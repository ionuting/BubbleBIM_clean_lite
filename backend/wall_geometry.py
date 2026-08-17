"""
Wall Join Geometry — Shapely extension/boolean method
======================================================

Computes 2D plan footprint polygons for wall nodes after joining with
adjacent walls at shared structural nodes (ax, column, foundation).

Method — "extend-then-intersect":
  1. Each wall is extended beyond its endpoints by half its thickness
     at junctions where ≥ 2 walls meet.
  2. At each junction the extended polygons of all meeting walls are unioned.
  3. Each wall's final footprint = its own extended poly ∪ (junction unions)
     clipped back to its infinite directional strip.

This gives clean L / T / + junctions without any bisector / angle maths.
Free ends (no adjacent wall) terminate cleanly without extension.

All coordinates in millimetres (mm), matching BubbleBIM BIM standard.
"""

from __future__ import annotations

import math
from typing import Any

from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

# ── Constants ─────────────────────────────────────────────────────────────

#: Node types that can form structural wall junctions (same set as TypeScript)
STRUCT_TYPES: frozenset[str] = frozenset({"ax", "column", "foundation"})

#: Large value used for "infinite" directional strips (metres in mm)
_BIG = 1_000_000.0

#: Default wall thickness when wall_type cannot be parsed
_DEFAULT_THICKNESS_MM = 200.0


# ── Helpers ───────────────────────────────────────────────────────────────


def _parse_thickness_mm(wall_type: str | None) -> float:
    """Parse wall thickness from type string.

    Examples
    --------
    "W20"  → 200.0 mm   (20 cm × 10)
    "W30"  → 300.0 mm
    ""     → 200.0 mm  (default)
    """
    if wall_type:
        s = wall_type.strip().upper()
        if s.startswith("W"):
            try:
                return float(s[1:]) * 10.0
            except ValueError:
                pass
    return _DEFAULT_THICKNESS_MM


def _resolve_pos(node: dict[str, Any], node_map: dict[str, dict]) -> tuple[float, float]:
    """Return the physical BIM position (mm) for any node.

    For *ax* nodes the position is looked up from the parent storey's
    axesX / axesY arrays using gridX / gridY.  For all other nodes the
    canvas x / y is used as a fallback (good enough for column / foundation).
    """
    if node.get("type") == "ax" and node.get("parentId"):
        storey = node_map.get(node["parentId"], {})
        props = storey.get("properties") or {}
        axes_x: list[float] = props.get("axesX") or []
        axes_y: list[float] = props.get("axesY") or []
        n_props = node.get("properties") or {}
        gx = int(n_props.get("gridX", 0))
        gy = int(n_props.get("gridY", 0))
        if axes_x and axes_y and gx < len(axes_x) and gy < len(axes_y):
            return (float(axes_x[gx]), float(axes_y[gy]))
    # Fallback: canvas position (used for column / foundation)
    return (float(node.get("x", 0)), float(node.get("y", 0)))


def _wall_rect(
    p1: tuple[float, float],
    p2: tuple[float, float],
    thickness_mm: float,
    extend_start_mm: float = 0.0,
    extend_end_mm: float = 0.0,
) -> Polygon | None:
    """Build a Shapely rectangle for a wall segment (optionally extended).

    Parameters
    ----------
    p1, p2           : start / end positions in mm
    thickness_mm     : wall thickness in mm
    extend_start_mm  : how far to extend behind p1 (for junction blending)
    extend_end_mm    : how far to extend past p2
    """
    dx = p2[0] - p1[0]
    dy = p2[1] - p1[1]
    length = math.hypot(dx, dy)
    if length < 1.0:
        return None

    ux, uy = dx / length, dy / length   # unit vector along wall
    px, py = -uy, ux                     # unit perpendicular (left side)
    half = thickness_mm / 2.0

    # Apply extensions
    sx = p1[0] - ux * extend_start_mm
    sy = p1[1] - uy * extend_start_mm
    ex = p2[0] + ux * extend_end_mm
    ey = p2[1] + uy * extend_end_mm

    corners = [
        (sx + px * half, sy + py * half),
        (ex + px * half, ey + py * half),
        (ex - px * half, ey - py * half),
        (sx - px * half, sy - py * half),
    ]
    poly = Polygon(corners)
    return poly if poly.is_valid else poly.buffer(0)


def _infinite_strip(
    p1: tuple[float, float],
    p2: tuple[float, float],
    thickness_mm: float,
) -> Polygon:
    """Return a very-long rectangle along the wall centreline.

    Used to clip post-union geometry back to the wall's own direction,
    preventing perpendicular bleed into adjacent walls.
    """
    dx = p2[0] - p1[0]
    dy = p2[1] - p1[1]
    length = math.hypot(dx, dy)
    if length < 1.0:
        return Polygon()

    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    half = thickness_mm / 2.0

    sx = p1[0] - ux * _BIG
    sy = p1[1] - uy * _BIG
    ex = p2[0] + ux * _BIG
    ey = p2[1] + uy * _BIG

    return Polygon([
        (sx + px * half, sy + py * half),
        (ex + px * half, ey + py * half),
        (ex - px * half, ey - py * half),
        (sx - px * half, sy - py * half),
    ])


def _largest_poly(geom) -> Polygon:
    """Return the largest polygon from a (possibly Multi-) geometry."""
    if isinstance(geom, MultiPolygon):
        return max(geom.geoms, key=lambda g: g.area)
    return geom


# ── Main entry point ──────────────────────────────────────────────────────


