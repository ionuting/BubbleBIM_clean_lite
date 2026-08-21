import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  buildGableEnvelope,
  buildHipEnvelope,
  buildShedEnvelope,
  contourFromStoreyWalls,
  createRoofForStorey,
  solveRoof,
  applyRoofResult,
  type RoofContour,
  type RoofDiagnostic,
} from '@/lib/roof';

/** 10m × 8m rectangle storey with 4 corner ax + 4 walls. */
function rectBuilding(): { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[]; storeyId: string } {
  const storeyId = 'storey_1';
  const nodes: BubbleGraphNode[] = [
    {
      id: storeyId,
      type: 'storey',
      name: 'L1',
      x: 0, y: 0, z: 0,
      properties: { bottomElevation: 0, topElevation: 3000 },
    },
    { id: 'ax_sw', type: 'ax', name: 'SW', x: 0, y: 0, z: 0, parentId: storeyId, properties: {} },
    { id: 'ax_se', type: 'ax', name: 'SE', x: 10000, y: 0, z: 0, parentId: storeyId, properties: {} },
    { id: 'ax_ne', type: 'ax', name: 'NE', x: 10000, y: 8000, z: 0, parentId: storeyId, properties: {} },
    { id: 'ax_nw', type: 'ax', name: 'NW', x: 0, y: 8000, z: 0, parentId: storeyId, properties: {} },
    { id: 'w_s', type: 'wall', name: 'S', x: 5000, y: 0, z: 0, parentId: storeyId, properties: { wall_type: 'W20' } },
    { id: 'w_e', type: 'wall', name: 'E', x: 10000, y: 4000, z: 0, parentId: storeyId, properties: { wall_type: 'W20' } },
    { id: 'w_n', type: 'wall', name: 'N', x: 5000, y: 8000, z: 0, parentId: storeyId, properties: { wall_type: 'W20' } },
    { id: 'w_w', type: 'wall', name: 'W', x: 0, y: 4000, z: 0, parentId: storeyId, properties: { wall_type: 'W20' } },
  ];
  const edges: BubbleGraphEdge[] = [
    { id: 'e1', from: 'w_s', to: 'ax_sw' },
    { id: 'e2', from: 'w_s', to: 'ax_se' },
    { id: 'e3', from: 'w_e', to: 'ax_se' },
    { id: 'e4', from: 'w_e', to: 'ax_ne' },
    { id: 'e5', from: 'w_n', to: 'ax_ne' },
    { id: 'e6', from: 'w_n', to: 'ax_nw' },
    { id: 'e7', from: 'w_w', to: 'ax_nw' },
    { id: 'e8', from: 'w_w', to: 'ax_sw' },
  ];
  return { nodes, edges, storeyId };
}

describe('roof contour from storey walls', () => {
  it('extracts 4-corner exterior cycle for 10×8 m rectangle', () => {
    const { nodes, edges, storeyId } = rectBuilding();
    const c = contourFromStoreyWalls(storeyId, nodes, edges);
    expect(c).not.toBeNull();
    expect(c!.points.length).toBe(4);
    expect(c!.axIds.length).toBe(4);
    const xs = c!.points.map((p) => p.x).sort((a, b) => a - b);
    const ys = c!.points.map((p) => p.y).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0, 0);
    expect(xs[3]).toBeCloseTo(10000, 0);
    expect(ys[0]).toBeCloseTo(0, 0);
    expect(ys[3]).toBeCloseTo(8000, 0);
  });
});

