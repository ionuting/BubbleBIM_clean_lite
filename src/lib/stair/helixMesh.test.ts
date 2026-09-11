import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildHelixGeometry, type HelixParams } from './helixMesh';

// The usual worked example: 2900 rise → 17 × 170.6, going 288.8 at the walking
// line, pole 100, width 1000.
const P: HelixParams = {
  centerXMm: 5000,
  centerYMm: 3000,
  baseZMm: 0,
  innerMm: 100,
  outerMm: 1100,
  startRad: 0,
  deltaRad: 288.8 / 600,   // going / walking radius
  steps: 17,
  riserMm: 2900 / 17,
  treadMm: 288.8,
  waistMm: 150,
};

/** BIM-space point of vertex i (scene is (x, z, −y)·0.001). */
function bimVertex(geo: THREE.BufferGeometry, i: number) {
  const a = geo.getAttribute('position');
  return { x: a.getX(i) * 1000, y: -a.getZ(i) * 1000, z: a.getY(i) * 1000 };
}

describe('buildHelixGeometry', () => {
  const geo = buildHelixGeometry(P)!;
  const count = geo.getAttribute('position').count;

  it('spans exactly floor to floor', () => {
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const v = bimVertex(geo, i);
      minZ = Math.min(minZ, v.z);
      maxZ = Math.max(maxZ, v.z);
    }
    // Clamped at the floor below — the drum SITS on it, no waist poking through
    // the ceiling underneath — and tops out exactly on the floor above.
    // (2 decimals: positions are Float32, worth a ten-thousandth of a mm here.)
    expect(minZ).toBeCloseTo(0, 2);
    expect(maxZ).toBeCloseTo(2900, 2);
  });

  it('keeps every vertex between the two radii', () => {
    for (let i = 0; i < count; i++) {
      const v = bimVertex(geo, i);
      const r = Math.hypot(v.x - P.centerXMm, v.y - P.centerYMm);
      expect(r).toBeGreaterThanOrEqual(P.innerMm - 1e-3);
      expect(r).toBeLessThanOrEqual(P.outerMm + 1e-3);
    }
  });

  it('drops the soffit a full waist below the pitch line, mid-flight', () => {
    // Away from the floor clamp, the lowest vertex at a given sweep must sit
    // drop = t·√(g²+h²)/g under the pitch line — the perpendicular waist.
    const g = P.treadMm, h = P.riserMm;
    const drop = (P.waistMm * Math.hypot(g, h)) / g;
    let worst = 0;
    for (let i = 0; i < count; i++) {
      const v = bimVertex(geo, i);
      const sweep = Math.atan2(v.y - P.centerYMm, v.x - P.centerXMm);
      const turns = ((sweep - P.startRad) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const pitch = (turns / P.deltaRad) * h;
      if (pitch > 800 && pitch < 2000) worst = Math.max(worst, pitch - v.z);
    }
    expect(worst).toBeGreaterThan(drop - h);   // reaches at least a waist below
    expect(worst).toBeLessThan(drop + h + 1);  // and never more than the waist
  });

  it('is flat-shaded triangles, enough for every step', () => {
    expect(count % 3).toBe(0);
    // 16 treads × (top+soffit+2 walls per segment ×4 + riser) — just assert a
    // sane magnitude so a silently-empty build cannot pass.
    expect(count / 3).toBeGreaterThan(16 * 9);
  });

  it('refuses the degenerate cases', () => {
    expect(buildHelixGeometry({ ...P, steps: 1 })).toBeNull();
    expect(buildHelixGeometry({ ...P, deltaRad: 0 })).toBeNull();
    expect(buildHelixGeometry({ ...P, outerMm: P.innerMm })).toBeNull();
  });
});
