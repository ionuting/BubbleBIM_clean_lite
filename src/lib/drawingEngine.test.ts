/**
 * Section engine: the marker line decides everything — look side, handedness,
 * horizontal extent — and the elements the 3D viewers draw all show up.
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { computeElevationView, computeSectionView, type DrawingShape, type SectionCut } from './drawingEngine';
import { createRoofForStorey } from '@/lib/roof';
import { BUILTIN_MATERIAL_CONFIG } from '@/lib/materialConfig';

// ── Fixture: a 6 × 4 m box, walls on all four sides, one column, a slab ─────
//
//   y=4000  D ───────── C        north wall
//           │           │
//   y=0     A ───────── B        south wall
//         x=0         x=6000

const storey: BubbleGraphNode = {
  id: 's1', type: 'storey', name: 'P', x: 0, y: 0, z: 0, parentId: null,
  properties: { bottomElevation: 0, topElevation: 3000, axesX: [0, 6000], axesY: [0, 4000] },
};
const ax = (id: string, gx: number, gy: number, extra: Record<string, unknown> = {}): BubbleGraphNode => ({
  id, type: 'ax', name: id, x: 0, y: 0, z: 0, parentId: 's1',
  properties: { gridX: gx, gridY: gy, ...extra },
});
const wall = (id: string): BubbleGraphNode => ({
  id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 's1',
  properties: { wall_type: 'W25', height: 3000 },
});
const edge = (from: string, to: string): BubbleGraphEdge => ({ id: `${from}-${to}`, from, to });

const A = ax('A', 0, 0), B = ax('B', 1, 0), C = ax('C', 1, 1), D = ax('D', 0, 1);
const south = wall('south'), north = wall('north'), west = wall('west'), east = wall('east');
const baseNodes = [storey, A, B, C, D, south, north, west, east];
const baseEdges = [
  edge('A', 'south'), edge('south', 'B'),
  edge('D', 'north'), edge('north', 'C'),
  edge('A', 'west'), edge('west', 'D'),
  edge('B', 'east'), edge('east', 'C'),
];

const byNode = (r: { shapes: DrawingShape[] }, id: string) => r.shapes.filter((s) => s.nodeId === id);
const isCutShape = (s: DrawingShape) => s.lineWeight === 'heavy-cut' || s.lineWeight === 'medium-cut';
const uRange = (shapes: DrawingShape[]) => {
  const us = shapes.flatMap((s) => s.pts.map((p) => p.u));
  return { min: Math.min(...us), max: Math.max(...us) };
};

const cut = (over: Partial<SectionCut>): SectionCut => ({
  cutDepth: 6000, elevMin: -1000, elevMax: 5000, ...over,
});

describe('computeSectionView — look side and handedness', () => {
  // Marker across the middle of the box, west→east.
  const line = { x1: -1000, y1: 2000, x2: 7000, y2: 2000 };

  it('looking left (north) shows the north wall projected and not the south one', () => {
    const r = computeSectionView(baseNodes, baseEdges, null, cut({ line, lookSide: 'left' }));
    expect(byNode(r, 'north').length).toBeGreaterThan(0);
    expect(byNode(r, 'north').every((s) => s.lineWeight === 'projected')).toBe(true);
    expect(byNode(r, 'south')).toHaveLength(0);
    // The east and west walls are cut by the plane.
    expect(byNode(r, 'east').some(isCutShape)).toBe(true);
    expect(byNode(r, 'west').some(isCutShape)).toBe(true);
  });

  it('looking right (south) shows the south wall instead', () => {
    const r = computeSectionView(baseNodes, baseEdges, null, cut({ line, lookSide: 'right' }));
    expect(byNode(r, 'south').length).toBeGreaterThan(0);
    expect(byNode(r, 'north')).toHaveLength(0);
  });

  it('east is on the right when looking north, on the left when looking south', () => {
    const north = computeSectionView(baseNodes, baseEdges, null, cut({ line, lookSide: 'left' }));
    const south = computeSectionView(baseNodes, baseEdges, null, cut({ line, lookSide: 'right' }));
    const eastU = (r: typeof north) => (uRange(byNode(r, 'east')).min + uRange(byNode(r, 'east')).max) / 2;
    const westU = (r: typeof north) => (uRange(byNode(r, 'west')).min + uRange(byNode(r, 'west')).max) / 2;
    expect(eastU(north)).toBeGreaterThan(westU(north));
    expect(eastU(south)).toBeLessThan(westU(south));
  });

  it('the legacy cutY form is a west→east line looking north', () => {
    const legacy = computeSectionView(baseNodes, baseEdges, null, cut({ cutY: 2000 }));
    const marker = computeSectionView(baseNodes, baseEdges, null, cut({ line, lookSide: 'left' }));
    expect(byNode(legacy, 'north').length).toBe(byNode(marker, 'north').length);
    expect(byNode(legacy, 'south')).toHaveLength(0);
  });

  it('an oblique marker still cuts the walls it crosses', () => {
    // Crosses y=0 at x=1500 and y=4000 at x=5500 — clear of the corners.
    const r = computeSectionView(baseNodes, baseEdges, null,
      cut({ line: { x1: 500, y1: -1000, x2: 5500, y2: 4000 }, lookSide: 'left', clipToLine: true }));
    expect(byNode(r, 'south').some(isCutShape)).toBe(true);
    expect(byNode(r, 'north').some(isCutShape)).toBe(true);
    // A crossing at 45° through a 250 wall is 250·√2 wide.
    const cutW = byNode(r, 'south').filter(isCutShape).map((s) => uRange([s]).max - uRange([s]).min);
    expect(Math.max(...cutW)).toBeCloseTo(250 * Math.SQRT2, 0);
  });
});

describe('computeSectionView — depth and horizontal range', () => {
  const line = { x1: -1000, y1: 2000, x2: 7000, y2: 2000 };

  it('depth 0 shows only the cut elements', () => {
    const r = computeSectionView(baseNodes, baseEdges, null, cut({ line, cutDepth: 0 }));
    expect(byNode(r, 'north')).toHaveLength(0);
    expect(byNode(r, 'east').some(isCutShape)).toBe(true);
    expect(r.shapes.every(isCutShape)).toBe(true);
  });

  it('a limited depth hides what lies beyond it', () => {
    const near = computeSectionView(baseNodes, baseEdges, null, cut({ line, cutDepth: 1000 }));
    const far = computeSectionView(baseNodes, baseEdges, null, cut({ line, cutDepth: Infinity }));
    expect(byNode(near, 'north')).toHaveLength(0);   // 2 m away, beyond 1 m
    expect(byNode(far, 'north').length).toBeGreaterThan(0);
  });

  it('clipToLine trims the drawing to the marker and reports its extent', () => {
    const short = { x1: 1000, y1: 2000, x2: 4000, y2: 2000 };
    const r = computeSectionView(baseNodes, baseEdges, null, cut({ line: short, clipToLine: true }));
    expect(byNode(r, 'west')).toHaveLength(0);   // west wall at x≈0 lies before the marker
    expect(byNode(r, 'east')).toHaveLength(0);
    const nr = uRange(byNode(r, 'north'));
    expect(nr.min).toBeGreaterThanOrEqual(0);
    expect(nr.max).toBeLessThanOrEqual(3000);
    expect(r.uMin).toBe(0);
    expect(r.uMax).toBe(3000);
  });

  it('u runs from the marker start, so the same wall shifts with the marker', () => {
    const a = computeSectionView(baseNodes, baseEdges, null, cut({ line, clipToLine: true }));
    const b = computeSectionView(baseNodes, baseEdges, null,
      cut({ line: { ...line, x1: -2000 }, clipToLine: true }));
    expect(uRange(byNode(b, 'east')).min - uRange(byNode(a, 'east')).min).toBeCloseTo(1000, 3);
  });

  it('the vertical range clips the shapes', () => {
    const r = computeSectionView(baseNodes, baseEdges, null, cut({ line, elevMin: 500, elevMax: 1500 }));
    const vs = r.shapes.flatMap((s) => s.pts.map((p) => p.v));
    expect(Math.min(...vs)).toBeGreaterThanOrEqual(500);
    expect(Math.max(...vs)).toBeLessThanOrEqual(1500);
  });

  it('grid axes meet the marker: X axes on a west→east marker, Y axes on a south→north one', () => {
    const we = computeSectionView(baseNodes, baseEdges, null, cut({ line }));
    expect(we.axes.map((a) => a.kind)).toEqual(['X', 'X']);
    expect(we.axes.map((a) => a.u)).toEqual([1000, 7000]);
    const sn = computeSectionView(baseNodes, baseEdges, null,
      cut({ line: { x1: 3000, y1: -1000, x2: 3000, y2: 5000 } }));
    expect(sn.axes.map((a) => a.label)).toEqual(['A', 'B']);
  });
});

describe('computeSectionView — slabs, rooms, columns', () => {
  const line = { x1: -1000, y1: 2000, x2: 7000, y2: 2000 };

  it('a slab is cut only along its own contour, not the whole grid', () => {
    // Slab on the west half only: A, mid-south, mid-north, D.
    const m1 = ax('m1', 0, 0, { bimX: 3000, bimY: 0 });
    const m2 = ax('m2', 0, 0, { bimX: 3000, bimY: 4000 });
    const slab: BubbleGraphNode = {
      id: 'slab', type: 'slab', name: 'slab', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { slab_thickness: 'S15', contour_offset: 0 },
    };
    const r = computeSectionView(
      [...baseNodes, m1, m2, slab],
      [...baseEdges, edge('slab', 'A'), edge('slab', 'm1'), edge('slab', 'm2'), edge('slab', 'D')],
      null, cut({ line }),
    );
    const s = byNode(r, 'slab');
    expect(s).toHaveLength(1);
    expect(isCutShape(s[0])).toBe(true);
    expect(uRange(s).min).toBeCloseTo(1000, 3);   // x=0 → u=1000
    expect(uRange(s).max).toBeCloseTo(4000, 3);   // x=3000 → u=4000
  });

  it('a slab the plane misses is projected, not cut', () => {
    const slab: BubbleGraphNode = {
      id: 'slab', type: 'slab', name: 'slab', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { slab_thickness: 'S15', contour_offset: 0 },
    };
    const r = computeSectionView(
      [...baseNodes, slab],
      [...baseEdges, edge('slab', 'A'), edge('slab', 'B'), edge('slab', 'C'), edge('slab', 'D')],
      null, cut({ line: { x1: -1000, y1: -800, x2: 7000, y2: -800 } }),  // south of the box
    );
    const s = byNode(r, 'slab');
    expect(s).toHaveLength(1);
    expect(s[0].lineWeight).toBe('projected');
  });

  it('a room with has_slab draws its slab', () => {
    const room: BubbleGraphNode = {
      id: 'room', type: 'room', name: 'room', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { contour_offset: 0 },
    };
    const r = computeSectionView(
      [...baseNodes, room],
      [...baseEdges, edge('room', 'A'), edge('room', 'B'), edge('room', 'C'), edge('room', 'D')],
      null, cut({ line }),
    );
    const s = byNode(r, 'room');
    expect(s).toHaveLength(1);
    expect(s[0].nodeType).toBe('slab');
    expect(isCutShape(s[0])).toBe(true);
    // Slab hangs under the storey top.
    const vs = s[0].pts.map((p) => p.v);
    expect(Math.max(...vs)).toBe(3000);
    expect(Math.min(...vs)).toBeLessThan(3000);
  });

  it('a column on the plane is cut to its width', () => {
    const col = ax('K', 0, 0, { bimX: 3000, bimY: 2000, has_column: 'True', column_type: 'C30x30' });
    const r = computeSectionView([...baseNodes, col], baseEdges, null, cut({ line }));
    const s = byNode(r, 'K');
    expect(s).toHaveLength(1);
    expect(isCutShape(s[0])).toBe(true);
    expect(uRange(s).max - uRange(s).min).toBeCloseTo(300, 3);
  });
});

describe('computeSectionView — roofs and stairs', () => {
  it('a gable roof cut across the ridge gives two sloping bands meeting at the ridge', () => {
    const roof: BubbleGraphNode = {
      id: 'roof', type: 'roof', name: 'roof', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { roof_type: 'gable', pitch_deg: 30, overhang_mm: 0, ridge_direction: 'x' },
    };
    const r = computeSectionView(
      [...baseNodes, roof],
      [...baseEdges, edge('roof', 'A'), edge('roof', 'B'), edge('roof', 'C'), edge('roof', 'D')],
      null, cut({ line: { x1: 3000, y1: -1000, x2: 3000, y2: 5000 }, elevMax: 8000 }),
    );
    const bands = byNode(r, 'roof').filter(isCutShape);
    expect(bands.length).toBeGreaterThanOrEqual(2);
    // Top edge of each band = first two points. The covering sits a rafter
    // height above the wall plate, so pin the RISE (half-span · tan 30°), not
    // the absolute level.
    const tops = bands.flatMap((b) => b.pts.slice(0, 2).map((p) => p.v));
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(3000);
    expect(Math.max(...tops) - Math.min(...tops)).toBeCloseTo(2000 * Math.tan(Math.PI / 6), 0);
  });

  it('a flight cut along its run draws the sawtooth', () => {
    const flight: BubbleGraphNode = {
      id: 'f', type: 'stair_flight', name: 'f', x: 0, y: 0, z: 0, parentId: 's1',
      properties: {
        ax: 1000, ay: 2000, az: 0, bx: 1000 + 9 * 280, by: 2000, bz: 10 * 170,
        steps: 10, riser_mm: 170, tread_mm: 280, width_mm: 1000, thickness_mm: 150,
      },
    };
    const r = computeSectionView([...baseNodes, flight], baseEdges, null,
      cut({ line: { x1: 0, y1: 2000, x2: 6000, y2: 2000 } }));
    const s = byNode(r, 'f');
    expect(s).toHaveLength(1);
    expect(isCutShape(s[0])).toBe(true);
    expect(s[0].pts.length).toBeGreaterThan(20);  // 10 risers → many corners
    // The profile stops a slab thickness under the arrival level: the last
    // riser's face belongs to the landing it steps onto.
    const vs = s[0].pts.map((p) => p.v);
    expect(Math.max(...vs)).toBeCloseTo(1700 - 150, 3);
    expect(Math.min(...vs)).toBe(0);           // foot_drop 0: the soffit stops at floor level
  });

  it('a flight crossed by the plane is a block at the crossing', () => {
    const flight: BubbleGraphNode = {
      id: 'f', type: 'stair_flight', name: 'f', x: 0, y: 0, z: 0, parentId: 's1',
      properties: {
        ax: 1000, ay: 500, az: 0, bx: 1000, by: 500 + 9 * 280, bz: 1700,
        steps: 10, riser_mm: 170, tread_mm: 280, width_mm: 1000, thickness_mm: 150,
      },
    };
    const r = computeSectionView([...baseNodes, flight], baseEdges, null,
      cut({ line: { x1: 0, y1: 2000, x2: 6000, y2: 2000 } }));
    const s = byNode(r, 'f');
    expect(s).toHaveLength(1);
    expect(isCutShape(s[0])).toBe(true);
    expect(uRange(s).max - uRange(s).min).toBeCloseTo(1000, 3);
  });

  it('a landing is a flat prism at its level', () => {
    const landing: BubbleGraphNode = {
      id: 'l', type: 'stair_landing', name: 'l', x: 0, y: 0, z: 1700, parentId: 's1',
      properties: {
        polygon: JSON.stringify([{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }, { x: 2000, y: 3000 }, { x: 1000, y: 3000 }]),
        level_mm: 1700, thickness_mm: 150,
      },
    };
    const r = computeSectionView([...baseNodes, landing], baseEdges, null,
      cut({ line: { x1: 0, y1: 2000, x2: 6000, y2: 2000 } }));
    const s = byNode(r, 'l');
    expect(s).toHaveLength(1);
    const vs = s[0].pts.map((p) => p.v);
    expect(Math.max(...vs)).toBe(1700);
    expect(Math.min(...vs)).toBe(1550);
  });
});

// ── Roof trim ───────────────────────────────────────────────────────────────
//
// A gable over the 6 × 4 m box: eaves along the long sides (y = 0 and y = 4000),
// ridge along x at y = 2000. The east and west walls run under the ridge, so a
// roof that trims them turns their tops into gables.

function withRoof(over: Record<string, unknown> = {}, wallOver: Record<string, unknown> = {}) {
  const tuned = baseNodes.map((n) => (n.type === 'wall' ? { ...n, properties: { ...n.properties, ...wallOver } } : n));
  const built = createRoofForStorey('s1', tuned, baseEdges, { generateLevel: 'envelope' });
  const nodes = built.nodes.map((n) => (n.type === 'roof' ? { ...n, properties: { ...n.properties, ...over } } : n));
  return { nodes, edges: built.edges, roofId: built.roofId };
}

const vRange = (shapes: DrawingShape[]) => {
  const vs = shapes.flatMap((s) => s.pts.map((p) => p.v));
  return { min: Math.min(...vs), max: Math.max(...vs) };
};
/** A section straight along the ridge line, so the east and west walls are cut at their apex. */
const RIDGE_CUT = { x1: -1000, y1: 2000, x2: 7000, y2: 2000 };
const tall = cut({ line: RIDGE_CUT, lookSide: 'left', elevMin: -1000, elevMax: 9000 });

