/**
 * countries.ts — the coordinate system a project should use, decided from
 * where the project IS rather than from a list the user has to already
 * understand.
 *
 * Each country here has ONE answer for a given point, because that is how
 * the countries themselves work: a Spanish surveyor in Madrid does not
 * choose between UTM zones, the zone is 30 and that is that. A Danish one
 * uses UTM 32 for the whole country except Bornholm, by national convention,
 * even though Copenhagen technically sits in zone 33. An Austrian cadastre
 * plan is in the Gauss-Krüger strip its province falls in. Romania has a
 * single national grid.
 *
 * `recommendCrs` encodes those rules. The generic EPSG list still exists for
 * anyone who knows better; this file exists for everyone who should not have
 * to.
 */

import { BUILTIN_CRS, utmCrs, utmZoneFor, type CrsDef } from './crs';

export type CountryCode = 'RO' | 'ES' | 'AT' | 'DK';

export interface Country {
  code: CountryCode;
  label: string;
  /** Rough bounding box for auto-detection: [west, south, east, north]. */
  bbox: [number, number, number, number];
  /** Every system this country's surveys can arrive in, current ones first. */
  systems: string[];
}

export const COUNTRIES: Country[] = [
  {
    code: 'RO', label: 'România',
    bbox: [20.2, 43.6, 29.8, 48.3],
    systems: ['EPSG:3844', 'EPSG:25834', 'EPSG:25835'],
  },
  {
    code: 'ES', label: 'Spania',
    // Two boxes really — peninsula and the Canaries — folded into one for
    // detection; the zone logic below tells them apart by latitude.
    bbox: [-18.4, 27.5, 4.4, 43.9],
    systems: [
      'EPSG:25829', 'EPSG:25830', 'EPSG:25831', 'EPSG:4082', 'EPSG:4083',
      'EPSG:23029', 'EPSG:23030', 'EPSG:23031',
    ],
  },
  {
    code: 'AT', label: 'Austria',
    bbox: [9.5, 46.3, 17.2, 49.1],
    systems: ['EPSG:31254', 'EPSG:31255', 'EPSG:31256', 'EPSG:3416', 'EPSG:25832', 'EPSG:25833', 'EPSG:31287'],
  },
  {
    code: 'DK', label: 'Danemarca',
    bbox: [8.0, 54.5, 15.3, 57.8],
    systems: ['EPSG:25832', 'EPSG:25833', 'EPSG:4093', 'EPSG:4094', 'EPSG:4095', 'EPSG:4096'],
  },
];

export function countryByCode(code: CountryCode): Country {
  const c = COUNTRIES.find((x) => x.code === code);
  if (!c) throw new Error(`Unknown country ${code}`);
  return c;
}

/**
 * Which supported country a point falls in, or null. Boxes are coarse and
 * a point can sit in two (Austria and Denmark do not overlap, but Spain's
 * box is generous); first match wins, in the order above. Good enough to
 * pre-select a dropdown — never used to decide anything silently.
 */
export function detectCountry(lat: number, lng: number): CountryCode | null {
  for (const c of COUNTRIES) {
    const [w, s, e, n] = c.bbox;
    if (lng >= w && lng <= e && lat >= s && lat <= n) return c.code;
  }
  return null;
}

export interface CrsRecommendation {
  crs: string;
  /** Plain-language reason, shown next to the pick. */
  reason: string;
  /** Other current systems that are also legitimate here. */
  alternatives: string[];
}

/**
 * The system a surveyor in `country` would hand you for a point.
 *
 * Longitude thresholds are the ones the countries use, not a generic UTM
 * zone formula — Denmark's are deliberately NOT the zone boundaries.
 */
export function recommendCrs(country: CountryCode, lat: number, lng: number): CrsRecommendation {
  switch (country) {
    case 'RO':
      return {
        crs: 'EPSG:3844',
        reason: 'Stereo 70 — grila națională, folosită de ANCPI și de orice topograf.',
        alternatives: [lng < 24 ? 'EPSG:25834' : 'EPSG:25835'],
      };

    case 'ES': {
      if (lat < 30) {
        // Canaries — own datum, two zones split at 18°W.
        return lng < -18
          ? { crs: 'EPSG:4082', reason: 'Canare, vest de 18°W (El Hierro, La Palma) — REGCAN95 / UTM 27N.', alternatives: ['EPSG:4083'] }
          : { crs: 'EPSG:4083', reason: 'Insulele Canare — REGCAN95 / UTM 28N.', alternatives: ['EPSG:4082'] };
      }
      if (lng < -6) return { crs: 'EPSG:25829', reason: 'Vest de 6°W (Galicia) — ETRS89 / UTM 29N.', alternatives: ['EPSG:25830'] };
      if (lng < 0)  return { crs: 'EPSG:25830', reason: 'Între 6°W și 0° — ETRS89 / UTM 30N, cea mai mare parte a peninsulei.', alternatives: ['EPSG:25829', 'EPSG:25831'] };
      return { crs: 'EPSG:25831', reason: 'Est de meridianul 0° (Catalonia, Baleare) — ETRS89 / UTM 31N.', alternatives: ['EPSG:25830'] };
    }

    case 'AT': {
      // Gauss-Krüger strips, boundaries at 11°50′ and 14°50′ E.
      if (lng < 11 + 50 / 60) return { crs: 'EPSG:31254', reason: 'Vest de 11°50′ (Tirol, Vorarlberg) — MGI / GK M28, sistemul cadastral.', alternatives: ['EPSG:3416', 'EPSG:25832'] };
      if (lng < 14 + 50 / 60) return { crs: 'EPSG:31255', reason: 'Între 11°50′ și 14°50′ (Salzburg, Carintia) — MGI / GK M31, sistemul cadastral.', alternatives: ['EPSG:3416', 'EPSG:25833'] };
      return { crs: 'EPSG:31256', reason: 'Est de 14°50′ (Viena, Stiria) — MGI / GK M34, sistemul cadastral.', alternatives: ['EPSG:3416', 'EPSG:25833'] };
    }

    case 'DK': {
      // National convention: UTM 32 for everything but Bornholm.
      if (lng > 14) return { crs: 'EPSG:25833', reason: 'Bornholm — ETRS89 / UTM 33N.', alternatives: ['EPSG:4096'] };
      const belt = lng < 10 ? 'EPSG:4093' : lng < 11.25 ? 'EPSG:4094' : 'EPSG:4095';
      return {
        crs: 'EPSG:25832',
        reason: 'ETRS89 / UTM 32N — convenția națională pentru toată Danemarca, mai puțin Bornholm.',
        alternatives: [belt],
      };
    }
  }
}

