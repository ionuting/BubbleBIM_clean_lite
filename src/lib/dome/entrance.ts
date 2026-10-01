/**
 * entrance.ts — the igloo tunnel.
 *
 * ## An entrance is not a new kind of geometry
 *
 * It is a small vault that overlaps the dome, and the cluster's `max` already
 * knows what to do with that: the tunnel shows where it stands proud of the
 * dome, the dome shows everywhere else, and the curve where they cross is the
 * doorway arch — grown by the same rule that grows the rim between two
 * bubbles, not drawn in as a special case. The two interiors are joined
 * because the union of the two solids is connected, so there is no wall to
 * cut a hole in and no hole-cutting code.
 *
 * ## The one thing that is not free: the mouth
 *
 * A membrane is pinned to zero all along its boundary, so a tunnel built as a
 * closed shape is a closed shape — a blister on the side of the dome, not a
 * way in. The fix is to build the vault LONGER than the tunnel and then stop
 * its region at the mouth plane. What is left ends on a cut rather than on a
 * pinned edge, and the section there is the arch you walk through. The rib
 * that lands on that edge is the door frame.
 *
 * So the mouth is a constraint on the region, not a shape in itself — which
 * is why it travels as a scalar field alongside the base, to be minimised
 * together with "inside my base" and "taller than the others".
 */
import { ensureCcw, polygonArea, type Pt2 } from '@/lib/geom/plan2d';

/** How far past the mouth the vault is built, as a multiple of its width. */
const OVERRUN = 0.75;

/** Area centroid of a simple polygon — where a tunnel starts from. */
export function polygonCentroid(poly: Pt2[]): Pt2 {
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const cr = p.x * q.y - q.x * p.y;
    a2 += cr;
    cx += (p.x + q.x) * cr;
    cy += (p.y + q.y) * cr;
  }
  if (Math.abs(a2) < 1e-9) {
    const n = poly.length || 1;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) };
}

/**
 * A stadium — a segment given width, with semicircular caps.
 *
 * Caps rather than square ends because the vault over a square end creases
 * into its two corners, and those creases would run right down the sides of
 * the doorway.
 */
export function stadiumPolygon(a: Pt2, b: Pt2, widthMm: number, capSegments = 16): Pt2[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const r = Math.max(1, widthMm) / 2;
  if (len < 1e-6) {
    return Array.from({ length: capSegments * 2 }, (_, i) => {
      const t = (i / (capSegments * 2)) * Math.PI * 2;
      return { x: a.x + r * Math.cos(t), y: a.y + r * Math.sin(t) };
    });
  }
  const ux = dx / len, uy = dy / len;          // along
  const nx = -uy, ny = ux;                      // left of travel
  const out: Pt2[] = [];
  // Right side a→b, then the cap at b, then the left side back, then cap at a.
  out.push({ x: a.x - nx * r, y: a.y - ny * r });
  out.push({ x: b.x - nx * r, y: b.y - ny * r });
  for (let i = 1; i < capSegments; i++) {
    const t = -Math.PI / 2 + (i / capSegments) * Math.PI;
    out.push({ x: b.x + r * (ux * Math.cos(t) + nx * Math.sin(t)), y: b.y + r * (uy * Math.cos(t) + ny * Math.sin(t)) });
  }
  out.push({ x: b.x + nx * r, y: b.y + ny * r });
  out.push({ x: a.x + nx * r, y: a.y + ny * r });
  for (let i = 1; i < capSegments; i++) {
    const t = Math.PI / 2 + (i / capSegments) * Math.PI;
    out.push({ x: a.x + r * (ux * Math.cos(t) + nx * Math.sin(t)), y: a.y + r * (uy * Math.cos(t) + ny * Math.sin(t)) });
  }
  return ensureCcw(out);
}

export interface EntranceGeometry {
  /** The vault's plan outline — longer than the tunnel, so the mouth can cut it. */
  base: Pt2[];
  /** Positive inside the tunnel, negative past the mouth. */
  mouthField: (p: Pt2) => number;
  /** Unit direction the tunnel runs, from inside the dome outward. */
  direction: Pt2;
  /** Where the mouth stands. */
  mouth: Pt2;
  /** Tunnel length from the dome's centroid to the mouth, mm. */
  lengthMm: number;
}

/**
 * Lay out a tunnel from inside `domeBasePoly` out to `mouthPoint`.
 *
 * It starts at the dome's centroid rather than at the rim: under the dome the
 * tunnel always loses the `max`, so the buried part costs nothing and never
 * has to be trimmed — while starting AT the rim would leave the two surfaces
 * meeting tangentially, which is exactly where a traced crease is least
 * stable.
 */
export function entranceGeometry(
  domeBasePoly: Pt2[],
  mouthPoint: Pt2,
  widthMm: number,
): EntranceGeometry | null {
  const c = polygonCentroid(domeBasePoly);
  const dx = mouthPoint.x - c.x, dy = mouthPoint.y - c.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1)) return null;
  const direction = { x: dx / len, y: dy / len };

  const overrun = Math.max(1, widthMm) * OVERRUN;
  const far = { x: mouthPoint.x + direction.x * overrun, y: mouthPoint.y + direction.y * overrun };

  return {
    base: stadiumPolygon(c, far, widthMm),
    mouthField: (p: Pt2) =>
      -((p.x - mouthPoint.x) * direction.x + (p.y - mouthPoint.y) * direction.y),
    direction,
    mouth: mouthPoint,
    lengthMm: len,
  };
}

/** Sanity of a tunnel against the dome it opens into. */
export function entranceFits(
  entranceHeightMm: number,
  domeHeightMm: number,
): { ok: boolean; reason?: string } {
  if (!(entranceHeightMm > 0)) {
    return { ok: false, reason: 'Înălțimea intrării trebuie să fie pozitivă.' };
  }
  if (entranceHeightMm >= domeHeightMm) {
    return {
      ok: false,
      reason: 'Intrarea e cel puțin la fel de înaltă ca domul — ar înghiți domul în loc să se deschidă în el.',
    };
  }
  return { ok: true };
}

/** True when the polygon winds counter-clockwise — used by the tests. */
export const isCcw = (poly: Pt2[]): boolean => polygonArea(poly) >= 0;
