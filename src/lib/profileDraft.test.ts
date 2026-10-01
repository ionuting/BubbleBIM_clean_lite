/**
 * A drafted profile has to arrive at the sweep as if it had come from a DXF.
 * These go the whole way: draft → bglib → the sweep's own reader.
 */
import { describe, expect, it } from 'vitest';
import {
  bglibToDraft, draftBounds, draftToBglib, profileFileName, validateProfileDraft,
  type ProfileDraft,
} from './profileDraft';
import { profileFromBglib } from '@/lib/sweep/profiles';

const draft = (over: Partial<ProfileDraft> = {}): ProfileDraft => ({
  name: 'Soclu',
  outline: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }],
  sliders: [],
  ...over,
});

const codes = (d: ProfileDraft) => validateProfileDraft(d).map((x) => x.code);

describe('draftBounds', () => {
  it('measures the outline', () => {
    expect(draftBounds(draft().outline)).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 100 });
  });

  it('an empty outline measures nothing rather than ±Infinity', () => {
    expect(draftBounds([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe('validateProfileDraft', () => {
  it('a plain rectangle is fine — but it is a fixed shape, and says so', () => {
    expect(codes(draft()).filter((c) => c !== 'PROFILE_FIXED')).toEqual([]);
    expect(codes(draft())).toContain('PROFILE_FIXED');
  });

  it('refuses what the sweep would refuse: too few points, a crossing, no area', () => {
    expect(codes(draft({ outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }))).toContain('PROFILE_NO_LOOP');
    // A bow tie.
    expect(codes(draft({
      outline: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
    }))).toContain('PROFILE_NOT_SIMPLE');
    expect(codes(draft({
      outline: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }],
    }))).toContain('PROFILE_DEGENERATE');
  });

  it('wants a name', () => {
    expect(codes(draft({ name: '  ' }))).toContain('PROFILE_NO_NAME');
  });

  it('warns about a stretch zone that would move nothing', () => {
    expect(codes(draft({ sliders: [{ axis: 'x', factor: 1, region: { x0: 500, y0: 500, x1: 600, y1: 600 } }] })))
      .toContain('SLIDER_EMPTY');
    expect(codes(draft({ sliders: [{ axis: 'x', factor: 1, region: { x0: 0, y0: 0, x1: 0, y1: 100 } }] })))
      .toContain('SLIDER_DEGENERATE');
  });
});

describe('draftToBglib', () => {
  it('writes one closed polyline, and the size it was drawn at', () => {
    const sym = draftToBglib(draft());
    expect(sym.geometry).toHaveLength(1);
    expect(sym.geometry[0].closed).toBe(true);
    expect(sym.geometry[0].vertices).toEqual([[0, 0], [200, 0], [200, 100], [0, 100]]);
    expect(sym.defaultWidth).toBe(200);
    expect(sym.defaultHeight).toBe(100);
  });

  it('leaves the insertion point at the origin, so the sweep\'s anchor decides', () => {
    expect(draftToBglib(draft()).insertionPoint).toEqual({ x: 0, y: 0 });
  });

  it('names a stretch zone the way the DXF parser does', () => {
    const sym = draftToBglib(draft({
      sliders: [
        { axis: 'x', factor: 1, region: { x0: 100, y0: 0, x1: 200, y1: 100 } },
        { axis: 'y', factor: 0.5, region: { x0: 0, y0: 50, x1: 200, y1: 100 } },
      ],
    }));
    expect(sym.sliders.map((s) => s.id)).toEqual(['slider_length', 'slider_0.5height']);
    expect(sym.sliders[0].polygon).toEqual([[100, 0], [200, 0], [200, 100], [100, 100]]);
  });

  it('squares a region drawn back to front', () => {
    const sym = draftToBglib(draft({
      sliders: [{ axis: 'x', factor: 1, region: { x0: 200, y0: 100, x1: 100, y1: 0 } }],
    }));
    expect(sym.sliders[0].polygon).toEqual([[100, 0], [200, 0], [200, 100], [100, 100]]);
  });
});

describe('the whole way through — draft → library → sweep profile', () => {
  it('a drafted L reaches the sweep as the polygon that was drawn', () => {
    const L = draft({
      name: 'Coltar',
      outline: [
        { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 40 },
        { x: 40, y: 40 }, { x: 40, y: 160 }, { x: 0, y: 160 },
      ],
    });
    const { polygon, diagnostics } = profileFromBglib(draftToBglib(L));
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(polygon).toHaveLength(6);
    // The sweep works counter-clockwise; the area is the L's, whichever way
    // the user happened to draw it.
    const area = Math.abs(polygon!.reduce((s, p, i, a) => {
      const q = a[(i + 1) % a.length];
      return s + (p.x * q.y - q.x * p.y);
    }, 0) / 2);
    expect(area).toBeCloseTo(200 * 40 + 40 * 120, 6);
  });

  it('a stretch zone really does stretch it', () => {
    const sym = draftToBglib(draft({
      // The right-hand half follows the width.
      sliders: [{ axis: 'x', factor: 1, region: { x0: 150, y0: -10, x1: 250, y1: 110 } }],
    }));
    const wide = profileFromBglib(sym, { widthMm: 300 }).polygon!;
    const xs = wide.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(300, 6);
  });

  it('a profile with no stretch zone keeps its size when asked to grow', () => {
    const sym = draftToBglib(draft());
    const same = profileFromBglib(sym, { widthMm: 400 }).polygon!;
    const xs = same.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(200, 6);
  });
});

describe('bglibToDraft', () => {
  it('round-trips a draft through the library format', () => {
    const d = draft({
      sliders: [{ axis: 'y', factor: 0.5, region: { x0: 0, y0: 50, x1: 200, y1: 100 } }],
    });
    const back = bglibToDraft(draftToBglib(d));
    expect(back.name).toBe(d.name);
    expect(back.outline).toEqual(d.outline);
    expect(back.sliders).toEqual(d.sliders);
  });

  it('opens a symbol whose outline repeats its first point', () => {
    const back = bglibToDraft({
      ...draftToBglib(draft()),
      geometry: [{
        type: 'lwpolyline', layer: 'profile', color: '#fff', lineweight: 0.25, closed: true,
        vertices: [[0, 0], [200, 0], [200, 100], [0, 100], [0, 0]],
      }],
    });
    expect(back.outline).toHaveLength(4);
  });

  it('takes the largest loop, since that is the only one the sweep reads', () => {
    const sym = draftToBglib(draft());
    sym.geometry.push({
      type: 'lwpolyline', layer: 'profile', color: '#fff', lineweight: 0.25, closed: true,
      vertices: [[10, 10], [20, 10], [20, 20], [10, 20]],
    });
    expect(bglibToDraft(sym).outline).toHaveLength(4);
    expect(draftBounds(bglibToDraft(sym).outline).maxX).toBe(200);
  });

  it('moves a symbol drawn around its own insertion point back to the origin', () => {
    const sym = draftToBglib(draft());
    sym.insertionPoint = { x: 100, y: 50 };
    expect(bglibToDraft(sym).outline[0]).toEqual({ x: -100, y: -50 });
  });
});

describe('profileFileName', () => {
  it('makes a library id out of a name', () => {
    expect(profileFileName('Soclu exterior')).toBe('soclu-exterior');
    expect(profileFileName('Cornișă 12')).toBe('corni-12');
    expect(profileFileName('  ')).toBe('profil');
  });
});
