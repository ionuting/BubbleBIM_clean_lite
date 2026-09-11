import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode } from '@/store';
import { gableFootprintMm, gableMaterial, gableSpec, wallThicknessMm } from './gable';

const wall = (properties: Record<string, unknown> = {}): BubbleGraphNode =>
  ({ id: 'w', type: 'wall', name: 'w', x: 0, y: 0, z: 0, properties: { wall_type: 'W25', ...properties } });

describe('wallThicknessMm', () => {
  it('reads the W-code in millimetres', () => {
    expect(wallThicknessMm(wall())).toBe(250);
    expect(wallThicknessMm(wall({ wall_type: 'W15' }))).toBe(150);
  });

  it('falls back to 200 for an unreadable type', () => {
    expect(wallThicknessMm(wall({ wall_type: 'odd' }))).toBe(200);
  });
});

describe('gableSpec', () => {
  it('inherits everything from an unconfigured wall', () => {
    const s = gableSpec(wall());
    expect(s.thicknessMm).toBe(250);
    expect(s.offsetMm).toBe(0);
    expect(s.material).toBe('');
    expect(s.reshaped).toBe(false);
    expect(s.distinct).toBe(false);
  });

  it('treats a zero thickness as "same as the wall"', () => {
    expect(gableSpec(wall({ gable_thickness_mm: 0 })).thicknessMm).toBe(250);
    expect(gableSpec(wall({ gable_thickness_mm: 0 })).reshaped).toBe(false);
  });

  it('a thinner gable is reshaped and distinct', () => {
    const s = gableSpec(wall({ gable_thickness_mm: 150 }));
    expect(s.thicknessMm).toBe(150);
    expect(s.reshaped).toBe(true);
    expect(s.distinct).toBe(true);
  });

  it('an offset alone reshapes it', () => {
    const s = gableSpec(wall({ gable_offset_mm: 50 }));
    expect(s.thicknessMm).toBe(250);
    expect(s.offsetMm).toBe(50);
    expect(s.reshaped).toBe(true);
  });

  it('a material alone makes it distinct but not reshaped', () => {
    const s = gableSpec(wall({ gable_material: 'wood' }));
    expect(s.reshaped).toBe(false);
    expect(s.distinct).toBe(true);
    expect(s.material).toBe('wood');
  });

  it('a thickness equal to the wall is not a difference', () => {
    expect(gableSpec(wall({ gable_thickness_mm: 250 })).reshaped).toBe(false);
  });

  it('reads numbers written as strings, and ignores junk', () => {
    expect(gableSpec(wall({ gable_thickness_mm: '150' })).thicknessMm).toBe(150);
    expect(gableSpec(wall({ gable_offset_mm: '-50' })).offsetMm).toBe(-50);
    expect(gableSpec(wall({ gable_offset_mm: 'x' })).offsetMm).toBe(0);
    expect(gableSpec(wall({ gable_thickness_mm: 'x' })).thicknessMm).toBe(250);
  });

  it('takes an already-resolved wall thickness when given one', () => {
    expect(gableSpec(wall({ wall_type: 'W25' }), 300).thicknessMm).toBe(300);
    expect(gableSpec(wall({ wall_type: 'W25' }), 300).reshaped).toBe(false);
  });
});

describe('gableMaterial', () => {
  it('falls back to the wall material', () => {
    const n = wall({ material: 'brick' });
    expect(gableMaterial(n, gableSpec(n))).toBe('brick');
  });

  it('prefers its own', () => {
    const n = wall({ material: 'brick', gable_material: 'wood' });
    expect(gableMaterial(n, gableSpec(n))).toBe('wood');
  });
});

describe('gableFootprintMm', () => {
  const A = { x: 0, y: 0 }, B = { x: 5000, y: 0 };

  it('is a rectangle of the gable thickness on the wall axis', () => {
    const fp = gableFootprintMm(A, B, gableSpec(wall({ gable_thickness_mm: 150 })));
    expect(fp).toHaveLength(4);
    const ys = fp.map((p) => p.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-75, 6);
    expect(ys[3]).toBeCloseTo(75, 6);
    expect(fp.map((p) => p.x).sort((a, b) => a - b)).toEqual([0, 0, 5000, 5000]);
  });

  it('a positive offset moves it right of A→B', () => {
    // Walking +x, the right-hand normal is (uy, −ux) = (0, −1), so +50 goes to y = −50.
    const fp = gableFootprintMm(A, B, gableSpec(wall({ gable_thickness_mm: 150, gable_offset_mm: 50 })));
    const ys = fp.map((p) => p.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-125, 6);
    expect(ys[3]).toBeCloseTo(25, 6);
  });

  it('half the thickness difference sits it flush with one face', () => {
    // 250 wall, 150 gable: the wall face is at y = ±125, the gable at −125…+25
    // when offset by (250 − 150) / 2 = 50.
    const fp = gableFootprintMm(A, B, gableSpec(wall({ gable_thickness_mm: 150, gable_offset_mm: 50 })));
    expect(Math.min(...fp.map((p) => p.y))).toBeCloseTo(-125, 6);
  });

  it('follows the wall direction', () => {
    const fp = gableFootprintMm({ x: 0, y: 0 }, { x: 0, y: 4000 }, gableSpec(wall({ gable_thickness_mm: 100 })));
    const xs = fp.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-50, 6);
    expect(xs[3]).toBeCloseTo(50, 6);
  });

  it('returns nothing for a degenerate run', () => {
    expect(gableFootprintMm(A, A, gableSpec(wall()))).toEqual([]);
  });
});
