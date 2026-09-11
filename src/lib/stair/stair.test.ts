/**
 * The graph-facing half: reading the intent, finding the storeys to span, and
 * the solve/apply cycle.
 *
 * The invariant that must never break is regeneration: solving twice has to
 * leave the same model, not twice the model. That is the failure mode the roof
 * system guards with its generated-types set, and it is silent when it breaks.
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import {
  applyStairResult,
  computeStairGeometry,
  createStairwellForStorey,
  parseStairIntent,
  resolveStairStoreys,
  solveStair,
} from './solver';
import { STAIR_GENERATED_TYPES } from './types';

const storey = (id: string, bottom: number, top: number): BubbleGraphNode => ({
  id, type: 'storey', name: id, x: 0, y: 0, z: 0,
  properties: { bottomElevation: bottom, topElevation: top },
});

const stairwell = (over: Record<string, unknown> = {}, parentId: string | null = 'st0'): BubbleGraphNode => ({
  id: 'sw1', type: 'stairwell', name: 'Stairwell', x: 1000, y: 2000, z: 0,
  parentId: parentId ?? undefined,
  properties: { stair_type: 'straight', width_mm: 1000, ...over },
});

const base = () => ({
  nodes: [storey('st0', 0, 2900), storey('st1', 2900, 5800), stairwell()],
  edges: [] as BubbleGraphEdge[],
});

describe('parseStairIntent', () => {
  it('falls back to the defaults for anything absent', () => {
    const i = parseStairIntent({ ...stairwell(), properties: {} });
    expect(i.stairType).toBe('straight');
    expect(i.widthMm).toBe(1000);
    expect(i.generateLevel).toBe('flights');
  });

  it('reads a formula-valued number instead of producing NaN', () => {
    const i = parseStairIntent(stairwell({ width_mm: '900 + 200' }));
    expect(i.widthMm).toBe(1100);
  });

  it('tolerates booleans and strings for the flags', () => {
    expect(parseStairIntent(stairwell({ gen_railing: 'True' })).genRailing).toBe(true);
    expect(parseStairIntent(stairwell({ gen_railing: true })).genRailing).toBe(true);
    expect(parseStairIntent(stairwell({ gen_void: 'False' })).genVoid).toBe(false);
  });

  it('ignores an unknown enum rather than trusting it', () => {
    expect(parseStairIntent(stairwell({ stair_type: 'helicoidal' })).stairType).toBe('straight');
  });

  it('reads the spiral and winder intent', () => {
    const i = parseStairIntent(stairwell({
      stair_type: 'spiral', spiral_inner_mm: 150, turn_style: 'winder', winder_count: 4,
    }));
    expect(i.stairType).toBe('spiral');
    expect(i.spiralInnerMm).toBe(150);
    expect(i.turnStyle).toBe('winder');
    expect(i.winderCount).toBe(4);
  });
});

describe('resolveStairStoreys', () => {
  it('climbs from its own storey to the floor of the one above', () => {
    const { nodes, edges } = base();
    const b = resolveStairStoreys(nodes[2], nodes, edges)!;
    expect(b.bottomZMm).toBe(0);
    expect(b.topZMm).toBe(2900);
  });

  it('uses the storey top when there is nothing above', () => {
    const nodes = [storey('st0', 0, 2900), stairwell()];
    const b = resolveStairStoreys(nodes[1], nodes, [])!;
    expect(b.topZMm).toBe(2900);
  });

  it('finds the storey through a connection when the node has no parent', () => {
    // A stairwell drawn against axes comes back with parentId null — the same
    // shape that silently dropped roofs from the ArchiCAD push.
    const ax: BubbleGraphNode = {
      id: 'a1', type: 'ax', name: 'a1', x: 0, y: 0, z: 0, parentId: 'st1',
      properties: {},
    };
    const sw = stairwell({}, null);
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800), ax, sw];
    const edges = [{ id: 'e1', from: 'sw1', to: 'a1' }];

    const b = resolveStairStoreys(sw, nodes, edges)!;
    expect(b.storeyId).toBe('st1');
    expect(b.bottomZMm).toBe(2900);
  });

  it('returns nothing when the project has no storeys at all', () => {
    expect(resolveStairStoreys(stairwell(), [stairwell()], [])).toBeNull();
  });
});

describe('computeStairGeometry', () => {
  it('lands on the floor above', () => {
    const { nodes, edges } = base();
    const { geometry } = computeStairGeometry(nodes[2], nodes, edges);
    expect(geometry!.topZMm).toBeCloseTo(2900, 6);
    expect(geometry!.steps * geometry!.riserMm).toBeCloseTo(2900, 6);
  });

  it('starts the walking line at the node, so moving the node moves the stair', () => {
    const { nodes, edges } = base();
    const { geometry } = computeStairGeometry(nodes[2], nodes, edges);
    expect(geometry!.baseline[0].x).toBe(1000);
    expect(geometry!.baseline[0].y).toBe(2000);
  });

  it('reports an error rather than guessing when there is no storey', () => {
    const sw = stairwell({}, null);
    const { geometry, diagnostics } = computeStairGeometry(sw, [sw], []);
    expect(geometry).toBeNull();
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });
});

describe('solveStair', () => {
  it('emits flights and the slab opening at the default level', () => {
    const { nodes, edges } = base();
    const r = solveStair({ nodes, edges, stairwellId: 'sw1' });
    const types = r.addNodes.map((n) => n.type);
    expect(types).toContain('stair_flight');
    expect(types).toContain('void');
    expect(types).not.toContain('stair_tread'); // only at the `steps` level
  });

  it('emits one tread node per riser at the steps level', () => {
    const { nodes, edges } = base();
    const r = solveStair({ nodes, edges, stairwellId: 'sw1', level: 'steps' });
    const treads = r.addNodes.filter((n) => n.type === 'stair_tread');
    expect(treads).toHaveLength(r.geometry!.steps);
  });

  it('emits nothing but the opening at the outline level', () => {
    const { nodes, edges } = base();
    const r = solveStair({ nodes, edges, stairwellId: 'sw1', level: 'outline' });
    expect(r.addNodes.filter((n) => n.type === 'stair_flight')).toHaveLength(0);
    expect(r.addNodes.filter((n) => n.type === 'void')).toHaveLength(1);
  });

  it('skips the opening when it is turned off', () => {
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800), stairwell({ gen_void: 'False' })];
    const r = solveStair({ nodes, edges: [], stairwellId: 'sw1' });
    expect(r.addNodes.filter((n) => n.type === 'void')).toHaveLength(0);
  });

  it('sizes the opening to clear the whole footprint', () => {
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800),
      stairwell({ stair_type: 'u_shape', width_mm: 1000, void_clearance_mm: 50 })];
    const r = solveStair({ nodes, edges: [], stairwellId: 'sw1' });
    const v = r.addNodes.find((n) => n.type === 'void')!;
    const f = r.geometry!.footprint;
    const spanX = Math.max(...f.map((p) => p.x)) - Math.min(...f.map((p) => p.x));
    const spanY = Math.max(...f.map((p) => p.y)) - Math.min(...f.map((p) => p.y));
    expect(Number(v.properties.width)).toBeGreaterThanOrEqual(spanX);
    expect(Number(v.properties.depth)).toBeGreaterThanOrEqual(spanY);
  });

  it('stamps what it solved onto the parent node', () => {
    const { nodes, edges } = base();
    const r = solveStair({ nodes, edges, stairwellId: 'sw1' });
    const p = r.updateNodes[0].properties;
    expect(p.solved_steps).toBe(17);
    expect(p.solved_rise_mm).toBe(2900);
  });

  it('tags every child so a regenerate can find it again', () => {
    const { nodes, edges } = base();
    const r = solveStair({ nodes, edges, stairwellId: 'sw1', level: 'steps' });
    for (const n of r.addNodes) {
      expect(n.properties.source_stairwell_id).toBe('sw1');
      expect(n.properties.generated).toBe(true);
      expect(STAIR_GENERATED_TYPES.has(n.type)).toBe(true);
    }
  });

  it('errors out on a node that is not a stairwell', () => {
    const { nodes, edges } = base();
    const r = solveStair({ nodes, edges, stairwellId: 'st0' });
    expect(r.diagnostics[0].severity).toBe('error');
    expect(r.addNodes).toHaveLength(0);
  });
});

describe('regeneration', () => {
  it('replaces the previous children instead of stacking a second set', () => {
    const { nodes, edges } = base();

    const first = solveStair({ nodes, edges, stairwellId: 'sw1', level: 'steps' });
    const afterFirst = applyStairResult(nodes, edges, first);

    const second = solveStair({ ...afterFirst, stairwellId: 'sw1', level: 'steps' });
    const afterSecond = applyStairResult(afterFirst.nodes, afterFirst.edges, second);

    const count = (ns: BubbleGraphNode[]) => ns.filter((n) => STAIR_GENERATED_TYPES.has(n.type)).length;
    expect(count(afterSecond.nodes)).toBe(count(afterFirst.nodes));
    expect(second.removeIds).toHaveLength(count(afterFirst.nodes));
  });

  it('clears the old stair even when the new solve fails', () => {
    const { nodes, edges } = base();
    const first = applyStairResult(nodes, edges, solveStair({ nodes, edges, stairwellId: 'sw1' }));

    // Break it: one storey, zero height to climb.
    const broken = first.nodes.map((n) =>
      n.type === 'storey' && n.id === 'st1' ? { ...n, properties: { bottomElevation: 0, topElevation: 0 } } : n);
    const second = solveStair({ nodes: broken, edges: first.edges, stairwellId: 'sw1' });

    expect(second.geometry).toBeNull();
    expect(second.removeIds.length).toBeGreaterThan(0);
    const after = applyStairResult(broken, first.edges, second);
    expect(after.nodes.filter((n) => STAIR_GENERATED_TYPES.has(n.type))).toHaveLength(0);
  });

  it('keeps a child the user locked', () => {
    const { nodes, edges } = base();
    const first = applyStairResult(nodes, edges, solveStair({ nodes, edges, stairwellId: 'sw1' }));
    const locked = first.nodes.map((n) => (n.type === 'stair_flight' ? { ...n, locked: true } : n));

    const second = solveStair({ nodes: locked, edges: first.edges, stairwellId: 'sw1' });
    const lockedIds = locked.filter((n) => n.locked).map((n) => n.id);
    for (const id of lockedIds) expect(second.removeIds).not.toContain(id);
  });
});

describe('createStairwellForStorey', () => {
  it('creates a solved stairwell in one step', () => {
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800)];
    const out = createStairwellForStorey('st0', nodes, [], { stairType: 'u_shape' }, { x: 500, y: 500 });

    expect(out.stairwellId).toBeTruthy();
    const sw = out.nodes.find((n) => n.id === out.stairwellId)!;
    expect(sw.properties.stair_type).toBe('u_shape');
    expect(out.nodes.filter((n) => n.type === 'stair_flight')).toHaveLength(2);
    expect(out.nodes.filter((n) => n.type === 'stair_landing')).toHaveLength(1);
  });

  it('refuses a storey that does not exist', () => {
    const out = createStairwellForStorey('nope', [], [], undefined);
    expect(out.stairwellId).toBe('');
    expect(out.diagnostics[0].severity).toBe('error');
  });
});

/**
 * The renderer reads generated nodes by property name. A rename on either side
 * makes the stair silently invisible — nothing throws, nothing is logged, the
 * geometry just is not there. These pin the contract.
 */
