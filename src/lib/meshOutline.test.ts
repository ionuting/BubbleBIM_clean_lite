/**
 * What has to hold for edges read off triangles.
 *
 * The failure that would look like success: drawing every triangle edge, so a
 * flat roof face comes out as a fan of lines and a terrain as a net. The
 * crease rule is what prevents it, and it is the first thing tested. After
 * that: an open sheet shows its rim, a closed box shows only the silhouette
 * of the side you are on, and nothing inside a body is ever drawn.
 */
import { describe, expect, it } from 'vitest';
import { CREASE_DEG, meshEdges, triangleNormal, WELD_MM } from './meshOutline';
import type { Pt3 } from './ogProjection';

const P = (x: number, y: number, z: number): Pt3 => ({ x, y, z });
/** Looking north, the way a south elevation does. */
const NORTH: Pt3 = { x: 0, y: 1, z: 0 };

/** The 12 triangles of an axis-aligned box, wound outward. */
function boxTriangles(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Pt3[][] {
  const v = [
    P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0),
    P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1),
  ];
  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1], [4, 5, 6, 7],   // bottom, top
    [0, 1, 5, 4], [1, 2, 6, 5],   // south, east
    [2, 3, 7, 6], [3, 0, 4, 7],   // north, west
  ];
  return quads.flatMap(([a, b, c, d]) => [[v[a], v[b], v[c]], [v[a], v[c], v[d]]]);
}

const lengths = (edges: { a: Pt3; b: Pt3 }[]) =>
  edges.map((e) => Math.round(Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y, e.b.z - e.a.z))).sort((a, b) => a - b);

describe('triangleNormal', () => {
  it('is the unit normal, and null for a degenerate triangle', () => {
    const n = triangleNormal(P(0, 0, 0), P(1000, 0, 0), P(0, 1000, 0))!;
    expect([n.x, n.y, n.z]).toEqual([0, 0, 1]);
    expect(triangleNormal(P(0, 0, 0), P(1000, 0, 0), P(2000, 0, 0))).toBeNull();
  });
});

