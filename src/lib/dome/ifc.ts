/**
 * ifc.ts — a dome as IFC elements.
 *
 * Two element kinds, because a dome is two trades: IFCMEMBER for every rib
 * segment and IFCPLATE for every glass panel. Both are extrusions of a
 * profile along an axis, which is the one representation `@ifc-lite/create`
 * takes — so the work here is entirely about placements, and a placement is
 * the easy thing to get subtly wrong.
 *
 * A rib segment reuses the sweep's own convention: Axis is the direction of
 * travel, RefDirection the profile's local X, and local Y = Axis × RefDir.
 * The difference from a sweep is the up vector — the surface normal rather
 * than world up — so the segments are built here rather than by
 * `sweepSegments`.
 *
 * A panel extrudes its own outline along its own normal: the profile is the
 * panel's plane coordinates (which `DomePanel` already carries), the axis is
 * the normal, and the depth is the glass thickness. Origin at the outline's
 * first vertex rather than the centroid, because `Placement.Location` is the
 * origin of the profile's coordinate system, not the centre of the shape.
 */
import type { Pt2 } from '@/lib/geom/plan2d';
import type { Pt3 } from '@/lib/sweep/types';
import { frameOnSurface } from '@/lib/sweep/rings';
import type { DomeMember, DomePanel } from './types';

export interface DomeIfcPiece {
  location: [number, number, number];
  axis: [number, number, number];
  refDirection: [number, number, number];
  /** Profile outer curve in the piece's local (x, y), metres. */
  profile: Array<[number, number]>;
  depthM: number;
}

const MM = 0.001;

/**
 * One extrusion per rib segment.
 *
 * `bottomMm` is the storey's own base elevation: IFC placements here are
 * relative to the storey, exactly as the wall and sweep exporters do it.
 */
export function domeMemberPieces(
  members: DomeMember[],
  placed: Pt2[],
  bottomMm: number,
): DomeIfcPiece[] {
  const out: DomeIfcPiece[] = [];
  const profile = placed.map((p): [number, number] => [p.x * MM, p.y * MM]);
  for (const m of members) {
    for (let i = 0; i + 1 < m.points.length; i++) {
      const A = m.points[i], B = m.points[i + 1];
      const len = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
      if (len < 1) continue;
      const t: Pt3 = { x: (B.x - A.x) / len, y: (B.y - A.y) / len, z: (B.z - A.z) / len };
      // The normal at the segment's own midpoint — the same frame the mesh used.
      const n = m.normals[i] ?? { x: 0, y: 0, z: 1 };
      const nb = m.normals[i + 1] ?? n;
      const mid = { x: (n.x + nb.x) / 2, y: (n.y + nb.y) / 2, z: (n.z + nb.z) / 2 };
      const { s } = frameOnSurface(t, mid);
      out.push({
        location: [A.x * MM, A.y * MM, (A.z - bottomMm) * MM],
        axis: [t.x, t.y, t.z],
        refDirection: [s.x, s.y, s.z],
        profile,
        depthM: len * MM,
      });
    }
  }
  return out;
}

/** One extrusion per glass panel, its outline pushed along its own normal. */
export function domePanelPieces(
  panels: DomePanel[],
  thicknessMm: number,
  bottomMm: number,
): DomeIfcPiece[] {
  const depthM = Math.max(1, thicknessMm) * MM;
  return panels.map((p) => {
    // The profile's own origin is the outline's first vertex; `p.profile` is
    // measured from the centroid, so shift it across.
    const o = p.profile[0];
    const v = p.outline[0];
    return {
      location: [v.x * MM, v.y * MM, (v.z - bottomMm) * MM],
      axis: [p.normal.x, p.normal.y, p.normal.z] as [number, number, number],
      refDirection: [p.refDir.x, p.refDir.y, p.refDir.z] as [number, number, number],
      profile: p.profile.map((q): [number, number] => [(q.x - o.x) * MM, (q.y - o.y) * MM]),
      depthM,
    };
  });
}
