import { type Vector2, aduna, inmulteste, distanta, grade, radiani } from "../geometrie/vector";
import {
  formeDinCaleArray,
  lungimeCaleArray,
  normalaCaleArray,
  offsetLinieCotaCaleArray,
  textEtichetaCaleArray,
  type CaleArray,
} from "../array-path/arrayPath";
import { cercForma, segmenteForma, definitiePentru, pozitiiArray } from "../forme/catalog";
import { coteGabarit, type CotaLiniara } from "../cote/cote";
import type { FormaArmare, Segment, TipForma, EtichetaBara, Hasura, CotaElevatie, SimbolSectiune } from "../model/tipuri";
import { geometrieCotaElevatie } from "../elevatie/geometrie";
import { grupuriNivelElevatie } from "../elevatie/niveluri";
import { textEtichetaBara } from "../label/etichetaBara";
import type { Adnotatie, CotaLibera, LinieAxa, Stalp, Dreptunghi } from "../model/cofraj";
import type { GeometrieDxf } from "./importDxf";

/**
 * Generator de fișiere DXF ASCII R2000 (AC1015). Fără dependențe externe —
 * rulează identic în browser, Node sau Tauri.
 *
 * Față de R12 adaugă: entități HATCH (hașuri vectoriale reale), MTEXT
 * (text multi-linie), handles unice pe toate entitățile, subclass markers
 * (cod 100) și secțiunile CLASSES/BLOCKS/OBJECTS cerute de standard.
 */

// ── Layere standard ────────────────────────────────────────────────────────────
const LAYERE = {
  bare: "Bare_Longitudinale",
  etrieri: "Etrieri",
  cofraj: "Cofraj",
  cote: "Cote",
  adnotatii: "Adnotatii",
  axe: "Axe_Structurale",
} as const;

function layerPentruTip(tip: TipForma): string {
  if (tip === "etrier" || tip === "etrier-lateral") return LAYERE.etrieri;
  if (definitiePentru(tip).categorie === "cofraj") return LAYERE.cofraj;
  return LAYERE.bare;
}

function deplaseazaSegment(seg: Segment, offset: Vector2): Segment {
  if (seg.tip === "linie") {
    return { tip: "linie", start: aduna(seg.start, offset), sfarsit: aduna(seg.sfarsit, offset) };
  }
  return { ...seg, centru: aduna(seg.centru, offset) };
}

// ── Handle counter (reset la fiecare export) ───────────────────────────────────
let _h = 0;
function resetHandles(): void { _h = 0x10; }
function nextH(): string { return (_h++).toString(16).toUpperCase(); }

// ── Primitive DXF ──────────────────────────────────────────────────────────────
function p(cod: number, val: string | number): string {
  return `${cod}\n${val}\n`;
}

function normalizeazaGrade(g: number): number {
  let v = g % 360;
  if (v < 0) v += 360;
  return v;
}

// ── Entități primare R2000 (handle + subclass markers) ─────────────────────────

function entitateSegment(seg: Segment, layer: string): string {
  if (seg.tip === "linie") {
    return (
      p(0, "LINE") + p(5, nextH()) +
      p(100, "AcDbEntity") + p(8, layer) +
      p(100, "AcDbLine") +
      p(10, seg.start.x) + p(20, seg.start.y) + p(30, 0) +
      p(11, seg.sfarsit.x) + p(21, seg.sfarsit.y) + p(31, 0)
    );
  }
  const start = seg.sensOrar ? seg.unghiSfarsit : seg.unghiStart;
  const sfarsit = seg.sensOrar ? seg.unghiStart : seg.unghiSfarsit;
  return (
    p(0, "ARC") + p(5, nextH()) +
    p(100, "AcDbEntity") + p(8, layer) +
    p(100, "AcDbCircle") +
    p(10, seg.centru.x) + p(20, seg.centru.y) + p(30, 0) +
    p(40, seg.raza) +
    p(100, "AcDbArc") +
    p(50, normalizeazaGrade(grade(start))) +
    p(51, normalizeazaGrade(grade(sfarsit)))
  );
}

function entitateCerc(centru: Vector2, raza: number, layer: string): string {
  return (
    p(0, "CIRCLE") + p(5, nextH()) +
    p(100, "AcDbEntity") + p(8, layer) +
    p(100, "AcDbCircle") +
    p(10, centru.x) + p(20, centru.y) + p(30, 0) +
    p(40, raza)
  );
}

function entitateText(pozitie: Vector2, text: string, inaltime: number, layer: string): string {
  return (
    p(0, "TEXT") + p(5, nextH()) +
    p(100, "AcDbEntity") + p(8, layer) +
    p(100, "AcDbText") +
    p(10, pozitie.x) + p(20, pozitie.y) + p(30, 0) +
    p(40, inaltime) + p(1, text)
  );
}

