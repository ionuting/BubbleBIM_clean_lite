# Plan: Configurator Armare 2D în BubbleBIM Standalone

Portare a aplicației **ConfiguratorArmare** (plugin Rhino / configurator de planșe de
armare 2D parametric, conform SR EN / Eurocod 2) în BubbleBIM Standalone, cu funcții
complete în canvasul 2D — indiferent de context: **top view, vederi sau secțiuni**.

## Decizii confirmate
- **Randare: SVG nativă.** Refolosim 100% logica de domeniu (`nucleu`); reimplementăm
  doar stratul vizual + interacțiune în SVG, consistent cu `SvgAnnotationLayer` existent.
  Un singur paradigm de canvas, integrare curată cu snap/zoom/pan-ul BubbleBIM.
- **Scope: local, fără backend.** Fără asistent LLM, auth sau versiuni cloud.

## Principiul director
`nucleu` este logică de domeniu pură (TS, mm, zero dependențe UI) care emite geometrie
ca **date**: `Segment` (linie/arc), `PunctControl` (grip cu axă). Îl importăm ca pachet și
**nu-l atingem**. Tot efortul nou = un strat SVG subțire care (1) desenează aceste date și
(2) traduce drag-ul de grip înapoi în parametri. Același strat funcționează identic în top
view / vederi / secțiuni, pentru că geometria e 2D pură indiferent de contextul view-ului.

---

## Faza 0 — Fundație (pachet domeniu + store)
1. Import `nucleu` (+`reguli`) ca `packages/armare-nucleu`, aliasat `@armare/nucleu`
   (același pattern ca `@ifc-lite/*` existente). Import-urile relative `.js` se strip-uiesc
   pentru rezolvare bundler Vite.
2. Slice `armare` în `src/store/index.ts`: `forme: FormaArmare[]`, `caleArrays`,
   `adnotatii`, `coteLibere`, `idsSelectate`, `unealtaActiva` + acțiuni. Portare ~1:1 din
   `stare/magazin.ts` al sursei.
3. Context per view: armarea e legată de `viewId`-ul tab-ului activ (câmp existent în store).

## Faza 1 — Stratul de randare SVG (`RebarLayer`)
Componentă `src/components/views/armare/RebarLayer.tsx`, montată ca `<g>` în `<svg>`-ul
fiecărui viewer.
- Geometrie: `segmenteForma(forma)` → `segmentToPath` (`linie`→`L`, `arc`→`A`);
  `cercForma` → `<circle>` (bare în secțiune).
- Transform: `matrix(mm→px)` per formă din `pozitie/rotatie/oglindit`.
- Adaptor unic `mmToWorld()` aliniază mm-ul `nucleu` cu sistemul de coordonate al gazdei.
- Cote/etichete: `coteGabarit` → refolosim `SvgAnnotationLayer`.

## Faza 2 — Interacțiune (grips / „dynamic blocks")
- `puncteControlForma` → `<circle class="grip">`; drag proiectat pe `axa` → `updateParametru`.
- Selecție, mutare (`mutaForma`), rubber-band, snap (`snap/snap.ts` + snap-ul gazdei).
- Ortho / rotație / oglindire / ciocuri (`ciocuri.ts`) + toolbar contextual la selecție.

## Faza 3 — Paletă, proprietăți, catalog
- Paletă forme din `CATALOG_FORME` / `LISTA_FORME` / `LISTA_FORME_COFRAJ`.
- Panou proprietăți **modular** (accordion) generat din `DefinitieParametru[]`.
- Array pe path: `array-path/arrayPath.ts` + `pozitiiArray`.

## Faza 4 — Extras, ancoraj, export
- Extras armare: `extrasArmare(forme, caleArrays)` → tabel (`optimizareStoc.ts` la croire).
- Ancoraj Eurocod 2: `ancoraj/ancoraj.ts` + `reguli` → validare.
- Export DXF: `exportaDxf` + `importDxf` (substrat). Layout/cartuș → `SheetComposer`.

## Faza 5 — Persistență în proiect BubbleBIM
Serializăm slice-ul `armare` în `.bbim` (`projectFile.ts`), reutilizând `proiect/proiect.ts`
pentru versionarea structurii de forme.

---

## Refolosit „gratis" din `nucleu` (fără rescriere, ~9k linii testate)
`segmenteForma` · `puncteControlForma` · `cercForma` · `coteGabarit` · `extrasArmare` ·
`CATALOG_FORME` · `razaForma`/`indoire` · `ciocuri` · `ancoraj` · `arrayPath` ·
`exportDxf`/`importDxf` · `optimizareStoc` · `layout` · `cartus` · `proiect`.

## Scris nou (stratul SVG, mult mai mic decât cele 31k linii Konva ale sursei)
`RebarLayer.tsx` · `RebarGrips` · slice `armare` · adaptor `mmToWorld` · paletă +
panou proprietăți modular · montare `<RebarLayer/>` în cele 3 viewere.

## Riscuri
1. Reconcilierea coordonatelor (mm ↔ metri IFC ↔ scara secțiunilor) — izolat în `mmToWorld`.
2. Panoul de proprietăți al sursei (3900 linii) — reconstruit modular, nu portat 1:1.
3. Undo/redo pe slice-ul de armare fără conflict cu istoricul global.
4. Proiecție screen→world pentru drag grip (helper reutilizabil).

## Ordine de livrare
Faza 0 → 1 → 2 pe **top view** ca vertical slice funcțional → extindere la secțiuni/vederi
(deja view-agnostic) → Fazele 3–5.