describe('computeSectionView — roof trim', () => {
  it('a wall taller than the roof is cut back to it, with no property to set', () => {
    const plain = computeSectionView(baseNodes.map((n) => n.id === 'east'
      ? { ...n, properties: { ...n.properties, height: 6000 } } : n), baseEdges, null, tall);
    expect(vRange(byNode(plain, 'east')).max).toBeCloseTo(6000, 0);

    const { nodes, edges } = withRoof({}, {});
    const roofed = computeSectionView(
      nodes.map((n) => n.id === 'east' ? { ...n, properties: { ...n.properties, height: 6000 } } : n),
      edges, null, tall);
    const top = vRange(byNode(roofed, 'east')).max;
    expect(top).toBeLessThan(6000);
    expect(top).toBeGreaterThan(3000);   // cut at the ridge, not at the eave
  });

  it('roof_attach grows a wall up to the roof and folds its top into a gable', () => {
    const { nodes, edges } = withRoof({}, { roof_attach: 'True' });

    // Cut along y at mid-span, looking east: the east wall shows in projection,
    // where a folded top actually reads.
    const alongY = cut({
      line: { x1: 3000, y1: -1000, x2: 3000, y2: 5000 },
      lookSide: 'right', elevMin: -1000, elevMax: 9000,
    });
    const r = computeSectionView(nodes, edges, null, alongY);
    const east = byNode(r, 'east');
    expect(east.length).toBeGreaterThan(0);
    // A rectangle has four corners; a gable has an apex on top of that.
    const gable = east.find((s) => s.pts.length > 4);
    expect(gable).toBeDefined();
    const vs = gable!.pts.map((p) => p.v);
    expect(Math.max(...vs)).toBeGreaterThan(3000);

    // Along the ridge the same wall is CUT, at its apex — the highest it gets.
    const apex = vRange(byNode(computeSectionView(nodes, edges, null, tall), 'east')).max;
    expect(apex).toBeCloseTo(Math.max(...vs), 0);

    // An eave wall only rises the little the overhang puts above it, and stays flat.
    const north = byNode(computeSectionView(nodes, edges, null, tall), 'north');
    const northTop = vRange(north).max;
    expect(northTop).toBeGreaterThan(3000);
    expect(northTop).toBeLessThan(apex - 500);
    expect(north.every((s) => s.pts.length === 4)).toBe(true);
  });

  it('trim_below = False on the roof, and a higher trim_priority on the wall, both opt out', () => {
    const off = withRoof({ trim_below: 'False' }, { roof_attach: 'True' });
    expect(vRange(byNode(computeSectionView(off.nodes, off.edges, null, tall), 'east')).max).toBeCloseTo(3000, 0);

    const outranks = withRoof({}, { roof_attach: 'True', trim_priority: 200 });
    expect(vRange(byNode(computeSectionView(outranks.nodes, outranks.edges, null, tall), 'east')).max)
      .toBeCloseTo(3000, 0);
  });

  it('trim_offset_mm drops the cut toward the rafters', () => {
    const flush = withRoof({}, {});
    const dropped = withRoof({ trim_offset_mm: -500 }, {});
    const tallEast = (b: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] }) => vRange(byNode(
      computeSectionView(
        b.nodes.map((n) => n.id === 'east' ? { ...n, properties: { ...n.properties, height: 6000 } } : n),
        b.edges, null, tall), 'east')).max;
    expect(tallEast(dropped)).toBeCloseTo(tallEast(flush) - 500, 0);
  });
});

