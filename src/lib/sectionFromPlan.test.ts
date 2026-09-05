import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  commitPlanCut,
  cutFromAxisLine,
  lookNormal,
  orthoConstrainCut,
  resolveSectionCut,
  sideOfLine,
} from './sectionFromPlan';

const storey: BubbleGraphNode = {
  id: 's1', type: 'storey', name: 'P', x: 0, y: 0, z: 0, parentId: null,
  properties: { bottomElevation: 0, topElevation: 3000, axesX: [0, 6000], axesY: [0, 4000] },
};
const section = (props: Record<string, unknown>): BubbleGraphNode => ({
  id: 'sec', type: 'section', name: 'S', x: 0, y: 0, z: 0, parentId: 's1', properties: props,
});
const line = { x1: -1000, y1: 2000, x2: 7000, y2: 2000 };

describe('resolveSectionCut', () => {
  it('reads the marker model: line, side, depth, clipping, vertical range', () => {
    const spec = resolveSectionCut(section({
      plan_cut: line, look_side: 'right', depth_mode: 'limited', cut_depth_mm: 2500,
      clip_to_marker: false, start_elevation_mm: -500, cut_height_mm: 4000,
    }), [storey], []);
    expect(spec).not.toBeNull();
    expect(spec!.line).toEqual(line);
    expect(spec!.lookSide).toBe('right');
    expect(spec!.depthMm).toBe(2500);
    expect(spec!.clipToMarker).toBe(false);
    expect(spec!.elevMin).toBe(-500);
    expect(spec!.elevMax).toBe(3500);
    expect(spec!.normal).toEqual({ x: 0, y: -1 });   // right of west→east is south
    expect(spec!.lengthMm).toBe(8000);
  });

  it('defaults: look left, limited 6000, clipped, storeys decide the range', () => {
    const spec = resolveSectionCut(section({ plan_cut: line }), [storey], [])!;
    expect(spec.lookSide).toBe('left');
    expect(spec.depthMode).toBe('limited');
    expect(spec.depthMm).toBe(6000);
    expect(spec.clipToMarker).toBe(true);
    expect(spec.elevMin).toBeNull();
    expect(spec.elevMax).toBeNull();
  });

  it('infinite and zero depth modes', () => {
    expect(resolveSectionCut(section({ plan_cut: line, depth_mode: 'infinite', cut_depth_mm: 100 }), [storey], [])!.depthMm)
      .toBe(Infinity);
    expect(resolveSectionCut(section({ plan_cut: line, depth_mode: 'zero', cut_depth_mm: 100 }), [storey], [])!.depthMm)
      .toBe(0);
  });

  it('legacy nodes: flipped means the other side, plane offset shifts the line', () => {
    const spec = resolveSectionCut(section({ plan_cut: line, flipped: true, cut_plane_offset_mm: 300 }), [storey], [])!;
    expect(spec.lookSide).toBe('right');
    expect(spec.line.y1).toBe(1700);   // 300 toward the viewed (south) side
    expect(spec.line.y2).toBe(1700);
  });

  it('ax-anchored markers take the line from the anchors, with legacy end offsets', () => {
    const a: BubbleGraphNode = { id: 'a', type: 'ax', name: 'a', x: 0, y: 0, z: 0, parentId: 's1', properties: { gridX: 0, gridY: 1 } };
    const b: BubbleGraphNode = { id: 'b', type: 'ax', name: 'b', x: 0, y: 0, z: 0, parentId: 's1', properties: { gridX: 1, gridY: 1 } };
    const edges: BubbleGraphEdge[] = [{ id: 'e1', from: 'sec', to: 'a' }, { id: 'e2', from: 'sec', to: 'b' }];
    const spec = resolveSectionCut(section({ offset_left_mm: 500, offset_right_mm: 250 }), [storey, a, b], edges)!;
    expect(spec.line).toEqual({ x1: -500, y1: 4000, x2: 6250, y2: 4000 });
  });

  it('returns null without a line', () => {
    expect(resolveSectionCut(section({}), [storey], [])).toBeNull();
    expect(resolveSectionCut(section({ plan_cut: { x1: 0, y1: 0, x2: 0, y2: 0 } }), [storey], [])).toBeNull();
  });
});

describe('marker helpers', () => {
  it('lookNormal: left of west→east is north', () => {
    expect(lookNormal(line, 'left')).toEqual({ x: -0, y: 1 });
    expect(lookNormal(line, 'right')).toEqual({ x: 0, y: -1 });
  });

  it('sideOfLine reports which side a click lands on', () => {
    expect(sideOfLine(line, { x: 3000, y: 3000 })).toBe('left');
    expect(sideOfLine(line, { x: 3000, y: 1000 })).toBe('right');
  });

  it('orthoConstrainCut keeps the first point and snaps the second; free keeps both', () => {
    const o = orthoConstrainCut({ x: 0, y: 100 }, { x: 5000, y: 400 });
    expect(o.cut).toEqual({ x1: 0, y1: 100, x2: 5000, y2: 100 });
    const v = orthoConstrainCut({ x: 100, y: 0 }, { x: 400, y: 5000 });
    expect(v.cut).toEqual({ x1: 100, y1: 0, x2: 100, y2: 5000 });
    expect(v.kind).toBe('section');   // never an elevation any more
    const f = orthoConstrainCut({ x: 0, y: 0 }, { x: 5000, y: 4000 }, true);
    expect(f.cut).toEqual({ x1: 0, y1: 0, x2: 5000, y2: 4000 });
  });

  it('cutFromAxisLine spans the grid with padding, always a section', () => {
    const b = { minX: 0, maxX: 6000, minY: 0, maxY: 4000 };
    expect(cutFromAxisLine('Y', 2000, b).cut).toEqual({ x1: -500, y1: 2000, x2: 6500, y2: 2000 });
    expect(cutFromAxisLine('X', 3000, b)).toEqual({ kind: 'section', cut: { x1: 3000, y1: -500, x2: 3000, y2: 4500 } });
  });

  it('commitPlanCut writes the marker model onto the new node', () => {
    const r = commitPlanCut({ nodes: [storey], edges: [], storeyId: 's1', cut: line, kind: 'section', lookSide: 'right' });
    const n = r.nodes.find((x) => x.id === r.sectionId)!;
    expect(n.type).toBe('section');
    expect(n.properties.look_side).toBe('right');
    expect(n.properties.depth_mode).toBe('limited');
    expect(n.properties.clip_to_marker).toBe(true);
    expect(n.properties.plan_cut).toEqual(line);
    expect(n.properties).not.toHaveProperty('flipped');
    expect(n.properties).not.toHaveProperty('cut_plane_offset_mm');
  });
});
