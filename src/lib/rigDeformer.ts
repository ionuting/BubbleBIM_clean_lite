/**
 * rigDeformer.ts — Volumetric Rig Deformation Engine
 *
 * Sprint 2 / Sprint 3 of the Volumetric Rig System.
 *
 * Concept
 * -------
 * Rig axes are draggable control lines placed over an IFC 2D plan.
 * Each wall endpoint "binds" to the nearest rig axis that aligns with it
 * (within SNAP_MM tolerance). When a rig axis moves, all bound endpoints
 * move by the same delta — a rigid parametric deformation.
 *
 * This gives the user a grid-based cage: drag axis "2" from X=6000 to
 * X=6500 and every wall column at X=6000 shifts to 6500 mm.
 *
 * Back-projection (Sprint 4): the new rig axis positions become the new
 * BubbleGraph axesX / axesY values, regenerating the parametric model.
 */

import type { IFCPlanWall, IFCPlanSlab, RigAxis } from '../store/index';

// ── Constants ──────────────────────────────────────────────────────────────
/** Binding snap radius in mm — endpoint binds to a rig axis within this distance. */
const SNAP_MM = 500;

// ── Types ──────────────────────────────────────────────────────────────────

/** Which endpoint(s) of a wall are bound to a rig axis. */
export interface EndpointBinding {
  axisId:    string;
  bindStart: boolean;   // startPt_mm is bound
  bindEnd:   boolean;   // endPt_mm is bound
}

/**
 * Full binding map: wallId → list of axis bindings.
 * A wall can be bound to multiple axes (e.g. its start to X-axis-1,
 * its end to X-axis-2).
 */
export type BindingMap = Map<string, EndpointBinding[]>;

// ── Core Functions ─────────────────────────────────────────────────────────

/**
 * computeBindings — decide which wall endpoints are bound to which rig axes.
 *
 * For each wall endpoint, scan all axes with matching direction:
 *   - X-axis: compare endpoint.x to axis.positionMm
 *   - Y-axis: compare endpoint.y to axis.positionMm
 *
 * If |endpoint.coord - axis.originMm| < SNAP_MM, bind.
 * Bindings are always computed against originMm (the position when the rig
 * was generated) so they remain stable no matter how far the axis is dragged.
 */
export function computeBindings(
  walls:  IFCPlanWall[],
  axes:   RigAxis[],
  snapMm: number = SNAP_MM,
): BindingMap {
  const map: BindingMap = new Map();

  for (const wall of walls) {
    const [sx, sy] = wall.startPt_mm;
    const [ex, ey] = wall.endPt_mm;
    const bindings: EndpointBinding[] = [];

    for (const axis of axes) {
      // Use originMm — the initial position at rig generation time.
      // This keeps bindings stable even when the axis is dragged far away.
      const origin  = axis.originMm;
      const startC  = axis.dir === 'X' ? sx : sy;
      const endC    = axis.dir === 'X' ? ex : ey;
      const bindS   = Math.abs(startC - origin) < snapMm;
      const bindE   = Math.abs(endC   - origin) < snapMm;

      if (bindS || bindE) {
        bindings.push({ axisId: axis.id, bindStart: bindS, bindEnd: bindE });
      }
    }

    if (bindings.length > 0) {
      map.set(wall.id, bindings);
    }
  }

  return map;
}

/**
 * applyRigDeformation — given current rig axes (with updated positionMm),
 * and the original IFC walls, produce a deformed copy of the walls.
 *
 * @param walls    Original IFC walls (unchanged)
 * @param axes     Current rig axes (positionMm may differ from originMm)
 * @param bindings Precomputed binding map from computeBindings()
 */
export function applyRigDeformation(
  walls:    IFCPlanWall[],
  axes:     RigAxis[],
  bindings: BindingMap,
): IFCPlanWall[] {
  // Build axis delta map: axisId → delta in mm
  const deltaMap = new Map<string, number>();
  for (const axis of axes) {
    deltaMap.set(axis.id, axis.positionMm - axis.originMm);
  }

  return walls.map((wall) => {
    const wallBindings = bindings.get(wall.id);
    if (!wallBindings || wallBindings.length === 0) return wall;

    let [sx, sy] = wall.startPt_mm;
    let [ex, ey] = wall.endPt_mm;

    for (const b of wallBindings) {
      const delta = deltaMap.get(b.axisId) ?? 0;
      if (delta === 0) continue;

      const axis = axes.find((a) => a.id === b.axisId);
      if (!axis) continue;

      if (axis.dir === 'X') {
        if (b.bindStart) sx += delta;
        if (b.bindEnd)   ex += delta;
      } else {
        if (b.bindStart) sy += delta;
        if (b.bindEnd)   ey += delta;
      }
    }

    // Recompute footprint from new axis endpoints + original thickness
    const startPt_mm: [number, number] = [sx, sy];
    const endPt_mm:   [number, number] = [ex, ey];
    const footprint_mm = buildFootprint(startPt_mm, endPt_mm, wall.thickness_mm);

    return { ...wall, startPt_mm, endPt_mm, footprint_mm };
  });
}

/**
 * buildFootprint — rebuild 4-point wall footprint from new endpoints + thickness.
 */
