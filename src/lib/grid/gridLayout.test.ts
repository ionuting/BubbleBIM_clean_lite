import { describe, expect, it } from 'vitest';
import { buildStoreyNodes } from '@/lib/storeys/defaultProject';
import { MM_TO_PX, detachCellEdge } from './axisEdit';
import { buildGridLayout, gridHitTest, screenToWorld, worldToScreen, xAxisLabel, yAxisLabel } from './gridLayout';

const XS = [0, 5000, 10000], YS = [0, 4000, 8000];

describe('buildGridLayout', () => {
  const nodes = buildStoreyNodes('P', 0, 3000, XS, YS, 0);
  const storey = nodes[0];
  const [L] = buildGridLayout(nodes, [storey.id], { zoom: 1 });

  it('one line per axis, labelled 1.. and A.., spanning the grid plus the extension', () => {
    expect(L.xLines.map((l) => l.label)).toEqual(['1', '2', '3']);
    expect(L.yLines.map((l) => l.label)).toEqual(['A', 'B', 'C']);
    expect(yAxisLabel(27)).toBe('B1');
    expect(xAxisLabel(9)).toBe('10');
    // Axis 2 sits at bim x = 5000 → world (storey.x − 5000 + 5000) × 0.05.
    expect(L.xLines[1].a.x).toBeCloseTo(storey.x * MM_TO_PX, 6);
    expect(L.xLines[1].a.y).toBeLessThan(L.bounds.minY);
    expect(L.xLines[1].b.y).toBeGreaterThan(L.bounds.maxY);
  });

  it('dimension labels carry the spans and sit outside the bubbles', () => {
    const xd = L.dims.filter((d) => d.axis === 'x');
    expect(xd.map((d) => d.spanMm)).toEqual([5000, 5000]);
    expect(xd[0].anchor.y).toBeLessThan(L.xLines[0].bubble.y);
    const yd = L.dims.filter((d) => d.axis === 'y');
    expect(yd.map((d) => d.spanMm)).toEqual([4000, 4000]);
    expect(yd[0].anchor.x).toBeLessThan(L.yLines[0].bubble.x);
  });

  it('dots come from the ax nodes and handles sit between consecutive dots', () => {
    expect(L.dots).toHaveLength(9);
    expect(L.dots.every((d) => !d.offAxis)).toBe(true);
    // 3 X axes × 2 cells + 3 Y axes × 2 cells.
    expect(L.handles).toHaveLength(12);
    const h = L.handles.find((h) => h.axis === 'x' && h.index === 1 && h.cell === 0)!;
    expect(h.mid.x).toBeCloseTo(L.xLines[1].a.x, 6);
    expect(h.mid.y).toBeCloseTo((L.yLines[0].a.y + L.yLines[1].a.y) / 2, 6);
  });

  it('a detached cell edge moves its two dots and flags the handle', () => {
    const edited = detachCellEdge(nodes, [], [storey.id], 'x', 1, 0, 600);
    const [E] = buildGridLayout(edited, [storey.id], { zoom: 1 });
    const off = E.dots.filter((d) => d.offAxis);
    expect(off.map((d) => `${d.gx}_${d.gy}`).sort()).toEqual(['1_0', '1_1']);
    expect(off[0].pos.x - off[0].foot.x).toBeCloseTo(600 * MM_TO_PX, 6);
    expect(E.handles.find((h) => h.axis === 'x' && h.index === 1 && h.cell === 0)!.detached).toBe(true);
    expect(E.handles.find((h) => h.axis === 'x' && h.index === 1 && h.cell === 1)!.detached).toBe(true);  // shares dot (1,1)
    expect(E.handles.find((h) => h.axis === 'x' && h.index === 0 && h.cell === 0)!.detached).toBe(false);
  });

  it('glyph sizes shrink with zoom so they stay constant on screen', () => {
    const [Z] = buildGridLayout(nodes, [storey.id], { zoom: 4 });
    expect(L.xLines[0].a.y - Z.xLines[0].a.y).toBeCloseTo(-(28 - 28 / 4), 6);
    expect(Z.dims[0].rect.h).toBeCloseTo(14 / 4, 6);
  });
});

describe('gridHitTest', () => {
  const nodes = buildStoreyNodes('P', 0, 3000, XS, YS, 0);
  const layout = buildGridLayout(nodes, [nodes[0].id], { zoom: 1 });
  const L = layout[0];

  it('priority: dimension, then handle, then bubble, then axis line', () => {
    const d = L.dims[0];
    expect(gridHitTest(layout, d.anchor.x, d.anchor.y, 1)).toMatchObject({ kind: 'dim' });
    const h = L.handles[0];
    expect(gridHitTest(layout, h.mid.x, h.mid.y, 1)).toMatchObject({ kind: 'handle' });
    const b = L.xLines[2].bubble;
    expect(gridHitTest(layout, b.x, b.y, 1)).toMatchObject({ kind: 'bubble', line: { index: 2 } });
    // On axis 2, a quarter of the way up the first cell (away from the handle).
    const x = L.xLines[1].a.x, y = L.yLines[0].a.y + (L.yLines[1].a.y - L.yLines[0].a.y) * 0.25;
    expect(gridHitTest(layout, x + 2, y, 1)).toMatchObject({ kind: 'axis', line: { axis: 'x', index: 1 } });
    expect(gridHitTest(layout, x + 2, y, 1, { skipAxisLine: true })).toBeNull();
    expect(gridHitTest(layout, x + 40, y, 1)).toBeNull();
  });
});

describe('screen ↔ world', () => {
  it('round-trips with the panel inverse (Y flipped)', () => {
    const pan = { x: 120, y: -40 }, zoom = 1.7, H = 900;
    const w = screenToWorld(300, 200, pan, zoom, H);
    const s = worldToScreen(w.x, w.y, pan, zoom, H);
    expect(s.x).toBeCloseTo(300, 9);
    expect(s.y).toBeCloseTo(200, 9);
    expect(w).toEqual({ x: (300 - pan.x) / zoom, y: (H - (200 - pan.y)) / zoom });
  });
});
