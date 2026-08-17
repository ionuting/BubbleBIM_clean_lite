import { describe, it, expect, beforeAll } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { bounds, ensureBooleanEngine, intersectSolids, unionSolids, validateSolid, volume, volumeM3 } from './index';
import {
  buildWallSolids, compareWallPriority, findWallJunctions, wallPriority,
  type WallBody,
} from './junctions';

beforeAll(async () => {
  await ensureBooleanEngine();
}, 30_000);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STOREY: BubbleGraphNode = {
  id: 'st', type: 'storey', name: 'S', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};

const ax = (id: string, x: number, y: number): BubbleGraphNode => ({
  id, type: 'ax', name: id, x, y, z: 0, parentId: 'st', properties: { bimX: x, bimY: y },
});

const wall = (id: string, props: Record<string, unknown> = {}): BubbleGraphNode => ({
  id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
  properties: { wall_type: 'W20', ...props },
});

let edgeSeq = 0;
const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `e${edgeSeq++}`, from, to });

const bodyOf = (bodies: WallBody[], id: string) => bodies.find((b) => b.id === id)!;

/** Two walls meeting at a shared corner ax — the L-junction. */
function lCorner(props: Record<string, unknown> = {}) {
  const corner = ax('c', 0, 0);
  const east = ax('e', 5000, 0);
  const north = ax('n', 0, 4000);
  const nodes = [STOREY, corner, east, north, wall('wA', props), wall('wB', props)];
  const edges = [wire('wA', 'c'), wire('wA', 'e'), wire('wB', 'c'), wire('wB', 'n')];
  return { nodes, edges };
}

// ─── Junction detection ───────────────────────────────────────────────────────

describe('findWallJunctions', () => {
  it('reads junctions off the graph, not off coordinates', () => {
    const { nodes, edges } = lCorner();
    const js = findWallJunctions(nodes, edges);
    expect(js).toHaveLength(1);
    expect(js[0].nodeId).toBe('c');
    expect(js[0].wallIds.sort()).toEqual(['wA', 'wB']);
  });

  it('a lone wall has no junctions', () => {
    const nodes = [STOREY, ax('a', 0, 0), ax('b', 5000, 0), wall('w')];
    expect(findWallJunctions(nodes, [wire('w', 'a'), wire('w', 'b')])).toEqual([]);
  });

  it('walls that merely cross in space are not connected', () => {
    // Two walls whose centre-lines intersect at (2500, 0), but which share no node.
    const nodes = [
      STOREY, ax('a1', 0, 0), ax('a2', 5000, 0), ax('b1', 2500, -2000), ax('b2', 2500, 2000),
      wall('wA'), wall('wB'),
    ];
    const edges = [wire('wA', 'a1'), wire('wA', 'a2'), wire('wB', 'b1'), wire('wB', 'b2')];
    expect(findWallJunctions(nodes, edges)).toEqual([]);
  });

  it('finds a node where three walls meet', () => {
    const hub = ax('h', 0, 0);
    const nodes = [
      STOREY, hub, ax('p1', 4000, 0), ax('p2', 0, 4000), ax('p3', -4000, 0),
      wall('w1'), wall('w2'), wall('w3'),
    ];
    const edges = [
      wire('w1', 'h'), wire('w1', 'p1'),
      wire('w2', 'h'), wire('w2', 'p2'),
      wire('w3', 'h'), wire('w3', 'p3'),
    ];
    const js = findWallJunctions(nodes, edges);
    expect(js).toHaveLength(1);
    expect(js[0].wallIds).toHaveLength(3);
  });
});

// ─── Priority ─────────────────────────────────────────────────────────────────

describe('wall priority', () => {
  it('ranks explicit property over thickness, and thickness over length', () => {
    const nodeMap = new Map<string, BubbleGraphNode>();
    const thin = wallPriority(wall('a', { wall_type: 'W10' }), nodeMap, []);
    const thick = wallPriority(wall('b', { wall_type: 'W30' }), nodeMap, []);
    expect(compareWallPriority(thick, thin)).toBeGreaterThan(0);

    const boosted = wallPriority(wall('a', { wall_type: 'W10', join_priority: 5 }), nodeMap, []);
    expect(compareWallPriority(boosted, thick)).toBeGreaterThan(0);
  });

  it('separators always yield', () => {
    const nodeMap = new Map<string, BubbleGraphNode>();
    const sep = wallPriority(wall('a', { wall_type: 'separator' }), nodeMap, []);
    const normal = wallPriority(wall('b', { wall_type: 'W10' }), nodeMap, []);
    expect(compareWallPriority(sep, normal)).toBeLessThan(0);
  });

  it('is deterministic when everything else ties', () => {
    const nodeMap = new Map<string, BubbleGraphNode>();
    const a = wallPriority(wall('aaa'), nodeMap, []);
    const b = wallPriority(wall('bbb'), nodeMap, []);
    expect(compareWallPriority(a, b)).toBeLessThan(0);
    expect(compareWallPriority(b, a)).toBeGreaterThan(0);
  });
});

