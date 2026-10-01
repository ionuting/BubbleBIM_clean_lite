/**
 * Scatter element — public surface.
 *
 * `computeScatter` is the one pure entry point: the 3D viewers, the plan, the
 * elevations, the quantity takeoff and the Inspector all read the same
 * instances, so the tree in the model is the tree in the schedule.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { getOrderedAnchorNodes, getStoreyBand } from '@/lib/bimGeometry';
import { planPos, polygonArea } from '@/lib/geom/plan2d';
import { sketchOutline } from '@/lib/sketch/types';
import { cleanOutline } from '@/lib/sketch/build';
import { arrayAlongPath, fillArea, pathLength, scatterRng } from './place';
import {
  parseScatterIntent,
  type ScatterDiagnostic,
  type ScatterInstance,
  type ScatterIntent,
  type ScatterResult,
} from './types';

export * from './types';
export * from './place';
export * from './symbols';
export * from './silhouette';

/** Ground elevation at a plan point, BIM mm — null when nothing knows. */
export type HeightAt = (xMm: number, yMm: number) => number | null;

/** The sketch this node is wired to, if any — the first one wins. */
function sourceSketch(node: BubbleGraphNode, nodeMap: Map<string, BubbleGraphNode>, edges: BubbleGraphEdge[]): BubbleGraphNode | null {
  for (const e of edges) {
    const other = e.from === node.id ? e.to : e.to === node.id ? e.from : null;
    if (!other) continue;
    const n = nodeMap.get(other);
    if (n && n.type === 'sketch') return n;
  }
  return null;
}

export function computeScatter(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  heightAt?: HeightAt | null,
): ScatterResult {
  const intent: ScatterIntent = parseScatterIntent(node);
  const diagnostics: ScatterDiagnostic[] = [];
  const result: ScatterResult = {
    intent, source: 'none', region: [], closed: false, mode: 'none',
    instances: [], count: 0, lengthMm: 0, areaMm2: 0, diagnostics,
  };

  // ── the region ──────────────────────────────────────────────────────────
  let region: { x: number; y: number }[] = [];
  let closed = false;
  const sk = sourceSketch(node, nodeMap, edges);
  if (sk) {
    closed = String(sk.properties.closed ?? 'True').toLowerCase() !== 'false';
    // Through the sketch's own door: a parametric rect's points are DERIVED
    // from its numbers, so the raw property can lag behind them.
    region = cleanOutline(sketchOutline(sk, nodeMap, edges), closed);
    result.source = 'sketch';
  } else {
    const anchors = getOrderedAnchorNodes(node.id, edges, nodeMap);
    if (anchors.length) {
      region = cleanOutline(anchors.map((a) => planPos(a, nodeMap)), intent.closed && anchors.length >= 3);
      closed = intent.closed && anchors.length >= 3;
      result.source = 'axes';
    }
  }
  if (region.length < 2) {
    diagnostics.push({
      code: 'SCATTER_NO_SOURCE',
      severity: 'error',
      message: 'Leagă nodul de o schiță (contur închis = împrăștiere pe arie, traseu deschis = array pe traseu) sau de 2+ axe.',
    });
    return result;
  }
  result.region = region;
  result.closed = closed;

  const mode: 'area' | 'path' =
    intent.mode === 'area' ? 'area'
    : intent.mode === 'path' ? 'path'
    : closed ? 'area' : 'path';
  if (mode === 'area' && (!closed || region.length < 3)) {
    diagnostics.push({
      code: 'SCATTER_AREA_OPEN',
      severity: 'error',
      message: 'Împrăștierea pe arie cere un contur închis — închide schița sau treci pe modul Traseu.',
    });
    return result;
  }
  result.mode = mode;

  // ── the ground ──────────────────────────────────────────────────────────
  const band = getStoreyBand(node, nodeMap);
  const parent = node.parentId ? nodeMap.get(node.parentId) : undefined;
  if (!parent || parent.type !== 'storey') {
    diagnostics.push({ code: 'SCATTER_NO_STOREY', severity: 'warning', message: 'Nodul nu aparține unui etaj — cotele cad pe banda implicită.' });
  }
  const zAt = (x: number, y: number) => heightAt?.(x, y) ?? band.bot;

  // ── the points ──────────────────────────────────────────────────────────
  const rnd = scatterRng(intent.seed * 7919 + 13);
  const make = (x: number, y: number, headingDeg: number | null): ScatterInstance => {
    const j = intent.sizeJitter;
    const f = 1 + (rnd() * 2 - 1) * j;
    return {
      x, y, z: zAt(x, y),
      sizeMm: intent.sizeMm * f,
      heightMm: intent.heightMm * f,
      rotDeg: headingDeg ?? rnd() * 360,
      kind: intent.kind,
      variant: rnd(),
    };
  };

  if (mode === 'area') {
    const pts = fillArea(region, {
      count: intent.count, spacingMm: intent.spacingMm,
      minGapMm: intent.minGapMm, edgeMarginMm: intent.edgeMarginMm, seed: intent.seed,
    });
    result.instances = pts.map((p) => make(p.x, p.y, null));
    result.areaMm2 = Math.abs(polygonArea(region));
    result.lengthMm = pathLength(region, true);
    if (intent.count > 0 && pts.length < intent.count) {
      diagnostics.push({
        code: 'SCATTER_NO_ROOM',
        severity: 'warning',
        message: `Au încăput ${pts.length} din ${intent.count} — micșorează distanța minimă sau marginea.`,
      });
    }
  } else {
    const st = arrayAlongPath(region, closed, intent.count, intent.spacingMm);
    result.instances = st.map((s) => make(s.x, s.y, s.headingDeg));
    result.lengthMm = pathLength(region, closed);
  }
  result.count = result.instances.length;
  return result;
}
