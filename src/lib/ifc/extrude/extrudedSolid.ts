/**
 * extrudedSolid.ts — a contour drawn on a plane, extruded straight up.
 *
 * This is the whole data model for the viewers' editing tools, and it is
 * deliberately the SAME model in both. The TOC viewer draws it with Three.js,
 * the World view draws it as a Cesium polygon, and the IFC exporter turns it
 * into `IfcExtrudedAreaSolid` — three renderers, one description.
 *
 * The description is not an arbitrary choice: `IfcArbitraryClosedProfileDef`
 * swept along the local +Z axis is exactly "a contour, extruded up". So the
 * thing the user draws survives the round trip to IFC as the same parametric
 * object, not as a bag of triangles. Height, position, rotation and scale all
 * stay editable, on our side and in whatever opens the file.
 *
 * Frame and units
 * ---------------
 * Everything here is METRES in a right-handed frame: +x east/right, +y
 * north/forward, +z up. `rotation` is degrees COUNTER-CLOCKWISE about +z seen
 * from above, matching that frame (and IFC's `RefDirection`). The viewers
 * convert to their own axes at the last moment; nothing in this file knows
 * about Three.js or Cesium.
 *
 * The profile is stored CENTRED on its own centroid, with the centroid carried
 * in `placement`. That is what makes rotation and scale behave the way a
 * person expects — about the object, not about some far-away drawing origin.
 */

export interface Pt2 { x: number; y: number }

/** Where a solid stands, and how it is turned and stretched. */
export interface SolidPlacement {
  /** Centroid of the profile, metres. */
  x: number;
  y: number;
  /** Elevation of the profile plane, metres. The solid grows upward from it. */
  z: number;
  /** Degrees counter-clockwise about +z, seen from above. */
  rotation: number;
  /** Scale about the centroid; sz stretches the height. */
  sx: number;
  sy: number;
  sz: number;
}

export interface ExtrudedSolid {
  id: string;
  name: string;
  /** IFC entity to export as. Any IfcProduct that can carry a shape. */
  ifcType: string;
  /** Closed contour in local XY, metres, centred on the centroid. The
   *  closing edge is implicit: the last point joins the first. */
  profile: Pt2[];
  /** Extrusion height before `sz`, metres. */
  height: number;
  placement: SolidPlacement;
  /** Hex colour for the viewers. Carries no meaning in IFC. */
  color: string;
}

export const DEFAULT_HEIGHT_M = 3;
export const DEFAULT_COLOR = '#38bdf8';
/** Below this a contour is a stray double-click, not a shape. */
export const MIN_AREA_M2 = 0.01;

export const IDENTITY_PLACEMENT: SolidPlacement = {
  x: 0, y: 0, z: 0, rotation: 0, sx: 1, sy: 1, sz: 1,
};

// ── Polygon maths ────────────────────────────────────────────────────────────

/** Twice the signed area. Positive when the ring runs counter-clockwise. */
export function signedArea2(pts: Pt2[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

export function polygonArea(pts: Pt2[]): number {
  return Math.abs(signedArea2(pts)) / 2;
}

export function polygonPerimeter(pts: Pt2[]): number {
  let p = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

/**
 * Area centroid — NOT the average of the vertices.
 *
 * The average moves when you add a point to one side of the shape without
 * changing the shape, which would make rotation drift as the user clicks.
 * Degenerate rings (zero area) fall back to the vertex average, which is the
 * only thing left to say about them.
 */
export function polygonCentroid(pts: Pt2[]): Pt2 {
  const a2 = signedArea2(pts);
  if (Math.abs(a2) < 1e-12) {
    const n = pts.length || 1;
    return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const cross = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) };
}

/** Counter-clockwise winding, which is what IFC profiles and our triangulation
 *  both assume. Returns the same array when it already runs that way. */
export function ensureCCW(pts: Pt2[]): Pt2[] {
  return signedArea2(pts) < 0 ? [...pts].reverse() : pts;
}

/** Drop points that repeat the previous one, including the wrap-around. */
export function dedupe(pts: Pt2[], epsilon = 1e-6): Pt2[] {
  const out: Pt2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) <= epsilon) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) <= epsilon) out.pop();
    else break;
  }
  return out;
}

