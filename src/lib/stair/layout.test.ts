/**
 * Layout. The load-bearing property is that the geometry ARRIVES: the last
 * walking-line point must sit exactly on the upper floor, for every stair type.
 * A stair that lands 20 mm out is worse than no stair.
 */
import { describe, expect, it } from 'vitest';
import { solveSteps } from './dimensioning';
import { flightCountFor, layoutStair, treadsOf } from './layout';
import { DEFAULT_STAIR_INTENT, type StairIntent } from './types';
import { isSimplePolygon, polygonArea } from '@/lib/geom/plan2d';

const RISE = 2900;
const BOTTOM = 0;
const intent = (over: Partial<StairIntent> = {}): StairIntent => ({ ...DEFAULT_STAIR_INTENT, ...over });

const build = (over: Partial<StairIntent> = {}) => {
  const i = intent(over);
  return layoutStair({ x: 0, y: 0 }, BOTTOM, solveSteps(RISE, i)!, i);
};

describe('arrival', () => {
  for (const stairType of ['straight', 'l_shape', 'u_shape'] as const) {
    it(`lands exactly on the upper floor — ${stairType}`, () => {
      const g = build({ stairType });
      expect(g.topZMm).toBeCloseTo(BOTTOM + RISE, 6);
      expect(g.baseline[g.baseline.length - 1].z).toBeCloseTo(BOTTOM + RISE, 6);
    });

    it(`accounts for every riser exactly once — ${stairType}`, () => {
      const g = build({ stairType });
      const climbed = g.flights.reduce((s, f) => s + f.steps, 0);
      expect(climbed).toBe(g.steps);
    });
  }
});

describe('flight counts', () => {
  it('turns a straight run into one flight and no landing', () => {
    const g = build({ stairType: 'straight' });
    expect(g.flights).toHaveLength(1);
    expect(g.landings).toHaveLength(0);
    expect(flightCountFor('straight')).toBe(1);
  });

  it('gives an L and a U two flights and one landing', () => {
    for (const stairType of ['l_shape', 'u_shape'] as const) {
      const g = build({ stairType });
      expect(g.flights).toHaveLength(2);
      expect(g.landings).toHaveLength(1);
    }
  });
});

describe('plan geometry', () => {
  it('runs the first flight along the given direction', () => {
    const g = build({ stairType: 'straight', directionDeg: 0 });
    const f = g.flights[0];
    expect(f.end.y).toBeCloseTo(f.start.y, 6);
    expect(f.end.x).toBeGreaterThan(f.start.x);
  });

  it('rotates the whole assembly with the direction', () => {
    const a = build({ stairType: 'straight', directionDeg: 0 });
    const b = build({ stairType: 'straight', directionDeg: 90 });
    const runA = Math.hypot(a.flights[0].end.x - a.flights[0].start.x, a.flights[0].end.y - a.flights[0].start.y);
    const runB = Math.hypot(b.flights[0].end.x - b.flights[0].start.x, b.flights[0].end.y - b.flights[0].start.y);
    expect(runB).toBeCloseTo(runA, 6);
    expect(b.flights[0].end.x).toBeCloseTo(b.flights[0].start.x, 6); // now runs along +Y
  });

  it('advances one going per tread, not per riser', () => {
    // A flight of n risers has n−1 goings: the last riser steps onto the floor.
    const g = build({ stairType: 'straight' });
    const f = g.flights[0];
    const run = Math.hypot(f.end.x - f.start.x, f.end.y - f.start.y);
    expect(run).toBeCloseTo((f.steps - 1) * f.treadMm, 6);
  });

  it('doubles a half-turn back on itself', () => {
    const g = build({ stairType: 'u_shape', directionDeg: 0 });
    const [f1, f2] = g.flights;
    const d1 = { x: f1.end.x - f1.start.x, y: f1.end.y - f1.start.y };
    const d2 = { x: f2.end.x - f2.start.x, y: f2.end.y - f2.start.y };
    const dot = d1.x * d2.x + d1.y * d2.y;
    expect(dot).toBeLessThan(0); // opposing directions
  });

  it('turns a quarter-turn through 90°', () => {
    const g = build({ stairType: 'l_shape', directionDeg: 0 });
    const [f1, f2] = g.flights;
    const d1 = { x: f1.end.x - f1.start.x, y: f1.end.y - f1.start.y };
    const d2 = { x: f2.end.x - f2.start.x, y: f2.end.y - f2.start.y };
    const dot = d1.x * d2.x + d1.y * d2.y;
    expect(dot).toBeCloseTo(0, 6);
  });

  it('turns the other way when asked', () => {
    const left = build({ stairType: 'l_shape', directionDeg: 0, turn: 'left' });
    const right = build({ stairType: 'l_shape', directionDeg: 0, turn: 'right' });
    expect(Math.sign(left.flights[1].end.y - left.flights[1].start.y))
      .toBe(-Math.sign(right.flights[1].end.y - right.flights[1].start.y));
  });
});

