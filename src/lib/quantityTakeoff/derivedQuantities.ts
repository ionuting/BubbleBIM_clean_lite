/**
 * derivedQuantities.ts — the quantities a node HAS, kept on the node.
 *
 * A node's lengths, areas and volume are consequences of its geometry, not
 * inputs: nobody types them, and a typed one would be wrong the moment an
 * axis moved. So they are derived — from `measureNode`, the same source the
 * takeoff prices from — and written as read-only `q_*` properties at the
 * moment the project leaves the app (save, `.bbim`, HTML export). What lands
 * on disk, or in another tool, then carries its quantities with it.
 *
 * They are never written into the live store: that would turn every edit
 * into a second edit, and an undo step into two. Inside the app they are
 * computed on demand, and the stored ones are only ever a snapshot.
 *
 * Two kinds:
 *  - the takeoff's measures, for every measurable node — totals, the array
 *    copies included, as the takeoff counts them;
 *  - for a sketch, what the drawing itself is — the curve's own length, the
 *    outline's area, the extrusion height, the profile's area, the lateral
 *    surface — for ONE copy, so a formula can be written against the shape.
 *
 * The same names are the variables a formula may use (`q_area_m2 * 0.2`).
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { calcWallJoins } from '@/lib/bimGeometry';
import { computeSketch, outlineArea } from '@/lib/sketch';
import { facePerimeter } from '@/lib/geom/faceWithHoles';
import type { NodeMeasures } from '@/lib/norms/types';
import { createMeasureMemo, measureNodeMemo, type MeasureMemo } from './geometryMeasures';

/** Every derived key starts with this — and no key a user types may. */
export const DERIVED_PREFIX = 'q_';
export const isDerivedKey = (k: string): boolean => k.startsWith(DERIVED_PREFIX);

export interface DerivedQuantity {
  /** Property key and formula variable, `q_…`. */
  key: string;
  label: string;
  unit: string;
  value: number;
}

/** The takeoff's measures worth carrying, in the order a reader wants them. */
const MEASURE_KEYS: { m: keyof NodeMeasures; label: string; unit: string }[] = [
  { m: 'length_m', label: 'Lungime', unit: 'm' },
  { m: 'height_m', label: 'Înălțime', unit: 'm' },
  { m: 'width_m', label: 'Lățime', unit: 'm' },
  { m: 'thickness_m', label: 'Grosime', unit: 'm' },
  { m: 'perimeter_m', label: 'Perimetru', unit: 'm' },
  { m: 'area_m2', label: 'Arie', unit: 'm²' },
  { m: 'gross_area_m2', label: 'Arie brută', unit: 'm²' },
  { m: 'net_area_m2', label: 'Arie netă', unit: 'm²' },
  { m: 'section_m2', label: 'Arie secțiune', unit: 'm²' },
  { m: 'opening_area_m2', label: 'Arie goluri', unit: 'm²' },
  { m: 'volume_m3', label: 'Volum', unit: 'm³' },
  { m: 'count', label: 'Bucăți', unit: 'buc' },
];

/** Rounded so a save does not churn on the last float bit. */
const tidy = (v: number): number => Math.round(v * 1e6) / 1e6 + 0;

/**
 * The derived quantities of one node, zeros left out — a wall has no profile
 * area, and listing it as 0 would say something false.
 */
export function deriveQuantities(
  node: BubbleGraphNode,
  edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
  wallJoins?: ReturnType<typeof calcWallJoins>,
  memo?: MeasureMemo,
): DerivedQuantity[] {
  const out: DerivedQuantity[] = [];
  const push = (key: string, label: string, unit: string, v: number) => {
    if (Number.isFinite(v) && Math.abs(v) > 1e-9) out.push({ key, label, unit, value: tidy(v) });
  };

  let measures: NodeMeasures | null = null;
  try {
    measures = measureNodeMemo(memo, node, edges, nodeMap, wallJoins);
  } catch {
    measures = null;
  }
  if (measures) {
    for (const { m, label, unit } of MEASURE_KEYS) push(`${DERIVED_PREFIX}${m}`, label, unit, measures[m] as number);
  }

  if (node.type === 'sketch') {
    try {
      const res = computeSketch(node, nodeMap, edges);
      const { op, closed, outline, heightMm, holeOf } = res.intent;
      if (!holeOf) {
        push('q_outline_length_m', op === 'sweep' || !closed ? 'Lungime traseu (1 buc)' : 'Lungime contur (1 buc)', 'm', res.lengthMm / 1000);
        push('q_outline_area_m2', 'Arie contur de bază (1 buc)', 'm²', outlineArea(outline, closed) / 1e6);
        push('q_holes', 'Goluri', 'buc', res.holeIds.length);
        if (op === 'extrude') {
          push('q_extrude_height_m', 'Înălțime extrudare', 'm', Math.abs(heightMm) / 1000);
          // Every boundary, holes included, run up the height.
          push('q_lateral_area_m2', 'Suprafață laterală (1 buc)', 'm²', (res.perimeterMm * Math.abs(heightMm)) / 1e6);
        } else if (op === 'sweep' && res.placed) {
          push('q_profile_area_m2', 'Arie profil', 'm²', res.profileAreaMm2 / 1e6);
          const profilePerimeter = facePerimeter(res.placed, res.profileHoles);
          push('q_lateral_area_m2', 'Suprafață laterală (1 buc)', 'm²', (profilePerimeter * res.lengthMm) / 1e6);
        }
      }
    } catch {
      /* a sketch that cannot be read has nothing to report */
    }
  }
  return out;
}

/** The quantities as formula variables — `{ q_area_m2: 12.5, … }`. */
export function quantityVars(qs: DerivedQuantity[]): Record<string, number> {
  return Object.fromEntries(qs.map((q) => [q.key, q.value]));
}

// One memo for every save: a node object unchanged since the last save is
// not measured again (the memo is keyed by node identity).
const saveMemo: MeasureMemo = createMeasureMemo();

/**
 * The nodes with their `q_*` properties rewritten from the current geometry —
 * stale ones removed, a node whose quantities did not change returned as the
 * very same object. Never throws: a save must not fail over a measure.
 */
export function stampDerivedQuantities(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]): BubbleGraphNode[] {
  let joins: ReturnType<typeof calcWallJoins> | undefined;
  try {
    joins = calcWallJoins(nodes, edges);
  } catch {
    joins = undefined;
  }
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return nodes.map((n) => {
    let qs: DerivedQuantity[] = [];
    try {
      qs = deriveQuantities(n, edges, nodeMap, joins, saveMemo);
    } catch {
      qs = [];
    }
    const kept = Object.entries(n.properties ?? {}).filter(([k]) => !isDerivedKey(k));
    const had = Object.entries(n.properties ?? {}).filter(([k]) => isDerivedKey(k));
    const same = had.length === qs.length && qs.every((q) => n.properties[q.key] === q.value);
    if (same) return n;
    return { ...n, properties: { ...Object.fromEntries(kept), ...quantityVars(qs) } };
  });
}
