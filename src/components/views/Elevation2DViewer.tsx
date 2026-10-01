/**
 * Elevation2DViewer — SVG external elevation renderer.
 *
 * Delegates all geometry to drawingEngine.computeElevationView().
 * Rendering is identical in structure to Section2DViewer.
 *
 * Coordinate system:
 *   U (horizontal) = function of view direction (see drawingEngine.ts)
 *   V (vertical)   = BIM elevation mm (positive = up)
 *   SVG y = drawH - (V - vMin)  (flipped)
 */
import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { computeElevationView, elevationCut, type DrawingResult, type ElevationDir } from '@/lib/drawingEngine';
import { useOgProjection } from '@/hooks/useOgProjection';
import { TEXT, drawingStyle, fitScale } from '@/lib/drawingStyle';
import { autoDimensions, dimensionReach } from '@/lib/drawingDimensions';
import { drawingToDxf } from '@/lib/dxfExport';
import { downloadText, safeFilename } from '@/lib/download';
import { SvgHatchDefs } from './SvgHatches';
import { buildDrawingSvg, sheetBounds } from './drawingSvg';
import { AnnotationToolbar, DrawingAnnotationLayer } from './DrawingAnnotations';
import type { SvgAnnotationTool } from './SvgAnnotationLayer';
import { clientToSvgUserPoint } from '@/lib/svgCoordinates';
import { useFitToContent } from '@/hooks/useFitToContent';

export type { ElevationDir };

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hatch tile, in paper millimetres — the pattern is a paper size like a pen. */
const HATCH_TILE_MM = 2.5;

const DIR_LABEL: Record<ElevationDir, string> = {
  N: 'Fațada nord', S: 'Fațada sud',
  E: 'Fațada est',  W: 'Fațada vest',
};

// ─── Props ────────────────────────────────────────────────────────────────────

export interface Elevation2DViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  viewDirection?: ElevationDir;
  startElevation?: number;
  endElevation?: number;
  className?: string;
  embedded?: boolean;
  /** How the drawing looks — lib/drawing/graphicStyle (color, technical, poche, presentation). */
  graphicStyle?: string;
  /** The view's own annotation key (lib/views/drawingViews); absent → the key this drawing used before views. */
  annotationKey?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Elevation2DViewer({
  nodes,
  edges,
  viewDirection = 'N',
  startElevation,
  endElevation,
  className,
  embedded = false,
  annotationKey,
  graphicStyle,
}: Elevation2DViewerProps) {
  const { config: matConfig } = useMaterialConfig();

  const [zoom, setZoom]         = useState(1);
  const [pan, setPan]           = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const lastPos    = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Frame the facade when the view opens (or switches to another direction).
  useFitToContent({
    svgRef, containerRef, setZoom, setPan,
    viewKey: viewDirection,
  });

  // ── Geometry from engine ───────────────────────────────────────────────
  // The kernel's exact outlines with our own hidden-line removal on top,
  // once they have arrived; until then the engine's own facade, as before.
  const [ogOutlines, setOgOutlines] = useState(true);
  const cut = useMemo(
    () => elevationCut(nodes, viewDirection, startElevation, endElevation),
    [nodes, viewDirection, startElevation, endElevation],
  );
  const ogLines = useOgProjection(ogOutlines, nodes, edges, matConfig, cut);
  const drawing: DrawingResult = useMemo(() => computeElevationView(
    nodes, edges, matConfig, viewDirection, startElevation, endElevation,
    ogLines ? { outlines: ogLines } : undefined,
  ), [nodes, edges, matConfig, viewDirection, startElevation, endElevation, ogLines]);

  // ── Scale and sheet bounds ─────────────────────────────────────────────
  // The facade picks the standard scale it fits a sheet at; every pen width
  // and text height then follows from that, in paper millimetres.
  const style = useMemo(
    () => drawingStyle(fitScale(drawing.uMax - drawing.uMin, drawing.vMax - drawing.vMin), graphicStyle),
    [drawing.uMax, drawing.uMin, drawing.vMax, drawing.vMin, graphicStyle],
  );
  // A facade also dimensions its own openings — the row a bricklayer sets out
  // from — nearest the drawing, under the axis grid.
  const [showDims, setShowDims] = useState(true);
  const dimensions = useMemo(
    () => (showDims ? autoDimensions(drawing, style, { openings: true }) : []),
    [showDims, drawing, style],
  );
  const bounds = useMemo(
    () => sheetBounds(drawing, style, dimensionReach(dimensions, drawing)),
    [drawing, style, dimensions],
  );
  const { uMin, uMax, vMin, vMax, width: drawW, height: drawH } = bounds;

  const toX = useCallback((u: number) => u - uMin, [uMin]);
  const toY = useCallback((v: number) => drawH - (v - vMin), [drawH, vMin]);

  // ── Build SVG elements ─────────────────────────────────────────────────
  const svgShapes = useMemo(() => [
    ...buildDrawingSvg({ drawing, style, bounds, toX, toY, dimensions }),
    // Which facade this is, over the drawing.
    <text key="dir-lbl"
      x={toX((uMin + uMax) / 2)} y={toY(vMax - style.paper(4))}
      textAnchor="middle" dominantBaseline="central"
      fontSize={style.text(TEXT.large)} fontFamily="sans-serif" fontWeight="600" fill="#475569">
      {DIR_LABEL[viewDirection]}
    </text>,
  ], [drawing, style, bounds, toX, toY, uMin, uMax, vMax, viewDirection, dimensions]);

  // ── Annotations ────────────────────────────────────────────────────────
  // Logical coordinates here are the drawing's own (u, v) in model mm, so an
  // annotation stays on the facade when the drawing is reframed.
  const [annTool, setAnnTool] = useState<SvgAnnotationTool | null>(null);
  const annViewId = annotationKey ?? `elevation:${viewDirection}`;
  const toSvgPt = useCallback((u: number, v: number) => ({ x: toX(u), y: toY(v) }), [toX, toY]);
  const fromSvgEvent = useCallback((e: { clientX: number; clientY: number }) => {
    const p = clientToSvgUserPoint(svgRef.current, e.clientX, e.clientY);
    if (!p) return { x: 0, y: 0 };
    return { x: p.x + uMin, y: vMin + (drawH - p.y) };
  }, [uMin, vMin, drawH]);

  // ── Wheel zoom ─────────────────────────────────────────────────────────
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
                title="Cote automate — goluri, axe și niveluri"
                onClick={() => setShowDims((v) => !v)}
                className={cn(
                  'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none',
                  showDims ? 'bg-slate-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >⟺</button>
              <button
                title={ogOutlines
                  ? (ogLines ? 'Contur exact + linii ascunse: silueta reală a fiecărui element (cu goluri), iar ce stă în spatele altui element nu se mai vede prin el' : 'Se calculează conturul exact și liniile ascunse…')
                  : 'Contur încadrător, fără eliminarea liniilor ascunse'}
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
                  safeFilename(DIR_LABEL[viewDirection], 'dxf'),
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
          <div className="absolute bottom-3 right-3 text-[10px] text-muted-foreground pointer-events-none">
            Shift+drag — pan · Scroll — zoom
          </div>
        </>
      )}
    </div>
  );
}
