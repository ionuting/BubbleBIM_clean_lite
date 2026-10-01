/**
 * What has to hold for hidden-line removal.
 *
 * The failures that would not look like failures: a line hidden by something
 * BEHIND it (depth sign flipped), a line eaten by the very surface it lies on
 * (epsilon too small), a hole in a face that does not let the line through.
 * Each has a test. The rest pins the cutting itself — a line crossing an
 * occluder's edge comes back in the right pieces, in the right places.
 */
import { describe, expect, it } from 'vitest';
import {
  DEPTH_EPS_MM, facePlaneFrom, faceDepthAt, hideOccluded, insideFace,
  type FacePlane, type HlrLine,
} from './hlr';

/** A face flat-on at one depth: a rectangle in (u, v). */
const flat = (u0: number, u1: number, v0: number, v1: number, depth: number, holes: [number, number, number, number][] = []): FacePlane =>
  facePlaneFrom([
    [{ u: u0, v: v0, depth }, { u: u1, v: v0, depth }, { u: u1, v: v1, depth }, { u: u0, v: v1, depth }],
    ...holes.map(([a, b, c, d]) => [
      { u: a, v: c, depth }, { u: b, v: c, depth }, { u: b, v: d, depth }, { u: a, v: d, depth },
    ]),
  ])!;

const line = (u0: number, v0: number, u1: number, v1: number, depthA: number, depthB = depthA): HlrLine =>
  ({ a: { u: u0, v: v0 }, b: { u: u1, v: v1 }, depthA, depthB });

const spans = (pieces: { a: { u: number }; b: { u: number } }[]) =>
  pieces.map((p) => [Math.round(p.a.u), Math.round(p.b.u)]).sort((x, y) => x[0] - y[0]);

describe('facePlaneFrom', () => {
  it('fits the depth plane of a slanted face', () => {
    // Depth rises 1000 over 2000 of u.
    const f = facePlaneFrom([[
      { u: 0, v: 0, depth: 500 }, { u: 2000, v: 0, depth: 1500 },
      { u: 2000, v: 1000, depth: 1500 }, { u: 0, v: 1000, depth: 500 },
    ]])!;
    expect(faceDepthAt(f, 0, 0)).toBeCloseTo(500, 6);
    expect(faceDepthAt(f, 1000, 500)).toBeCloseTo(1000, 6);
    expect(faceDepthAt(f, 2000, 1000)).toBeCloseTo(1500, 6);
  });

  it('refuses a face seen edge-on — it covers nothing', () => {
    expect(facePlaneFrom([[
      { u: 0, v: 0, depth: 0 }, { u: 1000, v: 0, depth: 500 }, { u: 2000, v: 0, depth: 1000 },
    ]])).toBeNull();
    expect(facePlaneFrom([[{ u: 0, v: 0, depth: 0 }, { u: 1, v: 1, depth: 0 }]])).toBeNull();
  });

  it('keeps the bounding box over every ring', () => {
    const f = flat(0, 1000, 0, 800, 100, [[200, 400, 200, 400]]);
    expect([f.uMin, f.uMax, f.vMin, f.vMax]).toEqual([0, 1000, 0, 800]);
  });
});

describe('insideFace', () => {
  const f = flat(0, 1000, 0, 1000, 100, [[300, 700, 300, 700]]);
  it('is true inside, false in the hole, false outside', () => {
    expect(insideFace(f, 100, 100)).toBe(true);
    expect(insideFace(f, 500, 500)).toBe(false); // the hole
    expect(insideFace(f, 1500, 500)).toBe(false);
  });
});

