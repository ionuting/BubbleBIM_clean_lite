/**
 * eyebrow.ts — the "eyebrow" dormer (lucarnă „ochi”): the roof covering
 * lifts in a smooth wave over a low arched window and settles back into the
 * slope behind it. The typical roof light of the modern Bucovina house.
 *
 * Unlike the box dormer (`dormer.ts`), nothing here is a wall standing on the
 * roof with a little roof of its own. The shape is one surface: the host slope
 * plus a bump,
 *
 *     z(u, s) = slope(s) + e(u) · (1 − smoothstep(s / depth))
 *
 * where `u` runs along the eave, `s` up the slope from the front line, and
 * `e(u)` is the eave line of the bump seen from the front — a raised-cosine
 * bell, `rise · ½(1 + cos(π u / halfSpan))`. The bell is concave at its feet
 * and convex at its crown, which is the wave the covering makes on these roofs.
 * Under the front edge stands the tympanum, a vertical wall filling the bell
 * down to the roof, with a half-elliptic window cut into it — the widest one
 * that keeps a frame's width of wall under the bell everywhere.
 *
 * Output is three closed triangle solids in BIM millimetres (x east, y north,
 * z up): the hood (covering, `hoodThicknessMm` thick), the tympanum with its
 * window hole, and the glass. The 3D view meshes them as they are and the IFC
 * export writes them as faceted B-reps, so the two cannot disagree.
 */
import earcut from 'earcut';
import type { Pt2, Pt3, RoofFace3D } from './types';
import { computeFaceBasis, findHostFace, projectPlanPointToFace } from './faceGeometry';

export interface EyebrowIntent {
  /** Plan position (BIM mm) of the centre of the front edge, on the roof. */
  planX: number;
  planY: number;
  /** Chord of the window arch, along the eave. */
  widthMm: number;
  /** Height of the bump's front edge above the roof at the centre. */
  riseMm: number;
  /** How far each side the wave runs out beyond the window before it meets the roof. */
  flareMm: number;
  /** Plan distance up the slope over which the bump settles back into the roof. */
  depthMm: number;
  /** The hood's lip, forward of the tympanum. */
  overhangMm?: number;
  hoodThicknessMm?: number;
  wallThicknessMm?: number;
  /** Top of the host covering above the solved face. */
  coveringThicknessMm?: number;
  /** Wall left under the window, above the roof. */
  sillMm?: number;
}

export type Tri = [Pt3, Pt3, Pt3];

/**
 * The hole the eyebrow opens in its host slope: a vertical prism over a plan
 * rectangle from the tympanum back to where the bump settles, `width` along
 * the eave. The hood covers it from above on every side, so from outside
 * nothing changes; from inside, the window looks into the attic.
 */
export interface EyebrowNotch {
  /** Centre of the rectangle's front edge (BIM mm). */
  front: Pt3;
  /** Unit plan directions: along the eave, and up the slope. */
  along: Pt2;
  up: Pt2;
  widthMm: number;
  depthMm: number;
  /** Vertical extent the prism must span to go through the covering. */
  zMinMm: number;
  zMaxMm: number;
}

export interface EyebrowGeometry {
  face: RoofFace3D;
  hood: Tri[];
  /** The underside of the hood's lip, in front of the tympanum — lined in timber. */
  soffit: Tri[];
  tympanum: Tri[];
  glass: Tri[];
  notch: EyebrowNotch;
  window: { widthMm: number; heightMm: number };
  /** Plan outline of the hood — what it covers of the host slope. */
  footprint: Pt2[];
  ok: boolean;
  diagnostics: string[];
}

const FRAME_MM = 80;
const LIFT_MM = 10;
const N_U = 28;
const N_S = 9;

const smooth = (t: number) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

/** Height of the bump's front edge at `u` from the centre. */
export function eyebrowEdge(u: number, halfSpan: number, rise: number): number {
  if (Math.abs(u) >= halfSpan) return 0;
  return rise * 0.5 * (1 + Math.cos((Math.PI * u) / halfSpan));
}

