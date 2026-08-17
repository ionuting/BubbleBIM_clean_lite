/**
 * details.ts — optional generated "detail layers" for the roof assembly.
 *
 * Each layer is a small PURE generator (context → graph nodes). They all build
 * on the per-face orthonormal basis from `faceGeometry` and a robust edge
 * classifier (eave vs rake vs shared), so a single implementation works for
 * every roof type the envelope engine produces (gable, hip, straight-skeleton,
 * cross-gable, mansard). Layers are opt-in via `RoofIntent.details`.
 *
 * Output nodes carry the same `ax..bz` / `face_vertices` conventions the rest
 * of the roof uses, so every generated element is a normal, selectable graph
 * node the user can re-edit parametrically. New element kinds slot in by adding
 * one generator + one entry to the type sets in `types.ts` and a render branch.
 */
import type { BubbleGraphNode } from '@/store';
import type { Pt2, Pt3, RoofContour, RoofDetailOptions, RoofFace3D, RoofIntent, SkeletonSeg } from './types';
import { computeFaceBasis, faceUV, uvToWorld, type FaceBasis } from './faceGeometry';

function uid(): string { return Math.random().toString(36).slice(2, 10); }
function segLen(a: Pt3, b: Pt3): number { return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z); }
function lerp3(a: Pt3, b: Pt3, t: number): Pt3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
/** Timber section string `T{w_cm}x{h_cm}` from millimetre dimensions. */
function sectionFromMm(wMm: number, hMm: number): string {
  return `T${(wMm / 10).toFixed(1)}x${(hMm / 10).toFixed(1)}`;
}
/** Section (cm) → dimensions in mm. */
function sectionDimsMm(t: string): { w: number; h: number } {
  const m = t?.match(/^[Tt](\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  return m ? { w: +m[1] * 10, h: +m[2] * 10 } : { w: 40, h: 60 };
}
function offN(p: Pt3, basis: FaceBasis, dMm: number): Pt3 {
  return { x: p.x + basis.n.x * dMm, y: p.y + basis.n.y * dMm, z: p.z + basis.n.z * dMm };
}

/** Enabled thin above-rafter layers (mm each), used for both lift and stacking. */
function buildupParts(d: RoofDetailOptions): { bh: number; ch: number; mem: number; sh: number } {
  return {
    bh: d.battens ? sectionDimsMm(d.battenSection).h : 0,
    ch: d.counterBattens ? sectionDimsMm(d.counterBattenSection).h : 0,
    mem: d.membrane ? 3 : 0,
    sh: d.sheathing ? d.sheathingThicknessMm : 0,
  };
}

/**
 * Total VERTICAL lift (mm) of the covering surface above the structural plane:
 *   rafter section height (clears the rafter boxes, whose axis is on the plane)
 *   + the thin above-rafter build-up that is actually enabled (battens, counter-
 *     battens, membrane, sheathing)
 *   + the user's `coveringOffsetMm`.
 * With no detail layers the lift is simply the rafter height, so the tiles sit
 * just clear of the rafters. Shared by the 3D covering render and the detail
 * layers so they always move together.
 */
export function coveringLiftMm(intent: RoofIntent): number {
  const { bh, ch, mem, sh } = buildupParts(intent.details);
  return sectionDimsMm(intent.rafterSection).h + bh + ch + mem + sh + Math.max(0, intent.coveringOffsetMm);
}

/** Copy of `faces` with every vertex raised in world Z by `dz` (keeps tilt/normal). */
export function liftFacesZ(faces: RoofFace3D[], dz: number): RoofFace3D[] {
  if (Math.abs(dz) < 1e-6) return faces;
  return faces.map((f) => ({ ...f, vertices: f.vertices.map((v) => ({ x: v.x, y: v.y, z: v.z + dz })) }));
}

export interface DetailContext {
  roofId: string;
  parentId: string | undefined;
  contour: RoofContour;
  intent: RoofIntent;
  skeleton: SkeletonSeg[];
  faces: RoofFace3D[];
  baseZ: number;
}

// ── node factories ───────────────────────────────────────────────────────────

function linearNode(
  type: string, name: string, a: Pt3, b: Pt3, section: string,
  material: string, ctx: DetailContext, extra: Record<string, unknown> = {},
): BubbleGraphNode {
  return {
    id: `${type}_${ctx.roofId}_${uid()}`,
    type, name,
    x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2,
    parentId: ctx.parentId,
    properties: {
      source_roof_id: ctx.roofId, generated: true, section, material,
      length_mm: segLen(a, b),
      ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, ...extra,
    },
  };
}

function roundNode(
  type: string, name: string, a: Pt3, b: Pt3, diameterMm: number,
  material: string, ctx: DetailContext,
): BubbleGraphNode {
  return {
    id: `${type}_${ctx.roofId}_${uid()}`,
    type, name,
    x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2,
    parentId: ctx.parentId,
    properties: {
      source_roof_id: ctx.roofId, generated: true, round: true, diameter_mm: diameterMm, material,
      length_mm: segLen(a, b),
      ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z,
    },
  };
}

function sheetNode(
  type: string, name: string, verts: Pt3[], material: string, thicknessMm: number, ctx: DetailContext,
): BubbleGraphNode {
  const cx = verts.reduce((s, v) => s + v.x, 0) / verts.length;
  const cy = verts.reduce((s, v) => s + v.y, 0) / verts.length;
  const cz = verts.reduce((s, v) => s + v.z, 0) / verts.length;
  return {
    id: `${type}_${ctx.roofId}_${uid()}`,
    type, name, x: cx, y: cy, z: cz, parentId: ctx.parentId,
    properties: {
      source_roof_id: ctx.roofId, generated: true, material, thickness: thicknessMm, pitched: true,
      face_vertices: JSON.stringify(verts),
    },
  };
}

// ── geometry helpers ─────────────────────────────────────────────────────────

/** Slope faces with a valid basis, paired with their (u,v) polygon + extents. */
interface FaceInfo {
  face: RoofFace3D;
  basis: FaceBasis;
  uvPoly: { u: number; v: number }[];
  uMin: number; uMax: number; vMax: number;
}
function slopeFaceInfos(faces: RoofFace3D[]): FaceInfo[] {
  const out: FaceInfo[] = [];
  for (const face of faces) {
    if (face.role !== 'slope' || face.vertices.length < 3) continue;
    const basis = computeFaceBasis(face);
    if (!basis) continue;
    const uvPoly = face.vertices.map((v) => faceUV(basis, v));
    let uMin = Infinity, uMax = -Infinity, vMax = -Infinity;
    for (const p of uvPoly) {
      uMin = Math.min(uMin, p.u); uMax = Math.max(uMax, p.u); vMax = Math.max(vMax, p.v);
    }
    out.push({ face, basis, uvPoly, uMin, uMax, vMax });
  }
  return out;
}

/** Scanline crossings of a (u,v) polygon: intervals of the OTHER axis at fixed `c`. */
function scanline(poly: { u: number; v: number }[], axis: 'u' | 'v', c: number): [number, number][] {
  const cross: number[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const av = axis === 'v' ? a.v : a.u;
    const bv = axis === 'v' ? b.v : b.u;
    const au = axis === 'v' ? a.u : a.v;
    const bu = axis === 'v' ? b.u : b.v;
    if ((av <= c && bv > c) || (bv <= c && av > c)) {
      cross.push(au + ((c - av) / (bv - av)) * (bu - au));
    }
  }
  cross.sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < cross.length; i += 2) out.push([cross[i], cross[i + 1]]);
  return out;
}

/** Edges of all slope faces, classified. `eave` = lowest & unshared; `rake` = unshared & rising. */
interface ClassifiedEdge { a: Pt3; b: Pt3; }
function classifyEdges(faces: RoofFace3D[]): { eaves: ClassifiedEdge[]; rakes: ClassifiedEdge[] } {
  const key = (p: Pt3) => `${Math.round(p.x)}_${Math.round(p.y)}_${Math.round(p.z)}`;
  const count = new Map<string, number>();
  const edgeKey = (a: Pt3, b: Pt3) => [key(a), key(b)].sort().join('|');
  const all: ClassifiedEdge[] = [];
  let minZ = Infinity;
  for (const f of faces) {
    if (f.role !== 'slope' || f.vertices.length < 3) continue;
    const V = f.vertices;
    for (let i = 0; i < V.length; i++) {
      const a = V[i], b = V[(i + 1) % V.length];
      minZ = Math.min(minZ, a.z, b.z);
      const k = edgeKey(a, b);
      count.set(k, (count.get(k) ?? 0) + 1);
      all.push({ a, b });
    }
  }
  const eaves: ClassifiedEdge[] = [];
  const rakes: ClassifiedEdge[] = [];
  const seen = new Set<string>();
  for (const e of all) {
    const k = edgeKey(e.a, e.b);
    if ((count.get(k) ?? 0) !== 1) continue;   // shared → ridge/hip/valley
    if (seen.has(k)) continue;
    seen.add(k);
    // Eave = the lowest run of the roof (lift-invariant: measured against the
    // actual minimum face height, not a fixed baseZ, so it works after the
    // covering has been raised above the rafters).
    const lowBoth = Math.abs(e.a.z - minZ) < 50 && Math.abs(e.b.z - minZ) < 50;
    const horiz = Math.abs(e.a.z - e.b.z) < 50;
    if (lowBoth && horiz) eaves.push(e);
    else rakes.push(e);
  }
  return { eaves, rakes };
}

/** Horizontal outward normal of an eave edge (points away from the plan centroid). */
function eaveOutward(a: Pt3, b: Pt3, centroid: Pt2): Pt2 {
  const ex = b.x - a.x, ey = b.y - a.y;
  const L = Math.hypot(ex, ey) || 1;
  let px = -ey / L, py = ex / L;
  const mx = (a.x + b.x) / 2 - centroid.x, my = (a.y + b.y) / 2 - centroid.y;
  if (px * mx + py * my < 0) { px = -px; py = -py; }
  return { x: px, y: py };
}

/** Nearest contour point along a ray in plan (for collar-tie feet). */
function contourFoot(o: Pt3, dir: Pt2, pts: Pt2[], baseZ: number): Pt3 | null {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const ex = b.x - a.x, ey = b.y - a.y;
    const det = ex * dir.y - ey * dir.x;
    if (Math.abs(det) < 1e-9) continue;
    const t = (-(a.x - o.x) * ey + ex * (a.y - o.y)) / det;
    const u = (dir.x * (a.y - o.y) - dir.y * (a.x - o.x)) / det;
    if (t > 1 && u > -1e-6 && u < 1 + 1e-6 && t < best) best = t;
  }
  return isFinite(best) ? { x: o.x + dir.x * best, y: o.y + dir.y * best, z: baseZ } : null;
}

