import {
  type Vector2,
  aduna,
  distanta,
  inmulteste,
  produsScalar,
  scade,
} from "../geometrie/vector";
import type { GeometrieDxf, SubstratImport } from "../dxf/importDxf";

/** Felul punctului de snap găsit (pentru feedback vizual). */
export type FelSnap = "capat" | "mijloc" | "pe-linie" | "grila";

function midpt(a: Vector2, b: Vector2): Vector2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export interface PunctSnap {
  punct: Vector2;
  fel: FelSnap;
}

export interface SegmentSnap {
  a: Vector2;
  b: Vector2;
}

export interface RezultatSnap {
  /** Punctul-țintă pe care s-a făcut snap. */
  tinta: Vector2;
  /** Translația de aplicat poziției formei (țintă − sursă). */
  delta: Vector2;
  fel: FelSnap;
}

/** Extrage punctele de snap (capete + mijloace de linii, vârfuri + mijloace de polilinii, capete de arce). */
export function puncteSnapSubstrat(s: SubstratImport): Vector2[] {
  const puncte: Vector2[] = [];
  for (const e of s.entitati) {
    if (e.tip === "linie") {
      puncte.push(e.p1, e.p2, midpt(e.p1, e.p2));
    } else if (e.tip === "polilinie") {
      for (let i = 0; i < e.puncte.length; i++) {
        puncte.push(e.puncte[i]!);
        if (i + 1 < e.puncte.length) puncte.push(midpt(e.puncte[i]!, e.puncte[i + 1]!));
      }
      if (e.inchis && e.puncte.length > 1) {
        puncte.push(midpt(e.puncte[e.puncte.length - 1]!, e.puncte[0]!));
      }
    } else if (e.tip === "arc") {
      const r = e.raza;
      const a0 = (e.unghiStartGrade * Math.PI) / 180;
      const a1 = (e.unghiSfarsitGrade * Math.PI) / 180;
      puncte.push(
        { x: e.centru.x + r * Math.cos(a0), y: e.centru.y + r * Math.sin(a0) },
        { x: e.centru.x + r * Math.cos(a1), y: e.centru.y + r * Math.sin(a1) },
      );
    }
  }
  return puncte;
}

/** Extrage segmentele de snap (linii + laturile poliliniilor) pentru proiecție. */
export function segmenteSnapSubstrat(s: SubstratImport): SegmentSnap[] {
  const segmente: SegmentSnap[] = [];
  for (const e of s.entitati) {
    if (e.tip === "linie") {
      segmente.push({ a: e.p1, b: e.p2 });
    } else if (e.tip === "polilinie") {
      for (let i = 0; i < e.puncte.length - 1; i++) {
        segmente.push({ a: e.puncte[i]!, b: e.puncte[i + 1]! });
      }
      if (e.inchis && e.puncte.length > 2) {
        segmente.push({ a: e.puncte[e.puncte.length - 1]!, b: e.puncte[0]! });
      }
    }
  }
  return segmente;
}

/** Extrage punctele de snap (capete + mijloace) dintr-o geometrie DXF în coordonate absolute. */
export function puncteSnapGeometrieDxf(geom: GeometrieDxf): Vector2[] {
  const puncte: Vector2[] = [];
  for (const e of geom.entitati) {
    if (e.layer && !geom.layereVizibile.includes(e.layer)) continue;
    if (e.tip === "linie") {
      puncte.push(e.p1, e.p2, midpt(e.p1, e.p2));
    } else if (e.tip === "polilinie") {
      for (let i = 0; i < e.puncte.length; i++) {
        puncte.push(e.puncte[i]!);
        if (i + 1 < e.puncte.length) puncte.push(midpt(e.puncte[i]!, e.puncte[i + 1]!));
      }
      if (e.inchis && e.puncte.length > 1) {
        puncte.push(midpt(e.puncte[e.puncte.length - 1]!, e.puncte[0]!));
      }
    } else if (e.tip === "arc") {
      const r = e.raza;
      const a0 = (e.unghiStartGrade * Math.PI) / 180;
      const a1 = (e.unghiSfarsitGrade * Math.PI) / 180;
      puncte.push(
        { x: e.centru.x + r * Math.cos(a0), y: e.centru.y + r * Math.sin(a0) },
        { x: e.centru.x + r * Math.cos(a1), y: e.centru.y + r * Math.sin(a1) },
      );
    }
  }
  return puncte;
}

/** Extrage segmentele de snap dintr-o geometrie DXF în coordonate absolute. */
export function segmenteSnapGeometrieDxf(geom: GeometrieDxf): SegmentSnap[] {
  const segmente: SegmentSnap[] = [];
  for (const e of geom.entitati) {
    if (e.layer && !geom.layereVizibile.includes(e.layer)) continue;
    if (e.tip === "linie") {
      segmente.push({ a: e.p1, b: e.p2 });
    } else if (e.tip === "polilinie") {
      for (let i = 0; i < e.puncte.length - 1; i++) {
        segmente.push({ a: e.puncte[i]!, b: e.puncte[i + 1]! });
      }
      if (e.inchis && e.puncte.length > 2) {
        segmente.push({ a: e.puncte[e.puncte.length - 1]!, b: e.puncte[0]! });
      }
    }
  }
  return segmente;
}

/** Cel mai apropiat punct de pe un segment față de `p`. */
export function proiectiePeSegment(p: Vector2, a: Vector2, b: Vector2): Vector2 {
  const ab = scade(b, a);
  const lungPatrat = produsScalar(ab, ab);
  if (lungPatrat < 1e-9) return a;
  let t = produsScalar(scade(p, a), ab) / lungPatrat;
  t = Math.max(0, Math.min(1, t));
  return aduna(a, inmulteste(ab, t));
}

/**
 * Caută cel mai bun snap pentru un set de puncte-sursă (punctele de referință
 * ale formei, în coordonate-lume). Capetele/​vârfurile au prioritate față de
 * proiecția pe linie. Întoarce translația de aplicat poziției formei.
 */
export function gasesteSnap(
  surse: Vector2[],
  puncte: Vector2[],
  segmente: SegmentSnap[],
  toleranta: number,
): RezultatSnap | null {
  let cel: RezultatSnap | null = null;
  let celDist = toleranta;

  // 1) Snap la puncte (capete/vârfuri) — prioritar.
  for (const s of surse) {
    for (const t of puncte) {
      const d = distanta(s, t);
      if (d < celDist) {
        celDist = d;
        cel = { tinta: t, delta: scade(t, s), fel: "capat" };
      }
    }
  }
  if (cel) return cel;

  // 2) Snap pe linie (proiecție) — secundar.
  for (const s of surse) {
    for (const seg of segmente) {
      const proj = proiectiePeSegment(s, seg.a, seg.b);
      const d = distanta(s, proj);
      if (d < celDist) {
        celDist = d;
        cel = { tinta: proj, delta: scade(proj, s), fel: "pe-linie" };
      }
    }
  }
  return cel;
}
