/**
 * The mapping is pure, so everything that can go wrong between the graph and
 * ArchiCAD is testable here without ArchiCAD running: unit conversion, storey
 * indices, the opening centre-offset, and the four places where the older IFC
 * export silently drops geometry.
 *
 * The fixture is the one from `src/lib/ifc/buildIfcModel.test.ts` — a 5×4 m box
 * with 4 corner columns, 4 walls (one with a door, one with an inline window),
 * an interior beam, a room slab and a standalone balcony slab.
 */
import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { buildArchicadModel, roofFaceToPayload } from './buildArchicadModel';

const STOREY: BubbleGraphNode = {
  id: 'st', type: 'storey', name: 'Parter', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};

const ax = (id: string, x: number, y: number, hasColumn = true): BubbleGraphNode => ({
  id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
  properties: { bimX: x, bimY: y, has_column: hasColumn ? 'True' : 'False', column_type: 'C30x30' },
});

const wall = (id: string, extra: Record<string, unknown> = {}): BubbleGraphNode => ({
  id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
  properties: { wall_type: 'W20', ...extra },
});

let n = 0;
const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `e${n++}`, from, to });

function buildFixture() {
  const c0 = ax('c0', 0, 0);
  const c1 = ax('c1', 5000, 0);
  const c2 = ax('c2', 5000, 4000);
  const c3 = ax('c3', 0, 4000);
  const m0 = ax('m0', 1000, 2000);
  const m1 = ax('m1', 4000, 2000);

  const w0 = wall('w0');
  const w1 = wall('w1', { has_windows: 'True', windows: JSON.stringify([{ window_type: 'W-FIX-100x120' }]) });
  const w2 = wall('w2');
  const w3 = wall('w3');
  const door: BubbleGraphNode = {
    id: 'door1', type: 'door', name: 'D1', x: 0, y: 0, z: 0, parentId: 'st',
    properties: { door_type: 'D-SWING-90x210', width: 900, height: 2100, sill_height: 0 },
  };
  const beam: BubbleGraphNode = {
    id: 'beam1', type: 'beam', name: 'B1', x: 2500, y: 2000, z: 0, parentId: 'st',
    properties: { beam_section: 'B25x30' },
  };
  const room: BubbleGraphNode = {
    id: 'room', type: 'room', name: 'R', x: 2500, y: 2000, z: 0, parentId: 'st',
    properties: { slab_type: 'SLAB15' },
  };

  const nodes = [STOREY, c0, c1, c2, c3, m0, m1, w0, w1, w2, w3, door, beam, room];
  const edges: BubbleGraphEdge[] = [
    wire('w0', 'c0'), wire('w0', 'c1'), wire('door1', 'w0'),
    wire('w1', 'c1'), wire('w1', 'c2'),
    wire('w2', 'c2'), wire('w2', 'c3'),
    wire('w3', 'c3'), wire('w3', 'c0'),
    wire('beam1', 'm0'), wire('beam1', 'm1'),
    wire('room', 'c0'), wire('room', 'c1'), wire('room', 'c2'), wire('room', 'c3'),
  ];
  return { nodes, edges };
}

describe('element coverage', () => {
  const { nodes, edges } = buildFixture();
  const plan = buildArchicadModel(nodes, edges);

  it('emits every element kind the fixture contains', () => {
    expect(plan.stories).toHaveLength(1);
    expect(plan.walls).toHaveLength(4);
    expect(plan.columns).toHaveLength(6); // 4 corners + 2 interior
    expect(plan.beams).toHaveLength(1);
    expect(plan.slabs).toHaveLength(1);
    expect(plan.doors).toHaveLength(1);
    expect(plan.windows).toHaveLength(1);
  });

  it('converts millimetres to metres everywhere', () => {
    const south = plan.walls[0];
    expect(south.begCoordinate).toEqual({ x: 0, y: 0 });
    expect(south.endCoordinate).toEqual({ x: 5, y: 0 });
    expect(south.thickness).toBeCloseTo(0.20, 6); // W20
    expect(south.height).toBeCloseTo(3.0, 6);
    expect(plan.columns[0].width).toBeCloseTo(0.30, 6); // C30x30
  });

  it('places the storey at its elevation and elements storey-relative', () => {
    expect(plan.stories[0]).toEqual({ name: 'Parter', level: 0, dispOnSections: true });
    expect(plan.walls.every((w) => w.zCoordinate === 0)).toBe(true);
    expect(plan.walls.every((w) => w.floorIndex === 0)).toBe(true);
  });
});

