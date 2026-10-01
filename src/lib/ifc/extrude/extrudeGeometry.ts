/**
 * extrudeGeometry.ts — an `ExtrudedSolid` as Three.js geometry.
 *
 * Used by the TOC viewer to draw the solid, and by the World view on the way
 * to glTF. Everything is baked into the vertex positions — scale, rotation,
 * position, elevation — so a mesh built from this needs no transform of its
 * own and a changed parameter is just a rebuild. With a handful of solids
 * that is cheaper than keeping two descriptions of the same placement in step,
 * and it removes a whole class of "the mesh moved but the maths did not" bugs.
 *
 * Axis convention is the app's: drawing (x east, y north, z up) → Three
 * (x, z, −y). The same mapping `bimGeometryThree` uses, minus the millimetre
 * factor, because this module already works in metres.
 */

import * as THREE from 'three';
import {
  effectiveHeight, fanTriangles, worldProfile, type ExtrudedSolid, type Pt2,
} from './extrudedSolid';

/** Drawing metres → Three.js metres. */
export function toThree(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

/**
 * A closed prism: bottom cap, top cap, and one quad per contour edge.
 *
 * Non-indexed on purpose — every face gets its own vertices so the normals
 * come out flat, which is what a building volume should look like. A smoothed
 * prism reads as a blob.
 */
export function extrudedSolidGeometry(s: ExtrudedSolid): THREE.BufferGeometry | null {
  const ring = worldProfile(s);
  if (ring.length < 3) return null;
  const z0 = s.placement.z;
  const z1 = z0 + effectiveHeight(s);
  const pos: number[] = [];

  const push = (p: Pt2, z: number) => { pos.push(...toThree(p.x, p.y, z)); };

  // Caps. The ring runs counter-clockwise seen from above, so the top cap is
  // wound as-is and the bottom is reversed to face down.
  for (const [a, b, c] of fanTriangles(ring)) {
    push(ring[a], z1); push(ring[b], z1); push(ring[c], z1);
    push(ring[a], z0); push(ring[c], z0); push(ring[b], z0);
  }

  // Sides: two triangles per edge, wound to face outward.
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    push(a, z0); push(b, z0); push(b, z1);
    push(a, z0); push(b, z1); push(a, z1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The prism's edges as line segments — the top and bottom rings plus the
 * verticals. Drawn over the solid it is what makes a box read as a shape
 * rather than as a silhouette.
 */
export function extrudedSolidEdges(s: ExtrudedSolid): THREE.BufferGeometry | null {
  const ring = worldProfile(s);
  if (ring.length < 2) return null;
  const z0 = s.placement.z;
  const z1 = z0 + effectiveHeight(s);
  const pos: number[] = [];
  const seg = (a: Pt2, za: number, b: Pt2, zb: number) => {
    pos.push(...toThree(a.x, a.y, za), ...toThree(b.x, b.y, zb));
  };
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    seg(a, z0, b, z0);
    seg(a, z1, b, z1);
    seg(a, z0, a, z1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

/**
 * The open contour being drawn, as a line at its plane's elevation.
 * `closing` adds the segment back to the first point, so the user sees the
 * shape they are about to get rather than a trailing tail.
 */
export function contourLineGeometry(
  points: Pt2[],
  elevation: number,
  closing = false,
): THREE.BufferGeometry | null {
  if (points.length < 2) return null;
  const pos: number[] = [];
  for (const p of points) pos.push(...toThree(p.x, p.y, elevation));
  if (closing) pos.push(...toThree(points[0].x, points[0].y, elevation));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}
