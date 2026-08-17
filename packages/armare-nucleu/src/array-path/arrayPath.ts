import { distanta, grade, radiani, scade, unghi, type Vector2 } from "../geometrie/vector";
import { definitiePentru, varfuriImplicitePolilinie } from "../forme/catalog";
import { lungimeDesfasurata } from "../forme/catalog";
import type {
  Ciocuri,
  FormaArmare,
  ModBarDisplay,
  PartLabel,
  TipForma,
  TipPartLabel,
  TipVedere,
  ValoriParametri,
} from "../model/tipuri";
import { valoriImplicite } from "../model/tipuri";
import {
  type FormatTokenLabel,
  textDinPartiLabel,
} from "../label/formateazaLabel";

/** Orientarea barei față de axa path-ului. */
export type OrientareCaleArray = "perpendicular" | "parallel";

/** Geometria path-ului: linie dreaptă (implicit) sau arc de cerc. */
export type TipPathCaleArray = "liniar" | "arc";

/**
 * O zonă cu pas constant în cadrul unui array pe cale cu distribuție variabilă.
 * Exemplu de utilizare în grindă seismică: 1/3 la 100mm, 1/3 la 200mm, 1/3 la 100mm.
 */
export interface ZonaCaleArray {
  /** Lungimea zonei (mm). Ignorată pentru ultima zonă — se extinde automat până la capăt. */
  lungime: number;
  /** Pas maxim al distribuției în această zonă (mm). */
  pas: number;
}

/**
 * Distribuție de bare/etrieri de-a lungul unui path liniar (start → sfârșit).
 * Extinde conceptual array-ul 2D: în loc de grid X/Y, instanțele se plasează
 * uniform pe o linie de referință.
 */
export interface CaleArray {
  id: string;
  start: Vector2;
  sfarsit: Vector2;
  /** Tipul de formă distribuită (bare/etrieri). */
  tipForma: TipForma;
  parametri: ValoriParametri;
  marca: number;
  /** Număr de bare identice la fiecare poziție de pe path. */
  numar: number;
  /** Număr de poziții de-a lungul path-ului (inclusiv la start). */
  nr: number;
  /** Pas între poziții consecutive (mm). */
  pas: number;
  vedere?: TipVedere;
  ciocuri?: Ciocuri;
  varfuri?: Vector2[];
  vizualizare: "detaliat" | "abstract";
  orientare: OrientareCaleArray;
  /** Rotație suplimentară (grade) aplicată fiecărei instanțe. */
  rotatieSuplimentara?: number;
  oglinditX?: boolean;
  oglinditY?: boolean;
  excludeExtras?: boolean;
  /**
   * Acoperire beton (mm): offset perpendicular al barelor față de path
   * (spre interiorul secțiunii, sens trigonometric față de axa path).
   */
  acoperire?: number;
  /**
   * Offset perpendicular al liniei de cotă față de path (mm).
   * Capetele cotei rămân ancorate la start/sfârșit path; doar linia efectivă se deplasează.
   */
  offsetLinieCota?: number;
  /** Clasă oțel afișată în etichetă (implicit BSTC). */
  clasaOtel?: string;
  /** Tokenuri etichetă distribuție (marcă, Ø, pas, lungime, clasă oțel). */
  partiLabel?: PartLabel[];
  afiseazaCota?: boolean;
  afiseazaLungimeCota?: boolean;
  afiseazaEticheta?: boolean;
  afiseazaSimbolBara?: boolean;
  modAfisareBare?: ModBarDisplay;
  /**
   * Dimensiunea fontului etichetei (px ecran). Dacă absent, se folosește setarea globală.
   * Valoarea este independentă de zoom — textul rămâne aceeași dimensiune pe ecran indiferent de nivel de zoom.
   */
  marimeEtichetaCale?: number;
  /**
   * Offset suplimentar al etichetei perpendicular față de linia de cotă (mm).
   */
  offsetEticheta?: number;
  /** Offset etichetă de-a lungul liniei de cotă față de mijloc (mm). */
  offsetEtichetaParalel?: number;
  /** Offset text lungime perpendicular față de linia de cotă (mm), față de poziția implicită. */
  offsetLungimePerpendicular?: number;
  /** Offset text lungime de-a lungul liniei de cotă față de mijloc (mm). */
  offsetLungimeParalel?: number;
  /**
   * Rânduri paralele suplimentare (offset perpendicular față de acoperire, mm).
   * Fiecare valoare definește un rând extra de simboluri decalat față de rândul principal.
   * Valorile pozitive = în direcția normalei CCW, negative = opus.
   */
  straturiParalele?: number[];
  /**
   * Zone cu pasuri diferite de-a lungul path-ului.
   * Dacă prezent și nevidă, înlocuiește câmpul `pas` global pentru calculul pozițiilor.
   * Ultima zonă se extinde automat până la capătul path-ului, indiferent de `lungime`.
   * Câmpul `pas` global rămâne utilizat în eticheta distribuției ca pas reprezentativ.
   */
  zone?: ZonaCaleArray[];
  /** Tip geometrie path. Implicit `"liniar"` pentru compatibilitate. */
  tipPath?: TipPathCaleArray;
  /** Centrul cercului (doar pentru `tipPath: "arc"`). */
  centru?: Vector2;
  /** Rază cerc (mm, doar arc). */
  raza?: number;
  /** Unghi start arc (grade, trigonometric). */
  unghiStart?: number;
  /** Unghi sfârșit arc (grade, trigonometric). Sweep CCW de la start la sfârșit. */
  unghiSfarsit?: number;
}

