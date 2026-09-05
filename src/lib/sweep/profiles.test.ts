import { describe, expect, it } from 'vitest';
import { isSimplePolygon, polygonArea } from '@/lib/geom/plan2d';
import type { BglibSymbol } from '@/lib/dxfSymbolRenderer';
import {
  applyProfilePlacement,
  circleProfile,
  lProfile,
  PARAMETRIC_PROFILES,
  profileBounds,
  profileFromBglib,
  rectProfile,
  tProfile,
  uProfile,
} from './profiles';
import { DEFAULT_SWEEP_INTENT, type SweepIntent } from './types';

const intent = (over: Partial<SweepIntent>): SweepIntent => ({ ...DEFAULT_SWEEP_INTENT, ...over });

describe('parametric builders', () => {
  it('every builder yields a CCW simple polygon at its defaults', () => {
    for (const def of PARAMETRIC_PROFILES) {
      const poly = def.build({});
      expect(poly, def.id).not.toBeNull();
      expect(polygonArea(poly!), `${def.id} CCW`).toBeGreaterThan(0);
      expect(isSimplePolygon(poly!), `${def.id} simple`).toBe(true);
    }
  });

  it('rect 300×600 has area 180000', () => {
    expect(Math.abs(polygonArea(rectProfile(300, 600)!))).toBeCloseTo(180000, 6);
  });

  it('circle area within 2% of the disc', () => {
    const d = 200;
    const a = Math.abs(polygonArea(circleProfile(d)!));
    expect(a).toBeGreaterThan(Math.PI * 100 * 100 * 0.98);
    expect(a).toBeLessThanOrEqual(Math.PI * 100 * 100);
  });

  it('L and U and T areas match the analytic formulas', () => {
    expect(Math.abs(polygonArea(lProfile(100, 60, 10)!)))
      .toBeCloseTo(100 * 60 - 90 * 50, 6);
    expect(Math.abs(polygonArea(uProfile(150, 100, 10)!)))
      .toBeCloseTo(150 * 100 - 130 * 90, 6);
    expect(Math.abs(polygonArea(tProfile(300, 400, 120, 120)!)))
      .toBeCloseTo(300 * 120 + 120 * 280, 6);
  });

  it('rejects degenerate dimensions', () => {
    expect(rectProfile(0, 100)).toBeNull();
    expect(lProfile(100, 100, 100)).toBeNull();
    expect(uProfile(100, 100, 60)).toBeNull();
  });
});

describe('applyProfilePlacement', () => {
  it('anchor max/max puts the bbox maximum at the origin', () => {
    const placed = applyProfilePlacement(rectProfile(300, 600)!, intent({ anchorX: 'max', anchorY: 'max' }));
    const b = profileBounds(placed);
    expect(b.maxX).toBeCloseTo(0, 6);
    expect(b.maxY).toBeCloseTo(0, 6);
    expect(b.minX).toBeCloseTo(-300, 6);
    expect(b.minY).toBeCloseTo(-600, 6);
  });

  it('mirror keeps the result CCW and negates x (mid anchors)', () => {
    const base = applyProfilePlacement(lProfile(100, 60, 10)!, intent({ anchorX: 'mid', anchorY: 'mid' }));
    const mirrored = applyProfilePlacement(lProfile(100, 60, 10)!, intent({ anchorX: 'mid', anchorY: 'mid', mirror: true }));
    expect(polygonArea(mirrored)).toBeGreaterThan(0);
    const key = (p: { x: number; y: number }) => `${p.x.toFixed(3)}|${p.y.toFixed(3)}`;
    const negated = new Set(base.map((p) => key({ x: -p.x, y: p.y })));
    for (const p of mirrored) expect(negated.has(key(p)), key(p)).toBe(true);
  });

  it('90° rotation swaps the bbox extents', () => {
    const placed = applyProfilePlacement(rectProfile(300, 600)!, intent({ rotationDeg: 90, anchorX: 'mid', anchorY: 'mid' }));
    const b = profileBounds(placed);
    expect(b.maxX - b.minX).toBeCloseTo(600, 6);
    expect(b.maxY - b.minY).toBeCloseTo(300, 6);
    expect(polygonArea(placed)).toBeGreaterThan(0);
  });

  it('order is mirror → rotate → anchor → offset', () => {
    // rect 200×100 rotated 90° → bbox 100×200; anchor min/min → min corner at
    // origin; offset_x 50 shifts it right. Anchoring BEFORE rotation would put
    // minX at 50 − 100 instead.
    const placed = applyProfilePlacement(
      rectProfile(200, 100)!,
      intent({ rotationDeg: 90, anchorX: 'min', anchorY: 'min', offsetXMm: 50 }),
    );
    const b = profileBounds(placed);
    expect(b.minX).toBeCloseTo(50, 6);
    expect(b.minY).toBeCloseTo(0, 6);
    expect(b.maxX).toBeCloseTo(150, 6);
    expect(b.maxY).toBeCloseTo(200, 6);
  });
});

