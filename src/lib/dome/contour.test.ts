/**
 * Marching squares is checked against fields whose answer is known in closed
 * form — a disc, an annulus, two overlapping discs, a half-plane split. What
 * matters downstream is the AREA and the ORIENTATION of what comes back, so
 * those are what is asserted, not the vertex list.
 */
import { describe, expect, it } from 'vitest';
import { contourRegion, significantRings, simplifyRing, splitRings } from './contour';
import { pointInPolygon, polygonArea, type Pt2 } from '@/lib/geom/plan2d';

const box = { minX: -6000, minY: -6000, maxX: 6000, maxY: 6000 };
const disc = (cx: number, cy: number, r: number) => (p: Pt2) => r - Math.hypot(p.x - cx, p.y - cy);
const area = (ring: Pt2[]) => Math.abs(polygonArea(ring));

describe('contourRegion', () => {
  it('traces a disc, counter-clockwise, with the right area', () => {
    const rings = contourRegion(disc(0, 0, 4000), box, 100);
    expect(rings).toHaveLength(1);
    expect(polygonArea(rings[0])).toBeGreaterThan(0);           // outer ⇒ CCW
    expect(area(rings[0]) / (Math.PI * 4000 * 4000)).toBeCloseTo(1, 2);
  });

  it('gets closer to the true area as the grid refines', () => {
    const truth = Math.PI * 4000 * 4000;
    const coarse = Math.abs(area(contourRegion(disc(0, 0, 4000), box, 500)[0]) - truth);
    const fine = Math.abs(area(contourRegion(disc(0, 0, 4000), box, 100)[0]) - truth);
    expect(fine).toBeLessThan(coarse);
  });

  it('traces a hole clockwise, so the sign tells outer from hole', () => {
    // An annulus: inside the big disc AND outside the small one.
    const field = (p: Pt2) => Math.min(disc(0, 0, 4000)(p), -disc(0, 0, 1500)(p));
    const { outers, holes } = splitRings(contourRegion(field, box, 100));
    expect(outers).toHaveLength(1);
    expect(holes).toHaveLength(1);
    expect(area(outers[0]) / (Math.PI * 4000 * 4000)).toBeCloseTo(1, 2);
    expect(area(holes[0]) / (Math.PI * 1500 * 1500)).toBeCloseTo(1, 2);
  });

  it('returns two rings for two disjoint pieces', () => {
    const field = (p: Pt2) => Math.max(disc(-3500, 0, 1500)(p), disc(3500, 0, 1500)(p));
    const rings = contourRegion(field, box, 100);
    expect(rings).toHaveLength(2);
    for (const r of rings) expect(polygonArea(r)).toBeGreaterThan(0);
  });

  it('traces the half of a disc a second, taller surface does not claim', () => {
    // Two equal domes side by side: the crease is the perpendicular bisector,
    // so each owns exactly half of its own base plus the lens it wins.
    const zA = (p: Pt2) => 4000 - Math.hypot(p.x + 1500, p.y);
    const zB = (p: Pt2) => 4000 - Math.hypot(p.x - 1500, p.y);
    const own = (p: Pt2) => Math.min(disc(-1500, 0, 4000)(p), zA(p) - zB(p));
    const rings = contourRegion(own, box, 80);
    expect(rings).toHaveLength(1);
    expect(polygonArea(rings[0])).toBeGreaterThan(0);
    // Every point of the region must be left of x = 0, the bisector.
    for (const p of rings[0]) expect(p.x).toBeLessThan(60);
    // Exactly the disc of radius 4000 about (−1500, 0) cut by the line x = 0,
    // i.e. a circular segment of height R − d removed from the disc.
    const R = 4000, d = 1500;
    const capAway = R * R * Math.acos(d / R) - d * Math.sqrt(R * R - d * d);
    expect(area(rings[0]) / (Math.PI * R * R - capAway)).toBeCloseTo(1, 2);
  });

  it('returns nothing when the field never turns positive, or never negative', () => {
    expect(contourRegion(() => -1, box, 200)).toEqual([]);
    expect(contourRegion(() => 1, box, 200)).toEqual([]);
  });

  it('refuses a grid that would be absurdly large rather than hanging', () => {
    expect(contourRegion(disc(0, 0, 4000), box, 0.001)).toEqual([]);
  });

  it('handles a saddle — two lobes pinched at a point', () => {
    // Positive in two opposite quadrants, bounded by a disc: an hourglass
    // whose waist is the ambiguous cell. Both lobes must come back closed.
    const field = (p: Pt2) => Math.min(disc(0, 0, 4000)(p), p.x * p.y);
    const rings = contourRegion(field, box, 100);
    expect(rings.length).toBeGreaterThanOrEqual(2);
    for (const r of rings) {
      expect(r.length).toBeGreaterThanOrEqual(3);
      expect(polygonArea(r)).toBeGreaterThan(0);
    }
    // The two lobes together are half the disc.
    const total = rings.reduce((s, r) => s + area(r), 0);
    expect(total / (Math.PI * 4000 * 4000 / 2)).toBeCloseTo(1, 1);
  });
});

describe('significantRings', () => {
  it('drops slivers below the threshold', () => {
    const big = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }];
    const tiny = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }];
    expect(significantRings([big, tiny], 1000)).toEqual([big]);
  });
});

describe('simplifyRing', () => {
  it('collapses a densely sampled straight edge to its ends', () => {
    const dense: Pt2[] = [];
    for (let x = 0; x <= 1000; x += 10) dense.push({ x, y: 0 });
    for (let y = 10; y <= 1000; y += 10) dense.push({ x: 1000, y });
    for (let x = 990; x >= 0; x -= 10) dense.push({ x, y: 1000 });
    for (let y = 990; y >= 10; y -= 10) dense.push({ x: 0, y });
    const out = simplifyRing(dense, 1);
    expect(out.length).toBeLessThan(10);
    expect(Math.abs(polygonArea(out))).toBeCloseTo(1e6, -3);
  });

  it('keeps a curve that the tolerance cannot flatten', () => {
    const circle = Array.from({ length: 120 }, (_, i) => ({
      x: 4000 * Math.cos((i / 120) * Math.PI * 2), y: 4000 * Math.sin((i / 120) * Math.PI * 2),
    }));
    const out = simplifyRing(circle, 5);
    expect(out.length).toBeGreaterThan(40);
    expect(Math.abs(polygonArea(out)) / (Math.PI * 4000 * 4000)).toBeCloseTo(1, 2);
  });

  it('leaves short rings and a zero tolerance alone', () => {
    const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    expect(simplifyRing(tri, 1)).toBe(tri);
    const quad = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(simplifyRing(quad, 0)).toBe(quad);
  });
});

describe('the traced region agrees with the field it came from', () => {
  it('points inside the ring are inside the field, and outside are outside', () => {
    const field = (p: Pt2) => Math.max(disc(-1200, 0, 3000)(p), disc(1200, 0, 3000)(p));
    const ring = contourRegion(field, box, 60)[0];
    let checked = 0;
    for (let x = -5000; x <= 5000; x += 250) {
      for (let y = -5000; y <= 5000; y += 250) {
        const p = { x, y };
        const f = field(p);
        if (Math.abs(f) < 120) continue;              // within a cell of the curve
        expect(pointInPolygon(p, ring, 0), `${x},${y}`).toBe(f > 0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});
