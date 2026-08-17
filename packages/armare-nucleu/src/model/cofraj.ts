import type { Vector2 } from "../geometrie/vector";

/** Element de cofraj / schiță (linie, dreptunghi, cerc, polilinie). */
interface BazaCofraj {
  id: string;
  culoare: string;
  grosimeLinie: number;
}

export interface CofrajLinie extends BazaCofraj {
  tip: "linie";
  start: Vector2;
  sfarsit: Vector2;
}

export interface CofrajDreptunghi extends BazaCofraj {
  tip: "dreptunghi";
  pozitie: Vector2;
  latime: number;
  inaltime: number;
  rotatie: number;
}

export interface CofrajCerc extends BazaCofraj {
  tip: "cerc";
  centru: Vector2;
  raza: number;
}

export interface CofrajPolilinie extends BazaCofraj {
  tip: "polilinie-cofraj";
  varfuri: Vector2[];
  inchis: boolean;
}

export type ElementCofraj =
  | CofrajLinie
  | CofrajDreptunghi
  | CofrajCerc
  | CofrajPolilinie;

export const CULOARE_COFRAJ_IMPLICITA = "#64748b";
export const GROSIME_COFRAJ_IMPLICITA = 1.5;

/** Adnotație text liberă pe planșă. */
export interface Adnotatie {
  id: string;
  text: string;
  pozitie: Vector2;
  /** Înălțimea fontului în mm pe HÂRTIE (sistem annotative). */
  marime: number;
  culoare: string;
  rotatie: number;
}

export const ADNOTATIE_IMPLICITA: Omit<Adnotatie, "id" | "text" | "pozitie"> = {
  marime: 2.5,
  culoare: "#1e293b",
  rotatie: 0,
};

/**
 * Ancorare asociativă a unui capăt de cotă la un punct dintr-o formă.
 * Când e prezentă, capătul urmează automat geometria formei.
 */
export interface AncoraCota {
  /** ID-ul formei la care e ancorat capătul. */
  idForma: string;
  /**
   * Indexul în vectorul returnat de `refLocaleForma(forma)`:
   * 0 = inserție, 1-4 = colțuri bbox, 5+ = puncte de control.
   */
  indexRef: number;
}

/**
 * Cotă liniară liberă, plasată manual pe planșă (nu legată de o formă).
 * Textul se calculează automat ca distanța p1-p2 dacă nu e suprascris.
 */
export interface CotaLibera {
  id: string;
  p1: Vector2;
  p2: Vector2;
  /**
   * Offset perpendicular față de segmentul p1→p2 (mm).
   * Pozitiv = stânga față de direcția p1→p2 (rotație CCW).
   */
  offset: number;
  /** Text afișat; dacă absent, se calculează automat distanța p1-p2. */
  text?: string;
  culoare: string;
  /** Dacă setat, p1 se calculează dinamic din geometria formei de referință. */
  ref1?: AncoraCota;
  /** Dacă setat, p2 se calculează dinamic din geometria formei de referință. */
  ref2?: AncoraCota;
  /** Offset text de-a lungul liniei de cotă față de mijloc (mm). */
  offsetTextParalel?: number;
  /** Offset text perpendicular față de linia de cotă (mm), față de poziția implicită. */
  offsetTextPerpendicular?: number;
  /**
   * Override unitate per cotă (mm/cm/m). Dacă absent, se folosește setarea globală.
   */
  unitateCota?: import("../label/formateazaLabel").TipUnitateCota;
}

export const COTA_LIBERA_IMPLICITA: Omit<CotaLibera, "id" | "p1" | "p2"> = {
  offset: 80,
  culoare: "#15803d",
};

/**
 * O linie de axă (grid structural). Afișează o linie cu cerc + etichetă la capete.
 */
export interface LinieAxa {
  id: string;
  /** Punctul de start (domeniu, mm). */
  start: Vector2;
  /** Punctul de sfârșit (domeniu, mm). */
  sfarsit: Vector2;
  /** Eticheta axei folosită la ambele capete (dacă nu e suprascrisă). */
  eticheta: string;
  /** Etichetă alternativă la capătul de start (suprascrie `eticheta`). */
  etichetaStart?: string;
  /** Etichetă alternativă la capătul de sfârșit (suprascrie `eticheta`). */
  etichetaSfarsit?: string;
  /** Afișează cercul + eticheta la capătul de start (implicit true). */
  afiseazaLabelStart?: boolean;
  /** Afișează cercul + eticheta la capătul de sfârșit (implicit true). */
  afiseazaLabelSfarsit?: boolean;
  /** Culoarea liniei + cercului. */
  culoare: string;
  /** Tipul liniei: punct-linie (implicit) sau continuă. */
  tipLinie: "punct-linie" | "continua";
  /** Raza cercului de etichetă (mm). */
  razaCerc: number;
  /** Factor de scalare al pattern-ului de linie punctată (1 = implicit, 0.5 = mai dens, 2 = mai rar). */
  scalaLinie?: number;
}

export const LINIE_AXA_IMPLICITA: Omit<LinieAxa, "id" | "start" | "sfarsit" | "eticheta"> = {
  culoare: "#dc2626",
  tipLinie: "punct-linie",
  razaCerc: 40,
};

/**
 * Un stâlp (secțiune dreptunghiulară) cu hașură diagonală integrată.
 */
export interface Stalp {
  id: string;
  /** Centrul stâlpului (domeniu, mm). */
  pozitie: Vector2;
  /** Lățimea (mm). */
  latime: number;
  /** Înălțimea (mm). */
  inaltime: number;
  /** Rotație (grade, sens trigonometric). */
  rotatie: number;
  /** Culoarea conturului. */
  culoare: string;
  /** Grosimea conturului (mm). */
  grosimeLinie: number;
  /** Pas hașură diagonală (mm). */
  pasHasura: number;
}

export const STALP_IMPLICIT: Omit<Stalp, "id" | "pozitie"> = {
  latime: 300,
  inaltime: 300,
  rotatie: 0,
  culoare: "#374151",
  grosimeLinie: 1.5,
  pasHasura: 40,
};

/**
 * Dreptunghi generic cu nume și layer, afișează aria și perimetrul.
 */
export interface Dreptunghi {
  id: string;
  /** Numele dreptunghiului (ex. "Zona 1", "Cameră"). */
  nume: string;
  /** Layer-ul (pentru organizare / export). */
  layer: string;
  /** Centrul dreptunghiului (domeniu, mm). */
  pozitie: Vector2;
  /** Lățimea (mm). */
  latime: number;
  /** Înălțimea (mm). */
  inaltime: number;
  /** Rotație (grade, sens trigonometric). */
  rotatie: number;
  /** Culoarea conturului. */
  culoare: string;
  /** Grosimea conturului (mm). */
  grosimeLinie: number;
  /** Afișează aria pe desen. */
  arataArie: boolean;
  /** Afișează perimetrul pe desen. */
  arataPerimetru: boolean;
}

export const DREPTUNGHI_IMPLICIT: Omit<Dreptunghi, "id" | "pozitie" | "nume"> = {
  layer: "General",
  latime: 500,
  inaltime: 300,
  rotatie: 0,
  culoare: "#0891b2",
  grosimeLinie: 1,
  arataArie: true,
  arataPerimetru: true,
};
