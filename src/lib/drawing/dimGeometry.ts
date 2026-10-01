/**
 * dimGeometry.ts — a dimension, resolved into the shapes that draw it.
 *
 * Kept apart from the renderer so that "where does an arrowhead go" is a
 * question with a testable answer. The renderer's job becomes emitting the
 * SVG for what comes out of here, which is the part a test could not check
 * without a browser anyway.
 *
 * ## The sign bug this fixes
 *
 * The old inline arithmetic added a fixed overshoot to the offset:
 *
 *     e1b = s1 + n * (offset + OVERSHOOT)
 *
 * which only extends past the dimension line while `offset` is positive. Put
 * the dimension on the other side — offset −100, overshoot 30 — and the
 * extension line stops at −70, i.e. 30 units SHORT of the line it is supposed
 * to run past, leaving a visible gap. The same sign error made the gap at the
 * measured point step the wrong way, so the extension line began slightly past
 * the point instead of just before it. Both are carried along the offset's own
 * direction here.
 */
import type { DimStyleProps } from './dimStyle';
import { dashFor } from './drawStyle';

export interface Pt { x: number; y: number }
export interface Seg { a: Pt; b: Pt }

/** A dimension line's terminator, as something drawable. */
export type TickShape =
  | { kind: 'line'; a: Pt; b: Pt }
  | { kind: 'polygon'; points: Pt[] }
  | { kind: 'dot'; c: Pt; r: number };

export interface DimText {
  x: number;
  y: number;
  /** Degrees, already kept within ±90 so the number never reads upside down. */
  angle: number;
  size: number;
  color: string;
  bold: boolean;
}

/**
 * The mask behind inline text, in the TEXT's own rotated frame — the renderer
 * emits it inside the same `translate(...) rotate(...)` group, so it stays
 * with the number instead of being an axis-aligned box that drifts as the
 * dimension turns.
 */
export interface DimTextBackground {
  x: number; y: number; width: number; height: number; rx: number;
}

export interface DimDrawing {
  dimLine: Seg;
  extensions: Seg[];
  ticks: TickShape[];
  text: DimText | null;
  background: DimTextBackground | null;
  strokeWidth: number;
  tickStrokeWidth: number;
  /** SVG `stroke-dasharray` for the dimension line, or undefined when solid. */
  dash: string | undefined;
}

export interface DimGeometryInput {
  /** The two measured points, already projected into SVG. */
  s1: Pt;
  s2: Pt;
  /** Unit normal in SVG, from `offsetNormalSvg`. */
  n: Pt;
  /** Signed offset of the dimension line from the baseline, SVG units. */
  offset: number;
  /** The host view's base stroke width and font size, its own SVG units. */
  baseStroke: number;
  baseFont: number;
  props: DimStyleProps;
  label: string;
}

/**
 * A terminator at one end.
 *
 * Two directions matter and they are not the same one. `u` runs along the
 * dimension, the same way at both ends; `out` points out of the dimension,
 * opposite at each end. An arrowhead has to face `out` or the two would point
 * at each other. An oblique tick uses `u`, because architectural ticks are
 * PARALLEL slashes — mirroring the far one turns the pair into a splay, which
 * is what reading `out` here would do.
 */
function tickAt(at: Pt, u: Pt, out: Pt, n: Pt, p: DimStyleProps, sw: number): TickShape | null {
  const size = p.tickSize * sw;
  switch (p.tick) {
    case 'none':
      return null;
    case 'dot':
      return { kind: 'dot', c: at, r: size * 0.25 };
    case 'arrow': {
      // A slim triangle: tip on the measured point, base back up the line.
      const w = size * 0.3;
      return {
        kind: 'polygon',
        points: [
          at,
          { x: at.x - out.x * size + n.x * w, y: at.y - out.y * size + n.y * w },
          { x: at.x - out.x * size - n.x * w, y: at.y - out.y * size - n.y * w },
        ],
      };
    }
    case 'oblique':
    default: {
      // The classic 45° slash: the sum of the along and normal directions,
      // deliberately NOT normalised — that is what the old renderer drew, and
      // normalising it would shorten every existing tick by a factor of √2.
      const dx = (u.x + n.x) * size * 0.5;
      const dy = (u.y + n.y) * size * 0.5;
      return {
        kind: 'line',
        a: { x: at.x + dx, y: at.y + dy },
        b: { x: at.x - dx, y: at.y - dy },
      };
    }
  }
}

