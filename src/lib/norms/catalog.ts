/**
 * catalog.ts — Active norm catalog and mapping configuration.
 *
 * ── Sursa de adevăr la runtime ──────────────────────────────────────────────
 * Catalogul `zidarie-confinata` e servit din librăria COMPILATĂ
 * (`generated/norms.compiled.json`), produsă din fișierele MD editabile de
 * `scripts/compile-norms-library.mjs`. Modulele TS hardcodate rămân doar ca
 * ANCORĂ de migrare — accesibile prin `getLegacyZidarieCatalog()` și verificate
 * de un test de fidelitate ca să nu diveargă tăcut de JSON. Nu le mai consumă
 * nimeni la runtime.
 *
 * Alternate: indicator C starter (generic), încă servit din TS.
 */

import type { NormArticle, NormMappingRule } from './types';
import {
  INDICATOR_C_STARTER,
  NORM_ARTICLE_MAP as INDICATOR_C_MAP,
} from './indicatorCStarter';
import { ELEMENT_NORM_MAPPING, findIndicatorMappingRules } from './elementNormMapping';
import {
  DEVIZ_ZIDARIE_STARTER,
  DEVIZ_ZIDARIE_MAP,
  DEVIZ_ZIDARIE_CATALOG_VERSION,
  DEVIZ_ZIDARIE_CATEGORIES,
} from './devizZidarieConfinata';
import {
  ZIDARIE_CONFINATA_MAPPING,
} from './elementNormMappingZidarieConfinata';
import { getCompiledCatalog, type RuntimeCatalog } from './catalogCompiled';
import { getMappingOverrides } from '@/store/mappingOverrideStore';

export type CatalogId = 'zidarie-confinata' | 'indicator-c-starter';

/** Active catalog — switch here to change norm set project-wide. */
export const ACTIVE_CATALOG_ID: CatalogId = 'zidarie-confinata';

export interface ActiveCatalog {
  id: CatalogId;
  version: string;
  articles: NormArticle[];
  map: Map<string, NormArticle>;
  categories: string[];
  mapping: NormMappingRule[];
}

/** Cheia de fuziune a unei reguli: același (nodeType, elementTypeId, materialFilter). */
const mergeKey = (r: NormMappingRule) => `${r.nodeType}|${r.elementTypeId}|${r.materialFilter ?? ''}`;

/**
 * Fuzionează suprascrierile de proiect peste catalogul de bază.
 * Pe aceeași cheie de regulă, overrideul ÎNLOCUIEȘTE; altfel se adaugă.
 * Articolele proprii proiectului se adaugă (override pe id dacă coincide).
 */
function mergeOverrides(base: ActiveCatalog): ActiveCatalog {
  const ov = getMappingOverrides();

  const ruleByKey = new Map<string, NormMappingRule>();
  for (const r of base.mapping) ruleByKey.set(mergeKey(r), r);
  for (const r of ov.rules) ruleByKey.set(mergeKey(r), r);

  const articles = [...base.articles];
  const map = new Map(base.map);
  for (const a of ov.articles) {
    if (map.has(a.id)) articles[articles.findIndex((x) => x.id === a.id)] = a;
    else articles.push(a);
    map.set(a.id, a);
  }

  return {
    ...base,
    articles,
    map,
    categories: [...new Set(articles.map((a) => a.categorie))],
    mapping: [...ruleByKey.values()],
  };
}

// Cache pentru catalogul fuzionat — invalidat de `rev`-ul overrideurilor.
let mergedCache: { rev: number; catalog: ActiveCatalog } | null = null;

export function getActiveCatalog(): ActiveCatalog {
  if (ACTIVE_CATALOG_ID === 'indicator-c-starter') {
    return {
      id: 'indicator-c-starter',
      version: 'indicator-c-starter-1',
      articles: INDICATOR_C_STARTER,
      map: INDICATOR_C_MAP,
      categories: [...new Set(INDICATOR_C_STARTER.map((a) => a.categorie))],
      mapping: ELEMENT_NORM_MAPPING,
    };
  }
  // Runtime = librăria compilată (MD → JSON), nu modulele TS hardcodate.
  const c: RuntimeCatalog = getCompiledCatalog();
  const base: ActiveCatalog = {
    id: 'zidarie-confinata',
    version: c.version,
    articles: c.articles,
    map: c.map,
    categories: c.categories,
    mapping: c.mapping,
  };

  // Fără suprascrieri de proiect → catalogul de bază neschimbat (comportament identic).
  const ov = getMappingOverrides();
  if (ov.isEmpty) return base;

  if (mergedCache && mergedCache.rev === ov.rev) return mergedCache.catalog;
  const merged = mergeOverrides(base);
  mergedCache = { rev: ov.rev, catalog: merged };
  return merged;
}

/**
 * Catalogul zidărie confinată din modulele TS HARDCODATE (ancora de migrare).
 * NU e sursa de runtime — folosit doar de testul de fidelitate și de
 * `buildLibraryFromActiveCatalog` (care re-emite fișierele MD din ancoră).
 */
export function getLegacyZidarieCatalog(): ActiveCatalog {
  return {
    id: 'zidarie-confinata',
    version: DEVIZ_ZIDARIE_CATALOG_VERSION,
    articles: DEVIZ_ZIDARIE_STARTER,
    map: DEVIZ_ZIDARIE_MAP,
    categories: DEVIZ_ZIDARIE_CATEGORIES,
    mapping: ZIDARIE_CONFINATA_MAPPING,
  };
}

export function findMappingRules(
  nodeType: string,
  elementTypeId: string,
  material?: string,
): NormMappingRule[] {
  const { mapping } = getActiveCatalog();
  const candidates = mapping.filter(
    (r) => r.nodeType === nodeType
      && (r.elementTypeId === elementTypeId || r.elementTypeId === '*'),
  );
  if (candidates.length === 0) return [];

  const exactId = candidates.filter((r) => r.elementTypeId === elementTypeId);
  const pool = exactId.length > 0 ? exactId : candidates;

  if (material) {
    const withMat = pool.filter((r) => r.materialFilter && material.includes(r.materialFilter));
    if (withMat.length > 0) return withMat;
  }

  const noFilter = pool.filter((r) => !r.materialFilter);
  return noFilter.length > 0 ? noFilter : pool;
}

// Re-export indicator finder for tests
export { findIndicatorMappingRules };
