/**
 * drawingEngine.ts — Pure 2D drawing engine for BIM section and elevation views.
 *
 * This is the SINGLE SOURCE OF TRUTH for 2D projection geometry. It mirrors the
 * exact same coordinate transforms used in WebIfcViewer.tsx / buildSceneGeometry:
 *
 *   BIM X  (East mm)      →  Drawing horizontal X (mm)
 *   BIM Y  (North mm)     →  Three.js -Z (metres) — used for depth / cut tests
 *   BIM Z  (elevation mm) →  Drawing vertical Y (mm, positive = up)
 *
 * All internal arithmetic is done in BIM millimetres.
 * Three.js metre values from calcWallGeometry are converted back to mm with *1000.
 *
 * The engine produces DrawingShape[] — engine-independent polygons that the SVG
 * layer renders using <polygon>, <path>, and <pattern> fills.
 *
 * Supports:
 *   - computeSectionView   (vertical cut along a plan marker line, any angle)
 *   - computeElevationView (external face, looking along +Y/-Y/+X/-X)
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  calcWallGeometry,
  calcWallJoins,
  calcSpanEffectiveEnds,
  getAxRealPos,
  getNodeBimPos,
  getStoreyBand,
  parseColumnDims,
  parseBeamDims,
  getNodeSlabThickness,
  getConnectedNodes,
  calcShellPolygon,
  calcRoomPolygon,
  parseContourOffsets,
  insetPolygon,
} from '@/lib/bimGeometry';
import { expandArrayNodes } from '@/lib/formulaUtils';
import { computeSweep } from '@/lib/sweep';
import { computeRoofFaces } from '@/lib/roof/solver';
import { flightProfile } from '@/lib/stair/profile';
import { parseAxes } from '@/lib/utils';
import type { HatchPattern, MaterialVisuals, MaterialConfig } from '@/lib/materialConfig';
import { resolveVisuals, applyNodeColorOverrides } from '@/lib/materialConfig';

// ─── Public types ─────────────────────────────────────────────────────────────

export type LineWeight = 'heavy-cut' | 'medium-cut' | 'projected' | 'annotation' | 'hidden';

/** A closed polygon or open polyline in drawing space (mm). */
export interface DrawingShape {
  /** Closed polygon corners in drawing coords: { u: horizontal mm, v: elevation mm }  */
  pts: { u: number; v: number }[];
  /** Whether this shape is closed (filled) or open (just stroked as lines) */
  closed: boolean;
  hatch: HatchPattern;
  fillColor: string;
  strokeColor: string;
  lineWeight: LineWeight;
  /** Z-depth in BIM Y mm (for painter's-algorithm sort: larger = further = draw first) */
  depthMm: number;
  nodeId: string;
  nodeType: string;
  /** Label to show (e.g. material name) — optional */
  label?: string;
}

/** Axis grid line in drawing space */
export interface DrawingAxis {
  u: number;          // horizontal position mm
  label: string;      // '1', '2', 'A', 'B', …
  kind: 'X' | 'Y';   // kind of axis
}

/** Elevation dimension marker */
export interface DrawingLevel {
  vMm: number;        // elevation in mm
  label: string;      // e.g. '+3.000'
}

export interface DrawingResult {
  shapes: DrawingShape[];
  axes: DrawingAxis[];
  levels: DrawingLevel[];
  /** Bounding box of content (drawing mm coords) */
  uMin: number; uMax: number; vMin: number; vMax: number;
}

// ─── Cut-plane type ───────────────────────────────────────────────────────────

/**
 * A vertical section through the model, defined the way a plan marker is: a
 * line A→B in BIM plan mm and the side of it the viewer stands on.
 *
 * The drawing's horizontal axis `u` runs along the marker with the viewer's
 * RIGHT hand positive, so handedness follows from the look side alone: a
 * west→east marker viewed from the south (look 'left' = north) puts east on the
 * right; the same marker viewed from the north puts west on the right. There
 * is no separate "flipped" — the engine never mirrors.
 *
 * `cutY` is the pre-marker form (a west→east line at that Y, looking north)
 * and is only read when `line` is absent.
 */
export interface SectionCut {
  /** Marker endpoints in BIM mm. */
  line?: { x1: number; y1: number; x2: number; y2: number };
  /** Which side of A→B is viewed. Default 'left' (the CCW normal). */
  lookSide?: 'left' | 'right';
  /** Legacy: BIM Y of a west→east cut looking north. Ignored when `line` is set. */
  cutY?: number;
  /**
   * How far past the plane projected elements show (mm). `Infinity` shows
   * everything on the viewed side; `0` shows only the cut elements.
   */
  cutDepth: number;
  /** Clip the drawing to the marker's length (ArchiCAD's horizontal range). */
  clipToLine?: boolean;
  /** Bottom elevation limit (mm) */
  elevMin: number;
  /** Top elevation limit (mm) */
  elevMax: number;
}

export type ElevationDir = 'N' | 'S' | 'E' | 'W';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Clip a polygon to the half-plane (y <= planeY) or (y >= planeY) with
 * Sutherland–Hodgman. Extra fields on the points (e.g. z) are interpolated
 * through `lerp`. Returns an empty array when nothing is inside.
 */
function clipPolygonY<T extends { x: number; y: number }>(
  pts: T[],
  planeY: number,
  keepBelow: boolean,
  lerp: (a: T, b: T, t: number) => T = (a, b, t) =>
    ({ ...a, x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }),
): T[] {
  if (pts.length === 0) return [];
  const inside = (p: T) => (keepBelow ? p.y <= planeY : p.y >= planeY);
  const out: T[] = [];
  for (let i = 0; i < pts.length; i++) {
    const S = pts[i], E = pts[(i + 1) % pts.length];
    const sIn = inside(S), eIn = inside(E);
    if (sIn) {
      out.push(S);
      if (!eIn) out.push(lerp(S, E, (planeY - S.y) / (E.y - S.y)));
    } else if (eIn) {
      out.push(lerp(S, E, (planeY - S.y) / (E.y - S.y)));
    }
  }
  return out;
}

