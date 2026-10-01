/**
 * standaloneTypes.ts — the contract between the app's HTML export and the
 * viewer that lives inside the exported file.
 *
 * The exported `.html` carries three blobs: the model as a GLB, this data
 * block, and (optionally) the whole `.bbim` project. The viewer reads them
 * back from `<script>` tags — it has no other source of truth, so anything
 * it should know about the building has to be in here. Type-only: the viewer
 * is built as a separate bundle (see vite.viewer.config.ts) and shares no
 * runtime code with the app.
 */

export interface StandaloneStorey {
  id: string;
  name: string;
  bottomMm: number;
  topMm: number;
}

export interface StandaloneElement {
  name: string;
  type: string;
  storeyId?: string;
  /** The node's own properties, primitives only — what the info panel lists. */
  props: Record<string, string | number | boolean>;
  /**
   * Named groups of further properties, listed under the plain ones. An IFC
   * element's property sets and quantity sets come through here, each under
   * its own heading; the project's own elements have none.
   */
  groups?: StandalonePropertyGroup[];
  /** The source the element came from — `StandaloneSourceInfo.id`. */
  source?: string;
}

export interface StandalonePropertyGroup {
  name: string;
  props: Record<string, string | number | boolean>;
}

/**
 * One model the file carries. The project's own building is a source like
 * any other; an imported IFC is another. Every mesh in the GLB names its
 * source on `userData.source`, which is how the viewer can show or hide one
 * model at a time when the file holds several.
 */
export interface StandaloneSourceInfo {
  id: string;
  name: string;
  kind: 'project' | 'ifc';
  /** How many elements it contributed to `StandaloneData.elements`. */
  elements: number;
}

export interface StandaloneDrawing {
  id: string;
  title: string;
  kind: 'plan' | 'section' | 'elevation';
  /** A complete `<svg>` element, self-contained (hatch defs inside). */
  svg: string;
}

/**
 * One article of the bill of quantities, as the exported file carries it.
 *
 * `quantity` and `unitPrice` are the two numbers the reader may change: a
 * contractor prices the job by putting their own rates against the
 * quantities the model measured. Everything else on the row is the article's
 * identity and is fixed. The value of a row is never stored — it is always
 * `quantity × unitPrice`, recomputed wherever it is shown, so a total can
 * never fall out of step with the numbers above it.
 */
export interface StandaloneBoqRow {
  /** `normId::storeyId` — the row's identity, stable across edits. */
  key: string;
  nrCrt: number;
  symbol: string;
  denumire: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  capitol: string;
  categorie: string;
  storeyId: string;
  storeyName: string;
  /** How many model elements the quantity came from. */
  elements: number;
}

export interface StandaloneBoq {
  currency: string;
  /** The norm catalogue the quantities were measured against. */
  catalogVersion: string;
  rows: StandaloneBoqRow[];
}

export interface StandaloneData {
  projectName: string;
  exportedAt: string;
  generator: string;
  storeys: StandaloneStorey[];
  /** Keyed by the node id every mesh in the GLB carries as `userData.nodeId`. */
  elements: Record<string, StandaloneElement>;
  drawings: StandaloneDrawing[];
  /** The bill of quantities, when the model has one. */
  boq?: StandaloneBoq;
  /** The models in the file. Absent in files written before sources existed. */
  sources?: StandaloneSourceInfo[];
}

/** Ids of the `<script>` tags the viewer reads its payload from. */
export const STANDALONE_TAG = {
  data: 'bbim-data',
  glb: 'bbim-glb',
  project: 'bbim-project',
} as const;