export const CULOARE_PATH_ARRAY = "#cbd5e1";
export const CLASA_OTEL_CALE_ARRAY_IMPLICITA = "BSTC";

/** Clase de oțel-beton uzuale (pentru selectoare UI); câmpul rămâne text liber. */
export const CLASE_OTEL_UZUALE = ["BSTC", "PC52", "BST 500S", "B500B", "B500C"];

export const PARTI_LABEL_CALE_ARRAY_IMPLICITE: PartLabel[] = [
  { tip: "marca" },
  { tip: "numar" },
  { tip: "diametru" },
  { tip: "text", valoare: "/" },
  { tip: "pas" },
  { tip: "text", valoare: " " },
  { tip: "lungime" },
  { tip: "text", valoare: " " },
  { tip: "clasaOtel" },
];

export const CALE_ARRAY_IMPLICITA: Omit<CaleArray, "id" | "start" | "sfarsit" | "marca" | "parametri"> = {
  tipForma: "etrier",
  numar: 1,
  nr: 8,
  pas: 200,
  vizualizare: "detaliat",
  orientare: "perpendicular",
  vedere: "sus",
  acoperire: 25,
  offsetLinieCota: -150,
  clasaOtel: CLASA_OTEL_CALE_ARRAY_IMPLICITA,
  partiLabel: PARTI_LABEL_CALE_ARRAY_IMPLICITE,
  afiseazaCota: true,
  afiseazaLungimeCota: true,
  afiseazaEticheta: true,
  afiseazaSimbolBara: false,
  modAfisareBare: "grup3",
};

/** Tipuri de armare disponibile pe un array-path (fără cofraj). */
export const TIPURI_CALE_ARRAY: TipForma[] = [
  "dreapta",
  "L",
  "U",
  "etrier",
  "polilinie",
  "bara-sectiune",
  "etrier-lateral",
];

export function tipPathCaleArray(cale: CaleArray): TipPathCaleArray {
  return cale.tipPath ?? "liniar";
}

/** Path arc valid: tip arc + centru + rază pozitivă. */
export function esteCaleArc(cale: CaleArray): boolean {
  return tipPathCaleArray(cale) === "arc" && !!cale.centru && (cale.raza ?? 0) > 1e-6;
}

/** Sweep arc în radiani (CCW, întotdeauna pozitiv, max 2π). */
export function sweepArcRadiani(cale: CaleArray): number {
  const a0 = radiani(cale.unghiStart ?? 0);
  let a1 = radiani(cale.unghiSfarsit ?? 0);
  let sweep = a1 - a0;
  while (sweep <= 1e-9) sweep += 2 * Math.PI;
  if (sweep > 2 * Math.PI - 1e-9) sweep = 2 * Math.PI;
  return sweep;
}

