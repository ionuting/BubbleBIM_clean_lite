/**
 * drawingDimensions.ts — the dimension chains a drawing carries by itself.
 *
 * A section or an elevation is not finished when the geometry is right: it is
 * finished when someone can build from it. The numbers that do that work are
 * always the same ones, and they are already in the drawing — the axis grid
 * across the bottom, the storey levels up the side, the openings in a facade.
 * Drawing them by hand, every time, on every view, is the kind of work a tool
 * should not ask for.
 *
 * So this derives them. Everything is a `DimChain`: a run of stations along
 * one of the drawing's two axes, a line to hang them on, and the edge the
 * extension lines reach back to. The renderer knows nothing about axes,
 * storeys or windows — it draws chains.
 *
 * Positions are drawing millimetres, like the rest of the engine's output.
 * The OFFSETS between chains are paper millimetres, because the gap between
 * two dimension rows is a property of the sheet, not of the building.
 */

import type { DrawingResult } from '@/lib/drawingEngine';
import type { DrawingStyle } from '@/lib/drawingStyle';

/** How far off the drawing the first chain sits, and how far apart rows are. */
export const DIM_ROW_MM = 9;
export const DIM_FIRST_ROW_MM = 11;

/** A chain is ignored below this span: two axes 3 mm apart are one axis. */
const MIN_SPAN_MM = 1;

export interface DimChain {
  /** What the chain measures along: the drawing's horizontal or vertical axis. */
  along: 'u' | 'v';
  /** Where the dimension line sits on the OTHER axis (drawing mm). */
  line: number;
  /** Where the extension lines start — the edge of the drawing they measure. */
  from: number;
  /** Stations in ascending order; consecutive pairs are the dimensioned spans. */
  stations: number[];
  /** What this chain is, for the reader and for the tests. */
  kind: 'axes' | 'levels' | 'openings' | 'overall';
}

/** The spans a chain actually prints. */
export function dimSpans(chain: DimChain): { a: number; b: number; mm: number }[] {
  const out: { a: number; b: number; mm: number }[] = [];
  for (let i = 0; i + 1 < chain.stations.length; i++) {
    const a = chain.stations[i], b = chain.stations[i + 1];
    if (b - a >= MIN_SPAN_MM) out.push({ a, b, mm: b - a });
  }
  return out;
}

/** Ascending, with near-duplicates merged — two axes a millimetre apart are one station. */
function stations(values: number[]): number[] {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] >= MIN_SPAN_MM) out.push(v);
  }
  return out;
}

export interface AutoDimensionOptions {
  /** Dimension the axis grid across the bottom. */
  axes?: boolean;
  /** Dimension the storey levels up the left. */
  levels?: boolean;
  /** Dimension the openings in the facade — only useful on an elevation. */
  openings?: boolean;
}

/**
 * The chains a drawing gets for free.
 *
 * Each direction gets its detail row and, when that row has more than one
 * span, an overall row outside it — the total is what a reader checks the
 * parts against, and it is the one number that is never the sum of what is
 * already written.
 */
