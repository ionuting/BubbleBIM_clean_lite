import { describe, expect, it } from 'vitest';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { computeSweep } from './index';

/**
 * End-to-end pin through the REAL node contract: properties exactly as
 * nodeLibrary.json ships them — numbers as numbers, booleans as 'True'/'False'
 * strings — so a change to parseSweepIntent or the defaults breaks here first.
 */
const DEFAULTS: Record<string, unknown> = {
  profile: 'rect',
  p_w_mm: 300,
  p_h_mm: 600,
  anchor_x: 'mid',
  anchor_y: 'max',
  level: 'top',
  offset_z_mm: 0,
  offset_x_mm: 0,
  rotation_deg: 0,
  mirror: 'False',
  corners: 'miter',
  closed: 'False',
  height_mm: 0,
  material: 'Beton C30/37',
};

const storey: BubbleGraphNode = {
  id: 'st', type: 'storey', name: 'Parter', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};
const ax = (id: string, x: number, y: number): BubbleGraphNode => ({
  id, type: 'ax', name: id, x: 0, y: 0, z: 0, parentId: 'st',
  properties: { bimX: x, bimY: y },
});

function build(anchorPts: [string, number, number][], props: Record<string, unknown> = {}) {
  const sweep: BubbleGraphNode = {
    id: 'sw', type: 'sweep', name: 'Sweep1', x: 0, y: 0, z: 0, parentId: 'st',
    properties: { ...DEFAULTS, ...props },
  };
  const anchors = anchorPts.map(([id, x, y]) => ax(id, x, y));
  const nodes = [storey, sweep, ...anchors];
  const edges: BubbleGraphEdge[] = anchors.map((a, i) => ({ id: `e${i}`, from: 'sw', to: a.id }));
  return { sweep, nodeMap: new Map(nodes.map((n) => [n.id, n])), edges };
}

describe('computeSweep on library-default properties', () => {
  it('2 axes → a beam-like solid hung from the storey top', () => {
    const { sweep, nodeMap, edges } = build([['a', 0, 0], ['b', 4200, 0]]);
    const res = computeSweep(sweep, nodeMap, edges);
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(res.path!.kind).toBe('horizontal');
    expect(res.solids).toHaveLength(1);
    expect(res.lengthMm).toBe(4200);
    // anchor_y 'max' hangs the 600 profile below the storey top
    expect(res.zMaxMm).toBeCloseTo(3000, 6);
    expect(res.zMinMm).toBeCloseTo(2400, 6);
    expect(res.volumeMm3).toBeCloseTo(300 * 600 * 4200, -3);
    expect(res.footprint).toHaveLength(1);
  });

  it('1 ax → a column-like vertical over the band', () => {
    const { sweep, nodeMap, edges } = build([['a', 1000, 2000]]);
    const res = computeSweep(sweep, nodeMap, edges);
    expect(res.path!.kind).toBe('vertical');
    expect(res.zMinMm).toBe(0);
    expect(res.zMaxMm).toBe(3000);
    expect(res.volumeMm3).toBeCloseTo(300 * 600 * 3000, -3);
  });

  it("closed:'True' with 4 axes → a ring", () => {
    const { sweep, nodeMap, edges } = build(
      [['a', 0, 0], ['b', 4000, 0], ['c', 4000, 4000], ['d', 0, 4000]],
      { closed: 'True' },
    );
    const res = computeSweep(sweep, nodeMap, edges);
    expect(res.path!.closed).toBe(true);
    expect(res.solids[0].loop).toBe(true);
    expect(res.lengthMm).toBe(16000);
  });

  it('unknown profile id → PROFILE_UNAVAILABLE, no solids, no throw', () => {
    const { sweep, nodeMap, edges } = build([['a', 0, 0], ['b', 4000, 0]], { profile: 'dxf:nope' });
    const res = computeSweep(sweep, nodeMap, edges);
    expect(res.solids).toHaveLength(0);
    expect(res.diagnostics.some((d) => d.code === 'PROFILE_UNAVAILABLE')).toBe(true);
  });
});
