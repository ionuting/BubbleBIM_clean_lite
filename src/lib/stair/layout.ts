/**
 * Stair layout — laying the solved steps out in plan and elevation.
 *
 * Everything is built along the WALKING LINE: the path a person actually takes,
 * running up the centre of each flight and turning across each landing. That is
 * the line ArchiCAD's `baseLinePoints` wants, the line the 2D symbol draws, and
 * the line the flights hang off, so deriving it once keeps all three consistent.
 *
 * Landings are derived from where the flights actually END and START rather than
 * from a formula, so a quarter-turn and a half-turn need no special-casing: the
 * landing is simply the ground both flights need in order to meet.
 *
 * Plan convention matches the rest of the app: X east, Y north, mm throughout,
 * angles CCW from +X.
 */
import { splitFlights } from './dimensioning';
import type { StepSizing } from './dimensioning';
import {
  type Pt2,
  type Pt3,
  type StairFlight,
  type StairGeometry,
  type StairIntent,
  type StairLanding,
  type StairWinder,
} from './types';

const deg2rad = (d: number) => (d * Math.PI) / 180;
const unit = (rad: number): Pt2 => ({ x: Math.cos(rad), y: Math.sin(rad) });
/** Left-hand normal — "across the flight", looking up it. */
const across = (d: Pt2): Pt2 => ({ x: -d.y, y: d.x });
const rot = (v: Pt2, rad: number): Pt2 => ({
  x: v.x * Math.cos(rad) - v.y * Math.sin(rad),
  y: v.x * Math.sin(rad) + v.y * Math.cos(rad),
});

/** How many flights each stair type has, and therefore how many landings. */
export function flightCountFor(stairType: StairIntent['stairType']): number {
  return stairType === 'straight' ? 1 : 2;
}

/**
 * The heading of each flight, in radians.
 *
 * A quarter-turn leaves at 90° from the first flight; a half-turn doubles back.
 * `turn` decides the sign, which is the difference between a stair that winds
 * into the room and one that winds into the wall.
 */
function flightHeadings(intent: StairIntent): number[] {
  const first = deg2rad(intent.directionDeg);
  const sign = intent.turn === 'left' ? 1 : -1;
  switch (intent.stairType) {
    case 'l_shape': return [first, first + sign * Math.PI / 2];
    case 'u_shape': return [first, first + sign * Math.PI];
    default: return [first];
  }
}

/**
 * A spiral stair: every step a wedge winding around a centre pole.
 *
 * The walking line is the circle at mid-width; the going the sizing solved is
 * honoured THERE, which is what the comfort rule applies to — the tread is
 * narrower toward the pole and wider outside, as every spiral is. The angle per
 * step therefore falls straight out: Δ = going / walkingRadius.
 *
 * `origin` stays the walking-line start, like every other type, so switching a
 * straight stair to a spiral pivots it around the same bottom step.
 */
function layoutSpiral(
  origin: Pt2,
  bottomZMm: number,
  sizing: StepSizing,
  intent: StairIntent,
): StairGeometry {
  const sign = intent.turn === 'left' ? 1 : -1;
  const rI = Math.max(0, intent.spiralInnerMm);
  const rO = rI + intent.widthMm;
  const rW = rI + intent.widthMm / 2;
  const delta = (sizing.treadMm / rW) * sign;

  const dir0 = unit(deg2rad(intent.directionDeg));
  // Turning left means the centre is on the walker's left.
  const center: Pt2 = {
    x: origin.x + across(dir0).x * sign * rW,
    y: origin.y + across(dir0).y * sign * rW,
  };
  const a0 = Math.atan2(origin.y - center.y, origin.x - center.x);
  const at = (rad: number, r: number): Pt2 => ({
    x: center.x + Math.cos(rad) * r,
    y: center.y + Math.sin(rad) * r,
  });

  const n = sizing.steps;
  const winders: StairWinder[] = [];
  // n risers, n−1 wedge treads: the last riser tops onto the floor above.
  for (let j = 1; j <= n - 1; j++) {
    const ta = a0 + (j - 1) * delta;
    const tb = a0 + j * delta;
    winders.push({
      index: j - 1,
      polygon: [
        at(ta, rI), at(ta, rO),
        at((ta + tb) / 2, rO),        // one midpoint keeps the outer arc round-ish
        at(tb, rO), at(tb, rI),
      ],
      zTopMm: bottomZMm + j * sizing.riserMm,
      riserMm: sizing.riserMm,
      nosing: { a: at(ta, rI), b: at(ta, rO) },
      walkMm: sizing.treadMm,
    });
  }

  const baseline: Pt3[] = [];
  for (let j = 0; j <= n; j++) {
    const p = at(a0 + j * delta, rW);
    baseline.push({ x: p.x, y: p.y, z: bottomZMm + j * sizing.riserMm });
  }

  // The opening must clear the whole drum, whatever arc the stair sweeps.
  const circle: Pt2[] = Array.from({ length: 16 }, (_, k) => at((k * Math.PI) / 8, rO));

  return {
    flights: [],
    landings: [],
    winders,
    spiral: { center, innerMm: rI, outerMm: rO, startRad: a0, deltaRad: delta },
    baseline,
    footprint: hullRect(circle),
    boundary: null,
    bottomZMm,
    topZMm: bottomZMm + n * sizing.riserMm,
    steps: n,
    riserMm: sizing.riserMm,
    treadMm: sizing.treadMm,
  };
}

