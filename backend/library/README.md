# BubbleGraph BIM Element Library

## Folder Structure

```
library/
├── windows/
│   ├── index.json           ← all window styles + catalogue (parquet-style table)
│   ├── default/
│   │   ├── style.json       ← style metadata
│   │   ├── W-FIX-60x60/
│   │   │   ├── model.step   ← full 3D STEP geometry (frame + glass + void as separate solid)
│   │   │   ├── void.step    ← wall void (opening solid to subtract from wall)
│   │   │   ├── top.svg      ← top view (plan section)
│   │   │   ├── front.svg    ← front elevation view
│   │   │   └── section.svg  ← vertical section through window
│   │   ├── W-FIX-100x120/   ← …same structure…
│   │   └── …
│   ├── french/
│   │   ├── style.json
│   │   └── …
│   └── gothic/
│       ├── style.json
│       └── …
└── doors/
    ├── index.json
    ├── default/
    │   ├── style.json
    │   ├── D-SWING-80x210/
    │   │   ├── model.step
    │   │   ├── void.step
    │   │   ├── top.svg
    │   │   ├── front.svg
    │   │   └── section.svg
    │   └── …
    ├── french/
    │   ├── style.json
    │   └── …
    └── gothic/
        ├── style.json
        └── …
```

## File Descriptions

| File | Purpose |
|---|---|
| `index.json` | Full parquet-style catalogue table for the element family (all styles) |
| `style.json` | Style metadata (name, description, era, material palette) |
| `model.step` | ISO-10303 STEP AP214. Contains: frame solid, glass panel, hardware. Void is a separate named solid `VOID`. |
| `void.step` | Standalone wall-opening void solid. Used for boolean subtraction in the 3D model. |
| `top.svg` | Orthographic top view (plan section at mid-height). Origin at bottom-left of bounding box. |
| `front.svg` | Orthographic front elevation. Width = element width, height = element height. |
| `section.svg` | Vertical section cut through mid-width. Shows frame depth, glass thickness, sill. |

## Coordinate Convention (STEP files)

All dimensions in **millimetres (mm)**.  
Origin at bottom-left-front corner of bounding box:  
- X → width (left to right)  
- Y → depth (front to back, into wall)  
- Z → height (upward)

## Adding New Elements

1. Add a row to `windows/index.json` or `doors/index.json`
2. Create the folder `windows/{style}/{id}/`
3. Place the 5 files: `model.step`, `void.step`, `top.svg`, `front.svg`, `section.svg`
4. Run `python scripts/validate_library.py` to confirm the entry is complete