describe('openings — where the two models genuinely differ', () => {
  it('converts left-edge offset to ArchiCAD centre offset', () => {
    // A 900 mm door, no explicit offset, on a 5000 mm wall → collectOpenings
    // centres it, left edge at 2050. ArchiCAD wants the centre: 2500 mm.
    const { nodes, edges } = buildFixture();
    const plan = buildArchicadModel(nodes, edges);
    expect(plan.doors[0].centerOffset).toBeCloseTo(2.5, 6);
    expect(plan.doors[0].width).toBeCloseTo(0.9, 6);
  });

  it('honours an explicit offset, still converting to the centre', () => {
    const { nodes, edges } = buildFixture();
    const door = nodes.find((x) => x.id === 'door1')!;
    door.properties = { ...door.properties, offset: 1000 }; // left edge at 1000 mm
    const plan = buildArchicadModel(nodes, edges);
    expect(plan.doors[0].centerOffset).toBeCloseTo(1.45, 6); // (1000 + 450) mm
  });

  it('measures the offset from the wall endpoint order, so it never mirrors', () => {
    // Reversing which endpoint is "start" must flip a non-centred opening.
    const { nodes, edges } = buildFixture();
    const door = nodes.find((x) => x.id === 'door1')!;
    door.properties = { ...door.properties, offset: 500 };
    const flipped = edges.map((e) =>
      e.from === 'w0' && e.to === 'c0' ? { ...e, id: 'zzz' } : e,
    ).sort((a, b) => (a.id === 'zzz' ? 1 : b.id === 'zzz' ? -1 : 0));

    const a = buildArchicadModel(nodes, edges);
    const b = buildArchicadModel(nodes, flipped);
    // Same wall, opposite direction → the wall's own endpoints swap too, so the
    // offset stays measured from whichever endpoint came first.
    expect(b.walls[0].begCoordinate).not.toEqual(a.walls[0].begCoordinate);
    expect(b.doors[0].centerOffset).toBeCloseTo(a.doors[0].centerOffset, 6);
  });

  it('splits count/spacing into several ArchiCAD openings from one node', () => {
    const { nodes, edges } = buildFixture();
    const w1 = nodes.find((x) => x.id === 'w1')!;
    w1.properties = {
      ...w1.properties,
      windows: JSON.stringify([{ window_type: 'W-FIX-100x120', count: 3, spacing: 500 }]),
    };
    const plan = buildArchicadModel(nodes, edges);
    expect(plan.windows).toHaveLength(3);
    const offsets = plan.windows.map((w) => w.centerOffset);
    expect(new Set(offsets).size).toBe(3); // three distinct positions
  });

  it('points every opening at a wall that exists in the plan', () => {
    const { nodes, edges } = buildFixture();
    const plan = buildArchicadModel(nodes, edges);
    for (const o of [...plan.windows, ...plan.doors]) {
      expect(plan.walls[o.wallIndex]).toBeDefined();
    }
  });
});

