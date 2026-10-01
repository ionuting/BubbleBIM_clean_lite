/**
 * contour.ts — marching squares, for regions no polygon boolean can express.
 *
 * ## Why this exists
 *
 * When two domes overlap, the outer shell is `max(z₁, z₂)` and the crease
 * between them is the curve where `z₁ = z₂`. That curve is not an edge of
 * either base — it is a level set of a function nobody has in closed form,
 * so it cannot come out of a polygon boolean. It has to be traced.
 *
 * The region a dome actually owns is then
 *
 *     Rᵢ = { p : inside(baseᵢ) AND zᵢ(p) ≥ z_j(p) for every other j }
 *
 * and both conditions are just "some scalar is positive". Sampling their
 * minimum on a grid and tracing the zero level gives the region's outline in
 * one pass, with holes and multiple pieces falling out for free — a small
 * tall dome standing in the middle of a big flat one really does punch a hole
 * in the big one's region, and nothing here has to special-case that.
 *
 * ## What it costs
 *
 * Resolution. The outline is accurate to about a grid cell, so the caller
 * passes a spacing fine enough for the job — the membrane's own spacing is
 * the natural choice, since no detail below that survives the surface anyway.
 * Where a region's boundary is a straight base edge, this is a REGRESSION on
 * using that edge directly, which is why the caller only contours domes that
 * actually overlap something.
 */
import type { Pt2 } from '@/lib/geom/plan2d';
import { polygonArea } from '@/lib/geom/plan2d';

export interface ContourBox { minX: number; minY: number; maxX: number; maxY: number }

/**
 * Trace the boundary of `{ field > 0 }` inside `box`.
 *
 * Rings come back with the positive region on the LEFT of every segment, so
 * an outer boundary is counter-clockwise and a hole is clockwise — the
 * convention `polygonArea`'s sign already encodes, and the one every consumer
 * here expects.
 */
