import type { CotaElevatie, FormatElevatie, NivelElevatie } from "../model/tipuri";
import { formateazaElevatie } from "../model/tipuri";
import type { Vector2 } from "../geometrie/vector";

/** Direcție pentru un nivel nou față de simbolul de bază. */
export type DirectieNivelElevatie = "sus" | "jos";

/** Un grup complet de elevație (triunghi + linii + text) la randare/export. */
export interface GrupNivelElevatie {
  id: string;
  /** Offset elevație față de baza cotei (mm model); 0 pentru simbolul de bază. */
  offsetElevatie: number;
  /**
   * Poziție verticală față de baza cotei.
   * - bază: mm hârtie (annotative, pentru fine-tuning)
   * - niveluri: mm model (= offset elevație, ca liniile de cotă)
   */
  distantaVerticala: number;
  /** Offset orizontal al simbolului (mm hârtie). */
  offsetOrizontal: number;
  label: string;
  offsetText?: Vector2;
  isBaza: boolean;
}

/** mm hârtie → mm model (annotative), același sistem ca dimensiunile simbolului. */
export function distantaPaperInModel(paperMm: number, factorAnnot: number): number {
  return paperMm * factorAnnot;
}

/** mm model → mm hârtie (annotative). */
export function distantaModelInPaper(modelMm: number, factorAnnot: number): number {
  if (factorAnnot === 0) return 0;
  return modelMm / factorAnnot;
}

/**
 * Poziție verticală a unui nivel în mm model — aceeași unitate ca liniile de cotă.
 * Implicit = offset elevație (diferența față de baza cotei).
 */
export function pozitieModelVerticalaNivel(
  _cota: CotaElevatie,
  nivel: NivelElevatie,
): number {
  if (nivel.distantaManuala && nivel.distantaVerticala != null) {
    return nivel.distantaVerticala;
  }
  return nivel.offset;
}

/** Offset orizontal — moștenește axa simbolului de bază dacă nu e setat. */
export function offsetOrizontalNivel(cota: CotaElevatie, nivel: NivelElevatie): number {
  return nivel.offsetOrizontal ?? cota.offsetGrupBaza?.x ?? 0;
}

const PAS_ELEVATIE_IMPLICIT_MM = 3000;

/** Offset elevație implicit pentru un nivel nou sus/jos față de bază. */
export function offsetElevatieImplicit(
  cota: CotaElevatie,
  directie: DirectieNivelElevatie = "sus",
): number {
  if (directie === "sus") {
    const deasupra = cota.niveluri.filter((n) => n.offset > 0).map((n) => n.offset);
    return deasupra.length
      ? Math.max(...deasupra) + PAS_ELEVATIE_IMPLICIT_MM
      : PAS_ELEVATIE_IMPLICIT_MM;
  }
  const dedesubt = cota.niveluri.filter((n) => n.offset < 0).map((n) => n.offset);
  return dedesubt.length
    ? Math.min(...dedesubt) - PAS_ELEVATIE_IMPLICIT_MM
    : -PAS_ELEVATIE_IMPLICIT_MM;
}

/** Toate grupurile de simbol (bază + niveluri) cu etichete calculate. */
export function grupuriNivelElevatie(cota: CotaElevatie): GrupNivelElevatie[] {
  const fmt = (cota.format ?? "m2") as FormatElevatie;
  const baza: GrupNivelElevatie = {
    id: `${cota.id}-baza`,
    offsetElevatie: 0,
    distantaVerticala: cota.offsetGrupBaza?.y ?? 0,
    offsetOrizontal: cota.offsetGrupBaza?.x ?? 0,
    label: formateazaElevatie(cota.elevatieBase, fmt),
    offsetText: cota.offsetText,
    isBaza: true,
  };
  const extra: GrupNivelElevatie[] = cota.niveluri.map((niv) => ({
    id: niv.id,
    offsetElevatie: niv.offset,
    distantaVerticala: pozitieModelVerticalaNivel(cota, niv),
    offsetOrizontal: offsetOrizontalNivel(cota, niv),
    label: niv.etichetaCustom ?? formateazaElevatie(cota.elevatieBase + niv.offset, fmt),
    offsetText: niv.offsetText,
    isBaza: false,
  }));
  return [baza, ...extra];
}

/** @deprecated alias pentru compatibilitate */
export function distantaVerticalaNivel(
  cota: CotaElevatie,
  nivel: NivelElevatie,
  _index: number,
): number {
  return pozitieModelVerticalaNivel(cota, nivel);
}
