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
import { computeElevationView, type DrawingResult, type DrawingShape, type ElevationDir } from '@/lib/drawingEngine';
import { SvgHatchDefs } from './SvgHatches';
import { useFitToContent } from '@/hooks/useFitToContent';

export type { ElevationDir };

// ─── Constants ────────────────────────────────────────────────────────────────

const PAD  = 60;
const TILE = 6;

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

export interface Elevation2DViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  viewDirection?: ElevationDir;
  startElevation?: number;
  endElevation?: number;
  className?: string;
  embedded?: boolean;
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
    svgRef, containerRef, setZoom, setPan, enabled: !embedded,
    viewKey: viewDirection,
  });

  // ── Geometry from engine ───────────────────────────────────────────────
  const drawing: DrawingResult = useMemo(() => computeElevationView(
    nodes, edges, matConfig, viewDirection, startElevation, endElevation,
  ), [nodes, edges, matConfig, viewDirection, startElevation, endElevation]);

  // ── SVG bounds ─────────────────────────────────────────────────────────
  const uMin  = drawing.uMin  - PAD;
  const uMax  = drawing.uMax  + PAD;
  const vMin  = drawing.vMin  - PAD;
  const vMax  = drawing.vMax  + PAD;
  const drawW = Math.max(uMax - uMin, 1);
  const drawH = Math.max(vMax - vMin, 1);

  const toX = useCallback((u: number) => u - uMin, [uMin]);
  const toY = useCallback((v: number) => drawH - (v - vMin), [drawH, vMin]);

  // ── Build SVG elements ─────────────────────────────────────────────────
  const svgShapes = useMemo(() => {
    const els: React.ReactElement[] = [];

    // Ground line + earth hatch
    const gx0 = toX(uMin);
    const gx1 = toX(uMax);
    const gy0 = toY(0);
    els.push(
      <line key="ground" x1={gx0} y1={gy0} x2={gx1} y2={gy0}
        stroke="#8B5E3C" strokeWidth={LW['heavy-cut'] * 1.5} />,
    );
    if (vMin < 0) {
      els.push(
        <rect key="earth" x={gx0} y={gy0} width={gx1 - gx0} height={toY(vMin) - gy0}
          fill="#c4a882" opacity={0.18} />,
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
      const cy = toY(vMin + PAD * 0.5);
      const r  = PAD * 0.2;
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

    // Storey level lines
    const drawnLevels = new Set<number>();
    for (const lv of drawing.levels) {
      if (drawnLevels.has(lv.vMm)) continue;
      drawnLevels.add(lv.vMm);
      const y  = toY(lv.vMm);
      const x0 = toX(uMin + PAD * 0.3);
      const x1 = toX(uMax - PAD * 0.3);
      els.push(
        <line key={`lv-${lv.vMm}`} x1={x0} y1={y} x2={x1} y2={y}
          stroke="#94a3b8" strokeWidth={LW['annotation']}
          strokeDasharray="10 4" opacity={0.45} />,
      );
    }

    // ── Main geometry ──────────────────────────────────────────────────
    // Collected into its own group (rather than straight into `els`) so
    // useFitToContent can frame the BUILDING: the surrounding chrome — earth
    // fill, axis grid, level lines — spans the view's full elevation range,
    // which for the default facades is −5000…15000 mm regardless of how tall
    // the building actually is. Drawing order is unchanged: the group sits
    // exactly where these shapes were pushed.
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
        if (sh.fillColor && sh.fillColor !== 'none') {
          shapeEls.push(
            <polygon key={`bg-${i}`} points={points}
              fill={sh.fillColor} opacity={isProj ? 0.4 : 0.85} />,
          );
        }
        if (sh.hatch && sh.hatch !== 'none' && sh.hatch !== 'solid') {
          shapeEls.push(
            <polygon key={`ht-${i}`} points={points}
              fill={`url(#hatch-${sh.hatch})`}
              color={sh.strokeColor}
              opacity={isProj ? 0.2 : 0.45} />,
          );
        }
        shapeEls.push(
          <polygon key={`ol-${i}`} points={points}
            fill="none"
            stroke={sh.strokeColor}
            strokeWidth={sw}
            strokeDasharray={DASH[sh.lineWeight]}
            opacity={isProj ? 0.55 : 1} />,
        );
      } else {
        const d = `M ${xs[0].toFixed(2)},${ys[0].toFixed(2)} ` +
          xs.slice(1).map((x, j) => `L ${x.toFixed(2)},${ys[j + 1].toFixed(2)}`).join(' ');
        shapeEls.push(
          <path key={`ln-${i}`} d={d}
            fill="none" stroke={sh.strokeColor}
            strokeWidth={sw} strokeDasharray={DASH[sh.lineWeight]} />,
        );
      }
    }
    els.push(<g key="geom" data-fit-target="">{shapeEls}</g>);

    // ── Elevation dimension bar (right) ────────────────────────────────
    const barX = toX(drawing.uMax + PAD * 0.55);
    const seen = new Set<number>();
    for (const lv of drawing.levels) {
      if (seen.has(lv.vMm)) continue;
      seen.add(lv.vMm);
      const y  = toY(lv.vMm);
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

    // View direction label
    const dirLabel: Record<ElevationDir, string> = {
      N: 'North Elevation', S: 'South Elevation',
      E: 'East Elevation',  W: 'West Elevation',
    };
    els.push(
      <text key="dir-lbl"
        x={toX((uMin + uMax) / 2)} y={toY(vMax - PAD * 0.3)}
        textAnchor="middle" dominantBaseline="central"
        fontSize={PAD * 0.28} fontFamily="sans-serif" fontWeight="600" fill="#475569">
        {dirLabel[viewDirection]}
      </text>,
    );

    return els;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, viewDirection, toX, toY, uMin, uMax, vMin, vMax, drawH]);

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
          <div className="absolute bottom-3 right-3 text-[10px] text-muted-foreground pointer-events-none">
            Shift+drag — pan · Scroll — zoom
          </div>
        </>
      )}
    </div>
  );
}
