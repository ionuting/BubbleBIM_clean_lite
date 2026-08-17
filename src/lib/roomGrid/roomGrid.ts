/**
 * roomGrid.ts — auto-fill a storey's ax grid with walls + rooms, and join
 * adjacent rooms back into one.
 *
 * Model (matches the editor):
 *   • ax nodes carry gridX / gridY (column / row) and live under a storey.
 *   • a wall is a node linked by edges to its two endpoint ax.
 *   • a room is a node linked by edges to its corner ax, in boundary order
 *     (calcRoomPolygon Pattern A trusts the edge-connection order).
 *
 * Rooms remember the grid CELLS they cover in `properties.cells` (array of
 * [gx, gy] bottom-left corners). That lets `planJoinRooms` union two rooms into
 * an arbitrary rectilinear outline (L/T/…) and re-trace the boundary exactly,
 * while dropping the wall that sat between them.
 *
 * Pure & framework-free → unit-tested.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';

export type Cell = [number, number]; // grid coords of a cell's bottom-left corner
export type Vert = [number, number]; // grid coords of a boundary vertex

const gridKey = (gx: number, gy: number) => `${gx}_${gy}`;

/** Map (gridX,gridY) → ax node, for the ax nodes of one storey. */
export function axByGrid(axNodes: BubbleGraphNode[]): Map<string, BubbleGraphNode> {
  const m = new Map<string, BubbleGraphNode>();
  for (const n of axNodes) {
    if (n.type !== 'ax') continue;
    m.set(gridKey(Number(n.properties.gridX), Number(n.properties.gridY)), n);
  }
  return m;
}

function connectedOfType(
  nodeId: string, edges: BubbleGraphEdge[], byId: Map<string, BubbleGraphNode>, type: string,
): BubbleGraphNode[] {
  const out: BubbleGraphNode[] = [];
  for (const e of edges) {
    if (e.from !== nodeId && e.to !== nodeId) continue;
    const other = byId.get(e.from === nodeId ? e.to : e.from);
    if (other && other.type === type) out.push(other);
  }
  return out;
}

/** The grid cells a room covers — from stored metadata, else derived from the ax bbox. */
export function cellsOfRoom(
  room: BubbleGraphNode, edges: BubbleGraphEdge[], byId: Map<string, BubbleGraphNode>,
): Cell[] {
  const stored = room.properties.cells;
  if (Array.isArray(stored) && stored.length) {
    return (stored as unknown[])
      .filter((c): c is [number, number] => Array.isArray(c) && c.length === 2)
      .map(([a, b]) => [Number(a), Number(b)] as Cell);
  }
  // Fallback: assume a rectangle spanning the connected ax's grid bbox.
  const ax = connectedOfType(room.id, edges, byId, 'ax');
  if (ax.length < 3) return [];
  const gxs = ax.map((n) => Number(n.properties.gridX));
  const gys = ax.map((n) => Number(n.properties.gridY));
  const minGX = Math.min(...gxs), maxGX = Math.max(...gxs);
  const minGY = Math.min(...gys), maxGY = Math.max(...gys);
  const cells: Cell[] = [];
  for (let gx = minGX; gx < maxGX; gx++)
    for (let gy = minGY; gy < maxGY; gy++) cells.push([gx, gy]);
  return cells;
}

/**
 * Trace the outline of a set of unit grid cells as an ordered CCW ring of
 * boundary vertices (corners only; collinear points removed). Assumes the cells
 * form a single connected region (guaranteed by the shared-edge check on join).
 */
