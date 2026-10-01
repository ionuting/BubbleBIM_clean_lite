import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { buildStoreyNodes } from '@/lib/storeys/defaultProject';
import { getAxRealPos } from '@/lib/bimGeometry';
import {
  applyGridEdit,
  axCanvasPos,
  axisDeltaBounds,
  cellOffsetBounds,
  detachCellEdge,
  linkedStoreys,
  moveStoreyAxis,
  resolveScope,
  setAxisSpan,
  sortedAxes,
  stepCellEdge,
  storeyFrame,
} from './axisEdit';

const XS = [0, 5000, 10000], YS = [0, 4000, 8000];

/** Two storeys with the default grid, plus a wall 1-A → 2-A on the first and a door on it. */
function fixture() {
  const s1 = buildStoreyNodes('P', 0, 3000, XS, YS, 0);
  const s2 = buildStoreyNodes('E1', 3000, 6000, XS, YS, 1);
  const storey1 = s1[0], storey2 = s2[0];
  const ax = (s: BubbleGraphNode[], gx: number, gy: number) =>
    s.find((n) => n.type === 'ax' && n.properties.gridX === gx && n.properties.gridY === gy)!;
  const a = ax(s1, 0, 0), b = ax(s1, 1, 0);
  const wall: BubbleGraphNode = {
    id: 'wall', type: 'wall', name: 'W', x: (a.x + b.x) / 2, y: a.y, z: 0, parentId: storey1.id, properties: {},
  };
  const door: BubbleGraphNode = {
    id: 'door', type: 'door', name: 'D', x: wall.x, y: wall.y + 600, z: 0, parentId: storey1.id, properties: {},
  };
  const loose: BubbleGraphNode = {
    id: 'loose', type: 'foundation', name: 'F', x: storey1.x, y: storey1.y, z: 0, parentId: storey1.id, properties: {},
  };
  const nodes = [...s1, ...s2, wall, door, loose];
  const edges: BubbleGraphEdge[] = [
    { id: 'e1', from: a.id, to: 'wall' }, { id: 'e2', from: 'wall', to: b.id }, { id: 'e3', from: 'door', to: 'wall' },
  ];
  return { nodes, edges, storey1, storey2, ax, s1 };
}

const byId = (nodes: BubbleGraphNode[], id: string) => nodes.find((n) => n.id === id)!;

describe('canvas ↔ bim', () => {
  it('axCanvasPos reproduces the positions buildStoreyNodes wrote', () => {
    const { s1 } = fixture();
    for (const n of s1.slice(1)) {
      const p = axCanvasPos(n, s1[0]);
      expect(p.x).toBeCloseTo(n.x, 6);
      expect(p.y).toBeCloseTo(n.y, 6);
    }
    const f = storeyFrame(s1[0]);
    expect(f.maxX).toBe(10000);
    expect(f.ox).toBe(s1[0].x - 5000);
  });

  it('sortedAxes returns a fresh sorted array from an array or a JSON string', () => {
    const s: BubbleGraphNode = { id: 's', type: 'storey', name: 's', x: 0, y: 0, z: 0, properties: { axesX: [3, 1, 2], axesY: '[9,8]' } };
    const xs = sortedAxes(s, 'x');
    expect(xs).toEqual([1, 2, 3]);
    expect(s.properties.axesX).toEqual([3, 1, 2]);   // untouched
    expect(sortedAxes(s, 'y')).toEqual([8, 9]);
  });
});

