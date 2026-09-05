/**
 * profile.ts — the cross-section of a flight, the way a cast stair is actually
 * shaped: a sawtooth of risers and treads on top, a sloping soffit underneath,
 * with the waist measured perpendicular between them.
 *
 * This is what makes the 3D read as a stair instead of a ramp. Revit and
 * ArchiCAD both draw the steps at every detail level for the same reason: a
 * smooth sloping slab is a structural abstraction, not a stair.
 *
 * Pure 2D in the flight's own vertical plane — `s` runs up the flight in plan,
 * `z` is height, both in mm, both relative to the walking-line START (the bottom
 * of the first riser). The 3D mapper extrudes this across the flight width; the
 * section viewers could draw it directly.
 */
import { ensureCcw } from '@/lib/geom/plan2d';
import type { Pt2 } from './types';

export interface FlightProfileOpts {
  /**
   * How far below its start level the flight's foot reaches — the thickness of
   * the landing it springs from. 0 (a ground-floor start) cuts the soffit off
   * at floor level; a landing start drops the foot to the landing's underside
   * so the two solids share their whole contact face.
   */
  footDropMm?: number;
  /**
   * Thickness of the slab or landing the flight arrives at. The flight's own
   * profile stops that far below the arrival level — the LANDING's edge face is
   * the visible part of the last riser — and a tail of waist runs on beneath it
   * until the soffit meets the landing's underside, the way monolithic concrete
   * is actually cast.
   *
   * Pass 0 for a flight that arrives somewhere nothing covers it — the top
   * floor of a model whose slab may not exist. The flight then carries its full
   * last riser itself, and `tailMm` bounds the nib of material behind it.
   */
  headDropMm?: number;
  /**
   * Explicit depth of the tail behind the last riser plane. Left unset it runs
   * until the soffit meets the arrival slab's underside (the landing case);
   * with `headDropMm: 0` it MUST be set, since the natural tail would put a
   * plateau at walking level a whole going deep.
   */
  tailMm?: number;
}

/**
 * Build the profile polygon for a flight of `steps` risers.
 *
 * Geometry worth writing down, because it is easy to get subtly wrong:
 *
 * - A flight of n risers has n−1 treads and a plan run of (n−1)·g: the last
 *   riser steps onto the landing or the floor above. That last riser is NOT
 *   part of this profile beyond a sliver — its visible face is the edge of the
 *   slab it arrives at. An earlier version drew it here as an up-and-down
 *   excursion on the same vertical line, and the zero-width spike it made
 *   rendered as a thin blade sticking out of the top of every flight.
 * - The steps' internal corners — riser bases and tread backs alike — all lie
 *   on the line z = (h/g)·s. The waist is the concrete at its THINNEST, so the
 *   soffit is parallel to that line, offset so the PERPENDICULAR distance is the
 *   waist. Two mistakes are close enough to look right: measuring vertically
 *   (thins the slab as the stair steepens), and measuring from the nosing line
 *   one riser higher — which leaves h·cosφ less concrete than asked, about
 *   146 mm short on a typical stair, i.e. nearly nothing.
 *
 * Returns null for a flight with no run (a single riser is a kerb, not a
 * stair) — the caller should fall back to a plain block.
 */
export function flightProfile(
  steps: number,
  riserMm: number,
  treadMm: number,
  waistMm: number,
  opts: FlightProfileOpts = {},
): Pt2[] | null {
  const n = Math.floor(steps);
  if (n < 2 || !(riserMm > 0) || !(treadMm > 0) || !(waistMm > 0)) return null;

  const h = riserMm;
  const g = treadMm;
  /** Vertical thickness of the waist, measured under the internal-corner line. */
  const drop = (waistMm * Math.hypot(g, h)) / g;
  // Neither end may drop below the soffit itself — a foot or head deeper than
  // the waist would turn the closure inside out.
  const headDrop = Math.min(Math.max(0, opts.headDropMm ?? waistMm), drop - 1e-6);
  const footDrop = Math.min(Math.max(0, opts.footDropMm ?? 0), drop - 1e-6);

  // The sawtooth: full risers 1..n−1, each with its tread. The nth riser
  // belongs to the arrival slab; this flight only rises the sliver between its
  // last tread and that slab's underside.
  const pts: Pt2[] = [{ x: 0, y: 0 }];
  for (let k = 0; k < n - 1; k++) {
    pts.push({ x: k * g, y: (k + 1) * h });                      // up riser k
    pts.push({ x: (k + 1) * g, y: (k + 1) * h });                // along tread k
  }
  const topY = n * h - headDrop;
  pts.push({ x: (n - 1) * g, y: topY });                         // up to the arrival level

  // The tail behind the last riser plane: by default it runs until the soffit
  // line z = (h/g)·s − drop reaches the arrival slab's underside; an explicit
  // tailMm cuts it short with a vertical back face — the nib a full-riser top
  // needs so its back face has actual material behind it.
  const soffitAt = (x: number) => (h / g) * x - drop;
  const naturalTailS = (g * (topY + drop)) / h;
  const tailS = opts.tailMm != null
    ? Math.min((n - 1) * g + Math.max(0, opts.tailMm), naturalTailS)
    : naturalTailS;
  pts.push({ x: tailS, y: topY });
  if (soffitAt(tailS) < topY - 1e-6) {
    pts.push({ x: tailS, y: soffitAt(tailS) });                  // vertical back face
  }

  // The foot: down the soffit until it reaches the start slab's underside,
  // then closed flat, so the flight sits on — or mates into — what it springs
  // from instead of running a waist-thickness below it.
  const footS = ((drop - footDrop) * g) / h;
  if (footS < tailS - 1e-6) {
    pts.push({ x: footS, y: -footDrop });
    if (footDrop > 1e-9) pts.push({ x: 0, y: -footDrop });
  } else {
    // A flight so short its soffit never surfaces — close at the front instead.
    pts.push({ x: 0, y: -drop });
  }

  return ensureCcw(pts);
}

/**
 * The foundation beam at the base of a cast stair, in section: an inverted T.
 * A wide flange spreads the load at the bottom and a narrower web rises to
 * floor level to anchor the flight's foot — it is what takes the thrust a
 * sloping slab delivers at its bearing.
 *
 * Same plane as `flightProfile`: `x` along the run, `y` up, relative to the
 * flight's walking-line start, so the web's top edge sits at (0, 0) directly
 * under the first riser. Extrude across the flight width like the flight
 * itself.
 */
export function invertedTeeProfile(
  webWidthMm: number,
  flangeWidthMm: number,
  flangeHeightMm: number,
  depthMm: number,
): Pt2[] | null {
  const ww = webWidthMm, wf = flangeWidthMm, hf = flangeHeightMm, d = depthMm;
  if (!(ww > 0) || !(hf > 0) || !(d > hf)) return null;
  // A flange no wider than the web is a rectangle — draw that instead of a
  // degenerate T with zero-length steps.
  if (wf <= ww + 1e-6) {
    return ensureCcw([
      { x: -ww / 2, y: -d }, { x: ww / 2, y: -d },
      { x: ww / 2, y: 0 }, { x: -ww / 2, y: 0 },
    ]);
  }
  return ensureCcw([
    { x: -wf / 2, y: -d },
    { x: wf / 2, y: -d },
    { x: wf / 2, y: -d + hf },
    { x: ww / 2, y: -d + hf },
    { x: ww / 2, y: 0 },
    { x: -ww / 2, y: 0 },
    { x: -ww / 2, y: -d + hf },
    { x: -wf / 2, y: -d + hf },
  ]);
}
