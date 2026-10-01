/**
 * Section2DViewer — SVG vertical section renderer.
 *
 * Delegates all geometry to drawingEngine.computeSectionView().
 * This component is a pure rendering layer: DrawingShape[] → SVG elements.
 *
 * The section is LIVE: with a `sectionNodeId` every parameter (marker line,
 * look side, depth, vertical range) is read from that node on each render
 * through `resolveSectionCut`, so dragging the marker in the plan or editing
 * the Inspector redraws the section at once. The `cutY…` props are the
 * fallback for hosts without a node (older sheet viewports).
 *
 * Coordinate system inside this file:
 *   U (drawing horizontal) = along the marker, viewer's right positive
 *   V (drawing vertical)   = BIM elevation (up), positive up
 *   SVG y is flipped: svgY = drawH - (V - vMin)
 */
import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { useBubbleGraphStore } from '@/store';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { computeSectionView, type DrawingResult, type SectionCut } from '@/lib/drawingEngine';
import { useOgProjection } from '@/hooks/useOgProjection';
import { drawingStyle, fitScale } from '@/lib/drawingStyle';
import { autoDimensions, dimensionReach } from '@/lib/drawingDimensions';
import { drawingToDxf } from '@/lib/dxfExport';
import { downloadText, safeFilename } from '@/lib/download';
import { resolveSectionCut, type DepthMode } from '@/lib/sectionFromPlan';
import { SvgHatchDefs } from './SvgHatches';
import { buildDrawingSvg, sheetBounds } from './drawingSvg';
import { AnnotationToolbar, DrawingAnnotationLayer } from './DrawingAnnotations';
import type { SvgAnnotationTool } from './SvgAnnotationLayer';
import { clientToSvgUserPoint } from '@/lib/svgCoordinates';
import { useFitToContent } from '@/hooks/useFitToContent';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hatch tile, in paper millimetres — the pattern is a paper size like a pen. */
const HATCH_TILE_MM = 2.5;

// ─── Props ────────────────────────────────────────────────────────────────────

export interface Section2DViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  cutY?: number;
  cutDepth?: number;
  startElevation?: number;
  endElevation?: number;
  sectionNodeId?: string;
  className?: string;
  embedded?: boolean;
  /** How the drawing looks — lib/drawing/graphicStyle (color, technical, poche, presentation). */
  graphicStyle?: string;
  /** The view's own annotation key (lib/views/drawingViews); absent → the key this drawing used before views. */
  annotationKey?: string;
}

