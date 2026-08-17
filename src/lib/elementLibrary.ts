/**
 * elementLibrary.ts — Default geometry library for BubbleGraph BIM elements.
 *
 * Structured parquet-style tables (typed arrays of records) for each BIM
 * element family.  These define the standard catalogue of cross-sections and
 * dimensions used as defaults throughout the application.
 *
 * Units: all dimensional values are in millimetres (mm).
 * Locale: English (shared default for Clean Lite and full app).
 */

// ─── Wall Types ───────────────────────────────────────────────────────────────

export interface WallType {
  id:            string;   // 'W10', 'W15', 'W20', …
  label:         string;
  thickness_mm:  number;
  material:      string;
  fire_rating:   string;   // 'REI 60', …
  description:   string;
}

export const WALL_TYPES: WallType[] = [
  { id: 'W10',  label: 'Wall 10 cm',   thickness_mm:  100, material: 'Gypsum board',  fire_rating: 'REI 30',  description: 'Thin interior gypsum-board wall, 10 cm' },
  { id: 'W12',  label: 'Wall 12.5 cm', thickness_mm:  125, material: 'Gypsum board',  fire_rating: 'REI 30',  description: 'Interior gypsum-board wall, 12.5 cm' },
  { id: 'W15',  label: 'Wall 15 cm',   thickness_mm:  150, material: 'Brick',         fire_rating: 'REI 60',  description: 'Interior brick wall, 15 cm' },
  { id: 'W20',  label: 'Wall 20 cm',   thickness_mm:  200, material: 'Brick',         fire_rating: 'REI 90',  description: 'Structural brick wall, 20 cm' },
  { id: 'W25',  label: 'Wall 25 cm',   thickness_mm:  250, material: 'Brick',         fire_rating: 'REI 120', description: 'Structural brick wall, 25 cm' },
  { id: 'W30',  label: 'Wall 30 cm',   thickness_mm:  300, material: 'Concrete C25/30', fire_rating: 'REI 180', description: 'Structural concrete wall, 30 cm' },
  { id: 'W35',  label: 'Wall 35 cm',   thickness_mm:  350, material: 'Concrete C30/37', fire_rating: 'REI 180', description: 'Exterior concrete wall, 35 cm' },
  { id: 'W40',  label: 'Wall 40 cm',   thickness_mm:  400, material: 'Concrete C30/37', fire_rating: 'REI 240', description: 'Thick exterior concrete wall, 40 cm' },
];

// ─── Beam Types ───────────────────────────────────────────────────────────────

export interface BeamType {
  id:          string;   // 'B20x30', 'B30x60', …
  label:       string;
  width_mm:    number;   // section width (plan dimension)
  height_mm:   number;   // section height (structural depth, vertical)
  material:    string;
  description: string;
}

export const BEAM_TYPES: BeamType[] = [
  { id: 'B20x30',  label: 'Beam 20×30 cm',   width_mm:  200, height_mm:  300, material: 'Concrete C30/37', description: 'Concrete beam 200×300 mm' },
  { id: 'B25x40',  label: 'Beam 25×40 cm',   width_mm:  250, height_mm:  400, material: 'Concrete C30/37', description: 'Concrete beam 250×400 mm' },
  { id: 'B30x50',  label: 'Beam 30×50 cm',   width_mm:  300, height_mm:  500, material: 'Concrete C30/37', description: 'Concrete beam 300×500 mm' },
  { id: 'B30x60',  label: 'Beam 30×60 cm',   width_mm:  300, height_mm:  600, material: 'Concrete C30/37', description: 'Concrete beam 300×600 mm' },
  { id: 'B40x60',  label: 'Beam 40×60 cm',   width_mm:  400, height_mm:  600, material: 'Concrete C30/37', description: 'Concrete beam 400×600 mm' },
  { id: 'B40x80',  label: 'Beam 40×80 cm',   width_mm:  400, height_mm:  800, material: 'Concrete C30/37', description: 'Concrete beam 400×800 mm' },
  { id: 'B50x80',  label: 'Beam 50×80 cm',   width_mm:  500, height_mm:  800, material: 'Concrete C30/37', description: 'Concrete beam 500×800 mm' },
  { id: 'B50x100', label: 'Beam 50×100 cm',  width_mm:  500, height_mm: 1000, material: 'Concrete C30/37', description: 'Concrete beam 500×1000 mm' },
];