/** Capete arc din parametri (grade trigonometrice). */
export function puncteArc(
  centru: Vector2,
  raza: number,
  unghiStart: number,
  unghiSfarsit: number,
): { start: Vector2; sfarsit: Vector2 } {
  const a0 = radiani(unghiStart);
  const a1 = radiani(unghiSfarsit);
  return {
    start: { x: centru.x + raza * Math.cos(a0), y: centru.y + raza * Math.sin(a0) },
    sfarsit: { x: centru.x + raza * Math.cos(a1), y: centru.y + raza * Math.sin(a1) },
  };
}

/**
 * Inițializează un arc care trece prin capetele date.
 * Centrul e pe bisectoarea perpendiculară, arc CCW față de coarda start→sfârșit.
 */
export function initArcDinCapete(
  start: Vector2,
  sfarsit: Vector2,
  razaExplicit?: number,
): Pick<CaleArray, "tipPath" | "centru" | "raza" | "unghiStart" | "unghiSfarsit" | "start" | "sfarsit"> {
  const chord = distanta(start, sfarsit);
  const r = Math.max(razaExplicit ?? Math.max(chord * 1.5, 500), chord / 2 + 1);
  const mx = (start.x + sfarsit.x) / 2;
  const my = (start.y + sfarsit.y) / 2;
  const dx = sfarsit.x - start.x;
  const dy = sfarsit.y - start.y;
  const chordLen = Math.max(chord, 1e-6);
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  const centru = {
    x: mx + (dy / chordLen) * h,
    y: my - (dx / chordLen) * h,
  };
  const aStart = grade(unghi(scade(start, centru)));
  const aEnd = grade(unghi(scade(sfarsit, centru)));
  return { tipPath: "arc", centru, raza: r, unghiStart: aStart, unghiSfarsit: aEnd, start, sfarsit };
}

/** Sincronizează start/sfârșit cu parametrii arc (apel după editarea razei/unghiurilor). */
export function sincronizeazaCapeteArc(cale: CaleArray): void {
  if (!esteCaleArc(cale) || !cale.centru || cale.raza == null) return;
  const capete = puncteArc(cale.centru, cale.raza, cale.unghiStart ?? 0, cale.unghiSfarsit ?? 0);
  cale.start = capete.start;
  cale.sfarsit = capete.sfarsit;
}

/** Patch la tragerea capătului de start al unui arc. */
export function patchUnghiStartArc(cale: CaleArray, punct: Vector2): Partial<CaleArray> {
  if (!cale.centru) return { start: punct };
  const r = distanta(cale.centru, punct);
  if (r < 1e-6) return { start: punct };
  const ang = grade(unghi(scade(punct, cale.centru)));
  return { unghiStart: ang, raza: r, start: punct };
}

/** Patch la tragerea capătului de sfârșit al unui arc. */
export function patchUnghiSfarsitArc(cale: CaleArray, punct: Vector2): Partial<CaleArray> {
  if (!cale.centru) return { sfarsit: punct };
  const r = distanta(cale.centru, punct);
  if (r < 1e-6) return { sfarsit: punct };
  const ang = grade(unghi(scade(punct, cale.centru)));
  return { unghiSfarsit: ang, raza: r, sfarsit: punct };
}

/** Punct pe path la distanța d (mm) de la start. */
export function punctPeCaleArray(cale: CaleArray, distanta: number): Vector2 {
  if (!esteCaleArc(cale)) {
    const dir = directieCaleArray(cale);
    if (!dir) return { ...cale.start };
    return { x: cale.start.x + dir.ux * distanta, y: cale.start.y + dir.uy * distanta };
  }
  const c = cale.centru!;
  const r = cale.raza!;
  const L = lungimeCaleArray(cale);
  const t = L < 1e-6 ? 0 : Math.min(1, Math.max(0, distanta / L));
  const ang = radiani(cale.unghiStart ?? 0) + t * sweepArcRadiani(cale);
  return { x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) };
}

