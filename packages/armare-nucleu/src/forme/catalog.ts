import { type Vector2, vec, aduna, distanta, inmulteste, normalizeaza, scade, unghi } from "../geometrie/vector";
import {
  fileteazaColturi,
  fileteazaPoligon,
} from "../geometrie/polilinie";
import { matriceForma, transformaPunct, transformaSegmente } from "../geometrie/transform";
import { razaIndoireMinima } from "./indoire";
import {
  aplicaCiocuri,
  aplicaCiocuriNominal,
  lungimeCiocStandard,
  combinaCiocuri,
  esteCioc180,
  segmenteCiocSfarsit,
  segmenteCiocStart,
} from "./ciocuri";
import type {
  Ciocuri,
  DefinitieForma,
  DefinitieParametru,
  FormaArmare,
  PunctControl,
  Segment,
  TipForma,
  ValoriParametri,
} from "../model/tipuri";
import { offseturiDistributie } from "../model/tipuri";

/** Parametrul "diametru" e comun tuturor formelor (definește și raza de îndoire). */
const PARAM_DIAMETRU: DefinitieParametru = {
  cheie: "diametru",
  eticheta: "Diametru bară Ø",
  valoareImplicita: 12,
  min: 6,
  max: 40,
  unitate: "mm",
};

/** Limitează o valoare în intervalul definit de parametru. */
function limiteaza(def: DefinitieParametru, valoare: number): number {
  let v = valoare;
  if (def.min !== undefined) v = Math.max(def.min, v);
  if (def.max !== undefined) v = Math.min(def.max, v);
  return v;
}

/**
 * Mapare inversă generică drag → parametru. Funcționează pentru toate formele
 * pentru că am ales coordonatele punctelor de control astfel încât componenta
 * de pe axa de mișcare să fie egală cu valoarea parametrului.
 */
function aplicaDeplasareGenerica(
  def: DefinitieForma,
  p: ValoriParametri,
  idPunct: string,
  pozitieNoua: { x: number; y: number },
): ValoriParametri {
  const punct = def.genereazaPuncteControl(p).find((pc) => pc.id === idPunct);
  if (!punct) return p;
  const defParam = def.parametri.find((dp) => dp.cheie === punct.parametru);
  if (!defParam) return p;

  const valoareBruta = punct.axa === "y" ? pozitieNoua.y : pozitieNoua.x;
  return { ...p, [punct.parametru]: limiteaza(defParam, valoareBruta) };
}

// ─── Bară dreaptă ───────────────────────────────────────────────────────────

const DREAPTA: DefinitieForma = {
  tip: "dreapta",
  nume: "Bară dreaptă",
  descriere: "Bară fără îndoituri, definită prin lungime.",
  acceptaCiocuriUtilizator: true,
  parametri: [
    { cheie: "lungime", eticheta: "Lungime", valoareImplicita: 1000, min: 50, unitate: "mm" },
    PARAM_DIAMETRU,
  ],
  genereazaVarfuri(p) {
    return { varfuri: [vec(0, 0), vec(p.lungime!, 0)], inchis: false };
  },
  genereazaPuncteControl(p): PunctControl[] {
    return [
      {
        id: "capat",
        pozitie: vec(p.lungime!, 0),
        parametru: "lungime",
        axa: "x",
        descriere: "Lungimea barei",
      },
    ];
  },
  aplicaDeplasare(p, id, poz) {
    return aplicaDeplasareGenerica(this, p, id, poz);
  },
};

// ─── Bară în L ──────────────────────────────────────────────────────────────

const FORMA_L: DefinitieForma = {
  tip: "L",
  nume: "Bară în L",
  descriere: "Un braț orizontal și unul vertical, cu îndoire pe rază (Eurocod 2).",
  acceptaCiocuriUtilizator: true,
  parametri: [
    { cheie: "a", eticheta: "Braț orizontal (a)", valoareImplicita: 800, min: 50, unitate: "mm" },
    { cheie: "b", eticheta: "Braț vertical (b)", valoareImplicita: 400, min: 50, unitate: "mm" },
    PARAM_DIAMETRU,
  ],
  genereazaVarfuri(p) {
    return { varfuri: [vec(0, 0), vec(p.a!, 0), vec(p.a!, p.b!)], inchis: false };
  },
  genereazaPuncteControl(p): PunctControl[] {
    return [
      { id: "cot", pozitie: vec(p.a!, 0), parametru: "a", axa: "x", descriere: "Braț orizontal" },
      { id: "varf", pozitie: vec(p.a!, p.b!), parametru: "b", axa: "y", descriere: "Braț vertical" },
    ];
  },
  aplicaDeplasare(p, id, poz) {
    return aplicaDeplasareGenerica(this, p, id, poz);
  },
};

// ─── Bară în U (agrafă) ──────────────────────────────────────────────────────

