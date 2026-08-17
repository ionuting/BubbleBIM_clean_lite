/**
 * ifcBrepHelpers.ts — BREP geometry math for the IFC Rig Zone Modifier.
 *
 * Port of the geometry helpers from compontent-editor/src/features/zoneModifier.ts.
 * All functions work with @thatopen/fragments RawTransformData / RawGlobalTransformData.
 */

import type { RawTransformData, RawGlobalTransformData } from '@thatopen/fragments';

// ── Vector helpers ────────────────────────────────────────────────────────────

export function cross3d(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Apply a RawTransformData (local placement) to a point. */
export function applyTransform(pt: number[], t: RawTransformData): number[] {
  const z = cross3d(t.xDirection, t.yDirection);
  return [
    t.position[0] + pt[0] * t.xDirection[0] + pt[1] * t.yDirection[0] + pt[2] * z[0],
    t.position[1] + pt[0] * t.xDirection[1] + pt[1] * t.yDirection[1] + pt[2] * z[1],
    t.position[2] + pt[0] * t.xDirection[2] + pt[1] * t.yDirection[2] + pt[2] * z[2],
  ];
}

/** Inverse of applyTransform — convert a world point back to local BREP space. */
export function inverseTransform(worldPt: number[], t: RawTransformData): number[] {
  const z = cross3d(t.xDirection, t.yDirection);
  const rel = [
    worldPt[0] - t.position[0],
    worldPt[1] - t.position[1],
    worldPt[2] - t.position[2],
  ];
  return [
    rel[0] * t.xDirection[0] + rel[1] * t.xDirection[1] + rel[2] * t.xDirection[2],
    rel[0] * t.yDirection[0] + rel[1] * t.yDirection[1] + rel[2] * t.yDirection[2],
    rel[0] * z[0]             + rel[1] * z[1]             + rel[2] * z[2],
  ];
}

/** Transform a BREP-local point to world space through localT then globalT. */
export function toWorld(
  pt: number[],
  localT:  RawTransformData        | undefined,
  globalT: RawGlobalTransformData  | undefined,
): number[] {
  const afterLocal = localT  ? applyTransform(pt, localT)           : pt;
  return               globalT ? applyTransform(afterLocal, globalT) : afterLocal;
}

/** Inverse of toWorld — world → local BREP space. */
export function fromWorld(
  worldPt: number[],
  localT:  RawTransformData        | undefined,
  globalT: RawGlobalTransformData  | undefined,
): number[] {
  const afterGlobal = globalT ? inverseTransform(worldPt, globalT) : worldPt;
  return localT ? inverseTransform(afterGlobal, localT) : afterGlobal;
}

/**
 * 2-D point-in-polygon test on the XZ plane (ray-casting algorithm).
 * `polygon` is an array of [worldX, worldZ] pairs.
 */
export function pointInPolygonXZ(
  x: number,
  z: number,
  polygon: [number, number][],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Build a rectangular strip polygon on the XZ plane for a rig axis.
 *
 * A rig axis dir='X' at posX creates a vertical strip:
 *   [[posX-halfW, zMin], [posX+halfW, zMin], [posX+halfW, zMax], [posX-halfW, zMax]]
 *
 * A rig axis dir='Y' at posZ (IFC Y → Three.js Z axis) creates a horizontal strip.
 *
 * @param dir      'X' = strip perpendicular to X axis | 'Y' = strip perpendicular to Z axis
 * @param posM     Position in METRES (IFC world coordinates)
 * @param halfWidthM Half-width of the snap strip in metres
 * @param spanMin  Min value along the parallel axis (metres)
 * @param spanMax  Max value along the parallel axis (metres)
 */
export function makeAxisStripPolygon(
  dir: 'X' | 'Y',
  posM: number,
  halfWidthM: number,
  spanMin: number,
  spanMax: number,
): [number, number][] {
  if (dir === 'X') {
    // Constant-X strip: varies in Z
    return [
      [posM - halfWidthM, spanMin],
      [posM + halfWidthM, spanMin],
      [posM + halfWidthM, spanMax],
      [posM - halfWidthM, spanMax],
    ];
  } else {
    // Constant-Z strip: varies in X
    // Note: IFC Y axis → Three.js Z axis (with potential sign). In OBC
    // fragment world coords the IFC Y global direction becomes the Z world axis.
    return [
      [spanMin, posM - halfWidthM],
      [spanMax, posM - halfWidthM],
      [spanMax, posM + halfWidthM],
      [spanMin, posM + halfWidthM],
    ];
  }
}

/** Compute AABB of a flat point list [[x,z],...]. Returns undefined when empty. */
export function bbox2d(pts: [number, number][]): { minX: number; maxX: number; minZ: number; maxZ: number } | undefined {
  if (!pts.length) return undefined;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}
