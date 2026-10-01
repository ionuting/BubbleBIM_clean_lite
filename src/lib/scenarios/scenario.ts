/**
 * scenario.ts — applying a delta to the live graph, and knowing when a cached
 * result is still good.
 *
 * ## Structural sharing is the whole economy
 *
 * `applyScenario` returns a NEW array in which every node the delta did not
 * touch is the SAME object as in the base graph. That one property is what
 * makes several scenarios cheap: a per-node measurement memo keyed by object
 * identity (see `evaluate.ts`) is hit for every unchanged node, so evaluating
 * five variants of a 60-node building costs about one evaluation plus the
 * handful of walls that actually changed.
 *
 * ## Hashing
 *
 * Per-node hashes are cached in a WeakMap keyed by the node object, for the
 * same reason: a graph hash is then a fold over cached values, not a
 * re-serialisation of 30 KB on every keystroke. The hash is FNV-1a over
 * canonical JSON (keys sorted), so property order in a hand-edited file does
 * not make a scenario look changed.
 *
 * Pure: no store, no React.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { classifyWallSides } from '@/lib/walls/wallSides';
import { adaptGraphToSystem } from '@/lib/systems/profiles';
import type { Scenario, ScenarioRule, ScenarioSlot, WallSide } from './types';

export { classifyWallSides };

// ─── Canonical hashing ────────────────────────────────────────────────────────

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** FNV-1a, 32-bit, as 8 hex chars. Not cryptographic — a change detector. */
export function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const hex = (n: number) => n.toString(16).padStart(8, '0');

/** Stable hash of any JSON-like value, independent of key order. */
export const hashValue = (v: unknown): string => hex(fnv1a(canonical(v)));

const nodeHashCache = new WeakMap<BubbleGraphNode, string>();

/** Hash of one node, memoised on the node object. */
export function nodeHash(n: BubbleGraphNode): string {
  let h = nodeHashCache.get(n);
  if (!h) {
    h = hashValue(n);
    nodeHashCache.set(n, h);
  }
  return h;
}

/**
 * Hash of a whole graph. Order-independent over nodes and edges, so a reorder
 * that changes nothing does not invalidate every scenario.
 */
export function graphHash(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]): string {
  const ns = nodes.map(nodeHash).sort();
  const es = edges.map((e) => `${e.from}>${e.to}:${e.type ?? ''}`).sort();
  return hex(fnv1a(ns.join('|') + '#' + es.join('|')));
}

/** The part of a scenario that changes its numbers — never the cached result or the name. */
export function scenarioDeltaHash(s: Scenario): string {
  return hashValue({
    structuralSystem: s.structuralSystem ?? null,
    keepTypes: s.keepTypes ?? false,
    specs: s.specs ?? {},
    rules: s.rules,
    patches: s.patches,
    prices: s.prices ?? {},
  });
}

// ─── Applying ─────────────────────────────────────────────────────────────────

function ruleMatches(rule: ScenarioRule, n: BubbleGraphNode, sides: Map<string, WallSide>): boolean {
  const w = rule.where;
  if (n.type !== w.nodeType) return false;
  if (w.prop !== undefined && n.properties?.[w.prop] !== w.equals) return false;
  if (w.side !== undefined && sides.get(n.id) !== w.side) return false;
  return true;
}

/** True when every key of `set` already holds the same value on the node. */
function alreadyApplied(n: BubbleGraphNode, set: Record<string, unknown>): boolean {
  const p = n.properties ?? {};
  return Object.keys(set).every((k) => Object.is(p[k], set[k]));
}

/**
 * Element types whose DECOMPOSITION into work items depends on the structural
 * system. A scenario system is stamped onto these as `structural_system`, so
 * every consumer — takeoff, 3D framing — reads it through the one resolver
 * (`resolveStructuralSystem`) without knowing scenarios exist. Rooms, axes and
 * openings are left alone: their quantities do not change with the system,
 * and touching them would defeat the identity memo for nothing.
 */
export const SYSTEM_SENSITIVE_TYPES: ReadonlySet<string> = new Set([
  'wall', 'slab', 'roof', 'column', 'beam', 'foundation',
]);

