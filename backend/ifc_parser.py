"""
IFC STEP Parser — BubbleGraph IFC Reverse Engineering
=====================================================

Pure-Python parser for IFC4 STEP files. No external dependencies.

Extracts from one chosen BuildingStorey:
- Walls      (axis line, thickness, height)
- Slabs      (footprint polygon, merged per storey)
- Windows    (host wall, width, height, sill, offset along wall)
- Doors      (host wall, width, height, offset along wall)
- Spaces/Rooms (name, boundary polygon)
- Storeys    (name, elevation, height)

All coordinates in METRES (IFC default) → converted to mm on output.
Grid detection: clusters wall endpoints → axesX / axesY lists.
"""

from __future__ import annotations

import math
import re
from typing import Any


# ─────────────────────────────────────────────────────────────────────────────
# STEP TOKENISER
# ─────────────────────────────────────────────────────────────────────────────

_LINE_RE = re.compile(r'^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\((.*)\)\s*;?\s*$', re.IGNORECASE)


def _tokenise_args(s: str) -> list[str]:
    """Split a STEP argument string respecting nested parens and quotes."""
    args: list[str] = []
    depth = 0
    start = 0
    in_str = False
    i = 0
    while i < len(s):
        c = s[i]
        if c == "'" and not in_str:
            in_str = True
        elif c == "'" and in_str:
            in_str = False
        elif not in_str:
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
            elif c == ',' and depth == 0:
                args.append(s[start:i].strip())
                start = i + 1
        i += 1
    last = s[start:].strip()
    if last:
        args.append(last)
    return args


def _unquote(s: str) -> str:
    s = s.strip()
    if s.startswith("'") and s.endswith("'"):
        s = s[1:-1]
    # IFC X2 encoding \X2\XXXX\X0\ → ignore for now, just strip
    s = re.sub(r'\\X2\\[0-9A-Fa-f]+\\X0\\', '?', s)
    return s


def _ref(s: str) -> int | None:
    """Return integer id from '#123' or None."""
    s = s.strip()
    if s.startswith('#'):
        try:
            return int(s[1:])
        except ValueError:
            pass
    return None


def _float(s: str) -> float:
    try:
        return float(s.strip())
    except (ValueError, AttributeError):
        return 0.0


def _inner(s: str) -> str:
    """Return content inside first pair of parens."""
    s = s.strip()
    if s.startswith('(') and s.endswith(')'):
        return s[1:-1]
    return s


# ─────────────────────────────────────────────────────────────────────────────
# IFC STEP TABLE
# ─────────────────────────────────────────────────────────────────────────────

class IFCModel:
    """Flat dict of entity_id → (type, args_list)."""

    def __init__(self) -> None:
        self._e: dict[int, tuple[str, list[str]]] = {}

    def load(self, path: str) -> None:
        with open(path, encoding='utf-8', errors='replace') as f:
            raw = f.read()

        # Join continuation lines (STEP spec: logical line ends with ;)
        lines = raw.replace('\r\n', '\n').replace('\r', '\n').split('\n')
        # Re-join split logical lines
        logical: list[str] = []
        buf = ''
        for line in lines:
            line = line.strip()
            if not line or line.startswith('/*') or line.startswith('//'):
                continue
            if line.startswith('HEADER;') or line.startswith('ENDSEC;') \
                    or line.startswith('ISO-') or line.startswith('DATA;') \
                    or line.startswith('END-ISO'):
                continue
            buf += line
            if line.endswith(';'):
                logical.append(buf)
                buf = ''
        if buf:
            logical.append(buf)

        for line in logical:
            m = _LINE_RE.match(line)
            if not m:
                continue
            eid = int(m.group(1))
            etype = m.group(2).upper()
            raw_args = m.group(3)
            args = _tokenise_args(raw_args)
            self._e[eid] = (etype, args)

    def get(self, eid: int | None) -> tuple[str, list[str]] | None:
        if eid is None:
            return None
        return self._e.get(eid)

    def find_all(self, etype: str) -> list[tuple[int, list[str]]]:
        etype = etype.upper()
        return [(eid, args) for eid, (t, args) in self._e.items() if t == etype]

    def attr(self, eid: int, index: int, default: str = '$') -> str:
        e = self._e.get(eid)
        if e is None:
            return default
        args = e[1]
        if index >= len(args):
            return default
        return args[index]


