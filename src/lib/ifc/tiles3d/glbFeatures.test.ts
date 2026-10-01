import { describe, expect, it } from 'vitest';
import {
  CHUNK_BIN, CHUNK_JSON, GLB_MAGIC, GLB_VERSION, METADATA_CLASS, PROPERTY_NAMES,
  buildGlb, dataUriToBytes, decodeBase64, encodeBase64,
  injectFeatureMetadata, parseGlb,
  type FeatureTable,
} from './glbFeatures';

/** The smallest glTF JSON that is worth injecting into: one mesh, two
 *  primitives, only the first of which the exporter gave feature ids. */
function minimalJson(): Record<string, unknown> {
  return {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 8 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' }],
    meshes: [{
      primitives: [
        { attributes: { POSITION: 0, _FEATURE_ID_0: 0 } },
        { attributes: { POSITION: 0 } },
      ],
    }],
    nodes: [{ mesh: 0, name: 'ifc:m:41' }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}

const TABLE: FeatureTable = {
  guids: ['2O2Fr$t4X7Zf8NOew3FLKr', null, '1kTvXnbbzCWw8lcMd1dR4o'],
  categories: ['IFCWALL', 'IFCDOOR', 'IFCSLAB'],
  names: ['Perete exterior', '', 'Placă peste parter'],
  localIds: [41, 42, 43],
};

/** Walk into the injected extension without fighting `unknown` at each step. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function at(root: unknown, path: string): any {
  // `any` is the honest type for "an arbitrary path into a parsed glTF" in a
  // test; the assertions below are what actually pin the shape down.
  let cur: unknown = root;
  for (const key of path.split('.')) {
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function header(glb: ArrayBuffer): { magic: number; version: number; length: number } {
  const v = new DataView(glb);
  return { magic: v.getUint32(0, true), version: v.getUint32(4, true), length: v.getUint32(8, true) };
}

/** The chunks as the container actually lays them out, padding included. */
function chunks(glb: ArrayBuffer): Array<{ type: number; length: number; bytes: Uint8Array }> {
  const v = new DataView(glb);
  const out: Array<{ type: number; length: number; bytes: Uint8Array }> = [];
  let at0 = 12;
  while (at0 + 8 <= glb.byteLength) {
    const length = v.getUint32(at0, true);
    const type = v.getUint32(at0 + 4, true);
    out.push({ type, length, bytes: new Uint8Array(glb, at0 + 8, length) });
    at0 += 8 + length;
  }
  return out;
}

describe('the GLB container', () => {
  it('stamps the magic, the version and the real total length', () => {
    const glb = buildGlb(minimalJson(), new Uint8Array([1, 2, 3, 4]));
    const h = header(glb);
    expect(h.magic).toBe(GLB_MAGIC);
    expect(h.version).toBe(GLB_VERSION);
    expect(h.length).toBe(glb.byteLength);
  });

  it('round-trips the JSON and the binary unchanged', () => {
    const json = minimalJson();
    const bin = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
    const back = parseGlb(buildGlb(json, bin));
    expect(back.json).toEqual(json);
    expect(back.bin).toEqual(bin);
  });

  it('round-trips a glTF with no binary chunk at all', () => {
    const json = minimalJson();
    const back = parseGlb(buildGlb(json, null));
    expect(back.json).toEqual(json);
    expect(back.bin).toBeNull();
    expect(chunks(buildGlb(json, null))).toHaveLength(1);
  });

  it('pads both chunks to a four-byte boundary with the filler each one requires', () => {
    // A JSON chunk of a length that is certainly not a multiple of four, and a
    // three-byte BIN chunk.
    const glb = buildGlb({ a: 1 }, new Uint8Array([1, 2, 3]));
    const [jsonChunk, binChunk] = chunks(glb);
    expect(jsonChunk.length % 4).toBe(0);
    expect(binChunk.length % 4).toBe(0);
    expect(glb.byteLength % 4).toBe(0);
    // JSON pads with spaces so the chunk still parses as JSON…
    expect(jsonChunk.bytes[jsonChunk.length - 1]).toBe(0x20);
    // …and BIN pads with zeros.
    expect([...binChunk.bytes]).toEqual([1, 2, 3, 0]);
  });

  it('labels the chunks with the types a glTF reader looks for', () => {
    const [jsonChunk, binChunk] = chunks(buildGlb({ a: 1 }, new Uint8Array([0])));
    expect(jsonChunk.type).toBe(CHUNK_JSON);
    expect(binChunk.type).toBe(CHUNK_BIN);
  });

  it('hands back the binary chunk exactly as stored, padding and all', () => {
    // Deliberate: trimming would mean guessing which trailing zeros are padding.
    const back = parseGlb(buildGlb({ a: 1 }, new Uint8Array([1, 2, 3])));
    expect(back.bin).toEqual(new Uint8Array([1, 2, 3, 0]));
  });

  it('refuses anything that is not a glTF 2.0 binary, rather than parsing rubbish', () => {
    expect(() => parseGlb(new Uint8Array([1, 2, 3]).buffer)).toThrow(/too short/i);

    const notGlb = new ArrayBuffer(20);
    new DataView(notGlb).setUint32(0, 0x12345678, true);
    expect(() => parseGlb(notGlb)).toThrow(/not a GLB/i);

    const wrongVersion = buildGlb({ a: 1 }, null);
    new DataView(wrongVersion).setUint32(4, 1, true);
    expect(() => parseGlb(wrongVersion)).toThrow(/version/i);

    const truncated = buildGlb({ a: 1 }, null).slice(0, 16);
    expect(() => parseGlb(truncated)).toThrow(/truncated/i);
  });

  it('survives a rebuild without drifting: build, parse, build again gives the same bytes', () => {
    const once = buildGlb(minimalJson(), new Uint8Array([1, 2, 3, 4]));
    const back = parseGlb(once);
    const twice = buildGlb(back.json, back.bin);
    expect([...new Uint8Array(twice)]).toEqual([...new Uint8Array(once)]);
  });
});

describe('base64', () => {
  it('round-trips arbitrary bytes at every remainder of three', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255]) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) & 0xff;
      expect([...decodeBase64(encodeBase64(bytes))]).toEqual([...bytes]);
    }
  });

  it('pads the encoded text to a multiple of four, as base64 requires', () => {
    expect(encodeBase64(new Uint8Array([1]))).toHaveLength(4);
    expect(encodeBase64(new Uint8Array([1, 2]))).toHaveLength(4);
    expect(encodeBase64(new Uint8Array([1, 2, 3]))).toHaveLength(4);
    expect(encodeBase64(new Uint8Array([1, 2, 3, 4]))).toHaveLength(8);
  });

  it('reads back a data: URI and ignores any other URI form', () => {
    const bytes = new Uint8Array([200, 100, 50, 25]);
    const uri = `data:application/octet-stream;base64,${encodeBase64(bytes)}`;
    expect([...(dataUriToBytes(uri) ?? [])]).toEqual([...bytes]);
    expect(dataUriToBytes('buffer.bin')).toBeNull();
    expect(dataUriToBytes('data:text/plain,hello')).toBeNull();
  });
});

