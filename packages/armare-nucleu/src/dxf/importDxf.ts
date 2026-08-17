import type { Vector2 } from "../geometrie/vector";

/**
 * Import DXF ca SUBSTRAT de referință (geometrie read-only) — nu reconstruiește
 * forme parametrice, ci permite trasarea armăturii peste un desen importat
 * (ex. o secțiune de cofraj, sau un cartuș exportat din AutoCAD/Revit/Tekla/Civil 3D).
 * Parser ASCII minimal, fără dependențe.
 *
 * Entități suportate: LINE, CIRCLE, ARC, LWPOLYLINE, HATCH, TEXT, MTEXT,
 * INSERT (blocuri, cu expandare recursivă), ATTDEF/ATTRIB (atribute de bloc —
 * devin entități `text` marcate cu `atribut.tag`, utile ca și câmpuri editabile
 * la conversia unui cartuș CAD), IMAGE/IMAGEDEF (rastere referite — poziție și
 * dimensiune extrase; conținutul imaginii trebuie furnizat separat de utilizator,
 * DXF nu îl înglobează, doar reține calea fișierului original).
 */
export type EntitateImport =
  | { tip: "linie"; p1: Vector2; p2: Vector2; layer?: string; stil?: StilEntitate }
  | { tip: "cerc"; centru: Vector2; raza: number; layer?: string; stil?: StilEntitate }
  | { tip: "arc"; centru: Vector2; raza: number; unghiStartGrade: number; unghiSfarsitGrade: number; layer?: string; stil?: StilEntitate }
  | { tip: "polilinie"; puncte: Vector2[]; inchis: boolean; layer?: string; stil?: StilEntitate }
  | { tip: "hasura"; contururi: Vector2[][]; numePattern: string; unghi: number; pas: number; layer?: string; stil?: StilEntitate }
  | { tip: "text"; pozitie: Vector2; continut: string; inaltime: number; rotatie: number; layer?: string; stil?: StilEntitate; atribut?: AtributText }
  | { tip: "imagine"; pozitie: Vector2; latime: number; inaltime: number; rotatie: number; fisierRef?: string; layer?: string; stil?: StilEntitate };

/** Marchează o entitate `text` ca provenind dintr-un atribut de bloc (ATTDEF/ATTRIB). */
export interface AtributText {
  /** Tag-ul atributului (ex. "PROIECT", "SCARA"), cheie candidat pentru câmp editabil. */
  tag: string;
}

export interface SubstratImport {
  entitati: EntitateImport[];
  /** Anvelopa în coordonate-lume (mm), utilă pentru încadrarea vederii. */
  anvelopa: { minX: number; minY: number; maxX: number; maxY: number };
  /** Layerele unice din DXF (extrase din entități). */
  layere?: string[];
}

export type TipLinieEntitate = "continua" | "punct-linie" | "puncte";

/** Stiluri vizuale per layer. */
export interface LayerSetari {
  /** Culoarea liniilor pe acest layer (hex). Dacă absent, se folosește culoarea implicită. */
  culoare?: string;
  /** Grosimea liniei în mm. Dacă absent, se folosește grosimea implicită (1.2mm). */
  grosime?: number;
  /** Tipul liniei. */
  tipLinie?: TipLinieEntitate;
}

/** Stiluri vizuale individuale per entitate (override față de layer). */
export interface StilEntitate {
  culoare?: string;
  grosime?: number;
  tipLinie?: TipLinieEntitate;
}

/**
 * Geometrie DXF importată — entități plate în coordonate absolute (lume),
 * fără bloc-wrapper, poziție sau rotație. Gestionată din panoul lateral.
 */
export interface GeometrieDxf {
  id: string;
  nume: string;
  /** Entitățile în coordonate absolute (mm). */
  entitati: EntitateImport[];
  /** Anvelopa în coordonate absolute. */
  anvelopa: { minX: number; minY: number; maxX: number; maxY: number };
  /** Layerele DXF originale. */
  layere: string[];
  /** Layerele vizibile. */
  layereVizibile: string[];
  /** Stiluri vizuale per layer (culoare, grosime). */
  layereSetari: Record<string, LayerSetari>;
  /** Opacitate globală a geometriei (0–1). Implicit 1. */
  opacitate?: number;
  /** Dacă true, geometria se randează în grayscale (tonuri de gri). */
  grayscale?: boolean;
}

