import { describe, expect, it } from 'vitest';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { computeSketch } from './index';
import { serialiseOutline } from './types';
import { setSketchRefs } from './rewire';

const storey: BubbleGraphNode = {
  id: 'st1', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};
const ax = (id: string, x: number, y: number): BubbleGraphNode =>
  ({ id, type: 'ax', name: id, x, y, z: 0, parentId: 'st1', properties: { bimX: x, bimY: y } });

function world(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[], id = 'sk') {
  const map = new Map(nodes.map((n) => [n.id, n]));
  return computeSketch(map.get(id)!, map, edges).intent.outline.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);
}

function scene(shape: 'poly' | 'rect' | 'circle') {
  const props: Record<string, unknown> = { op: 'extrude', height_mm: 500 };
  if (shape === 'poly') {
    props.outline = serialiseOutline([{ x: 1000, y: 1000 }, { x: 3000, y: 1500 }, { x: 2000, y: 4000 }]);
  } else if (shape === 'rect') {
    Object.assign(props, { shape: 'rect', shape_x_mm: 1000, shape_y_mm: 1000, shape_w_mm: 2000, shape_h_mm: 1000 });
  } else {
    Object.assign(props, { shape: 'circle', shape_x_mm: 1000, shape_y_mm: 1000, shape_r_mm: 600 });
  }
  const sk: BubbleGraphNode = { id: 'sk', type: 'sketch', name: 'S', x: 0, y: 0, z: 0, parentId: 'st1', properties: props };
  const wall: BubbleGraphNode = { id: 'w', type: 'wall', name: 'W', x: 0, y: 0, z: 0, parentId: 'st1', properties: {} };
  const nodes = [storey, ax('A', 5000, 3000), ax('B', 5000, 7000), ax('C', 0, 0), sk, wall];
  // An unrelated edge that must survive every rewire.
  const edges: BubbleGraphEdge[] = [{ id: 'e_w', from: 'w', to: 'A' }];
  return { nodes, edges };
}

describe('setSketchRefs', () => {
  it('a free contour does not move when it gains a reference', () => {
    const { nodes, edges } = scene('poly');
    const before = world(nodes, edges);
    const r = setSketchRefs(nodes, edges, 'sk', ['A', 'B']);
    expect(world(r.nodes, r.edges)).toEqual(before);
    // …and now it is really relative: the stored numbers changed.
    const sk = r.nodes.find((n) => n.id === 'sk')!;
    expect(sk.properties.outline).not.toBe(nodes.find((n) => n.id === 'sk')!.properties.outline);
  });

  it('…nor when it loses one, nor when the pair is swapped', () => {
    const { nodes, edges } = scene('poly');
    const before = world(nodes, edges);
    const a = setSketchRefs(nodes, edges, 'sk', ['A', 'B']);
    const b = setSketchRefs(a.nodes, a.edges, 'sk', ['B', 'A']);
    expect(world(b.nodes, b.edges)).toEqual(before);
    const c = setSketchRefs(b.nodes, b.edges, 'sk', []);
    expect(world(c.nodes, c.edges)).toEqual(before);
    expect(c.edges).toEqual(edges);
  });

  it('writes typed edges in order and keeps unrelated ones', () => {
    const { nodes, edges } = scene('poly');
    const r = setSketchRefs(nodes, edges, 'sk', ['B', 'A']);
    const refs = r.edges.filter((e) => e.from === 'sk');
    expect(refs.map((e) => e.to)).toEqual(['B', 'A']);
    expect(refs.every((e) => e.type === 'references')).toBe(true);
    expect(r.edges.some((e) => e.id === 'e_w')).toBe(true);
  });

  it('a circle keeps its centre and radius', () => {
    const { nodes, edges } = scene('circle');
    const r = setSketchRefs(nodes, edges, 'sk', ['A', 'B']);
    // The polygon's vertices are sampled from the frame's own angle zero, so
    // they rotate with the line — the circle they trace does not.
    const w = world(r.nodes, r.edges);
    const cx = w.reduce((a, p) => a + p[0], 0) / w.length;
    const cy = w.reduce((a, p) => a + p[1], 0) / w.length;
    expect(cx).toBeCloseTo(1000, 6);
    expect(cy).toBeCloseTo(1000, 6);
    // `world()` rounds to 0.01 mm, so the radius is exact to about that.
    for (const p of w) expect(Math.hypot(p[0] - 1000, p[1] - 1000)).toBeCloseTo(600, 1);
    expect(r.nodes.find((n) => n.id === 'sk')!.properties.shape_r_mm).toBe(600);
  });

  it('a rectangle keeps its corner and aligns to the line', () => {
    const { nodes, edges } = scene('rect');
    const r = setSketchRefs(nodes, edges, 'sk', ['A', 'B']); // line along +Y
    const w = world(r.nodes, r.edges);
    expect(w[0]).toEqual([1000, 1000]);
    // Width 2000 now runs along the line (+Y), depth 1000 to its left (−X).
    expect(w[1]).toEqual([1000, 3000]);
    expect(w[3]).toEqual([0, 1000]);
  });

  it('is a no-op — same array references — when the reference is unchanged', () => {
    const { nodes, edges } = scene('poly');
    const a = setSketchRefs(nodes, edges, 'sk', ['A']);
    const b = setSketchRefs(a.nodes, a.edges, 'sk', ['A']);
    expect(b.nodes).toBe(a.nodes);
    expect(b.edges).toBe(a.edges);
    expect(setSketchRefs(nodes, edges, 'sk', [])).toEqual({ nodes, edges });
  });

  it('ignores ids that are not anchors, duplicates, and anything past two', () => {
    const { nodes, edges } = scene('poly');
    const r = setSketchRefs(nodes, edges, 'sk', ['w', 'A', 'A', 'B', 'C']);
    expect(r.edges.filter((e) => e.from === 'sk').map((e) => e.to)).toEqual(['A', 'B']);
  });

  it('honours a mirror / offset already on the node when converting', () => {
    const { nodes, edges } = scene('poly');
    const sk = nodes.find((n) => n.id === 'sk')!;
    sk.properties.ref_mirror = 'True';
    sk.properties.ref_dx_mm = 250;
    const before = world(nodes, edges);
    const r = setSketchRefs(nodes, edges, 'sk', ['A', 'B']);
    expect(world(r.nodes, r.edges)).toEqual(before);
  });
});
