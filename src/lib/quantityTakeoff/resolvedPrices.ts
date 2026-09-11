/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * resolvedPrices.ts — the price actually in force for an article.
 *
 * WHY THIS EXISTS
 * ---------------
 * `usePrices` holds only what the PROJECT overrides, and starts empty. That is
 * the right thing to persist — a `.bbim` should carry the user's numbers, not a
 * copy of the catalogue — but it is the wrong thing to compute with: every
 * consumer that read the store directly saw an empty map on a fresh project and
 * reported a total of zero. A model that is fully priced in the catalogue must
 * not read as free.
 *
 * So the price in force is the catalogue's, with the project's on top:
 *
 *     resolvePrices(overrides) = { ...catalogue, ...overrides }
 *
 * This is the same fallback `PriceConfigPanel` shows per row ("al tău" vs the
 * catalogue value); putting it here makes every other consumer agree with the
 * panel instead of each deciding for itself.
 *
 * IDENTITY MATTERS
 * ----------------
 * The merged map is cached on the override object's identity, so repeated calls
 * during a render return the SAME object. `useScenarioResults` keeps prices in
 * an effect's dependency array — a fresh object per render would re-evaluate
 * every scenario forever.
 *
 * Not imported by the Clean Lite build: every consumer of it is stubbed there.
 */
import { useMemo } from 'react';
import { getCompiledUnitPrices } from '@/lib/norms/catalogCompiled';
import { usePrices } from '@/store/priceStore';

let cache: { project: Record<string, number>; out: Record<string, number> } | null = null;

/**
 * Prețul în vigoare: **catalog → proiect**.
 *
 * Stabil pe identitatea intrărilor — hrănește o dependență de efect.

 */
export function resolvePrices(overrides: Record<string, number>): Record<string, number> {
  if (cache && cache.project === overrides) return cache.out;
  const out: Record<string, number> = { ...getCompiledUnitPrices() };
  // An override of 0 means "not priced by me" and must not blank the catalogue:
  // clearing a price is `resetPrice`, which removes the key entirely.
  for (const [id, p] of Object.entries(overrides)) if (p > 0) out[id] = p;
  cache = { project: overrides, out };
  return out;
}

/** The whole price map in force, for anything that computes a cost. */
export function useResolvedPrices(): Record<string, number> {
  const overrides = usePrices((s) => s.prices);
  return useMemo(() => resolvePrices(overrides), [overrides]);
}

/** One article's price in force — for an editable single-price field. */
export function useResolvedPrice(normId: string): number {
  return useResolvedPrices()[normId] ?? 0;
}
