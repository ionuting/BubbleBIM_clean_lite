/**
 * bimGeometry.ts — shared BIM geometry calculation functions.
 *
 * Pure functions (no Babylon.js / Three.js dependencies).
 * Used by both BabylonViewer and Ara3DViewer.
 *
 * Coordinate system (BIM standard):
 *   X → East, Y → North, Z → Up (elevation)
 *   All values in mm unless noted.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { WINDOW_TYPES } from '@/lib/elementLibrary';
import { parseAxes } from '@/lib/utils';
import { evalProp, resolveFormulaContext } from '@/lib/formulaUtils';
import type { FormulaContext } from '@/lib/formulaUtils';

// ─── Node local transform ─────────────────────────────────────────────────────

/**
 * Read the local transform parameters from a node's properties.
 * All values are stored in BIM units (mm for translation, degrees for rotation).
 *
 * BIM axes for translation:
 *   translate_x = East (BIM X), translate_y = North (BIM Y), translate_z = Up (BIM Z)
 * Rotation axes (applied in XYZ order around local object axes):
 *   rotate_x = tilt around East (e.g. lean forward), rotate_y = spin around Up axis (plan rotation),
 *   rotate_z = roll around North axis
 */
export interface NodeLocalTransform {
  tx: number; ty: number; tz: number; // mm
  rx: number; ry: number; rz: number; // degrees
}

export function getNodeLocalTransform(n: BubbleGraphNode): NodeLocalTransform {
  const p = n.properties;
  return {
    tx: Number(p.obj_translate_x ?? 0),
    ty: Number(p.obj_translate_y ?? 0),
    tz: Number(p.obj_translate_z ?? 0),
    rx: Number(p.obj_rotate_x    ?? 0),
    ry: Number(p.obj_rotate_y    ?? 0),
    rz: Number(p.obj_rotate_z    ?? 0),
  };
}

/** True if the node has any non-zero local transform. */
export function hasNodeLocalTransform(n: BubbleGraphNode): boolean {
  const t = getNodeLocalTransform(n);
  return t.tx !== 0 || t.ty !== 0 || t.tz !== 0 || t.rx !== 0 || t.ry !== 0 || t.rz !== 0;
}

// ─── Window library lookup ────────────────────────────────────────────────────

const _windowTypeMap = new Map(WINDOW_TYPES.map((w) => [w.id, w]));

/**
 * Resolve opening dimensions for a window/door node.
 * Priority: explicit node properties → window_type library lookup → hardcoded defaults.
 */
/**
 * Resolve opening dimensions for a window/door node.
 * Priority: explicit node properties (evaluated as formula with ctx) → window_type library → defaults.
 *
 * @param ctx  Optional FormulaContext (wall topology variables) injected into formulas.
 */