describe('footprint', () => {
  it('encloses every flight and landing corner', () => {
    for (const stairType of ['straight', 'l_shape', 'u_shape'] as const) {
      const g = build({ stairType });
      const xs = g.footprint.map((p) => p.x), ys = g.footprint.map((p) => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);

      for (const f of g.flights) {
        for (const p of [f.start, f.end]) {
          expect(p.x).toBeGreaterThanOrEqual(minX - 1e-6);
          expect(p.x).toBeLessThanOrEqual(maxX + 1e-6);
          expect(p.y).toBeGreaterThanOrEqual(minY - 1e-6);
          expect(p.y).toBeLessThanOrEqual(maxY + 1e-6);
        }
      }
      for (const l of g.landings) {
        for (const p of l.polygon) {
          expect(p.x).toBeGreaterThanOrEqual(minX - 1e-6);
          expect(p.x).toBeLessThanOrEqual(maxX + 1e-6);
        }
      }
    }
  });

  it('is at least as wide as the flight for a straight run', () => {
    const g = build({ stairType: 'straight', widthMm: 1200 });
    const ys = g.footprint.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(1200, 6);
  });

  it('is wide enough for two flights side by side on a half-turn', () => {
    const g = build({ stairType: 'u_shape', widthMm: 1000, directionDeg: 0 });
    const ys = g.footprint.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(2000 - 1e-6);
  });
});