/** MTEXT — text multi-linie R2000. Foloseşte \P ca separator de paragraf. */
function entitateMText(pozitie: Vector2, text: string, inaltime: number, layer: string): string {
  return (
    p(0, "MTEXT") + p(5, nextH()) +
    p(100, "AcDbEntity") + p(8, layer) +
    p(100, "AcDbMText") +
    p(10, pozitie.x) + p(20, pozitie.y) + p(30, 0) +
    p(40, inaltime) +
    p(41, inaltime * 25) + // lăţime referinţă coloană
    p(71, 1) +             // ancorare: stânga-sus
    p(1, text) +
    p(7, "Standard")       // stil text
  );
}

/**
 * Entitate HATCH R2000 cu limită tip edge (linie) şi pattern user-defined.
 * @param unghiuriGrade Unghiurile liniilor de hașură (ex. [45] sau [45, 135]).
 * @param pas           Distanța între linii (mm).
 */
function hatchBoundary(contur: Vector2[]): string {
  const n = contur.length;
  let s = "";
  s += p(91, 1);
  s += p(92, 1);   // external boundary, edge-based
  s += p(93, n);
  for (let i = 0; i < n; i++) {
    const a = contur[i]!;
    const b = contur[(i + 1) % n]!;
    s += p(72, 1); // edge tip: LINE
    s += p(10, +a.x.toFixed(6)) + p(20, +a.y.toFixed(6));
    s += p(11, +b.x.toFixed(6)) + p(21, +b.y.toFixed(6));
  }
  s += p(97, 0);
  return s;
}

function hatchHeader(layer: string, solid: boolean): string {
  let s = "";
  s += p(0, "HATCH") + p(5, nextH());
  s += p(100, "AcDbEntity") + p(8, layer);
  s += p(100, "AcDbHatch");
  s += p(10, 0) + p(20, 0) + p(30, 0);
  s += p(210, 0) + p(220, 0) + p(230, 1);
  s += p(2, solid ? "SOLID" : "");
  s += p(70, solid ? 1 : 0);
  s += p(71, 0);
  return s;
}

function entitateHatch(
  contur: Vector2[],
  unghiuriGrade: number[],
  pas: number,
  layer: string,
): string {
  if (contur.length < 3 || pas <= 0) return "";

  let s = hatchHeader(layer, false);
  s += hatchBoundary(contur);
  s += p(75, 0);
  s += p(76, 0);   // user-defined pattern
  s += p(52, 0);
  s += p(41, 1);
  s += p(77, 0);
  s += p(78, unghiuriGrade.length);
  for (const ang of unghiuriGrade) {
    const angRad = radiani(ang);
    const dx = +(-pas * Math.sin(angRad)).toFixed(6);
    const dy = +(pas * Math.cos(angRad)).toFixed(6);
    s += p(53, ang);
    s += p(43, 0) + p(44, 0);
    s += p(45, dx) + p(46, dy);
    s += p(79, 0);
  }
  return s;
}

function entitateHatchSolid(contur: Vector2[], layer: string): string {
  if (contur.length < 3) return "";
  let s = hatchHeader(layer, true);
  s += hatchBoundary(contur);
  s += p(75, 0);
  s += p(76, 1);   // solid
  s += p(52, 0) + p(41, 1) + p(77, 0);
  s += p(78, 0);   // no line defs for solid
  return s;
}

// ── Cotare ─────────────────────────────────────────────────────────────────────

function entitatiCota(cota: CotaLiniara, offset: Vector2): string {
  const p1 = aduna(cota.p1, offset);
  const p2 = aduna(cota.p2, offset);
  let linie: Segment;
  let pozitieText: Vector2;

  if (cota.orientare === "orizontala") {
    const y = Math.min(p1.y, p2.y) - cota.offset;
    linie = { tip: "linie", start: { x: p1.x, y }, sfarsit: { x: p2.x, y } };
    pozitieText = { x: (p1.x + p2.x) / 2, y: y + 5 };
  } else {
    const x = Math.max(p1.x, p2.x) + cota.offset;
    linie = { tip: "linie", start: { x, y: p1.y }, sfarsit: { x, y: p2.y } };
    pozitieText = { x: x + 5, y: (p1.y + p2.y) / 2 };
  }

  return (
    entitateSegment(linie, LAYERE.cote) +
    entitateText(pozitieText, cota.text, 14, LAYERE.cote)
  );
}

