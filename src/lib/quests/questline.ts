/**
 * questline.ts — "First Building" guided questline.
 *
 * A pure evaluator that reads the live graph (nodes + edges + grid) and reports,
 * for each modeling milestone, whether it is done and how far along it is. The
 * UI (QuestPanel) renders this; it holds no state of its own, so the checklist
 * self-updates as the user models — no manual "mark complete" anywhere.
 *
 * Framework-free and side-effect-free → unit-tested against synthetic graphs.
 */
import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes } from '@/store';

export interface QuestStepState {
  id: string;
  /** Short imperative title, e.g. "Structural grid". */
  title: string;
  /** One-line contextual nudge shown while this is the active step. */
  hint: string;
  /** Emoji marker (kept understated — one glyph). */
  icon: string;
  current: number;
  target: number;
  done: boolean;
}

export interface QuestlineProgress {
  steps: QuestStepState[];
  completed: number;
  total: number;
  /** 0–100. */
  pct: number;
  /** First not-yet-done step, or null when everything is complete. */
  nextStep: QuestStepState | null;
  allDone: boolean;
}

interface StepDef {
  id: string;
  title: string;
  hint: string;
  icon: string;
  target: number;
  /** Raw progress count for this milestone from the graph. */
  count: (ctx: QuestContext) => number;
}

interface QuestContext {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  axes: BuildingAxes;
  byId: Map<string, BubbleGraphNode>;
  /** node id → set of neighbour node ids (undirected). */
  adj: Map<string, Set<string>>;
  counts: Record<string, number>;
}

const ANCHOR = new Set(['ax', 'column']);
const ENCLOSURE = new Set(['slab', 'room', 'covering', 'shell']);
const ROOF_MEMBER = new Set([
  'roof_ridge', 'roof_eave', 'roof_hip', 'roof_valley', 'roof_break',
  'rafter', 'hip_rafter', 'valley_rafter', 'ridge_beam', 'purlin', 'wall_plate',
]);

/** Walls with at least two anchor (ax/column) endpoints — i.e. real, placed walls. */
function anchoredWallCount(ctx: QuestContext): number {
  let n = 0;
  for (const node of ctx.nodes) {
    if (node.type !== 'wall') continue;
    const nbrs = ctx.adj.get(node.id);
    if (!nbrs) continue;
    let anchors = 0;
    for (const id of nbrs) {
      const nb = ctx.byId.get(id);
      if (nb && ANCHOR.has(nb.type)) anchors++;
    }
    if (anchors >= 2) n++;
  }
  return n;
}

/** A roof counts once it has actually been generated (faces or members exist). */
function generatedRoofCount(ctx: QuestContext): number {
  let generatedMembers = 0;
  let roofs = 0;
  let facedRoofs = 0;
  for (const node of ctx.nodes) {
    if (node.type === 'roof') {
      roofs++;
      const faceCount = Number(node.properties?.face_count ?? 0);
      const memberCount = Number(node.properties?.member_count ?? 0);
      if (faceCount > 0 || memberCount > 0) facedRoofs++;
    } else if (ROOF_MEMBER.has(node.type)) {
      generatedMembers++;
    }
  }
  if (facedRoofs > 0) return facedRoofs;
  // A roof node plus any generated member also counts as "generated".
  return roofs > 0 && generatedMembers > 0 ? 1 : 0;
}

/** Grid strength: explicit axis lines (x×y intersections) or placed ax nodes. */
function gridStrength(ctx: QuestContext): number {
  const axisPts = ctx.axes.xValues.length * ctx.axes.yValues.length;
  return Math.max(axisPts, ctx.counts.ax ?? 0);
}

const STEPS: StepDef[] = [
  {
    id: 'grid', title: 'Structural grid', icon: '▦', target: 4,
    hint: 'Open Axes and define at least a 2×2 structural grid.',
    count: gridStrength,
  },
  {
    id: 'storey', title: 'Add a storey', icon: '▤', target: 1,
    hint: 'Create a storey (floor) and open its plan.',
    count: (c) => c.counts.storey ?? 0,
  },
  {
    id: 'walls', title: 'Enclose walls', icon: '▧', target: 4,
    hint: 'Draw walls by connecting them between axes — 4 make a room.',
    count: anchoredWallCount,
  },
  {
    id: 'openings', title: 'Add an opening', icon: '◫', target: 1,
    hint: 'Place a window or door onto a wall.',
    count: (c) => (c.counts.window ?? 0) + (c.counts.door ?? 0),
  },
  {
    id: 'enclosure', title: 'Floor or room', icon: '▬', target: 1,
    hint: 'Add a slab, room or covering to close the space.',
    count: (c) => [...ENCLOSURE].reduce((s, t) => s + (c.counts[t] ?? 0), 0),
  },
  {
    id: 'roof', title: 'Generate a roof', icon: '◭', target: 1,
    hint: 'Add a roof node, wire it to the outline, then Generate.',
    count: generatedRoofCount,
  },
];

/** Evaluate the "First Building" questline against the current graph. */
export function evaluateQuestline(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  axes: BuildingAxes = { xValues: [], yValues: [] },
): QuestlineProgress {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  };
  for (const e of edges) { link(e.from, e.to); link(e.to, e.from); }

  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;

  const ctx: QuestContext = { nodes, edges, axes, byId, adj, counts };

  const steps: QuestStepState[] = STEPS.map((def) => {
    const raw = Math.max(0, Math.round(def.count(ctx)));
    const current = Math.min(raw, def.target);
    return {
      id: def.id, title: def.title, hint: def.hint, icon: def.icon,
      current, target: def.target, done: raw >= def.target,
    };
  });

  const completed = steps.filter((s) => s.done).length;
  const total = steps.length;
  const nextStep = steps.find((s) => !s.done) ?? null;
  return {
    steps,
    completed,
    total,
    pct: Math.round((completed / total) * 100),
    nextStep,
    allDone: completed === total,
  };
}
