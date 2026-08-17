import { describe, it, expect, beforeAll } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { bounds, ensureBooleanEngine, faceArea, validateSolid, volume, volumeM3 } from './index';
import { buildWallSolids, type WallBody } from './junctions';
import { wallOpeningCutters } from './openings';

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

let seq = 0;
const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `e${seq++}`, from, to });

const bodyOf = (bodies: WallBody[], id: string) => bodies.find((b) => b.id === id)!;

/**
 * One 6 m W20 wall on a 0–3000 storey, plus the given openings wired to it.
 * Each opening spec becomes a window/door node connected to the wall.
 */
function wallWith(openings: Array<{ id: string; type: 'window' | 'door'; props: Record<string, unknown> }>) {
  const a = ax('a', 0, 0);
  const b = ax('b', 6000, 0);
  const wall: BubbleGraphNode = {
    id: 'w', type: 'wall', name: 'W', x: 3000, y: 0, z: 0, parentId: 'st',
    properties: { wall_type: 'W20' },
  };
  const openingNodes: BubbleGraphNode[] = openings.map((o) => ({
    id: o.id, type: o.type, name: o.id, x: 0, y: 0, z: 0, parentId: 'w', properties: o.props,
  }));
  const nodes = [STOREY, a, b, wall, ...openingNodes];
  const edges = [wire('w', 'a'), wire('w', 'b'), ...openings.map((o) => wire('w', o.id))];
  return { nodes, edges, nodeMap: new Map(nodes.map((n) => [n.id, n])), wall };
}

const GROSS = 6000 * 200 * 3000; // solid wall, mm³

// ─── Cutter construction ──────────────────────────────────────────────────────

describe('openingCutter', () => {
  it('spans exactly the wall thickness — no overshoot needed', () => {
    const { nodes, edges, nodeMap, wall } = wallWith([
      { id: 'win', type: 'window', props: { width: 1200, height: 1500, sill_height: 900 } },
    ]);
    void nodes;
    const cutters = wallOpeningCutters(wall, nodeMap, edges);
    expect(cutters).toHaveLength(1);

    const bb = bounds(cutters[0].solid)!;
    // Across the wall: exactly ±100, flush with both faces.
    expect(bb.min.y).toBeCloseTo(-100, 6);
    expect(bb.max.y).toBeCloseTo(100, 6);
    // Vertically: sill 900 up to 900 + 1500.
    expect(bb.min.z).toBeCloseTo(900, 6);
    expect(bb.max.z).toBeCloseTo(2400, 6);
    // Along the wall: 1200 wide, centred on the 6 m span by default.
    expect(bb.max.x - bb.min.x).toBeCloseTo(1200, 6);
    expect((bb.min.x + bb.max.x) / 2).toBeCloseTo(3000, 6);

    expect(volume(cutters[0].solid)).toBeCloseTo(1200 * 200 * 1500, 3);
  });

  it('carries the owning element and its kind', () => {
    const { edges, nodeMap, wall } = wallWith([
      { id: 'dr', type: 'door', props: { width: 900, height: 2100 } },
    ]);
    const [cutter] = wallOpeningCutters(wall, nodeMap, edges);
    expect(cutter.node?.id).toBe('dr');
    expect(cutter.isDoor).toBe(true);
  });

  it('a wall with no openings yields no cutters', () => {
    const { edges, nodeMap, wall } = wallWith([]);
    expect(wallOpeningCutters(wall, nodeMap, edges)).toEqual([]);
  });
});

// ─── Cutting ──────────────────────────────────────────────────────────────────

describe('window openings', () => {
  it('removes exactly the opening volume and leaves a hole in the face', () => {
    const { nodes, edges } = wallWith([
      { id: 'win', type: 'window', props: { width: 1200, height: 1500, sill_height: 900 } },
    ]);
    const { bodies, diagnostics } = buildWallSolids(nodes, edges);
    expect(diagnostics).toEqual([]);

    const w = bodyOf(bodies, 'w');
    expect(validateSolid(w.solid)).toEqual([]);
    expect(volume(w.solid)).toBeCloseTo(GROSS - 1200 * 200 * 1500, 3);

    // Each 6 m × 3 m face comes back as ONE face carrying ONE rectangular hole,
    // not as a scatter of triangles.
    const faces = w.solid.faces.filter((f) => Math.abs(f.normal.y) > 0.99);
    expect(faces).toHaveLength(2);
    for (const f of faces) {
      expect(f.outer).toHaveLength(4);
      expect(f.holes).toHaveLength(1);
      expect(f.holes![0]).toHaveLength(4);
      expect(faceArea(w.solid, w.solid.faces.indexOf(f)))
        .toBeCloseTo(6000 * 3000 - 1200 * 1500, 3);
    }

    // The reveal is real geometry: 2 faces + 4 wall edges + 4 reveal surfaces.
    expect(w.solid.faces).toHaveLength(10);
  });

  it('cuts several windows in one pass', () => {
    const { nodes, edges } = wallWith([
      { id: 'w1', type: 'window', props: { width: 1000, height: 1200, sill_height: 900, offset: 500 } },
      { id: 'w2', type: 'window', props: { width: 1000, height: 1200, sill_height: 900, offset: 2500 } },
      { id: 'w3', type: 'window', props: { width: 1000, height: 1200, sill_height: 900, offset: 4500 } },
    ]);
    const { bodies, diagnostics } = buildWallSolids(nodes, edges);
    expect(diagnostics).toEqual([]);

    const w = bodyOf(bodies, 'w');
    expect(validateSolid(w.solid)).toEqual([]);
    expect(volume(w.solid)).toBeCloseTo(GROSS - 3 * (1000 * 200 * 1200), 3);

    const face = w.solid.faces.find((f) => f.normal.y > 0.99)!;
    expect(face.holes).toHaveLength(3);
  });

  it('the sill is left intact below the opening', () => {
    const { nodes, edges } = wallWith([
      { id: 'win', type: 'window', props: { width: 1200, height: 1500, sill_height: 900 } },
    ]);
    const { bodies } = buildWallSolids(nodes, edges);
    const bb = bounds(bodyOf(bodies, 'w').solid)!;
    // The wall still reaches floor and ceiling — the hole does not reach either.
    expect(bb.min.z).toBeCloseTo(0, 6);
    expect(bb.max.z).toBeCloseTo(3000, 6);
  });
});

