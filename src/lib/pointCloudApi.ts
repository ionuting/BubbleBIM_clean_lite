/**
 * pointCloudApi.ts — uploading a scan and waiting for its tiles.
 *
 * The conversion happens in Python, on the backend, because nothing in a
 * browser reads a `.laz` or an `.e57`: one is a compressed binary with no
 * trustworthy JavaScript reader, the other needs a C++ library. What comes
 * back is an ordinary 3D Tiles URL that Cesium loads like any other.
 *
 * Progress is a poll rather than a socket. The conversion reports in steps —
 * "read 5,000,000 points", "octree: 1932 nodes" — and a poll every second is
 * both enough to show them and simple enough to have no failure mode of its
 * own beyond the request already being made.
 */

const RAW = import.meta.env.VITE_API_URL as string | undefined;
/** `VITE_API_URL` already ends in `/api` where it is set; the routes below add it. */
const BASE = (RAW ? RAW.replace(/\/api\/?$/, '') : 'http://localhost:8000').replace(/\/$/, '');

/** What the backend accepts, and what the file picker should offer. */
export const POINT_CLOUD_EXTENSIONS = ['.las', '.laz', '.e57', '.ply', '.pts', '.xyz', '.txt', '.asc'] as const;
export const POINT_CLOUD_ACCEPT = POINT_CLOUD_EXTENSIONS.join(',');

export type JobState = 'queued' | 'converting' | 'ready' | 'failed';

export interface PointCloudResult {
  tiles: number;
  points: number;
  depth: number;
  rootSpacingM: number;
  sourcePoints: number;
  keptPoints: number;
  stride: number;
  colour: string;
  crs: string | null;
  seconds: number;
}

export interface PointCloudJob {
  id: string;
  name: string;
  bytes: number;
  state: JobState;
  steps?: string[];
  error?: string;
  result?: PointCloudResult;
  tilesetUrl?: string;
}

export function isPointCloudFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && (POINT_CLOUD_EXTENSIONS as readonly string[]).includes(name.slice(dot).toLowerCase());
}

/** The absolute URL Cesium should be given for a finished job. */
export function tilesetUrlOf(job: PointCloudJob): string | null {
  return job.tilesetUrl ? `${BASE}${job.tilesetUrl}` : null;
}

export async function uploadPointCloud(file: File): Promise<PointCloudJob> {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch(`${BASE}/api/pointcloud/upload`, { method: 'POST', body });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export async function pointCloudStatus(id: string): Promise<PointCloudJob> {
  const res = await fetch(`${BASE}/api/pointcloud/${id}/status`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export async function deletePointCloud(id: string): Promise<void> {
  await fetch(`${BASE}/api/pointcloud/${id}`, { method: 'DELETE' }).catch(() => undefined);
}

/**
 * Upload, then poll until the conversion finishes.
 *
 * `onUpdate` fires on every poll so the caller can show the converter's own
 * steps. The timeout is generous because the work is real: a hundred million
 * points is minutes, not seconds.
 */
export async function convertPointCloud(
  file: File,
  onUpdate?: (job: PointCloudJob) => void,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<PointCloudJob> {
  const timeout = opts.timeoutMs ?? 15 * 60_000;
  const interval = opts.intervalMs ?? 1000;

  let job = await uploadPointCloud(file);
  onUpdate?.(job);

  const deadline = Date.now() + timeout;
  while (job.state !== 'ready' && job.state !== 'failed') {
    if (Date.now() > deadline) {
      throw new Error('Conversia a depășit timpul alocat.');
    }
    await new Promise((r) => setTimeout(r, interval));
    job = await pointCloudStatus(job.id);
    onUpdate?.(job);
  }
  if (job.state === 'failed') throw new Error(job.error ?? 'Conversia a eșuat.');
  return job;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.detail ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Bytes as something a person reads, for the job list. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