/** Pereche cod/valoare DXF rezultată la parsarea fișierului. */
interface Pereche {
  cod: number;
  valoare: string;
}

/** O "entitate" brută (grupată la marcatorii cod 0), etichetată cu secțiunea DXF din care provine. */
interface EntitateBruta {
  tip: string;
  campuri: Pereche[];
  sectiune: string;
}

function tokenizeaza(text: string): Pereche[] {
  // DXF ASCII: linii alternând cod (întreg) și valoare.
  const linii = text.split(/\r\n|\r|\n/);
  const perechi: Pereche[] = [];
  for (let i = 0; i + 1 < linii.length; i += 2) {
    const cod = Number.parseInt(linii[i]!.trim(), 10);
    if (Number.isNaN(cod)) {
      i -= 1; // resincronizare dacă apar linii goale
      continue;
    }
    perechi.push({ cod, valoare: linii[i + 1]!.trim() });
  }
  return perechi;
}

/**
 * Grupează TOATE entitățile brute din fișier (indiferent de secțiune), marcând
 * fiecare cu numele secțiunii curente (ENTITIES, BLOCKS, OBJECTS, ...).
 * Necesar pentru rezolvarea blocurilor (INSERT → BLOCKS) și a imaginilor
 * (IMAGE → IMAGEDEF din OBJECTS).
 */
function* grupeazaToate(perechi: Pereche[]): Generator<EntitateBruta> {
  let sectiune = "";
  let asteaptaNumeSectiune = false;
  let curent: { tip: string; campuri: Pereche[] } | null = null;

  for (const p of perechi) {
    if (p.cod === 0) {
      if (curent) yield { ...curent, sectiune };
      curent = null;
      if (p.valoare === "SECTION") {
        asteaptaNumeSectiune = true;
        continue;
      }
      if (p.valoare === "ENDSEC") {
        sectiune = "";
        asteaptaNumeSectiune = false;
        continue;
      }
      if (p.valoare === "EOF") continue;
      curent = { tip: p.valoare, campuri: [] };
      continue;
    }
    if (asteaptaNumeSectiune && p.cod === 2) {
      sectiune = p.valoare;
      asteaptaNumeSectiune = false;
      continue;
    }
    if (curent) curent.campuri.push(p);
  }
  if (curent) yield { ...curent, sectiune };
}

/** Prima valoare numerică pentru un cod dat. Valorile corupte (NaN/Inf) cad pe implicit. */
function num(campuri: Pereche[], cod: number, implicit = 0): number {
  const c = campuri.find((x) => x.cod === cod);
  if (!c) return implicit;
  const v = Number.parseFloat(c.valoare);
  return Number.isFinite(v) ? v : implicit;
}

/** Prima valoare text pentru un cod dat. */
function str(campuri: Pereche[], cod: number): string | undefined {
  return campuri.find((x) => x.cod === cod)?.valoare;
}

/**
 * Toate valorile numerice pentru un cod (ex. toate vârfurile X).
 * Valorile corupte devin 0 (nu se filtrează, ca să nu se strice perechile X/Y).
 */
function toateNum(campuri: Pereche[], cod: number): number[] {
  return campuri
    .filter((x) => x.cod === cod)
    .map((x) => {
      const v = Number.parseFloat(x.valoare);
      return Number.isFinite(v) ? v : 0;
    });
}

/**
 * Parsează o entitate HATCH din DXF.
 *
 * Structura DXF HATCH (simplificată):
 *   cod  2 → nume pattern
 *   cod 52 → unghi pattern
 *   cod 41 → scară pattern (influențează pasul)
 *   cod 91 → număr de boundary paths
 *   Pentru fiecare path:
 *     cod 92 → tip path (1 = polilinie, 2 = arce/linii)
 *     cod 72 → hasBulge (la polilinie path)
 *     cod 73 → isClosed
 *     cod 93 → nr vârfuri
 *     cod 10/20 → coordonate vârfuri
 *
 * Extragem doar contururile polyline (cele mai frecvente în DXF-uri structurale).
 */
