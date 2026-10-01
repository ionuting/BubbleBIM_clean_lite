/**
 * dormer.ts — placement + envelope geometry for a dormer window.
 *
 * Unlike a skylight (a flat hole), a dormer breaks the roof ENVELOPE: it
 * notches the parent slope and adds its own small volume — front wall, two
 * cheek walls, and its own little roof — all standing on top of the parent
 * roof surface. This module computes that whole envelope purely (no OG/THREE
 * dependency, fully testable); `ogBimMapper.ts` turns it into meshes + a CSG
 * notch cut, the same way `skylight.ts` feeds the skylight's CSG hole.
 *
 * Simplification (documented, not hidden): the dormer's OWN mini-roof reuses
 * the existing world-XY-aligned `buildRoofEnvelope` engine. That is exact when
 * the host face's up-slope direction is aligned to a world axis — the normal
 * case for a rectilinear building — and a reasonable bounding-box approximation
 * otherwise (a dormer on a diagonal/rotated face gets a roof over its
 * axis-aligned bounding rectangle, not a perfectly snug one).
 */
import type { Pt2, Pt3, RoofContour, RoofDiagnostic, RoofFace3D, RoofType } from './types';
import { buildRoofEnvelope } from './skeleton';
import { extrudePolygon3, type Tri } from './eyebrow';
import { computeFaceBasis, findHostFace, projectPlanPointToFace, type FaceBasis } from './faceGeometry';

export interface DormerIntent {
  /** Plan position (BIM mm) of the FRONT WALL's centre, resting on the roof surface. */
  planX: number;
  planY: number;
  /** Along the host face's eave direction. */
  widthMm: number;
  /** Horizontal (plan) depth from the front wall back to the dormer's own wall-plate line. */
  depthMm: number;
  /** Front wall height (world-vertical) above the roof surface at the front wall line. */
  wallHeightMm: number;
  roofType: Extract<RoofType, 'gable' | 'shed'>;
  pitchDeg: number;
  overhangMm: number;
  wallThicknessMm?: number;
}

/** The 4 corners (world) of one wall pane, CCW as viewed from outside the dormer. */
export interface WallPane {
  corners: [Pt3, Pt3, Pt3, Pt3];
}

export interface DormerPlacement {
  face: RoofFace3D;
  basis: FaceBasis;
  /** Front wall (vertical rectangle, flat bottom at the roof surface height). */
  frontWall: WallPane;
  /** Left/right cheek walls (right-trapezoid: vertical front edge, flat top, sloped bottom). */
  cheekLeft: WallPane;
  cheekRight: WallPane;
  /** Plan footprint of the notch to cut from the parent covering (CCW, world XY at frontBottom.z). */
  notchFootprint: Pt3[];
  /** The dormer's own tiny roof, already solved (envelope only — no framing; see module doc). */
  ownRoofContour: RoofContour;
  ownRoofFaces: RoofFace3D[];
  ok: boolean;
  diagnostics: string[];
}

function sub3(a: Pt3, b: Pt3): Pt3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function addZ(p: Pt3, dz: number): Pt3 { return { x: p.x, y: p.y, z: p.z + dz }; }

