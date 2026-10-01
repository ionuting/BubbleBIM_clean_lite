/**
 * overlay.ts — placing a flat map image on the globe.
 *
 * A site plan, a cadastral extract or an orthophoto arrives as a picture plus
 * two corner coordinates, and those corners are almost never in WGS84 — they
 * are in whatever grid the surveyor works in.
 *
 * ── Why this is not just a bounding box ───────────────────────────────────
 * The obvious implementation converts the two corners to latitude/longitude
 * and hands Cesium that rectangle. It is wrong, and quietly so. The image's
 * edges are lines of constant easting and northing; those are not lines of
 * constant longitude and latitude, because grid north is tilted from true
 * north by the meridian convergence. On a 200 m site plan in Stereo 70 at
 * Bucharest the convergence is 0.78° and the corners land 2.7 m out — on a
 * plan whose whole purpose is to show where the building sits.
 *
 * So the placement carries a ROTATION, measured the same way the rest of this
 * module measures convergence: by projecting a point one metre north and
 * looking at where it went. Cesium's rectangle takes a rotation directly.
 * `skewM` reports what a renderer that ignores it would cost.
 */

import { convert, isKnownCrs, WGS84 } from './crs';
import { trueNorthInGrid } from './georeference';
import type { GeoPoint } from './crs';

/** Geographic bounds, degrees. */
export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface OverlayCorners {
  /** CRS the two corners are given in. */
  crs: string;
  /** Lower-left corner, in `crs` units (east/north, or lng/lat for WGS84). */
  minX: number;
  minY: number;
  /** Upper-right corner. */
  maxX: number;
  maxY: number;
}

export interface OverlayPlacement {
  /** Geographic centre of the image. */
  centre: GeoPoint;
  /** Ground size along the grid's own axes, metres. */
  widthM: number;
  heightM: number;
  /**
   * Rotation of the image, radians, counter-clockwise from TRUE north —
   * exactly what Cesium's `RectangleGraphics.rotation` and `stRotation` want.
   * Negative east of a central meridian in the northern hemisphere.
   */
  rotation: number;
  /**
   * The unrotated rectangle Cesium rotates about its centre. Also the correct
   * placement on its own for a caller that cannot rotate AND whose `skewM` is
   * small enough not to matter.
   */
  bounds: GeoBounds;
  /**
   * How far a corner lands from the truth if `rotation` is ignored, metres.
   * Quote it in a warning rather than hiding it.
   */
  skewM: number;
}

export type OverlayError =
  | 'unknown-crs'
  | 'degenerate'
  | 'out-of-range'
  | 'crosses-antimeridian';

export type OverlayResult =
  | { ok: true; placement: OverlayPlacement }
  | { ok: false; error: OverlayError; message: string };

const DEG = Math.PI / 180;

/** Metres per degree of latitude / longitude at a latitude. WGS84. */
function metresPerDegree(lat: number): { perLat: number; perLng: number } {
  return {
    perLat: 111_132.92 - 559.82 * Math.cos(2 * lat * DEG) + 1.175 * Math.cos(4 * lat * DEG),
    perLng: 111_412.84 * Math.cos(lat * DEG) - 93.5 * Math.cos(3 * lat * DEG),
  };
}

