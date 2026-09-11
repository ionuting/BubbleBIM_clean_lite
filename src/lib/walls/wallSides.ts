/**
 * wallSides.ts — which walls are on the outside of the building.
 *
 * "Exterior" here is exactly the ring the roof sits on: the wall network is
 * walked with the same `contourFromStoreyWalls` the roof solver uses, so the
 * takeoff, the scenarios and the system profiles never disagree with the
 * roof about what the outline is.
 *
 * A wall is exterior when its two anchors are consecutive on the ring. Every
 * other wall with two anchors is interior. Walls that cannot be placed
 * (unanchored, storey with no closed ring) are left out of BOTH sets, so a
 * side-filtered rule simply does not touch them.
 *
 * Pure: no store, no React.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { getConnectedNodes } from '@/lib/bimGeometry';
import { contourFromStoreyWalls } from '@/lib/roof/contour';

export type WallSide = 'exterior' | 'interior';

export function classifyWallSides(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]): Map<string, WallSide> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, WallSide>();
  const ringByStorey = new Map<string, Set<string>>();

  for (const st of nodes) {
    if (st.type !== 'storey') continue;
    const ring = contourFromStoreyWalls(st.id, nodes, edges);
    const pairs = new Set<string>();
    if (ring && ring.axIds.length >= 3) {
      const ids = ring.axIds;
      for (let i = 0; i < ids.length; i++) {
        const a = ids[i], b = ids[(i + 1) % ids.length];
        pairs.add(a < b ? `${a}|${b}` : `${b}|${a}`);
      }
    }
    ringByStorey.set(st.id, pairs);
  }

  for (const w of nodes) {
    if (w.type !== 'wall') continue;
    const ends = getConnectedNodes(w.id, edges, nodeMap).filter((c) => c.type === 'ax' || c.type === 'column');
    if (ends.length < 2) continue;
    const storeyId = w.parentId ?? ends[0].parentId ?? null;
    if (!storeyId) continue;
    const pairs = ringByStorey.get(storeyId);
    if (!pairs || pairs.size === 0) continue;
    const a = ends[0].id, b = ends[1].id;
    out.set(w.id, pairs.has(a < b ? `${a}|${b}` : `${b}|${a}`) ? 'exterior' : 'interior');
  }
  return out;
}

/** Ax ids on each storey's exterior ring, in ring order. */
export function ringAxIdsByStorey(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const st of nodes) {
    if (st.type !== 'storey') continue;
    const ring = contourFromStoreyWalls(st.id, nodes, edges);
    out.set(st.id, ring && ring.axIds.length >= 3 ? ring.axIds : []);
  }
  return out;
}

const sidesCache = new WeakMap<Map<string, BubbleGraphNode>, Map<string, WallSide>>();

/**
 * The same classification, cached on the node map object. A takeoff builds
 * one map and measures every wall against it, so the ring walk runs once per
 * takeoff rather than once per wall.
 */
export function wallSidesCached(
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): Map<string, WallSide> {
  let hit = sidesCache.get(nodeMap);
  if (!hit) {
    hit = classifyWallSides([...nodeMap.values()], edges);
    sidesCache.set(nodeMap, hit);
  }
  return hit;
}
