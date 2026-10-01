/**
 * gridLayout.ts — where everything in Grid mode sits, in WORLD canvas px.
 *
 * One pure function turns a storey's axes and ax nodes into axis lines,
 * bubbles, dimension labels, cell-edge handles and intersection dots. Both
 * the renderer and the hit test read this, so what you see is what you grab.
 *
 * Units: world = canvas px (`canvas mm × MM_TO_PX`), the space the panel's
 * `ctx.translate(pan); scale(zoom)` transform draws in. Glyphs are sized in
 * SCREEN px and divided by `zoom`, so bubbles and labels stay the same size
 * as you zoom while the grid itself scales.
 */
import type { BubbleGraphNode } from '@/store';
import {
  MM_TO_PX,
  bimToCanvas,
  sortedAxes,
  storeyFrame,
  storeyGridPoints,
  type Axis,
  type Pt,
  type StoreyFrame,
} from './axisEdit';

export interface GridLayoutOpts {
  zoom: number;
  /** How far axis lines run past the outer intersections (screen px). */
  extPx?: number;
  bubbleRPx?: number;
  /** Gap between the bubbles and the dimension chain (screen px). */
  dimOffsetPx?: number;
  handlePx?: number;
}

export interface AxisLine {
  storeyId: string; axis: Axis; index: number; valueMm: number;
  a: Pt; b: Pt;             // line ends (world), extended past the grid
  bubble: Pt; label: string;
}
export interface CellHandle {
  storeyId: string; axis: Axis; index: number; cell: number;
  a: Pt; b: Pt; mid: Pt;    // the cell edge between two intersections (world)
  detached: boolean;
}
export interface DimLabel {
  storeyId: string; axis: Axis; index: number; spanMm: number;
  anchor: Pt;               // label centre (world)
  rect: { x: number; y: number; w: number; h: number };
}
export interface GridDot {
  nodeId: string; storeyId: string; gx: number; gy: number;
  pos: Pt; foot: Pt; offAxis: boolean;
}
export interface StoreyGridLayout {
  storeyId: string; frame: StoreyFrame;
  xs: number[]; ys: number[];
  xLines: AxisLine[]; yLines: AxisLine[];
  handles: CellHandle[]; dims: DimLabel[]; dots: GridDot[];
  /** Grid bounds in world px (intersections only). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export const xAxisLabel = (j: number) => String(j + 1);
export const yAxisLabel = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');

/** BIM mm → world px for a storey. */
export function bimToWorld(frame: StoreyFrame, p: Pt): Pt {
  const c = bimToCanvas(frame, p);
  return { x: c.x * MM_TO_PX, y: c.y * MM_TO_PX };
}

export function buildGridLayout(
  nodes: BubbleGraphNode[],
  storeyIds: string[],
  opts: GridLayoutOpts,
): StoreyGridLayout[] {
  const zoom = Math.max(opts.zoom, 1e-6);
  const ext = (opts.extPx ?? 28) / zoom;
  const bubbleR = (opts.bubbleRPx ?? 9) / zoom;
  const dimOff = (opts.dimOffsetPx ?? 18) / zoom;
  const dimH = 14 / zoom;
  const out: StoreyGridLayout[] = [];

  for (const sid of storeyIds) {
    const storey = nodes.find((n) => n.id === sid && n.type === 'storey');
    if (!storey) continue;
    const xs = sortedAxes(storey, 'x');
    const ys = sortedAxes(storey, 'y');
    if (xs.length === 0 || ys.length === 0) continue;
    const frame = storeyFrame(storey);
    const W = (x: number, y: number) => bimToWorld(frame, { x, y });

    const x0 = W(xs[0], ys[0]).x, x1 = W(xs[xs.length - 1], ys[0]).x;
    const y0 = W(xs[0], ys[0]).y, y1 = W(xs[0], ys[ys.length - 1]).y;

    const xLines: AxisLine[] = xs.map((v, j) => {
      const x = W(v, 0).x;
      return {
        storeyId: sid, axis: 'x', index: j, valueMm: v,
        a: { x, y: y0 - ext }, b: { x, y: y1 + ext },
        bubble: { x, y: y0 - ext - bubbleR }, label: xAxisLabel(j),
      };
    });
    const yLines: AxisLine[] = ys.map((v, i) => {
      const y = W(0, v).y;
      return {
        storeyId: sid, axis: 'y', index: i, valueMm: v,
        a: { x: x0 - ext, y }, b: { x: x1 + ext, y },
        bubble: { x: x0 - ext - bubbleR, y }, label: yAxisLabel(i),
      };
    });

    // Dimension chains: below the X bubbles, left of the Y bubbles.
    const dims: DimLabel[] = [];
    const dimY = y0 - ext - 2 * bubbleR - dimOff;
    for (let j = 0; j + 1 < xs.length; j++) {
      const span = xs[j + 1] - xs[j];
      const cx = (W(xs[j], 0).x + W(xs[j + 1], 0).x) / 2;
      const w = (String(Math.round(span)).length * 7 + 10) / zoom;
      dims.push({ storeyId: sid, axis: 'x', index: j, spanMm: span, anchor: { x: cx, y: dimY },
        rect: { x: cx - w / 2, y: dimY - dimH / 2, w, h: dimH } });
    }
    const dimX = x0 - ext - 2 * bubbleR - dimOff;
    for (let i = 0; i + 1 < ys.length; i++) {
      const span = ys[i + 1] - ys[i];
      const cy = (W(0, ys[i]).y + W(0, ys[i + 1]).y) / 2;
      const w = (String(Math.round(span)).length * 7 + 10) / zoom;
      dims.push({ storeyId: sid, axis: 'y', index: i, spanMm: span, anchor: { x: dimX, y: cy },
        rect: { x: dimX - w / 2, y: cy - dimH / 2, w, h: dimH } });
    }

    // Dots from the real ax nodes (offsets included), keyed by grid index.
    const pts = storeyGridPoints(nodes, storey);
    const byKey = new Map<string, typeof pts[number]>();
    for (const p of pts) byKey.set(`${p.gx}_${p.gy}`, p);
    const dots: GridDot[] = pts.map((p) => ({
      nodeId: p.node.id, storeyId: sid, gx: p.gx, gy: p.gy,
      pos: { x: p.canvas.x * MM_TO_PX, y: p.canvas.y * MM_TO_PX },
      foot: W(xs[p.gx] ?? 0, ys[p.gy] ?? 0),
      offAxis: p.dx !== 0 || p.dy !== 0,
    }));
    const dotAt = (gx: number, gy: number) => {
      const p = byKey.get(`${gx}_${gy}`);
      return p ? { pos: { x: p.canvas.x * MM_TO_PX, y: p.canvas.y * MM_TO_PX }, dx: p.dx, dy: p.dy } : null;
    };

    // Cell-edge handles: along each X axis between consecutive Y axes, and vice versa.
    const handles: CellHandle[] = [];
    for (let j = 0; j < xs.length; j++) {
      for (let i = 0; i + 1 < ys.length; i++) {
        const A = dotAt(j, i), B = dotAt(j, i + 1);
        if (!A || !B) continue;
        handles.push({ storeyId: sid, axis: 'x', index: j, cell: i, a: A.pos, b: B.pos,
          mid: { x: (A.pos.x + B.pos.x) / 2, y: (A.pos.y + B.pos.y) / 2 }, detached: A.dx !== 0 || B.dx !== 0 });
      }
    }
    for (let i = 0; i < ys.length; i++) {
      for (let j = 0; j + 1 < xs.length; j++) {
        const A = dotAt(j, i), B = dotAt(j + 1, i);
        if (!A || !B) continue;
        handles.push({ storeyId: sid, axis: 'y', index: i, cell: j, a: A.pos, b: B.pos,
          mid: { x: (A.pos.x + B.pos.x) / 2, y: (A.pos.y + B.pos.y) / 2 }, detached: A.dy !== 0 || B.dy !== 0 });
      }
    }

    out.push({ storeyId: sid, frame, xs, ys, xLines, yLines, handles, dims, dots,
      bounds: { minX: x0, minY: y0, maxX: x1, maxY: y1 } });
  }
  return out;
}

// ─── Hit testing ──────────────────────────────────────────────────────────────

export type GridHit =
  | { kind: 'dim'; dim: DimLabel }
  | { kind: 'handle'; handle: CellHandle }
  | { kind: 'bubble'; line: AxisLine }
  | { kind: 'axis'; line: AxisLine }
  | null;

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * What the cursor (world px) is over. Priority: dimension label, cell handle,
 * bubble, then the axis line itself (skippable, so node hits can win first).
 */
export function gridHitTest(
  layout: StoreyGridLayout[],
  cx: number,
  cy: number,
  zoom: number,
  opts: { skipAxisLine?: boolean; handlePx?: number; axisPx?: number; bubbleRPx?: number } = {},
): GridHit {
  const z = Math.max(zoom, 1e-6);
  const handleR = (opts.handlePx ?? 8) / z;
  const axisR = (opts.axisPx ?? 6) / z;
  const bubbleR = (opts.bubbleRPx ?? 9) / z;
  const p = { x: cx, y: cy };

  for (const L of layout) {
    for (const d of L.dims) {
      if (cx >= d.rect.x && cx <= d.rect.x + d.rect.w && cy >= d.rect.y && cy <= d.rect.y + d.rect.h) return { kind: 'dim', dim: d };
    }
  }
  for (const L of layout) {
    for (const h of L.handles) {
      if (Math.hypot(cx - h.mid.x, cy - h.mid.y) <= handleR) return { kind: 'handle', handle: h };
    }
  }
  for (const L of layout) {
    for (const line of [...L.xLines, ...L.yLines]) {
      if (Math.hypot(cx - line.bubble.x, cy - line.bubble.y) <= bubbleR) return { kind: 'bubble', line };
    }
  }
  if (!opts.skipAxisLine) {
    let best: { line: AxisLine; d: number } | null = null;
    for (const L of layout) {
      for (const line of [...L.xLines, ...L.yLines]) {
        const d = distToSegment(p, line.a, line.b);
        if (d <= axisR && (!best || d < best.d)) best = { line, d };
      }
    }
    if (best) return { kind: 'axis', line: best.line };
  }
  return null;
}

// ─── Screen ↔ world (the panel's transform, Y up) ─────────────────────────────

export function screenToWorld(sx: number, sy: number, pan: Pt, zoom: number, canvasH: number): Pt {
  return { x: (sx - pan.x) / zoom, y: (canvasH - (sy - pan.y)) / zoom };
}
export function worldToScreen(wx: number, wy: number, pan: Pt, zoom: number, canvasH: number): Pt {
  return { x: pan.x + wx * zoom, y: pan.y + canvasH - wy * zoom };
}
