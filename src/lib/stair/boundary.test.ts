import { describe, expect, it } from 'vitest';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { checkStairFits, resolveStairBoundary } from './boundary';
import { occupiedCorners } from './layout';
import { computeStairGeometry, solveStair } from './solver';
import { DEFAULT_STAIR_INTENT, type StairDiagnostic, type StairIntent } from './types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function node(id: string, type: string, x: number, y: number, props: Record<string, unknown> = {}): BubbleGraphNode {
  return { id, type, name: id, x, y, z: 0, properties: props } as BubbleGraphNode;
}

function edge(from: string, to: string): BubbleGraphEdge {
  return { id: `${from}->${to}`, from, to } as BubbleGraphEdge;
}

/** Two storeys 2900 mm apart, which is the worked example the sizing tests use. */
function storeys(): BubbleGraphNode[] {
  return [
    node('s0', 'storey', 0, 0, { bottomElevation: 0, topElevation: 2900 }),
    node('s1', 'storey', 0, 0, { bottomElevation: 2900, topElevation: 5800 }),
  ];
}

/**
 * A shaft as the user draws it: four ax nodes wired to the stairwell in contour
 * order. `bimX/bimY` is the explicit-coordinate path through `planPos`.
 */
function shaft(
  corners: [number, number][],
  stairAt: [number, number] = [0, 0],
  props: Record<string, unknown> = {},
): { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } {
  const axes = corners.map(([x, y], i) =>
    node(`a${i}`, 'ax', x, y, { bimX: x, bimY: y }));
  const stair = node('st', 'stairwell', stairAt[0], stairAt[1], props);
  stair.parentId = 's0';
  return {
    nodes: [...storeys(), ...axes, stair],
    edges: axes.map((a) => edge('st', a.id)),
  };
}

const intentOf = (over: Partial<StairIntent> = {}): StairIntent => ({ ...DEFAULT_STAIR_INTENT, ...over });

// ── Reading the shaft ────────────────────────────────────────────────────────

describe('resolveStairBoundary', () => {
  it('ignores a stairwell with fewer than three axes wired', () => {
    const { nodes, edges } = shaft([[0, 0], [5000, 0]]);
    expect(resolveStairBoundary(nodes.find((n) => n.id === 'st')!, nodes, edges, intentOf())).toBeNull();
  });

  it('takes the polygon from the connection order', () => {
    const { nodes, edges } = shaft([[0, 0], [5000, 0], [5000, 2000], [0, 2000]]);
    const b = resolveStairBoundary(nodes.find((n) => n.id === 'st')!, nodes, edges, intentOf())!;
    expect(b.polygon).toHaveLength(4);
    expect(b.axIds).toHaveLength(4);
  });

  it('keeps a concave shaft concave instead of convexifying it', () => {
    // An L: an angular sort around the centroid would cut the notch off.
    const { nodes, edges } = shaft([
      [0, 0], [5000, 0], [5000, 2000], [2000, 2000], [2000, 4000], [0, 4000],
    ]);
    const b = resolveStairBoundary(nodes.find((n) => n.id === 'st')!, nodes, edges, intentOf())!;
    const hasNotch = b.polygon.some((p) => p.x === 2000 && p.y === 2000);
    expect(hasNotch).toBe(true);
    expect(b.polygon).toHaveLength(6);
  });

  it('runs lengthways along the shaft', () => {
    const { nodes, edges } = shaft([[0, 0], [5000, 0], [5000, 2000], [0, 2000]]);
    const b = resolveStairBoundary(nodes.find((n) => n.id === 'st')!, nodes, edges, intentOf())!;
    expect(Math.abs(b.directionDeg % 180)).toBeCloseTo(0, 6);   // along X, the long side
  });

  it('runs lengthways when the long side is the other one', () => {
    const { nodes, edges } = shaft([[0, 0], [2000, 0], [2000, 5000], [0, 5000]]);
    const b = resolveStairBoundary(nodes.find((n) => n.id === 'st')!, nodes, edges, intentOf())!;
    expect(Math.abs(b.directionDeg) % 180).toBeCloseTo(90, 6);  // along Y
  });

  it('climbs away from the end the node sits at', () => {
    const box: [number, number][] = [[0, 0], [5000, 0], [5000, 2000], [0, 2000]];

    const near = shaft(box, [200, 1000]);
    const a = resolveStairBoundary(near.nodes.find((n) => n.id === 'st')!, near.nodes, near.edges, intentOf())!;
    expect(a.directionDeg).toBeCloseTo(0, 6);
    expect(a.origin.x).toBeCloseTo(0, 6);

    const far = shaft(box, [4800, 1000]);
    const b = resolveStairBoundary(far.nodes.find((n) => n.id === 'st')!, far.nodes, far.edges, intentOf())!;
    expect(Math.abs(b.directionDeg)).toBeCloseTo(180, 6);
    expect(b.origin.x).toBeCloseTo(5000, 6);
  });

  it('centres a straight flight across the shaft', () => {
    const { nodes, edges } = shaft([[0, 0], [5000, 0], [5000, 2000], [0, 2000]]);
    const b = resolveStairBoundary(nodes.find((n) => n.id === 'st')!, nodes, edges, intentOf())!;
    expect(b.origin.y).toBeCloseTo(1000, 6);
  });

  it('offsets a half-turn so the two flights straddle the centre line', () => {
    const { nodes, edges } = shaft([[0, 0], [5000, 0], [5000, 2400], [0, 2400]]);
    const st = nodes.find((n) => n.id === 'st')!;
    const intent = intentOf({ stairType: 'u_shape', turn: 'left', widthMm: 1000 });
    const b = resolveStairBoundary(st, nodes, edges, intent)!;
    // Flight 1 at 700, flight 2 one width above at 1700 — centred on 1200.
    expect(b.origin.y).toBeCloseTo(1200 - 500, 6);
  });

  it('falls back to an angular sort when the axes are wired out of order', () => {
    // A bow tie: 3rd and 4th corner swapped, so the ring self-crosses.
    const { nodes, edges } = shaft([[0, 0], [5000, 0], [0, 2000], [5000, 2000]]);
    const b = resolveStairBoundary(nodes.find((n) => n.id === 'st')!, nodes, edges, intentOf())!;
    expect(b.polygon).toHaveLength(4);
    expect(Math.abs(b.directionDeg % 180)).toBeCloseTo(0, 6);
  });

  it('gives up on axes that are collinear rather than returning a degenerate shaft', () => {
    const { nodes, edges } = shaft([[0, 0], [2000, 0], [5000, 0]]);
    expect(resolveStairBoundary(nodes.find((n) => n.id === 'st')!, nodes, edges, intentOf())).toBeNull();
  });
});

