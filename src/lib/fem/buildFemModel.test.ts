import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { buildFemModel } from './buildFemModel';
// Deep-imported: @awatif/components ships raw TS with no "exports" map, so
// subpath imports resolve straight to source — no separate build step needed.
import { getPositionsAndForces } from '@awatif/components/analysis/l-solver/getPositionsAndForces';
import { getReactions } from '@awatif/components/analysis/l-solver/getReactions';
import { getFullReactions } from './getFullReactions';

const STOREY: BubbleGraphNode = {
  id: 'st', type: 'storey', name: 'S', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};

/**
 * Simple portal frame: storey 0–3000mm, two columns (C30x30) 5m apart, one
 * beam (B25x50) spanning between their tops.
 */
function portalFrame() {
  const a: BubbleGraphNode = {
    id: 'a', type: 'ax', name: 'a', x: 0, y: 0, z: 0, parentId: 'st',
    properties: { bimX: 0, bimY: 0, has_column: 'True', column_type: 'C30x30' },
  };
  const b: BubbleGraphNode = {
    id: 'b', type: 'ax', name: 'b', x: 5000, y: 0, z: 0, parentId: 'st',
    properties: { bimX: 5000, bimY: 0, has_column: 'True', column_type: 'C30x30' },
  };
  const beam: BubbleGraphNode = {
    id: 'beam1', type: 'beam', name: 'B1', x: 2500, y: 0, z: 0, parentId: 'st',
    properties: { beam_section: 'B25x50' },
  };
  const nodes = [STOREY, a, b, beam];
  const edges: BubbleGraphEdge[] = [
    { id: 'e1', from: 'beam1', to: 'a' },
    { id: 'e2', from: 'beam1', to: 'b' },
  ];
  return { nodes, edges };
}

/** Vertical equilibrium: ΣFz(reactions at every support node) == total self-weight applied. */
function checkVerticalEquilibrium(
  model: ReturnType<typeof buildFemModel>,
  reactions: [number, number, number, number, number, number][] | ReturnType<typeof getFullReactions>,
) {
  const reactionZ = (idx: number) => (reactions instanceof Map ? reactions.get(idx)![2] : reactions[idx][2]);
  const totalAppliedWeight = [...model.loads.values()].reduce((sum, l) => sum - l[2], 0);
  const totalVerticalReaction = [...model.supports.keys()].reduce((sum, idx) => sum + reactionZ(idx), 0);
  expect(Math.abs(totalVerticalReaction - totalAppliedWeight) / totalAppliedWeight).toBeLessThan(1e-6);
}

