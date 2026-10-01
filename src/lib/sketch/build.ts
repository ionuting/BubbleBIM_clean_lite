/**
 * build.ts — the outline's geometry, and the bodies it can be given.
 *
 * Nothing here knows about the graph or about React. It takes points and
 * numbers and returns solids in the SAME `SweepSolid` shape the sweep element
 * produces, which is the whole reason this module is small: the mesh builder,
 * the volume integral, the cap triangulation and the IFC extrusion writer are
 * all reused unchanged. An extrusion is simply a two-ring sweep solid whose
 * profile happens to lie in the plan.
 */
import type { Pt2 } from '@/lib/geom/plan2d';
import { ensureCcw, polygonArea } from '@/lib/geom/plan2d';
import { cw, triangulateFace } from '@/lib/geom/faceWithHoles';
import type { Pt3, SweepPath, SweepSolid } from '@/lib/sweep/types';
import type { SketchArray } from './types';
import { IDENTITY_FRAME, type SketchFrame } from './frame';

/** Points closer than this in plan are the same point. */
export const OUTLINE_TOL_MM = 1;

/**
 * Drop consecutive duplicates, and the closing duplicate a click-to-close
 * gesture leaves behind. Two coincident points in a row give a zero-length
 * segment, whose unit tangent is NaN — every downstream frame would then be
 * NaN, so this is a correctness step, not tidying.
 */
export function cleanOutline(pts: Pt2[], closed: boolean): Pt2[] {
  const out: Pt2[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < OUTLINE_TOL_MM) continue;
    out.push({ x: p.x, y: p.y });
  }
  // A closed ring stores its vertices once; the wrap-around is implied.
  while (closed && out.length > 1) {
    const first = out[0], last = out[out.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) < OUTLINE_TOL_MM) out.pop();
    else break;
  }
  return out;
}

/** Perimeter when closed, run length when open, mm. */
export function outlineLength(pts: Pt2[], closed: boolean): number {
  if (pts.length < 2) return 0;
  let total = 0;
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Area enclosed by a closed outline, mm², unsigned. 0 when open or degenerate. */
export function outlineArea(pts: Pt2[], closed: boolean): number {
  if (!closed || pts.length < 3) return 0;
  return Math.abs(polygonArea(pts));
}

/**
 * The prism a closed outline makes between two elevations.
 *
 * Rings are ordered bottom-then-top and the outline is wound CCW, which is
 * what makes every face come out pointing outwards: the top cap keeps its
 * winding (+Z), the bottom cap is reversed by `solidTriangles` (−Z), and each
 * side quad's normal is `edge × up`, which for a CCW ring points away from the
 * interior. Get either convention backwards and the volume integral goes
 * negative — so `extrudeVolume` is the assertion that this held.
 */
export function extrudeSolid(
  outline: Pt2[],
  zLowMm: number,
  zHighMm: number,
  /** Holes through the face, any winding — already checked by the caller. */
  holes: Pt2[][] = [],
): SweepSolid | null {
  if (outline.length < 3) return null;
  const ring = ensureCcw(outline);
  const at = (r: Pt2[], z: number): Pt3[] => r.map((p) => ({ x: p.x, y: p.y, z }));
  const solid: SweepSolid = { rings: [at(ring, zLowMm), at(ring, zHighMm)], loop: false };
  if (holes.length > 0) {
    const inner = holes.map(cw);
    solid.holes = inner.map((h) => [at(h, zLowMm), at(h, zHighMm)]);
    solid.capTris = triangulateFace(ring, inner);
  }
  return solid;
}

/** A horizontal guide line through the drawn points, at one elevation. */
export function outlinePath(outline: Pt2[], zMm: number, closed: boolean): SweepPath | null {
  if (outline.length < 2) return null;
  return {
    points: outline.map((p) => ({ x: p.x, y: p.y, z: zMm })),
    closed,
    kind: 'horizontal',
  };
}

/**
 * The translation of every array copy, copy 0 first and always the identity.
 *
 * A step vector shorter than a millimetre would stack copies on top of each
 * other — visually one element, but billed `count` times — so it collapses to
 * the original rather than quietly multiplying the quantities.
 */
export function arrayOffsets(array: SketchArray, frame: SketchFrame = IDENTITY_FRAME): Pt3[] {
  const count = Math.max(1, Math.round(array.count));
  const v = arrayStep(array, frame);
  const step = Math.hypot(v.x, v.y, v.z);
  if (count === 1 || step < 1) return [{ x: 0, y: 0, z: 0 }];
  const out: Pt3[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: v.x * i, y: v.y * i, z: v.z * i });
  }
  return out;
}

