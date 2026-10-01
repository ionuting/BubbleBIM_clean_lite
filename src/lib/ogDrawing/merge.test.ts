import { describe, it, expect } from 'vitest';
import { mergeOgCut } from './merge';
import type { DrawingShape } from '@/lib/drawingEngine';

const rect = (u0: number, v0: number, u1: number, v1: number) =>
  [{ u: u0, v: v0 }, { u: u1, v: v0 }, { u: u1, v: v1 }, { u: u0, v: v1 }];

const shape = (over: Partial<DrawingShape> = {}): DrawingShape => ({
  pts: rect(0, 0, 1000, 250),
  closed: true,
  hatch: 'none',
  fillColor: '#ddd',
  strokeColor: '#222',
  lineWeight: 'heavy-cut',
  depthMm: 0,
  nodeId: 'n',
  nodeType: 'wall',
  ...over,
});

const outlines = (out: DrawingShape[]) => out.filter((s) => s.fillColor === 'none');
const fills = (out: DrawingShape[]) => out.filter((s) => s.fillColor !== 'none');

describe('mergeOgCut — walls', () => {
  it('strokes the union once and leaves the faces their fill', () => {
    // Two walls meeting in a T: the seam is the stem's top edge.
    const chord = shape({ nodeId: 'chord', pts: rect(0, -125, 8000, 125) });
    const stem = shape({ nodeId: 'stem', pts: rect(3950, -3000, 4050, 125) });
    const out = mergeOgCut([chord, stem]);

    // One outline for both, and it has no pen-less gap in it.
    expect(outlines(out)).toHaveLength(1);
    expect(outlines(out)[0].strokeColor).toBe('#222');
    expect(outlines(out)[0].hatch).toBe('none');

    // Both faces survive, with their fill and without their own outline —
    // that is what stops the seam being drawn.
    expect(fills(out)).toHaveLength(2);
    for (const f of fills(out)) expect(f.strokeColor).toBe('none');
  });

  it('carries a hole in a wall face through the union', () => {
    // A wall cut above a doorway's head is a face with a hole. Unioned as a
    // solid it would fill the doorway in.
    const holed = shape({
      nodeId: 'w1', pts: rect(0, -125, 4000, 125),
      holes: [rect(1000, -125, 2000, 125)],
    });
    const other = shape({ nodeId: 'w2', pts: rect(4000, -125, 8000, 125) });
    const out = mergeOgCut([holed, other]);
    const ring = outlines(out)[0];
    // The union is split in two by the hole reaching both faces, so what
    // matters is that the doorway is not covered over.
    const covered = outlines(out).some((s) =>
      s.pts.every((p) => p.u >= 1000 && p.u <= 2000));
    expect(covered).toBe(false);
    expect(ring).toBeTruthy();
  });

  it('leaves a lone wall exactly as it was', () => {
    const one = shape();
    expect(mergeOgCut([one])).toEqual([one]);
  });

  it('does not merge what is not a cut wall', () => {
    const col = shape({ nodeType: 'column', nodeId: 'c', pts: rect(0, 0, 400, 400) });
    const wall = shape({ nodeId: 'w', pts: rect(400, 100, 4000, 350) });
    const out = mergeOgCut([col, wall]);
    // One wall and one column: nothing to union, so nothing is touched.
    expect(out).toEqual([col, wall]);
  });

  it('takes the pen most of the walls already use', () => {
    const out = mergeOgCut([
      shape({ nodeId: 'a', strokeColor: '#aaa', pts: rect(0, 0, 1000, 250) }),
      shape({ nodeId: 'b', strokeColor: '#aaa', pts: rect(1000, 0, 2000, 250) }),
      shape({ nodeId: 'c', strokeColor: '#f00', pts: rect(2000, 0, 3000, 250) }),
    ]);
    expect(outlines(out)[0].strokeColor).toBe('#aaa');
  });

  it('can be switched off', () => {
    const a = shape({ nodeId: 'a', pts: rect(0, 0, 1000, 250) });
    const b = shape({ nodeId: 'b', pts: rect(1000, 0, 2000, 250) });
    expect(mergeOgCut([a, b], { mergeWalls: false })).toEqual([a, b]);
  });
});

describe('mergeOgCut — openings', () => {
  const door = shape({ nodeType: 'door', nodeId: 'd', pts: rect(100, 0, 200, 250) });
  const win = shape({ nodeType: 'window', nodeId: 'wn', pts: rect(300, 0, 400, 250) });
  const wall = shape({ nodeId: 'w', pts: rect(0, 0, 1000, 250) });

  it('drops the real joinery so a symbol can stand in its place', () => {
    const out = mergeOgCut([wall, door, win]);
    expect(out.map((s) => s.nodeType)).not.toContain('door');
    expect(out.map((s) => s.nodeType)).not.toContain('window');
    expect(out.some((s) => s.nodeId === 'w')).toBe(true);
  });

  it('keeps it when asked to show the model as it is', () => {
    const out = mergeOgCut([wall, door, win], { hideOpeningSolids: false });
    expect(out.map((s) => s.nodeType)).toContain('door');
    expect(out.map((s) => s.nodeType)).toContain('window');
  });

  it('with both off, hands back exactly what it was given', () => {
    const input = [wall, door, win];
    expect(mergeOgCut(input, { mergeWalls: false, hideOpeningSolids: false }))
      .toEqual(input);
  });
});
