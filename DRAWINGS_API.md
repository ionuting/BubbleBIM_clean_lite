# Technical Drawings API — ThatOpen engine_components v3.4

> Capabilitati noi adaugate in ramura `main` (post-v3.3). Sursa: [engine_components](https://github.com/ThatOpen/engine_components)

---

## Arhitectura generala

Sistemul de desene tehnice este impartit in doua pachete:

| Pachet | Continut |
|--------|----------|
| `@thatopen/components` (core) | `TechnicalDrawings`, sisteme de adnotari, `DxfManager`, `EdgeProjector` |
| `@thatopen/components-front` (front) | `DrawingEditor`, instrumente interactive, `SheetBoard`, `PaperSpace` |

Un **desen tehnic** este un `THREE.Group` ancorat in spatiul 3D. Liniile de proiectie (muchii ale modelului BIM aplatizate pe planul de desen) sunt adaugate prin desen — nu direct in scena — pentru a activa raycasting accelerat BVH, care permite snap pe segmente individuale chiar si pe geometrii dense.

---

## 1. `TechnicalDrawings` (core)

Manager singleton ce creaza si gestioneaza toate desenele dintr-o aplicatie.

```typescript
import * as OBC from "@thatopen/components";

const techDrawings = components.get(OBC.TechnicalDrawings);

// Creeaza un desen nou si il leaga de lume
const drawing = techDrawings.create(world);

// Orienteaza desenul ca un plan de etaj (proiectie de sus in jos)
drawing.orientTo(new THREE.Vector3(0, -1, 0));

// Pozitioneaza planul de taiere la 1.2 m deasupra pardoselii
drawing.three.position.set(0, 1.2, 0);

// Adancimea de captura (4 m sub planul de taiere)
drawing.far = 4;
```

### Layere

Fiecare layer are un material independent si un flag de vizibilitate.

```typescript
drawing.layers.create("Visible", {
  material: new THREE.LineBasicMaterial({ color: 0x000000 }),
});
drawing.layers.create("Hidden", {
  material: new THREE.LineDashedMaterial({ color: 0x888888, dashSize: 0.2, gapSize: 0.1 }),
  visible: false,
});
drawing.layers.create("Annotations", {
  material: new THREE.LineBasicMaterial({ color: 0x000000 }),
});

drawing.activeLayer = "Annotations"; // layerul activ pentru adnotari noi
drawing.layers.setVisibility("Hidden", true); // toggle vizibilitate
```

### Adaugare linii de proiectie (manual)

```typescript
const projData = await fetch("projection.json").then((r) => r.json());
const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(projData.positions), 3));

drawing.layers.create("projection", { material: new THREE.LineBasicMaterial({ color: 0xff0000 }) });
const projLines = new THREE.LineSegments(geo);
drawing.addProjectionLines(projLines, "projection");
```

### Adaugare proiectie din model BIM (recomandat)

```typescript
const ids = await model.getItemsIdsWithGeometry();
const modelIdMap: OBC.ModelIdMap = { [model.modelId]: new Set(ids) };

await drawing.addProjectionFromItems(modelIdMap, {
  layers: { visible: "Visible", hidden: "Hidden" },
});
```

### Raycasting (snap pe segmente)

```typescript
const raycaster = new THREE.Raycaster();
raycaster.setFromCamera(ndc, world.camera.three);

const hit = drawing.raycast(raycaster.ray);
// hit.line => { start: THREE.Vector3, end: THREE.Vector3 }
```

### Viewport

```typescript
const viewport = drawing.viewports.create({
  left: -25, right: 25, top: 15, bottom: -15,
  scale: 100,
  name: "Floor Plan",
});
```

---

## 2. Sisteme de adnotari (core)

Sistemele de adnotari sunt inregistrate o singura data pe `TechnicalDrawings` si functioneaza pe toate desenele. Randarea textului este **responsabilitatea consumatorului** in core (fara dependinte DOM/font).

### `LinearAnnotations`

```typescript
const dims = techDrawings.use(OBC.LinearAnnotations);

// Stiluri
dims.styles.set("default", {
  color: 0x333333,
  fontSize: 0.3,
  textOffset: 0.4,
  tickSize: 0.25,
  extensionGap: 0.05,
  extensionOvershoot: 0.2,
  unit: OBC.Units.m,
  lineTick: OBC.DiagonalTick,    // sau ArrowTick, DotTick, NoTick
  meshTick: OBC.FilledCircleTick, // sau FilledArrowTick, FilledSquareTick, undefined
});

// Eveniment la confirmare (text rendering pe seama consumatorului)
dims.onCommit.add((committed) => {
  for (const { item: dim, group } of committed) {
    const dist = dim.pointA.distanceTo(dim.pointB).toFixed(2);
    // Genereaza mesh text si adauga la group...
  }
});

dims.onDelete.add(() => { /* curata */ });
```

### Masina de stari (interactie)

```typescript
// Stari posibile: "awaitingFirstPoint" | "positioningOffset"
console.log(dims.machineState.kind);

// Trimite evenimente
dims.sendMachineEvent({ type: "SELECT_LINE", line: hit.line, drawing });
dims.sendMachineEvent({ type: "MOUSE_MOVE", point: drawingSpacePoint });
dims.sendMachineEvent({ type: "CLICK", point: drawingSpacePoint, drawing });
dims.sendMachineEvent({ type: "ESCAPE" });

// Sterge toate adnotarile de pe un desen
dims.clear([drawing]);
```

### Alte sisteme disponibile

| Clasa | Descriere |
|-------|-----------|
| `OBC.LinearAnnotations` | Dimensiuni liniare |
| `OBC.AngleAnnotations` | Dimensiuni unghiuri |
| `OBC.CalloutAnnotations` | Callout-uri cu text si contur |
| `OBC.LeaderAnnotations` | Leader lines |
| `OBC.BlockAnnotations` | Blocuri reutilizabile |
| `OBC.SlopeAnnotations` | Pantă / inclinatie |

### Tick builders disponibili

```typescript
// Line ticks (geometry simpla)
OBC.DiagonalTick
OBC.ArrowTick
OBC.OpenArrowTick
OBC.DotTick
OBC.NoTick

// Mesh ticks (geometrie solida)
OBC.FilledArrowTick
OBC.FilledCircleTick
OBC.FilledSquareTick

// Enclosures (pentru callout)
OBC.CloudEnclosure
OBC.RectEnclosure
OBC.CircleEnclosure
```

---

## 3. Export DXF (core)

```typescript
const dxfExporter = components.get(OBC.DxfManager).exporter;

// Export simplu (un singur desen, un singur viewport)
const dxfString = dxfExporter.export([{ drawing, viewports: [{}] }]);

const blob = new Blob([dxfString], { type: "application/dxf" });
const a = document.createElement("a");
a.href = URL.createObjectURL(blob);
a.download = "technical-drawing.dxf";
a.click();
URL.revokeObjectURL(a.href);
```

---

## 4. `DrawingEditor` (front)

Absoarbe intreaga infrastructura de interactie (coordonate, hover highlight, state machine). Inregistrezi o lume, alegi un instrument, faci click — snap, hover feedback si conversia coordonatelor sunt gestionate automat.

```typescript
import * as OBF from "@thatopen/components-front";

const editor = components.get(OBF.DrawingEditor);

// Incarca font pentru randarea etichetelor
await editor.fonts.load("https://example.com/fonts/MyFont.ttf");

// Inregistreaza sursa de input (lumea 3D)
editor.setSource(world);

// Seteaza desenul activ
editor.activeDrawing = drawing;

// Eveniment la schimbarea starii
editor.onStateChanged.add((key) => {
  if (key.includes("activeDrawing")) updatePanel();
});
```

### Instrumente disponibile

```typescript
const dimTool     = editor.use(OBF.LinearAnnotationsTool);
const angleTool   = editor.use(OBF.AngleAnnotationsTool);
const calloutTool = editor.use(OBF.CalloutAnnotationsTool);
const leaderTool  = editor.use(OBF.LeaderAnnotationsTool);
const blockTool   = editor.use(OBF.BlockAnnotationsTool);
const slopeTool   = editor.use(OBF.SlopeAnnotationsTool);
```

### Activare instrument

```typescript
editor.activeTool = OBF.LinearAnnotationsTool;  // activeaza
editor.activeTool = null;                        // dezactiveaza
```

### Avansare stare si anulare

```typescript
// Un singur apel dispatchez pozitia cursorului la instrumentul activ
editor.step();

// Anuleaza plasarea curenta
editor.cancel();

// Sterge selectia curenta
editor.delete();
```

### Callout — text interactiv

```typescript
calloutTool.onEnterText.add(({ isEdit, currentText }) => {
  const text = prompt(isEdit ? "Editeaza:" : "Text:", currentText) ?? currentText;
  calloutTool.submitText(text);
});
```

### Stiluri pe instrumente

```typescript
dimTool.system.styles.set("default", {
  color: 0xe13333,
  fontSize: 0.3,
  textOffset: 0.4,
  tickSize: 0.25,
  extensionGap: 0.05,
  extensionOvershoot: 0.2,
  unit: OBC.Units.m,
  lineTick: OBC.NoTick,
  meshTick: OBC.FilledCircleTick,
});

calloutTool.system.styles.set("default", {
  color: 0xe13333,
  fontSize: 0.3,
  textOffset: 0.1,
  tickSize: 0.25,
  enclosure: OBC.CloudEnclosure,
  meshTick: OBC.FilledArrowTick,
});
```

---

## 5. `SheetBoard` si `PaperSpace` (front)

Randare in paper space — proiectie la scara fixa, gata de printare.

### HTML

```html
<div id="layout">
  <div id="container"></div>  <!-- viewport 3D -->
  <bim-sheet-board id="board">
    <bim-paper-space id="paper" size="A1" orientation="landscape" label="Plan Etaj 1">
    </bim-paper-space>
  </bim-sheet-board>
</div>
```

### Setup

```typescript
const board = document.getElementById("board") as CUI.SheetBoard;
board.components = components;

const paper = document.getElementById("paper") as BUI.PaperSpace;
paper.sheetNumber = "A-01";
paper.titleBlockTemplate = (mm, drawingArea) => BUI.html`
  <div style="width:100%;height:100%;border:${mm(0.7)} solid #222;">
    ${drawingArea}
  </div>
`;

// Adauga viewport pe sheet
board.addViewport(paper, drawing.uuid, viewport.uuid, { x: 30, y: 20 });

// Re-randeaza board-ul la fiecare modificare
editor.onDrawingMouseMove.add(() => board.requestRender());
dimTool.system.onCommit.add(() => board.requestRender());
dimTool.system.onDelete.add(() => board.requestRender());
```

### Mod editare paper space

Dublu-click pe un viewport din SheetBoard trece in modul paper space — input-ul se converteaza prin camera ortografica a viewport-ului.

```typescript
board.addEventListener("viewportactivate", (e) => {
  const { drawingId, viewportId } = (e as CustomEvent).detail;
  const td = components.get(OBC.TechnicalDrawings);
  const d = td.list.get(drawingId);
  const vp = d?.viewports.get(viewportId);
  if (!d || !vp) return;

  editor.activeDrawing = d;
  const vpEl = board.getViewportElement(drawingId, viewportId);
  if (vpEl) editor.setSource(vpEl, vp);
  board.enterEditMode(drawingId, viewportId);
});

// Iesire din paper space (Escape)
editor.cancel();
editor.clearSource(vpEl);
editor.setSource(world);   // revine la lumea 3D
board.exitEditMode();
```

### Export DXF din SheetBoard

```typescript
// Export un singur viewport
board.addEventListener("viewportdxfexport", (e) => {
  const { drawingId, viewportId, dxf } = (e as CustomEvent).detail;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([dxf], { type: "application/dxf" }));
  a.download = `${viewportId}.dxf`;
  a.click();
});

// Export intreaga coala
board.addEventListener("paperdxfexport", (e) => {
  const { paper, dxf } = (e as CustomEvent).detail;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([dxf], { type: "application/dxf" }));
  a.download = `${paper.getAttribute("label") || "drawing"}.dxf`;
  a.click();
});
```

---

## 6. `EdgeProjector` (front)

Proiecteaza muchiile 3D ale modelului pe planul de desen fara a necesita JSON pre-computat. Integrat direct in `drawing.addProjectionFromItems()`.

```typescript
// Folosit intern de addProjectionFromItems — nu necesita initializare separata
const ids = await model.getItemsIdsWithGeometry();
const modelIdMap: OBC.ModelIdMap = { [model.modelId]: new Set(ids) };

await drawing.addProjectionFromItems(modelIdMap, {
  layers: { visible: "Visible", hidden: "Hidden" },
});
```

---

## 7. Sub-exemple `TechnicalDrawings`

| Exemplu | Ce demonstreaza |
|---------|-----------------|
| **AnnotationStyles** | Configurare stiluri (culori, tick-uri, fonturi) per sistem |
| **AnnotationSystems** | Inregistrarea mai multor sisteme pe acelasi desen |
| **CustomAnnotationSystems** | Construire sistem de adnotari personalizat |
| **DrawingBlocks** | Blocuri reutilizabile (simboluri, stampile) |
| **DrawingLayers** | Gestionare layere: creare, vizibilitate, material per layer |
| **ModelDrivenAnnotations** | Adnotari generate automat din datele IFC ale modelului |
| **MultiDrawingViewports** | Mai multe viewport-uri pe acelasi desen |

---

## 8. Pattern complet (rezumat)

```typescript
// 1. Setup lume 3D
const components = new OBC.Components();
const world = components.get(OBC.Worlds).create<...>();
// ... setup scene, camera, renderer

// 2. Incarca model
const fragments = components.get(OBC.FragmentsManager);
const model = await fragments.core.load(buffer, { modelId: "my-model" });

// 3. Creeaza desenul
const techDrawings = components.get(OBC.TechnicalDrawings);
const drawing = techDrawings.create(world);
drawing.orientTo(new THREE.Vector3(0, -1, 0));
drawing.three.position.set(0, 1.2, 0);
drawing.far = 4;

// 4. Adauga layere
drawing.layers.create("Visible", { material: new THREE.LineBasicMaterial({ color: 0x000000 }) });
drawing.layers.create("Hidden",  { material: new THREE.LineDashedMaterial({ color: 0x888888 }), visible: false });
drawing.layers.create("Annotations", { material: new THREE.LineBasicMaterial({ color: 0x0000ff }) });
drawing.activeLayer = "Annotations";

// 5. Proiecteaza muchii din model
const ids = await model.getItemsIdsWithGeometry();
await drawing.addProjectionFromItems(
  { [model.modelId]: new Set(ids) },
  { layers: { visible: "Visible", hidden: "Hidden" } }
);

// 6. DrawingEditor (front)
const editor = components.get(OBF.DrawingEditor);
await editor.fonts.load("https://.../PlusJakartaSans-Medium.ttf");
editor.setSource(world);
editor.activeDrawing = drawing;

const dimTool = editor.use(OBF.LinearAnnotationsTool);
editor.activeTool = OBF.LinearAnnotationsTool;

// Click pe canvas => avansare stare
canvas.addEventListener("click", () => { editor.step(); board.requestRender(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") editor.cancel();
  if (e.key === "Delete") editor.delete();
});

// 7. Export DXF
const dxf = components.get(OBC.DxfManager).exporter.export([{ drawing, viewports: [{}] }]);
```

---

## Note importante

- **Text rendering in core** este responsabilitatea consumatorului — `onCommit` ofera datele, tu generezi mesh-urile Three.js. `DrawingEditor` (front) face asta automat cu font manager integrat.
- **Layer "0"** este rezervat intern; nu crea layere cu acest nume.
- `drawing.raycast()` returneaza segmentul cel mai apropiat din drawing-space — foloseste-l pentru hover highlight si snap.
- Adnotarile stocheaza doar **numele stilului**, nu stilul complet — modificarea unui stil actualizeaza automat toate adnotarile care il referencieaza.
- `SheetBoard` are propriul WebGL renderer — nu imparte contextul cu lumea 3D principala.
