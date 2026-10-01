import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { calcWallGeometry, calcWallJoins, getAxRealPos, getNodeWallThickness, parseWallThickness, MM } from './bimGeometry';

/** storey 0–3000mm + two ax + a wall wired between them. */
function scene(wallProps: Record<string, unknown>) {
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'S', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const a: BubbleGraphNode = { id: 'a', type: 'ax', name: 'a', x: 0, y: 0, z: 0, parentId: 'st', properties: { bimX: 0, bimY: 0 } };
  const b: BubbleGraphNode = { id: 'b', type: 'ax', name: 'b', x: 5000, y: 0, z: 0, parentId: 'st', properties: { bimX: 5000, bimY: 0 } };
  const wall: BubbleGraphNode = { id: 'w', type: 'wall', name: 'W', x: 2500, y: 0, z: 0, parentId: 'st', properties: wallProps };
  const nodeMap = new Map<string, BubbleGraphNode>([[storey.id, storey], [a.id, a], [b.id, b], [wall.id, wall]]);
  const edges: BubbleGraphEdge[] = [
    { id: 'e1', from: 'w', to: 'a' },
    { id: 'e2', from: 'w', to: 'b' },
  ];
  return { wall, nodeMap, edges };
}

describe('wall height vs ring beam', () => {
  it('no beam → wall spans the full storey height', () => {
    const { wall, nodeMap, edges } = scene({ wall_type: 'W20' });
    const g = calcWallGeometry(wall, nodeMap, edges)!;
    expect(g.wallH).toBe(3000);
    expect(g.beamDesc).toBeUndefined();
  });

  it('with beam → masonry height = storey − beam, and they meet exactly', () => {
    const { wall, nodeMap, edges } = scene({ wall_type: 'W20', has_beam: 'True', beam_section: 'B20x30' });
    const g = calcWallGeometry(wall, nodeMap, edges)!;
    // B20x30 → beam height 30cm = 300mm.
    expect(g.wallH).toBe(2700);
    expect(g.beamDesc).toBeDefined();
    expect(g.beamDesc!.height).toBeCloseTo(0.30, 6);
    // Wall top (botM + wallH) meets beam bottom (baseY) with no overlap/gap.
    const wallTopM = g.botM + g.wallH * MM;
    expect(wallTopM).toBeCloseTo(g.beamDesc!.baseY, 6);
    // Beam top reaches the storey top (3.0 m).
    expect(g.beamDesc!.baseY + g.beamDesc!.height).toBeCloseTo(3.0, 6);
  });

  it('explicit height overrides the beam-derived height', () => {
    const { wall, nodeMap, edges } = scene({ wall_type: 'W20', has_beam: 'True', beam_section: 'B20x30', height: 2500 });
    const g = calcWallGeometry(wall, nodeMap, edges)!;
    expect(g.wallH).toBe(2500);
    expect(g.beamDesc).toBeDefined();
  });
});

describe('getAxRealPos — grid offsets', () => {
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'S', x: 0, y: 0, z: 0,
    properties: { axesX: [0, 5000, 10000], axesY: [0, 4000] },
  };
  const grid = (props: Record<string, unknown>): BubbleGraphNode =>
    ({ id: 'g', type: 'ax', name: 'g', x: 0, y: 0, z: 0, parentId: 'st', properties: props });
  const map = (n: BubbleGraphNode) => new Map<string, BubbleGraphNode>([[storey.id, storey], [n.id, n]]);

  it('adds ax_dx_mm / ax_dy_mm to the grid value', () => {
    const n = grid({ gridX: 1, gridY: 1, ax_dx_mm: 500, ax_dy_mm: -250 });
    expect(getAxRealPos(n, map(n))).toEqual({ x: 5500, y: 3750 });
  });

  it('bimX/bimY still win over grid + offset', () => {
    const n = grid({ gridX: 1, gridY: 1, ax_dx_mm: 500, bimX: 123, bimY: 456 });
    expect(getAxRealPos(n, map(n))).toEqual({ x: 123, y: 456 });
  });

  it('does not sort the stored axes in place', () => {
    const s: BubbleGraphNode = { ...storey, properties: { axesX: [10000, 0, 5000], axesY: [4000, 0] } };
    const n = grid({ gridX: 1, gridY: 1 });
    expect(getAxRealPos(n, new Map([[s.id, s], [n.id, n]]))).toEqual({ x: 5000, y: 4000 });
    expect(s.properties.axesX).toEqual([10000, 0, 5000]);
  });
});

