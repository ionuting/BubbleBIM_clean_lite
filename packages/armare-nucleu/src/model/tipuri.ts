import type { Vector2 } from "../geometrie/vector";
import type { AncoraCota } from "./cofraj";

/**
 * Tipurile de forme de armare suportate de catalog.
 * `bara-sectiune` = bară văzută în secțiune (cerc plin); `etrier-lateral` =
 * etrier în vedere laterală (linie verticală).
 */
export type TipForma =
  | "dreapta"
  | "L"
  | "U"
  | "etrier"
  | "polilinie"
  | "bara-sectiune"
  | "etrier-lateral"
  // ── Cofraj (contururi de beton / secțiuni și vederi) ──
  | "cofraj-grinda"
  | "cofraj-grinda-T"
  | "cofraj-stalp"
  | "cofraj-fundatie"
  | "cofraj-polilinie";

/** Valorile concrete ale parametrilor unei forme (cheie -> valoare în mm sau grade). */
export type ValoriParametri = Record<string, number>;

/** Definiția unui parametru editabil al unei forme (folosit la generarea panoului de proprietăți). */
export interface DefinitieParametru {
  /** Cheia internă, ex. "a". */
  cheie: string;
  /** Eticheta afișată în interfață. */
  eticheta: string;
  valoareImplicita: number;
  min?: number;
  max?: number;
  unitate: "mm" | "grade";
}

/**
 * Un segment de geometrie rezultat din parametri: fie o linie dreaptă,
 * fie un arc (îndoirea barei pe raza de fasonare).
 */
export type Segment =
  | {
      tip: "linie";
      start: Vector2;
      sfarsit: Vector2;
    }
  | {
      tip: "arc";
      centru: Vector2;
      raza: number;
      /** Unghi de început, radiani. */
      unghiStart: number;
      /** Unghi de sfârșit, radiani. */
      unghiSfarsit: number;
      /** true dacă arcul se parcurge în sens orar. */
      sensOrar: boolean;
    };

/** Axa pe care se poate mișca un punct de control. */
export type AxaControl = "x" | "y" | "libera";

/**
 * Un punct de control ("grip") expus pe canvas. Tragerea lui modifică
 * unul sau mai mulți parametri ai formei — analog dynamic blocks din AutoCAD.
 */
export interface PunctControl {
  id: string;
  pozitie: Vector2;
  /** Cheia parametrului influențat. */
  parametru: string;
  axa: AxaControl;
  descriere: string;
}

/**
 * Un cioc (cârlig / cot) la capătul unei bare. `unghi` = unghiul de îndoire al
 * ciocului (90° cot, 135° cârlig); `lungime` = extensia dreaptă după îndoire (mm).
 */
export interface Cioc {
  unghi: number;
  lungime: number;
  /** Dacă este true, ciocul este oglindit față de axa barei. */
  flipuit?: boolean;
}

/** Ciocurile de la cele două capete ale unei bare deschise. */
export interface Ciocuri {
  start?: Cioc;
  sfarsit?: Cioc;
}

/** Tipul de vedere al unei forme pe planșă. */
export type TipVedere = "frontal" | "sus" | "lateral" | "sectiune";

/**
 * Offset și rotație manuală ale unui element de adnotație față de poziția sa calculată.
 * Stocate în coordonate Konva (y în jos, rotație în grade clockwise).
 */
export interface OffsetAdnotatie {
  /** Offset pe axa X față de poziția de bază calculată (px în spațiul grupului formei). */
  dx: number;
  /** Offset pe axa Y față de poziția de bază calculată (px în spațiul grupului formei). */
  dy: number;
  /** Rotație clockwise în grade față de orientarea implicită. */
  rotatie?: number;
}

/**
 * Setări de adnotații afișate direct pe o formă de armare (cotări pe segmente,
 * balon de marcă etc.). Fiecare câmp controlează vizibilitatea unui tip de info.
 */
