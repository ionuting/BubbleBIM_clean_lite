"""
dxf_parser.py — QCAD DXF parametric symbol parser.

Converts a .dxf symbol file drawn using the BubbleGraph layer convention
into a compact .bglib.json intermediate format.

Layer conventions:
  slider_length     polygon — move contained vertices by (actualW - defaultW) along X
  slider_0.5length  polygon — move contained vertices by (actualW - defaultW)/2 along X
  slider_height     polygon — move contained vertices by (actualH - defaultH) along Y
  slider_0.5height  polygon — move contained vertices by (actualH - defaultH)/2 along Y
  origin            circle = insertion point (0,0 reference for placement)
  ax                reference axis line — ignored in output
  ignore            completely ignored
  label             text/geometry for element label (optional, separate output)
  (all others)      regular geometry — imported with DXF color
"""

from __future__ import annotations
import math
import json
import os
from typing import Any

try:
    import ezdxf
    HAS_EZDXF = True
except ImportError:
    HAS_EZDXF = False

# ─── ACI color index → hex (most common indices) ────────────────────────────

_ACI: dict[int, str] = {
    1:  "#FF0000", 2:  "#FFFF00", 3:  "#00FF00", 4:  "#00FFFF",
    5:  "#0000FF", 6:  "#FF00FF", 7:  "#FFFFFF", 8:  "#414141",
    9:  "#808080", 10: "#FF0000", 11: "#FF7F7F", 12: "#BF0000",
    20: "#FF7F00", 21: "#FFBF7F", 30: "#FF8000", 40: "#BF8040",
    50: "#BFBF00", 60: "#808000", 70: "#007F00", 80: "#004040",
    90: "#004080", 100:"#0040BF", 130:"#7F00BF", 140:"#BF007F",
    150:"#FF007F", 160:"#FF4040", 170:"#BFBFBF", 250:"#333333",
    251:"#555555", 252:"#777777", 253:"#999999", 254:"#BBBBBB",
    255:"#FFFFFF",
}

def _aci_to_hex(idx: int) -> str:
    # Interpolate for unregistered indices
    if idx in _ACI:
        return _ACI[idx]
    # Round to nearest registered
    closest = min(_ACI.keys(), key=lambda k: abs(k - idx))
    return _ACI[closest]

# ─── Slider layer definitions ────────────────────────────────────────────────

_SLIDER_LAYERS: dict[str, tuple[str, float]] = {
    "slider_length":    ("x", 1.0),
    "slider_0.5length": ("x", 0.5),
    "slider_height":    ("y", 1.0),
    "slider_0.5height": ("y", 0.5),
}
_SKIP_LAYERS = {"ax", "ignore"}

# Layers whose geometry is only meaningful in specific view types.
# 'floorplan' = plan cut view, 'section' = vertical cut, 'elevation' = external face.
# If a layer is absent from this dict, it renders in ALL view types.
_LAYER_VIEW_TYPES: dict[str, list[str]] = {
    "sill":    ["section", "elevation"],   # glaf / parapet — NOT in floor plan cut
    "frame":   ["floorplan", "section"],   # toc fereastra
    "glass":   ["floorplan", "section"],   # sticla
}

# ─── Color resolution ────────────────────────────────────────────────────────

def _resolve_color(entity: Any, layer_colors: dict[str, str]) -> str:
    color_attr = getattr(entity.dxf, "color", 256)
    if color_attr == 256:  # ByLayer
        return layer_colors.get(entity.dxf.layer.lower(), "#000000")
    if color_attr == 0:    # ByBlock
        return "#000000"
    # True-color (24-bit) stored in true_color attribute
    tc = getattr(entity.dxf, "true_color", None)
    if tc is not None:
        r, g, b = (tc >> 16) & 0xFF, (tc >> 8) & 0xFF, tc & 0xFF
        return f"#{r:02X}{g:02X}{b:02X}"
    return _aci_to_hex(color_attr)


def _resolve_lw(entity: Any, layer_lw: dict[str, float]) -> float:
    lw = getattr(entity.dxf, "lineweight", -1)
    if lw <= 0:
        lw = layer_lw.get(entity.dxf.layer.lower(), 25)
    return max(1, lw) / 100.0  # 1/100 mm → mm


# ─── Main parser ─────────────────────────────────────────────────────────────

