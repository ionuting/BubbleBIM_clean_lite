/**
 * membrane.ts — the dome's surface, found rather than drawn.
 *
 * ## Why a membrane
 *
 * A hemisphere is easy and useless: it only fits a circular base. The graph
 * hands over an arbitrary contour, and what a bubble does over an arbitrary
 * contour is what a soap film does — it takes the shape of a membrane under
 * uniform pressure. That is a Poisson problem, Δt = −1 with t = 0 on the
 * boundary, and it is LINEAR: solve it once and scale, and the apex lands
 * exactly on the height asked for.
 *
 * ## Why a shaping exponent
 *
 * The small-deflection membrane is a paraboloid on a disc, t ∝ R² − r². Real
 * domes are rounder than that. Raising the normalised solution to a power
 * does it: z = H·(t/t_max)^e gives, on a disc, z = H·(1 − r²/R²)^e — an
 * ellipsoidal cap at e = ½ (a hemisphere when H = R), a paraboloid at e = 1,
 * a balloon with steep flanks below ½. On any other contour it generalises
 * the same way, which is the point.
 *
 * ## The limit
 *
 * This is a height field. Nothing here can overhang its base — a hemisphere
 * is exactly the edge case, with vertical tangents at the rim. A bubble that
 * bulges past its footprint is a different (3D, geodesic) problem.
 */
import { ensureCcw, pointInPolygon, type Pt2 } from '@/lib/geom/plan2d';
import type { Pt3 } from '@/lib/sweep/types';
import { delaunay, type Tri } from './delaunay';

export interface Membrane {
  /** Vertices in plan, mm, relative to nothing — the base's own coordinates. */
  pts: Pt2[];
  /** Height above the base per vertex, mm. Zero on the boundary. */
  z: Float64Array;
  tris: Tri[];
  /** Unit outward (upward) normal per vertex. */
  normals: Pt3[];
  boundary: Uint8Array;
  base: Pt2[];
  spacingMm: number;
  /** Height and normal at a plan point, by barycentric interpolation. */
  sample(p: Pt2): { z: number; normal: Pt3 };
}

export interface MembraneOptions {
  heightMm: number;
  bulge: number;
  resolution: number;
}

/** The exponent behind `bulge`: 0 → 1 (paraboloid), 1 → ½ (ellipsoid), clamped. */
export function bulgeExponent(bulge: number): number {
  return Math.min(1.5, Math.max(0.25, 1 - 0.5 * bulge));
}