export interface AdnotatiiForma {
  /** Afișează lungimile segmentelor (cotarea directă pe bară). */
  lungimi?: boolean;
  /** Afișează lungimile ciocurilor. */
  ciocuri?: boolean;
  /** Afișează balonul de marcă (cerc cu număr). */
  marca?: boolean;
  /** Afișează diametrul în balon/etichetă. */
  diametru?: boolean;
  /** Afișează numărul de bare. */
  numar?: boolean;
  /** Afișează pasul (la array). */
  pas?: boolean;
  /**
   * Offset-uri manuale per element de adnotație.
   * Cheile: "seg-0", "seg-1", ..., "marca", "cioc-start", "cioc-sfarsit", "len-sus", "len-lat"
   */
  offseturi?: Record<string, OffsetAdnotatie>;
  /** Override dimensiune text (mm). Dacă absent, se folosește setarea globală. */
  marime?: number;
  /** Override culoare text. Dacă absent, se folosește setarea globală. */
  culoare?: string;
}

/** O instanță de formă de armare plasată pe planșă. */
export interface FormaArmare {
  id: string;
  tip: TipForma;
  nume: string;
  /** Marca (numărul de poziție) afișat în extrasul de armare. */
  marca: number;
  /** Numărul de bare identice cu această formă. */
  numar: number;
  /** Punctul de inserție (originea locală 0,0) pe planșă, în mm. */
  pozitie: Vector2;
  parametri: ValoriParametri;
  /** Ciocuri adăugate de utilizator la capete (doar la formele deschise). */
  ciocuri?: Ciocuri;
  /** Oglindire pe axa X (stânga-dreapta). */
  oglinditX?: boolean;
  /** Oglindire pe axa Y (sus-jos). */
  oglinditY?: boolean;
  /** Rotație în jurul punctului de inserție, în grade (sens trigonometric). */
  rotatie?: number;
  /** Vârfurile poliliniei personalizate (doar pentru tipul "polilinie"), coordonate locale. */
  varfuri?: Vector2[];
  /** Dacă true, polilinia se închide (ultimul vârf conectat la primul). Valabil pentru "polilinie" și "cofraj-polilinie". */
  inchis?: boolean;
  /** Culoarea de afișare (override față de culoarea implicită a tipului). */
  culoare?: string;
  /** Grosimea liniei de afișare (mm); implicit = diametrul barei. */
  grosimeLinie?: number;
  /** Array 2D de copii ale acestei forme. */
  array?: Array2D;
  /**
   * Dacă true, forma este exclusă din extrasul de armare (bar bending schedule).
   * Util pentru vederi duble (plan + secțiune) unde bara apare de mai multe ori.
   */
  excludeExtras?: boolean;
  /**
   * Tipul de vedere: "frontal" (forma completă), "sus" (linie = lățimea/lungimea etrierului),
   * "lateral" (linie = înălțimea), "sectiune" (cerc plin Ø bară). Implicit = "frontal".
   */
  vedere?: TipVedere;
  /** ID-ul formei originale (dacă aceasta este o duplicare ca altă vedere). */
  idOriginal?: string;
  /** Setări de adnotații afișate pe formă. Dacă absent → fără adnotații pe formă. */
  adnotatiiForma?: AdnotatiiForma;
  /**
   * Acoperire de beton (mm). Dacă > 0, gripurile de ancoraj (portocalii) se afișează
   * cu acest offset în afara capetelor barei, reprezentând fața cofrajului.
   */
  acoperire?: number;
}

/**
 * Repetare a unei forme pe un grid 2D.
 * nrX / nrY = numărul total de instanțe pe axa respectivă (1 = fără repetiție).
 */
export interface Array2D {
  nrX: number;
  pasX: number;
  nrY: number;
  pasY: number;
  /** Modul de vizualizare pe canvas (nu afectează DXF). */
  vizualizare: "detaliat" | "abstract";
  /**
   * Distribuție variabilă pe axa X (opțional).
   * Dacă prezent, ignoră nrX/pasX și folosește zonele definite.
   * Fiecare zonă specifică un pas și un număr de repetări.
   */
  zoneX?: ZonaDistributie[];
  /** Distribuție variabilă pe axa Y (opțional). */
  zoneY?: ZonaDistributie[];
}