/** Tangenta path (grade trigonometrice) la distanța d. */
export function tangentaGradePeCale(cale: CaleArray, distanta: number): number {
  if (!esteCaleArc(cale)) return unghiCaleGrade(cale);
  const L = lungimeCaleArray(cale);
  const t = L < 1e-6 ? 0 : distanta / L;
  const ang = radiani(cale.unghiStart ?? 0) + t * sweepArcRadiani(cale);
  return grade(ang + Math.PI / 2);
}

/** Normală unitară (radială spre exterior pe arc) la distanța d pe path. */
export function normalaPeCaleArray(cale: CaleArray, distanta = 0): { nx: number; ny: number } {
  if (!esteCaleArc(cale)) return normalaCaleArray(cale);
  const p = punctPeCaleArray(cale, distanta);
  const c = cale.centru!;
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { nx: 0, ny: 1 };
  return { nx: dx / len, ny: dy / len };
}

/** Puncte discretizate pentru randare path (coordonate plane x,y,...). */
export function punctePathDiscretizat(cale: CaleArray, segmente = 64): number[] {
  if (!esteCaleArc(cale)) {
    return [cale.start.x, cale.start.y, cale.sfarsit.x, cale.sfarsit.y];
  }
  const c = cale.centru!;
  const r = cale.raza!;
  const a0 = radiani(cale.unghiStart ?? 0);
  const sweep = sweepArcRadiani(cale);
  const n = Math.max(8, Math.ceil(segmente * sweep / (2 * Math.PI)));
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * sweep;
    pts.push(c.x + r * Math.cos(a), c.y + r * Math.sin(a));
  }
  return pts;
}

/** Lungimea path-ului în mm (cordă sau lungime arc). */
export function lungimeCaleArray(cale: CaleArray): number {
  if (esteCaleArc(cale)) return (cale.raza ?? 0) * sweepArcRadiani(cale);
  return distanta(cale.start, cale.sfarsit);
}

/** Vedere efectivă (implicit sus pentru etrieri). */
export function vedereCaleArray(cale: CaleArray): TipVedere {
  if (cale.vedere) return cale.vedere;
  return cale.tipForma === "etrier" ? "sus" : "frontal";
}

/** Acoperire beton efectivă (mm). */
export function acoperireCaleArray(cale: CaleArray): number {
  return cale.acoperire ?? CALE_ARRAY_IMPLICITA.acoperire ?? 25;
}

/** Offset linie cotă efectiv (mm). */
export function offsetLinieCotaCaleArray(cale: CaleArray): number {
  return cale.offsetLinieCota ?? CALE_ARRAY_IMPLICITA.offsetLinieCota ?? -150;
}

/** Vector unitar tangent la path (la mijloc pentru arc) sau null dacă degenerat. */
export function directieCaleArray(cale: CaleArray): { ux: number; uy: number; len: number } | null {
  if (esteCaleArc(cale)) {
    const L = lungimeCaleArray(cale);
    const tang = tangentaGradePeCale(cale, L / 2);
    const rad = radiani(tang);
    return { ux: Math.cos(rad), uy: Math.sin(rad), len: L };
  }
  const dx = cale.sfarsit.x - cale.start.x;
  const dy = cale.sfarsit.y - cale.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  return { ux: dx / len, uy: dy / len, len };
}

/** Normală unitară perpendiculară (CCW) față de path — la mijloc pentru arc. */
export function normalaCaleArray(cale: CaleArray): { nx: number; ny: number } {
  if (esteCaleArc(cale)) return normalaPeCaleArray(cale, lungimeCaleArray(cale) / 2);
  const dir = directieCaleArray(cale);
  if (!dir) return { nx: 0, ny: 1 };
  return { nx: -dir.uy, ny: dir.ux };
}

/** Număr efectiv de poziții (întotdeauna start + sfârșit când path > 0). */
export function nrEfectivCaleArray(cale: CaleArray): number {
  if (cale.zone && cale.zone.length > 0) {
    return offseturiCuZone(cale.zone, lungimeCaleArray(cale)).length;
  }
  return calculeazaNrDinLungime(cale);
}

