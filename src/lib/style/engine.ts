/**
 * engine.ts — a style, applied to the graph.
 *
 * `applyStyle` reads the building (`analyzeBuilding`) and runs the rules in a
 * fixed order, each writing ordinary graph nodes:
 *
 *   windows    large (modern) or tall (classic) openings, resized in place on
 *              the exterior walls of every storey, centred where they were,
 *              clear of their neighbours;
 *   envelope   on every storey, the outer finish and colour on the envelope
 *              shell (or a new render shell) and the ornament it carries —
 *              surrounds, sills, glafs, corner dressings, drawn by
 *              `lib/ornament` from the shell's `orn_*` properties so they move
 *              with the openings; a brâu on each floor; a plinth from the
 *              ground to the ground floor — closed sweeps on the outer face;
 *   entrance   one of: a prispă along the entrance front (timber posts, plate
 *              beam, parapet); a columned portico; a canopy; or just a landing
 *              — each with its platform and the steps down to the ground;
 *   doors      every other exterior door: a terrace with steps on the ground
 *              floor, a balcony with a guard above it;
 *   roof       type, pitch, covering; overhang measured from the facade and
 *              deep enough to cover a prispă; the eave height from how the roof
 *              sits (on the walls, running down past them; or over a frieze,
 *              the eave at the top of the wall); a knee wall or frieze where the
 *              roof needs one; a parapet and coping round a flat roof; then the
 *              roof solver re-runs;
 *   trim       cornice under the eave, on the storey the roof sits on;
 *              pilasters at the corners, up through every storey that has them;
 *   chimney    a stack through the roof, clear of it by 60 cm.
 *
 * Nothing here computes a mesh. Where a rule needs a height it derives it from
 * the same numbers the solvers use (storey band, pitch, rafter section, the
 * roof's own contour), and the solvers then build the geometry from the nodes.
 *
 * Re-applying first takes the previous run off (`removeStyle`): generated
 * nodes carry `style_part`; modified nodes keep their previous values under
 * `style_prev`. So a style can be tried, tuned and removed without residue.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { bimToCanvas, storeyFrame } from '@/lib/grid/axisEdit';
import { collectOpenings, getConnectedNodesWithGrips, getGripBimPos } from '@/lib/bimGeometry';
import {
  applyRoofResult, computeFaceBasis, computeRoofFaces, createRoofForStorey, eyebrowIntentOf, gabletIntentOf, parseTimberSection,
  placeEyebrow, placeGablet, resolveRoofContour, solveRoof,
} from '@/lib/roof';
import type { RoofType } from '@/lib/roof';
import { computeSweep } from '@/lib/sweep';
import { computeSketch } from '@/lib/sketch';
import type { Pt2 } from '@/lib/geom/plan2d';
import { analyzeBuilding, type Facade, type FacadeDoor, type StoreyInfo } from './analyze';
import { resolveParams, STYLE_PACK_MAP } from './packs';
import {
  STYLE_PACK_KEY, STYLE_PARAMS_KEY, STYLE_PART_KEY, STYLE_PREV_KEY,
  type StyleChange, type StyleGroup, type StyleIssue, type StyleParams, type StyleResult,
} from './types';

const DECK_MM = 100;
const PLINTH_PROJ_MM = 60;
const BEAM_H_MM = 200;
const EAVE_MARGIN_MM = 300;
const POST_INSET_MM = 50;
const TREAD_MM = 300;
const PARAPET_T_MM = 50;
const CHIMNEY_MM = 500;
const CHIMNEY_CLEAR_MM = 600;
const ENTABLATURE_MM = 450;
const PORTICO_SLAB_MM = 150;
const PORCH_SLAB_MM = 150;
const BALCONY_SLAB_MM = 180;
const GUARD_MIN_MM = 900;
const CANOPY_MM = 120;
const CORNICE_H_MM = 220;
const CORNICE_PROJ_MM = 180;
const PILASTER_MM = 450;
const PILASTER_PROJ_MM = 60;
const WINDOW_MARGIN_MM = 350;

let seq = 0;
const uid = () => `${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const r1 = (n: number) => Math.round(n * 10) / 10;

// ─── Taking a style off ───────────────────────────────────────────────────────

/**
 * The graph without any style: generated nodes (and what a generated roof
 * generated) removed, modified nodes given back what they had, roofs whose
 * properties came back re-solved.
 */
export function removeStyle(
  nodes: BubbleGraphNode[], edges: BubbleGraphEdge[],
): { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[]; removed: number; restored: number } {
  const gone = new Set(nodes.filter((n) => n.properties[STYLE_PART_KEY] != null).map((n) => n.id));
  for (const n of nodes) {
    const src = n.properties.source_roof_id;
    if (typeof src === 'string' && gone.has(src)) gone.add(n.id);
  }
  let restored = 0;
  const reSolve: string[] = [];
  let out = nodes.filter((n) => !gone.has(n.id)).map((n) => {
    const raw = n.properties[STYLE_PREV_KEY];
    const stamped = n.properties[STYLE_PACK_KEY] != null || n.properties[STYLE_PARAMS_KEY] != null;
    if (raw == null && !stamped) return n;
    const props = { ...n.properties };
    if (raw != null) {
      let prev: Record<string, unknown> = {};
      try { prev = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>); } catch { prev = {}; }
      for (const [k, v] of Object.entries(prev)) {
        if (v === null) delete props[k];
        else props[k] = v;
      }
      restored++;
      if (n.type === 'roof') reSolve.push(n.id);
    }
    delete props[STYLE_PREV_KEY];
    delete props[STYLE_PACK_KEY];
    delete props[STYLE_PARAMS_KEY];
    return { ...n, properties: props };
  });
  let outEdges = edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
  for (const id of reSolve) {
    const applied = applyRoofResult(out, outEdges, solveRoof({ nodes: out, edges: outEdges, roofId: id }));
    out = applied.nodes;
    outEdges = applied.edges;
  }
  return { nodes: out, edges: outEdges, removed: gone.size, restored };
}

// ─── The working graph ────────────────────────────────────────────────────────

class Work {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  changes: StyleChange[] = [];
  issues: StyleIssue[] = [];
  figures: Record<string, number> = {};
  /** Stretches of a front already given a platform or a balcony — a door there needs nothing more. */
  covered: { storeyId: string; f: Facade; s0: number; s1: number }[] = [];
  constructor(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[], readonly packId: string) {
    this.nodes = nodes;
    this.edges = edges;
  }

  get(id: string) { return this.nodes.find((n) => n.id === id); }

  /** Set properties on an existing node, remembering what they were. */
  modify(id: string, patch: Record<string, unknown>) {
    this.nodes = this.nodes.map((n) => {
      if (n.id !== id) return n;
      const props = { ...n.properties };
      let prev: Record<string, unknown> = {};
      const raw = props[STYLE_PREV_KEY];
      if (raw != null) { try { prev = JSON.parse(String(raw)); } catch { prev = {}; } }
      for (const [k, v] of Object.entries(patch)) {
        if (props[STYLE_PART_KEY] == null && !(k in prev)) prev[k] = props[k] ?? null;
        if (v === undefined) delete props[k];
        else props[k] = v;
      }
      if (props[STYLE_PART_KEY] == null) props[STYLE_PREV_KEY] = JSON.stringify(prev);
      return { ...n, properties: props };
    });
  }

  add(storey: BubbleGraphNode, type: string, name: string, part: string, at: Pt2, props: Record<string, unknown>): string {
    const prefix = type === 'ax' ? 'ax' : 'node';
    const id = `${prefix}_style_${uid()}`;
    const c = bimToCanvas(storeyFrame(storey), at);
    this.nodes.push({
      id, type, name, x: c.x, y: c.y, z: 0, parentId: storey.id,
      properties: { ...props, [STYLE_PART_KEY]: part, [STYLE_PACK_KEY]: this.packId },
    });
    return id;
  }

  /** A free ax — a plan point the sweeps can hang on. */
  point(storey: BubbleGraphNode, p: Pt2, name: string, part: string): string {
    return this.add(storey, 'ax', name, part, p, {
      has_column: 'False', column_type: 'C25x25', bimX: r1(p.x), bimY: r1(p.y),
    });
  }

  wire(from: string, anchors: string[]) {
    for (const to of anchors) this.edges.push({ id: `edge_style_${uid()}`, from, to, type: 'spans' });
  }

  change(group: StyleGroup, kind: StyleChange['kind'], text: string, nodeIds: string[] = []) {
    this.changes.push({ group, kind, text, nodeIds });
  }

  issue(severity: StyleIssue['severity'], text: string) {
    this.issues.push({ severity, text });
  }

  cover(storeyId: string, f: Facade, s0: number, s1: number) {
    this.covered.push({ storeyId, f, s0, s1 });
  }

  /** Is this door, on this storey's front, in front of a platform or balcony already there? */
  isCovered(storeyId: string, f: Facade, door: FacadeDoor): boolean {
    const c = at(f, door.along, 0);
    return this.covered.some((k) => {
      if (k.storeyId !== storeyId || k.f.n.x * f.n.x + k.f.n.y * f.n.y < 0.99) return false;
      const r = { x: c.x - k.f.a.x, y: c.y - k.f.a.y };
      const s = r.x * k.f.t.x + r.y * k.f.t.y;
      return Math.abs(r.x * k.f.n.x + r.y * k.f.n.y) < 600 && s >= k.s0 && s <= k.s1;
    });
  }

