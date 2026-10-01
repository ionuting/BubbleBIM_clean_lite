/**
 * rewire.ts — change what a sketch is drawn against, without moving it.
 *
 * Wiring an ax to a sketch changes the meaning of every stored number: they
 * were offsets from the old origin, now they are offsets from the new one.
 * Done naively the sketch would jump. So the same operation that writes the
 * edges also rewrites the points, so that what is on the screen stays where
 * it is — the reference changes, the drawing does not.
 *
 * The one deliberate exception: a RECTANGLE aligns itself to the new line.
 * Its numbers are a corner and two sides in the frame's own axes, so it can
 * only ever be square to the line it references. The corner stays put; the
 * sides turn. A circle has no orientation to lose, and a free contour is
 * re-expressed point by point, exactly.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { outlineToLocal, outlineToWorld, resolveSketchFrame, worldToLocal, localToWorld } from './frame';
import { parseSketchIntent, serialiseOutline } from './types';

export interface RewireResult {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
}

const isAnchor = (n: BubbleGraphNode | undefined): boolean => !!n && (n.type === 'ax' || n.type === 'column');

let seq = 0;
const edgeId = (): string => `edge_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * Make `refIds` (0, 1 or 2 ax ids, in order: origin, then direction) the
 * sketch's references, and rewrite its stored geometry so it does not move.
 *
 * Every existing sketch↔ax edge is dropped first — the reference is the
 * ORDERED pair, and edge order is what `getOrderedAnchorNodes` reads, so a
 * swap of origin and direction has to be a rebuild, not a patch. Returns the
 * same arrays when nothing would change.
 */
export function setSketchRefs(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  sketchId: string,
  refIds: string[],
): RewireResult {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const sketch = nodeMap.get(sketchId);
  if (!sketch || sketch.type !== 'sketch') return { nodes, edges };

  const wanted = refIds.filter((id, i) => id && isAnchor(nodeMap.get(id)) && refIds.indexOf(id) === i).slice(0, 2);
  const oldFrame = resolveSketchFrame(sketch, nodeMap, edges).frame;
  if (oldFrame.refIds.length === wanted.length && oldFrame.refIds.every((id, i) => id === wanted[i])) {
    return { nodes, edges };
  }

  const kept = edges.filter((e) => {
    const other = e.from === sketchId ? e.to : e.to === sketchId ? e.from : null;
    return other === null || !isAnchor(nodeMap.get(other));
  });
  const nextEdges = [...kept, ...wanted.map((id) => ({ id: edgeId(), from: sketchId, to: id, type: 'references' as const }))];
  const newFrame = resolveSketchFrame(sketch, nodeMap, nextEdges).frame;

  const intent = parseSketchIntent(sketch);
  const props: Record<string, unknown> = { ...sketch.properties };
  const r = (n: number) => Math.round(n * 10) / 10;
  // Where the stored point IS today, then what it must read as in the new frame.
  const move = (p: { x: number; y: number }) => worldToLocal(newFrame, intent.ref, localToWorld(oldFrame, intent.ref, p));

  let localOutline: { x: number; y: number }[];
  if (intent.shape === 'rect' || intent.shape === 'circle') {
    const c = move({ x: intent.shapeParams.xMm, y: intent.shapeParams.yMm });
    props.shape_x_mm = r(c.x);
    props.shape_y_mm = r(c.y);
    localOutline = parseSketchIntent({ ...sketch, properties: props }).outline;
  } else {
    // A curve re-expresses its own points; its outline follows from them.
    const own = intent.curve?.points ?? intent.outline;
    localOutline = outlineToLocal(newFrame, intent.ref, outlineToWorld(oldFrame, intent.ref, own));
  }
  props.outline = serialiseOutline(localOutline);

  const world = outlineToWorld(newFrame, intent.ref, localOutline);
  const next: BubbleGraphNode = { ...sketch, properties: props };
  if (world.length) {
    next.x = world.reduce((a, p) => a + p.x, 0) / world.length;
    next.y = world.reduce((a, p) => a + p.y, 0) / world.length;
  }
  return {
    nodes: nodes.map((n) => (n.id === sketchId ? next : n)),
    edges: nextEdges,
  };
}
