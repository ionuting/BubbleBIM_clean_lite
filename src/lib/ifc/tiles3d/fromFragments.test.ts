/**
 * The exporter and the blob URLs need a browser, so they are not tested here.
 * Everything that decides WHAT goes into a tile is, because that is where a
 * mistake shows up as an element in the wrong tile or a pick returning the
 * wrong GlobalId — both invisible until someone clicks the wrong wall.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  collectElementMeshes, featureTableFor, gltfAttributeName, itemsFrom,
  mergeWithFeatureIds, worldGeometry, FEATURE_ID_ATTRIBUTE, GLTF_FEATURE_ID_ATTRIBUTE,
  BUBBLE_GRAPH_READER,
} from './fromFragments';
import { splitIntoTiles } from './spatialSplit';

/** A 1 m cube standing at (x, 0, z), tagged the way fragmentsToThreeGroup tags. */
function element(localId: number, category: string, x: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x334455 }),
  );
  mesh.position.set(x, 0, z);
  mesh.updateMatrixWorld(true);
  mesh.userData.ifcLocalId = localId;
  mesh.userData.ifcCategory = category;
  return mesh;
}

function group(...meshes: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  meshes.forEach((m) => g.add(m));
  g.updateMatrixWorld(true);
  return g;
}

describe('collectElementMeshes', () => {
  it('takes the tagged meshes and leaves everything else alone', () => {
    const g = group(
      element(1, 'IFCWALL', 0, 0),
      new THREE.AmbientLight(),               // not a mesh
      new THREE.Mesh(new THREE.BoxGeometry()), // a mesh, but not an element
      element(2, 'IFCSLAB', 10, 0),
    );
    const found = collectElementMeshes(g);
    expect(found.map((e) => e.localId)).toEqual([1, 2]);
    expect(found.map((e) => e.category)).toEqual(['IFCWALL', 'IFCSLAB']);
  });

  it('finds elements nested under other objects', () => {
    const inner = group(element(7, 'IFCBEAM', 0, 0));
    expect(collectElementMeshes(group(inner)).map((e) => e.localId)).toEqual([7]);
  });

  it('returns nothing for an empty scene rather than throwing', () => {
    expect(collectElementMeshes(new THREE.Group())).toEqual([]);
  });
});

describe('itemsFrom', () => {
  it('measures each element where it actually stands, not at its own origin', () => {
    const g = group(element(1, 'IFCWALL', 30, -12));
    const [item] = itemsFrom(collectElementMeshes(g), () => null);
    expect(item.min[0]).toBeCloseTo(29.5, 5);
    expect(item.max[0]).toBeCloseTo(30.5, 5);
    expect(item.min[2]).toBeCloseTo(-12.5, 5);
  });

  it('carries the GlobalId through, because that is what a pick must return', () => {
    const g = group(element(4, 'IFCWALL', 0, 0));
    const [item] = itemsFrom(collectElementMeshes(g), (id) => `GUID-${id}`);
    expect(item.guid).toBe('GUID-4');
    expect(item.localId).toBe(4);
  });

  it('survives an element with no geometry to measure', () => {
    const empty = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    empty.userData.ifcLocalId = 9;
    empty.userData.ifcCategory = 'IFCWALL';
    expect(itemsFrom(collectElementMeshes(group(empty)), () => null)).toEqual([]);
  });
});

