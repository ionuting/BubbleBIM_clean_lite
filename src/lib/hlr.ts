/**
 * hlr.ts — hidden-line removal in drawing space.
 *
 * The kernel gives exact projected edges but hides nothing behind anything
 * (measured — see `ogProjection.ts`), and the engine's painter's sort hides
 * things only where an opaque fill happens to cover them, which in a section
 * is nowhere. So this does the part neither does: given the projected faces
 * of everything in the view, cut each line where something nearer covers it.
 *
 * Everything here is 2D plus a depth, and pure. The projection is orthographic,
 * which is what makes it simple: a planar face's depth over the drawing is an
 * AFFINE function of (u, v), so "is this face nearer than that line here" is
 * one subtraction, and a face needs no per-point ray cast.
 *
 * ## The rule
 *
 * A point of a line is hidden when some face contains it in plan AND is
 * nearer by more than `DEPTH_EPS_MM`. The epsilon is what makes a surface not
 * hide the edges lying ON it: a wall's own face is exactly as deep as the
 * wall's own outline there, and two walls meeting flush are coplanar. One
 * millimetre at building scale is below anything a drawing shows and above
 * the noise of a boolean.
 *
 * A point exactly ON a face's boundary falls the way crossing-number
 * containment always falls: the bottom and left edges count as inside, the
 * top and right as outside. So a line running exactly along an occluder's
 * top edge survives and one along its bottom edge does not. Left as it is on
 * purpose — either way the line lies exactly under that edge of the
 * occluder's own silhouette, which is drawn there anyway, so the two
 * coincide on paper and the tie has no visible answer to get right.
 *
 * ## Why splitting at every crossing is enough
 *
 * Between two consecutive crossings, neither which faces cover the line nor
 * which of them are nearer than it changes — so one test at the middle of an
 * interval decides the whole interval. That is the algorithm: collect the
 * crossings, test each interval once, join what survives.
 *
 * There are two kinds of crossing and BOTH are needed. A line crosses a
 * face's boundary in plan — that one is obvious. It also crosses the face in
 * DEPTH, passing from in front of it to behind, without touching its
 * boundary at all: a wall receding from the viewer slides under a face that
 * spans the whole drawing. Both the line's depth and the face's are affine in
 * the parameter, so that crossing is one division, not a search.
 */

/** A point in drawing space: `u` across, `v` up, both mm. */
export interface UV { u: number; v: number }

/**
 * One planar face, projected.
 *
 * `rings[0]` is the outer boundary and the rest are holes; containment is
 * even-odd across all of them, so a hole is a hole with no separate case.
 */
export interface FacePlane {
  rings: UV[][];
  /** Depth = `du·u + dv·v + d0`, mm from the view plane; larger is further. */
  du: number;
  dv: number;
  d0: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

/** A line to draw, with the depth of each end. Depth runs linearly between them. */
export interface HlrLine {
  a: UV;
  b: UV;
  depthA: number;
  depthB: number;
}

/** What survives: the same line, cut to the stretch that is actually seen. */
export interface HlrPiece<T> {
  line: T;
  a: UV;
  b: UV;
}

/**
 * How much nearer a face must be to hide a line. Below this the two are the
 * same surface: a solid's own face under its own outline, or two elements
 * built flush.
 */
export const DEPTH_EPS_MM = 1;

/** A line shorter than this has nothing left to draw. */
const MIN_PIECE_MM = 0.05;

/** Parameters closer than this along a line are the same crossing. */
const PARAM_EPS = 1e-7;

export const faceDepthAt = (f: FacePlane, u: number, v: number): number => f.du * u + f.dv * v + f.d0;

/**
 * The plane of a face whose projected ring carries a depth per vertex.
 *
 * Fits `depth = du·u + dv·v + d0` through three points of the ring that are
 * not collinear in plan. A face seen edge-on has no such triple — it covers
 * no area and cannot hide anything — so it comes back null.
 */
export function facePlaneFrom(rings: { u: number; v: number; depth: number }[][]): FacePlane | null {
  const outer = rings[0];
  if (!outer || outer.length < 3) return null;

  const p0 = outer[0];
  let du = 0, dv = 0, ok = false;
  // The largest cross product gives the best-conditioned fit; a ring can
  // start with two nearly-coincident points and the third would be useless.
  let best = 0;
  for (let i = 1; i < outer.length - 1; i++) {
    for (let j = i + 1; j < outer.length; j++) {
      const ax = outer[i].u - p0.u, ay = outer[i].v - p0.v;
      const bx = outer[j].u - p0.u, by = outer[j].v - p0.v;
      const det = ax * by - ay * bx;
      if (Math.abs(det) <= best) continue;
      const az = outer[i].depth - p0.depth, bz = outer[j].depth - p0.depth;
      du = (az * by - ay * bz) / det;
      dv = (ax * bz - az * bx) / det;
      best = Math.abs(det);
      ok = true;
    }
  }
  if (!ok || best < 1e-6) return null;

  const d0 = p0.depth - du * p0.u - dv * p0.v;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  const flat: UV[][] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const out: UV[] = [];
    for (const p of ring) {
      out.push({ u: p.u, v: p.v });
      if (p.u < uMin) uMin = p.u;
      if (p.u > uMax) uMax = p.u;
      if (p.v < vMin) vMin = p.v;
      if (p.v > vMax) vMax = p.v;
    }
    flat.push(out);
  }
  if (flat.length === 0) return null;
  return { rings: flat, du, dv, d0, uMin, uMax, vMin, vMax };
}

