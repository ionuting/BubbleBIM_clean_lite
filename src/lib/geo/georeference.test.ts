import { describe, expect, it } from 'vitest';
import {
  fromCompoundAngle, georefFromWorldLocation, headingOf, mapToModel, modelToMap,
  offsetGeo, toCompoundAngle, trueNorthInGrid, worldLocationFromGeoref,
} from './georeference';
import { listCrs, project, registerCrs, unproject, utmCrs, utmZoneFor } from './crs';
import type { WorldLocation } from '@/store';

/** Bucharest, the app's default. */
const BUC = { lat: 44.4268, lng: 26.1025 };
const STEREO = 'EPSG:3844';

const loc = (over: Partial<WorldLocation> = {}): WorldLocation => ({
  lat: BUC.lat, lng: BUC.lng, alt: 85, offsetE: 0, offsetN: 0, offsetZ: 0, rotation: 0, ...over,
});

describe('crs', () => {
  it('puts Bucharest where Stereo 70 says it is', () => {
    // Independently checkable: Bucharest is east and north of the 500000/500000
    // false origin at 46°N 25°E — east of 25°E, south of 46°N.
    const p = project(BUC, STEREO);
    expect(p.e).toBeGreaterThan(500000);
    expect(p.n).toBeLessThan(500000);
    // ~87 km east, ~175 km south of the projection origin.
    expect(p.e).toBeCloseTo(587000, -4);
    expect(p.n).toBeCloseTo(325000, -4);
  });

  it('round-trips a projection to well under a millimetre', () => {
    const back = unproject(project(BUC, STEREO), STEREO);
    // Judge it in millimetres on the ground, not in decimal places: one
    // degree of latitude is ~111 km, so 1e-8° is about a millimetre.
    expect(Math.abs(back.lat - BUC.lat) * 111_320_000).toBeLessThan(1);
    expect(Math.abs(back.lng - BUC.lng) * 111_320_000 * Math.cos(BUC.lat * Math.PI / 180))
      .toBeLessThan(1);
  });

  it('applies the datum shift — Stereo 70 is not WGS84 dressed up', () => {
    // Without +towgs84 the result moves by ~100 m. Project the same point in a
    // CRS that differs ONLY by the missing shift and check they disagree.
    registerCrs({
      code: 'TEST:NOSHIFT', label: 'no shift', def:
        '+proj=sterea +lat_0=46 +lon_0=25 +k=0.99975 +x_0=500000 +y_0=500000 +ellps=krass +units=m +no_defs',
    });
    const a = project(BUC, STEREO);
    const b = project(BUC, 'TEST:NOSHIFT');
    expect(Math.hypot(a.e - b.e, a.n - b.n)).toBeGreaterThan(50);
  });

  it('builds UTM zones on demand', () => {
    expect(utmCrs(35)).toBe('EPSG:32635');
    expect(utmCrs(35, 'S')).toBe('EPSG:32735');
    expect(utmZoneFor(26.1)).toBe(35);
    expect(utmZoneFor(21.2)).toBe(34);
    expect(() => utmCrs(0)).toThrow();
    // Registered, so it shows up for a picker.
    expect(listCrs().some((c) => c.code === 'EPSG:32635')).toBe(true);
  });
});

describe('offsetGeo', () => {
  it('moves north and east by the metres asked for', () => {
    const p = offsetGeo(BUC, 0, 1000);
    const back = project(p, STEREO);
    const here = project(BUC, STEREO);
    expect(Math.hypot(back.e - here.e, back.n - here.n)).toBeCloseTo(1000, 0);
    expect(p.lat).toBeGreaterThan(BUC.lat);
    expect(p.lng).toBeCloseTo(BUC.lng, 12);
  });

  it('is identity for a zero offset', () => {
    expect(offsetGeo(BUC, 0, 0)).toEqual({ lat: BUC.lat, lng: BUC.lng });
  });
});