/**
 * O zonă de distribuție variabilă.
 * Ex: { pas: 100, numar: 5 } = 5 bare la pas de 100mm pe acea zonă.
 * Notație pe planșe: "5Ø8/100" → numar=5, pas=100.
 */
export interface ZonaDistributie {
  /** Pasul (distanța) între bare în această zonă (mm). */
  pas: number;
  /** Numărul de bare/spații în această zonă. */
  numar: number;
}

// ── Simbol parametric de distribuție ─────────────────────────────────────────

/** Tipul unui token din eticheta parametrică a simbolului de distribuție. */
export type TipPartLabel = "numar" | "marca" | "diametru" | "pas" | "lungime" | "lungimeTotala" | "clasaOtel" | "text";

/** Câte bare sunt reprezentate vizual pe planșă. */
export type ModBarDisplay = "toate" | "grup3" | "una";

/** Un token din eticheta parametrică. */
export interface PartLabel {
  tip: TipPartLabel;
  /** Conținut custom: pentru tip="text" textul propriu-zis. */
  valoare?: string;
  /** Prefix afișat înaintea valorii (ex. „L=”). Suprascrie setarea globală. */
  prefix?: string;
  /** Sufix afișat după valoare (ex. unitate custom). Suprascrie setarea globală. */
  sufix?: string;
}

/** Override pentru o zonă individuală dintr-o distribuție variabilă. */
export interface ZonaSimbolDistributie {
  /** Lungime afișată (mm). Dacă absent, se calculează automat (numar × pas). */
  lungimeOverride?: number;
  /** Override complet al tokenurilor de etichetă pentru această zonă. */
  partiLabelOverride?: PartLabel[];
}

/**
 * Simbol parametric de distribuție: vedere de sus sau lateral a unui array de bare.
 * Afișează săgeți duble cu etichetă configurabilă (marcă, Ø, diametru, pas, lungime).
 * Suportă distribuție uniformă și variabilă (zone individuale).
 */
export interface SimbolDistributie {
  id: string;
  /** ID-ul formei de armare cu array referit. */
  idForma: string;
  /** Axa distribuției reprezentate. */
  axa: "x" | "y";
  /**
   * Offset perpendicular al liniei de cotă față de forma de bază (mm).
   * Pentru axa X: offset în Y (negativ = sub formă).
   * Pentru axa Y: offset în X (negativ = la stânga formei).
   */
  offsetLinie: number;
  /**
   * Offset perpendicular al simbolurilor de bare față de forma de bază (mm).
   * 0 = la nivelul formei. Independent de offsetLinie.
   */
  offsetSimbol: number;
  /** Tokenurile etichetei principale (ordonate, compuse per zonă). */
  partiLabel: PartLabel[];
  /** Afișează lungimea zonei lângă linia de cotă. */
  afiseazaLungime: boolean;
  /** Afișează simbolurile barelor (⊕) pe planșă. */
  afiseazaSimbolBara: boolean;
  /** Câte bare sunt reprezentate vizual: toate, grup de 3 sau una singură. */
  modAfisareBare: ModBarDisplay;
  /** Override-uri per zonă (index 0..n-1 corespunzând zonelor din distribuție). */
  zoneOverride?: ZonaSimbolDistributie[];
  /** Culoare override. */
  culoare?: string;
  /** Mărime text (mm). */
  marimeText?: number;
}

export const SIMBOL_DISTRIBUTIE_IMPLICIT: Omit<SimbolDistributie, "id" | "idForma"> = {
  axa: "x",
  offsetLinie: -150,
  offsetSimbol: 0,
  modAfisareBare: "grup3",
  partiLabel: [
    { tip: "marca" },
    { tip: "numar" },
    { tip: "diametru" },
    { tip: "text", valoare: "/" },
    { tip: "pas" },
  ],
  afiseazaLungime: true,
  afiseazaSimbolBara: true,
};

/** Un leader suplimentar al unei etichete (pentru multi-leader). */
export interface LeaderSuplimentar {
  punctReferinta: Vector2;
  cotLeader?: Vector2;
}

/**
 * Etichetă de bară (balon cu marca, tip, diametru, număr).
 * Se atașează la o formă prin `idForma` (ref marca).
 * Pe planșă se afișează ca un cerc cu numărul mărcii + lider cu detalii.
 */
