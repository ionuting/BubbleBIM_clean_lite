/**
 * defaultProject.ts — the storeys a fresh project starts with.
 *
 * Infrastructure (−1800…0), First floor (0…2800), Second floor (2800…5600),
 * plus a "Last floor" (role: 'last') that always floats on top of the highest
 * regular storey (see lib/storeys/lastFloor + the panel effect that maintains
 * it). Each storey gets its own ax grid so the project is immediately workable.
 *
 * Self-contained (no editor internals) so both the in-editor "New" action and
 * the welcome-screen "New project" button can seed the same defaults.
 */
import type { BubbleGraphNode } from '@/store';

export const DEFAULT_PROJECT_AXES = { xValues: [0, 5000, 10000], yValues: [0, 5000, 10000] };
export const LAST_FLOOR_HEIGHT_MM = 2800;

let ctr = 0;
const uid = () => `${Date.now().toString(36)}${(ctr++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Build a storey node plus its ax grid (gridX/gridY = stable identity). */
export function buildStoreyNodes(
  name: string, bottomElev: number, topElev: number,
  xs: number[], ys: number[], index: number,
  extraProps: Record<string, unknown> = {},
): BubbleGraphNode[] {
  const maxX = xs[xs.length - 1] ?? 0;
  const maxY = ys[ys.length - 1] ?? 0;
  const cx = 8000 + index * 500;
  const cy = 6000;
  const storeyId = `storey_${uid()}`;
  const out: BubbleGraphNode[] = [{
    id: storeyId, type: 'storey', name, x: cx, y: cy, z: 0,
    properties: {
      bottomElevation: bottomElev, topElevation: topElev,
      axesX: xs, axesY: ys, width: maxX, height: maxY,
      discipline: 'architectural', ...extraProps,
    },
    locked: true,
  }];
  for (let i = 0; i < ys.length; i++) {
    for (let j = 0; j < xs.length; j++) {
      out.push({
        id: `ax_${storeyId}_${j}_${i}`, type: 'ax',
        name: `${j + 1}-${String.fromCharCode(65 + i)}`,
        x: cx + (xs[j] - maxX / 2), y: cy + (ys[i] - maxY / 2), z: 0,
        properties: { gridX: j, gridY: i, axNodeIndex: i * xs.length + j },
        locked: true, parentId: storeyId,
      });
    }
  }
  return out;
}

/** All nodes for a fresh project + the id of the storey to open first. */
export function buildDefaultProjectNodes(): { nodes: BubbleGraphNode[]; activeStoreyId: string } {
  const { xValues: xs, yValues: ys } = DEFAULT_PROJECT_AXES;
  const nodes: BubbleGraphNode[] = [
    ...buildStoreyNodes('Infrastructure', -1800, 0, xs, ys, 0),
    ...buildStoreyNodes('First floor', 0, 2800, xs, ys, 1),
    ...buildStoreyNodes('Second floor', 2800, 5600, xs, ys, 2),
    ...buildStoreyNodes('Last floor', 5600, 5600 + LAST_FLOOR_HEIGHT_MM, xs, ys, 3, { role: 'last' }),
  ];
  const first = nodes.find((n) => n.type === 'storey' && n.name === 'First floor');
  return { nodes, activeStoreyId: first?.id ?? '' };
}