function samplesAlong(a: Pt3, b: Pt3, spacingMm: number): Pt3[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.max(1, Math.round(len / Math.max(spacingMm, 50)));
  return Array.from({ length: n + 1 }, (_, i) => lerp3(a, b, i / n));
}

// ── layer stack offsets (mm, DOWN from the lifted covering plane along −n) ────
// The covering faces are already raised to sit above the rafters, so the
// build-up hangs just beneath them: tile → batten → counter-batten → membrane →
// sheathing → (insulation, which is allowed to reach down between the rafters).
function layerOffsets(d: RoofDetailOptions): {
  batten: number; counter: number; membrane: number; sheathing: number; insulation: number;
} {
  const { bh, ch, mem, sh } = buildupParts(d);
  return {
    batten: -bh / 2,
    counter: -(bh + ch / 2),
    membrane: -(bh + ch + mem / 2),
    sheathing: -(bh + ch + mem + sh / 2),
    insulation: -(bh + ch + mem + sh + d.insulationThicknessMm / 2),
  };
}

// ── generators ─────────────────────────────────────────────────────────────

function genSheets(ctx: DetailContext, kind: 'membrane' | 'sheathing' | 'insulation'): BubbleGraphNode[] {
  const d = ctx.intent.details;
  const off = layerOffsets(d)[kind === 'membrane' ? 'membrane' : kind];
  const thick = kind === 'membrane' ? 2 : kind === 'sheathing' ? d.sheathingThicknessMm : d.insulationThicknessMm;
  const mat = kind === 'membrane' ? 'Folie anticondens' : kind === 'sheathing' ? 'Astereala lemn' : 'Vata minerala';
  const name = kind === 'membrane' ? 'Membrane' : kind === 'sheathing' ? 'Sheathing' : 'Insulation';
  const nodes: BubbleGraphNode[] = [];
  for (const fi of slopeFaceInfos(ctx.faces)) {
    const verts = fi.face.vertices.map((v) => offN(v, fi.basis, off));
    nodes.push(sheetNode(kind, name, verts, mat, thick, ctx));
  }
  return nodes;
}

