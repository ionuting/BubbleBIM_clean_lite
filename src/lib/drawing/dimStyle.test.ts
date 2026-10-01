/**
 * Styles, overrides, and the number on the line.
 *
 * The test that matters most is the boring one: a dimension drawn before
 * styles existed must keep the appearance it had. Everything else here is
 * about the resolution order, which is the part that goes quietly wrong —
 * an override that blanks a style instead of deferring to it looks like a
 * style that "doesn't work".
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DIM_STYLES, DEFAULT_DIM_STYLE_ID, DEFAULT_DIM_STYLE_PROPS,
  formatDimLabel, overriddenKeys, resolveDimStyle, withBuiltins,
  type DimStyle,
} from './dimStyle';

const styles = BUILTIN_DIM_STYLES;
const arch = styles.find((s) => s.id === DEFAULT_DIM_STYLE_ID)!;

describe('the defaults reproduce the old hardcoded renderer', () => {
  it('keeps the constants the renderer used to inline', () => {
    // OVER = SW * 3, GAP = SW * 1.5, TICK = SW * 4, tick stroke = sw * 1.8.
    expect(DEFAULT_DIM_STYLE_PROPS.extOvershoot).toBe(3);
    expect(DEFAULT_DIM_STYLE_PROPS.extGap).toBe(1.5);
    expect(DEFAULT_DIM_STYLE_PROPS.tickSize).toBe(4);
    expect(DEFAULT_DIM_STYLE_PROPS.tickWeight).toBe(1.8);
    expect(DEFAULT_DIM_STYLE_PROPS.tick).toBe('oblique');
  });

  it('keeps inline, aligned text on its white mask', () => {
    expect(DEFAULT_DIM_STYLE_PROPS.textPlacement).toBe('inline');
    expect(DEFAULT_DIM_STYLE_PROPS.textAligned).toBe(true);
    expect(DEFAULT_DIM_STYLE_PROPS.textBackground).toBe(true);
  });

  it('labels the way the old renderer did', () => {
    // `logLen >= 1000 ? (logLen/1000).toFixed(3) + ' m' : Math.round(logLen)`
    const p = DEFAULT_DIM_STYLE_PROPS;
    expect(formatDimLabel(10_200, p)).toBe('10.200 m');
    expect(formatDimLabel(1_000, p)).toBe('1.000 m');
    expect(formatDimLabel(999, p)).toBe('999 mm');
    expect(formatDimLabel(3, p)).toBe('3 mm');
  });
});

describe('resolveDimStyle', () => {
  it('falls back to the default style when none is named', () => {
    expect(resolveDimStyle(undefined, styles).tick).toBe(arch.tick);
    expect(resolveDimStyle({}, styles).lineColor).toBe(arch.lineColor);
  });

  it('falls back to the default style when the named one is gone', () => {
    // A style deleted while dimensions still pointed at it must not blank them.
    expect(resolveDimStyle({ styleId: 'deleted' }, styles).tick).toBe(arch.tick);
  });

  it('uses the named style', () => {
    const r = resolveDimStyle({ styleId: 'dim-structural' }, styles);
    expect(r.tick).toBe('arrow');
    expect(r.unit).toBe('mm');
  });

  it('lets an override beat the style', () => {
    const r = resolveDimStyle({ styleId: 'dim-structural', override: { tick: 'dot' } }, styles);
    expect(r.tick).toBe('dot');
    expect(r.unit).toBe('mm');        // untouched fields still come from the style
  });

  it('ignores an override key whose value is undefined', () => {
    // Clearing an override often leaves the key behind; spreading it would
    // blank the style's value rather than defer to it.
    const r = resolveDimStyle(
      { styleId: 'dim-structural', override: { tick: undefined } },
      styles,
    );
    expect(r.tick).toBe('arrow');
  });

  it('honours the pre-style per-annotation colour and weight', () => {
    const r = resolveDimStyle({ color: '#ff0000', lineWeight: 2 }, styles);
    expect(r.lineColor).toBe('#ff0000');
    expect(r.textColor).toBe('#ff0000');
    expect(r.lineWeight).toBe(2);
  });

  it('lets a deliberate override beat the legacy colour', () => {
    const r = resolveDimStyle(
      { color: '#ff0000', override: { lineColor: '#00ff00' } },
      styles,
    );
    expect(r.lineColor).toBe('#00ff00');
    expect(r.textColor).toBe('#ff0000');   // only what was overridden moves
  });

  it('survives an empty style list', () => {
    expect(resolveDimStyle({ styleId: 'x' }, []).tick).toBe(DEFAULT_DIM_STYLE_PROPS.tick);
  });

  it('fills a gap in a style saved before a field existed', () => {
    const old = { id: 'old', name: 'Vechi', lineColor: '#123456' } as unknown as DimStyle;
    const r = resolveDimStyle({ styleId: 'old' }, [old]);
    expect(r.lineColor).toBe('#123456');
    expect(r.tickSize).toBe(DEFAULT_DIM_STYLE_PROPS.tickSize);
  });
});

describe('overriddenKeys', () => {
  it('lists only what is really set', () => {
    expect(overriddenKeys({ override: { tick: 'dot', unit: undefined } })).toEqual(['tick']);
    expect(overriddenKeys({})).toEqual([]);
    expect(overriddenKeys(undefined)).toEqual([]);
  });
});

describe('withBuiltins', () => {
  it('puts back a built-in that went missing', () => {
    const out = withBuiltins([{ ...arch, id: 'mine', name: 'Al meu', builtin: false }]);
    expect(out.some((s) => s.id === DEFAULT_DIM_STYLE_ID)).toBe(true);
    expect(out.some((s) => s.id === 'mine')).toBe(true);
  });

  it('does not duplicate one that is present, or lose the user’s edits to it', () => {
    const edited = { ...arch, lineColor: '#abcdef' };
    const out = withBuiltins([edited]);
    expect(out.filter((s) => s.id === DEFAULT_DIM_STYLE_ID)).toHaveLength(1);
    expect(out.find((s) => s.id === DEFAULT_DIM_STYLE_ID)!.lineColor).toBe('#abcdef');
  });

  it('gives a project with no styles the full set', () => {
    expect(withBuiltins(undefined)).toHaveLength(BUILTIN_DIM_STYLES.length);
  });
});

describe('formatDimLabel', () => {
  const p = { ...DEFAULT_DIM_STYLE_PROPS };

  it('converts to the unit the style asks for', () => {
    expect(formatDimLabel(1_234, { ...p, unit: 'mm', precision: 0 })).toBe('1234 mm');
    expect(formatDimLabel(1_234, { ...p, unit: 'cm', precision: 1 })).toBe('123.4 cm');
    expect(formatDimLabel(1_234, { ...p, unit: 'm', precision: 2 })).toBe('1.23 m');
  });

  it('keeps millimetres whole under a metre on auto', () => {
    // "0.003 m" tells a reader nothing about a 3 mm joint.
    expect(formatDimLabel(3, { ...p, unit: 'auto', precision: 3 })).toBe('3 mm');
  });

  it('can hide the unit symbol', () => {
    expect(formatDimLabel(1_234, { ...p, unit: 'mm', precision: 0, showUnit: false })).toBe('1234');
  });

  it('appends a suffix after everything', () => {
    expect(formatDimLabel(1_000, { ...p, suffix: ' typ.' })).toBe('1.000 m typ.');
  });

  it('never prints a negative zero', () => {
    // toFixed turns -0.0000004 into "-0.000", and a minus sign on a dimension
    // reads as a mistake in the model.
    expect(formatDimLabel(-0.0000004, { ...p, unit: 'm', precision: 3 })).toBe('0.000 m');
  });

  it('says so rather than printing NaN', () => {
    expect(formatDimLabel(NaN, p)).toBe('—');
    expect(formatDimLabel(Infinity, p)).toBe('—');
  });

  it('tolerates a nonsense precision instead of throwing', () => {
    expect(() => formatDimLabel(1_000, { ...p, precision: -2 })).not.toThrow();
  });
});