describe('trueNorthInGrid', () => {
  it('measures convergence rather than assuming it away', () => {
    // Near the 25°E central meridian grid north is essentially true north —
    // but not EXACTLY, and the residual is real rather than noise: the datum
    // shift means WGS84 25°E is not Pulkovo 1942(58) 25°E, so the point sits
    // a little off the meridian and picks up a genuine sliver of convergence.
    // It comes to ~1e-6 rad, i.e. 1 mm over a kilometre.
    const onMeridian = trueNorthInGrid({ lat: 45, lng: 25 }, STEREO);
    expect(Math.abs(onMeridian.e)).toBeLessThan(1e-5);
    expect(onMeridian.n).toBeCloseTo(1, 9);
    // Off it, they differ — and the sign flips with the side you are on.
    const east = trueNorthInGrid({ lat: 45, lng: 28 }, STEREO);
    const west = trueNorthInGrid({ lat: 45, lng: 22 }, STEREO);
    expect(Math.abs(east.e)).toBeGreaterThan(1e-3);
    expect(Math.sign(east.e)).toBe(-Math.sign(west.e));
  });

  it('always returns a unit vector', () => {
    for (const lng of [21, 25, 29]) {
      const v = trueNorthInGrid({ lat: 46, lng }, STEREO);
      expect(Math.hypot(v.e, v.n)).toBeCloseTo(1, 9);
    }
  });
});

describe('georefFromWorldLocation', () => {
  it('an unrotated model has +X along grid east, near the central meridian', () => {
    const gr = georefFromWorldLocation(loc({ lat: 45, lng: 25 }), STEREO);
    expect(gr.xAxisAbscissa).toBeCloseTo(1, 9);
    // Not exactly zero, and shouldn't be — see the convergence test above.
    expect(Math.abs(gr.xAxisOrdinate)).toBeLessThan(1e-5);
  });

  it('heading 90° turns the model so +X points SOUTH', () => {
    // rotation is clockwise from north and applies to the model's +Y (BIM
    // north). At 90° the model's north faces east, so its +X faces south.
    const gr = georefFromWorldLocation(loc({ lat: 45, lng: 25, rotation: 90 }), STEREO);
    expect(Math.abs(gr.xAxisAbscissa)).toBeLessThan(1e-5);
    expect(gr.xAxisOrdinate).toBeCloseTo(-1, 9);
  });

  it('the axis pair is always a unit vector, whatever the heading', () => {
    for (const rotation of [0, 17, 90, 180, 271, 359]) {
      const gr = georefFromWorldLocation(loc({ rotation }), STEREO);
      expect(Math.hypot(gr.xAxisAbscissa, gr.xAxisOrdinate)).toBeCloseTo(1, 9);
    }
  });

  it('applies ENU offsets geodetically, not by adding metres to eastings', () => {
    const plain = georefFromWorldLocation(loc(), STEREO);
    const moved = georefFromWorldLocation(loc({ offsetE: 300, offsetN: 400 }), STEREO);
    // 500 m away, but NOT exactly +300/+400 on the grid: convergence and the
    // scale factor both bite. Naive addition would give exactly 300/400.
    expect(Math.hypot(moved.eastings - plain.eastings, moved.northings - plain.northings))
      .toBeCloseTo(500, 0);
    expect(moved.eastings - plain.eastings).not.toBeCloseTo(300, 6);
  });

  it('carries height through as given', () => {
    const gr = georefFromWorldLocation(loc({ alt: 85, offsetZ: 3.5 }), STEREO);
    expect(gr.orthogonalHeight).toBe(88.5);
    expect(gr.elevation).toBe(88.5);
  });
});

