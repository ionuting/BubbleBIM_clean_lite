# Plan: Modul „Raport de Calcul Cantități" (BubbleBIM)

Transformă antemăsurătoarea dintr-un tabel plat (F3 actual) într-un **raport de
calcul explicabil**: calcul vizual pe graf → memoriu de calcul stil CalcPad →
inset-uri 3D cu exact geometria folosită. Scop: transparență totală asupra
„de unde vine fiecare cifră".

## Decizii confirmate
- **Calc graph vizual:** livrare pe faze — **read-only auto întâi**, apoi editabil.
- **3D & export:** **snapshot PNG** per calcul + raport **HTML self-contained via Artifact**
  (partajabil), cu un singur viewer 3D interactiv la focus.

## Ce refolosim (nu rescriem)
- `takeoffEngine` (`src/lib/quantityTakeoff/takeoffEngine.ts`): `measureNode`,
  `computeTakeoff`, `aggregateF3`, `evalFormula`.
- `norms` (`src/lib/norms/`): catalog articole, reguli mapare, `NodeMeasures`,
  `F3Row`, `TakeoffLine`.
- `@xyflow/react` (deja în deps, nefolosit) → canvasul de calcul vizual.
- Grafuri relaționale (`BubbleGraphPanel`, `BubbleGraphPlanSVG`).
- Viewer 3D ușor (`IFCPreview3D` / OpenGeo) pentru inset-uri.
- `f3Export`, `F3Table`, `QuantitiesPanel` existente.

## Lipsă azi
Motorul dă doar **rezultatul** (`quantity`, `source`). Pentru CalcPad ne trebuie
**urma de calcul** (formulă simbolică → valori substituite → pași). Prima piesă e
îmbogățirea motorului cu *provenance*, fără a schimba cifrele.

---

## Faza 1 — Motor de calcul explicabil (calculation trace)
Extindem `takeoffEngine` să emită un `CalcTrace` pe lângă `quantity`:
```ts
interface CalcTrace {
  symbolic: string;     // "V = A_net × t"
  substituted: string;  // "V = 12.50 × 0.20"
  steps: CalcStep[];
  result: number; unit: NormUnit;
  inputs: { key: MeasureKey; value: number; unit: string; fromGeometry: string }[];
  nodeIds: string[];    // trasabilitate graf + 3D
  normId: string;       // trasabilitate articol
}
```
`evalFormulaTraced` întoarce valoarea + string-urile de substituție. Nu schimbă
rezultatele — doar le face vizibile. Testabil (`takeoffEngine.test.ts` existent).

## Faza 2 — Randare CalcPad (memoriu de calcul)
`CalcPadBlock.tsx`: formula simbolică (KaTeX inline, fără CDN — CSP Artifact), linia
substituită + rezultat evidențiat, „sursă geometrică" per input, badge articol de
normă + link „→ graf / 3D". Raport = secvență grupată pe capitol → etaj → articol.

## Faza 3 — Canvas de calcul vizual (React Flow) — read-only (Faza A)
`CalcGraphCanvas.tsx` pe `@xyflow/react`, derivat automat din graful relațional:
noduri-măsură → noduri-operație (formulă normă) → noduri-rezultat (cantitate/articol).
Muchiile arată fluxul; hover evidențiază provenance. Selecția ↔ highlight în graful
relațional și în insetul 3D (bus comun de `nodeIds`).
**Faza B (ulterioară):** mod editabil — formule custom, persistență, validare, undo.

## Faza 4 — Inset-uri 3D per calcul
`Calc3DInset.tsx` — wrapper peste viewer 3D ușor existent, randează **doar**
`trace.nodeIds`, evidențiate. La generarea raportului → **snapshot PNG**; click →
un singur viewer live „focus".

## Faza 5 — Compunere & export raport
`CalcReportComposer.tsx` asamblează: antet proiect → sumar F3 (refolosit) →
pe capitol/etaj: snapshot calc-graph + `CalcPadBlock`-uri + inset 3D → anexă graf.
Export: **Artifact HTML self-contained** (grafuri SVG inline, calcpad HTML/KaTeX,
3D = PNG); + `window.print()`/PDF (pattern din `SheetComposer`); + CSV via `f3Export`.

## Faza 6 — Integrare & UI
Tab `report` în `ViewTabBar`; buton „Generează raport" în `QuantitiesPanel`;
persistență config în `.bbim` (`projectFile.ts`).

---

## Arhitectură
```
graful relațional (nodes/edges)
        │  measureNode (existent)
        ▼
   NodeMeasures ──► evalFormulaTraced (NOU) ──► CalcTrace[]
        │                                          │
        ├──────────────┬───────────────┬───────────┤
        ▼              ▼               ▼           ▼
  CalcGraphCanvas  CalcPadBlock    Calc3DInset   F3Table
   (React Flow)    (memoriu)       (3D subset)  (existent)
        └──────────────┴──── CalcReportComposer ──┴──► Artifact HTML / PDF
```

## Riscuri
1. Trace-ul rămâne 1:1 cu motorul (explică, nu recalculează → cifre identice cu F3).
2. 3D în raport: snapshot PNG la generare, un singur viewer live la focus.
3. Editabilul calc-graph = salt de scope → fază separată (B).
4. KaTeX inline fără CDN (CSP Artifact) sau layout HTML propriu pentru formule.

## Ordine de livrare
Faza 1 (trace) → 2 (CalcPad) ca vertical slice pe un articol → 4 (inset 3D) → 3A
(calc-graph read-only) → 5 (export Artifact) → 6 (integrare) → 3B (editabil).
