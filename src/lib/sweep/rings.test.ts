import { describe, expect, it } from 'vitest';
import {
  computeSweepSolids,
  pathLength,
  solidTriangles,
  sweepFootprint,
  sweepSegments,
  sweepVolume,
  triangulateSimple,
} from './rings';
import { lProfile, rectProfile, uProfile } from './profiles';
import type { Pt2, Pt3, SweepPath } from './types';

const hPath = (pts: [number, number][], z = 1000, closed = false): SweepPath => ({
  points: pts.map(([x, y]) => ({ x, y, z })),
  closed,
  kind: 'horizontal',
});

/** Unit square profile, CCW, corner at origin — easy to eyeball in assertions. */
const square100: Pt2[] = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
];

describe('triangulateSimple', () => {
  it('n−2 triangles for concave profiles', () => {
    expect(triangulateSimple(lProfile(100, 60, 10)!)).toHaveLength(4);
    expect(triangulateSimple(uProfile(150, 100, 10)!)).toHaveLength(6);
    expect(triangulateSimple(square100)).toHaveLength(2);
  });

  it('triangle areas sum to the polygon area', () => {
    const poly = uProfile(150, 100, 10)!;
    const area = triangulateSimple(poly).reduce((s, [a, b, c]) => {
      const A = poly[a], B = poly[b], C = poly[c];
      return s + Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / 2;
    }, 0);
    expect(area).toBeCloseTo(150 * 100 - 130 * 90, 3);
  });
});

describe('computeSweepSolids — straight and mitered', () => {
  it('straight +X run: ring = P + s·x + Z·y, s = left = +Y', () => {
    const { solids, diagnostics } = computeSweepSolids(hPath([[0, 0], [4000, 0]]), square100, 'miter');
    expect(diagnostics).toHaveLength(0);
    expect(solids).toHaveLength(1);
    expect(solids[0].rings).toHaveLength(2);
    expect(solids[0].rings[0][1]).toEqual({ x: 0, y: 100, z: 1000 });   // p=(100,0)
    expect(solids[0].rings[1][2]).toEqual({ x: 4000, y: 100, z: 1100 }); // p=(100,100)
  });

  it('right-angle L: middle ring on the bisector, scaled √2', () => {
    const { solids } = computeSweepSolids(hPath([[0, 0], [4000, 0], [4000, 3000]]), square100, 'miter');
    expect(solids).toHaveLength(1);
    expect(solids[0].rings).toHaveLength(3);
    // s_prev = (0,1), s_next = (−1,0) → lateral = (−1, 1); p.x = 100 → (3900, 100)
    expect(solids[0].rings[1][1].x).toBeCloseTo(3900, 6);
    expect(solids[0].rings[1][1].y).toBeCloseTo(100, 6);
  });

  it('closed square path → one loop solid with 4 rings', () => {
    const { solids } = computeSweepSolids(
      hPath([[0, 0], [4000, 0], [4000, 4000], [0, 4000]], 1000, true),
      square100, 'miter',
    );
    expect(solids).toHaveLength(1);
    expect(solids[0].loop).toBe(true);
    expect(solids[0].rings).toHaveLength(4);
  });

  it('butt mode splits an L into two 2-ring prisms', () => {
    const { solids } = computeSweepSolids(hPath([[0, 0], [4000, 0], [4000, 3000]]), square100, 'butt');
    expect(solids).toHaveLength(2);
    for (const s of solids) expect(s.rings).toHaveLength(2);
  });

  it('a 170° turn falls back to butt with CORNER_TOO_SHARP', () => {
    const a = (170 * Math.PI) / 180;
    const p2: [number, number] = [4000 + Math.cos(a) * 1000, Math.sin(a) * 1000];
    const { solids, diagnostics } = computeSweepSolids(hPath([[0, 0], [4000, 0], p2]), square100, 'miter');
    expect(solids).toHaveLength(2);
    expect(diagnostics.some((d) => d.code === 'CORNER_TOO_SHARP')).toBe(true);
  });

  it('vertical path stamps the profile in plan', () => {
    const path: SweepPath = {
      points: [{ x: 500, y: 700, z: 0 }, { x: 500, y: 700, z: 3000 }],
      closed: false, kind: 'vertical',
    };
    const { solids } = computeSweepSolids(path, square100, 'miter');
    expect(solids[0].rings[0][2]).toEqual({ x: 600, y: 800, z: 0 });
    expect(solids[0].rings[1][0]).toEqual({ x: 500, y: 700, z: 3000 });
  });
});