export function resolveOpeningDims(
  node: BubbleGraphNode,
  ctx?: Partial<FormulaContext>,
): {
  width: number; height: number; sillHeight: number; frameDepth: number;
} {
  const isDoor = node.type === 'door';
  const libEntry = _windowTypeMap.get(String(node.properties.window_type ?? ''));
  const w    = node.properties.width       != null
             ? evalProp(node.properties.width       as string | number, ctx, libEntry ? libEntry.width_mm   : isDoor ? 900  : 1000)
             : libEntry ? libEntry.width_mm   : isDoor ? 900  : 1000;
  const h    = node.properties.height      != null
             ? evalProp(node.properties.height      as string | number, ctx, libEntry ? libEntry.height_mm  : isDoor ? 2100 : 1200)
             : libEntry ? libEntry.height_mm  : isDoor ? 2100 : 1200;
  const sill = node.properties.sill_height != null
             ? evalProp(node.properties.sill_height as string | number, ctx, libEntry ? libEntry.sill_height_mm : isDoor ? 0 : 900)
             : libEntry ? libEntry.sill_height_mm : isDoor ? 0 : 900;
  const fd   = node.properties.frame_depth != null
             ? evalProp(node.properties.frame_depth as string | number, ctx, libEntry ? libEntry.depth_mm : 100)
             : libEntry ? libEntry.depth_mm : 100;
  return { width: w, height: h, sillHeight: sill, frameDepth: fd };
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const MM = 0.001; // 1 mm → meters

// ─── Colors ───────────────────────────────────────────────────────────────────

/** diffuseColor per node type [r, g, b] in 0–1 */
export const NODE_COLOR: Record<string, [number, number, number]> = {
  column:     [0.23, 0.51, 0.96],
  beam:       [0.06, 0.73, 0.51],
  wall:       [0.96, 0.74, 0.07],
  slab:       [0.55, 0.37, 0.98],
  foundation: [0.94, 0.27, 0.27],
  window:     [0.22, 0.74, 0.97],
  door:       [0.98, 0.60, 0.09],
  room:       [0.08, 0.72, 0.65],
  shell:      [0.66, 0.33, 0.98],
  covering:   [0.96, 0.26, 0.36],
  roof:       [0.76, 0.25, 0.05],
  roof_ridge: [0.60, 0.20, 0.07],
  roof_eave:  [0.70, 0.35, 0.12],
  roof_hip:   [0.60, 0.20, 0.07],
  rafter:     [0.85, 0.47, 0.02],
  hip_rafter: [0.70, 0.33, 0.04],
  valley_rafter: [0.66, 0.28, 0.10],
  ridge_beam: [0.57, 0.25, 0.05],
  wall_plate: [0.63, 0.38, 0.03],
  purlin:     [0.80, 0.52, 0.10],
  tie_beam:   [0.50, 0.30, 0.10],
  collar_tie: [0.52, 0.32, 0.12],
  post:       [0.47, 0.21, 0.06],
  roof_valley: [0.55, 0.18, 0.06],
  roof_break: [0.62, 0.30, 0.10],
  skylight:   [0.22, 0.74, 0.97],
  dormer:     [0.96, 0.62, 0.04],
  // roof detail layers
  membrane:   [0.30, 0.35, 0.42],
  sheathing:  [0.72, 0.55, 0.32],
  insulation: [0.98, 0.85, 0.40],
  counter_batten: [0.74, 0.52, 0.22],
  batten:     [0.82, 0.60, 0.28],
  fascia:     [0.60, 0.42, 0.24],
  barge_board:[0.58, 0.40, 0.22],
  soffit:     [0.80, 0.72, 0.60],
  ridge_cap:  [0.70, 0.28, 0.20],
  hip_cap:    [0.66, 0.26, 0.18],
  valley_flashing: [0.62, 0.66, 0.72],
  gutter:     [0.62, 0.66, 0.72],
  downpipe:   [0.58, 0.62, 0.68],
  snow_guard: [0.50, 0.54, 0.60],
  ax:         [0.58, 0.63, 0.75],
  void:       [0.98, 0.45, 0.09],
  object:     [0.55, 0.37, 0.96],  // library objects — purple
};

// ─── Dimension parsers ────────────────────────────────────────────────────────
// Type string numbers are in centimetres (BIM convention: C25x25 = 25 cm = 250 mm).
// Multiply by 0.01 to convert cm → metres.

export function parseColumnDims(t: string): { w: number; d: number; circular: boolean } {
  // Circular column: CR{diameter_cm}  e.g. CR30 = ∅30cm column
  const circ = t?.match(/^[Cc][Rr](\d+(?:\.\d+)?)$/);
  if (circ) { const diam = +circ[1] * 0.01; return { w: diam, d: diam, circular: true }; }
  // Rectangular column: C{w}x{d}  e.g. C25x25, C30x50
  const rect = t?.match(/[Cc](\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/);
  return rect ? { w: +rect[1] * 0.01, d: +rect[2] * 0.01, circular: false } : { w: 0.25, d: 0.25, circular: false };
}

export function parseBeamDims(t: string): { bw: number; bh: number } {
  const m = t?.match(/[Bb](\d+)x(\d+)/);
  return m ? { bw: +m[1] * 0.01, bh: +m[2] * 0.01 } : { bw: 0.30, bh: 0.60 };
}

export function parseWallThickness(t: string): number {
  if (/separator/i.test(t ?? '')) return 0.01; // 1 cm visual thickness for separator
  const m = t?.match(/[Ww](\d+)/);
  return m ? +m[1] * 0.01 : 0.20;
}

/** True when the wall type is a zero-thickness logical separator. */
export function isWallSeparator(t: string): boolean {
  return /separator/i.test(t ?? '');
}

/**
 * Return the half-size (mm) of an endpoint node to use as automatic start/end
 * offset for beams and walls when no explicit offset has been set by the user.
 *
 * - ax node with has_column: true → half the larger column dimension
 * - column node → half the larger column dimension
 * - wall node → half the wall thickness
 * - all others → 0
 */
export function getEndpointAutoOffset(
  endNode: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
): number {
  if (endNode.type === 'column') {
    const { w, d } = parseColumnDims(String(endNode.properties.column_type ?? 'C25x25'));
    return Math.max(w, d) / 2 * 1000; // metres → mm
  }
  if (endNode.type === 'ax') {
    const hasCol = String(endNode.properties.has_column ?? '').toLowerCase() === 'true';
    if (hasCol) {
      const { w, d } = parseColumnDims(String(endNode.properties.column_type ?? 'C25x25'));
      return Math.max(w, d) / 2 * 1000;
    }
  }
  if (endNode.type === 'wall') {
    const th = parseWallThickness(String(endNode.properties.wall_type ?? 'W20'));
    return th / 2 * 1000;
  }
  void nodeMap;
  return 0;
}

export function parseSlabThickness(t: string): number {
  const m = t?.match(/(?:[Ss][Ll][Aa][Bb]|[Ss])(\d+)/);
  return m ? +m[1] * 0.01 : 0.15;
}

/**
 * Returns slab thickness in METRES for a node.
 * Checks `slab_custom_mm` property first (custom override), then falls back to
 * the `slab_type` string (e.g. 'SLAB15').
 */
export function getNodeSlabThickness(n: BubbleGraphNode): number {
  const customMm = Number(n.properties.slab_custom_mm ?? 0);
  if (customMm > 0) return customMm * 0.001;
  return parseSlabThickness(String(n.properties.slab_type ?? 'SLAB15'));
}

// ─── Storey helpers ───────────────────────────────────────────────────────────

/** Return { bot, top } elevation (mm) for a node's parent storey. */
export function getStoreyBand(
  n: BubbleGraphNode,
  map: Map<string, BubbleGraphNode>,
): { bot: number; top: number } {
  const p = n.parentId ? map.get(n.parentId) : undefined;
  return p
    ? { bot: Number(p.properties.bottomElevation ?? 0), top: Number(p.properties.topElevation ?? 3000) }
    : { bot: 0, top: 3000 };
}

/**
 * Walk the parent chain of a node until we find a storey ancestor.
 * Handles any depth: storey → wall → window, storey → room → covering, etc.
 *
 * Returns the storey node ID, or `undefined` if the node has no storey ancestor.
 */
export function resolveStoreyId(
  node: BubbleGraphNode,
  map: Map<string, BubbleGraphNode>,
): string | undefined {
  const visited = new Set<string>();
  let current: BubbleGraphNode | undefined = node;
  while (current) {
    if (visited.has(current.id)) break;          // cycle guard
    visited.add(current.id);
    if (current.type === 'storey') return current.id;
    if (!current.parentId) return undefined;
    current = map.get(current.parentId);
  }
  return undefined;
}

// ─── Position helpers ─────────────────────────────────────────────────────────

/**
 * Real BIM plan position (mm) of an ax node.
 * Source of truth: parent storey's axesX[gridX] / axesY[gridY].
 * node.x / node.y are graph-canvas positions — ignored here.
 */
export function getAxRealPos(
  n: BubbleGraphNode,
  map: Map<string, BubbleGraphNode>,
): { x: number; y: number } {
  // Secondary ax nodes (e.g. wall endpoints drawn from floor plan) store bimX/bimY directly
  if (n.properties.bimX != null && n.properties.bimY != null) {
    return { x: Number(n.properties.bimX), y: Number(n.properties.bimY) };
  }
  const storey = n.parentId ? map.get(n.parentId) : undefined;
  const axesX = parseAxes(storey?.properties?.axesX).slice().sort((a, b) => a - b);
  const axesY = parseAxes(storey?.properties?.axesY).slice().sort((a, b) => a - b);
  return {
    x: axesX[Number(n.properties.gridX ?? 0)] ?? 0,
    y: axesY[Number(n.properties.gridY ?? 0)] ?? 0,
  };
}

/**
 * Real BIM plan position (mm) of any node.
 * Ax nodes → from storey axesX/Y grid.
 * All others → n.x / n.y are already BIM mm coords.
 */
export function getNodeBimPos(
  n: BubbleGraphNode,
  map: Map<string, BubbleGraphNode>,
): { x: number; y: number } {
  if (n.type === 'ax') return getAxRealPos(n, map);
  return { x: n.x, y: n.y };
}

// ─── Grip position helpers ────────────────────────────────────────────────────
/** Normalized offset factors for each of the 9 grip indices (matches axGrips() in graph editor). */
const GRIP_OX = [0, -1, 0, 1, -1, 1, -1, 0, 1];
const GRIP_OY = [0, -1, -1, -1,  0, 0,  1, 1, 1];

/** Parse column type string → half-dimensions in BIM mm (same formula as graph-editor parseColHalfDims). */
function colHalfDimsMm(colType: string): { hw: number; hd: number } {
  const rect = colType.match(/^[Cc](\d+)x(\d+)$/);
  if (rect) return { hw: Number(rect[1]) * 5, hd: Number(rect[2]) * 5 };
  const circ = colType.match(/^[Cc][Rr](\d+)$/);
  if (circ) { const r = Number(circ[1]) * 5; return { hw: r, hd: r }; }
  return { hw: 125, hd: 125 }; // default C25×25
}

/**
 * Real BIM plan position (mm) of a specific grip on an ax node.
 * Grip 0 = column center. Grips 1–8 = faces/corners of the cross-section.
 * For non-ax nodes (or grip 0) returns the normal BIM node position.
 */
export function getGripBimPos(
  n: BubbleGraphNode,
  gripIdx: number | undefined,
  map: Map<string, BubbleGraphNode>,
): { x: number; y: number } {
  const base = getNodeBimPos(n, map);
  if (!gripIdx || gripIdx === 0 || n.type !== 'ax') return base;
  const { hw, hd } = colHalfDimsMm(String(n.properties.column_type ?? 'C25x25'));
  return {
    x: base.x + (GRIP_OX[gripIdx] ?? 0) * hw,
    y: base.y + (GRIP_OY[gripIdx] ?? 0) * hd,
  };
}

/**
 * Like getConnectedNodes but also returns the grip index stored on the edge for each endpoint.
 * For an edge { from: A, to: B, fromGrip: 2, toGrip: 5 } connected to nodeId=A → B has gripIdx 5.
 */
export function getConnectedNodesWithGrips(
  nodeId: string,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): Array<{ node: BubbleGraphNode; gripIdx: number }> {
  return edges
    .filter((e) => e.from === nodeId || e.to === nodeId)
    .map((e) => {
      const connId = e.from === nodeId ? e.to : e.from;
      const grip   = e.from === nodeId ? (e.toGrip ?? 0) : (e.fromGrip ?? 0);
      const node   = nodeMap.get(connId);
      return node ? { node, gripIdx: grip } : null;
    })
    .filter((x): x is { node: BubbleGraphNode; gripIdx: number } => x !== null);
}

/**
 * Return all nodes directly connected to nodeId via any edge.
 */
export function getConnectedNodes(
  nodeId: string,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): BubbleGraphNode[] {
  return edges
    .filter((e) => e.from === nodeId || e.to === nodeId)
    .map((e) => nodeMap.get(e.from === nodeId ? e.to : e.from))
    .filter((n): n is BubbleGraphNode => n !== undefined);
}

/**
 * The ax/column anchors wired to a node, in the order the edges were created —
 * deduped, edge direction ignored. This is the ordering contract every contour
 * gesture relies on (roof outline, stair boundary, sweep guide line): the user
 * connects points in sequence and the sequence IS the polyline.
 */
export function getOrderedAnchorNodes(
  nodeId: string,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): BubbleGraphNode[] {
  const out: BubbleGraphNode[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from !== nodeId && e.to !== nodeId) continue;
    const otherId = e.from === nodeId ? e.to : e.from;
    if (seen.has(otherId)) continue;
    seen.add(otherId);
    const other = nodeMap.get(otherId);
    if (other && (other.type === 'ax' || other.type === 'column')) out.push(other);
  }
  return out;
}

// ─── Opening helpers ──────────────────────────────────────────────────────────

/**
 * Describes where an opening (window/door) sits along a wall.
 * All lengths in mm (except tS / tE which are metres after conversion).
 */
export interface OpeningInfo {
  node: BubbleGraphNode;
  distFromStart: number; // mm — left edge of opening along wall centre-line
  width: number;         // mm
  height: number;        // mm
  sillHeight: number;    // mm above storey bottom
  frameDepth: number;    // mm (toc depth = wall thickness)
}

/**
 * Collect all window/door nodes connected to a wall, compute their offsets,
 * and return sorted OpeningInfo list.
 */
export function collectOpenings(
  wallNode: BubbleGraphNode,
  wallLen: number, // effective wall length in mm
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): OpeningInfo[] {
  const results: OpeningInfo[] = [];

  // Build topology context for this wall so formulas in opening properties can
  // reference wall_length, room_area, storey_height, etc.
  const wallCtx = resolveFormulaContext(wallNode, edges, nodeMap);
  // Override wall_length with the effective length (post-offset) already computed by the caller
  const ctx: Partial<FormulaContext> = { ...wallCtx, wall_length: wallLen };

  /**
   * Expand a single opening descriptor into `count` evenly-spaced instances.
   *
   * count = 1 (default):
   *   `rawOffset` positions the single window (left edge from wall start).
   *   Empty/null → centred on wall.
   *
   * count > 1, spacing = null (auto):
   *   Wall divided into (count + 1) equal segments; each window centred in its
   *   segment.  `rawOffset` shifts the whole group: positive → rightward.
   *   Empty/null → group is auto-centred on the wall.
   *
   * count > 1, spacing = G mm (clear gap between adjacent window edges):
   *   Windows are placed at a fixed edge-to-edge gap G.
   *   Total group width = count * W + (count - 1) * G.
   *   `rawOffset` = left edge of the first window from wall start.
   *   Empty/null → group auto-centred.
   *
   *   Layout: wall_start ... groupStart [W] G [W] G ... [W] ... wall_end
   */
  function pushExpanded(
    node: BubbleGraphNode,
    w: number,
    h: number,
    sill: number,
    fd: number,
    count: number,
    rawOffset: unknown,
    rawSpacing: unknown,
  ): void {
    if (count <= 1) {
      const dist = (rawOffset === null || rawOffset === undefined || rawOffset === '')
        ? (wallLen - w) / 2
        : Math.max(0, evalProp(rawOffset as string | number, ctx, (wallLen - w) / 2));
      results.push({ node, distFromStart: dist, width: w, height: h, sillHeight: sill, frameDepth: fd });
      return;
    }

    // Resolve explicit clear-gap between windows (null = auto-distribute)
    const hasSpacing = rawSpacing !== null && rawSpacing !== undefined && rawSpacing !== '';
    const gap: number | null = hasSpacing
      ? Math.max(0, evalProp(rawSpacing as string | number, ctx, 0))
      : null;

    if (gap === null) {
      // ── Auto-distribution: equal spacing = wallLen / (count + 1) ─────────
      const segLen = wallLen / (count + 1);
      // rawOffset shifts the whole group's centre anchor
      const baseCentreShift = (rawOffset === null || rawOffset === undefined || rawOffset === '')
        ? 0
        : evalProp(rawOffset as string | number, ctx, 0) - wallLen / 2;
      for (let i = 0; i < count; i++) {
        const centerT = segLen * (i + 1) + baseCentreShift;
        const dist    = Math.max(0, centerT - w / 2);
        results.push({ node, distFromStart: dist, width: w, height: h, sillHeight: sill, frameDepth: fd });
      }
    } else {
      // ── Fixed gap: group_width = count*W + (count-1)*gap ─────────────────
      const groupWidth = count * w + (count - 1) * gap;
      const groupStart = (rawOffset === null || rawOffset === undefined || rawOffset === '')
        ? Math.max(0, (wallLen - groupWidth) / 2)
        : Math.max(0, evalProp(rawOffset as string | number, ctx, Math.max(0, (wallLen - groupWidth) / 2)));
      for (let i = 0; i < count; i++) {
        const dist = groupStart + i * (w + gap);
        results.push({ node, distFromStart: dist, width: w, height: h, sillHeight: sill, frameDepth: fd });
      }
    }
  }

  // ── 1. Edge-connected window/door nodes ───────────────────────────────────
  for (const e of edges) {
    if (e.from !== wallNode.id && e.to !== wallNode.id) continue;
    const otherId = e.from === wallNode.id ? e.to : e.from;
    const other = nodeMap.get(otherId);
    if (!other || (other.type !== 'window' && other.type !== 'door')) continue;

    const { width: w, height: h, sillHeight: sill, frameDepth: fd } = resolveOpeningDims(other, ctx);
    const count = Math.max(1, Math.round(Number(other.properties.count ?? 1)));
    pushExpanded(other, w, h, sill, fd, count, other.properties.offset, other.properties.spacing);
  }

  // ── 2. Inline windows from wall.properties.windows (has_windows = "True") ──
  const hasW = wallNode.properties.has_windows === 'True' || wallNode.properties.has_windows === true;
  if (hasW) {
    try {
      const rawWin = String(wallNode.properties.windows ?? '[]').trim();
      const wList = JSON.parse(rawWin || '[]') as Array<Record<string, unknown>>;
      wList.forEach((w, idx) => {
        // Synthesize a virtual BubbleGraphNode so resolveOpeningDims works unchanged
        const virtualNode: BubbleGraphNode = {
          id: String(w.id ?? `inl_win_${wallNode.id}_${idx}`),
          type: 'window', name: 'Window',
          x: 0, y: 0, z: 0,
          properties: {
            window_type:  w.window_type  ?? 'W-FIX-100x120',
            opening:      w.opening      ?? undefined,
            width:        w.width        ?? undefined,
            height:       w.height       ?? undefined,
            sill_height:  w.sill_height  ?? undefined,
            frame_depth:  w.frame_depth  ?? undefined,
            cut_depth:    w.cut_depth    ?? undefined,
            flip_across:  w.flip_across  ?? false,
            flip_along:   w.flip_along   ?? false,
            offset:       w.wall_offset  ?? undefined,
          },
        };
        const { width: vw, height: vh, sillHeight: vsill, frameDepth: vfd } = resolveOpeningDims(virtualNode, ctx);
        const count = Math.max(1, Math.round(Number(w.count ?? 1)));
        pushExpanded(virtualNode, vw, vh, vsill, vfd, count, virtualNode.properties.offset, w.spacing);
      });
    } catch { /* ignore malformed JSON */ }
  }

  // ── 3. Inline doors from wall.properties.doors (has_doors = "True") ────────
  const hasD = wallNode.properties.has_doors === 'True' || wallNode.properties.has_doors === true;
  if (hasD) {
    try {
      const rawDoor = String(wallNode.properties.doors ?? '[]').trim();
      const dList = JSON.parse(rawDoor || '[]') as Array<Record<string, unknown>>;
      dList.forEach((d, idx) => {
        const virtualNode: BubbleGraphNode = {
          id: String(d.id ?? `inl_door_${wallNode.id}_${idx}`),
          type: 'door', name: 'Door',
          x: 0, y: 0, z: 0,
          properties: {
            door_type:   d.door_type   ?? 'D-SWING-90x210',
            width:       d.width       ?? undefined,
            height:      d.height      ?? undefined,
            sill_height: d.sill_height ?? 0,
            frame_depth: d.frame_depth ?? undefined,
            cut_depth:   d.cut_depth   ?? undefined,
            flip_across: d.flip_across ?? false,
            flip_along:  d.flip_along  ?? false,
            swing:       d.swing       ?? 'left',
            offset:      d.wall_offset ?? undefined,
          },
        };
        const { width: vw, height: vh, sillHeight: vsill, frameDepth: vfd } = resolveOpeningDims(virtualNode, ctx);
        const count = Math.max(1, Math.round(Number(d.count ?? 1)));
        pushExpanded(virtualNode, vw, vh, vsill, vfd, count, virtualNode.properties.offset, d.spacing);
      });
    } catch { /* ignore malformed JSON */ }
  }

  return results.sort((a, b) => a.distFromStart - b.distFromStart);
}

// ─── Span / wall geometry descriptors ────────────────────────────────────────
// These are engine-independent descriptors. Each viewer turns them into meshes.

/**
 * Compute the effective start/end points for a beam or similar span element,
 * applying explicit offsets (panel-written camelCase takes priority over
 * snake_case nodeLibrary defaults) and auto-trimming from connected endpoint
 * node sizes when no explicit offset has been set.
 *
 * Returns { sx, sy, ex, ey } in BIM mm.
 */
export function calcSpanEffectiveEnds(
  elementNode: BubbleGraphNode,
  pA: { x: number; y: number },
  pB: { x: number; y: number },
  endNodeA: BubbleGraphNode,
  endNodeB: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
): { sx: number; sy: number; ex: number; ey: number } {
  const dx = pB.x - pA.x, dy = pB.y - pA.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return { sx: pA.x, sy: pA.y, ex: pB.x, ey: pB.y };
  const ux = dx / len, uy = dy / len;

  const osRaw = elementNode.properties.offsetStart ?? elementNode.properties.offset_start;
  const oeRaw = elementNode.properties.offsetEnd   ?? elementNode.properties.offset_end;
  const os = osRaw != null ? Number(osRaw) : getEndpointAutoOffset(endNodeA, nodeMap);
  const oe = oeRaw != null ? Number(oeRaw) : getEndpointAutoOffset(endNodeB, nodeMap);

  return {
    sx: pA.x + ux * os, sy: pA.y + uy * os,
    ex: pB.x - ux * oe, ey: pB.y - uy * oe,
  };
}

export interface SpanBoxDesc {
  /** Babylon XZ / Three XZ start (metres) */
  ax: number; az: number;
  /** Babylon XZ / Three XZ end (metres) */
  bx: number; bz: number;
  /** Cross-section depth (metres, perpendicular to span) */
  width: number;
  /** Vertical height (metres) */
  height: number;
  /** Babylon Y / Three Y of the bottom of the box (metres) */
  baseY: number;
}

export interface WallSegDesc extends SpanBoxDesc {
  /** position along wall from start (metres) */
  tStart: number;
  tEnd: number;
}

export interface OpeningMeshDesc {
  isDoor: boolean;
  /** The actual window/door node — used to read window_type, etc. */
  node: BubbleGraphNode;
  /** XZ centre of opening (metres) */
  cx: number; cz: number;
  /** unit direction along wall */
  ux: number; uz: number;
  /** unit normal into wall (perpendicular) */
  nx: number; nz: number;
  wallThick: number; // metres
  botY: number;      // metres — storey bottom
  tS: number;        // metres from wall start
  oW: number;        // metres — opening width
  oH: number;        // metres — opening height
  sill: number;      // metres — sill height above botY
  PROFILE: number;   // metres — frame profile width
}

// ─── Wall geometry calculator ─────────────────────────────────────────────────

export interface WallGeometry {
  /** Full-wall or per-segment solid boxes */
  solidSegs: WallSegDesc[];
  /** Openings to render (frame + glass/door + void) */
  openings: OpeningMeshDesc[];
  /** Optional beam along top of wall */
  beamDesc?: SpanBoxDesc;
  /** Effective start/end in metres (after endpoint offsets) */
  sxM: number; szM: number; exM: number; ezM: number;
  wallThick: number; // metres
  botM: number;      // metres
  /** Wall height in metres */
  wallH: number;
  /** Endpoint inset offsets in metres (0 = plain node/no column). Used to compute 2D plan extension. */
  osM: number; oeM: number;
  /** Resolved wall join info (if joins were computed). Contains face corner coords for 2D rendering. */
  joinResult?: WallJoinResult;
  /**
   * Horizontal footprint polygon in BIM mm (X=East, Y=North), CCW order.
   * Incorporates join geometry (miter/butt corners) directly as polygon vertices.
   * 4 vertices for square_off, 4–6+ for miter/butt joins.
   * Use with `wallHorizontalProfileMesh()` for clean join geometry without CSG.
   */
  footprint: Array<{ x: number; y: number }>;
}

// ─── Circular (arc) wall geometry ─────────────────────────────────────────────

/**
 * Tessellate a circular arc wall into straight segments and compute its
 * WallGeometry (footprint, openings, solid segments, etc.).
 *
 * When both endpoints are the same node (chord length ≈ 0), the arc is a full
 * circle centred on that node. Otherwise the arc subtends the shorter angle.
 *
 * The footprint polygon traces the outer arc then the inner arc reversed (CCW).
 * Openings are distributed along the arc length (same logic as straight walls).
 */
function calcCircularWallGeometry(
  wn: BubbleGraphNode,
  pA: { x: number; y: number },
  pB: { x: number; y: number },
  chordMm: number,
  arcRadiusMm: number,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): WallGeometry | null {
  const R = Math.abs(arcRadiusMm);
  const th = parseWallThickness(String(wn.properties.wall_type ?? 'W20'));
  const hwMm = th * 1000 / 2; // half-thickness in mm
  const { bot, top } = getStoreyBand(wn, nodeMap);
  // Masonry stops under its ring beam (see calcWallGeometry) — height = storey − beam.
  const hasBeamC  = String(wn.properties.has_beam ?? '').toLowerCase() === 'true';
  const beamDimsC = hasBeamC ? parseBeamDims(String(wn.properties.beam_section ?? 'B20x30')) : null;
  const wallH = wn.properties.height != null
    ? Number(wn.properties.height)
    : Math.max(0, top - bot - (beamDimsC ? beamDimsC.bh * 1000 : 0));
  const botM = bot * MM;

  // ── Compute arc centre & angles ──────────────────────────────────────────
  let cx: number, cy: number;
  let angA: number, angB: number, dAng: number;
  const SEGS_PER_RAD = 12 / Math.PI; // ~12 segments per 180°

  if (chordMm < 1) {
    // Full circle: both endpoints are the same node
    cx = pA.x;
    cy = pA.y;
    angA = 0;
    dAng = 2 * Math.PI;
  } else {
    const Rc = Math.max(R, chordMm / 2 + 0.1);
    const mx = (pA.x + pB.x) / 2, my = (pA.y + pB.y) / 2;
    const cdx = (pB.x - pA.x) / chordMm, cdy = (pB.y - pA.y) / chordMm;
    const px = -cdy, py = cdx; // perpendicular left
    const h = Math.sqrt(Rc * Rc - (chordMm / 2) ** 2);
    const sign = arcRadiusMm >= 0 ? 1 : -1;
    cx = mx + sign * h * px;
    cy = my + sign * h * py;

    angA = Math.atan2(pA.y - cy, pA.x - cx);
    angB = Math.atan2(pB.y - cy, pB.x - cx);
    dAng = angB - angA;
    while (dAng > Math.PI) dAng -= 2 * Math.PI;
    while (dAng < -Math.PI) dAng += 2 * Math.PI;
  }

  const arcLenMm = Math.abs(dAng) * R;
  if (arcLenMm < 1) return null;

  const N = Math.max(6, Math.ceil(Math.abs(dAng) * SEGS_PER_RAD));

  // Build centre-line points along arc (BIM mm)
  const arcPts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= N; i++) {
    const a = angA + (dAng * i) / N;
    arcPts.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
  }

  // ── Build footprint (outer arc → inner arc reversed, CCW) ────────────────
  const outerPts: Array<{ x: number; y: number }> = [];
  const innerPts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= N; i++) {
    const a = angA + (dAng * i) / N;
    const cos = Math.cos(a), sin = Math.sin(a);
    // Outer = centre + (R + hw) in radial direction
    // Inner = centre + (R - hw) in radial direction
    // For CCW arc with positive radius, outer is away from centre
    outerPts.push({ x: cx + (R + hwMm) * cos, y: cy + (R + hwMm) * sin });
    innerPts.push({ x: cx + (R - hwMm) * cos, y: cy + (R - hwMm) * sin });
  }
  // CCW: outer start→end, then inner end→start
  const footprint = [...outerPts, ...innerPts.reverse()];

  // ── Bounding box for sxM/szM/exM/ezM (used as effective start/end) ──────
  // Use first and last arc centre-line points as nominal start/end
  const sxMm = arcPts[0].x, szMm = arcPts[0].y;
  const exMm = arcPts[N].x, ezMm = arcPts[N].y;
  const sxM = sxMm * MM, szM = -szMm * MM;
  const exM = exMm * MM, ezM = -ezMm * MM;

  // ── Openings along arc ───────────────────────────────────────────────────
  const openingInfos = collectOpenings(wn, arcLenMm, edges, nodeMap);
  const solidSegs: WallSegDesc[] = [];
  const openings: OpeningMeshDesc[] = [];

  // Helper: get arc centre-line position and tangent at distance `d` (mm) from start
  function arcPosAt(dMm: number): { x: number; y: number; tx: number; ty: number; nx: number; ny: number } {
    const a = angA + dAng * (dMm / arcLenMm);
    const cos = Math.cos(a), sin = Math.sin(a);
    // Tangent: derivative of position w.r.t. angle, normalised
    const tdx = -sin * Math.sign(dAng), tdy = cos * Math.sign(dAng);
    // Normal: perpendicular to tangent, pointing outward (away from centre)
    return { x: cx + R * cos, y: cy + R * sin, tx: tdx, ty: tdy, nx: cos, ny: sin };
  }

  if (openingInfos.length === 0) {
    // Single solid arc — use segmented approach for solid segs
    for (let i = 0; i < N; i++) {
      const ap = arcPts[i], bp = arcPts[i + 1];
      const tS = (arcLenMm * i / N) * MM;
      const tE = (arcLenMm * (i + 1) / N) * MM;
      solidSegs.push({
        ax: ap.x * MM, az: -ap.y * MM,
        bx: bp.x * MM, bz: -bp.y * MM,
        width: th, height: wallH * MM, baseY: botM,
        tStart: tS, tEnd: tE,
      });
    }
  } else {
    // Sort openings along arc
    const sorted = openingInfos.map((o) => ({
      ...o,
      tS: Math.max(0, o.distFromStart * MM),
      tE: Math.min(arcLenMm * MM, (o.distFromStart + o.width) * MM),
    })).filter((o) => o.tE > o.tS);

    // Build solid segments in gaps + opening descriptors
    let cursor = 0; // metres along arc
    const arcLenM = arcLenMm * MM;

    for (let i = 0; i <= sorted.length; i++) {
      const gapStart = cursor;
      const gapEnd = i < sorted.length ? sorted[i].tS : arcLenM;

      // Solid gap: tessellate into arc sub-segments
      if (gapEnd - gapStart > 1e-6) {
        const nSub = Math.max(1, Math.round(N * (gapEnd - gapStart) / arcLenM));
        for (let j = 0; j < nSub; j++) {
          const t0 = gapStart + (gapEnd - gapStart) * j / nSub;
          const t1 = gapStart + (gapEnd - gapStart) * (j + 1) / nSub;
          const p0 = arcPosAt(t0 / MM); // convert m back to mm for arcPosAt
          const p1 = arcPosAt(t1 / MM);
          solidSegs.push({
            ax: p0.x * MM, az: -p0.y * MM,
            bx: p1.x * MM, bz: -p1.y * MM,
            width: th, height: wallH * MM, baseY: botM,
            tStart: t0, tEnd: t1,
          });
        }
      }

      if (i < sorted.length) {
        const op = sorted[i];
        const sill = op.sillHeight * MM;
        const openH = op.height * MM;
        const lintelH = wallH * MM - sill - openH;

        // Sill and lintel sub-segments
        const opMidMm = (op.distFromStart + op.width / 2);
        const nOpSub = Math.max(1, Math.round(N * (op.tE - op.tS) / arcLenM));
        if (sill > 1e-6) {
          for (let j = 0; j < nOpSub; j++) {
            const t0 = op.tS + (op.tE - op.tS) * j / nOpSub;
            const t1 = op.tS + (op.tE - op.tS) * (j + 1) / nOpSub;
            const p0 = arcPosAt(t0 / MM);
            const p1 = arcPosAt(t1 / MM);
            solidSegs.push({
              ax: p0.x * MM, az: -p0.y * MM,
              bx: p1.x * MM, bz: -p1.y * MM,
              width: th, height: sill, baseY: botM,
              tStart: t0, tEnd: t1,
            });
          }
        }
        if (lintelH > 1e-6) {
          for (let j = 0; j < nOpSub; j++) {
            const t0 = op.tS + (op.tE - op.tS) * j / nOpSub;
            const t1 = op.tS + (op.tE - op.tS) * (j + 1) / nOpSub;
            const p0 = arcPosAt(t0 / MM);
            const p1 = arcPosAt(t1 / MM);
            solidSegs.push({
              ax: p0.x * MM, az: -p0.y * MM,
              bx: p1.x * MM, bz: -p1.y * MM,
              width: th, height: lintelH, baseY: botM + sill + openH,
              tStart: t0, tEnd: t1,
            });
          }
        }

        // Opening mesh descriptor — placed at the arc midpoint of the opening
        const mid = arcPosAt(opMidMm);
        const PROFILE = Math.min(0.06, th * 0.25);
        openings.push({
          isDoor: op.node.type === 'door',
          node: op.node,
          cx: mid.x * MM,
          cz: -mid.y * MM,
          // Tangent direction along wall (BIM→Three: X stays, Y→-Z)
          ux: mid.tx,
          uz: -mid.ty,
          // Normal into wall
          nx: mid.nx,
          nz: -mid.ny,
          wallThick: th,
          botY: botM,
          tS: op.tS,
          oW: op.width * MM,
          oH: op.height * MM,
          sill,
          PROFILE,
        });

        cursor = op.tE;
      }
    }
  }

  // ── Beam ──────────────────────────────────────────────────────────────────
  let beamDesc: SpanBoxDesc | undefined;
  if (beamDimsC) {
    beamDesc = { ax: sxM, az: szM, bx: exM, bz: ezM, width: beamDimsC.bw, height: beamDimsC.bh, baseY: top * MM - beamDimsC.bh };
  }

  return {
    solidSegs, openings, beamDesc,
    sxM, szM, exM, ezM,
    wallThick: th, botM, wallH,
    osM: 0, oeM: 0,
    footprint,
  };
}

