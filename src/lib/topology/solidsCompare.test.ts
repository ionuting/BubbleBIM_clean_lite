/**
 * The takeoff held against the solids: rows by node, parts kept apart,
 * overlaps shared half and half, a gap flagged only when it is real.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BubbleGraphNode } from '@/store';
import type { SolidsResult } from './types';

vi.mock('@/lib/quantityTakeoff/geometryMeasures', () => ({
  measureNode: (n: BubbleGraphNode) => ({ w1: { volume_m3: 2.8 }, w2: { volume_m3: 2.0 }, c1: { volume_m3: 0.25 }, r1: { volume_m3: 56 } } as Record<string, { volume_m3: number }>)[n.id] ?? null,
}));

const { compareSolids } = await import('./solidsCompare');

const node = (id: string, type: string): BubbleGraphNode => ({ id, type, name: id.toUpperCase(), x: 0, y: 0, z: 0, properties: {} } as BubbleGraphNode);
const el = (guid: string, type: string, tag: string | null, volumeM3: number) => ({ guid, type, tag, name: null, volumeM3, surfaceM2: 0 });

const solids: SolidsResult = {
  elements: [
    el('g1', 'IfcWall', 'w1', 2.6),          // the body …
    el('g2', 'IfcWall', 'w1:gable', 0.2),    // … and its gable: 2.8 together, matching the takeoff
    el('g3', 'IfcBeam', 'w1:beam', 0.3),     // a part priced on its own line
    el('g4', 'IfcWall', 'w2', 2.3),          // 15 % over the takeoff — flagged
    el('g5', 'IfcColumn', 'c1', 0.2502),     // 0.08 % — within tolerance
    el('g6', 'IfcSlab', 'r1', 3.0),          // a room's slab: listed, never compared
    el('g7', 'IfcBuildingElementProxy', null, 1.0),
  ],
  overlaps: [{ a: 'g1', b: 'g5', volumeM3: 0.04 }, { a: 'g1', b: 'g4', volumeM3: 0.02 }],
  overlapsByType: [],
  failed: [],
  stats: { elements: 7, volumeM3: 8.8502, overlapVolumeM3: 0.06, pairsTested: 5, truncated: false, tookMs: 1 },
};
const nodes = [node('w1', 'wall'), node('w2', 'wall'), node('c1', 'ax'), node('r1', 'room')];

describe('comparing the takeoff with the solids', () => {
  const c = compareSolids(solids, nodes, []);
  const row = (key: string) => c.rows.find((r) => r.key === key)!;

  it('folds a gable into its wall and keeps the beam apart', () => {
    expect(row('w1').solidM3).toBeCloseTo(2.8, 9);
    expect(row('w1').elements).toBe(2);
    expect(row('w1').flagged).toBe(false);
    expect(row('w1:beam').takeoffM3).toBeNull();
    expect(row('w1:beam').name).toBe('W1 · beam');
  });

  it('flags a real gap, and only a real one', () => {
    expect(row('w2').diffPct).toBeCloseTo(0.15, 9);
    expect(row('w2').flagged).toBe(true);
    expect(row('c1').flagged).toBe(false);
    expect(c.totals.flagged).toBe(1);
    expect(c.rows[0].key).toBe('w2');          // flagged rows first
  });

  it('never holds a room’s slab against the room', () => {
    expect(row('r1').takeoffM3).toBeNull();
  });

  it('shares each overlap half and half, and names both sides', () => {
    expect(row('w1').overlapM3).toBeCloseTo(0.03, 9);
    expect(row('c1').overlapM3).toBeCloseTo(0.02, 9);
    expect(c.overlaps[0]).toEqual({ a: 'W1', b: 'C1', volumeM3: 0.04 });
    expect(c.totals.netSolidM3).toBeCloseTo(8.8502 - 0.06, 9);
    expect(c.totals.comparedTakeoffM3).toBeCloseTo(2.8 + 2.0 + 0.25, 9);
  });

  it('keeps an element with no node, by its IFC type', () => {
    expect(c.rows.some((r) => r.nodeId === null && r.name === 'IfcBuildingElementProxy')).toBe(true);
  });
});
