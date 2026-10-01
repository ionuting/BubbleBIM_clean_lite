/**
 * rings.ts — the geometric heart of the sweep, with NO three.js import so the
 * Inspector can call it every render just for diagnostics and numbers.
 *
 * A swept solid is modelled as rings: the placed profile stamped at each path
 * station. A mitered run is ONE solid whose interior rings sit on the corner
 * bisectors (scaled by 1/cos(θ/2), the classic miter factor); a butt corner —
 * requested, too sharp, or a reversal — splits the run into 2-ring prisms.
 *
 * Volume comes from the mesh itself (signed tetrahedron sum), not from
 * area × centerline length: with an off-centroid anchor the miter lengthens or
 * shortens the material and the shortcut is wrong by 2·offset·tan(θ/2) per
 * corner. The tetrahedron sum is also a free watertightness proof.
 */
import { polygonArea } from '@/lib/geom/plan2d';
import type { Pt2, Pt3, SweepCorners, SweepDiagnostic, SweepPath, SweepSolid } from './types';
import { triangulateFace } from '@/lib/geom/faceWithHoles';

/** Included-angle limit: a turn sharper than this (>150°) cannot miter sanely. */
const MITER_COS_HALF_MIN = Math.cos((75 * Math.PI) / 180);

// ─── Ear-clipping triangulation (simple polygons, CCW) ───────────────────────

/**
 * Triangulate a simple CCW polygon into index triples. Ear clipping — handles
 * the concave profiles (L, U, T) that a fan would get wrong. Self-intersecting
 * input is the caller's problem: `computeSweep` gates on `isSimplePolygon`.
 */
export function triangulateSimple(poly: Pt2[]): [number, number, number][] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = Array.from({ length: n }, (_, i) => i);
  const tris: [number, number, number][] = [];

  const cross = (a: Pt2, b: Pt2, c: Pt2) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inTri = (p: Pt2, a: Pt2, b: Pt2, c: Pt2) =>
    cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;

  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (cross(a, b, c) <= 1e-9) continue; // reflex or collinear — not an ear
      let contains = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(poly[j], a, b, c)) { contains = true; break; }
      }
      if (contains) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate input — return what we have
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

// ─── The frame the profile stands in ─────────────────────────────────────────

const cross3 = (a: Pt3, b: Pt3): Pt3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot3 = (a: Pt3, b: Pt3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const unit3 = (v: Pt3): Pt3 | null => {
  const l = Math.hypot(v.x, v.y, v.z);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : null;
};

const WORLD_UP: Pt3 = { x: 0, y: 0, z: 1 };

/**
 * Where the profile's own axes point at a station: `s` takes its x, `u` its y.
 *
 * The frame is fixed-up, not rotation-minimising: `s` is always horizontal, so
 * a cornice running up a gable stays upright instead of rolling with the
 * slope. That is what a moulding does, and it is also what makes the frame
 * reproduce both special cases it replaces —
 *
 *   a horizontal run  →  s = left of travel, u = +Z   (the old plan normal)
 *   a vertical run    →  s = +X, u = +Y               (the profile in plan)
 *
 * — so a raking path is not a third kind of geometry, only the general one.
 */
export interface SweepFrame { s: Pt3; u: Pt3 }

export function frameOf(t: Pt3): SweepFrame {
  const s = unit3(cross3(WORLD_UP, t));
  // Straight up or down: there is no horizontal left to take, and the profile
  // lies flat in the plan the way a one-anchor sweep has always placed it.
  if (!s) return { s: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 1, z: 0 } };
  return { s, u: cross3(t, s) };
}

/**
 * The miter of two unit directions: their bisector, lengthened by 1/cos(θ/2)
 * so the profile still measures its own width across the joint.
 *
 * Returns null for a reversal, which no miter can express.
 */