describe('door openings', () => {
  it('a door reaching the floor opens the outline rather than leaving a hole', () => {
    const { nodes, edges } = wallWith([
      { id: 'dr', type: 'door', props: { width: 900, height: 2100, sill_height: 0 } },
    ]);
    const { bodies, diagnostics } = buildWallSolids(nodes, edges);
    expect(diagnostics).toEqual([]);

    const w = bodyOf(bodies, 'w');
    expect(validateSolid(w.solid)).toEqual([]);
    expect(volume(w.solid)).toBeCloseTo(GROSS - 900 * 200 * 2100, 3);

    // Meeting the bottom edge makes the notch part of the outer boundary.
    const face = w.solid.faces.find((f) => f.normal.y > 0.99)!;
    expect(face.holes).toBeUndefined();
    expect(face.outer).toHaveLength(8);
  });

  it('a door and a window in the same wall', () => {
    const { nodes, edges } = wallWith([
      { id: 'dr', type: 'door', props: { width: 900, height: 2100, sill_height: 0, offset: 500 } },
      { id: 'win', type: 'window', props: { width: 1200, height: 1500, sill_height: 900, offset: 3000 } },
    ]);
    const { bodies } = buildWallSolids(nodes, edges);
    const w = bodyOf(bodies, 'w');
    expect(validateSolid(w.solid)).toEqual([]);
    expect(volume(w.solid))
      .toBeCloseTo(GROSS - 900 * 200 * 2100 - 1200 * 200 * 1500, 3);
  });
});

// ─── Interaction with junctions ───────────────────────────────────────────────

describe('openings on junction-resolved walls', () => {
  it('a corner wall keeps both its trim and its window', () => {
    const corner = ax('c', 0, 0);
    const wallA: BubbleGraphNode = {
      id: 'wA', type: 'wall', name: 'A', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { wall_type: 'W20' },
    };
    const wallB: BubbleGraphNode = {
      id: 'wB', type: 'wall', name: 'B', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { wall_type: 'W20' },
    };
    const win: BubbleGraphNode = {
      id: 'win', type: 'window', name: 'win', x: 0, y: 0, z: 0, parentId: 'wB',
      properties: { width: 1000, height: 1200, sill_height: 900 },
    };
    const nodes = [STOREY, corner, ax('e', 5000, 0), ax('n', 0, 4000), wallA, wallB, win];
    const edges = [
      wire('wA', 'c'), wire('wA', 'e'),
      wire('wB', 'c'), wire('wB', 'n'), wire('wB', 'win'),
    ];

    const { bodies, diagnostics } = buildWallSolids(nodes, edges);
    expect(diagnostics).toEqual([]);
    for (const b of bodies) expect(validateSolid(b.solid)).toEqual([]);

    // wB yields the corner to the longer wA, AND loses its window volume.
    const withOpenings = bodyOf(bodies, 'wB');
    const { bodies: solidWalls } = buildWallSolids(nodes, edges, { cutOpenings: false });
    const withoutOpenings = bodyOf(solidWalls, 'wB');

    expect(volume(withoutOpenings.solid) - volume(withOpenings.solid))
      .toBeCloseTo(1000 * 200 * 1200, 3);
  });

  it('cutOpenings: false leaves the walls solid', () => {
    const { nodes, edges } = wallWith([
      { id: 'win', type: 'window', props: { width: 1200, height: 1500, sill_height: 900 } },
    ]);
    const { bodies } = buildWallSolids(nodes, edges, { cutOpenings: false });
    expect(volume(bodyOf(bodies, 'w').solid)).toBeCloseTo(GROSS, 3);
  });
});

// ─── Quantity takeoff ─────────────────────────────────────────────────────────

describe('quantity takeoff', () => {
  it('net masonry equals gross minus every opening', () => {
    const { nodes, edges } = wallWith([
      { id: 'dr', type: 'door', props: { width: 900, height: 2100, sill_height: 0, offset: 400 } },
      { id: 'w1', type: 'window', props: { width: 1200, height: 1500, sill_height: 900, offset: 2200 } },
      { id: 'w2', type: 'window', props: { width: 800, height: 1000, sill_height: 1400, offset: 4400 } },
    ]);
    const { bodies, diagnostics } = buildWallSolids(nodes, edges);
    expect(diagnostics).toEqual([]);

    const net = volumeM3(bodyOf(bodies, 'w').solid);
    const openings = (900 * 2100 + 1200 * 1500 + 800 * 1000) * 200;
    expect(net).toBeCloseTo((GROSS - openings) * 1e-9, 9);
    expect(net).toBeLessThan(GROSS * 1e-9);
  });
});
