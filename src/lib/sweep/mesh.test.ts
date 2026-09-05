import { describe, expect, it } from 'vitest';
import { computeSweepSolids } from './rings';
import { rectProfile } from './profiles';
import { sweepBufferGeometry } from './mesh';
import type { Pt2, SweepPath } from './types';

const square: Pt2[] = rectProfile(100, 100)!;

const hPath = (pts: [number, number][], closed = false): SweepPath => ({
  points: pts.map(([x, y]) => ({ x, y, z: 0 })),
  closed,
  kind: 'horizontal',
});

describe('sweepBufferGeometry', () => {
  it('open straight rect run: 2·(R−1)·N sides + 2·(N−2) caps triangles', () => {
    const { solids } = computeSweepSolids(hPath([[0, 0], [4000, 0]]), square, 'miter');
    const geo = sweepBufferGeometry(solids, square)!;
    const triCount = geo.getAttribute('position').count / 3;
    expect(triCount).toBe(2 * 1 * 4 + 2 * 2); // 12
    expect(geo.getAttribute('normal')).toBeDefined();
  });

  it('closed loop: 2·R·N side triangles, no caps', () => {
    const { solids } = computeSweepSolids(
      hPath([[0, 0], [4000, 0], [4000, 4000], [0, 4000]], true),
      square, 'miter',
    );
    const geo = sweepBufferGeometry(solids, square)!;
    expect(geo.getAttribute('position').count / 3).toBe(2 * 4 * 4);
  });

  it('maps BIM mm to scene metres as (x, z, −y)·0.001', () => {
    const path: SweepPath = {
      points: [{ x: 1000, y: 2000, z: 500 }, { x: 3000, y: 2000, z: 500 }],
      closed: false, kind: 'horizontal',
    };
    const { solids } = computeSweepSolids(path, square, 'miter');
    const geo = sweepBufferGeometry(solids, square)!;
    const pos = geo.getAttribute('position');
    // Every vertex must respect the mapping ranges: x ∈ [1,3], y = z_bim ∈ [0.45,0.55], z = −y_bim ∈ [−2.05,−1.95]
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getX(i)).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(pos.getX(i)).toBeLessThanOrEqual(3 + 1e-6);
      expect(pos.getY(i)).toBeGreaterThanOrEqual(0.45 - 1e-6);
      expect(pos.getY(i)).toBeLessThanOrEqual(0.55 + 1e-6);
      expect(pos.getZ(i)).toBeGreaterThanOrEqual(-2.05 - 1e-6);
      expect(pos.getZ(i)).toBeLessThanOrEqual(-1.95 + 1e-6);
    }
  });

  it('returns null for nothing to build', () => {
    expect(sweepBufferGeometry([], square)).toBeNull();
  });
});
