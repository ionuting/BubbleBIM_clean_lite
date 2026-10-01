import { describe, it, expect } from 'vitest';
import { storeyOpeningFrames, symbolMatrix } from './openingSymbols';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';

const storey: BubbleGraphNode = {
  id: 'st', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};
const ax = (id: string, x: number, y: number): BubbleGraphNode => ({
  id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
  properties: { bimX: x, bimY: y, has_column: 'False' },
});

/** A 5 m wall east along y = 0, 250 thick, carrying one window. */
function scene(extra: Record<string, unknown> = {}) {
  const nodes: BubbleGraphNode[] = [
    storey, ax('a', 0, 0), ax('b', 5000, 0),
    {
      id: 'w', type: 'wall', name: 'w', x: 0, y: 0, z: 0, parentId: 'st',
      properties: {
        wall_type: 'W25',
        has_windows: 'True',
        windows: JSON.stringify([{ window_type: 'W-FIX-100x120' }]),
        ...extra,
      },
    },
  ];
  const edges: BubbleGraphEdge[] = [
    { id: 'e0', from: 'w', to: 'a' }, { id: 'e1', from: 'w', to: 'b' },
  ];
  return { nodes, edges };
}

describe('storeyOpeningFrames', () => {
  it('frames the opening on the wall it is a hole in', () => {
    const { nodes, edges } = scene();
    const [f, ...rest] = storeyOpeningFrames(nodes, edges, 'st');
    expect(rest).toHaveLength(0);
    expect(f.wallId).toBe('w');
    expect(f.kind).toBe('window');

    // The wall runs east, so along is +u and across crosses it. The two are
    // perpendicular, which is what makes the symbol square in its hole.
    expect(f.along.x).toBeCloseTo(1, 6);
    expect(f.along.y).toBeCloseTo(0, 6);
    expect(f.along.x * f.across.x + f.along.y * f.across.y).toBeCloseTo(0, 6);

    // Across spans the wall, and the origin sits on one of its faces.
    expect(f.thicknessMm).toBeCloseTo(250, 3);
    expect(Math.abs(f.origin.y)).toBeCloseTo(125, 3);
    expect(f.widthMm).toBeGreaterThan(0);
  });

  it('puts the origin at the opening\'s start, not the wall\'s', () => {
    const { nodes, edges } = scene();
    const [f] = storeyOpeningFrames(nodes, edges, 'st');
    // Somewhere along the wall, and far enough in that the whole opening fits.
    expect(f.origin.x).toBeGreaterThan(0);
    expect(f.origin.x + f.widthMm).toBeLessThanOrEqual(5000.001);
  });

  it('has nothing to frame on a blank wall', () => {
    const nodes: BubbleGraphNode[] = [
      storey, ax('a', 0, 0), ax('b', 5000, 0),
      { id: 'w', type: 'wall', name: 'w', x: 0, y: 0, z: 0, parentId: 'st',
        properties: { wall_type: 'W25' } },
    ];
    const edges: BubbleGraphEdge[] = [
      { id: 'e0', from: 'w', to: 'a' }, { id: 'e1', from: 'w', to: 'b' },
    ];
    expect(storeyOpeningFrames(nodes, edges, 'st')).toEqual([]);
  });

  it('ignores a wall on another storey', () => {
    const { nodes, edges } = scene();
    expect(storeyOpeningFrames(nodes, edges, 'other')).toEqual([]);
  });
});

describe('symbolMatrix', () => {
  // The view a floor plan actually uses: u across the page, v UP the model
  // and therefore down the page.
  const flipped = (u: number, v: number) => ({ x: u - 100, y: 800 - v });

  it('carries the symbol frame onto the drawing, flip and all', () => {
    const { nodes, edges } = scene();
    const [f] = storeyOpeningFrames(nodes, edges, 'st');
    const m = symbolMatrix(f, flipped);
    const [a, b, c, d, e, g] = m.slice(7, -1).split(',').map(Number);

    const apply = (x: number, y: number) => ({ x: a * x + c * y + e, y: b * x + d * y + g });
    // Origin maps to the origin's own projection.
    const o = flipped(f.origin.x, f.origin.y);
    expect(apply(0, 0).x).toBeCloseTo(o.x, 3);
    expect(apply(0, 0).y).toBeCloseTo(o.y, 3);
    // The symbol's far corner (W, T) lands on the opening's far inner corner.
    const far = {
      x: f.origin.x + f.along.x * f.widthMm + f.across.x * f.thicknessMm,
      y: f.origin.y + f.along.y * f.widthMm + f.across.y * f.thicknessMm,
    };
    const want = flipped(far.x, far.y);
    expect(apply(f.widthMm, f.thicknessMm).x).toBeCloseTo(want.x, 3);
    expect(apply(f.widthMm, f.thicknessMm).y).toBeCloseTo(want.y, 3);
  });

  it('does not assume which way the view runs', () => {
    const { nodes, edges } = scene();
    const [f] = storeyOpeningFrames(nodes, edges, 'st');
    // A view with v growing DOWN the model gives the mirrored matrix, which
    // is the whole reason the transform is measured rather than composed.
    const upright = (u: number, v: number) => ({ x: u, y: v });
    const mUp = symbolMatrix(f, upright);
    const mDown = symbolMatrix(f, flipped);
    expect(mUp).not.toBe(mDown);
  });
});
