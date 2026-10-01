/**
 * The overlay lives or dies on this maths: if the Three camera is a metre or
 * a degree away from Cesium's, the model visibly slides against the map as
 * you orbit. Every case here is a way that can happen.
 */
import { describe, expect, it } from 'vitest';
import {
  ecefToEnu, directionToEnu, enuBasis, enuToEcef, enuToThree, geodeticToEcef,
  needsReanchor, normalise, originDistance, syncCamera, vec,
  REANCHOR_DISTANCE_M, type CesiumCameraState, type Vec3,
} from './cameraSync';

const BUC = { lat: 44.4268, lng: 26.1025 };
const close = (a: Vec3, b: Vec3, mm = 1) => {
  expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 1000).toBeLessThan(mm);
};

describe('geodeticToEcef', () => {
  it('puts the equator at the semi-major axis and the pole on the polar one', () => {
    const eq = geodeticToEcef(0, 0);
    expect(eq.x).toBeCloseTo(6378137, 3);
    expect(eq.y).toBeCloseTo(0, 6);
    expect(eq.z).toBeCloseTo(0, 6);

    const pole = geodeticToEcef(90, 0);
    // Polar radius: a(1 − f) = 6 356 752.314…
    expect(pole.z).toBeCloseTo(6356752.314, 2);
    expect(Math.hypot(pole.x, pole.y)).toBeLessThan(1e-6);
  });

  it('puts 90° east on the +y axis, which fixes the handedness', () => {
    const p = geodeticToEcef(0, 90);
    expect(p.y).toBeCloseTo(6378137, 3);
    expect(Math.abs(p.x)).toBeLessThan(1e-6);
  });

  it('adds height along the surface normal', () => {
    const a = geodeticToEcef(BUC.lat, BUC.lng, 0);
    const b = geodeticToEcef(BUC.lat, BUC.lng, 100);
    expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeCloseTo(100, 6);
  });
});

describe('the local frame', () => {
  const basis = enuBasis(BUC.lat, BUC.lng, 85);

  it('is orthonormal, which is what lets the inverse be three dot products', () => {
    for (const v of [basis.east, basis.north, basis.up]) {
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 12);
    }
    const d = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
    expect(d(basis.east, basis.north)).toBeCloseTo(0, 12);
    expect(d(basis.east, basis.up)).toBeCloseTo(0, 12);
    expect(d(basis.north, basis.up)).toBeCloseTo(0, 12);
  });

  it('is right-handed: east × north points up', () => {
    const c = vec(
      basis.east.y * basis.north.z - basis.east.z * basis.north.y,
      basis.east.z * basis.north.x - basis.east.x * basis.north.z,
      basis.east.x * basis.north.y - basis.east.y * basis.north.x,
    );
    close(c, basis.up, 1e-6);
  });

  it('places its own origin at zero', () => {
    close(ecefToEnu(basis.origin, basis), vec(0, 0, 0));
  });

  it('round-trips a local point through ECEF and back', () => {
    for (const p of [vec(0, 0, 0), vec(120, -45, 8), vec(-3000, 2000, -50)]) {
      close(ecefToEnu(enuToEcef(p, basis), basis), p, 0.01);
    }
  });

  it('measures a step east as a step east', () => {
    // 100 m east of the origin, as a real geodetic move.
    const eastPoint = enuToEcef(vec(100, 0, 0), basis);
    const back = ecefToEnu(eastPoint, basis);
    expect(back.x).toBeCloseTo(100, 6);
    expect(Math.abs(back.y)).toBeLessThan(1e-6);
  });

  it('rotates a direction without translating it', () => {
    // Straight up in ECEF at this point IS the basis up vector.
    close(directionToEnu(basis.up, basis), vec(0, 0, 1), 1e-6);
    close(directionToEnu(basis.east, basis), vec(1, 0, 0), 1e-6);
    close(directionToEnu(basis.north, basis), vec(0, 1, 0), 1e-6);
  });
});

describe('enuToThree', () => {
  it('sends up to Three Y and north to negative Three Z, like the rest of the app', () => {
    close(enuToThree(vec(1, 0, 0)), vec(1, 0, 0));      // east  → +x
    close(enuToThree(vec(0, 1, 0)), vec(0, 0, -1));     // north → −z
    close(enuToThree(vec(0, 0, 1)), vec(0, 1, 0));      // up    → +y
  });
});

