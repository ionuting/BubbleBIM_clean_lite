/**
 * crs.ts — projected coordinate reference systems, via proj4.
 *
 * The model lives in metres on a flat local grid. The world is an ellipsoid.
 * A CRS is the agreed lie that turns one into the other, and which lie you
 * picked has to travel with the file — a number like `E = 589 231.44` means
 * nothing without it.
 *
 * Definitions are registered lazily with proj4 the first time a code is used,
 * so adding one here costs nothing until someone projects into it.
 *
 * Axis order: this module always speaks (east, north) and (lat, lng) in
 * DEGREES, whatever the authority says the official axis order is. EPSG:3844
 * is officially northing-first; proj4 hands back x/y = east/north and we keep
 * that, because mixing the two conventions inside one codebase is how
 * coordinates end up transposed by 400 km with everything still "working".
 */

import proj4 from 'proj4';

export interface CrsDef {
  /** Authority code, e.g. 'EPSG:3844'. */
  code: string;
  /** Human label for a picker. */
  label: string;
  /** proj4 definition string. */
  def: string;
  /** Rough area of use, for the picker only — never used in maths. */
  region?: string;
  /**
   * Set on a superseded system. The text says what replaced it and by how
   * much the two disagree — the number is the point: a datum shift of 80 or
   * 200 m produces coordinates that look perfectly plausible and are wrong.
   */
  legacy?: string;
}

export const WGS84 = 'EPSG:4326';

/**
 * The ones worth shipping by default. Romania first, since that is where the
 * cadastre this app has to satisfy lives; the rest cover the common cases a
 * project abroad runs into.
 *
 * EPSG:3844 (Stereo 70) is the Romanian national grid: oblique stereographic
 * on Krasovsky 1940, secant at 0.99975, origin 46°N 25°E, false E/N 500 000.
 * The +towgs84 block is the standard 7-parameter shift to WGS84 — without it
 * proj4 treats Pulkovo 1942(58) as if it were WGS84 and the result lands a few
 * hundred metres off, which is exactly the kind of error that looks plausible.
 */
