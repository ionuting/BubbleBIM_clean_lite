/**
 * fromFragments.ts — the glue that turns a loaded IFC into a 3D Tiles tileset.
 *
 * Variant B of the World view. `spatialSplit`, `tileset` and `glbFeatures`
 * are the pure halves; this is the part that touches Three.js and the
 * browser, and it is deliberately thin so that almost all of the reasoning
 * stays testable without a GPU.
 *
 * The shape of the job:
 *
 *   one mesh per element  →  bucketed into a ground-plane grid
 *                         →  merged per (tile, category, colour)
 *                         →  a feature id stamped on every vertex
 *                         →  glTF binary per tile, metadata injected
 *                         →  blob URLs, and a tileset.json that names them
 *
 * Why per-vertex feature ids: that is the only way 3D Tiles can address an
 * element once the geometry is merged, and merging is what makes the format
 * fast. The id indexes the tile's own property table, which carries the IFC
 * GlobalId — so a Cesium pick returns the same identifier the fragments path
 * returns, and the two rendering modes agree on what was clicked.
 *
 * Everything is served from blob URLs, so there is no server in this
 * demonstration. That is also its honest limitation: a real deployment would
 * write these files once, server-side, and hand Cesium a stable URL. The
 * geometry and the tileset would be identical.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import {
  splitIntoTiles, suggestGridSize, type TileBucket, type TileItem, type Vec3,
} from './spatialSplit';
import { buildTileset } from './tileset';
import { injectFeatureMetadata, type FeatureTable } from './glbFeatures';

/**
 * What the attribute is called ON THE THREE GEOMETRY — note the absence of a
 * leading underscore, which is load-bearing.
 *
 * Three's exporter renames every attribute it does not recognise: it
 * uppercases the name, and then, because the result is not one of glTF's
 * reserved names, prefixes it with an underscore. Starting from
 * `_feature_id_0` that yields `__FEATURE_ID_0` — two underscores — and GLSL
 * reserves consecutive underscores for future keywords, so the shader Cesium
 * generates from it fails to compile and the whole scene stops rendering.
 * Starting from `feature_id_0` yields exactly `_FEATURE_ID_0`, which is both
 * legal and the name EXT_mesh_features expects.
 */
export const FEATURE_ID_ATTRIBUTE = 'feature_id_0';

/** And what it is called once exported. The injector looks for this one. */
export const GLTF_FEATURE_ID_ATTRIBUTE = '_FEATURE_ID_0';

/**
 * Three's exporter's renaming rule, reproduced so the pair above can be
 * tested without running the exporter. Mirrors `GLTFExporter.processGeometry`:
 * uppercase, then prefix anything the glTF specification does not name.
 */
export function gltfAttributeName(threeName: string): string {
  const upper = threeName.toUpperCase();
  const reserved = /^(POSITION|NORMAL|TANGENT|TEXCOORD_\d+|COLOR_\d+|JOINTS_\d+|WEIGHTS_\d+)$/;
  return reserved.test(upper) ? upper : `_${upper}`;
}

export interface ElementMesh {
  mesh: THREE.Mesh;
  localId: number;
  category: string;
  /** `#rrggbb` off the mesh's own material — part of the merge key. */
  colour: string;
  /** Set when the source names elements directly rather than by local id. */
  guid?: string | null;
}

/** `#rrggbb` for a material, or '' when it has none to read. */
function materialColour(mat: THREE.Material | undefined): string {
  const c = (mat as { color?: THREE.Color } | undefined)?.color;
  return c ? `#${c.getHexString()}` : '';
}

/**
 * `#rrggbb` for a mesh's material, or '' when it has none to read. A mesh
 * with several materials answers with its first; `meshParts` is what splits
 * it by colour.
 */
export function meshColour(mesh: THREE.Mesh): string {
  return materialColour(Array.isArray(mesh.material) ? mesh.material[0] : mesh.material);
}