/**
 * The winder fan replacing a landing: `count` wedge steps pivoting on the turn's
 * inner corner, clipped to the same rectangle the landing would have occupied.
 *
 * The rays from the pivot advance monotonically along the rectangle's boundary,
 * so each winder is [pivot, hit_k, any rectangle corners passed, hit_k+1] — no
 * general polygon clipping needed.
 */
function fanWinders(
  pivot: Pt2,
  ray0: Pt2,
  totalRad: number,
  count: number,
  region: Pt2[],
): { polys: Pt2[][]; nosings: { a: Pt2; b: Pt2 }[]; mids: (rad: number) => Pt2 } {
  const m = region.length;
  const hit = (dir: Pt2): { p: Pt2; param: number } => {
    let best: { p: Pt2; param: number; t: number } | null = null;
    for (let i = 0; i < m; i++) {
      const a = region[i], b = region[(i + 1) % m];
      const ex = b.x - a.x, ey = b.y - a.y;
      const den = dir.x * ey - dir.y * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a.x - pivot.x) * ey - (a.y - pivot.y) * ex) / den;
      // s = ((a−p) × dir) / (dir × e); the denominator here IS den, not −den —
      // the flipped sign rejected true hits and accepted points on the edges'
      // EXTENSIONS, which is what drew a kite through the corner of the fan.
      const s = ((a.x - pivot.x) * dir.y - (a.y - pivot.y) * dir.x) / den;
      if (t > 1e-6 && s >= -1e-9 && s <= 1 + 1e-9) {
        if (!best || t < best.t) best = { p: { x: pivot.x + dir.x * t, y: pivot.y + dir.y * t }, param: i + Math.min(1, Math.max(0, s)), t };
      }
    }
    // The pivot sits on the boundary and every ray sweeps the interior, so a
    // miss can only be numerical; fall back to the ray at region scale.
    return best ?? { p: { x: pivot.x + dir.x, y: pivot.y + dir.y }, param: 0 };
  };

  const rays = Array.from({ length: count + 1 }, (_, k) => hit(rot(ray0, (totalRad * k) / count)));
  const forward = totalRad > 0;

  const polys: Pt2[][] = [];
  const nosings: { a: Pt2; b: Pt2 }[] = [];
  for (let k = 0; k < count; k++) {
    const from = rays[k], to = rays[k + 1];
    const poly: Pt2[] = [pivot, from.p];
    // Rectangle corners passed between the two hits, in sweep order.
    const span = forward
      ? (to.param - from.param + m) % m
      : (from.param - to.param + m) % m;
    for (let step = 1; step < m; step++) {
      const idx = forward
        ? Math.floor(from.param + step)
        : Math.ceil(from.param - step);
      const covered = forward
        ? (idx - from.param + m) % m
        : (from.param - idx + m) % m;
      if (covered >= span - 1e-9) break;
      poly.push(region[((idx % m) + m) % m]);
    }
    poly.push(to.p);
    polys.push(poly);
    nosings.push({ a: pivot, b: from.p });
  }
  return { polys, nosings, mids: (rad: number) => ({ x: pivot.x + Math.cos(rad), y: pivot.y + Math.sin(rad) }) };
}

/**
 * Build the full geometry.
 *
 * `origin` is where the walking line STARTS — the bottom of the first riser, on
 * the lower floor. Everything else follows from it, the headings and the solved
 * steps, so moving the stairwell node moves the whole assembly rigidly.
 */