describe('mergeWithFeatureIds', () => {
  const box = () => new THREE.BoxGeometry(1, 1, 1);

  it('stamps every vertex of a part with that part\'s id', () => {
    const merged = mergeWithFeatureIds([
      { geometry: box(), featureId: 0 },
      { geometry: box(), featureId: 1 },
    ])!;
    const fid = merged.getAttribute(FEATURE_ID_ATTRIBUTE);
    const pos = merged.getAttribute('position');
    expect(fid.count).toBe(pos.count);

    const ids = new Set<number>();
    for (let i = 0; i < fid.count; i++) ids.add(fid.getX(i));
    expect([...ids].sort()).toEqual([0, 1]);
    // Each id covers exactly half the vertices — one cube each.
    let zeros = 0;
    for (let i = 0; i < fid.count; i++) if (fid.getX(i) === 0) zeros += 1;
    expect(zeros).toBe(fid.count / 2);
  });

  it('keeps the ids contiguous, so a run maps to one element', () => {
    const merged = mergeWithFeatureIds([
      { geometry: box(), featureId: 5 },
      { geometry: box(), featureId: 6 },
    ])!;
    const fid = merged.getAttribute(FEATURE_ID_ATTRIBUTE);
    const first = fid.getX(0);
    let i = 0;
    while (i < fid.count && fid.getX(i) === first) i += 1;
    // Everything after the switch is the second id, never back to the first.
    for (let j = i; j < fid.count; j++) expect(fid.getX(j)).not.toBe(first);
  });

  it('carries normals so the tile is not flat-shaded black', () => {
    const merged = mergeWithFeatureIds([{ geometry: box(), featureId: 0 }])!;
    const n = merged.getAttribute('normal');
    expect(n.count).toBe(merged.getAttribute('position').count);
    let nonZero = 0;
    for (let i = 0; i < n.count; i++) if (Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) > 0.5) nonZero += 1;
    expect(nonZero).toBe(n.count);
  });

  it('un-indexes so the parts can simply be concatenated', () => {
    expect(mergeWithFeatureIds([{ geometry: box(), featureId: 0 }])!.index).toBeNull();
  });

  it('has nothing to merge when given nothing', () => {
    expect(mergeWithFeatureIds([])).toBeNull();
    expect(mergeWithFeatureIds([{ geometry: new THREE.BufferGeometry(), featureId: 0 }])).toBeNull();
  });
});

describe('featureTableFor', () => {
  it('lines the table up with the ids the merge stamped', () => {
    const items = itemsFrom(
      collectElementMeshes(group(element(1, 'IFCWALL', 0, 0), element(2, 'IFCSLAB', 2, 0))),
      (id) => `G${id}`,
    );
    const [bucket] = splitIntoTiles(items, 100);   // one big cell: both inside
    const table = featureTableFor(bucket);
    expect(table.guids).toEqual(bucket.items.map((i) => i.guid));
    expect(table.localIds).toEqual(bucket.items.map((i) => i.localId));
    expect(table.categories).toHaveLength(bucket.items.length);
    // Feature id N must address row N — the merge relies on exactly this.
    bucket.items.forEach((item, n) => {
      expect(table.localIds[n]).toBe(item.localId);
      expect(table.guids[n]).toBe(item.guid);
    });
  });

  it('is empty for an empty bucket rather than undefined', () => {
    expect(featureTableFor({ key: 'x', col: 0, row: 0, items: [], min: [0, 0, 0], max: [0, 0, 0] }))
      .toEqual({ guids: [], categories: [], names: [], localIds: [], colours: [] });
  });
});

describe('the feature id attribute survives the exporter', () => {
  // This pair broke the whole 3D Tiles mode once. Three's exporter uppercases
  // an unrecognised attribute and then prefixes it with an underscore, so a
  // name that already began with one came out as `__FEATURE_ID_0`. GLSL
  // reserves consecutive underscores, Cesium's generated shader refused to
  // compile, and rendering stopped altogether.
  it('turns the Three name into exactly the name glTF and Cesium expect', () => {
    expect(gltfAttributeName(FEATURE_ID_ATTRIBUTE)).toBe(GLTF_FEATURE_ID_ATTRIBUTE);
  });

  it('never produces two consecutive underscores', () => {
    expect(gltfAttributeName(FEATURE_ID_ATTRIBUTE)).not.toContain('__');
    // The mistake that caused it, pinned so nobody reintroduces the leading _.
    expect(gltfAttributeName('_feature_id_0')).toBe('__FEATURE_ID_0');
    expect(FEATURE_ID_ATTRIBUTE.startsWith('_')).toBe(false);
  });

  it('leaves the names glTF already reserves alone', () => {
    expect(gltfAttributeName('position')).toBe('POSITION');
    expect(gltfAttributeName('normal')).toBe('NORMAL');
    expect(gltfAttributeName('uv')).toBe('_UV');
  });

  it('is the name the merge actually writes', () => {
    const merged = mergeWithFeatureIds([
      { geometry: new THREE.BoxGeometry(1, 1, 1), featureId: 0 },
    ])!;
    expect(merged.getAttribute(FEATURE_ID_ATTRIBUTE)).toBeDefined();
  });
});

