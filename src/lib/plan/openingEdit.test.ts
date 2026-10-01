import { describe, it, expect } from 'vitest';
import {
  canFlipHinge, clampOpening, dragOpeningDistance, flipHinge, flipSide, moveOpening,
  openingClearances, patchOpening, snapMm,
} from './openingEdit';
import { storeyOpeningFrames, inlineOpeningRef, type OpeningFrame } from './openingSymbols';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';

const storey: BubbleGraphNode = {
  id: 'st', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};
const ax = (id: string, x: number, y: number): BubbleGraphNode => ({
  id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
  properties: { bimX: x, bimY: y, has_column: 'False' },
});

/** A 5 m wall with a door NODE at 1200 and an inline window centred. */
function scene() {
  const nodes: BubbleGraphNode[] = [
    storey, ax('a', 0, 0), ax('b', 5000, 0),
    {
      id: 'w', type: 'wall', name: 'w', x: 0, y: 0, z: 0, parentId: 'st',
      properties: {
        wall_type: 'W25',
        has_windows: 'True',
        windows: JSON.stringify([{ window_type: 'W-FIX-100x120', wall_offset: 3000 }]),
      },
    },
    {
      id: 'd', type: 'door', name: 'd', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { door_type: 'D-SWING-90x210', swing: 'left', offset: 1200 },
    },
  ];
  const edges: BubbleGraphEdge[] = [
    { id: 'e0', from: 'w', to: 'a' }, { id: 'e1', from: 'w', to: 'b' }, { id: 'e2', from: 'd', to: 'w' },
  ];
  return { nodes, edges };
}

const frameOf = (nodes: BubbleGraphNode[], edges: BubbleGraphEdge[], kind: 'door' | 'window'): OpeningFrame => {
  const f = storeyOpeningFrames(nodes, edges, 'st').find((x) => x.kind === kind);
  if (!f) throw new Error(`no ${kind}`);
  return f;
};

describe('the frame knows where it is on the wall', () => {
  it('reads the door node\'s offset and the wall\'s length', () => {
    const { nodes, edges } = scene();
    const f = frameOf(nodes, edges, 'door');
    expect(f.distFromStartMm).toBeCloseTo(1200, 3);
    expect(f.wallLenMm).toBeCloseTo(5000, 3);
    expect(f.inline).toBeUndefined();
    expect(f.grouped).toBe(false);
    // The wall's ends bracket the opening along `along`.
    const t = (p: { x: number; y: number }) => (p.x - f.wallStart.x) * f.along.x + (p.y - f.wallStart.y) * f.along.y;
    expect(t(f.origin)).toBeCloseTo(1200, 3);
    expect(t(f.wallEnd)).toBeCloseTo(5000, 3);
  });

  it('points an inline window back at its entry', () => {
    const { nodes, edges } = scene();
    const f = frameOf(nodes, edges, 'window');
    expect(f.inline).toEqual({ key: 'windows', index: 0 });
    expect(f.distFromStartMm).toBeCloseTo(3000, 3);
  });

  it('resolves an entry by its own id as well as by position', () => {
    const wall: BubbleGraphNode = {
      id: 'w', type: 'wall', name: 'w', x: 0, y: 0, z: 0,
      properties: { doors: JSON.stringify([{ id: 'front' }, {}]) },
    };
    const byId: BubbleGraphNode = { id: 'front', type: 'door', name: '', x: 0, y: 0, z: 0, properties: {} };
    const byIdx: BubbleGraphNode = { id: 'inl_door_w_1', type: 'door', name: '', x: 0, y: 0, z: 0, properties: {} };
    const gone: BubbleGraphNode = { id: 'inl_door_w_7', type: 'door', name: '', x: 0, y: 0, z: 0, properties: {} };
    expect(inlineOpeningRef(wall, byId)).toEqual({ key: 'doors', index: 0 });
    expect(inlineOpeningRef(wall, byIdx)).toEqual({ key: 'doors', index: 1 });
    expect(inlineOpeningRef(wall, gone)).toBeNull();
  });
});

