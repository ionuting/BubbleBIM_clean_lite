/**
 * dims.ts — the numbers a sketch shows on the plan, and what typing over one does.
 *
 * A parametric shape is only as editable as its dimensions are visible. So a
 * selected sketch carries its own dimension lines: the sides of a rectangle,
 * the radius of a circle, every segment of a free contour, the offset from
 * its reference ax, the step of its array. Each one is a value that can be
 * typed over, and `applySketchDim` says exactly which stored number that
 * rewrites — it never moves anything the typed value does not name.
 *
 * Endpoints are BIM millimetres; the viewer projects them. `side` says where
 * the line hangs: +1 to the LEFT of a→b in BIM (y up), −1 to the right — the
 * outside of the shape, so the lines never cross the drawing.
 */
import type { Pt2 } from '@/lib/geom/plan2d';
import { polygonArea } from '@/lib/geom/plan2d';
import { arrayStep } from './build';
import { localToWorld, worldToLocal } from './frame';
import type { ShapeParams } from './shapes';
import type { SketchResult } from './types';

export type SketchDimKind = 'w' | 'h' | 'r' | 'seg' | 'u' | 'v' | 'step';

export interface SketchDim {
  /** Stable across renders: `${kind}` or `seg${i}`. */
  id: string;
  kind: SketchDimKind;
  a: Pt2;
  b: Pt2;
  valueMm: number;
  side: 1 | -1;
  /** Segment start index, `seg` only. */
  index?: number;
}

/** What a typed value becomes — frame-local shape edits, or a property patch. */
export interface SketchDimEdit {
  params?: ShapeParams;
  outline?: Pt2[];
  props?: Record<string, unknown>;
}

/** Anything shorter than this has nothing to draw a line for. */
const MIN_DIM_MM = 1;

/** The local point a sketch is "at": rect corner, circle centre, first vertex. */
export function sketchAnchorLocal(res: SketchResult): Pt2 | null {
  const { shape, shapeParams: sp, localOutline } = res.intent;
  if (shape === 'rect' || shape === 'circle') return { x: sp.xMm, y: sp.yMm };
  if (shape === 'curve') return res.intent.curve?.points[0] ?? null;
  return localOutline[0] ?? null;
}

export function sketchDims(res: SketchResult): SketchDim[] {
  const { intent, frame } = res;
  const { shape, shapeParams: sp, ref } = intent;
  const W = (p: Pt2) => localToWorld(frame, ref, p);
  // A mirror flips the winding, so "outside" swaps sides with it.
  const flip: 1 | -1 = ref.mirror ? -1 : 1;
  const out: SketchDim[] = [];

  if (shape === 'rect') {
    const c0 = { x: sp.xMm, y: sp.yMm }, c1 = { x: sp.xMm + sp.wMm, y: sp.yMm }, c2 = { x: sp.xMm + sp.wMm, y: sp.yMm + sp.hMm };
    if (sp.wMm >= MIN_DIM_MM) out.push({ id: 'w', kind: 'w', a: W(c0), b: W(c1), valueMm: sp.wMm, side: (-1 * flip) as 1 | -1 });
    if (sp.hMm >= MIN_DIM_MM) out.push({ id: 'h', kind: 'h', a: W(c1), b: W(c2), valueMm: sp.hMm, side: (-1 * flip) as 1 | -1 });
  } else if (shape === 'circle') {
    if (sp.rMm >= MIN_DIM_MM) {
      out.push({ id: 'r', kind: 'r', a: W({ x: sp.xMm, y: sp.yMm }), b: W({ x: sp.xMm + sp.rMm, y: sp.yMm }), valueMm: sp.rMm, side: 1 });
    }
  } else if (shape === 'poly') {
    // A curve has no sides to dimension: its outline is dozens of chords.
    const pts = intent.localOutline;
    const n = pts.length;
    const segs = intent.closed ? n : n - 1;
    // Outside a CCW ring is its right-hand side; a CW ring's is its left.
    const ccw = !intent.closed || polygonArea(pts) >= 0;
    const side = ((ccw ? -1 : 1) * flip) as 1 | -1;
    for (let i = 0; i < segs; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < MIN_DIM_MM) continue;
      out.push({ id: `seg${i}`, kind: 'seg', index: i, a: W(p), b: W(q), valueMm: len, side });
    }
  }

  // Offset from the reference: along the line, then across it.
  const anchor = sketchAnchorLocal(res);
  if (frame.refIds.length > 0 && anchor) {
    const A = W(anchor);
    const O = frame.origin;
    const dx = A.x - O.x, dy = A.y - O.y;
    const u = dx * frame.dir.x + dy * frame.dir.y;
    const v = -dx * frame.dir.y + dy * frame.dir.x;
    const F = { x: O.x + frame.dir.x * u, y: O.y + frame.dir.y * u };
    if (Math.abs(u) >= MIN_DIM_MM) out.push({ id: 'u', kind: 'u', a: O, b: F, valueMm: u, side: v >= 0 ? -1 : 1 });
    if (Math.abs(v) >= MIN_DIM_MM) out.push({ id: 'v', kind: 'v', a: F, b: A, valueMm: v, side: u >= 0 ? 1 : -1 });
  }

  // The array step, between the first two copies.
  if (intent.array.count > 1 && anchor) {
    const d = arrayStep(intent.array, frame);
    const len = Math.hypot(d.x, d.y);
    if (len >= MIN_DIM_MM) {
      const A = W(anchor);
      out.push({ id: 'step', kind: 'step', a: A, b: { x: A.x + d.x, y: A.y + d.y }, valueMm: len, side: 1 });
    }
  }
  return out;
}

