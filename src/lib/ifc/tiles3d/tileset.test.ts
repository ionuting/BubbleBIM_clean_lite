import { describe, expect, it } from 'vitest';
import { boxVolume, buildTileset, threeBoxToLocal, type TilesetOptions } from './tileset';
import { geometricErrorFor, type TileBucket, type TileItem, type Vec3 } from './spatialSplit';

const OPTS: TilesetOptions = { gridSizeM: 20, contentUri: (key) => `tiles/${key}.glb` };

let nextLocalId = 1;

function bucket(key: string, col: number, row: number, min: Vec3, max: Vec3): TileBucket {
  const localId = nextLocalId++;
  const item: TileItem = {
    id: `ifc:m:${localId}`, localId, guid: null, category: 'IFCWALL', colour: '#bfbfbf', min, max,
  };
  return { key, col, row, items: [item], min, max };
}

describe('boxVolume', () => {
  it('writes the centre followed by three half-axis vectors', () => {
    expect(boxVolume([0, 0, 0], [2, 4, 6])).toEqual([
      1, 2, 3,
      1, 0, 0,
      0, 2, 0,
      0, 0, 3,
    ]);
  });

  it('centres on the box, not on the origin', () => {
    expect(boxVolume([10, 20, 30], [12, 24, 36])).toEqual([
      11, 22, 33,
      1, 0, 0,
      0, 2, 0,
      0, 0, 3,
    ]);
  });

  it('is twelve numbers with zeros off the diagonal, because our boxes are axis-aligned', () => {
    const box = boxVolume([-3, -3, -3], [3, 3, 3]);
    expect(box).toHaveLength(12);
    expect([box[4], box[5], box[6], box[8], box[9], box[10]]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('gives a degenerate box zero half-axes rather than a NaN', () => {
    expect(boxVolume([5, 5, 5], [5, 5, 5])).toEqual([5, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('threeBoxToLocal', () => {
  it('turns Three Y-up into the tileset Z-up frame: up becomes z, north becomes y', () => {
    // A box 1 m east, 2 m tall, running 3 m to the south (+z in Three).
    expect(threeBoxToLocal([0, 0, 0], [1, 2, 3])).toEqual({
      min: [0, -3, 0],
      max: [1, 0, 2],
    });
  });

  it('swaps min and max on the flipped axis, so the box is never inside out', () => {
    const local = threeBoxToLocal([-5, 1, -20], [5, 4, -10]);
    expect(local.min[1]).toBeLessThan(local.max[1]);
    // Three z = −20..−10 is 10..20 m NORTH of the origin.
    expect(local.min[1]).toBe(10);
    expect(local.max[1]).toBe(20);
  });

  it('sends a point south in Three to a negative northing', () => {
    const local = threeBoxToLocal([0, 0, 40], [1, 1, 41]);
    expect(local.max[1]).toBe(-40);
    expect(local.min[1]).toBe(-41);
  });

  it('carries the Three height straight through as the local z extent', () => {
    const local = threeBoxToLocal([0, 7, 0], [1, 19, 1]);
    expect([local.min[2], local.max[2]]).toEqual([7, 19]);
  });
});

describe('buildTileset', () => {
  const BUCKETS = [
    bucket('0_0', 0, 0, [0, 0, 0], [10, 6, 10]),
    bucket('1_0', 1, 0, [10, 0, 0], [22, 6, 10]),
    bucket('1_1', 1, 1, [10, 0, 10], [20, 6, 24]),
  ];

  it('declares itself as 3D Tiles 1.1 and refines by adding', () => {
    const ts = buildTileset(BUCKETS, OPTS);
    expect(ts.asset).toEqual({ version: '1.1' });
    expect(ts.root.refine).toBe('ADD');
  });

  it('makes exactly one child per bucket, in the order it was given them', () => {
    const ts = buildTileset(BUCKETS, OPTS);
    expect(ts.root.children).toHaveLength(3);
    expect(ts.root.children?.map((c) => c.content?.uri))
      .toEqual(['tiles/0_0.glb', 'tiles/1_0.glb', 'tiles/1_1.glb']);
  });

  it('asks the caller for every content URI rather than inventing a layout', () => {
    const ts = buildTileset(BUCKETS, { gridSizeM: 20, contentUri: (k) => `https://cdn/${k}?v=2` });
    expect(ts.root.children?.[0].content?.uri).toBe('https://cdn/0_0?v=2');
  });

  it('gives each child the converted box, not the raw Three one', () => {
    const ts = buildTileset([BUCKETS[0]], OPTS);
    // Three [0,0,0]..[10,6,10] → local [0,-10,0]..[10,0,6].
    expect(ts.root.children?.[0].boundingVolume.box).toEqual([
      5, -5, 3,
      5, 0, 0,
      0, 5, 0,
      0, 0, 3,
    ]);
  });

  it('gives the root a box that contains every child', () => {
    const ts = buildTileset(BUCKETS, OPTS);
    const [cx, cy, cz, hx, , , , hy, , , , hz] = ts.root.boundingVolume.box;
    // Three union is [0,0,0]..[22,6,24] → local [0,-24,0]..[22,0,6].
    expect([cx, cy, cz]).toEqual([11, -12, 3]);
    expect([hx, hy, hz]).toEqual([11, 12, 3]);
  });

  it('keeps the root error above every child error, or nothing would ever refine into the tree', () => {
    const ts = buildTileset(BUCKETS, OPTS);
    const childErrors = ts.root.children?.map((c) => c.geometricError) ?? [];
    expect(childErrors).toHaveLength(3);
    for (const e of childErrors) expect(ts.root.geometricError).toBeGreaterThan(e);
    expect(ts.geometricError).toBe(ts.root.geometricError);
  });

  it('takes each child error from the bucket it came from', () => {
    const ts = buildTileset(BUCKETS, OPTS);
    expect(ts.root.children?.map((c) => c.geometricError))
      .toEqual(BUCKETS.map(geometricErrorFor));
  });

  it('keeps the root error meaningful even for a single tiny tile', () => {
    const ts = buildTileset([bucket('0_0', 0, 0, [0, 0, 0], [0.2, 0.2, 0.2])], OPTS);
    expect(ts.root.geometricError).toBeGreaterThan(ts.root.children?.[0].geometricError ?? 0);
    expect(ts.root.geometricError).toBeGreaterThanOrEqual(OPTS.gridSizeM);
  });

  it('builds a valid, childless tileset for a model with no geometry instead of throwing', () => {
    const ts = buildTileset([], OPTS);
    expect(ts.asset.version).toBe('1.1');
    expect(ts.root.children).toEqual([]);
    expect(ts.root.boundingVolume.box).toHaveLength(12);
    expect(ts.root.boundingVolume.box.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(ts.geometricError)).toBe(true);
  });

  it('serialises to JSON with no undefined holes, which is what actually gets written to disk', () => {
    const ts = buildTileset(BUCKETS, OPTS);
    const round = JSON.parse(JSON.stringify(ts)) as typeof ts;
    expect(round).toEqual(ts);
    expect(JSON.stringify(ts)).not.toContain('undefined');
  });
});
