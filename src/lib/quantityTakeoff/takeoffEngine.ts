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
  measureNodeMemo,
  getElementTypeId,
  getElementMaterial,
  getStoreyInfo,
} from './geometryMeasures';
import { traceForOutput, type CalcTrace } from './calcTrace';
import { resolveStructuralSystem } from '@/lib/systems/structuralSystem';
import { resolveSpecs, suppressedArticles } from '@/lib/norms/specs';
import { resolveTakeoffSpecs, resolveTakeoffSystem, type TakeoffOptions } from './takeoffContext';
import { zonePassesFor, scalesWithHeight } from './zonePasses';

const ROUND = (n: number) => Math.round(n * 100) / 100;

function evalFormula(formula: string, m: NodeMeasures): number {
  // Every NodeMeasures key is a number and a formula variable — adding a
  // measure in norms/types.ts is enough for the library to reference it.
  const env: Record<string, number> = { ...m };
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
 * Whether an output belongs in THIS band of a zoned element.
 *
 * An output that is linear in height (plaster = `perimeter_m * height_m`, a
 * wall's volume, the envelope's façade area) is emitted in every band and the
 * bands add back up to the whole. Anything else — a room's floor area, a
 * `count`, a formula with a hardcoded height — is emitted once, in the first
 * band, because emitting it per band would multiply it by the number of bands.
 *
 * The test is a measurement, not an annotation: the element is measured once at
 * half its height and the output is checked for `2·q(H/2) == q(H)`. Nothing in
 * the norm library has to declare anything.
 */
function emitInPass(
  output: NormMappingOutput,
  full: NodeMeasures,
  probe: NodeMeasures | null,
  passIndex: number,
): boolean {
  if (!probe) return true;              // not zoned — the single pass takes all
  if (passIndex === 0) return true;     // the first band carries the non-scaling work
  return scalesWithHeight(
    applyOutput(output, probe).quantity,
    applyOutput(output, full).quantity,
  );
}

/**
 * A wall with `has_beam` carries a ring beam (centură / frame beam) the 3D
 * viewer draws from the wall's own anchors. The deviz used to miss it: only
 * `beam` NODES were measured. This hands the takeoff a synthetic beam per
 * such wall — same id (so F3 rows point at the wall), type `beam`, the
 * section the geometry reads (`beam_section`, else `beam_type`, else the
 * 20×30 default) — measured by `measureBeam` through the wall's anchors.
 */
export function ringBeamsOf(nodes: BubbleGraphNode[]): BubbleGraphNode[] {
  const out: BubbleGraphNode[] = [];
  for (const n of nodes) {
    if (n.type !== 'wall') continue;
    if (String(n.properties?.has_beam ?? '').toLowerCase() !== 'true') continue;
    const section = String(n.properties.beam_section ?? n.properties.beam_type ?? 'B20x30');
    out.push({ ...n, type: 'beam', name: `${n.name ?? n.id} (centură)`, properties: { ...n.properties, beam_section: section } });
  }
  return out;
}

/**
 * Compute raw takeoff lines (one per node × norm output).
 */
export function computeTakeoff(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  opts?: TakeoffOptions,
): TakeoffLine[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  const projectSystem = resolveTakeoffSystem(opts);
  const projectSpecs = resolveTakeoffSpecs(opts);
  const lines: TakeoffLine[] = [];

  for (const node of [...nodes, ...ringBeamsOf(nodes)]) {
    const measures = measureNodeMemo(opts?.memo, node, edges, nodeMap, wallJoins);
    if (!measures) continue;

    const { storeyId, storeyName } = getStoreyInfo(node, nodeMap);
    const { passes, probe } = zonePassesFor(node, measures, edges, nodeMap, wallJoins);

    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i];
      const elementTypeId = getElementTypeId(pass.node);
      const material = getElementMaterial(pass.node);
      const system = resolveStructuralSystem(pass.node, projectSystem);
      const specs = resolveSpecs(pass.node, projectSpecs);
      const rules = findMappingRules(pass.node.type, elementTypeId, material, system, specs);
      if (rules.length === 0) continue;
      // Articles the DEFAULT decomposition produced, dropped because another
      // option was chosen. Only spec-less rules are affected: a rule that
      // carries a specification is here precisely because that option is in
      // force, so an option re-declaring one of the default's articles (premium
      // paint keeps the same exterior coat) must not delete its own work.
      const dropped = suppressedArticles(specs);

      const seenNorms = new Set<string>();

      for (const rule of rules) {
        for (const output of rule.outputs) {
          if (seenNorms.has(output.normId)) continue;
          if (!rule.spec && dropped.has(output.normId)) continue;
          if (!emitInPass(output, measures, probe, i)) continue;
          const article = getActiveCatalog().map.get(output.normId);
          if (!article) continue;

          const { quantity, source } = applyOutput(output, pass.measures);
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
            source: pass.zone ? `${source} · ${pass.zone.label}` : source,
          });
        }
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
  opts?: TakeoffOptions,
): TakeoffResult {
  const lines = computeTakeoff(nodes, edges, opts);
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
  opts?: TakeoffOptions,
): TracedTakeoffLine[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  const projectSystem = resolveTakeoffSystem(opts);
  const projectSpecs = resolveTakeoffSpecs(opts);
  const lines: TracedTakeoffLine[] = [];

  for (const node of [...nodes, ...ringBeamsOf(nodes)]) {
    const measures = measureNodeMemo(opts?.memo, node, edges, nodeMap, wallJoins);
    if (!measures) continue;

    const { storeyId, storeyName } = getStoreyInfo(node, nodeMap);
    const { passes, probe } = zonePassesFor(node, measures, edges, nodeMap, wallJoins);

    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i];
      const elementTypeId = getElementTypeId(pass.node);
      const material = getElementMaterial(pass.node);
      const system = resolveStructuralSystem(pass.node, projectSystem);
      const specs = resolveSpecs(pass.node, projectSpecs);
      const rules = findMappingRules(pass.node.type, elementTypeId, material, system, specs);
      if (rules.length === 0) continue;
      // Articles the DEFAULT decomposition produced, dropped because another
      // option was chosen. Only spec-less rules are affected: a rule that
      // carries a specification is here precisely because that option is in
      // force, so an option re-declaring one of the default's articles (premium
      // paint keeps the same exterior coat) must not delete its own work.
      const dropped = suppressedArticles(specs);

      const seenNorms = new Set<string>();

      for (const rule of rules) {
        for (const output of rule.outputs) {
          if (seenNorms.has(output.normId)) continue;
          if (!rule.spec && dropped.has(output.normId)) continue;
          if (!emitInPass(output, measures, probe, i)) continue;
          const article = getActiveCatalog().map.get(output.normId);
          if (!article) continue;

          const { quantity, source, trace } = traceForOutput(output, pass.measures, article.unit);
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
            source: pass.zone ? `${source} · ${pass.zone.label}` : source,
            trace: pass.zone
              ? { ...trace, sourceLabel: `${trace.sourceLabel} · banda ${pass.zone.label}` }
              : trace,
          });
        }
      }
    }
  }

  return lines;
}
