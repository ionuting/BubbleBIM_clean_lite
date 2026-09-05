/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * edgeTypes.ts — relation semantics for bubble-graph edges.
 *
 * WHY THIS EXISTS
 * ---------------
 * A `BubbleGraphEdge` used to be pure adjacency: `{id, from, to}`. What a
 * given edge MEANT was re-derived at every read site from the node types at
 * its ends, e.g.
 *
 *     getConnectedNodes(n.id, edges, nodeMap).filter((c) => c.type === 'ax')
 *
 * — repeated (and free to drift) across the takeoff, FEM, IFC and drawing
 * engines. That works for one model but makes the graph unmineable: you
 * cannot query relations that are only implied by a filter somewhere.
 *
 * This module makes the relation explicit and gives ONE place where the
 * legacy inference lives, so old projects keep working untouched.
 *
 * BACKWARDS COMPATIBILITY
 * -----------------------
 * `BubbleGraphEdge.type` is OPTIONAL. Nothing may require it. Existing saved
 * graphs (and hand-authored .bbim files) carry no type at all, so
 * `resolveEdgeType()` falls back to `inferEdgeType()` — the same heuristic
 * the read sites used, in one place. `annotateEdgeTypes()` backfills a whole
 * edge list at load time so new work sees typed edges immediately.
 *
 * VOCABULARY
 * ----------
 * Deliberately small. Only the first three are inferable today because they
 * are the only relations the editor can currently author; the rest are
 * reserved for the process/operation layer and are never guessed — an edge
 * gets them only if something sets them explicitly.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';

export type EdgeType =
  /** Linear element ↔ its two endpoint ax/column nodes (wall, beam). */
  | 'spans'
  /** Hub element ↔ the ax corners of the polygon it covers (room, roof, slab…). */
  | 'bounds'
  /** Wall ↔ an opening it carries (window, door). */
  | 'hosts'
  /** Load-bearing relation (column under beam). Not inferred — see NOTE below. */
  | 'supports'
  /** Operation ordering, L4 process layer. Never inferred. */
  | 'precedes'
  /** Operation ↔ the element it materialises, L4 process layer. Never inferred. */
  | 'realizes';

export const EDGE_TYPES: readonly EdgeType[] = [
  'spans', 'bounds', 'hosts', 'supports', 'precedes', 'realizes',
] as const;

/** Romanian labels — the app's element/property UI is Romanian-facing. */
export const EDGE_TYPE_LABELS: Record<EdgeType, string> = {
  spans:    'Se întinde între',
  bounds:   'Delimitează',
  hosts:    'Găzduiește',
  supports: 'Reazemă pe',
  precedes: 'Precede',
  realizes: 'Materializează',
};

/**
 * Node types that define a polygon by fanning edges out to many ax corners
 * (room→ax, roof→ax, …) rather than connecting two endpoints.
 *
 * This is the canonical set — `BubbleGraphPanel`'s continuous-connect UI
 * imports it from here so the editor's idea of a hub and the graph's
 * relation semantics can never drift apart.
 */
export const HUB_TYPES: ReadonlySet<string> = new Set([
  'room', 'shell', 'roof', 'slab', 'covering', 'foundation',
]);

/** Node types that act as a geometric anchor point (an edge END, not a subject). */
const ANCHOR_TYPES: ReadonlySet<string> = new Set(['ax', 'column']);

/** Node types that are openings carried by a wall. */
const OPENING_TYPES: ReadonlySet<string> = new Set(['window', 'door']);

/** Linear elements anchored on ax/column endpoints (a sweep takes 1..N). */
const LINEAR_TYPES: ReadonlySet<string> = new Set(['wall', 'beam', 'sweep']);

/**
 * Classify an untyped edge from the node types at its ends.
 *
 * Direction-agnostic: callers store edges in whichever order the user drew
 * them, and every existing read site already normalises direction itself
 * (see `getConnectedNodes`). The relation is a property of the PAIR.
 *
 * NOTE on 'supports': not inferred. A column and a beam sharing an edge in
 * this model means "the beam ends here", which is `spans` — whether the
 * column actually carries it is a structural question `buildFemModel`
 * answers geometrically (by plan position), not a topological one. Guessing
 * `supports` here would put a claim into the data that the data doesn't
 * support.
 *
 * Returns undefined when the pair matches no known relation — an untyped
 * edge stays untyped rather than being forced into a wrong bucket.
 */
export function inferEdgeType(
  a: BubbleGraphNode | undefined,
  b: BubbleGraphNode | undefined,
): EdgeType | undefined {
  if (!a || !b) return undefined;

  // wall ↔ window/door
  if ((a.type === 'wall' && OPENING_TYPES.has(b.type)) ||
      (b.type === 'wall' && OPENING_TYPES.has(a.type))) {
    return 'hosts';
  }

  // hub ↔ ax corner
  if ((HUB_TYPES.has(a.type) && ANCHOR_TYPES.has(b.type)) ||
      (HUB_TYPES.has(b.type) && ANCHOR_TYPES.has(a.type))) {
    return 'bounds';
  }

  // linear element ↔ endpoint
  if ((LINEAR_TYPES.has(a.type) && ANCHOR_TYPES.has(b.type)) ||
      (LINEAR_TYPES.has(b.type) && ANCHOR_TYPES.has(a.type))) {
    return 'spans';
  }

  return undefined;
}

/** The edge's explicit type if it has one, otherwise the inferred one. */
export function resolveEdgeType(
  edge: BubbleGraphEdge,
  nodeMap: Map<string, BubbleGraphNode>,
): EdgeType | undefined {
  return edge.type ?? inferEdgeType(nodeMap.get(edge.from), nodeMap.get(edge.to));
}

/**
 * Backfill `type` on every edge that lacks one. Used at load time so a graph
 * saved before edge types existed becomes typed without the user doing
 * anything.
 *
 * Returns a NEW array only when something actually changed, so callers can
 * skip a state update (and the auto-save it would trigger) on an already
 * annotated graph.
 */
export function annotateEdgeTypes(
  edges: BubbleGraphEdge[],
  nodes: BubbleGraphNode[],
): BubbleGraphEdge[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  let changed = false;
  const next = edges.map((e) => {
    if (e.type) return e;
    const inferred = inferEdgeType(nodeMap.get(e.from), nodeMap.get(e.to));
    if (!inferred) return e;
    changed = true;
    return { ...e, type: inferred };
  });
  return changed ? next : edges;
}

/**
 * Edges of one relation type touching `nodeId`, with the OTHER end resolved.
 *
 * The query the read sites actually want — "the ax nodes this wall spans
 * between" — expressed once, against relations instead of node-type filters.
 */
export function relatedBy(
  nodeId: string,
  type: EdgeType,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): BubbleGraphNode[] {
  const out: BubbleGraphNode[] = [];
  for (const e of edges) {
    if (e.from !== nodeId && e.to !== nodeId) continue;
    if (resolveEdgeType(e, nodeMap) !== type) continue;
    const other = nodeMap.get(e.from === nodeId ? e.to : e.from);
    if (other) out.push(other);
  }
  return out;
}