export function traceCellBoundary(cells: Cell[]): Vert[] {
  const cellSet = new Set(cells.map(([gx, gy]) => gridKey(gx, gy)));
  // Emit each cell's 4 CCW-directed boundary edges; interior edges appear twice
  // with opposite direction and cancel.
  const edgeKey = (a: Vert, b: Vert) => `${a[0]},${a[1]}->${b[0]},${b[1]}`;
  const dirEdges = new Map<string, [Vert, Vert]>();
  const add = (a: Vert, b: Vert) => {
    const rev = edgeKey(b, a);
    if (dirEdges.has(rev)) { dirEdges.delete(rev); return; } // shared interior edge cancels
    dirEdges.set(edgeKey(a, b), [a, b]);
  };
  for (const [gx, gy] of cells) {
    add([gx, gy], [gx + 1, gy]);         // bottom
    add([gx + 1, gy], [gx + 1, gy + 1]); // right
    add([gx + 1, gy + 1], [gx, gy + 1]); // top
    add([gx, gy + 1], [gx, gy]);         // left
  }
  if (dirEdges.size === 0) return [];

  // Chain directed edges into a loop (each vertex has one outgoing boundary edge).
  const nextFrom = new Map<string, Vert>();
  for (const [a, b] of dirEdges.values()) nextFrom.set(gridKey(a[0], a[1]), b);

  const startEdge = [...dirEdges.values()][0];
  const start = startEdge[0];
  const ring: Vert[] = [start];
  let cur = startEdge[1];
  let guard = 0;
  while (!(cur[0] === start[0] && cur[1] === start[1]) && guard++ < dirEdges.size + 2) {
    ring.push(cur);
    const nxt = nextFrom.get(gridKey(cur[0], cur[1]));
    if (!nxt) break;
    cur = nxt;
  }

  // Drop collinear vertices — keep only real corners.
  const corners: Vert[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cross !== 0) corners.push(b);
  }
  void cellSet;
  return corners;
}

