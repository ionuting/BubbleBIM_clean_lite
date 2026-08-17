/**
 * Internal B-rep kernel — BubbleGraph element builders.
 *
 * The bridge from the graph to the kernel: a node plus its neighbours in, a
 * closed `Solid` out. These are pure functions — no scene, no renderer, no
 * mutation — so they can be unit-tested against volume and manifold invariants
 * rather than eyeballed in a viewer.
 *
 * Plan/elevation resolution (wall joins, storey bands, footprint offsets) is NOT
 * reimplemented here; it stays in `bimGeometry.ts`, which already handles miter
 * and butt corners. This module consumes that output and turns it into topology.
 *
 * ## Units at the boundary
 * `bimGeometry.ts` mixes units by historical accident — footprints and storey
 * bands are millimetres, but thicknesses, `botM` and `beamDesc` are metres, in
 * THREE's XZ axes. Every conversion is done here, explicitly and once, so the
 * kernel itself only ever sees BIM millimetres.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  calcWallGeometry, calcRoomPolygon, calcShellPolygon,
  getAxRealPos, getNodeBimPos, getNodeLocalTransform, getNodeSlabThickness, getStoreyBand,
  insetPolygon, parseColumnDims, parseContourOffsets,
  type NodeLocalTransform, type WallGeometry, type WallJoinResult,
} from '@/lib/bimGeometry';
import type { Solid, Vec2, Vec3 } from './types';
import { boxSolid, cylinderSolid, extrudeFootprint, sweepBox } from './prism';
import { transformSolid } from './solid';
import { centroid } from './measure';

/** Metres (as `bimGeometry` reports them) → BIM millimetres (as the kernel wants). */
const M_TO_MM = 1000;

/** Sides used to approximate a circular column. Matches the current renderers' cylinder. */
const CIRCLE_SIDES = 18;

export interface BuildOptions {
  /**
   * Apply the node's `obj_translate_*` / `obj_rotate_*` local transform.
   * Default true.
   */
  applyLocalTransform?: boolean;
}

export interface WallBuildOptions extends BuildOptions {
  /**
   * Push the wall's start / end face outward along its own axis by this many mm.
   *
   * Used by junction resolution: a wall that yields at a corner must first run
   * THROUGH the wall it yields to, so that subtracting the other leaves the
   * corner filled rather than notched. Ignored unless the footprint is the plain
   * 4-corner rectangle (i.e. no join map was supplied).
   */
  extendStart?: number;
  extendEnd?: number;
}

/**
 * Push a plain wall rectangle's end faces outward along its axis.
 *
 * The untrimmed footprint from `calcWallGeometry` is always
 * `[outerStart, outerEnd, innerEnd, innerStart]`, so vertices 0/3 sit at the
 * start and 1/2 at the end. Anything else means join corners were baked in and
 * the polygon is left alone.
 */
function extendFootprint(
  footprint: Array<{ x: number; y: number }>,
  extStart: number,
  extEnd: number,
): Array<{ x: number; y: number }> {
  if (footprint.length !== 4 || (extStart === 0 && extEnd === 0)) return footprint;
  const [os, oe] = [footprint[0], footprint[1]];
  const dx = oe.x - os.x, dy = oe.y - os.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return footprint;
  const ux = dx / l, uy = dy / l;

  const move = (p: { x: number; y: number }, d: number) => ({ x: p.x + ux * d, y: p.y + uy * d });
  return [
    move(footprint[0], -extStart),
    move(footprint[1], extEnd),
    move(footprint[2], extEnd),
    move(footprint[3], -extStart),
  ];
}

// ─── Local transform ──────────────────────────────────────────────────────────

/**
 * Apply a node's local transform to a solid.
 *
 * Rotation is taken about the solid's own volume centroid — "spin this element
 * in place", which is what the inspector's rotate fields mean. The existing
 * renderers instead rotate about each mesh's local origin, which differs per
 * backend precisely because they have no shared notion of the element's centre;
 * pinning it to the centroid is the definition that survives the move to a
 * single kernel.
 *
 * Axis mapping follows `NodeLocalTransform`: rx around East (X), ry around Up (Z),
 * rz around North (Y).
 */