  get family() { return STYLE_PACK_MAP.get(this.packId)?.family ?? 'traditional'; }
}

const at = (f: Facade, s: number, d: number): Pt2 => ({
  x: f.a.x + f.t.x * s + f.n.x * d,
  y: f.a.y + f.t.y * s + f.n.y * d,
});

const outline = (pts: Pt2[]) => JSON.stringify(pts.map((p) => [r1(p.x), r1(p.y)]));

/** `n` evenly spaced points from a to b, including both, no gap over `max`. */
function spread(a: number, b: number, max: number): number[] {
  if (b - a < 1) return [a];
  const k = Math.max(1, Math.ceil((b - a) / max));
  return Array.from({ length: k + 1 }, (_, i) => a + ((b - a) * i) / k);
}

/** Loop anchors clockwise: a sweep's profile hangs to the LEFT of travel, so this puts it outside. */
const clockwise = (m: StoreyInfo) => [...m.loop].reverse().map((v) => v.id);

const colour = (c: unknown): Record<string, unknown> => {
  const s = String(c ?? '');
  return s ? { color_3d: s, color_2d: s } : {};
};
const trimColour = (p: StyleParams) => colour(p.trim_color || p.wall_color);

const SWEEP_DEFAULTS = { closed: 'False', corners: 'miter', rotation_deg: 0, mirror: 'False', height_mm: 0 };

/** A sketch extruded from `z` for `h` above the storey floor (or top). */
function slab(
  w: Work, storey: BubbleGraphNode, name: string, part: string, pts: Pt2[],
  z: number, h: number, material: string, ifc: string, level: 'bottom' | 'top' = 'bottom',
  extra: Record<string, unknown> = {},
): string {
  const c = { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length };
  return w.add(storey, 'sketch', name, part, c, {
    shape: 'poly', outline: outline(pts), closed: 'True', op: 'extrude', level,
    offset_z_mm: Math.round(z), height_mm: Math.round(h), ifc_type: ifc, material, array_count: 1, ...extra,
  });
}

const rect = (f: Facade, s0: number, s1: number, d0: number, d1: number) =>
  [at(f, s0, d0), at(f, s1, d0), at(f, s1, d1), at(f, s0, d1)];

const plinthOn = (p: StyleParams) => Number(p.floor_raise_mm) >= 50 && String(p.plinth_material) !== '';
// Steps and platform bases are built of the plinth's stuff — but a rendered
// plinth is render over masonry, and a step is not rendered: concrete then.
const groundMaterial = (p: StyleParams) => (p.plinth_material && p.plinth_material !== 'Tencuială de var' ? String(p.plinth_material) : 'Beton');

/** A raised platform from the ground to the floor: a deck on a base. */
function platform(
  w: Work, m: StoreyInfo, f: Facade, s0: number, s1: number, d0: number, d1: number,
  p: StyleParams, deckMaterial: string, name: string,
): string[] {
  const raise = Number(p.floor_raise_mm);
  const pts = rect(f, s0, s1, d0, d1);
  const ids = [slab(w, m.storey, `Pardoseală ${name}`, 'entrance_deck', pts, -DECK_MM, DECK_MM, deckMaterial, 'IFCSLAB')];
  if (raise - DECK_MM >= 20) {
    ids.push(slab(w, m.storey, `Soclu ${name}`, 'entrance_base', pts, -raise, raise - DECK_MM, groundMaterial(p), 'IFCSLAB'));
  }
  return ids;
}

/** Steps down from a platform edge (`d`, measured from the outline) to the ground. */
function steps(w: Work, m: StoreyInfo, f: Facade, along: number, width: number, d: number, p: StyleParams): string[] {
  const raise = Number(p.floor_raise_mm);
  if (raise < 150) return [];
  const n = Math.max(2, Math.round(raise / 165));
  const rise = raise / n;
  const ids: string[] = [];
  for (let k = 1; k < n; k++) {
    const pts = rect(f, along - width / 2, along + width / 2, d + (k - 1) * TREAD_MM, d + k * TREAD_MM);
    ids.push(slab(w, m.storey, `Treaptă ${k}`, 'entrance_step', pts, -raise, raise - k * rise, groundMaterial(p), 'IFCSTAIR'));
  }
  return ids;
}

const stepsText = (n: number) => (n ? `, ${n} ${n === 1 ? 'treaptă' : 'trepte'}` : '');

/** A balcony's or upper porch's guard, in the style's own material. */
function railingLook(w: Work, p: StyleParams): Record<string, unknown> {
  if (w.family === 'modern') return { p_w_mm: 20, material: 'Sticlă', color_3d: '#A9C8D4', color_2d: '#A9C8D4' };
  if (w.family === 'classic') return { p_w_mm: 120, material: String(p.wall_finish || 'Tencuială de var'), ...trimColour(p) };
  return { p_w_mm: PARAPET_T_MM, material: 'Lemn masiv', ...colour(p.woodwork_color) };
}

/** A guard round three sides of a platform (open towards the wall), on `storey`. */
function guard(w: Work, storey: BubbleGraphNode, f: Facade, s0: number, s1: number, d0: number, d1: number, h: number, p: StyleParams, name: string, part: string): string[] {
  const look = railingLook(w, p);
  const half = Number(look.p_w_mm) / 2;
  const pts = [at(f, s0 + half, d0), at(f, s0 + half, d1 - half), at(f, s1 - half, d1 - half), at(f, s1 - half, d0)];
  const ax = pts.map((q, i) => w.point(storey, q, `${name} ${i + 1}`, `${part}_axis`));
  const id = w.add(storey, 'sweep', name, part, pts[0], {
    ...SWEEP_DEFAULTS, sweep_role: 'handrail', profile: 'rect', p_h_mm: Math.round(h),
    anchor_x: 'mid', anchor_y: 'min', offset_x_mm: 0, level: 'bottom', offset_z_mm: 0,
    ifc_type: 'IFCRAILING', ...look,
  });
  w.wire(id, ax);
  return [...ax, id];
}

/** The shell properties `lib/ornament` reads, from the style's choices. */
function ornamentProps(p: StyleParams): Record<string, unknown> {
  const window = String(p.window_trim ?? 'none');
  // A band takes the brâu's colour when there is one — the two are painted together.
  const tint = String(p.trim_color || (p.brau ? p.brau_color : '') || '');
  return {
    orn_window: window,
    orn_sill: String(p.window_sill ?? 'none'),
    orn_glaf: String(p.window_glaf ?? 'none'),
    orn_corner: p.pilasters ? 'none' : String(p.corner_trim ?? 'none'),
    orn_doors: 'True',
    orn_color: tint,
    orn_wood_color: String(p.woodwork_color ?? ''),
  };
}

const ornamentsOn = (p: StyleParams) => ['window_trim', 'window_sill', 'window_glaf']
  .some((k) => String(p[k] ?? 'none') !== 'none') || (!p.pilasters && String(p.corner_trim ?? 'none') !== 'none');

// ── Rule: windows ─────────────────────────────────────────────────────────────

/**
 * Resize the windows of the exterior walls to the style's proportion. Each
 * keeps its centre; its width is held clear of the next opening and of the
 * wall ends; its head stays under the top of the wall.
 */