function parseHatch(campuri: Pereche[]): EntitateImport | null {
  // Nume pattern (cod 2)
  const numePattern = campuri.find((c) => c.cod === 2)?.valoare ?? "SOLID";
  // Unghi pattern (cod 52)
  const unghi = num(campuri, 52);
  // Scară pattern (cod 41, default 1)
  const scala = num(campuri, 41, 1);
  // Pas implicit: linii la 5mm * scară
  const pas = scala * 5;

  // Extragem contururile boundary din secvența de coduri.
  // Strategia: parcurgem secvențial și detectăm boundary loops.
  const contururi: Vector2[][] = [];
  let i = 0;

  // Găsim prima apariție a codului 91 (nr paths)
  while (i < campuri.length && campuri[i]!.cod !== 91) i++;
  if (i >= campuri.length) return null;
  const nrPaths = Number.parseInt(campuri[i]!.valoare, 10);
  i++;

  for (let pathIdx = 0; pathIdx < nrPaths && i < campuri.length; pathIdx++) {
    // Căutăm cod 92 (path type flag)
    while (i < campuri.length && campuri[i]!.cod !== 92) i++;
    if (i >= campuri.length) break;
    const pathType = Number.parseInt(campuri[i]!.valoare, 10);
    i++;

    if (pathType & 2) {
      // Polyline boundary path
      // Caut cod 72 (hasBulge), 73 (isClosed), 93 (nr vertices)
      let nrVertices = 0;
      while (i < campuri.length && campuri[i]!.cod !== 93) i++;
      if (i < campuri.length) {
        nrVertices = Number.parseInt(campuri[i]!.valoare, 10);
        i++;
      }
      const puncte: Vector2[] = [];
      let collected = 0;
      while (collected < nrVertices && i < campuri.length) {
        if (campuri[i]!.cod === 10) {
          const x = Number.parseFloat(campuri[i]!.valoare);
          // Următorul ar trebui să fie 20 (y)
          if (i + 1 < campuri.length && campuri[i + 1]!.cod === 20) {
            const y = Number.parseFloat(campuri[i + 1]!.valoare);
            puncte.push({ x, y });
            i += 2;
            // Sărim peste bulge (cod 42) dacă există
            if (i < campuri.length && campuri[i]!.cod === 42) i++;
            collected++;
            continue;
          }
        }
        i++;
      }
      if (puncte.length >= 3) contururi.push(puncte);
    } else {
      // Edge-based boundary path — parsăm linii/arce
      // Cod 93 = nr edges
      while (i < campuri.length && campuri[i]!.cod !== 93) i++;
      if (i >= campuri.length) break;
      const nrEdges = Number.parseInt(campuri[i]!.valoare, 10);
      i++;

      const puncte: Vector2[] = [];
      for (let edgeIdx = 0; edgeIdx < nrEdges && i < campuri.length; edgeIdx++) {
        // Cod 72 = edge type (1=line, 2=arc, 3=ellipse, 4=spline)
        while (i < campuri.length && campuri[i]!.cod !== 72) i++;
        if (i >= campuri.length) break;
        const edgeType = Number.parseInt(campuri[i]!.valoare, 10);
        i++;

        if (edgeType === 1) {
          // Line: cod 10,20 → start; 11,21 → end
          let x1 = 0, y1 = 0;
          while (i < campuri.length && campuri[i]!.cod !== 10) i++;
          if (i < campuri.length) { x1 = Number.parseFloat(campuri[i]!.valoare); i++; }
          while (i < campuri.length && campuri[i]!.cod !== 20) i++;
          if (i < campuri.length) { y1 = Number.parseFloat(campuri[i]!.valoare); i++; }
          // end point
          while (i < campuri.length && campuri[i]!.cod !== 11) i++;
          if (i < campuri.length) i++; // skip x2
          while (i < campuri.length && campuri[i]!.cod !== 21) i++;
          if (i < campuri.length) i++; // skip y2
          puncte.push({ x: x1, y: y1 });
        } else {
          // Arc/ellipse/spline — skip by advancing past this edge's data
          // We just skip until next cod 72 or end
          while (i < campuri.length && campuri[i]!.cod !== 72 && campuri[i]!.cod !== 97) i++;
        }
      }
      if (puncte.length >= 3) contururi.push(puncte);
    }
  }

  if (contururi.length === 0) return null;
  return { tip: "hasura", contururi, numePattern, unghi, pas };
}

function stripSpecialChars(s: string): string {
  return s
    .replace(/%%[Cc]/gi, "∅")
    .replace(/%%[Dd]/gi, "°")
    .replace(/%%[Pp]/gi, "±");
}