const FORMA_U: DefinitieForma = {
  tip: "U",
  nume: "Bară în U",
  descriere: "Bază orizontală și două brațe verticale (agrafă deschisă).",
  acceptaCiocuriUtilizator: true,
  parametri: [
    { cheie: "a", eticheta: "Lățime bază (a)", valoareImplicita: 600, min: 50, unitate: "mm" },
    { cheie: "b", eticheta: "Înălțime brațe (b)", valoareImplicita: 500, min: 50, unitate: "mm" },
    PARAM_DIAMETRU,
  ],
  genereazaVarfuri(p) {
    return {
      varfuri: [vec(0, p.b!), vec(0, 0), vec(p.a!, 0), vec(p.a!, p.b!)],
      inchis: false,
    };
  },
  genereazaPuncteControl(p): PunctControl[] {
    return [
      { id: "latime", pozitie: vec(p.a!, 0), parametru: "a", axa: "x", descriere: "Lățime bază" },
      {
        id: "inaltime",
        pozitie: vec(p.a!, p.b!),
        parametru: "b",
        axa: "y",
        descriere: "Înălțime brațe",
      },
    ];
  },
  aplicaDeplasare(p, id, poz) {
    return aplicaDeplasareGenerica(this, p, id, poz);
  },
};

// ─── Etrier dreptunghiular (deschis, cu două cârlige 135°) ────────────────────

const ETRIER: DefinitieForma = {
  tip: "etrier",
  nume: "Etrier dreptunghiular",
  descriere: "Contur dreptunghiular cu colțuri fasonate și două cârlige 135° (Eurocod 2 / P100).",
  acceptaCiocuriUtilizator: false,
  parametri: [
    { cheie: "a", eticheta: "Lățime (a)", valoareImplicita: 400, min: 50, unitate: "mm" },
    { cheie: "b", eticheta: "Înălțime (b)", valoareImplicita: 600, min: 50, unitate: "mm" },
    { ...PARAM_DIAMETRU, valoareImplicita: 8 },
  ],
  genereazaVarfuri(p) {
    // Cele 4 colțuri unice ale dreptunghiului (fără duplicarea punctului de închidere).
    // Închiderea și cârligele 135° sunt aplicate în segmenteLocale prin mecanismul
    // polilinie (forma.varfuri), identic cu modul de formare din polilinii.
    return {
      varfuri: [
        vec(0, p.b!),      // TL stânga-sus
        vec(p.a!, p.b!),   // TR dreapta-sus
        vec(p.a!, 0),      // BR dreapta-jos
        vec(0, 0),         // BL stânga-jos
      ],
      inchis: false,
    };
  },
  ciocuriIntrinseci(p) {
    // Cele două cârlige de închidere (135°) cu extensia dreaptă standard (10·Ø).
    // Geometria efectivă a buclei 180° e construită în `construiesteEtrier`; aici
    // păstrăm doar lungimea cârligului, pentru adnotații și extras.
    const cioc = { unghi: 135, lungime: lungimeCiocStandard(p.diametru!, 135), flipuit: true };
    return { start: cioc, sfarsit: cioc };
  },
  genereazaPuncteControl(p): PunctControl[] {
    return [
      {
        id: "latime",
        pozitie: vec(p.a!, p.b! / 2),
        parametru: "a",
        axa: "x",
        descriere: "Lățime etrier",
      },
      {
        id: "inaltime",
        pozitie: vec(p.a! / 2, 0),
        parametru: "b",
        axa: "y",
        descriere: "Înălțime etrier",
      },
    ];
  },
  aplicaDeplasare(p, id, poz) {
    return aplicaDeplasareGenerica(this, p, id, poz);
  },
};

// ─── Polilinie personalizată (vârfuri libere, rază de filet setabilă) ─────────

/** Vârfurile implicite pentru o polilinie nouă (coordonate locale). */
export function varfuriImplicitePolilinie(): Vector2[] {
  return [vec(0, 0), vec(600, 0), vec(600, 400), vec(1000, 400)];
}

const POLILINIE: DefinitieForma = {
  tip: "polilinie",
  nume: "Polilinie",
  descriere: "Traseu liber din mai multe vârfuri, cu filet de rază reglabilă la fiecare colț.",
  acceptaCiocuriUtilizator: true,
  parametri: [
    { cheie: "razaIndoire", eticheta: "Rază filet", valoareImplicita: 40, min: 0, unitate: "mm" },
    PARAM_DIAMETRU,
  ],
  // Geometria și punctele de control sunt gestionate forma-aware (vârfuri pe FormaArmare).
  genereazaVarfuri() {
    return { varfuri: [], inchis: false };
  },
  genereazaPuncteControl() {
    return [];
  },
  aplicaDeplasare(p) {
    return p;
  },
};

// ─── Bară în secțiune (cerc plin) ────────────────────────────────────────────

