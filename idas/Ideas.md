# Implementation Log

| # | Idea | Status | Date | Notes |
|---|------|--------|------|-------|
| 1 | Multi-select nodes in Graph Editor | ✅ Done | 2026-04-28 | Ctrl+click toggles node in multi-selection; teal rings on canvas; bulk property panel auto-activates |
| 2 | Selection priority (nodes > edges) | ✅ Done | 2026-04-28 | Node hit-test now runs before edge hit-test in handleMouseDown |
| 3 | Wall node windows/doors config | ✅ Done | 2026-04-28 | `has_windows`/`has_doors` toggles on wall panel; inline entry list (type, w, h, sill, offset, swing); 🪟/🚪 badges on canvas; `collectOpenings()` in bimGeometry.ts now synthesizes virtual nodes from inline JSON → full pipeline (CSG cuts, 3D models, IFC lookup, flip props) works identically to dedicated nodes in all viewers (Ara3D, WebIfc, Babylon, Section, Elevation, TechnicalDrawings, FloorPlan2D) |
| 4 | Formulas inside parameters | ✅ Done | 2026-04-28 | `FormulaInput` replaces `NumInput`: accepts `1000*3`, `PI*200`, `sqrt(2)*500`; amber highlight when formula active; Array section on all non-storey/ax nodes: list `[0,3000,6000]` or range `{0..18000..6000}`; `expandArrayNodes()` expands into virtual copies in all viewers (3D + 2D); amber badge with instance count on canvas |
| 5 | Void node (boolean cut) | ✅ Done | — | Box + cylinder shapes; connects to host via edge; CSG subtract in Ara3DViewer (three-bvh-csg), ghost wireframe in BabylonViewer, dashed overlay in 2D plan |
| 6 | Procedural family generator | 🔲 Pending | — | |
| 8 | Bi-directional BIM authoring | 🔲 Pending | — | |
| 9 | 2D annotation layer (dims, text, hatches) | ✅ Done | — | Text, linear dim, leader, line, arc, polyline, hatch; SVG annotation layer in FloorPlan2DViewer + TechnicalDrawingsViewer; snap to axes + column nodes; persisted in graph JSON |
| 10 | Extending 2D symbols generator | ✅ Done | 2026-04-28 | `SymbolConfigPanel`: per-element-type section fill/hatch (none, solid, diagonal, crosshatch, brick, stone, concrete, wave), fill color/opacity, line color/weight/style (solid, dashed, dotted, dash-dot), 3D color+opacity; live SVG cross-section preview; auto-saves via PUT /api/material-config with 1.2 s debounce; accessible via 🔷 Symbols toolbar button |
| 11 | Extending 3D library (GLB + JSON/YAML) | ✅ Done | 2026-04-28 | YAML catalog (`backend/library/objects/library.yaml`, 18+ entries in 4 categories); `@babylonjs/loaders/glTF` GLB import; placeholder-box-then-async-GLB pattern in BabylonViewer; plan bbox+cross symbol in FloorPlan2DViewer; `useObjectLibrary` hook with module-level cache; `ObjectLibraryPanel` with category filter, text search, GLB upload, "+Place" → inserts `object` node into graph; GLB upload endpoint `POST /api/library/objects/upload`; panel accessible via 📦 Library toolbar button |
| 12 | Room node as polygon in graph canvas | ✅ Done | 2026-04-28 | Room nodes render as filled dashed polygon in graph canvas (Pattern A: direct ax/column connections; Pattern B: wall adjacency topology matching calcRoomPolygon); individual color via properties.color; consistent in graph/2D/3D; edges suppressed; centroid shows name + area m²; hit-test via ray-casting |

---

# Multi-select nodes in Graph Editor
Should be able to ctrl+select multiple nodes in Graph editor

# Selection priority
The nodes should be the priority when selected, then the edges

# Should extend wall nodes to include also
Config setups for windows and doors with the same exact functionality as the native nodes
- has windows - false default
Under it all the windows config, as well as in the native node;

- has doors - false default
Under it all the doors config, as well as in the native node;

Should have in UI some extra simbols asociated with the wall node that shows it has also windows and doors configed inside on true (window simbol + door simbol)

# Formulas inside the parameters for arraying multiple objects on plan axes or vertical

# Add-ing a void node that has the function to cut with it's geometry the nodes it connects to

# Add procedural family generator from graphs (graph → reusable parametric families)
This can extend from simple objects like windows, doors, balconies, furniture - to full furnished rooms - and use the axes nodes as connections/insertion points
Should be like Invetor parts and assembly but for graphs.
Should be able to have the insertion point (local coordinates for the object)
Should have the 3 planes for reference.
Should be easy to create dimensional parameters that can be used in formulas.
Should probably use the bbim fileformat to store it into a library folder.
The "family" engine should be in 3D space - and probably should allow using external geometry reference like glb/gltf and configure 2D simbols in svg or internal drawings.
Should have a build in method to be registered with the aplication - like as simple as being in a certaing folder inside the app install directory and a load library for external libraries. 
Should probably create a separate module for it? And a library inside the aplication to store the results. 
An UI place to preview and load objects from the library. Modern looking. Grouped by category.
This should be easy to extend and configure by default. Using the graph editor and some sort of extra UI helper like Miro - low code implementation? This should be a powerfull and flexible automation tools for generating full parametric BIM geometry + data.
Procedural roofs - for simple version should have a way to generate roofs using straigh skeleton techniques or others - but this should be a s

# Bi-directional BIM authoring
The graphs, the plans, Sections  and elevations as editable sketches (2D → 3D parametric update) 

# Adding suport for dimensions, text, labels on 2D plans, sections and elevations
Maybe using the cutting plane as also a svg writeble plane on top of it, with a way to snapp to different points, edges
Alos hatches/paterns could be a good idea - drawing simbols, lines, polilines, arches, poligons, as overlay on top of the 2D generated geometry from 3D model representation.

# Extending the 2D symbols generator and making it as user friendly as possible

# Extending the 3D library - should probably use glb + json or yalm for it, not IFC - if it is possible to make it into frag if needed - ask the AI assistant

# nodul de room ar putea fi schimbat in UI ca mod de afisare - sa nu mai vedem node - edge - target ci sa construim un poligon/polilinie inchisa care sa reflecte exact conturul camerei care este descrisa de relatia cu peretii sau cu axis nodes. Asa curatam vizual graph-ul si este mai user friendly de citit graph-ul si sa identificam forma camerelor si eventuale alte tagg-uri pe care le putem adauga (nume, arie)

# Worksheets with scalable viewports 
Think about ArchiCAD or Revit layout generators. 
We should be able to import 2D views and 3D into a standard or custom layout paper space
Scale the views.
redefine edges of the views inside the layout generator
The linethickesses inside the views should adapt with the scale - so we have consistent, profesional looking drawings

# utilizatorul sa poata desena noi pereti facand snap la puncte de pe axele existente in plan view
as vrea sa extindem posibilitatea de authoring bidirectional - incepand din planurile 2D. planul sursa fiind cel de la baza storey-ului - utilizatorul sa poata desena noi pereti facand snap la puncte de pe axele existente in plan view. punctele de snap find mijlocul distantei interax deocamdata, si vom folosi offseturile si transformarile pentru a stabili pozitia finala. De asemenea, in graph, as vrea sa putem face snapp pe mijlocul edge-urilor (midpoint)