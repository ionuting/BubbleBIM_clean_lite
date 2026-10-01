import { describe, expect, it } from 'vitest';
import type { ItemData } from '@thatopen/fragments';
import * as THREE from 'three';
import {
  definitionColour, fragmentsToThreeGroup, isIdentity, itemNodeName, meshDataToGeometry, modelToProjectMatrix,
  normalizeItemData, parseItemNodeName, pickedNodeName,
} from './ifcFragments';

/** The slice of fragments' MeshData these tests construct by hand. */
type ItemDataGeometry = Parameters<typeof meshDataToGeometry>[0];

const a = (value: unknown, type?: string) => ({ value, ...(type ? { type } : {}) });

/** The shape fragments returns for a wall with a pset, a quantity set, a type and a material. */
const WALL: ItemData = {
  _category: a('IFCWALL'),
  _guid: a('2O2Fr$t4X7Zf8NOew3FLKr'),
  _localId: a(42),
  Name: a('Perete exterior P1'),
  Tag: a('W-01'),
  ObjectType: a('Zidarie 25'),
  Description: a(null),
  IsDefinedBy: [
    {
      _category: a('IFCPROPERTYSET'),
      Name: a('Pset_WallCommon'),
      HasProperties: [
        { _category: a('IFCPROPERTYSINGLEVALUE'), Name: a('IsExternal'), NominalValue: a(true, 'IfcBoolean') },
        { _category: a('IFCPROPERTYSINGLEVALUE'), Name: a('FireRating'), NominalValue: a('REI 120', 'IfcLabel') },
        { _category: a('IFCPROPERTYSINGLEVALUE'), Name: a('LoadBearing'), NominalValue: a(false) },
      ],
    },
    {
      _category: a('IFCELEMENTQUANTITY'),
      Name: a('Qto_WallBaseQuantities'),
      Quantities: [
        { _category: a('IFCQUANTITYLENGTH'), Name: a('Length'), LengthValue: a(5.2) },
        { _category: a('IFCQUANTITYAREA'), Name: a('NetSideArea'), AreaValue: a(13.6) },
        { _category: a('IFCQUANTITYVOLUME'), Name: a('NetVolume'), VolumeValue: a(3.4) },
      ],
    },
  ],
  IsTypedBy: [
    { _category: a('IFCWALLTYPE'), Name: a('WT-Zidarie-25'), PredefinedType: a('SOLIDWALL') },
  ],
  HasAssociations: [
    {
      _category: a('IFCMATERIALLAYERSET'),
      MaterialLayers: [
        { _category: a('IFCMATERIALLAYER'), LayerThickness: a(0.25), Material: [{ _category: a('IFCMATERIAL'), Name: a('Caramida') }] },
        { _category: a('IFCMATERIALLAYER'), LayerThickness: a(0.02), Material: [{ _category: a('IFCMATERIAL'), Name: a('Tencuiala') }] },
      ],
    },
  ],
};

