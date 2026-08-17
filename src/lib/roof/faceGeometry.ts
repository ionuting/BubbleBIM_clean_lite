/**
 * faceGeometry.ts — shared per-face geometry helpers for anything that attaches
 * to a roof SLOPE FACE from the outside: skylights (a hole) and dormers (a
 * notch + their own small envelope). Pure, framework-free.
 *
 * A roof face (`RoofFace3D`) is planar by construction (straight-skeleton /
 * gable / hip / mansard all lift a 2D polygon to 3D via a single linear height
 * field per face — see skeleton.ts). That planarity is what lets everything
 * here work with plain vector algebra, no iterative fitting.
 */
import type { Pt2, Pt3, RoofFace3D } from './types';

export interface FaceBasis {
  /** A point on the face's lowest edge (its "eave" — or break line, for a
   *  mansard upper face; whichever edge is lowest on THIS face). */
  origin: Pt3;
  /** Unit vector along the low edge — purely horizontal (z = 0 component). */
  u: Pt2;
  /** Unit vector in-plane, perpendicular to `u`, pointing up-slope (toward
   *  increasing height). Has a z component — this is what "up the roof" means. */
  v: Pt3;
  /** Unit face normal (outward, away from the building interior). */
  n: Pt3;
  /** The low edge itself. */
  edgeA: Pt3;
  edgeB: Pt3;
}

const sub3 = (a: Pt3, b: Pt3): Pt3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross3 = (a: Pt3, b: Pt3): Pt3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const len3 = (a: Pt3): number => Math.hypot(a.x, a.y, a.z);
const norm3 = (a: Pt3): Pt3 => { const l = len3(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const dot3 = (a: Pt3, b: Pt3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** The face's lowest edge — generalizes "eave" to any face (incl. mansard upper hips). */
export function findBaseEdge(face: RoofFace3D): { a: Pt3; b: Pt3; index: number } | null {
  const V = face.vertices;
  const m = V.length;
  if (m < 3) return null;
  let best = -1;
  let bestZ = Infinity;
  for (let i = 0; i < m; i++) {
    const z = V[i].z + V[(i + 1) % m].z;
    if (z < bestZ) { bestZ = z; best = i; }
  }
  if (best < 0) return null;
  return { a: V[best], b: V[(best + 1) % m], index: best };
}

/** Orthonormal in-plane basis for a face, anchored on its lowest edge. */
export function computeFaceBasis(face: RoofFace3D): FaceBasis | null {
  const edge = findBaseEdge(face);
  if (!edge) return null;
  const { a, b } = edge;
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1) return null;
  const u: Pt2 = { x: dx / L, y: dy / L };

  // Face normal from the first non-degenerate triangle.
  const V = face.vertices;
  let n: Pt3 | null = null;
  for (let i = 0; i < V.length - 2 && !n; i++) {
    const e1 = sub3(V[i + 1], V[i]);
    const e2 = sub3(V[i + 2], V[i]);
    const c = cross3(e1, e2);
    if (len3(c) > 1e-6) n = norm3(c);
  }
  if (!n) return null;
  // Orient outward (upward-ish): flip if it points down.
  if (n.z < 0) n = { x: -n.x, y: -n.y, z: -n.z };

  // v = n × u3 (u extended to 3D with z=0), gives the in-plane "up-slope" direction.
  const u3: Pt3 = { x: u.x, y: u.y, z: 0 };
  let v = norm3(cross3(n, u3));
  // Ensure v points toward increasing z (up the slope), not down.
  if (v.z < 0) v = { x: -v.x, y: -v.y, z: -v.z };

  return { origin: a, u, v, n, edgeA: a, edgeB: b };
}

/** Point-in-polygon (plan projection, ray casting). Boundary counts as outside. */
export function pointInPolygon2D(pt: Pt2, poly: Pt2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Which slope face (if any) contains this plan point, by plan-projected point-in-polygon. */
export function findHostFace(faces: RoofFace3D[], planX: number, planY: number): RoofFace3D | null {
  for (const f of faces) {
    if (f.role !== 'slope') continue;
    const poly2d = f.vertices.map((v) => ({ x: v.x, y: v.y }));
    if (pointInPolygon2D({ x: planX, y: planY }, poly2d)) return f;
  }
  return null;
}

/** The 3D point ON the face plane directly above/below a plan (x,y) — null if the plane is vertical. */
export function projectPlanPointToFace(basis: FaceBasis, planX: number, planY: number): Pt3 | null {
  if (Math.abs(basis.n.z) < 1e-6) return null;
  const d = dot3(basis.n, basis.origin);
  const z = (d - basis.n.x * planX - basis.n.y * planY) / basis.n.z;
  return { x: planX, y: planY, z };
}

/** (u, v) in-plane coordinates of a point relative to the basis origin. */
export function faceUV(basis: FaceBasis, p: Pt3): { u: number; v: number } {
  const rel: Pt3 = sub3(p, basis.origin);
  return { u: rel.x * basis.u.x + rel.y * basis.u.y, v: dot3(rel, basis.v) };
}

/** World-space point at in-plane coordinates (u, v). */
export function uvToWorld(basis: FaceBasis, u: number, v: number): Pt3 {
  return {
    x: basis.origin.x + basis.u.x * u + basis.v.x * v,
    y: basis.origin.y + basis.u.y * u + basis.v.y * v,
    z: basis.origin.z + basis.v.z * v,
  };
}

/** Centered rectangle on the face plane, CCW, `widthMm` along u × `lengthMm` along v. */
export function rectOnFace(basis: FaceBasis, center: Pt3, widthMm: number, lengthMm: number): Pt3[] {
  const { u: cu, v: cv } = faceUV(basis, center);
  const hw = widthMm / 2, hl = lengthMm / 2;
  return [
    uvToWorld(basis, cu - hw, cv - hl),
    uvToWorld(basis, cu + hw, cv - hl),
    uvToWorld(basis, cu + hw, cv + hl),
    uvToWorld(basis, cu - hw, cv + hl),
  ];
}

/**
 * Reorders a (≥3-point) planar point loop so its own winding faces
 * `desiredNormal` — i.e. after this, extruding the loop by a POSITIVE height
 * (via `Polygon.extrude`, which follows the loop's own vertex-winding normal)
 * is guaranteed to grow toward `desiredNormal`, regardless of the order the
 * caller happened to list the points in. Removes any need to reason about — or
 * risk getting wrong — a specific winding convention by hand.
 */
export function orientPointsToward(pts: Pt3[], desiredNormal: Pt3): Pt3[] {
  if (pts.length < 3) return pts;
  const e1 = sub3(pts[1], pts[0]);
  const e2 = sub3(pts[2], pts[0]);
  const n = cross3(e1, e2);
  return dot3(n, desiredNormal) < 0 ? [...pts].reverse() : pts;
}
