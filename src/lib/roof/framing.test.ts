/**
 * Rafter generation over a face, independent of how the face was produced.
 *
 * The case that matters: on an irregular plan the straight skeleton can leave a
 * slope face that never reaches the eave — bounded entirely by ridges, hips and
 * valleys. That face used to come back completely unframed, and silently, which
 * reads as a hole in the roof structure.
 */
import { describe, expect, it } from 'vitest';
import { buildRoofFraming } from './framing';
import { DEFAULT_ROOF_INTENT, type RoofContour, type RoofFace3D, type RoofIntent } from './types';

const BASE_Z = 3000;

const intent: RoofIntent = { ...DEFAULT_ROOF_INTENT, roofType: 'hip', pitchDeg: 30, rafterSpacingMm: 600 };

const contour: RoofContour = {
  points: [
    { x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 8000 }, { x: 0, y: 8000 },
  ],
  axIds: [],
  baseZ: BASE_Z,
  storeyId: 'st',
};

/** A slope face whose lowest edge sits ON the eave line. */
const eaveFace: RoofFace3D = {
  id: 'f_eave',
  role: 'slope',
  vertices: [
    { x: 0, y: 0, z: BASE_Z },
    { x: 10000, y: 0, z: BASE_Z },
    { x: 8000, y: 2000, z: BASE_Z + 1154 },
    { x: 2000, y: 2000, z: BASE_Z + 1154 },
  ],
};

/** A slope face lifted clear of the eave — every vertex above baseZ. */
const liftedFace: RoofFace3D = {
  id: 'f_lifted',
  role: 'slope',
  vertices: [
    { x: 2000, y: 2000, z: BASE_Z + 1154 },
    { x: 8000, y: 2000, z: BASE_Z + 1154 },
    { x: 7000, y: 3000, z: BASE_Z + 1731 },
    { x: 3000, y: 3000, z: BASE_Z + 1731 },
  ],
};

const rafters = (faces: RoofFace3D[]) =>
  buildRoofFraming('r1', 'st', contour, intent, [], faces).filter((n) => n.type === 'rafter');

describe('rafter generation', () => {
  it('frames a face that sits on the eave', () => {
    expect(rafters([eaveFace]).length).toBeGreaterThan(0);
  });

  it('frames a face that never reaches the eave', () => {
    // Previously zero: no edge at baseZ meant an immediate bail-out.
    expect(rafters([liftedFace]).length).toBeGreaterThan(0);
  });

  it('starts those rafters from the face\'s own lowest edge, not the eave', () => {
    const rs = rafters([liftedFace]);
    for (const r of rs) {
      const p = r.properties as Record<string, number>;
      expect(p.az).toBeCloseTo(BASE_Z + 1154, 0);
      // …and they run UP the slope from there.
      expect(p.bz).toBeGreaterThan(p.az);
    }
  });

  it('keeps rafters on one face parallel in plan', () => {
    const rs = rafters([eaveFace]);
    const angles = rs.map((r) => {
      const p = r.properties as Record<string, number>;
      return Math.round((Math.atan2(p.by - p.ay, p.bx - p.ax) * 180) / Math.PI);
    });
    expect(new Set(angles).size).toBe(1);
  });

  it('does not frame non-slope faces', () => {
    const flat: RoofFace3D = { ...eaveFace, id: 'f_flat', role: 'gable_end' };
    expect(rafters([flat])).toHaveLength(0);
  });
});
