/**
 * pathStations.ts — one way to walk along any drawn path, curve or polyline.
 *
 * An array along a path needs two things of the path: how long it is, and
 * where it is — with which heading — at a given distance from its start.
 * A NURBS curve answers both exactly (`nurbs.stationsAt`, integrated length);
 * a polyline answers them segment by segment. Consumers take a `PathReader`
 * and never ask which one they have.
 */
import type { Pt2 } from './plan2d';
import { arcLength, stationsAt, type Nurbs2 } from './nurbs';

export interface PathStation {
  /** Distance along the path from its start. */
  s: number;
  point: Pt2;
  /** Unit tangent — the heading of the path there. */
  tangent: Pt2;
}

export interface PathReader {
  length: number;
  closed: boolean;
  /** Stations at these distances; a closed path wraps, an open one clamps. */
  at(distances: number[]): PathStation[];
}

/**
 * The distance along the path of the point nearest `p` — where something
 * drawn beside the path "is" on it. A coarse scan by length finds the right
 * stretch, a ternary search pins it down.
 */
export function closestDistance(path: PathReader, p: Pt2, samples = 400): number {
  const L = path.length;
  if (!(L > 0)) return 0;
  const n = Math.max(8, samples);
  const ds = Array.from({ length: n + 1 }, (_, i) => (L * i) / n);
  const d2 = (s: number) => {
    const q = path.at([s])[0].point;
    return (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
  };
  let best = 0, bestD = Infinity;
  for (const s of ds) { const v = d2(s); if (v < bestD) { bestD = v; best = s; } }
  let lo = Math.max(0, best - L / n), hi = Math.min(L, best + L / n);
  for (let it = 0; it < 40 && hi - lo > 1e-6; it++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (d2(m1) < d2(m2)) hi = m2; else lo = m1;
  }
  return (lo + hi) / 2;
}

/** A NURBS curve as a path. */
export function curvePath(c: Nurbs2): PathReader {
  const length = arcLength(c);
  const closed = !!c.periodic;
  return {
    length,
    closed,
    at: (ds) => stationsAt(c, ds.map((d) => wrapOrClamp(d, length, closed)))
      .map((st) => ({ s: st.s, point: st.point, tangent: st.tangent })),
  };
}

/** A polyline as a path — the tangent is the segment's own direction. */
export function polylinePath(pts: Pt2[], closed: boolean): PathReader | null {
  const segs: { a: Pt2; b: Pt2; s0: number; len: number }[] = [];
  let acc = 0;
  const n = pts.length;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    segs.push({ a, b, s0: acc, len });
    acc += len;
  }
  if (segs.length === 0) return null;
  const length = acc;
  return {
    length,
    closed,
    at: (ds) => ds.map((raw) => {
      const s = wrapOrClamp(raw, length, closed);
      let k = segs.findIndex((g) => s <= g.s0 + g.len + 1e-9);
      if (k < 0) k = segs.length - 1;
      const g = segs[k];
      const t = Math.max(0, Math.min(1, (s - g.s0) / g.len));
      const tangent = { x: (g.b.x - g.a.x) / g.len, y: (g.b.y - g.a.y) / g.len };
      return { s, point: { x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t }, tangent };
    }),
  };
}

function wrapOrClamp(d: number, length: number, closed: boolean): number {
  if (!(length > 0)) return 0;
  if (closed) return ((d % length) + length) % length;
  return Math.max(0, Math.min(length, d));
}

/** Heading of a unit tangent, radians. */
export const headingOf = (t: Pt2): number => Math.atan2(t.y, t.x);
