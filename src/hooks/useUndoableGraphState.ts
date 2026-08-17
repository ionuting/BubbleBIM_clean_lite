/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useUndoableGraphState — a drop-in replacement for the two `useState`s that
 * own `nodes`/`edges` in BubbleGraphPanel.tsx, adding an in-memory undo/redo
 * stack (`undoStack.ts`). This is the "working tree" layer of the git-
 * inspired versioning system (see also: the backend commit history in
 * `src/lib/versionHistory.ts` / the History panel) — fast, local-only, lost
 * on page reload. It does NOT talk to the backend at all.
 *
 * Design:
 *   - `nodes` and `edges` are tracked together as ONE history entry
 *     (`GraphSnapshot`), since most real edits touch both (e.g. deleting a
 *     node also deletes its edges) — undoing a node-only visible change
 *     should still restore the edges as they were at that point too.
 *   - Returned `setNodes`/`setEdges` have the exact same signature as
 *     React's `useState` setter (value OR updater-function), so every
 *     existing call site in BubbleGraphPanel.tsx keeps working unchanged —
 *     only the two `useState` declarations needed to change.
 *   - Coalescing (see undoStack.ts): rapid-fire changes collapse into ONE
 *     undo step, so a drag or fast typing doesn't produce hundreds of
 *     one-pixel/one-keystroke undo steps.
 *   - `undo`/`redo` bypass the wrapped setters (they call the raw `useState`
 *     setters directly) so restoring a snapshot never itself gets recorded
 *     as a new undoable step — that would corrupt the redo stack.
 */

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { UndoStack } from './undoStack';

interface GraphSnapshot {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
}

export interface UndoableGraphState {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  setNodes: Dispatch<SetStateAction<BubbleGraphNode[]>>;
  setEdges: Dispatch<SetStateAction<BubbleGraphEdge[]>>;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Force the NEXT change to start a fresh undo step even if it arrives
   * within the coalescing window — call before a bulk/programmatic edit
   * (e.g. "New project", "Open project", import) that should never merge
   * with whatever the user was doing right before it.
   */
  breakCoalescing: () => void;
}

export function useUndoableGraphState(
  initialNodes: BubbleGraphNode[],
  initialEdges: BubbleGraphEdge[],
): UndoableGraphState {
  const [nodes, setNodesState] = useState<BubbleGraphNode[]>(initialNodes);
  const [edges, setEdgesState] = useState<BubbleGraphEdge[]>(initialEdges);

  // Always-current mirrors so setNodes can see the latest edges (and vice
  // versa) without depending on the other's state in useCallback — that
  // would recreate the setter on every edges change, invalidating every
  // memoized callback across the panel that depends on `setNodes`.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const stackRef = useRef<UndoStack<GraphSnapshot> | null>(null);
  if (!stackRef.current) stackRef.current = new UndoStack<GraphSnapshot>();
  const stack = stackRef.current;

  // Refs inside UndoStack don't trigger re-renders on their own — bump this
  // after any change so canUndo/canRedo (read fresh below) reflect it.
  const [, forceRender] = useState(0);

  const setNodes = useCallback<Dispatch<SetStateAction<BubbleGraphNode[]>>>((updater) => {
    setNodesState((prev) => {
      const next = typeof updater === 'function'
        ? (updater as (p: BubbleGraphNode[]) => BubbleGraphNode[])(prev)
        : updater;
      if (next !== prev && stack.record({ nodes: prev, edges: edgesRef.current })) forceRender((v) => v + 1);
      return next;
    });
  }, [stack]);

  const setEdges = useCallback<Dispatch<SetStateAction<BubbleGraphEdge[]>>>((updater) => {
    setEdgesState((prev) => {
      const next = typeof updater === 'function'
        ? (updater as (p: BubbleGraphEdge[]) => BubbleGraphEdge[])(prev)
        : updater;
      if (next !== prev && stack.record({ nodes: nodesRef.current, edges: prev })) forceRender((v) => v + 1);
      return next;
    });
  }, [stack]);

  const undo = useCallback(() => {
    const snap = stack.undo({ nodes: nodesRef.current, edges: edgesRef.current });
    if (!snap) return;
    setNodesState(snap.nodes);
    setEdgesState(snap.edges);
    forceRender((v) => v + 1);
  }, [stack]);

  const redo = useCallback(() => {
    const snap = stack.redo({ nodes: nodesRef.current, edges: edgesRef.current });
    if (!snap) return;
    setNodesState(snap.nodes);
    setEdgesState(snap.edges);
    forceRender((v) => v + 1);
  }, [stack]);

  const breakCoalescing = useCallback(() => stack.breakCoalescing(), [stack]);

  return {
    nodes, edges, setNodes, setEdges, undo, redo,
    canUndo: stack.canUndo,
    canRedo: stack.canRedo,
    breakCoalescing,
  };
}
