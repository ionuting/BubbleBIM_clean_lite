import type { SvgSymNode, SvgSymEdge } from '@/lib/svgSymbolStore';
import { assembleDef, mkSp, mkSl, mkSh, mkSa } from './templateCompiler';
import type { SymbolTemplate } from './types';

/** Wall centre Y in door symbol space (outer face y=0, inner face y=T). */
const CY = 'T / 2';

function wallMask(): { nodes: SvgSymNode[]; edges: SvgSymEdge[] } {
  const p0 = mkSp('0', '0');
  const p1 = mkSp('W', '0');
  const p2 = mkSp('W', 'T');
  const p3 = mkSp('0', 'T');
  const mask = mkSh([p0, p1, p2, p3], '#ffffff', 1);
  mask.node.label = 'Mask';
  return { nodes: [p0, p1, p2, p3, mask.node], edges: mask.edges };
}

function wallBreaks(): { nodes: SvgSymNode[]; edges: SvgSymEdge[] } {
  const nodes: SvgSymNode[] = [];
  const edges: SvgSymEdge[] = [];
  for (const x of ['0', 'W'] as const) {
    const a = mkSp(x, '0');
    const b = mkSp(x, 'T');
    const br = mkSl(a, b, '#222222', 1);
    br.node.label = 'Break';
    nodes.push(a, b, br.node);
    edges.push(...br.edges);
  }
  return { nodes, edges };
}

function headerLine(): { nodes: SvgSymNode[]; edges: SvgSymEdge[] } {
  const a = mkSp('0', '0');
  const b = mkSp('W', '0');
  const ln = mkSl(a, b, '#111111', 2.4);
  ln.node.label = 'Frame';
  return { nodes: [a, b, ln.node], edges: ln.edges };
}

function swingLeft(typeKey: string, name: string) {
  const nodes: SvgSymNode[] = [];
  const edges: SvgSymEdge[] = [];

  const mask = wallMask();
  nodes.push(...mask.nodes);
  edges.push(...mask.edges);

  const br = wallBreaks();
  nodes.push(...br.nodes);
  edges.push(...br.edges);

  const hdr = headerLine();
  nodes.push(...hdr.nodes);
  edges.push(...hdr.edges);

  const hinge = mkSp('0', CY);
  const tip = mkSp('0', `${CY} - W`);
  const closed = mkSp('W', CY);
  const panel = mkSl(hinge, tip, '#111111', 2);
  panel.node.label = 'Panel';
  const arc = mkSa('0', CY, 'W', 270, 0, '#555555', 1, false);
  nodes.push(hinge, tip, closed, panel.node, arc);
  edges.push(...panel.edges);

  return assembleDef('door', typeKey, 'floorplan', name, { nodes, edges });
}

function swingRight(typeKey: string, name: string) {
  const nodes: SvgSymNode[] = [];
  const edges: SvgSymEdge[] = [];

  const mask = wallMask();
  nodes.push(...mask.nodes);
  edges.push(...mask.edges);

  const br = wallBreaks();
  nodes.push(...br.nodes);
  edges.push(...br.edges);

  const hdr = headerLine();
  nodes.push(...hdr.nodes);
  edges.push(...hdr.edges);

  const hinge = mkSp('W', CY);
  const tip = mkSp('W', `${CY} - W`);
  const closed = mkSp('0', CY);
  const panel = mkSl(hinge, tip, '#111111', 2);
  panel.node.label = 'Panel';
  const arc = mkSa('W', CY, 'W', 270, 180, '#555555', 1, true);
  nodes.push(hinge, tip, closed, panel.node, arc);
  edges.push(...panel.edges);

  return assembleDef('door', typeKey, 'floorplan', name, { nodes, edges });
}