describe('getNodeWallThickness — custom thicknesses', () => {
  const wall = (properties: Record<string, unknown>): BubbleGraphNode =>
    ({ id: 'w1', type: 'wall', name: 'W', x: 0, y: 0, z: 0, properties } as BubbleGraphNode);

  it('falls back to the type when nothing custom is set', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'W25' }))).toBeCloseTo(0.25, 6);
    expect(getNodeWallThickness(wall({}))).toBeCloseTo(0.20, 6);
  });

  it('A 60 cm WALL: the custom value wins over the type', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'W25', wall_custom_mm: 600 }))).toBeCloseTo(0.6, 6);
  });

  it('there is no upper bound — a retaining wall can be a metre thick', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'W20', wall_custom_mm: 1000 }))).toBeCloseTo(1.0, 6);
  });

  it('zero or negative means "not set" — it never collapses the wall', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'W25', wall_custom_mm: 0 }))).toBeCloseTo(0.25, 6);
    expect(getNodeWallThickness(wall({ wall_type: 'W25', wall_custom_mm: -5 }))).toBeCloseTo(0.25, 6);
    expect(getNodeWallThickness(wall({ wall_type: 'W25', wall_custom_mm: 'gros' }))).toBeCloseTo(0.25, 6);
  });

  it('a separator stays a separator — a custom thickness cannot give it a body', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'separator', wall_custom_mm: 600 })))
      .toBeCloseTo(parseWallThickness('separator'), 6);
  });

  it('timber and CLT types keep resolving through the library', () => {
    expect(getNodeWallThickness(wall({ wall_type: 'TF25' }))).toBeCloseTo(0.25, 6);
    expect(getNodeWallThickness(wall({ wall_type: 'CLT120' }))).toBeCloseTo(0.12, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('calcWallJoins — a mitre is the angle bisector', () => {
  // Four W25 walls around a 5000 x 4000 rectangle: the ordinary case, and the
  // one the old tie-break got wrong. Picking the nearest of the four face-line
  // crossings is undefined when all four sit the same distance from the
  // junction, which is exactly what equal thicknesses at a right angle give —
  // so both walls were cut square and left an uncovered notch the size of the
  // corner in the plan, the sections and the 3D.
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'S', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const ax = (id: string, x: number, y: number): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y, has_column: 'False' },
  });
  const wallNode = (id: string, props: Record<string, unknown> = {}): BubbleGraphNode => ({
    id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
    properties: { wall_type: 'W25', ...props },
  });

  function room() {
    let k = 0;
    const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `j${k++}`, from, to });
    const nodes: BubbleGraphNode[] = [
      storey,
      ax('c0', 0, 0), ax('c1', 5000, 0), ax('c2', 5000, 4000), ax('c3', 0, 4000),
      wallNode('south'), wallNode('east'), wallNode('north'), wallNode('west'),
    ];
    const edges: BubbleGraphEdge[] = [
      wire('south', 'c0'), wire('south', 'c1'),
      wire('east', 'c1'), wire('east', 'c2'),
      wire('north', 'c2'), wire('north', 'c3'),
      wire('west', 'c3'), wire('west', 'c0'),
    ];
    return { nodes, edges };
  }

  it('cuts the corner on the diagonal, not square across the wall', () => {
    const { nodes, edges } = room();
    const south = calcWallJoins(nodes, edges).get('south')!;
    expect(south.startJoin).toBe('miter');
    // The bisector of (1,0) and (0,1) is y = x, so the two face corners sit on
    // opposite sides of the centre-line AND at opposite ends of the overlap.
    expect(south.outerStartPt).toEqual({ x: 125, y: 125 });
    expect(south.innerStartPt).toEqual({ x: -125, y: -125 });
    // Square across would put both at the same x — the bug this replaced.
    expect(south.outerStartPt.x).not.toBeCloseTo(south.innerStartPt.x, 6);
  });

  it('gives both walls of a corner the same mitre line', () => {
    const { nodes, edges } = room();
    const joins = calcWallJoins(nodes, edges);
    const south = joins.get('south')!;
    const east = joins.get('east')!;
    // south's END and east's START are the same corner (5000, 0). A watertight
    // joint means the two walls cut along one line, not two parallel ones.
    const line = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      [a, b].map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).sort().join(' | ');
    expect(line(south.outerEndPt, south.innerEndPt))
      .toBe(line(east.outerStartPt, east.innerStartPt));
  });

  it('bisects an unequal angle too', () => {
    // A 45-degree corner: the bisector of (1,0) and (cos135, sin135) still
    // leaves the two corners on opposite sides of the centre-line.
    let k = 0;
    const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `k${k++}`, from, to });
    const nodes: BubbleGraphNode[] = [
      storey, ax('a', 0, 0), ax('b', 4000, 0), ax('c', 4000 + 2000, 2000),
      wallNode('run'), wallNode('splay'),
    ];
    const edges = [wire('run', 'a'), wire('run', 'b'), wire('splay', 'b'), wire('splay', 'c')];
    const run = calcWallJoins(nodes, edges).get('run')!;
    expect(run.endJoin).toBe('miter');
    expect(Math.sign(run.outerEndPt.y)).toBe(1);
    expect(Math.sign(run.innerEndPt.y)).toBe(-1);
    // Not a square cut: the corners are at different distances along the wall.
    expect(Math.abs(run.outerEndPt.x - run.innerEndPt.x)).toBeGreaterThan(1);
  });

  it('leaves an end-cap alone', () => {
    let k = 0;
    const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `m${k++}`, from, to });
    const nodes = [storey, ax('a', 0, 0), ax('b', 4000, 0), wallNode('lone')];
    const edges = [wire('lone', 'a'), wire('lone', 'b')];
    const lone = calcWallJoins(nodes, edges).get('lone')!;
    expect(lone.startJoin).toBe('square_off');
    expect(lone.endJoin).toBe('square_off');
    expect(lone.outerStartPt.x).toBeCloseTo(lone.innerStartPt.x, 6);
  });
});

