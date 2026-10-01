/**
 * Space boundaries on a model whose answers are known: two 5 × 4 m rooms
 * side by side on a storey at +3.00, 2.80 high, each with its ceiling slab.
 *
 *     r1 | r2        shared wall at x = 5000
 *
 * The faces are what the topology backend would send for it. The file is
 * read back with web-ifc — the engine the viewers use — and each boundary
 * checked: its space, its element, its pairing, its geometry in the space's
 * own coordinates.
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { buildIfcModel } from './buildIfcModel';
import { addSpaceBoundaries } from './spaceBoundaries';
import type { TopologyFace, TopologyResult } from '@/lib/topology/types';

type P = [number, number, number];
const storey = { id: 'st', type: 'storey', name: 'Etaj', x: 0, y: 0, z: 0, properties: { bottomElevation: 3000, topElevation: 5800, axesX: [0, 5000, 10000], axesY: [0, 4000] } } as unknown as BubbleGraphNode;
const ax = (id: string, gx: number, gy: number) => ({ id, type: 'ax', name: id, x: 0, y: 0, z: 0, parentId: 'st', properties: { gridX: gx, gridY: gy } }) as unknown as BubbleGraphNode;
const wall = (id: string) => ({ id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st', properties: { wall_type: 'W20' } }) as unknown as BubbleGraphNode;
const room = (id: string) => ({ id, type: 'room', name: id, x: 0, y: 0, z: 0, parentId: 'st', properties: { has_slab: 'True' } }) as unknown as BubbleGraphNode;

const axes = [ax('a00', 0, 0), ax('a10', 1, 0), ax('a20', 2, 0), ax('a01', 0, 1), ax('a11', 1, 1), ax('a21', 2, 1)];
const walls: [string, string, string][] = [
  ['wS1', 'a00', 'a10'], ['wS2', 'a10', 'a20'], ['wN1', 'a01', 'a11'], ['wN2', 'a11', 'a21'],
  ['wW', 'a00', 'a01'], ['wM', 'a10', 'a11'], ['wE', 'a20', 'a21'],
];
const nodes: BubbleGraphNode[] = [storey, ...axes, ...walls.map(([id]) => wall(id)), room('r1'), room('r2')];
const edges: BubbleGraphEdge[] = [
  ...walls.flatMap(([id, a, b]) => [{ id: `${id}a`, from: a, to: id }, { id: `${id}b`, from: id, to: b }]),
  ...['a00', 'a10', 'a11', 'a01'].map((a) => ({ id: `r1${a}`, from: 'r1', to: a })),
  ...['a10', 'a20', 'a21', 'a11'].map((a) => ({ id: `r2${a}`, from: 'r2', to: a })),
] as BubbleGraphEdge[];

const Z0 = 3000, Z1 = 5800;
const vface = (kind: TopologyFace['kind'], rooms: string[], el: string, a: [number, number], b: [number, number], normal: P): TopologyFace => ({
  kind, rooms, elements: [el], normal, areaM2: Math.hypot(b[0] - a[0], b[1] - a[1]) * 2.8 / 1000,
  outerMm: [[a[0], a[1], Z0], [b[0], b[1], Z0], [b[0], b[1], Z1], [a[0], a[1], Z1]],
});
const hface = (kind: TopologyFace['kind'], r: string, x0: number, z: number, normal: P): TopologyFace => ({
  kind, rooms: [r], normal, areaM2: 20,
  outerMm: [[x0, 0, z], [x0 + 5000, 0, z], [x0 + 5000, 4000, z], [x0, 4000, z]],
});
const faces: TopologyFace[] = [
  vface('wall', ['r1', 'r2'], 'wM', [5000, 0], [5000, 4000], [1, 0, 0]),
  vface('exterior', ['r1'], 'wS1', [0, 0], [5000, 0], [0, -1, 0]),
  vface('exterior', ['r2'], 'wS2', [5000, 0], [10000, 0], [0, -1, 0]),
  vface('exterior', ['r1'], 'wN1', [0, 4000], [5000, 4000], [0, 1, 0]),
  vface('exterior', ['r2'], 'wN2', [5000, 4000], [10000, 4000], [0, 1, 0]),
  vface('exterior', ['r1'], 'wW', [0, 0], [0, 4000], [-1, 0, 0]),
  vface('exterior', ['r2'], 'wE', [10000, 0], [10000, 4000], [1, 0, 0]),
  hface('roof', 'r1', 0, Z1, [0, 0, 1]), hface('roof', 'r2', 5000, Z1, [0, 0, 1]),
  hface('ground', 'r1', 0, Z0, [0, 0, -1]), hface('ground', 'r2', 5000, Z0, [0, 0, -1]),
];
const topo = {
  faces,
  rooms: [
    { id: 'r1', bottomMm: Z0, topMm: Z1 }, { id: 'r2', bottomMm: Z0, topMm: Z1 },
  ] as TopologyResult['rooms'],
  graph: { nodes: [
    { id: 'r1', name: 'r1', storeyId: 'st', degree: 1, positionMm: [2500, 2000, 4400] },
    { id: 'r2', name: 'r2', storeyId: 'st', degree: 1, positionMm: [7500, 2000, 4400] },
  ], edges: [] } as TopologyResult['graph'],
};

async function openWithWebIfc(content: string) {
  const WebIFC = await import('web-ifc');
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(path.dirname(createRequire(import.meta.url).resolve('web-ifc')) + '/', true);
  await api.Init();
  return { api, WebIFC, model: api.OpenModel(new TextEncoder().encode(content)) };
}

describe('space boundaries', () => {
  const built = buildIfcModel(nodes, edges, 'SB');

  it('knows every room’s IfcSpace', () => {
    expect(Object.keys(built.spaceIds).sort()).toEqual(['r1', 'r2']);
  });

  it('writes one boundary per side, paired, each naming its element', async () => {
    const out = addSpaceBoundaries(built.content, topo, built.spaceIds);
    // 1 shared face × 2 sides + 6 exterior + 2 roofs + 2 grounds.
    expect(out.boundaries).toBe(12);
    // The ground has no slab under it in this model: virtual, and said so.
    expect(out.virtual).toBe(2);
    expect(out.skipped).toEqual([]);

    const { api, WebIFC, model } = await openWithWebIfc(out.text);
    const ids = api.GetLineIDsWithType(model, WebIFC.IFCRELSPACEBOUNDARY2NDLEVEL);
    expect(ids.size()).toBe(12);
    const typeOf = (id: number) => api.GetLineType(model, id);
    const rels = Array.from({ length: ids.size() }, (_, i) => api.GetLine(model, ids.get(i)));
    for (const r of rels) expect(typeOf(r.RelatingSpace.value)).toBe(WebIFC.IFCSPACE);

    const kinds = rels.map((r) => typeOf(r.RelatedBuildingElement.value));
    expect(kinds.filter((k) => k === WebIFC.IFCWALL)).toHaveLength(8);
    expect(kinds.filter((k) => k === WebIFC.IFCSLAB)).toHaveLength(2);
    expect(kinds.filter((k) => k === WebIFC.IFCVIRTUALELEMENT)).toHaveLength(2);

    // The shared wall: two boundaries, one per space, pointing at each other.
    const shared = rels.filter((r) => r.InternalOrExternalBoundary.value === 'INTERNAL');
    expect(shared).toHaveLength(2);
    expect(shared[0].CorrespondingBoundary.value).toBe(shared[1].expressID);
    expect(shared[1].CorrespondingBoundary.value).toBe(shared[0].expressID);
    expect(new Set(shared.map((r) => r.RelatingSpace.value)).size).toBe(2);
    expect(rels.filter((r) => r.InternalOrExternalBoundary.value === 'EXTERNAL_EARTH')).toHaveLength(2);
    api.CloseModel(model);
  }, 60000);

  it('puts the geometry in the space’s coordinates, facing out of it', async () => {
    const out = addSpaceBoundaries(built.content, topo, built.spaceIds);
    const { api, WebIFC, model } = await openWithWebIfc(out.text);
    const ids = api.GetLineIDsWithType(model, WebIFC.IFCRELSPACEBOUNDARY2NDLEVEL);
    const rels = Array.from({ length: ids.size() }, (_, i) => api.GetLine(model, ids.get(i)));
    // Walked by hand: the paired boundaries point at each other, so a
    // flattened read would recurse for ever.
    const L = (id: number) => api.GetLine(model, id);
    const loopOf = (r: { ConnectionGeometry: { value: number } }): P[] => {
      const surf = L(L(r.ConnectionGeometry.value).SurfaceOnRelatingElement.value);
      const poly = L(L(surf.Bounds[0].value).Bound.value);
      return poly.Polygon.map((p: { value: number }) => L(p.value).Coordinates.map((c: { value: number }) => c.value) as P);
    };
    const area = (loop: P[]) => {
      const n: P = [0, 0, 0];
      loop.forEach((a, i) => {
        const b = loop[(i + 1) % loop.length];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
      });
      return { area: Math.hypot(...n) / 2, n: n.map((c) => c / (Math.hypot(...n) || 1)) as P };
    };
    for (const r of rels) {
      const loop = loopOf(r);
      const { area: a } = area(loop);
      // Every face here is 20 m² (5 × 4 floor/roof) or 14 / 11.2 m² of wall.
      expect([20, 14, 11.2].some((v) => Math.abs(a - v) < 1e-6)).toBe(true);
      // The storey sits at +3.00, so the space's own z runs 0 … 2.80.
      for (const p of loop) expect(p[2]).toBeGreaterThanOrEqual(-1e-9);
      for (const p of loop) expect(p[2]).toBeLessThanOrEqual(2.8 + 1e-9);
    }
    // A roof boundary faces up, a ground boundary faces down.
    const roof = rels.find((r) => api.GetLineType(model, r.RelatedBuildingElement.value) === WebIFC.IFCSLAB)!;
    expect(area(loopOf(roof)).n[2]).toBeCloseTo(1, 9);
    const earth = rels.find((r) => r.InternalOrExternalBoundary.value === 'EXTERNAL_EARTH')!;
    expect(area(loopOf(earth)).n[2]).toBeCloseTo(-1, 9);
    api.CloseModel(model);
  }, 60000);

  it.skipIf(!process.env.SB_DUMP)('dumps the files for an external validator', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(`${process.env.SB_DUMP}/sb-ifc4.ifc`, addSpaceBoundaries(built.content, topo, built.spaceIds).text);
    const b23 = buildIfcModel(nodes, edges, 'SB', { schema: 'IFC2X3' });
    fs.writeFileSync(`${process.env.SB_DUMP}/sb-ifc2x3.ifc`, addSpaceBoundaries(b23.content, topo, b23.spaceIds).text);
  });

  it('writes the IFC2X3 form: named 2ndLevel, no pairing', () => {
    const b23 = buildIfcModel(nodes, edges, 'SB', { schema: 'IFC2X3' });
    const out = addSpaceBoundaries(b23.content, topo, b23.spaceIds);
    expect(out.text).not.toContain('IFCRELSPACEBOUNDARY2NDLEVEL');
    expect(out.text.match(/IFCRELSPACEBOUNDARY\(/g)).toHaveLength(12);
    expect(out.text).not.toContain('EXTERNAL_EARTH');
  });
});
