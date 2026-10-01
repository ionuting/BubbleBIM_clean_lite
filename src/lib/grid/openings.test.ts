import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { buildStoreyNodes } from '@/lib/storeys/defaultProject';
import {
  addOpening,
  offsetForCentre,
  openingHitTest,
  parseOpeningList,
  patchOpening,
  placeOpening,
  removeOpening,
  sameOpeningRef,
  setHasOpenings,
  wallChipHitTest,
  wallChips,
  wallOpenings,
  type GridOpening,
  type GridWall,
  type OpeningRef,
} from './openings';

const XS = [0, 5000, 10000], YS = [0, 4000, 8000];

/** One storey, one 5 m wall on axis A, carrying whatever openings a test asks for. */
function fixture(wallProps: Record<string, unknown> = {}) {
  const s = buildStoreyNodes('P', 0, 3000, XS, YS, 0);
  const storey = s[0];
  const ax = (gx: number, gy: number) =>
    s.find((n) => n.type === 'ax' && n.properties.gridX === gx && n.properties.gridY === gy)!;
  const a = ax(0, 0), b = ax(1, 0);
  const wall: BubbleGraphNode = {
    id: 'w', type: 'wall', name: 'Wall', x: (a.x + b.x) / 2, y: a.y, z: 0,
    parentId: storey.id, properties: { thickness: 250, ...wallProps },
  };
  const nodes = [...s, wall];
  const edges: BubbleGraphEdge[] = [
    { id: 'e1', from: a.id, to: 'w' }, { id: 'e2', from: 'w', to: b.id },
  ];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return { nodes, edges, nodeMap, wall, storey };
}

/** The wall drawn left-to-right, 5000 mm long, mapped onto 250 world px. */
const gridWall = (wall: BubbleGraphNode, openings: GridWall['openings'] = []): GridWall => ({
  wall, a: { x: 0, y: 0 }, b: { x: 250, y: 0 }, lenMm: 5000, openings,
});

const WINDOWS = JSON.stringify([
  { id: 'wi1', window_type: 'W-FIX-100x120', width: 1200, height: 1200, sill_height: 900, wall_offset: 500 },
  { id: 'wi2', window_type: 'W-FIX-100x120', width: 800, height: 1200, sill_height: 900, wall_offset: 3000 },
]);

describe('wallOpenings', () => {
  it('reads the inline arrays and tags each symbol with the ref that writes it back', () => {
    const { wall, edges, nodeMap } = fixture({ has_windows: 'True', windows: WINDOWS });
    const ops = wallOpenings(wall, 5000, edges, nodeMap);
    expect(ops.map((o) => [o.type, o.distFromStart, o.widthMm])).toEqual([
      ['window', 500, 1200],
      ['window', 3000, 800],
    ]);
    expect(ops[0].ref).toEqual({ kind: 'inline', wallId: 'w', list: 'windows', index: 0 });
    expect(ops[1].ref).toEqual({ kind: 'inline', wallId: 'w', list: 'windows', index: 1 });
    expect(ops[0].flipAcross).toBe(false);
    expect(ops[0].swing).toBe('left');
  });

  it('honours the has_windows switch and the flip flags, however they are spelled', () => {
    const off = fixture({ has_windows: 'False', windows: WINDOWS });
    expect(wallOpenings(off.wall, 5000, off.edges, off.nodeMap)).toHaveLength(0);

    const flipped = fixture({
      has_doors: 'True',
      doors: JSON.stringify([{ id: 'd1', width: 900, wall_offset: 100, flip_across: 'True', flip_along: true, swing: 'right' }]),
    });
    const [d] = wallOpenings(flipped.wall, 5000, flipped.edges, flipped.nodeMap);
    expect(d.type).toBe('door');
    expect([d.flipAcross, d.flipAlong, d.swing]).toEqual([true, true, 'right']);
  });

  it('picks up window nodes wired to the wall, with a node ref', () => {
    const f = fixture();
    const win: BubbleGraphNode = {
      id: 'win', type: 'window', name: 'W1', x: 0, y: 0, z: 0,
      properties: { width: 1000, height: 1200, sill_height: 900, offset: 2000 },
    };
    const nodeMap = new Map([...f.nodeMap, ['win', win]]);
    const edges = [...f.edges, { id: 'e3', from: 'win', to: 'w' }];
    const ops = wallOpenings(f.wall, 5000, edges, nodeMap);
    expect(ops).toHaveLength(1);
    expect(ops[0].ref).toEqual({ kind: 'node', nodeId: 'win' });
    expect(ops[0].distFromStart).toBe(2000);
  });
});