describe('landings', () => {
  it('sits flush with the flight that arrives at it', () => {
    // The landing IS the walking surface the last riser tops out on. One riser
    // higher — the old model — showed in 3D as a plate floating above the
    // flight with a phantom step to nowhere at its edge.
    const g = build({ stairType: 'u_shape' });
    expect(g.landings[0].levelMm).toBeCloseTo(g.flights[0].end.z, 6);
  });

  it('is where the next flight starts from', () => {
    const g = build({ stairType: 'l_shape' });
    expect(g.flights[1].start.z).toBeCloseTo(g.landings[0].levelMm, 6);
  });

  it('has a real area', () => {
    const g = build({ stairType: 'u_shape' });
    const p = g.landings[0].polygon;
    const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1);
  });

  it('is square at a quarter turn, not stretched by the second flight', () => {
    // Running east, turning left (north). The landing is the turn itself:
    // 1000 deep by 1000 across. Reaching further would waste floor and read as
    // a drafting mistake.
    const g = build({ stairType: 'l_shape', directionDeg: 0, turn: 'left', widthMm: 1000 });
    const p = g.landings[0].polygon;
    const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1000, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(1000, 6);
    // Its near edge is where the first flight arrived.
    expect(Math.min(...xs)).toBeCloseTo(g.flights[0].end.x, 6);
  });

  it('sends the next flight out through the side of a quarter-turn landing', () => {
    const g = build({ stairType: 'l_shape', directionDeg: 0, turn: 'left', widthMm: 1000 });
    const [f1, f2] = g.flights;
    // Centred in the landing along the arriving run…
    expect(f2.start.x).toBeCloseTo(f1.end.x + 500, 6);
    // …and starting at the edge it leaves through, not at the middle.
    expect(f2.start.y).toBeCloseTo(f1.end.y + 500, 6);
  });

  it('keeps both flights on the landing at a half turn', () => {
    const g = build({ stairType: 'u_shape', directionDeg: 0, turn: 'left', widthMm: 1000 });
    const p = g.landings[0].polygon;
    const ys = p.map((q) => q.y);
    // Flight 1 centred on y=0, flight 2 on y=1000, each 1000 wide.
    expect(Math.min(...ys)).toBeCloseTo(-500, 6);
    expect(Math.max(...ys)).toBeCloseTo(1500, 6);
  });

  it('shares one riser plane between the two flights of a half turn', () => {
    // The classic U: last riser of the flight below and first riser of the
    // flight above sit on the SAME line — the landing's near edge — with the
    // landing extending beyond them both. Starting the upper flight at the far
    // edge shifts it a whole landing-depth out of line with its pair.
    const g = build({ stairType: 'u_shape', directionDeg: 0, turn: 'left', widthMm: 1000 });
    const [f1, f2] = g.flights;
    expect(f2.start.x).toBeCloseTo(f1.end.x, 6);
    expect(f2.start.y).toBeCloseTo(f1.end.y + 1000, 6);   // one width across, nothing forward
    // And the flights really do run back over each other.
    expect(f2.end.x).toBeLessThan(f2.start.x);
    // The landing still reaches its full depth beyond the shared plane.
    const xs = g.landings[0].polygon.map((q) => q.x);
    expect(Math.max(...xs)).toBeCloseTo(f1.end.x + 1000, 6);
  });

  it('squares the landing to the stair, not to the site grid', () => {
    // At 30° an axis-aligned landing would be visibly larger than the turn and
    // out of line with the flights it joins.
    const g = build({ stairType: 'l_shape', directionDeg: 30, widthMm: 1000 });
    const p = g.landings[0].polygon;
    const side = (i: number, j: number) => Math.hypot(p[j].x - p[i].x, p[j].y - p[i].y);
    expect(side(0, 1)).toBeCloseTo(1000, 6);
    expect(side(1, 2)).toBeCloseTo(1000, 6);
    // A true rectangle: opposite sides equal, and a right angle at a corner.
    expect(side(2, 3)).toBeCloseTo(side(0, 1), 6);
    const e1 = { x: p[1].x - p[0].x, y: p[1].y - p[0].y };
    const e2 = { x: p[2].x - p[1].x, y: p[2].y - p[1].y };
    expect(e1.x * e2.x + e1.y * e2.y).toBeCloseTo(0, 6);
  });
});

describe('treads', () => {
  it('produces one tread per riser, each a riser above the last', () => {
    const g = build({ stairType: 'straight' });
    const t = treadsOf(g.flights[0]);
    expect(t).toHaveLength(g.flights[0].steps);
    expect(t[0].centre.z).toBeCloseTo(g.flights[0].start.z + g.riserMm, 6);
    for (let i = 1; i < t.length; i++) {
      expect(t[i].centre.z - t[i - 1].centre.z).toBeCloseTo(g.riserMm, 6);
    }
  });

  it('tops out level with the flight it belongs to', () => {
    const g = build({ stairType: 'straight' });
    const t = treadsOf(g.flights[0]);
    expect(t[t.length - 1].centre.z).toBeCloseTo(g.flights[0].end.z, 6);
  });
});

