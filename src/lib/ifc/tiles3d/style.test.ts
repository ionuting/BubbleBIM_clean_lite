/**
 * A malformed styling expression does not throw — it colours nothing and says
 * nothing. So the expressions are built here and checked here.
 */
import { describe, expect, it } from 'vitest';
import {
  colourByGuidStyle, colourLiteral, guidLiteral, highlightGuidStyle,
  showOnlyGuidsStyle, NO_STYLE,
} from './style';

/** A real IFC GlobalId, with the `$` that makes people nervous. */
const GUID = '3xF7v2iH90Dv1FZk9$0Zpk';

describe('guidLiteral', () => {
  it('quotes a GlobalId as it stands — $ and _ need no escaping', () => {
    expect(guidLiteral(GUID)).toBe(`'${GUID}'`);
    expect(guidLiteral('2O2Fr$t4X7Zf8NOew3FLKr')).toBe("'2O2Fr$t4X7Zf8NOew3FLKr'");
  });

  it('escapes a quote, which would otherwise end the literal early', () => {
    expect(guidLiteral("a'b")).toBe("'a\\'b'");
    expect(guidLiteral('a\\b')).toBe("'a\\\\b'");
  });
});

describe('highlightGuidStyle', () => {
  it('paints the named element and leaves the others alone', () => {
    const style = highlightGuidStyle(GUID, '#ffd700', '#ffffff');
    const conditions = (style.color as { conditions: Array<[string, string]> }).conditions;
    expect(conditions[0][0]).toBe(`\${guid} === '${GUID}'`);
    expect(conditions[0][1]).toBe(colourLiteral('#ffd700'));
  });

  it('always ends with a catch-all, or unmatched features turn white', () => {
    const conditions = (highlightGuidStyle(GUID).color as { conditions: Array<[string, string]> }).conditions;
    expect(conditions[conditions.length - 1][0]).toBe('true');
  });

  it('falls back to a plain colour when nothing is selected', () => {
    expect(highlightGuidStyle(null).color).toBe(colourLiteral('#ffffff'));
  });
});

describe('colourByGuidStyle', () => {
  it('makes one condition per element, in order, plus the catch-all', () => {
    const style = colourByGuidStyle({ [GUID]: '#ff0000', 'ABC123': '#00ff00' });
    const conditions = (style.color as { conditions: Array<[string, string]> }).conditions;
    expect(conditions).toHaveLength(3);
    expect(conditions[0][1]).toBe(colourLiteral('#ff0000'));
    expect(conditions[1][0]).toContain('ABC123');
    expect(conditions[2][0]).toBe('true');
  });

  it('ignores entries with nothing to say rather than emitting broken syntax', () => {
    const conditions = (colourByGuidStyle({ '': '#f00', X: '' }).color as { conditions: Array<[string, string]> }).conditions;
    expect(conditions).toHaveLength(1);
    expect(conditions[0][0]).toBe('true');
  });

  it('still produces a usable style for an empty map', () => {
    const conditions = (colourByGuidStyle({}).color as { conditions: Array<[string, string]> }).conditions;
    expect(conditions).toEqual([['true', colourLiteral('#ffffff')]]);
  });
});

describe('showOnlyGuidsStyle', () => {
  it('ors the wanted elements together', () => {
    expect(showOnlyGuidsStyle([GUID, 'ABC']).show)
      .toBe(`\${guid} === '${GUID}' || \${guid} === 'ABC'`);
  });

  it('shows everything when asked for nothing, rather than hiding the model', () => {
    expect(showOnlyGuidsStyle([]).show).toBe('true');
    expect(showOnlyGuidsStyle(['']).show).toBe('true');
  });
});

describe('NO_STYLE', () => {
  it('says nothing, so the tileset draws its own colours', () => {
    expect(NO_STYLE).toEqual({});
  });
});
