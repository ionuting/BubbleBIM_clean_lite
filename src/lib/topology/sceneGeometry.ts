/**
 * sceneGeometry.ts — the CellComplex's faces as Three.js geometry.
 *
 * The backend sends each face of the complex once, as an ordered outline in
 * BIM millimetres (x east, y north, z up). Here a face becomes triangles in
 * metres, in the same Z-up frame — the topology view sets its camera's up
 * vector to +Z rather than rotating the model, so a coordinate read off the
 * screen is a coordinate in the building.
 *
 * A face is flat but can sit at any angle and have holes, so it is
 * triangulated with earcut in its own plane: drop the axis its normal leans
 * on most, which keeps the outline a simple polygon.
 */
import * as THREE from 'three';
import earcut from 'earcut';
import type { TopologyFace, TopologyFaceKind } from './types';

const MM = 0.001;

/** Face colours: the shared faces carry the analysis, the envelope is context. */
export const FACE_COLOUR: Record<TopologyFaceKind, string> = {
  wall: '#2563eb',
  slab: '#d97706',
  exterior: '#94a3b8',
  roof: '#0ea5e9',
  ground: '#78716c',
  internal: '#cbd5e1',
  orphan: '#cbd5e1',
};

export const FACE_LABEL: Record<TopologyFaceKind, string> = {
  wall: 'perete comun',
  slab: 'placă comună',
  exterior: 'perete exterior',
  roof: 'acoperiș',
  ground: 'pardoseală pe sol',
  internal: 'interior cameră',
  orphan: 'fără celulă',
};

export const isSharedKind = (k: TopologyFaceKind) => k === 'wall' || k === 'slab';

/** Triangles of one face, positions in metres, Z up. Null for a degenerate face. */
export function triangulateFace(face: Pick<TopologyFace, 'outerMm' | 'holesMm' | 'normal'>): {
  positions: Float32Array;
  indices: number[];
} | null {
  const rings = [face.outerMm, ...(face.holesMm ?? [])].filter((r) => r.length >= 3);
  if (rings.length === 0 || face.outerMm.length < 3) return null;

  // The two axes of the plane the face is projected onto.
  const [nx, ny, nz] = face.normal.map(Math.abs);
  const [u, v] = nz >= nx && nz >= ny ? [0, 1] : nx >= ny ? [1, 2] : [0, 2];

  const flat: number[] = [];
  const holes: number[] = [];
  const pos: number[] = [];
  for (const [i, ring] of rings.entries()) {
    if (i > 0) holes.push(flat.length / 2);
    for (const p of ring) {
      flat.push(p[u], p[v]);
      pos.push(p[0] * MM, p[1] * MM, p[2] * MM);
    }
  }
  const indices = earcut(flat, holes.length ? holes : null, 2);
  if (indices.length === 0) return null;
  return { positions: new Float32Array(pos), indices };
}

/** Area of the triangles, m² — the check that a triangulation covered the face. */
export function trianglesArea(positions: Float32Array, indices: number[]): number {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    a.fromArray(positions, indices[t] * 3);
    b.fromArray(positions, indices[t + 1] * 3);
    c.fromArray(positions, indices[t + 2] * 3);
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
}

/** What a face mesh carries, for picking and highlighting. */
export interface FaceMeshData {
  kind: TopologyFaceKind;
  rooms: string[];
  areaM2: number;
}

/**
 * One mesh per face, and the outline of each face as lines — the edges are
 * what makes a stack of translucent cells readable as separate boxes.
 */
export function buildFaceObjects(faces: TopologyFace[]): { meshes: THREE.Mesh[]; outlines: THREE.LineSegments[] } {
  const meshes: THREE.Mesh[] = [];
  const outlines: THREE.LineSegments[] = [];
  for (const face of faces) {
    const tri = triangulateFace(face);
    if (!tri) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(tri.positions, 3));
    geom.setIndex(tri.indices);
    geom.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: FACE_COLOUR[face.kind], transparent: true, opacity: 0.25,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData = { kind: face.kind, rooms: face.rooms, areaM2: face.areaM2 } satisfies FaceMeshData;
    meshes.push(mesh);

    const seg: number[] = [];
    for (const ring of [face.outerMm, ...(face.holesMm ?? [])]) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        seg.push(p[0] * MM, p[1] * MM, p[2] * MM, q[0] * MM, q[1] * MM, q[2] * MM);
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    const line = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
      color: FACE_COLOUR[face.kind], transparent: true, opacity: 0.6,
    }));
    line.userData = { kind: face.kind, rooms: face.rooms, areaM2: face.areaM2 } satisfies FaceMeshData;
    outlines.push(line);
  }
  return { meshes, outlines };
}
