/**
 * standaloneSources.ts — a model the HTML export can carry, whatever it
 * came from.
 *
 * The exported file's viewer displays triangles and looks ids up: every mesh
 * in its GLB names an element, and a data block says what that element is.
 * So anything the app can load becomes exportable the moment it can be put
 * in that shape — a group of meshes with the ids on `userData`, and the
 * element records those ids resolve to. That shape is `StandaloneSource`,
 * and this module builds it from an imported IFC.
 *
 * The project's own building is built into the same shape by
 * `standaloneExport.ts`; the two meet in `buildStandaloneHtmlFromSources`.
 *
 * An IFC comes in as the fragments model the World view keeps for picking,
 * plus the Three.js flattening it drew the globe with. The flattening
 * already has one mesh per element, named after it; what is added here is
 * the storey each element stands on — read off the file's spatial structure,
 * because a mesh knows nothing of that — and the element's properties, read
 * in batches from the fragments model the way the properties panel reads
 * them one at a time.
 */

import * as THREE from 'three';
import type { ItemData, ItemsDataConfig, SpatialTreeItem } from '@thatopen/fragments';
import {
  ITEM_DATA_CONFIG, itemNodeName, normalizeItemData, type IfcElementProperties,
} from '@/lib/ifc/ifcFragments';
import type {
  StandaloneElement, StandalonePropertyGroup, StandaloneSourceInfo, StandaloneStorey,
} from './standaloneTypes';

/** One model, ready to be baked into the file. */
export interface StandaloneSource {
  info: StandaloneSourceInfo;
  /**
   * The geometry: meshes carrying `nodeId`, `nodeType`, `storeyId` and
   * `source` on `userData`. The exporter re-parents this into its own scene,
   * so it must be the exporter's to take — a copy, or something built for it.
   */
  group: THREE.Object3D;
  storeys: StandaloneStorey[];
  /** Keyed by the `nodeId` the meshes carry. */
  elements: Record<string, StandaloneElement>;
  /** Where the model stands in the file's shared frame. Identity when absent. */
  placement?: THREE.Matrix4;
  /** Called once the file is built; for a source that owns its geometry. */
  dispose?: () => void;
}

/** The slice of a fragments model this reads, so a test can hand in a stub. */
export interface IfcSourceModel {
  modelId: string;
  getSpatialStructure(): Promise<SpatialTreeItem>;
  getItemsData(ids: number[], config?: Partial<ItemsDataConfig>): Promise<ItemData[]>;
}

/** Longer property strings are notes, not values; the panel truncates them. */
const MAX_PROP_CHARS = 300;

/** Elements per `getItemsData` round trip to the fragments worker. */
const BATCH = 400;

/** Only the entity's own attributes — what a storey needs: Name, Elevation. */
const ATTRIBUTES_ONLY: Partial<ItemsDataConfig> = {
  attributesDefault: true,
  relationsDefault: { attributes: false, relations: false },
};

// ─── The spatial structure ────────────────────────────────────────────────────

export interface StoreyMap {
  /** Storeys in the order the tree lists them. */
  storeyIds: number[];
  /** Element local id → the storey it is contained in, however deep. */
  byItem: Map<number, number>;
}

/**
 * Which storey each element belongs to, from the spatial tree.
 *
 * The tree nests project → site → building → storey → elements, and an
 * element may nest further (an aggregate's parts, a wall's openings). Every
 * node under a storey is that storey's, at any depth; the first storey met
 * on the way down wins, which is also the only one there is — storeys do
 * not nest.
 *
 * Measured, not assumed: fragments writes the tree as ALTERNATING levels. A
 * node with a category and no local id groups the instances of that
 * category, which follow as its children with a local id and NO category —
 * `{ IFCBUILDINGSTOREY, null } → { null, 89955 } → { IFCWALL, null } → …`.
 * So an instance's category is its parent's, and a node with both (the
 * shape a hand-written tree naturally takes) is read as itself.
 */
