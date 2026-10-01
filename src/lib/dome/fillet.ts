/**
 * fillet.ts — rounding the corners of a base contour.
 *
 * A membrane over a polygon pulls into a point at every corner: the boundary
 * is pinned at zero along both edges, so the surface creases into the vertex
 * and the panels there come out as slivers. Rounding the corner is not
 * decoration — it is what turns a polygon into something a bubble would
 * actually sit on.
 *
 * ## The arc
 *
 * At a corner of interior angle θ, an arc of radius r meets the two edges at
 * a distance t = r / tan(θ/2) from the vertex. That distance is the whole
 * geometry: too large and the arc runs past the neighbouring corner, so t is
 * clamped to half of each adjacent edge and the radius that survives is
 * recomputed from the clamped t. A corner therefore rounds by AT MOST what
 * its edges can give, and rounding one corner can never eat another's.
 *
 * ## Reflex corners
 *
 * A concave corner is filleted too, with the arc bulging the other way — the
 * centre falls outside the polygon and the sweep reverses. Skipping them
 * would leave a notch sharp while its neighbours softened, which reads as a
 * mistake rather than a choice.
 */
import { polygonArea, type Pt2 } from '@/lib/geom/plan2d';

/** Chord below which an arc is emitted as a straight line, mm. */
const ARC_CHORD_MM = 40;

const norm = (v: Pt2): Pt2 | null => {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : null;
};

/**
 * Round every corner of a simple polygon by `radiusMm`.
 *
 * Returns the polygon unchanged for a non-positive radius. Winding is
 * preserved. Corners that are already straight are left alone — an arc there
 * would be a no-op that only adds vertices.
 */
export function filletPolygon(poly: Pt2[], radiusMm: number): Pt2[] {
  const n = poly.length;
  if (n < 3 || !(radiusMm > 0)) return poly;
  const ccw = polygonArea(poly) >= 0;

  const out: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const V = poly[i];
    const P = poly[(i - 1 + n) % n];
    const N = poly[(i + 1) % n];
    const d1 = norm({ x: P.x - V.x, y: P.y - V.y });
    const d2 = norm({ x: N.x - V.x, y: N.y - V.y });
    if (!d1 || !d2) { out.push(V); continue; }

    const cosT = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y));
    const theta = Math.acos(cosT);
    // Straight through, or folded back on itself: no corner to round.
    if (theta > Math.PI - 1e-6 || theta < 1e-6) { out.push(V); continue; }

    const half = theta / 2;
    // Half the edge, so two adjacent fillets meet at worst, never overlap.
    const maxT = Math.min(
      Math.hypot(P.x - V.x, P.y - V.y) / 2,
      Math.hypot(N.x - V.x, N.y - V.y) / 2,
    );
    const t = Math.min(radiusMm / Math.tan(half), maxT);
    if (!(t > 1e-6)) { out.push(V); continue; }
    const r = t * Math.tan(half);

    const T1 = { x: V.x + d1.x * t, y: V.y + d1.y * t };
    const T2 = { x: V.x + d2.x * t, y: V.y + d2.y * t };
    const bis = norm({ x: d1.x + d2.x, y: d1.y + d2.y });
    if (!bis) { out.push(V); continue; }
    const C = { x: V.x + bis.x * (r / Math.sin(half)), y: V.y + bis.y * (r / Math.sin(half)) };

    const a1 = Math.atan2(T1.y - C.y, T1.x - C.x);
    const a2 = Math.atan2(T2.y - C.y, T2.x - C.x);
    // Sweep the short way round; its sign follows the corner's turn, so a
    // reflex corner bulges outward instead of cutting across the polygon.
    let sweep = a2 - a1;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;

    const steps = Math.max(2, Math.ceil(Math.abs(sweep) * r / ARC_CHORD_MM));
    for (let s = 0; s <= steps; s++) {
      const a = a1 + (sweep * s) / steps;
      out.push({ x: C.x + r * Math.cos(a), y: C.y + r * Math.sin(a) });
    }
  }

  // Drop points the arcs landed on top of each other.
  const clean: Pt2[] = [];
  for (const p of out) {
    const prev = clean[clean.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.5) continue;
    clean.push(p);
  }
  if (clean.length > 1) {
    const a = clean[0], b = clean[clean.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.5) clean.pop();
  }
  if (clean.length < 3) return poly;
  // A fillet cannot flip the winding; if arithmetic says otherwise, the
  // radius overwhelmed the shape and the original is the safer answer.
  return (polygonArea(clean) >= 0) === ccw ? clean : poly;
}
