/**
 * Sweep element — shared types.
 *
 * A `sweep` is a LEAF element: a 2D profile polygon swept along a guide line
 * that the graph itself defines. Unlike roof/stairwell it generates no child
 * nodes, so there is no solve/apply cycle — geometry and diagnostics come out
 * of one pure function (`computeSweep`) at render time, the way walls do.
 *
 * The guide-line rule is the whole graph contract:
 *   1 anchor  → a VERTICAL line at that point, over the storey band
 *   2 anchors → a HORIZONTAL segment A→B at the chosen level
 *   3+        → a horizontal polyline in edge order, optionally closed
 * The number of connections IS the choice — there is no "path type" property.
 */
import type { BubbleGraphNode } from '@/store';
import type { Pt2 } from '@/lib/geom/plan2d';

export type { Pt2 };
export interface Pt3 extends Pt2 { z: number }

export type SweepAnchor = 'min' | 'mid' | 'max';
export type SweepCorners = 'miter' | 'butt';
export type SweepLevel = 'bottom' | 'top';
export type SweepDiagSeverity = 'error' | 'warning' | 'info';

export interface SweepDiagnostic {
  code: string;
  severity: SweepDiagSeverity;
  message: string;
}

export interface SweepIntent {
  /** Profile id: a parametric id ('rect', 'circle', …), 'cat:<id>', or 'dxf:<typeId>'. */
  profileId: string;
  /** The p_* dimension properties, mm (meaning depends on the profile). */
  params: Record<string, number>;
  /** Which point of the profile bbox the guide line passes through. */
  anchorX: SweepAnchor;
  anchorY: SweepAnchor;
  /** Lateral shift, mm — +s is LEFT of travel (or +X in plan for verticals). */
  offsetXMm: number;
  /** Vertical shift from the chosen storey level, mm. */
  offsetZMm: number;
  /** Profile rotation in its own plane, degrees CCW. */
  rotationDeg: number;
  mirror: boolean;
  corners: SweepCorners;
  /** Close the polyline back to its first point (3+ anchors only). */
  closed: boolean;
  /** Which storey elevation the horizontal path sits at. */
  level: SweepLevel;
  /** Vertical sweeps: explicit height, mm. 0 = full storey band. */
  heightMm: number;
  material: string;
}

export const DEFAULT_SWEEP_INTENT: SweepIntent = {
  profileId: 'rect',
  params: {},
  anchorX: 'mid',
  anchorY: 'max',
  offsetXMm: 0,
  offsetZMm: 0,
  rotationDeg: 0,
  mirror: false,
  corners: 'miter',
  closed: false,
  level: 'top',
  heightMm: 0,
  material: 'Beton C30/37',
};

export type SweepProfileGroup = 'parametric' | 'catalogue' | 'dxf';

export interface SweepProfile {
  id: string;
  label: string;
  group: SweepProfileGroup;
  /** Closed simple polygon, CCW, mm, in the profile's own (x right, y up) plane. */
  polygon: Pt2[];
  /**
   * Present on a DXF profile drawn with `slider_*` layers: the size it was
   * drawn at, and which axes can be stretched. The Inspector offers width and
   * height inputs only for the axes that actually have a slider — an axis
   * without one cannot be resized without distorting the drawing.
   */
  sizing?: {
    defaultWidthMm: number;
    defaultHeightMm: number;
    stretchX: boolean;
    stretchY: boolean;
  };
}

export interface SweepPath {
  /** Vertices in BIM mm. Vertical paths carry exactly two, same x/y. */
  points: Pt3[];
  closed: boolean;
  kind: 'vertical' | 'horizontal';
}

/**
 * One watertight piece of the swept solid: rings of world-space points, one per
 * path station, all with the same vertex count (the placed profile's). A miter
 * run is a single many-ring solid; butt corners split the run into 2-ring
 * prisms. `loop` marks a closed sweep whose last ring welds back to the first
 * (no end caps).
 */
export interface SweepSolid {
  rings: Pt3[][];
  loop: boolean;
}

export interface SweepResult {
  intent: SweepIntent;
  path: SweepPath | null;
  profile: SweepProfile | null;
  /** The profile after mirror → rotate → anchor → offset, CCW. */
  placed: Pt2[] | null;
  solids: SweepSolid[];
  /** Plan outline(s) for the 2D floor plan. */
  footprint: Pt2[][];
  lengthMm: number;
  /** Cross-section area, mm². */
  areaMm2: number;
  /** Cross-section perimeter, mm. */
  perimeterMm: number;
  /** True solid volume from the mesh (miter-aware), mm³. */
  volumeMm3: number;
  zMinMm: number;
  zMaxMm: number;
  diagnostics: SweepDiagnostic[];
}

const truthy = (v: unknown): boolean => v === true || String(v ?? '').toLowerCase() === 'true';
const num = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Read a sweep node's properties into an intent. Booleans arrive as 'True'/'False' strings. */
export function parseSweepIntent(node: BubbleGraphNode): SweepIntent {
  const p = node.properties ?? {};
  const params: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith('p_')) {
      const n = Number(v);
      if (Number.isFinite(n)) params[k] = n;
    }
  }
  const anchor = (v: unknown, d: SweepAnchor): SweepAnchor =>
    v === 'min' || v === 'mid' || v === 'max' ? v : d;
  return {
    profileId: String(p.profile ?? DEFAULT_SWEEP_INTENT.profileId),
    params,
    anchorX: anchor(p.anchor_x, DEFAULT_SWEEP_INTENT.anchorX),
    anchorY: anchor(p.anchor_y, DEFAULT_SWEEP_INTENT.anchorY),
    offsetXMm: num(p.offset_x_mm, 0),
    offsetZMm: num(p.offset_z_mm, 0),
    rotationDeg: num(p.rotation_deg, 0),
    mirror: truthy(p.mirror),
    corners: p.corners === 'butt' ? 'butt' : 'miter',
    closed: truthy(p.closed),
    level: p.level === 'bottom' ? 'bottom' : 'top',
    heightMm: num(p.height_mm, 0),
    material: String(p.material ?? DEFAULT_SWEEP_INTENT.material),
  };
}
