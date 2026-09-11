/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * profiles.ts — what a structural system MEANS for the model: a technology
 * profile per system, and the one function that adapts a graph to it.
 *
 * WHY
 * ---
 * `structuralSystem.ts` makes the system a controlled value and the norms
 * library reads it as a mapping dimension. That is enough to decompose the
 * SAME wall into different work items, but a technology is more than a
 * decomposition: a timber house has timber walls, no concrete columns and a
 * joist floor; a frame house has columns at every junction, beams over every
 * wall and infill between them. Until now switching the project system left
 * 25 cm brick walls with studs painted inside them and concrete columns
 * costed at every corner of a "timber" house.
 *
 * WHAT
 * ----
 * A profile is DATA: default element types, which types are native, what the
 * frame provisioning is, what the inspector should show. `adaptGraphToSystem`
 * turns a graph into that technology — retyping foreign walls and floors,
 * adding or dropping columns and beams — and returns a new node array in
 * which every untouched node is the SAME object, so the scenario memo and
 * the undo stack both see one small change.
 *
 * Pure: no store, no React.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { getNodeBimPos } from '@/lib/bimGeometry';
import { WALL_TYPES, WALL_TYPE_MAP, SLAB_TYPES, type WallType, type SlabType } from '@/lib/elementLibrary';
import { classifyWallSides, ringAxIdsByStorey } from '@/lib/walls/wallSides';
import type { StructuralSystem } from './structuralSystem';

export type WallBuildup = 'masonry' | 'infill' | 'concrete' | 'framing' | 'clt' | 'none';
/** `junctions`: a column wherever walls meet or the ring turns. `none`: strip them. `keep`: leave as drawn. */
export type ColumnProvisioning = 'junctions' | 'none' | 'keep';
/** `all`: a beam over every anchored wall. `ring`: exterior walls only. `none`: strip. `keep`: leave. */
export type BeamProvisioning = 'all' | 'ring' | 'none' | 'keep';

export interface SystemProfile {
  system: StructuralSystem;
  buildup: WallBuildup;
  defaults: {
    exteriorWall: string;
    interiorWall: string;
    slab: string;
    /** Column type; `columnFor` may size it by storey count. */
    column: string;
    beam: string;
  };
  /** Wall type ids native to this technology; `UNIVERSAL_WALL_TYPES` are welcome everywhere. */
  wallTypes: readonly string[];
  slabTypes: readonly string[];
  frame: { columns: ColumnProvisioning; beams: BeamProvisioning };
  /** Node types the palette and the quest hints put first. */
  focus: readonly string[];
  /** Which inspector sections make sense for a wall in this system. */
  inspector: { framing: boolean; clt: boolean; frame: boolean };
}

/** Non-structural partitions that exist in every technology. */
export const UNIVERSAL_WALL_TYPES: readonly string[] = ['W10', 'W12'];

const MASONRY_WALLS = ['W15', 'W20', 'W25', 'W30', 'W35', 'W40'] as const;
const INFILL_WALLS = ['W15', 'W20', 'W25'] as const;
const CONCRETE_WALLS = ['W20', 'W25', 'W30', 'W35', 'W40'] as const;
const TIMBER_WALLS = ['TF14', 'TF20', 'TF25'] as const;
const CLT_WALLS = ['CLT100', 'CLT120', 'CLT140'] as const;
const CONCRETE_SLABS = ['SLAB10', 'SLAB12', 'SLAB15', 'SLAB18', 'SLAB20', 'SLAB25', 'SLAB30'] as const;
const TIMBER_SLABS = ['TJ20', 'TJ24'] as const;
const CLT_SLABS = ['CLT160', 'CLT200'] as const;

const masonryLike = (system: StructuralSystem, buildup: WallBuildup, wallTypes: readonly string[], column: string, beam: string): SystemProfile => ({
  system, buildup,
  defaults: { exteriorWall: 'W25', interiorWall: 'W15', slab: 'SLAB15', column, beam },
  wallTypes, slabTypes: CONCRETE_SLABS,
  frame: { columns: 'junctions', beams: 'all' },
  focus: ['wall', 'ax', 'slab', 'foundation'],
  inspector: { framing: false, clt: false, frame: true },
});

