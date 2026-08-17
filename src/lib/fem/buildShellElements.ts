/**
 * buildShellElements.ts — wall & slab shell (3-node) elements for buildFemModel.ts.
 *
 * "Slab" here covers two distinct graph shapes, both producing the same
 * shell elements: a `room` node's floor slab (`has_slab`, default on — the
 * caller gates this) and a standalone `slab` node (always modelled — its
 * existence in the graph already means "there is a slab here").
 *
 * Both wall and slab use the exact same `anchorIndex` cache buildFemModel seeds with each
 * column's {base, top} FEM node pair:
 *   - A wall/slab corner that coincides with a column reuses that column's
 *     node — real shared-DOF frame action, and a slab corner snaps onto the
 *     column's TOP node exactly (ignoring the small mid-plane eccentricity a
 *     slab's half-thickness offset would otherwise introduce — deliberate:
 *     a true shared DOF is worth more here than that ~5–10cm of elevation).
 *   - A wall corner with no column gets a fresh, cached, fully-fixed base
 *     node instead (placeholder "resting on a foundation" support) so two
 *     walls sharing that corner still share the same FEM nodes.
 *   - A slab corner with no column and no wall having visited it gets a
 *     pinned node (translations fixed, rotations free — "simply supported
 *     edge") at the slab's true mid-plane elevation.
 *
 * Without ANY of these fallback supports, a wall or slab whose whole
 * perimeter has no column would leave its DOF block disconnected from every
 * restraint — the assembled stiffness matrix would be singular and the solve
 * would blow up (NaN/throw), not just be inaccurate. This keeps every panel
 * self-supporting so the model always solves; treat panels with no column
 * anchor as a rough sketch, not a real support condition.
 *
 * A room's slab additionally carries its usage-category imposed load (see
 * femLoads.ts) on top of self-weight — a standalone `slab` node has no
 * category and stays self-weight only.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  getNodeBimPos,
  getConnectedNodes,
  parseWallThickness,
  getNodeSlabThickness,
  calcRoomPolygon,
  MM,
} from '@/lib/bimGeometry';
import { shellElementProps, CONCRETE_DENSITY_KG_M3, GRAVITY_ACCEL } from './femSections';
import { getRoomLiveLoadNm2 } from './femLoads';
import type { FemAccumulators } from './buildFemModel';

type Support6 = [boolean, boolean, boolean, boolean, boolean, boolean];
const PIN_SUPPORT: Support6 = [true, true, true, false, false, false];

function triangleArea3(a: number[], b: number[], c: number[]): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return 0.5 * Math.hypot(cx, cy, cz);
}

/**
 * Lump self-weight (+ an optional uniform live load, N/m² — e.g. a room's
 * usage-category imposed load, see femLoads.ts) over a triangle onto its 3
 * corner nodes, area-weighted 1/3 each. `liveLoadNm2` is 0 for anything
 * that isn't a room's own floor slab (walls, standalone `slab` nodes).
 */
function addTriLoad(
  acc: FemAccumulators,
  idx: [number, number, number],
  pts: number[][],
  thickness: number,
  liveLoadNm2 = 0,
): void {
  const area = triangleArea3(pts[0], pts[1], pts[2]);
  const selfWeight = area * thickness * CONCRETE_DENSITY_KG_M3 * GRAVITY_ACCEL;
  const liveLoad = area * liveLoadNm2;
  const w = selfWeight + liveLoad;
  for (const i of idx) acc.addLoad(i, [0, 0, -w / 3, 0, 0, 0]);
}

/** Get (or lazily create + cache) the {base, top} FEM node pair for an anchor node id. */
function anchorPair(
  acc: FemAccumulators,
  anchorNodeId: string,
  anchorIndex: Map<string, { base: number; top: number }>,
  x: number, y: number, baseZ: number, topZ: number,
): { base: number; top: number } {
  const cached = anchorIndex.get(anchorNodeId);
  if (cached) return cached;

  const base = acc.pushNode([x, y, baseZ]);
  acc.fixNode(base); // placeholder foundation — see file header
  const top = acc.pushNode([x, y, topZ]);
  const pair = { base, top };
  anchorIndex.set(anchorNodeId, pair);
  return pair;
}

/**
 * Add a wall as a flat vertical shell panel spanning the full storey height
 * (base → top), between its two `ax`/`column` endpoints. Ring-beam masonry-
 * height reduction and wall joins are not modelled — the panel runs the full
 * storey height on the plain centreline, same simplification level as the
 * column members it connects to.
 */
