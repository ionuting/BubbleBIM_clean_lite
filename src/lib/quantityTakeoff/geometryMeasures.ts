/**
 * geometryMeasures.ts — Extract quantity-relevant measurements from BIM graph nodes.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  calcWallGeometry,
  calcWallJoins,
  calcRoomPolygon,
  calcShellPolygon,
  getStoreyBand,
  getNodeSlabThickness,
  parseBeamDims,
  getConnectedNodes,
  getNodeBimPos,
  resolveStoreyId,
} from '@/lib/bimGeometry';
import { computeStairGeometry } from '@/lib/stair';
import { computeSweep } from '@/lib/sweep';
import {
  WALL_TYPE_MAP,
  BEAM_TYPE_MAP,
  COLUMN_TYPE_MAP,
  SLAB_TYPE_MAP,
  FOUNDATION_TYPE_MAP,
  WINDOW_TYPE_MAP,
  DOOR_TYPE_MAP,
} from '@/lib/elementLibrary';
import { resolveFormulaContext } from '@/lib/formulaUtils';
import { computeRoofFaces } from '@/lib/roof/solver';
import { parseTimberSection } from '@/lib/roof/solver';
import { computeWallFraming } from '@/lib/framing/wallFraming';
import { computeCltPanels } from '@/lib/framing/cltPanels';
import { cltInputForWall, framingInputForWall } from '@/lib/framing/framingInput';
import { wallSidesCached } from '@/lib/walls/wallSides';
import { shellRegion } from '@/lib/shell/region';
import type { NodeMeasures } from '@/lib/norms/types';
import { EMPTY_MEASURES as EMPTY } from '@/lib/norms/types';

function polygonAreaM2(poly: { x: number; y: number }[]): number {
  if (poly.length < 3) return 0;
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area2 += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return Math.abs(area2) / 2e6;
}

function polygonPerimeterM(poly: { x: number; y: number }[]): number {
  let perim = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    perim += Math.hypot(poly[j].x - poly[i].x, poly[j].y - poly[i].y);
  }
  return perim / 1000;
}

function columnPerimeterM(colTypeId: string): number {
  const col = COLUMN_TYPE_MAP.get(colTypeId);
  if (!col) return 0;
  if (col.shape === 'circle') {
    return Math.PI * col.width_mm / 1000;
  }
  return 2 * (col.width_mm + col.depth_mm) / 1000;
}

function columnSectionM2(colTypeId: string): number {
  const col = COLUMN_TYPE_MAP.get(colTypeId);
  if (!col) return 0;
  if (col.shape === 'circle') {
    const r = col.width_mm / 2000;
    return Math.PI * r * r;
  }
  return (col.width_mm * col.depth_mm) / 1e6;
}

/** Resolve element library type id from node properties. */
export function getElementTypeId(node: BubbleGraphNode): string {
  switch (node.type) {
    case 'wall':
      return String(node.properties.wall_type ?? 'W20');
    case 'beam':
      return String(node.properties.beam_section ?? node.properties.beam_type ?? 'B30x60');
    case 'column':
    case 'ax':
      return String(node.properties.column_type ?? 'C25x25');
    case 'slab':
      return String(node.properties.slab_type ?? 'SLAB15');
    case 'foundation':
      return String(node.properties.foundation_type ?? 'F60x60x40');
    case 'window':
      return String(node.properties.window_type ?? '');
    case 'door':
      return String(node.properties.door_type ?? '');
    case 'sweep':
      return String(node.properties.profile ?? 'rect');
    case 'shell':
      // The ROLE is the element type: an envelope and a beam grid are the same
      // geometry decomposed into completely different work.
      return String(node.properties.shell_role ?? 'envelope');
    default:
      return '*';
  }
}

/** Material string from element library for mapping filters. */
export function getElementMaterial(node: BubbleGraphNode): string {
  const id = getElementTypeId(node);
  switch (node.type) {
    case 'wall':       return WALL_TYPE_MAP.get(id)?.material ?? '';
    case 'beam':       return BEAM_TYPE_MAP.get(id)?.material ?? '';
    case 'column':
    case 'ax':         return COLUMN_TYPE_MAP.get(id)?.material ?? '';
    case 'slab':       return SLAB_TYPE_MAP.get(id)?.material ?? '';
    case 'foundation': return FOUNDATION_TYPE_MAP.get(id)?.material ?? '';
    case 'window':     return WINDOW_TYPE_MAP.get(id)?.material ?? String(node.properties.material ?? '');
    case 'door':       return DOOR_TYPE_MAP.get(id)?.material ?? String(node.properties.material ?? '');
    case 'sweep':      return String(node.properties.material ?? '');
    default:           return '';
  }
}

