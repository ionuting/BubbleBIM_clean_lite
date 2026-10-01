/**
 * Facade element — shared types.
 *
 * A `facade` is a LEAF element like the sweep and the dome: its anchors
 * decide its extent, one pure function decides its geometry.
 *
 *   2 anchors  → ONE vertical face between them
 *   3+ anchors → a polygon of faces, closed by default — a shell
 *
 * Each face is a flat vertical rectangle (length × storey band), and that is
 * why this is the EASY sibling of the dome: the dome tessellates a curved
 * height field and then has to check every panel for planarity; a facade
 * tessellates a plane, so every panel is planar by construction and the
 * whole pattern machinery — grid, staggered, hexagonal, Voronoi — runs in
 * the face's own (a, b) = (along, up) coordinates and is lifted with one
 * affine map.
 *
 * ## What a cell becomes
 *
 * Every cell edge is a MULLION (a rectangular member on the plane); every
 * cell interior is a PANEL. The panel kind is the whole difference between
 * a curtain wall and an office facade with relief:
 *
 *   glass    — a plate of glass, set back by the mullion
 *   solid    — an opaque plate, same geometry
 *   cassette — the cell pushed OUT by `cassetteDepthMm` with a bevel, so the
 *              face reads as profiled boxes — the 3D texture the brief asks for
 *   mixed    — cassette and glass alternating by cell index
 */
import type { BubbleGraphNode } from '@/store';
import type { Pt2 } from '@/lib/geom/plan2d';
import type { Pt3, SweepDiagnostic, SweepSolid } from '@/lib/sweep/types';
import type { DomePanel } from '@/lib/dome/types';

export type { Pt2, Pt3 };

export type FacadePattern = 'grid' | 'stagger' | 'hex' | 'voronoi';
export const FACADE_PATTERNS: FacadePattern[] = ['grid', 'stagger', 'hex', 'voronoi'];
export const FACADE_PATTERN_LABELS: Record<FacadePattern, string> = {
  grid: 'Grilă dreptunghiulară',
  stagger: 'Țesut (rânduri decalate)',
  hex: 'Hexagonal',
  voronoi: 'Voronoi',
};

export type FacadePanelKind = 'glass' | 'solid' | 'cassette' | 'mixed';
export const FACADE_PANEL_KINDS: FacadePanelKind[] = ['glass', 'solid', 'cassette', 'mixed'];
export const FACADE_PANEL_KIND_LABELS: Record<FacadePanelKind, string> = {
  glass: 'Sticlă',
  solid: 'Panou opac',
  cassette: 'Casetă profilată',
  mixed: 'Casete + sticlă, alternat',
};

export interface FacadeIntent {
  pattern: FacadePattern;
  /** Grid / stagger / hex: nominal cell size. Cells are fitted evenly to the face. */
  cellWMm: number;
  cellHMm: number;
  /** Voronoi: seeds per face (0 = from cell size). */
  cellCount: number;
  seed: number;
  relaxIterations: number;
  panelKind: FacadePanelKind;
  mullionWMm: number;
  mullionDMm: number;
  glassThicknessMm: number;
  panelThicknessMm: number;
  cassetteDepthMm: number;
  cassetteBevelMm: number;
  /** Outward shift of the face plane from the axis line, mm. */
  offsetMm: number;
  /** 0 = the storey band; otherwise this height from the bottom. */
  heightMm: number;
  offsetZMm: number;
  /** Swap which side is "outside". */
  flip: boolean;
  /** 3+ anchors: close the polygon (default on). */
  closed: boolean;
  material: string;
  glassMaterial: string;
  panelMaterial: string;
}

export const DEFAULT_FACADE_INTENT: FacadeIntent = {
  pattern: 'grid',
  cellWMm: 1500,
  cellHMm: 1500,
  cellCount: 0,
  seed: 1,
  relaxIterations: 2,
  panelKind: 'glass',
  mullionWMm: 60,
  mullionDMm: 120,
  glassThicknessMm: 24,
  panelThicknessMm: 40,
  cassetteDepthMm: 250,
  cassetteBevelMm: 120,
  offsetMm: 0,
  heightMm: 0,
  offsetZMm: 0,
  flip: false,
  closed: true,
  material: 'Aluminiu',
  glassMaterial: 'Sticla',
  panelMaterial: 'Aluminiu compozit',
};

