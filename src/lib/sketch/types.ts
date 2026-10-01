/**
 * Sketch element — shared types.
 *
 * A `sketch` is a LEAF element like the sweep, but where a sweep's guide line
 * is dictated by the axis grid, a sketch's outline is dictated by the hand.
 * The points are stored on the node in absolute BIM millimetres, so it needs
 * no anchors — which is the entire point. An auxiliary profile, a one-off
 * plinth, a cornice that follows no axis: none of those can be expressed by
 * connecting bubbles, and all of them are ordinary work.
 *
 * ## One outline, two readings
 *
 * The operation is what decides how the drawn points are read:
 *
 *   extrude — the outline is a closed PROFILE, given a height straight up
 *   sweep   — the outline is an open PATH, with a library profile run along it
 *   none    — it stays a 2D drawing that still carries BIM identity, which is
 *             what a setting-out line or a zone boundary is
 *
 * That is the whole vocabulary. There is no "shape type" property, because the
 * operation already says everything the geometry needs to know.
 *
 * ## The array is one vector, not two modes
 *
 * `count` copies along `(dx, dy, dz)`. "Vertical" and "horizontal" are then the
 * same control — (0,0,dz) stacks it up a facade, (dx,dy,0) runs it along the
 * ground, and anything between is a raking repeat that needs no special case.
 * Copy 0 is the original, so `count = 1` means "no array" and never disappears.
 *
 * ## Levels
 *
 * The outline lives at the storey's own level — `bottom` by default, because
 * a drawn profile is a thing you stand on the floor. `offsetZMm` lifts it from
 * there. This is the same `level` + `offset_z_mm` pair the sweep uses, and it
 * means the two elements answer to the same mental model.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import type { Pt2 } from '@/lib/geom/plan2d';
import type { SweepAnchor, SweepCorners, SweepLevel, SweepPath, SweepSolid } from '@/lib/sweep/types';
import {
  curveOutline, DEFAULT_SHAPE_PARAMS, shapeOutline,
  type CurveMode, type ShapeParams, type SketchShape,
} from './shapes';
import {
  IDENTITY_FRAME, IDENTITY_TRANSFORM, outlineToWorld, resolveSketchFrame,
  type SketchFrame, type SketchTransform,
} from './frame';

export type { Pt2 };

/** What gives the drawn outline a body. */
export type SketchOp = 'none' | 'extrude' | 'sweep';

export type SketchDiagSeverity = 'error' | 'warning' | 'info';

export interface SketchDiagnostic {
  code: string;
  severity: SketchDiagSeverity;
  message: string;
}

/**
 * Where the array's step comes from.
 *
 *   vector — the explicit `(dx, dy, dz)`, in BIM, as always
 *   ref    — `stepMm` along the reference line, needing two ax anchors; with
 *            `fit` the copies are spread evenly between the two anchors and
 *            the step is derived from the count instead
 */
export type SketchArrayAlong = 'vector' | 'ref' | 'path';

/**
 * How a copy along a path is turned.
 *
 *   tangent — it turns with the path, keeping its angle to it: a bench
 *             round a curved kerb, a rib along an arch
 *   fixed   — it only moves: every copy faces the way the original does
 */
export type SketchArrayOrient = 'tangent' | 'fixed';

/** A linear repeat of the finished body. `count` includes the original. */
export interface SketchArray {
  count: number;
  dxMm: number;
  dyMm: number;
  dzMm: number;
  along: SketchArrayAlong;
  /** Step along the reference line, mm — `along: 'ref'` only. */
  stepMm: number;
  /**
   * Spread `count` copies from the first anchor to the second (`ref`), or
   * evenly along the whole path from the start offset (`path`).
   */
  fit: boolean;
  /**
   * `along: 'path'` — the sketch whose outline (curve or polyline) the copies
   * follow. The original is copy 0 and keeps its place relative to the path:
   * drawn 500 off a curved kerb, every copy stands 500 off it. Where the
   * original is ON the path is read off the drawing — its nearest point.
   */
  pathId?: string;
  /** Default 'tangent'. */
  orient?: SketchArrayOrient;
}

