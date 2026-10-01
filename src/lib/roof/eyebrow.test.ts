/**
 * The eyebrow on a plain 40° slope, 10 m along the eave: every part a closed,
 * outward-facing solid; the bump as high as asked at the front and gone at the
 * back; the window under the hood with a frame's width to spare.
 */
import { describe, expect, it } from 'vitest';
import type { RoofFace3D } from './types';
import { eyebrowEdge, placeEyebrow, solidVolume, type Tri } from './eyebrow';

const tan = Math.tan((40 * Math.PI) / 180);
const face: RoofFace3D = {
  id: 'south', role: 'slope',
  vertices: [
    { x: 0, y: 0, z: 3000 }, { x: 10000, y: 0, z: 3000 },
    { x: 10000, y: 5000, z: 3000 + 5000 * tan }, { x: 0, y: 5000, z: 3000 + 5000 * tan },
  ],
};
const intent = { planX: 5000, planY: 1200, widthMm: 1400, riseMm: 900, flareMm: 900, depthMm: 1800, coveringThicknessMm: 40 };
const g = placeEyebrow([face], intent)!;

/** Every edge used exactly twice, once each way: a closed, consistently wound solid. */
function closed(tris: Tri[]): boolean {
  const key = (p: { x: number; y: number; z: number }) => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`;
  const count = new Map<string, number>();
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      const k = `${key(t[i])}>${key(t[(i + 1) % 3])}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of count) {
    const [a, b] = k.split('>');
    if (n !== 1 || count.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

describe('the eyebrow dormer', () => {
  it('fits the slope', () => {
    expect(g.ok).toBe(true);
    expect(g.diagnostics).toEqual([]);
  });

  it('builds three closed solids, every face pointing out', () => {
    for (const part of [g.hood, g.soffit, g.tympanum, g.glass]) {
      expect(part.length).toBeGreaterThan(0);
      expect(closed(part)).toBe(true);
      expect(solidVolume(part)).toBeGreaterThan(0);
    }
  });

  it('lifts the covering by the rise at the front, and not at all at the back', () => {
    const zs = g.hood.flatMap((t) => t.map((p) => p.z));
    const roofFront = 3000 + 1200 * tan + 40;
    expect(Math.max(...zs)).toBeGreaterThan(roofFront + 900 - 1);
    // At the back line, the top of the hood is the roof again.
    const back = g.hood.flatMap((t) => t).filter((p) => Math.abs(p.y - (1200 + 1800)) < 1e-6);
    expect(Math.max(...back.map((p) => p.z))).toBeCloseTo(3000 + 3000 * tan + 40 + 10, 3);
  });

  it('cuts a half-elliptic window a frame below the hood', () => {
    expect(g.window.widthMm).toBe(1400);
    expect(g.window.heightMm).toBeGreaterThan(400);
    const half = 700 + 900;
    const base = 3000 + 1200 * tan + 40;
    for (const p of g.glass.flatMap((t) => t)) {
      const u = p.x - 5000;
      expect(p.z - base).toBeLessThanOrEqual(eyebrowEdge(u, half, 900) - 140 - 80 + 1e-6);
    }
  });

  it('opens the slope under the hood, and the hood covers the opening on every side', () => {
    const n = g.notch;
    // Only where the hood stands a hood's thickness plus 60 mm clear of the roof.
    const clear = 60 + 2 * 40 + 60;
    expect(eyebrowEdge(n.widthMm / 2, 700 + 900, 900)).toBeCloseTo(clear, 6);
    expect(n.widthMm).toBeGreaterThan(1400);          // wider than the window
    expect(n.depthMm).toBeGreaterThan(900);
    expect(n.depthMm).toBeLessThan(1800);
    // Every edge of the notch lies under the hood's underside, down into the roof.
    const hoodBottom = Math.min(...g.hood.flatMap((t) => t.map((p) => p.z)));
    expect(hoodBottom).toBeLessThan(3000 + 1200 * tan);
    // The tympanum's foot goes below the covering the notch cuts.
    const foot = Math.min(...g.tympanum.flatMap((t) => t.map((p) => p.z)));
    expect(foot).toBeLessThan(3000 + 1200 * tan - 40);
  });

  it('lines the underside of the lip', () => {
    const ys = g.soffit.flatMap((t) => t.map((p) => p.y));
    expect(Math.min(...ys)).toBeCloseTo(1200 - 250, 6);   // out to the lip's edge
    expect(Math.max(...ys)).toBeCloseTo(1200, 6);         // back to the tympanum
  });

  it('refuses a spot too close to the edge of the slope', () => {
    const edge = placeEyebrow([face], { ...intent, planX: 1000 })!;
    expect(edge.ok).toBe(false);
  });
});
