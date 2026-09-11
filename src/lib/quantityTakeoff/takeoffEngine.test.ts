/**
 * Unit tests for quantity takeoff engine.
 * Run: pnpm test:takeoff
 */

import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { computeTakeoff, aggregateF3 } from './takeoffEngine';
import { measureNode } from './geometryMeasures';
import { buildF3Csv } from './f3Export';
import { getActiveCatalog } from '@/lib/norms';

function makeStorey(id: string, name: string): BubbleGraphNode {
  return {
    id,
    type: 'storey',
    name,
    x: 0,
    y: 0,
    z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
}

function makeAx(id: string, x: number, y: number, parentId: string): BubbleGraphNode {
  return {
    id,
    type: 'ax',
    name: id,
    x,
    y,
    z: 0,
    parentId,
    properties: { gridX: 0, gridY: 0, has_column: 'False' },
  };
}

function edge(from: string, to: string): BubbleGraphEdge {
  return { id: `${from}-${to}`, from, to };
}

describe('active catalog', () => {
  it('uses zidarie confinata catalog by default', () => {
    const cat = getActiveCatalog();
    expect(cat.id).toBe('zidarie-confinata');
    expect(cat.articles.length).toBeGreaterThan(20);
    expect(cat.categories).toContain('Zidarie');
    expect(cat.categories).toContain('Stalpisori');
    expect(cat.categories).toContain('Centuri');
  });
});

describe('computeTakeoff — zidărie confinată', () => {
  it('computes Porotherm wall volume (mc)', () => {
    const storey = makeStorey('s1', 'Parter');
    const ax1 = makeAx('ax1', 0, 0, 's1');
    const ax2 = makeAx('ax2', 6000, 0, 's1');
    const wall: BubbleGraphNode = {
      id: 'w1',
      type: 'wall',
      name: 'Perete 1',
      x: 3000,
      y: 0,
      z: 0,
      parentId: 's1',
      properties: { wall_type: 'W20', height: 3000 },
    };
    const nodes = [storey, ax1, ax2, wall];
    const edges = [edge('w1', 'ax1'), edge('w1', 'ax2')];

    const lines = computeTakeoff(nodes, edges);
    const zidarie = lines.find((l) => l.normId === '0001_00201A01_02' && l.nodeId === 'w1');
    expect(zidarie).toBeDefined();
    // 6m × 3m × 0.2m = 3.6 mc
    expect(zidarie!.quantity).toBe(3.6);
    expect(zidarie!.unit).toBe('mc');
  });

  it('computes stalpisori beton + cofraj + armătură', () => {
    const storey = makeStorey('s1', 'Parter');
    const col: BubbleGraphNode = {
      id: 'c1',
      type: 'column',
      name: 'Stalpisor 1',
      x: 0,
      y: 0,
      z: 0,
      parentId: 's1',
      properties: { column_type: 'C25x25' },
    };
    const lines = computeTakeoff([storey, col], []);
    expect(lines.find((l) => l.normId === '0002_CA01D_02')).toBeDefined();
    expect(lines.find((l) => l.normId === '0002_CB01C_02')).toBeDefined();
    expect(lines.find((l) => l.normId === '0002_CC01A4_02')).toBeDefined();
  });

  it('maps beams to centuri category articles', () => {
    const storey = makeStorey('s1', 'Parter');
    const col1: BubbleGraphNode = {
      id: 'c1', type: 'column', name: 'C1', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { column_type: 'C25x25' },
    };
    const col2: BubbleGraphNode = {
      id: 'c2', type: 'column', name: 'C2', x: 4000, y: 0, z: 0, parentId: 's1',
      properties: { column_type: 'C25x25' },
    };
    const beam: BubbleGraphNode = {
      id: 'b1',
      type: 'beam',
      name: 'Centura',
      x: 2000,
      y: 0,
      z: 0,
      parentId: 's1',
      properties: { beam_section: 'B20x30' },
    };
    const lines = computeTakeoff(
      [storey, col1, col2, beam],
      [edge('b1', 'c1'), edge('b1', 'c2')],
    );
    expect(lines.find((l) => l.normId === '0003_CA01D_02')).toBeDefined();
  });

  it('maps windows to glafuri (ml)', () => {
    const storey = makeStorey('s1', 'Parter');
    const win: BubbleGraphNode = {
      id: 'win1',
      type: 'window',
      name: 'Fereastră 1',
      x: 0,
      y: 0,
      z: 0,
      parentId: 's1',
      properties: { window_type: 'W-FIX-100x120' },
    };
    const lines = computeTakeoff([storey, win], []);
    const glaf = lines.find((l) => l.normId === '0015_CK26A_02');
    expect(glaf).toBeDefined();
    expect(glaf!.unit).toBe('ml');
  });

  it('aggregates F3 rows by norm + storey', () => {
    const storey = makeStorey('s1', 'Parter');
    const ax1 = makeAx('ax1', 0, 0, 's1');
    const ax2 = makeAx('ax2', 3000, 0, 's1');
    const ax3 = makeAx('ax3', 6000, 0, 's1');
    const w1: BubbleGraphNode = {
      id: 'w1', type: 'wall', name: 'W1', x: 1500, y: 0, z: 0, parentId: 's1',
      properties: { wall_type: 'W20', height: 3000 },
    };
    const w2: BubbleGraphNode = {
      id: 'w2', type: 'wall', name: 'W2', x: 4500, y: 0, z: 0, parentId: 's1',
      properties: { wall_type: 'W20', height: 3000 },
    };
    const nodes = [storey, ax1, ax2, ax3, w1, w2];
    const edges = [
      edge('w1', 'ax1'), edge('w1', 'ax2'),
      edge('w2', 'ax2'), edge('w2', 'ax3'),
    ];

    const lines = computeTakeoff(nodes, edges);
    const f3 = aggregateF3(lines);
    const zidarie = f3.find((r) => r.normId === '0001_00201A01_02');
    expect(zidarie).toBeDefined();
    expect(zidarie!.categorie).toBe('Zidarie');
    expect(zidarie!.nodeIds).toHaveLength(2);
  });
});

describe('example-project.bbim validation', () => {
  it('produces F3 rows from the bundled example project', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const bbimPath = path.resolve(process.cwd(), 'public/example-project.bbim');
    const raw = fs.readFileSync(bbimPath, 'utf-8');
    const data = JSON.parse(raw) as {
      model: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] };
    };
    const { f3, lines } = (await import('./takeoffEngine')).computeFullTakeoff(
      data.model.nodes,
      data.model.edges,
    );
    expect(f3.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    const hasZidarie = f3.some((r) => r.categorie === 'Zidarie');
    expect(hasZidarie).toBe(true);
  });
});