# ─────────────────────────────────────────────────────────────────────────────
# GEOMETRY HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _resolve_placement(m: IFCModel, placement_id: int) -> tuple[list[float], list[float], list[float]]:
    """Recursively resolve IFCLOCALPLACEMENT → (origin_xyz, x_axis_xyz, z_axis_xyz) in world coords."""
    origin = [0.0, 0.0, 0.0]
    x_dir  = [1.0, 0.0, 0.0]
    z_dir  = [0.0, 0.0, 1.0]

    chain: list[int] = []
    cur = placement_id
    while cur:
        e = m.get(cur)
        if e is None:
            break
        etype, args = e
        if etype == 'IFCLOCALPLACEMENT':
            # args[0]=relative_placement_ref, args[1]=IFCAXIS2PLACEMENT3D ref
            parent_ref = _ref(args[0]) if args[0] != '$' else None
            ax_ref     = _ref(args[1]) if len(args) > 1 else None
            chain.append(ax_ref)  # type: ignore[arg-type]
            cur = parent_ref
        else:
            break

    # Now apply chain in reverse (parent → child)
    ox, oy, oz = 0.0, 0.0, 0.0
    xx, xy, xz = 1.0, 0.0, 0.0
    zx, zy, zz = 0.0, 0.0, 1.0

    for ax_id in reversed(chain):
        if ax_id is None:
            continue
        e = m.get(ax_id)
        if e is None:
            continue
        etype, args = e
        if etype == 'IFCAXIS2PLACEMENT3D':
            loc_id = _ref(args[0])
            z_id   = _ref(args[1]) if len(args) > 1 and args[1] != '$' else None
            x_id   = _ref(args[2]) if len(args) > 2 and args[2] != '$' else None

            lx, ly, lz = _cart_point(m, loc_id)
            # Transform local origin into parent coords
            # (simplified: only handles translation + rotation about z)
            # Full 3D matrix transform:
            lx_w = ox + xx * lx + (-(zy) * 0 + zz * 0) * lx  # simplified
            # Just use translation for now — sufficient for axis-aligned buildings
            ox += lx; oy += ly; oz += lz

            if z_id:
                d = m.get(z_id)
                if d:
                    dargs = d[1]
                    coords = _inner(dargs[0]).split(',') if dargs else ['0','0','1']
                    zx = _float(coords[0]); zy = _float(coords[1]); zz = _float(coords[2]) if len(coords) > 2 else 1.0
            if x_id:
                d = m.get(x_id)
                if d:
                    dargs = d[1]
                    coords = _inner(dargs[0]).split(',') if dargs else ['1','0','0']
                    xx = _float(coords[0]); xy = _float(coords[1]); xz = _float(coords[2]) if len(coords) > 2 else 0.0

    return [ox, oy, oz], [xx, xy, xz], [zx, zy, zz]


def _cart_point(m: IFCModel, pt_id: int | None) -> tuple[float, float, float]:
    if pt_id is None:
        return 0.0, 0.0, 0.0
    e = m.get(pt_id)
    if e is None:
        return 0.0, 0.0, 0.0
    _, args = e
    coords_str = _inner(args[0])
    coords = coords_str.split(',')
    x = _float(coords[0]) if len(coords) > 0 else 0.0
    y = _float(coords[1]) if len(coords) > 1 else 0.0
    z = _float(coords[2]) if len(coords) > 2 else 0.0
    return x, y, z


def _direction(m: IFCModel, dir_id: int | None) -> tuple[float, float, float]:
    if dir_id is None:
        return 0.0, 0.0, 1.0
    e = m.get(dir_id)
    if e is None:
        return 0.0, 0.0, 1.0
    _, args = e
    coords_str = _inner(args[0])
    coords = coords_str.split(',')
    x = _float(coords[0]) if len(coords) > 0 else 0.0
    y = _float(coords[1]) if len(coords) > 1 else 0.0
    z = _float(coords[2]) if len(coords) > 2 else 0.0
    return x, y, z


def _axis2placement3d(m: IFCModel, ax_id: int | None) -> tuple[list[float], list[float], list[float]]:
    """Return (origin, x_dir, z_dir) from IFCAXIS2PLACEMENT3D."""
    if ax_id is None:
        return [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]
    e = m.get(ax_id)
    if e is None:
        return [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]
    _, args = e
    loc_id = _ref(args[0])
    z_id   = _ref(args[1]) if len(args) > 1 and args[1] != '$' else None
    x_id   = _ref(args[2]) if len(args) > 2 and args[2] != '$' else None
    origin = list(_cart_point(m, loc_id))
    z_dir  = list(_direction(m, z_id))
    x_dir  = list(_direction(m, x_id))
    return origin, x_dir, z_dir


# ─────────────────────────────────────────────────────────────────────────────
# RELATIONSHIP MAPS
# ─────────────────────────────────────────────────────────────────────────────

