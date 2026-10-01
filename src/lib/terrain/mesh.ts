/**
 * mesh.ts — the only terrain file that imports three.
 *
 * An INDEXED grid, unlike the sweep and dome meshes: the ground is one
 * continuous surface and wants smooth normals across it, which is exactly
 * what sharing vertices gives. Coordinates: BIM mm in, scene metres out,
 * (x, z, −y)·0.001 — the mapping every viewer uses.
 */
import * as THREE from 'three';
import { siteVerticesBim, type SiteResult } from './site';

const MM = 0.001;

export function terrainBufferGeometry(site: SiteResult): THREE.BufferGeometry | null {
  const v = siteVerticesBim(site);
  if (!v) return null;
  const { count, xyz } = v;
  const pos = new Float32Array(count * count * 3);
  for (let i = 0; i < count * count; i++) {
    pos[i * 3] = xyz[i * 3] * MM;
    pos[i * 3 + 1] = xyz[i * 3 + 2] * MM;
    pos[i * 3 + 2] = -xyz[i * 3 + 1] * MM;
  }
  const idx: number[] = [];
  for (let row = 0; row < count - 1; row++) {
    for (let col = 0; col < count - 1; col++) {
      const i0 = row * count + col, i1 = i0 + 1, i2 = i0 + count, i3 = i2 + 1;
      // Wound so the face normal points up (+Y in the scene).
      idx.push(i0, i2, i1, i1, i2, i3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