describe('calcWallJoins — a T-junction stops the stem, not the chord', () => {
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'S', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const ax = (id: string, x: number, y: number): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y, has_column: 'False' },
  });
  const wallNode = (id: string, t = 'W25'): BubbleGraphNode => ({
    id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
    properties: { wall_type: t },
  });
  let k = 0;
  const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `t${k++}`, from, to });

  //  a ──chordW── m ──chordE── b     both W25, collinear along y = 0
  //               │
  //             stem (W10) running south
  function tee() {
    return {
      nodes: [storey, ax('a', 0, 0), ax('m', 4000, 0), ax('b', 8000, 0), ax('p', 4000, -3000),
        wallNode('chordW'), wallNode('chordE'), wallNode('stem', 'W10')],
      edges: [wire('chordW', 'a'), wire('chordW', 'm'), wire('chordE', 'm'),
        wire('chordE', 'b'), wire('stem', 'm'), wire('stem', 'p')],
    };
  }

  it('lets the through-wall run past the junction untouched', () => {
    const { nodes, edges } = tee();
    const joins = calcWallJoins(nodes, edges);
    const w = joins.get('chordW')!, e = joins.get('chordE')!;
    // Both halves used to butt to the stem's faces, opening a hole the width
    // of the stem in a wall that does not stop here.
    expect(w.endJoin).toBe('square_off');
    expect(e.startJoin).toBe('square_off');
    expect(w.endPt).toEqual({ x: 4000, y: 0 });
    expect(e.startPt).toEqual({ x: 4000, y: 0 });
  });

  it('stops the stem at the chord\'s face, not at its centre-line', () => {
    const { nodes, edges } = tee();
    const stem = calcWallJoins(nodes, edges).get('stem')!;
    expect(stem.startJoin).toBe('butt');
    // The chord is W25, so its near face is 125 mm south of the node.
    expect(stem.startPt).toEqual({ x: 4000, y: -125 });
    // A butt end stays square: both corners at the same distance along.
    expect(stem.outerStartPt.y).toBeCloseTo(stem.innerStartPt.y, 6);
  });

  it('at a full cross the thicker pair runs through and the thinner butts', () => {
    let j = 0;
    const w2 = (from: string, to: string): BubbleGraphEdge => ({ id: `x${j++}`, from, to });
    const nodes = [storey,
      ax('w', -4000, 0), ax('c', 0, 0), ax('e', 4000, 0), ax('n', 0, 4000), ax('s', 0, -4000),
      wallNode('heavyW'), wallNode('heavyE'), wallNode('lightN', 'W10'), wallNode('lightS', 'W10')];
    const edges = [
      w2('heavyW', 'w'), w2('heavyW', 'c'), w2('heavyE', 'c'), w2('heavyE', 'e'),
      w2('lightN', 'c'), w2('lightN', 'n'), w2('lightS', 'c'), w2('lightS', 's'),
    ];
    const joins = calcWallJoins(nodes, edges);
    expect(joins.get('heavyW')!.endJoin).toBe('square_off');
    expect(joins.get('lightN')!.startJoin).toBe('butt');
  });
});