// ── The fit check ────────────────────────────────────────────────────────────

describe('checkStairFits', () => {
  const boundary = {
    polygon: [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 2000 }, { x: 0, y: 2000 }],
    axIds: [],
    origin: { x: 0, y: 1000 },
    directionDeg: 0,
  };

  it('passes a stair inside the shaft', () => {
    const diags: StairDiagnostic[] = [];
    const corners = [{ x: 100, y: 600 }, { x: 4000, y: 600 }, { x: 4000, y: 1400 }, { x: 100, y: 1400 }];
    expect(checkStairFits(corners, boundary, diags)).toBe(true);
    expect(diags).toHaveLength(0);
  });

  it('counts a corner exactly on the boundary as inside', () => {
    const diags: StairDiagnostic[] = [];
    const corners = [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 2000 }, { x: 0, y: 2000 }];
    expect(checkStairFits(corners, boundary, diags)).toBe(true);
    expect(diags).toHaveLength(0);
  });

  it('reports how far the run overruns, in millimetres', () => {
    const diags: StairDiagnostic[] = [];
    const corners = [{ x: 0, y: 600 }, { x: 6200, y: 600 }, { x: 6200, y: 1400 }, { x: 0, y: 1400 }];
    expect(checkStairFits(corners, boundary, diags)).toBe(false);
    expect(diags[0].code).toBe('DOES_NOT_FIT');
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].message).toContain('1200 mm along the run');
    expect(diags[0].message).toContain('the shaft is 5000 mm');
  });

  it('reports the width separately from the run', () => {
    const diags: StairDiagnostic[] = [];
    const corners = [{ x: 100, y: -400 }, { x: 4000, y: -400 }, { x: 4000, y: 2400 }, { x: 100, y: 2400 }];
    checkStairFits(corners, boundary, diags);
    expect(diags[0].message).toContain('across');
    expect(diags[0].message).not.toContain('along the run');
  });
});

// ── End to end, through the solver ───────────────────────────────────────────

