/**
 * Stairwell solver — the graph-facing half.
 *
 * Same cycle as the roof: read an intent off the parent node, solve geometry,
 * hand back a set of child nodes to add and the previous set to remove, then let
 * `applyStairResult` merge it. Nothing here mutates the graph.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { evalProp } from '@/lib/formulaUtils';
import { checkStairFits, resolveStairBoundary } from './boundary';
import { checkHeadroom, headroomUnder, solveSteps } from './dimensioning';
import { layoutStair, occupiedCorners, treadsOf } from './layout';
import {
  DEFAULT_STAIR_INTENT,
  STAIR_GENERATED_TYPES,
  STAIR_LIMITS,
  type Pt2,
  type StairDiagnostic,
  type StairGenerateLevel,
  type StairGeometry,
  type StairIntent,
  type StairSolveInput,
  type StairSolveResult,
} from './types';

let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

// ─── Intent ──────────────────────────────────────────────────────────────────

/** Numeric property that may be a formula string, so `Number()` alone gives NaN. */
function num(v: unknown, fallback: number): number {
  if (v == null || v === '') return fallback;
  if (typeof v === 'number') return isFinite(v) ? v : fallback;
  const n = evalProp(v as string, undefined, NaN);
  return isFinite(n) ? n : fallback;
}

/** Opt-in flag, case-insensitive, tolerating real booleans. */
const flag = (v: unknown, fallback: boolean): boolean => {
  if (v == null || v === '') return fallback;
  return String(v).toLowerCase() === 'true';
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
  const s = String(v ?? '').toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
};

export function parseStairIntent(node: BubbleGraphNode): StairIntent {
  const p = node.properties ?? {};
  const d = DEFAULT_STAIR_INTENT;
  return {
    stairType: oneOf(p.stair_type, ['straight', 'l_shape', 'u_shape', 'spiral'] as const, d.stairType),
    widthMm: num(p.width_mm, d.widthMm),
    directionDeg: num(p.direction_deg, d.directionDeg),
    turn: oneOf(p.turn, ['left', 'right'] as const, d.turn),
    turnStyle: oneOf(p.turn_style, ['landing', 'winder'] as const, d.turnStyle),
    winderCount: Math.max(1, Math.round(num(p.winder_count, d.winderCount))),
    spiralInnerMm: Math.max(0, num(p.spiral_inner_mm, d.spiralInnerMm)),
    spiralStructure: oneOf(p.spiral_structure, ['steps', 'monolithic'] as const, d.spiralStructure),
    sizing: oneOf(p.sizing, ['auto', 'explicit'] as const, d.sizing),
    riserMm: num(p.riser_mm, d.riserMm),
    treadMm: num(p.tread_mm, d.treadMm),
    landingDepthMm: num(p.landing_depth_mm, d.landingDepthMm),
    structure: oneOf(p.structure, ['concrete', 'timber', 'steel'] as const, d.structure),
    thicknessMm: num(p.thickness_mm, d.thicknessMm),
    material: String(p.material ?? d.material),
    genVoid: flag(p.gen_void, d.genVoid),
    voidClearanceMm: num(p.void_clearance_mm, d.voidClearanceMm),
    genRailing: flag(p.gen_railing, d.genRailing),
    railingHeightMm: num(p.railing_height_mm, d.railingHeightMm),
    railingSide: oneOf(p.railing_side, ['left', 'right', 'both'] as const, d.railingSide),
    genBaseBeam: flag(p.gen_base_beam, d.genBaseBeam),
    baseBeamWebMm: num(p.base_beam_web_mm, d.baseBeamWebMm),
    baseBeamFlangeMm: num(p.base_beam_flange_mm, d.baseBeamFlangeMm),
    baseBeamFlangeHMm: num(p.base_beam_flange_h_mm, d.baseBeamFlangeHMm),
    baseBeamDepthMm: num(p.base_beam_depth_mm, d.baseBeamDepthMm),
    generateLevel: oneOf(p.generate_level, ['outline', 'flights', 'steps'] as const, d.generateLevel),
  };
}

// ─── Storey resolution ───────────────────────────────────────────────────────

/**
 * The floor-to-floor the stair has to climb.
 *
 * Bottom is the storey the stairwell sits on; top is the NEXT storey up, since
 * that is the floor you arrive at. Falling back to `topElevation` covers a
 * top-storey stair (to a terrace or an attic) that has no storey above it.
 *
 * The storey is found through the parent chain first and then through the
 * stairwell's connections, because — exactly like a roof — a stairwell drawn
 * against the axes it occupies can come back with `parentId: null`.
 */
