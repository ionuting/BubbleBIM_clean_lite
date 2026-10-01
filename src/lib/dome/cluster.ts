/**
 * cluster.ts — what happens where two bubbles meet.
 *
 * ## The whole idea, in one line
 *
 * The outer shell of overlapping domes is `max(z₁, z₂, …)`, and everything
 * else follows from that.
 *
 * Because every dome here is a HEIGHT FIELD over its base — not a free 3D
 * mesh — the boolean union that would normally need a CSG engine is a
 * pointwise maximum. No triangle intersection, no coplanar-face degeneracies,
 * no mesh repair: the solid under `max` is exactly the union of the solids
 * under each surface, and the common volume is gone because `max` never
 * returns the lower of two surfaces.
 *
 * ## Who owns what
 *
 * A cluster is not drawn once by a designated owner. Each dome renders the
 * region it WINS:
 *
 *     Rᵢ = { p ∈ baseᵢ : zᵢ(p) ≥ z_j(p) for every other j covering p }
 *
 * The Rᵢ tile the union exactly, so nothing is drawn twice and nothing is
 * missing — and each dome node keeps its own identity, selection, material
 * and quantities, which a single merged blob would have thrown away.
 *
 * Rᵢ's boundary is part base edge, part crease. The crease half is the SEAM:
 * the curve where two surfaces cross, which is where a real bubble cluster
 * grows its rim. Cells clipped to Rᵢ end on it, so the ribs land there on
 * their own — the frame is not drawn in, it is what the tessellation does at
 * a boundary. A seam is shared by two domes, so only one of them emits its
 * ribs; the other would put a second bar in the same place.
 *
 * ## The cost
 *
 * Rᵢ comes from `contourRegion`, so its outline is accurate to a grid cell
 * rather than exact. A dome that overlaps nothing never takes this path and
 * keeps its exact polygon base.
 */
import { pointInPolygon, polygonArea, type Pt2 } from '@/lib/geom/plan2d';
import { buildMembrane, type Membrane } from './membrane';
import { contourRegion, significantRings, simplifyRing, splitRings } from './contour';

/** One surface taking part in a cluster. */
export interface DomeShell {
  /** The node that owns this surface — a dome, or a dome's entrance. */
  ownerId: string;
  base: Pt2[];
  membrane: Membrane;
  /** Absolute elevation of the base, mm. */
  baseZMm: number;
  /**
   * An extra constraint on the region, positive where the shell is allowed to
   * exist. An entrance uses it to stop at its mouth; a plain dome has none.
   * It restricts the REGION, not the surface: the membrane is still solved
   * over the whole base, so the cut edge shows a true section rather than a
   * pinned-to-zero edge.
   */
  extraField?: (p: Pt2) => number;
}

export interface ShellBox { minX: number; minY: number; maxX: number; maxY: number }

export function shellBox(base: Pt2[]): ShellBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of base) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function boxesOverlap(a: ShellBox, b: ShellBox, tolMm = 0): boolean {
  return a.minX - tolMm <= b.maxX && b.minX - tolMm <= a.maxX
    && a.minY - tolMm <= b.maxY && b.minY - tolMm <= a.maxY;
}

/**
 * The absolute height of a shell's surface at a plan point, or `null` when
 * the point is outside its base — outside, a shell has no opinion, which is
 * different from having a height of zero.
 */
export function shellHeight(shell: DomeShell, p: Pt2): number | null {
  if (!pointInPolygon(p, shell.base, 0)) return null;
  // Past its own cut, a shell is absent — it must not win the `max` there,
  // or a tunnel would keep claiming surface beyond its open mouth.
  if (shell.extraField && shell.extraField(p) <= 0) return null;
  return shell.baseZMm + shell.membrane.sample(p).z;
}

/**
 * Do two shells actually intersect — not just their bounding boxes?
 *
 * Bases that merely touch are not an overlap worth contouring: the shells
 * meet at a line of zero width and each keeps its own base. What counts is a
 * region where both are defined AND the loser is meaningfully below the
 * winner, which is sampled on a coarse grid over the shared box.
 */
export function shellsIntersect(a: DomeShell, b: DomeShell, minDepthMm = 1): boolean {
  const ba = shellBox(a.base), bb = shellBox(b.base);
  if (!boxesOverlap(ba, bb)) return false;
  const minX = Math.max(ba.minX, bb.minX), maxX = Math.min(ba.maxX, bb.maxX);
  const minY = Math.max(ba.minY, bb.minY), maxY = Math.min(ba.maxY, bb.maxY);
  const step = Math.max(1, Math.min(maxX - minX, maxY - minY) / 12);
  for (let x = minX; x <= maxX; x += step) {
    for (let y = minY; y <= maxY; y += step) {
      const p = { x, y };
      const za = shellHeight(a, p), zb = shellHeight(b, p);
      if (za !== null && zb !== null && Math.min(za - a.baseZMm, zb - b.baseZMm) > minDepthMm) {
        return true;
      }
    }
  }
  return false;
}

