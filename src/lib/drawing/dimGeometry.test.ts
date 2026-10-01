/**
 * The shapes a dimension resolves into.
 *
 * The anchor test replays the renderer's old inline arithmetic and demands the
 * same numbers, so the style system cannot quietly restyle every drawing that
 * already exists. The rest covers what the old code could not do at all.
 */
import { describe, expect, it } from 'vitest';
import { dimDrawing, type DimGeometryInput } from './dimGeometry';
import { DEFAULT_DIM_STYLE_PROPS, type DimStyleProps } from './dimStyle';

const SW = 10;
const FS = 180;

/** A horizontal dimension, 1000 SVG units long, offset 200 "above". */
const base: DimGeometryInput = {
  s1: { x: 0, y: 0 },
  s2: { x: 1000, y: 0 },
  n: { x: 0, y: -1 },
  offset: 200,
  baseStroke: SW,
  baseFont: FS,
  props: DEFAULT_DIM_STYLE_PROPS,
  label: '1.000 m',
};

const withProps = (o: Partial<DimStyleProps>, i: Partial<DimGeometryInput> = {}) =>
  dimDrawing({ ...base, ...i, props: { ...DEFAULT_DIM_STYLE_PROPS, ...o } })!;

describe('the default style still draws what the old renderer drew', () => {
  const d = dimDrawing(base)!;
  const { n, offset, s1, s2 } = base;

  it('puts the dimension line where the offset says', () => {
    expect(d.dimLine.a).toEqual({ x: s1.x + n.x * offset, y: s1.y + n.y * offset });
    expect(d.dimLine.b).toEqual({ x: s2.x + n.x * offset, y: s2.y + n.y * offset });
  });

  it('reproduces GAP = SW × 1.5 and OVER = SW × 3', () => {
    const GAP = SW * 1.5, OVER = SW * 3;
    expect(d.extensions[0].a).toEqual({ x: 0, y: -GAP });
    expect(d.extensions[0].b).toEqual({ x: 0, y: -(offset + OVER) });
    expect(d.extensions[1].a).toEqual({ x: 1000, y: -GAP });
    expect(d.extensions[1].b).toEqual({ x: 1000, y: -(offset + OVER) });
  });

  it('reproduces the oblique tick, unnormalised, at TICK = SW × 4', () => {
    const TICK = SW * 4;
    const ux = 1, uy = 0, nx = 0, ny = -1;
    const t = d.ticks[0] as { kind: 'line'; a: { x: number; y: number }; b: { x: number; y: number } };
    expect(t.kind).toBe('line');
    expect(t.a).toEqual({ x: d.dimLine.a.x + (ux + nx) * TICK * 0.5, y: d.dimLine.a.y + (uy + ny) * TICK * 0.5 });
    expect(t.b).toEqual({ x: d.dimLine.a.x - (ux + nx) * TICK * 0.5, y: d.dimLine.a.y - (uy + ny) * TICK * 0.5 });
  });

  it('leans both oblique ticks the SAME way — they are parallel slashes', () => {
    const [t1, t2] = d.ticks as { a: { x: number; y: number }; b: { x: number; y: number } }[];
    const v1 = { x: t1.b.x - t1.a.x, y: t1.b.y - t1.a.y };
    const v2 = { x: t2.b.x - t2.a.x, y: t2.b.y - t2.a.y };
    expect(v2.x).toBeCloseTo(v1.x, 9);
    expect(v2.y).toBeCloseTo(v1.y, 9);
  });

  it('keeps the tick stroke at 1.8× the line', () => {
    expect(d.tickStrokeWidth).toBeCloseTo(d.strokeWidth * 1.8, 9);
  });

  it('puts the text on the line, on its mask', () => {
    expect(d.text!.x).toBeCloseTo(500, 9);
    expect(d.text!.y).toBeCloseTo(-200, 9);
    expect(d.background).not.toBeNull();
    expect(d.background!.width).toBeCloseTo('1.000 m'.length * FS * 0.62, 9);
    expect(d.background!.height).toBeCloseTo(FS * 1.4, 9);
  });
});

describe('the sign bug the old arithmetic had', () => {
  // offset −200 with overshoot 30 used to give an extension ending at −170,
  // i.e. 30 units SHORT of the dimension line instead of 30 past it.
  const d = dimDrawing({ ...base, offset: -200 })!;

  it('still runs the extension PAST the dimension line on the far side', () => {
    const lineY = d.dimLine.a.y;                 // +200 (n is −y, offset −200)
    expect(lineY).toBeCloseTo(200, 9);
    expect(d.extensions[0].b.y).toBeGreaterThan(lineY);
    expect(d.extensions[0].b.y).toBeCloseTo(200 + SW * 3, 9);
  });

  it('still leaves the gap on the correct side of the measured point', () => {
    // The gap steps toward the dimension line, never away from it.
    expect(d.extensions[0].a.y).toBeCloseTo(SW * 1.5, 9);
  });

  it('is symmetric: flipping the offset mirrors the drawing', () => {
    const pos = dimDrawing({ ...base, offset: 200 })!;
    expect(d.dimLine.a.y).toBeCloseTo(-pos.dimLine.a.y, 9);
    expect(d.extensions[0].b.y).toBeCloseTo(-pos.extensions[0].b.y, 9);
  });
});

