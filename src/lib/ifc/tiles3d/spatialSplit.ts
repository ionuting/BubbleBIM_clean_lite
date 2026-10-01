/**
 * spatialSplit.ts — cutting a building into the tiles a 3D Tiles set is made of.
 *
 * An IFC that has been flattened by `fragmentsToThreeGroup` is one Three.js
 * mesh per element, and a whole site can be tens of thousands of them. Handing
 * that to Cesium as a single glTF works exactly once — the first time, on a
 * fast machine, with a small file. 3D Tiles exists so the viewer can fetch and
 * draw only the part of the model the camera is looking at, and the price of
 * that is deciding, up front and offline, which element belongs in which tile.
 *
 * This module is that decision, and nothing else. It never touches geometry: it
 * works purely on each element's axis-aligned bounds, so it can be tested
 * without a renderer, a file or a fragments worker, and so the caller stays
 * free to compute those bounds however it likes.
 *
 * Frame
 * -----
 * Bounds arrive in the frame `fragmentsToThreeGroup` produces — Three.js,
 * metres, right-handed, **X east, Y up, Z south** (so north is −Z). The split
 * is therefore over X and Z, the horizontal plane, and Y is deliberately NOT
 * split: a storey is only a few metres tall while a site is hundreds of metres
 * wide, so splitting vertically would make tall thin tiles that the camera
 * nearly always needs all of at once. One column of tiles per plan cell,
 * full height, is the shape that actually culls.
 *
 * Buckets may overlap
 * -------------------
 * An element is assigned to a cell by the CENTRE of its bounding box, but the
 * bucket's own bounds are the union of its members' bounds — not the cell
 * rectangle. A 12 m beam whose centre sits 0.5 m inside a cell still sticks out
 * of it, and a bounding volume that clipped the beam would let Cesium cull a
 * tile whose geometry is visibly on screen. Overlapping siblings are explicitly
 * legal in 3D Tiles under `refine: "ADD"` (they are not a spatial index, just a
 * conservative bound), so honest overlapping bounds are the correct answer and
 * tight-but-wrong ones are not.
 */

/** Metres, in the Three.js frame described above. */
export type Vec3 = [number, number, number];

/** One IFC element, reduced to the only things the split cares about. */
export interface TileItem {
  /** The mesh name, `ifc:<modelId>:<localId>` — carried through to the glTF node. */
  id: string;
  localId: number;
  /** IFC GlobalId. Null when the element has none, which does happen. */
  guid: string | null;
  /** e.g. "IFCWALL". */
  category: string;
  /**
   * The element's own colour as `#rrggbb`.
   *
   * Carried through the split because it is part of the MERGE KEY: elements
   * are merged per (category, colour), so two walls of different materials
   * stay two colours instead of both taking whichever one was first.
   */
  colour: string;
  min: Vec3;
  max: Vec3;
}

/** A group of items that will be exported as one tile content file. */
export interface TileBucket {
  /** `<col>_<row>` — stable, filename-safe, and the only key the tileset uses. */
  key: string;
  col: number;
  row: number;
  items: TileItem[];
  /** Union of the members' bounds, NOT the grid cell. See the module note. */
  min: Vec3;
  max: Vec3;
}

/** A grid finer than this makes more requests than it saves triangles. */
export const MIN_GRID_M = 5;
/** Coarser than this and a "tile" is the whole model again. */
export const MAX_GRID_M = 500;

/**
 * Divisor turning a tile's diagonal into its geometric error.
 *
 * 3D Tiles reads geometric error as "metres of error introduced by NOT drawing
 * this tile", which a runtime projects to pixels and compares against its
 * maximum screen-space error (16 by default in Cesium). There is no true value
 * here because our tiles carry a single level of detail: the number is purely
 * the knob that decides how close the camera must be before a tile loads.
 * A sixteenth of the diagonal puts a 30 m tile at ~1.9 m of error, which loads
 * it at roughly a few hundred metres out — near enough that a walk-through
 * never sees a hole, far enough that an overview of a site does not fetch
 * everything at once.
 */
export const ERROR_DIVISOR = 16;

function finite(n: number): boolean {
  return Number.isFinite(n);
}

/**
 * The cell a coordinate falls in.
 *
 * `Math.floor` is what makes a point sitting exactly on a boundary land in
 * exactly one cell — the upper one — rather than in both or neither. That is
 * worth stating because "shared" elements are the classic way a tiled export
 * ends up drawing the same wall twice.
 */
function cellIndex(coord: number, gridSizeM: number): number {
  return Math.floor(coord / gridSizeM);
}

/** Guard a caller-supplied grid size; a zero or NaN size would make every
 *  cell index infinite and collapse the model into one nonsense bucket. */
