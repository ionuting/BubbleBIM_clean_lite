---
name: fem-module
description: Maps the linear-elastic structural FEM spike (src/lib/fem/, FemViewer, the "Structural (FEM)" tab) — how bubble-graph nodes become an Awatif frame+shell model (single storey OR the whole building stacked), room-usage-category live loads, the solver's real deep-import API, and the non-obvious gotchas (shell reactions, Z-up GridHelper, node-anchor caching, cross-storey column matching). Use when adding/debugging structural analysis features, extending buildFemModel, touching @awatif/components, or when the user asks about columns/beams/walls/slabs being "modeled" or "not rendering" in the structural viewer, or about storey stacking / room loads.
---

# FEM module

## What this is

A linear-elastic structural model — either one storey OR the whole building
stacked at real elevations — built on top of `@awatif/components`'s solver
core. It is NOT the full Awatif app — only its bare analysis functions are
used, deep-imported directly (see "The @awatif/components import trick"
below). This is a spike: real, tested, wired into the app, but deliberately
narrow in scope (see Limitations). Loads are self-weight everywhere, plus a
room-usage-category imposed (live) load on room floor slabs (femLoads.ts) —
no wind, no load combinations.

## File map

| File | Role |
|---|---|
| `src/lib/fem/buildFemModel.ts` | Entry point. Converts one storey's graph nodes/edges — or, with `storeyId: 'all'`, every storey stacked — into Awatif's plain `{nodes, elements, elementsProps, supports, loads}` shape. Owns column/beam frame assembly, member subdivision, and cross-storey column continuity matching. |
| `src/lib/fem/buildShellElements.ts` | Wall (vertical panel) and slab (room polygon or standalone `slab` node) → 3-node shell elements. Owns the anchor-sharing/boundary-condition logic and applies a room's live load on top of its self-weight. |
| `src/lib/fem/femLoads.ts` | Room-usage-category imposed (live) load catalog (SR EN 1991-1-1 / Eurocode 1) — `room_load_category` property → kN/m², defaulting to `residential`. |
| `src/lib/fem/femSections.ts` | Section property formulas (rect/circular) + material constants (concrete C25/30) + the `FemElementProps` shape (mirrors Awatif's `ElementProps`). |
| `src/lib/fem/getFullReactions.ts` | Correct reaction computation (R = K·U − F). Use this, not Awatif's own `getReactions` — see Gotchas. |
| `src/components/views/FemViewer.tsx` | Diagnostic three.js viewer (plain Three.js, NOT `@awatif/ui`'s `getViewer` — that owns the whole DOM/page and doesn't fit a React component). Renders original + deformed (auto-scaled) + support markers. Accepts `storeyId: string | 'all' | null`. |
| `src/dev/femCheck.tsx` + `/fem-check.html` | Standalone dev harness — fixed synthetic model, same pattern as `brep-check.html`/`BrepViewer`. Good for visual smoke-testing without loading a real project. |
| `src/components/bubble-graph/BubbleGraphPanel.tsx` (grep `'fem'`) | App integration: `handleOpenFemTab`, the "🏗 Structural (FEM)" explorer section (per-storey list + a "🏢 Whole building" entry when there's more than one storey), the tab-content render block, and the room panel's "Live Load" dropdown (grep `room_load_category`). |
| `src/store/index.ts` — `ViewTabType` | `'fem'` is one tab type among floorplan/report/etc., with its own `storeyId` (a real storey id, or the literal string `'all'`). |

## Data flow

```
bubble-graph (nodes, edges, storeyId | 'all')
  → buildFemModel()               [buildFemModel.ts + buildShellElements.ts + femLoads.ts]
  → { nodes, elements, elementsProps, supports, loads }   (Awatif Mesh shape, plain arrays/Maps)
  → getPositionsAndForces(...)    [@awatif/components/analysis/l-solver/getPositionsAndForces — deep import]
  → getFullReactions(...)         [getFullReactions.ts — NOT Awatif's own getReactions]
  → FemViewer renders original + deformed + supports
```

## Core conventions

- **Coordinates**: metres, Z-up, gravity acts in **−Z**. Matches this repo's
  BIM convention (`bimGeometry.ts` header) and the solver's SI unit
  expectations. In single-storey mode (`storeyId` = a real storey id), the
  storey is built in **local** coordinates — `baseZ = 0` always, regardless
  of the storey's real `bottomElevation`. In whole-building mode
  (`storeyId: 'all'`), `baseZ` is each storey's real `bottomElevation`
  relative to the LOWEST storey's `bottomElevation` (so the ground floor
  still sits at z ≈ 0) — see "Multi-storey stacking" below.
- **Multi-storey stacking (`storeyId: 'all'`)**: builds every storey in ONE
  model instead of one floor in isolation — the same "whole building" the 3D
  viewers already render. Column continuity between storeys is inferred
  **geometrically**, not by graph node id: each storey owns its own
  independent `ax`/`column` nodes (there is no cross-storey node linkage in
  the graph — see `bimGeometry.ts`'s `getAxRealPos`), so a column's (x, y)
  plan position is matched against the storey directly below's column TOP
  nodes, rounded to 1mm (`posKey` in `buildFemModel.ts`). A match reuses that
  node as this column's base — real moment/shear continuity up the building.
  No match (only the true ground storey, or a column that starts partway up
  the building with nothing below it) falls back to a fresh fixed base at
  that storey — engineeringly rough for a mid-building "floating" column
  start, but keeps the model solvable (same philosophy as the wall/slab
  boundary-condition fallbacks below). A plain storey id still behaves
  exactly as it always did — this is purely additive, not a breaking change.
- **Room live loads (`femLoads.ts`)**: a `room` node's slab carries its
  `room_load_category` property's imposed load (SR EN 1991-1-1 / Eurocode 1
  categories — residential/office/assembly/balcony/stairs/storage/garage/
  attic/roof, one representative kN/m² each) ON TOP OF self-weight, applied
  the same triangle-area-weighted way self-weight already is
  (`buildShellElements.ts`'s `addTriLoad`). Unset → defaults to `residential`
  (1.5 kN/m²) — this is NOT zero, so every room slab has always carried some
  live load since this landed; there is no "self-weight only" room state
  short of setting an explicit (nonexistent) zero category. A standalone
  `slab` node (not a `room`) has no usage category and stays self-weight
  only, even if a `room_load_category` property is set on it by mistake.
- **Member subdivision for self-weight**: every column/beam is split into
  `divisions` sub-elements (default 4) with weight lumped consistently at
  each sub-node (`w·L/2` per side, accumulated). This mirrors
  `@awatif/components`'s OWN convention for a distributed load — verified by
  reading its `mesh/line-mesh/lineMesh.ts` + `loads/getLoads.ts` source. A
  single 2-node element under end-only point loads can never show span
  bending — that's why this exists.
- **Shared-DOF anchor caching**: a wall/slab corner that coincides with a
  column reuses that column's FEM node (real frame action, not just visual
  overlap). The cache (`anchorIndex` / `columnNodeIndex`) is seeded by the
  column loop and extended by walls/slabs on first touch, so two walls (or a
  wall and a slab) sharing a corner also share nodes.
- **Boundary-condition fallbacks**: a wall corner with no column gets a
  fresh, fixed "foundation" node; a slab corner with no column gets a pinned
  node (translations fixed, rotations free). Without this, a panel whose
  whole perimeter has no column would leave its DOF block disconnected from
  every restraint — the stiffness matrix would be **singular** and the solve
  would throw/NaN, not just be inaccurate. Every panel is deliberately kept
  self-supporting so the model always solves.
- **Slabs come from two sources**: a `room` node (gated by `has_slab` —
  `false`/`'False'` skips it, matching `ogBimMapper.ts`'s convention) OR a
  standalone `slab` node (always modeled — its existence means "there is a
  slab here"). Both resolve their polygon the same way: direct `ax`/`column`
  edge anchors first (`calcShellPolygon`'s rule); `room` additionally falls
  back to `calcRoomPolygon`'s legacy wall-adjacency walk when it has fewer
  than 3 direct anchors — standalone `slab` nodes have no such fallback.

## Gotchas (hard-won — read before touching this module)

1. **`@awatif/components` ships raw `.ts` source, no build, no `exports`
   map.** Deep imports like
   `@awatif/components/analysis/l-solver/getPositionsAndForces` resolve
   straight to source under Vite/Vitest — no compiled dist exists, don't go
   looking for one. Confirmed by extracting the npm tarball and reading it
   directly (`npm pack @awatif/components`).
2. **Awatif's own `getReactions` silently drops shell-element forces.** Its
   own source comment says so: *"Internal forces are frame-only; shell
   (3-node) elements get no entry."* A model with walls/slabs would report
   reactions ~50% short of true equilibrium through their function. Always
   use `getFullReactions.ts` (R = K·U − F, recomputed independently) once
   the model has any shell element. Verified empirically before writing the
   replacement, not assumed.
3. **`THREE.GridHelper` always lies flat in its own local XZ plane** —
   it ignores `camera.up`. Every OTHER viewer in this app (`BrepViewer`
   etc.) converts BIM Z-up coordinates to Three.js's native Y-up convention
   before building geometry, so their default GridHelper is already correct.
   `FemViewer` feeds raw Z-up coordinates straight into Three.js and
   compensates only via `camera.up.set(0,0,1)` — that fixes the CAMERA orbit
   but not GridHelper's own geometry. Fix: `grid.rotation.x = Math.PI / 2`.
   If you add another Z-up-fed Three.js helper here later, check whether it
   respects `camera.up` before assuming it "just works".
4. **`mathjs` is a direct dependency** (added for `getFullReactions.ts`) —
   needed because pnpm's strict `node_modules` layout blocks phantom
   dependency access; importing it without adding it to `package.json`
   fails to resolve even though it's already in the tree transitively via
   `@awatif/components`.
5. **A beam/wall/slab only connects if BOTH ends already have a column.**
   `ax` nodes need `has_column: 'True'` (string, not boolean — matches the
   rest of the bubble-graph convention) or be a standalone `column` node.
   An `ax` node that's merely part of the axis grid, with no column flagged,
   contributes nothing to the FEM model — this is the single most common
   reason a fresh project's Structural tab says "No columns/walls found".

## Limitations (intentional, not bugs)

- Dead (self-weight) + one imposed live-load category per room — no wind, no
  load cases/combinations, no factored (ULS/SLS) combinations, just both
  always-on at characteristic value.
- Multi-storey column continuity is inferred by (x, y) position matching,
  not real topology — two unrelated columns at the same plan position in
  adjacent storeys (unlikely, but possible in a messy graph) would
  incorrectly merge into one continuous member.
- A column that starts partway up the building (nothing below it at that
  plan position) gets a fixed base at ITS OWN storey — not a physically
  meaningful "transfer" or "floating" condition, just what keeps the model
  solvable. Same rough-sketch caveat already applies to wall/slab corners
  with no column (see buildShellElements.ts's header).
- No code-checking (Eurocode etc.) — Awatif's own package has this
  (`design/concrete-member`, `design/steel-member`...), unused here.
- Wall/slab triangulation is a manual fan/quad split, not
  `@awatif/components`'s own `triangleMesh` (which needs an async
  `initTriangleMesh()` WASM load) — fine for simple convex footprints, wrong
  for non-convex ones.
- Wall panels run the full storey height on the plain centreline — no
  join/offset trimming (ring-beam masonry-height reduction IS modelled — see
  buildIfcModel.ts's parallel note, buildFemModel just doesn't reduce wall
  panel height by beam height the way the IFC exporter does).

## Extending

- **Wind / other distributed loads**: follow the exact pattern in
  `addFrameMember` (buildFemModel.ts) — subdivide, lump `w·L/2` per
  sub-node — rather than implementing fixed-end-moment formulas by hand.
- **Load combinations**: femLoads.ts's live load is applied unconditionally
  at characteristic value; a real ULS/SLS combination system would need to
  keep self-weight and live-load contributions as SEPARATE accumulators
  (currently summed into one `loads` map in `addTriLoad`) so they can be
  factored independently before assembly.
- **Real transfer-structure / floating-column support**: instead of a fixed
  base fallback in `buildStorey`, detect a slab/beam at that storey spanning
  over the gap and connect into it (a genuinely more involved change — the
  current fallback is deliberately the simplest thing that still solves).
- **Non-convex slabs**: swap the fan triangulation in
  `buildShellElements.ts` for `@awatif/components`'s own
  `mesh/triangle-mesh/triangleMesh.ts` (`initTriangleMesh()` must resolve
  before first use — it fetches a `.wasm` file via a Vite `?url` import).

## Testing

- `src/lib/fem/buildFemModel.test.ts` — vitest, deep-imports the solver
  directly (no mocking): `getPositionsAndForces`/`getReactions` from
  `@awatif/components/analysis/l-solver/*`. Covers columns (grid + standalone),
  subdivision/sag, walls, both slab sources, `has_slab` gating, a
  `getFullReactions` vs. upstream `getReactions` equivalence check on a
  frame-only model, room live-load additivity (+ standalone `slab` nodes
  correctly getting none), and a dedicated multi-storey suite (real column
  continuity + node reuse, correct per-storey elevations, single-storeyId
  mode unchanged, and the "no storeys found" error for `'all'` on an empty
  graph).
- `/fem-check.html` — visual smoke test. No browser tooling is bundled in
  this environment; when verifying visually, install `playwright` in the
  session scratchpad (`npm install playwright@<pinned-version>`, matching
  whatever Chromium revision is already cached under
  `~/Library/Caches/ms-playwright`) rather than the project — don't add it
  as a project dependency.
- App integration: `'fem'` tabs only appear when `appProfile === 'full'`
  (gated in `BubbleGraphPanel.tsx`, matching how `Composer` is gated) — a
  Clean Lite / minimal build won't show the Structural (FEM) section at all.
