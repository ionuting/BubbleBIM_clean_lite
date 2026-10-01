/**
 * The site is a frame and a datum. What has to hold: the ground at the
 * anchor meets the storey floor; the frame round-trips; a footing digs a pit
 * of the right depth at the right place only when asked; and the cache is
 * invalidated by the things that change the answer — including the terrain
 * model itself, which is a different object every time it is edited.
 */
import { describe, expect, it } from 'vitest';
import { computeSite, bimToTerrain, terrainToBim, terrainZToBim, siteVerticesBim } from './site';
import { DEFAULT_TERRAIN_MODEL, type TerrainModel } from './types';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';

const storey: BubbleGraphNode = {
  id: 'st1', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 300, topElevation: 3300 },
};
const ax = (id: string, x: number, y: number): BubbleGraphNode =>
  ({ id, type: 'ax', name: id, x, y, z: 0, parentId: 'st1', properties: { bimX: x, bimY: y } });

function graph(opts: {
  siteProps?: Record<string, unknown>;
  anchor?: BubbleGraphNode | null;
  foundations?: BubbleGraphNode[];
}) {
  const anchor = opts.anchor === undefined ? ax('axS', 5000, 2000) : opts.anchor;
  const site: BubbleGraphNode = {
    id: 'site1', type: 'site', name: 'Teren', x: 0, y: 0, z: 0, parentId: 'st1',
    properties: { ...(opts.siteProps ?? {}) },
  };
  const nodes = [storey, site, ...(anchor ? [anchor] : []), ...(opts.foundations ?? [])];
  const edges: BubbleGraphEdge[] = anchor ? [{ id: 'e1', from: site.id, to: anchor.id }] : [];
  return { site, nodeMap: new Map(nodes.map((n) => [n.id, n])), edges };
}

const flat: TerrainModel = { ...DEFAULT_TERRAIN_MODEL, sizeM: 60, subdivisions: 60, flat: true };

describe('the frame', () => {
  it('puts the terrain origin on the anchor and the ground on the storey floor', () => {
    const g = graph({});
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.frame!.originX).toBe(5000);
    expect(r.frame!.originY).toBe(2000);
    expect(r.frame!.datumMm).toBe(300);
    expect(r.heightAtBim(5000, 2000)).toBeCloseTo(300, 6);
  });

  it('round-trips BIM ↔ terrain, with rotation', () => {
    const g = graph({ siteProps: { rotation_deg: 30 } });
    const f = computeSite(g.site, g.nodeMap, g.edges, flat).frame!;
    const t = bimToTerrain(f, 9000, -1000);
    const back = terrainToBim(f, t.x, t.z);
    expect(back.x).toBeCloseTo(9000, 6);
    expect(back.y).toBeCloseTo(-1000, 6);
    // 1 m east in terrain at 30° is (cos30, sin30) m in BIM.
    const p = terrainToBim(f, 1, 0);
    expect(p.x - 5000).toBeCloseTo(866.03, 1);
    expect(p.y - 2000).toBeCloseTo(500, 1);
  });

  it('honours the vertical offset', () => {
    const g = graph({ siteProps: { offset_z_mm: -450 } });
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.heightAtBim(5000, 2000)).toBeCloseTo(-150, 6);
  });

  it('is null outside the grid', () => {
    const g = graph({});
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.heightAtBim(5000 + 31000, 2000)).toBeNull();
    expect(r.heightAtBim(5000 + 29000, 2000)).not.toBeNull();
    expect(r.boundsMm!.minX).toBeCloseTo(5000 - 30000, 6);
  });

  it('the datum follows the storey the site belongs to', () => {
    const g = graph({});
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(terrainZToBim(r.frame!, 0)).toBe(300);
  });
});

describe('relief', () => {
  it('pins the anchor to the datum even when the ground there is not zero', () => {
    const hilly: TerrainModel = { ...flat, flat: false, maxHeightM: 5, seed: 11 };
    const g = graph({});
    const r = computeSite(g.site, g.nodeMap, g.edges, hilly);
    expect(r.frame!.h0M).not.toBe(0);
    expect(r.heightAtBim(5000, 2000)).toBeCloseTo(300, 3);
    expect(r.zMaxMm - r.zMinMm).toBeGreaterThan(1000);
  });
});

