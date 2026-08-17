/**
 * sectionFromPlan — create section / elevation markers from floor-plan authoring.
 *
 * Engine constraint (current):
 *   - type `section` → vertical cut at constant BIM Y (cut line ≈ parallel to X)
 *   - type `view`    → elevation cut at constant BIM X (cut line ≈ parallel to Y)
 *
 * Endpoints are stored on the node as `plan_cut` so markers work without ax anchors.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';

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

/** Ortho-constrain a freehand cut to the dominant axis. */
export function orthoConstrainCut(p1: { x: number; y: number }, p2: { x: number; y: number }): {
  cut: PlanCut;
  kind: 'section' | 'view';
  viewDirection?: 'N' | 'S' | 'E' | 'W';
} {
  const dx = Math.abs(p2.x - p1.x);
  const dy = Math.abs(p2.y - p1.y);
  if (dx >= dy) {
    // Horizontal cut line → section at constant Y
    const y = (p1.y + p2.y) / 2;
    return {
      kind: 'section',
      cut: { x1: p1.x, y1: y, x2: p2.x, y2: y },
    };
  }
  // Vertical cut line → elevation at constant X (camera from west by default)
  const x = (p1.x + p2.x) / 2;
  return {
    kind: 'view',
    viewDirection: 'W',
    cut: { x1: x, y1: p1.y, x2: x, y2: p2.y },
  };
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

export function cutFromAxisLine(
  dir: 'X' | 'Y',
  value: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  padMm = 500,
): { cut: PlanCut; kind: 'section' | 'view'; viewDirection?: 'N' | 'S' | 'E' | 'W' } {
  if (dir === 'Y') {
    // Horizontal grid line at Y=value → section
    return {
      kind: 'section',
      cut: {
        x1: bounds.minX - padMm,
        y1: value,
        x2: bounds.maxX + padMm,
        y2: value,
      },
    };
  }
  // Vertical grid line at X=value → elevation (from west)
  return {
    kind: 'view',
    viewDirection: 'W',
    cut: {
      x1: value,
      y1: bounds.minY - padMm,
      x2: value,
      y2: bounds.maxY + padMm,
    },
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
  flipped?: boolean;
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
      cut_depth_mm: args.cutDepthMm ?? 6000,
      cut_height_mm: cutHeight,
      start_elevation_mm: Math.min(0, bottom - 1000),
      cut_plane_offset_mm: 0,
      offset_left_mm: 0,
      offset_right_mm: 0,
      flipped: args.flipped ?? false,
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
