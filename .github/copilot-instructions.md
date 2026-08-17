# BubbleGraph BIM — Copilot Agent Instructions

> **Updated guidance:** For current architecture and agent workflows, prefer **[AGENTS.md](../AGENTS.md)** and **`.cursor/skills/`** (see `src/lib/agentSkillsRegistry.ts`). Production is **Clean Lite on Hetzner** with OpenGeometry 3D — not LadyBugDB/Babylon-primary below.

## Vision

BubbleGraph is a **full BIM (Building Information Modeling) platform** inspired by ArchiCAD and Revit,
built on top of a **relational graph database (LadyBugDB)**.

The application starts from a relational node-edge graph and grows into:
1. **3D parametric model** rendered in Babylon.js
2. **2D orthographic views** (floor plans, sections, elevations) derived from the 3D model
3. **Sheet compositions** — scalable viewports placed on drawing sheets
4. **Metadata queries** — all building information stored and queried via LadyBugDB
5. **Project data lake** — packaged as a `.bbim` ZIP containing LadyBugDB databases + assets

---

## Architecture

### Coordinate System (BIM Standard — matches Revit / Blender / ArchiCAD)

```
X → East  (plan horizontal right)
Y → North (plan horizontal up)
Z → Up    (vertical elevation)
```

In Babylon.js (Y-up scene), the mapping is:
```
BIM X  →  Babylon X    (unchanged)
BIM Y  →  Babylon Z    (plan north becomes scene depth)
BIM Z  →  Babylon Y    (elevation becomes scene up)
```

All node coordinates in the store use **millimeters (mm)**. Babylon.js scene uses **meters**.
Conversion: `mm * 0.001 = meters`.

Storey `bottomElevation` and `topElevation` are also in **mm**.

### Tech Stack

| Layer       | Technology                                  |
|-------------|---------------------------------------------|
| Frontend    | React 18 + TypeScript 5 + Vite 5 + Tailwind 4 |
| State       | Zustand 4 — `src/store/index.ts`           |
| 3D Viewer   | Babylon.js v9 (`@babylonjs/core`)           |
| 2D Viewer   | SVG (React) — `FloorPlan2DViewer.tsx`       |
| Graph DB    | LadyBugDB (Cypher only — no SQL)           |
| Backend API | FastAPI (Python) — port 8000 (`backend/main.py`) |
| Desktop     | C# .NET 8 WinForms + WebView2              |

### Project File Format — `.bbim` ZIP

A project is stored as a ZIP file containing:
```
project.json          ← manifest (name, version, schema version)
graph.ladybugdb       ← primary relational graph database (nodes, edges, metadata)
views.ladybugdb       ← saved views, sections, elevations, sheets
assets/               ← embedded images, textures, attachments
```

All databases use **LadyBugDB Cypher** queries — never SQL.

---

## Domain Model

### Node Types (stored in `bubbleGraphNodes`)

| Type         | BIM Equivalent        | Geometry              |
|--------------|-----------------------|-----------------------|
| `storey`     | IfcBuildingStorey     | Horizontal container  |
| `column`     | IfcColumn             | Vertical box extrusion|
| `beam`       | IfcBeam               | Horizontal box span   |
| `wall`       | IfcWall               | Vertical panel span   |
| `slab`       | IfcSlab               | Horizontal plate      |
| `foundation` | IfcFooting            | Base block            |
| `window`     | IfcWindow             | Opening in wall       |
| `door`       | IfcDoor               | Opening in wall       |
| `room`       | IfcSpace              | Transparent volume    |
| `ax`         | IfcGridAxis           | Grid axis marker      |
| `shell`      | IfcRoof               | Shell surface         |
| `covering`   | IfcCovering           | Roof covering         |

### Edge Types

Edges connect nodes directionally (`from` → `to`):
- **wall edge**: both endpoints are nodes defining wall path
- **beam edge**: beam spans between two column/ax nodes
- **containment edge**: `storey` → child elements (via `parentId` on node)

### BuildingAxes

Global grid axes (mm), stored separately in `buildingAxes: { xValues: number[], yValues: number[] }`.

---

## ⭐ FOUNDATIONAL PRINCIPLE — Ax Node Index Architecture

This is the **core spatial mapping contract** of BubbleGraph. All code must respect it.