function miterOf(a: Pt3, b: Pt3): { v: Pt3; cosHalf: number } | null {
  const m = unit3({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  if (!m) return null;
  const cosHalf = dot3(m, a);
  if (cosHalf < 1e-6) return null;
  return { v: { x: m.x / cosHalf, y: m.y / cosHalf, z: m.z / cosHalf }, cosHalf };
}

// ─── Ring construction ───────────────────────────────────────────────────────

function ringAt(P: Pt3, f: SweepFrame, placed: Pt2[]): Pt3[] {
  return placed.map((p) => ({
    x: P.x + f.s.x * p.x + f.u.x * p.y,
    y: P.y + f.s.y * p.x + f.u.y * p.y,
    z: P.z + f.s.z * p.x + f.u.z * p.y,
  }));
}

interface JointInfo {
  /** The frame for the ring at this vertex, mitered. Null = must split here. */
  frame: SweepFrame | null;
  sharp: boolean;
}

/**
 * The frame for a segment when the profile's up is NOT world up.
 *
 * `frameOf` keeps a moulding upright against gravity; a rib on a curved shell
 * has to stand on the SURFACE, so its up is the surface normal at the station.
 * Same construction, different up: `s` is left of travel within the surface,
 * `u` is the normal with its along-tangent part removed. Falls back to the
 * fixed-up frame when the normal and the tangent are parallel.
 */
export function frameOnSurface(t: Pt3, normal: Pt3): SweepFrame {
  const s = unit3(cross3(normal, t));
  if (!s) return frameOf(t);
  return { s, u: cross3(t, s) };
}

/** How a caller can choose the frame per segment: tangent and the segment's midpoint. */
export type SweepFrameFor = (tangent: Pt3, at: Pt3) => SweepFrame;

export function computeSweepSolids(
  path: SweepPath,
  placed: Pt2[],
  corners: SweepCorners,
  frameFor?: SweepFrameFor,
  /**
   * Holes through the profile, in the same placed coordinates as `placed`
   * (CCW) and wound clockwise. Each is swept along the very same stations, so
   * its rings line up one for one with the outer ring's and the caps can be
   * triangulated once for all of them.
   */
  holes: Pt2[][] = [],
): { solids: SweepSolid[]; diagnostics: SweepDiagnostic[] } {
  const out = sweepOuter(path, placed, corners, frameFor);
  if (holes.length === 0) return out;
  // The joints depend on the path alone, so every hole produces the same
  // solids in the same order with the same ring counts as the outer profile.
  const holeSolids = holes.map((h) => sweepOuter(path, h, corners, frameFor).solids);
  const capTris = triangulateFace(placed, holes);
  out.solids.forEach((solid, k) => {
    solid.holes = holeSolids.map((hs) => hs[k].rings);
    solid.capTris = capTris;
  });
  return out;
}

function sweepOuter(
  path: SweepPath,
  placed: Pt2[],
  corners: SweepCorners,
  frameFor?: SweepFrameFor,
): { solids: SweepSolid[]; diagnostics: SweepDiagnostic[] } {
  const diagnostics: SweepDiagnostic[] = [];
  const pts = path.points;

  // One code path for all three kinds. A vertical run is a two-point path whose
  // tangent is +Z, and `frameOf` lays its profile in the plan; a raking run is
  // a path whose tangent simply has a z.
  const n = pts.length;
  const segDirs: Pt3[] = [];
  const segMids: Pt3[] = [];
  const segCount = path.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const A = pts[i], B = pts[(i + 1) % n];
    const d = unit3({ x: B.x - A.x, y: B.y - A.y, z: B.z - A.z });
    segDirs.push(d ?? { x: 1, y: 0, z: 0 });
    segMids.push({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 });
  }
  const frames = segDirs.map((d, i) => (frameFor ? frameFor(d, segMids[i]) : frameOf(d)));

  // Joint per vertex: ends take the adjacent segment's normal; interiors miter
  // unless the corner is a reversal, too sharp, or butt mode is on.
  const joints: JointInfo[] = [];
  for (let i = 0; i < n; i++) {
    const hasPrev = path.closed || i > 0;
    const hasNext = path.closed || i < n - 1;
    if (!hasPrev || !hasNext) {
      joints.push({ frame: frames[hasNext ? i : i - 1], sharp: false });
      continue;
    }
    if (corners === 'butt') { joints.push({ frame: null, sharp: false }); continue; }
    const iPrev = (i - 1 + segCount) % segCount, iNext = i % segCount;
    const fPrev = frames[iPrev], fNext = frames[iNext];
    // Each profile axis is mitered on its own. A run that only turns in plan
    // leaves `u` untouched (both are +Z, so the miter is the identity); one
    // that only changes slope leaves `s` untouched. A run that does both gets
    // each axis carried across its own joint.
    const ms = miterOf(fPrev.s, fNext.s);
    const mu = miterOf(fPrev.u, fNext.u);
    const cosHalf = Math.min(ms?.cosHalf ?? 0, mu?.cosHalf ?? 0);
    if (!ms || !mu || cosHalf < MITER_COS_HALF_MIN) {
      const turnDeg = Math.round((Math.acos(Math.max(-1, Math.min(1,
        dot3(segDirs[iPrev], segDirs[iNext])))) * 180) / Math.PI);
      diagnostics.push({
        code: 'CORNER_TOO_SHARP',
        severity: 'warning',
        message: !ms || !mu
          ? `Punctul ${i + 1} întoarce traseul complet — colțul e tăiat drept, nu în unghi.`
          : `Colț de ${turnDeg}° la punctul ${i + 1} — prea ascuțit pentru îmbinare în unghi; tăiat drept.`,
      });
      joints.push({ frame: null, sharp: true });
      continue;
    }
    joints.push({ frame: { s: ms.v, u: mu.v }, sharp: false });
  }

  const solids: SweepSolid[] = [];

  const fullLoop = path.closed && joints.every((j) => j.frame !== null);
  if (fullLoop) {
    const rings = pts.map((P, i) => ringAt(P, joints[i].frame!, placed));
    return { solids: [{ rings, loop: true }], diagnostics };
  }

  // Walk the segments and grow runs; a null-lateral vertex ends the current run
  // with the previous segment's own normal and starts the next with its own.
  const segsInOrder: number[] = [];
  if (path.closed) {
    // Start at a split vertex so runs never straddle the seam.
    const start = joints.findIndex((j) => j.frame === null);
    for (let k = 0; k < segCount; k++) segsInOrder.push((start + k) % segCount);
  } else {
    for (let k = 0; k < segCount; k++) segsInOrder.push(k);
  }

  let run: Pt3[][] | null = null;
  for (const si of segsInOrder) {
    const vA = si, vB = (si + 1) % n;
    const f = frames[si];
    if (!run) run = [ringAt(pts[vA], joints[vA].frame ?? f, placed)];
    const fB = joints[vB].frame;
    const isEnd = fB === null || (!path.closed && vB === n - 1);
    run.push(ringAt(pts[vB], fB ?? f, placed));
    if (isEnd) {
      if (run.length >= 2) solids.push({ rings: run, loop: false });
      run = null;
    }
  }
  if (run && run.length >= 2) solids.push({ rings: run, loop: false });

  return { solids, diagnostics };
}

// ─── Triangles, volume, footprint ────────────────────────────────────────────

/**
 * Every triangle of a solid, outward-wound: side quads between consecutive
 * rings, caps from the profile triangulation on open runs. The same list feeds
 * the mesh AND the volume, so what you see is what gets measured.
 */
export function solidTriangles(
  solid: SweepSolid,
  placedTris: [number, number, number][],
): [Pt3, Pt3, Pt3][] {
  const { rings, loop } = solid;
  const R = rings.length;
  if (R < 2) return [];
  const tris: [Pt3, Pt3, Pt3][] = [];

  // Walls: the outer ring's, then each hole's. A hole ring is wound the other
  // way round, so the same stitching turns its walls to face into the hole.
  const bands = loop ? R : R - 1;
  const walls = (ringAt: (i: number) => Pt3[]) => {
    for (let i = 0; i < bands; i++) {
      const a = ringAt(i), b = ringAt((i + 1) % R);
      const N = a.length;
      for (let j = 0; j < N; j++) {
        const j1 = (j + 1) % N;
        tris.push([a[j], a[j1], b[j1]]);
        tris.push([a[j], b[j1], b[j]]);
      }
    }
  };
  walls((i) => rings[i]);
  for (const hole of solid.holes ?? []) walls((i) => hole[i]);

  if (!loop) {
    // With holes the solid carries its own cap triangulation over the outer
    // ring followed by the hole rings; without, the caller's profile one.
    const station = (i: number): Pt3[] =>
      solid.capTris ? [rings[i], ...(solid.holes ?? []).map((h) => h[i])].flat() : rings[i];
    const caps = solid.capTris ?? placedTris;
    const first = station(0), last = station(R - 1);
    for (const [ia, ib, ic] of caps) {
      tris.push([first[ia], first[ic], first[ib]]); // start cap faces −t
      tris.push([last[ia], last[ib], last[ic]]);    // end cap faces +t
    }
  }
  return tris;
}

/** Signed volume of the closed triangle soup, mm³ — positive when outward-wound. */
export function sweepVolume(
  solids: SweepSolid[],
  placedTris: [number, number, number][],
): number {
  let v6 = 0;
  for (const solid of solids) {
    for (const [a, b, c] of solidTriangles(solid, placedTris)) {
      v6 += a.x * (b.y * c.z - b.z * c.y)
          - a.y * (b.x * c.z - b.z * c.x)
          + a.z * (b.x * c.y - b.y * c.x);
    }
  }
  return v6 / 6;
}

/**
 * Plan outline(s) for the 2D floor plan, taken from the actual mitered rings:
 * the chain of each ring's leftmost profile point out, the rightmost back. A
 * closed loop yields its outer and inner chains as two polygons.
 */
export function sweepFootprint(
  solids: SweepSolid[],
  path: SweepPath,
  placed: Pt2[],
): Pt2[][] {
  if (placed.length < 3) return [];

  if (path.kind === 'vertical') {
    const P = path.points[0];
    return [placed.map((p) => ({ x: P.x + p.x, y: P.y + p.y }))];
  }

  let jMin = 0, jMax = 0;
  placed.forEach((p, j) => {
    if (p.x < placed[jMin].x) jMin = j;
    if (p.x > placed[jMax].x) jMax = j;
  });

  const out: Pt2[][] = [];
  for (const solid of solids) {
    const leftChain = solid.rings.map((r) => ({ x: r[jMax].x, y: r[jMax].y }));
    const rightChain = solid.rings.map((r) => ({ x: r[jMin].x, y: r[jMin].y }));
    if (solid.loop) {
      out.push(leftChain, rightChain);
    } else {
      out.push([...leftChain, ...rightChain.reverse()]);
    }
  }
  return out;
}

/** Perimeter of a closed polygon, mm. */
export function polygonPerimeter(poly: Pt2[]): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

/** Guide-line length, mm — the closing segment counts on a closed path. */
export function pathLength(path: SweepPath): number {
  const pts = path.points;
  let len = 0;
  const segCount = path.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const A = pts[i], B = pts[(i + 1) % pts.length];
    len += Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
  }
  return len;
}

