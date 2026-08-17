import {
  type SvgSymbolDef,
  type SvgSymNode,
  type SvgSymEdge,
  type SlProps,
  type SaProps,
  type ShProps,
  symId,
  symbolKey,
} from '@/lib/svgSymbolStore';
import {
  type SimpleSymbolEdits,
  DEFAULT_WINDOW_EDITS,
  DEFAULT_DOOR_EDITS,
} from './types';

// ─── Node builders ────────────────────────────────────────────────────────────

export function mkSp(x: string | number, y: string | number, label = 'P'): SvgSymNode {
  const id = symId('sp');
  return {
    id, type: 'sp', label, cx: 0, cy: 0,
    props: { x_mm: x, y_mm: y },
  };
}

export function mkSl(
  a: SvgSymNode, b: SvgSymNode,
  stroke = '#222222', weight = 2, dash = false,
): { node: SvgSymNode; edges: SvgSymEdge[] } {
  const id = symId('sl');
  return {
    node: {
      id, type: 'sl', label: 'Line', cx: 0, cy: 0,
      props: { stroke, weight, dash, linecap: 'square' } satisfies SlProps,
    },
    edges: [
      { id: symId('e'), from: id, to: a.id, type: 'ref' },
      { id: symId('e'), from: id, to: b.id, type: 'ref' },
    ],
  };
}

export function mkSa(
  cx: string | number, cy: string | number, r: string | number,
  a0: number, a1: number,
  stroke = '#555555', weight = 1.5, clockwise = false,
): SvgSymNode {
  const id = symId('sa');
  return {
    id, type: 'sa', label: 'Arc', cx: 0, cy: 0,
    props: { cx_mm: cx, cy_mm: cy, r_mm: r, a0, a1, stroke, weight, clockwise } satisfies SaProps,
  };
}

export function mkSh(
  points: SvgSymNode[],
  fill = '#ffffff', opacity = 1, pattern: ShProps['pattern'] = 'solid',
  stroke?: string, weight?: number,
): { node: SvgSymNode; edges: SvgSymEdge[] } {
  const id = symId('sh');
  return {
    node: {
      id, type: 'sh', label: 'Fill', cx: 0, cy: 0,
      props: {
        fill_color: fill, fill_opacity: opacity, pattern,
        stroke, weight,
      } satisfies ShProps,
    },
    edges: points.map((p, i) => ({
      id: symId('e'), from: id, to: p.id, type: 'poly' as const, order: i,
    })),
  };
}

export function assembleDef(
  elementType: 'window' | 'door',
  typeKey: string,
  viewType: 'floorplan',
  name: string,
  parts: { nodes: SvgSymNode[]; edges: SvgSymEdge[] },
): SvgSymbolDef {
  return {
    id: symbolKey(elementType, typeKey, viewType),
    name,
    elementType,
    typeKey,
    viewType,
    nodes: parts.nodes,
    edges: parts.edges,
    updatedAt: Date.now(),
  };
}

// ─── Apply simple edits to a compiled template ────────────────────────────────

export function applySimpleEdits(
  def: SvgSymbolDef,
  edits: SimpleSymbolEdits,
  _elementType: 'window' | 'door',
): SvgSymbolDef {
  const nodes = def.nodes.map((n) => {
    switch (n.type) {
      case 'sl': {
        const p = { ...n.props } as unknown as SlProps;
        const isGlass = n.label === 'Glass';
        const isBreak = n.label === 'Break';
        const isPanel = n.label === 'Panel';
        if (isGlass) {
          p.stroke = edits.glassColor;
          p.weight = edits.seenLineWeight;
        } else if (isBreak) {
          p.stroke = edits.breakLineColor;
          p.weight = edits.breakLineWeight;
        } else if (isPanel) {
          p.stroke = edits.frameColor;
          p.weight = edits.panelLineWeight;
        } else {
          p.stroke = edits.frameColor;
          p.weight = edits.frameLineWeight;
        }
        return { ...n, props: p };
      }
      case 'sa': {
        const p = { ...n.props } as unknown as SaProps;
        p.stroke = edits.arcColor;
        p.weight = edits.arcLineWeight;
        return { ...n, props: p };
      }
      case 'sh': {
        const p = { ...n.props } as unknown as ShProps;
        if (n.label === 'Sill') {
          p.fill_color = edits.sillFillColor;
          if (!edits.showSillZone) return null;
        }
        if (n.label === 'Mask' && !edits.showWhiteMask) return null;
        if (n.label === 'SqL' || n.label === 'SqR') {
          if (!edits.showFrameSquares) return null;
        }
        return { ...n, props: p };
      }
      default:
        return n;
    }
  }).filter((n): n is SvgSymNode => n !== null);

  // Filter edges for removed nodes
  const nodeIds = new Set(nodes.map((n) => n.id));
  let edges = def.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  // Toggle glass lines
  if (!edits.showGlassPanel) {
    const glassIds = new Set(def.nodes.filter((n) => n.label === 'Glass').map((n) => n.id));
    const filtered = nodes.filter((n) => !glassIds.has(n.id));
    edges = edges.filter((e) => !glassIds.has(e.from) && !glassIds.has(e.to));
    return { ...def, nodes: filtered, edges, updatedAt: Date.now() };
  }

  // Toggle swing arc
  if (!edits.showSwingArc) {
    const arcIds = new Set(def.nodes.filter((n) => n.type === 'sa').map((n) => n.id));
    return {
      ...def,
      nodes: nodes.filter((n) => !arcIds.has(n.id)),
      edges: edges.filter((e) => !arcIds.has(e.from)),
      updatedAt: Date.now(),
    };
  }

  // Toggle door panel lines
  if (!edits.showDoorPanel) {
    const panelIds = new Set(def.nodes.filter((n) => n.label === 'Panel').map((n) => n.id));
    return {
      ...def,
      nodes: nodes.filter((n) => !panelIds.has(n.id)),
      edges: edges.filter((e) => !panelIds.has(e.from)),
      updatedAt: Date.now(),
    };
  }

  // Toggle wall breaks
  if (!edits.showWallBreaks) {
    const breakIds = new Set(def.nodes.filter((n) => n.label === 'Break').map((n) => n.id));
    return {
      ...def,
      nodes: nodes.filter((n) => !breakIds.has(n.id)),
      edges: edges.filter((e) => !breakIds.has(e.from)),
      updatedAt: Date.now(),
    };
  }

  return { ...def, nodes, edges, updatedAt: Date.now() };
}

export function defaultEditsFor(elementType: 'window' | 'door'): SimpleSymbolEdits {
  return elementType === 'window'
    ? { ...DEFAULT_WINDOW_EDITS }
    : { ...DEFAULT_DOOR_EDITS };
}

export function compileTemplate(
  templateBuild: (typeKey: string, name: string) => SvgSymbolDef,
  typeKey: string,
  name: string,
  edits: SimpleSymbolEdits,
  elementType: 'window' | 'door',
): SvgSymbolDef {
  const base = templateBuild(typeKey, name);
  return applySimpleEdits(base, edits, elementType);
}