/**
 * A slice of an element's height, in metres from its base. Passed down when the
 * element is split into zones (`lib/zones/heightZones.ts`): the band is measured
 * as if it were the whole element, so a norm formula written in `height_m` needs
 * no notion of zones at all.
 */
export interface MeasureBand {
  fromM: number;
  toM: number;
}

function measureWall(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  wallJoins: ReturnType<typeof calcWallJoins>,
  band?: MeasureBand,
): NodeMeasures {
  const geo = calcWallGeometry(node, nodeMap, edges, wallJoins);
  const ctx = resolveFormulaContext(node, edges, nodeMap);
  const lengthM = ctx.wall_length / 1000;
  const heightM = band ? Math.max(0, band.toM - band.fromM) : ctx.wall_height / 1000;
  const thicknessM = ctx.wall_thickness / 1000;
  const grossArea = lengthM * heightM;

  // An opening counts only for the part of it inside the band: a window sitting
  // between 0.9 and 2.1 m takes nothing out of a 0–0.3 m socle band, and takes
  // 0.6 m of its height out of a band that stops at 1.5 m.
  let openingArea = 0;
  let openingWidth = 0;
  if (geo) {
    for (const op of geo.openings) {
      const h = band
        ? Math.max(0, Math.min(band.toM, op.sill + op.oH) - Math.max(band.fromM, op.sill))
        : op.oH;
      if (h <= 0) continue;
      openingArea += op.oW * h;
      openingWidth += op.oW;
    }
  }

  const netArea = Math.max(0, grossArea - openingArea);
  const volume = lengthM * heightM * thicknessM;

  // Timber framing and CLT panelisation, derived from the same length /
  // height / openings through the ONE input builder the 3D mapper uses. Cheap
  // enough to compute for every wall, and it is the rules — chosen by the
  // structural system — that decide whether either is ever read.
  const fg = {
    lengthMm: ctx.wall_length,
    heightMm: heightM * 1000,
    thicknessMm: ctx.wall_thickness,
    // Inside a band the openings are band-local too: sill measured from the
    // band's own base, height clipped to it, so a panel or a stud wall is
    // framed for the slice it actually is.
    openings: (geo?.openings ?? [])
      .map((op) => {
        const lo = band ? Math.max(band.fromM, op.sill) : op.sill;
        const hi = band ? Math.min(band.toM, op.sill + op.oH) : op.sill + op.oH;
        return {
          x0Mm: op.tS * 1000,
          widthMm: op.oW * 1000,
          sillMm: (lo - (band?.fromM ?? 0)) * 1000,
          heightMm: Math.max(0, hi - lo) * 1000,
        };
      })
      .filter((op) => op.heightMm > 0),
  };
  const framing = computeWallFraming(framingInputForWall(node, edges, nodeMap, fg));
  const clt = computeCltPanels(cltInputForWall(node, fg));

  // Side from the storey's exterior ring; a wall that cannot be placed is
  // treated as interior, so "exterior only" rules never fire on it.
  const side = wallSidesCached(nodeMap, edges).get(node.id);
  const isExterior = side === 'exterior' ? 1 : 0;

  return {
    ...EMPTY,
    length_m: lengthM,
    height_m: heightM,
    thickness_m: thicknessM,
    gross_area_m2: grossArea,
    net_area_m2: netArea,
    area_m2: grossArea,
    volume_m3: volume,
    opening_area_m2: openingArea,
    count: 1,
    stud_count: framing.studCount,
    framing_length_m: framing.framingLengthM,
    sheathing_area_m2: framing.sheathingAreaM2,
    stud_length_m: framing.studLengthM,
    plate_length_m: framing.plateLengthM,
    header_length_m: framing.headerLengthM,
    header_count: framing.headerCount,
    sheathing_sheet_count: framing.sheathingSheetCount,
    panel_count: clt.panelCount,
    panel_area_m2: clt.grossAreaM2,
    cut_length_m: clt.cutLengthM,
    joint_length_m: clt.jointLengthM,
    connector_count: clt.bracketCount + clt.holdDownCount,
    is_exterior: isExterior,
    is_interior: 1 - isExterior,
    opening_count: geo?.openings.length ?? 0,
    opening_width_m: openingWidth,
  };
}

