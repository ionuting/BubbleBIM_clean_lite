import { describe, expect, it } from 'vitest';
import { COUNTRIES, crsForLocation, crsValidAt, detectCountry, legacyNote, recommendCrs, recommendCrsAt } from './countries';
import { convert, isKnownCrs, WGS84 } from './crs';

describe('every system a country lists is one the app can project into', () => {
  for (const c of COUNTRIES) {
    it(c.label, () => {
      for (const code of c.systems) expect(isKnownCrs(code)).toBe(true);
    });
  }
});

describe('detectCountry', () => {
  it('finds the four countries from a point inside each', () => {
    expect(detectCountry(44.4268, 26.1025)).toBe('RO');  // București
    expect(detectCountry(40.4168, -3.7038)).toBe('ES');  // Madrid
    expect(detectCountry(48.2082, 16.3738)).toBe('AT');  // Viena
    expect(detectCountry(55.6761, 12.5683)).toBe('DK');  // Copenhaga
    expect(detectCountry(28.4636, -16.2518)).toBe('ES'); // Tenerife
  });

  it('says null rather than guessing for a point outside all of them', () => {
    expect(detectCountry(48.8566, 2.3522)).toBeNull();   // Paris
    expect(detectCountry(-33.8651, 151.2094)).toBeNull(); // Sydney
  });
});

describe('recommendCrs — Romania', () => {
  it('is always Stereo 70', () => {
    expect(recommendCrs('RO', 44.43, 26.10).crs).toBe('EPSG:3844');
    expect(recommendCrs('RO', 47.16, 21.90).crs).toBe('EPSG:3844');
  });
  it('offers the UTM zone that actually contains the point', () => {
    expect(recommendCrs('RO', 47.16, 21.90).alternatives).toContain('EPSG:25834'); // Oradea
    expect(recommendCrs('RO', 44.43, 26.10).alternatives).toContain('EPSG:25835'); // București
  });
});

describe('recommendCrs — Spain', () => {
  it('splits the peninsula into its three UTM zones', () => {
    expect(recommendCrs('ES', 43.36, -8.41).crs).toBe('EPSG:25829');  // A Coruña
    expect(recommendCrs('ES', 40.42, -3.70).crs).toBe('EPSG:25830');  // Madrid
    expect(recommendCrs('ES', 37.39, -5.99).crs).toBe('EPSG:25830');  // Sevilla
    expect(recommendCrs('ES', 41.39, 2.17).crs).toBe('EPSG:25831');   // Barcelona
    expect(recommendCrs('ES', 39.57, 2.65).crs).toBe('EPSG:25831');   // Palma
  });

  it('puts the Canaries on REGCAN95, split at 18°W', () => {
    expect(recommendCrs('ES', 28.46, -16.25).crs).toBe('EPSG:4083');  // Tenerife
    expect(recommendCrs('ES', 28.12, -15.43).crs).toBe('EPSG:4083');  // Las Palmas
    expect(recommendCrs('ES', 27.75, -18.02).crs).toBe('EPSG:4082');  // El Hierro
  });

  it('never recommends ED50 — it is there to read old plans, not to make new ones', () => {
    for (const [lat, lng] of [[43.36, -8.41], [40.42, -3.70], [41.39, 2.17]]) {
      const r = recommendCrs('ES', lat, lng);
      expect(r.crs.startsWith('EPSG:230')).toBe(false);
      expect(r.alternatives.some((a) => a.startsWith('EPSG:230'))).toBe(false);
    }
  });
});

describe('recommendCrs — Austria', () => {
  it('picks the Gauss-Krüger strip by the cadastre’s own boundaries', () => {
    expect(recommendCrs('AT', 47.27, 11.40).crs).toBe('EPSG:31254');  // Innsbruck → M28
    expect(recommendCrs('AT', 47.81, 13.06).crs).toBe('EPSG:31255');  // Salzburg → M31
    expect(recommendCrs('AT', 46.62, 14.31).crs).toBe('EPSG:31255');  // Klagenfurt → M31
    expect(recommendCrs('AT', 48.21, 16.37).crs).toBe('EPSG:31256');  // Viena → M34
    expect(recommendCrs('AT', 47.07, 15.44).crs).toBe('EPSG:31256');  // Graz → M34
  });

  it('offers the national Lambert as the alternative everywhere', () => {
    for (const lng of [11, 13, 16]) {
      expect(recommendCrs('AT', 47.5, lng).alternatives).toContain('EPSG:3416');
    }
  });
});

describe('recommendCrs — Denmark', () => {
  it('uses UTM 32 for Copenhagen, by national convention, NOT zone 33', () => {
    // Copenhagen is east of 12°E, so a generic zone formula says 33. Denmark
    // says 32 for the whole country. This is the case a formula gets wrong.
    expect(recommendCrs('DK', 55.68, 12.57).crs).toBe('EPSG:25832');
    expect(recommendCrs('DK', 56.16, 10.20).crs).toBe('EPSG:25832');  // Aarhus
  });

  it('makes the one exception for Bornholm', () => {
    expect(recommendCrs('DK', 55.10, 14.92).crs).toBe('EPSG:25833');
  });

  it('offers the DKTM belt the point falls in', () => {
    expect(recommendCrs('DK', 56.16, 10.20).alternatives).toContain('EPSG:4094');  // Aarhus → DKTM2
    expect(recommendCrs('DK', 55.68, 12.57).alternatives).toContain('EPSG:4095');  // Copenhagen → DKTM3
    expect(recommendCrs('DK', 55.50, 9.50).alternatives).toContain('EPSG:4093');   // Kolding → DKTM1
  });
});

