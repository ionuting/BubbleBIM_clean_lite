/**
 * Internal B-rep kernel — triangle-mesh round trip.
 *
 * Every boolean engine worth using speaks triangle meshes, not B-rep. This
 * module is the lossy-in / lossless-out boundary:
 *
 *   Solid ──toIndexedMesh──▶ IndexedMesh ──engine──▶ IndexedMesh ──solidFromMesh──▶ Solid
 *
 * The return leg is the part that matters. A naive round trip would leave a
 * cut wall as ~40 loose triangles — no faces, no edges, nothing to tag, measure
 * per-surface, or map to an IFC entity. `solidFromMesh` reassembles coplanar
 * triangle regions back into real faces WITH holes, so a wall with a window
 * comes back as one rectangular face carrying one rectangular hole.
 *
 * That reconstruction is why the kernel stays ours even though the boolean math
 * is borrowed: the engine is a numeric subroutine, not the model.
 */

import { TOL_DIST, type Face, type Loop, type Solid, type Vec3, type VertexId } from './types';
import { cross, dot, len, normalize, scale, sub } from './vec';
import { makeSolid, weldVertices, type FaceInput } from './solid';
import { triangulateFace } from './triangulate';

/**
 * A welded, indexed triangle mesh in BIM mm.
 *
 * Triangles are wound CCW seen from outside — the same convention as `Face.outer`
 * and, conveniently, as manifold-3d's `triVerts`.
 */
export interface IndexedMesh {
  /** Flat xyz triples. */
  positions: Float64Array;
  /** Flat vertex-index triples. */
  triangles: Uint32Array;
}

// ─── Solid → mesh ─────────────────────────────────────────────────────────────

/**
 * Triangulate a solid into a welded indexed mesh.
 *
 * Distinct from `tessellate()`, which duplicates vertices per face for flat
 * shading: a boolean engine needs SHARED vertices or it sees a pile of
 * disconnected shells rather than a closed solid.
 */
export function toIndexedMesh(solid: Solid): IndexedMesh {
  const positions = new Float64Array(solid.vertices.length * 3);
  solid.vertices.forEach((p, i) => {
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
  });

  const tris: number[] = [];
  for (const f of solid.faces) {
    for (const [a, b, c] of triangulateFace(solid.vertices, f.outer, f.holes, f.normal)) {
      tris.push(a, b, c);
    }
  }

  return { positions, triangles: new Uint32Array(tris) };
}

// ─── Mesh → solid ─────────────────────────────────────────────────────────────

export interface RebuildOptions {
  /** Vertex weld distance (mm). Default `TOL_DIST`. */
  weldTol?: number;
  /**
   * Two adjacent triangles join the same face when their normals differ by less
   * than this angle (degrees) AND their planes coincide within `weldTol`.
   * Default 0.1° — tight enough to keep a 64-sided cylinder's facets distinct.
   */
  coplanarAngleDeg?: number;
  /**
   * A loop vertex is dropped when it sits closer than this (mm) to the straight
   * line through its neighbours. Default `weldTol`. This is what turns the
   * engine's fan of triangles back into a clean 4-vertex quad.
   */
  collinearTol?: number;
  tag?: string;
}

/**
 * Rebuild a `Solid` from a triangle mesh, merging coplanar regions into faces.
 *
 * Steps: weld → per-triangle planes → flood-fill coplanar neighbours → extract
 * each region's boundary loops → drop collinear vertices → classify outer vs
 * holes by area.
 *
 * Returns a solid with no faces if the input is empty or fully degenerate;
 * callers should run `validateSolid` when it matters.
 */
