/**
 * drawingStyle.ts — what a drawing looks like once it has a scale.
 *
 * The 2D engine works in model millimetres, and so do the viewers' viewBoxes.
 * A pen width or a text height, though, is a property of the PAPER: a 0.35 mm
 * line is 0.35 mm whether the building behind it is 8 m or 80 m wide. Written
 * straight into a model-mm viewBox, the same number would shrink with the
 * building until it stopped being visible — 0.35 model mm across a 12 m
 * section is about a twentieth of a screen pixel.
 *
 * So everything here is stated in paper millimetres and converted once, by the
 * drawing's scale:
 *
 *     model mm = paper mm × scale        (scale 50 means 1 : 50)
 *
 * Sizes follow the ISO series architects already draw with — the pen widths of
 * ISO 128 and the text heights of ISO 3098 — so a sheet composed from these
 * views prints with the line hierarchy a reader expects.
 */

import type { LineWeight } from '@/lib/drawingEngine';
import { graphicStyleOf, type GraphicStyle } from '@/lib/drawing/graphicStyle';

// ─── Paper sizes ──────────────────────────────────────────────────────────────

/** ISO 128 pen widths, in paper millimetres. */
export const PEN = {
  thick: 0.50,
  medium: 0.35,
  thin: 0.25,
  fine: 0.18,
  hair: 0.13,
} as const;

/**
 * Which pen draws which kind of line. The cut face is the heaviest thing on a
 * section — that contrast IS the drawing — and everything merely seen behind it
 * steps down from there.
 */
export const PEN_OF: Record<LineWeight, number> = {
  'heavy-cut': PEN.thick,
  'medium-cut': PEN.medium,
  'projected': PEN.fine,
  'annotation': PEN.thin,
  'hidden': PEN.fine,
};

/** Dash patterns, in paper millimetres. */
const DASH_OF: Partial<Record<LineWeight, [number, number]>> = {
  hidden: [2, 1.2],
};

/** ISO 3098 text heights, in paper millimetres. */
export const TEXT = {
  small: 2.5,
  normal: 3.5,
  large: 5,
} as const;

/** Standard architectural scale denominators, smallest drawing last. */
export const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000];

/**
 * How far a SEEN face is lightened from its material's 2D colour.
 *
 * The convention of every section and elevation: what the plane cuts is
 * dark and hatched, what is merely seen beyond it is light, so the eye
 * reads the cut at once and the seen faces recede. The material palette
 * gives one `color_2d`, meant for the cut; a facade painted in it came out
 * as a wall of ink with black windows on it.
 */
export const VIEW_TINT = 0.55;

/** `hex` moved this fraction of the way to white; anything unparseable comes back as it was. */
export function tintHex(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const ch = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16);
    return Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  };
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

/**
 * The sheet a view is sized against when nobody has said otherwise: the usable
 * area of a landscape A3 inside its margins. It only sets which standard scale
 * a view picks for itself, so the exact figure matters less than its being
 * stable — a view that re-scaled on every window resize would redraw its whole
 * line hierarchy as you dragged.
 */
export const NOMINAL_SHEET_MM = { w: 380, h: 260 };

// ─── Style ────────────────────────────────────────────────────────────────────

export interface DrawingStyle {
  /** Denominator of 1 : N. */
  scale: number;
  /** "1 : 50" */
  label: string;
  /** Model mm for a width given in paper mm. */
  paper(mm: number): number;
  /** Model mm of stroke for a line of this kind. */
  line(w: LineWeight): number;
  /** Dash array in model mm, or undefined for a solid line. */
  dash(w: LineWeight): string | undefined;
  /** Model mm of cap height for a text of this paper size. */
  text(paperMm: number): number;
  /** How the drawing looks: colours, fills, hatches (lib/drawing/graphicStyle). */
  look: GraphicStyle;
}

export function drawingStyle(scale: number, look?: GraphicStyle | string | null): DrawingStyle {
  const k = Math.max(1, scale);
  const g = typeof look === 'object' && look ? look : graphicStyleOf(look as string | null | undefined);
  const paper = (mm: number) => mm * k;
  return {
    scale: k,
    label: `1 : ${k}`,
    paper,
    line: (w) => paper(PEN_OF[w]),
    dash: (w) => {
      const d = DASH_OF[w];
      return d ? `${paper(d[0]).toFixed(2)} ${paper(d[1]).toFixed(2)}` : undefined;
    },
    text: (paperMm) => paper(paperMm),
    look: g,
  };
}

/**
 * The standard scale at which a drawing of this size fits the sheet: the
 * largest drawing (smallest denominator) that still fits, so a small building
 * is not drawn at 1:500 just because the list starts there.
 *
 * A degenerate extent falls back to 1:50 rather than to 1:1, which would make
 * every line thicker than the building.
 */
export function fitScale(
  contentW: number,
  contentH: number,
  sheet: { w: number; h: number } = NOMINAL_SHEET_MM,
): number {
  if (!(contentW > 0) || !(contentH > 0) || !Number.isFinite(contentW) || !Number.isFinite(contentH)) return 50;
  const need = Math.max(contentW / sheet.w, contentH / sheet.h);
  return STANDARD_SCALES.find((s) => s >= need) ?? STANDARD_SCALES[STANDARD_SCALES.length - 1];
}
