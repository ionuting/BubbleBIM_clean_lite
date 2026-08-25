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
import { buildRoofEnvelope } from './skeleton';
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

/**
 * The re-entrant-corner case: a small face wedged between two valleys, where
 * EVERY edge slopes — there is no level edge anywhere on it. This is the face
 * that shows up as a bare patch in the notch of an L-shaped roof.
 */
const kiteFace: RoofFace3D = {
  id: 'f_kite',
  role: 'slope',
  vertices: [
    { x: 5000, y: 5000, z: BASE_Z },              // the inner corner, lowest
    { x: 6800, y: 4200, z: BASE_Z + 1039 },       // up one valley
    { x: 7600, y: 5400, z: BASE_Z + 1800 },       // apex
    { x: 5900, y: 6300, z: BASE_Z + 1039 },       // back down the other valley
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

  it('frames a valley-wedged face whose every edge slopes', () => {
    // No level edge at all — the bare patch in an L-shaped roof's notch.
    const levelEdges = kiteFace.vertices.filter((v, i) => {
      const w = kiteFace.vertices[(i + 1) % kiteFace.vertices.length];
      return Math.abs(v.z - w.z) < 1;
    });
    expect(levelEdges).toHaveLength(0);
    expect(rafters([kiteFace]).length).toBeGreaterThan(0);
  });

  it('runs those rafters up the slope, inside the face', () => {
    const zs = kiteFace.vertices.map((v) => v.z);
    for (const r of rafters([kiteFace])) {
      const p = r.properties as Record<string, number>;
      expect(p.bz).toBeGreaterThan(p.az);
      // Every endpoint stays within the face's own height range.
      for (const z of [p.az, p.bz]) {
        expect(z).toBeGreaterThanOrEqual(Math.min(...zs) - 1);
        expect(z).toBeLessThanOrEqual(Math.max(...zs) + 1);
      }
    }
  });

  it('spaces rafters at roughly the requested interval', () => {
    const rs = rafters([eaveFace]);
    const along = rs
      .map((r) => {
        const p = r.properties as Record<string, number>;
        return Math.hypot(p.ax - 0, p.ay - 0);
      })
      .sort((a, b) => a - b);
    const gaps = along.slice(1).map((v, i) => v - along[i]);
    for (const g of gaps) expect(g).toBeLessThanOrEqual(intent.rafterSpacingMm + 1);
  });

  it('does not frame non-slope faces', () => {
    const flat: RoofFace3D = { ...eaveFace, id: 'f_flat', role: 'gable_end' };
    expect(rafters([flat])).toHaveLength(0);
  });
});

/** Plan-space point-in-polygon (ray casting). */
function inPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y)
      && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

describe('every slope face of a real roof gets framed', () => {
  const L = [
    { x: 0, y: 0 }, { x: 12000, y: 0 }, { x: 12000, y: 6000 },
    { x: 6000, y: 6000 }, { x: 6000, y: 12000 }, { x: 0, y: 12000 },
  ];

  /** The same L rotated, which is what puts a valley-wedged face in the notch. */
  const rotated = (deg: number) => L.map((p) => {
    const a = (deg * Math.PI) / 180;
    return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) };
  });

  for (const [name, poly] of [['L', L], ['L rotated 30°', rotated(30)]] as const) {
    it(`leaves no bare face on an ${name} plan`, () => {
      const c: RoofContour = { points: poly, axIds: [], baseZ: BASE_Z, storeyId: 'st' };
      const { faces, skeleton } = buildRoofEnvelope(c, 'hip', 30, 'auto', 0, 'r1', []);
      const slopes = faces.filter((f) => f.role === 'slope' && f.vertices.length >= 3);
      expect(slopes.length).toBeGreaterThan(0);

      const rs = buildRoofFraming('r1', 'st', c, intent, skeleton, faces)
        .filter((n) => n.type === 'rafter');

      for (const f of slopes) {
        const plan = f.vertices.map((v) => ({ x: v.x, y: v.y }));
        const onFace = rs.filter((r) => {
          const p = r.properties as Record<string, number>;
          return inPolygon({ x: (p.ax + p.bx) / 2, y: (p.ay + p.by) / 2 }, plan);
        });
        expect(onFace.length, `face ${f.id} has no rafters`).toBeGreaterThan(0);
      }
    });
  }
});