/**
 * How far `shell` stands above the best of `others` at a point — positive
 * where this shell owns the surface. `+∞` where no other shell reaches.
 */
export function winMargin(shell: DomeShell, others: DomeShell[], p: Pt2): number {
  const mine = shellHeight(shell, p);
  if (mine === null) return -Infinity;
  let best = -Infinity;
  for (const o of others) {
    const z = shellHeight(o, p);
    if (z !== null && z > best) best = z;
  }
  return best === -Infinity ? Infinity : mine - best;
}

/**
 * Signed distance to a polygon's outline: positive inside, negative outside.
 *
 * Used as one half of the region's scalar field, so that "inside my base"
 * and "taller than the others" are the same kind of quantity and can simply
 * be minimised together.
 */
export function signedDistanceToPolygon(p: Pt2, poly: Pt2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return pointInPolygon(p, poly, 0) ? best : -best;
}

export interface OwnedRegion {
  /** Outer ring(s) of the region this shell wins, CCW. */
  outers: Pt2[][];
  /** Holes, CW — a taller dome standing inside this one punches one. */
  holes: Pt2[][];
}

/**
 * The region `shell` owns against `others`, traced on a grid.
 *
 * Both conditions — inside my base, and taller than everyone else — are
 * positive scalars, so their minimum is positive exactly on the region and
 * one contour pass finds its whole outline, corners between the two kinds of
 * boundary included.
 */
export function ownedRegion(
  shell: DomeShell,
  others: DomeShell[],
  spacingMm: number,
): OwnedRegion {
  const box = shellBox(shell.base);
  const field = (p: Pt2): number => {
    let inside = signedDistanceToPolygon(p, shell.base);
    if (shell.extraField) inside = Math.min(inside, shell.extraField(p));
    if (inside <= 0) return inside;
    const margin = winMargin(shell, others, p);
    // Both are lengths, but one is a distance in plan and the other a height
    // difference; the region only needs the SIGN of each, so the smaller of
    // the two is a valid indicator whatever their units mean.
    return Math.min(inside, margin === Infinity ? inside : margin);
  };
  const rings = significantRings(contourRegion(field, box, spacingMm), spacingMm * spacingMm * 4);
  const simplified = rings.map((r) => simplifyRing(r, spacingMm * 0.08));
  return splitRings(simplified);
}

// ─── Membrane cache ──────────────────────────────────────────────────────────
//
// Every dome in a cluster has to evaluate every other dome's surface, so the
// same membrane would otherwise be solved once per sibling per redraw. The
// solve is the expensive part of the whole element, and it depends only on
// the base and three numbers.

const MEMBRANE_MAX = 24;
const membraneCache = new Map<string, Membrane | null>();

export function membraneFor(
  base: Pt2[],
  heightMm: number,
  bulge: number,
  resolution: number,
): Membrane | null {
  const key = JSON.stringify([base, heightMm, bulge, resolution]);
  if (membraneCache.has(key)) return membraneCache.get(key) ?? null;
  const m = buildMembrane(base, { heightMm, bulge, resolution });
  if (membraneCache.size >= MEMBRANE_MAX) {
    const first = membraneCache.keys().next().value;
    if (first !== undefined) membraneCache.delete(first);
  }
  membraneCache.set(key, m);
  return m;
}

/**
 * Is this point on a seam rather than on the shell's own base edge?
 *
 * A seam rib is shared by the two domes that meet there, so exactly one of
 * them must emit it. The test is geometric rather than bookkeeping: a point
 * where another shell reaches the same height is a crease, wherever it sits.
 */
export function onSeam(shell: DomeShell, others: DomeShell[], p: Pt2, tolMm: number): boolean {
  const margin = winMargin(shell, others, p);
  return Number.isFinite(margin) && Math.abs(margin) <= tolMm;
}

/**
 * Which shell emits the ribs along a seam: the one whose owner id sorts
 * first. Arbitrary, but stable and agreed on by both sides, which is all
 * that is needed to stop a doubled bar.
 */
export function ownsSeamAgainst(shell: DomeShell, other: DomeShell): boolean {
  return shell.ownerId < other.ownerId;
}

/** The area a region covers, holes taken out. */
export function regionArea(region: OwnedRegion): number {
  const outer = region.outers.reduce((s, r) => s + Math.abs(polygonArea(r)), 0);
  const hole = region.holes.reduce((s, r) => s + Math.abs(polygonArea(r)), 0);
  return Math.max(0, outer - hole);
}
