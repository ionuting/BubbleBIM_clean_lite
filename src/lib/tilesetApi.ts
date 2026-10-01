/**
 * tilesetApi.ts — loading a 3D Tiles set that already exists.
 *
 * Two ways in, because there are two kinds of tileset a person actually has:
 *
 *   • an ARCHIVE — a zip holding `tileset.json` and its tiles. This is what
 *     `packageTileset` exports from this very app, and what Cesium ion,
 *     RealityCapture and the Python converters here all produce. A browser
 *     cannot open one from a file picker: a `File` has no siblings, so the
 *     relative content URIs inside the tileset resolve to nothing. It goes to
 *     the backend, which unpacks it and serves the folder.
 *
 *   • a URL — anything already hosted. Nothing to upload; Cesium fetches it
 *     directly. The catch is CORS: a server that does not allow this origin
 *     fails inside Cesium with an error that says very little, so the URL is
 *     probed here first and the problem is named before the tileset is built.
 */

const RAW = import.meta.env.VITE_API_URL as string | undefined;
const BASE = (RAW ? RAW.replace(/\/api\/?$/, '') : 'http://localhost:8000').replace(/\/$/, '');

export interface TilesetInfo {
  id: string;
  name: string;
  bytes: number;
  unpackedBytes: number;
  files: number;
  entry: string;
  /** Path on the backend; `tilesetUrlOf` makes it absolute. */
  url: string;
  version?: string;
  geometricError?: number;
  refine?: string;
  tiles?: number;
  contentTypes?: string[];
  hasTransform?: boolean;
}

export function tilesetUrlOf(info: TilesetInfo): string {
  return `${BASE}${info.url}`;
}

export async function uploadTilesetArchive(file: File, name?: string): Promise<TilesetInfo> {
  const body = new FormData();
  body.append('file', file);
  if (name) body.append('name', name);
  const res = await fetch(`${BASE}/api/tileset/upload`, { method: 'POST', body });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export async function deleteTileset(id: string): Promise<void> {
  await fetch(`${BASE}/api/tileset/${id}`, { method: 'DELETE' }).catch(() => undefined);
}

/**
 * Check a remote tileset before handing it to Cesium.
 *
 * Returns the parsed document on success. The two failures worth separating
 * are "the server will not talk to this page" and "that is not a tileset",
 * because the fix is completely different and Cesium reports neither.
 */
export async function probeTilesetUrl(url: string): Promise<{ tiles: number; version?: string }> {
  let res: Response;
  try {
    res = await fetch(url, { mode: 'cors' });
  } catch {
    throw new Error(
      'Serverul nu permite accesul din această pagină (CORS), sau adresa nu răspunde.',
    );
  }
  if (!res.ok) throw new Error(`Adresa a răspuns cu HTTP ${res.status}`);

  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    throw new Error('Adresa nu întoarce JSON — trebuie să fie un tileset.json');
  }
  const d = doc as { asset?: { version?: string }; root?: unknown };
  if (!d || typeof d !== 'object' || !d.root) {
    throw new Error('JSON-ul nu are un „root” — nu pare un tileset 3D Tiles');
  }
  return { tiles: countTiles(d.root), version: d.asset?.version };
}

function countTiles(tile: unknown): number {
  if (!tile || typeof tile !== 'object') return 0;
  const t = tile as { content?: { uri?: string }; children?: unknown[] };
  const own = t.content?.uri ? 1 : 0;
  return own + (t.children ?? []).reduce<number>((n, c) => n + countTiles(c), 0);
}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.detail ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
