import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { bounds, centroid, isManifold, validateSolid, volume, volumeM3 } from './index';
import { columnSolid, roomSlabSolid, roomVolumeSolid, wallBeamSolid, wallSolid } from './builders';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const storey = (props: Record<string, unknown> = {}): BubbleGraphNode => ({
  id: 'st', type: 'storey', name: 'S', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000, ...props },
});

const ax = (id: string, bimX: number, bimY: number, props: Record<string, unknown> = {}): BubbleGraphNode => ({
  id, type: 'ax', name: id, x: bimX, y: bimY, z: 0, parentId: 'st',
  properties: { bimX, bimY, ...props },
});

function mapOf(nodes: BubbleGraphNode[]): Map<string, BubbleGraphNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** A 5 m wall between two plain ax nodes on a 0–3000 mm storey. */
function wallScene(wallProps: Record<string, unknown>) {
  const a = ax('a', 0, 0);
  const b = ax('b', 5000, 0);
  const wall: BubbleGraphNode = {
    id: 'w', type: 'wall', name: 'W', x: 2500, y: 0, z: 0, parentId: 'st', properties: wallProps,
  };
  const edges: BubbleGraphEdge[] = [
    { id: 'e1', from: 'w', to: 'a' },
    { id: 'e2', from: 'w', to: 'b' },
  ];
  return { wall, nodeMap: mapOf([storey(), a, b, wall]), edges };
}

/** A rectangular room wired to its four corner ax nodes (calcRoomPolygon pattern A). */
function roomScene(w: number, d: number, roomProps: Record<string, unknown> = {}) {
  const corners = [ax('a1', 0, 0), ax('a2', w, 0), ax('a3', w, d), ax('a4', 0, d)];
  const room: BubbleGraphNode = {
    id: 'r', type: 'room', name: 'R', x: w / 2, y: d / 2, z: 0, parentId: 'st',
    properties: { contour_offset: 0, ...roomProps },
  };
  const edges: BubbleGraphEdge[] = corners.map((c, i) => ({ id: `e${i}`, from: 'r', to: c.id }));
  return { room, nodeMap: mapOf([storey(), ...corners, room]), edges };
}

// ─── Walls ────────────────────────────────────────────────────────────────────

describe('wallSolid', () => {
  it('a 5 m W20 wall on a 3 m storey is manifold and measures 3 m³', () => {
    const { wall, nodeMap, edges } = wallScene({ wall_type: 'W20' });
    const s = wallSolid(wall, nodeMap, edges)!;
    expect(validateSolid(s)).toEqual([]);
    expect(volumeM3(s)).toBeCloseTo(5.0 * 0.20 * 3.0, 6);

    const b = bounds(s)!;
    expect(b.min.z).toBeCloseTo(0, 6);
    expect(b.max.z).toBeCloseTo(3000, 6);
    expect(b.max.x - b.min.x).toBeCloseTo(5000, 6);  // length along East
    expect(b.max.y - b.min.y).toBeCloseTo(200, 6);   // W20 thickness across it
  });

  it('a ring beam shortens the masonry, and the two stack without overlap', () => {
    const { wall, nodeMap, edges } = wallScene({
      wall_type: 'W20', has_beam: 'True', beam_section: 'B20x30',
    });
    const masonry = wallSolid(wall, nodeMap, edges)!;
    const beam = wallBeamSolid(wall, nodeMap, edges)!;
    expect(validateSolid(masonry)).toEqual([]);
    expect(validateSolid(beam)).toEqual([]);

    const mb = bounds(masonry)!, bb = bounds(beam)!;
    expect(mb.max.z).toBeCloseTo(2700, 6);       // storey 3000 − beam 300
    expect(bb.min.z).toBeCloseTo(2700, 6);       // beam starts exactly where masonry ends
    expect(bb.max.z).toBeCloseTo(3000, 6);

    expect(volumeM3(masonry)).toBeCloseTo(5.0 * 0.20 * 2.7, 6);
    expect(volumeM3(beam)).toBeCloseTo(5.0 * 0.20 * 0.30, 6);
    // Together they exactly fill the storey band — the invariant the old
    // per-segment box builder had to maintain by hand.
    expect(volumeM3(masonry) + volumeM3(beam)).toBeCloseTo(5.0 * 0.20 * 3.0, 6);
  });

  it('no beam → no beam solid', () => {
    const { wall, nodeMap, edges } = wallScene({ wall_type: 'W20' });
    expect(wallBeamSolid(wall, nodeMap, edges)).toBeNull();
  });

  it('thickness follows the wall type', () => {
    const thin = wallScene({ wall_type: 'W10' });
    const thick = wallScene({ wall_type: 'W30' });
    expect(volumeM3(wallSolid(thin.wall, thin.nodeMap, thin.edges)!)).toBeCloseTo(5.0 * 0.10 * 3.0, 6);
    expect(volumeM3(wallSolid(thick.wall, thick.nodeMap, thick.edges)!)).toBeCloseTo(5.0 * 0.30 * 3.0, 6);
  });

  it('a wall with fewer than two endpoints yields nothing', () => {
    const a = ax('a', 0, 0);
    const wall: BubbleGraphNode = {
      id: 'w', type: 'wall', name: 'W', x: 0, y: 0, z: 0, parentId: 'st', properties: { wall_type: 'W20' },
    };
    const nodeMap = mapOf([storey(), a, wall]);
    expect(wallSolid(wall, nodeMap, [{ id: 'e1', from: 'w', to: 'a' }])).toBeNull();
  });
});