function entitatiCotaCaleArray(cale: CaleArray): string {
  const p1 = cale.start;
  const p2 = cale.sfarsit;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return "";

  const { nx, ny } = normalaCaleArray(cale);
  const n: Vector2 = { x: nx, y: ny };
  const offset = offsetLinieCotaCaleArray(cale);
  const semn = offset >= 0 ? 1 : -1;
  const OVERHANG = 12;
  const layer = LAYERE.cote;

  const L1 = aduna(p1, inmulteste(n, offset));
  const L2 = aduna(p2, inmulteste(n, offset));
  const E1e = aduna(p1, inmulteste(n, offset + semn * OVERHANG));
  const E2e = aduna(p2, inmulteste(n, offset + semn * OVERHANG));
  const dimMid: Vector2 = { x: (L1.x + L2.x) / 2, y: (L1.y + L2.y) / 2 };
  const outerSign = offset >= 0 ? 1 : -1;
  const textOff = 18;

  let ent =
    entitateSegment({ tip: "linie", start: p1, sfarsit: E1e }, layer) +
    entitateSegment({ tip: "linie", start: p2, sfarsit: E2e }, layer) +
    entitateSegment({ tip: "linie", start: L1, sfarsit: L2 }, layer);

  if (cale.afiseazaEticheta ?? true) {
    const label = `${cale.marca} ${textEtichetaCaleArray(cale)}`.trim();
    ent += entitateText(
      { x: dimMid.x + n.x * outerSign * textOff, y: dimMid.y + n.y * outerSign * textOff },
      label, 14, layer,
    );
  }
  if (cale.afiseazaLungimeCota ?? true) {
    const lenPos = (cale.afiseazaEticheta ?? true)
      ? { x: dimMid.x - n.x * outerSign * textOff, y: dimMid.y - n.y * outerSign * textOff }
      : dimMid;
    ent += entitateText(lenPos, `${Math.round(lungimeCaleArray(cale))}`, 14, layer);
  }
  return ent;
}

function entitatiCotaLibera(cota: CotaLibera): string {
  const { p1, p2, offset } = cota;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return "";

  const d = { x: dx / len, y: dy / len };
  const n = { x: -d.y, y: d.x };
  const semn = offset >= 0 ? 1 : -1;
  const OVERHANG = 12;

  const L1 = aduna(p1, inmulteste(n, offset));
  const L2 = aduna(p2, inmulteste(n, offset));
  const E1e = aduna(p1, inmulteste(n, offset + semn * OVERHANG));
  const E2e = aduna(p2, inmulteste(n, offset + semn * OVERHANG));
  const mid: Vector2 = { x: (L1.x + L2.x) / 2 + n.x * 8, y: (L1.y + L2.y) / 2 + n.y * 8 };
  const textLabel = cota.text ?? `${Math.round(distanta(p1, p2))}`;

  const layer = LAYERE.adnotatii;
  return (
    entitateSegment({ tip: "linie", start: p1, sfarsit: E1e }, layer) +
    entitateSegment({ tip: "linie", start: p2, sfarsit: E2e }, layer) +
    entitateSegment({ tip: "linie", start: L1, sfarsit: L2 }, layer) +
    entitateText(mid, textLabel, 14, layer)
  );
}

// ── Entități pentru elementele planșei ────────────────────────────────────────

function entitatiLinieAxa(axa: LinieAxa): string {
  const layer = LAYERE.axe;
  let ent = entitateSegment({ tip: "linie", start: axa.start, sfarsit: axa.sfarsit }, layer);

  if (axa.afiseazaLabelStart ?? true) {
    ent += entitateCerc(axa.start, axa.razaCerc, layer);
    ent += entitateText(
      { x: axa.start.x - axa.razaCerc * 0.35, y: axa.start.y - axa.razaCerc * 0.45 },
      axa.etichetaStart ?? axa.eticheta,
      axa.razaCerc * 0.8, layer,
    );
  }
  if (axa.afiseazaLabelSfarsit ?? true) {
    ent += entitateCerc(axa.sfarsit, axa.razaCerc, layer);
    ent += entitateText(
      { x: axa.sfarsit.x - axa.razaCerc * 0.35, y: axa.sfarsit.y - axa.razaCerc * 0.45 },
      axa.etichetaSfarsit ?? axa.eticheta,
      axa.razaCerc * 0.8, layer,
    );
  }
  return ent;
}

function entitatiStalp(stalp: Stalp): string {
  const layer = LAYERE.cofraj;
  const { pozitie, latime, inaltime, rotatie, pasHasura } = stalp;
  const ang = radiani(rotatie);
  const cosR = Math.cos(ang);
  const sinR = Math.sin(ang);
  const rotPt = (dx: number, dy: number): Vector2 => ({
    x: pozitie.x + cosR * dx - sinR * dy,
    y: pozitie.y + sinR * dx + cosR * dy,
  });

  const hw = latime / 2;
  const hh = inaltime / 2;
  const colturi: Vector2[] = [rotPt(-hw, -hh), rotPt(hw, -hh), rotPt(hw, hh), rotPt(-hw, hh)];

  let ent = "";
  for (let i = 0; i < 4; i++) {
    ent += entitateSegment({ tip: "linie", start: colturi[i]!, sfarsit: colturi[(i + 1) % 4]! }, layer);
  }
  // HATCH cu hașură diagonală dublă (beton armat) — rotit cu unghiul stâlpului
  ent += entitateHatch(colturi, [45 + rotatie, 135 + rotatie], pasHasura, layer);
  return ent;
}

