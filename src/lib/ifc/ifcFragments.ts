/**
 * ifcFragments.ts — an imported IFC as a That Open fragments model, usable
 * with or without an OBC world.
 *
 * Two consumers, one core:
 *
 *   The TOC viewer already turns an IFC into fragments through
 *   `OBC.IfcLoader`; it only needed a way to READ an element it picks. That is
 *   `readItemProperties` + `normalizeItemData`.
 *
 *   The World view is Cesium, which cannot draw fragments tiles. It needs the
 *   same model twice over: converted headlessly (`convertIfcToFragments` +
 *   `loadFragments`, no scene, no camera), then flattened to one Three.js mesh
 *   per element (`fragmentsToThreeGroup`) so the existing GLB → Cesium.Model
 *   path can place it — and the mesh NAMES carry the element's local id, so a
 *   Cesium pick on a glTF node can be traced back to the IFC element and its
 *   properties read from the fragments model kept alongside.
 *
 * `normalizeItemData` is the only piece with logic worth testing and is pure:
 * it takes the nested `ItemData` fragments returns and produces a flat record
 * of attributes, property sets, quantities, type and materials.
 */

import * as THREE from 'three';
import {
  FragmentsModels, IfcImporter,
  type FragmentsModel, type ItemData, type MaterialDefinition, type MeshData, type RawMaterial,
} from '@thatopen/fragments';
import type { BodyColour, ProductBody } from './indexedColours';

// The same locations WebIfcViewer uses. Production builds copy the worker to
// public/fragments/worker.mjs — see docs/OBC_VIEWER.md.
export const FRAGMENTS_WORKER_URL = '/node_modules/@thatopen/fragments/dist/Worker/worker.mjs';
export const WEBIFC_WASM_PATH = 'https://unpkg.com/web-ifc@0.0.77/';

// ── Properties ────────────────────────────────────────────────────────────────

export type IfcScalar = string | number | boolean | null;

export interface IfcPropertySet {
  name: string;
  /** IFCPROPERTYSET or IFCELEMENTQUANTITY — quantities are shown apart. */
  kind: 'pset' | 'qto';
  props: Record<string, IfcScalar>;
}

export interface IfcElementProperties {
  modelId: string;
  localId: number;
  guid: string | null;
  /** e.g. "IFCWALL". */
  category: string;
  name: string | null;
  /** Direct entity attributes (Name, Tag, ObjectType, Description…), scalar only. */
  attributes: Record<string, IfcScalar>;
  psets: IfcPropertySet[];
  typeName: string | null;
  materials: string[];
}

const isAttr = (v: unknown): v is { value: unknown; type?: string } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as object);

function scalar(v: unknown): IfcScalar {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  // web-ifc wraps typed values as { value, type }; unwrap one level.
  if (isAttr(v)) return scalar(v.value);
  return String(v);
}

function attrString(d: ItemData, key: string): string | null {
  const a = d[key];
  if (!isAttr(a)) return null;
  const s = scalar(a.value);
  return s === null ? null : String(s);
}

function category(d: ItemData): string {
  return (attrString(d, '_category') ?? '').toUpperCase();
}

/** One IfcProperty* or IfcQuantity* item → name and its single scalar value. */
function propertyEntry(p: ItemData): [string, IfcScalar] | null {
  const name = attrString(p, 'Name');
  if (!name) return null;
  // IfcPropertySingleValue → NominalValue; quantities carry *Value; enumerated
  // and list values keep their arrays as a readable join.
  for (const k of ['NominalValue', 'LengthValue', 'AreaValue', 'VolumeValue', 'CountValue', 'WeightValue', 'TimeValue']) {
    if (k in p) return [name, scalar((p[k] as { value: unknown }).value)];
  }
  if ('EnumerationValues' in p || 'ListValues' in p) {
    const raw = (p.EnumerationValues ?? p.ListValues) as unknown;
    const arr = isAttr(raw) ? raw.value : raw;
    if (Array.isArray(arr)) return [name, arr.map((x) => String(scalar(x))).join(', ')];
  }
  return [name, null];
}

