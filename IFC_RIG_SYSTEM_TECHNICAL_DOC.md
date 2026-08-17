# IFC Rig Zone Modifier — Documentație Tehnică Exhaustivă

> Versiune: Mai 2026  
> Scop: Reproducere exactă a sistemului de rig într-o altă aplicație

---

## 1. Viziune

Sistemul de rig permite deformarea în timp real a geometriei BREP a unui model IFC prin axe de grilă deplasabile. Fiecare axă definește o **zonă de strip** (prismă verticală) în spațiul world BREP. Vertexurile BREP din strip sunt deplasate solidar cu axa.

```
IFC file → OBC IfcLoader → FragmentsModel
  → IFCRigZoneModifier (cache BREP + zone strips)
  → Drag axă → _applyDelta() → FRAGS.editor.edit() → fragsModels.update(true)
  → Geometrie deformată live în Three.js scene
```

---

## 2. Stack tehnic

| Bibliotecă | Versiune | Rol |
|---|---|---|
| `@thatopen/fragments` | 3.4.5 | Stocare/editare BREP |
| `@thatopen/components` | OBC v3.x | IFC loader, camera, worlds |
| `@thatopen/components-front` | OBC-Front v3.x | PostproductionRenderer |
| `three` | 0.182.0 | Scene graph, gizmo geometry |
| React 18 + TypeScript 5 | — | UI, state (Zustand) |

---

## 3. Fișiere relevante

```
src/
  lib/
    IFCRigZoneModifier.ts   ← clasa principală
    ifcBrepHelpers.ts        ← toWorld, fromWorld, polygon helpers
    rigDeformer.ts           ← generare RigAxis[] din liste de axe
    ifcStepParser.ts         ← parser IFC STEP (storeys + grid detection)
  components/views/
    IFCOrthoPlanView.tsx     ← OBC renderer ortografic + HTML overlay axe
    IFCPlanView.tsx          ← container: toolbar, storey selector, lifecycle
    IFC3DFloatingPanel.tsx   ← panou 3D flotant (shared scene)
```

---

## 4. Modelul de date `@thatopen/fragments`

### 4.1 Entitățile

```
FragmentsModel
  ├── Items       — entități IFC (pereți, plăci, coloane...)
  ├── Samples     — instanțe geometrice concrete
  │     ├── item           → ID entity parent
  │     ├── material       → ID material
  │     ├── representation → ID geometrie BREP
  │     └── localTransform → ID transformare locală
  ├── Representations — geometrie BREP brută
  │     └── geometry: RawShell { points[][], profiles[], holes[] }
  ├── GlobalTransforms  — per item
  └── LocalTransforms   — per sample
```

**Instanțiere:** Un `representation` poate fi referit de N samples (ex: 120 ferestre identice partajează același repId).

### 4.2 API citire

```typescript
const allSamples = await model.getSamples();
// → Map<sampleId: number, { item, material, representation, localTransform }>

const allGT = await model.getGlobalTransforms();
// → Map<itemId: number, RawGlobalTransformData>
// RawGlobalTransformData = { position: number[], xDirection: number[], yDirection: number[] }

const allLT = await model.getLocalTransforms();
// → Map<localTransformId: number, RawTransformData>
// RawTransformData = { position: number[], xDirection: number[], yDirection: number[] }

const repIds = new Set([...allSamples.values()].map(s => s.representation));
const allReps = await model.getRepresentations(repIds);
// → Map<repId: number, RawRepresentation>
// RawRepresentation = { bbox: number[], representationClass: string, geometry: RawShell }
// RawShell = { points: number[][], profiles, bigProfiles, holes, bigHoles, profilesFaceIds, type }
```

### 4.3 API editare

```typescript
// fragsModels: FRAGS.FragmentsModels (din components.get(OBC.FragmentsManager).core)
const editedIds: number[] = await fragsModels.editor.edit(
  model.modelId,   // string
  requests,        // FRAGS.EditRequest[]
);

// Tipuri de EditRequest:
// CREATE_REPRESENTATION  { type, tempId: string, data: RawRepresentation }
//   → returnează ID numeric real în editedIds[], în ordinea creărilor
// UPDATE_REPRESENTATION  { type, localId: number, data: RawRepresentation }
// UPDATE_SAMPLE          { type, localId: sampleId, data: { item, material, representation, localTransform } }
//   → representation poate fi tempId (string) din același batch sau ID numeric

await fragsModels.update(true);      // reconstruiește Three.js InstancedMeshes
await fragments.core.update();        // flush tile streaming LOD
```

**Mapare tempId → ID real:**

`editedIds[i]` corespunde celui de-al `i`-lea `CREATE_REPRESENTATION` din vectorul `requests`. Trebuie indexat manual:

```typescript
const createIndices: { rep: AffectedRep }[] = [];
// (adaugi în ordine un entry pentru fiecare CREATE din requests[])
const editedIds = await fragsModels.editor.edit(modelId, requests);
for (let i = 0; i < createIndices.length; i++) {
  createIndices[i].rep.clonedRepId = editedIds[i];
}
```

---

## 5. Sistemul de coordonate

### 5.1 Spațiul BREP world

Fragmentele stochează geometria în **metri**, Three.js Y-up.

```
vertex local → [LocalTransform] → [GlobalTransform] → world XYZ (m)
```

`RawTransformData`: `{ position: [x,y,z], xDirection: [x,y,z], yDirection: [x,y,z] }`  
Z implicit = `cross(xDirection, yDirection)`

### 5.2 Funcții transformare (`ifcBrepHelpers.ts`)

