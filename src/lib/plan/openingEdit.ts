/**
 * openingEdit.ts — moving a door or window along its wall, and turning it
 * round, from a plan.
 *
 * An opening's place on its wall is one number: `offset`, the start jamb's
 * distance from the wall's start, in millimetres. Which way it faces is two
 * flags: `swing` (which jamb the leaf hangs on) and `flip_across` (which
 * face it opens from). The plan lets a person drag the symbol and click two
 * small buttons; this turns those gestures into the three values and writes
 * them where they live — on the opening's own node, or, for an opening the
 * wall carries inline in its `doors` / `windows` list, into that entry.
 *
 * Pure: takes the graph's nodes, returns new ones. The plan commits them.
 */

import type { BubbleGraphNode } from '@/store';
import type { OpeningFrame } from './openingSymbols';
import type { Pt } from './wallSilhouette';

/** A drag lands on a multiple of this, unless the person asks for finer. */
export const OPENING_SNAP_MM = 10;

export function snapMm(v: number, step = OPENING_SNAP_MM): number {
  return step > 0 ? Math.round(v / step) * step : v;
}

/** The start jamb positions that keep the whole opening inside the wall. */
export function clampOpening(distMm: number, widthMm: number, wallLenMm: number): number {
  const max = Math.max(0, wallLenMm - widthMm);
  return Math.min(max, Math.max(0, distMm));
}

/**
 * Where a drag has taken the opening: the pointer's travel projected onto
 * the wall, added to where the opening started, snapped and kept inside.
 */
export function dragOpeningDistance(
  f: OpeningFrame,
  from: Pt,
  to: Pt,
  step = OPENING_SNAP_MM,
): number {
  const travel = (to.x - from.x) * f.along.x + (to.y - from.y) * f.along.y;
  return clampOpening(snapMm(f.distFromStartMm + travel, step), f.widthMm, f.wallLenMm);
}

/** The two jamb-to-wall-end distances a plan labels while it is dragged. */
export function openingClearances(f: OpeningFrame, distMm = f.distFromStartMm): { start: number; end: number } {
  return { start: distMm, end: Math.max(0, f.wallLenMm - distMm - f.widthMm) };
}

// ─── Writing ──────────────────────────────────────────────────────────────────

/** Inline entries name the same things a little differently. */
const INLINE_KEY: Record<string, string> = { offset: 'wall_offset' };

/**
 * The graph with one opening's values changed. A node of the graph takes the
 * patch on its properties; an inline entry takes it in the wall's list,
 * re-serialised. Anything else is returned untouched, the same array.
 */
export function patchOpening(
  nodes: BubbleGraphNode[],
  f: OpeningFrame,
  patch: Record<string, unknown>,
): BubbleGraphNode[] {
  if (!f.inline) {
    const i = nodes.findIndex((n) => n.id === f.node.id);
    if (i < 0) return nodes;
    const out = nodes.slice();
    out[i] = { ...nodes[i], properties: { ...nodes[i].properties, ...patch } };
    return out;
  }
  const wi = nodes.findIndex((n) => n.id === f.wallId);
  if (wi < 0) return nodes;
  const wall = nodes[wi];
  let list: Record<string, unknown>[];
  try {
    const parsed = JSON.parse(String(wall.properties[f.inline.key] ?? '[]').trim() || '[]') as unknown;
    if (!Array.isArray(parsed)) return nodes;
    list = parsed as Record<string, unknown>[];
  } catch {
    return nodes;
  }
  const entry = list[f.inline.index];
  if (!entry || typeof entry !== 'object') return nodes;
  const renamed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) renamed[INLINE_KEY[k] ?? k] = v;
  list = list.slice();
  list[f.inline.index] = { ...entry, ...renamed };
  const out = nodes.slice();
  out[wi] = { ...wall, properties: { ...wall.properties, [f.inline.key]: JSON.stringify(list) } };
  return out;
}

/** The opening moved so its start jamb is `distMm` from the wall's start. */
export function moveOpening(nodes: BubbleGraphNode[], f: OpeningFrame, distMm: number): BubbleGraphNode[] {
  const dist = Math.round(clampOpening(distMm, f.widthMm, f.wallLenMm));
  if (dist === Math.round(f.distFromStartMm)) return nodes;
  return patchOpening(nodes, f, { offset: dist });
}

/** The jamb a door hangs on, the other way round. Only a single leaf has one. */
export function flipHinge(nodes: BubbleGraphNode[], f: OpeningFrame): BubbleGraphNode[] {
  if (f.kind !== 'door') return nodes;
  const swing = String(f.node.properties.swing ?? 'left');
  if (swing === 'left') return patchOpening(nodes, f, { swing: 'right' });
  if (swing === 'right') return patchOpening(nodes, f, { swing: 'left' });
  return nodes;
}

/** The face the opening is drawn from, the other way round. */
export function flipSide(nodes: BubbleGraphNode[], f: OpeningFrame): BubbleGraphNode[] {
  const on = String(f.node.properties.flip_across ?? '').toLowerCase() === 'true';
  return patchOpening(nodes, f, { flip_across: !on });
}

/** Whether the hinge button means anything for this opening. */
export function canFlipHinge(f: OpeningFrame): boolean {
  if (f.kind !== 'door') return false;
  const swing = String(f.node.properties.swing ?? 'left');
  return swing === 'left' || swing === 'right';
}