describe('worldGeometry', () => {
  // The parent group carries the file's coordination (see
  // `modelToProjectMatrix`); the raw buffer does not. Exporting the raw buffer
  // put the tiles' content somewhere other than their bounding volumes — and
  // somewhere other than the glTF of the same model.
  it('bakes the parent transform into a copy', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const g = new THREE.Group();
    g.add(mesh);
    g.position.set(100, 0, 0);

    const baked = new THREE.Box3().setFromBufferAttribute(
      worldGeometry(mesh).getAttribute('position') as THREE.BufferAttribute,
    );
    expect(baked.min.x).toBeCloseTo(99.5, 6);
    expect(baked.max.x).toBeCloseTo(100.5, 6);

    const own = new THREE.Box3().setFromBufferAttribute(
      mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
    );
    expect(own.min.x).toBeCloseTo(-0.5, 6);   // the mesh's own buffer untouched
  });

  it('lands exactly on the bounds the split bins by', () => {
    const el = element(1, 'IFCWALL', 30, -12);
    const g = new THREE.Group();
    g.add(el);
    g.position.set(5, 0, 0);
    g.updateMatrixWorld(true);
    const [item] = itemsFrom(collectElementMeshes(g), () => null);
    const baked = new THREE.Box3().setFromBufferAttribute(
      worldGeometry(el).getAttribute('position') as THREE.BufferAttribute,
    );
    expect(baked.min.x).toBeCloseTo(item.min[0], 5);
    expect(baked.max.z).toBeCloseTo(item.max[2], 5);
  });
});

// ── Per-element colour and identity ─────────────────────────────────────────
// The tileset exists to show a building as it is. Before this, elements were
// merged per category and the whole category took whichever colour happened to
// come first in the tile — a brick wall and a concrete wall came out identical.

/** A cube with a chosen colour, tagged the fragments way. */
function coloured(localId: number, category: string, colour: number, x: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: colour }),
  );
  mesh.position.set(x, 0, 0);
  mesh.updateMatrixWorld(true);
  mesh.userData.ifcLocalId = localId;
  mesh.userData.ifcCategory = category;
  return mesh;
}

/** A cube tagged the way the bubble graph's own Three scene tags. */
function bubbleMesh(nodeId: string, nodeType: string, colour: number, x: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: colour }),
  );
  mesh.position.set(x, 0, 0);
  mesh.updateMatrixWorld(true);
  mesh.userData.nodeId = nodeId;
  mesh.userData.nodeType = nodeType;
  return mesh;
}

