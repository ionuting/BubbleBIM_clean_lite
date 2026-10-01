/**
 * The igloo tunnel. Two things have to be true and neither is obvious:
 *
 *   • the mouth is OPEN — the vault stops at the axis, so there is a section
 *     there rather than a pinned-shut end;
 *   • the tunnel and the dome are one interior — the tunnel only shows where
 *     it stands above the dome, and the crease between them is the doorway
 *     arch, carrying its own ribs.
 */
import { describe, expect, it } from 'vitest';
import { computeDome } from './index';
import { entranceFits, entranceGeometry, isCcw, polygonCentroid, stadiumPolygon } from './entrance';
import { circlePolygon } from './index';
import { pointInPolygon, polygonArea } from '@/lib/geom/plan2d';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';

const storey: BubbleGraphNode = {
  id: 'st1', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};
const ax = (id: string, x: number, y: number): BubbleGraphNode =>
  ({ id, type: 'ax', name: id, x, y, z: 0, parentId: 'st1', properties: { bimX: x, bimY: y } });

describe('polygonCentroid', () => {
  it('finds the centre of a square and of a circle', () => {
    const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(polygonCentroid(sq)).toEqual({ x: 50, y: 50 });
    const c = polygonCentroid(circlePolygon(2000, -500, 4000));
    expect(c.x).toBeCloseTo(2000, 3);
    expect(c.y).toBeCloseTo(-500, 3);
  });

  it('falls back to the vertex average on a degenerate ring', () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
    expect(polygonCentroid(line).x).toBeCloseTo(10, 6);
  });
});

describe('stadiumPolygon', () => {
  const s = stadiumPolygon({ x: 0, y: 0 }, { x: 4000, y: 0 }, 1200);

  it('is counter-clockwise and the right size', () => {
    expect(isCcw(s)).toBe(true);
    // A 4000 × 1200 rectangle plus a disc of diameter 1200.
    const want = 4000 * 1200 + Math.PI * 600 * 600;
    expect(Math.abs(polygonArea(s)) / want).toBeCloseTo(1, 1);
  });

  it('contains its own axis and nothing more than half a width away', () => {
    expect(pointInPolygon({ x: 2000, y: 0 }, s, 0)).toBe(true);
    expect(pointInPolygon({ x: 2000, y: 500 }, s, 0)).toBe(true);
    expect(pointInPolygon({ x: 2000, y: 700 }, s, 0)).toBe(false);
    // Rounded caps, so the far end reaches exactly half a width past b.
    expect(pointInPolygon({ x: 4550, y: 0 }, s, 0)).toBe(true);
    expect(pointInPolygon({ x: 4700, y: 0 }, s, 0)).toBe(false);
  });

  it('a zero-length stadium is a disc', () => {
    const d = stadiumPolygon({ x: 0, y: 0 }, { x: 0, y: 0 }, 1000);
    expect(Math.abs(polygonArea(d)) / (Math.PI * 500 * 500)).toBeCloseTo(1, 1);
  });
});

describe('entranceGeometry', () => {
  const dome = circlePolygon(0, 0, 5000);
  const g = entranceGeometry(dome, { x: 6000, y: 0 }, 1200)!;

  it('runs from the dome centre out to the mouth', () => {
    expect(g).not.toBeNull();
    expect(g.direction.x).toBeCloseTo(1, 6);
    expect(g.lengthMm).toBeCloseTo(6000, 3);
    expect(pointInPolygon({ x: 0, y: 0 }, g.base, 0)).toBe(true);     // overlaps the dome
    expect(pointInPolygon({ x: 5500, y: 0 }, g.base, 0)).toBe(true);  // reaches past the rim
  });

  it('is built PAST the mouth so the mouth can cut it open', () => {
    expect(pointInPolygon({ x: 6500, y: 0 }, g.base, 0)).toBe(true);
    expect(g.mouthField({ x: 6500, y: 0 })).toBeLessThan(0);           // …but cut away
    expect(g.mouthField({ x: 5000, y: 0 })).toBeGreaterThan(0);
    expect(g.mouthField({ x: 6000, y: 0 })).toBeCloseTo(0, 6);
  });

  it('refuses a mouth at the dome\'s own centre — there is no direction', () => {
    expect(entranceGeometry(dome, { x: 0, y: 0 }, 1200)).toBeNull();
  });
});

describe('entranceFits', () => {
  it('rejects a tunnel as tall as its dome, and says why', () => {
    expect(entranceFits(2100, 4000).ok).toBe(true);
    expect(entranceFits(4000, 4000).ok).toBe(false);
    expect(entranceFits(4500, 4000).reason).toMatch(/înghiți/);
    expect(entranceFits(0, 4000).ok).toBe(false);
  });
});

// ─── End to end ──────────────────────────────────────────────────────────────

function iglooGraph(props: Record<string, unknown> = {}) {
  const centre = ax('axC', 0, 0);
  const mouth = ax('axM', 6000, 0);
  const dome: BubbleGraphNode = {
    id: 'dome1', type: 'dome', name: 'Iglu', x: 0, y: 0, z: 0, parentId: 'st1',
    properties: {
      base_radius_mm: 5000, dome_height_mm: 5000, cell_count: 30, cell_seed: 2,
      p_w_mm: 60, p_h_mm: 120, resolution: 22,
    },
  };
  const entrance: BubbleGraphNode = {
    id: 'ent1', type: 'dome_entrance', name: 'Intrare', x: 0, y: 0, z: 0, parentId: 'st1',
    properties: { width_mm: 1400, height_mm: 2100, ...props },
  };
  const nodes = [storey, centre, mouth, dome, entrance];
  const edges: BubbleGraphEdge[] = [
    { id: 'e1', from: dome.id, to: centre.id },
    { id: 'e2', from: dome.id, to: entrance.id },
    { id: 'e3', from: entrance.id, to: mouth.id },
  ];
  return { dome, entrance, nodeMap: new Map(nodes.map((n) => [n.id, n])), edges };
}

