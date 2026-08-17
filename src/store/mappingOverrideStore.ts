/**
 * mappingOverrideStore — suprascrieri de mapare BIM→articol la nivel de PROIECT.
 *
 * Librăria globală (fișierele MD → JSON compilat) e sursa comună tuturor
 * proiectelor. Uneori un proiect are nevoie de o mapare proprie: un tip BIP
 * nemapat global, sau un articol care aici se măsoară altfel. Astea NU trebuie
 * să schimbe librăria globală — trăiesc în `.bbim`, ca prețurile.
 *
 * La runtime, `getActiveCatalog()` le fuzionează peste catalogul compilat:
 * pe aceeași cheie (nodeType, elementTypeId, materialFilter), overrideul de
 * proiect ÎNLOCUIEȘTE regula globală; altfel o adaugă. Articolele proprii se
 * adaugă în catalog ca să poată fi găsite de motor.
 *
 * `rev` crește la fiecare schimbare — cheie de invalidare a cache-ului din catalog.
 */
import { create } from 'zustand';
import type { NormArticle, NormMappingRule } from '@/lib/norms/types';

interface MappingOverrideStore {
  /** Reguli suplimentare / de suprascriere, la nivel de proiect. */
  rules: NormMappingRule[];
  /** Articole proprii proiectului, referite de reguli. */
  articles: NormArticle[];
  /** Contor de revizie — crește la orice modificare. */
  rev: number;

  addRule: (rule: NormMappingRule) => void;
  updateRule: (index: number, rule: NormMappingRule) => void;
  removeRule: (index: number) => void;
  /** Înlocuiește tot setul de reguli (folosit de editorul de overrides). */
  setRules: (rules: NormMappingRule[]) => void;

  addArticle: (article: NormArticle) => void;
  updateArticle: (index: number, article: NormArticle) => void;
  removeArticle: (index: number) => void;
  setArticles: (articles: NormArticle[]) => void;

  clear: () => void;
}

export const useMappingOverrides = create<MappingOverrideStore>()((set) => ({
  rules: [],
  articles: [],
  rev: 0,

  addRule: (rule) => set((s) => ({ rules: [...s.rules, rule], rev: s.rev + 1 })),
  updateRule: (index, rule) =>
    set((s) => ({ rules: s.rules.map((r, i) => (i === index ? rule : r)), rev: s.rev + 1 })),
  removeRule: (index) =>
    set((s) => ({ rules: s.rules.filter((_, i) => i !== index), rev: s.rev + 1 })),
  setRules: (rules) => set((s) => ({ rules, rev: s.rev + 1 })),

  addArticle: (article) => set((s) => ({ articles: [...s.articles, article], rev: s.rev + 1 })),
  updateArticle: (index, article) =>
    set((s) => ({ articles: s.articles.map((a, i) => (i === index ? article : a)), rev: s.rev + 1 })),
  removeArticle: (index) =>
    set((s) => ({ articles: s.articles.filter((_, i) => i !== index), rev: s.rev + 1 })),
  setArticles: (articles) => set((s) => ({ articles, rev: s.rev + 1 })),

  clear: () => set((s) => ({ rules: [], articles: [], rev: s.rev + 1 })),
}));

// ─── Snapshot pentru catalog (citit în afara React) ───────────────────────────

export interface MappingOverridesSnapshot {
  rules: NormMappingRule[];
  articles: NormArticle[];
  rev: number;
  isEmpty: boolean;
}

export function getMappingOverrides(): MappingOverridesSnapshot {
  const s = useMappingOverrides.getState();
  return {
    rules: s.rules,
    articles: s.articles,
    rev: s.rev,
    isEmpty: s.rules.length === 0 && s.articles.length === 0,
  };
}

// ─── Persistență (.bbim) ──────────────────────────────────────────────────────

export interface MappingOverridePersist {
  rules: NormMappingRule[];
  articles: NormArticle[];
}

export function exportMappingOverrides(): MappingOverridePersist {
  const s = useMappingOverrides.getState();
  return { rules: s.rules, articles: s.articles };
}

export function importMappingOverrides(data: MappingOverridePersist | undefined): void {
  useMappingOverrides.setState((s) => ({
    rules: data?.rules ?? [],
    articles: data?.articles ?? [],
    rev: s.rev + 1,
  }));
}
