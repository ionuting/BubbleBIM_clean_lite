import { describe, it, expect } from 'vitest';
import { unionWallRings, wallFaces, wallSolidPolygons, type Pt } from './wallSilhouette';
import { calcWallGeometry, calcWallJoins, type WallGeometry } from '@/lib/bimGeometry';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';

/** A rectangle, corners counter-clockwise. */
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

const bbox = (ring: Pt[]) => ({
  x: [Math.min(...ring.map((p) => p.x)), Math.max(...ring.map((p) => p.x))],
  y: [Math.min(...ring.map((p) => p.y)), Math.max(...ring.map((p) => p.y))],
});

describe('unionWallRings', () => {
  it('melts a T-junction into one ring', () => {
    // A chord along y = ±125 and a stem hanging off it — the shape that shows
    // a seam across the poché today.
    const chord = rect(0, -125, 8000, 125);
    const stem = rect(3950, -3000, 4050, 125);
    const rings = unionWallRings([chord, stem]);
    expect(rings).toHaveLength(1);
    // One outline around both, so the seam where they meet is gone.
    expect(bbox(rings[0])).toEqual({ x: [0, 8000], y: [-3000, 125] });
    // The seam was the stem's top edge, buried inside the chord at y = 125.
    // If it survived, the ring would turn twice more up there; a silhouette
    // crosses the top just once, at each far end of the chord.
    const onTop = rings[0].filter((p) => p.y === 125).map((p) => p.x).sort((a, b) => a - b);
    expect(onTop).toEqual([0, 8000]);
    // A T outline: six corners round the stem plus the chord's two far ends.
    expect(rings[0]).toHaveLength(8);
  });

  it('keeps a courtyard as its own ring', () => {
    // Four walls around a room: the union has an outer boundary and a hole,
    // and the hole is as much part of the silhouette as the outside.
    const rings = unionWallRings([
      rect(-125, -125, 5125, 125), rect(-125, 3875, 5125, 4125),
      rect(-125, -125, 125, 4125), rect(4875, -125, 5125, 4125),
    ]);
    expect(rings).toHaveLength(2);
    const areas = rings.map((r) => Math.abs(
      r.reduce((a, p, i) => {
        const q = r[(i + 1) % r.length];
        return a + p.x * q.y - q.x * p.y;
      }, 0) / 2));
    const [hole, outer] = areas.sort((a, b) => a - b);
    expect(outer).toBeCloseTo(5250 * 4250, 3);
    expect(hole).toBeCloseTo(4750 * 3750, 3);
  });

  it('leaves walls that do not touch as separate rings', () => {
    const rings = unionWallRings([rect(0, 0, 1000, 250), rect(5000, 0, 6000, 250)]);
    expect(rings).toHaveLength(2);
  });

  it('drops slivers and handles the empty and single cases', () => {
    expect(unionWallRings([])).toEqual([]);
    const one = rect(0, 0, 1000, 250);
    expect(unionWallRings([one])).toEqual([one]);
    // A zero-area ring is noise, not a wall.
    expect(unionWallRings([rect(0, 0, 1000, 0)])).toEqual([]);
  });
});

describe('wallSolidPolygons', () => {
  const MM = 0.001;
  /** A straight 4 m wall, 250 thick, running east from the origin. */
  const straight = (openings: WallGeometry['openings'] = []): WallGeometry => ({
    footprint: [
      { x: 0, y: 125 }, { x: 4000, y: 125 }, { x: 4000, y: -125 }, { x: 0, y: -125 },
    ],
    sxM: 0, szM: 0, exM: 4000 * MM, ezM: 0,
    openings,
    solidSegs: [], wallThick: 0.25, botM: 0, wallH: 3000, osM: 0, oeM: 0,
  } as unknown as WallGeometry);

  it('gives one piece for a wall with no openings', () => {
    const [poly, ...rest] = wallSolidPolygons(straight());
    expect(rest).toHaveLength(0);
    expect(bbox(poly)).toEqual({ x: [0, 4000], y: [-125, 125] });
  });

  it('splits either side of an opening', () => {
    // A 1 m opening starting 1.5 m along.
    const polys = wallSolidPolygons(straight([
      { tS: 1500 * MM, oW: 1000 * MM } as WallGeometry['openings'][number],
    ]));
    expect(polys).toHaveLength(2);
    expect(bbox(polys[0]).x).toEqual([0, 1500]);
    expect(bbox(polys[1]).x).toEqual([2500, 4000]);
  });

  it('returns a curved wall whole — its footprint is not four corners', () => {
    const arc = {
      footprint: Array.from({ length: 14 }, (_, i) => ({ x: i * 100, y: (i % 2) * 50 })),
      sxM: 0, szM: 0, exM: 1, ezM: 0, openings: [],
      solidSegs: [], wallThick: 0.25, botM: 0, wallH: 3000, osM: 0, oeM: 0,
    } as unknown as WallGeometry;
    expect(wallSolidPolygons(arc)).toHaveLength(1);
    expect(wallSolidPolygons(arc)[0]).toHaveLength(14);
  });

  it('declines a wall with nothing to draw', () => {
    expect(wallSolidPolygons({ footprint: [] } as unknown as WallGeometry)).toEqual([]);
  });
});

