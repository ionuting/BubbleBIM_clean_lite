/**
 * useMaterialConfig — React hook that fetches and caches the material config
 * from the backend, provides a mutate function, and stores it in module-level
 * cache so all viewers share one copy.
 */
import { useState, useEffect, useCallback } from 'react';
import { BUILTIN_MATERIAL_CONFIG, type MaterialConfig } from './materialConfig';

const BACKEND_URL = (import.meta.env.VITE_API_URL as string || 'http://localhost:8000/api').replace(/\/api$/, '');
const ENDPOINT = `${BACKEND_URL}/api/material-config`;

// Module-level cache so re-mounting viewers doesn't re-fetch
let _cache: MaterialConfig | null = null;
let _promise: Promise<MaterialConfig | null> | null = null;
const _listeners = new Set<() => void>();

function notifyListeners() {
  _listeners.forEach((fn) => fn());
}

async function fetchConfig(): Promise<MaterialConfig | null> {
  if (_cache) return _cache;
  if (_promise) return _promise;
  _promise = fetch(ENDPOINT)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<MaterialConfig>;
    })
    .then((data) => {
      // The YAML on a long-lived server predates newer element types and
      // materials (it is user-writable and excluded from deploys), so fold the
      // built-ins in underneath. Anything the file defines still wins.
      _cache = {
        ...data,
        element_defaults: { ...BUILTIN_MATERIAL_CONFIG.element_defaults, ...data.element_defaults },
        materials: { ...BUILTIN_MATERIAL_CONFIG.materials, ...data.materials },
        window_glazing: data.window_glazing ?? BUILTIN_MATERIAL_CONFIG.window_glazing,
      };
      _promise = null;
      notifyListeners();
      return _cache;
    })
    .catch((err) => {
      console.warn('[useMaterialConfig] Could not load material config from backend:', err);
      _promise = null;
      // Offline fallback — English builtin catalogue
      _cache = structuredClone(BUILTIN_MATERIAL_CONFIG);
      notifyListeners();
      return _cache;
    });
  return _promise;
}

/** Call once at app start to pre-warm the cache. */
export function preloadMaterialConfig(): void {
  fetchConfig();
}

/** Returns the cached config synchronously (null if not yet loaded). */
export function getMaterialConfigSync(): MaterialConfig | null {
  return _cache;
}

export interface UseMaterialConfigResult {
  config: MaterialConfig | null;
  loading: boolean;
  isSaving: boolean;
  saveError: string | null;
  /** Save the full config to the backend, then refresh the cache. */
  save: (updated: MaterialConfig) => Promise<void>;
  /** Force a refresh from the backend. */
  refresh: () => Promise<void>;
  /** Patch a single element_defaults entry and auto-save. */
  updateElementDefault: (type: string, patch: Partial<import('./materialConfig').MaterialVisuals>) => void;
}

export function useMaterialConfig(): UseMaterialConfigResult {
  const [config, setConfig] = useState<MaterialConfig | null>(_cache);
  const [loading, setLoading]     = useState(!_cache);
  const [isSaving, setIsSaving]   = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const update = () => { if (live) setConfig(_cache); };
    _listeners.add(update);

    if (!_cache) {
      setLoading(true);
      fetchConfig().then((c) => {
        if (live) { setConfig(c); setLoading(false); }
      });
    } else {
      setConfig(_cache);
      setLoading(false);
    }

    return () => { _listeners.delete(update); live = false; };
  }, []);

  const save = useCallback(async (updated: MaterialConfig) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      _cache = updated;
      setConfig(updated);
      notifyListeners();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsSaving(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    _cache = null;
    _promise = null;
    setLoading(true);
    const c = await fetchConfig();
    setConfig(c);
    setLoading(false);
  }, []);

  // Debounce timer for auto-save on element default changes
  const _debRef = useState<ReturnType<typeof setTimeout> | null>(null);

  const updateElementDefault = useCallback((type: string, patch: Partial<import('./materialConfig').MaterialVisuals>) => {
    const current = _cache;
    if (!current) return;
    const existing = (current.element_defaults?.[type] ?? {}) as import('./materialConfig').MaterialVisuals;
    const updated: MaterialConfig = {
      ...current,
      element_defaults: {
        ...(current.element_defaults ?? {}),
        [type]: { ...existing, ...patch },
      },
    };
    // Optimistic update
    _cache = updated;
    setConfig({ ...updated });
    notifyListeners();
    // Debounced persist
    if (_debRef[0]) clearTimeout(_debRef[0]);
    _debRef[1](setTimeout(() => save(updated), 1200));
  }, [save, _debRef]);

  return { config, loading, isSaving, saveError, save, refresh, updateElementDefault };
}
