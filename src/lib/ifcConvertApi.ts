/**
 * ifcConvertApi.ts — ask the Python converter for CityJSON or Cesium 3D Tiles.
 *
 * Both formats come back as a download. The browser still has its own
 * Fragments / tiles path; these two documents are written only in Python.
 */

const RAW = import.meta.env.VITE_API_URL as string | undefined;
const BASE = (RAW ? RAW.replace(/\/api\/?$/, '') : 'http://localhost:8000').replace(/\/$/, '');

export interface CityJsonFile {
  bytes: ArrayBuffer;
  filename: string;
  objects: number;
  vertices: number;
}

export interface CesiumTilesArchive {
  bytes: ArrayBuffer;
  filename: string;
  tiles: number;
  features: number;
}

export async function convertIfcToCesiumTiles(
  file: File,
  opts?: { transform?: number[] },
): Promise<CesiumTilesArchive> {
  const body = new FormData();
  body.append('file', file);
  if (opts?.transform?.length === 16) body.append('transform', JSON.stringify(opts.transform));
  const res = await fetch(`${BASE}/api/ifc/tiles`, { method: 'POST', body });
  if (!res.ok) throw new Error(await readError(res));
  const bytes = await res.arrayBuffer();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^"]+)"?/i.exec(disposition);
  return {
    bytes,
    filename: match?.[1] ?? `${stemOf(file.name)}-3dtiles.zip`,
    tiles: Number(res.headers.get('X-3DTiles-Tiles') ?? 0),
    features: Number(res.headers.get('X-3DTiles-Features') ?? 0),
  };
}

export async function convertIfcToCityJson(file: File, crs?: string): Promise<CityJsonFile> {
  const body = new FormData();
  body.append('file', file);
  if (crs) body.append('crs', crs);
  const res = await fetch(`${BASE}/api/ifc/cityjson`, { method: 'POST', body });
  if (!res.ok) throw new Error(await readError(res));
  const bytes = await res.arrayBuffer();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^"]+)"?/i.exec(disposition);
  return {
    bytes,
    filename: match?.[1] ?? `${stemOf(file.name)}.city.json`,
    objects: Number(res.headers.get('X-CityJSON-Objects') ?? 0),
    vertices: Number(res.headers.get('X-CityJSON-Vertices') ?? 0),
  };
}

function stemOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.detail ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
