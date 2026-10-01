/**
 * A Delaunay triangulation is defined by one property — no input point lies
 * strictly inside any triangle's circumcircle — and by Euler's count. Both are
 * checked directly, so any triangulation that is actually Delaunay passes.
 */
import { describe, expect, it } from 'vitest';
import { delaunay, type Tri } from './delaunay';
import type { Pt2 } from '@/lib/geom/plan2d';

function circumcircle(A: Pt2, B: Pt2, C: Pt2): { cx: number; cy: number; r2: number } {
  const d = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
  const a2 = A.x ** 2 + A.y ** 2, b2 = B.x ** 2 + B.y ** 2, c2 = C.x ** 2 + C.y ** 2;
  const cx = (a2 * (B.y - C.y) + b2 * (C.y - A.y) + c2 * (A.y - B.y)) / d;
  const cy = (a2 * (C.x - B.x) + b2 * (A.x - C.x) + c2 * (B.x - A.x)) / d;
  return { cx, cy, r2: (A.x - cx) ** 2 + (A.y - cy) ** 2 };
}

function expectDelaunay(pts: Pt2[], tris: Tri[]) {
  for (const t of tris) {
    const { cx, cy, r2 } = circumcircle(pts[t.a], pts[t.b], pts[t.c]);
    for (let i = 0; i < pts.length; i++) {
      if (i === t.a || i === t.b || i === t.c) continue;
      const d2 = (pts[i].x - cx) ** 2 + (pts[i].y - cy) ** 2;
      expect(d2, `point ${i} inside circumcircle of ${t.a},${t.b},${t.c}`).toBeGreaterThanOrEqual(r2 * (1 - 1e-9));
    }
  }
}

const ccw = (pts: Pt2[], t: Tri) => {
  const A = pts[t.a], B = pts[t.b], C = pts[t.c];
  return (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
};

/** Convex hull size, for Euler's formula: T = 2n − h − 2. */
function hullSize(pts: Pt2[]): number {
  const s = [...pts].sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o: Pt2, a: Pt2, b: Pt2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt2[] = [];
  for (const p of s) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: Pt2[] = [];
  for (const p of [...s].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.length + upper.length - 2;
}

describe('delaunay', () => {
  it('three points make one counter-clockwise triangle', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    const tris = delaunay(pts);
    expect(tris).toHaveLength(1);
    expect(ccw(pts, tris[0])).toBeGreaterThan(0);
  });

  it('fewer than three points give nothing', () => {
    expect(delaunay([])).toEqual([]);
    expect(delaunay([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([]);
  });

  it('a square with its centre splits into four triangles, all CCW', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }];
    const tris = delaunay(pts);
    expect(tris).toHaveLength(4);
    for (const t of tris) expect(ccw(pts, t)).toBeGreaterThan(0);
    expectDelaunay(pts, tris);
  });

  it('holds the empty-circumcircle property and Euler\'s count on a scattered set', () => {
    // Deterministic pseudo-random points.
    let s = 7;
    const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const pts: Pt2[] = Array.from({ length: 80 }, () => ({ x: rand() * 1000, y: rand() * 700 }));
    const tris = delaunay(pts);
    expectDelaunay(pts, tris);
    expect(tris).toHaveLength(2 * pts.length - hullSize(pts) - 2);
  });

  it('survives a jittered regular grid — the co-circular case the membrane feeds it', () => {
    const pts: Pt2[] = [];
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
      pts.push({ x: i * 100 + ((i * 7 + j * 3) % 11) * 1e-3, y: j * 100 + ((j * 5 + i) % 13) * 1e-3 });
    }
    const tris = delaunay(pts);
    expectDelaunay(pts, tris);
    // Jittered perimeter points are on the hull or a hair inside it, which
    // makes Euler's count ambiguous — but the triangles must tile the hull
    // exactly either way: total area equal, none negative, every point used.
    const area = tris.reduce((s, t) => s + ccw(pts, t) / 2, 0);
    for (const t of tris) expect(ccw(pts, t)).toBeGreaterThan(0);
    expect(Math.abs(area - 600 * 600) / (600 * 600)).toBeLessThan(1e-4);
    const used = new Set(tris.flatMap((t) => [t.a, t.b, t.c]));
    expect(used.size).toBe(49);
  });
});
