/**
 * Internal B-rep kernel — wall junction resolution.
 *
 * This is the payoff of owning the topology layer. A junction is not something
 * to be re-derived from coordinates: it is already stated in the graph, as two
 * walls wired to the same ax node. That fact drives the geometry directly.
 *
 * ## What this replaces
 * `calcWallJoins` in `bimGeometry.ts` resolves corners numerically — bisector
 * math for miters, face-line trimming for butts, with distinct code paths for
 * L-corners, T-junctions and end caps. Here every one of those is the same
 * two-step operation: the yielding wall is EXTENDED through the wall it yields
 * to, then subtracts it.
 *
 * The extension is what fills the corner. A wall whose rectangle merely stops at
 * the junction node leaves the outer quadrant of the corner empty — the two
 * strips only overlap on the inner side. Running it through first, then cutting,
 * tiles the corner completely.
 *
 * It generalises for free to cases the numeric solver handles poorly or not at
 * all: walls meeting at any angle, walls of differing thickness, and three or
 * more walls at one node.
 *
 * ## Why subtraction rather than union
 * Fusing the walls into one body would be simpler, but a wall must stay an
 * element — its own id, its own quantity, its own IFC entity. So at each
 * junction one wall wins the shared volume and the others subtract it. The
 * bodies then tile the junction exactly once (no overlap, so no z-fighting and
 * no double-counted concrete; no gap either), while each remains a separate
 * selectable, measurable, exportable `Solid`.
 *
 * That is what a butt join is — and since the union of the resolved bodies
 * equals the union of the raw ones, the outer envelope is identical to a miter.
 * Only the invisible internal division differs.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  calcWallGeometry, getConnectedNodes, isWallSeparator, parseWallThickness,
  type WallGeometry,
} from '@/lib/bimGeometry';
import type { Solid } from './types';
import { subtractSolids, type BooleanOptions } from './boolean';
import { wallSolid, type BuildOptions } from './builders';
// `openings` borrows only TYPES from this module, so this pairing is not a
// runtime cycle — the type imports are erased.
import { cutWallOpenings } from './openings';

/** One wall as a resolved body. */
export interface WallBody {
  id: string;
  node: BubbleGraphNode;
  solid: Solid;
}

/** A node where two or more walls meet, taken straight from the graph. */
export interface WallJunction {
  /** The shared endpoint node (ax or column). */
  nodeId: string;
  /** Ids of the walls wired to it. */
  wallIds: string[];
}

export type JunctionDiagCode = 'boolean_failed' | 'wall_consumed';

export interface JunctionDiagnostic {
  code: JunctionDiagCode;
  wallId: string;
  message: string;
}

/**
 * Below this |sin(angle)| two walls at a node continue straight through rather
 * than forming a corner — a straight run modelled as two segments, which is
 * ordinary and not worth reporting. Their strips already coincide, so there is
 * no corner to fill, and the extension formula (which divides by sin) would
 * otherwise run away to infinity. ~10°.
 */
const SIN_COLLINEAR = 0.174;

// ─── Junction detection ───────────────────────────────────────────────────────

/** Endpoint nodes of a wall — its ax/column anchors, excluding hosted openings. */
function wallEndpoints(
  wall: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): BubbleGraphNode[] {
  return getConnectedNodes(wall.id, edges, nodeMap).filter(
    (n) => n.type !== 'window' && n.type !== 'door',
  );
}

/**
 * Every node where two or more walls meet.
 *
 * No geometric search, no tolerance, no proximity test — walls meet exactly when
 * the graph says they share an endpoint. Two walls that merely happen to cross
 * in space are deliberately NOT a junction: the model, not the coordinates,
 * decides what is connected.
 */
