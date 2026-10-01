/**
 * merge.ts — what the kernel's own plan shows of walls and openings.
 *
 * `cutShapes` slices every solid separately, so two walls meeting at a T come
 * back as two closed faces that happen to share an edge, and the drawing gets
 * a line across the poché where the masonry is in fact continuous. Doors and
 * windows come back as themselves: the actual leaf, frame and glass the
 * kernel built, drawn at cut height.
 *
 * Both are faithful to the model and wrong for a drawing. A plan shows walls
 * as one poché and openings as SYMBOLS, so this pass does two things to the
 * cut before it is assembled:
 *
 *   • the wall faces are unioned, and only the boundary of that union keeps a
 *     pen — each face still carries its own fill and hatch, so materials read
 *     as they did;
 *   • the opening solids are dropped, leaving the hole they were sitting in
 *     for the symbol layer to draw into.
 *
 * Neither is forced: `OgMergeOptions` turns each off, and with both off this
 * returns the shapes untouched.
 */

import type { DrawingShape } from '@/lib/drawingEngine';
import { unionPolygons, type Poly, type Pt } from '@/lib/plan/wallSilhouette';

export interface OgMergeOptions {
  /**
   * Draw the walls as one silhouette rather than face by face.
   * Default true.
   */
  mergeWalls?: boolean;
  /**
   * Leave out the real geometry of doors and windows, so the plan shows the
   * hole and the symbol over it instead of the leaf the kernel built.
   * Default true.
   */
  hideOpeningSolids?: boolean;
}

const OPENING_TYPES = new Set(['door', 'window']);

/** A cut face of a wall — the only thing the silhouette merges. */
function isWallCut(s: DrawingShape): boolean {
  return s.closed && s.nodeType === 'wall' && s.lineWeight === 'heavy-cut';
}

const toPt = (p: { u: number; v: number }): Pt => ({ x: p.u, y: p.v });
const toUV = (p: Pt) => ({ u: p.x, v: p.y });

export function mergeOgCut(
  shapes: DrawingShape[],
  opts: OgMergeOptions = {},
): DrawingShape[] {
  const { mergeWalls = true, hideOpeningSolids = true } = opts;

  let out = shapes;

  if (hideOpeningSolids) {
    out = out.filter((s) => !OPENING_TYPES.has(s.nodeType));
  }

  if (!mergeWalls) return out;

  const walls = out.filter(isWallCut);
  // One wall cannot seam against anything, so there is nothing to merge.
  if (walls.length < 2) return out;

  const polys: Poly[] = walls.map((s) => ({
    outer: s.pts.map(toPt),
    holes: (s.holes ?? []).map((h) => h.map(toPt)),
  }));
  const merged = unionPolygons(polys);
  if (merged.length === 0) return out;

  // The pen the silhouette takes. Walls of different materials outline in
  // different colours today; merged they can only have one, so it is the one
  // the most wall faces already use — the drawing's dominant wall.
  const tally = new Map<string, number>();
  for (const s of walls) tally.set(s.strokeColor, (tally.get(s.strokeColor) ?? 0) + 1);
  const pen = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const outline: DrawingShape[] = merged.map((p, i) => ({
    pts: p.outer.map(toUV),
    closed: true,
    holes: p.holes.length ? p.holes.map((h) => h.map(toUV)) : undefined,
    hatch: 'none',
    fillColor: 'none',
    strokeColor: pen,
    lineWeight: 'heavy-cut',
    // Drawn with the walls it came from, so anything in front still covers it.
    depthMm: walls[0].depthMm,
    nodeId: `og:wall-silhouette:${i}`,
    nodeType: 'wall',
  }));

  // The faces keep their fill and hatch and give up only their outline —
  // `strokeColor: 'none'` is what the renderer reads as no pen.
  return [
    ...out.map((s) => (isWallCut(s) ? { ...s, strokeColor: 'none' } : s)),
    ...outline,
  ];
}
