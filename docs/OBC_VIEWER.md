# That Open Components (OBC) Viewer — Ghid de utilizare

Viewerul **WebIfcViewer** din BubbleGraph folosește stack-ul oficial
[That Open Engine](https://github.com/ThatOpen/engine_components) (OBC v3) identic
cu template-ul vanilla al proiectului — `OrthoPerspectiveCamera` + `PostproductionRenderer` +
`FragmentsManager` + `IfcLoader`.

---

## Arhitectura stack-ului OBC

```
@thatopen/components          ← core: scene, camera, grids, raycasters, FragmentsManager, IfcLoader
@thatopen/components-front    ← renderer: PostproductionRenderer (SSAO, edge passes, LOD)
@thatopen/fragments           ← web worker pentru geometrie tile / flat-buffer
web-ifc                       ← WASM parser de fișiere IFC
```

Diagrama completă la runtime:

```
OBC.Components
  └── Worlds
        └── world (Main)
              ├── scene:    OBC.SimpleScene       → THREE.Scene intern
              ├── camera:   OBC.OrthoPerspectiveCamera → orbit + zoom + pan
              └── renderer: OBF.PostproductionRenderer → SSAO + edge glow

  └── Grids          ← grila de podea
  └── Raycasters     ← selecție obiecte cu mouse
  └── FragmentsManager ← manager fragmente flat-buffer (tile streaming)
  └── IfcLoader       ← parsare fișier .ifc → FragmentsModel
```

---

## 1. Geometria proprie (BIM graph din baza de date)

Geometria generată din nodurile BubbleGraph (coloane, pereți, grinzi, plăci etc.)
este adăugată direct pe `world.scene.three` ca `THREE.InstancedMesh` și `THREE.Mesh`.

Aceste obiecte sunt grupate în ierarhia IFC:

```
THREE.Group "__bg_scene_root__"
  └─ Group "IfcProject"
       └─ Group "IfcBuilding"
            ├─ Group "IfcBuildingStorey_Parter"
            │    ├─ InstancedMesh  (coloane C25x25, toate instanțele unui tip)
            │    ├─ Mesh           (perete)
            │    └─ Mesh           (grindă)
            └─ Group "IfcBuildingStorey_Etaj1"
                 └─ ...
```

Camera se auto-poziționează cu `fitToBox()` după fiecare rebuild al geometriei.

---

## 2. Încărcare fișiere IFC (Flat-Buffer Fragments)

### Prin UI
1. Deschide tab-ul **3D Model** din BubbleGraph.
2. Selectează viewerul **That Open (OBC)** din butoanele de sus.
3. Click pe butonul **Load IFC** (dreapta-sus în viewer).
4. Selectează un fișier `.ifc` din calculator.

Alternativ: **drag-and-drop** direct pe suprafața viewerului.

### Ce se întâmplă la încărcare
```
.ifc (Uint8Array)
  → IfcLoader.load(data, coordinate=true, name)
      → web-ifc WASM parsează geometria IFC
      → FragmentsManager primește FragmentsModel
          → fragments.list.onItemSet se declanșează
              → model.useCamera(cam)
              → world.scene.three.add(model.object)   ← apare în viewer
              → fragments.core.update(true)
```

Modelul IFC este redat prin sistemul de **flat-buffer fragments** al ThatOpen:
geometriile similare sunt grupate, memorate ca `InstancedMesh` serializable și
redate cu WebGL instancing pentru performanță.

### Format nativ — `.frag` (Flat-Buffer Fragment)
OBC poate citi direct fișiere `.frag` pre-convertite (mult mai rapide decât `.ifc`):

```typescript
// Convertire .ifc → .frag (offline, o singură dată):
const fragments = components.get(OBC.FragmentsManager);
const buffer = await file.arrayBuffer();
const model  = await ifcLoader.load(new Uint8Array(buffer), true, 'myModel');
const fragData = await fragments.core.export(model);  // Uint8Array

// Salvare ca .frag:
const blob = new Blob([fragData]);
const url  = URL.createObjectURL(blob);
const a    = document.createElement('a');
a.href = url; a.download = 'model.frag'; a.click();
```

Reîncărcare `.frag` direct (fără WASM):
```typescript
const buffer = await file.arrayBuffer();
await fragments.core.load(new Uint8Array(buffer));
// → declanșează onItemSet → apare în viewer
```

---

## 3. Streaming tiles (geometrie mare, paginată)

ThatOpen suportă streaming de modele mari prin `FragmentsModels` din `@thatopen/fragments`.
Geometria este împărțită în **tiles** (sectoare spațiale) și încărcate la cerere în funcție
de frustum-ul camerei.

Pentru a activa streaming:
1. Pre-procesează modelul IFC cu utilitarul oficial:
   ```bash
   npx @thatopen/clay ifc-to-tiles input.ifc ./output-tiles/
   ```
2. Servește folderul `./output-tiles/` pe un server HTTP (sau în `public/tiles/`).
3. Încarcă în viewer:
   ```typescript
   const fragments = components.get(OBC.FragmentsManager);
   await fragments.core.loadTiles('/tiles/myModel/');
   ```

> **Notă**: streaming tiles necesită că modelul să fie pre-procesat offline.
> Pentru modele mici (\< 50 MB), încărcarea directă `.ifc` sau `.frag` este suficientă.

---

## 4. Producție — copiere worker

În build-ul de producție (`pnpm build`), worker-ul FragmentsManager nu este inclus automat în
bundle. Trebuie copiat manual în folderul `public/` **înainte** de build:

```powershell
# Rulează o dată înainte de pnpm build:
$src = "node_modules\@thatopen\fragments\dist\Worker\worker.mjs"
$dst = "public\fragments\worker.mjs"
New-Item -ItemType Directory -Force -Path "public\fragments" | Out-Null
Copy-Item $src $dst
```

Apoi schimbă constanta din `WebIfcViewer.tsx`:
```typescript
// linia FRAGMENTS_WORKER_URL:
const FRAGMENTS_WORKER_URL = './fragments/worker.mjs';  // production
// sau dinamic:
const FRAGMENTS_WORKER_URL = import.meta.env.DEV
  ? '/node_modules/@thatopen/fragments/dist/Worker/worker.mjs'
  : './fragments/worker.mjs';
```

---

## 5. Comenzi cameră (OrthoPerspectiveCamera)

| Acțiune              | Interacțiune mouse / tastatură |
|----------------------|--------------------------------|
| Orbită               | Click stânga + drag            |
| Pan                  | Click dreapta + drag (sau middle + drag) |
| Zoom                 | Scroll                         |
| Comutare perspectivă / ortografică | `P` (dacă binding-ul e activ) |
| Fit to selection     | `F`                            |

---

## 6. Dependențe necesare (package.json)

```json
{
  "@thatopen/components": "^3.3.3",
  "@thatopen/components-front": "^3.3.3",
  "@thatopen/fragments": "^3.3.7",
  "web-ifc": "^0.0.77",
  "three": "^0.176.0"
}
```

toate instalate deja în proiect.
