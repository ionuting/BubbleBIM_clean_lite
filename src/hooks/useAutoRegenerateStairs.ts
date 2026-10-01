/**
 * useAutoRegenerateStairs — live regeneration, the way Revit and ArchiCAD
 * behave: change a stair parameter, or drag the stairwell node, and the stair
 * rebuilds itself. No Generate button between the edit and the result.
 *
 * The mechanics matter more than they look:
 *
 * - Change detection is by INTENT, not by node identity. Each stairwell gets a
 *   fingerprint of everything its geometry depends on — its parameters, its
 *   position, the axes wired to it, and every storey elevation. The solver
 *   stamping `solved_*` results back onto the node does NOT change the
 *   fingerprint, which is what keeps this from looping forever.
 * - The first pass only records fingerprints. A freshly loaded project must not
 *   be regenerated just for having been opened — that would dirty the file and
 *   reshuffle node ids without the user touching anything.
 * - Debounced through a pending set, so a half-typed "12" in a width field or a
 *   node mid-drag resolves once, 350 ms after the input goes quiet, and a
 *   stairwell whose edit is superseded by another node's change is not lost.
 * - No toasts. The solver's diagnostics are stamped on the node and the
 *   Inspector shows them inline; a toast per keystroke would be noise.
 */
import { useEffect, useRef } from 'react';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { applyStairResult, solveStair } from '@/lib/stair';

/** Every stairwell property the solved geometry is a function of. */
const INTENT_KEYS = [
  'stair_type', 'width_mm', 'direction_deg', 'turn', 'turn_style', 'winder_count',
  'spiral_inner_mm', 'spiral_structure', 'sizing', 'riser_mm',
  'tread_mm', 'landing_depth_mm', 'structure', 'thickness_mm', 'material',
  'gen_void', 'void_clearance_mm', 'gen_railing', 'railing_height_mm',
  'railing_side', 'gen_base_beam', 'base_beam_web_mm', 'base_beam_flange_mm',
  'base_beam_flange_h_mm', 'base_beam_depth_mm', 'generate_level',
] as const;

function fingerprint(
  sw: BubbleGraphNode,
  edges: BubbleGraphEdge[],
  byId: Map<string, BubbleGraphNode>,
  storeySig: string,
): string {
  const props = INTENT_KEYS.map((k) => `${k}=${String(sw.properties[k] ?? '')}`).join('|');
  // The wired shaft: connected ax/column nodes in edge order, with positions.
  const anchors: string[] = [];
  for (const e of edges) {
    if (e.from !== sw.id && e.to !== sw.id) continue;
    const o = byId.get(e.from === sw.id ? e.to : e.from);
    if (!o || (o.type !== 'ax' && o.type !== 'column')) continue;
    anchors.push(`${o.id}:${String(o.properties.bimX ?? o.x)},${String(o.properties.bimY ?? o.y)}`);
  }
  return `${sw.x},${sw.y};${sw.parentId ?? ''};${props};${anchors.join('|')};${storeySig}`;
}

export function useAutoRegenerateStairs(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  setNodes: (n: BubbleGraphNode[]) => void,
  setEdges: (e: BubbleGraphEdge[]) => void,
): void {
  const prev = useRef<Map<string, string> | null>(null);
  const pending = useRef(new Set<string>());
  // Always solve against the freshest state, not the closure the timer captured.
  const latest = useRef({ nodes, edges });
  latest.current = { nodes, edges };

  useEffect(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const storeySig = nodes
      .filter((n) => n.type === 'storey')
      .map((s) => `${s.id}:${String(s.properties.bottomElevation ?? '')}-${String(s.properties.topElevation ?? '')}`)
      .join('|');

    const keys = new Map(
      nodes
        .filter((n) => n.type === 'stairwell')
        .map((sw) => [sw.id, fingerprint(sw, edges, byId, storeySig)] as const),
    );

    if (prev.current === null) {
      prev.current = keys;
      return;
    }

    for (const [id, key] of keys) {
      const before = prev.current.get(id);
      // A stairwell seen for the first time was just created — and creation
      // already solves. Only an intent that CHANGED queues a regeneration.
      if (before !== undefined && before !== key) pending.current.add(id);
    }
    prev.current = keys;

    if (!pending.current.size) return;
    const t = setTimeout(() => {
      const ids = [...pending.current];
      pending.current.clear();
      let { nodes: ns, edges: es } = latest.current;
      let touched = false;
      for (const id of ids) {
        if (!ns.some((n) => n.id === id && n.type === 'stairwell')) continue;
        const result = solveStair({ nodes: ns, edges: es, stairwellId: id });
        ({ nodes: ns, edges: es } = applyStairResult(ns, es, result));
        touched = true;
      }
      if (touched) {
        setNodes(ns);
        setEdges(es);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [nodes, edges, setNodes, setEdges]);
}
