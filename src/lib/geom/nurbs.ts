/**
 * nurbs.ts — non-uniform rational B-spline curves in the plan.
 *
 * The exact curve is the model; points are only ever a READING of it. Every
 * pipeline in the app — extrusion, sweep, holes, the plan, IFC — consumes
 * polylines, so a curve reaches them through `tessellate` at a chord
 * tolerance, while its length, the stations of an array along it and (later)
 * an exact IFC B-spline come from the curve itself.
 *
 * Algorithms are the textbook ones (Piegl & Tiller, "The NURBS Book"):
 * span search A2.1, basis functions A2.2 and their first derivatives A2.3,
 * rational evaluation through homogeneous coordinates, global interpolation
 * with chord-length parameters and averaged knots (§9.2.1). A closed curve is
 * a uniform periodic B-spline: its control points wrap by `degree`, and
 * interpolating one is a cyclic system solved here directly.
 *
 * Units are whatever the points are in — BIM millimetres everywhere it is used.
 */
import type { Pt2 } from './plan2d';

export interface Nurbs2 {
  degree: number;
  /** Control points. A periodic curve repeats its first `degree` at the end. */
  points: Pt2[];
  /** One per control point; absent means all 1 (a plain B-spline). */
  weights?: number[];
  /** Non-decreasing, `points.length + degree + 1` long. */
  knots: number[];
  /** The curve closes on itself with continuity (periodic), not just a coincident end. */
  periodic?: boolean;
}

// ─── Basis ───────────────────────────────────────────────────────────────────

/** The knot span containing `u` — A2.1, with the domain's end mapped into the last span. */
export function findSpan(n: number, p: number, u: number, U: number[]): number {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let low = p, high = n + 1, mid = (low + high) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) high = mid; else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