export function solidFromMesh(mesh: IndexedMesh, opts: RebuildOptions = {}): Solid {
  const weldTol = opts.weldTol ?? TOL_DIST;
  const collinearTol = opts.collinearTol ?? weldTol;
  const cosTol = Math.cos(((opts.coplanarAngleDeg ?? 0.1) * Math.PI) / 180);

  // ── Weld ────────────────────────────────────────────────────────────────────
  const raw: Vec3[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    raw.push({ x: mesh.positions[i], y: mesh.positions[i + 1], z: mesh.positions[i + 2] });
  }
  const { vertices, remap } = weldVertices(raw, weldTol);

  interface TriInfo { v: [VertexId, VertexId, VertexId]; n: Vec3; d: number }
  const tris: TriInfo[] = [];
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const a = remap[mesh.triangles[t]], b = remap[mesh.triangles[t + 1]], c = remap[mesh.triangles[t + 2]];
    if (a === b || b === c || a === c) continue; // collapsed by welding
    const pa = vertices[a];
    const nRaw = cross(sub(vertices[b], pa), sub(vertices[c], pa));
    const l = len(nRaw);
    if (l < 1e-12) continue; // zero-area sliver
    const n = scale(nRaw, 1 / l);
    tris.push({ v: [a, b, c], n, d: dot(n, pa) });
  }
  if (tris.length === 0) return { vertices: [], faces: [], ...(opts.tag ? { tag: opts.tag } : {}) };

  // ── Triangle adjacency over shared edges ───────────────────────────────────
  const key = (a: VertexId, b: VertexId) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const edgeTris = new Map<string, number[]>();
  tris.forEach((tri, i) => {
    for (let e = 0; e < 3; e++) {
      const k = key(tri.v[e], tri.v[(e + 1) % 3]);
      const b = edgeTris.get(k);
      if (b) b.push(i); else edgeTris.set(k, [i]);
    }
  });

  // ── Flood-fill coplanar regions ────────────────────────────────────────────
  const region = new Int32Array(tris.length).fill(-1);
  const regions: number[][] = [];
  for (let seed = 0; seed < tris.length; seed++) {
    if (region[seed] >= 0) continue;
    const id = regions.length;
    const members: number[] = [];
    const stack = [seed];
    region[seed] = id;

    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      const ti = tris[i];
      for (let e = 0; e < 3; e++) {
        for (const j of edgeTris.get(key(ti.v[e], ti.v[(e + 1) % 3])) ?? []) {
          if (region[j] >= 0) continue;
          const tj = tris[j];
          // Same plane: parallel normals AND equal offset. Both checks are
          // needed — parallel alone would merge a slab's top and bottom faces.
          if (dot(ti.n, tj.n) < cosTol) continue;
          if (Math.abs(ti.d - tj.d) > weldTol) continue;
          region[j] = id;
          stack.push(j);
        }
      }
    }
    regions.push(members);
  }

  // ── Region → face ──────────────────────────────────────────────────────────
  const faces: FaceInput[] = [];
  for (const members of regions) {
    // Area-weighted normal: more stable than any single triangle's.
    let nx = 0, ny = 0, nz = 0;
    for (const i of members) {
      const t = tris[i];
      const a = vertices[t.v[0]], b = vertices[t.v[1]], c = vertices[t.v[2]];
      const w = len(cross(sub(b, a), sub(c, a))) / 2;
      nx += t.n.x * w; ny += t.n.y * w; nz += t.n.z * w;
    }
    const normal = normalize({ x: nx, y: ny, z: nz });
    if (len(normal) < 0.5) continue;

    const loops = boundaryLoops(members, tris, vertices, collinearTol);
    if (loops.length === 0) continue;

    // Largest loop is the outer boundary; the rest are holes inside it.
    const withArea = loops.map((l) => ({ loop: l, area: Math.abs(loopArea(l, vertices, normal)) }));
    withArea.sort((a, b) => b.area - a.area);
    const outer = withArea[0].loop;
    const holes = withArea.slice(1).map((h) => h.loop).filter((h) => h.length >= 3);

    faces.push({
      outer,
      ...(holes.length ? { holes } : {}),
      normal, // makeSolid reorients the winding to match
      ...(opts.tag ? { tag: opts.tag } : {}),
    });
  }

  return makeSolid(vertices, faces, { tol: weldTol, ...(opts.tag ? { tag: opts.tag } : {}) });
}