/** Do the open segments ab and cd cross? Shared endpoints do not count. */
function segmentsCross(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
  const cross = (o: Pt2, p: Pt2, q: Pt2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
      && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Does the ring cross itself? A bowtie extrudes into a solid with inverted
 * faces that no IFC consumer can make sense of, so it is worth refusing at
 * the point of drawing rather than exporting nonsense.
 */
export function selfIntersects(pts: Pt2[]): boolean {
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (i === j) continue;
      // Skip neighbours and the wrap-around pair: they share an endpoint.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

// ── Building one ─────────────────────────────────────────────────────────────

export interface ContourProblem { ok: false; reason: 'too-few' | 'too-small' | 'self-intersecting' }
export type ContourCheck = { ok: true; points: Pt2[] } | ContourProblem;

/** Everything that has to be true before a contour can become a solid. */
export function checkContour(raw: Pt2[]): ContourCheck {
  const pts = ensureCCW(dedupe(raw));
  if (pts.length < 3) return { ok: false, reason: 'too-few' };
  // Self-intersection is tested BEFORE area on purpose: a symmetric bowtie has
  // an area of exactly zero, so checking size first would reject it as "too
  // small" and send the user off to draw a bigger version of the same
  // impossible shape.
  if (selfIntersects(pts)) return { ok: false, reason: 'self-intersecting' };
  if (polygonArea(pts) < MIN_AREA_M2) return { ok: false, reason: 'too-small' };
  return { ok: true, points: pts };
}

export interface CreateExtrusionOptions {
  id?: string;
  name?: string;
  ifcType?: string;
  height?: number;
  /** Elevation of the contour's plane, metres. */
  elevation?: number;
  color?: string;
}

/**
 * A drawn contour (in drawing coordinates) → a parametric solid.
 *
 * The contour's centroid becomes the placement and the profile is re-expressed
 * around it, so the returned solid sits exactly where it was drawn while its
 * rotation and scale pivot on the shape itself.
 *
 * Returns the problem instead of a solid when the contour cannot carry one.
 */
export function createExtrusion(
  raw: Pt2[],
  opts: CreateExtrusionOptions = {},
): { ok: true; solid: ExtrudedSolid } | ContourProblem {
  const checked = checkContour(raw);
  if (!checked.ok) return checked;
  const c = polygonCentroid(checked.points);
  return {
    ok: true,
    solid: {
      id: opts.id ?? `xs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: opts.name ?? 'Extrudare',
      ifcType: opts.ifcType ?? 'IFCBUILDINGELEMENTPROXY',
      profile: checked.points.map((p) => ({ x: p.x - c.x, y: p.y - c.y })),
      height: opts.height ?? DEFAULT_HEIGHT_M,
      placement: { ...IDENTITY_PLACEMENT, x: c.x, y: c.y, z: opts.elevation ?? 0 },
      color: opts.color ?? DEFAULT_COLOR,
    },
  };
}

// ── Parametric edits ─────────────────────────────────────────────────────────

/** A solid is never mutated; every edit hands back a new one. */
export function withPlacement(s: ExtrudedSolid, patch: Partial<SolidPlacement>): ExtrudedSolid {
  const next = { ...s.placement, ...patch };
  // A zero or negative scale collapses or mirrors the solid, and a mirrored
  // profile exports with inverted faces. Clamp rather than refuse: the user is
  // dragging a number field, not making a decision.
  next.sx = Math.max(1e-3, next.sx);
  next.sy = Math.max(1e-3, next.sy);
  next.sz = Math.max(1e-3, next.sz);
  next.rotation = ((next.rotation % 360) + 360) % 360;
  return { ...s, placement: next };
}

export function moveSolid(s: ExtrudedSolid, dx: number, dy: number, dz = 0): ExtrudedSolid {
  return withPlacement(s, { x: s.placement.x + dx, y: s.placement.y + dy, z: s.placement.z + dz });
}

export function rotateSolid(s: ExtrudedSolid, deltaDeg: number): ExtrudedSolid {
  return withPlacement(s, { rotation: s.placement.rotation + deltaDeg });
}

/** Multiply the current scale. `sz` defaults to the plan factor so a single
 *  number scales the solid uniformly, which is the common case. */
export function scaleSolid(s: ExtrudedSolid, fx: number, fy = fx, fz = 1): ExtrudedSolid {
  return withPlacement(s, {
    sx: s.placement.sx * fx, sy: s.placement.sy * fy, sz: s.placement.sz * fz,
  });
}

export function setHeight(s: ExtrudedSolid, height: number): ExtrudedSolid {
  return { ...s, height: Math.max(1e-3, height) };
}

// ── Derived geometry and quantities ──────────────────────────────────────────

/** The profile with scale and rotation applied but still centred on the
 *  origin — the shape as it is oriented, before it is put anywhere. */
export function orientedProfile(s: ExtrudedSolid): Pt2[] {
  const r = (s.placement.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return s.profile.map((p) => {
    const x = p.x * s.placement.sx;
    const y = p.y * s.placement.sy;
    return { x: x * cos - y * sin, y: x * sin + y * cos };
  });
}

/** The footprint where it actually stands, in drawing coordinates. */
export function worldProfile(s: ExtrudedSolid): Pt2[] {
  return orientedProfile(s).map((p) => ({ x: p.x + s.placement.x, y: p.y + s.placement.y }));
}

/** Height after `sz`, metres — what gets extruded and exported. */
export function effectiveHeight(s: ExtrudedSolid): number {
  return s.height * s.placement.sz;
}

export function topElevation(s: ExtrudedSolid): number {
  return s.placement.z + effectiveHeight(s);
}

export interface SolidQuantities {
  areaM2: number;
  perimeterM: number;
  heightM: number;
  volumeM3: number;
  /** Side faces only — the useful one for cladding and formwork. */
  lateralAreaM2: number;
}

export function solidQuantities(s: ExtrudedSolid): SolidQuantities {
  const ring = orientedProfile(s);
  const areaM2 = polygonArea(ring);
  const perimeterM = polygonPerimeter(ring);
  const heightM = effectiveHeight(s);
  return {
    areaM2,
    perimeterM,
    heightM,
    volumeM3: areaM2 * heightM,
    lateralAreaM2: perimeterM * heightM,
  };
}

/** Axis-aligned bounds of the footprint, for fitting a camera. */
export function solidBounds(s: ExtrudedSolid): { minX: number; minY: number; maxX: number; maxY: number } {
  const ring = worldProfile(s);
  return {
    minX: Math.min(...ring.map((p) => p.x)),
    minY: Math.min(...ring.map((p) => p.y)),
    maxX: Math.max(...ring.map((p) => p.x)),
    maxY: Math.max(...ring.map((p) => p.y)),
  };
}

/**
 * Fan triangulation of the profile, as index triples into the ring.
 *
 * Correct for convex rings and for the mildly concave ones a person draws by
 * clicking corners; it is not a general polygon triangulator. Both viewers
 * share it so a shape can never be watertight in one and torn in the other.
 */
export function fanTriangles(ring: Pt2[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 1; i + 1 < ring.length; i++) out.push([0, i, i + 1]);
  return out;
}