export function resolveStairStoreys(
  stairwell: BubbleGraphNode,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): { bottomZMm: number; topZMm: number; storeyId: string | null } | null {
  const storeys = nodes
    .filter((n) => n.type === 'storey')
    .sort((a, b) => num(a.properties.bottomElevation, 0) - num(b.properties.bottomElevation, 0));
  if (!storeys.length) return null;

  const byId = new Map(nodes.map((n) => [n.id, n]));

  const chainStorey = (start: BubbleGraphNode): string | null => {
    const seen = new Set<string>();
    let cur: BubbleGraphNode | undefined = start;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.type === 'storey') return cur.id;
      if (!cur.parentId) return null;
      cur = byId.get(cur.parentId);
    }
    return null;
  };

  let storeyId = chainStorey(stairwell);
  if (!storeyId) {
    for (const e of edges) {
      if (e.from !== stairwell.id && e.to !== stairwell.id) continue;
      const other = byId.get(e.from === stairwell.id ? e.to : e.from);
      if (!other) continue;
      const sid = chainStorey(other);
      if (sid) { storeyId = sid; break; }
    }
  }

  const idx = storeyId ? storeys.findIndex((s) => s.id === storeyId) : 0;
  const here = storeys[idx < 0 ? 0 : idx];
  const above = storeys[(idx < 0 ? 0 : idx) + 1];

  const bottomZMm = num(here.properties.bottomElevation, 0);
  const topZMm = above
    ? num(above.properties.bottomElevation, bottomZMm + 3000)
    : num(here.properties.topElevation, bottomZMm + 3000);

  return { bottomZMm, topZMm, storeyId: here.id };
}

// ─── Geometry ────────────────────────────────────────────────────────────────

/**
 * Solve the stair's geometry without touching the graph — the entry point every
 * downstream consumer (3D, 2D, ArchiCAD, quantities) uses.
 */
export function computeStairGeometry(
  stairwell: BubbleGraphNode,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): { geometry: StairGeometry | null; intent: StairIntent; diagnostics: StairDiagnostic[] } {
  const diagnostics: StairDiagnostic[] = [];
  const intent = parseStairIntent(stairwell);

  const band = resolveStairStoreys(stairwell, nodes, edges);
  if (!band) {
    diagnostics.push({
      code: 'NO_STOREY',
      severity: 'error',
      message: 'No storey found — a stairwell needs a storey to climb from.',
    });
    return { geometry: null, intent, diagnostics };
  }

  const sizing = solveSteps(band.topZMm - band.bottomZMm, intent, diagnostics);
  if (!sizing) return { geometry: null, intent, diagnostics };

  // The shaft, when the graph carries one: axes wired to the stairwell in
  // contour order, exactly as a roof takes its contour. It overrides where the
  // stair sits and which way it climbs — never how wide it is. A spiral has no
  // long side to align to, so the node's own position and direction stand.
  const boundary = intent.stairType === 'spiral'
    ? null
    : resolveStairBoundary(stairwell, nodes, edges, intent);
  const origin: Pt2 = boundary ? boundary.origin : { x: stairwell.x, y: stairwell.y };
  const placed = boundary ? { ...intent, directionDeg: boundary.directionDeg } : intent;

  const geometry = layoutStair(origin, band.bottomZMm, sizing, placed);
  if (boundary) {
    geometry.boundary = boundary.polygon;
    checkStairFits(
      occupiedCorners(geometry.flights, geometry.landings, geometry.winders),
      boundary,
      diagnostics,
    );
  }

  // Each flight must read as a flight, not as a step at a landing.
  for (const f of geometry.flights) {
    if (f.steps >= STAIR_LIMITS.stepsPerFlightMin) continue;
    diagnostics.push({
      code: 'FLIGHT_TOO_SHORT',
      severity: 'warning',
      message:
        `Flight ${f.index + 1} has only ${f.steps} riser(s). Use a straight run, or a `
        + `storey height that leaves at least ${STAIR_LIMITS.stepsPerFlightMin} per flight.`,
    });
  }

  // On a half-turn the upper flight runs back over the lower one; the tight spot
  // is where it crosses, and it is also what the slab opening has to clear.
  if (intent.stairType === 'u_shape' && geometry.flights.length === 2) {
    const clear = headroomUnder(geometry.flights[1].end.z, geometry.flights[0].start.z, intent.thicknessMm);
    checkHeadroom(clear, 'where the upper flight crosses the lower', diagnostics);
  }
  // Everyone has to walk out from under the floor above at the top.
  if (geometry.flights.length) {
    checkHeadroom(
      headroomUnder(geometry.topZMm, geometry.flights[0].start.z, intent.thicknessMm),
      'under the floor above',
      diagnostics,
    );
  }

  if (intent.stairType === 'spiral') {
    // The winder going at the walking line is honoured by construction; what a
    // spiral can still get wrong is the turn above your head. Once the sweep
    // passes a full circle, the step one revolution up is the ceiling.
    const rW = Math.max(1, intent.spiralInnerMm + intent.widthMm / 2);
    const stepsPerTurn = (2 * Math.PI * rW) / geometry.treadMm;
    if (geometry.steps > stepsPerTurn) {
      checkHeadroom(
        stepsPerTurn * geometry.riserMm - geometry.riserMm,
        'between turns of the spiral',
        diagnostics,
      );
    }
  }

  if (geometry.winders.length) {
    // Winder goings narrow toward the pivot; the walking-line value is the one
    // the rules measure. Too tight means fewer winders or a wider stair.
    const walk = geometry.winders[0].walkMm;
    if (walk < STAIR_LIMITS.treadMin) {
      diagnostics.push({
        code: 'WINDER_TOO_TIGHT',
        severity: 'warning',
        message:
          `Winder going is ${Math.round(walk)} mm on the walking line, below the `
          + `${STAIR_LIMITS.treadMin} mm minimum. Use fewer winders or a wider flight.`,
      });
    }
  }

  // `placed` rather than `intent`: consumers want the heading the stair was
  // actually built on, which the shaft may have decided.
  return { geometry, intent: placed, diagnostics };
}

