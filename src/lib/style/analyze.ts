/**
 * analyze.ts — the building as a style rule needs to see it.
 *
 * A rule never asks "which node is at x = 5000"; it asks "which is the ground
 * floor, where does its outline run, which facade has the entrance, where is
 * the outer face of the wall, which roof covers it". This answers those from
 * the graph, with the same readers the geometry uses, so a rule placing a
 * porch against "the entrance facade" places it where the 3D view and the IFC
 * export put that facade.
 *
 * The outline is taken, in order of trust:
 *   1. the storey's envelope shell — its ax loop IS the outline, and its
 *      `contour_offset` IS the outer face;
 *   2. the storey's roof contour — the user wired it round the outline;
 *   3. the exterior walls — a wall with a room on one side only, chained.
 *
 * All plan coordinates are BIM millimetres; loops are counter-clockwise.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import {
  calcRoomPolygon, collectOpenings, getConnectedNodesWithGrips, getGripBimPos,
  getNodeWallThickness, getOrderedAnchorNodes, parseContourOffsets,
} from '@/lib/bimGeometry';
import { planPos, pointInPolygon, type Pt2 } from '@/lib/geom/plan2d';

export interface LoopVertex { id: string; p: Pt2 }

export interface FacadeDoor {
  id: string;
  /** Centre of the door, measured along the facade from its start (mm). */
  along: number;
  widthMm: number;
  heightMm: number;
}

export interface Facade {
  /** Start and end on the outline (the wall axis line), CCW. */
  a: Pt2;
  b: Pt2;
  /** Unit tangent a→b and unit outward normal. */
  t: Pt2;
  n: Pt2;
  lengthMm: number;
  wallIds: string[];
  doors: FacadeDoor[];
  /** Openings' vertical bands, relative to the storey floor — for the brâu check. */
  openingBands: [number, number][];
}

export interface StoreyInfo {
  storey: BubbleGraphNode;
  bot: number;
  top: number;
  loop: LoopVertex[];
  loopSource: 'shell' | 'roof' | 'walls';
  /** Distance from the outline to the outer face of the envelope (mm). */
  outerOffsetMm: number;
  /** Thickest wall on the storey (mm). */
  wallThicknessMm: number;
  envelopeShells: BubbleGraphNode[];
  roof: BubbleGraphNode | null;
  facades: Facade[];
}

export interface BuildingInfo {
  /** The floor the house stands on: lowest storey at or above ±0.00 with walls. */
  main: StoreyInfo | null;
  /** The storey carrying the roof (or the topmost with walls). */
  roofStorey: StoreyInfo | null;
  /** Every storey from the main one up whose outline could be read, bottom to top. */
  storeys: StoreyInfo[];
  entrance: { facade: Facade; door: FacadeDoor } | null;
  notes: string[];
}

const ENVELOPE_ROLES = new Set(['', 'envelope']);

const sub = (a: Pt2, b: Pt2): Pt2 => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Pt2, b: Pt2) => a.x * b.x + a.y * b.y;
const len = (a: Pt2) => Math.hypot(a.x, a.y);

function signedArea(pts: Pt2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return s / 2;
}

function ccw(loop: LoopVertex[]): LoopVertex[] {
  return signedArea(loop.map((v) => v.p)) < 0 ? [...loop].reverse() : loop;
}

/** Ends of a wall: the anchor node ids and their plan points at the wired grips. */
function wallEnds(w: BubbleGraphNode, edges: BubbleGraphEdge[], nodeMap: Map<string, BubbleGraphNode>) {
  const ends = getConnectedNodesWithGrips(w.id, edges, nodeMap)
    .filter(({ node }) => node.type === 'ax' || node.type === 'column');
  if (ends.length < 2) return null;
  return {
    aId: ends[0].node.id, bId: ends[1].node.id,
    a: planPos(ends[0].node, nodeMap), b: planPos(ends[1].node, nodeMap),
    ga: getGripBimPos(ends[0].node, ends[0].gripIdx, nodeMap),
    gb: getGripBimPos(ends[1].node, ends[1].gripIdx, nodeMap),
  };
}

function loopFromAnchors(owner: BubbleGraphNode, edges: BubbleGraphEdge[], nodeMap: Map<string, BubbleGraphNode>): LoopVertex[] | null {
  const anchors = getOrderedAnchorNodes(owner.id, edges, nodeMap);
  if (anchors.length < 3) return null;
  const loop = anchors.map((n) => ({ id: n.id, p: planPos(n, nodeMap) }));
  return Math.abs(signedArea(loop.map((v) => v.p))) > 1e4 ? ccw(loop) : null;
}

