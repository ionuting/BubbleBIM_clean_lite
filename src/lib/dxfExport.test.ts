/**
 * There is no CAD here to open the file in, so it is read back instead: the
 * group-code pairs are parsed and checked the way a reader would — sections
 * balanced, every layer an entity names actually declared, geometry where the
 * drawing put it.
 */
import { describe, expect, it } from 'vitest';
import { DXF_DIM_LAYER, DXF_GRID_LAYER, drawingToDxf, dxfLayerOf, dxfText } from './dxfExport';
import { drawingStyle } from './drawingStyle';
import { autoDimensions } from './drawingDimensions';
import { safeFilename } from './download';
import type { DrawingResult, DrawingShape } from './drawingEngine';

const style = drawingStyle(50);

// ─── A reader ─────────────────────────────────────────────────────────────────

type Pair = [number, string];

function pairs(dxf: string): Pair[] {
  const lines = dxf.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  expect(lines.length % 2, 'a DXF is whole (code, value) pairs').toBe(0);
  const out: Pair[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i]);
    expect(Number.isInteger(code), `group code at line ${i + 1}: ${lines[i]}`).toBe(true);
    out.push([code, lines[i + 1]]);
  }
  return out;
}

/** Every `0`-record in a section, as a list of its own pairs. */
function records(dxf: string, section: string): { type: string; pairs: Pair[] }[] {
  const ps = pairs(dxf);
  const out: { type: string; pairs: Pair[] }[] = [];
  let inside = false;
  let cur: { type: string; pairs: Pair[] } | null = null;
  for (let i = 0; i < ps.length; i++) {
    const [code, value] = ps[i];
    if (code === 0 && value === 'SECTION') {
      inside = ps[i + 1]?.[0] === 2 && ps[i + 1]?.[1] === section;
      continue;
    }
    if (code === 0 && value === 'ENDSEC') { if (cur) out.push(cur); cur = null; inside = false; continue; }
    if (!inside) continue;
    if (code === 0) { if (cur) out.push(cur); cur = { type: value, pairs: [] }; continue; }
    cur?.pairs.push([code, value]);
  }
  return out;
}

const get = (r: { pairs: Pair[] }, code: number) => r.pairs.find((p) => p[0] === code)?.[1];
const all = (r: { pairs: Pair[] }, code: number) => r.pairs.filter((p) => p[0] === code).map((p) => p[1]);

// ─── Fixture ──────────────────────────────────────────────────────────────────

const shape = (over: Partial<DrawingShape> = {}): DrawingShape => ({
  pts: [{ u: 0, v: 0 }, { u: 1000, v: 0 }, { u: 1000, v: 2800 }, { u: 0, v: 2800 }],
  closed: true, hatch: 'none', fillColor: '#ccc', strokeColor: '#333',
  lineWeight: 'heavy-cut', depthMm: 0, nodeId: 'w1', nodeType: 'wall', ...over,
});

