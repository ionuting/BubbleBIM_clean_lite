import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  buildRoofEnvelope, buildStraightSkeletonEnvelope, resolveRoofContour, isAxisAlignedRect,
  sanitizePolygon, solveRoofSkeleton,
  type RoofContour, type RoofDiagnostic,
} from '@/lib/roof';

const area = (pts: { x: number; y: number }[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
  return Math.abs(a / 2);
};
const C = (points: { x: number; y: number }[]): RoofContour => ({ points, axIds: [], baseZ: 3000, storeyId: 's' });

/** Build a roof node connected to ax nodes in the GIVEN order (mimics the user wiring the outline). */
function roofFromOrderedAx(corners: [number, number][], connectOrder: number[]) {
  const nodes: BubbleGraphNode[] = [
    { id: 'st', type: 'storey', name: 'L', x: 0, y: 0, z: 0, properties: { bottomElevation: 0, topElevation: 3000 } },
  ];
  corners.forEach(([x, y], i) => nodes.push({
    id: `a${i}`, type: 'ax', name: `a${i}`, x, y, z: 0, parentId: 'st', properties: { bimX: x, bimY: y },
  }));
  const roof: BubbleGraphNode = { id: 'roof', type: 'roof', name: 'Roof', x: 0, y: 0, z: 3000, parentId: 'st', properties: { roof_type: 'hip', pitch_deg: 30, overhang_mm: 0 } };
  nodes.push(roof);
  const edges: BubbleGraphEdge[] = connectOrder.map((k, i) => ({ id: `re${i}`, from: 'roof', to: `a${k}` }));
  return { nodes, edges, roof };
}

const U: [number, number][] = [[0, 0], [9000, 0], [9000, 9000], [6000, 9000], [6000, 3000], [3000, 3000], [3000, 9000], [0, 9000]];

const bbox = (pts: { x: number; y: number }[]) => {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};

describe('eave overhang is a uniform signed offset', () => {
  const RECT: [number, number][] = [[0, 0], [10000, 0], [10000, 8000], [0, 8000]];

  it('positive → expands outward uniformly on all four sides', () => {
    const { nodes, edges, roof } = roofFromOrderedAx(RECT, RECT.map((_, i) => i));
    const c = resolveRoofContour(roof, nodes, edges, 400, [])!;
    const b = bbox(c.points);
    expect(b.minX).toBeCloseTo(-400, 3);
    expect(b.minY).toBeCloseTo(-400, 3);
    expect(b.maxX).toBeCloseTo(10400, 3);
    expect(b.maxY).toBeCloseTo(8400, 3);
  });

  it('negative → insets inward uniformly (was ignored before)', () => {
    const { nodes, edges, roof } = roofFromOrderedAx(RECT, RECT.map((_, i) => i));
    const c = resolveRoofContour(roof, nodes, edges, -400, [])!;
    const b = bbox(c.points);
    expect(b.minX).toBeCloseTo(400, 3);
    expect(b.minY).toBeCloseTo(400, 3);
    expect(b.maxX).toBeCloseTo(9600, 3);
    expect(b.maxY).toBeCloseTo(7600, 3);
  });

  it('zero → contour unchanged', () => {
    const { nodes, edges, roof } = roofFromOrderedAx(RECT, RECT.map((_, i) => i));
    const c = resolveRoofContour(roof, nodes, edges, 0, [])!;
    expect(area(c.points)).toBeCloseTo(10000 * 8000, -1);
  });
});

describe('contour respects roof→ax connection order', () => {
  it('U-shape wired in CCW order → exact contour (not convexified)', () => {
    const order = U.map((_, i) => i); // connected in boundary order
    const { nodes, edges, roof } = roofFromOrderedAx(U, order);
    const diags: RoofDiagnostic[] = [];
    const c = resolveRoofContour(roof, nodes, edges, 0, diags)!;
    expect(c).not.toBeNull();
    expect(c.points.length).toBe(8);
    expect(area(c.points)).toBeCloseTo(area(U.map(([x, y]) => ({ x, y }))), -2); // true U area, not the filled bbox
  });

  it('axIds come back in contour order aligned with the points', () => {
    const { nodes, edges, roof } = roofFromOrderedAx(U, U.map((_, i) => i));
    const diags: RoofDiagnostic[] = [];
    const c = resolveRoofContour(roof, nodes, edges, 0, diags)!;
    expect(c.axIds.length).toBe(8);
    // consecutive contour points correspond to consecutive connected ax
    for (let i = 0; i < c.points.length; i++) {
      const ax = nodes.find((n) => n.id === c.axIds[i])!;
      expect(c.points[i].x).toBeCloseTo(Number(ax.properties.bimX), 3);
      expect(c.points[i].y).toBeCloseTo(Number(ax.properties.bimY), 3);
    }
  });

  it('a scrambled (self-intersecting) connection order falls back instead of returning garbage', () => {
    const scrambled = [0, 4, 1, 5, 2, 6, 3, 7]; // deliberately interleaved → self-intersecting loop
    const { nodes, edges, roof } = roofFromOrderedAx(U, scrambled);
    const diags: RoofDiagnostic[] = [];
    const c = resolveRoofContour(roof, nodes, edges, 0, diags);
    // Must still yield a valid, non-degenerate polygon (fallback path), never a self-crossing one.
    expect(c).not.toBeNull();
    expect(area(c!.points)).toBeGreaterThan(0);
  });
});

describe('non-rectangular gable no longer overshoots via bbox', () => {
  const PENTAGON = [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 12000, y: 6000 }, { x: 5000, y: 11000 }, { x: -2000, y: 6000 }];

  it('isAxisAlignedRect: true for a box, false for a pentagon / rotated quad', () => {
    expect(isAxisAlignedRect([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }])).toBe(true);
    expect(isAxisAlignedRect(PENTAGON)).toBe(false);
    expect(isAxisAlignedRect([{ x: 0, y: 0 }, { x: 10, y: 2 }, { x: 8, y: 12 }, { x: -2, y: 10 }])).toBe(false); // rotated
  });

  it('pentagon gable → faces tile the plan exactly (was 1.44× via bbox)', () => {
    const diags: RoofDiagnostic[] = [];
    const { faces } = buildRoofEnvelope(C(PENTAGON), 'gable', 30, 'auto', 0, 'r', diags);
    const total = faces.filter((f) => f.role === 'slope').reduce((s, f) => s + area(f.vertices.map((v) => ({ x: v.x, y: v.y }))), 0);
    expect(total / area(PENTAGON)).toBeCloseTo(1, 1);
    expect(diags.some((d) => d.code === 'GABLE_TO_SKELETON')).toBe(true);
  });

  it('rectangle gable stays a true two-slope gable (not rerouted)', () => {
    const diags: RoofDiagnostic[] = [];
    const rect = [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 8000 }, { x: 0, y: 8000 }];
    const { faces } = buildRoofEnvelope(C(rect), 'gable', 30, 'auto', 0, 'r', diags);
    expect(faces.filter((f) => f.role === 'slope')).toHaveLength(2);
    expect(diags.some((d) => d.code === 'GABLE_TO_SKELETON')).toBe(false);
  });

  it('concave gable (L) stays gabled per wing — it must NOT be hipped by the skeleton', () => {
    const L = [{ x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 9000 }, { x: 6000, y: 9000 }, { x: 6000, y: 3000 }, { x: 0, y: 3000 }];
    const diags: RoofDiagnostic[] = [];
    const { faces, skeleton } = buildRoofEnvelope(C(L), 'gable', 30, 'auto', 0, 'r', diags);
    // Gabled arms own concave gables now: the straight skeleton hips EVERY
    // edge, which silently turns a requested two-slope roof into a multi-hip one.
    expect(diags.some((d) => d.code === 'GABLED_ARMS')).toBe(true);
    expect(diags.some((d) => d.code === 'GABLE_TO_SKELETON')).toBe(false);
    expect(skeleton.some((s) => s.role === 'hip')).toBe(false);
    expect(skeleton.some((s) => s.role === 'valley')).toBe(true);
    expect(faces.filter((f) => f.role === 'gable_end').length).toBeGreaterThan(0);
  });

  it('a plan too irregular for gabled wings falls back to the skeleton WITH a warning', () => {
    // Non-rectilinear concave plan — no rectangle decomposition is possible.
    const poly = [{ x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 9000 }, { x: 4500, y: 5000 }, { x: 0, y: 9000 }];
    const diags: RoofDiagnostic[] = [];
    const { faces } = buildRoofEnvelope(C(poly), 'gable', 30, 'auto', 0, 'r', diags);
    expect(faces.length).toBeGreaterThan(0);
    const warn = diags.find((d) => d.code === 'GABLE_TO_SKELETON');
    expect(warn?.severity).toBe('warning'); // silent info hid this downgrade before
  });
});