function ruleWindows(w: Work, m: StoreyInfo, p: StyleParams, where = '') {
  const mode = String(p.windows);
  if (mode !== 'large' && mode !== 'tall') return;
  const nodeMap = new Map(w.nodes.map((n) => [n.id, n]));
  const H = m.top - m.bot;
  const touched: string[] = [];
  let count = 0;

  const size = (op: { distFromStart: number; width: number }, others: { distFromStart: number; width: number }[], len: number, wallH: number) => {
    const c = op.distFromStart + op.width / 2;
    let lo = 0, hi = len;
    for (const o of others) {
      if (o === op) continue;
      const oc = o.distFromStart + o.width / 2;
      if (oc < c) lo = Math.max(lo, o.distFromStart + o.width);
      else hi = Math.min(hi, o.distFromStart);
    }
    const room = 2 * Math.min(c - lo, hi - c) - 2 * WINDOW_MARGIN_MM;
    const head = Math.min(2400, wallH - 100);
    const target = mode === 'large' ? Math.min(2400, len * 0.6) : 1100;
    const width = Math.floor(Math.min(Math.max(target, mode === 'large' ? op.width : 0), room) / 10) * 10;
    if (width < 600) return null;
    const sill = mode === 'large' ? Math.max(150, head - 2250) : 700;
    return { width, height: Math.round(head - sill), sill: Math.round(sill) };
  };

  for (const f of m.facades) {
    for (const wid of f.wallIds) {
      const wall = nodeMap.get(wid);
      if (!wall) continue;
      const ends = getConnectedNodesWithGrips(wid, w.edges, nodeMap).filter(({ node }) => node.type === 'ax' || node.type === 'column');
      if (ends.length < 2) continue;
      const ga = getGripBimPos(ends[0].node, ends[0].gripIdx, nodeMap);
      const gb = getGripBimPos(ends[1].node, ends[1].gripIdx, nodeMap);
      const len = Math.hypot(gb.x - ga.x, gb.y - ga.y);
      const ops = collectOpenings(wall, len, w.edges, nodeMap);
      const wallH = Math.min(H, Number(wall.properties.height ?? H) || H);

      // Inline windows, rewritten in the wall's own list.
      let list: Record<string, unknown>[] = [];
      try { list = JSON.parse(String(wall.properties.windows ?? '[]')); } catch { list = []; }
      let changed = false;
      const next = (Array.isArray(list) ? list : []).map((entry) => {
        if (Number(entry.count ?? 1) > 1) return entry;
        const op = ops.find((o) => o.node.type === 'window' && o.node.id === String(entry.id));
        if (!op) return entry;
        const s = size(op, ops, len, wallH);
        if (!s) return entry;
        const off = entry.wall_offset;
        const numeric = off !== null && off !== undefined && off !== '' && Number.isFinite(Number(off));
        if (off !== null && off !== undefined && off !== '' && !numeric) return entry;   // a formula: leave it be
        changed = true;
        count++;
        return {
          ...entry, width: s.width, height: s.height, sill_height: s.sill,
          wall_offset: numeric ? Math.round(Number(off) + (op.width - s.width) / 2) : off ?? null,
        };
      });
      if (changed) {
        w.modify(wid, { windows: JSON.stringify(next) });
        touched.push(wid);
      }

      // Window nodes wired to the wall.
      for (const op of ops) {
        const node = nodeMap.get(op.node.id);
        if (!node || node.type !== 'window' || Number(node.properties.count ?? 1) > 1) continue;
        const s = size(op, ops, len, wallH);
        if (!s) continue;
        const off = node.properties.offset;
        const numeric = off !== null && off !== undefined && off !== '' && Number.isFinite(Number(off));
        w.modify(node.id, {
          width: s.width, height: s.height, sill_height: s.sill,
          ...(numeric ? { offset: Math.round(Number(off) + (op.width - s.width) / 2) } : {}),
        });
        touched.push(node.id);
        count++;
      }
    }
  }
  if (count) {
    w.change('envelope', 'modify', mode === 'large'
      ? `${count} ferestre mărite${where}, cu parapet jos și buiandrugul la +${Math.min(2400, H - 100)} mm`
      : `${count} ferestre înalte${where}, de proporție verticală`, touched);
  }
}

// ── Rule: envelope ────────────────────────────────────────────────────────────

/**
 * Every storey's envelope: the finish and colour on its shell (or a new render
 * shell), the ornament the shell carries (surrounds, sills, corners — drawn
 * by `lib/ornament` from these properties, so they follow the openings), a
 * brâu at the same height above each floor; the plinth on the ground floor
 * only. Returns each storey's outer face, measured from its outline.
 */
function ruleEnvelope(w: Work, storeys: StoreyInfo[], main: StoreyInfo, p: StyleParams): Map<string, number> {
  const finish = String(p.wall_finish ?? '');
  const tint = colour(p.wall_color);
  const orn = ornamentsOn(p) ? ornamentProps(p) : {};
  const outers = new Map<string, number>();
  const shells: string[] = [];
  const made: string[] = [];
  for (const m of storeys) {
    let outer = m.outerOffsetMm;
    if (m.envelopeShells.length) {
      if (finish || Object.keys(tint).length || Object.keys(orn).length) {
        for (const sh of m.envelopeShells) w.modify(sh.id, { ...(finish ? { material: finish } : {}), ...tint, ...orn });
        shells.push(...m.envelopeShells.map((sh) => sh.id));
      }
    } else if (finish || Object.keys(orn).length) {
      // No envelope on the model: the finish becomes one — a 25 mm render
      // shell on the outer face of the walls. Ornament needs a face to sit
      // on, so it makes one too, in the walls' own material.
      const t = 25;
      outer = m.wallThicknessMm / 2 + t;
      const wall = w.get(m.facades.flatMap((f) => f.wallIds)[0] ?? '');
      const material = finish || String(wall?.properties.material ?? '') || 'Tencuială de var';
      const id = w.add(m.storey, 'shell', `Finisaj exterior — ${material}`, 'finish_shell', m.loop[0].p, {
        material, contour_offset: String(outer), thickness: t, height: m.top - m.bot, ...tint, ...orn,
      });
      w.wire(id, m.loop.map((v) => v.id));
      made.push(id);
    }
    outers.set(m.storey.id, outer);
  }
  const floors = storeys.length > 1 ? ` (${storeys.length} niveluri)` : '';
  if (shells.length && (finish || Object.keys(tint).length)) {
    w.change('envelope', 'modify', `Stratul exterior al pereților: ${finish || 'finisajul actual'}${p.wall_color ? `, ${p.wall_color}` : ''}${floors}`, shells);
  }
  if (made.length) w.change('envelope', 'add', `Strat de finisaj exterior 25 mm${finish ? `: ${finish}` : ''}${floors}`, made);
  if (Object.keys(orn).length) {
    const what = [
      p.window_trim !== 'none' && 'ancadramente',
      p.window_sill !== 'none' && 'solbancuri',
      p.window_glaf !== 'none' && 'glafuri',
      orn.orn_corner !== 'none' && 'colțuri decorate',
    ].filter(Boolean).join(', ');
    w.change('envelope', 'add', `Ornamente pe fațade: ${what} — legate de goluri, le urmează la mutare${floors}`, [...shells, ...made]);
  }

  const outer = outers.get(main.storey.id) ?? main.outerOffsetMm;
  const raise = Number(p.floor_raise_mm);
  if (plinthOn(p)) {
    const id = w.add(main.storey, 'sweep', 'Soclu', 'plinth', main.loop[0].p, {
      ...SWEEP_DEFAULTS, sweep_role: 'plinth', profile: 'rect', p_w_mm: PLINTH_PROJ_MM, p_h_mm: raise,
      anchor_x: 'min', anchor_y: 'min', offset_x_mm: outer, level: 'bottom', offset_z_mm: -raise,
      closed: 'True', ifc_type: 'IFCCOVERING', material: String(p.plinth_material), ...colour(p.plinth_color),
    });
    w.wire(id, clockwise(main));
    const what = p.plinth_material === 'Tencuială de var' ? `tencuit${p.plinth_color ? ` și vopsit ${p.plinth_color}` : ''}` : `din ${String(p.plinth_material).toLowerCase()}`;
    w.change('envelope', 'add', `Soclu ${what}, ${raise} mm de la teren la pardoseală`, [id]);
  }

  if (p.brau) {
    const z = Number(p.brau_z_mm);
    const h = 120;
    const c = String(p.brau_color || '#2E5E8C');
    const ids: string[] = [];
    for (const m of storeys) {
      if (z + h / 2 > m.top - m.bot) continue;
      const hits = m.facades.some((f) => f.openingBands.some(([lo, hi]) => z + h / 2 > lo && z - h / 2 < hi));
      if (hits) w.issue('warning', `Brâul de la +${z} mm (${m.storey.name || 'etaj'}) trece peste goluri de uși sau ferestre — ridică-l deasupra lor.`);
      const id = w.add(m.storey, 'sweep', 'Brâu', 'brau', m.loop[0].p, {
        ...SWEEP_DEFAULTS, sweep_role: 'band', profile: 'rect', p_w_mm: 30, p_h_mm: h,
        anchor_x: 'min', anchor_y: 'mid', offset_x_mm: outers.get(m.storey.id) ?? m.outerOffsetMm, level: 'bottom', offset_z_mm: z,
        closed: 'True', ifc_type: 'IFCCOVERING', material: finish || 'Tencuială de var', color_3d: c, color_2d: c,
      });
      w.wire(id, clockwise(m));
      ids.push(id);
    }
    if (ids.length) w.change('envelope', 'add', `Brâu colorat la +${z} mm${ids.length > 1 ? ` pe fiecare din cele ${ids.length} niveluri` : ''}`, ids);
  }
  return outers;
}

// ── Rule: entrance — prispă ───────────────────────────────────────────────────

interface PorchPlan {
  facade: Facade;
  /** Distance from the outline to the porch's inner edge, and its outer edge. */
  d0: number;
  d1: number;
  /** Post centre line, from the outline. */
  dPost: number;
  /** Top of the plate beam above the floor. */
  plateTop: number;
  /** Wall-plate lift the headroom needed (≥ 0). */
  lift: number;
  /** No eave reaches it (a storey above, or a flat roof): it carries its own slab. */
  slab: boolean;
}

/**
 * Where the porch goes and how high its plate can be, before anything is
 * built — the roof rule needs the same numbers.
 *
 * The roof bears on the wall: its rafters' underside meets the outer face at
 * the top of the wall, plus a knee wall if one is needed (`lift`). From there
 * it falls at the roof pitch, so at the post line it is lower by
 * `distance · tan(pitch)`. The plate beam must fit under it with the headroom
 * the style asks for; the lift is what is missing, never more than allowed.
 */
