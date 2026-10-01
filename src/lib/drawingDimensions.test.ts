/**
 * The chains a drawing dimensions itself with: which ones appear, where they
 * sit, and what they measure.
 */
import { describe, expect, it } from 'vitest';
import { autoDimensions, dimSpans, dimensionReach, DIM_FIRST_ROW_MM, DIM_ROW_MM } from './drawingDimensions';
import { drawingStyle } from './drawingStyle';
import type { DrawingResult, DrawingShape } from './drawingEngine';

const style = drawingStyle(50);

const shape = (over: Partial<DrawingShape> = {}): DrawingShape => ({
  pts: [{ u: 0, v: 0 }], closed: true, hatch: 'none', fillColor: 'none', strokeColor: '#000',
  lineWeight: 'projected', depthMm: 0, nodeId: 'n', nodeType: 'wall', ...over,
});

const drawing = (over: Partial<DrawingResult> = {}): DrawingResult => ({
  shapes: [],
  axes: [
    { u: 0, label: '1', kind: 'X' },
    { u: 5000, label: '2', kind: 'X' },
    { u: 11000, label: '3', kind: 'X' },
  ],
  levels: [
    { vMm: -1200, label: '−1.200' },
    { vMm: 0, label: '+0.000' },
    { vMm: 2800, label: '+2.800' },
  ],
  uMin: -400, uMax: 11400, vMin: -1200, vMax: 5200,
  ...over,
});

describe('autoDimensions', () => {
  it('dimensions the axis grid along the bottom and the levels up the side', () => {
    const chains = autoDimensions(drawing(), style);
    expect(chains.map((c) => c.kind)).toEqual(['axes', 'overall', 'levels', 'overall']);
    const axes = chains[0];
    expect(axes.along).toBe('u');
    expect(axes.stations).toEqual([0, 5000, 11000]);
    expect(dimSpans(axes).map((s) => s.mm)).toEqual([5000, 6000]);
    const levels = chains[2];
    expect(levels.along).toBe('v');
    expect(dimSpans(levels).map((s) => s.mm)).toEqual([1200, 2800]);
  });

  it('the overall row carries the total, and only the total', () => {
    const chains = autoDimensions(drawing(), style);
    const overall = chains.find((c) => c.along === 'u' && c.kind === 'overall')!;
    expect(dimSpans(overall).map((s) => s.mm)).toEqual([11000]);
  });

  it('rows are stacked a paper gap apart, outside the drawing', () => {
    const d = drawing();
    const chains = autoDimensions(d, style);
    expect(chains[0].line).toBeCloseTo(d.vMin - style.paper(DIM_FIRST_ROW_MM), 6);
    expect(chains[1].line).toBeCloseTo(d.vMin - style.paper(DIM_FIRST_ROW_MM + DIM_ROW_MM), 6);
    expect(chains[0].from).toBe(d.vMin);
    // Every chain is outside the drawing, never over it.
    for (const c of chains) expect(c.line).toBeLessThan(c.from);
  });

  it('a single axis is not a chain, and neither is a single level', () => {
    const chains = autoDimensions(drawing({ axes: [{ u: 0, label: '1', kind: 'X' }], levels: [{ vMm: 0, label: '+0.000' }] }), style);
    expect(chains).toEqual([]);
  });

  it('two axes give a detail row but no separate total — it would say the same thing twice', () => {
    const chains = autoDimensions(
      drawing({ axes: [{ u: 0, label: '1', kind: 'X' }, { u: 6000, label: '2', kind: 'X' }] }),
      style,
    );
    expect(chains.filter((c) => c.along === 'u').map((c) => c.kind)).toEqual(['axes']);
  });

  it('axes a hair apart are one station, not a zero-width span', () => {
    const chains = autoDimensions(
      drawing({ axes: [
        { u: 0, label: '1', kind: 'X' },
        { u: 0.4, label: '1b', kind: 'X' },
        { u: 6000, label: '2', kind: 'X' },
      ] }),
      style,
    );
    expect(chains[0].stations).toEqual([0, 6000]);
  });

  it('either direction can be turned off', () => {
    expect(autoDimensions(drawing(), style, { axes: false }).every((c) => c.along === 'v')).toBe(true);
    expect(autoDimensions(drawing(), style, { levels: false }).every((c) => c.along === 'u')).toBe(true);
  });
});