/** Corner coordinates in any CRS → a rotated placement on the globe. */
export function placeOverlay(c: OverlayCorners): OverlayResult {
  if (!isKnownCrs(c.crs)) {
    return { ok: false, error: 'unknown-crs', message: `Sistem necunoscut: ${c.crs}` };
  }
  if (![c.minX, c.minY, c.maxX, c.maxY].every(Number.isFinite)) {
    return { ok: false, error: 'degenerate', message: 'Coordonate incomplete.' };
  }
  if (c.maxX <= c.minX || c.maxY <= c.minY) {
    return {
      ok: false, error: 'degenerate',
      message: 'Colțul dreapta-sus trebuie să fie la est și la nord de stânga-jos.',
    };
  }

  // Ground size along the grid axes. These are grid metres; the point scale
  // factor makes them differ from true ground metres by well under a decimetre
  // per kilometre in every system shipped here, which no raster resolves.
  const widthM = c.maxX - c.minX;
  const heightM = c.maxY - c.minY;

  let centre: GeoPoint;
  try {
    const mid = convert(
      { x: (c.minX + c.maxX) / 2, y: (c.minY + c.maxY) / 2 },
      c.crs, WGS84,
    );
    centre = { lat: mid.y, lng: mid.x };
  } catch {
    return { ok: false, error: 'unknown-crs', message: `Conversia din ${c.crs} a eșuat.` };
  }

  if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lng)
      || Math.abs(centre.lat) > 90) {
    return {
      ok: false, error: 'out-of-range',
      message: 'Coordonatele cad în afara domeniului sistemului ales.',
    };
  }

  // Grid north, expressed counter-clockwise from true north. `trueNorthInGrid`
  // gives the opposite direction (true north in grid axes), and the inverse of
  // a rotation is its negation — which is what swapping the atan2 arguments
  // from (-e, n) to (e, n) does.
  const tn = c.crs === WGS84 ? { e: 0, n: 1 } : trueNorthInGrid(centre, c.crs);
  const rotation = Math.atan2(tn.e, tn.n);

  const { perLat, perLng } = metresPerDegree(centre.lat);
  const halfLat = heightM / 2 / perLat;
  const halfLng = widthM / 2 / perLng;
  const bounds: GeoBounds = {
    west: centre.lng - halfLng,
    east: centre.lng + halfLng,
    south: centre.lat - halfLat,
    north: centre.lat + halfLat,
  };

  if (bounds.east - bounds.west > 180) {
    return {
      ok: false, error: 'crosses-antimeridian',
      message: 'Zona traversează antimeridianul; împarte harta în două.',
    };
  }

  return { ok: true, placement: { centre, widthM, heightM, rotation, bounds, skewM: skewOf(c, bounds) } };
}

/**
 * What ignoring the rotation costs, in metres: the worst distance between a
 * corner's true position and the corresponding corner of the unrotated
 * rectangle. Measured, not estimated — the same discipline as the convergence.
 */
function skewOf(c: OverlayCorners, bounds: GeoBounds): number {
  try {
    const corners: Array<[number, number, number, number]> = [
      [c.minX, c.minY, bounds.west, bounds.south],
      [c.maxX, c.minY, bounds.east, bounds.south],
      [c.maxX, c.maxY, bounds.east, bounds.north],
      [c.minX, c.maxY, bounds.west, bounds.north],
    ];
    let worst = 0;
    for (const [gx, gy, blng, blat] of corners) {
      const t = convert({ x: gx, y: gy }, c.crs, WGS84);
      const { perLat, perLng } = metresPerDegree(t.y);
      worst = Math.max(worst, Math.hypot((t.x - blng) * perLng, (t.y - blat) * perLat));
    }
    return worst;
  } catch {
    return NaN;
  }
}

/**
 * Corners centred on a point — the quick way to place an image when its size
 * is known but its corner coordinates are not.
 */
export function cornersAround(
  centre: { x: number; y: number },
  crs: string,
  widthM: number,
  heightM: number,
): OverlayCorners {
  return {
    crs,
    minX: centre.x - widthM / 2,
    minY: centre.y - heightM / 2,
    maxX: centre.x + widthM / 2,
    maxY: centre.y + heightM / 2,
  };
}

/** Rough ground size of a geographic rectangle, metres. For a sanity readout. */
export function groundSize(b: GeoBounds): { widthM: number; heightM: number } {
  const { perLat, perLng } = metresPerDegree((b.north + b.south) / 2);
  return { widthM: (b.east - b.west) * perLng, heightM: (b.north - b.south) * perLat };
}