```typescript
function cross3d(a: number[], b: number[]): number[] {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}

function applyTransform(pt: number[], t: RawTransformData): number[] {
  const z = cross3d(t.xDirection, t.yDirection);
  return [
    t.position[0] + pt[0]*t.xDirection[0] + pt[1]*t.yDirection[0] + pt[2]*z[0],
    t.position[1] + pt[0]*t.xDirection[1] + pt[1]*t.yDirection[1] + pt[2]*z[1],
    t.position[2] + pt[0]*t.xDirection[2] + pt[1]*t.yDirection[2] + pt[2]*z[2],
  ];
}

function inverseTransform(worldPt: number[], t: RawTransformData): number[] {
  const z = cross3d(t.xDirection, t.yDirection);
  const rel = [worldPt[0]-t.position[0], worldPt[1]-t.position[1], worldPt[2]-t.position[2]];
  return [
    rel[0]*t.xDirection[0] + rel[1]*t.xDirection[1] + rel[2]*t.xDirection[2],
    rel[0]*t.yDirection[0] + rel[1]*t.yDirection[1] + rel[2]*t.yDirection[2],
    rel[0]*z[0] + rel[1]*z[1] + rel[2]*z[2],
  ];
}

// Local BREP → world (aplică LT → GT)
function toWorld(pt, localT?, globalT?): number[]

// World → local BREP (aplică GT⁻¹ → LT⁻¹)
function fromWorld(worldPt, localT?, globalT?): number[]

// Ray-casting 2D în planul XZ
function pointInPolygonXZ(x: number, z: number, polygon: [number,number][]): boolean

// Strip dreptunghiular pentru o axă rig
function makeAxisStripPolygon(
  dir: 'X' | 'Y',
  posM: number,        // poziție axă în BREP world metres
  halfWidthM: number,  // jumătate din lățimea stripului
  spanMin: number,     // -200 pentru full building
  spanMax: number,     // +200
): [number,number][]
// dir='X': [[posM-hw, spanMin], [posM+hw, spanMin], [posM+hw, spanMax], [posM-hw, spanMax]]
// dir='Y': [[spanMin, posM-hw], [spanMax, posM-hw], [spanMax, posM+hw], [spanMin, posM+hw]]
```

### 5.3 Mapare coordonate parser IFC → BREP world

Parserul IFC STEP citește axele în mm, nordul IFC = +Y parser. Spațiul BREP: Three.js Y-up, nord IFC → +Z.

**Calibrare prin bounding box:**

```
parser X (est, mm)  → BREP X (m): liniar, același sens
parser Y (nord, mm) → BREP Z (m): liniar + FLIPAT (parserY_max → brepZ_min)
```

```typescript
// Conversie parser → BREP (în IFCRigZoneModifier):
const { brepAxesXMm, brepAxesYMm } = await zm.convertParserAxesToBrep(
  [minX_mm, minY_mm, maxX_mm, maxY_mm],  // worldBounds din parser
  axesX_mm,
  axesY_mm,
);

// Invers BREP → parser (pentru "Apply to BubbleGraph"):
const { parserAxesXMm, parserAxesYMm } = await zm.convertBrepAxesToParser(
  parserBounds, brepAxesXMm, brepAxesYMm
);
```

Formulele de transformare:

```typescript
// parser X (mm) → BREP X (mm):
brepX_mm = (bMinX + ((parserX_mm*0.001 - pMinX) / pSpanX) * bSpanX) * 1000;

// parser Y (mm) → BREP Z (mm), FLIPAT:
brepZ_mm = (bMaxZ - ((parserY_mm*0.001 - pMinY) / pSpanY) * bSpanZ) * 1000;
```

---

## 6. Clasa `IFCRigZoneModifier`

Fișier: `src/lib/IFCRigZoneModifier.ts`

### 6.1 Structuri interne

```typescript
type Pt3 = [number, number, number];

interface SampleRecord {
  sampleId:       number;
  item:           number;
  material:       number;
  representation: number;  // ID repr ORIGINALĂ — niciodată schimbat
  localTransform: number;
}

interface AffectedRep {
  repId:         number;
  baseline:      (Pt3 | null)[];  // snapshot la addAxis() — NICIODATĂ mutat
  current:       (Pt3 | null)[];  // mutat la fiecare deplasare
  primarySample: SampleRecord;
  clonedRepId:   number | null;   // ID clone după primul CREATE (null = necreat)
}

interface ZoneState {
  axisId:       string;
  dir:          'X' | 'Y';
  polygon:      [number, number][];        // strip XZ, world metres
  baseY:        number;                    // model.box.min.y
  height:       number;                    // model.box.max.y - min.y + 4
  dx:           number;                    // deplasare cumulată X (m)
  dz:           number;                    // deplasare cumulată Z (m)
  ownedIndices: Map<number, Set<number>>;  // sampleId → Set<ptIdx>
  affectedReps: AffectedRep[];
}

interface ModelCache {
  allGT:      Map<number, RawGlobalTransformData>;
  allLT:      Map<number, RawTransformData>;
  repSamples: Map<number, SampleRecord[]>;  // repId → toate samples care o folosesc
  allReps:    Map<number, RawRepresentation>;
}
```

**`_repBySample: Map<sampleId, AffectedRep>`** — garantează un singur `AffectedRep` per sample, chiar dacă sample-ul apare în mai multe zone. `current[]` și `clonedRepId` sunt shared între toate zonele care afectează acel sample.

### 6.2 Constructor și API public

