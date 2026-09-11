/**
 * cltPanels.ts — a cross-laminated-timber wall as the panels it is cut from,
 * derived from the wall's length, height and openings.
 *
 * ## Why derive
 *
 * Nobody draws CLT panels one by one; the factory cuts them from the wall
 * elevation. So — like the studs in `wallFraming.ts` — the panelisation is
 * computed on demand from the same inputs the takeoff and the 3D viewer
 * already have, and never stored as nodes.
 *
 * ## Layout rule
 *
 * A wall is one panel up to the transport length; longer walls are split into
 * equal pieces, a split never landing inside an opening (it moves to the
 * nearest jamb). Every panel keeps its openings cut out. What the norms
 * consume:
 *
 *   panels      — how many pieces the crane lifts
 *   gross area  — what the factory invoices (the blank, before cutting)
 *   net area    — the wall face after openings (lining, insulation)
 *   cut length  — panel perimeter + opening perimeters (CNC machining)
 *   joint length— the base joint (panel on floor) + vertical panel-to-panel joints
 *   connectors  — angle brackets on the base joint, hold-downs at panel ends
 *                 and opening jambs
 *
 * Coordinates are wall-local mm, like the framing module. Pure.
 */
import type { FramingOpening } from './wallFraming';

export interface CltPanel {
  x0Mm: number;
  x1Mm: number;
  grossAreaM2: number;
  netAreaM2: number;
  openingCount: number;
}

export interface CltPanelInput {
  lengthMm: number;
  heightMm: number;
  thicknessMm: number;
  openings: FramingOpening[];
  /** Longest panel the transport allows. */
  maxPanelLengthMm?: number;
}

export interface CltPanelisation {
  panels: CltPanel[];
  panelCount: number;
  grossAreaM2: number;
  netAreaM2: number;
  /** Gross panel volume — what is bought. */
  volumeM3: number;
  cutLengthM: number;
  jointLengthM: number;
  bracketCount: number;
  holdDownCount: number;
}

export const DEFAULT_MAX_PANEL_LENGTH_MM = 12000;
/** One angle bracket per metre of base joint, at least two per panel. */
export const BRACKET_SPACING_MM = 1000;

const EMPTY: CltPanelisation = {
  panels: [], panelCount: 0, grossAreaM2: 0, netAreaM2: 0, volumeM3: 0,
  cutLengthM: 0, jointLengthM: 0, bracketCount: 0, holdDownCount: 0,
};

/** Move a split out of any opening it falls into, to the nearer jamb. */
function clearOfOpenings(x: number, ops: { x0: number; x1: number }[]): number {
  for (const o of ops) {
    if (x > o.x0 + 1 && x < o.x1 - 1) return x - o.x0 < o.x1 - x ? o.x0 : o.x1;
  }
  return x;
}

export function computeCltPanels(input: CltPanelInput): CltPanelisation {
  const L = Math.max(0, input.lengthMm);
  const H = Math.max(0, input.heightMm);
  if (L < 1 || H < 1) return EMPTY;
  const maxLen = Math.max(1000, input.maxPanelLengthMm ?? DEFAULT_MAX_PANEL_LENGTH_MM);

  const ops = input.openings
    .map((o) => ({
      x0: Math.max(0, o.x0Mm),
      x1: Math.min(L, o.x0Mm + o.widthMm),
      sill: Math.max(0, o.sillMm),
      top: Math.min(H, o.sillMm + o.heightMm),
    }))
    .filter((o) => o.x1 - o.x0 > 1 && o.top - o.sill > 1)
    .sort((a, b) => a.x0 - b.x0);

  // Split points: equal pieces, nudged off openings, de-duplicated.
  const pieces = Math.max(1, Math.ceil(L / maxLen));
  const cuts: number[] = [0];
  for (let i = 1; i < pieces; i++) {
    const x = clearOfOpenings((L * i) / pieces, ops);
    if (x - cuts[cuts.length - 1] > 1 && L - x > 1) cuts.push(x);
  }
  cuts.push(L);

  const panels: CltPanel[] = [];
  let cutLengthMm = 0;
  let holdDowns = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const x0 = cuts[i], x1 = cuts[i + 1];
    const w = x1 - x0;
    let openingArea = 0;
    let openingCount = 0;
    for (const o of ops) {
      const ox0 = Math.max(o.x0, x0), ox1 = Math.min(o.x1, x1);
      if (ox1 - ox0 <= 1) continue;
      openingArea += (ox1 - ox0) * (o.top - o.sill);
      openingCount++;
      // CNC runs the opening outline; a jamb on the panel edge is a panel edge already.
      cutLengthMm += 2 * (ox1 - ox0)
        + (ox0 > x0 + 1 ? o.top - o.sill : 0)
        + (ox1 < x1 - 1 ? o.top - o.sill : 0);
      holdDowns += 2;
    }
    cutLengthMm += 2 * (w + H);
    holdDowns += 2;
    panels.push({
      x0Mm: x0, x1Mm: x1,
      grossAreaM2: (w * H) / 1e6,
      netAreaM2: Math.max(0, w * H - openingArea) / 1e6,
      openingCount,
    });
  }

  const grossAreaM2 = panels.reduce((s, p) => s + p.grossAreaM2, 0);
  const netAreaM2 = panels.reduce((s, p) => s + p.netAreaM2, 0);
  const jointLengthMm = L + (panels.length - 1) * H;
  const brackets = panels.reduce(
    (s, p) => s + Math.max(2, Math.ceil((p.x1Mm - p.x0Mm) / BRACKET_SPACING_MM) + 1), 0,
  );

  return {
    panels,
    panelCount: panels.length,
    grossAreaM2,
    netAreaM2,
    volumeM3: grossAreaM2 * (Math.max(0, input.thicknessMm) / 1000),
    cutLengthM: cutLengthMm / 1000,
    jointLengthM: jointLengthMm / 1000,
    bracketCount: brackets,
    holdDownCount: holdDowns,
  };
}

/** True when this wall type is a CLT panel — the library id, not the material string. */
export const isCltWallType = (wallType: unknown): boolean => /^CLT/i.test(String(wallType ?? ''));
