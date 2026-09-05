/**
 * sectionFromPlan — the section marker as ArchiCAD draws it, and the ONE
 * resolver every consumer reads it through.
 *
 * A `section` node carries:
 *   - `plan_cut {x1,y1,x2,y2}`  the marker line A→B in BIM mm. Its length is
 *                               the horizontal extent of the drawing.
 *   - `look_side 'left'|'right'` which side of A→B the viewer stands on. Left
 *                               of A→B is the CCW normal (A west, B east →
 *                               north). Flipping the marker changes this and
 *                               nothing else: the engine derives handedness.
 *   - `depth_mode`              'infinite' | 'limited' | 'zero' and
 *                               `cut_depth_mm` for the limited case.
 *   - `clip_to_marker`          clip the drawing to the marker's length.
 *   - `start_elevation_mm` / `cut_height_mm` — vertical range; a height ≤ 0
 *                               means "all storeys".
 *
 * Nodes made before this model had `flipped`, `cut_plane_offset_mm` and
 * `offset_left/right_mm`; `resolveSectionCut` still honours them so old
 * projects open unchanged, but the Inspector no longer offers them.
 *
 * `plan_cut` is optional: a marker can also hang off two `ax` anchors (the
 * graph-editor way), in which case the line runs between them.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { getAxRealPos } from '@/lib/bimGeometry';

export type PlanTool = 'draw-section' | 'section-on-axis' | null;

export interface PlanCut {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function parsePlanCut(raw: unknown): PlanCut | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const x1 = Number(o.x1), y1 = Number(o.y1), x2 = Number(o.x2), y2 = Number(o.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return { x1, y1, x2, y2 };
}

export type LookSide = 'left' | 'right';
export type DepthMode = 'infinite' | 'limited' | 'zero';

export const DEFAULT_CUT_DEPTH_MM = 6000;

/** The fully resolved marker — what the engine, the plan and the viewer draw. */
export interface SectionSpec {
  /** Marker endpoints in BIM mm (legacy offsets already applied). */
  line: PlanCut;
  lookSide: LookSide;
  depthMode: DepthMode;
  /** Depth in mm for 'limited'; Infinity for 'infinite'; 0 for 'zero'. */
  depthMm: number;
  clipToMarker: boolean;
  /** Vertical range; null = derive from the storeys. */
  elevMin: number | null;
  elevMax: number | null;
  /** Unit tangent A→B and the look normal (unit, pointing at the viewed side). */
  tangent: { x: number; y: number };
  normal: { x: number; y: number };
  lengthMm: number;
}

export function parseLookSide(raw: unknown, legacyFlipped?: unknown): LookSide {
  if (raw === 'right') return 'right';
  if (raw === 'left') return 'left';
  // Pre-model nodes: `flipped` mirrored the drawing; the closest honest
  // reading is "the other side".
  return legacyFlipped === true || legacyFlipped === 'true' ? 'right' : 'left';
}

export function parseDepthMode(raw: unknown): DepthMode {
  return raw === 'infinite' || raw === 'zero' ? raw : 'limited';
}

export function lookNormal(line: PlanCut, side: LookSide): { x: number; y: number } {
  const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
  const len = Math.hypot(dx, dy) || 1;
  const tx = dx / len, ty = dy / len;
  // CCW normal of the tangent is the left side.
  return side === 'left' ? { x: -ty, y: tx } : { x: ty, y: -tx };
}

/**
 * Read a section/view node into a SectionSpec. Returns null when the marker
 * has no line yet (no plan_cut and fewer than two ax anchors).
 */
export function resolveSectionCut(
  node: BubbleGraphNode,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): SectionSpec | null {
  const p = node.properties;
  let line = parsePlanCut(p.plan_cut);

  if (!line) {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const anchors = edges
      .filter((e) => e.from === node.id || e.to === node.id)
      .map((e) => nodeMap.get(e.from === node.id ? e.to : e.from))
      .filter((n): n is BubbleGraphNode => !!n && n.type === 'ax');
    if (anchors.length < 2) return null;
    const a = getAxRealPos(anchors[0], nodeMap);
    const b = getAxRealPos(anchors[1], nodeMap);
    line = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    // Legacy end extensions only ever applied to the ax-anchored form.
    const offL = Number(p.offset_left_mm ?? 0);
    const offR = Number(p.offset_right_mm ?? 0);
    if (offL || offR) {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const tx = (b.x - a.x) / len, ty = (b.y - a.y) / len;
      line = {
        x1: a.x - tx * offL, y1: a.y - ty * offL,
        x2: b.x + tx * offR, y2: b.y + ty * offR,
      };
    }
  }

  const lookSide = parseLookSide(p.look_side, p.flipped);
  const normal = lookNormal(line, lookSide);

  // Legacy plane offset: shift the line along the look normal.
  const planeOffset = Number(p.cut_plane_offset_mm ?? 0);
  if (Number.isFinite(planeOffset) && planeOffset !== 0) {
    line = {
      x1: line.x1 + normal.x * planeOffset, y1: line.y1 + normal.y * planeOffset,
      x2: line.x2 + normal.x * planeOffset, y2: line.y2 + normal.y * planeOffset,
    };
  }

  const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
  const lengthMm = Math.hypot(dx, dy);
  if (lengthMm < 1) return null;

  const depthMode = parseDepthMode(p.depth_mode);
  const rawDepth = Number(p.cut_depth_mm);
  const depthMm = depthMode === 'infinite'
    ? Infinity
    : depthMode === 'zero'
      ? 0
      : (Number.isFinite(rawDepth) && rawDepth > 0 ? rawDepth : DEFAULT_CUT_DEPTH_MM);

  const cutHeight = Number(p.cut_height_mm ?? 0);
  const startElev = Number(p.start_elevation_mm);
  const hasRange = Number.isFinite(startElev) && Number.isFinite(cutHeight) && cutHeight > 0;

  return {
    line,
    lookSide,
    depthMode,
    depthMm,
    clipToMarker: p.clip_to_marker !== false && p.clip_to_marker !== 'false',
    elevMin: hasRange ? startElev : null,
    elevMax: hasRange ? startElev + cutHeight : null,
    tangent: { x: dx / lengthMm, y: dy / lengthMm },
    normal,
    lengthMm,
  };
}