/**
 * The nested `ItemData` fragments hands back → a flat, display-ready record.
 *
 * Direct attributes are whatever scalar keys the entity has, minus the
 * bookkeeping ones fragments prefixes with `_`. Relations are arrays: an
 * `IsDefinedBy` pset carries `HasProperties`, a quantity set carries
 * `Quantities`, `IsTypedBy` carries the type, `HasAssociations` the materials.
 * Anything else that is a relation is ignored rather than dumped, so the panel
 * shows what a person means by "the properties of this wall".
 */
export function normalizeItemData(modelId: string, localId: number, d: ItemData): IfcElementProperties {
  const attributes: Record<string, IfcScalar> = {};
  const psets: IfcPropertySet[] = [];
  let typeName: string | null = null;
  const materials: string[] = [];

  for (const [key, v] of Object.entries(d)) {
    if (Array.isArray(v)) {
      for (const rel of v) collectRelation(key, rel, psets, materials, (t) => { typeName = typeName ?? t; });
      continue;
    }
    if (!isAttr(v) || key.startsWith('_')) continue;
    attributes[key] = scalar(v.value);
  }

  return {
    modelId,
    localId,
    guid: attrString(d, '_guid'),
    category: category(d),
    name: attrString(d, 'Name'),
    attributes,
    psets,
    typeName,
    materials,
  };
}

function collectRelation(
  relName: string,
  rel: ItemData,
  psets: IfcPropertySet[],
  materials: string[],
  onType: (name: string) => void,
): void {
  const cat = category(rel);
  if (cat === 'IFCPROPERTYSET' || cat === 'IFCELEMENTQUANTITY') {
    const kind: IfcPropertySet['kind'] = cat === 'IFCELEMENTQUANTITY' ? 'qto' : 'pset';
    const items = (rel.HasProperties ?? rel.Quantities) as unknown;
    const props: Record<string, IfcScalar> = {};
    if (Array.isArray(items)) {
      for (const p of items as ItemData[]) {
        const e = propertyEntry(p);
        if (e) props[e[0]] = e[1];
      }
    }
    psets.push({ name: attrString(rel, 'Name') ?? cat, kind, props });
    return;
  }
  if (cat.endsWith('TYPE') || relName === 'IsTypedBy') {
    const n = attrString(rel, 'Name');
    if (n) onType(n);
    return;
  }
  if (cat.startsWith('IFCMATERIAL')) {
    // IfcMaterial has Name; layer sets carry MaterialLayers → Material → Name.
    const n = attrString(rel, 'Name');
    if (n) materials.push(n);
    const layers = rel.MaterialLayers as unknown;
    if (Array.isArray(layers)) {
      for (const layer of layers as ItemData[]) {
        const mats = layer.Material as unknown;
        const list = Array.isArray(mats) ? (mats as ItemData[]) : [];
        for (const m of list) {
          const mn = attrString(m, 'Name');
          if (mn) materials.push(mn);
        }
      }
    }
  }
}

/** Query config: entity attributes, psets with their properties, type, materials. */
export const ITEM_DATA_CONFIG = {
  attributesDefault: true,
  relationsDefault: { attributes: true, relations: false },
  relations: {
    IsDefinedBy: { attributes: true, relations: true },
    IsTypedBy: { attributes: true, relations: false },
    HasAssociations: { attributes: true, relations: true },
  },
} as const;

/**
 * Just the GUID — the key a host platform uses to find the element in its own
 * data. Cheaper than reading the properties, and independent of them: it
 * comes straight off the fragments index, so it is known even for an element
 * whose property read fails.
 */
export async function readItemGuid(model: FragmentsModel, localId: number): Promise<string | null> {
  try {
    const [guid] = await model.getGuidsByLocalIds([localId]);
    return guid ?? null;
  } catch {
    return null;
  }
}

/** Everything about one element, ready for a panel. */
export async function readItemProperties(
  model: FragmentsModel,
  localId: number,
): Promise<IfcElementProperties | null> {
  const [data] = await model.getItemsData([localId], ITEM_DATA_CONFIG);
  if (!data) return null;
  return normalizeItemData(model.modelId, localId, data);
}