function stripMTextFormatting(s: string): string {
  return stripSpecialChars(
    s
      .replace(/\\[Pp]/g, "\n")
      .replace(/\{\\[^;]+;([^}]*)\}/g, "$1")
      .replace(/\\\\/g, "\\")
      .replace(/[{}]/g, ""),
  );
}

/** Extrage numele layer-ului (cod 8) din câmpurile entității. */
function layerDin(campuri: Pereche[]): string | undefined {
  const c = campuri.find((x) => x.cod === 8);
  return c?.valoare || undefined;
}

function entitateDin(tip: string, campuri: Pereche[]): EntitateImport | null {
  const layer = layerDin(campuri);
  switch (tip) {
    case "LINE":
      return {
        tip: "linie",
        p1: { x: num(campuri, 10), y: num(campuri, 20) },
        p2: { x: num(campuri, 11), y: num(campuri, 21) },
        layer,
      };
    case "CIRCLE":
      return {
        tip: "cerc",
        centru: { x: num(campuri, 10), y: num(campuri, 20) },
        raza: num(campuri, 40),
        layer,
      };
    case "ARC":
      return {
        tip: "arc",
        centru: { x: num(campuri, 10), y: num(campuri, 20) },
        raza: num(campuri, 40),
        unghiStartGrade: num(campuri, 50),
        unghiSfarsitGrade: num(campuri, 51),
        layer,
      };
    case "LWPOLYLINE": {
      const xs = toateNum(campuri, 10);
      const ys = toateNum(campuri, 20);
      const puncte: Vector2[] = [];
      for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
        puncte.push({ x: xs[i]!, y: ys[i]! });
      }
      const inchis = (num(campuri, 70) & 1) === 1;
      return puncte.length >= 2 ? { tip: "polilinie", puncte, inchis, layer } : null;
    }
    case "HATCH": {
      const h = parseHatch(campuri);
      if (h) h.layer = layer;
      return h;
    }
    case "TEXT": {
      const continut = stripSpecialChars(campuri.find((c) => c.cod === 1)?.valoare ?? "");
      if (!continut) return null;
      return {
        tip: "text",
        pozitie: { x: num(campuri, 10), y: num(campuri, 20) },
        continut,
        inaltime: num(campuri, 40, 2.5),
        rotatie: num(campuri, 50, 0),
        layer,
      };
    }
    case "MTEXT": {
      const continut = stripMTextFormatting(
        campuri.filter((c) => c.cod === 1).map((c) => c.valoare).join(""),
      );
      if (!continut.trim()) return null;
      return {
        tip: "text",
        pozitie: { x: num(campuri, 10), y: num(campuri, 20) },
        continut,
        inaltime: num(campuri, 40, 2.5),
        rotatie: num(campuri, 50, 0),
        layer,
      };
    }
    case "ATTDEF":
    case "ATTRIB": {
      // Fallback pt. atribute orfane (fără un INSERT grupat) — tratate ca text simplu.
      const continut = stripSpecialChars(campuri.find((c) => c.cod === 1)?.valoare ?? "");
      if (!continut) return null;
      const tag = str(campuri, 2);
      return {
        tip: "text",
        pozitie: { x: num(campuri, 10), y: num(campuri, 20) },
        continut,
        inaltime: num(campuri, 40, 2.5),
        rotatie: num(campuri, 50, 0),
        layer,
        atribut: tag ? { tag } : undefined,
      };
    }
    default:
      return null;
  }
}

/** Definiția unui bloc (din secțiunea BLOCKS): punct de bază + entitățile brute conținute. */
interface DefinitieBloc {
  nume: string;
  bazaX: number;
  bazaY: number;
  entitatiBrute: EntitateBruta[];
}

/** Grupează entitățile secțiunii BLOCKS pe definiții de bloc (marcate BLOCK…ENDBLK). */
function parseazaBlocuri(toate: EntitateBruta[]): Map<string, DefinitieBloc> {
  const blocuri = new Map<string, DefinitieBloc>();
  let curent: DefinitieBloc | null = null;
  for (const item of toate) {
    if (item.sectiune !== "BLOCKS") continue;
    if (item.tip === "BLOCK") {
      const nume = str(item.campuri, 2) ?? "";
      curent = { nume, bazaX: num(item.campuri, 10), bazaY: num(item.campuri, 20), entitatiBrute: [] };
      blocuri.set(nume, curent);
      continue;
    }
    if (item.tip === "ENDBLK") {
      curent = null;
      continue;
    }
    if (curent) curent.entitatiBrute.push(item);
  }
  return blocuri;
}

