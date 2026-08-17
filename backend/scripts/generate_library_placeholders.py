#!/usr/bin/env python3
"""
generate_library_placeholders.py
---------------------------------
Generates placeholder STEP and SVG stub files for every window and door entry
in the BubbleGraph BIM element library.

Run from the backend/ directory:
    python scripts/generate_library_placeholders.py

Each element folder gets:
    model.step    - STEP AP214 placeholder with bounding-box geometry
    void.step     - STEP AP214 placeholder for wall-void solid
    top.svg       - SVG top view (plan, looking down)
    front.svg     - SVG front elevation
    section.svg   - SVG vertical section at mid-width

All dimensions in mm.
"""

import json
import os
from pathlib import Path
from textwrap import dedent

LIBRARY_ROOT = Path(__file__).parent.parent / "library"

# ─── STEP template (minimal AP214 bounding box) ───────────────────────────────

def step_model(label: str, w: float, h: float, d: float) -> str:
    """Parametric placeholder STEP file — rectangular solid w×h×d mm."""
    return dedent(f"""\
        ISO-10303-21;
        HEADER;
        FILE_DESCRIPTION(('BubbleGraph BIM Library — {label}'),'2;1');
        FILE_NAME('{label.lower().replace(" ", "_")}.step','2026-01-01T00:00:00',('BubbleGraph'),(''),'BubbleGraph 1.0','','');
        FILE_SCHEMA(('AUTOMOTIVE_DESIGN {{ 1 0 10303 214 1 1 1 1 }}'));
        ENDSEC;
        DATA;
        /* ── Coordinate system ───────────────────────────────────────────────
           Origin at bottom-left-front corner of bounding box.
           X → width ({w} mm), Y → depth ({d} mm), Z → height ({h} mm).
           Object: {label}
           The solid named 'MAIN_BODY' represents the full frame + glass assembly.
           The solid named 'VOID' represents the wall-opening to be subtracted.
        ── */
        #1 = CARTESIAN_POINT('',(0.0,0.0,0.0));
        #2 = DIRECTION('X',(1.0,0.0,0.0));
        #3 = DIRECTION('Y',(0.0,1.0,0.0));
        #4 = DIRECTION('Z',(0.0,0.0,1.0));
        #5 = AXIS2_PLACEMENT_3D('',#1,#4,#2);
        /* Main body — replace with real BREP geometry */
        #10 = BLOCK('MAIN_BODY',#5,{w},{d},{h});
        /* Void solid — replace with real BREP void geometry */
        #11 = BLOCK('VOID',#5,{w},{d},{h});
        /* TODO: Replace #10 and #11 with proper ADVANCED_BREP_SHAPE_REPRESENTATION */
        ENDSEC;
        END-ISO-10303-21;
        """)

def step_void(label: str, w: float, h: float, d: float) -> str:
    """Standalone wall void STEP file."""
    return dedent(f"""\
        ISO-10303-21;
        HEADER;
        FILE_DESCRIPTION(('BubbleGraph BIM Library — {label} VOID'),'2;1');
        FILE_NAME('{label.lower().replace(" ", "_")}_void.step','2026-01-01T00:00:00',('BubbleGraph'),(''),'BubbleGraph 1.0','','');
        FILE_SCHEMA(('AUTOMOTIVE_DESIGN {{ 1 0 10303 214 1 1 1 1 }}'));
        ENDSEC;
        DATA;
        /* Wall-opening void for: {label}
           Dimensions: {w} mm wide × {d} mm deep × {h} mm tall.
           Used for boolean subtraction from the host wall solid.
        */
        #1 = CARTESIAN_POINT('',(0.0,0.0,0.0));
        #2 = DIRECTION('X',(1.0,0.0,0.0));
        #3 = DIRECTION('Z',(0.0,0.0,1.0));
        #5 = AXIS2_PLACEMENT_3D('',#1,#3,#2);
        #10 = BLOCK('VOID',#5,{w},{d},{h});
        /* TODO: Replace with proper ADVANCED_BREP_SHAPE_REPRESENTATION */
        ENDSEC;
        END-ISO-10303-21;
        """)

# ─── SVG templates ────────────────────────────────────────────────────────────

SVG_PAD = 20

