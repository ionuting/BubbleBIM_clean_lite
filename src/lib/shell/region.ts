/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * region.ts — the SHELL as a region with holes, and everything that follows
 * from it.
 *
 * THE IDEA
 * --------
 * A `shell` is a closed contour anchored to axis points. A `cell` is another
 * such contour that sits INSIDE it and counts as a hole. Together they are one
 * region with holes, and almost every envelope or grid quantity a building
 * needs is a reading of that single region:
 *
 *   plin (net solid)   = contour area − Σ cell areas
 *                        → the footing area of a cellular raft, the footprint
 *                          of a reinforced-concrete beam grid
 *   plin × height      → the concrete volume of that grid
 *   outer perimeter    × height → the façade: insulation, render, paint
 *   cell perimeters    × height → the interior faces of the same grid
 *   band               = perimeter × thickness → the ring read as a wall band
 *
 * So one topology answers "how much façade", "how much footing" and "how much
 * formwork" without the user drawing three different things. Because every
 * vertex is an axis point, moving an axis re-derives all of it.
 *
 * ROLES
 * -----
 * What the region MEANS is a property, not a different node type: an envelope,
 * a beam grid, a foundation raft, a slab region. The role decides which
 * reading becomes the generic `area_m2` / `volume_m3` the norms consume, so a
 * mapping rule can stay simple (`shell | foundation → volume`) while the
 * geometry stays one thing.
 *
 * Pure: no store, no React, no scene.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { calcShellPolygon, getConnectedNodes } from '@/lib/bimGeometry';

export type Pt = { x: number; y: number };

/** What a shell region is being used for. Free-form is refused: see `parseShellRole`. */
export type ShellRole = 'envelope' | 'beam_grid' | 'foundation' | 'slab_region';

export const SHELL_ROLES: readonly ShellRole[] = ['envelope', 'beam_grid', 'foundation', 'slab_region'];

export const SHELL_ROLE_LABELS: Record<ShellRole, string> = {
  envelope: 'Anvelopă',
  beam_grid: 'Rețea de grinzi',
  foundation: 'Fundație / radier celular',
  slab_region: 'Placă cu goluri',
};

export const SHELL_ROLE_HINTS: Record<ShellRole, string> = {
  envelope: 'Banda conturului e peretele exterior; termoizolația și finisajele se iau de aici',
  beam_grid: 'Plinul dintre celule e rețeaua de grinzi din beton armat',
  foundation: 'Plinul e talpa; volumul = aria plinului × înălțime',
  slab_region: 'Placă plină cu goluri decupate de celule',
};

export const DEFAULT_SHELL_ROLE: ShellRole = 'envelope';

export function parseShellRole(v: unknown): ShellRole | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return (SHELL_ROLES as readonly string[]).includes(s) ? (s as ShellRole) : undefined;
}

export const shellRole = (node: BubbleGraphNode | undefined): ShellRole =>
  parseShellRole(node?.properties?.shell_role) ?? DEFAULT_SHELL_ROLE;

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Signed area × 2 (shoelace). Positive = counter-clockwise. */
function area2(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return a;
}

const polygonAreaM2 = (poly: Pt[]) => (poly.length < 3 ? 0 : Math.abs(area2(poly)) / 2e6);

function polygonPerimeterM(poly: Pt[]): number {
  if (poly.length < 2) return 0;
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    p += Math.hypot(poly[j].x - poly[i].x, poly[j].y - poly[i].y);
  }
  return p / 1000;
}

const centroid = (poly: Pt[]): Pt => ({
  x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
  y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
});

/** Ray casting. Points exactly on an edge are treated as inside. */
export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y)
      && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── The region ───────────────────────────────────────────────────────────────

export interface ShellRegion {
  role: ShellRole;
  /** Contour in BIM mm, from the shell's axis anchors. */
  outer: Pt[];
  /** Cell contours that count as holes, same units. */
  holes: Pt[][];
  holeCount: number;

  heightM: number;
  thicknessM: number;

  /** Contour perimeter. */
  outerPerimeterM: number;
  /** Every hole's perimeter, summed. */
  holePerimeterM: number;
  /** Outer + holes — the total edge length of the solid. */
  perimeterM: number;

  /** Area inside the contour, holes ignored. */
  grossAreaM2: number;
  /** Every hole's area, summed. */
  holeAreaM2: number;
  /** PLINUL: gross − holes. Footing area of a cellular raft; footprint of a beam grid. */
  netSolidAreaM2: number;

  /** Perimeter × thickness — the contour read as a band (a wall ring). */
  bandAreaM2: number;
  /** Contour perimeter × height — the façade. */
  outerFaceAreaM2: number;
  /** Hole perimeters × height — the interior faces of a grid. */
  innerFaceAreaM2: number;

