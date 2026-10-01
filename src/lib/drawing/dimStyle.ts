/**
 * dimStyle.ts — what a dimension looks like, as a named style plus overrides.
 *
 * ## The model
 *
 * The same one CAD uses, and for the same reason: a drawing set has to be
 * consistent, but one dimension in the corner always needs to be different.
 * So every dimension names a style, and may carry its own overrides on top:
 *
 *     resolved = DEFAULTS  ←  style  ←  the annotation's own overrides
 *
 * Editing a style restyles every dimension that follows it, across every view.
 * Clearing an override puts one dimension back in line with its style.
 *
 * ## Why sizes are multipliers and not millimetres
 *
 * `SvgAnnotationLayer` is given a base stroke width and font size by whatever
 * view hosts it, and those bases are in that view's own SVG units — the floor
 * plan draws at 0.08 units per model millimetre, a section at 1. A style
 * holding absolute sizes would render twelve times larger in a section than in
 * a plan, so every size here is a factor of the host's base. It is also the
 * convention the annotation model already had: `lineWeight` was always read as
 * `(ann.lineWeight ?? 1) * baseStroke`.
 *
 * ## The defaults are not a fresh opinion
 *
 * `DEFAULT_DIM_STYLE` reproduces exactly what the renderer used to hardcode —
 * oblique ticks at 4×, extension gap 1.5× and overshoot 3×, tick stroke 1.8×,
 * aligned inline text on a white mask, metres to three decimals. A drawing
 * made before styles existed has to keep looking the way it did, so the
 * defaults are measured from the old constants rather than chosen.
 */

/** How a dimension line terminates at each end. */
export type DimTick = 'oblique' | 'arrow' | 'dot' | 'none';

/** Where the number sits relative to the dimension line. */
export type DimTextPlacement = 'inline' | 'above' | 'below';

/** What the number is expressed in. `auto` picks metres over a metre. */
export type DimUnit = 'auto' | 'mm' | 'cm' | 'm';

export type LineStyle = 'solid' | 'dashed' | 'dotted';

/**
 * Everything that decides how a dimension is drawn.
 *
 * Every field is required: a style is a complete description, and partiality
 * belongs to the override layer, where `Partial<DimStyleProps>` says exactly
 * "the handful of things this one dimension does differently".
 */
export interface DimStyleProps {
  // ── The dimension line ──
  lineColor: string;
  /** × the host's base stroke width. */
  lineWeight: number;
  lineStyle: LineStyle;

  // ── Terminators ──
  tick: DimTick;
  /** × the host's base stroke width. */
  tickSize: number;
  /** × the dimension line's own weight — ticks usually read heavier. */
  tickWeight: number;

  // ── Extension lines ──
  extension: boolean;
  /** Gap between the measured point and where its extension line starts, × base stroke. */
  extGap: number;
  /** How far the extension line runs past the dimension line, × base stroke. */
  extOvershoot: number;

  // ── Text ──
  textColor: string;
  /** × the host's base font size. */
  textSize: number;
  textBold: boolean;
  textPlacement: DimTextPlacement;
  /** Distance from the line when placed above or below, × the resolved text size. */
  textOffset: number;
  /** Turn the text along the dimension line, rather than keeping it upright. */
  textAligned: boolean;
  /** Mask the line behind inline text so the two do not overlap. */
  textBackground: boolean;

  // ── Units ──
  unit: DimUnit;
  precision: number;
  /** Show the unit symbol after the number. */
  showUnit: boolean;
  /** Free text appended after everything else, e.g. " typ." */
  suffix: string;
}

/** A named, reusable style. */
export interface DimStyle extends DimStyleProps {
  id: string;
  name: string;
  /** A built-in cannot be deleted, and is restored if it goes missing. */
  builtin?: boolean;
}

/**
 * The old hardcoded look, field for field — with one deliberate departure.
 *
 * `tickSize: 4` and `tickWeight: 1.8` are the former `TICK = SW * 4` and
 * `strokeWidth={sw * 1.8}`; `extGap` and `extOvershoot` are the former
 * `GAP = SW * 1.5` and `OVER = SW * 3`; the label was
 * `(logLen / 1000).toFixed(3) + ' m'` above a metre, so metres to three
 * decimals with the symbol shown.
 *
 * The departure is `lineWeight`, which was effectively 1 — the host's full
 * base stroke — and is now a quarter of it. Annotation linework at the same
 * weight as the building it annotates reads as heavy; this is the weight a
 * drawn dimension should have. Existing dimensions that carry their own
 * `lineWeight` keep it, so only those that never set one get lighter.
 */
export const DEFAULT_DIM_STYLE_PROPS: DimStyleProps = {
  lineColor: '#1565c0',
  lineWeight: 0.25,
  lineStyle: 'solid',

  tick: 'oblique',
  tickSize: 4,
  tickWeight: 1.8,

  extension: true,
  extGap: 1.5,
  extOvershoot: 3,

  textColor: '#1565c0',
  textSize: 1,
  textBold: true,
  textPlacement: 'inline',
  textOffset: 0.45,
  textAligned: true,
  textBackground: true,

  unit: 'auto',
  precision: 3,
  showUnit: true,
  suffix: '',
};