function genBattens(ctx: DetailContext): BubbleGraphNode[] {
  const d = ctx.intent.details;
  const offs = layerOffsets(d);
  const nodes: BubbleGraphNode[] = [];
  for (const fi of slopeFaceInfos(ctx.faces)) {
    if (d.counterBattens) {
      for (let uc = fi.uMin + d.counterBattenSpacingMm; uc < fi.uMax; uc += d.counterBattenSpacingMm) {
        for (const [v0, v1] of scanline(fi.uvPoly, 'u', uc)) {
          const a = offN(uvToWorld(fi.basis, uc, v0), fi.basis, offs.counter);
          const b = offN(uvToWorld(fi.basis, uc, v1), fi.basis, offs.counter);
          nodes.push(linearNode('counter_batten', 'Counter batten', a, b, d.counterBattenSection, 'Lemn rasinos', ctx, { role: 'counter_batten' }));
        }
      }
    }
    if (d.battens) {
      for (let vc = d.battenSpacingMm; vc < fi.vMax; vc += d.battenSpacingMm) {
        for (const [u0, u1] of scanline(fi.uvPoly, 'v', vc)) {
          const a = offN(uvToWorld(fi.basis, u0, vc), fi.basis, offs.batten);
          const b = offN(uvToWorld(fi.basis, u1, vc), fi.basis, offs.batten);
          nodes.push(linearNode('batten', 'Batten', a, b, d.battenSection, 'Lemn rasinos', ctx, { role: 'batten' }));
        }
      }
    }
  }
  return nodes;
}