def _build_rel_maps(m: IFCModel) -> dict[str, Any]:
    """Pre-compute relationship maps for fast lookups."""

    # storey → elements (IfcRelContainedInSpatialStructure)
    # IFC4 schema: [0]GlobalId [1]OwnerHistory [2]Name [3]Desc [4]RelatedElements [5]RelatingStructure
    storey_elements: dict[int, list[int]] = {}
    for eid, args in m.find_all('IFCRELCONTAINEDINSPATIALSTRUCTURE'):
        structure_id = _ref(args[5]) if len(args) > 5 else None
        elements_str = _inner(args[4]) if len(args) > 4 else ''
        elem_ids = [_ref(r.strip()) for r in elements_str.split(',') if r.strip().startswith('#')]
        if structure_id:
            storey_elements.setdefault(structure_id, []).extend(e for e in elem_ids if e is not None)

    # wall → opening (IfcRelVoidsElement): wall_id → [opening_id]
    # IFC4: [0]GlobalId [1]OwnerHistory [2]Name [3]Desc [4]RelatingBuildingElement [5]RelatedOpeningElement
    wall_openings: dict[int, list[int]] = {}
    for eid, args in m.find_all('IFCRELVOIDSELEMENT'):
        wall_id    = _ref(args[4]) if len(args) > 4 else None
        opening_id = _ref(args[5]) if len(args) > 5 else None
        if wall_id and opening_id:
            wall_openings.setdefault(wall_id, []).append(opening_id)

    # opening → window/door (IfcRelFillsElement): opening_id → element_id
    # IFC4: [0]GlobalId [1]OwnerHistory [2]Name [3]Desc [4]RelatingOpeningElement [5]RelatedBuildingElement
    opening_fills: dict[int, int] = {}
    for eid, args in m.find_all('IFCRELFILLSELEMENT'):
        opening_id = _ref(args[4]) if len(args) > 4 else None
        element_id = _ref(args[5]) if len(args) > 5 else None
        if opening_id and element_id:
            opening_fills[opening_id] = element_id

    return {
        'storey_elements': storey_elements,
        'wall_openings':   wall_openings,
        'opening_fills':   opening_fills,
    }


# ─────────────────────────────────────────────────────────────────────────────
# WALL GEOMETRY — extract axis line + thickness from IfcWall
# ─────────────────────────────────────────────────────────────────────────────

def _extract_wall_axis(m: IFCModel, wall_id: int) -> dict[str, Any] | None:
    """
    Extract wall axis line from IFCWALL.
    Returns dict with startPt, endPt (metres), thickness (metres), height (metres).
    """
    e = m.get(wall_id)
    if e is None:
        return None
    etype, args = e
    if etype not in ('IFCWALL', 'IFCWALLSTANDARDCASE'):
        return None

    # args: [GlobalId, OwnerHistory, Name, Desc, ObjectType, ObjectPlacement, Representation, Tag, PredefinedType]
    name           = _unquote(args[2]) if len(args) > 2 else ''
    placement_id   = _ref(args[5]) if len(args) > 5 else None
    representation = _ref(args[6]) if len(args) > 6 else None

    # Resolve placement (translation only — good enough for axis-aligned buildings)
    origin = [0.0, 0.0, 0.0]
    x_dir  = [1.0, 0.0, 0.0]
    if placement_id:
        e_pl = m.get(placement_id)
        if e_pl:
            _, pl_args = e_pl
            ax_id = _ref(pl_args[1]) if len(pl_args) > 1 else None
            if ax_id:
                origin, x_dir, _ = _axis2placement3d(m, ax_id)

    # Find IfcProductDefinitionShape → IfcShapeRepresentation (Axis or Body)
    axis_pts: list[tuple[float, float, float]] = []
    thickness_m = 0.25  # default 25 cm
    height_m    = 3.0   # default 3 m

    if representation:
        e_rep = m.get(representation)
        if e_rep:
            _, rep_args = e_rep
            # IFCPRODUCTDEFINITIONSHAPE: args[2] = (list of ShapeRepresentation refs)
            shape_list_str = _inner(rep_args[2]) if len(rep_args) > 2 else ''
            shape_ids = [_ref(r.strip()) for r in shape_list_str.split(',') if r.strip().startswith('#')]
            for sh_id in shape_ids:
                sh = m.get(sh_id)
                if sh is None:
                    continue
                _, sh_args = sh
                # IFCSHAPEREPRESENTATION: [0]=context [1]=RepresentationIdentifier [2]=RepresentationType [3]=Items
                rep_id_raw   = sh_args[1].strip().strip("'") if len(sh_args) > 1 else ''
                items_str = _inner(sh_args[3]) if len(sh_args) > 3 else ''
                item_ids  = [_ref(r.strip()) for r in items_str.split(',') if r.strip().startswith('#')]

                if rep_id_raw == 'Axis':
                    # Contains IFCPOLYLINE or IFCINDEXEDPOLYCURVE with 2 axis points
                    for it_id in item_ids:
                        it = m.get(it_id)
                        if it is None:
                            continue
                        it_type, it_args = it
                        if it_type == 'IFCPOLYLINE':
                            pts_str = _inner(it_args[0])
                            pt_ids  = [_ref(r.strip()) for r in pts_str.split(',') if r.strip().startswith('#')]
                            for pt_id in pt_ids:
                                pt = _cart_point(m, pt_id)
                                axis_pts.append(pt)
                        elif it_type == 'IFCINDEXEDPOLYCURVE':
                            # args[0] = IFCCARTESIANPOINTLIST2D ref
                            ptlist_id = _ref(it_args[0])
                            ptlist = m.get(ptlist_id)
                            if ptlist and ptlist[0] in ('IFCCARTESIANPOINTLIST2D', 'IFCCARTESIANPOINTLIST3D'):
                                raw = ptlist[1][0]  # e.g. "((0.,0.),(5.5,0.))"
                                # Parse all tuples
                                for tup_m in re.finditer(r'\(([^()]+)\)', raw):
                                    coords = tup_m.group(1).split(',')
                                    x = _float(coords[0])
                                    y = _float(coords[1]) if len(coords) > 1 else 0.0
                                    z = _float(coords[2]) if len(coords) > 2 else 0.0
                                    axis_pts.append((x, y, z))

    if len(axis_pts) < 2:
        return None

    # Transform axis points by placement (translation only)
    def _transform(pt: tuple[float, float, float]) -> list[float]:
        # For axis-aligned walls: local x maps to x_dir, local y maps to y_dir (90° from x)
        y_dir = [-x_dir[1], x_dir[0], 0.0]
        wx = origin[0] + pt[0] * x_dir[0] + pt[1] * y_dir[0]
        wy = origin[1] + pt[0] * x_dir[1] + pt[1] * y_dir[1]
        wz = origin[2] + pt[2]
        return [wx, wy, wz]

    p1 = _transform(axis_pts[0])
    p2 = _transform(axis_pts[1])

    # Try to extract thickness from IfcRelDefinesByProperties → IfcElementQuantity
    # (simplified: use 0.25m default if not found)

    return {
        'guid':       _unquote(args[0]),
        'name':       name,
        'startPt':    [p1[0], p1[1]],  # metres
        'endPt':      [p2[0], p2[1]],  # metres
        'baseZ':      p1[2],           # metres
        'thickness':  thickness_m,
        'height':     height_m,
    }