describe('through the real chain: a T and a cross', () => {
  // The shape from the screenshot — a rectangle split by a spine and a
  // cross-wall, so the plan has two T-junctions and one full cross.
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const ax = (id: string, x: number, y: number): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y, has_column: 'False' },
  });
  const w = (id: string): BubbleGraphNode => ({
    id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
    properties: { wall_type: 'W25' },
  });
  let k = 0;
  const e = (from: string, to: string): BubbleGraphEdge => ({ id: `s${k++}`, from, to });

  function scene() {
    const nodes = [storey,
      ax('a', 0, 0), ax('b', 10000, 0), ax('c', 10000, 8000), ax('d', 0, 8000),
      ax('m1', 5000, 0), ax('m2', 5000, 8000), ax('mid', 5000, 4000),
      ax('wm', 0, 4000), ax('em', 10000, 4000),
      w('S1'), w('S2'), w('N1'), w('N2'), w('W1'), w('W2'), w('E1'), w('E2'),
      w('spineS'), w('spineN'), w('crossW'), w('crossE')];
    const edges = [
      e('S1', 'a'), e('S1', 'm1'), e('S2', 'm1'), e('S2', 'b'),
      e('N1', 'd'), e('N1', 'm2'), e('N2', 'm2'), e('N2', 'c'),
      e('W1', 'a'), e('W1', 'wm'), e('W2', 'wm'), e('W2', 'd'),
      e('E1', 'b'), e('E1', 'em'), e('E2', 'em'), e('E2', 'c'),
      e('spineS', 'm1'), e('spineS', 'mid'), e('spineN', 'mid'), e('spineN', 'm2'),
      e('crossW', 'wm'), e('crossW', 'mid'), e('crossE', 'mid'), e('crossE', 'em'),
    ];
    return { nodes, edges };
  }

  it('leaves one boundary and four room holes, with no seam anywhere', () => {
    const { nodes, edges } = scene();
    const map = new Map(nodes.map((n) => [n.id, n]));
    const joins = calcWallJoins(nodes, edges);
    const polys = nodes.filter((n) => n.type === 'wall')
      .flatMap((wn) => {
        const geo = calcWallGeometry(wn, map, edges, joins);
        return geo ? wallSolidPolygons(geo) : [];
      });
    // Twelve separate quads before the union — one per wall.
    expect(polys.length).toBe(12);

    const rings = unionWallRings(polys);
    // The building's outline plus one hole per room. Every seam that used to
    // cross the poché at the spine, the cross-wall and the four T-junctions
    // is now interior to a single ring and simply not drawn.
    expect(rings.length).toBe(5);

    const areaOf = (r: Pt[]) => Math.abs(r.reduce((acc, p, i) => {
      const q = r[(i + 1) % r.length];
      return acc + p.x * q.y - q.x * p.y;
    }, 0) / 2);
    const sorted = rings.map(areaOf).sort((x, y) => y - x);
    // Outer boundary: 10 m x 8 m grown by half a wall on each side.
    expect(sorted[0]).toBeCloseTo(10250 * 8250, 2);
    // Four equal rooms: half the span each way, less a wall's thickness.
    for (const hole of sorted.slice(1)) expect(hole).toBeCloseTo(4750 * 3750, 2);
  });
});

describe('walls that only touch', () => {
  // What the kernel's cut hands over: the same edge, a few ULPs apart.
  const noise = 1e-9;

  it('merge at a T where one wall stops on the other’s face', () => {
    const through = rect(-100, -100, 10000, 100);
    const stem = rect(4900, 100 + noise, 5100, 5000);
    expect(unionWallRings([through, stem])).toHaveLength(1);
  });

  it('merge at an L meeting on its mitre', () => {
    const south: Pt[] = [{ x: -100, y: -100 }, { x: 5000, y: -100 }, { x: 5000, y: 100 }, { x: 100 + noise, y: 100 - noise }];
    const west: Pt[] = [{ x: -100, y: -100 }, { x: 100, y: 100 }, { x: 100, y: 5000 }, { x: -100 - noise, y: 5000 }];
    const rings = unionWallRings([south, west]);
    expect(rings).toHaveLength(1);
    // The mitre is gone: an L has six corners, not the eight of two quads.
    expect(rings[0]).toHaveLength(6);
  });
});

describe('an opening in a wall whose faces differ in length', () => {
  const MM = 0.001;
  // The corner wall of the plan that showed it: mitred at its start, so the
  // outer face starts 100 in and the inner one 100 out — 4900 against 5100.
  const mitred = (openings: WallGeometry['openings']): WallGeometry => ({
    footprint: [
      { x: 100, y: 100 }, { x: 5000, y: 100 }, { x: 5000, y: -100 }, { x: -100, y: -100 },
    ],
    sxM: 0, szM: 0, exM: 5000 * MM, ezM: 0,
    openings,
  } as unknown as WallGeometry);

  it('cuts square jambs, at the opening’s distance on both faces', () => {
    const polys = wallSolidPolygons(mitred([
      { tS: 2000 * MM, oW: 1200 * MM } as WallGeometry['openings'][number],
    ]));
    expect(polys).toHaveLength(2);
    // Before, each face was read at the same fraction of its own length and
    // the jambs came out at 2060/1960 and 3236/3164: a parallelogram.
    expect(polys[0][1]).toEqual({ x: 2000, y: 100 });
    expect(polys[0][2]).toEqual({ x: 2000, y: -100 });
    expect(polys[1][0]).toEqual({ x: 3200, y: 100 });
    expect(polys[1][3]).toEqual({ x: 3200, y: -100 });
    // The mitre corners at the wall's ends are the footprint's own.
    expect(polys[0][0]).toEqual({ x: 100, y: 100 });
    expect(polys[0][3]).toEqual({ x: -100, y: -100 });
  });

  it('gives the symbol a square frame, the wall’s real thickness deep', () => {
    const f = wallFaces(mitred([]))!;
    const o = f.outerAt(2000), i = f.innerAt(2000);
    expect(o.x).toBe(i.x);
    expect(Math.hypot(o.x - i.x, o.y - i.y)).toBe(200);
  });
});
