/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * credit.ts — cât costă casa dacă o plătești în ani, nu odată.
 *
 * DE CE E ALTĂ ÎNTREBARE
 * ----------------------
 * Devizul spune cât costă construcția. Nimeni nu o plătește așa. Pe 25 de ani
 * la 6,5%, dobânda aproape dublează suma — iar asta schimbă clasamentul
 * variantelor, fiindcă orice leu în plus la construcție se multiplică, în timp
 * ce economia la încălzire vine an de an în sens invers.
 *
 * Un simulator care compară doar costul de construcție dă un sfat sistematic
 * greșit: îl împinge pe utilizator spre cea mai ieftină anvelopă, care e cea
 * mai scumpă de întreținut. Modulul ăsta pune cele două pe același tablou.
 *
 * COSTUL PE DURATA CREDITULUI
 * ---------------------------
 *   avans + Σ rate + Σ energie   pe aceiași ani
 *
 * Nu e o analiză financiară: nu actualizează sumele viitoare, nu ține cont de
 * inflație, de scumpirea energiei sau de deductibilități. E o însumare
 * onestă a plăților nominale — potrivită ca să compari două case, nu ca să
 * decizi o ipotecă.
 *
 * Pur: fără store, fără React.
 */

export interface CreditTerms {
  /** Avansul, fracție din costul construcției (0…1). */
  downPaymentRatio: number;
  /** Durata creditului, ani. */
  years: number;
  /** Dobânda nominală anuală, procente. */
  annualRatePct: number;
  /** Prețul energiei, lei/kWh — pentru costul de exploatare pe aceeași durată. */
  energyPriceLeiKwh: number;
}

/**
 * Valori de pornire, ORIENTATIVE. Dobânda și prețul energiei sunt exact genul
 * de cifre care se schimbă de la lună la lună; sunt editabile din panou.
 */
export const DEFAULT_CREDIT_TERMS: CreditTerms = {
  downPaymentRatio: 0.15,
  years: 25,
  annualRatePct: 6.5,
  energyPriceLeiKwh: 0.9,
};

const R2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Rata lunară a unui credit cu anuități egale.
 *
 *   R = P · i / (1 − (1+i)^−n)
 *
 * La dobândă zero formula are 0/0, deci se rezolvă separat: rata e principalul
 * împărțit la luni. Un credit fără dobândă e o ipoteză, nu o eroare.
 */
export function monthlyPayment(principal: number, annualRatePct: number, years: number): number {
  const months = Math.round(years * 12);
  if (!(principal > 0) || months <= 0) return 0;
  const i = annualRatePct / 100 / 12;
  if (Math.abs(i) < 1e-12) return principal / months;
  return (principal * i) / (1 - Math.pow(1 + i, -months));
}

export interface CreditResult {
  /** Avansul plătit la început. */
  downPayment: number;
  /** Suma împrumutată. */
  principal: number;
  months: number;
  monthlyPayment: number;
  /** Σ rate pe toată durata. */
  totalPaid: number;
  /** Cât din asta e dobândă. */
  totalInterest: number;
  /** Avans + Σ rate — cât te costă în total construcția, finanțată. */
  totalWithCredit: number;
}

export function creditFor(constructionCost: number, terms: CreditTerms): CreditResult {
  const cost = Math.max(0, constructionCost);
  const ratio = Math.min(1, Math.max(0, terms.downPaymentRatio));
  const downPayment = cost * ratio;
  const principal = cost - downPayment;
  const months = Math.max(0, Math.round(terms.years * 12));
  const rate = monthlyPayment(principal, terms.annualRatePct, terms.years);
  const totalPaid = rate * months;

  return {
    downPayment: R2(downPayment),
    principal: R2(principal),
    months,
    monthlyPayment: R2(rate),
    totalPaid: R2(totalPaid),
    totalInterest: R2(totalPaid - principal),
    totalWithCredit: R2(downPayment + totalPaid),
  };
}

export interface LifecycleResult extends CreditResult {
  /** Costul anual al încălzirii, la prețul din termeni. */
  annualEnergyCost: number;
  /** Σ energie pe durata creditului. */
  energyOverTerm: number;
  /** Avans + Σ rate + Σ energie — tot ce plătești în anii creditului. */
  totalOverTerm: number;
}

/**
 * Construcția finanțată PLUS exploatarea, pe aceiași ani.
 *
 * `annualEnergyKwh` vine din modulul energetic (necesarul anvelopei). Când e 0
 * — model fără anvelopă — rezultatul e curat costul creditului, nu o casă care
 * se încălzește singură; cine afișează cifra trebuie să spună care e cazul.
 */
export function lifecycleFor(
  constructionCost: number,
  annualEnergyKwh: number,
  terms: CreditTerms,
): LifecycleResult {
  const credit = creditFor(constructionCost, terms);
  const annualEnergyCost = Math.max(0, annualEnergyKwh) * Math.max(0, terms.energyPriceLeiKwh);
  const energyOverTerm = annualEnergyCost * Math.max(0, terms.years);
  return {
    ...credit,
    annualEnergyCost: R2(annualEnergyCost),
    energyOverTerm: R2(energyOverTerm),
    totalOverTerm: R2(credit.totalWithCredit + energyOverTerm),
  };
}

/** Curăță termenii veniți din afară (fișier salvat) fără să lase valori absurde. */
export function parseCreditTerms(v: unknown): CreditTerms {
  const o = (v ?? {}) as Partial<CreditTerms>;
  const num = (x: unknown, fallback: number, lo: number, hi: number) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  return {
    downPaymentRatio: num(o.downPaymentRatio, DEFAULT_CREDIT_TERMS.downPaymentRatio, 0, 1),
    years: num(o.years, DEFAULT_CREDIT_TERMS.years, 0, 50),
    annualRatePct: num(o.annualRatePct, DEFAULT_CREDIT_TERMS.annualRatePct, 0, 100),
    energyPriceLeiKwh: num(o.energyPriceLeiKwh, DEFAULT_CREDIT_TERMS.energyPriceLeiKwh, 0, 100),
  };
}
