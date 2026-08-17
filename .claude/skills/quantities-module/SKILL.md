---
name: quantities-module
description: Maps the bill-of-quantities / F3 takeoff pipeline (src/lib/quantityTakeoff/, src/lib/norms/, QuantitiesPanel, calculation memo) — how graph nodes become norm-matched quantity lines and F3 rows, the compiled-catalog + project-override system, and the Clean Lite stub. Use when adding element measures, norm mapping rules, quantity/cost export, or when the user asks about the F3 table, deviz, calculation memo, or "why is this quantity wrong/missing".
---

# Quantities module

## What this is

Computes a Romanian-convention bill of quantities (deviz / "F3 schedule")
from the bubble-graph: every node is measured geometrically, matched against
a catalog of construction norms, and aggregated into priced/quantified rows.

## The pipeline (core mental model)

```
node
  → measureNode()                         [geometryMeasures.ts]
  → NodeMeasures                          (length_m, area_m2, net_area_m2,
                                            volume_m3, count, opening_area_m2, ...)
  → findMappingRules(nodeType, elementTypeId, material)
                                           [norms/catalog.ts, against getActiveCatalog().mapping]
  → per matched rule's outputs[]           (measure: length | area | volume | count
                                             | opening_area | formula)
  → applyOutput() → TakeoffLine            [takeoffEngine.ts]
  → aggregateF3()                         groups lines by `normId::storeyId`
  → F3Row[]                               (nrCrt, symbol, denumire, unit, quantity,
                                            capitol, categorie, storeyId, nodeIds)
```

`computeFullTakeoff(nodes, edges)` (`takeoffEngine.ts`) is the ONE entry
point — returns `{ lines, f3 }`. Called once, in `BubbleGraphPanel.tsx`, and
passed down to `QuantitiesPanel`.

`elementTypeId` / `material` — the two keys mapping rules match on — come
from `getElementTypeId(node)` / `getElementMaterial(node)`
(`geometryMeasures.ts`), which read the node's own `properties`, not its
display `name`.

## File map

| File | Role |
|---|---|
| `src/lib/quantityTakeoff/geometryMeasures.ts` | `measureNode()` — the ONE place raw geometry (length/area/volume/etc.) is derived per node type. `getElementTypeId`/`getElementMaterial` live here too. |
| `src/lib/quantityTakeoff/takeoffEngine.ts` | `computeTakeoff` → `TakeoffLine[]`, `aggregateF3` → `F3Row[]`, `computeFullTakeoff` (the entry point). |
| `src/lib/quantityTakeoff/calcTrace.ts` | Calculation **provenance** (`traceForOutput`) — which inputs/formula produced a given number. Used by the calculation memo, and the first place to look when a quantity looks wrong. |
| `src/lib/quantityTakeoff/customCalc.ts` + `src/store/customCalcStore.ts` | A SEPARATE, user-editable node-graph (param/const/op/result nodes) for one-off computed quantities per element. Independent of the norm-mapping pipeline above — not wired into F3 automatically. |
| `src/lib/quantityTakeoff/f3Export.ts` | CSV export (F3 schedule + takeoff detail). |
| `src/lib/norms/catalog.ts` | `getActiveCatalog()` — the runtime source of truth for norm articles + mapping rules, with project overrides merged in. |
| `src/lib/norms/catalogCompiled.ts` (+ `generated/norms.compiled.json`) | The ACTUAL runtime catalog data — compiled from editable Markdown by `scripts/compile-norms-library.mjs`. |
| `src/lib/norms/devizZidarieConfinata.ts`, `elementNormMapping*.ts`, `indicatorCStarter.ts` | Hardcoded TS catalog modules — a **migration anchor only**, checked by `catalogCompiled.fidelity.test.ts` so they don't silently diverge from the compiled JSON. Nothing at runtime reads them directly (`getLegacyZidarieCatalog()` is test/tooling-only). |
| `src/store/mappingOverrideStore.ts` | Project-level rule/article overrides merged over the base catalog, cache-invalidated by revision. |
| `src/components/quantities/QuantitiesPanel.tsx` | UI: F3 table ⟷ Calculation memo (`CalcReportPanel`) toggle, filters, detail breakdown, export buttons. |

