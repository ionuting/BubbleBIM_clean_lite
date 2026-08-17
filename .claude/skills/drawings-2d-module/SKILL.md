---
name: drawings-2d-module
description: Maps the 2D drafting views — FloorPlan2DViewer (its own large standalone SVG pipeline with annotations/rebar/roof/custom symbols) versus Section2DViewer + Elevation2DViewer (thin consumers of the shared src/lib/drawingEngine.ts). Covers the DrawingResult u/v coordinate model, line-weight and hatch conventions, and the door/window symbol override system. Use when adding 2D view features, fixing plan/section/elevation rendering, or touching wall/opening 2D projection.
---

# 2D drawings module (plan / section / elevation)

## The one thing to get right first

**Floor plan is architecturally separate from section/elevation.** They are
NOT three thin consumers of one shared engine — only two of them are.

| Viewer | Geometry source | Extra capability |
|---|---|---|
| `FloorPlan2DViewer.tsx` | Computes its own SVG geometry **inline**, importing primitives directly from `bimGeometry.ts` (`calcWallGeometry`, `calcRoomPolygon`, `calcShellPolygon`, `collectOpenings`, `calcSpanEffectiveEnds`, ...) | Annotation layer (`SvgAnnotationLayer`), rebar/reinforcement layer (`RebarLayer`/`RebarPanel`/`useArmare`), roof plan (`buildRoofPlan`), custom window/door symbol resolution (`useWindowSymbolConfig`, `useDoorSymbolConfig`, `resolveWindowPlan2DConfig`), `DrawingPropertiesPanel` |
| `Section2DViewer.tsx` | `computeSectionView()` from `src/lib/drawingEngine.ts` | — |
| `Elevation2DViewer.tsx` | `computeElevationView()` from `src/lib/drawingEngine.ts` | — |

If you're asked to add a capability to section/elevation that floor plan
already has (annotations, custom symbols, rebar), it does not exist for them
yet — it would need to be built into `drawingEngine.ts`, not copied from
`FloorPlan2DViewer.tsx`. Conversely, don't go looking for `DrawingResult` or
`drawingEngine.ts` inside `FloorPlan2DViewer.tsx` — it isn't there.

## The shared engine (section + elevation only)

```
computeSectionView(nodes, edges, matConfig, { cutY, cutDepth, elevMin, elevMax })
computeElevationView(nodes, edges, matConfig, dir, elevMin?, elevMax?)
  → DrawingResult = { shapes, axes, levels, uMin, uMax, vMin, vMax }
```

Both reuse the SAME 3D geometry functions as the 3D viewers
(`calcWallGeometry`, `calcWallJoins`, `getAxRealPos`, `parseColumnDims` from
`bimGeometry.ts`) — they project that geometry differently, they don't
recompute it. If a wall/column looks wrong in section but right in 3D, the
bug is almost always in the projection code inside `drawingEngine.ts`, not
in `bimGeometry.ts`.

### Coordinate model — the key mental model

- Drawing-space is `(u, v)` **in mm**, not raw BIM `(x, y, z)`.
  - `v` = vertical (elevation mm) for both section and elevation.
  - `u` = horizontal position along the view's own axis. For elevations
    it's view-direction-dependent (`toUDepth`: N/S pick `bimX`, E/W pick
    `bimY`, with sign flips per direction — see `computeElevationView`).
- Every shape also carries `depthMm` — distance from the viewer — used for
  **painter's-algorithm** back-to-front sorting
  (`shapes.sort((a,b) => b.depthMm - a.depthMm)`). This is how layering
  works; there's no real hidden-line/occlusion solve.
- The viewer components (not the engine) convert `(u, v)` → SVG pixels via
  local `toX`/`toY`, Y-flipped (`toY = drawH - (v - vMin)`). If geometry
  looks mirrored, offset, or the wrong way up, check the VIEWER's `toX`/
  `toY` first — the engine's `(u, v)` values are usually already correct.

### Visual conventions

- `DrawingShape.lineWeight` (`'heavy-cut' | 'projected' | 'hidden' | ...`)
  maps through `LW` (stroke width) / `DASH` (dash pattern) constants in
  `drawingEngine.ts`.
- `DrawingShape.hatch` maps to `fill="url(#hatch-${name})"`, with the
  pattern defs rendered once per viewer by `<SvgHatchDefs>`.
- Fill/stroke colors come from `getVis(elementType, material, matConfig,
  node)` — the same material-config lookup the 3D viewers use — not
  hardcoded per shape.

## Symbol overrides (floor plan only)

`FloorPlan2DViewer` calls `resolveSymbolDef` (`svgSymbolStore.ts`) so users
can register a custom 2D symbol per window/door `typeKey` + `viewType`
(floorplan/section/elevation), overriding the hardcoded fallback rendering.
Check there before hand-editing a hardcoded door/window shape — the fix may
belong in the symbol library, not the viewer.

## Gotchas

1. **Don't add wall/opening geometry logic inside a viewer.** It belongs in
   `bimGeometry.ts` (shared with the 3D viewers and `drawingEngine.ts`) —
   duplicating it locally will drift from the 3D representation the moment
   either side changes.
2. **Section/elevation vertical bounds have an override chain**: a
   `section`/view-tab node's own properties (`cut_depth_mm`,
   `start_elevation_mm`, `cutHeight`, `flipped`, ...) take priority over the
   component's own props, which take priority over storey
   `bottomElevation`/`topElevation` defaults. Check `Section2DViewer.tsx`'s
   prop-resolution block at the top of the component before assuming a
   hardcoded default is in play.
3. **`embedded` prop disables pan/zoom** on all of Section2DViewer /
   Elevation2DViewer (and presumably FloorPlan2DViewer — verify before
   relying on it) — used when composed into `SheetComposer.tsx` (print
   sheets) or the calculation-memo report insets. Don't add interaction
   logic assuming the component always owns its own pan/zoom state.
4. **No dedicated test file for `drawingEngine.ts` or `FloorPlan2DViewer.tsx`**
   as of this writing — verify that before assuming coverage exists.
   Geometry correctness is exercised indirectly through `bimGeometry.test.ts`
   (the functions both consume), not directly. Visual regressions need
   manual/screenshot verification.

## Wiring into the app

View tab types: `'floorplan' | 'section' | 'elevation'`, plus
`'opengeo-floorplan' | 'opengeo-section' | 'opengeo-elevation'` variants for
the OpenGeometry-only profile — all in `store/index.ts`'s `ViewTabType`.
Opened via `handleOpenFloorPlanTab` / `handleOpenSectionTab` /
`handleOpenOGElevationTab` etc. in `BubbleGraphPanel.tsx`. The same three
viewer components also render (via `embedded`) inside `SheetComposer.tsx`
and the calculation-memo report — one rendering stack, multiple hosts.
