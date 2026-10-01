/**
 * Facade element — public surface.
 *
 * `computeFacade` is the one pure entry point the viewers, the elevations,
 * the takeoff, the IFC writer and the Inspector share.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { getOrderedAnchorNodes, getStoreyBand } from '@/lib/bimGeometry';
import { ensureCcw, planPos, polygonArea } from '@/lib/geom/plan2d';
import { insetRing } from '@/lib/dome/panels';
import { polygonCentroid } from '@/lib/dome/entrance';
import { sweepVolume, triangulateSimple } from '@/lib/sweep/rings';
import type { Pt3, SweepDiagnostic, SweepSolid } from '@/lib/sweep/types';
import type { DomePanel } from '@/lib/dome/types';
import { faceCells, offsetPolygon } from './patterns';
import {
  parseFacadeIntent,
  type FacadeCassette,
  type FacadeCell,
  type FacadeFace,
  type FacadeIntent,
  type FacadeResult,
  type Pt2,
} from './types';

export * from './types';
export * from './patterns';
export * from './ifc';

function emptyResult(intent: FacadeIntent, diagnostics: SweepDiagnostic[]): FacadeResult {
  return {
    intent, faces: [], cells: [], members: [], memberProfile: [], memberLengthMm: 0, memberVolumeMm3: 0,
    glassPanels: [], solidPanels: [], cassettes: [], glassAreaMm2: 0, panelAreaMm2: 0, cassetteAreaMm2: 0,
    footprint: [], zMinMm: 0, zMaxMm: 0, diagnostics,
  };
}

/** The mullion cross-section in its own (x = in-plane perpendicular, y = outward) frame. */
export function mullionProfile(wMm: number, dMm: number): Pt2[] {
  const w = Math.max(1, wMm) / 2, d = Math.max(1, dMm);
  // From flush with the plane (y = 0) out to y = d, so the mullion stands
  // proud of the glass plane like a real one.
  return [{ x: -w, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: -w, y: d }];
}

/**
 * Faces from the anchors: each consecutive pair, offset outward. For a
 * closed polygon the outward side is decided by winding (the polygon is
 * made CCW, so "right of travel" is out); for a single face it is the right
 * of A→B and `flip` swaps it.
 */
export function facesFromAnchors(pts: Pt2[], closed: boolean, intent: FacadeIntent, z0: number, z1: number): FacadeFace[] {
  let ring = pts;
  if (closed && pts.length >= 3) ring = ensureCcw(pts);
  const sign = intent.flip ? -1 : 1;
  const segs = closed && ring.length >= 3 ? ring.length : ring.length - 1;
  const faces: FacadeFace[] = [];
  for (let i = 0; i < segs; i++) {
    const A = ring[i], B = ring[(i + 1) % ring.length];
    const dx = B.x - A.x, dy = B.y - A.y;
    const L = Math.hypot(dx, dy);
    if (L < 1) continue;
    const u = { x: dx / L, y: dy / L };
    const n = { x: u.y * sign, y: -u.x * sign };
    const off = intent.offsetMm;
    faces.push({
      index: faces.length,
      a: { x: A.x + n.x * off, y: A.y + n.y * off },
      b: { x: B.x + n.x * off, y: B.y + n.y * off },
      u, n, lengthMm: L, z0, z1,
    });
  }
  return faces;
}

/** Lift a face-local (a, b) point to world mm. */
export function faceToWorld(f: FacadeFace, p: Pt2, outMm = 0): Pt3 {
  return {
    x: f.a.x + f.u.x * p.x + f.n.x * outMm,
    y: f.a.y + f.u.y * p.x + f.n.y * outMm,
    z: f.z0 + p.y,
  };
}

/** A planar panel on a face, in the DomePanel shape so its mesh and IFC writers serve unchanged. */
function panelOnFace(f: FacadeFace, poly: Pt2[], cell: number): DomePanel {
  const c = polygonCentroid(poly);
  const outline = poly.map((p) => faceToWorld(f, p));
  const origin = faceToWorld(f, c);
  return {
    cell,
    outline,
    origin,
    normal: { x: f.n.x, y: f.n.y, z: 0 },
    refDir: { x: f.u.x, y: f.u.y, z: 0 },
    profile: poly.map((p) => ({ x: p.x - c.x, y: p.y - c.y })),
    areaMm2: Math.abs(polygonArea(poly)),
    deviationMm: 0,
    planar: true,
  };
}

