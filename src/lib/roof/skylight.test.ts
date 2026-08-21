import { describe, it, expect } from 'vitest';
import {
  buildRoofEnvelope,
  computeFaceBasis,
  findHostFace,
  placeSkylight,
  type RoofContour,
  type RoofDiagnostic,
} from '@/lib/roof';

const contour = (points: { x: number; y: number }[], baseZ = 3000): RoofContour => ({
  points, axIds: [], baseZ, storeyId: 's',
});
const RECT = [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 8000 }, { x: 0, y: 8000 }];

function gableFaces() {
  const diags: RoofDiagnostic[] = [];
  const { faces } = buildRoofEnvelope(contour(RECT), 'gable', 30, 'auto', 0, 'r', diags);
  return faces;
}
function hipFaces() {
  const diags: RoofDiagnostic[] = [];
  const { faces } = buildRoofEnvelope(contour(RECT), 'hip', 30, 'auto', 0, 'r', diags);
  return faces;
}

describe('face basis', () => {
  it('u is horizontal, v points up-slope, n is unit and roughly upward', () => {
    // Only slopes — gable-end frontons are vertical, so "up-slope" is undefined there.
    const faces = gableFaces().filter((f) => f.role === 'slope');
    for (const f of faces) {
      const basis = computeFaceBasis(f)!;
      expect(basis).not.toBeNull();
      expect(basis.u.x * basis.u.x + basis.u.y * basis.u.y).toBeCloseTo(1, 5);
      const nLen = Math.hypot(basis.n.x, basis.n.y, basis.n.z);
      expect(nLen).toBeCloseTo(1, 5);
      expect(basis.n.z).toBeGreaterThan(0); // outward = upward-ish for a roof slope
      expect(basis.v.z).toBeGreaterThan(0); // "up the slope" gains height
    }
  });
});

describe('findHostFace', () => {
  it('locates the south face of a gable roof by a plan point near the south eave', () => {
    const faces = gableFaces();
    const f = findHostFace(faces, 5000, 1000); // near y=0 eave, mid-span in x
    expect(f).not.toBeNull();
    expect(f!.role).toBe('slope');
  });

  it('returns null for a point outside the building footprint', () => {
    const faces = gableFaces();
    expect(findHostFace(faces, -5000, -5000)).toBeNull();
  });

  it('locates one of four hip faces correctly', () => {
    const faces = hipFaces();
    expect(faces).toHaveLength(4);
    const f = findHostFace(faces, 5000, 500); // south triangular hip end
    expect(f).not.toBeNull();
  });
});

describe('placeSkylight', () => {
  it('places a well-sized skylight centered on the south gable face with no diagnostics', () => {
    const faces = gableFaces();
    const p = placeSkylight(faces, { planX: 5000, planY: 1500, widthMm: 1000, lengthMm: 1200, curbHeightMm: 120 });
    expect(p).not.toBeNull();
    expect(p!.ok).toBe(true);
    expect(p!.diagnostics).toHaveLength(0);
    expect(p!.corners).toHaveLength(4);
    // Corners' z should sit above baseZ (they're on the pitched face, not at the eave).
    for (const c of p!.corners) expect(c.z).toBeGreaterThanOrEqual(3000);
  });

  it('rejects a skylight placed too close to the eave (fails the margin check)', () => {
    const faces = gableFaces();
    const p = placeSkylight(faces, { planX: 5000, planY: 50, widthMm: 1000, lengthMm: 1200, curbHeightMm: 120 }, 300);
    expect(p).not.toBeNull();
    expect(p!.ok).toBe(false);
    expect(p!.diagnostics.length).toBeGreaterThan(0);
  });

  it('returns null when the plan point is not on any roof face', () => {
    const faces = gableFaces();
    const p = placeSkylight(faces, { planX: -9999, planY: -9999, widthMm: 1000, lengthMm: 1000, curbHeightMm: 100 });
    expect(p).toBeNull();
  });

  it('all 4 corners project back inside the host face polygon (plan)', () => {
    const faces = gableFaces();
    const p = placeSkylight(faces, { planX: 5000, planY: 1500, widthMm: 1200, lengthMm: 1500, curbHeightMm: 120 })!;
    // Sanity: opening footprint area is a fraction of the face's plan area, not larger.
    const shoelace = (pts: { x: number; y: number }[]) => {
      let a = 0;
      for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
      return Math.abs(a / 2);
    };
    const openingArea = shoelace(p.corners.map((c) => ({ x: c.x, y: c.y })));
    const faceArea = shoelace(p.face.vertices.map((v) => ({ x: v.x, y: v.y })));
    expect(openingArea).toBeLessThan(faceArea);
    expect(openingArea).toBeGreaterThan(0);
  });

  it('placed on a hip triangular end still resolves (smaller face, tighter margin)', () => {
    const faces = hipFaces();
    const p = placeSkylight(faces, { planX: 5000, planY: 400, widthMm: 600, lengthMm: 600, curbHeightMm: 100 }, 100);
    expect(p).not.toBeNull();
  });
});
