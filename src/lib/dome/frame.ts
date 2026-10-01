/**
 * frame.ts — the ribs: the tessellation's edges, lifted, and swept.
 *
 * A Voronoi edge is a straight chord in plan; on the surface it is a curve.
 * Each edge is subdivided and every station lifted, so the rib follows the
 * shell instead of cutting under it. The sweep itself is the ordinary sweep
 * machinery — same profile library, same ring construction — with one
 * difference: the profile stands on the surface normal rather than on world
 * up, which is what `frameOnSurface` is for.
 *
 * Ribs are butt-ended at the nodes. Three ribs meet at every Voronoi vertex
 * and a miter is a two-member joint; the overlap at a node is a few
 * centimetres of doubled steel, and a node casting is the honest detail there.
 */
import type { Pt2 } from '@/lib/geom/plan2d';
import type { Pt3, SweepPath, SweepSolid } from '@/lib/sweep/types';
import { computeSweepSolids, frameOnSurface, sweepVolume, triangulateSimple } from '@/lib/sweep/rings';
import type { Membrane } from './membrane';
import type { CellEdge } from './voronoi';
import type { DomeMember } from './types';

/** Stations along an edge: at least two, roughly one per `stepMm` of chord. */
export function liftEdge(
  e: CellEdge,
  membrane: Membrane,
  baseZMm: number,
  stepMm: number,
): DomeMember {
  const chord = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
  const k = Math.max(1, Math.round(chord / Math.max(1, stepMm)));
  const points: Pt3[] = [];
  const normals: Pt3[] = [];
  for (let i = 0; i <= k; i++) {
    const t = i / k;
    const p = { x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t };
    const s = membrane.sample(p);
    points.push({ x: p.x, y: p.y, z: baseZMm + s.z });
    normals.push(s.normal);
  }
  let lengthMm = 0;
  for (let i = 1; i < points.length; i++) {
    lengthMm += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y, points[i].z - points[i - 1].z);
  }
  return { points, normals, lengthMm, onBase: e.cells.length < 2 };
}

/** Sweep `placed` along each member, standing on the surface. */
export function memberSolids(
  members: DomeMember[],
  placed: Pt2[],
  membrane: Membrane,
): { solids: SweepSolid[]; volumeMm3: number } {
  const tris = triangulateSimple(placed);
  const solids: SweepSolid[] = [];
  let volumeMm3 = 0;
  for (const m of members) {
    if (m.points.length < 2 || m.lengthMm < 1) continue;
    const path: SweepPath = { points: m.points, closed: false, kind: 'raked' };
    const { solids: s } = computeSweepSolids(path, placed, 'miter', (t, at) =>
      frameOnSurface(t, membrane.sample({ x: at.x, y: at.y }).normal));
    solids.push(...s);
    volumeMm3 += sweepVolume(s, tris);
  }
  return { solids, volumeMm3 };
}
