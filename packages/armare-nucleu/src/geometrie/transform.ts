import { type Vector2, radiani, unghi as unghiVec } from "./vector";
import type { FormaArmare, Segment } from "../model/tipuri";

/**
 * Transformare liniară 2×2 (fără translație) pentru oglindire + rotație în jurul
 * originii locale a formei. Matricea e ortogonală (det = ±1), deci inversa = transpusa.
 */
export interface Matrice2 {
  a: number;
  b: number;
  c: number;
  d: number;
}

export const MATRICE_IDENTITATE: Matrice2 = { a: 1, b: 0, c: 0, d: 1 };

/** Construiește matricea de transformare a unei forme (oglindiri + rotație). */
export function matriceForma(forma: FormaArmare): Matrice2 {
  const sx = forma.oglinditX ? -1 : 1;
  const sy = forma.oglinditY ? -1 : 1;
  const t = radiani(forma.rotatie ?? 0);
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  // M = R(θ) · diag(sx, sy)
  return {
    a: cos * sx,
    b: -sin * sy,
    c: sin * sx,
    d: cos * sy,
  };
}

/** true dacă matricea e identitatea (nicio transformare de aplicat). */
export function esteIdentitate(m: Matrice2): boolean {
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
}

/** Determinantul (±1): negativ înseamnă oglindire (schimbă sensul arcelor). */
export function determinant(m: Matrice2): number {
  return m.a * m.d - m.b * m.c;
}

/** Inversa unei matrice ortogonale = transpusa. */
export function inversa(m: Matrice2): Matrice2 {
  return { a: m.a, b: m.c, c: m.b, d: m.d };
}

export function transformaPunct(m: Matrice2, p: Vector2): Vector2 {
  return { x: m.a * p.x + m.b * p.y, y: m.c * p.x + m.d * p.y };
}

function transformaArc(m: Matrice2, seg: Extract<Segment, { tip: "arc" }>): Segment {
  const centru = transformaPunct(m, seg.centru);
  const pStart = {
    x: seg.centru.x + seg.raza * Math.cos(seg.unghiStart),
    y: seg.centru.y + seg.raza * Math.sin(seg.unghiStart),
  };
  const pSfarsit = {
    x: seg.centru.x + seg.raza * Math.cos(seg.unghiSfarsit),
    y: seg.centru.y + seg.raza * Math.sin(seg.unghiSfarsit),
  };
  const tStart = transformaPunct(m, pStart);
  const tSfarsit = transformaPunct(m, pSfarsit);
  return {
    tip: "arc",
    centru,
    raza: seg.raza, // matrice ortogonală → raza nemodificată
    unghiStart: unghiVec({ x: tStart.x - centru.x, y: tStart.y - centru.y }),
    unghiSfarsit: unghiVec({ x: tSfarsit.x - centru.x, y: tSfarsit.y - centru.y }),
    sensOrar: determinant(m) < 0 ? !seg.sensOrar : seg.sensOrar,
  };
}

/** Transformă un segment prin matricea dată. */
export function transformaSegment(m: Matrice2, seg: Segment): Segment {
  if (seg.tip === "linie") {
    return { tip: "linie", start: transformaPunct(m, seg.start), sfarsit: transformaPunct(m, seg.sfarsit) };
  }
  return transformaArc(m, seg);
}

/** Transformă o listă de segmente (no-op dacă matricea e identitatea). */
export function transformaSegmente(m: Matrice2, segmente: Segment[]): Segment[] {
  if (esteIdentitate(m)) return segmente;
  return segmente.map((s) => transformaSegment(m, s));
}