// ── The gable as its own construction ───────────────────────────────────────
//
// Cut along the ridge, the east wall is cut across its thickness, so the width
// of each shape in u IS the thickness of the body that produced it.

describe('computeSectionView — gable structure', () => {
  const eastAt = (wallOver: Record<string, unknown>) => {
    const { nodes, edges } = withRoof({}, { roof_attach: 'True', ...wallOver });
    return byNode(computeSectionView(nodes, edges, null, tall), 'east').filter(isCutShape);
  };

  it('a wall with no gable properties stays one body', () => {
    expect(eastAt({})).toHaveLength(1);
  });

  /** The two bodies of a split wall, lower first. */
  const split = (parts: DrawingShape[]) =>
    [...parts].sort((a, b) => Math.max(...a.pts.map((p) => p.v)) - Math.max(...b.pts.map((p) => p.v)));
  const mid = (s: DrawingShape) => (uRange([s]).min + uRange([s]).max) / 2;

  it('a gable in another material splits the wall in two at the cut', () => {
    const parts = eastAt({ gable_material: 'wood' });
    expect(parts).toHaveLength(2);
    const [box, gable] = split(parts);

    // They meet: the box top is the gable's base, and the apex is above both.
    const boxTop = Math.max(...box.pts.map((p) => p.v));
    expect(Math.min(...gable.pts.map((p) => p.v))).toBeCloseTo(boxTop, 0);
    expect(Math.max(...gable.pts.map((p) => p.v))).toBeGreaterThan(boxTop);
    // With a real material config loaded, the two read as different materials.
    const { nodes, edges } = withRoof({}, { roof_attach: 'True', gable_material: 'wood' });
    const painted = split(
      byNode(computeSectionView(nodes, edges, BUILTIN_MATERIAL_CONFIG, tall), 'east').filter(isCutShape),
    );
    expect(painted[1].fillColor).not.toBe(painted[0].fillColor);
    expect(painted[1].hatch).toBe('diagonal');   // wood

    // The material alone changes nothing about where it sits: still 250 wide.
    expect(uRange([gable]).max - uRange([gable]).min).toBeCloseTo(250, 0);
  });

  it('a thinner gable is cut at its own thickness', () => {
    const [box, gable] = split(eastAt({ gable_thickness_mm: 100 }));
    expect(uRange([gable]).max - uRange([gable]).min).toBeCloseTo(100, 0);
    expect(uRange([box]).max - uRange([box]).min).toBeCloseTo(250, 0);
    // Centred on the wall axis until an offset says otherwise.
    expect(mid(gable)).toBeCloseTo(mid(box), 0);
  });

  it('an offset slides the gable off the wall axis', () => {
    const centred = split(eastAt({ gable_thickness_mm: 100 }))[1];
    const shifted = split(eastAt({ gable_thickness_mm: 100, gable_offset_mm: 75 }))[1];
    expect(Math.abs(mid(shifted) - mid(centred))).toBeCloseTo(75, 0);
  });

  it('a wall the roof does not cut has no gable to configure', () => {
    // The north wall runs along the eave: it is never folded, so the gable
    // properties leave it a single flat-topped body.
    const { nodes, edges } = withRoof({}, { roof_attach: 'True', gable_material: 'wood', gable_thickness_mm: 100 });
    const north = byNode(computeSectionView(nodes, edges, null, tall), 'north');
    expect(north).toHaveLength(1);
    expect(north[0].pts).toHaveLength(4);
  });
});

