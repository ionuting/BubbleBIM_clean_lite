/**
 * OGOrthoViewer — the kernel's own plan, section and elevation.
 *
 * ## What changed, and why it had to
 *
 * This view used to be a shaded WebGL scene with two clipping planes through
 * it. That is a 3D preview of a slab of building, and it is not a drawing:
 * a clipping plane cuts a solid OPEN, so a wall in "plan" was a hollow box
 * seen from the inside rather than a filled poché; there was no linework at
 * all, so nothing read as a drawing; the elevation went down the same cutting
 * path as the section, which an elevation must not; the cut was a slider in
 * kernel metres with no relation to the storey it belonged to; and none of it
 * could reach a sheet, because there was no geometry to put on one.
 *
 * It is now the same drawing pipeline every other 2D view here uses —
 * `DrawingResult` → `buildDrawingSvg` — fed by `ogDrawing`, which cuts the
 * kernel's solids with a real plane and projects what is beyond it with
 * hidden lines removed. So it gains hatching, dimensions, DXF, fit-to-content
 * and scale-aware pen weights for free, and it draws whatever the kernel can
 * build: a sweep, a stair, a dormer, a sloping roof, cut exactly.
 *
 * ## How it relates to the parametric plan
 *
 * `FloorPlan2DViewer` remains the plan to WORK in — it knows what a wall is,
 * so it can reinforce, swap symbols and place a section on an axis. This one
 * knows only where the faces are. That is the point of it: it shows what the
 * model actually is, which is the drawing to reach for when the two disagree.
 *
 * It does annotate and dimension, though, through the same
 * `DrawingAnnotationLayer` the section and elevation use — the layer only ever
 * needed a `DrawingResult` and a pair of coordinate functions, and this view
 * has both. Annotations are stored in the drawing's own (u, v) millimetres, so
 * moving the cut, rescaling the sheet or letting the model grow past its old
 * extent redraws everything underneath them and leaves them where they were
 * put. What they are NOT is tied to an element: a dimension measures the
 * points it was given, so if a wall moves, the drawing follows and the
 * dimension does not.
 *
 * Coordinates inside this file are the drawing's own (u, v) in millimetres.
 * For a plan that is BIM east and BIM north exactly, which is what makes
 * picking and wall drawing straightforward here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn, parseAxes } from '@/lib/utils';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { useBubbleGraphStore } from '@/store';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { expandArrayNodes } from '@/lib/formulaUtils';
import { getAxRealPos } from '@/lib/bimGeometry';
import type { DrawingResult } from '@/lib/drawingEngine';
import { DEFAULT_PLAN_CUT_MM, buildOgFrame, type OgDrawingSpec, type OgViewKind } from '@/lib/ogDrawing';
import { useOgDrawing } from '@/hooks/useOgDrawing';
import { drawingStyle, fitScale } from '@/lib/drawingStyle';
import { autoDimensions, dimensionReach } from '@/lib/drawingDimensions';
import { drawingToDxf } from '@/lib/dxfExport';
import { downloadText, safeFilename } from '@/lib/download';
import { useFitToContent } from '@/hooks/useFitToContent';
import { clientToSvgUserPoint } from '@/lib/svgCoordinates';
import { SvgHatchDefs } from './SvgHatches';
import { buildDrawingSvg, sheetBounds } from './drawingSvg';
import { storeyOpeningFrames, symbolMatrix, type OpeningFrame } from '@/lib/plan/openingSymbols';
import {
  OPENING_SNAP_MM, canFlipHinge, dragOpeningDistance, flipHinge, flipSide, moveOpening, openingClearances,
} from '@/lib/plan/openingEdit';
import { defaultDoorPlanDef, defaultWindowPlanDef } from '@/lib/symbolTemplates/planDefaults';
import { resolveDoorPlan2DConfig } from '@/lib/doorSymbolLibrary';
import { resolveWindowPlan2DConfig } from '@/lib/windowSymbolLibrary';
import {
  buildDoorSymRenderParams, buildWindowSymRenderParams, renderSymbolInlineElements,
} from '@/lib/svgSymbolStore';
import { AnnotationToolbar, DrawingAnnotationLayer } from './DrawingAnnotations';
import type { SvgAnnotationTool } from './SvgAnnotationLayer';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Kept under their old names: these are the props the view tabs already pass. */
export type OG2DViewType = 'floorplan' | 'section' | 'elevation';
export type OGViewDir = 'N' | 'S' | 'E' | 'W';

interface OGOrthoViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  viewType: OG2DViewType;
  viewDirection?: OGViewDir;
  storeyId?: string;
  tabId?: string;
  /**
   * Kept from the WebGL viewer's saved tab params, where they were kernel
   * METRES. A plan's cut is now an offset above the storey floor in mm and a
   * section's is a depth in mm, so an old value is read as metres and
   * converted rather than being taken at face value — which would have put
   * the cut at 1.2 mm above the floor.
   */
  initialCutPos?: number;
  initialCutDepth?: number;
  className?: string;
  embedded?: boolean;
  /** How the drawing looks — lib/drawing/graphicStyle (color, technical, poche, presentation). */
  graphicStyle?: string;
  /** The view's own annotation key (lib/views/drawingViews); absent → the key this drawing used before views. */
  annotationKey?: string;
}

