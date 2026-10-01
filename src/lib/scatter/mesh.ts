/**
 * mesh.ts — the only scatter file that imports three.
 *
 * Deliberately low-poly and generic: a tree is a trunk and a canopy, a rock
 * is a jittered icosahedron. These are placeholders that read correctly at a
 * glance and cost nothing, the same way the plan symbols are generic. All
 * instances of one material class are merged into ONE geometry, so a forest
 * is three draw calls, not three thousand. Coordinates: BIM mm in, scene
 * metres out, (x, z, −y)·0.001 — the mapping every viewer uses.
 */
import * as THREE from 'three';
import { scatterRng } from './place';
import type { ScatterInstance } from './types';

const MM = 0.001;

export interface ScatterGeometries {
  /** Canopies, shrubs, grass. */
  foliage: THREE.BufferGeometry | null;
  /** Trunks. */
  wood: THREE.BufferGeometry | null;
  /** Rocks and boulders. */
  stone: THREE.BufferGeometry | null;
}

type Bucket = keyof ScatterGeometries;

function jitterVertices(g: THREE.BufferGeometry, amount: number, seed: number): void {
  const rnd = scatterRng(seed);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  // Shared vertices must move together, so jitter by position, not by index.
  const seen = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let f = seen.get(key);
    if (f === undefined) { f = 1 - amount + rnd() * amount * 2; seen.set(key, f); }
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f, pos.getZ(i) * f);
  }
  pos.needsUpdate = true;
}

/** Parts of one instance, in local metres with the ground at y = 0. */
function parts(inst: ScatterInstance): { bucket: Bucket; geo: THREE.BufferGeometry }[] {
  const d = inst.sizeMm * MM, h = inst.heightMm * MM;
  const out: { bucket: Bucket; geo: THREE.BufferGeometry }[] = [];
  switch (inst.kind) {
    case 'tree': {
      const trunkH = h * 0.35;
      const trunk = new THREE.CylinderGeometry(d * 0.04, d * 0.055, trunkH, 6);
      trunk.translate(0, trunkH / 2, 0);
      out.push({ bucket: 'wood', geo: trunk });
      const canopy = new THREE.SphereGeometry(d / 2, 8, 6);
      const canopyH = h - trunkH;
      canopy.scale(1, canopyH / d, 1);
      canopy.translate(0, trunkH + canopyH / 2, 0);
      out.push({ bucket: 'foliage', geo: canopy });
      break;
    }
    case 'shrub':
    case 'hedge': {
      const g = new THREE.SphereGeometry(d / 2, 7, 5);
      g.scale(1, h / d, 1);
      g.translate(0, h / 2, 0);
      out.push({ bucket: 'foliage', geo: g });
      break;
    }
    case 'rock':
    case 'boulder': {
      const g = new THREE.IcosahedronGeometry(d / 2, 1);
      jitterVertices(g, 0.25, Math.round(inst.variant * 1e6) + 1);
      g.scale(1, h / d, 1);
      g.translate(0, h * 0.4, 0); // sits into the ground a little
      out.push({ bucket: 'stone', geo: g });
      break;
    }
    case 'grass': {
      for (let i = 0; i < 3; i++) {
        const g = new THREE.ConeGeometry(d * 0.15, h, 4);
        g.translate(Math.cos(i * 2.1) * d * 0.2, h / 2, Math.sin(i * 2.1) * d * 0.2);
        out.push({ bucket: 'foliage', geo: g });
      }
      break;
    }
  }
  return out;
}

export function scatterGeometries(instances: ScatterInstance[]): ScatterGeometries {
  const buckets: Record<Bucket, number[]> = { foliage: [], wood: [], stone: [] };
  const m = new THREE.Matrix4();
  for (const inst of instances) {
    const rot = (inst.rotDeg * Math.PI) / 180;
    m.makeRotationY(rot);
    m.setPosition(inst.x * MM, inst.z * MM, -inst.y * MM);
    for (const { bucket, geo } of parts(inst)) {
      const g = geo.toNonIndexed();
      g.applyMatrix4(m);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const arr = buckets[bucket];
      for (let i = 0; i < pos.count; i++) arr.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      g.dispose(); geo.dispose();
    }
  }
  const build = (arr: number[]): THREE.BufferGeometry | null => {
    if (arr.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    return g;
  };
  return { foliage: build(buckets.foliage), wood: build(buckets.wood), stone: build(buckets.stone) };
}