describe('computeSectionView — roof trim on columns', () => {
  const column: BubbleGraphNode = {
    id: 'col', type: 'column', name: 'col', x: 1000, y: 1000, z: 0, parentId: 's1',
    properties: { column_type: 'C30x30', roof_attach: 'True' },
  };

  it('a column set to attach grows to the slope and takes its slope on top', () => {
    const base = createRoofForStorey('s1', [...baseNodes, column], baseEdges, { generateLevel: 'envelope' });
    const r = computeSectionView(base.nodes, base.edges, null, cut({
      line: { x1: 1000, y1: -1000, x2: 1000, y2: 5000 },
      lookSide: 'right', elevMin: -1000, elevMax: 9000,
    }));
    const col = byNode(r, 'col');
    expect(col.length).toBeGreaterThan(0);
    const vs = col.flatMap((s) => s.pts.map((p) => p.v));
    // It rose above the storey, and its top is sloped rather than flat.
    expect(Math.max(...vs)).toBeGreaterThan(3000);
    const tops = col.flatMap((s) => s.pts.filter((p) => p.v > 100).map((p) => p.v));
    expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(50);
  });

  it('without a roof it stays a plain box at the storey top', () => {
    const r = computeSectionView([...baseNodes, column], baseEdges, null, cut({
      line: { x1: 1000, y1: -1000, x2: 1000, y2: 5000 },
      lookSide: 'right', elevMin: -1000, elevMax: 9000,
    }));
    const vs = byNode(r, 'col').flatMap((s) => s.pts.map((p) => p.v));
    expect(Math.max(...vs)).toBeCloseTo(3000, 0);
  });
});

