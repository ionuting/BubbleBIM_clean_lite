/**
 * gridRender.ts — the Grid-mode picture of the graph canvas.
 *
 * Draws inside the panel's world transform (translate(pan) · scale(zoom) ·
 * Y up): axis lines with bubbles, dimension chains, cell-edge handles,
 * intersection dots, and a minimal but selectable version of everything else
 * — walls as lines between their anchors, rooms as light polygons, beams
 * dashed, columns as squares, sections as thin markers, other nodes as dots.
 *
 * Every glyph is sized in SCREEN px and divided by `zoom`, so the drawing
 * reads the same at any magnification. Text goes through `label()`, which
 * un-flips the Y axis and undoes the zoom so 10 px stays 10 px.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { parseLookSide } from '@/lib/sectionFromPlan';
import { type GridEdit, type Pt } from './axisEdit';
import type { CellHandle, DimLabel, GridHit, StoreyGridLayout } from './gridLayout';
import type { GridWall, OpeningPlacement, WallChip } from './openings';

export type GridHover = GridHit | { kind: 'node'; nodeId: string } | null;

export interface GridRenderColors {
  text: string;
  /** Axis lines and chains — a muted foreground. */
  axis: string;
  /** Hover / drag highlight. */
  accent: string;
  /** Selection (matches the rest of the canvas). */
  selection: string;
  edge: string;
  /** The canvas background — openings are cut out of the wall line with it. */
  surface: string;
}

export interface GridRenderArgs {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  layout: StoreyGridLayout[];
  zoom: number;
  mmToPx: number;
  colors: GridRenderColors;
  nodeColors: Record<string, string>;
  selectedNodeId: string | null;
  selectedNodeIds: string[];
  selectedEdge: string | null;
  edgeStart: string | null;
  hoveredGrip: { nodeId: string; gripIdx: number } | null;
  hover: GridHover;
  drag: { edit: GridEdit } | null;
  /** Dimension label currently edited in the HTML input — not drawn. */
  hideDim: { storeyId: string; axis: 'x' | 'y'; index: number } | null;
  /** Room polygon in world px (the panel's getRoomCanvasPts on the view nodes). */
  roomPts: (n: BubbleGraphNode) => Pt[] | null;
  /** Edge endpoint for a node (mm canvas units), honouring ax grips. */
  edgeEndpoint: (n: BubbleGraphNode, grip?: number) => Pt;
  /** Wall segments in the anchor order `calcWallGeometry` uses, with their openings. */
  walls: GridWall[];
  /** Opening symbols, already placed on those segments. */
  openings: Array<{ wall: GridWall; placement: OpeningPlacement }>;
  /** The one opening whose controls are shown (hovered, or on the selected wall). */
  activeOpening: OpeningPlacement | null;
  /** Has-windows / has-doors chips for the selected wall. */
  wallChips: WallChip[];
}

const ROOM_ANCHOR_TYPES = new Set(['ax', 'column']);
const LINE_TYPES = new Set(['wall', 'beam']);
const OPENING_TYPES = new Set(['door', 'window']);
const SKIP_TYPES = new Set(['storey', 'ax', 'wall', 'beam', 'room', 'section', 'view', 'door', 'window']);

