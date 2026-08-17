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
 *   - computeSectionView   (vertical cut at Y = cutY mm)
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
  MM,
} from '@/lib/bimGeometry';
import { expandArrayNodes } from '@/lib/formulaUtils';
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

export interface SectionCut {
  /** BIM Y coordinate of the cut plane (mm) */
  cutY: number;
  /** How deep behind the cut plane to show projections (mm). Default 6000. */
  cutDepth: number;
  /** Bottom elevation limit (mm) */
  elevMin: number;
  /** Top elevation limit (mm) */
  elevMax: number;
}

export type ElevationDir = 'N' | 'S' | 'E' | 'W';

// ─── Internal helpers ─────────────────────────────────────────────────────────

const DEF_COLORS = {
  cut_fill:   '#D4C5B2',
  cut_stroke: '#1E293B',
  proj_fill:  'none',
  proj_stroke:'#64748B',
};

/**
 * Clip a convex polygon to the half-plane (bimY <= planeY) or (bimY >= planeY).
 * Uses the Sutherland–Hodgman algorithm in Y.
 * Returns an empty array when the polygon is entirely outside.
 *
 * @param pts   polygon corners (bimX, bimY) in mm
 * @param planeY   cut Y value
 * @param keepBelow  true → keep side where bimY <= planeY
 */
function clipPolygonY(
  pts: { x: number; y: number }[],
  planeY: number,
  keepBelow: boolean,
): { x: number; y: number }[] {
  if (pts.length === 0) return [];
  const inside = (p: { x: number; y: number }) =>
    keepBelow ? p.y <= planeY : p.y >= planeY;

  let output = pts;
  const input = [...output, output[0]]; // close polygon
  output = [];

  for (let i = 0; i < input.length - 1; i++) {
    const S = input[i], E = input[i + 1];
    const sIn = inside(S), eIn = inside(E);
    if (sIn) {
      output.push(S);
      if (!eIn) {
        // S inside, E outside → compute intersection
        const t = (planeY - S.y) / (E.y - S.y);
        output.push({ x: S.x + t * (E.x - S.x), y: planeY });
      }
    } else if (eIn) {
      // S outside, E inside → compute intersection
      const t = (planeY - S.y) / (E.y - S.y);
      output.push({ x: S.x + t * (E.x - S.x), y: planeY });
    }
  }
  return output;
}

/**
 * Build the footprint polygon (BIM mm) of a wall solid segment.
 *
 * WallSegDesc stores positions in Three.js metres (ax, az, bx, bz) where:
 *   ax = bimX * MM, az = -bimY * MM, bx = bimX * MM, bz = -bimY * MM
 *
 * We recover BIM mm and produce the 4-corner footprint in plan.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ The wall direction unit vector (ux,uy) is computed from (ax,az)  │
 * │ → (bx,bz), then perpendicular nx=−uz, nz=ux gives wall sides.   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Returns 4 corners in BIM mm: (x=east, y=north)
 */
function wallSegFootprint(seg: {
  ax: number; az: number; bx: number; bz: number;
  tStart: number; tEnd: number;
  width: number; // metres
}): { x: number; y: number }[] {
  // Convert Three.js metres → BIM mm
  // Three.js: ax=bimX*MM, az=-bimY*MM  →  bimX=ax/MM, bimY=-az/MM
  const sx = seg.ax * 1000;       // BIM X mm (start, before tStart offset)
  const sy = -seg.az * 1000;      // BIM Y mm (start)
  const ex = seg.bx * 1000;       // BIM X mm (end, before tEnd offset)
  const ey = -seg.bz * 1000;      // BIM Y mm (end)

  const wallDx = ex - sx; const wallDy = ey - sy;
  const wallLen = Math.sqrt(wallDx * wallDx + wallDy * wallDy);
  if (wallLen < 1e-3) return [];

  const ux = wallDx / wallLen; const uy = wallDy / wallLen;
  // Perpendicular — left-hand normal
  const nx = -uy; const ny = ux;

  const hw = (seg.width * 1000) / 2; // half thickness in mm

  // tStart / tEnd are in metres along the wall centre-line
  const sOff = seg.tStart * 1000; // mm from wall start
  const eOff = seg.tEnd   * 1000;

  const pSx = sx + ux * sOff; const pSy = sy + uy * sOff;
  const pEx = sx + ux * eOff; const pEy = sy + uy * eOff;

  return [
    { x: pSx + nx * hw, y: pSy + ny * hw }, // front-start
    { x: pEx + nx * hw, y: pEy + ny * hw }, // front-end
    { x: pEx - nx * hw, y: pEy - ny * hw }, // back-end
    { x: pSx - nx * hw, y: pSy - ny * hw }, // back-start
  ];
}