describe('buildFemModel + @awatif/components linear solver — frame', () => {
  it('with divisions:1, builds 4 nodes / 3 elements (2 columns + 1 beam)', () => {
    const { nodes, edges } = portalFrame();
    const model = buildFemModel(nodes, edges, 'st', { divisions: 1, includeWalls: false, includeSlabs: false });

    expect(model.nodes).toHaveLength(4);
    expect(model.elements).toHaveLength(3);
    expect(model.elementMeta.map((m) => m.kind).sort()).toEqual(['beam', 'column', 'column']);
    expect(model.supports.size).toBe(2);
    for (const s of model.supports.values()) expect(s).toEqual([true, true, true, true, true, true]);
  });

  it('subdivides each member into `divisions` sub-elements', () => {
    const { nodes, edges } = portalFrame();
    const divisions = 4;
    const model = buildFemModel(nodes, edges, 'st', { divisions, includeWalls: false, includeSlabs: false });

    // 3 members (2 columns + 1 beam) × `divisions` sub-elements each.
    expect(model.elements).toHaveLength(3 * divisions);
    // 4 endpoint nodes + (divisions - 1) interior nodes per member.
    expect(model.nodes).toHaveLength(4 + 3 * (divisions - 1));
  });

  it('runs the Awatif linear solver and balances self-weight vertically', () => {
    const { nodes, edges } = portalFrame();
    const model = buildFemModel(nodes, edges, 'st', { includeWalls: false, includeSlabs: false });

    const { positions, internalForces } = getPositionsAndForces(
      model.nodes, model.elements, model.loads, model.supports, model.elementsProps,
    );
    expect(positions).toHaveLength(model.nodes.length * 3);
    expect(positions.every((v) => Number.isFinite(v))).toBe(true);
    expect(internalForces.size).toBe(model.elements.length);

    const reactions = getReactions(model.nodes, model.elements, internalForces, model.loads, model.supports);
    expect(reactions).toHaveLength(model.nodes.length);
    checkVerticalEquilibrium(model, reactions);

    // The beam-column joints are rigid (moment) connections, not pins: the
    // beam sagging under self-weight imposes a real end-rotation on each
    // column top, which a fixed base resists with its OWN nonzero horizontal
    // reaction (classic "sidesway inhibited, joint rotation only" portal-
    // frame behaviour) — so each base is NOT near-zero individually. Mirror
    // symmetry only guarantees the two cancel: ΣFx = ΣFy = 0 overall.
    const sumFx = [...model.supports.keys()].reduce((s, idx) => s + reactions[idx][0], 0);
    const sumFy = [...model.supports.keys()].reduce((s, idx) => s + reactions[idx][1], 0);
    expect(Math.abs(sumFx)).toBeLessThan(1e-3);
    expect(Math.abs(sumFy)).toBeLessThan(1e-3);
  });

  it('getFullReactions agrees with @awatif/components own getReactions on a frame-only model', () => {
    const { nodes, edges } = portalFrame();
    const model = buildFemModel(nodes, edges, 'st', { includeWalls: false, includeSlabs: false });

    const { internalForces } = getPositionsAndForces(model.nodes, model.elements, model.loads, model.supports, model.elementsProps);
    const upstream = getReactions(model.nodes, model.elements, internalForces, model.loads, model.supports);
    const ours = getFullReactions(model.nodes, model.elements, model.elementsProps, model.supports, model.loads);

    for (const idx of model.supports.keys()) {
      for (let d = 0; d < 6; d++) {
        expect(ours.get(idx)![d]).toBeCloseTo(upstream[idx][d], 3);
      }
    }
  });

  it('a subdivided beam actually sags under self-weight (span bending, not just axial column compression)', () => {
    const { nodes, edges } = portalFrame();
    const model = buildFemModel(nodes, edges, 'st', { divisions: 6, includeWalls: false, includeSlabs: false });

    const { positions } = getPositionsAndForces(
      model.nodes, model.elements, model.loads, model.supports, model.elementsProps,
    );

    const beamElements = model.elements.filter((_, i) => model.elementMeta[i].kind === 'beam');
    const beamNodeIdx = [...new Set(beamElements.flat())].sort((i, j) => model.nodes[i][0] - model.nodes[j][0]);
    const zAt = (idx: number) => positions[idx * 3 + 2];

    const zStart = zAt(beamNodeIdx[0]);
    const zEnd = zAt(beamNodeIdx[beamNodeIdx.length - 1]);
    const zMid = zAt(beamNodeIdx[Math.floor(beamNodeIdx.length / 2)]);
    const chordZAtMid = (zStart + zEnd) / 2;

    // True bending sag: midpoint sits below the chord connecting the two ends.
    expect(zMid).toBeLessThan(chordZAtMid);
  });

  it('treats a standalone `column` node (not ax+has_column) the same as a grid column', () => {
    const col: BubbleGraphNode = {
      id: 'col1', type: 'column', name: 'C1', x: 3000, y: 1000, z: 0, parentId: 'st',
      properties: { column_type: 'C25x25' },
    };
    const model = buildFemModel([STOREY, col], [], 'st', { divisions: 1, includeWalls: false, includeSlabs: false });

    expect(model.nodes).toHaveLength(2);
    expect(model.elements).toHaveLength(1);
    expect(model.elementMeta[0]).toEqual({ sourceNodeId: 'col1', kind: 'column' });
    expect(model.columnNodeIndex.has('col1')).toBe(true);
  });
});

