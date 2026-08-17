import { describe, it, expect } from 'vitest';
import {
  buildRoofDetails, buildRoofEnvelope, coveringLiftMm, liftFacesZ,
  DEFAULT_ROOF_DETAILS, DEFAULT_ROOF_INTENT,
  type DetailContext, type RoofContour, type RoofDetailOptions, type RoofIntent, type RoofDiagnostic,
} from '@/lib/roof';

const contour = (points: { x: number; y: number }[], baseZ = 3000): RoofContour => ({
  points, axIds: [], baseZ, storeyId: 's',
});
const RECT = [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 8000 }, { x: 0, y: 8000 }];
const LSHAPE = [
  { x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 5000 },
  { x: 5000, y: 5000 }, { x: 5000, y: 10000 }, { x: 0, y: 10000 },
];

function ctxFor(
  points: { x: number; y: number }[], roofType: 'gable' | 'hip', details: Partial<RoofDetailOptions>,
): DetailContext {
  const c = contour(points);
  const diags: RoofDiagnostic[] = [];
  const { skeleton, faces } = buildRoofEnvelope(c, roofType, 30, 'auto', 0, 'r', diags);
  const intent: RoofIntent = { ...DEFAULT_ROOF_INTENT, roofType, details: { ...DEFAULT_ROOF_DETAILS, ...details } };
  return { roofId: 'r', parentId: undefined, contour: c, intent, skeleton, faces, baseZ: c.baseZ };
}

describe('roof details — opt-in behaviour', () => {
  it('generates nothing when every layer is off', () => {
    expect(buildRoofDetails(ctxFor(RECT, 'gable', {}))).toHaveLength(0);
  });
});

describe('covering lift above rafters', () => {
  it('default lift equals the rafter section height (no detail layers)', () => {
    // T8x16 rafter → 160 mm; no build-up, no user offset.
    expect(coveringLiftMm(DEFAULT_ROOF_INTENT)).toBeCloseTo(160, 3);
  });

  it('user covering offset adds on top of the automatic rafter clearance', () => {
    const base = coveringLiftMm(DEFAULT_ROOF_INTENT);
    const raised = coveringLiftMm({ ...DEFAULT_ROOF_INTENT, coveringOffsetMm: 120 });
    expect(raised).toBeCloseTo(base + 120, 3);
  });

  it('enabling thin build-up layers raises the covering further', () => {
    const bare = coveringLiftMm(DEFAULT_ROOF_INTENT);
    const withBuildup = coveringLiftMm({
      ...DEFAULT_ROOF_INTENT,
      details: { ...DEFAULT_ROOF_DETAILS, battens: true, counterBattens: true, membrane: true },
    });
    expect(withBuildup).toBeGreaterThan(bare);
  });

  it('liftFacesZ raises every face vertex above the structural plane', () => {
    const diags: RoofDiagnostic[] = [];
    const { faces } = buildRoofEnvelope(contour(RECT), 'gable', 30, 'auto', 0, 'r', diags);
    const lifted = liftFacesZ(faces, coveringLiftMm(DEFAULT_ROOF_INTENT));
    for (let i = 0; i < faces.length; i++) {
      for (let j = 0; j < faces[i].vertices.length; j++) {
        expect(lifted[i].vertices[j].z).toBeCloseTo(faces[i].vertices[j].z + 160, 3);
      }
    }
  });
});

describe('planar covering layers', () => {
  it('membrane/sheathing/insulation each produce one sheet per slope face, stacked inward', () => {
    const ctx = ctxFor(RECT, 'gable', { membrane: true, sheathing: true, insulation: true });
    const nodes = buildRoofDetails(ctx);
    expect(nodes.filter((n) => n.type === 'membrane')).toHaveLength(2); // 2 gable slopes
    expect(nodes.filter((n) => n.type === 'sheathing')).toHaveLength(2);
    expect(nodes.filter((n) => n.type === 'insulation')).toHaveLength(2);
    for (const n of nodes) {
      expect(n.properties.pitched).toBe(true);
      const verts = JSON.parse(String(n.properties.face_vertices)) as { x: number; y: number; z: number }[];
      expect(verts.length).toBeGreaterThanOrEqual(3);
    }
    // Insulation sits deeper (further inward) than sheathing than membrane → lower mean z on a slope.
    const meanZ = (t: string) => {
      const ns = nodes.filter((n) => n.type === t);
      return ns.reduce((s, n) => s + Number(n.z), 0) / ns.length;
    };
    expect(meanZ('insulation')).toBeLessThan(meanZ('sheathing'));
    expect(meanZ('sheathing')).toBeLessThan(meanZ('membrane'));
  });

  it('hip roof → one sheet per each of the 4 faces', () => {
    const ctx = ctxFor(RECT, 'hip', { membrane: true });
    expect(buildRoofDetails(ctx).filter((n) => n.type === 'membrane')).toHaveLength(4);
  });
});

