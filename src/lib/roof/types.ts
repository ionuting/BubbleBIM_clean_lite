/**
 * Roof generation — shared types (envelope + skeleton + framing).
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';

export type RoofType = 'gable' | 'hip' | 'shed' | 'mansard' | 'flat';
export type RoofSystem = 'rafter' | 'purlin' | 'truss';
export type RoofGenerateLevel = 'envelope' | 'skeleton' | 'framing';
export type RidgeDirection = 'auto' | 'x' | 'y';

export interface Pt2 {
  x: number;
  y: number;
}

export interface Pt3 extends Pt2 {
  z: number;
}

/**
 * Optional "detail layers" — each is an opt-in group of generated elements
 * (planar sheets, batten grids, edge trim, caps, drainage, extra structure).
 * Everything defaults OFF so the base assembly is unchanged; the user enables
 * exactly the layers a given project needs from the Roof inspector.
 */
export interface RoofDetailOptions {
  // ── Covering build-up (planar sheets, one per slope face) ──
  membrane: boolean;                 // folie anticondens
  sheathing: boolean;                // astereală / deck
  sheathingThicknessMm: number;
  insulation: boolean;               // termoizolație
  insulationThicknessMm: number;

  // ── Batten grid (linear) ──
  counterBattens: boolean;           // contrașipci (up the slope)
  counterBattenSpacingMm: number;
  counterBattenSection: string;
  battens: boolean;                  // șipci (parallel to eave — tile gauge)
  battenSpacingMm: number;
  battenSection: string;

  // ── Edge trim ──
  fascia: boolean;                   // bordură streașină (vertical board at eaves)
  fasciaHeightMm: number;
  fasciaThicknessMm: number;
  bargeBoard: boolean;               // bordură fronton (along gable rakes)
  soffit: boolean;                   // căptușeală streașină (horizontal underside)

  // ── Ridge / hip / valley finishing ──
  ridgeCaps: boolean;                // coame (capping along ridges)
  ridgeCapWidthMm: number;
  hipCaps: boolean;                  // capping along hips
  valleyFlashing: boolean;           // șorț de dolie
  valleyFlashingWidthMm: number;

  // ── Drainage ──
  gutters: boolean;                  // jgheaburi (round, along eaves)
  gutterDiameterMm: number;
  downpipes: boolean;                // burlane (vertical)
  downpipeSpacingMm: number;
  downpipeDiameterMm: number;
  snowGuards: boolean;               // parazăpezi (short bars along eaves)
  snowGuardSpacingMm: number;

  // ── Extra structure ──
  collarTies: boolean;               // clești (horizontal ties between opposing rafters)
  collarHeightRatio: number;         // 0..1 of the rise where the tie sits
}

export interface RoofIntent {
  roofType: RoofType;
  pitchDeg: number;
  overhangMm: number;
  ridgeDirection: RidgeDirection;
  ridgeOffsetMm: number;
  system: RoofSystem;
  rafterSpacingMm: number;
  rafterSection: string;
  ridgeSection: string;
  postSection: string;
  coveringMaterial: string;
  coveringThicknessMm: number;
  /**
   * Extra VERTICAL raise (mm) of the covering surface, ON TOP of the automatic
   * clearance above the rafters. 0 = covering sits just clear of the rafter
   * tops; positive = raise it further (e.g. thicker batten/air gap).
   */
  coveringOffsetMm: number;
  generateLevel: RoofGenerateLevel;
  thicknessMm: number;
  material: string;
  /** Mansard: pitch of the UPPER (shallow) slope. `pitchDeg` is the lower steep one. */
  upperPitchDeg: number;
  /** Mansard: horizontal inset (mm) from eave to the break line. */
  mansardBreakInsetMm: number;
  /** Truss system: spacing (mm) between full trusses along the ridge. */
  trussSpacingMm: number;
  /** Purlin system: spacing (mm) between purlins up each slope. */
  purlinSpacingMm: number;
  /** Optional generated detail layers (all default off). */
  details: RoofDetailOptions;
}

export interface RoofContour {
  /** Ordered CCW plan polygon in BIM mm (after overhang). */
  points: Pt2[];
  /** Source ax node ids in the same order (may be shorter if derived). */
  axIds: string[];
  /** Elevation of eaves / wall plate (BIM Z mm, absolute). */
  baseZ: number;
  storeyId: string | null;
}

