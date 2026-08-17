import { describe, it, expect } from 'vitest';
import { buildRoofEnvelope, placeDormer, type RoofContour, type RoofDiagnostic } from '@/lib/roof';

const contour = (points: { x: number; y: number }[], baseZ = 3000): RoofContour => ({
  points, axIds: [], baseZ, storeyId: 's',
});
const RECT = [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 8000 }, { x: 0, y: 8000 }];

function gableFaces() {
  const diags: RoofDiagnostic[] = [];
  const { faces } = buildRoofEnvelope(contour(RECT), 'gable', 35, 'auto', 0, 'r', diags);
  return faces;
}

const BASE_INTENT = {
  widthMm: 1200,
  depthMm: 900,
  wallHeightMm: 1200,
  roofType: 'gable' as const,
  pitchDeg: 25,
  overhangMm: 150,
};

describe('placeDormer — envelope geometry', () => {
  it('resolves on the south gable face with a valid (flat) front wall', () => {
    const faces = gableFaces();
    const p = placeDormer(faces, { planX: 5000, planY: 900, ...BASE_INTENT });
    expect(p).not.toBeNull();
    expect(p!.ok).toBe(true);
    expect(p!.diagnostics).toHaveLength(0);

    // Front wall is vertical: bottom corners share z, top corners share a higher z.
    const [fbl, fbr, ftr, ftl] = p!.frontWall.corners;
    expect(fbl.z).toBeCloseTo(fbr.z, 0);
    expect(ftl.z).toBeCloseTo(ftr.z, 0);
    expect(ftl.z - fbl.z).toBeCloseTo(BASE_INTENT.wallHeightMm, 0);

    // Width: front-left to front-right spans ~widthMm in plan.
    const widthPlan = Math.hypot(fbr.x - fbl.x, fbr.y - fbl.y);
    expect(widthPlan).toBeCloseTo(BASE_INTENT.widthMm, 0);
  });

  it('cheek wall top edge is FLAT (wall-plate line), bottom follows the roof slope', () => {
    const faces = gableFaces();
    const p = placeDormer(faces, { planX: 5000, planY: 900, ...BASE_INTENT })!;
    const [frontBottom, frontTop, backTop, backBottom] = p.cheekRight.corners;
    expect(frontTop.z).toBeCloseTo(backTop.z, 0); // flat top plate
    expect(backBottom.z).toBeGreaterThan(frontBottom.z); // further up-slope → higher
    expect(backBottom.z).toBeLessThan(frontTop.z); // must sit below the wall-plate line
  });

  it('own mini-roof is a valid gable with 2 faces, sitting above the wall-plate height', () => {
    const faces = gableFaces();
    const p = placeDormer(faces, { planX: 5000, planY: 900, ...BASE_INTENT })!;
    expect(p.ownRoofFaces.length).toBeGreaterThanOrEqual(2);
    const wallPlateZ = p.frontWall.corners[2].z; // front-top
    for (const f of p.ownRoofFaces) {
      for (const v of f.vertices) expect(v.z).toBeGreaterThanOrEqual(wallPlateZ - 1);
    }
  });

  it('flags a dormer whose depth/height makes the back edge meet or exceed the wall-plate line', () => {
    const faces = gableFaces();
    // Very shallow wall + large depth on a steep-ish pitch → back edge outruns the top plate.
    const p = placeDormer(faces, { planX: 5000, planY: 900, ...BASE_INTENT, wallHeightMm: 100, depthMm: 3500 });
    expect(p).not.toBeNull();
    expect(p!.ok).toBe(false);
    expect(p!.diagnostics.some((d) => d.includes('wall height too small'))).toBe(true);
  });

  it('flags a dormer placed too close to the eave (margin check)', () => {
    const faces = gableFaces();
    const p = placeDormer(faces, { planX: 5000, planY: 60, ...BASE_INTENT }, 200);
    expect(p).not.toBeNull();
    expect(p!.ok).toBe(false);
    expect(p!.diagnostics.some((d) => d.includes('roof edge'))).toBe(true);
  });

  it('returns null when the plan point is not on any roof face', () => {
    const faces = gableFaces();
    expect(placeDormer(faces, { planX: -9999, planY: -9999, ...BASE_INTENT })).toBeNull();
  });

  it('a shed-type own roof produces a single face', () => {
    const faces = gableFaces();
    const p = placeDormer(faces, { planX: 5000, planY: 900, ...BASE_INTENT, roofType: 'shed' })!;
    expect(p.ownRoofFaces.length).toBe(1);
  });

  it('notch footprint is a proper CCW-ish rectangle with 4 distinct corners', () => {
    const faces = gableFaces();
    const p = placeDormer(faces, { planX: 5000, planY: 900, ...BASE_INTENT })!;
    expect(p.notchFootprint).toHaveLength(4);
    const xs = new Set(p.notchFootprint.map((c) => Math.round(c.x)));
    const ys = new Set(p.notchFootprint.map((c) => Math.round(c.y)));
    expect(xs.size).toBeGreaterThan(1);
    expect(ys.size).toBeGreaterThan(1);
  });
});
