/**
 * standaloneBoq.ts — the bill of quantities an exported file carries.
 *
 * What travels is the F3 schedule the app already computes (`computeFullTakeoff`)
 * with the price in force per article (catalogue → user library → project,
 * exactly as `resolvedPrices` resolves it for the panels). What does NOT
 * travel is the takeoff engine: the exported file cannot re-measure the
 * building, so the quantities it shows are the ones the model had at export.
 *
 * The reader can still change two numbers — a quantity and a unit price —
 * and everything derived from them recomputes in the file. That is the
 * arithmetic of pricing a job, and it is all the arithmetic there is: a row's
 * value, the subtotals, the grand total. Nothing geometric. Changing a wall's
 * thickness in the exported file would mean shipping the whole app.
 *
 * Both dependencies are reached lazily, and a failure is not fatal — Clean
 * Lite stubs the takeoff out entirely, and there the export simply carries no
 * schedule.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import type { F3Row } from '@/lib/norms';
import type { StandaloneBoq, StandaloneBoqRow } from './standaloneTypes';

/** The row's identity — the same key `aggregateF3` groups on. */
export const boqRowKey = (r: { normId: string; storeyId: string }): string =>
  `${r.normId}::${r.storeyId}`;

/** F3 rows plus the prices in force, as the exported file wants them. */
export function boqRows(f3: F3Row[], prices: Record<string, number>): StandaloneBoqRow[] {
  return f3.map((r) => ({
    key: boqRowKey(r),
    nrCrt: r.nrCrt,
    symbol: r.symbol,
    denumire: r.denumire,
    unit: String(r.unit),
    quantity: r.quantity,
    unitPrice: prices[r.normId] ?? 0,
    capitol: r.capitol,
    categorie: r.categorie,
    storeyId: r.storeyId,
    storeyName: r.storeyName,
    elements: r.nodeIds?.length ?? 0,
  }));
}

/**
 * The schedule for a model, or null when it has none — an empty graph, or a
 * build with the takeoff excluded.
 */
export async function buildStandaloneBoq(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): Promise<StandaloneBoq | null> {
  try {
    const { computeFullTakeoff } = await import('@/lib/quantityTakeoff');
    const { f3 } = computeFullTakeoff(nodes, edges);
    if (!f3 || f3.length === 0) return null;

    const prices = await resolvedPrices();
    const { CATALOG_VERSION } = await import('@/lib/norms');
    const { CURRENCY } = await import('@/store/priceStore');
    return { currency: CURRENCY, catalogVersion: CATALOG_VERSION, rows: boqRows(f3, prices) };
  } catch {
    return null;
  }
}

/** The price map in force, or an empty one when prices are not part of this build. */
async function resolvedPrices(): Promise<Record<string, number>> {
  try {
    const [{ resolvePrices }, { usePrices }, { useUserLibrary }] = await Promise.all([
      import('@/lib/quantityTakeoff/resolvedPrices'),
      import('@/store/priceStore'),
      import('@/store/userLibraryStore'),
    ]);
    return resolvePrices(usePrices.getState().prices, useUserLibrary.getState().prices);
  } catch {
    return {};
  }
}
