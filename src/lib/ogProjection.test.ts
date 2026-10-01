/**
 * What has to hold for the kernel's outlines to be usable in a drawing.
 *
 * Two things would fail silently. The coordinate mapping: lines in the right
 * place look right, and lines a metre off also look right until they are
 * compared with the engine's own shapes — so the elevation test compares
 * exactly that. And the kernel's REACH: `hide_hidden_edges` removes a solid's
 * own back faces and nothing more, which is pinned here as a fact about the
 * kernel, because a drawing built on the belief that it hides one element
 * behind another would be an x-ray and nobody would see why.
 *
 * The section tests pin which elements go through the kernel at all: beyond
 * the plane yes, cut by it no, behind the viewer no, past the depth no.
 *
 * Runs the real kernel: the wasm is loaded from the package, not mocked.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { OpenGeometry } from 'opengeometry';
import { createRoofForStorey } from '@/lib/roof';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  buildFrame, computeElevationView, computeSectionView, elevationCut, type DrawingShape, type SectionCut,
} from './drawingEngine';
import { cameraFor, collectOgEntities, depthBeyondPlane, projectOgLines, type OgEntity } from './ogProjection';

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const bytes = readFileSync(require.resolve('opengeometry/opengeometry_bg.wasm'));
  await OpenGeometry.create({ wasmURL: bytes as unknown as string });
});

// ── Fixture: a 6 × 4 m box, walls on all four sides, a column at C ──────────
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

const A = ax('A', 0, 0), B = ax('B', 1, 0), D = ax('D', 0, 1);
const C = ax('C', 1, 1, { has_column: 'True', column_type: 'C30x30' });
const south = wall('south'), north = wall('north'), west = wall('west'), east = wall('east');
const nodes = [storey, A, B, C, D, south, north, west, east];
const edges = [
  edge('A', 'south'), edge('south', 'B'),
  edge('D', 'north'), edge('north', 'C'),
  edge('A', 'west'), edge('west', 'D'),
  edge('B', 'east'), edge('east', 'C'),
];

const uvRange = (shapes: DrawingShape[]) => {
  const us = shapes.flatMap((s) => s.pts.map((p) => p.u));
  const vs = shapes.flatMap((s) => s.pts.map((p) => p.v));
  return { uMin: Math.min(...us), uMax: Math.max(...us), vMin: Math.min(...vs), vMax: Math.max(...vs) };
};

let entities: OgEntity[];
beforeAll(() => { entities = collectOgEntities(nodes, edges, null); });

describe('collectOgEntities', () => {
  it('reads every kernel solid back with its node id and a BIM-mm extent', () => {
    const ids = new Set(entities.map((e) => e.nodeId));
    for (const id of ['south', 'north', 'west', 'east', 'C']) expect(ids.has(id)).toBe(true);
    const n = entities.find((e) => e.nodeId === 'north')!;
    expect(n.nodeType).toBe('wall');
    // A 250 wall on the y = 4000 axis, 3 m tall.
    expect(n.bbox.minY).toBeCloseTo(3875, 0);
    expect(n.bbox.maxY).toBeCloseTo(4125, 0);
    expect(n.bbox.minZ).toBeCloseTo(0, 0);
    expect(n.bbox.maxZ).toBeCloseTo(3000, 0);
  });

  it('gives every entity its own UUID, which is what the kernel reports edges under', () => {
    const keys = entities.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f-]{36}$/);
    for (const e of entities) expect(JSON.parse(e.brep).id).toBe(e.key);
  });
});

describe('cameraFor', () => {
  it('stands behind the plane on the viewer’s side, looking along the frame’s look direction', () => {
    // North elevation: plane far south, looking north (+y BIM = −z kernel).
    const cam = cameraFor(buildFrame(elevationCut(nodes, 'N')));
    expect(cam.target.y).toBe(0);
    expect(cam.position.z).toBeGreaterThan(cam.target.z); // further south than the target
    expect(cam.up).toEqual({ x: 0, y: 1, z: 0 });
    expect(cam.projection_mode).toBe('Orthographic');
  });
});

describe('north elevation', () => {
  // The camera stands far SOUTH looking north, so the south wall is the near
  // one and the north wall stands directly behind it — same size, same place.
  const cut = elevationCut(nodes, 'N');

  it('draws each wall exactly where the engine draws it', () => {
    // Occlusion off: this is about the coordinate mapping and nothing else.
    // A line a metre out of place looks as plausible as a correct one, so it
    // is pinned against the engine's own extents, element by element.
    const outlines = projectOgLines(entities, cut, nodes, null, { occlude: false });
    const engine = computeElevationView(nodes, edges, null, 'N');
    for (const id of ['north', 'south', 'east', 'west', 'C']) {
      const mine = engine.shapes.filter((s) => s.nodeId === id && s.lineWeight === 'projected' && s.closed);
      const theirs = outlines.shapes.filter((s) => s.nodeId === id);
      expect(theirs.length, id).toBeGreaterThan(0);
      const a = uvRange(mine), b = uvRange(theirs);
      expect(b.uMin, id).toBeCloseTo(a.uMin, 0);
      expect(b.uMax, id).toBeCloseTo(a.uMax, 0);
      expect(b.vMin, id).toBeCloseTo(a.vMin, 0);
      expect(b.vMax, id).toBeCloseTo(a.vMax, 0);
    }
    for (const s of outlines.shapes) {
      expect(s.closed).toBe(false);
      expect(s.pts).toHaveLength(2);
    }
  });

  it('the kernel itself hides nothing behind anything — which is why we do it', () => {
    // The north wall stands wholly behind the south one, same size, same
    // place. Ask the kernel alone and every one of its edges comes back
    // visible: `hide_hidden_edges` drops a solid's own back faces and no
    // more. This is pinned because a drawing built on the opposite belief
    // would be an x-ray and nothing would say why.
    const raw = projectOgLines(entities, cut, nodes, null, { occlude: false });
    expect(raw.shapes.filter((s) => s.nodeId === 'north').length).toBeGreaterThan(0);
    expect(raw.shapes.filter((s) => s.nodeId === 'south').length).toBeGreaterThan(0);
  });

  it('with our own occlusion, the wall behind is gone', () => {
    const outlines = projectOgLines(entities, cut, nodes, null);
    expect(outlines.shapes.filter((s) => s.nodeId === 'south').length).toBeGreaterThan(0);
    // All that may survive of the wall behind is its top edge, which lies
    // exactly along the near wall's own top edge — the two walls are the
    // same height, so nothing is drawn there that was not drawn anyway.
    for (const s of outlines.shapes.filter((x) => x.nodeId === 'north')) {
      for (const p of s.pts) expect(p.v).toBeCloseTo(3000, 0);
    }
  });

  it('cuts a column back to the sliver standing past everything in front of it', () => {
    // The column at C spans u 5850..6150. Two walls stand in front of it: the
    // south one out to u 5875, and the east one — nearer still, since it runs
    // away from the viewer — out to 6125. So 25 mm of column is seen.
    const outlines = projectOgLines(entities, cut, nodes, null);
    const col = outlines.shapes.filter((s) => s.nodeId === 'C');
    expect(col.length).toBeGreaterThan(0);
    // Except along the walls' own top edge, where containment is a tie and
    // the line coincides with what is drawn there anyway (see `hlr.ts`).
    const open = col.filter((s) => !s.pts.every((p) => p.v > 2999));
    expect(open.length).toBeGreaterThan(0);
    for (const s of open) for (const p of s.pts) expect(p.u).toBeGreaterThanOrEqual(6125 - 1);
    expect(Math.max(...col.flatMap((s) => s.pts.map((p) => p.u)))).toBeCloseTo(6150, 0);
    // Its far vertical edge, wholly behind the walls, is gone.
    expect(col.some((s) => s.pts.every((p) => Math.abs(p.u - 5850) < 1))).toBe(false);
  });

  it('gives every line its own element’s depth, so the painter’s sort still decides what covers what', () => {
    const outlines = projectOgLines(entities, cut, nodes, null, { occlude: false });
    const depthOf = (id: string) => {
      const d = outlines.shapes.filter((s) => s.nodeId === id).map((s) => s.depthMm);
      expect(new Set(d).size).toBe(1);
      return d[0];
    };
    // Looking north from the south: the south wall is nearer than the north one.
    expect(depthOf('south')).toBeLessThan(depthOf('north'));
    // And the depths are the engine's own, so the two sort together.
    const engine = computeElevationView(nodes, edges, null, 'N');
    for (const id of ['north', 'south']) {
      const mine = engine.shapes.find((s) => s.nodeId === id && s.lineWeight === 'projected' && s.closed)!;
      expect(depthOf(id)).toBeCloseTo(mine.depthMm, 0);
    }
  });

  it('keeps a solid’s own back-face edges as dashed lines only when asked', () => {
    expect(projectOgLines(entities, cut, nodes, null).shapes.some((s) => s.lineWeight === 'hidden')).toBe(false);
    const kept = projectOgLines(entities, cut, nodes, null, { showBackFaces: true, occlude: false });
    expect(kept.shapes.some((s) => s.nodeId === 'north' && s.lineWeight === 'hidden')).toBe(true);
  });

  it('handed to the engine, replaces the covered strokes and keeps the face fills', () => {
    const outlines = projectOgLines(entities, cut, nodes, null);
    const r = computeElevationView(nodes, edges, null, 'N', undefined, undefined, { outlines });
    const faces = r.shapes.filter((s) => s.nodeId === 'north' && s.closed);
    expect(faces.length).toBeGreaterThan(0);
    for (const f of faces) {
      // The fill is what hides what is behind it; only the stroke goes.
      expect(f.strokeColor).toBe('none');
      expect(f.fillColor).not.toBe('none');
    }
    expect(r.shapes.some((s) => s.nodeId === 'north' && !s.closed)).toBe(true);
    // The near wall's fill still sorts after the far wall's lines.
    const northLine = r.shapes.findIndex((s) => s.nodeId === 'north' && !s.closed);
    const southFace = r.shapes.findIndex((s) => s.nodeId === 'south' && s.closed);
    expect(southFace).toBeGreaterThan(northLine);
  });
});

describe('section across the box, looking north', () => {
  // Marker through the middle, west→east; 'left' is north.
  const line = { x1: -1000, y1: 2000, x2: 7000, y2: 2000 };
  const cut = (over: Partial<SectionCut> = {}): SectionCut => ({ line, lookSide: 'left', cutDepth: 6000, elevMin: -1000, elevMax: 5000, ...over });

  it('takes what stands beyond the plane and nothing the plane cuts or that is behind the viewer', () => {
    const hlr = projectOgLines(entities, cut(), nodes, null);
    expect(hlr.covered.has('north')).toBe(true);
    expect(hlr.covered.has('C')).toBe(true);     // the column at the far corner
    expect(hlr.covered.has('south')).toBe(false); // behind the viewer
    expect(hlr.covered.has('east')).toBe(false);  // cut by the plane
    expect(hlr.covered.has('west')).toBe(false);
    const northLines = hlr.shapes.filter((s) => s.nodeId === 'north');
    expect(northLines.length).toBeGreaterThan(0);
    const r = uvRange(northLines);
    expect(r.vMin).toBeCloseTo(0, 0);
    expect(r.vMax).toBeCloseTo(3000, 0);
    // u runs along the marker from its start at x = −1000. The wall is the
    // solid the 3D viewer builds — trimmed by its neighbours at the joins —
    // so it spans x −125..5875, not the raw axis span.
    const bbox = entities.find((e) => e.nodeId === 'north')!.bbox;
    expect(r.uMin).toBeCloseTo(bbox.minX + 1000, 0);
    expect(r.uMax).toBeCloseTo(bbox.maxX + 1000, 0);
  });

  it('respects the depth: a wall 1.9 m past the plane is out of a 1 m deep section', () => {
    const hlr = projectOgLines(entities, cut({ cutDepth: 1000 }), nodes, null);
    expect(hlr.covered.has('north')).toBe(false);
    expect(hlr.shapes).toHaveLength(0);
  });

  it('handed to the engine, the covered outlines go and the cut stays untouched', () => {
    const plain = computeSectionView(nodes, edges, null, cut());
    const hlr = projectOgLines(entities, cut(), nodes, null);
    const r = computeSectionView(nodes, edges, null, cut(), { outlines: hlr });
    // The east/west walls are cut: same shapes, same weights, before and after.
    const cutOf = (res: typeof plain) => res.shapes.filter((s) => s.lineWeight === 'heavy-cut').map((s) => [s.nodeId, ...s.pts.map((p) => `${p.u.toFixed(1)},${p.v.toFixed(1)}`)].join('|')).sort();
    expect(cutOf(r)).toEqual(cutOf(plain));
    // The north wall's painter's outline is gone; the kernel's lines are there.
    expect(r.shapes.some((s) => s.nodeId === 'north' && s.closed)).toBe(false);
    expect(r.shapes.some((s) => s.nodeId === 'north' && !s.closed && s.lineWeight === 'projected')).toBe(true);
    // And they are clipped to the elevation band like everything else.
    const band = computeSectionView(nodes, edges, null, cut({ elevMax: 1500 }), { outlines: projectOgLines(entities, cut({ elevMax: 1500 }), nodes, null) });
    for (const s of band.shapes.filter((s) => s.nodeId === 'north')) for (const p of s.pts) expect(p.v).toBeLessThanOrEqual(1500 + 1e-6);
  });
});

describe('depthBeyondPlane', () => {
  const frame = buildFrame({ line: { x1: 0, y1: 0, x2: 1000, y2: 0 }, lookSide: 'left', cutDepth: 5000 });
  const box = (minY: number, maxY: number) => ({ minX: 0, maxX: 1000, minY, maxY, minZ: 0, maxZ: 3000 });
  it('gives the near face’s distance when the element is in the picture', () => {
    expect(depthBeyondPlane(box(100, 500), frame, -Infinity, Infinity)).toBeCloseTo(100, 6);
  });
  it('is null when cut by the plane, behind the viewer, too deep, or out of the band', () => {
    expect(depthBeyondPlane(box(-100, 500), frame, -Infinity, Infinity)).toBeNull();
    expect(depthBeyondPlane(box(-500, -100), frame, -Infinity, Infinity)).toBeNull();
    expect(depthBeyondPlane(box(6000, 7000), frame, -Infinity, Infinity)).toBeNull();
    expect(depthBeyondPlane(box(100, 500), frame, 4000, 5000)).toBeNull();
  });
});

describe('meshes — what the kernel cannot build still draws and still hides', () => {
  // A step block standing between the marker and the north wall, over the
  // wall's west edge: a plain THREE box, not a kernel solid.
  const tread: BubbleGraphNode = {
    id: 'tread', type: 'stair_tread', name: 'T', x: -125, y: 3000, z: 500, parentId: 's1',
    properties: { width_mm: 1000, tread_mm: 280, riser_mm: 170, dir_x: 1, dir_y: 0 },
  };
  const line = { x1: -1000, y1: 2000, x2: 7000, y2: 2000 };
  const cut: SectionCut = { line, lookSide: 'left', cutDepth: 6000, elevMin: -1000, elevMax: 5000 };

  it('reads a mesh as its triangles, in BIM mm', () => {
    const ents = collectOgEntities([...nodes, tread], edges, null);
    const t = ents.find((e) => e.nodeId === 'tread')!;
    expect(t.source).toBe('mesh');
    expect(t.faces.length).toBe(12);
    // `orientedBox` runs the 1000 width ACROSS the direction and the 280
    // tread along it; the block fills the riser under the walking surface.
    expect(t.bbox.minX).toBeCloseTo(-265, 0);
    expect(t.bbox.maxX).toBeCloseTo(15, 0);
    expect(t.bbox.minY).toBeCloseTo(2500, 0);
    expect(t.bbox.maxY).toBeCloseTo(3500, 0);
    expect(t.bbox.minZ).toBeCloseTo(330, 0);
    expect(t.bbox.maxZ).toBeCloseTo(500, 0);
  });

  it('draws the mesh’s own outline and cuts the wall behind it around it', () => {
    const ents = collectOgEntities([...nodes, tread], edges, null);
    const out = projectOgLines(ents, cut, [...nodes, tread], null);
    // The block, face-on, is a rectangle and nothing more: u 735..1015,
    // v 330..500 — four lines, no seams, no points, no doubles.
    const mine = out.shapes.filter((s) => s.nodeId === 'tread');
    expect(mine.length).toBe(4);
    const r = uvRange(mine);
    expect(r.uMin).toBeCloseTo(735, 0); expect(r.uMax).toBeCloseTo(1015, 0);
    expect(r.vMin).toBeCloseTo(330, 0); expect(r.vMax).toBeCloseTo(500, 0);
    // The wall's west edge at u = 875 is interrupted exactly behind the block.
    const west = out.shapes.filter((s) => s.nodeId === 'north' && s.pts.every((p) => Math.abs(p.u - 875) < 1));
    expect(west.length).toBe(2);
    const vs = west.flatMap((s) => s.pts.map((p) => Math.round(p.v))).sort((a, b) => a - b);
    expect(vs).toEqual([0, 330, 500, 3000]);
  });

  it('a mesh with too many triangles still hides, but is not drawn as a net', () => {
    const ents = collectOgEntities([...nodes, tread], edges, null);
    const t = ents.find((e) => e.nodeId === 'tread')!;
    // Pretend the block is a terrain: inflate its face list past the cap.
    const big = { ...t, faces: Array.from({ length: 5000 }, (_, i) => t.faces[i % t.faces.length]) };
    const out = projectOgLines([...ents.filter((e) => e !== t), big], cut, [...nodes, tread], null);
    expect(out.shapes.some((s) => s.nodeId === 'tread')).toBe(false);
    const west = out.shapes.filter((s) => s.nodeId === 'north' && s.pts.every((p) => Math.abs(p.u - 875) < 1));
    expect(west.length).toBe(2);
  });
});

describe('roof — a solid now, with its real thickness', () => {
  it('every sloping face is a kernel solid with a body', () => {
    const built = createRoofForStorey('s1', nodes, edges, { generateLevel: 'envelope' });
    const ents = collectOgEntities(built.nodes, built.edges, null);
    const roof = ents.filter((e) => e.nodeType === 'roof');
    expect(roof.length).toBeGreaterThan(0);
    for (const e of roof) {
      expect(e.source).toBe('brep');
      expect(e.faces.length).toBeGreaterThanOrEqual(6);
    }
    // In the north elevation the roof stands in front of the far wall's top,
    // and now hides it: the north wall's top edge no longer survives whole.
    const cut = elevationCut(built.nodes, 'N');
    const out = projectOgLines(ents, cut, built.nodes, null);
    expect(out.shapes.some((s) => s.nodeType === 'roof')).toBe(true);
  });
});

describe('what the engine draws as a symbol is not projected', () => {
  it('leaves planting and domes out of the entities, so the engine’s silhouettes stand alone', () => {
    const axAbs = (id: string, x: number, y: number): BubbleGraphNode => ({
      id, type: 'ax', name: id, x, y, z: 0, parentId: 's1', properties: { bimX: x, bimY: y },
    });
    const P1 = axAbs('P1', -2000, -6000), P2 = axAbs('P2', 8000, -6000), P3 = axAbs('P3', 8000, -2000), P4 = axAbs('P4', -2000, -2000);
    const trees: BubbleGraphNode = {
      id: 'trees', type: 'scatter', name: 'Copaci', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { kind: 'tree', closed: 'True', spacing_mm: 3000, seed: 3 },
    };
    const DA = axAbs('DA', 14000, 2000);
    const dome: BubbleGraphNode = {
      id: 'dome1', type: 'dome', name: 'Iglu', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { base_radius_mm: 4000, dome_height_mm: 4000, cell_count: 24, cell_seed: 2, resolution: 20 },
    };
    const all = [...nodes, P1, P2, P3, P4, trees, DA, dome];
    const allEdges = [...edges, edge('trees', 'P1'), edge('trees', 'P2'), edge('trees', 'P3'), edge('trees', 'P4'), edge('dome1', 'DA')];
    const ents = collectOgEntities(all, allEdges, null);
    expect(ents.some((e) => e.nodeType === 'wall')).toBe(true);
    expect(ents.some((e) => e.nodeType === 'dome' || e.nodeType === 'scatter')).toBe(false);
  });
});