# ─────────────────────────────────────────────────────────────────────────────
# OPENING GEOMETRY — extract window/door from IfcOpeningElement
# ─────────────────────────────────────────────────────────────────────────────

def _extract_opening(m: IFCModel, opening_id: int, fill_id: int | None,
                     wall_data: dict[str, Any] | None) -> dict[str, Any] | None:
    """Extract opening/filling as window or door record."""
    e = m.get(opening_id)
    if e is None:
        return None
    etype, args = e
    if etype != 'IFCOPENINGELEMENT':
        return None

    placement_id = _ref(args[5]) if len(args) > 5 else None
    origin = [0.0, 0.0, 0.0]
    if placement_id:
        e_pl = m.get(placement_id)
        if e_pl:
            _, pl_args = e_pl
            ax_id = _ref(pl_args[1]) if len(pl_args) > 1 else None
            if ax_id:
                origin, _, _ = _axis2placement3d(m, ax_id)

    # Determine type and dimensions from filling element
    element_type = 'opening'
    width_m  = 1.0
    height_m = 2.0
    sill_m   = 0.8
    fill_name = ''

    if fill_id:
        fe = m.get(fill_id)
        if fe:
            f_etype, f_args = fe
            fill_name = _unquote(f_args[2]) if len(f_args) > 2 else ''
            if f_etype == 'IFCWINDOW':
                element_type = 'window'
                height_m = _float(f_args[7]) if len(f_args) > 7 and f_args[7] != '$' else 2.0
                width_m  = _float(f_args[8]) if len(f_args) > 8 and f_args[8] != '$' else 1.0
            elif f_etype == 'IFCDOOR':
                element_type = 'door'
                height_m = _float(f_args[7]) if len(f_args) > 7 and f_args[7] != '$' else 2.2
                width_m  = _float(f_args[8]) if len(f_args) > 8 and f_args[8] != '$' else 0.9
                sill_m   = 0.0

    # Compute offset along wall axis
    offset_along_wall_m = 0.0
    if wall_data:
        wx1, wy1 = wall_data['startPt']
        wx2, wy2 = wall_data['endPt']
        dx = wx2 - wx1; dy = wy2 - wy1
        wlen = math.hypot(dx, dy)
        if wlen > 0.001:
            # Project opening origin onto wall axis
            ox = origin[0] - wx1; oy = origin[1] - wy1
            t  = (ox * dx + oy * dy) / (wlen * wlen)
            offset_along_wall_m = t * wlen
        sill_m = origin[2] - wall_data.get('baseZ', 0.0)

    return {
        'type':             element_type,
        'name':             fill_name,
        'width':            width_m,
        'height':           height_m,
        'sillHeight':       max(0.0, sill_m),
        'offsetAlongWall':  offset_along_wall_m,  # metres from wall start
    }


# ─────────────────────────────────────────────────────────────────────────────
# GRID DETECTION
# ─────────────────────────────────────────────────────────────────────────────

def _cluster(values: list[float], tol: float = 0.15) -> list[float]:
    """Group close values and return cluster centers (sorted)."""
    if not values:
        return []
    vals = sorted(set(values))
    clusters: list[list[float]] = []
    cur = [vals[0]]
    for v in vals[1:]:
        if v - cur[-1] <= tol:
            cur.append(v)
        else:
            clusters.append(cur)
            cur = [v]
    clusters.append(cur)
    return sorted(sum(c) / len(c) for c in clusters)


