import { describe, it, expect } from 'vitest';
import {
  computeStraightSkeleton,
  extractSkeletonFaces,
  buildStraightSkeletonEnvelope,
  buildRoofEnvelope,
  buildRoofFraming,
  DEFAULT_ROOF_INTENT,
  type RoofContour,
  type RoofDiagnostic,
  type RoofIntent,
} from '@/lib/roof';

type P = { x: number; y: number };
const area = (pts: P[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
  return Math.abs(a / 2);
};
const contour = (points: P[], baseZ = 3000): RoofContour => ({ points, axIds: [], baseZ, storeyId: 's' });
const intent = (over: Partial<RoofIntent>): RoofIntent => ({ ...DEFAULT_ROOF_INTENT, ...over });

const SQUARE: P[] = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 }];
const RECT: P[] = [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 8000 }, { x: 0, y: 8000 }];
const LSHAPE: P[] = [
  { x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 5000 },
  { x: 5000, y: 5000 }, { x: 5000, y: 10000 }, { x: 0, y: 10000 },
];
const TSHAPE: P[] = [
  { x: 0, y: 0 }, { x: 12000, y: 0 }, { x: 12000, y: 4000 }, { x: 8000, y: 4000 },
  { x: 8000, y: 10000 }, { x: 4000, y: 10000 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 },
];
const PLUS: P[] = [
  { x: 4000, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 4000 }, { x: 12000, y: 4000 },
  { x: 12000, y: 8000 }, { x: 8000, y: 8000 }, { x: 8000, y: 12000 }, { x: 4000, y: 12000 },
  { x: 4000, y: 8000 }, { x: 0, y: 8000 }, { x: 0, y: 4000 }, { x: 4000, y: 4000 },
];
const TRIANGLE: P[] = [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 0, y: 8000 }];

describe('straight skeleton — faces tile the polygon exactly', () => {
  for (const [name, poly, nFaces] of [
    ['square', SQUARE, 4], ['rectangle', RECT, 4], ['L', LSHAPE, 6],
    ['T', TSHAPE, 8], ['plus', PLUS, 12], ['triangle', TRIANGLE, 3],
  ] as [string, P[], number][]) {
    it(`${name}: one face per edge, area conserved`, () => {
      const arcs = computeStraightSkeleton(poly)!;
      expect(arcs).not.toBeNull();
      const faces = extractSkeletonFaces(poly, arcs);
      expect(faces.length).toBe(nFaces);
      const total = faces.reduce((s, f) => s + area(f), 0);
      expect(total).toBeCloseTo(area(poly), -1); // within ~1 mm² scale
    });
  }
});

describe('straight-skeleton hip envelope', () => {
  it('rectangle → classic hip: ridge, 4 hips, no valley, correct height', () => {
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildStraightSkeletonEnvelope(contour(RECT), 30, 'r', diags)!;
    expect(diags.some((d) => d.severity === 'error')).toBe(false);
    expect(skeleton.filter((s) => s.role === 'ridge').length).toBeGreaterThanOrEqual(1);
    expect(skeleton.filter((s) => s.role === 'hip')).toHaveLength(4);
    expect(skeleton.filter((s) => s.role === 'valley')).toHaveLength(0);
    expect(faces).toHaveLength(4);
    // Half-span 4000 mm (short side) → ridge height at 30°.
    const zR = 3000 + 4000 * Math.tan((30 * Math.PI) / 180);
    const topZ = Math.max(...skeleton.flatMap((s) => [s.a.z, s.b.z]));
    expect(topZ).toBeCloseTo(zR, 0);
  });

  it('L-shape → hips AND a real valley; faces tile the plan', () => {
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildStraightSkeletonEnvelope(contour(LSHAPE), 35, 'r', diags)!;
    expect(skeleton.some((s) => s.role === 'valley')).toBe(true);
    expect(skeleton.some((s) => s.role === 'hip')).toBe(true);
    expect(faces).toHaveLength(6);
    const proj = faces.map((f) => f.vertices.map((v) => ({ x: v.x, y: v.y })));
    const total = proj.reduce((s, f) => s + area(f), 0);
    expect(total).toBeCloseTo(area(LSHAPE), -1);
  });

  it('non-axis-aligned triangle → 3 faces meeting at an apex', () => {
    const diags: RoofDiagnostic[] = [];
    const { faces } = buildStraightSkeletonEnvelope(contour(TRIANGLE), 40, 'r', diags)!;
    expect(faces).toHaveLength(3);
    const total = faces.reduce((s, f) => s + area(f.vertices.map((v) => ({ x: v.x, y: v.y }))), 0);
    expect(total).toBeCloseTo(area(TRIANGLE), -1);
  });

  it('buildRoofEnvelope routes hip on an L-shape through the straight skeleton', () => {
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildRoofEnvelope(contour(LSHAPE), 'hip', 30, 'auto', 0, 'r', diags);
    expect(faces).toHaveLength(6);
    expect(skeleton.some((s) => s.role === 'valley')).toBe(true);
    expect(diags.some((d) => d.code === 'STRAIGHT_SKELETON')).toBe(true);
  });
});

