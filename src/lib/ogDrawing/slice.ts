/**
 * slice.ts — what a plane actually cuts out of a solid.
 *
 * ## Why this exists at all
 *
 * The drawing engine builds its cut from the PARAMETERS of an element: a wall
 * is a rectangle as wide as the wall is thick, a column is its section. That
 * is exact for a wall and a column and wrong for everything else — a sweep, a
 * stair, a sloping roof, a freeform solid have no rectangle to be. And the
 * kernel will not do it: `section_plane` is accepted by the projection API and
 * then discarded, in 2.0.13 and still in 2.0.14 (measured — a box straddling
 * the plane comes back whole, and no `SectionCut` edge is ever emitted).
 *
 * So the cut is computed here, from the same B-rep faces the kernel hands back
 * for its projection. One consequence is worth stating plainly: this works on
 * a wall and on a stair alike, because it never asks what the element IS. It
 * asks only where its faces are.
 *
 * ## The method
 *
 * A closed polyhedron meets a plane in closed loops. Each planar face meets it
 * in a segment, and the segments join end to end into those loops:
 *
 *   1. per face, intersect its boundary with the plane. Every crossing lies on
 *      one line — the two planes' intersection — so the crossings sort along
 *      that line and pair up even-odd into the intervals that are INSIDE the
 *      face. That pairing is what makes holes work for free: a wall cut at
 *      door height has the doorway's reveals in its boundary, so the wall's
 *      cut comes out as the two pieces either side of the opening, with no
 *      special case for openings anywhere in this file.
 *   2. weld the segment ends and walk the graph into closed loops.
 *   3. project, and decide by nesting which loop is a hole.
 *
 * ## The two degeneracies that matter
 *
 * A face LYING IN the plane is skipped. Its boundary would contribute the
 * whole outline, and since the neighbouring faces already contribute their own
 * crossings, keeping it doubles every edge and the walk closes nothing.
 *
 * A vertex exactly ON the plane is counted by the half-open rule
 * (`d <= 0 → d > 0`), the same one `drawingEngine.ts` uses for its footprint
 * crossings. It keeps the crossing count even, which is what the pairing
 * needs; the alternative — counting a touching vertex twice — opens the loop.
 */
import type { Vec3, ViewFrame } from './frame';
import { projectPt } from './frame';

/** A planar face: its boundary and its holes, BIM mm. Matches `OgFace`. */
export interface FaceLike {
  ring: Vec3[];
  holes: Vec3[][];
}

/** A closed cut loop in drawing millimetres. */
export interface CutLoop {
  pts: { u: number; v: number }[];
  /** A loop enclosed by another is the hole in it — a duct through a slab. */
  isHole: boolean;
}

/**
 * How close two ends must be to be the same point, mm.
 *
 * Generous on purpose: the ends come from different faces of the same solid
 * and pass through a float32 buffer for meshes, so they agree to about a
 * micron, never exactly. A tenth of a millimetre is far below anything a
 * drawing shows and far above the noise.
 */
export const WELD_MM = 0.1;

/** A segment shorter than this is a face touching the plane at a corner. */
const MIN_SEG_MM = 1e-3;

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

/**
 * The face's normal by Newell's method — which, unlike a cross product of the
 * first three corners, does not collapse when those three happen to be
 * collinear. A tessellated cylinder has plenty of those.
 */
export function faceNormal(ring: Vec3[]): Vec3 | null {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const m = Math.hypot(nx, ny, nz);
  if (m < 1e-9) return null;
  return { x: nx / m, y: ny / m, z: nz / m };
}

/** One segment of the cut, in BIM mm. */
export interface CutSegment { a: Vec3; b: Vec3 }

/**
 * Where one face crosses the plane.
 *
 * Returns the parts of the intersection line that lie inside the face. Holes
 * in the face take part in the same even-odd pairing as its outer ring, so a
 * face with a hole in it yields the pieces on either side of the hole.
 */
