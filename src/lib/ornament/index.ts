/**
 * ornament — what an envelope carries on its face: window and door surrounds
 * (encadramente), sills outside (solbanc) and in (glaf), and corner dressings
 * (bosaje, corner boards, metal angles).
 *
 * They are PROPERTIES OF THE SHELL, not nodes of their own. A surround belongs
 * to the opening it frames: move the window and it goes with it, widen it and
 * the surround widens, delete it and the surround is gone — none of which a
 * set of loose boxes in the graph would do. The shell knows the outer face
 * (its contour offset and thickness) and its storey; the walls behind it know
 * where their openings are. So the geometry is computed here, from both, and
 * every consumer — the 3D view, the IFC export — draws the same solids:
 *
 *   orn_window   none | band | classic | traditional | modern
 *   orn_sill     none | stone | metal | wood          (solbanc, outside)
 *   orn_glaf     none | wood | stone | pvc            (glaf, inside)
 *   orn_corner   none | quoins | boards | metal
 *   orn_doors    surround the doors too (default yes)
 *   orn_color    colour of the surrounds and corners (empty: the material's)
 *   orn_wood_color  colour of anything made of wood
 *
 * Every part is closed triangle solids in absolute BIM millimetres (z from
 * ±0.00), wound outward — the shape the IFC writer turns into a faceted B-rep.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import {
  calcShellPolygon, collectOpenings, getConnectedNodesWithGrips, getGripBimPos,
  getNodeWallThickness, getStoreyBand, insetPolygon, parseContourOffsets,
} from '@/lib/bimGeometry';
import type { Pt2 } from '@/lib/geom/plan2d';
import type { Pt3 } from '@/lib/roof/types';
import type { Tri } from '@/lib/roof/eyebrow';

export type WindowTrim = 'none' | 'band' | 'classic' | 'traditional' | 'modern';
export type SillKind = 'none' | 'stone' | 'metal' | 'wood';
export type GlafKind = 'none' | 'wood' | 'stone' | 'pvc';
export type CornerTrim = 'none' | 'quoins' | 'boards' | 'metal';

export interface OrnamentIntent {
  window: WindowTrim;
  sill: SillKind;
  glaf: GlafKind;
  corner: CornerTrim;
  doors: boolean;
  color: string;
  woodColor: string;
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  (allowed as readonly string[]).includes(String(v)) ? (String(v) as T) : dflt;

export function ornamentIntentOf(props: Record<string, unknown>): OrnamentIntent {
  return {
    window: pick(props.orn_window, ['none', 'band', 'classic', 'traditional', 'modern'] as const, 'none'),
    sill: pick(props.orn_sill, ['none', 'stone', 'metal', 'wood'] as const, 'none'),
    glaf: pick(props.orn_glaf, ['none', 'wood', 'stone', 'pvc'] as const, 'none'),
    corner: pick(props.orn_corner, ['none', 'quoins', 'boards', 'metal'] as const, 'none'),
    doors: !(props.orn_doors === false || props.orn_doors === 'False' || props.orn_doors === 'false'),
    color: String(props.orn_color ?? ''),
    woodColor: String(props.orn_wood_color ?? ''),
  };
}

export const hasOrnament = (o: OrnamentIntent) =>
  o.window !== 'none' || o.sill !== 'none' || o.glaf !== 'none' || o.corner !== 'none';

/** One element's worth of ornament: an opening's surround, its sill, a corner. */
export interface OrnamentPart {
  /** Stable within the shell: `w3:trim`, `c1:corner`… — the IFC Tag suffix. */
  key: string;
  label: string;
  role: 'trim' | 'sill' | 'glaf' | 'corner';
  material: string;
  color: string;
  solids: Tri[][];
}

// ─── Solids ─────────────────────────────────────────────────────────────────

/**
 * A convex plan polygon extruded from z0 to z1, wound outward. The base is
 * made counter-clockwise first, so the caps and sides need no orientation
 * test of their own.
 */
export function prism(pts: Pt2[], z0: number, z1: number): Tri[] {
  if (pts.length < 3 || !(z1 - z0 > 0.5)) return [];
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  if (Math.abs(a) < 1) return [];
  const p = a > 0 ? pts : [...pts].reverse();
  const lo = p.map((q): Pt3 => ({ x: q.x, y: q.y, z: z0 }));
  const hi = p.map((q): Pt3 => ({ x: q.x, y: q.y, z: z1 }));
  const out: Tri[] = [];
  for (let i = 1; i < p.length - 1; i++) {
    out.push([hi[0], hi[i], hi[i + 1]]);
    out.push([lo[0], lo[i + 1], lo[i]]);
  }
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    out.push([lo[i], lo[j], hi[j]]);
    out.push([lo[i], hi[j], hi[i]]);
  }
  return out;
}