/** Everything needed to draw one dimension. */
export function dimDrawing(input: DimGeometryInput): DimDrawing | null {
  const { s1, s2, n, offset, baseStroke: sw, baseFont, props: p, label } = input;

  const dx = s2.x - s1.x, dy = s2.y - s1.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return null;
  const ux = dx / len, uy = dy / len;

  const strokeWidth = p.lineWeight * sw;
  const fs = p.textSize * baseFont;

  // Everything measured from the baseline travels along the offset's own
  // direction, so a dimension placed on either side behaves identically.
  const dir = offset < 0 ? -1 : 1;

  const d1 = { x: s1.x + n.x * offset, y: s1.y + n.y * offset };
  const d2 = { x: s2.x + n.x * offset, y: s2.y + n.y * offset };

  const extensions: Seg[] = [];
  if (p.extension) {
    const gap = dir * p.extGap * sw;
    const end = offset + dir * p.extOvershoot * sw;
    extensions.push(
      { a: { x: s1.x + n.x * gap, y: s1.y + n.y * gap },
        b: { x: s1.x + n.x * end, y: s1.y + n.y * end } },
      { a: { x: s2.x + n.x * gap, y: s2.y + n.y * gap },
        b: { x: s2.x + n.x * end, y: s2.y + n.y * end } },
    );
  }

  const u = { x: ux, y: uy };
  const ticks: TickShape[] = [];
  const t1 = tickAt(d1, u, { x: -ux, y: -uy }, n, p, sw);
  const t2 = tickAt(d2, u, u, n, p, sw);
  if (t1) ticks.push(t1);
  if (t2) ticks.push(t2);

  // ── Text ──
  let angle = Math.atan2(uy, ux) * 180 / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle < -90) angle += 180;

  const mid = { x: (d1.x + d2.x) / 2, y: (d1.y + d2.y) / 2 };
  let tx = mid.x, ty = mid.y;
  if (p.textPlacement !== 'inline') {
    // Outward is the side the dimension line was pushed to, so "above" puts
    // the number clear of the thing being measured rather than on top of it.
    // Half the text's own height is added to the style's gap, so `textOffset`
    // means the clear space the reader sees and not the distance to a centre
    // that is still half-buried in the line.
    const away = p.textPlacement === 'above' ? dir : -dir;
    const d = away * (0.5 + p.textOffset) * fs;
    tx += n.x * d;
    ty += n.y * d;
  }

  const text: DimText = {
    x: tx, y: ty,
    angle: p.textAligned ? angle : 0,
    size: fs,
    color: p.textColor,
    bold: p.textBold,
  };

  // A mask only makes sense where the text actually crosses the line.
  const background = (p.textBackground && p.textPlacement === 'inline')
    ? {
        x: -(label.length * fs * 0.62) / 2, y: -(fs * 1.4) / 2,
        width: label.length * fs * 0.62, height: fs * 1.4,
        rx: fs * 0.15,
      }
    : null;

  return {
    dimLine: { a: d1, b: d2 },
    extensions,
    ticks,
    text,
    background,
    strokeWidth,
    tickStrokeWidth: strokeWidth * p.tickWeight,
    // Dash length comes from the host's BASE stroke, not from this line's own
    // weight — the CAD convention, where a linetype's scale is independent of
    // lineweight. Tying it to the weight would make a fine line's dashes
    // shrink until a dashed 0.25× line was indistinguishable from a solid one.
    dash: dashFor(p.lineStyle, sw),
  };
}
