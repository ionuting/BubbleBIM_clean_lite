/**
 * buildFemModel.ts — converts a slice of the bubble-graph (one storey, OR
 * every storey stacked — see `storeyId: 'all'` below) into the plain-array
 * input shape `@awatif/components`' linear solver expects
 * (`getPositionsAndForces` / `getReactions` from `analysis/l-solver/*`).
 *
 * Scope of this pass:
 *   - Columns: `ax` nodes with `has_column: true` AND standalone `column`
 *     nodes. Both become a vertical frame member from the storey base to its
 *     top. At the BUILDING's ground storey (or in single-storey mode) the
 *     base is fully fixed (no foundation/soil stiffness modelled). In
 *     `'all'` (whole-building) mode, a column whose (x, y) plan position
 *     matches a column top in the storey directly below instead reuses that
 *     node — real moment/shear continuity up the building, not a fresh
 *     support at every floor. A column with nothing below it (e.g. one that
 *     only starts at an upper floor) falls back to a fixed base at its own
 *     storey — see "Multi-storey stacking" below.
 *   - Beams: connect the TOP of two column members. A beam whose end lacks a
 *     column is skipped (nothing to frame into yet).
 *   - Walls / slabs: modelled as 3-node shell elements (see
 *     buildShellElements.ts) — flat vertical panels for walls; for slabs,
 *     either a room's floor polygon (skipped when that room has
 *     `has_slab: false`) or a standalone `slab` node's own polygon. Wherever
 *     a wall/slab corner coincides with a column, it reuses that column's
 *     FEM node (real shared-DOF frame action); corners with no column get a
 *     placeholder support instead (see that file's header for the exact
 *     boundary-condition choice). A room's slab also carries its usage-
 *     category imposed load (femLoads.ts) on top of self-weight.
 *   - Self-weight (+ room live loads on slabs) only. Every frame member is
 *     subdivided into `divisions` sub-elements (mirrors
 *     `@awatif/components`'s own `lineMesh` + `getLoads` convention — see
 *     that package's `mesh/line-mesh/lineMesh.ts` and `loads/getLoads.ts`)
 *     so its weight lands as consistent nodal loads along the span instead
 *     of only at the two endpoints; a single 2-node element under end-only
 *     point loads can never show span bending.
 *   - No wind loads, no load cases/combinations — dead self-weight + one
 *     live-load category per room, both always-on, no factored combinations.
 *
 * Coordinate system: metres, Z-up, gravity acts in -Z — matching this repo's
 * BIM convention (see bimGeometry.ts header) and the solver's SI unit
 * expectations.
 *
 * ── Multi-storey stacking (storeyId: 'all') ────────────────────────────────
 * Pass the literal string `'all'` instead of a specific storey id to build
 * every storey in the graph in ONE model, stacked at their real elevations
 * (baseZ = storey.bottomElevation − lowest storey's bottomElevation, so the
 * whole building still sits with its ground floor at z ≈ 0) — the same
 * "whole building" the 3D viewers already render, rather than one floor in
 * isolation. Column continuity between storeys is inferred geometrically: a
 * column's (x, y) plan position is matched (1mm rounding) against the
 * storey directly below's column TOP nodes; graph node ids are NOT compared,
 * since each storey owns its own independent `ax`/`column` nodes (there is
 * no cross-storey node linkage in the graph itself — see bimGeometry.ts's
 * `getAxRealPos`). Only the very base of the whole stack (or any column with
 * no match below it) gets a fixed support; every other storey boundary is a
 * real continuous frame joint. Walls/slabs are unaffected beyond using their
 * own storey's real baseZ/topZ — they still anchor into whatever columns
 * exist at THAT storey via the same per-storey `columnNodeIndex` entries.
 * A plain storey id still behaves exactly as before (baseZ = 0, single
 * floor, fully fixed bases) — this is purely additive.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  getNodeBimPos,
  getConnectedNodes,
  parseColumnDims,
  parseBeamDims,
  MM,
} from '@/lib/bimGeometry';
import {
  rectSectionProps,
  circularSectionProps,
  frameElementProps,
  CONCRETE_DENSITY_KG_M3,
  GRAVITY_ACCEL,
  type SectionProps,
  type FemElementProps,
} from './femSections';
import { addWallShell, addSlabShell } from './buildShellElements';

// ─── Awatif-shaped output types ───────────────────────────────────────────
// Mirrors `Mesh["nodes"]["val"]` etc. from `@awatif/components/data-model` —
// duplicated here (not imported) so this file has no hard runtime dependency
// on the package's internal module layout.

export type FemNodes = number[][]; // [[x,y,z], ...] metres
export type FemElements = number[][]; // [[a,b], ...] frame or [[a,b,c], ...] shell
export type FemElementPropsMap = Map<number, FemElementProps>;
export type FemSupports = Map<number, [boolean, boolean, boolean, boolean, boolean, boolean]>;
export type FemLoads = Map<number, [number, number, number, number, number, number]>;

export type ElementKind = 'column' | 'beam' | 'wall' | 'slab';
export interface ElementMetaEntry { sourceNodeId: string; kind: ElementKind }

export interface FemModel {
  nodes: FemNodes;
  elements: FemElements;
  elementsProps: FemElementPropsMap;
  supports: FemSupports;
  loads: FemLoads;
  /** FEM node index of the column base / top for each source column-bearing node id (`ax` or `column`). */
  columnNodeIndex: Map<string, { base: number; top: number }>;
  /** Source graph node id + kind for each FEM element index (for result traceback). */
  elementMeta: ElementMetaEntry[];
}

