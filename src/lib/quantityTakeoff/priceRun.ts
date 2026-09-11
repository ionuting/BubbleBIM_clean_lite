/**
 * priceRun.ts — „rulează calculul de prețuri" pentru modelul în starea curentă:
 * determină articolele folosite efectiv în model, le atribuie prețuri unitare
 * implicite și raportează ce a rămas neacoperit.
 *
 * Pur și testabil. Aplicarea în store + recalculul costurilor se fac de UI
 * (costurile sunt reactive la prețuri).
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import type { NormArticle } from '@/lib/norms';
import { getCompiledUnitPrices } from '@/lib/norms/catalogCompiled';
import { aggregateCalcGroups } from './calcAggregate';
import type { TakeoffOptions } from './takeoffContext';

export interface UsedArticle {
  normId: string;
  article: NormArticle;
}

export interface PriceRunPlan {
  /** Prețurile de aplicat (normId → preț unitar). */
  toApply: Record<string, number>;
  /** Articole folosite în model pentru care NU există preț implicit → totalul ar fi incomplet. */
  missing: UsedArticle[];
  /** Articole cu preț setat manual, păstrate (doar când overwrite = false). */
  kept: UsedArticle[];
  /** Numărul de articole distincte folosite în model. */
  usedCount: number;
  /** Categoriile de lucrări prezente în model. */
  categories: string[];
}

/** Articolele distincte folosite efectiv în model. */
export function usedArticles(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[], opts?: TakeoffOptions): UsedArticle[] {
  const seen = new Map<string, NormArticle>();
  for (const cap of aggregateCalcGroups(nodes, edges, opts))
    for (const s of cap.storeys)
      for (const ag of s.articles) if (!seen.has(ag.normId)) seen.set(ag.normId, ag.article);
  return [...seen.entries()].map(([normId, article]) => ({ normId, article }));
}

/**
 * Planifică rularea. `overwrite = false` (implicit) păstrează prețurile setate
 * manual (> 0) — un „run" nu distruge munca utilizatorului fără cerere explicită.
 */
export function planPriceRun(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  current: Record<string, number>,
  opts: { overwrite?: boolean } & TakeoffOptions = {},
): PriceRunPlan {
  const used = usedArticles(nodes, edges, opts);
  // Prețurile implicite vin din librăria COMPILATĂ (MD → JSON), ca articolele
  // adăugate în MD — lemnul, de pildă — să fie tarifabile fără o copie în TS.
  const defaults = getCompiledUnitPrices();
  const toApply: Record<string, number> = {};
  const missing: UsedArticle[] = [];
  const kept: UsedArticle[] = [];

  for (const u of used) {
    const hasManual = (current[u.normId] ?? 0) > 0;
    if (hasManual && !opts.overwrite) {
      kept.push(u);
      continue;
    }
    const def = defaults[u.normId];
    if (!(def > 0)) {
      // Fără preț implicit: dacă are deja unul manual îl păstrăm, altfel e lipsă.
      if (hasManual) kept.push(u);
      else missing.push(u);
      continue;
    }
    toApply[u.normId] = def;
  }

  const categories = [...new Set(used.map((u) => u.article.categorie))].sort((a, b) => a.localeCompare(b, 'ro'));
  return { toApply, missing, kept, usedCount: used.length, categories };
}

/** Articolele folosite care rămân fără preț (> 0) — totalul e incomplet cât timp există. */
export function unpricedArticles(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  prices: Record<string, number>,
  opts?: TakeoffOptions,
): UsedArticle[] {
  return usedArticles(nodes, edges, opts).filter((u) => (prices[u.normId] ?? 0) <= 0);
}