/** Walls with a room on exactly one side, chained end to end into a loop. */
function loopFromWalls(
  walls: BubbleGraphNode[], rooms: BubbleGraphNode[],
  edges: BubbleGraphEdge[], nodeMap: Map<string, BubbleGraphNode>,
): LoopVertex[] | null {
  const polys = rooms.map((r) => calcRoomPolygon(r, nodeMap, edges)).filter((p): p is Pt2[] => !!p && p.length >= 3);
  if (!polys.length) return null;
  const inside = (p: Pt2) => polys.some((poly) => pointInPolygon(p, poly, 0));
  const next = new Map<string, { to: string; p: Pt2; q: Pt2 }[]>();
  for (const w of walls) {
    const e = wallEnds(w, edges, nodeMap);
    if (!e) continue;
    const d = sub(e.b, e.a);
    const l = len(d);
    if (l < 1) continue;
    const nrm = { x: d.y / l, y: -d.x / l };
    const off = getNodeWallThickness(w) * 500 + 200;
    const mid = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
    const r = inside({ x: mid.x + nrm.x * off, y: mid.y + nrm.y * off });
    const l2 = inside({ x: mid.x - nrm.x * off, y: mid.y - nrm.y * off });
    if (r === l2) continue;
    for (const [from, to, p, q] of [[e.aId, e.bId, e.a, e.b], [e.bId, e.aId, e.b, e.a]] as const) {
      const list = next.get(from) ?? [];
      list.push({ to, p, q });
      next.set(from, list);
    }
  }
  const start = next.keys().next().value;
  if (!start) return null;
  const loop: LoopVertex[] = [];
  const used = new Set<string>();
  let cur = start as string;
  let prev = '';
  for (let guard = 0; guard < 1000; guard++) {
    const opts = (next.get(cur) ?? []).filter((o) => o.to !== prev && !used.has(`${cur}>${o.to}`) && !used.has(`${o.to}>${cur}`));
    if (!opts.length) return null;
    const o = opts[0];
    loop.push({ id: cur, p: o.p });
    used.add(`${cur}>${o.to}`);
    prev = cur;
    cur = o.to;
    if (cur === start) break;
  }
  if (cur !== start || loop.length < 3) return null;
  return ccw(loop);
}

function storeyBand(s: BubbleGraphNode) {
  const bot = Number(s.properties.bottomElevation ?? 0);
  const top = Number(s.properties.topElevation ?? bot + 3000);
  return { bot, top };
}

function buildFacades(
  loop: LoopVertex[], walls: BubbleGraphNode[], edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): Facade[] {
  // Collinear runs of the loop are one facade: a front with two walls and an
  // ax between them is still one front.
  const pts = loop.map((v) => v.p);
  const corners: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[(i - 1 + pts.length) % pts.length], p1 = pts[i], p2 = pts[(i + 1) % pts.length];
    const u = sub(p1, p0), v = sub(p2, p1);
    const cross = (u.x * v.y - u.y * v.x) / ((len(u) * len(v)) || 1);
    if (Math.abs(cross) > 1e-3) corners.push(i);
  }
  const facades: Facade[] = [];
  for (let k = 0; k < corners.length; k++) {
    const a = pts[corners[k]], b = pts[corners[(k + 1) % corners.length]];
    const d = sub(b, a);
    const L = len(d);
    if (L < 1) continue;
    const t = { x: d.x / L, y: d.y / L };
    const n = { x: t.y, y: -t.x };
    facades.push({ a, b, t, n, lengthMm: L, wallIds: [], doors: [], openingBands: [] });
  }

  for (const w of walls) {
    const e = wallEnds(w, edges, nodeMap);
    if (!e) continue;
    const f = facades.find((fc) => [e.a, e.b].every((p) => {
      const r = sub(p, fc.a);
      const s = dot(r, fc.t);
      return Math.abs(dot(r, fc.n)) < 50 && s > -50 && s < fc.lengthMm + 50;
    }));
    if (!f) continue;
    f.wallIds.push(w.id);
    // Openings exactly as the exporter places them: along the raw span between grips.
    const span = sub(e.gb, e.ga);
    const wl = len(span);
    if (wl < 1) continue;
    const u = { x: span.x / wl, y: span.y / wl };
    for (const op of collectOpenings(w, wl, edges, nodeMap)) {
      const along = Math.min(Math.max(op.distFromStart, 0), Math.max(0, wl - op.width)) + op.width / 2;
      const c = { x: e.ga.x + u.x * along, y: e.ga.y + u.y * along };
      f.openingBands.push([op.sillHeight, op.sillHeight + op.height]);
      if (op.node.type === 'door') {
        f.doors.push({ id: op.node.id, along: dot(sub(c, f.a), f.t), widthMm: op.width, heightMm: op.height });
      }
    }
  }
  return facades;
}

