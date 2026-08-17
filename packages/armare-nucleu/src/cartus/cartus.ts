import type { CadruPrintare } from "../model/tipuri";

/**
 * Cartuș (title block) pentru planșe de printare.
 *
 * Un șablon de cartuș este un SVG proiectat extern (Inkscape/Illustrator) care
 * conține grafica fixă (chenar, linii, logo) plus placeholdere de forma
 * `{{cheie}}` în textele care trebuie completate. Aplicația detectează automat
 * placeholderele și expune un formular; valorile se substituie la randare/print.
 */

/** Sursa valorii unui câmp: completat manual sau dedus automat din cadru/context. */
export type SursaCamp = "manual" | "auto";

/** Tipuri de câmpuri auto-populate din cadru/proiect. */
export type AutoCampCartus =
  | "scara"
  | "format"
  | "orientare"
  | "data"
  | "nrPlansa"
  | "totalPlanse"
  | "numePlansa";

/** Un câmp completabil al cartușului (derivat dintr-un placeholder `{{cheie}}`). */
export interface CampCartus {
  /** Cheia placeholderului (fără acolade), ex. "titlu". */
  cheie: string;
  /** Eticheta afișată în formular. */
  eticheta: string;
  sursa: SursaCamp;
  /** Maparea auto (dacă sursa === "auto"). */
  auto?: AutoCampCartus;
  /** Valoare implicită pentru câmpurile manuale. */
  valoareImplicita?: string;
}

/** Un șablon de cartuș refolosibil în cadrul proiectului. */
export interface SablonCartus {
  id: string;
  nume: string;
  /** Markup SVG brut (string). */
  svg: string;
  /** Câmpurile detectate din placeholderele SVG-ului. */
  campuri: CampCartus[];
}

/** Context dinamic la rezolvarea valorilor (cunoscut doar la printare). */
export interface ContextCartus {
  /** Indexul planșei în lotul de printat (1-based). */
  nrPlansa?: number;
  /** Numărul total de planșe din lot. */
  totalPlanse?: number;
  /** Data de referință (implicit: acum). */
  data?: Date;
}

/** Etichete prietenoase pentru orientare. */
const ETICHETE_ORIENTARE: Record<string, string> = {
  landscape: "Peisaj",
  portrait: "Portret",
};

/**
 * Maparea cheilor cunoscute (normalizate) la tipul auto corespunzător.
 * Normalizarea: lowercase + eliminare `_`/`-`.
 */
const CHEI_AUTO: Record<string, AutoCampCartus> = {
  scara: "scara",
  format: "format",
  orientare: "orientare",
  data: "data",
  nrplansa: "nrPlansa",
  nrpagina: "nrPlansa",
  totalplanse: "totalPlanse",
  totalpagini: "totalPlanse",
  numeplansa: "numePlansa",
  titluplansa: "numePlansa",
  numepagina: "numePlansa",
};

function normalizeazaCheie(cheie: string): string {
  return cheie.toLowerCase().replace(/[_-]/g, "");
}

function capitalizeaza(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Eticheta implicită pentru un câmp (din cheie: `nr_plansa` → "Nr plansa"). */
function etichetaDinCheie(cheie: string): string {
  return capitalizeaza(cheie.replace(/[_-]+/g, " "));
}

const REGEX_PLACEHOLDER = /\{\{\s*([\w-]+)\s*\}\}/g;

/**
 * Extrage câmpurile (placeholderele `{{cheie}}`) dintr-un SVG, deduplicate,
 * în ordinea primei apariții. Cheile cunoscute devin câmpuri `auto`.
 */
export function extrageCampuriDinSvg(svg: string): CampCartus[] {
  const vazute = new Set<string>();
  const campuri: CampCartus[] = [];
  for (const m of svg.matchAll(REGEX_PLACEHOLDER)) {
    const cheie = m[1]!;
    if (vazute.has(cheie)) continue;
    vazute.add(cheie);
    const auto = CHEI_AUTO[normalizeazaCheie(cheie)];
    campuri.push({
      cheie,
      eticheta: etichetaDinCheie(cheie),
      sursa: auto ? "auto" : "manual",
      ...(auto ? { auto } : {}),
    });
  }
  return campuri;
}

/**
 * Substituie placeholderele `{{cheie}}` cu valorile date (lipsă → ""),
 * și injectează atributul `xmlns` dacă lipsește (necesar pentru a încărca
 * SVG-ul ca `Image` în browser).
 */
export function aplicaCampuri(svg: string, valori: Record<string, string>): string {
  let rezultat = svg.replace(REGEX_PLACEHOLDER, (_match, cheie: string) => {
    const v = valori[cheie];
    return v !== undefined ? v : "";
  });
  if (!/xmlns\s*=/.test(rezultat)) {
    rezultat = rezultat.replace(
      /<svg\b/,
      '<svg xmlns="http://www.w3.org/2000/svg"',
    );
  }
  return rezultat;
}

/** Formatează o dată ca `zz.ll.aaaa`. */
function formateazaData(d: Date): string {
  const zz = String(d.getDate()).padStart(2, "0");
  const ll = String(d.getMonth() + 1).padStart(2, "0");
  return `${zz}.${ll}.${d.getFullYear()}`;
}

/** Rezolvă valoarea unui câmp auto din cadru + context. */
function valoareAuto(
  auto: AutoCampCartus,
  cadru: CadruPrintare,
  ctx: ContextCartus,
): string {
  switch (auto) {
    case "scara":
      return cadru.scara;
    case "format":
      return cadru.format;
    case "orientare":
      return ETICHETE_ORIENTARE[cadru.orientare] ?? cadru.orientare;
    case "data":
      return formateazaData(ctx.data ?? new Date());
    case "nrPlansa":
      return ctx.nrPlansa !== undefined ? String(ctx.nrPlansa) : "";
    case "totalPlanse":
      return ctx.totalPlanse !== undefined ? String(ctx.totalPlanse) : "";
    case "numePlansa":
      return cadru.nume;
    default:
      return "";
  }
}

/**
 * Combină valorile auto (din cadru/context) cu cele manuale pentru un cadru,
 * producând dicționarul `cheie → valoare` gata de aplicat în SVG.
 */
export function rezolvaValoriCadru(
  sablon: SablonCartus,
  cadru: CadruPrintare,
  ctx: ContextCartus,
  valoriManuale: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const camp of sablon.campuri) {
    if (camp.sursa === "auto" && camp.auto) {
      out[camp.cheie] = valoareAuto(camp.auto, cadru, ctx);
    } else {
      out[camp.cheie] = valoriManuale[camp.cheie] ?? camp.valoareImplicita ?? "";
    }
  }
  return out;
}