/** The style every dimension falls back to, and the one that cannot be deleted. */
export const DEFAULT_DIM_STYLE_ID = 'dim-default';

/**
 * The styles a project starts with.
 *
 * Two of them, because the pair covers the split every set of drawings makes:
 * the architectural sheets carry metres with oblique ticks, the structural and
 * detail sheets carry millimetres with arrows. A third would be a guess.
 */
export const BUILTIN_DIM_STYLES: DimStyle[] = [
  {
    ...DEFAULT_DIM_STYLE_PROPS,
    id: DEFAULT_DIM_STYLE_ID,
    name: 'Arhitectural',
    builtin: true,
  },
  {
    ...DEFAULT_DIM_STYLE_PROPS,
    id: 'dim-structural',
    name: 'Structural',
    builtin: true,
    tick: 'arrow',
    tickSize: 3.2,
    tickWeight: 1,
    textPlacement: 'above',
    textAligned: true,
    textBackground: false,
    unit: 'mm',
    precision: 0,
    showUnit: false,
    lineColor: '#1a1a2e',
    textColor: '#1a1a2e',
  },
];

/** What an annotation carries when it departs from its style. */
export type DimOverride = Partial<DimStyleProps>;

/** The parts of a dimension annotation this module reads. */
export interface DimStyled {
  styleId?: string;
  override?: DimOverride;
  /** The pre-style per-annotation fields, still honoured. See `resolveDimStyle`. */
  color?: string;
  lineWeight?: number;
}

/**
 * Drop keys whose value is `undefined`.
 *
 * An override object that has been edited and reset often keeps the key with
 * `undefined` beside it, and spreading that would blank the style's value
 * rather than defer to it — the override layer has to mean "these fields",
 * not "these keys".
 */
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
 * `color` and `lineWeight` were on the annotation before styles existed, and
 * dimensions drawn then still carry them. They are folded in UNDER the
 * override so that old drawings keep their appearance, while anything set
 * deliberately through the new panel still wins.
 */
export function resolveDimStyle(
  ann: DimStyled | undefined,
  styles: DimStyle[],
): DimStyleProps {
  const style = styles.find((s) => s.id === ann?.styleId)
    ?? styles.find((s) => s.id === DEFAULT_DIM_STYLE_ID)
    ?? styles[0];

  const legacy: DimOverride = {};
  if (ann?.color) { legacy.lineColor = ann.color; legacy.textColor = ann.color; }
  if (ann?.lineWeight !== undefined) legacy.lineWeight = ann.lineWeight;

  return {
    ...DEFAULT_DIM_STYLE_PROPS,
    ...defined(style),
    ...legacy,
    ...defined(ann?.override),
  };
}

/** Which fields this dimension sets for itself, for the UI to mark. */
export function overriddenKeys(ann: DimStyled | undefined): (keyof DimStyleProps)[] {
  return Object.keys(defined(ann?.override)) as (keyof DimStyleProps)[];
}

/** The styles a project should have, with any missing built-in put back. */
export function withBuiltins(styles: DimStyle[] | undefined): DimStyle[] {
  const have = styles ?? [];
  const missing = BUILTIN_DIM_STYLES.filter((b) => !have.some((s) => s.id === b.id));
  return [...missing, ...have];
}

// ─── The number on the line ──────────────────────────────────────────────────

const UNIT_FACTOR: Record<Exclude<DimUnit, 'auto'>, number> = { mm: 1, cm: 0.1, m: 0.001 };
const UNIT_SYMBOL: Record<Exclude<DimUnit, 'auto'>, string> = { mm: 'mm', cm: 'cm', m: 'm' };

/**
 * A measured length as the label to draw.
 *
 * `auto` is the old behaviour preserved: under a metre it reads as whole
 * millimetres with no decimals — a 3 mm joint written as "0.003 m" tells the
 * reader nothing — and from a metre up it reads in metres at the style's
 * precision.
 */
export function formatDimLabel(lengthMm: number, p: DimStyleProps): string {
  if (!Number.isFinite(lengthMm)) return '—';

  let unit: Exclude<DimUnit, 'auto'>;
  let precision: number;
  if (p.unit === 'auto') {
    const metres = Math.abs(lengthMm) >= 1000;
    unit = metres ? 'm' : 'mm';
    precision = metres ? p.precision : 0;
  } else {
    unit = p.unit;
    precision = p.precision;
  }

  const value = lengthMm * UNIT_FACTOR[unit];
  // `toFixed` renders -0.0000004 as "-0.000"; a dimension is never negative
  // zero, and the minus sign in front of one reads as a mistake.
  const rounded = Number(value.toFixed(Math.max(0, precision)));
  const text = (Object.is(rounded, -0) ? 0 : rounded).toFixed(Math.max(0, precision));

  return `${text}${p.showUnit ? ` ${UNIT_SYMBOL[unit]}` : ''}${p.suffix}`;
}
