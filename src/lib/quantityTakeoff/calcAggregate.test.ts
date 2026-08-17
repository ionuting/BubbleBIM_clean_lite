/**
 * Invariant: agregarea din memoriul de calcul (per articol + etaj) coincide cu
 * Lista F3 (`aggregateF3`) — aceleași totaluri, aceleași grupuri.
 */
import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { computeTakeoff, aggregateF3 } from './takeoffEngine';
import { aggregateCalcGroups } from './calcAggregate';

function flatten(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]) {
  const groups = aggregateCalcGroups(nodes, edges);
  const map = new Map<string, { total: number; count: number }>();
  for (const cap of groups)
    for (const sg of cap.storeys)
      for (const ag of sg.articles)
        map.set(`${ag.normId}::${ag.storeyId}`, { total: ag.total, count: ag.elements.length });
  return map;
}

describe('aggregateCalcGroups vs aggregateF3', () => {
  it('totaluri identice pe proiectul exemplu', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const data = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'public/example-project.bbim'), 'utf-8'),
    ) as { model: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } };
    const { nodes, edges } = data.model;

    const f3 = aggregateF3(computeTakeoff(nodes, edges));
    const agg = flatten(nodes, edges);

    // Fiecare rând F3 are un grup agregat cu aceeași cantitate.
    expect(f3.length).toBeGreaterThan(0);
    expect(agg.size).toBe(f3.length);
    for (const row of f3) {
      const g = agg.get(`${row.normId}::${row.storeyId}`);
      expect(g, `grup lipsă: ${row.normId}::${row.storeyId}`).toBeDefined();
      expect(g!.total).toBeCloseTo(row.quantity, 2);
      expect(g!.count).toBe(row.nodeIds.length);
    }
  });
});