/** One vertical face of the facade. */
export interface FacadeFace {
  index: number;
  /** Plan endpoints ON the face plane (after the outward offset), mm. */
  a: Pt2;
  b: Pt2;
  /** Unit direction along the face and its outward normal, in plan. */
  u: Pt2;
  n: Pt2;
  lengthMm: number;
  z0: number;
  z1: number;
}

export interface FacadeCell {
  face: number;
  /** In the face's (a = along, b = up) coordinates, CCW seen from outside. */
  poly: Pt2[];
  outline: Pt3[];
  areaMm2: number;
}

/** A cassette: outer ring on the plane, inner ring pushed out, same vertex count. */
export interface FacadeCassette {
  face: number;
  solid: SweepSolid;
  /** The outer ring in the plane's (a, b) frame — for triangulating the caps. */
  placed: Pt2[];
  areaMm2: number;
}

export interface FacadeResult {
  intent: FacadeIntent;
  faces: FacadeFace[];
  cells: FacadeCell[];
  /** Mullions: rectangular members on every cell edge, welded at shared edges. */
  members: SweepSolid[];
  /** The mullion cross-section, for the mesh's caps and the IFC profile. */
  memberProfile: Pt2[];
  memberLengthMm: number;
  memberVolumeMm3: number;
  glassPanels: DomePanel[];
  solidPanels: DomePanel[];
  cassettes: FacadeCassette[];
  glassAreaMm2: number;
  panelAreaMm2: number;
  cassetteAreaMm2: number;
  /** Plan lines for the 2D views, one per face (the face's own thickness applies). */
  footprint: Pt2[][];
  zMinMm: number;
  zMaxMm: number;
  diagnostics: SweepDiagnostic[];
}

const num = (v: unknown, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const truthy = (v: unknown): boolean => v === true || String(v ?? '').toLowerCase() === 'true';

export function parseFacadeIntent(node: BubbleGraphNode): FacadeIntent {
  const p = node.properties ?? {};
  const D = DEFAULT_FACADE_INTENT;
  const pattern = (FACADE_PATTERNS as string[]).includes(String(p.pattern)) ? (p.pattern as FacadePattern) : D.pattern;
  const panelKind = (FACADE_PANEL_KINDS as string[]).includes(String(p.panel_kind)) ? (p.panel_kind as FacadePanelKind) : D.panelKind;
  return {
    pattern,
    cellWMm: Math.max(100, num(p.cell_w_mm, D.cellWMm)),
    cellHMm: Math.max(100, num(p.cell_h_mm, D.cellHMm)),
    cellCount: Math.max(0, Math.round(num(p.cell_count, D.cellCount))),
    seed: Math.round(num(p.seed, D.seed)),
    relaxIterations: Math.max(0, Math.min(10, Math.round(num(p.relax_iterations, D.relaxIterations)))),
    panelKind,
    mullionWMm: Math.max(0, num(p.mullion_w_mm, D.mullionWMm)),
    mullionDMm: Math.max(1, num(p.mullion_d_mm, D.mullionDMm)),
    glassThicknessMm: Math.max(1, num(p.glass_thickness_mm, D.glassThicknessMm)),
    panelThicknessMm: Math.max(1, num(p.panel_thickness_mm, D.panelThicknessMm)),
    cassetteDepthMm: Math.max(0, num(p.cassette_depth_mm, D.cassetteDepthMm)),
    cassetteBevelMm: Math.max(0, num(p.cassette_bevel_mm, D.cassetteBevelMm)),
    offsetMm: num(p.offset_mm, D.offsetMm),
    heightMm: Math.max(0, num(p.height_mm, D.heightMm)),
    offsetZMm: num(p.offset_z_mm, D.offsetZMm),
    flip: truthy(p.flip),
    closed: p.closed === undefined ? D.closed : truthy(p.closed),
    material: String(p.material ?? D.material),
    glassMaterial: String(p.glass_material ?? D.glassMaterial),
    panelMaterial: String(p.panel_material ?? D.panelMaterial),
  };
}
