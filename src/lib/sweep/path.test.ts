import { describe, expect, it } from 'vitest';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { resolveSweepPath } from './path';
import { DEFAULT_SWEEP_INTENT, type SweepIntent } from './types';

const intent = (over: Partial<SweepIntent> = {}): SweepIntent => ({ ...DEFAULT_SWEEP_INTENT, ...over });

const storey: BubbleGraphNode = {
  id: 'st', type: 'storey', name: 'Parter', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};

const ax = (id: string, x: number, y: number): BubbleGraphNode => ({
  id, type: 'ax', name: id, x: 0, y: 0, z: 0,
  parentId: 'st', properties: { bimX: x, bimY: y },
});

const sweepNode = (parentId: string | null = 'st'): BubbleGraphNode => ({
  id: 'sw', type: 'sweep', name: 'Sweep', x: 0, y: 0, z: 0, parentId, properties: {},
});

function setup(anchors: BubbleGraphNode[], edges: BubbleGraphEdge[], node = sweepNode()) {
  const nodes = [storey, node, ...anchors];
  return { node, nodeMap: new Map(nodes.map((n) => [n.id, n])), edges };
}

const e = (id: string, from: string, to: string): BubbleGraphEdge => ({ id, from, to });

describe('resolveSweepPath', () => {
  it('0 anchors → NO_ANCHORS error', () => {
    const { node, nodeMap } = setup([], []);
    const out = resolveSweepPath(node, nodeMap, [], intent());
    expect(out.path).toBeNull();
    expect(out.diagnostics[0].code).toBe('NO_ANCHORS');
  });

  it('1 anchor → vertical over the storey band', () => {
    const { node, nodeMap, edges } = setup([ax('a', 1000, 2000)], [e('e1', 'sw', 'a')]);
    const out = resolveSweepPath(node, nodeMap, edges, intent());
    expect(out.path!.kind).toBe('vertical');
    expect(out.path!.points).toEqual([
      { x: 1000, y: 2000, z: 0 },
      { x: 1000, y: 2000, z: 3000 },
    ]);
  });

  it('1 anchor with height_mm and offset_z', () => {
    const { node, nodeMap, edges } = setup([ax('a', 0, 0)], [e('e1', 'sw', 'a')]);
    const out = resolveSweepPath(node, nodeMap, edges, intent({ heightMm: 1200, offsetZMm: 300 }));
    expect(out.path!.points[0].z).toBe(300);
    expect(out.path!.points[1].z).toBe(1500);
  });

  it('2 anchors → horizontal at level top + offset', () => {
    const { node, nodeMap, edges } = setup(
      [ax('a', 0, 0), ax('b', 4200, 0)],
      [e('e1', 'sw', 'a'), e('e2', 'sw', 'b')],
    );
    const out = resolveSweepPath(node, nodeMap, edges, intent({ level: 'top', offsetZMm: -300 }));
    expect(out.path!.kind).toBe('horizontal');
    expect(out.path!.points.map((p) => p.z)).toEqual([2700, 2700]);
    expect(out.path!.points[1].x).toBe(4200);
  });

  it('edge ORDER decides the sequence, edge direction does not', () => {
    const { node, nodeMap } = setup(
      [ax('a', 0, 0), ax('b', 1000, 0), ax('c', 1000, 1000)],
      [],
    );
    // b first (reversed edge), then a, then c
    const edges = [e('e1', 'b', 'sw'), e('e2', 'sw', 'a'), e('e3', 'c', 'sw')];
    const out = resolveSweepPath(node, nodeMap, edges, intent());
    expect(out.path!.points.map((p) => `${p.x},${p.y}`)).toEqual(['1000,0', '0,0', '1000,1000']);
  });

  it('coincident consecutive anchors are dropped with a warning', () => {
    const { node, nodeMap } = setup(
      [ax('a', 0, 0), ax('b', 0, 0), ax('c', 2000, 0)],
      [],
    );
    const edges = [e('e1', 'sw', 'a'), e('e2', 'sw', 'b'), e('e3', 'sw', 'c')];
    const out = resolveSweepPath(node, nodeMap, edges, intent());
    expect(out.path!.points).toHaveLength(2);
    expect(out.diagnostics.some((d) => d.code === 'DUPLICATE_POINT')).toBe(true);
  });

  it('closed with only 2 anchors stays open with CLOSED_NEEDS_3', () => {
    const { node, nodeMap } = setup([ax('a', 0, 0), ax('b', 3000, 0)], []);
    const edges = [e('e1', 'sw', 'a'), e('e2', 'sw', 'b')];
    const out = resolveSweepPath(node, nodeMap, edges, intent({ closed: true }));
    expect(out.path!.closed).toBe(false);
    expect(out.diagnostics.some((d) => d.code === 'CLOSED_NEEDS_3')).toBe(true);
  });

  it('closed with 3 anchors closes', () => {
    const { node, nodeMap } = setup(
      [ax('a', 0, 0), ax('b', 3000, 0), ax('c', 0, 3000)],
      [],
    );
    const edges = [e('e1', 'sw', 'a'), e('e2', 'sw', 'b'), e('e3', 'sw', 'c')];
    const out = resolveSweepPath(node, nodeMap, edges, intent({ closed: true }));
    expect(out.path!.closed).toBe(true);
    expect(out.path!.points).toHaveLength(3);
  });

  it('no storey parent → NO_STOREY warning, default band still used', () => {
    const node = sweepNode(null);
    const anchor = { ...ax('a', 0, 0), parentId: null };
    const nodeMap = new Map([[node.id, node], [anchor.id, anchor]]);
    const out = resolveSweepPath(node, nodeMap, [e('e1', 'sw', 'a')], intent());
    expect(out.diagnostics.some((d) => d.code === 'NO_STOREY')).toBe(true);
    expect(out.path!.points[1].z).toBe(3000);
  });
});
