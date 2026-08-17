/**
 * useLibraryTypes — React hook that loads BIM element type catalogues.
 *
 * Priority: backend YAML library (GET /api/library/{family}) → built-in elementLibrary.ts
 * New entries in the YAML that don't exist in the built-in list are appended to the result.
 * The built-in entries are always present as fallback even when the backend is unreachable.
 */

import { useState, useEffect } from 'react';
import { WINDOW_TYPES, DOOR_TYPES } from './elementLibrary';
import type { WindowType, DoorType } from './elementLibrary';

type LibraryFamily = 'window' | 'door';
type LibraryEntry  = WindowType | DoorType;

const BACKEND = (import.meta.env.VITE_API_URL as string || 'http://localhost:8000/api').replace(/\/api$/, '');

// Simple in-memory cache so multiple dropdown instances don't each trigger a fetch
const _cache = new Map<LibraryFamily, LibraryEntry[]>();

export function useLibraryTypes(family: LibraryFamily): LibraryEntry[] {
  const builtIn: LibraryEntry[] = family === 'window' ? WINDOW_TYPES : DOOR_TYPES;

  const [types, setTypes] = useState<LibraryEntry[]>(() => _cache.get(family) ?? builtIn);

  useEffect(() => {
    if (_cache.has(family)) {
      setTypes(_cache.get(family)!);
      return;
    }

    const ctrl = new AbortController();
    fetch(`${BACKEND}/api/library/${family}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.entries?.length) return;
        const builtInIds = new Set(builtIn.map((t) => t.id));
        // Merge: built-in first, then YAML-only extras
        const extras = (data.entries as LibraryEntry[]).filter((e) => !builtInIds.has(e.id));
        const merged = [...builtIn, ...extras];
        _cache.set(family, merged);
        setTypes(merged);
      })
      .catch(() => {/* backend unavailable — stay with built-in */});

    return () => ctrl.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family]);

  return types;
}