export interface EtichetaBara {
  id: string;
  /** ID-ul formei de armare de referință. */
  idForma: string;
  /** Poziția balonului pe planșă (mm). */
  pozitie: Vector2;
  /** Punctul de pe bară unde pornește linia leader (mm). Draggable la selecție. */
  punctReferinta: Vector2;
  /**
   * Punct intermediar (cot/genunchi) al leader-ului. Dacă setat, leader-ul devine
   * o polilinie din 2 segmente: punctReferinta → cotLeader → pozitie.
   * Dacă absent, leader-ul rămâne o linie dreaptă.
   */
  cotLeader?: Vector2;
  /**
   * Informații afișate sub/lângă balon.
   * Implicit se calculează automat din formă: "nrΦdiametru L=lungime"
   * Dacă prezent, suprascrie textul generat automat.
   */
  textSuprascriere?: string;
  /** Afișează numărul de elemente (ex. "4" bare). */
  afiseazaNumar: boolean;
  /** Afișează diametrul (ex. "Ø12"). */
  afiseazaDiametru: boolean;
  /** Afișează lungimea (ex. "L=2450"). */
  afiseazaLungime: boolean;
  /** Afișează pasul distribuției (ex. "/150"). */
  afiseazaPas: boolean;
  /** ID-ul stilului global de etichetă (din SetariApp.stiluriEtichete). Dacă setat, suprascrie setările individuale. */
  stilId?: string;
  /** Leaderi suplimentari (multi-leader). Fiecare arată spre o altă instanță a aceleași bare. */
  leaderiSuplimentari?: LeaderSuplimentar[];
  /** Tokenuri etichetă parametrică (prefix/sufix per token, ca array-path). */
  partiLabel?: PartLabel[];
  /** Offset manual al textului detalii față de poziția implicită sub balon (mm domeniu). */
  offsetText?: Vector2;
}

export const ETICHETA_BARA_IMPLICITA: Omit<EtichetaBara, "id" | "idForma" | "pozitie" | "punctReferinta"> = {
  afiseazaNumar: true,
  afiseazaDiametru: true,
  afiseazaLungime: true,
  afiseazaPas: false,
};

// ── Simbol de detaliu al unei bare (bar bending diagram) ─────────────────────

/**
 * Un simbol de detaliu al unei bare de armare, plasat independent pe planșă.
 * Vizualizează forma barei la o scară configurabilă cu adnotații draggable
 * (dimensiuni segmente, ciocuri, etichetă completă). Nu intră în extrasul de armare.
 */
export interface SimbolBara {
  id: string;
  /** ID-ul formei de armare de referință (gol dacă e legat de array-path). */
  idForma: string;
  /** ID array-path: simbol pentru un singur element (vedere frontală). */
  idCaleArray?: string;
  /** Poziția de inserție pe planșă (mm domeniu, y-sus). */
  pozitie: Vector2;
  /** Factor de scală față de dimensiunile reale (1 = la scară, 2 = dublu, 5 = chintuplu). */
  scara: number;
  /** Culoare override (implicit gri). */
  culoare?: string;
  /**
   * Offset-uri manuale per element de adnotație (draggable + rotatable).
   * Chei: "seg-0", "seg-1", ..., "cioc-start", "cioc-sfarsit", "eticheta".
   */
  offseturi?: Record<string, OffsetAdnotatie>;
  /** Afișează lungimile segmentelor ca adnotații. */
  arataLungimi: boolean;
  /** Afișează lungimile ciocurilor. */
  arataCiocuri: boolean;
  /** Afișează eticheta completă (Pos., Ø, L, nr buc.). */
  arataEticheta: boolean;
  /** Tokenuri etichetă parametrică (prefix/sufix per token). */
  partiLabel?: PartLabel[];
  /** Override dimensiune text adnotații (mm). Dacă absent, se folosește `marimeAdnotatii` din setările globale. */
  marimeText?: number;
  /** Afișează un leader (linie cu săgeată) care pornește din simbol spre bara de referință. */
  arataLeader?: boolean;
  /** Offset vertical al punctului de ancorare al leaderului față de originea simbolului (mm, y-sus). */
  offsetLeaderY?: number;
}

