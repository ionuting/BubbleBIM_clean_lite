/**
 * Section engine: the marker line decides everything — look side, handedness,
 * horizontal extent — and the elements the 3D viewers draw all show up.
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { computeSectionView, type DrawingShape, type SectionCut } from './drawingEngine';

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
