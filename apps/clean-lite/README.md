# BubbleBIM Clean Lite

Curated app shell with **BubbleBIM Professional** UI — one OpenGeometry 3D viewer plus drawings, sheets, and site views.

**Locale: English** — UI chrome, element library, and material catalogue are English-first.

## UI / UX (BubbleBIM Professional)

- Calm charcoal chrome, teal-steel accent, IBM Plex Sans — dark by default
- Theme toggle (Sun/Moon) persists in `localStorage`
- **Navigator** zones: Project · Views · **Sheets**
- Contextual **ribbon** by view type (Lucide icons)
- **Plan** = primary spatial work · **Model** (graph) = relations · **3D** = verify
- Docked **Inspector** (properties) on the right
- Bottom **status bar** (project, view, storey, selection, save)
- Decluttered header (no Board / BIMx / Chat)

## Included

| Area | Implementation |
|------|----------------|
| Graph editor | BubbleGraphPanel (storeys, nodes, edges) — tab label **Model** |
| 3D | **OpenGeometry only** |
| Floor plans | SVG `FloorPlan2DViewer` |
| Sections / elevations | SVG `Section2DViewer` / `Elevation2DViewer` |
| Sheets | SheetComposer |
| World + Terrain | Cesium `WorldViewer` / Babylon `TerrainViewer` |
| Materials | Builtin EN catalogue (`useMaterialConfig.lite` + localStorage) |
| Element library | English descriptions / material names |

## Commands

```bash
# from repo root
pnpm dev:clean      # http://localhost:3103
pnpm build:clean    # → dist-clean-lite/
pnpm preview:clean
```

Theme: `apps/clean-lite/clean-theme.css` (scoped under `.ac-shell`).
Persistence uses FastAPI with JWT accounts and per-user projects (`api.cloud`).
Local materials catalogue remains EN (`useMaterialConfig.lite`).
