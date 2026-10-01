/**
 * dxfExport.ts — a section or an elevation as a DXF, for whoever works next.
 *
 * ## Why R12
 *
 * DXF R12 (AC1009) is the interchange format: no handles, no subclass markers,
 * no OBJECTS section, and every CAD program ever written reads it. Later
 * versions can carry a per-entity lineweight and a true colour, which would be
 * nice — but a file that fails to open carries nothing at all, and there is no
 * CAD here to prove a newer file against.
 *
 * ## So how does the pen hierarchy survive?
 *
 * The way it has always survived: by layer. Each element goes to a layer named
 * for what it is and whether it is CUT or merely seen, and that layer is given
 * the AutoCAD colour index that the standard plot-style tables map to its pen
 * width. A draughtsman opening this file gets walls on `A-WALL-CUT` in colour 7
 * and plots them at 0.50 mm without being told to.
 *
 * ## Coordinates
 *
 * The engine's (u, v) are millimetres with v pointing up, which is exactly what
 * DXF model space is. Nothing is transformed: what the viewer shows at 1:50 is
 * what CAD measures at 1:1.
 */

import type { DrawingResult, DrawingShape, LineWeight } from '@/lib/drawingEngine';
import { PEN, PEN_OF, TEXT, type DrawingStyle } from '@/lib/drawingStyle';
import { dimSpans, type DimChain } from '@/lib/drawingDimensions';

// ─── Pens ─────────────────────────────────────────────────────────────────────

/**
 * AutoCAD colour index per pen width, the classic plotting convention.
 * A layer's colour IS its pen: this is what makes a weightless R12 file plot
 * with the right line hierarchy.
 */
export const DXF_PEN_COLORS: Record<number, number> = {
  [PEN.thick]: 7,    // white/black — the cut face, heaviest
  [PEN.medium]: 5,   // blue
  [PEN.thin]: 3,     // green
  [PEN.fine]: 1,     // red
  [PEN.hair]: 8,     // dark grey
};

const colorOf = (w: LineWeight): number => DXF_PEN_COLORS[PEN_OF[w]] ?? 7;

// ─── Layers ───────────────────────────────────────────────────────────────────

/** What each kind of element is called on paper. AIA-flavoured, as CAD expects. */
const LAYER_OF: Record<string, string> = {
  wall: 'A-WALL',
  window: 'A-GLAZ',
  door: 'A-DOOR',
  roof: 'A-ROOF',
  slab: 'A-FLOR',
  column: 'S-COLS',
  beam: 'S-BEAM',
  foundation: 'S-FNDN',
  sweep: 'A-SWEP',
  stair_flight: 'A-STRS',
  stair_landing: 'A-STRS',
  stair_winder: 'A-STRS',
};

export const DXF_GRID_LAYER = 'A-GRID';
export const DXF_LEVEL_LAYER = 'A-ANNO-LEVL';
export const DXF_DIM_LAYER = 'A-ANNO-DIMS';

/**
 * The layer a shape belongs on: what it is, plus how it was seen. A wall cut by
 * the plane and a wall standing behind it are the same element and two very
 * different lines, and a draughtsman needs to be able to freeze one of them.
 */
export function dxfLayerOf(shape: DrawingShape): string {
  const base = LAYER_OF[shape.nodeType] ?? `A-${shape.nodeType.toUpperCase().slice(0, 8)}`;
  if (shape.lineWeight === 'hidden') return `${base}-HIDN`;
  if (shape.lineWeight === 'heavy-cut' || shape.lineWeight === 'medium-cut') return `${base}-CUT`;
  return base;
}

// ─── Writing ──────────────────────────────────────────────────────────────────

/**
 * Whether a group code carries an integer rather than a real.
 *
 * This is not cosmetic: a flag or a colour index written as `7.0000` is a
 * malformed file, and a strict reader stops there. The ranges are DXF's own.
 */
function isIntCode(code: number): boolean {
  return (code >= 60 && code <= 79)
    || (code >= 90 && code <= 99)
    || (code >= 170 && code <= 179)
    || (code >= 270 && code <= 289)
    || (code >= 370 && code <= 389);
}

/** A DXF file is a flat list of (group code, value) pairs, two lines each. */
class DxfWriter {
  private out: string[] = [];

  pair(code: number, value: string | number): this {
    this.out.push(String(code));
    this.out.push(
      typeof value !== 'number' ? value
        : isIntCode(code) ? String(Math.round(value))
        : fmt(value),
    );
    return this;
  }

