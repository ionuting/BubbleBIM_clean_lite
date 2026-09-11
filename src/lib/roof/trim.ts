/**
 * trim.ts — roof planes cutting the geometry beneath them, and the priority
 * order that decides who cuts whom.
 *
 * ## The height field
 *
 * Every slope face of a roof is planar by construction (see `skeleton.ts`), so
 * over its own 2D footprint it is exactly `z = a·x + b·y + c`. The roof's
 * underside at a point is therefore the MINIMUM of the planes whose footprint
 * covers that point, and `Infinity` where no face covers it — nothing to cut.
 * Vertical faces (a gable end) carry no height information and are skipped;
 * the two slope planes that meet over a gable wall already give it its
 * triangle.
 *
 * That field is what every consumer needs: 3D subtracts a wedge built from the
 * same planes, section and elevation fold a wall's top along it, and the IFC
 * export splits the wall into a parametric box plus a swept gable. They agree
 * because they all read this one function.
 *
 * ## Priority
 *
 * `properties.trim_priority` (a number, defaulted per node type) orders any two
 * overlapping bodies: the higher number cuts the lower, equal numbers leave
 * each other alone. A roof sits at 100 and ordinary construction at 10, so a
 * roof trims walls and columns by default. Give a chimney or a stair tower 200
 * and the relation inverts — it punches a hole through the roof instead, along
 * the path skylights and dormers already take.
 *
 * Pure and framework-free: no scene, no kernel, no React.
 */
import type { BubbleGraphNode } from '@/store';
import { pointInPolygon } from '@/lib/geom/plan2d';
import type { Pt2, RoofFace3D } from './types';

/**
 * A point exactly on a face outline counts as covered. This is not a nicety:
 * the eave line IS the wall centre-line in most buildings, so a strict test
 * would leave precisely the walls that need trimming untouched.
 */
const COVER_TOL_MM = 1;
const covered = (poly: Pt2[], x: number, y: number) => pointInPolygon({ x, y }, poly, COVER_TOL_MM);

// ─── Priority ────────────────────────────────────────────────────────────────

/** What a node type is worth when it has no explicit `trim_priority`. */
export const TRIM_PRIORITY_DEFAULTS: Readonly<Record<string, number>> = {
  roof: 100,
  slab: 30,
  foundation: 30,
  beam: 20,
};

/** Everything not named above — walls, columns, rooms, objects. */
export const DEFAULT_TRIM_PRIORITY = 10;

export function trimPriority(node: BubbleGraphNode): number {
  const raw = node.properties?.trim_priority;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(n)) return n;
  return TRIM_PRIORITY_DEFAULTS[node.type] ?? DEFAULT_TRIM_PRIORITY;
}

/** True when `cutter` is entitled to cut `host`. Ties cut nothing. */
export function cuts(cutter: BubbleGraphNode, host: BubbleGraphNode): boolean {
  return trimPriority(cutter) > trimPriority(host);
}

// ─── Planes ──────────────────────────────────────────────────────────────────

export interface Bbox2 { minX: number; minY: number; maxX: number; maxY: number }

/** One roof slope reduced to what trimming needs: a footprint and a linear height. */
export interface TrimPlane {
  roofId: string;
  faceId: string;
  /** The face outline projected to plan (BIM mm). */
  footprint: Pt2[];
  bbox: Bbox2;
  /** z = a·x + b·y + c (BIM mm), already carrying the roof's trim offset. */
  a: number;
  b: number;
  c: number;
  minZ: number;
  maxZ: number;
}

/** Faces steeper than this are vertical for our purposes and carry no height. */
const MIN_NZ = 1e-4;
const EPS = 1e-6;

function bboxOf(pts: Pt2[]): Bbox2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export const bboxOverlap = (a: Bbox2, b: Bbox2, tol = 0): boolean =>
  a.minX - tol <= b.maxX && b.minX - tol <= a.maxX && a.minY - tol <= b.maxY && b.minY - tol <= a.maxY;

/**
 * Turn roof faces into trim planes, shifted by `offsetMm` (negative drops the
 * cut toward the rafter underside). Vertical faces are dropped.
 */
export function planesFromFaces(roofId: string, faces: RoofFace3D[], offsetMm = 0): TrimPlane[] {
  const out: TrimPlane[] = [];
  for (const face of faces) {
    const V = face.vertices;
    if (V.length < 3) continue;

    // Newell's normal — stable on the near-degenerate slivers a skeleton emits.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < V.length; i++) {
      const p = V[i], q = V[(i + 1) % V.length];
      nx += (p.y - q.y) * (p.z + q.z);
      ny += (p.z - q.z) * (p.x + q.x);
      nz += (p.x - q.x) * (p.y + q.y);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < EPS) continue;
    nx /= len; ny /= len; nz /= len;
    if (Math.abs(nz) < MIN_NZ) continue; // vertical: a gable end, not a water plane

    const p0 = V[0];
    const a = -nx / nz;
    const b = -ny / nz;
    const c = p0.z - a * p0.x - b * p0.y + offsetMm;

    const footprint = V.map((v) => ({ x: v.x, y: v.y }));
    const zs = V.map((v) => v.z + offsetMm);
    out.push({
      roofId, faceId: face.id, footprint, bbox: bboxOf(footprint),
      a, b, c, minZ: Math.min(...zs), maxZ: Math.max(...zs),
    });
  }
  return out;
}

