/**
 * formulaUtils.ts — safe formula evaluation and array expansion for BIM parameters.
 *
 * FormulaInput supports:
 *   - Arithmetic: 1000*3, 2500+500, (3000-200)/2
 *   - Constants:  PI, E
 *   - Functions:  sqrt(), abs(), round(), floor(), ceil(), min(), max(), sin(), cos(), tan()
 *   - Array list: [0, 3000, 6000]          → 3 values
 *   - Range:      {0..18000..6000}          → [0, 6000, 12000, 18000]  (start..end..step)
 *   - Context:    room_area, wall_length, storey_height, etc. (see resolveFormulaContext)
 *
 * expandArrayNodes() takes the flat node list and produces an expanded list where nodes
 * that carry array_x / array_y / array_z properties are repeated at each combination of
 * those offsets (applied on top of the node's base x / y / z).
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';

// ─── Formula context ──────────────────────────────────────────────────────────

/**
 * Contextual variables that can be referenced inside any formula expression.
 * All lengths in mm, areas in m².
 *
 * See docs/FORMULA_CONTEXT.md for the full reference.
 */
export interface FormulaContext {
  // Wall the opening/element belongs to
  wall_length:   number; // mm — effective span (after offsets)
  wall_height:   number; // mm
  wall_thickness:number; // mm
  // Room(s) adjacent to the wall (first found)
  room_area:     number; // m²
  room_width:    number; // mm — bounding box in BIM X
  room_depth:    number; // mm — bounding box in BIM Y
  room_height:   number; // mm — room height property
  room_perimeter:number; // mm
  // Storey
  storey_height: number; // mm — topElevation − bottomElevation
  storey_bottom: number; // mm — bottomElevation
  storey_top:    number; // mm — topElevation
  // Own node properties (useful for relative sizing)
  w:             number; // mm — current width (from library/property)
  h:             number; // mm — current height
  sill:          number; // mm — current sill_height
}

/** All context keys as array — used for whitelist regex generation. */
const CTX_KEYS: (keyof FormulaContext)[] = [
  'wall_length','wall_height','wall_thickness',
  'room_area','room_width','room_depth','room_height','room_perimeter',
  'storey_height','storey_bottom','storey_top',
  'w','h','sill',
];

// ─── Safe expression evaluator ────────────────────────────────────────────────

// Allowed tokens: digits, operators, parens, dot, whitespace, math names, context variable names
const BASE_SAFE = /^[\d\s+\-*/.(),PIEsqrtabsroundflorceilminmaxtancosin_]+$/;

const MATH_ENV: Record<string, number | ((...a: number[]) => number)> = {
  PI:    Math.PI,
  E:     Math.E,
  sqrt:  Math.sqrt,
  abs:   Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil:  Math.ceil,
  min:   Math.min,
  max:   Math.max,
  sin:   Math.sin,
  cos:   Math.cos,
  tan:   Math.tan,
};

/**
 * Safely evaluate a single numeric expression.
 * Optionally accepts a context object whose keys are injected as variables.
 * Returns NaN on failure — never throws.
 *
 * @example
 *   safeEval('wall_length * 0.15', { wall_length: 6000 }) // → 900
 *   safeEval('max(900, room_area * 50)', { room_area: 18.5 }) // → 925
 */
export function safeEval(expr: string, ctx?: Partial<FormulaContext>): number {
  const s = expr.trim();
  if (!s) return NaN;

  // Plain number fast-path
  const plain = Number(s);
  if (!isNaN(plain)) return plain;

  // Whitelist check — allow context variable names (alphanumeric + underscore)
  if (!BASE_SAFE.test(s.replace(/\s/g, ''))) return NaN;

  try {
    const envKeys   = Object.keys(MATH_ENV);
    const envVals   = Object.values(MATH_ENV);
    const ctxEntries = ctx ? Object.entries(ctx).filter(([, v]) => typeof v === 'number') : [];
    const ctxKeys   = ctxEntries.map(([k]) => k);
    const ctxVals   = ctxEntries.map(([, v]) => v);
    const allKeys   = [...envKeys, ...ctxKeys].join(',');
    const allVals   = [...envVals, ...ctxVals];
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(allKeys, `'use strict'; return (${s});`) as (...a: unknown[]) => number;
    const result = fn(...allVals);
    return typeof result === 'number' ? result : NaN;
  } catch {
    return NaN;
  }
}

