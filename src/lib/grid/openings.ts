/**
 * openings.ts — doors and windows as Grid-mode citizens.
 *
 * A wall carries its openings two ways: as connected `window`/`door` NODES, or
 * inline in `properties.windows` / `properties.doors` (JSON arrays gated by
 * `has_windows` / `has_doors`). `collectOpenings` already merges and expands
 * both for the 3D and plan views; this module adds the two things the canvas
 * needs on top of it — a REF that says where a given symbol came from, so a
 * click can write back to the same place the properties panel edits, and the
 * placement maths that turns "1200 mm from the wall start" into pixels on the
 * segment Grid mode actually drew.
 *
 * Every write here mirrors a control that already exists in the inspector:
 * `flip_across`, `flip_along`, `swing`, `wall_offset` / `offset`, and the
 * `has_windows` / `has_doors` switches themselves.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { collectOpenings } from '@/lib/bimGeometry';
import type { Pt } from './axisEdit';

export type OpeningList = 'windows' | 'doors';
export type OpeningKind = 'window' | 'door';

/** Where an on-canvas symbol lives, so a toggle writes to the right place. */
export type OpeningRef =
  | { kind: 'inline'; wallId: string; list: OpeningList; index: number }
  | { kind: 'node'; nodeId: string };

export interface GridOpening {
  ref: OpeningRef;
  wallId: string;
  type: OpeningKind;
  name: string;
  /** Left edge measured from the wall's first anchor, and the clear width (BIM mm). */
  distFromStart: number;
  widthMm: number;
  flipAcross: boolean;
  flipAlong: boolean;
  swing: 'left' | 'right';
}

/** One wall as Grid mode draws it: the segment, its length, and what is cut into it. */
export interface GridWall {
  wall: BubbleGraphNode;
  /** Segment ends in WORLD px, in the same order `calcWallGeometry` uses. */
  a: Pt;
  b: Pt;
  lenMm: number;
  openings: GridOpening[];
}

export const truthy = (v: unknown): boolean =>
  v === true || v === 'true' || v === 'True' || v === 1 || v === '1';

const hasKey = (list: OpeningList) => (list === 'windows' ? 'has_windows' : 'has_doors');
const kindOf = (list: OpeningList): OpeningKind => (list === 'windows' ? 'window' : 'door');
const idPrefix = (list: OpeningList) => (list === 'windows' ? 'inl_win' : 'inl_door');

/** The inline array on a wall, always a fresh list (never the stored reference). */
export function parseOpeningList(wall: BubbleGraphNode, list: OpeningList): Array<Record<string, unknown>> {
  try {
    const raw = String(wall.properties[list] ?? '[]').trim();
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>).map((o) => ({ ...o })) : [];
  } catch {
    return [];
  }
}

/** The id `collectOpenings` will synthesise for inline entry `index`. */
const inlineId = (wall: BubbleGraphNode, list: OpeningList, entry: Record<string, unknown>, index: number) =>
  String(entry.id ?? `${idPrefix(list)}_${wall.id}_${index}`);

/**
 * Every opening on a wall, in draw order, each tagged with the ref that writes
 * it back. `wallLenMm` must be the length of the segment the caller drew, so a
 * centred opening lands where the eye expects it.
 */
export function wallOpenings(
  wall: BubbleGraphNode,
  wallLenMm: number,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): GridOpening[] {
  const known = new Map<string, { ref: OpeningRef; type: OpeningKind }>();
  for (const list of ['windows', 'doors'] as const) {
    if (!truthy(wall.properties[hasKey(list)])) continue;
    parseOpeningList(wall, list).forEach((entry, index) => {
      known.set(inlineId(wall, list, entry, index), {
        ref: { kind: 'inline', wallId: wall.id, list, index },
        type: kindOf(list),
      });
    });
  }

  return collectOpenings(wall, wallLenMm, edges, nodeMap).map((op) => {
    const hit = known.get(op.node.id);
    const p = op.node.properties;
    return {
      ref: hit?.ref ?? { kind: 'node', nodeId: op.node.id },
      wallId: wall.id,
      type: hit?.type ?? (op.node.type === 'door' ? 'door' : 'window'),
      name: op.node.name,
      distFromStart: op.distFromStart,
      widthMm: op.width,
      flipAcross: truthy(p.flip_across),
      flipAlong: truthy(p.flip_along),
      swing: String(p.swing ?? 'left') === 'right' ? 'right' : 'left',
    };
  });
}

// ─── Writes (each one mirrors an inspector control) ──────────────────────────

/** Which property carries the along-wall position for this kind of opening. */
export const offsetKeyFor = (ref: OpeningRef) => (ref.kind === 'inline' ? 'wall_offset' : 'offset');