// ── Elevations ──────────────────────────────────────────────────────────────
//
// An elevation is the same projection as a section, with the plane pushed
// outside the building. These pin the two things that follow from that — every
// element reaches the drawing, and every face is seen rather than cut — plus
// the handedness of the four directions.

const win = (id: string, over: Record<string, unknown> = {}): BubbleGraphNode => ({
  id, type: 'window', name: id, x: 0, y: 0, z: 0, parentId: 's1',
  properties: { width: 1200, height: 1400, sill_height: 900, offset: 2000, ...over },
});

const closedOf = (shapes: DrawingShape[]) => shapes.filter((s) => s.closed);

describe('computeElevationView — handedness and the axis grid', () => {
  it('looking north puts east on the right; looking south puts it on the left', () => {
    const n = computeElevationView(baseNodes, baseEdges, null, 'N');
    expect(uRange(byNode(n, 'east')).min).toBeGreaterThan(uRange(byNode(n, 'west')).max);
    const s = computeElevationView(baseNodes, baseEdges, null, 'S');
    expect(uRange(byNode(s, 'east')).max).toBeLessThan(uRange(byNode(s, 'west')).min);
  });

  it('a facade meets the axes that run across it: numbered on N/S, lettered on E/W', () => {
    const n = computeElevationView(baseNodes, baseEdges, null, 'N');
    expect(n.axes.map((a) => a.kind)).toEqual(['X', 'X']);
    expect(n.axes.map((a) => a.label)).toEqual(['1', '2']);
    expect(n.axes.map((a) => a.u)).toEqual([0, 6000]);
    const e = computeElevationView(baseNodes, baseEdges, null, 'E');
    expect(e.axes.map((a) => a.label)).toEqual(['A', 'B']);
    expect(e.axes.map((a) => a.u)).toEqual([0, 4000]);
  });

  it('a storey marks two levels, and the shared face between two storeys only one', () => {
    const upper: BubbleGraphNode = {
      id: 's2', type: 'storey', name: 'E1', x: 0, y: 0, z: 0, parentId: null,
      properties: { bottomElevation: 3000, topElevation: 6000, axesX: [0, 6000], axesY: [0, 4000] },
    };
    const r = computeElevationView([...baseNodes, upper], baseEdges, null, 'N');
    expect(r.levels.map((l) => l.vMm)).toEqual([0, 3000, 6000]);
    expect(r.levels.map((l) => l.label)).toEqual(['+0.000', '+3.000', '+6.000']);
  });
});