/**
 * Build the footprint polygon (BIM mm) of a wall solid segment.
 *
 * WallSegDesc stores positions in Three.js metres (ax, az, bx, bz) where:
 *   ax = bimX * MM, az = -bimY * MM, bx = bimX * MM, bz = -bimY * MM
 *
 * We recover BIM mm and produce the 4-corner footprint in plan.
 * Returns 4 corners in BIM mm: (x=east, y=north)
 */
function wallSegFootprint(seg: {
  ax: number; az: number; bx: number; bz: number;
  tStart: number; tEnd: number;
  width: number; // metres
}): { x: number; y: number }[] {
  const sx = seg.ax * 1000;       // BIM X mm (start, before tStart offset)
  const sy = -seg.az * 1000;      // BIM Y mm (start)
  const ex = seg.bx * 1000;       // BIM X mm (end, before tEnd offset)
  const ey = -seg.bz * 1000;      // BIM Y mm (end)

  const wallDx = ex - sx; const wallDy = ey - sy;
  const wallLen = Math.sqrt(wallDx * wallDx + wallDy * wallDy);
  if (wallLen < 1e-3) return [];

  const ux = wallDx / wallLen; const uy = wallDy / wallLen;
  const nx = -uy; const ny = ux;
  const hw = (seg.width * 1000) / 2;
  const sOff = seg.tStart * 1000;
  const eOff = seg.tEnd   * 1000;

  const pSx = sx + ux * sOff; const pSy = sy + uy * sOff;
  const pEx = sx + ux * eOff; const pEy = sy + uy * eOff;

  return [
    { x: pSx + nx * hw, y: pSy + ny * hw },
    { x: pEx + nx * hw, y: pEy + ny * hw },
    { x: pEx - nx * hw, y: pEy - ny * hw },
    { x: pSx - nx * hw, y: pSy - ny * hw },
  ];
}

/** Rectangle footprint around a centre-line (BIM mm) of the given width. */
function lineFootprint(
  sx: number, sy: number, ex: number, ey: number, widthMm: number,
): { x: number; y: number }[] {
  const dx = ex - sx, dy = ey - sy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return [];
  const nx = -dy / len * widthMm / 2, ny = dx / len * widthMm / 2;
  return [
    { x: sx + nx, y: sy + ny }, { x: ex + nx, y: ey + ny },
    { x: ex - nx, y: ey - ny }, { x: sx - nx, y: sy - ny },
  ];
}

/** Get material visuals safely */
function getVis(
  nodeType: string,
  materialStr: string,
  matConfig: MaterialConfig | null,
  node?: BubbleGraphNode,
): MaterialVisuals {
  const vis = resolveVisuals(nodeType, materialStr, matConfig);
  return node ? applyNodeColorOverrides(vis, node.properties) : vis;
}

// ─── Section frame ────────────────────────────────────────────────────────────

/**
 * The marker as a local frame. `local(p)` maps a BIM plan point to
 * `{ x: u, y: -d }`: u along the marker (viewer's right positive), d the
 * distance in front of the plane. Everything downstream cuts at y = 0 and
 * looks toward negative y, so "in front" is y <= 0 and "further" is smaller y.
 */
interface CutFrame {
  ax: number; ay: number;
  tx: number; ty: number;
  nx: number; ny: number;
  lengthMm: number;
  clip: boolean;
  depth: number;
}

function buildFrame(cut: SectionCut): CutFrame {
  let x1: number, y1: number, x2: number, y2: number;
  let clip = cut.clipToLine === true;
  if (cut.line) {
    ({ x1, y1, x2, y2 } = cut.line);
  } else {
    const y = cut.cutY ?? 0;
    x1 = 0; y1 = y; x2 = 1; y2 = y;
    clip = false;
  }
  // Looking at the right side of A→B is looking at the left side of B→A.
  if (cut.lookSide === 'right') {
    [x1, y1, x2, y2] = [x2, y2, x1, y1];
  }
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const tx = dx / len, ty = dy / len;
  const depth = Number.isFinite(cut.cutDepth) && cut.cutDepth >= 0 ? cut.cutDepth : Infinity;
  return { ax: x1, ay: y1, tx, ty, nx: -ty, ny: tx, lengthMm: cut.line ? len : Infinity, clip, depth };
}

type UD = { x: number; y: number };
type UDZ = UD & { z: number };

/**
 * Where a footprint (already in frame space) crosses the plane y = 0, as
 * paired u-intervals. The half-open crossing rule keeps the count even, so a
 * concave footprint (an L-shaped slab) yields one interval per crossing wing.
 */
function cutIntervals(fp: UD[]): [number, number][] {
  const xs: number[] = [];
  for (let i = 0; i < fp.length; i++) {
    const A = fp[i], B = fp[(i + 1) % fp.length];
    if ((A.y <= 0 && B.y > 0) || (B.y <= 0 && A.y > 0)) {
      const t = (0 - A.y) / (B.y - A.y);
      xs.push(A.x + t * (B.x - A.x));
    }
  }
  xs.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > 0.5) out.push([xs[i], xs[i + 1]]);
  }
  return out;
}

/** Does the footprint have area on both sides of the plane? */
function straddles(fp: UD[], tol = 1): boolean {
  let neg = false, pos = false;
  for (const p of fp) {
    if (p.y < -tol) neg = true;
    if (p.y > tol) pos = true;
  }
  return neg && pos;
}

const rect = (u0: number, u1: number, v0: number, v1: number) => [
  { u: u0, v: v0 }, { u: u1, v: v0 }, { u: u1, v: v1 }, { u: u0, v: v1 },
];

interface PrismStyle {
  vis: MaterialVisuals;
  nodeId: string;
  nodeType: string;
  cutWeight?: LineWeight;
  projWeight?: LineWeight;
}

/**
 * Emit the section of a vertical prism (footprint × [zBot, zTop]). Cut where
 * the footprint straddles the plane — one filled rectangle per crossing
 * interval — otherwise the projected outline of the part in front, within
 * the depth. Returns true when the prism was cut.
 */
