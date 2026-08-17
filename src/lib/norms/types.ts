/**
 * types.ts — Romanian construction quantity norms (deviz) data model.
 */

export type NormUnit = 'mp' | 'mc' | 'ml' | 'kg' | 'buc';

export type MeasureKey =
  | 'length'
  | 'area'
  | 'volume'
  | 'count'
  | 'opening_area'
  | 'formula';

/** A norm article from the Indicator C starter catalog. */
export interface NormArticle {
  id: string;
  symbol: string;
  denumire: string;
  unit: NormUnit;
  capitol: string;
  categorie: string;
}

/** Maps a BIM node + element type to one or more norm outputs. */
export interface NormMappingRule {
  nodeType: string;
  /** Element library id (e.g. W30) or '*' for any in family. */
  elementTypeId: string;
  /** Optional substring match on material field from elementLibrary. */
  materialFilter?: string;
  outputs: NormMappingOutput[];
}

export interface NormMappingOutput {
  normId: string;
  measure: MeasureKey;
  /** Used when measure === 'formula'. Variables: length_m, height_m, area_m2, volume_m3, count, etc. */
  formula?: string;
  /** For wall area: subtract opening areas. */
  netOfOpenings?: boolean;
}

/** Raw geometry extracted from a single node. */
export interface NodeMeasures {
  length_m: number;
  height_m: number;
  thickness_m: number;
  width_m: number;
  depth_m: number;
  gross_area_m2: number;
  net_area_m2: number;
  area_m2: number;
  perimeter_m: number;
  section_m2: number;
  volume_m3: number;
  count: number;
  opening_area_m2: number;
}

export const EMPTY_MEASURES: NodeMeasures = {
  length_m: 0,
  height_m: 0,
  thickness_m: 0,
  width_m: 0,
  depth_m: 0,
  gross_area_m2: 0,
  net_area_m2: 0,
  area_m2: 0,
  perimeter_m: 0,
  section_m2: 0,
  volume_m3: 0,
  count: 0,
  opening_area_m2: 0,
};

/** One takeoff line before aggregation (per node × norm). */
export interface TakeoffLine {
  normId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  elementTypeId: string;
  storeyId: string;
  storeyName: string;
  quantity: number;
  unit: NormUnit;
  source: string;
}

/** Aggregated F3 row (Lista cu cantități). */
export interface F3Row {
  nrCrt: number;
  normId: string;
  symbol: string;
  denumire: string;
  unit: NormUnit;
  quantity: number;
  capitol: string;
  categorie: string;
  storeyId: string;
  storeyName: string;
  /** Node ids contributing to this aggregated row. */
  nodeIds: string[];
}

export const CATALOG_VERSION = 'indicator-c-starter-1';