describe('normalizeItemData', () => {
  const w = normalizeItemData('casa', 42, WALL);

  it('reads identity off the bookkeeping attributes without showing them as properties', () => {
    expect(w.category).toBe('IFCWALL');
    expect(w.guid).toBe('2O2Fr$t4X7Zf8NOew3FLKr');
    expect(w.name).toBe('Perete exterior P1');
    expect(w.modelId).toBe('casa');
    expect(w.localId).toBe(42);
    expect(Object.keys(w.attributes)).not.toContain('_category');
    expect(Object.keys(w.attributes)).not.toContain('_guid');
  });

  it('keeps the direct scalar attributes, nulls included', () => {
    expect(w.attributes).toEqual({
      Name: 'Perete exterior P1', Tag: 'W-01', ObjectType: 'Zidarie 25', Description: null,
    });
  });

  it('flattens a property set to name → value and keeps booleans as booleans', () => {
    const pset = w.psets.find((p) => p.name === 'Pset_WallCommon')!;
    expect(pset.kind).toBe('pset');
    expect(pset.props).toEqual({ IsExternal: true, FireRating: 'REI 120', LoadBearing: false });
  });

  it('tells a quantity set apart and reads the *Value it carries', () => {
    const qto = w.psets.find((p) => p.name === 'Qto_WallBaseQuantities')!;
    expect(qto.kind).toBe('qto');
    expect(qto.props).toEqual({ Length: 5.2, NetSideArea: 13.6, NetVolume: 3.4 });
  });

  it('names the type and lists the materials through a layer set', () => {
    expect(w.typeName).toBe('WT-Zidarie-25');
    expect(w.materials).toEqual(['Caramida', 'Tencuiala']);
  });

  it('survives an element with nothing but a category', () => {
    const bare = normalizeItemData('m', 1, { _category: a('IFCBUILDINGELEMENTPROXY') });
    expect(bare.category).toBe('IFCBUILDINGELEMENTPROXY');
    expect(bare.name).toBeNull();
    expect(bare.psets).toEqual([]);
    expect(bare.materials).toEqual([]);
    expect(bare.typeName).toBeNull();
  });

  it('joins enumerated values instead of printing [object Object]', () => {
    const d: ItemData = {
      _category: a('IFCDOOR'),
      IsDefinedBy: [{
        _category: a('IFCPROPERTYSET'), Name: a('Pset_X'),
        HasProperties: [{ _category: a('IFCPROPERTYENUMERATEDVALUE'), Name: a('Op'), EnumerationValues: a([a('LEFT'), a('RIGHT')]) }],
      }],
    };
    expect(normalizeItemData('m', 2, d).psets[0].props.Op).toBe('LEFT, RIGHT');
  });

  it('ignores relations it does not understand rather than dumping them', () => {
    const d: ItemData = {
      _category: a('IFCWALL'),
      ContainedInStructure: [{ _category: a('IFCBUILDINGSTOREY'), Name: a('Parter') }],
    };
    const r = normalizeItemData('m', 3, d);
    expect(r.psets).toEqual([]);
    expect(r.attributes).toEqual({});
  });
});

describe('node names', () => {
  it('round-trips, including a model id that contains a colon', () => {
    const n = itemNodeName('site:casa v2', 77);
    expect(parseItemNodeName(n)).toEqual({ modelId: 'site:casa v2', localId: 77 });
  });

  it('rejects names that are not ours', () => {
    expect(parseItemNodeName('Node_wall_abc')).toBeNull();
    expect(parseItemNodeName('ifc:')).toBeNull();
    expect(parseItemNodeName('ifc:m:notanumber')).toBeNull();
    expect(parseItemNodeName(undefined)).toBeNull();
  });
});

describe('pickedNodeName', () => {
  it('reads the glTF node off a Cesium pick, wherever the release put it', () => {
    expect(pickedNodeName({ primitive: {}, detail: { node: { name: 'ifc:m:5' } } })).toBe('ifc:m:5');
    expect(pickedNodeName({ primitive: {}, node: { name: 'ifc:m:6' } })).toBe('ifc:m:6');
    expect(pickedNodeName({ primitive: {}, id: 'ifc:m:7' })).toBe('ifc:m:7');
  });

  it('is null for empty space or a pick with no node', () => {
    expect(pickedNodeName(undefined)).toBeNull();
    expect(pickedNodeName({ primitive: {} })).toBeNull();
  });
});