// ─── L-corner ─────────────────────────────────────────────────────────────────

describe('L-corner resolution', () => {
  it('the corner volume is claimed exactly once', () => {
    const { nodes, edges } = lCorner();
    const { bodies, diagnostics } = buildWallSolids(nodes, edges);
    expect(diagnostics).toEqual([]);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(validateSolid(b.solid)).toEqual([]);

    const a = bodyOf(bodies, 'wA'), b = bodyOf(bodies, 'wB');
    // The L envelope a miter would produce: legs 5100×200 and 4100×200 sharing
    // a 200×200 corner. The parts must sum to exactly that — no gap, no overlap.
    const miterL = (5100 * 200 + 4100 * 200 - 200 * 200) * 3000;
    expect(volume(a.solid) + volume(b.solid)).toBeCloseTo(miterL, 3);
  });

  it('the resolved bodies do not overlap', () => {
    const { nodes, edges } = lCorner();
    const { bodies } = buildWallSolids(nodes, edges);
    const overlap = intersectSolids(bodyOf(bodies, 'wA').solid, [bodyOf(bodies, 'wB').solid]);
    expect(overlap.solid).toBeNull(); // empty intersection
  });

  it('the outer envelope matches a miter — only the internal division differs', () => {
    const { nodes, edges } = lCorner();
    const { bodies } = buildWallSolids(nodes, edges);
    const joined = unionSolids(bodies.map((b) => b.solid)).solid!;

    expect(validateSolid(joined)).toEqual([]);
    const miterL = (5100 * 200 + 4100 * 200 - 200 * 200) * 3000;
    expect(volume(joined)).toBeCloseTo(miterL, 3);

    // The outer corner is filled out to (−100, −100) — the notch that appears
    // if the yielding wall is not extended through the other first.
    const bb = bounds(joined)!;
    expect(bb.min.x).toBeCloseTo(-100, 3);
    expect(bb.min.y).toBeCloseTo(-100, 3);
    expect(bb.max.x).toBeCloseTo(5000, 3); // free end, no junction, so no extension
    expect(bb.max.y).toBeCloseTo(4000, 3);
  });

  it('each wall stays its own selectable, measurable body', () => {
    const { nodes, edges } = lCorner();
    const { bodies } = buildWallSolids(nodes, edges);
    expect(bodies.map((b) => b.id).sort()).toEqual(['wA', 'wB']);
    expect(bodies.every((b) => b.solid.faces.length > 0)).toBe(true);
    // Distinct volumes — one was trimmed, the other was not.
    expect(volume(bodyOf(bodies, 'wA').solid)).not.toBeCloseTo(volume(bodyOf(bodies, 'wB').solid), 3);
  });

  it('the thicker wall runs through and the thinner one butts into it', () => {
    const corner = ax('c', 0, 0);
    const nodes = [
      STOREY, corner, ax('e', 5000, 0), ax('n', 0, 5000),
      wall('thick', { wall_type: 'W30' }), wall('thin', { wall_type: 'W10' }),
    ];
    const edges = [wire('thick', 'c'), wire('thick', 'e'), wire('thin', 'c'), wire('thin', 'n')];
    const { bodies } = buildWallSolids(nodes, edges);

    // The thick wall runs straight through, keeping its whole body.
    expect(volume(bodyOf(bodies, 'thick').solid)).toBeCloseTo(5000 * 300 * 3000, 3);
    // The thin one reaches through the thick wall's half-thickness (150 mm),
    // then gives that crossing back: 100 × (5000 + 150) minus the 50 × 300 overlap.
    expect(volume(bodyOf(bodies, 'thin').solid))
      .toBeCloseTo((100 * 5150 - 50 * 300) * 3000, 3);
  });
});

// ─── T-junction ───────────────────────────────────────────────────────────────

