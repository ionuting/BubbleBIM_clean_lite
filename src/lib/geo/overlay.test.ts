import { describe, expect, it } from 'vitest';
import { cornersAround, groundSize, placeOverlay } from './overlay';
import { axisLabels, convert, listCrs, project, WGS84 } from './crs';

const STEREO = 'EPSG:3844';
/** A 200 m × 150 m site plan near Bucharest, in Stereo 70. */
const SITE = { crs: STEREO, minX: 587_800, minY: 325_700, maxX: 588_000, maxY: 325_850 };

describe('convert', () => {
  it('goes straight between two projected grids', () => {
    // Stereo 70 → UTM 35N for the same place, then back.
    const there = convert({ x: 587_904, y: 325_824 }, STEREO, 'EPSG:25835');
    const back = convert(there, 'EPSG:25835', STEREO);
    expect(back.x).toBeCloseTo(587_904, 2);
    expect(back.y).toBeCloseTo(325_824, 2);
    // UTM 35N easting near the 27°E central meridian is a few hundred km.
    expect(there.x).toBeGreaterThan(300_000);
    expect(there.x).toBeLessThan(700_000);
  });

  it('is identity when both ends are the same system', () => {
    const p = { x: 1, y: 2 };
    expect(convert(p, STEREO, STEREO)).toEqual(p);
  });

  it('accepts WGS84 at either end, as lng/lat', () => {
    const grid = convert({ x: 26.1025, y: 44.4268 }, WGS84, STEREO);
    expect(grid.x).toBeCloseTo(project({ lat: 44.4268, lng: 26.1025 }, STEREO).e, 6);
    const geo = convert(grid, STEREO, WGS84);
    // Millimetres on the ground — proj4's own round-trip precision.
    expect(Math.abs(geo.x - 26.1025) * 111_320_000).toBeLessThan(2);
    expect(Math.abs(geo.y - 44.4268) * 111_320_000).toBeLessThan(2);
  });

  it('crosses datums — Stereo 70 is Pulkovo, Danish UTM is ETRS89', () => {
    const dk = convert({ x: 10.2, y: 56.15 }, WGS84, 'EPSG:25832');
    const back = convert(dk, 'EPSG:25832', WGS84);
    expect(back.x).toBeCloseTo(10.2, 8);
    expect(back.y).toBeCloseTo(56.15, 8);
  });
});

describe('the shipped systems', () => {
  it('covers Romania, Spain and Denmark', () => {
    const codes = listCrs().map((c) => c.code);
    expect(codes).toContain('EPSG:3844');   // Stereo 70
    expect(codes).toContain('EPSG:25830');  // Spain, UTM 30N
    expect(codes).toContain('EPSG:25832');  // Denmark, UTM 32N
    expect(codes).toContain('EPSG:4095');   // DKTM3
  });

  it('puts Madrid inside UTM 30N and Copenhagen inside UTM 32N', () => {
    const madrid = convert({ x: -3.7038, y: 40.4168 }, WGS84, 'EPSG:25830');
    // A UTM easting is 500 000 on the central meridian; Madrid is west of 3°W.
    expect(madrid.x).toBeGreaterThan(400_000);
    expect(madrid.x).toBeLessThan(500_000);
    expect(madrid.y).toBeGreaterThan(4_400_000);

    const cph = convert({ x: 12.5683, y: 55.6761 }, WGS84, 'EPSG:25832');
    expect(cph.x).toBeGreaterThan(600_000);
    expect(cph.y).toBeGreaterThan(6_100_000);
  });

  it('DKTM3 keeps its own false origin, not UTM’s', () => {
    // x_0 = 300000, y_0 = -5000000 — a northing near a million, not six.
    const p = convert({ x: 12.0, y: 55.7 }, WGS84, 'EPSG:4095');
    expect(p.x).toBeGreaterThan(280_000);
    expect(p.x).toBeLessThan(320_000);
    expect(p.y).toBeGreaterThan(1_100_000);
    expect(p.y).toBeLessThan(1_300_000);
  });

  it('labels axes so a UI does not have to guess', () => {
    expect(axisLabels(STEREO)).toEqual({ x: 'E', y: 'N', unit: 'm' });
    expect(axisLabels(WGS84)).toEqual({ x: 'Lng', y: 'Lat', unit: '°' });
  });
});

