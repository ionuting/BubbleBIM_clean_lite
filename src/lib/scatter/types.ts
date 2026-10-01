/**
 * Scatter element — shared types.
 *
 * A `scatter` is a LEAF element that populates a region with many small
 * things: trees, shrubs, a hedge, rocks. It owns no geometry of its own — the
 * region comes from what it is wired to:
 *
 *   a `sketch`   → its outline: closed = an AREA to scatter over,
 *                                open   = a PATH to array along
 *   ax anchors   → a polyline in edge order, like the sweep's guide line
 *
 * Two readings, chosen by the outline's own closedness, so "scatter" and
 * "array along a path" are the same node with a different source — there is
 * no second element to learn.
 *
 * Everything is deterministic from `seed`: the same graph draws the same
 * forest, and a re-open does not reshuffle the garden. `seed` is the knob to
 * turn when the arrangement is wrong, not the count.
 *
 * Heights come from the site when there is one (`heightAt`), so a tree on a
 * slope stands on the slope; otherwise from the storey floor.
 */
import type { BubbleGraphNode } from '@/store';
import type { Pt2 } from '@/lib/geom/plan2d';

export type { Pt2 };

export type ScatterKind = 'tree' | 'shrub' | 'hedge' | 'rock' | 'boulder' | 'grass';
export const SCATTER_KINDS: ScatterKind[] = ['tree', 'shrub', 'hedge', 'rock', 'boulder', 'grass'];

export const SCATTER_KIND_LABELS: Record<ScatterKind, string> = {
  tree: 'Copac',
  shrub: 'Arbust',
  hedge: 'Gard viu',
  rock: 'Piatră',
  boulder: 'Bolovan',
  grass: 'Iarbă / tufe',
};

/** Sensible starting sizes per kind — a preset, not a constraint. */
export const SCATTER_KIND_DEFAULTS: Record<ScatterKind, { sizeMm: number; heightMm: number; spacingMm: number; minGapMm: number }> = {
  tree:    { sizeMm: 4000, heightMm: 6000, spacingMm: 4000, minGapMm: 2500 },
  shrub:   { sizeMm: 1200, heightMm: 1000, spacingMm: 1500, minGapMm: 800 },
  hedge:   { sizeMm: 800,  heightMm: 1200, spacingMm: 800,  minGapMm: 400 },
  rock:    { sizeMm: 800,  heightMm: 500,  spacingMm: 2000, minGapMm: 600 },
  boulder: { sizeMm: 1800, heightMm: 1200, spacingMm: 4000, minGapMm: 1500 },
  grass:   { sizeMm: 400,  heightMm: 300,  spacingMm: 600,  minGapMm: 200 },
};

export type ScatterMode = 'auto' | 'area' | 'path';

export interface ScatterIntent {
  kind: ScatterKind;
  /** auto = closed source scatters, open source arrays. */
  mode: ScatterMode;
  /** Exact number of instances; 0 = derive from spacing. */
  count: number;
  /** Path: step between stations. Area: nominal spacing → count = area / spacing². */
  spacingMm: number;
  seed: number;
  /** Plan size (canopy / rock diameter), mm. */
  sizeMm: number;
  /** Vertical extent, mm. */
  heightMm: number;
  /** 0..1 — random variation of size (and rock shape). */
  sizeJitter: number;
  /** Area only: no two instances closer than this. */
  minGapMm: number;
  /** Area only: keep this far inside the outline. */
  edgeMarginMm: number;
  /** Ax-anchored sources: close the polyline. */
  closed: boolean;
  material: string;
}

export const DEFAULT_SCATTER_INTENT: ScatterIntent = {
  kind: 'tree',
  mode: 'auto',
  count: 0,
  spacingMm: 4000,
  seed: 1,
  sizeMm: 4000,
  heightMm: 6000,
  sizeJitter: 0.3,
  minGapMm: 2500,
  edgeMarginMm: 0,
  closed: false,
  material: 'Vegetatie',
};

export interface ScatterInstance {
  /** BIM mm. */
  x: number;
  y: number;
  /** Ground elevation, BIM mm. */
  z: number;
  /** Plan diameter, mm, after jitter. */
  sizeMm: number;
  heightMm: number;
  /** Rotation in plan, degrees CCW. */
  rotDeg: number;
  kind: ScatterKind;
  /** 0..1 shape variation, for rocks and symbol wobble. */
  variant: number;
}

export type ScatterDiagSeverity = 'error' | 'warning' | 'info';
export interface ScatterDiagnostic { code: string; severity: ScatterDiagSeverity; message: string }

export type ScatterSource = 'sketch' | 'axes' | 'none';

export interface ScatterResult {
  intent: ScatterIntent;
  source: ScatterSource;
  /** The region in plan — the outline the instances were placed on/in. */
  region: Pt2[];
  closed: boolean;
  /** How the region was read: an area to fill, or a path to follow. */
  mode: 'area' | 'path' | 'none';
  instances: ScatterInstance[];
  count: number;
  /** Path length (path mode) or perimeter (area mode), mm. */
  lengthMm: number;
  /** Enclosed area (area mode), mm². */
  areaMm2: number;
  diagnostics: ScatterDiagnostic[];
}

const num = (v: unknown, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const truthy = (v: unknown): boolean => v === true || String(v ?? '').toLowerCase() === 'true';

export function parseScatterKind(v: unknown): ScatterKind {
  return (SCATTER_KINDS as string[]).includes(String(v)) ? (v as ScatterKind) : DEFAULT_SCATTER_INTENT.kind;
}

/** Read a scatter node's properties into an intent. Booleans arrive as 'True'/'False'. */
export function parseScatterIntent(node: BubbleGraphNode): ScatterIntent {
  const p = node.properties ?? {};
  const kind = parseScatterKind(p.kind);
  const kd = SCATTER_KIND_DEFAULTS[kind];
  const mode = p.mode === 'area' || p.mode === 'path' ? p.mode : 'auto';
  return {
    kind,
    mode,
    count: Math.max(0, Math.round(num(p.count, 0))),
    spacingMm: Math.max(10, num(p.spacing_mm, kd.spacingMm)),
    seed: Math.round(num(p.seed, DEFAULT_SCATTER_INTENT.seed)),
    sizeMm: Math.max(10, num(p.size_mm, kd.sizeMm)),
    heightMm: Math.max(10, num(p.height_mm, kd.heightMm)),
    sizeJitter: Math.max(0, Math.min(1, num(p.size_jitter, DEFAULT_SCATTER_INTENT.sizeJitter))),
    minGapMm: Math.max(0, num(p.min_gap_mm, kd.minGapMm)),
    edgeMarginMm: Math.max(0, num(p.edge_margin_mm, 0)),
    closed: truthy(p.closed),
    material: String(p.material ?? DEFAULT_SCATTER_INTENT.material),
  };
}