/**
 * Pure calculation of all geometry needed for one wall node.
 * Returns engine-independent descriptors; each viewer builds meshes from these.
 *
 * @param joinOverrides  Optional pre-computed join map (from `calcWallJoins`).
 *   When provided, the wall's effective start/end are overridden by the join result.
 */
export function calcWallGeometry(
  wn: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  joinOverrides?: Map<string, WallJoinResult>,
): WallGeometry | null {
  const endpointsRaw = getConnectedNodesWithGrips(wn.id, edges, nodeMap).filter(
    ({ node: n }) => n.type !== 'window' && n.type !== 'door',
  );
  if (endpointsRaw.length < 2) return null;
  const pts = endpointsRaw.map(({ node }) => node); // keep existing pts reference for compat

  const gripA = endpointsRaw[0].gripIdx;
  const gripB = endpointsRaw[1].gripIdx;
  const pA = gripA ? getGripBimPos(pts[0], gripA, nodeMap) : getNodeBimPos(pts[0], nodeMap);
  const pB = gripB ? getGripBimPos(pts[1], gripB, nodeMap) : getNodeBimPos(pts[1], nodeMap);
  const dx = pB.x - pA.x, dy = pB.y - pA.y;
  const wallLenMm = Math.sqrt(dx * dx + dy * dy);

  // ── Circular wall: delegate to arc geometry ────────────────────────────────
  const isCircular = wn.properties.is_circular === 'True' || wn.properties.is_circular === true;
  if (isCircular) {
    const arcRadiusMm = Number(wn.properties.arc_radius ?? 5000);
    if (Math.abs(arcRadiusMm) < 1) return null;
    return calcCircularWallGeometry(wn, pA, pB, wallLenMm, arcRadiusMm, nodeMap, edges);
  }

  if (wallLenMm < 1) return null;

  const ux = dx / wallLenMm, uy = dy / wallLenMm;
  // camelCase (panel-written) takes priority over snake_case (nodeLibrary default).
  // If neither is explicitly set, auto-compute from connected endpoint node sizes.
  // When a grip (non-center) was used, the position is already at the column face → offset = 0.
  const osRaw = wn.properties.offsetStart ?? wn.properties.offset_start;
  const oeRaw = wn.properties.offsetEnd   ?? wn.properties.offset_end;
  const os = osRaw != null ? Number(osRaw) : (gripA ? 0 : getEndpointAutoOffset(pts[0], nodeMap));
  const oe = oeRaw != null ? Number(oeRaw) : (gripB ? 0 : getEndpointAutoOffset(pts[1], nodeMap));

  // Apply join overrides when provided — only override endpoints with non-square_off joins.
  // Match join endpoints to our pA/pB by proximity (ordering may differ).
  const joinResRaw = joinOverrides?.get(wn.id);
  // Interior span (offset-inset) — always used as the reference for opening placement.
  const innerSxMm = pA.x + ux * os;
  const innerSzMm = pA.y + uy * os;
  const innerExMm = pB.x - ux * oe;
  const innerEzMm = pB.y - uy * oe;
  const innerLenMm = wallLenMm - os - oe;

  let sxMm = innerSxMm, szMm = innerSzMm;
  let exMm = innerExMm, ezMm = innerEzMm;
  if (joinResRaw) {
    // Detect if join's start matches our pA or pB (endpoint ordering may differ)
    const dSA = Math.hypot(joinResRaw.startPt.x - sxMm, joinResRaw.startPt.y - szMm);
    const dSB = Math.hypot(joinResRaw.startPt.x - exMm, joinResRaw.startPt.y - ezMm);
    const swapped = dSB < dSA;
    const jStart = swapped ? joinResRaw.endJoin : joinResRaw.startJoin;
    const jEnd   = swapped ? joinResRaw.startJoin : joinResRaw.endJoin;
    const jSPt   = swapped ? joinResRaw.endPt : joinResRaw.startPt;
    const jEPt   = swapped ? joinResRaw.startPt : joinResRaw.endPt;
    if (jStart !== 'square_off') { sxMm = jSPt.x; szMm = jSPt.y; }
    if (jEnd   !== 'square_off') { exMm = jEPt.x; ezMm = jEPt.y; }
  }
  const effLen = Math.sqrt((exMm - sxMm) ** 2 + (ezMm - szMm) ** 2);
  // Offset (in mm) from the join-adjusted start to the interior-span start.
  // Positive → interior start is further along the wall (e.g. butt trim moved start forward).
  // Negative → join start is earlier (e.g. miter extended the wall past the interior start).
  const startOffsetMm = (innerSxMm - sxMm) * ux + (innerSzMm - szMm) * uy;

  const { bot, top } = getStoreyBand(wn, nodeMap);
  const th    = parseWallThickness(String(wn.properties.wall_type ?? 'W20'));
  // A ring beam sits at the top of the storey; the masonry below it is therefore
  // (storey height − beam height) tall, so wall + beam fill the storey exactly
  // and don't overlap. An explicit `height` still wins if the user set one.
  const hasBeam  = String(wn.properties.has_beam ?? '').toLowerCase() === 'true';
  const beamDims = hasBeam ? parseBeamDims(String(wn.properties.beam_section ?? 'B20x30')) : null;
  const beamHMm  = beamDims ? beamDims.bh * 1000 : 0;
  const wallH = wn.properties.height != null
    ? Number(wn.properties.height)
    : Math.max(0, top - bot - beamHMm);

  const sxM = sxMm * MM, szM = -szMm * MM; // szM: BIM Y → Three -Z
  const exM = exMm * MM, ezM = -ezMm * MM; // ezM: BIM Y → Three -Z
  const botM = bot * MM;

  // Openings are placed relative to the interior span (offset-inset), not the join-adjusted span.
  // startOffsetMm shifts them so tS/tE are measured from the join-adjusted wall start.
  const openingInfos = collectOpenings(wn, innerLenMm, edges, nodeMap);

  // Debug: trace opening placement for walls with inline openings
  if ((wn.properties.has_windows === 'True' || wn.properties.has_doors === 'True') && openingInfos.length > 0) {
    const sorted0 = openingInfos.map(o => ({
      tS: Math.max(0, (o.distFromStart + startOffsetMm) * MM),
      tE: Math.min(effLen * MM, (o.distFromStart + o.width + startOffsetMm) * MM),
    }));
    const kept = sorted0.filter(o => o.tE > o.tS).length;
    if (kept === 0) {
      console.warn(`[bimGeo] ${wn.name} openings FILTERED: innerLenMm=${innerLenMm.toFixed(0)}, effLen=${effLen.toFixed(0)}, startOffsetMm=${startOffsetMm.toFixed(1)}, pAy=${pA.y.toFixed(0)}, pBy=${pB.y.toFixed(0)}, sxMmy=${szMm.toFixed(0)}, exMmy=${ezMm.toFixed(0)}, joinStart=${joinResRaw?.startPt.y?.toFixed(0)}, joinEnd=${joinResRaw?.endPt.y?.toFixed(0)}`);
    }
  }

  const solidSegs: WallSegDesc[] = [];
  const openings: OpeningMeshDesc[] = [];

  if (openingInfos.length === 0) {
    solidSegs.push({ ax: sxM, az: szM, bx: exM, bz: ezM, width: th, height: wallH * MM, baseY: botM, tStart: 0, tEnd: effLen * MM });
  } else {
    // Wall direction unit vector in metres
    const wdx = exM - sxM, wdz = ezM - szM;
    const wallLenM = Math.sqrt(wdx * wdx + wdz * wdz);
    const wux = wdx / wallLenM, wuz = wdz / wallLenM;
    // Perpendicular normal
    const wnx = -wuz, wnz = wux;

    const sorted = openingInfos.map((o) => ({
      ...o,
      tS: Math.max(0, (o.distFromStart + startOffsetMm) * MM),
      tE: Math.min(effLen * MM, (o.distFromStart + o.width + startOffsetMm) * MM),
    })).filter((o) => o.tE > o.tS);

    let cursor = 0;

    for (let i = 0; i <= sorted.length; i++) {
      const gapStart = cursor;
      const gapEnd   = i < sorted.length ? sorted[i].tS : effLen * MM;

      if (gapEnd - gapStart > 1e-6) {
        solidSegs.push({ ax: sxM, az: szM, bx: exM, bz: ezM, width: th, height: wallH * MM, baseY: botM, tStart: gapStart, tEnd: gapEnd });
      }

      if (i < sorted.length) {
        const op = sorted[i];
        const sill    = op.sillHeight * MM;
        const openH   = op.height * MM;
        const lintelH = wallH * MM - sill - openH;

        if (sill > 1e-6) {
          solidSegs.push({ ax: sxM, az: szM, bx: exM, bz: ezM, width: th, height: sill, baseY: botM, tStart: op.tS, tEnd: op.tE });
        }
        if (lintelH > 1e-6) {
          solidSegs.push({ ax: sxM, az: szM, bx: exM, bz: ezM, width: th, height: lintelH, baseY: botM + sill + openH, tStart: op.tS, tEnd: op.tE });
        }

        const openingCentreT = op.tS + (op.tE - op.tS) / 2;
        const cx = sxM + wux * openingCentreT;
        const cz = szM + wuz * openingCentreT;
        const PROFILE = Math.min(0.06, th * 0.25);

        openings.push({
          isDoor: op.node.type === 'door',
          node: op.node,
          cx, cz,
          ux: wux, uz: wuz,
          nx: wnx, nz: wnz,
          wallThick: th,
          botY: botM,
          tS: op.tS,
          oW: op.width * MM,
          oH: op.height * MM,
          sill,
          PROFILE,
        });

        cursor = op.tE;
      }
    }
  }

  let beamDesc: SpanBoxDesc | undefined;
  if (beamDims) {
    beamDesc = { ax: sxM, az: szM, bx: exM, bz: ezM, width: beamDims.bw, height: beamDims.bh, baseY: top * MM - beamDims.bh };
  }

  // ── Horizontal footprint polygon (BIM mm, CCW) ────────────────────────────
  // Normal: perpendicular to wall direction, points "right" (outer side).
  const nAx = -uy, nAy = ux; // wall normal in BIM mm coords
  const hw = th * 1000 / 2;  // half-thickness in mm

  // Resolve join corners or fall back to simple rectangular offset.
  let joinResAligned = joinResRaw;
  if (joinResRaw) {
    const dSA = Math.hypot(joinResRaw.startPt.x - innerSxMm, joinResRaw.startPt.y - innerSzMm);
    const dSB = Math.hypot(joinResRaw.startPt.x - innerExMm, joinResRaw.startPt.y - innerEzMm);
    if (dSB < dSA) {
      joinResAligned = {
        ...joinResRaw,
        startJoin: joinResRaw.endJoin, endJoin: joinResRaw.startJoin,
        startPt: joinResRaw.endPt, endPt: joinResRaw.startPt,
        outerStartPt: joinResRaw.outerEndPt, innerStartPt: joinResRaw.innerEndPt,
        outerEndPt: joinResRaw.outerStartPt, innerEndPt: joinResRaw.innerStartPt,
      };
    }
  }

  const jr = joinResAligned;
  const hasJoinStart = jr && jr.startJoin !== 'square_off' && jr.startJoin !== 'none';
  const hasJoinEnd   = jr && jr.endJoin   !== 'square_off' && jr.endJoin   !== 'none';

  // Outer side (right of travel direction): start → end
  const outerStart = hasJoinStart && jr
    ? jr.outerStartPt
    : { x: sxMm + nAx * hw, y: szMm + nAy * hw };
  const outerEnd = hasJoinEnd && jr
    ? jr.outerEndPt
    : { x: exMm + nAx * hw, y: ezMm + nAy * hw };

  // Inner side (left of travel direction): end → start (CCW)
  const innerEnd = hasJoinEnd && jr
    ? jr.innerEndPt
    : { x: exMm - nAx * hw, y: ezMm - nAy * hw };
  const innerStart = hasJoinStart && jr
    ? jr.innerStartPt
    : { x: sxMm - nAx * hw, y: szMm - nAy * hw };

  // CCW polygon: outerStart → outerEnd → innerEnd → innerStart
  const footprint = [outerStart, outerEnd, innerEnd, innerStart];

  return { solidSegs, openings, beamDesc, sxM, szM, exM, ezM, wallThick: th, botM, wallH, osM: os * MM, oeM: oe * MM, joinResult: joinResRaw, footprint };
}