/**
 * A mesh's world-space geometry, one piece per colour.
 *
 * An element flattened from fragments is one mesh, and when its bodies have
 * different materials (a door's frame and glass) they are geometry groups on
 * it. The tiler merges by colour, so each group goes its own way; a plain
 * mesh is one piece.
 */
export function meshParts(mesh: THREE.Mesh): Array<{ geometry: THREE.BufferGeometry; colour: string }> {
  const world = worldGeometry(mesh);
  if (!Array.isArray(mesh.material) || world.groups.length === 0) {
    return [{ geometry: world, colour: meshColour(mesh) }];
  }
  const flat = world.index ? world.toNonIndexed() : world;
  const pos = flat.getAttribute('position') as THREE.BufferAttribute;
  const nor = flat.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const out = flat.groups.map((g) => {
    const start = g.start;
    const count = Math.min(g.count, pos.count - start);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute((pos.array as Float32Array).slice(start * 3, (start + count) * 3), 3));
    if (nor && nor.count === pos.count) {
      geometry.setAttribute('normal', new THREE.BufferAttribute((nor.array as Float32Array).slice(start * 3, (start + count) * 3), 3));
    }
    const mat = (mesh.material as THREE.Material[])[g.materialIndex ?? 0];
    return { geometry, colour: materialColour(mat) };
  });
  if (flat !== world) flat.dispose();
  world.dispose();
  return out;
}

/**
 * How to read element identity off a mesh.
 *
 * Two sources produce these groups and they name elements differently: a
 * flattened fragments model stamps `ifcLocalId` / `ifcCategory`, while the
 * bubble graph's own Three scene stamps `nodeId` / `nodeType`. Rather than
 * teach the tiler about either, it is told how to look.
 */
export interface ElementReader {
  /** A stable integer per element. Anything returning null is not an element. */
  localId: (mesh: THREE.Mesh, index: number) => number | null;
  category: (mesh: THREE.Mesh) => string;
  /** Identity carried in the mesh itself; `guidOf` still wins when supplied. */
  guid?: (mesh: THREE.Mesh) => string | null;
}

/** The fragments convention: `ifcLocalId` and `ifcCategory`. */
export const FRAGMENTS_READER: ElementReader = {
  localId: (m) => (typeof m.userData.ifcLocalId === 'number' ? m.userData.ifcLocalId : null),
  category: (m) => String(m.userData.ifcCategory ?? ''),
};

/**
 * The bubble graph's own scene: `nodeId` names the element and IS its
 * identity, so there is no separate GlobalId to look up. The local id is
 * positional — nothing downstream needs it to mean anything but "this one".
 */
export const BUBBLE_GRAPH_READER: ElementReader = {
  localId: (m, i) => (typeof m.userData.nodeId === 'string' ? i : null),
  category: (m) => String(m.userData.nodeType ?? ''),
  guid: (m) => (typeof m.userData.nodeId === 'string' ? m.userData.nodeId : null),
};

/**
 * The meshes a group produced, in a form the split understands.
 * Anything the reader declines is not an element — a helper, a light, a grid —
 * and has no business in a tileset keyed by element.
 */
export function collectElementMeshes(
  group: THREE.Object3D,
  reader: ElementReader = FRAGMENTS_READER,
): ElementMesh[] {
  const out: ElementMesh[] = [];
  let index = 0;
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const localId = reader.localId(m, index);
    if (localId === null) return;
    index += 1;
    out.push({
      mesh: m,
      localId,
      category: reader.category(m),
      colour: meshColour(m),
      guid: reader.guid?.(m) ?? undefined,
    });
  });
  return out;
}

