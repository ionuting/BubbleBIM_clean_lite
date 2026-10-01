/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * heating.ts — necesarul anual de încălzire, prin grade-zile.
 *
 * METODA
 * ------
 *   Q [kWh/an] = (H_transmisie + H_ventilare) × GZ × 24 / 1000
 *
 * unde `H_ventilare = 0.34 × n × V`, cu `n` schimburi de aer pe oră.
 *
 * DE CE GRADE-ZILE LA BAZA DE 12 °C ȘI NU 20
 * -------------------------------------------
 * Interiorul se ține la 20 °C, dar clădirea nu are nevoie de încălzire până la
 * 20: oamenii, aparatele și soarele aduc câțiva grade pe gratis. Convenția
 * românească a gradelor-zile la baza de 12 °C ține cont de aporturile astea
 * IMPLICIT. Alternativa — baza 20 °C minus aporturile calculate cu factor de
 * utilizare — cere un calcul lunar cu radiație orientată, adică exact ce am
 * spus că nu facem în varianta simplă. Cu baza 12 °C rezultatul e rezonabil
 * fără să pretindem o precizie pe care n-o avem.
 *
 * CIFRELE CLIMATICE SUNT ORIENTATIVE
 * -----------------------------------
 * `CLIMATE` de mai jos e un tabel de pornire, nu date măsurate. Se editează, la
 * fel ca prețurile, și trebuie înlocuit cu valorile din certificatul energetic
 * sau dintr-un fișier TMY (climate.onebuilding.org) când contează. Un număr
 * climatic greșit deplasează tot rezultatul proporțional, deci e prima cifră de
 * verificat înainte să crezi un total.
 *
 * Pur: fără store, fără React.
 */



import {
  DEFAULT_ENERGY_CONFIG, DEFAULT_SITES, siteById, type ClimateSite, type EnergyConfig,
} from './config';

export type { ClimateSite };

/** Localitățile implicite. Cele în vigoare vin din `EnergyConfig`. */
export const CLIMATE = DEFAULT_SITES;
export const DEFAULT_SITE = DEFAULT_SITES[0];

/** Localitatea cerută, din configurația dată sau din cea implicită. */
export const climateSite = (id: string | undefined, config?: EnergyConfig): ClimateSite =>
  siteById(id, config ?? DEFAULT_ENERGY_CONFIG);

/** Schimburi de aer pe oră, implicit — o casă nouă, ventilată natural. */
export const DEFAULT_ACH = DEFAULT_ENERGY_CONFIG.ach;

/** Capacitatea termică volumică a aerului, Wh/m³K. */
const AIR_C = 0.34;

export interface HeatingInput {
  /** Pierderea prin transmisie, W/K — de la `computeEnvelope`. */
  transmissionWPerK: number;
  heatedVolumeM3: number;
  heatedAreaM2: number;
  site?: ClimateSite;
  /** Schimburi de aer pe oră. */
  ach?: number;
  /** Temperatura interioară de calcul, °C — pentru sarcina de vârf. */
  indoorTempC?: number;
  /** Convențiile în vigoare; dau valorile implicite pentru ACH și interior. */
  config?: EnergyConfig;
}

export interface HeatingResult {
  /** Ventilare, W/K. */
  ventilationWPerK: number;
  /** Transmisie + ventilare, W/K. */
  totalWPerK: number;
  /** Necesarul anual de încălzire, kWh/an. */
  annualKwh: number;
  /** Același, raportat la aria încălzită — cifra care se compară. */
  kwhM2Yr: number;
  /** Sarcina termică de vârf la temperatura de calcul, kW. */
  peakLoadKw: number;
  site: ClimateSite;
  ach: number;
}

const R2 = (n: number) => Math.round(n * 100) / 100;

export function computeHeating(input: HeatingInput): HeatingResult {
  const cfg = input.config ?? DEFAULT_ENERGY_CONFIG;
  const site = input.site ?? cfg.sites[0] ?? DEFAULT_SITE;
  const ach = input.ach ?? cfg.ach;
  const indoor = input.indoorTempC ?? cfg.indoorTempC;

  const ventilationWPerK = AIR_C * ach * input.heatedVolumeM3;
  const totalWPerK = input.transmissionWPerK + ventilationWPerK;

  const annualKwh = (totalWPerK * site.degreeDays * 24) / 1000;
  const peakLoadKw = (totalWPerK * (indoor - site.designTempC)) / 1000;

  return {
    ventilationWPerK: R2(ventilationWPerK),
    totalWPerK: R2(totalWPerK),
    annualKwh: R2(annualKwh),
    kwhM2Yr: input.heatedAreaM2 > 0 ? R2(annualKwh / input.heatedAreaM2) : 0,
    peakLoadKw: R2(peakLoadKw),
    site,
    ach,
  };
}

/**
 * Clasa energetică, după consumul specific de încălzire.
 *
 * Pragurile sunt cele uzuale pentru încălzire în certificatul românesc. NU e un
 * certificat: certificatul însumează încălzire, apă caldă, ventilare și
 * iluminat, și trece prin randamentele instalației. Aici e doar o citire a
 * anvelopei, și scrie asta pe ea.
 */
export function energyClass(kwhM2Yr: number): string {
  if (kwhM2Yr <= 29) return 'A';
  if (kwhM2Yr <= 68) return 'B';
  if (kwhM2Yr <= 107) return 'C';
  if (kwhM2Yr <= 146) return 'D';
  if (kwhM2Yr <= 185) return 'E';
  if (kwhM2Yr <= 224) return 'F';
  return 'G';
}
