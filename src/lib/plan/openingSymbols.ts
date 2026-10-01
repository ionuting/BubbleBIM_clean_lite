/**
 * openingSymbols.ts — where a door or window symbol goes on a plan.
 *
 * A symbol is drawn in its own little frame: x runs from 0 to the opening's
 * width `W`, y from the wall's outer face at 0 to its inner face at `T`. So
 * placing one comes down to finding four things in the drawing — that origin,
 * the direction along the wall, the direction across it, and the two sizes.
 *
 * They are read off the wall's FOOTPRINT, the same quad the plan fills and the
 * kernel extrudes, interpolated at the opening's own interval. That is what
 * keeps a symbol in its hole: whatever the joins did to the wall's ends, the
 * footprint already carries it, so the symbol moves with the wall rather than
 * with an idealised centre-line the wall no longer follows.
 *
 * BIM millimetres throughout, which for a floor plan is the drawing's own
 * (u, v) exactly.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  calcWallGeometry, calcWallJoins, getNodeWallThickness,
  type WallGeometry,
} from '@/lib/bimGeometry';
import { wallFaces, type Pt } from './wallSilhouette';

export interface OpeningFrame {
  node: BubbleGraphNode;
  kind: 'door' | 'window';
  /** The wall the opening is a hole in. */
  wallId: string;
  /** The opening's start corner on the wall's OUTER face. BIM mm. */
  origin: Pt;
  /** Unit vector along the wall, start → end. */
  along: Pt;
  /** Unit vector across the wall, outer face → inner face. */
  across: Pt;
  widthMm: number;
  thicknessMm: number;
  /** The opening's start jamb from the wall's start, along the wall. */
  distFromStartMm: number;
  /** The wall's length between its (join-adjusted) ends. */
  wallLenMm: number;
  /** The wall's two ends on the same face `origin` is on. */
  wallStart: Pt;
  wallEnd: Pt;
  /**
   * Set when the opening is an entry in the wall's own `doors` / `windows`
   * list rather than a node of the graph: an edit has to be written back
   * into that list, at this index.
   */
  inline?: { key: 'doors' | 'windows'; index: number };
  /**
   * True when the same descriptor places several openings (`count > 1`):
   * they are spaced by a rule, so one cannot be dragged on its own.
   */
  grouped: boolean;
}

/**
 * Which entry of a wall's inline `doors` / `windows` list an opening node
 * stands for, or null when the node is a real node of the graph.
 *
 * `collectOpenings` synthesises a node per entry, with the entry's own `id`
 * when it has one and `inl_<kind>_<wallId>_<index>` otherwise; both are
 * resolved here so an edit lands on the entry it came from.
 */
export function inlineOpeningRef(
  wall: BubbleGraphNode,
  node: BubbleGraphNode,
): { key: 'doors' | 'windows'; index: number } | null {
  const key = node.type === 'door' ? 'doors' : 'windows';
  let list: unknown[] = [];
  try {
    const raw = String(wall.properties[key] ?? '[]').trim();
    const parsed = JSON.parse(raw || '[]') as unknown;
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    return null;
  }
  const byId = list.findIndex((e) =>
    !!e && typeof e === 'object' && String((e as { id?: unknown }).id ?? '') === node.id);
  if (byId >= 0) return { key, index: byId };
  const m = new RegExp(`^inl_(?:door|win)_${wall.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)$`).exec(node.id);
  if (!m) return null;
  const index = Number(m[1]);
  return index < list.length ? { key, index } : null;
}

const MM = 0.001;

function unit(from: Pt, to: Pt): { u: Pt; len: number } | null {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return null;
  return { u: { x: dx / len, y: dy / len }, len };
}

/**
 * Every opening in one wall, framed for a symbol.
 *
 * A curved wall is skipped: its footprint is the whole tessellated ring, not
 * four corners, so there is no edge pair to interpolate an opening along. The
 * plan does not cut openings out of an arc either, so there is nothing there
 * to put a symbol into.
 */