export function computeFacade(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): FacadeResult {
  const intent = parseFacadeIntent(node);
  const diagnostics: SweepDiagnostic[] = [];
  const anchors = getOrderedAnchorNodes(node.id, edges, nodeMap);
  if (anchors.length < 2) {
    diagnostics.push({
      code: 'FACADE_NO_ANCHORS',
      severity: 'error',
      message: 'Fațada cere cel puțin 2 axe: 2 = un panou vertical, 3+ = poligon închis (shell).',
    });
    return emptyResult(intent, diagnostics);
  }
  const parent = node.parentId ? nodeMap.get(node.parentId) : undefined;
  if (!parent || parent.type !== 'storey') {
    diagnostics.push({ code: 'FACADE_NO_STOREY', severity: 'warning', message: 'Fațada nu aparține unui etaj — cotele cad pe banda implicită.' });
  }
  const band = getStoreyBand(node, nodeMap);
  const z0 = band.bot + intent.offsetZMm;
  const z1 = intent.heightMm > 0 ? z0 + intent.heightMm : band.top + intent.offsetZMm;
  if (z1 - z0 < 10) {
    diagnostics.push({ code: 'FACADE_ZERO_HEIGHT', severity: 'error', message: 'Înălțimea fațadei e zero — verifică height_mm și cotele etajului.' });
    return emptyResult(intent, diagnostics);
  }

  const pts = anchors.map((a) => planPos(a, nodeMap));
  const closed = intent.closed && pts.length >= 3;
  const faces = facesFromAnchors(pts, closed, intent, z0, z1);
  if (faces.length === 0) {
    diagnostics.push({ code: 'FACADE_DEGENERATE', severity: 'error', message: 'Axele fațadei coincid — nu iese nicio față.' });
    return emptyResult(intent, diagnostics);
  }

  const result = emptyResult(intent, diagnostics);
  result.faces = faces;
  result.memberProfile = mullionProfile(intent.mullionWMm, intent.mullionDMm);
  result.zMinMm = z0;
  result.zMaxMm = z1;
  result.footprint = faces.map((f) => [f.a, f.b]);

  const H = z1 - z0;
  const halfW = intent.mullionWMm / 2;
  const memberTris = triangulateSimple(result.memberProfile);
  let cellIndex = 0;

  for (const f of faces) {
    const cells = faceCells(f.lengthMm, H, intent);
    if (cells.length === 0) continue;

    // ── mullions: one member per UNIQUE edge, so shared edges weld ──────
    const edgeKey = (p: Pt2) => `${Math.round(p.x)}_${Math.round(p.y)}`;
    const seen = new Set<string>();
    for (const cell of cells) {
      for (let i = 0; i < cell.length; i++) {
        const A = cell[i], B = cell[(i + 1) % cell.length];
        const ka = edgeKey(A), kb = edgeKey(B);
        if (ka === kb) continue;
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const L = Math.hypot(B.x - A.x, B.y - A.y);
        if (L < 1) continue;
        // Frame on the plane: t along the edge, s = n × t (in-plane
        // perpendicular), u = t × s = n (outward) — the sweep's own
        // convention, so the caps and the volume come out right.
        const ta = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
        const t: Pt3 = { x: f.u.x * ta.x, y: f.u.y * ta.x, z: ta.y };
        const nn: Pt3 = { x: f.n.x, y: f.n.y, z: 0 };
        const s: Pt3 = { x: nn.y * t.z - nn.z * t.y, y: nn.z * t.x - nn.x * t.z, z: nn.x * t.y - nn.y * t.x };
        const ring = (P: Pt3): Pt3[] => result.memberProfile.map((q) => ({
          x: P.x + s.x * q.x + nn.x * q.y,
          y: P.y + s.y * q.x + nn.y * q.y,
          z: P.z + s.z * q.x + nn.z * q.y,
        }));
        const solid: SweepSolid = { rings: [ring(faceToWorld(f, A)), ring(faceToWorld(f, B))], loop: false };
        result.members.push(solid);
        result.memberLengthMm += L;
      }
    }

    // ── panels ──────────────────────────────────────────────────────────
    for (const cell of cells) {
      const ccw = ensureCcw(cell);
      const idx = cellIndex++;
      const inner = halfW > 0 ? insetRing(ccw, halfW) : ccw;
      if (inner.length < 3) continue;
      const area = Math.abs(polygonArea(inner));
      result.cells.push({ face: f.index, poly: ccw, outline: ccw.map((p) => faceToWorld(f, p)), areaMm2: Math.abs(polygonArea(ccw)) });

      const kind = intent.panelKind === 'mixed' ? (idx % 2 === 0 ? 'cassette' : 'glass') : intent.panelKind;
      if (kind === 'glass') {
        result.glassPanels.push(panelOnFace(f, inner, idx));
        result.glassAreaMm2 += area;
      } else if (kind === 'solid') {
        result.solidPanels.push(panelOnFace(f, inner, idx));
        result.panelAreaMm2 += area;
      } else {
        // Cassette: outer ring on the plane, inner ring bevelled in and
        // pushed out. When the bevel would eat the cell, fall back to a
        // straight box — a box is still a cassette; a crossed-over ring is
        // nothing.
        const outer = offsetPolygon(inner, 0) ?? inner;
        const bevelled = intent.cassetteBevelMm > 0 ? offsetPolygon(outer, intent.cassetteBevelMm) : null;
        const innerRing = bevelled ?? outer;
        const depth = intent.cassetteDepthMm;
        if (depth <= 0) {
          result.solidPanels.push(panelOnFace(f, inner, idx));
          result.panelAreaMm2 += area;
          continue;
        }
        const solid: SweepSolid = {
          rings: [outer.map((p) => faceToWorld(f, p, 0)), innerRing.map((p) => faceToWorld(f, p, depth))],
          loop: false,
        };
        result.cassettes.push({ face: f.index, solid, placed: outer, areaMm2: area });
        result.cassetteAreaMm2 += area;
      }
    }
  }

  result.memberVolumeMm3 = sweepVolume(result.members, memberTris);
  if (result.cells.length === 0) {
    diagnostics.push({ code: 'FACADE_NO_CELLS', severity: 'error', message: 'Tiparul n-a produs nicio celulă — mărește fața sau micșorează celula.' });
  }
  return result;
}

/** Signed volume of all cassettes, mm³ — each with its own cap triangulation. */
export function cassetteVolumeMm3(cassettes: FacadeCassette[]): number {
  let v = 0;
  for (const c of cassettes) v += sweepVolume([c.solid], triangulateSimple(c.placed));
  return v;
}

export type { FacadeCell };
