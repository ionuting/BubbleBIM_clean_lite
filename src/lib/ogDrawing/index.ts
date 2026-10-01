/**
 * ogDrawing — a plan, a section or an elevation, drawn from the kernel.
 *
 * ## What makes this different from the drawing engine
 *
 * `drawingEngine.ts` builds a drawing from element PARAMETERS: a wall becomes
 * a rectangle as thick as the wall, a column its section, a slab its band.
 * That is exact for those, and it is why the engine's plans and sections are
 * the ones to annotate and dimension — they know what every shape MEANS.
 *
 * This module knows nothing about wall types. It takes the solids the 3D
 * viewer actually built, cuts them with a plane, and projects the rest. So it
 * draws whatever the kernel can build — a sweep, a stair, a sloping roof, a
 * freeform solid, a dormer — and it draws it as it really is, openings and
 * trims and booleans included. The two are complementary, and the second is
 * the one to reach for when the question is "is the model right?".
 *
 * ## The three views are one view
 *
 * A plan cuts horizontally and looks down; a section cuts vertically and looks
 * along; an elevation does not cut at all, because its plane is pushed outside
 * the building. All three are a `ViewFrame` and the same three steps:
 *
 *   cut    — `slice.ts` on every solid the plane passes through
 *   seen   — `project.ts` on everything wholly beyond it, hidden lines removed
 *   frame  — axes and levels, from the storeys
 *
 * The cut is ours and the linework is the kernel's, for a reason that is a
 * measured fact rather than a preference: the kernel's `section_plane` is
 * accepted and discarded, in 2.0.13 and in 2.0.14 alike.
 */
import type { BubbleGraphNode } from '@/store';
import type { MaterialConfig } from '@/lib/materialConfig';
import { applyNodeColorOverrides, resolveVisuals } from '@/lib/materialConfig';
import { expandArrayNodes } from '@/lib/formulaUtils';
import { parseAxes } from '@/lib/utils';
import {
  buildFrame, elevationCut,
  type DrawingAxis, type DrawingLevel, type DrawingResult, type DrawingShape,
  type ElevationDir, type SectionCut,
} from '@/lib/drawingEngine';
import { cutPlane, frameFromCut, planFrame, projectPt, roleOf, type OgViewKind, type ViewFrame } from './frame';
import { sliceEntity } from './slice';
import { penColor, projectViewLines, type EntityLike, type ViewOutlines } from './project';
import { mergeOgCut, type OgMergeOptions } from './merge';

export type { OgViewKind, ViewFrame } from './frame';
export { planFrame, frameFromCut } from './frame';

/** Where a plan's cut sits above the storey's own floor, mm — the usual convention. */
export const DEFAULT_PLAN_CUT_MM = 1200;

/** What to draw. One shape for all three views; the unused fields are ignored. */
export interface OgDrawingSpec {
  kind: OgViewKind;
  /** Plan: the storey to cut. Its band also bounds the drawing vertically. */
  storeyId?: string;
  /** Plan: height of the cut above the storey floor, mm. */
  planCutMm?: number;
  /** Section and elevation: which way the viewer looks. */
  dir?: ElevationDir;
  /** Section: the marker node to read the line, look side and depth from. */
  cut?: SectionCut;
  /** How far past the plane the drawing still shows, mm. */
  depthMm?: number;
}

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const storeysOf = (nodes: BubbleGraphNode[]): BubbleGraphNode[] =>
  nodes.filter((n) => n.type === 'storey');

/**
 * The frame this spec asks for.
 *
 * Pure and synchronous — the viewer needs it to label itself and to place a
 * click before the kernel has loaded anything.
 */
export function buildOgFrame(nodes: BubbleGraphNode[], spec: OgDrawingSpec): ViewFrame {
  const all = expandArrayNodes(nodes);

  if (spec.kind === 'plan') {
    const storey = spec.storeyId ? all.find((n) => n.id === spec.storeyId) : storeysOf(all)[0];
    const bottom = num(storey?.properties?.bottomElevation, 0);
    const top = num(storey?.properties?.topElevation, bottom + 3000);
    const offset = spec.planCutMm ?? DEFAULT_PLAN_CUT_MM;
    // A cut asked for above the storey's own ceiling would show nothing; the
    // slider is clamped, not obeyed into an empty drawing.
    const cutZ = Math.min(Math.max(bottom + offset, bottom + 1), top - 1);
    return planFrame({
      cutZmm: cutZ,
      viewDepthMm: spec.depthMm,
      elevMin: bottom,
      elevMax: top,
    });
  }

  if (spec.kind === 'elevation') {
    const cut = elevationCut(all, spec.dir ?? 'N');
    return frameFromCut(buildFrame(cut), 'elevation', cut.elevMin ?? -Infinity, cut.elevMax ?? Infinity);
  }

  // A section: the marker if there is one, otherwise a plane through the
  // middle of the model facing the asked-for direction.
  const cut = spec.cut ?? defaultSectionCut(all, spec.dir ?? 'N', spec.depthMm);
  return frameFromCut(buildFrame(cut), 'section', cut.elevMin ?? -Infinity, cut.elevMax ?? Infinity);
}