describe('buildF3Csv', () => {
  it("produces valid CSV with headers", () => {
    const storey = makeStorey('s1', 'Parter');
    const win: BubbleGraphNode = {
      id: 'win1', type: 'window', name: 'F1', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { window_type: 'W-FIX-100x120' },
    };
    const lines = computeTakeoff([storey, win], []);
    const f3 = aggregateF3(lines);
    const csv = buildF3Csv(f3, {
      projectName: 'Test',
      exportedAt: '2026-06-05',
      catalogVersion: getActiveCatalog().version,
    });
    // Anteturile CSV au fost traduse deliberat în engleză (f3Export.ts).
    expect(csv).toContain('Bill of quantities (F3)');
    expect(csv).toContain('No.');
    expect(csv).toContain('Symbol');
    expect(csv).toContain('deviz-zidarie-confinata-1');
  });
});

describe('sweep → takeoff lines', () => {
  const SWEEP_DEFAULTS = {
    profile: 'rect', p_w_mm: 300, p_h_mm: 600,
    anchor_x: 'mid', anchor_y: 'max', level: 'top',
    offset_z_mm: 0, offset_x_mm: 0, rotation_deg: 0,
    mirror: 'False', corners: 'miter', closed: 'False', height_mm: 0,
  };

  function sweepScene(props: Record<string, unknown> = {}) {
    const st = makeStorey('st', 'Parter');
    const a = { ...makeAx('a', 0, 0, 'st'), properties: { bimX: 0, bimY: 0 } };
    const b = { ...makeAx('b', 4000, 0, 'st'), properties: { bimX: 4000, bimY: 0 } };
    const sweep: BubbleGraphNode = {
      id: 'sw', type: 'sweep', name: 'Brau', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { ...SWEEP_DEFAULTS, ...props },
    };
    return {
      nodes: [st, a, b, sweep] as BubbleGraphNode[],
      edges: [edge('sw', 'a'), edge('sw', 'b')],
    };
  }

  it('produces concrete, formwork and rebar lines with the mesh volume', () => {
    const { nodes, edges } = sweepScene();
    const lines = computeTakeoff(nodes, edges).filter((l) => l.nodeId === 'sw');
    expect(lines.length).toBe(3);

    const vol = lines.find((l) => l.normId === '0018_CA01D_02');
    // 0.3 × 0.6 × 4.0 m = 0.72 m³
    expect(vol!.quantity).toBeCloseTo(0.72, 2);

    const formwork = lines.find((l) => l.normId === '0018_CB01C_02');
    // lateral surface = perimeter 1.8 m × 4.0 m
    expect(formwork!.quantity).toBeCloseTo(7.2, 2);

    const rebar = lines.find((l) => l.normId === '0018_CC01A4_02');
    expect(rebar!.quantity).toBeCloseTo(0.72 * 61.5, 1);
  });

  it('an unwired sweep yields no lines rather than a zero row', () => {
    const st = makeStorey('st', 'Parter');
    const sweep: BubbleGraphNode = {
      id: 'sw', type: 'sweep', name: 'Orfan', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { ...SWEEP_DEFAULTS },
    };
    expect(computeTakeoff([st, sweep], []).filter((l) => l.nodeId === 'sw')).toHaveLength(0);
  });

  it('reaches the F3 schedule under its own category', () => {
    const { nodes, edges } = sweepScene();
    const rows = aggregateF3(computeTakeoff(nodes, edges));
    const row = rows.find((r) => r.nodeIds.includes('sw'));
    expect(row).toBeDefined();
    expect(row!.categorie).toBe('Profile liniare');
  });
});