describe('writes mirror the inspector', () => {
  const ref: OpeningRef = { kind: 'inline', wallId: 'w', list: 'windows', index: 1 };

  it('patchOpening edits one entry of the JSON array and leaves the rest alone', () => {
    const { nodes } = fixture({ has_windows: 'True', windows: WINDOWS });
    const out = patchOpening(nodes, ref, { flip_across: true, wall_offset: 3500 });
    const list = parseOpeningList(out.find((n) => n.id === 'w')!, 'windows');
    expect(list[1]).toMatchObject({ id: 'wi2', flip_across: true, wall_offset: 3500, width: 800 });
    expect(list[0]).toMatchObject({ id: 'wi1', wall_offset: 500 });
    expect(list[0]).not.toHaveProperty('flip_across');
  });

  it('patchOpening on a node ref writes the node properties', () => {
    const win: BubbleGraphNode = { id: 'win', type: 'window', name: 'W', x: 0, y: 0, z: 0, properties: { width: 900 } };
    const out = patchOpening([win], { kind: 'node', nodeId: 'win' }, { flip_along: true });
    expect(out[0].properties).toEqual({ width: 900, flip_along: true });
  });

  it('removing the last opening switches has_windows back off', () => {
    const { nodes } = fixture({ has_windows: 'True', windows: WINDOWS });
    const one = removeOpening(nodes, ref);
    const wall1 = one.find((n) => n.id === 'w')!;
    expect(parseOpeningList(wall1, 'windows')).toHaveLength(1);
    expect(wall1.properties.has_windows).toBe('True');
    const none = removeOpening(one, { kind: 'inline', wallId: 'w', list: 'windows', index: 0 });
    const wall0 = none.find((n) => n.id === 'w')!;
    expect(parseOpeningList(wall0, 'windows')).toHaveLength(0);
    expect(wall0.properties.has_windows).toBe('False');
    // A node ref removes the node itself.
    expect(removeOpening([{ id: 'x' } as BubbleGraphNode], { kind: 'node', nodeId: 'x' })).toHaveLength(0);
  });

  it('adding seeds the inspector defaults and turns the switch on; ids never collide', () => {
    const { nodes } = fixture();
    const one = addOpening(nodes, 'w', 'doors');
    const w1 = one.find((n) => n.id === 'w')!;
    expect(w1.properties.has_doors).toBe('True');
    expect(parseOpeningList(w1, 'doors')[0]).toMatchObject({ door_type: 'D-SWING-90x210', width: 900, swing: 'left' });
    const two = addOpening(one, 'w', 'doors');
    const ids = parseOpeningList(two.find((n) => n.id === 'w')!, 'doors').map((o) => o.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('setHasOpenings toggles the switch, seeding one opening when the list is empty', () => {
    const { nodes } = fixture({ has_windows: 'True', windows: WINDOWS });
    const off = setHasOpenings(nodes, 'w', 'windows', false);
    const wOff = off.find((n) => n.id === 'w')!;
    expect(wOff.properties.has_windows).toBe('False');
    expect(parseOpeningList(wOff, 'windows')).toHaveLength(2);   // kept, like the inspector's select
    const seeded = setHasOpenings(fixture().nodes, 'w', 'windows', true);
    expect(parseOpeningList(seeded.find((n) => n.id === 'w')!, 'windows')).toHaveLength(1);
  });
});

describe('placement on the drawn segment', () => {
  const base: Omit<GridOpening, 'type' | 'distFromStart' | 'widthMm'> = {
    ref: { kind: 'inline', wallId: 'w', list: 'windows', index: 0 },
    wallId: 'w', name: 'W', flipAcross: false, flipAlong: false, swing: 'left',
  };

  it('maps mm along the wall onto the segment, with a left normal', () => {
    const { wall } = fixture();
    const op = { ...base, type: 'window' as const, distFromStart: 1000, widthMm: 1000 };
    const p = placeOpening(gridWall(wall, [op]), op, 1)!;
    // 5000 mm → 250 px, so 1000 mm starts at 50 px and ends at 100 px.
    expect(p.p0).toEqual({ x: 50, y: 0 });
    expect(p.p1).toEqual({ x: 100, y: 0 });
    expect(p.centre.x).toBe(75);
    expect(p.u).toEqual({ x: 1, y: 0 });
    expect(p.nrm).toEqual({ x: -0, y: 1 });
    expect(p.side).toBe(1);
  });

  it('flip_across swaps the face; swing and flip_along each swap the hinge end', () => {
    const { wall } = fixture();
    const make = (o: Partial<typeof base>) => {
      const op = { ...base, ...o, type: 'door' as const, distFromStart: 0, widthMm: 900 };
      return placeOpening(gridWall(wall, [op]), op, 1)!;
    };
    expect(make({}).hingeAtStart).toBe(true);
    expect(make({ flipAcross: true }).side).toBe(-1);
    expect(make({ flipAlong: true }).hingeAtStart).toBe(false);
    expect(make({ swing: 'right' }).hingeAtStart).toBe(false);
    expect(make({ swing: 'right', flipAlong: true }).hingeAtStart).toBe(true);
  });

  it('offers flip and remove chips, sized on screen and clear of the symbol', () => {
    const { wall } = fixture();
    const op = { ...base, type: 'door' as const, distFromStart: 1000, widthMm: 1000 };
    const p = placeOpening(gridWall(wall, [op]), op, 1)!;
    expect(p.chips.map((c) => c.id)).toEqual(['across', 'along', 'remove']);
    // Chips sit on the face opposite the swing, so they never cover the leaf.
    expect(p.chips.every((c) => c.at.y < 0)).toBe(true);
    const zoomed = placeOpening(gridWall(wall, [op]), op, 4)!;
    expect(zoomed.chips[0].at.y).toBeCloseTo(p.chips[0].at.y / 4, 6);
  });

  it('a zero-length wall has no placement', () => {
    const { wall } = fixture();
    const op = { ...base, type: 'window' as const, distFromStart: 0, widthMm: 900 };
    expect(placeOpening({ ...gridWall(wall), b: { x: 0, y: 0 } }, op, 1)).toBeNull();
  });
});

describe('hit testing', () => {
  it('a chip wins over the symbol body, and a miss is null', () => {
    const { wall } = fixture();
    const op = {
      ref: { kind: 'inline', wallId: 'w', list: 'windows', index: 0 } as OpeningRef,
      wallId: 'w', name: 'W', type: 'window' as const, distFromStart: 1000, widthMm: 1000,
      flipAcross: false, flipAlong: false, swing: 'left' as const,
    };
    const w = gridWall(wall, [op]);
    const placement = placeOpening(w, op, 1)!;
    const list = [{ wall: w, placement }];
    expect(openingHitTest(list, placement.centre.x, placement.centre.y, 1)?.chip).toBeNull();
    const chip = placement.chips[0];
    expect(openingHitTest(list, chip.at.x, chip.at.y, 1)?.chip?.id).toBe('across');
    expect(openingHitTest(list, 200, 200, 1)).toBeNull();
  });

  it('wall chips carry the has_* state they toggle', () => {
    const { wall } = fixture({ has_windows: 'True', windows: WINDOWS });
    const chips = wallChips(gridWall(wall), 1);
    expect(chips.map((c) => [c.list, c.on])).toEqual([['windows', true], ['doors', false]]);
    expect(wallChipHitTest(chips, chips[1].at.x, chips[1].at.y, 1)?.list).toBe('doors');
    expect(wallChipHitTest(chips, 0, 0, 1)).toBeNull();
  });
});

describe('helpers', () => {
  it('offsetForCentre turns a cursor position into a clamped, snapped left edge', () => {
    expect(offsetForCentre(1000, 2503, 5000)).toBe(2000);
    expect(offsetForCentre(1000, 0, 5000)).toBe(0);          // clamped at the wall start
    expect(offsetForCentre(1000, 9999, 5000)).toBe(4000);    // and at the far end
    expect(offsetForCentre(6000, 100, 5000)).toBe(0);        // wider than the wall
  });

  it('sameOpeningRef compares by kind and identity', () => {
    const a: OpeningRef = { kind: 'inline', wallId: 'w', list: 'windows', index: 1 };
    expect(sameOpeningRef(a, { ...a })).toBe(true);
    expect(sameOpeningRef(a, { ...a, index: 0 })).toBe(false);
    expect(sameOpeningRef(a, { kind: 'node', nodeId: 'w' })).toBe(false);
    expect(sameOpeningRef(a, null)).toBe(false);
  });

  it('parseOpeningList survives malformed JSON and never hands back the stored objects', () => {
    const bad = { id: 'w', type: 'wall', name: 'W', x: 0, y: 0, z: 0, properties: { windows: '{oops' } } as BubbleGraphNode;
    expect(parseOpeningList(bad, 'windows')).toEqual([]);
    const { wall } = fixture({ windows: WINDOWS });
    const list = parseOpeningList(wall, 'windows');
    list[0].width = 1;
    expect(parseOpeningList(wall, 'windows')[0].width).toBe(1200);
  });
});