/**
 * A section with no marker: a plane through the middle of the model, facing
 * the way the tab asks. Not a substitute for a real marker — it is what the
 * view opens at before one is placed.
 */
function defaultSectionCut(
  nodes: BubbleGraphNode[],
  dir: ElevationDir,
  depthMm?: number,
): SectionCut {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of storeysOf(nodes)) {
    for (const x of parseAxes(s.properties.axesX)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    for (const y of parseAxes(s.properties.axesY)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = 10000; }
  if (!Number.isFinite(minY)) { minY = 0; maxY = 10000; }
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
  const pad = 100000;
  const line = {
    N: { x1: minX - pad, y1: midY, x2: maxX + pad, y2: midY },
    S: { x1: maxX + pad, y1: midY, x2: minX - pad, y2: midY },
    E: { x1: midX, y1: maxY + pad, x2: midX, y2: minY - pad },
    W: { x1: midX, y1: minY - pad, x2: midX, y2: maxY + pad },
  }[dir];
  return {
    line,
    lookSide: 'left',
    cutDepth: depthMm !== undefined && Number.isFinite(depthMm) ? depthMm : Infinity,
  };
}

/**
 * The cut faces: every solid the plane passes through, sliced.
 *
 * Hatch and colour come from the same material lookup the engine and the 3D
 * viewers use, so a cut wall reads the same however it was drawn. The depth is
 * zero for all of them — they are ON the plane, in front of everything seen.
 *
 * ## See-through elements
 *
 * A room is a solid in the model — `ogBimMapper` extrudes its polygon to full
 * height — but it is air. A PLAN shades it, which is a real convention and
 * reads well; a SECTION must not, or every drawing is a solid block of room
 * with the building somewhere behind it. So they are cut only in plan, drawn
 * without hatch, and sorted behind the material: a tint under the walls, not
 * a face among them.
 */
export function cutShapes(
  entities: EntityLike[],
  frame: ViewFrame,
  nodes: BubbleGraphNode[],
  matConfig: MaterialConfig | null,
): DrawingShape[] {
  const nodeMap = new Map(expandArrayNodes(nodes).map((n) => [n.id, n]));
  const plane = cutPlane(frame);
  const solid: DrawingShape[] = [];
  const tints: DrawingShape[] = [];

  for (const e of entities) {
    if (e.seeThrough && frame.kind !== 'plan') continue;
    if (roleOf(frame, e.bbox) !== 'cut') continue;
    const loops = sliceEntity(e.faces, frame, plane.point, plane.normal);
    if (loops.length === 0) continue;

    const node = nodeMap.get(e.nodeId);
    let vis = resolveVisuals(e.nodeType, String(node?.properties?.material ?? ''), matConfig);
    if (node) vis = applyNodeColorOverrides(vis, node.properties);

    // Loops come largest first, holes flagged. Each outline takes the holes
    // that fall inside it, so a face with two openings is still one shape.
    const outlines = loops.filter((l) => !l.isHole);
    const holes = loops.filter((l) => l.isHole);
    for (const o of outlines) {
      const mine = holes.filter((h) => insideLoop(h.pts[0], o.pts));
      (e.seeThrough ? tints : solid).push({
        pts: o.pts,
        closed: true,
        holes: mine.length ? mine.map((h) => h.pts) : undefined,
        hatch: e.seeThrough ? 'none' : vis.hatch,
        // The cut colours, not the seen ones — the same lookup the engine's
        // own cut faces use, so a sliced wall reads like a drawn one.
        fillColor: vis.section_fill_color ?? vis.color_2d,
        // The fill may be as pale as the material really is; its outline may
        // not, or the cut has no edge at all.
        strokeColor: penColor(vis.section_line_color ?? vis.color_2d),
        lineWeight: e.seeThrough ? 'annotation' : 'heavy-cut',
        depthMm: 0,
        nodeId: e.nodeId,
        nodeType: e.nodeType,
      });
    }
  }
  // Tints first: they are the ground the drawing sits on.
  return [...tints, ...solid];
}

function insideLoop(pt: { u: number; v: number }, poly: { u: number; v: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.v > pt.v) !== (b.v > pt.v)
      && pt.u < ((b.u - a.u) * (pt.v - a.v)) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}

/**
 * The grid, in the frame's own coordinates.
 *
 * A plan sees both directions and draws them as the grid it is. A vertical
 * view meets each grid line at one point along its own axis, which is the
 * existing engine's rule and is reproduced here so the two never disagree
 * about which bubble is which.
 */
export function ogAxes(nodes: BubbleGraphNode[], frame: ViewFrame): DrawingAxis[] {
  const storey = storeysOf(expandArrayNodes(nodes))[0];
  if (!storey) return [];
  const axX = parseAxes(storey.properties.axesX).slice().sort((a, b) => a - b);
  const axY = parseAxes(storey.properties.axesY).slice().sort((a, b) => a - b);
  const out: DrawingAxis[] = [];

  if (frame.kind === 'plan') {
    axX.forEach((x, i) => out.push({ u: projectPt(frame, { x, y: 0, z: frame.o.z }).u, label: String(i + 1), kind: 'X' }));
    axY.forEach((y, i) => out.push({
      u: 0,
      v: projectPt(frame, { x: 0, y, z: frame.o.z }).v,
      label: String.fromCharCode(65 + i),
      kind: 'Y',
    }));
    return out;
  }

  // Where each grid line meets the view's own horizontal axis.
  const { ru, o } = frame;
  if (Math.abs(ru.x) > 1e-6) {
    axX.forEach((x, i) => out.push({ u: (x - o.x) / ru.x, label: String(i + 1), kind: 'X' }));
  }
  if (Math.abs(ru.y) > 1e-6) {
    axY.forEach((y, i) => out.push({ u: (y - o.y) / ru.y, label: String.fromCharCode(65 + i), kind: 'Y' }));
  }
  return out;
}

/** Storey levels inside the view's vertical range. A plan has none — it IS one. */
export function ogLevels(nodes: BubbleGraphNode[], frame: ViewFrame): DrawingLevel[] {
  if (frame.kind === 'plan') return [];
  const seen = new Set<number>();
  const out: DrawingLevel[] = [];
  for (const s of storeysOf(expandArrayNodes(nodes))) {
    for (const v of [num(s.properties.bottomElevation, 0), num(s.properties.topElevation, 3000)]) {
      if (seen.has(v) || v < frame.elevMin - 1 || v > frame.elevMax + 1) continue;
      seen.add(v);
      out.push({ vMm: v, label: `${v < 0 ? '−' : '+'}${(Math.abs(v) / 1000).toFixed(3)}` });
    }
  }
  return out.sort((a, b) => a.vMm - b.vMm);
}

/**
 * Assemble the drawing from parts already computed.
 *
 * Split out from the kernel call so it can be tested without a wasm module,
 * and so a viewer can redraw when only the material config changed.
 *
 * The sort is the painter's: furthest first. Cut faces sit at depth zero and
 * therefore last, over everything they stand in front of — which is what makes
 * a plan read as a plan rather than as a wireframe.
 */
export function assembleOgDrawing(
  cut: DrawingShape[],
  seen: ViewOutlines | null,
  axes: DrawingAxis[],
  levels: DrawingLevel[],
): DrawingResult {
  const shapes = [...(seen?.shapes ?? []), ...cut]
    .sort((a, b) => b.depthMm - a.depthMm);

  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const s of shapes) {
    for (const p of s.pts) {
      if (p.u < uMin) uMin = p.u;
      if (p.u > uMax) uMax = p.u;
      if (p.v < vMin) vMin = p.v;
      if (p.v > vMax) vMax = p.v;
    }
  }
  if (!Number.isFinite(uMin)) { uMin = 0; uMax = 1000; vMin = 0; vMax = 1000; }

  return { shapes, axes, levels, uMin, uMax, vMin, vMax };
}

