import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  DEFAULT_SHELL_ROLE, SHELL_ROLES, SHELL_ROLE_LABELS, cellsOfShell, envelopeMissing,
  parseShellRole, pointInPolygon, shellRegion, shellRole,
} from './region';

// A 10 × 6 m contour with two 3 × 2 m cells punched out of it:
//
//   D ───────────── C        contour  A B C D          60 m², perimeter 32 m
//   │  ┌──┐  ┌──┐  │         cell 1   P Q R S           6 m², perimeter 10 m
//   │  └──┘  └──┘  │         cell 2   T U V W           6 m², perimeter 10 m
//   A ───────────── B        plin = 60 − 12 = 48 m²
const storey: BubbleGraphNode = {
  id: 's1', type: 'storey', name: 'P', x: 0, y: 0, z: 0, parentId: null,
  properties: { bottomElevation: 0, topElevation: 3000 },
};
const ax = (id: string, x: number, y: number): BubbleGraphNode =>
  ({ id, type: 'ax', name: id, x, y, z: 0, parentId: 's1', properties: { bimX: x, bimY: y } });
const E = (from: string, to: string): BubbleGraphEdge => ({ id: `${from}-${to}`, from, to });

const contour = [ax('A', 0, 0), ax('B', 10000, 0), ax('C', 10000, 6000), ax('D', 0, 6000)];
const cell1 = [ax('P', 1000, 2000), ax('Q', 4000, 2000), ax('R', 4000, 4000), ax('S', 1000, 4000)];
const cell2 = [ax('T', 6000, 2000), ax('U', 9000, 2000), ax('V', 9000, 4000), ax('W', 6000, 4000)];

const shell = (props: Record<string, unknown> = {}): BubbleGraphNode =>
  ({ id: 'sh', type: 'shell', name: 'Shell', x: 0, y: 0, z: 0, parentId: 's1', properties: { height: 3000, thickness: 400, ...props } });
const cellNode = (id: string): BubbleGraphNode =>
  ({ id, type: 'cell', name: id, x: 0, y: 0, z: 0, parentId: 's1', properties: {} });

const nodes = (sh: BubbleGraphNode, withCells = true): BubbleGraphNode[] => [
  storey, ...contour, sh,
  ...(withCells ? [...cell1, ...cell2, cellNode('c1'), cellNode('c2')] : []),
];
const edges = (withCells = true): BubbleGraphEdge[] => [
  ...contour.map((a) => E('sh', a.id)),
  ...(withCells ? [
    ...cell1.map((a) => E('c1', a.id)),
    ...cell2.map((a) => E('c2', a.id)),
  ] : []),
];

describe('the contour and its cells', () => {
  const r = shellRegion(shell(), nodes(shell()), edges())!;

  it('reads the contour from the axis anchors', () => {
    expect(r.outer).toHaveLength(4);
    expect(r.grossAreaM2).toBeCloseTo(60, 6);
    expect(r.outerPerimeterM).toBeCloseTo(32, 6);
  });

  it('finds the cells inside it and treats them as holes', () => {
    expect(r.holeCount).toBe(2);
    expect(r.holeAreaM2).toBeCloseTo(12, 6);
    expect(r.holePerimeterM).toBeCloseTo(20, 6);
  });

  it('the PLIN is the contour minus the cells — the footing area', () => {
    expect(r.netSolidAreaM2).toBeCloseTo(48, 6);
  });

  it('the total edge length is the contour plus every cell', () => {
    expect(r.perimeterM).toBeCloseTo(52, 6);
  });

  it('faces come from perimeter × height, inside and outside separately', () => {
    expect(r.outerFaceAreaM2).toBeCloseTo(32 * 3, 6);
    expect(r.innerFaceAreaM2).toBeCloseTo(20 * 3, 6);
  });

  it('the band is the whole edge length × thickness', () => {
    expect(r.bandAreaM2).toBeCloseTo(52 * 0.4, 6);
  });

  it('a contour with no cells is solid throughout', () => {
    const bare = shellRegion(shell(), nodes(shell(), false), edges(false))!;
    expect(bare.holeCount).toBe(0);
    expect(bare.netSolidAreaM2).toBeCloseTo(60, 6);
    expect(bare.innerFaceAreaM2).toBe(0);
  });

  it('fewer than three anchors is not a region', () => {
    const lonely = shell();
    expect(shellRegion(lonely, [storey, contour[0], contour[1], lonely], [E('sh', 'A'), E('sh', 'B')])).toBeNull();
  });
});

