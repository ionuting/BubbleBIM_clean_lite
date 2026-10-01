/**
 * An IFC as a source, against a stub of the two fragments calls it makes:
 * the spatial tree and the item data. The tree is the one every IFC has —
 * project, site, building, storeys, elements — and the item data is shaped
 * the way fragments shapes it, `{ value }` wrappers and `_`-prefixed
 * bookkeeping included, so `normalizeItemData` is exercised for real.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ItemData, SpatialTreeItem } from '@thatopen/fragments';
import { elevationsToMm, elementFromIfc, ifcSource, mapStoreys, type IfcSourceModel } from './standaloneSources';
import { normalizeItemData } from '@/lib/ifc/ifcFragments';

const v = (value: unknown) => ({ value });

const tree: SpatialTreeItem = {
  category: 'IFCPROJECT', localId: 1, children: [{
    category: 'IFCSITE', localId: 2, children: [{
      category: 'IFCBUILDING', localId: 3, children: [
        { category: 'IFCBUILDINGSTOREY', localId: 10, children: [
          { category: 'IFCWALL', localId: 100, children: [{ category: 'IFCOPENINGELEMENT', localId: 150 }] },
          { category: 'IFCWALL', localId: 101 },
        ] },
        { category: 'IFCBUILDINGSTOREY', localId: 11, children: [
          { category: 'IFCSLAB', localId: 200 },
        ] },
      ],
    }],
  }],
};

const items: Record<number, ItemData> = {
  10: { _category: v('IFCBUILDINGSTOREY'), Name: v('Parter'), Elevation: v(0) } as unknown as ItemData,
  11: { _category: v('IFCBUILDINGSTOREY'), Name: v('Etaj 1'), Elevation: v(3) } as unknown as ItemData,
  100: {
    _category: v('IFCWALL'), _guid: v('2O2Fr$t4X7Zf8NOew3FLOH'), Name: v('Perete P1'), Tag: v('W-01'),
    IsDefinedBy: [{
      _category: v('IFCPROPERTYSET'), Name: v('Pset_WallCommon'),
      HasProperties: [
        { Name: v('IsExternal'), NominalValue: v(true) },
        { Name: v('FireRating'), NominalValue: v('REI 60') },
      ],
    }, {
      _category: v('IFCELEMENTQUANTITY'), Name: v('Qto_WallBaseQuantities'),
      Quantities: [{ Name: v('NetVolume'), VolumeValue: v(1.25) }],
    }],
    IsTypedBy: [{ _category: v('IFCWALLTYPE'), Name: v('Zidărie 25') }],
    HasAssociations: [{ _category: v('IFCMATERIAL'), Name: v('Cărămidă') }],
  } as unknown as ItemData,
  101: { _category: v('IFCWALL'), _guid: v('g101'), Name: v('Perete P2') } as unknown as ItemData,
  200: { _category: v('IFCSLAB'), _guid: v('g200'), Name: v('Placă E1') } as unknown as ItemData,
};

const model: IfcSourceModel = {
  modelId: 'm1',
  getSpatialStructure: async () => tree,
  getItemsData: async (ids) => ids.map((id) => items[id]),
};

/** Three boxes, the way `fragmentsToThreeGroup` leaves them, 6 m tall in all. */
function flattening(): THREE.Group {
  const g = new THREE.Group();
  const box = (localId: number, cat: string, y: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.25), new THREE.MeshStandardMaterial());
    m.position.y = y;
    m.name = `ifc:m1:${localId}`;
    m.userData = { ifcLocalId: localId, ifcCategory: cat };
    g.add(m);
  };
  box(100, 'IFCWALL', 1.5);
  box(101, 'IFCWALL', 1.5);
  box(200, 'IFCSLAB', 4.5);
  return g;
}

describe('mapStoreys', () => {
  it('assigns every node under a storey to it, at any depth', () => {
    const { storeyIds, byItem } = mapStoreys(tree);
    expect(storeyIds).toEqual([10, 11]);
    expect(byItem.get(100)).toBe(10);
    expect(byItem.get(150)).toBe(10);   // the opening inside the wall
    expect(byItem.get(200)).toBe(11);
    expect(byItem.has(3)).toBe(false);  // the building is above the storeys
  });

  it('reads the tree the way fragments actually writes it: category, then instances', () => {
    // Copied from a real ArchiCAD file: every level is either a category
    // node with no id or an instance node with no category.
    const real: SpatialTreeItem = {
      category: 'IFCPROJECT', localId: null, children: [{
        category: null, localId: 1, children: [{
          category: 'IFCSITE', localId: null, children: [{
            category: null, localId: 27, children: [{
              category: 'IFCBUILDING', localId: null, children: [{
                category: null, localId: 30, children: [{
                  category: 'IFCBUILDINGSTOREY', localId: null, children: [
                    { category: null, localId: 89955, children: [
                      { category: 'IFCWALL', localId: null, children: [
                        { category: null, localId: 500 },
                        { category: null, localId: 501, children: [
                          { category: 'IFCOPENINGELEMENT', localId: null, children: [{ category: null, localId: 502 }] },
                        ] },
                      ] },
                    ] },
                    { category: null, localId: 89958, children: [
                      { category: 'IFCSLAB', localId: null, children: [{ category: null, localId: 600 }] },
                    ] },
                  ],
                }],
              }],
            }],
          }],
        }],
      }],
    };
    const { storeyIds, byItem } = mapStoreys(real);
    expect(storeyIds).toEqual([89955, 89958]);
    expect(byItem.get(500)).toBe(89955);
    expect(byItem.get(501)).toBe(89955);
    expect(byItem.get(502)).toBe(89955);
    expect(byItem.get(600)).toBe(89958);
    expect(byItem.has(30)).toBe(false);
    expect(byItem.has(27)).toBe(false);
  });
});