/** Area of a planar 3D polygon (Newell), mm² → m². */
function faceAreaM2(verts: { x: number; y: number; z: number }[]): number {
  if (verts.length < 3) return 0;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return Math.hypot(nx, ny, nz) / 2 / 1e6;
}

/**
 * A roof, measured from its solved faces: the sloped surface is what the
 * șarpantă and the covering norms are priced per m² of. Gable ends are walls'
 * business, not the roof's.
 */
function measureRoof(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): NodeMeasures {
  const { faces } = computeRoofFaces(node, [...nodeMap.values()], edges);
  let slope = 0;
  let plan = 0;
  for (const f of faces) {
    if (f.role !== 'slope') continue;
    slope += faceAreaM2(f.vertices);
    plan += faceAreaM2(f.vertices.map((v) => ({ x: v.x, y: v.y, z: 0 })));
  }
  return { ...EMPTY, area_m2: slope, gross_area_m2: plan, count: faces.length > 0 ? 1 : 0 };
}

/** A generated roof member (rafter, plate, purlin…): its length and timber section. */
function measureTimberMember(node: BubbleGraphNode): NodeMeasures {
  const p = node.properties;
  const [ax, ay, az, bx, by, bz] = [p.ax, p.ay, p.az, p.bx, p.by, p.bz].map(Number);
  const lengthM = [ax, ay, az, bx, by, bz].every(Number.isFinite)
    ? Math.hypot(bx - ax, by - ay, bz - az) / 1000
    : Number(p.length_mm ?? 0) / 1000;
  const { w, h } = parseTimberSection(String(p.section ?? 'T8x16'));
  return {
    ...EMPTY,
    length_m: lengthM,
    width_m: w,
    height_m: h,
    section_m2: w * h,
    volume_m3: w * h * lengthM,
    count: 1,
  };
}

function measureBeam(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): NodeMeasures {
  const endpoints = getConnectedNodes(node.id, edges, nodeMap)
    .filter((n) => n.type === 'ax' || n.type === 'column' || n.type === 'wall');
  let lengthM = 0;
  if (endpoints.length >= 2) {
    const pA = getNodeBimPos(endpoints[0], nodeMap);
    const pB = getNodeBimPos(endpoints[1], nodeMap);
    lengthM = Math.hypot(pB.x - pA.x, pB.y - pA.y) / 1000;
  }

  const beamId = getElementTypeId(node);
  const { bw, bh } = parseBeamDims(beamId);
  const section = bw * bh;
  const volume = lengthM * section;

  return {
    ...EMPTY,
    length_m: lengthM,
    width_m: bw,
    height_m: bh,
    section_m2: section,
    volume_m3: volume,
    count: 1,
  };
}

function measureColumn(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
): NodeMeasures {
  const colId = getElementTypeId(node);
  const { bot, top } = getStoreyBand(node, nodeMap);
  const heightM = (top - bot) / 1000;
  const section = columnSectionM2(colId);
  const perimeter = columnPerimeterM(colId);
  const col = COLUMN_TYPE_MAP.get(colId);

  return {
    ...EMPTY,
    height_m: heightM,
    width_m: (col?.width_mm ?? 0) / 1000,
    depth_m: (col?.depth_mm ?? 0) / 1000,
    section_m2: section,
    perimeter_m: perimeter,
    volume_m3: section * heightM,
    count: 1,
  };
}

function measureSlab(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): NodeMeasures {
  let poly = calcShellPolygon(node, nodeMap, edges);
  let areaM2 = poly ? polygonAreaM2(poly) : 0;

  if (areaM2 === 0) {
    const sibs = [...nodeMap.values()].filter((s) => s.parentId === node.parentId && s.type !== 'storey');
    if (sibs.length > 0) {
      const xs = sibs.map((s) => s.x);
      const ys = sibs.map((s) => s.y);
      areaM2 = ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 1e6;
    }
  }

  const thicknessM = getNodeSlabThickness(node);
  return {
    ...EMPTY,
    area_m2: areaM2,
    thickness_m: thicknessM,
    volume_m3: areaM2 * thicknessM,
    count: 1,
  };
}