def compute_wall_footprints(
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Compute joined 2D plan footprints for all wall nodes.

    Parameters
    ----------
    nodes : list of node dicts (from bubble_graph.json)
    edges : list of edge dicts

    Returns
    -------
    List of wall footprint records::

        {
            "id":              str,      # wall node id
            "name":            str,
            "footprint":       [[x,y],…],  # mm, CCW, closed (last ≠ first)
            "storeyId":        str,
            "bottomElevation": float,    # mm
            "topElevation":    float,    # mm
            "thickness":       float,    # mm
            "wallType":        str,
        }
    """
    node_map: dict[str, dict] = {n["id"]: n for n in nodes}

    # ── Adjacency list ────────────────────────────────────────────────────
    adj: dict[str, list[str]] = {}
    for e in edges:
        adj.setdefault(e["from"], []).append(e["to"])
        adj.setdefault(e["to"], []).append(e["from"])

    wall_nodes = [n for n in nodes if n.get("type") == "wall"]

    # ── Structural endpoints per wall ─────────────────────────────────────
    # wall_id → list of structural node ids (ax / column / foundation only)
    wall_struct_ends: dict[str, list[str]] = {}
    for wn in wall_nodes:
        wid = wn["id"]
        wall_struct_ends[wid] = [
            nid
            for nid in adj.get(wid, [])
            if node_map.get(nid, {}).get("type") in STRUCT_TYPES
        ]

    # ── Junction map ──────────────────────────────────────────────────────
    # junction_node_id → [wall_ids meeting here]
    junction_walls: dict[str, list[str]] = {}
    for wid, ends in wall_struct_ends.items():
        for nid in ends:
            junction_walls.setdefault(nid, []).append(wid)

    # ── Thickness map ─────────────────────────────────────────────────────
    def _thick(wn: dict) -> float:
        return _parse_thickness_mm(
            (wn.get("properties") or {}).get("wall_type") or ""
        )

    thickness: dict[str, float] = {wn["id"]: _thick(wn) for wn in wall_nodes}

    # ── Endpoint positions ────────────────────────────────────────────────
    # wall_id → (p1_mm, p2_mm)   — uses first two structural endpoints
    endpoints: dict[str, tuple[tuple[float, float], tuple[float, float]]] = {}
    for wn in wall_nodes:
        wid = wn["id"]
        ends = wall_struct_ends[wid]
        if len(ends) < 2:
            continue
        p1 = _resolve_pos(node_map[ends[0]], node_map)
        p2 = _resolve_pos(node_map[ends[1]], node_map)
        endpoints[wid] = (p1, p2)

    # ── Extension amounts per wall-end ────────────────────────────────────
    # Extend by half_thickness only where another wall meets (junction count ≥ 2).
    # This is the core of the "extension/boolean" method.
    def _extensions(wid: str) -> tuple[float, float]:
        ends = wall_struct_ends.get(wid, [])
        exts = []
        for nid in ends[:2]:
            count = len(junction_walls.get(nid, []))
            exts.append(thickness[wid] / 2.0 if count >= 2 else 0.0)
        while len(exts) < 2:
            exts.append(0.0)
        return (exts[0], exts[1])

    # ── Build extended polygons ───────────────────────────────────────────
    extended: dict[str, Polygon] = {}
    for wn in wall_nodes:
        wid = wn["id"]
        if wid not in endpoints:
            continue
        p1, p2 = endpoints[wid]
        ext_s, ext_e = _extensions(wid)
        poly = _wall_rect(p1, p2, thickness[wid], ext_s, ext_e)
        if poly is not None:
            extended[wid] = poly

    # ── Union at junctions + clip to directional strip ───────────────────
    result: dict[str, Polygon] = {}
    for wn in wall_nodes:
        wid = wn["id"]
        if wid not in extended or wid not in endpoints:
            continue

        p1, p2 = endpoints[wid]
        t = thickness[wid]

        # Start with this wall's own extended rectangle
        combined: Polygon = extended[wid]

        # Union with extended polys of every wall at each of our junctions.
        # This fills corner gaps at L / T / + joints.
        for jid in wall_struct_ends.get(wid, []):
            for other_wid in junction_walls.get(jid, []):
                if other_wid != wid and other_wid in extended:
                    combined = combined.union(extended[other_wid])

        # Clip back to this wall's infinite directional strip so we don't
        # bleed into adjacent walls' space perpendicularly.
        strip = _infinite_strip(p1, p2, t)
        clipped = combined.intersection(strip)

        if not clipped.is_empty and clipped.is_valid:
            result[wid] = _largest_poly(clipped)
        else:
            result[wid] = _largest_poly(extended[wid])

    # ── Serialize output ──────────────────────────────────────────────────
    output: list[dict[str, Any]] = []
    for wn in wall_nodes:
        wid = wn["id"]
        poly = result.get(wid)
        if poly is None or poly.is_empty:
            continue

        coords = list(poly.exterior.coords)[:-1]  # drop duplicate closing point

        props = wn.get("properties") or {}
        storey_id = wn.get("parentId") or ""
        storey = node_map.get(storey_id, {})
        storey_props = storey.get("properties") or {}

        output.append({
            "id":              wid,
            "name":            wn.get("name", ""),
            "footprint":       [[round(c[0], 2), round(c[1], 2)] for c in coords],
            "storeyId":        storey_id,
            "bottomElevation": float(storey_props.get("bottomElevation", 0)),
            "topElevation":    float(storey_props.get("topElevation", 3000)),
            "thickness":       thickness[wid],
            "wallType":        props.get("wall_type", ""),
        })

    return output