describe('per-element colour', () => {
  it('reads each mesh\'s own colour as #rrggbb', () => {
    const els = collectElementMeshes(group(coloured(1, 'IFCWALL', 0xc8b18c, 0)));
    expect(els[0].colour).toBe('#c8b18c');
  });

  it('two walls of different materials keep two colours', () => {
    const els = collectElementMeshes(group(
      coloured(1, 'IFCWALL', 0xc8b18c, 0),
      coloured(2, 'IFCWALL', 0x9aa0a6, 2),
    ));
    expect(els.map((e) => e.colour)).toEqual(['#c8b18c', '#9aa0a6']);

    // Same category, different colour: the merge key must separate them, or
    // the second wall is painted with the first one's material.
    const items = itemsFrom(els, () => null);
    expect(new Set(items.map((i) => `${i.category}|${i.colour}`)).size).toBe(2);
  });

  it('carries the colour into the property table a styling expression reads', () => {
    const els = collectElementMeshes(group(
      coloured(1, 'IFCWALL', 0xc8b18c, 0),
      coloured(2, 'IFCSLAB', 0x9aa0a6, 2),
    ));
    const [bucket] = splitIntoTiles(itemsFrom(els, () => null), 1000);
    expect(featureTableFor(bucket).colours).toEqual(['#c8b18c', '#9aa0a6']);
  });

  it('a mesh with no material colour yields an empty string, not a wrong one', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.material = new THREE.MeshBasicMaterial();
    (mesh.material as { color?: THREE.Color }).color = undefined;
    mesh.userData.ifcLocalId = 7;
    mesh.userData.ifcCategory = 'IFCWALL';
    mesh.updateMatrixWorld(true);
    expect(collectElementMeshes(group(mesh))[0].colour).toBe('');
  });
});

describe('reading the bubble graph\'s own scene', () => {
  it('takes nodeId as identity and nodeType as category', () => {
    const els = collectElementMeshes(
      group(bubbleMesh('wall_17', 'wall', 0xc8b18c, 0), bubbleMesh('slab_3', 'slab', 0x9aa0a6, 2)),
      BUBBLE_GRAPH_READER,
    );
    expect(els.map((e) => e.category)).toEqual(['wall', 'slab']);
    expect(els.map((e) => e.guid)).toEqual(['wall_17', 'slab_3']);
  });

  it('the node id reaches the property table, so a pick names the bubble node', () => {
    const els = collectElementMeshes(
      group(bubbleMesh('wall_17', 'wall', 0xc8b18c, 0)),
      BUBBLE_GRAPH_READER,
    );
    // `guidOf` returns null throughout: the mesh's own identity must win.
    const [bucket] = splitIntoTiles(itemsFrom(els, () => null), 1000);
    expect(featureTableFor(bucket).guids).toEqual(['wall_17']);
  });

  it('skips meshes that are not graph elements — grids, helpers, ground', () => {
    const helper = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    helper.updateMatrixWorld(true);
    expect(collectElementMeshes(group(helper, bubbleMesh('wall_1', 'wall', 0xffffff, 0)),
      BUBBLE_GRAPH_READER)).toHaveLength(1);
  });

  it('the fragments reader is still the default, and ignores bubble meshes', () => {
    expect(collectElementMeshes(group(bubbleMesh('wall_1', 'wall', 0xffffff, 0)))).toHaveLength(0);
  });
});

describe('meshParts', () => {
  it('splits a mesh with several materials into one world-space piece per group, each with its colour', async () => {
    const { meshParts } = await import('./fromFragments');
    const geo = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
    geo.clearGroups();
    geo.addGroup(0, 12, 0);
    geo.addGroup(12, 24, 1);
    const mesh = new THREE.Mesh(geo, [
      new THREE.MeshStandardMaterial({ color: 0xff0000 }),
      new THREE.MeshStandardMaterial({ color: 0x0000ff }),
    ]);
    mesh.position.set(10, 0, 0);
    const parts = meshParts(mesh);
    expect(parts.map((p) => [p.colour, p.geometry.getAttribute('position').count])).toEqual([['#ff0000', 12], ['#0000ff', 24]]);
    parts[0].geometry.computeBoundingBox();
    expect(parts[0].geometry.boundingBox!.min.x).toBeGreaterThanOrEqual(9);
  });

  it('leaves a single-material mesh whole', async () => {
    const { meshParts } = await import('./fromFragments');
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x00ff00 }));
    const parts = meshParts(mesh);
    expect(parts).toHaveLength(1);
    expect(parts[0].colour).toBe('#00ff00');
  });
});
