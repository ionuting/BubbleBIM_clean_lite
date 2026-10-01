/**
 * heightGrid.ts — the ground as a grid of heights, and the operations on it.
 *
 * Lifted out of the Terrain tab so that everything else can read the same
 * ground the tab draws: a section wants the profile under the building, the
 * quantities want the cut and fill, the globe wants the mesh. All of them
 * call into here; none of them needs Babylon or React.
 *
 * ## The grid
 *
 * `(subdivisions + 1)²` heights in metres, row-major, row = north index,
 * column = east index, over a square `sizeM` across centred on the origin.
 * The row/column of a world point is `((w / sizeM) + 0.5) · subdivisions`.
 *
 * ## Zones
 *
 * An excavation is applied in two passes, as the tab always did: first the
 * FLOOR of each zone is fixed — a flat plane at the entry height minus the
 * depth, or at an absolute elevation when the zone carries one — then every
 * vertex inside the zone is pulled down to it, with a sloped rim blending
 * the original ground into the floor over `depth / tan(slope)` metres.
 * Cutting is `min`, so cutting to the same floor twice changes nothing;
 * an embankment is `+depth`, which is NOT idempotent, and that is why baked
 * heights must never have the modeller's zones re-applied on top of them.
 */
import type { ExcavationZone, TerrainModel } from './types';

// ─── Noise ───────────────────────────────────────────────────────────────────

function hash2(ix: number, iy: number, seed: number): number {
  const n = Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.3) * 43758.5453;
  return n - Math.floor(n);
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = smoothstep(fx), sy = smoothstep(fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractional Brownian motion over value noise — the tab's procedural relief. */
export function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let val = 0, amp = 0.5, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    val += valueNoise(x * freq, y * freq, seed + i * 17) * amp;
    max += amp; amp *= 0.5; freq *= 2;
  }
  return val / max;
}

// ─── Plan helpers, on [x, z] tuples ──────────────────────────────────────────

export function pointInZone(px: number, pz: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]; const [xj, zj] = poly[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function distToZoneEdge(px: number, pz: number, poly: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j]; const [bx, bz] = poly[i];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
    const d = Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
    if (d < best) best = d;
  }
  return best;
}

// ─── The grid ────────────────────────────────────────────────────────────────

export interface GridSpec { sizeM: number; subdivisions: number }

export const gridCount = (g: GridSpec) => g.subdivisions + 1;

/** World metres of a grid column / row. */
export const gridToWorld = (g: GridSpec, col: number, row: number) => ({
  x: (col / g.subdivisions - 0.5) * g.sizeM,
  z: (row / g.subdivisions - 0.5) * g.sizeM,
});

/** Fractional grid coordinates of a world point. */
export const worldToGrid = (g: GridSpec, wx: number, wz: number) => ({
  col: ((wx / g.sizeM) + 0.5) * g.subdivisions,
  row: ((wz / g.sizeM) + 0.5) * g.subdivisions,
});

/** The untouched ground: a plane at zero, or the procedural relief. */
export function baseHeights(model: TerrainModel): Float32Array {
  const count = gridCount(model);
  const h = new Float32Array(count * count);
  if (model.flat) return h;
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      h[row * count + col] = fbm(col / model.subdivisions * 4, row / model.subdivisions * 4, model.seed) * model.maxHeightM;
    }
  }
  return h;
}

