/**
 * Two bubbles that touch. What has to be true:
 *
 *   • the outer shell is the higher of the two everywhere — no geometry is
 *     left inside the common volume;
 *   • the two owned regions tile the union exactly: nothing drawn twice,
 *     nothing missing;
 *   • the crease carries ribs, and carries them ONCE.
 *
 * Those are the assertions. How the regions are found is free to change.
 */
import { describe, expect, it } from 'vitest';
import { computeDome } from './index';
import { ownedRegion, regionArea, shellsIntersect, winMargin, type DomeShell } from './cluster';
import { membraneFor } from './cluster';
import { circlePolygon } from './index';
import { pointInPolygon } from '@/lib/geom/plan2d';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';

const storey: BubbleGraphNode = {
  id: 'st1', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};

const ax = (id: string, x: number, y: number): BubbleGraphNode =>
  ({ id, type: 'ax', name: id, x, y, z: 0, parentId: 'st1', properties: { bimX: x, bimY: y } });

/** Two circular domes, each on its own centre axis. */
function twoDomes(opts: {
  gapMm: number; radius?: number; heightA?: number; heightB?: number; cells?: number;
}) {
  const R = opts.radius ?? 4000;
  const axA = ax('axA', -opts.gapMm / 2, 0);
  const axB = ax('axB', opts.gapMm / 2, 0);
  const mk = (id: string, h: number): BubbleGraphNode => ({
    id, type: 'dome', name: id, x: 0, y: 0, z: 0, parentId: 'st1',
    properties: {
      base_radius_mm: R, dome_height_mm: h, cell_count: opts.cells ?? 24,
      cell_seed: 3, p_w_mm: 60, p_h_mm: 120, resolution: 22,
    },
  });
  const A = mk('domeA', opts.heightA ?? 4000);
  const B = mk('domeB', opts.heightB ?? 4000);
  const nodes = [storey, axA, axB, A, B];
  const edges: BubbleGraphEdge[] = [
    { id: 'e1', from: A.id, to: axA.id },
    { id: 'e2', from: B.id, to: axB.id },
  ];
  return { A, B, nodeMap: new Map(nodes.map((n) => [n.id, n])), edges, R };
}

const shellOf = (cx: number, r: number, h: number): DomeShell => ({
  ownerId: `s${cx}`,
  base: circlePolygon(cx, 0, r),
  membrane: membraneFor(circlePolygon(cx, 0, r), h, 1, 22)!,
  baseZMm: 0,
});

describe('shellsIntersect', () => {
  it('sees a real overlap and ignores mere neighbours', () => {
    expect(shellsIntersect(shellOf(-1500, 4000, 4000), shellOf(1500, 4000, 4000))).toBe(true);
    expect(shellsIntersect(shellOf(-6000, 4000, 4000), shellOf(6000, 4000, 4000))).toBe(false);
  });

  it('two bases that only touch at a point do not count as intersecting', () => {
    expect(shellsIntersect(shellOf(-4000, 4000, 4000), shellOf(4000, 4000, 4000))).toBe(false);
  });
});

describe('winMargin', () => {
  const a = shellOf(-1500, 4000, 4000);
  const b = shellOf(1500, 4000, 4000);

  it('is positive on my side of the crease and negative on the other', () => {
    expect(winMargin(a, [b], { x: -3000, y: 0 })).toBeGreaterThan(0);
    expect(winMargin(a, [b], { x: 1000, y: 0 })).toBeLessThan(0);
  });

  it('is zero on the crease — here, the bisector', () => {
    expect(Math.abs(winMargin(a, [b], { x: 0, y: 0 }))).toBeLessThan(50);
  });

  it('is infinite where nobody else reaches', () => {
    expect(winMargin(a, [b], { x: -5400, y: 0 })).toBe(Infinity);
  });
});

