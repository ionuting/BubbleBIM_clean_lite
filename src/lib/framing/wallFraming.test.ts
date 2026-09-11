import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECTION, DEFAULT_STUD_SPACING_MM, computeWallFraming, headerForSpan, parseFramingSection, placeMember,
  sectionForThickness, sheathingSheets,
} from './wallFraming';

const byKind = (f: ReturnType<typeof computeWallFraming>, kind: string) => f.members.filter((m) => m.kind === kind);

describe('computeWallFraming — a plain wall', () => {
  const f = computeWallFraming({ lengthMm: 5000, heightMm: 2800, openings: [] });

  it('has a bottom plate and a double top plate running the full length', () => {
    expect(byKind(f, 'bottom_plate')).toHaveLength(1);
    expect(byKind(f, 'top_plate')).toHaveLength(2);
    for (const p of [...byKind(f, 'bottom_plate'), ...byKind(f, 'top_plate')]) {
      expect(p.a.x).toBe(0);
      expect(p.b.x).toBe(5000);
    }
  });

  it('places studs on the spacing from the start plus one at the far end', () => {
    // 0, 625, …, 4375 = 8 lines, then the end stud at 5000.
    expect(f.studCount).toBe(9);
    const xs = byKind(f, 'stud').map((s) => s.a.x);
    expect(xs[0]).toBe(0);
    expect(xs[1]).toBe(DEFAULT_STUD_SPACING_MM);
    expect(xs[xs.length - 1]).toBe(5000);
  });

  it('studs run between the plates, not through them', () => {
    const s = byKind(f, 'stud')[0];
    expect(s.a.z).toBe(45);
    expect(s.b.z).toBe(2800 - 90);
  });

  it('sheathing is the whole face, timber length is plates plus studs', () => {
    expect(f.sheathingAreaM2).toBeCloseTo(14, 6);
    const studs = 9 * (2800 - 135);
    expect(f.framingLengthM).toBeCloseTo((3 * 5000 + studs) / 1000, 3);
    expect(f.volumeM3).toBeGreaterThan(0);
  });

  it('a wall exactly on the rhythm gets no duplicate end stud', () => {
    const g = computeWallFraming({ lengthMm: 2500, heightMm: 2800, openings: [] });
    expect(g.studCount).toBe(5);   // 0, 625, 1250, 1875, 2500
  });

  it('degenerate walls frame nothing', () => {
    expect(computeWallFraming({ lengthMm: 0, heightMm: 2800, openings: [] }).members).toHaveLength(0);
  });
});

describe('computeWallFraming — around a window', () => {
  const f = computeWallFraming({
    lengthMm: 5000, heightMm: 2800,
    openings: [{ x0Mm: 1000, widthMm: 1200, sillMm: 900, heightMm: 1200 }],
  });

  it('replaces the studs inside the opening with kings, jacks, a header and a sill', () => {
    // Lines 1250 and 1875 fall inside 1000…2200 and are no longer common studs.
    const commons = byKind(f, 'stud').map((s) => s.a.x);
    expect(commons).not.toContain(1250);
    expect(commons).not.toContain(1875);
    expect(byKind(f, 'king')).toHaveLength(2);
    expect(byKind(f, 'jack')).toHaveLength(2);
    expect(byKind(f, 'header')).toHaveLength(1);
    expect(byKind(f, 'sill')).toHaveLength(1);
  });

  it('kings count as full-height studs, cripples do not', () => {
    // 9 lines − 2 inside + 2 kings = 9.
    expect(f.studCount).toBe(9);
    expect(byKind(f, 'cripple').length).toBeGreaterThan(0);
  });

  it('the header sits on top of the opening and spans past the jacks', () => {
    const h = byKind(f, 'header')[0];
    expect(h.a.x).toBeLessThan(1000);
    expect(h.b.x).toBeGreaterThan(2200);
    expect(h.a.z).toBeCloseTo(2100 + 145 / 2, 6);
  });

  it('cripples continue the rhythm above the header and below the sill', () => {
    const cr = byKind(f, 'cripple');
    expect(cr.some((c) => c.a.x === 1250 && c.a.z > 2100)).toBe(true);
    expect(cr.some((c) => c.a.x === 1250 && c.b.z < 900)).toBe(true);
  });

  it('sheathing loses the opening', () => {
    expect(f.sheathingAreaM2).toBeCloseTo(14 - 1.44, 6);
  });
});

describe('computeWallFraming — a door has no sill and no lower cripples', () => {
  const f = computeWallFraming({
    lengthMm: 4000, heightMm: 2800,
    openings: [{ x0Mm: 1500, widthMm: 900, sillMm: 0, heightMm: 2100 }],
  });
  it('emits a header but no sill', () => {
    expect(byKind(f, 'header')).toHaveLength(1);
    expect(byKind(f, 'sill')).toHaveLength(0);
    expect(byKind(f, 'cripple').every((c) => c.a.z > 2100)).toBe(true);
  });
});