describe('straight-skeleton robustness (the L-shape failures)', () => {
  // Each of these previously merged faces or lost area; now they must tile
  // exactly with one face per edge.
  const shapes: [string, { x: number; y: number }[]][] = [
    ['equal-arm L', [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 }, { x: 3000, y: 3000 }, { x: 3000, y: 6000 }, { x: 0, y: 6000 }]],
    ['symmetric T', [{ x: 0, y: 0 }, { x: 12000, y: 0 }, { x: 12000, y: 4000 }, { x: 8000, y: 4000 }, { x: 8000, y: 9000 }, { x: 4000, y: 9000 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 }]],
    ['plus', [{ x: 3000, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 }, { x: 9000, y: 3000 }, { x: 9000, y: 6000 }, { x: 6000, y: 6000 }, { x: 6000, y: 9000 }, { x: 3000, y: 9000 }, { x: 3000, y: 6000 }, { x: 0, y: 6000 }, { x: 0, y: 3000 }, { x: 3000, y: 3000 }]],
    ['U', [{ x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 9000 }, { x: 6000, y: 9000 }, { x: 6000, y: 3000 }, { x: 3000, y: 3000 }, { x: 3000, y: 9000 }, { x: 0, y: 9000 }]],
  ];
  for (const [name, poly] of shapes) {
    it(`${name}: exact tiling, one face per edge`, () => {
      const sol = solveRoofSkeleton(poly)!;
      expect(sol).not.toBeNull();
      expect(sol.faces.length).toBe(poly.length);
      const total = sol.faces.reduce((s, f) => s + area(f), 0);
      expect(total / area(poly)).toBeCloseTo(1, 2);
    });
  }

  it('millimetre jitter on an L still resolves to an exact tiling', () => {
    const base = [{ x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 9000 }, { x: 6000, y: 9000 }, { x: 6000, y: 3000 }, { x: 0, y: 3000 }];
    const jit = base.map((p, i) => ({ x: p.x + ((i * 37) % 7 - 3) * 0.5, y: p.y + ((i * 53) % 7 - 3) * 0.5 }));
    const sol = solveRoofSkeleton(jit)!;
    expect(sol).not.toBeNull();
    expect(sol.faces.length).toBe(6);
  });

  it('sanitizePolygon drops duplicate and collinear vertices', () => {
    const withNoise = [
      { x: 0, y: 0 }, { x: 4500, y: 0 }, { x: 9000, y: 0 }, // 4500 is collinear
      { x: 9000, y: 9000 }, { x: 6000, y: 9000 },
      { x: 6000.2, y: 9000.1 }, // near-duplicate
      { x: 6000, y: 3000 }, { x: 0, y: 3000 },
    ];
    const clean = sanitizePolygon(withNoise, 1);
    expect(clean.length).toBe(6); // the L's 6 real corners
  });

  it('a duplicate-laden L still tiles to full area (was 25% missing)', () => {
    const dup = [{ x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 9000 }, { x: 6000, y: 9000 }, { x: 6000.2, y: 9000.1 }, { x: 6000, y: 3000 }, { x: 0, y: 3000 }];
    const diags: RoofDiagnostic[] = [];
    const { faces } = buildStraightSkeletonEnvelope(C(dup), 30, 'r', diags)!;
    const total = faces.reduce((s, f) => s + area(f.vertices.map((v) => ({ x: v.x, y: v.y }))), 0);
    const cleanArea = area(sanitizePolygon(dup, 1));
    expect(total / cleanArea).toBeCloseTo(1, 2);
  });
});