describe('placeOverlay', () => {
  it('keeps the size the plan was drawn at', () => {
    const r = placeOverlay(SITE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.placement.widthM).toBe(200);
    expect(r.placement.heightM).toBe(150);
    expect(r.placement.centre.lng).toBeCloseTo(26.10, 1);
    expect(r.placement.centre.lat).toBeCloseTo(44.42, 1);
  });

  it('rotates the image by the convergence instead of shearing it', () => {
    const r = placeOverlay(SITE);
    if (!r.ok) throw new Error('expected a placement');
    const deg = r.placement.rotation * 180 / Math.PI;
    // Bucharest is east of Stereo 70's 25°E central meridian, so grid north
    // leans clockwise of true north — a NEGATIVE counter-clockwise rotation.
    // (λ−λ₀)·sin φ ≈ 1.1025 × sin 44.43° ≈ 0.77°.
    expect(deg).toBeLessThan(0);
    expect(Math.abs(deg)).toBeCloseTo(0.77, 1);
  });

  it('reports what ignoring the rotation would cost — the bug this avoids', () => {
    const r = placeOverlay(SITE);
    if (!r.ok) throw new Error('expected a placement');
    // ~2.7 m on a 200 m site plan. Not a rounding error: a building drawn in
    // the wrong place. This number is why `rotation` exists.
    expect(r.placement.skewM).toBeGreaterThan(1);
    expect(r.placement.skewM).toBeLessThan(5);
  });

  it('has no rotation to make on the central meridian', () => {
    const r = placeOverlay({ crs: STEREO, minX: 499_900, minY: 499_900, maxX: 500_100, maxY: 500_100 });
    if (!r.ok) throw new Error('expected a placement');
    expect(Math.abs(r.placement.rotation * 180 / Math.PI)).toBeLessThan(0.01);
    expect(r.placement.skewM).toBeLessThan(0.1);
  });

  it('flips the rotation on the other side of the central meridian', () => {
    const east = placeOverlay({ crs: STEREO, minX: 700_000, minY: 400_000, maxX: 700_200, maxY: 400_200 });
    const west = placeOverlay({ crs: STEREO, minX: 300_000, minY: 400_000, maxX: 300_200, maxY: 400_200 });
    if (!east.ok || !west.ok) throw new Error('expected placements');
    expect(Math.sign(east.placement.rotation)).toBe(-Math.sign(west.placement.rotation));
  });

  it('leaves a WGS84 image unrotated — degrees are already geographic', () => {
    const r = placeOverlay({ crs: WGS84, minX: 26.10, minY: 44.42, maxX: 26.11, maxY: 44.43 });
    if (!r.ok) throw new Error('expected a placement');
    expect(r.placement.rotation).toBe(0);
  });

  it('rejects an unknown system instead of dropping the image at 0,0', () => {
    const r = placeOverlay({ ...SITE, crs: 'EPSG:99999' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('unknown-crs');
  });

  it('rejects swapped or equal corners', () => {
    for (const bad of [
      { ...SITE, maxX: SITE.minX - 10 },
      { ...SITE, maxY: SITE.minY },
    ]) {
      const r = placeOverlay(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('degenerate');
    }
  });

  it('rejects incomplete input rather than producing NaN bounds', () => {
    const r = placeOverlay({ ...SITE, maxX: NaN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('degenerate');
  });

  it('the bounds it returns span the size it reports', () => {
    const r = placeOverlay(SITE);
    if (!r.ok) throw new Error('expected a placement');
    const g = groundSize(r.placement.bounds);
    expect(g.widthM).toBeCloseTo(200, 0);
    expect(g.heightM).toBeCloseTo(150, 0);
  });

  it('places a Danish plan in DKTM3 as readily as a Romanian one', () => {
    const r = placeOverlay({ crs: 'EPSG:4095', minX: 300_000, minY: 1_200_000, maxX: 300_400, maxY: 1_200_300 });
    if (!r.ok) throw new Error('expected a placement');
    expect(r.placement.centre.lat).toBeGreaterThan(54);
    expect(r.placement.centre.lat).toBeLessThan(58);
    expect(r.placement.widthM).toBe(400);
    // DKTM belts are narrow, so convergence stays tiny — that is their point.
    expect(Math.abs(r.placement.rotation * 180 / Math.PI)).toBeLessThan(0.5);
  });
});

describe('cornersAround', () => {
  it('centres a given ground size on a point', () => {
    const c = cornersAround({ x: 500_000, y: 400_000 }, STEREO, 100, 60);
    expect(c).toEqual({ crs: STEREO, minX: 499_950, minY: 399_970, maxX: 500_050, maxY: 400_030 });
    const r = placeOverlay(c);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.placement.widthM).toBe(100);
      expect(r.placement.heightM).toBe(60);
    }
  });
});

describe('groundSize', () => {
  it('shrinks a degree of longitude as latitude rises', () => {
    const equator = groundSize({ west: 0, east: 1, south: 0, north: 1 });
    const north = groundSize({ west: 0, east: 1, south: 60, north: 61 });
    expect(north.widthM).toBeLessThan(equator.widthM / 1.9);
    // A degree of latitude is NOT constant: the meridian's radius of
    // curvature grows toward the poles, so the degree stretches from
    // ~110.6 km at the equator to ~111.4 km at 60°. Under a percent, but
    // real — asserting "about 111 km everywhere" would be asserting a sphere.
    expect(north.heightM).toBeGreaterThan(equator.heightM);
    expect(north.heightM / equator.heightM).toBeCloseTo(1.008, 2);
  });
});
