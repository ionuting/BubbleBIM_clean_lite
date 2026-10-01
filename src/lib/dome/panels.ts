/**
 * panels.ts — glass in the cells, and the truth about how flat it is.
 *
 * A Voronoi cell lifted onto a curved surface is not a plane, and a sheet of
 * glass is. The panel is therefore the cell projected onto its best-fit
 * plane, and the distance the real surface strays from that plane is measured
 * and kept on the panel — not hidden in the geometry. Under the tolerance the
 * panel is flat (or cold-bent within reason); over it, it is flagged and
 * counted, because that count is what changes the price of a dome.
 *
 * The inset is done with the same half-plane clipper the cells were cut with:
 * every edge is pushed inward by half the rib width. For a convex cell that
 * is exact; a cell made concave by the base's outline is over-cut at its
 * reflex corner, which errs towards a smaller panel, never a leaking one.
 */
import { ensureCcw, polygonArea, type Pt2 } from '@/lib/geom/plan2d';
import type { Pt3 } from '@/lib/sweep/types';
import type { Membrane } from './membrane';
import { clipByLine, dedupeRing } from './voronoi';
import type { DomePanel } from './types';

/** Push every edge of a CCW ring inward by `insetMm`. */
export function insetRing(ring: Pt2[], insetMm: number): Pt2[] {
  let out = ensureCcw(ring);
  if (insetMm <= 0) return out;
  const src = out;
  for (let i = 0; i < src.length && out.length >= 3; i++) {
    const a = src[i], b = src[(i + 1) % src.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) continue;
    // Inward = left of a CCW edge.
    out = clipByLine(out, a, { x: -dy / l, y: dx / l }, insetMm);
  }
  const ring2 = dedupeRing(out);
  return ring2.length >= 3 ? ring2 : [];
}

const unit = (v: Pt3): Pt3 | null => {
  const l = Math.hypot(v.x, v.y, v.z);
  return l > 1e-12 ? { x: v.x / l, y: v.y / l, z: v.z / l } : null;
};
const dot = (a: Pt3, b: Pt3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Pt3, b: Pt3): Pt3 => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});

/**
 * Fit a plane to the lifted cell and flatten it.
 *
 * Newell's normal is the area-weighted normal of the polygon, which for a
 * nearly-flat ring is the least-squares plane to all practical purposes and
 * needs no eigen-solver.
 */
export function panelFromCell(
  cellIndex: number,
  cell: Pt2[],
  insetMm: number,
  membrane: Membrane,
  baseZMm: number,
  tolMm: number,
): DomePanel | null {
  const ring = insetRing(cell, insetMm);
  if (ring.length < 3) return null;
  const lifted: Pt3[] = ring.map((p) => ({ x: p.x, y: p.y, z: baseZMm + membrane.sample(p).z }));

  const c = lifted.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y, z: s.z + p.z }), { x: 0, y: 0, z: 0 });
  const origin: Pt3 = { x: c.x / lifted.length, y: c.y / lifted.length, z: c.z / lifted.length };

  const nw: Pt3 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < lifted.length; i++) {
    const a = lifted[i], b = lifted[(i + 1) % lifted.length];
    nw.x += (a.y - b.y) * (a.z + b.z);
    nw.y += (a.z - b.z) * (a.x + b.x);
    nw.z += (a.x - b.x) * (a.y + b.y);
  }
  let normal = unit(nw);
  if (!normal) return null;
  if (normal.z < 0) normal = { x: -normal.x, y: -normal.y, z: -normal.z };

  let deviationMm = 0;
  const outline: Pt3[] = lifted.map((p) => {
    const d = dot({ x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z }, normal!);
    if (Math.abs(d) > deviationMm) deviationMm = Math.abs(d);
    return { x: p.x - normal!.x * d, y: p.y - normal!.y * d, z: p.z - normal!.z * d };
  });

  const r0 = unit({ x: outline[0].x - origin.x, y: outline[0].y - origin.y, z: outline[0].z - origin.z });
  if (!r0) return null;
  const refDir = r0;
  const vAxis = cross(normal, refDir);
  const profile: Pt2[] = outline.map((p) => {
    const d = { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z };
    return { x: dot(d, refDir), y: dot(d, vAxis) };
  });
  const areaMm2 = Math.abs(polygonArea(profile));
  if (areaMm2 < 1) return null;

  return {
    cell: cellIndex,
    outline, origin, normal, refDir, profile,
    areaMm2, deviationMm, planar: deviationMm <= tolMm,
  };
}
