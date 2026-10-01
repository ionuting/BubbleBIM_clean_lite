/**
 * solidsCompare.ts — the takeoff against the exact solids.
 *
 * The backend measures every exported IFC element as an exact solid and the
 * volume each pair of them shares (backend/topology_solids.py). This lines
 * that up with the takeoff, node by node, through the node id the IFC
 * writer puts in `Tag`:
 *
 *   `wallId`           the wall's body       ← compared with the takeoff
 *   `wallId:gable`     the part a roof adds  ← counted into the body
 *   `wallId:beam`, `roomId:covering:…`, `shellId:band:i`, `roofId:faceId`
 *                      parts priced on their own lines — listed, measured,
 *                      counted in overlaps, but not held against the body.
 *
 * A room's IfcSlab carries the room's id too; a room's takeoff volume is its
 * air, not its slab, so rooms are listed and never compared.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { measureNode } from '@/lib/quantityTakeoff/geometryMeasures';
import type { SolidsResult } from './types';

/** Node types whose takeoff `volume_m3` is the volume of what the IFC body is. */
const COMPARABLE = new Set(['wall', 'ax', 'column', 'beam', 'slab', 'foundation', 'sketch', 'sweep']);
/** Parts that belong to the body they are named after. */
const BODY_PARTS = new Set(['gable']);
/** Relative gap above which a row is flagged — and never for less than a litre. */
export const FLAG_REL = 0.02;
const FLAG_ABS_M3 = 0.001;

export interface SolidRow {
  key: string;
  nodeId: string | null;
  /** The part after the node id (`beam`, `covering`…), null for the body. */
  part: string | null;
  name: string;
  nodeType: string | null;
  ifcTypes: string[];
  elements: number;
  solidM3: number;
  /** The takeoff's volume for the same thing; null where it is not comparable. */
  takeoffM3: number | null;
  diffM3: number | null;
  diffPct: number | null;
  flagged: boolean;
  /** Half of every overlap this row's elements take part in — its share of the double count. */
  overlapM3: number;
}

export interface SolidsComparison {
  rows: SolidRow[];
  overlaps: { a: string; b: string; volumeM3: number }[];
  totals: {
    solidM3: number;
    overlapM3: number;
    /** Union of the solids: what is really there, counted once. */
    netSolidM3: number;
    comparedTakeoffM3: number;
    comparedSolidM3: number;
    flagged: number;
  };
}

export function compareSolids(solids: SolidsResult, nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]): SolidsComparison {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const rows = new Map<string, SolidRow>();
  const rowOfGuid = new Map<string, SolidRow>();

  for (const el of solids.elements) {
    const [head, ...rest] = (el.tag ?? '').split(':');
    const node = head ? nodeMap.get(head) : undefined;
    const rawPart = rest.length ? rest[0] : null;
    const part = rawPart && !BODY_PARTS.has(rawPart) ? rawPart : null;
    const key = node ? `${node.id}${part ? `:${part}` : ''}` : `guid:${el.guid}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        key, nodeId: node?.id ?? null, part,
        name: node ? (node.name || node.id) + (part ? ` · ${part}` : '') : (el.name || el.type),
        nodeType: node?.type ?? null, ifcTypes: [], elements: 0, solidM3: 0,
        takeoffM3: null, diffM3: null, diffPct: null, flagged: false, overlapM3: 0,
      };
      rows.set(key, row);
    }
    row.elements++;
    row.solidM3 += el.volumeM3;
    if (!row.ifcTypes.includes(el.type)) row.ifcTypes.push(el.type);
    rowOfGuid.set(el.guid, row);
  }

  for (const o of solids.overlaps) {
    const a = rowOfGuid.get(o.a), b = rowOfGuid.get(o.b);
    if (a) a.overlapM3 += o.volumeM3 / 2;
    if (b) b.overlapM3 += o.volumeM3 / 2;
  }

  let comparedTakeoff = 0, comparedSolid = 0, flagged = 0;
  for (const row of rows.values()) {
    if (!row.nodeId || row.part || !COMPARABLE.has(row.nodeType ?? '') || row.ifcTypes.includes('IfcSpace')) continue;
    const node = nodeMap.get(row.nodeId)!;
    let m: ReturnType<typeof measureNode> = null;
    try { m = measureNode(node, edges, nodeMap); } catch { m = null; }
    if (!m || !(m.volume_m3 > 0)) continue;
    row.takeoffM3 = m.volume_m3;
    row.diffM3 = row.solidM3 - m.volume_m3;
    row.diffPct = row.diffM3 / m.volume_m3;
    row.flagged = Math.abs(row.diffPct) > FLAG_REL && Math.abs(row.diffM3) > FLAG_ABS_M3;
    comparedTakeoff += m.volume_m3;
    comparedSolid += row.solidM3;
    if (row.flagged) flagged++;
  }

  const label = (guid: string) => rowOfGuid.get(guid)?.name ?? guid;
  const solidM3 = solids.stats.volumeM3;
  const overlapM3 = solids.stats.overlapVolumeM3;
  return {
    rows: [...rows.values()].sort((x, y) =>
      Number(y.flagged) - Number(x.flagged) || y.overlapM3 - x.overlapM3 || y.solidM3 - x.solidM3),
    overlaps: solids.overlaps.map((o) => ({ a: label(o.a), b: label(o.b), volumeM3: o.volumeM3 })),
    totals: {
      solidM3, overlapM3, netSolidM3: solidM3 - overlapM3,
      comparedTakeoffM3: comparedTakeoff, comparedSolidM3: comparedSolid, flagged,
    },
  };
}