export function patchOpening(
  nodes: BubbleGraphNode[],
  ref: OpeningRef,
  patch: Record<string, unknown>,
): BubbleGraphNode[] {
  if (ref.kind === 'node') {
    return nodes.map((n) => (n.id === ref.nodeId ? { ...n, properties: { ...n.properties, ...patch } } : n));
  }
  return nodes.map((n) => {
    if (n.id !== ref.wallId) return n;
    const list = parseOpeningList(n, ref.list);
    if (!list[ref.index]) return n;
    list[ref.index] = { ...list[ref.index], ...patch };
    return { ...n, properties: { ...n.properties, [ref.list]: JSON.stringify(list) } };
  });
}

export function removeOpening(nodes: BubbleGraphNode[], ref: OpeningRef): BubbleGraphNode[] {
  if (ref.kind === 'node') return nodes.filter((n) => n.id !== ref.nodeId);
  return nodes.map((n) => {
    if (n.id !== ref.wallId) return n;
    const list = parseOpeningList(n, ref.list).filter((_, i) => i !== ref.index);
    return {
      ...n,
      properties: { ...n.properties, [ref.list]: JSON.stringify(list), [hasKey(ref.list)]: list.length ? 'True' : 'False' },
    };
  });
}

/** The inspector's "+ Add Window" / "+ Add Door" defaults, kept in one place. */
export function defaultOpening(list: OpeningList, id: string): Record<string, unknown> {
  return list === 'windows'
    ? { id, window_type: 'W-FIX-100x120', width: 1000, height: 1200, sill_height: 900, wall_offset: null, count: 1 }
    : { id, door_type: 'D-SWING-90x210', width: 900, height: 2100, sill_height: 0, wall_offset: null, swing: 'left', count: 1 };
}

/** A stable, collision-free id for a new inline entry on this wall. */
function nextInlineId(existing: Array<Record<string, unknown>>, wallId: string, list: OpeningList): string {
  const taken = new Set(existing.map((o) => String(o.id ?? '')));
  for (let k = 1; ; k++) {
    const id = `${idPrefix(list)}_${wallId}_n${k}`;
    if (!taken.has(id)) return id;
  }
}

/** Append an inline opening, switching `has_windows` / `has_doors` on with it. */
export function addOpening(nodes: BubbleGraphNode[], wallId: string, list: OpeningList): BubbleGraphNode[] {
  return nodes.map((n) => {
    if (n.id !== wallId) return n;
    const cur = parseOpeningList(n, list);
    const next = [...cur, defaultOpening(list, nextInlineId(cur, wallId, list))];
    return { ...n, properties: { ...n.properties, [list]: JSON.stringify(next), [hasKey(list)]: 'True' } };
  });
}

/**
 * The inspector's Has Windows / Has Doors switch. Turning it on with an empty
 * list seeds one opening, so the toggle always has something to show.
 */
export function setHasOpenings(
  nodes: BubbleGraphNode[],
  wallId: string,
  list: OpeningList,
  on: boolean,
): BubbleGraphNode[] {
  const wall = nodes.find((n) => n.id === wallId);
  if (!wall) return nodes;
  if (on && parseOpeningList(wall, list).length === 0) return addOpening(nodes, wallId, list);
  return nodes.map((n) =>
    n.id === wallId ? { ...n, properties: { ...n.properties, [hasKey(list)]: on ? 'True' : 'False' } } : n);
}

// ─── Placement on the drawn segment ──────────────────────────────────────────

export type ChipId = 'across' | 'along' | 'swing' | 'remove';

export interface OpeningChip {
  id: ChipId;
  at: Pt;
  glyph: string;
  title: string;
}

export interface OpeningPlacement {
  op: GridOpening;
  /** Footprint of the opening on the wall (world px). */
  p0: Pt;
  p1: Pt;
  centre: Pt;
  /** Unit vector along the wall and its left normal (world px). */
  u: Pt;
  nrm: Pt;
  /** Which face the symbol opens onto: +1 along the left normal, −1 the other. */
  side: 1 | -1;
  /**
   * Door leaf hinged at the `p0` end. `swing` picks the hinge, `flip_along`
   * mirrors it — so the three opening properties stay visually distinct:
   * `flip_across` swaps the face, the other two swap the hinge end.
   */
  hingeAtStart: boolean;
  chips: OpeningChip[];
}

const CHIP_STEP_PX = 17;
const CHIP_OFFSET_PX = 20;

/**
 * Where one opening sits on the segment Grid mode drew for its wall, plus the
 * anchors for its on-canvas controls. Returns null for a degenerate wall.
 */