describe('sections', () => {
  it('reads T-codes in cm, like the roof', () => {
    expect(parseFramingSection('T4.5x14.5')).toEqual({ wMm: 45, dMm: 145 });
    expect(parseFramingSection('nope')).toEqual({ wMm: 45, dMm: 145 });
  });
  it('picks the deepest stud the build-up can hold', () => {
    expect(sectionForThickness(140).dMm).toBe(95);
    expect(sectionForThickness(200).dMm).toBe(145);
    expect(sectionForThickness(250).dMm).toBe(195);
    expect(sectionForThickness(100).dMm).toBe(95);
  });
});

describe('placeMember', () => {
  it('maps wall-local x/z onto the wall direction and base elevation', () => {
    const m = { kind: 'stud' as const, a: { x: 1000, z: 45 }, b: { x: 1000, z: 2000 }, section: { wMm: 45, dMm: 145 } };
    const p = placeMember(m, { x: 100, y: 200 }, { x: 0, y: 1 }, 3000);
    expect(p.a).toEqual({ x: 100, y: 1200, z: 3045 });
    expect(p.b).toEqual({ x: 100, y: 1200, z: 5000 });
  });
});

describe('computeWallFraming — what the structure decides', () => {
  it('sizes the header by its span and stacks two plies', () => {
    const narrow = computeWallFraming({ lengthMm: 5000, heightMm: 2800, openings: [{ x0Mm: 1000, widthMm: 900, sillMm: 0, heightMm: 2100 }] });
    const wide = computeWallFraming({ lengthMm: 5000, heightMm: 2800, openings: [{ x0Mm: 500, widthMm: 2400, sillMm: 0, heightMm: 2100 }] });
    const h1 = byKind(narrow, 'header')[0], h2 = byKind(wide, 'header')[0];
    expect(h1.section.dMm).toBe(145);
    expect(h1.plies).toBe(2);
    expect(h2.section.dMm).toBe(245);
    expect(h2.grade).toBe('c24');
    expect(headerForSpan(3500, DEFAULT_SECTION).grade).toBe('lvl');
    // Plies count in the metres of timber.
    expect(narrow.headerLengthM).toBeCloseTo(2 * (900 + 90) / 1000, 3);
    expect(narrow.headerCount).toBe(1);
  });

  it('doubles the kings past 1.8 m', () => {
    const f = computeWallFraming({ lengthMm: 6000, heightMm: 2800, openings: [{ x0Mm: 1000, widthMm: 2000, sillMm: 900, heightMm: 1200 }] });
    expect(byKind(f, 'king')).toHaveLength(4);
  });

  it('a corner gets a three-stud corner and the upper top plate laps past it', () => {
    const plain = computeWallFraming({ lengthMm: 4000, heightMm: 2800, openings: [] });
    const corner = computeWallFraming({ lengthMm: 4000, heightMm: 2800, openings: [], junctions: [{ xMm: 0, kind: 'corner' }] });
    expect(corner.studCount).toBe(plain.studCount + 2);
    const tops = byKind(corner, 'top_plate');
    expect(Math.min(...tops.map((p) => p.a.x))).toBe(-145);
    expect(byKind(plain, 'top_plate').every((p) => p.a.x === 0)).toBe(true);
  });

  it('a tee gets two backing studs', () => {
    const plain = computeWallFraming({ lengthMm: 4000, heightMm: 2800, openings: [] });
    const tee = computeWallFraming({ lengthMm: 4000, heightMm: 2800, openings: [], junctions: [{ xMm: 4000, kind: 'tee' }] });
    expect(tee.studCount).toBe(plain.studCount + 2);
    expect(byKind(tee, 'king').every((k) => k.a.x < 4000)).toBe(true);
  });

  it('breaks the timber down into verticals, plates and headers', () => {
    const f = computeWallFraming({ lengthMm: 5000, heightMm: 2800, openings: [{ x0Mm: 1000, widthMm: 1200, sillMm: 900, heightMm: 1200 }] });
    expect(f.studLengthM + f.plateLengthM + f.headerLengthM).toBeCloseTo(f.framingLengthM, 2);
    expect(f.plateLengthM).toBeCloseTo(3 * 5 + 1.2, 3);   // three plates + the sill
  });

  it('counts whole sheets per face and drops the sheets a big opening swallows', () => {
    expect(sheathingSheets(5000, 2800, [])).toBe(4 * 2);
    expect(sheathingSheets(5000, 2800, [{ x0: 1250, x1: 2500, sill: 0, top: 2800 }])).toBe(4 * 2 - 2);
    const f = computeWallFraming({ lengthMm: 5000, heightMm: 2800, openings: [] });
    expect(f.sheathingSheetCount).toBe(8);
  });
});
