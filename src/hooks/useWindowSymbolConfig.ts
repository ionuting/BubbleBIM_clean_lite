/**
 * useWindowSymbolConfig.ts — React hook for the window symbol registry.
 *
 * Subscribes to the global WindowPlan2DConfig registry and re-renders on change.
 * Persists the registry to localStorage automatically.
 */

import { useEffect, useReducer, useCallback } from 'react';
import {
  resolveWindowPlan2DConfig,
  setWindowPlan2DConfig,
  resetWindowPlan2DConfig,
  exportRegistry,
  importRegistry,
  subscribeWindowSymbolConfig,
  type WindowPlan2DConfig,
} from '@/lib/windowSymbolLibrary';

const STORAGE_KEY = 'bg_window_symbol_registry_v1';

// ── Persistence helpers ────────────────────────────────────────────────────────

function loadFromStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) importRegistry(JSON.parse(raw));
  } catch {
    // ignore corrupt storage
  }
}

function saveToStorage(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(exportRegistry()));
  } catch {
    // ignore quota exceeded
  }
}

// Load once at module init so the configs are ready before first render.
loadFromStorage();

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseWindowSymbolConfigReturn {
  /** Resolve the full config for a window type. */
  resolve: (typeId: string, opening: string) => WindowPlan2DConfig;
  /** Update (merge) overrides for a key. Persists automatically. */
  set: (key: string, overrides: Partial<WindowPlan2DConfig>) => void;
  /** Reset a key to built-in defaults. Persists automatically. */
  reset: (key: string) => void;
}

/**
 * React hook that re-renders when the window symbol registry changes.
 * Call it in any component that needs to read or update window symbol configs.
 */
export function useWindowSymbolConfig(): UseWindowSymbolConfigReturn {
  // useReducer gives us a stable dispatch to trigger re-renders.
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const unsub = subscribeWindowSymbolConfig(rerender);
    return unsub;
  }, []);

  const set = useCallback((key: string, overrides: Partial<WindowPlan2DConfig>) => {
    setWindowPlan2DConfig(key, overrides);
    saveToStorage();
  }, []);

  const reset = useCallback((key: string) => {
    resetWindowPlan2DConfig(key);
    saveToStorage();
  }, []);

  return { resolve: resolveWindowPlan2DConfig, set, reset };
}
