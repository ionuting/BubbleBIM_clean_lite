import { describe, it, expect, beforeAll } from 'vitest';
import {
  boxSolid, bounds, extrudeFootprint, faceArea, isManifold, surfaceArea,
  validateSolid, volume, volumeM3, type Solid, type Vec2,
} from './index';
import { solidFromMesh, toIndexedMesh } from './mesh';
import {
  ensureBooleanEngine, getBooleanEngine, intersectSolids, subtractSolids, unionSolids,
} from './boolean';

const square = (s: number): Vec2[] => [
  { x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s },
];

beforeAll(async () => {
  await ensureBooleanEngine();
}, 30_000);

// ─── Mesh round trip (engine-independent) ─────────────────────────────────────

describe('mesh round trip', () => {
  it('a prism survives Solid → mesh → Solid unchanged', () => {
    const cube = extrudeFootprint(square(1000), 0, 1000)!;
    const back = solidFromMesh(toIndexedMesh(cube));

    expect(validateSolid(back)).toEqual([]);
    expect(back.vertices.length).toBe(8);
    // The key property: 12 triangles are merged back into 6 quads, not left loose.
    expect(back.faces.length).toBe(6);
    for (const f of back.faces) expect(f.outer.length).toBe(4);
    expect(volume(back)).toBeCloseTo(volume(cube), 3);
    expect(surfaceArea(back)).toBeCloseTo(surfaceArea(cube), 3);
  });

  it('keeps distinct facets of a cylinder separate rather than merging them', () => {
    const cyl = extrudeFootprint(
      Array.from({ length: 12 }, (_, i) => ({
        x: 500 * Math.cos((i * Math.PI) / 6),
        y: 500 * Math.sin((i * Math.PI) / 6),
      })),
      0, 1000,
    )!;
    const back = solidFromMesh(toIndexedMesh(cyl));
    expect(back.faces.length).toBe(14); // 12 sides + 2 caps
    expect(validateSolid(back)).toEqual([]);
  });

  it('a concave region rebuilds as one face, not a fan of triangles', () => {
    const L: Vec2[] = [
      { x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 1000 },
      { x: 1000, y: 1000 }, { x: 1000, y: 2000 }, { x: 0, y: 2000 },
    ];
    const back = solidFromMesh(toIndexedMesh(extrudeFootprint(L, 0, 1000)!));
    expect(validateSolid(back)).toEqual([]);
    expect(back.faces.length).toBe(8); // 6 sides + 2 caps
    const top = back.faces.find((f) => f.normal.z > 0.99)!;
    expect(top.outer.length).toBe(6);  // the L outline, collinear points dropped
    expect(volumeM3(back)).toBeCloseTo(3, 6);
  });

  it('an empty mesh rebuilds to an empty solid rather than throwing', () => {
    const s = solidFromMesh({ positions: new Float64Array(0), triangles: new Uint32Array(0) });
    expect(s.faces).toEqual([]);
  });
});

// ─── Engine wiring ────────────────────────────────────────────────────────────

describe('engine registry', () => {
  it('loads the manifold adapter by default', () => {
    const e = getBooleanEngine()!;
    expect(e.name).toBe('manifold-3d');
    expect(e.isReady()).toBe(true);
  });

  it('reports failure as a value, not an exception', () => {
    const empty: Solid = { vertices: [], faces: [] };
    const r = subtractSolids(empty, [boxSolid({ x: 0, y: 0, z: 0 }, 10, 10, 10)!]);
    expect(r.solid).toBeNull();
    expect(r.error).toMatch(/no faces/i);
  });

  it('subtracting nothing returns the host untouched', () => {
    const host = boxSolid({ x: 0, y: 0, z: 0 }, 100, 100, 100)!;
    expect(subtractSolids(host, []).solid).toBe(host);
  });
});

// ─── Subtraction: the wall-opening case ───────────────────────────────────────

