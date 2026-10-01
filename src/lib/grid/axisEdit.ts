/**
 * axisEdit.ts — the pure write path behind the graph editor's Grid mode.
 *
 * A storey's grid is `properties.axesX/axesY` (mm, kept sorted) and its `ax`
 * children, whose `gridX/gridY` index that sorted list. The ax node's canvas
 * `x/y` is only a CACHE of `storey.x + (axesX[gridX] − maxX/2)`; every edit
 * here rewrites that cache, because the stair auto-regeneration fingerprints
 * it and the canvas draws from it.
 *
 * Four edits. The first three are non-destructive (no node is created, deleted
 * or renamed, unlike `handleRegenerateStoreyAxes`, which the axis dialogs keep
 * using); `stepCellEdge` is the one that changes topology:
 *
 *   moveAxis        one value changes; the two neighbouring cells resize.
 *   setSpan         the distance between axis i and i+1 is set; by default all
 *                   axes after it translate (a spacing list), or only i+1 moves.
 *   detachCellEdge  the two grid points on one cell edge leave their axis by a
 *                   relative offset (`ax_dx_mm` / `ax_dy_mm`) — Hypar's
 *                   "extend a cell". The axis stays straight for everyone else.
 *   stepCellEdge    the envelope steps: a NEW axis is inserted at the offset,
 *                   the run's points move onto it, and any corner that would
 *                   otherwise go oblique is SPLIT in two — the original point
 *                   stays on the old axis for its other neighbours, a new point
 *                   joins the new axis, and a wall cloned from the dragged one
 *                   closes the jog. This is the cell-complex edit: it re-keys
 *                   `gridX`/`gridY` for the whole storey and rewires edges.
 *
 * Scope: an edit applies to the storeys `resolveScope` returns — by default
 * every storey sharing the value at that index, so columns keep stacking.
 *
 * Invariants kept: a drag never crosses a neighbouring axis (`GRID_MIN_GAP_MM`),
 * because `gridX` indexes a SORTED array and crossing would silently re-key a
 * whole column of the model; axes are always written as a fresh sorted array.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { getAxRealPos } from '@/lib/bimGeometry';
import { parseAxes } from '@/lib/utils';

export type Axis = 'x' | 'y';
export type GridScope = 'linked' | 'single';
export type SpanEditMode = 'downstream' | 'neighbour';

export interface Pt { x: number; y: number }

/** Canvas px per BIM mm on the graph canvas (the panel's `MM_TO_PX`). */
export const MM_TO_PX = 0.05;
/** Two axes may never come closer than this (mm). */
export const GRID_MIN_GAP_MM = 100;
/** Drag results are rounded to this (mm). */
export const GRID_SNAP_MM = 10;
export const DEFAULT_SPAN_EDIT_MODE: SpanEditMode = 'downstream';

const EPS = 0.5;

export const roundToSnap = (mm: number, snap = GRID_SNAP_MM): number => Math.round(mm / snap) * snap;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const axesKey = (axis: Axis) => (axis === 'x' ? 'axesX' : 'axesY');
const offsetKey = (axis: Axis) => (axis === 'x' ? 'ax_dx_mm' : 'ax_dy_mm');
const gridKey = (axis: Axis) => (axis === 'x' ? 'gridX' : 'gridY');

/** The storey's axes along one direction, sorted ascending (fresh array). */
export function sortedAxes(storey: BubbleGraphNode, axis: Axis): number[] {
  return parseAxes(storey.properties[axesKey(axis)]).sort((a, b) => a - b);
}

// ─── Canvas ↔ BIM ─────────────────────────────────────────────────────────────

/** Where a storey's BIM origin sits on the graph canvas (canvas mm). */
export interface StoreyFrame { ox: number; oy: number; maxX: number; maxY: number }

export function storeyFrame(storey: BubbleGraphNode): StoreyFrame {
  const xs = sortedAxes(storey, 'x');
  const ys = sortedAxes(storey, 'y');
  const maxX = xs[xs.length - 1] ?? 0;
  const maxY = ys[ys.length - 1] ?? 0;
  return { ox: storey.x - maxX / 2, oy: storey.y - maxY / 2, maxX, maxY };
}

