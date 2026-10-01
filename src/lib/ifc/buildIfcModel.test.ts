import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { buildIfcModel, segmentFrame } from './buildIfcModel';
import { createRoofForStorey } from '@/lib/roof';
import { BUILTIN_MATERIAL_CONFIG } from '@/lib/materialConfig';
import { readEntity, refsIn } from './stepGeometry';
import { calcWallGeometry, calcWallJoins, collectOpenings } from '@/lib/bimGeometry';

// A 5m × 4m single-storey box: 4 corner columns (C30x30), 4 walls (W20 — one
// with a door + a window), one interior beam, a room slab covering the
// footprint, and a standalone balcony `slab` node cantilevered off the east
// wall — the same fixture shape as src/dev/femCheck.tsx, so both the FEM
// spike and the IFC export exercise the identical graph topology.
const STOREY: BubbleGraphNode = {
  id: 'st', type: 'storey', name: 'Parter', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};

const ax = (id: string, x: number, y: number, hasColumn = true): BubbleGraphNode => ({
  id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
  properties: { bimX: x, bimY: y, has_column: hasColumn ? 'True' : 'False', column_type: 'C30x30' },
});

const wall = (id: string, extra: Record<string, unknown> = {}): BubbleGraphNode => ({
  id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
  properties: { wall_type: 'W20', ...extra },
});

let n = 0;
const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `e${n++}`, from, to });

function buildFixture() {
  const c0 = ax('c0', 0, 0);
  const c1 = ax('c1', 5000, 0);
  const c2 = ax('c2', 5000, 4000);
  const c3 = ax('c3', 0, 4000);
  const m0 = ax('m0', 1000, 2000);
  const m1 = ax('m1', 4000, 2000);
  const b0 = ax('b0', 6500, 0, false);
  const b1 = ax('b1', 6500, 4000, false);

  const w0 = wall('w0'); // door
  const w1 = wall('w1', { has_windows: 'True', windows: JSON.stringify([{ window_type: 'W-FIX-100x120' }]) });
  const w2 = wall('w2');
  const w3 = wall('w3');
  const door: BubbleGraphNode = {
    id: 'door1', type: 'door', name: 'D1', x: 0, y: 0, z: 0, parentId: 'st',
    properties: { door_type: 'D-SWING-90x210' },
  };
  const beam: BubbleGraphNode = {
    id: 'beam1', type: 'beam', name: 'B1', x: 2500, y: 2000, z: 0, parentId: 'st',
    properties: { beam_section: 'B25x30' },
  };
  const room: BubbleGraphNode = {
    id: 'room', type: 'room', name: 'R', x: 2500, y: 2000, z: 0, parentId: 'st',
    properties: { slab_type: 'SLAB15' },
  };
  const balcony: BubbleGraphNode = {
    id: 'balcony', type: 'slab', name: 'Balcony', x: 5750, y: 2000, z: 0, parentId: 'st',
    properties: { slab_type: 'SLAB12' },
  };

  const nodes: BubbleGraphNode[] = [STOREY, c0, c1, c2, c3, m0, m1, b0, b1, w0, w1, w2, w3, door, beam, room, balcony];
  const edges: BubbleGraphEdge[] = [
    wire('w0', 'c0'), wire('w0', 'c1'), wire('door1', 'w0'),
    wire('w1', 'c1'), wire('w1', 'c2'),
    wire('w2', 'c2'), wire('w2', 'c3'),
    wire('w3', 'c3'), wire('w3', 'c0'),
    wire('beam1', 'm0'), wire('beam1', 'm1'),
    wire('room', 'c0'), wire('room', 'c1'), wire('room', 'c2'), wire('room', 'c3'),
    wire('balcony', 'c1'), wire('balcony', 'b0'), wire('balcony', 'b1'), wire('balcony', 'c2'),
  ];
  return { nodes, edges };
}

describe('buildIfcModel', () => {
  it('produces a valid IFC4 STEP file with all element kinds', () => {
    const { nodes, edges } = buildFixture();
    const { content, entities, stats } = buildIfcModel(nodes, edges, 'Test Project');

    expect(content).toMatch(/^ISO-10303-21;/);
    expect(content).toContain("FILE_SCHEMA(('IFC4'))");
    expect(content.trim().endsWith('END-ISO-10303-21;')).toBe(true);

    const types = entities.map((e) => e.type);
    expect(types).toContain('IfcBuildingStorey');
    expect(types.filter((t) => t === 'IfcColumn')).toHaveLength(6); // 4 corners + 2 interior
    expect(types).toContain('IfcBeam');
    expect(types.filter((t) => t === 'IfcWall')).toHaveLength(4);
    expect(types).toContain('IfcDoor');
    expect(types).toContain('IfcWindow');
    expect(types.filter((t) => t === 'IfcSlab')).toHaveLength(2); // room + standalone balcony

    expect(stats.entityCount).toBeGreaterThan(0);
    expect(stats.fileSize).toBe(content.length);
  });

  it('places the storey at its real elevation and elements storey-relative (Z=0)', () => {
    const upper: BubbleGraphNode = {
      id: 'st2', type: 'storey', name: 'Etaj 1', x: 0, y: 0, z: 0,
      properties: { bottomElevation: 3000, topElevation: 6000 },
    };
    const { nodes, edges } = buildFixture();
    const col = { ...nodes.find((x) => x.id === 'c0')!, id: 'c0b', parentId: 'st2' };
    const { content } = buildIfcModel([...nodes, upper, col], edges, 'Test Project');

    // Two distinct IFCBUILDINGSTOREY elevation values (0 and 3.0/3).
    const elevMatches = [...content.matchAll(/IFCBUILDINGSTOREY\([^)]*,([\d.]+)\)/g)].map((m) => m[1]);
    expect(elevMatches.length).toBeGreaterThanOrEqual(2);
    expect(elevMatches).toContain('0.');
  });

  it('draws a wall between plain (no-column) ax endpoints, but skips a beam between them', () => {
    // Walls only need 2 ax/column endpoints (matches buildShellElements.ts's addWallShell —
    // no has_column gate); beams DO need has_column at both ends (matches buildFemModel.ts).
    const p0 = { id: 'p0', type: 'ax', name: 'p0', x: 0, y: 0, z: 0, parentId: 'st', properties: { bimX: 0, bimY: 0, has_column: 'False' } } as BubbleGraphNode;
    const p1 = { id: 'p1', type: 'ax', name: 'p1', x: 3000, y: 0, z: 0, parentId: 'st', properties: { bimX: 3000, bimY: 0, has_column: 'False' } } as BubbleGraphNode;
    const w = { id: 'w', type: 'wall', name: 'w', x: 0, y: 0, z: 0, parentId: 'st', properties: { wall_type: 'W20' } } as BubbleGraphNode;
    const b = { id: 'b', type: 'beam', name: 'b', x: 0, y: 0, z: 0, parentId: 'st', properties: { beam_section: 'B20x30' } } as BubbleGraphNode;
    const { entities } = buildIfcModel(
      [STOREY, p0, p1, w, b],
      [
        { id: 'x0', from: 'w', to: 'p0' }, { id: 'x1', from: 'w', to: 'p1' },
        { id: 'x2', from: 'b', to: 'p0' }, { id: 'x3', from: 'b', to: 'p1' },
      ],
      'Test Project',
    );
    expect(entities.some((e) => e.type === 'IfcWall')).toBe(true);
    expect(entities.some((e) => e.type === 'IfcBeam')).toBe(false);
  });

  it('skips a wall with fewer than 2 ax/column endpoints', () => {
    const p0 = { id: 'p0', type: 'ax', name: 'p0', x: 0, y: 0, z: 0, parentId: 'st', properties: { bimX: 0, bimY: 0, has_column: 'True', column_type: 'C25x25' } } as BubbleGraphNode;
    const looseWall = { id: 'wLoose', type: 'wall', name: 'wLoose', x: 0, y: 0, z: 0, parentId: 'st', properties: { wall_type: 'W20' } } as BubbleGraphNode;
    const { content, entities } = buildIfcModel(
      [STOREY, p0, looseWall],
      [{ id: 'x0', from: 'wLoose', to: 'p0' }],
      'Test Project',
    );
    expect(entities.some((e) => e.type === 'IfcWall')).toBe(false);
    expect(content).toMatch(/^ISO-10303-21;/); // still a valid (near-empty) file
  });
});

