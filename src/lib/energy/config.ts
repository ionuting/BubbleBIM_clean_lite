/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * config.ts — toate convențiile calculului energetic, într-un singur obiect.
 *
 * DE CE
 * -----
 * Modulul e plin de numere care NU sunt măsurători: ψ-uri de punte, U-uri
 * pentru părțile pe care modelul nu le descrie prin straturi, λ echivalent pe
 * sistem structural, grade-zile. Toate erau constante în cod, ceea ce le făcea
 * să pară adevăruri. Nu sunt: sunt valori de pornire, potrivite pentru un
 * exemplu și greșite pentru un proiect anume.
 *
 * Deci aceeași regulă ca la prețuri: **implicitele dedesubt, ale
 * utilizatorului deasupra**. `DEFAULT_ENERGY_CONFIG` rămâne demo-ul care merge
 * din prima; `resolveEnergyConfig` pune peste el ce a schimbat utilizatorul, și
 * fiecare valoare știe să spună dacă e a ei sau a lui.
 *
 * Funcțiile de calcul primesc configurația ca PARAMETRU, nu o citesc dintr-un
 * store: rămân pure, deci un scenariu poate fi evaluat cu altă configurație
 * fără să miște starea aplicației.
 */
import type { StructuralSystem } from '@/lib/systems/structuralSystem';
import type { BridgeKind } from './bridges';

/** Elementele de anvelopă al căror U nu vine din straturi declarate. */
export type UKey = 'window' | 'door' | 'ground' | 'roof';

export const U_LABELS: Record<UKey, string> = {
  window: 'Ferestre',
  door: 'Uși exterioare',
  ground: 'Placă pe sol',
  roof: 'Acoperiș (fără grosime declarată)',
};

/** O localitate de calcul. */
export interface ClimateSite {
  id: string;
  label: string;
  /** Grade-zile, K·zi, baza 12 °C. */
  degreeDays: number;
  /** Temperatura exterioară convențională de iarnă, °C. */
  designTempC: number;
}

export interface EnergyConfig {
  /** ψ pe fel de punte, W/mK. */
  psi: Record<BridgeKind, number>;
  /** U pentru elementele fără straturi declarate, W/m²K. */
  u: Record<UKey, number>;
  /** λ echivalent al stratului portant, pe sistem structural, W/mK. */
  coreLambda: Record<StructuralSystem, number>;
  /** λ suprascris pentru un strat din librărie, cheiat `grup:opțiune`. */
  lambda: Record<string, number>;
  /** Localitățile disponibile. */
  sites: ClimateSite[];
  /** Schimburi de aer pe oră. */
  ach: number;
  /** Temperatura interioară de calcul, °C. */
  indoorTempC: number;
  /** Rezistențe superficiale, m²K/W (EN ISO 6946, flux orizontal). */
  rSi: number;
  rSe: number;
}

/**
 * ψ orientativ, W/mK, pentru o anvelopă cu termosistem continuu.
 *
 * Valori de proiectare uzuale, NU rezultatul unui calcul de câmp termic pe
 * detaliile acestui proiect. Cea de la teren e cea mai mare fiindcă acolo
 * termosistemul se oprește de obicei; colțul intrând e NEGATIV fiindcă
 * suprafața interioară e mai mare decât cea exterioară — nu e o eroare de semn.
 */
export const DEFAULT_PSI: Record<BridgeKind, number> = {
  corner_convex: 0.10,
  corner_concave: -0.05,
  ground: 0.45,
  roof: 0.25,
  storey_slab: 0.10,
  layer_change: 0.05,
  opening: 0.10,
};

/** U-uri uzuale pentru o casă nouă. Nu sunt citite din model. */
export const DEFAULT_U: Record<UKey, number> = {
  window: 1.3,
  door: 1.8,
  ground: 0.35,
  roof: 0.20,
};

/**
 * λ echivalent al miezului portant, W/mK.
 *
 * Pentru zidărie și beton e λ-ul materialului. Pentru `timber_frame` e o
 * valoare EFECTIVĂ a peretelui cu montanți și izolație între ei, cu o fracție
 * de lemn de ~15% — de aia e atât de mic. Pentru `unset` e o zidărie oarecare,
 * fiindcă a nu alege un sistem nu poate să însemne o clădire fără pereți.
 */
export const DEFAULT_CORE_LAMBDA: Record<StructuralSystem, number> = {
  confined_masonry: 0.25,
  rc_frame: 0.30,
  rc_shear_wall: 1.74,
  timber_frame: 0.06,
  clt: 0.13,
  steel_frame: 0.35,
  precast: 1.74,
  unset: 0.35,
};

/**
 * Localități de pornire — ORIENTATIVE.
 *
 * Un număr climatic greșit deplasează tot rezultatul proporțional, deci e prima
 * cifră de înlocuit cu una din certificatul energetic sau dintr-un fișier TMY.
 * De aia sunt editabile, și de aia se pot adăuga altele.
 */
