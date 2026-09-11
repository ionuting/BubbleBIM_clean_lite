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
  /**
   * Optional structural system the rule belongs to (`timber_frame`, …). A
   * rule with a system applies only when the element resolves to that system
   * and, when it does, REPLACES the system-less rules for the same element:
   * the same wall is masonry in one scenario and studs + sheathing in another.
   * Absent = the default decomposition, used when no system-specific rule fits.
   */
  structuralSystem?: string;
  /**
   * Specificația care activează regula, `grup:opțiune`. Absent = regulă
   * implicită. Vezi `findMappingRules` și `lib/norms/specs.ts`.
   */
  spec?: string;
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
  /** Timber framing (walls): full-height studs, metres of timber, one face net of openings. */
  stud_count: number;
  framing_length_m: number;
  sheathing_area_m2: number;
  /** Framing breakdown: verticals, plates+sills, headers (plies included), header count, whole sheets per face. */
  stud_length_m: number;
  plate_length_m: number;
  header_length_m: number;
  header_count: number;
  sheathing_sheet_count: number;
  /** CLT panelisation (walls): pieces, gross blank area, CNC cut length, base+vertical joints, brackets+hold-downs. */
  panel_count: number;
  panel_area_m2: number;
  cut_length_m: number;
  joint_length_m: number;
  connector_count: number;
  /** Wall side, 1/0 — from the storey's exterior ring. A formula multiplies by it to apply one side only. */
  is_exterior: number;
  is_interior: number;
  /** Openings in a wall: how many, and their widths summed (lintel length = widths + bearings). */
  opening_count: number;
  opening_width_m: number;
  /**
   * Shell regions (contour + cell holes — see lib/shell/region.ts). `net_solid`
   * is the PLIN: contour area minus the cells, i.e. the footing area of a
   * cellular raft or the footprint of a beam grid.
   */
  outer_perimeter_m: number;
  hole_perimeter_m: number;
  hole_area_m2: number;
  hole_count: number;
  net_solid_area_m2: number;
  band_area_m2: number;
  outer_face_area_m2: number;
  inner_face_area_m2: number;
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
  stud_count: 0,
  framing_length_m: 0,
  sheathing_area_m2: 0,
  stud_length_m: 0,
  plate_length_m: 0,
  header_length_m: 0,
  header_count: 0,
  sheathing_sheet_count: 0,
  panel_count: 0,
  panel_area_m2: 0,
  cut_length_m: 0,
  joint_length_m: 0,
  connector_count: 0,
  is_exterior: 0,
  is_interior: 0,
  opening_count: 0,
  opening_width_m: 0,
  outer_perimeter_m: 0,
  hole_perimeter_m: 0,
  hole_area_m2: 0,
  hole_count: 0,
  net_solid_area_m2: 0,
  band_area_m2: 0,
  outer_face_area_m2: 0,
  inner_face_area_m2: 0,
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