const BARA_SECTIUNE: DefinitieForma = {
  tip: "bara-sectiune",
  nume: "Bară în secțiune",
  descriere: "Bară văzută în secțiune transversală (cerc plin de diametrul barei).",
  acceptaCiocuriUtilizator: false,
  parametri: [
    PARAM_DIAMETRU,
    { cheie: "lungimeBara", eticheta: "Lungime reală bară", valoareImplicita: 1000, min: 0, unitate: "mm" },
  ],
  genereazaVarfuri() {
    return { varfuri: [], inchis: false };
  },
  genereazaPuncteControl() {
    return [];
  },
  aplicaDeplasare(p) {
    return p;
  },
};

// ─── Etrier în vedere laterală (linie verticală) ─────────────────────────────

const ETRIER_LATERAL: DefinitieForma = {
  tip: "etrier-lateral",
  nume: "Etrier — vedere laterală",
  descriere: "Etrier văzut din lateral (linie verticală de înălțimea secțiunii).",
  acceptaCiocuriUtilizator: false,
  parametri: [
    { cheie: "inaltime", eticheta: "Înălțime", valoareImplicita: 600, min: 50, unitate: "mm" },
    { ...PARAM_DIAMETRU, valoareImplicita: 8 },
  ],
  genereazaVarfuri(p) {
    return { varfuri: [vec(0, 0), vec(0, p.inaltime!)], inchis: false };
  },
  genereazaPuncteControl(p): PunctControl[] {
    return [
      {
        id: "capat",
        pozitie: vec(0, p.inaltime!),
        parametru: "inaltime",
        axa: "y",
        descriere: "Înălțimea etrierului",
      },
    ];
  },
  aplicaDeplasare(p, id, poz) {
    return aplicaDeplasareGenerica(this, p, id, poz);
  },
};

/** Lista definițiilor de armare (pentru paleta din interfață). */
export const LISTA_FORME: DefinitieForma[] = [
  DREAPTA, FORMA_L, FORMA_U, ETRIER, POLILINIE, BARA_SECTIUNE, ETRIER_LATERAL,
];

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Forme de COFRAJ (contururi de beton: secțiuni, vederi) ─────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const PARAM_RAZA_COLTURI: DefinitieParametru = {
  cheie: "razaIndoire",
  eticheta: "Rază colțuri",
  valoareImplicita: 0,
  min: 0,
  unitate: "mm",
};

// ─── Cofraj: Grindă dreptunghiulară ─────────────────────────────────────────

const COFRAJ_GRINDA: DefinitieForma = {
  tip: "cofraj-grinda",
  categorie: "cofraj",
  nume: "Grindă dreptunghiulară",
  descriere: "Secțiune dreptunghiulară de grindă. Origine: colț stânga-jos.",
  acceptaCiocuriUtilizator: false,
  parametri: [
    { cheie: "b", eticheta: "Lățime secțiune (b)", valoareImplicita: 300, min: 30, unitate: "mm" },
    { cheie: "h", eticheta: "Înălțime secțiune (h)", valoareImplicita: 600, min: 30, unitate: "mm" },
    PARAM_RAZA_COLTURI,
  ],
  genereazaVarfuri(p) {
    return {
      varfuri: [vec(0, 0), vec(p.b!, 0), vec(p.b!, p.h!), vec(0, p.h!)],
      inchis: true,
    };
  },
  genereazaPuncteControl(p): PunctControl[] {
    return [
      { id: "b", pozitie: vec(p.b!, p.h! / 2), parametru: "b", axa: "x", descriere: "Lățime" },
      { id: "h", pozitie: vec(p.b! / 2, p.h!), parametru: "h", axa: "y", descriere: "Înălțime" },
    ];
  },
  aplicaDeplasare(p, id, poz) { return aplicaDeplasareGenerica(this, p, id, poz); },
};

// ─── Cofraj: Grindă T ────────────────────────────────────────────────────────

const COFRAJ_GRINDA_T: DefinitieForma = {
  tip: "cofraj-grinda-T",
  categorie: "cofraj",
  nume: "Grindă T",
  descriere: "Secțiune în T (inimă + talpă superioară). Origine: centrul bazei inimii.",
  acceptaCiocuriUtilizator: false,
  parametri: [
    { cheie: "bw", eticheta: "Lățime inimă (bw)", valoareImplicita: 300, min: 30, unitate: "mm" },
    { cheie: "hw", eticheta: "Înălțime inimă (hw)", valoareImplicita: 450, min: 30, unitate: "mm" },
    { cheie: "bf", eticheta: "Lățime talpă (bf)", valoareImplicita: 700, min: 30, unitate: "mm" },
    { cheie: "tf", eticheta: "Grosime talpă (tf)", valoareImplicita: 120, min: 20, unitate: "mm" },
    PARAM_RAZA_COLTURI,
  ],
  genereazaVarfuri(p) {
    const bw = p.bw!, hw = p.hw!, bf = p.bf!, tf = p.tf!;
    return {
      varfuri: [
        vec(-bw / 2, 0), vec(bw / 2, 0),
        vec(bw / 2, hw), vec(bf / 2, hw), vec(bf / 2, hw + tf),
        vec(-bf / 2, hw + tf), vec(-bf / 2, hw), vec(-bw / 2, hw),
      ],
      inchis: true,
    };
  },
  genereazaPuncteControl(p): PunctControl[] {
    const bw = p.bw!, hw = p.hw!, bf = p.bf!, tf = p.tf!;
    return [
      { id: "bw", pozitie: vec(bw / 2, hw / 2), parametru: "bw", axa: "x", descriere: "Lățime inimă" },
      { id: "hw", pozitie: vec(bw / 2, hw), parametru: "hw", axa: "y", descriere: "Înălțime inimă" },
      { id: "bf", pozitie: vec(bf / 2, hw + tf / 2), parametru: "bf", axa: "x", descriere: "Lățime talpă" },
      { id: "tf", pozitie: vec(bf / 4, hw + tf), parametru: "tf", axa: "y", descriere: "Grosime talpă" },
    ];
  },
  aplicaDeplasare(p, id, poz) {
    const hw = p.hw ?? 450;
    switch (id) {
      case "bw": return { ...p, bw: Math.max(30, Math.round(Math.abs(poz.x) * 2)) };
      case "hw": return { ...p, hw: Math.max(30, Math.round(poz.y)) };
      case "bf": return { ...p, bf: Math.max(p.bw ?? 200, Math.round(Math.abs(poz.x) * 2)) };
      case "tf": return { ...p, tf: Math.max(20, Math.round(poz.y - hw)) };
      default: return p;
    }
  },
};