// ─── Wall Join Topology ───────────────────────────────────────────────────────

/**
 * Wall join behaviour at each endpoint.
 *
 * - `auto`       Automatically determined from graph topology:
 *                  L-corner (2 walls ~90°) → miter
 *                  T-junction (stem meets chord) → butt (stem trimmed to chord face)
 *                  End-cap (1 wall) → square_off
 * - `butt`       One wall stops at the other's face (T-join). The wall carrying
 *                this value gets trimmed to the perpendicular wall's face line.
 * - `miter`      Both walls at the junction are trimmed along the angle bisector
 *                (classic 45° corner join for same-thickness walls).
 * - `square_off` The wall end stays flat at its offset-inset position — no trim.
 * - `none`       Alias for square_off (no join processing).
 */
export type WallJoinType = 'auto' | 'butt' | 'miter' | 'square_off' | 'none';

/**
 * Describes the start/end override for a wall after topological join analysis.
 * All values in BIM mm (X east, Y north).
 *
 * Each wall gets TWO join results — one per endpoint.
 * `outerStartPt` / `innerStartPt` define the trimmed outer and inner face corners
 * at the start; same for `outerEndPt` / `innerEndPt`.
 *
 * For simple butt/square_off joins, outer and inner are symmetric (just the
 * perpendicular offset from the centre-line trim point).
 * For miter joins, outer and inner diverge along the bisector.
 */
