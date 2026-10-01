/**
 * delaunay.ts — Bowyer–Watson, because the membrane needs a mesh of the base.
 *
 * Nothing in the project triangulates a point SET (ear clipping handles a
 * polygon outline, which is a different problem), and no dependency does
 * either. The incremental algorithm is ~80 lines and O(n²) in the worst case,
 * which for the few thousand points a membrane grid produces is well under
 * the cost of drawing the result.
 *
 * Co-circular inputs — a regular grid is nothing but — are the one thing this
 * algorithm is fragile about, so callers jitter grid points by a fraction of
 * a millimetre. That is deliberate, and it is why the membrane builder does
 * it rather than asking this file to be robust to the exact case.
 */
import type { Pt2 } from '@/lib/geom/plan2d';

/** Triangle by vertex index, counter-clockwise. */
export interface Tri { a: number; b: number; c: number }

interface Circ extends Tri { cx: number; cy: number; r2: number }

function makeTri(P: Pt2[], a: number, b: number, c: number): Circ {
  const A = P[a], B = P[b], C = P[c];
  // Wind counter-clockwise so every consumer can assume it.
  const area2 = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
  if (area2 < 0) { const t = b; b = c; c = t; }
  const bx = P[b].x, by = P[b].y, cx = P[c].x, cy = P[c].y;
  const d = 2 * (A.x * (by - cy) + bx * (cy - A.y) + cx * (A.y - by));
  if (Math.abs(d) < 1e-12) {
    // Collinear: a circle of infinite radius. Every later point "lies inside",
    // so the triangle is re-cut as soon as anything else arrives.
    return { a, b, c, cx: (A.x + bx + cx) / 3, cy: (A.y + by + cy) / 3, r2: Infinity };
  }
  const a2 = A.x * A.x + A.y * A.y, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - A.y) + c2 * (A.y - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (A.x - cx) + c2 * (bx - A.x)) / d;
  return { a, b, c, cx: ux, cy: uy, r2: (A.x - ux) ** 2 + (A.y - uy) ** 2 };
}

/** Delaunay triangulation of `pts`. Fewer than three points give nothing. */
export function delaunay(pts: Pt2[]): Tri[] {
  const n = pts.length;
  if (n < 3) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1) * 20;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;

  const P: Pt2[] = pts.slice();
  P.push({ x: mx - span, y: my - span }, { x: mx + span, y: my - span }, { x: mx, y: my + span });

  let tris: Circ[] = [makeTri(P, n, n + 1, n + 2)];

  for (let i = 0; i < n; i++) {
    const p = P[i];
    const bad: Circ[] = [];
    const keep: Circ[] = [];
    for (const t of tris) {
      // Strictly inside, with a relative margin: points that are co-circular
      // to floating precision — every vertex of a circular base is — must be
      // judged the same way by every triangle, or the cavity stops being a
      // single star-shaped hole and the mesh fills with overlapping triangles.
      const d2 = (p.x - t.cx) ** 2 + (p.y - t.cy) ** 2;
      if (t.r2 === Infinity || d2 < t.r2 * (1 - 1e-9)) bad.push(t); else keep.push(t);
    }

    // The cavity boundary: edges of bad triangles not shared with another bad one.
    const count = new Map<string, { u: number; v: number; n: number }>();
    const edge = (u: number, v: number) => {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      const e = count.get(key);
      if (e) e.n++; else count.set(key, { u, v, n: 1 });
    };
    for (const t of bad) { edge(t.a, t.b); edge(t.b, t.c); edge(t.c, t.a); }

    tris = keep;
    for (const e of count.values()) {
      if (e.n === 1) tris.push(makeTri(P, e.u, e.v, i));
    }
  }

  return tris
    .filter((t) => t.a < n && t.b < n && t.c < n)
    .map(({ a, b, c }) => ({ a, b, c }));
}
