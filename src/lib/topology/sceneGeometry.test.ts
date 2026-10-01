/**
 * The complex's faces become triangles that cover exactly the face: a wall,
 * a floor, an L-shaped roof and a face with a hole, each checked by area.
 */
import { describe, expect, it } from 'vitest';
import { buildFaceObjects, triangulateFace, trianglesArea } from './sceneGeometry';
import type { TopologyFace } from './types';

type P = [number, number, number];
const face = (outerMm: P[], normal: P, holesMm?: P[][]): TopologyFace => ({
  kind: 'exterior', rooms: ['r'], areaM2: 0, normal, outerMm, ...(holesMm ? { holesMm } : {}),
});

describe('triangulating a face in its own plane', () => {
  it('covers a vertical wall 5 × 2.8 m', () => {
    const t = triangulateFace(face([[0, 0, 0], [5000, 0, 0], [5000, 0, 2800], [0, 0, 2800]], [0, -1, 0]))!;
    expect(trianglesArea(t.positions, t.indices)).toBeCloseTo(14, 6);
    // Metres, Z up: the top edge is at 2.8.
    expect(Math.max(...Array.from(t.positions).filter((_, i) => i % 3 === 2))).toBeCloseTo(2.8, 6); // float32
  });

  it('covers an L-shaped roof, concave corner included', () => {
    const L: P[] = [[0, 0, 3000], [6000, 0, 3000], [6000, 2000, 3000], [2000, 2000, 3000], [2000, 6000, 3000], [0, 6000, 3000]];
    const t = triangulateFace(face(L, [0, 0, 1]))!;
    expect(trianglesArea(t.positions, t.indices)).toBeCloseTo(20, 6);
  });

  it('leaves a hole empty', () => {
    const outer: P[] = [[0, 0, 0], [4000, 0, 0], [4000, 3000, 0], [0, 3000, 0]];
    const hole: P[] = [[1000, 1000, 0], [1000, 2000, 0], [2000, 2000, 0], [2000, 1000, 0]];
    const t = triangulateFace(face(outer, [0, 0, -1], [hole]))!;
    expect(trianglesArea(t.positions, t.indices)).toBeCloseTo(11, 6);
  });

  it('handles a wall facing east (the x axis dropped, not z)', () => {
    const t = triangulateFace(face([[0, 0, 0], [0, 4000, 0], [0, 4000, 3000], [0, 0, 3000]], [1, 0, 0]))!;
    expect(trianglesArea(t.positions, t.indices)).toBeCloseTo(12, 6);
  });

  it('refuses a degenerate face rather than drawing nothing silently', () => {
    expect(triangulateFace(face([[0, 0, 0], [1000, 0, 0]], [0, 0, 1]))).toBeNull();
  });
});

describe('face objects', () => {
  it('one mesh and one outline per face, each knowing its rooms', () => {
    const f: TopologyFace = {
      kind: 'wall', rooms: ['a', 'b'], areaM2: 14, normal: [1, 0, 0],
      outerMm: [[5000, 0, 0], [5000, 5000, 0], [5000, 5000, 2800], [5000, 0, 2800]],
    };
    const { meshes, outlines } = buildFaceObjects([f]);
    expect(meshes).toHaveLength(1);
    expect(outlines).toHaveLength(1);
    expect(meshes[0].userData).toEqual({ kind: 'wall', rooms: ['a', 'b'], areaM2: 14 });
    // A closed loop of four edges: eight endpoints.
    expect(outlines[0].geometry.getAttribute('position').count).toBe(8);
  });
});