export interface FemModelOptions {
  /** Sub-elements per column/beam span — higher = smoother bending diagram under self-weight. Default 4. */
  divisions?: number;
  /** Model walls as shell elements. Default true. */
  includeWalls?: boolean;
  /** Model rooms as slab shell elements at the storey top. Default true. */
  includeSlabs?: boolean;
}

/** Mutable build state shared by frame and shell assembly — see buildShellElements.ts. */
export interface FemAccumulators {
  nodes: FemNodes;
  elements: FemElements;
  elementsProps: FemElementPropsMap;
  supports: FemSupports;
  loads: FemLoads;
  elementMeta: ElementMetaEntry[];
  pushNode(pt: number[]): number;
  pushElement(...nodeIndices: number[]): number;
  addLoad(nodeIdx: number, delta: [number, number, number, number, number, number]): void;
  fixNode(nodeIdx: number): void;
}

function createAccumulators(): FemAccumulators {
  const nodes: FemNodes = [];
  const elements: FemElements = [];
  const elementsProps: FemElementPropsMap = new Map();
  const supports: FemSupports = new Map();
  const loads: FemLoads = new Map();
  const elementMeta: ElementMetaEntry[] = [];

  return {
    nodes, elements, elementsProps, supports, loads, elementMeta,
    pushNode: (pt) => nodes.push(pt) - 1,
    pushElement: (...idx) => elements.push(idx) - 1,
    addLoad: (nodeIdx, delta) => {
      const cur = loads.get(nodeIdx) ?? [0, 0, 0, 0, 0, 0];
      loads.set(nodeIdx, cur.map((v, i) => v + delta[i]) as typeof cur);
    },
    fixNode: (nodeIdx) => supports.set(nodeIdx, [true, true, true, true, true, true]),
  };
}

function sectionForColumn(columnType: string): SectionProps {
  const { w, d, circular } = parseColumnDims(columnType);
  return circular ? circularSectionProps(w / 2) : rectSectionProps(w, d);
}

function sectionForBeam(beamSection: string): SectionProps {
  const { bw, bh } = parseBeamDims(beamSection);
  return rectSectionProps(bw, bh);
}