def _detect_grid(walls: list[dict[str, Any]]) -> tuple[list[float], list[float]]:
    """Detect structural grid axes from wall endpoints (metres)."""
    xs: list[float] = []
    ys: list[float] = []
    for w in walls:
        xs.append(w['startPt'][0]); xs.append(w['endPt'][0])
        ys.append(w['startPt'][1]); ys.append(w['endPt'][1])
    return _cluster(xs), _cluster(ys)


def _snap(value: float, grid: list[float], tol: float = 0.2) -> int | None:
    """Return grid index closest to value within tolerance, or None."""
    if not grid:
        return None
    dists = [abs(value - g) for g in grid]
    min_d = min(dists)
    if min_d <= tol:
        return dists.index(min_d)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# MAIN ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def parse_ifc_storey(
    ifc_path: str,
    storey_name: str | None = None,
    storey_index: int = 0,
) -> dict[str, Any]:
    """
    Parse one BuildingStorey from an IFC4 file.

    Parameters
    ----------
    ifc_path     : Path to .ifc file
    storey_name  : Preferred storey name (partial match, case-insensitive).
                   If None, storey_index is used (0 = first/ground).
    storey_index : Fallback index when storey_name doesn't match.

    Returns
    -------
    {
      "storey":  { name, elevation_mm, height_mm },
      "allStoreys": [ { name, elevation_mm } ],
      "walls":   [ { guid, name, startPt_mm, endPt_mm, thickness_mm, height_mm,
                     openings: [ { type, name, width_mm, height_mm,
                                   sillHeight_mm, offsetAlongWall_mm } ] } ],
      "axesX_mm": [float, ...],
      "axesY_mm": [float, ...],
    }
    """
    m = IFCModel()
    m.load(ifc_path)

    rels = _build_rel_maps(m)

    # ── Collect storeys ──────────────────────────────────────────────────
    storey_list: list[tuple[int, str, float]] = []  # (id, name, elevation_m)
    for eid, args in m.find_all('IFCBUILDINGSTOREY'):
        name = _unquote(args[2]) if len(args) > 2 else f'Storey-{eid}'
        elev = _float(args[9]) if len(args) > 9 and args[9] not in ('$', '') else 0.0
        storey_list.append((eid, name, elev))
    storey_list.sort(key=lambda x: x[2])  # sort by elevation

    if not storey_list:
        return {'error': 'No IfcBuildingStorey found in file'}

    # ── Select storey ────────────────────────────────────────────────────
    chosen_idx = storey_index
    if storey_name:
        sn_low = storey_name.lower()
        for i, (_, name, _) in enumerate(storey_list):
            if sn_low in name.lower():
                chosen_idx = i
                break

    chosen_idx = max(0, min(chosen_idx, len(storey_list) - 1))
    storey_id, storey_name_out, storey_elev = storey_list[chosen_idx]

    # Estimate storey height
    if chosen_idx + 1 < len(storey_list):
        next_elev = storey_list[chosen_idx + 1][2]
        storey_height = next_elev - storey_elev
    else:
        storey_height = 3.0  # default

    # ── Get elements on this storey ──────────────────────────────────────
    element_ids: set[int] = set(rels['storey_elements'].get(storey_id, []))

    # ── Extract walls ────────────────────────────────────────────────────
    MM = 1000.0  # metres → mm

    walls_out: list[dict[str, Any]] = []
    for wall_id in element_ids:
        e = m.get(wall_id)
        if e is None:
            continue
        etype, _ = e
        if etype not in ('IFCWALL', 'IFCWALLSTANDARDCASE'):
            continue

        wall_data = _extract_wall_axis(m, wall_id)
        if wall_data is None:
            continue

        # Collect openings
        openings_out: list[dict[str, Any]] = []
        for op_id in rels['wall_openings'].get(wall_id, []):
            fill_id = rels['opening_fills'].get(op_id)
            op = _extract_opening(m, op_id, fill_id, wall_data)
            if op:
                openings_out.append({
                    'type':             op['type'],
                    'name':             op['name'],
                    'width_mm':         round(op['width'] * MM),
                    'height_mm':        round(op['height'] * MM),
                    'sillHeight_mm':    round(max(0.0, op['sillHeight']) * MM),
                    'offsetAlongWall_mm': round(op['offsetAlongWall'] * MM),
                })

        walls_out.append({
            'guid':          wall_data['guid'],
            'name':          wall_data['name'],
            'startPt_mm':    [round(wall_data['startPt'][0] * MM), round(wall_data['startPt'][1] * MM)],
            'endPt_mm':      [round(wall_data['endPt'][0] * MM),   round(wall_data['endPt'][1] * MM)],
            'thickness_mm':  round(wall_data['thickness'] * MM),
            'height_mm':     round(storey_height * MM),
            'openings':      openings_out,
        })

    # ── Grid detection ───────────────────────────────────────────────────
    # Work in metres for clustering, then convert
    axes_x, axes_y = _detect_grid(
        [{'startPt': [w['startPt_mm'][0] / MM, w['startPt_mm'][1] / MM],
          'endPt':   [w['endPt_mm'][0]   / MM, w['endPt_mm'][1]   / MM]}
         for w in walls_out]
    )

    return {
        'storey': {
            'name':          storey_name_out,
            'elevation_mm':  round(storey_elev * MM),
            'height_mm':     round(storey_height * MM),
        },
        'allStoreys': [
            {'name': n, 'elevation_mm': round(e * MM)}
            for _, n, e in storey_list
        ],
        'walls':    walls_out,
        'axesX_mm': [round(x * MM) for x in axes_x],
        'axesY_mm': [round(y * MM) for y in axes_y],
        'wallCount':    len(walls_out),
        'openingCount': sum(len(w['openings']) for w in walls_out),
    }


