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
    default:           return '';
  }
}

function measureWall(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  wallJoins: ReturnType<typeof calcWallJoins>,
): NodeMeasures {
  const geo = calcWallGeometry(node, nodeMap, edges, wallJoins);
  const ctx = resolveFormulaContext(node, edges, nodeMap);
  const lengthM = ctx.wall_length / 1000;
  const heightM = ctx.wall_height / 1000;
  const thicknessM = ctx.wall_thickness / 1000;
  const grossArea = lengthM * heightM;

  let openingArea = 0;
  if (geo) {
    for (const op of geo.openings) {
      openingArea += op.oW * op.oH;
    }
  }

  const netArea = Math.max(0, grossArea - openingArea);
  const volume = lengthM * heightM * thicknessM;

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
): NodeMeasures {
  const poly = calcRoomPolygon(node, nodeMap, edges);
  const areaM2 = poly ? polygonAreaM2(poly) : 0;
  const perimeterM = poly ? polygonPerimeterM(poly) : 0;
  const { bot, top } = getStoreyBand(node, nodeMap);
  const heightM = Number(node.properties.height ?? (top - bot)) / 1000;

  return {
    ...EMPTY,
    area_m2: areaM2,
    perimeter_m: perimeterM,
    height_m: heightM,
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
  ]);
  return MEASURABLE.has(node.type);
}

/**
 * Extract all quantity-relevant measurements for a single node.
 * Returns null for nodes that should not produce takeoff lines.
 */
export function measureNode(
  node: BubbleGraphNode,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
  wallJoins?: ReturnType<typeof calcWallJoins>,
): NodeMeasures | null {
  if (!shouldMeasureNode(node)) return null;

  const joins = wallJoins ?? calcWallJoins([...nodeMap.values()], edges);

  switch (node.type) {
    case 'wall':       return measureWall(node, nodeMap, edges, joins);
    case 'beam':       return measureBeam(node, nodeMap, edges);
    case 'column':
    case 'ax':         return measureColumn(node, nodeMap);
    case 'slab':       return measureSlab(node, nodeMap, edges);
    case 'foundation': return measureFoundation(node);
    case 'window':
    case 'door':       return measureOpening(node);
    case 'room':       return measureRoom(node, nodeMap, edges);
    default:           return null;
  }
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