/** Extrage maparea handle → cale fișier din obiectele IMAGEDEF (secțiunea OBJECTS). */
function parseazaImagedefs(toate: EntitateBruta[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of toate) {
    if (item.sectiune !== "OBJECTS" || item.tip !== "IMAGEDEF") continue;
    const handle = str(item.campuri, 5);
    const cale = str(item.campuri, 1);
    if (handle && cale) map.set(handle, cale);
  }
  return map;
}

function parseImage(campuri: Pereche[], imagedefs: Map<string, string>): EntitateImport | null {
  const uX = num(campuri, 11);
  const uY = num(campuri, 21);
  const vX = num(campuri, 12);
  const vY = num(campuri, 22);
  const pixU = num(campuri, 13);
  const pixV = num(campuri, 23);
  const latime = Math.hypot(uX, uY) * pixU;
  const inaltime = Math.hypot(vX, vY) * pixV;
  if (!(latime > 0) || !(inaltime > 0)) return null;
  const rotatie = (Math.atan2(uY, uX) * 180) / Math.PI;
  const handle = str(campuri, 340);
  const caleCompleta = handle ? imagedefs.get(handle) : undefined;
  const fisierRef = caleCompleta ? caleCompleta.replace(/\\/g, "/").split("/").pop() : undefined;
  return {
    tip: "imagine",
    pozitie: { x: num(campuri, 10), y: num(campuri, 20) },
    latime,
    inaltime,
    rotatie,
    fisierRef,
    layer: layerDin(campuri),
  };
}

/** Grupează secvențele INSERT + ATTRIB*...+ SEQEND în unități logice de expandat. */
interface GrupInsert {
  tip: "INSERT";
  campuri: Pereche[];
  atribute: Pereche[][];
}

function grupeazaInserturi(entitatiSectiune: EntitateBruta[]): (EntitateBruta | GrupInsert)[] {
  const rezultat: (EntitateBruta | GrupInsert)[] = [];
  let i = 0;
  while (i < entitatiSectiune.length) {
    const e = entitatiSectiune[i]!;
    if (e.tip === "INSERT") {
      const atribute: Pereche[][] = [];
      let j = i + 1;
      while (j < entitatiSectiune.length && entitatiSectiune[j]!.tip === "ATTRIB") {
        atribute.push(entitatiSectiune[j]!.campuri);
        j++;
      }
      if (j < entitatiSectiune.length && entitatiSectiune[j]!.tip === "SEQEND") j++;
      rezultat.push({ tip: "INSERT", campuri: e.campuri, atribute });
      i = j;
      continue;
    }
    if (e.tip === "ATTRIB" || e.tip === "SEQEND") {
      i++;
      continue;
    }
    rezultat.push(e);
    i++;
  }
  return rezultat;
}

/** Type guard: distinge un grup INSERT (cu atribute) de o entitate brută obișnuită. */
function esteGrupInsert(g: EntitateBruta | GrupInsert): g is GrupInsert {
  return g.tip === "INSERT" && "atribute" in g;
}