export type SkeletonRole = 'ridge' | 'hip' | 'valley' | 'eave' | 'break';

export interface SkeletonSeg {
  id: string;
  role: SkeletonRole;
  a: Pt3;
  b: Pt3;
}

/** One roof face (water plane) as a 3D polygon, CCW when viewed from above-ish. */
export interface RoofFace3D {
  id: string;
  role: 'slope' | 'gable_end';
  vertices: Pt3[];
}

export type RoofDiagSeverity = 'error' | 'warning' | 'info';

export interface RoofDiagnostic {
  code: string;
  severity: RoofDiagSeverity;
  message: string;
}

export interface RoofSolveInput {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  roofId: string;
  /** Override generate_level on the node for this run. */
  level?: RoofGenerateLevel;
  preserveLocked?: boolean;
}

export interface RoofSolveResult {
  addNodes: BubbleGraphNode[];
  addEdges: BubbleGraphEdge[];
  removeIds: string[];
  updateNodes: BubbleGraphNode[];
  faces: RoofFace3D[];
  skeleton: SkeletonSeg[];
  contour: RoofContour | null;
  diagnostics: RoofDiagnostic[];
}

export const ROOF_GENERATED_TYPES = new Set([
  'roof_ridge',
  'roof_hip',
  'roof_valley',
  'roof_eave',
  'roof_break',
  'rafter',
  'hip_rafter',
  'valley_rafter',
  'ridge_beam',
  'purlin',
  'post',
  'collar_tie',
  'tie_beam',
  'wall_plate',
  // detail layers
  'membrane',
  'sheathing',
  'insulation',
  'counter_batten',
  'batten',
  'fascia',
  'barge_board',
  'soffit',
  'ridge_cap',
  'hip_cap',
  'valley_flashing',
  'gutter',
  'downpipe',
  'snow_guard',
]);

/** Detail element types drawn as extruded timber-like BOXES (section w×h along axis). */
export const ROOF_LINEAR_DETAIL_TYPES = new Set([
  'counter_batten', 'batten', 'fascia', 'barge_board', 'ridge_cap', 'hip_cap', 'snow_guard',
]);
/** Detail element types drawn as ROUND profiles (diameter along axis). */
export const ROOF_ROUND_DETAIL_TYPES = new Set(['gutter', 'downpipe']);
/** Detail element types drawn as planar SHEETS from `face_vertices`. */
export const ROOF_SHEET_DETAIL_TYPES = new Set(['membrane', 'sheathing', 'insulation', 'soffit', 'valley_flashing']);

export const DEFAULT_ROOF_DETAILS: RoofDetailOptions = {
  membrane: false,
  sheathing: false,
  sheathingThicknessMm: 24,
  insulation: false,
  insulationThicknessMm: 200,
  counterBattens: false,
  counterBattenSpacingMm: 600,
  counterBattenSection: 'T4x6',
  battens: false,
  battenSpacingMm: 350,
  battenSection: 'T3x5',
  fascia: false,
  fasciaHeightMm: 200,
  fasciaThicknessMm: 25,
  bargeBoard: false,
  soffit: false,
  ridgeCaps: false,
  ridgeCapWidthMm: 250,
  hipCaps: false,
  valleyFlashing: false,
  valleyFlashingWidthMm: 400,
  gutters: false,
  gutterDiameterMm: 150,
  downpipes: false,
  downpipeSpacingMm: 8000,
  downpipeDiameterMm: 100,
  snowGuards: false,
  snowGuardSpacingMm: 800,
  collarTies: false,
  collarHeightRatio: 0.6,
};

export const DEFAULT_ROOF_INTENT: RoofIntent = {
  roofType: 'gable',
  pitchDeg: 30,
  overhangMm: 400,
  ridgeDirection: 'auto',
  ridgeOffsetMm: 0,
  system: 'rafter',
  rafterSpacingMm: 600,
  rafterSection: 'T8x16',
  ridgeSection: 'T10x20',
  postSection: 'T10x10',
  coveringMaterial: 'Tigla ceramica',
  coveringThicknessMm: 40,
  coveringOffsetMm: 0,
  generateLevel: 'framing',
  thicknessMm: 200,
  material: 'Lemn rasinos',
  upperPitchDeg: 15,
  mansardBreakInsetMm: 1500,
  trussSpacingMm: 3000,
  purlinSpacingMm: 1200,
  details: DEFAULT_ROOF_DETAILS,
};
