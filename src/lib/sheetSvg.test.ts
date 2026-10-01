/**
 * The two things that make a serialized viewport land on the sheet where it
 * was on screen, and not collide with its neighbours.
 */
import { describe, expect, it } from 'vitest';
import { prefixIds, viewportTransform } from './sheetSvg';

const src = (over: Partial<Parameters<typeof viewportTransform>[0]> = {}) => ({
  vbX: 0, vbY: 0, vbW: 1000, vbH: 500, pxW: 400, pxH: 200,
  zoom: 1, panX: 0, panY: 0, ...over,
});

describe('viewportTransform', () => {
  it('an untouched viewport needs no transform at all', () => {
    expect(viewportTransform(src())).toBe('');
  });

  it('a pan in pixels becomes a pan in viewBox units', () => {
    // 400 px across 1000 units → 0.4 px per unit, so 40 px is 100 units.
    expect(viewportTransform(src({ panX: 40, panY: -20 })))
      .toContain('translate(100.0000,-50.0000)');
  });

  it('zoom is about the middle of the viewBox, not its corner', () => {
    const t = viewportTransform(src({ zoom: 2, vbX: 200, vbY: 100 }));
    expect(t).toContain('translate(700.0000,350.0000) scale(2.000000) translate(-700.0000,-350.0000)');
  });

  it('a degenerate box asks for nothing rather than NaN', () => {
    expect(viewportTransform(src({ pxW: 0, pxH: 0 }))).toBe('');
    expect(viewportTransform(src({ vbW: 0 }))).toBe('');
  });
});

describe('prefixIds', () => {
  it('renames a definition and everything that points at it', () => {
    const out = prefixIds(
      '<defs><pattern id="hatch-brick"/></defs><polygon fill="url(#hatch-brick)"/>',
      'v2-',
    );
    expect(out).toBe('<defs><pattern id="v2-hatch-brick"/></defs><polygon fill="url(#v2-hatch-brick)"/>');
  });

  it('follows href references too', () => {
    expect(prefixIds('<use href="#sym"/><use xlink:href="#sym"/>', 'a-'))
      .toBe('<use href="#a-sym"/><use xlink:href="#a-sym"/>');
  });

  it('leaves the fragment alone when there is no prefix', () => {
    const s = '<pattern id="hatch-brick"/>';
    expect(prefixIds(s, '')).toBe(s);
  });

  it('two viewports of the same drawing no longer share an id', () => {
    const frag = '<pattern id="hatch-brick"/><polygon fill="url(#hatch-brick)"/>';
    const a = prefixIds(frag, 'v0-'), b = prefixIds(frag, 'v1-');
    expect(a).not.toBe(b);
    expect(a).not.toContain('v1-');
  });
});
