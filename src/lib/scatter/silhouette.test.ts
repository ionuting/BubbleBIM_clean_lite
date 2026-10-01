/**
 * The side-view outlines have to be the bodies `mesh.ts` builds, seen from
 * the side: the canopy as wide as the instance and the whole as tall as it,
 * the trunk under it, the stone squashed to its height. And never a box —
 * that was the bug.
 */
import { describe, expect, it } from 'vitest';
import { scatterSilhouette } from './silhouette';
import type { ScatterInstance } from './types';

const inst = (kind: ScatterInstance['kind'], sizeMm: number, heightMm: number, variant = 0.37): ScatterInstance =>
  ({ x: 0, y: 0, z: 0, kind, sizeMm, heightMm, rotDeg: 0, variant } as ScatterInstance);

const extent = (pts: { du: number; dv: number }[]) => ({
  duMin: Math.min(...pts.map((p) => p.du)), duMax: Math.max(...pts.map((p) => p.du)),
  dvMin: Math.min(...pts.map((p) => p.dv)), dvMax: Math.max(...pts.map((p) => p.dv)),
});

describe('scatterSilhouette', () => {
  it('a tree is a trunk with a canopy ellipse on it, as wide and as tall as the instance', () => {
    const parts = scatterSilhouette(inst('tree', 4000, 6000));
    expect(parts.map((p) => p.bucket)).toEqual(['wood', 'foliage']);
    const trunk = extent(parts[0].pts), canopy = extent(parts[1].pts);
    expect(trunk.dvMin).toBe(0);
    expect(trunk.dvMax).toBeCloseTo(2100, 6);            // 35 % of the height
    expect(trunk.duMax - trunk.duMin).toBeCloseTo(440, 6); // the 5.5 % radius at the foot
    expect(canopy.duMin).toBeCloseTo(-2000, 6);
    expect(canopy.duMax).toBeCloseTo(2000, 6);
    expect(canopy.dvMax).toBeCloseTo(6000, 6);
    expect(canopy.dvMin).toBeCloseTo(2100, 6);
    // A curve, not a rectangle: many corners, none of them repeated.
    expect(parts[1].pts.length).toBeGreaterThanOrEqual(16);
  });

  it('a shrub is one ellipse on the ground', () => {
    const [p] = scatterSilhouette(inst('shrub', 1200, 1000));
    expect(p.bucket).toBe('foliage');
    const e = extent(p.pts);
    expect(e.dvMin).toBeCloseTo(0, 6);
    expect(e.dvMax).toBeCloseTo(1000, 6);
    expect(e.duMax - e.duMin).toBeCloseTo(1200, 6);
  });

  it('a stone is a wobbled blob that sits a little into the ground, the same for the same seed', () => {
    const a = scatterSilhouette(inst('rock', 800, 500, 0.5))[0];
    const b = scatterSilhouette(inst('rock', 800, 500, 0.5))[0];
    const c = scatterSilhouette(inst('rock', 800, 500, 0.9))[0];
    expect(a.bucket).toBe('stone');
    expect(a.pts).toEqual(b.pts);
    expect(a.pts).not.toEqual(c.pts);
    const e = extent(a.pts);
    expect(e.dvMin).toBeLessThan(0);
    expect(e.dvMax).toBeGreaterThan(300);
    expect(e.duMax - e.duMin).toBeGreaterThan(600);
    expect(e.duMax - e.duMin).toBeLessThan(1000);
  });

  it('grass is three blades', () => {
    const parts = scatterSilhouette(inst('grass', 400, 300));
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(extent(p.pts).dvMax).toBe(300);
  });
});
