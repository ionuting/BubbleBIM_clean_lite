import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { evaluateQuestline } from './questline';

let seq = 0;
const N = (type: string, props: Record<string, unknown> = {}): BubbleGraphNode =>
  ({ id: `${type}_${seq++}`, type, name: type, x: 0, y: 0, z: 0, properties: props });
const E = (from: string, to: string): BubbleGraphEdge => ({ id: `e_${seq++}`, from, to });

/** Build a full 4-wall room wired to 4 ax corners. */
function room() {
  const ax = [N('ax'), N('ax'), N('ax'), N('ax')];
  const walls = [N('wall'), N('wall'), N('wall'), N('wall')];
  const edges: BubbleGraphEdge[] = [];
  walls.forEach((w, i) => { edges.push(E(w.id, ax[i].id), E(w.id, ax[(i + 1) % 4].id)); });
  return { nodes: [...ax, ...walls], edges };
}

describe('evaluateQuestline', () => {
  it('empty graph → nothing done, grid is the next step', () => {
    const p = evaluateQuestline([], []);
    expect(p.completed).toBe(0);
    expect(p.total).toBe(6);
    expect(p.pct).toBe(0);
    expect(p.allDone).toBe(false);
    expect(p.nextStep?.id).toBe('grid');
  });

  it('grid completes from buildingAxes intersections', () => {
    const p = evaluateQuestline([], [], { xValues: [0, 3000], yValues: [0, 4000] });
    expect(p.steps.find((s) => s.id === 'grid')?.done).toBe(true);
    expect(p.nextStep?.id).toBe('storey');
  });

  it('grid completes from placed ax nodes too', () => {
    const nodes = [N('ax'), N('ax'), N('ax'), N('ax')];
    const p = evaluateQuestline(nodes, []);
    expect(p.steps.find((s) => s.id === 'grid')?.done).toBe(true);
  });

  it('walls only count when anchored to ≥2 ax', () => {
    const ax = [N('ax'), N('ax')];
    const wired = N('wall');
    const dangling = N('wall'); // no edges
    const edges = [E(wired.id, ax[0].id), E(wired.id, ax[1].id)];
    const p = evaluateQuestline([...ax, wired, dangling], edges);
    expect(p.steps.find((s) => s.id === 'walls')?.current).toBe(1); // only the wired one
  });

  it('a full room advances grid + walls, roof still pending', () => {
    const { nodes, edges } = room();
    const p = evaluateQuestline([...nodes, N('storey')], edges);
    const by = Object.fromEntries(p.steps.map((s) => [s.id, s]));
    expect(by.grid.done).toBe(true);
    expect(by.storey.done).toBe(true);
    expect(by.walls.done).toBe(true);
    expect(by.roof.done).toBe(false);
    expect(p.nextStep?.id).toBe('openings');
  });

  it('roof only counts once generated (face_count or members)', () => {
    const bare = evaluateQuestline([N('roof')], []);
    expect(bare.steps.find((s) => s.id === 'roof')?.done).toBe(false);

    const generated = evaluateQuestline([N('roof', { face_count: 4 })], []);
    expect(generated.steps.find((s) => s.id === 'roof')?.done).toBe(true);

    const viaMembers = evaluateQuestline([N('roof'), N('rafter'), N('roof_ridge')], []);
    expect(viaMembers.steps.find((s) => s.id === 'roof')?.done).toBe(true);
  });

  it('a complete little building → allDone', () => {
    const { nodes, edges } = room();
    const full = [
      ...nodes,
      N('storey'),
      N('window'),
      N('slab'),
      N('roof', { face_count: 6, member_count: 20 }),
    ];
    const p = evaluateQuestline(full, edges);
    expect(p.allDone).toBe(true);
    expect(p.pct).toBe(100);
    expect(p.nextStep).toBeNull();
  });

  it('current never exceeds target (display clamp)', () => {
    const many = Array.from({ length: 20 }, () => N('ax'));
    const p = evaluateQuestline(many, []);
    const grid = p.steps.find((s) => s.id === 'grid')!;
    expect(grid.current).toBe(grid.target);
  });
});