// ── Headless conversion ───────────────────────────────────────────────────────

let importer: IfcImporter | null = null;
function getImporter(): IfcImporter {
  if (!importer) {
    importer = new IfcImporter();
    importer.wasm = { path: WEBIFC_WASM_PATH, absolute: true };
  }
  return importer;
}

/** IFC bytes → fragments bytes, no scene involved. Slow: web-ifc parses the whole file. */
export async function convertIfcToFragments(
  bytes: Uint8Array,
  onProgress?: (p: number) => void,
): Promise<Uint8Array> {
  const imp = getImporter();
  return imp.process({
    bytes,
    // Compressed output (raw: false) — matched by loadFragments, which loads
    // with raw: false. Mismatching the two yields a silent parse failure.
    raw: false,
    ...(onProgress ? { progressCallback: (p: number) => onProgress(p) } : {}),
  });
}

let headless: FragmentsModels | null = null;
/**
 * One fragments engine for the parts of the app that have no OBC world (the
 * Cesium globe). Created on first use; the worker stays up for the session.
 */
export function getHeadlessFragments(): FragmentsModels {
  if (!headless) headless = new FragmentsModels(FRAGMENTS_WORKER_URL);
  return headless;
}

export async function loadFragments(
  core: FragmentsModels,
  buffer: Uint8Array,
  modelId: string,
): Promise<FragmentsModel> {
  if (core.models.list.has(modelId)) await core.disposeModel(modelId);
  const model = await core.load(buffer, { modelId, raw: false });
  await core.update(true);
  return model;
}

// ── Flatten to Three.js ───────────────────────────────────────────────────────

/** `ifc:<modelId>:<localId>` — the mesh name a Cesium pick gives back. */
export function itemNodeName(modelId: string, localId: number): string {
  return `ifc:${modelId}:${localId}`;
}

/** The inverse. Model ids may themselves contain ':'; the local id never does. */
export function parseItemNodeName(name: string | undefined | null): { modelId: string; localId: number } | null {
  if (!name || !name.startsWith('ifc:')) return null;
  const cut = name.lastIndexOf(':');
  if (cut <= 4) return null;
  const localId = Number(name.slice(cut + 1));
  if (!Number.isInteger(localId)) return null;
  return { modelId: name.slice(4, cut), localId };
}

/** A small, stable palette so a wall is not the same grey as a slab. */
const CATEGORY_COLOURS: Record<string, number> = {
  IFCWALL: 0xd9d4c7, IFCWALLSTANDARDCASE: 0xd9d4c7,
  IFCSLAB: 0xb8b8b8, IFCROOF: 0xb5553a, IFCCOLUMN: 0x9a8a72, IFCBEAM: 0x8f7a5c,
  IFCWINDOW: 0x7fb3d5, IFCDOOR: 0xa8754b, IFCSTAIR: 0xa0a0a0, IFCRAILING: 0x707070,
  IFCFOOTING: 0x8c7b6a, IFCSPACE: 0x6fa8dc, IFCCOVERING: 0xcfcfd6, IFCFURNISHINGELEMENT: 0xc9a86a,
};

/**
 * One `MeshData` → a Three.js geometry, on buffers WE own.
 *
 * The copy is not a nicety. At full level of detail fragments hands back the
 * position buffer BY REFERENCE, straight out of the virtual-memory pool it
 * reuses from one sample to the next — and several items that share a
 * representation (a row of identical cubes, every member of a frame) are
 * handed the very same array. Wrapping it directly and then calling
 * `applyMatrix4` writes the transform back into fragments' own memory: the
 * next item reads geometry that has already been moved, and the one after
 * that reads it moved twice. What you see is elements collapsed onto each
 * other and others nowhere near where they belong.
 *
 * So: copy first, transform second, always.
 */
export function meshDataToGeometry(md: MeshData): THREE.BufferGeometry | null {
  if (!md.positions || md.positions.length < 9) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(md.positions), 3));
  if (md.indices && md.indices.length >= 3) {
    // Copied for the same reason, and widened: a Uint8/Uint16 index array is
    // shared memory too, and a merge may push the count past its range.
    geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(md.indices), 1));
  }
  // Fragments ships normals as quantised Int16; recomputing avoids caring how.
  geo.computeVertexNormals();
  geo.applyMatrix4(md.transform);
  return geo;
}