describe('computeElevationView — what reaches the drawing', () => {
  it('nothing is cut: every face is seen, and seen faces carry a fill', () => {
    const r = computeElevationView(baseNodes, baseEdges, null, 'N');
    expect(r.shapes.every((s) => !isCutShape(s))).toBe(true);
    expect(closedOf(byNode(r, 'south')).every((s) => s.fillColor !== 'none')).toBe(true);
    // The same wall in a section is an outline over whatever is behind it.
    const sec = computeSectionView(baseNodes, baseEdges, null,
      cut({ line: { x1: -1000, y1: 3000, x2: 7000, y2: 3000 }, lookSide: 'right' }));
    expect(byNode(sec, 'south').every((s) => s.fillColor === 'none')).toBe(true);
  });

  it('the roof, the slab, the footing, the column and the stair all show up', () => {
    const roof: BubbleGraphNode = {
      id: 'roof', type: 'roof', name: 'roof', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { roof_type: 'gable', pitch_deg: 30, overhang_mm: 0, ridge_direction: 'x' },
    };
    const room: BubbleGraphNode = {
      id: 'room', type: 'room', name: 'room', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { contour_offset: 0 },
    };
    const foot: BubbleGraphNode = {
      id: 'ft', type: 'foundation', name: 'ft', x: 3000, y: 2000, z: 0, parentId: 's1',
      properties: { width: 1000, depth: 500 },
    };
    const col = ax('K', 0, 0, { bimX: 3000, bimY: 2000, has_column: 'True', column_type: 'C30x30' });
    const flight: BubbleGraphNode = {
      id: 'f', type: 'stair_flight', name: 'f', x: 0, y: 0, z: 0, parentId: 's1',
      properties: {
        ax: 1000, ay: 2000, az: 0, bx: 1000 + 9 * 280, by: 2000, bz: 10 * 170,
        steps: 10, riser_mm: 170, tread_mm: 280, width_mm: 1000, thickness_mm: 150,
      },
    };
    const r = computeElevationView(
      [...baseNodes, roof, room, foot, col, flight],
      [...baseEdges, edge('roof', 'A'), edge('roof', 'B'), edge('roof', 'C'), edge('roof', 'D'),
        edge('room', 'A'), edge('room', 'B'), edge('room', 'C'), edge('room', 'D')],
      null, 'N',
    );
    for (const id of ['roof', 'room', 'ft', 'K', 'f']) {
      expect(byNode(r, id).length, `${id} is missing from the elevation`).toBeGreaterThan(0);
    }
    // A buried footing is a dashed outline, not a painted face.
    expect(byNode(r, 'ft').every((s) => s.lineWeight === 'hidden' && s.fillColor === 'none')).toBe(true);
    // No vertical limits given, so the roof is kept above the top storey.
    expect(Math.max(...byNode(r, 'roof').flatMap((s) => s.pts.map((p) => p.v)))).toBeGreaterThan(3000);
  });

  it('vertical limits clip the facade', () => {
    const r = computeElevationView(baseNodes, baseEdges, null, 'N', 0, 1000);
    const vs = r.shapes.flatMap((s) => s.pts.map((p) => p.v));
    expect(Math.max(...vs)).toBeCloseTo(1000, 6);
    expect(Math.min(...vs)).toBeCloseTo(0, 6);
  });
});

