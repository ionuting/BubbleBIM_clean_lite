/**
 * What has to hold for on-plan dimensions: every number shown is the number
 * stored (or a length of it), and typing over one changes exactly that and
 * nothing else — a rectangle's corner stays, a segment's start stays, an
 * offset edit leaves the shape's own size alone.
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { computeSketch } from './index';
import { serialiseOutline } from './types';
import { applySketchDim, sketchDims } from './dims';

const storey: BubbleGraphNode = {
  id: 'st1', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};
const ax = (id: string, x: number, y: number): BubbleGraphNode =>
  ({ id, type: 'ax', name: id, x, y, z: 0, parentId: 'st1', properties: { bimX: x, bimY: y } });

function make(props: Record<string, unknown>, refs: string[] = []) {
  const sk: BubbleGraphNode = {
    id: 'sk', type: 'sketch', name: 'S', x: 0, y: 0, z: 0, parentId: 'st1',
    properties: { op: 'extrude', height_mm: 500, ...props },
  };
  const nodes = [storey, ax('A', 5000, 3000), ax('B', 9000, 3000), sk];
  const map = new Map(nodes.map((n) => [n.id, n]));
  const edges: BubbleGraphEdge[] = refs.map((r, i) => ({ id: `e${i}`, from: 'sk', to: r }));
  const res = computeSketch(sk, map, edges);
  return { res, dims: sketchDims(res) };
}
const byId = (dims: ReturnType<typeof sketchDims>, id: string) => dims.find((d) => d.id === id)!;

describe('sketchDims', () => {
  it('a rectangle shows width and depth on its outside', () => {
    const { dims } = make({ shape: 'rect', shape_x_mm: 1000, shape_y_mm: 2000, shape_w_mm: 3000, shape_h_mm: 1500 });
    expect(dims.map((d) => d.id)).toEqual(['w', 'h']);
    const w = byId(dims, 'w');
    expect(w.valueMm).toBe(3000);
    expect(w.a).toEqual({ x: 1000, y: 2000 });
    expect(w.b).toEqual({ x: 4000, y: 2000 });
    expect(w.side).toBe(-1); // below the bottom edge, outside
    expect(byId(dims, 'h').valueMm).toBe(1500);
  });

  it('a circle shows its radius', () => {
    const { dims } = make({ shape: 'circle', shape_x_mm: 500, shape_y_mm: 500, shape_r_mm: 700 });
    expect(dims.map((d) => d.id)).toEqual(['r']);
    expect(byId(dims, 'r').b).toEqual({ x: 1200, y: 500 });
  });

  it('a free contour shows every segment, closing leg included', () => {
    const { dims } = make({ outline: serialiseOutline([{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 4000 }]) });
    expect(dims.map((d) => d.id)).toEqual(['seg0', 'seg1', 'seg2']);
    expect(byId(dims, 'seg2').valueMm).toBe(5000);
    // CCW ring: outside is the right-hand side.
    expect(byId(dims, 'seg0').side).toBe(-1);
  });

  it('an open path has no closing leg', () => {
    const { dims } = make({ closed: 'False', op: 'none', outline: serialiseOutline([{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 4000 }]) });
    expect(dims.map((d) => d.id)).toEqual(['seg0', 'seg1']);
  });

  it('a mirrored sketch hangs its lines on the other side', () => {
    const plain = make({ shape: 'rect', shape_w_mm: 3000, shape_h_mm: 1500 });
    const mirrored = make({ shape: 'rect', shape_w_mm: 3000, shape_h_mm: 1500, ref_mirror: 'True' });
    expect(byId(mirrored.dims, 'w').side).toBe(-byId(plain.dims, 'w').side);
  });

  it('with a reference, the offset along and across the line is shown', () => {
    const { dims } = make({ shape: 'rect', shape_x_mm: 1200, shape_y_mm: 800, shape_w_mm: 1000, shape_h_mm: 1000 }, ['A', 'B']);
    const u = byId(dims, 'u'), v = byId(dims, 'v');
    expect(u.valueMm).toBeCloseTo(1200, 9);
    expect(u.a).toEqual({ x: 5000, y: 3000 });
    expect(u.b.x).toBeCloseTo(6200, 9);
    expect(v.valueMm).toBeCloseTo(800, 9);
    expect(v.b.y).toBeCloseTo(3800, 9);
  });

  it('a zero offset draws no line', () => {
    const { dims } = make({ shape: 'rect', shape_x_mm: 0, shape_y_mm: 0, shape_w_mm: 1000, shape_h_mm: 1000 }, ['A']);
    expect(dims.map((d) => d.id)).toEqual(['w', 'h']);
  });

  it('an array shows the step between the first two copies', () => {
    const { dims } = make({ shape: 'rect', shape_w_mm: 1000, shape_h_mm: 1000, array_count: 3, array_dx_mm: 2500, array_dy_mm: 0 });
    expect(byId(dims, 'step').valueMm).toBe(2500);
    const fitted = make({ shape: 'rect', shape_w_mm: 1000, shape_h_mm: 1000, array_count: 5, array_along: 'ref', array_fit: 'True' }, ['A', 'B']);
    expect(byId(fitted.dims, 'step').valueMm).toBeCloseTo(1000, 9);
  });
});

describe('applySketchDim', () => {
  it('width keeps the corner; depth keeps the width', () => {
    const { res, dims } = make({ shape: 'rect', shape_x_mm: 1000, shape_y_mm: 2000, shape_w_mm: 3000, shape_h_mm: 1500 });
    const e = applySketchDim(res, byId(dims, 'w'), 4200)!;
    expect(e.params).toMatchObject({ xMm: 1000, yMm: 2000, wMm: 4200, hMm: 1500 });
    const f = applySketchDim(res, byId(dims, 'h'), 900)!;
    expect(f.params).toMatchObject({ wMm: 3000, hMm: 900 });
  });

  it('a segment keeps its start and its direction', () => {
    const { res, dims } = make({ outline: serialiseOutline([{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 4000 }]) });
    const e = applySketchDim(res, byId(dims, 'seg2'), 2500)!; // (3000,4000) → (0,0), len 5000
    expect(e.outline![2]).toEqual({ x: 3000, y: 4000 });
    expect(e.outline![0].x).toBeCloseTo(1500, 9);
    expect(e.outline![0].y).toBeCloseTo(2000, 9);
    expect(e.outline![1]).toEqual({ x: 3000, y: 0 });
  });

  it('an offset edit slides the shape without resizing it', () => {
    const { res, dims } = make({ shape: 'rect', shape_x_mm: 1200, shape_y_mm: 800, shape_w_mm: 1000, shape_h_mm: 1000 }, ['A', 'B']);
    const e = applySketchDim(res, byId(dims, 'u'), 2000)!;
    expect(e.params).toMatchObject({ xMm: 2000, yMm: 800, wMm: 1000, hMm: 1000 });
    const f = applySketchDim(res, byId(dims, 'v'), -300)!;
    expect(f.params!.yMm).toBeCloseTo(-300, 9);
    expect(f.params!.xMm).toBeCloseTo(1200, 9);
  });

  it('an offset edit on a contour moves every point together', () => {
    const { res, dims } = make({ outline: serialiseOutline([{ x: 100, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 4000 }]) }, ['A']);
    const e = applySketchDim(res, byId(dims, 'u'), 600)!;
    expect(e.outline![0].x).toBeCloseTo(600, 9);
    expect(e.outline![1].x).toBeCloseTo(3500, 9);
    expect(e.outline![2].y).toBeCloseTo(4000, 9);
  });

  it('an offset edit honours a rotated, mirrored frame', () => {
    const { res, dims } = make(
      { shape: 'circle', shape_x_mm: 1000, shape_y_mm: 400, shape_r_mm: 300, ref_rot_deg: 37, ref_mirror: 'True', ref_dx_mm: 55 },
      ['A', 'B'],
    );
    const e = applySketchDim(res, byId(dims, 'u'), 1500)!;
    // Re-read the dims from the edited state: u is now 1500 and v unchanged.
    const sk: BubbleGraphNode = {
      ...res.intent as unknown as BubbleGraphNode, id: 'sk', type: 'sketch', name: 'S', x: 0, y: 0, z: 0, parentId: 'st1',
      properties: {
        op: 'extrude', height_mm: 500, shape: 'circle', shape_r_mm: 300, ref_rot_deg: 37, ref_mirror: 'True', ref_dx_mm: 55,
        shape_x_mm: e.params!.xMm, shape_y_mm: e.params!.yMm,
      },
    };
    const nodes = [storey, ax('A', 5000, 3000), ax('B', 9000, 3000), sk];
    const map = new Map(nodes.map((n) => [n.id, n]));
    const edges: BubbleGraphEdge[] = [{ id: 'e0', from: 'sk', to: 'A' }, { id: 'e1', from: 'sk', to: 'B' }];
    const after = sketchDims(computeSketch(sk, map, edges));
    expect(byId(after, 'u').valueMm).toBeCloseTo(1500, 6);
    expect(byId(after, 'v').valueMm).toBeCloseTo(byId(dims, 'v').valueMm, 6);
  });

  it('the step edits the step, or the count when fitted, or scales the vector', () => {
    const vec = make({ shape: 'rect', shape_w_mm: 1000, shape_h_mm: 1000, array_count: 3, array_dx_mm: 3000, array_dy_mm: 4000 });
    expect(applySketchDim(vec.res, byId(vec.dims, 'step'), 2500)!.props).toEqual({ array_dx_mm: 1500, array_dy_mm: 2000 });

    const ref = make({ shape: 'rect', shape_w_mm: 1000, shape_h_mm: 1000, array_count: 3, array_along: 'ref', array_step_mm: 1000 }, ['A', 'B']);
    expect(applySketchDim(ref.res, byId(ref.dims, 'step'), 1250)!.props).toEqual({ array_step_mm: 1250 });

    const fit = make({ shape: 'rect', shape_w_mm: 1000, shape_h_mm: 1000, array_count: 5, array_along: 'ref', array_fit: 'True' }, ['A', 'B']);
    // 4000 mm line, 800 mm step → 5 gaps → 6 copies.
    expect(applySketchDim(fit.res, byId(fit.dims, 'step'), 800)!.props).toEqual({ array_count: 6 });
  });

  it('refuses nonsense', () => {
    const { res, dims } = make({ shape: 'rect', shape_w_mm: 3000, shape_h_mm: 1500 });
    expect(applySketchDim(res, byId(dims, 'w'), 0)).toBeNull();
    expect(applySketchDim(res, byId(dims, 'w'), NaN)).toBeNull();
  });
});
