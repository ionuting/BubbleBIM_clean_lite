/**
 * drawingSvg.tsx — one renderer for everything the 2D engine produces.
 *
 * Section2DViewer and Elevation2DViewer used to carry a copy each of the same
 * ~130 lines: ground, axis grid, level lines, the shapes themselves, the
 * elevation bar. They were already drifting — different fill opacities, one
 * drew the ground line unconditionally and the other did not — so the drawing
 * looked slightly different depending on which view you opened. It lives here
 * once instead, and both call it.
 *
 * Every size is taken from the view's `DrawingStyle`, so pen widths and text
 * heights are paper millimetres rather than model ones (see drawingStyle.ts).
 *
 * Coordinates: the engine's (u, v) in model mm; `toX`/`toY` put them in the
 * viewer's SVG space, Y flipped.
 */
import React from 'react';
import type { DrawingResult, DrawingShape } from '@/lib/drawingEngine';
import { TEXT, type DrawingStyle } from '@/lib/drawingStyle';
import { dimSpans, type DimChain } from '@/lib/drawingDimensions';

/** Paper millimetres of blank margin kept around the drawing. */
export const SHEET_PAD_MM = 12;

/** Cut faces read through their hatch; seen faces are opaque so nearer ones cover farther. */
const CUT_FILL_OPACITY = 0.92;
const CUT_HATCH_OPACITY = 0.5;
const SEEN_HATCH_OPACITY = 0.3;


/** Paper millimetres: the slash at a station, its overshoot, the text's gap. */
const TICK_MM = 1.6;
const OVERSHOOT_MM = 2;
const DIM_TEXT_GAP_MM = 1.2;

export interface SheetBounds {
  uMin: number; uMax: number; vMin: number; vMax: number;
  width: number; height: number;
}

/** Paper millimetres the level bar and its `+12.345` labels need past the drawing's right edge. */
export const LEVEL_BAR_MM = 14;

/**
 * The drawing's extent plus a paper-sized margin — the viewer's viewBox.
 *
 * `reach` is how far the dimension chains hang off the bottom and the left
 * (see `dimensionReach`), and `top` what a caption needs above; without them
 * the outermost chain, or the level labels down the right, would be drawn
 * outside the viewBox and simply not appear.
 */
export function sheetBounds(
  drawing: DrawingResult,
  style: DrawingStyle,
  reach: { u: number; v: number; top?: number } = { u: 0, v: 0 },
): SheetBounds {
  const pad = style.paper(SHEET_PAD_MM);
  const bar = drawing.levels.length ? style.paper(LEVEL_BAR_MM) : 0;
  const uMin = drawing.uMin - pad - reach.u, uMax = drawing.uMax + pad + bar;
  const vMin = drawing.vMin - pad - reach.v, vMax = drawing.vMax + pad + (reach.top ?? 0);
  return {
    uMin, uMax, vMin, vMax,
    width: Math.max(uMax - uMin, 1),
    height: Math.max(vMax - vMin, 1),
  };
}

export interface DrawingSvgArgs {
  drawing: DrawingResult;
  style: DrawingStyle;
  bounds: SheetBounds;
  toX: (u: number) => number;
  toY: (v: number) => number;
  /** Draw the ground line and the earth below it (a section through a facade). */
  ground?: boolean;
  /** Dimension chains to hang off the drawing. */
  dimensions?: DimChain[];
}

/**
 * The whole drawing as SVG elements, back to front: ground, grid, levels, the
 * geometry, then the elevation bar.
 *
 * The geometry goes in its own `[data-fit-target]` group because the chrome
 * around it spans the view's full range — on a default facade that is
 * −5000…15000 mm however tall the building is — and framing all of it would
 * leave the building a stamp in the middle of the screen.
 */