// ─── Cofraj: Stâlp ───────────────────────────────────────────────────────────

const COFRAJ_STALP: DefinitieForma = {
  tip: "cofraj-stalp",
  categorie: "cofraj",
  nume: "Stâlp dreptunghiular",
  descriere: "Secțiune dreptunghiulară de stâlp. Origine: colț stânga-jos.",
  acceptaCiocuriUtilizator: false,
  parametri: [
    { cheie: "b", eticheta: "Lățime secțiune (b)", valoareImplicita: 400, min: 30, unitate: "mm" },
    { cheie: "h", eticheta: "Înălțime secțiune (h)", valoareImplicita: 400, min: 30, unitate: "mm" },
    PARAM_RAZA_COLTURI,
  ],
  genereazaVarfuri(p) {
    return {
      varfuri: [vec(0, 0), vec(p.b!, 0), vec(p.b!, p.h!), vec(0, p.h!)],
      inchis: true,
    };
  },
  genereazaPuncteControl(p): PunctControl[] {
    return [
      { id: "b", pozitie: vec(p.b!, p.h! / 2), parametru: "b", axa: "x", descriere: "Lățime" },
      { id: "h", pozitie: vec(p.b! / 2, p.h!), parametru: "h", axa: "y", descriere: "Înălțime" },
    ];
  },
  aplicaDeplasare(p, id, poz) { return aplicaDeplasareGenerica(this, p, id, poz); },
};

// ─── Cofraj: Fundație T-răsturnat ────────────────────────────────────────────

const COFRAJ_FUNDATIE: DefinitieForma = {
  tip: "cofraj-fundatie",
  categorie: "cofraj",
  nume: "Fundație T-răsturnat",
  descriere: "Secțiune fundație cu talpă și grindă de fundație. Origine: centrul bazei tălpii.",
  acceptaCiocuriUtilizator: false,
  parametri: [
    { cheie: "bt", eticheta: "Lățime talpă (bt)", valoareImplicita: 1000, min: 50, unitate: "mm" },
    { cheie: "ht", eticheta: "Înălțime talpă (ht)", valoareImplicita: 300, min: 50, unitate: "mm" },
    { cheie: "bg", eticheta: "Lățime grindă (bg)", valoareImplicita: 400, min: 50, unitate: "mm" },
    { cheie: "hg", eticheta: "Înălțime grindă (hg)", valoareImplicita: 500, min: 50, unitate: "mm" },
    PARAM_RAZA_COLTURI,
  ],
  genereazaVarfuri(p) {
    const bt = p.bt!, ht = p.ht!, bg = p.bg!, hg = p.hg!;
    return {
      varfuri: [
        vec(-bt / 2, 0), vec(bt / 2, 0),
        vec(bt / 2, ht), vec(bg / 2, ht), vec(bg / 2, ht + hg),
        vec(-bg / 2, ht + hg), vec(-bg / 2, ht), vec(-bt / 2, ht),
      ],
      inchis: true,
    };
  },
  genereazaPuncteControl(p): PunctControl[] {
    const bt = p.bt!, ht = p.ht!, bg = p.bg!, hg = p.hg!;
    return [
      { id: "bt", pozitie: vec(bt / 2, ht / 2), parametru: "bt", axa: "x", descriere: "Lățime talpă" },
      { id: "ht", pozitie: vec(bt / 4, ht), parametru: "ht", axa: "y", descriere: "Înălțime talpă" },
      { id: "bg", pozitie: vec(bg / 2, ht + hg / 2), parametru: "bg", axa: "x", descriere: "Lățime grindă" },
      { id: "hg", pozitie: vec(bg / 4, ht + hg), parametru: "hg", axa: "y", descriere: "Înălțime grindă" },
    ];
  },
  aplicaDeplasare(p, id, poz) {
    const ht = p.ht ?? 300;
    switch (id) {
      case "bt": return { ...p, bt: Math.max(50, Math.round(Math.abs(poz.x) * 2)) };
      case "ht": return { ...p, ht: Math.max(50, Math.round(poz.y)) };
      case "bg": return { ...p, bg: Math.max(50, Math.round(Math.abs(poz.x) * 2)) };
      case "hg": return { ...p, hg: Math.max(50, Math.round(poz.y - ht)) };
      default: return p;
    }
  },
};

