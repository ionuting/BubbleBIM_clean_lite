/**
 * brush.ts — the footprint of the terrain sculpt brush.
 *
 * Pure: given the brush and the offset of a grid vertex from the brush centre,
 * it says how strongly that vertex is affected. Kept out of the viewer so the
 * two shapes' falloff laws can be stated — and tested — without a WebGL canvas.
 *
 * Offsets are in TERRAIN metres, measured along the terrain's own axes, which
 * is the space the height grid lives in.
 */

export type BrushShape = 'circle' | 'rect';

export interface BrushFootprint {
  shape: BrushShape;
  /** Circle: the radius, m. */
  radiusM: number;
  /** Rectangle: the full side lengths, m. */
  widthM: number;
  depthM: number;
  /** Rectangle: rotation of its width axis off terrain X, radians CCW. */
  rotRad: number;
}

/**
 * The fraction of the rectangle's half-size that is rim rather than plateau.
 *
 * A circular brush is a dome by nature — that is what it is for. A rectangle
 * is drawn when the user wants a flat platform, so the inner 75% is left at
 * full strength and only the rim ramps out. Same brush, different intent.
 */
export const RECT_EDGE_FRACTION = 0.25;

const smoothstep = (u: number): number => {
  const t = Math.max(0, Math.min(1, u));
  return t * t * (3 - 2 * t);
};

/**
 * How far from the centre the brush can still reach, m — the half-diagonal for
 * a rectangle. Used to bound the grid loop, so it may over- rather than
 * under-estimate; `brushWeight` returns 0 outside the true footprint anyway.
 */
export function brushReachM(b: BrushFootprint): number {
  return b.shape === 'rect' ? Math.hypot(b.widthM / 2, b.depthM / 2) : b.radiusM;
}

/**
 * Strength at a point `du, dv` metres from the brush centre: 1 at full effect,
 * 0 outside the footprint.
 *
 * The circle falls off from its very centre (`smoothstep(1 − d/r)`); the
 * rectangle holds a plateau and ramps only over its rim. A brush with a
 * non-positive dimension covers nothing rather than dividing by zero.
 */
export function brushWeight(b: BrushFootprint, du: number, dv: number): number {
  if (b.shape === 'rect') {
    const hw = b.widthM / 2, hd = b.depthM / 2;
    if (hw <= 0 || hd <= 0) return 0;
    const c = Math.cos(b.rotRad), s = Math.sin(b.rotRad);
    // Into the rectangle's own frame, then normalise each axis by its half-size:
    // the level sets of `q` are rectangles, which is exactly the wanted shape.
    const lu = du * c + dv * s, lv = -du * s + dv * c;
    const q = Math.max(Math.abs(lu) / hw, Math.abs(lv) / hd);
    if (q > 1) return 0;
    return smoothstep((1 - q) / RECT_EDGE_FRACTION);
  }
  if (b.radiusM <= 0) return 0;
  const d = Math.hypot(du, dv);
  if (d > b.radiusM) return 0;
  return smoothstep(1 - d / b.radiusM);
}
