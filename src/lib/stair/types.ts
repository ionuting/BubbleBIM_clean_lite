/**
 * Stairwell generation — shared types.
 *
 * Mirrors `src/lib/roof/types.ts`: one intent object parsed off the parent node,
 * a solve result that the graph merges, and a set naming every generated child
 * type so a regenerate can clear the previous run.
 *
 * The vocabulary is deliberately the standard one — baseline polyline, flight
 * width, riser count, riser height, tread depth. It is what carpenters use, what
 * IFC uses, and (not by accident) exactly what ArchiCAD's `CreateStairs` takes,
 * so the ArchiCAD push is a unit conversion rather than a translation.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';

/** Straight run, quarter-turn, half-turn, or a spiral around a centre pole. */
export type StairType = 'straight' | 'l_shape' | 'u_shape' | 'spiral';

/** How a turning stair makes its corner: a flat landing, or winder steps that
 *  keep climbing through it (trepte balansate / în evantai). */
export type StairTurnStyle = 'landing' | 'winder';

/** How much geometry to emit — the same escalation the roof uses. */
export type StairGenerateLevel = 'outline' | 'flights' | 'steps';

/** Which way the run turns at its landing, seen walking up. */
export type StairTurn = 'left' | 'right';

export type StairStructure = 'concrete' | 'timber' | 'steel';

export interface Pt2 { x: number; y: number }
export interface Pt3 extends Pt2 { z: number }

export type StairDiagSeverity = 'error' | 'warning' | 'info';

export interface StairDiagnostic {
  code: string;
  severity: StairDiagSeverity;
  message: string;
}

export interface StairIntent {
  stairType: StairType;
  /** Clear width of a flight (mm). For a spiral, the tread's radial width. */
  widthMm: number;
  /** Plan direction of the FIRST flight, degrees CCW from +X. */
  directionDeg: number;
  turn: StairTurn;

  // ── Turning stairs ──
  /** Landing or winder steps at the corner of an L / U stair. */
  turnStyle: StairTurnStyle;
  /** How many winder steps make the turn, when turnStyle is 'winder'. */
  winderCount: number;
  /** Centre-pole radius of a spiral stair (mm). 0 = open centre, no pole. */
  spiralInnerMm: number;
  /** How the spiral is built: stacked wedge steps (prefab segments) or one
   *  monolithic cast — a continuous helical waist with the steps on top. */
  spiralStructure: 'steps' | 'monolithic';

  // ── Step sizing ──
  /** 'auto' solves the riser from the storey height; 'explicit' takes riserMm. */
  sizing: 'auto' | 'explicit';
  /** Preferred riser when solving, or the exact riser when explicit (mm). */
  riserMm: number;
  /** Tread going (mm). 0 = derive from the comfort rule. */
  treadMm: number;

  // ── Landing ──
  /** Landing depth along the run (mm). 0 = use the flight width, which is the
   *  usual rule: a landing is at least as deep as the flight is wide. */
  landingDepthMm: number;

  // ── Construction ──
  structure: StairStructure;
  /** Structural thickness of the waist slab / stringer (mm). */
  thicknessMm: number;
  material: string;

  // ── Optional generated parts ──
  /** Cut a hole in the slab above. */
  genVoid: boolean;
  /** Extra clearance added around the flight when sizing that hole (mm). */
  voidClearanceMm: number;
  genRailing: boolean;
  railingHeightMm: number;
  /** Which edge(s) of each flight carry a railing, seen walking up. */
  railingSide: 'left' | 'right' | 'both';

  // ── Base beam ──
  /** Foundation beam under the first riser — inverted-T section taking the
   *  flight's thrust. Only meaningful for a concrete stair. */
  genBaseBeam: boolean;
  /** Web width (mm) — the stem the flight's foot bears on. */
  baseBeamWebMm: number;
  /** Flange width (mm) — the footing spread at the bottom. */
  baseBeamFlangeMm: number;
  /** Flange height (mm). */
  baseBeamFlangeHMm: number;
  /** Total depth below floor level (mm). */
  baseBeamDepthMm: number;

  generateLevel: StairGenerateLevel;
}

/** One straight run of steps between two levels. */
export interface StairFlight {
  index: number;
  /** Walking-line start and end, at the level of the surface walked on. */
  start: Pt3;
  end: Pt3;
  /** Number of RISERS in this flight. */
  steps: number;
  riserMm: number;
  treadMm: number;
  widthMm: number;
}

/**
 * One winder step: a wedge-shaped tread that climbs while turning. A spiral
 * stair is winders all the way up; a fan turn is winders where a landing would
 * have been.
 */
