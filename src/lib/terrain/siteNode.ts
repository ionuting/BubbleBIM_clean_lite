/**
 * siteNode.ts — a new project ground ("Teren"), ready to show.
 *
 * A site needs an anchor ax (the centre of its grid) and a storey (whose floor
 * its level is measured from). Picked here so that "add terrain" gives a ground
 * straight away: on the storey at ±0.00 (the lowest one at or above it), on the
 * ax nearest the middle of that storey's axes, at the usual −0.45 m below the
 * finished floor.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { planPos } from '@/lib/geom/plan2d';

export const DEFAULT_GROUND_LEVEL_MM = -450;

export function createSiteNode(
  nodes: BubbleGraphNode[],
  defaults: Record<string, unknown> = {},
): { node: BubbleGraphNode; edge: BubbleGraphEdge | null } | null {
  const storeys = nodes.filter((n) => n.type === 'storey');
  if (!storeys.length) return null;
  const bot = (s: BubbleGraphNode) => Number(s.properties.bottomElevation ?? 0);
  const above = storeys.filter((s) => bot(s) >= -100).sort((a, b) => bot(a) - bot(b));
  const storey = above[0] ?? [...storeys].sort((a, b) => Math.abs(bot(a)) - Math.abs(bot(b)))[0];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const axes = nodes.filter((n) => n.type === 'ax' && n.parentId === storey.id);
  let anchor: BubbleGraphNode | null = null;
  if (axes.length) {
    const pts = axes.map((a) => ({ a, p: planPos(a, nodeMap) }));
    const cx = pts.reduce((s, q) => s + q.p.x, 0) / pts.length;
    const cy = pts.reduce((s, q) => s + q.p.y, 0) / pts.length;
    anchor = pts.sort((u, v) => Math.hypot(u.p.x - cx, u.p.y - cy) - Math.hypot(v.p.x - cx, v.p.y - cy))[0].a;
  }
  const stamp = Date.now().toString(36);
  const node: BubbleGraphNode = {
    id: `node_site_${stamp}`, type: 'site', name: 'Teren',
    x: anchor ? anchor.x : storey.x, y: anchor ? anchor.y + 120 : storey.y + 120, z: 0,
    parentId: storey.id,
    properties: { ...defaults, offset_z_mm: DEFAULT_GROUND_LEVEL_MM, show_in_3d: 'True' },
  };
  const edge: BubbleGraphEdge | null = anchor ? { id: `edge_site_${stamp}`, from: node.id, to: anchor.id } : null;
  return { node, edge };
}