export const SIMBOL_BARA_IMPLICIT: Omit<SimbolBara, "id" | "idForma" | "pozitie"> = {
  scara: 1,
  arataLungimi: true,
  arataCiocuri: true,
  arataEticheta: true,
};

// ── Cotă de nivel (elevation mark) ────────────────────────────────────────────

/** Un nivel suplimentar afișat deasupra cotei de bază. */
export interface NivelElevatie {
  id: string;
  /** Offset față de elevația de bază (mm model); poate fi negativ. */
  offset: number;
  /** Poziție verticală manuală pe desen (mm model); folosită când distantaManuala=true. */
  distantaVerticala?: number;
  /** Offset orizontal al simbolului față de axa cotei (mm hârtie, annotative). */
  offsetOrizontal?: number;
  /** Poziție verticală decuplată manual de offset-ul parametric. */
  distantaManuala?: boolean;
  /** Etichetă personalizată; dacă lipsă se calculează automat (baza + offset). */
  etichetaCustom?: string;
  /** Offset manual al textului față de poziția implicită (mm, coordonate locale simbol). */
  offsetText?: Vector2;
}

/** Format de afișare a valorii de elevație. */
export type FormatElevatie = "m2" | "m3" | "cm" | "mm";

/**
 * Cotă de nivel (elevation mark): simbol triunghi + raft orizontal + valoare.
 * Suportă niveluri multiple stivuite vertical, cu valori calculate parametric.
 */
export interface CotaElevatie {
  id: string;
  /** Vârful triunghiului (datum) — cache; se recalculează din ancoră + offset. */
  pozitie: Vector2;
  /** Punct țintă pe geometrie (fallback când ref lipsește). */
  punctAncora?: Vector2;
  /** Offset de la ancoră la vârful triunghiului (mm domeniu). */
  offsetAncora?: Vector2;
  /** Ancorare asociativă la formă (cofraj / armare). */
  ref?: AncoraCota;
  /** Elevația de bază (mm față de referința 0.00). */
  elevatieBase: number;
  /** Niveluri adiționale față de baza (ordonate descendent → sus pe desen). */
  niveluri: NivelElevatie[];
  /** Format afișare valori. */
  format?: FormatElevatie;
  /** Lungimea ramurii orizontale a raftului (mm). */
  lungimeLinie?: number;
  /** Semijumătate linie orizontală la vârful triunghiului (mm hârtie, simetric). */
  lungimeLinieBaza?: number;
  /** Înălțimea triunghiului (mm). */
  inaltimeTriunghi?: number;
  /** Mărime text (mm). */
  marimeText?: number;
  /** Culoare override. */
  culoare?: string;
  /** Textul apare la dreapta (implicit) sau la stânga simbolului. */
  sensText?: "dreapta" | "stanga";
  /** Oglindire pe axa X (linie + text inversate). */
  oglinditX?: boolean;
  /** Oglindire pe axa Y (triunghi în sus, nivele în direcția opusă). */
  oglinditY?: boolean;
  /** Offset manual text etichetă bază față de poziția implicită (mm, coordonate locale). */
  offsetText?: Vector2;
  /** Offset poziție simbol bază față de vârful cotei (mm hârtie, x=orizontal y=vertical). */
  offsetGrupBaza?: Vector2;
  /** Rotație simbol (grade) în jurul vârfului triunghiului / liniei de bază. */
  rotatie?: number;
}

export const COTA_ELEVATIE_IMPLICITA: Omit<CotaElevatie, "id" | "pozitie"> = {
  elevatieBase: 0,
  niveluri: [],
  format: "m2",
  // Dimensiuni în mm pe HÂRTIE (sistem annotative).
  lungimeLinie: 7.5,
  lungimeLinieBaza: 4,
  inaltimeTriunghi: 3,
  marimeText: undefined,
  sensText: "dreapta",
  oglinditX: false,
  oglinditY: false,
  rotatie: 0,
};

