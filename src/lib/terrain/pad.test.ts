/**
 * What has to hold for a terrain platform.
 *
 * The questions with exact answers: a vertical pad puts the ground AT its
 * level and nowhere else; `cut` never raises and `fill` never lowers; a
 * sloped transition reaches the level only after the batter has run its
 * course; applying a pad twice is the same as applying it once (so a pad can
 * sit over hand-modelled ground); and the level is one number — change it and
 * the earth follows.
 */
import { describe, expect, it } from 'vitest';
import { computeSite } from './site';
import { applyZones, gridCount } from './heightGrid';
import { parsePadIntent, slopeRatio } from './pad';
import { DEFAULT_TERRAIN_MODEL, type ExcavationZone, type TerrainModel } from './types';
import { serialiseOutline } from '@/lib/sketch';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';

const storey: BubbleGraphNode = {
  id: 'st1', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 300, topElevation: 3300 },
};
const anchor: BubbleGraphNode = {
  id: 'axS', type: 'ax', name: 'axS', x: 0, y: 0, z: 0, parentId: 'st1', properties: { bimX: 0, bimY: 0 },
};
const flat: TerrainModel = { ...DEFAULT_TERRAIN_MODEL, sizeM: 60, subdivisions: 60, flat: true };

/** A site plus one pad, whose outline is a rectangle drawn as a sketch. */
function withPad(padProps: Record<string, unknown>, rect = [[-4000, -4000], [4000, -4000], [4000, 4000], [-4000, 4000]]) {
  const sketch: BubbleGraphNode = {
    id: 'sk', type: 'sketch', name: 'Dreptunghi1', x: 0, y: 0, z: 0, parentId: 'st1',
    properties: { shape: 'poly', closed: 'True', op: 'none', outline: serialiseOutline(rect.map(([x, y]) => ({ x, y }))) },
  };
  const pad: BubbleGraphNode = {
    id: 'pad1', type: 'terrain_pad', name: 'Platformă1', x: 0, y: 0, z: 0, parentId: 'st1', properties: { ...padProps },
  };
  const site: BubbleGraphNode = {
    id: 'site1', type: 'site', name: 'Teren', x: 0, y: 0, z: 0, parentId: 'st1', properties: {},
  };
  const nodes = [storey, anchor, site, sketch, pad];
  const edges: BubbleGraphEdge[] = [
    { id: 'e1', from: site.id, to: anchor.id },
    { id: 'e2', from: pad.id, to: sketch.id },
  ];
  return { site, pad, nodeMap: new Map(nodes.map((n) => [n.id, n])), edges };
}

describe('a vertical pad', () => {
  it('puts the ground at its level, and leaves the rest alone', () => {
    // level_mm is an offset from the storey base (300) → 300 − 1500 = −1200.
    const g = withPad({ level_mm: -1500, transition: 'vertical', mode: 'both' });
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.pads).toHaveLength(1);
    expect(r.pads[0].levelMm).toBe(-1200);
    expect(r.heightAtBim(0, 0)).toBeCloseTo(-1200, 0);
    // Well outside the rectangle the ground is still the datum.
    expect(r.heightAtBim(12000, 0)).toBeCloseTo(300, 0);
  });

  it('an absolute level ignores the storey', () => {
    const g = withPad({ level_mm: -800, level_mode: 'absolute', transition: 'vertical', mode: 'both' });
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.pads[0].levelMm).toBe(-800);
    expect(r.heightAtBim(0, 0)).toBeCloseTo(-800, 0);
  });

  it('is one number: change it and the ground follows', () => {
    const a = withPad({ level_mm: -1000, transition: 'vertical', mode: 'both' });
    const b = withPad({ level_mm: -2000, transition: 'vertical', mode: 'both' });
    expect(computeSite(a.site, a.nodeMap, a.edges, flat).heightAtBim(0, 0)).toBeCloseTo(-700, 0);
    expect(computeSite(b.site, b.nodeMap, b.edges, flat).heightAtBim(0, 0)).toBeCloseTo(-1700, 0);
  });
});

