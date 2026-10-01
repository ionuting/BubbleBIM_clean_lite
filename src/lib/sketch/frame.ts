/**
 * frame.ts — the reference a sketch is drawn against.
 *
 * A sketch on its own is absolute millimetres: move an axis and it stays where
 * it was. Wire it to one ax and its coordinates become offsets FROM that ax;
 * wire it to two and they become offsets along and across the line between
 * them. Nothing else changes — the stored numbers are the same kind of
 * numbers, only their origin has moved. That is the whole idea: the reference
 * is an edge in the graph, the same gesture that gives a wall its endpoints.
 *
 * Local coordinates are `(u, v)`: `u` along the reference line, `v` to its
 * left. With one ax the line runs along BIM X, so `(u, v)` is `(x, y)` shifted;
 * with none the frame is the identity and a sketch reads exactly as before.
 *
 * On top of the frame sits one transform — mirror, rotation, offset — so a
 * sketch can be flipped across its line or slid along it by number, without
 * touching the points it was drawn with.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import type { Pt2 } from '@/lib/geom/plan2d';
import { planPos } from '@/lib/geom/plan2d';
import { getOrderedAnchorNodes } from '@/lib/bimGeometry';

export interface SketchFrame {
  /** BIM mm of local (0, 0). */
  origin: Pt2;
  /** Unit vector of local +u in BIM. Local +v is its left-hand perpendicular. */
  dir: Pt2;
  /** Ax nodes the frame was read from, in edge order. */
  refIds: string[];
  /** Distance between the first two anchors, mm — 0 unless there are two. */
  refLengthMm: number;
}

/** No reference: local IS world. */
export const IDENTITY_FRAME: SketchFrame = {
  origin: { x: 0, y: 0 },
  dir: { x: 1, y: 0 },
  refIds: [],
  refLengthMm: 0,
};

/** Two anchors closer than this are one point; the line has no direction. */
export const MIN_REF_LENGTH_MM = 1;

/** How the drawn points sit inside the frame — all relative to the reference. */
export interface SketchTransform {
  /** Slide along the reference line, mm. */
  dxMm: number;
  /** Slide across it, mm — positive to the left of the line's direction. */
  dyMm: number;
  /** Turn about the local origin, degrees counter-clockwise. */
  rotDeg: number;
  /** Flip across the reference line (v → −v), before the rotation. */
  mirror: boolean;
}

export const IDENTITY_TRANSFORM: SketchTransform = { dxMm: 0, dyMm: 0, rotDeg: 0, mirror: false };

export interface FrameDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/**
 * Read the frame off the graph: the ax/column nodes wired to the sketch, in
 * edge order. One gives an origin, two give a direction; any beyond the
 * second are ignored — a sketch has one reference line, not a polygon.
 */
export function resolveSketchFrame(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): { frame: SketchFrame; diagnostics: FrameDiagnostic[] } {
  const diagnostics: FrameDiagnostic[] = [];
  const anchors = getOrderedAnchorNodes(node.id, edges, nodeMap);
  if (anchors.length === 0) return { frame: IDENTITY_FRAME, diagnostics };

  const a = planPos(anchors[0], nodeMap);
  if (anchors.length === 1) {
    return {
      frame: { origin: a, dir: { x: 1, y: 0 }, refIds: [anchors[0].id], refLengthMm: 0 },
      diagnostics,
    };
  }

  const b = planPos(anchors[1], nodeMap);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < MIN_REF_LENGTH_MM) {
    diagnostics.push({
      code: 'SKETCH_REF_DEGENERATE',
      severity: 'warning',
      message: 'Cele două axe de referință sunt în același punct — linia nu are direcție, se folosește doar originea.',
    });
    return {
      frame: { origin: a, dir: { x: 1, y: 0 }, refIds: [anchors[0].id, anchors[1].id], refLengthMm: 0 },
      diagnostics,
    };
  }
  if (anchors.length > 2) {
    diagnostics.push({
      code: 'SKETCH_REF_EXTRA',
      severity: 'info',
      message: `Schița e legată de ${anchors.length} axe — doar primele două dau linia de referință.`,
    });
  }
  return {
    frame: {
      origin: a,
      dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len },
      refIds: anchors.slice(0, 2).map((n) => n.id),
      refLengthMm: len,
    },
    diagnostics,
  };
}

/** Is this the identity — a sketch with no reference? */
export const isIdentityFrame = (f: SketchFrame): boolean => f.refIds.length === 0;

/**
 * Local → BIM, in this order: mirror across the line, rotate about the local
 * origin, slide, then place in the frame. Mirror-then-rotate means a flipped
 * sketch turned 30° is the mirror image of an unflipped one turned −30°,
 * which is what a reader of "oglindit, rotit 30°" expects.
 */
export function localToWorld(frame: SketchFrame, t: SketchTransform, p: Pt2): Pt2 {
  const v0 = t.mirror ? -p.y : p.y;
  const rad = (t.rotDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const u = p.x * c - v0 * s + t.dxMm;
  const v = p.x * s + v0 * c + t.dyMm;
  return {
    x: frame.origin.x + u * frame.dir.x - v * frame.dir.y,
    y: frame.origin.y + u * frame.dir.y + v * frame.dir.x,
  };
}

/** BIM → local: the exact inverse of `localToWorld`. */
export function worldToLocal(frame: SketchFrame, t: SketchTransform, p: Pt2): Pt2 {
  const dx = p.x - frame.origin.x, dy = p.y - frame.origin.y;
  const u = dx * frame.dir.x + dy * frame.dir.y - t.dxMm;
  const v = -dx * frame.dir.y + dy * frame.dir.x - t.dyMm;
  const rad = (t.rotDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const x = u * c + v * s;
  const y0 = -u * s + v * c;
  return { x, y: t.mirror ? -y0 : y0 };
}

export function outlineToWorld(frame: SketchFrame, t: SketchTransform, pts: Pt2[]): Pt2[] {
  return pts.map((p) => localToWorld(frame, t, p));
}

export function outlineToLocal(frame: SketchFrame, t: SketchTransform, pts: Pt2[]): Pt2[] {
  return pts.map((p) => worldToLocal(frame, t, p));
}

/** The frame's angle off BIM X, degrees CCW — what a rect aligned to it turns by. */
export function frameAngleDeg(frame: SketchFrame): number {
  return (Math.atan2(frame.dir.y, frame.dir.x) * 180) / Math.PI;
}

/** True when the transform flips winding — one mirror does, a rotation never. */
export const flipsWinding = (t: SketchTransform): boolean => t.mirror;