export interface WallJoinResult {
  wallId: string;
  /** Resolved join type at start endpoint */
  startJoin: WallJoinType;
  /** Resolved join type at end endpoint */
  endJoin: WallJoinType;
  /** Trimmed/extended start point on centreline (BIM mm) */
  startPt: { x: number; y: number };
  /** Trimmed/extended end point on centreline (BIM mm) */
  endPt: { x: number; y: number };
  /** Outer face corners at start (right side of wall dir) — BIM mm */
  outerStartPt: { x: number; y: number };
  innerStartPt: { x: number; y: number };
  /** Outer face corners at end — BIM mm */
  outerEndPt: { x: number; y: number };
  innerEndPt: { x: number; y: number };
}

/**
 * Intersect two infinite lines defined by point+direction (2D, mm units).
 * Returns the intersection point or null if parallel.
 */
function lineIntersect2D(
  p1x: number, p1y: number, d1x: number, d1y: number,
  p2x: number, p2y: number, d2x: number, d2y: number,
): { x: number; y: number } | null {
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((p2x - p1x) * d2y - (p2y - p1y) * d2x) / denom;
  return { x: p1x + t * d1x, y: p1y + t * d1y };
}

/**
 * Compute a wall's axis line endpoints (BIM mm) using full centre-line
 * (no offsets — raw pos of endpoint nodes).
 */