/** Pas efectiv (mm). Pentru zone, returnează pasul minim (cel mai restrictiv). */
export function pasEfectivCaleArray(cale: CaleArray): number {
  if (cale.zone && cale.zone.length > 0) {
    return Math.min(...cale.zone.map((z) => z.pas));
  }
  const L = lungimeCaleArray(cale);
  const nr = nrEfectivCaleArray(cale);
  if (nr <= 1 || L < 1e-6) return 0;
  return L / (nr - 1);
}

/** Lungimea span-ului de distribuție afișat (mm) = lungimea path-ului. */
export function lungimeDistributieCaleArray(cale: CaleArray): number {
  return lungimeCaleArray(cale);
}

/** Total etrieri/bare în array (poziții × bare/poziție × rânduri paralele). */
export function numarElementeCaleArray(cale: CaleArray): number {
  const nrRanduri = 1 + (cale.straturiParalele?.length ?? 0);
  return nrEfectivCaleArray(cale) * Math.max(1, Math.round(cale.numar)) * nrRanduri;
}

export interface InfoEtichetaCaleArray {
  numar: number;
  marca: number;
  diametru: number;
  pas: number;
  /** Lungimea desfășurată per bucată (mm). */
  lungime: number;
  /** Lungimea totală a tuturor barelor: lungime × numar (mm). */
  lungimeTotala: number;
  clasaOtel: string;
}

/** Date pentru compunerea etichetei parametrice. */
export function infoEtichetaCaleArray(cale: CaleArray): InfoEtichetaCaleArray {
  const sablon = sablonFormaDinCale(cale);
  const lungime = lungimeDesfasurata(sablon);
  const numar = numarElementeCaleArray(cale);
  return {
    numar,
    marca: cale.marca,
    diametru: cale.parametri.diametru ?? 10,
    pas: cale.pas,
    lungime,
    lungimeTotala: lungime * numar,
    clasaOtel: cale.clasaOtel ?? CLASA_OTEL_CALE_ARRAY_IMPLICITA,
  };
}

/** Text etichetă (fără marcă — marcă în cerc separat). */
export function textEtichetaCaleArray(
  cale: CaleArray,
  parti = cale.partiLabel ?? PARTI_LABEL_CALE_ARRAY_IMPLICITE,
  formatGlobal?: Partial<Record<TipPartLabel, FormatTokenLabel>>,
): string {
  const info = infoEtichetaCaleArray(cale);
  return textDinPartiLabel(
    parti,
    {
      numar: info.numar,
      marca: info.marca,
      diametru: info.diametru,
      pas: info.pas,
      lungime: Math.round(info.lungime),
      lungimeTotala: Math.round(info.lungimeTotala),
      clasaOtel: info.clasaOtel,
    },
    formatGlobal,
  );
}

/** Distanțe de-a lungul path-ului pentru simbolurile de bară (vedere de sus). */
export function pozitiiSimbolCaleArray(cale: CaleArray): number[] {
  const all = offseturiCaleArray(cale);
  const mod = cale.modAfisareBare ?? CALE_ARRAY_IMPLICITA.modAfisareBare ?? "grup3";
  if (mod === "toate") return all;
  if (mod === "una") return [all[Math.floor(all.length / 2)] ?? 0];
  if (all.length <= 3) return all;
  return [all[0]!, all[Math.floor((all.length - 1) / 2)]!, all[all.length - 1]!];
}

/** Unghiul tangentei path față de axa X, în grade (sens trigonometric). */
export function unghiCaleGrade(cale: CaleArray): number {
  if (esteCaleArc(cale)) return tangentaGradePeCale(cale, lungimeCaleArray(cale) / 2);
  const dx = cale.sfarsit.x - cale.start.x;
  const dy = cale.sfarsit.y - cale.start.y;
  return grade(unghi({ x: dx, y: dy }));
}

