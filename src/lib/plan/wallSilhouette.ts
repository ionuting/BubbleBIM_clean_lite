/**
 * wallSilhouette.ts — the walls of a storey as ONE outline.
 *
 * Every wall draws its own closed quad, so where two of them meet the plan
 * shows the seam: a line across the poché at every T and every cross, exactly
 * where a drawing should show nothing. The masonry does not stop there, and
 * neither should the linework.
 *
 * The fix is the one a draughtsman would describe: take the union of the wall
 * bodies and stroke only its boundary. Each wall keeps its own FILL — so
 * materials, hatches, selection and hit-testing are untouched — and gives up
 * only its outline, which is now drawn once for the whole storey.
 *
 * Everything here is BIM millimetres, the same frame `calcWallGeometry`
 * returns its footprint in. The viewer maps the rings through its own `toSvg`.
 */

import * as turf from '@turf/turf';
import type { WallGeometry } from '@/lib/bimGeometry';

export interface Pt { x: number; y: number }

/** Below this a ring is numerical noise, not a wall. mm². */
const MIN_AREA_MM2 = 1;

/**
 * A wall's two faces, addressed by distance along its axis.
 *
 * The footprint's outer and inner edges run parallel to the axis but rarely
 * start and end level with each other: a mitre or a butt join moves one
 * face's end and not the other's, so on a corner wall one face is 4900 long
 * and the other 5100. Taking the SAME FRACTION of each therefore lands on two
 * points that are not opposite each other, and anything placed that way — an
 * opening's jambs, a symbol's frame — comes out as a parallelogram. The
 * opening's own position (`tS`) is a distance along the axis, so each face is
 * read at that distance: the point on the face perpendicular to it.
 *
 * At the wall's two ends the footprint's own corners are returned instead,
 * so the join shape the footprint carries is kept exactly.
 */
export interface WallFaces {
  /** Length of the axis, mm. */
  len: number;
  /** Unit vector along the axis, start → end. */
  axis: Pt;
  outerAt: (t: number) => Pt;
  innerAt: (t: number) => Pt;
}

export function wallFaces(geo: WallGeometry): WallFaces | null {
  const fp = geo.footprint;
  if (!fp || fp.length !== 4) return null;
  const MM = 0.001;
  const start = { x: geo.sxM / MM, y: -geo.szM / MM };
  const end = { x: geo.exM / MM, y: -geo.ezM / MM };
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  if (!(len > 1)) return null;
  const axis = { x: (end.x - start.x) / len, y: (end.y - start.y) / len };

  const face = (a: Pt, b: Pt) => (t: number): Pt => {
    if (t <= 0.5) return { x: a.x, y: a.y };
    if (t >= len - 0.5) return { x: b.x, y: b.y };
    // How far along the axis the face's first corner sits; t is measured
    // from the axis start, so the point is `t - at` further along the face.
    const at = (a.x - start.x) * axis.x + (a.y - start.y) * axis.y;
    return { x: a.x + axis.x * (t - at), y: a.y + axis.y * (t - at) };
  };
  return { len, axis, outerAt: face(fp[0], fp[1]), innerAt: face(fp[3], fp[2]) };
}

/**
 * The solid pieces of one wall in plan — the poché between its openings.
 *
 * Mirrors what the floor plan already draws segment by segment: the footprint
 * carries the join corners, and each piece is cut out of it between the
 * openings, each face read at the openings' distances along the axis (see
 * `wallFaces` for why not at the same fraction of each face).
 *
 * A curved wall's footprint is not four corners but the whole tessellated
 * ring, and it cannot be interpolated that way, so it goes back whole. Its
 * openings are not subtracted here — the plan does not cut them out of an arc
 * either, and inventing a different answer would put the outline somewhere the
 * fill is not.
 */
export function wallSolidPolygons(geo: WallGeometry): Pt[][] {
  const fp = geo.footprint;
  if (!fp || fp.length < 4) return [];
  if (fp.length > 4) return [fp.map((p) => ({ x: p.x, y: p.y }))];

  const faces = wallFaces(geo);
  if (!faces) return [];
  const { len, outerAt, innerAt } = faces;

  const MM = 0.001;
  const gaps = geo.openings.map((op) => ({ t0: op.tS / MM, t1: (op.tS + op.oW) / MM }));
  const segs: Array<{ s: number; e: number }> = [];
  let prev = 0;
  for (const { t0, t1 } of gaps) {
    if (t0 > prev + 0.5) segs.push({ s: prev, e: t0 });
    prev = t1;
  }
  if (prev < len - 0.5) segs.push({ s: prev, e: len });

  return segs.map(({ s, e }) => [outerAt(s), outerAt(e), innerAt(e), innerAt(s)]);
}

