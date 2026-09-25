/**
 * annotationGeometry — the arithmetic behind a placed annotation.
 *
 * Small enough to live in the layer that draws it, except that the one thing
 * in here is exactly the thing that was wrong, silently, in every drawing the
 * app has: which side of a baseline a dimension line sits on.
 */

export interface Pt2 { x: number; y: number }

/**
 * The unit normal of `p1`→`p2`, expressed in the HOST's SVG units.
 *
 * A dimension's `offsetDir` is measured at placement time against a normal
 * built in LOGICAL coordinates — model millimetres, Y pointing up the way a
 * drawing does. Every viewer then maps logical to SVG with Y flipped, because
 * SVG counts Y downwards.
 *
 * A flip reverses a normal. So rebuilding the normal from the PROJECTED
 * endpoints — `n = perp(s2 − s1)`, which is what the renderer used to do —
 * produces a vector pointing the opposite way to the one the offset was
 * measured against, and the dimension line lands on the side the user did not
 * click. The preview, drawn entirely in SVG space, showed the right side while
 * placing, so the line appeared to jump across its own baseline on release.
 *
 * Mapping the logical normal THROUGH `toSvg` as a direction — the difference
 * between two mapped points — keeps the two in step whatever the host's
 * transform does: flipped, scaled, or rotated. It costs two extra `toSvg`
 * calls per dimension.
 *
 * Returns `null` when the baseline is degenerate, or when the transform
 * collapses it to nothing, so the caller can decline to draw rather than emit
 * `NaN` coordinates into the SVG.
 */
export function offsetNormalSvg(
  p1: Pt2,
  p2: Pt2,
  toSvg: (x: number, y: number) => Pt2,
): Pt2 | null {
  const ldx = p2.x - p1.x;
  const ldy = p2.y - p1.y;
  const llen = Math.hypot(ldx, ldy);
  if (!(llen > 1e-9)) return null;

  // Perpendicular in logical space — the same one `dim:offset` measures against.
  const lnx = -ldy / llen;
  const lny = ldx / llen;

  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const a = toSvg(mx, my);
  const b = toSvg(mx + lnx, my + lny);

  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const vlen = Math.hypot(vx, vy);
  if (!(vlen > 1e-12)) return null;

  return { x: vx / vlen, y: vy / vlen };
}