export function buildDrawingSvg({
  drawing, style, bounds, toX, toY, ground = true, dimensions = [],
}: DrawingSvgArgs): React.ReactElement[] {
  const els: React.ReactElement[] = [];
  const { vMin, vMax } = bounds;
  const pad = style.paper(SHEET_PAD_MM);

  // ── Ground line and the earth under it ──────────────────────────────────
  if (ground) {
    const gx0 = toX(drawing.uMin - pad * 0.5);
    const gx1 = toX(drawing.uMax + pad * 0.5);
    const gy0 = toY(0);
    if (vMin < 0) {
      els.push(
        <rect key="earth" x={Math.min(gx0, gx1)} y={gy0}
          width={Math.abs(gx1 - gx0)} height={toY(vMin) - gy0}
          fill={style.look.earth} opacity={0.18} />,
      );
    }
    els.push(
      <line key="ground" x1={Math.min(gx0, gx1)} y1={gy0} x2={Math.max(gx0, gx1)} y2={gy0}
        stroke={style.look.ground} strokeWidth={style.line('heavy-cut') * 1.5} />,
    );
  }

  // ── Axis grid ───────────────────────────────────────────────────────────
  // A vertical view meets each grid line at one `u` and draws it down the
  // page. A floor plan sees the grid itself, so an axis carrying a `v` is a
  // horizontal line at that ordinate with its bubble out to the left.
  const bubbleR = style.paper(3.5);
  for (let i = 0; i < drawing.axes.length; i++) {
    const ax = drawing.axes[i];
    const horizontal = ax.v !== undefined;
    const cx = horizontal ? toX(drawing.uMin - pad * 0.35) : toX(ax.u);
    const cy = horizontal ? toY(ax.v as number) : toY(vMin + pad * 0.35);
    els.push(
      horizontal
        ? <line key={`ax-${i}`}
            x1={toX(drawing.uMin - pad * 0.3)} y1={cy} x2={toX(drawing.uMax + pad * 0.3)} y2={cy}
            stroke={style.look.axis} strokeWidth={style.line('annotation') * 0.75}
            strokeDasharray={`${style.paper(4)} ${style.paper(2)}`} opacity={0.4} />
        : <line key={`ax-${i}`}
            x1={cx} y1={toY(vMax - pad * 0.3)} x2={cx} y2={toY(vMin + pad * 0.3)}
            stroke={style.look.axis} strokeWidth={style.line('annotation') * 0.75}
            strokeDasharray={`${style.paper(4)} ${style.paper(2)}`} opacity={0.4} />,
    );
    els.push(
      <g key={`axlb-${i}`}>
        <circle cx={cx} cy={cy} r={bubbleR}
          fill="white" stroke={style.look.axis} strokeWidth={style.line('annotation')} opacity={0.8} />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
          fontSize={style.text(TEXT.small)} fontFamily="sans-serif" fill={style.look.axisText} fontWeight="500">
          {ax.label}
        </text>
      </g>,
    );
  }

  // ── Storey level lines ──────────────────────────────────────────────────
  for (const lv of drawing.levels) {
    const y = toY(lv.vMm);
    const x0 = toX(drawing.uMin - pad * 0.3);
    const x1 = toX(drawing.uMax + pad * 0.3);
    els.push(
      <line key={`lv-${lv.vMm}`} x1={Math.min(x0, x1)} y1={y} x2={Math.max(x0, x1)} y2={y}
        stroke={style.look.level} strokeWidth={style.line('annotation')}
        strokeDasharray={`${style.paper(6)} ${style.paper(2.5)}`} opacity={0.5} />,
    );
  }

  // ── The geometry ────────────────────────────────────────────────────────
  els.push(<g key="geom" data-fit-target="">{buildShapes(drawing.shapes, style, toX, toY)}</g>);

  // ── Dimension chains ────────────────────────────────────────────────────
  els.push(...buildDimensions(dimensions, style, toX, toY));

  // ── Elevation bar down the right-hand side ──────────────────────────────
  const barX = toX(drawing.uMax + pad * 0.55);
  const tick = style.paper(1.5);
  for (const lv of drawing.levels) {
    const y = toY(lv.vMm);
    els.push(
      <line key={`tk-${lv.vMm}`} x1={barX - tick} y1={y} x2={barX + tick} y2={y}
        stroke="#64748b" strokeWidth={style.line('annotation')} />,
      <text key={`tv-${lv.vMm}`} x={barX + tick * 1.5} y={y}
        textAnchor="start" dominantBaseline="central"
        fontSize={style.text(TEXT.small)} fontFamily="monospace" fill={style.look.levelText}>
        {lv.label}
      </text>,
    );
  }

  return els;
}

/**
 * The shapes themselves, in the order the engine sorted them (back to front).
 *
 * A closed shape is up to three elements: its face, its hatch, its outline.
 * Seen faces are painted opaque on purpose — that is what makes the painter's
 * sort read as occlusion rather than as an x-ray of the building.
 */
