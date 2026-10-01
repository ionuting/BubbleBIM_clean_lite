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
  type WallGeometry,
} from '@/lib/bimGeometry';
import { isDoubleOpening } from '@/lib/elementLibrary';
import { expandArrayNodes } from '@/lib/formulaUtils';
import { computeSweep, frameOf } from '@/lib/sweep';
import { computeSketch } from '@/lib/sketch';
import { computeScatter, scatterSilhouette, type ScatterInstance, type SilhouetteBucket } from '@/lib/scatter';
import { computeFacade } from '@/lib/facade';
import { computeDome, type DomeResult } from '@/lib/dome';
import { terrainItemInstances } from '@/lib/scatter/terrainItems';
import * as terrainLib from '@/lib/terrain';
import { currentTerrainModel as currentTerrainModelForScatter } from '@/lib/terrain/current';
import { computeSite, findSiteNode, type TerrainModel } from '@/lib/terrain';
import { currentTerrainModel } from '@/lib/terrain/current';
import { computeRoofFaces } from '@/lib/roof/solver';
import {
  attachHeightAlong, attachesToRoof, isTrimmed, roofTrim, roofTrimsNode, topOutline, trimmedTopAlong,
  type RoofTrim, type TrimPlane,
} from '@/lib/roof/trim';
import { gableFootprintMm, gableMaterial, gableSpec, wallThicknessMm } from '@/lib/roof/gable';
import { flightProfile } from '@/lib/stair/profile';
import { parseAxes } from '@/lib/utils';
import type { HatchPattern, MaterialVisuals, MaterialConfig } from '@/lib/materialConfig';
import { resolveVisuals, applyNodeColorOverrides, resolveWindowGlazing } from '@/lib/materialConfig';
import { VIEW_TINT, tintHex } from '@/lib/drawingStyle';

// ─── Public types ─────────────────────────────────────────────────────────────

export type LineWeight = 'heavy-cut' | 'medium-cut' | 'projected' | 'annotation' | 'hidden';

/** A closed polygon or open polyline in drawing space (mm). */
export interface DrawingShape {
  /** Closed polygon corners in drawing coords: { u: horizontal mm, v: elevation mm }  */
  pts: { u: number; v: number }[];
  /** Whether this shape is closed (filled) or open (just stroked as lines) */
  closed: boolean;
  /**
   * Openings within a closed face — a duct through a slab, a shaft through a
   * floor, the doorway in a wall cut at its head. Only the kernel-sliced cut
   * (`ogDrawing/slice.ts`) has them: a face built from an element's parameters
   * is a rectangle and never needs one. Renderers without hole support see a
   * solid face, which is what they drew before this field existed.
   */
  holes?: { u: number; v: number }[][];
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
  /**
   * For a floor plan, where the grid runs BOTH ways: an axis with `v` set is
   * a horizontal line at that ordinate, and `u` is then only where its bubble
   * sits. A vertical view has one axis direction and leaves this out.
   */
  v?: number;
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
  /**
   * Bottom and top elevation limits (mm). Left out, the drawing keeps whatever
   * the model reaches — a roof above the top storey, a footing below the
   * bottom one — instead of being cut at the storey band.
   */
  elevMin?: number;
  elevMax?: number;
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

/**
 * A column-like prism, cut back by any roof above it. Its "run" is the footprint
 * diagonal — a column is small next to a roof plane, so that catches the fold
 * without pretending the square top is anything more than four corners.
 */
function emitColumnPrism(
  shapes: DrawingShape[],
  frame: CutFrame,
  footprint: { x: number; y: number }[],
  bot: number,
  top: number,
  style: PrismStyle,
  roofTrims: RoofTrim[],
  node: BubbleGraphNode,
): void {
  const planes = planesOver(roofTrims, node, footprint);
  if (planes.length > 0) {
    const centre = { a: footprint[0], b: footprint[2] };
    let zTop = top;
    if (attachesToRoof(node)) {
      const reach = attachHeightAlong(planes, centre.a, centre.b);
      if (reach != null && reach > zTop) zTop = reach;
    }
    if (isTrimmed(trimmedTopAlong(planes, centre.a, centre.b, zTop), zTop)) {
      emitTrimmedPrism(shapes, frame, footprint, bot, zTop, style, planes, centre);
      return;
    }
    if (zTop !== top) { emitPrism(shapes, frame, footprint, bot, zTop, style); return; }
  }
  emitPrism(shapes, frame, footprint, bot, top, style);
}

/** One body of a wall to draw: where it stands, and how high it goes. */
interface WallRun {
  footprint: { x: number; y: number }[];
  centre: { a: { x: number; y: number }; b: { x: number; y: number } };
  botMm: number;
  topMm: number;
}

/** The wall as one body, openings and all — what an elevation sees of it. */
function wholeWallRun(geo: WallGeometry): WallRun {
  const botMm = geo.botM * 1000;
  return {
    footprint: geo.footprint,
    centre: {
      a: { x: geo.sxM * 1000, y: -geo.szM * 1000 },
      b: { x: geo.exM * 1000, y: -geo.ezM * 1000 },
    },
    botMm,
    topMm: botMm + geo.wallH,
  };
}

/** The centre-line of a wall segment in BIM mm — the run its roof trim reads along. */
function wallSegCentre(seg: {
  ax: number; az: number; bx: number; bz: number; tStart: number; tEnd: number;
}): { a: { x: number; y: number }; b: { x: number; y: number } } {
  const sx = seg.ax * 1000, sy = -seg.az * 1000;
  const ex = seg.bx * 1000, ey = -seg.bz * 1000;
  const dx = ex - sx, dy = ey - sy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  return {
    a: { x: sx + ux * seg.tStart * 1000, y: sy + uy * seg.tStart * 1000 },
    b: { x: sx + ux * seg.tEnd * 1000, y: sy + uy * seg.tEnd * 1000 },
  };
}

/**
 * Every roof's trim planes, built once per drawing. Roofs that opt out, or whose
 * faces are all vertical, simply contribute nothing.
 */
function collectRoofTrims(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]): RoofTrim[] {
  const out: RoofTrim[] = [];
  for (const rn of nodes) {
    if (rn.type !== 'roof') continue;
    const t = roofTrim(rn, computeRoofFaces(rn, nodes, edges).faces);
    if (t) out.push(t);
  }
  return out;
}

/** The planes of every roof entitled to cut this node. */
const planesOver = (trims: RoofTrim[], node: BubbleGraphNode, footprint: { x: number; y: number }[]): TrimPlane[] =>
  trims.filter((t) => roofTrimsNode(t, node, footprint)).flatMap((t) => t.planes);

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

