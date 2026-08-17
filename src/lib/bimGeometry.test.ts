import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { calcWallGeometry, MM } from './bimGeometry';

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