/**
 * Boundary loops of a coplanar triangle region.
 *
 * Directed interior edges appear twice in opposite directions and cancel; what
 * survives is the region's boundary, already consistently oriented. (Same trick
 * `traceCellBoundary` uses for room grids.)
 */
function boundaryLoops(
  members: number[],
  tris: { v: [VertexId, VertexId, VertexId] }[],
  vertices: Vec3[],
  collinearTol: number,
): Loop[] {
  const dir = new Map<string, [VertexId, VertexId]>();
  const add = (a: VertexId, b: VertexId) => {
    const rev = `${b}>${a}`;
    if (dir.has(rev)) { dir.delete(rev); return; } // interior edge cancels
    dir.set(`${a}>${b}`, [a, b]);
  };
  for (const i of members) {
    const [a, b, c] = tris[i].v;
    add(a, b); add(b, c); add(c, a);
  }
  if (dir.size === 0) return [];

  // A vertex may be the start of several boundary edges when a region pinches;
  // a multimap plus pop-as-you-go keeps each edge used exactly once.
  const outgoing = new Map<VertexId, VertexId[]>();
  for (const [a, b] of dir.values()) {
    const l = outgoing.get(a);
    if (l) l.push(b); else outgoing.set(a, [b]);
  }

  const loops: Loop[] = [];
  const totalEdges = dir.size;
  let used = 0;
  let guard = totalEdges + 8;

  while (used < totalEdges && guard-- > 0) {
    let start = -1;
    for (const [v, tos] of outgoing) if (tos.length) { start = v; break; }
    if (start < 0) break;

    const loop: Loop = [];
    let cur = start;
    // Bound by the region's total edge count, which is fixed — bounding by the
    // remaining count would shrink underneath the walk and truncate the loop
    // one step before it closes.
    for (let step = 0; step < totalEdges; step++) {
      const tos = outgoing.get(cur);
      if (!tos || tos.length === 0) break;
      const next = tos.pop()!;
      used++;
      loop.push(cur);
      cur = next;
      if (cur === start) break;
    }
    const cleaned = dropCollinear(loop, vertices, collinearTol);
    if (cleaned.length >= 3) loops.push(cleaned);
  }

  return loops;
}

/** Remove vertices that lie on the straight line between their neighbours. */
function dropCollinear(loop: Loop, vertices: Vec3[], tol: number): Loop {
  if (loop.length < 3) return loop;
  const keep: Loop = [];
  for (let i = 0; i < loop.length; i++) {
    const a = vertices[loop[(i - 1 + loop.length) % loop.length]];
    const b = vertices[loop[i]];
    const c = vertices[loop[(i + 1) % loop.length]];
    const ab = sub(b, a), ac = sub(c, a);
    const acLen = len(ac);
    // Perpendicular distance from b to line a→c.
    const d = acLen > 1e-12 ? len(cross(ab, ac)) / acLen : len(ab);
    if (d > tol) keep.push(loop[i]);
  }
  return keep.length >= 3 ? keep : loop;
}

/** Signed area of a planar loop, measured in the plane of `normal`. */
function loopArea(loop: Loop, vertices: Vec3[], normal: Vec3): number {
  let ax = 0, ay = 0, az = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = vertices[loop[i]], q = vertices[loop[(i + 1) % loop.length]];
    const c = cross(p, q);
    ax += c.x; ay += c.y; az += c.z;
  }
  return dot({ x: ax / 2, y: ay / 2, z: az / 2 }, normal);
}

/** Faces a solid carries, grouped by tag — handy for asserting reconstruction in tests. */
export function faceTagCounts(solid: Solid): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of solid.faces as Face[]) {
    const k = f.tag ?? '(untagged)';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