export function autoDimensions(
  drawing: DrawingResult,
  style: DrawingStyle,
  opts: AutoDimensionOptions = {},
): DimChain[] {
  const { axes = true, levels = true, openings = false } = opts;
  const chains: DimChain[] = [];
  const row = (n: number) => style.paper(DIM_FIRST_ROW_MM + n * DIM_ROW_MM);

  // ── Across the bottom ───────────────────────────────────────────────────
  let bottomRow = 0;
  if (openings) {
    // The facade's own holes, nearest the drawing: reveal to reveal is what a
    // bricklayer sets out from, so it belongs below the axes, not above them.
    //
    // Grouped by node first. A window reaches the drawing as several shapes —
    // a frame, a pane or two, a sill — and measuring each of them would
    // dimension the joinery rather than the opening: 60 / 410 / 60 where the
    // wall was actually opened once, 1200 wide.
    const byNode = new Map<string, { lo: number; hi: number }>();
    for (const [nodeId, box] of visibleOpenings(drawing)) {
      const cur = byNode.get(nodeId);
      byNode.set(nodeId, cur ? { lo: Math.min(cur.lo, box.lo), hi: Math.max(cur.hi, box.hi) } : box);
    }
    // Bracketed by the outer axes, so the end piers are dimensioned too: the
    // distance from the grid to the first reveal is the one a setter-out needs
    // and the one the opening widths alone never give.
    const grid = drawing.axes.map((a) => a.u);
    const bracket = grid.length >= 2 ? [Math.min(...grid), Math.max(...grid)] : [];
    const st = stations([...[...byNode.values()].flatMap((o) => [o.lo, o.hi]), ...bracket]);
    // No hole to measure — a blank facade — is no chain: the bracket alone
    // would only repeat the overall length the axis rows already give.
    if (byNode.size > 0 && st.length >= 2) {
      chains.push({ along: 'u', line: drawing.vMin - row(bottomRow++), from: drawing.vMin, stations: st, kind: 'openings' });
    }
  }
  if (axes) {
    const st = stations(drawing.axes.map((a) => a.u));
    if (st.length >= 2) {
      chains.push({ along: 'u', line: drawing.vMin - row(bottomRow++), from: drawing.vMin, stations: st, kind: 'axes' });
      if (st.length > 2) {
        chains.push({
          along: 'u', line: drawing.vMin - row(bottomRow++), from: drawing.vMin,
          stations: [st[0], st[st.length - 1]], kind: 'overall',
        });
      }
    }
  }

  // ── Up the left ─────────────────────────────────────────────────────────
  if (levels) {
    const st = stations(drawing.levels.map((l) => l.vMm));
    if (st.length >= 2) {
      chains.push({ along: 'v', line: drawing.uMin - row(0), from: drawing.uMin, stations: st, kind: 'levels' });
      if (st.length > 2) {
        chains.push({
          along: 'v', line: drawing.uMin - row(1), from: drawing.uMin,
          stations: [st[0], st[st.length - 1]], kind: 'overall',
        });
      }
    }
  }

  return chains;
}

/** Even-odd containment of a drawing point in a closed shape. */
function insideShape(pts: { u: number; v: number }[], u: number, v: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i];
    if ((a.v > v) !== (b.v > v) && u < a.u + ((v - a.v) / (b.v - a.v)) * (b.u - a.u)) inside = !inside;
  }
  return inside;
}

/**
 * The openings a reader can actually see, as `nodeId → [lo, hi]` in u.
 *
 * Every window in the model reaches the drawing — the engine draws the far
 * wall's openings too, and lets the painter's sort bury them under the near
 * wall. A dimension chain has no painter: it measured all of them, so the
 * blank west facade carried the east facade's reveals along its bottom. An
 * opening counts as seen when nothing opaque stands nearer at its centre.
 *
 * Closed shapes only: a window's sill is an open line that deliberately
 * runs past the reveal on both sides, and it is not the hole.
 */
export function visibleOpenings(drawing: DrawingResult): Map<string, { lo: number; hi: number }> {
  const boxes = new Map<string, { lo: number; hi: number; vLo: number; vHi: number; depth: number }>();
  for (const s of drawing.shapes) {
    if ((s.nodeType !== 'window' && s.nodeType !== 'door') || !s.closed) continue;
    const us = s.pts.map((p) => p.u), vs = s.pts.map((p) => p.v);
    const cur = boxes.get(s.nodeId);
    const next = { lo: Math.min(...us), hi: Math.max(...us), vLo: Math.min(...vs), vHi: Math.max(...vs), depth: s.depthMm };
    boxes.set(s.nodeId, cur ? {
      lo: Math.min(cur.lo, next.lo), hi: Math.max(cur.hi, next.hi),
      vLo: Math.min(cur.vLo, next.vLo), vHi: Math.max(cur.vHi, next.vHi),
      depth: Math.min(cur.depth, next.depth),
    } : next);
  }
  const out = new Map<string, { lo: number; hi: number }>();
  for (const [id, b] of boxes) {
    const cu = (b.lo + b.hi) / 2, cv = (b.vLo + b.vHi) / 2;
    const hidden = drawing.shapes.some((s) =>
      s.closed && s.nodeId !== id && s.nodeType !== 'window' && s.nodeType !== 'door'
      && s.fillColor !== 'none' && s.depthMm < b.depth - 1 && insideShape(s.pts, cu, cv));
    if (!hidden) out.set(id, { lo: b.lo, hi: b.hi });
  }
  return out;
}

/**
 * How far past the drawing the chains reach, so the sheet can leave room for
 * them: `{ u, v }` in drawing mm, measured from `uMin` / `vMin`.
 */
export function dimensionReach(chains: DimChain[], drawing: DrawingResult): { u: number; v: number } {
  let u = 0, v = 0;
  for (const c of chains) {
    if (c.along === 'u') v = Math.max(v, drawing.vMin - c.line);
    else u = Math.max(u, drawing.uMin - c.line);
  }
  return { u, v };
}