/** Twice the signed area — sign is the winding, magnitude the size. */
function area2(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    a += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
  }
  return a;
}

/** A ring as the closed [x, y] list a polygon wants. */
function closed(ring: Pt[]): Array<[number, number]> {
  const out: Array<[number, number]> = ring.map((p) => [p.x, p.y]);
  const a = out[0], b = out[out.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  return out;
}

/**
 * The outline of the union of every polygon given, as rings in BIM mm.
 *
 * Outer boundaries and holes come back together and undistinguished: a
 * courtyard's inner ring is as much part of the silhouette as the building's
 * outer one, and both are stroked the same way. Rings are NOT closed — the
 * repeated last point is dropped, because the caller draws them as a closed
 * path anyway.
 *
 * Returns the input rings unchanged when there is nothing to union, and
 * falls back to them if the boolean fails — a plan with its old seams is a
 * far better outcome than a plan with no walls in it.
 */
export function unionWallRings(polys: Pt[][]): Pt[][] {
  return unionPolygons(polys.map((outer) => ({ outer, holes: [] })))
    .flatMap((p) => [p.outer, ...p.holes]);
}

/** A face and whatever is punched through it. */
export interface Poly { outer: Pt[]; holes: Pt[][] }

/** Big enough to be a face rather than rounding. */
const solidEnough = (ring: Pt[]) =>
  ring.length >= 3 && Math.abs(area2(ring)) > 2 * MIN_AREA_MM2;

/**
 * The grid every vertex is snapped to before the union, in mm.
 *
 * Walls that only TOUCH — a T where one wall stops on the other's face, an L
 * meeting on its mitre — merge only if the shared edge is the same edge to
 * the last bit. Faces the kernel cuts come back through float arithmetic
 * (99.99999999 where the other wall says 100), and the union then keeps both
 * outlines: the seam the silhouette exists to remove. A cross never showed
 * it because its walls overlap rather than touch. A hundredth of a
 * millimetre is far below anything a drawing shows and far above that noise.
 */
const SNAP_MM = 0.01;

const snap = (v: number) => Math.round(v / SNAP_MM) * SNAP_MM;

/** A ring on the snap grid, with the repeats snapping made dropped. */
function snapRing(ring: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of ring) {
    const q = { x: snap(p.x), y: snap(p.y) };
    const last = out[out.length - 1];
    if (!last || last.x !== q.x || last.y !== q.y) out.push(q);
  }
  if (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
  return out;
}

/**
 * The union of faces that may themselves have holes.
 *
 * Holes matter here in a way they do not in a bare outline: a wall cut above
 * a doorway's head is a face with a hole in it, and unioning it as a solid
 * rectangle would fill the doorway in. So each face goes in as an outer ring
 * followed by its own, which is exactly how a polygon is written anyway.
 *
 * Falls back to the input if the boolean fails — a drawing with its old seams
 * beats a drawing with no walls.
 */
export function unionPolygons(polys: Poly[]): Poly[] {
  const solid = polys
    .map((p) => ({ outer: snapRing(p.outer), holes: p.holes.map(snapRing) }))
    .filter((p) => solidEnough(p.outer))
    .map((p) => ({ outer: p.outer, holes: p.holes.filter(solidEnough) }));
  if (solid.length === 0) return [];
  if (solid.length === 1) return solid;

  try {
    const merged = turf.union(turf.featureCollection(solid.map((p) =>
      turf.polygon([closed(p.outer), ...p.holes.map(closed)]))));
    if (!merged) return solid;

    const out: Poly[] = [];
    const take = (poly: Array<Array<[number, number]>>) => {
      const rings = poly.map((ring) => {
        const pts = ring.map(([x, y]) => ({ x, y }));
        // polyclip closes its rings; the repeat is not a corner.
        if (pts.length > 1) {
          const a = pts[0], b = pts[pts.length - 1];
          if (a.x === b.x && a.y === b.y) pts.pop();
        }
        return pts;
      }).filter(solidEnough);
      if (rings.length) out.push({ outer: rings[0], holes: rings.slice(1) });
    };

    const g = merged.geometry;
    if (g.type === 'Polygon') take(g.coordinates as Array<Array<[number, number]>>);
    else for (const poly of g.coordinates) take(poly as Array<Array<[number, number]>>);

    return out.length ? out : solid;
  } catch {
    return solid;
  }
}
