/**
 * useCustomCalc — store pentru grafurile de calcul EDITABILE (Faza 3B).
 * Sursă unică de adevăr pentru nodurile/muchiile grafului; editorul React Flow
 * derivă din el și scrie înapoi prin acțiuni. Serializabil pentru `.bbim`.
 */
import { create } from 'zustand';
import type {
  CustomCalcGraph,
  CustomCalcNode,
  CustomCalcNodeKind,
} from '@/lib/quantityTakeoff';

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function defaultsForKind(kind: CustomCalcNodeKind): Partial<CustomCalcNode> {
  switch (kind) {
    case 'param': return { measureKey: 'volume_m3', label: 'Parametru' };
    case 'const': return { value: 1 };
    case 'op': return { op: 'mul' };
    case 'result': return { unit: 'mc', label: 'Rezultat' };
  }
}

function newGraph(name: string): CustomCalcGraph {
  const rid = uid('n');
  return {
    id: uid('graph'),
    name,
    nodes: [{ id: rid, kind: 'result', position: { x: 520, y: 160 }, unit: 'mc', label: 'Rezultat' }],
    edges: [],
  };
}

interface CustomCalcStore {
  graphs: Record<string, CustomCalcGraph>;
  currentId: string | null;
  /** Nodul din graful BIM folosit pentru preview-ul live al valorilor. */
  previewNodeId: string | null;

  createGraph: (name?: string) => string;
  deleteGraph: (id: string) => void;
  setCurrent: (id: string | null) => void;
  renameGraph: (id: string, name: string) => void;
  setPreviewNode: (nodeId: string | null) => void;

  addNode: (kind: CustomCalcNodeKind, position: { x: number; y: number }) => string;
  updateNode: (id: string, patch: Partial<CustomCalcNode>) => void;
  removeNode: (id: string) => void;
  moveNode: (id: string, position: { x: number; y: number }) => void;
  addEdge: (source: string, target: string, targetHandle?: string | null) => void;
  removeEdge: (id: string) => void;

  current: () => CustomCalcGraph | null;
}

export const useCustomCalc = create<CustomCalcStore>()((set, get) => {
  const patchCurrent = (fn: (g: CustomCalcGraph) => CustomCalcGraph) =>
    set((s) => {
      const id = s.currentId;
      if (!id || !s.graphs[id]) return s;
      return { graphs: { ...s.graphs, [id]: fn(s.graphs[id]) } };
    });

  return {
    graphs: {},
    currentId: null,
    previewNodeId: null,

    createGraph: (name = 'Calcul nou') => {
      const g = newGraph(name);
      set((s) => ({ graphs: { ...s.graphs, [g.id]: g }, currentId: g.id }));
      return g.id;
    },
    deleteGraph: (id) =>
      set((s) => {
        const { [id]: _drop, ...rest } = s.graphs;
        return { graphs: rest, currentId: s.currentId === id ? null : s.currentId };
      }),
    setCurrent: (id) => set({ currentId: id }),
    renameGraph: (id, name) =>
      set((s) => (s.graphs[id] ? { graphs: { ...s.graphs, [id]: { ...s.graphs[id], name } } } : s)),
    setPreviewNode: (nodeId) => set({ previewNodeId: nodeId }),

    addNode: (kind, position) => {
      const id = uid('n');
      const node: CustomCalcNode = { id, kind, position, ...defaultsForKind(kind) };
      patchCurrent((g) => ({ ...g, nodes: [...g.nodes, node] }));
      return id;
    },
    updateNode: (id, patch) =>
      patchCurrent((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) })),
    removeNode: (id) =>
      patchCurrent((g) => ({
        ...g,
        nodes: g.nodes.filter((n) => n.id !== id),
        edges: g.edges.filter((e) => e.source !== id && e.target !== id),
      })),
    moveNode: (id, position) =>
      patchCurrent((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, position } : n)) })),
    addEdge: (source, target, targetHandle) =>
      patchCurrent((g) => {
        if (source === target) return g;
        if (g.edges.some((e) => e.source === source && e.target === target && e.targetHandle === (targetHandle ?? null))) return g;
        return { ...g, edges: [...g.edges, { id: uid('e'), source, target, targetHandle: targetHandle ?? null }] };
      }),
    removeEdge: (id) => patchCurrent((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) })),

    current: () => {
      const { graphs, currentId } = get();
      return currentId ? graphs[currentId] ?? null : null;
    },
  };
});

// ─── Persistență (.bbim) ──────────────────────────────────────────────────────

export interface CustomCalcPersist {
  graphs: Record<string, CustomCalcGraph>;
  currentId: string | null;
}

/** Extrage starea serializabilă (fără `previewNodeId`, care e runtime). */
export function exportCustomCalc(): CustomCalcPersist {
  const { graphs, currentId } = useCustomCalc.getState();
  return { graphs, currentId };
}

/** Reîncarcă grafurile custom dintr-un proiect salvat. */
export function importCustomCalc(data: CustomCalcPersist | undefined): void {
  useCustomCalc.setState({
    graphs: data?.graphs ?? {},
    currentId: data?.currentId ?? null,
    previewNodeId: null,
  });
}