describe('moveStoreyAxis', () => {
  it('moves one value, rewrites the ax caches and keeps a fresh sorted array', () => {
    const { nodes, edges, storey1, ax, s1 } = fixture();
    const out = moveStoreyAxis(nodes, edges, [storey1.id], 'x', 1, 750);
    const st = byId(out, storey1.id);
    expect(st.properties.axesX).toEqual([0, 5750, 10000]);
    expect(st.properties.axesX).not.toBe(storey1.properties.axesX);
    expect(st.properties.width).toBe(10000);
    // Every ax on axis 2 moved by +750 on the canvas, others stayed.
    const moved = byId(out, ax(s1, 1, 1).id), fixed = byId(out, ax(s1, 0, 1).id);
    expect(moved.x - ax(s1, 1, 1).x).toBeCloseTo(750, 6);
    expect(fixed.x).toBeCloseTo(ax(s1, 0, 1).x, 6);
    // BIM resolution agrees.
    const map = new Map(out.map((n) => [n.id, n]));
    expect(getAxRealPos(moved, map).x).toBe(5750);
  });

  it('snaps to 10 mm and never crosses a neighbour', () => {
    const { nodes, edges, storey1 } = fixture();
    const b = axisDeltaBounds(nodes, [storey1.id], 'x', 1);
    expect(b).toEqual({ lo: -4900, hi: 4900 });
    const out = moveStoreyAxis(nodes, edges, [storey1.id], 'x', 1, 99999);
    expect(byId(out, storey1.id).properties.axesX).toEqual([0, 9900, 10000]);
    const snapped = moveStoreyAxis(nodes, edges, [storey1.id], 'x', 1, 123);
    expect(byId(snapped, storey1.id).properties.axesX).toEqual([0, 5120, 10000]);
    expect(axisDeltaBounds(nodes, [storey1.id], 'x', 0).lo).toBe(-Infinity);
  });

  it('a wall follows the mean shift of its anchors, its door follows the wall, loose nodes stay', () => {
    const { nodes, edges, storey1 } = fixture();
    const out = moveStoreyAxis(nodes, edges, [storey1.id], 'x', 1, 1000);
    expect(byId(out, 'wall').x - byId(nodes, 'wall').x).toBeCloseTo(500, 6);   // one anchor moved 1000
    expect(byId(out, 'door').x - byId(nodes, 'door').x).toBeCloseTo(500, 6);
    expect(byId(out, 'loose').x).toBe(byId(nodes, 'loose').x);
  });

  it('moving the LAST axis recentres the frame: unanchored children shift by −Δ/2', () => {
    const { nodes, edges, storey1 } = fixture();
    const out = moveStoreyAxis(nodes, edges, [storey1.id], 'x', 2, 2000);
    expect(byId(out, storey1.id).properties.axesX).toEqual([0, 5000, 12000]);
    expect(byId(out, storey1.id).properties.width).toBe(12000);
    expect(byId(out, 'loose').x - byId(nodes, 'loose').x).toBeCloseTo(-1000, 6);
    // Ax caches still satisfy the formula.
    const st = byId(out, storey1.id);
    for (const n of out.filter((n) => n.type === 'ax' && n.parentId === storey1.id)) {
      expect(axCanvasPos(n, st).x).toBeCloseTo(n.x, 6);
    }
  });

  it('no-op returns the same array reference', () => {
    const { nodes, edges, storey1 } = fixture();
    expect(moveStoreyAxis(nodes, edges, [storey1.id], 'x', 1, 0)).toBe(nodes);
    expect(moveStoreyAxis(nodes, edges, [storey1.id], 'x', 1, 3)).toBe(nodes);   // rounds to 0
  });
});

describe('scope', () => {
  it('linkedStoreys finds storeys sharing the value; single scope is only the source', () => {
    const { nodes, storey1, storey2 } = fixture();
    expect(linkedStoreys(nodes, storey1.id, 'x', 1)).toEqual([storey1.id, storey2.id]);
    const shifted = nodes.map((n) => n.id === storey2.id ? { ...n, properties: { ...n.properties, axesX: [0, 6000, 10000] } } : n);
    expect(linkedStoreys(shifted, storey1.id, 'x', 1)).toEqual([storey1.id]);
    expect(linkedStoreys(shifted, storey1.id, 'x', 2)).toEqual([storey1.id, storey2.id]);
    expect(resolveScope(nodes, { kind: 'moveAxis', storeyId: storey1.id, axis: 'x', index: 1, deltaMm: 1, scope: 'single' }))
      .toEqual([storey1.id]);
  });

  it('a linked move keeps columns stacked across storeys, bounded by the tightest storey', () => {
    const { nodes, edges, storey1, storey2 } = fixture();
    const tight = nodes.map((n) => n.id === storey2.id ? { ...n, properties: { ...n.properties, axesX: [0, 5000, 5500] } } : n);
    expect(axisDeltaBounds(tight, [storey1.id, storey2.id], 'x', 1)).toEqual({ lo: -4900, hi: 400 });
    const out = applyGridEdit(tight, edges, { kind: 'moveAxis', storeyId: storey1.id, axis: 'x', index: 1, deltaMm: 5000, scope: 'linked' });
    expect(out.edges).toBe(edges);
    expect(byId(out.nodes, storey1.id).properties.axesX).toEqual([0, 5400, 10000]);
    expect(byId(out.nodes, storey2.id).properties.axesX).toEqual([0, 5400, 5500]);
  });
});

