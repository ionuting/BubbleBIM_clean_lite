/**
 * straightSkeleton.ts — straight skeleton of a simple polygon (Felkel–Obdržálek
 * wavefront), used to build hip roofs over ARBITRARY footprints: correct ridges,
 * hips AND valleys, with faces that tile the plan exactly (no overlap).
 *
 * The wavefront is all edges moving inward at unit speed. Vertices slide along
 * angle bisectors. Two event kinds drive it:
 *   • edge event  — an edge shrinks to zero (two bisectors meet);
 *   • split event — a reflex vertex reaches a non-adjacent edge, splitting the
 *     wavefront in two (this is what produces valleys on concave plans).
 *
 * Output: skeleton arcs (segment source→sink, each endpoint carrying its `time`
 * = distance travelled inward = roof height ÷ tan(pitch)). Faces are recovered
 * separately from the planar subdivision (see `skeletonFaces`).
 *
 * Pure & framework-free, validated by area-tiling unit tests (square, rectangle,
 * L, T, plus). The polygon is taken CCW and processed clockwise internally.
 */

export interface P { x: number; y: number; }
export interface SkelPoint extends P { time: number; }
export interface SkelArc { a: SkelPoint; b: SkelPoint; }

const EPS = 1e-4;

const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: P, s: number): P => ({ x: a.x * s, y: a.y * s });
const dot = (a: P, b: P): number => a.x * b.x + a.y * b.y;
const crossp = (a: P, b: P): number => a.x * b.y - a.y * b.x;
const length = (a: P): number => Math.hypot(a.x, a.y);
const norm = (a: P): P => { const l = length(a) || 1; return { x: a.x / l, y: a.y / l }; };
const eq = (a: P, b: P): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

// ── Robustness helpers ───────────────────────────────────────────────────────
// The wavefront maths uses a fixed EPS, so it is only well-conditioned when the
// coordinates are O(1). Real contours arrive in millimetres (thousands) and may
// carry duplicate / collinear vertices from the overhang offset or the way the
// user wired the ax nodes. We therefore (1) sanitize the polygon, (2) normalise
// it to a canonical size before running, and (3) drive it through a retry loop
// with tiny symbolic perturbations that break the simultaneous-event ties which
// otherwise merge faces on symmetric plans (equal-arm L, T, +, …).

/** Drop consecutive near-duplicate vertices and collinear (straight-through) ones. */
export function sanitizePolygon(poly: P[], tol = 1): P[] {
  const dedup: P[] = [];
  for (const p of poly) {
    const last = dedup[dedup.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < tol) continue;
    dedup.push({ x: p.x, y: p.y });
  }
  while (dedup.length > 1 &&
    Math.hypot(dedup[0].x - dedup[dedup.length - 1].x, dedup[0].y - dedup[dedup.length - 1].y) < tol) {
    dedup.pop();
  }
  const out: P[] = [];
  const n = dedup.length;
  for (let i = 0; i < n; i++) {
    const a = dedup[(i - 1 + n) % n], b = dedup[i], c = dedup[(i + 1) % n];
    const crossA = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const base = Math.hypot(c.x - a.x, c.y - a.y) || 1;
    if (Math.abs(crossA) / base > tol) out.push(b); // keep only genuine corners
  }
  return out.length >= 3 ? out : dedup;
}

/** Deterministic LCG — reproducible perturbations (no Math.random in geometry). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const polyArea = (pts: { x: number; y: number }[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
  return a / 2;
};

class Edge {
  d: P; // unit direction p→q
  constructor(public p: P, public q: P) {
    this.d = norm(sub(q, p));
  }
}

interface Ray { o: P; d: P; }

/** Line/line intersection (rays treated as infinite lines). */
function intersect(r1: Ray, r2: Ray): P | null {
  const denom = crossp(r1.d, r2.d);
  if (Math.abs(denom) < 1e-12) return null;
  const t = crossp(sub(r2.o, r1.o), r2.d) / denom;
  return add(r1.o, mul(r1.d, t));
}

/** Unsigned perpendicular distance from a point to an edge's supporting line. */
function edgeDist(e: Edge, pt: P): number {
  return Math.abs(crossp(sub(pt, e.p), e.d));
}

