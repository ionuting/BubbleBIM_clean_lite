/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * pickHit.ts — care nod a fost ținta clicului, când mai multe sunt sub cursor.
 *
 * BUG-UL PE CARE ÎL REZOLVĂ
 * -------------------------
 * Alegerea se făcea cu `Array.find`: câștiga PRIMUL nod din listă care trecea
 * testul, nu cel mai apropiat. Iar un perete e „atins" pe toată lungimea lui,
 * în timp ce un punct de ax e atins doar în jurul lui. Cum pereții trec exact
 * peste punctele de ax — acolo sunt prinși — peretele fura clicul ori de câte
 * ori apărea mai devreme în listă. De aici senzația de „snap spre pereți, nu
 * spre punctele pe care le țintesc".
 *
 * REGULA
 * ------
 * Două clase de ținte, și ele NU sunt comparabile ca distanță:
 *
 *   PUNCT (ax, stâlp, fereastră…)  — un loc anume, pe care utilizatorul îl ochește
 *   LINIE (perete, grindă)         — un traseu întreg, atins oriunde pe el
 *
 * Când cursorul e în raza unui punct, punctul e ce s-a vrut: a-l ochi cere
 * precizie, deci e o intenție, pe când a atinge o linie e aproape inevitabil.
 * Deci **orice punct bate orice linie**, iar în interiorul aceleiași clase
 * câștigă cel mai apropiat — nu primul din listă.
 *
 * Pur: fără React, fără canvas. Componenta calculează distanțele, asta alege.
 */

/** Ce fel de țintă e un nod, din punctul de vedere al ochirii. */
export type HitClass = 'point' | 'line' | 'area';

/** Ordinea claselor: mai mic = are prioritate. */
const CLASS_RANK: Record<HitClass, number> = { point: 0, line: 1, area: 2 };

/** Tipurile care se comportă ca un TRASEU, nu ca un loc. */
export const LINE_TYPES = new Set(['wall', 'beam']);

/** Tipurile care se comportă ca o SUPRAFAȚĂ — cedează în fața oricărui altceva. */
export const AREA_TYPES = new Set(['room', 'storey']);

export function hitClassOf(nodeType: string): HitClass {
  if (LINE_TYPES.has(nodeType)) return 'line';
  if (AREA_TYPES.has(nodeType)) return 'area';
  return 'point';
}

export interface HitCandidate<T = unknown> {
  node: T;
  nodeType: string;
  /** Distanța de la cursor la țintă, în unități de lume. */
  dist: number;
  /** Raza în care ținta e considerată atinsă. */
  radius: number;
}

/**
 * Ținta pe care a vrut-o utilizatorul, sau `undefined` când nimic nu e în rază.
 *
 * Candidații din afara razei lor sunt ignorați — raza e chiar definiția lui
 * „atins", și diferă de la un tip la altul.
 */
export function pickBestHit<T>(candidates: Array<HitCandidate<T>>): HitCandidate<T> | undefined {
  let best: HitCandidate<T> | undefined;
  let bestRank = Infinity;
  for (const c of candidates) {
    if (!(c.dist <= c.radius)) continue;
    const rank = CLASS_RANK[hitClassOf(c.nodeType)];
    if (best === undefined || rank < bestRank || (rank === bestRank && c.dist < best.dist)) {
      best = c;
      bestRank = rank;
    }
  }
  return best;
}

/** Distanța de la un punct la un segment — cât de departe e cursorul de un perete. */
export function distToSegment(
  px: number, py: number,
  x1: number, y1: number, x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x1 + t * dx - px, y1 + t * dy - py);
}
