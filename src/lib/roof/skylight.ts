/**
 * skylight.ts — placement geometry for roof windows / skylights (Velux-style).
 *
 * A skylight is a flat rectangular hole cut straight through a single roof
 * SLOPE FACE — no envelope change, unlike a dormer (see dormer.ts). This module
 * only computes WHERE the opening sits and whether it fits; the actual CSG cut
 * and glazing mesh are built in ogBimMapper.ts (needs the OG/THREE runtime).
 */
import { insetPolygon } from '@/lib/bimGeometry';
import type { Pt3, RoofFace3D } from './types';
import {
  computeFaceBasis, findHostFace, projectPlanPointToFace, rectOnFace, type FaceBasis,
} from './faceGeometry';

export interface SkylightIntent {
  /** Plan position (BIM mm) of the skylight's centre — same convention as any node's x/y. */
  planX: number;
  planY: number;
  widthMm: number;
  lengthMm: number;
  /** Upstand frame height above the roof surface (mm). Purely cosmetic for the cut itself. */
  curbHeightMm: number;
}

export interface SkylightPlacement {
  face: RoofFace3D;
  basis: FaceBasis;
  /** Centre of the opening, ON the roof surface. */
  center: Pt3;
  /** 4 corners of the opening (CCW), ON the roof surface. */
  corners: Pt3[];
  ok: boolean;
  diagnostics: string[];
}

/**
 * Resolve a skylight's placement against a roof's slope faces.
 * `marginMm` — minimum clearance from any face edge (ridge/hip/valley/eave),
 * so the opening never overhangs onto another face or into empty air.
 */
export function placeSkylight(
  faces: RoofFace3D[], intent: SkylightIntent, marginMm = 150,
): SkylightPlacement | null {
  const face = findHostFace(faces, intent.planX, intent.planY);
  if (!face) return null;
  const basis = computeFaceBasis(face);
  if (!basis) return null;
  const center = projectPlanPointToFace(basis, intent.planX, intent.planY);
  if (!center) return null;

  const corners = rectOnFace(basis, center, intent.widthMm, intent.lengthMm);
  const diagnostics: string[] = [];

  if (intent.widthMm < 200 || intent.lengthMm < 200) {
    diagnostics.push('skylight smaller than 200×200 mm — check dimensions');
  }

  const facePoly = face.vertices.map((v) => ({ x: v.x, y: v.y }));
  const insetPoly = marginMm > 0 ? insetPolygon(facePoly, [marginMm]) : facePoly;
  for (const c of corners) {
    if (!pointInsidePoly(c, insetPoly)) {
      diagnostics.push(`opening reaches within ${marginMm} mm of a roof edge (ridge/hip/valley/eave) — move it or shrink it`);
      break;
    }
  }

  return { face, basis, center, corners, ok: diagnostics.length === 0, diagnostics };
}

function pointInsidePoly(pt: Pt3, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