/** A frame on a facade: origin on the wall axis, `t` along it, `n` out of the house. */
interface FaceFrame { o: Pt2; t: Pt2; n: Pt2 }

const P = (f: FaceFrame, s: number, d: number): Pt2 => ({
  x: f.o.x + f.t.x * s + f.n.x * d, y: f.o.y + f.t.y * s + f.n.y * d,
});

/** A box on the facade: `s` along it, `d` out of the house (from the wall axis), `z` absolute. */
const box = (f: FaceFrame, s0: number, s1: number, d0: number, d1: number, z0: number, z1: number): Tri[] =>
  prism([P(f, s0, d0), P(f, s1, d0), P(f, s1, d1), P(f, s0, d1)], z0, z1);

// ─── Where the openings are, seen from the shell ─────────────────────────────

export interface ShellOpening {
  id: string;
  kind: 'window' | 'door';
  frame: FaceFrame;
  widthMm: number;
  heightMm: number;
  /** Absolute z of the sill (bottom of the opening). */
  z0: number;
  /** From the wall axis, outward: the outer face of the shell, the frame's outer and inner faces, the room face. */
  outerMm: number;
  frameOutMm: number;
  frameInMm: number;
  innerMm: number;
}

/** The shell's outer face, as a CCW polygon — what `ringSegments` puts on the outside. */
export function shellOuterPolygon(shell: BubbleGraphNode, nodeMap: Map<string, BubbleGraphNode>, edges: BubbleGraphEdge[]): Pt2[] | null {
  const poly = calcShellPolygon(shell, nodeMap, edges);
  if (!poly || poly.length < 3) return null;
  const offsets = parseContourOffsets(shell.properties.contour_offset);
  return insetPolygon(poly, offsets.map((o) => -o));
}

/**
 * The openings of the walls on the shell's storey that show through it: a
 * wall parallel to an outer-face edge, behind it within reach — the same test
 * the exporter uses to cut the shell (`ringVoids`), so a surround is drawn
 * exactly where the shell has a hole.
 */
export function shellOpenings(shell: BubbleGraphNode, nodeMap: Map<string, BubbleGraphNode>, edges: BubbleGraphEdge[]): ShellOpening[] {
  const outer = shellOuterPolygon(shell, nodeMap, edges);
  if (!outer) return [];
  const thick = Number(shell.properties.thickness ?? 200);
  const offsets = parseContourOffsets(shell.properties.contour_offset);
  const standOff = offsets.reduce((m, o) => Math.max(m, Math.abs(o)), 0) + thick;
  const { bot } = getStoreyBand(shell, nodeMap);
  const height = Number(shell.properties.height ?? 2800);
  const out: ShellOpening[] = [];

  for (const wall of nodeMap.values()) {
    if (wall.type !== 'wall' || wall.parentId !== shell.parentId) continue;
    const ends = getConnectedNodesWithGrips(wall.id, edges, nodeMap).filter(({ node }) => node.type === 'ax' || node.type === 'column');
    if (ends.length < 2) continue;
    const ga = getGripBimPos(ends[0].node, ends[0].gripIdx, nodeMap);
    const gb = getGripBimPos(ends[1].node, ends[1].gripIdx, nodeMap);
    const len = Math.hypot(gb.x - ga.x, gb.y - ga.y);
    if (len < 1) continue;
    const u = { x: (gb.x - ga.x) / len, y: (gb.y - ga.y) / len };
    const wallT = getNodeWallThickness(wall) * 1000;
    for (const op of collectOpenings(wall, len, edges, nodeMap)) {
      if (op.node.type !== 'window' && op.node.type !== 'door') continue;
      if (op.width < 1 || op.height < 1) continue;
      if (op.sillHeight >= height || op.sillHeight + op.height <= 0) continue;
      const along = Math.min(Math.max(op.distFromStart, 0), Math.max(0, len - op.width)) + op.width / 2;
      const c = { x: ga.x + u.x * along, y: ga.y + u.y * along };
      // The outer-face edge in front of it.
      let best: { t: Pt2; n: Pt2; dist: number } | null = null;
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i], b = outer[(i + 1) % outer.length];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        if (L < 1) continue;
        const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
        if (Math.abs(t.x * u.x + t.y * u.y) < 0.7) continue;
        const n = { x: t.y, y: -t.x };
        const s = (c.x - a.x) * t.x + (c.y - a.y) * t.y;
        if (s < -op.width / 2 || s > L + op.width / 2) continue;
        const dist = -((c.x - a.x) * n.x + (c.y - a.y) * n.y);   // wall axis is this far inside the face
        if (dist <= 0 || dist > standOff + wallT / 2 + 50) continue;
        if (!best || dist < best.dist) best = { t, n, dist };
      }
      if (!best) continue;
      const fd = op.frameDepth > 0 ? op.frameDepth : 100;
      const frameOut = Math.min(fd / 2, best.dist - 10);
      out.push({
        id: op.node.id,
        kind: op.node.type === 'door' ? 'door' : 'window',
        frame: { o: c, t: best.t, n: best.n },
        widthMm: op.width,
        heightMm: Math.min(op.height, height - op.sillHeight),
        z0: bot + op.sillHeight,
        outerMm: best.dist,
        frameOutMm: frameOut,
        frameInMm: -Math.min(fd / 2, wallT / 2 - 10),
        innerMm: -wallT / 2,
      });
    }
  }
  return out;
}