const drawing = (over: Partial<DrawingResult> = {}): DrawingResult => ({
  shapes: [shape()],
  axes: [{ u: 0, label: '1', kind: 'X' }, { u: 5000, label: '2', kind: 'X' }],
  levels: [{ vMm: 0, label: '+0.000' }, { vMm: 2800, label: '+2.800' }],
  uMin: 0, uMax: 5000, vMin: 0, vMax: 2800,
  ...over,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('drawingToDxf — the file a CAD has to read', () => {
  const dxf = drawingToDxf(drawing(), style);

  it('is a well-formed R12 file that ends where it should', () => {
    const ps = pairs(dxf);
    expect(ps[0]).toEqual([0, 'SECTION']);
    expect(ps[ps.length - 1]).toEqual([0, 'EOF']);
    const version = ps.find((p, i) => ps[i - 1]?.[1] === '$ACADVER' && p[0] === 1);
    expect(version?.[1]).toBe('AC1009');
  });

  it('opens and closes every section exactly once', () => {
    const ps = pairs(dxf);
    const opened = ps.filter((p) => p[0] === 0 && p[1] === 'SECTION').length;
    const closed = ps.filter((p) => p[0] === 0 && p[1] === 'ENDSEC').length;
    expect(opened).toBe(closed);
    expect(opened).toBe(3);   // HEADER, TABLES, ENTITIES
    // The header is variables, not records, so it is checked by what it says.
    expect(dxf).toContain('$INSUNITS');
    for (const name of ['TABLES', 'ENTITIES']) {
      expect(records(dxf, name).length, `${name} has content`).toBeGreaterThan(0);
    }
  });

  it('declares every layer its entities stand on', () => {
    const declared = new Set(records(dxf, 'TABLES').filter((r) => r.type === 'LAYER').map((r) => get(r, 2)));
    expect(declared.has('0')).toBe(true);
    const used = new Set(records(dxf, 'ENTITIES').flatMap((r) => all(r, 8)));
    expect(used.size).toBeGreaterThan(0);
    for (const l of used) expect(declared, `layer ${l} is declared`).toContain(l);
  });

  it('declares the linetype a dashed entity asks for', () => {
    const d = drawingToDxf(drawing({ shapes: [shape({ lineWeight: 'hidden' })] }), style);
    const types = records(d, 'TABLES').filter((r) => r.type === 'LTYPE').map((r) => get(r, 2));
    const asked = new Set(records(d, 'ENTITIES').flatMap((r) => all(r, 6)));
    for (const t of asked) expect(types).toContain(t);
    expect(asked).toContain('DASHED');
  });
});

describe('drawingToDxf — geometry', () => {
  it('a closed shape is a closed polyline with one vertex per corner', () => {
    const ents = records(drawingToDxf(drawing({ axes: [], levels: [] }), style), 'ENTITIES');
    const poly = ents.find((r) => r.type === 'POLYLINE')!;
    expect(get(poly, 70)).toBe('1');            // closed
    expect(get(poly, 66)).toBe('1');            // vertices follow
    expect(ents.filter((r) => r.type === 'VERTEX')).toHaveLength(4);
    expect(ents.filter((r) => r.type === 'SEQEND')).toHaveLength(1);
  });

  it('a two-point run is a LINE, not a polyline of two vertices', () => {
    const d = drawingToDxf(
      drawing({ shapes: [shape({ closed: false, pts: [{ u: 100, v: 200 }, { u: 900, v: 200 }] })], axes: [], levels: [] }),
      style,
    );
    const ents = records(d, 'ENTITIES');
    expect(ents.filter((r) => r.type === 'POLYLINE')).toHaveLength(0);
    const line = ents.find((r) => r.type === 'LINE')!;
    expect([get(line, 10), get(line, 20), get(line, 11), get(line, 21)])
      .toEqual(['100.0000', '200.0000', '900.0000', '200.0000']);
  });

  it('coordinates are the drawing\'s own millimetres, untransformed', () => {
    const ents = records(drawingToDxf(drawing({ axes: [], levels: [] }), style), 'ENTITIES');
    const vs = ents.filter((r) => r.type === 'VERTEX');
    expect(vs.map((r) => [Number(get(r, 10)), Number(get(r, 20))]))
      .toEqual([[0, 0], [1000, 0], [1000, 2800], [0, 2800]]);
  });

  it('the axis grid brings its bubbles, the levels their labels', () => {
    const ents = records(drawingToDxf(drawing(), style), 'ENTITIES');
    expect(ents.filter((r) => r.type === 'CIRCLE')).toHaveLength(2);
    const texts = ents.filter((r) => r.type === 'TEXT').map((r) => get(r, 1));
    expect(texts).toContain('1');
    expect(texts).toContain('2');
    expect(texts).toContain('+2.800');
    expect(ents.filter((r) => all(r, 8).includes(DXF_GRID_LAYER)).length).toBeGreaterThan(0);
  });
});

describe('dxfLayerOf', () => {
  it('separates what was cut from what was only seen', () => {
    expect(dxfLayerOf(shape({ lineWeight: 'heavy-cut' }))).toBe('A-WALL-CUT');
    expect(dxfLayerOf(shape({ lineWeight: 'medium-cut' }))).toBe('A-WALL-CUT');
    expect(dxfLayerOf(shape({ lineWeight: 'projected' }))).toBe('A-WALL');
    expect(dxfLayerOf(shape({ lineWeight: 'hidden' }))).toBe('A-WALL-HIDN');
  });

  it('names the usual elements the way CAD expects', () => {
    expect(dxfLayerOf(shape({ nodeType: 'window', lineWeight: 'projected' }))).toBe('A-GLAZ');
    expect(dxfLayerOf(shape({ nodeType: 'column', lineWeight: 'projected' }))).toBe('S-COLS');
    expect(dxfLayerOf(shape({ nodeType: 'roof', lineWeight: 'projected' }))).toBe('A-ROOF');
  });

  it('an element nobody planned for still gets a layer of its own', () => {
    expect(dxfLayerOf(shape({ nodeType: 'covering', lineWeight: 'projected' }))).toBe('A-COVERING');
  });
});

describe('drawingToDxf — pens', () => {
  it('the layer colour is the pen: heavier line, heavier plot', () => {
    const d = drawingToDxf(drawing({
      shapes: [shape({ lineWeight: 'heavy-cut' }), shape({ nodeId: 'w2', lineWeight: 'projected' })],
      axes: [], levels: [],
    }), style);
    const byName = new Map(records(d, 'TABLES').filter((r) => r.type === 'LAYER').map((r) => [get(r, 2), get(r, 62)]));
    expect(byName.get('A-WALL-CUT')).toBe('7');   // 0.50 mm
    expect(byName.get('A-WALL')).toBe('1');       // 0.18 mm
  });
});

describe('drawingToDxf — dimensions', () => {
  it('a chain is written as the lines and numbers it looks like', () => {
    const d = drawing();
    const dxf = drawingToDxf(d, style, { dimensions: autoDimensions(d, style) });
    const ents = records(dxf, 'ENTITIES').filter((r) => all(r, 8).includes(DXF_DIM_LAYER));
    expect(ents.length).toBeGreaterThan(0);
    const texts = ents.filter((r) => r.type === 'TEXT').map((r) => get(r, 1));
    expect(texts).toContain('5000');   // the one axis span
    expect(texts).toContain('2800');   // the one level span
  });

  it('a vertical chain\'s text is turned to read bottom-up', () => {
    const d = drawing();
    const dxf = drawingToDxf(d, style, { dimensions: autoDimensions(d, style) });
    const t = records(dxf, 'ENTITIES').find((r) => r.type === 'TEXT' && get(r, 1) === '2800')!;
    expect(get(t, 50)).toBe('90.0000');
  });

  it('no chains, no annotation layer', () => {
    const dxf = drawingToDxf(drawing(), style);
    const declared = records(dxf, 'TABLES').filter((r) => r.type === 'LAYER').map((r) => get(r, 2));
    expect(declared).not.toContain(DXF_DIM_LAYER);
  });
});

describe('drawingToDxf — group codes', () => {
  it('flags, colours and counts are written as integers, never as reals', () => {
    const d = drawing();
    const dxf = drawingToDxf(d, style, { dimensions: autoDimensions(d, style) });
    const ps = pairs(dxf);
    const intCodes = ps.filter(([c]) => (c >= 60 && c <= 79) || (c >= 90 && c <= 99) || (c >= 170 && c <= 179));
    expect(intCodes.length).toBeGreaterThan(0);
    for (const [c, v] of intCodes) {
      expect(v, `group ${c} carries an integer`).toMatch(/^-?\d+$/);
    }
  });

  it('coordinates and heights stay real', () => {
    const ps = pairs(drawingToDxf(drawing(), style));
    const reals = ps.filter(([c]) => (c >= 10 && c <= 59));
    expect(reals.length).toBeGreaterThan(0);
    for (const [c, v] of reals) expect(v, `group ${c} carries a real`).toMatch(/^-?\d+\.\d+$/);
  });
});

describe('dxfText', () => {
  it('folds what an R12 code page cannot be trusted with', () => {
    expect(dxfText('−1.650')).toBe('-1.650');
    expect(dxfText('Secțiune A-A')).toBe('Sectiune A-A');
    expect(dxfText('Fațada nord')).toBe('Fatada nord');
  });

  it('leaves plain ASCII exactly as it was', () => {
    expect(dxfText('+3.000')).toBe('+3.000');
    expect(dxfText('A-WALL-CUT 1:50')).toBe('A-WALL-CUT 1:50');
  });
});

describe('safeFilename', () => {
  it('keeps a view name usable as a file name', () => {
    expect(safeFilename('Secțiune A-A', 'dxf')).toBe('Sectiune-A-A.dxf');
    expect(safeFilename('Fațada nord', 'dxf')).toBe('Fatada-nord.dxf');
    expect(safeFilename('plan/etaj: 1', 'dxf')).toBe('plan-etaj-1.dxf');
  });

  it('never hands back a name that is only an extension', () => {
    expect(safeFilename('', 'dxf')).toBe('desen.dxf');
    expect(safeFilename('///', 'dxf')).toBe('desen.dxf');
  });
});