export const bimToCanvas = (f: StoreyFrame, p: Pt): Pt => ({ x: f.ox + p.x, y: f.oy + p.y });
export const canvasToBim = (f: StoreyFrame, p: Pt): Pt => ({ x: p.x - f.ox, y: p.y - f.oy });

/**
 * The ONE cache formula: canvas position of an ax node given its storey.
 * Goes through `getAxRealPos`, so free points (bimX/bimY) and detached grid
 * points (ax_dx_mm) land exactly where the plan and 3D views put them.
 */
export function axCanvasPos(ax: BubbleGraphNode, storey: BubbleGraphNode): Pt {
  const bim = getAxRealPos(ax, new Map([[storey.id, storey]]));
  return bimToCanvas(storeyFrame(storey), bim);
}

// ─── Scope and bounds ─────────────────────────────────────────────────────────

function storeyOf(nodes: BubbleGraphNode[], id: string): BubbleGraphNode | undefined {
  const s = nodes.find((n) => n.id === id);
  return s && s.type === 'storey' ? s : undefined;
}

function axAt(nodes: BubbleGraphNode[], storeyId: string, gx: number, gy: number): BubbleGraphNode | undefined {
  return nodes.find((n) =>
    n.type === 'ax' && n.parentId === storeyId &&
    Number(n.properties.gridX) === gx && Number(n.properties.gridY) === gy &&
    n.properties.bimX == null);
}

/**
 * Storeys whose sorted axis list has the same value as `storeyId` at `index`
 * (and at `alsoMatchIndex` when given). The source storey is always first.
 */
export function linkedStoreys(
  nodes: BubbleGraphNode[],
  storeyId: string,
  axis: Axis,
  index: number,
  opts: { alsoMatchIndex?: number; requireAxNodes?: Array<{ gx: number; gy: number }> } = {},
): string[] {
  const src = storeyOf(nodes, storeyId);
  if (!src) return [];
  const ref = sortedAxes(src, axis);
  const want = ref[index];
  if (want === undefined) return [];
  const want2 = opts.alsoMatchIndex !== undefined ? ref[opts.alsoMatchIndex] : undefined;
  const out: string[] = [];
  for (const s of nodes) {
    if (s.type !== 'storey') continue;
    const axes = sortedAxes(s, axis);
    if (axes[index] === undefined || Math.abs(axes[index] - want) > EPS) continue;
    if (want2 !== undefined) {
      const v2 = axes[opts.alsoMatchIndex!];
      if (v2 === undefined || Math.abs(v2 - want2) > EPS) continue;
    }
    if (opts.requireAxNodes && !opts.requireAxNodes.every((p) => axAt(nodes, s.id, p.gx, p.gy))) continue;
    out.push(s.id);
  }
  // Source first, so callers can read "the" value off it.
  return [storeyId, ...out.filter((id) => id !== storeyId)];
}

/** How far axis `index` may move (mm) without coming within `minGap` of a neighbour, over all storeys. */
export function axisDeltaBounds(
  nodes: BubbleGraphNode[],
  storeyIds: string[],
  axis: Axis,
  index: number,
  minGap = GRID_MIN_GAP_MM,
): { lo: number; hi: number } {
  let lo = -Infinity, hi = Infinity;
  for (const id of storeyIds) {
    const s = storeyOf(nodes, id);
    if (!s) continue;
    const axes = sortedAxes(s, axis);
    const v = axes[index];
    if (v === undefined) continue;
    if (index > 0) lo = Math.max(lo, axes[index - 1] + minGap - v);
    if (index < axes.length - 1) hi = Math.min(hi, axes[index + 1] - minGap - v);
  }
  return { lo, hi };
}

/** Grid points of the cell edge: axis 'x' index j, cell i → (j,i),(j,i+1); axis 'y' index i, cell j → (j,i),(j+1,i). */
export function cellEdgePoints(axis: Axis, index: number, cell: number): Array<{ gx: number; gy: number }> {
  return axis === 'x'
    ? [{ gx: index, gy: cell }, { gx: index, gy: cell + 1 }]
    : [{ gx: cell, gy: index }, { gx: cell + 1, gy: index }];
}