def svg_top(label: str, w: float, d: float) -> str:
    """Top view (plan) — looking down. X=width, Y=depth."""
    vw = w + SVG_PAD * 2
    vh = d + SVG_PAD * 2
    return dedent(f"""\
        <?xml version="1.0" encoding="UTF-8"?>
        <!-- BubbleGraph — {label} — Top View (Plan) — dimensions in mm -->
        <svg xmlns="http://www.w3.org/2000/svg"
             viewBox="0 0 {vw} {vh}" width="{vw}" height="{vh}">
          <style>
            text {{ font-family: monospace; font-size: 8px; fill: #334155; }}
            .frame {{ fill: #e2e8f0; stroke: #334155; stroke-width: 1.5; }}
            .glass {{ fill: #bae6fd; stroke: #0ea5e9; stroke-width: 0.8; opacity: 0.7; }}
            .dim   {{ stroke: #94a3b8; stroke-width: 0.5; fill: none; stroke-dasharray: 3 2; }}
            .label {{ fill: #64748b; font-size: 7px; }}
          </style>
          <!-- Frame outline -->
          <rect class="frame" x="{SVG_PAD}" y="{SVG_PAD}" width="{w}" height="{d}" rx="1"/>
          <!-- Glass infill -->
          <rect class="glass" x="{SVG_PAD + 30}" y="{SVG_PAD + 8}" width="{max(w - 60, 10)}" height="{max(d - 16, 4)}" rx="1"/>
          <!-- Dimension lines -->
          <line class="dim" x1="{SVG_PAD}" y1="{SVG_PAD - 8}" x2="{SVG_PAD + w}" y2="{SVG_PAD - 8}"/>
          <text x="{SVG_PAD + w / 2}" y="{SVG_PAD - 10}" text-anchor="middle" class="label">{w} mm</text>
          <line class="dim" x1="{SVG_PAD + w + 8}" y1="{SVG_PAD}" x2="{SVG_PAD + w + 8}" y2="{SVG_PAD + d}"/>
          <text x="{SVG_PAD + w + 12}" y="{SVG_PAD + d / 2}" text-anchor="start" class="label">{d} mm</text>
          <!-- Title -->
          <text x="{SVG_PAD}" y="{vh - 4}" class="label">{label} — TOP VIEW</text>
        </svg>
        """)

def svg_front(label: str, w: float, h: float, sill: float = 0) -> str:
    """Front elevation — X=width, Y=height. Sill height shown if >0."""
    vw = w + SVG_PAD * 2
    vh = h + SVG_PAD * 2
    sill_y = SVG_PAD + (h - sill) if sill > 0 else None
    return dedent(f"""\
        <?xml version="1.0" encoding="UTF-8"?>
        <!-- BubbleGraph — {label} — Front Elevation — dimensions in mm -->
        <svg xmlns="http://www.w3.org/2000/svg"
             viewBox="0 0 {vw} {vh}" width="{vw}" height="{vh}">
          <style>
            text {{ font-family: monospace; font-size: 8px; fill: #334155; }}
            .frame {{ fill: #e2e8f0; stroke: #334155; stroke-width: 1.5; }}
            .glass {{ fill: #bae6fd; stroke: #0ea5e9; stroke-width: 0.8; opacity: 0.7; }}
            .sill  {{ stroke: #78716c; stroke-width: 1.5; fill: none; }}
            .dim   {{ stroke: #94a3b8; stroke-width: 0.5; fill: none; stroke-dasharray: 3 2; }}
            .label {{ fill: #64748b; font-size: 7px; }}
          </style>
          <!-- Frame -->
          <rect class="frame" x="{SVG_PAD}" y="{SVG_PAD}" width="{w}" height="{h}" rx="1"/>
          <!-- Glass panel (inside frame by 30 mm each side) -->
          <rect class="glass" x="{SVG_PAD + 30}" y="{SVG_PAD + 30}" width="{max(w - 60, 10)}" height="{max(h - 60, 10)}" rx="1"/>
          {"<!-- Sill line -->" if sill_y else ""}
          {f'<line class="sill" x1="{SVG_PAD}" y1="{sill_y}" x2="{SVG_PAD + w}" y2="{sill_y}"/>' if sill_y else ""}
          <!-- Width dimension -->
          <line class="dim" x1="{SVG_PAD}" y1="{SVG_PAD - 8}" x2="{SVG_PAD + w}" y2="{SVG_PAD - 8}"/>
          <text x="{SVG_PAD + w / 2}" y="{SVG_PAD - 10}" text-anchor="middle" class="label">{w} mm</text>
          <!-- Height dimension -->
          <line class="dim" x1="{SVG_PAD + w + 8}" y1="{SVG_PAD}" x2="{SVG_PAD + w + 8}" y2="{SVG_PAD + h}"/>
          <text x="{SVG_PAD + w + 12}" y="{SVG_PAD + h / 2}" text-anchor="start" class="label">{h} mm</text>
          <!-- Title -->
          <text x="{SVG_PAD}" y="{vh - 4}" class="label">{label} — FRONT ELEVATION</text>
        </svg>
        """)

