/**
 * mesh.ts — the only dome file that imports three.
 *
 * Ribs are drawn by the sweep's own `sweepBufferGeometry` (the rib solids ARE
 * sweep solids). This file adds the panels: each one a flat prism, the
 * outline on the fitted plane extruded inward by the glass thickness. Triangle
 * soup, like every generated mesh here, so the prism edges stay crisp.
 * Coordinates: BIM mm in, scene metres out, (x, z, −y)·0.001.
 */
import * as THREE from 'three';
import { triangulateSimple } from '@/lib/sweep/rings';
import type { Pt3 } from '@/lib/sweep/types';
import type { DomePanel } from './types';

const MM = 0.001;

export function domePanelGeometry(panels: DomePanel[], thicknessMm: number): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const push = (a: Pt3, b: Pt3, c: Pt3) => {
    pos.push(
      a.x * MM, a.z * MM, -a.y * MM,
      b.x * MM, b.z * MM, -b.y * MM,
      c.x * MM, c.z * MM, -c.y * MM,
    );
  };
  const t = Math.max(1, thicknessMm);
  for (const panel of panels) {
    const top = panel.outline;
    const n = panel.normal;
    const bottom = top.map((p) => ({ x: p.x - n.x * t, y: p.y - n.y * t, z: p.z - n.z * t }));
    const tris = triangulateSimple(panel.profile);
    // Top faces outward along the normal; the profile is CCW in the plane's
    // (refDir, normal × refDir) frame, so its triangles already wind that way.
    for (const [a, b, c] of tris) {
      push(top[a], top[b], top[c]);
      push(bottom[c], bottom[b], bottom[a]);
    }
    const m = top.length;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      push(top[i], bottom[i], bottom[j]);
      push(top[i], bottom[j], top[j]);
    }
  }
  if (pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}
