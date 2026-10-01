/**
 * scenarioStore — the project's cost scenarios, the one that is active, and
 * the target budget.
 *
 * The graph itself stays in the panel's undoable state; this store holds only
 * deltas and their cached results (see `lib/scenarios`). `activeId === null`
 * means the baseline — the live graph as drawn — is what the viewers and the
 * quantities show.
 *
 * `rev` increments on every change so memos keyed on it recompute exactly
 * when something here moved, not on every render.
 *
 * Persisted in `.bbim` and on the backend as `scenarios`, like prices.
 */
import { create } from 'zustand';
import { DEFAULT_CREDIT_TERMS, parseCreditTerms, type CreditTerms } from '@/lib/finance/credit';
import type { Scenario, ScenarioPersist, ScenarioResult } from '@/lib/scenarios/types';
import { createScenario, patchScenario } from '@/lib/scenarios/scenario';
import type { BubbleGraphNode } from '@/store';

interface ScenarioStore {
  scenarios: Scenario[];
  /** Scenario whose delta the editors write into and the viewers show; null = baseline. */
  activeId: string | null;
  /** Up to four ids the comparison panel overlays; the baseline is always shown alongside. */
  compareIds: string[];
  /** Target budget in project currency; 0 = none set. */
  budget: number;
  /** Cum se finanțează construcția — avans, ani, dobândă, preț energie. */
  credit: CreditTerms;
  /** Baseline result cache — the live graph has no Scenario object to carry one. */
  baselineResult: ScenarioResult | null;
  rev: number;

  add: (name: string, init?: Partial<Scenario>) => Scenario;
  duplicate: (id: string, name?: string) => Scenario | null;
  remove: (id: string) => void;
  update: (id: string, patch: Partial<Scenario>) => void;
  /** One inspector edit while a scenario is active — goes into its patches. */
  patchNode: (id: string, base: BubbleGraphNode[], nodeId: string, key: string, value: unknown) => void;
  setActive: (id: string | null) => void;
  toggleCompare: (id: string) => void;
  setBudget: (budget: number) => void;
  setCredit: (credit: Partial<CreditTerms>) => void;
  /** Store a freshly computed result; a no-op when the same hash is already there. */
  storeResult: (id: string | null, result: ScenarioResult) => void;
  clear: () => void;
}

export const useScenarios = create<ScenarioStore>()((set, get) => ({
  scenarios: [],
  activeId: null,
  compareIds: [],
  budget: 0,
  credit: DEFAULT_CREDIT_TERMS,
  baselineResult: null,
  rev: 0,

  add: (name, init) => {
    const s = createScenario(name, get().scenarios, init);
    set((st) => ({
      scenarios: [...st.scenarios, s],
      compareIds: st.compareIds.length < 4 ? [...st.compareIds, s.id] : st.compareIds,
      rev: st.rev + 1,
    }));
    return s;
  },

  duplicate: (id, name) => {
    const src = get().scenarios.find((s) => s.id === id);
    if (!src) return null;
    const copy = createScenario(name ?? `${src.name} (copy)`, get().scenarios, {
      structuralSystem: src.structuralSystem,
      rules: src.rules.map((r) => ({ where: { ...r.where }, set: { ...r.set } })),
      patches: Object.fromEntries(Object.entries(src.patches).map(([k, v]) => [k, { ...v }])),
      prices: src.prices ? { ...src.prices } : undefined,
    });
    set((st) => ({ scenarios: [...st.scenarios, copy], rev: st.rev + 1 }));
    return copy;
  },

  remove: (id) =>
    set((st) => ({
      scenarios: st.scenarios.filter((s) => s.id !== id),
      activeId: st.activeId === id ? null : st.activeId,
      compareIds: st.compareIds.filter((c) => c !== id),
      rev: st.rev + 1,
    })),

  update: (id, patch) =>
    set((st) => ({
      scenarios: st.scenarios.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      rev: st.rev + 1,
    })),

  patchNode: (id, base, nodeId, key, value) =>
    set((st) => ({
      scenarios: st.scenarios.map((s) => (s.id === id ? patchScenario(s, base, nodeId, key, value) : s)),
      rev: st.rev + 1,
    })),

  setActive: (id) => set((st) => (st.activeId === id ? st : { activeId: id, rev: st.rev + 1 })),

  toggleCompare: (id) =>
    set((st) => {
      const has = st.compareIds.includes(id);
      if (has) return { compareIds: st.compareIds.filter((c) => c !== id), rev: st.rev + 1 };
      if (st.compareIds.length >= 4) return st;
      return { compareIds: [...st.compareIds, id], rev: st.rev + 1 };
    }),

  setBudget: (budget) => set((st) => ({ budget: Math.max(0, budget || 0), rev: st.rev + 1 })),

  setCredit: (credit) =>
    set((st) => ({ credit: parseCreditTerms({ ...st.credit, ...credit }), rev: st.rev + 1 })),

  storeResult: (id, result) =>
    set((st) => {
      if (id === null) {
        return st.baselineResult?.hash === result.hash ? st : { baselineResult: result };
      }
      const cur = st.scenarios.find((s) => s.id === id);
      if (!cur || cur.result?.hash === result.hash) return st;
      // Results do not bump `rev`: they are derived, and a bump here would
      // re-run the very evaluation that produced them.
      return { scenarios: st.scenarios.map((s) => (s.id === id ? { ...s, result } : s)) };
    }),

  clear: () => set((st) => ({
    scenarios: [], activeId: null, compareIds: [], budget: 0, credit: DEFAULT_CREDIT_TERMS, baselineResult: null, rev: st.rev + 1,
  })),
}));

// ─── Persistență (.bbim / backend) ───────────────────────────────────────────

export function exportScenarios(): ScenarioPersist {
  const { scenarios, budget, credit } = useScenarios.getState();
  return { scenarios, ...(budget > 0 ? { budget } : {}), credit };
}

export function importScenarios(data: ScenarioPersist | undefined): void {
  const scenarios = Array.isArray(data?.scenarios) ? data!.scenarios : [];
  useScenarios.setState((st) => ({
    scenarios,
    activeId: null,
    compareIds: scenarios.slice(0, 4).map((s) => s.id),
    budget: Math.max(0, Number(data?.budget ?? 0) || 0),
    credit: parseCreditTerms(data?.credit),
    baselineResult: null,
    rev: st.rev + 1,
  }));
}

/** The active scenario object, or null for the baseline. */
export function getActiveScenario(): Scenario | null {
  const { scenarios, activeId } = useScenarios.getState();
  return activeId ? scenarios.find((s) => s.id === activeId) ?? null : null;
}