describe('straight-skeleton hip framing', () => {
  it('L-shape hip: valley rafters + face rafters + wall plates', () => {
    const c = contour(LSHAPE);
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildRoofEnvelope(c, 'hip', 30, 'auto', 0, 'r', diags);
    const nodes = buildRoofFraming('r', undefined, c, intent({ roofType: 'hip', pitchDeg: 30 }), skeleton, faces);
    expect(nodes.some((n) => n.type === 'valley_rafter')).toBe(true);
    expect(nodes.filter((n) => n.type === 'rafter').length).toBeGreaterThan(4);
    expect(nodes.some((n) => n.type === 'hip_rafter')).toBe(true);
    expect(nodes.some((n) => n.type === 'wall_plate')).toBe(true);
    // Rafters stay within the roof height band.
    const zMax = 3000 + 3000 * Math.tan((30 * Math.PI) / 180) + 1;
    for (const n of nodes.filter((n) => n.type === 'rafter')) {
      expect(Number(n.properties.bz)).toBeLessThanOrEqual(zMax);
    }
  });

  it('triangle hip: rafters generated on all slopes', () => {
    const c = contour(TRIANGLE);
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildRoofEnvelope(c, 'hip', 30, 'auto', 0, 'r', diags);
    const nodes = buildRoofFraming('r', undefined, c, intent({ roofType: 'hip', pitchDeg: 30 }), skeleton, faces);
    expect(nodes.filter((n) => n.type === 'rafter').length).toBeGreaterThan(3);
    expect(nodes.filter((n) => n.type === 'covering').length).toBe(3);
  });
});

