/**
 * Unit tests for quantity takeoff engine.
 * Run: pnpm test:takeoff
 */

import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { computeTakeoff, aggregateF3 } from './takeoffEngine';
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
