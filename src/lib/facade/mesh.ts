/**
 * mesh.ts — the only facade file that imports three.
 *
 * Mullions are sweep solids (one shared profile) and go through the sweep's
 * own builder; glass and opaque panels are DomePanels and go through the
 * dome's. Only the cassettes need anything of their own: every cassette has
 * its own vertex count, so each is capped with its own triangulation.
 * Triangle soup, crisp edges, (x, z, −y)·0.001 like every generated mesh.
 */
import * as THREE from 'three';
import { solidTriangles, triangulateSimple } from '@/lib/sweep/rings';
import { sweepBufferGeometry } from '@/lib/sweep/mesh';
import { domePanelGeometry } from '@/lib/dome/mesh';
import type { FacadeResult } from './types';

const MM = 0.001;

export function cassetteGeometry(cassettes: FacadeResult['cassettes']): THREE.BufferGeometry | null {
  const pos: number[] = [];
  for (const c of cassettes) {
    const tris = triangulateSimple(c.placed);
    if (tris.length === 0) continue;
    for (const [a, b, d] of solidTriangles(c.solid, tris)) {
      pos.push(a.x * MM, a.z * MM, -a.y * MM, b.x * MM, b.z * MM, -b.y * MM, d.x * MM, d.z * MM, -d.y * MM);
    }
  }
  if (pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

export interface FacadeGeometries {
  mullions: THREE.BufferGeometry | null;
  glass: THREE.BufferGeometry | null;
  /** Opaque panels AND cassettes — one material. */
  opaque: THREE.BufferGeometry | null;
}

export function facadeGeometries(res: FacadeResult): FacadeGeometries {
  const mullions = res.members.length ? sweepBufferGeometry(res.members, res.memberProfile) : null;
  const glass = res.glassPanels.length ? domePanelGeometry(res.glassPanels, res.intent.glassThicknessMm) : null;
  const solid = res.solidPanels.length ? domePanelGeometry(res.solidPanels, res.intent.panelThicknessMm) : null;
  const cas = cassetteGeometry(res.cassettes);
  let opaque: THREE.BufferGeometry | null = null;
  if (solid && cas) {
    const a = solid.getAttribute('position').array as Float32Array, b = cas.getAttribute('position').array as Float32Array;
    const merged = new Float32Array(a.length + b.length); merged.set(a); merged.set(b, a.length);
    opaque = new THREE.BufferGeometry();
    opaque.setAttribute('position', new THREE.BufferAttribute(merged, 3));
    opaque.computeVertexNormals();
  } else opaque = solid ?? cas;
  return { mullions, glass, opaque };
}
