import { describe, expect, it } from 'vitest';
import {
  PRICE_CSV_HEADER, buildPriceCsv, parseNumber, parsePriceCsv, splitCsvLine, type PriceCsvRow,
} from './priceCsv';

const row = (over: Partial<PriceCsvRow> = {}): PriceCsvRow => ({
  normId: 'A1', symbol: 'A 1', denumire: 'Zidărie', unit: 'mc',
  material: 420, manopera: 240, utilaj: 25, transport: 40, total: 725,
  source: 'estimare', date: '2026-09', ...over,
});

describe('buildPriceCsv', () => {
  it('writes the header the library uses, semicolon separated', () => {
    const csv = buildPriceCsv([row()]);
    expect(csv.split('\n')[0]).toBe(PRICE_CSV_HEADER.join(';'));
    expect(csv.split('\n')[1]).toBe('A1;A 1;Zidărie;mc;420;240;25;40;725;estimare;2026-09');
  });

  it('quotes anything that would break the row', () => {
    const csv = buildPriceCsv([row({ denumire: 'Beton C25/30; turnat "cu pompa"' })]);
    expect(csv).toContain('"Beton C25/30; turnat ""cu pompa"""');
  });

  it('leaves empty components empty rather than writing zero', () => {
    const csv = buildPriceCsv([row({ material: null, manopera: null, utilaj: null, transport: null, total: 90 })]);
    expect(csv.split('\n')[1]).toBe('A1;A 1;Zidărie;mc;;;;;90;estimare;2026-09');
  });
});

describe('splitCsvLine and parseNumber', () => {
  it('handles both separators and quoted fields', () => {
    expect(splitCsvLine('a;b;c')).toEqual(['a', 'b', 'c']);
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(splitCsvLine('a;"b;c";d')).toEqual(['a', 'b;c', 'd']);
    expect(splitCsvLine('a;"say ""hi""";c')).toEqual(['a', 'say "hi"', 'c']);
  });

  it('reads numbers written the Romanian way', () => {
    expect(parseNumber('1234.56')).toBe(1234.56);
    expect(parseNumber('1234,56')).toBe(1234.56);
    expect(parseNumber('1.234,56')).toBe(1234.56);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('n/a')).toBeNull();
  });
});

describe('parsePriceCsv', () => {
  const known = new Set(['A1', 'B2', 'C3']);

  it('reads the total when only a total is given', () => {
    const r = parsePriceCsv('normId;total\nA1;800\nB2;12,5', known);
    expect(r.prices).toEqual({ A1: 800, B2: 12.5 });
    expect(r.accepted).toBe(2);
  });

  it('prefers the components over the file\'s own total — a stale formula must not win', () => {
    const r = parsePriceCsv('normId;material;manopera;utilaj;transport;total\nA1;400;200;20;30;999', known);
    expect(r.prices.A1).toBe(650);
  });

  it('falls back to the total when the components are incomplete', () => {
    const r = parsePriceCsv('normId;material;manopera;utilaj;transport;total\nA1;400;;;;725', known);
    expect(r.prices.A1).toBe(725);
  });

  it('collects unknown ids instead of dropping them silently', () => {
    const r = parsePriceCsv('normId;total\nA1;800\nZZ;100', known);
    expect(r.prices).toEqual({ A1: 800 });
    expect(r.unknown).toEqual(['ZZ']);
    expect(r.accepted).toBe(1);
  });

  it('collects rows with no usable number', () => {
    const r = parsePriceCsv('normId;total\nA1;\nB2;abc\nC3;5', known);
    expect(r.invalid.sort()).toEqual(['A1', 'B2']);
    expect(r.prices).toEqual({ C3: 5 });
  });

  it('accepts a headerless two-column list', () => {
    const r = parsePriceCsv('A1;800\nB2;90', known);
    expect(r.prices).toEqual({ A1: 800, B2: 90 });
  });

  it('an empty file imports nothing and reports nothing', () => {
    expect(parsePriceCsv('', known)).toEqual({ prices: {}, unknown: [], invalid: [], accepted: 0 });
  });

  it('round-trips what buildPriceCsv wrote', () => {
    const csv = buildPriceCsv([row(), row({ normId: 'B2', material: null, manopera: null, utilaj: null, transport: null, total: 90 })]);
    const r = parsePriceCsv(csv, known);
    expect(r.prices).toEqual({ A1: 725, B2: 90 });
    expect(r.unknown).toEqual([]);
  });
});