/**
 * Every element with geometry, as one named Three.js mesh each.
 *
 * Fragments keeps geometry off the main thread and only materialises tiles a
 * camera looks at; this asks for it explicitly, per item, which is what a
 * glTF export needs. Meshes are grouped under the model so the caller can
 * export, position or dispose the lot at once.
 */
export interface FlattenOptions {
  /**
   * Colours the file gives through IfcIndexedColourMap, which web-ifc does
   * not read — `readIndexedColours` on the IFC text. Keyed by product id,
   * which is the fragments local id.
   */
  bodyColours?: Map<number, ProductBody[]>;
}

/**
 * Which colour map colour, if any, each of an element's bodies takes.
 *
 * web-ifc emits an element's bodies in the order the text lists them, so
 * when the counts agree the k-th body is the k-th item. When they do not
 * (a boolean, an item web-ifc split or dropped) the pairing is unknown, and
 * only an element whose every item has the same colour can still be coloured
 * — all of it, with that colour.
 */
export function colourPerBody(bodies: ProductBody[] | undefined, count: number): (BodyColour | null)[] {
  const none = new Array<BodyColour | null>(count).fill(null);
  if (!bodies || bodies.length === 0) return none;
  if (bodies.length === count) return bodies.map((b) => b.colour);
  const first = bodies[0].colour;
  const same = !!first && bodies.every((b) => b.colour
    && b.colour.opacity === first.opacity
    && b.colour.rgb.every((v, k) => v === first.rgb[k]));
  return same ? new Array(count).fill(first) : none;
}