export const SYSTEM_PROFILES: Record<StructuralSystem, SystemProfile> = {
  confined_masonry: masonryLike('confined_masonry', 'masonry', MASONRY_WALLS, 'C25x25', 'B20x30'),
  rc_frame: masonryLike('rc_frame', 'infill', INFILL_WALLS, 'C25x25', 'B25x40'),
  rc_shear_wall: {
    system: 'rc_shear_wall', buildup: 'concrete',
    defaults: { exteriorWall: 'W30', interiorWall: 'W20', slab: 'SLAB15', column: 'C25x25', beam: 'B20x30' },
    wallTypes: CONCRETE_WALLS, slabTypes: CONCRETE_SLABS,
    frame: { columns: 'keep', beams: 'keep' },
    focus: ['wall', 'slab', 'foundation'],
    inspector: { framing: false, clt: false, frame: true },
  },
  timber_frame: {
    system: 'timber_frame', buildup: 'framing',
    defaults: { exteriorWall: 'TF20', interiorWall: 'TF14', slab: 'TJ20', column: 'C25x25', beam: 'B20x30' },
    wallTypes: TIMBER_WALLS, slabTypes: TIMBER_SLABS,
    frame: { columns: 'none', beams: 'none' },
    focus: ['wall', 'slab', 'roof', 'window', 'door'],
    inspector: { framing: true, clt: false, frame: false },
  },
  clt: {
    system: 'clt', buildup: 'clt',
    defaults: { exteriorWall: 'CLT120', interiorWall: 'CLT100', slab: 'CLT160', column: 'C25x25', beam: 'B20x30' },
    wallTypes: CLT_WALLS, slabTypes: CLT_SLABS,
    frame: { columns: 'none', beams: 'none' },
    focus: ['wall', 'slab', 'roof', 'window', 'door'],
    inspector: { framing: false, clt: true, frame: false },
  },
  steel_frame: {
    system: 'steel_frame', buildup: 'none',
    defaults: { exteriorWall: 'W25', interiorWall: 'W15', slab: 'SLAB15', column: 'C25x25', beam: 'B20x30' },
    wallTypes: [...INFILL_WALLS, ...TIMBER_WALLS], slabTypes: CONCRETE_SLABS,
    frame: { columns: 'keep', beams: 'keep' },
    focus: ['column', 'beam', 'wall'],
    inspector: { framing: false, clt: false, frame: true },
  },
  precast: {
    system: 'precast', buildup: 'none',
    defaults: { exteriorWall: 'W25', interiorWall: 'W15', slab: 'SLAB15', column: 'C25x25', beam: 'B20x30' },
    wallTypes: [...CONCRETE_WALLS, ...INFILL_WALLS], slabTypes: CONCRETE_SLABS,
    frame: { columns: 'keep', beams: 'keep' },
    focus: ['wall', 'slab', 'column', 'beam'],
    inspector: { framing: false, clt: false, frame: true },
  },
  unset: {
    system: 'unset', buildup: 'none',
    defaults: { exteriorWall: 'W25', interiorWall: 'W15', slab: 'SLAB15', column: 'C25x25', beam: 'B20x30' },
    wallTypes: WALL_TYPES.map((t) => t.id), slabTypes: SLAB_TYPES.map((t) => t.id),
    frame: { columns: 'keep', beams: 'keep' },
    focus: [],
    inspector: { framing: true, clt: true, frame: true },
  },
};

export const profileFor = (system: StructuralSystem | undefined): SystemProfile =>
  SYSTEM_PROFILES[system ?? 'unset'];

export function isNativeWallType(system: StructuralSystem, wallType: string): boolean {
  return UNIVERSAL_WALL_TYPES.includes(wallType) || profileFor(system).wallTypes.includes(wallType);
}

export function isNativeSlabType(system: StructuralSystem, slabType: string): boolean {
  return profileFor(system).slabTypes.includes(slabType);
}

/** Wall types split for a picker: the system's own first, then everything else. */
export function wallTypeGroups(system: StructuralSystem): { native: WallType[]; other: WallType[] } {
  const native = WALL_TYPES.filter((t) => isNativeWallType(system, t.id));
  const other = WALL_TYPES.filter((t) => !isNativeWallType(system, t.id));
  return { native, other };
}

