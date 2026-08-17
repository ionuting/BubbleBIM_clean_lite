import type { FormaArmare } from "../model/tipuri";
import type { AncoraCota } from "../model/cofraj";
import type { Vector2 } from "../geometrie/vector";
import { aduna } from "../geometrie/vector";
import { anvelopaSegmente } from "../geometrie/polilinie";
import { puncteControlForma, segmenteForma } from "../forme/catalog";

/** Puncte locale de referință pe o formă (inserție, colțuri bbox, puncte control). */
export function refLocaleForma(forma: FormaArmare): Vector2[] {
  const a = anvelopaSegmente(segmenteForma(forma));
  const colturi: Vector2[] = [
    { x: a.minX, y: a.minY },
    { x: a.maxX, y: a.minY },
    { x: a.maxX, y: a.maxY },
    { x: a.minX, y: a.maxY },
  ];
  const pc = puncteControlForma(forma).map((p) => p.pozitie);
  return [{ x: 0, y: 0 }, ...colturi, ...pc];
}

/** Rezolvă poziția world a unei ancore pe formă; fallback dacă forma lipsește. */
export function rezolvaAncora(
  forme: FormaArmare[],
  ancora: AncoraCota,
  fallback: Vector2,
): Vector2 {
  const forma = forme.find((f) => f.id === ancora.idForma);
  if (!forma) return fallback;
  const refs = refLocaleForma(forma);
  const r = refs[ancora.indexRef] ?? { x: 0, y: 0 };
  return aduna(forma.pozitie, r);
}