/**
 * The face colour an elevation paints an element with. `view_fill_color` is an
 * optional extra a stored config may carry that `MaterialVisuals` does not
 * declare, so the read is narrowed here rather than at each call site.
 */
/**
 * The colour of a face that is SEEN, not cut: the material's own view fill
 * when it names one, else its 2D colour lightened — see `VIEW_TINT`.
 */
const viewFill = (v: MaterialVisuals): string =>
  (v as MaterialVisuals & { view_fill_color?: string }).view_fill_color ?? tintHex(v.color_2d, VIEW_TINT);

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
export interface CutFrame {
  ax: number; ay: number;
  tx: number; ty: number;
  nx: number; ny: number;
  lengthMm: number;
  clip: boolean;
  depth: number;
}

/**
 * Exact projected outlines from the OpenGeometry kernel (see
 * `ogProjection.ts`), to draw INSTEAD of the engine's own bounding-rectangle
 * outlines for the elements they cover.
 *
 * What they are: each solid's true silhouette in this view, its openings
 * included, with its own back faces removed. What they are NOT: hidden-line
 * removal between elements — the kernel does not do that (measured, see
 * `ogProjection.ts`). So these lines carry each element's real depth and go
 * through the same painter's sort as everything else; occlusion still comes
 * from the opaque face fills, exactly as before.
 *
 * The cut is never in here: a kernel that cannot section leaves the cut to
 * the engine.
 */
export interface KernelOutlines {
  /** Open two-point shapes in drawing mm, already in the frame's (u, v). */
  shapes: DrawingShape[];
  /** Node ids whose bounding-rectangle outlines these replace. */
  covered: Set<string>;
}