/** Resolve a dormer's full envelope against a roof's slope faces. */
export function placeDormer(
  faces: RoofFace3D[], intent: DormerIntent, marginMm = 200,
): DormerPlacement | null {
  const face = findHostFace(faces, intent.planX, intent.planY);
  if (!face) return null;
  const basis = computeFaceBasis(face);
  if (!basis) return null;
  const frontBottomC = projectPlanPointToFace(basis, intent.planX, intent.planY);
  if (!frontBottomC) return null;

  const diagnostics: string[] = [];

  // Horizontal-plan length per unit step along the in-plane "up-slope" axis `v`
  // (v is a 3D unit vector; only its (x,y) part contributes to plan distance).
  const hLen = Math.hypot(basis.v.x, basis.v.y);
  if (hLen < 1e-4) {
    diagnostics.push('host face is too steep to measure a horizontal dormer depth');
    return { face, basis, frontWall: emptyPane(), cheekLeft: emptyPane(), cheekRight: emptyPane(), notchFootprint: [], ownRoofContour: emptyContour(basis), ownRoofFaces: [], ok: false, diagnostics };
  }
  const dv = intent.depthMm / hLen;

  const { u: u0, v: v0 } = faceUVOf(basis, frontBottomC);
  const backBottomC = uvToWorldOf(basis, u0, v0 + dv);

  const frontTopC = addZ(frontBottomC, intent.wallHeightMm);
  const backTopC = { x: backBottomC.x, y: backBottomC.y, z: frontTopC.z }; // flat wall-plate line

  if (backBottomC.z >= frontTopC.z - 1) {
    diagnostics.push('dormer depth/wall height too small for this pitch — the back edge would meet or exceed the front wall top; increase wall height or reduce depth');
  }

  const hw = intent.widthMm / 2;
  const uAxis3: Pt3 = { x: basis.u.x, y: basis.u.y, z: 0 };
  const left = (p: Pt3): Pt3 => ({ x: p.x - uAxis3.x * hw, y: p.y - uAxis3.y * hw, z: p.z });
  const right = (p: Pt3): Pt3 => ({ x: p.x + uAxis3.x * hw, y: p.y + uAxis3.y * hw, z: p.z });

  const frontBottomL = left(frontBottomC), frontBottomR = right(frontBottomC);
  const frontTopL = left(frontTopC), frontTopR = right(frontTopC);
  const backTopL = left(backTopC), backTopR = right(backTopC);
  const backBottomL = left(backBottomC), backBottomR = right(backBottomC);

  const frontWall: WallPane = { corners: [frontBottomL, frontBottomR, frontTopR, frontTopL] };
  // Cheek wall cross-section, right-trapezoid: front-bottom → front-top → back-top → back-bottom.
  const cheekRight: WallPane = { corners: [frontBottomR, frontTopR, backTopR, backBottomR] };
  const cheekLeft: WallPane = { corners: [frontBottomL, backBottomL, backTopL, frontTopL] };

  const notchFootprint = [frontBottomL, frontBottomR, backBottomR, backBottomL];

  // Fit: all 4 footprint corners must stay within the host face (minus margin).
  const facePoly2d = face.vertices.map((v) => ({ x: v.x, y: v.y }));
  for (const c of notchFootprint) {
    if (!pointInsetInside({ x: c.x, y: c.y }, facePoly2d, marginMm)) {
      diagnostics.push(`dormer footprint reaches within ${marginMm} mm of a roof edge (ridge/hip/valley/eave) — move it, or shrink width/depth`);
      break;
    }
  }
  if (intent.widthMm < 400 || intent.depthMm < 300) {
    diagnostics.push('dormer smaller than 400×300 mm — check dimensions');
  }

  // Dormer's own tiny roof: rectangle at the wall-plate height, in the SAME
  // orientation convention as any other roof contour (world-XY plan points).
  const ownRoofContour: RoofContour = {
    points: [
      { x: frontBottomL.x, y: frontBottomL.y },
      { x: frontBottomR.x, y: frontBottomR.y },
      { x: backBottomR.x, y: backBottomR.y },
      { x: backBottomL.x, y: backBottomL.y },
    ],
    axIds: [],
    baseZ: frontTopC.z,
    storeyId: null,
  };
  const ownDiags: RoofDiagnostic[] = [];
  const { faces: ownRoofFaces } = buildRoofEnvelope(
    ownRoofContour, intent.roofType, intent.pitchDeg, 'auto', 0, 'dormer', ownDiags,
  );
  for (const d of ownDiags) if (d.severity === 'error') diagnostics.push(`own roof: ${d.message}`);

  return {
    face, basis, frontWall, cheekLeft, cheekRight, notchFootprint,
    ownRoofContour, ownRoofFaces,
    ok: diagnostics.length === 0,
    diagnostics,
  };
}

// ── small local helpers (mirrors faceGeometry's, kept private to avoid a
//    public API that leaks the exact uv-parametrization convention) ─────────