/** Screen-constant, upright text inside the flipped world transform. */
function label(
  ctx: CanvasRenderingContext2D, zoom: number, text: string, x: number, y: number,
  sizePx: number, color: string, align: CanvasTextAlign = 'center', bold = false,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1 / zoom, -1 / zoom);
  ctx.fillStyle = color;
  ctx.font = `${bold ? 'bold ' : ''}${sizePx}px system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

const fmtMm = (v: number) => String(Math.round(v));

export function drawGridMode(ctx: CanvasRenderingContext2D, a: GridRenderArgs): void {
  const { zoom, mmToPx: K, colors, nodes, edges } = a;
  const px = (v: number) => v / zoom;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isSel = (id: string) => a.selectedNodeId === id || a.selectedNodeIds.includes(id);
  const neighbours = (id: string) =>
    edges.filter((e) => e.from === id || e.to === id)
      .map((e) => ({ e, n: byId.get(e.from === id ? e.to : e.from) }))
      .filter((x): x is { e: BubbleGraphEdge; n: BubbleGraphNode } => !!x.n);

  const hoverLine = a.hover?.kind === 'axis' || a.hover?.kind === 'bubble' ? a.hover.line : null;
  const dragEdit = a.drag?.edit ?? null;
  const isDraggedLine = (storeyId: string, axis: 'x' | 'y', index: number) =>
    !!dragEdit && dragEdit.axis === axis && (
      (dragEdit.kind === 'moveAxis' && dragEdit.index === index) ||
      (dragEdit.kind === 'setSpan' && index === dragEdit.index + 1)) &&
    // Linked storeys preview too: the layout is built from the previewed nodes,
    // so highlight any storey whose axis carries the same index.
    (dragEdit.scope === 'linked' || dragEdit.storeyId === storeyId);

  // ── 1. Storey frames + names ───────────────────────────────────────────────
  for (const L of a.layout) {
    const s = byId.get(L.storeyId);
    if (!s) continue;
    const { minX, minY, maxX, maxY } = L.bounds;
    ctx.save();
    ctx.strokeStyle = colors.axis;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = px(1);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    ctx.restore();
    label(ctx, zoom, s.name, minX, maxY + px(34), 10, colors.text, 'left', true);
  }

  // ── 2. Axis lines + bubbles ────────────────────────────────────────────────
  for (const L of a.layout) {
    for (const line of [...L.xLines, ...L.yLines]) {
      const hot = hoverLine === line || isDraggedLine(line.storeyId, line.axis, line.index);
      ctx.save();
      ctx.strokeStyle = hot ? colors.accent : colors.axis;
      ctx.globalAlpha = hot ? 1 : 0.6;
      ctx.lineWidth = px(hot ? 1.5 : 0.75);
      ctx.setLineDash([px(6), px(4)]);
      ctx.beginPath();
      ctx.moveTo(line.a.x, line.a.y);
      ctx.lineTo(line.b.x, line.b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // Bubble
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(line.bubble.x, line.bubble.y, px(9), 0, Math.PI * 2);
      ctx.fillStyle = hot ? colors.accent : 'rgba(255,255,255,0.85)';
      ctx.fill();
      ctx.strokeStyle = hot ? colors.accent : colors.axis;
      ctx.lineWidth = px(1);
      ctx.stroke();
      ctx.restore();
      label(ctx, zoom, line.label, line.bubble.x, line.bubble.y, 10, hot ? '#fff' : colors.text, 'center', true);
    }
  }

  // ── 3. Dimension chains ────────────────────────────────────────────────────
  for (const L of a.layout) {
    const xd = L.dims.filter((d) => d.axis === 'x');
    const yd = L.dims.filter((d) => d.axis === 'y');
    ctx.save();
    ctx.strokeStyle = colors.axis;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = px(0.75);
    if (xd.length) {
      const y = xd[0].anchor.y;
      const xs = L.xLines.map((l) => l.a.x);
      ctx.beginPath();
      ctx.moveTo(xs[0], y); ctx.lineTo(xs[xs.length - 1], y);
      for (const x of xs) { ctx.moveTo(x, y - px(4)); ctx.lineTo(x, y + px(4)); }
      ctx.stroke();
    }
    if (yd.length) {
      const x = yd[0].anchor.x;
      const ys = L.yLines.map((l) => l.a.y);
      ctx.beginPath();
      ctx.moveTo(x, ys[0]); ctx.lineTo(x, ys[ys.length - 1]);
      for (const y of ys) { ctx.moveTo(x - px(4), y); ctx.lineTo(x + px(4), y); }
      ctx.stroke();
    }
    ctx.restore();
    for (const d of L.dims) {
      if (a.hideDim && a.hideDim.storeyId === d.storeyId && a.hideDim.axis === d.axis && a.hideDim.index === d.index) continue;
      const hot = a.hover?.kind === 'dim' && a.hover.dim === d;
      // A quiet backing so the number reads over the chain line.
      ctx.save();
      ctx.fillStyle = hot ? colors.accent : 'rgba(255,255,255,0.85)';
      ctx.fillRect(d.rect.x, d.rect.y, d.rect.w, d.rect.h);
      ctx.restore();
      label(ctx, zoom, fmtMm(d.spanMm), d.anchor.x, d.anchor.y, 10, hot ? '#fff' : colors.text);
    }
  }

  // ── 4. Cell-edge handles (hovered / dragged / detached) ───────────────────
  const hoverHandle: CellHandle | null = a.hover?.kind === 'handle' ? a.hover.handle : null;
  for (const L of a.layout) {
    for (const h of L.handles) {
      const dragged = !!dragEdit && dragEdit.kind === 'detachCellEdge' &&
        dragEdit.axis === h.axis && dragEdit.index === h.index && dragEdit.cell === h.cell &&
        (dragEdit.scope === 'linked' || dragEdit.storeyId === h.storeyId);
      if (h.detached) {
        // The edge itself, solid, so the jog reads as geometry.
        ctx.save();
        ctx.strokeStyle = colors.axis;
        ctx.lineWidth = px(1.25);
        ctx.beginPath(); ctx.moveTo(h.a.x, h.a.y); ctx.lineTo(h.b.x, h.b.y); ctx.stroke();
        ctx.restore();
      }
      if (!(hoverHandle === h || dragged || h.detached)) continue;
      const hot = hoverHandle === h || dragged;
      const s = px(hot ? 7 : 5);
      ctx.save();
      ctx.fillStyle = hot ? colors.accent : 'rgba(255,255,255,0.9)';
      ctx.strokeStyle = hot ? colors.accent : colors.axis;
      ctx.lineWidth = px(1);
      ctx.beginPath();
      ctx.rect(h.mid.x - s / 2, h.mid.y - s / 2, s, s);
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  // ── 5. Rooms ───────────────────────────────────────────────────────────────
  for (const n of nodes) {
    if (n.type !== 'room') continue;
    const pts = a.roomPts(n);
    const color = a.nodeColors.room ?? '#8b5cf6';
    if (pts && pts.length >= 3) {
      ctx.save();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = isSel(n.id) ? 0.22 : 0.1;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = isSel(n.id) ? colors.selection : color;
      ctx.lineWidth = px(isSel(n.id) ? 1.5 : 0.75);
      ctx.stroke();
      ctx.restore();
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, px(6), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = px(1); ctx.stroke();
      ctx.restore();
      label(ctx, zoom, '+', cx, cy, 10, color, 'center', true);
      label(ctx, zoom, n.name, cx, cy + px(14), 9, colors.text);
    } else {
      dot(ctx, n.x * K, n.y * K, px(4), color, isSel(n.id) ? colors.selection : null, px(1));
      label(ctx, zoom, n.name, n.x * K, n.y * K + px(12), 9, colors.text);
    }
  }

  // ── 6. Walls and beams as lines between their anchors ──────────────────────
  // Walls come pre-segmented so the openings sit on exactly the line drawn here.
  const segOf = new Map(a.walls.map((w) => [w.wall.id, w]));
  const wallMid = new Map<string, Pt>();
  for (const n of nodes) {
    if (!LINE_TYPES.has(n.type)) continue;
    const seg = segOf.get(n.id);
    let x1: number, y1: number, x2: number, y2: number;
    if (seg) {
      x1 = seg.a.x; y1 = seg.a.y; x2 = seg.b.x; y2 = seg.b.y;
    } else {
      const ends = neighbours(n.id).filter(({ n: m }) => ROOM_ANCHOR_TYPES.has(m.type));
      if (ends.length < 2) {
        dot(ctx, n.x * K, n.y * K, px(4), a.nodeColors[n.type] ?? colors.edge, isSel(n.id) ? colors.selection : null, px(1));
        continue;
      }
      const pA = a.edgeEndpoint(ends[0].n, ends[0].e.from === ends[0].n.id ? ends[0].e.fromGrip : ends[0].e.toGrip);
      const pB = a.edgeEndpoint(ends[1].n, ends[1].e.from === ends[1].n.id ? ends[1].e.fromGrip : ends[1].e.toGrip);
      x1 = pA.x * K; y1 = pA.y * K; x2 = pB.x * K; y2 = pB.y * K;
    }
    wallMid.set(n.id, { x: (x1 + x2) / 2, y: (y1 + y2) / 2 });
    const sel = isSel(n.id);
    ctx.save();
    ctx.strokeStyle = sel ? colors.selection : (a.nodeColors[n.type] ?? colors.edge);
    ctx.lineWidth = px(n.type === 'wall' ? (sel ? 3 : 2) : (sel ? 2.5 : 1.5));
    if (n.type === 'beam') ctx.setLineDash([px(8), px(5)]);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.restore();
    if (sel || (a.hover?.kind === 'node' && a.hover.nodeId === n.id)) {
      label(ctx, zoom, n.name, (x1 + x2) / 2, (y1 + y2) / 2 + px(10), 9, colors.text);
    }
  }

  // ── 7. Openings: the plan symbol, drawn on the wall it belongs to ──────────
  const placedNodeIds = new Set<string>();
  for (const { placement: p } of a.openings) {
    if (p.op.ref.kind === 'node') placedNodeIds.add(p.op.ref.nodeId);
    drawOpening(ctx, p, zoom, colors, a.nodeColors[p.op.type] ?? colors.edge);
  }
  // Opening nodes whose wall could not be resolved still get a dot and a leader.
  for (const n of nodes) {
    if (!OPENING_TYPES.has(n.type) || placedNodeIds.has(n.id)) continue;
    const host = neighbours(n.id).find(({ n: m }) => m.type === 'wall');
    const mid = host ? wallMid.get(host.n.id) : undefined;
    const color = a.nodeColors[n.type] ?? colors.edge;
    const x = n.x * K, y = n.y * K;
    if (mid) {
      ctx.save();
      ctx.strokeStyle = color; ctx.globalAlpha = 0.6; ctx.lineWidth = px(0.75);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(mid.x, mid.y); ctx.stroke();
      ctx.restore();
    }
    dot(ctx, x, y, px(3), color, isSel(n.id) ? colors.selection : null, px(1));
  }

  // ── 7b. On-canvas controls: flip / remove an opening, add one to a wall ────
  if (a.activeOpening) {
    const p = a.activeOpening;
    const color = a.nodeColors[p.op.type] ?? colors.edge;
    ctx.save();
    ctx.strokeStyle = colors.accent; ctx.lineWidth = px(1.5); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(p.p0.x, p.p0.y); ctx.lineTo(p.p1.x, p.p1.y); ctx.stroke();
    ctx.restore();
    for (const c of p.chips) chip(ctx, zoom, c.at, c.glyph, c.id === 'remove' ? '#e11d48' : colors.accent);
    label(ctx, zoom, `${p.op.name} · ${fmtMm(p.op.widthMm)}`,
      p.centre.x + p.nrm.x * p.side * px(16), p.centre.y + p.nrm.y * p.side * px(16), 9, color, 'center', true);
  }
  for (const c of a.wallChips) chip(ctx, zoom, c.at, c.glyph, c.on ? colors.accent : colors.axis);

  // ── 8. Section / view markers, compact ─────────────────────────────────────
  for (const n of nodes) {
    if (n.type !== 'section' && n.type !== 'view') continue;
    const color = n.type === 'section' ? '#e11d48' : '#f97316';
    const sel = isSel(n.id);
    const anchors = neighbours(n.id).filter(({ n: m }) => m.type === 'ax').map(({ n: m }) => m);
    if (anchors.length < 2) {
      ctx.save();
      ctx.setLineDash([px(3), px(2)]);
      ctx.strokeStyle = sel ? colors.selection : color; ctx.lineWidth = px(1);
      ctx.beginPath(); ctx.arc(n.x * K, n.y * K, px(8), 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      label(ctx, zoom, n.name, n.x * K, n.y * K + px(14), 9, color, 'center', true);
      continue;
    }
    const x1 = anchors[0].x * K, y1 = anchors[0].y * K, x2 = anchors[1].x * K, y2 = anchors[1].y * K;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const right = parseLookSide(n.properties.look_side, n.properties.flipped) === 'right';
    const nx = right ? uy : -uy, ny = right ? -ux : ux;
    ctx.save();
    ctx.strokeStyle = sel ? colors.selection : color;
    ctx.fillStyle = sel ? colors.selection : color;
    ctx.lineWidth = px(sel ? 2 : 1.5);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    for (const [cx, cy] of [[x1, y1], [x2, y2]] as const) {
      ctx.beginPath(); ctx.arc(cx, cy, px(4), 0, Math.PI * 2); ctx.fill();
      const L2 = px(9);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + nx * L2, cy + ny * L2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + nx * L2, cy + ny * L2);
      ctx.lineTo(cx + nx * L2 * 0.6 - ux * px(3), cy + ny * L2 * 0.6 - uy * px(3));
      ctx.lineTo(cx + nx * L2 * 0.6 + ux * px(3), cy + ny * L2 * 0.6 + uy * px(3));
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    label(ctx, zoom, n.name, (x1 + x2) / 2 + nx * px(14), (y1 + y2) / 2 + ny * px(14), 9, color, 'center', true);
  }

  // ── 9. Remaining edges (not implied by the drawing above) ──────────────────
  const roomHasPoly = new Map<string, boolean>();
  for (const n of nodes) if (n.type === 'room') roomHasPoly.set(n.id, !!a.roomPts(n)?.length);
  ctx.save();
  for (const e of edges) {
    const s = byId.get(e.from), t = byId.get(e.to);
    if (!s || !t) continue;
    const pair = [s.type, t.type];
    const has = (x: string) => pair.includes(x);
    if (has('ax') && (has('wall') || has('beam') || has('section') || has('view'))) continue;
    if (has('column') && (has('wall') || has('beam'))) continue;
    if ((s.type === 'room' && roomHasPoly.get(s.id)) || (t.type === 'room' && roomHasPoly.get(t.id))) continue;
    if ((OPENING_TYPES.has(s.type) && t.type === 'wall') || (OPENING_TYPES.has(t.type) && s.type === 'wall')) continue;
    const pf = a.edgeEndpoint(s, e.fromGrip), pt = a.edgeEndpoint(t, e.toGrip);
    const sel = a.selectedEdge === e.id;
    ctx.strokeStyle = sel ? colors.selection : colors.edge;
    ctx.globalAlpha = sel ? 1 : 0.5;
    ctx.lineWidth = px(sel ? 2 : 0.75);
    ctx.beginPath(); ctx.moveTo(pf.x * K, pf.y * K); ctx.lineTo(pt.x * K, pt.y * K); ctx.stroke();
  }
  ctx.restore();

  // ── 10. Other point nodes ──────────────────────────────────────────────────
  for (const n of nodes) {
    if (SKIP_TYPES.has(n.type)) continue;
    const color = a.nodeColors[n.type] ?? colors.edge;
    const x = n.x * K, y = n.y * K;
    const sel = isSel(n.id);
    if (n.type === 'column') {
      const s = px(6);
      ctx.save();
      ctx.fillStyle = color;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
      if (sel) { ctx.strokeStyle = colors.selection; ctx.lineWidth = px(1.5); ctx.strokeRect(x - s, y - s, 2 * s, 2 * s); }
      ctx.restore();
    } else {
      dot(ctx, x, y, px(4), color, sel ? colors.selection : null, px(1.5), px(8));
    }
    if (sel || (a.hover?.kind === 'node' && a.hover.nodeId === n.id)) {
      label(ctx, zoom, n.name, x, y + px(12), 9, colors.text);
    }
  }

  // ── 11. Intersection dots ──────────────────────────────────────────────────
  for (const L of a.layout) {
    for (const d of L.dots) {
      const n = byId.get(d.nodeId);
      if (!n) continue;
      if (d.offAxis) {
        // Dotted tie back to where the grid would have put it.
        ctx.save();
        ctx.strokeStyle = colors.axis; ctx.globalAlpha = 0.6;
        ctx.setLineDash([px(2), px(2)]); ctx.lineWidth = px(0.75);
        ctx.beginPath(); ctx.moveTo(d.foot.x, d.foot.y); ctx.lineTo(d.pos.x, d.pos.y); ctx.stroke();
        ctx.restore();
      }
      const hasCol = String(n.properties.has_column ?? '').toLowerCase() === 'true';
      const sel = isSel(n.id);
      const start = a.edgeStart === n.id;
      const hov = a.hoveredGrip?.nodeId === n.id && a.hoveredGrip.gripIdx === 0;
      ctx.save();
      if (hasCol) {
        const s = px(7);
        ctx.fillStyle = a.nodeColors.ax ?? '#374151';
        ctx.fillRect(d.pos.x - s / 2, d.pos.y - s / 2, s, s);
      } else {
        ctx.beginPath(); ctx.arc(d.pos.x, d.pos.y, px(3.5), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill();
        ctx.strokeStyle = a.nodeColors.ax ?? '#374151'; ctx.lineWidth = px(1.25); ctx.stroke();
      }
      if (hov || start || sel) {
        ctx.beginPath(); ctx.arc(d.pos.x, d.pos.y, px(7), 0, Math.PI * 2);
        ctx.strokeStyle = start ? colors.selection : hov ? '#facc15' : colors.selection;
        ctx.lineWidth = px(1.75);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ── 12. Drag readout ───────────────────────────────────────────────────────
  if (dragEdit && dragEdit.kind !== 'setSpan') {
    const L = a.layout.find((l) => l.storeyId === dragEdit.storeyId);
    if (L) {
      const delta = dragEdit.deltaMm;
      const text = `${delta > 0 ? '+' : ''}${fmtMm(delta)} mm`;
      let at: Pt | null = null;
      if (dragEdit.kind === 'moveAxis') {
        const line = (dragEdit.axis === 'x' ? L.xLines : L.yLines)[dragEdit.index];
        if (line) at = { x: line.bubble.x + (dragEdit.axis === 'x' ? 0 : -px(30)), y: line.bubble.y + (dragEdit.axis === 'x' ? -px(22) : 0) };
      } else {
        const h = L.handles.find((h) => h.axis === dragEdit.axis && h.index === dragEdit.index && h.cell === dragEdit.cell);
        if (h) at = { x: h.mid.x + px(14), y: h.mid.y + px(14) };
      }
      if (at) {
        ctx.save();
        ctx.fillStyle = colors.accent;
        const w = px(text.length * 6.5 + 12), hgt = px(16);
        ctx.fillRect(at.x - w / 2, at.y - hgt / 2, w, hgt);
        ctx.restore();
        label(ctx, zoom, text, at.x, at.y, 10, '#fff', 'center', true);
      }
    }
  }
}

/**
 * The plan symbol for one opening, cut out of the wall line: a reveal cleared
 * in the background colour with a jamb tick at each end, then a glazing bar for
 * a window or a leaf plus its sweep arc for a door.
 */
function drawOpening(
  ctx: CanvasRenderingContext2D,
  p: OpeningPlacement,
  zoom: number,
  colors: GridRenderColors,
  color: string,
): void {
  const px = (v: number) => v / Math.max(zoom, 1e-6);
  const len = Math.hypot(p.p1.x - p.p0.x, p.p1.y - p.p0.y);
  if (len < 1e-6) return;

  ctx.save();
  ctx.strokeStyle = colors.surface;
  ctx.lineWidth = px(4);
  ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(p.p0.x, p.p0.y); ctx.lineTo(p.p1.x, p.p1.y); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = px(1);
  const j = px(3);
  for (const q of [p.p0, p.p1]) {
    ctx.beginPath();
    ctx.moveTo(q.x - p.nrm.x * j, q.y - p.nrm.y * j);
    ctx.lineTo(q.x + p.nrm.x * j, q.y + p.nrm.y * j);
    ctx.stroke();
  }
  ctx.restore();

  if (p.op.type === 'window') {
    const h = px(1.6);
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(p.p0.x + p.nrm.x * h, p.p0.y + p.nrm.y * h);
    ctx.lineTo(p.p1.x + p.nrm.x * h, p.p1.y + p.nrm.y * h);
    ctx.lineTo(p.p1.x - p.nrm.x * h, p.p1.y - p.nrm.y * h);
    ctx.lineTo(p.p0.x - p.nrm.x * h, p.p0.y - p.nrm.y * h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    return;
  }

  const hinge = p.hingeAtStart ? p.p0 : p.p1;
  const along = p.hingeAtStart ? 1 : -1;
  const open = { x: p.nrm.x * p.side, y: p.nrm.y * p.side };
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = px(1.5);
  ctx.beginPath();
  ctx.moveTo(hinge.x, hinge.y);
  ctx.lineTo(hinge.x + open.x * len, hinge.y + open.y * len);
  ctx.stroke();
  const a0 = Math.atan2(p.u.y * along, p.u.x * along);
  const a1 = Math.atan2(open.y, open.x);
  let d = a1 - a0;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d > Math.PI) d -= 2 * Math.PI;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = px(0.75);
  ctx.setLineDash([px(3), px(3)]);
  ctx.beginPath();
  ctx.arc(hinge.x, hinge.y, len, a0, a1, d < 0);
  ctx.stroke();
  ctx.restore();
}

/** A small round button, positioned in world space but sized on screen. */
function chip(ctx: CanvasRenderingContext2D, zoom: number, at: Pt, glyph: string, color: string): void {
  const r = 8 / Math.max(zoom, 1e-6);
  ctx.save();
  ctx.beginPath();
  ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = r / 8;
  ctx.stroke();
  ctx.restore();
  label(ctx, zoom, glyph, at.x, at.y, 10, color, 'center', true);
}

function dot(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string,
  ring: string | null, ringW: number, ringR = r * 2,
) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  if (ring) {
    ctx.beginPath(); ctx.arc(x, y, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = ring; ctx.lineWidth = ringW; ctx.stroke();
  }
  ctx.restore();
}

export type { DimLabel };