// ─── Solve ───────────────────────────────────────────────────────────────────

function childNode(
  type: string,
  name: string,
  centre: { x: number; y: number; z: number },
  stairwellId: string,
  parentId: string | null | undefined,
  props: Record<string, unknown>,
): BubbleGraphNode {
  return {
    id: `${type}_${stairwellId}_${uid()}`,
    type,
    name,
    x: centre.x,
    y: centre.y,
    z: centre.z,
    parentId: parentId ?? undefined,
    properties: {
      source_stairwell_id: stairwellId,
      generated: true,
      ...props,
    },
  };
}

const centreOf = (pts: { x: number; y: number }[], z: number) => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  z,
});

export function solveStair(input: StairSolveInput): StairSolveResult {
  const { nodes, edges, stairwellId } = input;
  const empty = (diagnostics: StairDiagnostic[]): StairSolveResult => ({
    addNodes: [], addEdges: [], removeIds: [], updateNodes: [], geometry: null, diagnostics,
  });

  const stairwell = nodes.find((n) => n.id === stairwellId && n.type === 'stairwell');
  if (!stairwell) {
    return empty([{ code: 'NO_NODE', severity: 'error', message: `No stairwell node ${stairwellId}` }]);
  }

  const { geometry, intent, diagnostics } = computeStairGeometry(stairwell, nodes, edges);

  // Clear the previous run regardless of whether this one succeeds: leaving a
  // stale stair behind after a failed solve is worse than leaving nothing.
  const removeIds = nodes
    .filter((n) => n.properties?.source_stairwell_id === stairwellId && STAIR_GENERATED_TYPES.has(n.type))
    .filter((n) => !(n.locked || n.properties.locked === true || n.properties.locked === 'True'))
    .map((n) => n.id);

  if (!geometry) {
    // Even a failed solve reports WHY on the node, so the Inspector can show it
    // inline instead of the reason vanishing with a toast.
    return {
      ...empty(diagnostics),
      removeIds,
      updateNodes: [{
        ...stairwell,
        properties: { ...stairwell.properties, solved_diagnostics: JSON.stringify(diagnostics) },
      }],
    };
  }

  const level: StairGenerateLevel = input.level ?? intent.generateLevel;
  const parentId = stairwell.parentId;
  const addNodes: BubbleGraphNode[] = [];
  const addEdges: BubbleGraphEdge[] = [];

  if (level !== 'outline') {
    for (const f of geometry.flights) {
      addNodes.push(childNode('stair_flight', `Flight ${f.index + 1}`, {
        x: (f.start.x + f.end.x) / 2,
        y: (f.start.y + f.end.y) / 2,
        z: (f.start.z + f.end.z) / 2,
      }, stairwellId, parentId, {
        role: 'flight',
        flight_index: f.index,
        steps: f.steps,
        riser_mm: f.riserMm,
        tread_mm: f.treadMm,
        width_mm: f.widthMm,
        thickness_mm: intent.thicknessMm,
        // Junction depths for the cast cross-section. A flight springing from a
        // landing drops its foot to that landing's underside. A flight arriving
        // AT a landing stops a landing-thickness short — the landing's edge is
        // the visible part of its last riser. The LAST flight arrives at the
        // top floor, where no landing covers it, so it carries its full last
        // riser itself, with a nib just deep enough to reach across the void
        // clearance to the slab.
        // With a winder turn the neighbouring surface is a step block one riser
        // thick, not a landing slab, so the junction depth follows it.
        foot_drop_mm: f.index > 0
          ? (intent.turnStyle === 'winder' ? f.riserMm : intent.thicknessMm)
          : 0,
        head_drop_mm: f.index === geometry.flights.length - 1
          ? 0
          : (intent.turnStyle === 'winder' ? f.riserMm : intent.thicknessMm),
        ...(f.index === geometry.flights.length - 1
          ? { tail_mm: Math.max(30, intent.voidClearanceMm) }
          : {}),
        material: intent.material,
        ax: f.start.x, ay: f.start.y, az: f.start.z,
        bx: f.end.x, by: f.end.y, bz: f.end.z,
      }));
    }

    for (const l of geometry.landings) {
      addNodes.push(childNode('stair_landing', `Landing ${l.index + 1}`,
        centreOf(l.polygon, l.levelMm), stairwellId, parentId, {
          role: 'landing',
          landing_index: l.index,
          level_mm: l.levelMm,
          thickness_mm: l.thicknessMm,
          material: intent.material,
          polygon: JSON.stringify(l.polygon.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))),
        }));
    }

    // A monolithic spiral is ONE solid — the helical waist with its steps —
    // so it goes out as a single node carrying the sweep, not as wedge blocks.
    const monolithicSpiral = geometry.spiral != null && intent.spiralStructure === 'monolithic';
    if (monolithicSpiral && geometry.spiral) {
      const s = geometry.spiral;
      addNodes.push(childNode('stair_helix', 'Spiral flight', {
        x: s.center.x, y: s.center.y, z: (geometry.bottomZMm + geometry.topZMm) / 2,
      }, stairwellId, parentId, {
        role: 'helix',
        inner_mm: s.innerMm,
        outer_mm: s.outerMm,
        start_rad: s.startRad,
        delta_rad: s.deltaRad,
        steps: geometry.steps,
        riser_mm: geometry.riserMm,
        tread_mm: geometry.treadMm,
        thickness_mm: intent.thicknessMm,
        base_z_mm: geometry.bottomZMm,
        material: intent.material,
      }));
    }

    // Winder steps — the whole stair for a stacked spiral, the corner for a
    // fan turn. Each is a one-riser-thick wedge block.
    if (!monolithicSpiral) {
      for (const w of geometry.winders) {
        addNodes.push(childNode('stair_winder', `Winder ${w.index + 1}`,
          centreOf(w.polygon, w.zTopMm), stairwellId, parentId, {
            role: 'winder',
            winder_index: w.index,
            level_mm: w.zTopMm,
            riser_mm: w.riserMm,
            material: intent.material,
            polygon: JSON.stringify(w.polygon.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))),
          }));
      }
    }

    // The centre pole of a spiral, floor to floor.
    if (geometry.spiral && geometry.spiral.innerMm > 0) {
      addNodes.push(childNode('stair_column', 'Spiral pole', {
        x: geometry.spiral.center.x,
        y: geometry.spiral.center.y,
        z: (geometry.bottomZMm + geometry.topZMm) / 2,
      }, stairwellId, parentId, {
        role: 'spiral_pole',
        radius_mm: geometry.spiral.innerMm,
        base_z_mm: geometry.bottomZMm,
        height_mm: geometry.topZMm - geometry.bottomZMm,
        material: intent.material,
      }));
    }
  }

  if (level === 'steps') {
    for (const f of geometry.flights) {
      for (const [k, t] of treadsOf(f).entries()) {
        addNodes.push(childNode('stair_tread', `Step ${f.index + 1}.${k + 1}`, t.centre,
          stairwellId, parentId, {
            role: 'tread',
            flight_index: f.index,
            step_index: k,
            width_mm: f.widthMm,
            tread_mm: f.treadMm,
            riser_mm: f.riserMm,
            dir_x: t.dir.x,
            dir_y: t.dir.y,
            material: intent.material,
          }));
      }
    }
  }

  // The hole in the slab above. A plain `void` node, so the boolean subtraction
  // already in bimGeometry does the work and every viewer gets it for free.
  if (intent.genVoid) {
    // A wired shaft IS the opening, so it is taken as drawn — no clearance added,
    // because the axes already sit where the architect wants the hole. Without
    // one, the opening is the stair's own footprint plus clearance.
    const f = geometry.boundary ?? geometry.footprint;
    const pad = geometry.boundary ? 0 : intent.voidClearanceMm;
    const minX = Math.min(...f.map((p) => p.x)) - pad;
    const maxX = Math.max(...f.map((p) => p.x)) + pad;
    const minY = Math.min(...f.map((p) => p.y)) - pad;
    const maxY = Math.max(...f.map((p) => p.y)) + pad;
    addNodes.push(childNode('void', 'Stairwell opening', {
      x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: geometry.topZMm,
    }, stairwellId, parentId, {
      role: 'stair_void',
      void_shape: 'box',
      width: Math.round(maxX - minX),
      depth: Math.round(maxY - minY),
      // Deep enough to pass through whatever slab sits at the top, whatever its
      // thickness: an opening that stops short leaves a lip over the stair.
      height: Math.round(Math.max(600, intent.thicknessMm * 4)),
    }));
  }

  // The foundation beam under the first riser — inverted-T section taking the
  // thrust the sloping slab delivers at its bearing. Only the ground-start
  // flight gets one, and only on a concrete stair; upper flights bear on the
  // landing, and a timber or steel stair anchors differently.
  if (intent.genBaseBeam && intent.structure === 'concrete' && geometry.flights.length) {
    const f = geometry.flights[0];
    const runMm = Math.hypot(f.end.x - f.start.x, f.end.y - f.start.y);
    const dir = runMm > 1e-6
      ? { x: (f.end.x - f.start.x) / runMm, y: (f.end.y - f.start.y) / runMm }
      : { x: 1, y: 0 };
    addNodes.push(childNode('stair_base_beam', 'Base beam', {
      x: f.start.x, y: f.start.y, z: f.start.z - intent.baseBeamDepthMm / 2,
    }, stairwellId, parentId, {
      role: 'base_beam',
      material: intent.material,
      dir_x: dir.x,
      dir_y: dir.y,
      width_mm: f.widthMm,
      web_mm: intent.baseBeamWebMm,
      flange_mm: intent.baseBeamFlangeMm,
      flange_h_mm: intent.baseBeamFlangeHMm,
      depth_mm: intent.baseBeamDepthMm,
      // Where the web's top edge sits — the flight's walking-line start.
      ax: f.start.x, ay: f.start.y, az: f.start.z,
    }));
  }

  // Railings live on the flight EDGES, not the walking line: a handrail down
  // the middle of the stair is where a person walks. The axis stays at
  // walking-surface level and `rail_height_mm` lifts the rendered rail, so the
  // posts know both where they stand and how tall they are.
  if (intent.genRailing) {
    const sides = intent.railingSide === 'both'
      ? (['left', 'right'] as const)
      : ([intent.railingSide] as const);
    for (const f of geometry.flights) {
      const runMm = Math.hypot(f.end.x - f.start.x, f.end.y - f.start.y);
      const dir = runMm > 1e-6
        ? { x: (f.end.x - f.start.x) / runMm, y: (f.end.y - f.start.y) / runMm }
        : { x: 1, y: 0 };
      const across = { x: -dir.y, y: dir.x }; // left of the climb
      for (const side of sides) {
        // Inset so the posts stand on the flight rather than off its edge.
        const off = (side === 'left' ? 1 : -1) * (f.widthMm / 2 - 50);
        const a = { x: f.start.x + across.x * off, y: f.start.y + across.y * off, z: f.start.z };
        const b = { x: f.end.x + across.x * off, y: f.end.y + across.y * off, z: f.end.z };
        addNodes.push(childNode('stair_railing', `Railing ${f.index + 1} ${side}`, {
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          z: (a.z + b.z) / 2 + intent.railingHeightMm / 2,
        }, stairwellId, parentId, {
          role: 'railing',
          side,
          section: 'T5x5',
          material: intent.material,
          rail_height_mm: intent.railingHeightMm,
          ax: a.x, ay: a.y, az: a.z,
          bx: b.x, by: b.y, bz: b.z,
          length_mm: Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z),
        }));
      }
    }
  }

  // Record what was solved on the parent, the way the roof stamps its own node.
  const updateNodes: BubbleGraphNode[] = [{
    ...stairwell,
    properties: {
      ...stairwell.properties,
      solved_steps: geometry.steps,
      solved_riser_mm: Math.round(geometry.riserMm * 10) / 10,
      solved_tread_mm: Math.round(geometry.treadMm * 10) / 10,
      solved_rise_mm: Math.round(geometry.topZMm - geometry.bottomZMm),
      base_z: geometry.bottomZMm,
      member_count: addNodes.length,
      // Lets the Inspector say that the heading came from the shaft rather than
      // from the field the user is looking at.
      boundary_ax_count: geometry.boundary ? geometry.boundary.length : 0,
      solved_direction_deg: Math.round(intent.directionDeg * 10) / 10,
      solved_diagnostics: JSON.stringify(diagnostics),
    },
  }];

  return { addNodes, addEdges, removeIds, updateNodes, geometry, diagnostics };
}