describe('snapping and clamping', () => {
  it('rounds to the step and stays inside the wall', () => {
    expect(snapMm(1234)).toBe(1230);
    expect(snapMm(1235)).toBe(1240);
    expect(snapMm(1234, 1)).toBe(1234);
    expect(clampOpening(-50, 900, 5000)).toBe(0);
    expect(clampOpening(4500, 900, 5000)).toBe(4100);
    expect(clampOpening(2000, 900, 5000)).toBe(2000);
    // A wall narrower than the opening pins it at the start.
    expect(clampOpening(300, 900, 800)).toBe(0);
  });

  it('projects the pointer\'s travel onto the wall', () => {
    const { nodes, edges } = scene();
    const f = frameOf(nodes, edges, 'door');
    // Moving mostly across the wall changes nothing along it.
    expect(dragOpeningDistance(f, { x: 0, y: 0 }, { x: 4, y: 900 })).toBe(1200);
    // 333 along → 1533 → snapped 1530.
    expect(dragOpeningDistance(f, { x: 0, y: 0 }, { x: f.along.x * 333, y: f.along.y * 333 })).toBe(1530);
    // Shift-fine: 1 mm.
    expect(dragOpeningDistance(f, { x: 0, y: 0 }, { x: f.along.x * 333, y: f.along.y * 333 }, 1)).toBe(1533);
    // Past the end: clamped so the door stays in the wall.
    expect(dragOpeningDistance(f, { x: 0, y: 0 }, { x: f.along.x * 9000, y: f.along.y * 9000 })).toBe(5000 - f.widthMm);
    expect(openingClearances(f, 1530)).toEqual({ start: 1530, end: 5000 - 1530 - f.widthMm });
  });
});

describe('writing back', () => {
  it('moves a door node by its offset property', () => {
    const { nodes, edges } = scene();
    const f = frameOf(nodes, edges, 'door');
    const out = moveOpening(nodes, f, 2000);
    expect(out).not.toBe(nodes);
    expect(out.find((n) => n.id === 'd')?.properties.offset).toBe(2000);
    // And the wall was not touched.
    expect(out.find((n) => n.id === 'w')).toBe(nodes.find((n) => n.id === 'w'));
    // Re-reading the plan sees it there.
    expect(frameOf(out, edges, 'door').distFromStartMm).toBeCloseTo(2000, 3);
  });

  it('moves an inline window inside the wall\'s list', () => {
    const { nodes, edges } = scene();
    const f = frameOf(nodes, edges, 'window');
    const out = moveOpening(nodes, f, 500);
    const wall = out.find((n) => n.id === 'w')!;
    expect(JSON.parse(String(wall.properties.windows))).toEqual([{ window_type: 'W-FIX-100x120', wall_offset: 500 }]);
    expect(frameOf(out, edges, 'window').distFromStartMm).toBeCloseTo(500, 3);
  });

  it('is a no-op for the same place and for an unknown opening', () => {
    const { nodes, edges } = scene();
    const f = frameOf(nodes, edges, 'door');
    expect(moveOpening(nodes, f, 1200)).toBe(nodes);
    expect(patchOpening(nodes, { ...f, node: { ...f.node, id: 'ghost' } }, { offset: 1 })).toBe(nodes);
  });

  it('turns a door round, both ways', () => {
    const { nodes, edges } = scene();
    const f = frameOf(nodes, edges, 'door');
    expect(canFlipHinge(f)).toBe(true);
    const hinged = flipHinge(nodes, f);
    expect(hinged.find((n) => n.id === 'd')?.properties.swing).toBe('right');
    expect(flipHinge(hinged, frameOf(hinged, edges, 'door')).find((n) => n.id === 'd')?.properties.swing).toBe('left');

    const sided = flipSide(nodes, f);
    expect(sided.find((n) => n.id === 'd')?.properties.flip_across).toBe(true);
    const back = flipSide(sided, frameOf(sided, edges, 'door'));
    expect(back.find((n) => n.id === 'd')?.properties.flip_across).toBe(false);
    // The frame follows: the origin moves to the other face.
    expect(frameOf(sided, edges, 'door').origin.y).toBeCloseTo(-f.origin.y, 3);
  });

  it('has no hinge to flip on a slider or a window', () => {
    const { nodes, edges } = scene();
    const win = frameOf(nodes, edges, 'window');
    expect(canFlipHinge(win)).toBe(false);
    expect(flipHinge(nodes, win)).toBe(nodes);
    const sliding = nodes.map((n) => (n.id === 'd' ? { ...n, properties: { ...n.properties, swing: 'sliding' } } : n));
    const f = frameOf(sliding, edges, 'door');
    expect(canFlipHinge(f)).toBe(false);
    expect(flipHinge(sliding, f)).toBe(sliding);
  });
});
