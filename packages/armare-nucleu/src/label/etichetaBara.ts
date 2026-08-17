import { totalInstanteAxa, type EtichetaBara, type FormaArmare, type PartLabel, type TipPartLabel } from "../model/tipuri";
import { lungimeDesfasurata } from "../forme/catalog";
import {
  type FormatTokenLabel,
  textDinPartiLabel,
} from "./formateazaLabel";

/** Tokenuri implicite etichetă bară (balon): nr · Ø · L. */
export const PARTI_LABEL_ETICHETA_IMPLICITE: PartLabel[] = [
  { tip: "numar" },
  { tip: "text", valoare: " " },
  { tip: "diametru" },
  { tip: "text", valoare: " " },
  { tip: "lungime" },
];

/** Tokenuri implicite etichetă simbol detaliu bară. */
export const PARTI_LABEL_SIMBOL_BARA_IMPLICITE: PartLabel[] = [
  { tip: "diametru" },
  { tip: "text", valoare: "  " },
  { tip: "numar" },
  { tip: "text", valoare: "  " },
  { tip: "lungime" },
];

export interface OptiuniAfisareEtichetaBara {
  afiseazaNumar?: boolean;
  afiseazaDiametru?: boolean;
  afiseazaLungime?: boolean;
  afiseazaPas?: boolean;
}

/** Construiește lista de tokenuri din flag-urile vechi de afișare. */
export function partiLabelDinFlags(flags: OptiuniAfisareEtichetaBara): PartLabel[] {
  const parti: PartLabel[] = [];
  const sep = () => {
    if (parti.length) parti.push({ tip: "text", valoare: " " });
  };
  if (flags.afiseazaNumar) {
    sep();
    parti.push({ tip: "numar" });
  }
  if (flags.afiseazaDiametru) {
    sep();
    parti.push({ tip: "diametru" });
  }
  if (flags.afiseazaLungime) {
    sep();
    parti.push({ tip: "lungime" });
  }
  if (flags.afiseazaPas) {
    sep();
    parti.push({ tip: "pas" });
  }
  return parti.length ? parti : [...PARTI_LABEL_ETICHETA_IMPLICITE];
}

/** Tokenuri efective: custom > flag-uri (sau stil global). */
export function partiLabelEfectivEticheta(
  eticheta: EtichetaBara,
  opts?: OptiuniAfisareEtichetaBara,
): PartLabel[] {
  if (eticheta.partiLabel?.length) return eticheta.partiLabel;
  return partiLabelDinFlags({
    afiseazaNumar: opts?.afiseazaNumar ?? eticheta.afiseazaNumar,
    afiseazaDiametru: opts?.afiseazaDiametru ?? eticheta.afiseazaDiametru,
    afiseazaLungime: opts?.afiseazaLungime ?? eticheta.afiseazaLungime,
    afiseazaPas: opts?.afiseazaPas ?? eticheta.afiseazaPas,
  });
}

/** Valori pentru compunerea etichetei parametrice. */
export function valoriEtichetaBara(
  forma: FormaArmare,
  numarTotal?: number,
): Partial<Record<TipPartLabel, string | number>> {
  // Implicit: numar × instanțele array-ului 2D — consecvent cu extrasul de armare.
  const instante = forma.array
    ? totalInstanteAxa(forma.array, "x") * totalInstanteAxa(forma.array, "y")
    : 1;
  const nr = numarTotal ?? forma.numar * instante;
  const zonePas = (zone: { numar: number; pas: number }[]) =>
    zone.map((z) => `${z.numar}/${z.pas}`).join("+");
  // Pas afișat: axa X are prioritate; dacă distribuția e doar pe Y, folosește Y.
  const pasVal = !forma.array
    ? ""
    : forma.array.zoneX?.length
      ? zonePas(forma.array.zoneX)
      : forma.array.zoneY?.length && totalInstanteAxa(forma.array, "x") <= 1
        ? zonePas(forma.array.zoneY)
        : totalInstanteAxa(forma.array, "x") <= 1 && forma.array.nrY > 1
          ? forma.array.pasY
          : forma.array.pasX;
  const lungime = Math.round(lungimeDesfasurata(forma));
  return {
    numar: nr,
    marca: forma.marca,
    diametru: forma.parametri.diametru ?? 0,
    pas: pasVal,
    lungime,
    lungimeTotala: lungime * nr,
    clasaOtel: "",
  };
}

/** Text detalii etichetă bară (fără marca din balon). */
export function textEtichetaBara(
  eticheta: EtichetaBara,
  forma: FormaArmare | undefined,
  formatGlobal?: Partial<Record<TipPartLabel, FormatTokenLabel>>,
  opts?: OptiuniAfisareEtichetaBara,
): string {
  if (eticheta.textSuprascriere) return eticheta.textSuprascriere;
  if (!forma) return "";
  const parti = partiLabelEfectivEticheta(eticheta, opts);
  return textDinPartiLabel(parti, valoriEtichetaBara(forma), formatGlobal);
}

/** Text etichetă simbol detaliu bară (fără marca din cerc). */
export function textSimbolBaraLabel(
  parti: PartLabel[] | undefined,
  forma: FormaArmare,
  formatGlobal?: Partial<Record<TipPartLabel, FormatTokenLabel>>,
  numarTotal?: number,
): string {
  const lista = parti?.length ? parti : PARTI_LABEL_SIMBOL_BARA_IMPLICITE;
  return textDinPartiLabel(lista, valoriEtichetaBara(forma, numarTotal), formatGlobal);
}
