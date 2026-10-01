/**
 * extras.ts — what the topology backend needs to know beyond the rooms.
 *
 * The kernel builds cells from rooms; it cannot see where a door is, which
 * wall a face lies on, or where a stair climbs. Those are computed here with
 * the same functions the IFC exporter uses — wall ends read at their grips,
 * openings placed by `collectOpenings` along the raw span, a stair's walking
 * line from its solver — so a door in the egress check stands exactly where
 * the 3D view and the exported IFC put it.
 *
 * All coordinates are absolute BIM millimetres (x east, y north, z up).
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import {
  collectOpenings, getConnectedNodesWithGrips, getGripBimPos, getNodeWallThickness,
} from '@/lib/bimGeometry';
import { computeStairGeometry } from '@/lib/stair';
import type { TopologyExtras, TopologyOpening, TopologyStair, TopologyWall } from './types';

function storeyBand(n: BubbleGraphNode, nodeMap: Map<string, BubbleGraphNode>): { bot: number; top: number } | null {
  const s = n.parentId ? nodeMap.get(n.parentId) : undefined;
  if (!s || s.type !== 'storey') return null;
  const bot = Number(s.properties.bottomElevation ?? 0);
  const top = Number(s.properties.topElevation ?? bot + 3000);
  return { bot, top };
}

export function topologyExtras(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  maxEgressM: number,
): TopologyExtras {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const walls: TopologyWall[] = [];
  const openings: TopologyOpening[] = [];
  const seen = new Map<string, number>();

  for (const n of nodes) {
    if (n.type !== 'wall') continue;
    const band = storeyBand(n, nodeMap);
    if (!band) continue;
    const ends = getConnectedNodesWithGrips(n.id, edges, nodeMap)
      .filter(({ node: c }) => c.type === 'ax' || c.type === 'column');
    if (ends.length < 2) continue;
    const a = getGripBimPos(ends[0].node, ends[0].gripIdx, nodeMap);
    const b = getGripBimPos(ends[1].node, ends[1].gripIdx, nodeMap);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) continue;
    // `getNodeWallThickness` answers in metres.
    const thicknessMm = getNodeWallThickness(n) * 1000;
    const heightMm = n.properties.height != null ? Number(n.properties.height) : band.top - band.bot;
    walls.push({ id: n.id, aMm: [a.x, a.y], bMm: [b.x, b.y], thicknessMm, zMinMm: band.bot, zMaxMm: band.bot + heightMm });

    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    for (const op of collectOpenings(n, len, edges, nodeMap)) {
      const along = Math.min(Math.max(op.distFromStart, 0), Math.max(0, len - op.width)) + op.width / 2;
      // A group of windows from one node shares its id; each needs its own.
      const base = op.node.id;
      const k = seen.get(base) ?? 0;
      seen.set(base, k + 1);
      openings.push({
        id: k === 0 ? base : `${base}#${k}`,
        kind: op.node.type === 'door' ? 'door' : 'window',
        name: op.node.name || op.node.type,
        wallId: n.id,
        centreMm: [a.x + ux * along, a.y + uy * along],
        widthMm: op.width,
        zMinMm: band.bot + op.sillHeight,
        zMaxMm: band.bot + op.sillHeight + op.height,
        thicknessMm,
      });
    }
  }

  const stairs: TopologyStair[] = [];
  for (const n of nodes) {
    if (n.type !== 'stairwell') continue;
    const { geometry } = computeStairGeometry(n, nodes, edges);
    const line = geometry?.baseline ?? [];
    if (!geometry || line.length < 2) continue;
    let lengthMm = 0;
    for (let i = 1; i < line.length; i++) {
      lengthMm += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y, line[i].z - line[i - 1].z);
    }
    const lo = line[0], hi = line[line.length - 1];
    stairs.push({
      id: n.id, name: n.name || 'Scară',
      bottomMm: [lo.x, lo.y, lo.z], topMm: [hi.x, hi.y, hi.z], lengthMm,
    });
  }

  return { walls, openings, stairs, maxEgressM };
}