/** How far the two points of a cell edge may be pushed off their axis (mm), over all storeys. */
export function cellOffsetBounds(
  nodes: BubbleGraphNode[],
  storeyIds: string[],
  axis: Axis,
  index: number,
  cell: number,
  minGap = GRID_MIN_GAP_MM,
): { lo: number; hi: number } {
  let lo = -Infinity, hi = Infinity;
  const key = offsetKey(axis);
  for (const id of storeyIds) {
    const s = storeyOf(nodes, id);
    if (!s) continue;
    const axes = sortedAxes(s, axis);
    const v = axes[index];
    if (v === undefined) continue;
    for (const p of cellEdgePoints(axis, index, cell)) {
      const ax = axAt(nodes, id, p.gx, p.gy);
      if (!ax) continue;
      const cur = Number(ax.properties[key] ?? 0) || 0;
      if (index > 0) lo = Math.max(lo, axes[index - 1] + minGap - (v + cur));
      if (index < axes.length - 1) hi = Math.min(hi, axes[index + 1] - minGap - (v + cur));
    }
  }
  return { lo, hi };
}

// ─── Edits ────────────────────────────────────────────────────────────────────

export type GridEdit =
  | { kind: 'moveAxis'; storeyId: string; axis: Axis; index: number; deltaMm: number; scope: GridScope }
  | { kind: 'setSpan'; storeyId: string; axis: Axis; index: number; spanMm: number; mode: SpanEditMode; scope: GridScope }
  | { kind: 'detachCellEdge'; storeyId: string; axis: Axis; index: number; cell: number; deltaMm: number; scope: GridScope }
  | { kind: 'stepCellEdge'; storeyId: string; axis: Axis; index: number; cell: number; deltaMm: number; scope: GridScope };

/** Nodes and edges after an edit; both keep their input reference on a no-op. */
export interface GridEditResult { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] }

/** The storeys an edit applies to, source first. */
export function resolveScope(nodes: BubbleGraphNode[], edit: GridEdit): string[] {
  if (edit.scope === 'single') return storeyOf(nodes, edit.storeyId) ? [edit.storeyId] : [];
  switch (edit.kind) {
    case 'moveAxis':
      return linkedStoreys(nodes, edit.storeyId, edit.axis, edit.index);
    case 'setSpan':
      return linkedStoreys(nodes, edit.storeyId, edit.axis, edit.index,
        edit.mode === 'downstream' ? { alsoMatchIndex: edit.index + 1 } : {});
    case 'detachCellEdge':
    case 'stepCellEdge':
      return linkedStoreys(nodes, edit.storeyId, edit.axis, edit.index,
        { requireAxNodes: cellEdgePoints(edit.axis, edit.index, edit.cell) });
  }
}

/** Apply an edit. Returns the SAME arrays when nothing changes, so callers can skip a commit. */
export function applyGridEdit(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[], edit: GridEdit): GridEditResult {
  const storeyIds = resolveScope(nodes, edit);
  if (storeyIds.length === 0) return { nodes, edges };
  switch (edit.kind) {
    case 'moveAxis':
      return { nodes: moveStoreyAxis(nodes, edges, storeyIds, edit.axis, edit.index, edit.deltaMm), edges };
    case 'setSpan':
      return { nodes: setAxisSpan(nodes, edges, storeyIds, edit.axis, edit.index, edit.spanMm, edit.mode), edges };
    case 'detachCellEdge':
      return { nodes: detachCellEdge(nodes, edges, storeyIds, edit.axis, edit.index, edit.cell, edit.deltaMm), edges };
    case 'stepCellEdge':
      return stepCellEdge(nodes, edges, storeyIds, edit.axis, edit.index, edit.cell, edit.deltaMm);
  }
}

/** Move axis `index` by `deltaMm` (snapped, clamped) on every storey in `storeyIds`. */
export function moveStoreyAxis(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  storeyIds: string[],
  axis: Axis,
  index: number,
  deltaMm: number,
): BubbleGraphNode[] {
  const { lo, hi } = axisDeltaBounds(nodes, storeyIds, axis, index);
  const delta = roundToSnap(clamp(deltaMm, lo, hi));
  if (delta === 0 || !Number.isFinite(delta)) return nodes;
  let out = nodes;
  for (const id of storeyIds) {
    const s = storeyOf(out, id);
    if (!s) continue;
    const axes = sortedAxes(s, axis);
    if (axes[index] === undefined) continue;
    axes[index] = roundToSnap(axes[index] + delta);
    out = rewriteStorey(out, edges, id, { [axis]: axes });
  }
  return out;
}