describe('syncCamera', () => {
  const basis = enuBasis(BUC.lat, BUC.lng, 85);

  /** A camera 300 m up, looking straight down, with north up the screen. */
  const overhead = (): CesiumCameraState => ({
    positionWC: enuToEcef(vec(0, 0, 300), basis),
    directionWC: normalise(vec(-basis.up.x, -basis.up.y, -basis.up.z)),
    upWC: basis.north,
    fovy: Math.PI / 3,
    aspect: 16 / 9,
    near: 1,
    far: 10_000_000,
  });

  it('stands the Three camera where Cesium stands, in local metres', () => {
    const pose = syncCamera(overhead(), basis);
    close(pose.position, vec(0, 300, 0), 1);     // 300 m up is +y in Three
  });

  it('keeps small numbers in the scene, which is the entire point', () => {
    const pose = syncCamera(overhead(), basis);
    // An ECEF position is ~6.4 million; anything of that size here would mean
    // the frame conversion silently did nothing and float32 would shimmer.
    expect(Math.abs(pose.position.x)).toBeLessThan(10_000);
    expect(Math.abs(pose.position.y)).toBeLessThan(10_000);
    expect(Math.abs(pose.position.z)).toBeLessThan(10_000);
  });

  it('looks where Cesium looks', () => {
    const pose = syncCamera(overhead(), basis);
    close(pose.direction, vec(0, -1, 0), 1e-3);   // straight down
    close(pose.up, vec(0, 0, -1), 1e-3);          // north, which is −z
  });

  it('gives a target one metre along the view direction', () => {
    const pose = syncCamera(overhead(), basis);
    close(vec(
      pose.target.x - pose.position.x,
      pose.target.y - pose.position.y,
      pose.target.z - pose.position.z,
    ), pose.direction, 1e-6);
  });

  it('turns the field of view into the degrees Three wants', () => {
    expect(syncCamera(overhead(), basis).fovDeg).toBeCloseTo(60, 9);
  });

  it('refuses Cesium\'s planetary far plane, which would z-fight the model', () => {
    const pose = syncCamera(overhead(), basis);
    expect(pose.far).toBeLessThanOrEqual(50_000);
    expect(pose.far).toBeGreaterThan(pose.near * 10);
  });

  it('opens the near plane as the camera pulls away, so depth is not wasted', () => {
    const near1 = syncCamera(overhead(), basis).near;
    const far = { ...overhead(), positionWC: enuToEcef(vec(0, 0, 20_000), basis) };
    const near2 = syncCamera(far, basis).near;
    expect(near2).toBeGreaterThan(near1);
    expect(near1).toBeGreaterThanOrEqual(0.05);
  });

  it('never lets the near plane reach zero, whatever the camera does', () => {
    const atOrigin = { ...overhead(), positionWC: basis.origin };
    expect(syncCamera(atOrigin, basis).near).toBeGreaterThan(0);
    expect(syncCamera(atOrigin, basis).far).toBeGreaterThan(syncCamera(atOrigin, basis).near);
  });

  it('is exact for a camera looking at the site from any bearing', () => {
    // Orbiting must not drift: every bearing lands the camera at the same
    // distance from the origin, on the plane it was put on.
    for (const bearing of [0, 37, 90, 180, 271]) {
      const r = (bearing * Math.PI) / 180;
      const local = vec(400 * Math.sin(r), 400 * Math.cos(r), 150);
      const cam: CesiumCameraState = {
        ...overhead(), positionWC: enuToEcef(local, basis),
      };
      const pose = syncCamera(cam, basis);
      expect(Math.hypot(pose.position.x, pose.position.z)).toBeCloseTo(400, 2);
      expect(pose.position.y).toBeCloseTo(150, 2);
    }
  });
});

describe('re-anchoring', () => {
  const basis = enuBasis(BUC.lat, BUC.lng);
  const at = (local: Vec3): CesiumCameraState => ({
    positionWC: enuToEcef(local, basis),
    directionWC: vec(0, 0, -1), upWC: vec(0, 1, 0),
    fovy: 1, aspect: 1, near: 1, far: 1000,
  });

  it('measures how far the camera has wandered from the frame origin', () => {
    expect(originDistance(at(vec(300, 400, 0)), basis)).toBeCloseTo(500, 1);
  });

  it('asks for a new frame only once precision is genuinely at risk', () => {
    expect(needsReanchor(at(vec(0, 0, 500)), basis)).toBe(false);
    expect(needsReanchor(at(vec(50_000, 0, 0)), basis)).toBe(false);
    expect(needsReanchor(at(vec(REANCHOR_DISTANCE_M + 1000, 0, 0)), basis)).toBe(true);
  });
});

describe('normalise', () => {
  it('leaves a zero vector alone instead of producing NaN', () => {
    expect(normalise(vec(0, 0, 0))).toEqual(vec(0, 0, 0));
  });

  it('returns unit length for anything else', () => {
    expect(Math.hypot(...Object.values(normalise(vec(3, 4, 12))))).toBeCloseTo(1, 12);
  });
});
