/**
 * Convert browser client coordinates to SVG user-space (viewBox) coordinates.
 * Uses getScreenCTM() so pan/zoom CSS transforms and preserveAspectRatio letterboxing
 * are handled correctly (manual rect.width mapping is wrong when aspect ratios differ).
 */
export function clientToSvgUserPoint(
  svg: SVGSVGElement | null | undefined,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!svg) return null;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const loc = pt.matrixTransform(ctm.inverse());
  return { x: loc.x, y: loc.y };
}
