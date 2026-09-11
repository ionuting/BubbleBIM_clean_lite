import { describe, expect, it } from 'vitest';
import { BRACKET_SPACING_MM, computeCltPanels, isCltWallType } from './cltPanels';

describe('computeCltPanels — one panel', () => {
  const p = computeCltPanels({ lengthMm: 5000, heightMm: 2800, thicknessMm: 120, openings: [] });

  it('a wall within the transport length is one panel of its gross area', () => {
    expect(p.panelCount).toBe(1);
    expect(p.grossAreaM2).toBeCloseTo(14, 6);
    expect(p.netAreaM2).toBeCloseTo(14, 6);
    expect(p.volumeM3).toBeCloseTo(14 * 0.12, 6);
  });

  it('cuts the perimeter, joints the base, brackets every metre, holds down both ends', () => {
    expect(p.cutLengthM).toBeCloseTo(2 * (5 + 2.8), 6);
    expect(p.jointLengthM).toBeCloseTo(5, 6);
    expect(p.bracketCount).toBe(Math.ceil(5000 / BRACKET_SPACING_MM) + 1);
    expect(p.holdDownCount).toBe(2);
  });

  it('degenerate walls give nothing', () => {
    expect(computeCltPanels({ lengthMm: 0, heightMm: 2800, thicknessMm: 100, openings: [] }).panelCount).toBe(0);
  });
});

describe('computeCltPanels — openings', () => {
  const p = computeCltPanels({
    lengthMm: 5000, heightMm: 2800, thicknessMm: 120,
    openings: [{ x0Mm: 1000, widthMm: 1200, sillMm: 900, heightMm: 1200 }],
  });

  it('the blank stays whole, the net face loses the opening, the CNC runs its outline', () => {
    expect(p.grossAreaM2).toBeCloseTo(14, 6);
    expect(p.netAreaM2).toBeCloseTo(14 - 1.44, 6);
    expect(p.cutLengthM).toBeCloseTo(2 * (5 + 2.8) + 2 * (1.2 + 1.2), 6);
    expect(p.holdDownCount).toBe(4);   // 2 panel ends + 2 jambs
  });
});

describe('computeCltPanels — long wall', () => {
  it('splits above the transport length into equal pieces with a vertical joint between them', () => {
    const p = computeCltPanels({ lengthMm: 15000, heightMm: 2800, thicknessMm: 140, openings: [] });
    expect(p.panelCount).toBe(2);
    expect(p.panels[0].x1Mm).toBe(7500);
    expect(p.jointLengthM).toBeCloseTo(15 + 2.8, 6);
  });

  it('never splits through an opening — the cut moves to the nearer jamb', () => {
    const p = computeCltPanels({
      lengthMm: 15000, heightMm: 2800, thicknessMm: 140,
      openings: [{ x0Mm: 7000, widthMm: 1500, sillMm: 0, heightMm: 2100 }],
    });
    expect(p.panelCount).toBe(2);
    expect(p.panels[0].x1Mm).toBe(7000);
  });

  it('honours a shorter transport limit', () => {
    const p = computeCltPanels({ lengthMm: 9000, heightMm: 2800, thicknessMm: 100, openings: [], maxPanelLengthMm: 3000 });
    expect(p.panelCount).toBe(3);
  });
});

describe('isCltWallType', () => {
  it('reads the library id, not the material', () => {
    expect(isCltWallType('CLT120')).toBe(true);
    expect(isCltWallType('W25')).toBe(false);
    expect(isCltWallType(undefined)).toBe(false);
  });
});
