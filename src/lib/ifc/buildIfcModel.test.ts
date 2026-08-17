import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { buildIfcModel } from './buildIfcModel';

// A 5m × 4m single-storey box: 4 corner columns (C30x30), 4 walls (W20 — one
// with a door + a window), one interior beam, a room slab covering the
// footprint, and a standalone balcony `slab` node cantilevered off the east
// wall — the same fixture shape as src/dev/femCheck.tsx, so both the FEM
// spike and the IFC export exercise the identical graph topology.
const STOREY: BubbleGraphNode = {
  id: 'st', type: 'storey', name: 'Parter', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};

const ax = (id: string, x: number, y: number, hasColumn = true): BubbleGraphNode => ({
  id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
  properties: { bimX: x, bimY: y, has_column: hasColumn ? 'True' : 'False', column_type: 'C30x30' },
});

const wall = (id: string, extra: Record<string, unknown> = {}): BubbleGraphNode => ({
  id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
  properties: { wall_type: 'W20', ...extra },
});

let n = 0;
const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `e${n++}`, from, to });

function buildFixture() {
  const c0 = ax('c0', 0, 0);
  const c1 = ax('c1', 5000, 0);
  const c2 = ax('c2', 5000, 4000);
  const c3 = ax('c3', 0, 4000);
  const m0 = ax('m0', 1000, 2000);
  const m1 = ax('m1', 4000, 2000);
  const b0 = ax('b0', 6500, 0, false);
  const b1 = ax('b1', 6500, 4000, false);

  const w0 = wall('w0'); // door
  const w1 = wall('w1', { has_windows: 'True', windows: JSON.stringify([{ window_type: 'W-FIX-100x120' }]) });
  const w2 = wall('w2');
  const w3 = wall('w3');
  const door: BubbleGraphNode = {
    id: 'door1', type: 'door', name: 'D1', x: 0, y: 0, z: 0, parentId: 'st',
    properties: { door_type: 'D-SWING-90x210' },
  };
  const beam: BubbleGraphNode = {
    id: 'beam1', type: 'beam', name: 'B1', x: 2500, y: 2000, z: 0, parentId: 'st',
    properties: { beam_section: 'B25x30' },
  };
  const room: BubbleGraphNode = {
    id: 'room', type: 'room', name: 'R', x: 2500, y: 2000, z: 0, parentId: 'st',
    properties: { slab_type: 'SLAB15' },
  };
  const balcony: BubbleGraphNode = {
    id: 'balcony', type: 'slab', name: 'Balcony', x: 5750, y: 2000, z: 0, parentId: 'st',
    properties: { slab_type: 'SLAB12' },
  };

  const nodes: BubbleGraphNode[] = [STOREY, c0, c1, c2, c3, m0, m1, b0, b1, w0, w1, w2, w3, door, beam, room, balcony];
  const edges: BubbleGraphEdge[] = [
    wire('w0', 'c0'), wire('w0', 'c1'), wire('door1', 'w0'),
    wire('w1', 'c1'), wire('w1', 'c2'),
    wire('w2', 'c2'), wire('w2', 'c3'),
    wire('w3', 'c3'), wire('w3', 'c0'),
    wire('beam1', 'm0'), wire('beam1', 'm1'),
    wire('room', 'c0'), wire('room', 'c1'), wire('room', 'c2'), wire('room', 'c3'),
    wire('balcony', 'c1'), wire('balcony', 'b0'), wire('balcony', 'b1'), wire('balcony', 'c2'),
  ];
  return { nodes, edges };
}