// ─── Cofraj: Polilinie liberă ─────────────────────────────────────────────────

const COFRAJ_POLILINIE: DefinitieForma = {
  tip: "cofraj-polilinie",
  categorie: "cofraj",
  nume: "Polilinie cofraj",
  descriere: "Contur liber din vârfuri, pentru secțiuni sau vederi nestandard.",
  acceptaCiocuriUtilizator: false,
  parametri: [
    { cheie: "razaIndoire", eticheta: "Rază colțuri", valoareImplicita: 0, min: 0, unitate: "mm" },
  ],
  genereazaVarfuri() { return { varfuri: [], inchis: false }; },
  genereazaPuncteControl() { return []; },
  aplicaDeplasare(p) { return p; },
};

/** Lista definițiilor de COFRAJ (pentru paleta din interfață). */
export const LISTA_FORME_COFRAJ: DefinitieForma[] = [
  COFRAJ_GRINDA, COFRAJ_GRINDA_T, COFRAJ_STALP, COFRAJ_FUNDATIE, COFRAJ_POLILINIE,
];

/** Întoarce categoria unei forme: "armare" (implicit) sau "cofraj". */
export function categorieForma(tip: TipForma): "armare" | "cofraj" {
  return definitiePentru(tip).categorie ?? "armare";
}

/** Catalogul tuturor definițiilor de forme, indexat după tip. */
export const CATALOG_FORME: Record<TipForma, DefinitieForma> = {
  dreapta: DREAPTA,
  L: FORMA_L,
  U: FORMA_U,
  etrier: ETRIER,
  polilinie: POLILINIE,
  "bara-sectiune": BARA_SECTIUNE,
  "etrier-lateral": ETRIER_LATERAL,
  "cofraj-grinda": COFRAJ_GRINDA,
  "cofraj-grinda-T": COFRAJ_GRINDA_T,
  "cofraj-stalp": COFRAJ_STALP,
  "cofraj-fundatie": COFRAJ_FUNDATIE,
  "cofraj-polilinie": COFRAJ_POLILINIE,
};

/** Întoаrce definiția pentru un tip dat. */
export function definitiePentru(tip: TipForma): DefinitieForma {
  return CATALOG_FORME[tip];
}

/**
 * Construiește geometria unui traseu deschis: ciocurile non-180° devin vârfuri
 * filetate, iar cele 180° se adaugă ca semicercuri explicite.
 */
function construiesteDeschis(varfuri: Vector2[], raza: number, ciocuri?: Ciocuri): Segment[] {
  let segmente = fileteazaColturi(aplicaCiocuri(varfuri, ciocuri), raza);

  if (ciocuri && varfuri.length >= 2) {
    if (esteCioc180(ciocuri.sfarsit)) {
      const v1 = varfuri[varfuri.length - 1]!;
      const v0 = varfuri[varfuri.length - 2]!;
      const d = normalizeaza(scade(v1, v0));
      const sensSf = ciocuri.sfarsit!.flipuit ? -1 : 1;
      segmente = [...segmente, ...segmenteCiocSfarsit(v1, d, raza, ciocuri.sfarsit!, sensSf)];
    }
    if (esteCioc180(ciocuri.start)) {
      const a = varfuri[0]!;
      const b = varfuri[1]!;
      const d0 = normalizeaza(scade(b, a));
      const sensSt = ciocuri.start!.flipuit ? -1 : 1;
      segmente = [...segmenteCiocStart(a, d0, raza, ciocuri.start!, sensSt), ...segmente];
    }
  }
  return segmente;
}

/**
 * Geometria etrierului dreptunghiular cu închidere la colțul stânga-sus (TL).
 * Trei colțuri (TR, BR, BL) se filetează normal (90°), iar colțul TL e DESCHIS:
 * arcul de fasonare se prelungește la 180° (semicerc, 90° + 45° pe fiecare capăt),
 * iar din cele două capete libere pleacă două cozi drepte paralele, tangente la
 * arc, spre colțul diametral opus (BR). Vârfurile sosesc în ordinea
 * [TL, TR, BR, BL] (coordonate locale, dreptunghi aliniat la axe).
 */