function entitatiDreptunghi(d: Dreptunghi): string {
  const layer = LAYERE.adnotatii;
  const { pozitie, latime, inaltime, rotatie } = d;
  const ang = radiani(rotatie);
  const cosR = Math.cos(ang);
  const sinR = Math.sin(ang);
  const rotPt = (dx: number, dy: number): Vector2 => ({
    x: pozitie.x + cosR * dx - sinR * dy,
    y: pozitie.y + sinR * dx + cosR * dy,
  });
  const hw = latime / 2;
  const hh = inaltime / 2;
  const colturi: Vector2[] = [rotPt(-hw, -hh), rotPt(hw, -hh), rotPt(hw, hh), rotPt(-hw, hh)];
  let ent = "";
  for (let i = 0; i < 4; i++) {
    ent += entitateSegment({ tip: "linie", start: colturi[i]!, sfarsit: colturi[(i + 1) % 4]! }, layer);
  }
  return ent;
}

function entitatiHasura(hasura: Hasura): string {
  const layer = LAYERE.cofraj;
  const c = hasura.contur;
  if (c.length < 3) return "";

  // Contur
  let ent = "";
  for (let i = 0; i < c.length; i++) {
    ent += entitateSegment({ tip: "linie", start: c[i]!, sfarsit: c[(i + 1) % c.length]! }, layer);
  }

  switch (hasura.tipHasura) {
    case "solid":
      ent += entitateHatchSolid(c, layer);
      break;
    case "linii":
      ent += entitateHatch(c, [hasura.unghi], hasura.pas, layer);
      break;
    case "linii-incrucisate":
      ent += entitateHatch(c, [hasura.unghi, hasura.unghi + 90], hasura.pas, layer);
      break;
    case "beton":
      // linii diagonale + crosshatch dens pentru agregat
      ent += entitateHatch(c, [45], hasura.pas, layer);
      ent += entitateHatch(c, [45, 135], hasura.pas * 1.41, layer);
      break;
    case "metal":
      ent += entitateHatch(c, [45, 135], Math.max(4, hasura.pas * 0.4), layer);
      break;
    case "lemn":
    case "pamant":
      // linii orizontale
      ent += entitateHatch(c, [0], hasura.pas, layer);
      break;
    case "puncte":
      // Aproximare rețea fină încrucișată
      ent += entitateHatch(c, [hasura.unghi, hasura.unghi + 90], hasura.pas * 0.3, layer);
      break;
  }

  return ent;
}

function entitatiEtichetaBara(
  eticheta: EtichetaBara,
  formeMap: Map<string, FormaArmare>,
): string {
  const layer = LAYERE.adnotatii;
  const forma = formeMap.get(eticheta.idForma);
  const RAZA = 20;

  let ent = "";
  ent += entitateCerc(eticheta.pozitie, RAZA, layer);
  ent += entitateText(
    { x: eticheta.pozitie.x - RAZA * 0.35, y: eticheta.pozitie.y - RAZA * 0.45 },
    forma ? `${forma.marca}` : "?",
    RAZA * 0.9, layer,
  );

  // Leader
  const buildLeader = (ref: Vector2, cot?: Vector2) => {
    if (cot) {
      ent += entitateSegment({ tip: "linie", start: ref, sfarsit: cot }, layer);
      const dir = { x: eticheta.pozitie.x - cot.x, y: eticheta.pozitie.y - cot.y };
      const l = Math.hypot(dir.x, dir.y);
      if (l > 1e-6) {
        ent += entitateSegment(
          { tip: "linie", start: cot, sfarsit: { x: eticheta.pozitie.x - (dir.x / l) * RAZA, y: eticheta.pozitie.y - (dir.y / l) * RAZA } },
          layer,
        );
      }
    } else {
      const dir = { x: eticheta.pozitie.x - ref.x, y: eticheta.pozitie.y - ref.y };
      const l = Math.hypot(dir.x, dir.y);
      if (l > 1e-6) {
        ent += entitateSegment(
          { tip: "linie", start: ref, sfarsit: { x: eticheta.pozitie.x - (dir.x / l) * RAZA, y: eticheta.pozitie.y - (dir.y / l) * RAZA } },
          layer,
        );
      }
    }
  };

  buildLeader(eticheta.punctReferinta, eticheta.cotLeader);
  for (const ls of eticheta.leaderiSuplimentari ?? []) {
    buildLeader(ls.punctReferinta, ls.cotLeader);
  }

  // Text detalii — MTEXT pentru mai multe rânduri
  if (forma) {
    const textDetalii = textEtichetaBara(eticheta, forma);
    if (textDetalii) {
      const offTx = eticheta.offsetText?.x ?? 0;
      const offTy = eticheta.offsetText?.y ?? 0;
      ent += entitateMText(
        { x: eticheta.pozitie.x - RAZA + offTx, y: eticheta.pozitie.y - RAZA - 4 + offTy },
        textDetalii, 11, layer,
      );
    }
  }

  return ent;
}

/**
 * Factor de referință pentru dimensiunile annotative (mm hârtie) la export DXF.
 * Simbolurile au mărimi în mm pe hârtie; în DXF (spațiu model 1:1) le aducem la
 * scara modelului înmulțind cu factorul scării de referință (implicit 1:50).
 */
