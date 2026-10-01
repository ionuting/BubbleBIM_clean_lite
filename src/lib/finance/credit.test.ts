import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CREDIT_TERMS, creditFor, lifecycleFor, monthlyPayment, parseCreditTerms,
} from './credit';

describe('monthlyPayment', () => {
  it('matches the annuity formula on a known case', () => {
    // 100 000 at 6% over 10 years → 1110.21/month (standard annuity).
    expect(monthlyPayment(100_000, 6, 10)).toBeCloseTo(1110.21, 1);
  });

  it('at zero interest the payment is just the principal spread over the months', () => {
    expect(monthlyPayment(120_000, 0, 10)).toBeCloseTo(1000, 6);
  });

  it('a longer term lowers the instalment but raises the total', () => {
    const short = monthlyPayment(100_000, 6, 10);
    const long = monthlyPayment(100_000, 6, 30);
    expect(long).toBeLessThan(short);
    expect(long * 360).toBeGreaterThan(short * 120);
  });

  it('nothing borrowed, nothing owed', () => {
    expect(monthlyPayment(0, 6, 25)).toBe(0);
    expect(monthlyPayment(100_000, 6, 0)).toBe(0);
  });
});

describe('creditFor', () => {
  const terms = { downPaymentRatio: 0.2, years: 20, annualRatePct: 6, energyPriceLeiKwh: 0.9 };

  it('splits the cost into down payment and principal', () => {
    const c = creditFor(500_000, terms);
    expect(c.downPayment).toBe(100_000);
    expect(c.principal).toBe(400_000);
  });

  it('interest is what you pay above the principal', () => {
    const c = creditFor(500_000, terms);
    expect(c.totalInterest).toBeCloseTo(c.totalPaid - c.principal, 1);
    expect(c.totalInterest).toBeGreaterThan(0);
  });

  it('THE POINT: financing changes the number a simulator should compare', () => {
    const c = creditFor(500_000, terms);
    expect(c.totalWithCredit).toBeGreaterThan(500_000);
    // Over 20 years at 6% the interest is a large fraction of the build.
    expect(c.totalWithCredit / 500_000).toBeGreaterThan(1.3);
  });

  it('a full down payment is a house paid cash — no interest at all', () => {
    const c = creditFor(500_000, { ...terms, downPaymentRatio: 1 });
    expect(c.principal).toBe(0);
    expect(c.totalInterest).toBe(0);
    expect(c.totalWithCredit).toBe(500_000);
  });

  it('at zero interest the total is exactly the construction cost', () => {
    const c = creditFor(500_000, { ...terms, annualRatePct: 0 });
    expect(c.totalWithCredit).toBeCloseTo(500_000, 0);
  });
});

describe('lifecycleFor — build and run, on the same years', () => {
  const terms = { downPaymentRatio: 0.15, years: 25, annualRatePct: 6.5, energyPriceLeiKwh: 0.9 };

  it('adds the heating bill over the term', () => {
    const l = lifecycleFor(500_000, 10_000, terms);
    expect(l.annualEnergyCost).toBeCloseTo(9_000, 2);
    expect(l.energyOverTerm).toBeCloseTo(225_000, 2);
    expect(l.totalOverTerm).toBeCloseTo(l.totalWithCredit + l.energyOverTerm, 2);
  });

  it('a costlier but warmer house can win over the term — the whole reason this exists', () => {
    // +40 000 to build, but 6 000 kWh/yr less to heat.
    const cheap = lifecycleFor(500_000, 16_000, terms);
    const warm = lifecycleFor(540_000, 10_000, terms);
    expect(warm.totalWithCredit).toBeGreaterThan(cheap.totalWithCredit);  // costs more to build
    expect(warm.totalOverTerm).toBeLessThan(cheap.totalOverTerm);          // costs less to own
  });

  it('a model with no envelope reports the credit alone, with no invented energy', () => {
    const l = lifecycleFor(500_000, 0, terms);
    expect(l.annualEnergyCost).toBe(0);
    expect(l.totalOverTerm).toBe(l.totalWithCredit);
  });
});

describe('parseCreditTerms', () => {
  it('an absent block loads the defaults', () => {
    expect(parseCreditTerms(undefined)).toEqual(DEFAULT_CREDIT_TERMS);
  });

  it('clamps nonsense instead of propagating it', () => {
    const t = parseCreditTerms({ downPaymentRatio: 5, years: -3, annualRatePct: 'mult', energyPriceLeiKwh: 2 });
    expect(t.downPaymentRatio).toBe(1);
    expect(t.years).toBe(0);
    expect(t.annualRatePct).toBe(DEFAULT_CREDIT_TERMS.annualRatePct);
    expect(t.energyPriceLeiKwh).toBe(2);
  });
});