// ─── Columns ──────────────────────────────────────────────────────────────────

describe('columnSolid', () => {
  it('rectangular column spans the storey band at its ax position', () => {
    const a = ax('a', 4000, 2000, { has_column: 'true', column_type: 'C25x40' });
    const s = columnSolid(a, mapOf([storey(), a]))!;
    expect(validateSolid(s)).toEqual([]);
    expect(volume(s)).toBeCloseTo(250 * 400 * 3000, 3);

    const c = centroid(s)!;
    expect(c.x).toBeCloseTo(4000, 6);
    expect(c.y).toBeCloseTo(2000, 6);
    expect(c.z).toBeCloseTo(1500, 6);
  });

  it('standalone column node reads its own plan position', () => {
    const col: BubbleGraphNode = {
      id: 'c', type: 'column', name: 'C', x: 1000, y: -500, z: 0, parentId: 'st',
      properties: { column_type: 'C25x25' },
    };
    const s = columnSolid(col, mapOf([storey(), col]))!;
    const c = centroid(s)!;
    expect(c.x).toBeCloseTo(1000, 6);
    expect(c.y).toBeCloseTo(-500, 6);
  });

  it('circular column becomes an inscribed prism, not a box', () => {
    const a = ax('a', 0, 0, { has_column: 'true', column_type: 'CR30' });
    const s = columnSolid(a, mapOf([storey(), a]))!;
    expect(isManifold(s)).toBe(true);

    // CR30 → ∅300 mm. The kernel has no analytic curves, so this is an
    // 18-sided inscribed prism (matching the renderers' existing cylinder):
    // area = (n/2)·r²·sin(2π/n).
    const sides = 18, r = 150;
    const exact = (sides / 2) * r * r * Math.sin((2 * Math.PI) / sides) * 3000;
    expect(volume(s)).toBeCloseTo(exact, 3);
    expect(volume(s)).toBeLessThan(Math.PI * r * r * 3000);  // inscribed, so under the true circle
    expect(volume(s)).toBeLessThan(300 * 300 * 3000);        // and definitely not the bounding box
  });

  it('a zero-height storey band yields nothing', () => {
    const a = ax('a', 0, 0, { has_column: 'true' });
    const map = mapOf([storey({ topElevation: 0 }), a]);
    expect(columnSolid(a, map)).toBeNull();
  });
});

// ─── Rooms & slabs ────────────────────────────────────────────────────────────