const FACTOR_ADNOTATII_DXF = 50;

function entitatiCotaElevatie(cota: CotaElevatie, forme: FormaArmare[]): string {
  const layer = LAYERE.cote;
  const triH = (cota.inaltimeTriunghi ?? 3) * FACTOR_ADNOTATII_DXF;
  const lineExt = (cota.lungimeLinie ?? 7.5) * FACTOR_ADNOTATII_DXF;
  const baseHalf = (cota.lungimeLinieBaza ?? 4) * FACTOR_ADNOTATII_DXF;
  const { anchor, tip } = geometrieCotaElevatie(cota, forme);
  const pos = tip;
  const textLaStanga = cota.sensText === "stanga";
  const flipX = cota.oglinditX ?? false;
  const flipY = cota.oglinditY ?? false;
  const dirX = flipX ? -1 : 1;
  const dirY = flipY ? -1 : 1;
  const lineSign = (textLaStanga ? -1 : 1) * dirX;
  const rot = ((cota.rotatie ?? 0) * Math.PI) / 180;

  const rotP = (x: number, y: number): Vector2 => {
    if (rot === 0) return { x: pos.x + x, y: pos.y + y };
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    return { x: pos.x + x * c - y * s, y: pos.y + x * s + y * c };
  };

  const triW = triH / Math.sqrt(3);
  const triTopRel = flipY ? -triH : triH;
  const raftYRel = triH * dirY;
  let ent = "";
  if (Math.hypot(anchor.x - tip.x, anchor.y - tip.y) > 0.5) {
    ent += entitateSegment({ tip: "linie", start: anchor, sfarsit: tip }, layer);
  }

  const grupuri = grupuriNivelElevatie(cota);

  for (const grup of grupuri) {
    const ox = grup.offsetOrizontal * FACTOR_ADNOTATII_DXF;
    const datumLocalY = grup.isBaza
      ? -dirY * grup.distantaVerticala * FACTOR_ADNOTATII_DXF
      : -dirY * grup.distantaVerticala;
    const datum = rotP(ox, datumLocalY);
    const vL = rotP(ox - triW, datumLocalY + triTopRel);
    const vR = rotP(ox + triW, datumLocalY + triTopRel);
    ent += entitateSegment({ tip: "linie", start: datum, sfarsit: vL }, layer);
    ent += entitateSegment({ tip: "linie", start: datum, sfarsit: vR }, layer);
    ent += entitateSegment({ tip: "linie", start: vL, sfarsit: vR }, layer);

    const b1 = rotP(ox - baseHalf, datumLocalY);
    const b2 = rotP(ox + baseHalf, datumLocalY);
    ent += entitateSegment({ tip: "linie", start: b1, sfarsit: b2 }, layer);

    const shelfY = datumLocalY + raftYRel;
    const stemEnd = rotP(ox, shelfY);
    ent += entitateSegment({ tip: "linie", start: datum, sfarsit: stemEnd }, layer);

    const lineEnd = rotP(ox + lineSign * lineExt, shelfY);
    const lineStart = rotP(ox, shelfY);
    ent += entitateSegment({ tip: "linie", start: lineStart, sfarsit: lineEnd }, layer);

    const gap = 5;
    const implicitTextX = ox + (textLaStanga
      ? lineSign * lineExt - grup.label.length * 8 - gap
      : lineSign * lineExt + gap);
    const implicitTextY = shelfY + 4;
    const textLocalX = implicitTextX + (grup.offsetText?.x ?? 0) * FACTOR_ADNOTATII_DXF;
    const textLocalY = implicitTextY + (grup.offsetText?.y ?? 0) * FACTOR_ADNOTATII_DXF;
    const textPt = rotP(textLocalX, textLocalY);
    ent += entitateText({ x: textPt.x, y: textPt.y }, grup.label, 12, layer);
  }
  return ent;
}

function entitatiSimbolSectiune(simbol: SimbolSectiune): string {
  const layer = LAYERE.adnotatii;
  const { p1, p2, eticheta, directieVedere, afiseazaLinie = true } = simbol;
  const lungimeBrat = (simbol.lungimeBrat ?? 5) * FACTOR_ADNOTATII_DXF;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return "";

  const d = { x: dx / len, y: dy / len };
  const n = directieVedere === "stanga" ? { x: -d.y, y: d.x } : { x: d.y, y: -d.x };

  let ent = "";
  if (afiseazaLinie) ent += entitateSegment({ tip: "linie", start: p1, sfarsit: p2 }, layer);

  const arm1: Vector2 = { x: p1.x + n.x * lungimeBrat, y: p1.y + n.y * lungimeBrat };
  const arm2: Vector2 = { x: p2.x + n.x * lungimeBrat, y: p2.y + n.y * lungimeBrat };
  const lGap = 8;

  ent += entitateSegment({ tip: "linie", start: p1, sfarsit: arm1 }, layer);
  ent += entitateText({ x: arm1.x + n.x * lGap - 5, y: arm1.y + n.y * lGap - 7 }, eticheta, 14, layer);
  ent += entitateSegment({ tip: "linie", start: p2, sfarsit: arm2 }, layer);
  ent += entitateText({ x: arm2.x + n.x * lGap - 5, y: arm2.y + n.y * lGap - 7 }, eticheta, 14, layer);
  return ent;
}