function planPorch(m: StoreyInfo, facade: Facade, outer: number, p: StyleParams, sameStoreyRoof: boolean, w: Work): PorchPlan {
  const plinth = plinthOn(p) ? PLINTH_PROJ_MM : 0;
  const post = Number(p.post_size_mm);
  const d0 = outer + plinth;
  const d1 = d0 + Number(p.porch_depth_mm);
  const dPost = d1 - post / 2 - POST_INSET_MM;
  const H = m.top - m.bot;
  if (!sameStoreyRoof || p.roof_type === 'flat') {
    // No eave over it — a storey above, or a terrace roof: the porch carries
    // its own slab at the top of the storey, the floor of a balcony above.
    return { facade, d0, d1, dPost, plateTop: H - PORCH_SLAB_MM, lift: 0, slab: true };
  }
  const tan = Math.tan((Number(p.roof_pitch_deg) * Math.PI) / 180);
  const drop = (dPost - outer) * tan;
  const need = Number(p.porch_clear_mm) + BEAM_H_MM + drop - H;
  const liftMax = Number(p.wall_plate_lift_max_mm);
  const lift = Math.max(0, Math.min(liftMax, need));
  const plateTop = H + lift - drop;
  if (need > liftMax + 1) {
    w.issue('warning', `Sub grinda prispei rămân ${Math.round(plateTop - BEAM_H_MM)} mm, sub cei ${p.porch_clear_mm} ceruți — micșorează panta sau adâncimea prispei, ori permite o cosoroabă mai înaltă.`);
  }
  return { facade, d0, d1, dPost, plateTop, lift, slab: false };
}

/** What the porch rule leaves for the fronton: the door bay, between which two posts. */
interface PorchBuilt { stations: number[]; gap: [number, number] | null }

function rulePorch(w: Work, m: StoreyInfo, plan: PorchPlan, door: FacadeDoor, p: StyleParams, above: StoreyInfo | null): PorchBuilt {
  const f = plan.facade;
  const storey = m.storey;
  const post = Number(p.post_size_mm);
  const wood = colour(p.woodwork_color);
  const ids: string[] = [];

  // Along the front, the porch runs corner to corner of the outer face.
  const s0 = -plan.d0, s1 = f.lengthMm + plan.d0;
  const sMin = s0 + post / 2 + POST_INSET_MM, sMax = s1 - post / 2 - POST_INSET_MM;

  // Posts: the door gets its own bay, the rest is shared out evenly.
  const half = Math.max(door.widthMm / 2 + 350 + post / 2, 800);
  const spacing = Number(p.post_spacing_mm);
  let stations: number[];
  let gap: [number, number] | null = null;
  if (door.along - half - sMin >= 600 && sMax - (door.along + half) >= 600) {
    const left = spread(sMin, door.along - half, spacing);
    const right = spread(door.along + half, sMax, spacing);
    stations = [...left, ...right];
    gap = [left.length - 1, left.length];
  } else {
    stations = spread(sMin, sMax, spacing);
    const i = stations.findIndex((s, k) => k < stations.length - 1 && s <= door.along && stations[k + 1] >= door.along);
    if (i >= 0) gap = [i, i + 1];
  }

  const postIds: string[] = [];
  stations.forEach((s, i) => {
    const ax = w.point(storey, at(f, s, plan.dPost), `Stâlp prispă ${i + 1}`, 'porch_axis');
    const sw = w.add(storey, 'sweep', `Stâlp prispă ${i + 1}`, 'porch_post', at(f, s, plan.dPost), {
      ...SWEEP_DEFAULTS, sweep_role: 'column', profile: 'rect', p_w_mm: post, p_h_mm: post,
      anchor_x: 'mid', anchor_y: 'mid', offset_x_mm: 0, level: 'bottom', offset_z_mm: 0,
      height_mm: Math.round(plan.plateTop - BEAM_H_MM), ifc_type: 'IFCCOLUMN', material: 'Lemn masiv', ...wood,
    });
    w.wire(sw, [ax]);
    postIds.push(ax);
    ids.push(ax, sw);
  });

  const beam = w.add(storey, 'sweep', 'Grindă prispă', 'porch_beam', at(f, stations[0], plan.dPost), {
    ...SWEEP_DEFAULTS, sweep_role: 'beam', profile: 'rect', p_w_mm: post, p_h_mm: BEAM_H_MM,
    anchor_x: 'mid', anchor_y: 'max', offset_x_mm: 0, level: 'bottom', offset_z_mm: Math.round(plan.plateTop),
    ifc_type: 'IFCBEAM', material: 'Lemn masiv', ...wood,
  });
  w.wire(beam, postIds);
  ids.push(beam);

  ids.push(...platform(w, m, f, s0, s1, plan.d0, plan.d1, p, 'Lemn', 'prispă'));
  const wStep = Math.min(door.widthMm + 600, 2 * half - post);
  const stepIds = steps(w, m, f, door.along, wStep, plan.d1, p);
  ids.push(...stepIds);

  // Parapet: along the posts, open at the door, returned to the wall at each end.
  if (p.parapet) {
    const hPar = Number(p.parapet_h_mm);
    const runs: string[][] = [];
    const wallL = w.point(storey, at(f, stations[0], plan.d0), 'Parmaclac — capăt', 'porch_axis');
    const wallR = w.point(storey, at(f, stations[stations.length - 1], plan.d0), 'Parmaclac — capăt', 'porch_axis');
    ids.push(wallL, wallR);
    if (gap) {
      runs.push([wallL, ...postIds.slice(0, gap[0] + 1)]);
      runs.push([...postIds.slice(gap[1]), wallR]);
    } else {
      runs.push([wallL, ...postIds, wallR]);
    }
    for (const run of runs) {
      if (run.length < 2) continue;
      const id = w.add(storey, 'sweep', 'Parmaclac', 'porch_parapet', m.loop[0].p, {
        ...SWEEP_DEFAULTS, sweep_role: 'handrail', profile: 'rect', p_w_mm: PARAPET_T_MM, p_h_mm: hPar,
        anchor_x: 'mid', anchor_y: 'min', offset_x_mm: 0, level: 'bottom', offset_z_mm: 0,
        ifc_type: 'IFCRAILING', material: 'Lemn masiv', ...wood,
      });
      w.wire(id, run);
      ids.push(id);
    }
  }

  // Its own roof when no eave covers it; a balcony on it when the storey
  // above opens onto it.
  let over = '';
  w.cover(storey.id, f, s0, s1);
  if (plan.slab) {
    ids.push(slab(w, storey, 'Planșeu prispă', 'porch_roof', rect(f, s0, s1, plan.d0, plan.d1 + 100),
      -PORCH_SLAB_MM, PORCH_SLAB_MM, 'Beton armat', 'IFCSLAB', 'top'));
    over = ', planșeu deasupra';
    const opens = above?.facades.some((g) => g.doors.length && g.n.x * f.n.x + g.n.y * f.n.y > 0.99
      && Math.abs((g.a.x - f.a.x) * f.n.x + (g.a.y - f.a.y) * f.n.y) < 600);
    if (above && opens) {
      ids.push(...guard(w, above.storey, f, s0, s1, plan.d0, plan.d1 + 100, Math.max(GUARD_MIN_MM, Number(p.parapet_h_mm)), p, 'Parapet balcon', 'balcony_rail'));
      w.cover(above.storey.id, f, s0, s1);
      over = ', balcon la etaj peste ea';
    }
  }

  // A cerdac: an arch between each pair of posts, hung under the plate beam
  // — a board with an arched underside, set across the post line.
  const cerdac = p.entrance === 'cerdac';
  if (cerdac) {
    const archH = Math.round(Number(p.arch_rise_mm) + 120);
    const under = Math.round(plan.plateTop - BEAM_H_MM);
    const arches: string[] = [];
    for (let i = 0; i < stations.length - 1; i++) {
      const span = stations[i + 1] - stations[i] - post;
      if (span < 600) continue;
      const mid = (stations[i] + stations[i + 1]) / 2;
      const a = w.point(storey, at(f, mid, plan.dPost + 30), `Arcadă ${i + 1}`, 'porch_axis');
      const b = w.point(storey, at(f, mid, plan.dPost - 30), `Arcadă ${i + 1}`, 'porch_axis');
      const id = w.add(storey, 'sweep', `Arcadă ${i + 1}`, 'porch_arch', at(f, mid, plan.dPost), {
        ...SWEEP_DEFAULTS, sweep_role: 'generic', profile: 'arch', p_w_mm: Math.round(span), p_h_mm: archH,
        p_r_mm: Math.round(Math.min(Number(p.arch_rise_mm), span / 2)),
        anchor_x: 'mid', anchor_y: 'min', offset_x_mm: 0, level: 'bottom', offset_z_mm: under - archH,
        ifc_type: 'IFCMEMBER', material: 'Lemn masiv', ...wood,
      });
      w.wire(id, [a, b]);
      arches.push(a, b, id);
    }
    ids.push(...arches);
    if (arches.length) over += `, ${arches.length / 3} arcade`;
  }

  const depth = plan.d1 - plan.d0;
  w.figures.porch_posts = stations.length;
  w.figures.porch_area_m2 = Math.round(((s1 - s0) * depth) / 1e4) / 100;
  w.figures.porch_plate_top_mm = Math.round(plan.plateTop);
  w.change('porch', 'add',
    `${cerdac ? 'Cerdac' : 'Prispă'} ${(depth / 1000).toFixed(2)} × ${((s1 - s0) / 1000).toFixed(2)} m pe fațada intrării: ${stations.length} stâlpi ${post}×${post}, grindă la +${Math.round(plan.plateTop)} mm${p.parapet ? ', parmaclac' : ''}${stepsText(stepIds.length)}${over}`,
    ids);
  return { stations, gap };
}