export function slabTypeGroups(system: StructuralSystem): { native: SlabType[]; other: SlabType[] } {
  const native = SLAB_TYPES.filter((t) => isNativeSlabType(system, t.id));
  const other = SLAB_TYPES.filter((t) => !isNativeSlabType(system, t.id));
  return { native, other };
}

/**
 * Column for a frame, sized by how much stands on it. A two-storey house is
 * fine on 25×25; from three storeys the ground-floor column grows. Not a
 * design check — the usual starting point.
 */
export function columnFor(profile: SystemProfile, storeyCount: number): string {
  if (profile.system === 'rc_frame' && storeyCount >= 3) return 'C30x30';
  return profile.defaults.column;
}

// ─── Adapting a graph ─────────────────────────────────────────────────────────

export interface AdaptSummary {
  wallsRetyped: number;
  slabsRetyped: number;
  columnsAdded: number;
  columnsRemoved: number;
  beamsAdded: number;
  beamsRemoved: number;
}

export const summaryChanged = (s: AdaptSummary): boolean =>
  s.wallsRetyped + s.slabsRetyped + s.columnsAdded + s.columnsRemoved + s.beamsAdded + s.beamsRemoved > 0;

export interface AdaptOptions {
  /** Retype walls and floors of a foreign technology (default true). */
  retype?: boolean;
  /** Provision or strip columns and beams per the profile (default true). */
  frame?: boolean;
}

const isTrue = (v: unknown) => String(v ?? '').toLowerCase() === 'true';
const isAnchor = (n: BubbleGraphNode) => n.type === 'ax' || n.type === 'column';

/** Per ax: the walls that end on it, on its own storey. */
function wallsByAnchor(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[], nodeMap: Map<string, BubbleGraphNode>): Map<string, BubbleGraphNode[]> {
  const out = new Map<string, BubbleGraphNode[]>();
  for (const e of edges) {
    const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
    if (!a || !b) continue;
    const [anchor, wall] = a.type === 'wall' && isAnchor(b) ? [b, a] : b.type === 'wall' && isAnchor(a) ? [a, b] : [null, null];
    if (!anchor || !wall) continue;
    if ((anchor.parentId ?? null) !== (wall.parentId ?? null)) continue;
    const list = out.get(anchor.id) ?? [];
    list.push(wall);
    out.set(anchor.id, list);
  }
  void nodes;
  return out;
}

/** Anchors (ax/column) of a wall, first two. */
function anchorsOf(wall: BubbleGraphNode, edges: BubbleGraphEdge[], nodeMap: Map<string, BubbleGraphNode>): BubbleGraphNode[] {
  const out: BubbleGraphNode[] = [];
  for (const e of edges) {
    const otherId = e.from === wall.id ? e.to : e.to === wall.id ? e.from : null;
    if (!otherId) continue;
    const o = nodeMap.get(otherId);
    if (o && isAnchor(o)) out.push(o);
  }
  return out;
}

/**
 * Does a frame want a column here? Yes on the exterior ring, yes where three
 * or more walls meet, yes where two walls meet at an angle. Not at the end of
 * a straight run and not at a free wall end.
 */
export function anchorNeedsColumn(
  ax: BubbleGraphNode,
  walls: BubbleGraphNode[],
  onRing: boolean,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): boolean {
  if (onRing) return true;
  if (walls.length >= 3) return true;
  if (walls.length < 2) return false;
  const p = getNodeBimPos(ax, nodeMap);
  const dirs = walls.map((w) => {
    const far = anchorsOf(w, edges, nodeMap).find((a) => a.id !== ax.id);
    if (!far) return null;
    const q = getNodeBimPos(far, nodeMap);
    const l = Math.hypot(q.x - p.x, q.y - p.y);
    return l < 1 ? null : { x: (q.x - p.x) / l, y: (q.y - p.y) / l };
  }).filter((d): d is { x: number; y: number } => !!d);
  if (dirs.length < 2) return false;
  return Math.abs(dirs[0].x * dirs[1].y - dirs[0].y * dirs[1].x) >= 0.05;
}

