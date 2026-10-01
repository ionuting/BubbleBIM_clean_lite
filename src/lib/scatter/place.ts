/**
 * place.ts — where the instances go. Pure: points and numbers in, points out.
 *
 * Area filling is dart throwing with a minimum gap — the same idea the dome's
 * seed points use — because it is the one method whose output a person can
 * predict: "about this dense, never closer than this". Path arraying is
 * arc-length stepping, exact and regular, because an array IS regularity.
 *
 * Both are driven by a seeded generator, so `seed` alone decides the
 * arrangement and the same inputs always give the same garden.
 */
import type { Pt2 } from '@/lib/geom/plan2d';
import { polygonArea, pointInPolygon } from '@/lib/geom/plan2d';

/** mulberry32 — small, fast, deterministic. */
export function scatterRng(seed: number): () => number {
  let s = (seed | 0) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function segDist(p: Pt2, a: Pt2, b: Pt2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Distance from a point to the nearest edge of a closed polygon. */
export function distToOutline(p: Pt2, poly: Pt2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = segDist(p, poly[j], poly[i]);
    if (d < best) best = d;
  }
  return best;
}

export interface AreaOpts {
  count: number;        // 0 = from spacing
  spacingMm: number;
  minGapMm: number;
  edgeMarginMm: number;
  seed: number;
}

/**
 * Fill a closed outline. Returns the points placed — possibly fewer than
 * asked when the gap and margin leave no room, which is the honest answer
 * rather than cramming.
 */
export function fillArea(outline: Pt2[], o: AreaOpts): Pt2[] {
  if (outline.length < 3) return [];
  const area = Math.abs(polygonArea(outline));
  if (area <= 0) return [];
  const target = o.count > 0
    ? o.count
    : Math.max(1, Math.round(area / (o.spacingMm * o.spacingMm)));

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of outline) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const rnd = scatterRng(o.seed);
  const out: Pt2[] = [];
  const gap2 = o.minGapMm * o.minGapMm;
  let attempts = 0;
  const maxAttempts = target * 40 + 50;
  while (out.length < target && attempts < maxAttempts) {
    attempts++;
    const p = { x: minX + rnd() * (maxX - minX), y: minY + rnd() * (maxY - minY) };
    if (!pointInPolygon(p, outline, 0)) continue;
    if (o.edgeMarginMm > 0 && distToOutline(p, outline) < o.edgeMarginMm) continue;
    let ok = true;
    if (gap2 > 0) {
      for (const q of out) {
        const dx = q.x - p.x, dy = q.y - p.y;
        if (dx * dx + dy * dy < gap2) { ok = false; break; }
      }
    }
    if (ok) out.push(p);
  }
  return out;
}

export interface PathStation extends Pt2 { /** Tangent heading, degrees CCW from +X. */ headingDeg: number }

export function pathLength(pts: Pt2[], closed: boolean): number {
  let L = 0;
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    L += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return L;
}

/**
 * Stations along a polyline. `count > 0` spreads exactly that many evenly
 * (endpoints included on an open path); otherwise one every `spacingMm`,
 * starting at the first point.
 */
export function arrayAlongPath(pts: Pt2[], closed: boolean, count: number, spacingMm: number): PathStation[] {
  if (pts.length < 2) return [];
  const L = pathLength(pts, closed);
  if (L <= 0) return [];
  let n: number, step: number;
  if (count > 0) {
    n = count;
    step = closed ? L / n : (n > 1 ? L / (n - 1) : 0);
  } else {
    n = closed ? Math.max(1, Math.round(L / spacingMm)) : Math.floor(L / spacingMm) + 1;
    step = spacingMm;
  }
  const out: PathStation[] = [];
  const segs = closed ? pts.length : pts.length - 1;
  for (let k = 0; k < n; k++) {
    let d = step * k;
    if (!closed) d = Math.min(d, L); // the last station sits on the end, never past it
    let acc = 0;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len <= 0) continue;
      if (d <= acc + len + 1e-6 || i === segs - 1) {
        const t = Math.max(0, Math.min(1, (d - acc) / len));
        out.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          headingDeg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
        });
        break;
      }
      acc += len;
    }
  }
  return out;
}
