/**
 * The World view draws one IFC three ways, and each way reaches the globe
 * through a different chain of transforms:
 *
 *   glTF      Cesium.Model:   modelMatrix × axisCorrection × nodeTransform × v
 *   3D Tiles  Cesium3DTileset: modelMatrix × [root.transform] × Y_UP_TO_Z_UP × v_world
 *   overlay   Three.js:       ENU basis at the anchor ← (x, −z, y) ← wrapper × toProject × v
 *
 * Nothing forces those to agree except arithmetic. This file takes one stored
 * vertex, pushes it through all three chains using Cesium's own matrices for
 * the Cesium halves and the real overlay helpers for the Three half, and
 * demands the same earth-centred point back, to the millimetre. It is the
 * proof behind "the three modes are in the same place and orientation".
 *
 * The Cesium axis correction is reproduced here from
 * `ModelUtility.getAxisCorrectionMatrix` (not exported), so the test can also
 * show WHY `GLTF_MODEL_AXES` exists: with Cesium's defaults the glTF comes
 * out a quarter turn from the other two.
 */
import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import * as THREE from 'three';
import type { WorldLocation } from '@/store';
import {
  GLTF_MODEL_AXES, insertionPoint, overlayAnchorOf, overlayOffsetOf, placementMatrix,
} from './worldPlacement';
import { overlayNodeFor, placeInOverlay } from '@/lib/ifc/overlay/fragmentsOverlay';
import { enuBasis, enuToEcef } from '@/lib/ifc/overlay/cameraSync';
import { threeBoxToLocal } from '@/lib/ifc/tiles3d/tileset';
import { worldGeometry } from '@/lib/ifc/tiles3d/fromFragments';

/** A project with every knob turned: offsets, elevation and a heading. */
const PROJECT: WorldLocation = {
  lat: 44.4268, lng: 26.1025, alt: 82.5,
  offsetE: 12.5, offsetN: -7.25, offsetZ: 3.1,
  rotation: 37, georeferenced: true,
};

/** A second model with its own placement, 300 m away and turned differently. */
const OTHER: WorldLocation = {
  lat: 44.4295, lng: 26.1040, alt: 90,
  offsetE: -4, offsetN: 2.5, offsetZ: -1,
  rotation: 211, georeferenced: true,
};

/** The file's coordination undone: a translation and a turn, as an IFC may carry. */
const TO_PROJECT = new THREE.Matrix4().makeRotationY(0.3).setPosition(0.955, 2.09, -0.055);

/** One stored vertex, off every axis so a swapped or negated one shows. */
const V = new THREE.Vector3(3.2, 1.1, -4.7);

/** Cesium's static axis matrices exist at runtime but not in its typings. */
const AXIS = Cesium.Axis as unknown as {
  Y_UP_TO_Z_UP: Cesium.Matrix4; X_UP_TO_Z_UP: Cesium.Matrix4; Z_UP_TO_X_UP: Cesium.Matrix4;
};

interface ModelAxes { upAxis: Cesium.Axis; forwardAxis: Cesium.Axis }

/** `ModelUtility.getAxisCorrectionMatrix`, verbatim in spirit. */
function axisCorrection(upAxis: Cesium.Axis, forwardAxis: Cesium.Axis): Cesium.Matrix4 {
  let m = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, new Cesium.Matrix4());
  if (upAxis === Cesium.Axis.Y) m = Cesium.Matrix4.clone(AXIS.Y_UP_TO_Z_UP, m);
  else if (upAxis === Cesium.Axis.X) m = Cesium.Matrix4.clone(AXIS.X_UP_TO_Z_UP, m);
  if (forwardAxis === Cesium.Axis.Z) m = Cesium.Matrix4.multiplyTransformation(m, AXIS.Z_UP_TO_X_UP, m);
  return m;
}

const c3 = (v: THREE.Vector3) => new Cesium.Cartesian3(v.x, v.y, v.z);
const apply = (m: Cesium.Matrix4, p: Cesium.Cartesian3) =>
  Cesium.Matrix4.multiplyByPoint(m, p, new Cesium.Cartesian3());

