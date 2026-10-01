import { describe, expect, it } from 'vitest';
import {
  ERROR_DIVISOR, MAX_GRID_M, MIN_GRID_M,
  geometricErrorFor, overallBounds, splitIntoTiles, suggestGridSize,
  type TileItem, type Vec3,
} from './spatialSplit';

let nextLocalId = 1;

/** An item with the given bounds; identity fields are filled in for us because
 *  the split never looks at them. */
function item(min: Vec3, max: Vec3, over: Partial<TileItem> = {}): TileItem {
  const localId = nextLocalId++;
  return {
    id: `ifc:m:${localId}`,
    localId,
    guid: `guid-${localId}`,
    category: 'IFCWALL',
    colour: '#bfbfbf',
    min, max,
    ...over,
  };
}

/** A 1 m cube centred on (x, 0, z) — the simplest thing that lands in one cell. */
function cubeAt(x: number, z: number): TileItem {
  return item([x - 0.5, 0, z - 0.5], [x + 0.5, 1, z + 0.5]);
}

describe('overallBounds', () => {
  it('has nothing to say about an empty list', () => {
    expect(overallBounds([])).toBeNull();
  });

  it('gives a single item its own bounds back', () => {
    const it0 = item([1, 2, 3], [4, 5, 6]);
    expect(overallBounds([it0])).toEqual({ min: [1, 2, 3], max: [4, 5, 6] });
  });

  it('unions every axis, including the vertical one the split ignores', () => {
    const bounds = overallBounds([
      item([0, 0, 0], [1, 3, 1]),
      item([-5, 10, 2], [-4, 12, 8]),
    ]);
    expect(bounds).toEqual({ min: [-5, 0, 0], max: [1, 12, 8] });
  });
});

describe('splitIntoTiles', () => {
  it('returns nothing for no items rather than one empty tile', () => {
    expect(splitIntoTiles([], 10)).toEqual([]);
  });

  it('puts an item in the cell its bbox CENTRE falls in', () => {
    // Centres at x = 3, 13, 25 and z = 3, 3, 17 with a 10 m grid.
    const buckets = splitIntoTiles([cubeAt(3, 3), cubeAt(13, 3), cubeAt(25, 17)], 10);
    expect(buckets.map((b) => b.key)).toEqual(['0_0', '1_0', '2_1']);
    expect(buckets.map((b) => [b.col, b.row])).toEqual([[0, 0], [1, 0], [2, 1]]);
  });

  it('indexes negative coordinates downwards, so the grid is continuous across the origin', () => {
    const buckets = splitIntoTiles([cubeAt(-3, -3), cubeAt(3, 3)], 10);
    expect(buckets.map((b) => b.key)).toEqual(['-1_-1', '0_0']);
  });

  it('sends an item sitting exactly on a cell boundary to exactly one cell', () => {
    // Centre at exactly (10, 10) with a 10 m grid: the boundary belongs to the
    // upper cell, and the item appears once, not twice and not never.
    const buckets = splitIntoTiles([cubeAt(10, 10)], 10);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe('1_1');
    expect(buckets[0].items).toHaveLength(1);
  });

  it('keeps every item exactly once, whatever the grid', () => {
    const items = [cubeAt(0, 0), cubeAt(10, 0), cubeAt(20, 20), cubeAt(-30, 5), cubeAt(10, 0.001)];
    for (const grid of [1, 7, 10, 100]) {
      const placed = splitIntoTiles(items, grid).flatMap((b) => b.items.map((i) => i.localId));
      expect([...placed].sort()).toEqual(items.map((i) => i.localId).sort());
    }
  });

  it('collapses everything into one bucket when the grid is bigger than the model', () => {
    const items = [cubeAt(5, 5), cubeAt(40, 40), cubeAt(20, 10)];
    const buckets = splitIntoTiles(items, 1000);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].items).toHaveLength(3);
  });

  it('bounds a bucket by the UNION of its items, not by the cell — overhanging geometry must not be clipped', () => {
    // A 12 m beam whose centre is just inside cell 0 pokes well past x = 10.
    const beam = item([-1, 0, 4], [11, 0.4, 4.4]);
    const buckets = splitIntoTiles([beam, cubeAt(2, 2)], 10);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].min).toEqual([-1, 0, 1.5]);
    expect(buckets[0].max).toEqual([11, 1, 4.4]);
  });

  it('orders buckets by column then row, so two runs give the same file', () => {
    const items = [cubeAt(25, 5), cubeAt(5, 25), cubeAt(5, 5), cubeAt(25, 25), cubeAt(15, 15)];
    const once = splitIntoTiles(items, 10);
    const again = splitIntoTiles([...items].reverse(), 10);
    expect(once.map((b) => b.key)).toEqual(['0_0', '0_2', '1_1', '2_0', '2_2']);
    expect(again.map((b) => b.key)).toEqual(once.map((b) => b.key));
  });

  it('does not split vertically: a stack of storeys is one tile', () => {
    const storeys = [0, 3, 6, 9].map((y) => item([0, y, 0], [8, y + 3, 8]));
    const buckets = splitIntoTiles(storeys, 10);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].min[1]).toBe(0);
    expect(buckets[0].max[1]).toBe(12);
  });

  it('falls back to a sane grid rather than one nonsense bucket when given a useless size', () => {
    const items = [cubeAt(0, 0), cubeAt(100, 100)];
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const buckets = splitIntoTiles(items, bad);
      expect(buckets.length).toBeGreaterThan(1);
      expect(buckets.every((b) => Number.isFinite(b.col) && Number.isFinite(b.row))).toBe(true);
    }
  });
});

