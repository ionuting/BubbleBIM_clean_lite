/**
 * boundary.ts — the stairwell shaft, drawn as axes in the graph.
 *
 * This is the same authoring gesture the roof uses: you wire the `stairwell`
 * node to the `ax` nodes that bound the shaft, in contour order, and that ring
 * IS the stairwell. Connection order is trusted over any sort, because an
 * angular sort around the centroid would convexify an L-shaped shaft.
 *
 * What the boundary decides, and what it does not, is deliberate:
 *
 *   decides   where the run starts, which way it climbs, how big the slab
 *             opening is, and whether the stair fits at all
 *   does not  the flight width or the stair type — those stay yours, typed in
 *             the Inspector. The boundary only says whether they work here.
 *
 * With no boundary wired, none of this applies and the stair falls back to the
 * node's own position and `direction_deg`, exactly as before.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import {
  ensureCcw,
  isSimplePolygon,
  planPos,
  pointInPolygon,
  polygonArea,
} from '@/lib/geom/plan2d';
import type { Pt2, StairDiagnostic, StairIntent } from './types';

export interface StairBoundary {
  /** The shaft outline, CCW, in BIM mm. */
  polygon: Pt2[];
  /** The ax/column nodes it came from, in polygon order. */
  axIds: string[];
  /** Where the walking line starts — bottom of the first riser. */
  origin: Pt2;
  /** Heading of the first flight, degrees CCW from +X. */
  directionDeg: number;
}

const dot = (a: Pt2, b: Pt2) => a.x * b.x + a.y * b.y;
/** Left-hand normal — "across the run", looking up it. */
const across = (d: Pt2): Pt2 => ({ x: -d.y, y: d.x });

/** Extent of a set of points along one direction. */
function span(pts: Pt2[], dir: Pt2): { min: number; max: number } {
  const ts = pts.map((p) => dot(p, dir));
  return { min: Math.min(...ts), max: Math.max(...ts) };
}

/**
 * The ax/column nodes wired to this stairwell, in the order the edges were made.
 * Mirrors the roof's contour reader — same gesture, same expectation.
 */
function orderedAnchors(
  stairwell: BubbleGraphNode,
  edges: BubbleGraphEdge[],
  byId: Map<string, BubbleGraphNode>,
): BubbleGraphNode[] {
  const out: BubbleGraphNode[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from !== stairwell.id && e.to !== stairwell.id) continue;
    const otherId = e.from === stairwell.id ? e.to : e.from;
    if (seen.has(otherId)) continue;
    seen.add(otherId);
    const other = byId.get(otherId);
    if (other && (other.type === 'ax' || other.type === 'column')) out.push(other);
  }
  return out;
}

/**
 * Read the shaft outline off the graph and derive how the stair sits inside it.
 *
 * Returns null when fewer than three anchors are wired, or when they do not form
 * a usable polygon — the caller then keeps the node's own position and heading,
 * so a half-wired stairwell degrades to the manual behaviour instead of failing.
 */
export function resolveStairBoundary(
  stairwell: BubbleGraphNode,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  intent: StairIntent,
): StairBoundary | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const anchors = orderedAnchors(stairwell, edges, byId);
  if (anchors.length < 3) return null;

  const placed = anchors.map((n) => ({ id: n.id, ...planPos(n, byId) }));
  let ring = placed;

  // Connection order is the polygon — but only if it actually closes into one.
  // A ring wired out of order self-crosses, and there an angular sort is the
  // better guess than a bow tie.
  if (!isSimplePolygon(ring) || Math.abs(polygonArea(ring)) < 1) {
    const cx = placed.reduce((s, p) => s + p.x, 0) / placed.length;
    const cy = placed.reduce((s, p) => s + p.y, 0) / placed.length;
    ring = [...placed].sort(
      (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
    );
    if (Math.abs(polygonArea(ring)) < 1) return null;
  }

  const ccw = ensureCcw(ring) as (Pt2 & { id: string })[];
  const polygon: Pt2[] = ccw.map((p) => ({ x: p.x, y: p.y }));

  // ── Which way the stair runs ──
  // Along the longest side of the shaft. For the usual rectangular stairwell
  // that is simply "lengthways", which is where a flight has to go; for an
  // L-shaped shaft it is still the side with the most room to climb.
  let u: Pt2 = { x: 1, y: 0 };
  let best = -1;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best) {
      best = len;
      u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    }
  }

  // ── Which end you start from ──
  // The end nearest the stairwell node itself. That keeps the node meaningful:
  // drag it to the corner you want to climb from and the stair turns around.
  const v = across(u);
  const t = span(polygon, u);
  const s = span(polygon, v);
  const tNode = dot({ x: stairwell.x, y: stairwell.y }, u);
  const forward = Math.abs(tNode - t.min) <= Math.abs(tNode - t.max);

  const dir = forward ? u : { x: -u.x, y: -u.y };
  const startT = forward ? t.min : t.max;

  // Centre the assembly across the shaft. A half-turn puts its second flight one
  // full width to the `turn` side, so the pair centres only if the first flight
  // starts half a width the other way.
  const turnSign = intent.turn === 'left' ? 1 : -1;
  const lateral = intent.stairType === 'u_shape' ? -turnSign * intent.widthMm / 2 : 0;
  const startS = (s.min + s.max) / 2 + lateral;

  return {
    polygon,
    axIds: ccw.map((p) => p.id),
    origin: {
      x: u.x * startT + v.x * startS,
      y: u.y * startT + v.y * startS,
    },
    directionDeg: (Math.atan2(dir.y, dir.x) * 180) / Math.PI,
  };
}

/**
 * Check the solved stair against its shaft and report what overflows.
 *
 * This is the whole point of wiring the boundary: nothing else in the app stops
 * you from asking for a 4.8 m straight run inside a 3 m stairwell. It is a
 * warning rather than an error — the geometry is valid, it just does not belong
 * in this shaft, and only you can decide which of the two to change.
 */
export function checkStairFits(
  corners: Pt2[],
  boundary: StairBoundary,
  diagnostics: StairDiagnostic[],
): boolean {
  if (!corners.length) return true;
  const outside = corners.filter((c) => !pointInPolygon(c, boundary.polygon));
  if (!outside.length) return true;

  const rad = (boundary.directionDeg * Math.PI) / 180;
  const u: Pt2 = { x: Math.cos(rad), y: Math.sin(rad) };
  const v = across(u);

  const need = { run: span(corners, u), across: span(corners, v) };
  const have = { run: span(boundary.polygon, u), across: span(boundary.polygon, v) };
  const overRun = (need.run.max - need.run.min) - (have.run.max - have.run.min);
  const overAcross = (need.across.max - need.across.min) - (have.across.max - have.across.min);

  const parts: string[] = [];
  if (overRun > 1) {
    parts.push(
      `${Math.round(overRun)} mm along the run `
      + `(needs ${Math.round(need.run.max - need.run.min)} mm, `
      + `the shaft is ${Math.round(have.run.max - have.run.min)} mm)`,
    );
  }
  if (overAcross > 1) {
    parts.push(
      `${Math.round(overAcross)} mm across `
      + `(needs ${Math.round(need.across.max - need.across.min)} mm, `
      + `the shaft is ${Math.round(have.across.max - have.across.min)} mm)`,
    );
  }

  diagnostics.push({
    code: 'DOES_NOT_FIT',
    severity: 'warning',
    message: parts.length
      ? `The stair overruns its shaft by ${parts.join(' and ')}.`
      : 'The stair falls outside its shaft even though it would fit inside the '
        + 'overall size — check the shape of the outline, or which corner the climb starts from.',
  });
  return false;
}
