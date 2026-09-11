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

/**
 * De unde vine prețul pe care îl folosește PROIECTUL — distinct de proveniența
 * din librărie, fiindcă exact asta e întrebarea: „cifra asta e a mea sau e
 * estimarea din catalog?". Se salvează cu proiectul, ca prețul.
 */
export interface PriceMeta {
  /** `ofertă Wienerberger`, `deviz 2026`, `import furnizor.csv`, `manual`… */
  source: string;
  /** `AAAA-LL` sau `AAAA-LL-ZZ`. */
  date: string;
}

/** Data de azi ca `AAAA-LL-ZZ`, pentru marcarea automată a ce editează userul. */
export const today = (): string => new Date().toISOString().slice(0, 10);

interface PriceStore {
  /** normId → preț unitar (în `CURRENCY` pe unitatea articolului). */
  prices: Record<string, number>;
  /** normId → proveniența prețului DIN PROIECT. Lipsă = valoarea din catalog. */
  meta: Record<string, PriceMeta>;
  setPrice: (normId: string, price: number, meta?: PriceMeta) => void;
  /** Setează același preț pentru mai multe articole (ex. toată o categorie). */
  setPrices: (normIds: string[], price: number, meta?: PriceMeta) => void;
  /** Aplică un map întreg normId → preț într-o singură actualizare. */
  mergePrices: (map: Record<string, number>, meta?: PriceMeta) => void;
  /** Uită prețul de proiect al unui articol — revine la cel din catalog. */
  resetPrice: (normId: string) => void;
  clear: () => void;
  getPrice: (normId: string) => number;
}

const withMeta = (
  cur: Record<string, PriceMeta>,
  ids: string[],
  meta: PriceMeta | undefined,
): Record<string, PriceMeta> => {
  if (!meta) return cur;
  const next = { ...cur };
  for (const id of ids) next[id] = meta;
  return next;
};

export const usePrices = create<PriceStore>()((set, get) => ({
  prices: {},
  meta: {},
  setPrice: (normId, price, meta) =>
    set((s) => ({
      prices: { ...s.prices, [normId]: Math.max(0, price) },
      meta: withMeta(s.meta, [normId], meta),
    })),
  setPrices: (normIds, price, meta) =>
    set((s) => {
      const next = { ...s.prices };
      for (const id of normIds) next[id] = Math.max(0, price);
      return { prices: next, meta: withMeta(s.meta, normIds, meta) };
    }),
  mergePrices: (map, meta) =>
    set((s) => {
      const next = { ...s.prices };
      for (const [id, p] of Object.entries(map)) next[id] = Math.max(0, p);
      return { prices: next, meta: withMeta(s.meta, Object.keys(map), meta) };
    }),
  resetPrice: (normId) =>
    set((s) => {
      const prices = { ...s.prices }; delete prices[normId];
      const meta = { ...s.meta }; delete meta[normId];
      return { prices, meta };
    }),
  clear: () => set({ prices: {}, meta: {} }),
  getPrice: (normId) => get().prices[normId] ?? 0,
}));

// ─── Persistență (.bbim) ──────────────────────────────────────────────────────

export interface PricePersist {
  prices: Record<string, number>;
  /** Proveniența prețurilor proprii proiectului. Absentă în fișierele vechi. */
  meta?: Record<string, PriceMeta>;
}

export function exportPrices(): PricePersist {
  const s = usePrices.getState();
  return { prices: s.prices, meta: s.meta };
}

export function importPrices(data: PricePersist | undefined): void {
  usePrices.setState({ prices: data?.prices ?? {}, meta: data?.meta ?? {} });
}