describe('ownedRegion', () => {
  it('two equal domes split their overlap down the bisector', () => {
    const a = shellOf(-1500, 4000, 4000);
    const b = shellOf(1500, 4000, 4000);
    const ra = ownedRegion(a, [b], 120);
    expect(ra.outers).toHaveLength(1);
    for (const p of ra.outers[0]) expect(p.x).toBeLessThan(150);
    // Mirror image, so the two regions have the same area.
    const rb = ownedRegion(b, [a], 120);
    expect(regionArea(ra) / regionArea(rb)).toBeCloseTo(1, 1);
  });

  it('a taller dome takes more than half', () => {
    const tall = shellOf(-1500, 4000, 6000);
    const low = shellOf(1500, 4000, 3000);
    expect(regionArea(ownedRegion(tall, [low], 120)))
      .toBeGreaterThan(regionArea(ownedRegion(low, [tall], 120)));
  });

  it('the two regions tile the union — no gap, no double cover', () => {
    const a = shellOf(-1500, 4000, 4000);
    const b = shellOf(1500, 4000, 4000);
    const ra = ownedRegion(a, [b], 100).outers[0];
    const rb = ownedRegion(b, [a], 100).outers[0];
    let inUnion = 0, covered = 0, doubled = 0;
    for (let x = -6000; x <= 6000; x += 200) {
      for (let y = -6000; y <= 6000; y += 200) {
        const p = { x, y };
        const inA = pointInPolygon(p, a.base, 0), inB = pointInPolygon(p, b.base, 0);
        if (!inA && !inB) continue;
        // Skip a band around the crease, where the grid cannot decide.
        if (Math.abs(winMargin(a, [b], p)) < 150) continue;
        inUnion++;
        const cA = pointInPolygon(p, ra, 0), cB = pointInPolygon(p, rb, 0);
        if (cA || cB) covered++;
        if (cA && cB) doubled++;
      }
    }
    expect(inUnion).toBeGreaterThan(1000);
    expect(covered / inUnion).toBeGreaterThan(0.99);
    expect(doubled / inUnion).toBeLessThan(0.01);
  });

  it('a dome swallowed by a taller one that covers it owns nothing', () => {
    const small = shellOf(0, 1500, 1000);
    const big = shellOf(0, 5000, 6000);
    expect(regionArea(ownedRegion(small, [big], 80))).toBeLessThan(1e5);
  });
});

describe('computeDome on a cluster', () => {
  const { A, B, nodeMap, edges } = twoDomes({ gapMm: 3000 });
  const ra = computeDome(A, nodeMap, edges);
  const rb = computeDome(B, nodeMap, edges);

  it('both domes know they are in a cluster, and with whom', () => {
    expect(ra.clustered).toBe(true);
    expect(ra.clusteredWith).toEqual(['domeB']);
    expect(rb.clusteredWith).toEqual(['domeA']);
    expect(ra.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('neither draws anything on the far side of the crease', () => {
    for (const p of ra.panels) expect(p.origin.x).toBeLessThan(400);
    for (const p of rb.panels) expect(p.origin.x).toBeGreaterThan(-400);
  });

  it('no panel sits below the other dome — the common volume is gone', () => {
    const shellB = shellOf(1500, 4000, 4000);
    for (const p of ra.panels) {
      const here = { x: p.origin.x, y: p.origin.y };
      if (!pointInPolygon(here, shellB.base, 0)) continue;
      const zB = shellB.baseZMm + shellB.membrane.sample(here).z;
      // A's panel must be at or above B's surface, bar the panel inset.
      expect(p.origin.z - ra.baseZMm).toBeGreaterThan(zB - 400);
    }
  });

  it('the crease carries ribs, and only one dome emits them', () => {
    const seamA = ra.members.filter((m) => m.onSeam);
    const seamB = rb.members.filter((m) => m.onSeam);
    expect(seamA.length + seamB.length).toBeGreaterThan(3);
    // `domeA` sorts first, so it owns the shared crease and `domeB` emits none.
    expect(seamB).toHaveLength(0);
    expect(ra.seamLengthMm).toBeGreaterThan(1000);
    expect(rb.seamLengthMm).toBe(0);
    // The seam runs up and over: its highest point clears the springing.
    const top = Math.max(...seamA.flatMap((m) => m.points.map((p) => p.z)));
    expect(top - ra.baseZMm).toBeGreaterThan(1500);
  });

  it('separated domes are not a cluster and keep their exact circular bases', () => {
    const far = twoDomes({ gapMm: 12000 });
    const r = computeDome(far.A, far.nodeMap, far.edges);
    expect(r.clustered).toBe(false);
    expect(r.clusteredWith).toEqual([]);
    expect(r.members.some((m) => m.onSeam)).toBe(false);
    expect(r.base).toHaveLength(far.R / 150 > 64 ? Math.round(far.R / 150) : 64);
  });

  it('moving the neighbour changes this dome — the cache is not stale', () => {
    const near = twoDomes({ gapMm: 3000 });
    const before = computeDome(near.A, near.nodeMap, near.edges);
    const movedAx = ax('axB', 40000, 0);
    const moved = new Map(near.nodeMap);
    moved.set('axB', movedAx);
    const after = computeDome(near.A, moved, near.edges);
    expect(after).not.toBe(before);
    expect(before.clustered).toBe(true);
    expect(after.clustered).toBe(false);
  });

  it('a lower dome loses its share of the overlap to the taller one', () => {
    const g = twoDomes({ gapMm: 3000, heightA: 6000, heightB: 2500 });
    const tall = computeDome(g.A, g.nodeMap, g.edges);
    const low = computeDome(g.B, g.nodeMap, g.edges);
    expect(tall.glassAreaMm2).toBeGreaterThan(low.glassAreaMm2);
    // The tall one reaches past the bisector.
    expect(Math.max(...tall.panels.map((p) => p.origin.x))).toBeGreaterThan(200);
  });
});
