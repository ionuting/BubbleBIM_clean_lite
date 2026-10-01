/**
 * The NURBS core, against answers that do not depend on it: a curve through
 * points passes through them; a rational quadratic is an exact circle, so its
 * length is πr/2 and every point sits at radius r; tessellation keeps to its
 * tolerance; stations along the curve are evenly spaced by arc length.
 */
import { describe, expect, it } from 'vitest';
import {
  arcLength, bsplineFromControl, divideEvenly, domain, evaluate, evaluateWithTangent,
  interpolateClosed, interpolateOpen, periodicFromControl, stationsAt, tessellate, type Nurbs2,
} from './nurbs';

const R = 1000;
/** A quarter circle of radius R, exact: rational quadratic, middle weight √2/2. */
const QUARTER: Nurbs2 = {
  degree: 2,
  points: [{ x: R, y: 0 }, { x: R, y: R }, { x: 0, y: R }],
  weights: [1, Math.SQRT1_2, 1],
  knots: [0, 0, 0, 1, 1, 1],
};

describe('evaluation', () => {
  it('a rational quadratic is an exact circle', () => {
    for (let i = 0; i <= 20; i++) {
      const p = evaluate(QUARTER, i / 20);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(R, 9);
    }
  });

  it('the tangent is the derivative', () => {
    const c = interpolateOpen([{ x: 0, y: 0 }, { x: 1000, y: 800 }, { x: 2500, y: -300 }, { x: 4000, y: 500 }])!;
    const [u0, u1] = domain(c);
    const u = u0 + (u1 - u0) * 0.37, h = 1e-6;
    const a = evaluate(c, u - h), b = evaluate(c, u + h);
    const t = evaluateWithTangent(c, u).tangent;
    expect(t.x).toBeCloseTo((b.x - a.x) / (2 * h), 2);
    expect(t.y).toBeCloseTo((b.y - a.y) / (2 * h), 2);
  });

  it('a straight control polygon is a straight curve', () => {
    const c = bsplineFromControl([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 2000, y: 0 }, { x: 3000, y: 0 }])!;
    for (let i = 0; i <= 10; i++) expect(evaluate(c, i / 10).y).toBeCloseTo(0, 9);
    expect(arcLength(c)).toBeCloseTo(3000, 6);
  });
});

describe('interpolation', () => {
  const fit = [{ x: 0, y: 0 }, { x: 1200, y: 900 }, { x: 2600, y: -400 }, { x: 4100, y: 600 }, { x: 5000, y: 0 }];

  it('passes through every point of an open run', () => {
    const c = interpolateOpen(fit)!;
    const pts = tessellate(c, 0.01);
    // Distance to the tessellated curve — its segments, not just its vertices.
    const toSeg = (q: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2)) : 0;
      return Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t));
    };
    for (const q of fit) {
      let d = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, toSeg(q, pts[i], pts[i + 1]));
      expect(d).toBeLessThan(0.02);
    }
    expect(evaluate(c, 0)).toEqual(expect.objectContaining({ x: expect.closeTo(0, 9), y: expect.closeTo(0, 9) }));
  });

  it('closes smoothly through every point of a loop', () => {
    const loop = [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 2000 }, { x: 0, y: 2000 }];
    const c = interpolateClosed(loop)!;
    expect(c.periodic).toBe(true);
    const [u0, u1] = domain(c);
    // Station k at u0 + k, and the loop ends where it began with the same tangent.
    loop.forEach((q, k) => {
      const p = evaluate(c, u0 + k);
      expect(p.x).toBeCloseTo(q.x, 6);
      expect(p.y).toBeCloseTo(q.y, 6);
    });
    const a = evaluateWithTangent(c, u0), b = evaluateWithTangent(c, u1);
    expect(b.point.x).toBeCloseTo(a.point.x, 6);
    expect(b.tangent.x).toBeCloseTo(a.tangent.x, 6);
    expect(b.tangent.y).toBeCloseTo(a.tangent.y, 6);
  });

  it('a closed control polygon is a periodic curve inside it', () => {
    const c = periodicFromControl([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }])!;
    const pts = tessellate(c, 0.5);
    expect(pts.every((p) => p.x > 0 && p.x < 1000 && p.y > 0 && p.y < 1000)).toBe(true);
  });
});

describe('measuring', () => {
  it('integrates the exact length of a quarter circle', () => {
    expect(arcLength(QUARTER)).toBeCloseTo((Math.PI * R) / 2, 6);
  });

  it('tessellates within the chord tolerance', () => {
    for (const tol of [5, 0.5, 0.05]) {
      const pts = tessellate(QUARTER, tol);
      for (let i = 0; i + 1 < pts.length; i++) {
        const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
        // Sagitta of the chord against the true circle.
        expect(R - Math.hypot(m.x, m.y)).toBeLessThanOrEqual(tol * 1.0001);
      }
    }
  });

  it('places stations evenly by arc length, with unit tangents', () => {
    const st = divideEvenly(QUARTER, 5);
    const L = (Math.PI * R) / 2;
    st.forEach((s, i) => {
      expect(s.s).toBeCloseTo((L * i) / 4, 6);
      const ang = Math.atan2(s.point.y, s.point.x);
      expect(ang).toBeCloseTo((Math.PI / 2) * (i / 4), 6);
      expect(Math.hypot(s.tangent.x, s.tangent.y)).toBeCloseTo(1, 9);
    });
    expect(stationsAt(QUARTER, [L * 2])[0].s).toBeCloseTo(L, 9);
  });
});
