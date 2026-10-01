import { describe, it, expect } from 'vitest';
import { RECT_EDGE_FRACTION, brushReachM, brushWeight, type BrushFootprint } from './brush';

const circle = (radiusM: number): BrushFootprint =>
  ({ shape: 'circle', radiusM, widthM: 0, depthM: 0, rotRad: 0 });
const rect = (widthM: number, depthM: number, rotRad = 0): BrushFootprint =>
  ({ shape: 'rect', radiusM: 0, widthM, depthM, rotRad });

describe('brushWeight — circle', () => {
  it('is full at the centre and nil at the rim', () => {
    expect(brushWeight(circle(3), 0, 0)).toBe(1);
    expect(brushWeight(circle(3), 3, 0)).toBe(0);
  });

  it('falls off from the very centre — a circular brush is a dome', () => {
    const half = brushWeight(circle(4), 2, 0);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
  });

  it('covers nothing outside the radius, in any direction', () => {
    for (const [du, dv] of [[3.1, 0], [0, -3.1], [2.2, 2.2]]) {
      expect(brushWeight(circle(3), du, dv)).toBe(0);
    }
  });

  it('is radially symmetric', () => {
    const b = circle(5);
    expect(brushWeight(b, 3, 0)).toBeCloseTo(brushWeight(b, 0, 3), 12);
    expect(brushWeight(b, 3, 0)).toBeCloseTo(brushWeight(b, -3, 0), 12);
  });

  it('a zero radius covers nothing rather than dividing by zero', () => {
    expect(brushWeight(circle(0), 0, 0)).toBe(0);
  });
});

describe('brushWeight — rectangle', () => {
  it('covers the rectangle and nothing beyond it', () => {
    const b = rect(10, 4);
    // Inside, near each side.
    expect(brushWeight(b, 4.9, 0)).toBeGreaterThan(0);
    expect(brushWeight(b, 0, 1.9)).toBeGreaterThan(0);
    // Outside: past the width, past the depth, and the corner a circle of the
    // same reach WOULD have caught.
    expect(brushWeight(b, 5.1, 0)).toBe(0);
    expect(brushWeight(b, 0, 2.1)).toBe(0);
    expect(brushWeight(b, 4.9, 2.5)).toBe(0);
  });

  it('holds a plateau inside the rim so it can make a flat platform', () => {
    const b = rect(10, 10);
    const plateau = 5 * (1 - RECT_EDGE_FRACTION);
    expect(brushWeight(b, 0, 0)).toBe(1);
    expect(brushWeight(b, plateau - 0.01, 0)).toBe(1);
    expect(brushWeight(b, plateau + 0.5, 0)).toBeLessThan(1);
  });

  it('ramps to zero at the border', () => {
    const b = rect(8, 8);
    expect(brushWeight(b, 3.999, 0)).toBeCloseTo(0, 3);
  });

  it('normalises each axis independently, so a long thin brush is thin', () => {
    const b = rect(20, 2);
    // Same fraction of each half-size ⇒ same weight, even though the distances
    // differ by a factor of ten.
    expect(brushWeight(b, 5, 0)).toBeCloseTo(brushWeight(b, 0, 0.5), 12);
  });

  it('rotates with the brush', () => {
    const upright = rect(10, 2);
    const turned = rect(10, 2, Math.PI / 2);
    // A point 4 m along terrain X is inside the upright brush, and outside the
    // one turned a quarter turn — where the same point is 4 m across a 2 m side.
    expect(brushWeight(upright, 4, 0)).toBeGreaterThan(0);
    expect(brushWeight(turned, 4, 0)).toBe(0);
    // And the turned brush reaches along terrain Z instead.
    expect(brushWeight(turned, 0, 4)).toBeCloseTo(brushWeight(upright, 4, 0), 12);
  });

  it('is symmetric about both of its own axes', () => {
    const b = rect(6, 3, 0.4);
    expect(brushWeight(b, 1.2, 0.7)).toBeCloseTo(brushWeight(b, -1.2, -0.7), 12);
  });

  it('a collapsed side covers nothing', () => {
    expect(brushWeight(rect(10, 0), 0, 0)).toBe(0);
    expect(brushWeight(rect(0, 10), 0, 0)).toBe(0);
  });
});

describe('brushReachM', () => {
  it('is the radius for a circle', () => {
    expect(brushReachM(circle(3.5))).toBe(3.5);
  });

  it('is the half-diagonal for a rectangle, so the grid loop never clips a corner', () => {
    const b = rect(6, 8);
    expect(brushReachM(b)).toBeCloseTo(5, 12);
    // The far corner is exactly at the reach and is still covered.
    expect(brushReachM(b)).toBeGreaterThanOrEqual(Math.hypot(3, 4));
  });
});