function construiesteEtrier(varfuri: Vector2[], raza: number, lungimeCioc: number): Segment[] {
  if (varfuri.length < 4 || raza <= 0) return fileteazaPoligon(varfuri, raza);
  const TL = varfuri[0]!;
  const TR = varfuri[1]!;
  const BR = varfuri[2]!;
  const BL = varfuri[3]!;
  const r = raza;
  const s = r * Math.SQRT1_2; // r · sin45°

  // Cercul de fasonare din colțul TL și punctele de tangență pe cele două laturi.
  const C = vec(TL.x + r, TL.y - r); // centru
  const A = vec(TL.x, TL.y - r);     // tangentă pe latura stângă (la 180°)
  const B = vec(TL.x + r, TL.y);     // tangentă pe latura de sus (la 90°)
  const E1 = vec(C.x - s, C.y - s);  // capăt semicerc, 225°
  const E2 = vec(C.x + s, C.y + s);  // capăt semicerc, 45°

  // Cozile drepte: bisectoarea colțului (tangenta semicercului), spre interior/BR.
  const tdir = normalizeaza(vec(1, -1));
  const T1 = aduna(E1, inmulteste(tdir, lungimeCioc));
  const T2 = aduna(E2, inmulteste(tdir, lungimeCioc));

  // Corpul: latura stângă (A→BL), jos, dreapta, sus (→B), cu cele 3 colțuri filetate.
  const corpul = fileteazaColturi([A, BL, BR, TR, B], r);

  const arcE1A: Segment = {
    tip: "arc",
    centru: C,
    raza: r,
    unghiStart: unghi(scade(E1, C)),
    unghiSfarsit: unghi(scade(A, C)),
    sensOrar: true,
  };
  const arcBE2: Segment = {
    tip: "arc",
    centru: C,
    raza: r,
    unghiStart: unghi(scade(B, C)),
    unghiSfarsit: unghi(scade(E2, C)),
    sensOrar: true,
  };
  // Arcul de închidere al colțului (A→B, cele 90° „lipsă"), ca dreptunghiul să
  // apară închis. Nu face parte din firul continuu al cârligelor, deci se adaugă
  // ca lanț separat (randat ca subtraseu distinct).
  const arcInchidere: Segment = {
    tip: "arc",
    centru: C,
    raza: r,
    unghiStart: unghi(scade(A, C)),
    unghiSfarsit: unghi(scade(B, C)),
    sensOrar: true,
  };

  return [
    { tip: "linie", start: T1, sfarsit: E1 },
    arcE1A,
    ...corpul,
    arcBE2,
    { tip: "linie", start: E2, sfarsit: T2 },
    arcInchidere,
  ];
}

/** Raza de filet folosită de o formă (override la polilinie, altfel Eurocod 2). */
export function razaForma(forma: FormaArmare): number {
  const def = definitiePentru(forma.tip);
  if (def.categorie === "cofraj") return forma.parametri.razaIndoire ?? 0;
  if (forma.tip === "polilinie" && forma.parametri.razaIndoire !== undefined) {
    return forma.parametri.razaIndoire;
  }
  return razaIndoireMinima(forma.parametri.diametru ?? 10);
}

/** Geometria în coordonate LOCALE (înainte de oglindire/rotație și de plasare). */
function segmenteLocale(forma: FormaArmare): Segment[] {
  if (forma.tip === "polilinie" || forma.tip === "cofraj-polilinie") {
    const varfuri = forma.varfuri ?? [];
    if (varfuri.length < 2) return [];
    const ciocuri = forma.tip === "polilinie" ? combinaCiocuri(undefined, forma.ciocuri) : undefined;
    if (forma.inchis && varfuri.length >= 3) {
      return construiesteDeschis([...varfuri, varfuri[0]!], razaForma(forma), ciocuri);
    }
    return construiesteDeschis(varfuri, razaForma(forma), ciocuri);
  }

  if (forma.tip === "etrier") {
    // Etrierul folosește forma.varfuri (cele 4 colțuri); închiderea cu buclă 180°
    // și cele două cozi sunt construite de `construiesteEtrier`.
    const varfuri = forma.varfuri ?? definitiePentru("etrier").genereazaVarfuri(forma.parametri).varfuri;
    if (varfuri.length < 4) return [];
    const lungimeCioc = lungimeCiocStandard(forma.parametri.diametru ?? 8, 135);
    return construiesteEtrier(varfuri, razaForma(forma), lungimeCioc);
  }

  const def = definitiePentru(forma.tip);
  const { varfuri, inchis } = def.genereazaVarfuri(forma.parametri);
  const raza = razaForma(forma);
  if (inchis) return fileteazaPoligon(varfuri, raza);

  const ciocuri = combinaCiocuri(
    def.ciocuriIntrinseci?.(forma.parametri),
    def.acceptaCiocuriUtilizator ? forma.ciocuri : undefined,
  );
  return construiesteDeschis(varfuri, raza, ciocuri);
}

/**
 * Generează geometria completă (segmente) a unei forme plasate, incluzând
 * filetarea colțurilor, ciocurile și transformarea de oglindire/rotație.
 * Coordonate locale (originea 0,0); plasarea pe planșă se aplică separat.
 */