// ─── Surrounds ──────────────────────────────────────────────────────────────

const WOOD = '#8A5A33';
const METAL = '#3A3D40';

/** The boxes of one opening's surround, by style. `a` is half the width; z0/z1 bottom and head. */
function surround(kind: WindowTrim, o: ShellOpening): { solids: Tri[][]; dressed: number } {
  const f = o.frame, F = o.outerMm, a = o.widthMm / 2;
  const z0 = o.z0, z1 = o.z0 + o.heightMm;
  const win = o.kind === 'window';
  const s: Tri[][] = [];
  const add = (t: Tri[]) => { if (t.length) s.push(t); };
  let dressed = 0;   // how far the surround reaches out past the jamb — the sill clears it
  if (kind === 'band') {
    // A flat painted band round the opening, proud of the render.
    const b = 150, p = 25;
    add(box(f, -a - b, -a, F, F + p, z0, z1));
    add(box(f, a, a + b, F, F + p, z0, z1));
    add(box(f, -a - b, a + b, F, F + p, z1, z1 + b));
    if (win) add(box(f, -a - b, a + b, F, F + p, z0 - b, z0));
    dressed = b;
  } else if (kind === 'classic') {
    // Architrave, a frieze over it, a cornice cap; under the sill an apron on two consoles.
    const b = 160, p = 40;
    add(box(f, -a - b, -a, F, F + p, z0, z1));
    add(box(f, a, a + b, F, F + p, z0, z1));
    add(box(f, -a - b, a + b, F, F + p, z1, z1 + b));
    add(box(f, -a - b, a + b, F, F + p - 15, z1 + b, z1 + b + 140));
    add(box(f, -a - b - 70, a + b + 70, F, F + 120, z1 + b + 140, z1 + b + 220));
    if (win) {
      add(box(f, -a - b, a + b, F, F + p, z0 - 180, z0));
      for (const c of [-a - b / 2, a + b / 2]) add(box(f, c - 50, c + 50, F + p, F + 100, z0 - 240, z0 - 40));
    }
    dressed = b + 20;
  } else if (kind === 'traditional') {
    // Boards: jambs, a head board with ears and a drip cap, a board under the sill.
    const b = 120, p = 25;
    add(box(f, -a - b, -a, F, F + p, z0, z1));
    add(box(f, a, a + b, F, F + p, z0, z1));
    add(box(f, -a - b - 60, a + b + 60, F, F + 30, z1, z1 + 180));
    add(box(f, -a - b - 80, a + b + 80, F, F + 65, z1 + 180, z1 + 210));
    if (win) add(box(f, -a - b - 40, a + b + 40, F, F + 30, z0 - 120, z0));
    dressed = b + 40;
  } else if (kind === 'modern') {
    // A deep frame box from the window out past the face: plates top, sides and bottom.
    const tk = 40, d0 = o.frameOutMm, d1 = F + 220;
    add(box(f, -a - tk, -a, d0, d1, z0 - (win ? tk : 0), z1));
    add(box(f, a, a + tk, d0, d1, z0 - (win ? tk : 0), z1));
    add(box(f, -a - tk, a + tk, d0, d1, z1, z1 + tk));
    if (win) add(box(f, -a, a, d0, d1, z0 - tk, z0));
    dressed = tk;
  }
  return { solids: s, dressed };
}

