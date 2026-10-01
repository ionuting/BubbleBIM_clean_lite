/**
 * Architectural style — shared types.
 *
 * A style is a set of SEMANTIC RULES applied to the graph, not geometry: "the
 * roof is a hip at 35°", "the entrance facade gets a porch on timber posts",
 * "the plinth is stone up to the floor". Each rule reads the building through
 * `analyzeBuilding` (which walls are exterior, where the entrance is, where
 * the roof sits) and writes ordinary nodes — sweeps, sketches, free axes — or
 * properties on the nodes already there. Every solver the app has (roof,
 * sweep, sketch, IFC export, quantities) then does the geometry, exactly as
 * it would for a node the user drew.
 *
 * So a styled model stays a model: editable node by node, re-styled with other
 * parameters, or returned to what it was.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';

/** One knob of a style, with the range the style allows. */
export type StyleParamDef =
  | {
    key: string; label: string; group: StyleGroup; kind: 'number';
    unit: 'mm' | '°' | 'buc'; min: number; max: number; step: number; help?: string;
  }
  | { key: string; label: string; group: StyleGroup; kind: 'bool'; help?: string }
  | { key: string; label: string; group: StyleGroup; kind: 'choice'; options: { value: string; label: string }[]; help?: string }
  | { key: string; label: string; group: StyleGroup; kind: 'color'; help?: string };

export type StyleGroup = 'roof' | 'envelope' | 'ornament' | 'porch' | 'details';

export const STYLE_GROUP_LABELS: Record<StyleGroup, string> = {
  roof: 'Acoperiș',
  envelope: 'Fațade',
  ornament: 'Ornamente',
  porch: 'Intrare',
  details: 'Detalii',
};

export type StyleValue = number | boolean | string;
export type StyleParams = Record<string, StyleValue>;

export type StyleFamily = 'traditional' | 'modern' | 'classic';

export const STYLE_FAMILY_LABELS: Record<StyleFamily, string> = {
  traditional: 'Tradițional românesc',
  modern: 'Modern',
  classic: 'Clasic',
};

export interface StylePack {
  id: string;
  family: StyleFamily;
  label: string;
  region: string;
  description: string;
  /** Defaults; every key of `STYLE_PARAMS` is present. */
  params: StyleParams;
  /** Per-pack narrowing of a numeric range — the style's own limits. */
  ranges?: Record<string, [number, number]>;
}

/** What the engine did, one line per decision, for the preview and the log. */
export interface StyleChange {
  group: StyleGroup;
  kind: 'add' | 'modify' | 'remove';
  text: string;
  nodeIds: string[];
}

export interface StyleIssue {
  severity: 'error' | 'warning' | 'info';
  text: string;
}

export interface StyleResult {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  changes: StyleChange[];
  issues: StyleIssue[];
  /** Figures the rules derived, for the preview (lift, eave height, posts…). */
  figures: Record<string, number>;
}

/**
 * Markers on the nodes a style touches. Generated nodes carry `style_part`;
 * a node the style modified keeps what it had under `style_prev`, so the style
 * can be taken off again — or re-applied with other parameters — without
 * leaving anything of the previous run behind.
 */
export const STYLE_PACK_KEY = 'style_pack';
export const STYLE_PART_KEY = 'style_part';
export const STYLE_PREV_KEY = 'style_prev';
export const STYLE_PARAMS_KEY = 'style_params';