describe('the footprint OpenGeometry extrudes carries the joins', () => {
  // `ogBimMapper` builds every wall solid from `calcWallGeometry(...).footprint`
  // (see its "Footprint already includes join geometry" note), so whatever the
  // join solver decides reaches OpenGeometry, the 3D viewers and the plan
  // through this one quad. These pin that it actually arrives.
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'S', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const ax = (id: string, x: number, y: number): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y, has_column: 'False' },
  });
  const wallNode = (id: string, t = 'W25'): BubbleGraphNode => ({
    id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
    properties: { wall_type: t },
  });
  let k = 0;
  const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `f${k++}`, from, to });

  const footprintOf = (nodes: BubbleGraphNode[], edges: BubbleGraphEdge[], id: string) => {
    const nodeMap = new Map(nodes.map((x) => [x.id, x]));
    return calcWallGeometry(nodeMap.get(id)!, nodeMap, edges, calcWallJoins(nodes, edges))!.footprint
      .map((p) => [Math.round(p.x), Math.round(p.y)] as const);
  };

  it('a mitred corner arrives as a trapezoid, not a rectangle', () => {
    const nodes = [storey, ax('c0', 0, 0), ax('c1', 5000, 0), ax('c3', 0, 4000),
      wallNode('south'), wallNode('west')];
    const edges = [wire('south', 'c0'), wire('south', 'c1'),
      wire('west', 'c3'), wire('west', 'c0')];
    const fp = footprintOf(nodes, edges, 'south');
    const has = (x: number, y: number) => fp.some(([a, b]) => a === x && b === y);
    // The corner reaches PAST the node on the outside and stops short on the
    // inside — the two ends of the bisector through (0, 0).
    expect(has(-125, -125)).toBe(true);
    expect(has(125, 125)).toBe(true);
    // A square end would put both corners on the same x.
    const startXs = fp.filter(([x]) => Math.abs(x) <= 200).map(([x]) => x);
    expect(new Set(startXs).size).toBe(2);
  });

  it('a T lets the chord through at full width and stops the stem', () => {
    const nodes = [storey, ax('a', 0, 0), ax('m', 4000, 0), ax('b', 8000, 0), ax('p', 4000, -3000),
      wallNode('chordW'), wallNode('chordE'), wallNode('stem', 'W10')];
    const edges = [wire('chordW', 'a'), wire('chordW', 'm'), wire('chordE', 'm'),
      wire('chordE', 'b'), wire('stem', 'm'), wire('stem', 'p')];

    // The chord halves meet at x = 4000 with nothing taken out between them.
    const w = footprintOf(nodes, edges, 'chordW').map(([x]) => x);
    const e = footprintOf(nodes, edges, 'chordE').map(([x]) => x);
    expect(Math.max(...w)).toBe(4000);
    expect(Math.min(...e)).toBe(4000);

    // The stem reaches the chord's face at y = -125 and no further.
    const stemYs = footprintOf(nodes, edges, 'stem').map(([, y]) => y);
    expect(Math.max(...stemYs)).toBe(-125);
  });
});

