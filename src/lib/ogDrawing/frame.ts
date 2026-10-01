/**
 * frame.ts — one view frame for all three drawings.
 *
 * A plan, a section and an elevation differ in exactly one thing: where the
 * viewer stands. Everything after that — which solids are cut, which are
 * merely seen, how far each one is from the paper — is the same arithmetic on
 * a different basis. `ogProjection.ts` could not say that, because its
 * `CutFrame` is a plan-space line: `u` runs along it, `v` IS the BIM
 * elevation, and the depth is measured sideways. That hard-wires the vertical,
 * which is exactly what a floor plan does not have.
 *
 * So a `ViewFrame` is the full orthonormal basis in BIM millimetres:
 *
 *   ru — the drawing's horizontal, pointing the viewer's right
 *   rv — the drawing's vertical, pointing up the page
 *   rd — INTO the picture, away from the viewer
 *
 * and a point projects by three dot products. A section frame built from a
 * `CutFrame` reproduces that module's `project()` exactly, term for term —
 * pinned by a test, since a silently mirrored axis is the one bug that still
 * looks like a drawing.
 *
 * ## The sign of depth
 *
 * `depth` is positive INTO the picture and zero on the cut plane. What lies
 * in front of the viewer's plane is negative and is never drawn: in a section
 * you do not see the half of the building you sawed off, and in a plan you do
 * not see the ceiling you cut through. That is one rule for all three views,
 * where the old code needed two.
 */

/** A point or direction in BIM millimetres. */
export interface Vec3 { x: number; y: number; z: number }

/** A projected point: drawing millimetres, plus how far behind the plane it sits. */
export interface UVD { u: number; v: number; depth: number }

/** What a `ViewFrame` is looking at. Only `plan` cuts horizontally. */
export type OgViewKind = 'plan' | 'section' | 'elevation';

export interface ViewFrame {
  kind: OgViewKind;
  /** A point ON the view plane, BIM mm. */
  o: Vec3;
  /** Drawing right, drawing up, and the direction into the picture. Orthonormal. */
  ru: Vec3;
  rv: Vec3;
  rd: Vec3;
  /**
   * How far past the plane an element still shows, mm. `Infinity` keeps the
   * whole of the viewed side — which is what an elevation wants, and what a
   * plan wants below its cut.
   */
  depth: number;
  /** Clip the drawing to `[0, lengthMm]` along `u` — a section marker's range. */
  clip: boolean;
  lengthMm: number;
  /** Vertical limits in BIM Z mm, kept so entity filtering stays one call. */
  elevMin: number;
  elevMax: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Project a BIM point into the frame's drawing coordinates. */
export function projectPt(f: ViewFrame, p: Vec3): UVD {
  const r = sub(p, f.o);
  return { u: dot(r, f.ru), v: dot(r, f.rv), depth: dot(r, f.rd) };
}

/** Just the depth, for the many places that only need to know which side. */
export function depthOf(f: ViewFrame, p: Vec3): number {
  return dot(sub(p, f.o), f.rd);
}

/**
 * The plane of the cut, as a point and a normal pointing INTO the picture.
 * This is what `slice.ts` takes: it does not need to know which view it is.
 */
export function cutPlane(f: ViewFrame): { point: Vec3; normal: Vec3 } {
  return { point: f.o, normal: f.rd };
}

/**
 * The shape of a `CutFrame` from `drawingEngine.ts`, restated so this module
 * depends on nothing. Structural typing makes the real one assignable.
 */
export interface CutFrameLike {
  ax: number; ay: number;
  tx: number; ty: number;
  nx: number; ny: number;
  lengthMm: number;
  clip: boolean;
  depth: number;
}

/**
 * A vertical view — section or elevation — from the plan-space line the
 * engine already built.
 *
 * `rv` is straight up and `o` sits at elevation zero, so `v` comes out as the
 * BIM elevation itself. That is the drawing convention every consumer of
 * `DrawingResult` already assumes; it is not a choice this module is free to
 * make differently.
 */
export function frameFromCut(
  cf: CutFrameLike,
  kind: 'section' | 'elevation' = 'section',
  elevMin = -Infinity,
  elevMax = Infinity,
): ViewFrame {
  return {
    kind,
    o: { x: cf.ax, y: cf.ay, z: 0 },
    ru: { x: cf.tx, y: cf.ty, z: 0 },
    rv: { x: 0, y: 0, z: 1 },
    rd: { x: cf.nx, y: cf.ny, z: 0 },
    depth: cf.depth,
    clip: cf.clip,
    lengthMm: cf.lengthMm,
    elevMin,
    elevMax,
  };
}

/**
 * A floor plan: the viewer above, looking down through a horizontal plane.
 *
 * `u` is BIM east and `v` is BIM north, so the page is the site map everyone
 * draws — north up. Depth runs DOWN from the cut, so a slab under the storey
 * is deep and the underside of the ceiling is shallow, which is the order a
 * plan needs for its painter's sort.
 *
 * `viewDepthMm` is how far below the cut the drawing still shows. A plan
 * normally shows the whole storey under it, so the default is everything down
 * to `elevMin`.
 */
export function planFrame(opts: {
  cutZmm: number;
  viewDepthMm?: number;
  elevMin?: number;
  elevMax?: number;
}): ViewFrame {
  const elevMin = opts.elevMin ?? -Infinity;
  const elevMax = opts.elevMax ?? opts.cutZmm;
  const depth = opts.viewDepthMm !== undefined && Number.isFinite(opts.viewDepthMm)
    ? Math.max(0, opts.viewDepthMm)
    : Infinity;
  return {
    kind: 'plan',
    o: { x: 0, y: 0, z: opts.cutZmm },
    ru: { x: 1, y: 0, z: 0 },
    rv: { x: 0, y: 1, z: 0 },
    rd: { x: 0, y: 0, z: -1 },
    depth,
    clip: false,
    lengthMm: Infinity,
    elevMin,
    elevMax,
  };
}

/** Extent in BIM mm — the same shape `ogProjection.ts` reports for an entity. */
export interface BoxLike {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/** The eight corners of a box, so a frame can be asked about it directly. */
export function boxCorners(b: BoxLike): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.minX, b.maxX]) {
    for (const y of [b.minY, b.maxY]) {
      for (const z of [b.minZ, b.maxZ]) out.push({ x, y, z });
    }
  }
  return out;
}

