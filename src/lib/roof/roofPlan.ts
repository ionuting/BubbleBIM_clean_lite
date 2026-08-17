/**
 * roofPlan.ts — 2D plan projection of a solved roof, for the floor-plan viewer.
 *
 * A roof plan is standard architectural linework seen from above: the eave
 * outline, ridge lines (solid), hip lines (from outer corners up), valley lines
 * (from reflex corners up), and a slope-direction arrow per water plane pointing
 * DOWN-slope (toward the eave). Everything is a plain 2D segment/polyline in BIM
 * mm; the viewer maps it to SVG. Pure — no framework, no store.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { parseRoofIntent } from './solver';
import { resolveRoofContour } from './contour';
import { buildRoofEnvelope } from './skeleton';
import type { Pt2, RoofDiagnostic } from './types';

export interface PlanSeg { a: Pt2; b: Pt2; role: 'eave' | 'ridge' | 'hip' | 'valley' | 'break'; }
export interface SlopeArrow { from: Pt2; to: Pt2; }

export interface RoofPlan {
  /** Closed eave outline (CCW, BIM mm). */
  outline: Pt2[];
  /** Ridge/hip/valley/eave segments to stroke. */
  segments: PlanSeg[];
  /** One down-slope arrow per slope face. */
  arrows: SlopeArrow[];
  diagnostics: RoofDiagnostic[];
}

/** Point-in-polygon (plan) — used to keep slope arrows inside their face. */
function inPoly(p: Pt2, poly: Pt2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Build the plan linework for one roof node. Returns null if the roof has no
 * resolvable contour (e.g. fewer than 3 connected ax and no storey walls).
 */
export function buildRoofPlan(
  roof: BubbleGraphNode, nodes: BubbleGraphNode[], edges: BubbleGraphEdge[],
): RoofPlan | null {
  const diagnostics: RoofDiagnostic[] = [];
  const intent = parseRoofIntent(roof);
  const contour = resolveRoofContour(roof, nodes, edges, intent.overhangMm, diagnostics);
  if (!contour || contour.points.length < 3) return null;

  const { skeleton, faces } = buildRoofEnvelope(
    contour, intent.roofType, intent.pitchDeg, intent.ridgeDirection, intent.ridgeOffsetMm,
    roof.id, diagnostics, intent.upperPitchDeg, intent.mansardBreakInsetMm,
  );

  const segments: PlanSeg[] = [];
  // Eave outline is the contour itself.
  const outline = contour.points;
  for (let i = 0; i < outline.length; i++) {
    segments.push({ a: outline[i], b: outline[(i + 1) % outline.length], role: 'eave' });
  }
  // Ridge / hip / valley / break come straight from the skeleton (plan = drop z).
  for (const s of skeleton) {
    if (s.role === 'eave') continue; // already have the outline
    segments.push({ a: { x: s.a.x, y: s.a.y }, b: { x: s.b.x, y: s.b.y }, role: s.role });
  }

  // One down-slope arrow per slope face: from the face centroid toward the
  // lowest edge midpoint (the eave side), kept inside the face.
  const arrows: SlopeArrow[] = [];
  for (const f of faces) {
    if (f.role !== 'slope' || f.vertices.length < 3) continue;
    const poly2d = f.vertices.map((v) => ({ x: v.x, y: v.y }));
    const cx = poly2d.reduce((s, p) => s + p.x, 0) / poly2d.length;
    const cy = poly2d.reduce((s, p) => s + p.y, 0) / poly2d.length;
    // Lowest edge of the face = its eave; arrow points from centroid toward it.
    let loMid: Pt2 | null = null;
    let loZ = Infinity;
    for (let i = 0; i < f.vertices.length; i++) {
      const A = f.vertices[i], B = f.vertices[(i + 1) % f.vertices.length];
      const z = A.z + B.z;
      if (z < loZ) { loZ = z; loMid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 }; }
    }
    if (!loMid) continue;
    const dx = loMid.x - cx, dy = loMid.y - cy;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;
    // Arrow length: a fraction of the centroid→eave distance, centred on the face.
    const half = Math.min(L * 0.45, 900);
    const from = { x: cx - ux * half, y: cy - uy * half };
    const to = { x: cx + ux * half, y: cy + uy * half };
    if (inPoly(from, poly2d) || inPoly(to, poly2d)) arrows.push({ from, to });
  }

  return { outline, segments, arrows, diagnostics };
}
