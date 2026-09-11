/**
 * Step sizing — turning a floor-to-floor height into risers and treads.
 *
 * The rule that matters is that the risers must close the height EXACTLY. A
 * stair whose top step is a different height from the rest is a trip hazard, so
 * the riser is never rounded to a tidy number: the step COUNT is the integer,
 * and the riser is whatever the height divided by that count comes to.
 *
 * Everything that falls outside the design limits is reported, never silently
 * corrected. Quietly adjusting a width or a going would hide exactly the fact
 * the architect needs to see.
 */
import { STAIR_LIMITS, type StairDiagnostic, type StairIntent } from './types';

export interface StepSizing {
  /** Number of risers. Treads in a straight flight are always one fewer. */
  steps: number;
  riserMm: number;
  treadMm: number;
  /** 2h + g, the comfort rule's value. */
  comfortMm: number;
  /** Horizontal run consumed by the going of every tread. */
  runMm: number;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Solve the steps for a total rise.
 *
 * `auto` picks the step count nearest the preferred riser and derives the going
 * from the comfort rule; `explicit` takes the given riser as a target for the
 * count but still divides the height exactly, because any other reading would
 * either leave the stair short of the floor or produce an odd last step.
 */
export function solveSteps(
  totalRiseMm: number,
  intent: StairIntent,
  diagnostics: StairDiagnostic[] = [],
): StepSizing | null {
  if (!(totalRiseMm > 0)) {
    diagnostics.push({
      code: 'NO_RISE',
      severity: 'error',
      message: 'Stair has no height to climb — check the storey elevations above and below it.',
    });
    return null;
  }

  const target = intent.riserMm > 0 ? intent.riserMm : STAIR_LIMITS.riserMin;
  const steps = Math.max(1, Math.round(totalRiseMm / target));
  const riserMm = totalRiseMm / steps;

  if (intent.sizing === 'explicit' && Math.abs(riserMm - intent.riserMm) > 0.5) {
    diagnostics.push({
      code: 'RISER_ADJUSTED',
      severity: 'info',
      message:
        `Riser is ${round1(riserMm)} mm, not the ${round1(intent.riserMm)} mm asked for: `
        + `${steps} equal risers are what divides ${round1(totalRiseMm)} mm exactly. `
        + `A stair whose last step differs from the rest is a trip hazard.`,
    });
  }

  const treadMm = intent.treadMm > 0
    ? intent.treadMm
    : clamp(STAIR_LIMITS.comfortTarget - 2 * riserMm, STAIR_LIMITS.treadMin, STAIR_LIMITS.treadMax);

  const sizing: StepSizing = {
    steps,
    riserMm,
    treadMm,
    comfortMm: 2 * riserMm + treadMm,
    runMm: treadMm * steps,
  };

  checkLimits(sizing, intent, diagnostics);
  return sizing;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Report every limit the sizing misses, with the number and the nearest allowed one. */
function checkLimits(s: StepSizing, intent: StairIntent, diagnostics: StairDiagnostic[]): void {
  const L = STAIR_LIMITS;

  if (s.riserMm > L.riserMax) {
    diagnostics.push({
      code: 'RISER_TOO_HIGH',
      severity: 'warning',
      message:
        `Riser ${round1(s.riserMm)} mm is above the ${L.riserMax} mm limit. `
        + `Use ${Math.ceil(s.steps * s.riserMm / L.riserMax)} steps to bring it down.`,
    });
  } else if (s.riserMm < L.riserMin) {
    diagnostics.push({
      code: 'RISER_TOO_LOW',
      severity: 'warning',
      message:
        `Riser ${round1(s.riserMm)} mm is below the ${L.riserMin} mm minimum — the flight is `
        + `longer than it needs to be. Use ${Math.max(1, Math.floor(s.steps * s.riserMm / L.riserMin))} steps.`,
    });
  }

  if (s.treadMm < L.treadMin) {
    diagnostics.push({
      code: 'TREAD_TOO_SHALLOW',
      severity: 'warning',
      message: `Going ${round1(s.treadMm)} mm is below the ${L.treadMin} mm minimum.`,
    });
  } else if (s.treadMm > L.treadMax) {
    diagnostics.push({
      code: 'TREAD_TOO_DEEP',
      severity: 'info',
      message: `Going ${round1(s.treadMm)} mm is above the ${L.treadMax} mm usual maximum.`,
    });
  }

  if (s.comfortMm < L.comfortMin || s.comfortMm > L.comfortMax) {
    const wanted = clamp(L.comfortTarget - 2 * s.riserMm, L.treadMin, L.treadMax);
    diagnostics.push({
      code: 'COMFORT_OUT_OF_RANGE',
      severity: 'warning',
      message:
        `2h + g = ${round1(s.comfortMm)} mm, outside the ${L.comfortMin}–${L.comfortMax} mm comfort `
        + `range. A going of ${round1(wanted)} mm would put it at ${L.comfortTarget} mm.`,
    });
  }

  if (intent.widthMm < L.widthMin) {
    diagnostics.push({
      code: 'FLIGHT_TOO_NARROW',
      severity: 'warning',
      message: `Flight width ${round1(intent.widthMm)} mm is below the ${L.widthMin} mm minimum.`,
    });
  }
}

/**
 * How the risers split across the flights of a turning stair.
 *
 * The landing consumes NO risers: its surface IS the top of the arriving
 * flight's last riser, so the flights share all of them. An earlier version
 * "reserved" one riser per landing — a model in which you step UP onto the
 * landing edge — and the phantom step it implied was visible in 3D as a
 * landing floating one riser above the flight that arrives at it.
 *
 * Splitting as evenly as possible is what makes a half-turn stair look right;
 * an odd count puts the extra riser in the lower flight, which is the usual
 * choice because it keeps the upper flight shorter where headroom is tightest.
 */
export function splitFlights(steps: number, flightCount: number): number[] {
  if (flightCount <= 1) return [steps];

  const base = Math.floor(steps / flightCount);
  const extra = steps - base * flightCount;
  return Array.from({ length: flightCount }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Clear height under the flight above, at the point the two overlap.
 *
 * On a half-turn stair the upper flight runs back over the lower one, and the
 * tight spot is where the underside of the upper flight passes over the lower
 * walking line. Anything below the minimum means someone hits their head, and
 * it is also what decides how far the slab opening has to extend.
 */
export function headroomUnder(
  upperSurfaceZMm: number,
  lowerWalkingZMm: number,
  waistThicknessMm: number,
): number {
  return upperSurfaceZMm - waistThicknessMm - lowerWalkingZMm;
}

export function checkHeadroom(
  clearMm: number,
  where: string,
  diagnostics: StairDiagnostic[],
): void {
  if (clearMm >= STAIR_LIMITS.headroomMin) return;
  diagnostics.push({
    code: 'HEADROOM_LOW',
    severity: 'warning',
    message:
      `Only ${Math.round(clearMm)} mm clear ${where}, against a ${STAIR_LIMITS.headroomMin} mm `
      + `minimum. Lengthen the opening above, or move the landing.`,
  });
}