/** Formatează o valoare de elevație (mm) în textul afișat pe cotă. */
export function formateazaElevatie(mm: number, format: FormatElevatie = "m2"): string {
  if (format === "mm") return `${Math.round(mm)}`;
  if (format === "cm") {
    const v = mm / 10;
    const s = v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
    return v === 0 ? `±${Math.abs(v).toFixed(1)}` : s;
  }
  const dec = format === "m3" ? 3 : 2;
  const v = mm / 1000;
  if (Math.abs(v) < 1e-9) return `±${(0).toFixed(dec)}`;
  return v > 0 ? `+${v.toFixed(dec)}` : v.toFixed(dec);
}

// ── Simbol de secțiune ────────────────────────────────────────────────────────

/**
 * Simbol de secțiune: linie de tăiere cu indicatoare de vedere la capete.
 * `p1`/`p2` = capetele liniei (snappable); `directieVedere` = pe care parte
 * a liniei p1→p2 privești secțiunea.
 */
export interface SimbolSectiune {
  id: string;
  p1: Vector2;
  p2: Vector2;
  eticheta: string;
  /** "stanga" = normal CCW față de p1→p2; "dreapta" = normal CW. */
  directieVedere: "stanga" | "dreapta";
  lungimeBrat?: number;
  afiseazaLinie?: boolean;
  culoare?: string;
  marimeText?: number;
  grosimeLinie?: number;
}

export const SIMBOL_SECTIUNE_IMPLICIT: Omit<SimbolSectiune, "id" | "p1" | "p2"> = {
  eticheta: "A",
  directieVedere: "stanga",
  // Lungime braț în mm pe HÂRTIE (sistem annotative).
  lungimeBrat: 5,
  afiseazaLinie: true,
};

/**
 * Zonă hașurată pe planșă (pentru indicarea secțiunilor de beton, teren, etc.).
 * Conturul este definit de un set de puncte (poligon închis).
 */
export interface Hasura {
  id: string;
  /** Conturul zonei (poligon închis), coordonate domeniu. */
  contur: Vector2[];
  /** Tipul de hașură. */
  tipHasura: TipHasura;
  /** Unghiul liniilor de hașură (grade, implicit 45). */
  unghi: number;
  /** Distanța între linii de hașură (mm). */
  pas: number;
  /** Culoarea liniilor. */
  culoare: string;
  /** Grosimea liniilor. */
  grosimeLinie: number;
}

export type TipHasura =
  | "linii"             // linii paralele la unghi dat
  | "linii-incrucisate" // hașură încrucișată (2 direcții)
  | "puncte"            // grilă de puncte (dots)
  | "beton"             // beton: linii 45° + agregate punctate
  | "metal"             // metal/oțel: hașură deasă încrucișată
  | "lemn"              // lemn: linii orizontale (fibră)
  | "pamant"            // pământ/teren: linii orizontale + marcaje V
  | "solid";            // fill solid (umplutură plină)

export const HASURA_IMPLICITA: Omit<Hasura, "id" | "contur"> = {
  tipHasura: "linii",
  unghi: 45,
  pas: 30,
  culoare: "#64748b",
  grosimeLinie: 0.5,
};

/**
 * Definiția (template-ul) unei forme parametrice. Încapsulează atât generarea
 * geometriei din parametri, cât și maparea inversă drag-punct-control -> parametru.
 * Aceasta este abstracția centrală de tip "dynamic block".
 */
/** Polilinia de bază a unei forme (axa barei), înainte de filetare și ciocuri. */
export interface VarfuriForma {
  varfuri: Vector2[];
  /** true pentru contururi închise (nefolosit acum — etrierul e modelat deschis). */
  inchis: boolean;
}