## Gotchas

1. **Don't edit `generated/norms.compiled.json` by hand and expect it to
   stick** — it's a build artifact. Edit the source Markdown library and run
   `scripts/compile-norms-library.mjs` to regenerate it. Also don't edit the
   hardcoded TS catalog modules (`devizZidarieConfinata.ts` etc.) expecting
   a runtime effect — they're the migration anchor, not the live source.
2. **`quantity <= 0` lines are silently dropped** in `computeTakeoff` — a
   norm that matches but computes to zero (or negative, e.g. net area after
   opening subtraction) never becomes a `TakeoffLine`. If a norm is
   "missing" from the F3 table, check the measure value before assuming the
   mapping rule itself is wrong.
3. **Clean Lite stubs this entire module out** —
   `src/stubs/quantityTakeoff.stub.ts` (`computeFullTakeoff` returns empty)
   and `src/stubs/QuantitiesPanel.stub.tsx` (renders `null`). Don't assume
   quantities exist when working on that build profile.
4. **`customCalc.ts` graphs and the norm-mapping pipeline are two separate
   systems** that happen to share `NodeMeasures` as their common geometric
   vocabulary (`MEASURE_OPTIONS` in `customCalc.ts` mirrors the same keys
   `takeoffEngine.ts`'s `evalFormula` env exposes). A change to one doesn't
   automatically apply to the other — e.g. adding a new `NodeMeasures` key
   needs updating both `geometryMeasures.ts` AND `customCalc.ts`'s
   `MEASURE_OPTIONS` for it to be usable in a custom formula.
5. **Formula evaluation uses `new Function(...)`** (both
   `takeoffEngine.ts`'s `evalFormula` and `customCalc.ts`'s
   `evalFormulaSafe`) — errors are swallowed and return `0`, not thrown.
   Silent-zero is the debugging trap here, not an exception.

## Testing

`src/lib/quantityTakeoff/`: `takeoffEngine.test.ts`, `customCalc.test.ts`,
`calcAggregate.test.ts`, `calcReportExport.test.ts`, `calcTrace.test.ts`,
`costByCategory.test.ts`, `donutLayout.test.ts`, `editableFormula.test.ts`,
`priceRun.test.ts`.

`src/lib/norms/`: `catalogCompiled.fidelity.test.ts` (hardcoded-vs-compiled
parity), `mappingCoverage.test.ts`, `mappingOverrides.test.ts`,
`library/*.test.ts` (MD→JSON compile pipeline).

Solid coverage already exists — when extending this module, extend the
matching test file rather than adding a new one unless the change is a new
subsystem.

## Extending

- **New norm article**: add it to the editable Markdown library, recompile
  (`scripts/compile-norms-library.mjs`), and verify
  `catalogCompiled.fidelity.test.ts` (and `mappingCoverage.test.ts`) still
  pass.
- **New geometric measure**: add the key to `NodeMeasures`
  (`src/lib/norms/types.ts`) → compute it in `measureNode()`
  (`geometryMeasures.ts`) → add it to `takeoffEngine.ts`'s `evalFormula` env
  and `applyOutput` switch if norms should be able to reference it → add it
  to `customCalc.ts`'s `MEASURE_OPTIONS` if the custom-calc graph editor
  should expose it too.
- **New mapping rule (element → norms)**: goes in the catalog's `mapping`
  array (via the Markdown library, not hand-edited TS) — matched by
  `findMappingRules(nodeType, elementTypeId, material)` with fallback order:
  exact `elementTypeId` → wildcard `'*'` → material-filtered → unfiltered.
