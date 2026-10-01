/**
 * georeference.ts — the one description of where the model actually stands.
 *
 * The app already knew this in `WorldLocation` (lat/lng/alt + ENU offsets +
 * heading), but only Cesium ever read it. A `GeoReference` is the same fact
 * said in the terms a CRS and an IFC file use: a point on a projected grid,
 * plus the direction the model's own +X axis points in that grid.
 *
 * ── The two norths ────────────────────────────────────────────────────────
 * `WorldLocation.rotation` is a Cesium heading: clockwise from TRUE north
 * (see WorldViewer's `headingPitchRollToFixedFrame` call). `IfcMapConversion`
 * wants the model axis expressed in GRID axes, and grid north is not true
 * north — they differ by the meridian convergence, which reaches a degree or
 * two in Stereo 70 away from the 25°E central meridian. A degree is ~1.7 m
 * over a 100 m building: small enough to look fine, large enough to fail a
 * survey.
 *
 * Rather than pick a convergence formula per projection (and a sign
 * convention to go with it), this module MEASURES it: project the origin,
 * project a point one metre true-north of it, and take the difference. That
 * is exact for whatever proj4 was handed, and has no convention to get
 * backwards.
 */

import type { WorldLocation } from '@/store';
import { project, unproject, type GeoPoint, type MapPoint } from './crs';

/** Semi-major axis and first eccentricity squared, WGS84. */
const A = 6378137.0;
const E2 = 0.00669437999014;
const DEG = Math.PI / 180;

/**
 * Where a model sits in the world, in the terms IFC uses.
 *
 * `eastings`/`northings`/`orthogonalHeight` place the model's ORIGIN (BIM
 * 0,0,0) on the grid. `xAxisAbscissa`/`xAxisOrdinate` are the east and north
 * components of the model's +X direction — a unit vector, so the pair also
 * encodes the rotation without a separate angle to disagree with.
 */
export interface GeoReference {
  /** Projected CRS code, e.g. 'EPSG:3844'. */
  crs: string;
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  /** East component of the model's +X axis in grid axes. */
  xAxisAbscissa: number;
  /** North component of the model's +X axis in grid axes. */
  xAxisOrdinate: number;
  /**
   * Model units → map units. 1 means the model is in ground distances, which
   * is what a building model almost always is; set the combined grid factor
   * only if the survey was delivered in grid distances.
   */
  scale: number;
  /** Geodetic position of the model origin — what IfcSite carries. */
  lat: number;
  lng: number;
  /** Height of the model origin, metres. Same number as orthogonalHeight. */
  elevation: number;
}

/** Meridional radius of curvature at `lat` (degrees). */
function meridionalRadius(lat: number): number {
  const s = Math.sin(lat * DEG);
  return (A * (1 - E2)) / Math.pow(1 - E2 * s * s, 1.5);
}

/** Prime-vertical radius of curvature at `lat` (degrees). */
function primeVerticalRadius(lat: number): number {
  const s = Math.sin(lat * DEG);
  return A / Math.sqrt(1 - E2 * s * s);
}

/**
 * Move a geodetic point by a local East/North offset in metres.
 *
 * First-order on the ellipsoid — good to millimetres over the kilometres an
 * ENU offset is ever used for here, and it keeps the offset meaning exactly
 * what it means in Cesium, which applies it in the same local ENU frame.
 */
export function offsetGeo(p: GeoPoint, east: number, north: number): GeoPoint {
  if (east === 0 && north === 0) return { lat: p.lat, lng: p.lng };
  const dLat = north / meridionalRadius(p.lat) / DEG;
  const dLng = east / (primeVerticalRadius(p.lat) * Math.cos(p.lat * DEG)) / DEG;
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

/**
 * The direction of TRUE north at `p`, expressed as a unit vector in the grid
 * axes of `crs` — i.e. measured convergence, not assumed zero.
 *
 * Returns grid north `(0, 1)` if the two projected points coincide, which can
 * only happen if the CRS is degenerate at that point; better a straight model
 * than a NaN one.
 */
export function trueNorthInGrid(p: GeoPoint, crs: string): { e: number; n: number } {
  const here = project(p, crs);
  const ahead = project(offsetGeo(p, 0, 1), crs);
  const de = ahead.e - here.e;
  const dn = ahead.n - here.n;
  const len = Math.hypot(de, dn);
  if (!(len > 1e-9)) return { e: 0, n: 1 };
  return { e: de / len, n: dn / len };
}

/**
 * `WorldLocation` → `GeoReference`, in the given projected CRS.
 *
 * The ENU offsets are applied geodetically (not by adding metres to eastings)
 * so the result agrees with where Cesium actually draws the model.
 */
export function georefFromWorldLocation(
  loc: WorldLocation,
  crs: string,
  scale = 1,
): GeoReference {
  const origin = offsetGeo({ lat: loc.lat, lng: loc.lng }, loc.offsetE, loc.offsetN);
  const map = project(origin, crs);
  const north = trueNorthInGrid(origin, crs);
  // True east in grid axes: true north turned 90° clockwise.
  const east = { e: north.n, n: -north.e };

  // The model's +Y points at true bearing `rotation` (clockwise from north),
  // so +X points at `rotation + 90°`.
  const r = loc.rotation * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);

  return {
    crs,
    eastings: map.e,
    northings: map.n,
    orthogonalHeight: loc.alt + loc.offsetZ,
    xAxisAbscissa: -sin * north.e + cos * east.e,
    xAxisOrdinate: -sin * north.n + cos * east.n,
    scale,
    lat: origin.lat,
    lng: origin.lng,
    elevation: loc.alt + loc.offsetZ,
  };
}