### The Rule

**Spatial position in plan is determined by an index into a sorted coordinate table — NEVER by
storing raw mm coordinates directly on the node.**

An `ax` node occupies the plan intersection at column `gridX` and row `gridY`:
```
physical_X_mm = sortedAxesX[gridX]
physical_Y_mm = sortedAxesY[gridY]
```

Each ax node also carries a flat `axNodeIndex` (sequential integer in the full grid):
```
axNodeIndex = gridY * axesX.length + gridX
```

### Ax Node Required Properties

Every `ax` node in LadyBugDB MUST have these three properties in its dictionary:

| Property       | Type    | Meaning                                               |
|----------------|---------|-------------------------------------------------------|
| `gridX`        | number  | Column index into `sortedAxesX` (0 = leftmost axis)  |
| `gridY`        | number  | Row index into `sortedAxesY` (0 = bottom axis)       |
| `axNodeIndex`  | number  | Flat index = `gridY * xCount + gridX`                |

All other properties (`has_column`, `column_type`, custom metadata, etc.) are freely mutable.

### LadyBugDB Coordinate Table

The axis coordinate lists live as a **dedicated table in the storey node** (not on ax nodes):

```cypher
// Each storey node carries:
CREATE (s:Storey {
  id: 'storey_001',
  axesX: [0, 6000, 12000, 18000],   // mm from origin, already sorted ascending
  axesY: [0, 5000, 10000],           // mm from origin, already sorted ascending
  ...
})
```

Position resolution (used identically in ALL viewers):
```typescript
const sortedX = [...storey.axesX].sort((a, b) => a - b);
const sortedY = [...storey.axesY].sort((a, b) => a - b);
const physical_x = sortedX[node.gridX];  // mm
const physical_y = sortedY[node.gridY];  // mm
```

### Regenerate Axes — Preserving Node Properties

When the user edits inter-axis distances on an existing storey:
1. The new `axesX`/`axesY` arrays are saved to the storey node in LadyBugDB.
2. The ax node **grid is fully regenerated** using the new axis arrays.
3. For every `(gridX, gridY)` that existed before AND still exists after the change,
   **all non-spatial properties are preserved** (copied from the old node).
4. New intersections (added axes) receive default ax properties.
5. Deleted intersections (removed axes) have their ax nodes deleted together with any
   edges referencing them.
6. Canvas layout positions (`node.x`, `node.y`) are recomputed from the new axis values
   centered on the storey canvas anchor.

The `gridX`/`gridY`/`axNodeIndex` values are **stable identifiers** — they do not change
when axis coordinates change. This is the same principle as Excel cell addresses (A1, B2):
the column/row label is permanent, the column width/row height is a separate parameter.

### What MUST NOT be done

- ❌ Store physical mm coordinates (`x_mm`, `y_mm`) on the ax node itself
- ❌ Use `node.x` / `node.y` canvas drag positions for BIM geometry (they are display-only)
- ❌ Compute geometry before sorting the `axesX`/`axesY` arrays
- ❌ Reindex ax nodes when axes change (preserve the `gridX`/`gridY` mapping)

---

## Multi-Viewer Tab System

The central area uses a tab system (`src/store/index.ts` → `ViewTab`):

| Tab Type      | Component              | Description                          |
|---------------|------------------------|--------------------------------------|
| `graph-editor`| BubbleGraphCanvas      | 2D node-edge relational graph        |
| `3d-model`    | BabylonViewer          | Full 3D parametric model             |
| `floorplan`   | FloorPlan2DViewer      | Orthographic top view (per storey)   |
| `section`     | SectionViewer          | Vertical cutting plane (orthographic)|
| `elevation`   | ElevationViewer        | External face orthographic view      |
| `table`       | TableViewer            | LadyBugDB query results as table     |
| `sheet`       | SheetViewer            | Viewport compositions for printing   |

---

## Views and Sections (BIM Workflow)

View planes are stored as **LadyBugDB nodes** of type `ViewPlane`:
```cypher
CREATE (v:ViewPlane {
  id: 'vp_001',
  type: 'section',          // 'floorplan' | 'section' | 'elevation' | 'sheet'
  name: 'Section A-A',
  origin: [x, y, z],        // mm
  normal: [nx, ny, nz],     // unit vector
  upVector: [ux, uy, uz],   // determines view orientation
  clipDepth: 5000,           // mm, how deep to cut
  scale: 100,                // 1:100
  disciplineFilter: 'architectural'
})
```

