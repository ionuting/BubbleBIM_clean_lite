/**
 * pad.ts — platforms, terraces and cut-outs the GRAPH asks the ground for.
 *
 * The Terrain tab's own zones are drawn by hand and live in the terrain
 * model. A pad is the same operation stated as a graph node, and that is the
 * whole point: it is PARAMETRIC. Its outline comes from a sketch — the
 * rectangle tool included — so the plan is where the shape is drawn and
 * corrected; its level is one number in the Inspector; and the transition
 * from the surrounding ground to that level is either a vertical face or a
 * batter at a stated angle. Change the number, the earth follows.
 *
 * ## Where the outline comes from
 *
 * The same rule the scatter node uses, so there is one thing to learn:
 *
 *   a connected `sketch`  → its outline (closed)
 *   3+ ax anchors         → a polygon in edge order
 *
 * ## Cut, fill, or both
 *
 * A pad on a slope usually needs both: dig into the high side, build up the
 * low one. `cut` only lowers, `fill` only raises, `both` makes the platform
 * whatever the ground was. Cutting is idempotent against a FIXED batter
 * surface (see `applyZones`), so a pad can be re-applied over ground that has
 * already been shaped by hand without eating it twice.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { getOrderedAnchorNodes, getStoreyBand } from '@/lib/bimGeometry';
import { planPos, type Pt2 } from '@/lib/geom/plan2d';
import { sketchOutline } from '@/lib/sketch/types';
import { bimToTerrain, bimZToTerrain, type SiteFrame } from './frame';
import { insideGrid, type GridSpec } from './heightGrid';
import type { ExcavationZone, ZoneMode } from './types';

export type PadTransition = 'vertical' | 'slope';
export type PadLevelMode = 'absolute' | 'storey';

export interface PadIntent {
  /** Target elevation: absolute BIM mm, or an offset from the storey's base. */
  levelMm: number;
  levelMode: PadLevelMode;
  transition: PadTransition;
  /** Batter angle from horizontal, degrees. 45° is 1:1. */
  slopeDeg: number;
  mode: ZoneMode;
  /** Ax-anchored pads: close the polygon (a pad is an area, so default on). */
  closed: boolean;
}

export const DEFAULT_PAD_INTENT: PadIntent = {
  levelMm: 0,
  levelMode: 'storey',
  transition: 'vertical',
  slopeDeg: 45,
  mode: 'both',
  closed: true,
};

/** What a pad resolved to — for the plan, the Inspector and the diagnostics. */
export interface PadInfo {
  nodeId: string;
  /** The outline in BIM mm. */
  outline: Pt2[];
  /** The absolute target elevation, BIM mm. */
  levelMm: number;
  transition: PadTransition;
  slopeDeg: number;
  mode: ZoneMode;
  source: 'sketch' | 'axes';
}

const num = (v: unknown, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const truthy = (v: unknown): boolean => v === true || String(v ?? '').toLowerCase() === 'true';

export function parsePadIntent(node: BubbleGraphNode): PadIntent {
  const p = node.properties ?? {};
  const D = DEFAULT_PAD_INTENT;
  const mode: ZoneMode = p.mode === 'cut' || p.mode === 'fill' || p.mode === 'both' ? p.mode : D.mode;
  return {
    levelMm: num(p.level_mm, D.levelMm),
    levelMode: p.level_mode === 'absolute' ? 'absolute' : 'storey',
    transition: p.transition === 'slope' ? 'slope' : 'vertical',
    // 0° would be a horizontal batter — infinite reach; 89° is all but vertical.
    slopeDeg: Math.max(1, Math.min(89, num(p.slope_deg, D.slopeDeg))),
    mode,
    closed: p.closed === undefined ? D.closed : truthy(p.closed),
  };
}

/** The pad's outline in BIM mm, and where it came from. */
export function padOutline(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): { outline: Pt2[]; source: 'sketch' | 'axes' | 'none' } {
  for (const e of edges) {
    const other = e.from === node.id ? e.to : e.to === node.id ? e.from : null;
    if (!other) continue;
    const n = nodeMap.get(other);
    if (n && n.type === 'sketch') return { outline: sketchOutline(n, nodeMap, edges), source: 'sketch' };
  }
  const anchors = getOrderedAnchorNodes(node.id, edges, nodeMap);
  if (anchors.length >= 3) return { outline: anchors.map((a) => planPos(a, nodeMap)), source: 'axes' };
  return { outline: [], source: 'none' };
}

export interface PadDiagnostic { code: string; severity: 'error' | 'warning' | 'info'; message: string }

/**
 * Every pad in the graph, as zones the height grid can apply.
 *
 * Nothing here mutates: the caller decides where in the chain the zones land.
 */
export function collectPadZones(
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  frame: SiteFrame,
  grid: GridSpec,
): { zones: ExcavationZone[]; pads: PadInfo[]; diagnostics: PadDiagnostic[] } {
  const zones: ExcavationZone[] = [];
  const pads: PadInfo[] = [];
  const diagnostics: PadDiagnostic[] = [];

  for (const n of nodeMap.values()) {
    if (n.type !== 'terrain_pad') continue;
    const intent = parsePadIntent(n);
    const { outline, source } = padOutline(n, nodeMap, edges);
    if (source === 'none' || outline.length < 3) {
      diagnostics.push({
        code: 'PAD_NO_OUTLINE',
        severity: 'error',
        message: `„${n.name}" nu are contur — leagă-l de o schiță închisă (ex. unealta Dreptunghi) sau de 3+ axe.`,
      });
      continue;
    }
    const band = getStoreyBand(n, nodeMap);
    const levelMm = intent.levelMode === 'storey' ? band.bot + intent.levelMm : intent.levelMm;

    const polygon = outline.map((p): [number, number] => {
      const t = bimToTerrain(frame, p.x, p.y);
      return [t.x, t.z];
    });
    if (!polygon.some(([x, z]) => insideGrid(grid, x, z))) {
      diagnostics.push({
        code: 'PAD_OFF_GRID',
        severity: 'warning',
        message: `„${n.name}" cade în afara grilei de teren — mărește terenul sau mută platforma.`,
      });
      continue;
    }

    zones.push({
      id: `pad:${n.id}`,
      polygon,
      depth: 0,
      slope: intent.transition === 'slope' ? intent.slopeDeg : 0,
      type: 'pit',
      floorM: bimZToTerrain(frame, levelMm),
      mode: intent.mode,
    });
    pads.push({
      nodeId: n.id, outline, levelMm,
      transition: intent.transition, slopeDeg: intent.slopeDeg, mode: intent.mode, source,
    });
  }
  return { zones, pads, diagnostics };
}

/** The batter as builders state it: 1 : n horizontal per vertical. */
export function slopeRatio(slopeDeg: number): number {
  return 1 / Math.tan((Math.max(1, Math.min(89, slopeDeg)) * Math.PI) / 180);
}