export function layoutStair(
  origin: Pt2,
  bottomZMm: number,
  sizing: StepSizing,
  intent: StairIntent,
): StairGeometry {
  if (intent.stairType === 'spiral') return layoutSpiral(origin, bottomZMm, sizing, intent);

  const headings = flightHeadings(intent);
  const winderTurn = intent.turnStyle === 'winder' && headings.length > 1;
  const winderCount = Math.max(1, Math.round(intent.winderCount));
  // Each winder is a walking surface of its own, so W winders absorb W−1 risers
  // that the straight flights therefore do not climb. A landing is the W=1
  // case: one surface, no risers consumed.
  const straightSteps = winderTurn
    ? sizing.steps - (winderCount - 1) * (headings.length - 1)
    : sizing.steps;
  const perFlight = splitFlights(straightSteps, headings.length);
  const landingDepth = intent.landingDepthMm > 0 ? intent.landingDepthMm : intent.widthMm;
  const sign = intent.turn === 'left' ? 1 : -1;

  const flights: StairFlight[] = [];
  const landings: StairLanding[] = [];
  const winders: StairWinder[] = [];
  const baseline: Pt3[] = [];

  let cursor: Pt2 = { x: origin.x, y: origin.y };
  let z = bottomZMm;
  baseline.push({ x: cursor.x, y: cursor.y, z });

  for (let i = 0; i < headings.length; i++) {
    const dir = unit(headings[i]);
    const steps = perFlight[i];

    // A flight of n risers advances (n − 1) goings in plan: the last riser steps
    // up onto the landing (or the floor above) without advancing another tread.
    const runMm = Math.max(0, steps - 1) * sizing.treadMm;

    const start: Pt3 = { x: cursor.x, y: cursor.y, z };
    const end: Pt3 = {
      x: cursor.x + dir.x * runMm,
      y: cursor.y + dir.y * runMm,
      z: z + steps * sizing.riserMm,
    };

    flights.push({
      index: i,
      start, end, steps,
      riserMm: sizing.riserMm,
      treadMm: sizing.treadMm,
      widthMm: intent.widthMm,
    });

    cursor = { x: end.x, y: end.y };
    z = end.z;
    baseline.push({ x: cursor.x, y: cursor.y, z });

    if (i === headings.length - 1) break;

    // ── Landing, and where the next flight begins ──
    // The landing sits flush with the arrival: its surface IS the top of this
    // flight's last riser. No height is added here — the earlier version that
    // treated the landing edge as one more riser drew a landing floating a step
    // above the flight, with nothing to climb it by.
    const next = unit(headings[i + 1]);
    const a = across(dir);
    const half = intent.widthMm / 2;

    // A quarter turn and a half turn are genuinely different constructions, and
    // treating them the same is what makes a drawn stair look wrong:
    //
    //   quarter  the landing is `landingDepth` deep by ONE flight width across,
    //            and the next flight leaves through its SIDE. So that flight
    //            centres half the depth in, and starts at the side edge.
    //   half     the two flights nest side by side over the SAME plan extent:
    //            the last riser of the flight below and the first riser of the
    //            flight above share one plane — the landing's near edge — and
    //            the landing extends beyond them both. Starting the upper
    //            flight at the FAR edge instead (an earlier version) shifted it
    //            a whole landing-depth out of line with its pair.
    let nextStart: Pt2;
    let acrossSpan: [number, number];
    if (intent.stairType === 'u_shape') {
      nextStart = {
        x: cursor.x + a.x * sign * intent.widthMm,
        y: cursor.y + a.y * sign * intent.widthMm,
      };
      acrossSpan = sign > 0
        ? [-half, intent.widthMm + half]
        : [-intent.widthMm - half, half];
    } else {
      nextStart = {
        x: cursor.x + dir.x * (landingDepth / 2) + next.x * half,
        y: cursor.y + dir.y * (landingDepth / 2) + next.y * half,
      };
      acrossSpan = [-half, half];
    }

    if (winderTurn) {
      // ── The fan: winder steps climbing through the corner ──
      // Pivot on the turn's inner corner; the fan sweeps from the arrival plane
      // to the departure plane, clipped to the same rectangle the landing would
      // have filled. Each winder is one riser, so the corner itself climbs.
      const turnRad = (intent.stairType === 'u_shape' ? Math.PI : Math.PI / 2) * sign;
      const pivot: Pt2 = {
        x: cursor.x + a.x * sign * half,
        y: cursor.y + a.y * sign * half,
      };
      const region = landingRect(cursor, dir, a, landingDepth, acrossSpan);
      const ray0: Pt2 = { x: -a.x * sign, y: -a.y * sign };
      const fan = fanWinders(pivot, ray0, turnRad, winderCount, region);

      const walkMm = (Math.abs(turnRad) / winderCount) * half;
      for (let k = 0; k < winderCount; k++) {
        winders.push({
          index: winders.length,
          polygon: fan.polys[k],
          // Winder 1 IS the arrival surface, flush like a landing; the rest
          // climb one riser each.
          zTopMm: z + k * sizing.riserMm,
          riserMm: sizing.riserMm,
          nosing: fan.nosings[k],
          walkMm,
        });
        // Walking line through the middle of each winder, at half a width from
        // the pivot — where the going is measured.
        const midRad = Math.atan2(-a.y * sign, -a.x * sign) + (turnRad * (k + 0.5)) / winderCount;
        baseline.push({
          x: pivot.x + Math.cos(midRad) * half,
          y: pivot.y + Math.sin(midRad) * half,
          z: z + k * sizing.riserMm,
        });
      }
      z += (winderCount - 1) * sizing.riserMm;
    } else {
      landings.push({
        index: i,
        polygon: landingRect(cursor, dir, a, landingDepth, acrossSpan),
        levelMm: z,
        thicknessMm: intent.thicknessMm,
      });
    }

    cursor = nextStart;
    baseline.push({ x: cursor.x, y: cursor.y, z });
  }

  return {
    flights,
    landings,
    winders,
    spiral: null,
    baseline,
    footprint: hullRect(occupiedCorners(flights, landings, winders)),
    // Set by the solver when a shaft is wired; layout itself only ever lays out.
    boundary: null,
    bottomZMm,
    topZMm: z,
    steps: sizing.steps,
    riserMm: sizing.riserMm,
    treadMm: sizing.treadMm,
  };
}