/**
 * `GeoReference` → `WorldLocation`, the inverse of the above.
 *
 * Everything lands in lat/lng/alt with zero ENU offsets: the offsets exist so
 * a user can nudge a model on the globe, and a round trip has no way to know
 * (or reason to care) how the original was split between base point and nudge.
 * `georefFromWorldLocation` of the result reproduces the same GeoReference.
 */
export function worldLocationFromGeoref(gr: GeoReference): WorldLocation {
  const origin = unproject({ e: gr.eastings, n: gr.northings }, gr.crs);
  const north = trueNorthInGrid(origin, gr.crs);
  const east = { e: north.n, n: -north.e };

  // Invert the projection of +X onto (north, east): the components ARE the
  // sine and cosine of the heading, because (north, east) is orthonormal.
  const x = { e: gr.xAxisAbscissa, n: gr.xAxisOrdinate };
  const alongEast = x.e * east.e + x.n * east.n;   //  cos(rotation)
  const alongNorth = x.e * north.e + x.n * north.n; // -sin(rotation)
  const rotation = Math.atan2(-alongNorth, alongEast) / DEG;

  return {
    lat: origin.lat,
    lng: origin.lng,
    alt: gr.orthogonalHeight,
    offsetE: 0,
    offsetN: 0,
    offsetZ: 0,
    // Rounded at a millionth of a degree — below anything a survey resolves,
    // and it keeps a file's 90° from reading back as 89.99999997. The `+ 0`
    // turns a -0 into 0, which would otherwise serialise as "-0".
    rotation: Math.round(rotation * 1e6) / 1e6 + 0,
  };
}

/** Heading of the model's +Y axis, degrees clockwise from true north. */
export function headingOf(gr: GeoReference): number {
  return worldLocationFromGeoref(gr).rotation;
}

/** A map point → the model's own XY coordinates, in metres. */
export function mapToModel(gr: GeoReference, p: MapPoint): { x: number; y: number } {
  const de = (p.e - gr.eastings) / gr.scale;
  const dn = (p.n - gr.northings) / gr.scale;
  // The grid→model rotation is the transpose of model→grid, since the axes
  // are orthonormal: +X is (abscissa, ordinate) and +Y is that turned 90° CCW.
  const xe = gr.xAxisAbscissa, xn = gr.xAxisOrdinate;
  return { x: de * xe + dn * xn, y: -de * xn + dn * xe };
}

/** The model's own XY coordinates, in metres → a map point. */
export function modelToMap(gr: GeoReference, p: { x: number; y: number }): MapPoint {
  const xe = gr.xAxisAbscissa, xn = gr.xAxisOrdinate;
  return {
    e: gr.eastings + gr.scale * (p.x * xe - p.y * xn),
    n: gr.northings + gr.scale * (p.x * xn + p.y * xe),
  };
}

// ── IFC compound plane angle ────────────────────────────────────────────────

/**
 * Degrees → IFC's `IfcCompoundPlaneAngleMeasure`:
 * `[degrees, minutes, seconds, millionths of a second]`.
 *
 * The spec requires every non-zero component to carry the same sign, which is
 * why the split is done on the absolute value and signed at the end — doing it
 * the other way round produces things like `(-44, 25, 36)`, which some readers
 * take as -44° +25' and land the model 25 arc-minutes away.
 */
export function toCompoundAngle(deg: number): [number, number, number, number] {
  const sign = deg < 0 ? -1 : 1;
  // Round at the millionth-of-a-second first, so carries propagate cleanly
  // instead of leaving 59'60".
  let total = Math.round(Math.abs(deg) * 3600 * 1e6);
  const millionths = total % 1e6; total = (total - millionths) / 1e6;
  const seconds = total % 60;     total = (total - seconds) / 60;
  const minutes = total % 60;     total = (total - minutes) / 60;
  return [sign * total, sign * minutes, sign * seconds, sign * millionths];
}

/** IFC compound plane angle → degrees. Accepts the 3- or 4-part form. */
export function fromCompoundAngle(parts: number[]): number {
  const [d = 0, m = 0, s = 0, u = 0] = parts;
  const sign = parts.find((v) => v !== 0) ?? 0;
  const mag = Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600 + Math.abs(u) / 3.6e9;
  return sign < 0 ? -mag : mag;
}