/**
 * Rewrite the one thing the dimension names. Returns null when the value is
 * not usable (non-finite, or a length below a millimetre).
 */
export function applySketchDim(res: SketchResult, dim: SketchDim, valueMm: number): SketchDimEdit | null {
  if (!Number.isFinite(valueMm)) return null;
  const { intent, frame } = res;
  const { shapeParams: sp, ref, array } = intent;

  switch (dim.kind) {
    case 'w':
      return valueMm < MIN_DIM_MM ? null : { params: { ...sp, wMm: valueMm } };
    case 'h':
      return valueMm < MIN_DIM_MM ? null : { params: { ...sp, hMm: valueMm } };
    case 'r':
      return valueMm < MIN_DIM_MM ? null : { params: { ...sp, rMm: valueMm } };

    case 'seg': {
      // Keep the segment's start and direction; move only its end.
      if (valueMm < MIN_DIM_MM || dim.index === undefined) return null;
      const pts = intent.localOutline;
      const i = dim.index, j = (i + 1) % pts.length;
      const p = pts[i], q = pts[j];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < MIN_DIM_MM) return null;
      const k = valueMm / len;
      const moved = { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
      return { outline: pts.map((pt, idx) => (idx === j ? moved : pt)) };
    }

    case 'u':
    case 'v': {
      // Put the anchor where the new offset says, then re-express it locally
      // so mirror/rotation/slide are all honoured.
      const anchor = sketchAnchorLocal(res);
      if (!anchor) return null;
      const A = localToWorld(frame, ref, anchor);
      const O = frame.origin;
      const dx = A.x - O.x, dy = A.y - O.y;
      let u = dx * frame.dir.x + dy * frame.dir.y;
      let v = -dx * frame.dir.y + dy * frame.dir.x;
      if (dim.kind === 'u') u = valueMm; else v = valueMm;
      const T = { x: O.x + frame.dir.x * u - frame.dir.y * v, y: O.y + frame.dir.y * u + frame.dir.x * v };
      const L = worldToLocal(frame, ref, T);
      if (intent.shape === 'rect' || intent.shape === 'circle') return { params: { ...sp, xMm: L.x, yMm: L.y } };
      const sx = L.x - anchor.x, sy = L.y - anchor.y;
      // A curve moves its own points; writing its outline back would replace
      // them with the polyline that only stands for the curve.
      const own = intent.curve?.points ?? intent.localOutline;
      return { outline: own.map((pt) => ({ x: pt.x + sx, y: pt.y + sy })) };
    }

    case 'step': {
      if (valueMm < MIN_DIM_MM) return null;
      if (array.along === 'ref' && frame.refLengthMm > 0) {
        // Fitted: the step is derived from the count, so typing a step means
        // "how many of these fit" — the count is what changes.
        if (array.fit) return { props: { array_count: Math.max(2, Math.floor(frame.refLengthMm / valueMm + 1e-9) + 1) } };
        return { props: { array_step_mm: valueMm } };
      }
      const len = Math.hypot(array.dxMm, array.dyMm);
      if (len < MIN_DIM_MM) return null;
      const k = valueMm / len;
      return { props: { array_dx_mm: array.dxMm * k, array_dy_mm: array.dyMm * k } };
    }
  }
}