function emitPrism(
  shapes: DrawingShape[],
  frame: CutFrame,
  fpBim: { x: number; y: number }[],
  zBot: number,
  zTop: number,
  style: PrismStyle,
): boolean {
  if (fpBim.length < 3 || !(zTop > zBot)) return false;
  const fp = fpBim.map((p) => localOf(frame, p));
  const { vis, nodeId, nodeType } = style;

  const intervals = cutIntervals(fp);
  if (intervals.length > 0) {
    for (const [u0, u1] of intervals) {
      shapes.push({
        pts: rect(u0, u1, zBot, zTop), closed: true,
        hatch: vis.hatch,
        fillColor: vis.section_fill_color ?? vis.color_2d,
        strokeColor: vis.section_line_color ?? vis.color_2d,
        lineWeight: style.cutWeight ?? 'heavy-cut',
        depthMm: 0,
        nodeId, nodeType,
      });
    }
    return true;
  }

  const front = clipPolygonY(fp, 0, true);
  if (front.length < 3) return false;
  const dMin = -Math.max(...front.map((p) => p.y));
  if (dMin > frame.depth + 1) return false;
  const us = front.map((p) => p.x);
  shapes.push({
    pts: rect(Math.min(...us), Math.max(...us), zBot, zTop), closed: true,
    hatch: 'none',
    fillColor: 'none',
    strokeColor: vis.view_line_color ?? vis.color_2d,
    lineWeight: style.projWeight ?? 'projected',
    depthMm: Math.max(0, dMin),
    nodeId, nodeType,
  });
  return false;
}

function localOf(frame: CutFrame, p: { x: number; y: number }): UD {
  const rx = p.x - frame.ax, ry = p.y - frame.ay;
  return { x: rx * frame.tx + ry * frame.ty, y: -(rx * frame.nx + ry * frame.ny) };
}

/**
 * Cut a planar 3D polygon (frame space with z) by the plane y = 0: the
 * crossing points sorted along u, paired into segments.
 */
function cutSegments3(poly: UDZ[]): [UDZ, UDZ][] {
  const hits: UDZ[] = [];
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length];
    if ((A.y <= 0 && B.y > 0) || (B.y <= 0 && A.y > 0)) {
      const t = (0 - A.y) / (B.y - A.y);
      hits.push({ x: A.x + t * (B.x - A.x), y: 0, z: A.z + t * (B.z - A.z) });
    }
  }
  hits.sort((a, b) => a.x - b.x);
  const out: [UDZ, UDZ][] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]]);
  return out;
}

const lerp3 = (a: UDZ, b: UDZ, t: number): UDZ =>
  ({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), z: a.z + t * (b.z - a.z) });

/** Sutherland–Hodgman of a (u,v) polygon against u >= lo and u <= hi, v >= vlo and v <= vhi. */
function clipShapeBox(
  pts: { u: number; v: number }[],
  uLo: number, uHi: number, vLo: number, vHi: number,
): { u: number; v: number }[] {
  type P = { u: number; v: number };
  const clipHalf = (input: P[], inside: (p: P) => boolean, cross: (a: P, b: P) => P): P[] => {
    const out: P[] = [];
    for (let i = 0; i < input.length; i++) {
      const S = input[i], E = input[(i + 1) % input.length];
      const sIn = inside(S), eIn = inside(E);
      if (sIn) { out.push(S); if (!eIn) out.push(cross(S, E)); }
      else if (eIn) out.push(cross(S, E));
    }
    return out;
  };
  const atU = (u0: number) => (a: P, b: P): P => {
    const t = (u0 - a.u) / (b.u - a.u);
    return { u: u0, v: a.v + t * (b.v - a.v) };
  };
  const atV = (v0: number) => (a: P, b: P): P => {
    const t = (v0 - a.v) / (b.v - a.v);
    return { u: a.u + t * (b.u - a.u), v: v0 };
  };
  let poly = pts;
  if (Number.isFinite(uLo)) poly = clipHalf(poly, (p) => p.u >= uLo, atU(uLo));
  if (poly.length && Number.isFinite(uHi)) poly = clipHalf(poly, (p) => p.u <= uHi, atU(uHi));
  if (poly.length && Number.isFinite(vLo)) poly = clipHalf(poly, (p) => p.v >= vLo, atV(vLo));
  if (poly.length && Number.isFinite(vHi)) poly = clipHalf(poly, (p) => p.v <= vHi, atV(vHi));
  return poly;
}

