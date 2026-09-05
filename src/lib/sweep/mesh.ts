/**
 * mesh.ts — the only sweep file that imports three.
 *
 * Non-indexed triangle soup, like the stair helix: sharing vertices between
 * side quads would let computeVertexNormals smooth the profile corners and a
 * 30×60 beam would render as a rounded tube. Coordinates: BIM mm in, scene
 * metres out, (x, z, −y)·0.001 — the mapping every viewer uses.
 */
import * as THREE from 'three';
import { solidTriangles, triangulateSimple } from './rings';
import type { Pt2, SweepSolid } from './types';

const MM = 0.001;

export function sweepBufferGeometry(
  solids: SweepSolid[],
  placed: Pt2[],
): THREE.BufferGeometry | null {
  if (solids.length === 0 || placed.length < 3) return null;
  const placedTris = triangulateSimple(placed);
  if (placedTris.length === 0) return null;

  const pos: number[] = [];
  for (const solid of solids) {
    for (const [a, b, c] of solidTriangles(solid, placedTris)) {
      pos.push(
        a.x * MM, a.z * MM, -a.y * MM,
        b.x * MM, b.z * MM, -b.y * MM,
        c.x * MM, c.z * MM, -c.y * MM,
      );
    }
  }
  if (pos.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}