function wallAxisEndpoints(
  wn: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): { pA: { x: number; y: number }; pB: { x: number; y: number }; ux: number; uy: number; len: number; gripA: number; gripB: number } | null {
  const raw = getConnectedNodesWithGrips(wn.id, edges, nodeMap).filter(
    ({ node: n }) => n.type !== 'window' && n.type !== 'door',
  );
  if (raw.length < 2) return null;
  const gripA = raw[0].gripIdx;
  const gripB = raw[1].gripIdx;
  const pA = gripA ? getGripBimPos(raw[0].node, gripA, nodeMap) : getNodeBimPos(raw[0].node, nodeMap);
  const pB = gripB ? getGripBimPos(raw[1].node, gripB, nodeMap) : getNodeBimPos(raw[1].node, nodeMap);
  const dx = pB.x - pA.x, dy = pB.y - pA.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return null;
  return { pA, pB, ux: dx / len, uy: dy / len, len, gripA, gripB };
}

/**
 * Read the explicit wall join type from a wall node's properties for a given endpoint.
 * Property names: `wall_join_start` / `wall_join_end` (or camelCase equivalents).
 * Falls back to `wall_join` (applies to both ends) then `'auto'`.
 */
export function getWallJoinProp(wn: BubbleGraphNode, endpoint: 'start' | 'end'): WallJoinType {
  const specific = endpoint === 'start'
    ? (wn.properties.wallJoinStart ?? wn.properties.wall_join_start)
    : (wn.properties.wallJoinEnd   ?? wn.properties.wall_join_end);
  if (specific != null) return normaliseJoinType(String(specific));
  const global = wn.properties.wallJoin ?? wn.properties.wall_join;
  if (global != null) return normaliseJoinType(String(global));
  return 'auto';
}

function normaliseJoinType(v: string): WallJoinType {
  const s = v.toLowerCase().trim();
  if (s === 'butt')       return 'butt';
  if (s === 'miter' || s === 'mitre') return 'miter';
  if (s === 'square_off' || s === 'squareoff' || s === 'square') return 'square_off';
  if (s === 'none')       return 'none';
  return 'auto';
}

/**
 * Determine the automatic join type at a junction based on graph topology.
 *
 * Rules:
 *   - 1 wall at node → `square_off` (end-cap, no join)
 *   - 2 walls at ~90° (no co-linear partner) → `miter` (L-corner)
 *   - 2+ walls, one pair co-linear → stem walls get `butt`, chord walls get `butt`
 *     (stem trimmed to chord face)
 *   - 3+ walls, complex → `butt` for all (each trimmed to nearest cross-wall face)
 */
function autoJoinType(
  wallIdx: number,
  descs: WallDesc[],
): WallJoinType {
  if (descs.length < 2) return 'square_off';

  const dA = descs[wallIdx];

  // Check if wall A has a co-linear partner (angle < 20°)
  const hasColinear = descs.some((d, j) => {
    if (j === wallIdx) return false;
    return Math.abs(d.ux * dA.ux + d.uy * dA.uy) >= 0.94;
  });

  // Check if any walls are approximately perpendicular (angle 60°–120°)
  const hasCross = descs.some((d, j) => {
    if (j === wallIdx) return false;
    const dot = Math.abs(d.ux * dA.ux + d.uy * dA.uy);
    return dot < 0.94; // more than ~20° apart
  });

  // L-corner: exactly 2 walls, roughly perpendicular, no co-linear partner
  if (descs.length === 2 && !hasColinear && hasCross) {
    return 'miter';
  }

  // T-junction or cross: wall A is the stem if it has no co-linear partner
  // and the other wall(s) do have a co-linear partner (chord).
  if (hasCross) {
    // If this wall is a stem (stops at junction) → butt
    // If this wall is the chord (passes through) → butt (both faces contribute)
    return 'butt';
  }

  // Co-linear only (wall continues through) → square_off at junction
  return 'square_off';
}

interface WallDesc {
  wn: BubbleGraphNode;
  /** Direction vector pointing AWAY from the junction */
  ux: number; uy: number;
  /** Half-thickness (mm) */
  hw: number;
  /** Which endpoint of this wall is at the junction (0=start, 1=end) */
  endIdx: 0 | 1;
  /** Wall endpoint at junction (grip-aware BIM position in mm) */
  jPt: { x: number; y: number };
}

/**
 * Compute face corner points from a centre-line point.
 * `nAx, nAy` is the wall normal (perpendicular to direction, pointing "outer" / right).
 */
function faceCorners(
  cx: number, cy: number, nAx: number, nAy: number, hw: number,
): { outer: { x: number; y: number }; inner: { x: number; y: number } } {
  return {
    outer: { x: cx + nAx * hw, y: cy + nAy * hw },
    inner: { x: cx - nAx * hw, y: cy - nAy * hw },
  };
}

/**
 * Analyse the wall topology at every junction node and compute the correct
 * trimmed footprint for every wall meeting at that node.
 *
 * Supports five join modes per endpoint (auto / butt / miter / square_off / none).
 * When `auto`, the join type is determined from the topology (see `autoJoinType`).
 *
 * The result provides both centre-line trim points AND outer/inner face corners,
 * so viewers can render proper mitered corners in 2D floor plans.
 */
export function calcWallJoins(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): Map<string, WallJoinResult> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallNodes = nodes.filter((n) => n.type === 'wall');

  // ── Step 1: initialise every wall with default offset-inset (square_off) ──
  const results = new Map<string, WallJoinResult>();
  for (const wn of wallNodes) {
    const ax = wallAxisEndpoints(wn, nodeMap, edges);
    if (!ax) continue;
    const endNodesRaw = getConnectedNodesWithGrips(wn.id, edges, nodeMap).filter(
      ({ node: n }) => n.type !== 'window' && n.type !== 'door',
    );
    // Match calcWallGeometry offset precedence: explicit prop → auto → 0
    // When a grip (non-center) is used, offset = 0 (position is already at face).
    const osRaw = wn.properties.offsetStart ?? wn.properties.offset_start;
    const oeRaw = wn.properties.offsetEnd   ?? wn.properties.offset_end;
    const os = osRaw != null ? Number(osRaw) : (ax.gripA ? 0 : getEndpointAutoOffset(endNodesRaw[0]?.node ?? wn, nodeMap));
    const oe = oeRaw != null ? Number(oeRaw) : (ax.gripB ? 0 : getEndpointAutoOffset(endNodesRaw[1]?.node ?? wn, nodeMap));
    const th = parseWallThickness(String(wn.properties.wall_type ?? 'W20'));
    const hw = th * 1000 / 2; // half-thickness in mm
    const nAx = -ax.uy, nAy = ax.ux; // wall normal (perpendicular, right side)

    const sp = { x: ax.pA.x + ax.ux * os, y: ax.pA.y + ax.uy * os };
    const ep = { x: ax.pB.x - ax.ux * oe, y: ax.pB.y - ax.uy * oe };

    const sCorners = faceCorners(sp.x, sp.y, nAx, nAy, hw);
    const eCorners = faceCorners(ep.x, ep.y, nAx, nAy, hw);

    results.set(wn.id, {
      wallId: wn.id,
      startJoin: 'square_off',
      endJoin: 'square_off',
      startPt: sp,
      endPt: ep,
      outerStartPt: sCorners.outer,
      innerStartPt: sCorners.inner,
      outerEndPt: eCorners.outer,
      innerEndPt: eCorners.inner,
    });
  }

  // ── Step 2: build map — junctionNodeId → walls connected to it ──
  // Only structural endpoint types (ax, column, foundation) can form wall
  // junctions. Room, slab, section, shell, beam, etc. are semantic connections
  // and must NOT be treated as structural junction nodes — they would pull
  // all walls in a room into the same junction, mangling join geometry.
  const WALL_JUNCTION_TYPES = new Set(['ax', 'column', 'foundation']);
  const nodeWalls = new Map<string, BubbleGraphNode[]>();
  for (const wn of wallNodes) {
    const endNodes = getConnectedNodes(wn.id, edges, nodeMap).filter(
      (n) => WALL_JUNCTION_TYPES.has(n.type),
    );
    for (const en of endNodes) {
      const arr = nodeWalls.get(en.id) ?? [];
      arr.push(wn);
      nodeWalls.set(en.id, arr);
    }
  }

  // ── Step 3: process each junction node ──
  for (const [nodeId, wallsAtNode] of nodeWalls) {
    if (wallsAtNode.length < 2) continue; // end-cap → stays square_off

    const junctionNode = nodeMap.get(nodeId);
    if (!junctionNode) continue;

    // Use center position only for distance-based endpoint detection
    const jCenter = getNodeBimPos(junctionNode, nodeMap);

    // Build descriptors for each wall at this junction
    const descs: WallDesc[] = [];
    for (const wn of wallsAtNode) {
      const ax = wallAxisEndpoints(wn, nodeMap, edges);
      if (!ax) continue;
      const th = parseWallThickness(String(wn.properties.wall_type ?? 'W20'));
      const hw = th * 1000 / 2;
      const distA = Math.hypot(ax.pA.x - jCenter.x, ax.pA.y - jCenter.y);
      const distB = Math.hypot(ax.pB.x - jCenter.x, ax.pB.y - jCenter.y);
      const endIdx: 0 | 1 = distA < distB ? 0 : 1;
      const ux = endIdx === 0 ? ax.ux : -ax.ux;
      const uy = endIdx === 0 ? ax.uy : -ax.uy;
      // Use the wall's own (grip-aware) endpoint as junction reference
      const wallJPt = endIdx === 0 ? ax.pA : ax.pB;
      descs.push({ wn, ux, uy, hw, endIdx, jPt: wallJPt });
    }
    if (descs.length < 2) continue;

    // ── Resolve join type per wall at this junction ──
    for (let i = 0; i < descs.length; i++) {
      const dA = descs[i];
      const endpoint = dA.endIdx === 0 ? 'start' : 'end';
      const userJoin = getWallJoinProp(dA.wn, endpoint);
      const resolvedJoin = userJoin === 'auto' ? autoJoinType(i, descs) : userJoin;

      const res = results.get(dA.wn.id);
      if (!res) continue;

      // Update resolved join type
      if (dA.endIdx === 0) res.startJoin = resolvedJoin;
      else res.endJoin = resolvedJoin;

      // Skip geometry processing for square_off / none
      if (resolvedJoin === 'square_off' || resolvedJoin === 'none') continue;

      // Normal always in the wall's canonical direction (pA→pB), not junction-relative.
      // This ensures "outer" and "inner" are consistent with the wall's overall normal.
      const axA = wallAxisEndpoints(dA.wn, nodeMap, edges);
      if (!axA) continue;
      const canonNx = -axA.uy, canonNy = axA.ux; // wall normal in pA→pB direction
      const nAx = canonNx, nAy = canonNy;

      // Find cross-walls (not co-linear, angle > 20°)
      const crossWalls = descs.filter((d, j) => {
        if (j === i) return false;
        return Math.abs(d.ux * dA.ux + d.uy * dA.uy) < 0.94;
      });

      if (crossWalls.length === 0) continue;

      if (resolvedJoin === 'miter') {
        // ── MITER JOIN ──
        // For L-corners: find where the face lines of wall A and wall B intersect.
        // Each wall has two face lines (left and right of centre-line).
        // We compute all 4 combinations and pick the two that form the correct
        // mitered corner for wall A's endpoint.
        const dB = crossWalls[0];
        const axB = wallAxisEndpoints(dB.wn, nodeMap, edges);
        if (!axB) continue;
        const canonNBx = -axB.uy, canonNBy = axB.ux;

        // Wall A face lines: through (dA.jPt ± nA*hw) in direction (canonical dir of A)
        // Wall B face lines: through (dB.jPt ± nB*hw) in direction (canonical dir of B)
        const adx = axA.ux, ady = axA.uy;
        const bdx = axB.ux, bdy = axB.uy;

        // Compute 4 intersections: A+/B+, A+/B−, A−/B+, A−/B−
        const pts: Array<{ pt: { x: number; y: number }; sA: number; sB: number }> = [];
        for (const sA of [1, -1]) {
          for (const sB of [1, -1]) {
            const pt = lineIntersect2D(
              dA.jPt.x + nAx * dA.hw * sA, dA.jPt.y + nAy * dA.hw * sA, adx, ady,
              dB.jPt.x + canonNBx * dB.hw * sB, dB.jPt.y + canonNBy * dB.hw * sB, bdx, bdy,
            );
            if (pt) pts.push({ pt, sA, sB });
          }
        }

        // Pick the two intersections that are on OPPOSITE sides of wall A's centre-line.
        // For each side, pick the one closest to the junction along wall A's direction.
        const outerCandidates = pts.filter((p) => p.sA > 0);
        const innerCandidates = pts.filter((p) => p.sA < 0);

        const closestToJunction = (candidates: typeof pts) => {
          let best: (typeof pts)[0] | null = null;
          let bestDist = Infinity;
          for (const c of candidates) {
            const d = Math.hypot(c.pt.x - dA.jPt.x, c.pt.y - dA.jPt.y);
            if (d < bestDist) { bestDist = d; best = c; }
          }
          return best;
        };

        const outerHit = closestToJunction(outerCandidates);
        const innerHit = closestToJunction(innerCandidates);

        const trimCentre = dA.jPt; // miter centre stays at wall's junction endpoint

        if (dA.endIdx === 0) {
          res.startPt = trimCentre;
          if (outerHit) res.outerStartPt = outerHit.pt;
          if (innerHit) res.innerStartPt = innerHit.pt;
        } else {
          res.endPt = trimCentre;
          if (outerHit) res.outerEndPt = outerHit.pt;
          if (innerHit) res.innerEndPt = innerHit.pt;
        }

      } else if (resolvedJoin === 'butt') {
        // ── BUTT JOIN ──
        // Wall A's centreline is trimmed to the nearest face of the cross-wall(s).
        // The face corners are then computed perpendicular at the trim point.
        let bestTrimPt: { x: number; y: number } | null = null;
        let bestDist = Infinity;

        for (const dB of crossWalls) {
          const nBx = -dB.uy, nBy = dB.ux;
          for (const side of [1, -1]) {
            const facePx = dB.jPt.x + nBx * dB.hw * side;
            const facePy = dB.jPt.y + nBy * dB.hw * side;
            const pt = lineIntersect2D(
              dA.jPt.x, dA.jPt.y, dA.ux, dA.uy,
              facePx, facePy, dB.ux, dB.uy,
            );
            if (!pt) continue;
            const tA = (pt.x - dA.jPt.x) * dA.ux + (pt.y - dA.jPt.y) * dA.uy;
            if (tA < -1) continue; // behind junction
            const dist = Math.abs(tA);
            if (dist < bestDist) {
              bestDist = dist;
              bestTrimPt = pt;
            }
          }
        }

        if (!bestTrimPt) continue;

        const corners = faceCorners(bestTrimPt.x, bestTrimPt.y, nAx, nAy, dA.hw);
        if (dA.endIdx === 0) {
          res.startPt = bestTrimPt;
          res.outerStartPt = corners.outer;
          res.innerStartPt = corners.inner;
        } else {
          res.endPt = bestTrimPt;
          res.outerEndPt = corners.outer;
          res.innerEndPt = corners.inner;
        }
      }
    }
  }

  return results;
}