function genEaveTrim(ctx: DetailContext, centroid: Pt2, eaves: ClassifiedEdge[]): BubbleGraphNode[] {
  const d = ctx.intent.details;
  const nodes: BubbleGraphNode[] = [];
  for (const e of eaves) {
    const out = eaveOutward(e.a, e.b, centroid);
    const eaveZ = e.a.z; // the (possibly lifted) covering eave elevation
    if (d.fascia) {
      const zc = eaveZ - d.fasciaHeightMm / 2;
      const a: Pt3 = { x: e.a.x, y: e.a.y, z: zc };
      const b: Pt3 = { x: e.b.x, y: e.b.y, z: zc };
      nodes.push(linearNode('fascia', 'Fascia', a, b, sectionFromMm(d.fasciaThicknessMm, d.fasciaHeightMm), 'Lemn rasinos', ctx, { role: 'fascia' }));
    }
    if (d.soffit) {
      const z = eaveZ - d.fasciaHeightMm;
      const w = Math.max(100, ctx.intent.overhangMm);
      const inA: Pt3 = { x: e.a.x - out.x * w, y: e.a.y - out.y * w, z };
      const inB: Pt3 = { x: e.b.x - out.x * w, y: e.b.y - out.y * w, z };
      nodes.push(sheetNode('soffit', 'Soffit', [{ x: e.a.x, y: e.a.y, z }, { x: e.b.x, y: e.b.y, z }, inB, inA], 'Lemn rasinos', 20, ctx));
    }
    if (d.gutters) {
      const gr = d.gutterDiameterMm;
      const a: Pt3 = { x: e.a.x + out.x * gr, y: e.a.y + out.y * gr, z: eaveZ - gr };
      const b: Pt3 = { x: e.b.x + out.x * gr, y: e.b.y + out.y * gr, z: eaveZ - gr };
      nodes.push(roundNode('gutter', 'Gutter', a, b, gr, 'Tabla zincata', ctx));
    }
    if (d.downpipes) {
      const gr = d.gutterDiameterMm;
      for (const p of samplesAlong(e.a, e.b, d.downpipeSpacingMm)) {
        const top: Pt3 = { x: p.x + out.x * gr, y: p.y + out.y * gr, z: eaveZ - gr };
        const bot: Pt3 = { x: top.x, y: top.y, z: Math.min(0, ctx.baseZ - 3000) };
        nodes.push(roundNode('downpipe', 'Downpipe', top, bot, d.downpipeDiameterMm, 'Tabla zincata', ctx));
      }
    }
    if (d.snowGuards) {
      // A short bar a little up-slope from the eave, repeated along it.
      const upx = -out.x, upy = -out.y; // up-slope horizontal ≈ inward
      for (const p of samplesAlong(e.a, e.b, d.snowGuardSpacingMm)) {
        if (Math.hypot(p.x - e.a.x, p.y - e.a.y) < 100 || Math.hypot(p.x - e.b.x, p.y - e.b.y) < 100) continue;
        const a: Pt3 = { x: p.x - upx * 30, y: p.y - upy * 30, z: eaveZ + 40 };
        const b: Pt3 = { x: p.x + upx * 150, y: p.y + upy * 150, z: eaveZ + 90 };
        nodes.push(linearNode('snow_guard', 'Snow guard', a, b, 'T2x4', 'Otel', ctx, { role: 'snow_guard' }));
      }
    }
  }
  return nodes;
}

