/**
 * Costuri pe categorie + plierea în „Alte" + prețurile orientative implicite.
 */
import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { costByCategory, topNWithOther, grandTotalCost, OTHER_LABEL } from './costByCategory';
import { aggregateCalcGroups } from './calcAggregate';
import { PRETURI_DEFAULT_RO, totalPret, preturiDefaultTotale } from '@/lib/norms';

async function exampleModel() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const data = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'public/example-project.bbim'), 'utf-8'),
  ) as { model: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } };
  return data.model;
}

describe('costByCategory', () => {
  it('însumează cantitate × preț pe categorie; cotele dau 1', async () => {
    const { nodes, edges } = await exampleModel();
    const costs = costByCategory(nodes, edges, preturiDefaultTotale());

    expect(costs.length).toBeGreaterThan(0);
    // Ordonat descrescător.
    for (let i = 1; i < costs.length; i++) expect(costs[i - 1].total).toBeGreaterThanOrEqual(costs[i].total);
    // Cotele însumează 1.
    expect(costs.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1, 6);

    // Totalul pe categorii = Σ pe articole (cantitate × preț).
    let expected = 0;
    const prices = preturiDefaultTotale();
    for (const cap of aggregateCalcGroups(nodes, edges))
      for (const s of cap.storeys)
        for (const ag of s.articles) expected += ag.total * (prices[ag.normId] ?? 0);
    expect(grandTotalCost(costs)).toBeCloseTo(expected, 4);
  });

  it('fără prețuri → niciun cost', async () => {
    const { nodes, edges } = await exampleModel();
    expect(costByCategory(nodes, edges, {})).toHaveLength(0);
  });
});

describe('topNWithOther', () => {
  const mk = (categorie: string, total: number, share: number) => ({ categorie, total, share });

  it('pliază restul în „Alte" păstrând totalul', () => {
    const costs = [mk('A', 50, 0.5), mk('B', 30, 0.3), mk('C', 10, 0.1), mk('D', 6, 0.06), mk('E', 4, 0.04)];
    const out = topNWithOther(costs, 3);
    expect(out).toHaveLength(4);
    expect(out[3].categorie).toBe(OTHER_LABEL);
    expect(out[3].total).toBe(10);
    expect(out.reduce((a, c) => a + c.total, 0)).toBe(100);
    expect(out.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1, 6);
  });

  it('nu pliază dacă sunt deja ≤ n', () => {
    const costs = [mk('A', 50, 0.5), mk('B', 50, 0.5)];
    expect(topNWithOther(costs, 3)).toHaveLength(2);
  });
});

describe('prețuri orientative implicite', () => {
  it('totalul = material + manoperă + utilaj + transport', () => {
    for (const [id, c] of Object.entries(PRETURI_DEFAULT_RO)) {
      const sum = c.material + c.manopera + c.utilaj + c.transport;
      expect(totalPret(c), id).toBeCloseTo(sum, 2);
      expect(totalPret(c), id).toBeGreaterThan(0);
    }
  });

  it('acoperă toate articolele folosite în proiectul exemplu', async () => {
    const { nodes, edges } = await exampleModel();
    const used = new Set<string>();
    for (const cap of aggregateCalcGroups(nodes, edges))
      for (const s of cap.storeys)
        for (const ag of s.articles) used.add(ag.normId);

    const missing = [...used].filter((id) => !PRETURI_DEFAULT_RO[id]);
    expect(missing, `articole fără preț implicit: ${missing.join(', ')}`).toHaveLength(0);
  });
});