describe('cut, fill, both', () => {
  // Flat ground sits at the datum, 300 mm. A pad ABOVE it can only be
  // reached by filling; a pad BELOW it only by cutting.
  it('cut never raises', () => {
    const up = withPad({ level_mm: 2000, transition: 'vertical', mode: 'cut' });
    expect(computeSite(up.site, up.nodeMap, up.edges, flat).heightAtBim(0, 0)).toBeCloseTo(300, 0);
    const down = withPad({ level_mm: -2000, transition: 'vertical', mode: 'cut' });
    expect(computeSite(down.site, down.nodeMap, down.edges, flat).heightAtBim(0, 0)).toBeCloseTo(-1700, 0);
  });

  it('fill never lowers', () => {
    const down = withPad({ level_mm: -2000, transition: 'vertical', mode: 'fill' });
    expect(computeSite(down.site, down.nodeMap, down.edges, flat).heightAtBim(0, 0)).toBeCloseTo(300, 0);
    const up = withPad({ level_mm: 2000, transition: 'vertical', mode: 'fill' });
    expect(computeSite(up.site, up.nodeMap, up.edges, flat).heightAtBim(0, 0)).toBeCloseTo(2300, 0);
  });

  it('both reaches the level from either side, and bills the earthworks', () => {
    const up = withPad({ level_mm: 1000, transition: 'vertical', mode: 'both' });
    const r = computeSite(up.site, up.nodeMap, up.edges, flat);
    expect(r.heightAtBim(0, 0)).toBeCloseTo(1300, 0);
    // An 8 × 8 m platform raised by 1 m is 64 m³ exactly. The 1 m grid can
    // only move whole vertices, and the ones ON the boundary count as inside,
    // so the raised patch is one vertex wider each way: 9 × 9 = 81 m³ is the
    // ceiling. Anything in that band is the grid drawing a 64 m³ platform.
    expect(r.padFillM3).toBeGreaterThanOrEqual(64 - 1e-6);
    expect(r.padFillM3).toBeLessThanOrEqual(81 + 1e-6);
    expect(r.padCutM3).toBe(0);
  });
});

describe('the transition', () => {
  it('a slope batters from the edge and only then reaches the level', () => {
    // 45° over an 8 m square, 2 m down: the middle gets there, the rim does not.
    const g = withPad({ level_mm: -2000, transition: 'slope', slope_deg: 45, mode: 'both' });
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.heightAtBim(0, 0)).toBeCloseTo(-1700, 0);
    // 1 m in from the edge, a 45° batter has dropped about 1 m.
    const rim = r.heightAtBim(3000, 0)!;
    expect(rim).toBeGreaterThan(-1700);
    expect(rim).toBeLessThan(300);
  });

  it('vertical is the same as a batter that never runs', () => {
    const v = withPad({ level_mm: -1000, transition: 'vertical', mode: 'both' });
    const r = computeSite(v.site, v.nodeMap, v.edges, flat);
    // Every vertex inside is exactly at the level — no ramp at all.
    expect(r.heightAtBim(3500, 3500)).toBeCloseTo(-700, 0);
  });

  it('states the batter the way builders do', () => {
    expect(slopeRatio(45)).toBeCloseTo(1, 6);
    expect(slopeRatio(30)).toBeCloseTo(1.732, 3);
  });
});