function sillSolids(kind: SillKind, o: ShellOpening, dressed: number, trimProj: number): Tri[][] {
  const f = o.frame, F = o.outerMm, a = o.widthMm / 2;
  const t = kind === 'stone' ? 40 : kind === 'metal' ? 15 : 30;
  const proj = Math.max(kind === 'metal' ? 40 : 50, trimProj + 30);
  const ext = dressed ? dressed + 20 : 30;
  return [
    box(f, -a, a, o.frameOutMm, F, o.z0, o.z0 + t),                  // in the reveal, under the frame
    box(f, -a - ext, a + ext, F, F + proj, o.z0 - (kind === 'stone' ? 20 : 0), o.z0 + t),   // the nose, out over the face
  ].filter((x) => x.length);
}

function glafSolids(kind: GlafKind, o: ShellOpening): Tri[][] {
  const f = o.frame, a = o.widthMm / 2;
  const t = kind === 'stone' ? 30 : kind === 'pvc' ? 20 : 25;
  const I = o.innerMm;
  return [
    box(f, -a, a, I, o.frameInMm, o.z0, o.z0 + t),
    box(f, -a - 30, a + 30, I - 30, I, o.z0, o.z0 + t),
  ].filter((x) => x.length);
}

const TRIM_LOOK: Record<WindowTrim, (o: OrnamentIntent, shellMat: string) => { material: string; color: string }> = {
  none: () => ({ material: '', color: '' }),
  band: (o, m) => ({ material: m || 'Tencuială de var', color: o.color }),
  classic: (o, m) => ({ material: m || 'Tencuială de var', color: o.color }),
  traditional: (o) => ({ material: 'Lemn masiv', color: o.woodColor || WOOD }),
  modern: (o) => ({ material: 'Aluminiu', color: o.color || METAL }),
};

const SILL_LOOK: Record<Exclude<SillKind, 'none'>, { material: string; color: string; label: string }> = {
  stone: { material: 'Piatră', color: '#CFC8BA', label: 'Solbanc de piatră' },
  metal: { material: 'Tablă', color: '#5A5E63', label: 'Solbanc de tablă' },
  wood: { material: 'Lemn masiv', color: '', label: 'Solbanc de lemn' },
};

const GLAF_LOOK: Record<Exclude<GlafKind, 'none'>, { material: string; color: string; label: string }> = {
  wood: { material: 'Lemn', color: '', label: 'Glaf de lemn' },
  stone: { material: 'Piatră', color: '#E6E1D6', label: 'Glaf de marmură' },
  pvc: { material: 'PVC', color: '#F2F2F0', label: 'Glaf PVC' },
};

const TRIM_LABEL: Record<WindowTrim, string> = {
  none: '', band: 'Ancadrament', classic: 'Ancadrament clasic', traditional: 'Ancadrament de lemn', modern: 'Chenar',
};

// ─── Corners ────────────────────────────────────────────────────────────────

/**
 * One corner piece: two prisms, one on each face, meeting on the bisector, so
 * the corner square outside the face is filled once and mitred — no overlap.
 * `l1` runs back along the incoming face, `l2` on along the outgoing one.
 */
function cornerPiece(V: Pt2, t1: Pt2, t2: Pt2, p: number, l1: number, l2: number, z0: number, z1: number): Tri[][] {
  const n1 = { x: t1.y, y: -t1.x }, n2 = { x: t2.y, y: -t2.x };
  const k = p / (1 + n1.x * n2.x + n1.y * n2.y);
  const Vo = { x: V.x + (n1.x + n2.x) * k, y: V.y + (n1.y + n2.y) * k };
  const A = [{ x: V.x - t1.x * l1, y: V.y - t1.y * l1 }, V, Vo, { x: V.x - t1.x * l1 + n1.x * p, y: V.y - t1.y * l1 + n1.y * p }];
  const B = [V, { x: V.x + t2.x * l2, y: V.y + t2.y * l2 }, { x: V.x + t2.x * l2 + n2.x * p, y: V.y + t2.y * l2 + n2.y * p }, Vo];
  return [prism(A, z0, z1), prism(B, z0, z1)].filter((x) => x.length);
}

function cornerSolids(kind: CornerTrim, V: Pt2, t1: Pt2, t2: Pt2, z0: number, z1: number): Tri[][] {
  if (kind === 'boards') return cornerPiece(V, t1, t2, 25, 140, 140, z0, z1);
  if (kind === 'metal') return cornerPiece(V, t1, t2, 8, 60, 60, z0, z1);
  // Quoins: courses of 350, a 30 mm joint, long and short faces alternating.
  // The course count runs from ±0.00, so a storey above carries the bond on.
  const h = 350, joint = 30, long = 600, short = 350, p = 30;
  const out: Tri[][] = [];
  for (let k = Math.ceil(z0 / h - 1e-6); (k + 1) * h <= z1 + 1e-6; k++) {
    const even = k % 2 === 0;
    out.push(...cornerPiece(V, t1, t2, p, even ? long : short, even ? short : long, k * h, (k + 1) * h - joint));
  }
  return out;
}

