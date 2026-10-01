/**
 * What has to hold for a sketch drawn against a reference.
 *
 * The contract is "same numbers, moved origin": an unwired sketch reads
 * exactly as before, a wired one follows its ax, and `worldToLocal` is the
 * exact inverse of `localToWorld` under every combination of mirror, turn and
 * slide — because the plan's drag handles round-trip through both, and any
 * drift there would make a dragged corner creep.
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { computeSketch } from './index';
import { serialiseOutline } from './types';
import { arrayStep } from './build';
import {
  IDENTITY_FRAME, IDENTITY_TRANSFORM, frameAngleDeg, localToWorld, outlineToWorld,
  resolveSketchFrame, worldToLocal, type SketchFrame, type SketchTransform,
} from './frame';

const storey: BubbleGraphNode = {
  id: 'st1', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};
const ax = (id: string, x: number, y: number): BubbleGraphNode =>
  ({ id, type: 'ax', name: id, x, y, z: 0, parentId: 'st1', properties: { bimX: x, bimY: y } });
const RECT: [number, number][] = [[0, 0], [2000, 0], [2000, 1000], [0, 1000]];

function scene(refs: string[], props: Record<string, unknown> = {}) {
  const a = ax('A', 5000, 3000);
  const b = ax('B', 5000, 7000); // straight up from A: the line runs along +Y
  const node: BubbleGraphNode = {
    id: 'sk', type: 'sketch', name: 'S', x: 0, y: 0, z: 0, parentId: 'st1',
    properties: {
      outline: serialiseOutline(RECT.map(([x, y]) => ({ x, y }))),
      op: 'extrude', height_mm: 500, ...props,
    },
  };
  const map = new Map([[storey.id, storey], [a.id, a], [b.id, b], [node.id, node]]);
  const edges: BubbleGraphEdge[] = refs.map((r, i) => ({ id: `e${i}`, from: 'sk', to: r }));
  return { node, map, edges };
}

describe('resolveSketchFrame', () => {
  it('is the identity with no reference — an unwired sketch reads as before', () => {
    const { node, map, edges } = scene([]);
    expect(resolveSketchFrame(node, map, edges).frame).toEqual(IDENTITY_FRAME);
  });

  it('one ax gives an origin and keeps the line along BIM X', () => {
    const { node, map, edges } = scene(['A']);
    const { frame } = resolveSketchFrame(node, map, edges);
    expect(frame.origin).toEqual({ x: 5000, y: 3000 });
    expect(frame.dir).toEqual({ x: 1, y: 0 });
    expect(frame.refLengthMm).toBe(0);
  });

  it('two axes give origin, unit direction and the line length', () => {
    const { node, map, edges } = scene(['A', 'B']);
    const { frame } = resolveSketchFrame(node, map, edges);
    expect(frame.dir.x).toBeCloseTo(0, 12);
    expect(frame.dir.y).toBeCloseTo(1, 12);
    expect(frame.refLengthMm).toBe(4000);
    expect(frameAngleDeg(frame)).toBeCloseTo(90, 9);
  });

  it('a degenerate pair keeps the origin, drops the direction and says so', () => {
    const { node, map, edges } = scene(['A', 'B']);
    map.set('B', ax('B', 5000, 3000.2));
    const { frame, diagnostics } = resolveSketchFrame(node, map, edges);
    expect(frame.dir).toEqual({ x: 1, y: 0 });
    expect(diagnostics.map((d) => d.code)).toContain('SKETCH_REF_DEGENERATE');
  });

  it('a third ax is ignored with a note — a sketch has one line, not a polygon', () => {
    const { node, map, edges } = scene(['A', 'B']);
    map.set('C', ax('C', 9000, 9000));
    edges.push({ id: 'e2', from: 'C', to: 'sk' });
    const { frame, diagnostics } = resolveSketchFrame(node, map, edges);
    expect(frame.refIds).toEqual(['A', 'B']);
    expect(diagnostics.map((d) => d.code)).toContain('SKETCH_REF_EXTRA');
  });
});

describe('localToWorld / worldToLocal', () => {
  const frame: SketchFrame = {
    origin: { x: 1000, y: 2000 },
    dir: { x: Math.SQRT1_2, y: Math.SQRT1_2 }, // 45°
    refIds: ['A', 'B'],
    refLengthMm: 5000,
  };

  it('the identity frame and transform change nothing', () => {
    expect(localToWorld(IDENTITY_FRAME, IDENTITY_TRANSFORM, { x: 12, y: -7 })).toEqual({ x: 12, y: -7 });
  });

  it('local +u runs along the line and local +v to its left', () => {
    const u = localToWorld(frame, IDENTITY_TRANSFORM, { x: 1000, y: 0 });
    expect(u.x).toBeCloseTo(1000 + 1000 * Math.SQRT1_2, 9);
    expect(u.y).toBeCloseTo(2000 + 1000 * Math.SQRT1_2, 9);
    const v = localToWorld(frame, IDENTITY_TRANSFORM, { x: 0, y: 1000 });
    // Left of a 45° line is the 135° direction.
    expect(v.x).toBeCloseTo(1000 - 1000 * Math.SQRT1_2, 9);
    expect(v.y).toBeCloseTo(2000 + 1000 * Math.SQRT1_2, 9);
  });

  it('a mirror flips across the line, a slide moves along and across it', () => {
    const t: SketchTransform = { dxMm: 0, dyMm: 0, rotDeg: 0, mirror: true };
    const p = localToWorld(frame, t, { x: 0, y: 1000 });
    const q = localToWorld(frame, IDENTITY_TRANSFORM, { x: 0, y: -1000 });
    expect(p.x).toBeCloseTo(q.x, 9);
    expect(p.y).toBeCloseTo(q.y, 9);

    const s: SketchTransform = { dxMm: 300, dyMm: -200, rotDeg: 0, mirror: false };
    const o = localToWorld(frame, s, { x: 0, y: 0 });
    const expected = localToWorld(frame, IDENTITY_TRANSFORM, { x: 300, y: -200 });
    expect(o.x).toBeCloseTo(expected.x, 9);
    expect(o.y).toBeCloseTo(expected.y, 9);
  });

  it('mirror happens before the rotation, so "flipped, turned 30°" is one thing', () => {
    const mr: SketchTransform = { dxMm: 0, dyMm: 0, rotDeg: 30, mirror: true };
    const p = localToWorld(IDENTITY_FRAME, mr, { x: 1000, y: 200 });
    // Flip first: (1000, −200); then turn 30°.
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    expect(p.x).toBeCloseTo(1000 * c + 200 * s, 9);
    expect(p.y).toBeCloseTo(1000 * s - 200 * c, 9);
  });

  it('worldToLocal is the exact inverse, whatever the transform', () => {
    const cases: SketchTransform[] = [
      IDENTITY_TRANSFORM,
      { dxMm: 250, dyMm: -80, rotDeg: 0, mirror: false },
      { dxMm: 0, dyMm: 0, rotDeg: 37, mirror: false },
      { dxMm: 0, dyMm: 0, rotDeg: 0, mirror: true },
      { dxMm: -400, dyMm: 900, rotDeg: -122, mirror: true },
    ];
    const pts = [{ x: 0, y: 0 }, { x: 1234.5, y: -678.9 }, { x: -50, y: 50 }];
    for (const t of cases) for (const p of pts) {
      const back = worldToLocal(frame, t, localToWorld(frame, t, p));
      expect(back.x).toBeCloseTo(p.x, 8);
      expect(back.y).toBeCloseTo(p.y, 8);
    }
  });
});

describe('computeSketch with a reference', () => {
  it('an unwired sketch is byte-for-byte what it was', () => {
    const { node, map, edges } = scene([]);
    const r = computeSketch(node, map, edges);
    expect(r.frame).toEqual(IDENTITY_FRAME);
    expect(r.intent.outline.map((p) => [p.x, p.y])).toEqual(RECT);
    expect(r.volumeMm3).toBeCloseTo(2000 * 1000 * 500, 3);
  });

  it('wired to one ax, the drawn numbers become offsets from it', () => {
    const { node, map, edges } = scene(['A']);
    const r = computeSketch(node, map, edges);
    expect(r.intent.outline[0]).toEqual({ x: 5000, y: 3000 });
    expect(r.intent.outline[2]).toEqual({ x: 7000, y: 4000 });
    // The stored points are untouched.
    expect(r.intent.localOutline[2]).toEqual({ x: 2000, y: 1000 });
  });

  it('moving the ax moves the sketch — that is the whole point', () => {
    const { node, map, edges } = scene(['A']);
    map.set('A', ax('A', 6000, 3000));
    const r = computeSketch(node, map, edges);
    expect(r.intent.outline[0]).toEqual({ x: 6000, y: 3000 });
    expect(r.volumeMm3).toBeCloseTo(2000 * 1000 * 500, 3);
  });

  it('wired to two axes, the sketch turns with the line', () => {
    const { node, map, edges } = scene(['A', 'B']); // line along +Y
    const r = computeSketch(node, map, edges);
    // Local (2000, 0) — along the line — lands 2000 up from A.
    expect(r.intent.outline[1].x).toBeCloseTo(5000, 9);
    expect(r.intent.outline[1].y).toBeCloseTo(5000, 9);
    // Local (0, 1000) — left of +Y is −X.
    expect(r.intent.outline[3].x).toBeCloseTo(4000, 9);
    expect(r.intent.outline[3].y).toBeCloseTo(3000, 9);
    expect(r.volumeMm3).toBeCloseTo(2000 * 1000 * 500, 3);
  });

  it('a mirrored sketch still comes out with outward faces', () => {
    const { node, map, edges } = scene(['A', 'B'], { ref_mirror: 'True' });
    const r = computeSketch(node, map, edges);
    expect(r.volumeMm3).toBeGreaterThan(0);
    expect(r.volumeMm3).toBeCloseTo(2000 * 1000 * 500, 3);
    // Mirrored across a +Y line, local +v (= −X) becomes +X.
    expect(r.intent.outline[3].x).toBeCloseTo(6000, 9);
  });

  it('ref_dx / ref_dy / ref_rot are read off the node', () => {
    const { node, map, edges } = scene(['A'], { ref_dx_mm: 100, ref_dy_mm: 200, ref_rot_deg: 90 });
    const r = computeSketch(node, map, edges);
    // (2000, 0) turned 90° is (0, 2000); slid by (100, 200); from A.
    expect(r.intent.outline[1].x).toBeCloseTo(5100, 9);
    expect(r.intent.outline[1].y).toBeCloseTo(5200, 9);
  });
});

describe('array along the reference line', () => {
  it('steps along the line by stepMm', () => {
    const { node, map, edges } = scene(['A', 'B'], { array_count: 3, array_along: 'ref', array_step_mm: 1500 });
    const r = computeSketch(node, map, edges);
    expect(r.count).toBe(3);
    expect(r.copies[2].dxMm).toBeCloseTo(0, 9);
    expect(r.copies[2].dyMm).toBeCloseTo(3000, 9);
  });

  it('fit spreads the copies so the last one lands on the second ax', () => {
    const { node, map, edges } = scene(['A', 'B'], { array_count: 5, array_along: 'ref', array_fit: 'True' });
    const r = computeSketch(node, map, edges);
    expect(r.copies.map((c) => Math.round(c.dyMm))).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it('fit with one copy is no array at all', () => {
    const frame: SketchFrame = { origin: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, refIds: ['A', 'B'], refLengthMm: 4000 };
    const s = arrayStep({ count: 1, dxMm: 0, dyMm: 0, dzMm: 0, along: 'ref', stepMm: 0, fit: true }, frame);
    expect(s).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('keeps the vertical part of the vector, so a run along a line can still climb', () => {
    const frame: SketchFrame = { origin: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, refIds: ['A', 'B'], refLengthMm: 4000 };
    const s = arrayStep({ count: 3, dxMm: 999, dyMm: 999, dzMm: 300, along: 'ref', stepMm: 1000, fit: false }, frame);
    expect(s).toEqual({ x: 1000, y: 0, z: 300 });
  });

  it('without a line to follow, "ref" degrades to the vector and says so', () => {
    const { node, map, edges } = scene(['A'], { array_count: 2, array_along: 'ref', array_step_mm: 1500, array_dx_mm: 700 });
    const r = computeSketch(node, map, edges);
    expect(r.copies[1].dxMm).toBe(700);
    expect(r.diagnostics.map((d) => d.code)).toContain('SKETCH_ARRAY_NO_REF_LINE');
  });
});

describe('outlineToWorld', () => {
  it('maps every point through the same transform', () => {
    const pts = outlineToWorld(IDENTITY_FRAME, { dxMm: 10, dyMm: 20, rotDeg: 0, mirror: false }, [{ x: 0, y: 0 }, { x: 5, y: 5 }]);
    expect(pts).toEqual([{ x: 10, y: 20 }, { x: 15, y: 25 }]);
  });
});
