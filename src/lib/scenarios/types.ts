/**
 * types.ts — a scenario is a DELTA over the live graph, never a copy of it.
 *
 * ## Why a delta
 *
 * A project is one graph. "What if the walls were timber?" is not a second
 * project — it is the same graph with a few decisions changed. Copying the
 * graph per variant would cost the full model every time and, worse, would
 * fork it: a wall moved in the baseline would not move in the variants. A
 * delta keeps one source of truth and stores only the decisions.
 *
 * ## The three layers of a delta
 *
 * - `structuralSystem` — the project default for this scenario. Read by the
 *   takeoff through `resolveStructuralSystem`, so a timber scenario changes how
 *   every wall is DECOMPOSED into work items without touching its geometry.
 * - `rules` — "every X that matches Y gets Z". Compact, and they survive nodes
 *   added after the scenario was written: a wall drawn tomorrow still turns to
 *   timber in the timber scenario. This is the normal way to express a variant.
 * - `patches` — per-node exceptions, keyed by node id. What the inspector
 *   writes when a scenario is active and the user edits one element.
 *
 * Plus `prices` — unit-price overrides on top of the project's price store, for
 * "same building, a different supplier".
 *
 * ## The cached result
 *
 * `result` is what the scenario COST the last time it was evaluated, stamped
 * with the hash of everything that fed it. When the hash still matches, the
 * numbers are served without recomputing; when it does not, they are stale and
 * `evaluateScenario` replaces them. Small (tens of rows) and saved with the
 * project, so reopening a file shows every variant's numbers immediately.
 *
 * Pure types — no store, no React.
 */
import type { StructuralSystem } from '@/lib/systems/structuralSystem';
import type { CreditTerms } from '@/lib/finance/credit';
import type { SpecSelection } from '@/lib/norms/specs';
import type { F3Row } from '@/lib/norms/types';

/** Palette slot — the comparison view has exactly four, so a scenario owns one. */
export type ScenarioSlot = 0 | 1 | 2 | 3;

/** Where a wall sits on its storey, derived from the wall network — never typed by hand. */
export type WallSide = 'exterior' | 'interior';

export interface ScenarioRuleWhere {
  /** Node type the rule applies to (`wall`, `slab`, `room`, …). */
  nodeType: string;
  /** Optional: only nodes whose `properties[prop]` equals `equals`. */
  prop?: string;
  equals?: unknown;
  /** Optional, walls only: exterior ring or interior partitions. */
  side?: WallSide;
}

export interface ScenarioRule {
  where: ScenarioRuleWhere;
  /** Properties written onto every matching node. */
  set: Record<string, unknown>;
}

/** One metric of a scenario, in project currency. */
export interface ScenarioMetrics {
  /** Σ quantity × unit price over every priced article. */
  total: number;
  /** The four deviz components, when the catalog knows them for an article. */
  material: number;
  manopera: number;
  utilaj: number;
  transport: number;
  /** Articles used in the model that have no price — the total is incomplete while > 0. */
  unpricedCount: number;
}

export interface ScenarioCategoryCost {
  categorie: string;
  total: number;
}

export interface ScenarioResult {
  /** Hash of (base graph, delta, prices, catalog version) this was computed from. */
  hash: string;
  computedAt: string;
  metrics: ScenarioMetrics;
  byCategory: ScenarioCategoryCost[];
  f3: F3Row[];
  /** Built floor area in m², from rooms and slabs; 0 when the model has none. */
  builtAreaM2: number;
  /** total / builtAreaM2, or 0 when there is no area. */
  perM2: number;
  /** Wall-hours of labour, from the manoperă component at the catalog's hourly rate. */
  labourHours: number;
  /** Embodied carbon in kg CO₂e, from per-article factors; 0 when no factor is known. */
  co2Kg: number;
  /** Articles that had a CO₂ factor — the figure above is partial while this is below the article count. */
  co2CoveredCount: number;
  articleCount: number;
  /**
   * Annual heating NEED of the envelope, kWh/m²·an — not consumption: no boiler
   * efficiency, no heat recovery. The figure that lets a thicker wall be argued
   * against a cheaper one. 0 when the model has no envelope.
   */
  energyKwhM2Yr: number;
  /** Transmission + ventilation heat loss coefficient, W/K. */
  heatLossWPerK: number;
  /** Share of the transmission loss that comes from thermal bridges, 0…1. */
  bridgeShare: number;
  /** True when there is no envelope shell — the energy figures are absent, not zero. */
  energyMissing: boolean;
}

export interface Scenario {
  id: string;
  name: string;
  slot: ScenarioSlot;
  createdAt: string;
  structuralSystem?: StructuralSystem;
  /**
   * Do NOT retype walls/floors and provision the frame for `structuralSystem`
   * (see `adaptGraphToSystem`) — keep the base element types and only change
   * their decomposition. Off by default: a system change means a technology.
   */
  keepTypes?: boolean;
  /**
   * Material and finish choices (`grup → opțiune`, see `lib/norms/specs.ts`):
   * which brick, which plaster, which insulation, which floor. Orthogonal to
   * `structuralSystem` and applied through the takeoff options, not by
   * rewriting nodes — a whole finish package is a handful of strings.
   */
  specs?: SpecSelection;
  rules: ScenarioRule[];
  patches: Record<string, Record<string, unknown>>;
  prices?: Record<string, number>;
  result?: ScenarioResult;
}

/** What goes into a `.bbim` and onto the backend — the scenarios as they are. */
export interface ScenarioPersist {
  scenarios: Scenario[];
  /** Target budget in project currency, or 0 when none was set. */
  budget?: number;
  /** Cum se finanțează construcția. Absent în fișierele salvate înainte de modul. */
  credit?: CreditTerms;
}

/** The metric the comparison view can be switched to. */
export type ScenarioMetricKey =
  | 'total' | 'material' | 'manopera' | 'utilaj' | 'transport' | 'perM2'
  | 'labourHours' | 'co2Kg' | 'energyKwhM2Yr'
  /** Construcția finanțată: avans + toate ratele. Cere termenii creditului. */
  | 'totalWithCredit'
  /** Avans + rate + energie, pe durata creditului. Cere termenii creditului. */
  | 'totalOverTerm';

export const SCENARIO_METRIC_LABELS: Record<ScenarioMetricKey, string> = {
  total: 'Total cost',
  material: 'Materials',
  manopera: 'Labour',
  utilaj: 'Equipment',
  transport: 'Transport',
  perM2: 'Cost / m²',
  labourHours: 'Labour hours',
  co2Kg: 'CO₂e (kg)',
  energyKwhM2Yr: 'Încălzire (kWh/m²·an)',
  totalWithCredit: 'Cost cu credit',
  totalOverTerm: 'Cost total pe durata creditului',
};

/** Metricile care nu ies din rezultat singure — au nevoie de termenii creditului. */
export const FINANCE_METRICS: readonly ScenarioMetricKey[] = ['totalWithCredit', 'totalOverTerm'];
