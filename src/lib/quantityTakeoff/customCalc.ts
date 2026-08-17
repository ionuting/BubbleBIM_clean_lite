/**
 * customCalc.ts — graf de calcul EDITABIL (Faza 3B). Permite inginerului să
 * compună o cantitate din parametrii geometrici ai elementelor:
 *  - parametri DIRECȚI (noduri `param` → o cheie din `NodeMeasures`)
 *  - constante (noduri `const`)
 *  - parametri CUSTOM / CALCULAȚI (noduri `op`: +, −, ×, ÷ sau formulă liberă)
 *  - rezultat (nod `result`)
 *
 * Evaluatorul e pur și testabil; nu depinde de UI. Se evaluează pe măsurile unui
 * element concret (`NodeMeasures`), obținute cu `measuresForNode`.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import type { NodeMeasures } from '@/lib/norms';
import { calcWallJoins } from '@/lib/bimGeometry';
import { measureNode } from './geometryMeasures';

/** Parametrii geometrici DIRECȚI disponibili (cheie → etichetă + unitate). */
export const MEASURE_OPTIONS: { key: keyof NodeMeasures; label: string; unit: string }[] = [
  { key: 'length_m', label: 'Lungime', unit: 'm' },
  { key: 'height_m', label: 'Înălțime', unit: 'm' },
  { key: 'thickness_m', label: 'Grosime', unit: 'm' },
  { key: 'width_m', label: 'Lățime', unit: 'm' },
  { key: 'depth_m', label: 'Adâncime', unit: 'm' },
  { key: 'gross_area_m2', label: 'Arie brută', unit: 'm²' },
  { key: 'net_area_m2', label: 'Arie netă', unit: 'm²' },
  { key: 'area_m2', label: 'Arie', unit: 'm²' },
  { key: 'perimeter_m', label: 'Perimetru', unit: 'm' },
  { key: 'section_m2', label: 'Arie secțiune', unit: 'm²' },
  { key: 'volume_m3', label: 'Volum', unit: 'm³' },
  { key: 'count', label: 'Număr', unit: 'buc' },
  { key: 'opening_area_m2', label: 'Arie goluri', unit: 'm²' },
];

export type CustomCalcNodeKind = 'param' | 'const' | 'op' | 'result';
export type CustomOp = 'add' | 'sub' | 'mul' | 'div' | 'formula';

export interface CustomCalcNode {
  id: string;
  kind: CustomCalcNodeKind;
  position: { x: number; y: number };
  /** param: cheia mărimii geometrice directe. */
  measureKey?: keyof NodeMeasures;
  /** const: valoarea literală. */
  value?: number;
  /** op: operatorul sau 'formula'. */
  op?: CustomOp;
  /** op='formula': expresie cu variabile a, b, c, … (în ordinea intrărilor). */
  formula?: string;
  /** etichetă (param/result). */
  label?: string;
  /** result: unitatea afișată. */
  unit?: string;
}

export interface CustomCalcEdge {
  id: string;
  source: string;
  target: string;
  /** slot de intrare pe target (ordonează intrările pentru sub/div/formulă). */
  targetHandle?: string | null;
}

export interface CustomCalcGraph {
  id: string;
  name: string;
  /** Restrânge la ce elemente se aplică (opțional). */
  appliesTo?: { nodeType?: string; elementTypeId?: string };
  nodes: CustomCalcNode[];
  edges: CustomCalcEdge[];
}

export interface CustomCalcEvalResult {
  /** Valoarea nodului `result` (0 dacă lipsește). */
  value: number;
  /** Valoarea calculată la fiecare nod (pentru afișare live pe canvas). */
  byNode: Record<string, number>;
  errors: string[];
}

/** Măsurile geometrice ale unui singur element din graf. */
export function measuresForNode(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  nodeId: string,
): NodeMeasures | null {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const node = nodeMap.get(nodeId);
  if (!node) return null;
  const joins = calcWallJoins(nodes, edges);
  return measureNode(node, edges, nodeMap, joins);
}

const VARS = 'abcdefghij';

function evalFormulaSafe(formula: string, inputs: number[]): number {
  const names = inputs.map((_, i) => VARS[i]).filter(Boolean);
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...names, `'use strict'; return (${formula});`) as (...a: number[]) => number;
    const r = fn(...inputs.slice(0, names.length));
    return typeof r === 'number' && isFinite(r) ? r : 0;
  } catch {
    return 0;
  }
}

/** Evaluează graful pe măsurile unui element. Robust la cicluri (le tratează ca 0). */
export function evaluateCustomCalc(
  graph: CustomCalcGraph,
  measures: NodeMeasures | null,
): CustomCalcEvalResult {
  const byNode: Record<string, number> = {};
  const errors: string[] = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // Intrări per nod, ordonate după targetHandle apoi id.
  const incoming = new Map<string, CustomCalcEdge[]>();
  for (const e of graph.edges) {
    const arr = incoming.get(e.target) ?? [];
    arr.push(e);
    incoming.set(e.target, arr);
  }
  for (const arr of incoming.values()) {
    arr.sort((a, b) => String(a.targetHandle ?? '').localeCompare(String(b.targetHandle ?? '')) || a.id.localeCompare(b.id));
  }

  const visiting = new Set<string>();

  const evalNode = (id: string): number => {
    if (id in byNode) return byNode[id];
    if (visiting.has(id)) { errors.push(`Ciclu detectat la nodul ${id}`); return 0; }
    const node = nodeById.get(id);
    if (!node) return 0;
    visiting.add(id);

    const inputs = (incoming.get(id) ?? []).map((e) => evalNode(e.source));
    let v = 0;
    switch (node.kind) {
      case 'param':
        v = measures && node.measureKey ? (measures[node.measureKey] ?? 0) : 0;
        break;
      case 'const':
        v = node.value ?? 0;
        break;
      case 'op':
        v = applyOp(node.op ?? 'add', inputs, node.formula);
        break;
      case 'result':
        v = inputs.length > 0 ? inputs[0] : 0;
        break;
    }
    visiting.delete(id);
    byNode[id] = v;
    return v;
  };

  for (const n of graph.nodes) evalNode(n.id);

  const resultNode = graph.nodes.find((n) => n.kind === 'result');
  const value = resultNode ? byNode[resultNode.id] ?? 0 : 0;
  return { value, byNode, errors };
}

function applyOp(op: CustomOp, inputs: number[], formula?: string): number {
  if (inputs.length === 0 && op !== 'formula') return 0;
  switch (op) {
    case 'add': return inputs.reduce((a, b) => a + b, 0);
    case 'mul': return inputs.reduce((a, b) => a * b, 1);
    case 'sub': return inputs.slice(1).reduce((a, b) => a - b, inputs[0] ?? 0);
    case 'div': {
      const d = inputs[1] ?? 0;
      return d !== 0 ? (inputs[0] ?? 0) / d : 0;
    }
    case 'formula': return evalFormulaSafe(formula ?? '0', inputs);
    default: return 0;
  }
}