describe('geometricErrorFor', () => {
  it('is the tile diagonal over the divisor', () => {
    const bucket = splitIntoTiles([item([0, 0, 0], [3, 4, 12])], 100)[0];
    expect(geometricErrorFor(bucket)).toBeCloseTo(13 / ERROR_DIVISOR, 9);
  });

  it('is zero for a tile with no extent, because there is nothing to miss', () => {
    const bucket = splitIntoTiles([item([2, 2, 2], [2, 2, 2])], 100)[0];
    expect(geometricErrorFor(bucket)).toBe(0);
  });

  it('grows with the tile, which is what makes a big tile load from further away', () => {
    const small = splitIntoTiles([item([0, 0, 0], [1, 1, 1])], 1000)[0];
    const large = splitIntoTiles([item([0, 0, 0], [50, 20, 50])], 1000)[0];
    expect(geometricErrorFor(large)).toBeGreaterThan(geometricErrorFor(small));
  });
});

describe('suggestGridSize', () => {
  it('lands near the requested tile count for an evenly filled footprint', () => {
    // A 200 × 200 m site of 1 m cubes on a 10 m lattice: 400 items, well spread.
    const items: TileItem[] = [];
    for (let x = 5; x < 200; x += 10) for (let z = 5; z < 200; z += 10) items.push(cubeAt(x, z));
    const grid = suggestGridSize(items, 16);
    const count = splitIntoTiles(items, grid).length;
    expect(count).toBeGreaterThanOrEqual(9);
    expect(count).toBeLessThanOrEqual(30);
  });

  it('never returns zero, a negative or a NaN, whatever it is handed', () => {
    const inputs: Array<[TileItem[], number]> = [
      [[], 50],
      [[cubeAt(0, 0)], 50],
      // A footprint with no depth at all: the area estimate divides by zero
      // unless the fallback to the longer side kicks in.
      [[item([0, 0, 0], [50, 3, 0]), item([60, 0, 0], [100, 3, 0])], 10],
      [[cubeAt(0, 0), cubeAt(50, 50)], 0],
      [[cubeAt(0, 0), cubeAt(50, 50)], -3],
      [[cubeAt(0, 0), cubeAt(50, 50)], Number.NaN],
      [[item([0, 0, 0], [0, 0, 0])], 100],
    ];
    for (const [items, target] of inputs) {
      const grid = suggestGridSize(items, target);
      expect(Number.isFinite(grid)).toBe(true);
      expect(grid).toBeGreaterThan(0);
    }
  });

  it('clamps a tiny site up and a huge one down', () => {
    const tiny = [cubeAt(0, 0), cubeAt(2, 2)];
    expect(suggestGridSize(tiny, 100)).toBe(MIN_GRID_M);

    const huge = [item([0, 0, 0], [100000, 10, 100000])];
    expect(suggestGridSize(huge, 1)).toBe(MAX_GRID_M);
  });

  it('is deterministic — the same items give the same size', () => {
    const items = [cubeAt(0, 0), cubeAt(120, 40), cubeAt(60, 90)];
    expect(suggestGridSize(items, 12)).toBe(suggestGridSize(items, 12));
  });
});