const sub = (a: Pt3, b: Pt3): Pt3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: Pt3, b: Pt3): Pt3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: Pt3, b: Pt3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** The triangle wound so its normal points along `dir` (degenerate ones dropped). */
function toward(t: Tri, dir: Pt3): Tri | null {
  const n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
  if (Math.hypot(n.x, n.y, n.z) < 1e-6) return null;
  return dot(n, dir) >= 0 ? t : [t[0], t[2], t[1]];
}

function quad(out: Tri[], a: Pt3, b: Pt3, c: Pt3, d: Pt3, dir: Pt3) {
  for (const t of [[a, b, c], [a, c, d]] as Tri[]) {
    const o = toward(t, dir);
    if (o) out.push(o);
  }
}

const ringArea = (r: Pt2[]) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p.x * q.y - q.x * p.y; }, 0) / 2;
const ccw = (r: Pt2[]) => (ringArea(r) < 0 ? [...r].reverse() : r);

/**
 * A planar face with holes, in its own (a, b) coordinates, made a closed solid
 * `depth` thick. `lift(a, b, d)` places a point in the world; `front` and
 * `back` are the outward directions of the two caps; `side(na, nb)` turns a
 * 2D outward edge normal into a world direction.
 */
function prism(
  outer: Pt2[], holes: Pt2[][], depth: number,
  lift: (a: number, b: number, d: number) => Pt3,
  front: Pt3, back: Pt3, side: (na: number, nb: number) => Pt3,
): Tri[] {
  const rings = [ccw(outer), ...holes.map(ccw)];
  const flat: number[] = [];
  const holeIdx: number[] = [];
  for (const [i, r] of rings.entries()) {
    if (i > 0) holeIdx.push(flat.length / 2);
    for (const p of r) flat.push(p.x, p.y);
  }
  const idx = earcut(flat, holeIdx, 2);
  const pts = rings.flat();
  const out: Tri[] = [];
  // Earcut winds every triangle the same way, so the caps are oriented once,
  // as a whole — its sliver triangles along a hole's bridge have no normal of
  // their own, and dropping them would leave the solid open.
  const cap = (d: number): Tri[] => {
    const tris: Tri[] = [];
    for (let k = 0; k < idx.length; k += 3) {
      const [a, b, c] = [pts[idx[k]], pts[idx[k + 1]], pts[idx[k + 2]]];
      tris.push([lift(a.x, a.y, d), lift(b.x, b.y, d), lift(c.x, c.y, d)]);
    }
    return tris;
  };
  const facing = (tris: Tri[], dir: Pt3): Tri[] => {
    let n: Pt3 = { x: 0, y: 0, z: 0 };
    for (const t of tris) { const c = cross(sub(t[1], t[0]), sub(t[2], t[0])); n = { x: n.x + c.x, y: n.y + c.y, z: n.z + c.z }; }
    return dot(n, dir) >= 0 ? tris : tris.map((t) => [t[0], t[2], t[1]] as Tri);
  };
  out.push(...facing(cap(0), front), ...facing(cap(depth), back));
  for (const [i, r] of rings.entries()) {
    for (let k = 0; k < r.length; k++) {
      const p = r[k], q = r[(k + 1) % r.length];
      const dx = q.x - p.x, dy = q.y - p.y;
      // Right of a CCW ring is outside it: out of the solid for the outer
      // ring, into the opening for a hole — out of the solid either way.
      const sign = i === 0 ? 1 : -1;
      quad(out, lift(p.x, p.y, 0), lift(q.x, q.y, 0), lift(q.x, q.y, depth), lift(p.x, p.y, depth), side(sign * dy, -sign * dx));
    }
  }
  return out;
}

function insideWithMargin(pt: Pt2, poly: Pt2[], margin: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  if (!inside) return false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2));
    if (Math.hypot(pt.x - (a.x + dx * t), pt.y - (a.y + dy * t)) < margin) return false;
  }
  return true;
}

