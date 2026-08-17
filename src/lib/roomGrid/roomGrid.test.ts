import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { generateRoomGrid, traceCellBoundary, planJoinRooms, cellsOfRoom, type Cell } from './roomGrid';

/** Build ax nodes for an nx×ny grid at 1000mm spacing. */
function axGrid(nx: number, ny: number): BubbleGraphNode[] {
  const out: BubbleGraphNode[] = [];
  for (let gy = 0; gy < ny; gy++)
    for (let gx = 0; gx < nx; gx++)
      out.push({
        id: `ax_${gx}_${gy}`, type: 'ax', name: `${gx}-${gy}`,
        x: gx * 1000, y: gy * 1000, z: 0,
        parentId: 'st', properties: { gridX: gx, gridY: gy },
      });
  return out;
}

let seq = 0;
const mk = (t: string) => `${t}_${seq++}`;

describe('traceCellBoundary', () => {
  it('single cell → 4 corners', () => {
    expect(traceCellBoundary([[0, 0]])).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });

  it('two horizontal cells → 2×1 rectangle (4 corners)', () => {
    const b = traceCellBoundary([[0, 0], [1, 0]]);
    expect(b).toHaveLength(4);
    const xs = b.map((v) => v[0]), ys = b.map((v) => v[1]);
    expect(Math.max(...xs)).toBe(2);
    expect(Math.max(...ys)).toBe(1);
  });

  it('L-shape (3 cells) → 6 corners', () => {
    const b = traceCellBoundary([[0, 0], [1, 0], [0, 1]]);
    expect(b).toHaveLength(6);
  });
});

describe('generateRoomGrid', () => {
  it('3×2 ax grid → 2 rooms, 7 walls, correctly wired', () => {
    seq = 0;
    const ax = axGrid(3, 2);
    const { nodes, edges } = generateRoomGrid('st', ax, ax, [], mk);
    const rooms = nodes.filter((n) => n.type === 'room');
    const walls = nodes.filter((n) => n.type === 'wall');
    expect(rooms).toHaveLength(2);
    expect(walls).toHaveLength(7); // 4 horizontal + 3 vertical
    // Each room wired to exactly 4 ax.
    for (const r of rooms) {
      const rax = edges.filter((e) => e.from === r.id).map((e) => e.to);
      expect(rax).toHaveLength(4);
      expect(rax.every((id) => id.startsWith('ax_'))).toBe(true);
    }
    // Each wall wired to exactly 2 ax.
    for (const w of walls) {
      const wax = edges.filter((e) => e.from === w.id);
      expect(wax).toHaveLength(2);
    }
    // Rooms carry their cell.
    expect(rooms.map((r) => (r.properties.cells as Cell[])[0])).toEqual(
      expect.arrayContaining([[0, 0], [1, 0]]),
    );
  });

  it('is idempotent — re-running adds nothing', () => {
    seq = 0;
    const ax = axGrid(3, 3);
    const first = generateRoomGrid('st', ax, ax, [], mk);
    const all = [...ax, ...first.nodes];
    const again = generateRoomGrid('st', ax, all, first.edges, mk);
    expect(again.nodes).toHaveLength(0);
    expect(again.edges).toHaveLength(0);
  });
});

describe('planJoinRooms', () => {
  function build(nx: number, ny: number) {
    seq = 0;
    const ax = axGrid(nx, ny);
    const { nodes, edges } = generateRoomGrid('st', ax, ax, [], mk);
    return { ax, nodes, edges, all: [...ax, ...nodes] };
  }

  it('merges two adjacent rooms, drops the shared wall', () => {
    const { ax, nodes, edges, all } = build(3, 2);
    const rooms = nodes.filter((n) => n.type === 'room');
    const [rA, rB] = rooms;
    const plan = planJoinRooms(rA, rB, ax, all, edges)!;
    expect(plan).not.toBeNull();
    expect(plan.keepRoomId).toBe(rA.id);
    expect(plan.cells).toHaveLength(2);
    expect(plan.boundaryAxIds).toHaveLength(4); // 2×1 rectangle
    // Room B removed + exactly one interior wall (the shared vertical edge).
    expect(plan.removeNodeIds).toContain(rB.id);
    const removedWalls = plan.removeNodeIds.filter((id) => nodes.find((n) => n.id === id && n.type === 'wall'));
    expect(removedWalls).toHaveLength(1);
  });

  it('refuses rooms that do not share an edge', () => {
    // 3×3 grid → corner cells (0,0) and (1,1) touch only at a point.
    const { ax, nodes, edges, all } = build(3, 3);
    const rooms = nodes.filter((n) => n.type === 'room');
    const byCell = (gx: number, gy: number) =>
      rooms.find((r) => (r.properties.cells as Cell[])[0][0] === gx && (r.properties.cells as Cell[])[0][1] === gy)!;
    const plan = planJoinRooms(byCell(0, 0), byCell(1, 1), ax, all, edges);
    expect(plan).toBeNull();
  });

  it('a second merge yields an L-shaped room (6 boundary corners)', () => {
    const { ax, nodes, edges, all } = build(3, 3);
    const rooms = nodes.filter((n) => n.type === 'room');
    const byCell = (gx: number, gy: number) =>
      rooms.find((r) => (r.properties.cells as Cell[])[0][0] === gx && (r.properties.cells as Cell[])[0][1] === gy)!;
    // First merge (0,0)+(1,0) → 2×1 room A'.
    const p1 = planJoinRooms(byCell(0, 0), byCell(1, 0), ax, all, edges)!;
    const roomAprime: BubbleGraphNode = { ...byCell(0, 0), properties: { ...byCell(0, 0).properties, cells: p1.cells } };
    // Now merge A' with (0,1) → L-shape.
    const plan = planJoinRooms(roomAprime, byCell(0, 1), ax, all, edges)!;
    expect(plan).not.toBeNull();
    expect(plan.cells).toHaveLength(3);
    expect(plan.boundaryAxIds).toHaveLength(6);
  });

  it('cellsOfRoom falls back to the ax bbox when metadata is absent', () => {
    const ax = axGrid(3, 2);
    const byId = new Map<string, BubbleGraphNode>(ax.map((n) => [n.id, n]));
    const room: BubbleGraphNode = { id: 'r', type: 'room', name: 'R', x: 0, y: 0, z: 0, properties: {} };
    const edges: BubbleGraphEdge[] = [
      { id: 'e1', from: 'r', to: 'ax_0_0' }, { id: 'e2', from: 'r', to: 'ax_2_0' },
      { id: 'e3', from: 'r', to: 'ax_2_1' }, { id: 'e4', from: 'r', to: 'ax_0_1' },
    ];
    byId.set('r', room);
    const cells = cellsOfRoom(room, edges, byId);
    expect(cells).toHaveLength(2); // spans columns 0..2, row 0..1 → cells (0,0),(1,0)
  });
});