/** Rotația unei instanțe la distanța d pe path (grade, sens trigonometric). */
export function rotatieInstPeCale(cale: CaleArray, distanta: number): number {
  const theta = tangentaGradePeCale(cale, distanta);
  const base = cale.orientare === "perpendicular" ? theta + 90 : theta;
  const extra = cale.rotatieSuplimentara ?? 0;
  return ((base + extra) % 360 + 360) % 360;
}

/** Rotația unei instanțe pe path (grade) — la mijlocul path-ului. */
export function rotatieInstCale(cale: CaleArray): number {
  return rotatieInstPeCale(cale, lungimeCaleArray(cale) / 2);
}

/**
 * Calculează pozițiile (offset față de start, mm) pentru un array cu zone diferite.
 * Prima poziție e întotdeauna 0 (start); ultima e întotdeauna totalL (sfârșit).
 * La fiecare limită de zonă există o bară — aceasta devine prima bară din zona anterioară
 * și din zona următoare nu mai apare o bară suplimentară la 0 offset.
 *
 * Algoritmul pentru fiecare zonă:
 *  - Calculează nrPasi = max(1, ceil(lungZ / pas)) → pas efectiv = lungZ / nrPasi ≤ pas
 *  - Generează nrPasi poziții de la cursor+pasEf până la cursor+lungZ (inclusiv)
 *
 * Zona finală se extinde automat până la capătul path-ului.
 */
export function offseturiCuZone(zone: ZonaCaleArray[], totalL: number): number[] {
  const offsets: number[] = [0];
  let cursor = 0;

  for (let z = 0; z < zone.length; z++) {
    const zona = zone[z]!;
    const isLast = z === zone.length - 1;
    const ramas = totalL - cursor;
    if (ramas < 1e-6) break;

    const lungZ = isLast ? ramas : Math.min(Math.max(zona.lungime, 0), ramas);
    if (lungZ < 1e-6) { cursor += lungZ; continue; }

    const nrPasi = Math.max(1, Math.ceil(lungZ / zona.pas));
    const pasEf = lungZ / nrPasi;

    for (let j = 1; j <= nrPasi; j++) {
      offsets.push(j === nrPasi ? cursor + lungZ : cursor + j * pasEf);
    }
    cursor += lungZ;
  }

  return offsets;
}

/**
 * Distanțele de la start pe path pentru fiecare instanță (mm).
 * Primul la start, ultimul la sfârșit; pas efectiv ≤ pas (maxim declarat).
 * Dacă CaleArray are zone definite, folosește distribuție cu pas variabil per zonă.
 */
export function offseturiCaleArray(cale: CaleArray): number[] {
  if (cale.zone && cale.zone.length > 0) {
    return offseturiCuZone(cale.zone, lungimeCaleArray(cale));
  }
  const L = lungimeCaleArray(cale);
  const nr = nrEfectivCaleArray(cale);
  if (L < 1e-6 || nr <= 1) return [0];
  const pasEf = L / (nr - 1);
  return Array.from({ length: nr }, (_, i) => (i === nr - 1 ? L : i * pasEf));
}

/** Indecșii vizibili în mod abstract (max. 3: primul, mijloc, ultimul). */
function indiciAbstracti(n: number): number[] {
  if (n <= 1) return [0];
  if (n === 2) return [0, 1];
  if (n === 3) return [0, 1, 2];
  return [0, Math.floor((n - 1) / 2), n - 1];
}

export interface InstantaCaleArray {
  index: number;
  pozitie: Vector2;
  rotatie: number;
  distanta: number;
}

/** Pozițiile instanțelor de-a lungul path-ului. */
export function instanteCaleArray(cale: CaleArray): InstantaCaleArray[] {
  const L = lungimeCaleArray(cale);
  if (L < 1e-6) {
    return [{ index: 0, pozitie: { ...cale.start }, rotatie: rotatieInstCale(cale), distanta: 0 }];
  }
  const offsetsFinale = offseturiCaleArray(cale);
  const cover = acoperireCaleArray(cale);
  const indices =
    cale.vizualizare === "abstract"
      ? indiciAbstracti(offsetsFinale.length)
      : offsetsFinale.map((_, i) => i);

  return indices.map((i) => {
    const d = offsetsFinale[i] ?? 0;
    const { nx, ny } = normalaPeCaleArray(cale, d);
    const pPath = punctPeCaleArray(cale, d);
    return {
      index: i,
      distanta: d,
      rotatie: rotatieInstPeCale(cale, d),
      pozitie: { x: pPath.x + nx * cover, y: pPath.y + ny * cover },
    };
  });
}

