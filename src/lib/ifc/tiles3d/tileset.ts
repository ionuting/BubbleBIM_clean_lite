/**
 * tileset.ts — the tileset.json that ties the exported tiles together.
 *
 * A 3D Tiles set is a tree of bounding volumes with content hung off it. Ours
 * is deliberately the shallowest tree that is still a tileset: one root, one
 * child per bucket, every child carrying a GLB. No level-of-detail pyramid —
 * an IFC model is authored at one level of detail and there is nothing honest
 * to decimate it into without a mesh simplifier. `refine: "ADD"` says exactly
 * that: children ADD geometry to the parent rather than replacing a coarser
 * version of it, which is the correct refinement for a set where the parent
 * draws nothing.
 *
 * ── The coordinate frame, which is the part that goes wrong ──────────────────
 *
 * Two different conventions meet in a tileset and it is worth being blunt about
 * which is which:
 *
 *   • glTF content is **Y-up**. Our GLBs come out of Three's `GLTFExporter`, so
 *     they are in the frame `fragmentsToThreeGroup` produced: X east, Y up,
 *     Z south (north is −Z), metres.
 *
 *   • Tile **bounding volumes** are expressed in the tile's own coordinate
 *     system, which 3D Tiles defines as **Z-up**. A runtime loading glTF
 *     content into a tile applies an implicit Y-up → Z-up rotation to that
 *     content first.
 *
 * So the bounding volumes must describe where the geometry lands AFTER that
 * implicit rotation, not where it sits in the GLB. The rotation is +90° about
 * X, which sends a glTF point (x, y, z) to (x, −z, y). Writing the box in
 * unrotated Three coordinates is the single most common way to get a tileset
 * that loads, reports no error, and draws nothing: Cesium culls every tile
 * because the volumes it was given are lying about where the content is.
 *
 * With that rotation applied our local frame reads as **east / north / up**:
 * local x = east = three.x; local y = north = −three.z; local z = up = three.y.
 * That is precisely the frame an ENU matrix expects, which is why the viewer
 * can place the whole tileset with `Transforms.eastNorthUpToFixedFrame` at the
 * model's origin and set it as the root `transform`. Supplying that matrix is
 * the integrator's job; this module only guarantees the local frame it assumes.
 *
 * Note the axis flip is a NEGATION, so the minimum and maximum swap on that
 * axis — `threeBoxToLocal` handles it, and doing it by hand is the second most
 * common way to get an inside-out box.
 */

import {
  geometricErrorFor, type TileBucket, type Vec3,
} from './spatialSplit';

// ── The 3D Tiles 1.1 document, as much of it as we emit ──────────────────────

/** The 12-number `box` form: centre, then three half-axis vectors. */
export interface BoundingVolumeBox {
  box: number[];
}

export interface TileContent {
  uri: string;
}

export interface Tile3D {
  boundingVolume: BoundingVolumeBox;
  geometricError: number;
  refine?: 'ADD' | 'REPLACE';
  content?: TileContent;
  children?: Tile3D[];
  /**
   * Column-major 4×4 placing this tile's frame on the globe. `buildTileset`
   * never sets it: the split knows the model's shape but nothing about where
   * on Earth it stands. The World view leaves it unset too and places the
   * whole tileset through the primitive's `modelMatrix` — the same
   * east-north-up matrix every other representation of the model is placed
   * with — so a move never rebuilds the tiles. Cesium composes the two, so
   * setting both would apply the placement twice.
   */
  transform?: number[];
}

export interface Tileset3D {
  asset: { version: '1.1' };
  geometricError: number;
  root: Tile3D;
}

export interface TilesetOptions {
  /** The grid the buckets were split on, metres. Recorded so a consumer can
   *  reason about tile size without re-deriving it from the bounds. */
  gridSizeM: number;
  /** Bucket key → the content URI for that tile, relative to tileset.json. */
  contentUri: (key: string) => string;
}

/**
 * Root error, as a multiple of the largest child's.
 *
 * The root must be strictly coarser than every child or a runtime has no
 * reason ever to descend into the tree: it compares the root's error against
 * its screen-space budget and, if the root already passes, stops there — and
 * since the root has no content, "stops there" means an empty screen. Double
 * is the smallest factor that is unambiguously larger while keeping the root
 * from loading absurdly early.
 */