describe('computeTakeoff — structural system decides the technology', () => {
  // A 6 × 4 m box: four exterior walls with a ring beam each, columns at the corners.
  const storey = makeStorey('s1', 'Parter');
  const ax = (id: string, x: number, y: number, col = false) =>
    ({ ...makeAx(id, x, y, 's1'), properties: { bimX: x, bimY: y, has_column: col ? 'True' : 'False', column_type: 'C25x25' } });
  const A = ax('A', 0, 0, true), B = ax('B', 6000, 0, true), C = ax('C', 6000, 4000, true), D = ax('D', 0, 4000, true);
  const wall = (id: string, props: Record<string, unknown> = {}): BubbleGraphNode =>
    ({ id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 's1', properties: { wall_type: 'W25', ...props } });
  const walls = [wall('s', { has_beam: 'True', beam_section: 'B20x30' }), wall('e'), wall('n'), wall('w')];
  const nodes = [storey, A, B, C, D, ...walls];
  const edges = [edge('s', 'A'), edge('s', 'B'), edge('e', 'B'), edge('e', 'C'), edge('n', 'C'), edge('n', 'D'), edge('w', 'D'), edge('w', 'A')];

  it('a wall with has_beam yields the ring beam\'s work items, pointing at the wall', () => {
    const lines = computeTakeoff(nodes, edges);
    const beam = lines.filter((l) => l.nodeType === 'beam');
    expect(beam.length).toBeGreaterThan(0);
    expect(beam.every((l) => l.nodeId === 's')).toBe(true);
    expect(beam.some((l) => l.normId === '0003_CA01D_02')).toBe(true);    // centuri concrete
    expect(beam.find((l) => l.normId === '0003_CA01D_02')!.quantity).toBeCloseTo(6 * 0.2 * 0.3, 2);
  });

  it('under rc_frame the walls are infill with lintels, the columns and beams frame articles', () => {
    const lines = computeTakeoff(nodes, edges, { structuralSystem: 'rc_frame' });
    const ids = new Set(lines.map((l) => l.normId));
    expect(ids.has('0020_CD01A_02')).toBe(true);     // infill masonry
    expect(ids.has('0001_00201A01_02')).toBe(false);  // not structural masonry
    expect(ids.has('0020_CA02C_02')).toBe(true);     // pumped concrete, columns + beam
    expect(ids.has('0002_CA01D_02')).toBe(false);    // not the confined-masonry sâmburi article
    expect(ids.has('0003_CA01D_02')).toBe(false);    // nor the centuri one
  });

  it('under timber_frame every wall is exterior here, so OSB and wool cover each; gypsum one face', () => {
    const lines = computeTakeoff(nodes, edges, { structuralSystem: 'timber_frame' });
    const q = (id: string) => lines.filter((l) => l.normId === id).reduce((s, l) => s + l.quantity, 0);
    expect(q('0019_LF02_OSB')).toBeGreaterThan(0);
    expect(q('0019_LF04_GK')).toBeCloseTo(q('0019_LF02_OSB'), 1);
    expect(q('0019_LF08_HDR')).toBe(0);              // no openings, no headers
    expect(q('0019_LF10_FIX')).toBeGreaterThan(0);
  });

  it('an interior partition gets gypsum on both faces and no sheathing', () => {
    const M = ax('M', 3000, 0), N = ax('N', 3000, 4000);
    const withMid = [...nodes, M, N, wall('mid', { wall_type: 'TF14' })];
    const e2 = [...edges, edge('mid', 'M'), edge('mid', 'N')];
    const lines = computeTakeoff(withMid, e2, { structuralSystem: 'timber_frame' }).filter((l) => l.nodeId === 'mid');
    const q = (id: string) => lines.filter((l) => l.normId === id).reduce((s, l) => s + l.quantity, 0);
    expect(q('0019_LF02_OSB')).toBe(0);
    expect(q('0019_LF04_GK')).toBeCloseTo(2 * 4 * 3, 1);
  });

  it('under clt the walls are panels: bought by volume, cut by the metre, lifted by the m²', () => {
    const lines = computeTakeoff(nodes, edges, { structuralSystem: 'clt' });
    const ids = new Set(lines.map((l) => l.normId));
    for (const id of ['0021_CLT01_PN', '0021_CLT02_CNC', '0021_CLT03_MNT', '0021_CLT04_CON', '0021_CLT05_JNT', '0021_CLT06_GK']) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.has('0001_00201A01_02')).toBe(false);
  });
});

