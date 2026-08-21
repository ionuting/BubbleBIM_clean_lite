import { describe, it, expect } from 'vitest';
import {
  buildMansardEnvelope,
  buildCrossGableEnvelope,
  buildRoofEnvelope,
  buildRoofFraming,
  decomposeToRects,
  DEFAULT_ROOF_INTENT,
  type RoofContour,
  type RoofDiagnostic,
  type RoofIntent,
} from '@/lib/roof';

const rect = (w: number, h: number, baseZ = 3000): RoofContour => ({
  points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
  axIds: [], baseZ, storeyId: 's',
});

/** L-shape (CCW): 10×10 m with the top-right 5×5 m quadrant removed. */
const lShape = (baseZ = 3000): RoofContour => ({
  points: [
    { x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 5000 },
    { x: 5000, y: 5000 }, { x: 5000, y: 10000 }, { x: 0, y: 10000 },
  ],
  axIds: [], baseZ, storeyId: 's',
});

const intent = (over: Partial<RoofIntent>): RoofIntent => ({ ...DEFAULT_ROOF_INTENT, ...over });

// ── Mansard: true two-pitch ──────────────────────────────────────────────────
describe('mansard two-pitch envelope', () => {
  it('builds a steep lower skirt + shallow upper hip on 12×10 m', () => {
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildMansardEnvelope(rect(12000, 10000), 70, 20, 1500, 'auto', 0, 'r', diags);
    expect(diags.filter((d) => d.severity === 'error')).toHaveLength(0);

    expect(skeleton.filter((s) => s.role === 'ridge')).toHaveLength(1);
    expect(skeleton.filter((s) => s.role === 'break')).toHaveLength(4);
    expect(skeleton.filter((s) => s.role === 'eave')).toHaveLength(4);
    expect(skeleton.filter((s) => s.role === 'hip')).toHaveLength(8); // 4 lower folds + 4 upper
    expect(faces).toHaveLength(8); // 4 lower trapezoids + 4 upper hip faces

    // Break ring height from the LOWER (steep) pitch over the 1500 mm inset.
    const zBreak = 3000 + 1500 * Math.tan((70 * Math.PI) / 180);
    const brk = skeleton.find((s) => s.role === 'break')!;
    expect(brk.a.z).toBeCloseTo(zBreak, 0);

    // Ridge is above the break, and rises with the shallow upper pitch.
    const ridge = skeleton.find((s) => s.role === 'ridge')!;
    const zRidge = zBreak + 3500 * Math.tan((20 * Math.PI) / 180);
    expect(ridge.a.z).toBeCloseTo(zRidge, 0);
    expect(ridge.a.z).toBeGreaterThan(brk.a.z);
    expect(brk.a.z).toBeGreaterThan(3000);
  });

  it('falls back to hip when the plan is too small for a break ring', () => {
    const diags: RoofDiagnostic[] = [];
    const { skeleton } = buildMansardEnvelope(rect(2500, 2500), 70, 20, 1500, 'auto', 0, 'r', diags);
    expect(diags.some((d) => d.code === 'MANSARD_TOO_SMALL')).toBe(true);
    expect(skeleton.filter((s) => s.role === 'break')).toHaveLength(0);
  });

  it('routes roofType=mansard through the two-pitch builder (break lines present)', () => {
    const diags: RoofDiagnostic[] = [];
    const { skeleton } = buildRoofEnvelope(rect(12000, 10000), 'mansard', 70, 'auto', 0, 'r', diags, 20, 1500);
    expect(skeleton.some((s) => s.role === 'break')).toBe(true);
  });
});

