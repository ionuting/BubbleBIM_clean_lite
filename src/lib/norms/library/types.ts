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

/** Un articol de deviz declarat într-o categorie. */
export interface LibraryArticle {
  normId: string;
  symbol: string;
  denumire: string;
  unit: NormUnit;
  /** Absent = articol fără preț declarat (validatorul îl semnalează). */
  price?: PriceComponents;
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
  measure: MeasureKey;
  /** Folosit când measure = 'formula'. */
  formula?: string;
  /** Pentru arii: scade golurile. */
  netOfOpenings?: boolean;
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
}

/** Unitățile acceptate — validate la parsare. */
export const VALID_UNITS: readonly NormUnit[] = ['mp', 'mc', 'ml', 'kg', 'buc'];

/** Măsurile acceptate — validate la parsare. */
export const VALID_MEASURES: readonly MeasureKey[] = [
  'length', 'area', 'volume', 'count', 'opening_area', 'formula',
];
