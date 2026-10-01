/**
 * glbFeatures.ts — giving the elements inside a GLB names Cesium can pick.
 *
 * Three's `GLTFExporter` produces geometry and nothing else. Once a tile is a
 * GLB, the IFC elements inside it are anonymous triangles: Cesium can draw them
 * but cannot tell you which wall you clicked, cannot colour every IFCDOOR, and
 * cannot hide one storey. The 3D Tiles answer is a pair of glTF extensions —
 * `EXT_mesh_features` marks each vertex with a feature id, and
 * `EXT_structural_metadata` hangs a table of properties off those ids — and
 * neither is something `GLTFExporter` will write for us.
 *
 * So this module does the unglamorous thing: it takes the finished GLB, opens
 * the container, edits the JSON, and closes it again. Two halves, both pure and
 * both testable without an exporter anywhere near them:
 *
 *   • `parseGlb` / `buildGlb` — the container. A 12-byte header then chunks,
 *     each 4-byte aligned, each padded with its OWN filler byte (spaces for
 *     JSON so it stays parseable, zeros for BIN), and a total length in the
 *     header that must match to the byte or nothing will open the file.
 *
 *   • `injectFeatureMetadata` — the edit. It assumes the caller has already
 *     put a `_FEATURE_ID_0` attribute on every primitive (one id per vertex,
 *     indexing the table rows in order); it supplies the extensions that give
 *     those ids meaning.
 *
 * ── Why the strings live in a data: URI ──────────────────────────────────────
 *
 * A property table is not JSON — the values are binary, and STRING properties
 * need two buffers each: the UTF-8 bytes end to end, and a UINT32 offset per
 * string saying where it starts (plus one final offset for the end of the last).
 *
 * The tidy place for that is the GLB's BIN chunk. The tidy place is also the
 * expensive one: appending means every existing `bufferView.byteOffset` stays
 * valid only if we append at the end AND the existing buffer's `byteLength`
 * is rewritten AND the alignment rules for each accessor's component type are
 * preserved through the join. That is a real piece of glTF surgery for a module
 * whose job is metadata.
 *
 * Instead the metadata gets a buffer of its own, carried inline as a
 * base64 `data:` URI. Nothing existing moves, so nothing existing can break.
 * The trade-off is real and the integrator should know it: base64 costs a third
 * more bytes than raw binary, and the whole table sits in the JSON chunk, so it
 * is parsed as text before the first triangle is drawn. For per-element IFC
 * metadata — a GUID, a category and a name per element, a few tens of
 * kilobytes for a tile of a few thousand elements — that is a price worth
 * paying for an edit that cannot corrupt the geometry. For a tile carrying
 * megabytes of properties it would not be, and the BIN-append version should
 * be written then.
 */

// ── The GLB container ────────────────────────────────────────────────────────

/** 'glTF' little-endian. */
export const GLB_MAGIC = 0x46546c67;
export const GLB_VERSION = 2;
/** 'JSON' little-endian. */
export const CHUNK_JSON = 0x4e4f534a;
/** 'BIN\0' little-endian. */
export const CHUNK_BIN = 0x004e4942;

const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
/** JSON pads with spaces so the chunk stays valid JSON; BIN pads with zeros. */
const PAD_JSON = 0x20;
const PAD_BIN = 0x00;

const align4 = (n: number): number => (n + 3) & ~3;

/**
 * Open a GLB.
 *
 * Returns the parsed JSON chunk and the BIN chunk exactly as stored — including
 * any alignment padding the writer added, because trimming it would require
 * guessing which trailing zeros are padding and which are geometry.
 *
 * Throws on anything that is not a glTF 2.0 binary container: a caller that has
 * been handed a .gltf, a truncated download or a zip is better off finding out
 * here than three layers further on.
 */
