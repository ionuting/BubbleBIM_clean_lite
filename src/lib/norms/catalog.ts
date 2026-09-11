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
import type { LibrarySpecGroup } from './library/types';
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
  /** Grupurile de specificații (material/finisaj) — vezi `lib/norms/specs.ts`. */
  specGroups?: LibrarySpecGroup[];
}

/** Cheia de fuziune a unei reguli: același (nodeType, elementTypeId, materialFilter, sistem, spec). */
const mergeKey = (r: NormMappingRule) =>
  `${r.nodeType}|${r.elementTypeId}|${r.materialFilter ?? ''}|${r.structuralSystem ?? ''}|${r.spec ?? ''}`;

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
    specGroups: c.specGroups,
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

/**
 * The rules an element decomposes through.
 *
 * Resolution, most specific first: a rule for the element's STRUCTURAL SYSTEM
 * beats the system-less default; an exact element type beats the `*`
 * wildcard; a material filter beats none. The system step comes first because
 * it is the bigger decision — a timber wall is not a brick wall with a
 * different material, it is a different set of work items altogether.
 *
 * A rule carrying a system the element does NOT resolve to is never a
 * candidate, so the masonry catalog is untouched by the timber rules and a
 * project with no system chosen ('unset') sees exactly what it saw before.
 *
 * SPECIFICATIONS (`specs`, see `lib/norms/specs.ts`) are the second, ORTHOGONAL
 * dimension: which brick, which plaster, which insulation. A rule carrying a
 * `spec` is a candidate only while that option is in force, and each
 * specification is then resolved on its OWN — system, then exact type, then
 * material. Specifications compete with each other, never with the default, so
 * one wildcard row with no system expresses an alternative for every element
 * type in every structural system at once.
 */
export function findMappingRules(
  nodeType: string,
  elementTypeId: string,
  material?: string,
  structuralSystem?: string,
  specs?: Record<string, string>,
): NormMappingRule[] {
  const { mapping } = getActiveCatalog();
  const sys = structuralSystem && structuralSystem !== 'unset' ? structuralSystem : undefined;

  // Pasul 1: doar regulile care privesc acest element ȘI ale căror specificații
  // sunt în vigoare.
  const active = mapping.filter(
    (r) => r.nodeType === nodeType
      && (r.elementTypeId === elementTypeId || r.elementTypeId === '*')
      && specActive(r.spec, specs),
  );
  if (active.length === 0) return [];

  // Pasul 2: fiecare SPECIFICAȚIE se rezolvă separat. Specificațiile sunt
  // alternative între ele, nu între ele și implicitul, deci o alternativă
  // scrisă o dată — fără sistem, cu `*` — funcționează în orice sistem și
  // pentru orice tip de element, fără să fie repetată pentru fiecare.
  const buckets = new Map<string, NormMappingRule[]>();
  for (const r of active) {
    const k = r.spec ?? '';
    const list = buckets.get(k);
    if (list) list.push(r); else buckets.set(k, [r]);
  }

  const out: NormMappingRule[] = [];
  for (const bucket of buckets.values()) out.push(...resolveBucket(bucket, elementTypeId, material, sys));
  return out;
}

/** True când regula n-are specificație, sau când opțiunea ei e cea în vigoare. */
function specActive(spec: string | undefined, specs: Record<string, string> | undefined): boolean {
  if (!spec) return true;
  const i = spec.indexOf(':');
  if (i <= 0) return false;
  return specs?.[spec.slice(0, i)] === spec.slice(i + 1);
}

/**
 * Rezolvarea în interiorul unei specificații: sistemul bate lipsa lui, tipul
 * exact bate wildcard-ul, filtrul de material bate lipsa lui — în ordinea asta.
 */
function resolveBucket(
  bucket: NormMappingRule[],
  elementTypeId: string,
  material: string | undefined,
  sys: string | undefined,
): NormMappingRule[] {
  const all = bucket.filter((r) => !r.structuralSystem || r.structuralSystem === sys);
  if (all.length === 0) return [];

  const forSystem = sys ? all.filter((r) => r.structuralSystem === sys) : [];
  const candidates = forSystem.length > 0 ? forSystem : all.filter((r) => !r.structuralSystem);
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
