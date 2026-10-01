/**
 * cameraSync.ts — one camera, two renderers.
 *
 * Variant A of the World view draws fragments with Three.js on a transparent
 * canvas over Cesium's. For that to look like a single scene, the Three camera
 * has to stand exactly where Cesium's camera stands, every frame.
 *
 * The obstacle is precision, not geometry. Cesium works in earth-centred,
 * earth-fixed coordinates — metres from the centre of the planet — in double
 * precision. Three.js uploads float32. At a radius of 6 378 000 m a float32
 * resolves to roughly half a metre, so a model placed in ECEF would visibly
 * jitter and swim as the camera moves. Nothing about the maths is wrong; the
 * numbers are simply too large for the mantissa.
 *
 * The fix is the standard one: never put large numbers in the Three scene.
 * The scene's origin is pinned at the model's own anchor, and this module
 * expresses Cesium's camera IN THAT LOCAL FRAME. Coordinates become metres
 * from the site — a few hundred at most — where float32 has millimetre
 * resolution to spare.
 *
 * Everything here is pure and Cesium-free. The ENU basis is computed from
 * latitude and longitude directly, so the maths can be tested without a
 * WebGL context, and the viewer only has to hand over numbers Cesium already
 * exposes (`positionWC`, `directionWC`, `upWC`, and the frustum).
 */

export interface Vec3 { x: number; y: number; z: number }

const DEG = Math.PI / 180;
/** WGS84. The same ellipsoid Cesium uses, so the two frames agree. */
const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