def svg_section(label: str, h: float, d: float, sill: float = 0, glass_t: float = 24) -> str:
    """Vertical section at mid-width — Y=depth, Z=height."""
    vw = d + SVG_PAD * 2
    vh = h + SVG_PAD * 2
    frame_t = 70  # frame profile thickness mm
    glass_x = SVG_PAD + frame_t
    glass_w = d - 2 * frame_t
    sill_y = SVG_PAD + (h - sill) if sill > 0 else None
    return dedent(f"""\
        <?xml version="1.0" encoding="UTF-8"?>
        <!-- BubbleGraph — {label} — Vertical Section — dimensions in mm -->
        <svg xmlns="http://www.w3.org/2000/svg"
             viewBox="0 0 {vw} {vh}" width="{vw}" height="{vh}">
          <style>
            text {{ font-family: monospace; font-size: 8px; fill: #334155; }}
            .frame {{ fill: #e2e8f0; stroke: #334155; stroke-width: 1.5; }}
            .glass {{ fill: #bae6fd; stroke: #0ea5e9; stroke-width: 0.8; opacity: 0.7; }}
            .sill  {{ fill: #d6d3d1; stroke: #78716c; stroke-width: 1; }}
            .dim   {{ stroke: #94a3b8; stroke-width: 0.5; fill: none; stroke-dasharray: 3 2; }}
            .label {{ fill: #64748b; font-size: 7px; }}
          </style>
          <!-- Left frame profile -->
          <rect class="frame" x="{SVG_PAD}" y="{SVG_PAD}" width="{frame_t}" height="{h}"/>
          <!-- Right frame profile -->
          <rect class="frame" x="{SVG_PAD + d - frame_t}" y="{SVG_PAD}" width="{frame_t}" height="{h}"/>
          <!-- Glass -->
          <rect class="glass" x="{glass_x}" y="{SVG_PAD + 30}" width="{max(glass_w, 4)}" height="{max(h - 60, 4)}"/>
          <!-- Sill -->
          {f'<rect class="sill" x="{SVG_PAD}" y="{sill_y}" width="{d}" height="40"/>' if sill_y else ""}
          <!-- Depth dimension -->
          <line class="dim" x1="{SVG_PAD}" y1="{SVG_PAD - 8}" x2="{SVG_PAD + d}" y2="{SVG_PAD - 8}"/>
          <text x="{SVG_PAD + d / 2}" y="{SVG_PAD - 10}" text-anchor="middle" class="label">{d} mm</text>
          <!-- Height dimension -->
          <line class="dim" x1="{SVG_PAD + d + 8}" y1="{SVG_PAD}" x2="{SVG_PAD + d + 8}" y2="{SVG_PAD + h}"/>
          <text x="{SVG_PAD + d + 12}" y="{SVG_PAD + h / 2}" text-anchor="start" class="label">{h} mm</text>
          <!-- Title -->
          <text x="{SVG_PAD}" y="{vh - 4}" class="label">{label} — SECTION</text>
        </svg>
        """)

# ─── Generate all entries ─────────────────────────────────────────────────────

def generate_for_family(family: str) -> None:
    index_path = LIBRARY_ROOT / family / "index.json"
    if not index_path.exists():
        print(f"  [skip] {index_path} not found")
        return

    with open(index_path, encoding="utf-8") as f:
        index = json.load(f)

    for row in index["rows"]:
        eid    = row["id"]
        style  = row["style"]
        label  = row["label"]
        w      = float(row["width_mm"])
        h      = float(row["height_mm"])
        d      = float(row.get("depth_mm", 200))
        sill   = float(row.get("sill_height_mm", 0))

        folder = LIBRARY_ROOT / family / style / eid
        folder.mkdir(parents=True, exist_ok=True)

        files = {
            "model.step":   step_model(label, w, h, d),
            "void.step":    step_void(label, w, h, d),
            "top.svg":      svg_top(label, w, d),
            "front.svg":    svg_front(label, w, h, sill),
            "section.svg":  svg_section(label, h, d, sill),
        }

        for fname, content in files.items():
            target = folder / fname
            if target.exists():
                print(f"  [skip] {target.relative_to(LIBRARY_ROOT.parent)} (already exists)")
            else:
                target.write_text(content, encoding="utf-8")
                print(f"  [create] {target.relative_to(LIBRARY_ROOT.parent)}")


if __name__ == "__main__":
    print("Generating BubbleGraph BIM library placeholders...\n")
    for fam in ("windows", "doors"):
        print(f"── {fam} ──")
        generate_for_family(fam)
    print("\nDone.")
