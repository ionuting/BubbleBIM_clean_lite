/**
 * triangulate.ts — a CityJSON surface as triangles.
 *
 * A CityJSON surface is a list of rings: the first is the outline, the rest
 * are holes in it — a courtyard through a block, an opening through a wall.
 * The rings are 3D and planar, and GPUs draw triangles, so somebody has to
 * do this.
 *
 * `earcut` would, and Cesium bundles a copy of it, but not one this project
 * can import: pnpm's layout puts a transitive dependency out of reach, and
 * reaching for it anyway is the kind of thing that works until an install.
 * Pulling the whole polygon pipeline out of Cesium for it would tie the
 * CityJSON parser to a viewer it otherwise knows nothing about — and the
 * parser's tests would then need a WebGL context to check arithmetic. So it
 * is here, in about a hundred lines, and it is tested on its own.
 *
 * ## The method
 *
 * Ear clipping, with holes bridged into the outline first. The polygon is
 * planar in 3D, so it is projected to 2D by dropping the axis its normal
 * points most strongly along — the one projection that cannot collapse it —
 * with the sign chosen so that a ring wound counter-clockwise about the
 * normal stays counter-clockwise on the page.
 */

/** A point in whatever space the caller is working in. */
export interface P3 { x: number; y: number; z: number }

interface P2 { x: number; y: number; i: number }

const EPS = 1e-12;

/**
 * The polygon's normal, by Newell's method.
 *
 * Not a cross product of the first three corners: a ring that starts with
 * three collinear points is common in exported geometry (a wall split at a
 * floor level), and a cross product there is zero.
 */
export function ringNormal(ring: P3[]): P3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const m = Math.hypot(nx, ny, nz);
  return m < EPS ? { x: 0, y: 0, z: 1 } : { x: nx / m, y: ny / m, z: nz / m };
}

/**
 * Project onto the plane, keeping the winding.
 *
 * The axis dropped is the one the normal is most aligned with, because that
 * is the projection with the most area left to work with — dropping any
 * other can squash the polygon to a line. The remaining two axes are ordered
 * so the 2D winding matches the 3D winding about the normal; get that
 * backwards and every ear test is inverted, which triangulates the outside.
 */
function projector(n: P3): (p: P3) => { x: number; y: number } {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  if (az >= ax && az >= ay) {
    return n.z > 0 ? (p) => ({ x: p.x, y: p.y }) : (p) => ({ x: p.y, y: p.x });
  }
  if (ax >= ay) {
    return n.x > 0 ? (p) => ({ x: p.y, y: p.z }) : (p) => ({ x: p.z, y: p.y });
  }
  return n.y > 0 ? (p) => ({ x: p.z, y: p.x }) : (p) => ({ x: p.x, y: p.z });
}

/** Twice the signed area by the shoelace rule: POSITIVE when counter-clockwise. */
const area2 = (poly: P2[]): number => {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return a;
};

/** Positive when a→b→c turns left. Everything here is wound counter-clockwise. */
const cross = (a: P2, b: P2, c: P2): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** Inside a counter-clockwise triangle, edges included. */
function inTriangle(a: P2, b: P2, c: P2, p: P2): boolean {
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
}

