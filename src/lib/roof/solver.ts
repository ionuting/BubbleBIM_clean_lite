/**
 * roofSolver — envelope → skeleton → framing graph transform.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { getNodeBimPos } from '@/lib/bimGeometry';
import { contourFromStoreyWalls, resolveRoofContour } from './contour';
import { buildRoofFraming } from './framing';
import { buildRoofDetails, coveringLiftMm, liftFacesZ } from './details';
import { buildRoofEnvelope } from './skeleton';
import {
  DEFAULT_ROOF_INTENT,
  DEFAULT_ROOF_DETAILS,
  ROOF_GENERATED_TYPES,
  type RoofDetailOptions,
  type RoofDiagnostic,
  type RoofGenerateLevel,
  type RoofIntent,
  type RoofSolveInput,
  type RoofSolveResult,
  type RoofType,
  type RidgeDirection,
  type RoofFace3D,
  type SkeletonRole,
} from './types';

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Parse a possibly-string boolean property ('True'/'true'/true → true). */
function boolProp(v: unknown, dflt: boolean): boolean {
  if (v == null) return dflt;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

export function parseRoofDetails(p: Record<string, unknown>): RoofDetailOptions {
  const D = DEFAULT_ROOF_DETAILS;
  return {
    membrane: boolProp(p.gen_membrane, D.membrane),
    sheathing: boolProp(p.gen_sheathing, D.sheathing),
    sheathingThicknessMm: Number(p.sheathing_thickness_mm ?? D.sheathingThicknessMm),
    insulation: boolProp(p.gen_insulation, D.insulation),
    insulationThicknessMm: Number(p.insulation_thickness_mm ?? D.insulationThicknessMm),
    counterBattens: boolProp(p.gen_counter_battens, D.counterBattens),
    counterBattenSpacingMm: Number(p.counter_batten_spacing_mm ?? D.counterBattenSpacingMm),
    counterBattenSection: String(p.counter_batten_section ?? D.counterBattenSection),
    battens: boolProp(p.gen_battens, D.battens),
    battenSpacingMm: Number(p.batten_spacing_mm ?? D.battenSpacingMm),
    battenSection: String(p.batten_section ?? D.battenSection),
    fascia: boolProp(p.gen_fascia, D.fascia),
    fasciaHeightMm: Number(p.fascia_height_mm ?? D.fasciaHeightMm),
    fasciaThicknessMm: Number(p.fascia_thickness_mm ?? D.fasciaThicknessMm),
    bargeBoard: boolProp(p.gen_barge_board, D.bargeBoard),
    soffit: boolProp(p.gen_soffit, D.soffit),
    ridgeCaps: boolProp(p.gen_ridge_caps, D.ridgeCaps),
    ridgeCapWidthMm: Number(p.ridge_cap_width_mm ?? D.ridgeCapWidthMm),
    hipCaps: boolProp(p.gen_hip_caps, D.hipCaps),
    valleyFlashing: boolProp(p.gen_valley_flashing, D.valleyFlashing),
    valleyFlashingWidthMm: Number(p.valley_flashing_width_mm ?? D.valleyFlashingWidthMm),
    gutters: boolProp(p.gen_gutters, D.gutters),
    gutterDiameterMm: Number(p.gutter_diameter_mm ?? D.gutterDiameterMm),
    downpipes: boolProp(p.gen_downpipes, D.downpipes),
    downpipeSpacingMm: Number(p.downpipe_spacing_mm ?? D.downpipeSpacingMm),
    downpipeDiameterMm: Number(p.downpipe_diameter_mm ?? D.downpipeDiameterMm),
    snowGuards: boolProp(p.gen_snow_guards, D.snowGuards),
    snowGuardSpacingMm: Number(p.snow_guard_spacing_mm ?? D.snowGuardSpacingMm),
    collarTies: boolProp(p.gen_collar_ties, D.collarTies),
    collarHeightRatio: Number(p.collar_height_ratio ?? D.collarHeightRatio),
  };
}

export function parseRoofIntent(node: BubbleGraphNode): RoofIntent {
  const p = node.properties;
  const roofType = String(p.roof_type ?? DEFAULT_ROOF_INTENT.roofType) as RoofType;
  const ridgeRaw = String(p.ridge_direction ?? 'auto');
  const ridgeDirection = (['auto', 'x', 'y'].includes(ridgeRaw) ? ridgeRaw : 'auto') as RidgeDirection;
  const levelRaw = String(p.generate_level ?? 'envelope');
  const generateLevel = (
    ['envelope', 'skeleton', 'framing'].includes(levelRaw) ? levelRaw : 'envelope'
  ) as RoofGenerateLevel;

  return {
    roofType: ['gable', 'hip', 'shed', 'mansard', 'flat'].includes(roofType)
      ? roofType
      : 'gable',
    pitchDeg: Number(p.pitch_deg ?? DEFAULT_ROOF_INTENT.pitchDeg),
    overhangMm: Number(p.overhang_mm ?? DEFAULT_ROOF_INTENT.overhangMm),
    ridgeDirection,
    ridgeOffsetMm: Number(p.ridge_offset_mm ?? 0),
    system: (String(p.system ?? 'rafter') as RoofIntent['system']),
    rafterSpacingMm: Number(p.rafter_spacing_mm ?? 600),
    rafterSection: String(p.rafter_section ?? DEFAULT_ROOF_INTENT.rafterSection),
    ridgeSection: String(p.ridge_section ?? DEFAULT_ROOF_INTENT.ridgeSection),
    postSection: String(p.post_section ?? DEFAULT_ROOF_INTENT.postSection),
    coveringMaterial: String(p.covering_material ?? DEFAULT_ROOF_INTENT.coveringMaterial),
    coveringThicknessMm: Number(p.covering_thickness_mm ?? DEFAULT_ROOF_INTENT.coveringThicknessMm),
    coveringOffsetMm: Number(p.covering_offset_mm ?? DEFAULT_ROOF_INTENT.coveringOffsetMm),
    generateLevel,
    thicknessMm: Number(p.thickness ?? DEFAULT_ROOF_INTENT.thicknessMm),
    material: String(p.material ?? DEFAULT_ROOF_INTENT.material),
    upperPitchDeg: Number(p.upper_pitch_deg ?? DEFAULT_ROOF_INTENT.upperPitchDeg),
    mansardBreakInsetMm: Number(p.mansard_break_inset_mm ?? DEFAULT_ROOF_INTENT.mansardBreakInsetMm),
    trussSpacingMm: Number(p.truss_spacing_mm ?? DEFAULT_ROOF_INTENT.trussSpacingMm),
    purlinSpacingMm: Number(p.purlin_spacing_mm ?? DEFAULT_ROOF_INTENT.purlinSpacingMm),
    details: parseRoofDetails(p),
  };
}

/** Faces for 3D — pure, no graph mutation. */
export function computeRoofFaces(
  roof: BubbleGraphNode,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): { faces: RoofFace3D[]; diagnostics: RoofDiagnostic[] } {
  const diagnostics: RoofDiagnostic[] = [];
  const intent = parseRoofIntent(roof);
  const contour = resolveRoofContour(roof, nodes, edges, intent.overhangMm, diagnostics);
  if (!contour) return { faces: [], diagnostics };
  const { faces } = buildRoofEnvelope(
    contour,
    intent.roofType,
    intent.pitchDeg,
    intent.ridgeDirection,
    intent.ridgeOffsetMm,
    roof.id,
    diagnostics,
    intent.upperPitchDeg,
    intent.mansardBreakInsetMm,
  );
  // Raise the visible covering surface above the rafters (+ user vertical offset).
  return { faces: liftFacesZ(faces, coveringLiftMm(intent)), diagnostics };
}

export function solveRoof(input: RoofSolveInput): RoofSolveResult {
  const { nodes, edges, roofId, preserveLocked = true } = input;
  const diagnostics: RoofDiagnostic[] = [];
  const roof = nodes.find((n) => n.id === roofId && n.type === 'roof');
  if (!roof) {
    return {
      addNodes: [],
      addEdges: [],
      removeIds: [],
      updateNodes: [],
      faces: [],
      skeleton: [],
      contour: null,
      diagnostics: [{ code: 'NO_CONTOUR', severity: 'error', message: `No roof node ${roofId}` }],
    };
  }

  const intent = parseRoofIntent(roof);
  const level = input.level ?? intent.generateLevel;

  const contour = resolveRoofContour(roof, nodes, edges, intent.overhangMm, diagnostics);
  if (!contour) {
    return {
      addNodes: [],
      addEdges: [],
      removeIds: [],
      updateNodes: [],
      faces: [],
      skeleton: [],
      contour: null,
      diagnostics,
    };
  }

  // If roof has no ax edges yet but we derived from walls — wire contour edges
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const existingAx = edges.filter(
    (e) =>
      (e.from === roofId || e.to === roofId) &&
      (() => {
        const other = nodeMap.get(e.from === roofId ? e.to : e.from);
        return other?.type === 'ax' || other?.type === 'column';
      })(),
  );
  const addEdges: BubbleGraphEdge[] = [];
  if (existingAx.length < 3 && contour.axIds.length >= 3) {
    for (const axId of contour.axIds) {
      addEdges.push({ id: `re_${uid()}`, from: roofId, to: axId });
    }
  }

  const { skeleton, faces } = buildRoofEnvelope(
    contour,
    intent.roofType,
    intent.pitchDeg,
    intent.ridgeDirection,
    intent.ridgeOffsetMm,
    roof.id,
    diagnostics,
    intent.upperPitchDeg,
    intent.mansardBreakInsetMm,
  );

  // Remove previously generated children (unless locked)
  const removeIds: string[] = [];
  for (const n of nodes) {
    if (n.properties.source_roof_id !== roofId) continue;
    if (!ROOF_GENERATED_TYPES.has(n.type) && n.type !== 'covering') continue;
    if (preserveLocked && (n.locked || n.properties.locked === true || n.properties.locked === 'True')) {
      diagnostics.push({
        code: 'LOCKED_SKIP',
        severity: 'info',
        message: `Kept locked ${n.type} ${n.id}`,
      });
      continue;
    }
    removeIds.push(n.id);
  }

  const addNodes: BubbleGraphNode[] = [];
  const roleType: Record<SkeletonRole, string> = {
    ridge: 'roof_ridge',
    eave: 'roof_eave',
    hip: 'roof_hip',
    valley: 'roof_valley',
    break: 'roof_break',
  };
  const roleName: Record<SkeletonRole, string> = {
    ridge: 'Ridge',
    eave: 'Eave',
    hip: 'Hip',
    valley: 'Valley',
    break: 'Break',
  };

  // Skeleton markers (always for envelope+ so canvas/3D show ridge/hips)
  if (level === 'skeleton' || level === 'framing' || level === 'envelope') {
    for (const seg of skeleton) {
      const type = roleType[seg.role] ?? 'roof_ridge';
      const mx = (seg.a.x + seg.b.x) / 2;
      const my = (seg.a.y + seg.b.y) / 2;
      const mz = (seg.a.z + seg.b.z) / 2;
      addNodes.push({
        id: seg.id,
        type,
        name: roleName[seg.role] ?? seg.role,
        x: mx,
        y: my,
        z: mz,
        parentId: roof.parentId,
        properties: {
          source_roof_id: roofId,
          generated: true,
          role: seg.role,
          length_mm: Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y, seg.b.z - seg.a.z),
          ax: seg.a.x,
          ay: seg.a.y,
          az: seg.a.z,
          bx: seg.b.x,
          by: seg.b.y,
          bz: seg.b.z,
        },
      });
    }
  }

  if (level === 'framing') {
    const framing = buildRoofFraming(
      roofId,
      roof.parentId,
      contour,
      intent,
      skeleton,
      faces,
    );
    addNodes.push(...framing);
    diagnostics.push({
      code: 'FRAMING_OK',
      severity: 'info',
      message: `Framing: ${framing.filter((n) => n.type === 'rafter').length} rafters, `
        + `${framing.filter((n) => n.type === 'post').length} posts, `
        + `${framing.filter((n) => n.type === 'covering').length} coverings.`,
    });

    // Optional detail layers (membrane, battens, trim, caps, drainage, …).
    const details = buildRoofDetails({
      roofId, parentId: roof.parentId, contour, intent, skeleton, faces, baseZ: contour.baseZ,
    });
    if (details.length) {
      addNodes.push(...details);
      const byType = new Map<string, number>();
      for (const nd of details) byType.set(nd.type, (byType.get(nd.type) ?? 0) + 1);
      diagnostics.push({
        code: 'DETAILS_OK',
        severity: 'info',
        message: `Details: ${[...byType.entries()].map(([t, c]) => `${c} ${t}`).join(', ')}.`,
      });
    }
  }

  const updateNodes: BubbleGraphNode[] = [
    {
      ...roof,
      properties: {
        ...roof.properties,
        generate_level: level,
        solver_version: '2',
        face_count: faces.length,
        member_count: addNodes.filter((n) => ROOF_GENERATED_TYPES.has(n.type) || n.type === 'covering').length,
        base_z: contour.baseZ,
      },
    },
  ];

  // Centroid roof node on contour
  if (contour.points.length) {
    const cx = contour.points.reduce((s, p) => s + p.x, 0) / contour.points.length;
    const cy = contour.points.reduce((s, p) => s + p.y, 0) / contour.points.length;
    updateNodes[0] = { ...updateNodes[0], x: cx, y: cy, z: contour.baseZ };
  }

  return {
    addNodes,
    addEdges,
    removeIds,
    updateNodes,
    faces,
    skeleton,
    contour,
    diagnostics,
  };
}