function distToBoundary(p: Pt2, poly: Pt2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Solve Δt = −1 on the mesh with t = 0 on the boundary, by successive
 * over-relaxation with cotangent weights. Cotangent weights make the answer
 * independent of how the grid happens to fall; the clamp to ≥ 0 keeps an
 * obtuse sliver at the boundary from making the iteration diverge.
 */
function solvePoisson(pts: Pt2[], tris: Tri[], boundary: Uint8Array): Float64Array {
  const n = pts.length;
  const nbr: number[][] = Array.from({ length: n }, () => []);
  const wts: number[][] = Array.from({ length: n }, () => []);
  const area = new Float64Array(n);
  const wmap = new Map<string, number>();
  const addW = (u: number, v: number, w: number) => {
    const key = u < v ? `${u}_${v}` : `${v}_${u}`;
    wmap.set(key, (wmap.get(key) ?? 0) + Math.max(0, w));
  };
  const cot = (o: Pt2, a: Pt2, b: Pt2) => {
    const ux = a.x - o.x, uy = a.y - o.y, vx = b.x - o.x, vy = b.y - o.y;
    const cr = ux * vy - uy * vx;
    return Math.abs(cr) < 1e-12 ? 0 : (ux * vx + uy * vy) / Math.abs(cr);
  };
  for (const t of tris) {
    const A = pts[t.a], B = pts[t.b], C = pts[t.c];
    const ar = Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / 2;
    area[t.a] += ar / 3; area[t.b] += ar / 3; area[t.c] += ar / 3;
    addW(t.a, t.b, 0.5 * cot(C, A, B));
    addW(t.b, t.c, 0.5 * cot(A, B, C));
    addW(t.c, t.a, 0.5 * cot(B, C, A));
  }
  for (const [key, w] of wmap) {
    const [u, v] = key.split('_').map(Number);
    nbr[u].push(v); wts[u].push(w);
    nbr[v].push(u); wts[v].push(w);
  }

  const t = new Float64Array(n);
  const interior: number[] = [];
  for (let i = 0; i < n; i++) if (!boundary[i] && nbr[i].length) interior.push(i);
  if (interior.length === 0) return t;

  const omega = 1.8;
  for (let iter = 0; iter < 8000; iter++) {
    let maxDelta = 0, maxT = 0;
    for (const i of interior) {
      let sw = 0, swt = 0;
      const ns = nbr[i], ws = wts[i];
      for (let k = 0; k < ns.length; k++) { sw += ws[k]; swt += ws[k] * t[ns[k]]; }
      if (sw <= 0) continue;
      const next = (swt + area[i]) / sw;
      const delta = omega * (next - t[i]);
      t[i] += delta;
      if (Math.abs(delta) > maxDelta) maxDelta = Math.abs(delta);
      if (t[i] > maxT) maxT = t[i];
    }
    if (maxDelta < 1e-7 * Math.max(maxT, 1e-9)) break;
  }
  return t;
}

/**
 * Inflate a membrane over `baseIn`. Returns null when the contour cannot hold
 * a mesh (fewer than three points, or a degenerate outline).
 */
export function buildMembrane(baseIn: Pt2[], opts: MembraneOptions): Membrane | null {
  if (baseIn.length < 3) return null;
  const base = ensureCcw(baseIn);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of base) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const longest = Math.max(maxX - minX, maxY - minY);
  if (!(longest > 1)) return null;
  const res = Math.max(6, Math.min(80, Math.round(opts.resolution) || 28));
  const h = longest / res;

  // Boundary, resampled at the grid spacing so Delaunay edges follow it.
  const pts: Pt2[] = [];
  const boundaryFlags: number[] = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[i], b = base[(i + 1) % base.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.max(1, Math.round(len / h));
    // A circular base puts every boundary point on one circle, a straight
    // edge puts its samples on one line — both are degeneracies Bowyer–Watson
    // is fragile about. A sub-millimetre nudge ACROSS the edge, deterministic
    // and invisible, breaks the tie; along the edge it would break nothing.
    const nx = len > 0 ? -(b.y - a.y) / len : 0, ny = len > 0 ? (b.x - a.x) / len : 0;
    for (let s = 0; s < k; s++) {
      const u = s / k;
      const j = (((i * 5 + s * 3) % 7) - 3) * 1e-3;
      pts.push({ x: a.x + (b.x - a.x) * u + nx * j, y: a.y + (b.y - a.y) * u + ny * j });
      boundaryFlags.push(1);
    }
  }

  // Interior grid, kept clear of the boundary so the boundary edges stay
  // Delaunay, and jittered so no four points are exactly co-circular.
  let row = 0;
  for (let gy = minY + h / 2; gy < maxY; gy += h, row++) {
    let col = 0;
    for (let gx = minX + h / 2; gx < maxX; gx += h, col++) {
      const p = { x: gx + ((col * 7 + row * 3) % 11) * 1e-3, y: gy + ((row * 5 + col) % 13) * 1e-3 };
      if (!pointInPolygon(p, base, 0)) continue;
      if (distToBoundary(p, base) < 0.45 * h) continue;
      pts.push(p);
      boundaryFlags.push(0);
    }
  }
  const boundary = Uint8Array.from(boundaryFlags);

  const tris = delaunay(pts).filter((t) => {
    const A = pts[t.a], B = pts[t.b], C = pts[t.c];
    return pointInPolygon({ x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 }, base, 0);
  });
  if (tris.length === 0) return null;

  const t = solvePoisson(pts, tris, boundary);
  let tMax = 0;
  for (let i = 0; i < t.length; i++) if (t[i] > tMax) tMax = t[i];
  const e = bulgeExponent(opts.bulge);
  const z = new Float64Array(pts.length);
  if (tMax > 0) {
    for (let i = 0; i < z.length; i++) z[i] = opts.heightMm * Math.pow(Math.max(0, t[i] / tMax), e);
  }

  // Area-weighted vertex normals from the lifted triangles.
  const acc = pts.map(() => ({ x: 0, y: 0, z: 0 }));
  for (const tr of tris) {
    const A = pts[tr.a], B = pts[tr.b], C = pts[tr.c];
    const ux = B.x - A.x, uy = B.y - A.y, uz = z[tr.b] - z[tr.a];
    const vx = C.x - A.x, vy = C.y - A.y, vz = z[tr.c] - z[tr.a];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [tr.a, tr.b, tr.c]) { acc[i].x += nx; acc[i].y += ny; acc[i].z += nz; }
  }
  const normals: Pt3[] = acc.map((v) => {
    const l = Math.hypot(v.x, v.y, v.z);
    return l > 1e-12 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 0, z: 1 };
  });

  // Point location: triangle bboxes for a cheap reject, barycentric inside.
  const boxes = tris.map((tr) => {
    const A = pts[tr.a], B = pts[tr.b], C = pts[tr.c];
    return {
      minX: Math.min(A.x, B.x, C.x), maxX: Math.max(A.x, B.x, C.x),
      minY: Math.min(A.y, B.y, C.y), maxY: Math.max(A.y, B.y, C.y),
    };
  });
  const sample = (p: Pt2): { z: number; normal: Pt3 } => {
    const eps = -1e-4;
    for (let k = 0; k < tris.length; k++) {
      const bb = boxes[k];
      if (p.x < bb.minX - 1e-6 || p.x > bb.maxX + 1e-6 || p.y < bb.minY - 1e-6 || p.y > bb.maxY + 1e-6) continue;
      const tr = tris[k];
      const A = pts[tr.a], B = pts[tr.b], C = pts[tr.c];
      const det = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((B.x - p.x) * (C.y - p.y) - (C.x - p.x) * (B.y - p.y)) / det;
      const l2 = ((C.x - p.x) * (A.y - p.y) - (A.x - p.x) * (C.y - p.y)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < eps || l2 < eps || l3 < eps) continue;
      const n = {
        x: l1 * normals[tr.a].x + l2 * normals[tr.b].x + l3 * normals[tr.c].x,
        y: l1 * normals[tr.a].y + l2 * normals[tr.b].y + l3 * normals[tr.c].y,
        z: l1 * normals[tr.a].z + l2 * normals[tr.b].z + l3 * normals[tr.c].z,
      };
      const l = Math.hypot(n.x, n.y, n.z) || 1;
      return {
        z: l1 * z[tr.a] + l2 * z[tr.b] + l3 * z[tr.c],
        normal: { x: n.x / l, y: n.y / l, z: n.z / l },
      };
    }
    // Outside every triangle (a clipped vertex a hair past the rim): nearest vertex.
    let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i].x - p.x) ** 2 + (pts[i].y - p.y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return { z: z[best], normal: normals[best] };
  };

  return { pts, z, tris, normals, boundary, base, spacingMm: h, sample };
}