export interface SketchIntent {
  /**
   * What the sketch IS. A `rect` or `circle` derives its outline from
   * `shapeParams`, so it stays editable by number and a dragged corner keeps
   * it square; a `poly` owns its points outright.
   */
  shape: SketchShape;
  shapeParams: ShapeParams;
  /**
   * A curve's own definition — its stored points (frame-local, like
   * `localOutline` is for a poly), how they are read and the degree. Null for
   * every other shape. `outline` is then the curve read at a chord tolerance.
   */
  curve: { mode: CurveMode; degree: number; points: Pt2[] } | null;
  /**
   * The outline in play — derived for parametric shapes, stored for a poly.
   *
   * LOCAL to the reference frame as parsed off the node; `computeSketch`
   * replaces it with the BIM outline in its result, which is what every
   * consumer draws, and keeps the drawn one in `localOutline`.
   */
  outline: Pt2[];
  /** The points as stored — frame-local, untransformed. */
  localOutline: Pt2[];
  /** Mirror / rotation / offset relative to the reference frame. */
  ref: SketchTransform;
  /** Closed back to the first point — required by `extrude`. */
  closed: boolean;
  op: SketchOp;

  /** Which storey elevation the outline sits at. */
  level: SweepLevel;
  /** Vertical shift from that level, mm. */
  offsetZMm: number;

  // ── extrude ────────────────────────────────────────────────────────────
  /** Extrusion height, mm. Negative extrudes downwards. */
  heightMm: number;

  // ── sweep ──────────────────────────────────────────────────────────────
  /** Profile id for `op: 'sweep'` — same library the sweep element reads. */
  profileId: string;
  params: Record<string, number>;
  anchorX: SweepAnchor;
  anchorY: SweepAnchor;
  offsetXMm: number;
  rotationDeg: number;
  mirror: boolean;
  corners: SweepCorners;

  // ── array ──────────────────────────────────────────────────────────────
  array: SketchArray;

  // ── face with holes ────────────────────────────────────────────────────
  /**
   * The id of the sketch this one is a HOLE in, or '' for an ordinary sketch.
   *
   * A hole is a closed sketch drawn inside a bigger closed one: it has no body
   * of its own, it is cut out of its host's face — so out of the host's
   * extrusion, out of the host's plan fill, and out of any sweep that takes
   * the host as its profile. It stays a node of its own, so it is edited the
   * way every sketch is and the host follows.
   */
  holeOf: string;

  // ── BIM identity ───────────────────────────────────────────────────────
  /** Explicit IFC entity, or 'auto' to let the operation choose. */
  ifcType: string;
  /** The type key the quantity mapping rules match on. */
  elementType: string;
  material: string;
}

export const DEFAULT_SKETCH_INTENT: SketchIntent = {
  shape: 'poly',
  shapeParams: DEFAULT_SHAPE_PARAMS,
  curve: null,
  outline: [],
  localOutline: [],
  ref: IDENTITY_TRANSFORM,
  closed: true,
  op: 'extrude',
  level: 'bottom',
  offsetZMm: 0,
  heightMm: 1000,
  profileId: 'rect',
  params: {},
  anchorX: 'mid',
  anchorY: 'max',
  offsetXMm: 0,
  rotationDeg: 0,
  mirror: false,
  corners: 'miter',
  array: { count: 1, dxMm: 0, dyMm: 0, dzMm: 0, along: 'vector', stepMm: 0, fit: false, pathId: '', orient: 'tangent' },
  holeOf: '',
  ifcType: 'auto',
  elementType: '',
  material: 'Beton C30/37',
};

/**
 * One array copy, with its OWN elevations.
 *
 * A section has to know these separately: a vertical array spans the whole
 * stack, so drawing each copy between the result's global `zMin` and `zMax`
 * would render every one of them as a single body the height of the lot.
 */
export interface SketchCopy {
  /**
   * Placement from the drawn position: turn by `rotDeg` about `pivot` in
   * plan, then move by (dx, dy, dz), mm. A translation-only array has
   * `rotDeg` 0.
   */
  dxMm: number;
  dyMm: number;
  dzMm: number;
  rotDeg: number;
  pivot: Pt2;
  /** Plan outline(s) of this copy. */
  footprint: Pt2[][];
  /** The holes of each footprint polygon, parallel to `footprint`. */
  footprintHoles: Pt2[][][];
  zMinMm: number;
  zMaxMm: number;
}