export const ROOT_ERROR_FACTOR = 2;

/**
 * An axis-aligned box as the 12 numbers 3D Tiles wants:
 * `[cx, cy, cz, hx, 0, 0, 0, hy, 0, 0, 0, hz]`.
 *
 * The three vectors after the centre are half-AXES, not a size: they are the
 * columns of an arbitrary orientation matrix, which is how the format supports
 * oriented boxes. Ours are axis-aligned, so each vector has one non-zero
 * component and the other two are exactly zero.
 *
 * Inputs are taken in whichever frame the caller is already working in; run
 * them through `threeBoxToLocal` first if they came from Three.js.
 */
export function boxVolume(min: Vec3, max: Vec3): number[] {
  const c = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const h = [
    (max[0] - min[0]) / 2,
    (max[1] - min[1]) / 2,
    (max[2] - min[2]) / 2,
  ];
  return [
    c[0], c[1], c[2],
    h[0], 0, 0,
    0, h[1], 0,
    0, 0, h[2],
  ];
}

/**
 * Three (X east, Y up, Z south) → tileset-local (X east, Y north, Z up).
 *
 * See the module docstring: this is the implicit glTF Y-up → Z-up rotation the
 * runtime will apply to the content, applied here to the bounds so the two
 * agree. Because local y = −three.z, the box's minimum and maximum trade
 * places on that axis.
 */
export function threeBoxToLocal(min: Vec3, max: Vec3): { min: Vec3; max: Vec3 } {
  return {
    min: [min[0], negate(max[2]), min[1]],
    max: [max[0], negate(min[2]), max[1]],
  };
}

/** Negation that never yields −0. The value serialises identically either way,
 *  but a −0 in a bounding box reads as a bug to everyone who meets it. */
function negate(v: number): number {
  return v === 0 ? 0 : -v;
}

/** The union of every bucket's bounds, in the Three frame. Null when there are
 *  no buckets, which the root handles as a degenerate box. */
function unionOfBuckets(buckets: TileBucket[]): { min: Vec3; max: Vec3 } | null {
  if (buckets.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of buckets) {
    for (let a = 0; a < 3; a++) {
      if (b.min[a] < min[a]) min[a] = b.min[a];
      if (b.max[a] > max[a]) max[a] = b.max[a];
    }
  }
  return { min, max };
}

/**
 * Buckets → the tileset document.
 *
 * Child order follows the bucket order, which `splitIntoTiles` already made
 * deterministic, so re-exporting an unchanged model yields an unchanged file.
 *
 * An empty list is a legitimate outcome — an IFC with no geometry, or one
 * filtered down to nothing — and yields a structurally valid tileset with no
 * children and a zero-sized box at the origin rather than a throw. The viewer
 * shows an empty model; it does not fail to load one.
 */
export function buildTileset(buckets: TileBucket[], opts: TilesetOptions): Tileset3D {
  const children: Tile3D[] = buckets.map((bucket) => {
    const local = threeBoxToLocal(bucket.min, bucket.max);
    return {
      boundingVolume: { box: boxVolume(local.min, local.max) },
      geometricError: geometricErrorFor(bucket),
      content: { uri: opts.contentUri(bucket.key) },
    };
  });

  const overall = unionOfBuckets(buckets);
  const rootLocal = overall
    ? threeBoxToLocal(overall.min, overall.max)
    : { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };

  const maxChildError = children.reduce((m, c) => Math.max(m, c.geometricError), 0);
  // The grid size is a floor on the root error as well as the children's: a
  // model made of one small tile would otherwise get a root error near zero and
  // load at any distance, which defeats the point of tiling it at all.
  const rootError = Math.max(
    maxChildError * ROOT_ERROR_FACTOR,
    Number.isFinite(opts.gridSizeM) && opts.gridSizeM > 0 ? opts.gridSizeM : 0,
  );

  return {
    asset: { version: '1.1' },
    geometricError: rootError,
    root: {
      boundingVolume: { box: boxVolume(rootLocal.min, rootLocal.max) },
      geometricError: rootError,
      refine: 'ADD',
      children,
    },
  };
}