function genRakeTrim(ctx: DetailContext, rakes: ClassifiedEdge[]): BubbleGraphNode[] {
  const d = ctx.intent.details;
  if (!d.bargeBoard) return [];
  return rakes.map((e) =>
    linearNode('barge_board', 'Barge board', e.a, e.b, sectionFromMm(d.fasciaThicknessMm, d.fasciaHeightMm), 'Lemn rasinos', ctx, { role: 'barge_board' }),
  );
}

function genCaps(ctx: DetailContext): BubbleGraphNode[] {
  const d = ctx.intent.details;
  const nodes: BubbleGraphNode[] = [];
  const raise = (p: Pt3, dz: number): Pt3 => ({ x: p.x, y: p.y, z: p.z + dz });
  if (d.ridgeCaps) {
    for (const s of ctx.skeleton) {
      if (s.role !== 'ridge') continue;
      nodes.push(linearNode('ridge_cap', 'Ridge cap', raise(s.a, 30), raise(s.b, 30), sectionFromMm(d.ridgeCapWidthMm, 60), 'Coama ceramica', ctx, { role: 'ridge_cap' }));
    }
  }
  if (d.hipCaps) {
    for (const s of ctx.skeleton) {
      if (s.role !== 'hip') continue;
      nodes.push(linearNode('hip_cap', 'Hip cap', raise(s.a, 30), raise(s.b, 30), sectionFromMm(d.ridgeCapWidthMm, 60), 'Coama ceramica', ctx, { role: 'hip_cap' }));
    }
  }
  if (d.valleyFlashing) {
    for (const s of ctx.skeleton) {
      if (s.role !== 'valley') continue;
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
      const L = Math.hypot(dx, dy) || 1;
      const px = -dy / L, py = dx / L;
      const hw = d.valleyFlashingWidthMm / 2;
      const verts: Pt3[] = [
        { x: s.a.x - px * hw, y: s.a.y - py * hw, z: s.a.z },
        { x: s.a.x + px * hw, y: s.a.y + py * hw, z: s.a.z },
        { x: s.b.x + px * hw, y: s.b.y + py * hw, z: s.b.z },
        { x: s.b.x - px * hw, y: s.b.y - py * hw, z: s.b.z },
      ];
      nodes.push(sheetNode('valley_flashing', 'Valley flashing', verts, 'Tabla zincata', 2, ctx));
    }
  }
  return nodes;
}

