/**
 * The membrane has one closed-form case: on a disc the normalised Poisson
 * solution is 1 − r²/R², so z = H·(1 − r²/R²)^e. That is checked at several
 * radii, at both ends of the bulge range — if the solver, the scaling or the
 * exponent were wrong, no radius would land.
 */
import { describe, expect, it } from 'vitest';
import { buildMembrane, bulgeExponent } from './membrane';
import type { Pt2 } from '@/lib/geom/plan2d';

const circle = (R: number, n = 64): Pt2[] =>
  Array.from({ length: n }, (_, i) => ({
    x: R * Math.cos((i / n) * Math.PI * 2), y: R * Math.sin((i / n) * Math.PI * 2),
  }));

const R = 5000, H = 5000;

describe('bulgeExponent', () => {
  it('maps 0 to a paraboloid and 1 to an ellipsoid, and clamps beyond', () => {
    expect(bulgeExponent(0)).toBe(1);
    expect(bulgeExponent(1)).toBe(0.5);
    expect(bulgeExponent(1.5)).toBe(0.25);
    expect(bulgeExponent(10)).toBe(0.25);
    expect(bulgeExponent(-5)).toBe(1.5);
  });
});

describe('buildMembrane on a disc', () => {
  const m = buildMembrane(circle(R), { heightMm: H, bulge: 1, resolution: 32 })!;

  it('builds, with the boundary pinned at zero', () => {
    expect(m).not.toBeNull();
    for (let i = 0; i < m.pts.length; i++) if (m.boundary[i]) expect(m.z[i]).toBe(0);
    expect(m.tris.length).toBeGreaterThan(500);
  });

  it('reaches the asked height at the apex', () => {
    expect(m.sample({ x: 0, y: 0 }).z).toBeCloseTo(H, -2);   // within ~50 mm
  });

  it('is a hemisphere at bulge 1 when H = R', () => {
    for (const r of [1000, 2500, 4000]) {
      const want = H * Math.sqrt(1 - (r / R) ** 2);
      const got = m.sample({ x: r, y: 0 }).z;
      expect(Math.abs(got - want) / want, `r=${r}`).toBeLessThan(0.04);
      // And rotationally symmetric.
      expect(m.sample({ x: 0, y: -r }).z).toBeCloseTo(got, -2);
    }
  });

  it('is a paraboloid at bulge 0', () => {
    const p = buildMembrane(circle(R), { heightMm: H, bulge: 0, resolution: 32 })!;
    for (const r of [1000, 2500, 4000]) {
      const want = H * (1 - (r / R) ** 2);
      expect(Math.abs(p.sample({ x: r, y: 0 }).z - want) / want, `r=${r}`).toBeLessThan(0.04);
    }
  });

  it('normals point up at the apex and outward on the flank', () => {
    const top = m.sample({ x: 0, y: 0 }).normal;
    expect(top.z).toBeGreaterThan(0.99);
    const flank = m.sample({ x: 4000, y: 0 }).normal;
    expect(flank.x).toBeGreaterThan(0.5);       // leans outward, +x
    expect(flank.z).toBeGreaterThan(0);         // still upward
    expect(Math.abs(flank.y)).toBeLessThan(0.1);
  });

  it('a point past the rim falls back to the nearest vertex rather than throwing', () => {
    expect(m.sample({ x: R + 50, y: 0 }).z).toBeCloseTo(0, 0);
  });
});

describe('buildMembrane on other contours', () => {
  it('puts the apex of a rectangle in its middle, at the asked height', () => {
    const rect = [{ x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 5000 }, { x: 0, y: 5000 }];
    const m = buildMembrane(rect, { heightMm: 3000, bulge: 1, resolution: 32 })!;
    let best = 0, at = { x: 0, y: 0 };
    for (let i = 0; i < m.z.length; i++) if (m.z[i] > best) { best = m.z[i]; at = m.pts[i]; }
    expect(best).toBeCloseTo(3000, -1);
    expect(Math.abs(at.x - 4000)).toBeLessThan(400);
    expect(Math.abs(at.y - 2500)).toBeLessThan(400);
    // Corners and the long edge's midpoint are boundary: zero.
    expect(m.sample({ x: 4000, y: 0 }).z).toBeLessThan(150);
  });

  it('handles a concave (L-shaped) base without a triangle across the notch', () => {
    const L = [
      { x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 },
      { x: 3000, y: 3000 }, { x: 3000, y: 6000 }, { x: 0, y: 6000 },
    ];
    const m = buildMembrane(L, { heightMm: 2000, bulge: 1, resolution: 30 })!;
    expect(m).not.toBeNull();
    // The point in the notch is outside the base — nearest-vertex fallback, near zero.
    expect(m.sample({ x: 4500, y: 4500 }).z).toBeLessThan(200);
    // Both arms are inflated.
    expect(m.sample({ x: 1500, y: 4500 }).z).toBeGreaterThan(800);
    expect(m.sample({ x: 4500, y: 1500 }).z).toBeGreaterThan(800);
  });

  it('refuses a degenerate contour', () => {
    expect(buildMembrane([{ x: 0, y: 0 }, { x: 1, y: 0 }], { heightMm: 1000, bulge: 1, resolution: 20 })).toBeNull();
    expect(buildMembrane([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0, y: 0.1 }], { heightMm: 1000, bulge: 1, resolution: 20 })).toBeNull();
  });
});
