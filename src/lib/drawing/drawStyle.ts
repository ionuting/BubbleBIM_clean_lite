/**
 * drawStyle.ts — how everything that is not a dimension is drawn.
 *
 * The same style-plus-override model as `dimStyle`, for text, leaders, lines,
 * arcs, polylines, rectangles, circles and hatches:
 *
 *     resolved = DEFAULTS  ←  style  ←  the annotation's own overrides
 *
 * One style covers all of them rather than one per kind, because the fields
 * overlap almost completely — a rectangle and a circle differ in geometry, not
 * in how they are inked — and a panel offering nine nearly identical styles
 * would be worse to use than one. Which groups are RELEVANT does vary by kind,
 * and `RELEVANT` below says so, so the panel can show a circle its fill and
 * not its hatch angle.
 *
 * ## Sizes are multipliers, with one exception
 *
 * As in `dimStyle`, every size is a factor of the base stroke or font the host
 * view supplies, because those bases differ per view. The exception is the
 * legacy per-annotation `fontSize`, which was stored in ABSOLUTE host units
 * before styles existed. It cannot be converted to a multiplier here without
 * knowing the host's base, so the renderer keeps honouring it directly — see
 * `textSize` below.
 */

export type LineStyle = 'solid' | 'dashed' | 'dotted';

/**
 * The hatch patterns the SVG layer can build.
 *
 * Defined here rather than in the store so that this module stays free of it —
 * the store imports styles, and the reverse would be a cycle. `@/store`
 * re-exports the type, so every existing importer is unaffected.
 */
export type HatchPatternId =
  | 'diagonal' | 'crosshatch' | 'dots' | 'solid' | 'none'
  | 'concrete' | 'brick' | 'stone' | 'wave'
  | 'wood' | 'insulation' | 'earth' | 'steel' | 'glass' | 'sand';

/** The annotation kinds this style covers — everything but `dimension`. */
export type DrawKind =
  | 'text' | 'leader' | 'line' | 'arc' | 'polyline' | 'rect' | 'circle' | 'hatch';

export interface DrawStyleProps {
  // ── Stroke: every drawn element has one ──
  lineColor: string;
  /** × the host's base stroke width. */
  lineWeight: number;
  lineStyle: LineStyle;

  // ── Fill: closed shapes ──
  fillColor: string;
  fillOpacity: number;

  // ── Text: the text tool and a leader's label ──
  textColor: string;
  /** × the host's base font size. Overridden by a legacy absolute `fontSize`. */
  textSize: number;
  textBold: boolean;

  // ── Leader ──
  /** Arrowhead length, × the host's base font size. */
  arrowSize: number;

  // ── Hatch ──
  hatchPattern: HatchPatternId;
  hatchSpacing: number;
  hatchAngle: number;
  hatchOpacity: number;
}

export interface DrawStyle extends DrawStyleProps {
  id: string;
  name: string;
  builtin?: boolean;
}

/**
 * Which groups of fields mean anything for each kind.
 *
 * A panel that showed hatch angle while a circle was selected would be asking
 * about something that cannot take effect, and the reader would reasonably
 * conclude the control was broken.
 */
export const RELEVANT: Record<DrawKind, { stroke: boolean; fill: boolean; text: boolean; arrow: boolean; hatch: boolean }> = {
  text:     { stroke: false, fill: false, text: true,  arrow: false, hatch: false },
  leader:   { stroke: true,  fill: false, text: true,  arrow: true,  hatch: false },
  line:     { stroke: true,  fill: false, text: false, arrow: false, hatch: false },
  arc:      { stroke: true,  fill: false, text: false, arrow: false, hatch: false },
  polyline: { stroke: true,  fill: true,  text: false, arrow: false, hatch: false },
  rect:     { stroke: true,  fill: true,  text: false, arrow: false, hatch: false },
  circle:   { stroke: true,  fill: true,  text: false, arrow: false, hatch: false },
  hatch:    { stroke: true,  fill: false, text: false, arrow: false, hatch: true },
};

/**
 * The defaults.
 *
 * `lineWeight: 0.25` is a deliberate change from what the renderer used to do,
 * which was `(ann.lineWeight ?? 1) * baseStroke`. Annotation linework at the
 * host's full base weight reads as heavy as the building it sits on; a quarter
 * of it is what a drawn annotation should look like. Anything already carrying
 * an explicit `lineWeight` keeps it, so only elements that never had one move.
 */