describe('batten grid', () => {
  it('battens run across the slope (parallel to eave), counter-battens up the slope', () => {
    const ctx = ctxFor(RECT, 'gable', { battens: true, counterBattens: true, battenSpacingMm: 400, counterBattenSpacingMm: 700 });
    const nodes = buildRoofDetails(ctx);
    const battens = nodes.filter((n) => n.type === 'batten');
    const counters = nodes.filter((n) => n.type === 'counter_batten');
    expect(battens.length).toBeGreaterThan(0);
    expect(counters.length).toBeGreaterThan(0);

    // A batten on the south slope (ridge along X) runs mostly in X (parallel to the eave).
    const runX = (n: typeof battens[number]) => Math.abs(Number(n.properties.bx) - Number(n.properties.ax));
    const runY = (n: typeof battens[number]) => Math.abs(Number(n.properties.by) - Number(n.properties.ay));
    // At least one batten spans a long X extent (across the 10 m width).
    expect(Math.max(...battens.map(runX))).toBeGreaterThan(5000);
    // Counter-battens climb the slope → notable Z change end-to-end.
    const runZ = (n: typeof counters[number]) => Math.abs(Number(n.properties.bz) - Number(n.properties.az));
    expect(Math.max(...counters.map(runZ))).toBeGreaterThan(500);
    void runY;
  });
});

describe('edge trim (eave vs rake classification)', () => {
  it('gable: fascia on both eaves, barge boards on the rake edges', () => {
    const ctx = ctxFor(RECT, 'gable', { fascia: true, bargeBoard: true, gutters: true });
    const nodes = buildRoofDetails(ctx);
    // A gable has 2 eaves (the two long sides) and 2 rake pairs (gable ends) → boards present.
    expect(nodes.filter((n) => n.type === 'fascia').length).toBe(2);
    expect(nodes.filter((n) => n.type === 'gutter').length).toBe(2);
    expect(nodes.filter((n) => n.type === 'barge_board').length).toBeGreaterThan(0);
    // Fascia hangs below the (lifted) covering eave — above the structural 3000,
    // since the covering now sits above the rafters (rafter T8x16 → +160 mm lift).
    for (const f of nodes.filter((n) => n.type === 'fascia')) {
      expect(Number(f.properties.az)).toBeLessThan(3160 + 1); // below the covering eave
      expect(Number(f.properties.az)).toBeGreaterThan(2950);   // still hanging near the eave
    }
  });

  it('hip: fascia on all 4 eaves, no rake edges → no barge boards', () => {
    const ctx = ctxFor(RECT, 'hip', { fascia: true, bargeBoard: true });
    const nodes = buildRoofDetails(ctx);
    expect(nodes.filter((n) => n.type === 'fascia').length).toBe(4);
    expect(nodes.filter((n) => n.type === 'barge_board')).toHaveLength(0);
  });
});

describe('ridge/hip/valley finishing', () => {
  it('ridge caps on a gable, hip caps + valley flashing on an L-hip', () => {
    const gable = buildRoofDetails(ctxFor(RECT, 'gable', { ridgeCaps: true }));
    expect(gable.filter((n) => n.type === 'ridge_cap').length).toBeGreaterThanOrEqual(1);

    const lhip = buildRoofDetails(ctxFor(LSHAPE, 'hip', { hipCaps: true, valleyFlashing: true }));
    expect(lhip.filter((n) => n.type === 'hip_cap').length).toBeGreaterThan(0);
    expect(lhip.filter((n) => n.type === 'valley_flashing').length).toBeGreaterThan(0);
  });
});

describe('drainage', () => {
  it('downpipes drop vertically and snow guards sit near the eave', () => {
    const ctx = ctxFor(RECT, 'gable', { downpipes: true, gutters: true, snowGuards: true, downpipeSpacingMm: 6000 });
    const nodes = buildRoofDetails(ctx);
    const pipes = nodes.filter((n) => n.type === 'downpipe');
    expect(pipes.length).toBeGreaterThan(0);
    for (const p of pipes) {
      // vertical: same x/y at both ends, big z drop, round profile
      expect(Number(p.properties.ax)).toBeCloseTo(Number(p.properties.bx), 3);
      expect(Number(p.properties.ay)).toBeCloseTo(Number(p.properties.by), 3);
      expect(Number(p.properties.az) - Number(p.properties.bz)).toBeGreaterThan(1000);
      expect(p.properties.round).toBe(true);
    }
    expect(nodes.filter((n) => n.type === 'snow_guard').length).toBeGreaterThan(0);
  });
});

describe('collar ties', () => {
  it('sit at the configured height fraction between the slopes', () => {
    const ctx = ctxFor(RECT, 'gable', { collarTies: true, collarHeightRatio: 0.6 });
    const ties = buildRoofDetails(ctx).filter((n) => n.type === 'collar_tie');
    expect(ties.length).toBeGreaterThan(0);
    // rise = 4000 * tan30 ≈ 2309; collar z ≈ base + 0.6*rise
    const rise = 4000 * Math.tan((30 * Math.PI) / 180);
    for (const t of ties) {
      expect(Number(t.properties.az)).toBeCloseTo(3000 + 0.6 * rise, -1);
      expect(Number(t.properties.az)).toBeCloseTo(Number(t.properties.bz), 3); // horizontal
    }
  });
});