/** Liang–Barsky clip of an open polyline to the same box; may split it. */
function clipPolylineBox(
  pts: { u: number; v: number }[],
  uLo: number, uHi: number, vLo: number, vHi: number,
): { u: number; v: number }[][] {
  const inside = (p: { u: number; v: number }) =>
    p.u >= uLo - 1e-6 && p.u <= uHi + 1e-6 && p.v >= vLo - 1e-6 && p.v <= vHi + 1e-6;
  const runs: { u: number; v: number }[][] = [];
  let run: { u: number; v: number }[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    let t0 = 0, t1 = 1;
    const du = b.u - a.u, dv = b.v - a.v;
    const tests: [number, number][] = [[-du, a.u - uLo], [du, uHi - a.u], [-dv, a.v - vLo], [dv, vHi - a.v]];
    let ok = true;
    for (const [p, q] of tests) {
      if (!Number.isFinite(q)) continue;
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { if (run.length > 1) runs.push(run); run = []; continue; }
    const pa = { u: a.u + t0 * du, v: a.v + t0 * dv };
    const pb = { u: a.u + t1 * du, v: a.v + t1 * dv };
    if (run.length === 0 || !inside(a) || t0 > 0) { if (run.length > 1) runs.push(run); run = [pa]; }
    run.push(pb);
    if (t1 < 1) { runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

// ─── Section view computation ─────────────────────────────────────────────────

/**
 * Compute all drawing shapes for a vertical section cut. See `SectionCut` for
 * the marker model; every element is mapped through the marker's local frame
 * so an oblique marker works exactly like an orthogonal one.
 *
 * Elements CUT by the plane → heavy outline + hatch fill.
 * Elements VISIBLE in front of the plane, within `cutDepth` → thin outline.
 */
export function computeSectionView(
  rawNodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null,
  cut: SectionCut,
): DrawingResult {
  const nodes = expandArrayNodes(rawNodes);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  const storeys = nodes.filter((n) => n.type === 'storey');

  const frame = buildFrame(cut);
  const { elevMin, elevMax } = cut;
  const L = (p: { x: number; y: number }) => localOf(frame, p);
  /** Is a frame-space footprint worth looking at (touches the plane or the depth band)? */
  const nearPlane = (fp: UD[]) => {
    const ys = fp.map((p) => p.y);
    return Math.max(...ys) >= -frame.depth - 1 && Math.min(...ys) <= 1;
  };

  const shapes: DrawingShape[] = [];
  const axes: DrawingAxis[] = [];
  const levels: DrawingLevel[] = [];

  // ── Levels ────────────────────────────────────────────────────────────────
  for (const s of storeys) {
    const bot = Number(s.properties.bottomElevation ?? 0);
    levels.push({ vMm: bot, label: `+${(bot / 1000).toFixed(3)}` });
  }
  if (storeys.length) {
    const topLevel = Math.max(...storeys.map((s) => Number(s.properties.topElevation ?? 3000)));
    levels.push({ vMm: topLevel, label: `+${(topLevel / 1000).toFixed(3)}` });
  }

  // ── Axis grid lines: where each grid line meets the marker ────────────────
  // A marker along X meets the X axes (numbered); one along Y meets the Y
  // axes (lettered); an oblique marker meets both.
  for (const s of storeys) {
    const seen = new Set<string>();
    const axX = parseAxes(s.properties.axesX).sort((a, b) => a - b);
    const axY = parseAxes(s.properties.axesY).sort((a, b) => a - b);
    if (Math.abs(frame.tx) > 1e-6) {
      axX.forEach((x, i) => {
        const u = (x - frame.ax) / frame.tx;
        const key = `X${i}`;
        if (!seen.has(key)) { seen.add(key); axes.push({ u, label: String(i + 1), kind: 'X' }); }
      });
    }
    if (Math.abs(frame.ty) > 1e-6) {
      axY.forEach((y, i) => {
        const u = (y - frame.ay) / frame.ty;
        const key = `Y${i}`;
        if (!seen.has(key)) { seen.add(key); axes.push({ u, label: String.fromCharCode(65 + i), kind: 'Y' }); }
      });
    }
    break; // global axes from first storey
  }

  // ── Per-storey prisms: columns and slabs ─────────────────────────────────
  for (const s of storeys) {
    const bot = Number(s.properties.bottomElevation ?? 0);
    const top = Number(s.properties.topElevation ?? 3000);
    if (bot > elevMax || top < elevMin) continue;

    // Columns from ax nodes
    for (const n of nodes.filter((nd) => nd.type === 'ax' && nd.parentId === s.id)) {
      if (String(n.properties.has_column ?? '').toLowerCase() !== 'true') continue;
      const { x: bimX, y: bimY } = getAxRealPos(n, nodeMap);
      const { w, d } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
      const wMm = w * 1000; const dMm = d * 1000;
      const footprint = [
        { x: bimX - wMm / 2, y: bimY - dMm / 2 },
        { x: bimX + wMm / 2, y: bimY - dMm / 2 },
        { x: bimX + wMm / 2, y: bimY + dMm / 2 },
        { x: bimX - wMm / 2, y: bimY + dMm / 2 },
      ];
      const vis = getVis('column', String(n.properties.material ?? ''), matConfig, n);
      emitPrism(shapes, frame, footprint, bot, top, { vis, nodeId: n.id, nodeType: 'column' });
    }

    // Standalone column nodes
    for (const n of nodes.filter((nd) => nd.type === 'column' && nd.parentId === s.id)) {
      const { w, d } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
      const wMm = w * 1000; const dMm = d * 1000;
      const footprint = [
        { x: n.x - wMm / 2, y: n.y - dMm / 2 },
        { x: n.x + wMm / 2, y: n.y - dMm / 2 },
        { x: n.x + wMm / 2, y: n.y + dMm / 2 },
        { x: n.x - wMm / 2, y: n.y + dMm / 2 },
      ];
      const vis = getVis('column', String(n.properties.material ?? ''), matConfig, n);
      emitPrism(shapes, frame, footprint, bot, top, { vis, nodeId: n.id, nodeType: 'column' });
    }

    // Slab nodes — the real contour (anchors, inset by contour_offset), the
    // same one the 3D viewers extrude. No contour → the siblings' bounding
    // box, exactly like ogBimMapper's fallback.
    for (const n of nodes.filter((nd) => nd.type === 'slab' && nd.parentId === s.id)) {
      const thickMm = getNodeSlabThickness(n) * 1000;
      let poly = calcShellPolygon(n, nodeMap, edges);
      if (poly && poly.length >= 3) {
        const inward = parseContourOffsets(n.properties.contour_offset).map((o) => -o);
        if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);
      }
      if (!poly || poly.length < 3) {
        const sibs = nodes.filter((sb) => sb.parentId === n.parentId && sb.type !== 'storey');
        const pts = (sibs.length ? sibs : [n]).map((sb) => getNodeBimPos(sb, nodeMap));
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        if (x1 - x0 < 1 || y1 - y0 < 1) continue;
        poly = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      }
      const vis = getVis('slab', String(n.properties.material ?? ''), matConfig, n);
      emitPrism(shapes, frame, poly, top - thickMm, top,
        { vis, nodeId: n.id, nodeType: 'slab', cutWeight: 'medium-cut' });
    }

    // Room-derived slabs (has_slab, default true) — the 3D viewers draw them,
    // so the section must too.
    for (const n of nodes.filter((nd) => nd.type === 'room' && nd.parentId === s.id)) {
      if (n.properties.has_slab === 'False' || n.properties.has_slab === false) continue;
      let poly = calcRoomPolygon(n, nodeMap, edges);
      if (!poly || poly.length < 3) continue;
      const inward = parseContourOffsets(n.properties.contour_offset).map((o) => -o);
      if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);
      if (!poly || poly.length < 3) continue;
      const thickMm = getNodeSlabThickness(n) * 1000;
      const vis = getVis('slab', String(n.properties.slab_material ?? ''), matConfig, n);
      emitPrism(shapes, frame, poly, top - thickMm, top,
        { vis, nodeId: n.id, nodeType: 'slab', cutWeight: 'medium-cut' });
    }
  }

  // ── Walls ────────────────────────────────────────────────────────────────
  for (const wn of nodes.filter((n) => n.type === 'wall')) {
    const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins);
    if (!geo) continue;
    const vis = getVis('wall', String(wn.properties.material ?? ''), matConfig, wn);

    for (const seg of geo.solidSegs) {
      const footprint = wallSegFootprint(seg);
      if (footprint.length === 0) continue;
      if (!nearPlane(footprint.map(L))) continue;
      const segBotMm = seg.baseY * 1000;
      const segTopMm = (seg.baseY + seg.height) * 1000;
      emitPrism(shapes, frame, footprint, segBotMm, segTopMm, { vis, nodeId: wn.id, nodeType: 'wall' });
    }

    // Beam on top of the wall: a prism along the wall's centre-line.
    if (geo.beamDesc) {
      const bd = geo.beamDesc;
      const footprint = lineFootprint(bd.ax * 1000, -bd.az * 1000, bd.bx * 1000, -bd.bz * 1000, bd.width * 1000);
      if (footprint.length && nearPlane(footprint.map(L))) {
        const bvis = getVis('beam', String(wn.properties.material ?? ''), matConfig, wn);
        emitPrism(shapes, frame, footprint, bd.baseY * 1000, (bd.baseY + bd.height) * 1000,
          { vis: bvis, nodeId: wn.id, nodeType: 'beam', cutWeight: 'medium-cut' });
      }
    }
  }

  // ── Standalone beam nodes ──────────────────────────────────────────────
  for (const bn of nodes.filter((n) => n.type === 'beam')) {
    const pts = getConnectedNodes(bn.id, edges, nodeMap);
    if (pts.length < 2) continue;
    const pA = getNodeBimPos(pts[0], nodeMap);
    const pB = getNodeBimPos(pts[1], nodeMap);
    const { sx, sy, ex, ey } = calcSpanEffectiveEnds(bn, pA, pB, pts[0], pts[1], nodeMap);
    const { top } = getStoreyBand(bn, nodeMap);
    const { bw, bh } = parseBeamDims(String(bn.properties.beam_section ?? bn.properties.beam_type ?? 'B30x60'));
    const footprint = lineFootprint(sx, sy, ex, ey, bw * 1000);
    if (!footprint.length || !nearPlane(footprint.map(L))) continue;
    const bvis = getVis('beam', String(bn.properties.material ?? ''), matConfig, bn);
    emitPrism(shapes, frame, footprint, top - bh * 1000, top,
      { vis: bvis, nodeId: bn.id, nodeType: 'beam', cutWeight: 'medium-cut' });
  }

  // ── Sweep elements ─────────────────────────────────────────────────────
  // A segment crossing the plane draws the TRUE placed profile (lateral axis
  // projected on u, profile height on v). Anything else falls back to the
  // projected bbox, like beams.
  for (const sn of nodes.filter((nd) => nd.type === 'sweep')) {
    const res = computeSweep(sn, nodeMap, edges);
    if (!res.placed || !res.path) continue;
    const svis = getVis('sweep', String(sn.properties.material ?? ''), matConfig, sn);
    const placed = res.placed;
    let drewCut = false;

    if (res.path.kind === 'horizontal') {
      const pts = res.path.points;
      const segCount = res.path.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segCount; i++) {
        const A = pts[i], B = pts[(i + 1) % pts.length];
        const la = L(A), lb = L(B);
        if ((la.y > 0 && lb.y > 0) || (la.y <= 0 && lb.y <= 0)) continue;
        const dy = lb.y - la.y;
        if (Math.abs(dy) < 1e-6) continue;
        const t = (0 - la.y) / dy;
        const cx = la.x + (lb.x - la.x) * t;
        // Lateral axis (left of travel, BIM) projected on the viewer's right.
        const bdx = B.x - A.x, bdy = B.y - A.y;
        const len = Math.hypot(bdx, bdy) || 1;
        const sxDir = (-bdy * frame.tx + bdx * frame.ty) / len;
        shapes.push({
          pts: placed.map((p) => ({ u: cx + sxDir * p.x, v: A.z + p.y })),
          closed: true,
          hatch: svis.hatch,
          fillColor: svis.section_fill_color ?? svis.color_2d,
          strokeColor: svis.section_line_color ?? svis.color_2d,
          lineWeight: 'medium-cut',
          depthMm: 0,
          nodeId: sn.id, nodeType: 'sweep',
        });
        drewCut = true;
      }
    }

    if (!drewCut) {
      for (const fp of res.footprint) {
        if (!nearPlane(fp.map(L))) continue;
        emitPrism(shapes, frame, fp, res.zMinMm, res.zMaxMm,
          { vis: svis, nodeId: sn.id, nodeType: 'sweep', cutWeight: 'medium-cut' });
      }
    }
  }

  // ── Foundations ────────────────────────────────────────────────────────
  for (const n of nodes.filter((nd) => nd.type === 'foundation')) {
    const fW = Number(n.properties.width ?? 1000);
    const fH = Number(n.properties.depth ?? n.properties.height ?? 500);
    const { bot } = getStoreyBand(n, nodeMap);
    const fHalfW = fW / 2;
    const footprint = [
      { x: n.x - fHalfW, y: n.y - fHalfW },
      { x: n.x + fHalfW, y: n.y - fHalfW },
      { x: n.x + fHalfW, y: n.y + fHalfW },
      { x: n.x - fHalfW, y: n.y + fHalfW },
    ];
    if (!nearPlane(footprint.map(L))) continue;
    const fvis = getVis('foundation', String(n.properties.material ?? ''), matConfig, n);
    // Below ground a projected foundation is not visible; draw it hidden.
    emitPrism(shapes, frame, footprint, bot - fH, bot,
      { vis: fvis, nodeId: n.id, nodeType: 'foundation', projWeight: 'hidden' });
  }

  // ── Roofs ──────────────────────────────────────────────────────────────
  // Each face is a planar 3D polygon: its crossing with the plane is the cut
  // (a band of the covering thickness on a slope, a line on a gable end);
  // the part in front of the plane is its projected outline.
  for (const rn of nodes.filter((nd) => nd.type === 'roof')) {
    const { faces } = computeRoofFaces(rn, nodes, edges);
    if (!faces.length) continue;
    const thickMm = Math.max(10, Number(rn.properties.covering_thickness_mm ?? 40));
    const rvis = getVis('roof', String(rn.properties.material ?? ''), matConfig, rn);
    for (const face of faces) {
      const poly: UDZ[] = face.vertices.map((v) => ({ ...L(v), z: v.z }));
      if (!nearPlane(poly)) continue;
      const segs = cutSegments3(poly);
      for (const [p, q] of segs) {
        if (face.role === 'slope') {
          shapes.push({
            pts: [
              { u: p.x, v: p.z }, { u: q.x, v: q.z },
              { u: q.x, v: q.z - thickMm }, { u: p.x, v: p.z - thickMm },
            ],
            closed: true,
            hatch: rvis.hatch,
            fillColor: rvis.section_fill_color ?? rvis.color_2d,
            strokeColor: rvis.section_line_color ?? rvis.color_2d,
            lineWeight: 'medium-cut',
            depthMm: 0,
            nodeId: rn.id, nodeType: 'roof',
          });
        } else {
          shapes.push({
            pts: [{ u: p.x, v: p.z }, { u: q.x, v: q.z }],
            closed: false, hatch: 'none', fillColor: 'none',
            strokeColor: rvis.section_line_color ?? rvis.color_2d,
            lineWeight: 'heavy-cut', depthMm: 0,
            nodeId: rn.id, nodeType: 'roof',
          });
        }
      }
      const front = clipPolygonY(poly, 0, true, lerp3);
      if (front.length < 3) continue;
      const dMin = -Math.max(...front.map((p) => p.y));
      if (dMin > frame.depth + 1) continue;
      shapes.push({
        pts: front.map((p) => ({ u: p.x, v: p.z })),
        closed: true, hatch: 'none', fillColor: 'none',
        strokeColor: rvis.view_line_color ?? rvis.color_2d,
        lineWeight: 'projected',
        depthMm: Math.max(0, dMin),
        nodeId: rn.id, nodeType: 'roof',
      });
    }
  }

  // ── Stairs ─────────────────────────────────────────────────────────────
  // A flight is `flightProfile` extruded across its width. Cut along the run
  // it shows the sawtooth — the drawing every stair section is; cut across
  // it shows the block at the crossing; in front, the projected profile.
  for (const fn of nodes.filter((nd) => nd.type === 'stair_flight')) {
    const p = fn.properties;
    const a = { x: Number(p.ax), y: Number(p.ay), z: Number(p.az) };
    const b = { x: Number(p.bx), y: Number(p.by), z: Number(p.bz) };
    if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) continue;
    const widthMm = Number(p.width_mm ?? 1000);
    const riserMm = Number(p.riser_mm ?? 170);
    const treadMm = Number(p.tread_mm ?? 280);
    const thickMm = Number(p.thickness_mm ?? 150);
    const steps = Math.max(1, Math.round(Number(p.steps ?? 1)));
    const runMm = Math.hypot(b.x - a.x, b.y - a.y);
    if (runMm < 1) continue;
    const dir = { x: (b.x - a.x) / runMm, y: (b.y - a.y) / runMm };
    const footprint = lineFootprint(a.x, a.y, b.x, b.y, widthMm);
    const fp = footprint.map(L);
    if (!nearPlane(fp)) continue;
    const svis = getVis('stair_flight', String(p.material ?? ''), matConfig, fn);
    const profile = flightProfile(steps, riserMm, treadMm, thickMm, {
      footDropMm: Number(p.foot_drop_mm ?? 0),
      headDropMm: Number(p.head_drop_mm ?? thickMm),
      ...(p.tail_mm != null ? { tailMm: Number(p.tail_mm) } : {}),
    });
    const along = dir.x * frame.tx + dir.y * frame.ty; // run projected on u
    const la = L(a);
    const isCut = straddles(fp);

    if (profile && isCut && Math.abs(along) > 0.7) {
      shapes.push({
        pts: profile.map((q) => ({ u: la.x + q.x * along, v: a.z + q.y })),
        closed: true,
        hatch: svis.hatch,
        fillColor: svis.section_fill_color ?? svis.color_2d,
        strokeColor: svis.section_line_color ?? svis.color_2d,
        lineWeight: 'medium-cut',
        depthMm: 0,
        nodeId: fn.id, nodeType: 'stair_flight',
      });
      continue;
    }
    if (isCut) {
      // Crossing the run: where does the walking line meet the plane?
      const lb = L(b);
      const t = Math.abs(lb.y - la.y) > 1e-6 ? Math.min(1, Math.max(0, (0 - la.y) / (lb.y - la.y))) : 0.5;
      const zAt = a.z + t * (b.z - a.z);
      for (const [u0, u1] of cutIntervals(fp)) {
        shapes.push({
          pts: rect(u0, u1, zAt - thickMm, zAt + riserMm), closed: true,
          hatch: svis.hatch,
          fillColor: svis.section_fill_color ?? svis.color_2d,
          strokeColor: svis.section_line_color ?? svis.color_2d,
          lineWeight: 'medium-cut', depthMm: 0,
          nodeId: fn.id, nodeType: 'stair_flight',
        });
      }
      continue;
    }
    const front = clipPolygonY(fp, 0, true);
    if (front.length < 3) continue;
    const dMin = -Math.max(...front.map((q) => q.y));
    if (dMin > frame.depth + 1) continue;
    if (profile && Math.abs(along) > 0.05) {
      shapes.push({
        pts: profile.map((q) => ({ u: la.x + q.x * along, v: a.z + q.y })),
        closed: true, hatch: 'none', fillColor: 'none',
        strokeColor: svis.view_line_color ?? svis.color_2d,
        lineWeight: 'projected', depthMm: Math.max(0, dMin),
        nodeId: fn.id, nodeType: 'stair_flight',
      });
    } else {
      const us = front.map((q) => q.x);
      shapes.push({
        pts: rect(Math.min(...us), Math.max(...us), Math.min(a.z, b.z) - thickMm, Math.max(a.z, b.z) + riserMm),
        closed: true, hatch: 'none', fillColor: 'none',
        strokeColor: svis.view_line_color ?? svis.color_2d,
        lineWeight: 'projected', depthMm: Math.max(0, dMin),
        nodeId: fn.id, nodeType: 'stair_flight',
      });
    }
  }

  // Landings and winders: flat prisms hung under their walking level.
  for (const n of nodes.filter((nd) => nd.type === 'stair_landing' || nd.type === 'stair_winder')) {
    let poly: { x: number; y: number }[] = [];
    try { poly = JSON.parse(String(n.properties.polygon ?? '[]')); } catch { /* no polygon, no shape */ }
    if (!Array.isArray(poly) || poly.length < 3) continue;
    const levelMm = Number(n.properties.level_mm ?? n.z);
    const hMm = n.type === 'stair_landing'
      ? Number(n.properties.thickness_mm ?? 150)
      : Number(n.properties.riser_mm ?? 170);
    if (!nearPlane(poly.map(L))) continue;
    const vis = getVis(n.type, String(n.properties.material ?? ''), matConfig, n);
    emitPrism(shapes, frame, poly, levelMm - hMm, levelMm,
      { vis, nodeId: n.id, nodeType: n.type, cutWeight: 'medium-cut' });
  }

  // ── Horizontal and vertical range ──────────────────────────────────────
  // ArchiCAD clips the section to the marker's length and to its vertical
  // range; so do we, splitting polylines where they leave the box.
  const uLo = frame.clip ? 0 : -Infinity;
  const uHi = frame.clip ? frame.lengthMm : Infinity;
  const clipped: DrawingShape[] = [];
  for (const sh of shapes) {
    if (sh.closed) {
      const pts = clipShapeBox(sh.pts, uLo, uHi, elevMin, elevMax);
      if (pts.length >= 3) clipped.push({ ...sh, pts });
    } else {
      for (const run of clipPolylineBox(sh.pts, uLo, uHi, elevMin, elevMax)) {
        clipped.push({ ...sh, pts: run });
      }
    }
  }
  const visibleAxes = frame.clip
    ? axes.filter((a) => a.u >= uLo - 1 && a.u <= uHi + 1)
    : axes;

  // ── Sort: painter's algorithm (far elements first = back to front) ─────────
  clipped.sort((a, b) => b.depthMm - a.depthMm);

  // ── Compute bounds ─────────────────────────────────────────────────────────
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const sh of clipped) {
    for (const p of sh.pts) {
      if (p.u < uMin) uMin = p.u; if (p.u > uMax) uMax = p.u;
      if (p.v < vMin) vMin = p.v; if (p.v > vMax) vMax = p.v;
    }
  }
  visibleAxes.forEach((a) => { if (a.u < uMin) uMin = a.u; if (a.u > uMax) uMax = a.u; });
  if (frame.clip) { uMin = Math.min(uMin, 0); uMax = Math.max(uMax, frame.lengthMm); }
  if (!isFinite(uMin)) { uMin = 0; uMax = 20000; }
  if (!isFinite(vMin)) { vMin = elevMin; vMax = elevMax; }

  return { shapes: clipped, axes: visibleAxes, levels, uMin, uMax, vMin, vMax };
}