describe('stairs in the IFC export', () => {
  const STOREY2: BubbleGraphNode = {
    id: 'st2', type: 'storey', name: 'Etaj 1', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 2900, topElevation: 5800 },
  };
  const sw = (props: Record<string, unknown>): BubbleGraphNode => ({
    id: 'sw', type: 'stairwell', name: 'Scara', x: 1000, y: 1000, z: 0,
    parentId: 'st', properties: { width_mm: 1000, ...props },
  });
  const count = (content: string, entity: string) =>
    (content.match(new RegExp(`=\\s*${entity}\\(`, 'g')) ?? []).length;

  it('exports a straight stair as one IfcStair carrying the cast profile', () => {
    const { content } = buildIfcModel([STOREY, STOREY2, sw({ stair_type: 'straight' })], [], 'T');
    expect(count(content, 'IFCSTAIR')).toBe(1);
    // The body is our sawtooth-over-waist cross-section, not the primitive's
    // detached tread plates: an arbitrary closed profile with a point per
    // riser and tread (2n + head, tail and foot points).
    expect(count(content, 'IFCARBITRARYCLOSEDPROFILEDEF')).toBeGreaterThanOrEqual(1);
    const poly = content.match(/IFCPOLYLINE\(\(([^)]*#[^)]*)\)\)/);
    expect(poly).not.toBeNull();
  });

  it('exports an L as two IfcStairs and the landing as a slab', () => {
    const plain = buildIfcModel([STOREY, STOREY2], [], 'T').content;
    const { content } = buildIfcModel([STOREY, STOREY2, sw({ stair_type: 'l_shape' })], [], 'T');
    expect(count(content, 'IFCSTAIR')).toBe(2);
    expect(count(content, 'IFCSLAB') - count(plain, 'IFCSLAB')).toBe(1);
  });

  it('exports a winder turn: two flights plus one slab per winder', () => {
    const plain = buildIfcModel([STOREY, STOREY2], [], 'T').content;
    const { content } = buildIfcModel(
      [STOREY, STOREY2, sw({ stair_type: 'l_shape', turn_style: 'winder', winder_count: 3 })], [], 'T',
    );
    expect(count(content, 'IFCSTAIR')).toBe(2);
    expect(count(content, 'IFCSLAB') - count(plain, 'IFCSLAB')).toBe(3);
  });

  it('exports a spiral as winder slabs and its pole as a column', () => {
    const plain = buildIfcModel([STOREY, STOREY2], [], 'T').content;
    const { content } = buildIfcModel(
      [STOREY, STOREY2, sw({ stair_type: 'spiral', spiral_inner_mm: 100 })], [], 'T',
    );
    expect(count(content, 'IFCSTAIR')).toBe(0);
    expect(count(content, 'IFCSLAB') - count(plain, 'IFCSLAB')).toBe(16); // 17 risers → 16 wedges
    expect(count(content, 'IFCCOLUMN')).toBe(1);
  });

  it('leaves the file valid when the stair does not solve', () => {
    // Only one storey and no height to climb — the stair is skipped, the rest exports.
    const { content } = buildIfcModel(
      [{ ...STOREY, properties: { bottomElevation: 0, topElevation: 0 } }, sw({})], [], 'T',
    );
    expect(count(content, 'IFCSTAIR')).toBe(0);
    expect(content).toContain('IFCBUILDINGSTOREY');
  });
});

describe('sweeps in the IFC export', () => {
  const count = (content: string, entity: string) =>
    (content.match(new RegExp(`=\\s*${entity}\\(`, 'g')) ?? []).length;

  const pt = (id: string, x: number, y: number): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y },
  });

  const SWEEP_DEFAULTS = {
    profile: 'rect', p_w_mm: 300, p_h_mm: 600,
    anchor_x: 'mid', anchor_y: 'max', level: 'top',
    offset_z_mm: 0, offset_x_mm: 0, rotation_deg: 0,
    mirror: 'False', corners: 'miter', closed: 'False', height_mm: 0,
  };

  function scene(anchors: [string, number, number][], props: Record<string, unknown> = {}) {
    const pts = anchors.map(([id, x, y]) => pt(id, x, y));
    const sweep: BubbleGraphNode = {
      id: 'sw1', type: 'sweep', name: 'Cornisa', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { ...SWEEP_DEFAULTS, ...props },
    };
    const es: BubbleGraphEdge[] = pts.map((p, i) => ({ id: `se${i}`, from: 'sw1', to: p.id }));
    return { nodes: [STOREY, sweep, ...pts], edges: es };
  }

  it('exports a run of segments as ONE mitred solid, not one extrusion per segment', () => {
    const plain = buildIfcModel([STOREY], [], 'T').content;
    const l = scene([['p0', 0, 0], ['p1', 4000, 0], ['p2', 4000, 3000]]);
    const { content } = buildIfcModel(l.nodes, l.edges, 'T');
    // 'auto' on a horizontal run → IFCBEAM; the corner is mitred, so the body
    // is the swept solid itself, written as a B-rep.
    expect(count(content, 'IFCBEAM') - count(plain, 'IFCBEAM')).toBe(1);
    expect(count(content, 'IFCFACETEDBREP')).toBe(1);
  });

  it('a closed ring is one solid, closed on itself', () => {
    const ring = scene(
      [['p0', 0, 0], ['p1', 4000, 0], ['p2', 4000, 4000], ['p3', 0, 4000]],
      { closed: 'True' },
    );
    const { content } = buildIfcModel(ring.nodes, ring.edges, 'T');
    expect(count(content, 'IFCBEAM')).toBe(1);
    expect(count(content, 'IFCFACETEDBREP')).toBe(1);
  });

  it('meets itself at the corner: no notch outside, no overlap inside', async () => {
    const ring = scene(
      [['p0', 0, 0], ['p1', 4000, 0], ['p2', 4000, 4000], ['p3', 0, 4000]],
      { closed: 'True' },
    );
    const { content } = buildIfcModel(ring.nodes, ring.edges, 'T');
    // Read back by web-ifc (what the viewers use): the plan outline of the
    // ring is exactly the 4.3 × 4.3 m outer square — a notched corner would
    // leave the outer corner point unreached.
    const WebIFC = await import('web-ifc');
    const { createRequire } = await import('node:module');
    const path = await import('node:path');
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath(path.dirname(createRequire(import.meta.url).resolve('web-ifc')) + '/', true);
    await api.Init();
    const m = api.OpenModel(new TextEncoder().encode(content));
    const xs: number[] = [], zs: number[] = [];
    api.StreamAllMeshes(m, (mesh) => {
      for (let g = 0; g < mesh.geometries.size(); g++) {
        const pg = mesh.geometries.get(g);
        const geo = api.GetGeometry(m, pg.geometryExpressID);
        const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
        const T = pg.flatTransformation;
        for (let k = 0; k < v.length; k += 6) {
          xs.push(T[0] * v[k] + T[4] * v[k + 1] + T[8] * v[k + 2] + T[12]);
          zs.push(T[2] * v[k] + T[6] * v[k + 1] + T[10] * v[k + 2] + T[14]);
        }
      }
    });
    api.CloseModel(m);
    const corner = xs.some((x, i) => Math.abs(x - 4.15) < 1e-3 && Math.abs(Math.abs(zs[i]) - 0.15) < 1e-3);
    expect(Math.max(...xs)).toBeCloseTo(4.15, 3);
    expect(Math.min(...xs)).toBeCloseTo(-0.15, 3);
    expect(corner).toBe(true);
  }, 60000);

  it('a single anchor exports as a vertical IFCCOLUMN', () => {
    const v = scene([['p0', 1000, 2000]]);
    const { content } = buildIfcModel(v.nodes, v.edges, 'T');
    expect(count(content, 'IFCCOLUMN')).toBe(1);
    expect(count(content, 'IFCBEAM')).toBe(0);
  });

  it('ifc_type overrides the automatic choice', () => {
    const h = scene([['p0', 0, 0], ['p1', 4000, 0]], { ifc_type: 'IFCRAILING' });
    const { content } = buildIfcModel(h.nodes, h.edges, 'T');
    expect(count(content, 'IFCRAILING')).toBe(1);
    expect(count(content, 'IFCBEAM')).toBe(0);
  });

  it('an unwired sweep is skipped and the file stays valid', () => {
    const orphan: BubbleGraphNode = {
      id: 'sw2', type: 'sweep', name: 'Orfan', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { ...SWEEP_DEFAULTS },
    };
    const { content } = buildIfcModel([STOREY, orphan], [], 'T');
    expect(content).toContain('IFCBUILDINGSTOREY');
    expect(count(content, 'IFCBEAM')).toBe(0);
  });
});