export function buildFootprint(
  start: [number, number],
  end:   [number, number],
  thickness: number,
): [number, number][] {
  const [x1, y1] = start;
  const [x2, y2] = end;
  const dx = x2 - x1; const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return [start, end, end, start];
  const ux = dx / len; const uy = dy / len;
  const px = -uy;      const py = ux;
  const h  = thickness / 2;
  return [
    [x1 + px * h, y1 + py * h],
    [x2 + px * h, y2 + py * h],
    [x2 - px * h, y2 - py * h],
    [x1 - px * h, y1 - py * h],
  ];
}

/**
 * generateRigFromStorey — auto-create rig axes from detected IFC grid axes.
 *
 * Each detected X-axis becomes a vertical rig line; each Y-axis a horizontal one.
 * Returns the full set of RigAxis objects ready to insert into rigState.
 */
export function generateRigFromStorey(
  axesX_mm: number[],
  axesY_mm: number[],
  storeyId: string,
): RigAxis[] {
  const axes: RigAxis[] = [];

  const sortedX = [...axesX_mm].sort((a, b) => a - b);
  const sortedY = [...axesY_mm].sort((a, b) => a - b);

  sortedX.forEach((pos, i) => {
    axes.push({
      id:         `rig-x-${storeyId}-${i}`,
      dir:        'X',
      positionMm: pos,
      originMm:   pos,
      label:      String(i + 1),
    });
  });

  sortedY.forEach((pos, i) => {
    axes.push({
      id:         `rig-y-${storeyId}-${i}`,
      dir:        'Y',
      positionMm: pos,
      originMm:   pos,
      label:      String.fromCharCode(65 + i),  // A, B, C…
    });
  });

  return axes;
}

/**
 * backProjectToBubbleGraph — map final rig axis positions back to
 * BubbleGraph axesX / axesY arrays.
 *
 * Returns { axesX: number[], axesY: number[] } in mm, sorted ascending.
 * These can be fed directly to updateStoreyAxes() in the store.
 */
export function backProjectToBubbleGraph(axes: RigAxis[]): {
  axesX: number[];
  axesY: number[];
} {
  const axesX = axes
    .filter((a) => a.dir === 'X')
    .map((a) => a.positionMm)
    .sort((a, b) => a - b);

  const axesY = axes
    .filter((a) => a.dir === 'Y')
    .map((a) => a.positionMm)
    .sort((a, b) => a - b);

  return { axesX, axesY };
}

// ─────────────────────────────────────────────────────────────────────────────
// SLAB DEFORMATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Binding for a single slab footprint vertex to a rig axis.
 * When the axis moves, vertex[vertexIndex] is translated by the axis delta.
 */
export interface SlabVertexBinding {
  axisId:      string;
  vertexIndex: number;
}

/** Full slab binding map: slabId → list of vertex bindings. */
export type SlabBindingMap = Map<string, SlabVertexBinding[]>;

/**
 * computeSlabBindings — bind each footprint vertex to nearby rig axes.
 *
 * Uses the same originMm snap logic as wall bindings for stability.
 */
export function computeSlabBindings(
  slabs:  IFCPlanSlab[],
  axes:   RigAxis[],
  snapMm: number = SNAP_MM,
): SlabBindingMap {
  const map: SlabBindingMap = new Map();

  for (const slab of slabs) {
    const bindings: SlabVertexBinding[] = [];

    for (let vi = 0; vi < slab.footprint_mm.length; vi++) {
      const [vx, vy] = slab.footprint_mm[vi];

      for (const axis of axes) {
        const vc = axis.dir === 'X' ? vx : vy;
        if (Math.abs(vc - axis.originMm) < snapMm) {
          bindings.push({ axisId: axis.id, vertexIndex: vi });
        }
      }
    }

    if (bindings.length > 0) {
      map.set(slab.id, bindings);
    }
  }

  return map;
}

/**
 * applySlabDeformation — translate bound footprint vertices according to
 * current rig axis deltas (positionMm − originMm).
 */
export function applySlabDeformation(
  slabs:    IFCPlanSlab[],
  axes:     RigAxis[],
  bindings: SlabBindingMap,
): IFCPlanSlab[] {
  const deltaMap = new Map<string, number>();
  for (const axis of axes) {
    deltaMap.set(axis.id, axis.positionMm - axis.originMm);
  }

  return slabs.map((slab) => {
    const slabBindings = bindings.get(slab.id);
    if (!slabBindings || slabBindings.length === 0) return slab;

    // Deep-copy footprint so we don't mutate the original
    const newFootprint: [number, number][] = slab.footprint_mm.map(
      (p) => [p[0], p[1]],
    );

    for (const b of slabBindings) {
      const delta = deltaMap.get(b.axisId) ?? 0;
      if (delta === 0) continue;

      const axis = axes.find((a) => a.id === b.axisId);
      if (!axis) continue;

      const [vx, vy] = newFootprint[b.vertexIndex];
      if (axis.dir === 'X') {
        newFootprint[b.vertexIndex] = [vx + delta, vy];
      } else {
        newFootprint[b.vertexIndex] = [vx, vy + delta];
      }
    }

    return { ...slab, footprint_mm: newFootprint };
  });
}