function dist3(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function lerp3(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Add a frame member between two already-created nodes, subdivided into
 * `divisions` sub-elements, with self-weight lumped consistently along the
 * span (w·L/2 to each sub-node, accumulated — same convention Awatif itself
 * uses for a meshed line under a distributed load).
 */
export function addFrameMember(
  acc: FemAccumulators,
  startIdx: number,
  endIdx: number,
  sec: SectionProps,
  divisions: number,
  meta: ElementMetaEntry,
): number[] {
  const pStart = acc.nodes[startIdx];
  const pEnd = acc.nodes[endIdx];
  const n = Math.max(1, Math.round(divisions));

  const chain = [startIdx];
  for (let i = 1; i < n; i++) {
    chain.push(acc.pushNode(lerp3(pStart, pEnd, i / n)));
  }
  chain.push(endIdx);

  const totalLen = dist3(pStart, pEnd);
  const subLen = totalLen / n;
  const weightPerLength = sec.area * CONCRETE_DENSITY_KG_M3 * GRAVITY_ACCEL; // N/m
  const subWeight = weightPerLength * subLen; // N

  const props = frameElementProps(sec);
  const elIdxs: number[] = [];
  for (let i = 0; i < n; i++) {
    const elIdx = acc.pushElement(chain[i], chain[i + 1]);
    acc.elementsProps.set(elIdx, props);
    acc.elementMeta.push(meta);
    elIdxs.push(elIdx);
    acc.addLoad(chain[i], [0, 0, -subWeight / 2, 0, 0, 0]);
    acc.addLoad(chain[i + 1], [0, 0, -subWeight / 2, 0, 0, 0]);
  }
  return elIdxs;
}

/** Rounds an (x, y) metre position to a 1mm-tolerance key for cross-storey column matching. */
function posKey(x: number, y: number): string {
  return `${Math.round(x * 1000)}:${Math.round(y * 1000)}`;
}

/**
 * Build one storey's columns/beams/walls/slabs into the shared accumulator.
 *
 * `prevColumnTops` — when building storey N in `'all'` mode, the (x,y)-keyed
 * top-node map storey N−1 just produced; a column here whose plan position
 * matches reuses that node as ITS base (real continuity) instead of getting
 * a fresh fixed support. `undefined` in single-storey mode (every base is
 * fixed, as before — this parameter is purely additive).
 *
 * Returns this storey's own (x,y)-keyed column-top map, for the NEXT storey
 * up to consume the same way.
 */
function buildStorey(
  acc: FemAccumulators,
  columnNodeIndex: Map<string, { base: number; top: number }>,
  allNodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
  storeyId: string,
  baseZ: number,
  topZ: number,
  options: Required<Pick<FemModelOptions, 'divisions' | 'includeWalls' | 'includeSlabs'>>,
  prevColumnTops: Map<string, { idx: number; x: number; y: number }> | undefined,
): Map<string, { idx: number; x: number; y: number }> {
  const { divisions, includeWalls, includeSlabs } = options;
  const storeyNodes = allNodes.filter((n) => n.parentId === storeyId);
  const thisColumnTops = new Map<string, { idx: number; x: number; y: number }>();

  // ── Columns: `ax` nodes with has_column: true, and standalone `column` nodes ──
  for (const n of storeyNodes) {
    const isGridColumn = n.type === 'ax' && String(n.properties.has_column ?? '').toLowerCase() === 'true';
    const isStandaloneColumn = n.type === 'column';
    if (!isGridColumn && !isStandaloneColumn) continue;

    const pos = getNodeBimPos(n, nodeMap); // mm
    const x = pos.x * MM;
    const y = pos.y * MM;
    const key = posKey(x, y);

    // Continue from the matching column top in the storey below (real frame
    // continuity), or start fresh with a fixed base (ground storey, single-
    // storey mode, or a column with nothing below it at this plan position).
    const below = prevColumnTops?.get(key);
    const baseIdx = below ? below.idx : acc.pushNode([x, y, baseZ]);
    if (!below) acc.fixNode(baseIdx);

    const topIdx = acc.pushNode([x, y, topZ]);
    columnNodeIndex.set(n.id, { base: baseIdx, top: topIdx });
    thisColumnTops.set(key, { idx: topIdx, x, y });

    const columnType = String(n.properties.column_type ?? 'C25x25');
    const sec = sectionForColumn(columnType);
    addFrameMember(acc, baseIdx, topIdx, sec, divisions, { sourceNodeId: n.id, kind: 'column' });
  }

  // ── Beams: connect the TOP node of each end column ────────────────────────
  for (const n of storeyNodes) {
    if (n.type !== 'beam') continue;
    const ends = getConnectedNodes(n.id, edges, nodeMap).filter((c) => c.type === 'ax' || c.type === 'column');
    if (ends.length < 2) continue;

    const topA = columnNodeIndex.get(ends[0].id)?.top;
    const topB = columnNodeIndex.get(ends[1].id)?.top;
    if (topA == null || topB == null) continue; // both ends need a column in this spike

    const sec = sectionForBeam(String(n.properties.beam_section ?? 'B20x30'));
    addFrameMember(acc, topA, topB, sec, divisions, { sourceNodeId: n.id, kind: 'beam' });
  }

  // ── Shells: walls (vertical panels) + slabs (room polygon or standalone `slab` node, at storey top) ──
  if (includeWalls) {
    for (const n of storeyNodes) {
      if (n.type === 'wall') addWallShell(acc, n, nodeMap, edges, columnNodeIndex, baseZ, topZ);
    }
  }
  if (includeSlabs) {
    for (const n of storeyNodes) {
      if (n.type === 'slab') {
        addSlabShell(acc, n, nodeMap, edges, columnNodeIndex, topZ);
      } else if (n.type === 'room') {
        const hasSlab = n.properties.has_slab !== 'False' && n.properties.has_slab !== false;
        if (hasSlab) addSlabShell(acc, n, nodeMap, edges, columnNodeIndex, topZ);
      }
    }
  }

  return thisColumnTops;
}

/**
 * Build a FEM model (frame + shell) for one storey, or for the whole
 * building stacked at real storey elevations — see the "Multi-storey
 * stacking" note in this file's header.
 *
 * @param allNodes  Full bubble-graph node list (any storey — filtered internally).
 * @param edges     Full bubble-graph edge list.
 * @param storeyId  Id of the `storey` node to build a model for, OR the
 *                  literal string `'all'` to stack every storey in the graph.
 */
export function buildFemModel(
  allNodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  storeyId: string,
  options: FemModelOptions = {},
): FemModel {
  const { divisions = 4, includeWalls = true, includeSlabs = true } = options;
  const storeyOptions = { divisions, includeWalls, includeSlabs };

  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
  const acc = createAccumulators();
  const columnNodeIndex = new Map<string, { base: number; top: number }>();

  if (storeyId === 'all') {
    const storeys = allNodes
      .filter((n) => n.type === 'storey')
      .slice()
      .sort((a, b) => Number(a.properties.bottomElevation ?? 0) - Number(b.properties.bottomElevation ?? 0));
    if (storeys.length === 0) throw new Error('buildFemModel: no storeys found in the graph');

    const lowestBottomMm = Number(storeys[0].properties.bottomElevation ?? 0);
    let prevColumnTops: Map<string, { idx: number; x: number; y: number }> | undefined;

    for (const storey of storeys) {
      const bottomMm = Number(storey.properties.bottomElevation ?? 0);
      const topMm = Number(storey.properties.topElevation ?? 3000);
      const baseZ = (bottomMm - lowestBottomMm) * MM;
      const topZ = baseZ + Math.max(0, (topMm - bottomMm) * MM);

      prevColumnTops = buildStorey(
        acc, columnNodeIndex, allNodes, edges, nodeMap, storey.id, baseZ, topZ, storeyOptions, prevColumnTops,
      );
    }
  } else {
    const storey = nodeMap.get(storeyId);
    if (!storey || storey.type !== 'storey') {
      throw new Error(`buildFemModel: storey "${storeyId}" not found`);
    }
    const bottomMm = Number(storey.properties.bottomElevation ?? 0);
    const topMm = Number(storey.properties.topElevation ?? 3000);
    const baseZ = 0;
    const topZ = Math.max(0, (topMm - bottomMm) * MM);

    buildStorey(acc, columnNodeIndex, allNodes, edges, nodeMap, storeyId, baseZ, topZ, storeyOptions, undefined);
  }

  return {
    nodes: acc.nodes,
    elements: acc.elements,
    elementsProps: acc.elementsProps,
    supports: acc.supports,
    loads: acc.loads,
    columnNodeIndex,
    elementMeta: acc.elementMeta,
  };
}