/**
 * Project a footprint polygon onto a vertical section plane (cutY).
 *
 * Returns { uMin, uMax, depthMin, depthMax } in BIM mm, or null if the polygon
 * does not cross the cut plane at all.
 *
 * For a section looking in the +Y direction (standard):
 *   u = BIM X (horizontal axis in the drawing)
 *   depth = distance from the cut plane in BIM Y
 */
function projectFootprintOnSection(
  footprint: { x: number; y: number }[],
  cutY: number,
): { uMin: number; uMax: number; depthMin: number; depthMax: number } | null {
  if (footprint.length === 0) return null;
  // Find the Y-range of the footprint
  const ys = footprint.map((p) => p.y);
  const fpYmin = Math.min(...ys); const fpYmax = Math.max(...ys);

  if (fpYmax < cutY || fpYmin > cutY) return null; // doesn't cross the cut

  // Clip polygon to Y >= cutY (the side behind the section cut = visible)
  // No — we want the X extent at exactly Y=cutY, so we compute the X crossings
  // at the cut line.
  const xCrossings: number[] = [];
  for (let i = 0; i < footprint.length; i++) {
    const A = footprint[i], B = footprint[(i + 1) % footprint.length];
    const aY = A.y, bY = B.y;
    if ((aY <= cutY && bY > cutY) || (bY <= cutY && aY > cutY) ||
        Math.abs(aY - cutY) < 0.01) {
      const t = Math.abs(bY - aY) < 0.01 ? 0 : (cutY - aY) / (bY - aY);
      xCrossings.push(A.x + t * (B.x - A.x));
    }
  }
  // Also consider vertices that are exactly on the cut plane
  footprint.forEach((p) => { if (Math.abs(p.y - cutY) < 0.5) xCrossings.push(p.x); });

  if (xCrossings.length < 2) return null;

  const uMin = Math.min(...xCrossings);
  const uMax = Math.max(...xCrossings);

  // Depth = distance of footprint from cut plane
  const depthMin = Math.min(...ys.map((y) => Math.abs(y - cutY)));
  const depthMax = Math.max(...ys.map((y) => Math.abs(y - cutY)));

  return { uMin, uMax, depthMin, depthMax };
}

/**
 * Does a footprint polygon straddle the cut plane (meaning the element is CUT)?
 * A footprint straddles if it has vertices on both sides of the plane.
 */