describe('computeTakeoff — specifications swap materials and finishes', () => {
  const storey = makeStorey('s1', 'Parter');
  const ax = (id: string, x: number, y: number) =>
    ({ ...makeAx(id, x, y, 's1'), properties: { bimX: x, bimY: y, has_column: 'False' } });
  const A = ax('A', 0, 0), B = ax('B', 6000, 0), C = ax('C', 6000, 4000), D = ax('D', 0, 4000);
  const wall = (id: string): BubbleGraphNode =>
    ({ id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 's1', properties: { wall_type: 'W25' } });
  const room: BubbleGraphNode =
    { id: 'r', type: 'room', name: 'r', x: 0, y: 0, z: 0, parentId: 's1', properties: { height: 2800 } };
  // The façade is measured on the ENVELOPE, not on the rooms — so a fixture
  // that wants exterior render or insulation has to declare a shell.
  const shell: BubbleGraphNode =
    { id: 'sh', type: 'shell', name: 'Shell', x: 0, y: 0, z: 0, parentId: 's1', properties: { height: 2800, thickness: 250 } };
  const nodes = [storey, A, B, C, D, wall('s'), wall('e'), wall('n'), wall('w'), room, shell];
  const edges = [
    edge('s', 'A'), edge('s', 'B'), edge('e', 'B'), edge('e', 'C'),
    edge('n', 'C'), edge('n', 'D'), edge('w', 'D'), edge('w', 'A'),
    edge('r', 'A'), edge('r', 'B'), edge('r', 'C'), edge('r', 'D'),
    edge('sh', 'A'), edge('sh', 'B'), edge('sh', 'C'), edge('sh', 'D'),
  ];
  const ids = (specs?: Record<string, string>) =>
    new Set(computeTakeoff(nodes, edges, specs ? { specs } : undefined).map((l) => l.normId));

  it('with nothing chosen the deviz is exactly what it was before specifications existed', () => {
    const base = ids();
    expect(base.has('0001_00201A01_02')).toBe(true);    // Porotherm
    expect(base.has('0011_CF24A_02')).toBe(true);       // tencuială ipsos
    expect(base.has('0001_BCA25_02')).toBe(false);
  });

  it('another brick replaces the default masonry article, not the plaster', () => {
    const s = ids({ zidarie: 'bca25' });
    expect(s.has('0001_BCA25_02')).toBe(true);
    expect(s.has('0001_00201A01_02')).toBe(false);
    expect(s.has('0011_CF24A_02')).toBe(true);
  });

  it('each finish group is independent of the others', () => {
    const s = ids({ tencuiala_int: 'var_ciment', termoizolatie: 'vata15' });
    expect(s.has('0011_CF10VC_02')).toBe(true);
    expect(s.has('0011_CF24A_02')).toBe(false);
    expect(s.has('0012_VATA15_02')).toBe(true);
    expect(s.has('0012_00107A011_02')).toBe(false);
    expect(s.has('0011_CF06B1_82')).toBe(true);          // tencuiala exterioară neatinsă
  });

  it('an option may KEEP one of the default articles it replaces', () => {
    // Vopsitoria premium schimbă interiorul și păstrează exteriorul; suprimarea
    // implicitului nu are voie să șteargă munca pe care opțiunea o redeclară.
    const s = ids({ vopsitorie: 'premium' });
    expect(s.has('0013_CN20PR_02')).toBe(true);
    expect(s.has('0013_CN11A_02')).toBe(true);
    expect(s.has('0013_CN05A_02')).toBe(false);
  });

  it('an option with no rules removes the work entirely', () => {
    const s = ids({ tencuiala_ext: 'fara' });
    expect(s.has('0011_CF06B1_82')).toBe(false);
    expect(s.has('0011_CF24A_02')).toBe(true);
  });

  it('a per-element override beats the project choice', () => {
    const wet = nodes.map((n) => (n.id === 'r' ? { ...n, properties: { ...n.properties, spec_faianta: 'standard' } } : n));
    const s = new Set(computeTakeoff(wet, edges).map((l) => l.normId));
    expect(s.has('0024_FA01_STD')).toBe(true);
    expect(new Set(computeTakeoff(nodes, edges).map((l) => l.normId)).has('0024_FA01_STD')).toBe(false);
  });

  it('quantities follow the option: a thicker insulation is the same area, a different article', () => {
    const q = (specs: Record<string, string>, id: string) =>
      computeTakeoff(nodes, edges, { specs }).filter((l) => l.normId === id).reduce((a, l) => a + l.quantity, 0);
    expect(q({ termoizolatie: 'eps15' }, '0012_EPS15_02'))
      .toBeCloseTo(q({}, '0012_00107A011_02'), 2);
  });
});

