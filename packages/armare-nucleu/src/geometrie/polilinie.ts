import {
  type Vector2,
  aduna,
  distanta,
  inmulteste,
  normalizeaza,
  produsVectorial,
  scade,
  unghi,
} from "./vector";
import type { Segment } from "../model/tipuri";

/**
 * Transformă o polilinie (listă de vârfuri ale axei barei) într-o listă de
 * segmente geometrice, înlocuind fiecare colț interior cu un arc tangent de
 * rază dată — exact felul în care o bară reală se îndoaie pe dorn.
 *
 * Dacă raza este 0 sau colțul nu permite filetare, se păstrează colțul ascuțit.
 */
export function fileteazaColturi(varfuri: Vector2[], raza: number): Segment[] {
  if (varfuri.length < 2) return [];
  if (raza <= 0 || varfuri.length < 3) {
    return segmenteDrepte(varfuri);
  }

  const segmente: Segment[] = [];
  // Punctul de la care pornește următoarea linie (se mută pe tangenta arcului).
  let plecare = varfuri[0]!;

  for (let i = 1; i < varfuri.length - 1; i++) {
    const v = varfuri[i]!;
    const anterior = varfuri[i - 1]!;
    const urmator = varfuri[i + 1]!;

    const fillet = calculeazaFillet(anterior, v, urmator, raza);

    if (!fillet) {
      // Colț prea strâns sau segmente prea scurte → păstrăm colțul ascuțit.
      segmente.push({ tip: "linie", start: plecare, sfarsit: v });
      plecare = v;
      continue;
    }

    segmente.push({ tip: "linie", start: plecare, sfarsit: fillet.tangentaIntrare });
    segmente.push(fillet.arc);
    plecare = fillet.tangentaIesire;
  }

  // Ultima linie până la vârful final.
  segmente.push({ tip: "linie", start: plecare, sfarsit: varfuri[varfuri.length - 1]! });
  return segmente;
}

/**
 * Filetează colțurile unui contur ÎNCHIS (ex. etrier dreptunghiular), înlocuind
 * fiecare vârf cu un arc tangent de rază dată și închizând bucla.
 */
export function fileteazaPoligon(varfuri: Vector2[], raza: number): Segment[] {
  const n = varfuri.length;
  if (n < 3) return segmenteDrepte([...varfuri, varfuri[0]!]);

  const intrari: Vector2[] = [];
  const iesiri: Vector2[] = [];
  const arce: (Extract<Segment, { tip: "arc" }> | null)[] = [];

  for (let i = 0; i < n; i++) {
    const anterior = varfuri[(i - 1 + n) % n]!;
    const v = varfuri[i]!;
    const urmator = varfuri[(i + 1) % n]!;
    const fillet = raza > 0 ? calculeazaFillet(anterior, v, urmator, raza) : null;
    if (fillet) {
      intrari[i] = fillet.tangentaIntrare;
      iesiri[i] = fillet.tangentaIesire;
      arce[i] = fillet.arc;
    } else {
      intrari[i] = v;
      iesiri[i] = v;
      arce[i] = null;
    }
  }

  const segmente: Segment[] = [];
  for (let i = 0; i < n; i++) {
    const arc = arce[i];
    if (arc) segmente.push(arc);
    // Linie de la ieșirea colțului curent până la intrarea colțului următor.
    const start = iesiri[i]!;
    const sfarsit = intrari[(i + 1) % n]!;
    if (distanta(start, sfarsit) > 1e-6) {
      segmente.push({ tip: "linie", start, sfarsit });
    }
  }
  return segmente;
}

function segmenteDrepte(varfuri: Vector2[]): Segment[] {
  const segmente: Segment[] = [];
  for (let i = 0; i < varfuri.length - 1; i++) {
    segmente.push({ tip: "linie", start: varfuri[i]!, sfarsit: varfuri[i + 1]! });
  }
  return segmente;
}

interface RezultatFillet {
  tangentaIntrare: Vector2;
  tangentaIesire: Vector2;
  arc: Extract<Segment, { tip: "arc" }>;
}

/**
 * Calculează arcul tangent în colțul `v` format de segmentele `a→v` și `v→c`,
 * pentru o rază dată. Întoarce null dacă geometria nu permite filetarea.
 */