describe('what the 3D renderer needs is what the solver writes', () => {
  const solved = () => {
    const { nodes, edges } = base();
    return solveStair({ nodes, edges, stairwellId: 'sw1', level: 'steps' });
  };

  it('gives every flight its axis, width and waist', () => {
    for (const f of solved().addNodes.filter((n) => n.type === 'stair_flight')) {
      for (const k of ['ax', 'ay', 'az', 'bx', 'by', 'bz', 'width_mm', 'thickness_mm']) {
        expect(Number.isFinite(Number(f.properties[k])), `${k} missing`).toBe(true);
      }
      // A flight must actually rise, or it renders as a flat plate.
      expect(Number(f.properties.bz)).toBeGreaterThan(Number(f.properties.az));
    }
  });

  it('gives every tread its plan direction and step sizes', () => {
    for (const t of solved().addNodes.filter((n) => n.type === 'stair_tread')) {
      for (const k of ['width_mm', 'tread_mm', 'riser_mm', 'dir_x', 'dir_y']) {
        expect(Number.isFinite(Number(t.properties[k])), `${k} missing`).toBe(true);
      }
      const len = Math.hypot(Number(t.properties.dir_x), Number(t.properties.dir_y));
      expect(len).toBeCloseTo(1, 6); // must be a unit vector
    }
  });

  it('gives every landing a parseable polygon, level and thickness', () => {
    const { nodes, edges } = base();
    const r = solveStair({
      nodes: nodes.map((n) => (n.type === 'stairwell' ? { ...n, properties: { ...n.properties, stair_type: 'u_shape' } } : n)),
      edges, stairwellId: 'sw1',
    });
    const landings = r.addNodes.filter((n) => n.type === 'stair_landing');
    expect(landings.length).toBeGreaterThan(0);
    for (const l of landings) {
      const poly = JSON.parse(String(l.properties.polygon));
      expect(poly.length).toBeGreaterThanOrEqual(3);
      for (const p of poly) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(Number(l.properties.level_mm))).toBe(true);
      expect(Number(l.properties.thickness_mm)).toBeGreaterThan(0);
    }
  });

  it('gives the railing the axis and height the renderer reads', () => {
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800), stairwell({ gen_railing: 'True' })];
    const r = solveStair({ nodes, edges: [], stairwellId: 'sw1' });
    const rails = r.addNodes.filter((n) => n.type === 'stair_railing');
    expect(rails.length).toBeGreaterThan(0);
    for (const rail of rails) {
      for (const k of ['ax', 'ay', 'az', 'bx', 'by', 'bz', 'section', 'rail_height_mm', 'side']) {
        expect(rail.properties[k], `${k} missing`).toBeDefined();
      }
    }
  });

  it('puts the railings on the flight edges, one per side', () => {
    // Straight run east, 1000 wide: edges at y = ±(500 − inset). The axis stays
    // at walking-surface level — a rail on the centre line is where people walk.
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800),
      stairwell({ gen_railing: 'True', railing_side: 'both', direction_deg: 0 })];
    const r = solveStair({ nodes, edges: [], stairwellId: 'sw1' });
    const rails = r.addNodes.filter((n) => n.type === 'stair_railing');
    expect(rails).toHaveLength(2);
    const ys = rails.map((n) => Number(n.properties.ay)).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(2000 - 450, 6);
    expect(ys[1]).toBeCloseTo(2000 + 450, 6);
    for (const rail of rails) {
      expect(Number(rail.properties.az)).toBeCloseTo(0, 6);       // walking line, not +900
      expect(Number(rail.properties.rail_height_mm)).toBe(900);
    }
  });

  it('generates a single railing when one side is asked for', () => {
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800),
      stairwell({ gen_railing: 'True', railing_side: 'left', direction_deg: 0 })];
    const r = solveStair({ nodes, edges: [], stairwellId: 'sw1' });
    const rails = r.addNodes.filter((n) => n.type === 'stair_railing');
    expect(rails).toHaveLength(1);
    expect(rails[0].properties.side).toBe('left');
    // Left of an eastbound climb is +Y.
    expect(Number(rails[0].properties.ay)).toBeCloseTo(2000 + 450, 6);
  });

  it('casts a base beam under the first riser, and only there', () => {
    const r = solveStair({ ...base(), stairwellId: 'sw1' });
    const beams = r.addNodes.filter((n) => n.type === 'stair_base_beam');
    expect(beams).toHaveLength(1);
    const flight = r.addNodes.find((n) => n.type === 'stair_flight')!;
    // Web top at the flight's walking-line start, section dims carried along.
    expect(Number(beams[0].properties.ax)).toBeCloseTo(Number(flight.properties.ax), 6);
    expect(Number(beams[0].properties.az)).toBeCloseTo(Number(flight.properties.az), 6);
    expect(beams[0].properties.web_mm).toBe(300);
    expect(beams[0].properties.flange_mm).toBe(600);
    expect(beams[0].properties.depth_mm).toBe(400);
  });

  it('skips the base beam for a non-concrete stair or when switched off', () => {
    const timber = [storey('st0', 0, 2900), storey('st1', 2900, 5800),
      stairwell({ structure: 'timber' })];
    expect(solveStair({ nodes: timber, edges: [], stairwellId: 'sw1' })
      .addNodes.some((n) => n.type === 'stair_base_beam')).toBe(false);

    const off = [storey('st0', 0, 2900), storey('st1', 2900, 5800),
      stairwell({ gen_base_beam: 'False' })];
    expect(solveStair({ nodes: off, edges: [], stairwellId: 'sw1' })
      .addNodes.some((n) => n.type === 'stair_base_beam')).toBe(false);
  });

  it('marks only the last flight as a full-riser top arrival', () => {
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800),
      stairwell({ stair_type: 'u_shape' })];
    const r = solveStair({ nodes, edges: [], stairwellId: 'sw1' });
    const flights = r.addNodes
      .filter((n) => n.type === 'stair_flight')
      .sort((a, b) => Number(a.properties.flight_index) - Number(b.properties.flight_index));
    expect(flights).toHaveLength(2);
    // The lower flight arrives at the landing: the landing edge is its riser.
    expect(flights[0].properties.head_drop_mm).toBe(150);
    expect(flights[0].properties.tail_mm).toBeUndefined();
    // The upper flight arrives at the open top floor: it carries its own riser.
    expect(flights[1].properties.head_drop_mm).toBe(0);
    expect(Number(flights[1].properties.tail_mm)).toBeGreaterThan(0);
    // And only the upper one springs from a landing.
    expect(flights[0].properties.foot_drop_mm).toBe(0);
    expect(flights[1].properties.foot_drop_mm).toBe(150);
  });

  it('generates a spiral as winder wedges around a pole, cleared on regenerate', () => {
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800),
      stairwell({ stair_type: 'spiral', spiral_inner_mm: 100 })];
    const r = solveStair({ nodes, edges: [], stairwellId: 'sw1' });
    const winders = r.addNodes.filter((n) => n.type === 'stair_winder');
    const poles = r.addNodes.filter((n) => n.type === 'stair_column');
    expect(winders.length).toBeGreaterThan(10);
    expect(poles).toHaveLength(1);
    expect(Number(poles[0].properties.height_mm)).toBeCloseTo(2900, 6);
    // No straight parts, no base beam — a spiral has nothing to anchor one to.
    expect(r.addNodes.some((n) => n.type === 'stair_flight')).toBe(false);
    expect(r.addNodes.some((n) => n.type === 'stair_base_beam')).toBe(false);

    // Regeneration clears the previous set instead of stacking a second drum.
    const applied = applyStairResult(nodes, [], r);
    const again = solveStair({ nodes: applied.nodes, edges: [], stairwellId: 'sw1' });
    const after = applyStairResult(applied.nodes, [], again);
    expect(after.nodes.filter((n) => n.type === 'stair_winder')).toHaveLength(winders.length);
    expect(after.nodes.filter((n) => n.type === 'stair_column')).toHaveLength(1);
  });

  it('emits one helix solid instead of wedges for a monolithic spiral', () => {
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800),
      stairwell({ stair_type: 'spiral', spiral_structure: 'monolithic', spiral_inner_mm: 100 })];
    const r = solveStair({ nodes, edges: [], stairwellId: 'sw1' });
    const helix = r.addNodes.filter((n) => n.type === 'stair_helix');
    expect(helix).toHaveLength(1);
    expect(r.addNodes.some((n) => n.type === 'stair_winder')).toBe(false);
    // Everything the renderer needs to rebuild the sweep.
    for (const k of ['inner_mm', 'outer_mm', 'start_rad', 'delta_rad', 'steps', 'riser_mm', 'tread_mm', 'thickness_mm', 'base_z_mm']) {
      expect(helix[0].properties[k], `${k} missing`).toBeDefined();
    }
    expect(Number(helix[0].properties.steps)).toBe(17);
    // The pole still stands.
    expect(r.addNodes.filter((n) => n.type === 'stair_column')).toHaveLength(1);
  });

  it('skips the pole for an open-centre spiral', () => {
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800),
      stairwell({ stair_type: 'spiral', spiral_inner_mm: 0 })];
    const r = solveStair({ nodes, edges: [], stairwellId: 'sw1' });
    expect(r.addNodes.some((n) => n.type === 'stair_column')).toBe(false);
  });

  it('matches the flight junctions to a winder turn', () => {
    const nodes = [storey('st0', 0, 2900), storey('st1', 2900, 5800),
      stairwell({ stair_type: 'l_shape', turn_style: 'winder', winder_count: 3 })];
    const r = solveStair({ nodes, edges: [], stairwellId: 'sw1' });
    const flights = r.addNodes
      .filter((n) => n.type === 'stair_flight')
      .sort((a, b) => Number(a.properties.flight_index) - Number(b.properties.flight_index));
    // The neighbouring surface is a one-riser step block, not a landing slab.
    const riser = Number(flights[0].properties.riser_mm);
    expect(Number(flights[0].properties.head_drop_mm)).toBeCloseTo(riser, 6);
    expect(Number(flights[1].properties.foot_drop_mm)).toBeCloseTo(riser, 6);
    expect(r.addNodes.filter((n) => n.type === 'stair_winder')).toHaveLength(3);
    expect(r.addNodes.some((n) => n.type === 'stair_landing')).toBe(false);
  });

  it('stamps its diagnostics on the node, success or failure', () => {
    const ok = solveStair({ ...base(), stairwellId: 'sw1' });
    expect(ok.updateNodes[0].properties.solved_diagnostics).toBeDefined();

    // No storeys at all: the solve fails, and the node still says why.
    const broken = solveStair({ nodes: [stairwell({}, null)], edges: [], stairwellId: 'sw1' });
    expect(broken.geometry).toBeNull();
    const diags = JSON.parse(String(broken.updateNodes[0].properties.solved_diagnostics));
    expect(diags.some((d: { code: string }) => d.code === 'NO_STOREY')).toBe(true);
  });

  it('gives the opening the box dimensions collectVoids reads', () => {
    const v = solved().addNodes.find((n) => n.type === 'void')!;
    expect(v.properties.void_shape).toBe('box');
    for (const k of ['width', 'depth', 'height']) {
      expect(Number(v.properties[k])).toBeGreaterThan(0);
    }
  });
});