/** The p+1 non-zero basis functions at `u` and their first derivatives — A2.2/A2.3. */
function basisWithDerivs(i: number, u: number, p: number, U: number[]): { N: number[]; dN: number[] } {
  const ndu: number[][] = Array.from({ length: p + 1 }, () => new Array(p + 1).fill(0));
  const left = new Array(p + 1).fill(0), right = new Array(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[i + 1 - j];
    right[j] = U[i + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[j][r] === 0 ? 0 : ndu[r][j - 1] / ndu[j][r];
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }
  const N = ndu.map((row) => row[p]);
  const dN = new Array(p + 1).fill(0);
  if (p > 0) {
    for (let r = 0; r <= p; r++) {
      // First derivative from the degree p−1 functions: p·(N_{r−1}/Δ − N_r/Δ').
      let d = 0;
      if (r >= 1) {
        const a = ndu[p][r - 1];
        d += a === 0 ? 0 : ndu[r - 1][p - 1] / a;
      }
      if (r <= p - 1) {
        const b = ndu[p][r];
        d -= b === 0 ? 0 : ndu[r][p - 1] / b;
      }
      dN[r] = d * p;
    }
  }
  return { N, dN };
}

/** The parameter range the curve is defined on. */
export function domain(c: Nurbs2): [number, number] {
  return [c.knots[c.degree], c.knots[c.points.length]];
}

/** Point and first derivative at `u` — rational, through homogeneous coordinates. */
export function evaluateWithTangent(c: Nurbs2, u: number): { point: Pt2; tangent: Pt2 } {
  const p = c.degree, n = c.points.length - 1;
  const [u0, u1] = domain(c);
  const uu = Math.min(u1, Math.max(u0, u));
  const span = findSpan(n, p, uu, c.knots);
  const { N, dN } = basisWithDerivs(span, uu, p, c.knots);
  let wx = 0, wy = 0, w = 0, dwx = 0, dwy = 0, dw = 0;
  for (let j = 0; j <= p; j++) {
    const k = span - p + j;
    const P = c.points[k], wk = c.weights?.[k] ?? 1;
    wx += N[j] * P.x * wk; wy += N[j] * P.y * wk; w += N[j] * wk;
    dwx += dN[j] * P.x * wk; dwy += dN[j] * P.y * wk; dw += dN[j] * wk;
  }
  const point = { x: wx / w, y: wy / w };
  // C' = (A' − w'·C) / w
  const tangent = { x: (dwx - dw * point.x) / w, y: (dwy - dw * point.y) / w };
  return { point, tangent };
}

export const evaluate = (c: Nurbs2, u: number): Pt2 => evaluateWithTangent(c, u).point;

// ─── Construction ────────────────────────────────────────────────────────────

/** Knots of a clamped curve with evenly spaced interior knots on [0, 1]. */
export function clampedUniformKnots(count: number, p: number): number[] {
  const m = count + p + 1;
  const inner = count - p;
  const U: number[] = [];
  for (let i = 0; i < m; i++) {
    if (i <= p) U.push(0);
    else if (i >= count) U.push(1);
    else U.push((i - p) / inner);
  }
  return U;
}

/** The degree a curve through / over `count` points can have, capped at `wanted`. */
const degreeFor = (count: number, wanted: number, periodic: boolean) =>
  Math.max(1, Math.min(wanted, periodic ? count - 1 : count - 1, 5));

/**
 * The points as a CONTROL polygon: a clamped B-spline that starts and ends on
 * the first and last point and is pulled towards the others.
 */
export function bsplineFromControl(points: Pt2[], degree = 3): Nurbs2 | null {
  if (points.length < 2) return null;
  const p = degreeFor(points.length, degree, false);
  return { degree: p, points: points.map((q) => ({ ...q })), knots: clampedUniformKnots(points.length, p) };
}

/** The points as a closed control polygon: a uniform periodic B-spline. */
export function periodicFromControl(points: Pt2[], degree = 3): Nurbs2 | null {
  if (points.length < 3) return null;
  const p = degreeFor(points.length, degree, true);
  const wrapped = [...points, ...points.slice(0, p)].map((q) => ({ ...q }));
  const knots = Array.from({ length: wrapped.length + p + 1 }, (_, i) => i);
  return { degree: p, points: wrapped, knots, periodic: true };
}

/** Solve A·x = b in place by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[][]): number[][] | null {
  const n = A.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-14) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      for (let k = 0; k < b[r].length; k++) b[r][k] -= f * b[c][k];
    }
  }
  const x = b.map((row) => row.slice());
  for (let r = n - 1; r >= 0; r--) {
    for (let k = 0; k < x[r].length; k++) {
      let s = x[r][k];
      for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c][k];
      x[r][k] = s / A[r][r];
    }
  }
  return x;
}

/**
 * The curve THROUGH the points (§9.2.1): chord-length parameters, knots by
 * averaging, one linear solve. Passes exactly through every point, in order.
 */
export function interpolateOpen(fit: Pt2[], degree = 3): Nurbs2 | null {
  const pts = dedupe(fit);
  if (pts.length < 2) return null;
  const p = degreeFor(pts.length, degree, false);
  const n = pts.length - 1;
  const d: number[] = [0];
  for (let k = 1; k <= n; k++) d.push(d[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
  const total = d[n];
  if (!(total > 0)) return null;
  const ub = d.map((v) => v / total);
  const U: number[] = new Array(n + p + 2).fill(0);
  for (let j = 0; j <= p; j++) U[n + p + 1 - j] = 1;
  for (let j = 1; j <= n - p; j++) {
    let s = 0;
    for (let i = j; i < j + p; i++) s += ub[i];
    U[j + p] = s / p;
  }
  const A: number[][] = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
  for (let k = 0; k <= n; k++) {
    const span = findSpan(n, p, ub[k], U);
    const { N } = basisWithDerivs(span, ub[k], p, U);
    for (let j = 0; j <= p; j++) A[k][span - p + j] = N[j];
  }
  const X = solve(A, pts.map((q) => [q.x, q.y]));
  if (!X) return null;
  return { degree: p, points: X.map(([x, y]) => ({ x, y })), knots: U };
}

/**
 * The closed curve through the points: a uniform periodic cubic whose
 * stations are the points themselves. With uniform knots the condition at
 * each point is (P[k−1] + 4·P[k] + P[k+1]) / 6 = Q[k] — a cyclic system.
 * Lower degrees fall back to the points as a closed control polygon.
 */
export function interpolateClosed(fit: Pt2[], degree = 3): Nurbs2 | null {
  const pts = dedupe(fit, true);
  if (pts.length < 3) return null;
  if (degree !== 3 || pts.length < 4) return periodicFromControl(pts, Math.min(degree, pts.length - 1));
  const n = pts.length;
  const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let k = 0; k < n; k++) {
    A[k][(k - 1 + n) % n] += 1 / 6;
    A[k][k] += 4 / 6;
    A[k][(k + 1) % n] += 1 / 6;
  }
  const X = solve(A, pts.map((q) => [q.x, q.y]));
  if (!X) return null;
  // Control point k sits under station k when the curve is started one span
  // back: rotate so that u = 3 (the domain start) lands on point 0.
  const ctrl = X.map(([x, y]) => ({ x, y }));
  const rotated = [ctrl[n - 1], ...ctrl.slice(0, n - 1)];
  return periodicFromControl(rotated, 3);
}

function dedupe(pts: Pt2[], closed = false): Pt2[] {
  const out: Pt2[] = [];
  for (const q of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 1e-6) out.push({ x: q.x, y: q.y });
  }
  if (closed && out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= 1e-6) out.pop();
  }
  return out;
}

// ─── Reading the curve ───────────────────────────────────────────────────────

/** Distinct knot values inside the domain — the spans the curve is made of. */
function spans(c: Nurbs2): [number, number][] {
  const [u0, u1] = domain(c);
  const ks = [...new Set(c.knots.filter((k) => k >= u0 && k <= u1))].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ks.length; i++) if (ks[i + 1] > ks[i]) out.push([ks[i], ks[i + 1]]);
  return out.length ? out : [[u0, u1]];
}

const distToChord = (p: Pt2, a: Pt2, b: Pt2) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
};