// ── Rule: entrance — portico ──────────────────────────────────────────────────

/**
 * A columned portico centred on the door: an even number of columns so the
 * door falls between the middle two, an entablature returned to the wall at
 * both ends, a flat roof over it just under the eave, a stone platform and
 * steps as wide as the central bays.
 */
function rulePortico(w: Work, m: StoreyInfo, f: Facade, door: FacadeDoor, outer: number, p: StyleParams) {
  const storey = m.storey;
  const H = m.top - m.bot;
  const d0 = outer + (plinthOn(p) ? PLINTH_PROJ_MM : 0);
  const d1 = d0 + Number(p.porch_depth_mm);
  const dia = Number(p.column_d_mm);
  const n = Math.max(2, Math.round(Number(p.portico_columns) / 2) * 2);
  const s0 = -d0, s1 = f.lengthMm + d0;
  const room = s1 - s0 - dia - 400;
  let bay = Math.max(door.widthMm + 700 + dia, 1800);
  if ((n - 1) * bay > room) bay = room / (n - 1);
  const span = (n - 1) * bay;
  const centre = Math.min(Math.max(door.along, s0 + span / 2 + dia / 2 + 200), s1 - span / 2 - dia / 2 - 200);
  const stations = Array.from({ length: n }, (_, i) => centre - span / 2 + i * bay);
  const dCol = d1 - dia / 2 - 100;
  const finish = String(p.wall_finish || 'Tencuială de var');
  const trim = trimColour(p);
  const ids: string[] = [];
  const colTop = H - PORTICO_SLAB_MM - ENTABLATURE_MM;

  const colIds: string[] = [];
  stations.forEach((s, i) => {
    const ax = w.point(storey, at(f, s, dCol), `Coloană ${i + 1}`, 'portico_axis');
    const sw = w.add(storey, 'sweep', `Coloană ${i + 1}`, 'portico_column', at(f, s, dCol), {
      ...SWEEP_DEFAULTS, sweep_role: 'column', profile: 'circle', p_d_mm: dia, p_segments: 24,
      anchor_x: 'mid', anchor_y: 'mid', offset_x_mm: 0, level: 'bottom', offset_z_mm: 0,
      height_mm: Math.round(colTop), ifc_type: 'IFCCOLUMN', material: finish, ...trim,
    });
    w.wire(sw, [ax]);
    colIds.push(ax);
    ids.push(ax, sw);
  });

  const wallL = w.point(storey, at(f, stations[0], d0), 'Antablament — capăt', 'portico_axis');
  const wallR = w.point(storey, at(f, stations[n - 1], d0), 'Antablament — capăt', 'portico_axis');
  const ent = w.add(storey, 'sweep', 'Antablament', 'portico_entablature', at(f, centre, dCol), {
    ...SWEEP_DEFAULTS, sweep_role: 'beam', profile: 'rect', p_w_mm: dia + 80, p_h_mm: ENTABLATURE_MM,
    anchor_x: 'mid', anchor_y: 'max', offset_x_mm: 0, level: 'top', offset_z_mm: -PORTICO_SLAB_MM,
    ifc_type: 'IFCBEAM', material: finish, ...trim,
  });
  w.wire(ent, [wallL, ...colIds, wallR]);
  ids.push(wallL, wallR, ent);

  const a0 = stations[0] - dia / 2 - 200, a1 = stations[n - 1] + dia / 2 + 200;
  ids.push(slab(w, storey, 'Acoperiș portic', 'portico_roof', rect(f, a0, a1, d0, d1 + 150), -PORTICO_SLAB_MM, PORTICO_SLAB_MM, finish, 'IFCSLAB', 'top', trim));
  ids.push(...platform(w, m, f, a0, a1, d0, d1, p, groundMaterial(p), 'portic'));
  const stepIds = steps(w, m, f, centre, Math.min(span, door.widthMm + 1600), d1, p);
  ids.push(...stepIds);

  w.cover(storey.id, f, a0, a1);
  w.figures.portico_columns = n;
  w.change('porch', 'add',
    `Portic ${((a1 - a0) / 1000).toFixed(2)} × ${((d1 - d0) / 1000).toFixed(2)} m: ${n} coloane Ø${dia}, antablament, acoperiș plat${stepsText(stepIds.length)}`,
    ids);
}

// ── Rule: entrance — canopy, or just the steps ────────────────────────────────

function ruleCanopy(w: Work, m: StoreyInfo, f: Facade, door: FacadeDoor, outer: number, p: StyleParams) {
  const storey = m.storey;
  const depth = Number(p.porch_depth_mm);
  const width = door.widthMm + 1400;
  const z = Math.min(door.heightMm + 250, m.top - m.bot - CANOPY_MM - 100);
  const ids = [slab(w, storey, 'Copertină', 'canopy', rect(f, door.along - width / 2, door.along + width / 2, outer, outer + depth),
    z, CANOPY_MM, 'Beton aparent', 'IFCSLAB')];
  const stepIds = landing(w, m, f, door, outer, Math.min(depth - 100, 1500), p, ids);
  w.change('porch', 'add', `Copertină ${(width / 1000).toFixed(2)} × ${(depth / 1000).toFixed(2)} m la +${Math.round(z)} mm${stepIds ? ', podest' : ''}${stepsText(stepIds)}`, ids);
}

/** A landing in front of the door and the steps down to it; returns the step count. */
function landing(w: Work, m: StoreyInfo, f: Facade, door: FacadeDoor, outer: number, depth: number, p: StyleParams, ids: string[]): number {
  if (Number(p.floor_raise_mm) < 50) return 0;
  const d0 = outer + (plinthOn(p) ? PLINTH_PROJ_MM : 0);
  const d1 = d0 + Math.max(900, depth);
  const half = door.widthMm / 2 + 500;
  w.cover(m.storey.id, f, door.along - half, door.along + half);
  ids.push(...platform(w, m, f, door.along - half, door.along + half, d0, d1, p, groundMaterial(p), 'podest'));
  const stepIds = steps(w, m, f, door.along, 2 * half, d1, p);
  ids.push(...stepIds);
  return stepIds.length;
}

// ── Rule: every other exterior door ───────────────────────────────────────────

/**
 * A door to the outside that the entrance rule did not treat gets somewhere
 * to step out to: on the ground floor a terrace at floor level with steps down
 * to the ground; above it, a balcony slab with a guard. Doors close together
 * on one front share one terrace; a door already in front of a porch, a
 * portico or a balcony is left alone.
 */
function ruleDoors(w: Work, storeys: StoreyInfo[], main: StoreyInfo, outers: Map<string, number>, p: StyleParams, entranceDoor: string | null) {
  const terraceDepth = Number(p.terrace_depth_mm);
  const terraces: string[] = [], balconies: string[] = [];
  let doors = 0, groundDoors = 0, flights = 0, nBalc = 0;
  for (const m of storeys) {
    const ground = m.storey.id === main.storey.id;
    if (ground ? !p.terraces : !p.balconies) continue;
    const outer = outers.get(m.storey.id) ?? m.outerOffsetMm;
    const d0 = outer + (ground && plinthOn(p) ? PLINTH_PROJ_MM : 0);
    for (const f of m.facades) {
      // Door ids are only unique within their wall's list — a storey copied
      // from the ground floor repeats them — so the entrance is excluded by
      // storey as well as by id.
      const list = f.doors.filter((d) => !(ground && d.id === entranceDoor) && !w.isCovered(m.storey.id, f, d));
      if (!list.length) continue;
      // One stretch per door, merged where they touch; kept on the front.
      const spans = list
        .map((d) => {
          const half = ground ? Math.max(d.widthMm / 2 + 600, 1100) : d.widthMm / 2 + 500;
          return { s0: Math.max(-d0, d.along - half), s1: Math.min(f.lengthMm + d0, d.along + half), doors: [d] };
        })
        .sort((a, b) => a.s0 - b.s0);
      const groups: typeof spans = [];
      for (const sp of spans) {
        const last = groups[groups.length - 1];
        if (last && sp.s0 <= last.s1 + 300) {
          last.s1 = Math.max(last.s1, sp.s1);
          last.doors.push(...sp.doors);
        } else groups.push({ ...sp, doors: [...sp.doors] });
      }
      for (const g of groups) {
        doors += g.doors.length;
        w.cover(m.storey.id, f, g.s0, g.s1);
        if (ground) {
          groundDoors += g.doors.length;
          const d1 = d0 + terraceDepth;
          const ids = platform(w, m, f, g.s0, g.s1, d0, d1, p, String(p.terrace_material || 'Lemn'), 'terasă');
          // The steps down from the middle of the doors, as wide as the widest plus a margin.
          const centre = g.doors.reduce((acc, d) => acc + d.along, 0) / g.doors.length;
          const width = Math.min(g.s1 - g.s0, Math.max(...g.doors.map((d) => d.widthMm)) + 600);
          const stepIds = steps(w, m, f, Math.min(Math.max(centre, g.s0 + width / 2), g.s1 - width / 2), width, d1, p);
          if (stepIds.length) flights++;
          terraces.push(...ids, ...stepIds);
        } else {
          const depth = Math.min(terraceDepth, 1500);
          const ids = [slab(w, m.storey, 'Balcon', 'balcony', rect(f, g.s0, g.s1, outer, outer + depth),
            -BALCONY_SLAB_MM, BALCONY_SLAB_MM, 'Beton armat', 'IFCSLAB')];
          ids.push(...guard(w, m.storey, f, g.s0, g.s1, outer, outer + depth,
            Math.max(GUARD_MIN_MM, Number(p.parapet_h_mm)), p, 'Parapet balcon', 'balcony_rail'));
          balconies.push(...ids);
          nBalc++;
        }
      }
    }
  }
  if (terraces.length) {
    w.change('porch', 'add', `Terasă ${(terraceDepth / 1000).toFixed(2)} m din ${String(p.terrace_material).toLowerCase()} la ${groundDoors === 1 ? 'ușa' : `cele ${groundDoors} uși`} de la parter${flights ? `, ${flights} ${flights === 1 ? 'scară' : 'scări'} până la teren` : ''}`, terraces);
  }
  if (nBalc) w.change('porch', 'add', `${nBalc} ${nBalc === 1 ? 'balcon' : 'balcoane'} la ușile de la etaj, cu parapet`, balconies);
  w.figures.door_terraces = doors;
}

