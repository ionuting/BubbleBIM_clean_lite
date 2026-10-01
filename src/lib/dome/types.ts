/**
 * Dome element — shared types.
 *
 * A `dome` is a hub node, like a roof or a room: the axes it is wired to, in
 * edge order, are the BASE CONTOUR. Everything else is derived, at render time,
 * by one pure function (`computeDome`) — no child nodes, no solve/apply cycle.
 *
 * What comes out is three things that are one element:
 *
 *   • a SURFACE — a membrane inflated over the base contour, so the shape is
 *     a bubble on whatever plan the graph gives it, and a hemisphere is only
 *     the special case of a circular base;
 *   • a Voronoi tessellation of that surface, whose edges are the RIBS
 *     (a sweep profile along each edge, standing on the surface) …
 *   • … and whose cells, inset by half a rib, are the GLASS PANELS — each one
 *     flattened onto its best-fit plane, with the deviation reported, because
 *     a Voronoi cell on a curved surface is not planar and glass is.
 */
import type { Pt2 } from '@/lib/geom/plan2d';
import type { Pt3, SweepDiagnostic, SweepProfile, SweepSolid } from '@/lib/sweep/types';

export type { Pt2, Pt3, SweepDiagnostic };

export interface DomeIntent {
  /**
   * Radius of a CIRCULAR base, mm, used when the dome is wired to exactly one
   * axis: that axis is the centre. Zero means the base comes from the contour
   * the anchors draw, which needs three of them.
   *
   * The same rule the sweep follows — the number of anchors IS the choice —
   * and the case that makes a plain hemisphere a two-click element rather
   * than a dozen axes arranged on a circle by hand.
   */
  baseRadiusMm: number;
  /**
   * Round the base contour's corners by this radius, mm. A membrane creases
   * into a sharp corner and the panels there come out as slivers, so this is
   * geometry, not decoration. Ignored on a circular base, which has none.
   */
  baseFilletMm: number;
  /** Apex height above the base level, mm. */
  heightMm: number;
  /**
   * How much the profile bulges. 0 is a paraboloid (a membrane under small
   * pressure); 1 is ellipsoidal — a hemisphere on a circular base of radius
   * `heightMm`; above 1 the flanks steepen and the top flattens, like a balloon.
   */
  bulge: number;
  /** Which storey elevation the base sits at. */
  level: 'bottom' | 'top';
  offsetZMm: number;
  /** Membrane grid divisions along the longer side of the base. */
  resolution: number;
  /** Voronoi cells wanted. The tessellation is deterministic for a given seed. */
  cellCount: number;
  seed: number;
  /** Lloyd relaxation passes: 0 leaves the cells where the seeds fell. */
  relaxIterations: number;
  /** Rib profile — the sweep library's ids and `p_*` params. */
  profileId: string;
  params: Record<string, number>;
  /** Where the guide line passes through the rib profile; 'max' hangs the rib under the skin. */
  anchorY: 'min' | 'mid' | 'max';
  glassThicknessMm: number;
  /** A panel further from its plane than this is flagged. */
  planarityTolMm: number;
  material: string;
  glassMaterial: string;
}

export const DEFAULT_DOME_INTENT: DomeIntent = {
  baseRadiusMm: 0,
  baseFilletMm: 0,
  heightMm: 3000,
  bulge: 1,
  level: 'top',
  offsetZMm: 0,
  resolution: 28,
  cellCount: 40,
  seed: 1,
  relaxIterations: 3,
  profileId: 'rect',
  params: {},
  anchorY: 'max',
  glassThicknessMm: 12,
  planarityTolMm: 10,
  material: 'Otel S235',
  glassMaterial: 'Sticla',
};

/** One rib: a Voronoi edge lifted onto the surface. */
export interface DomeMember {
  /** Stations along the surface, world mm. */
  points: Pt3[];
  /** Unit surface normal at each station — the rib profile's up. */
  normals: Pt3[];
  lengthMm: number;
  /** True for an edge that lies on the base contour — the ring beam. */
  onBase: boolean;
  /**
   * True for an edge on a SEAM: the crease where this surface meets another
   * one at the same height. That is the rim between two bubbles, and the arch
   * around an entrance — the members a cluster adds that a lone dome has not.
   */
  onSeam?: boolean;
}

/** One glass panel: a Voronoi cell flattened onto its best-fit plane. */
export interface DomePanel {
  cell: number;
  /** The panel outline ON the plane, world mm, counter-clockwise seen from outside. */
  outline: Pt3[];
  /** Plane frame: origin at the outline centroid, `normal` pointing outward. */
  origin: Pt3;
  normal: Pt3;
  refDir: Pt3;
  /** The outline in the plane's own (refDir, normal × refDir) coordinates, mm. */
  profile: Pt2[];
  areaMm2: number;
  /** Largest distance of a surface vertex from the fitted plane, mm. */
  deviationMm: number;
  /** Deviation within `planarityTolMm`. */
  planar: boolean;
}

export interface DomeResult {
  intent: DomeIntent;
  /** The base contour in plan, CCW, mm. Null when the graph gives no usable one. */
  base: Pt2[] | null;
  /** How the base was arrived at — the plan and the Inspector both say so. */
  baseKind: 'contour' | 'circle' | 'none';
  baseZMm: number;
  /** Voronoi cells in plan, one per seed, clipped to the base. */
  cells: Pt2[][];
  members: DomeMember[];
  /** Rib solids, ready for `sweepBufferGeometry` with `placed`. */
  memberSolids: SweepSolid[];
  profile: SweepProfile | null;
  placed: Pt2[] | null;
  panels: DomePanel[];
  memberLengthMm: number;
  /** Of `memberLengthMm`, how much runs along seams. */
  seamLengthMm: number;
  memberVolumeMm3: number;
  /** True when another dome (or an entrance) changed what this one owns. */
  clustered: boolean;
  /** Ids of the OTHER dome nodes this one shares a surface with. */
  clusteredWith: string[];
  glassAreaMm2: number;
  /** Panels outside the planarity tolerance. */
  offToleranceCount: number;
  zMinMm: number;
  zMaxMm: number;
  diagnostics: SweepDiagnostic[];
}
