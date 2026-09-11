import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { cltInputForWall, framingInputForWall, wallJunctions } from './framingInput';

//   D ──N── C      south1: A→M (corner at A, straight on at M)
//   │   │   │      mid:    M→N (tee at both ends)
//   A ──M── B      east:   B→C (corners at both ends)
const storey: BubbleGraphNode = { id: 's1', type: 'storey', name: 'P', x: 0, y: 0, z: 0, parentId: null, properties: {} };
const ax = (id: string, x: number, y: number): BubbleGraphNode =>
  ({ id, type: 'ax', name: id, x, y, z: 0, parentId: 's1', properties: { bimX: x, bimY: y } });
const wall = (id: string, props: Record<string, unknown> = {}): BubbleGraphNode =>
  ({ id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 's1', properties: { wall_type: 'W25', ...props } });
const E = (from: string, to: string): BubbleGraphEdge => ({ id: `${from}-${to}`, from, to });
const nodes = [storey, ax('A', 0, 0), ax('B', 6000, 0), ax('C', 6000, 4000), ax('D', 0, 4000), ax('M', 3000, 0), ax('N', 3000, 4000),
  wall('south1'), wall('south2'), wall('east'), wall('north1'), wall('north2'), wall('west'), wall('mid')];
const edges = [
  E('south1', 'A'), E('south1', 'M'), E('south2', 'M'), E('south2', 'B'),
  E('east', 'B'), E('east', 'C'),
  E('north1', 'C'), E('north1', 'N'), E('north2', 'N'), E('north2', 'D'),
  E('west', 'D'), E('west', 'A'),
  E('mid', 'M'), E('mid', 'N'),
];
const nodeMap = new Map(nodes.map((n) => [n.id, n]));
const byId = (id: string) => nodeMap.get(id)!;

describe('wallJunctions', () => {
  it('a corner at one end; at the other the run continues and the partition tees in', () => {
    expect(wallJunctions(byId('south1'), edges, nodeMap, 3000)).toEqual([{ xMm: 0, kind: 'corner' }, { xMm: 3000, kind: 'tee' }]);
  });
  it('a straight continuation alone is no junction', () => {
    const straight = [storey, ax('A', 0, 0), ax('M', 3000, 0), ax('B', 6000, 0), wall('s1'), wall('s2')];
    const e = [E('s1', 'A'), E('s1', 'M'), E('s2', 'M'), E('s2', 'B')];
    expect(wallJunctions(straight[4], e, new Map(straight.map((n) => [n.id, n])), 3000)).toEqual([]);
  });
  it('corners at both ends of a side wall', () => {
    expect(wallJunctions(byId('east'), edges, nodeMap, 4000)).toEqual([{ xMm: 0, kind: 'corner' }, { xMm: 4000, kind: 'corner' }]);
  });
  it('the partition tees into the two long walls', () => {
    expect(wallJunctions(byId('mid'), edges, nodeMap, 4000)).toEqual([{ xMm: 0, kind: 'tee' }, { xMm: 4000, kind: 'tee' }]);
  });
});

describe('framingInputForWall / cltInputForWall', () => {
  const g = { lengthMm: 4000, heightMm: 2800, thicknessMm: 200, openings: [] };

  it('reads the wall\'s tuning and derives the section from the thickness', () => {
    const f = framingInputForWall(byId('east'), edges, nodeMap, g);
    expect(f.section).toEqual({ wMm: 45, dMm: 145 });
    expect(f.spacingMm).toBeUndefined();
    expect(f.junctions).toHaveLength(2);
    const tuned = framingInputForWall({ ...byId('east'), properties: { stud_spacing_mm: 400, stud_section: 'T4.5x19.5' } }, edges, nodeMap, g);
    expect(tuned.spacingMm).toBe(400);
    expect(tuned.section).toEqual({ wMm: 45, dMm: 195 });
  });

  it('passes the transport limit through', () => {
    expect(cltInputForWall(byId('east'), g).maxPanelLengthMm).toBeUndefined();
    expect(cltInputForWall({ ...byId('east'), properties: { clt_max_panel_mm: 3000 } }, g).maxPanelLengthMm).toBe(3000);
  });
});