/** Set the distance between axis `index` and `index + 1`. */
export function setAxisSpan(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  storeyIds: string[],
  axis: Axis,
  index: number,
  spanMm: number,
  mode: SpanEditMode = DEFAULT_SPAN_EDIT_MODE,
): BubbleGraphNode[] {
  const span = roundToSnap(Math.max(GRID_MIN_GAP_MM, spanMm));
  if (!Number.isFinite(span)) return nodes;
  const src = storeyOf(nodes, storeyIds[0]);
  if (!src) return nodes;
  const ref = sortedAxes(src, axis);
  if (ref[index] === undefined || ref[index + 1] === undefined) return nodes;
  const delta = span - (ref[index + 1] - ref[index]);
  if (delta === 0) return nodes;

  if (mode === 'neighbour') return moveStoreyAxis(nodes, edges, storeyIds, axis, index + 1, delta);

  let out = nodes;
  for (const id of storeyIds) {
    const s = storeyOf(out, id);
    if (!s) continue;
    const axes = sortedAxes(s, axis);
    if (axes[index + 1] === undefined) continue;
    for (let k = index + 1; k < axes.length; k++) axes[k] = roundToSnap(axes[k] + delta);
    out = rewriteStorey(out, edges, id, { [axis]: axes });
  }
  return out;
}

/** Push the two grid points of one cell edge off their axis by `deltaMm` (relative offset). */
export function detachCellEdge(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  storeyIds: string[],
  axis: Axis,
  index: number,
  cell: number,
  deltaMm: number,
): BubbleGraphNode[] {
  const { lo, hi } = cellOffsetBounds(nodes, storeyIds, axis, index, cell);
  const delta = roundToSnap(clamp(deltaMm, lo, hi));
  if (delta === 0 || !Number.isFinite(delta)) return nodes;
  const key = offsetKey(axis);
  let out = nodes;
  for (const id of storeyIds) {
    const pts = cellEdgePoints(axis, index, cell).map((p) => axAt(out, id, p.gx, p.gy));
    if (pts.some((p) => !p)) continue;
    const patch = new Map<string, Record<string, unknown>>();
    for (const ax of pts as BubbleGraphNode[]) {
      const cur = Number(ax.properties[key] ?? 0) || 0;
      const next = roundToSnap(cur + delta);
      const props = { ...ax.properties };
      if (next === 0) delete props[key]; else props[key] = next;
      patch.set(ax.id, props);
    }
    out = rewriteStorey(out, edges, id, {}, patch);
  }
  return out;
}

// ─── Step: insert an axis and jog the envelope ────────────────────────────────

/** A, B … Z, A1, B1 — the bubble labels that ax node names mirror. */
const axLetter = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');
/** The name `handleRegenerateStoreyAxes` gives a grid point; a custom name is left alone. */
const autoAxName = (gx: number, gy: number) => `${gx + 1}-${axLetter(gy)}`;

function freshId(taken: Set<string>, base: string): string {
  let id = base;
  for (let k = 2; taken.has(id); k++) id = `${base}_${k}`;
  taken.add(id);
  return id;
}

const linked = (edges: BubbleGraphEdge[], a: string, b: string) =>
  edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));

/**
 * Step one cell edge off its axis, orthogonally.
 *
 * The offset line becomes a REAL axis (bubble, dimension chain, draggable), so
 * every grid index after it shifts by one. The run's own points move onto it;
 * a point that still carries a neighbour further along the old axis is split
 * instead, and — when the run contains a wall — a copy of that wall closes the
 * corner between the two halves. Deltas smaller than `GRID_MIN_GAP_MM` are a
 * dead zone: the drag has not cleared the old axis yet.
 */
export function stepCellEdge(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  storeyIds: string[],
  axis: Axis,
  index: number,
  cell: number,
  deltaMm: number,
): GridEditResult {
  const { lo, hi } = axisDeltaBounds(nodes, storeyIds, axis, index);
  const delta = roundToSnap(clamp(deltaMm, lo, hi));
  if (!Number.isFinite(delta) || Math.abs(delta) < GRID_MIN_GAP_MM) return { nodes, edges };
  let out: GridEditResult = { nodes, edges };
  for (const id of storeyIds) out = stepOneStorey(out.nodes, out.edges, id, axis, index, cell, delta);
  return out;
}