describe('elevationsToMm', () => {
  it('reads metres when the span matches the model height that way', () => {
    expect(elevationsToMm([0, 3, 6], 9)).toEqual([0, 3000, 6000]);
  });
  it('reads millimetres when that is what matches', () => {
    expect(elevationsToMm([0, 3000, 6000], 9)).toEqual([0, 3000, 6000]);
  });
  it('decides a lone value by its size', () => {
    expect(elevationsToMm([2.8], 3)).toEqual([2800]);
    expect(elevationsToMm([2800], 3)).toEqual([2800]);
    expect(elevationsToMm([0], 3)).toEqual([0]);
  });
  it('gives a storey without an elevation zero', () => {
    expect(elevationsToMm([null, 3], 6)).toEqual([0, 3000]);
  });
});

describe('elementFromIfc', () => {
  it('lays the element out the way the panel lists it: own attributes, then sets', () => {
    const e = elementFromIfc(normalizeItemData('m1', 100, items[100]), 'ifc:m1:10', 'src');
    expect(e.name).toBe('Perete P1');
    expect(e.type).toBe('IFCWALL');
    expect(e.storeyId).toBe('ifc:m1:10');
    expect(e.source).toBe('src');
    expect(e.props).toMatchObject({ GlobalId: '2O2Fr$t4X7Zf8NOew3FLOH', Tag: 'W-01', Tip: 'Zidărie 25', Materiale: 'Cărămidă' });
    expect(e.groups).toEqual([
      { name: 'Pset_WallCommon', props: { IsExternal: true, FireRating: 'REI 60' } },
      { name: 'Qto_WallBaseQuantities · cantități', props: { NetVolume: 1.25 } },
    ]);
  });

  it('leaves out what it cannot show — nulls, empty strings, empty sets', () => {
    const e = elementFromIfc(normalizeItemData('m1', 101, items[101]), undefined, 'src');
    expect(e.storeyId).toBeUndefined();
    expect(e.groups).toBeUndefined();
    expect(Object.values(e.props).every((x) => x !== null && x !== '')).toBe(true);
  });
});

describe('ifcSource', () => {
  it('builds the source: storeys from the tree, elements with their sets, ids on a copy of the meshes', async () => {
    const original = flattening();
    const src = await ifcSource(model, original, { id: 'ifc-1', name: 'Casa' });

    expect(src.info).toEqual({ id: 'ifc-1', name: 'Casa', kind: 'ifc', elements: 3 });
    expect(src.storeys).toEqual([
      { id: 'ifc:m1:10', name: 'Parter', bottomMm: 0, topMm: 3000 },
      { id: 'ifc:m1:11', name: 'Etaj 1', bottomMm: 3000, topMm: 6000 },
    ]);
    expect(Object.keys(src.elements).sort()).toEqual(['ifc:m1:100', 'ifc:m1:101', 'ifc:m1:200']);
    expect(src.elements['ifc:m1:100'].groups?.[0].name).toBe('Pset_WallCommon');
    expect(src.elements['ifc:m1:200'].storeyId).toBe('ifc:m1:11');

    // The meshes the exporter will bake carry exactly what the viewer reads.
    const ud: Record<string, unknown>[] = [];
    src.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) ud.push(o.userData); });
    expect(ud).toEqual([
      { nodeId: 'ifc:m1:100', nodeType: 'IFCWALL', storeyId: 'ifc:m1:10', source: 'ifc-1' },
      { nodeId: 'ifc:m1:101', nodeType: 'IFCWALL', storeyId: 'ifc:m1:10', source: 'ifc-1' },
      { nodeId: 'ifc:m1:200', nodeType: 'IFCSLAB', storeyId: 'ifc:m1:11', source: 'ifc-1' },
    ]);

    // And the World view's own group is exactly as it was.
    expect(src.group).not.toBe(original);
    expect(original.children.map((c) => c.userData)).toEqual([
      { ifcLocalId: 100, ifcCategory: 'IFCWALL' },
      { ifcLocalId: 101, ifcCategory: 'IFCWALL' },
      { ifcLocalId: 200, ifcCategory: 'IFCSLAB' },
    ]);
    expect(src.dispose).toBeUndefined();
  });

  it('still exports when the model has no spatial structure to offer', async () => {
    const bare: IfcSourceModel = {
      ...model,
      getSpatialStructure: async () => { throw new Error('no tree'); },
    };
    const src = await ifcSource(bare, flattening(), { id: 'x', name: 'x' });
    expect(src.storeys).toEqual([]);
    expect(src.elements['ifc:m1:100'].storeyId).toBeUndefined();
    expect(src.elements['ifc:m1:100'].name).toBe('Perete P1');
  });
});