export function placeOpening(w: GridWall, op: GridOpening, zoom: number): OpeningPlacement | null {
  const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y;
  const segLen = Math.hypot(dx, dy);
  if (segLen < 1e-6 || w.lenMm < 1e-6) return null;
  const px = (v: number) => v / Math.max(zoom, 1e-6);
  const u = { x: dx / segLen, y: dy / segLen };
  const nrm = { x: -u.y, y: u.x };
  const scale = segLen / w.lenMm; // world px per mm along this wall

  const t0 = Math.max(0, Math.min(w.lenMm, op.distFromStart)) * scale;
  const t1 = Math.max(0, Math.min(w.lenMm, op.distFromStart + op.widthMm)) * scale;
  const at = (t: number): Pt => ({ x: w.a.x + u.x * t, y: w.a.y + u.y * t });
  const p0 = at(t0), p1 = at(t1);
  const centre = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const side: 1 | -1 = op.flipAcross ? -1 : 1;

  // Controls sit on the face away from the symbol, so they never cover it.
  const chipDefs: Array<{ id: ChipId; glyph: string; title: string }> = [
    { id: 'across', glyph: '⇕', title: 'Flip across — schimbă fața pe care se deschide (flip_across)' },
    { id: 'along', glyph: '⇔', title: 'Flip along — schimbă capătul balamalei (flip_along)' },
    { id: 'remove', glyph: '×', title: 'Șterge golul' },
  ];
  const base = px(CHIP_OFFSET_PX), step = px(CHIP_STEP_PX);
  const start = -((chipDefs.length - 1) / 2) * step;
  const chips: OpeningChip[] = chipDefs.map((c, i) => ({
    ...c,
    at: {
      x: centre.x - nrm.x * side * base + u.x * (start + i * step),
      y: centre.y - nrm.y * side * base + u.y * (start + i * step),
    },
  }));

  return { op, p0, p1, centre, u, nrm, side, hingeAtStart: (op.swing === 'left') !== op.flipAlong, chips };
}

export interface OpeningHit {
  wall: GridWall;
  placement: OpeningPlacement;
  chip: OpeningChip | null;
}

/** Chips win over the symbol body, and both are tested in screen-constant radii. */
export function openingHitTest(
  placements: Array<{ wall: GridWall; placement: OpeningPlacement }>,
  cx: number,
  cy: number,
  zoom: number,
  opts: { chipPx?: number; bodyPx?: number } = {},
): OpeningHit | null {
  const z = Math.max(zoom, 1e-6);
  const chipR = (opts.chipPx ?? 9) / z;
  const bodyR = (opts.bodyPx ?? 7) / z;
  for (const { wall, placement } of placements) {
    for (const chip of placement.chips) {
      if (Math.hypot(cx - chip.at.x, cy - chip.at.y) <= chipR) return { wall, placement, chip };
    }
  }
  for (const { wall, placement } of placements) {
    if (distToSegment({ x: cx, y: cy }, placement.p0, placement.p1) <= bodyR) return { wall, placement, chip: null };
  }
  return null;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ─── Wall-level controls (the Has Windows / Has Doors switches) ──────────────

export interface WallChip {
  wallId: string;
  list: OpeningList;
  at: Pt;
  glyph: string;
  /** The wall already has this kind of opening — the chip removes rather than adds. */
  on: boolean;
  title: string;
}

/**
 * The pair of chips shown on a selected wall: one per opening kind, mirroring
 * the inspector's Has Windows / Has Doors switch. They sit above the midpoint
 * so they never land on the opening symbols themselves.
 */
export function wallChips(w: GridWall, zoom: number): WallChip[] {
  const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [];
  const px = (v: number) => v / Math.max(zoom, 1e-6);
  const u = { x: dx / len, y: dy / len };
  const nrm = { x: -u.y, y: u.x };
  const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
  const base = px(30), step = px(CHIP_STEP_PX);
  return (['windows', 'doors'] as const).map((list, i) => ({
    wallId: w.wall.id,
    list,
    at: {
      x: mid.x + nrm.x * base + u.x * (i - 0.5) * step,
      y: mid.y + nrm.y * base + u.y * (i - 0.5) * step,
    },
    glyph: list === 'windows' ? '▭' : '◗',
    on: truthy(w.wall.properties[hasKey(list)]),
    title: list === 'windows'
      ? 'Adaugă fereastră (has_windows)'
      : 'Adaugă ușă (has_doors)',
  }));
}

export function wallChipHitTest(chips: WallChip[], cx: number, cy: number, zoom: number, chipPx = 9): WallChip | null {
  const r = chipPx / Math.max(zoom, 1e-6);
  return chips.find((c) => Math.hypot(cx - c.at.x, cy - c.at.y) <= r) ?? null;
}

export const sameOpeningRef = (a: OpeningRef | null, b: OpeningRef | null): boolean => {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === 'node' && b.kind === 'node'
    ? a.nodeId === b.nodeId
    : a.kind === 'inline' && b.kind === 'inline' && a.wallId === b.wallId && a.list === b.list && a.index === b.index;
};

/**
 * The along-wall offset a drag to `centreMm` should store: `collectOpenings`
 * measures a single opening from its LEFT EDGE, clamped inside the wall.
 */
export function offsetForCentre(widthMm: number, centreMm: number, wallLenMm: number, snapMm = 10): number {
  const max = Math.max(0, wallLenMm - widthMm);
  return Math.round(Math.max(0, Math.min(max, centreMm - widthMm / 2)) / snapMm) * snapMm;
}