describe('computeTakeoff — the shell is the envelope', () => {
  const storey = makeStorey('s1', 'Parter');
  const ax = (id: string, x: number, y: number) =>
    ({ ...makeAx(id, x, y, 's1'), properties: { bimX: x, bimY: y, has_column: 'False' } });
  const A = ax('A', 0, 0), B = ax('B', 10000, 0), C = ax('C', 10000, 6000), D = ax('D', 0, 6000);
  const P = ax('P', 2000, 2000), Q = ax('Q', 8000, 2000), R = ax('R', 8000, 4000), S = ax('S', 2000, 4000);
  const shell = (props: Record<string, unknown>): BubbleGraphNode =>
    ({ id: 'sh', type: 'shell', name: 'Shell', x: 0, y: 0, z: 0, parentId: 's1', properties: { height: 3000, thickness: 400, ...props } });
  const cell: BubbleGraphNode = { id: 'c1', type: 'cell', name: 'c1', x: 0, y: 0, z: 0, parentId: 's1', properties: {} };
  const base = [storey, A, B, C, D, P, Q, R, S, cell];
  const wire = [
    edge('sh', 'A'), edge('sh', 'B'), edge('sh', 'C'), edge('sh', 'D'),
    edge('c1', 'P'), edge('c1', 'Q'), edge('c1', 'R'), edge('c1', 'S'),
  ];
  const linesFor = (props: Record<string, unknown>) => computeTakeoff([...base, shell(props)], wire);

  it('an envelope shell carries the façade: insulation, render, exterior paint', () => {
    const lines = linesFor({ shell_role: 'envelope' });
    const q = (id: string) => lines.filter((l) => l.normId === id).reduce((a, l) => a + l.quantity, 0);
    // Contour 10 × 6 → perimeter 32 m, height 3 m → 96 m² of façade, once.
    expect(q('0012_00107A011_02')).toBeCloseTo(96, 1);
    expect(q('0011_CF06B1_82')).toBeCloseTo(96, 1);
    expect(q('0013_CN11A_02')).toBeCloseTo(96, 1);
    expect(lines.every((l) => l.nodeId === 'sh')).toBe(true);
  });

  it('a foundation shell prices the PLIN, not the façade', () => {
    const lines = linesFor({ shell_role: 'foundation' });
    const q = (id: string) => lines.filter((l) => l.normId === id).reduce((a, l) => a + l.quantity, 0);
    // 60 m² contour − 12 m² cell = 48 m² of plin; × 3 m = 144 m³ of concrete.
    expect(q('0031_RC04_EGA')).toBeCloseTo(48, 1);
    expect(q('0031_RC01_BET')).toBeCloseTo(144, 1);
    expect(q('0031_RC03_ARM')).toBeCloseTo(144 * 90, 0);
    // Formwork is both faces: contour 32 m + cell 16 m, × 3 m.
    expect(q('0031_RC02_COF')).toBeCloseTo((32 + 16) * 3, 1);
    // Backfill occupies the cells.
    expect(q('0031_RC06_UMP')).toBeCloseTo(12 * 3, 1);
    expect(q('0012_00107A011_02')).toBe(0);
  });

  it('a beam grid is the same geometry with a heavier cage and no blinding', () => {
    const lines = linesFor({ shell_role: 'beam_grid' });
    const q = (id: string) => lines.filter((l) => l.normId === id).reduce((a, l) => a + l.quantity, 0);
    expect(q('0031_RC01_BET')).toBeCloseTo(144, 1);
    expect(q('0031_RC03_ARM')).toBeCloseTo(144 * 110, 0);
    expect(q('0031_RC04_EGA')).toBe(0);
  });

  it('removing the cell makes the region solid again', () => {
    const lines = computeTakeoff([storey, A, B, C, D, shell({ shell_role: 'foundation' })],
      [edge('sh', 'A'), edge('sh', 'B'), edge('sh', 'C'), edge('sh', 'D')]);
    const q = (id: string) => lines.filter((l) => l.normId === id).reduce((a, l) => a + l.quantity, 0);
    expect(q('0031_RC04_EGA')).toBeCloseTo(60, 1);
    expect(q('0031_RC06_UMP')).toBe(0);
  });

  it('the façade follows the specification chosen for the envelope', () => {
    const lines = computeTakeoff([...base, shell({ shell_role: 'envelope' })], wire, { specs: { termoizolatie: 'vata15' } });
    const ids = new Set(lines.map((l) => l.normId));
    expect(ids.has('0012_VATA15_02')).toBe(true);
    expect(ids.has('0012_00107A011_02')).toBe(false);
  });
});