/** Număr total de bare în extras (poziții × numar). */
export function numarTotalCaleArray(cale: CaleArray): number {
  if (cale.excludeExtras) return 0;
  return numarElementeCaleArray(cale);
}

/**
 * Calculează nr. de poziții: minim 2 (start + sfârșit) când path > 0,
 * astfel încât distanța uniformă între poziții ≤ pas (pas = maxim).
 */
export function calculeazaNrDinLungime(cale: CaleArray): number {
  const L = lungimeCaleArray(cale);
  if (L < 1e-6) return 1;
  if (cale.pas <= 0) return 2;
  return Math.max(2, Math.ceil(L / cale.pas + 1));
}

/** Formă-sablon pentru generarea geometriei instanțelor. */
export function sablonFormaDinCale(cale: CaleArray): FormaArmare {
  const def = definitiePentru(cale.tipForma);
  return {
    id: `${cale.id}-sablon`,
    tip: cale.tipForma,
    nume: def.nume,
    marca: cale.marca,
    numar: 1,
    pozitie: { x: 0, y: 0 },
    parametri: cale.parametri,
    ciocuri: cale.ciocuri,
    vedere: vedereCaleArray(cale),
    varfuri: cale.varfuri,
    oglinditX: cale.oglinditX,
    oglinditY: cale.oglinditY,
    rotatie: rotatieInstCale(cale),
  };
}

/**
 * Formă pentru simbol de detaliu al unui singur element din array-path:
 * vedere frontală cu parametrii/ciocurile calei, indiferent de vederea de pe plan.
 */
export function formaSimbolCaleArray(cale: CaleArray): FormaArmare {
  const sablon = sablonFormaDinCale(cale);
  return {
    ...sablon,
    id: `${cale.id}-simbol`,
    vedere: "frontal",
    numar: cale.numar,
    rotatie: 0,
    pozitie: { x: 0, y: 0 },
  };
}

/** Punct de ancorare (leader) pentru simbol legat de array-path — mijlocul path-ului. */
export function ancorajSimbolCaleArray(cale: CaleArray): Vector2 {
  const L = lungimeCaleArray(cale);
  return punctPeCaleArray(cale, L / 2);
}

/** Formă completă la o instanță (pentru randare / DXF). */
export function formaLaInstanta(cale: CaleArray, inst: InstantaCaleArray): FormaArmare {
  const sablon = sablonFormaDinCale(cale);
  return {
    ...sablon,
    id: `${cale.id}-inst-${inst.index}`,
    pozitie: inst.pozitie,
    rotatie: inst.rotatie,
  };
}

/** Toate formele virtuale distribuite pe path (pentru export DXF), inclusiv rândurile paralele. */
export function formeDinCaleArray(cale: CaleArray): FormaArmare[] {
  const instante = instanteCaleArray(cale);
  const forme = instante.map((inst) => formaLaInstanta(cale, inst));

  const straturi = cale.straturiParalele ?? [];
  if (straturi.length > 0) {
    for (let si = 0; si < straturi.length; si++) {
      const extraOffset = straturi[si]!;
      for (const inst of instante) {
        const { nx, ny } = normalaPeCaleArray(cale, inst.distanta);
        const forma = formaLaInstanta(cale, inst);
        forme.push({
          ...forma,
          id: `${cale.id}-strat${si}-inst-${inst.index}`,
          pozitie: {
            x: inst.pozitie.x + nx * extraOffset,
            y: inst.pozitie.y + ny * extraOffset,
          },
        });
      }
    }
  }
  return forme;
}

/** Parametri impliciți pentru un tip de formă pe cale. */
export function parametriImplicitiCale(tip: TipForma): ValoriParametri {
  return valoriImplicite(definitiePentru(tip));
}