describe('profileFromBglib', () => {
  const sym = (over: Partial<BglibSymbol>): BglibSymbol => ({
    name: 'test',
    defaultWidth: 100,
    defaultHeight: 100,
    bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
    insertionPoint: { x: 0, y: 0 },
    sliders: [],
    geometry: [],
    labels: [],
    ...over,
  });

  it('normalises a CW polyline with repeated closing vertex and insertion point', () => {
    const out = profileFromBglib(sym({
      insertionPoint: { x: 100, y: 50 },
      geometry: [{
        type: 'lwpolyline', layer: '0', color: '#000', lineweight: 0.25, closed: false,
        // CW square, author-closed by repeating the first vertex
        vertices: [[100, 50], [100, 150], [200, 150], [200, 50], [100, 50]],
      }],
    }));
    expect(out.polygon).not.toBeNull();
    expect(out.polygon!.length).toBe(4);
    expect(polygonArea(out.polygon!)).toBeCloseTo(100 * 100, 3);
    const b = profileBounds(out.polygon!);
    expect(b.minX).toBeCloseTo(0, 3);   // insertionPoint subtracted
    expect(b.minY).toBeCloseTo(0, 3);
  });

  it('two closed loops → the larger wins, holes flagged', () => {
    const out = profileFromBglib(sym({
      geometry: [
        { type: 'lwpolyline', layer: '0', color: '#000', lineweight: 0.25, closed: true,
          vertices: [[10, 10], [20, 10], [20, 20], [10, 20]] },
        { type: 'lwpolyline', layer: '0', color: '#000', lineweight: 0.25, closed: true,
          vertices: [[0, 0], [100, 0], [100, 100], [0, 100]] },
      ],
    }));
    expect(Math.abs(polygonArea(out.polygon!))).toBeCloseTo(10000, 3);
    expect(out.diagnostics.some((d) => d.code === 'PROFILE_HOLES_IGNORED')).toBe(true);
  });

  it('a lone circle tessellates to 24 vertices', () => {
    const out = profileFromBglib(sym({
      geometry: [{ type: 'circle', layer: '0', color: '#000', lineweight: 0.25, center: [50, 50], radius: 25 }],
    }));
    expect(out.polygon!.length).toBe(24);
    expect(out.diagnostics).toHaveLength(0);
  });

  it('converts the real cornice.bglib.json the backend parser produced', async () => {
    // Integration pin: the sample profile shipped in backend/library/profiles/
    // must survive the whole DXF → bglib → polygon chain. Skips if the library
    // folder is absent (e.g. a stripped checkout).
    const { existsSync, readFileSync } = await import('node:fs');
    const p = 'backend/library/profiles/symbols2d/cornice.bglib.json';
    if (!existsSync(p)) return;
    const real = JSON.parse(readFileSync(p, 'utf8')) as BglibSymbol;
    const out = profileFromBglib(real);
    expect(out.polygon).not.toBeNull();
    expect(out.polygon!.length).toBe(10);
    expect(polygonArea(out.polygon!)).toBeGreaterThan(0);
    expect(isSimplePolygon(out.polygon!)).toBe(true);
    const b = profileBounds(out.polygon!);
    expect(b.maxX - b.minX).toBeCloseTo(180, 3);
    expect(b.maxY - b.minY).toBeCloseTo(180, 3);
  });

  it('stretches a sliderful profile without touching the rest', () => {
    // 100×100 square; only vertices at x >= 50 sit in the x-slider region.
    const s = sym({
      defaultWidth: 100, defaultHeight: 100,
      sliders: [{ id: 'slider_length', axis: 'x', factor: 1,
        polygon: [[50, -10], [150, -10], [150, 150], [50, 150]] }],
      geometry: [{ type: 'lwpolyline', layer: '0', color: '#000', lineweight: 0.25, closed: true,
        vertices: [[0, 0], [100, 0], [100, 100], [0, 100]] }],
    });
    const wide = profileFromBglib(s, { widthMm: 160 });
    const b = profileBounds(wide.polygon!);
    expect(b.maxX - b.minX).toBeCloseTo(160, 6);   // right edge moved by +60
    expect(b.maxY - b.minY).toBeCloseTo(100, 6);   // no y-slider → height untouched
    expect(b.minX).toBeCloseTo(0, 6);              // left edge stayed put
  });

  it('leaves the polygon alone at its drawn size, and with no sliders', () => {
    const geometry = [{ type: 'lwpolyline' as const, layer: '0', color: '#000', lineweight: 0.25,
      closed: true, vertices: [[0, 0], [100, 0], [100, 100], [0, 100]] as [number, number][] }];
    const noSliders = profileFromBglib(sym({ defaultWidth: 100, defaultHeight: 100, geometry }), { widthMm: 400 });
    const b1 = profileBounds(noSliders.polygon!);
    expect(b1.maxX - b1.minX).toBeCloseTo(100, 6); // nothing to stretch → unchanged

    const atDrawnSize = profileFromBglib(
      sym({ defaultWidth: 100, defaultHeight: 100, geometry,
        sliders: [{ id: 'slider_length', axis: 'x', factor: 1, polygon: [[50, -10], [150, -10], [150, 150], [50, 150]] }] }),
      { widthMm: 100 },
    );
    const b2 = profileBounds(atDrawnSize.polygon!);
    expect(b2.maxX - b2.minX).toBeCloseTo(100, 6);
  });

  it('the shipped parametric plinth stretches on both axes', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const p = 'backend/library/profiles/symbols2d/plinth.bglib.json';
    if (!existsSync(p)) return;
    const real = JSON.parse(readFileSync(p, 'utf8')) as BglibSymbol;
    expect(real.sliders.map((s) => s.axis).sort()).toEqual(['x', 'y']);

    const drawn = profileBounds(profileFromBglib(real).polygon!);
    expect(drawn.maxX - drawn.minX).toBeCloseTo(400, 3);
    expect(drawn.maxY - drawn.minY).toBeCloseTo(120, 3);

    const grown = profileBounds(profileFromBglib(real, { widthMm: 600, heightMm: 200 }).polygon!);
    expect(grown.maxX - grown.minX).toBeCloseTo(600, 3);
    expect(grown.maxY - grown.minY).toBeCloseTo(200, 3);
  });

  it('no closed loop → PROFILE_NO_LOOP error', () => {
    const out = profileFromBglib(sym({
      geometry: [{ type: 'line', layer: '0', color: '#000', lineweight: 0.25, start: [0, 0], end: [10, 0] }],
    }));
    expect(out.polygon).toBeNull();
    expect(out.diagnostics[0].code).toBe('PROFILE_NO_LOOP');
  });
});
