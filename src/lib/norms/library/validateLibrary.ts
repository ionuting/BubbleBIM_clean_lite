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
const VIRTUAL_NODE_TYPES = new Set(['room', 'ax', 'space', 'zone']);

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

  // ── 4. Articole fără preț declarat ──
  for (const cat of lib.categories) {
    for (const a of cat.articles) {
      if (!a.price) {
        push('warning', 'missing-price', `articolul \`${a.normId}\` nu are preț declarat — costul lui va fi 0`, cat.sourceFile);
      }
    }
  }

  // ── 5. Acoperire ──
  const mappedTypes = new Set<string>();
  for (const r of compiled.mapping) {
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