export const DEFAULT_DRAW_STYLE_PROPS: DrawStyleProps = {
  lineColor: '#374151',
  lineWeight: 0.25,
  lineStyle: 'solid',

  fillColor: '#ffffff',
  fillOpacity: 0,

  textColor: '#1a1a2e',
  textSize: 1,
  textBold: false,

  arrowSize: 0.5,

  hatchPattern: 'diagonal',
  hatchSpacing: 1,
  hatchAngle: 0,
  hatchOpacity: 0.4,
};

export const DEFAULT_DRAW_STYLE_ID = 'draw-default';

export const BUILTIN_DRAW_STYLES: DrawStyle[] = [
  { ...DEFAULT_DRAW_STYLE_PROPS, id: DEFAULT_DRAW_STYLE_ID, name: 'Desen', builtin: true },
];

export type DrawOverride = Partial<DrawStyleProps>;

/**
 * The per-annotation fields that existed before styles.
 *
 * Every one of them is still honoured, folded in UNDER the override, so a
 * drawing made earlier keeps the appearance it had.
 */
export interface DrawStyled {
  kind?: string;
  styleId?: string;
  override?: DrawOverride;
  color?: string;
  lineWeight?: number;
  strokeStyle?: LineStyle;
  fill?: string;
  fillColor?: string;
  fillOpacity?: number;
  bold?: boolean;
  pattern?: HatchPatternId;
  hatchSpacing?: number;
  hatchAngle?: number;
}

function defined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * What to actually draw with.
 *
 * `color` sets BOTH the stroke and the text colour, because that is what the
 * old renderer did with it — a leader's line and its label were one `col`.
 */
export function resolveDrawStyle(
  ann: DrawStyled | undefined,
  styles: DrawStyle[],
): DrawStyleProps {
  const style = styles.find((s) => s.id === ann?.styleId)
    ?? styles.find((s) => s.id === DEFAULT_DRAW_STYLE_ID)
    ?? styles[0];

  const legacy: DrawOverride = {};
  if (ann?.color) { legacy.lineColor = ann.color; legacy.textColor = ann.color; }
  if (ann?.lineWeight !== undefined) legacy.lineWeight = ann.lineWeight;
  if (ann?.strokeStyle !== undefined) legacy.lineStyle = ann.strokeStyle;
  // `fill` on shapes, `fillColor` on hatches — two names for one idea.
  const fill = ann?.fill ?? ann?.fillColor;
  if (fill !== undefined) legacy.fillColor = fill;
  if (ann?.fillOpacity !== undefined) legacy.fillOpacity = ann.fillOpacity;
  if (ann?.bold !== undefined) legacy.textBold = ann.bold;
  if (ann?.pattern !== undefined) legacy.hatchPattern = ann.pattern;
  if (ann?.hatchSpacing !== undefined) legacy.hatchSpacing = ann.hatchSpacing;
  if (ann?.hatchAngle !== undefined) legacy.hatchAngle = ann.hatchAngle;

  return {
    ...DEFAULT_DRAW_STYLE_PROPS,
    ...defined(style),
    ...legacy,
    ...defined(ann?.override),
  };
}

/** Which fields this annotation sets for itself, for the UI to mark. */
export function drawOverriddenKeys(ann: DrawStyled | undefined): (keyof DrawStyleProps)[] {
  return Object.keys(defined(ann?.override)) as (keyof DrawStyleProps)[];
}

/** The styles a project should have, with any missing built-in put back. */
export function withDrawBuiltins(styles: DrawStyle[] | undefined): DrawStyle[] {
  const have = styles ?? [];
  const missing = BUILTIN_DRAW_STYLES.filter((b) => !have.some((s) => s.id === b.id));
  return [...missing, ...have];
}

/** SVG `stroke-dasharray` for a style, at a given stroke width. */
export function dashFor(style: LineStyle, w: number): string | undefined {
  if (style === 'dashed') return `${w * 6} ${w * 3}`;
  if (style === 'dotted') return `${w * 1} ${w * 3}`;
  return undefined;
}