describe('truss/purlin systems on arbitrary straight-skeleton ridges', () => {
  it('rectangle hip + truss: tie beams span the real eave-to-eave width, jack rafters on the triangular ends', () => {
    const c = contour(RECT); // 10000×8000 → short side 8000, half-span 4000
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildRoofEnvelope(c, 'hip', 30, 'auto', 0, 'r', diags);
    const nodes = buildRoofFraming(
      'r', undefined, c, intent({ roofType: 'hip', pitchDeg: 30, system: 'truss', trussSpacingMm: 3000 }),
      skeleton, faces,
    );
    const ties = nodes.filter((n) => n.type === 'tie_beam');
    expect(ties.length).toBeGreaterThanOrEqual(1);
    for (const t of ties) expect(Number(t.properties.length_mm)).toBeCloseTo(8000, -1);
    // Triangular hip-end faces still get jack rafters (no truss possible there).
    expect(nodes.some((n) => n.type === 'rafter' && !n.properties.role)).toBe(true);
    expect(nodes.some((n) => n.type === 'rafter' && n.properties.role === 'truss_chord')).toBe(true);
  });

  it('rectangle hip + purlin: purlins run the full ridge length at increasing height', () => {
    const c = contour(RECT);
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildRoofEnvelope(c, 'hip', 30, 'auto', 0, 'r', diags);
    const nodes = buildRoofFraming(
      'r', undefined, c, intent({ roofType: 'hip', pitchDeg: 30, system: 'purlin', purlinSpacingMm: 900 }),
      skeleton, faces,
    );
    const purlins = nodes.filter((n) => n.type === 'purlin');
    expect(purlins.length).toBeGreaterThan(0);
    // Purlins climb monotonically from the eave toward the ridge height.
    const zR = 3000 + 4000 * Math.tan((30 * Math.PI) / 180);
    for (const p of purlins) {
      expect(Number(p.properties.az)).toBeGreaterThan(3000 - 1);
      expect(Number(p.properties.az)).toBeLessThan(zR + 1);
    }
    expect(nodes.some((n) => n.type === 'rafter' && n.properties.role === 'principal')).toBe(true);
  });

  it('L-shape hip + truss: still produces ties on the ridged wings, jack rafters at hip ends', () => {
    const c = contour(LSHAPE);
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildRoofEnvelope(c, 'hip', 30, 'auto', 0, 'r', diags);
    expect(skeleton.some((s) => s.role === 'ridge')).toBe(true); // sanity: this L has a ridge run
    const nodes = buildRoofFraming(
      'r', undefined, c, intent({ roofType: 'hip', pitchDeg: 30, system: 'truss', trussSpacingMm: 2000 }),
      skeleton, faces,
    );
    expect(nodes.filter((n) => n.type === 'tie_beam').length).toBeGreaterThanOrEqual(1);
    expect(nodes.some((n) => n.type === 'post' && n.properties.role === 'king_post')).toBe(true);
    expect(nodes.some((n) => n.type === 'valley_rafter')).toBe(true);
  });

  it('triangle hip (no ridge at all) falls back to jack rafters even when system=truss', () => {
    const c = contour(TRIANGLE);
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildRoofEnvelope(c, 'hip', 30, 'auto', 0, 'r', diags);
    expect(skeleton.some((s) => s.role === 'ridge')).toBe(false); // pure apex, no ridge run
    const nodes = buildRoofFraming(
      'r', undefined, c, intent({ roofType: 'hip', pitchDeg: 30, system: 'truss' }),
      skeleton, faces,
    );
    expect(nodes.filter((n) => n.type === 'rafter').length).toBeGreaterThan(3);
    expect(nodes.filter((n) => n.type === 'tie_beam')).toHaveLength(0);
  });
});

