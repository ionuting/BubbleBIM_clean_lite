/**
 * ifcGeoref.ts — georeferencing in and out of an IFC STEP file.
 *
 * `@ifc-lite/create` has no georeferencing API: its `SiteParams` carries only
 * a name and a description, and it emits `IFCSITE(…,.ELEMENT.,$,$,$,$,$)` with
 * every reference slot empty. So the reference is written by editing the STEP
 * text it produces — a narrow, testable transform over lines that were emitted
 * one entity each.
 *
 * Two mechanisms are written, on purpose:
 *
 *   IfcSite.RefLatitude / RefLongitude / RefElevation — old, coarse, and the
 *     one thing every reader back to IFC2X3 understands. No rotation, no CRS.
 *
 *   IfcMapConversion + IfcProjectedCRS (IFC4 and later) — the real answer:
 *     grid coordinates, the CRS they belong to, the model's rotation on that
 *     grid, and a scale. This is what a surveyor's software reads.
 *
 * Writing only the first loses the rotation; writing only the second loses
 * every IFC2X3 consumer. They cost a handful of lines together.
 */

import {
  appendEntities, editEntityArgs, editEntityById, findEntityId, flt, inner, maxEntityId,
  ref, stepReal, tokeniseArgs, unquote,
} from '@/lib/ifc/stepText';
import { isKnownCrs, utmCrs, utmZoneFor, WGS84 } from './crs';
import {
  fromCompoundAngle, georefFromWorldLocation, headingOf, toCompoundAngle, type GeoReference,
} from './georeference';

export type { GeoReference };

/** id → [type, args], the shape `ifcStepParser` already builds. */
export type StepEntities = Map<number, [string, string[]]>;

export interface GeorefWriteOptions {
  /** IFC2X3 gets IfcSite only — IfcMapConversion does not exist before IFC4. */
  schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  /** IfcProjectedCRS.GeodeticDatum, e.g. 'EPSG:4844' or 'Pulkovo 1942(58)'. */
  geodeticDatum?: string;
  verticalDatum?: string;
  mapProjection?: string;
  mapZone?: string;
}

const DEG = Math.PI / 180;

/** `(44,25,36,480000)` for an IfcCompoundPlaneAngleMeasure. */
function compoundAngleLiteral(deg: number): string {
  // Object.is guards -0, which would print as "0" but must print as "-0"? No:
  // STEP has no signed zero, and a zero component carries no sign anyway.
  return `(${toCompoundAngle(deg).map((v) => (v === 0 ? 0 : v)).join(',')})`;
}

/**
 * Write `gr` into an IFC STEP file.
 *
 * Returns the text unchanged if it has no IfcSite — that means the file did
 * not come from a spatial structure this function understands, and guessing
 * would be worse than leaving it alone.
 */
