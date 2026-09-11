/**
 * The plan symbol. A stair in plan is a drawing convention, not a projection:
 * what matters is that the cut splits the steps correctly and that the reader
 * can tell which way is up.
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode } from '@/store';
import { buildStairPlan } from './stairPlan';

const storey = (id: string, bottom: number, top: number): BubbleGraphNode => ({
  id, type: 'storey', name: id, x: 0, y: 0, z: 0,
  properties: { bottomElevation: bottom, topElevation: top },
});

const sw = (over: Record<string, unknown> = {}): BubbleGraphNode => ({
  id: 'sw1', type: 'stairwell', name: 'S', x: 0, y: 0, z: 0, parentId: 'st0',
  properties: { stair_type: 'straight', width_mm: 1000, ...over },
});

const nodes = (over: Record<string, unknown> = {}) => [
  storey('st0', 0, 2900), storey('st1', 2900, 5800), sw(over),
];

describe('buildStairPlan', () => {
  it('splits the steps at the cut plane', () => {
    const p = buildStairPlan(sw(), nodes(), [], 1000)!;
    expect(p.treads.length).toBeGreaterThan(0);
    expect(p.treadsAboveCut.length).toBeGreaterThan(0);
    // 17 risers over 2900 mm; a 1000 mm cut falls just below the 6th.
    expect(p.treads.length + p.treadsAboveCut.length).toBe(17);
  });

  it('moves the split when the cut moves', () => {
    const low = buildStairPlan(sw(), nodes(), [], 500)!;
    const high = buildStairPlan(sw(), nodes(), [], 2000)!;
    expect(high.treads.length).toBeGreaterThan(low.treads.length);
  });

  it('draws every step and no break line when the cut clears the whole flight', () => {
    const p = buildStairPlan(sw(), nodes(), [], 9999)!;
    expect(p.treadsAboveCut).toHaveLength(0);
    expect(p.breakLines).toHaveLength(0);
  });

  it('marks the cut with two parallel break lines', () => {
    const p = buildStairPlan(sw(), nodes(), [], 1000)!;
    expect(p.breakLines).toHaveLength(2);
    const dir = (l: { a: { x: number; y: number }; b: { x: number; y: number } }) =>
      Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x);
    expect(dir(p.breakLines[0])).toBeCloseTo(dir(p.breakLines[1]), 6);
  });

  it('makes each nosing span the flight width, square to the run', () => {
    const p = buildStairPlan(sw({ width_mm: 1200 }), nodes({ width_mm: 1200 }), [], 9999)!;
    for (const t of p.treads) {
      expect(Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y)).toBeCloseTo(1200, 6);
    }
  });

  it('runs the walking line from the start mark upward', () => {
    const p = buildStairPlan(sw(), nodes(), [], 1000)!;
    expect(p.start).toEqual(p.walkingLine[0]);
    expect(p.upArrow!.b).toEqual(p.walkingLine[p.walkingLine.length - 1]);
  });

  it('turns the walking line at the landing of an L', () => {
    const p = buildStairPlan(sw({ stair_type: 'l_shape' }), nodes({ stair_type: 'l_shape' }), [], 9999)!;
    expect(p.walkingLine.length).toBeGreaterThan(2);
    expect(p.landings).toHaveLength(1);
  });

  it('returns null instead of breaking the plan when the stair cannot solve', () => {
    const orphan = { ...sw(), parentId: undefined };
    expect(buildStairPlan(orphan, [orphan], [], 1000)).toBeNull();
  });
});
