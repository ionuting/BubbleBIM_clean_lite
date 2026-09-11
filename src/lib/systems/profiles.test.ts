import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  SYSTEM_PROFILES, adaptGraphToSystem, anchorNeedsColumn, columnFor, isNativeWallType, profileFor,
  slabTypeGroups, summaryChanged, wallTypeGroups,
} from './profiles';
import { STRUCTURAL_SYSTEMS } from './structuralSystem';

// A 6 × 4 m box on one storey with a partition down the middle:
//
//   D ──N── C
//   │   │   │      mid (M–N) is interior, the six ring walls exterior
//   A ──M── B
const storey: BubbleGraphNode = {
  id: 's1', type: 'storey', name: 'P', x: 0, y: 0, z: 0, parentId: null,
  properties: { bottomElevation: 0, topElevation: 3000 },
};
const ax = (id: string, x: number, y: number, props: Record<string, unknown> = {}): BubbleGraphNode =>
  ({ id, type: 'ax', name: id, x, y, z: 0, parentId: 's1', properties: { bimX: x, bimY: y, ...props } });
const wall = (id: string, props: Record<string, unknown> = {}): BubbleGraphNode =>
  ({ id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 's1', properties: { wall_type: 'W25', ...props } });
const E = (from: string, to: string): BubbleGraphEdge => ({ id: `${from}-${to}`, from, to });

const A = ax('A', 0, 0), B = ax('B', 6000, 0), C = ax('C', 6000, 4000), D = ax('D', 0, 4000);
const M = ax('M', 3000, 0), N = ax('N', 3000, 4000);
const slab: BubbleGraphNode = { id: 'sl', type: 'slab', name: 'sl', x: 0, y: 0, z: 0, parentId: 's1', properties: { slab_type: 'SLAB15' } };
const gyp = wall('gyp', { wall_type: 'W10' });
const walls = [wall('south1'), wall('south2'), wall('east'), wall('north1'), wall('north2'), wall('west'), wall('mid', { wall_type: 'W15' }), gyp];
const base: BubbleGraphNode[] = [storey, A, B, C, D, M, N, ...walls, slab];
const edges: BubbleGraphEdge[] = [
  E('south1', 'A'), E('south1', 'M'), E('south2', 'M'), E('south2', 'B'),
  E('east', 'B'), E('east', 'C'),
  E('north1', 'C'), E('north1', 'N'), E('north2', 'N'), E('north2', 'D'),
  E('west', 'D'), E('west', 'A'),
  E('mid', 'M'), E('mid', 'N'),
  E('gyp', 'M'), E('gyp', 'C'),
  E('sl', 'A'), E('sl', 'B'), E('sl', 'C'), E('sl', 'D'),
];
const byId = (nodes: BubbleGraphNode[], id: string) => nodes.find((n) => n.id === id)!;

describe('profiles', () => {
  it('every system in the vocabulary has a profile with valid defaults', () => {
    for (const s of STRUCTURAL_SYSTEMS) {
      const p = SYSTEM_PROFILES[s];
      expect(p.system).toBe(s);
      expect(isNativeWallType(s, p.defaults.exteriorWall)).toBe(true);
      expect(isNativeWallType(s, p.defaults.interiorWall)).toBe(true);
      expect(p.slabTypes).toContain(p.defaults.slab);
    }
  });

  it('gypsum partitions are native everywhere; a stud wall is foreign to masonry', () => {
    expect(isNativeWallType('confined_masonry', 'W10')).toBe(true);
    expect(isNativeWallType('clt', 'W12')).toBe(true);
    expect(isNativeWallType('confined_masonry', 'TF20')).toBe(false);
    expect(isNativeWallType('timber_frame', 'W25')).toBe(false);
    expect(isNativeWallType('clt', 'CLT120')).toBe(true);
  });

  it('pickers get the system\'s own types first', () => {
    const g = wallTypeGroups('timber_frame');
    expect(g.native.map((t) => t.id)).toEqual(['W10', 'W12', 'TF14', 'TF20', 'TF25']);
    expect(g.other.some((t) => t.id === 'W25')).toBe(true);
    expect(slabTypeGroups('clt').native.map((t) => t.id)).toEqual(['CLT160', 'CLT200']);
  });

  it('a frame column grows from three storeys', () => {
    expect(columnFor(profileFor('rc_frame'), 2)).toBe('C25x25');
    expect(columnFor(profileFor('rc_frame'), 3)).toBe('C30x30');
    expect(columnFor(profileFor('confined_masonry'), 5)).toBe('C25x25');
  });
});

