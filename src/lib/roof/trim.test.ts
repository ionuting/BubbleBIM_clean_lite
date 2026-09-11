import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode } from '@/store';
import type { RoofFace3D } from './types';
import {
  DEFAULT_TRIM_PRIORITY,
  attachHeightAlong,
  attachesToRoof,
  cuts,
  isTrimmed,
  nodesCuttingRoof,
  planeZ,
  planesFromFaces,
  roofTrim,
  roofTrimsNode,
  topOutline,
  trimHeightAt,
  trimPriority,
  trimmedTopAlong,
} from './trim';

const node = (id: string, type: string, properties: Record<string, unknown> = {}): BubbleGraphNode =>
  ({ id, type, name: id, x: 0, y: 0, z: 0, properties });

/**
 * A symmetric gable over a 10 × 6 m rectangle: eaves at y = 0 and y = 6000
 * (z = 3000), ridge along y = 3000 (z = 4500). Slope = 1500 / 3000 = 0.5.
 */
const GABLE: RoofFace3D[] = [
  {
    id: 'south', role: 'slope',
    vertices: [
      { x: 0, y: 0, z: 3000 }, { x: 10000, y: 0, z: 3000 },
      { x: 10000, y: 3000, z: 4500 }, { x: 0, y: 3000, z: 4500 },
    ],
  },
  {
    id: 'north', role: 'slope',
    vertices: [
      { x: 0, y: 3000, z: 4500 }, { x: 10000, y: 3000, z: 4500 },
      { x: 10000, y: 6000, z: 3000 }, { x: 0, y: 6000, z: 3000 },
    ],
  },
];

/** The vertical triangle closing the gable — carries no height information. */
const GABLE_END: RoofFace3D = {
  id: 'east', role: 'gable_end',
  vertices: [
    { x: 10000, y: 0, z: 3000 }, { x: 10000, y: 6000, z: 3000 }, { x: 10000, y: 3000, z: 4500 },
  ],
};

describe('priority', () => {
  it('defaults per type, overridden by trim_priority, and ties cut nothing', () => {
    expect(trimPriority(node('r', 'roof'))).toBe(100);
    expect(trimPriority(node('w', 'wall'))).toBe(DEFAULT_TRIM_PRIORITY);
    expect(trimPriority(node('b', 'beam'))).toBe(20);
    expect(trimPriority(node('c', 'column', { trim_priority: 200 }))).toBe(200);
    expect(trimPriority(node('c', 'column', { trim_priority: '150' }))).toBe(150);
    expect(trimPriority(node('c', 'column', { trim_priority: 'nonsense' }))).toBe(DEFAULT_TRIM_PRIORITY);

    expect(cuts(node('r', 'roof'), node('w', 'wall'))).toBe(true);
    expect(cuts(node('w', 'wall'), node('r', 'roof'))).toBe(false);
    // A chimney raised above the roof inverts the relation.
    expect(cuts(node('ch', 'column', { trim_priority: 200 }), node('r', 'roof'))).toBe(true);
    expect(cuts(node('w1', 'wall'), node('w2', 'wall'))).toBe(false);
  });
});

describe('planes', () => {
  it('fits one linear height per slope and drops vertical faces', () => {
    const planes = planesFromFaces('roof1', [...GABLE, GABLE_END]);
    expect(planes.map((p) => p.faceId)).toEqual(['south', 'north']);
    const south = planes[0];
    expect(planeZ(south, 5000, 0)).toBeCloseTo(3000, 6);
    expect(planeZ(south, 5000, 3000)).toBeCloseTo(4500, 6);
    expect(planeZ(south, 5000, 1500)).toBeCloseTo(3750, 6);
    expect(south.minZ).toBe(3000);
    expect(south.maxZ).toBe(4500);
  });

  it('the roof offset shifts every plane, so the cut can drop to the rafters', () => {
    const [south] = planesFromFaces('roof1', GABLE, -200);
    expect(planeZ(south, 5000, 0)).toBeCloseTo(2800, 6);
    expect(south.minZ).toBe(2800);
  });
});

describe('trimHeightAt', () => {
  const planes = planesFromFaces('roof1', GABLE);

  it('is the lowest covering plane, and infinite where the roof does not reach', () => {
    expect(trimHeightAt(planes, 5000, 0)).toBeCloseTo(3000, 6);
    expect(trimHeightAt(planes, 5000, 3000)).toBeCloseTo(4500, 6);
    expect(trimHeightAt(planes, 5000, 4500)).toBeCloseTo(3750, 6);
    expect(trimHeightAt(planes, 5000, 6000)).toBeCloseTo(3000, 6);
    expect(trimHeightAt(planes, 20000, 3000)).toBe(Infinity);
    expect(trimHeightAt(planes, 5000, -500)).toBe(Infinity);
  });
});