# ─────────────────────────────────────────────────────────────────────────────
# FULL PLAN DATA — all storeys, all walls, for IFC 2D Plan View
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# SLAB GEOMETRY — extract footprint from IfcSlab tessellation (IfcPolygonalFaceSet)
# ─────────────────────────────────────────────────────────────────────────────

def _parse_polygonalfaceset(m: 'IFCModel', faceset_id: int) -> dict[str, Any] | None:
    """
    Parse IFCPOLYGONALFACESET → list of flat face polygons (constant Z per face).
    Returns { 'vertices': [(x,y,z)...], 'flat_faces': [[(x,y,z)...]...] }
    or None if not parseable.
    """
    e = m.get(faceset_id)
    if e is None:
        return None
    etype, args = e
    if etype != 'IFCPOLYGONALFACESET' or len(args) < 3:
        return None

    # Parse vertex coordinate list (IFCCARTESIANPOINTLIST3D)
    ptlist_id = _ref(args[0])
    ptlist = m.get(ptlist_id)
    if ptlist is None:
        return None
    raw = ptlist[1][0]
    tuples = re.findall(r'\(([^()]+)\)', raw)
    vertices: list[tuple[float, float, float]] = []
    for t in tuples:
        c = t.split(',')
        if len(c) >= 3:
            try:
                vertices.append((_float(c[0]), _float(c[1]), _float(c[2])))
            except (ValueError, IndexError):
                pass

    if not vertices:
        return None

    # Parse face index references
    face_list_raw = args[2].strip()
    face_refs = [_ref(r.strip()) for r in face_list_raw.strip('()').split(',')
                 if r.strip().startswith('#')]

    flat_faces: list[list[tuple[float, float, float]]] = []
    for fid in face_refs:
        fe = m.get(fid)
        if fe is None:
            continue
        ftype, fargs = fe
        if ftype not in ('IFCINDEXEDPOLYGONALFACE', 'IFCINDEXEDPOLYGONALFACEWITHVOIDS'):
            continue
        idx_raw = fargs[0].strip('()')
        try:
            idxs = [int(i.strip()) for i in idx_raw.split(',')
                    if i.strip().lstrip('-').isdigit()]
        except ValueError:
            continue
        fverts = [vertices[i - 1] for i in idxs if 1 <= i <= len(vertices)]
        if len(fverts) < 3:
            continue
        # Keep only flat faces (all vertices share the same Z within tolerance)
        zs = {round(v[2], 4) for v in fverts}
        if len(zs) == 1:
            flat_faces.append(fverts)

    return {'vertices': vertices, 'flat_faces': flat_faces}


def _polygon_area_2d(pts: list[tuple[float, float]]) -> float:
    """Signed shoelace area of a 2-D polygon."""
    n = len(pts)
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += pts[i][0] * pts[j][1]
        area -= pts[j][0] * pts[i][1]
    return abs(area) / 2.0