export function placeEyebrow(faces: RoofFace3D[], intent: EyebrowIntent, marginMm = 150): EyebrowGeometry | null {
  const face = findHostFace(faces, intent.planX, intent.planY);
  if (!face) return null;
  const basis = computeFaceBasis(face);
  if (!basis) return null;
  const F0 = projectPlanPointToFace(basis, intent.planX, intent.planY);
  if (!F0) return null;
  const diagnostics: string[] = [];

  const hLen = Math.hypot(basis.v.x, basis.v.y);
  if (hLen < 1e-4) return null;
  const up = { x: basis.v.x / hLen, y: basis.v.y / hLen };      // plan up-slope
  const slope = basis.v.z / hLen;                                 // rise per plan mm
  if (slope < 0.15) diagnostics.push('panta acoperișului e prea mică pentru o lucarnă „ochi” (sub ~9°)');
  const along = { x: basis.u.x, y: basis.u.y };

  const W = Math.max(400, intent.widthMm);
  const H = Math.max(200, intent.riseMm);
  const half = W / 2 + Math.max(0, intent.flareMm);
  const D = Math.max(300, intent.depthMm);
  const ov = Math.max(0, intent.overhangMm ?? 250);
  // Thick enough that, at the flanks and at the back, the hood's underside
  // goes below the host covering whichever way the covering is extruded from
  // its face (up in the 3D view, down in the IFC export) — so the cut edge of
  // the notch is always inside it.
  const coveringT = Math.max(0, intent.coveringThicknessMm ?? 40);
  const hoodT = Math.max(20, intent.hoodThicknessMm ?? 60 + 2 * coveringT);
  const wallT = Math.max(40, intent.wallThicknessMm ?? 100);
  const sill = Math.max(0, intent.sillMm ?? 100);
  const covering = coveringT;
  const baseZ = F0.z + covering;

  /** World point: `u` along the eave, `s` up the slope in plan, `h` above the roof's front line. */
  const at = (u: number, s: number, h: number): Pt3 => ({
    x: F0.x + along.x * u + up.x * s,
    y: F0.y + along.y * u + up.y * s,
    z: baseZ + h,
  });

  // ── Hood: the covering, lifted by the bump, `hoodT` thick ────────────────
  const hood: Tri[] = [];
  const us = Array.from({ length: N_U + 1 }, (_, i) => -half + (2 * half * i) / N_U);
  const ss = [-ov, ...Array.from({ length: N_S + 1 }, (_, j) => (D * j) / N_S)];
  // A hair above the covering where the bump has run out, so the two
  // surfaces never coincide (they would flicker against each other on screen).
  const top = (u: number, s: number) => at(u, s, s * slope + LIFT_MM + eyebrowEdge(u, half, H) * (1 - smooth(s / D)));
  const bot = (u: number, s: number) => { const p = top(u, s); return { ...p, z: p.z - hoodT }; };
  const upDir: Pt3 = { x: 0, y: 0, z: 1 }, downDir: Pt3 = { x: 0, y: 0, z: -1 };
  const alongDir: Pt3 = { x: along.x, y: along.y, z: 0 }, upSlope: Pt3 = { x: up.x, y: up.y, z: 0 };
  const neg = (p: Pt3): Pt3 => ({ x: -p.x, y: -p.y, z: -p.z });
  for (let i = 0; i < us.length - 1; i++) {
    for (let j = 0; j < ss.length - 1; j++) {
      const [u0, u1, s0, s1] = [us[i], us[i + 1], ss[j], ss[j + 1]];
      quad(hood, top(u0, s0), top(u1, s0), top(u1, s1), top(u0, s1), upDir);
      quad(hood, bot(u0, s0), bot(u1, s0), bot(u1, s1), bot(u0, s1), downDir);
    }
  }
  for (let j = 0; j < ss.length - 1; j++) {
    quad(hood, top(-half, ss[j]), top(-half, ss[j + 1]), bot(-half, ss[j + 1]), bot(-half, ss[j]), neg(alongDir));
    quad(hood, top(half, ss[j]), top(half, ss[j + 1]), bot(half, ss[j + 1]), bot(half, ss[j]), alongDir);
  }
  for (let i = 0; i < us.length - 1; i++) {
    const [s0, s1] = [ss[0], ss[ss.length - 1]];
    quad(hood, top(us[i], s0), top(us[i + 1], s0), bot(us[i + 1], s0), bot(us[i], s0), neg(upSlope));
    quad(hood, top(us[i], s1), top(us[i + 1], s1), bot(us[i + 1], s1), bot(us[i], s1), upSlope);
  }

  // ── Soffit: a lining under the lip, from its edge back to the tympanum ────
  const soffit: Tri[] = [];
  if (ov > 1) {
    const SOFFIT_MM = 20;
    const sl = [-ov, -ov / 2, 0];
    const sTop = (u: number, s: number) => { const p = bot(u, s); return { ...p, z: p.z - 0.5 }; };
    const sBot = (u: number, s: number) => { const p = bot(u, s); return { ...p, z: p.z - 0.5 - SOFFIT_MM }; };
    for (let i = 0; i < us.length - 1; i++) {
      for (let j = 0; j < sl.length - 1; j++) {
        const [u0, u1, s0, s1] = [us[i], us[i + 1], sl[j], sl[j + 1]];
        quad(soffit, sTop(u0, s0), sTop(u1, s0), sTop(u1, s1), sTop(u0, s1), upDir);
        quad(soffit, sBot(u0, s0), sBot(u1, s0), sBot(u1, s1), sBot(u0, s1), downDir);
      }
    }
    for (let j = 0; j < sl.length - 1; j++) {
      quad(soffit, sTop(-half, sl[j]), sTop(-half, sl[j + 1]), sBot(-half, sl[j + 1]), sBot(-half, sl[j]), neg(alongDir));
      quad(soffit, sTop(half, sl[j]), sTop(half, sl[j + 1]), sBot(half, sl[j + 1]), sBot(half, sl[j]), alongDir);
    }
    for (let i = 0; i < us.length - 1; i++) {
      quad(soffit, sTop(us[i], sl[0]), sTop(us[i + 1], sl[0]), sBot(us[i + 1], sl[0]), sBot(us[i], sl[0]), neg(upSlope));
      const e = sl[sl.length - 1];
      quad(soffit, sTop(us[i], e), sTop(us[i + 1], e), sBot(us[i + 1], e), sBot(us[i], e), upSlope);
    }
  }

  // ── Window: the widest half-ellipse that keeps a frame under the hood ─────
  const Ww = W;
  let Hw = Infinity;
  for (let k = 0; k <= 40; k++) {
    const u = (Ww / 2) * (k / 40) * 0.98;
    const room = eyebrowEdge(u, half, H) - hoodT - FRAME_MM - sill;
    const shape = Math.sqrt(1 - (2 * u / Ww) ** 2);
    Hw = Math.min(Hw, room / shape);
  }
  Hw = Math.min(Hw, Ww * 0.6);
  if (!(Hw >= 250)) diagnostics.push('lucarna e prea joasă pentru o fereastră — mărește înălțimea sau lățimea');
  const windowRing: Pt2[] = Hw >= 250
    ? Array.from({ length: 25 }, (_, k) => {
      const th = (Math.PI * k) / 24;
      return { x: (Ww / 2) * Math.cos(th), y: sill + Hw * Math.sin(th) };
    })
    : [];

  // ── Tympanum: the bell down to the roof, with the window cut out ──────────
  const edge: Pt2[] = [];
  for (const u of us) {
    const h = eyebrowEdge(u, half, H) - hoodT;
    if (h > 10) edge.push({ x: u, y: h });
  }
  const tympanum: Tri[] = [];
  const glass: Tri[] = [];
  const liftT = (a: number, b: number, d: number) => at(a, d, b);
  const side = (na: number, nb: number): Pt3 => ({ x: along.x * na, y: along.y * na, z: nb });
  if (edge.length >= 3) {
    // Its foot goes down through the covering: the notch cuts the covering
    // right behind it, and that cut face must not show under the wall.
    const foot = -(2.5 * covering + 20);
    const outer: Pt2[] = [{ x: edge[0].x, y: foot }, { x: edge[edge.length - 1].x, y: foot }, ...[...edge].reverse()];
    tympanum.push(...prism(outer, windowRing.length ? [windowRing] : [], wallT, liftT, neg(upSlope), upSlope, side));
    if (windowRing.length) {
      const g = 20;
      const liftG = (a: number, b: number, d: number) => at(a, wallT / 2 - g / 2 + d, b);
      glass.push(...prism(windowRing, [], g, liftG, neg(upSlope), upSlope, side));
    }
  }

  // ── Fit on the host slope ─────────────────────────────────────────────────
  const footprint = [at(-half, -ov, 0), at(half, -ov, 0), at(half, D, 0), at(-half, D, 0)].map((p) => ({ x: p.x, y: p.y }));
  const facePlan = face.vertices.map((v) => ({ x: v.x, y: v.y }));
  if (!footprint.every((p) => insideWithMargin(p, facePlan, marginMm))) {
    diagnostics.push(`lucarna iese la mai puțin de ${marginMm} mm de marginea apei (coamă, muchie, streașină) — mut-o sau micșoreaz-o`);
  }

  // The hole stops where the bump has sunk to within a hood's thickness (plus
  // a margin) of the roof: past there the hood lies almost flat on the slope,
  // and the cut's edges would show through it.
  const clear = hoodT + 60;
  let notchHalf = 0, notchDepth = 0;
  if (H > clear) {
    notchHalf = (half / Math.PI) * Math.acos(2 * clear / H - 1);
    let lo = 0, hi = 1;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (1 - smooth(m) >= clear / H) lo = m; else hi = m; }
    notchDepth = D * lo;
  }
  const notch: EyebrowNotch = {
    front: { x: F0.x, y: F0.y, z: F0.z },
    along, up, widthMm: 2 * notchHalf, depthMm: notchDepth,
    zMinMm: F0.z - 200, zMaxMm: F0.z + D * slope + covering + 200,
  };
  return {
    face, hood, soffit, tympanum, glass, notch,
    window: { widthMm: Hw >= 250 ? Ww : 0, heightMm: Hw >= 250 ? Math.round(Hw) : 0 },
    footprint, ok: diagnostics.length === 0, diagnostics,
  };
}

