/**
 * meshOutline.ts — the drawable edges of a triangle mesh.
 *
 * Not everything the 3D viewer builds is a kernel solid. A roof's gable end is
 * a vertical polygon and the kernel will not extrude one; a stair flight is a
 * sawtooth profile run sideways and the kernel extrudes only upward; a dome,
 * a terrain, a swept moulding are meshes by construction. Left out of the
 * drawing they would neither be drawn properly nor hide anything, and a stair
 * you can see the wall through is worse than no stair.
 *
 * So this reads the edges straight off the triangles. It needs no topology
 * from the kernel and no B-rep: two triangles that share an edge are found by
 * the edge's own endpoints.
 *
 * ## Which edges are drawn
 *
 *   boundary  — one triangle only: an open sheet's rim. Drawn.
 *   silhouette — two triangles, one facing the viewer and one away. Drawn:
 *                this is where the body turns away, the outline itself.
 *   crease    — two triangles both facing the viewer, meeting at an angle.
 *                Drawn only past `CREASE_DEG`, which is what keeps the fan
 *                triangulation of a flat roof face from being drawn as a fan.
 *   interior  — two triangles both facing away: inside the body. Never drawn.
 *
 * That last rule is the mesh's own back-face removal, and it is the same rule
 * the kernel applies to a solid. What it cannot do is decide whether one body
 * stands in front of another — that is `hlr.ts`, over these lines and every
 * face in the view.
 *
 * ## The welding tolerance
 *
 * Triangles from `BufferGeometry` rarely share vertex objects, so edges are
 * matched on rounded coordinates. `WELD_MM` has to be coarse enough to join
 * what a float32 position pulled apart and fine enough not to weld two real
 * corners into one; a tenth of a millimetre is both at building scale.
 */
import type { Pt3 } from '@/lib/ogProjection';

/** Positions closer than this are the same point. */
export const WELD_MM = 0.1;

/** Two seen triangles meeting at less than this are one surface, not an edge. */
export const CREASE_DEG = 20;

/**
 * A triangle whose normal is this close to perpendicular to the view is seen
 * edge-on: it covers nothing and must count as facing AWAY. Without the
 * margin, a box's side face — its normal a float32 rotation away from exact —
 * comes out facing the viewer by a hair, and every edge it shares with the
 * top, bottom and back becomes a "silhouette": two lines drawn on top of the
 * real one and two drawn as points. Unit normals, so this is a cosine.
 */
export const EDGE_ON_COS = 1e-4;

export interface MeshEdge {
  a: Pt3;
  b: Pt3;
  /** A silhouette or a free rim reads as the body's outline; a crease is interior detail. */
  kind: 'outline' | 'crease';
}

const key = (p: Pt3): string =>
  `${Math.round(p.x / WELD_MM)},${Math.round(p.y / WELD_MM)},${Math.round(p.z / WELD_MM)}`;

/** Unit normal of a triangle in BIM mm, or null when it is degenerate. */
export function triangleNormal(a: Pt3, b: Pt3, c: Pt3): Pt3 | null {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
}

interface EdgeRecord {
  a: Pt3;
  b: Pt3;
  /** Normals of the triangles sharing this edge — one, two, or more on a bad mesh. */
  normals: Pt3[];
}

/**
 * The drawable edges of a set of triangles, seen from `viewDir` (the direction
 * the viewer LOOKS, in BIM mm).
 *
 * `rings` are triangles as 3-point rings, which is what both a mesh's index
 * buffer and a B-rep's triangulated face give.
 */
export function meshEdges(
  triangles: Pt3[][],
  viewDir: Pt3,
  creaseDeg: number = CREASE_DEG,
): MeshEdge[] {
  const edges = new Map<string, EdgeRecord>();

  for (const t of triangles) {
    if (t.length < 3) continue;
    const n = triangleNormal(t[0], t[1], t[2]);
    if (!n) continue;
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      const ka = key(a), kb = key(b);
      if (ka === kb) continue;
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const hit = edges.get(k);
      if (hit) hit.normals.push(n);
      else edges.set(k, { a, b, normals: [n] });
    }
  }

  // A triangle faces the viewer when its normal opposes the view direction;
  // which way round the mesh wound its triangles is not to be trusted, so
  // "facing" is only ever used to compare one triangle with another.
  const facing = (n: Pt3): number => -(n.x * viewDir.x + n.y * viewDir.y + n.z * viewDir.z);
  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);

  const out: MeshEdge[] = [];
  for (const e of edges.values()) {
    if (e.normals.length === 1) {
      out.push({ a: e.a, b: e.b, kind: 'outline' });
      continue;
    }
    // More than two triangles on one edge is a mesh that is not a surface;
    // the first two decide, which is better than dropping the edge.
    const [n0, n1] = e.normals;
    const f0 = facing(n0), f1 = facing(n1);
    const seen0 = f0 > EDGE_ON_COS, seen1 = f1 > EDGE_ON_COS;
    if (!seen0 && !seen1) continue;               // inside the body
    if (seen0 !== seen1) { out.push({ a: e.a, b: e.b, kind: 'outline' }); continue; }
    const dot = n0.x * n1.x + n0.y * n1.y + n0.z * n1.z;
    if (Math.abs(dot) < cosCrease) out.push({ a: e.a, b: e.b, kind: 'crease' });
  }
  return out;
}
