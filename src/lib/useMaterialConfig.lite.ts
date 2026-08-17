/**
 * useMaterialConfig.lite — Clean Lite material config (no FastAPI).
 * Seeds English builtin catalogue into localStorage.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  BUILTIN_MATERIAL_CONFIG,
  type MaterialConfig,
  type MaterialVisuals,
} from './materialConfig';

const STORAGE_KEY = 'bubblebim_lite_material_config';

let _cache: MaterialConfig | null = null;
const _listeners = new Set<() => void>();

function notifyListeners() {
  _listeners.forEach((fn) => fn());
}

function loadFromStorage(): MaterialConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MaterialConfig;
      if (parsed?.materials && parsed?.element_defaults) return parsed;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return structuredClone(BUILTIN_MATERIAL_CONFIG);
}

function persist(config: MaterialConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* quota / private mode */
  }
}

function ensureCache(): MaterialConfig {
  if (!_cache) {
    _cache = loadFromStorage();
  }
  return _cache;
}

export function preloadMaterialConfig(): void {
  ensureCache();
}

export function getMaterialConfigSync(): MaterialConfig | null {
  return _cache ?? ensureCache();
}

export interface UseMaterialConfigResult {
  config: MaterialConfig | null;
  loading: boolean;
  isSaving: boolean;
  saveError: string | null;
  save: (updated: MaterialConfig) => Promise<void>;
  refresh: () => Promise<void>;
  updateElementDefault: (type: string, patch: Partial<MaterialVisuals>) => void;
}

export function useMaterialConfig(): UseMaterialConfigResult {
  const [config, setConfig] = useState<MaterialConfig | null>(() => ensureCache());
  const [loading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const update = () => setConfig(_cache);
    _listeners.add(update);
    ensureCache();
    setConfig(_cache);
    return () => { _listeners.delete(update); };
  }, []);

  const save = useCallback(async (updated: MaterialConfig) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      _cache = updated;
      persist(updated);
      setConfig(updated);
      notifyListeners();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsSaving(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    _cache = loadFromStorage();
    setConfig(_cache);
  }, []);

  const _debRef = useState<ReturnType<typeof setTimeout> | null>(null);

  const updateElementDefault = useCallback((type: string, patch: Partial<MaterialVisuals>) => {
    const current = ensureCache();
    const existing = (current.element_defaults?.[type] ?? {}) as MaterialVisuals;
    const updated: MaterialConfig = {
      ...current,
      element_defaults: {
        ...(current.element_defaults ?? {}),
        [type]: { ...existing, ...patch },
      },
    };
    _cache = updated;
    setConfig({ ...updated });
    notifyListeners();
    if (_debRef[0]) clearTimeout(_debRef[0]);
    _debRef[1](setTimeout(() => { void save(updated); }, 1200));
  }, [save, _debRef]);

  return { config, loading, isSaving, saveError, save, refresh, updateElementDefault };
}
