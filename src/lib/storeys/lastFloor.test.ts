import { describe, it, expect } from 'vitest';
import { computeLastFloorBand, type StoreyBand } from './lastFloor';

const S = (id: string, b: number, t: number): StoreyBand => ({ id, bottomElevation: b, topElevation: t });

describe('computeLastFloorBand', () => {
  const base: StoreyBand[] = [
    S('infra', -1800, 0),
    S('f1', 0, 2800),
    S('f2', 2800, 5600),
    S('last', 5600, 8400),
  ];

  it('floats to sit on the highest regular storey (default project)', () => {
    expect(computeLastFloorBand(base, 'last')).toEqual({ bottom: 5600, top: 8400 });
  });

  it('rises when a storey is added above the previous top', () => {
    const withF3 = [...base, S('f3', 5600, 8400)];
    // last should now sit above f3's top (8400), keeping its 2800 height.
    expect(computeLastFloorBand(withF3, 'last')).toEqual({ bottom: 8400, top: 11200 });
  });

  it('preserves a customised Last floor height', () => {
    const tall = base.map((s) => (s.id === 'last' ? S('last', 5600, 9600) : s)); // height 4000
    expect(computeLastFloorBand(tall, 'last')).toEqual({ bottom: 5600, top: 9600 });
  });

  it('drops back down when upper storeys are removed', () => {
    const onlyGround = [S('f1', 0, 2800), S('last', 6000, 8800)]; // last height 2800
    expect(computeLastFloorBand(onlyGround, 'last')).toEqual({ bottom: 2800, top: 5600 });
  });

  it('returns null when it is the only storey', () => {
    expect(computeLastFloorBand([S('last', 5600, 8400)], 'last')).toBeNull();
  });

  it('returns null when the last storey id is missing', () => {
    expect(computeLastFloorBand(base, 'nope')).toBeNull();
  });
});
