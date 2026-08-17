/**
 * Internal B-rep kernel — solid construction, half-edge topology, validation.
 *
 * `makeSolid` is the only supported way to build a `Solid`. It welds coincident
 * vertices, drops degenerate loops and derives face normals, because every stage
 * downstream (topology, triangulation, and later the boolean engine) assumes a
 * clean vertex pool — hand-assembled solids are where "works in the viewer,
 * explodes in the boolean" bugs come from.
 */

import {
  TOL_AREA, TOL_DIST, TOL_PLANAR,
  type BrepDiagnostic, type Face, type Loop, type Solid, type Topology, type Vec3, type VertexId,
} from './types';
import { dist2, len, newellNormal, normalize, scale } from './vec';
import { facePlanarity, signedVolume } from './measure';

/** Face description accepted by `makeSolid` — `normal` optional, derived when absent. */
export interface FaceInput {
  outer: Loop;
  holes?: Loop[];
  /**
   * Intended outward direction. Only its SIGN is used: if it disagrees with the
   * loop winding, `makeSolid` reverses the loops rather than trusting either one
   * blindly. Omit it when the winding is already known to be correct.
   */
  normal?: Vec3;
  tag?: string;
}

// ─── Vertex welding ───────────────────────────────────────────────────────────

/**
 * Merge points within `tol` into a single vertex, via a uniform spatial hash.
 * The 3×3×3 neighbour sweep is what makes it correct for points that straddle a
 * cell boundary — a plain "round the coordinates" hash silently misses those.
 */
export function weldVertices(pts: Vec3[], tol: number): { vertices: Vec3[]; remap: number[] } {
  const cell = Math.max(tol, 1e-9);
  const buckets = new Map<string, VertexId[]>();
  const vertices: Vec3[] = [];
  const remap: number[] = new Array(pts.length);
  const tol2 = tol * tol;

  for (let n = 0; n < pts.length; n++) {
    const p = pts[n];
    const ci = Math.floor(p.x / cell), cj = Math.floor(p.y / cell), ck = Math.floor(p.z / cell);

    let found = -1;
    for (let di = -1; di <= 1 && found < 0; di++) {
      for (let dj = -1; dj <= 1 && found < 0; dj++) {
        for (let dk = -1; dk <= 1 && found < 0; dk++) {
          const bucket = buckets.get(`${ci + di}_${cj + dj}_${ck + dk}`);
          if (!bucket) continue;
          for (const vi of bucket) {
            if (dist2(vertices[vi], p) <= tol2) { found = vi; break; }
          }
        }
      }
    }

    if (found < 0) {
      found = vertices.length;
      vertices.push(p);
      const k = `${ci}_${cj}_${ck}`;
      const b = buckets.get(k);
      if (b) b.push(found); else buckets.set(k, [found]);
    }
    remap[n] = found;
  }

  return { vertices, remap };
}

/** Remap a loop through the weld table and collapse repeated vertices (including the wrap). */
function cleanLoop(loop: Loop, remap: number[]): Loop {
  const out: Loop = [];
  for (const id of loop) {
    const v = remap[id];
    if (v === undefined) continue;
    if (out.length && out[out.length - 1] === v) continue;
    out.push(v);
  }
  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

// ─── Construction ─────────────────────────────────────────────────────────────

/**
 * Build a validated-shape `Solid` from a raw vertex pool and face loops.
 *
 * Loops must be wound CCW seen from OUTSIDE (holes the opposite way). Faces that
 * collapse below `TOL_AREA` after welding are dropped silently — they are an
 * expected by-product of zero-length wall segments and coincident ax nodes, not
 * an error worth surfacing.
 *
 * Note that welding and compaction RENUMBER the vertices: ids are meaningful
 * only within the returned solid, never across two calls or against the input.
 */
export function makeSolid(
  vertices: Vec3[],
  faces: FaceInput[],
  opts: { tag?: string; tol?: number } = {},
): Solid {
  const tol = opts.tol ?? TOL_DIST;
  const welded = weldVertices(vertices, tol);

  const outFaces: Face[] = [];
  for (const f of faces) {
    const outer = cleanLoop(f.outer, welded.remap);
    if (outer.length < 3) continue;

    const raw = newellNormal(outer.map((i) => welded.vertices[i]));
    const area = len(raw);
    if (area < TOL_AREA) continue;

    let normal = scale(raw, 1 / area);
    let loops = { outer, holes: (f.holes ?? []).map((h) => cleanLoop(h, welded.remap)).filter((h) => h.length >= 3) };

    // Caller's normal is authoritative for orientation: flip the winding to match.
    if (f.normal) {
      const want = normalize(f.normal);
      if (normal.x * want.x + normal.y * want.y + normal.z * want.z < 0) {
        normal = scale(normal, -1);
        loops = { outer: [...loops.outer].reverse(), holes: loops.holes.map((h) => [...h].reverse()) };
      }
    }

    outFaces.push({
      outer: loops.outer,
      ...(loops.holes.length ? { holes: loops.holes } : {}),
      normal,
      ...(f.tag ? { tag: f.tag } : {}),
    });
  }

  return compact({ vertices: welded.vertices, faces: outFaces, ...(opts.tag ? { tag: opts.tag } : {}) });
}

/** Drop vertices no face references, renumbering the loops. */
function compact(solid: Solid): Solid {
  const used = new Map<VertexId, VertexId>();
  const vertices: Vec3[] = [];
  const idOf = (v: VertexId): VertexId => {
    let n = used.get(v);
    if (n === undefined) { n = vertices.length; vertices.push(solid.vertices[v]); used.set(v, n); }
    return n;
  };
  const faces = solid.faces.map((f) => ({
    ...f,
    outer: f.outer.map(idOf),
    ...(f.holes ? { holes: f.holes.map((h) => h.map(idOf)) } : {}),
  }));
  return { ...solid, vertices, faces };
}

// ─── Transforms ───────────────────────────────────────────────────────────────

/** Translate a solid by a delta in BIM mm. Normals are unchanged. */
export function translateSolid(solid: Solid, d: Vec3): Solid {
  return {
    ...solid,
    vertices: solid.vertices.map((p) => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z })),
  };
}

