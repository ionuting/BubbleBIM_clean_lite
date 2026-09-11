/**
 * Step sizing. The invariant that matters above all others: the risers must
 * close the floor-to-floor height EXACTLY. Everything else is advice.
 */
import { describe, expect, it } from 'vitest';
import { checkHeadroom, headroomUnder, solveSteps, splitFlights } from './dimensioning';
import { DEFAULT_STAIR_INTENT, STAIR_LIMITS, type StairDiagnostic, type StairIntent } from './types';

const intent = (over: Partial<StairIntent> = {}): StairIntent => ({ ...DEFAULT_STAIR_INTENT, ...over });

describe('solveSteps', () => {
  it('divides a typical storey height into equal risers', () => {
    const d: StairDiagnostic[] = [];
    const s = solveSteps(2900, intent({ riserMm: 170 }), d)!;

    expect(s.steps).toBe(17);
    expect(s.riserMm).toBeCloseTo(170.588, 3);
    expect(s.treadMm).toBeCloseTo(288.8, 1);   // comfortTarget − 2h
    expect(s.comfortMm).toBeCloseTo(STAIR_LIMITS.comfortTarget, 6);
    expect(d.filter((x) => x.severity === 'warning')).toEqual([]);
  });

  it('closes the height exactly, whatever the rise', () => {
    for (const rise of [2600, 2750, 2900, 3050, 3200, 2437]) {
      const s = solveSteps(rise, intent())!;
      expect(s.steps * s.riserMm).toBeCloseTo(rise, 6);
    }
  });

  it('keeps the riser exact rather than the round number asked for', () => {
    const d: StairDiagnostic[] = [];
    // 2900 / 175 is not an integer, so an exact 175 mm riser cannot reach the floor.
    const s = solveSteps(2900, intent({ sizing: 'explicit', riserMm: 175 }), d)!;

    expect(s.steps * s.riserMm).toBeCloseTo(2900, 6);
    expect(s.riserMm).not.toBeCloseTo(175, 1);
    expect(d.map((x) => x.code)).toContain('RISER_ADJUSTED');
  });

  it('honours an explicit going instead of deriving one', () => {
    const s = solveSteps(2900, intent({ treadMm: 300 }))!;
    expect(s.treadMm).toBe(300);
  });

  it('warns when the riser comes out too steep, and says how many steps would fix it', () => {
    const d: StairDiagnostic[] = [];
    solveSteps(3600, intent({ riserMm: 200 }), d);
    const w = d.find((x) => x.code === 'RISER_TOO_HIGH')!;
    expect(w.severity).toBe('warning');
    expect(w.message).toMatch(/steps to bring it down/);
  });

  it('warns when the comfort rule is missed', () => {
    const d: StairDiagnostic[] = [];
    solveSteps(2900, intent({ treadMm: 250 }), d);   // 2h + g = 591
    expect(d.map((x) => x.code)).toContain('COMFORT_OUT_OF_RANGE');
  });

  it('warns about a narrow flight', () => {
    const d: StairDiagnostic[] = [];
    solveSteps(2900, intent({ widthMm: 800 }), d);
    expect(d.map((x) => x.code)).toContain('FLIGHT_TOO_NARROW');
  });

  it('refuses a stair with nowhere to climb', () => {
    const d: StairDiagnostic[] = [];
    expect(solveSteps(0, intent(), d)).toBeNull();
    expect(d[0].severity).toBe('error');
  });
});

describe('splitFlights', () => {
  it('leaves a straight stair whole', () => {
    expect(splitFlights(17, 1)).toEqual([17]);
  });

  it('shares every riser between the flights — the landing consumes none', () => {
    // The landing surface IS the top of the arriving flight's last riser.
    // Reserving a riser for it (as an earlier version did) implies a phantom
    // step at the landing edge that no geometry draws.
    const parts = splitFlights(17, 2);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(17);
  });

  it('splits as evenly as it can, extra riser in the lower flight', () => {
    expect(splitFlights(18, 2)).toEqual([9, 9]);
    expect(splitFlights(17, 2)).toEqual([9, 8]);
  });
});

describe('headroom', () => {
  it('measures the clear height under the flight above', () => {
    expect(headroomUnder(4500, 2200, 150)).toBe(2150);
  });

  it('warns only when the clearance is short, and names both numbers', () => {
    const ok: StairDiagnostic[] = [];
    checkHeadroom(2150, 'at the landing', ok);
    expect(ok).toEqual([]);

    const bad: StairDiagnostic[] = [];
    checkHeadroom(1850, 'at the landing', bad);
    expect(bad[0].message).toMatch(/1850 mm clear at the landing/);
    expect(bad[0].message).toMatch(String(STAIR_LIMITS.headroomMin));
  });
});