export const planeZ = (p: TrimPlane, x: number, y: number): number => p.a * x + p.b * y + p.c;

/** The roof underside at a plan point: the lowest covering plane, `Infinity` where none covers it. */
export function trimHeightAt(planes: TrimPlane[], x: number, y: number): number {
  let z = Infinity;
  for (const p of planes) {
    if (x < p.bbox.minX - COVER_TOL_MM || x > p.bbox.maxX + COVER_TOL_MM) continue;
    if (y < p.bbox.minY - COVER_TOL_MM || y > p.bbox.maxY + COVER_TOL_MM) continue;
    if (!covered(p.footprint, x, y)) continue;
    const v = planeZ(p, x, y);
    if (v < z) z = v;
  }
  return z;
}

// ─── The folded top of a run ─────────────────────────────────────────────────

/** A straight stretch of trimmed top, parametrised along a segment (t = 0…1). */
export interface TopSegment { t0: number; t1: number; z0: number; z1: number }

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Where the segment A→B crosses the edges of `poly`, as parameters in [0,1]. */
function edgeCrossings(A: Pt2, B: Pt2, poly: Pt2[], out: number[]): void {
  const dx = B.x - A.x, dy = B.y - A.y;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q.x - p.x, ey = q.y - p.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < EPS) continue;
    const t = ((p.x - A.x) * ey - (p.y - A.y) * ex) / den;
    const s = ((p.x - A.x) * dy - (p.y - A.y) * dx) / den;
    if (t > -EPS && t < 1 + EPS && s > -EPS && s < 1 + EPS) out.push(clamp01(t));
  }
}

/**
 * The top of a run from `A` to `B` capped at `zTop`, folded wherever the roof
 * folds. Breakpoints come from three places: where the segment enters or leaves
 * a face's footprint, where two planes cross (a ridge, hip or valley), and
 * where a plane crosses `zTop` — between any two of them exactly one linear
 * function governs, so each piece is a straight line and the result is exact,
 * not sampled.
 *
 * Returns one segment spanning the whole run when nothing trims it.
 */
export function trimmedTopAlong(planes: TrimPlane[], A: Pt2, B: Pt2, zTop: number): TopSegment[] {
  const flat: TopSegment[] = [{ t0: 0, t1: 1, z0: zTop, z1: zTop }];
  if (planes.length === 0) return flat;

  const dx = B.x - A.x, dy = B.y - A.y;
  const at = (t: number): Pt2 => ({ x: A.x + dx * t, y: A.y + dy * t });

  // Only the planes whose bbox the run can reach.
  const run = bboxOf([A, B]);
  const near = planes.filter((p) => bboxOverlap(p.bbox, run, 1));
  if (near.length === 0) return flat;

  const ts: number[] = [0, 1];
  for (const p of near) edgeCrossings(A, B, p.footprint, ts);
  // z along the run is linear per plane: z(t) = (a·dx + b·dy)·t + (a·Ax + b·Ay + c).
  const lin = near.map((p) => ({ k: p.a * dx + p.b * dy, z0: planeZ(p, A.x, A.y) }));
  for (let i = 0; i < lin.length; i++) {
    const den = lin[i].k;
    if (Math.abs(den) > EPS) {
      const t = (zTop - lin[i].z0) / den;
      if (t > 0 && t < 1) ts.push(t);
    }
    for (let j = i + 1; j < lin.length; j++) {
      const d = lin[i].k - lin[j].k;
      if (Math.abs(d) < EPS) continue;
      const t = (lin[j].z0 - lin[i].z0) / d;
      if (t > 0 && t < 1) ts.push(t);
    }
  }

  ts.sort((x, y) => x - y);
  const segs: TopSegment[] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    if (t1 - t0 < 1e-9) continue;
    const mid = at((t0 + t1) / 2);
    // One plane governs the whole piece, so evaluating it at the ends is exact.
    let best: TrimPlane | null = null;
    let bestZ = Infinity;
    for (const p of near) {
      if (!covered(p.footprint, mid.x, mid.y)) continue;
      const z = planeZ(p, mid.x, mid.y);
      if (z < bestZ) { bestZ = z; best = p; }
    }
    const p0 = at(t0), p1 = at(t1);
    const z0 = best ? Math.min(zTop, planeZ(best, p0.x, p0.y)) : zTop;
    const z1 = best ? Math.min(zTop, planeZ(best, p1.x, p1.y)) : zTop;
    const last = segs[segs.length - 1];
    // Fold back together the pieces a breakpoint split without changing the line.
    if (last && Math.abs(last.z1 - z0) < 1e-6 &&
        Math.abs((last.z1 - last.z0) * (t1 - t0) - (z1 - z0) * (last.t1 - last.t0)) < 1e-6) {
      last.t1 = t1; last.z1 = z1;
    } else {
      segs.push({ t0, t1, z0, z1 });
    }
  }
  return segs.length ? segs : flat;
}