// ── Roof trim ───────────────────────────────────────────────────────────────
//
// A gable over the 5 × 4 m box: the ridge runs along the long side (x) at
// y = 2000, so w1 (x = 5000) and w3 (x = 0) cross it and become gables, while
// w0 and w2 run along the eaves and stay plain boxes.

describe('buildIfcModel — roof trim', () => {
  function roofed(wallOver: Record<string, unknown> = {}) {
    const { nodes, edges } = buildFixture();
    const tuned = nodes.map((x) => (x.type === 'wall' ? { ...x, properties: { ...x.properties, ...wallOver } } : x));
    return createRoofForStorey('st', tuned, edges, { generateLevel: 'envelope' });
  }
  const gables = (content: string) => [...content.matchAll(/:gable'/g)].length;
  const entityCount = (content: string, entity: string) =>
    (content.match(new RegExp(`=\\s*${entity}\\(`, 'g')) ?? []).length;
  /** How many extruded solids in the file are swept exactly `d` metres. */
  const sweptCount = (content: string, d: number) =>
    [...content.matchAll(/IFCEXTRUDEDAREASOLID\([^)]*?,([\d.E+-]+)\);/g)]
      .filter((m) => Number(m[1]) === d).length;

  it('leaves a model with no roof exactly as it was', () => {
    const { nodes, edges } = buildFixture();
    const { content, entities } = buildIfcModel(nodes, edges, 'T');
    expect(gables(content)).toBe(0);
    expect(entities.filter((e) => e.type === 'IFCWALL')).toHaveLength(0);
    expect(entities.filter((e) => e.type === 'IfcWall')).toHaveLength(4);
  });

  it('a wall that attaches to the roof exports as a box plus its own gable product', () => {
    const r = roofed({ roof_attach: 'True' });
    const { content, entities } = buildIfcModel(r.nodes, r.edges, 'T');

    // The two walls under the ridge; the eave walls only got taller.
    expect(content).toContain("'w1:gable'");
    expect(content).toContain("'w3:gable'");
    expect(content).not.toContain("'w0:gable'");
    expect(content).not.toContain("'w2:gable'");
    // Each gable is a swept elevation profile, not another parametric wall.
    expect(entities.filter((e) => e.type === 'IFCWALL')).toHaveLength(2);
    expect(entities.filter((e) => e.type === 'IfcWall')).toHaveLength(4);
    expect(content).toContain('IFCARBITRARYCLOSEDPROFILEDEF');
    expect(content).toMatch(/^ISO-10303-21;/);
    expect(content.trim().endsWith('END-ISO-10303-21;')).toBe(true);
  });

  it('a wall taller than the roof is cut back even without asking, and its openings survive', () => {
    const { nodes, edges } = buildFixture();
    const tall = nodes.map((x) => (x.type === 'wall' ? { ...x, properties: { ...x.properties, height: 6000 } } : x));
    const r = createRoofForStorey('st', tall, edges, { generateLevel: 'envelope' });
    const { content, entities } = buildIfcModel(r.nodes, r.edges, 'T');

    expect(gables(content)).toBe(2);
    // w1 carries the window; it is still hosted, on the box part.
    expect(entities.map((e) => e.type)).toContain('IfcWindow');
    expect(entities.map((e) => e.type)).toContain('IfcDoor');
  });

  it('the gable is swept through its own thickness', () => {
    const base = roofed({ roof_attach: 'True' });
    const plain = buildIfcModel(base.nodes, base.edges, 'T');
    const thin = roofed({ roof_attach: 'True', gable_thickness_mm: 150 });
    const { content } = buildIfcModel(thin.nodes, thin.edges, 'T');

    expect(gables(content)).toBe(2);
    // The two gables move from the wall's 200 to their own 150.
    expect(sweptCount(content, 0.15) - sweptCount(plain.content, 0.15)).toBe(2);
    expect(sweptCount(plain.content, 0.2) - sweptCount(content, 0.2)).toBe(2);
  });

  it('the gable offset moves it off the wall axis', () => {
    // w1 runs c1(5000,0) → c2(5000,4000), so its normal is +x. A 150 gable is
    // swept from half a thickness back: x = 5.0 − 0.075, and +50 of offset
    // slides that to 4.975.
    const centred = roofed({ roof_attach: 'True', gable_thickness_mm: 150 });
    expect(buildIfcModel(centred.nodes, centred.edges, 'T').content).toContain('4.925');

    const shifted = roofed({ roof_attach: 'True', gable_thickness_mm: 150, gable_offset_mm: 50 });
    const { content } = buildIfcModel(shifted.nodes, shifted.edges, 'T');
    expect(content).toContain('4.975');
    expect(content).not.toContain('4.925');
  });

  it('a gable material becomes an IfcMaterial on the gable alone', () => {
    const timber = roofed({ roof_attach: 'True', gable_material: 'wood' });
    const { content } = buildIfcModel(timber.nodes, timber.edges, 'T');
    const wood = /#(\d+)=IFCMATERIAL\('wood'/.exec(content);
    expect(wood).not.toBeNull();
    // One association carries the wood, and it names the two gables only.
    const rels = content.split('\n').filter((l) => l.includes('IFCRELASSOCIATESMATERIAL') && l.endsWith(`,#${wood![1]});`));
    expect(rels).toHaveLength(1);
    // After the `#id=`: owner history, the two gables, the material.
    expect(rels[0].split('=')[1].match(/#\d+/g)!.length).toBe(2 /* gables */ + 2 /* owner history + material */);

    // Nothing is written for a wall that carries on in one material — that
    // would give every existing model a material it never had. (The roof's
    // covering material is present in both files and cancels out.)
    const plain = roofed({ roof_attach: 'True' });
    const bare = buildIfcModel(plain.nodes, plain.edges, 'T').content;
    expect(bare).not.toContain("IFCMATERIAL('wood'");
    expect(entityCount(content, 'IFCRELASSOCIATESMATERIAL')).toBe(entityCount(bare, 'IFCRELASSOCIATESMATERIAL') + 1);

    // …and the material alone leaves the gable on the wall's own thickness.
    expect(sweptCount(content, 0.2)).toBe(sweptCount(bare, 0.2));
    expect(sweptCount(content, 0.15)).toBe(sweptCount(bare, 0.15));
  });

  it('a wall that outranks the roof, or a roof that opts out, exports untrimmed', () => {
    const outranks = roofed({ roof_attach: 'True', trim_priority: 200 });
    expect(gables(buildIfcModel(outranks.nodes, outranks.edges, 'T').content)).toBe(0);

    const off = roofed({ roof_attach: 'True' });
    const noTrim = off.nodes.map((x) => (x.type === 'roof'
      ? { ...x, properties: { ...x.properties, trim_below: 'False' } } : x));
    expect(gables(buildIfcModel(noTrim, off.edges, 'T').content)).toBe(0);
  });
});

describe('appearance from the material settings', () => {
  const entityCount = (content: string, entity: string) =>
    (content.match(new RegExp(`=\\s*${entity}\\(`, 'g')) ?? []).length;

  it('paints every element kind from the settings instead of the library grey', () => {
    const { nodes, edges } = buildFixture();
    const { content } = buildIfcModel(nodes, edges, 'T');
    for (const style of ['wall', 'column', 'beam', 'slab', 'door', 'window 55%', 'room 15%']) {
      expect(content).toContain(`IFCSURFACESTYLE('${style}'`);
    }
    // One styled item per product solid; only the opening voids go unstyled.
    expect(entityCount(content, 'IFCSTYLEDITEM')).toBeGreaterThanOrEqual(
      entityCount(content, 'IFCEXTRUDEDAREASOLID') - entityCount(content, 'IFCOPENINGELEMENT'),
    );
    expect(content).not.toMatch(/IFCSTYLEDITEM\(#\d+,\(#22\)/);   // #22 is the library's 'Default'
  });

  it('writes the window translucent, as the viewer draws it', () => {
    const { nodes, edges } = buildFixture();
    const { content } = buildIfcModel(nodes, edges, 'T');
    const style = /#(\d+)=IFCSURFACESTYLE\('window 55%',\.BOTH\.,\(#(\d+)\)\);/.exec(content)!;
    expect(style).not.toBeNull();
    expect(content).toMatch(new RegExp(`#${style[2]}=IFCSURFACESTYLERENDERING\\(#\\d+,0\\.45,`));
  });

  it('a named material becomes the colour AND an IfcMaterial with the catalogue label', () => {
    const { nodes, edges } = buildFixture();
    const bricked = nodes.map((x) => (x.id === 'w0' ? { ...x, properties: { ...x.properties, material: 'brick' } } : x));
    const { content } = buildIfcModel(bricked, edges, 'T');
    expect(content).toContain("IFCMATERIAL('Brick'");
    expect(content).toContain("IFCSURFACESTYLE('Brick'");
    // #C0614A → 192, 97, 74 → 0.753, 0.380, 0.290
    expect(content).toMatch(/IFCCOLOURRGB\(\$,0\.75\d*,0\.38\d*,0\.29\d*\)/);
  });

  it('the user\'s own settings win over the built-in catalogue', () => {
    const { nodes, edges } = buildFixture();
    const red = {
      ...BUILTIN_MATERIAL_CONFIG,
      element_defaults: {
        ...BUILTIN_MATERIAL_CONFIG.element_defaults,
        wall: { ...BUILTIN_MATERIAL_CONFIG.element_defaults.wall, color_3d: '#ff0000' },
      },
    };
    const { content } = buildIfcModel(nodes, edges, 'T', { materialConfig: red });
    expect(content).toMatch(/IFCCOLOURRGB\(\$,1\.?0*,0\.?0*,0\.?0*\)/);
  });

  it('a node colour override reaches the file', () => {
    const { nodes, edges } = buildFixture();
    const tinted = nodes.map((x) => (x.id === 'c0' ? { ...x, properties: { ...x.properties, color_3d: '#00ff00' } } : x));
    const { content } = buildIfcModel(tinted, edges, 'T');
    expect(content).toMatch(/IFCCOLOURRGB\(\$,0\.?0*,1\.?0*,0\.?0*\)/);
  });
});

describe('geometry the 3D viewer draws and the file used to miss', () => {
  const entityCount = (content: string, entity: string) =>
    (content.match(new RegExp(`=\\s*${entity}\\(`, 'g')) ?? []).length;

  it('a standalone beam hangs from the storey top: its centre sits half a height below', () => {
    const { nodes, edges } = buildFixture();
    const { content } = buildIfcModel(nodes, edges, 'T');
    // B25x30 from m0 (1000, 2000) under a 3.0 m storey: centre at 3 − 0.15 = 2.85.
    expect(content).toMatch(/IFCCARTESIANPOINT\(\(1\.,2\.,2\.85\)\)/);
    expect(content).not.toMatch(/IFCCARTESIANPOINT\(\(1\.,2\.,3\.\)\)/);
  });

  it('a wall with a ring beam writes the beam too', () => {
    const { nodes, edges } = buildFixture();
    const ringed = nodes.map((x) => (x.id === 'w2' ? { ...x, properties: { ...x.properties, has_beam: 'True', beam_section: 'B25x30' } } : x));
    const plain = buildIfcModel(nodes, edges, 'T');
    const { content, entities } = buildIfcModel(ringed, edges, 'T');
    expect(entities.filter((e) => e.type === 'IfcBeam')).toHaveLength(
      plain.entities.filter((e) => e.type === 'IfcBeam').length + 1,
    );
    expect(content).toContain("'w2:beam'");
  });

  it('a foundation node becomes a pad footing', () => {
    const { nodes, edges } = buildFixture();
    const footing: BubbleGraphNode = {
      id: 'f1', type: 'foundation', name: 'F1', x: 1000, y: 1000, z: 0, parentId: 'st', properties: {},
    };
    const { content, entities } = buildIfcModel([...nodes, footing], edges, 'T');
    expect(entities.map((e) => e.type)).toContain('IfcFooting');
    expect(content).toContain("IFCSURFACESTYLE('foundation'");
  });

  it('a room becomes an IfcSpace with the room\'s polygon', () => {
    const { nodes, edges } = buildFixture();
    const { entities } = buildIfcModel(nodes, edges, 'T');
    expect(entities.filter((e) => e.type === 'IfcSpace')).toHaveLength(1);
  });

  it('a shell rings the storey as one mitred wall per side; a covering likewise', () => {
    const { nodes, edges } = buildFixture();
    const shell: BubbleGraphNode = {
      id: 'sh', type: 'shell', name: 'Shell', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { thickness: 150, height: 2800 },
    };
    const cover: BubbleGraphNode = {
      id: 'cv', type: 'covering', name: 'Cover', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { thickness: 20, height: 2800 },
    };
    const wired = [...edges, ...['c0', 'c1', 'c2', 'c3'].flatMap((c) => [wire('sh', c), wire('cv', c)])];
    const plain = buildIfcModel(nodes, edges, 'T');
    const { content } = buildIfcModel([...nodes, shell, cover], wired, 'T');
    for (let i = 0; i < 4; i++) {
      expect(content).toContain(`'sh:ring:${i}'`);
      expect(content).toContain(`'cv:ring:${i}'`);
    }
    expect(entityCount(content, 'IFCCOVERING') - entityCount(plain.content, 'IFCCOVERING')).toBe(4);
  });

  it('a roof writes one IfcRoof per slope, in the covering material', () => {
    const { nodes, edges } = buildFixture();
    const r = createRoofForStorey('st', nodes, edges, { generateLevel: 'envelope' });
    const { content, entities } = buildIfcModel(r.nodes, r.edges, 'T');
    const roofs = entities.filter((e) => e.type === 'IFCROOF');
    expect(roofs.length).toBeGreaterThanOrEqual(2);
    // The default covering, 'Tigla ceramica', resolves to the catalogue's roof tile.
    expect(content).toContain("IFCMATERIAL('Roof tile");
  });
});

describe('openings show through the rings, and the fills have frames', () => {
  const count = (content: string, entity: string) =>
    (content.match(new RegExp(`=\\s*${entity}\\(`, 'g')) ?? []).length;

  /** The ring segments that a void relation cuts, by tag. */
  function voidedTags(content: string): string[] {
    const tagOf = new Map<number, string>();
    for (const line of content.split('\n')) {
      // The tag is the last quoted argument before the predefined type; a
      // name such as "R (covering)" carries a parenthesis, so no `[^)]` here.
      const m = /^#(\d+)=IFC(?:WALL|COVERING)\(.*,'([^']+)',\.NOTDEFINED\.\);$/.exec(line);
      if (m) tagOf.set(parseInt(m[1], 10), m[2]);
    }
    return [...content.matchAll(/IFCRELVOIDSELEMENT\('[^']+',#\d+,\$,\$,#(\d+),#\d+\)/g)]
      .map((m) => tagOf.get(parseInt(m[1], 10)) ?? '?');
  }

  it('the envelope is cut exactly where the walls behind it have openings', () => {
    const { nodes, edges } = buildFixture();
    const shell: BubbleGraphNode = {
      id: 'sh', type: 'shell', name: 'Shell', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { thickness: 150, height: 3000 },
    };
    const wired = [...edges, ...['c0', 'c1', 'c2', 'c3'].map((c) => wire('sh', c))];
    const plain = buildIfcModel(nodes, edges, 'T');
    const { content } = buildIfcModel([...nodes, shell], wired, 'T');

    // The door is on w0 (c0→c1, the south edge), the window on w1 (c1→c2).
    const shellCuts = voidedTags(content).filter((t) => t.startsWith('sh:'));
    expect(shellCuts).toHaveLength(2);
    expect(new Set(shellCuts).size).toBe(2);              // two different sides
    expect(count(content, 'IFCRELVOIDSELEMENT') - count(plain.content, 'IFCRELVOIDSELEMENT')).toBe(2);
    // The room's own covering, inside, is cut by the same openings.
    expect(voidedTags(plain.content).filter((t) => t.startsWith('room:covering')).length).toBeGreaterThanOrEqual(2);
  });

  it('every cut stands on the wall\'s sill, through the wall, relative to the ring', () => {
    const { nodes, edges } = buildFixture();
    const shell: BubbleGraphNode = {
      id: 'sh', type: 'shell', name: 'Shell', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { thickness: 150, height: 3000 },
    };
    const wired = [...edges, ...['c0', 'c1', 'c2', 'c3'].map((c) => wire('sh', c))];
    const { content } = buildIfcModel([...nodes, shell], wired, 'T');
    for (const line of content.split('\n')) {
      if (!line.includes('IFCOPENINGELEMENT(')) continue;
      expect(line).toMatch(/,\$,\.OPENING\.\);$/);
    }
    expect(content.trim().endsWith('END-ISO-10303-21;')).toBe(true);
  });

  it('a window is stiles, rails and a translucent pane; a door stiles, a rail and a leaf', () => {
    const { nodes, edges } = buildFixture();
    const { content } = buildIfcModel(nodes, edges, 'T');
    const solidsOf = (type: 'IFCWINDOW' | 'IFCDOOR') => {
      const line = content.split('\n').find((l) => l.includes(`=${type}(`))!;
      const shapeId = parseInt(/,#(\d+),#(\d+),/.exec(line)![2], 10);
      const shape = readEntity(content, shapeId)!;
      const rep = readEntity(content, refsIn(shape.args[2])[0])!;
      return refsIn(rep.args[3]);
    };
    expect(solidsOf('IFCWINDOW')).toHaveLength(5);
    expect(solidsOf('IFCDOOR')).toHaveLength(4);
    expect(content).toContain("IFCSURFACESTYLE('Window frame'");
    expect(content).toContain("IFCSURFACESTYLE('Glass 35%'");
    expect(content).toContain("IFCSURFACESTYLE('Door leaf'");
    // No box is left behind: each fill's original solid was removed with its profile.
    expect(content).not.toMatch(/IFCSTYLEDITEM\(#\d+,\(#\d+\),\$\);\n[^\n]*IFCSTYLEDITEM\(#0,/);
  });
});

describe('a ring void lands on the segment that actually covers the wall', () => {
  // `insetPolygon` returns vertex i as the intersection of edge-lines i and
  // i+1 — the offset of the ORIGINAL vertex i+1 — so a ring segment's index
  // does NOT name the polygon edge it covers. Matching them by index put the
  // south facade's windows on the east facade's segment, where they cut
  // nothing: every opening in the exported envelope was plastered over, and
  // the file still validated. The invariant below is what was missing.
  function withShell() {
    const { nodes, edges } = buildFixture();
    const shell: BubbleGraphNode = {
      id: 'sh', type: 'shell', name: 'Shell', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { thickness: 150, height: 3000, contour_offset: '325' },
    };
    return buildIfcModel(
      [...nodes, shell],
      [...edges, ...['c0', 'c1', 'c2', 'c3'].map((c) => wire('sh', c))],
      'T',
    );
  }

  /** The host's plan quad, in storey coordinates, read back out of the file. */
  function hostQuad(content: string, hostId: number) {
    const host = readEntity(content, hostId)!;
    const shape = readEntity(content, refsIn(host.args[6])[0])!;
    const rep = readEntity(content, refsIn(shape.args[2])[0])!;
    const solid = readEntity(content, refsIn(rep.args[3])[0])!;
    const profile = readEntity(content, refsIn(solid.args[0])[0])!;
    const polyline = readEntity(content, refsIn(profile.args[2])[0])!;
    // The closing point repeats the first, so the last is dropped.
    const ids = refsIn(polyline.args[0]).slice(0, -1);
    return ids.map((id) => {
      const [x, y] = readEntity(content, id)!.args[0].replace(/[()]/g, '').split(',').map(Number);
      return { x: x * 1000, y: y * 1000 };
    });
  }

  /** Every void whose host is a ring segment, with its opening's frame. */
  function ringVoidPairs(content: string) {
    const tags = new Map<number, string>();
    for (const line of content.split('\n')) {
      const m = /^#(\d+)=IFC(?:WALL|COVERING)\(.*,'([^']+)',\.NOTDEFINED\.\);$/.exec(line);
      if (m && /:(ring|covering):/.test(m[2])) tags.set(parseInt(m[1], 10), m[2]);
    }
    return [...content.matchAll(/IFCRELVOIDSELEMENT\('[^']+',#\d+,\$,\$,#(\d+),#(\d+)\)/g)]
      .map((m) => ({ hostId: parseInt(m[1], 10), openingId: parseInt(m[2], 10) }))
      .filter((p) => tags.has(p.hostId))
      .map((p) => {
        const opening = readEntity(content, p.openingId)!;
        const placement = readEntity(content, refsIn(opening.args[5])[0])!;
        const axis2 = readEntity(content, refsIn(placement.args[1])[0])!;
        const nums = (id: number) =>
          readEntity(content, id)!.args[0].replace(/[()]/g, '').split(',').map(Number);
        return {
          ...p, tag: tags.get(p.hostId)!,
          location: nums(refsIn(axis2.args[0])[0]),
          refDirection: nums(refsIn(axis2.args[2])[0]),
        };
      });
  }

  it('cuts along the segment, never across it', () => {
    const { content } = withShell();
    const pairs = ringVoidPairs(content);
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) {
      const f = segmentFrame(hostQuad(content, p.hostId))!;
      expect(f).not.toBeNull();
      // The opening runs ALONG its host, which is the whole invariant: a
      // south-facing window may only ever cut a south-facing segment.
      const dot = Math.abs(p.refDirection[0] * f.dx + p.refDirection[1] * f.dy);
      expect(dot).toBeCloseTo(1, 6);
    }
  });

  it('places every cut inside its host\'s own length', () => {
    const { content } = withShell();
    for (const p of ringVoidPairs(content)) {
      const f = segmentFrame(hostQuad(content, p.hostId))!;
      const rx = p.location[0] * 1000 - f.cx, ry = p.location[1] * 1000 - f.cy;
      expect(Math.abs(rx * f.dx + ry * f.dy)).toBeLessThanOrEqual(f.halfLen);
    }
  });

  it('cuts the two facades that have openings and leaves the other two whole', () => {
    const { content } = withShell();
    const byTag = new Map<string, number>();
    for (const p of ringVoidPairs(content)) {
      if (!p.tag.startsWith('sh:')) continue;
      byTag.set(p.tag, (byTag.get(p.tag) ?? 0) + 1);
    }
    // The fixture puts a door on w0 (c0→c1) and a window on w1 (c1→c2).
    expect(byTag.size).toBe(2);
    expect([...byTag.values()].sort()).toEqual([1, 1]);
  });
});

describe('segmentFrame', () => {
  it('measures a long thin quad along its length, whatever order it is given in', () => {
    const quad = [{ x: 0, y: -100 }, { x: 6000, y: -100 }, { x: 6000, y: 100 }, { x: 0, y: 100 }];
    for (const q of [quad, [...quad].reverse(), [...quad.slice(2), ...quad.slice(0, 2)]]) {
      const f = segmentFrame(q)!;
      expect(f.cx).toBeCloseTo(3000, 6);
      expect(f.cy).toBeCloseTo(0, 6);
      expect(Math.abs(f.dx)).toBeCloseTo(1, 6);
      expect(f.halfLen).toBeCloseTo(3000, 6);
      expect(f.halfThick).toBeCloseTo(100, 6);
    }
  });

  it('follows a mitred quad\'s own direction, not an axis', () => {
    const f = segmentFrame([
      { x: 0, y: 0 }, { x: 3000, y: 3000 }, { x: 2900, y: 3100 }, { x: -100, y: 100 },
    ])!;
    expect(Math.abs(f.dx)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(Math.abs(f.dy)).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('has nothing to measure in a degenerate quad', () => {
    expect(segmentFrame([])).toBeNull();
    expect(segmentFrame([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }])).toBeNull();
  });
});

describe('the wall opening, its window and the envelope cut share one centre', () => {
  // The library's Position is the opening's CENTRE; `collectOpenings` gives
  // its LEFT edge. Handing one to the other shifted every window half a
  // width along its wall — and the envelope, cut on the true centre, showed
  // it: two holes side by side, neither where the 3D viewer draws the window.
  const pointOf = (content: string, id: number) =>
    readEntity(content, id)!.args[0].replace(/[()]/g, '').split(',').map(Number);

  it('puts the window at distFromStart + width / 2 along its wall', () => {
    const { nodes, edges } = buildFixture();
    const { content } = buildIfcModel(nodes, edges, 'T');
    const nodeMap = new Map(nodes.map((x) => [x.id, x]));
    const w1 = nodeMap.get('w1')!;
    const [op] = collectOpenings(w1, 4000, edges, nodeMap);

    const line = content.split('\n').find((l) => l.includes('=IFCWINDOW('))!;
    const placementId = parseInt(/,#(\d+),#\d+,/.exec(line)![1], 10);
    const placement = readEntity(content, placementId)!;
    const axis2 = readEntity(content, refsIn(placement.args[1])[0])!;
    const [along] = pointOf(content, refsIn(axis2.args[0])[0]);

    // The wall-local number alone no longer says where the window is: a
    // mitred wall starts before its axis node, so its frame begins outside
    // the span openings are measured on. Walk out to the world point, which
    // is the thing the half-width bug actually moved.
    const wallAxis = readEntity(content, refsIn(readEntity(content, refsIn(placement.args[0])[0])!.args[1])[0])!;
    const origin = pointOf(content, refsIn(wallAxis.args[0])[0]);
    const dir = pointOf(content, refsIn(wallAxis.args[2])[0]);
    const world = { x: origin[0] + dir[0] * along, y: origin[1] + dir[1] * along };

    // w1 runs between c1 (5000, 0) and c2 (5000, 4000); which of the two the
    // export calls the start is incidental, so accept the centre measured
    // from either. A window half a width out lands near neither.
    const d = (op.distFromStart + op.width / 2) / 1000;
    const err = Math.min(
      Math.hypot(world.x - 5, world.y - d),
      Math.hypot(world.x - 5, world.y - (4 - d)),
    );
    expect(err).toBeCloseTo(0, 6);
  });

  it('and the envelope cut sits on that same centre', () => {
    const { nodes, edges } = buildFixture();
    const shell: BubbleGraphNode = {
      id: 'sh', type: 'shell', name: 'Shell', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { thickness: 150, height: 3000 },
    };
    const { content } = buildIfcModel(
      [...nodes, shell], [...edges, ...['c0', 'c1', 'c2', 'c3'].map((c) => wire('sh', c))], 'T',
    );
    const nodeMap = new Map(nodes.map((x) => [x.id, x]));
    const [op] = collectOpenings(nodeMap.get('w1')!, 4000, edges, nodeMap);
    // w1 runs c1 (5000, 0) → c2 (5000, 4000): the centre's y is the distance along it.
    const centreY = (op.distFromStart + op.width / 2) / 1000;

    const cuts = [...content.matchAll(/IFCRELVOIDSELEMENT\('[^']+',#\d+,\$,\$,#(\d+),#(\d+)\)/g)]
      .filter((m) => /'sh:ring:/.test(readEntity(content, parseInt(m[1], 10))!.args[7] ?? ''))
      .map((m) => {
        const opening = readEntity(content, parseInt(m[2], 10))!;
        const placement = readEntity(content, refsIn(opening.args[5])[0])!;
        const axis2 = readEntity(content, refsIn(placement.args[1])[0])!;
        return pointOf(content, refsIn(axis2.args[0])[0]);
      });
    // One of the two envelope cuts is the window's; its y is the window's centre.
    expect(cuts.some(([, y]) => Math.abs(y - centreY) < 1e-6)).toBe(true);
  });
});

// ── Georeferencing, which the .frag export depends on ───────────────────────
// The World view exports a georeferenced .frag by building an IFC WITH the
// reference and converting that — the fragments API has setCRS nowhere, only
// getCRS, so the CRS can only ride in from the source file. That makes this
// the link in the chain worth pinning: if the built IFC has no IfcProjectedCRS,
// the .frag silently comes out knowing only its own origin.
describe('buildIfcModel — georeference', () => {
  const georeference = {
    crs: 'EPSG:3844',
    lat: 44.4268, lng: 26.1025, elevation: 85,
    eastings: 425000, northings: 315000, orthogonalHeight: 85,
    xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
  };

  it('writes IfcProjectedCRS naming the system — what the converter reads', () => {
    const { content } = buildIfcModel(buildFixture().nodes, buildFixture().edges, 'Test', {
      georeference,
    });
    expect(content).toContain('IFCPROJECTEDCRS');
    expect(content).toContain("'EPSG:3844'");
  });

  it('writes IfcMapConversion carrying the grid coordinates', () => {
    const { content } = buildIfcModel(buildFixture().nodes, buildFixture().edges, 'Test', {
      georeference,
    });
    const line = content.split('\n').find((l) => l.includes('IFCMAPCONVERSION'));
    expect(line).toBeDefined();
    expect(line).toContain('425000');
    expect(line).toContain('315000');
  });

  it('fills the IfcSite slots too, for readers that know nothing newer', () => {
    const { content } = buildIfcModel(buildFixture().nodes, buildFixture().edges, 'Test', {
      georeference,
    });
    const site = content.split('\n').find((l) => l.includes('IFCSITE'));
    // Compound plane angle: degrees, minutes, seconds, millionths.
    expect(site).toMatch(/\(44,25,36,\d+\)/);
  });

  it('no georeference leaves the file saying nothing about where it is', () => {
    const { content } = buildIfcModel(buildFixture().nodes, buildFixture().edges, 'Test');
    expect(content).not.toContain('IFCPROJECTEDCRS');
    expect(content).not.toContain('IFCMAPCONVERSION');
  });

  it('IFC2X3 gets IfcSite only — IfcMapConversion does not exist in that schema', () => {
    const { content } = buildIfcModel(buildFixture().nodes, buildFixture().edges, 'Test', {
      georeference, schema: 'IFC2X3',
    });
    expect(content).not.toContain('IFCMAPCONVERSION');
    expect(content).toContain('IFCSITE');
  });
});

describe('mitred corners survive into the file', () => {
  // A plain closed room: four W25 walls around a 5000 x 4000 rectangle, every
  // corner an L. The export used to run each wall from axis centre to axis
  // centre, so neighbours overlapped in a 250 x 250 square at every corner and
  // the outside corner itself was covered by neither.
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const a = (id: string, x: number, y: number): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y, has_column: 'False' },
  });
  const w = (id: string): BubbleGraphNode => ({
    id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
    properties: { wall_type: 'W25' },
  });

  function room() {
    let k = 0;
    const e = (from: string, to: string): BubbleGraphEdge => ({ id: `r${k++}`, from, to });
    return {
      nodes: [storey, a('c0', 0, 0), a('c1', 5000, 0), a('c2', 5000, 4000), a('c3', 0, 4000),
        w('south'), w('east'), w('north'), w('west')],
      edges: [e('south', 'c0'), e('south', 'c1'), e('east', 'c1'), e('east', 'c2'),
        e('north', 'c2'), e('north', 'c3'), e('west', 'c3'), e('west', 'c0')],
    };
  }

  /** A wall's rectangle profile and the placement it is swept from. */
  function wallSolid(content: string, name: string) {
    const line = content.split('\n').find((l) => l.includes(`=IFCWALL(`) && l.includes(`'${name}'`))!;
    const wallId = parseInt(/^#(\d+)=/.exec(line.trim())![1], 10);
    const wall = readEntity(content, wallId)!;
    const shape = readEntity(content, refsIn(wall.args[6])[0])!;
    const rep = readEntity(content, refsIn(shape.args[2])[0])!;
    const axis2 = readEntity(content, refsIn(readEntity(content, refsIn(wall.args[5])[0])!.args[1])[0])!;
    return { wallId, rep, axis2 };
  }

  it('cuts every wall at both ends and says so in the representation type', () => {
    const { nodes, edges } = room();
    const { content } = buildIfcModel(nodes, edges, 'T');
    // Four walls, two mitres each.
    expect((content.match(/=IFCBOOLEANCLIPPINGRESULT\(/g) ?? []).length).toBe(8);
    expect((content.match(/=IFCHALFSPACESOLID\(/g) ?? []).length).toBe(8);
    for (const name of ['south', 'east', 'north', 'west']) {
      expect(wallSolid(content, name).rep.args[2]).toBe("'CSG'");
    }
  });

  it('grows the wall past its axis node so the outside corner is filled', () => {
    const { nodes, edges } = room();
    const { content } = buildIfcModel(nodes, edges, 'T');
    const { rep, axis2 } = wallSolid(content, 'south');
    // A clip only removes, so an unextended wall would leave the outside
    // corner empty — the notch that is there today.
    const origin = readEntity(content, refsIn(axis2.args[0])[0])!.args[0];
    expect(origin).toBe('(-0.125,0.,0.)');
    // 5000 + 125 at each end, and still 250 thick. Both ends are mitred, so
    // the booleans are nested: unwrap until the swept solid underneath.
    let base = readEntity(content, refsIn(rep.args[3])[0])!;
    while (base.type === 'IFCBOOLEANCLIPPINGRESULT') {
      base = readEntity(content, refsIn(base.args[1])[0])!;
    }
    expect(base.type).toBe('IFCEXTRUDEDAREASOLID');
    const profile = readEntity(content, refsIn(base.args[0])[0])!;
    expect(Number(profile.args[3])).toBeCloseTo(5.25, 6);
    expect(Number(profile.args[4])).toBeCloseTo(0.25, 6);
  });

  it('leaves a lone wall uncut', () => {
    let k = 0;
    const e = (from: string, to: string): BubbleGraphEdge => ({ id: `s${k++}`, from, to });
    const nodes = [storey, a('a', 0, 0), a('b', 4000, 0), w('lone')];
    const { content } = buildIfcModel(nodes, [e('lone', 'a'), e('lone', 'b')], 'T');
    expect(content).not.toContain('IFCBOOLEANCLIPPINGRESULT');
    expect(wallSolid(content, 'lone').rep.args[2]).toBe("'SweptSolid'");
  });
});

describe('butt joins reach the file too', () => {
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const a = (id: string, x: number, y: number): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y, has_column: 'False' },
  });
  const w = (id: string, t = 'W25'): BubbleGraphNode => ({
    id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
    properties: { wall_type: t },
  });
  let k = 0;
  const e = (from: string, to: string): BubbleGraphEdge => ({ id: `b${k++}`, from, to });

  function tee() {
    return {
      nodes: [storey, a('p0', 0, 0), a('m', 4000, 0), a('p1', 8000, 0), a('p', 4000, -3000),
        w('chordW'), w('chordE'), w('stem', 'W10')],
      edges: [e('chordW', 'p0'), e('chordW', 'm'), e('chordE', 'm'),
        e('chordE', 'p1'), e('stem', 'm'), e('stem', 'p')],
    };
  }

  /** A wall's swept length and where its local frame starts. */
  function wallSpan(content: string, name: string) {
    const line = content.split('\n').find((l) => l.includes('=IFCWALL(') && l.includes(`'${name}'`))!;
    const wall = readEntity(content, parseInt(/^#(\d+)=/.exec(line.trim())![1], 10))!;
    const shape = readEntity(content, refsIn(wall.args[6])[0])!;
    const rep = readEntity(content, refsIn(shape.args[2])[0])!;
    let solid = readEntity(content, refsIn(rep.args[3])[0])!;
    while (solid.type === 'IFCBOOLEANCLIPPINGRESULT') solid = readEntity(content, refsIn(solid.args[1])[0])!;
    const profile = readEntity(content, refsIn(solid.args[0])[0])!;
    const axis2 = readEntity(content, refsIn(readEntity(content, refsIn(wall.args[5])[0])!.args[1])[0])!;
    return {
      length: Number(profile.args[3]),
      origin: readEntity(content, refsIn(axis2.args[0])[0])!.args[0],
      clipped: rep.args[2] === "'CSG'",
    };
  }

  it('stops the stem at the chord\'s face instead of burying it', () => {
    const { nodes, edges } = tee();
    const { content } = buildIfcModel(nodes, edges, 'T');
    const stem = wallSpan(content, 'stem');
    // 3000 long between the nodes, less the 125 the chord's half-thickness
    // takes off the top — it used to run the full 3000 and overlap the chord.
    expect(stem.length).toBeCloseTo(2.875, 6);
    // A butt is a plain shortened box: no clipping needed, none written.
    expect(stem.clipped).toBe(false);
  });

  it('leaves the wall that runs through at its full length', () => {
    const { nodes, edges } = tee();
    const { content } = buildIfcModel(nodes, edges, 'T');
    expect(wallSpan(content, 'chordW').length).toBeCloseTo(4, 6);
    expect(wallSpan(content, 'chordE').length).toBeCloseTo(4, 6);
  });

  it('moves the stem\'s openings with its frame, not through it', () => {
    const { nodes, edges } = tee();
    const stem = nodes.find((x) => x.id === 'stem')!;
    stem.properties = {
      ...stem.properties, has_windows: 'True',
      windows: JSON.stringify([{ window_type: 'W-FIX-100x120' }]),
    };
    const { content } = buildIfcModel(nodes, edges, 'T');
    const line = content.split('\n').find((l) => l.includes('=IFCWINDOW('))!;
    const placement = readEntity(content, parseInt(/,#(\d+),#\d+,/.exec(line)![1], 10))!;
    const [along] = readEntity(content, refsIn(readEntity(content, refsIn(placement.args[1])[0])!.args[0])[0])!
      .args[0].replace(/[()]/g, '').split(',').map(Number);
    // Whatever the opening's distance along the wall, it has to land INSIDE
    // the shortened solid — a frame that moved without its openings would
    // push them out of the end.
    expect(along).toBeGreaterThan(0);
    expect(along).toBeLessThan(wallSpan(content, 'stem').length);
  });
});

describe('a plain end stops at the node, not in it — and OpenGeometry agrees', () => {
  // One W25 wall spanning two ax nodes that both carry a C30x30 column, so
  // both ends resolve to `square_off` with a 150 mm inset. OpenGeometry and
  // the 3D viewer have always drawn it that way, through
  // `calcWallGeometry(...).footprint`; the IFC export ran to the node centres
  // and buried 150 mm of wall inside each column.
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const col = (id: string, x: number, y: number): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y, has_column: 'True', column_type: 'C30x30' },
  });
  function scene() {
    const nodes: BubbleGraphNode[] = [
      storey, col('k0', 0, 0), col('k1', 5000, 0),
      { id: 'solo', type: 'wall', name: 'solo', x: 0, y: 0, z: 0, parentId: 'st',
        properties: { wall_type: 'W25' } },
    ];
    const edges: BubbleGraphEdge[] = [
      { id: 'q0', from: 'solo', to: 'k0' }, { id: 'q1', from: 'solo', to: 'k1' },
    ];
    return { nodes, edges };
  }

  /** The span the OpenGeometry mapper extrudes, from the shared footprint. */
  function ogSpan(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]) {
    const nodeMap = new Map(nodes.map((x) => [x.id, x]));
    const wn = nodes.find((x) => x.type === 'wall')!;
    const fp = calcWallGeometry(wn, nodeMap, edges, calcWallJoins(nodes, edges))!.footprint;
    const xs = fp.map((p) => p.x);
    return { min: Math.min(...xs), max: Math.max(...xs) };
  }

  it('insets a square_off end by the column\'s half-size', () => {
    const { nodes, edges } = scene();
    const og = ogSpan(nodes, edges);
    // C30x30 → 150 mm in from each node centre.
    expect(og.min).toBeCloseTo(150, 6);
    expect(og.max).toBeCloseTo(4850, 6);
  });

  it('gives the IFC wall exactly the span OpenGeometry extrudes', () => {
    const { nodes, edges } = scene();
    const { content } = buildIfcModel(nodes, edges, 'T');
    const line = content.split('\n').find((l) => l.includes('=IFCWALL('))!;
    const wallEnt = readEntity(content, parseInt(/^#(\d+)=/.exec(line.trim())![1], 10))!;
    const rep = readEntity(content, refsIn(readEntity(content, refsIn(wallEnt.args[6])[0])!.args[2])[0])!;
    let solid = readEntity(content, refsIn(rep.args[3])[0])!;
    while (solid.type === 'IFCBOOLEANCLIPPINGRESULT') solid = readEntity(content, refsIn(solid.args[1])[0])!;
    const profile = readEntity(content, refsIn(solid.args[0])[0])!;
    const axis2 = readEntity(content, refsIn(readEntity(content, refsIn(wallEnt.args[5])[0])!.args[1])[0])!;
    const origin = readEntity(content, refsIn(axis2.args[0])[0])!
      .args[0].replace(/[()]/g, '').split(',').map(Number);

    const og = ogSpan(nodes, edges);
    // The one number that must match: where the solid starts and how long it
    // is. Two representations of the same wall are free to differ in anything
    // else, but not in where the wall is.
    expect(origin[0] * 1000).toBeCloseTo(og.min, 3);
    expect(Number(profile.args[3]) * 1000).toBeCloseTo(og.max - og.min, 3);
  });
});

describe('the last two gaps: grips and curved walls', () => {
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const node = (id: string, x: number, y: number, col = false): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y, has_column: col ? 'True' : 'False', column_type: 'C40x40' },
  });
  const span = (nodes: BubbleGraphNode[], edges: BubbleGraphEdge[], id: string) => {
    const map = new Map(nodes.map((x) => [x.id, x]));
    const fp = calcWallGeometry(map.get(id)!, map, edges, calcWallJoins(nodes, edges))!.footprint;
    const xs = fp.map((p) => p.x), ys = fp.map((p) => p.y);
    return { x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)], pts: fp.length };
  };

  it('starts a wall at the column FACE its edge is wired to', () => {
    // Grip 3 is a corner of the C40x40 — GRIP_OX/GRIP_OY put it at
    // (+200, -200). Reading the node instead put this wall's start back at
    // the column's centre.
    const nodes = [storey, node('k0', 0, 0, true), node('k1', 6000, 0, true),
      { id: 'g', type: 'wall', name: 'g', x: 0, y: 0, z: 0, parentId: 'st',
        properties: { wall_type: 'W25' } } as BubbleGraphNode];
    const edges = [
      { id: 'g0', from: 'g', to: 'k0', toGrip: 3 } as BubbleGraphEdge,
      { id: 'g1', from: 'g', to: 'k1' } as BubbleGraphEdge,
    ];
    const { content } = buildIfcModel(nodes, edges, 'T');
    const line = content.split('\n').find((l) => l.includes('=IFCWALL('))!;
    const wallEnt = readEntity(content, parseInt(/^#(\d+)=/.exec(line.trim())![1], 10))!;
    const axis2 = readEntity(content, refsIn(readEntity(content, refsIn(wallEnt.args[5])[0])!.args[1])[0])!;
    const origin = readEntity(content, refsIn(axis2.args[0])[0])!
      .args[0].replace(/[()]/g, '').split(',').map(Number);
    // The grip corner, not (0, 0).
    expect(origin[0] * 1000).toBeCloseTo(200, 3);
    expect(origin[1] * 1000).toBeCloseTo(-200, 3);
  });

  it('writes a curved wall as its arc, not as the chord across it', () => {
    const nodes = [storey, node('a', 0, 0), node('b', 4000, 0),
      { id: 'arc', type: 'wall', name: 'arc', x: 0, y: 0, z: 0, parentId: 'st',
        properties: { wall_type: 'W25', is_circular: 'True', arc_radius: 3000 } } as BubbleGraphNode];
    const edges = [{ id: 'c0', from: 'arc', to: 'a' } as BubbleGraphEdge,
      { id: 'c1', from: 'arc', to: 'b' } as BubbleGraphEdge];
    const { content } = buildIfcModel(nodes, edges, 'T');

    // An arbitrary profile with the arc's own points, not a 4 m x 250 rectangle.
    expect(content).toContain('IFCARBITRARYCLOSEDPROFILEDEF');
    const poly = readEntity(content, refsIn(
      readEntity(content, findEntityIdByType(content, 'IFCARBITRARYCLOSEDPROFILEDEF'))!.args[2])[0])!;
    const ids = refsIn(poly.args[0]);
    const og = span(nodes, edges, 'arc');
    // An IfcPolyline closes by repeating its first point.
    expect(ids.length).toBe(og.pts + 1);
    expect(ids[0]).toBe(ids[ids.length - 1]);

    const pts = ids.map((id) => readEntity(content, id)!.args[0]
      .replace(/[()]/g, '').split(',').map(Number));
    const xs = pts.map((p) => p[0] * 1000), ys = pts.map((p) => p[1] * 1000);
    // The bulge is the point: a chord would have no y spread to speak of.
    expect(Math.min(...xs)).toBeCloseTo(og.x[0], 3);
    expect(Math.max(...xs)).toBeCloseTo(og.x[1], 3);
    expect(Math.min(...ys)).toBeCloseTo(og.y[0], 3);
    expect(Math.abs(og.y[0])).toBeGreaterThan(500);
  });

  it('still cuts a curved wall\'s openings, as real holes', () => {
    const nodes = [storey, node('a', 0, 0), node('b', 4000, 0),
      { id: 'arc', type: 'wall', name: 'arc', x: 0, y: 0, z: 0, parentId: 'st',
        properties: {
          wall_type: 'W25', is_circular: 'True', arc_radius: 3000,
          has_windows: 'True', windows: JSON.stringify([{ window_type: 'W-FIX-100x120' }]),
        } } as BubbleGraphNode];
    const edges = [{ id: 'd0', from: 'arc', to: 'a' } as BubbleGraphEdge,
      { id: 'd1', from: 'arc', to: 'b' } as BubbleGraphEdge];
    const { content } = buildIfcModel(nodes, edges, 'T');
    // The hole is there and belongs to the wall. What is NOT there is the
    // window product: only a parametric wall can host one, and an arc is not.
    expect(content).toContain('IFCOPENINGELEMENT');
    const rel = content.split('\n').find((l) => l.includes('=IFCRELVOIDSELEMENT('))!;
    expect(rel).toBeTruthy();
  });
});

/** First entity of a type, by id — small helper for the arc assertions. */
function findEntityIdByType(text: string, type: string): number {
  const m = new RegExp(`^#(\\d+)=${type}\\(`, 'm').exec(text);
  return m ? parseInt(m[1], 10) : -1;
}