def parse_dxf_symbol(dxf_path: str) -> dict:
    """
    Parse a QCAD .dxf symbol file and return the bglib dict.

    Raises ImportError if ezdxf is not installed.
    Raises ezdxf.DXFError on parse errors.
    """
    if not HAS_EZDXF:
        raise ImportError(
            "ezdxf is required for DXF parsing. Install with: pip install ezdxf"
        )

    doc = ezdxf.readfile(dxf_path)
    msp = doc.modelspace()

    # Build layer-level color and lineweight maps
    layer_colors: dict[str, str] = {}
    layer_lw: dict[str, float] = {}
    for layer in doc.layers:
        name = layer.dxf.name.lower()
        ci = abs(int(getattr(layer.dxf, "color", 7)))
        tc = getattr(layer.dxf, "true_color", None)
        if tc is not None:
            r, g, b = (tc >> 16) & 0xFF, (tc >> 8) & 0xFF, tc & 0xFF
            layer_colors[name] = f"#{r:02X}{g:02X}{b:02X}"
        else:
            layer_colors[name] = _aci_to_hex(ci)
        lw = getattr(layer.dxf, "lineweight", 25)
        layer_lw[name] = lw if lw > 0 else 25

    insertion_pt = {"x": 0.0, "y": 0.0}
    sliders: list[dict] = []
    geometry: list[dict] = []
    labels: list[dict] = []

    for entity in msp:
        layer_name = entity.dxf.layer.lower()
        dxftype = entity.dxftype()
        color = _resolve_color(entity, layer_colors)
        lw = _resolve_lw(entity, layer_lw)

        # ── Completely skip ─────────────────────────────────────────────────
        if layer_name in _SKIP_LAYERS or layer_name == "ignore":
            continue

        # ── Origin circle → insertion point ─────────────────────────────────
        if layer_name == "origin" and dxftype == "CIRCLE":
            c = entity.dxf.center
            insertion_pt = {"x": round(c.x, 3), "y": round(c.y, 3)}
            continue

        # ── Slider polygons ──────────────────────────────────────────────────
        if layer_name in _SLIDER_LAYERS:
            axis, factor = _SLIDER_LAYERS[layer_name]
            if dxftype == "LWPOLYLINE":
                pts = [[round(p[0], 3), round(p[1], 3)] for p in entity.get_points()]
                sliders.append({
                    "id": layer_name,
                    "axis": axis,
                    "factor": factor,
                    "polygon": pts,
                })
            continue

        # ── Decide target list ────────────────────────────────────────────────
        target = labels if layer_name == "label" else geometry
        # Optional viewTypes metadata (restricts which views render this entity)
        view_types = _LAYER_VIEW_TYPES.get(layer_name)

        # ── LWPOLYLINE ────────────────────────────────────────────────────────
        if dxftype == "LWPOLYLINE":
            pts = [[round(p[0], 3), round(p[1], 3)] for p in entity.get_points()]
            entry: dict = {
                "type": "lwpolyline",
                "layer": entity.dxf.layer,
                "color": color,
                "lineweight": round(lw, 3),
                "closed": bool(entity.is_closed),
                "vertices": pts,
            }
            if view_types:
                entry["viewTypes"] = view_types
            target.append(entry)

        # ── LINE ──────────────────────────────────────────────────────────────
        elif dxftype == "LINE":
            s, e = entity.dxf.start, entity.dxf.end
            entry = {
                "type": "line",
                "layer": entity.dxf.layer,
                "color": color,
                "lineweight": round(lw, 3),
                "start": [round(s.x, 3), round(s.y, 3)],
                "end":   [round(e.x, 3), round(e.y, 3)],
            }
            if view_types:
                entry["viewTypes"] = view_types
            target.append(entry)

        # ── ARC ───────────────────────────────────────────────────────────────
        elif dxftype == "ARC":
            c = entity.dxf.center
            entry = {
                "type": "arc",
                "layer": entity.dxf.layer,
                "color": color,
                "lineweight": round(lw, 3),
                "center":     [round(c.x, 3), round(c.y, 3)],
                "radius":     round(entity.dxf.radius, 3),
                "startAngle": round(entity.dxf.start_angle, 3),
                "endAngle":   round(entity.dxf.end_angle, 3),
            }
            if view_types:
                entry["viewTypes"] = view_types
            target.append(entry)

        # ── CIRCLE ────────────────────────────────────────────────────────────
        elif dxftype == "CIRCLE":
            c = entity.dxf.center
            entry = {
                "type": "circle",
                "layer": entity.dxf.layer,
                "color": color,
                "lineweight": round(lw, 3),
                "center": [round(c.x, 3), round(c.y, 3)],
                "radius": round(entity.dxf.radius, 3),
            }
            if view_types:
                entry["viewTypes"] = view_types
            target.append(entry)

        # ── SPLINE ───────────────────────────────────────────────────────────
        elif dxftype == "SPLINE":
            # Approximate as polyline using control points
            try:
                pts = [[round(p.x, 3), round(p.y, 3)] for p in entity.control_points]
                if len(pts) >= 2:
                    entry = {
                        "type": "lwpolyline",
                        "layer": entity.dxf.layer,
                        "color": color,
                        "lineweight": round(lw, 3),
                        "closed": False,
                        "vertices": pts,
                        "_approx": "spline_control_pts",
                    }
                    if view_types:
                        entry["viewTypes"] = view_types
                    target.append(entry)
            except Exception:
                pass

        # ── TEXT / MTEXT ──────────────────────────────────────────────────────
        elif dxftype in ("MTEXT", "TEXT"):
            try:
                if dxftype == "MTEXT":
                    pos = entity.dxf.insert
                    content = entity.plain_mtext()
                    height = getattr(entity.dxf, "char_height", 12.0)
                else:
                    pos = entity.dxf.insert
                    content = entity.dxf.text
                    height = getattr(entity.dxf, "height", 12.0)
                target.append({
                    "type": "text",
                    "layer": entity.dxf.layer,
                    "color": color,
                    "position": [round(pos.x, 3), round(pos.y, 3)],
                    "content": content,
                    "height": round(height, 3),
                })
            except Exception:
                pass

        # ── HATCH ─────────────────────────────────────────────────────────────
        elif dxftype == "HATCH":
            try:
                fill_color = color
                for path in entity.paths:
                    for edge in getattr(path, "edges", []):
                        if edge.EDGE_TYPE == "LineEdge":
                            # Collect closed boundary as lwpolyline
                            pass
                # Store as hatch marker for renderer to draw solid/diagonal fill
                target.append({
                    "type": "hatch",
                    "layer": entity.dxf.layer,
                    "color": fill_color,
                    "lineweight": round(lw, 3),
                    "pattern": getattr(entity.dxf, "pattern_name", "SOLID"),
                })
            except Exception:
                pass

    # ── Compute bounds from non-slider geometry ──────────────────────────────
    all_pts: list[tuple[float, float]] = []
    for g in geometry:
        if g["type"] == "lwpolyline":
            all_pts.extend((p[0], p[1]) for p in g["vertices"])
        elif g["type"] == "line":
            all_pts.append(tuple(g["start"]))
            all_pts.append(tuple(g["end"]))
        elif g["type"] in ("arc", "circle"):
            cx, cy = g["center"]
            r = g["radius"]
            all_pts.extend([(cx - r, cy), (cx + r, cy), (cx, cy - r), (cx, cy + r)])

    if all_pts:
        xs = [p[0] for p in all_pts]
        ys = [p[1] for p in all_pts]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
    else:
        min_x, max_x, min_y, max_y = 0, 1000, -200, 200

    return {
        "name":          os.path.splitext(os.path.basename(dxf_path))[0],
        "defaultWidth":  round(max_x - min_x),
        "defaultHeight": round(max_y - min_y),
        "bounds": {
            "minX": round(min_x, 1), "maxX": round(max_x, 1),
            "minY": round(min_y, 1), "maxY": round(max_y, 1),
        },
        "insertionPoint": insertion_pt,
        "sliders":  sliders,
        "geometry": geometry,
        "labels":   labels,
    }