describe('computeElevationView — windows and doors', () => {
  const nodes = [...baseNodes, win('w1')];
  const edges = [...baseEdges, edge('south', 'w1')];

  it('a window is drawn once: a frame, a pane and a sill line', () => {
    const r = computeElevationView(nodes, edges, null, 'N');
    const parts = byNode(r, 'w1');
    expect(parts).toHaveLength(3);
    expect(closedOf(parts)).toHaveLength(2);
  });

  it('the wall behind it is one silhouette, not the pieces it was cut into', () => {
    // The wall geometry splits this wall into four solid bodies — two piers,
    // the parapet and the lintel. Drawn separately they would seam the facade;
    // the opening is painted over the top anyway.
    const r = computeElevationView(nodes, edges, null, 'N');
    const wall = byNode(r, 'south');
    expect(wall).toHaveLength(1);
    const vs = wall[0].pts.map((p) => p.v);
    expect(Math.min(...vs)).toBe(0);
    expect(Math.max(...vs)).toBe(3000);
    // A section still shows the pieces: there the gaps between them ARE the
    // openings, and a reader needs to see them.
    const sec = computeSectionView(nodes, edges, null,
      cut({ line: { x1: -1000, y1: 2000, x2: 7000, y2: 2000 }, lookSide: 'right' }));
    expect(byNode(sec, 'south').length).toBeGreaterThan(1);
  });

  it('the window sits in front of its own wall, not behind it', () => {
    const r = computeElevationView(nodes, edges, null, 'N');
    const wallDepth = Math.min(...byNode(r, 'south').map((s) => s.depthMm));
    expect(byNode(r, 'w1').every((s) => s.depthMm < wallDepth)).toBe(true);
    // Painter's order: the wall is laid down first, the window over it.
    const lastWall = r.shapes.map((s) => s.nodeId).lastIndexOf('south');
    expect(r.shapes.findIndex((s) => s.nodeId === 'w1')).toBeGreaterThan(lastWall);
  });

  it('the frame spans the opening and the pane is inset inside it', () => {
    const r = computeElevationView(nodes, edges, null, 'N');
    const [frame, pane] = closedOf(byNode(r, 'w1'));
    expect(uRange([frame]).max - uRange([frame]).min).toBeCloseTo(1200, 3);
    const fv = frame.pts.map((p) => p.v);
    expect(Math.min(...fv)).toBeCloseTo(900, 3);
    expect(Math.max(...fv)).toBeCloseTo(2300, 3);
    expect(uRange([pane]).min).toBeGreaterThan(uRange([frame]).min);
    expect(uRange([pane]).max).toBeLessThan(uRange([frame]).max);
  });

  it('a two-sash type is drawn as two panes on a mullion', () => {
    const r = computeElevationView(
      [...baseNodes, win('w1', { double: true })], edges, null, 'N',
    );
    const panes = byNode(r, 'w1').filter((s) => s.closed && s.lineWeight === 'projected');
    expect(panes).toHaveLength(2);
    expect(uRange([panes[0]]).max).toBeLessThan(uRange([panes[1]]).min);
  });

  it('a door stands on the floor and has no sill line', () => {
    const r = computeElevationView(
      [...baseNodes, { ...win('d1'), type: 'door', properties: { width: 900, height: 2100, sill_height: 0, offset: 2000 } }],
      [...baseEdges, edge('south', 'd1')], null, 'N',
    );
    const parts = byNode(r, 'd1');
    expect(parts.every((s) => s.closed)).toBe(true);
    const leaf = parts.find((s) => s.lineWeight === 'projected')!;
    expect(Math.min(...leaf.pts.map((p) => p.v))).toBeCloseTo(0, 3);
  });
});