export interface DefinitieForma {
  tip: TipForma;
  nume: string;
  descriere: string;
  parametri: DefinitieParametru[];
  /**
   * Categoria formei:
   * - "armare" (implicit) = bară de oțel (intrată în extras de armare)
   * - "cofraj" = contur/secțiune de beton (nu intră în extras)
   */
  categorie?: "armare" | "cofraj";
  /** true dacă utilizatorul poate adăuga ciocuri la capete (bare deschise). */
  acceptaCiocuriUtilizator: boolean;
  /** Generează polilinia de bază (coordonate locale, origine 0,0). */
  genereazaVarfuri(p: ValoriParametri): VarfuriForma;
  /** Ciocuri intrinseci formei (ex. cele două cârlige 135° ale etrierului). */
  ciocuriIntrinseci?(p: ValoriParametri): Ciocuri | undefined;
  /** Generează punctele de control (în coordonate locale). */
  genereazaPuncteControl(p: ValoriParametri): PunctControl[];
  /**
   * Aplică deplasarea unui punct de control la o poziție nouă (coordonate locale)
   * și întoarce valorile de parametri actualizate.
   */
  aplicaDeplasare(
    p: ValoriParametri,
    idPunct: string,
    pozitieNoua: Vector2,
  ): ValoriParametri;
}

/** Valorile implicite de parametri pentru o definiție de formă. */
export function valoriImplicite(def: DefinitieForma): ValoriParametri {
  const v: ValoriParametri = {};
  for (const par of def.parametri) v[par.cheie] = par.valoareImplicita;
  return v;
}

/**
 * Calculează offset-urile instanțelor pe o axă, suportând distribuție variabilă.
 * Returnează un array de offset-uri (mm) de la origine (fără elementul la 0).
 */
export function offseturiDistributie(arr: Array2D, axa: "x" | "y"): number[] {
  const zone = axa === "x" ? arr.zoneX : arr.zoneY;
  if (zone && zone.length > 0) {
    // Distribuție variabilă: fiecare zonă are { pas, numar }.
    const pozitii: number[] = [];
    let cursor = 0;
    for (const zona of zone) {
      for (let i = 0; i < zona.numar; i++) {
        cursor += zona.pas;
        pozitii.push(cursor);
      }
    }
    return pozitii;
  }
  // Distribuție uniformă clasică.
  const nr = axa === "x" ? arr.nrX : arr.nrY;
  const pas = axa === "x" ? arr.pasX : arr.pasY;
  const pozitii: number[] = [];
  for (let i = 1; i < nr; i++) {
    pozitii.push(i * pas);
  }
  return pozitii;
}

/**
 * Număr total de instanțe pe o axă (inclusiv originea).
 */
export function totalInstanteAxa(arr: Array2D, axa: "x" | "y"): number {
  const zone = axa === "x" ? arr.zoneX : arr.zoneY;
  if (zone && zone.length > 0) {
    return 1 + zone.reduce((s, z) => s + z.numar, 0);
  }
  return axa === "x" ? arr.nrX : arr.nrY;
}

/**
 * Text descriptiv pentru zona de distribuție (format planșă).
 * Ex: "5/100 + 3/200 + 5/100" sau "10/150" (uniform).
 */
export function textDistributie(arr: Array2D, axa: "x" | "y"): string {
  const zone = axa === "x" ? arr.zoneX : arr.zoneY;
  if (zone && zone.length > 0) {
    return zone.map((z) => `${z.numar}/${z.pas}`).join(" + ");
  }
  const nr = axa === "x" ? arr.nrX : arr.nrY;
  const pas = axa === "x" ? arr.pasX : arr.pasY;
  return `${nr - 1}/${pas}`;
}

// ── Cadre de printare (print frames / viewports) ──────────────────────────────

/** Format standard de hârtie. */
export type FormatHartie = "A4" | "A3" | "A2" | "A1" | "A0" | "custom";

/** Orientarea hârtiei. */
export type OrientareHartie = "landscape" | "portrait";

/** Scări convenționale de desenare. */
export type ScaraConventionala =
  | "1:1" | "1:2" | "1:5" | "1:10" | "1:15" | "1:20" | "1:25"
  | "1:50" | "1:75" | "1:100" | "1:200" | "1:500" | "1:1000"
  | "2:1" | "5:1" | "10:1";