/** A 5m × 4m box: 4 corner columns, 4 walls, 1 room (slab). */
function boxWithWallsAndSlab() {
  const ax = (id: string, x: number, y: number): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y, has_column: 'True', column_type: 'C30x30' },
  });
  const wall = (id: string): BubbleGraphNode => ({
    id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
    properties: { wall_type: 'W20' },
  });
  const c0 = ax('c0', 0, 0), c1 = ax('c1', 5000, 0), c2 = ax('c2', 5000, 4000), c3 = ax('c3', 0, 4000);
  const w0 = wall('w0'), w1 = wall('w1'), w2 = wall('w2'), w3 = wall('w3');
  const room: BubbleGraphNode = {
    id: 'room', type: 'room', name: 'R', x: 2500, y: 2000, z: 0, parentId: 'st',
    properties: { slab_type: 'SLAB15' },
  };
  const nodes = [STOREY, c0, c1, c2, c3, w0, w1, w2, w3, room];
  const edges: BubbleGraphEdge[] = [
    { id: 'e0', from: 'w0', to: 'c0' }, { id: 'e1', from: 'w0', to: 'c1' },
    { id: 'e2', from: 'w1', to: 'c1' }, { id: 'e3', from: 'w1', to: 'c2' },
    { id: 'e4', from: 'w2', to: 'c2' }, { id: 'e5', from: 'w2', to: 'c3' },
    { id: 'e6', from: 'w3', to: 'c3' }, { id: 'e7', from: 'w3', to: 'c0' },
    { id: 'e8', from: 'room', to: 'c0' }, { id: 'e9', from: 'room', to: 'c1' },
    { id: 'e10', from: 'room', to: 'c2' }, { id: 'e11', from: 'room', to: 'c3' },
  ];
  return { nodes, edges };
}

