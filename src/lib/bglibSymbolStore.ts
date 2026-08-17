/**
 * bglibSymbolStore.ts
 *
 * Client-side registry for .bglib.json parametric symbols.
 *
 * Symbols are fetched from the FastAPI backend:
 *   GET /api/library/bglib/symbols?element_type=window
 *   GET /api/library/bglib/symbol/{file}
 *
 * The store maps (elementType + name) → BglibSymbol.
 * Components can subscribe to changes and resolve symbols by type key.
 */

import type { BglibSymbol } from './dxfSymbolRenderer';

const API_BASE = 'http://localhost:8000';

// ─── Internal state ────────────────────────────────────────────────────────

/** Full symbol data cache: symbolKey → BglibSymbol */
const _cache = new Map<string, BglibSymbol>();

/** Metadata list cache: elementType → list of metadata entries */
const _metaCache = new Map<string, BglibMeta[]>();

/** Assignment registry: (elementType:typeKey) → symbol name */
const _assignments = new Map<string, string>();

/** Pub/sub listeners */
const _listeners = new Set<() => void>();

const ASSIGNMENTS_STORAGE_KEY = 'bg_bglib_assignments_v1';

// ─── Types ────────────────────────────────────────────────────────────────

export interface BglibMeta {
  name: string;
  file: string;
  elementType: string;
  defaultWidth: number;
  defaultHeight: number;
  sliderCount: number;
}

// ─── Persistence ────────────────────────────────────────────────────────────

function _loadAssignments(): void {
  try {
    const raw = localStorage.getItem(ASSIGNMENTS_STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) {
        _assignments.set(k, v);
      }
    }
  } catch {
    /* ignore */
  }
}

