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

// ─── Ring construction ───────────────────────────────────────────────────────

const left = (d: Pt2): Pt2 => ({ x: -d.y, y: d.x });

function ringAt(P: Pt3, lateral: Pt2, placed: Pt2[]): Pt3[] {
  return placed.map((p) => ({
    x: P.x + lateral.x * p.x,
    y: P.y + lateral.y * p.x,
    z: P.z + p.y,
  }));
}

interface JointInfo {
  /** Lateral direction for the ring at this vertex (unit s, or scaled miter). */
  lateral: Pt2 | null; // null = must split (butt) here
  sharp: boolean;
}

export function computeSweepSolids(
  path: SweepPath,
  placed: Pt2[],
  corners: SweepCorners,
): { solids: SweepSolid[]; diagnostics: SweepDiagnostic[] } {
  const diagnostics: SweepDiagnostic[] = [];
  const pts = path.points;

  if (path.kind === 'vertical') {
    // Profile plane is the plan itself: x → world X, y → world Y, sweep along Z.
    const [a, b] = pts;
    const ring = (z: number): Pt3[] => placed.map((p) => ({ x: a.x + p.x, y: a.y + p.y, z }));
    return { solids: [{ rings: [ring(a.z), ring(b.z)], loop: false }], diagnostics };
  }

  const n = pts.length;
  const segDirs: Pt2[] = [];
  const segCount = path.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const A = pts[i], B = pts[(i + 1) % n];
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    segDirs.push(len > 0 ? { x: (B.x - A.x) / len, y: (B.y - A.y) / len } : { x: 1, y: 0 });
  }

  // Joint per vertex: ends take the adjacent segment's normal; interiors miter
  // unless the corner is a reversal, too sharp, or butt mode is on.
  const joints: JointInfo[] = [];
  for (let i = 0; i < n; i++) {
    const hasPrev = path.closed || i > 0;
    const hasNext = path.closed || i < n - 1;
    if (!hasPrev || !hasNext) {
      const d = segDirs[hasNext ? i : i - 1];
      joints.push({ lateral: left(d), sharp: false });
      continue;
    }
    const sPrev = left(segDirs[(i - 1 + segCount) % segCount]);
    const sNext = left(segDirs[i % segCount]);
    if (corners === 'butt') { joints.push({ lateral: null, sharp: false }); continue; }
    const mx = sPrev.x + sNext.x, my = sPrev.y + sNext.y;
    const mlen = Math.hypot(mx, my);
    if (mlen < 1e-9) {
      diagnostics.push({
        code: 'CORNER_TOO_SHARP',
        severity: 'warning',
        message: `Punctul ${i + 1} întoarce traseul complet — colțul e tăiat drept, nu în unghi.`,
      });
      joints.push({ lateral: null, sharp: true });
      continue;
    }
    const mhx = mx / mlen, mhy = my / mlen;
    const cosHalf = mhx * sPrev.x + mhy * sPrev.y;
    if (cosHalf < MITER_COS_HALF_MIN) {
      const turnDeg = Math.round((Math.acos(Math.max(-1, Math.min(1,
        sPrev.x * sNext.x + sPrev.y * sNext.y))) * 180) / Math.PI);
      diagnostics.push({
        code: 'CORNER_TOO_SHARP',
        severity: 'warning',
        message: `Colț de ${turnDeg}° la punctul ${i + 1} — prea ascuțit pentru îmbinare în unghi; tăiat drept.`,
      });
      joints.push({ lateral: null, sharp: true });
      continue;
    }
    joints.push({ lateral: { x: mhx / cosHalf, y: mhy / cosHalf }, sharp: false });
  }

  const solids: SweepSolid[] = [];

  const fullLoop = path.closed && joints.every((j) => j.lateral !== null);
  if (fullLoop) {
    const rings = pts.map((P, i) => ringAt(P, joints[i].lateral!, placed));
    return { solids: [{ rings, loop: true }], diagnostics };
  }

  // Walk the segments and grow runs; a null-lateral vertex ends the current run
  // with the previous segment's own normal and starts the next with its own.
  const segsInOrder: number[] = [];
  if (path.closed) {
    // Start at a split vertex so runs never straddle the seam.
    const start = joints.findIndex((j) => j.lateral === null);
    for (let k = 0; k < segCount; k++) segsInOrder.push((start + k) % segCount);
  } else {
    for (let k = 0; k < segCount; k++) segsInOrder.push(k);
  }

  let run: Pt3[][] | null = null;
  for (const si of segsInOrder) {
    const vA = si, vB = (si + 1) % n;
    const s = left(segDirs[si]);
    if (!run) {
      const latA = joints[vA].lateral ?? s;
      run = [ringAt(pts[vA], latA, placed)];
    }
    const latB = joints[vB].lateral;
    const isEnd = latB === null || (!path.closed && vB === n - 1);
    run.push(ringAt(pts[vB], latB ?? s, placed));
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
  const N = rings[0].length;
  const tris: [Pt3, Pt3, Pt3][] = [];

  const bands = loop ? R : R - 1;
  for (let i = 0; i < bands; i++) {
    const a = rings[i], b = rings[(i + 1) % R];
    for (let j = 0; j < N; j++) {
      const j1 = (j + 1) % N;
      tris.push([a[j], a[j1], b[j1]]);
      tris.push([a[j], b[j1], b[j]]);
    }
  }

  if (!loop) {
    const first = rings[0], last = rings[R - 1];
    for (const [ia, ib, ic] of placedTris) {
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
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    if (len < 1e-6) continue;
    const t = { x: (B.x - A.x) / len, y: (B.y - A.y) / len };
    const s = left(t);
    out.push({
      start: A,
      axis: { x: z0(t.x), y: z0(t.y), z: 0 },
      refDir: { x: z0(s.x), y: z0(s.y), z: 0 },  // Y = axis × refDir = +Z (up)
      lengthMm: len,
    });
  }
  return out;
}