export function wallOpeningFrames(
  wall: BubbleGraphNode,
  geo: WallGeometry,
  /**
   * Somewhere inside the building — the storey's own anchors averaged.
   * A symbol is drawn from the OUTSIDE face inwards (its sill projects into
   * the room, its leaf swings into the room), and a wall's footprint has no
   * opinion about which of its two faces faces out: `calcWallGeometry` calls
   * the left of the run "outer", which on a south wall is the inside. So the
   * across direction is turned to point at this instead — the same test
   * `ogBimMapper` uses to tell which way an exterior wall looks.
   */
  inward?: Pt,
  /** Whether an opening id names a node of the graph; see `inlineRef`. */
  isGraphNode?: (id: string) => boolean,
): OpeningFrame[] {
  const fp = geo.footprint;
  if (!fp || fp.length !== 4 || geo.openings.length === 0) return [];

  // Each face read at a distance along the axis, not a fraction of its own
  // length — the faces of a joined wall differ in length, and equal fractions
  // make every opening a parallelogram. See `wallFaces`.
  const faces = wallFaces(geo);
  if (!faces) return [];
  const { len } = faces;

  // Which footprint edge faces out. The centroid decides; without one the
  // footprint's own naming stands, which is what the parametric plan draws.
  let outerAt = faces.outerAt;
  let innerAt = faces.innerAt;
  if (inward) {
    const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const d = (p: Pt) => Math.hypot(p.x - inward.x, p.y - inward.y);
    if (d(mid(fp[0], fp[1])) < d(mid(fp[3], fp[2]))) {
      [outerAt, innerAt] = [innerAt, outerAt];
    }
  }

  // How many openings each descriptor places; more than one means a rule.
  const perNode = new Map<string, number>();
  for (const op of geo.openings) perNode.set(op.node.id, (perNode.get(op.node.id) ?? 0) + 1);

  const out: OpeningFrame[] = [];
  for (const op of geo.openings) {
    const t0 = op.tS / MM;
    const t1 = t0 + op.oW / MM;
    if (!(t1 > t0)) continue;

    const o0 = outerAt(t0);
    const o1 = outerAt(t1);
    const i0 = innerAt(t0);

    const along = unit(o0, o1);
    const across = unit(o0, i0);
    if (!along || !across) continue;

    // `flip_across` is the same per-opening override the parametric plan
    // honours, for the wall where the rule guesses wrong.
    const flip = String(op.node.properties.flip_across ?? '').toLowerCase() === 'true';
    const origin = flip ? i0 : o0;
    const acrossU = flip ? { x: -across.u.x, y: -across.u.y } : across.u;
    const [wallStart, wallEnd] = flip ? [innerAt(0), innerAt(len)] : [outerAt(0), outerAt(len)];

    out.push({
      node: op.node,
      kind: op.isDoor ? 'door' : 'window',
      wallId: wall.id,
      origin,
      along: along.u,
      across: acrossU,
      widthMm: along.len,
      thicknessMm: across.len || getNodeWallThickness(wall) * 1000,
      distFromStartMm: t0,
      wallLenMm: len,
      wallStart,
      wallEnd,
      ...(inlineRef(wall, op.node, isGraphNode)),
      grouped: (perNode.get(op.node.id) ?? 1) > 1,
    });
  }
  return out;
}

/**
 * `inline` for an opening the wall carries in its list, nothing for a node
 * of the graph. `collectOpenings` synthesises a node per list entry, so the
 * only way to tell the two apart for certain is whether the id is in the
 * graph; without that, the synthesised id's own prefix has to do.
 */
function inlineRef(
  wall: BubbleGraphNode,
  node: BubbleGraphNode,
  isGraphNode?: (id: string) => boolean,
): { inline?: OpeningFrame['inline'] } {
  const real = isGraphNode ? isGraphNode(node.id) : !/^inl_(door|win)_/.test(node.id);
  if (real) return {};
  const ref = inlineOpeningRef(wall, node);
  return ref ? { inline: ref } : {};
}

/** Every opening on one storey, framed for a symbol. */
export function storeyOpeningFrames(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  storeyId: string,
): OpeningFrame[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const joins = calcWallJoins(nodes, edges);

  // Roughly the middle of the storey, from the points the walls are hung on.
  const anchors = nodes.filter((n) =>
    n.parentId === storeyId && (n.type === 'ax' || n.type === 'column'));
  const inward = anchors.length
    ? {
      x: anchors.reduce((a, n) => a + Number(n.properties.bimX ?? n.x), 0) / anchors.length,
      y: anchors.reduce((a, n) => a + Number(n.properties.bimY ?? n.y), 0) / anchors.length,
    }
    : undefined;

  const isGraphNode = (id: string) => nodeMap.has(id);
  return nodes
    .filter((n) => n.type === 'wall' && n.parentId === storeyId)
    .flatMap((wn) => {
      const geo = calcWallGeometry(wn, nodeMap, edges, joins);
      return geo ? wallOpeningFrames(wn, geo, inward, isGraphNode) : [];
    });
}

/**
 * The 2D transform that carries a symbol's own millimetres onto the drawing.
 *
 * Derived by mapping the frame's origin and its two unit directions through
 * the view's own projection and measuring what came out, rather than composing
 * the matrix from scale and rotation by hand. The view may flip an axis — a
 * plan's `v` grows up the model and down the screen — and a sign assumed here
 * would put every door on the wrong side of its wall.
 */
export function symbolMatrix(
  f: OpeningFrame,
  toSvg: (u: number, v: number) => { x: number; y: number },
): string {
  const o = toSvg(f.origin.x, f.origin.y);
  const ax = toSvg(f.origin.x + f.along.x, f.origin.y + f.along.y);
  const ay = toSvg(f.origin.x + f.across.x, f.origin.y + f.across.y);
  const n = (v: number) => v.toFixed(6);
  return `matrix(${n(ax.x - o.x)},${n(ax.y - o.y)},`
    + `${n(ay.x - o.x)},${n(ay.y - o.y)},`
    + `${o.x.toFixed(3)},${o.y.toFixed(3)})`;
}