  section(name: string, body: () => void): this {
    this.pair(0, 'SECTION').pair(2, name);
    body();
    return this.pair(0, 'ENDSEC');
  }

  text(): string {
    return `${this.out.join('\n')}\n`;
  }
}

/** DXF reals: enough precision for millimetres, without exponent notation. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0.0';
  const s = n.toFixed(4);
  return s === '-0.0000' ? '0.0000' : s;
}

/**
 * R12 stores text in the drawing's own code page, which we cannot set from
 * here with any confidence — so text is folded to ASCII. The typographic minus
 * a level label uses becomes a hyphen, and Romanian diacritics lose their
 * marks, which is what every CAD title block does anyway.
 */
export function dxfText(s: string): string {
  return s
    .replace(/−/g, '-')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '');
}

// ─── Entities ─────────────────────────────────────────────────────────────────

type Pt = { u: number; v: number };

function polyline(w: DxfWriter, pts: Pt[], closed: boolean, layer: string, dashed: boolean): void {
  if (pts.length < 2) return;
  if (!closed && pts.length === 2) {
    w.pair(0, 'LINE').pair(8, layer);
    if (dashed) w.pair(6, 'DASHED');
    w.pair(10, pts[0].u).pair(20, pts[0].v).pair(30, 0)
      .pair(11, pts[1].u).pair(21, pts[1].v).pair(31, 0);
    return;
  }
  // R12 has no LWPOLYLINE: a polyline is a header, a vertex each, and an end.
  w.pair(0, 'POLYLINE').pair(8, layer);
  if (dashed) w.pair(6, 'DASHED');
  w.pair(66, 1).pair(70, closed ? 1 : 0)
    .pair(10, 0).pair(20, 0).pair(30, 0);
  for (const p of pts) {
    w.pair(0, 'VERTEX').pair(8, layer).pair(10, p.u).pair(20, p.v).pair(30, 0);
  }
  w.pair(0, 'SEQEND').pair(8, layer);
}

function circle(w: DxfWriter, cu: number, cv: number, r: number, layer: string): void {
  w.pair(0, 'CIRCLE').pair(8, layer).pair(10, cu).pair(20, cv).pair(30, 0).pair(40, r);
}

type Align = 'left' | 'center';

function label(
  w: DxfWriter, s: string, u: number, v: number, height: number, layer: string,
  align: Align = 'center', rotation = 0,
): void {
  const t = dxfText(s);
  if (!t) return;
  w.pair(0, 'TEXT').pair(8, layer)
    .pair(10, u).pair(20, v).pair(30, 0)
    .pair(40, height).pair(1, t);
  if (rotation) w.pair(50, rotation);
  if (align === 'center') {
    // Horizontal 1 = centred, vertical 2 = middle; both read the second point.
    w.pair(72, 1).pair(73, 2).pair(11, u).pair(21, v).pair(31, 0);
  }
}

// ─── Public ───────────────────────────────────────────────────────────────────

export interface DxfExportOptions {
  /** Dimension chains to draw, as plain geometry on the annotation layer. */
  dimensions?: DimChain[];
  /** Include the axis grid and its bubbles. Default true. */
  grid?: boolean;
  /** Include the storey level lines and their labels. Default true. */
  levels?: boolean;
}

/**
 * The drawing as a DXF R12 file.
 *
 * Dimensions are written as the lines and text they look like, not as DXF
 * DIMENSION entities: those need a dimension style, a block per dimension and
 * a set of variables to match, and a reader that disagrees about any of them
 * redraws the number somewhere else. Plain geometry says exactly what the
 * drawing said.
 */