// ── Rule: roof ────────────────────────────────────────────────────────────────

function ruleRoof(w: Work, main: StoreyInfo, roofStorey: StoreyInfo, outer: number, p: StyleParams, plan: PorchPlan | null, entrance: Facade | null): string | null {
  const type = String(p.roof_type) as RoofType;
  let roofId = roofStorey.roof?.id ?? null;
  if (!roofId) {
    const made = createRoofForStorey(roofStorey.storey.id, w.nodes, w.edges, {
      roofType: type, pitchDeg: Number(p.roof_pitch_deg), generateLevel: type === 'flat' ? 'envelope' : 'framing',
    });
    if (!made.roofId) {
      w.issue('error', made.diagnostics[0]?.message ?? 'Nu am putut crea acoperișul.');
      return null;
    }
    w.nodes = made.nodes;
    w.edges = made.edges;
    roofId = made.roofId;
    w.nodes = w.nodes.map((n) => (n.id === roofId
      ? { ...n, properties: { ...n.properties, [STYLE_PART_KEY]: 'roof', [STYLE_PACK_KEY]: w.packId } }
      : n));
    w.change('roof', 'add', 'Acoperiș nou pe conturul etajului', [roofId]);
  }
  const roof = w.get(roofId)!;
  const t = roofStorey.wallThicknessMm;
  const finish = String(p.wall_finish || 'Tencuială de var');

  // How far out the roof's own contour already reaches on a front — the
  // overhang is measured from there, the style's overhang from the facade.
  const contour = resolveRoofContour(roof, w.nodes, w.edges, 0, []);
  const reach = (f: Facade) => Math.max(...(contour?.points ?? [f.a]).map((q) => (q.x - f.a.x) * f.n.x + (q.y - f.a.y) * f.n.y));
  const front = plan?.facade ?? entrance ?? roofStorey.facades[0];
  const c0 = front ? reach(front) : 0;
  const common = {
    covering_material: String(p.roof_covering),
    ...(Number(roof.properties.obj_translate_z ?? 0) !== 0 ? { obj_translate_z: 0 } : {}),
  };

  if (type === 'flat') {
    // The slab stops at the inner face of the walls; the parapet takes the rest.
    const overhang = -Math.round(c0 + t / 2);
    w.modify(roofId, { ...common, roof_type: 'flat', overhang_mm: overhang, eave_z_offset_mm: 0, generate_level: 'envelope' });
    const hPar = Number(p.roof_parapet_h_mm);
    const atic = w.add(roofStorey.storey, 'sweep', 'Atic', 'roof_parapet', roofStorey.loop[0].p, {
      ...SWEEP_DEFAULTS, sweep_role: 'generic', profile: 'rect', p_w_mm: Math.round(outer + t / 2), p_h_mm: hPar,
      anchor_x: 'min', anchor_y: 'min', offset_x_mm: Math.round(-t / 2), level: 'top', offset_z_mm: 0,
      closed: 'True', ifc_type: 'IFCWALL', material: finish, ...colour(p.wall_color),
    });
    w.wire(atic, clockwise(roofStorey));
    const coping = w.add(roofStorey.storey, 'sweep', 'Șorț atic', 'roof_coping', roofStorey.loop[0].p, {
      ...SWEEP_DEFAULTS, sweep_role: 'coping', profile: 'rect', p_w_mm: Math.round(outer + t / 2 + 60), p_h_mm: 50,
      anchor_x: 'min', anchor_y: 'min', offset_x_mm: Math.round(-t / 2 - 30), level: 'top', offset_z_mm: hPar,
      closed: 'True', ifc_type: 'IFCCOVERING', material: 'Tablă', color_3d: '#5A5E63', color_2d: '#5A5E63',
    });
    w.wire(coping, clockwise(roofStorey));
    w.figures.eave_z_mm = Math.round(roofStorey.top + hPar);
    w.change('roof', 'modify', `Terasă cu ${String(p.roof_covering).toLowerCase()}, atic de ${hPar} mm cu șorț de tablă`, [roofId, atic, coping]);
  } else {
    const pitch = Number(p.roof_pitch_deg);
    const tan = Math.tan((pitch * Math.PI) / 180);
    let overhang = (outer - c0) + Number(p.roof_overhang_mm);
    if (plan) overhang = Math.max(overhang, plan.d1 + EAVE_MARGIN_MM - c0);
    const eaveFromFace = c0 + overhang - outer;

    // How the roof sits. On the walls: the rafters' underside meets the outer
    // face at the top of the wall (plus a knee wall where a porch needed one)
    // and the eave is where the slope has fallen to. Over a frieze: the wall
    // rises until the eave's underside is at the top of the storey.
    const same = roofStorey.storey.id === main.storey.id;
    let lift = same && plan ? plan.lift : 0;
    const frieze = p.roof_seat === 'frieze';
    if (frieze) lift = Math.max(lift, eaveFromFace * tan);
    const rafter = parseTimberSection(String(roof.properties.rafter_section ?? 'T8x16')).h * 1000;
    const allowance = rafter / Math.cos((pitch * Math.PI) / 180);
    const eaveOffset = Math.round(lift + allowance - eaveFromFace * tan);

    const patch: Record<string, unknown> = {
      ...common,
      roof_type: type,
      pitch_deg: pitch,
      overhang_mm: Math.round(overhang),
      eave_z_offset_mm: eaveOffset,
      ...(type === 'mansard' ? { upper_pitch_deg: Number(p.roof_upper_pitch_deg) } : {}),
    };
    if (roof.properties.generate_level == null || roof.properties.generate_level === 'envelope') patch.generate_level = 'framing';
    w.modify(roofId, patch);
    w.figures.roof_overhang_mm = Math.round(eaveFromFace);
    w.figures.eave_z_mm = Math.round(roofStorey.top + eaveOffset);
    w.figures.wall_plate_lift_mm = Math.round(lift);
    w.figures.roof_slope = tan;
    const names: Record<string, string> = {
      hip: 'în patru ape', gable: 'în două ape', shed: 'într-o apă', mansard: 'mansardă',
    };
    w.change('roof', 'modify',
      `Acoperiș ${names[type] ?? type} la ${pitch}°${type === 'mansard' ? `/${p.roof_upper_pitch_deg}°` : ''}, ${String(p.roof_covering).toLowerCase()}, streașină ${Math.round(eaveFromFace)} mm peste fațadă, cu marginea la +${Math.round(roofStorey.top + eaveOffset)} mm`,
      [roofId]);

    // A knee wall (for the porch's headroom) or a frieze (for the eave line).
    if (lift >= 20) {
      const id = w.add(roofStorey.storey, 'sweep', frieze ? 'Friză' : 'Cosoroabă — perete de pod', 'knee_wall', roofStorey.loop[0].p, {
        ...SWEEP_DEFAULTS, sweep_role: 'generic', profile: 'rect', p_w_mm: Math.round(outer + t / 2), p_h_mm: Math.round(lift),
        anchor_x: 'min', anchor_y: 'min', offset_x_mm: Math.round(-t / 2), level: 'top', offset_z_mm: 0,
        closed: 'True', ifc_type: 'IFCWALL', material: String(p.wall_finish || 'Cărămidă'), ...colour(p.wall_color),
      });
      w.wire(id, clockwise(roofStorey));
      w.change('roof', 'add', frieze
        ? `Friză de ${Math.round(lift)} mm peste ziduri, până sub streașină`
        : `Cosoroabă ridicată ${Math.round(lift)} mm peste ziduri, ca streașina să treacă peste prispă`, [id]);
    }
  }

  const solved = solveRoof({ nodes: w.nodes, edges: w.edges, roofId });
  const applied = applyRoofResult(w.nodes, w.edges, solved);
  w.nodes = applied.nodes;
  w.edges = applied.edges;
  for (const e of solved.diagnostics) if (e.severity === 'error') w.issue('error', `Acoperiș: ${e.message}`);
  return roofId;
}

// ── Rule: trim ────────────────────────────────────────────────────────────────

/**
 * Cornice at the top of the wall under the roof (or of the frieze); pilasters
 * at the outer corners of the ground floor, rising through every storey above
 * that has the same corner — the full height of the front.
 */