/**
 * Quantity takeoff. The number that matters is the concrete volume: a cast
 * stair is the sloping waist PLUS a wedge per step, and measuring only the
 * waist under-reads it badly.
 */
describe('measured for the takeoff', () => {
  it('measures a straight stair the way a takeoff needs it', async () => {
    const { measureNode } = await import('@/lib/quantityTakeoff/geometryMeasures');
    const { nodes, edges } = base();
    const m = measureNode(nodes[2], edges, new Map(nodes.map((n) => [n.id, n])))!;

    expect(m).not.toBeNull();
    expect(m.count).toBe(17);                       // risers
    expect(m.height_m).toBeCloseTo(2.9, 6);
    expect(m.width_m).toBeCloseTo(1.0, 6);
    // Waist alone would be ≈ 5.38 × 1.0 × 0.15 = 0.81 m³; the steps add ~0.42.
    expect(m.volume_m3).toBeGreaterThan(1.0);
    expect(m.volume_m3).toBeLessThan(1.6);
    expect(m.area_m2).toBeGreaterThan(0);
    expect(m.length_m).toBeGreaterThan(2.9);        // developed, so longer than the rise
  });

  it('counts the step wedges, not just the waist slab', async () => {
    const { measureNode } = await import('@/lib/quantityTakeoff/geometryMeasures');
    const { nodes, edges } = base();
    const map = new Map(nodes.map((n) => [n.id, n]));
    const m = measureNode(nodes[2], edges, map)!;

    const f = { runM: 16 * 0.2888, riseM: 2.9 };
    const slopeM = Math.hypot(f.runM, f.riseM);
    const waistOnly = slopeM * 1.0 * 0.15;
    expect(m.volume_m3).toBeGreaterThan(waistOnly * 1.3);
  });

  it('measures a turning stair as more concrete than a straight one', async () => {
    const { measureNode } = await import('@/lib/quantityTakeoff/geometryMeasures');
    const straight = base();
    const turning = {
      nodes: base().nodes.map((n) => (n.type === 'stairwell'
        ? { ...n, properties: { ...n.properties, stair_type: 'u_shape' } } : n)),
      edges: [] as BubbleGraphEdge[],
    };
    const ms = measureNode(straight.nodes[2], straight.edges, new Map(straight.nodes.map((n) => [n.id, n])))!;
    const mt = measureNode(turning.nodes[2], turning.edges, new Map(turning.nodes.map((n) => [n.id, n])))!;
    expect(mt.volume_m3).toBeGreaterThan(ms.volume_m3); // the landing adds slab
  });

  it('measures nothing rather than guessing when the stair cannot solve', async () => {
    const { measureNode } = await import('@/lib/quantityTakeoff/geometryMeasures');
    const orphan = { ...stairwell({}, null) };
    const m = measureNode(orphan, [], new Map([[orphan.id, orphan]]))!;
    expect(m.volume_m3).toBe(0);
    expect(m.count).toBe(0);
  });
});