describe('calcWallJoins — a column at the junction IS the junction', () => {
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'S', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const ax = (id: string, x: number, y: number, col: boolean): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y, has_column: col ? 'True' : 'False', column_type: 'C40x40' },
  });
  const wallNode = (id: string, props: Record<string, unknown> = {}): BubbleGraphNode => ({
    id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
    properties: { wall_type: 'W25', ...props },
  });
  let k = 0;
  const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `n${k++}`, from, to });

  // An L-corner at (0, 0). The C40x40 there occupies x, y in [-200, 200].
  const corner = (cornerProps: Record<string, unknown> = {}, hasCol = true) => ({
    nodes: [storey, ax('c0', 0, 0, hasCol), ax('c1', 5000, 0, false), ax('c3', 0, 4000, false),
      wallNode('south', cornerProps), wallNode('west')],
    edges: [wire('south', 'c0'), wire('south', 'c1'), wire('west', 'c3'), wire('west', 'c0')],
  });

  const startX = (nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]) => {
    const map = new Map(nodes.map((n) => [n.id, n]));
    const fp = calcWallGeometry(map.get('south')!, map, edges, calcWallJoins(nodes, edges))!.footprint;
    return Math.min(...fp.map((p) => p.x));
  };

  it('stops both walls on the column\'s faces instead of mitring inside it', () => {
    const { nodes, edges } = corner();
    const joins = calcWallJoins(nodes, edges);
    expect(joins.get('south')!.startJoin).toBe('square_off');
    expect(joins.get('west')!.endJoin).toBe('square_off');
    // The mitre used to cut the corner at (125, 125) / (-125, -125) — wholly
    // inside a column that reaches 200 mm out on both axes.
    expect(startX(nodes, edges)).toBeCloseTo(200, 6);
  });

  it('still mitres a corner with no column on it', () => {
    const { nodes, edges } = corner({}, false);
    expect(calcWallJoins(nodes, edges).get('south')!.startJoin).toBe('miter');
    expect(startX(nodes, edges)).toBeCloseTo(-125, 6);
  });

  it('lets an explicit wall_join_start ask for the mitre back', () => {
    // The column may be only a stiffener inside masonry that really does run
    // past it, so the manual override has to outrank the automatic rule.
    const { nodes, edges } = corner({ wall_join_start: 'miter' });
    expect(calcWallJoins(nodes, edges).get('south')!.startJoin).toBe('miter');
  });

  it('treats a standalone column node the same as an ax carrying one', () => {
    const col: BubbleGraphNode = {
      id: 'k', type: 'column', name: 'k', x: 0, y: 0, z: 0, parentId: 'st',
      properties: { bimX: 0, bimY: 0, column_type: 'C40x40' },
    };
    const nodes = [storey, col, ax('c1', 5000, 0, false), ax('c3', 0, 4000, false),
      wallNode('south'), wallNode('west')];
    const edges = [wire('south', 'k'), wire('south', 'c1'), wire('west', 'c3'), wire('west', 'k')];
    expect(calcWallJoins(nodes, edges).get('south')!.startJoin).toBe('square_off');
  });
});
