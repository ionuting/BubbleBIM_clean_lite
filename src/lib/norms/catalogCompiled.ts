/**
 * catalogCompiled.ts — runtime catalog încărcat din librăria COMPILATĂ.
 *
 * Sursa de adevăr la runtime e `generated/norms.compiled.json`, produs de
 * `scripts/compile-norms-library.mjs` din fișierele MD editabile
 * (`data/norms/library/*.md`). Acest modul doar îl încarcă și îi dă forma pe
 * care o așteaptă motorul (`getActiveCatalog`), fără nicio transformare de date.
 *
 * Modulele TS hardcodate (`devizZidarieConfinata`, `elementNormMappingZidarieConfinata`)
 * rămân ca ancoră de migrare, dar NU mai sunt consumate la runtime — un test de
 * fidelitate (`catalogCompiled.fidelity.test.ts`) garantează că JSON-ul compilat
 * și ancora hardcodată nu diverg în tăcere.
 */
import type { NormArticle, NormMappingRule } from './types';
import type { LibrarySpecGroup } from './library/types';
import compiled from './generated/norms.compiled.json';

export interface RuntimeCatalog {
  id: string;
  version: string;
  currency: string;
  articles: NormArticle[];
  map: Map<string, NormArticle>;
  categories: string[];
  mapping: NormMappingRule[];
  /** Grupurile de specificații — absente în JSON-uri compilate înainte de ele. */
  specGroups: LibrarySpecGroup[];
}

/** Catalogul compilat, dat forma de runtime. Memoizat (JSON-ul e imutabil). */
let cache: RuntimeCatalog | null = null;

export function getCompiledCatalog(): RuntimeCatalog {
  if (cache) return cache;
  const articles = compiled.articles as NormArticle[];
  cache = {
    id: compiled.id,
    version: compiled.version,
    currency: compiled.currency,
    articles,
    map: new Map(articles.map((a) => [a.id, a])),
    categories: compiled.categories as string[],
    mapping: compiled.mapping as NormMappingRule[],
    specGroups: ((compiled as { specGroups?: unknown }).specGroups ?? []) as LibrarySpecGroup[],
  };
  return cache;
}

/** Componentele de deviz ale unui preț unitar (lei / unitatea articolului). */
export interface CompiledPriceComponents {
  material: number;
  manopera: number;
  utilaj: number;
  transport: number;
}

/**
 * Prețurile din librăria compilată, pe componente (normId → material /
 * manoperă / utilaj / transport). Sursa de runtime pentru orice consumator
 * care are nevoie de descompunere — `PRETURI_DEFAULT_RO` rămâne doar ancora
 * de migrare a articolelor mutate în MD.
 */
export function getCompiledPriceComponents(): Record<string, CompiledPriceComponents> {
  return compiled.prices as Record<string, CompiledPriceComponents>;
}

/** De unde vine fiecare preț din librărie (normId → sursă + dată). */
export function getCompiledPriceMeta(): Record<string, { source: string; date: string }> {
  return ((compiled as { priceMeta?: unknown }).priceMeta ?? {}) as Record<string, { source: string; date: string }>;
}

/** Prețurile unitare din librăria compilată (normId → lei). */
export function getCompiledUnitPrices(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, p] of Object.entries(getCompiledPriceComponents())) {
    out[id] = Math.round((p.material + p.manopera + p.utilaj + p.transport) * 100) / 100;
  }
  return out;
}
