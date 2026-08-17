import { describe, it, expect, beforeEach } from 'vitest';
import { usePrices, exportPrices, importPrices } from './priceStore';

beforeEach(() => importPrices(undefined));

describe('priceStore', () => {
  it('setPrice + setPrices (bulk pe categorie)', () => {
    usePrices.getState().setPrice('A', 12.5);
    usePrices.getState().setPrices(['B', 'C'], 30);
    expect(usePrices.getState().getPrice('A')).toBe(12.5);
    expect(usePrices.getState().getPrice('B')).toBe(30);
    expect(usePrices.getState().getPrice('C')).toBe(30);
    expect(usePrices.getState().getPrice('X')).toBe(0); // default
  });

  it('preț negativ e limitat la 0', () => {
    usePrices.getState().setPrice('A', -5);
    expect(usePrices.getState().getPrice('A')).toBe(0);
  });

  it('round-trip export → import', () => {
    usePrices.getState().setPrice('A', 99.99);
    const persist = exportPrices();
    importPrices(undefined);
    expect(usePrices.getState().getPrice('A')).toBe(0);
    importPrices(persist);
    expect(usePrices.getState().getPrice('A')).toBe(99.99);
  });
});