class Vertex {
  prev!: Vertex;
  next!: Vertex;
  bisector: Ray;
  isReflex: boolean;
  valid = true;
  constructor(
    public point: P,
    public time: number,
    public edgeLeft: Edge,
    public edgeRight: Edge,
  ) {
    const L = norm(edgeLeft.d);
    const R = norm(edgeRight.d);
    const negL = mul(L, -1);
    this.isReflex = crossp(negL, R) < 0;
    let bd = add(negL, R);
    if (length(bd) < EPS) {
      // Collinear edges → bisector is the inward normal of the right edge.
      bd = { x: -R.y, y: R.x };
    } else if (this.isReflex) {
      bd = mul(bd, -1);
    }
    this.bisector = { o: point, d: norm(bd) };
  }
}

interface OrigEdge { edge: Edge; bisLeft: Ray; bisRight: Ray; }

type EdgeEvent = { kind: 'edge'; dist: number; point: P; a: Vertex; b: Vertex };
type SplitEvent = { kind: 'split'; dist: number; point: P; v: Vertex; opp: Edge };
type Event = EdgeEvent | SplitEvent;

/** Earliest event for a vertex (edge event with a neighbour, or a split). */
function nextEvent(v: Vertex, origEdges: OrigEdge[]): Event | null {
  const cands: Event[] = [];

  if (v.isReflex) {
    for (const oe of origEdges) {
      if (oe.edge === v.edgeLeft || oe.edge === v.edgeRight) continue;
      // Choose the incident edge more parallel to the opposite edge.
      const leftDot = Math.abs(dot(norm(v.edgeLeft.d), norm(oe.edge.d)));
      const rightDot = Math.abs(dot(norm(v.edgeRight.d), norm(oe.edge.d)));
      const selfEdge = leftDot < rightDot ? v.edgeLeft : v.edgeRight;
      const i = intersect({ o: selfEdge.p, d: selfEdge.d }, { o: oe.edge.p, d: oe.edge.d });
      if (!i || eq(i, v.point)) continue;
      let linv = norm(sub(v.point, i));
      let edv = norm(oe.edge.d);
      if (dot(linv, edv) < 0) edv = mul(edv, -1);
      const bd = add(edv, linv);
      if (length(bd) < EPS) continue;
      const b = intersect({ o: i, d: norm(bd) }, v.bisector);
      if (!b) continue;
      // Eligibility: b within the opposite edge's live span and on its interior side.
      const xLeft = crossp(norm(oe.bisLeft.d), norm(sub(b, oe.bisLeft.o))) > -EPS;
      const xRight = crossp(norm(oe.bisRight.d), norm(sub(b, oe.bisRight.o))) < EPS;
      const xEdge = crossp(norm(oe.edge.d), norm(sub(b, oe.edge.p))) < EPS;
      if (!(xLeft && xRight && xEdge)) continue;
      cands.push({ kind: 'split', dist: edgeDist(oe.edge, b), point: b, v, opp: oe.edge });
    }
  }

  const iPrev = intersect(v.bisector, v.prev.bisector);
  const iNext = intersect(v.bisector, v.next.bisector);
  if (iPrev) cands.push({ kind: 'edge', dist: edgeDist(v.edgeLeft, iPrev), point: iPrev, a: v.prev, b: v });
  if (iNext) cands.push({ kind: 'edge', dist: edgeDist(v.edgeRight, iNext), point: iNext, a: v, b: v.next });

  let best: Event | null = null;
  for (const c of cands) {
    if (c.dist < v.time - EPS) continue; // events must be in the future
    if (!best || c.dist < best.dist) best = c;
  }
  return best;
}

/**
 * Raw wavefront on a polygon already conditioned (sanitized, O(1)-scaled).
 * Returns null if the polygon is degenerate.
 */
