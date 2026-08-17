/**
 * calc2DModel.ts — construiește, pur (fără React), modelul geometric 2D al
 * nodurilor dintr-un calcul (filtru = `nodeIds`) + overlay-ul de graf. Folosit atât
 * de insetul din UI (`Calc2DInset`) cât și de exportul HTML (SVG string).
 *
 * Poziții în mm (`getNodeBimPos`); dimensiunile din parserii de tip sunt în metri → ×1000.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  getNodeBimPos,
  getConnectedNodes,
  parseWallThickness,
  parseColumnDims,
  parseBeamDims,
} from '@/lib/bimGeometry';

export interface Pt { x: number; y: number }
export interface WallSeg { a: Pt; b: Pt; thick: number; focus: boolean }
export interface ColBox { c: Pt; w: number; d: number; focus: boolean }
export interface Marker { p: Pt; label: string; focus: boolean; kind: string }
export interface GraphEdgeSeg { a: Pt; b: Pt }
export interface GraphNodeDot { p: Pt; focus: boolean }

export interface Calc2DModel {
  walls: WallSeg[];
  cols: ColBox[];
  markers: Marker[];
  graphEdges: GraphEdgeSeg[];
  graphNodes: GraphNodeDot[];
  minX: number; minY: number; maxX: number; maxY: number;
  w: number; h: number; span: number;
}

const M2MM = 1000;

export interface Calc2DModelOptions {
  /**
   * true = randează ÎNTREG planul (toate elementele) ca context (albastru), cu
   * elementele din `nodeIds` evidențiate (roșu). false = doar focus + vecinii direcți.
   */
  fullContext?: boolean;
}

export function buildCalc2DModel(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  nodeIds: string[],
  opts: Calc2DModelOptions = {},
): Calc2DModel | null {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const focus = new Set(nodeIds);

  const relevant = new Set<string>(nodeIds);
  if (opts.fullContext) {
    // Tot planul ca context.
    for (const n of nodes) relevant.add(n.id);
  } else {
    // Doar vecinii direcți (capetele pereților/grinzilor).
    for (const id of nodeIds) {
      for (const c of getConnectedNodes(id, edges, nodeMap)) relevant.add(c.id);
    }
  }

  const pos = (n: BubbleGraphNode): Pt => getNodeBimPos(n, nodeMap);
  const relNodes = [...relevant].map((id) => nodeMap.get(id)).filter((n): n is BubbleGraphNode => !!n);

  const walls: WallSeg[] = [];
  const cols: ColBox[] = [];
  const markers: Marker[] = [];

  for (const n of relNodes) {
    const isFocus = focus.has(n.id);
    if (n.type === 'wall') {
      const axes = getConnectedNodes(n.id, edges, nodeMap).filter((c) => c.type === 'ax');
      if (axes.length >= 2) {
        walls.push({
          a: pos(axes[0]), b: pos(axes[1]),
          thick: parseWallThickness(String(n.properties.wall_type ?? 'W20')) * M2MM,
          focus: isFocus,
        });
      } else {
        markers.push({ p: pos(n), label: n.name ?? n.id, focus: isFocus, kind: 'wall' });
      }
    } else if (n.type === 'beam') {
      const ends = getConnectedNodes(n.id, edges, nodeMap);
      if (ends.length >= 2) {
        walls.push({
          a: pos(ends[0]), b: pos(ends[1]),
          thick: parseBeamDims(String(n.properties.beam_section ?? 'B20x30')).bw * M2MM,
          focus: isFocus,
        });
      } else {
        markers.push({ p: pos(n), label: n.name ?? n.id, focus: isFocus, kind: 'beam' });
      }
    } else if (n.type === 'column' || (n.type === 'ax' && String(n.properties.has_column) === 'True')) {
      const dc = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
      cols.push({ c: pos(n), w: dc.w * M2MM, d: dc.d * M2MM, focus: isFocus });
    } else if (n.type !== 'ax' && n.type !== 'storey') {
      markers.push({ p: pos(n), label: n.name ?? n.id, focus: isFocus, kind: n.type });
    }
  }

  const graphEdges: GraphEdgeSeg[] = edges
    .filter((e) => relevant.has(e.from) && relevant.has(e.to))
    .map((e) => ({ a: pos(nodeMap.get(e.from)!), b: pos(nodeMap.get(e.to)!) }));
  const graphNodes: GraphNodeDot[] = relNodes.map((n) => ({ p: pos(n), focus: focus.has(n.id) }));

  const pts: Pt[] = [];
  for (const wl of walls) { pts.push(wl.a, wl.b); }
  for (const c of cols) { pts.push({ x: c.c.x - c.w / 2, y: c.c.y - c.d / 2 }, { x: c.c.x + c.w / 2, y: c.c.y + c.d / 2 }); }
  for (const m of markers) pts.push(m.p);
  for (const g of graphNodes) pts.push(g.p);
  if (pts.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const span = Math.max(maxX - minX, maxY - minY, 1000);
  const pad = span * 0.12 + 200;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  return { walls, cols, markers, graphEdges, graphNodes, minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, span };
}