/**
 * Map every vertex through `fn` and re-derive the normals.
 *
 * A mirroring transform turns the solid inside out, which shows up as a negative
 * volume; that case is repaired by flipping rather than left for a downstream
 * boolean to choke on.
 */
export function transformSolid(solid: Solid, fn: (p: Vec3) => Vec3): Solid {
  const moved: Solid = {
    ...solid,
    vertices: solid.vertices.map(fn),
  };
  const faces = moved.faces.map((f) => {
    const raw = newellNormal(f.outer.map((i) => moved.vertices[i]));
    const a = len(raw);
    return { ...f, normal: a > 0 ? scale(raw, 1 / a) : f.normal };
  });
  const out: Solid = { ...moved, faces };
  return signedVolume(out) < 0 ? flipSolid(out) : out;
}

/** Reverse every face — turns the solid inside out. */
export function flipSolid(solid: Solid): Solid {
  return {
    ...solid,
    faces: solid.faces.map((f) => ({
      ...f,
      outer: [...f.outer].reverse(),
      ...(f.holes ? { holes: f.holes.map((h) => [...h].reverse()) } : {}),
      normal: scale(f.normal, -1),
    })),
  };
}

// ─── Half-edge topology ───────────────────────────────────────────────────────

const edgeKey = (a: VertexId, b: VertexId): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * Derive the half-edge structure: one directed edge per loop step, twinned with
 * the matching edge on the neighbouring face.
 *
 * Kept out of `Solid` deliberately — it is fully derivable, and caching it would
 * mean every transform and boolean has to remember to invalidate it.
 */
export function buildTopology(solid: Solid): Topology {
  const halfEdges: Topology['halfEdges'] = [];
  const byEdge = new Map<string, number[]>();

  solid.faces.forEach((f, fi) => {
    const loops: Loop[] = [f.outer, ...(f.holes ?? [])];
    loops.forEach((loop, li) => {
      const base = halfEdges.length;
      for (let i = 0; i < loop.length; i++) {
        const from = loop[i];
        const to = loop[(i + 1) % loop.length];
        const idx = halfEdges.length;
        halfEdges.push({ from, to, face: fi, loop: li, next: base + ((i + 1) % loop.length), twin: -1 });
        const k = edgeKey(from, to);
        const b = byEdge.get(k);
        if (b) b.push(idx); else byEdge.set(k, [idx]);
      }
    });
  });

  // Pair up opposite-direction half-edges.
  for (const uses of byEdge.values()) {
    if (uses.length !== 2) continue;
    const [a, b] = uses;
    const ha = halfEdges[a], hb = halfEdges[b];
    if (ha.from === hb.to && ha.to === hb.from) { ha.twin = b; hb.twin = a; }
  }

  return { halfEdges, byEdge };
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Structural check of a solid: closed, manifold, consistently wound, planar
 * faces, outward normals.
 *
 * This is the kernel's safety net. Running it in tests (and behind a dev flag on
 * generated geometry) catches malformed input at the point it is produced,
 * instead of as an unexplained hole in the render or a boolean failure three
 * stages later.
 */
export function validateSolid(solid: Solid, tolPlanar = TOL_PLANAR): BrepDiagnostic[] {
  const out: BrepDiagnostic[] = [];

  if (solid.faces.length === 0) {
    return [{ code: 'empty', severity: 'error', message: 'Solid has no faces.' }];
  }

  solid.faces.forEach((f, i) => {
    if (f.outer.length < 3) {
      out.push({ code: 'degenerate_face', severity: 'error', message: `Face ${i} has ${f.outer.length} vertices.`, face: i });
      return;
    }
    const dev = facePlanarity(solid, i);
    if (dev > tolPlanar) {
      out.push({
        code: 'non_planar_face',
        severity: 'error',
        message: `Face ${i} deviates ${dev.toFixed(4)} mm from its plane (max ${tolPlanar} mm).`,
        face: i,
      });
    }
  });

  const topo = buildTopology(solid);
  let open = 0, nonManifold = 0, badWinding = 0;
  for (const uses of topo.byEdge.values()) {
    if (uses.length < 2) { open++; continue; }
    if (uses.length > 2) { nonManifold++; continue; }
    const [a, b] = uses;
    if (topo.halfEdges[a].twin < 0 || topo.halfEdges[b].twin < 0) badWinding++;
  }
  if (open) {
    out.push({ code: 'not_closed', severity: 'error', message: `${open} edge(s) belong to only one face — the shell is open.` });
  }
  if (nonManifold) {
    out.push({ code: 'non_manifold_edge', severity: 'error', message: `${nonManifold} edge(s) shared by more than two faces.` });
  }
  if (badWinding) {
    out.push({ code: 'inconsistent_winding', severity: 'error', message: `${badWinding} edge(s) traversed the same way by both faces.` });
  }

  if (out.every((d) => d.code !== 'not_closed' && d.code !== 'non_manifold_edge') && signedVolume(solid) < 0) {
    out.push({ code: 'inverted', severity: 'error', message: 'Signed volume is negative — face normals point inward.' });
  }

  return out;
}

/** True when `validateSolid` reports no errors. */
export function isManifold(solid: Solid): boolean {
  return validateSolid(solid).every((d) => d.severity !== 'error');
}