// ─── Storey plan extents ──────────────────────────────────────────────────────

export interface StoreyPlanExtents {
  minX: number; maxX: number; minY: number; maxY: number; // mm
  cXm: number; cZm: number; planWm: number; planDm: number; // metres
}

export function calcStoreyPlanExtents(
  s: BubbleGraphNode,
  nodes: BubbleGraphNode[],
): StoreyPlanExtents {
  const axesXS = parseAxes(s.properties.axesX);
  const axesYS = parseAxes(s.properties.axesY);
  const nonAx  = nodes.filter((c) => c.parentId === s.id && c.type !== 'ax' && c.type !== 'storey');
  const allX   = [...axesXS, ...nonAx.map((c) => c.x)];
  const allY   = [...axesYS, ...nonAx.map((c) => c.y)];
  if (!allX.length) allX.push(0);
  if (!allY.length) allY.push(0);
  const pad  = 500;
  const minX = Math.min(...allX) - pad, maxX = Math.max(...allX) + pad;
  const minY = Math.min(...allY) - pad, maxY = Math.max(...allY) + pad;
  const planWm = (maxX - minX) * MM || 10;
  const planDm = (maxY - minY) * MM || 10;
  const cXm    =  ((minX + maxX) / 2) * MM;
  const cZm    = -((minY + maxY) / 2) * MM; // negated: BIM Y → Three.js -Z
  return { minX, maxX, minY, maxY, cXm, cZm, planWm, planDm };
}

// ─── Room polygon (from wall connections OR direct ax connections) ───────────

/**
 * Build an ordered polygon of BIM-mm corners for a room node.
 *
 * Two connectivity patterns are supported:
 *
 * **Pattern A — direct ax/column connections** (new style, same as shell):
 *   The room is connected directly to ax or column nodes via edges.
 *   Edge insertion order defines the perimeter; CCW winding is ensured.
 *
 * **Pattern B — wall adjacency** (legacy style):
 *   The room connects to boundary walls via edges.  Each wall provides two
 *   corner ax/column nodes.  Corners are arranged into a closed loop by
 *   greedy adjacency walk.
 *
 * Pattern A is tried first.  If the room has fewer than 3 direct ax/column
 * connections, Pattern B is attempted.
 *
 * Returns null when fewer than 3 corners can be resolved (fall back to a box).
 */
export function calcRoomPolygon(
  roomNode: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): { x: number; y: number }[] | null {
  // ── Pattern A: direct ax/column connections (edge-order polygon) ──────────
  const directAnchors = getConnectedNodes(roomNode.id, edges, nodeMap)
    .filter((n) => n.type === 'ax' || n.type === 'column');

  if (directAnchors.length >= 3) {
    const pts = directAnchors.map((n) => getNodeBimPos(n, nodeMap));
    // Ensure CCW winding (positive signed area via shoelace formula).
    let area2 = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      area2 += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    if (area2 < 0) pts.reverse();
    return pts;
  }

  // ── Pattern B: wall adjacency (legacy) ────────────────────────────────────
  const GEOM_IGNORE = new Set(['window', 'door', 'room', 'storey']);
  const walls = getConnectedNodes(roomNode.id, edges, nodeMap)
    .filter((n) => n.type === 'wall');

  if (walls.length < 3) return null;

  // For each wall get its two corner nodes (ax or column endpoints)
  const cornerPairs: [BubbleGraphNode, BubbleGraphNode][] = [];
  for (const wall of walls) {
    const corners = getConnectedNodes(wall.id, edges, nodeMap)
      .filter((n) => !GEOM_IGNORE.has(n.type) && (n.type === 'ax' || n.type === 'column'));
    if (corners.length >= 2) cornerPairs.push([corners[0], corners[1]]);
  }
  if (cornerPairs.length < 3) return null;

  // Build adjacency map: cornerId → Set<cornerId>
  const adj = new Map<string, Set<string>>();
  for (const [a, b] of cornerPairs) {
    if (!adj.has(a.id)) adj.set(a.id, new Set());
    if (!adj.has(b.id)) adj.set(b.id, new Set());
    adj.get(a.id)!.add(b.id);
    adj.get(b.id)!.add(a.id);
  }

  // Greedy polygon walk (visit each corner exactly once)
  const start     = [...adj.keys()][0];
  const visited   = new Set<string>([start]);
  const polyIds   = [start];
  let   current   = start;

  while (true) {
    const next = [...(adj.get(current) ?? [])].find((id) => !visited.has(id));
    if (!next) break;
    visited.add(next);
    polyIds.push(next);
    current = next;
  }

  if (polyIds.length < 3) return null;

  // Map IDs → real BIM mm positions
  return polyIds.map((id) => {
    const n = nodeMap.get(id)!;
    return n.type === 'ax' ? getAxRealPos(n, nodeMap) : getNodeBimPos(n, nodeMap);
  });
}

// ─── Room offset helpers ──────────────────────────────────────────────────────

/**
 * Parse the `room_offset` node property into an array of mm values.
 * Parse the `contour_offset` node property into an array of mm values.
 * Supported formats: number, "-125", "-125;-100;-50", "-125,-100,-50", [-125, -100].
 * Negative values = interior (inward), positive = exterior (outward).
 * When the property is absent/empty returns [defaultMm] (default -125 mm).
 */
export function parseContourOffsets(raw: unknown, defaultMm = -125): number[] {
  if (raw == null || raw === '') return [defaultMm];
  if (typeof raw === 'number') return [raw];
  if (Array.isArray(raw)) {
    const vals = (raw as unknown[]).map(Number).filter((v) => !isNaN(v));
    return vals.length ? vals : [defaultMm];
  }
  if (typeof raw === 'string') {
    // Accept both comma and semicolon as separator
    const parts = raw.split(/[,;]/).map((s) => parseFloat(s.trim())).filter((v) => !isNaN(v));
    return parts.length ? parts : [defaultMm];
  }
  return [defaultMm];
}