/** "N", "SE", … for the overlay: which way the viewer looks. */
function lookLabel(n: { x: number; y: number }): string {
  const a = Math.atan2(n.y, n.x) * 180 / Math.PI;   // BIM: +x east, +y north
  const names = ['E', 'NE', 'N', 'NV', 'V', 'SV', 'S', 'SE'];
  return names[Math.round(((a + 360) % 360) / 45) % 8];
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Section2DViewer({
  nodes,
  edges,
  cutY: cutYProp = 0,
  cutDepth: cutDepthProp = 6000,
  startElevation: startElevProp,
  endElevation: endElevProp,
  sectionNodeId,
  className,
  embedded = false,
  annotationKey,
  graphicStyle,
}: Section2DViewerProps) {
  // Live params from the section node; props only when there is no node.
  const sectionNode = sectionNodeId ? nodes.find((n) => n.id === sectionNodeId) : undefined;
  const spec = useMemo(
    () => (sectionNode ? resolveSectionCut(sectionNode, nodes, edges) : null),
    [sectionNode, nodes, edges],
  );
  const cutDepth = spec ? spec.depthMm : cutDepthProp;
  const startElev = spec ? spec.elevMin ?? undefined : startElevProp;
  const endElev = spec ? spec.elevMax ?? undefined : endElevProp;

  const { config: matConfig } = useMaterialConfig();
  const setBubbleGraph = useBubbleGraphStore((s) => s.setBubbleGraph);
  const rawNodes = useBubbleGraphStore((s) => s.bubbleGraphNodes);
  const rawEdges = useBubbleGraphStore((s) => s.bubbleGraphEdges);
  const updateProps = useCallback((patch: Record<string, unknown>) => {
    if (!sectionNodeId) return;
    setBubbleGraph(
      rawNodes.map((n) => (n.id === sectionNodeId ? { ...n, properties: { ...n.properties, ...patch } } : n)),
      rawEdges,
    );
  }, [sectionNodeId, rawNodes, rawEdges, setBubbleGraph]);

  const [zoom, setZoom]     = useState(1);
  const [pan, setPan]       = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Frame the drawing when the view opens (or switches to another section).
  useFitToContent({
    svgRef, containerRef, setZoom, setPan,
    viewKey: sectionNodeId ?? `${cutYProp}:${cutDepth}`,
  });

  // ── Geometry from engine ───────────────────────────────────────────────
  // No explicit vertical range means no clipping: a section that stopped at
  // the top storey would cut the roof off the drawing.
  const cut: SectionCut = useMemo(() => spec
    ? { line: spec.line, lookSide: spec.lookSide, cutDepth, clipToLine: spec.clipToMarker, elevMin: startElev, elevMax: endElev }
    : { cutY: cutYProp, cutDepth, elevMin: startElev, elevMax: endElev },
  [spec, cutDepth, cutYProp, startElev, endElev]);
  // Beyond the cut: the kernel's exact outlines with our own hidden-line
  // removal on top, once they arrive. The cut itself is always the engine's.
  const [ogOutlines, setOgOutlines] = useState(true);
  const ogLines = useOgProjection(ogOutlines, nodes, edges, matConfig, cut);
  const drawing: DrawingResult = useMemo(
    () => computeSectionView(nodes, edges, matConfig, cut, ogLines ? { outlines: ogLines } : undefined),
    [nodes, edges, matConfig, cut, ogLines],
  );

  // ── Scale and sheet bounds ─────────────────────────────────────────────
  // The drawing picks the standard scale it fits a sheet at; every pen width
  // and text height then follows from that, in paper millimetres.
  const style = useMemo(
    () => drawingStyle(fitScale(drawing.uMax - drawing.uMin, drawing.vMax - drawing.vMin), graphicStyle),
    [drawing.uMax, drawing.uMin, drawing.vMax, drawing.vMin, graphicStyle],
  );
  // The chains the drawing dimensions itself with, and the room they need.
  const [showDims, setShowDims] = useState(true);
  const dimensions = useMemo(
    () => (showDims ? autoDimensions(drawing, style) : []),
    [showDims, drawing, style],
  );
  const bounds = useMemo(
    () => sheetBounds(drawing, style, dimensionReach(dimensions, drawing)),
    [drawing, style, dimensions],
  );
  const { uMin, vMin, width: drawW, height: drawH } = bounds;

  // toX / toY: drawing-space mm → SVG px (1:1 in viewBox, Y-flipped). The
  // engine already hands back u with the viewer's right positive, so no mirror.
  const toX = useCallback((u: number) => u - uMin, [uMin]);
  const toY = useCallback((v: number) => drawH - (v - vMin), [drawH, vMin]);

  // ── Build SVG elements ─────────────────────────────────────────────────
  const svgShapes = useMemo(
    () => buildDrawingSvg({ drawing, style, bounds, toX, toY, dimensions }),
    [drawing, style, bounds, toX, toY, dimensions],
  );

  // ── Annotations ────────────────────────────────────────────────────────
  // Logical coordinates here are the drawing's own (u, v) in model mm, so an
  // annotation stays where it was put when the section is redrawn at another
  // extent — the bounds move, the drawing coordinates do not.
  const [annTool, setAnnTool] = useState<SvgAnnotationTool | null>(null);
  const annViewId = annotationKey ?? `section:${sectionNodeId ?? `y${cutYProp}`}`;
  const toSvgPt = useCallback((u: number, v: number) => ({ x: toX(u), y: toY(v) }), [toX, toY]);
  const fromSvgEvent = useCallback((e: { clientX: number; clientY: number }) => {
    const p = clientToSvgUserPoint(svgRef.current, e.clientX, e.clientY);
    if (!p) return { x: 0, y: 0 };
    return { x: p.x + uMin, y: vMin + (drawH - p.y) };
  }, [uMin, vMin, drawH]);

  // ── Pan / zoom events ──────────────────────────────────────────────────
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

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (embedded) return;
    if (e.button === 1 || e.shiftKey) {
      setDragging(true);
      lastPos.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    }
  }, [embedded]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    // The delta is taken NOW: the updater may run at the next render, by
    // which time `lastPos` already holds this event and the move is zero.
    const dx = e.clientX - lastPos.current.x, dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, [dragging]);

  const onMouseUp = useCallback(() => setDragging(false), []);

  return (
    <div
      ref={containerRef}
      className={cn('w-full h-full relative overflow-hidden', className)}
      style={{ background: '#f8f7f4' }}
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
        <DrawingAnnotationLayer
          viewId={annViewId}
          style={style}
          drawing={drawing}
          activeTool={embedded ? null : annTool}
          toSvg={toSvgPt}
          fromSvgEvent={fromSvgEvent}
        />
      </svg>

      {!embedded && (
        <>
          <AnnotationToolbar
            viewId={annViewId} activeTool={annTool} onToolChange={setAnnTool}
            leading={<>
              <button
                title="Cote automate — axe și niveluri"
                onClick={() => setShowDims((v) => !v)}
                className={cn(
                  'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none',
                  showDims ? 'bg-slate-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >⟺</button>
              <button
                title={ogOutlines
                  ? (ogLines ? 'Dincolo de tăietură: contur exact + linii ascunse — ce stă în spatele altui element nu se mai vede prin el' : 'Se calculează conturul exact și liniile ascunse…')
                  : 'Dincolo de tăietură: contur încadrător, fără eliminarea liniilor ascunse'}
                onClick={() => setOgOutlines((v) => !v)}
                className={cn(
                  'h-6 px-1.5 flex items-center justify-center text-[10px] rounded transition-colors select-none',
                  ogOutlines ? (ogLines ? 'bg-emerald-700 text-white' : 'bg-emerald-700/50 text-white') : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >OG</button>
            </>}
            trailing={
              <button
                title="Export DXF — geometrie, axe, niveluri și cote, pe straturi"
                onClick={() => downloadText(
                  safeFilename(sectionNode?.name ?? 'sectiune', 'dxf'),
                  drawingToDxf(drawing, style, { dimensions }),
                  'image/vnd.dxf',
                )}
                className="w-6 h-6 flex items-center justify-center text-[10px] rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >DXF</button>
            }
          />
          <div className="absolute bottom-3 left-3 flex items-center gap-1.5 text-[10px] text-muted-foreground bg-background/60 px-1.5 py-0.5 rounded border border-border/40">
            <span title="Scara la care e desenată — grosimile de linie o urmează">{style.label}</span>
            <span className="opacity-40">·</span>
            <span>{Math.round(zoom * 100)}%</span>
          </div>
          <div className="absolute top-2 left-2 flex items-center gap-1.5 text-[10px] text-muted-foreground bg-background/70 px-2 py-1 rounded border border-border/40">
            <span className="pointer-events-none">
              {sectionNode?.name ?? 'Secțiune'}
              {spec ? ` · privire ${lookLabel(spec.normal)}` : ` · Y=${cutYProp}mm`}
            </span>
            {spec && (
              <>
                <button
                  className="px-1.5 py-0.5 rounded border border-border/60 hover:bg-accent"
                  title="Întoarce direcția de privire"
                  onClick={() => updateProps({ look_side: spec.lookSide === 'left' ? 'right' : 'left' })}
                >⇄</button>
                <select
                  className="bg-background border border-border/60 rounded px-1 py-0.5 text-[10px]"
                  value={spec.depthMode}
                  title="Adâncimea secțiunii"
                  onChange={(e) => updateProps({ depth_mode: e.target.value as DepthMode })}
                >
                  <option value="infinite">adâncime ∞</option>
                  <option value="limited">adâncime limitată</option>
                  <option value="zero">doar tăietura</option>
                </select>
                {spec.depthMode === 'limited' && (
                  <input
                    type="number" step={500} min={0}
                    className="w-16 bg-background border border-border/60 rounded px-1 py-0.5 text-[10px]"
                    value={Math.round(spec.depthMm)}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v >= 0) updateProps({ cut_depth_mm: v });
                    }}
                  />
                )}
              </>
            )}
          </div>
          <div className="absolute bottom-3 right-3 text-[10px] text-muted-foreground pointer-events-none">
            Shift+drag — pan · Scroll — zoom
          </div>
        </>
      )}
    </div>
  );
}
