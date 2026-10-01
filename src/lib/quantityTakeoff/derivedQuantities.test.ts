/**
 * Derived quantities: what a node's geometry makes it measure, kept as
 * read-only `q_*` properties and usable in formulas.
 *
 * Checked on shapes whose answers are closed-form: a 4 × 3 m slab 200 thick
 * with a 1 × 1 m hole (net 11 m², 2.2 m³, 18 m of edge); a 200 × 300 profile
 * swept 5 m (0.06 m², 0.3 m³, 1 m of profile edge run 5 m = 5 m²).
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode } from '@/store';
import { serialiseOutline } from '@/lib/sketch/types';
import { safeEval } from '@/lib/formulaUtils';
import { deriveQuantities, quantityVars, stampDerivedQuantities } from './derivedQuantities';

const storey: BubbleGraphNode = {
  id: 'st1', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};
type P = [number, number];
function sk(id: string, pts: P[], props: Record<string, unknown> = {}): BubbleGraphNode {
  return {
    id, type: 'sketch', name: id, x: 0, y: 0, z: 0, parentId: 'st1',
    properties: { outline: serialiseOutline(pts.map(([x, y]) => ({ x, y }))), closed: 'True', op: 'extrude', height_mm: 200, ...props },
  };
}
const SLAB = sk('slab', [[0, 0], [4000, 0], [4000, 3000], [0, 3000]]);
const HOLE = sk('hole', [[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]], { hole_of: 'slab' });
const BEAM = sk('beam', [[0, 0], [5000, 0]], {
  closed: 'False', op: 'sweep', profile: 'rect', p_w_mm: 200, p_h_mm: 300, anchor_x: 'mid', anchor_y: 'min',
});
const nodes = [storey, SLAB, HOLE, BEAM];
const map = new Map(nodes.map((n) => [n.id, n]));
const vars = (n: BubbleGraphNode) => quantityVars(deriveQuantities(n, [], map));

describe('a slab with a hole', () => {
  const q = vars(SLAB);

  it('knows its outline, its net face and its volume', () => {
    expect(q.q_outline_area_m2).toBeCloseTo(12, 6);
    expect(q.q_net_area_m2).toBeCloseTo(11, 6);
    expect(q.q_gross_area_m2).toBeCloseTo(12, 6);
    expect(q.q_volume_m3).toBeCloseTo(2.2, 6);
    expect(q.q_extrude_height_m).toBeCloseTo(0.2, 6);
    expect(q.q_holes).toBe(1);
  });

  it('counts every edge, the hole’s included, and runs it up the height', () => {
    expect(q.q_perimeter_m).toBeCloseTo(18, 6);
    expect(q.q_lateral_area_m2).toBeCloseTo(18 * 0.2, 6);
  });

  it('a hole has no body, so no quantities of a body', () => {
    const h = vars(HOLE);
    expect(h.q_volume_m3).toBeUndefined();
    expect(h.q_outline_area_m2).toBeUndefined();
  });
});

describe('a swept profile', () => {
  it('knows its path, its profile and its skin', () => {
    const q = vars(BEAM);
    expect(q.q_outline_length_m).toBeCloseTo(5, 6);
    expect(q.q_profile_area_m2).toBeCloseTo(0.06, 6);
    expect(q.q_volume_m3).toBeCloseTo(0.3, 3);
    expect(q.q_lateral_area_m2).toBeCloseTo(1.0 * 5, 6);
    // Nothing a sweep does not have.
    expect(q.q_extrude_height_m).toBeUndefined();
  });
});

describe('in formulas', () => {
  it('a quantity is a variable', () => {
    expect(safeEval('q_net_area_m2 * 0.1', vars(SLAB))).toBeCloseTo(1.1, 6);
    expect(safeEval('q_outline_length_m * 1000 / 10', vars(BEAM))).toBeCloseTo(500, 6);
    // A name the node does not have is still refused, not read as 0.
    expect(safeEval('q_profile_area_m2 * 2', vars(SLAB))).toBeNaN();
  });
});

describe('stamped on save', () => {
  it('writes the current values, drops stale ones, and leaves the rest alone', () => {
    const stale = { ...SLAB, properties: { ...SLAB.properties, q_volume_m3: 99, q_gone: 1, material: 'Beton' } };
    const out = stampDerivedQuantities([storey, stale, HOLE, BEAM], []);
    const slab = out.find((n) => n.id === 'slab')!;
    expect(slab.properties.q_volume_m3).toBeCloseTo(2.2, 6);
    expect(slab.properties.q_gone).toBeUndefined();
    expect(slab.properties.material).toBe('Beton');
    expect(slab.properties.outline).toBe(SLAB.properties.outline);
  });

  it('returns a node whose quantities did not change as the same object', () => {
    const once = stampDerivedQuantities(nodes, []);
    const twice = stampDerivedQuantities(once, []);
    twice.forEach((n, i) => expect(n).toBe(once[i]));
    // A storey has nothing to measure, and is not touched at all.
    expect(once[0]).toBe(storey);
  });
});

describe('IFC: every sketch element carries its own base quantities', () => {
  it('writes a Qto per element that web-ifc reads back', async () => {
    const { buildIfcModel } = await import('@/lib/ifc/buildIfcModel');
    const { content } = buildIfcModel(nodes, [], 'Qto');
    expect(content).toContain("'Qto_BuildingElementProxyQuantities'");

    const WebIFC = await import('web-ifc');
    const { createRequire } = await import('node:module');
    const pathMod = await import('node:path');
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath(pathMod.dirname(createRequire(import.meta.url).resolve('web-ifc')) + '/', true);
    await api.Init();
    const model = api.OpenModel(new TextEncoder().encode(content));
    const vols: Record<string, number> = {};
    const ids = api.GetLineIDsWithType(model, WebIFC.IFCQUANTITYVOLUME);
    for (let i = 0; i < ids.size(); i++) {
      const q = api.GetLine(model, ids.get(i));
      const name = String(q.Name?.value);
      vols[name] = (vols[name] ?? 0) + Number(q.VolumeValue?.value);
    }
    api.CloseModel(model);
    // Slab net 2.2 m³ + the beam's 0.3 m³ — no element counted twice.
    expect(vols.NetVolume).toBeCloseTo(2.2 + 0.3, 6);
    expect(vols.GrossVolume).toBeCloseTo(12 * 0.2, 6);
  }, 60000);
});
