/**
 * devizZidarieConfinata.ts — Catalog imported from DEVIZ PE CATEGORII.ods
 * (case din zidărie confinată — Casa Butnaru template).
 */

import type { NormArticle, NormUnit } from './types';
import catalogData from './devizZidarieConfinata.json';

export const DEVIZ_ZIDARIE_CATALOG_VERSION = catalogData.catalogVersion;

interface JsonArticle {
  id: string;
  symbol: string;
  denumire: string;
  unit: string;
  categorie: string;
  categorie_code: string;
  capitol: string;
}

export const DEVIZ_ZIDARIE_CATEGORIES: string[] = catalogData.categories;

export const DEVIZ_ZIDARIE_STARTER: NormArticle[] = (catalogData.articles as JsonArticle[]).map((a) => ({
  id: a.id,
  symbol: a.symbol,
  denumire: a.denumire,
  unit: a.unit as NormUnit,
  capitol: a.capitol,
  categorie: a.categorie,
}));

export const DEVIZ_ZIDARIE_MAP = new Map(
  DEVIZ_ZIDARIE_STARTER.map((a) => [a.id, a]),
);
