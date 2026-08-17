/**
 * Internal B-rep kernel — planar polygon triangulation.
 *
 * Faces are stored as boundary loops; renderers, area/volume integrals and the
 * eventual IFC tessellated fallback all need triangles. This is a self-contained
 * ear-clipping implementation (with hole bridging) so the kernel keeps no
 * dependency on THREE or any geometry library — the whole point of owning the
 * topology layer.
 *
 * Everything works in the face's own 2D plane basis (see `planeBasis`), which
 * preserves winding, so triangles come out CCW around the face normal.
 */

import type { Loop, Vec2, Vec3, VertexId } from './types';
import { planeBasis, project2, signedArea2 } from './vec';

export type Tri = [VertexId, VertexId, VertexId];

/** Cross product of (b−a) × (c−a) in 2D — twice the signed triangle area. */
function cross2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Inclusive point-in-triangle for a CCW triangle. */
function inTriangle(a: Vec2, b: Vec2, c: Vec2, p: Vec2): boolean {
  return cross2(a, b, p) >= 0 && cross2(b, c, p) >= 0 && cross2(c, a, p) >= 0;
}

function samePoint(a: Vec2, b: Vec2, tol: number): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

/**
 * Ear-clip a **simple** CCW polygon given as vertex ids plus a 2D lookup.
 *
 * The id list may repeat ids — hole bridging duplicates the two vertices it
 * cuts through — so every test here is positional rather than by identity.
 */
function earClip(poly: VertexId[], at: (id: VertexId) => Vec2, tol: number): Tri[] {
  const out: Tri[] = [];
  const ring = [...poly];
  // A polygon of n vertices yields n−2 triangles; the extra headroom absorbs
  // the forced clips below without ever letting the loop run away.
  let guard = ring.length * ring.length + 16;

  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;

    for (let i = 0; i < ring.length; i++) {
      const n = ring.length;
      const iPrev = (i - 1 + n) % n;
      const iNext = (i + 1) % n;
      const a = at(ring[iPrev]), b = at(ring[i]), c = at(ring[iNext]);

      // Convex corner? (CCW polygon → positive cross). Collinear/reflex is not an ear.
      if (cross2(a, b, c) <= tol) continue;

      // No other vertex may lie inside the candidate ear.
      let blocked = false;
      for (let j = 0; j < n && !blocked; j++) {
        if (j === iPrev || j === i || j === iNext) continue;
        const p = at(ring[j]);
        if (samePoint(p, a, tol) || samePoint(p, b, tol) || samePoint(p, c, tol)) continue;
        if (inTriangle(a, b, c, p)) blocked = true;
      }
      if (blocked) continue;

      out.push([ring[iPrev], ring[i], ring[iNext]]);
      ring.splice(i, 1);
      clipped = true;
      break;
    }

    if (clipped) continue;

    // No ear found — the loop is self-intersecting or numerically degenerate.
    // Force-clip the sharpest convex-ish corner so we still emit usable geometry
    // instead of hanging. Slivers get filtered by the zero-area check below.
    let best = -1, bestCross = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const n = ring.length;
      const a = at(ring[(i - 1 + n) % n]), b = at(ring[i]), c = at(ring[(i + 1) % n]);
      const x = cross2(a, b, c);
      if (x > bestCross) { bestCross = x; best = i; }
    }
    if (best < 0) break;
    const n = ring.length;
    out.push([ring[(best - 1 + n) % n], ring[best], ring[(best + 1) % n]]);
    ring.splice(best, 1);
  }

  if (ring.length === 3) out.push([ring[0], ring[1], ring[2]]);

  // Drop zero-area triangles (bridge slivers, welded duplicates).
  return out.filter((t) => Math.abs(cross2(at(t[0]), at(t[1]), at(t[2]))) > tol);
}