describe('round trip', () => {
  it('WorldLocation → GeoReference → WorldLocation keeps the place and the heading', () => {
    for (const rotation of [0, 33.5, 90, 180, 300]) {
      const src = loc({ rotation, alt: 85 });
      const back = worldLocationFromGeoref(georefFromWorldLocation(src, STEREO));
      // Millimetres on the ground, not decimal places — the limit here is
      // proj4's own forward/inverse precision, ~0.1 mm.
      expect(Math.abs(back.lat - src.lat) * 111_320_000).toBeLessThan(2);
      expect(Math.abs(back.lng - src.lng) * 111_320_000).toBeLessThan(2);
      expect(back.alt).toBeCloseTo(src.alt, 6);
      // atan2 returns (-180,180]; compare as a bearing.
      expect(((back.rotation % 360) + 360) % 360).toBeCloseTo(rotation, 6);
    }
  });

  it('folds ENU offsets into the base point instead of inventing a split', () => {
    const src = loc({ offsetE: 250, offsetN: -120, offsetZ: 2 });
    const gr = georefFromWorldLocation(src, STEREO);
    const back = worldLocationFromGeoref(gr);
    expect(back.offsetE).toBe(0);
    expect(back.offsetN).toBe(0);
    // Re-deriving from the folded location gives the same reference back —
    // to under a millimetre. Not to the last bit: the outbound trip applied
    // the ENU offset with a first-order ellipsoid step, the return trip went
    // through the exact projection, and those differ by ~0.7 mm at 275 m out.
    const again = georefFromWorldLocation(back, STEREO);
    expect(Math.abs(again.eastings - gr.eastings)).toBeLessThan(0.005);
    expect(Math.abs(again.northings - gr.northings)).toBeLessThan(0.005);
    expect(again.xAxisAbscissa).toBeCloseTo(gr.xAxisAbscissa, 9);
  });

  it('survives a CRS with real convergence at the point', () => {
    const src = loc({ lat: 47.15, lng: 21.9, rotation: 45 });
    const back = worldLocationFromGeoref(georefFromWorldLocation(src, STEREO));
    expect(Math.abs(back.lat - src.lat) * 111_320_000).toBeLessThan(2);
    expect(Math.abs(back.lng - src.lng) * 111_320_000).toBeLessThan(2);
    // The heading survives even though grid north here is ~0.9° off true
    // north — which is the whole reason convergence is measured, not assumed.
    expect(back.rotation).toBeCloseTo(45, 6);
  });

  it('headingOf reads the heading straight off the reference', () => {
    const gr = georefFromWorldLocation(loc({ rotation: 123.5 }), STEREO);
    expect(headingOf(gr)).toBeCloseTo(123.5, 6);
  });
});

describe('model ↔ map', () => {
  it('the model origin is the reference point itself', () => {
    const gr = georefFromWorldLocation(loc({ rotation: 40 }), STEREO);
    const p = modelToMap(gr, { x: 0, y: 0 });
    expect(p.e).toBeCloseTo(gr.eastings, 9);
    expect(p.n).toBeCloseTo(gr.northings, 9);
  });

  it('round-trips an arbitrary point through the grid', () => {
    const gr = georefFromWorldLocation(loc({ rotation: 40 }), STEREO);
    const src = { x: 12.5, y: -80.25 };
    const back = mapToModel(gr, modelToMap(gr, src));
    expect(back.x).toBeCloseTo(src.x, 9);
    expect(back.y).toBeCloseTo(src.y, 9);
  });

  it('preserves distances — a rotation must not stretch the building', () => {
    const gr = georefFromWorldLocation(loc({ rotation: 40 }), STEREO);
    const a = modelToMap(gr, { x: 0, y: 0 });
    const b = modelToMap(gr, { x: 30, y: 40 });
    expect(Math.hypot(b.e - a.e, b.n - a.n)).toBeCloseTo(50, 9);
  });
});

describe('compound plane angle', () => {
  it('splits degrees the way IFC wants them', () => {
    expect(toCompoundAngle(44.4268)).toEqual([44, 25, 36, 480000]);
    expect(fromCompoundAngle([44, 25, 36, 480000])).toBeCloseTo(44.4268, 9);
  });

  it('gives every non-zero component the same sign', () => {
    // (-44, 25, 36) reads as -44° +25′ to a strict parser — 25 arc-minutes of
    // error, which is about 46 km.
    const parts = toCompoundAngle(-44.4268);
    expect(parts).toEqual([-44, -25, -36, -480000]);
    expect(parts.every((v) => v <= 0)).toBe(true);
    expect(fromCompoundAngle(parts)).toBeCloseTo(-44.4268, 9);
  });

  it('carries the sign when the degree component is zero', () => {
    const parts = toCompoundAngle(-0.5);
    expect(parts[0]).toBe(-0);
    expect(fromCompoundAngle(parts)).toBeCloseTo(-0.5, 9);
  });

  it('rounds without leaving 59 minutes 60 seconds behind', () => {
    expect(toCompoundAngle(1 - 1e-12)).toEqual([1, 0, 0, 0]);
    expect(toCompoundAngle(0.99999999999)).toEqual([1, 0, 0, 0]);
  });

  it('accepts the three-part form on the way back in', () => {
    expect(fromCompoundAngle([26, 6, 9])).toBeCloseTo(26 + 6 / 60 + 9 / 3600, 9);
  });

  it('round-trips to better than a millimetre on the ground', () => {
    for (const d of [0, 0.0001, 26.1025, -44.4268, 179.999999]) {
      // A millionth of an arc-second is ~0.03 mm, so 1e-9 degrees is plenty.
      expect(fromCompoundAngle(toCompoundAngle(d))).toBeCloseTo(d, 9);
    }
  });
});