function skeletonRaw(polyCcw: P[]): SkelArc[] | null {
  if (polyCcw.length < 3) return null;
  // Work clockwise (interior on the right of directed edges under this convention).
  const pts = [...polyCcw].reverse();
  const n = pts.length;

  // Build edges + the initial doubly-linked wavefront.
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) edges.push(new Edge(pts[i], pts[(i + 1) % n]));

  const verts: Vertex[] = [];
  for (let i = 0; i < n; i++) {
    const eLeft = edges[(i - 1 + n) % n];
    const eRight = edges[i];
    verts.push(new Vertex(pts[i], 0, eLeft, eRight));
  }
  for (let i = 0; i < n; i++) {
    verts[i].prev = verts[(i - 1 + n) % n];
    verts[i].next = verts[(i + 1) % n];
  }

  // Original edges with their endpoints' initial bisectors (bound split targets).
  const origEdges: OrigEdge[] = edges.map((e, i) => ({
    edge: e,
    bisLeft: verts[i].bisector,
    bisRight: verts[(i + 1) % n].bisector,
  }));

  const allVerts: Vertex[] = [...verts];
  const arcs: SkelArc[] = [];
  const sp = (p: P, t: number): SkelPoint => ({ x: p.x, y: p.y, time: t });

  // Simple priority queue: array kept sorted-on-demand.
  const queue: Event[] = [];
  const push = (e: Event | null) => { if (e) queue.push(e); };
  for (const v of verts) push(nextEvent(v, origEdges));

  let guard = 0;
  const maxIter = 100 * n * n + 1000;
  while (queue.length && guard++ < maxIter) {
    // Extract-min.
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].dist < queue[bi].dist) bi = i;
    const ev = queue.splice(bi, 1)[0];

    if (ev.kind === 'edge') {
      const { a, b } = ev;
      if (!a.valid || !b.valid) continue;
      if (a.prev === b.next) {
        // Peak: three vertices collapse to a single node.
        const apex = sp(ev.point, ev.dist);
        arcs.push({ a: sp(a.point, a.time), b: apex });
        arcs.push({ a: sp(b.point, b.time), b: apex });
        arcs.push({ a: sp(a.prev.point, a.prev.time), b: apex });
        a.valid = b.valid = a.prev.valid = false;
        continue;
      }
      a.valid = false;
      b.valid = false;
      const nv = new Vertex(ev.point, ev.dist, a.edgeLeft, b.edgeRight);
      nv.prev = a.prev;
      nv.next = b.next;
      a.prev.next = nv;
      b.next.prev = nv;
      allVerts.push(nv);
      arcs.push({ a: sp(a.point, a.time), b: sp(ev.point, ev.dist) });
      arcs.push({ a: sp(b.point, b.time), b: sp(ev.point, ev.dist) });
      push(nextEvent(nv, origEdges));
    } else {
      // Split event.
      const v = ev.v;
      if (!v.valid) continue;
      // Find the wavefront pair (y, x=y.next) currently owning the opposite edge,
      // such that the split point lies within their bisector wedge.
      let x: Vertex | null = null;
      let y: Vertex | null = null;
      for (const cand of allVerts) {
        if (!cand.valid) continue;
        if (cand.edgeRight !== ev.opp) continue;
        const yy = cand;
        const xx = cand.next;
        if (!xx.valid) continue;
        const inLeft = crossp(norm(yy.bisector.d), norm(sub(ev.point, yy.bisector.o))) > -EPS;
        const inRight = crossp(norm(xx.bisector.d), norm(sub(ev.point, xx.bisector.o))) < EPS;
        if (inLeft && inRight) { y = yy; x = xx; break; }
      }
      if (!x || !y) continue;
      v.valid = false;
      arcs.push({ a: sp(v.point, v.time), b: sp(ev.point, ev.dist) });

      const v1 = new Vertex(ev.point, ev.dist, v.edgeLeft, ev.opp);
      const v2 = new Vertex(ev.point, ev.dist, ev.opp, v.edgeRight);
      // Loop 1: v.prev → v1 → x → … → v.prev
      v1.prev = v.prev; v1.next = x;
      v.prev.next = v1; x.prev = v1;
      // Loop 2: y → v2 → v.next → … → y
      v2.prev = y; v2.next = v.next;
      y.next = v2; v.next.prev = v2;
      allVerts.push(v1, v2);

      // Degenerate 2-vertex loops resolve on their own next edge event.
      push(nextEvent(v1, origEdges));
      push(nextEvent(v2, origEdges));
    }
  }

  return arcs.filter((a) => !eq(a.a, a.b));
}

interface Norm { sc: P[]; s: number; ox: number; oy: number; }