describe('legacy systems', () => {
  it('flags the superseded ones with the size of the error', () => {
    expect(legacyNote('EPSG:23030')).toMatch(/100–250 m/);
    expect(legacyNote('EPSG:31287')).toMatch(/78 m/);
  });
  it('has nothing to say about a current system', () => {
    expect(legacyNote('EPSG:25830')).toBeNull();
    expect(legacyNote('EPSG:3844')).toBeNull();
  });

  it('the ED50 → ETRS89 shift really is that large — the reason the note exists', () => {
    // Same numbers, two datums: read as ED50 and as ETRS89, Madrid moves.
    const p = { x: 440_000, y: 4_474_000 };
    const asEd50 = convert(p, 'EPSG:23030', WGS84);
    const asEtrs = convert(p, 'EPSG:25830', WGS84);
    const metres = Math.hypot(
      (asEd50.x - asEtrs.x) * 111_320 * Math.cos(40.4 * Math.PI / 180),
      (asEd50.y - asEtrs.y) * 111_320,
    );
    expect(metres).toBeGreaterThan(100);
    expect(metres).toBeLessThan(300);
  });

  it('and so is MGI → ETRS89 in Austria', () => {
    const p = { x: 625_900, y: 483_150 };
    const a = convert(p, 'EPSG:31287', WGS84);
    const b = convert(p, 'EPSG:3416', WGS84);
    const metres = Math.hypot(
      (a.x - b.x) * 111_320 * Math.cos(48.2 * Math.PI / 180),
      (a.y - b.y) * 111_320,
    );
    expect(metres).toBeGreaterThan(50);
    expect(metres).toBeLessThan(120);
  });
});

describe('crsForLocation — the grid follows the model', () => {
  it('keeps the grid while the model stays in its country', () => {
    expect(crsForLocation(44.43, 26.10, 'EPSG:3844')).toBe('EPSG:3844');
    expect(crsForLocation(47.16, 21.90, 'EPSG:25835')).toBe('EPSG:25835'); // Oradea, still a Romanian system
    // Nudged across 0° within Spain: no flip, that stays a decision.
    expect(crsForLocation(41.39, 2.17, 'EPSG:25830')).toBe('EPSG:25830');
  });

  it('re-picks when the model is carried to another country', () => {
    // A Romanian default that followed a model to Granada.
    expect(crsForLocation(37.08, -3.75, 'EPSG:3844')).toBe('EPSG:25830');
    expect(crsForLocation(48.21, 16.37, 'EPSG:3844')).toBe('EPSG:31256'); // Viena
  });

  it('falls back to the WGS 84 / UTM zone outside every known country', () => {
    expect(crsForLocation(48.8566, 2.3522, 'EPSG:3844')).toBe('EPSG:32631');   // Paris
    expect(crsForLocation(-33.8651, 151.2094, null)).toBe('EPSG:32756');       // Sydney, south
    expect(isKnownCrs('EPSG:32756')).toBe(true);
    // And keeps a UTM grid that still contains the point.
    expect(crsForLocation(48.9, 2.5, 'EPSG:32631')).toBe('EPSG:32631');
    expect(crsForLocation(48.9, 7.5, 'EPSG:32631')).toBe('EPSG:32632');
  });

  it('recommendCrsAt says why', () => {
    expect(recommendCrsAt(48.8566, 2.3522).reason).toContain('UTM 31N');
    expect(recommendCrsAt(44.43, 26.10).crs).toBe('EPSG:3844');
  });
});

describe('crsValidAt — can this grid carry a point here?', () => {
  it('rejects a national grid outside its country', () => {
    expect(crsValidAt('EPSG:3844', 37.0834, -3.7556)).toBe(false); // Stereo 70 in Granada
    expect(crsValidAt('EPSG:3844', 44.43, 26.10)).toBe(true);
    expect(crsValidAt('EPSG:25830', 37.0834, -3.7556)).toBe(true);
  });
  it('accepts a UTM zone one zone either side, and checks the hemisphere', () => {
    expect(crsValidAt('EPSG:32630', 37.08, -3.75)).toBe(true);
    expect(crsValidAt('EPSG:32631', 37.08, -3.75)).toBe(true);  // stretched across the edge
    expect(crsValidAt('EPSG:32635', 37.08, -3.75)).toBe(false);
    expect(crsValidAt('EPSG:32730', 37.08, -3.75)).toBe(false); // south in the north
  });
  it('trusts a code it has no area for', () => {
    expect(crsValidAt('EPSG:2154', 48.85, 2.35)).toBe(true);
  });
});
