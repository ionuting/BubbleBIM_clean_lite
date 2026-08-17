/**
 * Internal B-rep kernel — measurements.
 *
 * Everything derives from the face triangulation, so concave footprints, mitered
 * wall ends and faces with holes are all handled by the same code path. Results
 * are in BIM units (mm, mm², mm³); the `*M3` / `*M2` helpers convert for quantity
 * takeoff, which reports in metres.
 */

import type { Solid, Vec3 } from './types';
import { cross, dot, len, newellNormal, sub } from './vec';
import { triangulateFace, type Tri } from './triangulate';

/** All triangles of a solid, as vertex-id triples wound CCW around each face normal. */
export function solidTriangles(solid: Solid): Tri[] {
  const out: Tri[] = [];
  for (const f of solid.faces) {
    out.push(...triangulateFace(solid.vertices, f.outer, f.holes, f.normal));
  }
  return out;
}

/** Area of one face (mm²), outer loop minus its holes. */
export function faceArea(solid: Solid, faceIndex: number): number {
  const f = solid.faces[faceIndex];
  if (!f) return 0;
  const outer = len(newellNormal(f.outer.map((i) => solid.vertices[i])));
  let holes = 0;
  for (const h of f.holes ?? []) holes += len(newellNormal(h.map((i) => solid.vertices[i])));
  return Math.max(0, outer - holes);
}

/** Total surface area (mm²). */
export function surfaceArea(solid: Solid): number {
  let a = 0;
  for (let i = 0; i < solid.faces.length; i++) a += faceArea(solid, i);
  return a;
}

/**
 * Signed volume (mm³) by the divergence theorem: each triangle forms a
 * tetrahedron with the origin, and consistently outward-wound faces make the
 * signed contributions sum to the enclosed volume.
 *
 * A **negative** result means the faces are wound inward — which is exactly why
 * `validateSolid` checks the sign rather than trusting builders.
 */
export function signedVolume(solid: Solid): number {
  let v = 0;
  for (const [ia, ib, ic] of solidTriangles(solid)) {
    const a = solid.vertices[ia], b = solid.vertices[ib], c = solid.vertices[ic];
    v += dot(a, cross(b, c));
  }
  return v / 6;
}

/** Enclosed volume (mm³), always positive. */
export const volume = (solid: Solid): number => Math.abs(signedVolume(solid));

/** Enclosed volume in cubic metres — the unit quantity takeoff reports. */
export const volumeM3 = (solid: Solid): number => volume(solid) * 1e-9;

/** Total surface area in square metres. */
export const surfaceAreaM2 = (solid: Solid): number => surfaceArea(solid) * 1e-6;

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** Axis-aligned bounds (BIM mm), or `null` for a solid with no vertices. */
export function bounds(solid: Solid): Bounds | null {
  if (solid.vertices.length === 0) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of solid.vertices) {
    if (p.x < min.x) min.x = p.x;
    if (p.y < min.y) min.y = p.y;
    if (p.z < min.z) min.z = p.z;
    if (p.x > max.x) max.x = p.x;
    if (p.y > max.y) max.y = p.y;
    if (p.z > max.z) max.z = p.z;
  }
  return { min, max };
}

/**
 * Volume centroid (BIM mm) — the centre of mass of the enclosed solid, not of
 * its vertices. Falls back to the bounding-box centre for zero-volume input.
 */
export function centroid(solid: Solid): Vec3 | null {
  let vol = 0;
  let cx = 0, cy = 0, cz = 0;
  for (const [ia, ib, ic] of solidTriangles(solid)) {
    const a = solid.vertices[ia], b = solid.vertices[ib], c = solid.vertices[ic];
    // Signed volume of the tetrahedron (origin, a, b, c) and its centroid.
    const dv = dot(a, cross(b, c)) / 6;
    vol += dv;
    cx += ((a.x + b.x + c.x) / 4) * dv;
    cy += ((a.y + b.y + c.y) / 4) * dv;
    cz += ((a.z + b.z + c.z) / 4) * dv;
  }
  if (Math.abs(vol) > 1e-9) return { x: cx / vol, y: cy / vol, z: cz / vol };

  const b = bounds(solid);
  return b ? { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 } : null;
}

/**
 * Largest distance from any loop vertex to the face's own plane (mm).
 * Used by `validateSolid` — non-planar faces break both triangulation and every
 * boolean engine we might plug in behind `BooleanEngine`.
 */
export function facePlanarity(solid: Solid, faceIndex: number): number {
  const f = solid.faces[faceIndex];
  if (!f) return 0;
  const origin = solid.vertices[f.outer[0]];
  let worst = 0;
  for (const loop of [f.outer, ...(f.holes ?? [])]) {
    for (const id of loop) {
      const d = Math.abs(dot(sub(solid.vertices[id], origin), f.normal));
      if (d > worst) worst = d;
    }
  }
  return worst;
}