describe('the gaps the IFC export leaves', () => {
  it('emits a wall ring beam, not just a shortened wall', () => {
    const { nodes, edges } = buildFixture();
    const w = nodes.find((x) => x.id === 'w0')!;
    w.properties = { ...w.properties, has_beam: 'True', beam_section: 'B20x30' };
    const plan = buildArchicadModel(nodes, edges);

    // The wall stops under its beam...
    expect(plan.walls[0].height).toBeCloseTo(3.0 - 0.30, 6);
    // ...and the beam itself exists, sitting in the gap.
    expect(plan.beams).toHaveLength(2); // interior beam + this ring beam
    const ring = plan.beams.find((b) => b.height === 0.30 && b.width === 0.20)!;
    expect(ring).toBeDefined();
    expect(ring.zCoordinate).toBeCloseTo(3.0 - 0.30, 6);
  });

  it('expands array nodes instead of exporting one of N', () => {
    const { nodes, edges } = buildFixture();
    const col: BubbleGraphNode = {
      id: 'arr', type: 'column', name: 'arr', x: 8000, y: 0, z: 0, parentId: 'st',
      // Offsets list — one instance per entry (see parseArrayProp).
      properties: { column_type: 'C30x30', array_x: '0, 1000, 2000' },
    };
    const plan = buildArchicadModel([...nodes, col], edges);
    expect(plan.columns).toHaveLength(6 + 3);
  });

  it('finds elements nested deeper than one level below the storey', () => {
    const { nodes, edges } = buildFixture();
    // A column parented to a room, which is parented to the storey.
    const nested: BubbleGraphNode = {
      id: 'deep', type: 'column', name: 'deep', x: 2000, y: 2000, z: 0, parentId: 'room',
      properties: { column_type: 'C25x25' },
    };
    const plan = buildArchicadModel([...nodes, nested], edges);
    expect(plan.columns).toHaveLength(7);
  });

  it('hangs beams under the storey top rather than floating at it', () => {
    const { nodes, edges } = buildFixture();
    const plan = buildArchicadModel(nodes, edges);
    expect(plan.beams[0].zCoordinate).toBeCloseTo(3.0 - 0.30, 6); // B25x30 → 0.30 deep
  });

  it('insets a slab by its contour offset', () => {
    const { nodes, edges } = buildFixture();
    const room = nodes.find((x) => x.id === 'room')!;
    room.properties = { ...room.properties, contour_offset: -100 };
    const plan = buildArchicadModel(nodes, edges);
    const xs = plan.slabs[0].polygonCoordinates.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(0.1, 3);
    expect(Math.max(...xs)).toBeCloseTo(4.9, 3);
  });

  it('hangs the slab under the storey top', () => {
    const { nodes, edges } = buildFixture();
    const plan = buildArchicadModel(nodes, edges);
    expect(plan.slabs[0].thickness).toBeCloseTo(0.15, 6);
    expect(plan.slabs[0].level).toBeCloseTo(3.0 - 0.15, 6);
  });
});