// ─── Column Types ─────────────────────────────────────────────────────────────

export interface ColumnType {
  id:          string;   // 'C25x25', 'C30x30', 'CR30', …
  label:       string;
  width_mm:    number;
  depth_mm:    number;
  material:    string;
  description: string;
  shape?:      'rect' | 'circle';  // defaults to 'rect' when absent
}

export const COLUMN_TYPES: ColumnType[] = [
  // ── Rectangular ──────────────────────────────────────────────────────────
  { id: 'C20x20', label: 'Column 20×20 cm', width_mm:  200, depth_mm:  200, material: 'Concrete C25/30', description: 'Concrete column 200×200 mm' },
  { id: 'C25x25', label: 'Column 25×25 cm', width_mm:  250, depth_mm:  250, material: 'Concrete C30/37', description: 'Concrete column 250×250 mm' },
  { id: 'C30x30', label: 'Column 30×30 cm', width_mm:  300, depth_mm:  300, material: 'Concrete C30/37', description: 'Concrete column 300×300 mm' },
  { id: 'C30x50', label: 'Column 30×50 cm', width_mm:  300, depth_mm:  500, material: 'Concrete C30/37', description: 'Rectangular concrete column 300×500 mm' },
  { id: 'C40x40', label: 'Column 40×40 cm', width_mm:  400, depth_mm:  400, material: 'Concrete C35/45', description: 'Concrete column 400×400 mm' },
  { id: 'C45x45', label: 'Column 45×45 cm', width_mm:  450, depth_mm:  450, material: 'Concrete C35/45', description: 'Concrete column 450×450 mm' },
  { id: 'C50x50', label: 'Column 50×50 cm', width_mm:  500, depth_mm:  500, material: 'Concrete C35/45', description: 'Concrete column 500×500 mm' },
  { id: 'C60x60', label: 'Column 60×60 cm', width_mm:  600, depth_mm:  600, material: 'Concrete C35/45', description: 'Concrete column 600×600 mm' },
  // ── Circular (CR{diameter_cm}) ───────────────────────────────────────────
  { id: 'CR20', label: 'Column ∅20 cm',  width_mm:  200, depth_mm:  200, material: 'Concrete C25/30', description: 'Circular concrete column ∅200 mm',  shape: 'circle' },
  { id: 'CR25', label: 'Column ∅25 cm',  width_mm:  250, depth_mm:  250, material: 'Concrete C30/37', description: 'Circular concrete column ∅250 mm',  shape: 'circle' },
  { id: 'CR30', label: 'Column ∅30 cm',  width_mm:  300, depth_mm:  300, material: 'Concrete C30/37', description: 'Circular concrete column ∅300 mm',  shape: 'circle' },
  { id: 'CR40', label: 'Column ∅40 cm',  width_mm:  400, depth_mm:  400, material: 'Concrete C35/45', description: 'Circular concrete column ∅400 mm',  shape: 'circle' },
  { id: 'CR50', label: 'Column ∅50 cm',  width_mm:  500, depth_mm:  500, material: 'Concrete C35/45', description: 'Circular concrete column ∅500 mm',  shape: 'circle' },
  { id: 'CR60', label: 'Column ∅60 cm',  width_mm:  600, depth_mm:  600, material: 'Concrete C35/45', description: 'Circular concrete column ∅600 mm',  shape: 'circle' },
];

// ─── Slab Types ───────────────────────────────────────────────────────────────

