/**
 * worldPlacement.ts — where a model stands on the globe, for every renderer.
 *
 * The World view draws an imported IFC three different ways — a Cesium Model
 * baked from glTF, a 3D Tiles tileset, and a Three.js overlay — and each gets
 * to the globe through a different chain of transforms. They can only agree
 * if they all start from the same two facts, and this module is where those
 * facts live:
 *
 *   • the INSERTION POINT: anchor lat/lng/alt plus the east/north/up offsets,
 *     the one point on Earth the model's origin is pinned to;
 *   • the PLACEMENT: an east-north-up frame at that point, turned by the
 *     heading. Heading is clockwise from north, as `WorldLocation` stores it.
 *
 * `worldPlacement.test.ts` runs one vertex through all three chains with
 * Cesium's own matrices and demands the same ECEF point back. If you change
 * anything here, or in how any of the three renderers is fed, that test is
 * the proof that the other two still stand on the same spot.
 */

import * as Cesium from 'cesium';
import type { WorldLocation } from '@/store';

/** Anchor lat/lng/alt, then the ENU offsets, all in metres. */
export function insertionPoint(L: WorldLocation): Cesium.Cartesian3 {
  const basePos = Cesium.Cartesian3.fromDegrees(L.lng, L.lat, L.alt);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(basePos);
  return Cesium.Matrix4.multiplyByPoint(
    enu, new Cesium.Cartesian3(L.offsetE, L.offsetN, L.offsetZ), new Cesium.Cartesian3(),
  );
}

/**
 * Model matrix for content whose local frame is east/north/up at the
 * insertion point, turned by the heading. Cesium's heading is a rotation
 * from north increasing towards east, which is the convention `rotation`
 * follows and the one `placeInOverlay` reproduces on the Three side.
 */
export function placementMatrix(L: WorldLocation): Cesium.Matrix4 {
  return Cesium.Transforms.headingPitchRollToFixedFrame(
    insertionPoint(L), new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(L.rotation), 0, 0),
  );
}

/**
 * How Cesium must read the glTF we bake — and this is load-bearing.
 *
 * Our glTF is Y-up with north on −Z, straight out of Three. Cesium's `Model`
 * assumes glTF's own convention of "+Z is forward" and, by default, adds a
 * quarter turn about the vertical so that forward becomes its own +X (east).
 * `Cesium3DTileset` does NOT do that: tile content is read with X forward.
 * Left at the defaults, the same file therefore came out turned 90° in the
 * glTF mode and not in the other two. Naming the axes explicitly makes the
 * glTF path apply the one rotation the tileset applies — Y-up to Z-up — and
 * nothing else.
 */
export const GLTF_MODEL_AXES = {
  upAxis: Cesium.Axis.Y,
  forwardAxis: Cesium.Axis.X,
} as const;

/**
 * The overlay scene's origin: the project's insertion point, as lat/lng/alt.
 *
 * Not the bare anchor. A model linked to the project sits at offset zero from
 * the scene origin, so if the origin were the anchor the project's own
 * east/north/up offsets would silently vanish from the overlay — which is
 * exactly how the fragments layer ended up at the wrong height while the
 * glTF, placed through `placementMatrix`, stood at the right one.
 */
export function overlayAnchorOf(L: WorldLocation): { lat: number; lng: number; alt: number } {
  const carto = Cesium.Cartographic.fromCartesian(insertionPoint(L));
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lng: Cesium.Math.toDegrees(carto.longitude),
    alt: carto.height,
  };
}

/**
 * Where model `L`'s insertion point sits relative to `anchor`'s, in metres
 * east, north and up of the anchor's frame. Zero when the two coincide,
 * which is the linked-model case.
 */
export function overlayOffsetOf(anchor: WorldLocation, L: WorldLocation): { e: number; n: number; u: number } {
  const origin = insertionPoint(anchor);
  const inv = Cesium.Matrix4.inverse(
    Cesium.Transforms.eastNorthUpToFixedFrame(origin), new Cesium.Matrix4(),
  );
  const d = Cesium.Matrix4.multiplyByPoint(inv, insertionPoint(L), new Cesium.Cartesian3());
  return { e: d.x, n: d.y, u: d.z };
}