export function parseGlb(glb: ArrayBuffer): { json: Record<string, unknown>; bin: Uint8Array | null } {
  if (glb.byteLength < HEADER_BYTES) throw new Error('GLB too short to hold a header');
  const view = new DataView(glb);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) throw new Error(`not a GLB: magic 0x${magic.toString(16)}`);
  const version = view.getUint32(4, true);
  if (version !== GLB_VERSION) throw new Error(`unsupported GLB version ${version}`);

  // The header's length field is authoritative, but a buffer that is merely
  // longer (a slice of a bigger download) is common and harmless; only a
  // SHORTER one is a real truncation.
  const declared = view.getUint32(8, true);
  const end = Math.min(declared, glb.byteLength);
  if (declared > glb.byteLength) throw new Error('GLB truncated: header length exceeds the buffer');

  let json: Record<string, unknown> | null = null;
  let bin: Uint8Array | null = null;
  let at = HEADER_BYTES;

  while (at + CHUNK_HEADER_BYTES <= end) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const start = at + CHUNK_HEADER_BYTES;
    if (start + length > end) throw new Error('GLB truncated: chunk runs past the end');
    const bytes = new Uint8Array(glb, start, length);
    // Unknown chunk types are skipped rather than rejected — the spec reserves
    // them for future use and requires readers to ignore what they don't know.
    if (type === CHUNK_JSON && json === null) {
      json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } else if (type === CHUNK_BIN && bin === null) {
      // Copied out: the caller may outlive the input ArrayBuffer, and a view
      // into someone else's buffer is a lifetime problem waiting to happen.
      bin = bytes.slice();
    }
    at = start + length;
  }

  if (json === null) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

/**
 * Close a GLB.
 *
 * Every chunk is padded up to a 4-byte boundary with its own filler, the two
 * chunk lengths count that padding, and the header's total length counts
 * everything — get any one of those three wrong and the file is silently
 * unreadable. A null `bin` omits the BIN chunk entirely, which is legal and is
 * what a geometry-free or fully data-URI'd glTF looks like.
 */
export function buildGlb(json: Record<string, unknown>, bin: Uint8Array | null): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = align4(jsonBytes.length);
  const binPadded = bin ? align4(bin.length) : 0;

  const total = HEADER_BYTES
    + CHUNK_HEADER_BYTES + jsonPadded
    + (bin ? CHUNK_HEADER_BYTES + binPadded : 0);

  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, total, true);

  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, CHUNK_JSON, true);
  bytes.set(jsonBytes, 20);
  bytes.fill(PAD_JSON, 20 + jsonBytes.length, 20 + jsonPadded);

  if (bin) {
    const at = 20 + jsonPadded;
    view.setUint32(at, binPadded, true);
    view.setUint32(at + 4, CHUNK_BIN, true);
    bytes.set(bin, at + 8);
    bytes.fill(PAD_BIN, at + 8 + bin.length, at + 8 + binPadded);
  }

  return out;
}

// ── base64, without a dependency ─────────────────────────────────────────────
//
// `btoa` is a DOM API and `Buffer` is a Node one; this module runs under both
// and under vitest, so it carries its own. Twenty lines is cheaper than a
// polyfill decision.

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += has1 ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += has2 ? B64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array {
  // Padding and whitespace are dropped rather than trusted; the group sizes
  // below already say how many bytes each quartet is worth.
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const n0 = B64_ALPHABET.indexOf(clean[i]);
    const n1 = B64_ALPHABET.indexOf(clean[i + 1]);
    const n2 = i + 2 < clean.length ? B64_ALPHABET.indexOf(clean[i + 2]) : -1;
    const n3 = i + 3 < clean.length ? B64_ALPHABET.indexOf(clean[i + 3]) : -1;
    out[o++] = (n0 << 2) | (n1 >> 4);
    if (n2 >= 0) out[o++] = ((n1 & 0x0f) << 4) | (n2 >> 2);
    if (n3 >= 0) out[o++] = ((n2 & 0x03) << 6) | n3;
  }
  return out.subarray(0, o);
}

/** The bytes behind a `data:...;base64,...` URI, for reading back a buffer this
 *  module wrote. Returns null for any other URI form. */
export function dataUriToBytes(uri: string): Uint8Array | null {
  const cut = uri.indexOf(';base64,');
  if (!uri.startsWith('data:') || cut < 0) return null;
  return decodeBase64(uri.slice(cut + ';base64,'.length));
}

// ── The metadata edit ────────────────────────────────────────────────────────