function _saveAssignments(): void {
  try {
    const obj: Record<string, string> = {};
    _assignments.forEach((v, k) => { obj[k] = v; });
    localStorage.setItem(ASSIGNMENTS_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

_loadAssignments();

// ─── Pub/sub ────────────────────────────────────────────────────────────────

function _notify(): void {
  _listeners.forEach((fn) => fn());
}

export function subscribeBglibStore(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ─── Symbol key helpers ────────────────────────────────────────────────────

/** Unique cache key for a loaded symbol */
function _symKey(elementType: string, name: string): string {
  return `${elementType}:${name}`;
}

/** Assignment key: maps a specific element type+typeKey to a symbol name */
export function assignmentKey(elementType: string, typeKey: string): string {
  return `${elementType}:${typeKey}`;
}

// ─── API fetches ─────────────────────────────────────────────────────────────

/** Fetch the metadata list for an element type from the backend. Cached in memory. */
export async function fetchBglibMeta(elementType: string): Promise<BglibMeta[]> {
  if (_metaCache.has(elementType)) return _metaCache.get(elementType)!;
  try {
    const resp = await fetch(`${API_BASE}/api/library/bglib/symbols?element_type=${encodeURIComponent(elementType)}`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { symbols: BglibMeta[] };
    _metaCache.set(elementType, data.symbols ?? []);
    return _metaCache.get(elementType)!;
  } catch {
    return [];
  }
}

/** Fetch and cache a full BglibSymbol by file path. */
export async function fetchBglibSymbol(filePath: string, elementType: string): Promise<BglibSymbol | null> {
  // Try to determine name from filePath
  const name = filePath.replace(/\.bglib\.json$/, '').split('/').pop() ?? filePath;
  const key = _symKey(elementType, name);
  if (_cache.has(key)) return _cache.get(key)!;

  try {
    const resp = await fetch(`${API_BASE}/api/library/bglib/symbol/${encodeURIComponent(filePath)}`);
    if (!resp.ok) return null;
    const sym = (await resp.json()) as BglibSymbol;
    _cache.set(key, sym);
    return sym;
  } catch {
    return null;
  }
}

/** Invalidate the metadata list cache (call after uploading a new symbol). */
export function invalidateBglibMeta(elementType?: string): void {
  if (elementType) {
    _metaCache.delete(elementType);
  } else {
    _metaCache.clear();
  }
  _notify();
}

// ─── Assignment management ────────────────────────────────────────────────

/**
 * Assign a bglib symbol (by name) to a specific element typeKey.
 * E.g. assignBglibSymbol('window', 'W1000-DOUBLE', 'Window_Double_100_TOV')
 */
export function assignBglibSymbol(elementType: string, typeKey: string, symbolName: string): void {
  _assignments.set(assignmentKey(elementType, typeKey), symbolName);
  _saveAssignments();
  _notify();
}

/** Remove the bglib symbol assignment for a typeKey. */
export function unassignBglibSymbol(elementType: string, typeKey: string): void {
  _assignments.delete(assignmentKey(elementType, typeKey));
  _saveAssignments();
  _notify();
}

/** Get the assigned symbol name for a typeKey, or null. */
export function getAssignedSymbolName(elementType: string, typeKey: string): string | null {
  return _assignments.get(assignmentKey(elementType, typeKey)) ?? null;
}

/** List all assignments as [{elementType, typeKey, symbolName}] */
export function listAssignments(): Array<{ elementType: string; typeKey: string; symbolName: string }> {
  return Array.from(_assignments.entries()).map(([k, v]) => {
    const [et, ...rest] = k.split(':');
    return { elementType: et, typeKey: rest.join(':'), symbolName: v };
  });
}

// ─── Resolution (sync, for render use) ────────────────────────────────────

/**
 * Synchronously resolve a bglib symbol for a given element typeKey.
 * Returns the cached BglibSymbol if available, otherwise null.
 * Kicks off an async fetch in the background if not cached.
 *
 * @param elementType  'window' | 'door' | …
 * @param typeKey      The element's type identifier (e.g. 'W1000-DOUBLE')
 */
export function resolveBglibSymbol(elementType: string, typeKey: string): BglibSymbol | null {
  const symbolName = _assignments.get(assignmentKey(elementType, typeKey));
  if (!symbolName) return null;

  const key = _symKey(elementType, symbolName);
  if (_cache.has(key)) return _cache.get(key)!;

  // Kick off background fetch
  _loadSymbolAsync(elementType, symbolName);
  return null;
}

async function _loadSymbolAsync(elementType: string, symbolName: string): Promise<void> {
  // Find the file path from meta cache
  const meta = _metaCache.get(elementType);
  const entry = meta?.find((m) => m.name === symbolName);
  if (!entry) {
    // Fetch meta first
    const metas = await fetchBglibMeta(elementType);
    const found = metas.find((m) => m.name === symbolName);
    if (!found) return;
    await fetchBglibSymbol(found.file, elementType);
  } else {
    await fetchBglibSymbol(entry.file, elementType);
  }
  _notify();
}

/**
 * Pre-warm the cache for all assigned symbols of an element type.
 * Call once on component mount, await if you need symbols ready on first render.
 */
export async function prewarmBglibSymbols(elementType: string): Promise<void> {
  const metas = await fetchBglibMeta(elementType);
  const assigned = new Set(
    Array.from(_assignments.entries())
      .filter(([k]) => k.startsWith(`${elementType}:`))
      .map(([, v]) => v),
  );
  await Promise.all(
    metas.filter((m) => assigned.has(m.name)).map((m) => fetchBglibSymbol(m.file, elementType)),
  );
  _notify();
}

// ─── Auto-symbol (symbols2d/ folder — name-based mapping) ────────────────────

/**
 * Auto-symbol cache: `auto:{elementType}:{typeId}` → BglibSymbol | 'loading' | 'not-found'
 * These symbols come from `library/{elementType}s/symbols2d/{typeId}.dxf`
 * and are auto-parsed by the backend on first request.
 */
const _autoCache = new Map<string, BglibSymbol | 'loading' | 'not-found'>();

/**
 * Set of element types for which the available-symbols list has been fetched.
 * Until an element type is in this set, resolveAutoSymbol() will not trigger
 * individual backend fetches (avoids 404 noise for type IDs without DXF files).
 */
const _listReady = new Set<string>();

/**
 * Clear the auto-symbol cache and list-ready flag for an element type.
 * Call after DXF files have been modified so initAutoSymbolList re-fetches.
 */
export function invalidateAutoSymbolCache(elementType?: string): void {
  if (elementType) {
    _listReady.delete(elementType);
    const prefix = `auto:${elementType}:`;
    for (const key of [..._autoCache.keys()]) {
      if (key.startsWith(prefix)) _autoCache.delete(key);
    }
  } else {
    _listReady.clear();
    _autoCache.clear();
  }
  _notify();
}

/**
 * Fetch the auto-symbol for a type ID from the backend.
 * The backend looks for `library/windows/symbols2d/{typeId}.dxf`, auto-parses it,
 * caches the .bglib.json, and returns the parsed symbol data.
 */
export async function fetchAutoSymbol(elementType: string, typeId: string): Promise<BglibSymbol | null> {
  try {
    const resp = await fetch(
      `${API_BASE}/api/library/bglib/auto-symbol/${encodeURIComponent(elementType)}/${encodeURIComponent(typeId)}`,
    );
    if (!resp.ok) return null;
    return (await resp.json()) as BglibSymbol;
  } catch {
    return null;
  }
}

/**
 * Synchronously resolve the auto-symbol for a typeId.
 * Triggers a background fetch if not yet loaded. Returns null on first call
 * then triggers a _notify() re-render once loaded.
 *
 * Priority chain in FloorPlan2DViewer:
 *   1. resolveBglibSymbol (manually assigned)
 *   2. resolveAutoSymbol  (symbols2d/{typeId}.dxf ← this function)
 *   3. SymbolCanvas custom symbol
 *   4. hardcoded 3-line symbol
 */
export function resolveAutoSymbol(elementType: string, typeId: string): BglibSymbol | null {
  if (!typeId) return null;
  const key = `auto:${elementType}:${typeId}`;
  const cached = _autoCache.get(key);
  if (cached === 'not-found') return null;
  if (cached === 'loading') return null;
  if (cached != null) return cached;

  if (!_listReady.has(elementType)) {
    // Available-symbols list not yet fetched — park as loading.
    // initAutoSymbolList() will resolve all parked entries once the list arrives.
    _autoCache.set(key, 'loading');
    return null;
  }

  // List is known but this typeId is not in it → not available.
  _autoCache.set(key, 'not-found');
  return null;
}

/**
 * Initialise the auto-symbol system for an element type:
 *  1. Fetch the list of available DXF files from symbols2d/.
 *  2. Mark all parked ('loading') type IDs that are NOT available as 'not-found'.
 *  3. Fetch the actual symbols for available type IDs.
 *  4. Notify subscribers.
 *
 * Safe to call multiple times — idempotent once the list is ready.
 * Call once at component mount instead of listAutoSymbols + prewarmAutoSymbols.
 */
export async function initAutoSymbolList(elementType: string): Promise<void> {
  if (_listReady.has(elementType)) return;

  const list = await listAutoSymbols(elementType);
  const available = new Set(list.map((s) => s.typeId));

  // Resolve all entries that were parked as 'loading' before the list arrived.
  const prefix = `auto:${elementType}:`;
  for (const [key, val] of _autoCache.entries()) {
    if (val !== 'loading') continue;
    if (!key.startsWith(prefix)) continue;
    const tid = key.slice(prefix.length);
    if (!available.has(tid)) _autoCache.set(key, 'not-found');
    // Available ones remain 'loading' and will be overwritten below by fetch.
  }

  _listReady.add(elementType);

  // Fetch all available symbols.
  await Promise.all(
    list.map(async ({ typeId }) => {
      const key = `auto:${elementType}:${typeId}`;
      if (_autoCache.get(key) === 'not-found') return; // shouldn't happen, but guard
      const sym = await fetchAutoSymbol(elementType, typeId);
      _autoCache.set(key, sym ?? 'not-found');
    }),
  );

  _notify();
}

/** List all available auto-symbols for an element type (metadata only, no full data). */
export async function listAutoSymbols(elementType: string): Promise<Array<{ typeId: string; hasBglib: boolean; dxfFile: string }>> {
  try {
    const resp = await fetch(
      `${API_BASE}/api/library/bglib/auto-symbols?element_type=${encodeURIComponent(elementType)}`,
    );
    if (!resp.ok) return [];
    const data = await resp.json() as { symbols: Array<{ typeId: string; hasBglib: boolean; dxfFile: string }> };
    return data.symbols ?? [];
  } catch {
    return [];
  }
}

/**
 * Pre-warm auto-symbols for all types in a list.
 * Call on configurator mount with the list of known typeIds.
 */
export async function prewarmAutoSymbols(elementType: string, typeIds: string[]): Promise<void> {
  await Promise.all(
    typeIds.map(async (tid) => {
      const key = `auto:${elementType}:${tid}`;
      if (_autoCache.has(key)) return;
      const sym = await fetchAutoSymbol(elementType, tid);
      _autoCache.set(key, sym ?? 'not-found');
    }),
  );
  _notify();
}

/**
 * Pre-mark a list of typeIds as 'not-found' without fetching.
 * Call after listAutoSymbols() to suppress 404 console noise for type IDs
 * that have no matching DXF in symbols2d/.
 * Only marks IDs that haven't been cached yet (won't overwrite loaded symbols).
 */
export function markAutoSymbolsNotFound(elementType: string, typeIds: string[]): void {
  for (const tid of typeIds) {
    const key = `auto:${elementType}:${tid}`;
    if (!_autoCache.has(key)) {
      _autoCache.set(key, 'not-found');
    }
  }
}
