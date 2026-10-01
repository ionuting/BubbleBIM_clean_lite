/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useUserLibrary — stratul UTILIZATORULUI peste librăria livrată.
 *
 * TREI STRATURI, ÎN ORDINEA ASTA
 * -------------------------------
 *   catalog  →  utilizator  →  proiect
 *
 * Catalogul e ce vine cu aplicația. Stratul utilizatorului e ce ai corectat
 * o dată și vrei să te urmeze în FIECARE proiect — prețurile tale de furnizor,
 * λ-ul produsului pe care îl folosești tu, gradele-zile ale orașului tău.
 * Stratul proiectului e ce e adevărat doar aici.
 *
 * Fără stratul din mijloc, orice corecție trebuia refăcută la fiecare proiect
 * nou, ceea ce înseamnă în practică că nu se face.
 *
 * UNDE STĂ, ȘI CE ÎNSEAMNĂ ASTA
 * ------------------------------
 * În `localStorage`, ca celelalte preferințe ale aplicației (`gameStore`,
 * `annotationDrawingSettings`). Deci: **per utilizator ȘI per browser**. Nu se
 * sincronizează între calculatoare și se pierde dacă golești datele site-ului.
 * Pentru sincronizare ar trebui un endpoint de setări pe cont, care nu există;
 * până atunci există exportul în fișier, ca să nu fie singura copie.
 */
import { create } from 'zustand';
import type { PriceMeta } from './priceStore';
import type { EnergyOverrides } from '@/lib/energy/config';

const KEY = 'bubblebim.userLibrary.v1';

export interface UserLibrary {
  /** normId → preț unitar. */
  prices: Record<string, number>;
  /** normId → de unde vine prețul. */
  priceMeta: Record<string, PriceMeta>;
  /** Convențiile energetice pe care le poartă utilizatorul dintr-un proiect în altul. */
  energy: EnergyOverrides;
}

export const EMPTY_USER_LIBRARY: UserLibrary = { prices: {}, priceMeta: {}, energy: {} };

function load(): UserLibrary {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (!raw) return EMPTY_USER_LIBRARY;
    const p = JSON.parse(raw) as Partial<UserLibrary>;
    return {
      prices: p.prices && typeof p.prices === 'object' ? p.prices : {},
      priceMeta: p.priceMeta && typeof p.priceMeta === 'object' ? p.priceMeta : {},
      energy: p.energy && typeof p.energy === 'object' ? p.energy : {},
    };
  } catch {
    // Un localStorage stricat nu are voie să împiedice aplicația să pornească.
    return EMPTY_USER_LIBRARY;
  }
}

function save(lib: UserLibrary): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(lib));
  } catch { /* cotă depășită sau mod privat — nu e motiv de eroare vizibilă */ }
}

interface UserLibraryStore extends UserLibrary {
  setPrice: (normId: string, price: number | null, meta?: PriceMeta) => void;
  mergePrices: (map: Record<string, number>, meta?: PriceMeta) => void;
  setEnergy: (energy: EnergyOverrides) => void;
  /** Ridică tot ce a fost setat pe proiect în stratul utilizatorului. */
  adoptFromProject: (prices: Record<string, number>, meta: Record<string, PriceMeta>, energy: EnergyOverrides) => void;
  clear: () => void;
  replace: (lib: UserLibrary) => void;
}

export const useUserLibrary = create<UserLibraryStore>()((set, get) => {
  const persist = (patch: Partial<UserLibrary>) => {
    const next = { ...get(), ...patch };
    save({ prices: next.prices, priceMeta: next.priceMeta, energy: next.energy });
    return patch;
  };

  return {
    ...load(),

    setPrice: (normId, price, meta) =>
      set((s) => {
        const prices = { ...s.prices };
        const priceMeta = { ...s.priceMeta };
        if (price === null || !(price > 0)) { delete prices[normId]; delete priceMeta[normId]; }
        else { prices[normId] = price; if (meta) priceMeta[normId] = meta; }
        return persist({ prices, priceMeta });
      }),

    mergePrices: (map, meta) =>
      set((s) => {
        const prices = { ...s.prices };
        const priceMeta = { ...s.priceMeta };
        for (const [id, p] of Object.entries(map)) {
          if (!(p > 0)) continue;
          prices[id] = p;
          if (meta) priceMeta[id] = meta;
        }
        return persist({ prices, priceMeta });
      }),

    setEnergy: (energy) => set(() => persist({ energy })),

    adoptFromProject: (prices, meta, energy) =>
      set((s) => persist({
        prices: { ...s.prices, ...prices },
        priceMeta: { ...s.priceMeta, ...meta },
        energy: { ...s.energy, ...energy },
      })),

    clear: () => set(() => persist({ ...EMPTY_USER_LIBRARY })),

    replace: (lib) => set(() => persist({
      prices: lib.prices ?? {}, priceMeta: lib.priceMeta ?? {}, energy: lib.energy ?? {},
    })),
  };
});

/** Ce se scrie într-un fișier de librărie personală — copia de siguranță. */
export function exportUserLibrary(): UserLibrary {
  const s = useUserLibrary.getState();
  return { prices: s.prices, priceMeta: s.priceMeta, energy: s.energy };
}
