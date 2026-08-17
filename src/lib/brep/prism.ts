/**
 * Internal B-rep kernel — prism / sweep primitives.
 *
 * Nearly every element BubbleGraph authors is a planar profile swept along a
 * straight vector: walls and slabs sweep a plan footprint up, beams and rafters
 * sweep a rectangular section along their axis, roof covering sweeps a pitched
 * face along its own normal. One well-tested primitive covers all of them, which
 * is the main reason the current code's several ad-hoc mesh builders can collapse
 * into this module.
 *
 * All inputs are BIM mm in world space (X east, Y north, Z up).
 */

import type { Solid, Vec2, Vec3 } from './types';
import { makeSolid, type FaceInput } from './solid';
import { cross, dot, len, newellNormal, normalize, scale, sub } from './vec';

/**
 * Sweep a planar 3D polygon along `d`, producing a closed prism.
 *
 * The profile's winding does not matter: it is reoriented so the swept cap faces
 * along `d`. Faces are tagged `'start'` (the cap at the profile), `'end'` (the
 * swept cap) and `'side'`.
 *
 * Returns `null` for a degenerate profile or a sweep vector parallel to the
 * profile plane — both produce zero volume rather than a usable solid.
 */
export function extrudePolygon3(profile: Vec3[], d: Vec3, tag?: string): Solid | null {
  if (profile.length < 3) return null;

  const raw = newellNormal(profile);
  const area = len(raw);
  if (area < 1e-9) return null;

  let n = scale(raw, 1 / area);
  let base = profile;
  // Orient the profile so its normal runs with the sweep.
  const along = dot(n, d);
  if (Math.abs(along) < 1e-9) return null; // sweeping inside the profile's own plane
  if (along < 0) { base = [...profile].reverse(); n = scale(n, -1); }

  const count = base.length;
  const vertices: Vec3[] = [
    ...base,
    ...base.map((p) => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z })),
  ];
  const lo = (i: number) => i;
  const hi = (i: number) => count + i;

  const faces: FaceInput[] = [
    // Back cap: same ring, reversed, normal opposite the sweep.
    { outer: base.map((_, i) => lo(count - 1 - i)), normal: scale(n, -1), tag: 'start' },
    // Front cap: swept ring, normal along the sweep.
    { outer: base.map((_, i) => hi(i)), normal: n, tag: 'end' },
  ];

  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    // (edge direction) × (sweep) points away from the profile interior.
    const outward = cross(sub(base[j], base[i]), d);
    faces.push({ outer: [lo(i), lo(j), hi(j), hi(i)], normal: outward, tag: 'side' });
  }

  return makeSolid(vertices, faces, tag ? { tag } : {});
}

/**
 * Extrude a plan footprint vertically — the wall / slab / room workhorse.
 *
 * @param footprint Plan polygon in BIM mm (X east, Y north). Winding is corrected automatically.
 * @param baseZ     Elevation of the bottom face (BIM mm).
 * @param height    Extrusion height (BIM mm). Must be > 0.
 *
 * Caps are tagged `'bottom'` / `'top'` (rather than `'start'` / `'end'`) so
 * consumers can address them by their architectural meaning.
 */
export function extrudeFootprint(
  footprint: Vec2[],
  baseZ: number,
  height: number,
  tag?: string,
): Solid | null {
  if (footprint.length < 3 || !(height > 0)) return null;
  const profile: Vec3[] = footprint.map((p) => ({ x: p.x, y: p.y, z: baseZ }));
  const solid = extrudePolygon3(profile, { x: 0, y: 0, z: height }, tag);
  if (!solid) return null;
  return {
    ...solid,
    faces: solid.faces.map((f) =>
      f.tag === 'start' ? { ...f, tag: 'bottom' } : f.tag === 'end' ? { ...f, tag: 'top' } : f,
    ),
  };
}

/** Axis-aligned box from its centre and full extents (BIM mm). */
export function boxSolid(center: Vec3, sizeX: number, sizeY: number, sizeZ: number, tag?: string): Solid | null {
  if (!(sizeX > 0) || !(sizeY > 0) || !(sizeZ > 0)) return null;
  const hx = sizeX / 2, hy = sizeY / 2;
  const footprint: Vec2[] = [
    { x: center.x - hx, y: center.y - hy },
    { x: center.x + hx, y: center.y - hy },
    { x: center.x + hx, y: center.y + hy },
    { x: center.x - hx, y: center.y + hy },
  ];
  return extrudeFootprint(footprint, center.z - sizeZ / 2, sizeZ, tag);
}

/**
 * Rectangular member swept from `a` to `b` — beams, rafters, battens, ring beams.
 *
 * `width` runs horizontally across the axis and `height` across it in the
 * up-ish direction, matching how section codes are read (`B20x30` = 20 cm wide,
 * 30 cm deep). For a vertical member the reference "up" falls back to +X so the
 * section stays well defined.
 */
export function sweepBox(a: Vec3, b: Vec3, width: number, height: number, tag?: string): Solid | null {
  const axis = sub(b, a);
  const l = len(axis);
  if (l < 1e-9 || !(width > 0) || !(height > 0)) return null;
  const dir = scale(axis, 1 / l);

  const worldUp: Vec3 = Math.abs(dir.z) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  const side = normalize(cross(dir, worldUp));   // horizontal, across the axis
  const up = cross(side, dir);                   // completes the right-handed section frame

  const hw = width / 2, hh = height / 2;
  const corner = (sw: number, sh: number): Vec3 => ({
    x: a.x + side.x * sw * hw + up.x * sh * hh,
    y: a.y + side.y * sw * hw + up.y * sh * hh,
    z: a.z + side.z * sw * hw + up.z * sh * hh,
  });

  const profile = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  return extrudePolygon3(profile, axis, tag);
}

/**
 * Regular n-gon prism — the stand-in for circular columns, gutters and downpipes.
 *
 * The kernel has no analytic curved faces by design (see `types.ts`), so round
 * elements arrive pre-tessellated exactly as the current renderers already draw
 * them; `sides` controls that trade-off at the call site.
 */
export function cylinderSolid(
  center: Vec2,
  baseZ: number,
  radius: number,
  height: number,
  sides = 18,
  tag?: string,
): Solid | null {
  if (!(radius > 0) || !(height > 0) || sides < 3) return null;
  const footprint: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    footprint.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return extrudeFootprint(footprint, baseZ, height, tag);
}
