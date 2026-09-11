/**
 * helixMesh.ts — the monolithic cast spiral: a continuous helical waist slab
 * with the steps on top, the way a scară elicoidală is actually poured. The
 * stacked-wedge rendering shows prefab segments; this is the in-situ one.
 *
 * The cross-section logic mirrors `flightProfile` swept around the axis: the
 * steps' internal corners lie on the pitch helix, the soffit is the same helix
 * dropped by the waist measured perpendicular to the slope at the WALKING
 * radius (drop = t·√(g²+h²)/g — measuring vertically would thin the slab as
 * the stair steepens), and the soffit is clamped at floor level so the drum
 * sits on its floor.
 *
 * Only `three` is imported here, so the builder is testable without the whole
 * viewer stack. Coordinates: BIM mm in, scene metres out (x, z, −y)·0.001 —
 * the same mapping every viewer uses.
 */
import * as THREE from 'three';

export interface HelixParams {
  centerXMm: number;
  centerYMm: number;
  baseZMm: number;
  innerMm: number;
  outerMm: number;
  /** Angle of the walking-line start, radians CCW from +X. */
  startRad: number;
  /** Signed sweep per riser, radians — the turn's direction lives in the sign. */
  deltaRad: number;
  /** Riser count. */
  steps: number;
  riserMm: number;
  /** Going at the walking radius (mm) — what the waist drop derives from. */
  treadMm: number;
  waistMm: number;
}

const MM = 0.001;
/** Arc subdivisions per tread — enough to read as a curve, cheap to draw. */
const SEGS = 4;

export function buildHelixGeometry(p: HelixParams): THREE.BufferGeometry | null {
  const n = Math.floor(p.steps);
  const g = p.treadMm, h = p.riserMm, t = p.waistMm;
  if (n < 2 || !(g > 0) || !(h > 0) || !(t > 0) || !(p.outerMm > p.innerMm) || p.deltaRad === 0) {
    return null;
  }

  const drop = (t * Math.hypot(g, h)) / g;
  const rI = Math.max(0, p.innerMm), rO = p.outerMm;
  const stations = (n - 1) * SEGS;

  const theta = (i: number) => p.startRad + (i / SEGS) * p.deltaRad;
  const soffit = (i: number) => Math.max(p.baseZMm, p.baseZMm + (i / SEGS) * h - drop);
  const treadTop = (k: number) => p.baseZMm + (k + 1) * h;

  const pos: number[] = [];
  const P = (rad: number, r: number, z: number) => {
    const x = p.centerXMm + Math.cos(rad) * r;
    const y = p.centerYMm + Math.sin(rad) * r;
    pos.push(x * MM, z * MM, -y * MM);
  };
  const quad = (
    a: [number, number, number], b: [number, number, number],
    c: [number, number, number], d: [number, number, number],
  ) => {
    P(...a); P(...b); P(...c);
    P(...a); P(...c); P(...d);
  };

  for (let k = 0; k < n - 1; k++) {
    // The riser face at the front of tread k.
    const th = theta(k * SEGS);
    quad([th, rI, p.baseZMm + k * h], [th, rO, p.baseZMm + k * h],
      [th, rO, treadTop(k)], [th, rI, treadTop(k)]);

    for (let s = 0; s < SEGS; s++) {
      const i = k * SEGS + s;
      const a = theta(i), b = theta(i + 1);
      const top = treadTop(k);
      // Walking surface of tread k.
      quad([a, rI, top], [a, rO, top], [b, rO, top], [b, rI, top]);
      // The helical soffit underneath.
      quad([a, rI, soffit(i)], [b, rI, soffit(i + 1)],
        [b, rO, soffit(i + 1)], [a, rO, soffit(i)]);
      // The cylindrical side walls, soffit up to the tread.
      quad([a, rI, soffit(i)], [a, rI, top], [b, rI, top], [b, rI, soffit(i + 1)]);
      quad([a, rO, soffit(i)], [b, rO, soffit(i + 1)], [b, rO, top], [a, rO, top]);
    }
  }

  // End face: the last riser up to the floor above and the waist's cut, in one
  // plane — the slab edge of the arrival floor continues it.
  const thEnd = theta(stations);
  quad([thEnd, rI, soffit(stations)], [thEnd, rO, soffit(stations)],
    [thEnd, rO, p.baseZMm + n * h], [thEnd, rI, p.baseZMm + n * h]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}