export function findWallJunctions(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  nodeMap?: Map<string, BubbleGraphNode>,
): WallJunction[] {
  const map = nodeMap ?? new Map(nodes.map((n) => [n.id, n]));
  const byEndpoint = new Map<string, string[]>();

  for (const wall of nodes) {
    if (wall.type !== 'wall') continue;
    for (const ep of wallEndpoints(wall, map, edges)) {
      const list = byEndpoint.get(ep.id);
      if (list) { if (!list.includes(wall.id)) list.push(wall.id); }
      else byEndpoint.set(ep.id, [wall.id]);
    }
  }

  const out: WallJunction[] = [];
  for (const [nodeId, wallIds] of byEndpoint) {
    if (wallIds.length >= 2) out.push({ nodeId, wallIds });
  }
  return out;
}

// ─── Priority ─────────────────────────────────────────────────────────────────

/**
 * Ranking key for a wall at a junction. Compared lexicographically, higher wins.
 *
 * The ordering encodes the usual construction reading: a load-bearing wall runs
 * through and a partition butts into it. `id` is the final tiebreak purely so
 * the result is deterministic — geometry that changes between runs on equal
 * input is worse than any particular choice of winner.
 */
export interface WallPriority {
  /** `join_priority` / `joinPriority` property. Separators default to −1. */
  explicit: number;
  /** Wall thickness (mm) — the thicker wall runs through. */
  thickness: number;
  /** Centre-line length (mm) — at a T, the chord beats the stem. */
  length: number;
  id: string;
}

export function wallPriority(
  wall: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  geom?: WallGeometry | null,
): WallPriority {
  const type = String(wall.properties.wall_type ?? 'W20');
  const raw = wall.properties.joinPriority ?? wall.properties.join_priority;
  const explicit = raw != null ? Number(raw) : (isWallSeparator(type) ? -1 : 0);

  const g = geom ?? (wallEndpoints(wall, nodeMap, edges).length >= 2
    ? calcWallGeometry(wall, nodeMap, edges)
    : null);
  const length = g ? Math.hypot(g.exM - g.sxM, g.ezM - g.szM) * 1000 : 0;

  return {
    explicit: Number.isFinite(explicit) ? explicit : 0,
    thickness: parseWallThickness(type) * 1000,
    length,
    id: wall.id,
  };
}

