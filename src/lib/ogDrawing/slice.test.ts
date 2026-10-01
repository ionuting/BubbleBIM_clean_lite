/**
 * What has to hold for a cut to be a cut.
 *
 * These are pure geometry — no kernel, no React — because the failures they
 * guard against are silent. A loop that does not close draws as a few stray
 * strokes that still look like linework; a hole classified as an outline
 * fills the doorway solid; a doubled edge from a coplanar face looks right
 * until the walk closes nothing and the wall vanishes. None of those raise.
 */
import { describe, expect, it } from 'vitest';
import { planFrame, frameFromCut, projectPt, roleOf, type Vec3 } from './frame';
import { chainLoops, faceNormal, sliceEntity, sliceFace, type FaceLike } from './slice';
import { penColor } from './project';

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255) as [number, number, number];
};
const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The six faces of an axis-aligned box, BIM mm. */
function boxFaces(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): FaceLike[] {
  const p = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
  return [
    { ring: [p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0)], holes: [] }, // bottom
    { ring: [p(x0, y0, z1), p(x0, y1, z1), p(x1, y1, z1), p(x1, y0, z1)], holes: [] }, // top
    { ring: [p(x0, y0, z0), p(x0, y0, z1), p(x1, y0, z1), p(x1, y0, z0)], holes: [] }, // south
    { ring: [p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)], holes: [] }, // north
    { ring: [p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), p(x0, y0, z1)], holes: [] }, // west
    { ring: [p(x1, y0, z0), p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0)], holes: [] }, // east
  ];
}

const uRange = (pts: { u: number; v: number }[]) => ({
  min: Math.min(...pts.map((p) => p.u)), max: Math.max(...pts.map((p) => p.u)),
});
const vRange = (pts: { u: number; v: number }[]) => ({
  min: Math.min(...pts.map((p) => p.v)), max: Math.max(...pts.map((p) => p.v)),
});

// A wall 250 thick running east 4000, 3000 tall, at y = 0.
const WALL = boxFaces(0, 0, 0, 4000, 250, 3000);

describe('sliceFace', () => {
  it('cuts a face that crosses the plane, and leaves alone one that does not', () => {
    const plane = { point: { x: 0, y: 0, z: 1200 }, normal: { x: 0, y: 0, z: -1 } };
    const south = WALL[2];                        // vertical, crosses z = 1200
    const bottom = WALL[0];                       // horizontal at z = 0
    expect(sliceFace(south, plane.point, plane.normal)).toHaveLength(1);
    expect(sliceFace(bottom, plane.point, plane.normal)).toHaveLength(0);
  });

  it('skips a face lying IN the plane, which would otherwise double every edge', () => {
    // The wall's own bottom face, cut at exactly z = 0.
    const plane = { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: -1 } };
    expect(sliceFace(WALL[0], plane.point, plane.normal)).toHaveLength(0);
  });

  it('pairs crossings even-odd, so a face with a hole cuts either side of it', () => {
    // A tall south face with a window opening 1000..2000 in x, 900..2100 in z.
    const face: FaceLike = {
      ring: [
        { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3000 },
        { x: 4000, y: 0, z: 3000 }, { x: 4000, y: 0, z: 0 },
      ],
      holes: [[
        { x: 1000, y: 0, z: 900 }, { x: 2000, y: 0, z: 900 },
        { x: 2000, y: 0, z: 2100 }, { x: 1000, y: 0, z: 2100 },
      ]],
    };
    const segs = sliceFace(face, { x: 0, y: 0, z: 1200 }, { x: 0, y: 0, z: -1 });
    expect(segs).toHaveLength(2);
    const spans = segs.map((s) => [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x)]).sort((a, b) => a[0] - b[0]);
    expect(spans[0][0]).toBeCloseTo(0, 6);
    expect(spans[0][1]).toBeCloseTo(1000, 6);
    expect(spans[1][0]).toBeCloseTo(2000, 6);
    expect(spans[1][1]).toBeCloseTo(4000, 6);
  });

  it('counts a vertex sitting on the plane once, keeping the crossings even', () => {
    // A triangle with its apex exactly on the cut.
    const tri: FaceLike = {
      ring: [{ x: 0, y: 0, z: 0 }, { x: 2000, y: 0, z: 0 }, { x: 1000, y: 0, z: 1200 }],
      holes: [],
    };
    const segs = sliceFace(tri, { x: 0, y: 0, z: 1200 }, { x: 0, y: 0, z: -1 });
    // Either nothing or one degenerate touch — never an odd count that would
    // pair the apex with some unrelated crossing on another face.
    expect(segs.length % 2).toBe(0);
  });
});

describe('faceNormal', () => {
  it('survives three collinear corners, which a cross product of the first three does not', () => {
    const ring: Vec3[] = [
      { x: 0, y: 0, z: 0 }, { x: 500, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 },
      { x: 1000, y: 0, z: 1000 }, { x: 0, y: 0, z: 1000 },
    ];
    const n = faceNormal(ring);
    expect(n).not.toBeNull();
    expect(Math.abs(n!.y)).toBeCloseTo(1, 6);
  });

  it('is null for a degenerate ring rather than a NaN direction', () => {
    expect(faceNormal([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }])).toBeNull();
  });
});

