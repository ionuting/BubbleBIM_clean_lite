/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * zonePasses.ts — un element zonat pe înălțime, ca listă de măsurători.
 *
 * Motorul măsura fiecare nod o dată. Un nod cu benzi (`lib/zones/heightZones.ts`)
 * se măsoară o dată PE BANDĂ, fiecare bandă cu înălțimea ei, cu golurile
 * decupate pe ea și cu nodul văzut prin suprascrierile ei — după care regulile
 * se potrivesc normal. O formulă de normă scrisă în `height_m` nu află
 * niciodată că există benzi.
 *
 * PROBLEMA CARE TREBUIE REZOLVATĂ, ALTFEL SE DUBLEAZĂ TOT
 * -------------------------------------------------------
 * Dacă pur și simplu emiți fiecare regulă pe fiecare bandă, o cameră cu două
 * benzi produce ȘAPA DE DOUĂ ORI: șapa se măsoară pe `area_m2` (pardoseala),
 * care n-are nicio treabă cu înălțimea.
 *
 * Deci o ieșire se emite pe fiecare bandă doar dacă e LINIARĂ ÎN ÎNĂLȚIME, iar
 * asta nu se ghicește și nu se adnotează în librărie: se MĂSOARĂ. Nodul se
 * măsoară o dată în plus, la jumătate de înălțime, și se compară:
 *
 *     q(H/2) * 2 == q(H)   →  se împarte pe benzi
 *     altfel               →  se emite o singură dată, pe prima bandă
 *
 * `perimeter_m * height_m` (tencuiala) trece; `area_m2` pe cameră (pardoseala),
 * `count`, și orice formulă cu o înălțime hardcodată nu trec. Costă o măsurare
 * în plus, și doar pentru nodurile chiar zonate.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import type { calcWallJoins } from '@/lib/bimGeometry';
import type { NodeMeasures } from '@/lib/norms/types';
import { heightZonesOf, zoneNode, type HeightZone } from '@/lib/zones/heightZones';
import { measureNode } from './geometryMeasures';

/** O măsurătoare de emis: nodul așa cum îl vede banda, plus banda însăși. */
export interface ZonePass {
  node: BubbleGraphNode;
  measures: NodeMeasures;
  /** `null` pentru un nod nezonat — o singură trecere, ca înainte. */
  zone: HeightZone | null;
}

export interface ZonedNode {
  passes: ZonePass[];
  /**
   * Aceeași măsurătoare la jumătate de înălțime, pentru testul de liniaritate.
   * `null` când nodul nu e zonat și testul n-are rost.
   */
  probe: NodeMeasures | null;
}

/** Toleranța testului de liniaritate — relativă, ca să nu depindă de unități. */
const EPS = 1e-6;

/** `2 * q(H/2) == q(H)` — ieșirea se împarte pe benzi. */
export function scalesWithHeight(qHalf: number, qFull: number): boolean {
  return Math.abs(qHalf * 2 - qFull) <= EPS * Math.max(1, Math.abs(qFull));
}

/**
 * Trecerile de făcut pentru un nod. Un nod fără benzi dă exact o trecere cu
 * măsurătoarea primită — deci un proiect care n-a configurat nimic trece prin
 * exact același cod și dă exact aceleași cifre.
 */
export function zonePassesFor(
  node: BubbleGraphNode,
  fullMeasures: NodeMeasures,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
  wallJoins?: ReturnType<typeof calcWallJoins>,
): ZonedNode {
  const zones = heightZonesOf(node, fullMeasures.height_m);
  if (!zones) return { passes: [{ node, measures: fullMeasures, zone: null }], probe: null };

  const passes: ZonePass[] = [];
  for (const zone of zones) {
    const zn = zoneNode(node, zone);
    // Deliberat NEmemoizat: memo-ul e cheiat pe identitatea nodului, iar aici
    // același nod dă rezultate diferite pe fiecare bandă.
    const m = measureNode(zn, edges, nodeMap, wallJoins, { fromM: zone.fromM, toM: zone.toM });
    if (!m) continue;
    passes.push({ node: zn, measures: m, zone });
  }
  if (passes.length === 0) return { passes: [{ node, measures: fullMeasures, zone: null }], probe: null };

  const probe = measureNode(node, edges, nodeMap, wallJoins, { fromM: 0, toM: fullMeasures.height_m / 2 });
  return { passes, probe };
}
