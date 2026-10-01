/**
 * A Voronoi tessellation clipped to a base is right when the cells tile the
 * base exactly and each seed sits in its own cell. Both are checked on a
 * convex base and on a concave one — the concave case is the reason the
 * cells are cut by half-planes rather than taken from the Delaunay dual.
 */
import { describe, expect, it } from 'vitest';
import { cellEdges, clipByLine, lloydStep, rng, seedPoints, voronoiCells } from './voronoi';
import { pointInPolygon, polygonArea, type Pt2 } from '@/lib/geom/plan2d';

const square: Pt2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
const L: Pt2[] = [
  { x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 },
  { x: 3000, y: 3000 }, { x: 3000, y: 6000 }, { x: 0, y: 6000 },
];
const area = (p: Pt2[]) => Math.abs(polygonArea(p));

describe('clipByLine', () => {
  it('keeps the half on the normal\'s side', () => {
    const half = clipByLine(square, { x: 5, y: 0 }, { x: 1, y: 0 });
    expect(area(half)).toBeCloseTo(50, 6);
    for (const p of half) expect(p.x).toBeGreaterThanOrEqual(5 - 1e-9);
  });

  it('an offset moves the cut line along the normal', () => {
    const strip = clipByLine(square, { x: 0, y: 0 }, { x: 1, y: 0 }, 8);
    expect(area(strip)).toBeCloseTo(20, 6);
  });

  it('a line missing the polygon returns it whole, or nothing', () => {
    expect(area(clipByLine(square, { x: -1, y: 0 }, { x: 1, y: 0 }))).toBeCloseTo(100, 6);
    expect(clipByLine(square, { x: 11, y: 0 }, { x: 1, y: 0 })).toEqual([]);
  });
});

describe('voronoiCells', () => {
  it('two seeds split a square into the two halves', () => {
    const cells = voronoiCells(square, [{ x: 2.5, y: 5 }, { x: 7.5, y: 5 }]);
    expect(cells).toHaveLength(2);
    expect(area(cells[0])).toBeCloseTo(50, 6);
    expect(area(cells[1])).toBeCloseTo(50, 6);
    expect(cells[0].some((p) => Math.abs(p.x - 5) < 1e-9)).toBe(true);
  });

  it('cells tile the base and each contains its seed', () => {
    const seeds = seedPoints(square, 25, rng(3));
    const cells = voronoiCells(square, seeds);
    expect(cells.reduce((s, c) => s + area(c), 0)).toBeCloseTo(100, 4);
    cells.forEach((c, i) => expect(pointInPolygon(seeds[i], c, 1e-6), `seed ${i}`).toBe(true));
  });

  it('tiles a concave base too', () => {
    const seeds = seedPoints(L, 30, rng(11));
    const cells = voronoiCells(L, seeds);
    const covered = cells.reduce((s, c) => s + area(c), 0);
    expect(Math.abs(covered - area(L)) / area(L)).toBeLessThan(0.01);
    // No cell reaches into the notch.
    for (const c of cells) for (const p of c) {
      expect(p.x <= 3000 + 1e-6 || p.y <= 3000 + 1e-6, `${p.x},${p.y}`).toBe(true);
    }
  });
});

describe('seedPoints', () => {
  it('is deterministic for a seed and lands inside the base', () => {
    const a = seedPoints(L, 40, rng(5));
    const b = seedPoints(L, 40, rng(5));
    expect(a).toEqual(b);
    expect(a).toHaveLength(40);
    for (const p of a) expect(pointInPolygon(p, L, 0)).toBe(true);
    expect(seedPoints(L, 40, rng(6))).not.toEqual(a);
  });

  it('spreads the seeds rather than clumping them', () => {
    const pts = seedPoints(square, 20, rng(1));
    let minD = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      minD = Math.min(minD, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    }
    expect(minD).toBeGreaterThan(0.6);   // expected spacing ≈ 2.2; dart throwing keeps ≥ ~0.6·spacing·decay
  });
});

describe('lloydStep', () => {
  it('moves a single seed to the centre of a flat square', () => {
    const seeds = [{ x: 1, y: 1 }];
    const next = lloydStep(square, seeds, voronoiCells(square, seeds), () => 0);
    expect(next[0].x).toBeCloseTo(5, 6);
    expect(next[0].y).toBeCloseTo(5, 6);
  });

  it('weights by surface area — a lifted flank pulls the centroid towards it', () => {
    // Height rises steeply towards x = 10: more surface there, so the
    // centroid of the lifted cell sits right of the plan centre.
    const seeds = [{ x: 5, y: 5 }];
    const next = lloydStep(square, seeds, voronoiCells(square, seeds), (p) => (p.x / 10) ** 3 * 40);
    expect(next[0].x).toBeGreaterThan(5.5);
    expect(next[0].y).toBeCloseTo(5, 6);
  });

  it('leaves a seed whose cell vanished where it is', () => {
    expect(lloydStep(square, [{ x: 1, y: 1 }], [[]], () => 0)).toEqual([{ x: 1, y: 1 }]);
  });
});

describe('cellEdges', () => {
  it('lists each edge once and knows which lie on the base', () => {
    const cells = voronoiCells(square, [{ x: 2.5, y: 5 }, { x: 7.5, y: 5 }]);
    const edges = cellEdges(cells);
    expect(edges).toHaveLength(7);
    const shared = edges.filter((e) => e.cells.length === 2);
    expect(shared).toHaveLength(1);
    expect(shared[0].a.x).toBeCloseTo(5, 6);
    expect(shared[0].b.x).toBeCloseTo(5, 6);
    expect(edges.filter((e) => e.cells.length === 1)).toHaveLength(6);
  });
});
