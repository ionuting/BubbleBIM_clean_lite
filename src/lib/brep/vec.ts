/**
 * Internal B-rep kernel — vector math.
 *
 * Plain value-object helpers (no classes, no mutation) so solids stay trivially
 * serialisable and comparable in tests.
 */

import type { Vec2, Vec3 } from './types';

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const len = (a: Vec3): number => Math.sqrt(dot(a, a));

/** Unit vector, or (0,0,0) for a zero-length input (callers treat that as degenerate). */
export function normalize(a: Vec3): Vec3 {
  const l = len(a);
  return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}

export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));

/** Squared distance — for comparisons, avoids the sqrt. */
export function dist2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

// ─── Plan-space (2D) helpers ──────────────────────────────────────────────────

/** Signed area of a 2D polygon. Positive = counter-clockwise. */
export function signedArea2(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** A plan polygon wound counter-clockwise (positive area), reversing a copy if needed. */
export function ensureCCW2(pts: Vec2[]): Vec2[] {
  return signedArea2(pts) < 0 ? [...pts].reverse() : pts;
}

// ─── Planar basis ─────────────────────────────────────────────────────────────

/**
 * An orthonormal basis (u, v) spanning the plane of `n`, with `u × v = n`.
 *
 * Projecting onto it preserves orientation: a loop wound CCW around `n` in 3D
 * comes out CCW (positive signed area) in 2D. Triangulation and planar area both
 * rely on that, which is why this avoids the usual "drop the dominant axis"
 * shortcut and its per-axis sign special cases.
 */
export function planeBasis(n: Vec3): { u: Vec3; v: Vec3 } {
  const nn = normalize(n);
  // Any vector not parallel to nn works as a seed; pick whichever axis nn leans away from.
  const seed: Vec3 = Math.abs(nn.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const u = normalize(cross(nn, seed));
  const v = cross(nn, u); // already unit: nn ⊥ u, both unit
  return { u, v };
}

/** Project a 3D point into the (u, v) plane basis. */
export const project2 = (p: Vec3, u: Vec3, v: Vec3): Vec2 => ({ x: dot(p, u), y: dot(p, v) });

/**
 * Newell's method — the area-weighted normal of a 3D polygon.
 *
 * Unlike a cross product of two edges it uses every vertex, so it stays stable
 * on the near-degenerate slivers that show up at tight wall miters and on
 * shallow roof planes, and it does not care which corner happens to be convex.
 * Returns the raw (unnormalised) vector; its length is twice the polygon area.
 */
export function newellNormal(pts: Vec3[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    nx += (p.y - q.y) * (p.z + q.z);
    ny += (p.z - q.z) * (p.x + q.x);
    nz += (p.x - q.x) * (p.y + q.y);
  }
  return { x: nx / 2, y: ny / 2, z: nz / 2 };
}