/**
 * The whole drawing, kernel and all.
 *
 * `collect` and `newSceneManager` are injected because they are the only two
 * things here that need the wasm loaded: a caller that already has the
 * entities (the HTML export builds the scene for its own reasons) passes them
 * straight in rather than building the model twice.
 */
export function computeOgDrawing(
  entities: EntityLike[],
  frame: ViewFrame,
  nodes: BubbleGraphNode[],
  matConfig: MaterialConfig | null,
  newSceneManager: (() => import('./project').SceneManagerLike) | null,
  merge: OgMergeOptions = {},
): DrawingResult {
  // The kernel cuts every solid on its own; a drawing wants the walls as one
  // poché and the openings as symbols over an empty hole. See `merge.ts`.
  const cut = mergeOgCut(cutShapes(entities, frame, nodes, matConfig), merge);
  const seen = newSceneManager
    // These drawings have no engine fills under the linework, so a stroke
    // with no contrast is simply not there.
    ? projectViewLines(entities, frame, nodes, matConfig, newSceneManager, { rescuePens: true })
    : null;
  return assembleOgDrawing(cut, seen, ogAxes(nodes, frame), ogLevels(nodes, frame));
}

/** Re-exported so a caller needs one import for the whole module. */
export type { EntityLike, ViewOutlines } from './project';
export { projectViewLines, cameraForView } from './project';
export { mergeOgCut, type OgMergeOptions } from './merge';
export { sliceEntity } from './slice';
