/**
 * patterns.ts — how a face is divided. Pure: a rectangle in, cells out.
 *
 * Cells come back CCW in (a, b) = (along the face, up), inside [0, L] × [0, H].
 * Grid and stagger FIT the cell size to the face — a 10 m face asked for
 * 1.5 m cells gets seven cells of 1.43 m, never six and a sliver — because a
 * facade with one odd bay reads as a mistake, and evenly fitted bays are what
 * every real facade drawing does. Hex and Voronoi are clipped Voronoi
 * diagrams of lattice or random seeds, the dome's own machinery on a plane.
 */
import type { Pt2 } from '@/lib/geom/plan2d';
import { ensureCcw, polygonArea } from '@/lib/geom/plan2d';
import { rng, seedPoints, voronoiCells } from '@/lib/dome/voronoi';
import { polygonCentroid } from '@/lib/dome/entrance';
import type { FacadeIntent } from './types';

const rect = (x0: number, y0: number, x1: number, y1: number): Pt2[] =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

/** Evenly fitted divisions: the count that brings the size closest to what was asked. */
export function fitCount(lengthMm: number, cellMm: number): number {
  return Math.max(1, Math.round(lengthMm / Math.max(1, cellMm)));
}

export function gridCells(L: number, H: number, cw: number, ch: number): Pt2[][] {
  const nx = fitCount(L, cw), ny = fitCount(H, ch);
  const w = L / nx, h = H / ny;
  const out: Pt2[][] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    out.push(rect(i * w, j * h, (i + 1) * w, (j + 1) * h));
  }
  return out;
}

/** Brick bond: every other row shifted half a cell; the row ends are half cells. */
export function staggerCells(L: number, H: number, cw: number, ch: number): Pt2[][] {
  const nx = fitCount(L, cw), ny = fitCount(H, ch);
  const w = L / nx, h = H / ny;
  const out: Pt2[][] = [];
  for (let j = 0; j < ny; j++) {
    const shift = j % 2 === 1 ? w / 2 : 0;
    let x = 0;
    if (shift > 0) { out.push(rect(0, j * h, shift, (j + 1) * h)); x = shift; }
    while (x < L - 1e-6) {
      const x1 = Math.min(L, x + w);
      out.push(rect(x, j * h, x1, (j + 1) * h));
      x = x1;
    }
  }
  return out;
}

/** Honeycomb: a hexagonal lattice of seeds, Voronoi-clipped to the face. */
export function hexCells(L: number, H: number, cellMm: number): Pt2[][] {
  const base = rect(0, 0, L, H);
  const s = Math.max(100, cellMm);            // across-flats distance
  const dy = s * Math.sqrt(3) / 2;
  const seeds: Pt2[] = [];
  // Overshoot the face by a ring of seeds so the border cells are clipped
  // hexagons, not stretched Voronoi remainders.
  for (let j = -1; j * dy <= H + dy; j++) {
    const shift = j % 2 === 0 ? 0 : s / 2;
    for (let i = -1; i * s <= L + s; i++) seeds.push({ x: i * s + shift, y: j * dy });
  }
  return voronoiCells(base, seeds).filter((c) => c.length >= 3 && Math.abs(polygonArea(c)) > 1);
}

/** Random seeds, relaxed by 2D Lloyd so the cells even out. */
export function voronoiFaceCells(L: number, H: number, count: number, seed: number, relax: number): Pt2[][] {
  const base = rect(0, 0, L, H);
  const random = rng(seed);
  let seeds = seedPoints(base, Math.max(1, count), random);
  let cells = voronoiCells(base, seeds);
  for (let k = 0; k < relax; k++) {
    seeds = cells.map((c, i) => (c.length >= 3 ? polygonCentroid(c) : seeds[i]));
    cells = voronoiCells(base, seeds);
  }
  return cells.filter((c) => c.length >= 3 && Math.abs(polygonArea(c)) > 1).map(ensureCcw);
}

export function faceCells(L: number, H: number, intent: FacadeIntent): Pt2[][] {
  switch (intent.pattern) {
    case 'grid': return gridCells(L, H, intent.cellWMm, intent.cellHMm);
    case 'stagger': return staggerCells(L, H, intent.cellWMm, intent.cellHMm);
    case 'hex': return hexCells(L, H, intent.cellWMm);
    case 'voronoi': {
      const count = intent.cellCount > 0
        ? intent.cellCount
        : Math.max(1, Math.round((L * H) / (intent.cellWMm * intent.cellHMm)));
      return voronoiFaceCells(L, H, count, intent.seed, intent.relaxIterations);
    }
  }
}

/**
 * Offset a CCW polygon inwards by `d`, keeping the vertex count — each vertex
 * slides along its angle bisector. That is what a cassette needs: its inner
 * ring must pair vertex-for-vertex with the outer one. Returns null when the
 * offset eats the polygon (a corner crosses over), so the caller can skip the
 * bevel rather than build an inside-out box.
 */
export function offsetPolygon(poly: Pt2[], d: number): Pt2[] | null {
  const n = poly.length;
  if (n < 3) return null;
  const src = ensureCcw(poly);
  const out: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const p = src[(i - 1 + n) % n], c = src[i], q = src[(i + 1) % n];
    const e1 = { x: c.x - p.x, y: c.y - p.y }, e2 = { x: q.x - c.x, y: q.y - c.y };
    const l1 = Math.hypot(e1.x, e1.y), l2 = Math.hypot(e2.x, e2.y);
    if (l1 < 1e-9 || l2 < 1e-9) return null;
    // Inward normals of a CCW polygon: left of each edge.
    const n1 = { x: -e1.y / l1, y: e1.x / l1 }, n2 = { x: -e2.y / l2, y: e2.x / l2 };
    const bx = n1.x + n2.x, by = n1.y + n2.y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) return null;
    const cosHalf = (bx * n1.x + by * n1.y) / bl;       // cos of half the turn
    if (cosHalf < 0.2) return null;                      // too sharp to offset sanely
    const k = d / cosHalf;
    out.push({ x: c.x + (bx / bl) * k, y: c.y + (by / bl) * k });
  }
  // The offset must not have crossed over. Area cannot tell: a square offset
  // past its centre comes back as a SMALLER square, still counter-clockwise,
  // because opposite corners swapped places. What does tell is direction —
  // every edge of a sane offset runs the same way as the edge it came from.
  for (let i = 0; i < n; i++) {
    const a = src[i], b = src[(i + 1) % n], c = out[i], d = out[(i + 1) % n];
    if ((b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y) <= 0) return null;
  }
  if (Math.abs(polygonArea(out)) <= 1) return null;
  return out;
}
