/**
 * The shipped band presets, end to end: clicking "Baie" or "Soclu BCA" must
 * move the bill of quantities, not just the colour in the 3D view. Until
 * 2026-09 they moved only the colour.
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { computeTakeoff } from '@/lib/quantityTakeoff/takeoffEngine';
import { COVERING_PRESETS, serializeCoveringLayers } from '@/lib/roomCovering';
import { WALL_LAYER_PRESETS, serializeWallLayers } from '@/lib/wallLayers';

const storey: BubbleGraphNode = { id: 's1', type: 'storey', name: 'P', x: 0, y: 0, z: 0, properties: { bottomElevation: 0, topElevation: 2800 } };
const ax = (id: string, x: number, y: number): BubbleGraphNode =>
  ({ id, type: 'ax', name: id, x, y, z: 0, parentId: 's1', properties: { bimX: x, bimY: y, has_column: 'False' } });
const A = ax('A', 0, 0), B = ax('B', 5000, 0), C = ax('C', 5000, 4000), D = ax('D', 0, 4000);
const e = (from: string, to: string): BubbleGraphEdge => ({ id: from + to, from, to });

const q = (lines: ReturnType<typeof computeTakeoff>, id: string) =>
  lines.filter((l) => l.normId === id).reduce((a, l) => a + l.quantity, 0);

// 5 × 4 room: 18 m perimeter, 20 m² floor, 2.8 m tall.
const PERIM = 18, FLOOR = 20, H = 2.8;
const TILES = '0024_FA01_STD', PLASTER = '0011_CF24A_02';
const PAINT = '0013_CN05A_02', SCREED = '0007_SP01_CIM';

describe('the "Baie" covering preset', () => {
  const wire = [e('r1', 'A'), e('r1', 'B'), e('r1', 'C'), e('r1', 'D')];
  const room = (props: Record<string, unknown>): BubbleGraphNode =>
    ({ id: 'r1', type: 'room', name: 'Baie', x: 0, y: 0, z: 0, parentId: 's1', properties: { height: 2800, ...props } });
  const plain = computeTakeoff([storey, A, B, C, D, room({})], wire);
  const bath = computeTakeoff([storey, A, B, C, D,
    room({ covering_layers: serializeCoveringLayers(COVERING_PRESETS.bathroom.layers) })], wire);

  it('tiles 1.5 m and plasters the 1.3 m above it', () => {
    expect(q(plain, TILES)).toBe(0);
    expect(q(bath, TILES)).toBeCloseTo(PERIM * 1.5, 2);
    expect(q(bath, PLASTER)).toBeCloseTo(PERIM * 1.3, 2);
    expect(q(plain, PLASTER)).toBeCloseTo(PERIM * H, 2);
  });

  it('does not plaster or paint behind the tiles', () => {
    expect(q(bath, PLASTER) + q(bath, TILES)).toBeCloseTo(q(plain, PLASTER), 2);
    expect(q(bath, PAINT)).toBeCloseTo(PERIM * 1.3, 2);
  });

  it('leaves the floor alone — it is not a vertical quantity', () => {
    expect(q(bath, SCREED)).toBeCloseTo(FLOOR, 2);
    expect(q(bath, SCREED)).toBeCloseTo(q(plain, SCREED), 6);
  });
});

describe('the "Soclu BCA" wall preset', () => {
  const wall = (props: Record<string, unknown>): BubbleGraphNode =>
    ({ id: 'w1', type: 'wall', name: 'W', x: 0, y: 0, z: 0, parentId: 's1', properties: { wall_type: 'W20', height: 3000, ...props } });
  const wire = [e('w1', 'A'), e('w1', 'B')];
  const plain = computeTakeoff([storey, A, B, wall({})], wire);
  const socle = computeTakeoff([storey, A, B,
    wall({ wall_layers: serializeWallLayers(WALL_LAYER_PRESETS.bca_socle.layers) })], wire);

  const BCA = '0001_BCA25_02', POROTHERM = '0001_00201A01_02';

  it('builds the first 600 mm out of AAC and the rest out of Porotherm', () => {
    // 5 m long × 0.2 m thick.
    expect(q(socle, BCA)).toBeCloseTo(5 * 0.6 * 0.2, 2);
    expect(q(socle, POROTHERM)).toBeCloseTo(5 * 2.4 * 0.2, 2);
  });

  it('conserves the wall: the two blocks add up to the whole volume', () => {
    expect(q(socle, BCA) + q(socle, POROTHERM)).toBeCloseTo(q(plain, POROTHERM), 6);
  });
});