describe('a stairwell wired to axes', () => {
  it('positions and orients the stair from the shaft, not from direction_deg', () => {
    // direction_deg says 0 (east) but the shaft runs north — the shaft wins.
    const { nodes, edges } = shaft([[0, 0], [2000, 0], [2000, 5000], [0, 5000]], [1000, 100], {
      direction_deg: 0,
    });
    const { geometry } = computeStairGeometry(nodes.find((n) => n.id === 'st')!, nodes, edges);
    expect(geometry).not.toBeNull();
    expect(geometry!.boundary).toHaveLength(4);
    // The walking line climbs in +Y, starting on the shaft's south edge.
    const [first, last] = [geometry!.baseline[0], geometry!.baseline[geometry!.baseline.length - 1]];
    expect(first.y).toBeCloseTo(0, 6);
    expect(last.y).toBeGreaterThan(first.y);
    expect(Math.abs(last.x - first.x)).toBeLessThan(1);
  });

  it('leaves the stair on the node when no axes are wired', () => {
    const nodes = [...storeys(), { ...node('st', 'stairwell', 1234, 5678), parentId: 's0' } as BubbleGraphNode];
    const { geometry } = computeStairGeometry(nodes[2], nodes, []);
    expect(geometry!.boundary).toBeNull();
    expect(geometry!.baseline[0].x).toBeCloseTo(1234, 6);
    expect(geometry!.baseline[0].y).toBeCloseTo(5678, 6);
  });

  it('warns when the flight is too long for the shaft', () => {
    // 17 risers at 280 mm going needs ~4.48 m; the shaft is 3 m.
    const { nodes, edges } = shaft([[0, 0], [3000, 0], [3000, 1400], [0, 1400]], [0, 700]);
    const { diagnostics } = computeStairGeometry(nodes.find((n) => n.id === 'st')!, nodes, edges);
    expect(diagnostics.some((d) => d.code === 'DOES_NOT_FIT')).toBe(true);
  });

  it('does not warn when the same rise is split into two flights that fit', () => {
    // 9 risers up (8 goings = 2311 mm) plus a 1000 mm landing = 3311 along the
    // run, and two 1000 mm flights side by side across.
    const { nodes, edges } = shaft([[0, 0], [3600, 0], [3600, 2400], [0, 2400]], [0, 1200], {
      stair_type: 'u_shape',
      width_mm: 1000,
    });
    const { diagnostics } = computeStairGeometry(nodes.find((n) => n.id === 'st')!, nodes, edges);
    expect(diagnostics.some((d) => d.code === 'DOES_NOT_FIT')).toBe(false);
  });

  it('sizes the slab opening from the shaft, exactly as drawn', () => {
    const { nodes, edges } = shaft([[0, 0], [3000, 0], [3000, 2400], [0, 2400]], [0, 1200], {
      stair_type: 'u_shape',
      width_mm: 1000,
      gen_void: 'True',
    });
    const result = solveStair({ nodes, edges, stairwellId: 'st' });
    const hole = result.addNodes.find((n) => n.type === 'void')!;
    expect(hole.properties.width).toBe(3000);
    expect(hole.properties.depth).toBe(2400);
  });

  it('records the shaft on the stairwell node', () => {
    const { nodes, edges } = shaft([[0, 0], [5000, 0], [5000, 2000], [0, 2000]], [0, 1000]);
    const result = solveStair({ nodes, edges, stairwellId: 'st' });
    expect(result.updateNodes[0].properties.boundary_ax_count).toBe(4);
    expect(result.updateNodes[0].properties.solved_direction_deg).toBeCloseTo(0, 6);
  });

  it('turns the stair around when the node is dragged to the far corner', () => {
    const box: [number, number][] = [[0, 0], [5000, 0], [5000, 2000], [0, 2000]];
    const near = shaft(box, [100, 1000]);
    const far = shaft(box, [4900, 1000]);
    const a = computeStairGeometry(near.nodes.find((n) => n.id === 'st')!, near.nodes, near.edges).geometry!;
    const b = computeStairGeometry(far.nodes.find((n) => n.id === 'st')!, far.nodes, far.edges).geometry!;
    expect(a.baseline[0].x).toBeCloseTo(0, 6);
    expect(b.baseline[0].x).toBeCloseTo(5000, 6);
    expect(a.baseline[a.baseline.length - 1].x).toBeGreaterThan(a.baseline[0].x);
    expect(b.baseline[b.baseline.length - 1].x).toBeLessThan(b.baseline[0].x);
  });

  it('still closes exactly on the upper floor', () => {
    const { nodes, edges } = shaft([[0, 0], [5000, 0], [5000, 2000], [0, 2000]], [0, 1000]);
    const { geometry } = computeStairGeometry(nodes.find((n) => n.id === 'st')!, nodes, edges);
    expect(geometry!.topZMm).toBeCloseTo(2900, 6);
  });

  it('keeps the corner check honest for a stair running at an angle', () => {
    // A shaft at 45°, 5657 × 1414 — room for a 4621 mm run 1000 mm wide. Its
    // axis-aligned bounding box is 5000 × 5000, so a bounding-box check would
    // pass the wrong things; here it is the real corners that must decide.
    const { nodes, edges } = shaft([[0, 0], [4000, 4000], [3000, 5000], [-1000, 1000]], [0, 0]);
    const { geometry, diagnostics } = computeStairGeometry(
      nodes.find((n) => n.id === 'st')!, nodes, edges,
    );
    const corners = occupiedCorners(geometry!.flights, geometry!.landings);
    expect(corners.length).toBeGreaterThan(0);
    expect(diagnostics.some((d) => d.code === 'DOES_NOT_FIT')).toBe(false);
  });
});