export interface SketchResult {
  intent: SketchIntent;
  /** The reference frame the outline was placed in — identity when unwired. */
  frame: SketchFrame;
  /** The profile actually used, in its own plane — null when there is none. */
  placed: Pt2[] | null;
  /** Holes through `placed`, same plane, clockwise — a swept face with voids. */
  profileHoles: Pt2[][];
  /**
   * The guide line, for `op: 'sweep'` only — null otherwise.
   *
   * The IFC writer needs it: ifc-lite writes extruded-area-solids, not meshes,
   * so a swept run has to go out one segment at a time exactly as the sweep
   * element does. An extrusion needs no path — it IS one extrusion.
   */
  path: SweepPath | null;
  solids: SweepSolid[];
  /** Every copy with its own elevations — the original is `copies[0]`. */
  copies: SketchCopy[];
  /** All copies' plan outlines, flattened, for consumers that ignore height. */
  footprint: Pt2[][];
  /** The holes of each `footprint` polygon, parallel to it. */
  footprintHoles: Pt2[][][];
  /**
   * The holes cut out of this face, in BIM mm, CLOCKWISE — the original copy.
   * Empty for a sketch without holes, an open one, and a hole itself.
   */
  holes: Pt2[][];
  /** The hole sketches actually cut, by node id — a rejected one is a diagnostic. */
  holeIds: string[];
  /** Outline length, mm — perimeter when closed, run length when open. Exact for a curve. */
  lengthMm: number;
  /** A curve's stored points in BIM mm — where its handles are. Empty for other shapes. */
  curvePoints: Pt2[];
  /** Every boundary of a closed face — the outline plus each hole's — mm. */
  perimeterMm: number;
  /** Enclosed plan area of a closed outline, holes subtracted, mm². 0 when open. */
  areaMm2: number;
  /** Cross-section area of the swept profile, holes subtracted, mm². 0 for an extrusion. */
  profileAreaMm2: number;
  /** True solid volume of ALL copies, mm³. */
  volumeMm3: number;
  /** Copies actually generated, including the original. */
  count: number;
  zMinMm: number;
  zMaxMm: number;
  diagnostics: SketchDiagnostic[];
}

// ─── Property parsing ────────────────────────────────────────────────────────

const truthy = (v: unknown): boolean => v === true || String(v ?? '').toLowerCase() === 'true';

const num = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * Read an outline off a node property.
 *
 * It survives the round trip through `.bbim` JSON as a real array, but a
 * hand-edited project — or the generic property editor — hands back a string,
 * so both are accepted. A point that is not two finite numbers is dropped
 * rather than poisoning the geometry with NaN downstream.
 */
export function parseOutline(v: unknown): Pt2[] {
  let raw: unknown = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    try {
      raw = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: Pt2[] = [];
  for (const item of raw) {
    let x: unknown, y: unknown;
    if (Array.isArray(item)) {
      [x, y] = item;
    } else if (item && typeof item === 'object') {
      ({ x, y } = item as { x: unknown; y: unknown });
    } else {
      continue;
    }
    const nx = Number(x), ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) out.push({ x: nx, y: ny });
  }
  return out;
}

/**
 * The outline a sketch node describes, in BIM mm, parameters first.
 *
 * Needs the graph to place it: a sketch wired to an ax is stored relative to
 * that ax. Without `nodeMap`/`edges` the frame is taken as the identity —
 * right only for an unwired sketch, so pass them whenever you have them.
 */
export function sketchOutline(
  node: BubbleGraphNode,
  nodeMap?: Map<string, BubbleGraphNode>,
  edges?: BubbleGraphEdge[],
): Pt2[] {
  const intent = parseSketchIntent(node);
  const frame = nodeMap && edges ? resolveSketchFrame(node, nodeMap, edges).frame : IDENTITY_FRAME;
  return outlineToWorld(frame, intent.ref, intent.outline);
}

