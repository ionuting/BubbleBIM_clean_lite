/**
 * gablet.ts — a fronton: a small gable standing on a slope, its ridge running
 * back into the roof — the pediment over a Basarabian cerdac.
 *
 * In the host slope's own frame (`s` along the eave, `b` back up the slope in
 * plan, z up) the slope is z = z0 + b·tanM. The fronton's two planes rise from
 * the front corners (s = ±W/2, z0) to a level ridge at z0 + H, H = W/2·tanG,
 * so each is z = z0 + (W/2 − |s|)·tanG. Where they meet the slope they make
 * the two valleys, b = (W/2 − |s|)·tanG / tanM, and the ridge dies into the
 * slope at b = W/2·tanG/tanM. Everything is above the slope, so nothing is cut
 * from it: the fronton closes its own volume against the roof, the way a
 * gablet is built.
 *
 * Solids (closed, wound outward, BIM mm): the pediment — the front triangle,
 * `wall` thick going back; the two roof halves, overhanging the pediment by
 * `overhang` and `covering` thick; and, with `decor`, a sun on the pediment —
 * a half disc on the base and rays fanning up to the rakes, standing proud.
 */
import type { Pt2, Pt3, RoofFace3D } from './types';
import { extrudePolygon3, type Tri } from './eyebrow';
import { computeFaceBasis, findHostFace, projectPlanPointToFace } from './faceGeometry';

export interface GabletIntent {
  /** Plan point (BIM mm) at the middle of the pediment's base. */
  planX: number;
  planY: number;
  widthMm: number;
  pitchDeg: number;
  overhangMm: number;
  coveringMm: number;
  wallMm: number;
  decor: boolean;
}

export interface GabletGeometry {
  face: RoofFace3D;
  pediment: Tri[];
  roof: Tri[][];
  decor: Tri[][];
  /** Height of the pediment's apex over its base, and how far back the ridge runs. */
  heightMm: number;
  ridgeMm: number;
  ok: boolean;
  diagnostics: string[];
}

export function gabletIntentOf(node: { x: number; y: number; properties: Record<string, unknown> }, coveringMm = 40): GabletIntent {
  const p = node.properties;
  return {
    planX: node.x,
    planY: node.y,
    widthMm: Number(p.width_mm ?? 3000),
    pitchDeg: Number(p.pitch_deg ?? 45),
    overhangMm: Number(p.overhang_mm ?? 150),
    coveringMm: Math.max(10, coveringMm),
    wallMm: Number(p.wall_mm ?? 60),
    decor: !(p.decor === false || p.decor === 'False'),
  };
}

const inPoly = (pt: Pt2, poly: Pt2[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

export function placeGablet(faces: RoofFace3D[], g: GabletIntent): GabletGeometry | null {
  const face = findHostFace(faces, g.planX, g.planY);
  if (!face) return null;
  const basis = computeFaceBasis(face);
  if (!basis) return null;
  const diagnostics: string[] = [];
  const base = projectPlanPointToFace(basis, g.planX, g.planY);
  if (!base) return null;
  // Plan directions: along the eave, and back (up-slope) into the house.
  const t = basis.u;
  const hl = Math.hypot(basis.v.x, basis.v.y) || 1;
  const back = { x: basis.v.x / hl, y: basis.v.y / hl };
  const tanM = basis.v.z / hl;
  const tanG = Math.tan((Math.min(75, Math.max(15, g.pitchDeg)) * Math.PI) / 180);
  if (tanM < 0.05) diagnostics.push('apa e prea plată pentru un fronton');
  if (tanG <= tanM + 0.05) diagnostics.push('frontonul trebuie să fie mai abrupt decât acoperișul');
  const W = g.widthMm, hw = W / 2;
  const H = hw * tanG;
  const ridge = tanM > 0.05 ? H / tanM : 0;

  // A point of the fronton's frame: s along, b back, dz over the base.
  const P = (s: number, b: number, dz: number): Pt3 => ({
    x: base.x + t.x * s + back.x * b, y: base.y + t.y * s + back.y * b, z: base.z + dz,
  });
  const facePoly = face.vertices.map((v) => ({ x: v.x, y: v.y }));
  for (const q of [P(-hw, 0, 0), P(hw, 0, 0), P(0, ridge, 0)]) {
    if (!inPoly(q, facePoly)) { diagnostics.push('frontonul iese de pe apa lui — îngustează-l sau mută-l'); break; }
  }
  if (diagnostics.length) return { face, pediment: [], roof: [], decor: [], heightMm: H, ridgeMm: ridge, ok: false, diagnostics };

  const down = (d: number): Pt3 => ({ x: 0, y: 0, z: -d });
  const backBy = (d: number): Pt3 => ({ x: back.x * d, y: back.y * d, z: 0 });
  const fwd = (d: number): Pt3 => ({ x: -back.x * d, y: -back.y * d, z: 0 });
  // The pediment: its face on the front line, the wall going back.
  const pediment = extrudePolygon3([P(-hw, 0, 0), P(hw, 0, 0), P(0, 0, H)], backBy(g.wallMm));
  // Two roof halves over it, out past it by the overhang, lifted clear of the pediment's rake.
  const o = g.overhangMm, lift = 5;
  const roof = [
    extrudePolygon3([P(0, -o, H + lift), P(hw, -o, lift), P(hw, 0, lift), P(0, ridge, H + lift)], down(g.coveringMm)),
    extrudePolygon3([P(0, -o, H + lift), P(0, ridge, H + lift), P(-hw, 0, lift), P(-hw, -o, lift)], down(g.coveringMm)),
  ].filter((x) => x.length);

  const decor: Tri[][] = [];
  if (g.decor) {
    // A half sun on the base and nine rays — proud of the pediment by 25 mm.
    const r = W * 0.13, n = 12, k = 9;
    const disc: Pt3[] = [];
    for (let i = 0; i <= n; i++) {
      const a = Math.PI - (Math.PI * i) / n;
      disc.push(P(r * Math.cos(a), 0, 40 + r * Math.sin(a)));
    }
    decor.push(extrudePolygon3(disc, fwd(25)));
    const inset = 120;
    for (let i = 0; i < k; i++) {
      const a = Math.PI * (0.08 + (0.84 * i) / (k - 1));     // fan from left to right
      const dir = { x: Math.cos(a), z: Math.sin(a) };
      // Where the ray meets the rake, less an inset: on |s|·tanG + z = H.
      const len = (H - 40 - inset) / (Math.abs(dir.x) * tanG + dir.z);
      if (!(len > r + 60)) continue;
      const w0 = 22, w1 = 6;
      const nx = -dir.z, nz = dir.x;                         // across the ray, in the pediment plane
      const at = (d: number, w: number, side: number) => P(dir.x * d + nx * w * side, 0, 40 + dir.z * d + nz * w * side);
      decor.push(extrudePolygon3([at(r + 30, w0, -1), at(len, w1, -1), at(len, w1, 1), at(r + 30, w0, 1)], fwd(18)));
    }
  }
  return { face, pediment, roof, decor: decor.filter((x) => x.length), heightMm: H, ridgeMm: ridge, ok: true, diagnostics };
}