describe('robustness', () => {
  it('a vertical pad applied twice is the same as applied once', () => {
    // This is the guarantee that lets a graph pad sit over ground the
    // modeller shaped by hand: it is a FIXED level, not a relative move.
    const zone: ExcavationZone = {
      id: 'z', polygon: [[-4, -4], [4, -4], [4, 4], [-4, 4]],
      depth: 0, slope: 0, type: 'pit', floorM: -2, mode: 'both',
    };
    const n = gridCount(flat);
    const base = new Float32Array(n * n);
    const once = applyZones(base, flat, [zone]);
    const twice = applyZones(once, flat, [zone]);
    expect(Array.from(twice)).toEqual(Array.from(once));
  });

  it('a BATTERED pad settles instead of digging further each time', () => {
    // A rim slope meets the ground where it finds it, so re-applying can
    // still move the rim — but never past the floor, and by less each pass.
    const zone: ExcavationZone = {
      id: 'z', polygon: [[-4, -4], [4, -4], [4, 4], [-4, 4]],
      depth: 0, slope: 30, type: 'pit', floorM: -2, mode: 'both',
    };
    const n = gridCount(flat);
    const base = new Float32Array(n * n);
    const once = applyZones(base, flat, [zone]);
    const twice = applyZones(once, flat, [zone]);
    const thrice = applyZones(twice, flat, [zone]);
    const drift = (a: Float32Array, b: Float32Array) =>
      a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
    expect(Math.min(...once)).toBeGreaterThanOrEqual(-2 - 1e-6);
    expect(Math.min(...twice)).toBeGreaterThanOrEqual(-2 - 1e-6);
    expect(drift(thrice, twice)).toBeLessThanOrEqual(drift(twice, once) + 1e-6);
  });

  it('an unwired pad is an error and changes nothing', () => {
    const g = withPad({ level_mm: -1000 });
    g.edges.splice(1, 1); // drop the pad → sketch edge
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.diagnostics.map((d) => d.code)).toContain('PAD_NO_OUTLINE');
    expect(r.pads).toEqual([]);
    expect(r.heightAtBim(0, 0)).toBeCloseTo(300, 0);
  });

  it('a pad off the grid warns instead of silently doing nothing', () => {
    const far = [[90000, 90000], [95000, 90000], [95000, 95000], [90000, 95000]];
    const g = withPad({ level_mm: -1000 }, far);
    const r = computeSite(g.site, g.nodeMap, g.edges, flat);
    expect(r.diagnostics.map((d) => d.code)).toContain('PAD_OFF_GRID');
  });

  it('defaults read as a platform, not a hole', () => {
    const i = parsePadIntent({ id: 'x', type: 'terrain_pad', name: 'x', x: 0, y: 0, z: 0, properties: {} });
    expect(i.mode).toBe('both');
    expect(i.transition).toBe('vertical');
    expect(i.levelMode).toBe('storey');
  });

  it('pads shape the ground BEFORE the footings dig into it', () => {
    const footing: BubbleGraphNode = {
      id: 'f1', type: 'foundation', name: 'F1', x: 0, y: 0, z: 0, parentId: 'st1',
      properties: { foundation_type: 'F100x100x60' },
    };
    // A shallow terrace at +100; the footing's underside is well below it, so
    // the pit must cut into the PADDED ground, not the original.
    const g = withPad({ level_mm: -200, transition: 'vertical', mode: 'both' });
    g.nodeMap.set(footing.id, footing);
    const site = { ...g.site, properties: { excavate_foundations: 'True', pit_slope_deg: 0 } };
    const r = computeSite(site, g.nodeMap, g.edges, flat);
    expect(r.pads).toHaveLength(1);
    // Storey base 300, block 600 tall → underside −300, bedding 100 → −400.
    expect(r.heightAtBim(0, 0)!).toBeCloseTo(-400, 0);
    // Just outside the footing but inside the terrace: the pad's level.
    expect(r.heightAtBim(3000, 3000)!).toBeCloseTo(100, 0);
    expect(r.foundationCutM3).toBeGreaterThan(0);
  });

  it('a pad that sits ABOVE a footing pit does not fill it back in', () => {
    // Cut is `min`: the deeper of the two wins, whichever ran first.
    const footing: BubbleGraphNode = {
      id: 'f1', type: 'foundation', name: 'F1', x: 0, y: 0, z: 0, parentId: 'st1',
      properties: { foundation_type: 'F100x100x60' },
    };
    const g = withPad({ level_mm: -1000, transition: 'vertical', mode: 'both' });
    g.nodeMap.set(footing.id, footing);
    const site = { ...g.site, properties: { excavate_foundations: 'True', pit_slope_deg: 0 } };
    const r = computeSite(site, g.nodeMap, g.edges, flat);
    // Pad floor −700 is below the pit floor −400, so −700 stands.
    expect(r.heightAtBim(0, 0)!).toBeCloseTo(-700, 0);
  });
});
