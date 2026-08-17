# Multi-Viewer Support: Babylon.js vs. Three.js (Ara3D)

## Introducere

BubbleGraph acum suportă **doi motoare 3D diferite** pentru vizualizarea modelelor BIM:
- **Babylon.js** (implicit, performant, cu suport avansat)
- **Three.js cu Ara3D** (alternativă, mai ușoară, cu alte caracteristici)

Poți comuta între vieweruri direct din interfață atunci când lucrezi cu tab-ul 3D Model.

---

## Setup și Instalare

### 1. Asigurează-te că ai dependențele necesare

```bash
cd /path/to/bubble-graph
pnpm install
```

Dependențele vor fi automat instalate:
- `@babylonjs/core@^9.0.0` — vizualizare Babylon.js
- `three@^r128` — vizualizare Three.js (Ara3D)

### 2. Pornește aplicația

```bash
pnpm dev
```

---

## Utilizare

### Deschiderea unei tab-uri 3D Model

1. Din explorer-ul din stânga, sub secțiunea "3D Models", apasă butonul **"+ New 3D View"**
2. O nouă tab cu denumirea `<Nume Proiect> — 3D` va fi deschisă

### Schimbarea Viewer-ului

În tab-ul 3D Model, vei vedea o **bară de instrumente** în partea superioară cu selector de engine:

```
3D Engine: [Babylon.js] [Three.js (Ara3D)]
```

- Apasă **Babylon.js** pentru a folosi motorul Babylon.js
- Apasă **Three.js (Ara3D)** pentru a folosi motorul Three.js cu Ara3D

Change-ul este **instant** și **persistent** (se ține minte ștare ta).

---

## Funcționalități per Viewer

### Babylon.js (Default)
- ✅ Full feature set (toate elementele BIM: coloane, grinzi, pereți, plăci)
- ✅ Deschideri (uși/ferestre) cu geometrie detaliat
- ✅ Grid lines și axis markers
- ✅ Storey floor planes (translucent)
- ✅ Performanță optimă pentru scene mari
- 🎮 Controale: `Middle mouse drag` rotire, `Mouse wheel` zoom, `Right click + drag` pan

### Three.js / Ara3D
- ✅ Full feature set (toate elementele BIM)
- ✅ Grid lines și axis markers
- ✅ Storey floor planes (translucent)
- ✅ Geometrie similară cu Babylon.js
- ✅ Suport ușor de customizare (mai simplu three.js standard)
- 🎮 Controale: `Left mouse drag` rotire sferică, `Mouse wheel` zoom, `Shift+Drag` pan

**Notă:** Ara3D este o alternativă ușoară la Babylon.js. Continuă să se dezvolte cu mai multe caracteristici.

---

## Controale în Vizualizare

### Babylon.js
| Acțiune | Comandă |
|---------|---------|
| Rotire | Middle mouse button + drag |
| Zoom | Mouse wheel |
| Pan | Right mouse button + drag |
| Focus pe element | Double-click pe nod |

### Three.js (Ara3D)
| Acțiune | Comandă |
|---------|---------|
| Rotire | Left mouse button + drag |
| Zoom | Mouse wheel |
| Pan | (în viitor) |
| Focus pe element | (în viitor) |

---

## Suportul Geometriei

Ambele vieweruri suportă **aceleași tipuri de geometrie**:

| Tip | Descriere | Babylon.js | Three.js |
|-----|-----------|------------|----------|
| `storey` | Planuri etaj + grid | ✅ | ✅ |
| `column` | Coloane verticale (C25x25 etc.) | ✅ | ✅ |
| `beam` | Grinzi orizontale (B30x60 etc.) | ✅ | ✅ |
| `wall` | Pereți cu detalii (W20 etc.) | ✅ | ✅ |
| `slab` | Plăci orizontale | ✅ | ✅ |
| `foundation` | Blocuri de fundație | ✅ | ✅ |
| `window` | Deschideri de ferestre | ✅ | ⏳ |
| `door` | Deschideri de uși | ✅ | ⏳ |
| `ax` | Markeri de grid | ✅ | ✅ |

Legend: ✅ = Complet implementat, ⏳ = În progres, ❌ = Nu este implementat

---

## Dimensiuni și Convențiile BIM

### Tipuri de Dimensioni
Notația în `type_string` folosește **centimetri** (nu milimetri):

- `C25x25` → Coloană 25cm × 25cm (250mm × 250mm)
- `B30x60` → Grindă 30cm × 60cm (300mm × 600mm)
- `W20` → Perete 20cm grosime (200mm)
- `SLAB15` → Placă 15cm grosime (150mm)

În baza de date interna (LadyBugDB), toate coordonatele sunt în **milimetri (mm)**.

### Sistem de Coordonate (BIM Standard)
```
X → Est (plan orizontal dreapta)
Y → Nord (plan orizontal sus)
Z → Sus (elevație verticală)
```

Convertire în scene 3D:
- BIM X → Babylon X (neschimbat)
- BIM Y → Babylon Z (X+Y plan)
- BIM Z → Babylon Y (elevație verticală)

---

## Probleme Cunoscute și FAQ

### Q: De ce se schimbă viewer-ul greu?
R: Este complet normal. Schimbarea este instant deoarece scene sunt regenrate în real-time.

### Q: Pot salva preferința mea de viewer?
R: Da! Selectarea viewer-ului se salvează în store Zustand (persistent din browser).

### Q: Care viewer este mai bun?
R: **Babylon.js** este recomandată pentru case mari cu feature-uri avansate. **Three.js** este mai ușor de customizat și mai mic.

### Q: Pot folosi ambii viewers simultan?
R: Nu, doar un viewer activ per tab. Dar poți deschide tab-uri separate pe fiecare platform.

---

## Dezvoltare Viitoare

Plan de implementare pentru viitoare versiuni:

- [ ] Ara3D: Suport complet pentru openings (ferestre/uși)
- [ ] Babylon.js: Suport pentru efecte de lumină avansate
- [ ] Ambii: Export la glTF / USD
- [ ] Ambii: Selecție de obiecte și proprietăți
- [ ] Ambii: Raportat și clipping planes pentru secțiuni
- [ ] Ambii: Moduri de culoare (material, thermal, wireframe)

---

## Trebuie să adaug mai mult suport?

Consultă fișierul de instrucțiuni: [copilot-instructions.md](../../.github/copilot-instructions.md)

Pentru detalii despre arhitectura viewerelor, verifica:
- [BabylonViewer.tsx](../components/views/BabylonViewer.tsx)
- [Ara3DViewer.tsx](../components/views/Ara3DViewer.tsx)