In the 3D viewer, active view planes render as **translucent cutting planes** (Babylon.js clipping planes).

### Orthographic Rendering for 2D Views

Use Babylon.js `FreeCamera` with `mode = Camera.ORTHOGRAPHIC_CAMERA` and computed ortho bounds.
Render to `RenderTargetTexture`, then export as SVG overlay or PNG for sheet composition.

### Sheet Composition

A `Sheet` is a LadyBugDB node containing an array of `Viewport` child nodes:
```cypher
CREATE (s:Sheet { id: 'sh_001', name: 'A1 Ground Floor Plan', width: 841, height: 594 })
CREATE (vp:Viewport { id: 'vp_ref_001', viewId: 'vp_001', x: 50, y: 50, width: 300, height: 200, scale: 100 })
CREATE (s)-[:HAS_VIEWPORT]->(vp)
```

---

## LadyBugDB Usage Rules

**CRITICAL — LadyBugDB supports Cypher ONLY:**
- ✅ `CREATE (n:Label { prop: value })`
- ✅ `MATCH (n:NodeType) RETURN n`
- ✅ `MATCH (a)-[r]->(b) RETURN a, r, b`
- ❌ No SQL (`INSERT`, `SELECT`, `UPDATE`, `DELETE`)

API pattern:
```typescript
import { Database, Connection } from "@ladybugdb/core";
const db   = new Database("path.db");
const conn = new Connection(db);
const result = await conn.query("MATCH (n:BubbleNode) RETURN n");
const rows   = await result.getAll(); // MUST call .getAll()
```

Schema nodes live in `graph.ladybugdb`; view configuration in `views.ladybugdb`.

---

## Coding Conventions

### File Layout
```
src/
  components/
    bubble-graph/        ← graph editor, node library, geometry resolver
    views/               ← BabylonViewer, FloorPlan2DViewer, SectionViewer, SheetViewer...
    ui/                  ← shadcn/ui primitives
  store/index.ts         ← Zustand store (single source of truth)
  lib/
    api.ts               ← backend REST calls (FastAPI port 8000)
    utils.ts             ← cn(), uid()...
backend/
  main.py                ← FastAPI + LadyBugDB
```

### Coordinate Conversion (always apply)
```typescript
const MM = 0.001; // mm → meters for Babylon.js

// bim() helper — converts BIM mm coords to Babylon.js Vector3 (meters, Y-up):
function bim(bx: number, by: number, bz: number): Vector3 {
  return new Vector3(bx * MM, bz * MM, by * MM);
  //                  East      Up/Elev   North
}
// Usage: bim(east_mm, north_mm, elevation_mm)
```

### Ax Node — Source of Truth for Column Grid Positions

**CRITICAL:** `node.x` and `node.y` on `ax` nodes are graph-canvas layout positions
(set by the user dragging nodes in the editor). They are **irrelevant for geometry**.

The real BIM plan position of an ax node is:
```typescript
const rx = storey.properties.axesX[node.properties.gridX]; // mm, absolute from origin
const ry = storey.properties.axesY[node.properties.gridY]; // mm, absolute from origin
```

The helper in `BabylonViewer.tsx`:
```typescript
function getAxRealPos(n: BubbleGraphNode, map: Map<string, BubbleGraphNode>): { x: number; y: number } {
  const storey = n.parentId ? map.get(n.parentId) : undefined;
  const axesX  = (storey?.properties?.axesX as number[]) ?? [];
  const axesY  = (storey?.properties?.axesY as number[]) ?? [];
  return { x: axesX[Number(n.properties.gridX ?? 0)] ?? 0,
           y: axesY[Number(n.properties.gridY ?? 0)] ?? 0 };
}
```

Grid lines in 3D/2D are drawn from `storey.properties.axesX` and `axesY` directly —
**never** from ax node positions.

### Dimension Type String Notation (centimetres)

All cross-section numbers in type strings are **centimetres** (not mm):