/** Inside a triangle of either winding — the bridge search does not control it. */
function inTriangleEither(a: P2, b: P2, c: P2, p: P2): boolean {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/**
 * Where to cut the outline open so a hole can be let in.
 *
 * A horizontal ray runs left from the hole's leftmost point; the outline edge
 * it first crosses gives the bridge, taking that edge's rightmost end. Any
 * outline vertex that falls inside the triangle between the two is a closer
 * candidate and wins — without that check the bridge can be drawn straight
 * through a spur of the outline, which leaves a self-intersecting polygon and
 * an unclippable ear.
 */
function findBridge(hole: P2[], outer: P2[]): number {
  let hi = 0;
  for (let i = 1; i < hole.length; i++) if (hole[i].x < hole[hi].x) hi = i;
  const h = hole[hi];

  let bestX = -Infinity, m = -1;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const a = outer[j], b = outer[i];
    if ((h.y <= a.y) === (h.y <= b.y)) continue;      // ray misses this edge
    const x = a.x + ((h.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (x > h.x) continue;                            // the ray runs LEFT
    if (x > bestX) { bestX = x; m = a.x > b.x ? j : i; }
  }
  if (m < 0) return 0;                                // degenerate; cut anywhere

  // Refine: any outline vertex inside the triangle (hole point, ray hit,
  // bridge end) sits between the two, so bridging to the first one instead
  // keeps the cut clear of the outline.
  const q: P2 = { x: bestX, y: h.y, i: -1 };
  const mv = outer[m];
  let bestTan = Infinity;
  let best = m;
  for (let i = 0; i < outer.length; i++) {
    const p = outer[i];
    if (p.x > h.x || p.x < q.x) continue;
    if (!inTriangleEither(h, q, mv, p)) continue;
    const tan = Math.abs(h.y - p.y) / (h.x - p.x || EPS);
    if (tan < bestTan) { bestTan = tan; best = i; }
  }
  return best;
}

/** Splice every hole into the outline, leaving one simple polygon. */
function bridgeHoles(outer: P2[], holes: P2[][]): P2[] {
  // Left to right: a hole bridged early must not sit across a later bridge.
  const queue = holes
    .filter((h) => h.length >= 3)
    .map((h) => ({ h, x: Math.min(...h.map((p) => p.x)) }))
    .sort((a, b) => a.x - b.x);

  let poly = outer;
  for (const { h } of queue) {
    let hi = 0;
    for (let i = 1; i < h.length; i++) if (h[i].x < h[hi].x) hi = i;
    const at = findBridge(h, poly);
    const ring = [...h.slice(hi), ...h.slice(0, hi)];
    // The hole runs the other way round, so the bridge crosses rather than
    // doubles back on itself.
    poly = [
      ...poly.slice(0, at + 1),
      ...ring, ring[0],
      ...poly.slice(at),
    ];
  }
  return poly;
}

/**
 * Triangulate one planar surface.
 *
 * `rings[0]` is the outline and the rest are holes, which is CityJSON's own
 * convention. Returns indices into the CONCATENATION of the rings, so the
 * caller keeps its own vertices and never has to match them back up.
 *
 * A ring that repeats its first point at the end is accepted: the CityJSON
 * spec says rings are not closed, and plenty of writers close them anyway.
 */
export function triangulateSurface(rings: P3[][]): number[] {
  if (rings.length === 0 || rings[0].length < 3) return [];

  // Strip a repeated closing vertex, and remember where each ring starts in
  // the concatenated numbering the caller will use.
  const offsets: number[] = [];
  const open: P3[][] = [];
  let base = 0;
  for (const r of rings) {
    offsets.push(base);
    base += r.length;
    const last = r[r.length - 1], first = r[0];
    const closed = r.length > 3
      && Math.abs(last.x - first.x) < 1e-9
      && Math.abs(last.y - first.y) < 1e-9
      && Math.abs(last.z - first.z) < 1e-9;
    open.push(closed ? r.slice(0, -1) : r);
  }
  if (open[0].length < 3) return [];

  const to2 = projector(ringNormal(open[0]));
  const ringsOf = (r: P3[], off: number): P2[] =>
    r.map((p, i) => ({ ...to2(p), i: off + i }));

  // The ear clipper works counter-clockwise, and a hole has to run against
  // its outline or the bridge doubles back instead of crossing.
  let outer = ringsOf(open[0], offsets[0]);
  if (area2(outer) < 0) outer = outer.reverse();

  const holes = open.slice(1).map((r, k) => {
    let h = ringsOf(r, offsets[k + 1]);
    if (area2(h) > 0) h = h.reverse();
    return h;
  });

  const poly = holes.length ? bridgeHoles(outer, holes) : outer;
  return earClip(poly);
}

/**
 * Ear clipping.
 *
 * Quadratic in the worst case, which is fine: a CityJSON surface is a wall or
 * a roof plane, not a coastline. A vertex that cannot be clipped is skipped
 * rather than fatal — a surface with a fold in it still contributes the
 * triangles it can, which is a better drawing than none.
 */
function earClip(poly: P2[]): number[] {
  const out: number[] = [];
  const v = [...poly];
  let guard = v.length * v.length + 16;

  while (v.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < v.length; i++) {
      const a = v[(i + v.length - 1) % v.length];
      const b = v[i];
      const c = v[(i + 1) % v.length];
      if (cross(a, b, c) <= 0) continue;              // reflex or collinear
      let ok = true;
      for (const p of v) {
        if (p === a || p === b || p === c) continue;
        if (inTriangle(a, b, c, p)) { ok = false; break; }
      }
      if (!ok) continue;
      out.push(a.i, b.i, c.i);
      v.splice(i, 1);
      clipped = true;
      break;
    }
    // No ear anywhere: the ring is degenerate or self-touching. Drop the
    // sharpest corner and carry on rather than spin.
    if (!clipped) v.splice(1, 1);
  }
  if (v.length === 3) out.push(v[0].i, v[1].i, v[2].i);
  return out;
}