/** Which side of A→B a point lies on. */
export function sideOfLine(line: PlanCut, pt: { x: number; y: number }): LookSide {
  const cross = (line.x2 - line.x1) * (pt.y - line.y1) - (line.y2 - line.y1) * (pt.x - line.x1);
  return cross >= 0 ? 'left' : 'right';
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nextName(nodes: BubbleGraphNode[], type: 'section' | 'view'): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const existing = nodes.filter((n) => n.type === type).length;
  if (type === 'section') {
    const a = letters[existing % 26];
    return `Section ${a}-${a}`;
  }
  const dirs = ['West', 'East', 'South', 'North'];
  return `${dirs[existing % 4]} Elevation`;
}

/**
 * Constrain a freehand cut to the dominant axis (the engine takes any angle;
 * ortho is a drafting convenience). The first point stays put — it is what the
 * user clicked — and the second slides onto the axis line through it.
 * `free` skips the constraint. Always a `section`: a vertical marker is a
 * section looking east or west, not an elevation.
 */
export function orthoConstrainCut(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  free = false,
): { cut: PlanCut; kind: 'section' } {
  if (free) return { kind: 'section', cut: { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y } };
  const dx = Math.abs(p2.x - p1.x);
  const dy = Math.abs(p2.y - p1.y);
  if (dx >= dy) return { kind: 'section', cut: { x1: p1.x, y1: p1.y, x2: p2.x, y2: p1.y } };
  return { kind: 'section', cut: { x1: p1.x, y1: p1.y, x2: p1.x, y2: p2.y } };
}

/** Snap cursor to nearest axis line (X=const or Y=const). */
export function findNearestAxisLine(
  pt: { x: number; y: number },
  axisXVals: number[],
  axisYVals: number[],
  thresholdMm = 800,
): { dir: 'X' | 'Y'; value: number; dist: number } | null {
  let best: { dir: 'X' | 'Y'; value: number; dist: number } | null = null;
  for (const x of axisXVals) {
    const d = Math.abs(pt.x - x);
    if (d < thresholdMm && (!best || d < best.dist)) best = { dir: 'X', value: x, dist: d };
  }
  for (const y of axisYVals) {
    const d = Math.abs(pt.y - y);
    if (d < thresholdMm && (!best || d < best.dist)) best = { dir: 'Y', value: y, dist: d };
  }
  return best;
}

/**
 * A section along a whole grid line. West→east for a Y line (look-left =
 * north), south→north for an X line (look-left = west); the caller picks the
 * side with `look_side` afterwards.
 */
export function cutFromAxisLine(
  dir: 'X' | 'Y',
  value: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  padMm = 500,
): { cut: PlanCut; kind: 'section' } {
  if (dir === 'Y') {
    return {
      kind: 'section',
      cut: { x1: bounds.minX - padMm, y1: value, x2: bounds.maxX + padMm, y2: value },
    };
  }
  return {
    kind: 'section',
    cut: { x1: value, y1: bounds.minY - padMm, x2: value, y2: bounds.maxY + padMm },
  };
}

export interface CommitSectionResult {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  sectionId: string;
  kind: 'section' | 'view';
}

export function commitPlanCut(args: {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  storeyId: string;
  cut: PlanCut;
  kind: 'section' | 'view';
  lookSide?: LookSide;
  depthMode?: DepthMode;
  cutDepthMm?: number;
  viewDirection?: 'N' | 'S' | 'E' | 'W';
}): CommitSectionResult {
  const { nodes, edges, storeyId, cut, kind } = args;
  const sectionId = uid('node');
  const name = nextName(nodes, kind);
  const midX = (cut.x1 + cut.x2) / 2;
  const midY = (cut.y1 + cut.y2) / 2;

  const storey = nodes.find((n) => n.id === storeyId);
  const bottom = Number(storey?.properties?.bottomElevation ?? 0);
  const top = Number(storey?.properties?.topElevation ?? bottom + 3000);
  const cutHeight = Math.max(3000, top - bottom + 2000);

  const newNode: BubbleGraphNode = {
    id: sectionId,
    type: kind,
    name,
    x: midX,
    y: midY,
    z: 0,
    parentId: storeyId,
    properties: {
      cut_depth_mm: args.cutDepthMm ?? DEFAULT_CUT_DEPTH_MM,
      depth_mode: args.depthMode ?? 'limited',
      look_side: args.lookSide ?? 'left',
      clip_to_marker: true,
      cut_height_mm: cutHeight,
      start_elevation_mm: Math.min(0, bottom - 1000),
      show_in_plan: true,
      plan_cut: { ...cut },
      ...(kind === 'view' ? { view_direction: args.viewDirection ?? 'W' } : {}),
    },
  };

  return {
    nodes: [...nodes, newNode],
    edges,
    sectionId,
    kind,
  };
}