export function drawingToDxf(
  drawing: DrawingResult,
  style: DrawingStyle,
  opts: DxfExportOptions = {},
): string {
  const { dimensions = [], grid = true, levels = true } = opts;
  const w = new DxfWriter();

  // Which layers the file actually needs, in the order they were first used.
  const layers = new Map<string, number>();
  const use = (name: string, color: number) => {
    if (!layers.has(name)) layers.set(name, color);
    return name;
  };
  for (const sh of drawing.shapes) use(dxfLayerOf(sh), colorOf(sh.lineWeight));
  if (grid && drawing.axes.length) use(DXF_GRID_LAYER, colorOf('annotation'));
  if (levels && drawing.levels.length) use(DXF_LEVEL_LAYER, colorOf('annotation'));
  if (dimensions.length) use(DXF_DIM_LAYER, colorOf('annotation'));

  // ── Header ──────────────────────────────────────────────────────────────
  w.section('HEADER', () => {
    w.pair(9, '$ACADVER').pair(1, 'AC1009');
    w.pair(9, '$INSUNITS').pair(70, 4);                 // millimetres
    w.pair(9, '$EXTMIN').pair(10, drawing.uMin).pair(20, drawing.vMin).pair(30, 0);
    w.pair(9, '$EXTMAX').pair(10, drawing.uMax).pair(20, drawing.vMax).pair(30, 0);
  });

  // ── Tables ──────────────────────────────────────────────────────────────
  w.section('TABLES', () => {
    w.pair(0, 'TABLE').pair(2, 'LTYPE').pair(70, 2);
    w.pair(0, 'LTYPE').pair(2, 'CONTINUOUS').pair(70, 0).pair(3, 'Solid line')
      .pair(72, 65).pair(73, 0).pair(40, 0);
    w.pair(0, 'LTYPE').pair(2, 'DASHED').pair(70, 0).pair(3, '__ __ __')
      .pair(72, 65).pair(73, 2).pair(40, style.paper(3))
      .pair(49, style.paper(2)).pair(49, -style.paper(1));
    w.pair(0, 'ENDTAB');

    w.pair(0, 'TABLE').pair(2, 'LAYER').pair(70, layers.size + 1);
    w.pair(0, 'LAYER').pair(2, '0').pair(70, 0).pair(62, 7).pair(6, 'CONTINUOUS');
    for (const [name, color] of layers) {
      w.pair(0, 'LAYER').pair(2, name).pair(70, 0).pair(62, color).pair(6, 'CONTINUOUS');
    }
    w.pair(0, 'ENDTAB');
  });

  // ── Entities ────────────────────────────────────────────────────────────
  w.section('ENTITIES', () => {
    for (const sh of drawing.shapes) {
      polyline(w, sh.pts, sh.closed, dxfLayerOf(sh), sh.lineWeight === 'hidden');
    }

    if (grid) {
      const r = style.paper(3.5);
      const bubbleV = drawing.vMin - style.paper(6);
      for (const ax of drawing.axes) {
        polyline(w, [{ u: ax.u, v: drawing.vMax }, { u: ax.u, v: bubbleV + r }], false, DXF_GRID_LAYER, true);
        circle(w, ax.u, bubbleV, r, DXF_GRID_LAYER);
        label(w, ax.label, ax.u, bubbleV, style.text(TEXT.small), DXF_GRID_LAYER);
      }
    }

    if (levels) {
      for (const lv of drawing.levels) {
        polyline(w, [{ u: drawing.uMin, v: lv.vMm }, { u: drawing.uMax, v: lv.vMm }], false, DXF_LEVEL_LAYER, true);
        label(w, lv.label, drawing.uMax + style.paper(2), lv.vMm, style.text(TEXT.small), DXF_LEVEL_LAYER, 'left');
      }
    }

    for (const chain of dimensions) writeChain(w, chain, style);
  });

  w.pair(0, 'EOF');
  return w.text();
}

/** One dimension chain: the line, a tick per station, extensions, and the spans. */
function writeChain(w: DxfWriter, chain: DimChain, style: DrawingStyle): void {
  const spans = dimSpans(chain);
  if (spans.length === 0) return;
  const horizontal = chain.along === 'u';
  const tick = style.paper(1.6);
  const over = style.paper(2);
  const gap = style.paper(1.2);
  const fs = style.text(TEXT.small);
  const pt = (s: number, off: number): Pt => (horizontal
    ? { u: s, v: chain.line + off }
    : { u: chain.line + off, v: s });

  const first = chain.stations[0];
  const last = chain.stations[chain.stations.length - 1];
  polyline(w, [pt(first, 0), pt(last, 0)], false, DXF_DIM_LAYER, false);

  for (const s of chain.stations) {
    polyline(w, [pt(s, chain.from - chain.line), pt(s, -over)], false, DXF_DIM_LAYER, false);
    polyline(w, [pt(s - tick, -tick), pt(s + tick, tick)], false, DXF_DIM_LAYER, false);
  }

  for (const sp of spans) {
    const mid = pt((sp.a + sp.b) / 2, gap);
    label(w, String(Math.round(sp.mm)), mid.u, mid.v, fs, DXF_DIM_LAYER, 'center', horizontal ? 0 : 90);
  }
}