/** Hatch tile, in paper millimetres — the pattern is a paper size like a pen. */
const HATCH_TILE_MM = 2.5;

const KIND: Record<OG2DViewType, OgViewKind> = {
  floorplan: 'plan', section: 'section', elevation: 'elevation',
};

const DIR_NAME: Record<OGViewDir, string> = { N: 'Nord', S: 'Sud', E: 'Est', W: 'Vest' };

function viewLabel(viewType: OG2DViewType, dir: OGViewDir, storeyName?: string): string {
  if (viewType === 'floorplan') return `Plan OG${storeyName ? ` · ${storeyName}` : ''}`;
  if (viewType === 'section') return `Secțiune OG · ${DIR_NAME[dir]}`;
  return `Fațadă OG · ${DIR_NAME[dir]}`;
}

function dwUid(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * An old tab param, in kernel metres, as the millimetres this viewer wants.
 *
 * Anything under 100 was a metre value — no one sets a cut 100 mm above the
 * floor, and every old value was metres — so it is scaled. A value already in
 * millimetres passes through.
 */
function mmFromLegacy(v: number | undefined, fallback: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.abs(v) < 100 ? Math.round(v * 1000) : Math.round(v);
}

/** Is a point inside a closed drawing polygon? */
function inPoly(pt: { u: number; v: number }, poly: { u: number; v: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.v > pt.v) !== (b.v > pt.v)
      && pt.u < ((b.u - a.u) * (pt.v - a.v)) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}

/**
 * Which element was clicked.
 *
 * The shapes are in painter's order, so the one on top is the LAST that
 * contains the point — hence the backwards walk. Holes count: clicking in a
 * doorway must not select the wall it is a hole in.
 */
function pickAt(drawing: DrawingResult, pt: { u: number; v: number }): string | null {
  for (let i = drawing.shapes.length - 1; i >= 0; i--) {
    const s = drawing.shapes[i];
    if (!s.closed || s.pts.length < 3) continue;
    if (!inPoly(pt, s.pts)) continue;
    if ((s.holes ?? []).some((h) => inPoly(pt, h))) continue;
    return s.nodeId;
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OGOrthoViewer({
  nodes,
  edges,
  viewType,
  viewDirection = 'N',
  storeyId,
  tabId,
  initialCutPos,
  initialCutDepth,
  className,
  embedded = false,
  annotationKey,
  graphicStyle,
}: OGOrthoViewerProps) {
  const kind = KIND[viewType];
  const dir = (viewType === 'floorplan' ? 'N' : viewDirection) as OGViewDir;

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const { config: matConfig } = useMaterialConfig();
  const updateViewTabParams = useBubbleGraphStore((s) => s.updateViewTabParams);
  const setSelectedNodeId = useBubbleGraphStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useBubbleGraphStore((s) => s.selectedNodeId);
  const setBubbleGraph = useBubbleGraphStore((s) => s.setBubbleGraph);
  const rawStoreNodes = useBubbleGraphStore((s) => s.bubbleGraphNodes);
  const rawStoreEdges = useBubbleGraphStore((s) => s.bubbleGraphEdges);
  const selectedAnnotationId = useBubbleGraphStore((s) => s.selectedAnnotationId);

  const allNodes = useMemo(() => expandArrayNodes(nodes), [nodes]);
  const storeyNode = useMemo(
    () => (storeyId ? allNodes.find((n) => n.id === storeyId) : allNodes.find((n) => n.type === 'storey')),
    [allNodes, storeyId],
  );

  // ── The view's own parameters ─────────────────────────────────────────────
  const [planCutMm, setPlanCutMm] = useState(() => mmFromLegacy(initialCutPos, DEFAULT_PLAN_CUT_MM));
  const [depthMm, setDepthMm] = useState(() => mmFromLegacy(initialCutDepth, 50000));
  const [limitDepth, setLimitDepth] = useState(false);

  const storeyHeight = useMemo(() => {
    const bot = Number(storeyNode?.properties?.bottomElevation ?? 0);
    const top = Number(storeyNode?.properties?.topElevation ?? bot + 3000);
    return Math.max(100, top - bot);
  }, [storeyNode]);

  // Persist back to the tab, in millimetres this time.
  const initedRef = useRef(false);
  useEffect(() => {
    if (!tabId) return;
    if (!initedRef.current) { initedRef.current = true; return; }
    const t = setTimeout(() => updateViewTabParams(tabId, { cutPos: planCutMm, cutDepth: depthMm }), 400);
    return () => clearTimeout(t);
  }, [tabId, planCutMm, depthMm, updateViewTabParams]);

  const spec: OgDrawingSpec = useMemo(() => ({
    kind,
    storeyId: kind === 'plan' ? storeyNode?.id : undefined,
    planCutMm: kind === 'plan' ? planCutMm : undefined,
    dir: kind === 'plan' ? undefined : dir,
    depthMm: kind === 'plan' || !limitDepth ? undefined : depthMm,
  }), [kind, storeyNode?.id, planCutMm, dir, limitDepth, depthMm]);

  /**
   * A plan draws an opening as a SYMBOL, not as the joinery the kernel built.
   * So the door and window solids are left out of the cut by default and the
   * symbol layer below draws into the hole they leave. Turning this on shows
   * the model as it really is, which is what this view is for when the two
   * disagree.
   */
  const [showOpeningSolids, setShowOpeningSolids] = useState(false);
  const { drawing, busy, error, tookMs } = useOgDrawing(
    nodes, edges, matConfig ?? null, spec,
    { hideOpeningSolids: !showOpeningSolids },
  );

  // Where the plan's cut actually landed, which is not always where the
  // slider asked: `buildOgFrame` clamps it inside the storey. Cheap and
  // synchronous, so the label is right before the kernel has drawn anything.
  const cutZmm = useMemo(
    () => (kind === 'plan' ? Math.round(buildOgFrame(nodes, spec).o.z) : 0),
    [kind, nodes, spec],
  );

  // ── Sheet, scale, dimensions ──────────────────────────────────────────────
  const [showDims, setShowDims] = useState(true);
  const style = useMemo(
    () => drawingStyle(drawing
      ? fitScale(drawing.uMax - drawing.uMin, drawing.vMax - drawing.vMin)
      : fitScale(10000, 10000), graphicStyle),
    [drawing, graphicStyle],
  );
  const dimensions = useMemo(
    () => (showDims && drawing ? autoDimensions(drawing, style) : []),
    [showDims, drawing, style],
  );
  const bounds = useMemo(
    () => (drawing
      ? sheetBounds(drawing, style, dimensionReach(dimensions, drawing))
      : { uMin: 0, uMax: 1000, vMin: 0, vMax: 1000, width: 1000, height: 1000 }),
    [drawing, style, dimensions],
  );
  const { uMin, vMin, width: drawW, height: drawH } = bounds;

  const toX = useCallback((u: number) => u - uMin, [uMin]);
  const toY = useCallback((v: number) => drawH - (v - vMin), [drawH, vMin]);

  /**
   * The opening symbols, laid over the drawing.
   *
   * Each is the architectural template for its family — the same definition
   * Symbol Studio edits and the parametric plan draws — placed from the
   * wall's own footprint so it sits in the hole rather than near it. A symbol
   * someone has drawn by hand is not consulted here yet; the template is what
   * a plan needs, and it is what both plans now agree on.
   */
  const openingSymbols = useMemo(() => {
    if (kind !== 'plan' || !storeyNode) return [];
    return storeyOpeningFrames(allNodes, edges, storeyNode.id).flatMap((f, i) => {
      const p = f.node.properties;
      const key = `${f.node.id}#${i}`;
      try {
        if (f.kind === 'door') {
          const swing = String(p.swing ?? 'left');
          const def = defaultDoorPlanDef(
            swing, resolveDoorPlan2DConfig(String(p.door_type ?? ''), swing),
          );
          const html = renderSymbolInlineElements(
            def, buildDoorSymRenderParams({}, f.widthMm, f.thicknessMm),
          ).join('\n');
          return [{ key, frame: f, html }];
        }
        const opening = String(p.opening ?? 'single');
        const cfg = resolveWindowPlan2DConfig(String(p.window_type ?? ''), opening);
        const def = defaultWindowPlanDef(opening, cfg);
        // The window symbol's depth is `outerLineOffset + innerLineOffset`,
        // a per-type setting that knows nothing about the wall it lands in —
        // 125 + 125 by default, so on a 200 wall the symbol hangs 50 out and
        // its sill projects from the wrong place. Scale the pair onto the
        // real thickness, keeping whatever asymmetry was configured.
        const sum = cfg.outerLineOffset_mm + cfg.innerLineOffset_mm;
        const k = sum > 1 ? f.thicknessMm / sum : 1;
        const html = renderSymbolInlineElements(def, buildWindowSymRenderParams(
          {
            ...cfg,
            outerLineOffset_mm: cfg.outerLineOffset_mm * k,
            innerLineOffset_mm: cfg.innerLineOffset_mm * k,
          },
          f.widthMm, f.thicknessMm,
        )).join('\n');
        return [{ key, frame: f, html }];
      } catch {
        // A symbol that will not build must not take the drawing with it.
        return [];
      }
    });
  }, [kind, storeyNode, allNodes, edges]);

  const svgShapes = useMemo(
    () => (drawing
      // A plan has no ground line and no earth below it — that is a section's
      // furniture, and drawn here it would be a band across the middle.
      ? buildDrawingSvg({ drawing, style, bounds, toX, toY, dimensions, ground: kind !== 'plan' })
      : []),
    [drawing, style, bounds, toX, toY, dimensions, kind],
  );

  // ── Pan / zoom ────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });

  useFitToContent({
    svgRef, containerRef, setZoom, setPan,
    // The kernel draws asynchronously: fit again once, when the drawing
    // arrives — framing the empty sheet before it left the plan a speck.
    viewKey: `${viewType}:${storeyNode?.id ?? ''}:${dir}:${drawing ? 'drawn' : 'waiting'}`,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el || embedded) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.max(0.05, Math.min(20, z * (1 - e.deltaY * 0.001))));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [embedded]);

  /** A mouse event as a point in the drawing's own millimetres. */
  const eventToUv = useCallback((e: { clientX: number; clientY: number }) => {
    const p = clientToSvgUserPoint(svgRef.current, e.clientX, e.clientY);
    if (!p) return null;
    return { u: p.x + uMin, v: vMin + (drawH - p.y) };
  }, [uMin, vMin, drawH]);

  // ── Annotations ───────────────────────────────────────────────────────────
  // The id a drawing's annotations are filed under has to survive a reload, so
  // it names the view rather than the tab: a tab id is minted fresh each time
  // one is opened, and filing under it would lose every annotation the moment
  // the tab was closed. Two OG tabs on the same storey, or on the same
  // direction, are the same drawing and share the same marks — which is the
  // behaviour you want, since there is nothing to tell them apart.
  const [annTool, setAnnTool] = useState<SvgAnnotationTool | null>(null);
  const annViewId = annotationKey ?? (kind === 'plan'
    ? `og:plan:${storeyNode?.id ?? 'all'}`
    : `og:${kind}:${dir}`);

  const toSvgPt = useCallback((u: number, v: number) => ({ x: toX(u), y: toY(v) }), [toX, toY]);
  const fromSvgEvent = useCallback((e: { clientX: number; clientY: number }) => {
    const uv = eventToUv(e);
    return uv ? { x: uv.u, y: uv.v } : { x: 0, y: 0 };
  }, [eventToUv]);

  // ── Draw Wall (plan only) ─────────────────────────────────────────────────
  const [drawWall, setDrawWall] = useState(false);
  const [wallStart, setWallStart] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ raw: { x: number; y: number }; snap: { x: number; y: number } } | null>(null);

  const axisXVals = useMemo(
    () => parseAxes(storeyNode?.properties?.axesX).slice().sort((a, b) => a - b),
    [storeyNode],
  );
  const axisYVals = useMemo(
    () => parseAxes(storeyNode?.properties?.axesY).slice().sort((a, b) => a - b),
    [storeyNode],
  );

  /** Grid intersections, the midpoint of every bay, and the centre of each. */
  const snapPoints = useMemo(() => {
    const mids = (vs: number[]) => vs.slice(0, -1).map((v, i) => (v + vs[i + 1]) / 2);
    const xs = [...axisXVals, ...mids(axisXVals)];
    const ys = [...axisYVals, ...mids(axisYVals)];
    const pts: { x: number; y: number }[] = [];
    for (const x of xs) for (const y of ys) pts.push({ x, y });
    return pts;
  }, [axisXVals, axisYVals]);

  const SNAP_MM = 500;
  const findSnap = useCallback((pt: { x: number; y: number }) => {
    let best = pt, bestD = SNAP_MM;
    for (const p of snapPoints) {
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }, [snapPoints]);

  /**
   * Where the graph editor would put an ax node for this BIM point — the same
   * formula it uses itself, so a wall drawn here lands in the right place on
   * the bubble canvas too.
   */
  const bimToCanvas = useCallback((pt: { x: number; y: number }) => {
    const sn = rawStoreNodes.find((n) => n.id === storeyNode?.id);
    if (!sn) return { x: 300, y: 300 };
    const axX = parseAxes(sn.properties?.axesX).slice().sort((a, b) => a - b);
    const axY = parseAxes(sn.properties?.axesY).slice().sort((a, b) => a - b);
    const maxX = axX.length ? axX[axX.length - 1] : 0;
    const maxY = axY.length ? axY[axY.length - 1] : 0;
    return { x: sn.x + (pt.x - maxX / 2), y: sn.y + (pt.y - maxY / 2) };
  }, [rawStoreNodes, storeyNode?.id]);

  const commitWall = useCallback((a: { x: number; y: number }, b: { x: number; y: number }) => {
    const sid = storeyNode?.id;
    if (!sid) return;
    const REUSE_MM = 100;
    const nodeMap = new Map(rawStoreNodes.map((n) => [n.id, n]));
    const axNodes = rawStoreNodes.filter((n) => n.type === 'ax' && n.parentId === sid);
    const existing = (pt: { x: number; y: number }) => axNodes.find((n) => {
      const p = getAxRealPos(n, nodeMap);
      return Math.hypot(p.x - pt.x, p.y - pt.y) < REUSE_MM;
    });

    const ea = existing(a), eb = existing(b);
    const startId = ea ? ea.id : `ax_${dwUid()}`;
    const endId = eb ? eb.id : `ax_${dwUid()}`;
    const wallId = `wall_${dwUid()}`;
    const axCount = rawStoreNodes.filter((n) => n.type === 'ax').length;
    const wallCount = rawStoreNodes.filter((n) => n.type === 'wall').length;

    const fresh: BubbleGraphNode[] = [];
    if (!ea) {
      const c = bimToCanvas(a);
      fresh.push({
        id: startId, type: 'ax', name: `Ax${axCount + 1}`,
        x: c.x, y: c.y, z: 0, parentId: sid,
        properties: { has_column: 'False', column_type: 'C25x25', bimX: a.x, bimY: a.y },
      });
    }
    if (!eb) {
      const c = bimToCanvas(b);
      fresh.push({
        id: endId, type: 'ax', name: `Ax${axCount + fresh.length + 1}`,
        x: c.x, y: c.y, z: 0, parentId: sid,
        properties: { has_column: 'False', column_type: 'C25x25', bimX: b.x, bimY: b.y },
      });
    }
    const ca = bimToCanvas(a), cb = bimToCanvas(b);
    fresh.push({
      id: wallId, type: 'wall', name: `Wall${wallCount + 1}`,
      x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2, z: 0, parentId: sid,
      properties: {
        wall_type: 'W20', height: 3000,
        offset_start: 0, offset_end: 0,
        has_beam: 'True', beam_section: 'B20x30',
        material: 'Beton C30/37',
        has_windows: 'False', windows: '[]',
        has_doors: 'False', doors: '[]',
      },
    });
    setBubbleGraph(
      [...rawStoreNodes, ...fresh],
      [...rawStoreEdges,
        { id: `edge_${dwUid()}`, from: startId, to: wallId },
        { id: `edge_${dwUid()}`, from: wallId, to: endId }],
    );
  }, [storeyNode?.id, rawStoreNodes, rawStoreEdges, setBubbleGraph, bimToCanvas]);

  const deleteSelected = useCallback(() => {
    if (!selectedNodeId) return;
    const node = rawStoreNodes.find((n) => n.id === selectedNodeId);
    if (!node) return;
    const gone = new Set<string>([selectedNodeId]);
    if (node.type === 'wall') {
      // An endpoint this wall invented and nothing else uses goes with it.
      for (const e of rawStoreEdges) {
        if (e.from !== selectedNodeId && e.to !== selectedNodeId) continue;
        const otherId = e.from === selectedNodeId ? e.to : e.from;
        const other = rawStoreNodes.find((n) => n.id === otherId);
        if (!other || other.properties?.bimX == null) continue;
        const usedElsewhere = rawStoreEdges.some(
          (x) => (x.from === otherId || x.to === otherId) && x.from !== selectedNodeId && x.to !== selectedNodeId,
        );
        if (!usedElsewhere) gone.add(otherId);
      }
    }
    setBubbleGraph(
      rawStoreNodes.filter((n) => !gone.has(n.id)),
      rawStoreEdges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
    );
    setSelectedNodeId(null);
  }, [selectedNodeId, rawStoreNodes, rawStoreEdges, setBubbleGraph, setSelectedNodeId]);

  const drawWallRef = useRef(false);
  useEffect(() => { drawWallRef.current = drawWall; }, [drawWall]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drawWallRef.current) {
        setDrawWall(false); setWallStart(null); setHover(null);
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const el = e.target as HTMLElement | null;
        const tag = el?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return;
        // The annotation layer listens for Delete too, and deletes whatever
        // annotation is selected. Both handlers are on `window`, so without
        // this one standing down a single press would take the annotation AND
        // the element still selected behind it.
        if (selectedAnnotationId) return;
        if (!drawWallRef.current) deleteSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelected, selectedAnnotationId]);

  // ── Mouse ─────────────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (embedded) return;
    if (e.button === 1 || e.shiftKey) {
      setDragging(true);
      lastPos.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    // With a tool armed the click is the annotation layer's — it handles it on
    // the SVG itself. Picking an element at the same time would fight it: a
    // dimension's first click would change the selection under the second.
    if (annTool) return;

    const uv = eventToUv(e);
    if (!uv) return;

    if (drawWall && kind === 'plan') {
      const pt = findSnap({ x: uv.u, y: uv.v });
      if (!wallStart) setWallStart(pt);
      else {
        if (Math.hypot(pt.x - wallStart.x, pt.y - wallStart.y) > 1) commitWall(wallStart, pt);
        setWallStart(null);
      }
      return;
    }
    if (drawing) setSelectedNodeId(pickAt(drawing, uv));
  }, [embedded, eventToUv, annTool, drawWall, kind, wallStart, findSnap, commitWall, drawing, setSelectedNodeId]);

  // ── Openings: drag along the wall, turn round ─────────────────────────────
  // The symbol follows the pointer on its own; the wall is re-cut once, on
  // release, because a cut is the kernel's work and takes a moment. Grouped
  // openings (`count > 1`) are placed by a rule and only select.
  const [openingDrag, setOpeningDrag] = useState<{ key: string; frame: OpeningFrame; from: { x: number; y: number }; dist: number } | null>(null);
  const openingDragRef = useRef(openingDrag);
  useEffect(() => { openingDragRef.current = openingDrag; }, [openingDrag]);

  const beginOpeningDrag = useCallback((key: string, f: OpeningFrame, e: React.MouseEvent) => {
    if (embedded || e.button !== 0 || annTool || drawWall || e.shiftKey) return;
    e.stopPropagation();
    setSelectedNodeId(f.inline ? f.wallId : f.node.id);
    if (f.grouped) return;
    const uv = eventToUv(e);
    if (!uv) return;
    setOpeningDrag({ key, frame: f, from: { x: uv.u, y: uv.v }, dist: f.distFromStartMm });
  }, [embedded, annTool, drawWall, eventToUv, setSelectedNodeId]);

  const commitOpening = useCallback((next: BubbleGraphNode[]) => {
    if (next !== rawStoreNodes) setBubbleGraph(next, rawStoreEdges);
  }, [rawStoreNodes, rawStoreEdges, setBubbleGraph]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && openingDragRef.current) setOpeningDrag(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging) {
      // The delta is taken NOW: the updater may run at the next render, by
      // which time `lastPos` already holds this event and the move is zero.
      const dx = e.clientX - lastPos.current.x, dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
      return;
    }
    if (openingDrag) {
      const uv = eventToUv(e);
      if (!uv) return;
      const to = { x: uv.u, y: uv.v };
      const step = e.altKey ? 1 : OPENING_SNAP_MM;
      setOpeningDrag((d) => (d ? { ...d, dist: dragOpeningDistance(d.frame, d.from, to, step) } : d));
      return;
    }
    if (!drawWall || kind !== 'plan') return;
    const uv = eventToUv(e);
    if (!uv) return;
    const raw = { x: uv.u, y: uv.v };
    setHover({ raw, snap: findSnap(raw) });
  }, [dragging, openingDrag, drawWall, kind, eventToUv, findSnap]);

  const onMouseUp = useCallback(() => {
    const d = openingDragRef.current;
    if (d) {
      setOpeningDrag(null);
      commitOpening(moveOpening(rawStoreNodes, d.frame, d.dist));
    }
    setDragging(false);
  }, [commitOpening, rawStoreNodes]);

  // ── Selection outline, in drawing coordinates ─────────────────────────────
  const selectedOutline = useMemo(() => {
    if (!drawing || !selectedNodeId) return null;
    const mine = drawing.shapes.filter((s) => s.nodeId === selectedNodeId && s.closed);
    if (mine.length === 0) return null;
    return mine.map((s) => `M ${s.pts.map((p) => `${toX(p.u).toFixed(2)},${toY(p.v).toFixed(2)}`).join(' L ')} Z`).join(' ');
  }, [drawing, selectedNodeId, toX, toY]);

  const cutLabel = kind === 'plan'
    ? `Tăietură +${planCutMm} mm  (cota ${(cutZmm / 1000).toFixed(3)})`
    : limitDepth ? `Adâncime ${depthMm} mm` : 'Adâncime ∞';

  return (
    <div
      ref={containerRef}
      className={cn('w-full h-full relative overflow-hidden', className)}
      style={{ background: '#f8f7f4', cursor: drawWall ? 'crosshair' : dragging ? 'grabbing' : 'default' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${drawW.toFixed(2)} ${drawH.toFixed(2)}`}
        style={{
          width: '100%',
          height: '100%',
          transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
          transformOrigin: '50% 50%',
          transition: dragging ? 'none' : 'transform 0.05s',
        }}
        preserveAspectRatio="xMidYMid meet"
      >
        <SvgHatchDefs tileSize={style.paper(HATCH_TILE_MM)} />
        {svgShapes}

        {/* Door and window symbols, over the hole their solids left. Each
            can be taken hold of and slid along its wall; the one selected
            shows its clearances and two buttons to turn it round. */}
        {openingSymbols.map(({ key, frame: f, html }) => {
          const isDrag = openingDrag?.key === key;
          const shift = isDrag ? openingDrag.dist - f.distFromStartMm : 0;
          const g: OpeningFrame = shift
            ? { ...f, origin: { x: f.origin.x + f.along.x * shift, y: f.origin.y + f.along.y * shift } }
            : f;
          const active = isDrag || (!embedded && selectedNodeId === (f.inline ? f.wallId : f.node.id));
          return (
            <g key={`sym-${key}`}>
              <g transform={symbolMatrix(g, toSvgPt)}
                onMouseDown={embedded ? undefined : (e) => beginOpeningDrag(key, f, e)}
                style={embedded ? undefined : { cursor: f.grouped ? 'pointer' : isDrag ? 'grabbing' : 'grab' }}>
                <g pointerEvents="none"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: html }} />
                {/* The hole itself is the handle: the lines are too thin to catch. */}
                <rect x={0} y={0} width={f.widthMm} height={f.thicknessMm} fill="transparent"
                  stroke={active ? '#f97316' : 'none'} strokeWidth={style.line('heavy-cut')} />
              </g>
              {active && kind === 'plan' && !embedded && (() => {
                const r = style.paper(2.4);
                const fs = style.paper(2.4);
                const out = { x: -g.across.x, y: -g.across.y };      // away from the room
                const at = (dAlong: number, dOut: number, from = g.origin) => toSvgPt(
                  from.x + g.along.x * dAlong + out.x * dOut,
                  from.y + g.along.y * dAlong + out.y * dOut,
                );
                // Text runs along the wall, never upside down.
                const a0 = toSvgPt(g.origin.x, g.origin.y);
                const a1 = toSvgPt(g.origin.x + g.along.x, g.origin.y + g.along.y);
                let ang = (Math.atan2(a1.y - a0.y, a1.x - a0.x) * 180) / Math.PI;
                if (ang > 90 || ang <= -90) ang += 180;
                const clear = openingClearances(g, g.distFromStartMm);
                const lift = 2.2 * r;
                const startMid = at(-clear.start / 2, lift);
                const endMid = at(f.widthMm + clear.end / 2, lift);
                const btnY = -lift;
                const hinge = canFlipHinge(f);
                const btn = (dx: number, glyph: string, title: string, onClick: () => void) => {
                  const c = at(f.widthMm / 2 + dx, -btnY + 0.6 * r, g.origin);
                  return (
                    <g style={{ cursor: 'pointer' }} onMouseDown={(e) => { e.stopPropagation(); }}
                      onClick={(e) => { e.stopPropagation(); onClick(); }}>
                      <title>{title}</title>
                      <circle cx={c.x} cy={c.y} r={r} fill="#fff" stroke="#f97316" strokeWidth={style.paper(0.25)} />
                      <text x={c.x} y={c.y} fontSize={fs * 1.1} textAnchor="middle" dominantBaseline="central"
                        fill="#c2410c" style={{ userSelect: 'none' }}>{glyph}</text>
                    </g>
                  );
                };
                const label = (p: { x: number; y: number }, mm: number) => (
                  <text x={p.x} y={p.y} fontSize={fs} textAnchor="middle" dominantBaseline="central"
                    fill="#c2410c" transform={`rotate(${ang.toFixed(2)} ${p.x.toFixed(2)} ${p.y.toFixed(2)})`}
                    style={{ userSelect: 'none' }} pointerEvents="none">{Math.round(mm)}</text>
                );
                return (
                  <g>
                    {clear.start > 1 && label(startMid, clear.start)}
                    {clear.end > 1 && label(endMid, clear.end)}
                    {!f.grouped && !isDrag && (
                      <>
                        {hinge && btn(-1.3 * r, '⇄', 'Balamaua pe celălalt toc', () => commitOpening(flipHinge(rawStoreNodes, f)))}
                        {btn(hinge ? 1.3 * r : 0, '⇅', 'Deschide spre cealaltă față', () => commitOpening(flipSide(rawStoreNodes, f)))}
                      </>
                    )}
                  </g>
                );
              })()}
            </g>
          );
        })}

        {selectedOutline && (
          <path d={selectedOutline} fill="none" stroke="#f97316"
            strokeWidth={style.line('heavy-cut') * 2} opacity={0.9} pointerEvents="none" />
        )}

        {/* Draw Wall: the snap grid, the crosshair and the rubber band. */}
        {drawWall && kind === 'plan' && (
          <g pointerEvents="none">
            {snapPoints.map((p, i) => (
              <circle key={i} cx={toX(p.x)} cy={toY(p.y)} r={style.paper(0.8)}
                fill="#3b82f6" fillOpacity={0.35} />
            ))}
            {hover && (
              <>
                <circle cx={toX(hover.snap.x)} cy={toY(hover.snap.y)} r={style.paper(2)}
                  fill="none" stroke="#22c55e" strokeWidth={style.line('annotation')} />
                {wallStart && (
                  <line
                    x1={toX(wallStart.x)} y1={toY(wallStart.y)}
                    x2={toX(hover.snap.x)} y2={toY(hover.snap.y)}
                    stroke="#3b82f6" strokeWidth={style.line('projected')}
                    strokeDasharray={`${style.paper(3)} ${style.paper(2)}`} />
                )}
              </>
            )}
            {wallStart && (
              <circle cx={toX(wallStart.x)} cy={toY(wallStart.y)} r={style.paper(2)}
                fill="#22c55e" fillOpacity={0.7} />
            )}
          </g>
        )}

        {/* Annotations last, so they sit above the drawing they describe. The
            layer needs a drawing to snap to and to size its pens from, so it
            waits for the kernel's first result rather than mounting empty. */}
        {drawing && (
          <DrawingAnnotationLayer
            viewId={annViewId}
            style={style}
            drawing={drawing}
            activeTool={embedded ? null : annTool}
            toSvg={toSvgPt}
            fromSvgEvent={fromSvgEvent}
          />
        )}
      </svg>

      {!embedded && (
        <>
          {/* Title and tools */}
          <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 text-[10px] bg-background/80 px-2 py-1 rounded border border-border/40">
            <span className="font-mono text-emerald-700">{viewLabel(viewType, dir, storeyNode?.name)}</span>
            <span className="opacity-40">·</span>
            <span className="text-muted-foreground" title="Scara la care e desenat — grosimile de linie o urmează">
              {style.label}
            </span>
            {kind === 'plan' && (
              <button
                title={drawWall ? 'Desenare pereți activă — două puncte, ESC anulează' : 'Desenează pereți între punctele de agățare'}
                onClick={() => {
                  setDrawWall((v) => !v); setWallStart(null); setHover(null);
                  setAnnTool(null);   // one tool at a time, or a click means two things
                }}
                className={cn('px-1.5 py-0.5 rounded border transition-colors',
                  drawWall ? 'bg-orange-500 text-white border-orange-500' : 'border-border/60 hover:bg-accent')}
              >▭ Perete</button>
            )}
            {selectedNodeId && !drawWall && (
              <button
                title="Șterge elementul selectat (Del)"
                onClick={deleteSelected}
                className="px-1.5 py-0.5 rounded border border-red-500/60 text-red-600 hover:bg-red-50"
              >🗑</button>
            )}
          </div>

          {/* The annotation tools, with this view's own two buttons on either
              side of them — the same arrangement the section and elevation
              use, so the three drawings are operated the same way. */}
          <AnnotationToolbar
            viewId={annViewId}
            activeTool={annTool}
            onToolChange={(t) => { setAnnTool(t); if (t) { setDrawWall(false); setWallStart(null); setHover(null); } }}
            leading={
              <>
                <button
                  title="Cote automate — axe și niveluri"
                  onClick={() => setShowDims((v) => !v)}
                  className={cn(
                    'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none',
                    showDims ? 'bg-slate-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >⟺</button>
                {kind === 'plan' && (
                  <button
                    title={showOpeningSolids
                      ? 'Geometria reală a golurilor — apasă pentru simboluri'
                      : 'Simboluri de ușă și fereastră — apasă pentru geometria reală'}
                    onClick={() => setShowOpeningSolids((v) => !v)}
                    className={cn(
                      'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none',
                      showOpeningSolids
                        ? 'bg-slate-600 text-white'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >{showOpeningSolids ? '▣' : '⌷'}</button>
                )}
              </>
            }
            trailing={
              <button
                title="Export DXF — geometrie, axe, niveluri și cote, pe straturi"
                disabled={!drawing}
                onClick={() => drawing && downloadText(
                  safeFilename(viewLabel(viewType, dir, storeyNode?.name), 'dxf'),
                  drawingToDxf(drawing, style, { dimensions }),
                  'image/vnd.dxf',
                )}
                className="h-6 px-1.5 flex items-center justify-center text-[10px] rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 transition-colors select-none"
              >DXF</button>
            }
          />

          {/* State — under the title, because the top right is the toolbar's
              now and a badge there would sit on top of the tools. */}
          {busy && (
            <div className="absolute top-10 left-2 z-20 px-2 py-1 rounded bg-emerald-900/80 text-emerald-100 text-[10px] font-mono">
              Se taie și se proiectează…
            </div>
          )}
          {!busy && error && (
            <div className="absolute top-10 left-2 z-20 max-w-sm px-2 py-1 rounded bg-red-900/85 text-red-100 text-[10px] font-mono">
              {error}
            </div>
          )}
          {!busy && !error && drawing && drawing.shapes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="px-3 py-1.5 rounded bg-background/85 border border-border/50 text-xs text-muted-foreground">
                Planul de tăiere nu întâlnește nimic — mută-l sau verifică nivelul.
              </span>
            </div>
          )}

          {/* Cut controls */}
          <div className="absolute bottom-0 left-0 right-0 z-10 px-3 py-1.5 bg-background/90 border-t border-border/40 text-[10px] font-mono flex items-center gap-2">
            <span className="w-52 shrink-0 text-emerald-700">{cutLabel}</span>
            {kind === 'plan' ? (
              <input
                type="range" className="flex-1 h-1 accent-emerald-600 cursor-pointer"
                min={50} max={Math.round(storeyHeight)} step={50}
                value={Math.min(planCutMm, Math.round(storeyHeight))}
                onChange={(e) => setPlanCutMm(Number(e.target.value))}
              />
            ) : (
              <>
                <button
                  onClick={() => setLimitDepth((v) => !v)}
                  className={cn('px-1.5 py-0.5 rounded border transition-colors',
                    limitDepth ? 'bg-slate-600 text-white border-slate-600' : 'border-border/60 hover:bg-accent')}
                  title="Limitează cât se vede dincolo de planul de tăiere"
                >{limitDepth ? 'limitată' : '∞'}</button>
                <input
                  type="range" className="flex-1 h-1 accent-emerald-600 cursor-pointer disabled:opacity-30"
                  min={500} max={100000} step={500}
                  disabled={!limitDepth}
                  value={depthMm}
                  onChange={(e) => setDepthMm(Number(e.target.value))}
                />
              </>
            )}
            <span className="text-muted-foreground shrink-0">{Math.round(zoom * 100)}%</span>
            {tookMs !== null && (
              <span className="text-muted-foreground/60 shrink-0" title="Cât a durat ultima recalculare">
                {Math.round(tookMs)} ms
              </span>
            )}
          </div>

          <div className="absolute bottom-8 right-3 text-[10px] text-muted-foreground pointer-events-none">
            {drawWall ? (wallStart ? 'Al doilea punct · ESC anulează' : 'Primul punct · ESC anulează')
              : annTool ? 'Adnotare · ESC anulează plasarea · Del șterge selecția'
              : openingDrag ? `${Math.round(openingDrag.dist)} mm de la capăt · Alt — pas 1 mm · ESC anulează`
              : 'Shift+drag — pan · Scroll — zoom · Click — selectează · Trage o ușă sau fereastră pe perete'}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Named aliases ────────────────────────────────────────────────────────────

interface OGAlias {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  storeyId?: string;
  tabId?: string;
  initialCutPos?: number;
  initialCutDepth?: number;
  viewDirection?: OGViewDir;
  className?: string;
  embedded?: boolean;
  annotationKey?: string;
  graphicStyle?: string;
}

export function OGFloorPlanViewer(props: OGAlias) {
  return <OGOrthoViewer {...props} viewType="floorplan" />;
}

export function OGSectionViewer({ viewDirection = 'N', ...props }: OGAlias) {
  return <OGOrthoViewer {...props} viewType="section" viewDirection={viewDirection} />;
}

export function OGElevationViewer({ viewDirection = 'N', ...props }: OGAlias) {
  return <OGOrthoViewer {...props} viewType="elevation" viewDirection={viewDirection} />;
}