function faceUVOf(basis: FaceBasis, p: Pt3): { u: number; v: number } {
  const rel = sub3(p, basis.origin);
  return { u: rel.x * basis.u.x + rel.y * basis.u.y, v: rel.x * basis.v.x + rel.y * basis.v.y + rel.z * basis.v.z };
}
function uvToWorldOf(basis: FaceBasis, u: number, v: number): Pt3 {
  return {
    x: basis.origin.x + basis.u.x * u + basis.v.x * v,
    y: basis.origin.y + basis.u.y * u + basis.v.y * v,
    z: basis.origin.z + basis.v.z * v,
  };
}
function pointInsetInside(pt: Pt2, poly: Pt2[], marginMm: number): boolean {
  // Cheap conservative check: point must be ≥ marginMm from every edge line
  // AND inside the raw polygon. Avoids importing insetPolygon's stricter
  // (and here unnecessary) winding/edge-offset machinery for a single point.
  if (!pointInPoly(pt, poly)) return false;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    if (distToSegment(pt, a, b) < marginMm) return false;
  }
  return true;
}
function pointInPoly(pt: Pt2, poly: Pt2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToSegment(pt: Pt2, a: Pt2, b: Pt2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
  return Math.hypot(pt.x - (a.x + dx * t), pt.y - (a.y + dy * t));
}
function emptyPane(): WallPane {
  const z: Pt3 = { x: 0, y: 0, z: 0 };
  return { corners: [z, z, z, z] };
}
function emptyContour(basis: FaceBasis): RoofContour {
  return { points: [], axIds: [], baseZ: basis.origin.z, storeyId: null };
}

/** A box dormer node's intent, as the 3D view and the IFC export both read it. */
export function dormerIntentOf(node: { x: number; y: number; properties: Record<string, unknown> }): DormerIntent {
  const p = node.properties;
  return {
    planX: node.x,
    planY: node.y,
    widthMm: Number(p.width_mm ?? 1200),
    depthMm: Number(p.depth_mm ?? 900),
    wallHeightMm: Number(p.wall_height_mm ?? 1200),
    roofType: String(p.roof_type ?? 'gable') === 'shed' ? 'shed' : 'gable',
    pitchDeg: Number(p.pitch_deg ?? 25),
    overhangMm: Number(p.overhang_mm ?? 200),
  };
}

/**
 * The box dormer as closed solids, for the export: its three walls given the
 * thickness the 3D view gives them (outward from the pane), its own slopes
 * given the covering's thickness (downward), its gable ends the walls'
 * thickness (inward). Millimetres, BIM axes.
 */
export function dormerSolids(
  p: DormerPlacement, wallThicknessMm = 100, roofThicknessMm = 40,
): { walls: Tri[][]; roof: Tri[][] } {
  const u: Pt3 = { x: p.basis.u.x, y: p.basis.u.y, z: 0 };
  const l = Math.hypot(p.basis.v.x, p.basis.v.y) || 1;
  const front: Pt3 = { x: -p.basis.v.x / l, y: -p.basis.v.y / l, z: 0 };
  const scale = (d: Pt3, k: number): Pt3 => ({ x: d.x * k, y: d.y * k, z: d.z * k });
  const walls = [
    extrudePolygon3(p.frontWall.corners, scale(front, wallThicknessMm)),
    extrudePolygon3(p.cheekLeft.corners, scale(u, -wallThicknessMm)),
    extrudePolygon3(p.cheekRight.corners, scale(u, wallThicknessMm)),
  ];
  const all = p.ownRoofFaces.flatMap((f) => f.vertices);
  const c = all.reduce((m, q) => ({ x: m.x + q.x / all.length, y: m.y + q.y / all.length, z: m.z + q.z / all.length }), { x: 0, y: 0, z: 0 });
  const roof: Tri[][] = [];
  for (const f of p.ownRoofFaces) {
    if (f.role === 'gable_end') {
      const m = f.vertices.reduce((s, q) => ({ x: s.x + q.x / f.vertices.length, y: s.y + q.y / f.vertices.length, z: 0 }), { x: 0, y: 0, z: 0 });
      const d = { x: c.x - m.x, y: c.y - m.y, z: 0 };
      const dl = Math.hypot(d.x, d.y) || 1;
      walls.push(extrudePolygon3(f.vertices, scale({ x: d.x / dl, y: d.y / dl, z: 0 }, wallThicknessMm)));
    } else {
      roof.push(extrudePolygon3(f.vertices, { x: 0, y: 0, z: -roofThicknessMm }));
    }
  }
  return { walls: walls.filter((t) => t.length), roof: roof.filter((t) => t.length) };
}