export const DEFAULT_SITES: ClimateSite[] = [
  { id: 'bucuresti', label: 'București', degreeDays: 2100, designTempC: -15 },
  { id: 'constanta', label: 'Constanța', degreeDays: 1950, designTempC: -12 },
  { id: 'timisoara', label: 'Timișoara', degreeDays: 2150, designTempC: -15 },
  { id: 'cluj', label: 'Cluj-Napoca', degreeDays: 2650, designTempC: -18 },
  { id: 'iasi', label: 'Iași', degreeDays: 2500, designTempC: -18 },
  { id: 'brasov', label: 'Brașov', degreeDays: 2900, designTempC: -21 },
];

export const DEFAULT_ENERGY_CONFIG: EnergyConfig = {
  psi: DEFAULT_PSI,
  u: DEFAULT_U,
  coreLambda: DEFAULT_CORE_LAMBDA,
  lambda: {},
  sites: DEFAULT_SITES,
  ach: 0.5,
  indoorTempC: 20,
  rSi: 0.13,
  rSe: 0.04,
};

// ─── Suprascrierile utilizatorului ───────────────────────────────────────────

/**
 * Ce a schimbat utilizatorul. Doar abaterile — un proiect care n-a atins nimic
 * salvează un obiect gol și se calculează exact ca demo-ul.
 */
export interface EnergyOverrides {
  psi?: Partial<Record<BridgeKind, number>>;
  u?: Partial<Record<UKey, number>>;
  coreLambda?: Partial<Record<StructuralSystem, number>>;
  /** `grup:opțiune` → λ. Suprascrie ce declară librăria pentru acel strat. */
  lambda?: Record<string, number>;
  /** Localități adăugate sau modificate, după `id`. */
  sites?: ClimateSite[];
  ach?: number;
  indoorTempC?: number;
  rSi?: number;
  rSe?: number;
}

const num = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Suprascrierile aplicate peste un map de implicite, ignorând ce nu e număr. */
function mergeNumbers<K extends string>(
  base: Record<K, number>,
  over: Partial<Record<K, number>> | undefined,
): Record<K, number> {
  if (!over) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over) as Array<[K, unknown]>) {
    const n = num(v);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

/**
 * Localitățile în vigoare: cele implicite, cu ale utilizatorului peste — o
 * localitate cu același `id` o ÎNLOCUIEȘTE, una cu id nou se ADAUGĂ la coadă.
 * Așa se poate și corecta București, și adăuga Sibiu.
 */
export function mergeSites(base: ClimateSite[], over: ClimateSite[] | undefined): ClimateSite[] {
  if (!over || over.length === 0) return base;
  const byId = new Map(base.map((s) => [s.id, s]));
  const order = base.map((s) => s.id);
  for (const s of over) {
    if (!s?.id) continue;
    const dd = num(s.degreeDays);
    const dt = num(s.designTempC);
    const prev = byId.get(s.id);
    byId.set(s.id, {
      id: s.id,
      label: s.label || prev?.label || s.id,
      degreeDays: dd !== undefined && dd > 0 ? dd : (prev?.degreeDays ?? 2100),
      designTempC: dt !== undefined ? dt : (prev?.designTempC ?? -15),
    });
    if (!order.includes(s.id)) order.push(s.id);
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

let cache: {
  project: EnergyOverrides | undefined;
  user: EnergyOverrides | undefined;
  out: EnergyConfig;
} | null = null;

/**
 * Configurația în vigoare: **implicit → utilizator → proiect**.
 *
 * Stratul utilizatorului sunt convențiile pe care le duci cu tine dintr-un
 * proiect în altul (vezi `userLibraryStore`); cel de proiect îl bate.
 *
 * Memoizată pe identitatea intrărilor, fiindcă ajunge într-un `useEffect` care
 * evaluează toate scenariile — un obiect nou la fiecare render ar reevalua la
 * infinit.
 */
export function resolveEnergyConfig(
  over: EnergyOverrides | undefined,
  user?: EnergyOverrides,
): EnergyConfig {
  if (cache && cache.project === over && cache.user === user) return cache.out;
  const pick = <K extends keyof EnergyOverrides>(k: K) => over?.[k] ?? user?.[k];
  const out: EnergyConfig = {
    psi: mergeNumbers(mergeNumbers(DEFAULT_PSI, user?.psi), over?.psi),
    u: mergeNumbers(mergeNumbers(DEFAULT_U, user?.u), over?.u),
    coreLambda: mergeNumbers(mergeNumbers(DEFAULT_CORE_LAMBDA, user?.coreLambda), over?.coreLambda),
    lambda: { ...(user?.lambda ?? {}), ...(over?.lambda ?? {}) },
    sites: mergeSites(mergeSites(DEFAULT_SITES, user?.sites), over?.sites),
    ach: num(pick('ach')) ?? DEFAULT_ENERGY_CONFIG.ach,
    indoorTempC: num(pick('indoorTempC')) ?? DEFAULT_ENERGY_CONFIG.indoorTempC,
    rSi: num(pick('rSi')) ?? DEFAULT_ENERGY_CONFIG.rSi,
    rSe: num(pick('rSe')) ?? DEFAULT_ENERGY_CONFIG.rSe,
  };
  cache = { project: over, user, out };
  return out;
}

/** Localitatea cerută, sau prima din listă — niciodată `undefined`. */
export const siteById = (id: string | undefined, config: EnergyConfig): ClimateSite =>
  config.sites.find((s) => s.id === id) ?? config.sites[0] ?? DEFAULT_SITES[0];