export function writeGeoreference(
  text: string,
  gr: GeoReference,
  options: GeorefWriteOptions = {},
): string {
  const schema = options.schema ?? 'IFC4';
  if (findEntityId(text, 'IFCSITE') === null) return text;

  let out = text;

  // ── IfcSite: the coarse, universally readable position ───────────────────
  // Attribute order: GlobalId, OwnerHistory, Name, Description, ObjectType,
  // ObjectPlacement, Representation, LongName, CompositionType, RefLatitude,
  // RefLongitude, RefElevation, LandTitleNumber, SiteAddress.
  out = editEntityArgs(out, 'IFCSITE', (args) => {
    while (args.length < 14) args.push('$');
    args[9] = compoundAngleLiteral(gr.lat);
    args[10] = compoundAngleLiteral(gr.lng);
    args[11] = stepReal(gr.elevation);
  });

  const nextId = { v: maxEntityId(out) + 1 };
  const take = () => nextId.v++;
  const added: string[] = [];

  // ── TrueNorth on the model context ───────────────────────────────────────
  // The direction of TRUE north expressed in the MODEL's own x-y plane. The
  // model's +Y points at bearing `rotation` clockwise from true north, so
  // north sits at (-sin rot, cos rot) in model axes.
  //
  // The heading has to come back through the projection: the axis pair in
  // `gr` is measured against GRID north, and the two differ by the meridian
  // convergence. Reading the angle straight off the pair would write grid
  // north into a slot labelled true north — the same degree-or-two error the
  // whole module exists to avoid.
  const rot = trueHeadingOf(gr) * DEG;
  const northId = take();
  added.push(`#${northId}=IFCDIRECTION((${stepReal(-Math.sin(rot))},${stepReal(Math.cos(rot))}));`);
  out = editEntityArgs(out, 'IFCGEOMETRICREPRESENTATIONCONTEXT', (args) => {
    while (args.length < 6) args.push('$');
    args[5] = `#${northId}`;
  });

  // ── IfcMapConversion — the part that actually carries the CRS ────────────
  if (schema !== 'IFC2X3') {
    const q = (s: string | undefined) => (s ? `'${s.replace(/'/g, "''")}'` : '$');
    const numbers = [
      stepReal(gr.eastings), stepReal(gr.northings), stepReal(gr.orthogonalHeight),
      stepReal(gr.xAxisAbscissa), stepReal(gr.xAxisOrdinate), stepReal(gr.scale),
    ];

    const existingId = findEntityId(out, 'IFCMAPCONVERSION');
    if (existingId !== null) {
      // The file is already georeferenced — a model that was placed once and
      // is being placed again. Rewrite the conversion it has rather than
      // appending a second one: two IfcMapConversions on one context is a
      // file whose position depends on which one a reader happens to pick.
      let targetCrs: number | null = null;
      out = editEntityById(out, existingId, (_type, args) => {
        while (args.length < 8) args.push('$');
        targetCrs = ref(args[1]);
        for (let i = 0; i < numbers.length; i++) args[2 + i] = numbers[i];
      });
      if (targetCrs !== null) {
        out = editEntityById(out, targetCrs, (type, args) => {
          if (type !== 'IFCPROJECTEDCRS') return;
          while (args.length < 7) args.push('$');
          args[0] = q(gr.crs);
          if (options.geodeticDatum) args[2] = q(options.geodeticDatum);
          if (options.verticalDatum) args[3] = q(options.verticalDatum);
          if (options.mapProjection) args[4] = q(options.mapProjection);
          if (options.mapZone) args[5] = q(options.mapZone);
        });
      }
    } else {
      const contextId = findEntityId(out, 'IFCGEOMETRICREPRESENTATIONCONTEXT');
      if (contextId !== null) {
        const crsId = take();
        added.push(
          `#${crsId}=IFCPROJECTEDCRS(${q(gr.crs)},$,${q(options.geodeticDatum)},`
          + `${q(options.verticalDatum)},${q(options.mapProjection)},${q(options.mapZone)},$);`,
        );
        added.push(`#${take()}=IFCMAPCONVERSION(#${contextId},#${crsId},${numbers.join(',')});`);
      }
    }
  }

  return appendEntities(out, added);
}

/**
 * Heading of the model's +Y axis, degrees clockwise from TRUE north.
 *
 * Goes through the projection to undo the meridian convergence. If the CRS is
 * unusable — an unknown code, or a file whose IfcProjectedCRS had no name —
 * it falls back to the angle against grid north, which is the best available
 * answer and wrong by at most a degree or two.
 */
function trueHeadingOf(gr: GeoReference): number {
  const gridHeading = Math.atan2(-gr.xAxisOrdinate, gr.xAxisAbscissa) / DEG;
  if (!gr.crs || !isKnownCrs(gr.crs)) return gridHeading;
  try {
    return headingOf(gr);
  } catch {
    return gridHeading;
  }
}

// ── Reading ────────────────────────────────────────────────────────────────

function findFirst(entities: StepEntities, type: string): [number, string[]] | null {
  for (const [id, [t, args]] of entities) {
    if (t === type) return [id, args];
  }
  return null;
}

/**
 * Recover a `GeoReference` from a parsed IFC.
 *
 * Prefers `IfcMapConversion`, which says everything. Falls back to
 * `IfcSite`'s latitude/longitude plus the context's `TrueNorth`, projecting
 * into the UTM zone the site falls in — a file that only carries IfcSite has
 * no opinion about a grid, so one is chosen rather than invented as identity.
 *
 * Returns null when the file carries neither.
 */
