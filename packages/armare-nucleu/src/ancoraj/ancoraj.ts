/**
 * Lungimi de ancoraj și de suprapunere conform SR EN 1992-1-1 (Eurocod 2), §8.4–8.7.
 * Implementare simplificată (coeficienții α2…α5 ≈ 1), suficientă pentru un extras
 * orientativ; valorile de proiectare finale rămân responsabilitatea inginerului.
 */

/** Rezistența caracteristică la întindere fctk;0,05 (MPa) pe clase de beton. */
const FCTK_005: Record<string, number> = {
  "C12/15": 1.1,
  "C16/20": 1.3,
  "C20/25": 1.5,
  "C25/30": 1.8,
  "C30/37": 2.0,
  "C35/45": 2.2,
  "C40/50": 2.5,
  "C45/55": 2.7,
  "C50/60": 2.9,
};

/** Clasele de beton disponibile (pentru selectoare UI). */
export const CLASE_BETON = Object.keys(FCTK_005);

export interface OptiuniAncoraj {
  clasaBeton: string;
  /** Condiții de aderență: „bune” (η1=1.0) sau „slabe” (η1=0.7). */
  aderenta: "bune" | "slabe";
  /** Limita de curgere caracteristică a oțelului (MPa). */
  fyk: number;
  /** Bară întinsă sau comprimată (afectează lb,min). */
  situatie: "intins" | "comprimat";
  /** Capăt drept sau cu cioc/cot (α1: 1.0 drept, 0.7 cu cioc, la întindere). */
  capat: "drept" | "cioc";
}

export const OPTIUNI_ANCORAJ_IMPLICITE: OptiuniAncoraj = {
  clasaBeton: "C25/30",
  aderenta: "bune",
  fyk: 500,
  situatie: "intins",
  capat: "drept",
};

export interface RezultatAncoraj {
  /** Tensiunea de aderență de proiectare fbd (MPa). */
  fbd: number;
  /** Lungimea de ancorare de bază necesară lb,rqd (mm). */
  lbRqd: number;
  /** Lungimea minimă de ancorare lb,min (mm). */
  lbMin: number;
  /** Lungimea de ancorare de proiectare lbd (mm). */
  lbd: number;
  /** Lungimea de suprapunere l0 (mm). */
  l0: number;
}

const GAMMA_C = 1.5;
const GAMMA_S = 1.15;

/** Calculează lungimile de ancoraj/suprapunere pentru un diametru dat. */
export function ancoraj(diametru: number, opt: OptiuniAncoraj): RezultatAncoraj {
  const fctk = FCTK_005[opt.clasaBeton] ?? FCTK_005["C25/30"]!;
  const fctd = fctk / GAMMA_C; // αct = 1.0

  const eta1 = opt.aderenta === "bune" ? 1.0 : 0.7;
  const eta2 = diametru <= 32 ? 1.0 : (132 - diametru) / 100;
  const fbd = 2.25 * eta1 * eta2 * fctd;

  const sigmaSd = opt.fyk / GAMMA_S; // tensiune de proiectare = fyd (ancorare la efort maxim)
  const lbRqd = (diametru / 4) * (sigmaSd / fbd);

  // α1: capăt cu cioc reduce lungimea la întindere (0.7), drept = 1.0.
  const alpha1 = opt.capat === "cioc" && opt.situatie === "intins" ? 0.7 : 1.0;

  const lbMin =
    opt.situatie === "intins"
      ? Math.max(0.3 * lbRqd, 10 * diametru, 100)
      : Math.max(0.6 * lbRqd, 10 * diametru, 100);

  const lbd = Math.max(alpha1 * lbRqd, lbMin);

  // Suprapunere: α6 = 1.5 (acoperitor, >50% bare înnădite în secțiune).
  const alpha6 = 1.5;
  const l0Min = Math.max(0.3 * alpha6 * lbRqd, 15 * diametru, 200);
  const l0 = Math.max(alpha6 * lbd, l0Min);

  return { fbd, lbRqd, lbMin, lbd, l0 };
}