function storeyInfo(
  storey: BubbleGraphNode, nodes: BubbleGraphNode[], edges: BubbleGraphEdge[],
  nodeMap: Map<string, BubbleGraphNode>,
): StoreyInfo | null {
  const own = nodes.filter((n) => n.parentId === storey.id);
  const walls = own.filter((n) => n.type === 'wall');
  if (!walls.length) return null;
  const rooms = own.filter((n) => n.type === 'room');
  const roof = own.find((n) => n.type === 'roof') ?? null;
  const envelopeShells = own.filter((n) => n.type === 'shell'
    && ENVELOPE_ROLES.has(String(n.properties.shell_role ?? '')));
  const wallThicknessMm = Math.max(...walls.map((w) => getNodeWallThickness(w) * 1000));

  let loop: LoopVertex[] | null = null;
  let loopSource: StoreyInfo['loopSource'] = 'walls';
  let outerOffsetMm = wallThicknessMm / 2;
  for (const sh of envelopeShells) {
    loop = loopFromAnchors(sh, edges, nodeMap);
    if (loop) {
      loopSource = 'shell';
      outerOffsetMm = parseContourOffsets(sh.properties.contour_offset)[0];
      break;
    }
  }
  if (!loop && roof) {
    loop = loopFromAnchors(roof, edges, nodeMap);
    if (loop) loopSource = 'roof';
  }
  if (!loop) loop = loopFromWalls(walls, rooms, edges, nodeMap);
  if (!loop) return null;

  const { bot, top } = storeyBand(storey);
  return {
    storey, bot, top, loop, loopSource, outerOffsetMm, wallThicknessMm,
    envelopeShells, roof, facades: buildFacades(loop, walls, edges, nodeMap),
  };
}

export function analyzeBuilding(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]): BuildingInfo {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const notes: string[] = [];
  const storeys = nodes.filter((n) => n.type === 'storey')
    .sort((a, b) => storeyBand(a).bot - storeyBand(b).bot);

  const infos = new Map<string, StoreyInfo>();
  for (const s of storeys) {
    const info = storeyInfo(s, nodes, edges, nodeMap);
    if (info) infos.set(s.id, info);
  }
  const aboveGround = storeys.filter((s) => storeyBand(s).bot >= -100 && infos.has(s.id));
  const main = (aboveGround[0] && infos.get(aboveGround[0].id)) ?? [...infos.values()][0] ?? null;
  if (!main) {
    notes.push('Nu am găsit un etaj cu pereți al cărui contur să se poată citi.');
    return { main: null, roofStorey: null, storeys: [], entrance: null, notes };
  }
  const withRoof = [...infos.values()].filter((i) => i.roof).sort((a, b) => b.top - a.top);
  const roofStorey = withRoof[0] ?? infos.get(aboveGround[aboveGround.length - 1]?.id ?? '') ?? main;

  // The entrance: the front with doors; between several, the longest, then the
  // one facing most to the south.
  const withDoors = main.facades.filter((f) => f.doors.length);
  withDoors.sort((a, b) => b.lengthMm - a.lengthMm || a.n.y - b.n.y);
  const facade = withDoors[0];
  let entrance: BuildingInfo['entrance'] = null;
  if (facade) {
    const mid = facade.lengthMm / 2;
    const door = [...facade.doors].sort((a, b) => Math.abs(a.along - mid) - Math.abs(b.along - mid))[0];
    entrance = { facade, door };
  } else {
    notes.push('Nicio ușă într-un perete exterior — nu știu care e fațada intrării.');
  }
  const stack = [...infos.values()].filter((i) => i.bot >= main.bot).sort((a, b) => a.bot - b.bot);
  return { main, roofStorey, storeys: stack, entrance, notes };
}