export function readGeoreference(entities: StepEntities): GeoReference | null {
  const mc = findFirst(entities, 'IFCMAPCONVERSION');
  if (mc) {
    const [, a] = mc;
    const crsRef = a[1]?.trim() ?? '$';
    let crs = '';
    if (crsRef.startsWith('#')) {
      const target = entities.get(parseInt(crsRef.slice(1), 10));
      if (target && target[0] === 'IFCPROJECTEDCRS') crs = unquote(target[1][0] ?? '');
    }
    const abscissa = a[5] && a[5] !== '$' ? flt(a[5]) : 1;
    const ordinate = a[6] && a[6] !== '$' ? flt(a[6]) : 0;
    const len = Math.hypot(abscissa, ordinate);
    return {
      // Empty means "grid coordinates of an unnamed system" — honest, and
      // `isKnownCrs('')` is false so a caller cannot unproject it by accident.
      // Substituting WGS84 here would hand back metres labelled as degrees.
      crs,
      eastings: flt(a[2]),
      northings: flt(a[3]),
      orthogonalHeight: a[4] && a[4] !== '$' ? flt(a[4]) : 0,
      // Normalise: a writer that rounded the pair leaves it slightly off unit,
      // which would otherwise read back as a scale change on every coordinate.
      xAxisAbscissa: len > 1e-12 ? abscissa / len : 1,
      xAxisOrdinate: len > 1e-12 ? ordinate / len : 0,
      scale: a[7] && a[7] !== '$' ? flt(a[7]) || 1 : 1,
      // Filled in by the caller if it wants geodetic too; IfcSite is the
      // authority for that and may disagree, so it is read separately.
      ...siteLatLng(entities),
    };
  }

  const site = siteLatLng(entities);
  if (site.lat === 0 && site.lng === 0 && site.elevation === 0) return null;

  const crs = fallbackCrsFor(site.lng);
  const rotation = trueNorthHeading(entities);
  return georefFromWorldLocation(
    {
      lat: site.lat, lng: site.lng, alt: site.elevation,
      offsetE: 0, offsetN: 0, offsetZ: 0, rotation,
    },
    crs,
  );
}

/**
 * A file carrying only IfcSite has no opinion about a grid, so one is chosen:
 * the UTM zone the site falls in. Explicitly picked and named, rather than
 * pretending the model was already on a grid.
 */
function fallbackCrsFor(lng: number): string {
  if (!Number.isFinite(lng)) return WGS84;
  return utmCrs(utmZoneFor(lng));
}

/** IfcSite's geodetic position; zeros when absent. */
function siteLatLng(entities: StepEntities): { lat: number; lng: number; elevation: number } {
  const site = findFirst(entities, 'IFCSITE');
  if (!site) return { lat: 0, lng: 0, elevation: 0 };
  const a = site[1];
  const angle = (raw: string | undefined): number => {
    if (!raw || raw.trim() === '$') return 0;
    const parts = tokeniseArgs(inner(raw)).map((v) => parseInt(v.trim(), 10) || 0);
    return parts.length ? fromCompoundAngle(parts) : 0;
  };
  return {
    lat: angle(a[9]),
    lng: angle(a[10]),
    elevation: a[11] && a[11].trim() !== '$' ? flt(a[11]) : 0,
  };
}

/** Heading in degrees CW from true north, read off the context's TrueNorth. */
function trueNorthHeading(entities: StepEntities): number {
  const ctx = findFirst(entities, 'IFCGEOMETRICREPRESENTATIONCONTEXT');
  const raw = ctx?.[1][5]?.trim();
  if (!raw || !raw.startsWith('#')) return 0;
  const dir = entities.get(parseInt(raw.slice(1), 10));
  if (!dir || dir[0] !== 'IFCDIRECTION') return 0;
  const parts = tokeniseArgs(inner(dir[1][0] ?? '')).map((v) => flt(v));
  if (parts.length < 2) return 0;
  const [x, y] = parts;
  if (Math.hypot(x, y) < 1e-12) return 0;
  // north = (-sin rot, cos rot)  ⇒  rot = atan2(-x, y)
  return Math.atan2(-x, y) / DEG;
}

/** True when `code` can be projected into — re-exported for callers validating input. */
export { isKnownCrs };
