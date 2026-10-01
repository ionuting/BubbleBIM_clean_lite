import { describe, expect, it } from 'vitest';
import {
  checkContour, createExtrusion, dedupe, effectiveHeight, ensureCCW, fanTriangles,
  moveSolid, orientedProfile, polygonArea, polygonCentroid, polygonPerimeter,
  rotateSolid, scaleSolid, selfIntersects, setHeight, signedArea2, solidBounds,
  solidQuantities, topElevation, withPlacement, worldProfile,
  type ExtrudedSolid, type Pt2,
} from './extrudedSolid';

const p = (x: number, y: number): Pt2 => ({ x, y });

/** A 4 × 6 m rectangle with its lower-left corner at (10, 20). */
const RECT = [p(10, 20), p(14, 20), p(14, 26), p(10, 26)];

function solid(over: Partial<ExtrudedSolid> = {}): ExtrudedSolid {
  const made = createExtrusion(RECT, { id: 'a', height: 3 });
  if (!made.ok) throw new Error('fixture contour rejected');
  return { ...made.solid, ...over };
}

/** Compare rings allowing for a different starting vertex. */
function ringsClose(a: Pt2[], b: Pt2[], tol = 1e-9): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (a.every((pt, i) => {
      const q = b[(i + k) % b.length];
      return Math.abs(pt.x - q.x) < tol && Math.abs(pt.y - q.y) < tol;
    })) return true;
  }
  return false;
}

describe('polygon maths', () => {
  it('measures area and perimeter of a rectangle', () => {
    expect(polygonArea(RECT)).toBeCloseTo(24, 9);
    expect(polygonPerimeter(RECT)).toBeCloseTo(20, 9);
  });

  it('signs the area by winding, which is how the winding is detected', () => {
    expect(signedArea2(RECT)).toBeGreaterThan(0);
    expect(signedArea2([...RECT].reverse())).toBeLessThan(0);
  });

  it('turns a clockwise ring counter-clockwise and leaves a CCW one alone', () => {
    const cw = [...RECT].reverse();
    expect(signedArea2(ensureCCW(cw))).toBeGreaterThan(0);
    expect(ensureCCW(RECT)).toBe(RECT);            // same reference: no copy when it need not
  });

  it('takes the AREA centroid, not the average of the corners', () => {
    // An extra vertex in the middle of one edge changes the vertex average but
    // not the shape — and so must not move the pivot the user rotates about.
    const withMidpoint = [p(10, 20), p(12, 20), p(14, 20), p(14, 26), p(10, 26)];
    const c1 = polygonCentroid(RECT);
    const c2 = polygonCentroid(withMidpoint);
    expect(c1.x).toBeCloseTo(12, 9);
    expect(c1.y).toBeCloseTo(23, 9);
    expect(c2.x).toBeCloseTo(c1.x, 9);
    expect(c2.y).toBeCloseTo(c1.y, 9);
  });

  it('falls back to the vertex average for a degenerate ring', () => {
    const line = [p(0, 0), p(2, 0), p(4, 0)];
    expect(polygonCentroid(line)).toEqual({ x: 2, y: 0 });
  });

  it('drops repeated points, including a closing point that repeats the first', () => {
    expect(dedupe([p(0, 0), p(0, 0), p(1, 0), p(1, 1), p(0, 0)])).toEqual([p(0, 0), p(1, 0), p(1, 1)]);
  });
});

describe('self-intersection', () => {
  it('passes a simple rectangle and an L', () => {
    expect(selfIntersects(RECT)).toBe(false);
    expect(selfIntersects([p(0, 0), p(4, 0), p(4, 2), p(2, 2), p(2, 4), p(0, 4)])).toBe(false);
  });

  it('catches a bowtie, which would extrude into inverted faces', () => {
    expect(selfIntersects([p(0, 0), p(4, 4), p(4, 0), p(0, 4)])).toBe(true);
  });

  it('does not mistake a shared endpoint for a crossing', () => {
    // Every consecutive pair touches; a triangle has nothing else.
    expect(selfIntersects([p(0, 0), p(3, 0), p(0, 4)])).toBe(false);
  });
});