export interface SlabType {
  id:            string;   // 'SLAB10', 'SLAB15', …
  label:         string;
  thickness_mm:  number;
  material:      string;
  description:   string;
}

export const SLAB_TYPES: SlabType[] = [
  { id: 'SLAB10', label: 'Slab 10 cm', thickness_mm:  100, material: 'Concrete C25/30', description: 'Concrete slab 100 mm' },
  { id: 'SLAB12', label: 'Slab 12 cm', thickness_mm:  120, material: 'Concrete C25/30', description: 'Concrete slab 120 mm' },
  { id: 'SLAB15', label: 'Slab 15 cm', thickness_mm:  150, material: 'Concrete C25/30', description: 'Concrete slab 150 mm' },
  { id: 'SLAB18', label: 'Slab 18 cm', thickness_mm:  180, material: 'Concrete C30/37', description: 'Concrete slab 180 mm' },
  { id: 'SLAB20', label: 'Slab 20 cm', thickness_mm:  200, material: 'Concrete C30/37', description: 'Concrete slab 200 mm' },
  { id: 'SLAB25', label: 'Slab 25 cm', thickness_mm:  250, material: 'Concrete C30/37', description: 'Concrete slab 250 mm' },
  { id: 'SLAB30', label: 'Slab 30 cm', thickness_mm:  300, material: 'Concrete C35/45', description: 'Concrete slab 300 mm' },
];

// ─── Foundation Types ─────────────────────────────────────────────────────────

export interface FoundationType {
  id:          string;   // 'F60x60x40', …
  label:       string;
  width_mm:    number;
  depth_mm:    number;
  height_mm:   number;   // foundation block height (vertical)
  material:    string;
  description: string;
}

export const FOUNDATION_TYPES: FoundationType[] = [
  { id: 'F60x60x40',   label: 'Footing 60×60×40 cm',   width_mm:  600, depth_mm:  600, height_mm:  400, material: 'Concrete C20/25', description: 'Isolated footing 600×600×400 mm' },
  { id: 'F80x80x50',   label: 'Footing 80×80×50 cm',   width_mm:  800, depth_mm:  800, height_mm:  500, material: 'Concrete C25/30', description: 'Isolated footing 800×800×500 mm' },
  { id: 'F100x100x60', label: 'Footing 100×100×60 cm', width_mm: 1000, depth_mm: 1000, height_mm:  600, material: 'Concrete C25/30', description: 'Isolated footing 1000×1000×600 mm' },
  { id: 'F120x120x60', label: 'Footing 120×120×60 cm', width_mm: 1200, depth_mm: 1200, height_mm:  600, material: 'Concrete C25/30', description: 'Isolated footing 1200×1200×600 mm' },
  { id: 'F150x150x70', label: 'Footing 150×150×70 cm', width_mm: 1500, depth_mm: 1500, height_mm:  700, material: 'Concrete C30/37', description: 'Isolated footing 1500×1500×700 mm' },
];

// ─── Window Types ─────────────────────────────────────────────────────────────
//
// id convention:  W-{STYLE_CODE}-{width_cm}x{height_cm}
// Each entry maps to a folder: library/windows/{style}/{id}/
//   containing: model.step, void.step, top.svg, front.svg, section.svg

export interface WindowType {
  id:             string;   // 'W-FIX-100x120'
  label:          string;
  style:          string;   // 'default' | 'french' | 'gothic' | …
  width_mm:       number;
  height_mm:      number;
  sill_height_mm: number;   // default sill height
  depth_mm:       number;   // wall insertion depth (= wall thickness, overridden at placement)
  opening:        'none' | 'single' | 'double' | 'tilt-turn';
  material:       string;
  description:    string;
  /** Relative path inside the backend library root, e.g. "windows/default/W-FIX-100x120" */
  library_path:   string;
  /**
   * Relative path to the IFC4.3 file inside the backend library root.
   * e.g. "windows/default/W-FIX-90X140-IFC/W-FIX-90X140-IFC.ifc"
   * null = no IFC asset; use procedural geometry instead.
   */
  ifc_path:       string | null;
}