/**
 * End to end into the bill of quantities. Measuring a stair is only useful if
 * the norm mapping actually turns it into priced rows — and `computeTakeoff`
 * drops any line whose quantity is ≤ 0, so a broken measure vanishes silently
 * instead of erroring.
 */
describe('reaches the F3 schedule', () => {
  it('produces concrete, formwork and reinforcement rows', async () => {
    const { computeFullTakeoff } = await import('@/lib/quantityTakeoff/takeoffEngine');
    const out = createStairwellForStorey('st0',
      [storey('st0', 0, 2900), storey('st1', 2900, 5800)], [], undefined, { x: 0, y: 0 });

    const { f3 } = computeFullTakeoff(out.nodes, out.edges);
    const rows = f3.filter((r) => r.nodeIds?.includes(out.stairwellId));

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.categorie === 'Scări')).toBe(true);

    const byUnit = Object.fromEntries(rows.map((r) => [r.unit, r.quantity]));
    expect(byUnit.mc).toBeGreaterThan(0.5);   // concrete, m³
    expect(byUnit.mp).toBeGreaterThan(3);     // formwork, m²
    expect(byUnit.kg).toBeGreaterThan(30);    // reinforcement
    // Reinforcement follows the volume at the inherited 61.5 kg/m³ ratio. The
    // F3 quantities are rounded for display, so compare the ratio, not the
    // product of two rounded numbers.
    expect(byUnit.kg / byUnit.mc).toBeCloseTo(61.5, 0);
  });
});