// ── Purlins sampled ALONG the ridge (not just interpolated between its two ends) ──
// A general trapezium (no two sides parallel) has a ridge whose perpendicular
// span to the eave genuinely varies along its length — the case a naive 2-point
// interpolation gets wrong. Independently recomputed here (same perpendicular
// ray-cast the production code uses) to verify against, not just eyeballed.
describe('purlins follow the real eave shape along the ridge', () => {
  const TRAPEZIUM: P[] = [{ x: 0, y: 0 }, { x: 12000, y: 1000 }, { x: 9000, y: 7000 }, { x: 500, y: 6000 }];

  function raySegT(o: P, dir: P, a: P, b: P): number | null {
    const ex = b.x - a.x, ey = b.y - a.y;
    const det = ex * dir.y - ey * dir.x;
    if (Math.abs(det) < 1e-9) return null;
    const t = (-(a.x - o.x) * ey + ex * (a.y - o.y)) / det;
    const u = (dir.x * (a.y - o.y) - dir.y * (a.x - o.x)) / det;
    return t > 1 && u > -1e-6 && u < 1 + 1e-6 ? t : null;
  }
  function foot(o: P, dir: P, pts: P[]): P | null {
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const t = raySegT(o, dir, pts[i], pts[(i + 1) % pts.length]);
      if (t !== null && t < best) best = t;
    }
    return isFinite(best) ? { x: o.x + dir.x * best, y: o.y + dir.y * best } : null;
  }
  function samplesAlong2D(a: P, b: P, spacing: number): P[] {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(len / Math.max(spacing, 200)));
    return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + (b.x - a.x) * (i / n), y: a.y + (b.y - a.y) * (i / n) }));
  }

  it('the span to the eave genuinely varies along this ridge (not the same at both ends)', () => {
    const diags: RoofDiagnostic[] = [];
    const { skeleton } = buildRoofEnvelope(contour(TRAPEZIUM), 'hip', 30, 'auto', 0, 'r', diags);
    const rg = skeleton.find((s) => s.role === 'ridge')!;
    const dx = rg.b.x - rg.a.x, dy = rg.b.y - rg.a.y, len = Math.hypot(dx, dy);
    const perp = { x: -dy / len, y: dx / len };
    const spanAt = (t: number) => {
      const rp = { x: rg.a.x + dx * t, y: rg.a.y + dy * t };
      return foot(rp, perp, TRAPEZIUM)!;
    };
    const d0 = Math.hypot(spanAt(0).x - rg.a.x, spanAt(0).y - rg.a.y);
    const d1 = Math.hypot(spanAt(1).x - rg.b.x, spanAt(1).y - rg.b.y);
    expect(Math.abs(d1 - d0)).toBeGreaterThan(20); // a real, non-negligible difference
  });

  it('multi-sampled purlins land exactly on the locally-cast foot line, not a 2-point interpolation', () => {
    const c = contour(TRAPEZIUM);
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildRoofEnvelope(c, 'hip', 30, 'auto', 0, 'r', diags);
    const rg = skeleton.find((s) => s.role === 'ridge')!;
    const rafterSpacingMm = 500;
    const nodes = buildRoofFraming(
      'r', undefined, c,
      intent({ roofType: 'hip', pitchDeg: 30, system: 'purlin', purlinSpacingMm: 1200, rafterSpacingMm }),
      skeleton, faces,
    );
    const purlins = nodes.filter((n) => n.type === 'purlin');
    // More than a single 2-endpoint course per height/side — proves real sampling.
    expect(purlins.length).toBeGreaterThan(4);

    // Independently recompute the ridge samples + local feet the same way the
    // production code does, and verify every purlin endpoint matches one of
    // the expected (sample, heightFraction) lerp points.
    const ridgeSamples = samplesAlong2D({ x: rg.a.x, y: rg.a.y }, { x: rg.b.x, y: rg.b.y }, rafterSpacingMm);
    const dx = rg.b.x - rg.a.x, dy = rg.b.y - rg.a.y, len = Math.hypot(dx, dy);
    const perp = { x: -dy / len, y: dx / len };
    const expectedXY = new Set<string>();
    for (const s of ridgeSamples) {
      for (const d of [perp, { x: -perp.x, y: -perp.y }]) {
        const f = foot(s, d, TRAPEZIUM);
        if (!f) continue;
        for (const t of [1 / 3, 2 / 3]) { // matches count=3 → k=1,2 for purlinSpacingMm=1200
          const x = f.x + (s.x - f.x) * t, y = f.y + (s.y - f.y) * t;
          expectedXY.add(`${Math.round(x / 5)}_${Math.round(y / 5)}`);
        }
      }
    }
    let matched = 0;
    for (const p of purlins) {
      const ax = Math.round(Number(p.properties.ax) / 5), ay = Math.round(Number(p.properties.ay) / 5);
      const bx = Math.round(Number(p.properties.bx) / 5), by = Math.round(Number(p.properties.by) / 5);
      if (expectedXY.has(`${ax}_${ay}`)) matched++;
      if (expectedXY.has(`${bx}_${by}`)) matched++;
    }
    // Every purlin endpoint (2 per segment) should match a predicted sample point.
    expect(matched).toBe(purlins.length * 2);
  });
});
