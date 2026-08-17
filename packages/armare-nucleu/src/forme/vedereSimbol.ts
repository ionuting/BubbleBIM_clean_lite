import { definitiePentru } from "./catalog";
import type { FormaArmare, TipVedere } from "../model/tipuri";

/** Diametrul barei (mm). */
export function diametruForma(forma: FormaArmare): number {
  return forma.parametri.diametru ?? 10;
}

/**
 * Lungimea liniei în vedere plan (sus): lățimea etrierului (a) sau fallback bbox.
 * Pe array-path linia e rotită perpendicular pe path.
 */
export function lungimeVedereSus(forma: FormaArmare, bboxW = 0): number {
  const p = forma.parametri;
  switch (forma.tip) {
    case "etrier":
      return p.a ?? bboxW;
    case "etrier-lateral":
      return p.inaltime ?? bboxW;
    case "dreapta":
    case "L":
    case "U":
      return p.lungime ?? bboxW;
    default:
      return bboxW > 0 ? bboxW : 100;
  }
}

/**
 * Lungimea liniei în vedere laterală: înălțimea etrierului (b) sau fallback bbox.
 */
export function lungimeVedereLateral(forma: FormaArmare, bboxH = 0): number {
  const p = forma.parametri;
  switch (forma.tip) {
    case "etrier":
      return p.b ?? bboxH;
    case "etrier-lateral":
      return p.inaltime ?? bboxH;
    case "dreapta":
    case "L":
    case "U":
      return diametruForma(forma);
    default:
      return bboxH > 0 ? bboxH : 100;
  }
}

/** Vedere secțiune: cerc plin (simbol pe plan). */
export function esteVedereSectiune(vedere: TipVedere | undefined): boolean {
  return vedere === "sectiune";
}

/** Formă de cofraj — fără vedere secțiune simbol. */
export function acceptaVedereSimbol(forma: FormaArmare): boolean {
  return definitiePentru(forma.tip).categorie !== "cofraj";
}

/** Etichete UI pentru tipurile de vedere. */
export const ETICHETE_VEDERE: Record<TipVedere, string> = {
  frontal: "Frontală",
  sus: "Plan (L)",
  lateral: "Laterală (H)",
  sectiune: "Secțiune",
};
