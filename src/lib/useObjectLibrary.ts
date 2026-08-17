/**
 * useObjectLibrary — fetch and cache the objects library from the backend.
 *
 * Returns { entries, categories, loading, error }.
 * Entries are the full YAML catalogue (furniture, fixtures, equipment, landscape).
 */

import { useState, useEffect } from 'react';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ObjectLibraryEntry {
  id:           string;
  label:        string;
  category:     string;
  glb:          string;   // path relative to library root, e.g. "objects/furniture/chair_office/model.glb"
  top_svg?:     string;   // path relative to library root, e.g. "objects/furniture/chair_office/top.svg"
  width_mm:     number;
  depth_mm:     number;
  height_mm:    number;
  description?: string;
  tags?:        string[];
}

export interface ObjectLibraryCategory {
  id:    string;
  label: string;
  icon?: string;
}

interface LibraryResponse {
  entries:    ObjectLibraryEntry[];
  categories: ObjectLibraryCategory[];
}

// ─── Module-level cache (shared across component instances) ───────────────────

let _cached: LibraryResponse | null = null;
let _promise: Promise<LibraryResponse> | null = null;

async function fetchObjectLibrary(): Promise<LibraryResponse> {
  if (_cached) return _cached;
  if (_promise) return _promise;

  _promise = fetch(`${API_BASE}/api/library/objects`)
    .then((r) => {
      if (!r.ok) throw new Error(`Library fetch failed: ${r.status}`);
      return r.json();
    })
    .then((data: LibraryResponse) => {
      _cached = data;
      _promise = null;
      return data;
    })
    .catch((err) => {
      _promise = null;
      throw err;
    });

  return _promise;
}

/** Invalidate the cache (e.g. after a GLB upload). */
export function invalidateObjectLibraryCache() {
  _cached = null;
  _promise = null;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useObjectLibrary() {
  const [entries,    setEntries]    = useState<ObjectLibraryEntry[]>([]);
  const [categories, setCategories] = useState<ObjectLibraryCategory[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchObjectLibrary()
      .then((data) => {
        if (cancelled) return;
        setEntries(data.entries ?? []);
        setCategories(data.categories ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load library');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { entries, categories, loading, error };
}

/**
 * Quick lookup: get a single library entry by ID.
 * Returns undefined if not found or library not yet loaded.
 */
export function useObjectLibraryEntry(id: string | undefined): ObjectLibraryEntry | undefined {
  const { entries } = useObjectLibrary();
  if (!id) return undefined;
  return entries.find((e) => e.id === id);
}