describe('trimmedTopAlong', () => {
  const planes = planesFromFaces('roof1', GABLE);

  it('a wall along an eave keeps one flat top at the eave height', () => {
    const segs = trimmedTopAlong(planes, { x: 0, y: 0 }, { x: 10000, y: 0 }, 6000);
    expect(segs).toHaveLength(1);
    expect(segs[0].z0).toBeCloseTo(3000, 6);
    expect(segs[0].z1).toBeCloseTo(3000, 6);
    expect(isTrimmed(segs, 6000)).toBe(true);
  });

  it('a wall crossing the ridge folds into two straight pieces meeting at the apex', () => {
    const segs = trimmedTopAlong(planes, { x: 5000, y: 0 }, { x: 5000, y: 6000 }, 6000);
    expect(segs).toHaveLength(2);
    expect(segs[0].t1).toBeCloseTo(0.5, 6);
    expect(segs[0].z0).toBeCloseTo(3000, 6);
    expect(segs[0].z1).toBeCloseTo(4500, 6);
    expect(segs[1].z0).toBeCloseTo(4500, 6);
    expect(segs[1].z1).toBeCloseTo(3000, 6);
    // The outline is the gable triangle: up to the ridge and back down.
    expect(topOutline(segs).map((p) => Math.round(p.z))).toEqual([3000, 4500, 3000]);
  });

  it('a low wall is left alone; the cap wins wherever the roof is higher', () => {
    const segs = trimmedTopAlong(planes, { x: 5000, y: 0 }, { x: 5000, y: 6000 }, 2500);
    expect(isTrimmed(segs, 2500)).toBe(false);
    expect(segs.every((s) => s.z0 <= 2500 + 1e-6 && s.z1 <= 2500 + 1e-6)).toBe(true);
  });

  it('a wall that starts under the roof and runs out of it steps back up to its own height', () => {
    const segs = trimmedTopAlong(planes, { x: 5000, y: 0 }, { x: 5000, y: 12000 }, 6000);
    // Half the run is roofed (0 → 6000 mm of 12000), the rest is free.
    const roofed = segs.filter((s) => s.z0 < 6000 - 1 || s.z1 < 6000 - 1);
    const free = segs.filter((s) => s.z0 > 6000 - 1 && s.z1 > 6000 - 1);
    expect(roofed.length).toBeGreaterThan(0);
    expect(free.length).toBeGreaterThan(0);
    expect(Math.max(...roofed.map((s) => s.t1))).toBeCloseTo(0.5, 3);
    expect(free[0].z0).toBe(6000);
  });

  it('the cap and the slope cross mid-run, and the break lands exactly on the crossing', () => {
    // Cap at 3750 = the slope height at y = 1500, i.e. a quarter along this run.
    const segs = trimmedTopAlong(planes, { x: 5000, y: 0 }, { x: 5000, y: 6000 }, 3750);
    const brk = segs.find((s) => Math.abs(s.z1 - 3750) < 1e-6 && s.z0 < 3750);
    expect(brk?.t1).toBeCloseTo(0.25, 6);
    expect(segs.every((s) => s.z0 <= 3750 + 1e-6 && s.z1 <= 3750 + 1e-6)).toBe(true);
  });

  it('attachHeightAlong reaches the apex of a run that crosses the ridge', () => {
    expect(attachHeightAlong(planes, { x: 5000, y: 0 }, { x: 5000, y: 6000 })).toBeCloseTo(4500, 6);
    expect(attachHeightAlong(planes, { x: 0, y: 0 }, { x: 10000, y: 0 })).toBeCloseTo(3000, 6);
    expect(attachHeightAlong(planes, { x: 50000, y: 0 }, { x: 51000, y: 0 })).toBeNull();
    expect(attachesToRoof(node('w', 'wall', { roof_attach: 'True' }))).toBe(true);
    expect(attachesToRoof(node('w', 'wall'))).toBe(false);
  });

  it('no planes, or a run nowhere near the roof, gives back the untrimmed top', () => {
    expect(trimmedTopAlong([], { x: 0, y: 0 }, { x: 1000, y: 0 }, 2800))
      .toEqual([{ t0: 0, t1: 1, z0: 2800, z1: 2800 }]);
    const far = trimmedTopAlong(planes, { x: 50000, y: 0 }, { x: 51000, y: 0 }, 2800);
    expect(isTrimmed(far, 2800)).toBe(false);
  });
});

describe('roof trim set', () => {
  const roof = node('roof1', 'roof');
  const trim = roofTrim(roof, GABLE)!;
  const square = [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }, { x: 2000, y: 2000 }, { x: 1000, y: 2000 }];

  it('covers the roof footprint and knows its own floor', () => {
    expect(trim.bbox).toEqual({ minX: 0, minY: 0, maxX: 10000, maxY: 6000 });
    expect(trim.minZ).toBe(3000);
    expect(trim.priority).toBe(100);
    expect(roofTrim(node('r2', 'roof'), [GABLE_END])).toBeNull();
  });

  it('trims what is under it and below it in priority — never its own members', () => {
    expect(roofTrimsNode(trim, node('w', 'wall'), square)).toBe(true);
    expect(roofTrimsNode(trim, node('rafter', 'rafter', { source_roof_id: 'roof1' }), square)).toBe(false);
    expect(roofTrimsNode(trim, node('ch', 'column', { trim_priority: 200 }), square)).toBe(false);
    expect(roofTrimsNode(trim, node('w2', 'wall'), [{ x: 90000, y: 0 }, { x: 91000, y: 0 }, { x: 91000, y: 1000 }])).toBe(false);
    expect(roofTrimsNode(trim, node('w3', 'wall'), [])).toBe(false);
    // A roof can opt out entirely.
    const off = roofTrim(node('r3', 'roof', { trim_below: 'False' }), GABLE)!;
    expect(roofTrimsNode(off, node('w', 'wall'), square)).toBe(false);
  });

  it('reports the nodes entitled to cut the roof back', () => {
    const all = [
      node('w', 'wall'),
      node('ch', 'column', { trim_priority: 200 }),
      node('rafter', 'rafter', { source_roof_id: 'roof1', trim_priority: 999 }),
      roof,
    ];
    expect(nodesCuttingRoof(trim, all).map((n) => n.id)).toEqual(['ch']);
  });
});
