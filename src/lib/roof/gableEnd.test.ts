/**
 * Gable-end (fronton) faces and rotated-rectangle gables.
 *
 * Two long-standing defects covered here:
 *  1. `gable_end` was declared in the type but never produced — every two-slope
 *     roof was open at its ends in 3D.
 *  2. Any plan that wasn't a bbox-aligned rectangle was silently rerouted to the
 *     straight skeleton, which hips EVERY edge — so a requested two-slope roof
 *     came out with multiple hipped faces and no frontons.
 */
import { describe, it, expect } from 'vitest';
import {
  buildGableEnvelope, buildRoofEnvelope, rotatedRectFrame,
  type RoofContour, type RoofDiagnostic, type RoofFace3D,
} from '@/lib/roof';

const RECT = [
  { x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 6000 }, { x: 0, y: 6000 },
];
/** Contour AFTER the eave offset was applied — `overhangMm` records how much. */
const C = (points: { x: number; y: number }[], overhangMm = 0): RoofContour =>
  ({ points, axIds: [], baseZ: 3000, storeyId: 's', overhangMm });

const expand = (pts: { x: number; y: number }[], d: number) => {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return pts.map((p) => ({ x: p.x + Math.sign(p.x - cx) * d, y: p.y + Math.sign(p.y - cy) * d }));
};
const gableEnds = (faces: RoofFace3D[]) => faces.filter((f) => f.role === 'gable_end');
const slopes = (faces: RoofFace3D[]) => faces.filter((f) => f.role === 'slope');

describe('gable-end frontons', () => {
  it('a two-slope gable emits exactly two vertical frontons', () => {
    const diags: RoofDiagnostic[] = [];
    const { faces } = buildGableEnvelope(C(RECT), 30, 'auto', 0, 'r', diags);
    expect(slopes(faces)).toHaveLength(2);
    const ends = gableEnds(faces);
    expect(ends).toHaveLength(2);
    // Vertical: every vertex of a fronton shares one plan coordinate (the wall plane).
    for (const f of ends) {
      const xs = new Set(f.vertices.map((v) => Math.round(v.x)));
      expect(xs.size).toBe(1); // ridge runs along X here → frontons are X-planes
    }
  });

  it('the fronton sits at the exterior wall face — inset from the eave by the overhang', () => {
    const ov = 500;
    // Wall line is RECT; the roof contour is that expanded by the overhang.
    const diags: RoofDiagnostic[] = [];
    const { faces } = buildGableEnvelope(C(expand(RECT, ov), ov), 30, 'auto', 0, 'r', diags);
    const ends = gableEnds(faces);
    expect(ends).toHaveLength(2);
    const planes = ends.map((f) => Math.round(f.vertices[0].x)).sort((a, b) => a - b);
    // Back at the WALL, not out at the roof edge (which is at -500 / 10500).
    expect(planes).toEqual([0, 10000]);
    // ...and the fronton's span likewise stops at the wall on the eave sides.
    for (const f of ends) {
      const ys = f.vertices.map((v) => v.y);
      expect(Math.min(...ys)).toBeCloseTo(0, 0);
      expect(Math.max(...ys)).toBeCloseTo(6000, 0);
    }
  });

  it('the fronton reaches the ridge apex and starts at the wall plate', () => {
    const rise = 3000 * Math.tan((30 * Math.PI) / 180); // half-span 3000 on a 6 m width
    const diags: RoofDiagnostic[] = [];
    const { faces } = buildGableEnvelope(C(RECT), 30, 'auto', 0, 'r', diags);
    for (const f of gableEnds(faces)) {
      const zs = f.vertices.map((v) => v.z);
      expect(Math.min(...zs)).toBeCloseTo(3000, 0);       // wall plate
      expect(Math.max(...zs)).toBeCloseTo(3000 + rise, 0); // ridge
    }
  });

  it('with an overhang the fronton shoulders rise by overhang × slope (rake set-back)', () => {
    const ov = 500;
    const tan30 = Math.tan((30 * Math.PI) / 180);
    const diags: RoofDiagnostic[] = [];
    const { faces } = buildGableEnvelope(C(expand(RECT, ov), ov), 30, 'auto', 0, 'r', diags);
    const f = gableEnds(faces)[0];
    const zs = [...new Set(f.vertices.map((v) => Math.round(v.z)))].sort((a, b) => a - b);
    // Base at the plate, shoulders one overhang up the slope, apex at the ridge.
    expect(zs[0]).toBe(3000);
    expect(zs[1]).toBeCloseTo(3000 + ov * tan30, -1);
  });
});

describe('rotated rectangle stays a true two-slope gable', () => {
  const rot = (deg: number) => (x: number, y: number) => {
    const a = (deg * Math.PI) / 180;
    return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
  };

  it('detects a right-angled quad at any angle', () => {
    const r = rot(23);
    expect(rotatedRectFrame(RECT.map((p) => r(p.x, p.y)))).not.toBeNull();
    // A genuine non-rectangle must be rejected, or it would get a bogus gable.
    expect(rotatedRectFrame([{ x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 6000 }, { x: 3000, y: 9000 }])).toBeNull();
  });

  it('a 23°-rotated box gives 2 slopes + 2 frontons, not 4 hipped faces', () => {
    const r = rot(23);
    const diags: RoofDiagnostic[] = [];
    const { faces, skeleton } = buildRoofEnvelope(
      C(RECT.map((p) => r(p.x, p.y))), 'gable', 30, 'auto', 0, 'r', diags,
    );
    expect(slopes(faces)).toHaveLength(2);
    expect(gableEnds(faces)).toHaveLength(2);
    expect(skeleton.filter((s) => s.role === 'hip')).toHaveLength(0);
    expect(diags.some((d) => d.code === 'GABLE_ROTATED')).toBe(true);
  });

  it('the rotated ridge keeps the correct height and runs along the long side', () => {
    const r = rot(23);
    const diags: RoofDiagnostic[] = [];
    const { skeleton } = buildRoofEnvelope(
      C(RECT.map((p) => r(p.x, p.y))), 'gable', 30, 'auto', 0, 'r', diags,
    );
    const ridge = skeleton.find((s) => s.role === 'ridge')!;
    expect(ridge.a.z).toBeCloseTo(3000 + 3000 * Math.tan((30 * Math.PI) / 180), 0);
    // Ridge length ≈ the 10 m side (the bbox of the rotated box is ~12.4 m wide,
    // which is exactly what the old bbox gable overshot to).
    expect(Math.hypot(ridge.b.x - ridge.a.x, ridge.b.y - ridge.a.y)).toBeCloseTo(10000, 0);
    // ...and it points along the rotated long axis, not along world X.
    const ang = Math.abs((Math.atan2(ridge.b.y - ridge.a.y, ridge.b.x - ridge.a.x) * 180) / Math.PI);
    expect(ang % 180).toBeCloseTo(23, 0);
  });
});