describe('adaptGraphToSystem — timber frame', () => {
  const { nodes, summary } = adaptGraphToSystem(base, edges, 'timber_frame');

  it('retypes exterior walls to TF20 and the interior one to TF14, keeps the gypsum partition', () => {
    expect(byId(nodes, 'east').properties.wall_type).toBe('TF20');
    expect(byId(nodes, 'south1').properties.wall_type).toBe('TF20');
    expect(byId(nodes, 'mid').properties.wall_type).toBe('TF14');
    expect(byId(nodes, 'gyp')).toBe(gyp);
    expect(summary.wallsRetyped).toBe(7);
  });

  it('the floor becomes a joist floor', () => {
    expect(byId(nodes, 'sl').properties.slab_type).toBe('TJ20');
    expect(summary.slabsRetyped).toBe(1);
  });

  it('shares every untouched node and never touches the base', () => {
    expect(byId(nodes, 's1')).toBe(storey);
    expect(byId(nodes, 'A')).toBe(A);
    expect(base.find((n) => n.id === 'east')!.properties.wall_type).toBe('W25');
  });

  it('is idempotent', () => {
    const again = adaptGraphToSystem(nodes, edges, 'timber_frame');
    expect(again.nodes).toBe(nodes);
    expect(summaryChanged(again.summary)).toBe(false);
  });

  it('strips concrete columns and ring beams a masonry model carried', () => {
    const masonry = adaptGraphToSystem(base, edges, 'confined_masonry').nodes;
    const timber = adaptGraphToSystem(masonry, edges, 'timber_frame');
    expect(timber.summary.columnsRemoved).toBeGreaterThan(0);
    expect(timber.summary.beamsRemoved).toBeGreaterThan(0);
    expect(timber.nodes.filter((n) => n.type === 'ax').every((n) => n.properties.has_column === 'False')).toBe(true);
  });
});

describe('adaptGraphToSystem — confined masonry / RC frame', () => {
  const { nodes, summary } = adaptGraphToSystem(base, edges, 'confined_masonry');

  it('puts a column on every ring anchor and none where nothing needs one', () => {
    for (const id of ['A', 'B', 'C', 'D', 'M', 'N']) expect(byId(nodes, id).properties.has_column).toBe('True');
    expect(summary.columnsAdded).toBe(6);
    expect(byId(nodes, 'A').properties.column_type).toBe('C25x25');
  });

  it('puts a ring beam over every anchored structural wall, not over the gypsum partition', () => {
    expect(byId(nodes, 'east').properties.has_beam).toBe('True');
    expect(byId(nodes, 'mid').properties.has_beam).toBe('True');
    expect(byId(nodes, 'east').properties.beam_section).toBe('B20x30');
    expect(byId(nodes, 'gyp')).toBe(gyp);
    expect(summary.beamsAdded).toBe(7);
  });

  it('keeps the brick walls as they are', () => {
    expect(summary.wallsRetyped).toBe(0);
    expect(byId(nodes, 'east').properties.wall_type).toBe('W25');
  });

  it('respects a column the user already sized', () => {
    const sized = base.map((n) => (n.id === 'A' ? { ...n, properties: { ...n.properties, has_column: 'True', column_type: 'C40x40' } } : n));
    const out = adaptGraphToSystem(sized, edges, 'rc_frame').nodes;
    expect(byId(out, 'A').properties.column_type).toBe('C40x40');
    expect(byId(out, 'B').properties.column_type).toBe('C25x25');
    expect(byId(out, 'east').properties.beam_section).toBe('B25x40');
  });

  it('a mid-run anchor with two collinear walls gets no column; an angled one does', () => {
    const nodeMap = new Map(base.map((n) => [n.id, n]));
    const s1 = byId(base, 'south1'), s2 = byId(base, 'south2'), mid = byId(base, 'mid');
    expect(anchorNeedsColumn(M, [s1, s2], false, edges, nodeMap)).toBe(false);
    expect(anchorNeedsColumn(M, [s1, mid], false, edges, nodeMap)).toBe(true);
    expect(anchorNeedsColumn(M, [s1, s2, mid], false, edges, nodeMap)).toBe(true);
    expect(anchorNeedsColumn(M, [s1], true, edges, nodeMap)).toBe(true);
  });
});

describe('adaptGraphToSystem — CLT and the untouched systems', () => {
  it('CLT retypes walls to panels and the floor to a CLT floor', () => {
    const { nodes } = adaptGraphToSystem(base, edges, 'clt');
    expect(byId(nodes, 'east').properties.wall_type).toBe('CLT120');
    expect(byId(nodes, 'mid').properties.wall_type).toBe('CLT100');
    expect(byId(nodes, 'sl').properties.slab_type).toBe('CLT160');
  });

  it('unset changes nothing', () => {
    const r = adaptGraphToSystem(base, edges, 'unset');
    expect(r.nodes).toBe(base);
    expect(summaryChanged(r.summary)).toBe(false);
  });

  it('options can hold back retyping or the frame', () => {
    const noRetype = adaptGraphToSystem(base, edges, 'timber_frame', { retype: false });
    expect(noRetype.summary.wallsRetyped).toBe(0);
    const noFrame = adaptGraphToSystem(base, edges, 'rc_frame', { frame: false });
    expect(noFrame.summary.columnsAdded).toBe(0);
    expect(noFrame.summary.beamsAdded).toBe(0);
  });

  it('a wall with no ring falls back on its thickness', () => {
    const loose = [storey, A, B, wall('w', { wall_type: 'W25' }), wall('t', { wall_type: 'W15' })];
    const e = [E('w', 'A'), E('w', 'B'), E('t', 'A'), E('t', 'B')];
    const { nodes } = adaptGraphToSystem(loose, e, 'timber_frame');
    expect(byId(nodes, 'w').properties.wall_type).toBe('TF20');
    expect(byId(nodes, 't').properties.wall_type).toBe('TF14');
  });
});
