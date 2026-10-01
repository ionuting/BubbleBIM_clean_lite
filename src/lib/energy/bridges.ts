/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bridges.ts — punțile termice liniare, DERIVATE din geometrie.
 *
 * ÎNTREBAREA
 * ----------
 * „Punțile date de geometria exterioară s-ar putea calcula din geometria
 * nodului shell?" Da — și nu doar colțurile. O punte liniară e un traseu pe
 * care izolația se subțiază sau se întrerupe, iar traseele alea sunt exact
 * muchiile modelului nostru:
 *
 *   colț vertical      ← fiecare VÂRF al conturului shell, pe toată înălțimea
 *   racord cu terenul  ← perimetrul, o dată, la baza clădirii
 *   racord cu acoperiș ← perimetrul, o dată, la ultimul nivel
 *   planșeu intermediar← perimetrul × (număr de niveluri − 1)
 *   schimbare de strat ← perimetrul × fiecare limită INTERNĂ de bandă
 *   contur de gol      ← perimetrul fiecărei ferestre și uși din anvelopă
 *
 * Ultimele două sunt fix cele două pe care le-ai numit: „materialele pe
 * verticală" sunt limitele de bandă (`shell_zones`), „dintre etaje" sunt
 * racordurile de planșeu. Amândouă sunt numărabile, nu estimabile: știm câte
 * niveluri sunt și unde se rup benzile.
 *
 * DE CE CONTEAZĂ
 * --------------
 * Punțile sunt tipic 10–30% din pierderile prin anvelopă. Un calcul care le
 * ignoră nu e „aproximativ", e sistematic optimist — și exact în direcția în
 * care un simulator de cost te împinge oricum (izolație mai subțire).
 *
 * CE NU FACE
 * ----------
 * Nu calculează ψ. ψ vine dintr-un catalog de valori uzuale de proiectare
 * (`PSI`), fiindcă determinarea lui reală cere un calcul de câmp termic 2D pe
 * detaliul de execuție — care nu e desenat nicăieri în model și nici n-ar avea
 * de unde. Ce face modulul ăsta e partea pe care geometria chiar o știe:
 * LUNGIMILE. Ele sunt exacte; ψ e o convenție, declarată și înlocuibilă.
 *
 * Pur: fără store, fără React.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { shellRegion, shellRole } from '@/lib/shell/region';
import { heightZonesOf } from '@/lib/zones/heightZones';
import { DEFAULT_ENERGY_CONFIG, DEFAULT_PSI, type EnergyConfig } from './config';

/** Felurile de punte pe care geometria le poate număra singură. */
export type BridgeKind =
  | 'corner_convex'
  | 'corner_concave'
  | 'ground'
  | 'roof'
  | 'storey_slab'
  | 'layer_change'
  | 'opening';

export const BRIDGE_LABELS: Record<BridgeKind, string> = {
  corner_convex: 'Colț ieșind',
  corner_concave: 'Colț intrând',
  ground: 'Racord cu terenul',
  roof: 'Racord cu acoperișul',
  storey_slab: 'Planșeu intermediar',
  layer_change: 'Schimbare de strat pe verticală',
  opening: 'Contur de gol',
};

/** ψ-urile implicite. Cele în vigoare vin din `EnergyConfig` — vezi `config.ts`. */
export { DEFAULT_PSI as PSI } from './config';

export interface LinearBridge {
  kind: BridgeKind;
  /** Lungimea totală a traseului, m — asta o știe geometria exact. */
  lengthM: number;
  /** ψ folosit, W/mK. */
  psi: number;
  /** ψ × lungime, W/K. */
  wPerK: number;
  /** Ce s-a numărat, pentru memoriul de calcul: „8 colțuri × 5.60 m". */
  detail: string;
}

const R2 = (n: number) => Math.round(n * 100) / 100;

const makeBridge = (psiTable: Record<BridgeKind, number>) =>
  (kind: BridgeKind, lengthM: number, detail: string): LinearBridge => {
    const psi = psiTable[kind] ?? DEFAULT_PSI[kind];
    return { kind, lengthM: R2(lengthM), psi, wPerK: R2(lengthM * psi), detail };
  };

/**
 * Unghiul interior la vârful `i` al poligonului. Peste 180° = colț intrând.
 *
 * Se măsoară pe orientarea reală a poligonului, ca un contur scris în sens
 * orar să nu raporteze toate colțurile pe dos.
 */
function isConvexVertex(poly: { x: number; y: number }[], i: number, ccw: boolean): boolean {
  const n = poly.length;
  const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
  const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  return ccw ? cross > 0 : cross < 0;
}

/** Aria cu semn × 2 — pozitiv = sens trigonometric. */
function signedArea2(poly: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return a;
}

/** Un vârf care continuă drept nu e colț — nu e nimic de punte acolo. */
function isCollinear(poly: { x: number; y: number }[], i: number): boolean {
  const n = poly.length;
  const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
  const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  const scale = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y);
  return scale > 0 && Math.abs(cross) / scale < 1e-3;
}