describe('subtractSolids', () => {
  it('cuts a window clean through a wall, with faces reconstructed as a hole', () => {
    // 5 m × 200 mm × 3 m wall, centred on the origin in Y.
    const wall = extrudeFootprint(
      [{ x: 0, y: -100 }, { x: 5000, y: -100 }, { x: 5000, y: 100 }, { x: 0, y: 100 }],
      0, 3000, 'wall',
    )!;
    // 1200 × 1500 opening at sill 900, cutter EXACTLY flush with both wall faces
    // (zero overshoot) — the case the current OG path cannot do reliably.
    const opening = extrudeFootprint(
      [{ x: 1500, y: -100 }, { x: 2700, y: -100 }, { x: 2700, y: 100 }, { x: 1500, y: 100 }],
      900, 1500,
    )!;

    const { solid, error } = subtractSolids(wall, [opening]);
    expect(error).toBeUndefined();
    expect(validateSolid(solid!)).toEqual([]);

    expect(volumeM3(solid!)).toBeCloseTo(5.0 * 0.2 * 3.0 - 1.2 * 0.2 * 1.5, 5);

    // Each 5 m × 3 m wall face must come back as ONE face carrying ONE hole —
    // that is the whole point of rebuilding B-rep instead of keeping triangles.
    const bigFaces = solid!.faces.filter((f) => Math.abs(f.normal.y) > 0.99);
    expect(bigFaces.length).toBe(2);
    for (const f of bigFaces) {
      expect(f.outer.length).toBe(4);
      expect(f.holes?.length).toBe(1);
      expect(f.holes![0].length).toBe(4);
      // 15 m² of wall minus the 1.8 m² opening.
      expect(faceArea(solid!, solid!.faces.indexOf(f))).toBeCloseTo(5000 * 3000 - 1200 * 1500, 3);
    }

    // The reveal (the opening's four inner surfaces) exists as real geometry.
    expect(solid!.faces.length).toBe(2 + 4 + 4); // 2 faces + 4 wall edges + 4 reveals
  });

  it('cuts several openings in one batch', () => {
    const wall = extrudeFootprint(
      [{ x: 0, y: -100 }, { x: 6000, y: -100 }, { x: 6000, y: 100 }, { x: 0, y: 100 }],
      0, 3000, 'wall',
    )!;
    const cutters = [1000, 3000, 4500].map((x) =>
      extrudeFootprint(
        [{ x, y: -100 }, { x: x + 900, y: -100 }, { x: x + 900, y: 100 }, { x, y: 100 }],
        900, 1200,
      )!,
    );

    const { solid, error } = subtractSolids(wall, cutters);
    expect(error).toBeUndefined();
    expect(isManifold(solid!)).toBe(true);
    expect(volumeM3(solid!)).toBeCloseTo(6.0 * 0.2 * 3.0 - 3 * (0.9 * 0.2 * 1.2), 5);

    const face = solid!.faces.find((f) => f.normal.y > 0.99)!;
    expect(face.holes?.length).toBe(3);
  });

  it('a door cut to the floor opens the outline instead of leaving a hole', () => {
    const wall = extrudeFootprint(
      [{ x: 0, y: -100 }, { x: 4000, y: -100 }, { x: 4000, y: 100 }, { x: 0, y: 100 }],
      0, 3000, 'wall',
    )!;
    const door = extrudeFootprint(
      [{ x: 1000, y: -100 }, { x: 1900, y: -100 }, { x: 1900, y: 100 }, { x: 1000, y: 100 }],
      0, 2100,
    )!;

    const { solid } = subtractSolids(wall, [door]);
    expect(validateSolid(solid!)).toEqual([]);
    expect(volumeM3(solid!)).toBeCloseTo(4.0 * 0.2 * 3.0 - 0.9 * 0.2 * 2.1, 5);

    // Reaching the bottom edge makes the notch part of the outer boundary,
    // so the face gains vertices rather than a hole.
    const face = solid!.faces.find((f) => f.normal.y > 0.99)!;
    expect(face.holes).toBeUndefined();
    expect(face.outer.length).toBe(8);
  });

  it('a cutter that misses the host leaves it unchanged', () => {
    const host = boxSolid({ x: 0, y: 0, z: 0 }, 1000, 1000, 1000)!;
    const miss = boxSolid({ x: 5000, y: 0, z: 0 }, 100, 100, 100)!;
    const { solid } = subtractSolids(host, [miss]);
    expect(volume(solid!)).toBeCloseTo(volume(host), 3);
  });

  it('a cutter that swallows the host reports an empty result', () => {
    const host = boxSolid({ x: 0, y: 0, z: 0 }, 100, 100, 100)!;
    const big = boxSolid({ x: 0, y: 0, z: 0 }, 1000, 1000, 1000)!;
    const r = subtractSolids(host, [big]);
    expect(r.solid).toBeNull();
    expect(r.error).toMatch(/empty/i);
  });
});

