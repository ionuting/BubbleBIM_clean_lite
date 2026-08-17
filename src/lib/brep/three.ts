/**
 * Internal B-rep kernel — THREE.js adapter.
 *
 * Isolated in its own module so the kernel core (types, solid, prism, measure,
 * triangulate, tessellate) stays free of any rendering dependency and can be
 * exercised in plain unit tests — and so a second renderer (Babylon already
 * exists in this project) is one more adapter rather than a fork of the kernel.
 */

import * as THREE from 'three';
import type { Solid } from './types';
import { loopSegments, tessellate, type TessellateOptions } from './tessellate';

/**
 * Build a `THREE.BufferGeometry` from a solid, in scene space (Y up, metres) by
 * default.
 *
 * `userData.brepFaces` carries the per-triangle face indices, so a raycast hit's
 * `faceIndex` maps straight back to the originating B-rep face and its tag.
 */
export function toBufferGeometry(solid: Solid, opts: TessellateOptions = {}): THREE.BufferGeometry {
  const soup = tessellate(solid, opts);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(soup.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(soup.normals, 3));
  geo.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  geo.userData.brepFaces = soup.triangleFaces;
  return geo;
}

/**
 * Geometry of the solid's real face boundaries, for wireframe overlays.
 *
 * Use this rather than `THREE.EdgesGeometry` on the result of
 * `toBufferGeometry`: flat shading duplicates vertices per face, which destroys
 * the adjacency information `EdgesGeometry` relies on, so it would draw every
 * triangulation edge instead of the actual model edges.
 */
export function toEdgesGeometry(solid: Solid, opts: TessellateOptions = {}): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(loopSegments(solid, opts), 3));
  return geo;
}

/** Convenience: geometry + material in one mesh. */
export function toMesh(solid: Solid, material?: THREE.Material, opts: TessellateOptions = {}): THREE.Mesh {
  return new THREE.Mesh(
    toBufferGeometry(solid, opts),
    material ?? new THREE.MeshStandardMaterial(),
  );
}