describe('spiral', () => {
  const spiral = (over: Partial<StairIntent> = {}) =>
    build({ stairType: 'spiral', spiralInnerMm: 100, widthMm: 1000, ...over });

  it('lands exactly on the upper floor', () => {
    const g = spiral();
    expect(g.topZMm).toBeCloseTo(BOTTOM + RISE, 6);
    expect(g.baseline[g.baseline.length - 1].z).toBeCloseTo(BOTTOM + RISE, 6);
  });

  it('is winders all the way up: n−1 wedge treads for n risers', () => {
    const g = spiral();
    expect(g.flights).toHaveLength(0);
    expect(g.landings).toHaveLength(0);
    expect(g.winders).toHaveLength(g.steps - 1);
    for (const [j, w] of g.winders.entries()) {
      expect(w.zTopMm).toBeCloseTo(BOTTOM + (j + 1) * g.riserMm, 6);
    }
  });

  it('honours the solved going on the walking line', () => {
    // Consecutive baseline points sit on the walking circle one going apart.
    const g = spiral();
    const c = g.spiral!.center;
    const rW = g.spiral!.innerMm + 500;
    for (const p of g.baseline) {
      expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(rW, 4);
    }
    const [a, b] = g.baseline;
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const theta = g.treadMm / rW;
    expect(chord).toBeCloseTo(2 * rW * Math.sin(theta / 2), 4);
  });

  it('starts its walking line at the node, like every other type', () => {
    const g = spiral();
    expect(g.baseline[0].x).toBeCloseTo(0, 6);
    expect(g.baseline[0].y).toBeCloseTo(0, 6);
  });

  it('turns the other way when asked', () => {
    const left = spiral({ turn: 'left' });
    const right = spiral({ turn: 'right' });
    // The centre lands on opposite sides of the start direction.
    expect(Math.sign(left.spiral!.center.y)).toBe(-Math.sign(right.spiral!.center.y));
  });

  it('keeps every tread wedge between the two radii', () => {
    const g = spiral();
    const c = g.spiral!.center;
    for (const w of g.winders) {
      for (const p of w.polygon) {
        const r = Math.hypot(p.x - c.x, p.y - c.y);
        expect(r).toBeGreaterThanOrEqual(g.spiral!.innerMm - 1e-6);
        expect(r).toBeLessThanOrEqual(g.spiral!.outerMm + 1e-6);
      }
    }
  });

  it('sizes the opening to the whole drum', () => {
    const g = spiral();
    const xs = g.footprint.map((p) => p.x), ys = g.footprint.map((p) => p.y);
    const c = g.spiral!.center;
    expect(Math.max(...xs) - c.x).toBeCloseTo(g.spiral!.outerMm, 0);
    expect(c.x - Math.min(...xs)).toBeCloseTo(g.spiral!.outerMm, 0);
    expect(Math.max(...ys) - c.y).toBeCloseTo(g.spiral!.outerMm, 0);
  });
});