export function applyRoofResult(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  result: RoofSolveResult,
): { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } {
  const remove = new Set(result.removeIds);
  let nextNodes = nodes.filter((n) => !remove.has(n.id));
  let nextEdges = edges.filter(
    (e) => !remove.has(e.from) && !remove.has(e.to),
  );

  const byId = new Map(nextNodes.map((n) => [n.id, n]));
  for (const u of result.updateNodes) byId.set(u.id, u);
  for (const a of result.addNodes) byId.set(a.id, a);
  nextNodes = [...byId.values()];

  const edgeIds = new Set(nextEdges.map((e) => e.id));
  for (const e of result.addEdges) {
    if (edgeIds.has(e.id)) continue;
    // Avoid duplicate roof→ax
    const dup = nextEdges.some(
      (x) =>
        (x.from === e.from && x.to === e.to) || (x.from === e.to && x.to === e.from),
    );
    if (dup) continue;
    nextEdges.push(e);
    edgeIds.add(e.id);
  }

  return { nodes: nextNodes, edges: nextEdges };
}

/**
 * Create a new roof node for a storey and run envelope solve.
 */
export function createRoofForStorey(
  storeyId: string,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  overrides?: Partial<RoofIntent>,
): { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[]; roofId: string; diagnostics: RoofDiagnostic[] } {
  const storey = nodes.find((n) => n.id === storeyId && n.type === 'storey');
  const diagnostics: RoofDiagnostic[] = [];
  if (!storey) {
    return {
      nodes,
      edges,
      roofId: '',
      diagnostics: [{ code: 'NO_CONTOUR', severity: 'error', message: 'Storey not found' }],
    };
  }

  const derived = contourFromStoreyWalls(storeyId, nodes, edges);
  if (!derived || derived.points.length < 3) {
    return {
      nodes,
      edges,
      roofId: '',
      diagnostics: [{
        code: 'NO_CONTOUR',
        severity: 'error',
        message: 'Storey needs walls with ≥3 corner ax to create a roof.',
      }],
    };
  }

  const intent = { ...DEFAULT_ROOF_INTENT, ...overrides };
  const cx = derived.points.reduce((s, p) => s + p.x, 0) / derived.points.length;
  const cy = derived.points.reduce((s, p) => s + p.y, 0) / derived.points.length;
  const baseZ = Number(storey.properties.topElevation ?? 3000);
  const roofId = `roof_${uid()}`;

  const roofNode: BubbleGraphNode = {
    id: roofId,
    type: 'roof',
    name: `Roof ${storey.name}`,
    x: cx,
    y: cy,
    z: baseZ,
    parentId: storeyId,
    properties: {
      roof_type: intent.roofType,
      pitch_deg: intent.pitchDeg,
      overhang_mm: intent.overhangMm,
      ridge_direction: intent.ridgeDirection,
      ridge_offset_mm: intent.ridgeOffsetMm,
      system: intent.system,
      rafter_spacing_mm: intent.rafterSpacingMm,
      rafter_section: intent.rafterSection,
      ridge_section: intent.ridgeSection,
      post_section: intent.postSection,
      covering_material: intent.coveringMaterial,
      covering_thickness_mm: intent.coveringThicknessMm,
      generate_level: intent.generateLevel ?? 'framing',
      thickness: intent.thicknessMm,
      material: intent.material,
      solver_version: '2',
    },
  };

  const roofEdges: BubbleGraphEdge[] = derived.axIds.map((axId) => ({
    id: `re_${uid()}`,
    from: roofId,
    to: axId,
  }));

  const withRoof = {
    nodes: [...nodes, roofNode],
    edges: [...edges, ...roofEdges],
  };

  const level = overrides?.generateLevel ?? 'framing';
  const result = solveRoof({
    nodes: withRoof.nodes,
    edges: withRoof.edges,
    roofId,
    level,
  });
  diagnostics.push(...result.diagnostics);
  const applied = applyRoofResult(withRoof.nodes, withRoof.edges, result);
  return { ...applied, roofId, diagnostics };
}

/** Timber section T{w}x{h} in cm → metres (same convention as beams). */
export function parseTimberSection(t: string): { w: number; h: number } {
  const m = t?.match(/^[Tt](\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  return m ? { w: +m[1] * 0.01, h: +m[2] * 0.01 } : { w: 0.08, h: 0.16 };
}

export { getNodeBimPos };