describe('property idioms and skips', () => {
  it('treats has_slab as opt-out but has_column as opt-in', () => {
    const { nodes, edges } = buildFixture();
    const room = nodes.find((x) => x.id === 'room')!;
    expect(room.properties.has_slab).toBeUndefined();
    expect(buildArchicadModel(nodes, edges).slabs).toHaveLength(1); // absent ⇒ yes

    room.properties = { ...room.properties, has_slab: 'False' };
    expect(buildArchicadModel(nodes, edges).slabs).toHaveLength(0);
  });

  it('resolves a formula-valued height instead of producing NaN', () => {
    const { nodes, edges } = buildFixture();
    const w = nodes.find((x) => x.id === 'w0')!;
    w.properties = { ...w.properties, height: '1000 + 500' };
    const plan = buildArchicadModel(nodes, edges);
    expect(plan.walls[0].height).toBeCloseTo(1.5, 6);
  });

  it('records a reason for everything it drops', () => {
    const loose = wall('wLoose');
    const plan = buildArchicadModel([STOREY, ax('p', 0, 0), loose], [wire('wLoose', 'p')]);
    expect(plan.walls).toHaveLength(0);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({ nodeId: 'wLoose', reason: expect.stringContaining('2 ax/column') }),
    );
  });

  it('needs columns at both ends of a beam, but not of a wall', () => {
    const p0 = ax('p0', 0, 0, false);
    const p1 = ax('p1', 3000, 0, false);
    const w = wall('w');
    const b: BubbleGraphNode = {
      id: 'b', type: 'beam', name: 'b', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { beam_section: 'B20x30' },
    };
    const plan = buildArchicadModel(
      [STOREY, p0, p1, w, b],
      [wire('w', 'p0'), wire('w', 'p1'), wire('b', 'p0'), wire('b', 'p1')],
    );
    expect(plan.walls).toHaveLength(1);
    expect(plan.beams).toHaveLength(0);
  });

  it('reports an element whose parent chain never reaches a storey', () => {
    // The grouping pass used to drop these with no trace, which is
    // indistinguishable from the bridge simply ignoring the element.
    const orphan = { ...ax('orphan', 1000, 1000), parentId: undefined };
    const plan = buildArchicadModel([STOREY, orphan], []);

    expect(plan.columns).toHaveLength(0);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({ nodeId: 'orphan', reason: expect.stringContaining('storey') }),
    );
  });

  it('emits a column for an ax only when has_column is on', () => {
    const on = buildArchicadModel([STOREY, ax('a', 0, 0, true)], []);
    expect(on.columns).toHaveLength(1);

    const off = buildArchicadModel([STOREY, ax('a', 0, 0, false)], []);
    expect(off.columns).toHaveLength(0);

    // The property being absent entirely — a freshly generated axis grid — is
    // the same "no column" case, not a default-on.
    const bare: BubbleGraphNode = {
      id: 'a', type: 'ax', name: 'a', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { gridX: 0, gridY: 0 },
    };
    expect(buildArchicadModel([STOREY, bare], []).columns).toHaveLength(0);
  });

  it('accepts has_column as a real boolean, not only the string', () => {
    const b: BubbleGraphNode = {
      id: 'a', type: 'ax', name: 'a', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { bimX: 0, bimY: 0, has_column: true, column_type: 'C30x30' },
    };
    expect(buildArchicadModel([STOREY, b], []).columns).toHaveLength(1);
  });

  it('returns an empty plan when there are no storeys', () => {
    const plan = buildArchicadModel([ax('x', 0, 0)], []);
    expect(plan.stories).toHaveLength(0);
    expect(plan.columns).toHaveLength(0);
  });
});

describe('multi-storey', () => {
  it('indexes storeys by elevation and tags every element with its floor', () => {
    const upper: BubbleGraphNode = {
      id: 'st2', type: 'storey', name: 'Etaj 1', x: 0, y: 0, z: 0,
      properties: { bottomElevation: 3000, topElevation: 6000 },
    };
    const { nodes, edges } = buildFixture();
    const upperCol: BubbleGraphNode = {
      id: 'uc', type: 'column', name: 'uc', x: 0, y: 0, z: 0, parentId: 'st2',
      properties: { column_type: 'C30x30' },
    };
    const plan = buildArchicadModel([...nodes, upper, upperCol], edges);

    expect(plan.stories.map((s) => s.level)).toEqual([0, 3]);
    expect(plan.columns.find((c) => c.floorIndex === 1)).toBeDefined();
    // Storey-local: the upper column's own Z is 0, its height comes from the band.
    expect(plan.columns.find((c) => c.floorIndex === 1)!.coordinates.z).toBe(0);
  });
});