describe('room-derived solids', () => {
  it('room volume fills the storey from its floor up', () => {
    const { room, nodeMap, edges } = roomScene(4000, 3000, { height: 2650 });
    const s = roomVolumeSolid(room, nodeMap, edges)!;
    expect(validateSolid(s)).toEqual([]);
    expect(volumeM3(s)).toBeCloseTo(4.0 * 3.0 * 2.65, 6);
    const b = bounds(s)!;
    expect(b.min.z).toBeCloseTo(0, 6);
    expect(b.max.z).toBeCloseTo(2650, 6);
  });

  it('room slab hangs under the storey top', () => {
    const { room, nodeMap, edges } = roomScene(4000, 3000, { slab_type: 'SLAB15' });
    const s = roomSlabSolid(room, nodeMap, edges)!;
    expect(validateSolid(s)).toEqual([]);
    const b = bounds(s)!;
    expect(b.max.z).toBeCloseTo(3000, 6);  // storey top
    expect(b.min.z).toBeCloseTo(2850, 6);  // 150 mm thick
    expect(volumeM3(s)).toBeCloseTo(4.0 * 3.0 * 0.15, 6);
  });

  it('the default contour offset insets the polygon by 125 mm per side', () => {
    // No explicit contour_offset → parseContourOffsets defaults to −125.
    const { room, nodeMap, edges } = roomScene(4000, 3000, { contour_offset: undefined, height: 1000 });
    const s = roomVolumeSolid(room, nodeMap, edges)!;
    const b = bounds(s)!;
    expect(b.max.x - b.min.x).toBeCloseTo(4000 - 250, 6);
    expect(b.max.y - b.min.y).toBeCloseTo(3000 - 250, 6);
  });

  it('a room with too few anchors yields nothing', () => {
    const c1 = ax('a1', 0, 0), c2 = ax('a2', 1000, 0);
    const room: BubbleGraphNode = {
      id: 'r', type: 'room', name: 'R', x: 0, y: 0, z: 0, parentId: 'st', properties: {},
    };
    const edges: BubbleGraphEdge[] = [
      { id: 'e1', from: 'r', to: 'a1' }, { id: 'e2', from: 'r', to: 'a2' },
    ];
    expect(roomVolumeSolid(room, mapOf([storey(), c1, c2, room]), edges)).toBeNull();
  });
});

// ─── Local transforms ─────────────────────────────────────────────────────────

describe('local transform', () => {
  it('translation moves the solid and preserves its volume', () => {
    const a = ax('a', 0, 0, {
      has_column: 'true', column_type: 'C25x25',
      obj_translate_x: 500, obj_translate_y: 250, obj_translate_z: 100,
    });
    const map = mapOf([storey(), a]);
    const moved = columnSolid(a, map)!;
    const plain = columnSolid(a, map, { applyLocalTransform: false })!;

    expect(volume(moved)).toBeCloseTo(volume(plain), 3);
    const cm = centroid(moved)!, cp = centroid(plain)!;
    expect(cm.x - cp.x).toBeCloseTo(500, 6);
    expect(cm.y - cp.y).toBeCloseTo(250, 6);
    expect(cm.z - cp.z).toBeCloseTo(100, 6);
  });

  it('rotation about Up spins the element in place, keeping volume and centroid', () => {
    const a = ax('a', 1000, 2000, {
      has_column: 'true', column_type: 'C20x60', obj_rotate_y: 90,
    });
    const map = mapOf([storey(), a]);
    const spun = columnSolid(a, map)!;
    const plain = columnSolid(a, map, { applyLocalTransform: false })!;

    expect(validateSolid(spun)).toEqual([]);
    expect(volume(spun)).toBeCloseTo(volume(plain), 3);
    const cs = centroid(spun)!, cp = centroid(plain)!;
    expect(cs.x).toBeCloseTo(cp.x, 6);
    expect(cs.y).toBeCloseTo(cp.y, 6);

    // 200 × 600 section rotated a quarter turn swaps its plan extents.
    const bp = bounds(plain)!, bs = bounds(spun)!;
    expect(bp.max.x - bp.min.x).toBeCloseTo(200, 6);
    expect(bs.max.x - bs.min.x).toBeCloseTo(600, 6);
    expect(bs.max.y - bs.min.y).toBeCloseTo(200, 6);
  });
});
