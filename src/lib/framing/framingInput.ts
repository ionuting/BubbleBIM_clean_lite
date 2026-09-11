/**
 * framingInput.ts — ONE way to turn a wall node into the input of the derived
 * timber framing / CLT panelisation, shared by the takeoff (counts) and the
 * 3D mapper (draws). Both used to assemble it by hand; a stud the viewer
 * showed and the deviz did not count was only ever a matter of time.
 *
 * What is added here beyond length / height / openings:
 *
 * - JUNCTIONS at the wall's two ends, read from the wall network: another
 *   wall meeting the end anchor at an angle makes a corner; two or more make
 *   a tee/cross. A wall continuing straight on is neither.
 * - The user's tuning: `stud_spacing_mm`, `stud_section`, `clt_max_panel_mm`.
 *
 * Pure: no scene, no store.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { getConnectedNodesWithGrips, getNodeBimPos } from '@/lib/bimGeometry';
import {
  parseFramingSection, sectionForThickness,
  type FramingInput, type FramingJunction, type FramingOpening,
} from './wallFraming';
import type { CltPanelInput } from './cltPanels';

export interface WallFramingGeometry {
  lengthMm: number;
  heightMm: number;
  thicknessMm: number;
  openings: FramingOpening[];
}

const isAnchor = (n: BubbleGraphNode) => n.type === 'ax' || n.type === 'column';

/** The two anchors of a wall in the order `calcWallGeometry` walks them (start, end). */
export function wallAnchors(
  wall: BubbleGraphNode,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): [BubbleGraphNode, BubbleGraphNode] | null {
  const ends = getConnectedNodesWithGrips(wall.id, edges, nodeMap)
    .map((e) => e.node)
    .filter((n) => n.type !== 'window' && n.type !== 'door');
  if (ends.length < 2) return null;
  return [ends[0], ends[1]];
}

/**
 * Corners and tees at the two ends of a wall. Collinear continuations are
 * ignored: a wall split in two by an intermediate axis is still one straight
 * run, not a corner.
 */
export function wallJunctions(
  wall: BubbleGraphNode,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
  lengthMm: number,
): FramingJunction[] {
  const anchors = wallAnchors(wall, edges, nodeMap);
  if (!anchors) return [];
  const [a, b] = anchors;
  const pa = getNodeBimPos(a, nodeMap), pb = getNodeBimPos(b, nodeMap);
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  if (len < 1) return [];
  const d = { x: (pb.x - pa.x) / len, y: (pb.y - pa.y) / len };

  const out: FramingJunction[] = [];
  for (const [end, xMm] of [[a, 0], [b, lengthMm]] as const) {
    if (!isAnchor(end)) continue;
    let angled = 0;
    let others = 0;
    for (const e of edges) {
      const otherId = e.from === end.id ? e.to : e.to === end.id ? e.from : null;
      if (!otherId || otherId === wall.id) continue;
      const other = nodeMap.get(otherId);
      if (!other || other.type !== 'wall') continue;
      if ((other.parentId ?? null) !== (wall.parentId ?? null)) continue;
      const oa = wallAnchors(other, edges, nodeMap);
      if (!oa) continue;
      const far = oa[0].id === end.id ? oa[1] : oa[0];
      const pe = getNodeBimPos(end, nodeMap), pf = getNodeBimPos(far, nodeMap);
      const l2 = Math.hypot(pf.x - pe.x, pf.y - pe.y);
      if (l2 < 1) continue;
      const v = { x: (pf.x - pe.x) / l2, y: (pf.y - pe.y) / l2 };
      others++;
      if (Math.abs(d.x * v.y - d.y * v.x) < 0.05) continue;     // straight continuation
      angled++;
    }
    // Nothing at an angle: a free end or a straight run. One other wall, at an
    // angle: a corner. More than one other wall (a continuation plus a
    // partition, or two partitions): a tee/cross — backing studs, not a corner.
    if (angled === 0) continue;
    out.push({ xMm, kind: others === 1 ? 'corner' : 'tee' });
  }
  return out;
}

/** Framing input for a wall: geometry + junctions + the wall's own tuning. */
export function framingInputForWall(
  wall: BubbleGraphNode,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
  g: WallFramingGeometry,
): FramingInput {
  const spacing = Number(wall.properties.stud_spacing_mm);
  return {
    lengthMm: g.lengthMm,
    heightMm: g.heightMm,
    openings: g.openings,
    spacingMm: spacing > 0 ? spacing : undefined,
    section: parseFramingSection(wall.properties.stud_section as string | undefined, sectionForThickness(g.thicknessMm)),
    junctions: wallJunctions(wall, edges, nodeMap, g.lengthMm),
  };
}

/** CLT panelisation input for a wall. */
export function cltInputForWall(wall: BubbleGraphNode, g: WallFramingGeometry): CltPanelInput {
  const maxLen = Number(wall.properties.clt_max_panel_mm);
  return {
    lengthMm: g.lengthMm,
    heightMm: g.heightMm,
    thicknessMm: g.thicknessMm,
    openings: g.openings,
    maxPanelLengthMm: maxLen > 0 ? maxLen : undefined,
  };
}
