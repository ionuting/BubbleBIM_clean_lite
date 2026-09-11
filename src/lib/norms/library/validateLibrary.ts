/**
 * validateLibrary.ts — validare + raport de acoperire.
 *
 * Rolul acestui modul e să transforme eșecurile TĂCUTE în erori zgomotoase.
 * În modelul vechi, o mapare care nu se potrivea nu era o eroare — producea pur
 * și simplu zero cantități, iar devizul ieșea incomplet fără niciun semnal.
 *
 * Severități:
 *  - `error` — librăria e ruptă; build-ul trebuie să pice.
 *  - `warning` — librăria e validă, dar incompletă (acoperire); nu blochează.
 */
import { ELEMENT_LIBRARY } from '@/lib/elementLibrary';
import type { NormLibrary } from './types';
import { MATERIAL_SYNONYMS, elementTypesFor, resolveMaterialKey, type CompiledLibrary } from './compileLibrary';

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  severity: Severity;
  code: string;
  message: string;
  file?: string;
}

export interface CoverageReport {
  /** Tipuri BIM (nodeType/elementTypeId) fără nicio regulă. */
  unmappedTypes: string[];
  /** Articole declarate dar nefolosite de nicio mapare. */
  unusedArticles: string[];
  mappedTypeCount: number;
  totalTypeCount: number;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  coverage: CoverageReport;
  get ok(): boolean;
}

/** Tipuri de noduri care nu vin din `elementLibrary` (nu au tipuri enumerabile). */
/**
 * Node types that are legitimate mapping targets but have no catalogue of
 * element TYPES behind them — a room is a room, and a stairwell is measured
 * from its solved geometry rather than from a `SLAB15`-style type string. Their
 * mappings use the `*` wildcard, so an empty type list is expected, not a
 * missing entry.
 */
const VIRTUAL_NODE_TYPES = new Set([
  'room', 'ax', 'space', 'zone', 'stairwell', 'sweep',
  // Contour nodes: a shell's "element type" is its ROLE, and a cell is a hole
  // in one — neither has a catalogue of sections behind it.
  'shell', 'cell', 'covering',
  // The roof and what its solver generates: measured from solved faces and
  // member end points, no type catalogue behind them.
  'roof', 'covering', 'rafter', 'hip_rafter', 'valley_rafter', 'ridge_beam', 'wall_plate', 'purlin', 'post',
]);

