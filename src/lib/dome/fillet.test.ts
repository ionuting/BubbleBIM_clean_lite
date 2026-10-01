/**
 * A fillet is right when the arc is tangent to both edges and has the radius
 * asked for — so that is what is measured, rather than comparing vertex
 * lists. The clamp is the other half: a radius larger than the shape can
 * give must degrade smoothly, never fold the polygon inside out.
 */
import { describe, expect, it } from 'vitest';
import { filletPolygon } from './fillet';
import { pointInPolygon, polygonArea, isSimplePolygon, type Pt2 } from '@/lib/geom/plan2d';

const square: Pt2[] = [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 10000 }, { x: 0, y: 10000 }];
const area = (p: Pt2[]) => Math.abs(polygonArea(p));

/** Distance from `c` to the nearest point of the polygon's outline. */
function distToOutline(c: Pt2, poly: Pt2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(c.x - (a.x + dx * t), c.y - (a.y + dy * t)));
  }
  return best;
}

describe('filletPolygon', () => {
  it('leaves the polygon alone for a non-positive radius', () => {
    expect(filletPolygon(square, 0)).toBe(square);
    expect(filletPolygon(square, -100)).toBe(square);
    expect(filletPolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }], 100)).toHaveLength(2);
  });

  it('rounds a square corner with the exact radius, tangent to both edges', () => {
    const r = 1000;
    const out = filletPolygon(square, r);
    // The corner at the origin: its arc centre must be at (r, r).
    expect(distToOutline({ x: r, y: r }, out)).toBeCloseTo(r, 0);
    // Tangency: the arc must touch each edge exactly at distance r along it.
    expect(out.some((p) => Math.abs(p.x - 0) < 1 && Math.abs(p.y - r) < 1)).toBe(true);
    expect(out.some((p) => Math.abs(p.y - 0) < 1 && Math.abs(p.x - r) < 1)).toBe(true);
    // Nothing sticks out past the original edges.
    for (const p of out) {
      expect(p.x).toBeGreaterThanOrEqual(-0.5);
      expect(p.y).toBeGreaterThanOrEqual(-0.5);
      expect(p.x).toBeLessThanOrEqual(10000.5);
    }
  });

  it('removes the four corner offcuts from the area', () => {
    const r = 1000;
    const lost = 4 * (r * r - (Math.PI * r * r) / 4);   // square corner minus quarter disc
    const want = area(square) - lost;
    // Not exact: the arc ships as chords, which sit inside the true arc. The
    // shortfall is the faceting and nothing else, so it is bounded relatively
    // rather than absolutely.
    expect(Math.abs(area(filletPolygon(square, r)) - want) / want).toBeLessThan(1e-4);
  });

  it('keeps winding, simplicity, and every point inside the original', () => {
    for (const r of [200, 1000, 4000]) {
      const out = filletPolygon(square, r);
      expect(polygonArea(out), `r=${r}`).toBeGreaterThan(0);
      expect(isSimplePolygon(out), `r=${r}`).toBe(true);
      for (const p of out) expect(pointInPolygon(p, square, 1), `r=${r}`).toBe(true);
    }
  });

  it('preserves clockwise input as clockwise', () => {
    const cw = [...square].reverse();
    expect(polygonArea(filletPolygon(cw, 800))).toBeLessThan(0);
  });

  it('clamps to half the edge — a radius past the shape rounds it to a circle-ish blob', () => {
    // Asking for 50 m on a 10 m square: every corner takes the most it can,
    // which is half of each edge, leaving no straight run at all.
    const out = filletPolygon(square, 50000);
    expect(isSimplePolygon(out)).toBe(true);
    expect(polygonArea(out)).toBeGreaterThan(0);
    expect(area(out)).toBeGreaterThan(0.7 * area(square));
    expect(area(out)).toBeLessThan(area(square));
    // Close to the inscribed disc of radius 5000.
    expect(area(out)).toBeCloseTo(Math.PI * 5000 * 5000, -7);
  });

  it('two adjacent fillets meet without overlapping', () => {
    // A 10 m square with r = 5000 puts both tangent points at each edge's
    // midpoint: the arcs touch and the straight run vanishes, but no arc may
    // cross into its neighbour.
    const out = filletPolygon(square, 5000);
    expect(isSimplePolygon(out)).toBe(true);
    for (const p of out) expect(pointInPolygon(p, square, 1)).toBe(true);
  });

  it('rounds a reflex corner outward, keeping the polygon simple', () => {
    const L: Pt2[] = [
      { x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 },
      { x: 3000, y: 3000 }, { x: 3000, y: 6000 }, { x: 0, y: 6000 },
    ];
    const out = filletPolygon(L, 600);
    expect(isSimplePolygon(out)).toBe(true);
    expect(polygonArea(out)).toBeGreaterThan(0);
    // The reflex vertex at (3000, 3000) is replaced by an arc that bulges
    // INTO the polygon's material, so the area there grows rather than shrinks.
    expect(out.some((p) => Math.hypot(p.x - 3000, p.y - 3000) < 1)).toBe(false);
    const c = { x: 3600, y: 3600 };                 // centre of the reflex arc
    expect(distToOutline(c, out)).toBeCloseTo(600, 0);
  });

  it('leaves a straight-through vertex untouched', () => {
    const withMid: Pt2[] = [
      { x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 10000, y: 0 },
      { x: 10000, y: 10000 }, { x: 0, y: 10000 },
    ];
    const out = filletPolygon(withMid, 500);
    expect(out.some((p) => Math.abs(p.x - 5000) < 1 && Math.abs(p.y) < 1)).toBe(true);
  });

  it('a filleted circle is still that circle', () => {
    const circle = Array.from({ length: 64 }, (_, i) => ({
      x: 5000 * Math.cos((i / 64) * Math.PI * 2), y: 5000 * Math.sin((i / 64) * Math.PI * 2),
    }));
    // Each corner turns by only ~5.6°, so the clamp leaves the shape alone.
    expect(area(filletPolygon(circle, 300)) / area(circle)).toBeGreaterThan(0.99);
  });
});