export function sliceFace(
  face: FaceLike,
  planePoint: Vec3,
  planeNormal: Vec3,
): CutSegment[] {
  const n = faceNormal(face.ring);
  if (!n) return [];

  // A face lying IN the plane contributes nothing: its neighbours already do.
  const dir = cross(n, planeNormal);
  const dlen = len(dir);
  if (dlen < 1e-7) return [];
  const L: Vec3 = { x: dir.x / dlen, y: dir.y / dlen, z: dir.z / dlen };

  const signed = (p: Vec3): number => dot(sub(p, planePoint), planeNormal);

  // Every crossing of the face's whole boundary, with where it is and how far
  // along L it sits. The point is KEPT, not re-derived from the distance: L
  // passes through `planePoint`, which is the view's origin and generally not
  // on this face at all, so rebuilding the point from its distance alone
  // would slide every segment sideways onto that one line.
  const hits: { t: number; p: Vec3 }[] = [];
  const addRing = (ring: Vec3[]): void => {
    if (ring.length < 2) return;
    for (let i = 0; i < ring.length; i++) {
      const A = ring[i], B = ring[(i + 1) % ring.length];
      const da = signed(A), db = signed(B);
      // Half-open: a vertex sitting on the plane is counted once, not twice.
      if (!((da <= 0 && db > 0) || (db <= 0 && da > 0))) continue;
      const t = da / (da - db);
      const P: Vec3 = {
        x: A.x + (B.x - A.x) * t,
        y: A.y + (B.y - A.y) * t,
        z: A.z + (B.z - A.z) * t,
      };
      hits.push({ t: dot(sub(P, planePoint), L), p: P });
    }
  };
  addRing(face.ring);
  for (const h of face.holes) addRing(h);
  if (hits.length < 2) return [];

  hits.sort((p, q) => p.t - q.t);
  const out: CutSegment[] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) {
    if (hits[i + 1].t - hits[i].t < MIN_SEG_MM) continue;
    out.push({ a: hits[i].p, b: hits[i + 1].p });
  }
  return out;
}

const keyOf = (p: Vec3): string =>
  `${Math.round(p.x / WELD_MM)},${Math.round(p.y / WELD_MM)},${Math.round(p.z / WELD_MM)}`;

/**
 * Join segments end to end into closed loops.
 *
 * A well-formed solid gives every welded point exactly two segments, and the
 * walk is unambiguous. Real geometry does not always: a solid welded from two
 * touching boxes gives a point four segments. The walk takes whichever unused
 * segment is there, which closes a loop through the junction rather than
 * refusing — a drawing with the right ink in the right places, even if the
 * loop it belongs to is a matter of opinion at that one point.
 *
 * A chain that runs out before closing is kept anyway when it is long enough
 * to see: a solid with a hole in its surface still cuts to something, and
 * dropping it silently would be the worse failure.
 */
export function chainLoops(segments: CutSegment[]): Vec3[][] {
  const adj = new Map<string, number[]>();
  const pointOf = new Map<string, Vec3>();
  const used = new Array<boolean>(segments.length).fill(false);

  segments.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      const k = keyOf(p);
      if (!pointOf.has(k)) pointOf.set(k, p);
      const list = adj.get(k);
      if (list) list.push(i); else adj.set(k, [i]);
    }
  });

  const other = (i: number, k: string): string => {
    const s = segments[i];
    return keyOf(s.a) === k ? keyOf(s.b) : keyOf(s.a);
  };
  const step = (k: string): number | null => {
    for (const i of adj.get(k) ?? []) if (!used[i]) return i;
    return null;
  };

  const loops: Vec3[][] = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    const k0 = keyOf(segments[start].a);
    let k = k0;
    const pts: Vec3[] = [];
    let guard = segments.length + 2;
    let i: number | null = start;
    while (i !== null && guard-- > 0) {
      used[i] = true;
      const p = pointOf.get(k);
      if (p) pts.push(p);
      k = other(i, k);
      if (k === k0) break;
      i = step(k);
    }
    if (pts.length >= 3) loops.push(pts);
  }
  return loops;
}

/** Twice the signed area of a drawing polygon — positive when counter-clockwise. */
export function signedArea2(pts: { u: number; v: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.u * q.v - q.u * p.v;
  }
  return a;
}

function pointInPoly(pt: { u: number; v: number }, poly: { u: number; v: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.v > pt.v) !== (b.v > pt.v)
      && pt.u < ((b.u - a.u) * (pt.v - a.v)) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}

/**
 * The cut of one solid, in drawing coordinates.
 *
 * Nesting decides what is a hole, not winding: the loops come from a walk that
 * has no reason to agree on orientation between one solid and the next, and a
 * duct through a slab is a hole because it is INSIDE the slab's outline —
 * which is the thing actually being claimed.
 *
 * Loops are returned largest first, so a renderer that draws them in order
 * puts the holes on top of the outline they belong to.
 */
export function sliceEntity(
  faces: FaceLike[],
  frame: ViewFrame,
  planePoint: Vec3,
  planeNormal: Vec3,
): CutLoop[] {
  const segs: CutSegment[] = [];
  for (const f of faces) segs.push(...sliceFace(f, planePoint, planeNormal));
  if (segs.length === 0) return [];

  const drawn = chainLoops(segs).map((loop) => {
    const pts = loop.map((p) => {
      const q = projectPt(frame, p);
      return { u: q.u, v: q.v };
    });
    return { pts, area: Math.abs(signedArea2(pts)) };
  }).filter((l) => l.area > 1);          // 1 mm² — a loop with no face to it

  drawn.sort((a, b) => b.area - a.area);
  return drawn.map((l, i) => ({
    pts: l.pts,
    // A loop inside any LARGER loop is a hole in it. Testing one vertex is
    // enough: the loops of a single cut never cross one another.
    isHole: drawn.slice(0, i).some((outer) => pointInPoly(l.pts[0], outer.pts)),
  }));
}