describe('meshDataToGeometry owns its buffers', () => {
  // At full level of detail fragments hands back the position buffer BY
  // REFERENCE out of a pool it reuses, and items that share a representation
  // get the SAME array. Transforming it in place corrupted every later read:
  // identical elements collapsed onto one another and others drifted off.
  const unitTriangle = () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

  it('never writes the transform back into the buffer it was given', () => {
    const positions = unitTriangle();
    const before = Array.from(positions);
    const md = {
      positions,
      indices: new Uint16Array([0, 1, 2]),
      transform: new THREE.Matrix4().makeTranslation(100, 200, 300),
    } as unknown as ItemDataGeometry;

    const geo = meshDataToGeometry(md)!;
    expect(Array.from(positions)).toEqual(before);          // source untouched
    expect(geo.getAttribute('position').getX(0)).toBeCloseTo(100, 6);   // copy moved
  });

  it('gives two items sharing one buffer their own places', () => {
    // The exact shape of the bug: one array, two samples, two transforms.
    const shared = unitTriangle();
    const at = (x: number) => meshDataToGeometry({
      positions: shared,
      indices: new Uint16Array([0, 1, 2]),
      transform: new THREE.Matrix4().makeTranslation(x, 0, 0),
    } as unknown as ItemDataGeometry)!;

    const a = at(10);
    const b = at(20);
    expect(a.getAttribute('position').getX(0)).toBeCloseTo(10, 6);
    expect(b.getAttribute('position').getX(0)).toBeCloseTo(20, 6);
  });

  it('declines a mesh with nothing in it rather than making an empty one', () => {
    expect(meshDataToGeometry({ positions: new Float32Array([0, 0, 0]), transform: new THREE.Matrix4() } as unknown as ItemDataGeometry)).toBeNull();
    expect(meshDataToGeometry({ transform: new THREE.Matrix4() } as unknown as ItemDataGeometry)).toBeNull();
  });
});

describe('definitionColour', () => {
  // A material definition crosses a worker boundary, where structured cloning
  // keeps the fields and drops the prototype. The typed `THREE.Color` arrives
  // as a plain `{r, g, b}`, and calling a Color method on it threw — taking
  // the whole IFC import down.
  it('reads a plain object that only looks like a Color', () => {
    const c = definitionColour({ color: { r: 1, g: 0.5, b: 0 } } as never)!;
    expect(c).toBeInstanceOf(THREE.Color);
    expect(c.r).toBeCloseTo(1, 6);
    expect(c.g).toBeCloseTo(0.5, 6);
    expect(c.b).toBeCloseTo(0, 6);
  });

  it('accepts a real Color too, since inside the library it is one', () => {
    const c = definitionColour({ color: new THREE.Color(0.2, 0.4, 0.6) } as never)!;
    expect(c.g).toBeCloseTo(0.4, 6);
  });

  it('says nothing rather than producing black for a definition it cannot read', () => {
    expect(definitionColour(undefined)).toBeNull();
    expect(definitionColour({} as never)).toBeNull();
    expect(definitionColour({ color: {} } as never)).toBeNull();
    expect(definitionColour({ color: { r: 'x', g: 0, b: 0 } } as never)).toBeNull();
    expect(definitionColour({ color: { r: NaN, g: 0, b: 0 } } as never)).toBeNull();
  });

  it('clamps a channel that came back out of range', () => {
    const c = definitionColour({ color: { r: 2, g: -1, b: 0.5 } } as never)!;
    expect(c.r).toBe(1);
    expect(c.g).toBe(0);
  });
});

