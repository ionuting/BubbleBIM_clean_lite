/**
 * Roof contour extraction — from connected ax nodes or storey wall network.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  calcShellPolygon,
  getAxRealPos,
  getConnectedNodes,
  getNodeBimPos,
  getStoreyBand,
  insetPolygon,
} from '@/lib/bimGeometry';
import { parseAxes } from '@/lib/utils';
import { sanitizePolygon } from './straightSkeleton';
import type { Pt2, RoofContour, RoofDiagnostic } from './types';

/** Plan position for roof contour — prefers grid axes, then bimX/Y, then node.x/y. */
function roofNodePos(n: BubbleGraphNode, map: Map<string, BubbleGraphNode>): Pt2 {
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

function ensureCcw(pts: Pt2[]): Pt2[] {
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area2 += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  if (area2 < 0) return [...pts].reverse();
  return pts;
}

function polygonArea(pts: Pt2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

/** Proper segment intersection (excludes shared endpoints of adjacent edges). */
function segsCross(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
  const o = (p: Pt2, q: Pt2, r: Pt2) => (r.x - p.x) * (q.y - p.y) - (q.x - p.x) * (r.y - p.y);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True if the closed polygon has no self-crossing edges (ignores adjacency). */
function isSimplePolygon(pts: Pt2[]): boolean {
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
 * Exterior cycle of an undirected ax–ax graph built from walls.
 * At junctions (deg > 2), picks the sharpest left turn to stay on the outer ring.
 */
export function walkWallExteriorCycle(
  adj: Map<string, string[]>,
  pos: Map<string, Pt2>,
): string[] | null {
  if (adj.size < 3) return null;

  let start = [...adj.keys()][0];
  for (const id of adj.keys()) {
    const p = pos.get(id)!;
    const s = pos.get(start)!;
    if (p.x < s.x - 1e-6 || (Math.abs(p.x - s.x) < 1e-6 && p.y < s.y)) start = id;
  }

  const startNeighbors = adj.get(start) ?? [];
  if (startNeighbors.length === 0) return null;

  // First step: neighbor with smallest absolute angle from +X
  let first = startNeighbors[0];
  let bestAng = Infinity;
  for (const n of startNeighbors) {
    const a = pos.get(start)!;
    const b = pos.get(n)!;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (ang < bestAng) { bestAng = ang; first = n; }
  }

  const path: string[] = [start, first];
  const used = new Set<string>([edgeKey(start, first)]);
  let prev = start;
  let cur = first;
  const maxSteps = adj.size * 4;

  for (let step = 0; step < maxSteps; step++) {
    if (cur === start) break;
    const neighbors = adj.get(cur) ?? [];
    const candidates = neighbors.filter((n) => !used.has(edgeKey(cur, n)) || n === start);
    if (candidates.length === 0) return null;

    const pPrev = pos.get(prev)!;
    const pCur = pos.get(cur)!;
    const inDx = pCur.x - pPrev.x;
    const inDy = pCur.y - pPrev.y;

    let best = candidates[0];
    let bestTurn = -Infinity;
    for (const n of candidates) {
      if (n === prev && candidates.length > 1) continue;
      const pNext = pos.get(n)!;
      const outDx = pNext.x - pCur.x;
      const outDy = pNext.y - pCur.y;
      // Cross product: positive = left turn (CCW). Prefer largest left turn for outer CCW walk.
      const cross = inDx * outDy - inDy * outDx;
      const dot = inDx * outDx + inDy * outDy;
      const turn = Math.atan2(cross, dot);
      if (turn > bestTurn + 1e-9) {
        bestTurn = turn;
        best = n;
      }
    }

    used.add(edgeKey(cur, best));
    path.push(best);
    prev = cur;
    cur = best;
    if (cur === start) break;
  }

  if (path[path.length - 1] !== start) return null;
  // Drop closing duplicate
  path.pop();
  return path.length >= 3 ? path : null;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Build roof contour from walls belonging to a storey (outer cycle of wall graph).
 */
export function contourFromStoreyWalls(
  storeyId: string,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): { axIds: string[]; points: Pt2[] } | null {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const storey = nodeMap.get(storeyId);
  if (!storey || storey.type !== 'storey') return null;

  const walls = nodes.filter((n) => {
    if (n.type !== 'wall') return false;
    if (n.parentId === storeyId) return true;
    // Walls whose both endpoints live under this storey
    const ends = getConnectedNodes(n.id, edges, nodeMap).filter((c) => c.type === 'ax');
    return ends.length >= 2 && ends.every((e) => e.parentId === storeyId || !e.parentId);
  });

  const adj = new Map<string, string[]>();
  const pos = new Map<string, Pt2>();

  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    if (!adj.get(a)!.includes(b)) adj.get(a)!.push(b);
    if (!adj.get(b)!.includes(a)) adj.get(b)!.push(a);
  };

  for (const w of walls) {
    const ends = getConnectedNodes(w.id, edges, nodeMap).filter((c) => c.type === 'ax' || c.type === 'column');
    if (ends.length < 2) continue;
    const a = ends[0];
    const b = ends[1];
    pos.set(a.id, roofNodePos(a, nodeMap));
    pos.set(b.id, roofNodePos(b, nodeMap));
    link(a.id, b.id);
  }

  const cycle = walkWallExteriorCycle(adj, pos);
  if (!cycle) {
    // Fallback: convex-ish — all ax under storey, angular sort
    const axs = nodes.filter(
      (n) => (n.type === 'ax' || n.type === 'column') && (n.parentId === storeyId || n.parentId == null),
    );
    if (axs.length < 3) return null;
    const pts = axs.map((n) => ({ id: n.id, ...roofNodePos(n, nodeMap) }));
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    const ordered = ensureCcw(pts.map((p) => ({ x: p.x, y: p.y })));
    // Remap ids after possible reverse
    const idByKey = new Map(pts.map((p) => [`${p.x},${p.y}`, p.id]));
    const axIds = ordered.map((p) => idByKey.get(`${p.x},${p.y}`) ?? '');
    return { axIds: axIds.filter(Boolean), points: ordered };
  }

  const points = ensureCcw(cycle.map((id) => pos.get(id)!));
  // Reorder axIds to match CCW points (match by position)
  const axIds: string[] = [];
  for (const p of points) {
    const id = cycle.find((cid) => {
      const q = pos.get(cid)!;
      return Math.hypot(q.x - p.x, q.y - p.y) < 1e-3;
    });
    if (id) axIds.push(id);
  }
  return { axIds, points };
}

export function readRoofIntentProps(node: BubbleGraphNode) {
  const p = node.properties;
  return {
    overhangMm: Number(p.overhang_mm ?? 400),
    pitchDeg: Number(p.pitch_deg ?? 30),
  };
}

/**
 * Resolve contour for an existing roof node.
 * Prefers connected ax (edge order), else storey walls.
 */
export function resolveRoofContour(
  roof: BubbleGraphNode,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  overhangMm: number,
  diagnostics: RoofDiagnostic[],
): RoofContour | null {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  let points: Pt2[] | null = null;
  let axIds: string[] = [];

  // ── Primary: the ax nodes in the ORDER they were connected to the roof ──
  // The user builds the outline by wiring ax nodes in contour order (usually
  // CCW), so that connection order IS the polygon. Respect it — this is the only
  // way concave/complex footprints (L/U/T/pentagon) come through correctly; an
  // angular sort around the centroid would convexify them.
  const orderedAnchors: BubbleGraphNode[] = [];
  const seenAnchor = new Set<string>();
  for (const e of edges) {
    if (e.from !== roof.id && e.to !== roof.id) continue;
    const otherId = e.from === roof.id ? e.to : e.from;
    if (seenAnchor.has(otherId)) continue;
    const other = nodeMap.get(otherId);
    if (other && (other.type === 'ax' || other.type === 'column')) {
      orderedAnchors.push(other);
      seenAnchor.add(otherId);
    }
  }

  if (orderedAnchors.length >= 3) {
    const withPos = orderedAnchors.map((n) => ({ id: n.id, ...roofNodePos(n, nodeMap) }));
    const ordered = withPos.map((p) => ({ x: p.x, y: p.y }));
    // Trust the connection order only if it forms a simple (non-self-intersecting)
    // polygon; otherwise fall back to the centroid angular sort below.
    if (isSimplePolygon(ordered) && Math.abs(polygonArea(ordered)) >= 1) {
      const ccw = polygonArea(ordered) < 0 ? [...withPos].reverse() : withPos;
      points = ccw.map((p) => ({ x: p.x, y: p.y }));
      axIds = ccw.map((p) => p.id);
    }
  }

  // Fallback: angular sort around centroid (only correct for star-shaped plans).
  if (!points && orderedAnchors.length >= 3) {
    const withPos = orderedAnchors.map((n) => ({ id: n.id, ...roofNodePos(n, nodeMap) }));
    const cx = withPos.reduce((s, p) => s + p.x, 0) / withPos.length;
    const cy = withPos.reduce((s, p) => s + p.y, 0) / withPos.length;
    withPos.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    points = ensureCcw(withPos.map((p) => ({ x: p.x, y: p.y })));
    const idByKey = new Map(withPos.map((p) => [`${p.x},${p.y}`, p.id]));
    axIds = points.map((p) => idByKey.get(`${p.x},${p.y}`) ?? '').filter(Boolean);
    if (Math.abs(polygonArea(points)) < 1) { points = null; axIds = []; }
  }

  const anchors = orderedAnchors;

  // Fallback: library calcShellPolygon (same as slab/shell) if still empty
  if (!points) {
    const shellPoly = calcShellPolygon(roof, nodeMap, edges);
    if (shellPoly && Math.abs(polygonArea(shellPoly)) >= 1) {
      points = shellPoly;
      axIds = anchors.map((n) => n.id);
    }
  }

  if (!points || points.length < 3) {
    const storeyId = roof.parentId
      ?? nodes.find((n) => n.type === 'storey')?.id
      ?? null;
    if (!storeyId) {
      diagnostics.push({
        code: 'NO_CONTOUR',
        severity: 'error',
        message: 'Roof has no contour (connect ≥3 ax) and no parent storey.',
      });
      return null;
    }
    const fromWalls = contourFromStoreyWalls(storeyId, nodes, edges);
    if (!fromWalls) {
      diagnostics.push({
        code: 'NO_CONTOUR',
        severity: 'error',
        message: 'Could not derive contour from storey walls.',
      });
      return null;
    }
    points = fromWalls.points;
    axIds = fromWalls.axIds;
    diagnostics.push({
      code: 'CONTOUR_FROM_WALLS',
      severity: 'info',
      message: `Contour derived from storey walls (${points.length} verts).`,
    });
  }

  if (Math.abs(polygonArea(points)) < 1) {
    diagnostics.push({
      code: 'NO_CONTOUR',
      severity: 'error',
      message: 'Contour has zero area.',
    });
    return null;
  }

  // Overhang: signed, uniform offset around the whole contour (all edges equally).
  //   positive → expand outward (eave/streașină past the wall line)
  //   negative → inset inward (roof stops short of the wall line)
  // insetPolygon's convention is positive = inward, so pass the negated value;
  // that makes a single call handle both directions symmetrically.
  const offset =
    overhangMm !== 0 ? insetPolygon(points, [-overhangMm]) : points;
  // Drop duplicate / collinear vertices (from wiring or the offset) so the
  // downstream skeleton, eave ring and 2D plan all work on a clean polygon.
  const cleaned = sanitizePolygon(offset, 1);
  const withOverhang = cleaned.length >= 3 ? cleaned : offset;

  const storeyId = roof.parentId ?? null;
  let baseZ = Number(roof.z ?? 0);
  if (storeyId) {
    const storey = nodeMap.get(storeyId);
    if (storey?.type === 'storey') {
      baseZ = Number(storey.properties.topElevation ?? 3000);
    } else {
      const { top } = getStoreyBand(roof, nodeMap);
      baseZ = top;
    }
  }

  return {
    points: ensureCcw(withOverhang),
    axIds,
    baseZ,
    storeyId,
  };
}
