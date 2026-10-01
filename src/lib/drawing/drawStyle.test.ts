/**
 * Styles for everything that is not a dimension.
 *
 * The legacy folding is what most of this covers: eight per-annotation fields
 * predate styles, and a drawing made with them has to keep its appearance.
 * Getting one of them wrong does not throw — it silently restyles somebody's
 * finished drawing.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DRAW_STYLES, DEFAULT_DRAW_STYLE_ID, DEFAULT_DRAW_STYLE_PROPS,
  RELEVANT, dashFor, drawOverriddenKeys, resolveDrawStyle, withDrawBuiltins,
  type DrawStyle,
} from './drawStyle';

const styles = BUILTIN_DRAW_STYLES;

describe('defaults', () => {
  it('inks annotations at a quarter of the host’s base stroke', () => {
    // The point of the change: annotation linework should not read as heavy
    // as the building under it.
    expect(DEFAULT_DRAW_STYLE_PROPS.lineWeight).toBe(0.25);
  });

  it('leaves closed shapes unfilled, as they were', () => {
    expect(DEFAULT_DRAW_STYLE_PROPS.fillOpacity).toBe(0);
  });

  it('keeps the leader arrow at the size the renderer hardcoded', () => {
    expect(DEFAULT_DRAW_STYLE_PROPS.arrowSize).toBe(0.5);   // was FS * 0.5
  });
});

describe('resolveDrawStyle', () => {
  it('falls back to the default style, and to defaults with no styles at all', () => {
    expect(resolveDrawStyle(undefined, styles).lineWeight).toBe(0.25);
    expect(resolveDrawStyle({ styleId: 'gone' }, styles).lineWeight).toBe(0.25);
    expect(resolveDrawStyle({ styleId: 'x' }, []).lineColor)
      .toBe(DEFAULT_DRAW_STYLE_PROPS.lineColor);
  });

  it('lets an override beat the style', () => {
    expect(resolveDrawStyle({ override: { lineWeight: 2 } }, styles).lineWeight).toBe(2);
  });

  it('ignores an override key left behind as undefined', () => {
    expect(resolveDrawStyle({ override: { lineWeight: undefined } }, styles).lineWeight).toBe(0.25);
  });

  describe('the fields that predate styles', () => {
    it('reads `color` as both stroke and text, the way one `col` used to be', () => {
      const r = resolveDrawStyle({ color: '#ff0000' }, styles);
      expect(r.lineColor).toBe('#ff0000');
      expect(r.textColor).toBe('#ff0000');
    });

    it('keeps an explicit lineWeight, so an old drawing does not get thinner', () => {
      // This is what stops the new 0.25 default from restyling existing work.
      expect(resolveDrawStyle({ lineWeight: 1 }, styles).lineWeight).toBe(1);
      expect(resolveDrawStyle({ lineWeight: 3 }, styles).lineWeight).toBe(3);
    });

    it('maps strokeStyle onto lineStyle', () => {
      expect(resolveDrawStyle({ strokeStyle: 'dashed' }, styles).lineStyle).toBe('dashed');
    });

    it('accepts either name a fill was stored under', () => {
      // Shapes wrote `fill`; hatches wrote `fillColor`.
      expect(resolveDrawStyle({ fill: '#abcdef' }, styles).fillColor).toBe('#abcdef');
      expect(resolveDrawStyle({ fillColor: '#123456' }, styles).fillColor).toBe('#123456');
    });

    it('prefers `fill` when an annotation somehow carries both', () => {
      expect(resolveDrawStyle({ fill: '#aaaaaa', fillColor: '#bbbbbb' }, styles).fillColor)
        .toBe('#aaaaaa');
    });

    it('keeps a stored fillOpacity of 0 rather than treating it as absent', () => {
      const s: DrawStyle = { ...styles[0], fillOpacity: 0.8 };
      expect(resolveDrawStyle({ fillOpacity: 0 }, [s]).fillOpacity).toBe(0);
    });

    it('keeps `bold: false` rather than falling back to the style', () => {
      const s: DrawStyle = { ...styles[0], textBold: true };
      expect(resolveDrawStyle({ bold: false }, [s]).textBold).toBe(false);
    });

    it('carries the hatch fields across', () => {
      const r = resolveDrawStyle({ pattern: 'brick', hatchSpacing: 2, hatchAngle: 45 }, styles);
      expect(r.hatchPattern).toBe('brick');
      expect(r.hatchSpacing).toBe(2);
      expect(r.hatchAngle).toBe(45);
    });

    it('still lets a deliberate override beat a legacy field', () => {
      const r = resolveDrawStyle({ color: '#ff0000', override: { lineColor: '#00ff00' } }, styles);
      expect(r.lineColor).toBe('#00ff00');
      expect(r.textColor).toBe('#ff0000');
    });
  });

  it('fills a gap in a style saved before a field existed', () => {
    const old = { id: 'old', name: 'Vechi', lineColor: '#111111' } as unknown as DrawStyle;
    const r = resolveDrawStyle({ styleId: 'old' }, [old]);
    expect(r.lineColor).toBe('#111111');
    expect(r.arrowSize).toBe(DEFAULT_DRAW_STYLE_PROPS.arrowSize);
  });
});

describe('drawOverriddenKeys', () => {
  it('lists only what is really set', () => {
    expect(drawOverriddenKeys({ override: { lineWeight: 1, fillColor: undefined } }))
      .toEqual(['lineWeight']);
    expect(drawOverriddenKeys(undefined)).toEqual([]);
  });
});

describe('withDrawBuiltins', () => {
  it('puts back the built-in and keeps the user’s own', () => {
    const out = withDrawBuiltins([{ ...styles[0], id: 'mine', name: 'Al meu', builtin: false }]);
    expect(out.some((s) => s.id === DEFAULT_DRAW_STYLE_ID)).toBe(true);
    expect(out).toHaveLength(2);
  });

  it('does not duplicate one that is present, nor lose edits to it', () => {
    const edited = { ...styles[0], lineWeight: 0.1 };
    const out = withDrawBuiltins([edited]);
    expect(out).toHaveLength(1);
    expect(out[0].lineWeight).toBe(0.1);
  });
});

describe('RELEVANT', () => {
  it('offers a circle its fill but not a hatch angle', () => {
    expect(RELEVANT.circle.fill).toBe(true);
    expect(RELEVANT.circle.hatch).toBe(false);
  });

  it('offers text no stroke — it has none to set', () => {
    expect(RELEVANT.text.stroke).toBe(false);
    expect(RELEVANT.text.text).toBe(true);
  });

  it('offers a leader both a line and an arrow', () => {
    expect(RELEVANT.leader.stroke).toBe(true);
    expect(RELEVANT.leader.arrow).toBe(true);
    expect(RELEVANT.leader.text).toBe(true);
  });

  it('covers every kind the layer can draw', () => {
    expect(Object.keys(RELEVANT).sort()).toEqual(
      ['arc', 'circle', 'hatch', 'leader', 'line', 'polyline', 'rect', 'text'],
    );
  });
});

describe('dashFor', () => {
  it('matches what the renderer used to emit', () => {
    expect(dashFor('solid', 10)).toBeUndefined();
    expect(dashFor('dashed', 10)).toBe('60 30');
    expect(dashFor('dotted', 10)).toBe('10 30');
  });
});