/** Merge a solve result into the graph. Mirrors `applyRoofResult`. */
export function applyStairResult(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  result: StairSolveResult,
): { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } {
  const remove = new Set(result.removeIds);
  let nextNodes = nodes.filter((n) => !remove.has(n.id));
  const nextEdges = edges.filter((e) => !remove.has(e.from) && !remove.has(e.to));

  const byId = new Map(nextNodes.map((n) => [n.id, n]));
  for (const u of result.updateNodes) byId.set(u.id, u);
  for (const a of result.addNodes) byId.set(a.id, a);
  nextNodes = [...byId.values()];

  const edgeIds = new Set(nextEdges.map((e) => e.id));
  for (const e of result.addEdges) {
    if (edgeIds.has(e.id)) continue;
    nextEdges.push(e);
    edgeIds.add(e.id);
  }
  return { nodes: nextNodes, edges: nextEdges };
}

/**
 * Create a stairwell on a storey and solve it in one step, so the ribbon button
 * produces something visible rather than an empty node to configure.
 */
export function createStairwellForStorey(
  storeyId: string,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  overrides?: Partial<StairIntent>,
  at?: Pt2,
): {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  stairwellId: string;
  diagnostics: StairDiagnostic[];
} {
  const storey = nodes.find((n) => n.id === storeyId && n.type === 'storey');
  if (!storey) {
    return {
      nodes, edges, stairwellId: '',
      diagnostics: [{ code: 'NO_STOREY', severity: 'error', message: 'Storey not found' }],
    };
  }

  const intent = { ...DEFAULT_STAIR_INTENT, ...overrides };
  const id = `stairwell_${uid()}`;
  const origin = at ?? { x: 0, y: 0 };

  const node: BubbleGraphNode = {
    id,
    type: 'stairwell',
    name: 'Stairwell',
    x: origin.x,
    y: origin.y,
    z: 0,
    parentId: storeyId,
    properties: {
      stair_type: intent.stairType,
      width_mm: intent.widthMm,
      direction_deg: intent.directionDeg,
      turn: intent.turn,
      turn_style: intent.turnStyle,
      winder_count: intent.winderCount,
      spiral_inner_mm: intent.spiralInnerMm,
      spiral_structure: intent.spiralStructure,
      sizing: intent.sizing,
      riser_mm: intent.riserMm,
      tread_mm: intent.treadMm,
      landing_depth_mm: intent.landingDepthMm,
      structure: intent.structure,
      thickness_mm: intent.thicknessMm,
      material: intent.material,
      gen_void: intent.genVoid ? 'True' : 'False',
      void_clearance_mm: intent.voidClearanceMm,
      gen_railing: intent.genRailing ? 'True' : 'False',
      railing_height_mm: intent.railingHeightMm,
      railing_side: intent.railingSide,
      gen_base_beam: intent.genBaseBeam ? 'True' : 'False',
      base_beam_web_mm: intent.baseBeamWebMm,
      base_beam_flange_mm: intent.baseBeamFlangeMm,
      base_beam_flange_h_mm: intent.baseBeamFlangeHMm,
      base_beam_depth_mm: intent.baseBeamDepthMm,
      generate_level: intent.generateLevel,
    },
  };

  const withNode = [...nodes, node];
  const result = solveStair({ nodes: withNode, edges, stairwellId: id });
  const applied = applyStairResult(withNode, edges, result);
  return { ...applied, stairwellId: id, diagnostics: result.diagnostics };
}
