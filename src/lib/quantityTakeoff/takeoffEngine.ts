/**
 * takeoffEngine.ts — Compute antemăsurători from BIM graph nodes via norm mapping rules.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { calcWallJoins } from '@/lib/bimGeometry';
import {
  findMappingRules,
  getActiveCatalog,
  type TakeoffLine,
  type F3Row,
  type NodeMeasures,
  type NormMappingOutput,
} from '@/lib/norms';
import {
  measureNode,
  getElementTypeId,
  getElementMaterial,
  getStoreyInfo,
} from './geometryMeasures';
import { traceForOutput, type CalcTrace } from './calcTrace';

const ROUND = (n: number) => Math.round(n * 100) / 100;

function evalFormula(formula: string, m: NodeMeasures): number {
  const env: Record<string, number> = {
    length_m: m.length_m,
    height_m: m.height_m,
    thickness_m: m.thickness_m,
    width_m: m.width_m,
    depth_m: m.depth_m,
    gross_area_m2: m.gross_area_m2,
    net_area_m2: m.net_area_m2,
    area_m2: m.area_m2,
    perimeter_m: m.perimeter_m,
    section_m2: m.section_m2,
    volume_m3: m.volume_m3,
    count: m.count,
    opening_area_m2: m.opening_area_m2,
  };
  try {
    const keys = Object.keys(env);
    const vals = Object.values(env);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...keys, `'use strict'; return (${formula});`) as (...a: number[]) => number;
    const result = fn(...vals);
    return typeof result === 'number' && isFinite(result) ? result : 0;
  } catch {
    return 0;
  }
}

function applyOutput(
  output: NormMappingOutput,
  measures: NodeMeasures,
): { quantity: number; source: string } {
  switch (output.measure) {
    case 'length':
      return { quantity: measures.length_m, source: 'length_m' };
    case 'area': {
      const q = output.netOfOpenings ? measures.net_area_m2 : measures.area_m2;
      return {
        quantity: q,
        source: output.netOfOpenings ? 'net_area_m2 (excl. openings)' : 'area_m2',
      };
    }
    case 'volume':
      return { quantity: measures.volume_m3, source: 'volume_m3' };
    case 'count':
      return { quantity: measures.count, source: 'count' };
    case 'opening_area':
      return { quantity: measures.opening_area_m2, source: 'opening_area_m2' };
    case 'formula':
      return {
        quantity: output.formula ? evalFormula(output.formula, measures) : 0,
        source: output.formula ?? 'formula',
      };
    default:
      return { quantity: 0, source: 'unknown' };
  }
}

/**
 * Compute raw takeoff lines (one per node × norm output).
 */
export function computeTakeoff(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): TakeoffLine[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  const lines: TakeoffLine[] = [];

  for (const node of nodes) {
    const measures = measureNode(node, edges, nodeMap, wallJoins);
    if (!measures) continue;

    const elementTypeId = getElementTypeId(node);
    const material = getElementMaterial(node);
    const rules = findMappingRules(node.type, elementTypeId, material);
    if (rules.length === 0) continue;

    const { storeyId, storeyName } = getStoreyInfo(node, nodeMap);
    const seenNorms = new Set<string>();

    for (const rule of rules) {
      for (const output of rule.outputs) {
        if (seenNorms.has(output.normId)) continue;
        const article = getActiveCatalog().map.get(output.normId);
        if (!article) continue;

        const { quantity, source } = applyOutput(output, measures);
        if (quantity <= 0) continue;

        seenNorms.add(output.normId);
        lines.push({
          normId: output.normId,
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          elementTypeId,
          storeyId,
          storeyName,
          quantity: ROUND(quantity),
          unit: article.unit,
          source,
        });
      }
    }
  }

  return lines;
}

/** Aggregate takeoff lines into F3 rows (grouped by normId + storeyId). */
export function aggregateF3(lines: TakeoffLine[]): F3Row[] {
  const groups = new Map<string, F3Row>();

  for (const line of lines) {
    const key = `${line.normId}::${line.storeyId}`;
    const article = getActiveCatalog().map.get(line.normId);
    if (!article) continue;

    const existing = groups.get(key);
    if (existing) {
      existing.quantity = ROUND(existing.quantity + line.quantity);
      if (!existing.nodeIds.includes(line.nodeId)) {
        existing.nodeIds.push(line.nodeId);
      }
    } else {
      groups.set(key, {
        nrCrt: 0,
        normId: line.normId,
        symbol: article.symbol,
        denumire: article.denumire,
        unit: article.unit,
        quantity: ROUND(line.quantity),
        capitol: article.capitol,
        categorie: article.categorie,
        storeyId: line.storeyId,
        storeyName: line.storeyName,
        nodeIds: [line.nodeId],
      });
    }
  }

  const rows = [...groups.values()].sort((a, b) => {
    const cap = a.capitol.localeCompare(b.capitol, 'ro');
    if (cap !== 0) return cap;
    const cat = a.categorie.localeCompare(b.categorie, 'ro');
    if (cat !== 0) return cat;
    const st = a.storeyName.localeCompare(b.storeyName, 'ro');
    if (st !== 0) return st;
    return a.symbol.localeCompare(b.symbol, 'ro');
  });

  return rows.map((row, i) => ({ ...row, nrCrt: i + 1 }));
}

export interface TakeoffResult {
  lines: TakeoffLine[];
  f3: F3Row[];
}

export function computeFullTakeoff(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): TakeoffResult {
  const lines = computeTakeoff(nodes, edges);
  return { lines, f3: aggregateF3(lines) };
}

/** O linie de takeoff îmbogățită cu urma de calcul (provenance). */
export interface TracedTakeoffLine extends TakeoffLine {
  trace: CalcTrace;
}

/**
 * Ca `computeTakeoff`, dar atașează fiecărei linii urma de calcul (`CalcTrace`).
 * Cantitatea e obținută prin `traceForOutput`, care folosește aceeași evaluare
 * de formulă ca `computeTakeoff` — cifrele sunt garantat identice cu F3.
 */
export function computeTakeoffTraced(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): TracedTakeoffLine[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  const lines: TracedTakeoffLine[] = [];

  for (const node of nodes) {
    const measures = measureNode(node, edges, nodeMap, wallJoins);
    if (!measures) continue;

    const elementTypeId = getElementTypeId(node);
    const material = getElementMaterial(node);
    const rules = findMappingRules(node.type, elementTypeId, material);
    if (rules.length === 0) continue;

    const { storeyId, storeyName } = getStoreyInfo(node, nodeMap);
    const seenNorms = new Set<string>();

    for (const rule of rules) {
      for (const output of rule.outputs) {
        if (seenNorms.has(output.normId)) continue;
        const article = getActiveCatalog().map.get(output.normId);
        if (!article) continue;

        const { quantity, source, trace } = traceForOutput(output, measures, article.unit);
        if (quantity <= 0) continue;

        seenNorms.add(output.normId);
        lines.push({
          normId: output.normId,
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          elementTypeId,
          storeyId,
          storeyName,
          quantity: ROUND(quantity),
          unit: article.unit,
          source,
          trace,
        });
      }
    }
  }

  return lines;
}