export function segmenteForma(forma: FormaArmare): Segment[] {
  return transformaSegmente(matriceForma(forma), segmenteLocale(forma));
}

/**
 * Reprezentarea de tip cerc plin (bară în secțiune), în coordonate locale.
 * Întoarce null pentru formele desenate ca linii. Centrul e originea (0,0),
 * neafectat de oglindire/rotație.
 */
export function cercForma(forma: FormaArmare): { centru: Vector2; raza: number } | null {
  if (forma.tip !== "bara-sectiune") return null;
  return { centru: { x: 0, y: 0 }, raza: (forma.parametri.diametru ?? 10) / 2 };
}

/** Punctele de control în coordonate locale (înainte de transformare). */
function puncteControlLocale(forma: FormaArmare): PunctControl[] {
  if (forma.tip === "polilinie" || forma.tip === "etrier" || forma.tip === "cofraj-polilinie") {
    return (forma.varfuri ?? []).map((v, i) => ({
      id: `v${i}`,
      pozitie: v,
      parametru: `v${i}`,
      axa: "libera" as const,
      descriere: `Vârf ${i + 1}`,
    }));
  }
  return definitiePentru(forma.tip).genereazaPuncteControl(forma.parametri);
}

/** Punctele de control ale unei forme, cu oglindirea/rotația aplicate (pentru afișare). */
export function puncteControlForma(forma: FormaArmare): PunctControl[] {
  const m = matriceForma(forma);
  return puncteControlLocale(forma).map((pc) => ({
    ...pc,
    pozitie: transformaPunct(m, pc.pozitie),
  }));
}

/** Un segment NOMINAL (drept, vârf-la-vârf sau cioc), folosit pentru dimensiunile brute. */
export interface SegmentNominal {
  start: Vector2;
  sfarsit: Vector2;
  /** Lungimea brută (vârf-la-vârf / lungimea ciocului), fără reducerea din filet. */
  lungime: number;
  /** True dacă segmentul e un cioc (cârlig), nu o latură a barei. */
  cioc: boolean;
}

/**
 * Polilinia NOMINALĂ a unei forme (coordonate locale, înainte de transformare):
 * vârfurile de colț + ciocurile, ca segmente drepte, FĂRĂ filetarea colțurilor.
 * Reprezintă dimensiunile „brute" (de cotare / debitare), nu geometria reală.
 */
function segmenteNominaleLocale(forma: FormaArmare): SegmentNominal[] {
  if (forma.tip === "bara-sectiune") return [];

  // Vârfurile de bază, închiderea și ciocurile (oglindă a `segmenteLocale`).
  let varfuri: Vector2[];
  let inchis: boolean;
  let ciocuri: Ciocuri | undefined;

  if (forma.tip === "polilinie" || forma.tip === "cofraj-polilinie") {
    varfuri = forma.varfuri ?? [];
    inchis = !!forma.inchis && varfuri.length >= 3;
    ciocuri = forma.tip === "polilinie" ? combinaCiocuri(undefined, forma.ciocuri) : undefined;
  } else if (forma.tip === "etrier") {
    varfuri = forma.varfuri ?? definitiePentru("etrier").genereazaVarfuri(forma.parametri).varfuri;
    inchis = true;
    ciocuri = definitiePentru("etrier").ciocuriIntrinseci?.(forma.parametri);
  } else {
    const def = definitiePentru(forma.tip);
    const g = def.genereazaVarfuri(forma.parametri);
    varfuri = g.varfuri;
    inchis = g.inchis;
    ciocuri = combinaCiocuri(
      def.ciocuriIntrinseci?.(forma.parametri),
      def.acceptaCiocuriUtilizator ? forma.ciocuri : undefined,
    );
  }

  if (varfuri.length < 2) return [];

  const baza = inchis ? [...varfuri, varfuri[0]!] : varfuri;
  const areCioc = !!ciocuri && (!!ciocuri.start || !!ciocuri.sfarsit);
  const { varfuri: pts, areStart, areSfarsit } = areCioc
    ? aplicaCiocuriNominal(baza, ciocuri)
    : { varfuri: baza, areStart: false, areSfarsit: false };

  const segmente: SegmentNominal[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const cioc = (areStart && i === 0) || (areSfarsit && i === pts.length - 2);
    segmente.push({ start: a, sfarsit: b, lungime: distanta(a, b), cioc });
  }
  return segmente;
}

/**
 * Segmentele NOMINALE ale unei forme plasate (cu oglindire/rotație aplicate,
 * coordonate locale, origine 0,0). Lungimile sunt cele BRUTE (vârf-la-vârf și
 * lungimile ciocurilor), nu cele reale reduse de filetarea colțurilor.
 */
export function segmenteNominale(forma: FormaArmare): SegmentNominal[] {
  const m = matriceForma(forma);
  return segmenteNominaleLocale(forma).map((s) => ({
    start: transformaPunct(m, s.start),
    sfarsit: transformaPunct(m, s.sfarsit),
    lungime: s.lungime,
    cioc: s.cioc,
  }));
}