/**
 * The step between consecutive copies, in BIM mm.
 *
 * Along the reference line the step is `stepMm` in the line's direction —
 * or, when fitting, the line's length shared out over the `count − 1` gaps,
 * so the last copy lands exactly on the second anchor. The vertical part of
 * the explicit vector is kept either way: a repeat along a line can still
 * climb. With no reference line to follow, 'ref' degrades to the vector.
 */
export function arrayStep(array: SketchArray, frame: SketchFrame): Pt3 {
  // Along a path the step is not one vector: each copy has its own placement
  // (`pathPlacements`). Only the climb is shared.
  if (array.along === 'path') return { x: 0, y: 0, z: array.dzMm };
  if (array.along !== 'ref' || frame.refLengthMm <= 0) {
    return { x: array.dxMm, y: array.dyMm, z: array.dzMm };
  }
  const count = Math.max(1, Math.round(array.count));
  const along = array.fit
    ? (count > 1 ? frame.refLengthMm / (count - 1) : 0)
    : array.stepMm;
  return { x: frame.dir.x * along, y: frame.dir.y * along, z: array.dzMm };
}

/** Copy solids translated by `d`. The originals are not touched. */
export function translateSolids(solids: SweepSolid[], d: Pt3): SweepSolid[] {
  if (d.x === 0 && d.y === 0 && d.z === 0) return solids;
  const move = (r: Pt3[]) => r.map((p) => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z }));
  return solids.map((s) => ({
    loop: s.loop,
    rings: s.rings.map(move),
    ...(s.holes ? { holes: s.holes.map((h) => h.map(move)), capTris: s.capTris } : {}),
  }));
}

/** Copy a plan outline translated by `d` (z ignored). */
export function translateOutline(pts: Pt2[], d: Pt3): Pt2[] {
  return pts.map((p) => ({ x: p.x + d.x, y: p.y + d.y }));
}

// ─── Placements: a turn about a pivot, then a move ──────────────────────────

/** Where one array copy goes: turned by `rotRad` about `pivot` in plan, then moved by `d`. */
export interface CopyPlacement {
  d: Pt3;
  rotRad: number;
  pivot: Pt2;
}

export const IDENTITY_PLACEMENT: CopyPlacement = { d: { x: 0, y: 0, z: 0 }, rotRad: 0, pivot: { x: 0, y: 0 } };

/** A translation-only placement — what the vector and reference arrays produce. */
export const placementOf = (d: Pt3): CopyPlacement => ({ d, rotRad: 0, pivot: { x: 0, y: 0 } });

/** The plan map of a placement. */
export function placeFn(pl: CopyPlacement): (p: Pt2) => Pt2 {
  const c = Math.cos(pl.rotRad), s = Math.sin(pl.rotRad);
  return (p) => {
    const x = p.x - pl.pivot.x, y = p.y - pl.pivot.y;
    return { x: pl.pivot.x + x * c - y * s + pl.d.x, y: pl.pivot.y + x * s + y * c + pl.d.y };
  };
}

/** Copy solids placed by `pl` — rings, holes and all. The originals are not touched. */
export function placeSolids(solids: SweepSolid[], pl: CopyPlacement): SweepSolid[] {
  if (pl.rotRad === 0) return translateSolids(solids, pl.d);
  const f = placeFn(pl);
  const move = (r: Pt3[]) => r.map((p) => ({ ...f(p), z: p.z + pl.d.z }));
  return solids.map((s) => ({
    loop: s.loop,
    rings: s.rings.map(move),
    ...(s.holes ? { holes: s.holes.map((h) => h.map(move)), capTris: s.capTris } : {}),
  }));
}

/** Copy a plan outline placed by `pl` (z ignored). */
export function placeOutline(pts: Pt2[], pl: CopyPlacement): Pt2[] {
  if (pl.rotRad === 0) return translateOutline(pts, pl.d);
  return pts.map(placeFn(pl));
}

/** A direction (no translation) turned by the placement — for an IFC axis. */
export function placeDirection(v: Pt3, pl: CopyPlacement): Pt3 {
  const c = Math.cos(pl.rotRad), s = Math.sin(pl.rotRad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}