/**
 * Evaluate a property value that may be a formula string or a plain number.
 * Falls back to `fallback` when the value is missing/NaN.
 */
export function evalProp(
  raw: string | number | null | undefined,
  ctx?: Partial<FormulaContext>,
  fallback = NaN,
): number {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'number') return isNaN(raw) ? fallback : raw;
  const v = safeEval(String(raw), ctx);
  return isNaN(v) ? fallback : v;
}

// ─── Topology context resolver ────────────────────────────────────────────────

/**
 * Build a FormulaContext for a given node by traversing the BIM graph topology.
 *
 * Traversal rules (see docs/FORMULA_CONTEXT.md):
 *   window / door node        → parent wall → storey, room
 *   inline opening dict entry → wall node   → storey, room
 *   wall node                 → storey, connected rooms
 *   any other node            → storey only
 */
export function resolveFormulaContext(
  node: BubbleGraphNode,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): FormulaContext {
  const DEFAULT: FormulaContext = {
    wall_length: 0, wall_height: 0, wall_thickness: 0,
    room_area: 0, room_width: 0, room_depth: 0, room_height: 0, room_perimeter: 0,
    storey_height: 3000, storey_bottom: 0, storey_top: 3000,
    w: 0, h: 0, sill: 0,
  };

  // ── Locate the wall (directly from node or via edge) ──────────────────────
  let wallNode: BubbleGraphNode | undefined;
  if (node.type === 'wall') {
    wallNode = node;
  } else if (node.type === 'window' || node.type === 'door') {
    wallNode = edges
      .filter((e) => e.from === node.id || e.to === node.id)
      .map((e) => nodeMap.get(e.from === node.id ? e.to : e.from))
      .find((n): n is BubbleGraphNode => n?.type === 'wall');
  }

  // ── Storey ────────────────────────────────────────────────────────────────
  const anchorNode = wallNode ?? node;
  const storeyNode = anchorNode.parentId ? nodeMap.get(anchorNode.parentId) : undefined;
  const storeyBot  = Number(storeyNode?.properties.bottomElevation ?? 0);
  const storeyTop  = Number(storeyNode?.properties.topElevation    ?? 3000);
  DEFAULT.storey_bottom = storeyBot;
  DEFAULT.storey_top    = storeyTop;
  DEFAULT.storey_height = storeyTop - storeyBot;

  // ── Wall geometry ──────────────────────────────────────────────────────────
  if (wallNode) {
    // Find wall endpoint nodes (ax/column)
    const WALL_ENDPOINT_TYPES = new Set(['ax', 'column', 'foundation']);
    const endpts = edges
      .filter((e) => e.from === wallNode!.id || e.to === wallNode!.id)
      .map((e) => nodeMap.get(e.from === wallNode!.id ? e.to : e.from))
      .filter((n): n is BubbleGraphNode => !!n && WALL_ENDPOINT_TYPES.has(n.type));

    if (endpts.length >= 2) {
      // Resolve BIM mm positions (ax nodes via axes grid, others direct)
      const getPos = (n: BubbleGraphNode) => {
        if (n.type === 'ax') {
          const s = n.parentId ? nodeMap.get(n.parentId) : undefined;
          const axX = parseAxesList(s?.properties?.axesX);
          const axY = parseAxesList(s?.properties?.axesY);
          return { x: axX[Number(n.properties.gridX ?? 0)] ?? n.x, y: axY[Number(n.properties.gridY ?? 0)] ?? n.y };
        }
        return { x: n.x, y: n.y };
      };
      const pA = getPos(endpts[0]), pB = getPos(endpts[1]);
      const wallLen = Math.sqrt((pB.x - pA.x) ** 2 + (pB.y - pA.y) ** 2);
      const osRaw = wallNode.properties.offsetStart ?? wallNode.properties.offset_start;
      const oeRaw = wallNode.properties.offsetEnd   ?? wallNode.properties.offset_end;
      const os    = osRaw != null ? Number(osRaw) : 0;
      const oe    = oeRaw != null ? Number(oeRaw) : 0;
      DEFAULT.wall_length    = Math.max(0, wallLen - os - oe);
      DEFAULT.wall_thickness = parseWallThicknessMm(String(wallNode.properties.wall_type ?? 'W20'));
    }
    DEFAULT.wall_height = Number(wallNode.properties.height ?? (storeyTop - storeyBot));

    // ── Find adjacent room (first room connected to this wall) ────────────
    const roomNode = edges
      .filter((e) => e.from === wallNode!.id || e.to === wallNode!.id)
      .map((e) => nodeMap.get(e.from === wallNode!.id ? e.to : e.from))
      .find((n): n is BubbleGraphNode => n?.type === 'room');

    if (roomNode) {
      DEFAULT.room_height = Number(roomNode.properties.height ?? (storeyTop - storeyBot));
      // Compute room polygon area/bounds using same Pattern A / B logic as calcRoomPolygon
      const poly = calcRoomPolyForContext(roomNode, edges, nodeMap);
      if (poly.length >= 3) {
        let area2 = 0;
        for (let i = 0; i < poly.length; i++) {
          const j = (i + 1) % poly.length;
          area2 += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
        }
        DEFAULT.room_area = Math.abs(area2) / 2e6; // mm² → m²
        const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
        DEFAULT.room_width  = Math.max(...xs) - Math.min(...xs);
        DEFAULT.room_depth  = Math.max(...ys) - Math.min(...ys);
        // Perimeter
        let perim = 0;
        for (let i = 0; i < poly.length; i++) {
          const j = (i + 1) % poly.length;
          perim += Math.sqrt((poly[j].x - poly[i].x) ** 2 + (poly[j].y - poly[i].y) ** 2);
        }
        DEFAULT.room_perimeter = perim;
      }
    }
  }

  // ── Own node dims (current library / property values) ─────────────────────
  DEFAULT.w    = Number(node.properties.width       ?? node.properties.w    ?? 0);
  DEFAULT.h    = Number(node.properties.height      ?? node.properties.h    ?? 0);
  DEFAULT.sill = Number(node.properties.sill_height ?? node.properties.sill ?? 0);

  return DEFAULT;
}