describe('meshEdges', () => {
  it('does not draw the seams of a flat fan — a roof face is not a fan of lines', () => {
    // One flat quad, fan-triangulated: the diagonal is a seam between two
    // coplanar triangles and must not appear.
    const quad = [P(0, 0, 0), P(4000, 0, 0), P(4000, 3000, 0), P(0, 3000, 0)];
    const tris = [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]];
    const edges = meshEdges(tris, { x: 0, y: 0, z: -1 });
    expect(edges).toHaveLength(4);
    expect(edges.every((e) => e.kind === 'outline')).toBe(true);
    expect(lengths(edges)).toEqual([3000, 3000, 4000, 4000]);
  });

  it('draws the rim of an open sheet from whichever side it is seen', () => {
    const tris = [[P(0, 0, 0), P(1000, 0, 0), P(1000, 0, 2000)], [P(0, 0, 0), P(1000, 0, 2000), P(0, 0, 2000)]];
    for (const dir of [NORTH, { x: 0, y: -1, z: 0 }]) {
      const edges = meshEdges(tris, dir);
      expect(edges).toHaveLength(4);
    }
  });

  it('shows a box seen face-on as the rectangle it is, never its inside', () => {
    const edges = meshEdges(boxTriangles(0, 2000, 0, 1000, 0, 3000), NORTH);
    // Looking north at a box: the sides are seen exactly edge-on and cover
    // nothing, so the only lines are the four where the near face turns into
    // them. The far face and the far corners are inside and never drawn.
    expect(edges).toHaveLength(4);
    expect(lengths(edges)).toEqual([2000, 2000, 3000, 3000]);
    for (const e of edges) {
      expect(Math.min(e.a.y, e.b.y)).toBe(0);
      expect(Math.max(e.a.y, e.b.y)).toBe(0);
    }
  });

  it('gives the same box from the other side — the rule is symmetric', () => {
    const edges = meshEdges(boxTriangles(0, 2000, 0, 1000, 0, 3000), { x: 0, y: -1, z: 0 });
    expect(edges).toHaveLength(4);
    for (const e of edges) expect(e.a.y).toBe(1000);
  });

  it('seen from a corner, a box shows two faces and the crease between them', () => {
    // Looking north-east: the south and west faces are seen, meeting at the
    // vertical edge at the origin — a right-angle crease. Six silhouette
    // edges around them, one crease, nothing from the far side.
    const diag = { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 };
    const edges = meshEdges(boxTriangles(0, 2000, 0, 1000, 0, 3000), diag);
    expect(edges).toHaveLength(7);
    const creases = edges.filter((e) => e.kind === 'crease');
    expect(creases).toHaveLength(1);
    expect(creases[0].a.x).toBe(0);
    expect(creases[0].a.y).toBe(0);
  });

  it('draws a sawtooth’s step lines — that is what makes a stair read as a stair', () => {
    // Two boxes stacked like steps, seen from the south. Their touching faces
    // are interior; the step line where they meet is a crease and is drawn.
    const tris = [...boxTriangles(0, 300, 0, 1000, 0, 170), ...boxTriangles(300, 600, 0, 1000, 0, 340)];
    const edges = meshEdges(tris, NORTH);
    // The riser line at x = 300 between the two treads.
    expect(edges.some((e) => Math.abs(e.a.x - 300) < 1 && Math.abs(e.b.x - 300) < 1)).toBe(true);
    for (const e of edges) expect(Math.min(e.a.y, e.b.y)).toBe(0);
  });

  it('keeps a crease only past the threshold', () => {
    // Two quads meeting at a shallow angle: below the threshold they are one
    // surface, above it they are an edge.
    const hinge = (rise: number): Pt3[][] => [
      [P(0, 0, 0), P(1000, 0, 0), P(1000, 0, 1000)], [P(0, 0, 0), P(1000, 0, 1000), P(0, 0, 1000)],
      [P(0, 0, 1000), P(1000, 0, 1000), P(1000, rise, 2000)], [P(0, 0, 1000), P(1000, rise, 2000), P(0, rise, 2000)],
    ];
    const shallow = meshEdges(hinge(50), NORTH).filter((e) => e.kind === 'crease');
    expect(shallow).toHaveLength(0);
    const sharp = meshEdges(hinge(1000), NORTH).filter((e) => e.kind === 'crease');
    expect(sharp.length).toBeGreaterThan(0);
  });

  it('welds vertices the mesh pulled apart, so a shared edge stays shared', () => {
    const eps = WELD_MM / 4;
    const tris = [
      [P(0, 0, 0), P(1000, 0, 0), P(1000, 0, 1000)],
      [P(0, eps, 0), P(1000, 0, 1000), P(0, 0, 1000)],
    ];
    // The shared diagonal is found despite the drift, so it is a seam, not two rims.
    expect(meshEdges(tris, { x: 0, y: 0, z: -1 })).toHaveLength(4);
  });

  it('survives a degenerate triangle and an edge shared by three faces', () => {
    const tris = [
      [P(0, 0, 0), P(1000, 0, 0), P(2000, 0, 0)],          // degenerate
      ...boxTriangles(0, 1000, 0, 1000, 0, 1000),
      [P(0, 0, 0), P(1000, 0, 0), P(500, -500, 500)],      // a fin on a box edge
    ];
    expect(() => meshEdges(tris, NORTH)).not.toThrow();
    expect(meshEdges(tris, NORTH).length).toBeGreaterThan(0);
  });

  it('uses the crease threshold it is given', () => {
    const tris = boxTriangles(0, 1000, 0, 1000, 0, 1000);
    const diag = { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 };
    expect(meshEdges(tris, diag, CREASE_DEG).length).toBe(7);
    // A threshold past a right angle drops the crease and leaves the silhouette.
    expect(meshEdges(tris, diag, 100).length).toBe(6);
  });
});