describe('a dome with an entrance', () => {
  const g = iglooGraph();
  const r = computeDome(g.dome, g.nodeMap, g.edges);

  it('builds without errors', () => {
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.panels.length).toBeGreaterThan(20);
  });

  it('the tunnel shows outside the dome, where it is the only surface', () => {
    const outside = r.panels.filter((p) => Math.hypot(p.origin.x, p.origin.y) > 5200);
    expect(outside.length).toBeGreaterThan(0);
    // …and it is low: a 2100 tunnel, not the 5000 dome.
    for (const p of outside) expect(p.origin.z - r.baseZMm).toBeLessThan(2400);
  });

  it('the mouth is open — nothing is drawn past the axis it was given', () => {
    for (const p of r.panels) expect(p.origin.x).toBeLessThan(6100);
    for (const m of r.members) for (const pt of m.points) expect(pt.x).toBeLessThan(6150);
  });

  it('the tunnel is buried under the dome, not drawn through it', () => {
    // Along the tunnel's axis but well inside the dome, the surface must be
    // the DOME's height, not the tunnel's 2100.
    const onAxisInside = r.panels.filter((p) =>
      Math.abs(p.origin.y) < 900 && p.origin.x > 500 && p.origin.x < 3000);
    expect(onAxisInside.length).toBeGreaterThan(0);
    for (const p of onAxisInside) expect(p.origin.z - r.baseZMm).toBeGreaterThan(2400);
  });

  it('the doorway arch is a seam, and carries ribs that follow it', () => {
    const seam = r.members.filter((m) => m.onSeam);
    expect(seam.length).toBeGreaterThanOrEqual(2);
    expect(r.seamLengthMm).toBeGreaterThan(1000);
    // The arch rises to about the tunnel's height — it is a doorway, not a
    // line on the ground.
    const top = Math.max(...seam.flatMap((m) => m.points.map((p) => p.z))) - r.baseZMm;
    expect(top).toBeGreaterThan(1200);
    expect(top).toBeLessThan(2400);
    // It arches OVER the opening rather than cutting straight across it: the
    // curve is far longer than the 1400 mm the tunnel is wide.
    expect(r.seamLengthMm).toBeGreaterThan(2000);
  });

  it('the tunnel is panelled in its own right, not left as one sheet', () => {
    const outside = r.panels.filter((p) => Math.hypot(p.origin.x, p.origin.y) > 5200);
    expect(outside.length).toBeGreaterThan(2);
    const fewer = iglooGraph({ cell_count: 2 });
    const rf = computeDome(fewer.dome, fewer.nodeMap, fewer.edges);
    expect(rf.panels.filter((p) => Math.hypot(p.origin.x, p.origin.y) > 5200).length)
      .toBeLessThan(outside.length);
  });

  it('the dome keeps its own height — the tunnel does not lower it', () => {
    expect(r.zMaxMm - r.zMinMm).toBeCloseTo(5000, -2);
  });

  it('refuses a tunnel taller than its dome, and draws the dome anyway', () => {
    const tall = iglooGraph({ height_mm: 6000 });
    const rt = computeDome(tall.dome, tall.nodeMap, tall.edges);
    expect(rt.diagnostics.map((d) => d.code)).toContain('ENTRANCE_TOO_TALL');
    expect(rt.panels.length).toBeGreaterThan(20);
  });

  it('an entrance with no axis says so rather than guessing a direction', () => {
    const g2 = iglooGraph();
    const edges = g2.edges.filter((e) => e.id !== 'e3');
    const r2 = computeDome(g2.dome, g2.nodeMap, edges);
    expect(r2.diagnostics.map((d) => d.code)).toContain('ENTRANCE_NO_AXIS');
  });

  it('a wider tunnel cuts a wider doorway', () => {
    const wide = iglooGraph({ width_mm: 2600 });
    const rw = computeDome(wide.dome, wide.nodeMap, wide.edges);
    const spread = (res: typeof r) => Math.max(...res.members.filter((m) => m.onSeam)
      .flatMap((m) => m.points.map((p) => Math.abs(p.y))));
    expect(spread(rw)).toBeGreaterThan(spread(r) * 1.4);
    expect(rw.seamLengthMm).toBeGreaterThan(r.seamLengthMm);
  });

  it('two entrances both open', () => {
    const g3 = iglooGraph();
    const axS = ax('axS', 0, -6000);
    const ent2: BubbleGraphNode = {
      id: 'ent2', type: 'dome_entrance', name: 'Intrare 2', x: 0, y: 0, z: 0, parentId: 'st1',
      properties: { width_mm: 1400, height_mm: 2100 },
    };
    const nodeMap = new Map(g3.nodeMap);
    nodeMap.set(axS.id, axS); nodeMap.set(ent2.id, ent2);
    const edges: BubbleGraphEdge[] = [
      ...g3.edges,
      { id: 'e4', from: g3.dome.id, to: ent2.id },
      { id: 'e5', from: ent2.id, to: axS.id },
    ];
    const r3 = computeDome(g3.dome, nodeMap, edges);
    expect(r3.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const east = r3.panels.some((p) => p.origin.x > 5200 && Math.abs(p.origin.y) < 1200);
    const south = r3.panels.some((p) => p.origin.y < -5200 && Math.abs(p.origin.x) < 1200);
    expect(east && south).toBe(true);
  });
});
