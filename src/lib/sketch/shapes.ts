/**
 * shapes.ts — what a sketch IS, before it is a list of points.
 *
 * A rectangle drawn with two clicks is a rectangle, not four arbitrary
 * vertices that happen to form one. Keeping it that way is what makes it
 * editable by NUMBER — width 4200 typed into the Inspector — and what keeps a
 * dragged corner square instead of turning the shape into a quadrilateral.
 *
 * So a sketch carries a `shape`, and the outline is DERIVED for the
 * parametric ones:
 *
 *   rect   — origin (min corner) + width + height, axis aligned
 *   circle — centre + radius, polygonised
 *   curve  — a NURBS curve: the stored points are the points it passes
 *            THROUGH (or its control polygon), the outline is the curve read
 *            at a chord tolerance — see `geom/nurbs.ts`
 *   poly   — the points themselves; there is nothing to derive
 *
 * The derived outline is still written to the node alongside the parameters,
 * so anything reading `properties.outline` raw keeps working; the parameters
 * are the source of truth and `sketchOutline` is where that is decided.
 */
import type { Pt2 } from '@/lib/geom/plan2d';
import {
  bsplineFromControl, interpolateClosed, interpolateOpen, periodicFromControl, tessellate,
  type Nurbs2,
} from '@/lib/geom/nurbs';

export type SketchShape = 'poly' | 'rect' | 'circle' | 'curve';

/**
 * How a curve reads its stored points.
 *
 *   fit     — the curve passes THROUGH every point: what an architect draws
 *   control — the points are the control polygon: the curve is pulled
 *             towards them, the finer, CAD-style control
 */
export type CurveMode = 'fit' | 'control';

/** Chord tolerance a curve is read at, mm — invisible at any drawing scale. */
export const CURVE_TOLERANCE_MM = 0.5;

/** The exact curve the stored points describe, or null when there are too few. */
export function curveFromPoints(points: Pt2[], closed: boolean, mode: CurveMode, degree = 3): Nurbs2 | null {
  if (points.length < (closed ? 3 : 2)) return null;
  if (mode === 'control') return closed ? periodicFromControl(points, degree) : bsplineFromControl(points, degree);
  return closed ? interpolateClosed(points, degree) : interpolateOpen(points, degree);
}

/** The curve as the polyline every pipeline consumes. */
export function curveOutline(points: Pt2[], closed: boolean, mode: CurveMode, degree = 3): Pt2[] | null {
  const c = curveFromPoints(points, closed, mode, degree);
  return c ? tessellate(c, CURVE_TOLERANCE_MM) : null;
}

/** Segments a parametric circle is approximated by. */
export const CIRCLE_SEGMENTS = 48;

/** Below this a shape has no area worth keeping. */
export const MIN_SHAPE_MM = 1;

export interface ShapeParams {
  /** rect: the min corner. circle: the centre. */
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
  rMm: number;
}

export const DEFAULT_SHAPE_PARAMS: ShapeParams = { xMm: 0, yMm: 0, wMm: 0, hMm: 0, rMm: 0 };

/** An axis-aligned rectangle, CCW from its min corner. */
export function rectFromParams(xMm: number, yMm: number, wMm: number, hMm: number): Pt2[] {
  const w = Math.max(MIN_SHAPE_MM, wMm), h = Math.max(MIN_SHAPE_MM, hMm);
  return [{ x: xMm, y: yMm }, { x: xMm + w, y: yMm }, { x: xMm + w, y: yMm + h }, { x: xMm, y: yMm + h }];
}

/** A circle about (cx, cy), CCW, starting at angle 0. */
export function circleFromParams(cxMm: number, cyMm: number, rMm: number, segments = CIRCLE_SEGMENTS): Pt2[] {
  const r = Math.max(MIN_SHAPE_MM, rMm);
  const n = Math.max(8, Math.round(segments));
  const out: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cxMm + Math.cos(a) * r, y: cyMm + Math.sin(a) * r });
  }
  return out;
}

/** The outline a parametric shape describes, or null for a free polygon. */
export function shapeOutline(shape: SketchShape, p: ShapeParams): Pt2[] | null {
  if (shape === 'rect') return rectFromParams(p.xMm, p.yMm, p.wMm, p.hMm);
  if (shape === 'circle') return circleFromParams(p.xMm, p.yMm, p.rMm);
  return null;
}

/** Parameters that reproduce an existing outline — used when a tool commits. */
export function paramsForRect(a: Pt2, b: Pt2): ShapeParams {
  return {
    xMm: Math.min(a.x, b.x), yMm: Math.min(a.y, b.y),
    wMm: Math.abs(b.x - a.x), hMm: Math.abs(b.y - a.y), rMm: 0,
  };
}

export function paramsForCircle(centre: Pt2, edge: Pt2): ShapeParams {
  return { xMm: centre.x, yMm: centre.y, wMm: 0, hMm: 0, rMm: Math.hypot(edge.x - centre.x, edge.y - centre.y) };
}

/**
 * What dragging vertex `index` to `pt` does.
 *
 * A rectangle resizes from the OPPOSITE corner, which stays put — the gesture
 * every CAD tool uses, and the one that keeps the shape a rectangle. A circle
 * takes its radius from the distance to the centre. A free polygon simply
 * moves that point. Returns the new parameters (parametric shapes) or the new
 * outline (free ones); never both.
 */
export function dragVertex(
  shape: SketchShape,
  params: ShapeParams,
  outline: Pt2[],
  index: number,
  pt: Pt2,
): { params?: ShapeParams; outline?: Pt2[] } {
  if (shape === 'rect') {
    // Vertices run CCW from the min corner, so the opposite one is +2.
    const fixed = rectFromParams(params.xMm, params.yMm, params.wMm, params.hMm)[(index + 2) % 4];
    return { params: { ...paramsForRect(fixed, pt), rMm: 0 } };
  }
  if (shape === 'circle') {
    return { params: { ...params, rMm: Math.max(MIN_SHAPE_MM, Math.hypot(pt.x - params.xMm, pt.y - params.yMm)) } };
  }
  if (index < 0 || index >= outline.length) return {};
  return { outline: outline.map((p, i) => (i === index ? { x: pt.x, y: pt.y } : p)) };
}

/** Move a whole shape by (dx, dy) — parameters for the parametric ones. */
export function translateShape(
  shape: SketchShape,
  params: ShapeParams,
  outline: Pt2[],
  dxMm: number,
  dyMm: number,
): { params?: ShapeParams; outline?: Pt2[] } {
  if (shape === 'rect' || shape === 'circle') {
    return { params: { ...params, xMm: params.xMm + dxMm, yMm: params.yMm + dyMm } };
  }
  // A free polygon and a curve both own their points outright.
  return { outline: outline.map((p) => ({ x: p.x + dxMm, y: p.y + dyMm })) };
}