```typescript
const zm = new IFCRigZoneModifier(
  model,        // FRAGS.FragmentsModel — returnat de IfcLoader.load()
  fragsModels,  // FRAGS.FragmentsModels — din fragments.core
  components,   // OBC.Components (opțional, pentru tile flush)
);
zm.setScene(scene);   // THREE.Scene — apelat O SINGURĂ DATĂ după model load

// Gestionare axe:
await zm.addAxis(def: RigAxisDef);
await zm.applyAxisDelta(axisId, dx, dz);   // deplasare incrementală (m)
await zm.setAxisPosition(axisId, dx, dz);  // poziție absolută (m)
await zm.resetAxis(axisId);                // restaurare geometrie originală
await zm.removeAxis(axisId);               // reset + șterge zona
await zm.dispose();                        // toate zonele + gizmo cleanup

// Conversii coordonate:
await zm.getBrepBbox();
// → { minX, maxX, minZ, maxZ } în metres
await zm.convertParserAxesToBrep(parserBounds, axesX_mm, axesY_mm);
// → { brepAxesXMm, brepAxesYMm }
await zm.convertBrepAxesToParser(parserBounds, brepAxesXMm, brepAxesYMm);
// → { parserAxesXMm, parserAxesYMm }

// Listener UI:
const unsub = zm.onChange(() => { /* re-render UI */ });
unsub(); // dezabonare
```

`RigAxisDef`:
```typescript
interface RigAxisDef {
  id:          string;    // ex: "rig-x-storey_0-1"
  dir:         'X' | 'Y';
  positionM:   number;    // poziție curentă în BREP world metres
  originM:     number;    // poziție originală — NICIODATĂ schimbată
  label:       string;    // "1", "2", "A", "B" etc.
  halfWidthM?: number;    // lățimea jumătate a zonei (default 0.25m)
}
```

### 6.3 `ensureInit()` — construirea cache-ului BREP

Apelat lazy la primul `addAxis()`. Complexitate O(N) unde N = total puncte BREP (ex: ~50k pentru Fertighaus, ~2-3s).

```typescript
private async ensureInit(): Promise<void> {
  // 1. allSamples = await model.getSamples()
  // 2. allGT      = await model.getGlobalTransforms()
  // 3. allLT      = await model.getLocalTransforms()
  // 4. repSamples = Map<repId, SampleRecord[]>   (group-by representation)
  // 5. allReps    = await model.getRepresentations(repIds)
  // 6. Calculează _brepBbox:
  //    pentru fiecare repr → primul sample → toWorld(pts) → extinde bbox
}
```

### 6.4 `addAxis()` — algoritmul complet

```
1. makeAxisStripPolygon(dir, originM, halfWidthM, -200, 200)
   → dreptunghi strip în planul XZ

2. _findAffectedReps(polygon, minY=-200, maxY=200):
   pentru fiecare (repId, repr) din allReps:
     pentru fiecare sample al acelei repr:
       dacă _repBySample.has(sampleId):
         verifică overlap pe baseline → returnează AffectedRep existent
       altfel:
         toWorld(pts, localT, globalT) → dacă vreun pt în polygon:
           creează AffectedRep {
             baseline = current = shell.points.map(pt => [...pt])
             primarySample = inst
             clonedRepId = null
           }
           _repBySample.set(sampleId, newRep)

3. Pre-calculează ownedIndices: Map<sampleId, Set<ptIdx>>
   pentru fiecare pt din baseline:
     toWorld → pointInPolygonXZ → dacă da: ownedIndices.get(sampleId).add(ptIdx)

4. Stochează ZoneState în _zones
5. rebuildGizmos()
```

**Half-width optim** (calculat în `IFCPlanView`):
```typescript
const leftHalf  = prev !== null ? (cur - prev) * 0.001 / 2 : 2.0;
const rightHalf = next !== null ? (next - cur) * 0.001 / 2 : 2.0;
halfWidthM = Math.max(leftHalf, rightHalf);
```

### 6.5 `_applyDelta()` — deplasarea vertexurilor

```typescript
private async _applyDelta(axisId: string, dx: number, dz: number): Promise<void> {
  const state = this._zones.get(axisId);
  if (!state) return;

  for (const rep of state.affectedReps) {
    const owned   = state.ownedIndices.get(rep.primarySample.sampleId);
    if (!owned?.size) continue;
    const globalT = this._cache!.allGT.get(rep.primarySample.item);
    const localT  = this._cache!.allLT.get(rep.primarySample.localTransform);

    for (const ptIdx of owned) {
      const pt_local = rep.current[ptIdx]!;
      const wp       = toWorld(pt_local, localT, globalT);       // local → world
      const wp_new   = [wp[0] + dx, wp[1], wp[2] + dz];          // adaugă deplasarea
      rep.current[ptIdx] = fromWorld(wp_new, localT, globalT) as Pt3; // world → local
    }
  }

  state.dx += dx;
  state.dz += dz;
  await this._writeFragsForReps(state.affectedReps);
  this._emit();
  this.rebuildGizmos();
}
```

**De ce `toWorld → fromWorld`?**  
`dx`/`dz` sunt în spațiul world. Fiecare sample poate fi rotit/scalat față de world prin `localTransform` + `globalTransform`. Fără round-trip-ul world, deplasarea ar fi distorsionată în sisteme locale ne-identitare.

### 6.6 `_writeFragsForReps()` — scrierea în model

**Pattern clone-per-sample** — fiecare sample afectat primește propria clonă a reprezentării:

```typescript
private async _writeFragsForReps(reps: AffectedRep[]): Promise<void> {
  const requests: FRAGS.EditRequest[] = [];
  const createIndices: { rep: AffectedRep }[] = [];
  const seen = new Set<number>(); // deduplicare pe sampleId

  for (const rep of reps) {
    if (seen.has(rep.primarySample.sampleId)) continue;
    seen.add(rep.primarySample.sampleId);

    const origShell = (this._cache!.allReps.get(rep.repId)!.geometry as FRAGS.RawShell);
    const shellData: FRAGS.RawShell = {
      points:          rep.current.map(pt => (pt ?? [0, 0, 0]) as number[]),
      profiles:        origShell.profiles,
      bigProfiles:     origShell.bigProfiles,
      holes:           origShell.holes,
      bigHoles:        origShell.bigHoles,
      profilesFaceIds: origShell.profilesFaceIds,
      type:            origShell.type,
    };
    const repData: FRAGS.RawRepresentation = {
      bbox:                computeBbox(rep.current),   // [minX,minY,minZ,maxX,maxY,maxZ]
      representationClass: origRep.representationClass,
      geometry:            shellData,
    };

    if (rep.clonedRepId) {
      // Scrieri ulterioare — actualizare geometrie clonă existentă
      requests.push({
        type:    FRAGS.EditRequestType.UPDATE_REPRESENTATION,
        localId: rep.clonedRepId,
        data:    repData,
      } as FRAGS.EditRequest);
    } else {
      // Prima scriere — creare clonă + redirecționare sample
      const tempId = `rig-rep-${rep.primarySample.sampleId}-${Date.now()}`;
      createIndices.push({ rep });

      requests.push({
        type:   FRAGS.EditRequestType.CREATE_REPRESENTATION,
        tempId,
        data:   repData,
      } as FRAGS.EditRequest);

      requests.push({
        type:    FRAGS.EditRequestType.UPDATE_SAMPLE,
        localId: rep.primarySample.sampleId,
        data: {
          item:           rep.primarySample.item,
          material:       rep.primarySample.material,
          representation: tempId,   // referință spre noul CREATE (string!)
          localTransform: rep.primarySample.localTransform,
        },
      } as FRAGS.EditRequest);
    }
  }

  if (!requests.length) return;

  // editedIds[i] = ID real pentru al i-lea CREATE_REPRESENTATION din batch
  const editedIds = await this.fragsModels.editor.edit(this.model.modelId, requests);

  if (Array.isArray(editedIds)) {
    for (let i = 0; i < createIndices.length; i++) {
      createIndices[i].rep.clonedRepId =
        typeof editedIds[i] === 'number' ? editedIds[i] : null;
    }
  }

  await this.fragsModels.update(true);
  await fragments.core.update(); // flush tile streaming
}
```

**Restaurare originală:**
```typescript
// UPDATE_SAMPLE înapoi la repr originală:
requests.push({
  type:    FRAGS.EditRequestType.UPDATE_SAMPLE,
  localId: rep.primarySample.sampleId,
  data: {
    item:           rep.primarySample.item,
    material:       rep.primarySample.material,
    representation: rep.primarySample.representation,  // ID repr originală
    localTransform: rep.primarySample.localTransform,
  },
} as FRAGS.EditRequest);
rep.clonedRepId = null;
rep.current = rep.baseline.map(pt => pt ? [...pt] as Pt3 : null);
```

Clona rămâne în model dar devine "orfană" (niciun sample nu o referă) → nu se mai randează.

---

## 7. Gizmo-uri 3D

### 7.1 Prizmă wireframe (`makeZoneBox`)

```typescript
// BoxGeometry → EdgesGeometry → LineSegments (wireframe)
const geo   = new THREE.BoxGeometry(w, h, d);
const edges = new THREE.EdgesGeometry(geo);
const mat   = new THREE.LineBasicMaterial({
  color:       moved ? 0xff9900 : 0x00ccff,  // portocaliu = deplasat, cyan = fix
  transparent: true, opacity: 0.5, depthTest: false,
});
const lines = new THREE.LineSegments(edges, mat);
lines.renderOrder = 998;
lines.position.set((minX+maxX)/2, baseY + h/2, (minZ+maxZ)/2);

// Fill semitransparent la baza prizmei (vizibil în planul 2D):
const fill = new THREE.Mesh(
  new THREE.PlaneGeometry(w, d),
  new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.08, depthTest: false, side: THREE.DoubleSide,
    color: moved ? 0xff9900 : 0x00ccff,
  })
);
fill.rotation.x = -Math.PI / 2;  // culcat orizontal
fill.position.set((minX+maxX)/2, baseY + 0.01, (minZ+maxZ)/2);
fill.renderOrder = 997;
```

Dimensiunile sunt **clamped la BREP bbox + 1m padding** pentru a evita prisme vizuale de ±200m:
```typescript
minX = Math.max(polygon_minX, brepBbox.minX - 1.0);
maxX = Math.min(polygon_maxX, brepBbox.maxX + 1.0);
// idem pentru Z
```
Poziția se deplasează cu `state.dx` / `state.dz`.

### 7.2 Săgeți (`makeArrowMesh`)

```typescript
// Shaft: CylinderGeometry(radiusTop=0.04, radiusBottom=0.04, height=1.5, radialSegments=8)
// Head:  ConeGeometry(radius=0.12, height=0.5, radialSegments=10)

// dir='x': pointează spre +X (roșu 0xff4444)
shaft.rotation.z = -Math.PI / 2;
shaft.position.set(shaftLen/2, 0, 0);
head.rotation.z = -Math.PI / 2;
head.position.set(shaftLen + headLen/2, 0, 0);

// dir='z': pointează spre +Z (albastru 0x4444ff)
shaft.rotation.x = Math.PI / 2;
shaft.position.set(0, 0, shaftLen/2);
head.rotation.x = Math.PI / 2;
head.position.set(0, 0, shaftLen + headLen/2);

group.renderOrder = 999;
group.position.copy(centroid); // centroidul poligonului + deplasare curentă
```

### 7.3 Lifecycle gizmo-uri

```typescript
zm.setScene(scene);      // O singură dată după model load
                         // → scene.add(this._gizmosGroup)

zm.rebuildGizmos();      // Apelat automat după addAxis, _applyDelta, resetAxis
// Intern:
//   while (group.children.length) {
//     child.traverse → geometry.dispose() + material.dispose()
//     group.remove(child)
//   }
//   pentru fiecare zone: makeZoneBox + makeArrowMesh → group.add(...)

zm.dispose();
// → scene.remove(this._gizmosGroup)
// → traverse → geometry.dispose() + material.dispose()
```

---

## 8. `IFCOrthoPlanView` — renderer OBC

Fișier: `src/components/views/IFCOrthoPlanView.tsx`