/** Vârfuri implicite (polilinie / etrier). */
export function varfuriImplicitiCale(tip: TipForma, parametri: ValoriParametri): Vector2[] | undefined {
  const def = definitiePentru(tip);
  if (tip === "polilinie") return varfuriImplicitePolilinie();
  if (tip === "etrier") return def.genereazaVarfuri(parametri).varfuri;
  return undefined;
}

/** Creează o cale array nouă cu valori implicite. */
export function creeazaCaleArray(
  start: Vector2,
  sfarsit: Vector2,
  marca: number,
  partial: Partial<Omit<CaleArray, "id" | "start" | "sfarsit" | "marca">> = {},
): Omit<CaleArray, "id"> {
  const tip = partial.tipForma ?? CALE_ARRAY_IMPLICITA.tipForma;
  const parametri = partial.parametri ?? parametriImplicitiCale(tip);
  return {
    start,
    sfarsit,
    marca,
    tipForma: tip,
    parametri,
    numar: partial.numar ?? CALE_ARRAY_IMPLICITA.numar,
    nr: partial.nr ?? CALE_ARRAY_IMPLICITA.nr,
    pas: partial.pas ?? CALE_ARRAY_IMPLICITA.pas,
    vizualizare: partial.vizualizare ?? CALE_ARRAY_IMPLICITA.vizualizare,
    orientare: partial.orientare ?? CALE_ARRAY_IMPLICITA.orientare,
    vedere: partial.vedere ?? CALE_ARRAY_IMPLICITA.vedere,
    acoperire: partial.acoperire ?? CALE_ARRAY_IMPLICITA.acoperire,
    offsetLinieCota: partial.offsetLinieCota ?? CALE_ARRAY_IMPLICITA.offsetLinieCota,
    clasaOtel: partial.clasaOtel ?? CALE_ARRAY_IMPLICITA.clasaOtel,
    partiLabel: partial.partiLabel ?? CALE_ARRAY_IMPLICITA.partiLabel,
    afiseazaCota: partial.afiseazaCota ?? CALE_ARRAY_IMPLICITA.afiseazaCota,
    afiseazaLungimeCota: partial.afiseazaLungimeCota ?? CALE_ARRAY_IMPLICITA.afiseazaLungimeCota,
    afiseazaEticheta: partial.afiseazaEticheta ?? CALE_ARRAY_IMPLICITA.afiseazaEticheta,
    afiseazaSimbolBara: partial.afiseazaSimbolBara ?? CALE_ARRAY_IMPLICITA.afiseazaSimbolBara,
    modAfisareBare: partial.modAfisareBare ?? CALE_ARRAY_IMPLICITA.modAfisareBare,
    ciocuri: partial.ciocuri,
    varfuri: partial.varfuri ?? varfuriImplicitiCale(tip, parametri),
    rotatieSuplimentara: partial.rotatieSuplimentara,
    oglinditX: partial.oglinditX,
    oglinditY: partial.oglinditY,
    excludeExtras: partial.excludeExtras,
    zone: partial.zone,
    tipPath: partial.tipPath,
    centru: partial.centru,
    raza: partial.raza,
    unghiStart: partial.unghiStart,
    unghiSfarsit: partial.unghiSfarsit,
  };
}

/** Creează o cale array arc cu valori implicite. */
export function creeazaCaleArrayArc(
  centru: Vector2,
  raza: number,
  unghiStart: number,
  unghiSfarsit: number,
  marca: number,
  partial: Partial<Omit<CaleArray, "id" | "start" | "sfarsit" | "marca" | "centru" | "raza" | "unghiStart" | "unghiSfarsit" | "tipPath">> = {},
): Omit<CaleArray, "id"> {
  const capete = puncteArc(centru, raza, unghiStart, unghiSfarsit);
  const base = creeazaCaleArray(capete.start, capete.sfarsit, marca, partial);
  return {
    ...base,
    tipPath: "arc",
    centru,
    raza,
    unghiStart,
    unghiSfarsit,
    start: capete.start,
    sfarsit: capete.sfarsit,
  };
}