describe('injectFeatureMetadata', () => {
  const injected = () => parseGlb(injectFeatureMetadata(buildGlb(minimalJson(), new Uint8Array(8)), TABLE));

  it('produces a container that is still a valid GLB', () => {
    const glb = injectFeatureMetadata(buildGlb(minimalJson(), new Uint8Array(8)), TABLE);
    const h = header(glb);
    expect(h.magic).toBe(GLB_MAGIC);
    expect(h.version).toBe(GLB_VERSION);
    expect(h.length).toBe(glb.byteLength);
    expect(parseGlb(glb).bin).toEqual(new Uint8Array(8));
  });

  it('declares both extensions as used', () => {
    expect(injected().json.extensionsUsed)
      .toEqual(['EXT_structural_metadata', 'EXT_mesh_features']);
  });

  it('adds a property table with the five IFC properties', () => {
    const meta = at(injected().json, 'extensions.EXT_structural_metadata');
    const props = meta.schema.classes[METADATA_CLASS].properties;
    expect(props.guid.type).toBe('STRING');
    expect(props.category.type).toBe('STRING');
    expect(props.name.type).toBe('STRING');
    expect(props.colour.type).toBe('STRING');
    expect(props.localId).toEqual({ name: 'Fragments local id', type: 'SCALAR', componentType: 'UINT32' });

    expect(meta.propertyTables).toHaveLength(1);
    expect(meta.propertyTables[0].class).toBe(METADATA_CLASS);
    expect(meta.propertyTables[0].count).toBe(3);

    // The exported names are the contract a Cesium styling expression writes
    // against, so they must be the names that actually reach the file.
    expect(Object.keys(props)).toEqual([...PROPERTY_NAMES]);
    expect(Object.keys(meta.propertyTables[0].properties)).toEqual([...PROPERTY_NAMES]);
  });

  it('marks only the primitive that already carries _FEATURE_ID_0', () => {
    const primitives = at(injected().json, 'meshes.0.primitives');
    expect(primitives[0].extensions.EXT_mesh_features.featureIds)
      .toEqual([{ attribute: 0, featureCount: 3, propertyTable: 0 }]);
    // The second primitive has no feature ids, so it is left exactly as it was.
    expect(primitives[1]).toEqual({ attributes: { POSITION: 0 } });
  });

  it('leaves the existing buffers and bufferViews where they were', () => {
    const json = injected().json;
    expect(at(json, 'buffers.0')).toEqual({ byteLength: 8 });
    expect(at(json, 'bufferViews.0')).toEqual({ buffer: 0, byteOffset: 0, byteLength: 8 });
    expect(at(json, 'accessors')).toEqual(minimalJson().accessors);
  });

  it('puts the metadata in a buffer of its own, carried as a base64 data URI', () => {
    const buffers = at(injected().json, 'buffers');
    expect(buffers).toHaveLength(2);
    expect(buffers[1].uri).toMatch(/^data:application\/octet-stream;base64,/);
    const bytes = dataUriToBytes(buffers[1].uri as string);
    expect(bytes?.length).toBe(buffers[1].byteLength);
  });

  it('keeps every new bufferView inside the new buffer and four-byte aligned', () => {
    const json = injected().json;
    const buffers = at(json, 'buffers');
    const views = at(json, 'bufferViews') as Array<Record<string, number>>;
    const mine = views.slice(1);
    expect(mine.length).toBe(9);           // four strings (values + offsets) plus the scalars
    for (const v of mine) {
      expect(v.buffer).toBe(1);
      expect(v.byteOffset % 4).toBe(0);
      expect(v.byteLength).toBeGreaterThan(0);
      expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(buffers[1].byteLength as number);
    }
  });

  it('writes string offsets that increase and cut the buffer back into the original strings', () => {
    const json = injected().json;
    const blob = dataUriToBytes(at(json, 'buffers.1.uri') as string);
    expect(blob).not.toBeNull();
    const views = at(json, 'bufferViews') as Array<Record<string, number>>;
    const table = at(json, 'extensions.EXT_structural_metadata.propertyTables.0');

    const read = (property: string): string[] => {
      const valuesView = views[table.properties[property].values as number];
      const offsetsView = views[table.properties[property].stringOffsets as number];
      const offsets = new Uint32Array(
        (blob as Uint8Array).buffer.slice(
          (blob as Uint8Array).byteOffset + offsetsView.byteOffset,
          (blob as Uint8Array).byteOffset + offsetsView.byteOffset + offsetsView.byteLength,
        ),
      );
      // Monotonic: a string can be empty, but an offset may never go backwards.
      for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);
      expect(offsets).toHaveLength(table.count + 1);
      const decoder = new TextDecoder();
      const out: string[] = [];
      for (let i = 0; i < table.count; i++) {
        out.push(decoder.decode(
          (blob as Uint8Array).subarray(
            valuesView.byteOffset + offsets[i],
            valuesView.byteOffset + offsets[i + 1],
          ),
        ));
      }
      return out;
    };

    // A null GUID becomes an empty string; everything else survives verbatim,
    // diacritics included.
    expect(read('guid')).toEqual(['2O2Fr$t4X7Zf8NOew3FLKr', '', '1kTvXnbbzCWw8lcMd1dR4o']);
    expect(read('category')).toEqual(['IFCWALL', 'IFCDOOR', 'IFCSLAB']);
    expect(read('name')).toEqual(['Perete exterior', '', 'Placă peste parter']);
  });

  it('stores the local ids as UINT32 scalars in order', () => {
    const json = injected().json;
    const blob = dataUriToBytes(at(json, 'buffers.1.uri') as string) as Uint8Array;
    const views = at(json, 'bufferViews') as Array<Record<string, number>>;
    const table = at(json, 'extensions.EXT_structural_metadata.propertyTables.0');
    const view = views[table.properties.localId.values as number];
    const ids = new Uint32Array(blob.buffer.slice(
      blob.byteOffset + view.byteOffset,
      blob.byteOffset + view.byteOffset + view.byteLength,
    ));
    expect([...ids]).toEqual([41, 42, 43]);
    expect(table.properties.localId.stringOffsets).toBeUndefined();
  });

  it('says nothing at all for an empty feature table, rather than an illegal zero-row one', () => {
    const source = buildGlb(minimalJson(), new Uint8Array(8));
    const out = injectFeatureMetadata(source, { guids: [], categories: [], names: [], localIds: [] });
    const json = parseGlb(out).json;
    expect(json.extensions).toBeUndefined();
    expect(json.extensionsUsed).toBeUndefined();
    expect(json).toEqual(minimalJson());
    expect([...new Uint8Array(out)]).toEqual([...new Uint8Array(source)]);
  });

  it('survives a table whose strings are all empty — a bufferView may never be zero bytes long', () => {
    const glb = injectFeatureMetadata(buildGlb(minimalJson(), null), {
      guids: [null, null], categories: ['', ''], names: ['', ''], localIds: [1, 2],
    });
    const views = at(parseGlb(glb).json, 'bufferViews') as Array<Record<string, number>>;
    for (const v of views.slice(1)) expect(v.byteLength).toBeGreaterThanOrEqual(1);
  });

  it('pads short columns out rather than losing the features they belong to', () => {
    // A caller that assembled the table from several passes can hand over
    // columns of different lengths; the longest one decides the count.
    const glb = injectFeatureMetadata(buildGlb(minimalJson(), null), {
      guids: ['a', 'b', 'c', 'd'], categories: ['IFCWALL'], names: [], localIds: [7],
    });
    const table = at(parseGlb(glb).json, 'extensions.EXT_structural_metadata.propertyTables.0');
    expect(table.count).toBe(4);
    expect(at(parseGlb(glb).json, 'meshes.0.primitives.0.extensions.EXT_mesh_features.featureIds.0.featureCount'))
      .toBe(4);
  });

  it('adds no mesh-features declaration when nothing in the file has feature ids', () => {
    const plain = { asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] };
    const json = parseGlb(injectFeatureMetadata(buildGlb(plain, null), TABLE)).json;
    expect(json.extensionsUsed).toEqual(['EXT_structural_metadata']);
    expect(at(json, 'meshes.0.primitives.0.extensions')).toBeUndefined();
  });

  it('does not invent arrays a glTF without meshes never had', () => {
    const json = parseGlb(injectFeatureMetadata(buildGlb({ asset: { version: '2.0' } }, null), TABLE)).json;
    expect(json.meshes).toBeUndefined();
    expect(Array.isArray(json.buffers)).toBe(true);
  });
});