export function applyLocalTransform(solid: Solid, t: NodeLocalTransform, pivot?: Vec3): Solid {
  const hasRot = t.rx !== 0 || t.ry !== 0 || t.rz !== 0;
  const hasTrans = t.tx !== 0 || t.ty !== 0 || t.tz !== 0;
  if (!hasRot && !hasTrans) return solid;

  const c = hasRot ? (pivot ?? centroid(solid) ?? { x: 0, y: 0, z: 0 }) : { x: 0, y: 0, z: 0 };
  const D2R = Math.PI / 180;
  const [sx, cx] = [Math.sin(t.rx * D2R), Math.cos(t.rx * D2R)];
  const [sy, cy] = [Math.sin(t.ry * D2R), Math.cos(t.ry * D2R)];
  const [sz, cz] = [Math.sin(t.rz * D2R), Math.cos(t.rz * D2R)];

  return transformSolid(solid, (p) => {
    let x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
    if (t.rx !== 0) { const ny = y * cx - z * sx, nz = y * sx + z * cx; y = ny; z = nz; } // around East
    if (t.ry !== 0) { const nx = x * cy - y * sy, ny = x * sy + y * cy; x = nx; y = ny; } // around Up
    if (t.rz !== 0) { const nz = z * cz - x * sz, nx = z * sz + x * cz; z = nz; x = nx; } // around North
    return { x: x + c.x + t.tx, y: y + c.y + t.ty, z: z + c.z + t.tz };
  });
}

function finish(solid: Solid | null, node: BubbleGraphNode, opts: BuildOptions): Solid | null {
  if (!solid) return null;
  if (opts.applyLocalTransform === false) return solid;
  return applyLocalTransform(solid, getNodeLocalTransform(node));
}

// ─── Walls ────────────────────────────────────────────────────────────────────

/**
 * Solid masonry of a wall — the resolved plan footprint (including miter/butt
 * join corners) extruded through the wall's own height.
 *
 * Openings are NOT cut here: subtracting them is a boolean operation, which
 * belongs to the `BooleanEngine` stage. Until then this is the uncut body, same
 * as the `solid fallback` path the current renderers use when a cut fails.
 *
 * Pass `wg` when the caller already computed the wall geometry (the scene
 * builder does, once per wall) to avoid recomputing joins per element.
 */
export function wallSolid(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  joins?: Map<string, WallJoinResult>,
  opts: WallBuildOptions = {},
  wg?: WallGeometry | null,
): Solid | null {
  const g = wg ?? calcWallGeometry(node, nodeMap, edges, joins);
  if (!g || g.footprint.length < 3 || !(g.wallH > 0)) return null;
  // `footprint` is BIM mm already; its winding is whatever the join solver
  // produced, and `extrudeFootprint` reorients it.
  const footprint = extendFootprint(g.footprint, opts.extendStart ?? 0, opts.extendEnd ?? 0);
  return finish(extrudeFootprint(footprint, g.botM * M_TO_MM, g.wallH, 'wall'), node, opts);
}

/**
 * Ring beam (centură) sitting on top of a wall, when `has_beam` is set.
 *
 * `beamDesc` arrives in metres and in THREE's XZ plan axes (x = East,
 * z = −North); this is the one place that mapping is undone.
 */
export function wallBeamSolid(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  joins?: Map<string, WallJoinResult>,
  opts: BuildOptions = {},
  wg?: WallGeometry | null,
): Solid | null {
  const g = wg ?? calcWallGeometry(node, nodeMap, edges, joins);
  const bd = g?.beamDesc;
  if (!bd) return null;

  const midZ = (bd.baseY + bd.height / 2) * M_TO_MM;
  const a: Vec3 = { x: bd.ax * M_TO_MM, y: -bd.az * M_TO_MM, z: midZ };
  const b: Vec3 = { x: bd.bx * M_TO_MM, y: -bd.bz * M_TO_MM, z: midZ };
  return finish(sweepBox(a, b, bd.width * M_TO_MM, bd.height * M_TO_MM, 'beam'), node, opts);
}