/**
 * The graph as the technology of `system` would build it.
 *
 * Walls of a foreign type take the system's exterior/interior default by
 * their side on the storey ring (thickness decides when there is no ring);
 * floors likewise. Then the frame: columns provisioned at junctions or
 * stripped, beams over walls or stripped. Existing choices native to the
 * system are never touched, so adapting twice is a no-op and the user's own
 * column sizes survive.
 */
export function adaptGraphToSystem(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  system: StructuralSystem,
  opts: AdaptOptions = {},
): { nodes: BubbleGraphNode[]; summary: AdaptSummary } {
  const summary: AdaptSummary = { wallsRetyped: 0, slabsRetyped: 0, columnsAdded: 0, columnsRemoved: 0, beamsAdded: 0, beamsRemoved: 0 };
  const profile = profileFor(system);
  if (system === 'unset' || profile.buildup === 'none' && profile.frame.columns === 'keep' && profile.frame.beams === 'keep') {
    return { nodes, summary };
  }
  const retype = opts.retype ?? true;
  const frame = opts.frame ?? true;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const sides = classifyWallSides(nodes, edges);
  const rings = ringAxIdsByStorey(nodes, edges);
  const ringSet = new Set([...rings.values()].flat());
  const byAnchor = wallsByAnchor(nodes, edges, nodeMap);
  const storeyCount = Math.max(1, nodes.filter((n) => n.type === 'storey' && n.properties?.role !== 'last').length);
  const columnType = columnFor(profile, storeyCount);
  const doColumns = frame && profile.frame.columns !== 'keep';
  const doBeams = frame && profile.frame.beams !== 'keep';

  let changed = false;
  const out = nodes.map((n) => {
    let next: Record<string, unknown> | null = null;
    const set = (patch: Record<string, unknown>) => { next = { ...(next ?? n.properties ?? {}), ...patch }; };

    if (n.type === 'wall') {
      const wallType = String(n.properties?.wall_type ?? 'W20');
      const universal = UNIVERSAL_WALL_TYPES.includes(wallType);
      if (retype && !isNativeWallType(system, wallType)) {
        const side = sides.get(n.id);
        const thick = WALL_TYPE_MAP.get(wallType)?.thickness_mm ?? 200;
        const exterior = side ? side === 'exterior' : thick >= 200;
        set({ wall_type: exterior ? profile.defaults.exteriorWall : profile.defaults.interiorWall });
        summary.wallsRetyped++;
      }
      if (doBeams) {
        const hasBeam = isTrue(n.properties?.has_beam);
        const anchored = anchorsOf(n, edges, nodeMap).length >= 2;
        const wants = profile.frame.beams === 'all' ? anchored && !universal
          : profile.frame.beams === 'ring' ? sides.get(n.id) === 'exterior'
          : false;
        if (wants && !hasBeam) {
          const section = n.properties?.beam_section ?? n.properties?.beam_type ?? profile.defaults.beam;
          set({ has_beam: 'True', beam_section: section, beam_type: section });
          summary.beamsAdded++;
        } else if (!wants && hasBeam && profile.frame.beams === 'none') {
          set({ has_beam: 'False' });
          summary.beamsRemoved++;
        }
      }
    } else if (n.type === 'slab') {
      const slabType = String(n.properties?.slab_type ?? 'SLAB15');
      if (retype && !isNativeSlabType(system, slabType)) {
        set({ slab_type: profile.defaults.slab });
        summary.slabsRetyped++;
      }
    } else if (n.type === 'ax' && doColumns) {
      const hasCol = isTrue(n.properties?.has_column);
      if (profile.frame.columns === 'none') {
        if (hasCol) { set({ has_column: 'False' }); summary.columnsRemoved++; }
      } else if (!hasCol) {
        const walls = byAnchor.get(n.id) ?? [];
        if (walls.length > 0 && anchorNeedsColumn(n, walls, ringSet.has(n.id), edges, nodeMap)) {
          set({ has_column: 'True', column_type: n.properties?.column_type ?? columnType });
          summary.columnsAdded++;
        }
      }
    }

    if (!next) return n;
    changed = true;
    return { ...n, properties: next };
  });

  return { nodes: changed ? out : nodes, summary };
}