/** Serialise an outline for storage — compact pairs, rounded to 0.1 mm. */
export function serialiseOutline(pts: Pt2[]): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  return JSON.stringify(pts.map((p) => [r(p.x), r(p.y)]));
}

function parseOp(v: unknown): SketchOp {
  return v === 'sweep' || v === 'none' || v === 'extrude' ? v : DEFAULT_SKETCH_INTENT.op;
}

/** Read a sketch node's properties into an intent. Booleans arrive as 'True'/'False'. */
export function parseSketchIntent(node: BubbleGraphNode): SketchIntent {
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

  const shape: SketchShape = p.shape === 'rect' || p.shape === 'circle' || p.shape === 'curve' ? p.shape : 'poly';
  const closed = p.closed === undefined ? DEFAULT_SKETCH_INTENT.closed : truthy(p.closed);
  const shapeParams: ShapeParams = {
    xMm: num(p.shape_x_mm, 0), yMm: num(p.shape_y_mm, 0),
    wMm: num(p.shape_w_mm, 0), hMm: num(p.shape_h_mm, 0),
    rMm: num(p.shape_r_mm, 0),
  };
  // Parameters are the source of truth; the stored outline is the fallback
  // (a poly, or a parametric shape whose numbers have not been written yet).
  const derived = shapeOutline(shape, shapeParams);
  const stored = parseOutline(p.outline);
  // A curve's stored points are the curve's, not its outline: read them
  // through the curve. Too few for one, and the points stand as drawn.
  const curve = shape === 'curve'
    ? {
      mode: (p.curve_mode === 'control' ? 'control' : 'fit') as CurveMode,
      degree: Math.max(1, Math.min(5, Math.round(num(p.curve_degree, 3)))),
      points: stored,
    }
    : null;
  const curved = curve ? curveOutline(curve.points, closed, curve.mode, curve.degree) : null;
  const outline = curved
    ?? (derived && (shape !== 'rect' || shapeParams.wMm > 0) && (shape !== 'circle' || shapeParams.rMm > 0)
      ? derived
      : stored);

  // A count below 1 would erase the element; the original is always copy 0.
  const count = Math.max(1, Math.round(num(p.array_count, 1)));

  return {
    shape,
    shapeParams,
    curve,
    outline,
    localOutline: outline,
    ref: {
      dxMm: num(p.ref_dx_mm, 0),
      dyMm: num(p.ref_dy_mm, 0),
      rotDeg: num(p.ref_rot_deg, 0),
      mirror: truthy(p.ref_mirror),
    },
    closed,
    op: parseOp(p.op),
    level: p.level === 'top' ? 'top' : 'bottom',
    offsetZMm: num(p.offset_z_mm, 0),
    heightMm: num(p.height_mm, DEFAULT_SKETCH_INTENT.heightMm),
    profileId: String(p.profile ?? DEFAULT_SKETCH_INTENT.profileId),
    params,
    anchorX: anchor(p.anchor_x, DEFAULT_SKETCH_INTENT.anchorX),
    anchorY: anchor(p.anchor_y, DEFAULT_SKETCH_INTENT.anchorY),
    offsetXMm: num(p.offset_x_mm, 0),
    rotationDeg: num(p.rotation_deg, 0),
    mirror: truthy(p.mirror),
    corners: p.corners === 'butt' ? 'butt' : 'miter',
    array: {
      count,
      dxMm: num(p.array_dx_mm, 0),
      dyMm: num(p.array_dy_mm, 0),
      dzMm: num(p.array_dz_mm, 0),
      along: p.array_along === 'ref' || p.array_along === 'path' ? p.array_along : 'vector',
      stepMm: num(p.array_step_mm, 0),
      fit: truthy(p.array_fit),
      pathId: String(p.array_path ?? '').trim(),
      orient: p.array_orient === 'fixed' ? 'fixed' : 'tangent',
    },
    holeOf: String(p.hole_of ?? '').trim(),
    ifcType: String(p.ifc_type ?? DEFAULT_SKETCH_INTENT.ifcType),
    elementType: String(p.element_type ?? ''),
    material: String(p.material ?? DEFAULT_SKETCH_INTENT.material),
  };
}