/** Element meshes → the bounded items the spatial split bins. */
export function itemsFrom(
  elements: ElementMesh[],
  guidOf: (localId: number) => string | null,
): TileItem[] {
  const box = new THREE.Box3();
  const items: TileItem[] = [];
  for (const el of elements) {
    box.setFromObject(el.mesh);
    if (!isFinite(box.min.x) || box.isEmpty()) continue;
    items.push({
      id: String(el.localId),
      localId: el.localId,
      // A mesh that knows its own identity keeps it; `guidOf` is the lookup
      // for sources where identity lives in the model, not on the mesh.
      guid: el.guid ?? guidOf(el.localId),
      category: el.category,
      colour: el.colour,
      min: [box.min.x, box.min.y, box.min.z] as Vec3,
      max: [box.max.x, box.max.y, box.max.z] as Vec3,
    });
  }
  return items;
}

/**
 * A mesh's geometry where the mesh actually STANDS, not where its buffer says.
 *
 * The meshes `fragmentsToThreeGroup` makes carry their own placement baked
 * into the buffer, but their parent group carries the transform back to the
 * file's project coordinates. `itemsFrom` measures bounds through
 * `setFromObject`, which includes that parent; exporting the raw buffer did
 * not — so the bounding volumes described one place and the content sat in
 * another, and the tiles landed offset from the glTF of the same model.
 * A copy is transformed, never the mesh's own geometry.
 */
export function worldGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  mesh.updateWorldMatrix(true, false);
  return mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
}

/**
 * Concatenate geometries, stamping each one with its feature id.
 *
 * Non-indexed throughout: an index buffer would have to be rebased per part,
 * and a tile is drawn once per frame either way. Only position and normal
 * are carried — a tileset for massing and identification needs no texture
 * coordinates, and inventing them would only inflate the file.
 */
export function mergeWithFeatureIds(
  parts: Array<{ geometry: THREE.BufferGeometry; featureId: number }>,
): THREE.BufferGeometry | null {
  const flat = parts
    .map((p) => ({ g: p.geometry.index ? p.geometry.toNonIndexed() : p.geometry, id: p.featureId }))
    .filter((p) => !!p.g.getAttribute('position'));
  if (flat.length === 0) return null;

  const total = flat.reduce((n, p) => n + p.g.getAttribute('position').count, 0);
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const fid = new Float32Array(total);

  let v = 0;
  for (const { g, id } of flat) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    pos.set(p.array as Float32Array, v * 3);
    if (n && n.count === p.count) nor.set(n.array as Float32Array, v * 3);
    fid.fill(id, v, v + p.count);
    v += p.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  // Float rather than an integer type: glTF forbids unsigned int for
  // non-index accessors in the base spec, and Cesium reads float ids happily.
  out.setAttribute(FEATURE_ID_ATTRIBUTE, new THREE.BufferAttribute(fid, 1));
  return out;
}

/** The property table for one tile, in the order the feature ids index it. */
export function featureTableFor(bucket: TileBucket): FeatureTable {
  return {
    guids: bucket.items.map((i) => i.guid),
    categories: bucket.items.map((i) => i.category),
    names: bucket.items.map((i) => i.id),
    localIds: bucket.items.map((i) => i.localId),
    colours: bucket.items.map((i) => i.colour),
  };
}

export interface BuiltTileset {
  /** Blob URL of tileset.json — what Cesium3DTileset.fromUrl is given. */
  tilesetUrl: string;
  /** Every URL created, so the caller can revoke the lot on teardown. */
  urls: string[];
  tileCount: number;
  featureCount: number;
  gridSizeM: number;
  /** The document itself, handy for inspection and for writing to disk. */
  tileset: ReturnType<typeof buildTileset>;
}

