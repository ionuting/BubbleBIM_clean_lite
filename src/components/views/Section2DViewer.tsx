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
import { computeSectionView, type DrawingResult, type DrawingShape, type SectionCut } from '@/lib/drawingEngine';
import { resolveSectionCut, type DepthMode } from '@/lib/sectionFromPlan';
import { SvgHatchDefs } from './SvgHatches';
import { useFitToContent } from '@/hooks/useFitToContent';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAD = 60;     // padding in drawing-space mm
const TILE = 6;     // hatch tile size in drawing-space mm

// Stroke widths per line-weight category (drawing-space mm)
const LW: Record<DrawingShape['lineWeight'], number> = {
  'heavy-cut':  0.6,
  'medium-cut': 0.4,
  'projected':  0.25,
  'annotation': 0.2,
  'hidden':     0.15,
};
const DASH: Record<DrawingShape['lineWeight'], string | undefined> = {
  'heavy-cut':  undefined,
  'medium-cut': undefined,
  'projected':  undefined,
  'annotation': undefined,
  'hidden':     '3 2',
};

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
    svgRef, containerRef, setZoom, setPan, enabled: !embedded,
    viewKey: sectionNodeId ?? `${cutYProp}:${cutDepth}`,
  });

  // ── Elevation range ────────────────────────────────────────────────────
  const storeys = useMemo(() => nodes.filter((n) => n.type === 'storey'), [nodes]);
  const elevMin = startElev ?? (storeys.length
    ? Math.min(0, ...storeys.map((s) => Number(s.properties.bottomElevation ?? 0)))
    : 0);
  const elevMax = endElev ?? (storeys.length
    ? Math.max(3000, ...storeys.map((s) => Number(s.properties.topElevation ?? 3000)))
    : 3000);

  // ── Geometry from engine ───────────────────────────────────────────────
  const cut: SectionCut = useMemo(() => spec
    ? { line: spec.line, lookSide: spec.lookSide, cutDepth, clipToLine: spec.clipToMarker, elevMin, elevMax }
    : { cutY: cutYProp, cutDepth, elevMin, elevMax },
  [spec, cutDepth, cutYProp, elevMin, elevMax]);
  const drawing: DrawingResult = useMemo(
    () => computeSectionView(nodes, edges, matConfig, cut),
    [nodes, edges, matConfig, cut],
  );

  // ── SVG bounds (drawing-space mm, padded) ──────────────────────────────
  const uMin = drawing.uMin - PAD;
  const uMax = drawing.uMax + PAD;
  const vMin = drawing.vMin - PAD;
  const vMax = drawing.vMax + PAD;
  const drawW = Math.max(uMax - uMin, 1);
  const drawH = Math.max(vMax - vMin, 1);

  // toX / toY: drawing-space mm → SVG px (1:1 in viewBox, Y-flipped). The
  // engine already hands back u with the viewer's right positive, so no mirror.
  const toX = useCallback((u: number) => u - uMin, [uMin]);
  const toY = useCallback((v: number) => drawH - (v - vMin), [drawH, vMin]);

  // ── Build SVG elements ─────────────────────────────────────────────────
  const svgShapes = useMemo(() => {
    const els: React.ReactElement[] = [];

    // Ground / earth fill below elevation 0
    if (vMin < 0) {
      const gx0 = toX(drawing.uMin - PAD * 0.5);
      const gx1 = toX(drawing.uMax + PAD * 0.5);
      const gy0 = toY(0);
      const gy1 = toY(vMin);
      els.push(
        <rect key="earth-bg" x={Math.min(gx0, gx1)} y={gy0}
          width={Math.abs(gx1 - gx0)} height={gy1 - gy0}
          fill="#c4a882" opacity={0.18} />,
        <line key="ground-line"
          x1={Math.min(gx0, gx1)} y1={gy0}
          x2={Math.max(gx0, gx1)} y2={gy0}
          stroke="#8B5E3C" strokeWidth={LW['heavy-cut'] * 1.5} />,
      );
    }

    // Axis grid lines
    for (const ax of drawing.axes) {
      const x = toX(ax.u);
      const y0 = toY(vMax - PAD * 0.3);
      const y1 = toY(vMin + PAD * 0.3);
      els.push(
        <line key={`ax-${ax.u}`} x1={x} y1={y0} x2={x} y2={y1}
          stroke="#d946ef" strokeWidth={LW['annotation'] * 0.9}
          strokeDasharray="5 3" opacity={0.4} />,
      );
      // Axis bubble at bottom
      const cy = toY(vMin + PAD * 0.5);
      const r = PAD * 0.2;
      els.push(
        <g key={`axlb-${ax.u}`}>
          <circle cx={x} cy={cy} r={r}
            fill="white" stroke="#d946ef" strokeWidth={LW['annotation']} opacity={0.7} />
          <text x={x} y={cy} textAnchor="middle" dominantBaseline="central"
            fontSize={r * 1.1} fontFamily="sans-serif" fill="#9d00c4" fontWeight="500">
            {ax.label}
          </text>
        </g>,
      );
    }

    // Storey level lines (thin dashed)
    const drawnLevels = new Set<number>();
    for (const lv of drawing.levels) {
      if (drawnLevels.has(lv.vMm)) continue;
      drawnLevels.add(lv.vMm);
      const y = toY(lv.vMm);
      const x0 = toX(drawing.uMin - PAD * 0.3);
      const x1 = toX(drawing.uMax + PAD * 0.3);
      els.push(
        <line key={`lv-${lv.vMm}`} x1={Math.min(x0, x1)} y1={y} x2={Math.max(x0, x1)} y2={y}
          stroke="#94a3b8" strokeWidth={LW['annotation']}
          strokeDasharray="10 4" opacity={0.5} />,
      );
    }

    // ── Main geometry shapes (sorted back→front by engine) ─────────────
    // Grouped so useFitToContent frames the BUILDING rather than the
    // full-range chrome (earth fill, axis grid, level lines), which spans
    // the section's whole elevation range. Drawing order is unchanged.
    const shapeEls: React.ReactElement[] = [];
    for (let i = 0; i < drawing.shapes.length; i++) {
      const sh = drawing.shapes[i];
      if (sh.pts.length < 2) continue;

      const xs = sh.pts.map((p) => toX(p.u));
      const ys = sh.pts.map((p) => toY(p.v));
      const points = xs.map((x, j) => `${x.toFixed(2)},${ys[j].toFixed(2)}`).join(' ');
      const sw = LW[sh.lineWeight];
      const isProj = sh.lineWeight === 'projected' || sh.lineWeight === 'hidden';

      if (sh.closed && sh.pts.length >= 3) {
        // 1. Solid fill background
        if (sh.fillColor && sh.fillColor !== 'none') {
          shapeEls.push(
            <polygon key={`bg-${i}`} points={points}
              fill={sh.fillColor} opacity={isProj ? 0.35 : 0.9} />,
          );
        }
        // 2. Hatch overlay (pattern uses currentColor = strokeColor)
        if (sh.hatch && sh.hatch !== 'none' && sh.hatch !== 'solid') {
          shapeEls.push(
            <polygon key={`ht-${i}`} points={points}
              fill={`url(#hatch-${sh.hatch})`}
              color={sh.strokeColor}
              opacity={isProj ? 0.25 : 0.5} />,
          );
        }
        // 3. Outline
        shapeEls.push(
          <polygon key={`ol-${i}`} points={points}
            fill="none"
            stroke={sh.strokeColor}
            strokeWidth={sw}
            strokeDasharray={DASH[sh.lineWeight]}
            opacity={isProj ? 0.55 : 1} />,
        );
      } else {
        // Open polyline
        const d = `M ${xs[0].toFixed(2)},${ys[0].toFixed(2)} ` +
          xs.slice(1).map((x, j) => `L ${x.toFixed(2)},${ys[j + 1].toFixed(2)}`).join(' ');
        shapeEls.push(
          <path key={`ln-${i}`} d={d}
            fill="none"
            stroke={sh.strokeColor}
            strokeWidth={sw}
            strokeDasharray={DASH[sh.lineWeight]} />,
        );
      }
    }
    els.push(<g key="geom" data-fit-target="">{shapeEls}</g>);

    // ── Elevation dimension bar (right side) ───────────────────────────
    {
      const barX = toX(drawing.uMax + PAD * 0.55);
      const seen = new Set<number>();
      for (const lv of drawing.levels) {
        if (seen.has(lv.vMm)) continue;
        seen.add(lv.vMm);
        const y = toY(lv.vMm);
        const tk = PAD * 0.08;
        els.push(
          <line key={`tk-${lv.vMm}`}
            x1={barX - tk} y1={y} x2={barX + tk} y2={y}
            stroke="#64748b" strokeWidth={LW['annotation']} />,
          <text key={`tv-${lv.vMm}`}
            x={barX + tk * 1.5} y={y}
            textAnchor="start" dominantBaseline="central"
            fontSize={PAD * 0.2} fontFamily="monospace" fill="#475569">
            {lv.label}
          </text>,
        );
      }
    }

    return els;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, toX, toY, uMin, uMax, vMin, vMax, drawW, drawH]);

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
    setPan((p) => ({ x: p.x + e.clientX - lastPos.current.x, y: p.y + e.clientY - lastPos.current.y }));
    lastPos.current = { x: e.clientX, y: e.clientY };
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
        <SvgHatchDefs tileSize={TILE} />
        {svgShapes}
      </svg>

      {!embedded && (
        <>
          <div className="absolute bottom-3 left-3 text-[10px] text-muted-foreground bg-background/60 px-1.5 py-0.5 rounded border border-border/40">
            {Math.round(zoom * 100)}%
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