/**
 * The graph as the scenario sees it.
 *
 * Returns the base array itself when nothing matches, and otherwise a new
 * array in which only the touched nodes are new objects. Order of
 * application, each layer seeing the previous one:
 *
 *   1. the system's TECHNOLOGY (`adaptGraphToSystem`): walls and floors of a
 *      foreign technology retyped to the system's defaults, columns/beams
 *      provisioned or dropped — so "timber frame" means a timber house, not
 *      a brick house with studs painted inside 25 cm walls;
 *   2. the system STAMP on every system-sensitive element that has no
 *      override, so takeoff and 3D read it through `resolveStructuralSystem`;
 *   3. rules, in order — bulk decisions on top of the defaults;
 *   4. patches, last — a per-node exception always wins.
 *
 * `keepTypes` skips layer 1 for a scenario that wants to test "same walls,
 * other decomposition" deliberately.
 */
export function applyScenario(
  base: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  scenario: Scenario | null | undefined,
): BubbleGraphNode[] {
  if (!scenario) return base;
  const hasRules = scenario.rules.length > 0;
  const hasPatches = Object.keys(scenario.patches).length > 0;
  const sys = scenario.structuralSystem && scenario.structuralSystem !== 'unset' ? scenario.structuralSystem : undefined;
  if (!hasRules && !hasPatches && !sys) return base;

  const adapted = sys && !scenario.keepTypes ? adaptGraphToSystem(base, edges, sys).nodes : base;

  const needSides = scenario.rules.some((r) => r.where.side !== undefined);
  const sides = needSides ? classifyWallSides(adapted, edges) : new Map<string, WallSide>();

  let changed = adapted !== base;
  const out = adapted.map((n) => {
    let next: Record<string, unknown> | null = null;
    // The scenario's system, unless the element carries its own choice.
    if (sys && SYSTEM_SENSITIVE_TYPES.has(n.type) && !n.properties?.structural_system
      && n.properties?.structural_system !== sys) {
      next = { ...n.properties, structural_system: sys };
    }
    for (const r of scenario.rules) {
      if (!ruleMatches(r, n, sides)) continue;
      if (!next && alreadyApplied(n, r.set)) continue;
      next = { ...(next ?? n.properties), ...r.set };
    }
    const patch = scenario.patches[n.id];
    if (patch && Object.keys(patch).length > 0 && (next || !alreadyApplied(n, patch))) {
      next = { ...(next ?? n.properties), ...patch };
    }
    if (!next) return n;
    changed = true;
    return { ...n, properties: next };
  });
  return changed ? out : base;
}

/** Ids of the nodes a scenario rewrites — what the canvas badges. */
export function touchedNodeIds(
  base: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  scenario: Scenario | null | undefined,
): Set<string> {
  const applied = applyScenario(base, edges, scenario);
  const out = new Set<string>();
  if (applied === base) return out;
  for (let i = 0; i < base.length; i++) if (applied[i] !== base[i]) out.add(base[i].id);
  return out;
}

// ─── Construction helpers ─────────────────────────────────────────────────────

let seq = 0;
export function newScenarioId(): string {
  seq += 1;
  return `sc_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** The first palette slot not taken by an existing scenario; wraps past four. */
export function freeSlot(existing: Scenario[]): ScenarioSlot {
  const taken = new Set(existing.map((s) => s.slot));
  for (const s of [0, 1, 2, 3] as const) if (!taken.has(s)) return s;
  return ((existing.length % 4) as ScenarioSlot);
}

export function createScenario(name: string, existing: Scenario[], init: Partial<Scenario> = {}): Scenario {
  return {
    id: newScenarioId(),
    name,
    slot: freeSlot(existing),
    createdAt: new Date().toISOString(),
    rules: [],
    patches: {},
    ...init,
  };
}

/** Write one property change into a scenario's patches, dropping the key when it returns to the base value. */
export function patchScenario(
  scenario: Scenario,
  base: BubbleGraphNode[],
  nodeId: string,
  key: string,
  value: unknown,
): Scenario {
  const baseNode = base.find((n) => n.id === nodeId);
  const cur = { ...(scenario.patches[nodeId] ?? {}) };
  if (baseNode && Object.is(baseNode.properties?.[key], value)) delete cur[key];
  else cur[key] = value;
  const patches = { ...scenario.patches };
  if (Object.keys(cur).length === 0) delete patches[nodeId];
  else patches[nodeId] = cur;
  return { ...scenario, patches, result: undefined };
}