describe('roles decide what the area and the volume mean', () => {
  const region = (role: string) => shellRegion(shell({ shell_role: role }), nodes(shell({ shell_role: role })), edges())!;

  it('an envelope is a band standing on the contour: area = façade, volume = band × height', () => {
    const r = region('envelope');
    expect(r.areaM2).toBeCloseTo(96, 6);            // 32 m × 3 m
    expect(r.volumeM3).toBeCloseTo(52 * 0.4 * 3, 6);
  });

  it('a foundation is the plin lying flat: area = plin, volume = plin × height', () => {
    const r = region('foundation');
    expect(r.areaM2).toBeCloseTo(48, 6);
    expect(r.volumeM3).toBeCloseTo(48 * 3, 6);
  });

  it('a beam grid reads the same way as a foundation', () => {
    expect(region('beam_grid').volumeM3).toBeCloseTo(region('foundation').volumeM3, 6);
  });

  it('the role is a closed vocabulary; anything else falls back to the default', () => {
    for (const r of SHELL_ROLES) {
      expect(parseShellRole(r)).toBe(r);
      expect(SHELL_ROLE_LABELS[r]).toBeTruthy();
    }
    expect(parseShellRole('radier')).toBeUndefined();
    expect(parseShellRole(42)).toBeUndefined();
    expect(shellRole(shell())).toBe(DEFAULT_SHELL_ROLE);
    expect(shellRole(shell({ shell_role: 'FOUNDATION' }))).toBe('foundation');
  });
});

describe('which cells belong to which shell', () => {
  const map = (ns: BubbleGraphNode[]) => new Map(ns.map((n) => [n.id, n]));

  it('wiring a cell to the shell is obeyed over geometry', () => {
    const sh = shell();
    const ns = nodes(sh);
    // Only c1 is wired; c2 sits inside but is deliberately not connected.
    const es = [...contour.map((a) => E('sh', a.id)), E('sh', 'c1'),
      ...cell1.map((a) => E('c1', a.id)), ...cell2.map((a) => E('c2', a.id))];
    const found = cellsOfShell(sh, ns, es, map(ns), [
      { x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 6000 }, { x: 0, y: 6000 },
    ]);
    expect(found.map((c) => c.id)).toEqual(['c1']);
  });

  it('with nothing wired, a cell counts when its centroid is inside the contour', () => {
    const sh = shell();
    const outside = [ax('X', 20000, 0), ax('Y', 23000, 0), ax('Z', 23000, 2000), ax('W2', 20000, 2000)];
    const ns = [...nodes(sh), ...outside, cellNode('far')];
    const es = [...edges(), ...outside.map((a) => E('far', a.id))];
    const found = cellsOfShell(sh, ns, es, map(ns), [
      { x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 6000 }, { x: 0, y: 6000 },
    ]);
    expect(found.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('point-in-polygon does what it says', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, sq)).toBe(false);
    expect(pointInPolygon({ x: 5, y: 5 }, sq.slice(0, 2))).toBe(false);
  });
});

describe('envelopeMissing', () => {
  it('flags a model that has walls but no envelope shell', () => {
    const wall: BubbleGraphNode = { id: 'w', type: 'wall', name: 'w', x: 0, y: 0, z: 0, properties: {} };
    expect(envelopeMissing([storey, wall])).toBe(true);
    expect(envelopeMissing([storey, wall, shell()])).toBe(false);
    expect(envelopeMissing([storey, wall, shell({ shell_role: 'foundation' })])).toBe(true);
    expect(envelopeMissing([storey])).toBe(false);
  });
});
