/**
 * usePrices — prețuri unitare configurabile global, per ARTICOL de normă (normId).
 * Prețul se configurează organizat pe categorie de lucrări (vezi PriceConfigPanel),
 * dar se aplică pe articol fiindcă fiecare articol are propria unitate (mp/mc/ml/kg/buc).
 *
 * Preț total al unui articol = cantitate × preț unitar. Persistat în `.bbim`.
 */
import { create } from 'zustand';

/** Moneda implicită. */
export const CURRENCY = 'lei';

interface PriceStore {
  /** normId → preț unitar (în `CURRENCY` pe unitatea articolului). */
  prices: Record<string, number>;
  setPrice: (normId: string, price: number) => void;
  /** Setează același preț pentru mai multe articole (ex. toată o categorie). */
  setPrices: (normIds: string[], price: number) => void;
  /** Aplică un map întreg normId → preț într-o singură actualizare. */
  mergePrices: (map: Record<string, number>) => void;
  clear: () => void;
  getPrice: (normId: string) => number;
}

export const usePrices = create<PriceStore>()((set, get) => ({
  prices: {},
  setPrice: (normId, price) =>
    set((s) => ({ prices: { ...s.prices, [normId]: Math.max(0, price) } })),
  setPrices: (normIds, price) =>
    set((s) => {
      const next = { ...s.prices };
      for (const id of normIds) next[id] = Math.max(0, price);
      return { prices: next };
    }),
  mergePrices: (map) =>
    set((s) => {
      const next = { ...s.prices };
      for (const [id, p] of Object.entries(map)) next[id] = Math.max(0, p);
      return { prices: next };
    }),
  clear: () => set({ prices: {} }),
  getPrice: (normId) => get().prices[normId] ?? 0,
}));

// ─── Persistență (.bbim) ──────────────────────────────────────────────────────

export interface PricePersist {
  prices: Record<string, number>;
}

export function exportPrices(): PricePersist {
  return { prices: usePrices.getState().prices };
}

export function importPrices(data: PricePersist | undefined): void {
  usePrices.setState({ prices: data?.prices ?? {} });
}