/** How a box sits against the view plane, in one pass over its corners. */
export interface BoxDepth {
  /** Nearest and furthest depth of the box, mm. Negative is in front of the plane. */
  near: number;
  far: number;
  /** The plane passes through it: it is a CUT element, not a seen one. */
  straddles: boolean;
}

/** A box closer to the plane than this counts as touching it, not crossing it. */
export const PLANE_TOL_MM = 0.5;

export function boxDepth(f: ViewFrame, b: BoxLike): BoxDepth {
  let near = Infinity, far = -Infinity;
  for (const c of boxCorners(b)) {
    const d = depthOf(f, c);
    if (d < near) near = d;
    if (d > far) far = d;
  }
  return { near, far, straddles: near < -PLANE_TOL_MM && far > PLANE_TOL_MM };
}

/** Is this element in the drawing at all, and is it cut or merely seen? */
export type EntityRole = 'cut' | 'seen' | 'out';

/**
 * Which role an element plays in this view.
 *
 * Out of the vertical band, in front of the viewer's plane, or past the view
 * depth — none of those are drawn. What is left either straddles the plane
 * (cut) or stands wholly beyond it (seen).
 *
 * The vertical band is checked in BIM Z for every view kind, including the
 * plan. A plan's band is normally the storey, and it is what keeps the storey
 * above out of the drawing even though it is, strictly, behind the cut.
 */
export function roleOf(f: ViewFrame, b: BoxLike): EntityRole {
  if (b.maxZ < f.elevMin - PLANE_TOL_MM || b.minZ > f.elevMax + PLANE_TOL_MM) return 'out';
  const d = boxDepth(f, b);
  if (d.straddles) return 'cut';
  if (d.far <= PLANE_TOL_MM) return 'out';          // wholly in front of the viewer
  if (d.near > f.depth + 1) return 'out';            // past the view depth
  return 'seen';
}
