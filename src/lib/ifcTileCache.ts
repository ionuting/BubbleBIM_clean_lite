/**
 * ifcTileCache.ts — IndexedDB persistence for IFC → GLB tile cache.
 *
 * Schema (DB: 'ifctiles_v2'):
 *   'glb'       { key: `${hash}::${tileId}` → gzip-compressed ArrayBuffer }
 *   'manifests' { key: hash                  → RootManifest JSON }
 *   'metadata'  { key: hash                  → ElementMetaMap JSON }
 *   'projects'  { key: hash                  → { name, date, tileCount } }
 *
 * GLB tiles are stored gzip-compressed (browser CompressionStream API).
 * Callers receive decompressed GLB bytes — compression is transparent.
 *
 * All operations are Promise-based and safe to call concurrently.
 */

import type { RootManifest, ElementMetaMap } from './tileManifest';

const DB_NAME    = 'ifctiles_v2'; // v2: gzip-compressed GLB tiles
const DB_VERSION = 1;

// ─── Open / upgrade DB ────────────────────────────────────────────────────────

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('glb'))       db.createObjectStore('glb');
      if (!db.objectStoreNames.contains('manifests')) db.createObjectStore('manifests');
      if (!db.objectStoreNames.contains('metadata'))  db.createObjectStore('metadata');
      if (!db.objectStoreNames.contains('projects'))  db.createObjectStore('projects');
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

function idbPut(store: string, key: string, value: unknown): Promise<void> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  }));
}

function idbGet<T>(store: string, key: string): Promise<T | null> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror   = () => reject(req.error);
  }));
}

function idbDelete(store: string, key: string): Promise<void> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  }));
}

function idbGetAllKeys(store: string): Promise<string[]> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror   = () => reject(req.error);
  }));
}

// ─── Gzip compress / decompress (browser CompressionStream — no external dep) ─

async function gzipCompress(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  writer.write(buf);
  writer.close();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer;
}

async function gzipDecompress(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(buf);
  writer.close();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer;
}

// ─── SHA-256 helper (Web Crypto — no external dep) ───────────────────────────

export async function hashBuffer(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16); // use first 16 hex chars as project key
}

// ─── GLB tiles ────────────────────────────────────────────────────────────────

export async function cacheTileGLB(hash: string, tileId: string, glb: ArrayBuffer): Promise<void> {
  const compressed = await gzipCompress(glb);
  await idbPut('glb', `${hash}::${tileId}`, compressed);
}

export async function loadTileGLB(hash: string, tileId: string): Promise<ArrayBuffer | null> {
  const compressed = await idbGet<ArrayBuffer>('glb', `${hash}::${tileId}`);
  if (!compressed) return null;
  return gzipDecompress(compressed);
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

export async function cacheManifest(hash: string, manifest: RootManifest): Promise<void> {
  await idbPut('manifests', hash, JSON.stringify(manifest));
}

export async function loadManifest(hash: string): Promise<RootManifest | null> {
  const raw = await idbGet<string>('manifests', hash);
  return raw ? (JSON.parse(raw) as RootManifest) : null;
}

// ─── Element metadata ─────────────────────────────────────────────────────────

export async function cacheMetadata(hash: string, meta: ElementMetaMap): Promise<void> {
  await idbPut('metadata', hash, JSON.stringify(meta));
}

export async function loadMetadata(hash: string): Promise<ElementMetaMap | null> {
  const raw = await idbGet<string>('metadata', hash);
  return raw ? (JSON.parse(raw) as ElementMetaMap) : null;
}

// ─── Project registry ─────────────────────────────────────────────────────────

export interface CachedProjectInfo {
  hash: string;
  name: string;
  date: string;      // ISO
  tileCount: number;
  sizeEstimateKB: number;
}

export async function registerProject(
  hash: string, name: string, tileCount: number, sizeEstimateKB: number,
): Promise<void> {
  await idbPut('projects', hash, JSON.stringify({
    hash, name, tileCount, sizeEstimateKB,
    date: new Date().toISOString(),
  }));
}

export async function listCachedProjects(): Promise<CachedProjectInfo[]> {
  const keys = await idbGetAllKeys('projects');
  const results: CachedProjectInfo[] = [];
  for (const key of keys) {
    const raw = await idbGet<string>('projects', key);
    if (raw) results.push(JSON.parse(raw) as CachedProjectInfo);
  }
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

export async function projectExists(hash: string): Promise<boolean> {
  return (await idbGet<string>('manifests', hash)) !== null;
}

export async function deleteProject(hash: string): Promise<void> {
  // Remove manifest, metadata, project entry
  await Promise.all([
    idbDelete('manifests', hash),
    idbDelete('metadata', hash),
    idbDelete('projects', hash),
  ]);
  // Remove all GLB tiles for this project
  const keys = await idbGetAllKeys('glb');
  const prefix = `${hash}::`;
  await Promise.all(
    keys.filter(k => k.startsWith(prefix)).map(k => idbDelete('glb', k))
  );
}

export async function estimateProjectSizeKB(hash: string, manifest: RootManifest): Promise<number> {
  let total = 0;
  for (const tile of manifest.tiles) {
    const glb = await loadTileGLB(hash, tile.id);
    if (glb) total += glb.byteLength;
  }
  return Math.round(total / 1024);
}
