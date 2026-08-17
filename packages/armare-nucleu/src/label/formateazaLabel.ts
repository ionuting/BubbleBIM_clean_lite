import type { PartLabel, TipPartLabel } from "../model/tipuri";

/** Format global per tip de token (prefix, sufix, unitate). */
export interface FormatTokenLabel {
  prefix: string;
  /** Sufix literal după valoare (ex. spațiu). */
  sufix: string;
  unitate: string;
  afiseazaUnitate: boolean;
}

export const FORMAT_LABEL_IMPLICIT: Record<TipPartLabel, FormatTokenLabel> = {
  numar: { prefix: "", sufix: "", unitate: "buc", afiseazaUnitate: false },
  marca: { prefix: "", sufix: "", unitate: "", afiseazaUnitate: false },
  diametru: { prefix: "Ø", sufix: "", unitate: "mm", afiseazaUnitate: false },
  pas: { prefix: "/", sufix: "", unitate: "mm", afiseazaUnitate: true },
  lungime: { prefix: "L=", sufix: "", unitate: "mm", afiseazaUnitate: true },
  lungimeTotala: { prefix: "Ltot=", sufix: "", unitate: "mm", afiseazaUnitate: true },
  clasaOtel: { prefix: " ", sufix: "", unitate: "", afiseazaUnitate: false },
  text: { prefix: "", sufix: "", unitate: "", afiseazaUnitate: false },
};

/** Valoarea brută a unui token (fără prefix/sufix/unitate). */
export function valoareBrutaToken(
  tip: TipPartLabel,
  valori: Partial<Record<TipPartLabel, string | number>>,
): string {
  switch (tip) {
    case "numar":
      return `${valori.numar ?? ""}`;
    case "marca":
      return `${valori.marca ?? ""}`;
    case "diametru":
      return `${valori.diametru ?? ""}`;
    case "pas":
      return `${valori.pas ?? ""}`;
    case "lungime":
      return `${valori.lungime ?? ""}`;
    case "lungimeTotala":
      return `${valori.lungimeTotala ?? ""}`;
    case "clasaOtel":
      return `${valori.clasaOtel ?? ""}`;
    case "text":
      return "";
    default:
      return "";
  }
}

/** Formatează un singur token cu prefix/sufix/unitate (part > global > implicit). */
export function formateazaPartLabel(
  part: PartLabel,
  valori: Partial<Record<TipPartLabel, string | number>>,
  global?: Partial<Record<TipPartLabel, FormatTokenLabel>>,
): string {
  if (part.tip === "text") return part.valoare ?? "";
  if (part.tip === "marca") return "";

  const def = FORMAT_LABEL_IMPLICIT[part.tip];
  const g = global?.[part.tip];
  const prefix = part.prefix ?? g?.prefix ?? def.prefix;
  const sufixPart = part.sufix ?? g?.sufix ?? def.sufix;
  const unitate = g?.unitate ?? def.unitate;
  const afiseazaUnitate = g?.afiseazaUnitate ?? def.afiseazaUnitate;

  const raw = valoareBrutaToken(part.tip, valori);
  const unitSuffix =
    sufixPart ||
    (afiseazaUnitate && unitate ? (sufixPart === "" ? ` ${unitate}` : `${sufixPart}${unitate}`) : "");

  return `${prefix}${raw}${unitSuffix}`;
}

/** Compune textul complet din lista de tokenuri. */
export function textDinPartiLabel(
  parti: PartLabel[],
  valori: Partial<Record<TipPartLabel, string | number>>,
  global?: Partial<Record<TipPartLabel, FormatTokenLabel>>,
): string {
  return parti
    .filter((p) => p.tip !== "marca")
    .map((p) => formateazaPartLabel(p, valori, global))
    .join("");
}

export type TipUnitateCota = "mm" | "cm" | "m";

function convertesteMmLa(valoareMm: number, unitate: TipUnitateCota): number {
  if (unitate === "cm") return valoareMm / 10;
  if (unitate === "m") return valoareMm / 1000;
  return valoareMm;
}

function formateazaNumarCota(valoare: number, unitate: TipUnitateCota): string {
  if (unitate === "mm") return Math.round(valoare).toString();
  // max 2 zecimale, fără zerouri finale inutile
  return parseFloat(valoare.toFixed(2)).toString();
}

/**
 * Returnează perechea (număr, etichetă-unitate) pentru randare independentă
 * (ex. superscript). Valoarea de intrare este întotdeauna în mm.
 */
export function descompuneCotaFormata(
  valoareMm: number,
  format?: { prefix?: string; unitateCota?: TipUnitateCota; afiseazaUnitate?: boolean },
): { numar: string; unitate: string } {
  const prefix = format?.prefix ?? "";
  const unitateCota = format?.unitateCota ?? "mm";
  const afiseazaUnitate = format?.afiseazaUnitate ?? true;
  const valConv = convertesteMmLa(valoareMm, unitateCota);
  return {
    numar: `${prefix}${formateazaNumarCota(valConv, unitateCota)}`,
    unitate: afiseazaUnitate ? unitateCota : "",
  };
}

/** Formatează o valoare de cotă liberă (distanță) ca șir complet. Valoarea de intrare în mm. */
export function formateazaValoareCota(
  valoareMm: number,
  format?: { prefix?: string; unitateCota?: TipUnitateCota; afiseazaUnitate?: boolean },
): string {
  const { numar, unitate } = descompuneCotaFormata(valoareMm, format);
  return unitate ? `${numar} ${unitate}` : numar;
}

/**
 * Formatează o lungime (în mm) în unitatea specificată, cu simbol.
 * Ex: formateazaLungime(1500, "m") → "1.5 m"
 */
export function formateazaLungime(mm: number, unitate: TipUnitateCota): string {
  const val = convertesteMmLa(mm, unitate);
  return `${formateazaNumarCota(val, unitate)} ${unitate}`;
}

/**
 * Formatează o arie (în mm²) în unitatea specificată, cu simbol pătrat.
 * Ex: formateazaArie(1_000_000, "m") → "1 m²"
 */
export function formateazaArie(mm2: number, unitate: TipUnitateCota): string {
  let val: number;
  let label: string;
  switch (unitate) {
    case "cm": val = mm2 / 100; label = "cm²"; break;
    case "m":  val = mm2 / 1_000_000; label = "m²"; break;
    default:   val = mm2; label = "mm²";
  }
  const formatted =
    unitate === "mm"
      ? Math.round(val).toLocaleString("ro-RO")
      : parseFloat(val.toFixed(2)).toString();
  return `${formatted} ${label}`;
}