/** Convenience: |area| of the placed profile, mm². */
export function profileArea(placed: Pt2[]): number {
  return Math.abs(polygonArea(placed));
}

/**
 * One straight prism per path segment, in the frame a swept-solid EXPORT needs.
 *
 * IFC (and ArchiCAD, and anything else that only knows straight extrusions)
 * cannot express a mitered joint: an extrusion has two parallel cap planes, and
 * a miter needs two different ones. So exporters emit a prism per segment,
 * which overlaps on the inside of every corner and leaves a notch outside. The
 * error is bounded by the profile's lateral half-width and only ever appears at
 * corners — worth stating, not worth faking.
 *
 * Frame per segment, matching the profile's own (x = lateral left, y = up):
 *   axis        the extrusion direction, unit — the segment's own heading
 *   refDir      local X, i.e. the lateral direction, so that Y = axis × refDir
 *               comes out as "up" and the profile lands the right way round
 */
export interface SweepSegment {
  /** Segment start in BIM mm — the origin of the profile's placement. */
  start: Pt3;
  /** Unit extrusion direction. */
  axis: { x: number; y: number; z: number };
  /** Unit local-X (lateral) direction. */
  refDir: { x: number; y: number; z: number };
  lengthMm: number;
}

/**
 * The placed profile as an AXIS-ALIGNED rectangle, or null when it is anything
 * else (a rotated rectangle included).
 *
 * This is the question every "width × height" consumer has to ask: ArchiCAD's
 * CreateBeams/CreateColumns take two dimensions and no profile, so only a
 * rectangle standing square to the guide line survives the trip. `cx`/`cy` are
 * the rectangle's centre relative to the guide line, which is where the anchor
 * and lateral offset end up — a consumer that ignores them silently re-centres
 * the element on the line.
 */