/** Normalise a polygon so its bbox diagonal ≈ TARGET (keeps the wavefront well-conditioned). */
const TARGET_SCALE = 1000;
function normalize(poly: P[]): Norm {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const s = TARGET_SCALE / diag;
  return { sc: poly.map((p) => ({ x: (p.x - minX) * s, y: (p.y - minY) * s })), s, ox: minX, oy: minY };
}

/**
 * Straight-skeleton arcs of a simple polygon (CCW input), in the ORIGINAL
 * coordinate frame. Delegates to the robust solver (sanitize + normalise +
 * tie-break retries) so the arcs always correspond to a valid exact tiling.
 * Returns null on degenerate input.
 */
export function computeStraightSkeleton(polyCcw: P[]): SkelArc[] | null {
  const sol = solveRoofSkeleton(polyCcw);
  return sol ? sol.arcs : null;
}

export interface SkeletonSolution { poly: P[]; arcs: SkelArc[]; faces: SkelPoint[][]; }

/**
 * Robustly solve the straight skeleton AND its faces for an arbitrary simple
 * polygon. Sanitizes, normalises, then retries with escalating symbolic
 * perturbations until the faces form a valid exact tiling (one face per edge,
 * total area == polygon area). Everything is returned in the ORIGINAL frame,
 * with eave-level (ground) vertices snapped back onto the exact contour.
 *
 * Returns null if no perturbation yields a valid tiling — the caller then falls
 * back to a bbox hip/gable rather than rendering a self-intersecting mess.
 */
export function solveRoofSkeleton(polyCcw: P[]): SkeletonSolution | null {
  const clean = sanitizePolygon(polyCcw);
  if (clean.length < 3) return null;
  const nEdges = clean.length;
  const targetArea = Math.abs(polyArea(clean));
  if (targetArea < 1) return null;

  const { sc, s, ox, oy } = normalize(clean);
  const invPt = (p: SkelPoint): SkelPoint => ({ x: p.x / s + ox, y: p.y / s + oy, time: p.time / s });

  // Snap a ground-level (time≈0) vertex back onto the nearest exact contour corner.
  const snapTol = TARGET_SCALE * 5e-3 / s; // ~5mm of working scale in original units
  const snapGround = (p: SkelPoint): SkelPoint => {
    if (p.time > snapTol) return p;
    let best = p as P, bd = snapTol;
    for (const c of clean) { const d = Math.hypot(c.x - p.x, c.y - p.y); if (d < bd) { bd = d; best = c; } }
    return { x: best.x, y: best.y, time: p.time <= snapTol ? 0 : p.time };
  };

  // Attempts: exact first, then tiny deterministic jitters to break event ties.
  const attempts: Array<{ amp: number; seed: number }> = [
    { amp: 0, seed: 0 },
    { amp: 0.02, seed: 1 }, { amp: 0.05, seed: 2 }, { amp: 0.1, seed: 3 },
    { amp: 0.2, seed: 4 }, { amp: 0.4, seed: 5 }, { amp: 0.05, seed: 7 },
    { amp: 0.1, seed: 11 }, { amp: 0.3, seed: 17 }, { amp: 0.5, seed: 23 },
  ];

  for (const { amp, seed } of attempts) {
    const rand = lcg(seed);
    const psc = amp > 0
      ? sc.map((p) => ({ x: p.x + (rand() - 0.5) * amp, y: p.y + (rand() - 0.5) * amp }))
      : sc;
    const arcsS = skeletonRaw(psc);
    if (!arcsS) continue;
    const facesS = extractSkeletonFaces(psc, arcsS);
    if (facesS.length !== nEdges) continue;
    const areaS = facesS.reduce((acc, f) => acc + Math.abs(polyArea(f)), 0) / (s * s);
    if (Math.abs(areaS / targetArea - 1) > 0.01) continue;

    // Valid tiling — map back to original coordinates and snap eave (ground)
    // vertices onto the exact contour corners so hips/valleys meet the walls and
    // the faces share vertices with the polygon boundary exactly.
    const snap = (p: SkelPoint): SkelPoint => snapGround(invPt(p));
    const arcs = arcsS
      .map((a) => ({ a: snap(a.a), b: snap(a.b) }))
      .filter((a) => Math.hypot(a.a.x - a.b.x, a.a.y - a.b.y) > 1e-3);
    const faces = facesS.map((f) => f.map(snap));
    return { poly: clean, arcs, faces };
  }
  return null;
}