/** Apply zones to a grid. Returns a new array; `base` is not touched. */
export function applyZones(
  base: Float32Array,
  grid: GridSpec,
  zones: ExcavationZone[],
): Float32Array {
  const heights = new Float32Array(base);
  if (zones.length === 0) return heights;
  const count = gridCount(grid);

  // Per zone: the entry height (ground at the polygon's own vertices), the
  // floor, and the rim's slope. The cut is then a FIXED surface — a batter
  // plane descending from the entry height at the edge, clamped at the floor
  // — and every vertex takes the lower of itself and that surface. A fixed
  // surface is what makes cutting twice the same as cutting once; the old
  // blend against each vertex's own current height was not, and so could not
  // be applied over ground that had already been cut.
  const params = zones.map((zone) => {
    if (zone.type === 'embankment') return { floorY: 0, entryH: 0, rimSlope: 0 };
    let sum = 0;
    for (const [px, pz] of zone.polygon) {
      const { col, row } = worldToGrid(grid, px, pz);
      const c = Math.max(0, Math.min(count - 1, Math.round(col)));
      const r = Math.max(0, Math.min(count - 1, Math.round(row)));
      sum += base[r * count + c];
    }
    const entryH = sum / Math.max(1, zone.polygon.length);
    const floorY = zone.floorM !== undefined ? zone.floorM : entryH - zone.depth;
    const rimSlope = zone.slope > 0 ? Math.tan((zone.slope * Math.PI) / 180) : 0;
    return { floorY, entryH, rimSlope };
  });

  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      const { x: wx, z: wz } = gridToWorld(grid, col, row);
      const i = row * count + col;
      let h = base[i];
      for (let zi = 0; zi < zones.length; zi++) {
        const zone = zones[zi];
        if (zone.polygon.length < 3 || !pointInZone(wx, wz, zone.polygon)) continue;
        if (zone.type === 'embankment') { h = h + zone.depth; continue; }
        const { floorY, entryH, rimSlope } = params[zi];
        // `cut` lowers, `fill` raises, `both` does whichever the ground needs.
        // The surfaces are FIXED (they depend on the zone, not on `h`), which
        // is what keeps applying a zone twice the same as applying it once.
        const mode = zone.mode ?? 'cut';
        if (rimSlope <= 0) {
          if (mode !== 'fill') h = Math.min(h, floorY);
          if (mode !== 'cut') h = Math.max(h, floorY);
          continue;
        }
        const dist = distToZoneEdge(wx, wz, zone.polygon);
        if (mode !== 'fill') h = Math.min(h, Math.max(floorY, entryH - dist * rimSlope));
        if (mode !== 'cut') h = Math.max(h, Math.min(floorY, entryH + dist * rimSlope));
      }
      heights[i] = h;
    }
  }
  return heights;
}

/**
 * The ground the model describes: hand-edited heights when there are any,
 * otherwise the base with the modeller's zones applied.
 */
export function modelHeights(model: TerrainModel): Float32Array {
  const count = gridCount(model);
  const baked = model.bakedHeights;
  if (baked && baked.length === count * count) return Float32Array.from(baked);
  return applyZones(baseHeights(model), model, model.excavations);
}

/**
 * Height at a world point, bilinear between the four surrounding vertices.
 * Outside the grid the edge value is used — `null` is the caller's decision
 * (`insideGrid`), because a rock at the boundary still wants a height.
 */
export function sampleHeight(heights: Float32Array, grid: GridSpec, wx: number, wz: number): number {
  const count = gridCount(grid);
  const { col, row } = worldToGrid(grid, wx, wz);
  const c0 = Math.max(0, Math.min(count - 1, Math.floor(col)));
  const r0 = Math.max(0, Math.min(count - 1, Math.floor(row)));
  const c1 = Math.min(count - 1, c0 + 1), r1 = Math.min(count - 1, r0 + 1);
  const fc = Math.max(0, Math.min(1, col - c0)), fr = Math.max(0, Math.min(1, row - r0));
  const h00 = heights[r0 * count + c0], h01 = heights[r0 * count + c1];
  const h10 = heights[r1 * count + c0], h11 = heights[r1 * count + c1];
  return (h00 * (1 - fc) + h01 * fc) * (1 - fr) + (h10 * (1 - fc) + h11 * fc) * fr;
}

export function insideGrid(grid: GridSpec, wx: number, wz: number): boolean {
  const half = grid.sizeM / 2;
  return wx >= -half && wx <= half && wz >= -half && wz <= half;
}

/**
 * Earthworks between two grids, cubic metres: what was taken away and what
 * was added, summed cell by cell at the cell's mean height difference.
 */
export function earthworks(
  before: Float32Array,
  after: Float32Array,
  grid: GridSpec,
): { cutM3: number; fillM3: number } {
  const count = gridCount(grid);
  const cell = (grid.sizeM / grid.subdivisions) ** 2;
  let cut = 0, fill = 0;
  for (let row = 0; row < grid.subdivisions; row++) {
    for (let col = 0; col < grid.subdivisions; col++) {
      const i0 = row * count + col, i1 = i0 + 1, i2 = i0 + count, i3 = i2 + 1;
      const d = ((before[i0] - after[i0]) + (before[i1] - after[i1])
        + (before[i2] - after[i2]) + (before[i3] - after[i3])) / 4;
      if (d > 0) cut += d * cell; else fill -= d * cell;
    }
  }
  return { cutM3: cut, fillM3: fill };
}