describe('setAxisSpan', () => {
  it('downstream translates every later axis; neighbour moves only the next one', () => {
    const { nodes, edges, storey1 } = fixture();
    const down = setAxisSpan(nodes, edges, [storey1.id], 'x', 0, 6000, 'downstream');
    expect(byId(down, storey1.id).properties.axesX).toEqual([0, 6000, 11000]);
    const nb = setAxisSpan(nodes, edges, [storey1.id], 'x', 0, 6000, 'neighbour');
    expect(byId(nb, storey1.id).properties.axesX).toEqual([0, 6000, 10000]);
  });

  it('clamps a tiny span to the minimum gap, and the linked scope needs both indices to match', () => {
    const { nodes, edges, storey1, storey2 } = fixture();
    const out = setAxisSpan(nodes, edges, [storey1.id], 'x', 0, 5, 'downstream');
    expect(byId(out, storey1.id).properties.axesX).toEqual([0, 100, 5100]);
    const other = nodes.map((n) => n.id === storey2.id ? { ...n, properties: { ...n.properties, axesX: [0, 5000, 9000] } } : n);
    expect(resolveScope(other, { kind: 'setSpan', storeyId: storey1.id, axis: 'x', index: 1, spanMm: 1, mode: 'downstream', scope: 'linked' }))
      .toEqual([storey1.id]);
    expect(resolveScope(other, { kind: 'setSpan', storeyId: storey1.id, axis: 'x', index: 0, spanMm: 1, mode: 'downstream', scope: 'linked' }))
      .toEqual([storey1.id, storey2.id]);
  });
});

describe('detachCellEdge', () => {
  it('offsets exactly the two points of the edge, resolved by getAxRealPos, and the wall between them follows', () => {
    const { nodes, edges, storey1, ax, s1 } = fixture();
    // Axis 2 (index 1), cell A-B (cell 0) → points (1,0) and (1,1) move +600 in x.
    const out = detachCellEdge(nodes, edges, [storey1.id], 'x', 1, 0, 600);
    const p10 = byId(out, ax(s1, 1, 0).id), p11 = byId(out, ax(s1, 1, 1).id), p12 = byId(out, ax(s1, 1, 2).id);
    expect(p10.properties.ax_dx_mm).toBe(600);
    expect(p11.properties.ax_dx_mm).toBe(600);
    expect(p12.properties).not.toHaveProperty('ax_dx_mm');
    const map = new Map(out.map((n) => [n.id, n]));
    expect(getAxRealPos(p10, map).x).toBe(5600);
    expect(getAxRealPos(p12, map).x).toBe(5000);
    expect(byId(out, storey1.id).properties.axesX).toEqual([0, 5000, 10000]);   // axis untouched
    expect(p10.x - ax(s1, 1, 0).x).toBeCloseTo(600, 6);                          // cache rewritten
    expect(byId(out, 'wall').x - byId(nodes, 'wall').x).toBeCloseTo(300, 6);    // one anchor of the wall moved
  });

  it('dragging back to zero removes the key; bounds stop at the neighbouring axis', () => {
    const { nodes, edges, storey1, ax, s1 } = fixture();
    const a = detachCellEdge(nodes, edges, [storey1.id], 'x', 1, 0, 600);
    const back = detachCellEdge(a, edges, [storey1.id], 'x', 1, 0, -600);
    expect(byId(back, ax(s1, 1, 0).id).properties).not.toHaveProperty('ax_dx_mm');
    expect(cellOffsetBounds(a, [storey1.id], 'x', 1, 0)).toEqual({ lo: -5500, hi: 4300 });
    const far = detachCellEdge(nodes, edges, [storey1.id], 'x', 1, 0, 99999);
    expect(byId(far, ax(s1, 1, 0).id).properties.ax_dx_mm).toBe(4900);
  });

  it('a later whole-axis move carries detached points along', () => {
    const { nodes, edges, storey1, ax, s1 } = fixture();
    const a = detachCellEdge(nodes, edges, [storey1.id], 'x', 1, 0, 600);
    const b = moveStoreyAxis(a, edges, [storey1.id], 'x', 1, 1000);
    const map = new Map(b.map((n) => [n.id, n]));
    expect(getAxRealPos(byId(b, ax(s1, 1, 0).id), map).x).toBe(6600);
    expect(getAxRealPos(byId(b, ax(s1, 1, 2).id), map).x).toBe(6000);
  });
});