/**
 * `recommendCrs` for a point whose country may be unknown. Outside the
 * countries above there is no national convention to follow, so the answer
 * is the universal one: the WGS 84 / UTM zone the point falls in — the grid
 * any GIS or survey package opens without being told anything.
 */
export function recommendCrsAt(lat: number, lng: number, country?: CountryCode | null): CrsRecommendation {
  const c = country === undefined ? detectCountry(lat, lng) : country;
  if (c) return recommendCrs(c, lat, lng);
  const zone = utmZoneFor(lng);
  const hemi = lat < 0 ? 'S' : 'N';
  return {
    crs: utmCrs(zone, hemi),
    reason: `În afara țărilor cunoscute — WGS 84 / UTM ${zone}${hemi}, grila universală pentru această poziție.`,
    alternatives: [],
  };
}

/** `EPSG:326xx` / `EPSG:327xx` → the zone and hemisphere, or null for anything else. */
function utmOf(code: string): { zone: number; hemi: 'N' | 'S' } | null {
  const m = /^EPSG:32([67])(\d\d)$/.exec(code);
  if (!m) return null;
  return { zone: parseInt(m[2], 10), hemi: m[1] === '6' ? 'N' : 'S' };
}

/**
 * Whether `code` is a grid that can honestly carry a point at (lat, lng).
 *
 * A national system is valid inside its own country; a UTM zone within one
 * zone of the point (a zone is routinely stretched across its edge). A code
 * this app has no area for is trusted — a surveyor who wrote Lambert-93 into
 * a French file knew what they were doing, and "unknown" is not "wrong".
 *
 * This is what catches a Stereo 70 file placed in Granada: the numbers are
 * self-consistent, and no other program can use them.
 */
export function crsValidAt(code: string, lat: number, lng: number): boolean {
  const owners = COUNTRIES.filter((c) => c.systems.includes(code));
  if (owners.length) {
    return owners.some((c) => {
      const [w, s, e, n] = c.bbox;
      return lng >= w && lng <= e && lat >= s && lat <= n;
    });
  }
  const utm = utmOf(code);
  if (utm) {
    const d = Math.abs(utm.zone - utmZoneFor(lng));
    return Math.min(d, 60 - d) <= 1 && utm.hemi === (lat < 0 ? 'S' : 'N');
  }
  return true;
}

/**
 * The grid a placement at (lat, lng) should be written in, given the grid
 * the project has now.
 *
 * The current grid is kept as long as it still belongs where the model
 * stands: one of the systems of the country the point is in, or a UTM zone
 * that contains it. Nudging a Spanish project across 0° does not flip it
 * from UTM 30N to 31N — that stays a decision the panel offers. Carrying it
 * to another country does re-pick: a Romanian default followed a model to
 * Granada once, and wrote Stereo 70 coordinates two thousand kilometres
 * outside the grid's own area — consistent for this app, meaningless for any
 * other. That file is why this function exists.
 */
export function crsForLocation(lat: number, lng: number, current?: string | null): string {
  const country = detectCountry(lat, lng);
  if (current) {
    if (country && COUNTRIES.find((c) => c.code === country)!.systems.includes(current)) return current;
    const utm = utmOf(current);
    if (utm && utm.zone === utmZoneFor(lng) && utm.hemi === (lat < 0 ? 'S' : 'N')) return current;
  }
  return recommendCrsAt(lat, lng, country).crs;
}

/** The definition behind a code, for labels and legacy notes. */
export function crsInfo(code: string): CrsDef | undefined {
  return BUILTIN_CRS.find((c) => c.code === code);
}

/** Non-null when `code` is a superseded system; the text to show. */
export function legacyNote(code: string): string | null {
  return crsInfo(code)?.legacy ?? null;
}