### 8.1 Setup OBC

```typescript
const components = new OBC.Components();
const world = components.get(OBC.Worlds).create<
  OBC.SimpleScene,
  OBC.OrthoPerspectiveCamera,
  OBF.PostproductionRenderer
>();
world.scene    = new OBC.SimpleScene(components);
world.renderer = new OBF.PostproductionRenderer(components, containerDivRef.current);
world.camera   = new OBC.OrthoPerspectiveCamera(components);
world.scene.setup();
world.renderer.three.localClippingEnabled = true;
components.init();
world.renderer.postproduction.enabled = true;

// Fragment LOD materials (tile streaming):
fragments.core.models.materials.list.onItemSet.add(({ value: mat }) => {
  if ((mat as any).isLodMaterial) {
    world.renderer.postproduction.basePass.isolatedMaterials.push(mat as THREE.Material);
  }
});
```

### 8.2 Camera ortografică top-down

```typescript
async function applyPlanView(cam: OBC.OrthoPerspectiveCamera, modelBox: THREE.Box3) {
  const center = modelBox.getCenter(new THREE.Vector3());
  const size   = modelBox.getSize(new THREE.Vector3());
  const dist   = Math.max(size.x, size.z) * 2 + 50;

  // Poziționare deasupra centrului, privind drept în jos
  await cam.controls.setLookAt(
    center.x, center.y + dist, center.z,
    center.x, center.y,        center.z,
    false,
  );

  // Switch la proiecție ortografică
  // NOTĂ: OBC resetează mouseButtons intern la setOrthoCamera → trebuie reconfigurate DUPĂ
  await (cam.projection as any).set('Orthographic');

  // Blocare rotire (top-down fix)
  cam.controls.minPolarAngle = 0;
  cam.controls.maxPolarAngle = 0.001;

  // Mouse buttons — camera-controls ACTION enum:
  // NONE=0, ROTATE=1, TRUCK=2, DOLLY=16, ZOOM=32
  cam.controls.mouseButtons.left   = 2;   // pan (TRUCK)
  cam.controls.mouseButtons.right  = 2;   // pan
  cam.controls.mouseButtons.middle = 2;   // pan
  (cam.controls.mouseButtons as any).wheel = 32; // zoom (modifică camera.zoom, nu distanța)

  cam.controls.dollyToCursor = true;
  cam.controls.dollySpeed    = 1.0;
  cam.controls.truckSpeed    = 2.0;

  // Touch
  cam.controls.touches.one   = 128 as any;    // TOUCH_TRUCK (pan)
  cam.controls.touches.two   = 65536 as any;  // TOUCH_ZOOM_TRUCK (zoom + pan)
  cam.controls.touches.three = 0 as any;      // NONE

  // Fit la footprint XZ (ignoră Y)
  const PAD = Math.max(size.x, size.z) * 0.05;
  const flatBox = new THREE.Box3(
    new THREE.Vector3(modelBox.min.x - PAD, center.y - 0.1, modelBox.min.z - PAD),
    new THREE.Vector3(modelBox.max.x + PAD, center.y + 0.1, modelBox.max.z + PAD),
  );
  await cam.controls.fitToBox(flatBox, false, {
    paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
  });
}
```

**`cam.three`** = camera ortografică activă (folosită de PostproductionRenderer);  
**`cam.threePersp`** = camera perspectivă internă (folosită EXCLUSIV pentru tile streaming LOD de `fragments.core`).

Sincronizare tile LOD (listener pe controls):
```typescript
cam.controls.addEventListener('update', () => {
  cam.threePersp.position.copy(cam.three.position);
  cam.threePersp.quaternion.copy(cam.three.quaternion);
  cam.threePersp.updateProjectionMatrix();
  fragments.core.update();
});
world.renderer.onBeforeUpdate.add(() => { fragments.core.update(); });
```

### 8.3 Încărcarea modelului

```typescript
const FRAGMENTS_WORKER_URL = '/node_modules/@thatopen/fragments/dist/Worker/worker.mjs';
const WEBIFC_WASM_PATH     = '/node_modules/web-ifc/';

fragments.init(FRAGMENTS_WORKER_URL);

await ifcLoader.setup({
  autoSetWasm: false,
  wasm: { absolute: true, path: WEBIFC_WASM_PATH },
});

// Abonare la evenimentul de model adăugat:
fragments.core.models.list.onItemSet.add(({ value: model }) => {
  model.useCamera(cam.threePersp);  // tile LOD via persp camera
  model.getClippingPlanesEvent = () => Array.from(world.renderer.three.clippingPlanes);
  world.scene.three.add(model.object);
  fragments.core.update(true);
});

const model = await ifcLoader.load(new Uint8Array(ifcBuffer), false, 'modelName');
model.graphicsQuality = 1;

// Storey clipping (planuri de tăiere pe Y):
world.renderer.three.clippingPlanes = [
  new THREE.Plane(new THREE.Vector3(0, 1, 0), -clipBottomM),
  new THREE.Plane(new THREE.Vector3(0, -1, 0), clipTopM),
];
```

### 8.4 Overlay HTML axe rig — proiecție și drag

**Proiecție world → screen** (rulează în `requestAnimationFrame`):
```typescript
const posM = axis.positionMm * 0.001;
const worldPt = axis.dir === 'X'
  ? new THREE.Vector3(posM, 0, 0)
  : new THREE.Vector3(0, 0, posM);
const ndc = worldPt.project(cam.three);  // cam.three = OrthoCamera
const screenX = (ndc.x * 0.5 + 0.5) * rect.width;
const screenY = (-ndc.y * 0.5 + 0.5) * rect.height;
```

