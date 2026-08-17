/**
 * useDoorSymbolConfig.ts — React hook for the door symbol registry.
 *
 * Mirrors useWindowSymbolConfig. Subscribes to the global DoorPlan2DConfig
 * registry and re-renders on change. Persists to localStorage automatically.
 */

import { useEffect, useReducer, useCallback } from 'react';
import {
  resolveDoorPlan2DConfig,
  setDoorPlan2DConfig,
  resetDoorPlan2DConfig,
  exportDoorRegistry,
  importDoorRegistry,
  subscribeDoorSymbolConfig,
  type DoorPlan2DConfig,
} from '@/lib/doorSymbolLibrary';

const STORAGE_KEY = 'bg_door_symbol_registry_v1';

function loadFromStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) importDoorRegistry(JSON.parse(raw));
  } catch { /* ignore corrupt */ }
}

function saveToStorage(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(exportDoorRegistry()));
  } catch { /* ignore quota */ }
}

loadFromStorage();

export interface UseDoorSymbolConfigReturn {
  resolve: (typeId: string, swing: string) => DoorPlan2DConfig;
  set: (key: string, overrides: Partial<DoorPlan2DConfig>) => void;
  reset: (key: string) => void;
}

export function useDoorSymbolConfig(): UseDoorSymbolConfigReturn {
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const unsub = subscribeDoorSymbolConfig(rerender);
    return unsub;
  }, []);

  const set = useCallback((key: string, overrides: Partial<DoorPlan2DConfig>) => {
    setDoorPlan2DConfig(key, overrides);
    saveToStorage();
  }, []);

  const reset = useCallback((key: string) => {
    resetDoorPlan2DConfig(key);
    saveToStorage();
  }, []);

  return { resolve: resolveDoorPlan2DConfig, set, reset };
}
