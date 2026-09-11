import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { calcWallGeometry, getAxRealPos, getNodeWallThickness, parseWallThickness, MM } from './bimGeometry';

/** storey 0–3000mm + two ax + a wall wired between them. */
function scene(wallProps: Record<string, unknown>) {
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'S', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const a: BubbleGraphNode = { id: 'a', type: 'ax', name: 'a', x: 0, y: 0, z: 0, parentId: 'st', properties: { bimX: 0, bimY: 0 } };
  const b: BubbleGraphNode = { id: 'b', type: 'ax', name: 'b', x: 5000, y: 0, z: 0, parentId: 'st', properties: { bimX: 5000, bimY: 0 } };
  const wall: BubbleGraphNode = { id: 'w', type: 'wall', name: 'W', x: 2500, y: 0, z: 0, parentId: 'st', properties: wallProps };
  const nodeMap = new Map<string, BubbleGraphNode>([[storey.id, storey], [a.id, a], [b.id, b], [wall.id, wall]]);
  const edges: BubbleGraphEdge[] = [
    { id: 'e1', from: 'w', to: 'a' },
    { id: 'e2', from: 'w', to: 'b' },
  ];
  return { wall, nodeMap, edges };
}

describe('wall height vs ring beam', () => {
  it('no beam → wall spans the full storey height', () => {
    const { wall, nodeMap, edges } = scene({ wall_type: 'W20' });
    const g = calcWallGeometry(wall, nodeMap, edges)!;
    expect(g.wallH).toBe(3000);
    expect(g.beamDesc).toBeUndefined();
  });

  it('with beam → masonry height = storey − beam, and they meet exactly', () => {
    const { wall, nodeMap, edges } = scene({ wall_type: 'W20', has_beam: 'True', beam_section: 'B20x30' });
    const g = calcWallGeometry(wall, nodeMap, edges)!;
    // B20x30 → beam height 30cm = 300mm.
    expect(g.wallH).toBe(2700);
    expect(g.beamDesc).toBeDefined();
    expect(g.beamDesc!.height).toBeCloseTo(0.30, 6);
    // Wall top (botM + wallH) meets beam bottom (baseY) with no overlap/gap.
    const wallTopM = g.botM + g.wallH * MM;
    expect(wallTopM).toBeCloseTo(g.beamDesc!.baseY, 6);
    // Beam top reaches the storey top (3.0 m).
    expect(g.beamDesc!.baseY + g.beamDesc!.height).toBeCloseTo(3.0, 6);
  });

  it('explicit height overrides the beam-derived height', () => {
    const { wall, nodeMap, edges } = scene({ wall_type: 'W20', has_beam: 'True', beam_section: 'B20x30', height: 2500 });
    const g = calcWallGeometry(wall, nodeMap, edges)!;
    expect(g.wallH).toBe(2500);
    expect(g.beamDesc).toBeDefined();
  });
});

describe('getAxRealPos — grid offsets', () => {
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'S', x: 0, y: 0, z: 0,
    properties: { axesX: [0, 5000, 10000], axesY: [0, 4000] },
  };
  const grid = (props: Record<string, unknown>): BubbleGraphNode =>
    ({ id: 'g', type: 'ax', name: 'g', x: 0, y: 0, z: 0, parentId: 'st', properties: props });
  const map = (n: BubbleGraphNode) => new Map<string, BubbleGraphNode>([[storey.id, storey], [n.id, n]]);

  it('adds ax_dx_mm / ax_dy_mm to the grid value', () => {
    const n = grid({ gridX: 1, gridY: 1, ax_dx_mm: 500, ax_dy_mm: -250 });
    expect(getAxRealPos(n, map(n))).toEqual({ x: 5500, y: 3750 });
  });

  it('bimX/bimY still win over grid + offset', () => {
    const n = grid({ gridX: 1, gridY: 1, ax_dx_mm: 500, bimX: 123, bimY: 456 });
    expect(getAxRealPos(n, map(n))).toEqual({ x: 123, y: 456 });
  });

  it('does not sort the stored axes in place', () => {
    const s: BubbleGraphNode = { ...storey, properties: { axesX: [10000, 0, 5000], axesY: [4000, 0] } };
    const n = grid({ gridX: 1, gridY: 1 });
    expect(getAxRealPos(n, new Map([[s.id, s], [n.id, n]]))).toEqual({ x: 5000, y: 4000 });
    expect(s.properties.axesX).toEqual([10000, 0, 5000]);
  });
});

describe('getNodeWallThickness — custom thicknesses', () => {
  const wall = (properties: Record<string, unknown>): BubbleGraphNode =>
    ({ id: 'w1', type: 'wall', name: 'W', x: 0, y: 0, z: 0, properties } as BubbleGraphNode);

  it('falls back to the type when nothing custom is set', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'W25' }))).toBeCloseTo(0.25, 6);
    expect(getNodeWallThickness(wall({}))).toBeCloseTo(0.20, 6);
  });

  it('A 60 cm WALL: the custom value wins over the type', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'W25', wall_custom_mm: 600 }))).toBeCloseTo(0.6, 6);
  });

  it('there is no upper bound — a retaining wall can be a metre thick', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'W20', wall_custom_mm: 1000 }))).toBeCloseTo(1.0, 6);
  });

  it('zero or negative means "not set" — it never collapses the wall', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'W25', wall_custom_mm: 0 }))).toBeCloseTo(0.25, 6);
    expect(getNodeWallThickness(wall({ wall_type: 'W25', wall_custom_mm: -5 }))).toBeCloseTo(0.25, 6);
    expect(getNodeWallThickness(wall({ wall_type: 'W25', wall_custom_mm: 'gros' }))).toBeCloseTo(0.25, 6);
  });

  it('a separator stays a separator — a custom thickness cannot give it a body', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'separator', wall_custom_mm: 600 })))
      .toBeCloseTo(parseWallThickness('separator'), 6);
  });

  it('timber and CLT types keep resolving through the library', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'TF25' }))).toBeCloseTo(0.25, 6);
    expect(getNodeWallThickness(wall({ wall_type: 'CLT120' }))).toBeCloseTo(0.12, 6);
  });
});