/** The glTF chain: the group node carries toProject; Cesium adds its correction. */
function viaGltf(L: WorldLocation, axes: ModelAxes = GLTF_MODEL_AXES): Cesium.Cartesian3 {
  const nodeSpace = V.clone().applyMatrix4(TO_PROJECT);
  const m = Cesium.Matrix4.multiply(
    placementMatrix(L), axisCorrection(axes.upAxis, axes.forwardAxis), new Cesium.Matrix4(),
  );
  return apply(m, c3(nodeSpace));
}

/** The tiles chain: geometry baked in world Three space, Y-up → Z-up, no root transform. */
function viaTiles(L: WorldLocation): Cesium.Cartesian3 {
  const group = new THREE.Group();
  group.applyMatrix4(TO_PROJECT);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry().setAttribute(
    'position', new THREE.Float32BufferAttribute([V.x, V.y, V.z], 3),
  ));
  group.add(mesh);
  const baked = worldGeometry(mesh).getAttribute('position');
  const world = new THREE.Vector3(baked.getX(0), baked.getY(0), baked.getZ(0));
  const m = Cesium.Matrix4.multiply(
    placementMatrix(L), axisCorrection(Cesium.Axis.Y, Cesium.Axis.X), new Cesium.Matrix4(),
  );
  return apply(m, c3(world));
}

/** The overlay chain: the real wrapper and placement, then the pure ENU maths. */
function viaOverlay(anchor: WorldLocation, L: WorldLocation): Cesium.Cartesian3 {
  const model = new THREE.Object3D();
  const node = overlayNodeFor(model, TO_PROJECT, 'm');
  const d = overlayOffsetOf(anchor, L);
  placeInOverlay(node, d.e, d.n, d.u, L.rotation);
  const q = model.localToWorld(V.clone());
  const a = overlayAnchorOf(anchor);
  const p = enuToEcef({ x: q.x, y: -q.z, z: q.y }, enuBasis(a.lat, a.lng, a.alt));
  return new Cesium.Cartesian3(p.x, p.y, p.z);
}

function expectSamePoint(a: Cesium.Cartesian3, b: Cesium.Cartesian3, toleranceM = 1e-3) {
  expect(Cesium.Cartesian3.distance(a, b)).toBeLessThan(toleranceM);
}

describe('the three rendering modes stand on the same spot', () => {
  it('glTF and 3D Tiles agree', () => {
    expectSamePoint(viaGltf(PROJECT), viaTiles(PROJECT));
  });

  it('glTF and the fragments overlay agree for a model linked to the project', () => {
    expectSamePoint(viaGltf(PROJECT), viaOverlay(PROJECT, PROJECT));
  });

  it('agree for a model with its own placement, anchored at another project', () => {
    expectSamePoint(viaGltf(OTHER), viaOverlay(PROJECT, OTHER));
    expectSamePoint(viaTiles(OTHER), viaOverlay(PROJECT, OTHER));
  });

  it('agree at every heading, not only the one above', () => {
    for (const rotation of [0, 90, 180, 270, 123.4]) {
      const L = { ...PROJECT, rotation };
      expectSamePoint(viaGltf(L), viaTiles(L));
      expectSamePoint(viaGltf(L), viaOverlay(L, L));
    }
  });

  it('is not vacuous: the vertex really moves with the heading', () => {
    expect(Cesium.Cartesian3.distance(viaGltf(PROJECT), viaGltf({ ...PROJECT, rotation: 0 })))
      .toBeGreaterThan(1);
  });
});