function stepOneStorey(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  storeyId: string,
  axis: Axis,
  index: number,
  cell: number,
  delta: number,
): GridEditResult {
  const storey = storeyOf(nodes, storeyId);
  if (!storey) return { nodes, edges };
  const axes = sortedAxes(storey, axis);
  const v = axes[index];
  if (v === undefined) return { nodes, edges };
  const newV = roundToSnap(v + delta);
  if (axes.some((a) => Math.abs(a - newV) <= EPS)) return { nodes, edges };

  const [ptA, ptB] = cellEdgePoints(axis, index, cell);
  const A = axAt(nodes, storeyId, ptA.gx, ptA.gy);
  const B = axAt(nodes, storeyId, ptB.gx, ptB.gy);
  if (!A || !B) return { nodes, edges };

  const nextAxes = [...axes, newV].sort((a, b) => a - b);
  const newIndex = nextAxes.indexOf(newV);
  const shift = (g: number) => (g >= newIndex ? g + 1 : g);
  // A corner splits only when the old axis carries on past the run — that is
  // the edge which would otherwise go oblique.
  const outer = (along: number) =>
    axis === 'x' ? axAt(nodes, storeyId, index, along) : axAt(nodes, storeyId, along, index);
  const willSplit = (p: BubbleGraphNode) => (p.id === A.id ? !!outer(cell - 1) : !!outer(cell + 2));

  const before = new Map<string, Pt>();
  for (const n of nodes) if (n.type === 'ax' && n.parentId === storeyId) before.set(n.id, axCanvasPos(n, storey));
  const frameBefore = storeyFrame(storey);

  const props: Record<string, unknown> = { ...storey.properties };
  if (axis === 'x') { props.axesX = nextAxes; props.width = nextAxes[nextAxes.length - 1] ?? 0; }
  else { props.axesY = nextAxes; props.height = nextAxes[nextAxes.length - 1] ?? 0; }

  // ── Re-key every grid point; the run's un-split ends land on the new axis ──
  const stepped = nodes.map((n) => {
    if (n.id === storeyId) return { ...storey, properties: props };
    if (!(n.type === 'ax' && n.parentId === storeyId && n.properties.bimX == null && n.properties.gridX != null)) return n;
    const gx = Number(n.properties.gridX), gy = Number(n.properties.gridY);
    const moves = (n.id === A.id || n.id === B.id) && !willSplit(n);
    const next = moves ? newIndex : shift(axis === 'x' ? gx : gy);
    const ngx = axis === 'x' ? next : gx;
    const ngy = axis === 'y' ? next : gy;
    return {
      ...n,
      name: n.name === autoAxName(gx, gy) ? autoAxName(ngx, ngy) : n.name,
      properties: { ...n.properties, gridX: ngx, gridY: ngy },
    };
  });

  // ── Split the corners that need it ────────────────────────────────────────
  const taken = new Set(nodes.map((n) => n.id));
  const created: BubbleGraphNode[] = [];
  const swap = new Map<string, string>(); // original grid point → its copy on the new axis
  for (const P of [A, B]) {
    if (!willSplit(P)) continue;
    const gx = Number(P.properties.gridX), gy = Number(P.properties.gridY);
    const ngx = axis === 'x' ? newIndex : gx;
    const ngy = axis === 'y' ? newIndex : gy;
    const copyProps: Record<string, unknown> = { ...P.properties, gridX: ngx, gridY: ngy };
    delete copyProps.ax_dx_mm;
    delete copyProps.ax_dy_mm;
    const id = freshId(taken, `ax_${storeyId}_${ngx}_${ngy}`);
    created.push({ ...P, id, name: autoAxName(ngx, ngy), properties: copyProps, locked: true, parentId: storeyId });
    swap.set(P.id, id);
    // The copy inherits the original's old position, so the reflow below sees
    // the jog as a real shift and carries the run's wall label with it.
    const old = before.get(P.id);
    if (old) before.set(id, old);
  }

  // ── Rewire the run onto the copies, and close each corner with a wall ─────
  const runIds = new Set(
    nodes.filter((n) => n.type !== 'ax' && n.type !== 'storey' &&
      linked(edges, n.id, A.id) && linked(edges, n.id, B.id)).map((n) => n.id));

  let nextEdges = edges;
  const corners: Array<{ wallId: string; a: string; b: string }> = [];
  // With nothing spanning the run there is nothing to rewire and no corner to
  // close — a bare grid just gains the points.
  if (swap.size > 0 && runIds.size > 0) {
    nextEdges = edges.map((e) => {
      const f = swap.get(e.from), t = swap.get(e.to);
      if (f && runIds.has(e.to)) return { ...e, from: f };
      if (t && runIds.has(e.from)) return { ...e, to: t };
      return e;
    });
    const srcWall = nodes.find((n) => n.type === 'wall' && runIds.has(n.id));
    if (srcWall) {
      const anchorType = edges.find((e) =>
        (e.from === srcWall.id && (e.to === A.id || e.to === B.id)) ||
        (e.to === srcWall.id && (e.from === A.id || e.from === B.id)))?.type;
      const takenEdges = new Set(edges.map((e) => e.id));
      const added: BubbleGraphEdge[] = [];
      for (const [origId, copyId] of swap) {
        const wallId = freshId(taken, `${srcWall.id}_jog`);
        created.push({ ...srcWall, id: wallId, properties: { ...srcWall.properties }, parentId: storeyId });
        added.push(
          { id: freshId(takenEdges, `${wallId}_a`), from: wallId, to: origId, type: anchorType },
          { id: freshId(takenEdges, `${wallId}_b`), from: wallId, to: copyId, type: anchorType },
        );
        corners.push({ wallId, a: origId, b: copyId });
      }
      nextEdges = [...nextEdges, ...added];
    }
  }

  const out = finalizeStorey([...stepped, ...created], nextEdges, storeyId, before, frameBefore);

  // Park each generated wall on the middle of the jog it closes.
  if (corners.length === 0) return { nodes: out, edges: nextEdges };
  const pos = new Map(out.map((n) => [n.id, n]));
  return {
    nodes: out.map((n) => {
      const c = corners.find((c) => c.wallId === n.id);
      const pa = c && pos.get(c.a), pb = c && pos.get(c.b);
      return pa && pb ? { ...n, x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } : n;
    }),
    edges: nextEdges,
  };
}