describe('autoDimensions — openings', () => {
  const withOpenings = drawing({
    shapes: [
      // One window, as the engine actually draws it: a frame, a pane inset
      // inside it, and a sill line running past both reveals.
      shape({ nodeId: 'w1', nodeType: 'window', lineWeight: 'medium-cut', pts: [{ u: 1000, v: 900 }, { u: 2200, v: 900 }, { u: 2200, v: 2300 }, { u: 1000, v: 2300 }] }),
      shape({ nodeId: 'w1', nodeType: 'window', pts: [{ u: 1060, v: 960 }, { u: 2140, v: 960 }, { u: 2140, v: 2240 }, { u: 1060, v: 2240 }] }),
      shape({ nodeId: 'w1', nodeType: 'window', closed: false, pts: [{ u: 940, v: 900 }, { u: 2260, v: 900 }] }),
      shape({ nodeId: 'd1', nodeType: 'door', lineWeight: 'medium-cut', pts: [{ u: 7000, v: 0 }, { u: 7900, v: 0 }, { u: 7900, v: 2100 }, { u: 7000, v: 2100 }] }),
      shape({ nodeType: 'wall' }),
    ],
  });

  it('a facade dimensions its holes, not its joinery', () => {
    const chains = autoDimensions(withOpenings, style, { openings: true });
    const op = chains.find((c) => c.kind === 'openings')!;
    // The window is ONE 1200 mm hole — not frame, pane, frame — and the sill's
    // overhang is not part of it.
    expect(dimSpans(op).map((s) => s.mm)).toContain(1200);
    expect(dimSpans(op).map((s) => s.mm)).toContain(900);
    expect(dimSpans(op).every((s) => s.mm > 100)).toBe(true);
  });

  it('the chain reaches the outer axes, so the end piers are dimensioned', () => {
    const op = autoDimensions(withOpenings, style, { openings: true }).find((c) => c.kind === 'openings')!;
    expect(op.stations[0]).toBe(0);
    expect(op.stations[op.stations.length - 1]).toBe(11000);
    expect(dimSpans(op).map((s) => s.mm)).toEqual([1000, 1200, 4800, 900, 3100]);
  });

  it('the opening row sits closer to the building than the axis row', () => {
    const chains = autoDimensions(withOpenings, style, { openings: true });
    const op = chains.find((c) => c.kind === 'openings')!;
    const axes = chains.find((c) => c.kind === 'axes')!;
    expect(op.line).toBeGreaterThan(axes.line);
  });

  it('openings are off unless asked for — a section has no facade to measure', () => {
    expect(autoDimensions(withOpenings, style).some((c) => c.kind === 'openings')).toBe(false);
  });

  it('measures only the openings a reader can see — not those buried behind a nearer wall', () => {
    // The door stands in a far wall, and a near wall's face covers it.
    const buried = drawing({
      shapes: [
        ...withOpenings.shapes.map((s) => (s.nodeId === 'd1' ? { ...s, depthMm: 4000 } : s)),
        shape({ nodeId: 'near', nodeType: 'wall', fillColor: '#334155', depthMm: 500, pts: [{ u: 6000, v: 0 }, { u: 9000, v: 0 }, { u: 9000, v: 3000 }, { u: 6000, v: 3000 }] }),
      ],
    });
    const op = autoDimensions(buried, style, { openings: true }).find((c) => c.kind === 'openings')!;
    expect(dimSpans(op).map((s) => s.mm)).toContain(1200);
    expect(dimSpans(op).map((s) => s.mm)).not.toContain(900);
    // An unfilled shape in front hides nothing: a section's projected outline is see-through.
    const outlined = drawing({
      shapes: [
        ...withOpenings.shapes.map((s) => (s.nodeId === 'd1' ? { ...s, depthMm: 4000 } : s)),
        shape({ nodeId: 'near', nodeType: 'wall', fillColor: 'none', depthMm: 500, pts: [{ u: 6000, v: 0 }, { u: 9000, v: 0 }, { u: 9000, v: 3000 }, { u: 6000, v: 3000 }] }),
      ],
    });
    const op2 = autoDimensions(outlined, style, { openings: true }).find((c) => c.kind === 'openings')!;
    expect(dimSpans(op2).map((s) => s.mm)).toContain(900);
  });

  it('a blank facade gets no opening chain at all — not one that repeats the overall length', () => {
    const blank = drawing({ shapes: [shape({ nodeType: 'wall' })] });
    expect(autoDimensions(blank, style, { openings: true }).some((c) => c.kind === 'openings')).toBe(false);
  });
});

describe('dimensionReach', () => {
  it('reports how much room the chains need on each side', () => {
    const d = drawing();
    const reach = dimensionReach(autoDimensions(d, style), d);
    expect(reach.v).toBeCloseTo(style.paper(DIM_FIRST_ROW_MM + DIM_ROW_MM), 6);
    expect(reach.u).toBeCloseTo(style.paper(DIM_FIRST_ROW_MM + DIM_ROW_MM), 6);
  });

  it('nothing to draw needs no room', () => {
    expect(dimensionReach([], drawing())).toEqual({ u: 0, v: 0 });
  });
});