function entitatiGeometrieDxf(geom: GeometrieDxf): string {
  let ent = "";
  const vizibile = new Set(geom.layereVizibile);

  for (const e of geom.entitati) {
    if (e.layer && !vizibile.has(e.layer)) continue;
    const layer = e.layer ?? LAYERE.cofraj;

    switch (e.tip) {
      case "linie":
        ent += entitateSegment({ tip: "linie", start: e.p1, sfarsit: e.p2 }, layer);
        break;
      case "cerc":
        ent += entitateCerc(e.centru, e.raza, layer);
        break;
      case "arc":
        ent += entitateSegment({
          tip: "arc",
          centru: e.centru, raza: e.raza,
          unghiStart: radiani(e.unghiStartGrade),
          unghiSfarsit: radiani(e.unghiSfarsitGrade),
          sensOrar: false,
        }, layer);
        break;
      case "polilinie":
        for (let i = 0; i < e.puncte.length - 1; i++)
          ent += entitateSegment({ tip: "linie", start: e.puncte[i]!, sfarsit: e.puncte[i + 1]! }, layer);
        if (e.inchis && e.puncte.length > 1)
          ent += entitateSegment({ tip: "linie", start: e.puncte[e.puncte.length - 1]!, sfarsit: e.puncte[0]! }, layer);
        break;
      case "text":
        ent += entitateText(e.pozitie, e.continut, e.inaltime, layer);
        break;
      case "hasura":
        for (const c of e.contururi)
          for (let i = 0; i < c.length; i++)
            ent += entitateSegment({ tip: "linie", start: c[i]!, sfarsit: c[(i + 1) % c.length]! }, layer);
        break;
    }
  }
  return ent;
}

// ── Forma de armare (cu expandare Array2D) ────────────────────────────────────

function entitatiForma(forma: FormaArmare, cuCote: boolean): string {
  let ent = "";
  const layer = layerPentruTip(forma.tip);
  const pozitii = pozitiiArray(forma);

  const cerc = cercForma(forma);
  if (cerc) {
    for (const pos of pozitii) ent += entitateCerc(aduna(cerc.centru, pos), cerc.raza, layer);
    return ent;
  }

  const segmente = segmenteForma(forma);
  for (const pos of pozitii) {
    for (const seg of segmente) ent += entitateSegment(deplaseazaSegment(seg, pos), layer);
  }
  if (cuCote) {
    for (const cota of coteGabarit(segmente)) ent += entitatiCota(cota, pozitii[0]!);
  }
  return ent;
}

// ── Structura fișier R2000 ─────────────────────────────────────────────────────

function sectiuneAntet(): string {
  const h = nextH(); // $HANDSEED
  return (
    p(0, "SECTION") + p(2, "HEADER") +
    p(9, "$ACADVER") + p(1, "AC1015") +
    p(9, "$DWGCODEPAGE") + p(3, "ANSI_1252") +
    p(9, "$INSUNITS") + p(70, 4) + // 4 = mm
    p(9, "$HANDSEED") + p(5, h) +
    p(0, "ENDSEC")
  );
}

function sectiuneClase(): string {
  return p(0, "SECTION") + p(2, "CLASSES") + p(0, "ENDSEC");
}