export const WINDOW_TYPES: WindowType[] = [
  // ── default style ──────────────────────────────────────────────────────────
  {
    id: 'W-FIX-60x60',    label: 'Window Fix 60×60 cm',     style: 'default',
    width_mm: 600,  height_mm:  600, sill_height_mm: 1200, depth_mm: 200, opening: 'none',
    material: 'White PVC', description: 'Fixed window 600×600 mm',
    library_path: 'windows/default/W-FIX-60x60',
    ifc_path: null,
  },
  {
    id: 'W-FIX-100x120',  label: 'Window Fix 100×120 cm',   style: 'default',
    width_mm: 1000, height_mm: 1200, sill_height_mm:  900, depth_mm: 200, opening: 'none',
    material: 'White PVC', description: 'Fixed window 1000×1200 mm',
    library_path: 'windows/default/W-FIX-100x120',
    ifc_path: null,
  },
  {
    id: 'W-SNG-80x120',   label: 'Window Single 80×120 cm', style: 'default',
    width_mm:  800, height_mm: 1200, sill_height_mm:  900, depth_mm: 200, opening: 'single',
    material: 'White PVC', description: 'Single casement window 800×1200 mm',
    library_path: 'windows/default/W-SNG-80x120',
    ifc_path: null,
  },
  {
    id: 'W-SNG-100x140',  label: 'Window Single 100×140 cm', style: 'default',
    width_mm: 1000, height_mm: 1400, sill_height_mm:  900, depth_mm: 200, opening: 'single',
    material: 'White PVC', description: 'Single casement window 1000×1400 mm',
    library_path: 'windows/default/W-SNG-100x140',
    ifc_path: null,
  },
  {
    id: 'W-DBL-120x140',  label: 'Window Double 120×140 cm', style: 'default',
    width_mm: 1200, height_mm: 1400, sill_height_mm:  900, depth_mm: 200, opening: 'double',
    material: 'White PVC', description: 'Double casement window 1200×1400 mm',
    library_path: 'windows/default/W-DBL-120x140',
    ifc_path: null,
  },
  {
    id: 'W-DBL-150x150',  label: 'Window Double 150×150 cm', style: 'default',
    width_mm: 1500, height_mm: 1500, sill_height_mm:  900, depth_mm: 200, opening: 'double',
    material: 'White PVC', description: 'Double casement window 1500×1500 mm',
    library_path: 'windows/default/W-DBL-150x150',
    ifc_path: null,
  },
  {
    id: 'W-TT-100x140',   label: 'Window Tilt-Turn 100×140 cm', style: 'default',
    width_mm: 1000, height_mm: 1400, sill_height_mm:  900, depth_mm: 200, opening: 'tilt-turn',
    material: 'White PVC', description: 'Tilt-turn window 1000×1400 mm',
    library_path: 'windows/default/W-TT-100x140',
    ifc_path: null,
  },
  // ── french style ───────────────────────────────────────────────────────────
  {
    id: 'W-FR-DBL-120x220', label: 'French Door-Window 120×220 cm', style: 'french',
    width_mm: 1200, height_mm: 2200, sill_height_mm:    0, depth_mm: 200, opening: 'double',
    material: 'White painted wood', description: 'French door-window 1200×2200 mm, floor to ceiling',
    library_path: 'windows/french/W-FR-DBL-120x220',
    ifc_path: null,
  },
  {
    id: 'W-FR-SNG-80x220',  label: 'French Window Single 80×220 cm', style: 'french',
    width_mm:  800, height_mm: 2200, sill_height_mm:    0, depth_mm: 200, opening: 'single',
    material: 'White painted wood', description: 'Single French window 800×2200 mm',
    library_path: 'windows/french/W-FR-SNG-80x220',
    ifc_path: null,
  },
  // ── gothic style ───────────────────────────────────────────────────────────
  {
    id: 'W-GT-SNG-60x180',  label: 'Gothic Window 60×180 cm', style: 'gothic',
    width_mm:  600, height_mm: 1800, sill_height_mm: 1200, depth_mm: 300, opening: 'none',
    material: 'Stone / Stained glass', description: 'Gothic pointed-arch window 600×1800 mm',
    library_path: 'windows/gothic/W-GT-SNG-60x180',
    ifc_path: null,
  },
  {
    id: 'W-GT-DBL-100x220', label: 'Gothic Window Double 100×220 cm', style: 'gothic',
    width_mm: 1000, height_mm: 2200, sill_height_mm:  900, depth_mm: 300, opening: 'double',
    material: 'Stone / Stained glass', description: 'Double gothic arched window 1000×2200 mm',
    library_path: 'windows/gothic/W-GT-DBL-100x220',
    ifc_path: null,
  },
  // ── IFC-referenced types ───────────────────────────────────────────────────
  {
    id: 'W-FIX-90X140-IFC', label: 'Window Fix 110×263 cm (IFC)', style: 'default',
    width_mm: 1100, height_mm: 2630, sill_height_mm: 0, depth_mm: 200, opening: 'none',
    material: 'White PVC', description: 'Fixed window/frame 1100×2630 mm — referenced IFC geometry',
    library_path: 'windows/default/W-FIX-90X140-IFC',
    ifc_path: 'windows/default/W-FIX-90X140-IFC/W-FIX-90X140-IFC.frag',
  },
];