let counter = 0;
const fallbackId = (t: string) => `${t}_g${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface GridFill { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[]; }

/**
 * Fill a storey's ax grid with a wall between every pair of adjacent ax and a
 * room in every cell (wired to its 4 corners). Idempotent: skips walls/cells
 * that already exist. Returns only the NEW nodes + edges to add.
 */
export function generateRoomGrid(
  storeyId: string,
  axNodes: BubbleGraphNode[],
  existingNodes: BubbleGraphNode[],
  existingEdges: BubbleGraphEdge[],
  makeId: (type: string) => string = fallbackId,
): GridFill {
  const grid = axByGrid(axNodes);
  if (grid.size < 4) return { nodes: [], edges: [] };
  const byId = new Map(existingNodes.map((n) => [n.id, n]));

  let nx = 0, ny = 0;
  for (const n of axNodes) {
    if (n.type !== 'ax') continue;
    nx = Math.max(nx, Number(n.properties.gridX) + 1);
    ny = Math.max(ny, Number(n.properties.gridY) + 1);
  }

  // Existing wall ax-pairs (dedupe) and existing covered cells (dedupe).
  const wallPairs = new Set<string>();
  for (const n of existingNodes) {
    if (n.type !== 'wall') continue;
    const ax = connectedOfType(n.id, existingEdges, byId, 'ax');
    if (ax.length >= 2) {
      const [a, b] = [ax[0].id, ax[1].id].sort();
      wallPairs.add(`${a}|${b}`);
    }
  }
  const coveredCells = new Set<string>();
  for (const n of existingNodes) {
    if (n.type !== 'room') continue;
    for (const [gx, gy] of cellsOfRoom(n, existingEdges, byId)) coveredCells.add(gridKey(gx, gy));
  }

  const nodes: BubbleGraphNode[] = [];
  const edges: BubbleGraphEdge[] = [];

  const addWall = (a: BubbleGraphNode, b: BubbleGraphNode) => {
    const key = [a.id, b.id].sort().join('|');
    if (wallPairs.has(key)) return;
    wallPairs.add(key);
    const id = makeId('wall');
    nodes.push({
      id, type: 'wall', name: 'Wall',
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0,
      parentId: storeyId,
      properties: {
        wall_type: 'W20',
        // Ring beam (centură) on top of the masonry — renders in 3D and the
        // wall auto-shrinks by the beam height so the two fill the storey.
        has_beam: 'True', beam_section: 'B20x30',
        grid_generated: true, source_storey: storeyId,
      },
    });
    edges.push(
      { id: makeId('edge'), from: id, to: a.id },
      { id: makeId('edge'), from: id, to: b.id },
    );
  };

  // Walls: horizontal (adjacent columns) + vertical (adjacent rows).
  for (let gy = 0; gy < ny; gy++)
    for (let gx = 0; gx < nx - 1; gx++) {
      const a = grid.get(gridKey(gx, gy)), b = grid.get(gridKey(gx + 1, gy));
      if (a && b) addWall(a, b);
    }
  for (let gx = 0; gx < nx; gx++)
    for (let gy = 0; gy < ny - 1; gy++) {
      const a = grid.get(gridKey(gx, gy)), b = grid.get(gridKey(gx, gy + 1));
      if (a && b) addWall(a, b);
    }

  // Rooms: one per cell, wired to its 4 corners in CCW boundary order.
  for (let gx = 0; gx < nx - 1; gx++)
    for (let gy = 0; gy < ny - 1; gy++) {
      if (coveredCells.has(gridKey(gx, gy))) continue;
      const corners = [
        grid.get(gridKey(gx, gy)), grid.get(gridKey(gx + 1, gy)),
        grid.get(gridKey(gx + 1, gy + 1)), grid.get(gridKey(gx, gy + 1)),
      ];
      if (corners.some((c) => !c)) continue;
      const cs = corners as BubbleGraphNode[];
      const id = makeId('room');
      const rx = cs.reduce((s, c) => s + c.x, 0) / 4;
      const ry = cs.reduce((s, c) => s + c.y, 0) / 4;
      nodes.push({
        id, type: 'room', name: `Room ${gx + 1}·${gy + 1}`,
        x: rx, y: ry, z: 0,
        parentId: storeyId,
        properties: { cells: [[gx, gy]], grid_generated: true, source_storey: storeyId },
      });
      for (const c of cs) edges.push({ id: makeId('edge'), from: id, to: c.id });
    }

  return { nodes, edges };
}

export interface JoinPlan {
  /** Room kept (A) — its cells + centroid update. */
  keepRoomId: string;
  cells: Cell[];
  center: { x: number; y: number };
  /** ax ids, in boundary order, the kept room should now connect to. */
  boundaryAxIds: string[];
  /** Node ids to delete (room B + interior walls). */
  removeNodeIds: string[];
}

/**
 * Merge two edge-adjacent rooms into one: union their cells, re-trace the
 * outline, and drop the wall(s) that sat on the shared edge. Returns null when
 * the rooms do not share an edge (need ≥2 shared corner ax) or the outline can't
 * be resolved.
 */
export function planJoinRooms(
  roomA: BubbleGraphNode,
  roomB: BubbleGraphNode,
  axNodes: BubbleGraphNode[],
  allNodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): JoinPlan | null {
  if (roomA.type !== 'room' || roomB.type !== 'room' || roomA.id === roomB.id) return null;
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const grid = axByGrid(axNodes);

  const axA = connectedOfType(roomA.id, edges, byId, 'ax');
  const axB = connectedOfType(roomB.id, edges, byId, 'ax');
  const idsB = new Set(axB.map((n) => n.id));
  const shared = new Set(axA.filter((n) => idsB.has(n.id)).map((n) => n.id));
  if (shared.size < 2) return null; // not edge-adjacent

  const cells = [...cellsOfRoom(roomA, edges, byId), ...cellsOfRoom(roomB, edges, byId)];
  const dedup = new Map<string, Cell>();
  for (const [gx, gy] of cells) dedup.set(gridKey(gx, gy), [gx, gy]);
  const merged = [...dedup.values()];
  if (!merged.length) return null;

  const boundary = traceCellBoundary(merged);
  if (boundary.length < 3) return null;

  const boundaryAxIds: string[] = [];
  for (const [gx, gy] of boundary) {
    const ax = grid.get(gridKey(gx, gy));
    if (!ax) return null; // boundary vertex has no ax — bail rather than corrupt
    boundaryAxIds.push(ax.id);
  }

  // Interior walls to remove: those whose BOTH endpoints are shared ax.
  const removeNodeIds: string[] = [roomB.id];
  for (const n of allNodes) {
    if (n.type !== 'wall') continue;
    const wax = connectedOfType(n.id, edges, byId, 'ax');
    if (wax.length >= 2 && wax.every((a) => shared.has(a.id))) removeNodeIds.push(n.id);
  }

  // Centroid of the merged room's corner ax (canvas coords).
  let cx = 0, cy = 0;
  for (const id of boundaryAxIds) { const a = byId.get(id)!; cx += a.x; cy += a.y; }
  cx /= boundaryAxIds.length; cy /= boundaryAxIds.length;

  return { keepRoomId: roomA.id, cells: merged, center: { x: cx, y: cy }, boundaryAxIds, removeNodeIds };
}