const CORNER_LOOK: Record<Exclude<CornerTrim, 'none'>, (o: OrnamentIntent, shellMat: string) => { material: string; color: string; label: string }> = {
  quoins: (o, m) => ({ material: m || 'Tencuială de var', color: o.color, label: 'Bosaj de colț' }),
  boards: (o) => ({ material: 'Lemn masiv', color: o.woodColor || WOOD, label: 'Scândură de colț' }),
  metal: (o) => ({ material: 'Tablă', color: o.color || METAL, label: 'Cornier de colț' }),
};

// ─── Entry ──────────────────────────────────────────────────────────────────

/** Everything the shell's ornament properties ask for, as solids. */
export function shellOrnaments(shell: BubbleGraphNode, nodeMap: Map<string, BubbleGraphNode>, edges: BubbleGraphEdge[]): OrnamentPart[] {
  const o = ornamentIntentOf(shell.properties);
  if (!hasOrnament(o)) return [];
  const shellMat = String(shell.properties.material ?? '');
  const parts: OrnamentPart[] = [];

  if (o.window !== 'none' || o.sill !== 'none' || o.glaf !== 'none') {
    const ops = shellOpenings(shell, nodeMap, edges);
    ops.forEach((op, i) => {
      const isDoor = op.kind === 'door';
      let dressed = 0;
      let proj = 0;
      if (o.window !== 'none' && (!isDoor || o.doors)) {
        const sr = surround(o.window, op);
        dressed = sr.dressed;
        proj = o.window === 'modern' ? 220 : o.window === 'classic' ? 40 : 25;
        if (sr.solids.length) {
          const look = TRIM_LOOK[o.window](o, shellMat);
          parts.push({ key: `o${i}:trim`, label: TRIM_LABEL[o.window], role: 'trim', ...look, solids: sr.solids });
        }
      }
      if (isDoor) return;
      // The modern box has its own bottom plate: no separate sill.
      if (o.sill !== 'none' && o.window !== 'modern') {
        const look = SILL_LOOK[o.sill];
        const solids = sillSolids(o.sill, op, dressed, proj);
        if (solids.length) parts.push({ key: `o${i}:sill`, label: look.label, role: 'sill', material: look.material, color: o.sill === 'wood' ? o.woodColor : look.color, solids });
      }
      if (o.glaf !== 'none') {
        const look = GLAF_LOOK[o.glaf];
        const solids = glafSolids(o.glaf, op);
        if (solids.length) parts.push({ key: `o${i}:glaf`, label: look.label, role: 'glaf', material: look.material, color: o.glaf === 'wood' ? o.woodColor : look.color, solids });
      }
    });
  }

  if (o.corner !== 'none') {
    const outer = shellOuterPolygon(shell, nodeMap, edges);
    if (outer) {
      const { bot } = getStoreyBand(shell, nodeMap);
      const top = bot + Number(shell.properties.height ?? 2800);
      const N = outer.length;
      const look = CORNER_LOOK[o.corner](o, shellMat);
      for (let i = 0; i < N; i++) {
        const A = outer[(i - 1 + N) % N], V = outer[i], C = outer[(i + 1) % N];
        const l1 = Math.hypot(V.x - A.x, V.y - A.y), l2 = Math.hypot(C.x - V.x, C.y - V.y);
        if (l1 < 1 || l2 < 1) continue;
        const t1 = { x: (V.x - A.x) / l1, y: (V.y - A.y) / l1 }, t2 = { x: (C.x - V.x) / l2, y: (C.y - V.y) / l2 };
        if (t1.x * t2.y - t1.y * t2.x < 0.5) continue;      // only the outer (convex) corners
        const solids = cornerSolids(o.corner, V, t1, t2, bot, top);
        if (solids.length) parts.push({ key: `c${i}:corner`, label: look.label, role: 'corner', material: look.material, color: look.color, solids });
      }
    }
  }
  return parts;
}

/**
 * The shell as a part should be painted: the part's material, and its own
 * colour — or none, so a wooden sill under a white render does not come out
 * white because the shell was.
 */
export function ornamentLook(shell: BubbleGraphNode, part: OrnamentPart): BubbleGraphNode {
  const props: Record<string, unknown> = { ...shell.properties, material: part.material };
  delete props.color_3d;
  delete props.color_2d;
  delete props.opacity_3d;
  if (part.color) { props.color_3d = part.color; props.color_2d = part.color; }
  return { ...shell, properties: props } as BubbleGraphNode;
}