// ─── Columns ──────────────────────────────────────────────────────────────────

/**
 * Column solid for either a standalone `column` node or an `ax` node carrying
 * `has_column`. Circular sections become regular prisms — the kernel has no
 * analytic curved faces (see `types.ts`).
 */
export function columnSolid(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  opts: BuildOptions = {},
): Solid | null {
  const { bot, top } = getStoreyBand(node, nodeMap);
  const height = top - bot;
  if (!(height > 0)) return null;

  const { w, d, circular } = parseColumnDims(String(node.properties.column_type ?? 'C25x25'));
  const pos = node.type === 'ax' ? getAxRealPos(node, nodeMap) : getNodeBimPos(node, nodeMap);

  const solid = circular
    ? cylinderSolid({ x: pos.x, y: pos.y }, bot, (w * M_TO_MM) / 2, height, CIRCLE_SIDES, 'column')
    : boxSolid({ x: pos.x, y: pos.y, z: bot + height / 2 }, w * M_TO_MM, d * M_TO_MM, height, 'column');

  return finish(solid, node, opts);
}

// ─── Slabs ────────────────────────────────────────────────────────────────────

/** Plan polygon with its `contour_offset` applied inward, as the renderers do. */
function offsetPolygon(poly: Vec2[], raw: unknown): Vec2[] {
  const inward = parseContourOffsets(raw).map((o) => -o);
  return inward.some((o) => o !== 0) ? insetPolygon(poly, inward) : poly;
}

/**
 * Structural slab hung under the top of its storey — same placement rule the
 * renderers use (`baseZ = storeyTop − thickness`).
 *
 * Returns `null` when the node has no resolvable shell polygon; unlike the
 * current renderers there is no bounding-box fallback, because a box guessed
 * from sibling positions is not geometry anyone should be measuring or exporting.
 */
export function slabSolid(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  opts: BuildOptions = {},
): Solid | null {
  const { top } = getStoreyBand(node, nodeMap);
  const thickness = getNodeSlabThickness(node) * M_TO_MM;
  const poly = calcShellPolygon(node, nodeMap, edges);
  if (!poly || poly.length < 3 || !(thickness > 0)) return null;

  const shaped = offsetPolygon(poly, node.properties.contour_offset);
  if (shaped.length < 3) return null;
  return finish(extrudeFootprint(shaped, top - thickness, thickness, 'slab'), node, opts);
}

/** Floor slab derived from a room's own polygon (`has_slab`, default on). */
export function roomSlabSolid(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  opts: BuildOptions = {},
): Solid | null {
  const { top } = getStoreyBand(node, nodeMap);
  const thickness = getNodeSlabThickness(node) * M_TO_MM;
  const poly = calcRoomPolygon(node, nodeMap, edges);
  if (!poly || poly.length < 3 || !(thickness > 0)) return null;

  const shaped = offsetPolygon(poly, node.properties.contour_offset);
  if (shaped.length < 3) return null;
  return finish(extrudeFootprint(shaped, top - thickness, thickness, 'slab'), node, opts);
}

/**
 * The air volume of a room — used for visualisation and for volumetric takeoff,
 * not as a physical body.
 */
export function roomVolumeSolid(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  opts: BuildOptions = {},
): Solid | null {
  const { bot } = getStoreyBand(node, nodeMap);
  const height = Number(node.properties.height ?? 2650);
  const poly = calcRoomPolygon(node, nodeMap, edges);
  if (!poly || poly.length < 3 || !(height > 0)) return null;

  const shaped = offsetPolygon(poly, node.properties.contour_offset);
  if (shaped.length < 3) return null;
  return finish(extrudeFootprint(shaped, bot, height, 'room'), node, opts);
}