/**
 * Recover the roof faces from polygon + skeleton arcs as a planar subdivision.
 * Each bounded interior face corresponds to exactly one polygon edge and is
 * returned as a CCW loop of points carrying their `time` (→ height when lifted).
 * The faces tile the polygon exactly (no overlap, no gaps).
 */
export function extractSkeletonFaces(polyCcw: P[], arcs: SkelArc[]): SkelPoint[][] {
  const key = (p: P) => `${Math.round(p.x * 10)}_${Math.round(p.y * 10)}`;
  const timeOf = new Map<string, number>();
  const coord = new Map<string, P>();
  const setNode = (p: P, t: number) => {
    const k = key(p);
    if (!coord.has(k)) { coord.set(k, { x: p.x, y: p.y }); timeOf.set(k, t); }
    else if (t < (timeOf.get(k) ?? Infinity)) timeOf.set(k, t);
  };

  const n = polyCcw.length;
  for (let i = 0; i < n; i++) setNode(polyCcw[i], 0);
  for (const a of arcs) { setNode(a.a, a.a.time); setNode(a.b, a.b.time); }

  // Undirected edge set (polygon boundary + skeleton arcs), deduped.
  const seen = new Set<string>();
  const undirected: [string, string][] = [];
  const addEdge = (a: P, b: P) => {
    const ka = key(a), kb = key(b);
    if (ka === kb) return;
    const kk = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seen.has(kk)) return;
    seen.add(kk);
    undirected.push([ka, kb]);
  };
  for (let i = 0; i < n; i++) addEdge(polyCcw[i], polyCcw[(i + 1) % n]);
  for (const a of arcs) addEdge(a.a, a.b);

  // Half-edges.
  interface HE { from: string; to: string; angle: number; twin: number; next: number; }
  const he: HE[] = [];
  const idx = new Map<string, number>();
  const addHE = (a: string, b: string) => {
    const ca = coord.get(a)!, cb = coord.get(b)!;
    he.push({ from: a, to: b, angle: Math.atan2(cb.y - ca.y, cb.x - ca.x), twin: -1, next: -1 });
    idx.set(`${a}|${b}`, he.length - 1);
  };
  for (const [a, b] of undirected) { addHE(a, b); addHE(b, a); }
  for (const h of he) h.twin = idx.get(`${h.to}|${h.from}`) ?? -1;

  // Outgoing half-edges per vertex, sorted CCW by angle.
  const out = new Map<string, number[]>();
  for (let i = 0; i < he.length; i++) {
    const f = he[i].from;
    if (!out.has(f)) out.set(f, []);
    out.get(f)!.push(i);
  }
  for (const list of out.values()) list.sort((i, j) => he[i].angle - he[j].angle);

  // next(h) = clockwise neighbour of twin(h) around the target vertex.
  for (let i = 0; i < he.length; i++) {
    const list = out.get(he[i].to)!;
    const tp = list.indexOf(he[i].twin);
    he[i].next = list[(tp - 1 + list.length) % list.length];
  }

  // Trace faces; keep bounded interior loops (CCW, positive area).
  const visited = new Array(he.length).fill(false);
  const faces: SkelPoint[][] = [];
  for (let i = 0; i < he.length; i++) {
    if (visited[i]) continue;
    const loop: number[] = [];
    let cur = i, guard = 0;
    while (!visited[cur] && guard++ < he.length * 4) {
      visited[cur] = true;
      loop.push(cur);
      cur = he[cur].next;
      if (cur === i) break;
    }
    const pts: SkelPoint[] = loop.map((hi) => {
      const k = he[hi].from;
      const c = coord.get(k)!;
      return { x: c.x, y: c.y, time: timeOf.get(k) ?? 0 };
    });
    let ar = 0;
    for (let k = 0; k < pts.length; k++) {
      const j = (k + 1) % pts.length;
      ar += pts[k].x * pts[j].y - pts[j].x * pts[k].y;
    }
    if (ar / 2 > 1) faces.push(pts);
  }
  return faces;
}
