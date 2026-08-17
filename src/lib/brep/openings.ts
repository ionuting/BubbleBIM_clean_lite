/**
 * Internal B-rep kernel — window and door openings.
 *
 * An opening is a void in a wall, so it is a subtraction — the operation the
 * kernel now does exactly. What makes this worth its own module is the placement
 * arithmetic: `calcWallGeometry` reports openings in metres on THREE's XZ axes,
 * while the kernel works in BIM millimetres, and getting that conversion wrong
 * puts a window through the wrong face of the wall.
 *
 * ## No overshoot
 * The cutter spans exactly the wall thickness, so its side faces are EXACTLY
 * coplanar with the wall's. That is deliberate. The current OpenGeometry path
 * cannot do this — its own documentation requires a `max(thickness·0.05, 0.01)`
 * model-unit overshoot and warns that coincident faces may still fail, which is
 * why `ogBimMapper.ts` defaults to a 1000 mm `cut_depth` and wraps every cut in
 * retry logic. manifold-3d resolves the coincident case exactly (see the Phase 2
 * spike), so the reveal lands precisely on the wall face instead of somewhere
 * within a centimetre of it.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { calcWallGeometry, type OpeningMeshDesc, type WallGeometry } from '@/lib/bimGeometry';
import type { Solid, Vec2 } from './types';
import { extrudeFootprint } from './prism';
import { subtractSolids, type BooleanOptions } from './boolean';
import type { JunctionDiagnostic, ResolveResult, WallBody } from './junctions';

/** Metres, as `bimGeometry` reports them → BIM millimetres. */
const M_TO_MM = 1000;

/** One opening, with the void it removes and the element that owns it. */
export interface OpeningCutter {
  /** The window/door node, or null when the opening is a bare void. */
  node: BubbleGraphNode | null;
  isDoor: boolean;
  solid: Solid;
}

/**
 * The void a single opening removes from its wall.
 *
 * `cx`/`cz` sit on the wall centre-line in THREE's XZ plan (z = −north), and the
 * cutter is a box: `oW` along the wall, `oH` vertical from the sill, and the
 * full wall thickness across. The across-wall axis is derived from the
 * along-wall one rather than read from `nx`/`nz`, so it is perpendicular by
 * construction.
 */
export function openingCutter(op: OpeningMeshDesc): Solid | null {
  if (!(op.oW > 0) || !(op.oH > 0) || !(op.wallThick > 0)) return null;

  // THREE XZ (metres) → BIM plan (mm): x stays, north = −z.
  const cx = op.cx * M_TO_MM;
  const cy = -op.cz * M_TO_MM;
  const ux = op.ux, uy = -op.uz;
  const l = Math.hypot(ux, uy);
  if (l < 1e-9) return null;
  const ax = ux / l, ay = uy / l;      // along the wall
  const nx = -ay, ny = ax;             // across it, perpendicular by construction

  const halfW = (op.oW / 2) * M_TO_MM;
  const halfT = (op.wallThick / 2) * M_TO_MM;

  const corner = (sw: number, st: number): Vec2 => ({
    x: cx + ax * sw * halfW + nx * st * halfT,
    y: cy + ay * sw * halfW + ny * st * halfT,
  });

  return extrudeFootprint(
    [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
    (op.botY + op.sill) * M_TO_MM,
    op.oH * M_TO_MM,
    'opening',
  );
}

/** Every opening void hosted by one wall. */
export function wallOpeningCutters(
  wall: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  wg?: WallGeometry | null,
): OpeningCutter[] {
  const g = wg ?? calcWallGeometry(wall, nodeMap, edges);
  if (!g) return [];

  const out: OpeningCutter[] = [];
  for (const op of g.openings) {
    const solid = openingCutter(op);
    if (solid) out.push({ node: op.node ?? null, isDoor: op.isDoor, solid });
  }
  return out;
}

export interface CutOpeningsOptions extends BooleanOptions {}

/**
 * Punch every wall's openings out of its body.
 *
 * Run AFTER junction resolution: openings belong to the finished wall, and
 * cutting them last keeps the junction booleans working on simple prisms.
 *
 * All of a wall's openings go in one call so the engine resolves them together;
 * on failure the wall keeps its unpunched body and says so, because a solid wall
 * where a window belongs is obvious to the eye, whereas a silently missing wall
 * is not.
 */
export function cutWallOpenings(
  bodies: WallBody[],
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  geoms?: Map<string, WallGeometry>,
  opts: CutOpeningsOptions = {},
): ResolveResult {
  const diagnostics: JunctionDiagnostic[] = [];

  const out = bodies.map((body) => {
    const cutters = wallOpeningCutters(body.node, nodeMap, edges, geoms?.get(body.id));
    if (cutters.length === 0) return body;

    const { solid, error } = subtractSolids(body.solid, cutters.map((c) => c.solid), opts);
    if (!solid) {
      diagnostics.push({
        code: error?.includes('empty') ? 'wall_consumed' : 'boolean_failed',
        wallId: body.id,
        message: `Could not cut ${cutters.length} opening(s) in "${body.node.name || body.id}" (${error}); keeping the solid wall.`,
      });
      return body;
    }
    return { ...body, solid };
  });

  return { bodies: out, diagnostics };
}