function ruleTrim(w: Work, storeys: StoreyInfo[], main: StoreyInfo, roofStorey: StoreyInfo, outers: Map<string, number>, p: StyleParams) {
  const lift = w.figures.wall_plate_lift_mm ?? 0;
  const finish = String(p.wall_finish || 'Tencuială de var');
  const trim = trimColour(p);
  if (p.cornice) {
    // Its top follows the rafters' underside out to its front edge, so the
    // roof passes over it rather than through it.
    const top = lift - CORNICE_PROJ_MM * (w.figures.roof_slope ?? 0);
    const id = w.add(roofStorey.storey, 'sweep', 'Cornișă', 'cornice', roofStorey.loop[0].p, {
      ...SWEEP_DEFAULTS, sweep_role: 'cornice', profile: 'rect', p_w_mm: CORNICE_PROJ_MM, p_h_mm: CORNICE_H_MM,
      anchor_x: 'min', anchor_y: 'max', offset_x_mm: outers.get(roofStorey.storey.id) ?? roofStorey.outerOffsetMm,
      level: 'top', offset_z_mm: Math.round(top),
      closed: 'True', ifc_type: 'IFCCOVERING', material: finish, ...trim,
    });
    w.wire(id, clockwise(roofStorey));
    w.change('envelope', 'add', `Cornișă ${CORNICE_H_MM} mm, ieșită ${CORNICE_PROJ_MM} mm din fațadă`, [id]);
  }
  if (p.pilasters) {
    const outer = outers.get(main.storey.id) ?? main.outerOffsetMm;
    const ids: string[] = [];
    const convex = (m: StoreyInfo) => {
      const pts = m.loop.map((v) => v.p);
      const N = pts.length;
      const out: { b: Pt2; n1: Pt2; n2: Pt2 }[] = [];
      for (let i = 0; i < N; i++) {
        const a = pts[(i - 1 + N) % N], b = pts[i], c = pts[(i + 1) % N];
        const t1 = { x: b.x - a.x, y: b.y - a.y }, t2 = { x: c.x - b.x, y: c.y - b.y };
        const l1 = Math.hypot(t1.x, t1.y), l2 = Math.hypot(t2.x, t2.y);
        if (l1 < 1 || l2 < 1) continue;
        if ((t1.x * t2.y - t1.y * t2.x) / (l1 * l2) < 0.5) continue;     // only the outer (convex) corners
        out.push({ b, n1: { x: t1.y / l1, y: -t1.x / l1 }, n2: { x: t2.y / l2, y: -t2.x / l2 } });
      }
      return out;
    };
    const above = storeys.filter((s) => s.bot > main.bot).sort((a, b) => a.bot - b.bot);
    let tallest = 1;
    for (const { b, n1, n2 } of convex(main)) {
      // Up through each storey that sits right on the last and turns the same corner.
      let top = main.top, levels = 1, reachesRoof = roofStorey.storey.id === main.storey.id;
      for (const s of above) {
        if (Math.abs(s.bot - top) > 50) break;
        if (!convex(s).some((c) => Math.hypot(c.b.x - b.x, c.b.y - b.y) < 60)) break;
        top = s.top;
        levels++;
        reachesRoof = s.storey.id === roofStorey.storey.id;
      }
      tallest = Math.max(tallest, levels);
      const k = outer + PILASTER_PROJ_MM - PILASTER_MM / 2;
      const q = { x: b.x + (n1.x + n2.x) * k, y: b.y + (n1.y + n2.y) * k };
      const ax = w.point(main.storey, q, `Pilastru ${ids.length / 2 + 1}`, 'pilaster_axis');
      const sw = w.add(main.storey, 'sweep', `Pilastru ${ids.length / 2 + 1}`, 'pilaster', q, {
        ...SWEEP_DEFAULTS, sweep_role: 'pilaster', profile: 'rect', p_w_mm: PILASTER_MM, p_h_mm: PILASTER_MM,
        anchor_x: 'mid', anchor_y: 'mid', offset_x_mm: 0, level: 'bottom', offset_z_mm: 0,
        height_mm: Math.round(top - main.bot + (reachesRoof ? lift : 0)), ifc_type: 'IFCCOLUMN', material: finish, ...trim,
      });
      w.wire(sw, [ax]);
      ids.push(ax, sw);
    }
    if (ids.length) w.change('envelope', 'add', `${ids.length / 2} pilaștri la colțuri, ${PILASTER_MM} mm${tallest > 1 ? `, pe ${tallest} niveluri` : ''}`, ids);
  }
}

// ── Rule: eyebrow dormers ─────────────────────────────────────────────────────

/**
 * Lucarne „ochi” on the slopes: one per slope whose eave runs along a facade
 * (two on a front over 12 m), centred on it, the front edge just inside the
 * wall face — low on the roof, where these houses have them. A spot the
 * eyebrow does not fit in (a narrow hip end, a slope too flat) is skipped and
 * said so; the rest go ahead.
 */
function ruleEyebrows(w: Work, roofStorey: StoreyInfo, roofId: string, outer: number, p: StyleParams, entrance: Facade | null) {
  const mode = String(p.roof_dormers);
  if (mode === 'none' || p.roof_type === 'flat') return;
  const roof = w.get(roofId);
  if (!roof) return;
  const { faces } = computeRoofFaces(roof, w.nodes, w.edges);
  const covering = Number(roof.properties.covering_thickness_mm ?? 40) || 40;
  const facades = mode === 'front' ? (entrance ? [roofStorey.facades.find((f) => f === entrance) ?? entrance] : []) : roofStorey.facades;
  const ids: string[] = [];
  let skipped = 0;
  for (const f of facades) {
    // The slope over this front: its up-slope direction points back into the house.
    const host = faces.find((face) => {
      if (face.role !== 'slope') return false;
      const b = computeFaceBasis(face);
      if (!b) return false;
      const l = Math.hypot(b.v.x, b.v.y) || 1;
      return -(b.v.x * f.n.x + b.v.y * f.n.y) / l > 0.9;
    });
    if (!host) { skipped++; continue; }
    const k = Math.min(3, Math.floor(f.lengthMm / 12000) + 1);
    for (let i = 0; i < k; i++) {
      const s = (f.lengthMm * (i + 0.5)) / k;
      const q = at(f, s, outer - 200);
      const props = {
        dormer_type: 'eyebrow', width_mm: Number(p.dormer_width_mm), rise_mm: Number(p.dormer_rise_mm),
        flare_mm: Math.round(Number(p.dormer_width_mm) * 0.65), depth_mm: Math.round(Number(p.dormer_rise_mm) * 2),
        overhang_mm: 250, material: String(p.wall_finish || 'Tencuială de var'), ...colour(p.wall_color),
        soffit_material: 'Lemn masiv', soffit_color: String(p.woodwork_color || '#C8955A'),
      };
      const g = placeEyebrow([host], eyebrowIntentOf({ x: q.x, y: q.y, properties: props }, covering));
      if (!g || !g.ok) { skipped++; continue; }
      const id = w.add(roofStorey.storey, 'dormer', 'Lucarnă ochi', 'eyebrow', q, props);
      // A dormer's own x/y ARE its plan position (BIM mm) — not a canvas spot.
      w.nodes = w.nodes.map((n) => (n.id === id ? { ...n, x: r1(q.x), y: r1(q.y) } : n));
      ids.push(id);
    }
  }
  if (ids.length) {
    w.change('roof', 'add', `${ids.length} ${ids.length === 1 ? 'lucarnă' : 'lucarne'} „ochi”, fereastră ${p.dormer_width_mm} mm, înălțime ${p.dormer_rise_mm} mm`, ids);
  }
  if (skipped) {
    w.issue('info', `${skipped} ${skipped === 1 ? 'lucarnă n-a încăput' : 'lucarne n-au încăput'} pe apa lor (apă prea îngustă sau prea plată) — le-am omis.`);
  }
}

// ── Rule: fronton over the cerdac ─────────────────────────────────────────────

/**
 * The cerdac's fronton: a gablet on the slope over the door bay, its front on
 * the post line, as wide as the bay and a post either side — the pediment
 * and its little roof (`roof/gablet.ts`), a sun of tin on its face.
 */
function ruleFronton(w: Work, storey: StoreyInfo, roofId: string, plan: PorchPlan, built: PorchBuilt, door: FacadeDoor, p: StyleParams) {
  const roof = w.get(roofId);
  if (!roof) return;
  const { faces } = computeRoofFaces(roof, w.nodes, w.edges);
  const covering = Number(roof.properties.covering_thickness_mm ?? 40) || 40;
  const post = Number(p.post_size_mm);
  const f = plan.facade;
  const bay = built.gap ? built.stations[built.gap[1]] - built.stations[built.gap[0]] : door.widthMm + 1200;
  const centre = built.gap ? (built.stations[built.gap[0]] + built.stations[built.gap[1]]) / 2 : door.along;
  const pitch = Math.min(60, Math.max(45, Number(p.roof_pitch_deg) + 12));
  const decorColour = String(p.plinth_color || p.brau_color || '#2E5E8C');
  for (const width of [bay + post + 400, bay + post, 2400]) {
    const q = at(f, centre, plan.dPost);
    const props = {
      dormer_type: 'gablet', width_mm: Math.round(width), pitch_deg: pitch, overhang_mm: 200, wall_mm: 60, decor: 'True',
      material: 'Lemn masiv', ...colour(p.woodwork_color), decor_material: 'Tablă', decor_color: decorColour,
    };
    const g = placeGablet(faces, gabletIntentOf({ x: q.x, y: q.y, properties: props }, covering));
    if (!g || !g.ok) continue;
    const id = w.add(storey.storey, 'dormer', 'Fronton', 'fronton', q, props);
    w.nodes = w.nodes.map((n) => (n.id === id ? { ...n, x: r1(q.x), y: r1(q.y) } : n));
    w.change('porch', 'add', `Fronton peste intrare, ${(width / 1000).toFixed(2)} m lat, ${pitch}°, cu soare de tablă`, [id]);
    return;
  }
  w.issue('info', 'Frontonul nu încape pe apa de deasupra intrării (apă prea plată sau prea îngustă) — l-am omis.');
}

