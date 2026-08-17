# Cum adaugi un tip nou de fereastră / ușă (IFC sau procedural)

Biblioteca de elemente fereastra/ușă are **două straturi** sincronizate:

| Strat | Fișier | Rol |
|---|---|---|
| **Catalog runtime TS** | `src/lib/elementLibrary.ts` | Sursă primară — furnizează dropdown-ul în UI, chiar dacă backend-ul este offline |
| **Catalog YAML backend** | `backend/library/windows/library.yaml` sau `doors/library.yaml` | Extensii adăugate ulterior; interogate prin `GET /api/library/{family}` |
| **Fișiere de geometrie** | `backend/library/windows/{style}/{id}/` | Fișiere STEP / SVG / IFC plasate pe disc |

Regula: **întotdeauna adaugă intrarea în ambele fișiere** (TS și YAML) pentru ca tipul să apară corect în panoul de proprietăți și în randerul 3D.

---

## Tipuri de elemente acceptate

### A. Element **procedural** (fără geometrie IFC)
Fereastra / ușa e redată printr-un parametric box generat de viewer.  
`ifc_path` este `null`.

### B. Element **IFC** (geometrie din fișier `.ifc`)
Viewer-ul încarcă fișierul `.ifc` plasat în biblioteca backend, îl parsează cu `web-ifc` și îl plasează în scenă.  
`ifc_path` indică calea relativă față de `backend/library/`.

---

## Pasul 1 — Alege un ID

Convenție de denumire:

```
Ferestre:  W-{STIL}-{latime_cm}x{inaltime_cm}
                          sau
           W-{STIL}-{latime_cm}x{inaltime_cm}-IFC   ← când are geometrie IFC

Uși:       D-{TIP}-{latime_cm}x{inaltime_cm}
           D-{TIP}-{latime_cm}x{inaltime_cm}-IFC
```

Coduri de stil uzuale: `default`, `french`, `gothic`, `modern`, `industrial`.  
Coduri de tip ușă uzuale: `SWING`, `DBL`, `SLD` (sliding), `FR` (french), `GT` (gothic).

Exemple: `W-SNG-120x160`, `W-AR-80x200-IFC`, `D-SWING-100x210-IFC`

---

## Pasul 2 — Adaugă intrarea în `src/lib/elementLibrary.ts`

Deschide `src/lib/elementLibrary.ts` și localizează secțiunea `WINDOW_TYPES` sau `DOOR_TYPES`.

### Exemplu fereastră procedurală

```typescript
// în WINDOW_TYPES[]
{
  id: 'W-SNG-120x160',
  label: 'Window Single 120×160 cm',
  style: 'default',
  width_mm: 1200,
  height_mm: 1600,
  sill_height_mm: 900,
  depth_mm: 200,
  opening: 'single',
  material: 'PVC alb',
  description: 'Fereastră simplu batant 1200×1600 mm',
  library_path: 'windows/default/W-SNG-120x160',
  ifc_path: null,               // ← null = geometrie procedurală
},
```

### Exemplu fereastră cu geometrie IFC

```typescript
{
  id: 'W-AR-80x200-IFC',
  label: 'Arch Window 80×200 cm (IFC)',
  style: 'modern',
  width_mm: 800,
  height_mm: 2000,
  sill_height_mm: 0,
  depth_mm: 200,
  opening: 'single',
  material: 'Aluminiu RAL 9016',
  description: 'Fereastră arc 800×2000 mm — model IFC',
  library_path: 'windows/modern/W-AR-80x200-IFC',
  ifc_path: 'windows/modern/W-AR-80x200-IFC/W-AR-80x200-IFC.ifc',  // ← calea spre .ifc
},
```

### Exemplu ușă cu geometrie IFC

```typescript
// în DOOR_TYPES[]
{
  id: 'D-SWING-100x210-IFC',
  label: 'Door Swing 100×210 cm (IFC)',
  style: 'default',
  width_mm: 1000,
  height_mm: 2100,
  depth_mm: 200,
  leaf_count: 1,
  swing: 'right',
  material: 'Lemn masiv',
  description: 'Ușă batantă dreapta 1000×2100 mm — model IFC',
  library_path: 'doors/default/D-SWING-100x210-IFC',
  ifc_path: 'doors/default/D-SWING-100x210-IFC/D-SWING-100x210-IFC.ifc',
},
```

> **Câmpuri obligatorii**: `id`, `label`, `style`, `width_mm`, `height_mm`, `depth_mm`,
> `material`, `description`, `library_path`, `ifc_path` (`null` sau cale string).  
> Câmpuri specifice ferestrei: `sill_height_mm`, `opening`.  
> Câmpuri specifice ușii: `leaf_count`, `swing`.

