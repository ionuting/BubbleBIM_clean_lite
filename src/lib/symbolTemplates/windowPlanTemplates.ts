import type { SvgSymNode, SvgSymEdge } from '@/lib/svgSymbolStore';
import { assembleDef, mkSp, mkSl, mkSh } from './templateCompiler';
import type { SymbolTemplate } from './types';

const INNER_Y = 'outer_off + inner_off';
const SILL_Y = 'outer_off + inner_off + sill_proj';
const SQ = 'sq / 2';

function frameSquare(cx: string, cy: string): { nodes: SvgSymNode[]; edges: SvgSymEdge[]; fill: SvgSymNode } {
  const p0 = mkSp(`(${cx}) - ${SQ}`, `(${cy}) - ${SQ}`, 'sq');
  const p1 = mkSp(`(${cx}) + ${SQ}`, `(${cy}) - ${SQ}`, 'sq');
  const p2 = mkSp(`(${cx}) + ${SQ}`, `(${cy}) + ${SQ}`, 'sq');
  const p3 = mkSp(`(${cx}) - ${SQ}`, `(${cy}) + ${SQ}`, 'sq');
  const { node, edges } = mkSh([p0, p1, p2, p3], '#ffffff', 1, 'solid', '#222222', 2);
  node.label = cx === '0' ? 'SqL' : 'SqR';
  return { nodes: [p0, p1, p2, p3, node], edges, fill: node };
}

function buildFixed(typeKey: string, name: string) {
  const nodes: SvgSymNode[] = [];
  const edges: SvgSymEdge[] = [];

  const m0 = mkSp('0', '0');
  const m1 = mkSp('W', '0');
  const m2 = mkSp('W', INNER_Y);
  const m3 = mkSp('0', INNER_Y);
  const mask = mkSh([m0, m1, m2, m3], '#ffffff', 1);
  mask.node.label = 'Mask';
  nodes.push(m0, m1, m2, m3, mask.node);
  edges.push(...mask.edges);

  const o0 = mkSp('0', '0');
  const o1 = mkSp('W', '0');
  const outer = mkSl(o0, o1);
  outer.node.label = 'Frame';
  nodes.push(o0, o1, outer.node);
  edges.push(...outer.edges);

  const i0 = mkSp('0', INNER_Y);
  const i1 = mkSp('W', INNER_Y);
  const inner = mkSl(i0, i1);
  inner.node.label = 'Frame';
  nodes.push(i0, i1, inner.node);
  edges.push(...inner.edges);

  const sqL = frameSquare('0', '0');
  const sqR = frameSquare('W', '0');
  nodes.push(...sqL.nodes, ...sqR.nodes);
  edges.push(...sqL.edges, ...sqR.edges);

  const g0 = mkSp('0', 'gw');
  const g1 = mkSp('W', 'gw');
  const g0b = mkSp('0', '-gw');
  const g1b = mkSp('W', '-gw');
  const gTop = mkSl(g0, g1, '#5588AA', 1);
  gTop.node.label = 'Glass';
  const gBot = mkSl(g0b, g1b, '#5588AA', 1);
  gBot.node.label = 'Glass';
  const gMid0 = mkSp('W/2', 'gw');
  const gMid1 = mkSp('W/2', '-gw');
  const gMid = mkSl(gMid0, gMid1, '#5588AA', 1);
  gMid.node.label = 'Glass';
  nodes.push(g0, g1, g0b, g1b, gTop.node, gBot.node, gMid0, gMid1, gMid.node);
  edges.push(...gTop.edges, ...gBot.edges, ...gMid.edges);

  const s0 = mkSp('0', INNER_Y);
  const s1 = mkSp('W', INNER_Y);
  const s2 = mkSp('W', SILL_Y);
  const s3 = mkSp('0', SILL_Y);
  const sill = mkSh([s0, s1, s2, s3], '#D0D0C4', 0.55, 'solid', '#888888', 1);
  sill.node.label = 'Sill';
  nodes.push(s0, s1, s2, s3, sill.node);
  edges.push(...sill.edges);

  return assembleDef('window', typeKey, 'floorplan', name, { nodes, edges });
}