/** Dimensiuni standard de hârtie (lățime × înălțime în mm, landscape). */
export const DIMENSIUNI_HARTIE: Record<Exclude<FormatHartie, "custom">, { latime: number; inaltime: number }> = {
  A4: { latime: 297, inaltime: 210 },
  A3: { latime: 420, inaltime: 297 },
  A2: { latime: 594, inaltime: 420 },
  A1: { latime: 841, inaltime: 594 },
  A0: { latime: 1189, inaltime: 841 },
};

/** Transformă scara convențională într-un factor numeric (ex. "1:50" → 50). */
export function factorScara(scara: ScaraConventionala): number {
  const [numarator, numitor] = scara.split(":").map(Number);
  return numitor! / numarator!;
}

/**
 * Un cadru de printare plasat pe planșă.
 * Definește o zonă dreptunghiulară ce reprezintă o pagină imprimabilă
 * la o scară dată. Poate fi selectat individual sau în batch pentru tipărire.
 */
export interface CadruPrintare {
  id: string;
  /** Numele paginii/planșei (ex. "P01 - Armare grindă G1"). */
  nume: string;
  /** Formatul de hârtie. */
  format: FormatHartie;
  /** Orientarea hârtiei. */
  orientare: OrientareHartie;
  /** Scara de desenare. */
  scara: ScaraConventionala;
  /** Poziția colțului stânga-jos pe planșă (în mm domeniu). */
  pozitie: Vector2;
  /**
   * Dimensiuni custom (doar dacă format === "custom"), în mm.
   * Dacă format ≠ "custom", se folosesc DIMENSIUNI_HARTIE.
   */
  latimeCustom?: number;
  inaltimeCustom?: number;
  /** Șablonul de cartuș (title block) atribuit acestui cadru. */
  sablonId?: string;
  /** Valorile manuale ale câmpurilor de cartuș (cheie → valoare). */
  valoriCampuri?: Record<string, string>;
}

/** Calculează dimensiunile efective ale unui cadru pe planșă (în mm domeniu). */
export function dimensiuniCadru(cadru: CadruPrintare): { latime: number; inaltime: number } {
  let w: number;
  let h: number;
  if (cadru.format === "custom") {
    w = cadru.latimeCustom ?? 297;
    h = cadru.inaltimeCustom ?? 210;
  } else {
    const dim = DIMENSIUNI_HARTIE[cadru.format];
    w = cadru.orientare === "landscape" ? dim.latime : dim.inaltime;
    h = cadru.orientare === "landscape" ? dim.inaltime : dim.latime;
  }
  // Dimensiunile pe planșă = dimensiuni hârtie × factor scară
  const f = factorScara(cadru.scara);
  return { latime: w * f, inaltime: h * f };
}

/** Valori implicite pentru un cadru nou. */
export const CADRU_PRINTARE_IMPLICIT: Omit<CadruPrintare, "id" | "pozitie"> = {
  nume: "Planșă nouă",
  format: "A3",
  orientare: "landscape",
  scara: "1:50",
};

// ── Tabel extras de armare pe canvas ─────────────────────────────────────────

/** Tabel de extras de armare plasat pe canvas (poziție + scală persistate). */
export interface TabelExtrasConfig {
  id: string;
  pozitie: Vector2;
  /** Factor de scalare față de dimensiunea implicită. Implicit 1. */
  scalaUtilizator?: number;
  /** Titlu afișat deasupra antetului tabelului. */
  titlu?: string;
  /** Etichete personalizate pentru coloane (cheie → text). */
  eticheteColoane?: Record<string, string>;
  /** Denumiri personalizate per marcă pentru coloana „Tip". */
  numeRanduri?: Record<number, string>;
  /** Pe foaie layout: id foaie; poziția e în mm hârtie (colț stânga-jos al foii). */
  foaieLayoutId?: string;
  /** Pe layout: calculează scala pentru lizibilitate pe hârtie. Implicit true. */
  scalaAutoLayout?: boolean;
  /** Cheile coloanelor ascunse în canvas (ex. "simbol", "lbuc"). Implicit niciuna. */
  coloaneAscunse?: string[];
  /**
   * Dacă e setat, tabelul afișează doar mărcile din listă (tabele separate
   * pentru a le distribui pe planșe). Dacă lipsește, afișează toate mărcile.
   */
  filtruMarci?: number[];
}
