/**
 * economist.ts — the second questline: from "a building" to "a building you
 * can afford", ticking itself off from the cost scenarios.
 *
 * Same shape as `questline.ts` and the same rule: every step is a pure count
 * over live state, never a flag someone sets. The state here is the scenario
 * store's — prices, budget, scenarios and their cached results — handed in as
 * a plain snapshot so this stays framework-free and unit-tested.
 *
 * Steps, in the order a first-time user meets them:
 *   price   — every article used in the model has a unit price
 *   budget  — a target budget is set
 *   variant — at least one scenario exists
 *   system  — one scenario tries a different structural system
 *   cheaper — a scenario beats the baseline by ≥ 5 %
 *   afford  — the cheapest evaluated variant lands under the budget
 */
import type { QuestStepState, QuestlineProgress } from './questline';

export interface EconomySnapshot {
  /** Baseline total in project currency, 0 when nothing is priced. */
  baselineTotal: number;
  /** Articles used by the model that still have no price. */
  unpricedCount: number;
  /** Articles used by the model, priced or not. */
  articleCount: number;
  budget: number;
  scenarios: Array<{
    total: number | null;
    /** The scenario's own system, undefined when it keeps the project's. */
    structuralSystem?: string;
  }>;
  projectSystem: string;
}

interface StepDef {
  id: string;
  title: string;
  hint: string;
  icon: string;
  target: number;
  count: (e: EconomySnapshot) => number;
}

export const CHEAPER_BY = 0.05;

const evaluated = (e: EconomySnapshot) => e.scenarios.filter((s) => s.total != null && s.total > 0);
const cheapest = (e: EconomySnapshot) => Math.min(...evaluated(e).map((s) => s.total as number), Infinity);

const STEPS: StepDef[] = [
  {
    id: 'price', title: 'Price the model', icon: '¤', target: 1,
    hint: 'Open Cost structure and press Calculate costs — every article needs a unit price.',
    count: (e) => (e.articleCount > 0 && e.unpricedCount === 0 ? 1 : 0),
  },
  {
    id: 'budget', title: 'Set a budget', icon: '◎', target: 1,
    hint: 'Give the project a target budget in the scenario bar.',
    count: (e) => (e.budget > 0 ? 1 : 0),
  },
  {
    id: 'variant', title: 'Create a scenario', icon: '⑂', target: 1,
    hint: 'Add a scenario and change something — a wall type, a floor, the system.',
    count: (e) => e.scenarios.length,
  },
  {
    id: 'system', title: 'Try another system', icon: '⌂', target: 1,
    hint: 'Set one scenario to a different structural system, e.g. timber frame.',
    count: (e) => e.scenarios.filter((s) => s.structuralSystem && s.structuralSystem !== 'unset'
      && s.structuralSystem !== e.projectSystem).length,
  },
  {
    id: 'cheaper', title: 'Beat the baseline by 5 %', icon: '↓', target: 1,
    hint: 'Find a combination that costs at least 5 % less than the baseline.',
    count: (e) => (e.baselineTotal > 0 && cheapest(e) <= e.baselineTotal * (1 - CHEAPER_BY) ? 1 : 0),
  },
  {
    id: 'afford', title: 'Land under budget', icon: '✓', target: 1,
    hint: 'Bring the cheapest scenario under the budget you set.',
    count: (e) => (e.budget > 0 && evaluated(e).length > 0 && cheapest(e) <= e.budget ? 1 : 0),
  },
];

export function evaluateEconomist(e: EconomySnapshot): QuestlineProgress {
  const steps: QuestStepState[] = STEPS.map((def) => {
    const raw = Math.max(0, Math.round(def.count(e)));
    const current = Math.min(raw, def.target);
    return { id: def.id, title: def.title, hint: def.hint, icon: def.icon, current, target: def.target, done: raw >= def.target };
  });
  const completed = steps.filter((s) => s.done).length;
  const total = steps.length;
  const nextStep = steps.find((s) => !s.done) ?? null;
  return { steps, completed, total, pct: Math.round((completed / total) * 100), nextStep, allDone: completed === total };
}