/**
 * The landing slab, as a rectangle in the arriving flight's own frame.
 *
 * Built in that frame rather than as an axis-aligned box on purpose: a stair
 * running at an angle would otherwise get a landing squared to the site grid,
 * far larger than the turn needs and visibly out of line with its own flights.
 *
 * `alongMm` is the depth measured up the arriving run; `acrossSpan` is where the
 * slab reaches sideways, which is what differs between a quarter and a half turn.
 */
function landingRect(
  arrive: Pt2,
  inDir: Pt2,
  acrossDir: Pt2,
  alongMm: number,
  acrossSpan: [number, number],
): Pt2[] {
  const [s0, s1] = acrossSpan;
  const at = (along: number, side: number): Pt2 => ({
    x: arrive.x + inDir.x * along + acrossDir.x * side,
    y: arrive.y + inDir.y * along + acrossDir.y * side,
  });
  return [at(0, s0), at(alongMm, s0), at(alongMm, s1), at(0, s1)];
}

/**
 * Every plan corner the assembly occupies.
 *
 * Exported because the shaft-fit check needs the REAL corners, not the
 * axis-aligned footprint below: a stair running at 37° would look far too wide
 * measured by its bounding box and would report an overflow that is not there.
 */
export function occupiedCorners(
  flights: StairFlight[],
  landings: StairLanding[],
  winders: StairWinder[] = [],
): Pt2[] {
  const pts: Pt2[] = [];
  for (const f of flights) {
    const dx = f.end.x - f.start.x, dy = f.end.y - f.start.y;
    const len = Math.hypot(dx, dy) || 1;
    const a = across({ x: dx / len, y: dy / len });
    const half = f.widthMm / 2;
    for (const p of [f.start, f.end]) {
      pts.push({ x: p.x + a.x * half, y: p.y + a.y * half });
      pts.push({ x: p.x - a.x * half, y: p.y - a.y * half });
    }
  }
  for (const l of landings) pts.push(...l.polygon);
  for (const w of winders) pts.push(...w.polygon);
  return pts;
}

/**
 * Axis-aligned bounding rectangle, CCW.
 *
 * The footprint stays a rectangle rather than a tight polygon on purpose: it is
 * what sizes the slab opening, and an opening must be at least as large as what
 * passes through it. A tight outline that clipped a corner would leave the stair
 * poking into the slab.
 */
function hullRect(pts: Pt2[]): Pt2[] {
  if (!pts.length) return [];
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  return [
    { x: minX, y: minY }, { x: maxX, y: minY },
    { x: maxX, y: maxY }, { x: minX, y: maxY },
  ];
}

/**
 * The individual steps of a flight, as walking surfaces.
 *
 * Step k's tread sits k risers above the flight's start. Only built at the
 * `steps` detail level — a 17-step flight is 17 extra nodes, worth it for a
 * rendering and not worth it for a massing model.
 */
export function treadsOf(flight: StairFlight): { centre: Pt3; dir: Pt2 }[] {
  const dx = flight.end.x - flight.start.x, dy = flight.end.y - flight.start.y;
  const len = Math.hypot(dx, dy);
  const dir = len > 0 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };

  const out: { centre: Pt3; dir: Pt2 }[] = [];
  for (let k = 1; k <= flight.steps; k++) {
    const along = (k - 1) * flight.treadMm;
    out.push({
      centre: {
        x: flight.start.x + dir.x * (along + flight.treadMm / 2),
        y: flight.start.y + dir.y * (along + flight.treadMm / 2),
        z: flight.start.z + k * flight.riserMm,
      },
      dir,
    });
  }
  return out;
}