export interface FeatureTable {
  /** One entry per feature id, in order. Null where the element has no GlobalId. */
  guids: (string | null)[];
  categories: string[];
  names: string[];
  localIds: number[];
  /**
   * `#rrggbb` per feature — the colour the element had in the model.
   *
   * Geometry is merged per colour, so the tile already LOOKS right without
   * this. It is in the table so a styling expression can address colour the
   * way it addresses category: `${colour} === '#c8b18c'`. Absent entries read
   * as an empty string, which no expression will match by accident.
   */
  colours?: string[];
}

/** The class and table names the injected schema uses. Exported because a
 *  styling expression in Cesium refers to properties by these names. */
export const METADATA_CLASS = 'ifcElement';
export const PROPERTY_NAMES = ['guid', 'category', 'name', 'colour', 'localId'] as const;

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read an array-valued key without creating it — walking the meshes must not
 *  leave an empty `"meshes": []` behind on a glTF that had none. */
function readArray(parent: JsonObject, key: string): unknown[] {
  const existing = parent[key];
  return Array.isArray(existing) ? existing : [];
}

/** Read an array-valued key, creating it if absent, so the caller can push. */
function arrayAt(parent: JsonObject, key: string): unknown[] {
  const existing = parent[key];
  if (Array.isArray(existing)) return existing;
  const made: unknown[] = [];
  parent[key] = made;
  return made;
}

/** Read an object-valued key, creating it if absent. */
function objectAt(parent: JsonObject, key: string): JsonObject {
  const existing = parent[key];
  if (isObject(existing)) return existing;
  const made: JsonObject = {};
  parent[key] = made;
  return made;
}

/** How many features the table describes. Arrays of different lengths are a
 *  caller bug, but the longest one is the least destructive reading of it —
 *  a short array yields empty strings and zeros rather than losing features. */
function featureCountOf(table: FeatureTable): number {
  return Math.max(
    table.guids.length, table.categories.length,
    table.names.length, table.localIds.length,
    table.colours?.length ?? 0,
  );
}

/** One STRING property's two buffers: UTF-8 values end to end, and the
 *  count+1 UINT32 offsets that cut them apart again. */
function encodeStrings(values: string[]): { values: Uint8Array; offsets: Uint8Array } {
  const encoder = new TextEncoder();
  const parts = values.map((s) => encoder.encode(s));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  // count + 1: the last offset is the end of the last string, which is what
  // makes the final string's length knowable.
  const offsets = new Uint32Array(parts.length + 1);
  let at = 0;
  parts.forEach((p, i) => {
    offsets[i] = at;
    bytes.set(p, at);
    at += p.length;
  });
  offsets[parts.length] = at;
  // Viewed as bytes in the platform's own order. glTF requires little-endian
  // and every platform this runs on is little-endian; a big-endian host would
  // need an explicit DataView write here.
  return { values: bytes, offsets: new Uint8Array(offsets.buffer) };
}

/**
 * Add the feature-id and metadata extensions to a GLB.
 *
 * The caller is responsible for `_FEATURE_ID_0`: this walks every primitive and
 * only touches the ones that already carry that attribute, so a mesh the
 * exporter produced without feature ids (a helper, a ground plane) is left
 * exactly as it was rather than being given ids that index nothing.
 *
 * An empty table injects nothing and returns an equivalent GLB. That is a
 * deliberate choice over emitting a zero-row table: a `propertyTable` with
 * `count: 0` needs zero-length bufferViews, which the glTF spec forbids, so
 * "no features" is better said by saying nothing at all.
 */
