# BubbleGraph — Formula Context Reference

Formula expressions are accepted in most numeric fields throughout the Properties Panel.
When a field value contains letters or operators it is evaluated as a formula.

---

## 1. Basic Arithmetic & Math Functions

Always available, no node context required.

| Syntax | Example | Result |
|---|---|---|
| Arithmetic operators | `1200 + 300` | 1500 |
| Parentheses | `(3000 - 200) / 2` | 1400 |
| Constants | `PI`, `E` | 3.14159… |
| `sqrt(x)` | `sqrt(2) * 2500` | 3535.5 |
| `abs(x)` | `abs(-900)` | 900 |
| `round(x)` | `round(933.3)` | 933 |
| `floor(x)` / `ceil(x)` | `floor(1050 / 100) * 100` | 1000 |
| `min(a, b)` / `max(a, b)` | `max(900, wall_length * 0.12)` | ≥ 900 |
| `sin(x)` / `cos(x)` / `tan(x)` | `sin(PI/6)` | 0.5 |

---

## 2. Context Variables

Context variables are injected automatically from the **topology of the BIM graph**
when a node is selected in the Properties Panel.  
The variables available depend on which node is being edited:

| Variable | Type | Unit | Description | Requires |
|---|---|---|---|---|
| `wall_length` | number | mm | Effective span of the wall (after start/end offsets) | Wall parent |
| `wall_height` | number | mm | Wall height property (or storey height if unset) | Wall parent |
| `wall_thickness` | number | mm | Parsed from wall_type (e.g. `W20` → 200 mm) | Wall parent |
| `room_area` | number | m² | Polygon area of the adjacent room | Room connected to wall |
| `room_width` | number | mm | Bounding-box width (BIM X) of the room polygon | Room connected to wall |
| `room_depth` | number | mm | Bounding-box depth (BIM Y) of the room polygon | Room connected to wall |
| `room_height` | number | mm | Room height property | Room connected to wall |
| `room_perimeter` | number | mm | Polygon perimeter of the room | Room connected to wall |
| `storey_height` | number | mm | `topElevation − bottomElevation` of the parent storey | Parent storey |
| `storey_bottom` | number | mm | `bottomElevation` of the parent storey | Parent storey |
| `storey_top` | number | mm | `topElevation` of the parent storey | Parent storey |
| `w` | number | mm | Current width of the node being edited | node.width |
| `h` | number | mm | Current height of the node being edited | node.height |
| `sill` | number | mm | Current sill height of the node being edited | node.sill_height |

### Topology Resolution

```
window / door node
  └─ parent wall (via edge)
       ├─ wall_length, wall_height, wall_thickness
       ├─ storey (via parentId)
       │    └─ storey_height, storey_bottom, storey_top
       └─ room (via edge to wall)
            └─ room_area, room_width, room_depth, room_height, room_perimeter

inline opening (defined in wall.properties.windows / .doors)
  └─ the same wall context as above
```

> **Note:** `room_area` is resolved from the **first room node connected to the wall**.
> If a wall separates two rooms, the first room found in edge order is used.

---

## 3. Example Formulas

### Window width as % of wall length
```
wall_length * 0.40
```
*Window occupies 40% of the effective wall span.*

### Window width proportional to room area (glazing ratio)
```
room_area * 150000 / wall_length
```
*Total glazed area = 15% of floor area (15% × room_area m² = room_area × 0.15 m² = room_area × 150 000 mm²;
divide by wall_length to get opening width for one wall).*

### Window height = 2/5 of storey height
```
storey_height * 0.40
```

### Sill = 1/3 storey height
```
storey_height / 3
```

### Door height = storey height − 300 mm clearance, minimum 2100
```
max(2100, storey_height - 300)
```

### Window centred on wall
```
wall_length / 2
```
*(used in the Offset field to centre an opening)*

### Window width with minimum clamp
```
max(600, wall_length * 0.25)
```

### Offset: place opening at 1/4 from wall start
```
wall_length * 0.25
```

---

## 4. Where Formulas Are Evaluated

| Location | When context is resolved |
|---|---|
| Inline window/door panel (Properties Panel) | Live — on every keypress, tooltip shows resolved value |
| `collectOpenings()` (geometry pipeline) | At geometry build time — every 3D/2D rebuild |
| `resolveOpeningDims()` | Called by `collectOpenings`, all properties formula-evaluated |
| `Ara3DViewer`, `WebIfcViewer`, `BabylonViewer`, `FloorPlan2DViewer` | Whenever the geometry/plan is (re)built |

Formula strings are stored as-is in the node/opening properties dictionary.
The resolved numeric value is only computed at evaluation time — the original formula is always preserved.

---

## 5. Topology Diagram

```
Storey
│  bottomElevation, topElevation
│
├─ Ax node (gridX, gridY)
│    └─ column (optional, has_column = True)
│
├─ Wall  (connected between two Ax/Column nodes)
│    ├─ wall_type (W20, W30…), height, offsetStart, offsetEnd
│    ├─ has_windows + windows[] (inline opening list)
│    │    └─ { window_type, width*, height*, sill_height*, wall_offset* }
│    │         * can be a formula referencing context variables
│    ├─ has_doors + doors[] (inline opening list)
│    │    └─ { door_type, width*, height*, wall_offset*, swing }
│    └─ (edge) ──► Room
│                    └─ room polygon → area, bounds, perimeter
│
└─ Room  (polygon built from connected ax/column or wall adjacency)
     ├─ height, color
     └─ (edges to walls define the enclosing walls)
```

---

## 6. Formula Storage Format

Formulas are stored as plain **strings** in the node's `properties` dictionary.
Numeric fields that contain only digits are stored as numbers (no formula evaluation overhead).

```json
{
  "window_type": "W-FIX-100x120",
  "width": "wall_length * 0.35",
  "height": "storey_height * 0.40",
  "sill_height": "storey_height / 3",
  "wall_offset": "wall_length / 2"
}
```

When the geometry pipeline runs, `evalProp(rawValue, ctx)` is called on every dimension field:
- If the raw value is a number → returned as-is
- If the raw value is a formula string → evaluated with the wall's resolved `FormulaContext`
- If evaluation fails (bad syntax or missing variable) → falls back to library default

---

## 7. Adding New Context Variables

To expose additional variables to formulas, edit `resolveFormulaContext()` in
[`src/lib/formulaUtils.ts`](../src/lib/formulaUtils.ts):

1. Add the key to `FormulaContext` interface
2. Add the key to `CTX_KEYS` array
3. Populate the value inside `resolveFormulaContext()` using graph traversal

All `FormulaInput` components and `collectOpenings` will automatically receive the new variable.