function genCollarTies(ctx: DetailContext): BubbleGraphNode[] {
  const d = ctx.intent.details;
  if (!d.collarTies) return [];
  const nodes: BubbleGraphNode[] = [];
  const spacing = Math.max(1200, ctx.intent.rafterSpacingMm * 2);
  for (const s of ctx.skeleton) {
    if (s.role !== 'ridge') continue;
    const zRidge = s.a.z;
    const zc = ctx.baseZ + (zRidge - ctx.baseZ) * Math.min(0.95, Math.max(0.2, d.collarHeightRatio));
    const frac = zRidge > ctx.baseZ ? (zRidge - zc) / (zRidge - ctx.baseZ) : 0;
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
    const L = Math.hypot(dx, dy) || 1;
    const perp: Pt2 = { x: -dy / L, y: dx / L };
    for (const rp of samplesAlong(s.a, s.b, spacing)) {
      const footA = contourFoot({ ...rp, z: ctx.baseZ }, perp, ctx.contour.points, ctx.baseZ);
      const footB = contourFoot({ ...rp, z: ctx.baseZ }, { x: -perp.x, y: -perp.y }, ctx.contour.points, ctx.baseZ);
      if (!footA || !footB) continue;
      const a: Pt3 = { x: rp.x + (footA.x - rp.x) * frac, y: rp.y + (footA.y - rp.y) * frac, z: zc };
      const b: Pt3 = { x: rp.x + (footB.x - rp.x) * frac, y: rp.y + (footB.y - rp.y) * frac, z: zc };
      if (segLen(a, b) < 300) continue;
      nodes.push(linearNode('collar_tie', 'Collar tie', a, b, ctx.intent.rafterSection, ctx.intent.material, ctx, { role: 'collar_tie' }));
    }
  }
  return nodes;
}

/** True when any detail layer is enabled (lets the solver skip all this work). */
export function hasAnyDetail(d: RoofDetailOptions): boolean {
  return d.membrane || d.sheathing || d.insulation || d.counterBattens || d.battens
    || d.fascia || d.bargeBoard || d.soffit || d.ridgeCaps || d.hipCaps || d.valleyFlashing
    || d.gutters || d.downpipes || d.snowGuards || d.collarTies;
}

/** Build every enabled detail layer for a roof. Pure — no graph mutation. */
export function buildRoofDetails(ctx: DetailContext): BubbleGraphNode[] {
  const d = ctx.intent.details;
  if (!hasAnyDetail(d)) return [];
  const centroid: Pt2 = {
    x: ctx.contour.points.reduce((s, p) => s + p.x, 0) / Math.max(1, ctx.contour.points.length),
    y: ctx.contour.points.reduce((s, p) => s + p.y, 0) / Math.max(1, ctx.contour.points.length),
  };

  // Everything on the covering side (sheets, battens, eave/rake trim, caps) is
  // built against the RAISED covering plane so it sits above the rafters; the
  // structural collar ties stay on the original (structural) skeleton.
  const lift = coveringLiftMm(ctx.intent);
  const liftedFaces = liftFacesZ(ctx.faces, lift);
  const liftedCtx: DetailContext = { ...ctx, faces: liftedFaces };
  const liftedSkeleton = lift
    ? ctx.skeleton.map((s) => ({ ...s, a: { ...s.a, z: s.a.z + lift }, b: { ...s.b, z: s.b.z + lift } }))
    : ctx.skeleton;
  const capsCtx: DetailContext = { ...ctx, skeleton: liftedSkeleton };

  const { eaves, rakes } = classifyEdges(liftedFaces);

  const nodes: BubbleGraphNode[] = [];
  // Covering build-up (deepest first, so the visual stack reads correctly).
  if (d.insulation) nodes.push(...genSheets(liftedCtx, 'insulation'));
  if (d.sheathing) nodes.push(...genSheets(liftedCtx, 'sheathing'));
  if (d.membrane) nodes.push(...genSheets(liftedCtx, 'membrane'));
  nodes.push(...genBattens(liftedCtx));
  nodes.push(...genEaveTrim(liftedCtx, centroid, eaves));
  nodes.push(...genRakeTrim(liftedCtx, rakes));
  nodes.push(...genCaps(capsCtx));
  nodes.push(...genCollarTies(ctx));
  return nodes;
}