/** Even-odd containment across every ring, so holes are holes. */
export function insideFace(f: FacePlane, u: number, v: number): boolean {
  if (u < f.uMin || u > f.uMax || v < f.vMin || v > f.vMax) return false;
  let inside = false;
  for (const ring of f.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      if ((a.v > v) !== (b.v > v)) {
        const t = (v - a.v) / (b.v - a.v);
        if (u < a.u + t * (b.u - a.u)) inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * The parameter where the line's depth equals the face's, if it happens
 * strictly along the line. Both depths are affine in the parameter, so this
 * is one division; parallel depths (a line level with the face) never cross.
 */
function depthCrossing(line: HlrLine, f: FacePlane, out: number[]): void {
  const { a, b } = line;
  const A = faceDepthAt(f, a.u, a.v);
  const B = faceDepthAt(f, b.u, b.v) - A;
  const D = line.depthB - line.depthA;
  const den = D - B;
  if (Math.abs(den) < 1e-12) return;
  const t = (A - line.depthA) / den;
  if (t > PARAM_EPS && t < 1 - PARAM_EPS) out.push(t);
}

/** Every parameter along a→b where it crosses a ring edge of `f`. */
function crossings(a: UV, b: UV, f: FacePlane, out: number[]): void {
  const dx = b.u - a.u, dy = b.v - a.v;
  for (const ring of f.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p = ring[j], q = ring[i];
      const ex = q.u - p.u, ey = q.v - p.v;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue; // parallel: no crossing to record
      const t = ((p.u - a.u) * ey - (p.v - a.v) * ex) / den;
      if (t <= PARAM_EPS || t >= 1 - PARAM_EPS) continue;
      const s = ((p.u - a.u) * dy - (p.v - a.v) * dx) / den;
      if (s < -PARAM_EPS || s > 1 + PARAM_EPS) continue;
      out.push(t);
    }
  }
}

/**
 * Cut every line back to what is actually seen.
 *
 * `faces` is everything solid in the view, including the lines' own solids:
 * a face level with a line does not hide it (that is what the epsilon is
 * for), while a nearer part of the same solid does — which is how a line
 * hidden by its own element's far wing comes out right.
 */
export function hideOccluded<T extends HlrLine>(
  lines: T[],
  faces: FacePlane[],
  epsMm: number = DEPTH_EPS_MM,
): HlrPiece<T>[] {
  const out: HlrPiece<T>[] = [];
  if (faces.length === 0) {
    for (const line of lines) out.push({ line, a: line.a, b: line.b });
    return out;
  }

  const ts: number[] = [];
  for (const line of lines) {
    const { a, b } = line;
    const du = b.u - a.u, dv = b.v - a.v;
    if (Math.hypot(du, dv) < MIN_PIECE_MM) continue;

    const loU = Math.min(a.u, b.u), hiU = Math.max(a.u, b.u);
    const loV = Math.min(a.v, b.v), hiV = Math.max(a.v, b.v);
    const near: FacePlane[] = [];
    for (const f of faces) {
      if (f.uMax < loU || f.uMin > hiU || f.vMax < loV || f.vMin > hiV) continue;
      near.push(f);
    }
    if (near.length === 0) {
      out.push({ line, a, b });
      continue;
    }

    ts.length = 0;
    ts.push(0, 1);
    for (const f of near) {
      crossings(a, b, f, ts);
      depthCrossing(line, f, ts);
    }
    ts.sort((x, y) => x - y);

    // Walk the intervals, joining the ones that stay visible.
    let runFrom: number | null = null;
    const flush = (to: number) => {
      if (runFrom === null) return;
      const from = runFrom;
      runFrom = null;
      const pa = { u: a.u + du * from, v: a.v + dv * from };
      const pb = { u: a.u + du * to, v: a.v + dv * to };
      if (Math.hypot(pb.u - pa.u, pb.v - pa.v) >= MIN_PIECE_MM) out.push({ line, a: pa, b: pb });
    };
    for (let i = 0; i < ts.length - 1; i++) {
      const t0 = ts[i], t1 = ts[i + 1];
      if (t1 - t0 <= PARAM_EPS) continue;
      const tm = (t0 + t1) / 2;
      const um = a.u + du * tm, vm = a.v + dv * tm;
      const depth = line.depthA + (line.depthB - line.depthA) * tm;
      let hidden = false;
      for (const f of near) {
        if (faceDepthAt(f, um, vm) >= depth - epsMm) continue;
        if (!insideFace(f, um, vm)) continue;
        hidden = true;
        break;
      }
      if (hidden) flush(t0);
      else if (runFrom === null) runFrom = t0;
    }
    flush(1);
  }
  return out;
}