def save_bglib_json(dxf_path: str, output_path: str | None = None) -> str:
    """Parse DXF and save .bglib.json adjacent to it (or at output_path)."""
    result = parse_dxf_symbol(dxf_path)
    if output_path is None:
        output_path = os.path.splitext(dxf_path)[0] + ".bglib.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    return output_path


def scan_library_for_bglib(library_path: str) -> list[dict]:
    """
    Walk library_path recursively and return a list of symbol metadata dicts
    for every .bglib.json file found.
    """
    results = []
    for root, _dirs, files in os.walk(library_path):
        for fname in files:
            if fname.endswith(".bglib.json"):
                full = os.path.join(root, fname)
                try:
                    with open(full, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    rel = os.path.relpath(full, library_path).replace("\\", "/")
                    # Guess element type from folder name
                    parts = rel.split("/")
                    element_type = parts[0].rstrip("s") if parts else "window"
                    results.append({
                        "name":          data.get("name", fname[:-12]),
                        "file":          rel,
                        "elementType":   element_type,
                        "defaultWidth":  data.get("defaultWidth", 1000),
                        "defaultHeight": data.get("defaultHeight", 200),
                        "sliderCount":   len(data.get("sliders", [])),
                    })
                except Exception:
                    pass
    return results


# ── CLI entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python dxf_parser.py <file.dxf> [output.bglib.json]")
        sys.exit(1)
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else None
    out = save_bglib_json(src, dst)
    print(f"Saved: {out}")