export function mapStoreys(tree: SpatialTreeItem): StoreyMap {
  const storeyIds: number[] = [];
  const byItem = new Map<number, number>();
  const walk = (item: SpatialTreeItem, storey: number | null, inherited: string | null) => {
    const cat = (item.category ?? inherited ?? '').toUpperCase();
    const isInstance = item.localId !== null && item.localId !== undefined;
    let here = storey;
    if (isInstance) {
      if (here === null && cat === 'IFCBUILDINGSTOREY') {
        here = item.localId as number;
        storeyIds.push(here);
      } else if (here !== null) {
        byItem.set(item.localId as number, here);
      }
    }
    // A category node's children are its instances; an instance's children
    // are category nodes again, which name themselves.
    const passDown = isInstance ? null : (item.category ?? inherited);
    for (const c of item.children ?? []) walk(c, here, passDown);
  };
  walk(tree, null, null);
  return { storeyIds, byItem };
}

/**
 * Storey elevations, whatever unit the file wrote them in, as millimetres.
 *
 * `IfcBuildingStorey.Elevation` is in the file's length unit, and fragments
 * hands it over as written. Reading the unit itself means walking
 * IfcProject → UnitsInContext, which fragments does not expose; but the
 * model's own height does the job: the span from lowest storey to highest
 * is a few metres in a real building, so whichever reading of the numbers
 * comes out nearest the geometry's height is the right one. A single storey
 * has no span, so its value alone decides: nothing in a building stands at
 * a hundred metres in metres and at a hundred millimetres in millimetres
 * both, so 100 is the cut.
 *
 * A storey without an elevation reads as 0; the viewer only uses the number
 * to offer a cut 1.5 m above it, so a guess costs little.
 */
export function elevationsToMm(elevations: (number | null)[], modelHeightM: number): number[] {
  const known = elevations.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  let factor: number;   // multiply by this to get millimetres
  if (known.length === 0) {
    factor = 1;
  } else if (known.length >= 2 && Math.max(...known) - Math.min(...known) > 0 && modelHeightM > 0) {
    const span = Math.max(...known) - Math.min(...known);
    const offIfMetres = Math.abs(Math.log(span / modelHeightM));
    const offIfMm = Math.abs(Math.log((span / 1000) / modelHeightM));
    factor = offIfMetres <= offIfMm ? 1000 : 1;
  } else {
    factor = Math.max(...known.map(Math.abs)) > 100 ? 1 : 1000;
  }
  return elevations.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v * factor : 0));
}

// ─── Elements ─────────────────────────────────────────────────────────────────

type Scalar = string | number | boolean;

function clip(v: unknown): Scalar | null {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v === '') return null;
    return v.length > MAX_PROP_CHARS ? `${v.slice(0, MAX_PROP_CHARS)}…` : v;
  }
  return null;
}

function scalarRecord(src: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(src)) {
    const c = clip(v);
    if (c !== null) out[k] = c;
  }
  return out;
}

/** An IFC element's properties in the shape the viewer's panel lists. */
export function elementFromIfc(
  p: IfcElementProperties,
  storeyId: string | undefined,
  source: string,
): StandaloneElement {
  const props = scalarRecord({
    ...(p.guid ? { GlobalId: p.guid } : {}),
    ...p.attributes,
    ...(p.typeName ? { Tip: p.typeName } : {}),
    ...(p.materials.length ? { Materiale: p.materials.join(', ') } : {}),
  });
  const groups: StandalonePropertyGroup[] = p.psets
    .map((ps) => ({
      name: ps.kind === 'qto' ? `${ps.name} · cantități` : ps.name,
      props: scalarRecord(ps.props),
    }))
    .filter((g) => Object.keys(g.props).length > 0);
  return {
    name: p.name || p.category || String(p.localId),
    type: p.category,
    ...(storeyId ? { storeyId } : {}),
    props,
    ...(groups.length ? { groups } : {}),
    source,
  };
}

function attrValue(d: ItemData | undefined, key: string): unknown {
  const a = d?.[key] as { value?: unknown } | undefined;
  return a && typeof a === 'object' && 'value' in a ? a.value : undefined;
}

// ─── The source ───────────────────────────────────────────────────────────────

export interface IfcSourceOptions {
  /** Identifies the source inside the file; the model id does. */
  id: string;
  /** What the viewer calls it — the file's name, usually. */
  name: string;
  placement?: THREE.Matrix4;
}