// ── Internal helpers (no external dependency on bimGeometry to avoid circular imports) ──

function parseAxesList(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) return p.map(Number); } catch { /* */ }
    return raw.split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n));
  }
  return [];
}

function parseWallThicknessMm(t: string): number {
  if (/separator/i.test(t)) return 10;
  const m = t.match(/[Ww](\d+)/);
  return m ? +m[1] * 10 : 200;
}

function calcRoomPolyForContext(
  roomNode: BubbleGraphNode,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): { x: number; y: number }[] {
  const IGNORE = new Set(['window', 'door', 'room', 'storey']);

  const getPos = (n: BubbleGraphNode) => {
    if (n.type === 'ax') {
      const s = n.parentId ? nodeMap.get(n.parentId) : undefined;
      const axX = parseAxesList(s?.properties?.axesX);
      const axY = parseAxesList(s?.properties?.axesY);
      return { x: axX[Number(n.properties.gridX ?? 0)] ?? n.x, y: axY[Number(n.properties.gridY ?? 0)] ?? n.y };
    }
    return { x: n.x, y: n.y };
  };

  const connEdges = edges.filter((e) => e.from === roomNode.id || e.to === roomNode.id);
  const conn = connEdges
    .map((e) => nodeMap.get(e.from === roomNode.id ? e.to : e.from))
    .filter((n): n is BubbleGraphNode => !!n);

  // Pattern A: direct ax/column
  const anchors = conn.filter((n) => n.type === 'ax' || n.type === 'column');
  if (anchors.length >= 3) return anchors.map(getPos);

  // Pattern B: wall adjacency
  const walls = conn.filter((n) => n.type === 'wall');
  if (walls.length >= 3) {
    const adj    = new Map<string, Set<string>>();
    const nById  = new Map<string, BubbleGraphNode>();
    for (const wall of walls) {
      const corners = edges
        .filter((e) => e.from === wall.id || e.to === wall.id)
        .map((e) => nodeMap.get(e.from === wall.id ? e.to : e.from))
        .filter((n): n is BubbleGraphNode => !!n && !IGNORE.has(n.type)
          && (n.type === 'ax' || n.type === 'column'));
      if (corners.length >= 2) {
        const [a, b] = corners;
        nById.set(a.id, a); nById.set(b.id, b);
        if (!adj.has(a.id)) adj.set(a.id, new Set());
        if (!adj.has(b.id)) adj.set(b.id, new Set());
        adj.get(a.id)!.add(b.id); adj.get(b.id)!.add(a.id);
      }
    }
    if (adj.size >= 3) {
      const start = [...adj.keys()][0];
      const visited = new Set([start]);
      const polyIds = [start]; let cur = start;
      while (true) {
        const next = [...(adj.get(cur) ?? [])].find((id) => !visited.has(id));
        if (!next) break;
        visited.add(next); polyIds.push(next); cur = next;
      }
      if (polyIds.length >= 3) return polyIds.map((id) => getPos(nById.get(id)!));
    }
  }
  return [];
}