/**
 * Points along the curve such that no chord strays more than `tolerance` from
 * it. Each span starts from a few samples (so no wiggle hides between two
 * points that happen to agree) and every interval is bisected until its
 * chord holds. A periodic curve does not repeat its first point at the end.
 */
export function tessellate(c: Nurbs2, tolerance = 0.5): Pt2[] {
  const out: Pt2[] = [];
  const params: number[] = [];
  const refine = (ua: number, ub: number, a: Pt2, b: Pt2, depth: number) => {
    const um = (ua + ub) / 2;
    const m = evaluate(c, um);
    // Also test the quarter points: a symmetric S can pass its midpoint on
    // the chord and still bulge either side of it.
    const q1 = evaluate(c, (ua + um) / 2), q3 = evaluate(c, (um + ub) / 2);
    const dev = Math.max(distToChord(m, a, b), distToChord(q1, a, b), distToChord(q3, a, b));
    if (depth < 16 && dev > tolerance) {
      refine(ua, um, a, m, depth + 1);
      refine(um, ub, m, b, depth + 1);
    } else {
      out.push(b);
      params.push(ub);
    }
  };
  const SEED = Math.max(2, c.degree + 1);
  let first = true;
  for (const [s0, s1] of spans(c)) {
    for (let k = 0; k < SEED; k++) {
      const ua = s0 + ((s1 - s0) * k) / SEED, ub = s0 + ((s1 - s0) * (k + 1)) / SEED;
      const a = evaluate(c, ua);
      if (first) { out.push(a); params.push(ua); first = false; }
      refine(ua, ub, a, evaluate(c, ub), 0);
    }
  }
  if (c.periodic && out.length > 1) out.pop();
  return out;
}

// Gauss–Legendre, 8 points on [−1, 1].
const GL_X = [-0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498,
  0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363];
const GL_W = [0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620,
  0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

function lengthBetween(c: Nurbs2, a: number, b: number): number {
  const h = (b - a) / 2, m = (a + b) / 2;
  let s = 0;
  for (let i = 0; i < 8; i++) {
    const t = evaluateWithTangent(c, m + h * GL_X[i]).tangent;
    s += GL_W[i] * Math.hypot(t.x, t.y);
  }
  return s * h;
}

/** Sub-intervals per span for the length integral — plenty for smooth spans. */
const SUBDIV = 4;

/** Arc length, integrated on the curve (not on a polyline). */
export function arcLength(c: Nurbs2): number {
  let s = 0;
  for (const [s0, s1] of spans(c)) {
    for (let k = 0; k < SUBDIV; k++) {
      s += lengthBetween(c, s0 + ((s1 - s0) * k) / SUBDIV, s0 + ((s1 - s0) * (k + 1)) / SUBDIV);
    }
  }
  return s;
}

export interface CurveStation {
  /** Distance along the curve from its start. */
  s: number;
  u: number;
  point: Pt2;
  /** Unit tangent. */
  tangent: Pt2;
}

/**
 * The points at the given distances along the curve, with their unit
 * tangents — what an array along a path is placed on. Each distance is found
 * on a cumulative table of the integrated length and finished by Newton.
 */
export function stationsAt(c: Nurbs2, distances: number[]): CurveStation[] {
  const table: { u: number; s: number }[] = [];
  let acc = 0;
  for (const [s0, s1] of spans(c)) {
    for (let k = 0; k < SUBDIV; k++) {
      const a = s0 + ((s1 - s0) * k) / SUBDIV, b = s0 + ((s1 - s0) * (k + 1)) / SUBDIV;
      if (table.length === 0) table.push({ u: a, s: 0 });
      acc += lengthBetween(c, a, b);
      table.push({ u: b, s: acc });
    }
  }
  const total = acc;
  return distances.map((raw) => {
    const s = Math.max(0, Math.min(total, raw));
    let j = 1;
    while (j < table.length - 1 && table[j].s < s) j++;
    const lo = table[j - 1], hi = table[j];
    let u = hi.s > lo.s ? lo.u + ((s - lo.s) / (hi.s - lo.s)) * (hi.u - lo.u) : lo.u;
    for (let it = 0; it < 6; it++) {
      const err = lo.s + lengthBetween(c, lo.u, u) - s;
      const t = evaluateWithTangent(c, u).tangent;
      const speed = Math.hypot(t.x, t.y);
      if (speed < 1e-12 || Math.abs(err) < 1e-9) break;
      u = Math.max(lo.u, Math.min(hi.u, u - err / speed));
    }
    const { point, tangent } = evaluateWithTangent(c, u);
    const L = Math.hypot(tangent.x, tangent.y) || 1;
    return { s, u, point, tangent: { x: tangent.x / L, y: tangent.y / L } };
  });
}

/** `count` stations spread evenly along the curve, ends included (open) or wrapping (closed). */
export function divideEvenly(c: Nurbs2, count: number): CurveStation[] {
  const total = arcLength(c);
  const n = Math.max(1, Math.round(count));
  const gaps = c.periodic ? n : Math.max(1, n - 1);
  return stationsAt(c, Array.from({ length: n }, (_, i) => (n === 1 ? 0 : (total * i) / gaps)));
}
