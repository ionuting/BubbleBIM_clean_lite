/**
 * tools.ts — turning clicks into an outline.
 *
 * The state machine a drawing tool needs is small and it is pure: a list of
 * clicked points plus the cursor is enough to say both what would be created
 * and what the preview should show. Keeping it here rather than inside the
 * viewer means the rectangle's corner order, the circle's segment count and
 * the "is this finishable yet" rule are all testable without a DOM.
 */
import type { Pt2 } from '@/lib/geom/plan2d';
import { CIRCLE_SEGMENTS, circleFromParams, curveOutline, rectFromParams } from './shapes';

export { CIRCLE_SEGMENTS };

/**
 * What the user is drawing.
 *
 * `polyline` and `path` collect the same clicks — the difference is only what
 * the finished sketch does with them (a closed profile to extrude, or an open
 * run to sweep a profile along), and that shows up in the node's `op`.
 */
export type SketchTool = 'polyline' | 'rect' | 'circle' | 'path' | 'curve' | 'curvepath';

export interface SketchToolDef {
  tool: SketchTool;
  label: string;
  hint: string;
  /** The operation a sketch made with this tool starts on. */
  op: 'extrude' | 'sweep';
  closed: boolean;
}

export const SKETCH_TOOLS: SketchToolDef[] = [
  {
    tool: 'polyline',
    label: 'Contur',
    hint: 'Clic pentru fiecare punct, dublu-clic sau Enter pentru a închide conturul.',
    op: 'extrude',
    closed: true,
  },
  {
    tool: 'rect',
    label: 'Dreptunghi',
    hint: 'Clic pe un colț, apoi pe colțul opus.',
    op: 'extrude',
    closed: true,
  },
  {
    tool: 'circle',
    label: 'Cerc',
    hint: 'Clic în centru, apoi pe margine pentru rază.',
    op: 'extrude',
    closed: true,
  },
  {
    tool: 'path',
    label: 'Traseu',
    hint: 'Clic pentru fiecare punct, dublu-clic sau Enter pentru a termina. Profilul se plimbă pe traseu.',
    op: 'sweep',
    closed: false,
  },
  {
    tool: 'curve',
    label: 'Curbă',
    hint: 'Curbă NURBS închisă prin punctele date — clic pentru fiecare punct, dublu-clic sau Enter pentru a închide.',
    op: 'extrude',
    closed: true,
  },
  {
    tool: 'curvepath',
    label: 'Traseu curb',
    hint: 'Curbă NURBS deschisă prin punctele date — clic pentru fiecare punct, dublu-clic sau Enter pentru a termina. Profilul se plimbă pe ea.',
    op: 'sweep',
    closed: false,
  },
];

/** Whether a tool draws a curve (its clicks are the points the curve passes through). */
export const isCurveTool = (tool: SketchTool): boolean => tool === 'curve' || tool === 'curvepath';

export const sketchToolDef = (tool: SketchTool): SketchToolDef =>
  SKETCH_TOOLS.find((t) => t.tool === tool) ?? SKETCH_TOOLS[0];

/** How many clicks a tool takes before it commits on its own. 0 = open-ended. */
export function sketchToolClicks(tool: SketchTool): number {
  return tool === 'rect' || tool === 'circle' ? 2 : 0;
}

/** The four corners of the rectangle spanned by two opposite points, CCW. */
export function rectOutline(a: Pt2, b: Pt2): Pt2[] {
  return rectFromParams(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
}

/** A circle through `edge` about `centre`, as a CCW polygon. */
export function circleOutline(centre: Pt2, edge: Pt2, segments = CIRCLE_SEGMENTS): Pt2[] {
  return circleFromParams(centre.x, centre.y, Math.hypot(edge.x - centre.x, edge.y - centre.y), segments);
}

/**
 * The outline the clicks so far describe, or null when there are too few.
 *
 * A rectangle or circle needs both of its points; a polyline needs three to
 * enclose anything and a path two to go anywhere. Below that there is nothing
 * to commit — so the caller can use a null here as "not finishable yet".
 */
export function sketchToolOutline(tool: SketchTool, pts: Pt2[]): Pt2[] | null {
  switch (tool) {
    case 'rect':
      return pts.length >= 2 ? rectOutline(pts[0], pts[1]) : null;
    case 'circle':
      return pts.length >= 2 ? circleOutline(pts[0], pts[1]) : null;
    case 'polyline':
      return pts.length >= 3 ? pts.slice() : null;
    case 'path':
      return pts.length >= 2 ? pts.slice() : null;
    case 'curve':
      return pts.length >= 3 ? curveOutline(pts, true, 'fit') : null;
    case 'curvepath':
      return pts.length >= 2 ? curveOutline(pts, false, 'fit') : null;
  }
}

/**
 * The rubber band to draw while the tool is live: the outline the current
 * clicks plus the cursor would make. Returns the points to stroke and whether
 * to close the loop when stroking them.
 */
export function sketchToolPreview(
  tool: SketchTool,
  pts: Pt2[],
  cursor: Pt2 | null,
): { points: Pt2[]; closed: boolean } | null {
  if (pts.length === 0) return null;
  const live = cursor ? [...pts, cursor] : pts;

  if (tool === 'rect' || tool === 'circle') {
    if (live.length < 2) return null;
    const outline = tool === 'rect'
      ? rectOutline(live[0], live[1])
      : circleOutline(live[0], live[1]);
    return { points: outline, closed: true };
  }
  if (live.length < 2) return null;
  // A curve previews as the curve itself — closing back once it can enclose.
  if (isCurveTool(tool)) {
    const closed = tool === 'curve' && live.length >= 3;
    return { points: curveOutline(live, closed, 'fit') ?? live, closed };
  }
  // A polyline previews its closing leg so the enclosed shape is visible
  // before committing; a path has no closing leg to show.
  return { points: live, closed: tool === 'polyline' };
}
