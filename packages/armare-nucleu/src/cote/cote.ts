import { type Vector2, vec } from "../geometrie/vector";
import { anvelopaSegmente } from "../geometrie/polilinie";
import type { Segment } from "../model/tipuri";

/**
 * O cotă liniară: linia de cotă între două puncte, cu un offset perpendicular
 * și textul aferent. Reprezentare simplă, consumată identic de canvas și DXF.
 */
export interface CotaLiniara {
  p1: Vector2;
  p2: Vector2;
  /** Distanța (mm) la care e trasă linia de cotă față de geometrie. */
  offset: number;
  /** Orientarea offsetului: cotă orizontală (jos) sau verticală (dreapta). */
  orientare: "orizontala" | "verticala";
  text: string;
}

/** Formatează o valoare în mm pentru afișare pe cotă. */
export function formateazaCota(valoareMm: number): string {
  return `${Math.round(valoareMm)}`;
}

/**
 * Generează cotele de gabarit (lățime totală + înălțime totală) pentru o formă,
 * pe baza anvelopei segmentelor.
 */
export function coteGabarit(segmente: Segment[], offset = 60): CotaLiniara[] {
  const a = anvelopaSegmente(segmente);
  const cote: CotaLiniara[] = [];

  if (a.latime > 1e-6) {
    cote.push({
      p1: vec(a.minX, a.minY),
      p2: vec(a.maxX, a.minY),
      offset,
      orientare: "orizontala",
      text: formateazaCota(a.latime),
    });
  }
  if (a.inaltime > 1e-6) {
    cote.push({
      p1: vec(a.maxX, a.minY),
      p2: vec(a.maxX, a.maxY),
      offset,
      orientare: "verticala",
      text: formateazaCota(a.inaltime),
    });
  }
  return cote;
}