| Type string | Meaning          | Babylon.js size |
|-------------|------------------|-----------------|
| `C25x25`    | Column 25×25 cm  | 0.25 × 0.25 m   |
| `B30x60`    | Beam 30×60 cm    | 0.30 m × 0.60 m |
| `W20`       | Wall 20 cm thick | 0.20 m          |
| `SLAB15`    | Slab 15 cm thick | 0.15 m          |

Conversion: `number * 0.01` (cm → metres). Default column is `C25x25` (250×250 mm).

### BabylonViewer Geometry Parser (`src/components/views/BabylonViewer.tsx`)
- Type strings use **centimetre** notation — multiply by `0.01` (NOT `MM = 0.001`)
- Ax nodes with `has_column: "True"` render as full-height columns using `getAxRealPos()`
- Column vertical extent: `storey.bottomElevation` → `storey.topElevation` (both in mm)
- All positions pass through `bim(east_mm, north_mm, elev_mm)` helper
- Storey floor planes: translucent `CreateGround` at `bottomElevation` and `topElevation`
- Grid lines: `CreateLineSystem` from `storey.axesX` / `axesY` — one line per unique value
- Axes gizmo: three `CreateLineSystem` lines at world origin (X=red, Z=green/North, Y=blue/Up)
- All materials: `StandardMaterial`, colors from `NODE_COLOR` record

### 2D Floor Plan Viewer (`src/components/views/FloorPlan2DViewer.tsx`)

**AutoCAD axis convention:** axis 1 is bottom-left. X increases right (numeric: 1, 2, 3…),
Y increases upward (letters: A, B, C…). SVG Y is flipped:
```typescript
function toSvg(wx: number, wy: number) {
  return {
    x: (wx - minX) * SCALE + PAD,
    y: H - ((wy - minY) * SCALE + PAD), // Y flipped — bottom = min, top = max
  };
}
```

**Grid lines** are drawn from `storeyMeta.properties.axesX` / `axesY` (absolute mm).
**Ax node markers** are rendered at `axesX[gridX]`, `axesY[gridY]` — **never** `node.x/y`.
**Bounds** are computed from axis values + non-ax node positions (axis values are the floor plan extent).

### View Planes in Babylon.js
- Render as `MeshBuilder.CreatePlane` with transparency ~0.15
- Apply as `scene.clipPlane` (or `clipPlane2...4`) when viewing section
- Camera for 2D export: `FreeCamera` with `ORTHOGRAPHIC_CAMERA` mode
- Export to `RenderTargetTexture` → PNG → overlay in SVG sheet

---

## Naming & Label Conventions
- Storeys: numbered from 0 (ground), negative for basement (e.g. -1, -2)
- Grid axes X: numeric labels (1, 2, 3...)
- Grid axes Y: letter labels (A, B, C...)
- Section names: format `Section X-X` or `Section A-A`
- Elevation names: `North Elevation`, `South Elevation`, etc.
- Sheet sizes: ISO A0-A4 or custom mm

---

## Backend API Endpoints (FastAPI — port 8000)

```
GET  /graph           → { nodes, edges, buildingAxes, projectName }
POST /graph           → save graph
POST /graph/backup    → create timestamped backup
GET  /views           → list saved ViewPlane definitions
POST /views           → save a ViewPlane
GET  /sheets          → list Sheet definitions
POST /sheets          → save a Sheet
```

---

## Implementation Roadmap

The following major capabilities are planned (in priority order):

1. **✅ Graph editor** — relational node-edge BIM graph
2. **✅ 3D viewer** — Babylon.js with custom geometry parser
3. **✅ Floor plan 2D** — SVG orthographic top view with pan/zoom
4. **🔲 View planes in 3D** — cutting plane gizmos (section/elevation/floorplan)
5. **🔲 Section viewer** — orthographic side cut via Babylon.js clip plane
6. **🔲 Elevation viewer** — external face orthographic view
7. **🔲 Sheet composer** — scalable viewport grid on drawing sheet
8. **🔲 Table viewer** — LadyBugDB Cypher query result grid
9. **🔲 Project ZIP** — `.bbim` packaging with embedded LadyBugDB
10. **🔲 Metadata panel** — LadyBugDB queries per selected element
11. **🔲 IFC export** — proper IFC STEP from graph (re-implement ifcGenerator)