function measureFoundation(node: BubbleGraphNode): NodeMeasures {
  const fId = getElementTypeId(node);
  const f = FOUNDATION_TYPE_MAP.get(fId);
  if (!f) return { ...EMPTY, count: 1 };

  const w = f.width_mm / 1000;
  const d = f.depth_mm / 1000;
  const h = f.height_mm / 1000;
  return {
    ...EMPTY,
    width_m: w,
    depth_m: d,
    height_m: h,
    volume_m3: w * d * h,
    count: 1,
  };
}

function measureOpening(node: BubbleGraphNode): NodeMeasures {
  const id = getElementTypeId(node);
  const lib = node.type === 'window' ? WINDOW_TYPE_MAP.get(id) : DOOR_TYPE_MAP.get(id);
  const w = (lib?.width_mm ?? Number(node.properties.width ?? 0)) / 1000;
  const h = (lib?.height_mm ?? Number(node.properties.height ?? 0)) / 1000;
  return {
    ...EMPTY,
    width_m: w,
    height_m: h,
    opening_area_m2: w * h,
    count: 1,
  };
}

function measureRoom(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  band?: MeasureBand,
): NodeMeasures {
  const poly = calcRoomPolygon(node, nodeMap, edges);
  const areaM2 = poly ? polygonAreaM2(poly) : 0;
  const perimeterM = poly ? polygonPerimeterM(poly) : 0;
  const { bot, top } = getStoreyBand(node, nodeMap);
  // Floor area and perimeter are the room's whatever the band; only the height
  // of the wall face it offers changes.
  const heightM = band
    ? Math.max(0, band.toM - band.fromM)
    : Number(node.properties.height ?? (top - bot)) / 1000;

  return {
    ...EMPTY,
    area_m2: areaM2,
    perimeter_m: perimeterM,
    height_m: heightM,
    count: 1,
  };
}

/**
 * A stairwell, measured from its solved geometry rather than its properties.
 *
 * The concrete volume is what a takeoff actually needs, and it is not the
 * bounding box: a cast stair is the sloping waist slab plus the wedge of each
 * step sitting on it. Measuring the waist alone under-reads by roughly the step
 * volume, which on a 17-step flight is not a rounding error.
 *
 *   length_m  developed length of the walking line (handrail, edge finish)
 *   area_m2   plan area of the footprint (slab opening, formwork take-off)
 *   volume_m3 waist + steps + landings
 *   count     number of risers
 */
function measureStair(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): NodeMeasures {
  const { geometry, intent } = computeStairGeometry(node, [...nodeMap.values()], edges);
  if (!geometry) return { ...EMPTY };

  const waistM = intent.thicknessMm / 1000;
  const widthM = intent.widthMm / 1000;

  let lengthM = 0;
  let volumeM3 = 0;
  for (const f of geometry.flights) {
    const runM = Math.hypot(f.end.x - f.start.x, f.end.y - f.start.y) / 1000;
    const riseM = (f.end.z - f.start.z) / 1000;
    const slopeM = Math.hypot(runM, riseM);
    lengthM += slopeM;
    // Waist slab along the slope, plus one triangular step wedge per riser.
    volumeM3 += slopeM * widthM * waistM;
    volumeM3 += f.steps * 0.5 * (f.treadMm / 1000) * (f.riserMm / 1000) * widthM;
  }
  for (const l of geometry.landings) {
    const areaM2 = Math.abs(polygonAreaM2(l.polygon));
    volumeM3 += areaM2 * (l.thicknessMm / 1000);
    lengthM += Math.sqrt(areaM2); // the traverse across the landing
  }

  // Winder steps — spiral treads and fan corners. Stacked construction is
  // full-riser wedge blocks; the monolithic spiral is the helical waist plus a
  // half-wedge of step on top, so it carries roughly half the step concrete.
  const monolithic = geometry.spiral != null && intent.spiralStructure === 'monolithic';
  for (const w of geometry.winders) {
    const areaM2 = Math.abs(polygonAreaM2(w.polygon));
    volumeM3 += areaM2 * (w.riserMm / 1000) * (monolithic ? 0.5 : 1);
    lengthM += Math.hypot(w.walkMm, w.riserMm) / 1000;
  }
  if (monolithic) {
    // The waist: width × thickness × developed slope length at the walking line.
    const slopeM = geometry.winders.length
      * (Math.hypot(geometry.treadMm, geometry.riserMm) / 1000);
    volumeM3 += widthM * waistM * slopeM;
  }
  // The spiral's centre pole.
  if (geometry.spiral && geometry.spiral.innerMm > 0) {
    const rM = geometry.spiral.innerMm / 1000;
    volumeM3 += Math.PI * rM * rM * ((geometry.topZMm - geometry.bottomZMm) / 1000);
  }

  // The inverted-T foundation beam at the base: cross-section area × width.
  // A spiral emits no beam (no straight flight to anchor), so none is counted.
  if (intent.genBaseBeam && intent.structure === 'concrete' && geometry.flights.length) {
    const flangeM2 = (intent.baseBeamFlangeMm / 1000) * (intent.baseBeamFlangeHMm / 1000);
    const webM2 = (intent.baseBeamWebMm / 1000)
      * ((intent.baseBeamDepthMm - intent.baseBeamFlangeHMm) / 1000);
    volumeM3 += (flangeM2 + Math.max(0, webM2)) * widthM;
  }

  const fp = geometry.footprint;
  const areaM2 = fp.length >= 3 ? Math.abs(polygonAreaM2(fp)) : 0;

  return {
    ...EMPTY,
    length_m: lengthM,
    width_m: widthM,
    thickness_m: waistM,
    height_m: (geometry.topZMm - geometry.bottomZMm) / 1000,
    area_m2: areaM2,
    gross_area_m2: areaM2,
    perimeter_m: fp.length >= 3 ? polygonPerimeterM(fp) : 0,
    volume_m3: volumeM3,
    count: geometry.steps,
  };
}