// ─── Core rewrite ─────────────────────────────────────────────────────────────

/**
 * Write new axes and/or new ax properties on one storey, then refresh every
 * ax cache and reflow the storey's other children by their anchors' shifts.
 */
function rewriteStorey(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  storeyId: string,
  axes: Partial<Record<Axis, number[]>>,
  axProps: Map<string, Record<string, unknown>> = new Map(),
): BubbleGraphNode[] {
  const storey = storeyOf(nodes, storeyId);
  if (!storey) return nodes;

  const before = new Map<string, Pt>();
  for (const n of nodes) {
    if (n.type === 'ax' && n.parentId === storeyId) before.set(n.id, axCanvasPos(n, storey));
  }
  const frameBefore = storeyFrame(storey);

  const props: Record<string, unknown> = { ...storey.properties };
  if (axes.x) { props.axesX = axes.x; props.width = axes.x[axes.x.length - 1] ?? 0; }
  if (axes.y) { props.axesY = axes.y; props.height = axes.y[axes.y.length - 1] ?? 0; }

  const staged = nodes.map((n) => {
    if (n.id === storeyId) return { ...storey, properties: props };
    if (n.type === 'ax' && n.parentId === storeyId && axProps.has(n.id)) {
      return { ...n, properties: axProps.get(n.id)! };
    }
    return n;
  });

  return finalizeStorey(staged, edges, storeyId, before, frameBefore);
}