describe('buildFemModel + @awatif/components linear solver — shells (walls + slab)', () => {
  it('builds wall (3-node) and slab (3-node) elements alongside the frame', () => {
    const { nodes, edges } = boxWithWallsAndSlab();
    const model = buildFemModel(nodes, edges, 'st', { divisions: 1 });

    const wallEls = model.elements.filter((_, i) => model.elementMeta[i].kind === 'wall');
    const slabEls = model.elements.filter((_, i) => model.elementMeta[i].kind === 'slab');
    expect(wallEls).toHaveLength(4 * 2); // 4 walls × 2 triangles
    expect(slabEls.length).toBeGreaterThan(0);
    for (const el of [...wallEls, ...slabEls]) expect(el).toHaveLength(3);

    // Wall corners at columns reuse the column's FEM nodes (real shared DOF) —
    // no duplicate coincident node created for those corners.
    const c0 = model.columnNodeIndex.get('c0')!;
    expect(model.nodes.filter((n) => n[0] === model.nodes[c0.base][0] && n[1] === model.nodes[c0.base][1] && n[2] === model.nodes[c0.base][2])).toHaveLength(1);
  });

  it('runs the solver on the full box (frame + walls + slab) without blowing up, and balances vertically', () => {
    const { nodes, edges } = boxWithWallsAndSlab();
    const model = buildFemModel(nodes, edges, 'st', { divisions: 2 });

    const { positions } = getPositionsAndForces(
      model.nodes, model.elements, model.loads, model.supports, model.elementsProps,
    );
    expect(positions.every((v) => Number.isFinite(v))).toBe(true);

    // @awatif/components's own getReactions under-counts here (see
    // getFullReactions.ts header) — shell-carried load never reaches it.
    const reactions = getFullReactions(model.nodes, model.elements, model.elementsProps, model.supports, model.loads);
    for (const r of reactions.values()) expect(r.every((v) => Number.isFinite(v))).toBe(true);
    checkVerticalEquilibrium(model, reactions);
  });

  it('models a standalone `slab` node (not a `room`) the same way — direct ax/column anchors', () => {
    const { nodes, edges } = boxWithWallsAndSlab();
    // Swap the `room` node for a standalone `slab` node, same anchors.
    const withoutRoom = nodes.filter((n) => n.type !== 'room');
    const slabNode: BubbleGraphNode = {
      id: 'slab1', type: 'slab', name: 'Slab', x: 2500, y: 2000, z: 0, parentId: 'st',
      properties: { slab_type: 'SLAB15' },
    };
    const slabEdges = edges
      .filter((e) => e.from !== 'room')
      .concat([
        { id: 'se0', from: 'slab1', to: 'c0' }, { id: 'se1', from: 'slab1', to: 'c1' },
        { id: 'se2', from: 'slab1', to: 'c2' }, { id: 'se3', from: 'slab1', to: 'c3' },
      ]);

    const model = buildFemModel([...withoutRoom, slabNode], slabEdges, 'st', { divisions: 1 });
    const slabEls = model.elements.filter((_, i) => model.elementMeta[i].kind === 'slab');
    expect(slabEls.length).toBeGreaterThan(0);
    expect(model.elementMeta.filter((m) => m.kind === 'slab').every((m) => m.sourceNodeId === 'slab1')).toBe(true);

    // Still solves cleanly (frame + walls + standalone slab).
    const { positions } = getPositionsAndForces(model.nodes, model.elements, model.loads, model.supports, model.elementsProps);
    expect(positions.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('skips a room slab when has_slab is False, matching the rest of the app', () => {
    const { nodes, edges } = boxWithWallsAndSlab();
    const noSlabNodes = nodes.map((n) => n.id === 'room'
      ? { ...n, properties: { ...n.properties, has_slab: 'False' } }
      : n);

    const model = buildFemModel(noSlabNodes, edges, 'st', { divisions: 1 });
    expect(model.elementMeta.some((m) => m.kind === 'slab')).toBe(false);
  });

  it("a room's live-load category adds to (not replaces) its slab self-weight", () => {
    const { nodes, edges } = boxWithWallsAndSlab();
    const baseline = buildFemModel(nodes, edges, 'st', { divisions: 1, includeWalls: false });
    const baselineTotal = [...baseline.loads.values()].reduce((s, l) => s - l[2], 0);

    const loaded = nodes.map((n) => n.id === 'room'
      ? { ...n, properties: { ...n.properties, room_load_category: 'storage' } } // 5.0 kN/m², heaviest category
      : n);
    const model = buildFemModel(loaded, edges, 'st', { divisions: 1, includeWalls: false });
    const total = [...model.loads.values()].reduce((s, l) => s - l[2], 0);

    expect(total).toBeGreaterThan(baselineTotal);
    // 5m × 4m room ⇒ 20 m² × (5.0 − 1.5 default-residential) kN/m² = 70 kN of extra live load.
    expect(total - baselineTotal).toBeCloseTo(70_000, -2);
  });

  it("a standalone `slab` node gets no room-category live load (self-weight only)", () => {
    const { nodes, edges } = boxWithWallsAndSlab();
    const withoutRoom = nodes.filter((n) => n.type !== 'room');
    const slabNode: BubbleGraphNode = {
      id: 'slab1', type: 'slab', name: 'Slab', x: 2500, y: 2000, z: 0, parentId: 'st',
      properties: { slab_type: 'SLAB15', room_load_category: 'storage' }, // should be ignored — not a room
    };
    const slabEdges = edges.filter((e) => e.from !== 'room').concat([
      { id: 'se0', from: 'slab1', to: 'c0' }, { id: 'se1', from: 'slab1', to: 'c1' },
      { id: 'se2', from: 'slab1', to: 'c2' }, { id: 'se3', from: 'slab1', to: 'c3' },
    ]);
    const withSlabNode = buildFemModel([...withoutRoom, slabNode], slabEdges, 'st', { divisions: 1, includeWalls: false });

    const roomNodes = nodes.map((n) => n.id === 'room' ? { ...n, properties: { ...n.properties } } : n);
    const withRoomNode = buildFemModel(roomNodes, edges, 'st', { divisions: 1, includeWalls: false });

    const totalSlabNode = [...withSlabNode.loads.values()].reduce((s, l) => s - l[2], 0);
    const totalRoomNode = [...withRoomNode.loads.values()].reduce((s, l) => s - l[2], 0);
    // Same geometry/thickness ⇒ same self-weight-only total for the slab node,
    // versus the room's own default residential (1.5 kN/m²) live load on top.
    expect(totalSlabNode).toBeLessThan(totalRoomNode);
  });
});

/** Two identical boxWithWallsAndSlab() storeys stacked 3m apart, sharing the same corner column plan positions. */
function twoStoreyBuilding() {
  const storey0: BubbleGraphNode = { id: 'st0', type: 'storey', name: 'Parter', x: 0, y: 0, z: 0, properties: { bottomElevation: 0, topElevation: 3000 } };
  const storey1: BubbleGraphNode = { id: 'st1', type: 'storey', name: 'Etaj 1', x: 0, y: 0, z: 0, properties: { bottomElevation: 3000, topElevation: 6000 } };

  const ax = (id: string, x: number, y: number, parentId: string): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId,
    properties: { bimX: x, bimY: y, has_column: 'True', column_type: 'C30x30' },
  });
  const c0a = ax('c0a', 0, 0, 'st0'), c1a = ax('c1a', 5000, 0, 'st0'), c2a = ax('c2a', 5000, 4000, 'st0'), c3a = ax('c3a', 0, 4000, 'st0');
  const c0b = ax('c0b', 0, 0, 'st1'), c1b = ax('c1b', 5000, 0, 'st1'), c2b = ax('c2b', 5000, 4000, 'st1'), c3b = ax('c3b', 0, 4000, 'st1');
  // A column that only starts at the upper storey — no match below, should fall back to a fixed base there.
  const cFloating = ax('cFloating', 2000, 2000, 'st1');

  const nodes = [storey0, storey1, c0a, c1a, c2a, c3a, c0b, c1b, c2b, c3b, cFloating];
  return { nodes, edges: [] as BubbleGraphEdge[] };
}

describe('buildFemModel — multi-storey stacking (storeyId: \'all\')', () => {
  it("stacks storeys at their real elevation and reuses each column's top node as the storey above's base", () => {
    const { nodes, edges } = twoStoreyBuilding();
    const model = buildFemModel(nodes, edges, 'all', { divisions: 1, includeWalls: false, includeSlabs: false });

    // 4 ground columns × 2 nodes + 4 upper columns reusing the ground tops (1 new node each) + 1 floating column × 2 nodes.
    expect(model.nodes).toHaveLength(4 * 2 + 4 * 1 + 2);
    expect(model.elements).toHaveLength(4 + 4 + 1); // one 2-node element per column (divisions:1)

    const groundTop = model.columnNodeIndex.get('c0a')!.top;
    const upperBase = model.columnNodeIndex.get('c0b')!.base;
    expect(upperBase).toBe(groundTop); // real shared DOF, not a coincident duplicate

    // Only the ground base (4) + the floating column's own fresh base (1) are fixed — not the shared joints.
    expect(model.supports.size).toBe(5);
    expect(model.supports.has(model.columnNodeIndex.get('c0a')!.base)).toBe(true);
    expect(model.supports.has(model.columnNodeIndex.get('c0b')!.base)).toBe(false);
    expect(model.supports.has(model.columnNodeIndex.get('cFloating')!.base)).toBe(true);

    // Elevations: ground column spans z=0..3, upper column spans z=3..6.
    expect(model.nodes[model.columnNodeIndex.get('c0a')!.base][2]).toBeCloseTo(0, 6);
    expect(model.nodes[model.columnNodeIndex.get('c0a')!.top][2]).toBeCloseTo(3, 6);
    expect(model.nodes[model.columnNodeIndex.get('c0b')!.top][2]).toBeCloseTo(6, 6);
  });

  it('solves the stacked model cleanly (finite positions, vertical equilibrium)', () => {
    const { nodes, edges } = twoStoreyBuilding();
    const model = buildFemModel(nodes, edges, 'all', { divisions: 2, includeWalls: false, includeSlabs: false });

    const { positions } = getPositionsAndForces(model.nodes, model.elements, model.loads, model.supports, model.elementsProps);
    expect(positions.every((v) => Number.isFinite(v))).toBe(true);

    const reactions = getFullReactions(model.nodes, model.elements, model.elementsProps, model.supports, model.loads);
    checkVerticalEquilibrium(model, reactions);
  });

  it('a single storeyId still behaves exactly as before (baseZ = 0, no stacking)', () => {
    const { nodes, edges } = twoStoreyBuilding();
    const model = buildFemModel(nodes, edges, 'st1', { divisions: 1, includeWalls: false, includeSlabs: false });

    // Only storey 1's own 4 grid columns + the floating one — storey 0 not included at all.
    expect(model.elementMeta.every((m) => ['c0b', 'c1b', 'c2b', 'c3b', 'cFloating'].includes(m.sourceNodeId))).toBe(true);
    expect(model.nodes[model.columnNodeIndex.get('c0b')!.base][2]).toBeCloseTo(0, 6); // baseZ=0, not 3
    expect(model.supports.size).toBe(5); // every base fixed — no cross-storey continuity in single mode
  });

  it("throws when 'all' is requested but the graph has no storeys", () => {
    expect(() => buildFemModel([], [], 'all')).toThrow(/no storeys/);
  });
});
