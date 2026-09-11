import { describe, expect, it } from 'vitest';
import { AREA_TYPES, LINE_TYPES, distToSegment, hitClassOf, pickBestHit, type HitCandidate } from './pickHit';

const c = (id: string, nodeType: string, dist: number, radius = 12): HitCandidate<string> =>
  ({ node: id, nodeType, dist, radius });

describe('hitClassOf', () => {
  it('walls and beams are paths, not places', () => {
    expect([...LINE_TYPES].every((t) => hitClassOf(t) === 'line')).toBe(true);
    expect([...AREA_TYPES].every((t) => hitClassOf(t) === 'area')).toBe(true);
    expect(hitClassOf('ax')).toBe('point');
    expect(hitClassOf('column')).toBe('point');
    expect(hitClassOf('window')).toBe('point');
  });
});

describe('pickBestHit', () => {
  it('THE BUG: an ax point wins over a wall lying on it, whatever the order', () => {
    // The cursor is 3 px from the ax and 1 px from the wall that runs through it.
    const wallFirst = pickBestHit([c('wall1', 'wall', 1), c('ax1', 'ax', 3)]);
    const axFirst = pickBestHit([c('ax1', 'ax', 3), c('wall1', 'wall', 1)]);
    expect(wallFirst?.node).toBe('ax1');
    expect(axFirst?.node).toBe('ax1');
  });

  it('aiming at a point is an intention; brushing a line is not', () => {
    // Even a wall directly under the cursor loses to an ax still in range.
    expect(pickBestHit([c('wall1', 'wall', 0), c('ax1', 'ax', 11)])?.node).toBe('ax1');
  });

  it('but a point out of range does not steal the click', () => {
    expect(pickBestHit([c('wall1', 'wall', 2), c('ax1', 'ax', 30, 12)])?.node).toBe('wall1');
  });

  it('within one class the NEAREST wins — not the first in the list', () => {
    expect(pickBestHit([c('far', 'ax', 9), c('near', 'ax', 2)])?.node).toBe('near');
    expect(pickBestHit([c('near', 'ax', 2), c('far', 'ax', 9)])?.node).toBe('near');
    expect(pickBestHit([c('w1', 'wall', 7), c('w2', 'wall', 3)])?.node).toBe('w2');
  });

  it('a room yields to anything else that is in range', () => {
    expect(pickBestHit([c('room1', 'room', 0), c('wall1', 'wall', 10)])?.node).toBe('wall1');
    expect(pickBestHit([c('room1', 'room', 0), c('ax1', 'ax', 10)])?.node).toBe('ax1');
  });

  it('nothing in range is nothing hit', () => {
    expect(pickBestHit([c('ax1', 'ax', 40, 12), c('wall1', 'wall', 40, 12)])).toBeUndefined();
    expect(pickBestHit([])).toBeUndefined();
  });

  it('a candidate exactly on its radius still counts', () => {
    expect(pickBestHit([c('ax1', 'ax', 12, 12)])?.node).toBe('ax1');
  });

  it('an unbounded radius (a box hit already proven inside) still ranks by distance', () => {
    const best = pickBestHit([
      { node: 'wide', nodeType: 'ax', dist: 9, radius: Infinity },
      { node: 'tight', nodeType: 'ax', dist: 2, radius: Infinity },
    ]);
    expect(best?.node).toBe('tight');
  });
});

describe('distToSegment', () => {
  it('is zero on the segment and the perpendicular beside it', () => {
    expect(distToSegment(5, 0, 0, 0, 10, 0)).toBe(0);
    expect(distToSegment(5, 4, 0, 0, 10, 0)).toBeCloseTo(4, 6);
  });

  it('clamps to the endpoints past the ends — a wall does not extend forever', () => {
    expect(distToSegment(-3, 0, 0, 0, 10, 0)).toBeCloseTo(3, 6);
    expect(distToSegment(14, 0, 0, 0, 10, 0)).toBeCloseTo(4, 6);
  });

  it('a degenerate segment is just a point', () => {
    expect(distToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 6);
  });
});
