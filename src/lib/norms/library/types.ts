/**
 * types.ts — modelul librăriei de categorii de lucrări.
 *
 * O categorie de lucrări ține ÎMPREUNĂ cele trei lucruri care azi sunt în trei
 * locuri separate: articolele de deviz, mapările pe obiecte BIM și prețurile.
 *
 * Sursa de adevăr sunt fișierele `.md` din `data/norms/library/`; acest modul
 * descrie forma lor parsată. Totul e pur (fără I/O), ca să ruleze identic în
 * Node (compilator) și în browser (editorul vizual).
 */
import type { NormUnit, MeasureKey } from '../types';

/** Componentele de preț ale unui articol (lei / unitatea articolului). */
export interface PriceComponents {
  material: number;
  manopera: number;
  utilaj: number;
  transport: number;
}

/**
 * De unde vine un preț și din când.
 *
 * Fără asta „preț orientativ" e o etichetă lipită pe tot catalogul deopotrivă,
 * și nu se mai poate spune care cifră e o ofertă reală și care e o estimare de
 * acum doi ani. Cu ea, întrebarea „pe ce mă pot baza?" are răspuns pe rând.
 */
export interface PriceSource {
  /** Cine a dat cifra: `estimare`, `ofertă <furnizor>`, `deviz <proiect>`, `indicator <an>`. */
  source: string;
  /** Când, `AAAA-LL` sau `AAAA-LL-ZZ`. */
  date: string;
}

/** Un articol de deviz declarat într-o categorie. */
export interface LibraryArticle {
  normId: string;
  symbol: string;
  denumire: string;
  unit: NormUnit;
  /** Absent = articol fără preț declarat (validatorul îl semnalează). */
  price?: PriceComponents;
  /** Proveniența prețului. Absent = necunoscută, ceea ce UI-ul spune pe față. */
  priceSource?: PriceSource;
}

/**
 * O mapare „obiect BIM → articol".
 *
 * `materialKey` e o cheie STABILĂ, nu eticheta afișabilă a materialului:
 * eticheta a fost deja tradusă o dată (ro→en) și a rupt tăcut maparea pereților.
 */
export interface LibraryMapping {
  /** Articolul produs — trebuie să existe în librărie. */
  normId: string;
  /** Tipul de nod din graf: wall, column, beam, slab, foundation, room, window, door, ax. */
  nodeType: string;
  /** Id de tip din elementLibrary (ex. W20) sau `*` pentru oricare. */
  elementType: string;
  /** Filtru opțional pe cheia de material (ex. `brick`). */
  materialKey?: string;
  /**
   * Sistemul structural în care se aplică maparea (ex. `timber_frame`).
   * Gol = descompunerea implicită. O mapare cu sistem ÎNLOCUIEȘTE mapările
   * fără sistem ale aceluiași element atunci când proiectul (sau elementul)
   * e în acel sistem — vezi `findMappingRules`.
   */
  system?: string;
  /**
   * Specificația în care se aplică maparea, `grup:opțiune` (ex.
   * `tencuiala_int:var_ciment`). Gol = maparea implicită, valabilă indiferent
   * de alegeri. O mapare cu spec e candidat DOAR când acea opțiune e în
   * vigoare — vezi `findMappingRules` și `_specificatii.md`.
   */
  spec?: string;
  measure: MeasureKey;
  /** Folosit când measure = 'formula'. */
  formula?: string;
  /** Pentru arii: scade golurile. */
  netOfOpenings?: boolean;
}

/**
 * O OPȚIUNE dintr-un grup de specificații: „vată bazaltică 15 cm" în grupul
 * `termoizolatie`. Ce produce în deviz vine din mapările care poartă
 * `spec = grup:opțiune`; opțiunea în sine e doar identitate + etichetă.
 */
export interface LibrarySpecOption {
  group: string;
  id: string;
  label: string;
  description?: string;
  /**
   * Materialul pe care îl pune în operă opțiunea — cheie din configurația de
   * materiale (`ceramic_tile`, `aac_block`). Îl citește REPREZENTAREA: o bandă
   * de înălțime care alege `faianta:standard` se desenează ca faianță, fără ca
   * utilizatorul să mai seteze materialul separat.
   * Absent = opțiunea nu schimbă cu nimic aspectul.
   */
  material?: string;
  /**
   * Conductivitatea termică a stratului, W/mK. Se declară AICI, lângă preț și
   * material, ca aceeași alegere să producă și devizul, și randarea, și
   * rezistența termică — dintr-un singur rând, care nu poate diverge de el
   * însuși. Absent = opțiunea nu e un strat cu proprietăți termice.
   */
  lambda?: number;
  /** Grosimea stratului, mm. Împreună cu `lambda` dă R = d/λ. */
  grosime?: number;
}

/**
 * Un GRUP de specificații: o decizie de material sau de tehnologie de finisaj
 * pe care un scenariu o poate roti, independentă de sistemul structural.
 *
 * Grupul deține articolele pe care le produce opțiunea IMPLICITĂ
 * (`defaultArticles`). Când e aleasă altă opțiune, acele articole sunt scoase
 * din deviz și în locul lor intră mapările opțiunii. Așa alternativele se
 * adaugă fără să atingă nicio regulă existentă: implicitul rămâne exact
 * maparea de azi.
 */
export interface LibrarySpecGroup {
  id: string;
  label: string;
  /** Tipurile de nod al căror `spec_<id>` suprascrie alegerea de proiect. */
  appliesTo: string[];
  /** Opțiunea în vigoare când nu s-a ales nimic. */
  defaultOption: string;
  /** Articolele produse de opțiunea implicită — scoase când e aleasă alta. */
  defaultArticles: string[];
  description?: string;
  options: LibrarySpecOption[];
}

/** O categorie de lucrări = un fișier `.md`. */
export interface LibraryCategory {
  categorie: string;
  capitol: string;
  articles: LibraryArticle[];
  mappings: LibraryMapping[];
  /** Numele fișierului sursă — apare în mesajele de validare. */
  sourceFile: string;
}

/** Metadatele catalogului (`_catalog.md`). */
export interface LibraryCatalogMeta {
  id: string;
  version: string;
  currency: string;
}

/** Librăria completă. */
export interface NormLibrary {
  meta: LibraryCatalogMeta;
  categories: LibraryCategory[];
  /** Grupurile de specificații (`_specificatii.md`). Absent = librărie fără alternative. */
  specGroups?: LibrarySpecGroup[];
}

/** Unitățile acceptate — validate la parsare. */
export const VALID_UNITS: readonly NormUnit[] = ['mp', 'mc', 'ml', 'kg', 'buc'];

/**
 * Sistemele structurale acceptate în coloana `sistem` — validate la parsare.
 * Oglinda vocabularului închis din `lib/systems/structuralSystem.ts` (fără
 * `unset`, care nu e un sistem). Ținut aici ca text, ca librăria să rămână
 * pură și compilabilă în Node fără a trage modulul de store.
 */
export const VALID_SYSTEMS: readonly string[] = [
  'confined_masonry', 'rc_frame', 'rc_shear_wall', 'timber_frame', 'clt', 'steel_frame', 'precast',
];

/** Măsurile acceptate — validate la parsare. */
export const VALID_MEASURES: readonly MeasureKey[] = [
  'length', 'area', 'volume', 'count', 'opening_area', 'formula',
];