/** Positive when `a` outranks `b`. */
export function compareWallPriority(a: WallPriority, b: WallPriority): number {
  if (a.explicit !== b.explicit) return a.explicit - b.explicit;
  if (Math.abs(a.thickness - b.thickness) > 1e-6) return a.thickness - b.thickness;
  if (Math.abs(a.length - b.length) > 1e-6) return a.length - b.length;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ─── Resolution ───────────────────────────────────────────────────────────────

export interface ResolveOptions extends BooleanOptions {
  /** Override the default ranking. Positive result = `a` wins the shared volume. */
  priority?: (a: BubbleGraphNode, b: BubbleGraphNode) => number;
}

export interface ResolveResult {
  bodies: WallBody[];
  diagnostics: JunctionDiagnostic[];
}

// ─── Junction planning ────────────────────────────────────────────────────────

/** A wall's effective centre-line in BIM mm, with its unit direction. */
interface WallAxis {
  sx: number; sy: number;
  ex: number; ey: number;
  ux: number; uy: number;
  halfThickness: number;
}

/**
 * Centre-line of a wall, read back from `calcWallGeometry`.
 *
 * That function reports the span in metres on THREE's XZ axes (`sxM`/`szM`), so
 * the conversion back to BIM mm (north = −z) happens here, once.
 */
function wallAxisOf(
  wall: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  geom?: WallGeometry | null,
): WallAxis | null {
  const g = geom ?? calcWallGeometry(wall, nodeMap, edges);
  if (!g) return null;
  const sx = g.sxM * 1000, sy = -g.szM * 1000;
  const ex = g.exM * 1000, ey = -g.ezM * 1000;
  const dx = ex - sx, dy = ey - sy;
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return null;
  return { sx, sy, ex, ey, ux: dx / l, uy: dy / l, halfThickness: (g.wallThick * 1000) / 2 };
}

/** How far each end of each wall must run past its junction node. */
export interface WallExtensions {
  start: number;
  end: number;
}

interface JunctionPlan {
  extensions: Map<string, WallExtensions>;
  /** wallId → ids of the walls it must subtract. */
  yieldsTo: Map<string, Set<string>>;
  diagnostics: JunctionDiagnostic[];
}

/**
 * Decide, for every junction, who wins and how far the losers must reach.
 *
 * A yielding wall must cross the winner's full slab before it can subtract it.
 * Travelling along its own axis at angle φ to the winner's, it closes the
 * winner's half-thickness `h` at a rate of `sin φ`, so the reach is `h / sin φ`
 * — the same quantity a miter solver computes as a corner point, but expressed
 * as a scalar, which is what makes it work unchanged for three or more walls at
 * one node.
 *
 * Near-collinear walls are exempt: they continue straight through, their strips
 * already coincide, and there is no corner to fill.
 */
function planJunctions(
  walls: BubbleGraphNode[],
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  junctions: WallJunction[],
  geoms: Map<string, WallGeometry>,
  opts: ResolveOptions,
): JunctionPlan {
  const byId = new Map(walls.map((w) => [w.id, w]));
  const axes = new Map<string, WallAxis>();
  for (const w of walls) {
    const a = wallAxisOf(w, nodeMap, edges, geoms.get(w.id));
    if (a) axes.set(w.id, a);
  }

  const ranks = new Map<string, WallPriority>();
  const rankOf = (id: string): WallPriority => {
    let p = ranks.get(id);
    if (!p) { p = wallPriority(byId.get(id)!, nodeMap, edges, geoms.get(id)); ranks.set(id, p); }
    return p;
  };
  const outranks = (a: string, b: string): boolean =>
    (opts.priority
      ? opts.priority(byId.get(a)!, byId.get(b)!)
      : compareWallPriority(rankOf(a), rankOf(b))) > 0;

  const extensions = new Map<string, WallExtensions>();
  const yieldsTo = new Map<string, Set<string>>();
  const diagnostics: JunctionDiagnostic[] = [];

  /** Which end of `wallId` sits on `nodeId` — start or end. */
  const endAt = (wallId: string, nodeId: string): 'start' | 'end' | null => {
    const eps = wallEndpoints(byId.get(wallId)!, nodeMap, edges);
    if (eps[0]?.id === nodeId) return 'start';
    if (eps[1]?.id === nodeId) return 'end';
    return null;
  };

  for (const j of junctions) {
    const present = j.wallIds.filter((id) => byId.has(id) && axes.has(id));

    for (const loser of present) {
      const which = endAt(loser, j.nodeId);
      if (!which) continue;
      const la = axes.get(loser)!;
      // Direction the loser travels AWAY from this node.
      const lx = which === 'start' ? la.ux : -la.ux;
      const ly = which === 'start' ? la.uy : -la.uy;

      for (const winner of present) {
        if (winner === loser || !outranks(winner, loser)) continue;

        const wa = axes.get(winner)!;
        const wWhich = endAt(winner, j.nodeId);
        const wx = wWhich === 'end' ? -wa.ux : wa.ux;
        const wy = wWhich === 'end' ? -wa.uy : wa.uy;

        const sin = Math.abs(lx * wy - ly * wx);
        if (sin >= SIN_COLLINEAR) {
          const cur = extensions.get(loser) ?? { start: 0, end: 0 };
          cur[which] = Math.max(cur[which], wa.halfThickness / sin);
          extensions.set(loser, cur);
        }
        // Still yield even when collinear: same-thickness segments merely touch,
        // but segments of differing thickness genuinely overlap and must be cut.

        const s = yieldsTo.get(loser) ?? new Set<string>();
        s.add(winner);
        yieldsTo.set(loser, s);
      }
    }
  }

  return { extensions, yieldsTo, diagnostics };
}

/**
 * Make junction-sharing wall bodies disjoint.
 *
 * Each wall subtracts every higher-ranked wall it shares a junction with, in one
 * boolean call. Crucially the subtrahends are the ORIGINAL bodies, not already
 * resolved ones: with A > B > C, that yields A, B−A and C−A−B, whose union is
 * exactly A ∪ B ∪ C and whose pairwise intersections are all empty. Subtracting
 * resolved bodies instead would reopen the overlap between B and C.
 *
 * A failed boolean leaves that wall untouched and is reported — an overlapping
 * corner is a far better outcome than a missing wall, and silence here would
 * hide a real modelling problem.
 */
export function resolveWallJunctions(
  bodies: WallBody[],
  yieldsTo: Map<string, Set<string>>,
  opts: ResolveOptions = {},
): ResolveResult {
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const diagnostics: JunctionDiagnostic[] = [];

  const out: WallBody[] = bodies.map((body) => {
    const winners = [...(yieldsTo.get(body.id) ?? [])].filter((id) => byId.has(id)).sort();
    if (winners.length === 0) return body;

    const { solid, error } = subtractSolids(body.solid, winners.map((id) => byId.get(id)!.solid), opts);
    if (!solid) {
      diagnostics.push({
        code: error?.includes('empty') ? 'wall_consumed' : 'boolean_failed',
        wallId: body.id,
        message: `Junction resolution for "${body.node.name || body.id}" failed (${error}); keeping the extended body.`,
      });
      return body;
    }
    return { ...body, solid };
  });

  return { bodies: out, diagnostics };
}

// ─── Scene-level entry point ──────────────────────────────────────────────────

export interface BuildWallsOptions extends ResolveOptions, BuildOptions {
  /** Punch window/door voids out of the resolved bodies. Default true. */
  cutOpenings?: boolean;
}

/**
 * Build every wall in the model as a junction-resolved, opening-punched solid.
 *
 * Walls are built WITHOUT a join map, so `calcWallGeometry` yields plain
 * rectangles on the raw centre-line; the corner geometry comes from the
 * extend-then-subtract pass instead of from the numeric join solver.
 *
 * The three stages run in this order for a reason: junctions before openings, so
 * the corner booleans work on simple prisms rather than on bodies already
 * riddled with holes.
 *
 * Requires `ensureBooleanEngine()` to have resolved.
 */
export function buildWallSolids(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  opts: BuildWallsOptions = {},
): ResolveResult {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const walls = nodes.filter((n) => n.type === 'wall');

  // One wall-geometry solve per wall, shared by planning, building and openings.
  const geoms = new Map<string, WallGeometry>();
  for (const w of walls) {
    const g = calcWallGeometry(w, nodeMap, edges);
    if (g) geoms.set(w.id, g);
  }

  const junctions = findWallJunctions(nodes, edges, nodeMap);
  const plan = planJunctions(walls, nodeMap, edges, junctions, geoms, opts);

  const bodies: WallBody[] = [];
  for (const node of walls) {
    const ext = plan.extensions.get(node.id);
    const solid = wallSolid(node, nodeMap, edges, undefined, {
      ...opts,
      extendStart: ext?.start ?? 0,
      extendEnd: ext?.end ?? 0,
    }, geoms.get(node.id));
    if (solid) bodies.push({ id: node.id, node, solid });
  }

  const resolved = resolveWallJunctions(bodies, plan.yieldsTo, opts);
  if (opts.cutOpenings === false) {
    return {
      bodies: resolved.bodies,
      diagnostics: [...plan.diagnostics, ...resolved.diagnostics],
    };
  }

  const punched = cutWallOpenings(resolved.bodies, nodeMap, edges, geoms, opts);
  return {
    bodies: punched.bodies,
    diagnostics: [...plan.diagnostics, ...resolved.diagnostics, ...punched.diagnostics],
  };
}