describe('chainLoops', () => {
  it('closes a square from four segments given in scrambled order and direction', () => {
    const P = (x: number, y: number): Vec3 => ({ x, y, z: 0 });
    const loops = chainLoops([
      { a: P(0, 0), b: P(10, 0) },
      { a: P(10, 10), b: P(10, 0) },   // reversed on purpose
      { a: P(0, 10), b: P(10, 10) },
      { a: P(0, 0), b: P(0, 10) },
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
  });

  it('separates two disjoint squares instead of joining them into one', () => {
    const P = (x: number, y: number): Vec3 => ({ x, y, z: 0 });
    const square = (ox: number) => [
      { a: P(ox, 0), b: P(ox + 10, 0) },
      { a: P(ox + 10, 0), b: P(ox + 10, 10) },
      { a: P(ox + 10, 10), b: P(ox, 10) },
      { a: P(ox, 10), b: P(ox, 0) },
    ];
    expect(chainLoops([...square(0), ...square(100)])).toHaveLength(2);
  });

  it('welds ends that agree only to within a micron', () => {
    const P = (x: number, y: number): Vec3 => ({ x, y, z: 0 });
    const loops = chainLoops([
      { a: P(0, 0), b: P(10, 0) },
      { a: P(10.000_001, 0), b: P(10, 10) },
      { a: P(10, 10), b: P(0, 10) },
      { a: P(0, 10), b: P(0, 0) },
    ]);
    expect(loops).toHaveLength(1);
  });
});

describe('sliceEntity — a plan cut', () => {
  const frame = planFrame({ cutZmm: 1200, elevMin: 0, elevMax: 3000 });
  const plane = { point: { x: 0, y: 0, z: 1200 }, normal: { x: 0, y: 0, z: -1 } };

  it('cuts a wall into its footprint at the cut height', () => {
    const loops = sliceEntity(WALL, frame, plane.point, plane.normal);
    expect(loops).toHaveLength(1);
    expect(loops[0].isHole).toBe(false);
    expect(uRange(loops[0].pts)).toEqual({ min: 0, max: 4000 });
    expect(vRange(loops[0].pts)).toEqual({ min: 0, max: 250 });
  });

  it('gives a plan u = BIM east and v = BIM north, not a mirrored pair', () => {
    // A marker box far east and far north must land top-right, not anywhere else.
    const corner = boxFaces(9000, 7000, 0, 9100, 7100, 3000);
    const [loop] = sliceEntity(corner, frame, plane.point, plane.normal);
    expect(uRange(loop.pts).min).toBeCloseTo(9000, 6);
    expect(vRange(loop.pts).min).toBeCloseTo(7000, 6);
  });

  it('finds nothing where the plane misses the solid entirely', () => {
    const low = boxFaces(0, 0, 0, 1000, 1000, 500);
    expect(sliceEntity(low, frame, plane.point, plane.normal)).toHaveLength(0);
  });

  it('reads a duct through a slab as a hole, not as a second outline', () => {
    // A slab 5000 × 5000 × 200 around z = 1200, with a 1000 square shaft
    // through it. The shaft is a box of faces facing inward; for the slice it
    // only matters that its faces are there.
    const slab = boxFaces(0, 0, 1100, 5000, 5000, 1300);
    const shaft = boxFaces(2000, 2000, 1100, 3000, 3000, 1300);
    const loops = sliceEntity([...slab, ...shaft], frame, plane.point, plane.normal);
    expect(loops).toHaveLength(2);
    expect(loops[0].isHole).toBe(false);
    expect(loops[1].isHole).toBe(true);
    expect(uRange(loops[1].pts)).toEqual({ min: 2000, max: 3000 });
  });

  it('cuts a wall with a doorway into the two pieces either side of it', () => {
    // The doorway is modelled the way the mapper leaves it: the wall's south
    // and north faces each carry the opening as a hole, and the reveals are
    // faces of their own.
    const hole = (y: number): Vec3[] => [
      { x: 1000, y, z: 0 }, { x: 2000, y, z: 0 },
      { x: 2000, y, z: 2100 }, { x: 1000, y, z: 2100 },
    ];
    const faces: FaceLike[] = [
      ...boxFaces(0, 0, 0, 4000, 250, 3000).map((f, i) =>
        i === 2 ? { ring: f.ring, holes: [hole(0)] }
          : i === 3 ? { ring: f.ring, holes: [hole(250)] } : f),
      // the two reveals
      { ring: [{ x: 1000, y: 0, z: 0 }, { x: 1000, y: 0, z: 2100 }, { x: 1000, y: 250, z: 2100 }, { x: 1000, y: 250, z: 0 }], holes: [] },
      { ring: [{ x: 2000, y: 0, z: 0 }, { x: 2000, y: 250, z: 0 }, { x: 2000, y: 250, z: 2100 }, { x: 2000, y: 0, z: 2100 }], holes: [] },
    ];
    const loops = sliceEntity(faces, frame, plane.point, plane.normal);
    expect(loops).toHaveLength(2);
    expect(loops.every((l) => !l.isHole)).toBe(true);
    const spans = loops.map((l) => uRange(l.pts)).sort((a, b) => a.min - b.min);
    expect(spans[0]).toEqual({ min: 0, max: 1000 });
    expect(spans[1]).toEqual({ min: 2000, max: 4000 });
  });
});

describe('sliceEntity — a vertical cut', () => {
  // A west→east marker at y = 125, looking north: it runs down the wall.
  const cf = { ax: 0, ay: 125, tx: 1, ty: 0, nx: 0, ny: 1, lengthMm: 4000, clip: false, depth: Infinity };
  const frame = frameFromCut(cf, 'section', -Infinity, Infinity);

  it('puts v on the BIM elevation, the way every DrawingResult consumer assumes', () => {
    const loops = sliceEntity(WALL, frame, frame.o, frame.rd);
    expect(loops).toHaveLength(1);
    expect(vRange(loops[0].pts)).toEqual({ min: 0, max: 3000 });
    expect(uRange(loops[0].pts)).toEqual({ min: 0, max: 4000 });
  });
});

describe('penColor', () => {
  it('leaves alone any colour that already reads as ink', () => {
    // The slates and mid tones the element defaults use for seen lines.
    for (const c of ['#64748B', '#94A3B8', '#1E293B', '#475569', '#0891B2']) {
      expect(penColor(c)).toBe(c);
    }
  });

  it('rescues the pale ones too, which a fill can carry and a line cannot', () => {
    // A slab's seen line `#CBD5E1` sits at luminance 0.83 and a covering's
    // `#FDA4AF` at 0.72: against a cream sheet those are contrast ratios
    // near 1.1, which is no line at all. They are perfectly good FILLS,
    // which is why they were never noticed.
    for (const c of ['#CBD5E1', '#FDA4AF']) {
      expect(luminance(c)).toBeGreaterThan(0.68);
      expect(luminance(penColor(c))).toBeLessThan(0.3);
    }
  });

  it('rescues a white line, which is no line at all on a cream sheet', () => {
    const out = penColor('#ffffff');
    expect(out).not.toBe('#ffffff');
    expect(luminance(out)).toBeLessThan(0.3);
  });

  it('keeps the hue while it darkens — a terracotta stays terracotta', () => {
    const out = penColor('#FFEEE6');          // a very pale warm tint
    const [r, g, b] = rgb(out);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(luminance(out)).toBeLessThan(0.3);
  });

  it('hands back anything it cannot read, rather than inventing a colour', () => {
    expect(penColor('url(#grad)')).toBe('url(#grad)');
    expect(penColor('rebeccapurple')).toBe('rebeccapurple');
  });

  it('understands the three-digit form', () => {
    expect(penColor('#fff')).not.toBe('#fff');
    expect(penColor('#345')).toBe('#345');
  });
});

describe('the frame itself', () => {
  it('reproduces ogProjection’s own projection term for term', () => {
    // A section frame must agree with `project(frame, p) = { u: local.x,
    // v: p.z, depth: -local.y }`, or every kernel line lands somewhere else
    // than the cut it belongs to.
    const cf = { ax: 1000, ay: 2000, tx: 0.6, ty: 0.8, nx: -0.8, ny: 0.6, lengthMm: 5000, clip: false, depth: Infinity };
    const frame = frameFromCut(cf);
    const p = { x: 4321, y: -765, z: 2345 };
    const rx = p.x - cf.ax, ry = p.y - cf.ay;
    expect(projectPt(frame, p).u).toBeCloseTo(rx * cf.tx + ry * cf.ty, 9);
    expect(projectPt(frame, p).v).toBeCloseTo(p.z, 9);
    expect(projectPt(frame, p).depth).toBeCloseTo(rx * cf.nx + ry * cf.ny, 9);
  });

  it('calls a straddling box cut, one below the plane seen, one above it out', () => {
    const frame = planFrame({ cutZmm: 1200, elevMin: 0, elevMax: 3000 });
    const box = (z0: number, z1: number) => ({ minX: 0, minY: 0, minZ: z0, maxX: 1, maxY: 1, maxZ: z1 });
    expect(roleOf(frame, box(0, 3000))).toBe('cut');
    expect(roleOf(frame, box(0, 200))).toBe('seen');
    expect(roleOf(frame, box(2000, 2500))).toBe('out');
  });

  it('keeps the storey above out of a plan even though it is behind the cut', () => {
    const frame = planFrame({ cutZmm: 1200, elevMin: 0, elevMax: 3000 });
    // A slab of the storey above: below the cut in depth terms it is not,
    // but it is out of the band and that is what decides.
    expect(roleOf(frame, { minX: 0, minY: 0, minZ: 3000, maxX: 1, maxY: 1, maxZ: 3200 })).toBe('out');
  });
});
