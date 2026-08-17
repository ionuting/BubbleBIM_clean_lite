# OpenGeometry Integration Plan — BubbleGraph BIM

**Date:** 2026-04-29  
**Package:** `opengeometry` (v0.0.7, MPL-2.0)  
**Repo:** https://github.com/OpenGeometry-io/OpenGeometry

---

## What OpenGeometry Brings

| Aspect | Current (Ara3D / TOC) | With OpenGeometry |
|--------|----------------------|-------------------|
| 3D geometry | `THREE.BoxGeometry` + manual math in `bimGeometryThree.ts` | Rust/WASM kernel — `Polygon.extrude()`, `Cuboid`, `Cylinder`, `Opening.subtractFrom()` |
| Boolean cuts (windows/doors) | `three-bvh-csg` (fragile JS CSG) | `Opening.subtractFrom(host)` — kernel-native, deterministic |
| 2D projections | Manual SVG math in `FloorPlan2DViewer` | `OGSceneManager` with HLR (Hidden Line Removal) — geometrically correct outlines |
| IFC/STEP/STL export | `ifcGenerator.ts` manual assembly | Kernel-native serialization: `exportIFC()`, `exportSTEP()`, `exportSTL()` |
| Performance for booleans | JS (slow on large models) | WebAssembly compiled from Rust |

---

## Architecture (Parallel, Non-Breaking)

```
BubbleGraph nodes/edges  ← Zustand store (unchanged)
         │
         ├── bimGeometry.ts        (coord math — reused by all)
         │
         ├── [Existing] Ara3DViewer        ← Three.js manual
         ├── [Existing] WebIfcViewer       ← ThatOpen/OBC fragments
         │
         └── [NEW] ogBimMapper.ts          ← BubbleGraph → OG shapes
                    │
                    ├── [NEW] OpenGeoViewer.tsx        3D (tab: opengeo-3d)
                    ├── [NEW] OGFloorPlanViewer.tsx    2D top proj (Phase 3)
                    ├── [NEW] OGSectionViewer.tsx      2D section  (Phase 3)
                    └── [NEW] OGElevationViewer.tsx    2D elevation (Phase 3)
```

All existing viewers remain fully functional. OG viewers are opened via new tab types.

---

## Phase 1 — Foundation + 3D Viewer

**Goal:** A working OpenGeometry 3D viewer tab rendering the full BIM model.

### Steps

1. **`npm install opengeometry`**  
   Copy `node_modules/opengeometry/dist/opengeometry_bg.wasm` → `public/opengeometry_bg.wasm`

2. **`src/lib/openGeoInit.ts`**  
   Singleton `Promise<void>` that calls `await OpenGeometry.create({ wasmURL: '/opengeometry_bg.wasm' })`.  
   Shared across all OG viewers — called once, guarded.

3. **`src/lib/ogBimMapper.ts`** — BubbleGraph nodes → OG shapes:
   | BIM Element | OpenGeometry |
   |-------------|--------------|
   | `column` / `ax(has_column)` | `new Cuboid({ center, width, height, depth })` |
   | `wall` | `new Polygon(profile).extrude(h)` + `Opening.subtractFrom(wallSolid)` |
   | `slab` | `new Polygon(axContour).extrude(thickness)` |
   | `beam` | `new Cuboid(...)` oriented along span |
   | `room` | `new Polygon(roomPoly).extrude(h)` (transparent) |
   | `shell/covering` | ring polygon extruded |

4. **`src/components/views/OpenGeoViewer.tsx`**  
   - Three.js scene (same renderer/orbit pattern as Ara3DViewer — copy camera/mouse code)  
   - `ogBimMapper.ts` builds OG solids → `shape.get_geometry_serialized()` → `THREE.BufferGeometry`  
   - Visibility filter (same `VisibilityFilter` component as Ara3DViewer)  
   - Selection highlight via emissive (same pattern as Ara3DViewer)

5. **`src/store/index.ts`**  
   - Add `'opengeo-3d'` to `ViewTabType`  
   - Add `'opengeo'` to `Viewer3DType`

6. **`src/components/bubble-graph/BubbleGraphPanel.tsx`**  
   - Add `'opengeo'` button to viewer selector toolbar in the `3d-model` tab  
   - `handleOpenOG3DTab` callback  
   - When `viewer3DType === 'opengeo'`: render `<OpenGeoViewer />`

### Files Created/Modified

| File | Action |
|------|--------|
| `public/opengeometry_bg.wasm` | Copy from node_modules |
| `src/lib/openGeoInit.ts` | Create |
| `src/lib/ogBimMapper.ts` | Create |
| `src/components/views/OpenGeoViewer.tsx` | Create |
| `src/store/index.ts` | Modify (ViewTabType + Viewer3DType) |
| `src/components/bubble-graph/BubbleGraphPanel.tsx` | Modify (button + renderer) |

---

## Phase 2 — Native Boolean Operations

**Goal:** Window/door openings cut with kernel booleans (replaces `three-bvh-csg`).

- `ogBimMapper.ts` already builds `Opening` objects in Phase 1 (without boolean)
- Phase 2: call `Opening.subtractFrom(wallSolid)` on each wall after collecting all openings
- Also: `booleanSubtraction([operands])` for `void` node type
- Handle OG scene snapshots: `addBrepEntityToScene` at insert, `replaceBrepEntityInScene` on rebuild

---

## Phase 3 — 2D Projections from Kernel

**Goal:** OG-based floor plan / section / elevation views via `OGSceneManager`.

> ⚠️ `OGSceneManager`/`OGEntityRegistry` API is in flux — verify method names from installed package  
> via `grep -r "OGSceneManager" node_modules/opengeometry/dist/`

### New Viewers

| Component | Tab Type | Description |
|-----------|----------|-------------|
| `OGFloorPlanViewer.tsx` | `opengeo-floorplan` | Top-down orthographic, HLR outlines → SVG |
| `OGSectionViewer.tsx` | `opengeo-section` | Vertical cut plane → projected SVG |
| `OGElevationViewer.tsx` | `opengeo-elevation` | External face orthographic → SVG |

### New Tab Types in Store

```typescript
// Add to ViewTabType:
| 'opengeo-3d'
| 'opengeo-floorplan'
| 'opengeo-section'
| 'opengeo-elevation'
```

---

## Phase 4 — Kernel Export (Bonus)

- **Export IFC** button in OpenGeoViewer → `ogScene.exportIFC()` (kernel-native)
- **Export STEP** → `ogScene.exportSTEP()`
- **Export STL** → `ogScene.exportSTL()`
- Potentially replaces/augments `backend/ifcGenerator.ts` for IFC quality

> ❌ **PDF export does NOT work in browser** — only STL/STEP/IFC work browser-side.  
> Continue using TechnicalDrawingsViewer for PDF/print.

---

## Key Constraints

| Constraint | Detail |
|------------|--------|
| WASM init | `Vector3` must NOT be used before `OpenGeometry.create()` resolves |
| Peer dep | `three >= 0.168.0` — satisfied (project uses `^0.176.0`) |
| Scene snapshots | Not live — `replaceBrepEntityInScene` needed on node changes |
| WASM init latency | ~200ms first load — init lazy on first OG tab open |
| PDF export | Browser-side not supported — do not implement |
| API stability | `OGSceneManager` projection API is in-flight — verify from package before use |

---

## Implementation Priority

```
Phase 1 (3D viewer) → Phase 2 (booleans) → Phase 3 (2D projections) → Phase 4 (export)
```

Phase 3 is the highest value delivery: geometrically correct 2D projections via HLR replace the current manual SVG math.
