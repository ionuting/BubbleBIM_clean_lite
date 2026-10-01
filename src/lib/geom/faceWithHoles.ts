/**
 * faceWithHoles.ts — a planar face bounded by one outer ring and any number
 * of inner rings (holes), and the triangles that cover it.
 *
 * Conventions, fixed here once so every consumer agrees:
 *
 *   • the OUTER ring is counter-clockwise, the HOLES clockwise. Stitching side
 *     quads between two copies of a ring (`solidTriangles`) then gives every
 *     wall an outward normal with no special case: an outer wall faces away
 *     from the material, a hole wall faces into the hole — which is away from
 *     the material too.
 *   • triangles index the CONCATENATED point list: outer ring first, then each
 *     hole in order. A solid whose rings are built point-for-point from these
 *     rings can reuse the indices at every station.
 *
 * The triangulation is earcut's — the same one three uses inside
 * `ShapeUtils`, taken directly so this stays free of three: `sweep/rings.ts`
 * imports it and is called by the Inspector on every render. The ear clipper
 * there handles simple polygons only, and bridging holes into it by hand is
 * where triangulators go wrong.
 */
import earcut from 'earcut';
import { isSimplePolygon, pointInPolygon, polygonArea, type Pt2 } from './plan2d';

export type Tri = [number, number, number];

/** Counter-clockwise, reversing only when needed. */
export const ccw = (ring: Pt2[]): Pt2[] => (polygonArea(ring) < 0 ? [...ring].reverse() : ring);
/** Clockwise, reversing only when needed. */
export const cw = (ring: Pt2[]): Pt2[] => (polygonArea(ring) > 0 ? [...ring].reverse() : ring);

/**
 * Triangles covering the outer ring minus the holes, indexing
 * `[...outer, ...holes[0], ...holes[1], …]`. The rings are used as given —
 * wind them with `ccw` / `cw` first so the indices match the solid.
 */
export function triangulateFace(outer: Pt2[], holes: Pt2[][] = []): Tri[] {
  if (outer.length < 3) return [];
  const coords: number[] = [];
  const holeStarts: number[] = [];
  for (const p of outer) coords.push(p.x, p.y);
  for (const h of holes) {
    holeStarts.push(coords.length / 2);
    for (const p of h) coords.push(p.x, p.y);
  }
  const idx = earcut(coords, holeStarts.length ? holeStarts : null, 2);
  const tris: Tri[] = [];
  // earcut winds its triangles by the input: re-wind each one CCW so a cap
  // built from them faces +Z before `solidTriangles` flips the start cap.
  const at = (i: number) => ({ x: coords[2 * i], y: coords[2 * i + 1] });
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const A = at(a), B = at(b), C = at(c);
    const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
    tris.push(cross >= 0 ? [a, b, c] : [a, c, b]);
  }
  return tris;
}

/** Area of the face, holes subtracted, unsigned. */
export function faceArea(outer: Pt2[], holes: Pt2[][] = []): number {
  let a = Math.abs(polygonArea(outer));
  for (const h of holes) a -= Math.abs(polygonArea(h));
  return Math.max(0, a);
}

/** Total length of every boundary — the outer ring and each hole. */
export function facePerimeter(outer: Pt2[], holes: Pt2[][] = []): number {
  const ring = (r: Pt2[]) => {
    let s = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      s += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return r.length >= 2 ? s : 0;
  };
  return [outer, ...holes].reduce((s, r) => s + ring(r), 0);
}

const segsCross = (a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean => {
  const o = (p: Pt2, q: Pt2, r: Pt2) => (r.x - p.x) * (q.y - p.y) - (q.x - p.x) * (r.y - p.y);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

/** True when no edge of `a` properly crosses an edge of `b`. */
function ringsDisjointEdges(a: Pt2[], b: Pt2[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segsCross(p, q, b[j], b[(j + 1) % b.length])) return false;
    }
  }
  return true;
}

export type HoleProblem = 'too_few_points' | 'not_simple' | 'outside' | 'overlaps';

export interface HoleCheck {
  /** The holes that can be cut, in the order given. */
  valid: number[];
  /** The ones that cannot, and why. */
  rejected: { index: number; problem: HoleProblem }[];
}

/**
 * Which holes can actually be cut out of `outer`.
 *
 * A hole must be a simple ring lying strictly inside the outer one, and must
 * not cross or contain another hole already accepted. A rejected hole is
 * reported, not silently dropped — the caller turns it into a diagnostic.
 * Points ON the outer boundary count as outside: a "hole" touching the edge is
 * a notch, which is a different outline, not a hole.
 */
export function checkHoles(outer: Pt2[], holes: Pt2[][]): HoleCheck {
  const valid: number[] = [];
  const rejected: HoleCheck['rejected'] = [];
  holes.forEach((h, index) => {
    if (h.length < 3 || Math.abs(polygonArea(h)) < 1) { rejected.push({ index, problem: 'too_few_points' }); return; }
    if (!isSimplePolygon(h)) { rejected.push({ index, problem: 'not_simple' }); return; }
    const inside = h.every((p) => pointInPolygon(p, outer, -1) && !onRing(p, outer))
      && ringsDisjointEdges(h, outer);
    if (!inside) { rejected.push({ index, problem: 'outside' }); return; }
    for (const k of valid) {
      const o = holes[k];
      if (!ringsDisjointEdges(h, o) || pointInPolygon(h[0], o, 0) || pointInPolygon(o[0], h, 0)) {
        rejected.push({ index, problem: 'overlaps' });
        return;
      }
    }
    valid.push(index);
  });
  return { valid, rejected };
}

/** Within 0.5 mm of an edge of the ring. */
function onRing(p: Pt2, ring: Pt2[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    if (Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) <= 0.5) return true;
  }
  return false;
}