describe('checkContour', () => {
  it('accepts a real contour and hands back a CCW ring', () => {
    const r = checkContour([...RECT].reverse());
    expect(r.ok).toBe(true);
    if (r.ok) expect(signedArea2(r.points)).toBeGreaterThan(0);
  });

  it('refuses the three ways a drawing can fail', () => {
    expect(checkContour([p(0, 0), p(1, 1)])).toEqual({ ok: false, reason: 'too-few' });
    expect(checkContour([p(0, 0), p(0.05, 0), p(0.05, 0.05)])).toEqual({ ok: false, reason: 'too-small' });
    expect(checkContour([p(0, 0), p(4, 4), p(4, 0), p(0, 4)])).toEqual({ ok: false, reason: 'self-intersecting' });
  });

  it('treats a double-clicked corner as one point rather than a failure', () => {
    const r = checkContour([p(0, 0), p(0, 0), p(4, 0), p(4, 3)]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.points).toHaveLength(3);
  });
});

describe('createExtrusion', () => {
  it('re-centres the profile on the centroid and keeps the shape where it was drawn', () => {
    const s = solid();
    // The stored profile is about the origin…
    const c = polygonCentroid(s.profile);
    expect(c.x).toBeCloseTo(0, 9);
    expect(c.y).toBeCloseTo(0, 9);
    // …the placement holds where that centroid is…
    expect(s.placement.x).toBeCloseTo(12, 9);
    expect(s.placement.y).toBeCloseTo(23, 9);
    // …and putting the two back together reproduces the drawn contour.
    expect(ringsClose(worldProfile(s), ensureCCW(RECT))).toBe(true);
  });

  it('starts unrotated and unscaled at the elevation it was drawn on', () => {
    const made = createExtrusion(RECT, { elevation: 12.5 });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const { placement } = made.solid;
    expect(placement).toMatchObject({ z: 12.5, rotation: 0, sx: 1, sy: 1, sz: 1 });
  });

  it('passes the contour problem through instead of inventing a solid', () => {
    expect(createExtrusion([p(0, 0), p(1, 0)])).toEqual({ ok: false, reason: 'too-few' });
  });

  it('gives every solid its own id', () => {
    const a = createExtrusion(RECT);
    const b = createExtrusion(RECT);
    expect(a.ok && b.ok && a.solid.id !== b.solid.id).toBe(true);
  });
});