function swingDouble(typeKey: string, name: string) {
  const nodes: SvgSymNode[] = [];
  const edges: SvgSymEdge[] = [];

  const mask = wallMask();
  nodes.push(...mask.nodes);
  edges.push(...mask.edges);

  const br = wallBreaks();
  nodes.push(...br.nodes);
  edges.push(...br.edges);

  const hdr = headerLine();
  nodes.push(...hdr.nodes);
  edges.push(...hdr.edges);

  const hL = mkSp('0', CY);
  const tL = mkSp('0', `${CY} - W/2`);
  const pL = mkSl(hL, tL, '#111111', 2);
  pL.node.label = 'Panel';
  const arcL = mkSa('0', CY, 'W/2', 270, 0, '#555555', 1, false);

  const hR = mkSp('W', CY);
  const tR = mkSp('W', `${CY} - W/2`);
  const pR = mkSl(hR, tR, '#111111', 2);
  pR.node.label = 'Panel';
  const arcR = mkSa('W', CY, 'W/2', 270, 180, '#555555', 1, true);

  nodes.push(hL, tL, pL.node, arcL, hR, tR, pR.node, arcR);
  edges.push(...pL.edges, ...pR.edges);

  return assembleDef('door', typeKey, 'floorplan', name, { nodes, edges });
}

function sliding(typeKey: string, name: string) {
  const nodes: SvgSymNode[] = [];
  const edges: SvgSymEdge[] = [];

  const mask = wallMask();
  nodes.push(...mask.nodes);
  edges.push(...mask.edges);

  const br = wallBreaks();
  nodes.push(...br.nodes);
  edges.push(...br.edges);

  const hdr = headerLine();
  nodes.push(...hdr.nodes);
  edges.push(...hdr.edges);

  const y = 'T * 0.65';
  const p0 = mkSp('0', y);
  const p1 = mkSp('W', y);
  const panel = mkSl(p0, p1, '#111111', 2, true);
  panel.node.label = 'Panel';
  nodes.push(p0, p1, panel.node);
  edges.push(...panel.edges);

  const a0 = mkSp('W * 0.2', CY);
  const a1 = mkSp('W * 0.8', CY);
  const arrow = mkSl(a0, a1, '#555555', 1.5, true);
  arrow.node.label = 'Glass';
  nodes.push(a0, a1, arrow.node);
  edges.push(...arrow.edges);

  return assembleDef('door', typeKey, 'floorplan', name, { nodes, edges });
}

function fixedGap(typeKey: string, name: string) {
  const nodes: SvgSymNode[] = [];
  const edges: SvgSymEdge[] = [];

  const mask = wallMask();
  nodes.push(...mask.nodes);
  edges.push(...mask.edges);

  const br = wallBreaks();
  nodes.push(...br.nodes);
  edges.push(...br.edges);

  const hdr = headerLine();
  nodes.push(...hdr.nodes);
  edges.push(...hdr.edges);

  return assembleDef('door', typeKey, 'floorplan', name, { nodes, edges });
}

export const DOOR_PLAN_TEMPLATES: SymbolTemplate[] = [
  {
    id: 'swing-left',
    name: 'Swing left',
    description: 'Panel and 90° arc hinged at left jamb',
    families: ['left'],
    build: swingLeft,
  },
  {
    id: 'swing-right',
    name: 'Swing right',
    description: 'Panel and 90° arc hinged at right jamb',
    families: ['right'],
    build: swingRight,
  },
  {
    id: 'swing-double',
    name: 'Double swing',
    description: 'Two opposing leaves with arcs',
    families: ['double'],
    build: swingDouble,
  },
  {
    id: 'sliding',
    name: 'Sliding',
    description: 'Dashed panel line with direction arrow',
    families: ['sliding'],
    build: sliding,
  },
  {
    id: 'fixed-gap',
    name: 'Fixed opening',
    description: 'Wall break and header only (no swing)',
    families: ['left', 'right', 'double', 'sliding', 'folding'],
    build: fixedGap,
  },
];

export function pickDoorTemplate(family: string): SymbolTemplate {
  return DOOR_PLAN_TEMPLATES.find((t) => t.families.includes(family))
    ?? DOOR_PLAN_TEMPLATES[0];
}