// ─── Door Types ───────────────────────────────────────────────────────────────
//
// id convention:  D-{STYLE_CODE}-{width_cm}x{height_cm}
// Each entry maps to: library/doors/{style}/{id}/

export interface DoorType {
  id:           string;   // 'D-SWING-90x210'
  label:        string;
  style:        string;   // 'default' | 'french' | 'gothic' | …
  width_mm:     number;
  height_mm:    number;
  depth_mm:     number;   // wall insertion depth
  leaf_count:   1 | 2;
  swing:        'left' | 'right' | 'double' | 'sliding' | 'folding';
  material:     string;
  description:  string;
  library_path: string;
  /**
   * Relative path to the IFC4.3 file inside the backend library root.
   * null = no IFC asset; use procedural geometry instead.
   */
  ifc_path:     string | null;
}

export const DOOR_TYPES: DoorType[] = [
  // ── default style ──────────────────────────────────────────────────────────
  {
    id: 'D-SWING-80x210',  label: 'Door Swing 80×210 cm',  style: 'default',
    width_mm:  800, height_mm: 2100, depth_mm: 200, leaf_count: 1, swing: 'left',
    material: 'Oak wood', description: 'Left-hand swing door 800×2100 mm',
    library_path: 'doors/default/D-SWING-80x210',
    ifc_path: null,
  },
  {
    id: 'D-SWING-90x210',  label: 'Door Swing 90×210 cm',  style: 'default',
    width_mm:  900, height_mm: 2100, depth_mm: 200, leaf_count: 1, swing: 'right',
    material: 'Oak wood', description: 'Right-hand swing door 900×2100 mm',
    library_path: 'doors/default/D-SWING-90x210',
    ifc_path: null,
  },
  {
    id: 'D-DBL-120x210',   label: 'Door Double 120×210 cm', style: 'default',
    width_mm: 1200, height_mm: 2100, depth_mm: 200, leaf_count: 2, swing: 'double',
    material: 'Oak wood', description: 'Double swing door 1200×2100 mm',
    library_path: 'doors/default/D-DBL-120x210',
    ifc_path: null,
  },
  {
    id: 'D-SLD-90x210-IFC', label: 'Door Sliding 90×210 cm (IFC)', style: 'default',
    width_mm:  900, height_mm: 2100, depth_mm: 200, leaf_count: 1, swing: 'sliding',
    material: 'Glass / Aluminium', description: 'Sliding door 900×2100 mm — IFC model',
    library_path: 'doors/default/D-SLD-90x210-IFC',
    ifc_path: 'doors/default/D-SLD-90x210-IFC/D-SLD-90x210-IFC.frag',
  },
  {
    id: 'D-SLD-100x210',   label: 'Door Sliding 100×210 cm', style: 'default',
    width_mm: 1000, height_mm: 2100, depth_mm: 200, leaf_count: 1, swing: 'sliding',
    material: 'Glass / Aluminium', description: 'Sliding door 1000×2100 mm',
    library_path: 'doors/default/D-SLD-100x210',
    ifc_path: null,
  },
  {
    id: 'D-SLD-200x210',   label: 'Door Sliding 200×210 cm', style: 'default',
    width_mm: 2000, height_mm: 2100, depth_mm: 200, leaf_count: 2, swing: 'sliding',
    material: 'Glass / Aluminium', description: 'Double sliding door 2000×2100 mm',
    library_path: 'doors/default/D-SLD-200x210',
    ifc_path: null,
  },
  // ── french style ───────────────────────────────────────────────────────────
  {
    id: 'D-FR-DBL-120x240', label: 'French Door Double 120×240 cm', style: 'french',
    width_mm: 1200, height_mm: 2400, depth_mm: 200, leaf_count: 2, swing: 'double',
    material: 'White painted wood', description: 'Double French door 1200×2400 mm',
    library_path: 'doors/french/D-FR-DBL-120x240',
    ifc_path: null,
  },
  {
    id: 'D-FR-SNG-90x240',  label: 'French Door Single 90×240 cm', style: 'french',
    width_mm:  900, height_mm: 2400, depth_mm: 200, leaf_count: 1, swing: 'right',
    material: 'White painted wood', description: 'Single French door 900×2400 mm',
    library_path: 'doors/french/D-FR-SNG-90x240',
    ifc_path: null,
  },
  // ── gothic style ───────────────────────────────────────────────────────────
  {
    id: 'D-GT-DBL-140x280', label: 'Gothic Door Double 140×280 cm', style: 'gothic',
    width_mm: 1400, height_mm: 2800, depth_mm: 350, leaf_count: 2, swing: 'double',
    material: 'Solid oak / Wrought iron', description: 'Double gothic pointed-arch door 1400×2800 mm',
    library_path: 'doors/gothic/D-GT-DBL-140x280',
    ifc_path: null,
  },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────────

export const WALL_TYPE_MAP       = new Map(WALL_TYPES.map((t)       => [t.id, t]));
export const BEAM_TYPE_MAP       = new Map(BEAM_TYPES.map((t)       => [t.id, t]));
export const COLUMN_TYPE_MAP     = new Map(COLUMN_TYPES.map((t)     => [t.id, t]));
export const SLAB_TYPE_MAP       = new Map(SLAB_TYPES.map((t)       => [t.id, t]));
export const FOUNDATION_TYPE_MAP = new Map(FOUNDATION_TYPES.map((t) => [t.id, t]));
export const WINDOW_TYPE_MAP     = new Map(WINDOW_TYPES.map((t)     => [t.id, t]));
export const DOOR_TYPE_MAP       = new Map(DOOR_TYPES.map((t)       => [t.id, t]));

/** All type tables indexed by BIM element family name. */
export const ELEMENT_LIBRARY = {
  wall:       WALL_TYPES,
  beam:       BEAM_TYPES,
  column:     COLUMN_TYPES,
  slab:       SLAB_TYPES,
  foundation: FOUNDATION_TYPES,
  window:     WINDOW_TYPES,
  door:       DOOR_TYPES,
} as const;
