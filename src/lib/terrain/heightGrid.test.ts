/**
 * The grid has closed-form answers for everything that matters: a flat
 * ground is zero, a pit of known size removes a known volume, a vertical
 * cut has no rim, an absolute floor lands where it says. Those are checked,
 * so the noise and the two-pass zone logic are free to change underneath.
 */
import { describe, expect, it } from 'vitest';
import {
  applyZones, baseHeights, earthworks, gridCount, insideGrid, modelHeights, sampleHeight,
} from './heightGrid';
import { DEFAULT_TERRAIN_MODEL, normaliseTerrainModel, type ExcavationZone, type TerrainModel } from './types';

const flat: TerrainModel = { ...DEFAULT_TERRAIN_MODEL, sizeM: 40, subdivisions: 40, flat: true };
const square = (cx: number, cz: number, half: number): [number, number][] => [
  [cx - half, cz - half], [cx + half, cz - half], [cx + half, cz + half], [cx - half, cz + half],
];

describe('baseHeights', () => {
  it('is a plane at zero when flat', () => {
    const h = baseHeights(flat);
    expect(h).toHaveLength(gridCount(flat) ** 2);
    expect(Math.max(...h)).toBe(0);
    expect(Math.min(...h)).toBe(0);
  });

  it('is relief within the amplitude when not flat, and deterministic per seed', () => {
    const m = { ...flat, flat: false, maxHeightM: 5, seed: 7 };
    const h = baseHeights(m);
    expect(Math.max(...h)).toBeGreaterThan(1);
    expect(Math.max(...h)).toBeLessThanOrEqual(5);
    expect(Math.min(...h)).toBeGreaterThanOrEqual(0);
    expect(Array.from(baseHeights(m))).toEqual(Array.from(h));
    expect(Array.from(baseHeights({ ...m, seed: 8 }))).not.toEqual(Array.from(h));
  });
});

describe('applyZones', () => {
  it('does not touch the input', () => {
    const base = baseHeights(flat);
    applyZones(base, flat, [{ id: 'p', polygon: square(0, 0, 5), depth: 2, slope: 0, type: 'pit' }]);
    expect(Math.min(...base)).toBe(0);
  });

  it('a vertical pit removes exactly its footprint times its depth', () => {
    const base = baseHeights(flat);
    const out = applyZones(base, flat, [{ id: 'p', polygon: square(0, 0, 5), depth: 2, slope: 0, type: 'pit' }]);
    const { cutM3, fillM3 } = earthworks(base, out, flat);
    // 10 × 10 × 2 = 200 m³, give or take the cells straddling the edge.
    expect(cutM3 / 200).toBeCloseTo(1, 1);
    expect(fillM3).toBe(0);
    expect(sampleHeight(out, flat, 0, 0)).toBeCloseTo(-2, 6);
    expect(sampleHeight(out, flat, 15, 15)).toBe(0);
  });

  it('a sloped rim blends from the ground down to the floor', () => {
    const base = baseHeights(flat);
    const out = applyZones(base, flat, [{ id: 'p', polygon: square(0, 0, 8), depth: 2, slope: 45, type: 'pit' }]);
    // Rim width = depth / tan 45° = 2 m: inside that, partway down.
    const rim = sampleHeight(out, flat, 7, 0);
    expect(rim).toBeLessThan(0);
    expect(rim).toBeGreaterThan(-2);
    expect(sampleHeight(out, flat, 0, 0)).toBeCloseTo(-2, 6);
  });

  it('an embankment raises by the depth, and is NOT idempotent', () => {
    const base = baseHeights(flat);
    const z: ExcavationZone = { id: 'e', polygon: square(0, 0, 5), depth: 1.5, slope: 0, type: 'embankment' };
    const once = applyZones(base, flat, [z]);
    expect(sampleHeight(once, flat, 0, 0)).toBeCloseTo(1.5, 6);
    const twice = applyZones(once, flat, [z]);
    expect(sampleHeight(twice, flat, 0, 0)).toBeCloseTo(3, 6);
    expect(earthworks(base, once, flat).fillM3 / 150).toBeCloseTo(1, 1);
  });

  it('an absolute floor lands where it says, whatever the ground does', () => {
    const hilly = { ...flat, flat: false, maxHeightM: 4, seed: 3 };
    const base = baseHeights(hilly);
    const out = applyZones(base, hilly, [{ id: 'p', polygon: square(0, 0, 5), depth: 0, slope: 0, type: 'pit', floorM: -1.25 }]);
    expect(sampleHeight(out, hilly, 0, 0)).toBeCloseTo(-1.25, 6);
    expect(sampleHeight(out, hilly, 3, -3)).toBeCloseTo(-1.25, 6);
  });

  it('cutting to an absolute floor twice is the same as once', () => {
    const base = baseHeights(flat);
    const z: ExcavationZone = { id: 'p', polygon: square(0, 0, 5), depth: 0, slope: 30, type: 'pit', floorM: -2 };
    const once = applyZones(base, flat, [z]);
    const twice = applyZones(once, flat, [z]);
    expect(Array.from(twice)).toEqual(Array.from(once));
  });

  it('a zone with fewer than three points is ignored', () => {
    const base = baseHeights(flat);
    const out = applyZones(base, flat, [{ id: 'p', polygon: [[0, 0], [1, 1]], depth: 2, slope: 0, type: 'pit' }]);
    expect(Math.min(...out)).toBe(0);
  });
});