export function contourRegion(
  field: (p: Pt2) => number,
  box: ContourBox,
  spacingMm: number,
): Pt2[][] {
  const h = Math.max(1, spacingMm);
  // One cell of margin so a region touching the box still closes.
  const nx = Math.max(1, Math.ceil((box.maxX - box.minX) / h) + 2);
  const ny = Math.max(1, Math.ceil((box.maxY - box.minY) / h) + 2);
  if (nx * ny > 4_000_000) return [];

  const x0 = box.minX - h, y0 = box.minY - h;
  const at = (i: number, j: number): Pt2 => ({ x: x0 + i * h, y: y0 + j * h });

  const g = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const p = at(i, j);
      const v = field(p);
      // A sample landing exactly on the level would make a segment of zero
      // length and break the chaining; nudge it to one side.
      g[j * (nx + 1) + i] = Number.isFinite(v) ? (v === 0 ? -1e-9 : v) : -1;
    }
  }
  const val = (i: number, j: number) => g[j * (nx + 1) + i];

  /** Where the level crosses the segment between two corners. */
  const lerp = (a: Pt2, va: number, b: Pt2, vb: number): Pt2 => {
    const t = va / (va - vb);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };

  const segs: Array<[Pt2, Pt2]> = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const BL = at(i, j), BR = at(i + 1, j), TR = at(i + 1, j + 1), TL = at(i, j + 1);
      const vBL = val(i, j), vBR = val(i + 1, j), vTR = val(i + 1, j + 1), vTL = val(i, j + 1);
      const code = (vBL > 0 ? 1 : 0) | (vBR > 0 ? 2 : 0) | (vTR > 0 ? 4 : 0) | (vTL > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;

      // Crossing points on the four edges, when that edge changes sign.
      const B = () => lerp(BL, vBL, BR, vBR);
      const Rr = () => lerp(BR, vBR, TR, vTR);
      const T = () => lerp(TL, vTL, TR, vTR);
      const L = () => lerp(BL, vBL, TL, vTL);

      // Each segment runs so the POSITIVE side is on its left — derived per
      // case by walking the inside corner(s) counter-clockwise and keeping
      // the one edge that is not a cell edge. Get one of these backwards and
      // the ring still closes, but its area comes out negative and an outer
      // boundary is mistaken for a hole.
      switch (code) {
        case 1:  segs.push([B(), L()]); break;     // BL in
        case 2:  segs.push([Rr(), B()]); break;    // BR in
        case 3:  segs.push([Rr(), L()]); break;    // bottom half
        case 4:  segs.push([T(), Rr()]); break;    // TR in
        case 6:  segs.push([T(), B()]); break;     // right half
        case 7:  segs.push([T(), L()]); break;     // all but TL
        case 8:  segs.push([L(), T()]); break;     // TL in
        case 9:  segs.push([B(), T()]); break;     // left half
        case 11: segs.push([Rr(), T()]); break;    // all but TR
        case 12: segs.push([L(), Rr()]); break;    // top half
        case 13: segs.push([B(), Rr()]); break;    // all but BR
        case 14: segs.push([L(), B()]); break;     // all but BL
        // Saddles. The centre's own sign decides whether the two positive
        // corners join through the middle (so the NEGATIVE corners are
        // isolated pockets) or stay apart as two islands.
        case 5: {                                   // BL and TR in
          const centre = (vBL + vBR + vTR + vTL) / 4;
          if (centre > 0) { segs.push([B(), Rr()]); segs.push([T(), L()]); }
          else { segs.push([B(), L()]); segs.push([T(), Rr()]); }
          break;
        }
        case 10: {                                  // BR and TL in
          const centre = (vBL + vBR + vTR + vTL) / 4;
          if (centre > 0) { segs.push([L(), B()]); segs.push([Rr(), T()]); }
          else { segs.push([Rr(), B()]); segs.push([L(), T()]); }
          break;
        }
      }
    }
  }
  if (segs.length === 0) return [];

  // ── Chain the segments into rings ────────────────────────────────────────
  // Endpoints are snapped to a fraction of the grid so the two segments
  // meeting on a shared cell edge agree on where they meet.
  const snap = h * 1e-6;
  const key = (p: Pt2) => `${Math.round(p.x / snap)}_${Math.round(p.y / snap)}`;
  const starts = new Map<string, number[]>();
  segs.forEach(([a], idx) => {
    const k = key(a);
    const list = starts.get(k);
    if (list) list.push(idx); else starts.set(k, [idx]);
  });

  const used = new Uint8Array(segs.length);
  const rings: Pt2[][] = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    const ring: Pt2[] = [segs[s][0]];
    let cur = s;
    used[cur] = 1;
    for (let guard = 0; guard < segs.length + 2; guard++) {
      const end = segs[cur][1];
      ring.push(end);
      const next = (starts.get(key(end)) ?? []).find((idx) => !used[idx]);
      if (next === undefined) break;
      used[next] = 1;
      cur = next;
    }
    // Only closed rings describe a region; an open strand means the field
    // left the box, which the one-cell margin is there to prevent.
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) {
      ring.pop();
      rings.push(ring);
    }
  }
  return rings;
}

/** Drop rings whose area is below `minAreaMm2` — grid noise, not geometry. */
export function significantRings(rings: Pt2[][], minAreaMm2: number): Pt2[][] {
  return rings.filter((r) => Math.abs(polygonArea(r)) >= minAreaMm2);
}

/**
 * Split traced rings into outers (positive area) and holes (negative), the
 * orientation `contourRegion` guarantees.
 */
export function splitRings(rings: Pt2[][]): { outers: Pt2[][]; holes: Pt2[][] } {
  const outers: Pt2[][] = [];
  const holes: Pt2[][] = [];
  for (const r of rings) (polygonArea(r) >= 0 ? outers : holes).push(r);
  return { outers, holes };
}

/**
 * Thin a traced ring: drop vertices that sit within `tolMm` of the straight
 * line between their neighbours.
 *
 * Marching squares emits one vertex per grid cell along the curve, which is
 * far more than the geometry carries — and every one of them becomes a
 * Voronoi clip and a panel vertex downstream.
 */
export function simplifyRing(ring: Pt2[], tolMm: number): Pt2[] {
  const n = ring.length;
  if (n < 4 || !(tolMm > 0)) return ring;
  const out: Pt2[] = [];
  let anchor = ring[0];
  out.push(anchor);
  for (let i = 1; i < n; i++) {
    const p = ring[i];
    const next = ring[(i + 1) % n];
    const dx = next.x - anchor.x, dy = next.y - anchor.y;
    const len = Math.hypot(dx, dy);
    // Distance from p to the chord anchor→next.
    const d = len > 1e-9
      ? Math.abs((p.x - anchor.x) * dy - (p.y - anchor.y) * dx) / len
      : Math.hypot(p.x - anchor.x, p.y - anchor.y);
    if (d > tolMm) { out.push(p); anchor = p; }
  }
  return out.length >= 3 ? out : ring;
}
