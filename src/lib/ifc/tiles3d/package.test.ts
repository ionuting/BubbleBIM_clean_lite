/**
 * The archive has to be a working tileset once unzipped: relative URIs that
 * resolve to files that are actually in it, and a placement that survives the
 * trip. The failure this guards is silent — a tileset.json still full of
 * `blob:` URLs downloads fine and opens at nothing.
 */
import { describe, expect, it } from 'vitest';
import { packageTileset, relocateTileset, TILESET_FILE } from './package';
import type { Tile3D, Tileset3D } from './tileset';
import { crc32 } from './zip';

const box = () => [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

const tile = (uri?: string, children?: Tile3D[]): Tile3D => ({
  boundingVolume: { box: box() },
  geometricError: 4,
  ...(uri ? { content: { uri } } : {}),
  ...(children ? { children } : {}),
});

const doc = (root: Tile3D): Tileset3D => ({
  asset: { version: '1.1' }, geometricError: 8, root,
});

/** Read the archive's central directory back into path → bytes. */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    const path = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const data = zip.subarray(dataAt, dataAt + size);
    expect(crc32(data), path).toBe(crc);
    out.set(path, data);
    at += 46 + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return out;
}

describe('relocateTileset', () => {
  it('replaces blob URLs with relative paths', () => {
    const r = relocateTileset(doc(tile(undefined, [tile('blob:a'), tile('blob:b')])));
    expect(r.paths).toEqual(['tiles/t0.glb', 'tiles/t1.glb']);
    expect(r.sources).toEqual(['blob:a', 'blob:b']);
    expect(r.tileset.root.children!.map((c) => c.content!.uri))
      .toEqual(['tiles/t0.glb', 'tiles/t1.glb']);
  });

  it('leaves the caller\'s document alone — it is still driving the live view', () => {
    const original = doc(tile(undefined, [tile('blob:a')]));
    relocateTileset(original, { transform: [1, 0, 0, 0] });
    expect(original.root.children![0].content!.uri).toBe('blob:a');
    expect(original.root.transform).toBeUndefined();
  });

  it('writes the placement into the root, which is the only place a file has', () => {
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4000, 5000, 6000, 1];
    expect(relocateTileset(doc(tile(undefined, [tile('blob:a')])), { transform: m })
      .tileset.root.transform).toEqual(m);
  });

  it('copies the transform rather than aliasing the caller\'s array', () => {
    const m = [1, 0, 0, 0];
    const out = relocateTileset(doc(tile(undefined, [tile('blob:a')])), { transform: m });
    m[0] = 99;
    expect(out.tileset.root.transform![0]).toBe(1);
  });

  it('no transform means a local-coordinate archive, not a zeroed one', () => {
    expect(relocateTileset(doc(tile(undefined, [tile('blob:a')]))).tileset.root.transform)
      .toBeUndefined();
  });

  it('reaches tiles at any depth, and skips a parent that draws nothing', () => {
    const r = relocateTileset(doc(tile(undefined, [tile(undefined, [tile('blob:deep')])])));
    expect(r.sources).toEqual(['blob:deep']);
  });

  it('renames a content tile on the root itself', () => {
    expect(relocateTileset(doc(tile('blob:root'))).tileset.root.content!.uri).toBe('tiles/t0.glb');
  });
});

describe('packageTileset', () => {
  const bytesFor = new Map([
    ['blob:a', new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3])],
    ['blob:b', new Uint8Array(40).fill(0x7f)],
  ]);
  const fetchBytes = async (uri: string) => {
    const b = bytesFor.get(uri);
    if (!b) throw new Error(`no such blob: ${uri}`);
    return b;
  };

  it('produces an archive that unzips into a working tileset', async () => {
    const { zip, tileCount } = await packageTileset(
      doc(tile(undefined, [tile('blob:a'), tile('blob:b')])),
      { fetchBytes, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1] },
    );
    expect(tileCount).toBe(2);

    const files = readZip(zip);
    expect([...files.keys()].sort()).toEqual(['tiles/t0.glb', 'tiles/t1.glb', TILESET_FILE]);

    // Every URI the JSON names must be a file that is actually in the archive.
    const parsed = JSON.parse(new TextDecoder().decode(files.get(TILESET_FILE)!)) as Tileset3D;
    for (const child of parsed.root.children!) {
      expect(child.content!.uri).not.toMatch(/^blob:/);
      expect(files.has(child.content!.uri)).toBe(true);
    }
    expect(parsed.root.transform![12]).toBe(10);

    // And the geometry is the geometry, byte for byte.
    expect(Array.from(files.get('tiles/t0.glb')!)).toEqual(Array.from(bytesFor.get('blob:a')!));
    expect(files.get('tiles/t1.glb')!.length).toBe(40);
  });

  it('refuses a tileset with no geometry rather than shipping an empty archive', async () => {
    await expect(packageTileset(doc(tile()), { fetchBytes })).rejects.toThrow(/niciun tile/);
  });

  it('a tile that cannot be read fails the package — a partial tileset is broken', async () => {
    await expect(packageTileset(doc(tile(undefined, [tile('blob:missing')])), { fetchBytes }))
      .rejects.toThrow();
  });
});
