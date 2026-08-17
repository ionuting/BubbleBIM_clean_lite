/**
 * costByCategory.ts — costul construcției agregat pe CATEGORIE DE LUCRĂRI.
 * Cost categorie = Σ pe articole (cantitate × preț unitar). Pur și testabil.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { aggregateCalcGroups } from './calcAggregate';

export interface CategoryCost {
  categorie: string;
  total: number;
  /** Cota din costul total, 0..1. */
  share: number;
}

/** Eticheta grupului rezidual când se pliază categoriile mici. */
export const OTHER_LABEL = 'Alte';

/** Costurile pe categorie, ordonate descrescător. Include doar categoriile cu cost > 0. */
export function costByCategory(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  prices: Record<string, number>,
): CategoryCost[] {
  const byCat = new Map<string, number>();
  for (const cap of aggregateCalcGroups(nodes, edges))
    for (const s of cap.storeys)
      for (const ag of s.articles) {
        const cost = ag.total * (prices[ag.normId] ?? 0);
        if (cost <= 0) continue;
        byCat.set(ag.article.categorie, (byCat.get(ag.article.categorie) ?? 0) + cost);
      }

  const grand = [...byCat.values()].reduce((a, b) => a + b, 0);
  return [...byCat.entries()]
    .map(([categorie, total]) => ({ categorie, total, share: grand > 0 ? total / grand : 0 }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Păstrează primele `n` categorii și pliază restul în „Alte".
 * Necesar fiindcă o formă part-to-whole cu identitate prin culoare nu poate purta
 * mai multe clase decât validează paleta — restul se pliază, nu se colorează cu hue-uri noi.
 */
export function topNWithOther(costs: CategoryCost[], n: number): CategoryCost[] {
  if (costs.length <= n) return costs;
  const head = costs.slice(0, n);
  const tail = costs.slice(n);
  const total = tail.reduce((a, c) => a + c.total, 0);
  const share = tail.reduce((a, c) => a + c.share, 0);
  return total > 0 ? [...head, { categorie: OTHER_LABEL, total, share }] : head;
}

/** Costul total al construcției. */
export function grandTotalCost(costs: CategoryCost[]): number {
  return costs.reduce((a, c) => a + c.total, 0);
}