/**
 * Sweep: one pure compute shared with the viewers, so the F3 volume is the
 * volume of the mesh on screen — miter corners included.
 */
function measureSweep(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): NodeMeasures {
  const res = computeSweep(node, nodeMap, edges);
  if (!res.placed || res.solids.length === 0) return { ...EMPTY };
  const lengthM = res.lengthMm / 1000;
  const perimM = res.perimeterMm / 1000;
  return {
    ...EMPTY,
    length_m: lengthM,
    height_m: (res.zMaxMm - res.zMinMm) / 1000,
    section_m2: res.areaMm2 / 1e6,
    perimeter_m: perimM,
    area_m2: perimM * lengthM,
    gross_area_m2: perimM * lengthM,
    volume_m3: res.volumeMm3 / 1e9,
    count: 1,
  };
}

/** Skip ax nodes without column. */
function shouldMeasureNode(node: BubbleGraphNode): boolean {
  if (node.type === 'ax') {
    return String(node.properties.has_column ?? '').toLowerCase() === 'true';
  }
  const MEASURABLE = new Set([
    'wall', 'beam', 'column', 'slab', 'foundation', 'window', 'door', 'room',
    'stairwell', 'sweep', 'roof', 'shell', ...TIMBER_MEMBER_TYPES,
  ]);
  return MEASURABLE.has(node.type);
}

/** Roof members the solver generates as nodes — box timber, measured by length. */
const TIMBER_MEMBER_TYPES = ['rafter', 'hip_rafter', 'valley_rafter', 'ridge_beam', 'wall_plate', 'purlin', 'post'];

/**
 * Extract all quantity-relevant measurements for a single node.
 * Returns null for nodes that should not produce takeoff lines.
 */
/**
 * A shell: the building's contour with its cells punched out — see
 * `lib/shell/region.ts`. Every reading is exposed, and the ROLE decides which
 * of them the generic `area_m2` / `volume_m3` carry, so a norm rule can say
 * `shell | foundation → volume` and mean the plin × height.
 */
function measureShell(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  band?: MeasureBand,
): NodeMeasures | null {
  const r = shellRegion(node, [...nodeMap.values()], edges, nodeMap,
    band ? Math.max(0, band.toM - band.fromM) : undefined);
  if (!r) return null;
  return {
    ...EMPTY,
    height_m: r.heightM,
    thickness_m: r.thicknessM,
    perimeter_m: r.outerPerimeterM,
    outer_perimeter_m: r.outerPerimeterM,
    hole_perimeter_m: r.holePerimeterM,
    hole_area_m2: r.holeAreaM2,
    hole_count: r.holeCount,
    gross_area_m2: r.grossAreaM2,
    net_solid_area_m2: r.netSolidAreaM2,
    band_area_m2: r.bandAreaM2,
    outer_face_area_m2: r.outerFaceAreaM2,
    inner_face_area_m2: r.innerFaceAreaM2,
    area_m2: r.areaM2,
    net_area_m2: r.areaM2,
    volume_m3: r.volumeM3,
    count: 1,
  };
}