  /** What the role calls "the area" — façade for an envelope, plin for a grid. */
  areaM2: number;
  /** What the role calls "the volume". */
  volumeM3: number;
}

/**
 * Cells that belong to a shell: the ones wired to it by an edge, or — when
 * nothing is wired — the ones whose centroid falls inside its contour on the
 * same storey.
 *
 * Explicit wiring wins so a user can say "this cell is not a hole in that
 * shell" and be obeyed; containment is the convenience for the common case of
 * dropping cells inside a contour and expecting them to count.
 */
export function cellsOfShell(
  shell: BubbleGraphNode,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
  outer: Pt[],
): BubbleGraphNode[] {
  const wired = getConnectedNodes(shell.id, edges, nodeMap).filter((n) => n.type === 'cell');
  if (wired.length > 0) return wired;

  const out: BubbleGraphNode[] = [];
  for (const n of nodes) {
    if (n.type !== 'cell') continue;
    if ((n.parentId ?? null) !== (shell.parentId ?? null)) continue;
    const poly = calcShellPolygon(n, nodeMap, edges);
    if (!poly || poly.length < 3) continue;
    if (pointInPolygon(centroid(poly), outer)) out.push(n);
  }
  return out;
}

/**
 * The shell as a region, with every reading derived. `null` when the contour
 * cannot be built (fewer than three anchors).
 *
 * The contour deliberately uses the RAW anchor polygon, not the offset ring
 * the 3D viewer extrudes: `contour_offset` shifts faces for drawing, while
 * quantities are taken on the axis lines, which is the convention a deviz is
 * measured in and the only one that stays stable when an offset is edited.
 */
export function shellRegion(
  shell: BubbleGraphNode,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  nodeMap?: Map<string, BubbleGraphNode>,
  /**
   * Measure only this much height instead of the shell's own — how a height
   * ZONE reads the contour (a damp-proof socle band, then the insulated field
   * above it). The plan geometry is untouched; only the vertical readings and
   * the volume follow it.
   */
  heightOverrideM?: number,
): ShellRegion | null {
  const map = nodeMap ?? new Map(nodes.map((n) => [n.id, n]));
  const outer = calcShellPolygon(shell, map, edges);
  if (!outer || outer.length < 3) return null;

  const role = shellRole(shell);
  const heightM = heightOverrideM !== undefined
    ? Math.max(0, heightOverrideM)
    : Math.max(0, Number(shell.properties?.height ?? 2800)) / 1000;
  const thicknessM = Math.max(0, Number(shell.properties?.thickness ?? 200)) / 1000;

  const cells = cellsOfShell(shell, nodes, edges, map, outer);
  const holes: Pt[][] = [];
  for (const c of cells) {
    const poly = calcShellPolygon(c, map, edges);
    if (poly && poly.length >= 3) holes.push(poly);
  }

  const outerPerimeterM = polygonPerimeterM(outer);
  const holePerimeterM = holes.reduce((s, h) => s + polygonPerimeterM(h), 0);
  const grossAreaM2 = polygonAreaM2(outer);
  const holeAreaM2 = holes.reduce((s, h) => s + polygonAreaM2(h), 0);
  const netSolidAreaM2 = Math.max(0, grossAreaM2 - holeAreaM2);
  const perimeterM = outerPerimeterM + holePerimeterM;

  const bandAreaM2 = perimeterM * thicknessM;
  const outerFaceAreaM2 = outerPerimeterM * heightM;
  const innerFaceAreaM2 = holePerimeterM * heightM;

  // The role picks which reading is "the" area and "the" volume. An envelope
  // is a band standing on the contour; a grid or a raft is the plin lying flat.
  const isBand = role === 'envelope';
  const areaM2 = isBand ? outerFaceAreaM2 : netSolidAreaM2;
  const volumeM3 = isBand ? bandAreaM2 * heightM : netSolidAreaM2 * heightM;

  return {
    role, outer, holes, holeCount: holes.length,
    heightM, thicknessM,
    outerPerimeterM, holePerimeterM, perimeterM,
    grossAreaM2, holeAreaM2, netSolidAreaM2,
    bandAreaM2, outerFaceAreaM2, innerFaceAreaM2,
    areaM2, volumeM3,
  };
}

/** True when the model has exterior walls but no shell to carry the envelope. */
export function envelopeMissing(nodes: BubbleGraphNode[]): boolean {
  const hasWalls = nodes.some((n) => n.type === 'wall');
  const hasShell = nodes.some((n) => n.type === 'shell' && shellRole(n) === 'envelope');
  return hasWalls && !hasShell;
}
