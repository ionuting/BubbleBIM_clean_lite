/**
 * featurePick.ts — what a click on an imported layer has to say for itself.
 *
 * Two layers in the world view carry their own attributes, and they carry
 * them completely differently:
 *
 *   • a CityJSON object has an `attributes` record read straight out of the
 *     file, plus the identity CityJSON gives it — an id, a type, a level of
 *     detail, and the parents it belongs to;
 *
 *   • a 3D Tiles feature has a metadata table behind two accessor methods,
 *     `getPropertyIds()` and `getProperty()`, and nothing else. The names are
 *     whatever the person who wrote the tileset chose.
 *
 * Both end as the same `PickedFeature` so one panel draws either, and both
 * are converted here — away from Cesium — so the conversion can be tested
 * without a WebGL context. The tiles side takes a duck-typed feature for
 * exactly that reason: the two methods are the whole contract.
 *
 * Values are formatted, never trusted to render themselves: a 3D Tiles
 * property can hold an array, a nested object or a `BigInt`, and React
 * throws on the last of those rather than printing it.
 */

/** A titled block of key/value rows. */
export interface FeatureGroup {
  name: string;
  rows: [string, string][];
}

export interface PickedFeature {
  source: 'cityjson' | 'tiles';
  /** Which loaded layer it came from, so two models are distinguishable. */
  layer: string;
  /** The headline — a name if there is one, otherwise the id. */
  title: string;
  /** The object's class: a CityJSON type, or the tileset's own name. */
  subtitle: string;
  /** The identity rows, shown above the groups and never collapsed. */
  identity: [string, string][];
  groups: FeatureGroup[];
}

/**
 * One value as one line of text.
 *
 * Deliberately lossy for containers: a panel row is a line, and a nested
 * object printed as `[object Object]` is worse than JSON that is cut short.
 */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v.length ? v : '—';
  if (typeof v === 'boolean') return v ? 'da' : 'nu';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
  }
  if (Array.isArray(v)) {
    // Numbers read better as a plain list than as JSON — a coordinate or an
    // extent is the common case.
    if (v.every((x) => typeof x === 'number')) return v.map((x) => formatValue(x)).join(', ');
    return truncate(JSON.stringify(v));
  }
  if (v instanceof Date) return v.toISOString();
  try {
    return truncate(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

const MAX_VALUE_CHARS = 400;
const truncate = (s: string): string =>
  s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS)}…` : s;

/** Attributes in a stable, readable order: named things first, then the rest. */
function rowsOf(attrs: Record<string, unknown>, skip: Set<string> = new Set()): [string, string][] {
  return Object.entries(attrs)
    .filter(([k]) => !skip.has(k))
    .sort(([a], [b]) => a.localeCompare(b, 'ro'))
    .map(([k, v]) => [k, formatValue(v)] as [string, string]);
}

/** What `toCesium.ts` puts on each instance, restated so this module imports nothing. */
export interface CityPickLike {
  cityObjectId: string;
  type: string;
  attributes: Record<string, unknown>;
  lod?: string;
  parents?: string[];
}

/** Is this what a CityJSON instance id looks like? */
export function isCityPick(v: unknown): v is CityPickLike {
  return !!v && typeof v === 'object'
    && typeof (v as CityPickLike).cityObjectId === 'string'
    && typeof (v as CityPickLike).type === 'string';
}

export function cityJsonFeature(pick: CityPickLike, layer: string): PickedFeature {
  const attrs = pick.attributes ?? {};
  // CityJSON has no required name; most writers put one in `attributes`.
  const name = typeof attrs.name === 'string' && attrs.name.trim()
    ? attrs.name.trim()
    : null;

  const identity: [string, string][] = [['id', pick.cityObjectId], ['tip', pick.type]];
  if (pick.lod) identity.push(['LoD', pick.lod]);
  if (pick.parents?.length) identity.push(['părinte', pick.parents.join(', ')]);

  // The name is already the title; repeating it as a row is noise.
  const rows = rowsOf(attrs, new Set(name ? ['name'] : []));

  return {
    source: 'cityjson',
    layer,
    title: name ?? pick.cityObjectId,
    subtitle: pick.type,
    identity,
    groups: rows.length ? [{ name: 'Atribute', rows }] : [],
  };
}

/** The two methods of `Cesium3DTileFeature` this module actually uses. */
export interface TileFeatureLike {
  getPropertyIds(results?: string[]): string[];
  getProperty(name: string): unknown;
  featureId?: number;
}

/**
 * A 3D Tiles feature's metadata.
 *
 * The property names are the tileset author's, so nothing can be assumed
 * about them — except that a few spellings of "name" are worth promoting to
 * the title, since a panel headed by a batch index helps nobody.
 */
const NAME_KEYS = ['name', 'Name', 'NAME', 'title', 'label'];

export function tilesFeature(feature: TileFeatureLike, layer: string): PickedFeature {
  let ids: string[] = [];
  try {
    ids = feature.getPropertyIds() ?? [];
  } catch {
    ids = [];
  }

  const props: Record<string, unknown> = {};
  for (const id of ids) {
    try {
      props[id] = feature.getProperty(id);
    } catch {
      props[id] = null;
    }
  }

  const nameKey = NAME_KEYS.find((k) => typeof props[k] === 'string' && (props[k] as string).trim());
  const title = nameKey
    ? (props[nameKey] as string).trim()
    : feature.featureId !== undefined ? `Element ${feature.featureId}` : 'Element';

  const identity: [string, string][] = [];
  if (feature.featureId !== undefined) identity.push(['id element', String(feature.featureId)]);
  identity.push(['proprietăți', String(ids.length)]);

  const rows = rowsOf(props, new Set(nameKey ? [nameKey] : []));

  return {
    source: 'tiles',
    layer,
    title,
    subtitle: '3D Tiles',
    identity,
    groups: rows.length
      ? [{ name: 'Atribute', rows }]
      // A tileset with no metadata table is a normal thing to meet, and
      // saying so beats an empty panel that looks broken.
      : [],
  };
}