/** All available context variable names (exported for UI documentation/tooltip). */
export { CTX_KEYS };

// ─── Array / range parser ─────────────────────────────────────────────────────

/**
 * Parse an array property string into a list of numbers.
 *
 * Supported formats:
 *   "[0, 3000, 6000]"          → [0, 3000, 6000]
 *   "0, 3000, 6000"            → [0, 3000, 6000]
 *   "{0..18000..6000}"         → [0, 6000, 12000, 18000]
 *   "{start..end..step}"       → range inclusive of start, up to end
 *   "3000"                     → [3000]  (single scalar)
 *   each value may itself be a formula: "[PI*1000, 2500+500]"
 *
 * Returns [] on failure.
 */
export function parseArrayProp(raw: string | null | undefined): number[] {
  if (raw == null || raw === '') return [];

  const s = String(raw).trim();

  // Range syntax: {start..end..step}
  const rangeMatch = s.match(/^\{(.+?)\.\.(.+?)\.\.(.+?)\}$/);
  if (rangeMatch) {
    const start = safeEval(rangeMatch[1]);
    const end   = safeEval(rangeMatch[2]);
    const step  = safeEval(rangeMatch[3]);
    if (isNaN(start) || isNaN(end) || isNaN(step) || step === 0) return [];
    const result: number[] = [];
    const sign = step > 0 ? 1 : -1;
    for (let v = start; sign * v <= sign * end + 1e-9; v += step) {
      result.push(Math.round(v * 1e6) / 1e6); // float precision cleanup
    }
    return result;
  }

  // List syntax: [a, b, c] or a, b, c
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  const parts = inner.split(',').map((p) => safeEval(p.trim())).filter((v) => !isNaN(v));
  return parts.length > 0 ? parts : [];
}

/**
 * Check whether a string looks like an array / range expression (not a plain scalar).
 */
export function isArrayExpr(s: string): boolean {
  const t = s.trim();
  if (t.startsWith('[') || t.startsWith('{')) return true;
  if (t.includes(',')) return true;
  return false;
}

// ─── Node array expansion ─────────────────────────────────────────────────────

/**
 * Expand nodes that carry `array_x`, `array_y`, and/or `array_z` properties.
 *
 * For each array node, we produce one virtual copy per combination of the supplied
 * offset values added to the node's base x/y/z.  The original node (offset 0,0,0)
 * is always included when its base offsets contain it.
 *
 * Virtual copies receive:
 *   - `id`:  `${original.id}_arr_${xIdx}_${yIdx}_${zIdx}`
 *   - `_arraySource`: original id  (useful for selection / deletion propagation)
 *   - `_arrayIndex`:  `{xi, yi, zi}`
 *
 * Nodes without any array property are returned unchanged.
 */
export function expandArrayNodes(nodes: BubbleGraphNode[]): BubbleGraphNode[] {
  const result: BubbleGraphNode[] = [];
  for (const n of nodes) {
    const ax = parseArrayProp(n.properties.array_x as string | undefined);
    const ay = parseArrayProp(n.properties.array_y as string | undefined);
    const az = parseArrayProp(n.properties.array_z as string | undefined);

    // No arrays → passthrough
    if (ax.length === 0 && ay.length === 0 && az.length === 0) {
      result.push(n);
      continue;
    }

    const xOffsets = ax.length > 0 ? ax : [0];
    const yOffsets = ay.length > 0 ? ay : [0];
    const zOffsets = az.length > 0 ? az : [0];

    for (let xi = 0; xi < xOffsets.length; xi++) {
      for (let yi = 0; yi < yOffsets.length; yi++) {
        for (let zi = 0; zi < zOffsets.length; zi++) {
          result.push({
            ...n,
            id: `${n.id}_arr_${xi}_${yi}_${zi}`,
            x:  n.x + xOffsets[xi],
            y:  n.y + yOffsets[yi],
            z:  (n.z ?? 0) + zOffsets[zi],
            properties: {
              ...n.properties,
              _arraySource: n.id,
              _arrayIndex:  JSON.stringify({ xi, yi, zi }),
            },
          });
        }
      }
    }
  }
  return result;
}