export function validateLibrary(lib: NormLibrary, compiled: CompiledLibrary): ValidationResult {
  const issues: ValidationIssue[] = [];
  const push = (severity: Severity, code: string, message: string, file?: string) =>
    issues.push({ severity, code, message, file });

  // ── 1. Articole: id-uri duplicate ──
  const seen = new Map<string, string>();
  for (const cat of lib.categories) {
    for (const a of cat.articles) {
      const prev = seen.get(a.normId);
      if (prev) {
        push('error', 'duplicate-article', `articolul \`${a.normId}\` e declarat de două ori (${prev} și ${cat.sourceFile})`, cat.sourceFile);
      } else {
        seen.set(a.normId, cat.sourceFile);
      }
    }
  }

  const articleIds = new Set(compiled.articles.map((a) => a.id));

  // ── 2. Mapări: referințe rupte + nodeType/elementType necunoscute ──
  for (const cat of lib.categories) {
    for (const m of cat.mappings) {
      if (!articleIds.has(m.normId)) {
        push('error', 'unknown-article', `maparea referă articolul inexistent \`${m.normId}\``, cat.sourceFile);
      }

      const isVirtual = VIRTUAL_NODE_TYPES.has(m.nodeType);
      const types = elementTypesFor(m.nodeType);
      if (!isVirtual && types.length === 0) {
        push('error', 'unknown-nodetype', `nodeType necunoscut \`${m.nodeType}\` (nu există în elementLibrary)`, cat.sourceFile);
        continue;
      }

      // ── 3. Cheia de material trebuie să rezolve la ceva ──
      // Aceasta e regula care ar fi prins regresia ro→en: dacă traducerea
      // materialelor golește potrivirea, build-ul pică aici, nu devizul.
      if (m.materialKey) {
        if (!MATERIAL_SYNONYMS[m.materialKey.toLowerCase()]) {
          push('error', 'unknown-material-key',
            `cheie de material necunoscută \`${m.materialKey}\` (permise: ${Object.keys(MATERIAL_SYNONYMS).join(', ')})`,
            cat.sourceFile);
        } else {
          const resolved = resolveMaterialKey(m.nodeType, m.materialKey);
          if (resolved.length === 0) {
            const present = [...new Set(types.map((t) => t.material).filter(Boolean))].join(' | ');
            push('error', 'material-key-unresolved',
              `cheia \`${m.materialKey}\` nu se potrivește cu niciun tip de \`${m.nodeType}\` — materiale prezente: ${present || '(niciunul)'}`,
              cat.sourceFile);
          }
        }
      } else if (!isVirtual && m.elementType !== '*' && !types.some((t) => t.id === m.elementType)) {
        push('error', 'unknown-element-type',
          `elementType \`${m.elementType}\` nu există pentru \`${m.nodeType}\``, cat.sourceFile);
      }
    }
  }

  // ── 3b. Specificații: grupuri, opțiuni, referințe din mapări ──
  const specGroups = lib.specGroups ?? [];
  const optionIds = new Set<string>();
  for (const g of specGroups) {
    for (const o of g.options) optionIds.add(`${g.id}:${o.id}`);
    for (const a of g.defaultArticles) {
      if (!articleIds.has(a)) {
        push('error', 'unknown-default-article',
          `grupul \`${g.id}\` declară articolul implicit inexistent \`${a}\``, '_specificatii.md');
      }
    }
    if (g.options.length < 2) {
      push('warning', 'single-option',
        `grupul \`${g.id}\` are o singură opțiune — nu e nimic de comutat`, '_specificatii.md');
    }
  }

  const specsUsedByRules = new Set(
    lib.categories.flatMap((c) => c.mappings.map((m) => m.spec).filter((x): x is string => !!x)),
  );
  for (const cat of lib.categories) {
    for (const m of cat.mappings) {
      if (m.spec && !optionIds.has(m.spec)) {
        push('error', 'unknown-spec',
          `maparea referă specificația inexistentă \`${m.spec}\` (declar-o în _specificatii.md)`, cat.sourceFile);
      }
    }
  }
  // O opțiune fără mapări e legitimă („fără șapă") ATÂTA TIMP cât grupul are
  // ce scoate: fie articolele implicitului, fie mapările opțiunii implicite,
  // care se dezactivează când alegi altceva. Dacă n-are nici una, nici alta,
  // alegerea nu schimbă nimic și e o capcană tăcută.
  for (const g of specGroups) {
    const defaultHasRules = specsUsedByRules.has(`${g.id}:${g.defaultOption}`);
    if (g.defaultArticles.length > 0 || defaultHasRules) continue;
    for (const o of g.options) {
      if (o.id === g.defaultOption) continue;
      if (!specsUsedByRules.has(`${g.id}:${o.id}`)) {
        push('warning', 'inert-option',
          `opțiunea \`${g.id}:${o.id}\` nu are nicio mapare, iar grupul nu scoate nimic — alegerea n-ar schimba nimic`,
          '_specificatii.md');
      }
    }
  }

  // ── 4. Articole fără preț declarat ──
  for (const cat of lib.categories) {
    for (const a of cat.articles) {
      if (!a.price) {
        push('warning', 'missing-price', `articolul \`${a.normId}\` nu are preț declarat — costul lui va fi 0`, cat.sourceFile);
      }
    }
  }

  // ── 5. Acoperire ──
  // Regulile cu sistem sau cu specificație sunt ALTERNATIVE ale descompunerii
  // implicite, nu acoperire în plus: un tip mapat doar în `timber_frame` sau
  // doar sub `zidarie:bca25` rămâne nemapat implicit, deci nu-l numărăm.
  const mappedTypes = new Set<string>();
  for (const r of compiled.mapping) {
    if (r.structuralSystem || r.spec) continue;
    if (r.elementTypeId === '*') {
      for (const t of elementTypesFor(r.nodeType)) mappedTypes.add(`${r.nodeType}/${t.id}`);
      if (VIRTUAL_NODE_TYPES.has(r.nodeType)) mappedTypes.add(`${r.nodeType}/*`);
    } else {
      mappedTypes.add(`${r.nodeType}/${r.elementTypeId}`);
    }
  }

  const allTypes: string[] = [];
  for (const nodeType of Object.keys(ELEMENT_LIBRARY)) {
    for (const t of elementTypesFor(nodeType)) allTypes.push(`${nodeType}/${t.id}`);
  }
  const unmappedTypes = allTypes.filter((k) => !mappedTypes.has(k));

  const usedArticles = new Set(compiled.mapping.flatMap((r) => r.outputs.map((o) => o.normId)));
  const unusedArticles = compiled.articles.filter((a) => !usedArticles.has(a.id)).map((a) => a.id);

  for (const t of unmappedTypes) {
    push('warning', 'unmapped-type', `tipul BIM \`${t}\` nu are nicio mapare — nu produce cantități`);
  }
  for (const a of unusedArticles) {
    push('warning', 'unused-article', `articolul \`${a}\` nu e folosit de nicio mapare — nu ajunge în deviz`);
  }

  const coverage: CoverageReport = {
    unmappedTypes,
    unusedArticles,
    mappedTypeCount: allTypes.length - unmappedTypes.length,
    totalTypeCount: allTypes.length,
  };

  return {
    issues,
    coverage,
    get ok() {
      return !issues.some((i) => i.severity === 'error');
    },
  };
}

/** Raport lizibil pentru consolă / CI. */
export function formatValidation(res: ValidationResult): string {
  const errors = res.issues.filter((i) => i.severity === 'error');
  const warnings = res.issues.filter((i) => i.severity === 'warning');
  const lines: string[] = [];

  for (const e of errors) lines.push(`  ✖ [${e.code}] ${e.message}${e.file ? `  (${e.file})` : ''}`);
  for (const w of warnings) lines.push(`  ⚠ [${w.code}] ${w.message}${w.file ? `  (${w.file})` : ''}`);

  const { mappedTypeCount, totalTypeCount, unusedArticles } = res.coverage;
  lines.push('');
  lines.push(`  Acoperire: ${mappedTypeCount}/${totalTypeCount} tipuri BIM mapate · ${unusedArticles.length} articole nefolosite`);
  lines.push(`  ${errors.length} erori · ${warnings.length} avertismente`);
  return lines.join('\n');
}