export function buildFrame(cut: SectionCut): CutFrame {
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
function cutIntervals(fp: UD[], holes: UD[][] = []): [number, number][] {
  // Even-odd over every ring at once: a hole's crossings interleave with the
  // outline's, so the pairs are exactly the solid stretches either side of it.
  const xs: number[] = [];
  for (const ring of [fp, ...holes]) {
    for (let i = 0; i < ring.length; i++) {
      const A = ring[i], B = ring[(i + 1) % ring.length];
      if ((A.y <= 0 && B.y > 0) || (B.y <= 0 && A.y > 0)) {
        const t = (0 - A.y) / (B.y - A.y);
        xs.push(A.x + t * (B.x - A.x));
      }
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

/** Convex hull of drawing points (Andrew's monotone chain), counter-clockwise. */
export function convexHull(pts: { u: number; v: number }[]): { u: number; v: number }[] {
  const p = [...pts].sort((a, b) => a.u - b.u || a.v - b.v);
  if (p.length < 3) return p;
  const cross = (o: { u: number; v: number }, a: { u: number; v: number }, b: { u: number; v: number }) =>
    (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);
  const lower: { u: number; v: number }[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: { u: number; v: number }[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/**
 * The cross-section a dome's rib leaves on the cut, mm: the profile's own
 * extent when the dome has one, else the rectangle its parameters name.
 */
function domeRibSize(res: DomeResult): { w: number; h: number } {
  const poly = res.profile?.polygon;
  if (poly && poly.length >= 3) {
    const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    if (w > 0 && h > 0) return { w, h };
  }
  const p = res.intent.params;
  return { w: Number(p.p_w_mm) > 0 ? Number(p.p_w_mm) : 60, h: Number(p.p_h_mm) > 0 ? Number(p.p_h_mm) : 120 };
}

interface PrismStyle {
  vis: MaterialVisuals;
  nodeId: string;
  nodeType: string;
  cutWeight?: LineWeight;
  projWeight?: LineWeight;
  /**
   * Face colour for the part that is only SEEN, not cut. A section leaves it
   * unset — a projected outline there is a thin line over whatever is behind
   * it — while an elevation is nothing but seen faces, so it always sets one.
   */
  projFill?: string;
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
  /** Holes through the footprint — the plane cuts across them as air. */
  holesBim: { x: number; y: number }[][] = [],
): boolean {
  if (fpBim.length < 3 || !(zTop > zBot)) return false;
  const fp = fpBim.map((p) => localOf(frame, p));
  const { vis, nodeId, nodeType } = style;

  const intervals = cutIntervals(fp, holesBim.map((h) => h.map((p) => localOf(frame, p))));
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
    fillColor: style.projFill ?? 'none',
    strokeColor: vis.view_line_color ?? vis.color_2d,
    lineWeight: style.projWeight ?? 'projected',
    depthMm: Math.max(0, dMin),
    nodeId, nodeType,
  });
  return false;
}

export function localOf(frame: CutFrame, p: { x: number; y: number }): UD {
  const rx = p.x - frame.ax, ry = p.y - frame.ay;
  return { x: rx * frame.tx + ry * frame.ty, y: -(rx * frame.nx + ry * frame.ny) };
}

/** The BIM point at local `u` ON the cut line (d = 0) — the inverse of `localOf`. */
const bimAt = (frame: CutFrame, u: number) => ({ x: frame.ax + u * frame.tx, y: frame.ay + u * frame.ty });

/**
 * A prism whose top follows the roof above it.
 *
 * Same two branches as `emitPrism`, but the top edge is the folded profile from
 * `trimmedTopAlong` instead of a flat line. Where the run is CUT the profile is
 * read along the cut line itself, so it is exact; where it is only seen beyond
 * the cut, it is read along the run's centre-line and mapped onto u. A run
 * square to the view collapses to a single u, and then the silhouette is its
 * highest point.
 *
 * Kept separate from `emitPrism` on purpose: the untrimmed path is the common
 * one and stays a plain rectangle.
 */
function emitTrimmedPrism(
  shapes: DrawingShape[],
  frame: CutFrame,
  fpBim: { x: number; y: number }[],
  zBot: number,
  zTop: number,
  style: PrismStyle,
  planes: TrimPlane[],
  centre: { a: { x: number; y: number }; b: { x: number; y: number } },
): boolean {
  if (fpBim.length < 3 || !(zTop > zBot)) return false;
  const fp = fpBim.map((p) => localOf(frame, p));
  const { vis, nodeId, nodeType } = style;

  /** Bottom edge left→right, then the top profile right→left. */
  const shell = (u0: number, u1: number, top: Array<{ u: number; v: number }>) =>
    [{ u: u0, v: zBot }, { u: u1, v: zBot }, ...[...top].reverse()];

  const intervals = cutIntervals(fp);
  if (intervals.length > 0) {
    for (const [u0, u1] of intervals) {
      const segs = trimmedTopAlong(planes, bimAt(frame, u0), bimAt(frame, u1), zTop);
      const top = topOutline(segs).map((p) => ({ u: u0 + (u1 - u0) * p.t, v: p.z }));
      if (top.length < 2) continue;
      shapes.push({
        pts: shell(u0, u1, top), closed: true,
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
  const u0 = Math.min(...us), u1 = Math.max(...us);

  const segs = trimmedTopAlong(planes, centre.a, centre.b, zTop);
  const ua = localOf(frame, centre.a).x, ub = localOf(frame, centre.b).x;
  const outline = topOutline(segs);
  const top = Math.abs(ub - ua) < 1
    ? [{ u: u0, v: Math.max(...outline.map((p) => p.z)) }, { u: u1, v: Math.max(...outline.map((p) => p.z)) }]
    : outline
      .map((p) => ({ u: ua + (ub - ua) * p.t, v: p.z }))
      .sort((m, n) => m.u - n.u);
  if (top.length < 2) return false;

  shapes.push({
    pts: shell(u0, u1, top), closed: true,
    hatch: 'none',
    fillColor: style.projFill ?? 'none',
    strokeColor: vis.view_line_color ?? vis.color_2d,
    lineWeight: style.projWeight ?? 'projected',
    depthMm: Math.max(0, dMin),
    nodeId, nodeType,
  });
  return false;
}

/** How wide the frame face reads when the opening carries no profile of its own. */
const FRAME_FACE_MM = 60;
/** How far a window's sill line runs past the reveal on each side. */
const SILL_OVERHANG_MM = 60;
/** The plate a pane is, and the slab a door leaf is, where a section cuts them. */
const PANE_MM = 8;
const LEAF_MM = 40;

/**
 * The window or door standing in a wall opening, as a view of the wall draws
 * it: the frame, the pane or leaf inside it, a mullion when the type has two
 * sashes, and the line a window's sill makes under it.
 *
 * Called once per WALL. The opening is one hole however many solid segments
 * the wall was split into around it, so emitting it from inside that loop
 * would draw it once per parapet, lintel and pier.
 *
 * Colours come from the global glazing config — the same frame and glass the
 * 3D viewers and the IFC export use — so a facade drawn here matches the model
 * it was taken from.
 */
function emitWallOpenings(
  shapes: DrawingShape[],
  frame: CutFrame,
  geo: WallGeometry,
  matConfig: MaterialConfig | null,
): void {
  const glazing = resolveWindowGlazing(matConfig);

  for (const op of geo.openings) {
    // The opening's own plan rectangle: its width along the wall, the wall's
    // thickness across it.
    const cx = op.cx * 1000, cy = -op.cz * 1000;
    const dx = op.ux, dy = -op.uz;
    const nx = -dy, ny = dx;
    const hw = (op.oW * 1000) / 2, ht = (op.wallThick * 1000) / 2;
    const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => localOf(frame, {
      x: cx + a * hw * dx + b * ht * nx,
      y: cy + a * hw * dy + b * ht * ny,
    }));

    const v0 = (op.botY + op.sill) * 1000;
    const v1 = v0 + op.oH * 1000;
    const isDoor = op.isDoor;
    const ovis = getVis(isDoor ? 'door' : 'window', String(op.node.properties.material ?? ''), matConfig, op.node);
    const line = ovis.view_line_color ?? ovis.color_2d;
    const prof = Math.max(20, (op.PROFILE > 0 ? op.PROFILE * 1000 : FRAME_FACE_MM));

    // ── Cut by the plane ──────────────────────────────────────────────────
    // The section passes THROUGH the joinery, so what shows is its
    // cross-section: the head member, the sill member a window sits on, and
    // the glass between them as the thin plate it is. Narrow in u — the
    // interval is the wall's thickness, not the opening's width.
    if (straddles(corners)) {
      for (const [c0, c1] of cutIntervals(corners)) {
        const mid = (c0 + c1) / 2;
        const push = (pts: { u: number; v: number }[], fill: string) => shapes.push({
          pts, closed: true, hatch: 'none',
          fillColor: fill, strokeColor: ovis.section_line_color ?? line,
          lineWeight: 'medium-cut', depthMm: 0,
          nodeId: op.node.id, nodeType: isDoor ? 'door' : 'window',
        });
        if (v1 - v0 <= 2 * prof) continue;
        push(rect(c0, c1, v1 - prof, v1), glazing.frame_color);          // head
        if (!isDoor) push(rect(c0, c1, v0, v0 + prof), glazing.frame_color); // sill
        const half = (isDoor ? LEAF_MM : PANE_MM) / 2;
        push(
          rect(mid - half, mid + half, isDoor ? v0 : v0 + prof, v1 - prof),
          isDoor ? viewFill(ovis) : glazing.glass_color,
        );
      }
      continue;
    }

    // ── Seen beyond the plane ─────────────────────────────────────────────
    // Only what is in FRONT of it. The prisms get this from `clipPolygonY`
    // returning nothing for a body behind the viewer; an opening has to ask
    // the same question itself, or a window in the wall at your back is drawn
    // into the drawing along with the one you are looking at.
    const front = clipPolygonY(corners, 0, true);
    if (front.length < 3) continue;
    const dMin = -Math.max(...front.map((p) => p.y));
    if (dMin > frame.depth + 1) continue;
    const us = corners.map((p) => p.x);
    const u0 = Math.min(...us), u1 = Math.max(...us);
    if (u1 - u0 < 1) continue;                    // square to the view: a line, not a face

    // Strictly nearer than the wall it sits in — they share a near face, so
    // sorting on the same value would leave the order to chance.
    const depthMm = dMin - 1;
    const push = (pts: { u: number; v: number }[], fill: string, lineWeight: LineWeight) => shapes.push({
      pts, closed: true, hatch: 'none',
      fillColor: fill, strokeColor: line, lineWeight, depthMm,
      nodeId: op.node.id, nodeType: isDoor ? 'door' : 'window',
    });

    push(rect(u0, u1, v0, v1), glazing.frame_color, 'medium-cut');

    // Inside the frame: the glass, or the leaf. A door frame has no bottom
    // member, so its leaf stands on the floor.
    const iu0 = u0 + prof, iu1 = u1 - prof;
    const iv0 = isDoor ? v0 : v0 + prof, iv1 = v1 - prof;
    if (iu1 - iu0 > 1 && iv1 - iv0 > 1) {
      const fill = isDoor ? viewFill(ovis) : glazing.glass_color;
      if (isDoubleOpening(op.node, isDoor)) {
        // Two sashes meeting on a mullion the width of the frame face.
        const mid = (iu0 + iu1) / 2;
        if (mid - prof / 2 - iu0 > 1) {
          push(rect(iu0, mid - prof / 2, iv0, iv1), fill, 'projected');
          push(rect(mid + prof / 2, iu1, iv0, iv1), fill, 'projected');
        } else {
          push(rect(iu0, iu1, iv0, iv1), fill, 'projected');
        }
      } else {
        push(rect(iu0, iu1, iv0, iv1), fill, 'projected');
      }
    }

    // The sill a window sits on, running a little past the reveal.
    if (!isDoor) {
      shapes.push({
        pts: [{ u: u0 - SILL_OVERHANG_MM, v: v0 }, { u: u1 + SILL_OVERHANG_MM, v: v0 }],
        closed: false, hatch: 'none', fillColor: 'none',
        strokeColor: line, lineWeight: 'medium-cut', depthMm,
        nodeId: op.node.id, nodeType: 'window',
      });
    }
  }
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
 * What the frame is being used for. A section and an elevation are the same
 * projection — a plane, a look direction, and everything in front of it — and
 * differ only in what that produces on paper:
 *
 *   section    the plane is inside the building, so elements straddle it and
 *              are CUT; what lies beyond is a thin outline over what's behind.
 *   elevation  the plane is outside the building, so nothing is cut and every
 *              face is SEEN: it needs a fill, and the openings drawn in it.
 */
interface DrawOpts {
  /** Give the seen (not cut) faces a face colour. */
  fillProjected?: boolean;
  /** The ground to draw under the building; the project's own when left out. */
  terrain?: TerrainModel | null;
  /** Draw the window and door leaves sitting in the wall openings. */
  openings?: boolean;
  /** Kernel linework to draw in place of the covered elements' outlines. */
  outlines?: KernelOutlines;
}

/** What a caller of the public entry points may add to a drawing. */
export interface DrawingOptions {
  outlines?: KernelOutlines;
}

/**
 * Every element the drawing knows about, projected through one frame.
 *
 * Elements CUT by the plane → heavy outline + hatch fill.
 * Elements VISIBLE in front of the plane, within `frame.depth` → thin outline.
 *
 * `elevMin`/`elevMax` may be infinite: the drawing then keeps whatever the
 * model reaches, which is what an elevation wants (a roof rises above the top
 * storey, a footing sits below the bottom one).
 */
function collectDrawing(
  rawNodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null,
  frame: CutFrame,
  elevMin: number,
  elevMax: number,
  opts: DrawOpts = {},
): DrawingResult {
  const nodes = expandArrayNodes(rawNodes);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  const roofTrims = collectRoofTrims(nodes, edges);
  const storeys = nodes.filter((n) => n.type === 'storey');

  const L = (p: { x: number; y: number }) => localOf(frame, p);
  /** A prism style, with the seen faces filled when the view asks for it. */
  const mk = (
    vis: MaterialVisuals, nodeId: string, nodeType: string, extra: Partial<PrismStyle> = {},
  ): PrismStyle => ({
    vis, nodeId, nodeType,
    ...(opts.fillProjected ? { projFill: viewFill(vis) } : {}),
    ...extra,
  });
  /** Is a frame-space footprint worth looking at (touches the plane or the depth band)? */
  const nearPlane = (fp: UD[]) => {
    const ys = fp.map((p) => p.y);
    return Math.max(...ys) >= -frame.depth - 1 && Math.min(...ys) <= 1;
  };

  const shapes: DrawingShape[] = [];
  const axes: DrawingAxis[] = [];
  const levels: DrawingLevel[] = [];

  // ── Levels ────────────────────────────────────────────────────────────────
  // Both faces of every storey, deduplicated: a storey top and the next
  // storey's bottom are usually the same height and must mark one line, but a
  // deliberate gap between them is two. Only the levels inside the view's
  // own vertical range: a section through the ground floor is not marked
  // with the roof level, or the sheet grows to hold a line nothing is
  // drawn at.
  {
    const seen = new Set<number>();
    for (const s of storeys) {
      for (const v of [Number(s.properties.bottomElevation ?? 0), Number(s.properties.topElevation ?? 3000)]) {
        if (!Number.isFinite(v) || seen.has(v)) continue;
        if (v < elevMin - 1 || v > elevMax + 1) continue;
        seen.add(v);
        levels.push({ vMm: v, label: `${v < 0 ? '−' : '+'}${(Math.abs(v) / 1000).toFixed(3)}` });
      }
    }
    levels.sort((a, b) => a.vMm - b.vMm);
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
      emitColumnPrism(shapes, frame, footprint, bot, top, mk(vis, n.id, 'column'), roofTrims, n);
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
      emitColumnPrism(shapes, frame, footprint, bot, top, mk(vis, n.id, 'column'), roofTrims, n);
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
      emitPrism(shapes, frame, poly, top - thickMm, top, mk(vis, n.id, 'slab', { cutWeight: 'medium-cut' }));
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
      emitPrism(shapes, frame, poly, top - thickMm, top, mk(vis, n.id, 'slab', { cutWeight: 'medium-cut' }));
    }
  }

  // ── Walls ────────────────────────────────────────────────────────────────
  for (const wn of nodes.filter((n) => n.type === 'wall')) {
    const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins);
    if (!geo) continue;
    const vis = getVis('wall', String(wn.properties.material ?? ''), matConfig, wn);

    const wallPlanes = planesOver(roofTrims, wn, geo.footprint);
    // Only consulted where a roof actually cuts, but resolved once per wall.
    const gable = gableSpec(wn, wallThicknessMm(wn));
    const gableVis = gable.distinct
      ? getVis('wall', gableMaterial(wn, gable), matConfig, wn)
      : vis;

    // How the wall is cut into pieces to draw.
    //
    // A SECTION draws the solid segments the wall geometry already carries:
    // the pier, the parapet under an opening, the lintel over it. Cut by the
    // plane, those are different bodies at different heights, and the gaps
    // between them are the openings.
    //
    // An ELEVATION wants the opposite. The same segments tile one flat face,
    // so drawing them separately paints a grid of seams across every wall —
    // and the openings are drawn over the top anyway. One silhouette instead.
    const runs: WallRun[] = opts.fillProjected
      ? [wholeWallRun(geo)]
      : geo.solidSegs.map((seg) => ({
        footprint: wallSegFootprint(seg),
        centre: wallSegCentre(seg),
        botMm: seg.baseY * 1000,
        topMm: (seg.baseY + seg.height) * 1000,
      }));

    for (const run of runs) {
      const footprint = run.footprint;
      if (footprint.length === 0) continue;
      if (!nearPlane(footprint.map(L))) continue;
      const segBotMm = run.botMm;
      const style = mk(vis, wn.id, 'wall');
      let segTopMm = run.topMm;

      if (wallPlanes.length > 0) {
        const centre = run.centre;
        // A wall set to attach grows to the roof first, then is cut back by it.
        if (attachesToRoof(wn)) {
          const reach = attachHeightAlong(wallPlanes, centre.a, centre.b);
          if (reach != null && reach > segTopMm) segTopMm = reach;
        }
        const top = trimmedTopAlong(wallPlanes, centre.a, centre.b, segTopMm);
        if (isTrimmed(top, segTopMm)) {
          if (gable.distinct) {
            // A separately built gable splits the run in two at the lowest
            // point of the cut: a plain box below in the wall's own material,
            // the folded triangle above in the gable's.
            const boxTopMm = Math.min(...top.flatMap((s) => [s.z0, s.z1]));
            if (boxTopMm > segBotMm + 1) {
              emitPrism(shapes, frame, footprint, segBotMm, boxTopMm, style);
            }
            const gfp = gable.reshaped ? gableFootprintMm(centre.a, centre.b, gable) : footprint;
            emitTrimmedPrism(
              shapes, frame, gfp, Math.max(segBotMm, boxTopMm), segTopMm,
              mk(gableVis, wn.id, 'wall'), wallPlanes, centre,
            );
            continue;
          }
          emitTrimmedPrism(shapes, frame, footprint, segBotMm, segTopMm, style, wallPlanes, centre);
          continue;
        }
      }
      emitPrism(shapes, frame, footprint, segBotMm, segTopMm, style);
    }

    // Beam on top of the wall: a prism along the wall's centre-line.
    if (geo.beamDesc) {
      const bd = geo.beamDesc;
      const footprint = lineFootprint(bd.ax * 1000, -bd.az * 1000, bd.bx * 1000, -bd.bz * 1000, bd.width * 1000);
      if (footprint.length && nearPlane(footprint.map(L))) {
        const bvis = getVis('beam', String(wn.properties.material ?? ''), matConfig, wn);
        emitPrism(shapes, frame, footprint, bd.baseY * 1000, (bd.baseY + bd.height) * 1000,
          mk(bvis, wn.id, 'beam', { cutWeight: 'medium-cut' }));
      }
    }

    // The openings themselves — once per wall, not once per solid segment.
    if (opts.openings) emitWallOpenings(shapes, frame, geo, matConfig);
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
      mk(bvis, bn.id, 'beam', { cutWeight: 'medium-cut' }));
  }

  // ── Sweep elements ─────────────────────────────────────────────────────
  // A segment crossing the plane draws the TRUE placed profile: the ring the
  // sweep would stamp at the crossing, mapped into the drawing. Whatever the
  // run's slope, the profile's own frame decides where its corners land — so a
  // raking cornice is cut as accurately as a level one. Anything the plane
  // misses falls back to the projected bbox, like beams.
  for (const sn of nodes.filter((nd) => nd.type === 'sweep')) {
    const res = computeSweep(sn, nodeMap, edges);
    if (!res.placed || !res.path) continue;
    const svis = getVis('sweep', String(sn.properties.material ?? ''), matConfig, sn);
    const placed = res.placed;
    let drewCut = false;

    {
      const pts = res.path.points;
      const segCount = res.path.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segCount; i++) {
        const A = pts[i], B = pts[(i + 1) % pts.length];
        const la = L(A), lb = L(B);
        if ((la.y > 0 && lb.y > 0) || (la.y <= 0 && lb.y <= 0)) continue;
        const dy = lb.y - la.y;
        if (Math.abs(dy) < 1e-6) continue;
        const t = (0 - la.y) / dy;
        // The station on the guide line, and the frame the profile stands in
        // there — the same pair `computeSweepSolids` uses to build the ring.
        const P = {
          x: A.x + (B.x - A.x) * t,
          y: A.y + (B.y - A.y) * t,
          z: A.z + (B.z - A.z) * t,
        };
        const dir = { x: B.x - A.x, y: B.y - A.y, z: B.z - A.z };
        const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
        const f = frameOf({ x: dir.x / len, y: dir.y / len, z: dir.z / len });
        shapes.push({
          pts: placed.map((p) => ({
            u: localOf(frame, {
              x: P.x + f.s.x * p.x + f.u.x * p.y,
              y: P.y + f.s.y * p.x + f.u.y * p.y,
            }).x,
            v: P.z + f.s.z * p.x + f.u.z * p.y,
          })),
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
          mk(svis, sn.id, 'sweep', { cutWeight: 'medium-cut' }));
      }
    }
  }

  // ── Sketches ───────────────────────────────────────────────────────────
  // Every array copy draws itself, so a stacked repeat reads as the several
  // bodies it is. An extrusion IS a prism between its own two elevations, so
  // this is exact for it; a sweep-along-path takes the same bbox fallback the
  // sweep element uses when the plane misses its segments.
  for (const sn of nodes.filter((nd) => nd.type === 'sketch')) {
    const res = computeSketch(sn, nodeMap, edges);
    if (res.solids.length === 0) continue;
    const kvis = getVis('sketch', String(sn.properties.material ?? ''), matConfig, sn);
    for (const copy of res.copies) {
      copy.footprint.forEach((fp, i) => {
        if (fp.length < 3 || !nearPlane(fp.map(L))) return;
        emitPrism(shapes, frame, fp, copy.zMinMm, copy.zMaxMm,
          mk(kvis, sn.id, 'sketch', { cutWeight: 'medium-cut' }), copy.footprintHoles[i] ?? []);
      });
    }
  }

  // ── Scatter: silhouettes ────────────────────────────────────────────────
  // Each tree, shrub and rock is drawn as the side-view outline of the body
  // the 3D viewers build (`scatterSilhouette`): an ellipse of canopy on a
  // tapered trunk, a squashed stone — never a prism, which from the side is
  // a box. Planting is not sectioned: one standing on the plane is drawn as
  // seen, the way an elevation draws it. Terrain-model items included.
  {
    const siteNode = terrainLib.findSiteNode(nodes);
    const site = siteNode ? terrainLib.computeSite(siteNode, nodeMap, edges, currentTerrainModelForScatter()) : null;
    const heightAt = site?.frame ? site.heightAtBim : null;
    const VIS_KEY: Record<SilhouetteBucket, string> = { foliage: 'scatter', wood: 'scatter_wood', stone: 'scatter_rock' };
    const emitInst = (inst: ScatterInstance[], id: string, node: BubbleGraphNode) => {
      const material = String(node.properties.material ?? '');
      for (const it of inst) {
        const c = L(it);
        const r = it.sizeMm / 2;
        const depth = -c.y;
        // Entirely in front of the viewer, or past the depth of the view.
        if (depth + r < -1 || depth - r > frame.depth + 1) continue;
        for (const part of scatterSilhouette(it)) {
          const vis = getVis(VIS_KEY[part.bucket], material, matConfig, node);
          shapes.push({
            pts: part.pts.map((p) => ({ u: c.x + p.du, v: it.z + p.dv })),
            closed: true,
            hatch: 'none',
            fillColor: opts.fillProjected ? viewFill(vis) : 'none',
            strokeColor: vis.view_line_color ?? vis.color_2d,
            lineWeight: 'projected',
            depthMm: Math.max(0, depth - r),
            nodeId: id, nodeType: 'scatter',
          });
        }
      }
    };
    for (const sn of nodes.filter((nd) => nd.type === 'scatter')) emitInst(computeScatter(sn, nodeMap, edges, heightAt).instances, sn.id, sn);
    if (site && siteNode) emitInst(terrainItemInstances(site), siteNode.id, siteNode);
  }

  // ── Facades ─────────────────────────────────────────────────────────────
  // In elevation every cell is drawn as the polygon it is — the pattern IS
  // the drawing. A face the plane cuts goes through emitPrism as a thin band
  // (its mullion depth) so the section shows the wall line.
  for (const fn of nodes.filter((nd) => nd.type === 'facade')) {
    const res = computeFacade(fn, nodeMap, edges);
    if (res.faces.length === 0) continue;
    const mvis = getVis('facade', String(fn.properties.material ?? ''), matConfig, fn);
    const gvis = getVis('facade_panel', res.intent.glassMaterial, matConfig, fn);
    const cvis = getVis('facade_cassette', res.intent.panelMaterial, matConfig, fn);
    const d = res.intent.mullionDMm;
    for (const f of res.faces) {
      const band = [f.a, f.b, { x: f.b.x + f.n.x * d, y: f.b.y + f.n.y * d }, { x: f.a.x + f.n.x * d, y: f.a.y + f.n.y * d }];
      if (nearPlane(band.map(L))) emitPrism(shapes, frame, band, f.z0, f.z1, mk(mvis, fn.id, 'facade', { cutWeight: 'medium-cut' }));
    }
    const glassIdx = new Set(res.glassPanels.map((p) => p.cell));
    res.cells.forEach((c, ci) => {
      const loc = c.outline.map((p) => localOf(frame, { x: p.x, y: p.y }));
      const depth = -Math.max(...loc.map((q) => q.y));
      if (depth < -1 || depth > frame.depth + 1) return;
      // Only a face looking at the viewer shows its cells; a face seen from
      // behind is hidden by the body in front of it.
      const face = res.faces[c.face];
      const facing = -(face.n.x * frame.nx + face.n.y * frame.ny);
      if (facing <= 0) return;
      const glass = glassIdx.has(ci);
      const vis = glass ? gvis : cvis;
      shapes.push({
        pts: c.outline.map((p, i) => ({ u: loc[i].x, v: p.z })),
        closed: true,
        hatch: 'none',
        fillColor: vis.section_fill_color ?? vis.color_2d,
        strokeColor: mvis.view_line_color ?? mvis.color_2d,
        lineWeight: 'projected',
        depthMm: Math.max(0, depth),
        nodeId: fn.id, nodeType: 'facade',
      });
    });
  }

  // ── Domes ───────────────────────────────────────────────────────────────
  // The half of the shell that faces the viewer, panel by panel and rib by
  // rib, culled on the surface normal: a far rib seen through a near panel
  // is simply not drawn, whether or not the panel is filled — which is what
  // the painter's sort cannot decide for a shell, where near and far panels
  // sit at the same depth along the rim. Where the plane cuts the shell, a
  // rib leaves its cross-section and a panel the chord of glass it is cut to;
  // what stands beyond the plane is drawn as seen, clipped to it.
  for (const dn of nodes.filter((nd) => nd.type === 'dome')) {
    const res = computeDome(dn, nodeMap, edges);
    if (!res.placed || res.panels.length === 0) continue;
    const rvis = getVis('dome', res.intent.material, matConfig, dn);
    const gvis = getVis('dome_panel', res.intent.glassMaterial, matConfig, dn);
    const rib = domeRibSize(res);
    const facing = (n: { x: number; y: number }) => -(n.x * frame.nx + n.y * frame.ny);
    // Frame space with the elevation kept: x across, y = depth beyond the plane, v up.
    type Q = { x: number; y: number; v: number };
    const Q = (p: { x: number; y: number; z: number }): Q => { const l = L(p); return { x: l.x, y: -l.y, v: p.z }; };
    const lerpQ = (a: Q, b: Q, t: number): Q => ({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), v: a.v + t * (b.v - a.v) });
    const inView = (qs: Q[]) => qs.some((q) => q.y >= -1) && qs.some((q) => q.y <= frame.depth + 1);
    const line = (a: Q, b: Q, vis: MaterialVisuals, weight: LineWeight, depthMm: number): DrawingShape => ({
      pts: [{ u: a.x, v: a.v }, { u: b.x, v: b.v }], closed: false, hatch: 'none', fillColor: 'none',
      strokeColor: (weight === 'projected' ? vis.view_line_color : vis.section_line_color) ?? vis.color_2d,
      lineWeight: weight, depthMm, nodeId: dn.id, nodeType: 'dome',
    });

    // Does the plane cut the shell? Then what stands beyond it is seen from
    // INSIDE — the near half is gone — and no face is culled: a convex shell
    // cut open hides nothing of itself. A shell entirely beyond the plane is
    // seen from outside, and its far half is behind its near half.
    const depths = res.panels.flatMap((p) => p.outline.map((v) => -L(v).y));
    const cutOpen = depths.some((d) => d < -1) && depths.some((d) => d > 1);
    const seen = (n: { x: number; y: number }) => cutOpen || facing(n) > 0;

    // The shell's own silhouette, under the panels: the planar panels of a
    // curved surface do not quite meet in projection, and the hull of the
    // rib stations closes those slivers with the same glass. Only for a
    // dome on its own — a cluster's hull would bridge the saddle between
    // two bubbles.
    if (res.clusteredWith.length === 0) {
      const stations: { u: number; v: number }[] = [];
      let far = 0;
      for (const m of res.members) {
        for (let i = 0; i + 1 < m.points.length; i++) {
          let a = Q(m.points[i]), b = Q(m.points[i + 1]);
          if (a.y < 0 && b.y < 0) continue;
          if (a.y < 0 || b.y < 0) {
            const cut = lerpQ(a, b, a.y / (a.y - b.y));
            if (a.y < 0) a = cut; else b = cut;
          }
          stations.push({ u: a.x, v: a.v }, { u: b.x, v: b.v });
          far = Math.max(far, a.y, b.y);
        }
      }
      const hull = convexHull(stations);
      if (hull.length >= 3 && far <= frame.depth + 1) {
        shapes.push({
          pts: hull, closed: true, hatch: 'none',
          fillColor: opts.fillProjected ? viewFill(gvis) : 'none',
          strokeColor: gvis.view_line_color ?? gvis.color_2d,
          lineWeight: 'projected', depthMm: far, nodeId: dn.id, nodeType: 'dome',
        });
      }
    }

    for (const panel of res.panels) {
      if (!seen(panel.normal)) continue;
      const qs = panel.outline.map(Q);
      if (!inView(qs)) continue;
      const kept = clipPolygonY(qs, 0, false, lerpQ);
      if (kept.length < 3) continue;
      const depth = kept.reduce((s, q) => s + q.y, 0) / kept.length;
      shapes.push({
        pts: kept.map((q) => ({ u: q.x, v: q.v })), closed: true, hatch: 'none',
        fillColor: opts.fillProjected ? viewFill(gvis) : 'none',
        strokeColor: gvis.view_line_color ?? gvis.color_2d,
        lineWeight: 'projected', depthMm: Math.max(0, depth), nodeId: dn.id, nodeType: 'dome',
      });
      // The chord the plane cuts through the glass.
      const onPlane = kept.filter((q) => Math.abs(q.y) < 1e-3);
      if (onPlane.length >= 2) shapes.push(line(onPlane[0], onPlane[onPlane.length - 1], gvis, 'heavy-cut', 0));
    }

    for (const m of res.members) {
      for (let i = 0; i + 1 < m.points.length; i++) {
        const na = m.normals[i] ?? m.normals[0], nb = m.normals[i + 1] ?? na;
        if (!na || !seen({ x: (na.x + nb.x) / 2, y: (na.y + nb.y) / 2 })) continue;
        let a = Q(m.points[i]), b = Q(m.points[i + 1]);
        if ((a.y < 0 && b.y < 0) || (a.y > frame.depth + 1 && b.y > frame.depth + 1)) continue;
        if (a.y < 0 || b.y < 0) {
          const cut = lerpQ(a, b, a.y / (a.y - b.y));
          shapes.push({
            pts: rect(cut.x - rib.w / 2, cut.x + rib.w / 2, cut.v - rib.h / 2, cut.v + rib.h / 2), closed: true,
            hatch: rvis.hatch, fillColor: rvis.section_fill_color ?? rvis.color_2d,
            strokeColor: rvis.section_line_color ?? rvis.color_2d,
            lineWeight: 'heavy-cut', depthMm: 0, nodeId: dn.id, nodeType: 'dome',
          });
          if (a.y < 0) a = cut; else b = cut;
        }
        shapes.push(line(a, b, rvis, 'projected', Math.max(0, Math.min(a.y, b.y))));
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
      mk(fvis, n.id, 'foundation', { projWeight: 'hidden', projFill: undefined }));
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
        closed: true, hatch: 'none',
        fillColor: opts.fillProjected ? viewFill(rvis) : 'none',
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
    const seenFill = opts.fillProjected ? viewFill(svis) : 'none';
    if (profile && Math.abs(along) > 0.05) {
      shapes.push({
        pts: profile.map((q) => ({ u: la.x + q.x * along, v: a.z + q.y })),
        closed: true, hatch: 'none', fillColor: seenFill,
        strokeColor: svis.view_line_color ?? svis.color_2d,
        lineWeight: 'projected', depthMm: Math.max(0, dMin),
        nodeId: fn.id, nodeType: 'stair_flight',
      });
    } else {
      const us = front.map((q) => q.x);
      shapes.push({
        pts: rect(Math.min(...us), Math.max(...us), Math.min(a.z, b.z) - thickMm, Math.max(a.z, b.z) + riserMm),
        closed: true, hatch: 'none', fillColor: seenFill,
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
      mk(vis, n.id, n.type, { cutWeight: 'medium-cut' }));
  }

  // ── The ground ─────────────────────────────────────────────────────────
  // A section shows the terrain where the plane cuts it; an elevation shows
  // its silhouette — the highest ground at each u across the whole depth,
  // which is what stands between the viewer and the facade. Drawn as a line:
  // it says where the ground is, and it does not yet hide what is behind it.
  {
    const siteNode = findSiteNode(nodes);
    if (siteNode) {
      const site = computeSite(siteNode, nodeMap, edges, opts.terrain ?? currentTerrainModel());
      if (site.frame && site.boundsMm) {
        let u0 = Infinity, u1 = -Infinity;
        for (const sh of shapes) for (const p of sh.pts) { if (p.u < u0) u0 = p.u; if (p.u > u1) u1 = p.u; }
        if (frame.clip) { u0 = Math.min(u0, 0); u1 = Math.max(u1, frame.lengthMm); }
        if (Number.isFinite(u0) && Number.isFinite(u1)) {
          const pad = 5000;
          u0 -= pad; u1 += pad;
          const cellMm = (site.model.sizeM / site.model.subdivisions) * 1000;
          const step = Math.max(200, cellMm / 2);
          const elevation = !Number.isFinite(frame.depth);
          const reachMm = elevation ? 300000 : 0;
          const at = (u: number, d: number) => ({ x: frame.ax + u * frame.tx + d * frame.nx, y: frame.ay + u * frame.ty + d * frame.ny });
          const pts: { u: number; v: number }[] = [];
          let run: { u: number; v: number }[] = [];
          const flush = () => { if (run.length >= 2) pts.push(...run, { u: NaN, v: NaN }); run = []; };
          for (let u = u0; u <= u1 + 1e-6; u += step) {
            let z: number | null = null;
            if (elevation) {
              for (let d = 0; d <= reachMm; d += cellMm) {
                const p = at(u, d);
                const h = site.heightAtBim(p.x, p.y);
                if (h !== null && (z === null || h > z)) z = h;
              }
            } else {
              const p = at(u, 0);
              z = site.heightAtBim(p.x, p.y);
            }
            if (z === null) { flush(); continue; }
            run.push({ u, v: z });
          }
          flush();
          const svis = getVis('site', String(siteNode.properties.material ?? ''), matConfig, siteNode);
          let seg: { u: number; v: number }[] = [];
          for (const p of pts) {
            if (Number.isNaN(p.u)) {
              if (seg.length >= 2) shapes.push({
                pts: seg, closed: false, hatch: 'none', fillColor: 'none',
                strokeColor: svis.section_line_color ?? svis.color_2d,
                lineWeight: 'heavy-cut', depthMm: 0, nodeId: siteNode.id, nodeType: 'site',
              });
              seg = [];
            } else seg.push(p);
          }
        }
      }
    }
  }

  // ── Kernel outlines ───────────────────────────────────────────────────
  // The engine draws a seen prism as its bounding RECTANGLE; the kernel knows
  // the real silhouette, openings and all. So for the elements it covers, the
  // rectangle keeps its face colour — the fill is what hides whatever is
  // behind it, and that must not change — and loses only its stroke, which
  // the kernel's lines replace. A section fills nothing, so its rectangle
  // goes entirely. The cut is not touched: it was never the kernel's.
  //
  // The lines carry their own element's depth, so the painter's sort below
  // interleaves them with the fills exactly as the rectangles were. They go
  // in before the clip, so the marker's box cuts them like everything else.
  let drawn: DrawingShape[] = shapes;
  if (opts.outlines) {
    const { covered } = opts.outlines;
    drawn = [];
    for (const sh of shapes) {
      if (sh.lineWeight !== 'projected' || !sh.closed || !covered.has(sh.nodeId)) { drawn.push(sh); continue; }
      // A face with a colour of its own keeps it and loses only its stroke:
      // the glass of a window seen in a section is a fill the kernel's lines
      // do not replace, and without it the frame reads as a black board.
      if (sh.fillColor && sh.fillColor !== 'none') drawn.push({ ...sh, strokeColor: 'none' });
    }
    for (const sh of opts.outlines.shapes) drawn.push(sh);
  }

  // ── Horizontal and vertical range ──────────────────────────────────────
  // ArchiCAD clips the section to the marker's length and to its vertical
  // range; so do we, splitting polylines where they leave the box.
  const uLo = frame.clip ? 0 : -Infinity;
  const uHi = frame.clip ? frame.lengthMm : Infinity;
  const clipped: DrawingShape[] = [];
  for (const sh of drawn) {
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


// ─── Public entry points ──────────────────────────────────────────────────────

/**
 * A vertical section cut. See `SectionCut` for the marker model; every element
 * is mapped through the marker's local frame, so an oblique marker works
 * exactly like an orthogonal one.
 */
export function computeSectionView(
  rawNodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null,
  cut: SectionCut,
  options: DrawingOptions = {},
): DrawingResult {
  return collectDrawing(
    rawNodes, edges, matConfig, buildFrame(cut),
    cut.elevMin ?? -Infinity, cut.elevMax ?? Infinity,
    // A section draws the joinery too: cut through where the plane passes
    // through it, seen in the wall beyond where it does not. A blank rectangle
    // where a window should be is the commonest thing missing from a section.
    { openings: true, outlines: options.outlines },
  );
}

/**
 * The cut an external elevation is: a plane pushed out past everything on
 * the side it looks from, looking in, with no depth limit. One definition so
 * the engine and the kernel projection see the same plane.
 */
export function elevationCut(
  rawNodes: BubbleGraphNode[],
  dir: ElevationDir,
  elevMin?: number,
  elevMax?: number,
): SectionCut {
  const R = modelReach(rawNodes);
  const line = {
    N: { x1: 0, y1: -R, x2: 1, y2: -R },
    S: { x1: 0, y1: R, x2: -1, y2: R },
    E: { x1: R, y1: 0, x2: R, y2: 1 },
    W: { x1: -R, y1: 0, x2: -R, y2: -1 },
  }[dir];
  return { line, lookSide: 'left', cutDepth: Infinity, elevMin, elevMax };
}

/**
 * How far out the elevation plane is pushed so that nothing in the model
 * straddles it. 100 m clear of the furthest thing the graph places.
 */
function modelReach(nodes: BubbleGraphNode[]): number {
  let m = 10000;
  const bump = (v: unknown) => {
    const n = Number(v);
    if (Number.isFinite(n)) m = Math.max(m, Math.abs(n));
  };
  for (const n of nodes) {
    bump(n.x); bump(n.y);
    if (n.type === 'storey') {
      for (const v of parseAxes(n.properties.axesX)) bump(v);
      for (const v of parseAxes(n.properties.axesY)) bump(v);
    }
  }
  return m + 100000;
}

/**
 * An elevation is a section whose plane has been pushed outside the building:
 * nothing straddles it, so every element is SEEN rather than cut, and the
 * depth is unlimited so the whole facade — and everything standing behind it —
 * reaches the drawing.
 *
 * The four directions are four frames. Handedness and the axis grid then come
 * out of the shared frame maths rather than a second set of sign rules:
 *
 *   'N'  looking north (+Y):  u = BIM X    (east on the right)
 *   'S'  looking south (−Y):  u = −BIM X
 *   'E'  looking west  (−X):  u = BIM Y
 *   'W'  looking east  (+X):  u = −BIM Y
 *
 * `elevMin` / `elevMax` are limits, not the frame: left out, the drawing keeps
 * whatever the model reaches, which is what a facade wants — a roof rises past
 * the top storey and a footing sits below the bottom one.
 */
export function computeElevationView(
  rawNodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null,
  dir: ElevationDir,
  elevMin?: number,
  elevMax?: number,
  options: DrawingOptions = {},
): DrawingResult {
  const frame = buildFrame(elevationCut(rawNodes, dir));
  return collectDrawing(
    rawNodes, edges, matConfig, frame,
    elevMin ?? -Infinity, elevMax ?? Infinity,
    { fillProjected: true, openings: true, outlines: options.outlines },
  );
}