export async function fragmentsToThreeGroup(model: FragmentsModel, opts: FlattenOptions = {}): Promise<THREE.Group> {
  const group = new THREE.Group();
  group.name = model.modelId;

  const ids = await model.getItemsIdsWithGeometry();
  if (ids.length === 0) return group;
  const [geoms, cats] = await Promise.all([
    model.getItemsGeometry(ids),
    model.getItemsWithGeometryCategories(),
  ]);

  // Back into the file's own project coordinates — see `modelToProjectMatrix`
  // for why this is the INVERSE of what fragments calls the coordination.
  const toProject = await modelToProjectMatrix(model);
  if (!isIdentity(toProject)) group.applyMatrix4(toProject);

  // ── Colours ────────────────────────────────────────────────────────────────
  // The model's OWN materials, the ones the file carries and the ones
  // fragments draws with in the TOC viewer. Taking them here is what keeps
  // every representation of the model looking the same: the glTF handed to
  // Cesium, the 3D Tiles built from this group, the HTML export and the
  // fragments overlay all end up with one appearance instead of several.
  //
  // Per SAMPLE, not per item. An element is several bodies with a material
  // each — a door's frame, leaf and glass; a window's sash and pane — and
  // each `MeshData` names its sample. `getItemsMaterialDefinition` cannot be
  // used for this: it answers one material per item, and in 3.4.5 reads it
  // as `meshes.samples(itemIndex)` — the item's index taken for a sample
  // index — so the colour it returns belongs to some other body of some
  // other element. Measured on the IFC4 sample house: doors came out black,
  // the glass opaque, a space brown.
  //
  // The category palette below is only a fallback for a body the file gave
  // no material, or a model that cannot answer.
  let sampleMaterial = (_sampleId: number | undefined): RawMaterial | undefined => undefined;
  try {
    const [samples, materials] = await Promise.all([model.getSamples(), model.getMaterials()]);
    sampleMaterial = (sampleId) => {
      if (sampleId === undefined) return undefined;
      const sample = samples.get(sampleId);
      return sample ? materials.get(sample.material) : undefined;
    };
  } catch (err) {
    console.warn('[ifcFragments] no sample materials, falling back to the category palette:', err);
  }

  const matCache = new Map<string, THREE.MeshStandardMaterial>();
  const cached = (key: string, make: () => THREE.MeshStandardMaterial) => {
    let m = matCache.get(key);
    if (!m) { m = make(); matCache.set(key, m); }
    return m;
  };

  const materialFor = (cat: string, raw: RawMaterial | undefined, mapped: BodyColour | null = null) => {
    if (mapped) {
      // A colour map is the file's own word on this body, and more specific
      // than any surface style: it is attached to the geometry itself.
      const [r, g, b] = mapped.rgb;
      return cached(`i:${r}:${g}:${b}:${mapped.opacity}`, () => new THREE.MeshStandardMaterial({
        color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace),
        opacity: mapped.opacity,
        transparent: mapped.opacity < 1,
        depthWrite: mapped.opacity >= 1,
        side: THREE.DoubleSide,
        roughness: 0.75,
        metalness: 0.05,
      }));
    }
    if (raw) {
      // Keyed on what actually differs, so a model with three materials makes
      // three, not one per body.
      return cached(`r:${raw.r}:${raw.g}:${raw.b}:${raw.a}:${raw.renderedFaces}`, () => {
        const opacity = Math.min(Math.max(raw.a / 255, 0), 1);
        return new THREE.MeshStandardMaterial({
          // Bytes in sRGB — the way fragments' own ParserHelper reads them.
          color: new THREE.Color().setRGB(raw.r / 255, raw.g / 255, raw.b / 255, THREE.SRGBColorSpace),
          opacity,
          transparent: opacity < 1,
          depthWrite: opacity >= 1,
          // RenderedFaces.ONE means the file says one side is enough; anything
          // else is double-sided, which is also the safer default for IFC.
          side: raw.renderedFaces === 0 ? THREE.FrontSide : THREE.DoubleSide,
          roughness: 0.75,
          metalness: 0.05,
        });
      });
    }
    return cached(`c:${cat}`, () => new THREE.MeshStandardMaterial({
      color: CATEGORY_COLOURS[cat] ?? 0xbfbfbf,
      roughness: 0.75, metalness: 0.1,
      side: THREE.DoubleSide,
      ...(cat === 'IFCWINDOW' ? { transparent: true, opacity: 0.45 } : {}),
      ...(cat === 'IFCSPACE' ? { transparent: true, opacity: 0.12 } : {}),
    }));
  };

  ids.forEach((localId, i) => {
    const cat = (cats[i] ?? '').toUpperCase();
    // Bodies grouped by material, in the order the materials first appear.
    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const bodies = geoms[i] ?? [];
    const mapped = colourPerBody(opts.bodyColours?.get(localId), bodies.length);
    bodies.forEach((md, k) => {
      const geo = meshDataToGeometry(md);
      if (!geo) return;
      const mat = materialFor(cat, sampleMaterial(md.sampleId), mapped[k]);
      const list = byMaterial.get(mat);
      if (list) list.push(geo); else byMaterial.set(mat, [geo]);
    });
    if (byMaterial.size === 0) return;

    // One mesh per element even when it has several bodies: the pick has to
    // land on ONE node name, and merging keeps the glTF node count sane.
    // Several materials become geometry groups on that one mesh — one glTF
    // primitive each — rather than several meshes with the same id.
    const mats = [...byMaterial.keys()];
    const perMat = mats.map((m) => {
      const list = byMaterial.get(m)!;
      return list.length === 1 ? list[0] : mergeGeometries(list);
    });
    const geo = perMat.length === 1 ? perMat[0] : mergeGeometries(perMat, true);
    const mesh = new THREE.Mesh(geo, mats.length === 1 ? mats[0] : mats);
    mesh.name = itemNodeName(model.modelId, localId);
    mesh.userData.ifcLocalId = localId;
    mesh.userData.ifcCategory = cat;
    group.add(mesh);
  });

  return group;
}

/**
 * The colour out of a fragments material definition, as a real `THREE.Color`.
 *
 * The type says `THREE.Color`, and inside the library it is one — but the
 * definition reaches us across a worker boundary, where structured cloning
 * keeps the FIELDS and drops the PROTOTYPE. What arrives is a plain
 * `{ r, g, b }`, so calling any Color method on it throws and takes the whole
 * import down with it. Read the numbers, build the object here.
 *
 * Returns null when there is nothing usable, which sends the caller to the
 * category palette instead of to a black model.
 */
