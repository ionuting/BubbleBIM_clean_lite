/**
 * Internal B-rep kernel — model assembly.
 *
 * Turns a whole BubbleGraph into a list of `Solid`s, one per element, with
 * junctions resolved and openings punched. This is the piece that eventually
 * replaces the element loops in `ogBimMapper.ts`; for now it also feeds the
 * side-by-side comparison viewer.
 *
 * ## Coverage
 * Covers exactly what the kernel builders support today: walls, their ring
 * beams, columns, slabs and room floor slabs. Roofs, coverings, shells and
 * timber framing still go through the existing pipeline — they are the next
 * phase, and the viewer labels the gap so a missing roof reads as "not ported
 * yet" rather than "the kernel dropped it".
 *
 * Requires `ensureBooleanEngine()` to have resolved.
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { resolveStoreyId } from '@/lib/bimGeometry';
import { expandArrayNodes } from '@/lib/formulaUtils';
import type { Solid } from './types';
import { columnSolid, roomSlabSolid, roomVolumeSolid, slabSolid, wallBeamSolid } from './builders';
import { buildWallSolids, type BuildWallsOptions, type JunctionDiagnostic } from './junctions';
import { validateSolid } from './solid';
import { volumeM3 } from './measure';

/** One built element: the node it came from, and its solid. */
export interface BrepElement {
  /** Source node id. Several elements may share one (a wall and its ring beam). */
  id: string;
  /** Element kind for colouring/filtering: 'wall' | 'beam' | 'column' | 'slab' | 'room'. */
  type: string;
  node: BubbleGraphNode;
  solid: Solid;
  storeyId?: string;
}

export interface BrepModelDiagnostic {
  code: 'invalid_solid' | 'build_failed' | JunctionDiagnostic['code'];
  nodeId: string;
  message: string;
}

export interface BrepModel {
  elements: BrepElement[];
  diagnostics: BrepModelDiagnostic[];
  /** Element kinds the kernel does not build yet — shown so gaps read as expected. */
  unsupportedTypes: string[];
}

export interface BuildModelOptions extends BuildWallsOptions {
  /** Include room air volumes. Off by default — useful for takeoff, noisy on screen. */
  includeRoomVolumes?: boolean;
  /** Run `validateSolid` on everything and report failures. Default true. */
  validate?: boolean;
}

/** Element types the existing pipeline draws but the kernel does not build yet. */
const NOT_YET_PORTED = new Set([
  'roof', 'covering', 'shell', 'skylight', 'dormer', 'foundation',
  'rafter', 'hip_rafter', 'valley_rafter', 'ridge_beam', 'wall_plate', 'post', 'purlin',
  'tie_beam', 'collar_tie', 'membrane', 'sheathing', 'insulation', 'counter_batten',
  'batten', 'fascia', 'barge_board', 'soffit', 'ridge_cap', 'hip_cap', 'valley_flashing',
  'gutter', 'downpipe', 'snow_guard', 'object',
]);

/**
 * Build every supported element of the model.
 *
 * Walls go through `buildWallSolids` as a set, because junction resolution is
 * inherently a whole-model operation — a wall's final shape depends on its
 * neighbours. Everything else is independent and built per node.
 */
export function buildBrepModel(
  rawNodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  opts: BuildModelOptions = {},
): BrepModel {
  const nodes = expandArrayNodes(rawNodes) as BubbleGraphNode[];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const elements: BrepElement[] = [];
  const diagnostics: BrepModelDiagnostic[] = [];

  const add = (type: string, node: BubbleGraphNode, solid: Solid | null) => {
    if (!solid) return;
    elements.push({ id: node.id, type, node, solid, storeyId: resolveStoreyId(node, nodeMap) });
  };

  // ── Walls: one whole-model pass (junctions + openings) ─────────────────────
  const walls = buildWallSolids(nodes, edges, opts);
  for (const body of walls.bodies) {
    elements.push({
      id: body.id, type: 'wall', node: body.node, solid: body.solid,
      storeyId: resolveStoreyId(body.node, nodeMap),
    });
  }
  for (const d of walls.diagnostics) {
    diagnostics.push({ code: d.code, nodeId: d.wallId, message: d.message });
  }

  // ── Everything else: independent, per node ─────────────────────────────────
  for (const n of nodes) {
    try {
      switch (n.type) {
        case 'wall':
          if (String(n.properties.has_beam ?? '').toLowerCase() === 'true') {
            add('beam', n, wallBeamSolid(n, nodeMap, edges, undefined, opts));
          }
          break;
        case 'column':
          add('column', n, columnSolid(n, nodeMap, opts));
          break;
        case 'ax':
          if (String(n.properties.has_column ?? '').toLowerCase() === 'true') {
            add('column', n, columnSolid(n, nodeMap, opts));
          }
          break;
        case 'slab':
          add('slab', n, slabSolid(n, nodeMap, edges, opts));
          break;
        case 'room':
          if (n.properties.has_slab !== 'False' && n.properties.has_slab !== false) {
            add('slab', n, roomSlabSolid(n, nodeMap, edges, opts));
          }
          if (opts.includeRoomVolumes) {
            add('room', n, roomVolumeSolid(n, nodeMap, edges, opts));
          }
          break;
      }
    } catch (err) {
      diagnostics.push({
        code: 'build_failed',
        nodeId: n.id,
        message: `${n.type} "${n.name || n.id}": ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ── Validation ─────────────────────────────────────────────────────────────
  if (opts.validate !== false) {
    for (const el of elements) {
      const errors = validateSolid(el.solid).filter((d) => d.severity === 'error');
      if (errors.length) {
        diagnostics.push({
          code: 'invalid_solid',
          nodeId: el.id,
          message: `${el.type} "${el.node.name || el.id}": ${errors.map((e) => e.message).join(' ')}`,
        });
      }
    }
  }

  const unsupportedTypes = [...new Set(
    nodes.filter((n) => NOT_YET_PORTED.has(n.type)).map((n) => n.type),
  )].sort();

  return { elements, diagnostics, unsupportedTypes };
}

/** Total enclosed volume per element type (m³) — the takeoff-facing summary. */
export function modelVolumesByType(model: BrepModel): Record<string, number> {
  const out: Record<string, number> = {};
  for (const el of model.elements) {
    out[el.type] = (out[el.type] ?? 0) + volumeM3(el.solid);
  }
  return out;
}