/**
 * A dormer node's eyebrow, as the viewers and the export read it: the node's
 * plan position (BIM mm, like any non-ax node) is the centre of the front edge.
 */
export function eyebrowIntentOf(
  node: { x: number; y: number; properties: Record<string, unknown> },
  coveringThicknessMm: number,
): EyebrowIntent {
  const num = (k: string, d: number) => { const v = Number(node.properties[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    planX: node.x, planY: node.y,
    widthMm: num('width_mm', 1400),
    riseMm: num('rise_mm', 900),
    flareMm: num('flare_mm', 900),
    depthMm: num('depth_mm', 1800),
    overhangMm: num('overhang_mm', 250),
    coveringThicknessMm,
  };
}

/** Signed volume of a closed triangle solid (mm³) — positive when every face points out. */
export function solidVolume(tris: Tri[]): number {
  let v = 0;
  for (const [a, b, c] of tris) v += dot(a, cross(b, c)) / 6;
  return v;
}

/**
 * A planar convex polygon (a dormer wall pane, a roof face) made a closed solid
 * by sweeping it through `offset`. Faces point away from the solid's centre.
 */
export function extrudePolygon3(poly: Pt3[], offset: Pt3): Tri[] {
  if (poly.length < 3) return [];
  const far = poly.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y, z: p.z + offset.z }));
  const all = [...poly, ...far];
  const c = all.reduce((m, p) => ({ x: m.x + p.x / all.length, y: m.y + p.y / all.length, z: m.z + p.z / all.length }), { x: 0, y: 0, z: 0 });
  const out: Tri[] = [];
  const push = (t: Tri) => {
    const m = { x: (t[0].x + t[1].x + t[2].x) / 3, y: (t[0].y + t[1].y + t[2].y) / 3, z: (t[0].z + t[1].z + t[2].z) / 3 };
    const o = toward(t, sub(m, c));
    if (o) out.push(o);
  };
  for (let i = 1; i < poly.length - 1; i++) {
    push([poly[0], poly[i], poly[i + 1]]);
    push([far[0], far[i], far[i + 1]]);
  }
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    push([poly[i], poly[j], far[j]]);
    push([poly[i], far[j], far[i]]);
  }
  return out;
}