/**
 * The highest the roof gets over a run — what a wall must grow to if it is set
 * to attach to the roof. Reads the folded top, so a run crossing a ridge gets
 * the apex, not just the higher of its two ends. Null when nothing covers it.
 */
export function attachHeightAlong(planes: TrimPlane[], A: Pt2, B: Pt2): number | null {
  let best = -Infinity;
  for (const s of trimmedTopAlong(planes, A, B, Infinity)) {
    if (Number.isFinite(s.z0)) best = Math.max(best, s.z0);
    if (Number.isFinite(s.z1)) best = Math.max(best, s.z1);
  }
  return Number.isFinite(best) ? best : null;
}

/** Walls and columns opt in to growing up to the roof before being cut by it. */
export const attachesToRoof = (node: BubbleGraphNode): boolean =>
  String(node.properties?.roof_attach ?? 'False').toLowerCase() === 'true';

/** True when any part of the run was pulled below `zTop`. */
export const isTrimmed = (segs: TopSegment[], zTop: number, tolMm = 1): boolean =>
  segs.some((s) => s.z0 < zTop - tolMm || s.z1 < zTop - tolMm);

/** The outline of a trimmed run in (t, z), ready to be mapped into a drawing. */
export function topOutline(segs: TopSegment[]): Array<{ t: number; z: number }> {
  const pts: Array<{ t: number; z: number }> = [];
  for (const s of segs) {
    const prev = pts[pts.length - 1];
    if (!prev || Math.abs(prev.t - s.t0) > 1e-9 || Math.abs(prev.z - s.z0) > 1e-6) pts.push({ t: s.t0, z: s.z0 });
    pts.push({ t: s.t1, z: s.z1 });
  }
  return pts;
}

// ─── Per-roof trim set ───────────────────────────────────────────────────────

export interface RoofTrim {
  roof: BubbleGraphNode;
  planes: TrimPlane[];
  bbox: Bbox2;
  /** Lowest point of the whole roof — nothing below this is ever touched. */
  minZ: number;
  priority: number;
}

/** The roof's own `trim_offset_mm`: negative drops the cut toward the rafters. */
export const trimOffsetMm = (roof: BubbleGraphNode): number => {
  const n = Number(roof.properties?.trim_offset_mm ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Whether a roof is allowed to trim at all (`trim_below = "False"` opts out). */
export const roofTrimsBelow = (roof: BubbleGraphNode): boolean =>
  String(roof.properties?.trim_below ?? 'True').toLowerCase() !== 'false';

export function roofTrim(roof: BubbleGraphNode, faces: RoofFace3D[]): RoofTrim | null {
  const planes = planesFromFaces(roof.id, faces, trimOffsetMm(roof));
  if (planes.length === 0) return null;
  const bbox = bboxOf(planes.flatMap((p) => p.footprint));
  return { roof, planes, bbox, minZ: Math.min(...planes.map((p) => p.minZ)), priority: trimPriority(roof) };
}

/**
 * Whether this roof should trim that node: a lower priority, not one of the
 * roof's own generated members, and actually underneath it in plan.
 */
export function roofTrimsNode(trim: RoofTrim, node: BubbleGraphNode, footprint: Pt2[]): boolean {
  if (!roofTrimsBelow(trim.roof)) return false;
  if (node.id === trim.roof.id) return false;
  if (node.properties?.source_roof_id === trim.roof.id) return false;
  if (trimPriority(node) >= trim.priority) return false;
  if (footprint.length === 0) return false;
  return bboxOverlap(trim.bbox, bboxOf(footprint), 1);
}

/** The nodes entitled to cut THIS roof instead — a chimney, a stair tower, a shaft. */
export function nodesCuttingRoof(trim: RoofTrim, nodes: BubbleGraphNode[]): BubbleGraphNode[] {
  return nodes.filter((n) =>
    n.id !== trim.roof.id &&
    n.properties?.source_roof_id !== trim.roof.id &&
    trimPriority(n) > trim.priority);
}