describe('gable envelope 30° on 10×8 m', () => {
  it('places ridge along long axis with correct height', () => {
    const contour: RoofContour = {
      points: [
        { x: 0, y: 0 },
        { x: 10000, y: 0 },
        { x: 10000, y: 8000 },
        { x: 0, y: 8000 },
      ],
      axIds: [],
      baseZ: 3000,
      storeyId: 's',
    };
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildGableEnvelope(contour, 30, 'auto', 0, 'roof1', diags);
    expect(diags.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(skeleton.length).toBe(1);
    expect(faces.filter((f) => f.role === 'slope')).toHaveLength(2);
    // Both ridge ends get a vertical fronton (overhang 0 here → flush with the eave).
    expect(faces.filter((f) => f.role === 'gable_end')).toHaveLength(2);
    // Long axis is X → ridge along X at mid Y=4000
    expect(skeleton[0].a.y).toBeCloseTo(4000, 0);
    expect(skeleton[0].b.y).toBeCloseTo(4000, 0);
    // half span 4000 mm, pitch 30° → rise = 4000 * tan(30°)
    const rise = 4000 * Math.tan((30 * Math.PI) / 180);
    expect(skeleton[0].a.z).toBeCloseTo(3000 + rise, 0);
    expect(skeleton[0].a.x).toBeCloseTo(0, 0);
    expect(skeleton[0].b.x).toBeCloseTo(10000, 0);
  });
});

describe('shed envelope', () => {
  it('creates one face with elevated high edge', () => {
    const contour: RoofContour = {
      points: [
        { x: 0, y: 0 },
        { x: 6000, y: 0 },
        { x: 6000, y: 4000 },
        { x: 0, y: 4000 },
      ],
      axIds: [],
      baseZ: 3000,
      storeyId: 's',
    };
    const diags: RoofDiagnostic[] = [];
    const { faces, skeleton } = buildShedEnvelope(contour, 20, 'auto', 'r1', diags);
    expect(faces.length).toBe(1);
    expect(skeleton.some((s) => s.role === 'ridge')).toBe(true);
    const zs = faces[0].vertices.map((v) => v.z);
    expect(Math.max(...zs)).toBeGreaterThan(3000);
    expect(Math.min(...zs)).toBeCloseTo(3000, 0);
  });
});

describe('hip envelope 30° on 10×8 m', () => {
  it('creates ridge + 4 hips + 4 faces', () => {
    const contour: RoofContour = {
      points: [
        { x: 0, y: 0 },
        { x: 10000, y: 0 },
        { x: 10000, y: 8000 },
        { x: 0, y: 8000 },
      ],
      axIds: [],
      baseZ: 3000,
      storeyId: 's',
    };
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildHipEnvelope(contour, 30, 'auto', 0, 'roof1', diags);
    expect(diags.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(skeleton.filter((s) => s.role === 'ridge')).toHaveLength(1);
    expect(skeleton.filter((s) => s.role === 'hip')).toHaveLength(4);
    expect(faces).toHaveLength(4);
    // Ridge shorter than 10m by half-span (4m) each end → length 2m
    const ridge = skeleton.find((s) => s.role === 'ridge')!;
    expect(Math.abs(ridge.b.x - ridge.a.x)).toBeCloseTo(2000, 0);
    const rise = 4000 * Math.tan((30 * Math.PI) / 180);
    expect(ridge.a.z).toBeCloseTo(3000 + rise, 0);
  });
});

describe('createRoofForStorey + solveRoof', () => {
  it('creates complete roof with framing by default', () => {
    const { nodes, edges, storeyId } = rectBuilding();
    const out = createRoofForStorey(storeyId, nodes, edges, { roofType: 'gable', pitchDeg: 30 });
    expect(out.roofId).toBeTruthy();
    expect(out.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    const roof = out.nodes.find((n) => n.id === out.roofId);
    expect(roof?.type).toBe('roof');
    expect(roof?.properties.pitch_deg).toBe(30);
    const ridge = out.nodes.find((n) => n.type === 'roof_ridge' && n.properties.source_roof_id === out.roofId);
    expect(ridge).toBeTruthy();
    expect(out.nodes.filter((n) => n.type === 'rafter' && n.properties.source_roof_id === out.roofId).length).toBeGreaterThan(4);
    expect(out.nodes.some((n) => n.type === 'ridge_beam' && n.properties.source_roof_id === out.roofId)).toBe(true);
    expect(out.nodes.some((n) => n.type === 'wall_plate' && n.properties.source_roof_id === out.roofId)).toBe(true);
    expect(out.nodes.some((n) => n.type === 'post' && n.properties.source_roof_id === out.roofId)).toBe(true);
    expect(out.nodes.filter((n) => n.type === 'covering' && n.properties.source_roof_id === out.roofId).length).toBe(2);
    const roofAxEdges = out.edges.filter(
      (e) => e.from === out.roofId || e.to === out.roofId,
    );
    expect(roofAxEdges.length).toBeGreaterThanOrEqual(4);
  });

  it('hip framing creates hip rafters and 4 coverings', () => {
    const { nodes, edges, storeyId } = rectBuilding();
    const out = createRoofForStorey(storeyId, nodes, edges, {
      roofType: 'hip',
      pitchDeg: 30,
      generateLevel: 'framing',
    });
    expect(out.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    expect(out.nodes.filter((n) => n.type === 'hip_rafter').length).toBe(4);
    expect(out.nodes.filter((n) => n.type === 'roof_hip').length).toBe(4);
    expect(out.nodes.filter((n) => n.type === 'covering' && n.properties.source_roof_id === out.roofId).length).toBe(4);
    const roof = out.nodes.find((n) => n.id === out.roofId)!;
    expect(Number(roof.properties.face_count)).toBe(4);
  });

  it('regenerate framing replaces previous members', () => {
    const { nodes, edges, storeyId } = rectBuilding();
    const once = createRoofForStorey(storeyId, nodes, edges, { pitchDeg: 30 });
    const count1 = once.nodes.filter((n) => n.properties.source_roof_id === once.roofId).length;
    const result = solveRoof({ nodes: once.nodes, edges: once.edges, roofId: once.roofId, level: 'framing' });
    const twice = applyRoofResult(once.nodes, once.edges, result);
    const count2 = twice.nodes.filter((n) => n.properties.source_roof_id === once.roofId).length;
    expect(count2).toBe(count1);
    expect(twice.nodes.filter((n) => n.type === 'roof_ridge').length).toBe(1);
  });
});