/** Aplică transformarea unui INSERT (translație relativă la baza blocului, scară, rotație) unei entități copil. */
function transformaEntitate(
  ent: EntitateImport,
  transform: (x: number, y: number) => Vector2,
  scaleX: number,
  scaleY: number,
  rotDeg: number,
  layerFallback: string | undefined,
): EntitateImport {
  const factorScala = Math.max(Math.abs(scaleX), Math.abs(scaleY));
  const layer = ent.layer ?? layerFallback;
  switch (ent.tip) {
    case "linie":
      return { ...ent, p1: transform(ent.p1.x, ent.p1.y), p2: transform(ent.p2.x, ent.p2.y), layer };
    case "cerc":
      return { ...ent, centru: transform(ent.centru.x, ent.centru.y), raza: ent.raza * factorScala, layer };
    case "arc": {
      // Scara negativă (bloc oglindit) reflectă unghiurile și inversează sensul
      // de parcurgere; arcul DXF e mereu CCW, deci după oglindire schimbăm capetele.
      let s = ent.unghiStartGrade;
      let e = ent.unghiSfarsitGrade;
      const det = scaleX * scaleY;
      if (det < 0) {
        if (scaleX < 0) {
          s = 180 - s;
          e = 180 - e;
        } else {
          s = -s;
          e = -e;
        }
        [s, e] = [e, s];
      } else if (scaleX < 0 && scaleY < 0) {
        // Dublă oglindire = rotație 180° (fără inversarea sensului).
        s += 180;
        e += 180;
      }
      return {
        ...ent,
        centru: transform(ent.centru.x, ent.centru.y),
        raza: ent.raza * factorScala,
        unghiStartGrade: s + rotDeg,
        unghiSfarsitGrade: e + rotDeg,
        layer,
      };
    }
    case "polilinie":
      return { ...ent, puncte: ent.puncte.map((p) => transform(p.x, p.y)), layer };
    case "hasura":
      return { ...ent, contururi: ent.contururi.map((c) => c.map((p) => transform(p.x, p.y))), layer };
    case "text":
      return {
        ...ent,
        pozitie: transform(ent.pozitie.x, ent.pozitie.y),
        inaltime: ent.inaltime * factorScala,
        rotatie: ent.rotatie + rotDeg,
        layer,
      };
    case "imagine":
      return {
        ...ent,
        pozitie: transform(ent.pozitie.x, ent.pozitie.y),
        latime: ent.latime * Math.abs(scaleX),
        inaltime: ent.inaltime * Math.abs(scaleY),
        rotatie: ent.rotatie + rotDeg,
        layer,
      };
  }
}

const ADANCIME_MAX_BLOC = 6;

/**
 * Expandează un INSERT în entități în coordonate-lume, urcând recursiv prin
 * blocuri imbricate (până la `ADANCIME_MAX_BLOC`). Atributele (ATTRIB, deja
 * poziționate absolut de aplicația sursă) devin entități `text` marcate cu
 * `atribut.tag`; atributele constante (doar ATTDEF, fără ATTRIB corespondent)
 * sunt aplicate cu poziția transformată prin bloc.
 */
function rezolvaInsert(
  insert: GrupInsert,
  blocuri: Map<string, DefinitieBloc>,
  imagedefs: Map<string, string>,
  adancime: number,
): EntitateImport[] {
  if (adancime > ADANCIME_MAX_BLOC) return [];
  const nume = str(insert.campuri, 2) ?? "";
  const bloc = blocuri.get(nume);
  if (!bloc) return [];

  const insX = num(insert.campuri, 10);
  const insY = num(insert.campuri, 20);
  const scaleX = num(insert.campuri, 41, 1);
  const scaleY = num(insert.campuri, 42, 1);
  const rotDeg = num(insert.campuri, 50, 0);
  const rot = (rotDeg * Math.PI) / 180;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const layerInsert = layerDin(insert.campuri);

  const transform = (x: number, y: number): Vector2 => {
    const lx = (x - bloc.bazaX) * scaleX;
    const ly = (y - bloc.bazaY) * scaleY;
    return { x: insX + lx * cosR - ly * sinR, y: insY + lx * sinR + ly * cosR };
  };

  const rezultat: EntitateImport[] = [];

  for (const sub of bloc.entitatiBrute) {
    if (sub.tip === "ATTDEF") continue; // gestionate separat mai jos (fallback pt. atribute constante)
    if (sub.tip === "INSERT") {
      // Bloc imbricat: expandăm recursiv, apoi transformăm rezultatul prin transformarea curentă.
      const nested: GrupInsert = { tip: "INSERT", campuri: sub.campuri, atribute: [] };
      const subEntitati = rezolvaInsert(nested, blocuri, imagedefs, adancime + 1);
      for (const se of subEntitati) {
        rezultat.push(transformaEntitate(se, transform, scaleX, scaleY, rotDeg, layerInsert));
      }
      continue;
    }
    if (sub.tip === "IMAGE") {
      const img = parseImage(sub.campuri, imagedefs);
      if (img) rezultat.push(transformaEntitate(img, transform, scaleX, scaleY, rotDeg, layerInsert));
      continue;
    }
    const ent = entitateDin(sub.tip, sub.campuri);
    if (!ent) continue;
    rezultat.push(transformaEntitate(ent, transform, scaleX, scaleY, rotDeg, layerInsert));
  }

  // Atribute instanțiate (ATTRIB) — poziția e deja absolută (scrisă de aplicația sursă), nu se retransformă.
  const tagsGestionate = new Set<string>();
  for (const attribCampuri of insert.atribute) {
    const tag = str(attribCampuri, 2);
    const valoare = stripSpecialChars(str(attribCampuri, 1) ?? "");
    if (tag) tagsGestionate.add(tag);
    if (!valoare) continue;
    rezultat.push({
      tip: "text",
      pozitie: { x: num(attribCampuri, 10), y: num(attribCampuri, 20) },
      continut: valoare,
      inaltime: num(attribCampuri, 40, 2.5) * Math.max(Math.abs(scaleX), Math.abs(scaleY), 1),
      rotatie: num(attribCampuri, 50, 0),
      layer: layerDin(attribCampuri) ?? layerInsert,
      atribut: tag ? { tag } : undefined,
    });
  }

  // Atribute constante (ATTDEF fără ATTRIB corespondent) — poziția se transformă prin bloc.
  for (const sub of bloc.entitatiBrute) {
    if (sub.tip !== "ATTDEF") continue;
    const tag = str(sub.campuri, 2) ?? "";
    if (tagsGestionate.has(tag)) continue;
    const valoare = stripSpecialChars(str(sub.campuri, 1) ?? "");
    if (!valoare) continue;
    rezultat.push({
      tip: "text",
      pozitie: transform(num(sub.campuri, 10), num(sub.campuri, 20)),
      continut: valoare,
      inaltime: num(sub.campuri, 40, 2.5) * Math.max(Math.abs(scaleX), Math.abs(scaleY)),
      rotatie: num(sub.campuri, 50, 0) + rotDeg,
      layer: layerDin(sub.campuri) ?? layerInsert,
      atribut: tag ? { tag } : undefined,
    });
  }

  return rezultat;
}

