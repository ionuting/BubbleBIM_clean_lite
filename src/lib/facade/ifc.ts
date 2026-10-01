/**
 * ifc.ts — the facade as ifc-lite extrusions.
 *
 * Glass and opaque panels are DomePanels, so the dome's writer serves them.
 * Mullions and cassettes are written here: a mullion is its rectangle
 * extruded along its edge; a cassette is its OUTER ring extruded by its
 * depth — the bevel is lost in IFC, which is stated rather than hidden,
 * because ifc-lite writes straight extrusions and nothing else.
 */
import type { DomeIfcPiece } from '@/lib/dome/ifc';
import type { FacadeResult } from './types';

const MM = 0.001;

export function facadeMemberPieces(res: FacadeResult, bottomMm: number): DomeIfcPiece[] {
  const out: DomeIfcPiece[] = [];
  const o = res.memberProfile[0];
  if (!o) return out;
  const profile = res.memberProfile.map((q): [number, number] => [(q.x - o.x) * MM, (q.y - o.y) * MM]);
  for (const m of res.members) {
    const A = m.rings[0][0], B = m.rings[1][0];
    const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1) continue;
    const t = { x: dx / L, y: dy / L, z: dz / L };
    // Local X = the ring's own first-to-second direction (the profile's x).
    const P1 = m.rings[0][1];
    const sx = P1.x - A.x, sy = P1.y - A.y, sz = P1.z - A.z;
    const sl = Math.hypot(sx, sy, sz) || 1;
    out.push({
      location: [A.x * MM, A.y * MM, (A.z - bottomMm) * MM],
      axis: [t.x, t.y, t.z],
      refDirection: [sx / sl, sy / sl, sz / sl],
      profile,
      depthM: L * MM,
    });
  }
  return out;
}

export function facadeCassettePieces(res: FacadeResult, bottomMm: number): DomeIfcPiece[] {
  const out: DomeIfcPiece[] = [];
  for (const c of res.cassettes) {
    const f = res.faces[c.face];
    if (!f || c.placed.length < 3) continue;
    const o = c.placed[0];
    const V = c.solid.rings[0][0];
    out.push({
      location: [V.x * MM, V.y * MM, (V.z - bottomMm) * MM],
      axis: [f.n.x, f.n.y, 0],
      refDirection: [f.u.x, f.u.y, 0],
      profile: c.placed.map((q): [number, number] => [(q.x - o.x) * MM, (q.y - o.y) * MM]),
      depthM: Math.max(1, res.intent.cassetteDepthMm) * MM,
    });
  }
  return out;
}