def _extract_slab_data(m: 'IFCModel', slab_id: int) -> dict[str, Any] | None:
    """
    Extract footprint polygon + thickness from IFCSLAB (tessellation geometry).
    Returns {
        'guid', 'name',
        'footprint': [(x, y), …],  # metres, world XY
        'thickness': float,         # metres
        'baseZ':     float,         # metres, world Z of bottom face
    }
    Returns None when geometry cannot be extracted or the slab is too small.
    """
    e = m.get(slab_id)
    if e is None:
        return None
    etype, args = e
    if etype != 'IFCSLAB':
        return None

    guid         = _unquote(args[0]) if args else ''
    name         = _unquote(args[2]) if len(args) > 2 else ''
    placement_id = _ref(args[5]) if len(args) > 5 else None
    rep_id       = _ref(args[6]) if len(args) > 6 else None

    if rep_id is None:
        return None

    # Resolve placement (translation + 2-D rotation via x_dir)
    origin, x_dir, _ = _resolve_placement(m, placement_id)
    y_dir = [-x_dir[1], x_dir[0], 0.0]

    def _tr(pt: tuple[float, float, float]) -> tuple[float, float, float]:
        wx = origin[0] + pt[0] * x_dir[0] + pt[1] * y_dir[0]
        wy = origin[1] + pt[0] * x_dir[1] + pt[1] * y_dir[1]
        wz = origin[2] + pt[2]
        return (wx, wy, wz)

    # Find Body representation → IFCPOLYGONALFACESET
    rep = m.get(rep_id)
    if rep is None:
        return None
    _, rargs = rep
    shape_list = _inner(rargs[2]) if len(rargs) > 2 else ''
    shape_ids = [_ref(r.strip()) for r in shape_list.split(',') if r.strip().startswith('#')]

    faceset_data: dict[str, Any] | None = None
    for sh_id in shape_ids:
        sh = m.get(sh_id)
        if sh is None:
            continue
        _, shargs = sh
        rep_tag = shargs[1].strip().strip("'") if len(shargs) > 1 else ''
        if rep_tag != 'Body':
            continue
        items_raw = _inner(shargs[3]) if len(shargs) > 3 else ''
        item_ids = [_ref(r.strip()) for r in items_raw.split(',') if r.strip().startswith('#')]
        for it_id in item_ids:
            it = m.get(it_id)
            if it and it[0] == 'IFCPOLYGONALFACESET':
                faceset_data = _parse_polygonalfaceset(m, it_id)
                if faceset_data:
                    break
        if faceset_data:
            break

    if not faceset_data or not faceset_data['flat_faces']:
        return None

    vertices = faceset_data['vertices']
    flat_faces = faceset_data['flat_faces']

    # Z extent in local space
    all_z = [v[2] for v in vertices]
    max_z = max(all_z)
    min_z = min(all_z)
    thickness = max_z - min_z  # metres

    if thickness < 0.001:  # < 1 mm — skip degenerate slabs
        return None

    # Find the topmost flat face (constant Z at max_z)
    top_faces = [f for f in flat_faces if abs(f[0][2] - max_z) < 0.002]
    if not top_faces:
        top_faces = flat_faces  # fallback to any flat face

    # Among matching faces take the one with the largest 2-D area
    def _face_area(fv: list[tuple[float, float, float]]) -> float:
        return _polygon_area_2d([(v[0], v[1]) for v in fv])

    best_local = max(top_faces, key=_face_area)

    # Transform to world coordinates
    world_pts = [_tr(v) for v in best_local]

    # Discard tiny elements (< 0.25 m²)
    area = _polygon_area_2d([(p[0], p[1]) for p in world_pts])
    if area < 0.25:
        return None

    footprint_xy = [(p[0], p[1]) for p in world_pts]
    base_z = origin[2] + min_z

    return {
        'guid':      guid,
        'name':      name,
        'footprint': footprint_xy,  # metres
        'thickness': thickness,      # metres
        'baseZ':     base_z,         # metres, world Z
    }


def _wall_footprint_mm(wall: dict[str, Any]) -> list[list[float]]:
    """Build 4-point footprint rectangle (mm) from wall axis + thickness."""
    x1, y1 = wall['startPt_mm']
    x2, y2 = wall['endPt_mm']
    dx, dy  = x2 - x1, y2 - y1
    length  = math.hypot(dx, dy)
    if length < 1.0:
        return []
    ux, uy = dx / length, dy / length   # unit along wall
    px, py = -uy, ux                    # unit perpendicular (left side)
    half   = wall['thickness_mm'] / 2.0
    return [
        [round(x1 + px * half, 1), round(y1 + py * half, 1)],
        [round(x2 + px * half, 1), round(y2 + py * half, 1)],
        [round(x2 - px * half, 1), round(y2 - py * half, 1)],
        [round(x1 - px * half, 1), round(y1 - py * half, 1)],
    ]