// ─── Union: the wall-junction case ────────────────────────────────────────────

describe('unionSolids', () => {
  it('fuses two walls at an L-corner into one body, without double-counting the overlap', () => {
    const a = extrudeFootprint(
      [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 200 }, { x: 0, y: 200 }], 0, 3000,
    )!;
    const b = extrudeFootprint(
      [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 4000 }, { x: 0, y: 4000 }], 0, 3000,
    )!;

    const { solid, error } = unionSolids([a, b]);
    expect(error).toBeUndefined();
    expect(validateSolid(solid!)).toEqual([]);

    // Overlap counted once — exactly what the current pipeline gets wrong,
    // both visually (z-fighting) and in quantity takeoff.
    const expected = volume(a) + volume(b) - 200 * 200 * 3000;
    expect(volume(solid!)).toBeCloseTo(expected, 3);
    expect(volume(solid!)).toBeLessThan(volume(a) + volume(b));
  });

  it('a T-junction stays a single manifold body', () => {
    const chord = extrudeFootprint(
      [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 200 }, { x: 0, y: 200 }], 0, 3000,
    )!;
    const stem = extrudeFootprint(
      [{ x: 2900, y: 200 }, { x: 3100, y: 200 }, { x: 3100, y: 4000 }, { x: 2900, y: 4000 }], 0, 3000,
    )!;
    const { solid } = unionSolids([chord, stem]);
    expect(isManifold(solid!)).toBe(true);
    expect(volume(solid!)).toBeCloseTo(volume(chord) + volume(stem), 3); // they only touch
  });

  it('union of one solid is that solid', () => {
    const a = boxSolid({ x: 0, y: 0, z: 0 }, 100, 100, 100)!;
    expect(unionSolids([a]).solid).toBe(a);
  });

  it('union of nothing is an error, not a crash', () => {
    expect(unionSolids([]).error).toBeTruthy();
  });
});

// ─── Intersection ─────────────────────────────────────────────────────────────

describe('intersectSolids', () => {
  it('returns the shared volume of two overlapping boxes', () => {
    const a = boxSolid({ x: 0, y: 0, z: 0 }, 1000, 1000, 1000)!;
    const b = boxSolid({ x: 500, y: 0, z: 0 }, 1000, 1000, 1000)!;
    const { solid } = intersectSolids(a, [b]);
    expect(validateSolid(solid!)).toEqual([]);
    expect(volume(solid!)).toBeCloseTo(500 * 1000 * 1000, 3);
    const bb = bounds(solid!)!;
    expect(bb.min.x).toBeCloseTo(0, 3);
    expect(bb.max.x).toBeCloseTo(500, 3);
  });

  it('disjoint solids intersect to nothing', () => {
    const a = boxSolid({ x: 0, y: 0, z: 0 }, 100, 100, 100)!;
    const b = boxSolid({ x: 9999, y: 0, z: 0 }, 100, 100, 100)!;
    expect(intersectSolids(a, [b]).solid).toBeNull();
  });
});

// ─── Chaining ─────────────────────────────────────────────────────────────────

describe('chained operations', () => {
  it('a union result can be cut again — the output is a first-class Solid', () => {
    const a = extrudeFootprint(
      [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 200 }, { x: 0, y: 200 }], 0, 3000,
    )!;
    const b = extrudeFootprint(
      [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 3000 }, { x: 0, y: 3000 }], 0, 3000,
    )!;
    const joined = unionSolids([a, b]).solid!;

    const window = extrudeFootprint(
      [{ x: 1500, y: 0 }, { x: 2500, y: 0 }, { x: 2500, y: 200 }, { x: 1500, y: 200 }],
      1000, 1200,
    )!;
    const { solid, error } = subtractSolids(joined, [window]);

    expect(error).toBeUndefined();
    expect(validateSolid(solid!)).toEqual([]);
    expect(volume(solid!)).toBeCloseTo(volume(joined) - 1000 * 200 * 1200, 3);
  });
});