describe('terminators', () => {
  it('draws nothing for none', () => {
    expect(withProps({ tick: 'none' }).ticks).toEqual([]);
  });

  it('draws a dot at each end', () => {
    const d = withProps({ tick: 'dot' });
    expect(d.ticks.map((t) => t.kind)).toEqual(['dot', 'dot']);
    const dot = d.ticks[0] as { c: { x: number; y: number }; r: number };
    expect(dot.c).toEqual(d.dimLine.a);
    expect(dot.r).toBeGreaterThan(0);
  });

  it('points the two arrowheads in OPPOSITE directions', () => {
    // Both facing the same way is the classic mistake — one arrow then points
    // into the dimension instead of out of it.
    const d = withProps({ tick: 'arrow' });
    const [a1, a2] = d.ticks as { points: { x: number; y: number }[] }[];
    // Tip is the first point; the base sits back along the line.
    expect(a1.points[0]).toEqual(d.dimLine.a);
    expect(a2.points[0]).toEqual(d.dimLine.b);
    expect(a1.points[1].x).toBeGreaterThan(a1.points[0].x);   // base to the right of the left tip
    expect(a2.points[1].x).toBeLessThan(a2.points[0].x);      // base to the left of the right tip
  });

  it('scales every terminator with tickSize', () => {
    const small = withProps({ tick: 'dot', tickSize: 2 }).ticks[0] as { r: number };
    const big = withProps({ tick: 'dot', tickSize: 8 }).ticks[0] as { r: number };
    expect(big.r).toBeCloseTo(small.r * 4, 9);
  });
});

describe('text placement', () => {
  it('lifts the text clear of the line when placed above', () => {
    const d = withProps({ textPlacement: 'above', textOffset: 0.5 });
    // "Above" is the side the dimension was offset to — away from what is measured.
    expect(d.text!.y).toBeLessThan(-200);
    expect(d.text!.y).toBeCloseTo(-200 - (0.5 + 0.5) * FS, 9);
  });

  it('drops it the other way when placed below', () => {
    const d = withProps({ textPlacement: 'below', textOffset: 0.5 });
    expect(d.text!.y).toBeCloseTo(-200 + (0.5 + 0.5) * FS, 9);
  });

  it('follows the offset’s side, so "above" is never inside the building', () => {
    const up = withProps({ textPlacement: 'above' }, { offset: 200 });
    const down = withProps({ textPlacement: 'above' }, { offset: -200 });
    expect(up.text!.y).toBeLessThan(up.dimLine.a.y);
    expect(down.text!.y).toBeGreaterThan(down.dimLine.a.y);
  });

  it('drops the mask when the text is not on the line', () => {
    expect(withProps({ textPlacement: 'above' }).background).toBeNull();
    expect(withProps({ textBackground: false }).background).toBeNull();
  });

  it('keeps the number upright when not aligned', () => {
    const d = withProps({ textAligned: false }, { s2: { x: 0, y: 1000 }, n: { x: 1, y: 0 } });
    expect(d.text!.angle).toBe(0);
  });

  it('never turns an aligned number upside down', () => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [-1, -1], [1, -1]]) {
      const d = withProps({}, { s2: { x: dx * 1000, y: dy * 1000 } });
      expect(Math.abs(d.text!.angle)).toBeLessThanOrEqual(90);
    }
  });

  it('scales the text with textSize', () => {
    expect(withProps({ textSize: 2 }).text!.size).toBeCloseTo(FS * 2, 9);
  });
});

describe('line', () => {
  it('scales the stroke with lineWeight', () => {
    expect(withProps({ lineWeight: 2.5 }).strokeWidth).toBeCloseTo(SW * 2.5, 9);
  });

  it('dashes only when asked', () => {
    expect(withProps({ lineStyle: 'solid' }).dash).toBeUndefined();
    expect(withProps({ lineStyle: 'dashed' }).dash).toBe(`${SW * 6} ${SW * 3}`);
    expect(withProps({ lineStyle: 'dotted' }).dash).toBe(`${SW * 1} ${SW * 3}`);
  });

  it('omits extension lines when they are turned off', () => {
    expect(withProps({ extension: false }).extensions).toEqual([]);
  });
});

describe('degenerate input', () => {
  it('declines a zero-length dimension instead of dividing by it', () => {
    expect(dimDrawing({ ...base, s2: { x: 0, y: 0 } })).toBeNull();
  });
});
