import { describe, expect, it } from 'vitest';
import { isSimplePolygon, polygonArea } from '@/lib/geom/plan2d';
import { flightProfile, invertedTeeProfile } from './profile';

// The worked example the rest of the suite uses: 2900 mm rise → 17 × 170.6.
const N = 17, H = 2900 / 17, G = 280, T = 150;
const DROP = (T * Math.hypot(G, H)) / G;

describe('flightProfile', () => {
  const prof = flightProfile(N, H, G, T)!;

  it('is a simple CCW polygon', () => {
    expect(isSimplePolygon(prof)).toBe(true);
    expect(polygonArea(prof)).toBeGreaterThan(0);
  });

  it('never traverses the same vertical line twice — the blade-fin bug', () => {
    // The old shape climbed the full last riser and came straight back down the
    // same line: a zero-width spike that extruded into a thin blade sticking
    // out of the top of every flight. No two consecutive edges may fold back.
    for (let i = 0; i < prof.length; i++) {
      const a = prof[i], b = prof[(i + 1) % prof.length], c = prof[(i + 2) % prof.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      expect(Math.abs(cross) > 1e-9 || dot > 0, `fold-back at point ${i}`).toBe(true);
    }
  });

  it('stops one slab short of the arrival: the landing edge is the last riser', () => {
    // The profile's high point is a slab-thickness below n·h. The landing's own
    // edge face provides the visible riser above it — flight 150 + landing top
    // sliver = one full riser, the way a monolithic junction reads in section.
    const ys = prof.map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo(N * H - T, 6);
  });

  it('runs a tail of waist under the landing until the soffits meet', () => {
    // Beyond the last riser plane at (n−1)·g, the tail's top is flat at the
    // landing underside and its end is where the soffit line reaches it.
    const tailS = (G * (N * H - T + DROP)) / H;
    const xs = prof.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(tailS, 6);
    expect(tailS).toBeGreaterThan((N - 1) * G);
  });

  it('has one riser and one tread per step on its upper edge', () => {
    // 1 start + 2(n−1) sawtooth + head sliver + tail + foot cut.
    expect(prof).toHaveLength(2 * N + 2);
  });

  it('starts the climb at the walking-line origin', () => {
    expect(prof.some((p) => p.x === 0 && p.y === 0)).toBe(true);
  });

  it('measures the waist perpendicular to the soffit, not vertically', () => {
    // The soffit's two corners give its line; the internal-corner line is
    // z = (h/g)·s through the origin. Perpendicular distance must be the waist.
    const soffit = prof.filter((p) => p.y < (H / G) * p.x - 1e-9);
    expect(soffit).toHaveLength(2);
    const [a, b] = soffit;
    const slope = (b.y - a.y) / (b.x - a.x);
    expect(slope).toBeCloseTo(H / G, 6);
    const vertical = (H / G) * a.x - a.y;
    expect(vertical * (G / Math.hypot(G, H))).toBeCloseTo(T, 6);
    // Both near-misses would read thinner here: measuring vertically, and
    // measuring from the nosing line one riser up. This is what they corrupt.
    expect(vertical).toBeGreaterThan(T);
  });

  it('sits on its floor when it starts from the ground', () => {
    expect(Math.min(...prof.map((p) => p.y))).toBeCloseTo(0, 6);
  });

  it('carries its full last riser at a top-floor arrival', () => {
    // Nothing covers the flight at the top of the stair — no landing edge to
    // provide the riser face. With headDrop 0 the flight rises the whole way
    // itself and ends with a short square nib, not a sliver-and-plateau 150 mm
    // short of the floor.
    const top = flightProfile(N, H, G, T, { headDropMm: 0, tailMm: 50 })!;
    expect(isSimplePolygon(top)).toBe(true);
    const ys = top.map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo(N * H, 6);
    // The nib: exactly 50 beyond the last riser plane, with a real back face.
    const xs = top.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo((N - 1) * G + 50, 6);
    const back = top.filter((p) => Math.abs(p.x - ((N - 1) * G + 50)) < 1e-6);
    expect(back).toHaveLength(2);
    expect(Math.abs(back[0].y - back[1].y)).toBeGreaterThan(1);
  });

  it('drops its foot to the landing underside when it springs from one', () => {
    // An upper flight mates into the landing: front face down to −T, flush with
    // the landing's side face, so soffit and landing underside read as one cast.
    const upper = flightProfile(N, H, G, T, { footDropMm: T })!;
    expect(isSimplePolygon(upper)).toBe(true);
    expect(Math.min(...upper.map((p) => p.y))).toBeCloseTo(-T, 6);
    expect(upper.some((p) => p.x === 0 && Math.abs(p.y + T) < 1e-6)).toBe(true);
  });

  it('gets thicker vertically as the stair steepens, for the same waist', () => {
    const shallow = flightProfile(10, 150, 300, T)!;
    const steep = flightProfile(10, 200, 250, T)!;
    const verticalOf = (pts: typeof shallow, h: number, g: number) => {
      const s = pts.filter((p) => p.y < (h / g) * p.x - 1e-9)[0];
      return (h / g) * s.x - s.y;
    };
    expect(verticalOf(steep, 200, 250)).toBeGreaterThan(verticalOf(shallow, 150, 300));
  });

  it('refuses a flight with no run', () => {
    expect(flightProfile(1, H, G, T)).toBeNull();
    expect(flightProfile(0, H, G, T)).toBeNull();
  });

  it('handles the shortest real flight', () => {
    const p = flightProfile(2, H, G, T)!;
    expect(isSimplePolygon(p)).toBe(true);
    expect(Math.max(...p.map((q) => q.y))).toBeCloseTo(2 * H - T, 6);
  });
});

describe('invertedTeeProfile', () => {
  const tee = invertedTeeProfile(300, 600, 150, 400)!;

  it('is a simple polygon with the eight corners of a T', () => {
    expect(isSimplePolygon(tee)).toBe(true);
    expect(tee).toHaveLength(8);
    expect(polygonArea(tee)).not.toBe(0);
  });

  it('is the right way up: wide at the bottom, web topping at floor level', () => {
    const bottom = tee.filter((p) => p.y === -400);
    const top = tee.filter((p) => p.y === 0);
    expect(Math.max(...bottom.map((p) => p.x)) - Math.min(...bottom.map((p) => p.x))).toBe(600);
    expect(Math.max(...top.map((p) => p.x)) - Math.min(...top.map((p) => p.x))).toBe(300);
    expect(Math.max(...tee.map((p) => p.y))).toBe(0);
  });

  it('has the section area the quantities compute', () => {
    // flange 600×150 + web 300×250 — the same formula measureStair uses.
    expect(Math.abs(polygonArea(tee))).toBeCloseTo(600 * 150 + 300 * 250, 6);
  });

  it('is centred on the first riser plane', () => {
    const xs = tee.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(-Math.min(...xs), 6);
  });

  it('degrades to a rectangle when the flange is no wider than the web', () => {
    const rect = invertedTeeProfile(300, 300, 150, 400)!;
    expect(rect).toHaveLength(4);
    expect(isSimplePolygon(rect)).toBe(true);
  });

  it('refuses a depth that leaves no web at all', () => {
    expect(invertedTeeProfile(300, 600, 150, 150)).toBeNull();
    expect(invertedTeeProfile(300, 600, 150, 100)).toBeNull();
  });
});