function sectiuneTabele(): string {
  // Culorile ACI per layer
  const layereDef: Array<{ nume: string; culoare: number; ltip: string }> = [
    { nume: LAYERE.bare,      culoare: 1,  ltip: "CONTINUOUS" },
    { nume: LAYERE.etrieri,   culoare: 5,  ltip: "CONTINUOUS" },
    { nume: LAYERE.cofraj,    culoare: 8,  ltip: "CONTINUOUS" },
    { nume: LAYERE.cote,      culoare: 3,  ltip: "CONTINUOUS" },
    { nume: LAYERE.adnotatii, culoare: 6,  ltip: "CONTINUOUS" },
    { nume: LAYERE.axe,       culoare: 1,  ltip: "CENTER" },
  ];

  let s = p(0, "SECTION") + p(2, "TABLES");

  // ── VPORT ──
  s += p(0, "TABLE") + p(2, "VPORT") + p(5, nextH()) + p(100, "AcDbSymbolTable") + p(70, 1);
  s += p(0, "VPORT") + p(5, nextH()) + p(100, "AcDbSymbolTableRecord") + p(100, "AcDbViewportTableRecord");
  s += p(2, "*Active") + p(70, 0);
  s += p(10, 0) + p(20, 0) + p(11, 1) + p(21, 1); // min/max screen bounds
  s += p(12, 0) + p(22, 0) + p(13, 0) + p(23, 0); // center/snap base
  s += p(14, 10) + p(24, 10) + p(15, 10) + p(25, 10); // snap/grid spacing
  s += p(16, 0) + p(26, 0) + p(36, 1); // view direction
  s += p(17, 0) + p(27, 0) + p(37, 0); // view target
  s += p(40, 1000) + p(41, 1) + p(42, 50); // height/aspect/lens
  s += p(43, 0) + p(44, 0) + p(50, 0) + p(51, 0); // clipping distances
  s += p(71, 0) + p(72, 1000) + p(73, 1) + p(74, 3) + p(75, 0) + p(76, 1) + p(77, 0) + p(78, 0);
  s += p(0, "ENDTAB");

  // ── LTYPE ──
  s += p(0, "TABLE") + p(2, "LTYPE") + p(5, nextH()) + p(100, "AcDbSymbolTable") + p(70, 4);
  for (const [numeLtip, desc, nrElemente, lungime] of [
    ["BYLAYER",    "By layer", "0", "0.0"],
    ["BYBLOCK",    "By block", "0", "0.0"],
    ["CONTINUOUS", "Solid line", "0", "0.0"],
  ] as [string, string, string, string][]) {
    s += p(0, "LTYPE") + p(5, nextH()) + p(100, "AcDbSymbolTableRecord") + p(100, "AcDbLinetypeTableRecord");
    s += p(2, numeLtip) + p(70, 0) + p(3, desc) + p(72, 65) + p(73, Number(nrElemente)) + p(40, Number(lungime));
  }
  // CENTER: _ _ _ (dash lung + gap + dash scurt + gap)
  s += p(0, "LTYPE") + p(5, nextH()) + p(100, "AcDbSymbolTableRecord") + p(100, "AcDbLinetypeTableRecord");
  s += p(2, "CENTER") + p(70, 0) + p(3, "Center _ _ _ _ _") + p(72, 65);
  s += p(73, 4) + p(40, 70.0);  // 4 elemente, lungime totală 70mm
  s += p(49, 50.0)  + p(74, 0); // dash 50mm
  s += p(49, -5.0)  + p(74, 0); // gap 5mm
  s += p(49, 10.0)  + p(74, 0); // dash scurt 10mm
  s += p(49, -5.0)  + p(74, 0); // gap 5mm
  s += p(0, "ENDTAB");

  // ── LAYER ──
  s += p(0, "TABLE") + p(2, "LAYER") + p(5, nextH()) + p(100, "AcDbSymbolTable") + p(70, layereDef.length + 1);
  // Layer "0" (obligatoriu)
  s += p(0, "LAYER") + p(5, nextH()) + p(100, "AcDbSymbolTableRecord") + p(100, "AcDbLayerTableRecord");
  s += p(2, "0") + p(70, 0) + p(62, 7) + p(6, "CONTINUOUS") + p(370, -3);
  for (const def of layereDef) {
    s += p(0, "LAYER") + p(5, nextH()) + p(100, "AcDbSymbolTableRecord") + p(100, "AcDbLayerTableRecord");
    s += p(2, def.nume) + p(70, 0) + p(62, def.culoare) + p(6, def.ltip) + p(370, -3);
  }
  s += p(0, "ENDTAB");

  // ── STYLE ──
  s += p(0, "TABLE") + p(2, "STYLE") + p(5, nextH()) + p(100, "AcDbSymbolTable") + p(70, 1);
  s += p(0, "STYLE") + p(5, nextH()) + p(100, "AcDbSymbolTableRecord") + p(100, "AcDbTextStyleTableRecord");
  s += p(2, "Standard") + p(70, 0) + p(40, 0) + p(41, 1) + p(50, 0) + p(71, 0) + p(42, 2.5) + p(3, "txt") + p(4, "");
  s += p(0, "ENDTAB");

  // ── VIEW ──
  s += p(0, "TABLE") + p(2, "VIEW") + p(5, nextH()) + p(100, "AcDbSymbolTable") + p(70, 0) + p(0, "ENDTAB");

  // ── UCS ──
  s += p(0, "TABLE") + p(2, "UCS") + p(5, nextH()) + p(100, "AcDbSymbolTable") + p(70, 0) + p(0, "ENDTAB");

  // ── APPID ──
  s += p(0, "TABLE") + p(2, "APPID") + p(5, nextH()) + p(100, "AcDbSymbolTable") + p(70, 1);
  s += p(0, "APPID") + p(5, nextH()) + p(100, "AcDbSymbolTableRecord") + p(100, "AcDbRegAppTableRecord");
  s += p(2, "ACAD") + p(70, 0);
  s += p(0, "ENDTAB");

  // ── DIMSTYLE ──
  s += p(0, "TABLE") + p(2, "DIMSTYLE") + p(5, nextH()) + p(100, "AcDbSymbolTable") + p(70, 1);
  s += p(0, "DIMSTYLE") + p(5, nextH()) + p(100, "AcDbSymbolTableRecord") + p(100, "AcDbDimStyleTableRecord");
  s += p(2, "Standard") + p(70, 0) + p(3, "") + p(4, "") + p(5, "") + p(6, "") + p(7, "");
  s += p(0, "ENDTAB");

  // ── BLOCK_RECORD ──
  s += p(0, "TABLE") + p(2, "BLOCK_RECORD") + p(5, nextH()) + p(100, "AcDbSymbolTable") + p(70, 2);
  s += p(0, "BLOCK_RECORD") + p(5, nextH()) + p(100, "AcDbSymbolTableRecord") + p(100, "AcDbBlockTableRecord");
  s += p(2, "*MODEL_SPACE") + p(340, 0);
  s += p(0, "BLOCK_RECORD") + p(5, nextH()) + p(100, "AcDbSymbolTableRecord") + p(100, "AcDbBlockTableRecord");
  s += p(2, "*PAPER_SPACE") + p(340, 0);
  s += p(0, "ENDTAB");

  s += p(0, "ENDSEC");
  return s;
}