describe('roof faces → ArchiCAD single-plane roofs', () => {
  /** A 30° face rising toward +X, from z=0 at x=0 to z=tan30*4000 at x=4000. */
  const rise = Math.tan((30 * Math.PI) / 180) * 4000;
  const face = [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 5000, z: 0 },
    { x: 4000, y: 5000, z: rise },
    { x: 4000, y: 0, z: rise },
  ];

  it('reports the face\'s real slope angle', () => {
    const p = roofFaceToPayload(face)!;
    expect((p.angleRad * 180) / Math.PI).toBeCloseTo(30, 6);
  });

  it('puts the pivot line on the low edge, at its elevation', () => {
    const p = roofFaceToPayload(face)!;
    expect(p.levelMm).toBe(0);
    expect(p.pivot.beg.x).toBe(0); // the low edge is at x = 0
  });

  it('orients the pivot so ArchiCAD tilts the plane the way the face tilts', () => {
    // This is the whole correctness question: ArchiCAD raises the plane on the
    // LEFT of beg→end, and left of d is (−d.y, d.x). That must point uphill.
    const p = roofFaceToPayload(face)!;
    const d = { x: p.pivot.end.x - p.pivot.beg.x, y: p.pivot.end.y - p.pivot.beg.y };
    const left = { x: -d.y, y: d.x };
    const len = Math.hypot(left.x, left.y);
    // Uphill here is +X.
    expect(left.x / len).toBeCloseTo(1, 6);
    expect(left.y / len).toBeCloseTo(0, 6);
  });

  it('keeps the pivot line level on the plane', () => {
    const p = roofFaceToPayload(face)!;
    // Both pivot endpoints must sit at the same height on the face's plane,
    // else the roof is tilted about the wrong axis.
    const zAt = (x: number) => (x / 4000) * rise;
    expect(zAt(p.pivot.beg.x)).toBeCloseTo(zAt(p.pivot.end.x), 6);
  });

  it('handles a face tilting the other way without mirroring it', () => {
    const flipped = face.map((v) => ({ ...v, x: -v.x }));
    const p = roofFaceToPayload(flipped)!;
    const d = { x: p.pivot.end.x - p.pivot.beg.x, y: p.pivot.end.y - p.pivot.beg.y };
    const left = { x: -d.y, y: d.x };
    expect(left.x / Math.hypot(left.x, left.y)).toBeCloseTo(-1, 6);
  });

  it('refuses faces that are not a slope', () => {
    expect(roofFaceToPayload(face.slice(0, 2))).toBeNull();                        // degenerate
    expect(roofFaceToPayload(face.map((v) => ({ ...v, z: 0 })))).toBeNull();       // dead level
    expect(roofFaceToPayload([                                                     // vertical
      { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 0, z: 2000 },
    ])).toBeNull();
  });

  it('emits one roof per slope face of a real roof node, and skips gable ends', () => {
    const { nodes, edges } = buildFixture();
    const roof: BubbleGraphNode = {
      id: 'roof1', type: 'roof', name: 'R', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { roof_type: 'hip', pitch_deg: 30, overhang_mm: 400, covering_thickness_mm: 40 },
    };
    const plan = buildArchicadModel(
      [...nodes, roof],
      [...edges, ...['c0', 'c1', 'c2', 'c3'].map((a, i) => ({ id: `re${i}`, from: 'roof1', to: a }))],
    );
    expect(plan.roofs.length).toBeGreaterThan(0);
    for (const r of plan.roofs) {
      expect(r.angle).toBeGreaterThan(0);
      expect(r.thickness).toBeCloseTo(0.04, 6);
      expect(r.polygonCoordinates.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('placing an element that has no parent', () => {
  /** A roof drawn against the axes it covers comes out with parentId: null. */
  function parentlessRoof() {
    const { nodes, edges } = buildFixture();
    const roof: BubbleGraphNode = {
      id: 'roof1', type: 'roof', name: 'R', x: 0, y: 0, z: 0, parentId: null,
      properties: { roof_type: 'hip', pitch_deg: 30, overhang_mm: 400, covering_thickness_mm: 40 },
    };
    return {
      nodes: [...nodes, roof],
      edges: [...edges, ...['c0', 'c1', 'c2', 'c3'].map((a, i) => ({ id: `re${i}`, from: 'roof1', to: a }))],
    };
  }

  it('finds the storey through its connections', () => {
    const { nodes, edges } = parentlessRoof();
    const plan = buildArchicadModel(nodes, edges);
    expect(plan.roofs.length).toBeGreaterThan(0);
    expect(plan.skipped.map((s) => s.nodeId)).not.toContain('roof1');
    expect(plan.roofs.every((r) => r.floorIndex === 0)).toBe(true);
  });

  it('still reports one that is connected to nothing', () => {
    const { nodes } = parentlessRoof();
    const plan = buildArchicadModel(nodes, []);
    expect(plan.roofs).toHaveLength(0);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({ nodeId: 'roof1', reason: expect.stringContaining('storey') }),
    );
  });

  it('prefers a real parent over a connection when both exist', () => {
    const upper: BubbleGraphNode = {
      id: 'st2', type: 'storey', name: 'Etaj', x: 0, y: 0, z: 0,
      properties: { bottomElevation: 3000, topElevation: 6000 },
    };
    const { nodes, edges } = parentlessRoof();
    const roof = nodes.find((n) => n.id === 'roof1')!;
    roof.parentId = 'st2'; // parented upstairs, but wired to ground-floor axes
    const plan = buildArchicadModel([...nodes, upper], edges);
    expect(plan.roofs.every((r) => r.floorIndex === 1)).toBe(true);
  });
});

describe('stairs by type', () => {
  const STOREY2: BubbleGraphNode = {
    id: 'st2', type: 'storey', name: 'Etaj 1', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 3000, topElevation: 6000 },
  };
  const sw = (props: Record<string, unknown>): BubbleGraphNode => ({
    id: 'sw', type: 'stairwell', name: 'Stairwell', x: 1000, y: 1000, z: 0,
    parentId: 'st', properties: { width_mm: 1000, ...props },
  });

  it('pushes a winder turn with flight ends only — fan points refuse the stair', () => {
    // Measured live: a point per winder makes ~260 mm baseline segments and
    // CreateStairs refuses the whole stair; the 4-point flight-ends path (the
    // same shape a landing turn sends) creates.
    const plan = buildArchicadModel(
      [STOREY, STOREY2, sw({ stair_type: 'l_shape', turn_style: 'winder', winder_count: 3 })], [],
    );
    expect(plan.stairs).toHaveLength(1);
    expect(plan.stairs[0].baseLinePoints).toHaveLength(4);
    expect(plan.stairs[0].totalHeight).toBeCloseTo(3, 6);
  });

  it('sends a landing turn the same 4-point path as before', () => {
    const plan = buildArchicadModel([STOREY, STOREY2, sw({ stair_type: 'l_shape' })], []);
    expect(plan.stairs[0].baseLinePoints).toHaveLength(4);
  });

  it('skips a spiral with the measured reason, not a fake solve failure', () => {
    const plan = buildArchicadModel(
      [STOREY, STOREY2, sw({ stair_type: 'spiral' })], [],
    );
    expect(plan.stairs).toHaveLength(0);
    const skip = plan.skipped.find((s) => s.nodeId === 'sw');
    expect(skip).toBeDefined();
    expect(skip!.reason).toContain('spiral');
    expect(skip!.reason).toContain('refuses');
    expect(skip!.reason).not.toContain('did not solve');
  });
});

describe('sweeps → beams and columns', () => {
  const SWEEP_DEFAULTS = {
    profile: 'rect', p_w_mm: 300, p_h_mm: 600,
    anchor_x: 'mid', anchor_y: 'max', level: 'top',
    offset_z_mm: 0, offset_x_mm: 0, rotation_deg: 0,
    mirror: 'False', corners: 'miter', closed: 'False', height_mm: 0,
  };
  const pt = (id: string, x: number, y: number): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y },
  });
  function scene(anchors: [string, number, number][], props: Record<string, unknown> = {}) {
    const pts = anchors.map(([id, x, y]) => pt(id, x, y));
    const sweep: BubbleGraphNode = {
      id: 'sw1', type: 'sweep', name: 'Brau', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { ...SWEEP_DEFAULTS, ...props },
    };
    const es: BubbleGraphEdge[] = pts.map((p, i) => ({ id: `swe${i}`, from: 'sw1', to: p.id }));
    return buildArchicadModel([STOREY, sweep, ...pts], es);
  }

  it('a straight rectangular sweep becomes one beam in metres, hung by its anchor', () => {
    const plan = scene([['p0', 0, 0], ['p1', 4200, 0]]);
    expect(plan.beams).toHaveLength(1);
    const b = plan.beams[0];
    expect(b.begCoordinate).toEqual({ x: 0, y: 0 });
    expect(b.endCoordinate.x).toBeCloseTo(4.2, 9);
    expect(b.width).toBeCloseTo(0.3, 9);
    expect(b.height).toBeCloseTo(0.6, 9);
    // anchor_y 'max' at storey top 3000 → the beam bottom sits at 2.4 m
    expect(b.zCoordinate).toBeCloseTo(2.4, 9);
  });

  it('a lateral offset shifts the baseline, since ArchiCAD centres the beam on it', () => {
    const plan = scene([['p0', 0, 0], ['p1', 4000, 0]], { offset_x_mm: 250 });
    // +x in the profile is LEFT of travel; travel is +X, so left is +Y.
    expect(plan.beams[0].begCoordinate.y).toBeCloseTo(0.25, 9);
    expect(plan.beams[0].endCoordinate.y).toBeCloseTo(0.25, 9);
  });

  it('an L emits a beam per segment and says the corners are not mitred', () => {
    const plan = scene([['p0', 0, 0], ['p1', 4000, 0], ['p2', 4000, 3000]]);
    expect(plan.beams).toHaveLength(2);
    expect(plan.skipped.some((s) => s.nodeId === 'sw1' && /not mitred|notch/.test(s.reason))).toBe(true);
  });

  it('a single anchor becomes a column, storey-relative', () => {
    const plan = scene([['p0', 1500, 2500]]);
    expect(plan.beams).toHaveLength(0);
    const c = plan.columns.find((x) => x.coordinates.x === 1.5);
    expect(c).toBeDefined();
    expect(c!.coordinates.z).toBeCloseTo(0, 9);
    expect(c!.height).toBeCloseTo(3, 9);
    expect(c!.width).toBeCloseTo(0.3, 9);
  });

  it('a non-rectangular profile is skipped with the reason, not faked as its bbox', () => {
    const plan = scene([['p0', 0, 0], ['p1', 4000, 0]], { profile: 'u', p_w_mm: 150, p_h_mm: 100, p_t_mm: 10 });
    expect(plan.beams).toHaveLength(0);
    expect(plan.skipped.some((s) => s.nodeId === 'sw1' && /not a rectangle/.test(s.reason))).toBe(true);
  });

  it('a rotated rectangle is not treated as axis-aligned', () => {
    const plan = scene([['p0', 0, 0], ['p1', 4000, 0]], { rotation_deg: 30 });
    expect(plan.beams).toHaveLength(0);
    expect(plan.skipped.some((s) => s.nodeId === 'sw1' && /not a rectangle/.test(s.reason))).toBe(true);
  });

  it('an unwired sweep is reported, never silently dropped', () => {
    const sweep: BubbleGraphNode = {
      id: 'sw2', type: 'sweep', name: 'Orfan', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { ...SWEEP_DEFAULTS },
    };
    const plan = buildArchicadModel([STOREY, sweep], []);
    expect(plan.beams).toHaveLength(0);
    expect(plan.skipped.some((s) => s.nodeId === 'sw2')).toBe(true);
  });
});