def parse_ifc_plan(ifc_path: str) -> dict[str, Any]:
    """
    Parse the complete IFC file and return 2D plan data for ALL storeys.

    Returns
    -------
    {
      "storeys": [
        {
          "id":           str,      # "storey_0", "storey_1", ...
          "name":         str,
          "elevation_mm": float,
          "height_mm":    float,
          "walls": [
            {
              "id":            str,    # "w_<storey_idx>_<wall_idx>"
              "guid":          str,
              "name":          str,
              "startPt_mm":    [x, y],
              "endPt_mm":      [x, y],
              "footprint_mm":  [[x,y], [x,y], [x,y], [x,y]],  # 4-pt rect
              "thickness_mm":  float,
              "height_mm":     float,
              "openings":      [...],
            },
            ...
          ],
          "slabs": [
            {
              "id":               str,   # "sl_<storey_idx>_<slab_idx>"
              "guid":             str,
              "name":             str,
              "footprint_mm":     [[x,y], ...],  # N-point polygon
              "thickness_mm":     float,
              "baseElevation_mm": float,          # world Z of slab bottom
            },
            ...
          ],
          "axesX_mm": [...],
          "axesY_mm": [...],
        },
        ...
      ],
      "worldBounds": {
        "minX_mm": float, "minY_mm": float,
        "maxX_mm": float, "maxY_mm": float,
      },
      "totalWalls": int,
    }
    """
    m = IFCModel()
    m.load(ifc_path)

    rels = _build_rel_maps(m)
    MM   = 1000.0

    # ── Collect all storeys ───────────────────────────────────────────────
    storey_list: list[tuple[int, str, float]] = []
    for eid, args in m.find_all('IFCBUILDINGSTOREY'):
        name = _unquote(args[2]) if len(args) > 2 else f'Storey-{eid}'
        elev = _float(args[9]) if len(args) > 9 and args[9] not in ('$', '') else 0.0
        storey_list.append((eid, name, elev))
    storey_list.sort(key=lambda x: x[2])

    # ── Process each storey ───────────────────────────────────────────────
    all_x: list[float] = []
    all_y: list[float] = []
    storeys_out: list[dict[str, Any]] = []

    for s_idx, (storey_id, storey_name, storey_elev) in enumerate(storey_list):
        # Storey height
        if s_idx + 1 < len(storey_list):
            storey_h = storey_list[s_idx + 1][2] - storey_elev
        else:
            storey_h = 3.0

        element_ids: set[int] = set(rels['storey_elements'].get(storey_id, []))
        walls_out: list[dict[str, Any]] = []

        for w_idx, wall_id in enumerate(element_ids):
            e = m.get(wall_id)
            if e is None:
                continue
            etype, _ = e
            if etype not in ('IFCWALL', 'IFCWALLSTANDARDCASE'):
                continue

            wall_data = _extract_wall_axis(m, wall_id)
            if wall_data is None:
                continue

            # Openings
            openings_out: list[dict[str, Any]] = []
            for op_id in rels['wall_openings'].get(wall_id, []):
                fill_id = rels['opening_fills'].get(op_id)
                op = _extract_opening(m, op_id, fill_id, wall_data)
                if op:
                    openings_out.append({
                        'type':                op['type'],
                        'name':                op['name'],
                        'width_mm':            round(op['width'] * MM),
                        'height_mm':           round(op['height'] * MM),
                        'sillHeight_mm':       round(max(0.0, op['sillHeight']) * MM),
                        'offsetAlongWall_mm':  round(op['offsetAlongWall'] * MM),
                    })

            wall_rec: dict[str, Any] = {
                'id':           f'w_{s_idx}_{w_idx}',
                'guid':         wall_data['guid'],
                'name':         wall_data['name'],
                'startPt_mm':   [round(wall_data['startPt'][0] * MM), round(wall_data['startPt'][1] * MM)],
                'endPt_mm':     [round(wall_data['endPt'][0] * MM),   round(wall_data['endPt'][1] * MM)],
                'thickness_mm': round(wall_data['thickness'] * MM),
                'height_mm':    round(storey_h * MM),
                'openings':     openings_out,
            }
            wall_rec['footprint_mm'] = _wall_footprint_mm(wall_rec)

            walls_out.append(wall_rec)
            # Accumulate world bounds
            for pt in [wall_rec['startPt_mm'], wall_rec['endPt_mm']]:
                all_x.append(pt[0]); all_y.append(pt[1])

        # ── Extract slabs for this storey ─────────────────────────────────
        slabs_out: list[dict[str, Any]] = []
        sl_idx = 0
        for elem_id in element_ids:
            e = m.get(elem_id)
            if e is None:
                continue
            etype, _ = e
            if etype != 'IFCSLAB':
                continue

            slab_data = _extract_slab_data(m, elem_id)
            if slab_data is None:
                continue

            slabs_out.append({
                'id':               f'sl_{s_idx}_{sl_idx}',
                'guid':             slab_data['guid'],
                'name':             slab_data['name'],
                'footprint_mm':     [[round(p[0] * MM, 1), round(p[1] * MM, 1)]
                                     for p in slab_data['footprint']],
                'thickness_mm':     round(slab_data['thickness'] * MM),
                'baseElevation_mm': round(slab_data['baseZ'] * MM),
            })
            # Accumulate bounds from slab footprint too
            for p in slab_data['footprint']:
                all_x.append(p[0] * MM); all_y.append(p[1] * MM)
            sl_idx += 1

        axes_x, axes_y = _detect_grid(
            [{'startPt': [w['startPt_mm'][0] / MM, w['startPt_mm'][1] / MM],
              'endPt':   [w['endPt_mm'][0]   / MM, w['endPt_mm'][1]   / MM]}
             for w in walls_out]
        )

        storeys_out.append({
            'id':           f'storey_{s_idx}',
            'name':         storey_name,
            'elevation_mm': round(storey_elev * MM),
            'height_mm':    round(storey_h * MM),
            'walls':        walls_out,
            'slabs':        slabs_out,
            'axesX_mm':     [round(x * MM) for x in axes_x],
            'axesY_mm':     [round(y * MM) for y in axes_y],
        })

    world_bounds = {
        'minX_mm': round(min(all_x)) if all_x else 0,
        'minY_mm': round(min(all_y)) if all_y else 0,
        'maxX_mm': round(max(all_x)) if all_x else 0,
        'maxY_mm': round(max(all_y)) if all_y else 0,
    }

    return {
        'storeys':    storeys_out,
        'worldBounds': world_bounds,
        'totalWalls':  sum(len(s['walls']) for s in storeys_out),
        'totalSlabs':  sum(len(s['slabs']) for s in storeys_out),
    }