function sectiuneBloc(): string {
  let s = p(0, "SECTION") + p(2, "BLOCKS");

  for (const numBloc of ["*MODEL_SPACE", "*PAPER_SPACE"]) {
    s += p(0, "BLOCK") + p(5, nextH()) + p(100, "AcDbEntity") + p(8, "0");
    s += p(100, "AcDbBlockBegin") + p(2, numBloc) + p(70, 0);
    s += p(10, 0) + p(20, 0) + p(30, 0) + p(3, numBloc) + p(1, "");
    s += p(0, "ENDBLK") + p(5, nextH()) + p(100, "AcDbEntity") + p(8, "0") + p(100, "AcDbBlockEnd");
  }

  s += p(0, "ENDSEC");
  return s;
}

function sectiuneObiects(): string {
  return (
    p(0, "SECTION") + p(2, "OBJECTS") +
    p(0, "DICTIONARY") + p(5, nextH()) +
    p(100, "AcDbDictionary") + p(280, 0) + p(281, 1) +
    p(0, "ENDSEC")
  );
}

// ── Export public ─────────────────────────────────────────────────────────────

export function exportaDxf(
  forme: FormaArmare[],
  opt?: {
    cuCote?: boolean;
    adnotatii?: Adnotatie[];
    coteLibere?: CotaLibera[];
    caleArrays?: CaleArray[];
    etichete?: EtichetaBara[];
    hasuri?: Hasura[];
    axe?: LinieAxa[];
    stalpi?: Stalp[];
    dreptunghiuri?: Dreptunghi[];
    coteElevatie?: CotaElevatie[];
    simboluriSectiuni?: SimbolSectiune[];
    geometriiDxf?: GeometrieDxf[];
  },
): string {
  resetHandles();
  const cuCote = opt?.cuCote ?? true;
  let entitati = "";

  for (const forma of forme) entitati += entitatiForma(forma, cuCote);

  for (const cale of opt?.caleArrays ?? []) {
    for (const forma of formeDinCaleArray(cale)) entitati += entitatiForma(forma, cuCote);
  }
  for (const cale of opt?.caleArrays ?? []) {
    entitati += entitateSegment({ tip: "linie", start: cale.start, sfarsit: cale.sfarsit }, LAYERE.adnotatii);
    if (cale.afiseazaCota ?? true) entitati += entitatiCotaCaleArray(cale);
  }

  for (const a of opt?.adnotatii ?? []) entitati += entitateText(a.pozitie, a.text || "Text", a.marime * FACTOR_ADNOTATII_DXF, LAYERE.adnotatii);
  for (const c of opt?.coteLibere ?? []) entitati += entitatiCotaLibera(c);
  for (const axa of opt?.axe ?? []) entitati += entitatiLinieAxa(axa);
  for (const stalp of opt?.stalpi ?? []) entitati += entitatiStalp(stalp);
  for (const d of opt?.dreptunghiuri ?? []) entitati += entitatiDreptunghi(d);
  for (const h of opt?.hasuri ?? []) entitati += entitatiHasura(h);

  if ((opt?.etichete ?? []).length > 0) {
    const formeMap = new Map(forme.map((f) => [f.id, f]));
    for (const e of opt!.etichete!) entitati += entitatiEtichetaBara(e, formeMap);
  }

  for (const c of opt?.coteElevatie ?? []) entitati += entitatiCotaElevatie(c, forme);
  for (const s of opt?.simboluriSectiuni ?? []) entitati += entitatiSimbolSectiune(s);
  for (const g of opt?.geometriiDxf ?? []) entitati += entitatiGeometrieDxf(g);

  return (
    sectiuneAntet() +
    sectiuneClase() +
    sectiuneTabele() +
    sectiuneBloc() +
    p(0, "SECTION") + p(2, "ENTITIES") +
    entitati +
    p(0, "ENDSEC") +
    sectiuneObiects() +
    p(0, "EOF")
  );
}
