import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { pointInPolygon, yawForPlanDir, yawForPlanDirX } from './plan2d';

/**
 * Where a box's own +Z axis ends up in the scene, given a yaw and an optional
 * tilt — the same Euler the stair meshes build. Returned back in BIM terms
 * (x east, y north, z up) so the expectations read as building directions.
 */
function localZInBim(yaw: number, pitch = 0): { x: number; y: number; z: number } {
  const m = new THREE.Euler(pitch, yaw, 0, 'YXZ');
  const v = new THREE.Vector3(0, 0, 1).applyEuler(m);
  return { x: v.x, y: -v.z, z: v.y };
}

const near = (got: { x: number; y: number; z: number }, want: [number, number, number]) => {
  expect(got.x).toBeCloseTo(want[0], 6);
  expect(got.y).toBeCloseTo(want[1], 6);
  expect(got.z).toBeCloseTo(want[2], 6);
};

describe('yawForPlanDir', () => {
  it('points a box east when the plan heading is east', () => {
    near(localZInBim(yawForPlanDir(1, 0)), [1, 0, 0]);
  });

  it('points a box north when the plan heading is north', () => {
    near(localZInBim(yawForPlanDir(0, 1)), [0, 1, 0]);
  });

  it('points a box west and south too', () => {
    near(localZInBim(yawForPlanDir(-1, 0)), [-1, 0, 0]);
    near(localZInBim(yawForPlanDir(0, -1)), [0, -1, 0]);
  });

  it('does not mirror a diagonal heading', () => {
    // The bug this guards: negating the heading agrees with the truth at 0° and
    // 180° in one axis but flips the sign of the other, so a diagonal run comes
    // out reflected. Check a heading no symmetry can rescue.
    const s = Math.SQRT1_2;
    near(localZInBim(yawForPlanDir(s, s)), [s, s, 0]);
    near(localZInBim(yawForPlanDir(s, -s)), [s, -s, 0]);
  });

  it('keeps the box level in plan for every heading', () => {
    for (let deg = 0; deg < 360; deg += 15) {
      const rad = (deg * Math.PI) / 180;
      const got = localZInBim(yawForPlanDir(Math.cos(rad), Math.sin(rad)));
      expect(got.z).toBeCloseTo(0, 6);
    }
  });

  it('climbs along the heading once a pitch is added', () => {
    // A flight running north at 30°: the run stays north, and it goes up.
    const got = localZInBim(yawForPlanDir(0, 1), -Math.atan2(1, Math.sqrt(3)));
    expect(got.x).toBeCloseTo(0, 6);
    expect(got.y).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    expect(got.z).toBeCloseTo(Math.sin(Math.PI / 6), 6);
  });

  it('climbs along a diagonal heading, still without mirroring', () => {
    const s = Math.SQRT1_2;
    // North-east, not north-west: the two agree at north-west by coincidence,
    // which is part of why the wrong formula looked plausible.
    const got = localZInBim(yawForPlanDir(s, s), -Math.atan2(1, 1));
    const flat = Math.cos(Math.PI / 4);
    expect(got.x).toBeCloseTo(s * flat, 6);
    expect(got.y).toBeCloseTo(s * flat, 6);
    expect(got.z).toBeCloseTo(Math.sin(Math.PI / 4), 6);
  });
});

describe('yawForPlanDirX', () => {
  /** Where local +X ends up in BIM terms, given the yaw. */
  const localXInBim = (yaw: number) => {
    const v = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
    return { x: v.x, y: -v.z, z: v.y };
  };

  it('points local +X along the four cardinal headings', () => {
    near(localXInBim(yawForPlanDirX(1, 0)), [1, 0, 0]);
    near(localXInBim(yawForPlanDirX(0, 1)), [0, 1, 0]);
    near(localXInBim(yawForPlanDirX(-1, 0)), [-1, 0, 0]);
    near(localXInBim(yawForPlanDirX(0, -1)), [0, -1, 0]);
  });

  it('does not mirror a diagonal heading', () => {
    const s = Math.SQRT1_2;
    near(localXInBim(yawForPlanDirX(s, s)), [s, s, 0]);
    near(localXInBim(yawForPlanDirX(s, -s)), [s, -s, 0]);
  });

  it('agrees with the +Z variant about which way is which', () => {
    // The same physical rotation described through two different local axes:
    // pointing +X along a heading also points +Z along the heading turned 90°
    // clockwise in plan. If this drifts, one of the two formulas is wrong again.
    for (let deg = 0; deg < 360; deg += 30) {
      const rad = (deg * Math.PI) / 180;
      const dx = Math.cos(rad), dy = Math.sin(rad);
      const viaX = yawForPlanDirX(dx, dy);
      const viaZ = yawForPlanDir(dy, -dx);
      const diff = Math.atan2(Math.sin(viaX - viaZ), Math.cos(viaX - viaZ));
      expect(diff).toBeCloseTo(0, 6);
    }
  });
});

describe('pointInPolygon', () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];

  it('accepts an interior point', () => {
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
  });

  it('rejects an exterior point', () => {
    expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
  });

  it('counts the boundary as inside, within tolerance', () => {
    expect(pointInPolygon({ x: 100, y: 50 }, square)).toBe(true);
    expect(pointInPolygon({ x: 100.5, y: 50 }, square)).toBe(true);
    expect(pointInPolygon({ x: 102, y: 50 }, square)).toBe(false);
  });

  it('handles a concave ring without filling the notch', () => {
    const ell = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 },
      { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 },
    ];
    expect(pointInPolygon({ x: 20, y: 80 }, ell)).toBe(true);
    expect(pointInPolygon({ x: 80, y: 80 }, ell)).toBe(false);
  });
});