export interface BridgeInput {
  /** Nodul shell cu rol de anvelopă. */
  shell: BubbleGraphNode;
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  nodeMap?: Map<string, BubbleGraphNode>;
  /** Câte niveluri stau unul peste altul în anvelopă. Sub 1 se tratează ca 1. */
  storeyCount?: number;
  /** Înălțimea totală a anvelopei, m. Implicit înălțimea shell-ului. */
  totalHeightM?: number;
  /** Perimetrul golurilor din anvelopă, m — vezi `openingPerimeterM`. */
  openingPerimeterM?: number;
  /** Convențiile în vigoare; implicit cele de demo. */
  config?: EnergyConfig;
}

/** Perimetrul tuturor golurilor din pereții exteriori — conturul de buiandrug + glafuri + spaleți. */
export function openingPerimeterM(nodes: BubbleGraphNode[], exteriorWallIds: Set<string>, edges: BubbleGraphEdge[]): number {
  const hostOf = new Map<string, string>();
  for (const e of edges) {
    const a = nodes.find((n) => n.id === e.from);
    const b = nodes.find((n) => n.id === e.to);
    if (a && b) {
      if ((a.type === 'window' || a.type === 'door') && b.type === 'wall') hostOf.set(a.id, b.id);
      if ((b.type === 'window' || b.type === 'door') && a.type === 'wall') hostOf.set(b.id, a.id);
    }
  }
  let total = 0;
  for (const n of nodes) {
    if (n.type !== 'window' && n.type !== 'door') continue;
    const host = hostOf.get(n.id);
    if (!host || !exteriorWallIds.has(host)) continue;
    const w = Number(n.properties?.width ?? 0) / 1000;
    const h = Number(n.properties?.height ?? 0) / 1000;
    if (w > 0 && h > 0) total += 2 * (w + h);
  }
  return total;
}

/**
 * Toate punțile liniare pe care conturul le implică.
 *
 * Gol când shell-ul nu e anvelopă sau nu are contur: nu inventăm punți pentru o
 * clădire pe care n-o putem descrie.
 */
export function linearBridges(input: BridgeInput): LinearBridge[] {
  const { shell, nodes, edges } = input;
  if (shellRole(shell) !== 'envelope') return [];
  const map = input.nodeMap ?? new Map(nodes.map((n) => [n.id, n]));
  const region = shellRegion(shell, nodes, edges, map);
  if (!region) return [];

  const poly = region.outer;
  const perimeterM = region.outerPerimeterM;
  const storeys = Math.max(1, Math.round(input.storeyCount ?? 1));
  const heightM = input.totalHeightM ?? region.heightM * storeys;
  const bridge = makeBridge((input.config ?? DEFAULT_ENERGY_CONFIG).psi);
  const out: LinearBridge[] = [];

  // ── Colțurile: fiecare vârf al conturului, pe toată înălțimea clădirii ──
  const ccw = signedArea2(poly) > 0;
  let convex = 0;
  let concave = 0;
  for (let i = 0; i < poly.length; i++) {
    if (isCollinear(poly, i)) continue;
    if (isConvexVertex(poly, i, ccw)) convex++; else concave++;
  }
  if (convex > 0) out.push(bridge('corner_convex', convex * heightM, `${convex} colțuri × ${heightM.toFixed(2)} m`));
  if (concave > 0) out.push(bridge('corner_concave', concave * heightM, `${concave} colțuri × ${heightM.toFixed(2)} m`));

  // ── Racordurile orizontale: perimetrul, o dată de fiecare ──
  out.push(bridge('ground', perimeterM, `perimetru ${perimeterM.toFixed(2)} m`));
  out.push(bridge('roof', perimeterM, `perimetru ${perimeterM.toFixed(2)} m`));

  // ── „Dintre etaje": un racord de planșeu la fiecare rost dintre niveluri ──
  if (storeys > 1) {
    const junctions = storeys - 1;
    out.push(bridge('storey_slab', junctions * perimeterM,
      `${junctions} planșee × ${perimeterM.toFixed(2)} m`));
  }

  // ── „Materialele pe verticală": fiecare limită INTERNĂ de bandă ──
  // Limita de jos e racordul cu terenul și cea de sus e cel cu acoperișul; sunt
  // deja numărate mai sus, deci aici intră doar rupturile dinăuntru — altfel
  // soclul s-ar decontat de două ori.
  const zones = heightZonesOf(shell, region.heightM);
  const internalBreaks = zones ? zones.length - 1 : 0;
  if (internalBreaks > 0) {
    const count = internalBreaks * storeys;
    out.push(bridge('layer_change', count * perimeterM,
      `${count} limite de bandă × ${perimeterM.toFixed(2)} m`));
  }

  // ── Conturul golurilor ──
  const opM = input.openingPerimeterM ?? 0;
  if (opM > 0) out.push(bridge('opening', opM, `contur goluri ${opM.toFixed(2)} m`));

  return out;
}

/** Σ ψ×L, W/K — cât adaugă punțile la coeficientul de pierdere. */
export const bridgeWPerK = (bridges: LinearBridge[]): number =>
  R2(bridges.reduce((s, b) => s + b.wPerK, 0));