describe('modelToProjectMatrix', () => {
  // The numbers are measured, not invented: the library door
  // D-SLD-90x210_IFC.ifc loaded through web-ifc with and without
  // COORDINATE_TO_ORIGIN. Its first placement sits at (0.505, 1.0725, −0.05)
  // in the file, at (−0.45, −1.0175, 0.005) once coordinated, and the
  // coordination matrix carries exactly the difference — so it is the matrix
  // that was APPLIED, and the way back is its inverse.
  const inFile = new THREE.Vector3(0.505, 1.0725, -0.05);
  const stored = new THREE.Vector3(-0.45, -1.0175, 0.005);
  const coordination = new THREE.Matrix4().makeTranslation(-0.955, -2.09, 0.055);
  const stub = (m: THREE.Matrix4 | null) => ({ getCoordinationMatrix: async () => m });

  it('takes a stored point back to where the file puts it', async () => {
    const back = await modelToProjectMatrix(stub(coordination));
    const p = stored.clone().applyMatrix4(back);
    expect(p.x).toBeCloseTo(inFile.x, 6);
    expect(p.y).toBeCloseTo(inFile.y, 6);
    expect(p.z).toBeCloseTo(inFile.z, 6);
  });

  it('is the INVERSE of the coordination, not the coordination itself', async () => {
    // Applying the coordination as-is — the natural-looking mistake — lands a
    // second offset away from the file, on the wrong side of the stored point.
    const wrong = stored.clone().applyMatrix4(coordination);
    expect(wrong.x).toBeCloseTo(-1.405, 6);
    const back = await modelToProjectMatrix(stub(coordination));
    expect(back.clone().multiply(coordination).elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9)).toBe(true);
  });

  it('undoes a rotated coordination too, not only a translation', async () => {
    const coord = new THREE.Matrix4().makeRotationY(0.7).setPosition(3, -2, 1);
    const back = await modelToProjectMatrix(stub(coord));
    const p = new THREE.Vector3(1, 2, 3);
    const roundTrip = p.clone().applyMatrix4(coord).applyMatrix4(back);
    expect(roundTrip.distanceTo(p)).toBeLessThan(1e-9);
  });

  it('is identity when the model carries no coordination, or refuses to say', async () => {
    expect(isIdentity(await modelToProjectMatrix(stub(null)))).toBe(true);
    expect(isIdentity(await modelToProjectMatrix(stub(new THREE.Matrix4())))).toBe(true);
    expect(isIdentity(await modelToProjectMatrix({ getCoordinationMatrix: async () => { throw new Error('no'); } }))).toBe(true);
  });
});

describe('fragmentsToThreeGroup colours each body by its own sample', () => {
  // A window: a frame body and a glass body, each sample naming its material.
  const box = new THREE.BoxGeometry(1, 1, 0.1);
  const body = (sampleId: number) => ({
    transform: new THREE.Matrix4(),
    positions: box.getAttribute('position').array as Float32Array,
    indices: box.getIndex()!.array as Uint16Array,
    sampleId,
  });
  const model = (samples: boolean) => ({
    modelId: 'm',
    getItemsIdsWithGeometry: async () => [7, 8],
    getItemsGeometry: async () => [[body(1), body(2)], [body(3)]],
    getItemsWithGeometryCategories: async () => ['IFCWINDOW', 'IFCWALL'],
    getCoordinationMatrix: async () => new THREE.Matrix4(),
    getSamples: async () => {
      if (!samples) throw new Error('no samples');
      return new Map([[1, { material: 10 }], [2, { material: 11 }], [3, { material: 10 }]]);
    },
    getMaterials: async () => new Map([
      [10, { r: 255, g: 0, b: 0, a: 255, renderedFaces: 0 }],
      [11, { r: 0, g: 127, b: 191, a: 25, renderedFaces: 1 }],
    ]),
  });

  it('one mesh per element, one geometry group and material per distinct material', async () => {
    const group = await fragmentsToThreeGroup(model(true) as never);
    const [win, wall] = group.children as THREE.Mesh[];
    expect(win.name).toBe('ifc:m:7');
    const mats = win.material as THREE.MeshStandardMaterial[];
    expect(mats).toHaveLength(2);
    expect(win.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    expect(mats[0].color.getHexString()).toBe('ff0000');
    expect(mats[0].transparent).toBe(false);
    expect(mats[1].transparent).toBe(true);
    expect(mats[1].opacity).toBeCloseTo(25 / 255, 5);
    expect(mats[1].side).toBe(THREE.DoubleSide);
    // Same material, same object: the wall shares the frame's.
    expect(wall.material).toBe(mats[0]);
  });

  it('falls back to the category palette when the model cannot say', async () => {
    const group = await fragmentsToThreeGroup(model(false) as never);
    const [win, wall] = group.children as THREE.Mesh[];
    expect(Array.isArray(win.material)).toBe(false);
    expect((win.material as THREE.MeshStandardMaterial).transparent).toBe(true);
    expect((wall.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xd9d4c7);
  });
});