function buildShapes(
  shapes: DrawingShape[],
  style: DrawingStyle,
  toX: (u: number) => number,
  toY: (v: number) => number,
): React.ReactElement[] {
  const els: React.ReactElement[] = [];
  for (let i = 0; i < shapes.length; i++) {
    const sh = shapes[i];
    if (sh.pts.length < 2) continue;

    const xs = sh.pts.map((p) => toX(p.u));
    const ys = sh.pts.map((p) => toY(p.v));
    const dash = style.dash(sh.lineWeight);
    const seen = sh.lineWeight === 'projected' || sh.lineWeight === 'hidden';
    const sw = style.line(sh.lineWeight) * (seen ? 1 : style.look.cutWeight);
    const look = style.look;
    const fill = look.fill(sh, seen);
    const stroke = look.stroke(sh, seen);
    const hatch = look.hatch(sh, seen);

    if (sh.closed && sh.pts.length >= 3) {
      // A face with openings has to be one path under the even-odd rule: two
      // separate polygons would paint the hole's fill straight back over the
      // hole. Without holes the path is the same shape a polygon was.
      const ring = (pts: { u: number; v: number }[]): string =>
        `M ${pts.map((p) => `${toX(p.u).toFixed(2)},${toY(p.v).toFixed(2)}`).join(' L ')} Z`;
      const holed = (sh.holes?.length ?? 0) > 0;
      const d = holed
        ? [ring(sh.pts), ...(sh.holes ?? []).map(ring)].join(' ')
        : ring(sh.pts);

      if (fill && fill !== 'none') {
        els.push(
          <path key={`bg-${i}`} d={d} fillRule="evenodd"
            fill={fill} opacity={seen ? 1 : CUT_FILL_OPACITY} />,
        );
      }
      if (hatch && hatch !== 'none' && hatch !== 'solid') {
        els.push(
          <path key={`ht-${i}`} d={d} fillRule="evenodd"
            fill={`url(#hatch-${hatch})`} color={stroke}
            opacity={seen ? SEEN_HATCH_OPACITY : CUT_HATCH_OPACITY} />,
        );
      }
      els.push(
        <path key={`ol-${i}`} d={d}
          fill="none" stroke={stroke} strokeWidth={sw}
          strokeDasharray={dash} opacity={seen ? 0.85 : 1} />,
      );
    } else {
      const d = `M ${xs[0].toFixed(2)},${ys[0].toFixed(2)} ` +
        xs.slice(1).map((x, j) => `L ${x.toFixed(2)},${ys[j + 1].toFixed(2)}`).join(' ');
      els.push(
        <path key={`ln-${i}`} d={d}
          fill="none" stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />,
      );
    }
  }
  return els;
}

/**
 * The dimension chains: a line, a slash at every station, extension lines back
 * to the drawing, and the span written above each pair.
 *
 * Slashes rather than arrowheads — the architectural convention, and the one
 * that stays readable when a chain has a dozen short spans. A vertical chain's
 * text is turned to read bottom-up, as it is on paper.
 */
function buildDimensions(
  chains: DimChain[],
  style: DrawingStyle,
  toX: (u: number) => number,
  toY: (v: number) => number,
): React.ReactElement[] {
  if (chains.length === 0) return [];
  const els: React.ReactElement[] = [];
  const sw = style.line('annotation');
  const tick = style.paper(TICK_MM);
  const over = style.paper(OVERSHOOT_MM);
  const gap = style.paper(DIM_TEXT_GAP_MM);
  const fs = style.text(TEXT.small);

  chains.forEach((chain, ci) => {
    const spans = dimSpans(chain);
    if (spans.length === 0) return;
    const horizontal = chain.along === 'u';
    /** A point on the chain: `s` along it, `off` across it from the line. */
    const pt = (s: number, off: number) => (horizontal
      ? { x: toX(s), y: toY(chain.line + off) }
      : { x: toX(chain.line + off), y: toY(s) });

    const a = pt(chain.stations[0], 0);
    const b = pt(chain.stations[chain.stations.length - 1], 0);
    const g: React.ReactElement[] = [
      <line key="line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={style.look.dim} strokeWidth={sw} />,
    ];

    for (const [i, s] of chain.stations.entries()) {
      // Extension line, from the drawing's edge to just past the chain.
      const e0 = pt(s, chain.from - chain.line);
      // A chain always hangs on the low side of the drawing, so the
      // extension line overshoots it downward — away from the building.
      const e1 = pt(s, -over);
      g.push(
        <line key={`e${i}`} x1={e0.x} y1={e0.y} x2={e1.x} y2={e1.y}
          stroke={style.look.dim} strokeWidth={sw * 0.7} opacity={0.6} />,
      );
      // The slash: 45° through the station, whichever way the chain runs.
      const p0 = pt(s - tick, -tick), p1 = pt(s + tick, tick);
      g.push(
        <line key={`t${i}`} x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y}
          stroke={style.look.dim} strokeWidth={sw * 1.4} />,
      );
    }

    for (const [i, sp] of spans.entries()) {
      const mid = pt((sp.a + sp.b) / 2, gap);
      g.push(
        <text key={`v${i}`} x={mid.x} y={mid.y}
          textAnchor="middle" dominantBaseline={horizontal ? 'auto' : 'central'}
          transform={horizontal ? undefined : `rotate(-90 ${mid.x} ${mid.y})`}
          fontSize={fs} fontFamily="sans-serif" fill={style.look.dim}>
          {Math.round(sp.mm)}
        </text>,
      );
    }

    els.push(<g key={`dim-${ci}`}>{g}</g>);
  });

  return els;
}
