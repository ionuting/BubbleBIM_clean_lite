/**
 * Pen widths and text heights are paper sizes. These pin the one conversion
 * everything else depends on, and the scale a drawing picks for itself.
 */
import { describe, expect, it } from 'vitest';
import { PEN, TEXT, drawingStyle, fitScale, NOMINAL_SHEET_MM } from './drawingStyle';

describe('drawingStyle', () => {
  it('turns paper millimetres into model millimetres by the scale', () => {
    const s = drawingStyle(50);
    expect(s.paper(1)).toBe(50);
    expect(s.line('heavy-cut')).toBeCloseTo(PEN.thick * 50, 9);
    expect(s.text(TEXT.normal)).toBeCloseTo(3.5 * 50, 9);
    expect(s.label).toBe('1 : 50');
  });

  it('keeps the line hierarchy at every scale', () => {
    for (const scale of [20, 50, 100, 200]) {
      const s = drawingStyle(scale);
      expect(s.line('heavy-cut')).toBeGreaterThan(s.line('medium-cut'));
      expect(s.line('medium-cut')).toBeGreaterThan(s.line('annotation'));
      expect(s.line('annotation')).toBeGreaterThan(s.line('projected'));
    }
  });

  it('a line drawn at 1:100 is twice the model width it has at 1:50 — and the same on paper', () => {
    expect(drawingStyle(100).line('heavy-cut')).toBeCloseTo(2 * drawingStyle(50).line('heavy-cut'), 9);
    expect(drawingStyle(100).line('heavy-cut') / 100).toBeCloseTo(drawingStyle(50).line('heavy-cut') / 50, 9);
  });

  it('dashes are paper sizes too; a solid line has none', () => {
    expect(drawingStyle(50).dash('hidden')).toBe('100.00 60.00');
    expect(drawingStyle(50).dash('heavy-cut')).toBeUndefined();
  });
});

describe('fitScale', () => {
  it('picks the largest standard scale the drawing still fits at', () => {
    // A 12 × 8 m building needs 12000/380 ≈ 31.6 → 1:50.
    expect(fitScale(12000, 8000)).toBe(50);
    // A 6 × 4 m one needs only 6000/380 ≈ 15.8 → 1:20.
    expect(fitScale(6000, 4000)).toBe(20);
    // A 40 m block does not fit until 1:200 (40000/380 ≈ 105 → 1:200 by height too).
    expect(fitScale(40000, 26000)).toBe(200);
  });

  it('measures both directions, not just the wider one', () => {
    // Narrow and tall: the height decides.
    expect(fitScale(1000, 13000)).toBe(50);
  });

  it('falls back to a usable scale when there is nothing to measure', () => {
    expect(fitScale(0, 0)).toBe(50);
    expect(fitScale(NaN, 100)).toBe(50);
    expect(fitScale(Infinity, 100)).toBe(50);
  });

  it('honours a sheet of another size', () => {
    expect(fitScale(12000, 8000, { w: 180, h: 120 })).toBe(100);
    expect(NOMINAL_SHEET_MM.w).toBeGreaterThan(0);
  });
});