function safeGrid(gridSizeM: number): number {
  return finite(gridSizeM) && gridSizeM > 0 ? gridSizeM : MIN_GRID_M;
}

/**
 * Every item's bounds, unioned. Null for an empty list — there is no such thing
 * as the bounding box of nothing, and returning a zero box at the origin would
 * quietly place an empty tileset in the Atlantic.
 */
export function overallBounds(items: TileItem[]): { min: Vec3; max: Vec3 } | null {
  if (items.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const it of items) {
    for (let a = 0; a < 3; a++) {
      if (it.min[a] < min[a]) min[a] = it.min[a];
      if (it.max[a] > max[a]) max[a] = it.max[a];
    }
  }
  return { min, max };
}

/**
 * Items → buckets, one per occupied grid cell of the X/Z plane.
 *
 * Empty cells are not returned at all: a building is rarely a rectangle, and a
 * tileset whose children are mostly empty boxes costs the runtime a traversal
 * per frame for nothing.
 *
 * The result is sorted by column then row so that two runs over the same input
 * produce byte-identical tileset.json — which is what makes an export
 * cacheable and a diff readable.
 */
export function splitIntoTiles(items: TileItem[], gridSizeM: number): TileBucket[] {
  const grid = safeGrid(gridSizeM);
  const byKey = new Map<string, TileBucket>();

  for (const it of items) {
    // The centre, not a corner: a corner would move an element between cells
    // depending on which way it happens to be modelled.
    const cx = (it.min[0] + it.max[0]) / 2;
    const cz = (it.min[2] + it.max[2]) / 2;
    // Degenerate bounds (a NaN slipping out of an empty geometry) would land in
    // cell NaN and poison the key; park them in the origin cell instead of
    // dropping the element, because a missing wall is harder to notice than a
    // misplaced one.
    const col = finite(cx) ? cellIndex(cx, grid) : 0;
    const row = finite(cz) ? cellIndex(cz, grid) : 0;
    const key = `${col}_${row}`;

    const bucket = byKey.get(key);
    if (!bucket) {
      byKey.set(key, {
        key, col, row,
        items: [it],
        min: [it.min[0], it.min[1], it.min[2]],
        max: [it.max[0], it.max[1], it.max[2]],
      });
      continue;
    }
    bucket.items.push(it);
    for (let a = 0; a < 3; a++) {
      if (it.min[a] < bucket.min[a]) bucket.min[a] = it.min[a];
      if (it.max[a] > bucket.max[a]) bucket.max[a] = it.max[a];
    }
  }

  return [...byKey.values()].sort((a, b) => (a.col - b.col) || (a.row - b.row));
}

/** A tile's geometric error: its diagonal over `ERROR_DIVISOR`. See that
 *  constant for why a made-up number is the honest answer here. */
export function geometricErrorFor(bucket: TileBucket): number {
  const dx = bucket.max[0] - bucket.min[0];
  const dy = bucket.max[1] - bucket.min[1];
  const dz = bucket.max[2] - bucket.min[2];
  const diagonal = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return finite(diagonal) ? diagonal / ERROR_DIVISOR : 0;
}

/**
 * A grid size that would split these items into roughly `targetTiles` tiles.
 *
 * The estimate is the crude one on purpose — spread the footprint area evenly
 * over the target count and take the square root — because the real count
 * depends on how the building fills its own bounding rectangle, which is not
 * knowable without doing the split. Callers that care can split, count, and
 * call again; most do not, and an L-shaped block landing on 40 tiles instead
 * of 50 changes nothing anyone can see.
 *
 * Always returns a finite number in [MIN_GRID_M, MAX_GRID_M]: this value feeds
 * a division, so a 0 or a NaN escaping here would take the whole export with it.
 */
export function suggestGridSize(items: TileItem[], targetTiles: number): number {
  const bounds = overallBounds(items);
  if (!bounds) return MIN_GRID_M;

  const width = bounds.max[0] - bounds.min[0];
  const depth = bounds.max[2] - bounds.min[2];
  const target = finite(targetTiles) && targetTiles >= 1 ? Math.floor(targetTiles) : 1;

  const area = width * depth;
  // A model that is flat in one horizontal direction (a single row of items, or
  // one item) has zero area, so fall back to the longer side split `target`
  // ways; if even that is zero there is nothing to split and the minimum wins.
  const raw = area > 0
    ? Math.sqrt(area / target)
    : Math.max(width, depth) / target;

  if (!finite(raw) || raw <= 0) return MIN_GRID_M;
  return Math.min(MAX_GRID_M, Math.max(MIN_GRID_M, raw));
}