describe('the offsets are not optional', () => {
  // The panel once projected the bare lat/lng while Cesium and the IFC export
  // both applied the ENU offsets, so the readout disagreed with the globe and
  // with the file by exactly the offset. These pin the contract: whatever
  // reads a position must go through georefFromWorldLocation.
  it('a nudged model is NOT at its anchor', () => {
    const anchor = georefFromWorldLocation(loc(), STEREO);
    const nudged = georefFromWorldLocation(loc({ offsetE: 120, offsetN: -45 }), STEREO);
    const moved = Math.hypot(nudged.eastings - anchor.eastings, nudged.northings - anchor.northings);
    expect(moved).toBeCloseTo(Math.hypot(120, 45), 0);
  });

  it('the vertical offset reaches the height that gets written', () => {
    expect(georefFromWorldLocation(loc({ alt: 85, offsetZ: 4 }), STEREO).orthogonalHeight).toBe(89);
  });

  it('an offset of zero changes nothing, so the simple case stays simple', () => {
    const a = georefFromWorldLocation(loc(), STEREO);
    const b = georefFromWorldLocation(loc({ offsetE: 0, offsetN: 0, offsetZ: 0 }), STEREO);
    expect(b.eastings).toBe(a.eastings);
    expect(b.northings).toBe(a.northings);
  });
});

describe('typing grid coordinates for the insertion point', () => {
  // The World panel lets you type the eastings/northings of a model's
  // insertion point. It does that by taking the CURRENT georeference,
  // swapping the two numbers, and converting back to a WorldLocation. The
  // model then has to land exactly on the typed point.
  const place = (base: WorldLocation, e: number, n: number): WorldLocation => {
    const gr = georefFromWorldLocation(base, STEREO);
    const wl = worldLocationFromGeoref({ ...gr, eastings: e, northings: n });
    return { ...base, lat: wl.lat, lng: wl.lng, offsetE: 0, offsetN: 0 };
  };

  it('lands on the point that was typed, to the millimetre', () => {
    const moved = place(loc({ rotation: 33 }), 587_900, 325_800);
    const back = georefFromWorldLocation(moved, STEREO);
    // The residual is the seven-parameter datum shift going out and back:
    // under a millimetre, which is finer than any survey it will ever meet.
    expect(Math.hypot(back.eastings - 587_900, back.northings - 325_800)).toBeLessThan(0.002);
  });

  it('keeps the heading — typing a position is not a rotation', () => {
    for (const rotation of [0, 33, 180, 287.5]) {
      const moved = place(loc({ rotation }), 590_000, 330_000);
      expect(moved.rotation).toBe(rotation);
      // And the axes that get written still describe that same heading.
      const back = georefFromWorldLocation(moved, STEREO);
      expect(((headingOf(back) % 360) + 360) % 360).toBeCloseTo(rotation, 6);
    }
  });

  it('discards the ENU nudge, because the typed point IS the insertion point', () => {
    const moved = place(loc({ offsetE: 120, offsetN: -45 }), 587_900, 325_800);
    expect(moved.offsetE).toBe(0);
    expect(moved.offsetN).toBe(0);
    const back = georefFromWorldLocation(moved, STEREO);
    expect(Math.abs(back.eastings - 587_900)).toBeLessThan(0.002);
  });
});
