/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useEnergySettings — convențiile calculului energetic, ale UTILIZATORULUI.
 *
 * Ține DOAR abaterile de la implicite, exact ca `usePrices`: un proiect care
 * n-a atins nimic salvează un obiect gol și se calculează ca demo-ul. Ce e în
 * vigoare se obține cu `resolveEnergyConfig`, care pune ce e aici peste
 * `DEFAULT_ENERGY_CONFIG`.
 *
 * De ce nu se salvează și implicitele: dacă s-ar salva, un proiect de azi ar
 * îngheța ψ-urile de azi și n-ar mai vedea niciodată o corecție a lor. Așa,
 * doar ce ai schimbat tu e al tău; restul urmează librăria.
 *
 * Se persistă în `.bbim` lângă prețuri.
 */
import { create } from 'zustand';
import type { StructuralSystem } from '@/lib/systems/structuralSystem';
import type { BridgeKind } from '@/lib/energy/bridges';
import type { ClimateSite, EnergyOverrides, UKey } from '@/lib/energy/config';

interface EnergyStore {
  overrides: EnergyOverrides;
  setPsi: (kind: BridgeKind, value: number | null) => void;
  setU: (key: UKey, value: number | null) => void;
  setCoreLambda: (system: StructuralSystem, value: number | null) => void;
  /** λ pentru un strat din librărie, cheiat `grup:opțiune`. `null` = revine la librărie. */
  setLambda: (key: string, value: number | null) => void;
  /** Adaugă sau modifică o localitate. */
  setSite: (site: ClimateSite) => void;
  /** Uită modificările unei localități — revine la cea implicită, sau o șterge dacă era adăugată. */
  resetSite: (id: string) => void;
  setScalar: (key: 'ach' | 'indoorTempC' | 'rSi' | 'rSe', value: number | null) => void;
  /** Șterge tot ce a schimbat utilizatorul. */
  reset: () => void;
}

/** Scrie o cheie într-un sub-map, sau o șterge când valoarea e `null`. */
function patchMap<K extends string>(
  cur: Partial<Record<K, number>> | undefined,
  key: K,
  value: number | null,
): Partial<Record<K, number>> | undefined {
  const next = { ...(cur ?? {}) } as Partial<Record<K, number>>;
  if (value === null || !Number.isFinite(value)) delete next[key];
  else next[key] = value;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Curăță cheile devenite goale, ca un proiect neatins să salveze `{}`. */
const prune = (o: EnergyOverrides): EnergyOverrides => {
  const out: EnergyOverrides = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
};

export const useEnergySettings = create<EnergyStore>()((set) => ({
  overrides: {},

  setPsi: (kind, value) =>
    set((s) => ({ overrides: prune({ ...s.overrides, psi: patchMap(s.overrides.psi, kind, value) }) })),

  setU: (key, value) =>
    set((s) => ({ overrides: prune({ ...s.overrides, u: patchMap(s.overrides.u, key, value) }) })),

  setCoreLambda: (system, value) =>
    set((s) => ({ overrides: prune({ ...s.overrides, coreLambda: patchMap(s.overrides.coreLambda, system, value) }) })),

  setLambda: (key, value) =>
    set((s) => {
      const next = { ...(s.overrides.lambda ?? {}) };
      if (value === null || !Number.isFinite(value) || value <= 0) delete next[key];
      else next[key] = value;
      return { overrides: prune({ ...s.overrides, lambda: next }) };
    }),

  setSite: (site) =>
    set((s) => {
      const rest = (s.overrides.sites ?? []).filter((x) => x.id !== site.id);
      return { overrides: prune({ ...s.overrides, sites: [...rest, site] }) };
    }),

  resetSite: (id) =>
    set((s) => ({ overrides: prune({ ...s.overrides, sites: (s.overrides.sites ?? []).filter((x) => x.id !== id) }) })),

  setScalar: (key, value) =>
    set((s) => {
      const next = { ...s.overrides };
      if (value === null || !Number.isFinite(value)) delete next[key];
      else next[key] = value;
      return { overrides: prune(next) };
    }),

  reset: () => set({ overrides: {} }),
}));

// ─── Persistență (.bbim) ──────────────────────────────────────────────────────

export type EnergyPersist = EnergyOverrides;

export function exportEnergySettings(): EnergyPersist {
  return useEnergySettings.getState().overrides;
}

export function importEnergySettings(data: EnergyPersist | undefined): void {
  useEnergySettings.setState({ overrides: data && typeof data === 'object' ? data : {} });
}