function buildCasement(typeKey: string, name: string, double: boolean) {
  const def = buildFixed(typeKey, name);
  const nodes = [...def.nodes];
  const edges = [...def.edges];

  if (double) {
    const c0 = mkSp('W/2', '0');
    const c1 = mkSp('W/2', INNER_Y);
    const center = mkSl(c0, c1, '#222222', 2);
    center.node.label = 'Frame';
    nodes.push(c0, c1, center.node);
    edges.push(...center.edges);

    const a0 = mkSp('W*0.25', 'gw*2');
    const a1 = mkSp('W*0.25', 'gw*4');
    const indL = mkSl(a0, a1, '#5588AA', 1, true);
    indL.node.label = 'Glass';
    const b0 = mkSp('W*0.75', 'gw*2');
    const b1 = mkSp('W*0.75', 'gw*4');
    const indR = mkSl(b0, b1, '#5588AA', 1, true);
    indR.node.label = 'Glass';
    nodes.push(a0, a1, indL.node, b0, b1, indR.node);
    edges.push(...indL.edges, ...indR.edges);
  } else {
    const a0 = mkSp('W*0.5', 'gw*2');
    const a1 = mkSp('W*0.5', 'gw*4');
    const ind = mkSl(a0, a1, '#5588AA', 1, true);
    ind.node.label = 'Glass';
    nodes.push(a0, a1, ind.node);
    edges.push(...ind.edges);
  }

  return { ...def, nodes, edges, updatedAt: Date.now() };
}

function buildOpeningGap(typeKey: string, name: string) {
  const nodes: SvgSymNode[] = [];
  const edges: SvgSymEdge[] = [];

  const m0 = mkSp('0', '0');
  const m1 = mkSp('W', '0');
  const m2 = mkSp('W', INNER_Y);
  const m3 = mkSp('0', INNER_Y);
  const mask = mkSh([m0, m1, m2, m3], '#ffffff', 1);
  mask.node.label = 'Mask';
  nodes.push(m0, m1, m2, m3, mask.node);
  edges.push(...mask.edges);

  const b0 = mkSp('0', '0');
  const b1 = mkSp('0', INNER_Y);
  const b2 = mkSp('W', INNER_Y);
  const b3 = mkSp('W', '0');
  for (const [a, b] of [[b0, b1], [b2, b3]] as const) {
    const br = mkSl(a, b, '#222222', 2);
    br.node.label = 'Break';
    nodes.push(a, b, br.node);
    edges.push(...br.edges);
  }

  return assembleDef('window', typeKey, 'floorplan', name, { nodes, edges });
}

function buildTiltTurn(typeKey: string, name: string) {
  const def = buildCasement(typeKey, name, false);
  const nodes = [...def.nodes];
  const edges = [...def.edges];

  const cx = mkSp('W/2', 'gw*3');
  const cy = mkSp('W/2', 'gw*5');
  const tilt = mkSl(cx, cy, '#5588AA', 1, true);
  tilt.node.label = 'Glass';
  const hx = mkSp('W*0.35', 'gw*3');
  const hy = mkSp('W*0.65', 'gw*3');
  const hinge = mkSl(hx, hy, '#5588AA', 1);
  hinge.node.label = 'Glass';
  nodes.push(cx, cy, tilt.node, hx, hy, hinge.node);
  edges.push(...tilt.edges, ...hinge.edges);

  return { ...def, nodes, edges, updatedAt: Date.now() };
}

export const WINDOW_PLAN_TEMPLATES: SymbolTemplate[] = [
  {
    id: 'fixed',
    name: 'Fixed glazing',
    description: 'Two parallel frame lines with corner squares and sill zone',
    families: ['none', 'single', 'double', 'tilt-turn'],
    build: (k, n) => buildFixed(k, n),
  },
  {
    id: 'casement-single',
    name: 'Single casement',
    description: 'Fixed frame plus opening indicator line',
    families: ['single', 'tilt-turn'],
    build: (k, n) => buildCasement(k, n, false),
  },
  {
    id: 'casement-double',
    name: 'Double casement',
    description: 'Centre mullion with two opening indicators',
    families: ['double'],
    build: (k, n) => buildCasement(k, n, true),
  },
  {
    id: 'tilt-turn',
    name: 'Tilt-turn',
    description: 'Combined tilt and side-hung indicators',
    families: ['tilt-turn'],
    build: (k, n) => buildTiltTurn(k, n),
  },
  {
    id: 'opening-gap',
    name: 'Wall opening',
    description: 'Simple wall break without frame detail',
    families: ['none', 'single', 'double', 'tilt-turn'],
    build: (k, n) => buildOpeningGap(k, n),
  },
];

export function pickWindowTemplate(family: string): SymbolTemplate {
  return WINDOW_PLAN_TEMPLATES.find((t) => t.families.includes(family))
    ?? WINDOW_PLAN_TEMPLATES[0];
}