describe('winder turn', () => {
  const winderL = (over: Partial<StairIntent> = {}) =>
    build({ stairType: 'l_shape', turnStyle: 'winder', winderCount: 3, ...over });

  it('lands exactly on the upper floor', () => {
    for (const stairType of ['l_shape', 'u_shape'] as const) {
      const g = build({ stairType, turnStyle: 'winder', winderCount: 3 });
      expect(g.topZMm).toBeCloseTo(BOTTOM + RISE, 6);
    }
  });

  it('replaces the landing with winders that absorb their risers', () => {
    const g = winderL();
    expect(g.landings).toHaveLength(0);
    expect(g.winders).toHaveLength(3);
    // W winders absorb W−1 risers; the flights climb the rest.
    const climbed = g.flights.reduce((s, f) => s + f.steps, 0);
    expect(climbed + g.winders.length - 1).toBe(g.steps);
  });

  it('steps the corner: first winder flush with the arrival, the rest climbing', () => {
    const g = winderL();
    const arrive = g.flights[0].end.z;
    expect(g.winders[0].zTopMm).toBeCloseTo(arrive, 6);
    expect(g.winders[1].zTopMm).toBeCloseTo(arrive + g.riserMm, 6);
    expect(g.winders[2].zTopMm).toBeCloseTo(arrive + 2 * g.riserMm, 6);
    // Flight 2 springs from the last winder.
    expect(g.flights[1].start.z).toBeCloseTo(g.winders[2].zTopMm, 6);
  });

  it('pivots every winder on the turn corner', () => {
    const g = build({ stairType: 'l_shape', turnStyle: 'winder', winderCount: 3, directionDeg: 0, turn: 'left', widthMm: 1000 });
    const pivot = { x: g.flights[0].end.x, y: g.flights[0].end.y + 500 };
    for (const w of g.winders) {
      expect(w.polygon.some((p) => Math.hypot(p.x - pivot.x, p.y - pivot.y) < 1e-6)).toBe(true);
    }
  });

  it('fans the whole corner: winder areas sum to the landing square', () => {
    const g = build({ stairType: 'l_shape', turnStyle: 'winder', winderCount: 3, directionDeg: 0, turn: 'left', widthMm: 1000 });
    const area = (pts: { x: number; y: number }[]) => {
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      }
      return Math.abs(s / 2);
    };
    const total = g.winders.reduce((s, w) => s + area(w.polygon), 0);
    expect(total).toBeCloseTo(1000 * 1000, 0);
  });

  it('mirrors cleanly for a right turn', () => {
    const g = build({ stairType: 'l_shape', turnStyle: 'winder', winderCount: 3, directionDeg: 0, turn: 'right', widthMm: 1000 });
    expect(g.winders).toHaveLength(3);
    expect(g.topZMm).toBeCloseTo(BOTTOM + RISE, 6);
    // The fan is below the first flight's centre line for a right turn.
    for (const w of g.winders) {
      for (const p of w.polygon) expect(p.y).toBeLessThanOrEqual(500 + 1e-6);
    }
  });

  it('a single winder is the flush square turn', () => {
    const g = build({ stairType: 'l_shape', turnStyle: 'winder', winderCount: 1 });
    expect(g.winders).toHaveLength(1);
    expect(g.winders[0].zTopMm).toBeCloseTo(g.flights[0].end.z, 6);
    const climbed = g.flights.reduce((s, f) => s + f.steps, 0);
    expect(climbed).toBe(g.steps);
  });
});

describe('fan polygon integrity', () => {
  // The area-sum check alone let a real bug through: a sign flip in the
  // ray-edge intersection produced a SELF-CROSSING winder reaching outside the
  // corner square, whose |shoelace| still summed to the right total. So every
  // winder is checked individually: simple, and inside the turn's rectangle.
  const configs: [string, 'l_shape' | 'u_shape', 'left' | 'right', number, number][] = [];
  for (const st of ['l_shape', 'u_shape'] as const) {
    for (const turn of ['left', 'right'] as const) {
      for (const dir of [0, 30, 135]) {
        configs.push([`${st} ${turn} ${dir}°`, st, turn, dir, 3]);
      }
    }
  }

  for (const [label, stairType, turn, directionDeg, winderCount] of configs) {
    it(`every winder is simple and stays in the corner — ${label}`, () => {
      const g = build({ stairType, turnStyle: 'winder', winderCount, directionDeg, turn, widthMm: 1000 });
      const corner = { x: g.flights[0].end.x, y: g.flights[0].end.y };
      const reach = stairType === 'u_shape' ? 2000 : 1000;
      let total = 0;
      for (const w of g.winders) {
        expect(isSimplePolygon(w.polygon), `winder ${w.index} self-crosses`).toBe(true);
        for (const p of w.polygon) {
          const d = Math.hypot(p.x - corner.x, p.y - corner.y);
          expect(d, `winder ${w.index} reaches ${Math.round(d)} mm from the corner`)
            .toBeLessThanOrEqual(Math.hypot(reach, 1000) + 1e-6);
        }
        total += Math.abs(polygonArea(w.polygon));
      }
      expect(total).toBeCloseTo(stairType === 'l_shape' ? 1e6 : 2e6, 0);
    });
  }
});