describe('computeTakeoff — bands over the height', () => {
  const storey = makeStorey('s1', 'Parter');
  const ax = (id: string, x: number, y: number) =>
    ({ ...makeAx(id, x, y, 's1'), properties: { bimX: x, bimY: y, has_column: 'False' } });
  const A = ax('A', 0, 0), B = ax('B', 5000, 0), C = ax('C', 5000, 4000), D = ax('D', 0, 4000);

  const room = (props: Record<string, unknown>): BubbleGraphNode =>
    ({ id: 'r1', type: 'room', name: 'Baie', x: 0, y: 0, z: 0, parentId: 's1', properties: { height: 2800, ...props } });
  const wire = [edge('r1', 'A'), edge('r1', 'B'), edge('r1', 'C'), edge('r1', 'D')];
  const q = (lines: ReturnType<typeof computeTakeoff>, id: string) =>
    lines.filter((l) => l.normId === id).reduce((a, l) => a + l.quantity, 0);

  // 5 × 4 room: 18 m of perimeter, 20 m² of floor, 2.8 m tall.
  const PERIM = 18;
  const TILES = '0024_FA01_STD';
  const PLASTER = '0011_CF24A_02';
  const SCREED = '0007_SP01_CIM';

  const bathroom = JSON.stringify([
    { from_mm: 0, to_mm: 1500, material: 'ceramic_tile', spec: 'faianta:standard, tencuiala_int:fara' },
    { from_mm: 1500, to_mm: 2800, material: 'plaster' },
  ]);

  it('tiles the lower band and plasters the upper one — the two add up to the wall', () => {
    const lines = computeTakeoff([storey, A, B, C, D, room({ covering_layers: bathroom })], wire);
    expect(q(lines, TILES)).toBeCloseTo(PERIM * 1.5, 2);
    expect(q(lines, PLASTER)).toBeCloseTo(PERIM * 1.3, 2);
    expect(q(lines, TILES) + q(lines, PLASTER)).toBeCloseTo(PERIM * 2.8, 2);
  });

  it('THE FLOOR IS NOT COUNTED TWICE — a measure that ignores height is emitted once', () => {
    const plain = computeTakeoff([storey, A, B, C, D, room({})], wire);
    const zoned = computeTakeoff([storey, A, B, C, D, room({ covering_layers: bathroom })], wire);
    expect(q(plain, SCREED)).toBeCloseTo(20, 2);
    expect(q(zoned, SCREED)).toBeCloseTo(q(plain, SCREED), 6);
  });

  it('an unbanded room is measured exactly as before — zoning is inert until configured', () => {
    const plain = computeTakeoff([storey, A, B, C, D, room({})], wire);
    const oneBand = computeTakeoff([storey, A, B, C, D,
      room({ covering_layers: JSON.stringify([{ from_mm: 0, to_mm: 2800 }]) })], wire);
    expect(oneBand.map((l) => `${l.normId}=${l.quantity}`).sort())
      .toEqual(plain.map((l) => `${l.normId}=${l.quantity}`).sort());
    expect(q(plain, PLASTER)).toBeCloseTo(PERIM * 2.8, 2);
  });

  it('without a band, a tiled room is tiled floor to ceiling — no hidden 2.1 m', () => {
    const lines = computeTakeoff([storey, A, B, C, D, room({ spec_faianta: 'standard' })], wire);
    expect(q(lines, TILES)).toBeCloseTo(PERIM * 2.8, 2);
  });

  it('the band shows in the line source, so the memo says where the number came from', () => {
    const lines = computeTakeoff([storey, A, B, C, D, room({ covering_layers: bathroom })], wire);
    expect(lines.find((l) => l.normId === TILES)!.source).toContain('0.00–1.50 m');
  });

  it('a masonry wall with a BCA socle splits its volume between the two blocks', () => {
    const wall: BubbleGraphNode = {
      id: 'w1', type: 'wall', name: 'Perete', x: 0, y: 0, z: 0, parentId: 's1',
      properties: {
        wall_type: 'W20', height: 3000,
        wall_layers: JSON.stringify([
          { from_mm: 0, to_mm: 300, spec: 'zidarie:bca25' },
          { from_mm: 300, to_mm: 3000 },
        ]),
      },
    };
    const lines = computeTakeoff([storey, A, B, wall], [edge('w1', 'A'), edge('w1', 'B')]);
    // 5 m long × 0.2 m thick: 0.3 m of BCA, 2.7 m of Porotherm.
    expect(q(lines, '0001_BCA25_02')).toBeCloseTo(5 * 0.3 * 0.2, 2);
    expect(q(lines, '0001_00201A01_02')).toBeCloseTo(5 * 2.7 * 0.2, 2);
    expect(q(lines, '0001_BCA25_02') + q(lines, '0001_00201A01_02')).toBeCloseTo(5 * 3 * 0.2, 2);
  });

  it('an opening only comes out of the bands it actually crosses', () => {
    const window_: BubbleGraphNode = {
      id: 'win1', type: 'window', name: 'Fereastra', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { window_type: 'W-1200x1400', width: 1200, height: 1400, sill_height: 900, wall_offset: 2000 },
    };
    const wall: BubbleGraphNode = {
      id: 'w1', type: 'wall', name: 'Perete', x: 0, y: 0, z: 0, parentId: 's1',
      properties: { wall_type: 'W20', height: 3000 },
    };
    const nodes = [storey, A, B, wall, window_];
    const wires = [edge('w1', 'A'), edge('w1', 'B'), edge('win1', 'w1')];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const whole = measureNode(wall, wires, nodeMap)!;
    // The window sits between 0.9 and 2.3 m. A 0–0.3 m socle band is entirely
    // below it and must lose nothing; a 0–1.5 m band loses 0.6 m of its height.
    const socle = measureNode(wall, wires, nodeMap, undefined, { fromM: 0, toM: 0.3 })!;
    const lower = measureNode(wall, wires, nodeMap, undefined, { fromM: 0, toM: 1.5 })!;
    const upper = measureNode(wall, wires, nodeMap, undefined, { fromM: 1.5, toM: 3 })!;

    expect(whole.opening_area_m2).toBeCloseTo(1.2 * 1.4, 3);
    expect(socle.opening_area_m2).toBe(0);
    expect(socle.net_area_m2).toBeCloseTo(5 * 0.3, 3);
    expect(lower.opening_area_m2).toBeCloseTo(1.2 * 0.6, 3);
    // Split anywhere, the two bands' net areas add back up to the whole wall's.
    expect(lower.net_area_m2 + upper.net_area_m2).toBeCloseTo(whole.net_area_m2, 3);
  });

  it('an envelope shell can carry a socle band with its own insulation', () => {
    const shell: BubbleGraphNode = {
      id: 'sh', type: 'shell', name: 'Anvelopa', x: 0, y: 0, z: 0, parentId: 's1',
      properties: {
        shell_role: 'envelope', height: 3000, thickness: 400,
        shell_zones: JSON.stringify([
          { from_mm: 0, to_mm: 500, spec: 'termoizolatie:vata15' },
          { from_mm: 500, to_mm: 3000 },
        ]),
      },
    };
    const lines = computeTakeoff([storey, A, B, C, D, shell],
      [edge('sh', 'A'), edge('sh', 'B'), edge('sh', 'C'), edge('sh', 'D')]);
    // Perimeter 18 m: 0.5 m of mineral wool, 2.5 m of the default EPS.
    expect(q(lines, '0012_VATA15_02')).toBeCloseTo(18 * 0.5, 1);
    expect(q(lines, '0012_00107A011_02')).toBeCloseTo(18 * 2.5, 1);
    // The render does not care about the band split: it is the whole façade.
    expect(q(lines, '0011_CF06B1_82')).toBeCloseTo(18 * 3, 1);
  });
});