---

## Pasul 3 — Adaugă intrarea în YAML-ul backend

Deschide `backend/library/windows/library.yaml` (sau `doors/library.yaml`) și adaugă un bloc
în lista `entries:` (exact aceleași valori ca în TS):

```yaml
# fereastră procedurală
- id: W-SNG-120x160
  label: "Window Single 120×160 cm"
  style: default
  width_mm: 1200
  height_mm: 1600
  sill_height_mm: 900
  depth_mm: 200
  opening: single
  material: "PVC alb"
  description: "Fereastră simplu batant 1200×1600 mm"
  library_path: "windows/default/W-SNG-120x160"
```

```yaml
# fereastră cu IFC
- id: W-AR-80x200-IFC
  label: "Arch Window 80×200 cm (IFC)"
  style: modern
  width_mm: 800
  height_mm: 2000
  sill_height_mm: 0
  depth_mm: 200
  opening: single
  material: "Aluminiu RAL 9016"
  description: "Fereastră arc 800×2000 mm — model IFC"
  library_path: "windows/modern/W-AR-80x200-IFC"
  ifc_path: "windows/modern/W-AR-80x200-IFC/W-AR-80x200-IFC.ifc"
```

---

## Pasul 4 — Creează folderul și plasează fișierele

```
backend/library/
└── windows/
    └── modern/                        ← stilul ales
        └── W-AR-80x200-IFC/           ← id-ul exact
            ├── W-AR-80x200-IFC.ifc    ← model IFC (obligatoriu dacă ifc_path != null)
            ├── model.step             ← opțional: geometrie STEP
            ├── void.step              ← opțional: goală pentru subtracție din perete
            ├── top.svg                ← opțional: vedere de sus / plan
            ├── front.svg              ← opțional: vedere frontală
            └── section.svg            ← opțional: secțiune verticală
```

### Cerințe fișier IFC

- Format: **IFC4** sau **IFC4.3** (`.ifc`, text STEP — nu binary `.ifczip`)
- Sistem de coordonate: originea în colțul **stânga-jos-față** al elementului
  - `X` → lățime (stânga → dreapta)
  - `Y` → înălțime (în sus)
  - `Z` → adâncime (față → spate, în perete)
- Unitate: **metri** (IFC standard) — web-ifc aplică automat `COORDINATE_TO_ORIGIN: true`
- Conținut recomandat: câte un `IfcRepresentation` per solid (rama, sticla, etc.)
- Vidul de perete (deschiderea) poate fi inclus ca solid separat numit `VOID`
  sau omis complet (viewer-ul folesoșete dimensiunile `width_mm`/`height_mm` din catalog pentru deschidere)

### Cerințe SVG (opționale, folosite de SheetViewer 2D)

- Viewbox: `0 0 {width_mm} {height_mm}` (mm, nicio unitate)
- `top.svg`: secțiune orizontală la jumătatea înălțimii elementului
- `front.svg`: față văzută din exterior
- `section.svg`: secțiune verticală la mijlocul lățimii

---

## Pasul 5 — Verificare

1. Repornește backend-ul (`uvicorn main:app --reload`) sau lasă reloader-ul automat
2. Testează că YAML-ul e valid:
   ```powershell
   Invoke-RestMethod "http://localhost:8000/api/library/window" | Select-Object -ExpandProperty entries | Where-Object { $_.id -eq "W-AR-80x200-IFC" }
   ```
3. Deschide BubbleGraph → adaugă un nod `window` → Properties Panel → dropdown — noul tip trebuie să apară
4. Selectează noul tip → viewer-ul 3D trebuie să încarce geometria IFC (sau să afișeze box-ul procedural dacă `ifc_path` este `null`)

---

## Rezumat flux date (runtime)

```
useLibraryTypes('window')
  ├── instant: returnează WINDOW_TYPES din elementLibrary.ts
  └── async: GET /api/library/window (backend/library/windows/library.yaml)
              └── merge: intrări YAML cu id inexistent în TS → adăugate la listă

LibraryTypePicker (Properties Panel)
  └── dropdown grupat pe style → selectare tip → setează window_type + width + height + sill_height

buildSceneGeometry (Ara3DViewer / WebIfcViewer)
  └── pentru fiecare nod window/door:
        resolveIfcPath(nodeType, typeId)
          ├── null  → geometrie procedurală (box frame + glass)
          └── path  → loadIfcParts(path) → web-ifc parsare → Three.js BufferGeometry
                       buildIfcGroup() → positionIfcGroup() → plasat în scenă
```
