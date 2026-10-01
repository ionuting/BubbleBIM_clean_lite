/**
 * The export end to end, in Node: the kernel builds the box, the exporter
 * bakes it, and what comes out is one file with a real GLB inside — magic
 * bytes, a JSON chunk, and every element's id on its node — plus the five
 * drawings the box has.
 *
 * Two things the browser has and Node does not are supplied here: the
 * kernel is initialised from the wasm bytes (the app fetches them), and
 * `FileReader`, which `GLTFExporter` uses to read its own blobs back.
 *
 * Set STANDALONE_OUT=/some/dir to also write the file, to open in a browser.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';

vi.mock('@/lib/openGeoInit', () => {
  let ready: Promise<void> | null = null;
  return {
    ensureOpenGeoReady: () => {
      if (!ready) ready = (async () => {
        const { OpenGeometry } = await import('opengeometry');
        const { createRequire } = await import('node:module');
        const { readFileSync } = await import('node:fs');
        const require = createRequire(import.meta.url);
        const bytes = readFileSync(require.resolve('opengeometry/opengeometry_bg.wasm'));
        await OpenGeometry.create({ wasmURL: bytes as unknown as string });
      })();
      return ready;
    },
  };
});

/** What GLTFExporter needs of FileReader: read a blob, then call onloadend. */
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); });
  }
  readAsDataURL(blob: Blob): void {
    blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type};base64,${Buffer.from(b).toString('base64')}`;
      this.onloadend?.();
    });
  }
}

beforeAll(() => {
  (globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;
});

// The 6 × 4 m box again, with a column and a section marker through it.
const storey: BubbleGraphNode = {
  id: 's1', type: 'storey', name: 'Parter', x: 0, y: 0, z: 0, parentId: null,
  properties: { bottomElevation: 0, topElevation: 3000, axesX: [0, 6000], axesY: [0, 4000] },
};
const ax = (id: string, gx: number, gy: number, extra: Record<string, unknown> = {}): BubbleGraphNode => ({
  id, type: 'ax', name: id, x: 0, y: 0, z: 0, parentId: 's1', properties: { gridX: gx, gridY: gy, ...extra },
});
const wall = (id: string): BubbleGraphNode => ({
  id, type: 'wall', name: `Perete ${id}`, x: 0, y: 0, z: 0, parentId: 's1', properties: { wall_type: 'W25', height: 3000 },
});
const edge = (from: string, to: string): BubbleGraphEdge => ({ id: `${from}-${to}`, from, to });
const section: BubbleGraphNode = {
  id: 'sec1', type: 'section', name: 'A-A', x: 0, y: 0, z: 0, parentId: null,
  properties: { plan_cut: { x1: -1000, y1: 2000, x2: 7000, y2: 2000 }, look_side: 'left' },
};
const nodes = [
  storey, ax('A', 0, 0), ax('B', 1, 0), ax('C', 1, 1, { has_column: 'True', column_type: 'C30x30' }), ax('D', 0, 1),
  wall('south'), wall('north'), wall('west'), wall('east'), section,
];
const edges = [
  edge('A', 'south'), edge('south', 'B'), edge('D', 'north'), edge('north', 'C'),
  edge('A', 'west'), edge('west', 'D'), edge('B', 'east'), edge('east', 'C'),
];

interface GlbJson {
  asset: { generator?: string };
  nodes: { name?: string; mesh?: number; extras?: Record<string, unknown> }[];
  meshes: unknown[];
  materials: { doubleSided?: boolean }[];
}

/** The JSON chunk of a GLB — after the 12-byte header, chunk 0 is JSON. */
function glbJson(bytes: Uint8Array): GlbJson {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('glTF');
  expect(dv.getUint32(8, true)).toBe(bytes.byteLength);
  const len = dv.getUint32(12, true);
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as GlbJson;
}

describe('buildStandaloneHtml', () => {
  it('bakes the box into one file: a GLB with ids on every node, and five drawings', async () => {
    const { buildStandaloneHtml } = await import('./standaloneExport');
    const t0 = performance.now();
    const { html, meshes, drawings, boqRows } = await buildStandaloneHtml({
      projectName: 'Cutie', nodes, edges, matConfig: null, buildingAxes: { xValues: [0, 6000], yValues: [0, 4000] },
      project: { formatVersion: 1, projectName: 'Cutie', savedAt: 'now', model: { nodes, edges } } as never,
    });
    const ms = performance.now() - t0;

    expect(meshes).toBeGreaterThanOrEqual(5);    // four walls and a column
    expect(drawings).toBe(6);                    // a plan, four facades, one section

    const glbB64 = html.match(/<script id="bbim-glb"[^>]*>([^<]*)<\/script>/)![1];
    const glb = new Uint8Array(Buffer.from(glbB64, 'base64'));
    const json = glbJson(glb);
    expect(json.meshes).toHaveLength(meshes);
    const ids = json.nodes.map((n) => n.extras?.nodeId);
    for (const w of ['south', 'north', 'west', 'east']) expect(ids).toContain(w);
    expect(json.nodes.every((n) => n.extras?.storeyId === 's1')).toBe(true);
    expect(json.materials.every((m) => m.doubleSided === true)).toBe(true);

    const data = JSON.parse(html.match(/<script id="bbim-data"[^>]*>([\s\S]*?)<\/script>/)![1]);
    expect(data.storeys).toEqual([{ id: 's1', name: 'Parter', bottomMm: 0, topMm: 3000 }]);
    expect(data.elements.south.name).toBe('Perete south');
    expect(data.drawings.map((d: { title: string }) => d.title)).toEqual(['Plan Parter', 'Fațada nord', 'Fațada sud', 'Fațada est', 'Fațada vest', 'A-A']);
    expect(data.drawings[0].kind).toBe('plan');
    expect(data.drawings[0].svg.startsWith('<svg')).toBe(true);
    expect(data.drawings[0].svg).not.toMatch(/^<svg[^>]*\sstyle=/);   // no pan/zoom transform on the root
    expect(html).toContain('<script id="bbim-project"');

    // The bill of quantities travels with a price against each article, and
    // every row carries the identity the editable table keys its edits on.
    expect(boqRows).toBeGreaterThan(0);
    expect(data.boq.rows).toHaveLength(boqRows);
    expect(data.boq.currency).toBe('lei');
    expect(new Set(data.boq.rows.map((r: { key: string }) => r.key)).size).toBe(boqRows);
    for (const r of data.boq.rows) {
      expect(r.quantity).toBeGreaterThan(0);
      expect(typeof r.unitPrice).toBe('number');
      expect(r.unit).toBeTruthy();
      expect(r.denumire).toBeTruthy();
    }

    // The whole file stays small: the viewer is the bulk of it.
    expect(html.length).toBeLessThan(1.2 * 1024 * 1024);
    expect(ms).toBeLessThan(15000);

    if (process.env.STANDALONE_OUT) {
      mkdirSync(process.env.STANDALONE_OUT, { recursive: true });
      writeFileSync(path.join(process.env.STANDALONE_OUT, 'cutie.html'), html);
    }
  }, 60000);
});

describe('buildStandaloneHtmlFromSources', () => {
  it('bakes a source that is not the project: its ids, its storeys, its property sets', async () => {
    const THREE = await import('three');
    const { buildStandaloneHtmlFromSources } = await import('./standaloneExport');

    // One IFC-shaped source: a mesh already stamped, standing 10 m east.
    const group = new THREE.Group();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.25), new THREE.MeshStandardMaterial({ color: 0xd9d4c7 }));
    wall.userData = { nodeId: 'ifc:m1:100', nodeType: 'IFCWALL', storeyId: 'ifc:m1:10', source: 'ifc-1' };
    group.add(wall);
    let disposed = false;

    const { html, meshes, drawings, boqRows } = await buildStandaloneHtmlFromSources({
      projectName: 'Casa',
      sources: [{
        info: { id: 'ifc-1', name: 'Casa.ifc', kind: 'ifc', elements: 1 },
        group,
        storeys: [{ id: 'ifc:m1:10', name: 'Parter', bottomMm: 0, topMm: 3000 }],
        elements: {
          'ifc:m1:100': {
            name: 'Perete P1', type: 'IFCWALL', storeyId: 'ifc:m1:10', source: 'ifc-1',
            props: { GlobalId: 'abc', Tag: 'W-01' },
            groups: [{ name: 'Pset_WallCommon', props: { IsExternal: true } }],
          },
        },
        placement: new THREE.Matrix4().makeTranslation(10, 0, 0),
        dispose: () => { disposed = true; },
      }],
    });

    expect(meshes).toBe(1);
    expect(drawings).toBe(0);
    expect(boqRows).toBe(0);
    expect(disposed).toBe(true);
    expect(html).not.toContain('<script id="bbim-project"');

    const glb = new Uint8Array(Buffer.from(html.match(/<script id="bbim-glb"[^>]*>([^<]*)<\/script>/)![1], 'base64'));
    const json = glbJson(glb) as GlbJson & {
      accessors: { min?: number[]; max?: number[] }[];
      meshes: { primitives: { attributes: { POSITION: number } }[] }[];
    };
    expect(json.nodes[0].extras).toEqual({ nodeId: 'ifc:m1:100', nodeType: 'IFCWALL', storeyId: 'ifc:m1:10', source: 'ifc-1' });
    // The placement is baked into the vertices: the box now spans x ∈ [8, 12].
    const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    expect(pos.min![0]).toBeCloseTo(8, 5);
    expect(pos.max![0]).toBeCloseTo(12, 5);

    const data = JSON.parse(html.match(/<script id="bbim-data"[^>]*>([\s\S]*?)<\/script>/)![1]);
    expect(data.sources).toEqual([{ id: 'ifc-1', name: 'Casa.ifc', kind: 'ifc', elements: 1 }]);
    expect(data.storeys).toEqual([{ id: 'ifc:m1:10', name: 'Parter', bottomMm: 0, topMm: 3000 }]);
    expect(data.elements['ifc:m1:100'].groups).toEqual([{ name: 'Pset_WallCommon', props: { IsExternal: true } }]);
    expect(data.drawings).toEqual([]);
    expect(data.boq).toBeUndefined();
  }, 30000);
});

describe('buildStandaloneHtml with IFC models open in the viewers', () => {
  it('carries each model as a source; an empty project steps aside, a broken model is left out', async () => {
    const THREE = await import('three');
    const { buildStandaloneHtml } = await import('./standaloneExport');

    // A fragments model reduced to what the export reads: one wall, on one storey.
    const box = new THREE.BoxGeometry(4, 3, 0.25);
    const model = {
      modelId: 'Casa',
      getItemsIdsWithGeometry: async () => [100],
      getItemsGeometry: async () => [[{
        transform: new THREE.Matrix4(),
        positions: box.getAttribute('position').array as Float32Array,
        indices: box.getIndex()!.array as Uint16Array,
      }]],
      getItemsWithGeometryCategories: async () => ['IFCWALL'],
      getItemsMaterialDefinition: async () => [],
      getCoordinationMatrix: async () => new THREE.Matrix4(),
      getSpatialStructure: async () => ({
        category: null, localId: 1, children: [
          { category: 'IFCBUILDINGSTOREY', localId: null, children: [
            { category: null, localId: 10, children: [
              { category: 'IFCWALL', localId: null, children: [{ category: null, localId: 100, children: [] }] },
            ] },
          ] },
        ],
      }),
      getItemsData: async (ids: number[]) => ids.map((id) => (id === 10
        ? { Name: { value: 'Parter' }, Elevation: { value: 0 } }
        : { Name: { value: 'Perete P1' } })),
    };
    const broken = { ...model, modelId: 'Stricat', getItemsIdsWithGeometry: async () => { throw new Error('worker gone'); } };

    const { html, ifcModels, drawings } = await buildStandaloneHtml({
      projectName: 'Gol', nodes: [], edges: [], matConfig: null, buildingAxes: { xValues: [], yValues: [] },
      ifcModels: [
        { key: 'k1', name: 'Casa', getModel: () => model as never },
        { key: 'k2', name: 'Stricat', getModel: () => broken as never },
      ],
    });

    expect(ifcModels).toBe(1);
    expect(drawings).toBe(0);
    const data = JSON.parse(html.match(/<script id="bbim-data"[^>]*>([\s\S]*?)<\/script>/)![1]);
    expect(data.sources).toEqual([{ id: 'k1', name: 'Casa', kind: 'ifc', elements: 1 }]);
    expect(data.storeys.map((s: { id: string; name: string }) => [s.id, s.name])).toEqual([['ifc:Casa:10', 'Parter']]);
    expect(data.elements['ifc:Casa:100'].storeyId).toBe('ifc:Casa:10');

    const glb = new Uint8Array(Buffer.from(html.match(/<script id="bbim-glb"[^>]*>([^<]*)<\/script>/)![1], 'base64'));
    const json = glbJson(glb);
    expect(json.nodes.map((n) => n.extras)).toEqual([
      { nodeId: 'ifc:Casa:100', nodeType: 'IFCWALL', storeyId: 'ifc:Casa:10', source: 'k1' },
    ]);
  }, 30000);
});