// ── Cross-gable: L-shape valleys ─────────────────────────────────────────────
describe('cross-gable with real valleys (L-shape)', () => {
  it('decomposes the L into two rectangles', () => {
    const rects = decomposeToRects(lShape().points);
    expect(rects).toHaveLength(2);
  });

  it('produces two ridges and a valley from the reflex corner', () => {
    const diags: RoofDiagnostic[] = [];
    const res = buildCrossGableEnvelope(lShape(), 30, 'r', diags)!;
    expect(res).not.toBeNull();
    expect(res.skeleton.filter((s) => s.role === 'ridge')).toHaveLength(2);
    const valleys = res.skeleton.filter((s) => s.role === 'valley');
    expect(valleys.length).toBeGreaterThanOrEqual(1);
    expect(res.faces.filter((f) => f.role === 'slope')).toHaveLength(4); // two slopes per wing
    // Frontons only on the FREE wing ends — the end that opens into the other
    // wing must stay open (3 free ends on an L, not 4).
    expect(res.faces.filter((f) => f.role === 'gable_end')).toHaveLength(3);

    // Equal spans (2.5 m half-span each) → equal ridge height at 30°.
    const zR = 3000 + 2500 * Math.tan((30 * Math.PI) / 180);
    for (const rg of res.skeleton.filter((s) => s.role === 'ridge')) {
      expect(rg.a.z).toBeCloseTo(zR, 0);
    }
    // Valley runs from the reflex corner (base) up to the ridge junction.
    const v = valleys[0];
    expect(v.a.z).toBeCloseTo(3000, 0);
    expect(v.b.z).toBeCloseTo(zR, 0);
    expect(v.a.x).toBeCloseTo(5000, 0);
    expect(v.a.y).toBeCloseTo(5000, 0);
  });

  it('a plain rectangle gable has no valleys (routing untouched)', () => {
    const diags: RoofDiagnostic[] = [];
    const { skeleton } = buildRoofEnvelope(rect(10000, 8000), 'gable', 30, 'auto', 0, 'r', diags);
    expect(skeleton.filter((s) => s.role === 'valley')).toHaveLength(0);
  });

  it('buildRoofEnvelope routes an L-shape gable to the cross-gable (valley present)', () => {
    const diags: RoofDiagnostic[] = [];
    const { skeleton } = buildRoofEnvelope(lShape(), 'gable', 30, 'auto', 0, 'r', diags);
    expect(skeleton.some((s) => s.role === 'valley')).toBe(true);
  });
});

// ── Framing systems: truss + purlin ──────────────────────────────────────────
function gableFraming(system: RoofIntent['system'], over: Partial<RoofIntent> = {}) {
  const contour = rect(10000, 8000);
  const diags: RoofDiagnostic[] = [];
  const { skeleton, faces } = buildRoofEnvelope(contour, 'gable', 30, 'auto', 0, 'r', diags);
  const it = intent({ roofType: 'gable', pitchDeg: 30, system, ...over });
  return buildRoofFraming('r', undefined, contour, it, skeleton, faces);
}

describe('framing systems', () => {
  it('rafter system (default) makes common rafters + posts, no trusses', () => {
    const nodes = gableFraming('rafter');
    expect(nodes.filter((n) => n.type === 'rafter').length).toBeGreaterThan(4);
    expect(nodes.filter((n) => n.type === 'tie_beam')).toHaveLength(0);
    expect(nodes.filter((n) => n.type === 'purlin')).toHaveLength(0);
    expect(nodes.some((n) => n.type === 'post')).toBe(true);
  });

  it('truss system makes tie beams + king posts at truss spacing', () => {
    const nodes = gableFraming('truss', { trussSpacingMm: 3000 });
    const ties = nodes.filter((n) => n.type === 'tie_beam');
    expect(ties.length).toBeGreaterThanOrEqual(1);
    // One king post per truss, plus truss top-chord rafters.
    expect(nodes.some((n) => n.type === 'post' && n.properties.role === 'king_post')).toBe(true);
    expect(nodes.some((n) => n.type === 'rafter' && n.properties.role === 'truss_chord')).toBe(true);
    // Trusses carry their own posts — no separate ridge posts.
    expect(nodes.some((n) => n.type === 'post' && n.properties.role === 'post')).toBe(false);
  });

  it('purlin system makes purlins + principal rafters', () => {
    const nodes = gableFraming('purlin', { purlinSpacingMm: 1200, trussSpacingMm: 3000 });
    expect(nodes.filter((n) => n.type === 'purlin').length).toBeGreaterThan(0);
    expect(nodes.some((n) => n.type === 'rafter' && n.properties.role === 'principal')).toBe(true);
  });

  it('cross-gable framing emits valley rafters', () => {
    const contour = lShape();
    const diags: RoofDiagnostic[] = [];
    const { skeleton, faces } = buildRoofEnvelope(contour, 'gable', 30, 'auto', 0, 'r', diags);
    const nodes = buildRoofFraming('r', undefined, contour, intent({ roofType: 'gable', pitchDeg: 30 }), skeleton, faces);
    expect(nodes.some((n) => n.type === 'valley_rafter')).toBe(true);
    expect(nodes.filter((n) => n.type === 'ridge_beam').length).toBe(2); // one per wing
  });
});