describe('computeSectionView — joinery', () => {
  const nodes = [...baseNodes, win('w1')];
  const edges = [...baseEdges, edge('south', 'w1')];

  // The window sits 2000 mm along the south wall and is 1200 wide, so a marker
  // at x = 2600 runs straight through the middle of it.
  const across = { x1: 2600, y1: -1000, x2: 2600, y2: 5000 };

  it('a section through a window cuts its head, its sill and the glass between', () => {
    const r = computeSectionView(nodes, edges, null, cut({ line: across, lookSide: 'left' }));
    const parts = byNode(r, 'w1');
    expect(parts).toHaveLength(3);
    expect(parts.every(isCutShape)).toBe(true);
    // All three are as narrow as the wall is thick — this is a cross-section
    // of the joinery, not a view of the opening.
    expect(uRange(parts).max - uRange(parts).min).toBeCloseTo(250, 3);

    const vOf = (s: DrawingShape) => ({ lo: Math.min(...s.pts.map((p) => p.v)), hi: Math.max(...s.pts.map((p) => p.v)) });
    const sorted = [...parts].sort((a, b) => vOf(a).lo - vOf(b).lo);
    expect(vOf(sorted[0]).lo).toBeCloseTo(900, 3);    // sill sits on the opening's bottom
    expect(vOf(sorted[2]).hi).toBeCloseTo(2300, 3);   // head on its top
    // The glass is the thin one in the middle.
    const glass = sorted[1];
    expect(uRange([glass]).max - uRange([glass]).min).toBeLessThan(20);
    expect(vOf(glass).lo).toBeGreaterThan(900);
    expect(vOf(glass).hi).toBeLessThan(2300);
  });

  it('a door cut through is a leaf standing on the floor, with no sill under it', () => {
    const d = { ...win('d1'), type: 'door', properties: { width: 900, height: 2100, sill_height: 0, offset: 2000 } };
    const r = computeSectionView(
      [...baseNodes, d as BubbleGraphNode], [...baseEdges, edge('south', 'd1')],
      null, cut({ line: { ...across, x1: 2450, x2: 2450 }, lookSide: 'left' }),
    );
    const parts = byNode(r, 'd1');
    expect(parts).toHaveLength(2);       // head and leaf; no sill
    expect(Math.min(...parts.flatMap((s) => s.pts.map((p) => p.v)))).toBeCloseTo(0, 3);
  });

  it('a window in the wall beyond the plane is seen, not cut', () => {
    const r = computeSectionView(nodes, edges, null,
      cut({ line: { x1: -1000, y1: 2000, x2: 7000, y2: 2000 }, lookSide: 'right' }));
    const parts = byNode(r, 'w1');
    expect(parts).toHaveLength(3);                       // frame, pane, sill line
    expect(parts.some(isCutShape)).toBe(true);           // the frame reads as joinery
    expect(uRange(parts).max - uRange(parts).min).toBeGreaterThan(1200);
  });

  it('a window in the wall behind the viewer is not in the drawing at all', () => {
    // Same marker, looking the other way: the south wall — and its window —
    // are now behind the plane.
    const r = computeSectionView(nodes, edges, null,
      cut({ line: { x1: -1000, y1: 2000, x2: 7000, y2: 2000 }, lookSide: 'left' }));
    expect(byNode(r, 'south')).toHaveLength(0);
    expect(byNode(r, 'w1')).toHaveLength(0);
  });

  it('depth 0 leaves only what the plane actually touches', () => {
    const r = computeSectionView(nodes, edges, null,
      cut({ line: { x1: -1000, y1: 2000, x2: 7000, y2: 2000 }, lookSide: 'right', cutDepth: 0 }));
    expect(byNode(r, 'w1')).toHaveLength(0);
  });
});