function anvelopaDin(entitati: EntitateImport[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const e of entitati) {
    switch (e.tip) {
      case "linie":
        include(e.p1.x, e.p1.y);
        include(e.p2.x, e.p2.y);
        break;
      case "cerc":
      case "arc":
        include(e.centru.x - e.raza, e.centru.y - e.raza);
        include(e.centru.x + e.raza, e.centru.y + e.raza);
        break;
      case "hasura":
        for (const contur of e.contururi) {
          for (const p of contur) include(p.x, p.y);
        }
        break;
      case "text": {
        const w = e.inaltime * 0.6 * e.continut.length;
        include(e.pozitie.x, e.pozitie.y);
        include(e.pozitie.x + w, e.pozitie.y + e.inaltime);
        break;
      }
      case "imagine":
        include(e.pozitie.x, e.pozitie.y);
        include(e.pozitie.x + e.latime, e.pozitie.y + e.inaltime);
        break;
      case "polilinie":
        for (const p of e.puncte) include(p.x, p.y);
        break;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * Parsează un fișier DXF ASCII într-un substrat de referință.
 * Expandează blocurile (INSERT) recursiv și rezolvă atributele/imaginile.
 */
export function importaDxf(text: string): SubstratImport {
  const perechi = tokenizeaza(text);
  const toate = [...grupeazaToate(perechi)];
  const imagedefs = parseazaImagedefs(toate);
  const blocuri = parseazaBlocuri(toate);
  const entitatiSectiune = toate.filter((e) => e.sectiune === "ENTITIES");
  const grupate = grupeazaInserturi(entitatiSectiune);

  const entitati: EntitateImport[] = [];
  for (const g of grupate) {
    if (esteGrupInsert(g)) {
      entitati.push(...rezolvaInsert(g, blocuri, imagedefs, 0));
      continue;
    }
    if (g.tip === "IMAGE") {
      const img = parseImage(g.campuri, imagedefs);
      if (img) entitati.push(img);
      continue;
    }
    const e = entitateDin(g.tip, g.campuri);
    if (e) entitati.push(e);
  }
  const layereSet = new Set<string>();
  for (const e of entitati) {
    if (e.layer) layereSet.add(e.layer);
  }
  const layere = [...layereSet].sort();
  return { entitati, anvelopa: anvelopaDin(entitati), layere };
}