describe('parametric edits', () => {
  it('never mutates the solid it is given', () => {
    const s = solid();
    const before = JSON.stringify(s);
    moveSolid(s, 5, 5, 5);
    rotateSolid(s, 90);
    scaleSolid(s, 2);
    setHeight(s, 9);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('moves the footprint by exactly the offset', () => {
    const s = moveSolid(solid(), 5, -3, 2);
    expect(s.placement.z).toBe(2);
    const moved = worldProfile(s);
    const original = worldProfile(solid());
    moved.forEach((q, i) => {
      expect(q.x).toBeCloseTo(original[i].x + 5, 9);
      expect(q.y).toBeCloseTo(original[i].y - 3, 9);
    });
  });

  it('rotates about the centroid, so the solid stays put while it turns', () => {
    const s = rotateSolid(solid(), 90);
    expect(s.placement.x).toBeCloseTo(12, 9);
    expect(s.placement.y).toBeCloseTo(23, 9);
    // A 4 × 6 rectangle turned a quarter turn is 6 × 4 in the same place.
    const b = solidBounds(s);
    expect(b.maxX - b.minX).toBeCloseTo(6, 9);
    expect(b.maxY - b.minY).toBeCloseTo(4, 9);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(12, 9);
  });

  it('turns counter-clockwise, the direction the frame implies', () => {
    const one = createExtrusion([p(0, 0), p(2, 0), p(2, 1), p(0, 1)]);
    if (!one.ok) throw new Error('fixture rejected');
    const turned = orientedProfile(rotateSolid(one.solid, 90));
    // +x must swing onto +y. The corner that was furthest along +x is now
    // furthest along +y.
    const far = turned.reduce((m, q) => (q.y > m.y ? q : m), turned[0]);
    expect(far.y).toBeGreaterThan(0.9);
  });

  it('keeps the rotation inside one turn', () => {
    expect(rotateSolid(solid(), 450).placement.rotation).toBeCloseTo(90, 9);
    expect(rotateSolid(solid(), -90).placement.rotation).toBeCloseTo(270, 9);
  });

  it('scales about the centroid and multiplies, so two doublings are a quadrupling', () => {
    const s = scaleSolid(scaleSolid(solid(), 2), 2);
    expect(s.placement.sx).toBeCloseTo(4, 9);
    const b = solidBounds(s);
    expect(b.maxX - b.minX).toBeCloseTo(16, 9);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(12, 9);   // still centred where it was
  });

  it('refuses to collapse or mirror a solid through its scale', () => {
    expect(withPlacement(solid(), { sx: 0 }).placement.sx).toBeGreaterThan(0);
    expect(withPlacement(solid(), { sy: -2 }).placement.sy).toBeGreaterThan(0);
    expect(setHeight(solid(), -5).height).toBeGreaterThan(0);
  });

  it('stretches the height through sz without touching the drawn height', () => {
    const s = withPlacement(setHeight(solid(), 3), { sz: 2 });
    expect(s.height).toBe(3);
    expect(effectiveHeight(s)).toBeCloseTo(6, 9);
    expect(topElevation(s)).toBeCloseTo(6, 9);
  });

  it('measures the top from the elevation it stands on', () => {
    const s = withPlacement(setHeight(solid(), 4), { z: 10 });
    expect(topElevation(s)).toBeCloseTo(14, 9);
  });
});

describe('quantities', () => {
  it('measures the solid as drawn', () => {
    const q = solidQuantities(setHeight(solid(), 3));
    expect(q.areaM2).toBeCloseTo(24, 9);
    expect(q.perimeterM).toBeCloseTo(20, 9);
    expect(q.heightM).toBeCloseTo(3, 9);
    expect(q.volumeM3).toBeCloseTo(72, 9);
    expect(q.lateralAreaM2).toBeCloseTo(60, 9);
  });

  it('follows the scale, because that is what would be built', () => {
    const q = solidQuantities(withPlacement(setHeight(solid(), 3), { sx: 2, sy: 2, sz: 2 }));
    expect(q.areaM2).toBeCloseTo(96, 9);      // 4× in plan
    expect(q.volumeM3).toBeCloseTo(576, 9);   // 8× in all
  });

  it('is unchanged by rotation, which moves a shape without resizing it', () => {
    const a = solidQuantities(solid());
    const b = solidQuantities(rotateSolid(solid(), 37));
    expect(b.areaM2).toBeCloseTo(a.areaM2, 9);
    expect(b.perimeterM).toBeCloseTo(a.perimeterM, 9);
  });
});

describe('fanTriangles', () => {
  it('covers the ring once, with no triangle for a degenerate one', () => {
    expect(fanTriangles(RECT)).toEqual([[0, 1, 2], [0, 2, 3]]);
    expect(fanTriangles([p(0, 0), p(1, 0), p(0, 1)])).toEqual([[0, 1, 2]]);
    expect(fanTriangles([p(0, 0), p(1, 0)])).toEqual([]);
  });

  it('triangulates the area it claims to', () => {
    const ring = [p(0, 0), p(4, 0), p(4, 3), p(0, 3)];
    const total = fanTriangles(ring).reduce((sum, [a, b, c]) =>
      sum + Math.abs(signedArea2([ring[a], ring[b], ring[c]])) / 2, 0);
    expect(total).toBeCloseTo(polygonArea(ring), 9);
  });
});
