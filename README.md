# BubbleBIM Clean Lite

A graph-driven BIM authoring tool: model a building as a **bubble graph** (storeys → axes →
walls/rooms/openings), then generate 2D drawings, a structural FEM model, IFC exports and print
sheets from that single source of truth.

This repository is the **Clean** profile — a curated build of the BubbleBIM app shell with one
OpenGeometry 3D viewer, the SVG drawing stack, sheets, and cloud (multi-user) persistence.
Redundant engines and duplicate 2D paths are stubbed out of the bundle.

**Stack:** React 18 + TypeScript + Vite + Tailwind CSS · FastAPI + SQLite

---

## Quick start

```bash
pnpm install

# 1) Backend (FastAPI + SQLite, serves /api)
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn main:app --port 8000

# 2) Frontend (in another shell, from the repo root)
VITE_API_URL=http://localhost:8000/api pnpm dev:clean   # → http://localhost:3103
```

Sign in with the seeded admin account (`ADMIN_USERNAME` / `ADMIN_PASSWORD`, default
`admin` / `admin123` — **change these before deploying**), create a project, and start modelling.

```bash
pnpm build:clean     # → dist-clean-lite/
pnpm preview:clean
```

---

## What's in this profile

| Area | Implementation |
|---|---|
| Graph editor | `BubbleGraphPanel` — storeys, axes, nodes, edges (tab: **Model**) |
| 3D | **OpenGeometry** only |
| Floor plans | SVG `FloorPlan2DViewer` (annotations, rebar, roof plan, custom symbols) |
| Sections / elevations | SVG `Section2DViewer` / `Elevation2DViewer` via `src/lib/drawingEngine.ts` |
| **Structural (FEM)** | Linear-elastic frame + shell model on `@awatif/components` — see below |
| IFC export | Real IFC4 STEP via `@ifc-lite/create` |
| Sheets | `SheetComposer` |
| World + Terrain | Cesium `WorldViewer` / Babylon `TerrainViewer` |
| Versioning | Undo/redo + a git-like per-project commit history |
| Persistence | FastAPI + JWT accounts, per-user projects |

**Not** in this profile: Ara3D/Three.js 3D, WebIfc / That Open, IFC Tiles, IFC Plan, OG 2D views,
Composer, Armare 2D (rebar configurator), and the Romanian quantities/norms modules — all stubbed
via aliases in `apps/clean-lite/vite.config.ts`.

---

## Structural (FEM)

Navigator → **Structural**. Builds a linear-elastic model from the graph and solves it:

- **Elements** — columns (`ax` nodes with `has_column`, or standalone `column` nodes), beams
  between column tops, walls and slabs as 3-node shell elements.
- **Whole building or single storey** — "Whole building" stacks every storey at its real
  elevation, with columns continuous storey-to-storey (matched geometrically by plan position,
  since each storey owns its own independent nodes).
- **Loads** — self-weight everywhere, plus a per-room imposed load from the room's usage category
  (SR EN 1991-1-1 / Eurocode 1: residential, office, assembly, storage, …), set on the room's
  **Live Load** property.
- **Results** — deformed shape (auto-scaled), support reactions, max displacement.

Scope is deliberately narrow — no wind, no load combinations, no code checking. See
`.claude/skills/fem-module/SKILL.md` for the design notes and the non-obvious gotchas.

---

## Versioning

Two independent layers:

- **Undo/redo** (`Ctrl+Z` / `Ctrl+Shift+Z`) — in-memory, coalesced so a drag is one step.
- **Version history** (🕐 in the header) — a git-like commit log per project, stored
  content-addressably so identical states are never duplicated on disk. Named checkpoints,
  auto-saves, node-level diffs between any two commits, comments on any version, and restore.
  A restore *appends* a new commit rather than rewriting history, so it can never destroy anything.

---

## Layout

```
src/
  components/bubble-graph/   graph editor, navigator, ribbon, panels
  components/views/          2D viewers (plan/section/elevation), 3D, FEM viewer
  lib/bimGeometry.ts         shared BIM geometry (mm; X=East, Y=North, Z=Up)
  lib/drawingEngine.ts       shared section + elevation geometry
  lib/fem/                   FEM model builder, sections, loads, solver glue
  lib/ifc/                   bubble-graph → IFC4 STEP
  stubs/                     inert replacements for modules excluded from this build
apps/clean-lite/             entry point, theme, and the alias map that defines the profile
backend/                     FastAPI: projects, auth, version history, IFC/geometry helpers
deploy/                      Docker Compose + nginx for a server deploy
```

## Tests

```bash
pnpm vitest run                                              # frontend
cd backend && .venv/bin/python -m unittest discover -p 'test_*.py'
```

---

## Optional: nature assets

The World/Terrain viewers can place stylized trees, served by the backend from an
`Ultimate Stylized Nature/` folder at the repo root. That's a **third-party CC0 asset pack by
[Quaternius](https://quaternius.com/)** (~450 MB) and is not redistributed here — download it
separately if you want the vegetation. Everything else works without it.

## License

[MPL-2.0](LICENSE). Third-party dependencies keep their own licenses.
