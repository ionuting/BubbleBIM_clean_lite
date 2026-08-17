/**
 * Testează invariantul cheie al modulului de raport: urma de calcul EXPLICĂ, nu
 * recalculează. Cantitățile din `computeTakeoffTraced` trebuie să fie identice,
 * linie cu linie, cu cele din `computeTakeoff` (deci cu F3).
 */
import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { computeTakeoff, computeTakeoffTraced } from './takeoffEngine';

function makeStorey(id: string, name: string): BubbleGraphNode {
  return { id, type: 'storey', name, x: 0, y: 0, z: 0, properties: { bottomElevation: 0, topElevation: 3000 } };
}
function makeAx(id: string, x: number, y: number, parentId: string): BubbleGraphNode {
  return { id, type: 'ax', name: id, x, y, z: 0, parentId, properties: { gridX: 0, gridY: 0, has_column: 'False' } };
}
const edge = (from: string, to: string): BubbleGraphEdge => ({ id: `${from}-${to}`, from, to });

/** Cheie stabilă pentru compararea liniilor. */
const key = (l: { normId: string; nodeId: string }) => `${l.normId}::${l.nodeId}`;

function expectTracedMatchesPlain(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]) {
  const plain = computeTakeoff(nodes, edges);
  const traced = computeTakeoffTraced(nodes, edges);

  expect(traced.length).toBe(plain.length);

  const tracedMap = new Map(traced.map((l) => [key(l), l]));
  for (const p of plain) {
    const t = tracedMap.get(key(p));
    expect(t, `linie lipsă în traced: ${key(p)}`).toBeDefined();
    expect(t!.quantity).toBe(p.quantity);
    expect(t!.unit).toBe(p.unit);
    // Rezultatul din trace rotunjit trebuie să dea aceeași cantitate.
    expect(Math.round(t!.trace.result * 100) / 100).toBe(p.quantity);
  }
}

describe('computeTakeoffTraced — invariant 1:1 cu F3', () => {
  it('perete zidărie (volum)', () => {
    const nodes = [
      makeStorey('s1', 'Parter'),
      makeAx('ax1', 0, 0, 's1'),
      makeAx('ax2', 6000, 0, 's1'),
      { id: 'w1', type: 'wall', name: 'Perete 1', x: 3000, y: 0, z: 0, parentId: 's1', properties: { wall_type: 'W20', height: 3000 } } as BubbleGraphNode,
    ];
    expectTracedMatchesPlain(nodes, [edge('w1', 'ax1'), edge('w1', 'ax2')]);
  });

  it('stâlpișor beton + cofraj + armătură (mai multe outputs/nod)', () => {
    const nodes = [
      makeStorey('s1', 'Parter'),
      { id: 'c1', type: 'column', name: 'Stalpisor 1', x: 0, y: 0, z: 0, parentId: 's1', properties: { column_type: 'C25x25' } } as BubbleGraphNode,
    ];
    expectTracedMatchesPlain(nodes, []);
  });

  it('proiectul exemplu bundle-uit', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const bbimPath = path.resolve(process.cwd(), 'public/example-project.bbim');
    const data = JSON.parse(fs.readFileSync(bbimPath, 'utf-8')) as {
      model: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] };
    };
    expectTracedMatchesPlain(data.model.nodes, data.model.edges);
  });
});