/** Ciocurile efective ale unei forme (intrinseci + utilizator), ca în segmenteNominaleLocale. */
function ciocuriEfectiveForma(forma: FormaArmare): Ciocuri | undefined {
  if (forma.tip === "polilinie") return combinaCiocuri(undefined, forma.ciocuri);
  if (forma.tip === "cofraj-polilinie") return undefined;
  if (forma.tip === "etrier") return definitiePentru("etrier").ciocuriIntrinseci?.(forma.parametri);
  const def = definitiePentru(forma.tip);
  return combinaCiocuri(
    def.ciocuriIntrinseci?.(forma.parametri),
    def.acceptaCiocuriUtilizator ? forma.ciocuri : undefined,
  );
}

/**
 * Lungimea desfășurată (de debitare) a unei bare, în mm. Folosește dimensiunile
 * BRUTE (vârf-la-vârf + lungimile ciocurilor), nu lungimile reale reduse de
 * filetarea colțurilor — conform practicii de cotare/extras.
 *
 * Excepție: cârligele 180° (semicirculare) includ și arcul semicircular π·r,
 * pe lângă extensia dreaptă — segmentul nominal vârf-la-vârf nu îl surprinde.
 */
export function lungimeDesfasurata(forma: FormaArmare): number {
  // Bara în secțiune e un simbol; lungimea reală se introduce ca parametru.
  if (forma.tip === "bara-sectiune") return forma.parametri.lungimeBara ?? 0;
  let total = segmenteNominaleLocale(forma).reduce((t, seg) => t + seg.lungime, 0);

  const ciocuri = ciocuriEfectiveForma(forma);
  if (ciocuri) {
    const raza = razaForma(forma);
    if (esteCioc180(ciocuri.start)) total += Math.PI * raza;
    if (esteCioc180(ciocuri.sfarsit)) total += Math.PI * raza;
  }
  return total;
}

/**
 * Toate pozițiile de inserție generate de array-ul 2D al formei.
 * Suportă atât distribuție uniformă cât și variabilă (zone).
 * Fără array (sau array cu nr=1): întoarce [pozitie].
 */
export function pozitiiArray(forma: FormaArmare): Vector2[] {
  const arr = forma.array;
  if (!arr) return [forma.pozitie];
  const ofX = offseturiDistributie(arr, "x");
  const ofY = offseturiDistributie(arr, "y");
  // Include originea (0,0)
  const allX = [0, ...ofX];
  const allY = [0, ...ofY];
  if (allX.length <= 1 && allY.length <= 1) return [forma.pozitie];
  const pozitii: Vector2[] = [];
  for (const dy of allY) {
    for (const dx of allX) {
      pozitii.push({ x: forma.pozitie.x + dx, y: forma.pozitie.y + dy });
    }
  }
  return pozitii;
}

/**
 * Puncte de ancorare leader pentru fiecare instanță a array-ului 2D,
 * derivate din punctul de referință al instanței de origine.
 */
export function referinteLeaderArray(forma: FormaArmare, punctReferintaOrigine: Vector2): Vector2[] {
  const arr = forma.array;
  if (!arr) return [punctReferintaOrigine];
  const ofX = [0, ...offseturiDistributie(arr, "x")];
  const ofY = [0, ...offseturiDistributie(arr, "y")];
  const refs: Vector2[] = [];
  for (const dy of ofY) {
    for (const dx of ofX) {
      refs.push({
        x: punctReferintaOrigine.x + dx,
        y: punctReferintaOrigine.y + dy,
      });
    }
  }
  return refs;
}

/** Indecșii vizibili în modul abstract pentru n elemente (1, 2 sau 3: primul, mijlocul, ultimul). */
function indiciAbstracti(n: number): number[] {
  if (n <= 1) return [0];
  if (n === 2) return [0, 1];
  if (n === 3) return [0, 1, 2];
  return [0, Math.floor((n - 1) / 2), n - 1];
}

/**
 * Pozițiile vizibile în modul abstract: maximum 3 pe fiecare axă (primul/mijlocul/ultimul).
 * Suportă distribuție variabilă (zone).
 */
export function pozitiiArrayAbstract(forma: FormaArmare): Vector2[] {
  const arr = forma.array;
  if (!arr) return [forma.pozitie];
  const allX = [0, ...offseturiDistributie(arr, "x")];
  const allY = [0, ...offseturiDistributie(arr, "y")];
  if (allX.length <= 1 && allY.length <= 1) return [forma.pozitie];
  const ixViz = indiciAbstracti(allX.length);
  const iyViz = indiciAbstracti(allY.length);
  const set = new Set<string>();
  const result: Vector2[] = [];
  for (const iy of iyViz) {
    for (const ix of ixViz) {
      const k = `${ix},${iy}`;
      if (!set.has(k)) {
        set.add(k);
        result.push({ x: forma.pozitie.x + (allX[ix] ?? 0), y: forma.pozitie.y + (allY[iy] ?? 0) });
      }
    }
  }
  return result;
}