export function measureNode(
  node: BubbleGraphNode,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
  wallJoins?: ReturnType<typeof calcWallJoins>,
  /** Measure only this slice of the element's height — see `MeasureBand`. */
  band?: MeasureBand,
): NodeMeasures | null {
  if (!shouldMeasureNode(node)) return null;

  const joins = wallJoins ?? calcWallJoins([...nodeMap.values()], edges);

  switch (node.type) {
    case 'wall':       return measureWall(node, nodeMap, edges, joins, band);
    case 'beam':       return measureBeam(node, nodeMap, edges);
    case 'column':
    case 'ax':         return measureColumn(node, nodeMap);
    case 'slab':       return measureSlab(node, nodeMap, edges);
    case 'foundation': return measureFoundation(node);
    case 'window':
    case 'door':       return measureOpening(node);
    case 'room':       return measureRoom(node, nodeMap, edges, band);
    case 'stairwell':  return measureStair(node, nodeMap, edges);
    case 'sweep':      return measureSweep(node, nodeMap, edges);
    case 'roof':       return measureRoof(node, nodeMap, edges);
    case 'shell':      return measureShell(node, nodeMap, edges, band);
    default:
      return TIMBER_MEMBER_TYPES.includes(node.type) ? measureTimberMember(node) : null;
  }
}

// ─── Memo ────────────────────────────────────────────────────────────────────

/**
 * A per-node measurement cache keyed by node OBJECT IDENTITY.
 *
 * A caller that derives a variant of the graph keeps every untouched node as
 * the SAME object, so a memo keyed on identity is hit for every node the
 * variant did not change — which is why re-measuring a variant costs almost
 * nothing.
 *
 * What a node's measure depends on beyond itself is its CONNECTED nodes (a
 * wall's anchors and its windows) and the edge list, so an entry is reused
 * only while those are the same objects too. Rooms, slabs and stairs read the
 * wider neighbourhood (polygons walked through other walls) and are never
 * cached — they are few, and correctness beats the saving.
 */
export interface MeasureMemo {
  entries: WeakMap<BubbleGraphNode, { edges: BubbleGraphEdge[]; deps: string; measures: NodeMeasures | null }>;
}

export function createMeasureMemo(): MeasureMemo {
  return { entries: new WeakMap() };
}

const MEMOISABLE = new Set(['wall', 'beam', 'column', 'ax', 'foundation', 'window', 'door', 'sweep', ...TIMBER_MEMBER_TYPES]);

/** Identity signature of the nodes a measure reads besides the node itself. */
function depsSignature(node: BubbleGraphNode, edges: BubbleGraphEdge[], nodeMap: Map<string, BubbleGraphNode>): string {
  const parts: string[] = [];
  for (const e of edges) {
    if (e.from !== node.id && e.to !== node.id) continue;
    const other = nodeMap.get(e.from === node.id ? e.to : e.from);
    if (other) parts.push(`${other.id}@${identityTag(other)}`);
  }
  const storey = node.parentId ? nodeMap.get(node.parentId) : undefined;
  if (storey) parts.push(`st@${identityTag(storey)}`);
  return parts.sort().join(',');
}

// Object identity as a stable token: a WeakMap hands every object a number once.
const identityIds = new WeakMap<object, number>();
let nextIdentity = 1;
function identityTag(o: object): number {
  let id = identityIds.get(o);
  if (id === undefined) { id = nextIdentity++; identityIds.set(o, id); }
  return id;
}

/** `measureNode`, served from `memo` when the node and everything it reads are unchanged. */
export function measureNodeMemo(
  memo: MeasureMemo | undefined,
  node: BubbleGraphNode,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
  wallJoins?: ReturnType<typeof calcWallJoins>,
): NodeMeasures | null {
  if (!memo || !MEMOISABLE.has(node.type)) return measureNode(node, edges, nodeMap, wallJoins);
  const deps = depsSignature(node, edges, nodeMap);
  const hit = memo.entries.get(node);
  if (hit && hit.edges === edges && hit.deps === deps) return hit.measures;
  const measures = measureNode(node, edges, nodeMap, wallJoins);
  memo.entries.set(node, { edges, deps, measures });
  return measures;
}

export function getStoreyInfo(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
): { storeyId: string; storeyName: string } {
  const storeyId = resolveStoreyId(node, nodeMap) ?? 'unknown';
  const storey = nodeMap.get(storeyId);
  return {
    storeyId,
    storeyName: storey?.name ?? (storeyId === 'unknown' ? '—' : storeyId),
  };
}