describe('hideOccluded', () => {
  it('leaves a line alone when nothing is in front of it', () => {
    const l = line(0, 500, 1000, 500, 2000);
    expect(hideOccluded([l], [])).toEqual([{ line: l, a: l.a, b: l.b }]);
    // A face at the same place but FURTHER away hides nothing.
    expect(spans(hideOccluded([l], [flat(-1000, 2000, 0, 1000, 5000)]))).toEqual([[0, 1000]]);
  });

  it('removes the covered middle and keeps both ends', () => {
    // A 3 m line at depth 2000, with a 1 m panel at depth 1000 across its middle.
    const pieces = hideOccluded([line(0, 500, 3000, 500, 2000)], [flat(1000, 2000, 0, 1000, 1000)]);
    expect(spans(pieces)).toEqual([[0, 1000], [2000, 3000]]);
  });

  it('removes the line entirely when it is covered end to end', () => {
    expect(hideOccluded([line(0, 500, 1000, 500, 2000)], [flat(-500, 1500, 0, 1000, 500)])).toHaveLength(0);
  });

  it('lets the line through a hole in the occluder', () => {
    const pieces = hideOccluded(
      [line(0, 500, 3000, 500, 2000)],
      [flat(0, 3000, 0, 1000, 1000, [[1000, 2000, 200, 800]])],
    );
    expect(spans(pieces)).toEqual([[1000, 2000]]);
  });

  it('does not let a surface eat the line lying on it', () => {
    // The outline of a wall is exactly as deep as the wall's own face there.
    const pieces = hideOccluded([line(0, 500, 1000, 500, 2000)], [flat(-500, 1500, 0, 1000, 2000)]);
    expect(spans(pieces)).toEqual([[0, 1000]]);
    // …and neither does a face flush with it, to within the epsilon.
    expect(spans(hideOccluded([line(0, 500, 1000, 500, 2000)], [flat(-500, 1500, 0, 1000, 2000 - DEPTH_EPS_MM / 2)])))
      .toEqual([[0, 1000]]);
    // A face a centimetre nearer is a different surface and does hide it.
    expect(hideOccluded([line(0, 500, 1000, 500, 2000)], [flat(-500, 1500, 0, 1000, 1990)])).toHaveLength(0);
  });

  it('cuts where a line passes from behind an occluder to in front of it', () => {
    // The line recedes from depth 0 to 2000 under a face at a flat 1000:
    // nearer than the face for the first half, behind it for the second.
    const pieces = hideOccluded([line(0, 500, 2000, 500, 0, 2000)], [flat(-500, 2500, 0, 1000, 1000)]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].a.u).toBeCloseTo(0, 6);
    expect(pieces[0].b.u).toBeCloseTo(1000, 0);
  });

  it('handles several occluders, overlapping', () => {
    const pieces = hideOccluded(
      [line(0, 500, 4000, 500, 3000)],
      [flat(500, 1500, 0, 1000, 1000), flat(1000, 2000, 0, 1000, 500), flat(3000, 3500, 0, 1000, 100)],
    );
    expect(spans(pieces)).toEqual([[0, 500], [2000, 3000], [3500, 4000]]);
  });

  it('drops slivers rather than emitting lines nobody can see', () => {
    // Two occluders leaving a 0.01 mm gap between them.
    const pieces = hideOccluded(
      [line(0, 500, 2000, 500, 3000)],
      [flat(-100, 1000, 0, 1000, 100), flat(1000.01, 2100, 0, 1000, 100)],
    );
    expect(pieces).toHaveLength(0);
  });

  it('keeps a vertical line and a slanted one, cut the same way', () => {
    const vertical = hideOccluded([{ a: { u: 500, v: 0 }, b: { u: 500, v: 3000 }, depthA: 2000, depthB: 2000 }], [flat(0, 1000, 1000, 2000, 500)]);
    expect(vertical.map((p) => [Math.round(p.a.v), Math.round(p.b.v)]).sort((x, y) => x[0] - y[0]))
      .toEqual([[0, 1000], [2000, 3000]]);
    const slanted = hideOccluded([line(0, 0, 2000, 2000, 2000)], [flat(800, 1200, 800, 1200, 500)]);
    expect(slanted).toHaveLength(2);
  });

  it('is not fooled by an occluder that only touches the line’s bounding box', () => {
    // The face is beside the line, not over it.
    expect(spans(hideOccluded([line(0, 500, 1000, 500, 2000)], [flat(900, 2000, 600, 1000, 100)])))
      .toEqual([[0, 1000]]);
  });
});
