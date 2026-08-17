/**
 * Rularea calculului de prețuri pe modelul curent.
 */
import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { planPriceRun, usedArticles, unpricedArticles } from './priceRun';
import { costByCategory, grandTotalCost } from './costByCategory';

async function exampleModel() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const data = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'public/example-project.bbim'), 'utf-8'),
  ) as { model: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } };
  return data.model;
}

describe('planPriceRun', () => {
  it('de la zero: tarifează toate articolele folosite, fără lipsuri', async () => {
    const { nodes, edges } = await exampleModel();
    const plan = planPriceRun(nodes, edges, {});

    expect(plan.usedCount).toBeGreaterThan(0);
    expect(Object.keys(plan.toApply)).toHaveLength(plan.usedCount);
    expect(plan.missing).toHaveLength(0);
    expect(plan.kept).toHaveLength(0);
    expect(plan.categories.length).toBeGreaterThan(0);
    // Toate prețurile aplicate sunt > 0.
    for (const p of Object.values(plan.toApply)) expect(p).toBeGreaterThan(0);
  });

  it('păstrează prețurile manuale (nu le distruge fără overwrite)', async () => {
    const { nodes, edges } = await exampleModel();
    const used = usedArticles(nodes, edges);
    const manualId = used[0].normId;
    const current = { [manualId]: 999 };

    const plan = planPriceRun(nodes, edges, current);
    expect(plan.kept.map((k) => k.normId)).toContain(manualId);
    expect(plan.toApply[manualId]).toBeUndefined();
    expect(Object.keys(plan.toApply)).toHaveLength(plan.usedCount - 1);
  });

  it('overwrite = true suprascrie și prețurile manuale', async () => {
    const { nodes, edges } = await exampleModel();
    const used = usedArticles(nodes, edges);
    const manualId = used[0].normId;

    const plan = planPriceRun(nodes, edges, { [manualId]: 999 }, { overwrite: true });
    expect(plan.kept).toHaveLength(0);
    expect(plan.toApply[manualId]).toBeGreaterThan(0);
    expect(plan.toApply[manualId]).not.toBe(999);
  });

  it('aplicarea planului produce un cost total > 0 (calculul chiar rulează)', async () => {
    const { nodes, edges } = await exampleModel();
    const plan = planPriceRun(nodes, edges, {});
    expect(grandTotalCost(costByCategory(nodes, edges, {}))).toBe(0);
    const total = grandTotalCost(costByCategory(nodes, edges, plan.toApply));
    expect(total).toBeGreaterThan(0);
  });
});

describe('unpricedArticles', () => {
  it('fără prețuri → toate articolele folosite sunt netarifate', async () => {
    const { nodes, edges } = await exampleModel();
    expect(unpricedArticles(nodes, edges, {})).toHaveLength(usedArticles(nodes, edges).length);
  });

  it('după run → niciun articol netarifat', async () => {
    const { nodes, edges } = await exampleModel();
    const plan = planPriceRun(nodes, edges, {});
    expect(unpricedArticles(nodes, edges, plan.toApply)).toHaveLength(0);
  });
});