export function vec(x: number, y: number, z: number): Vec3 { return { x, y, z }; }
const sub = (a: Vec3, b: Vec3): Vec3 => vec(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export function normalise(a: Vec3): Vec3 {
  const l = len(a);
  return l === 0 ? vec(0, 0, 0) : vec(a.x / l, a.y / l, a.z / l);
}

/**
 * Geodetic latitude/longitude/height → earth-centred, earth-fixed metres.
 *
 * Kept here rather than borrowed from Cesium so the frame this module works
 * in is defined by this module, and so the tests need nothing but numbers.
 */
export function geodeticToEcef(latDeg: number, lngDeg: number, height = 0): Vec3 {
  const lat = latDeg * DEG;
  const lng = lngDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  // Radius of curvature in the prime vertical.
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return vec(
    (n + height) * cosLat * Math.cos(lng),
    (n + height) * cosLat * Math.sin(lng),
    (n * (1 - E2) + height) * sinLat,
  );
}

/**
 * The local east-north-up basis at a point on the ellipsoid, as three unit
 * vectors in ECEF. Orthonormal by construction, so its inverse is its
 * transpose — which is why converting a direction below is three dot
 * products rather than a matrix solve.
 */
export interface EnuBasis { origin: Vec3; east: Vec3; north: Vec3; up: Vec3 }

export function enuBasis(latDeg: number, lngDeg: number, height = 0): EnuBasis {
  const lat = latDeg * DEG;
  const lng = lngDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLng = Math.sin(lng);
  const cosLng = Math.cos(lng);
  return {
    origin: geodeticToEcef(latDeg, lngDeg, height),
    east: vec(-sinLng, cosLng, 0),
    north: vec(-sinLat * cosLng, -sinLat * sinLng, cosLat),
    up: vec(cosLat * cosLng, cosLat * sinLng, sinLat),
  };
}

/** An ECEF point → metres east, north and up of the basis origin. */
export function ecefToEnu(p: Vec3, b: EnuBasis): Vec3 {
  const d = sub(p, b.origin);
  return vec(dot(d, b.east), dot(d, b.north), dot(d, b.up));
}

/** An ECEF direction → the same direction in local axes. No translation. */
export function directionToEnu(d: Vec3, b: EnuBasis): Vec3 {
  return vec(dot(d, b.east), dot(d, b.north), dot(d, b.up));
}

/** The inverse, for turning a local point back into something Cesium can use. */
export function enuToEcef(p: Vec3, b: EnuBasis): Vec3 {
  return vec(
    b.origin.x + p.x * b.east.x + p.y * b.north.x + p.z * b.up.x,
    b.origin.y + p.x * b.east.y + p.y * b.north.y + p.z * b.up.y,
    b.origin.z + p.x * b.east.z + p.y * b.north.z + p.z * b.up.z,
  );
}

/**
 * What the viewer reads off Cesium each frame. Named after the Cesium
 * properties they come from so the wiring is obvious at the call site.
 */
export interface CesiumCameraState {
  positionWC: Vec3;
  directionWC: Vec3;
  upWC: Vec3;
  /** Vertical field of view in RADIANS. Cesium's `frustum.fovy`. */
  fovy: number;
  aspect: number;
  near: number;
  far: number;
}

/**
 * Where the Three camera must stand, in the app's own axis convention.
 *
 * The rest of this codebase draws in Three coordinates where +x is east,
 * +y is up and −z is north (see `extrudeGeometry.toThree`). The conversion
 * from the east/north/up triple happens HERE, once, rather than in every
 * consumer — and it is the single place to look when the overlay comes out
 * mirrored or a quarter-turn off.
 */
export interface ThreeCameraPose {
  position: Vec3;
  /** A point to look at; `direction` is kept too for callers that prefer it. */
  target: Vec3;
  direction: Vec3;
  up: Vec3;
  /** Degrees, for THREE.PerspectiveCamera.fov. */
  fovDeg: number;
  aspect: number;
  near: number;
  far: number;
}

/** east/north/up metres → the app's Three axes. */
export function enuToThree(p: Vec3): Vec3 { return vec(p.x, p.z, -p.y); }

/**
 * The whole job: Cesium's camera, expressed for Three, relative to `basis`.
 *
 * `near` and `far` are NOT copied blindly. Cesium runs a far plane in the
 * millions of metres because it draws a planet; handing that to Three would
 * spend the entire depth buffer on empty space and z-fight the model against
 * itself. They are clamped to a range that suits a building, which is all
 * this layer ever draws.
 */
export function syncCamera(
  cam: CesiumCameraState,
  basis: EnuBasis,
  opts: { minNear?: number; maxFar?: number } = {},
): ThreeCameraPose {
  const position = enuToThree(ecefToEnu(cam.positionWC, basis));
  const direction = enuToThree(directionToEnu(normalise(cam.directionWC), basis));
  const up = enuToThree(directionToEnu(normalise(cam.upWC), basis));

  const minNear = opts.minNear ?? 0.05;
  const maxFar = opts.maxFar ?? 50_000;
  // The near plane follows the camera's distance from the site: standing a
  // kilometre away, a 5 cm near plane wastes almost all of the depth buffer.
  const distance = len(position);
  const near = Math.max(minNear, Math.min(cam.near, distance / 1000));
  const far = Math.min(maxFar, Math.max(near * 10, cam.far, distance * 4));

  return {
    position,
    direction,
    up,
    target: vec(
      position.x + direction.x, position.y + direction.y, position.z + direction.z,
    ),
    fovDeg: (cam.fovy * 180) / Math.PI,
    aspect: cam.aspect,
    near,
    far,
  };
}

/**
 * How far the camera has wandered from the frame's origin, in metres.
 *
 * Float32 keeps about seven significant digits, so a scene origin ten
 * kilometres from the camera still resolves to a millimetre — fine. At a
 * thousand kilometres it is centimetres, and beyond that the model starts to
 * shimmer. The viewer watches this number and re-anchors the frame when it
 * grows, which is cheap: a new basis and a rebuilt scene transform.
 */
export function originDistance(cam: CesiumCameraState, basis: EnuBasis): number {
  return len(ecefToEnu(cam.positionWC, basis));
}

/** Past this, re-anchor. Chosen well inside where float32 stops being exact. */
export const REANCHOR_DISTANCE_M = 200_000;

export function needsReanchor(cam: CesiumCameraState, basis: EnuBasis): boolean {
  return originDistance(cam, basis) > REANCHOR_DISTANCE_M;
}