/**
 * Inset (shrink) a polygon by per-edge offsets (in mm, same units as poly coords).
 *
 * - Single offset in `offsets` → all edges shifted inward by that amount.
 * - Multiple offsets → edge[i] uses offsets[i]; last value repeats for remaining edges.
 * - Empty `offsets` or all-zero → returns original polygon unchanged.
 *
 * Algorithm: for each edge build an offset line parallel to the edge shifted
 * inward; intersect consecutive offset lines to obtain new vertices.
 */
export function insetPolygon(
  poly: { x: number; y: number }[],
  offsets: number[],
): { x: number; y: number }[] {
  const n = poly.length;
  if (n < 3 || offsets.length === 0 || offsets.every((o) => o === 0)) return poly;

  // Signed area (shoelace) to determine winding — positive = CCW, negative = CW
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  const isCCW = area2 > 0;

  // Returns the offset amount for edge i (repeat last value if i >= offsets.length)
  const getOff = (i: number) =>
    i < offsets.length ? offsets[i] : offsets[offsets.length - 1];

  // Build one offset line per edge: point on the shifted edge + edge direction
  const lines: { p: { x: number; y: number }; d: { x: number; y: number } }[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = poly[j].x - poly[i].x;
    const dy = poly[j].y - poly[i].y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-10) { lines.push({ p: poly[i], d: { x: 1, y: 0 } }); continue; }
    const dxn = dx / len, dyn = dy / len;
    // Inward normal: CCW → left normal (-dy, dx); CW → right normal (dy, -dx)
    const nx = isCCW ? -dyn : dyn;
    const ny = isCCW ? dxn : -dxn;
    const off = getOff(i);
    lines.push({ p: { x: poly[i].x + nx * off, y: poly[i].y + ny * off }, d: { x: dxn, y: dyn } });
  }

  // Intersect consecutive lines → new vertex between each pair
  const result: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const l1 = lines[i], l2 = lines[j];
    const dp = { x: l2.p.x - l1.p.x, y: l2.p.y - l1.p.y };
    const cross = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
    if (Math.abs(cross) < 1e-10) {
      // Parallel edges — use start of second offset line
      result.push({ x: l2.p.x, y: l2.p.y });
    } else {
      const t = (dp.x * l2.d.y - dp.y * l2.d.x) / cross;
      result.push({ x: l1.p.x + t * l1.d.x, y: l1.p.y + t * l1.d.y });
    }
  }
  return result;
}

// ─── Shell / Covering polygon ─────────────────────────────────────────────────

/**
 * Build an ordered polygon (BIM mm, CCW) from ax/column nodes directly
 * connected to a shell or covering node.
 *
 * The polygon follows **edge insertion order** — the order the user drew the
 * edges in the graph editor.  This preserves concave perimeters (L-shapes,
 * U-shapes, etc.) that angular-sort from the centroid would scramble.
 *
 * If the resulting polygon has clockwise winding it is reversed to CCW
 * (required by Three.js ExtrudeGeometry / earcut).
 *
 * Returns null when fewer than 3 anchor nodes are connected.
 */
export function calcShellPolygon(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): { x: number; y: number }[] | null {
  const anchors = getConnectedNodes(node.id, edges, nodeMap)
    .filter((n) => n.type === 'ax' || n.type === 'column');
  if (anchors.length < 3) return null;

  const pts = anchors.map((n) => getNodeBimPos(n, nodeMap));

  // Ensure CCW winding (positive signed area).
  // Shoelace formula: positive = CCW, negative = CW.
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area2 += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  if (area2 < 0) pts.reverse();

  return pts;
}

// ─── Void boolean cut ─────────────────────────────────────────────────────────

/**
 * Describes a void cut that should be boolean-subtracted from a host element.
 * All dimensions in metres (Babylon / Three.js scene units).
 *
 * void_shape = 'box'      → axis-aligned box (w × h × d)
 * void_shape = 'cylinder' → vertical cylinder (radius × height, radialSegments facets)
 *
 * cx_mm / cy_mm / cz_mm = world-space centre of the void in BIM mm.
 * Callers convert to scene units (× MM = × 0.001).
 */
export interface VoidInfo {
  node:           BubbleGraphNode;
  shape:          'box' | 'cylinder';
  // box params (metres)
  width:          number;
  height:         number;
  depth:          number;
  // cylinder params (metres)
  radius:         number;
  radialSegments: number;
  // BIM mm world-centre of the void
  cx_mm:          number; // BIM X (East) mm
  cy_mm:          number; // BIM Y (North) mm
  cz_mm:          number; // BIM Z (Up/Elev) mm — vertical centre
}

/**
 * Collect all `void` nodes connected to a host node and return VoidInfo descriptors.
 *
 * hostPosMm = BIM plan position + elevation centre of the host (mm).
 * offset_x / offset_y / offset_z on the void node shift from that centre.
 */
export function collectVoids(
  hostNode:  BubbleGraphNode,
  hostPosMm: { x: number; y: number; z: number },
  edges:     BubbleGraphEdge[],
  nodeMap:   Map<string, BubbleGraphNode>,
): VoidInfo[] {
  const voids: VoidInfo[] = [];

  for (const e of edges) {
    if (e.from !== hostNode.id && e.to !== hostNode.id) continue;
    const other = nodeMap.get(e.from === hostNode.id ? e.to : e.from);
    if (!other || other.type !== 'void') continue;

    const p = other.properties;
    const shape: 'box' | 'cylinder' =
      String(p.void_shape ?? 'box') === 'cylinder' ? 'cylinder' : 'box';

    const w  = Number(p.width   ?? 500);
    const h  = Number(p.height  ?? 500);
    const d  = Number(p.depth   ?? 500);
    const r  = Number(p.radius  ?? 250);
    const rs = Math.max(4, Math.round(Number(p.radial_segments ?? 16)));
    const ox = Number(p.offset_x ?? 0);
    const oy = Number(p.offset_y ?? 0);
    const oz = Number(p.offset_z ?? 0);

    voids.push({
      node:           other,
      shape,
      width:          w  * MM,
      height:         h  * MM,
      depth:          d  * MM,
      radius:         r  * MM,
      radialSegments: rs,
      cx_mm:          hostPosMm.x + ox,
      cy_mm:          hostPosMm.y + oy,
      cz_mm:          hostPosMm.z + oz,
    });
  }

  return voids.sort((a, b) => a.cx_mm - b.cx_mm);
}

// ─── Room Parametric Control Points ───────────────────────────────────────────

export interface RoomParametricGrid {
  roomId: string;
  /** All parametric snap points (edge + interior grid), BIM mm */
  points: { x: number; y: number }[];
  /** Edge control points only (3 per edge, ordered per-edge) */
  edgePoints: { x: number; y: number }[][];
  /** Interior grid lines (pairs: [start, end] for rendering) */
  gridLines: [{ x: number; y: number }, { x: number; y: number }][];
}

/**
 * Compute parametric control points for a room polygon:
 * - Each edge is divided into `segments` equal parts (default 4), producing `segments-1` interior points per edge.
 * - A parametric grid is formed by connecting corresponding points on opposite edges.
 * - Returns all control points as snap targets + grid lines for visualization.
 *
 * @param polygon Room contour vertices in BIM mm (CCW, at least 3 points).
 * @param roomId  The room node ID (for tagging snap point ownership).
 * @param segments Number of segments per edge (default 4 → 3 control points/edge).
 */
export function calcRoomParametricGrid(
  polygon: { x: number; y: number }[],
  roomId: string,
  segments = 4,
): RoomParametricGrid {
  const n = polygon.length;
  if (n < 3) return { roomId, points: [], edgePoints: [], gridLines: [] };

  // 1) Subdivide each edge into `segments` parts → (segments-1) interior control points
  const edgePoints: { x: number; y: number }[][] = [];
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const pts: { x: number; y: number }[] = [];
    for (let k = 1; k < segments; k++) {
      const t = k / segments;
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    edgePoints.push(pts);
  }

  // 2) Build interior grid by connecting points on "opposite" edges.
  //    For quads (n=4): edge0↔edge2, edge1↔edge3 (classical parametric surface).
  //    For general polygons: connect each edge to its opposite (i ↔ (i + n/2) % n) when n is even,
  //    or skip interior grid for odd-sided polygons.
  const gridLines: [{ x: number; y: number }, { x: number; y: number }][] = [];
  if (n === 4) {
    // Quad: bilinear parametric grid
    const ptsPerEdge = segments - 1;
    // Horizontal grid lines: edge3 (left, reversed) ↔ edge1 (right)
    // Edge indices for a quad: 0=bottom, 1=right, 2=top(reversed), 3=left(reversed)
    // Connect edge0[k] → edge2[reversed][k]  and  edge3[reversed][k] → edge1[k]
    for (let k = 0; k < ptsPerEdge; k++) {
      // edge0 (bottom) to edge2 (top, reversed order)
      const fromBottom = edgePoints[0][k];
      const toTop = edgePoints[2][ptsPerEdge - 1 - k];
      gridLines.push([fromBottom, toTop]);
      // edge3 (left, reversed) to edge1 (right)
      const fromLeft = edgePoints[3][ptsPerEdge - 1 - k];
      const toRight = edgePoints[1][k];
      gridLines.push([fromLeft, toRight]);
    }
  } else if (n % 2 === 0) {
    // Even polygon: pair opposite edges
    const half = n / 2;
    const ptsPerEdge = segments - 1;
    for (let i = 0; i < half; i++) {
      const oppIdx = (i + half) % n;
      for (let k = 0; k < ptsPerEdge; k++) {
        const from = edgePoints[i][k];
        const to = edgePoints[oppIdx][ptsPerEdge - 1 - k];
        gridLines.push([from, to]);
      }
    }
  }

  // 3) Collect all unique points: edge points + grid intersection points
  const allPts: { x: number; y: number }[] = [];
  // Edge control points
  for (const epts of edgePoints) {
    for (const p of epts) allPts.push(p);
  }
  // Grid intersection points (for quads: bilinear interpolation at each grid crossing)
  if (n === 4 && segments > 2) {
    for (let u = 1; u < segments; u++) {
      for (let v = 1; v < segments; v++) {
        // Skip if this is already an edge point (u or v at boundary)
        if (u === 0 || v === 0 || u === segments || v === segments) continue;
        // Bilinear interpolation using the 4 corners
        const [c0, c1, c2, c3] = polygon; // bottom-left, bottom-right, top-right, top-left
        const s = u / segments;
        const t = v / segments;
        const x = (1 - s) * (1 - t) * c0.x + s * (1 - t) * c1.x + s * t * c2.x + (1 - s) * t * c3.x;
        const y = (1 - s) * (1 - t) * c0.y + s * (1 - t) * c1.y + s * t * c2.y + (1 - s) * t * c3.y;
        allPts.push({ x, y });
      }
    }
  }

  return { roomId, points: allPts, edgePoints, gridLines };
}