describe('foundation pits', () => {
  const footing: BubbleGraphNode = {
    id: 'f1', type: 'foundation', name: 'F1', x: 8000, y: 2000, z: 0, parentId: 'st1',
    properties: { foundation_type: 'F100x100x60' },
  };

  it('do nothing unless asked', () => {
    const g = graph({ foundations: [footing] });
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.foundationPits).toEqual([]);
    expect(r.foundationCutM3).toBe(0);
    expect(r.heightAtBim(8000, 2000)).toBeCloseTo(300, 6);
  });

  it('dig to the footing\'s underside plus bedding, footprint plus working space', () => {
    const g = graph({
      foundations: [footing],
      siteProps: { excavate_foundations: 'True', working_space_mm: 500, bedding_mm: 100, pit_slope_deg: 0 },
    });
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.foundationPits).toHaveLength(1);
    // Storey bottom 300, block 600 tall → underside −300, bedding → −400.
    expect(r.heightAtBim(8000, 2000)).toBeCloseTo(-400, 0);
    // 1000 + 2·500 = 2000 wide: inside at ±900. The grid is 1 m, so the
    // edge is smeared over one cell — ground again one full cell out.
    expect(r.heightAtBim(8900, 2000)).toBeCloseTo(-400, 0);
    expect(r.heightAtBim(10000, 2000)).toBeCloseTo(300, 0);
    // 2 × 2 × 0.7 = 2.8 m³, within the grid's cell resolution.
    expect(r.foundationCutM3).toBeGreaterThan(2);
    expect(r.foundationCutM3).toBeLessThan(4);
  });

  it('say so when asked to dig but no footing is on the grid', () => {
    const far = { ...footing, x: 90000, y: 90000 };
    const g = graph({ foundations: [far], siteProps: { excavate_foundations: 'True' } });
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.diagnostics.map((d) => d.code)).toContain('SITE_NO_FOUNDATIONS');
  });

  it('a moved footing moves its pit — the cache sees foundations', () => {
    const g = graph({ foundations: [footing], siteProps: { excavate_foundations: 'True', pit_slope_deg: 0 } });
    const before = computeSite(g.site, g.nodeMap, g.edges, flat);
    const moved = new Map(g.nodeMap);
    moved.set('f1', { ...footing, x: 12000 });
    const after = computeSite(g.site, moved, g.edges, flat);
    expect(after).not.toBe(before);
    expect(before.heightAtBim(8000, 2000)).toBeLessThan(0);
    expect(after.heightAtBim(8000, 2000)).toBeCloseTo(300, 0);
    expect(after.heightAtBim(12000, 2000)).toBeLessThan(0);
  });
});

describe('failures and the cache', () => {
  it('an unanchored site is an error and places nothing', () => {
    const g = graph({ anchor: null });
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.frame).toBeNull();
    expect(r.diagnostics.map((d) => d.code)).toContain('SITE_NO_ANCHOR');
    expect(r.heightAtBim(0, 0)).toBeNull();
  });

  it('is memoised per model object, and a new model is a new answer', () => {
    const g = graph({});
    const a = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(computeSite(g.site, g.nodeMap, g.edges, flat)).toBe(a);
    const edited: TerrainModel = { ...flat, excavations: [
      { id: 'p', polygon: [[-2, -2], [2, -2], [2, 2], [-2, 2]], depth: 1, slope: 0, type: 'pit' },
    ] };
    const b = computeSite(g.site, g.nodeMap, g.edges, edited);
    expect(b).not.toBe(a);
    // The pit is at the terrain origin = the anchor, one metre down.
    expect(b.heightAtBim(5000, 2000)).toBeCloseTo(300 - 1000, 0);
    // …and the anchor still reads as the datum's ground: h0 moved with it.
    expect(b.zoneCutM3).toBeGreaterThan(10);
  });

  it('exposes the grid as BIM vertices for the mesh and the section', () => {
    const g = graph({});
    const v = siteVerticesBim(computeSite(g.site, g.nodeMap, g.edges, flat))!;
    expect(v.count).toBe(61);
    // The centre vertex is the anchor at the datum.
    const mid = (30 * 61 + 30) * 3;
    expect(v.xyz[mid]).toBeCloseTo(5000, 6);
    expect(v.xyz[mid + 1]).toBeCloseTo(2000, 6);
    expect(v.xyz[mid + 2]).toBeCloseTo(300, 6);
  });
});