export function injectFeatureMetadata(glb: ArrayBuffer, table: FeatureTable): ArrayBuffer {
  const { json, bin } = parseGlb(glb);
  const count = featureCountOf(table);
  if (count === 0) return buildGlb(json, bin);

  // Normalise the four columns to the same length. A null GUID becomes an
  // empty string: EXT_structural_metadata has no null for a STRING without
  // declaring noData, and "" is unambiguous — no IFC GlobalId is empty.
  const guids: string[] = [];
  const categories: string[] = [];
  const names: string[] = [];
  const colours: string[] = [];
  const localIds = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    guids.push(table.guids[i] ?? '');
    categories.push(table.categories[i] ?? '');
    names.push(table.names[i] ?? '');
    colours.push(table.colours?.[i] ?? '');
    const id = table.localIds[i];
    localIds[i] = Number.isFinite(id) && id >= 0 ? Math.floor(id) : 0;
  }

  const guidData = encodeStrings(guids);
  const categoryData = encodeStrings(categories);
  const nameData = encodeStrings(names);
  const colourData = encodeStrings(colours);
  const localIdBytes = new Uint8Array(localIds.buffer);

  // Lay the sections out 4-byte aligned. Every UINT32 array here is read
  // directly out of the buffer, so a misaligned offset is a hard failure in
  // some runtimes and a silent misread in others.
  const sections: Uint8Array[] = [
    guidData.values, guidData.offsets,
    categoryData.values, categoryData.offsets,
    nameData.values, nameData.offsets,
    colourData.values, colourData.offsets,
    localIdBytes,
  ];
  const offsets: number[] = [];
  let cursor = 0;
  for (const s of sections) {
    offsets.push(cursor);
    // A bufferView must be at least one byte long, and a table whose strings
    // are all empty would otherwise produce a zero-length one. The spare byte
    // is never read: the offsets say every string is empty.
    cursor = align4(cursor + Math.max(1, s.length));
  }
  const blob = new Uint8Array(cursor);
  sections.forEach((s, i) => blob.set(s, offsets[i]));

  const buffers = arrayAt(json, 'buffers');
  const bufferIndex = buffers.length;
  buffers.push({
    uri: `data:application/octet-stream;base64,${encodeBase64(blob)}`,
    byteLength: blob.length,
  });

  const bufferViews = arrayAt(json, 'bufferViews');
  const viewIndex = sections.map((s, i) => {
    const index = bufferViews.length;
    // No `target`: these are read by the metadata extension, not bound as a
    // vertex or index buffer, and declaring a target would be a lie.
    bufferViews.push({
      buffer: bufferIndex,
      byteOffset: offsets[i],
      byteLength: Math.max(1, s.length),
    });
    return index;
  });
  const [
    guidValues, guidOffsets,
    categoryValues, categoryOffsets,
    nameValues, nameOffsets,
    colourValues, colourOffsets,
    localIdValues,
  ] = viewIndex;

  const extensions = objectAt(json, 'extensions');
  extensions.EXT_structural_metadata = {
    schema: {
      id: 'ifcElementSchema',
      classes: {
        [METADATA_CLASS]: {
          name: 'IFC element',
          properties: {
            guid: { name: 'GlobalId', type: 'STRING' },
            category: { name: 'IFC category', type: 'STRING' },
            name: { name: 'Name', type: 'STRING' },
            colour: { name: 'Colour', type: 'STRING' },
            localId: { name: 'Fragments local id', type: 'SCALAR', componentType: 'UINT32' },
          },
        },
      },
    },
    propertyTables: [{
      name: 'IFC elements',
      class: METADATA_CLASS,
      count,
      properties: {
        guid: { values: guidValues, stringOffsets: guidOffsets },
        category: { values: categoryValues, stringOffsets: categoryOffsets },
        name: { values: nameValues, stringOffsets: nameOffsets },
        colour: { values: colourValues, stringOffsets: colourOffsets },
        localId: { values: localIdValues },
      },
    }],
  };

  // `attribute: 0` means the `_FEATURE_ID_0` attribute — the number is the
  // attribute's set index, not a bufferView or accessor.
  const featureIds = [{ attribute: 0, featureCount: count, propertyTable: 0 }];
  let touched = 0;
  for (const mesh of readArray(json, 'meshes')) {
    if (!isObject(mesh)) continue;
    for (const primitive of readArray(mesh, 'primitives')) {
      if (!isObject(primitive)) continue;
      const attributes = primitive.attributes;
      if (!isObject(attributes) || !('_FEATURE_ID_0' in attributes)) continue;
      objectAt(primitive, 'extensions').EXT_mesh_features = { featureIds };
      touched++;
    }
  }

  const used = arrayAt(json, 'extensionsUsed');
  if (!used.includes('EXT_structural_metadata')) used.push('EXT_structural_metadata');
  // Only declared when something actually uses it: an unused entry in
  // extensionsUsed makes a validator complain and tells a reader a lie.
  if (touched > 0 && !used.includes('EXT_mesh_features')) used.push('EXT_mesh_features');

  return buildGlb(json, bin);
}