describe('computeTakeoff — a wall with its own thickness', () => {
  const storey = makeStorey('s1', 'Parter');
  const A = makeAx('a', 0, 0, 's1');
  const B = makeAx('b', 5000, 0, 's1');
  const wall = (props: Record<string, unknown>): BubbleGraphNode =>
    ({ id: 'w1', type: 'wall', name: 'W', x: 0, y: 0, z: 0, parentId: 's1',
       properties: { wall_type: 'W25', height: 3000, ...props } });
  const wire = [edge('w1', 'a'), edge('w1', 'b')];
  const vol = (props: Record<string, unknown>) => computeTakeoff([storey, A, B, wall(props)], wire)
    .filter((l) => l.normId === '0001_00201A01_02')
    .reduce((a, l) => a + l.quantity, 0);

  it('without a custom value the type decides — 5 × 3 × 0.25', () => {
    expect(vol({})).toBeCloseTo(5 * 3 * 0.25, 2);
  });

  it('A 60 CM WALL IS PRICED AS 60 CM — the deviz agrees with the geometry', () => {
    expect(vol({ wall_custom_mm: 600 })).toBeCloseTo(5 * 3 * 0.6, 2);
  });

  it('a thicker wall costs strictly more', () => {
    expect(vol({ wall_custom_mm: 600 })).toBeGreaterThan(vol({}));
  });

  it('a zero custom value leaves the type alone', () => {
    expect(vol({ wall_custom_mm: 0 })).toBeCloseTo(vol({}), 6);
  });
});