/** Refresh every ax cache (position + `axNodeIndex`) on a storey, then reflow its children. */
function finalizeStorey(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  storeyId: string,
  before: Map<string, Pt>,
  frameBefore: StoreyFrame,
): BubbleGraphNode[] {
  const storey = storeyOf(nodes, storeyId);
  if (!storey) return nodes;
  const xsLen = sortedAxes(storey, 'x').length;
  const frameAfter = storeyFrame(storey);

  const staged = nodes.map((n) => {
    if (!(n.type === 'ax' && n.parentId === storeyId)) return n;
    const p = axCanvasPos(n, storey);
    const gx = Number(n.properties.gridX), gy = Number(n.properties.gridY);
    const properties = Number.isFinite(gx) && Number.isFinite(gy)
      ? { ...n.properties, axNodeIndex: gy * xsLen + gx }
      : n.properties;
    return { ...n, x: p.x, y: p.y, properties };
  });

  return reflowStoreyCanvas(staged, edges, storeyId, before, {
    x: frameAfter.ox - frameBefore.ox,
    y: frameAfter.oy - frameBefore.oy,
  });
}

/**
 * Move the storey's non-ax children with the grid: by the mean shift of their
 * connected ax anchors; doors/windows by their host wall's shift; anything
 * unanchored by the frame recentre (the canvas centres a storey on maxX/2, so
 * moving the last axis nudges everything). Ids and edges untouched.
 */
export function reflowStoreyCanvas(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  storeyId: string,
  before: Map<string, Pt>,
  frameShift: Pt = { x: 0, y: 0 },
): BubbleGraphNode[] {
  const map = new Map(nodes.map((n) => [n.id, n]));
  const shiftOf = new Map<string, Pt>();
  for (const [id, old] of before) {
    const cur = map.get(id);
    if (cur) shiftOf.set(id, { x: cur.x - old.x, y: cur.y - old.y });
  }

  const childIds = new Set(nodes.filter((n) => n.parentId === storeyId && n.type !== 'ax').map((n) => n.id));
  const neighbours = (id: string): BubbleGraphNode[] =>
    edges.filter((e) => e.from === id || e.to === id)
      .map((e) => map.get(e.from === id ? e.to : e.from))
      .filter((n): n is BubbleGraphNode => !!n);
  // A node counts as the storey's when it is a child, or wired to one (openings
  // placed before their parentId was set live one hop away).
  const affected = (n: BubbleGraphNode) =>
    n.type !== 'ax' && n.type !== 'storey' &&
    (n.parentId === storeyId || neighbours(n.id).some((m) => childIds.has(m.id)));

  const meanShift = (ids: string[]): Pt | null => {
    const s = ids.map((id) => shiftOf.get(id)).filter((v): v is Pt => !!v);
    if (!s.length) return null;
    return { x: s.reduce((a, v) => a + v.x, 0) / s.length, y: s.reduce((a, v) => a + v.y, 0) / s.length };
  };

  // Pass 1: everything anchored to ax nodes.
  const pass1 = new Map<string, Pt>();
  for (const n of nodes) {
    if (!affected(n)) continue;
    const anchors = neighbours(n.id).filter((m) => m.type === 'ax').map((m) => m.id);
    const sh = meanShift(anchors);
    if (sh) pass1.set(n.id, sh);
  }
  // Pass 2: openings follow their wall; the rest follows the frame.
  const finalShift = new Map<string, Pt>(pass1);
  for (const n of nodes) {
    if (!affected(n) || finalShift.has(n.id)) continue;
    const host = neighbours(n.id).find((m) => pass1.has(m.id));
    finalShift.set(n.id, host ? pass1.get(host.id)! : frameShift);
  }

  return nodes.map((n) => {
    const sh = finalShift.get(n.id);
    if (!sh || (sh.x === 0 && sh.y === 0)) return n;
    return { ...n, x: n.x + sh.x, y: n.y + sh.y };
  });
}

/** Grid-bound ax nodes of a storey with their resolved BIM and canvas positions. */
export function storeyGridPoints(nodes: BubbleGraphNode[], storey: BubbleGraphNode) {
  return nodes
    .filter((n) => n.type === 'ax' && n.parentId === storey.id && n.properties.bimX == null && n.properties.gridX != null)
    .map((n) => ({
      node: n,
      gx: Number(n.properties.gridX),
      gy: Number(n.properties.gridY),
      dx: Number(n.properties.ax_dx_mm ?? 0) || 0,
      dy: Number(n.properties.ax_dy_mm ?? 0) || 0,
      canvas: axCanvasPos(n, storey),
    }));
}

export { gridKey as gridIndexKey, offsetKey as gridOffsetKey };
