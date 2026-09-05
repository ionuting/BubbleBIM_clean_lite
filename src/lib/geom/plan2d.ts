/**
 * plan2d.ts — plan-polygon primitives shared by the generators.
 *
 * These started life inside `roof/contour.ts` and moved here unchanged when the
 * stairwell needed the same three things: read a node's real plan position,
 * decide whether a ring of points forms a usable polygon, and orient it.
 *
 * Everything is in BIM millimetres, X east, Y north, angles CCW from +X — the
 * same convention as the rest of the app.
 */
import type { BubbleGraphNode } from '@/store';
import { getAxRealPos, getNodeBimPos } from '@/lib/bimGeometry';
import { parseAxes } from '@/lib/utils';

export interface Pt2 { x: number; y: number }

/**
 * Plan position of a node for polygon purposes.
 *
 * An `ax` carries a grid reference rather than a coordinate, so its `x/y` are
 * canvas positions and not the building's. Resolution order — explicit bimX/bimY,
 * then the storey's axis spacing, then the raw node position — is what keeps a
 * contour drawn on the grid landing where the grid actually is.
 */
export function planPos(n: BubbleGraphNode, map: Map<string, BubbleGraphNode>): Pt2 {
  if (n.type !== 'ax' && n.type !== 'column') return getNodeBimPos(n, map);
  if (n.properties.bimX != null && n.properties.bimY != null) {
    return { x: Number(n.properties.bimX), y: Number(n.properties.bimY) };
  }
  const storey = n.parentId ? map.get(n.parentId) : undefined;
  const axesX = parseAxes(storey?.properties?.axesX);
  const axesY = parseAxes(storey?.properties?.axesY);
  if (axesX.length > 0 && axesY.length > 0) return getAxRealPos(n, map);
  return { x: n.x, y: n.y };
}

/**
 * Y-rotation that points a box's local +Z along a BIM plan heading.
 *
 * The viewers map BIM (x, y, z) to scene (x, z, −y), so plan north runs along
 * scene −Z and a box's own +Z axis starts out pointing SOUTH, not east. That
 * quarter turn is easy to lose: rotating by minus the heading looks right in the
 * plan sketch and comes out both rotated and mirrored on screen.
 *
 * Derived rather than guessed — R_y(θ)·(0,0,1) = (sinθ, 0, cosθ), which must
 * equal the heading in scene space, (dx, 0, −dy).
 */
export function yawForPlanDir(dx: number, dy: number): number {
  return Math.atan2(dx, -dy);
}

/**
 * Y-rotation that points a mesh's local +X along a BIM plan heading — for
 * geometry authored with its length along X, like an extruded cross-section.
 *
 * Same derivation as above with the other axis: R_y(ψ)·(1,0,0) = (cosψ, 0, −sinψ)
 * must equal (dx, 0, −dy). Note this happens to be plain atan2(dy, dx) while the
 * +Z variant is not — which is exactly how the wrong formula slipped in there.
 */
export function yawForPlanDirX(dx: number, dy: number): number {
  return Math.atan2(dy, dx);
}

/** Signed area; positive when the ring is counter-clockwise. */
export function polygonArea(pts: Pt2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

/** Return the ring counter-clockwise, reversing it only if it is not already. */
export function ensureCcw(pts: Pt2[]): Pt2[] {
  return polygonArea(pts) < 0 ? [...pts].reverse() : pts;
}

/** Proper segment intersection (excludes shared endpoints of adjacent edges). */
function segsCross(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
  const o = (p: Pt2, q: Pt2, r: Pt2) => (r.x - p.x) * (q.y - p.y) - (q.x - p.x) * (r.y - p.y);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True if the closed polygon has no self-crossing edges (ignores adjacency). */
export function isSimplePolygon(pts: Pt2[]): boolean {
  const n = pts.length;
  if (n < 4) return true;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue; // adjacent edges
      if (segsCross(a, b, pts[j], pts[(j + 1) % n])) return false;
    }
  }
  return true;
}

/**
 * Point-in-polygon by ray casting, with points ON the boundary counted as inside.
 *
 * The tolerance matters here: a stair sized to exactly fill its stairwell has
 * corners sitting on the boundary line, and a strict test would report every one
 * of them as an overflow.
 */
export function pointInPolygon(p: Pt2, poly: Pt2[], tolMm = 1): boolean {
  const n = poly.length;
  if (n < 3) return false;

  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const cx = a.x + dx * t, cy = a.y + dy * t;
    if (Math.hypot(p.x - cx, p.y - cy) <= tolMm) return true;
  }

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y)
      && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
