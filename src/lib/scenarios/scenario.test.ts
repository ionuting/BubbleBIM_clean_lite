import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  applyScenario, classifyWallSides, createScenario, freeSlot, graphHash, hashValue, nodeHash,
  patchScenario, scenarioDeltaHash, touchedNodeIds,
} from './scenario';
import type { Scenario } from './types';

// A 6 × 4 m box on one storey with a partition down the middle:
//
//   D ───── C
//   │   │   │      the middle wall (M–N) is interior, the four sides exterior
//   A ───── B
const storey: BubbleGraphNode = {
  id: 's1', type: 'storey', name: 'P', x: 0, y: 0, z: 0, parentId: null,
  properties: { bottomElevation: 0, topElevation: 3000 },
};
const ax = (id: string, x: number, y: number): BubbleGraphNode =>
  ({ id, type: 'ax', name: id, x, y, z: 0, parentId: 's1', properties: { bimX: x, bimY: y } });
const wall = (id: string, props: Record<string, unknown> = {}): BubbleGraphNode =>
  ({ id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 's1', properties: { wall_type: 'W25', ...props } });
const E = (from: string, to: string): BubbleGraphEdge => ({ id: `${from}-${to}`, from, to });

const A = ax('A', 0, 0), B = ax('B', 6000, 0), C = ax('C', 6000, 4000), D = ax('D', 0, 4000);
const M = ax('M', 3000, 0), N = ax('N', 3000, 4000);
const walls = [wall('south1'), wall('south2'), wall('east'), wall('north1'), wall('north2'), wall('west'), wall('mid')];
const room: BubbleGraphNode = { id: 'r', type: 'room', name: 'r', x: 0, y: 0, z: 0, parentId: 's1', properties: {} };
const base: BubbleGraphNode[] = [storey, A, B, C, D, M, N, ...walls, room];
const edges: BubbleGraphEdge[] = [
  E('south1', 'A'), E('south1', 'M'), E('south2', 'M'), E('south2', 'B'),
  E('east', 'B'), E('east', 'C'),
  E('north1', 'C'), E('north1', 'N'), E('north2', 'N'), E('north2', 'D'),
  E('west', 'D'), E('west', 'A'),
  E('mid', 'M'), E('mid', 'N'),
];

const sc = (init: Partial<Scenario>): Scenario => ({
  id: 'x', name: 'x', slot: 0, createdAt: '', rules: [], patches: {}, ...init,
});

describe('classifyWallSides', () => {
  it('marks the ring exterior and the partition interior', () => {
    const sides = classifyWallSides(base, edges);
    for (const id of ['south1', 'south2', 'east', 'north1', 'north2', 'west']) expect(sides.get(id)).toBe('exterior');
    expect(sides.get('mid')).toBe('interior');
  });
});