export interface StairWinder {
  index: number;
  /** Plan polygon of the tread (mm). */
  polygon: Pt2[];
  /** Walking surface elevation (mm, absolute). */
  zTopMm: number;
  riserMm: number;
  /** The leading (nosing) edge, for the 2D symbol. */
  nosing: { a: Pt2; b: Pt2 };
  /** Going measured on the walking line (mm) — what comfort and length use. */
  walkMm: number;
}

/** A level platform between flights. */
export interface StairLanding {
  index: number;
  /** CCW plan polygon (mm). */
  polygon: Pt2[];
  /** Walking surface elevation (mm, absolute). */
  levelMm: number;
  thicknessMm: number;
}

/**
 * The solved stair: everything downstream (3D, 2D, ArchiCAD, quantities) reads
 * this rather than re-deriving geometry from the node's properties.
 */
export interface StairGeometry {
  flights: StairFlight[];
  landings: StairLanding[];
  /** Winder steps — the whole stair for a spiral, the corner for a fan turn. */
  winders: StairWinder[];
  /** Set only for a spiral: centre, radii and sweep, for the pole, the plan
   *  and the monolithic helix. */
  spiral: {
    center: Pt2;
    innerMm: number;
    outerMm: number;
    /** Angle of the walking-line start, radians CCW from +X. */
    startRad: number;
    /** Signed sweep per riser, radians. */
    deltaRad: number;
  } | null;
  /** The walking-line polyline, bottom to top — the ArchiCAD baseline. */
  baseline: Pt3[];
  /** Plan outline of the whole stairwell, for the void and the 2D symbol. */
  footprint: Pt2[];
  /**
   * The shaft the stair was fitted into, when one is wired in the graph.
   * Null means the stair was positioned from the node alone.
   */
  boundary: Pt2[] | null;
  /** Elevation walked from and to (mm, absolute). */
  bottomZMm: number;
  topZMm: number;
  /** Solved step sizing, shared by every flight. */
  steps: number;
  riserMm: number;
  treadMm: number;
}

export interface StairSolveInput {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  stairwellId: string;
  /** Override generate_level on the node for this run. */
  level?: StairGenerateLevel;
}

export interface StairSolveResult {
  addNodes: BubbleGraphNode[];
  addEdges: BubbleGraphEdge[];
  removeIds: string[];
  updateNodes: BubbleGraphNode[];
  geometry: StairGeometry | null;
  diagnostics: StairDiagnostic[];
}

/**
 * Everything the stairwell owns. A regenerate deletes every node of these types
 * that points back at the stairwell, then rebuilds — without this the model
 * doubles on every run.
 *
 * `void` is deliberately included: the slab opening is a plain `void` node so
 * the existing boolean-subtraction path in bimGeometry handles it, but it is
 * still ours to clear.
 */
export const STAIR_GENERATED_TYPES = new Set([
  'stair_flight',
  'stair_landing',
  'stair_tread',
  'stair_railing',
  'stair_base_beam',
  'stair_winder',
  'stair_column',
  'stair_helix',
  'void',
]);

/**
 * Design limits for step sizing, in mm.
 *
 * These are the values commonly used for residential stairs, NOT a citation
 * from a specific normative — they are collected here, and overridable, so the
 * numbers that govern the model are reviewable in one place rather than spread
 * through the solver. Confirm them against the norm that applies to a given
 * project before relying on the diagnostics.
 */
export const STAIR_LIMITS = {
  riserMin: 150,
  riserMax: 175,
  treadMin: 250,
  treadMax: 320,
  /** Comfort rule 2h + g. */
  comfortMin: 600,
  comfortMax: 645,
  /** Preferred value when the tread is derived rather than given. */
  comfortTarget: 630,
  /** Clear height under whatever is above the walking line. */
  headroomMin: 2000,
  widthMin: 900,
  /** A flight shorter than this reads as a step, not a flight. */
  stepsPerFlightMin: 3,
} as const;

export const DEFAULT_STAIR_INTENT: StairIntent = {
  stairType: 'straight',
  widthMm: 1000,
  directionDeg: 0,
  turn: 'left',
  turnStyle: 'landing',
  winderCount: 3,
  spiralInnerMm: 100,
  spiralStructure: 'steps',
  sizing: 'auto',
  riserMm: 170,
  treadMm: 0,
  landingDepthMm: 0,
  structure: 'concrete',
  thicknessMm: 150,
  material: 'concrete_reinforced',
  genVoid: true,
  voidClearanceMm: 50,
  genRailing: false,
  railingHeightMm: 900,
  railingSide: 'both',
  // Base-beam sizes are the usual residential ones, NOT calculated — like
  // STAIR_LIMITS, confirm them against the project's structural design.
  genBaseBeam: true,
  baseBeamWebMm: 300,
  baseBeamFlangeMm: 600,
  baseBeamFlangeHMm: 150,
  baseBeamDepthMm: 400,
  generateLevel: 'flights',
};