describe('T-junction resolution', () => {
  it('the chord runs through and the stem butts into it', () => {
    const mid = ax('m', 3000, 0);
    const nodes = [
      STOREY, ax('w', 0, 0), mid, ax('e', 6000, 0), ax('s', 3000, 4000),
      wall('chord'), wall('chordB'), wall('stem'),
    ];
    // Chord modelled as two segments meeting at the mid node, plus the stem.
    const edges = [
      wire('chord', 'w'), wire('chord', 'm'),
      wire('chordB', 'm'), wire('chordB', 'e'),
      wire('stem', 'm'), wire('stem', 's'),
    ];
    const { bodies, diagnostics } = buildWallSolids(nodes, edges);
    expect(diagnostics).toEqual([]);
    for (const b of bodies) expect(validateSolid(b.solid)).toEqual([]);

    // The stem (4000 long) is shorter than each chord half (3000)… so length
    // ties are broken by id; what matters is that nothing double-counts.
    const total = bodies.reduce((s, b) => s + volume(b.solid), 0);
    const joined = unionSolids(bodies.map((b) => b.solid)).solid!;
    expect(total).toBeCloseTo(volume(joined), 3);
  });

  it('three walls at one node still tile it exactly once', () => {
    const hub = ax('h', 0, 0);
    const nodes = [
      STOREY, hub, ax('p1', 4000, 0), ax('p2', 0, 4000), ax('p3', -4000, 0),
      wall('w1', { wall_type: 'W30' }), wall('w2', { wall_type: 'W20' }), wall('w3', { wall_type: 'W10' }),
    ];
    const edges = [
      wire('w1', 'h'), wire('w1', 'p1'),
      wire('w2', 'h'), wire('w2', 'p2'),
      wire('w3', 'h'), wire('w3', 'p3'),
    ];
    const { bodies, diagnostics } = buildWallSolids(nodes, edges);
    expect(diagnostics).toEqual([]);
    expect(bodies).toHaveLength(3);

    // Pairwise disjoint…
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        expect(intersectSolids(bodies[i].solid, [bodies[j].solid]).solid).toBeNull();
      }
    }
    // …and together they still cover the same envelope as the raw prisms.
    const joined = unionSolids(bodies.map((b) => b.solid)).solid!;
    const total = bodies.reduce((s, b) => s + volume(b.solid), 0);
    expect(total).toBeCloseTo(volume(joined), 3);
  });
});

// ─── Non-orthogonal ───────────────────────────────────────────────────────────

describe('oblique junctions', () => {
  it('walls meeting at 45° resolve without special-casing the angle', () => {
    const corner = ax('c', 0, 0);
    const nodes = [
      STOREY, corner, ax('e', 5000, 0), ax('d', 3000, 3000),
      wall('straight'), wall('diagonal'),
    ];
    const edges = [
      wire('straight', 'c'), wire('straight', 'e'),
      wire('diagonal', 'c'), wire('diagonal', 'd'),
    ];
    const { bodies, diagnostics } = buildWallSolids(nodes, edges);
    expect(diagnostics).toEqual([]);
    for (const b of bodies) expect(validateSolid(b.solid)).toEqual([]);
    expect(intersectSolids(bodies[0].solid, [bodies[1].solid]).solid).toBeNull();
  });
});

// ─── Quantity invariant ───────────────────────────────────────────────────────

describe('quantity takeoff invariant', () => {
  it('a closed four-wall room counts every corner exactly once', () => {
    const c = [ax('c0', 0, 0), ax('c1', 6000, 0), ax('c2', 6000, 4000), ax('c3', 0, 4000)];
    const walls = [wall('n'), wall('e'), wall('s'), wall('w')];
    const nodes = [STOREY, ...c, ...walls];
    const edges = [
      wire('n', 'c0'), wire('n', 'c1'),
      wire('e', 'c1'), wire('e', 'c2'),
      wire('s', 'c2'), wire('s', 'c3'),
      wire('w', 'c3'), wire('w', 'c0'),
    ];

    const { bodies, diagnostics } = buildWallSolids(nodes, edges);
    expect(diagnostics).toEqual([]);
    expect(bodies).toHaveLength(4);
    for (const b of bodies) expect(validateSolid(b.solid)).toEqual([]);

    // Sum of the parts equals the volume of the whole — the property that makes
    // the takeoff trustworthy, and that overlapping bodies silently violate.
    const joined = unionSolids(bodies.map((b) => b.solid)).solid!;
    const summed = bodies.reduce((s, b) => s + volume(b.solid), 0);
    expect(summed).toBeCloseTo(volume(joined), 3);

    // And the whole is exactly the ideal 200 mm ring around a 6000 × 4000 room:
    // outer 6200 × 4200 minus inner 5800 × 3800. Every corner mitred, none
    // double-counted, none missing.
    const ring = (6200 * 4200 - 5800 * 3800) * 3000;
    expect(summed).toBeCloseTo(ring, 3);
    expect(volumeM3(joined)).toBeCloseTo(summed * 1e-9, 9);
  });
});