/**
 * An imported IFC as a source.
 *
 * `group` is the flattening the World view drew — one mesh per element,
 * named `ifc:<model>:<localId>`, with the local id and category on
 * `userData` and the file's coordination already applied to the group. It
 * is copied, not taken: the World view goes on drawing from it, and the
 * copy is what gets the export's ids written onto it. Geometry and
 * materials are shared with the original, which is why the source has no
 * `dispose` — none of it is ours to free.
 */
export async function ifcSource(
  model: IfcSourceModel,
  group: THREE.Object3D,
  opts: IfcSourceOptions,
): Promise<StandaloneSource> {
  const own = group.clone(true);
  own.name = opts.id;

  const meshes: { mesh: THREE.Mesh; localId: number; category: string }[] = [];
  own.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const localId = Number(mesh.userData?.ifcLocalId);
    if (!Number.isInteger(localId)) return;
    meshes.push({ mesh, localId, category: String(mesh.userData?.ifcCategory ?? '').toUpperCase() });
  });

  // ── Storeys ────────────────────────────────────────────────────────────────
  let storeyMap: StoreyMap = { storeyIds: [], byItem: new Map() };
  try {
    storeyMap = mapStoreys(await model.getSpatialStructure());
  } catch (err) {
    console.warn('[standaloneSources] no spatial structure; elements go without a storey:', err);
  }
  const storeys: StandaloneStorey[] = [];
  if (storeyMap.storeyIds.length) {
    let rows: ItemData[] = [];
    try {
      rows = await model.getItemsData(storeyMap.storeyIds, ATTRIBUTES_ONLY);
    } catch (err) {
      console.warn('[standaloneSources] storey attributes unreadable:', err);
    }
    const heightM = new THREE.Box3().setFromObject(own).getSize(new THREE.Vector3()).y;
    const elevations = storeyMap.storeyIds.map((_, i) => {
      const v = attrValue(rows[i], 'Elevation');
      return typeof v === 'number' ? v : null;
    });
    const bottoms = elevationsToMm(elevations, heightM);
    storeyMap.storeyIds.forEach((localId, i) => {
      const name = attrValue(rows[i], 'Name');
      storeys.push({
        id: itemNodeName(model.modelId, localId),
        name: typeof name === 'string' && name ? name : `Etaj ${i + 1}`,
        bottomMm: bottoms[i],
        // The viewer never reads a storey's top; the next one's bottom is it.
        topMm: bottoms[i] + 3000,
      });
    });
    storeys.sort((a, b) => a.bottomMm - b.bottomMm);
  }
  const storeyIdOf = (localId: number): string | undefined => {
    const s = storeyMap.byItem.get(localId);
    return s === undefined ? undefined : itemNodeName(model.modelId, s);
  };

  // ── Properties, in batches ─────────────────────────────────────────────────
  const elements: Record<string, StandaloneElement> = {};
  const ids = meshes.map((m) => m.localId);
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    let rows: ItemData[] = [];
    try {
      rows = await model.getItemsData(slice, ITEM_DATA_CONFIG);
    } catch (err) {
      console.warn('[standaloneSources] properties unreadable for a batch; ids only:', err);
    }
    slice.forEach((localId, j) => {
      const nodeId = itemNodeName(model.modelId, localId);
      const d = rows[j];
      elements[nodeId] = d
        ? elementFromIfc(normalizeItemData(model.modelId, localId, d), storeyIdOf(localId), opts.id)
        : { name: nodeId, type: meshes[i + j].category, storeyId: storeyIdOf(localId), props: {}, source: opts.id };
    });
  }

  // ── The ids the viewer reads ───────────────────────────────────────────────
  for (const { mesh, localId, category } of meshes) {
    const nodeId = itemNodeName(model.modelId, localId);
    const storeyId = storeyIdOf(localId);
    mesh.name = nodeId;
    mesh.userData = {
      nodeId,
      nodeType: elements[nodeId]?.type || category,
      ...(storeyId ? { storeyId } : {}),
      source: opts.id,
    };
  }

  return {
    info: { id: opts.id, name: opts.name, kind: 'ifc', elements: Object.keys(elements).length },
    group: own,
    storeys,
    elements,
    ...(opts.placement ? { placement: opts.placement } : {}),
  };
}