export function definitionColour(def: MaterialDefinition | undefined): THREE.Color | null {
  const c = def?.color as unknown as { r?: unknown; g?: unknown; b?: unknown } | undefined;
  if (!c) return null;
  const n = (v: unknown) => (typeof v === 'number' && isFinite(v) ? Math.min(Math.max(v, 0), 1) : null);
  const r = n(c.r);
  const g = n(c.g);
  const b = n(c.b);
  if (r === null || g === null || b === null) return null;
  return new THREE.Color(r, g, b);
}

/** The slice of a fragments model this needs, so a test can hand in a stub. */
export interface HasCoordination {
  getCoordinationMatrix(): Promise<THREE.Matrix4 | null | undefined>;
}

/**
 * The transform that takes a model's stored geometry back to the coordinates
 * the IFC file actually uses — the ones an IfcMapConversion is relative to.
 *
 * Fragments imports with web-ifc's `COORDINATE_TO_ORIGIN`, which translates
 * the whole model so its first vertex lands at the origin (float32 has no
 * room for site coordinates in the millions). What it stores as the
 * "coordination matrix" is the matrix it APPLIED: `stored = coord × project`.
 * Measured, not assumed — the same door file loaded both ways gives a first
 * placement of (0.505, 1.0725, −0.05) uncoordinated, (−0.45, −1.0175, 0.005)
 * coordinated, and a coordination translation of exactly their difference.
 * So the way back is the inverse. Applying `coord` itself, which reads
 * naturally and is what this code once did, moves the model AWAY from where
 * the file says by another copy of the same offset.
 *
 * Every rendering of the model on the globe goes through this — the baked
 * glTF, the 3D Tiles built from it and the live fragments object — which is
 * what keeps the three standing on the same spot, with the insertion pin at
 * the IFC origin. Identity when the model carries no coordination.
 */
export async function modelToProjectMatrix(model: HasCoordination): Promise<THREE.Matrix4> {
  try {
    const coord = await model.getCoordinationMatrix();
    if (!coord || isIdentity(coord)) return new THREE.Matrix4();
    return coord.clone().invert();
  } catch (err) {
    console.warn('[ifcFragments] no coordination matrix, using stored coordinates:', err);
    return new THREE.Matrix4();
  }
}

export function isIdentity(m: THREE.Matrix4): boolean {
  return m.elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);
}

/**
 * Non-indexed concatenation; enough for export, no attribute reconciliation
 * needed. With `groups`, part i becomes geometry group i (material index i).
 */
function mergeGeometries(parts: THREE.BufferGeometry[], groups = false): THREE.BufferGeometry {
  const flat = parts.map((g) => g.index ? g.toNonIndexed() : g);
  const total = flat.reduce((n, g) => n + g.getAttribute('position').count, 0);
  const pos = new Float32Array(total * 3);
  const out = new THREE.BufferGeometry();
  let off = 0;
  flat.forEach((g, i) => {
    const a = g.getAttribute('position') as THREE.BufferAttribute;
    pos.set(a.array as Float32Array, off);
    if (groups) out.addGroup(off / 3, a.count, i);
    off += a.array.length;
  });
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

/**
 * The node name under a Cesium pick, if the pick landed on a glTF node.
 *
 * Cesium's `scene.pick` result is deliberately loosely typed; for a Model it
 * carries the runtime node under `detail.node` on current releases. Every
 * plausible location is tried so a Cesium upgrade degrades to "no element"
 * rather than to a crash.
 */
export function pickedNodeName(pick: unknown): string | null {
  if (!pick || typeof pick !== 'object') return null;
  const p = pick as Record<string, unknown>;
  const detail = p.detail as Record<string, unknown> | undefined;
  const node = (detail?.node ?? p.node) as { name?: unknown } | undefined;
  if (node && typeof node.name === 'string') return node.name;
  if (typeof p.id === 'string') return p.id;
  return null;
}