function footprintStraddlesCut(
  footprint: { x: number; y: number }[],
  cutY: number,
  tol = 10, // mm tolerance for "exactly at" cut
): boolean {
  let hasAbove = false, hasBelow = false;
  for (const p of footprint) {
    if (p.y < cutY - tol) hasBelow = true;
    if (p.y > cutY + tol) hasAbove = true;
  }
  return hasAbove && hasBelow;
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

function hexToSvgColor(hex: string): string { return hex; }

// ─── Section view computation ─────────────────────────────────────────────────

/**
 * Compute all drawing shapes for a vertical section cut.
 *
 * The section plane is Y = cutY (BIM North mm).
 * Looking direction: +Y (North), so the drawing shows:
 *   U = BIM X (East), V = BIM Z (elevation, up).
 *
 * Elements CUT by the plane (footprint straddles cutY) → heavy outline + hatch fill
 * Elements VISIBLE behind the plane (between cutY and cutY−cutDepth) → thin projected outline
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

  const { cutY, cutDepth, elevMin, elevMax } = cut;
  const cutMin = cutY - cutDepth; // furthest visible Y (behind cut)
  const cutMax = cutY;

  const shapes: DrawingShape[] = [];
  const axes: DrawingAxis[] = [];
  const levels: DrawingLevel[] = [];

  // ── Elevation grid lines + levels ─────────────────────────────────────────
  const processedStoreyIds = new Set<string>();
  for (const s of storeys) {
    const bot = Number(s.properties.bottomElevation ?? 0);
    const top = Number(s.properties.topElevation ?? 3000);
    levels.push({ vMm: bot, label: `+${(bot / 1000).toFixed(3)}` });
    if (!processedStoreyIds.has(s.id)) {
      processedStoreyIds.add(s.id);
    }
  }
  // Deduplicate levels
  const topLevel = Math.max(...storeys.map((s) => Number(s.properties.topElevation ?? 3000)));
  levels.push({ vMm: topLevel, label: `+${(topLevel / 1000).toFixed(3)}` });

  // ── Axis grid lines (X axes visible in section) ───────────────────────────
  const seenAxX = new Set<number>();
  for (const s of storeys) {
    const axX = parseAxes(s.properties.axesX).sort((a, b) => a - b);
    axX.forEach((x, i) => {
      if (!seenAxX.has(x)) {
        seenAxX.add(x);
        axes.push({ u: x, label: String(i + 1), kind: 'X' });
      }
    });
    break; // global axes from first storey
  }

  // ── Process each storey ────────────────────────────────────────────────────
  for (const s of storeys) {
    const bot = Number(s.properties.bottomElevation ?? 0);
    const top = Number(s.properties.topElevation ?? 3000);
    if (bot > elevMax || top < elevMin) continue;

    // ── Columns from ax nodes ────────────────────────────────────────────
    for (const n of nodes.filter((nd) => nd.type === 'ax' && nd.parentId === s.id)) {
      if (String(n.properties.has_column ?? '').toLowerCase() !== 'true') continue;

      const { x: bimX, y: bimY } = getAxRealPos(n, nodeMap);
      if (bimY < cutMin - 1000 || bimY > cutMax + 1000) continue; // too far

      const { w, d } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
      const wMm = w * 1000; const dMm = d * 1000;

      // Footprint: square centered at (bimX, bimY)
      const footprint = [
        { x: bimX - wMm / 2, y: bimY - dMm / 2 },
        { x: bimX + wMm / 2, y: bimY - dMm / 2 },
        { x: bimX + wMm / 2, y: bimY + dMm / 2 },
        { x: bimX - wMm / 2, y: bimY + dMm / 2 },
      ];

      const proj = projectFootprintOnSection(footprint, cutY);
      if (!proj) continue;
      const isCut = footprintStraddlesCut(footprint, cutY);
      const inProjectionRange = bimY >= cutMin - 10;

      if (!isCut && !inProjectionRange) continue;

      const vis = getVis('column', String(n.properties.material ?? ''), matConfig, n);
      const colH = top - bot;

      const pts = [
        { u: proj.uMin, v: bot },
        { u: proj.uMax, v: bot },
        { u: proj.uMax, v: bot + colH },
        { u: proj.uMin, v: bot + colH },
      ];

      shapes.push({
        pts, closed: true,
        hatch: isCut ? vis.hatch : 'none',
        fillColor: isCut ? (vis.section_fill_color ?? vis.color_2d) : 'none',
        strokeColor: isCut ? (vis.section_line_color ?? vis.color_2d) : vis.color_2d,
        lineWeight: isCut ? 'heavy-cut' : 'projected',
        depthMm: Math.abs(bimY - cutY),
        nodeId: n.id, nodeType: 'column',
      });
    }

    // ── Standalone column nodes ──────────────────────────────────────────
    for (const n of nodes.filter((nd) => nd.type === 'column' && nd.parentId === s.id)) {
      const bimX = n.x; const bimY = n.y;
      if (bimY < cutMin - 1000 || bimY > cutMax + 1000) continue;

      const { w, d } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
      const wMm = w * 1000; const dMm = d * 1000;
      const footprint = [
        { x: bimX - wMm / 2, y: bimY - dMm / 2 },
        { x: bimX + wMm / 2, y: bimY - dMm / 2 },
        { x: bimX + wMm / 2, y: bimY + dMm / 2 },
        { x: bimX - wMm / 2, y: bimY + dMm / 2 },
      ];
      const proj = projectFootprintOnSection(footprint, cutY);
      if (!proj) continue;
      const isCut = footprintStraddlesCut(footprint, cutY);
      if (!isCut && bimY < cutMin) continue;

      const vis = getVis('column', String(n.properties.material ?? ''), matConfig, n);
      const colH = top - bot;
      shapes.push({
        pts: [
          { u: proj.uMin, v: bot },
          { u: proj.uMax, v: bot },
          { u: proj.uMax, v: bot + colH },
          { u: proj.uMin, v: bot + colH },
        ],
        closed: true,
        hatch: isCut ? vis.hatch : 'none',
        fillColor: isCut ? (vis.section_fill_color ?? vis.color_2d) : 'none',
        strokeColor: isCut ? (vis.section_line_color ?? vis.color_2d) : vis.color_2d,
        lineWeight: isCut ? 'heavy-cut' : 'projected',
        depthMm: Math.abs(bimY - cutY),
        nodeId: n.id, nodeType: 'column',
      });
    }

    // ── Slabs ────────────────────────────────────────────────────────────
    for (const n of nodes.filter((nd) => nd.type === 'slab' && nd.parentId === s.id)) {
      const thickMm = getNodeSlabThickness(n) * 1000;
      const slabTop = top;       // slab sits at storey top
      const slabBot = top - thickMm;

      const vis = getVis('slab', String(n.properties.material ?? ''), matConfig, n);

      // Slab spans across X axes
      const axX = parseAxes(s.properties.axesX).sort((a, b) => a - b);
      const slabMinX = axX.length > 0 ? axX[0] - 500 : -5000;
      const slabMaxX = axX.length > 0 ? axX[axX.length - 1] + 500 : 5000;

      shapes.push({
        pts: [
          { u: slabMinX, v: slabBot },
          { u: slabMaxX, v: slabBot },
          { u: slabMaxX, v: slabTop },
          { u: slabMinX, v: slabTop },
        ],
        closed: true,
        hatch: vis.hatch,
        fillColor: vis.section_fill_color ?? vis.color_2d,
        strokeColor: vis.section_line_color ?? vis.color_2d,
        lineWeight: 'medium-cut',
        depthMm: 0, // slab at cut plane
        nodeId: n.id, nodeType: 'slab',
      });
    }
  }

  // ── Walls ────────────────────────────────────────────────────────────────
  for (const wn of nodes.filter((n) => n.type === 'wall')) {
    const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins);
    if (!geo) continue;

    const { bot } = getStoreyBand(wn, nodeMap);
    const wallH = Number(wn.properties.height ?? 3000);
    const wallTop = bot + wallH;

    const vis = getVis('wall', String(wn.properties.material ?? ''), matConfig, wn);

    for (const seg of geo.solidSegs) {
      const footprint = wallSegFootprint(seg);
      if (footprint.length === 0) continue;

      // Check if footprint is in view range
      const fpYs = footprint.map((p) => p.y);
      const fpYmin = Math.min(...fpYs); const fpYmax = Math.max(...fpYs);
      if (fpYmax < cutMin - 10 || fpYmin > cutMax + 10) continue;

      const isCut = footprintStraddlesCut(footprint, cutY);
      const inRange = fpYmax >= cutMin && fpYmin <= cutMax;
      if (!isCut && !inRange) continue;

      const proj = projectFootprintOnSection(footprint, cutY);
      // For projected (non-cut) walls we use the mid-Y of footprint as approximate u range
      let uMin: number, uMax: number, depthMm: number;
      if (proj) {
        uMin = proj.uMin; uMax = proj.uMax;
        depthMm = proj.depthMin;
      } else if (!isCut) {
        // Projected — no direct intersection with cut, show full X extent behind it
        const fpXs = footprint.map((p) => p.x);
        uMin = Math.min(...fpXs); uMax = Math.max(...fpXs);
        depthMm = Math.min(...fpYs.map((y) => Math.abs(y - cutY)));
      } else {
        continue;
      }

      // Wall segment elevation: use tStart/tEnd for height within the wall
      const segBotM = seg.baseY;         // Three.js metres (Y = up)
      const segTopM = seg.baseY + seg.height;
      const segBotMm = segBotM * 1000;   // → BIM mm elevation
      const segTopMm = segTopM * 1000;

      shapes.push({
        pts: [
          { u: uMin, v: segBotMm },
          { u: uMax, v: segBotMm },
          { u: uMax, v: segTopMm },
          { u: uMin, v: segTopMm },
        ],
        closed: true,
        hatch: isCut ? vis.hatch : 'none',
        fillColor: isCut ? (vis.section_fill_color ?? vis.color_2d) : 'none',
        strokeColor: isCut
          ? (vis.section_line_color ?? vis.color_2d)
          : (vis.view_line_color ?? vis.color_2d),
        lineWeight: isCut ? 'heavy-cut' : 'projected',
        depthMm,
        nodeId: wn.id, nodeType: 'wall',
      });
    }

    // ── Beam on top of wall ────────────────────────────────────────────
    if (geo.beamDesc) {
      const bd = geo.beamDesc;
      const footprint = [
        { x: bd.ax * 1000, y: -bd.az * 1000 },
        { x: bd.bx * 1000, y: -bd.bz * 1000 },
        { x: bd.bx * 1000, y: -bd.bz * 1000 },
        { x: bd.ax * 1000, y: -bd.az * 1000 },
      ];
      // For beams we approximate with the wall mid-Y
      const midY = (-geo.szM * 1000 + -geo.ezM * 1000) / 2;
      if (midY >= cutMin - 10 && midY <= cutMax + 10) {
        const isCut = Math.abs(midY - cutY) < 300;
        const bvis = getVis('beam', String(wn.properties.material ?? ''), matConfig, wn);
        const bBotMm = bd.baseY * 1000;
        const bTopMm = (bd.baseY + bd.height) * 1000;
        const sxMm = bd.ax * 1000; const exMm = bd.bx * 1000;
        const hw = (bd.width * 1000) / 2;
        shapes.push({
          pts: [
            { u: Math.min(sxMm, exMm), v: bBotMm },
            { u: Math.max(sxMm, exMm), v: bBotMm },
            { u: Math.max(sxMm, exMm), v: bTopMm },
            { u: Math.min(sxMm, exMm), v: bTopMm },
          ],
          closed: true,
          hatch: isCut ? bvis.hatch : 'none',
          fillColor: isCut ? (bvis.section_fill_color ?? bvis.color_2d) : 'none',
          strokeColor: isCut ? (bvis.section_line_color ?? bvis.color_2d) : bvis.color_2d,
          lineWeight: isCut ? 'medium-cut' : 'projected',
          depthMm: Math.abs(midY - cutY),
          nodeId: wn.id, nodeType: 'beam',
        });
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
    const midY = (sy + ey) / 2;
    if (midY < cutMin - 1000 || midY > cutMax + 1000) continue;

    const { top } = getStoreyBand(bn, nodeMap);
    const { bw, bh } = parseBeamDims(String(bn.properties.beam_section ?? bn.properties.beam_type ?? 'B30x60'));
    const bBotMm = top - bh * 1000;
    const bTopMm = top;

    const isCut = Math.abs(midY - cutY) < 300;
    const bvis = getVis('beam', String(bn.properties.material ?? ''), matConfig, bn);

    shapes.push({
      pts: [
        { u: Math.min(sx, ex), v: bBotMm },
        { u: Math.max(sx, ex), v: bBotMm },
        { u: Math.max(sx, ex), v: bTopMm },
        { u: Math.min(sx, ex), v: bTopMm },
      ],
      closed: true,
      hatch: isCut ? bvis.hatch : 'none',
      fillColor: isCut ? (bvis.section_fill_color ?? bvis.color_2d) : 'none',
      strokeColor: isCut ? (bvis.section_line_color ?? bvis.color_2d) : bvis.color_2d,
      lineWeight: isCut ? 'medium-cut' : 'projected',
      depthMm: Math.abs(midY - cutY),
      nodeId: bn.id, nodeType: 'beam',
    });
  }

  // ── Foundations ────────────────────────────────────────────────────────
  for (const n of nodes.filter((nd) => nd.type === 'foundation')) {
    const bimY = n.y;
    if (bimY < cutMin - 1000 || bimY > cutMax + 1000) continue;

    const fW = Number(n.properties.width ?? 1000);
    const fH = Number(n.properties.depth ?? n.properties.height ?? 500);
    const { bot } = getStoreyBand(n, nodeMap);
    const fBotMm = bot - fH;
    const fTopMm = bot;
    const fHalfW = fW / 2;
    const footprint = [
      { x: n.x - fHalfW, y: bimY - fHalfW },
      { x: n.x + fHalfW, y: bimY - fHalfW },
      { x: n.x + fHalfW, y: bimY + fHalfW },
      { x: n.x - fHalfW, y: bimY + fHalfW },
    ];
    const proj = projectFootprintOnSection(footprint, cutY);
    const isCut = footprintStraddlesCut(footprint, cutY);
    if (!proj && !isCut) continue;

    const uMin = proj ? proj.uMin : (n.x - fHalfW);
    const uMax = proj ? proj.uMax : (n.x + fHalfW);
    const fvis = getVis('foundation', String(n.properties.material ?? ''), matConfig, n);

    shapes.push({
      pts: [
        { u: uMin, v: fBotMm },
        { u: uMax, v: fBotMm },
        { u: uMax, v: fTopMm },
        { u: uMin, v: fTopMm },
      ],
      closed: true,
      hatch: fvis.hatch,
      fillColor: fvis.section_fill_color ?? fvis.color_2d,
      strokeColor: fvis.section_line_color ?? fvis.color_2d,
      lineWeight: isCut ? 'heavy-cut' : 'medium-cut',
      depthMm: Math.abs(bimY - cutY),
      nodeId: n.id, nodeType: 'foundation',
    });
  }

  // ── Sort: painter's algorithm (far elements first = back to front) ─────────
  shapes.sort((a, b) => b.depthMm - a.depthMm);

  // ── Compute bounds ─────────────────────────────────────────────────────────
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const sh of shapes) {
    for (const p of sh.pts) {
      if (p.u < uMin) uMin = p.u; if (p.u > uMax) uMax = p.u;
      if (p.v < vMin) vMin = p.v; if (p.v > vMax) vMax = p.v;
    }
  }
  axes.forEach((a) => { if (a.u < uMin) uMin = a.u; if (a.u > uMax) uMax = a.u; });
  if (!isFinite(uMin)) { uMin = 0; uMax = 20000; }
  if (!isFinite(vMin)) { vMin = elevMin; vMax = elevMax; }

  return { shapes, axes, levels, uMin, uMax, vMin, vMax };
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