describe('applyScenario', () => {
  it('returns the very same array when there is nothing to apply', () => {
    expect(applyScenario(base, edges, null)).toBe(base);
    expect(applyScenario(base, edges, sc({}))).toBe(base);
  });

  it('a rule rewrites only the matching nodes and keeps every other object identical', () => {
    const s = sc({ rules: [{ where: { nodeType: 'wall', side: 'exterior' }, set: { wall_type: 'TF20' } }] });
    const out = applyScenario(base, edges, s);
    expect(out).not.toBe(base);
    expect(out).toHaveLength(base.length);
    for (let i = 0; i < base.length; i++) {
      const b = base[i], o = out[i];
      if (b.type === 'wall' && b.id !== 'mid') {
        expect(o).not.toBe(b);
        expect(o.properties.wall_type).toBe('TF20');
      } else {
        expect(o).toBe(b);     // structural sharing — the whole economy of scenarios
      }
    }
    expect(base.find((n) => n.id === 'east')!.properties.wall_type).toBe('W25');   // base untouched
  });

  it('a rule already satisfied changes nothing', () => {
    const s = sc({ rules: [{ where: { nodeType: 'wall' }, set: { wall_type: 'W25' } }] });
    expect(applyScenario(base, edges, s)).toBe(base);
  });

  it('a patch beats a rule, and a patch equal to the base is a no-op', () => {
    const s = sc({
      rules: [{ where: { nodeType: 'wall' }, set: { wall_type: 'TF20' } }],
      patches: { east: { wall_type: 'W30' }, west: { wall_type: 'W25' } },
    });
    const out = applyScenario(base, edges, s);
    expect(out.find((n) => n.id === 'east')!.properties.wall_type).toBe('W30');
    // west: rule made it TF20, then the patch put W25 back.
    expect(out.find((n) => n.id === 'west')!.properties.wall_type).toBe('W25');
    const only = sc({ patches: { west: { wall_type: 'W25' } } });
    expect(applyScenario(base, edges, only)).toBe(base);
  });

  it('a property filter narrows the rule', () => {
    const marked = base.map((n) => (n.id === 'mid' ? { ...n, properties: { ...n.properties, tag: 'x' } } : n));
    const s = sc({ rules: [{ where: { nodeType: 'wall', prop: 'tag', equals: 'x' }, set: { wall_type: 'TF14' } }] });
    expect(touchedNodeIds(marked, edges, s)).toEqual(new Set(['mid']));
  });

  it('a scenario system stamps the elements whose decomposition depends on it', () => {
    const withOverride = base.map((n) => (n.id === 'mid'
      ? { ...n, properties: { ...n.properties, structural_system: 'confined_masonry' } } : n));
    const s = sc({ structuralSystem: 'timber_frame' });
    const out = applyScenario(withOverride, edges, s);
    expect(out.find((n) => n.id === 'east')!.properties.structural_system).toBe('timber_frame');
    // An element's own choice outranks the scenario, exactly like the project default.
    expect(out.find((n) => n.id === 'mid')!.properties.structural_system).toBe('confined_masonry');
    expect(out.find((n) => n.id === 'r')).toBe(room);
    expect(out.find((n) => n.id === 'A')).toBe(A);
  });
});

describe('hashing', () => {
  it('is independent of key order and of node order', () => {
    expect(hashValue({ a: 1, b: [1, 2] })).toBe(hashValue({ b: [1, 2], a: 1 }));
    expect(graphHash(base, edges)).toBe(graphHash([...base].reverse(), [...edges].reverse()));
  });

  it('changes when a property changes', () => {
    const other = base.map((n) => (n.id === 'east' ? { ...n, properties: { ...n.properties, wall_type: 'W30' } } : n));
    expect(graphHash(other, edges)).not.toBe(graphHash(base, edges));
  });

  it('memoises per node object', () => {
    expect(nodeHash(A)).toBe(nodeHash(A));
    expect(nodeHash(A)).toBe(nodeHash({ ...A }));   // same content, fresh object
  });

  it('the delta hash ignores the name and the cached result', () => {
    const s = sc({ rules: [{ where: { nodeType: 'wall' }, set: { wall_type: 'TF20' } }] });
    const renamed = { ...s, name: 'other', result: { hash: 'h' } as never };
    expect(scenarioDeltaHash(renamed)).toBe(scenarioDeltaHash(s));
    expect(scenarioDeltaHash({ ...s, prices: { x: 1 } })).not.toBe(scenarioDeltaHash(s));
  });
});

describe('construction helpers', () => {
  it('hands out the first free palette slot', () => {
    const a = createScenario('a', []);
    const b = createScenario('b', [a]);
    expect(a.slot).toBe(0);
    expect(b.slot).toBe(1);
    expect(freeSlot([a, b, { ...a, id: 'c', slot: 2 }, { ...a, id: 'd', slot: 3 }])).toBe(0);
  });

  it('patchScenario drops a key that returns to the base value', () => {
    let s = sc({});
    s = patchScenario(s, base, 'east', 'wall_type', 'W30');
    expect(s.patches.east).toEqual({ wall_type: 'W30' });
    s = patchScenario(s, base, 'east', 'wall_type', 'W25');
    expect(s.patches.east).toBeUndefined();
  });
});
