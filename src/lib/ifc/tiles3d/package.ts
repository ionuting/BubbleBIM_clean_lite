/**
 * package.ts — turning a live tileset into a file the user can keep.
 *
 * `buildTilesetFromGroup` produces something that works in THIS tab and nowhere
 * else: a `tileset.json` whose content URIs are `blob:` URLs, valid only for
 * the lifetime of the document that created them. Downloading that JSON gives
 * you a file that points at nothing.
 *
 * Packaging is therefore two jobs, and only the second one needs a browser:
 *
 *   • rewrite the document so the tiles are named by RELATIVE path, and stamp
 *     the placement into the root tile's `transform` — pure, and the half that
 *     decides whether the archive lands on the right patch of Earth;
 *
 *   • fetch the blobs back and zip them — thin, and untestable without a DOM.
 *
 * ## Why the transform goes in the file
 *
 * The live view deliberately leaves `root.transform` unset and places the
 * tileset through the primitive's `modelMatrix`, so dragging the model never
 * rebuilds the tiles. A downloaded tileset has no primitive to be placed by:
 * whatever a viewer is told about where this building stands has to be IN the
 * archive, or the model opens at the centre of the Earth. So the placement is
 * written here — and only here, which is why packaging cannot simply serialise
 * the document the viewer is using.
 */

import type { Tile3D, Tileset3D } from './tileset';
import { buildZip, type ZipEntry } from './zip';

/** Where the tiles are put inside the archive. */
export const TILE_FOLDER = 'tiles';
export const TILESET_FILE = 'tileset.json';

export interface RelocateOptions {
  /**
   * Column-major 4×4 placing the model on the globe — `Matrix4.toArray` of the
   * same east-north-up matrix the live view uses as `modelMatrix`. Omitted, the
   * archive describes a building in local coordinates and says nothing about
   * where it is.
   */
  transform?: number[];
  /** Name for the i-th tile file. Default `tiles/t0.glb`, `tiles/t1.glb`, … */
  fileName?: (index: number) => string;
}

export interface Relocated {
  tileset: Tileset3D;
  /** The original URI of each tile, in the order the new names were assigned. */
  sources: string[];
  /** The path each source was renamed to, same order. */
  paths: string[];
}

/** Every tile in the tree, parents before children, in document order. */
function walk(tile: Tile3D, out: Tile3D[] = []): Tile3D[] {
  out.push(tile);
  for (const child of tile.children ?? []) walk(child, out);
  return out;
}

/**
 * Rewrite a tileset so it can live in a folder.
 *
 * The document is deep-copied: the caller's copy is still driving a live
 * Cesium primitive, and renaming its content URIs out from under it would
 * break the view the user is looking at while they wait for a download.
 */
export function relocateTileset(tileset: Tileset3D, opts: RelocateOptions = {}): Relocated {
  const copy = JSON.parse(JSON.stringify(tileset)) as Tileset3D;
  const nameOf = opts.fileName ?? ((i: number) => `${TILE_FOLDER}/t${i}.glb`);

  const sources: string[] = [];
  const paths: string[] = [];
  let index = 0;
  for (const tile of walk(copy.root)) {
    const uri = tile.content?.uri;
    if (!uri) continue;
    const path = nameOf(index++);
    sources.push(uri);
    paths.push(path);
    tile.content!.uri = path;
  }

  if (opts.transform) copy.root.transform = [...opts.transform];
  return { tileset: copy, sources, paths };
}

export interface PackageResult {
  zip: Uint8Array;
  /** Tiles written, excluding tileset.json. */
  tileCount: number;
}

/**
 * Fetch the tiles back out of their blob URLs and zip them with the rewritten
 * `tileset.json`.
 *
 * `fetchBytes` is injectable so the packing can be exercised without a browser;
 * the default reads the blob URLs the build created.
 */
export async function packageTileset(
  tileset: Tileset3D,
  opts: RelocateOptions & {
    fetchBytes?: (uri: string) => Promise<Uint8Array>;
  } = {},
): Promise<PackageResult> {
  const fetchBytes = opts.fetchBytes ?? (async (uri: string) => {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`Nu am putut citi tile-ul: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  });

  const { tileset: doc, sources, paths } = relocateTileset(tileset, opts);
  if (sources.length === 0) throw new Error('Tileset-ul nu conține niciun tile cu geometrie.');

  const entries: ZipEntry[] = [{
    path: TILESET_FILE,
    data: new TextEncoder().encode(JSON.stringify(doc, null, 2)),
  }];
  for (let i = 0; i < sources.length; i++) {
    entries.push({ path: paths[i], data: await fetchBytes(sources[i]) });
  }

  return { zip: buildZip(entries), tileCount: sources.length };
}