function calculeazaFillet(
  a: Vector2,
  v: Vector2,
  c: Vector2,
  raza: number,
): RezultatFillet | null {
  const spreA = normalizeaza(scade(a, v));
  const spreC = normalizeaza(scade(c, v));

  // Unghiul interior dintre cele două laturi.
  let cosUnghi = spreA.x * spreC.x + spreA.y * spreC.y;
  cosUnghi = Math.max(-1, Math.min(1, cosUnghi));
  const unghiInterior = Math.acos(cosUnghi);

  // Laturi coliniare (drept sau întors complet) → fără arc.
  if (unghiInterior < 1e-3 || Math.PI - unghiInterior < 1e-3) return null;

  // Distanța de la vârf până la punctele de tangență.
  const tangenta = raza / Math.tan(unghiInterior / 2);

  const lungA = distanta(a, v);
  const lungC = distanta(c, v);
  // Nu putem fileta dacă tangenta depășește laturile disponibile.
  if (tangenta > lungA - 1e-6 || tangenta > lungC - 1e-6) return null;

  const tangentaIntrare = aduna(v, inmulteste(spreA, tangenta));
  const tangentaIesire = aduna(v, inmulteste(spreC, tangenta));

  // Centrul arcului: pe bisectoarea unghiului, la distanța raza / sin(unghi/2).
  const bisectoare = normalizeaza(aduna(spreA, spreC));
  const distCentru = raza / Math.sin(unghiInterior / 2);
  const centru = aduna(v, inmulteste(bisectoare, distCentru));

  const unghiStart = unghi(scade(tangentaIntrare, centru));
  const unghiSfarsit = unghi(scade(tangentaIesire, centru));

  // Sensul arcului: dat de orientarea colțului (stânga/dreapta).
  const sensOrar = produsVectorial(spreA, spreC) > 0;

  return {
    tangentaIntrare,
    tangentaIesire,
    arc: {
      tip: "arc",
      centru,
      raza,
      unghiStart,
      unghiSfarsit,
      sensOrar,
    },
  };
}

/** Discretizează un segment (linie sau arc) într-o listă de puncte, pentru randare. */
export function discretizeazaSegment(seg: Segment, pasUnghi = Math.PI / 24): Vector2[] {
  if (seg.tip === "linie") return [seg.start, seg.sfarsit];

  const puncte: Vector2[] = [];
  let { unghiStart, unghiSfarsit } = seg;

  // Normalizează intervalul în funcție de sens.
  if (seg.sensOrar) {
    while (unghiSfarsit > unghiStart) unghiSfarsit -= 2 * Math.PI;
  } else {
    while (unghiSfarsit < unghiStart) unghiSfarsit += 2 * Math.PI;
  }

  const total = Math.abs(unghiSfarsit - unghiStart);
  const pasi = Math.max(1, Math.ceil(total / pasUnghi));
  for (let i = 0; i <= pasi; i++) {
    const t = unghiStart + ((unghiSfarsit - unghiStart) * i) / pasi;
    puncte.push({
      x: seg.centru.x + seg.raza * Math.cos(t),
      y: seg.centru.y + seg.raza * Math.sin(t),
    });
  }
  return puncte;
}

/** Unghiul total parcurs de un arc (radiani, mereu pozitiv). */
function unghiArc(seg: Extract<Segment, { tip: "arc" }>): number {
  let { unghiStart, unghiSfarsit } = seg;
  if (seg.sensOrar) {
    while (unghiSfarsit > unghiStart) unghiSfarsit -= 2 * Math.PI;
  } else {
    while (unghiSfarsit < unghiStart) unghiSfarsit += 2 * Math.PI;
  }
  return Math.abs(unghiSfarsit - unghiStart);
}

/** Lungimea unui singur segment (mm). */
export function lungimeSegment(seg: Segment): number {
  if (seg.tip === "linie") return distanta(seg.start, seg.sfarsit);
  return seg.raza * unghiArc(seg);
}

/** Lungimea desfășurată totală a unei liste de segmente (mm). */
export function lungimeSegmente(segmente: Segment[]): number {
  let total = 0;
  for (const seg of segmente) total += lungimeSegment(seg);
  return total;
}

/** Anvelopa (bounding box) unei liste de segmente. */
export interface Anvelopa {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  latime: number;
  inaltime: number;
}

export function anvelopaSegmente(segmente: Segment[]): Anvelopa {
  const puncte = discretizeazaSegmente(segmente);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of puncte) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, latime: 0, inaltime: 0 };
  }
  return { minX, minY, maxX, maxY, latime: maxX - minX, inaltime: maxY - minY };
}

/** Discretizează o listă întreagă de segmente într-o polilinie continuă de puncte. */
export function discretizeazaSegmente(segmente: Segment[], pasUnghi?: number): Vector2[] {
  const puncte: Vector2[] = [];
  for (const seg of segmente) {
    const p = discretizeazaSegment(seg, pasUnghi);
    if (puncte.length > 0) p.shift(); // evită dublarea punctului de joncțiune
    puncte.push(...p);
  }
  return puncte;
}

/**
 * Împarte o listă de segmente în lanțuri CONTINUE (subtrasee): un nou lanț începe
 * acolo unde începutul unui segment nu coincide cu sfârșitul celui anterior.
 * Util pentru randare, când un traseu conține bucăți disjuncte (ex. arcul de
 * închidere al etrierului, care nu face parte din firul continuu al cârligelor).
 */
export function lanturiContinue(segmente: Segment[], toleranta = 1e-3): Segment[][] {
  const lanturi: Segment[][] = [];
  let curent: Segment[] = [];
  let capatAnterior: Vector2 | null = null;
  for (const seg of segmente) {
    const pct = discretizeazaSegment(seg);
    const start = pct[0]!;
    const sfarsit = pct[pct.length - 1]!;
    if (capatAnterior && distanta(capatAnterior, start) > toleranta) {
      if (curent.length > 0) lanturi.push(curent);
      curent = [];
    }
    curent.push(seg);
    capatAnterior = sfarsit;
  }
  if (curent.length > 0) lanturi.push(curent);
  return lanturi;
}
