/**
 * voronoi.ts — the tessellation, cut to the base and relaxed on the surface.
 *
 * ## Cells by half-planes, not by duality
 *
 * The textbook route — Delaunay, then the dual — gives unbounded cells that
 * still have to be clipped to the base contour, and the base is any simple
 * polygon, concave included. Clipping a polygon by a HALF-PLANE, on the other
 * hand, is Sutherland–Hodgman with a convex clipper, which is correct for a
 * concave subject. So each cell is built the other way round: start from the
 * base and cut it by the bisector of every other seed. Quadratic in the seed
 * count, and with a few hundred seeds that is nothing.
 *
 * The one thing this cannot express is a cell that the base's concavity
 * splits in two; Sutherland–Hodgman returns it as one ring joined by a
 * zero-width bridge. Rare at any sensible seed density, and harmless.
 *
 * ## Relaxation in 3D
 *
 * Lloyd's step moves each seed to its cell's centroid. Taken in plan, cells
 * on the steep flanks come out stretched: the same plan area is far more
 * surface up there. So the centroid is taken of the LIFTED cell, area-weighted
 * on the surface, and only then dropped back to plan. That is what makes the
 * panels read as evenly sized on the dome rather than on its shadow.
 */
import { ensureCcw, pointInPolygon, polygonArea, type Pt2 } from '@/lib/geom/plan2d';
import { triangulateSimple } from '@/lib/sweep/rings';

/** mulberry32 — a small, deterministic PRNG so a seed reproduces a tessellation. */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Keep the part of `poly` on the side of the line through `p` with unit
 * `normal` where (x − p)·normal ≥ offset. The clipper is a half-plane, so a
 * concave subject is handled correctly.
 */
export function clipByLine(poly: Pt2[], p: Pt2, normal: Pt2, offset = 0): Pt2[] {
  const out: Pt2[] = [];
  const n = poly.length;
  if (n === 0) return out;
  const side = (q: Pt2) => (q.x - p.x) * normal.x + (q.y - p.y) * normal.y - offset;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const sa = side(a), sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Drop consecutive duplicates closer than `tol`. */
export function dedupeRing(poly: Pt2[], tol = 0.5): Pt2[] {
  const out: Pt2[] = [];
  for (const p of poly) {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < tol) continue;
    out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < tol) out.pop();
  }
  return out;
}

/** A merge tolerance that scales with the base: a millionth of its extent. */
export function sizeTolerance(base: Pt2[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of base) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return Math.max(1e-9, 1e-6 * Math.max(maxX - minX, maxY - minY));
}

/** The Voronoi cell of every seed, clipped to `base`. Empty ring = no cell. */
export function voronoiCells(base: Pt2[], seeds: Pt2[]): Pt2[][] {
  const ccw = ensureCcw(base);
  const tol = sizeTolerance(base);
  return seeds.map((s, i) => {
    let cell = ccw;
    for (let j = 0; j < seeds.length && cell.length >= 3; j++) {
      if (j === i) continue;
      const o = seeds[j];
      const dx = s.x - o.x, dy = s.y - o.y;
      const l = Math.hypot(dx, dy);
      if (l < 1e-9) continue;
      // Keep the side nearer to s: (x − mid)·(s − o) ≥ 0.
      cell = clipByLine(cell, { x: (s.x + o.x) / 2, y: (s.y + o.y) / 2 }, { x: dx / l, y: dy / l });
    }
    const ring = dedupeRing(cell, tol);
    return ring.length >= 3 ? ring : [];
  });
}

/**
 * `count` seeds inside `base`, spread by dart throwing: a candidate closer
 * than half the expected cell spacing to an accepted seed is retried. After a
 * few failures the distance requirement is relaxed rather than failing.
 */
export function seedPoints(base: Pt2[], count: number, random: () => number): Pt2[] {
  const ccw = ensureCcw(base);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ccw) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const area = Math.abs(polygonArea(ccw));
  const want = Math.max(1, Math.round(count));
  let minDist = 0.6 * Math.sqrt(area / want);
  const out: Pt2[] = [];
  let failures = 0;
  let guard = 0;
  while (out.length < want && guard++ < want * 400) {
    const p = { x: minX + (maxX - minX) * random(), y: minY + (maxY - minY) * random() };
    if (!pointInPolygon(p, ccw, 0)) continue;
    let ok = true;
    for (const q of out) {
      if (Math.hypot(p.x - q.x, p.y - q.y) < minDist) { ok = false; break; }
    }
    if (ok) { out.push(p); failures = 0; continue; }
    if (++failures > 60) { minDist *= 0.8; failures = 0; }
  }
  return out;
}

/**
 * One Lloyd pass: each seed to the surface-area-weighted centroid of its
 * lifted cell, dropped back to plan. A seed whose cell vanished, or whose
 * centroid left the base, stays put.
 */
export function lloydStep(
  base: Pt2[],
  seeds: Pt2[],
  cells: Pt2[][],
  heightAt: (p: Pt2) => number,
): Pt2[] {
  return seeds.map((s, i) => {
    const cell = cells[i];
    if (!cell || cell.length < 3) return s;
    const ccw = ensureCcw(cell);
    let ax = 0, ay = 0, aw = 0;
    const accumulate = (A: Pt2, B: Pt2, C: Pt2) => {
      const za = heightAt(A), zb = heightAt(B), zc = heightAt(C);
      const ux = B.x - A.x, uy = B.y - A.y, uz = zb - za;
      const vx = C.x - A.x, vy = C.y - A.y, vz = zc - za;
      const w = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      ax += w * (A.x + B.x + C.x) / 3;
      ay += w * (A.y + B.y + C.y) / 3;
      aw += w;
    };
    const mid = (P: Pt2, Q: Pt2): Pt2 => ({ x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 });
    for (const [a, b, c] of triangulateSimple(ccw)) {
      // Split each triangle in four so the surface is sampled inside the cell
      // too, not only at its corners — a cell spanning a steep flank would
      // otherwise weigh the same as a flat one.
      const A = ccw[a], B = ccw[b], C = ccw[c];
      const AB = mid(A, B), BC = mid(B, C), CA = mid(C, A);
      accumulate(A, AB, CA); accumulate(AB, B, BC); accumulate(CA, BC, C); accumulate(AB, BC, CA);
    }
    if (aw <= 0) return s;
    const c = { x: ax / aw, y: ay / aw };
    return pointInPolygon(c, base, 0) ? c : s;
  });
}

export interface CellEdge {
  a: Pt2;
  b: Pt2;
  /** Cells sharing this edge — one means it lies on the base contour. */
  cells: number[];
}

/** Every distinct edge of the tessellation, each once, with the cells it borders. */
export function cellEdges(cells: Pt2[][], tolIn?: number): CellEdge[] {
  const tol = tolIn ?? sizeTolerance(cells.flat()) * 100;
  const key = (p: Pt2) => `${Math.round(p.x / tol)}_${Math.round(p.y / tol)}`;
  const map = new Map<string, CellEdge>();
  cells.forEach((cell, ci) => {
    for (let i = 0; i < cell.length; i++) {
      const a = cell[i], b = cell[(i + 1) % cell.length];
      const ka = key(a), kb = key(b);
      if (ka === kb) continue;
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = map.get(k);
      if (e) { if (!e.cells.includes(ci)) e.cells.push(ci); }
      else map.set(k, { a, b, cells: [ci] });
    }
  });
  return [...map.values()];
}
