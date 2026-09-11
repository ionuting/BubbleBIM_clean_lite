import { describe, expect, it } from 'vitest';
import { getCompiledUnitPrices } from '@/lib/norms/catalogCompiled';
import { resolvePrices } from './resolvedPrices';

const anyId = () => Object.keys(getCompiledUnitPrices())[0];

describe('resolvePrices', () => {
  it('a project with no prices of its own still gets the catalogue — never zero', () => {
    const r = resolvePrices({});
    const cat = getCompiledUnitPrices();
    expect(Object.keys(r).length).toBe(Object.keys(cat).length);
    for (const [id, p] of Object.entries(cat)) expect(r[id]).toBe(p);
    expect(Object.values(r).every((p) => p > 0)).toBe(true);
  });

  it("the project's own price wins over the catalogue's", () => {
    const id = anyId();
    expect(resolvePrices({ [id]: 12345 })[id]).toBe(12345);
  });

  it('an override of 0 does not blank the catalogue price — clearing is resetPrice', () => {
    const id = anyId();
    expect(resolvePrices({ [id]: 0 })[id]).toBe(getCompiledUnitPrices()[id]);
  });

  it('keeps a price for an article the catalogue does not carry', () => {
    expect(resolvePrices({ CUSTOM_X: 40 }).CUSTOM_X).toBe(40);
  });

  it('returns the same object for the same overrides — an effect dependency must be stable', () => {
    const o = { [anyId()]: 9 };
    expect(resolvePrices(o)).toBe(resolvePrices(o));
    expect(resolvePrices({ ...o })).not.toBe(resolvePrices(o));
  });
});