// ─── Elevation view computation ───────────────────────────────────────────────

/**
 * Compute all drawing shapes for an external elevation view.
 *
 * Direction mapping:
 *   'N' → looking in +Y direction: U = BIM X, depth = BIM Y (ascending = further)
 *   'S' → looking in -Y direction: U = -BIM X (flipped), depth = -BIM Y
 *   'E' → looking in -X direction: U = BIM Y, depth = -BIM X
 *   'W' → looking in +X direction: U = -BIM Y, depth = BIM X
 *
 * V (vertical) = BIM elevation (mm, positive = up) in all cases.
 */
export function computeElevationView(
  rawNodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null,
  dir: ElevationDir,
  elevMin?: number,
  elevMax?: number,
): DrawingResult {
  const nodes = expandArrayNodes(rawNodes);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  const storeys = nodes.filter((n) => n.type === 'storey');

  /** Map (bimX, bimY) → (U: horizontal, depth: how far away) */
  const toUDepth = (bimX: number, bimY: number): { u: number; depth: number } => {
    switch (dir) {
      case 'N': return { u: bimX,  depth: bimY };
      case 'S': return { u: -bimX, depth: -bimY };
      case 'E': return { u: bimY,  depth: -bimX };
      case 'W': return { u: -bimY, depth: bimX };
    }
  };

  const allBots = storeys.map((s) => Number(s.properties.bottomElevation ?? 0));
  const allTops = storeys.map((s) => Number(s.properties.topElevation ?? 3000));
  const vMin = elevMin ?? (allBots.length ? Math.min(...allBots) : 0);
  const vMax = elevMax ?? (allTops.length ? Math.max(...allTops) : 3000);

  const shapes: DrawingShape[] = [];
  const axes: DrawingAxis[] = [];
  const levels: DrawingLevel[] = [];

  // ── Levels ───────────────────────────────────────────────────────────────
  for (const s of storeys) {
    const bot = Number(s.properties.bottomElevation ?? 0);
    const top = Number(s.properties.topElevation ?? 3000);
    levels.push({ vMm: bot, label: `+${(bot / 1000).toFixed(3)}` });
    levels.push({ vMm: top, label: `+${(top / 1000).toFixed(3)}` });
  }

  // ── Axis grid lines (perpendicular to view direction) ─────────────────────
  for (const s of storeys) {
    const vals = dir === 'N' || dir === 'S'
      ? parseAxes(s.properties.axesX).sort((a, b) => a - b)
      : parseAxes(s.properties.axesY).sort((a, b) => a - b);
    vals.forEach((v, i) => {
      const u = dir === 'S' ? -v : dir === 'W' ? -v : v;
      axes.push({ u, label: dir === 'N' || dir === 'S' ? String(i + 1) : String.fromCharCode(65 + i), kind: dir === 'N' || dir === 'S' ? 'X' : 'Y' });
    });
    break;
  }

  // ── Walls ───────────────────────────────────────────────────────────────
  for (const wn of nodes.filter((n) => n.type === 'wall')) {
    const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins);
    if (!geo) continue;

    const vis = getVis('wall', String(wn.properties.material ?? ''), matConfig, wn);

    for (const seg of geo.solidSegs) {
      // Footprint in BIM (X,Y) plan mm
      const fp = wallSegFootprint(seg);
      if (fp.length === 0) continue;

      // Get the U and depth range of this segment footprint
      const uVals = fp.map((p) => toUDepth(p.x, p.y).u);
      const depths = fp.map((p) => toUDepth(p.x, p.y).depth);
      const uMin = Math.min(...uVals); const uMax = Math.max(...uVals);
      const depthMin = Math.min(...depths); const depthMax = Math.max(...depths);

      const segBotMm = seg.baseY * 1000;
      const segTopMm = (seg.baseY + seg.height) * 1000;

      shapes.push({
        pts: [
          { u: uMin, v: segBotMm },
          { u: uMax, v: segBotMm },
          { u: uMax, v: segTopMm },
          { u: uMin, v: segTopMm },
        ],
        closed: true,
        hatch: 'none', // elevation: no hatch fill, just outline + face color
        fillColor: vis.view_fill_color ?? vis.color_2d,
        strokeColor: vis.view_line_color ?? vis.color_2d,
        lineWeight: 'projected',
        depthMm: depthMin,
        nodeId: wn.id, nodeType: 'wall',
      });

      // Openings (windows/doors) on this wall segment
      for (const op of geo.openings) {
        // op.tS: metres from wall start along centre-line
        // Wall start in BIM mm:
        const sxMm = geo.sxM * 1000; const syMm = -geo.szM * 1000; // BIM Y = -szM in metres
        const exMm = geo.exM * 1000; const eyMm = -geo.ezM * 1000;
        const wDx = exMm - sxMm; const wDy = eyMm - syMm;
        const wLen = Math.sqrt(wDx * wDx + wDy * wDy);
        if (wLen < 1) continue;
        const wUx = wDx / wLen; const wUy = wDy / wLen;

        // Opening centre in plan
        const opCX = sxMm + wUx * (op.tS * 1000 + op.oW * 1000 / 2);
        const opCY = syMm + wUy * (op.tS * 1000 + op.oW * 1000 / 2);

        // Project opening width onto U axis
        const uStart = toUDepth(sxMm + wUx * op.tS * 1000, syMm + wUy * op.tS * 1000).u;
        const uEnd   = toUDepth(sxMm + wUx * (op.tS + op.oW) * 1000, syMm + wUy * (op.tS + op.oW) * 1000).u;
        const opDepth = toUDepth(opCX, opCY).depth;

        const opSillMm = geo.botM * 1000 + op.sill * 1000;
        const opTopMm  = opSillMm + op.oH * 1000;

        const otype = op.isDoor ? 'door' : 'window';
        const ovis = getVis(otype, String(op.node.properties.material ?? ''), matConfig, op.node);

        // Opening background (lighter)
        shapes.push({
          pts: [
            { u: Math.min(uStart, uEnd), v: opSillMm },
            { u: Math.max(uStart, uEnd), v: opSillMm },
            { u: Math.max(uStart, uEnd), v: opTopMm },
            { u: Math.min(uStart, uEnd), v: opTopMm },
          ],
          closed: true,
          hatch: 'none',
          fillColor: ovis.color_2d,
          strokeColor: ovis.section_line_color ?? '#555555',
          lineWeight: 'projected',
          depthMm: opDepth - 1, // render in front of wall
          nodeId: op.node.id, nodeType: otype,
        });
      }
    }
  }

  // ── Columns ────────────────────────────────────────────────────────────
  for (const s of storeys) {
    const bot = Number(s.properties.bottomElevation ?? 0);
    const top = Number(s.properties.topElevation ?? 3000);
    for (const n of nodes.filter((nd) => nd.type === 'ax' && nd.parentId === s.id)) {
      if (String(n.properties.has_column ?? '').toLowerCase() !== 'true') continue;
      const { x: bimX, y: bimY } = getAxRealPos(n, nodeMap);
      const { w } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
      const hw = w * 1000 / 2;
      const { u, depth } = toUDepth(bimX, bimY);
      const vis = getVis('column', String(n.properties.material ?? ''), matConfig, n);
      shapes.push({
        pts: [
          { u: u - hw, v: bot },
          { u: u + hw, v: bot },
          { u: u + hw, v: top },
          { u: u - hw, v: top },
        ],
        closed: true,
        hatch: 'none',
        fillColor: vis.view_fill_color ?? vis.color_2d,
        strokeColor: vis.view_line_color ?? vis.color_2d,
        lineWeight: 'projected',
        depthMm: depth,
        nodeId: n.id, nodeType: 'column',
      });
    }
  }

  // ── Sort by depth (painter's algorithm) ──────────────────────────────────
  shapes.sort((a, b) => b.depthMm - a.depthMm);

  // ── Bounds ────────────────────────────────────────────────────────────────
  let uMin2 = Infinity, uMax2 = -Infinity;
  for (const sh of shapes) for (const p of sh.pts) {
    if (p.u < uMin2) uMin2 = p.u; if (p.u > uMax2) uMax2 = p.u;
  }
  axes.forEach((a) => { if (a.u < uMin2) uMin2 = a.u; if (a.u > uMax2) uMax2 = a.u; });
  if (!isFinite(uMin2)) { uMin2 = 0; uMax2 = 20000; }

  return { shapes, axes, levels, uMin: uMin2, uMax: uMax2, vMin, vMax };
}