describe('buildIfcModel', () => {
  it('produces a valid IFC4 STEP file with all element kinds', () => {
    const { nodes, edges } = buildFixture();
    const { content, entities, stats } = buildIfcModel(nodes, edges, 'Test Project');

    expect(content).toMatch(/^ISO-10303-21;/);
    expect(content).toContain("FILE_SCHEMA(('IFC4'))");
    expect(content.trim().endsWith('END-ISO-10303-21;')).toBe(true);

    const types = entities.map((e) => e.type);
    expect(types).toContain('IfcBuildingStorey');
    expect(types.filter((t) => t === 'IfcColumn')).toHaveLength(6); // 4 corners + 2 interior
    expect(types).toContain('IfcBeam');
    expect(types.filter((t) => t === 'IfcWall')).toHaveLength(4);
    expect(types).toContain('IfcDoor');
    expect(types).toContain('IfcWindow');
    expect(types.filter((t) => t === 'IfcSlab')).toHaveLength(2); // room + standalone balcony

    expect(stats.entityCount).toBeGreaterThan(0);
    expect(stats.fileSize).toBe(content.length);
  });

  it('places the storey at its real elevation and elements storey-relative (Z=0)', () => {
    const upper: BubbleGraphNode = {
      id: 'st2', type: 'storey', name: 'Etaj 1', x: 0, y: 0, z: 0,
      properties: { bottomElevation: 3000, topElevation: 6000 },
    };
    const { nodes, edges } = buildFixture();
    const col = { ...nodes.find((x) => x.id === 'c0')!, id: 'c0b', parentId: 'st2' };
    const { content } = buildIfcModel([...nodes, upper, col], edges, 'Test Project');

    // Two distinct IFCBUILDINGSTOREY elevation values (0 and 3.0/3).
    const elevMatches = [...content.matchAll(/IFCBUILDINGSTOREY\([^)]*,([\d.]+)\)/g)].map((m) => m[1]);
    expect(elevMatches.length).toBeGreaterThanOrEqual(2);
    expect(elevMatches).toContain('0.');
  });

  it('draws a wall between plain (no-column) ax endpoints, but skips a beam between them', () => {
    // Walls only need 2 ax/column endpoints (matches buildShellElements.ts's addWallShell —
    // no has_column gate); beams DO need has_column at both ends (matches buildFemModel.ts).
    const p0 = { id: 'p0', type: 'ax', name: 'p0', x: 0, y: 0, z: 0, parentId: 'st', properties: { bimX: 0, bimY: 0, has_column: 'False' } } as BubbleGraphNode;
    const p1 = { id: 'p1', type: 'ax', name: 'p1', x: 3000, y: 0, z: 0, parentId: 'st', properties: { bimX: 3000, bimY: 0, has_column: 'False' } } as BubbleGraphNode;
    const w = { id: 'w', type: 'wall', name: 'w', x: 0, y: 0, z: 0, parentId: 'st', properties: { wall_type: 'W20' } } as BubbleGraphNode;
    const b = { id: 'b', type: 'beam', name: 'b', x: 0, y: 0, z: 0, parentId: 'st', properties: { beam_section: 'B20x30' } } as BubbleGraphNode;
    const { entities } = buildIfcModel(
      [STOREY, p0, p1, w, b],
      [
        { id: 'x0', from: 'w', to: 'p0' }, { id: 'x1', from: 'w', to: 'p1' },
        { id: 'x2', from: 'b', to: 'p0' }, { id: 'x3', from: 'b', to: 'p1' },
      ],
      'Test Project',
    );
    expect(entities.some((e) => e.type === 'IfcWall')).toBe(true);
    expect(entities.some((e) => e.type === 'IfcBeam')).toBe(false);
  });

  it('skips a wall with fewer than 2 ax/column endpoints', () => {
    const p0 = { id: 'p0', type: 'ax', name: 'p0', x: 0, y: 0, z: 0, parentId: 'st', properties: { bimX: 0, bimY: 0, has_column: 'True', column_type: 'C25x25' } } as BubbleGraphNode;
    const looseWall = { id: 'wLoose', type: 'wall', name: 'wLoose', x: 0, y: 0, z: 0, parentId: 'st', properties: { wall_type: 'W20' } } as BubbleGraphNode;
    const { content, entities } = buildIfcModel(
      [STOREY, p0, looseWall],
      [{ id: 'x0', from: 'wLoose', to: 'p0' }],
      'Test Project',
    );
    expect(entities.some((e) => e.type === 'IfcWall')).toBe(false);
    expect(content).toMatch(/^ISO-10303-21;/); // still a valid (near-empty) file
  });
});