// ── Rule: chimney ─────────────────────────────────────────────────────────────

/** Height of the roof surface above a plan point, from the faces the solver built. */
function roofZAt(faces: { vertices: { x: number; y: number; z: number }[] }[], q: Pt2): number | null {
  let best: number | null = null;
  for (const f of faces) {
    const v = f.vertices;
    if (v.length < 3) continue;
    let inside = false;
    for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
      if ((v[i].y > q.y) !== (v[j].y > q.y) && q.x < ((v[j].x - v[i].x) * (q.y - v[i].y)) / (v[j].y - v[i].y) + v[i].x) inside = !inside;
    }
    if (!inside) continue;
    // Plane through the face (Newell normal), solved for z.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length];
      nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
    }
    if (Math.abs(nz) < 1e-9) continue;
    const z = v[0].z - (nx * (q.x - v[0].x) + ny * (q.y - v[0].y)) / nz;
    best = best == null ? z : Math.max(best, z);
  }
  return best;
}

function ruleChimney(w: Work, roofStorey: StoreyInfo, roofId: string, entrance: Facade | null) {
  const roof = w.get(roofId);
  if (!roof) return;
  const { faces } = computeRoofFaces(roof, w.nodes, w.edges);
  const pts = roofStorey.loop.map((v) => v.p);
  const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length;
  const cy = pts.reduce((s, q) => s + q.y, 0) / pts.length;
  // Off the ridge, towards the back: the stack of a stove, not a finial.
  const back = entrance ? { x: -entrance.n.x, y: -entrance.n.y } : { x: 0, y: 1 };
  const span = Math.min(...roofStorey.facades.map((f) => f.lengthMm));
  const q = { x: cx + back.x * span * 0.18, y: cy + back.y * span * 0.18 };
  const h = CHIMNEY_MM / 2;
  const corners = [{ x: q.x - h, y: q.y - h }, { x: q.x + h, y: q.y - h }, { x: q.x + h, y: q.y + h }, { x: q.x - h, y: q.y + h }];
  const zs = corners.map((c) => roofZAt(faces, c)).filter((z): z is number => z != null);
  if (!zs.length) { w.issue('info', 'Hornul nu cade sub acoperiș — nu l-am adăugat.'); return; }
  const top = Math.max(...zs) + CHIMNEY_CLEAR_MM;
  const id = slab(w, roofStorey.storey, 'Horn', 'chimney', corners, 0, top - roofStorey.top, 'Cărămidă', 'IFCBUILDINGELEMENTPROXY', 'top');
  w.change('details', 'add', `Horn de cărămidă, ${Math.round(top - roofStorey.top)} mm peste planșeu`, [id]);
}

// ── Checks ────────────────────────────────────────────────────────────────────

/** Every generated element must solve: run the solvers on them and report what fails. */
function check(w: Work) {
  const nodeMap = new Map(w.nodes.map((n) => [n.id, n]));
  for (const n of w.nodes) {
    if (n.properties[STYLE_PART_KEY] == null) continue;
    if (n.type === 'sweep') {
      const res = computeSweep(n, nodeMap, w.edges);
      const err = res.diagnostics.find((d) => d.severity === 'error');
      if (err || !res.solids.length) w.issue('error', `${n.name}: ${err?.message ?? 'nu s-a putut construi'}`);
    } else if (n.type === 'sketch') {
      const res = computeSketch(n, nodeMap, w.edges);
      const err = res.diagnostics.find((d) => d.severity === 'error');
      if (err || !res.copies.length) w.issue('error', `${n.name}: ${err?.message ?? 'nu s-a putut construi'}`);
    }
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────

export function applyStyle(
  nodes: BubbleGraphNode[], edges: BubbleGraphEdge[],
  packId: string, given: Partial<StyleParams> = {},
): StyleResult {
  const pack = STYLE_PACK_MAP.get(packId);
  if (!pack) {
    return { nodes, edges, changes: [], issues: [{ severity: 'error', text: `Stil necunoscut: ${packId}` }], figures: {} };
  }
  const p = resolveParams(pack, given);
  const clean = removeStyle(nodes, edges);
  const w = new Work([...clean.nodes], [...clean.edges], pack.id);
  if (clean.removed || clean.restored) {
    w.change('details', 'remove', `Stilul aplicat anterior a fost înlocuit (${clean.removed} elemente scoase, ${clean.restored} readuse)`);
  }

  let info = analyzeBuilding(w.nodes, w.edges);
  if (!info.main) {
    return { nodes, edges, changes: [], issues: info.notes.map((text) => ({ severity: 'warning' as const, text })), figures: {} };
  }
  // Windows first, on every storey: the rest reads the openings they leave.
  const levels = info.storeys.length ? info.storeys : [info.main];
  for (const s of levels) ruleWindows(w, s, p, levels.length > 1 ? ` (${s.storey.name || 'etaj'})` : '');
  info = analyzeBuilding(w.nodes, w.edges);
  for (const n of info.notes) w.issue('warning', n);
  const main = info.main!;
  const roofStorey = info.roofStorey ?? main;
  const storeys = info.storeys.length ? info.storeys : [main];
  w.figures.outline_source = main.loopSource === 'shell' ? 1 : main.loopSource === 'roof' ? 2 : 3;
  w.figures.storeys = storeys.length;

  const outers = ruleEnvelope(w, storeys, main, p);
  const outer = outers.get(main.storey.id) ?? main.outerOffsetMm;
  const above = storeys.find((s) => Math.abs(s.bot - main.top) < 50) ?? null;

  const entrance = info.entrance;
  const kind = String(p.entrance);
  let plan: PorchPlan | null = null;
  let porch: PorchBuilt | null = null;
  if (!entrance) {
    if (kind !== 'none') w.issue('warning', 'Intrarea n-a fost tratată: nicio ușă într-un perete exterior.');
  } else if (kind === 'prispa' || kind === 'cerdac') {
    plan = planPorch(main, entrance.facade, outer, p, roofStorey.storey.id === main.storey.id, w);
    porch = rulePorch(w, main, plan, entrance.door, p, above);
  } else if (kind === 'portic') {
    rulePortico(w, main, entrance.facade, entrance.door, outer, p);
  } else if (kind === 'copertina') {
    ruleCanopy(w, main, entrance.facade, entrance.door, outer, p);
  } else {
    const ids: string[] = [];
    const n = landing(w, main, entrance.facade, entrance.door, outer, 1200, p, ids);
    if (ids.length) w.change('porch', 'add', `Podest în fața ușii${stepsText(n)}`, ids);
  }

  ruleDoors(w, storeys, main, outers, p, entrance?.door.id ?? null);

  // A porch with its own slab is not the roof's to cover.
  const roofOuter = outers.get(roofStorey.storey.id) ?? roofStorey.outerOffsetMm;
  const roofId = ruleRoof(w, main, roofStorey, roofOuter, p, plan && !plan.slab ? plan : null, entrance?.facade ?? null);
  ruleTrim(w, storeys, main, roofStorey, outers, p);
  if (roofId) ruleEyebrows(w, roofStorey, roofId, roofOuter, p, entrance?.facade ?? null);
  if (roofId && kind === 'cerdac' && plan && porch && entrance) {
    if (plan.slab) w.issue('info', 'Cerdacul are un etaj deasupra — frontonul stă pe acoperiș, așa că l-am omis.');
    else ruleFronton(w, roofStorey, roofId, plan, porch, entrance.door, p);
  }
  if (roofId && p.chimney) ruleChimney(w, roofStorey, roofId, entrance?.facade ?? null);

  w.modify(main.storey.id, { [STYLE_PACK_KEY]: pack.id, [STYLE_PARAMS_KEY]: JSON.stringify(p) });
  check(w);
  return { nodes: w.nodes, edges: w.edges, changes: w.changes, issues: w.issues, figures: w.figures };
}

/** The style a project was last given, read back from its main storey. */
export function readAppliedStyle(nodes: BubbleGraphNode[]): { packId: string; params: StyleParams } | null {
  for (const n of nodes) {
    if (n.type !== 'storey' || n.properties[STYLE_PACK_KEY] == null) continue;
    let params: StyleParams = {};
    try { params = JSON.parse(String(n.properties[STYLE_PARAMS_KEY] ?? '{}')); } catch { params = {}; }
    return { packId: String(n.properties[STYLE_PACK_KEY]), params };
  }
  return null;
}