export function addWallShell(
  acc: FemAccumulators,
  wallNode: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  anchorIndex: Map<string, { base: number; top: number }>,
  baseZ: number,
  topZ: number,
): void {
  const ends = getConnectedNodes(wallNode.id, edges, nodeMap).filter((n) => n.type === 'ax' || n.type === 'column');
  if (ends.length < 2) return;
  const [eA, eB] = ends;

  const posA = getNodeBimPos(eA, nodeMap);
  const posB = getNodeBimPos(eB, nodeMap);
  const a = anchorPair(acc, eA.id, anchorIndex, posA.x * MM, posA.y * MM, baseZ, topZ);
  const b = anchorPair(acc, eB.id, anchorIndex, posB.x * MM, posB.y * MM, baseZ, topZ);

  const thickness = parseWallThickness(String(wallNode.properties.wall_type ?? 'W20'));
  const props = shellElementProps(thickness);

  const corners = [a.base, b.base, b.top, a.top];
  const pts = corners.map((i) => acc.nodes[i]);
  const tris: [number, number, number][] = [[0, 1, 2], [0, 2, 3]];

  for (const tri of tris) {
    const idx: [number, number, number] = [corners[tri[0]], corners[tri[1]], corners[tri[2]]];
    const elIdx = acc.pushElement(...idx);
    acc.elementsProps.set(elIdx, props);
    acc.elementMeta.push({ sourceNodeId: wallNode.id, kind: 'wall' });
    addTriLoad(acc, idx, [pts[tri[0]], pts[tri[1]], pts[tri[2]]], thickness);
  }
}

/**
 * Add a slab shell panel triangulated (simple fan — convex/near-convex
 * footprints only) at the storey's top elevation, from either:
 *   - a `room` node (floor slab, its perimeter from `calcRoomPolygon` —
 *     direct ax/column anchors, or the legacy wall-adjacency walk as a
 *     fallback), or
 *   - a standalone `slab` node (perimeter from direct ax/column anchors only
 *     — same rule `calcShellPolygon` uses for it elsewhere in the app; there
 *     is no wall-adjacency fallback for these).
 * Perimeter corners reuse their column's/wall's cached node where one exists.
 */
export function addSlabShell(
  acc: FemAccumulators,
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  anchorIndex: Map<string, { base: number; top: number }>,
  topZ: number,
): void {
  const thickness = getNodeSlabThickness(node);
  const zMid = topZ - thickness / 2;

  const slabCorner = (anchorNodeId: string | undefined, x: number, y: number): number => {
    if (anchorNodeId) {
      const cached = anchorIndex.get(anchorNodeId);
      if (cached) return cached.top; // snaps to the column/wall top — see file header
    }
    const idx = acc.pushNode([x, y, zMid]);
    acc.supports.set(idx, PIN_SUPPORT);
    return idx;
  };

  // Prefer direct ax/column anchors (keeps node identity for shared-DOF reuse).
  const directAnchors = getConnectedNodes(node.id, edges, nodeMap).filter((n) => n.type === 'ax' || n.type === 'column');

  let cornerIdx: number[];
  if (directAnchors.length >= 3) {
    const pts = directAnchors.map((n) => getNodeBimPos(n, nodeMap));
    let area2 = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      area2 += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    const anchors = area2 < 0 ? [...directAnchors].reverse() : directAnchors;
    cornerIdx = anchors.map((n) => {
      const p = getNodeBimPos(n, nodeMap);
      return slabCorner(n.id, p.x * MM, p.y * MM);
    });
  } else if (node.type === 'room') {
    // Standalone `slab` nodes have no equivalent legacy fallback — calcShellPolygon
    // (the function the rest of the app uses for them) requires ≥3 direct anchors too.
    const poly = calcRoomPolygon(node, nodeMap, edges);
    if (!poly || poly.length < 3) return;
    cornerIdx = poly.map((p) => slabCorner(undefined, p.x * MM, p.y * MM));
  } else {
    return;
  }

  const cornerPts = cornerIdx.map((i) => acc.nodes[i]);
  const props = shellElementProps(thickness);
  // Live load only applies to a room's own floor — a standalone `slab` node
  // (e.g. an unattached balcony) has no usage category, self-weight only.
  const liveLoadNm2 = node.type === 'room' ? getRoomLiveLoadNm2(node.properties.room_load_category) : 0;

  for (let i = 1; i < cornerIdx.length - 1; i++) {
    const idx: [number, number, number] = [cornerIdx[0], cornerIdx[i], cornerIdx[i + 1]];
    const elIdx = acc.pushElement(...idx);
    acc.elementsProps.set(elIdx, props);
    acc.elementMeta.push({ sourceNodeId: node.id, kind: 'slab' });
    addTriLoad(acc, idx, [cornerPts[0], cornerPts[i], cornerPts[i + 1]], thickness, liveLoadNm2);
  }
}