describe('sweepVolume', () => {
  const placedMid = rectProfile(300, 600)!; // centered — centroid on the guide line

  it('rect 300×600 along a 4000+3000 L, centroid on the line → area × 7 m', () => {
    const { solids } = computeSweepSolids(hPath([[0, 0], [4000, 0], [4000, 3000]]), placedMid, 'miter');
    const v = sweepVolume(solids, triangulateSimple(placedMid));
    expect(v).toBeCloseTo(180000 * 7000, -3); // mm³, exact but for float noise
  });

  it('a 300 mm lateral offset shortens the mitered run: area × (7000 − 2·300)', () => {
    // +x in the profile is LEFT of travel; this L turns left, so +300 is inside.
    const placedOff = placedMid.map((p) => ({ x: p.x + 300, y: p.y }));
    const { solids } = computeSweepSolids(hPath([[0, 0], [4000, 0], [4000, 3000]]), placedOff, 'miter');
    const v = sweepVolume(solids, triangulateSimple(placedOff));
    expect(v).toBeCloseTo(180000 * 6400, -3);
  });

  it('vertical: area × height', () => {
    const path: SweepPath = {
      points: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3000 }],
      closed: false, kind: 'vertical',
    };
    const { solids } = computeSweepSolids(path, placedMid, 'miter');
    expect(sweepVolume(solids, triangulateSimple(placedMid))).toBeCloseTo(180000 * 3000, -3);
  });

  it('closed square loop: area × centroid loop length', () => {
    const { solids } = computeSweepSolids(
      hPath([[0, 0], [4000, 0], [4000, 4000], [0, 4000]], 1000, true),
      placedMid, 'miter',
    );
    expect(sweepVolume(solids, triangulateSimple(placedMid))).toBeCloseTo(180000 * 16000, -3);
  });

  it('the triangle soup is watertight — every directed edge has its reverse', () => {
    const placed = lProfile(100, 60, 10)!; // concave, so caps matter
    const { solids } = computeSweepSolids(hPath([[0, 0], [4000, 0], [4000, 3000]]), placed, 'miter');
    const tris = solids.flatMap((s) => solidTriangles(s, triangulateSimple(placed)));
    const key = (p: Pt3) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
    const dir = new Map<string, number>();
    for (const [a, b, c] of tris) {
      for (const [p, q] of [[a, b], [b, c], [c, a]] as [Pt3, Pt3][]) {
        dir.set(`${key(p)}→${key(q)}`, (dir.get(`${key(p)}→${key(q)}`) ?? 0) + 1);
      }
    }
    for (const [k, count] of dir) {
      expect(count, k).toBe(1);
      const [p, q] = k.split('→');
      expect(dir.get(`${q}→${p}`), `reverse of ${k}`).toBe(1);
    }
  });
});

describe('footprint & length', () => {
  it('open L footprint is one polygon following the mitered edges', () => {
    const { solids } = computeSweepSolids(hPath([[0, 0], [4000, 0], [4000, 3000]]), square100, 'miter');
    const fp = sweepFootprint(solids, hPath([[0, 0], [4000, 0], [4000, 3000]]), square100);
    expect(fp).toHaveLength(1);
    expect(fp[0]).toHaveLength(6); // 3 rings × 2 chains
  });

  it('closed loop footprint yields outer and inner chains', () => {
    const path = hPath([[0, 0], [4000, 0], [4000, 4000], [0, 4000]], 1000, true);
    const { solids } = computeSweepSolids(path, square100, 'miter');
    expect(sweepFootprint(solids, path, square100)).toHaveLength(2);
  });

  it('vertical footprint is the profile at the point', () => {
    const path: SweepPath = {
      points: [{ x: 500, y: 700, z: 0 }, { x: 500, y: 700, z: 3000 }],
      closed: false, kind: 'vertical',
    };
    const fp = sweepFootprint([], path, square100);
    expect(fp[0][2]).toEqual({ x: 600, y: 800 });
  });

  it('sweepSegments builds a right-handed frame per segment', () => {
    const segs = sweepSegments(hPath([[0, 0], [4000, 0], [4000, 3000]]));
    expect(segs).toHaveLength(2);
    expect(segs[0].axis).toEqual({ x: 1, y: 0, z: 0 });
    expect(segs[0].refDir).toEqual({ x: 0, y: 1, z: 0 });  // left of +X
    expect(segs[0].lengthMm).toBe(4000);
    expect(segs[1].axis).toEqual({ x: 0, y: 1, z: 0 });
    expect(segs[1].refDir).toEqual({ x: -1, y: 0, z: 0 });
    // Y = axis × refDir must be world up for every segment, or the profile
    // would be exported lying on its side.
    for (const s of segs) {
      // `+ 0` folds the −0 this arithmetic produces back to 0 for the compare.
      const y = {
        x: s.axis.y * s.refDir.z - s.axis.z * s.refDir.y + 0,
        y: s.axis.z * s.refDir.x - s.axis.x * s.refDir.z + 0,
        z: s.axis.x * s.refDir.y - s.axis.y * s.refDir.x + 0,
      };
      expect(y).toEqual({ x: 0, y: 0, z: 1 });
    }
  });

  it('sweepSegments: vertical maps profile x→X, y→Y; closed path keeps its seam', () => {
    const vert = sweepSegments({
      points: [{ x: 0, y: 0, z: 200 }, { x: 0, y: 0, z: 3000 }],
      closed: false, kind: 'vertical',
    });
    expect(vert).toHaveLength(1);
    expect(vert[0].lengthMm).toBe(2800);
    expect(vert[0].axis).toEqual({ x: 0, y: 0, z: 1 });

    const loop = sweepSegments(hPath([[0, 0], [4000, 0], [4000, 4000], [0, 4000]], 1000, true));
    expect(loop).toHaveLength(4);
    expect(loop.reduce((s, x) => s + x.lengthMm, 0)).toBeCloseTo(16000, 6);
  });

  it('pathLength counts the closing segment of a loop', () => {
    expect(pathLength(hPath([[0, 0], [4000, 0], [4000, 3000]]))).toBeCloseTo(7000, 6);
    expect(pathLength(hPath([[0, 0], [4000, 0], [4000, 4000], [0, 4000]], 1000, true))).toBeCloseTo(16000, 6);
  });
});