describe('modelHeights', () => {
  it('uses baked heights when they fit the grid, and ignores the zones then', () => {
    const count = gridCount(flat);
    const baked = new Array(count * count).fill(3);
    const m: TerrainModel = {
      ...flat, bakedHeights: baked,
      excavations: [{ id: 'p', polygon: square(0, 0, 5), depth: 2, slope: 0, type: 'pit' }],
    };
    expect(sampleHeight(modelHeights(m), flat, 0, 0)).toBe(3);
  });

  it('falls back to building when the baked array is the wrong size', () => {
    const m: TerrainModel = { ...flat, bakedHeights: [1, 2, 3] };
    expect(sampleHeight(modelHeights(m), flat, 0, 0)).toBe(0);
  });
});

describe('sampleHeight', () => {
  it('interpolates between vertices', () => {
    const count = gridCount(flat);
    const h = new Float32Array(count * count);
    // A ramp: height = column index.
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) h[r * count + c] = c;
    // Column 20 is x = 0; x = 0.5 m is column 20.5.
    expect(sampleHeight(h, flat, 0.5, 0)).toBeCloseTo(20.5, 6);
  });

  it('clamps to the edge outside the grid', () => {
    const count = gridCount(flat);
    const h = new Float32Array(count * count).fill(2);
    expect(sampleHeight(h, flat, 1000, 1000)).toBe(2);
  });
});

describe('insideGrid', () => {
  it('is the square the grid covers', () => {
    expect(insideGrid(flat, 0, 0)).toBe(true);
    expect(insideGrid(flat, 20, 20)).toBe(true);
    expect(insideGrid(flat, 20.1, 0)).toBe(false);
  });
});

describe('normaliseTerrainModel', () => {
  it('defaults an empty model to flat ground', () => {
    expect(normaliseTerrainModel(null).flat).toBe(true);
    expect(normaliseTerrainModel(undefined).excavations).toEqual([]);
  });

  it('keeps an old procedural model procedural', () => {
    expect(normaliseTerrainModel({ sizeM: 100, subdivisions: 128, seed: 1 }).flat).toBe(false);
  });

  it('drops an empty baked array and keeps a real one', () => {
    expect(normaliseTerrainModel({ bakedHeights: [] }).bakedHeights).toBeUndefined();
    expect(normaliseTerrainModel({ bakedHeights: [1, 2] }).bakedHeights).toEqual([1, 2]);
  });
});