export interface BuildTilesetOptions {
  /** Roughly how many tiles to aim for. More tiles stream finer, cost more requests. */
  targetTiles?: number;
  /**
   * Column-major 4×4 written into the root tile's `transform`. The World view
   * does NOT use this: it places the tileset through the primitive's own
   * `modelMatrix`, so a move or turn never rebuilds the tiles. Setting both
   * applies the placement twice.
   */
  transform?: number[];
  guidOf?: (localId: number) => string | null;
  /** How to read element identity off each mesh. Defaults to the fragments convention. */
  reader?: ElementReader;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Build a complete, self-contained tileset from a flattened fragments model.
 *
 * Returns blob URLs. The caller owns them and must revoke every entry in
 * `urls` when the tileset is discarded, or the tab leaks a copy of the model
 * for as long as it lives.
 */
export async function buildTilesetFromGroup(
  group: THREE.Object3D,
  opts: BuildTilesetOptions = {},
): Promise<BuiltTileset> {
  const elements = collectElementMeshes(group, opts.reader ?? FRAGMENTS_READER);
  if (elements.length === 0) throw new Error('Modelul nu conține elemente cu geometrie.');

  const guidOf = opts.guidOf ?? (() => null);
  const items = itemsFrom(elements, guidOf);
  if (items.length === 0) throw new Error('Niciun element cu limite valide.');

  const gridSizeM = suggestGridSize(items, opts.targetTiles ?? 24);
  const buckets = splitIntoTiles(items, gridSizeM);

  const byLocalId = new Map(elements.map((e) => [e.localId, e]));
  const urls: string[] = [];
  const uriByKey = new Map<string, string>();

  let done = 0;
  for (const bucket of buckets) {
    const scene = new THREE.Scene();

    // Merge per (category, COLOUR). Merging per category alone painted every
    // element of a category with whichever colour came first in the bucket —
    // so a brick wall and a concrete wall in the same tile came out the same,
    // and material was invisible in the very view that exists to show massing.
    // One draw call per distinct colour is the price, and it is small: a
    // building has a handful of materials, not a handful per element.
    const byGroup = new Map<string, {
      category: string;
      colour: string;
      parts: Array<{ geometry: THREE.BufferGeometry; featureId: number }>;
    }>();
    bucket.items.forEach((item, featureId) => {
      const el = byLocalId.get(item.localId);
      if (!el) return;
      // Per piece, not per item: one element can carry several colours.
      for (const part of meshParts(el.mesh)) {
        const key = `${item.category}\u0000${part.colour}`;
        const entry = byGroup.get(key) ?? { category: item.category, colour: part.colour, parts: [] };
        entry.parts.push({ geometry: part.geometry, featureId });
        byGroup.set(key, entry);
      }
    });

    for (const { colour, parts } of byGroup.values()) {
      const geo = mergeWithFeatureIds(parts);
      if (!geo) continue;
      scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: colour ? new THREE.Color(colour) : new THREE.Color(0xbfbfbf),
        roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide,
      })));
    }
    if (scene.children.length === 0) { done += 1; continue; }

    const glb = await new Promise<ArrayBuffer>((res, rej) =>
      new GLTFExporter().parse(scene, (r) => res(r as ArrayBuffer), rej, { binary: true }),
    );
    const withMeta = injectFeatureMetadata(glb, featureTableFor(bucket));
    const url = URL.createObjectURL(new Blob([withMeta], { type: 'model/gltf-binary' }));
    urls.push(url);
    uriByKey.set(bucket.key, url);

    done += 1;
    opts.onProgress?.(done, buckets.length);
  }

  // Only tiles that actually produced content may appear, or Cesium will
  // request a URI that was never created and fail the whole tileset.
  const present = buckets.filter((b) => uriByKey.has(b.key));
  const tileset = buildTileset(present, {
    gridSizeM,
    contentUri: (key) => uriByKey.get(key) ?? '',
  });
  if (opts.transform) tileset.root.transform = opts.transform;

  const tilesetUrl = URL.createObjectURL(
    new Blob([JSON.stringify(tileset)], { type: 'application/json' }),
  );
  urls.push(tilesetUrl);

  return {
    tilesetUrl,
    urls,
    tileCount: present.length,
    featureCount: items.length,
    gridSizeM,
    tileset,
  };
}
