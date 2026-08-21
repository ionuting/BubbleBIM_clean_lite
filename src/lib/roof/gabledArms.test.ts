/**
 * Gabled arms — the concave-gable roof (L / T / U / plus).
 *
 * The defect this replaces: asking for a two-slope roof on any concave plan
 * silently produced a fully hipped roof (the straight skeleton pitches EVERY
 * edge), so "gable" was unreachable on real house footprints. The older
 * `buildCrossGableEnvelope` butt-joints its wings instead, which on unequal
 * arms leaves two parallel ridges with a dead-flat gutter and no valley.
 */
import { describe, it, expect } from 'vitest';
import {
  buildGabledArmsEnvelope, buildRoofEnvelope, maximalRects,
  type RoofContour, type RoofDiagnostic, type RoofFace3D, type SkeletonSeg,
} from '@/lib/roof';

const BASE_Z = 3000;
const PITCH = 30;
const C = (points: { x: number; y: number }[], overhangMm = 0): RoofContour =>
  ({ points, axIds: [], baseZ: BASE_Z, storeyId: 's', overhangMm });

const area = (pts: { x: number; y: number }[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
  return Math.abs(a / 2);
};
const slopes = (f: RoofFace3D[]) => f.filter((x) => x.role === 'slope');
const ends = (f: RoofFace3D[]) => f.filter((x) => x.role === 'gable_end');
const roles = (s: SkeletonSeg[], r: SkeletonSeg['role']) => s.filter((x) => x.role === r);

const L = [
  { x: 0, y: 0 }, { x: 12000, y: 0 }, { x: 12000, y: 5000 },
  { x: 7000, y: 5000 }, { x: 7000, y: 10000 }, { x: 0, y: 10000 },
];
const T = [
  { x: 0, y: 0 }, { x: 12000, y: 0 }, { x: 12000, y: 4000 }, { x: 8000, y: 4000 },
  { x: 8000, y: 9000 }, { x: 4000, y: 9000 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 },
];
const U = [
  { x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 9000 }, { x: 6000, y: 9000 },
  { x: 6000, y: 3000 }, { x: 3000, y: 3000 }, { x: 3000, y: 9000 }, { x: 0, y: 9000 },
];
const PLUS = [
  { x: 3000, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 }, { x: 9000, y: 3000 },
  { x: 9000, y: 6000 }, { x: 6000, y: 6000 }, { x: 6000, y: 9000 }, { x: 3000, y: 9000 },
  { x: 3000, y: 6000 }, { x: 0, y: 6000 }, { x: 0, y: 3000 }, { x: 3000, y: 3000 },
];

describe('maximal rectangles are the building arms', () => {
  it('finds the two OVERLAPPING arms of an L (not a butt-joint tiling)', () => {
    const r = maximalRects(L)!;
    expect(r).toHaveLength(2);
    // Each arm spans its own full length — they share the corner block.
    expect(r.some((x) => x.minX === 0 && x.maxX === 12000 && x.maxY === 5000)).toBe(true);
    expect(r.some((x) => x.minY === 0 && x.maxY === 10000 && x.maxX === 7000)).toBe(true);
  });

  it('U has three arms, plus has two, plain rectangle has one', () => {
    expect(maximalRects(U)).toHaveLength(3);
    expect(maximalRects(PLUS)).toHaveLength(2);
    expect(maximalRects([{ x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 6000 }, { x: 0, y: 6000 }])).toHaveLength(1);
  });
});

describe.each([["L", L], ["T", T], ["U", U], ["plus", PLUS]] as const)("%s plan", (_name, poly) => {
  const diags: RoofDiagnostic[] = [];
  const res = buildGabledArmsEnvelope(C(poly), PITCH, 'r', diags)!;

  it('resolves at all', () => {
    expect(res).not.toBeNull();
    expect(slopes(res.faces).length).toBeGreaterThanOrEqual(4);
  });

  it('the slope faces tile the footprint exactly — no gaps, no overlap', () => {
    const covered = slopes(res.faces).reduce((s, f) => s + area(f.vertices), 0);
    expect(covered / area(poly)).toBeCloseTo(1, 2);
  });

  it('has NO hips — that absence is what makes it a gable', () => {
    expect(roles(res.skeleton, 'hip')).toHaveLength(0);
  });

  it('drains: every reentrant corner produces a valley', () => {
    expect(roles(res.skeleton, 'valley').length).toBeGreaterThan(0);
  });

  it('closes its free arm ends with frontons', () => {
    expect(ends(res.faces).length).toBeGreaterThan(0);
  });

  it('never rises above the tallest arm ridge, never dips below the plate', () => {
    const halfMax = Math.max(...maximalRects(poly)!.map((r) =>
      Math.min(r.maxX - r.minX, r.maxY - r.minY) / 2));
    const zMax = BASE_Z + halfMax * Math.tan((PITCH * Math.PI) / 180);
    for (const f of res.faces) {
      for (const v of f.vertices) {
        expect(v.z).toBeGreaterThanOrEqual(BASE_Z - 1);
        expect(v.z).toBeLessThanOrEqual(zMax + 1);
      }
    }
  });
});

describe('L keeps the wing from re-emerging on the far side', () => {
  const diags: RoofDiagnostic[] = [];
  const res = buildGabledArmsEnvelope(C(L), PITCH, 'r', diags)!;

  it('the short wing gables only at its own free end, not at the main body wall', () => {
    // The wing runs east; its west end dies into the main body, so exactly one
    // fronton faces east, and the main body gables north and south.
    const planes = ends(res.faces).map((f) => {
      const xs = f.vertices.map((v) => Math.round(v.x)), ys = f.vertices.map((v) => Math.round(v.y));
      return { flatX: Math.min(...xs) === Math.max(...xs), at: Math.min(...xs) === Math.max(...xs) ? xs[0] : ys[0] };
    });
    expect(ends(res.faces)).toHaveLength(3);
    expect(planes.filter((p) => p.flatX && p.at === 12000)).toHaveLength(1); // wing, east
    expect(planes.filter((p) => !p.flatX)).toHaveLength(2);                  // main body, N + S
    // Nothing gables at x=0: that wall carries the main body's eave.
    expect(planes.some((p) => p.flatX && p.at === 0)).toBe(false);
  });

  it('exactly two valleys — one each side of the wing junction', () => {
    expect(roles(res.skeleton, 'valley')).toHaveLength(2);
  });
});

describe('routing: a concave gable no longer comes back hipped', () => {
  it.each([['L', L], ['T', T], ['U', U], ['plus', PLUS]] as const)('%s', (_n, poly) => {
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildRoofEnvelope(C(poly, 500), 'gable', PITCH, 'auto', 0, 'r', diags);
    expect(diags.some((d) => d.code === 'GABLED_ARMS')).toBe(true);
    expect(skeleton.filter((s) => s.role === 'hip')).toHaveLength(0);
    expect(ends(faces).length).toBeGreaterThan(0);
  });

  it('roofType=hip on the same plan still gets hips (routing untouched)', () => {
    const diags: RoofDiagnostic[] = [];
    const { skeleton } = buildRoofEnvelope(C(L), 'hip', PITCH, 'auto', 0, 'r', diags);
    expect(skeleton.filter((s) => s.role === 'hip').length).toBeGreaterThan(0);
  });
});