/**
 * Find where to cut from the outer loop into a hole, and splice the hole in.
 *
 * Standard ray-cast bridge: from the hole's leftmost vertex M shoot a ray in −X
 * and take the nearest outer edge it hits; the bridge partner is that edge's
 * endpoint, unless some reflex outer vertex sits inside the triangle M–hit–partner,
 * in which case the closest such vertex is used instead (otherwise the bridge
 * would cross the outer boundary).
 *
 * Returns a single simple loop, or `null` if no bridge exists (malformed input).
 */
function bridgeHole(outer: VertexId[], hole: VertexId[], at: (id: VertexId) => Vec2): VertexId[] | null {
  // Leftmost vertex of the hole.
  let hi = 0;
  for (let i = 1; i < hole.length; i++) {
    const p = at(hole[i]), q = at(hole[hi]);
    if (p.x < q.x || (p.x === q.x && p.y < q.y)) hi = i;
  }
  const m = at(hole[hi]);

  // Nearest outer edge hit by the −X ray from m.
  let hitX = -Infinity;
  let partner = -1; // position within `outer`
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    const p = at(outer[i]), q = at(outer[j]);
    if (p.y === q.y) continue;
    // Does the horizontal line y = m.y cross this edge?
    if ((m.y <= p.y && m.y >= q.y) || (m.y >= p.y && m.y <= q.y)) {
      const x = p.x + ((m.y - p.y) * (q.x - p.x)) / (q.y - p.y);
      if (x <= m.x && x > hitX) {
        hitX = x;
        partner = p.x > q.x ? i : j; // the endpoint nearer the ray origin
      }
    }
  }
  if (partner < 0) return null;

  // Any reflex outer vertex inside the triangle m–(hitX, m.y)–partner would make
  // the naive bridge cross the boundary; prefer the closest such vertex.
  const hit: Vec2 = { x: hitX, y: m.y };
  const pv = at(outer[partner]);
  let bestPos = partner, bestD = Infinity;
  for (let i = 0; i < outer.length; i++) {
    if (i === partner) continue;
    const p = at(outer[i]);
    if (p.x > m.x || p.x < hitX) continue;
    if (!inTriangle(hit, pv, m, p) && !inTriangle(hit, m, pv, p)) continue;
    const d = (p.x - m.x) ** 2 + (p.y - m.y) ** 2;
    if (d < bestD) { bestD = d; bestPos = i; }
  }

  const rotated = [...hole.slice(hi), ...hole.slice(0, hi)];
  return [
    ...outer.slice(0, bestPos + 1),
    ...rotated,
    rotated[0],
    outer[bestPos],
    ...outer.slice(bestPos + 1),
  ];
}

/**
 * Triangulate one planar face.
 *
 * @param points Vertex pool; loops index into it.
 * @param outer  Boundary loop, CCW around `normal`.
 * @param holes  Inner loops, wound the opposite way. Bridged into `outer` before clipping.
 * @param normal Face normal — fixes the plane and the output winding.
 * @returns Triangles as vertex ids, CCW around `normal`.
 */
export function triangulateFace(
  points: Vec3[],
  outer: Loop,
  holes: Loop[] | undefined,
  normal: Vec3,
  tol = 1e-9,
): Tri[] {
  if (outer.length < 3) return [];

  const { u, v } = planeBasis(normal);
  const flat = new Map<VertexId, Vec2>();
  const at = (id: VertexId): Vec2 => {
    let p = flat.get(id);
    if (!p) { p = project2(points[id], u, v); flat.set(id, p); }
    return p;
  };

  // The plane basis preserves orientation, so a loop wound CCW around `normal`
  // projects to positive signed area. Normalise both windings defensively —
  // a builder that got one backwards should still tessellate, not vanish.
  let ring = signedArea2(outer.map(at)) < 0 ? [...outer].reverse() : [...outer];

  for (const hole of holes ?? []) {
    if (hole.length < 3) continue;
    const h = signedArea2(hole.map(at)) > 0 ? [...hole].reverse() : [...hole];
    const merged = bridgeHole(ring, h, at);
    if (merged) ring = merged;
  }

  return earClip(ring, at, tol);
}