export function placedRectangle(placed: Pt2[]): { cx: number; cy: number; w: number; h: number } | null {
  if (placed.length !== 4) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX, h = maxY - minY;
  if (!(w > 0) || !(h > 0)) return null;
  // A rotated rectangle fills only part of its bounding box; an axis-aligned
  // one fills it exactly.
  if (Math.abs(Math.abs(polygonArea(placed)) - w * h) > Math.max(1, w * h * 1e-6)) return null;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h };
}

/** Normalise −0 to 0: a left-normal of +X is (−0, 1), and −0 serialises into
 *  exported files as "-0." — valid but noise, and it breaks identity tests. */
const z0 = (v: number): number => v + 0;

export function sweepSegments(path: SweepPath): SweepSegment[] {
  if (path.kind === 'vertical') {
    const [a, b] = path.points;
    return [{
      start: a,
      axis: { x: 0, y: 0, z: 1 },
      refDir: { x: 1, y: 0, z: 0 },   // Y = Z × X = +Y, so profile y → world Y
      lengthMm: b.z - a.z,
    }];
  }

  const out: SweepSegment[] = [];
  const pts = path.points;
  const segCount = path.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const A = pts[i], B = pts[(i + 1) % pts.length];
    // The true 3-D length: a raking run is longer than its shadow in plan, and
    // an exporter that used the plan length would leave a gap at the top.
    const len = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
    if (len < 1e-6) continue;
    const t: Pt3 = { x: (B.x - A.x) / len, y: (B.y - A.y) / len, z: (B.z - A.z) / len };
    const { s } = frameOf(t);
    out.push({
      start: A,
      axis: { x: z0(t.x), y: z0(t.y), z: z0(t.z) },
      refDir: { x: z0(s.x), y: z0(s.y), z: z0(s.z) },  // Y = axis × refDir = the frame's up
      lengthMm: len,
    });
  }
  return out;
}