**Hit-test canvas adaptiv la zoom:**
```typescript
// Threshold în world metres, proporțional cu zoom-ul curent:
const visibleWidth = (cam.three as THREE.OrthographicCamera).right
                   - (cam.three as THREE.OrthographicCamera).left;
const threshold = (visibleWidth / containerPxWidth) * RIG_HIT_PX; // RIG_HIT_PX = 12

// Raycast screen → world XZ:
raycaster.setFromCamera(ndcVec, cam.three);
raycaster.ray.intersectPlane(
  new THREE.Plane(new THREE.Vector3(0, 1, 0), -elevY),  // ground plane la Y=elevY
  hit
);
// hit.x = world X (m), hit.z = world Z (m)
```

**Lifecycle drag (cu dezactivare camera controls):**
```typescript
// pointerdown (capture phase — înaintea camera-controls):
canvas.addEventListener('pointerdown', onDown, true);

// În startDrag():
cam.controls.enabled = false;   // dezactivează pan/zoom camera
canvas.style.cursor = 'grabbing';
window.addEventListener('pointermove', onDragMove);  // window-level
window.addEventListener('pointerup', onDragEnd);

// În onDragEnd():
cam.controls.enabled = true;
onAxisDragEnd(axisId, startPosMm, endPosMm);
```

---

## 9. `IFCPlanView` — lifecycle management

Fișier: `src/components/views/IFCPlanView.tsx`

### 9.1 Regula anti-stale-closure (CRITICĂ)

**Problema:** Dacă `handleModelLoaded` are `[rigAxes]` în deps → se recreează la fiecare schimbare de poziție a axelor → `IFCRigZoneModifier` distrus și recreat → zonele se pierd în mijlocul unui drag.

**Soluția:**

```typescript
// handleModelLoaded: deps [] → STABIL, niciodată recreat
const handleModelLoaded = useCallback((
  model, fragsModels, components, bbox, scene, renderer
) => {
  if (zoneModifierRef.current) void zoneModifierRef.current.dispose();
  zoneModifierRef.current = new IFCRigZoneModifier(model, fragsModels, components);
  zoneModifierRef.current.setScene(scene);
  brepBboxRef.current = bbox;
  setSharedScene(scene);
  setSharedRenderer(renderer);
}, []);  // ← GOLE — nicio dependență

// Ref pentru acces la rigAxes curent fără deps în callbacks:
const rigAxesRef = useRef(rigAxes);
rigAxesRef.current = rigAxes;  // actualizat la fiecare render

// handleAxisDragEnd: deps [] — stabil
const handleAxisDragEnd = useCallback((axisId, startPosMm, endPosMm) => {
  const zm   = zoneModifierRef.current;
  const axis = rigAxesRef.current.find(a => a.id === axisId); // VIA REF!
  if (!zm || !axis) return;
  const deltaM = (endPosMm - startPosMm) * 0.001;
  const dx = axis.dir === 'X' ? deltaM : 0;
  const dz = axis.dir === 'Y' ? deltaM : 0;
  zm.applyAxisDelta(axisId, dx, dz).catch(console.warn);
}, []);  // ← GOLE

// Înregistrarea axelor — SEPARAT, declanșat NUMAI când LISTA se schimbă (nu poziția)
const axisIdsKey = useMemo(
  () => rigAxes.map(a => a.id).join(','),
  [rigAxes]
);

useEffect(() => {
  const zm = zoneModifierRef.current;
  if (!zm || !rigAxes.length) return;
  let cancelled = false;
  (async () => {
    (zm as any)._zones?.clear?.();  // șterge zonele vechi
    for (const a of rigAxes) {
      if (cancelled) return;
      await zm.addAxis({
        id: a.id, dir: a.dir,
        positionM:  a.positionMm * 0.001,
        originM:    a.originMm * 0.001,
        label:      a.label,
        halfWidthM: halfWidths.get(a.id) ?? 0.25,
      });
    }
  })();
  return () => { cancelled = true; };
}, [axisIdsKey]); // ← NU se declanșează la schimbări de positionMm (drag)
```

### 9.2 Fluxul complet al unui drag

```
1. pointerdown (canvas sau balon HTML)
   → startDrag(axisId, dir, startPosMm)
   → cam.controls.enabled = false

2. pointermove (window-level)
   → screenToWorldXZ() → newPosMm
   → updateLinePosition() [Three.js imperativ — fără React]
   → onAxisDrag(axisId, newPosMm)
   → updateRigAxis(id, newPosMm)  [Zustand — React re-render: balon se mișcă]
   → FĂRĂ scriere BREP

3. pointerup (window-level)
   → cam.controls.enabled = true
   → onAxisDragEnd(axisId, startPosMm, endPosMm)
   → handleAxisDragEnd:
       deltaM = (endPosMm - startPosMm) * 0.001
       dx = dir==='X' ? deltaM : 0
       dz = dir==='Y' ? deltaM : 0
       zm.applyAxisDelta(axisId, dx, dz)  ← ACUM se deformează BREP
         → _applyDelta: per vertex: toWorld → +dx/dz → fromWorld → current[]
         → _writeFragsForReps: editor.edit() → fragsModels.update(true)
         → rebuildGizmos: prizme portocalii
```

---

## 10. `IFC3DFloatingPanel` — viewer 3D shared

Fișier: `src/components/views/IFC3DFloatingPanel.tsx`

Nu are propriul renderer/scene. **Partajează** scene-ul și renderer-ul Three.js din `IFCOrthoPlanView`. Randararea: `WebGLRenderTarget` + pixel readback → canvas 2D:

```typescript
// Init:
const camera   = new THREE.PerspectiveCamera(50, aspect, 0.1, 2000);
const controls = new OrbitControls(camera, canvas2dElement);
controls.enableDamping  = true;
controls.dampingFactor  = 0.12;
const target   = new THREE.WebGLRenderTarget(w, h, {
  format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
});
let pixelBuf = new Uint8Array(w * h * 4);

// Render loop (rAF):
const prevRT   = sharedRenderer.getRenderTarget();
const prevClip = sharedRenderer.clippingPlanes;
sharedRenderer.clippingPlanes = clipPlanesRef.current;
sharedRenderer.setRenderTarget(target);
sharedRenderer.clear(true, true, true);
sharedRenderer.render(sharedScene, camera);
sharedRenderer.setRenderTarget(prevRT);
sharedRenderer.clippingPlanes = prevClip;

sharedRenderer.readRenderTargetPixels(target, 0, 0, w, h, pixelBuf);

// Flip Y (WebGL bottom-up → canvas top-down):
const flipped = new Uint8ClampedArray(pixelBuf.length);
for (let y = 0; y < h; y++) {
  flipped.set(pixelBuf.subarray(y*w*4, (y+1)*w*4), (h-1-y)*w*4);
}
ctx2d.putImageData(new ImageData(flipped, w, h), 0, 0);
```

Orice deformare aplicată prin `fragsModels.update(true)` este imediat vizibilă → shared scene.

---

## 11. `ifcStepParser.ts` — extragere metadate IFC

```typescript
const data = await parseIfcPlan(rawBuffer: ArrayBuffer);
// Returnează:
{
  storeys: [{
    id:           string,       // "storey_0", "storey_1" etc.
    name:         string,       // din IFC LONGNAME
    elevation_mm: number,       // cota planșeului (mm)
    height_mm:    number,       // înălțimea etajului (mm)
    axesX_mm:     number[],     // axe X detectate, mm, sortate crescător
    axesY_mm:     number[],     // axe Y detectate, mm, sortate crescător
  }],
  worldBounds: [minX_mm, minY_mm, maxX_mm, maxY_mm],  // AABB în parser space
  totalWalls:  number,
  totalSlabs:  number,
}
```

`worldBounds` este esențial pentru calibrarea coordonatelor parser → BREP world.

---

## 12. `rigDeformer.ts` — generator axe rig

```typescript
interface RigAxis {
  id:         string;   // "rig-x-{storeyId}-{index}" sau "rig-y-{storeyId}-{index}"
  dir:        'X' | 'Y';
  positionMm: number;   // poziție curentă (modificată la drag)
  originMm:   number;   // poziție originală (NICIODATĂ modificată)
  label:      string;   // "1","2",... pentru X;  "A","B",... pentru Y
}

const axes: RigAxis[] = generateRigFromStorey(
  brepAxesXMm: number[],  // din convertParserAxesToBrep
  brepAxesYMm: number[],
  storeyId: string,        // "storey_0" etc.
);
```

---

## 13. Starea Zustand (store)

```typescript
// src/store/index.ts (fragment relevant)
interface RigState {
  axes: RigAxis[];
}

store.setRigAxes(axes: RigAxis[])               // înlocuiește lista completă
store.updateRigAxis(id: string, newPosMm: number) // actualizează positionMm al unei axe
store.clearRig()                                // șterge tot rig-ul
```

---

## 14. Recipe minimală de reproducere

```typescript
// ─── 1. Instalare ───────────────────────────────────────────────────────────
// npm i @thatopen/fragments@3.4.5 @thatopen/components @thatopen/components-front three

// ─── 2. Copiază fișierele (fără dependențe de React/Zustand) ───────────────
//   src/lib/ifcBrepHelpers.ts
//   src/lib/IFCRigZoneModifier.ts

// ─── 3. Init OBC + load model ───────────────────────────────────────────────
const components = new OBC.Components();
const world = components.get(OBC.Worlds).create();
world.scene    = new OBC.SimpleScene(components);
world.renderer = new OBC.SimpleRenderer(components, document.getElementById('viewport'));
world.camera   = new OBC.SimpleCamera(components);
world.scene.setup();
components.init();

const fragments = components.get(OBC.FragmentsManager);
fragments.init('/node_modules/@thatopen/fragments/dist/Worker/worker.mjs');

const ifcLoader = components.get(OBC.IfcLoader);
await ifcLoader.setup({
  autoSetWasm: false,
  wasm: { absolute: true, path: '/node_modules/web-ifc/' },
});

const model = await ifcLoader.load(new Uint8Array(ifcFileArrayBuffer), false, 'myModel');
world.scene.three.add(model.object);
await fragments.core.update(true);

// ─── 4. Creare modifier ─────────────────────────────────────────────────────
const zm = new IFCRigZoneModifier(model, fragments.core, components);
zm.setScene(world.scene.three);

// ─── 5. Obținere BREP bbox ──────────────────────────────────────────────────
const bbox = await zm.getBrepBbox();
// { minX: 0.0, maxX: 20.3, minZ: -15.1, maxZ: 0.0 } în metres

// ─── 6. Conversie opțională parser → BREP ───────────────────────────────────
// (dacă axele sunt în coordonate IFC parser — mm, nord = +Y)
const parserBounds: [number, number, number, number] = [0, 0, 20000, 15000]; // mm
const { brepAxesXMm, brepAxesYMm } = await zm.convertParserAxesToBrep(
  parserBounds,
  [0, 5000, 10000, 15000, 20000],
  [0, 3000, 6000, 9000, 12000],
);

// ─── 7. Calculare half-widths și adăugare axe ───────────────────────────────
for (let i = 0; i < brepAxesXMm.length; i++) {
  const cur  = brepAxesXMm[i];
  const prev = brepAxesXMm[i-1];
  const next = brepAxesXMm[i+1];
  const hw = Math.max(
    prev != null ? (cur - prev) * 0.001 / 2 : 2.0,
    next != null ? (next - cur) * 0.001 / 2 : 2.0,
  );
  await zm.addAxis({
    id:        `ax-x-${i}`,
    dir:       'X',
    positionM: cur * 0.001,
    originM:   cur * 0.001,
    label:     String(i + 1),
    halfWidthM: hw,
  });
}

// ─── 8. Deplasare ───────────────────────────────────────────────────────────
// Mută axa "ax-x-1" cu +2m pe X:
await zm.applyAxisDelta('ax-x-1', 2.0, 0.0);

// ─── 9. Reset ───────────────────────────────────────────────────────────────
await zm.resetAxis('ax-x-1');

// ─── 10. Cleanup complet ────────────────────────────────────────────────────
await zm.dispose();
```