describe('and they all agree on which way is north', () => {
  const NORTH = new THREE.Vector3(0, 0, -10);  // 10 m north of the origin, in Three axes

  /** Metres east and north of the insertion point, for a chain's output. */
  function enuOf(L: WorldLocation, p: Cesium.Cartesian3): { e: number; n: number } {
    const inv = Cesium.Matrix4.inverse(
      Cesium.Transforms.eastNorthUpToFixedFrame(insertionPoint(L)), new Cesium.Matrix4(),
    );
    const d = apply(inv, p);
    return { e: d.x, n: d.y };
  }

  function northVia(L: WorldLocation) {
    const identity = new THREE.Matrix4();
    const gltf = apply(
      Cesium.Matrix4.multiply(placementMatrix(L), axisCorrection(GLTF_MODEL_AXES.upAxis, GLTF_MODEL_AXES.forwardAxis), new Cesium.Matrix4()),
      c3(NORTH),
    );
    const model = new THREE.Object3D();
    const node = overlayNodeFor(model, identity, 'm');
    placeInOverlay(node, 0, 0, 0, L.rotation);
    const q = model.localToWorld(NORTH.clone());
    const a = overlayAnchorOf(L);
    const o = enuToEcef({ x: q.x, y: -q.z, z: q.y }, enuBasis(a.lat, a.lng, a.alt));
    return { gltf: enuOf(L, gltf), overlay: enuOf(L, new Cesium.Cartesian3(o.x, o.y, o.z)) };
  }

  it('heading 0: north in the file is north on the globe', () => {
    const { gltf, overlay } = northVia({ ...PROJECT, rotation: 0 });
    expect(gltf.n).toBeCloseTo(10, 3);
    expect(gltf.e).toBeCloseTo(0, 3);
    expect(overlay.n).toBeCloseTo(10, 3);
    expect(overlay.e).toBeCloseTo(0, 3);
  });

  it('heading 90: north in the file turns to EAST on the globe, in both', () => {
    const { gltf, overlay } = northVia({ ...PROJECT, rotation: 90 });
    expect(gltf.e).toBeCloseTo(10, 3);
    expect(gltf.n).toBeCloseTo(0, 3);
    expect(overlay.e).toBeCloseTo(10, 3);
    expect(overlay.n).toBeCloseTo(0, 3);
  });

  it('the tile bounding volume uses the same Y-up → Z-up rotation as the content', () => {
    const local = threeBoxToLocal([V.x, V.y, V.z], [V.x, V.y, V.z]);
    const rotated = apply(AXIS.Y_UP_TO_Z_UP, c3(V));
    expect(local.min[0]).toBeCloseTo(rotated.x, 9);
    expect(local.min[1]).toBeCloseTo(rotated.y, 9);
    expect(local.min[2]).toBeCloseTo(rotated.z, 9);
  });
});

describe('why the glTF axes are named explicitly', () => {
  it('with Cesium\'s defaults the glTF comes out a quarter turn from the tiles', () => {
    const defaults = { upAxis: Cesium.Axis.Y, forwardAxis: Cesium.Axis.Z };
    const off = Cesium.Cartesian3.distance(viaGltf(PROJECT, defaults), viaTiles(PROJECT));
    expect(off).toBeGreaterThan(1);        // metres, for a vertex a few metres out
  });

  it('with the named axes the correction is exactly Y-up → Z-up, as for tiles', () => {
    const m = axisCorrection(GLTF_MODEL_AXES.upAxis, GLTF_MODEL_AXES.forwardAxis);
    expect(Cesium.Matrix4.equalsEpsilon(m, AXIS.Y_UP_TO_Z_UP, 1e-12)).toBe(true);
  });
});

describe('the overlay anchor is the insertion point, offsets included', () => {
  it('sits offsetE/N/Z away from the bare anchor, not on it', () => {
    const a = overlayAnchorOf(PROJECT);
    const anchorPt = Cesium.Cartesian3.fromDegrees(a.lng, a.lat, a.alt);
    expectSamePoint(anchorPt, insertionPoint(PROJECT), 1e-4);
    const bare = Cesium.Cartesian3.fromDegrees(PROJECT.lng, PROJECT.lat, PROJECT.alt);
    expect(Cesium.Cartesian3.distance(anchorPt, bare))
      .toBeCloseTo(Math.hypot(PROJECT.offsetE, PROJECT.offsetN, PROJECT.offsetZ), 3);
  });

  it('a linked model is at offset zero; another model is where it stands', () => {
    const same = overlayOffsetOf(PROJECT, PROJECT);
    expect(Math.hypot(same.e, same.n, same.u)).toBeLessThan(1e-6);
    const other = overlayOffsetOf(PROJECT, OTHER);
    expect(other.n).toBeGreaterThan(250);   // OTHER is north of PROJECT
    expect(other.u).toBeCloseTo(90 - 1 - (82.5 + 3.1), 0);
  });
});