export const BUILTIN_CRS: CrsDef[] = [
  {
    code: 'EPSG:3844',
    label: 'Stereo 70 — România',
    region: 'România',
    def: '+proj=sterea +lat_0=46 +lon_0=25 +k=0.99975 +x_0=500000 +y_0=500000 '
       + '+ellps=krass +towgs84=2.329,-147.042,-92.08,-0.309,0.325,0.497,5.69 '
       + '+units=m +no_defs',
  },
  {
    code: 'EPSG:3857',
    label: 'Web Mercator',
    region: 'global (hărți web)',
    def: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 '
       + '+k=1 +units=m +nadgrids=@null +no_defs',
  },
  {
    code: 'EPSG:25834',
    label: 'ETRS89 / UTM 34N',
    region: 'vestul României, Ungaria',
    def: '+proj=utm +zone=34 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  {
    code: 'EPSG:25835',
    label: 'ETRS89 / UTM 35N',
    region: 'estul României, Moldova',
    def: '+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },

  // ── Spania ───────────────────────────────────────────────────────────────
  // Peninsula is split across three UTM zones; 30N carries most of it.
  {
    code: 'EPSG:25829', label: 'ETRS89 / UTM 29N', region: 'Spania — Galicia',
    def: '+proj=utm +zone=29 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  {
    code: 'EPSG:25830', label: 'ETRS89 / UTM 30N', region: 'Spania — centru',
    def: '+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  {
    code: 'EPSG:25831', label: 'ETRS89 / UTM 31N', region: 'Spania — Catalonia, Baleare',
    def: '+proj=utm +zone=31 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  {
    // The Canaries are on their own datum; ETRS89 does not reach them.
    code: 'EPSG:4082', label: 'REGCAN95 / UTM 27N', region: 'Spania — El Hierro, La Palma',
    def: '+proj=utm +zone=27 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  {
    code: 'EPSG:4083', label: 'REGCAN95 / UTM 28N', region: 'Spania — Insulele Canare',
    def: '+proj=utm +zone=28 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  // ED50 — replaced by ETRS89 in 2007 but still on older plans. The shift to
  // ETRS89 is 100–250 m across Spain; shipping it means an old plan can be
  // converted correctly instead of quietly landing two streets over.
  {
    code: 'EPSG:23029', label: 'ED50 / UTM 29N (vechi)', region: 'Spania — planuri dinainte de 2007',
    def: '+proj=utm +zone=29 +ellps=intl +towgs84=-87,-98,-121,0,0,0,0 +units=m +no_defs',
    legacy: 'ED50 a fost înlocuit de ETRS89 în 2007; diferența e de 100–250 m.',
  },
  {
    code: 'EPSG:23030', label: 'ED50 / UTM 30N (vechi)', region: 'Spania — planuri dinainte de 2007',
    def: '+proj=utm +zone=30 +ellps=intl +towgs84=-87,-98,-121,0,0,0,0 +units=m +no_defs',
    legacy: 'ED50 a fost înlocuit de ETRS89 în 2007; diferența e de 100–250 m.',
  },
  {
    code: 'EPSG:23031', label: 'ED50 / UTM 31N (vechi)', region: 'Spania — planuri dinainte de 2007',
    def: '+proj=utm +zone=31 +ellps=intl +towgs84=-87,-98,-121,0,0,0,0 +units=m +no_defs',
    legacy: 'ED50 a fost înlocuit de ETRS89 în 2007; diferența e de 100–250 m.',
  },

  // ── Austria ──────────────────────────────────────────────────────────────
  // The cadastre works in MGI Gauss-Krüger, three meridian strips named after
  // their longitude east of Ferro (M28/M31/M34 = 10°20′, 13°20′, 16°20′ E of
  // Greenwich). Bessel ellipsoid, and a datum 78 m away from ETRS89 — the same
  // trap as ED50 in Spain, in a different costume.
  {
    code: 'EPSG:31254', label: 'MGI / Austria GK West (M28)', region: 'Austria — Tirol, Vorarlberg',
    def: '+proj=tmerc +lat_0=0 +lon_0=10.33333333333333 +k=1 +x_0=0 +y_0=-5000000 '
       + '+ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs',
  },
  {
    code: 'EPSG:31255', label: 'MGI / Austria GK Central (M31)', region: 'Austria — Salzburg, Carintia, Austria Superioară',
    def: '+proj=tmerc +lat_0=0 +lon_0=13.33333333333333 +k=1 +x_0=0 +y_0=-5000000 '
       + '+ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs',
  },
  {
    code: 'EPSG:31256', label: 'MGI / Austria GK East (M34)', region: 'Austria — Viena, Austria Inferioară, Stiria, Burgenland',
    def: '+proj=tmerc +lat_0=0 +lon_0=16.33333333333333 +k=1 +x_0=0 +y_0=-5000000 '
       + '+ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs',
  },
  {
    // One projection for the whole country — federal datasets, not the cadastre.
    code: 'EPSG:3416', label: 'ETRS89 / Austria Lambert', region: 'Austria — date federale',
    def: '+proj=lcc +lat_1=49 +lat_2=46 +lat_0=47.5 +lon_0=13.33333333333333 +x_0=400000 +y_0=400000 '
       + '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  {
    code: 'EPSG:31287', label: 'MGI / Austria Lambert (vechi)', region: 'Austria — date federale mai vechi',
    def: '+proj=lcc +lat_1=49 +lat_2=46 +lat_0=47.5 +lon_0=13.33333333333333 +x_0=400000 +y_0=400000 '
       + '+ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs',
    legacy: 'Datum MGI; față de ETRS89 diferă cu ~78 m.',
  },

  // ── Danemarca ────────────────────────────────────────────────────────────
  {
    code: 'EPSG:25832', label: 'ETRS89 / UTM 32N', region: 'Danemarca — Iutlanda, Fionia',
    def: '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  {
    code: 'EPSG:25833', label: 'ETRS89 / UTM 33N', region: 'Danemarca — Zeelanda, Bornholm',
    def: '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  {
    // DKTM: narrow transverse-Mercator belts the Danish cadastre uses where
    // UTM's scale error is too large. Four belts, 1° wide each.
    code: 'EPSG:4094', label: 'DKTM2', region: 'Danemarca — Fionia',
    def: '+proj=tmerc +lat_0=0 +lon_0=10 +k=0.99998 +x_0=200000 +y_0=-5000000 '
       + '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  {
    code: 'EPSG:4095', label: 'DKTM3', region: 'Danemarca — Zeelanda',
    def: '+proj=tmerc +lat_0=0 +lon_0=11.75 +k=0.99998 +x_0=300000 +y_0=-5000000 '
       + '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  {
    code: 'EPSG:4093', label: 'DKTM1', region: 'Danemarca — Iutlanda',
    def: '+proj=tmerc +lat_0=0 +lon_0=9 +k=0.99998 +x_0=200000 +y_0=-5000000 '
       + '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
  {
    code: 'EPSG:4096', label: 'DKTM4', region: 'Danemarca — Bornholm',
    def: '+proj=tmerc +lat_0=0 +lon_0=15 +k=1 +x_0=800000 +y_0=-5000000 '
       + '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },

  // ── Pan-european ─────────────────────────────────────────────────────────
  {
    code: 'EPSG:3035', label: 'ETRS89 / LAEA Europa', region: 'Europa (statistici, INSPIRE)',
    def: '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 '
       + '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
];

const registered = new Set<string>([WGS84]);
const custom = new Map<string, CrsDef>();

function defOf(code: string): CrsDef | undefined {
  return custom.get(code) ?? BUILTIN_CRS.find((c) => c.code === code);
}

/**
 * Teach the app a CRS it does not ship. The definition is a proj4 string —
 * the one epsg.io prints under "Proj4". Re-registering a code replaces it.
 */
export function registerCrs(def: CrsDef): void {
  custom.set(def.code, def);
  registered.delete(def.code);
}

/** Every CRS the app can project into right now, builtins plus registered. */
export function listCrs(): CrsDef[] {
  return [...BUILTIN_CRS, ...custom.values()];
}

/** True when `code` can be projected into — check before trusting user input. */
export function isKnownCrs(code: string): boolean {
  return code === WGS84 || defOf(code) !== undefined;
}

/**
 * Any UTM zone on WGS84, built on demand: `utmCrs(35)` → EPSG:32635,
 * `utmCrs(35, 'S')` → EPSG:32735. Registered as a side effect so the code can
 * then be used like any other.
 */
export function utmCrs(zone: number, hemisphere: 'N' | 'S' = 'N'): string {
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) {
    throw new Error(`utmCrs: zone must be 1..60, got ${zone}`);
  }
  const code = `EPSG:${(hemisphere === 'N' ? 32600 : 32700) + zone}`;
  if (!defOf(code)) {
    registerCrs({
      code,
      label: `WGS 84 / UTM ${zone}${hemisphere}`,
      region: 'global',
      def: `+proj=utm +zone=${zone}${hemisphere === 'S' ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`,
    });
  }
  return code;
}

/** The UTM zone a longitude falls in. Zone 1 starts at 180°W, 6° wide. */
export function utmZoneFor(lng: number): number {
  const wrapped = ((lng + 180) % 360 + 360) % 360;
  return Math.min(60, Math.floor(wrapped / 6) + 1);
}

function ensure(code: string): string {
  if (registered.has(code)) return code;
  if (code === WGS84) { registered.add(code); return code; }
  const d = defOf(code);
  if (!d) throw new Error(`Unknown CRS '${code}'. Register it with registerCrs() first.`);
  proj4.defs(code, d.def);
  registered.add(code);
  return code;
}

export interface MapPoint {
  /** Metres east of the CRS origin. */
  e: number;
  /** Metres north of the CRS origin. */
  n: number;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Geodetic (WGS84 degrees) → projected metres. */
export function project(p: GeoPoint, code: string): MapPoint {
  ensure(code);
  const [e, n] = proj4(WGS84, code, [p.lng, p.lat]) as [number, number];
  return { e, n };
}

/** Projected metres → geodetic (WGS84 degrees). */
export function unproject(p: MapPoint, code: string): GeoPoint {
  ensure(code);
  const [lng, lat] = proj4(code, WGS84, [p.e, p.n]) as [number, number];
  return { lat, lng };
}

/**
 * Straight between two projected systems — Stereo 70 to UTM 30N, DKTM3 to
 * ETRS89/UTM 33N, whatever the survey and the map disagree about.
 *
 * proj4 routes through the datums itself, so this is a single transformation
 * rather than the two-step project/unproject a caller would otherwise write.
 * `WGS84` is accepted at either end, where the pair is (lng, lat) in degrees —
 * which is why this takes and returns bare {x, y} instead of the named
 * east/north fields: halfway through a conversion, "eastings" would be a lie.
 */
export function convert(
  p: { x: number; y: number },
  from: string,
  to: string,
): { x: number; y: number } {
  if (from === to) return { x: p.x, y: p.y };
  ensure(from);
  ensure(to);
  const [x, y] = proj4(from, to, [p.x, p.y]) as [number, number];
  return { x, y };
}

/** Axis labels for a CRS, so a UI can say E/N or Lng/Lat rather than X/Y. */
export function axisLabels(code: string): { x: string; y: string; unit: string } {
  return code === WGS84
    ? { x: 'Lng', y: 'Lat', unit: '°' }
    : { x: 'E', y: 'N', unit: 'm' };
}