---

## 15. Capcane și lecții

| Problemă | Cauza | Soluția |
|---|---|---|
| Zonele se golesc la drag | `handleModelLoaded` cu `[rigAxes]` în deps → modifier recreat la fiecare drag | deps: `[]` + `rigAxesRef.current` |
| Zone prea înguste (685 pts capturate vs 8039 așteptate) | `halfWidthM = 0.25m` fix | Calculat dinamic din inter-axis distance |
| Prisme vizuale de ±200m | `makeAxisStripPolygon` span extins la ±200m | Clamp la BREP bbox + 1m padding |
| Compile error: variable redeclarată | `const moved = ...` declarat de două ori în `makeZoneBox` | Declarat o singură dată înaintea ambelor utilizări |
| Transformarea dispare după modificare | Modificare greșită a sincronizării camerei → render stricat | `git checkout -- src/components/views/IFCOrthoPlanView.tsx` |
| Gizmo-urile nu apar în scenă | `setScene()` nu era apelat | Apelat în `handleModelLoaded` imediat după `new IFCRigZoneModifier` |
| 135 shared reps cu max 120 samples | Instanțiere IFC normală (ferestre, uși identice) | Clone per-sample: fiecare sample afectat primește propria clonă via `UPDATE_SAMPLE` |
| `editor.edit()` nu returnează IDs | `editedIds` poate fi `null` / `[]` la eroare | Fallback: setează `clonedRepId = null` → va recrea la apelul următor |

---

## 16. Diagrama completă a fluxului de date

```
IFC File (.ifc)
    │
    ├──► ifcStepParser.parseIfcPlan()
    │        → storeys[{ id, name, elevation_mm, axesX_mm, axesY_mm }]
    │        → worldBounds: [minX_mm, minY_mm, maxX_mm, maxY_mm]
    │
    └──► OBC IfcLoader.load(uint8Array) → FragmentsModel
              (geometry stocată ca BREP: points[], profiles[], holes[] în metres)

IFCPlanView.handleModelLoaded (deps=[])
    → new IFCRigZoneModifier(model, fragsModels, components)
    → zm.setScene(world.scene.three)

[user: "Auto Rig"]
    → zm.convertParserAxesToBrep(parserBounds, axesX_mm, axesY_mm)
          → calibrare bbox: parser X→BREP X (liniar), parser Y→BREP Z (flipat)
          → { brepAxesXMm, brepAxesYMm }
    → generateRigFromStorey(brepAxesXMm, brepAxesYMm) → RigAxis[]
    → setRigAxes(axes)  →  axisIdsKey change

useEffect([axisIdsKey])
    → zm._zones.clear()
    → for each axis: zm.addAxis(def)
          → makeAxisStripPolygon(dir, originM, halfWidthM, -200, 200)
          → _findAffectedReps():
                for each repr → sample → toWorld(pts) → pointInPolygonXZ()
                → AffectedRep { baseline, current, primarySample, clonedRepId=null }
                → _repBySample.set(sampleId, rep)
          → ownedIndices: Map<sampleId, Set<ptIdx>>
          → rebuildGizmos():
                BoxGeometry→EdgesGeometry→LineSegments (cyan wireframe)
                PlaneGeometry (fill semitransparent)
                CylinderGeometry+ConeGeometry (săgeți)
                → _gizmosGroup → scene

[user drags axis in IFCOrthoPlanView]
    pointerdown (canvas capture) → startDrag → cam.controls.enabled = false
    pointermove (window) → screenToWorldXZ (raycast → ground plane)
                         → updateLinePosition (Three.js imperativ)
                         → onAxisDrag → updateRigAxis [Zustand]
                         → FĂRĂ scriere BREP
    pointerup (window) → cam.controls.enabled = true
                       → onAxisDragEnd(id, startPosMm, endPosMm)

IFCPlanView.handleAxisDragEnd (deps=[])
    → axis = rigAxesRef.current.find(...)
    → deltaM = (endPosMm - startPosMm) * 0.001
    → zm.applyAxisDelta(id, dx, dz)

IFCRigZoneModifier._applyDelta(id, dx, dz)
    → per owned vertex:
          pt_local = rep.current[ptIdx]
          wp = toWorld(pt_local, localT, globalT)       // local → world (2 affine transforms)
          wp_new = [wp[0]+dx, wp[1], wp[2]+dz]          // adaugă deplasarea world
          rep.current[ptIdx] = fromWorld(wp_new, ...)   // world → local
    → state.dx += dx; state.dz += dz
    → _writeFragsForReps(affectedReps)

IFCRigZoneModifier._writeFragsForReps(reps)
    → prima scriere per sample:
          CREATE_REPRESENTATION(tempId, RawShell cu current[])
          UPDATE_SAMPLE(sampleId, representation=tempId)
          → editor.edit() → editedIds[] → rep.clonedRepId = editedIds[i]
    → scrieri ulterioare:
          UPDATE_REPRESENTATION(clonedRepId, RawShell cu current[])
    → fragsModels.update(true) → Three.js InstancedMeshes rebuild
    → fragments.core.update() → tile LOD flush
    → rebuildGizmos() → prisme portocalii (moved)

IFC3DFloatingPanel (render loop, rAF)
    → OrbitControls + PerspectiveCamera
    → sharedRenderer.setRenderTarget(target) → render(sharedScene, camera)
    → readRenderTargetPixels → flip Y → putImageData pe canvas 2D
    → deformarea vizibilă imediat (shared scene)
```