describe('stepCellEdge', () => {
  /** One storey, two walls along axis A (1→2 and 2→3) and a room over the right bay. */
  function envelope() {
    const s = buildStoreyNodes('P', 0, 3000, XS, YS, 0);
    const storey = s[0];
    const ax = (gx: number, gy: number) =>
      s.find((n) => n.type === 'ax' && n.properties.gridX === gx && n.properties.gridY === gy)!;
    const wall = (id: string, a: BubbleGraphNode, b: BubbleGraphNode): BubbleGraphNode => ({
      id, type: 'wall', name: 'Wall', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0,
      parentId: storey.id, properties: { thickness: 250, material: 'brick' },
    });
    const w1 = wall('w1', ax(0, 0), ax(1, 0));
    const w2 = wall('w2', ax(1, 0), ax(2, 0));
    const room: BubbleGraphNode = {
      id: 'room', type: 'room', name: 'R', x: storey.x, y: storey.y, z: 0, parentId: storey.id, properties: {},
    };
    const nodes = [...s, w1, w2, room];
    const edges: BubbleGraphEdge[] = [
      { id: 'e1', from: ax(0, 0).id, to: 'w1' }, { id: 'e2', from: 'w1', to: ax(1, 0).id },
      { id: 'e3', from: ax(1, 0).id, to: 'w2' }, { id: 'e4', from: 'w2', to: ax(2, 0).id },
      { id: 'e5', from: 'room', to: ax(1, 0).id }, { id: 'e6', from: 'room', to: ax(2, 0).id },
      { id: 'e7', from: 'room', to: ax(1, 1).id }, { id: 'e8', from: 'room', to: ax(2, 1).id },
    ];
    return { nodes, edges, storey, ax };
  }

  /** Step the A-axis run between axes 2 and 3 down by 800 mm. */
  const stepped = () => {
    const f = envelope();
    return { ...f, out: stepCellEdge(f.nodes, f.edges, [f.storey.id], 'y', 0, 1, -800) };
  };

  it('inserts a real axis and re-keys every grid point after it', () => {
    const { out, storey, ax } = stepped();
    expect(byId(out.nodes, storey.id).properties.axesY).toEqual([-800, 0, 4000, 8000]);
    // Everything that was on A, B, C moved one row up the index.
    expect(byId(out.nodes, ax(0, 0).id).properties.gridY).toBe(1);
    expect(byId(out.nodes, ax(0, 2).id).properties.gridY).toBe(3);
    // …and the names follow the bubbles.
    expect(byId(out.nodes, ax(0, 0).id).name).toBe('1-B');
    expect(byId(out.nodes, ax(0, 0).id).properties.axNodeIndex).toBe(3);
  });

  it('moves the free end onto the new axis and splits the corner that would go oblique', () => {
    const { out, ax } = stepped();
    const map = new Map(out.nodes.map((n) => [n.id, n]));
    // Axis 3 has no run beyond it, so its point simply moved down.
    const far = byId(out.nodes, ax(2, 0).id);
    expect(far.properties.gridY).toBe(0);
    expect(getAxRealPos(far, map).y).toBe(-800);
    // Axis 2 still carries the run to axis 1, so it kept a point on A …
    const corner = byId(out.nodes, ax(1, 0).id);
    expect(corner.properties.gridY).toBe(1);
    expect(getAxRealPos(corner, map).y).toBe(0);
    // … and gained one on the new axis.
    const copies = out.nodes.filter((n) => n.type === 'ax' && n.properties.gridX === 1 && n.properties.gridY === 0);
    expect(copies).toHaveLength(1);
    expect(copies[0].id).not.toBe(corner.id);
    expect(getAxRealPos(copies[0], map).y).toBe(-800);
  });

  it('rewires only the dragged run, and closes the jog with a copy of its wall', () => {
    const { out, ax } = stepped();
    const copy = out.nodes.find((n) => n.type === 'ax' && n.properties.gridX === 1 && n.properties.gridY === 0)!;
    const ends = (id: string) => out.edges.filter((e) => e.from === id || e.to === id)
      .map((e) => (e.from === id ? e.to : e.from)).sort();
    // w2 and the room span the run, so they follow the step; w1 stays on axis A.
    expect(ends('w2')).toEqual([ax(2, 0).id, copy.id].sort());
    expect(ends('w1')).toEqual([ax(0, 0).id, ax(1, 0).id].sort());
    expect(ends('room')).toContain(copy.id);
    expect(ends('room')).not.toContain(ax(1, 0).id);
    // The generated wall bridges the two halves of the split corner.
    const jog = out.nodes.find((n) => n.type === 'wall' && n.id !== 'w1' && n.id !== 'w2')!;
    expect(jog.properties).toEqual({ thickness: 250, material: 'brick' });
    expect(ends(jog.id)).toEqual([ax(1, 0).id, copy.id].sort());
    const a = byId(out.nodes, ax(1, 0).id), b = byId(out.nodes, copy.id);
    expect(jog.x).toBeCloseTo((a.x + b.x) / 2, 6);
    expect(jog.y).toBeCloseTo((a.y + b.y) / 2, 6);
  });

  it('with nothing beyond either end both points move and no wall is invented', () => {
    // A single bay: the run IS the whole A axis, so no corner can go oblique.
    const s = buildStoreyNodes('P', 0, 3000, [0, 5000], YS, 0);
    const storey = s[0];
    const ax = (gx: number, gy: number) =>
      s.find((n) => n.type === 'ax' && n.properties.gridX === gx && n.properties.gridY === gy)!;
    const wall: BubbleGraphNode = {
      id: 'w', type: 'wall', name: 'Wall', x: 0, y: 0, z: 0, parentId: storey.id, properties: {},
    };
    const nodes = [...s, wall];
    const edges: BubbleGraphEdge[] = [
      { id: 'e1', from: ax(0, 0).id, to: 'w' }, { id: 'e2', from: 'w', to: ax(1, 0).id },
    ];
    const out = stepCellEdge(nodes, edges, [storey.id], 'y', 0, 0, 600);
    expect(byId(out.nodes, storey.id).properties.axesY).toEqual([0, 600, 4000, 8000]);
    expect(byId(out.nodes, ax(0, 0).id).properties.gridY).toBe(1);
    expect(byId(out.nodes, ax(1, 0).id).properties.gridY).toBe(1);
    expect(out.nodes.filter((n) => n.type === 'wall')).toHaveLength(1);
    expect(out.edges).toBe(edges);
  });

  it('a run in the middle splits BOTH corners and closes each with its own wall', () => {
    const s = buildStoreyNodes('P', 0, 3000, [0, 4000, 8000, 12000], YS, 0);
    const storey = s[0];
    const ax = (gx: number, gy: number) =>
      s.find((n) => n.type === 'ax' && n.properties.gridX === gx && n.properties.gridY === gy)!;
    const wall = (id: string, a: BubbleGraphNode, b: BubbleGraphNode): BubbleGraphNode => ({
      id, type: 'wall', name: 'Wall', x: (a.x + b.x) / 2, y: a.y, z: 0, parentId: storey.id, properties: {},
    });
    const nodes = [...s, wall('wA', ax(0, 0), ax(1, 0)), wall('wB', ax(1, 0), ax(2, 0)), wall('wC', ax(2, 0), ax(3, 0))];
    const edges: BubbleGraphEdge[] = [
      { id: 'a1', from: ax(0, 0).id, to: 'wA' }, { id: 'a2', from: 'wA', to: ax(1, 0).id },
      { id: 'b1', from: ax(1, 0).id, to: 'wB' }, { id: 'b2', from: 'wB', to: ax(2, 0).id },
      { id: 'c1', from: ax(2, 0).id, to: 'wC' }, { id: 'c2', from: 'wC', to: ax(3, 0).id },
    ];
    const out = stepCellEdge(nodes, edges, [storey.id], 'y', 0, 1, -900);
    // Both ends of the middle bay kept their point on A and gained one below.
    expect(out.nodes.filter((n) => n.type === 'ax' && n.properties.gridY === 0)).toHaveLength(2);
    expect(byId(out.nodes, ax(1, 0).id).properties.gridY).toBe(1);
    expect(byId(out.nodes, ax(2, 0).id).properties.gridY).toBe(1);
    expect(out.nodes.filter((n) => n.type === 'wall')).toHaveLength(5);   // wA, wB, wC + two jogs
  });

  it('is a no-op inside the dead zone and cannot land on an existing axis', () => {
    const { nodes, edges, storey } = envelope();
    const tiny = stepCellEdge(nodes, edges, [storey.id], 'y', 0, 1, 40);
    expect(tiny.nodes).toBe(nodes);
    expect(tiny.edges).toBe(edges);
    // Clamped to the neighbour, 4000 is already an axis → nothing to insert.
    const onto = stepCellEdge(nodes, edges, [storey.id], 'y', 0, 1, 4000);
    expect(byId(onto.nodes, storey.id).properties.axesY).toEqual([0, 3900, 4000, 8000]);
  });

  it('the linked scope needs the run to exist on the other storey too', () => {
    const a = envelope(), b = envelope();
    const nodes = [...a.nodes, ...b.nodes];
    const edit = { kind: 'stepCellEdge', storeyId: a.storey.id, axis: 'y', index: 0, cell: 1, deltaMm: -800, scope: 'linked' } as const;
    expect(resolveScope(nodes, edit)).toEqual([a.storey.id, b.storey.id]);
    const stripped = nodes.filter((n) => !(n.parentId === b.storey.id && n.properties.gridX === 2 && n.properties.gridY === 0));
    expect(resolveScope(stripped, edit)).toEqual([a.storey.id]);
  });
});
