/**
 * AxisInteraxOverlay — perspective-projected 3D dimension lines.
 *
 * Renders BIM axis inter-ax dimensions directly in 3D viewport space by
 * projecting BIM coordinates to screen pixels on every animation frame.
 *
 * Layout (matches ArchiCAD / AutoCAD dimension convention):
 *   • X dimension line — at (axX[i], axY[0] - STANDOFF, minBot)  one handle per X-axis
 *   • Y dimension line — at (axX[0] - STANDOFF, axY[j], minBot)  one handle per Y-axis
 *   • Extension lines  — from each axis on the building edge to its handle
 *   • Standoff arrows  — "2000 mm" annotation showing standoff distance
 *
 * Interaction:
 *   • Drag a handle ? moves that axis, updating store on pointer-up
 *   • Click a dimension label ? opens inline <input> for precise mm entry
 *   • Both changes auto-save (debounced 800 ms)
 */

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import type { BubbleGraphNode } from '@/store';
import { useBubbleGraphStore } from '@/store';
import { saveGraph } from '@/lib/api';

// -- Constants -----------------------------------------------------------------

const STANDOFF_MM  = 2000;
const MIN_GAP_MM   = 10;
const CROSS_ARM    = 7;
const HANDLE_R     = 5;
const ARROW_SIZE   = 7;
const LABEL_MIN_PX = 42;

// -- Types ---------------------------------------------------------------------

export type Pt2D = { x: number; y: number };

export interface AxisInteraxOverlayProps {
  nodes: BubbleGraphNode[];
  projectBimPoint: (bimX: number, bimY: number, bimZ: number) => Pt2D | null;
  viewerReady?: boolean;
}

interface HandleData {
  pt:    Pt2D | null;
  extPt: Pt2D | null;
  axMm:  number;
  idx:   number;
}

interface Layout {
  xHandles:  HandleData[];
  yHandles:  HandleData[];
  xSoBase:   Pt2D | null;
  xSoTip:    Pt2D | null;
  ySoBase:   Pt2D | null;
  ySoTip:    Pt2D | null;
}

// -- Helpers -------------------------------------------------------------------

function parseAxes(v: unknown): number[] {
  if (Array.isArray(v)) return (v as unknown[]).map(Number).filter(isFinite);
  if (typeof v === 'string') return v.split(/[,;|\s]+/).map(Number).filter(isFinite);
  return [];
}

function fmtMm(mm: number): string {
  const r = Math.round(Math.abs(mm));
  if (r >= 10000) return `${(r / 1000).toFixed(2)} m`;
  if (r >= 1000)  return `${(r / 1000).toFixed(3)} m`;
  return `${r} mm`;
}

function arrowPath(tip: Pt2D, dir: Pt2D, size = ARROW_SIZE): string {
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y);
  if (len < 1e-5) return '';
  const ux = dir.x / len, uy = dir.y / len;
  const p1x = tip.x - ux * size - uy * size * 0.4;
  const p1y = tip.y - uy * size + ux * size * 0.4;
  const p2x = tip.x - ux * size + uy * size * 0.4;
  const p2y = tip.y - uy * size - ux * size * 0.4;
  return `M${p1x.toFixed(1)},${p1y.toFixed(1)} L${tip.x.toFixed(1)},${tip.y.toFixed(1)} L${p2x.toFixed(1)},${p2y.toFixed(1)}`;
}

function crossPath(p: Pt2D): string {
  const { x, y } = p;
  return (
    `M${(x - CROSS_ARM).toFixed(1)},${(y - CROSS_ARM).toFixed(1)} ` +
    `L${(x + CROSS_ARM).toFixed(1)},${(y + CROSS_ARM).toFixed(1)} ` +
    `M${(x + CROSS_ARM).toFixed(1)},${(y - CROSS_ARM).toFixed(1)} ` +
    `L${(x - CROSS_ARM).toFixed(1)},${(y + CROSS_ARM).toFixed(1)}`
  );
}

// -- Component -----------------------------------------------------------------

export function AxisInteraxOverlay({
  nodes,
  projectBimPoint,
  viewerReady = false,
}: AxisInteraxOverlayProps) {
  const updateStoreyAxes = useBubbleGraphStore((s) => s.updateStoreyAxes);
  const activeStoreyId   = useBubbleGraphStore((s) => s.activeStoreyId);
  const allNodes         = useBubbleGraphStore((s) => s.bubbleGraphNodes);
  const allEdges         = useBubbleGraphStore((s) => s.bubbleGraphEdges);
  const buildingAxes     = useBubbleGraphStore((s) => s.buildingAxes);

  const storeyNode = useMemo(
    () => (activeStoreyId ? nodes.find((n) => n.id === activeStoreyId && n.type === 'storey') : null),
    [nodes, activeStoreyId],
  );

  const axX = useMemo(
    () => parseAxes(storeyNode?.properties?.axesX).sort((a, b) => a - b),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeyNode?.properties?.axesX],
  );
  const axY = useMemo(
    () => parseAxes(storeyNode?.properties?.axesY).sort((a, b) => a - b),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeyNode?.properties?.axesY],
  );
  const minBot = useMemo(
    () => Number(storeyNode?.properties?.bottomElevation ?? 0),
    [storeyNode],
  );

  const [liveAxX, setLiveAxX] = useState<number[]>([]);
  const [liveAxY, setLiveAxY] = useState<number[]>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setLiveAxX(axX), [axX.join(',')]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setLiveAxY(axY), [axY.join(',')]);

  // -- rAF projection loop ---------------------------------------------------

  const [layout, setLayout] = useState<Layout | null>(null);

  const projectRef = useRef(projectBimPoint);
  const liveAxXRef = useRef(liveAxX);
  const liveAxYRef = useRef(liveAxY);
  const minBotRef  = useRef(minBot);

  useEffect(() => { projectRef.current = projectBimPoint; }, [projectBimPoint]);
  useEffect(() => { liveAxXRef.current = liveAxX; },        [liveAxX]);
  useEffect(() => { liveAxYRef.current = liveAxY; },        [liveAxY]);
  useEffect(() => { minBotRef.current  = minBot;  },        [minBot]);

  useEffect(() => {
    if (!viewerReady) return;
    let animId: number;
    const tick = () => {
      const proj = projectRef.current;
      const axX  = liveAxXRef.current;
      const axY  = liveAxYRef.current;
      const bot  = minBotRef.current;

      if (axX.length < 1 && axY.length < 1) { animId = requestAnimationFrame(tick); return; }

      const minX      = axX.length ? axX[0] : 0;
      const minY      = axY.length ? axY[0] : 0;
      const standoffY = minY - STANDOFF_MM;
      const standoffX = minX - STANDOFF_MM;

      setLayout({
        xHandles: axX.map((mm, i) => ({
          pt:    proj(mm, standoffY, bot),
          extPt: proj(mm, minY,      bot),
          axMm: mm, idx: i,
        })),
        yHandles: axY.map((mm, j) => ({
          pt:    proj(standoffX, mm, bot),
          extPt: proj(minX,      mm, bot),
          axMm: mm, idx: j,
        })),
        xSoBase: proj(minX, minY,      bot),
        xSoTip:  proj(minX, standoffY, bot),
        ySoBase: proj(minX, minY,      bot),
        ySoTip:  proj(standoffX, minY, bot),
      });

      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [viewerReady]);

  // -- Drag -----------------------------------------------------------------

  interface DragState {
    dir: 'X' | 'Y';
    idx: number;
    startClientX: number;
    startClientY: number;
    startMm: number;
    dimDirX: number;
    dimDirY: number;
    mmPerPx: number;
  }

  const dragRef  = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  const getDimScale = useCallback((handles: HandleData[], axes: number[]) => {
    const valid = handles.filter((h) => h.pt !== null);
    if (valid.length < 2) return { dx: 1, dy: 0, mmPerPx: 1 };
    const first = valid[0], last = valid[valid.length - 1];
    const sdx = last.pt!.x - first.pt!.x;
    const sdy = last.pt!.y - first.pt!.y;
    const screenLen = Math.sqrt(sdx * sdx + sdy * sdy);
    const bimSpan   = Math.abs(axes[axes.length - 1] - axes[0]);
    if (screenLen < 1 || bimSpan < 1) return { dx: 1, dy: 0, mmPerPx: 1 };
    return { dx: sdx / screenLen, dy: sdy / screenLen, mmPerPx: bimSpan / screenLen };
  }, []);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<SVGGElement>, dir: 'X' | 'Y', idx: number) => {
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDragging(true);
      const handles = dir === 'X' ? (layout?.xHandles ?? []) : (layout?.yHandles ?? []);
      const axes    = dir === 'X' ? liveAxX : liveAxY;
      const { dx, dy, mmPerPx } = getDimScale(handles, axes);
      dragRef.current = {
        dir, idx,
        startClientX: e.clientX, startClientY: e.clientY,
        startMm: axes[idx],
        dimDirX: dx, dimDirY: dy, mmPerPx,
      };
    },
    [layout, liveAxX, liveAxY, getDimScale],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dpx = e.clientX - d.startClientX;
      const dpy = e.clientY - d.startClientY;
      const projection = dpx * d.dimDirX + dpy * d.dimDirY;
      const newAxMm    = d.startMm + projection * d.mmPerPx;
      const axes = [...(d.dir === 'X' ? liveAxX : liveAxY)];
      const lo   = d.idx > 0               ? axes[d.idx - 1] + MIN_GAP_MM : -Infinity;
      const hi   = d.idx < axes.length - 1 ? axes[d.idx + 1] - MIN_GAP_MM :  Infinity;
      axes[d.idx] = Math.round(Math.min(hi, Math.max(lo, newAxMm)));
      if (d.dir === 'X') setLiveAxX(axes);
      else               setLiveAxY(axes);
    },
    [liveAxX, liveAxY],
  );

  const triggerSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try { await saveGraph({ nodes: allNodes, edges: allEdges, buildingAxes }); }
      catch (err) { console.warn('[AxisInteraxOverlay] auto-save failed', err); }
    }, 800);
  }, [allNodes, allEdges, buildingAxes]);

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    if (!d) { setDragging(false); return; }
    dragRef.current = null;
    setDragging(false);
    const axes     = d.dir === 'X' ? liveAxX : liveAxY;
    const origAxes = d.dir === 'X' ? axX      : axY;
    if (activeStoreyId && Math.abs(axes[d.idx] - (origAxes[d.idx] ?? 0)) > 0.5) {
      updateStoreyAxes(activeStoreyId, d.dir, d.idx, axes[d.idx]);
      triggerSave();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveAxX, liveAxY, axX, axY, activeStoreyId, updateStoreyAxes, triggerSave]);

  // -- Auto-save -------------------------------------------------------------

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); }, []);

  // -- Inline edit -----------------------------------------------------------

  interface EditState { dir: 'X' | 'Y'; i: number; px: number; py: number; val: string }
  const [editState, setEditState] = useState<EditState | null>(null);

  const openEdit = useCallback((dir: 'X' | 'Y', i: number) => {
    const handles = dir === 'X' ? (layout?.xHandles ?? []) : (layout?.yHandles ?? []);
    const axes    = dir === 'X' ? liveAxX : liveAxY;
    if (i + 1 >= axes.length || !handles[i]?.pt || !handles[i + 1]?.pt) return;
    const px   = (handles[i].pt!.x + handles[i + 1].pt!.x) / 2;
    const py   = (handles[i].pt!.y + handles[i + 1].pt!.y) / 2;
    setEditState({ dir, i, px, py, val: String(Math.round(axes[i + 1] - axes[i])) });
  }, [layout, liveAxX, liveAxY]);

  const commitEdit = useCallback(() => {
    if (!editState || !activeStoreyId) { setEditState(null); return; }
    const dist = parseFloat(editState.val);
    if (isFinite(dist) && dist >= MIN_GAP_MM) {
      const axes = [...(editState.dir === 'X' ? liveAxX : liveAxY)];
      const hi   = editState.i + 2 < axes.length ? axes[editState.i + 2] - MIN_GAP_MM : Infinity;
      axes[editState.i + 1] = Math.round(Math.min(hi, axes[editState.i] + dist));
      if (editState.dir === 'X') setLiveAxX(axes);
      else                       setLiveAxY(axes);
      updateStoreyAxes(activeStoreyId, editState.dir, editState.i + 1, axes[editState.i + 1]);
      triggerSave();
    }
    setEditState(null);
  }, [editState, activeStoreyId, liveAxX, liveAxY, updateStoreyAxes, triggerSave]);

  // -- Early-out -------------------------------------------------------------

  if (!storeyNode || !viewerReady || !layout) return null;
  if (liveAxX.length < 1 && liveAxY.length < 1) return null;

  // -- Colours ---------------------------------------------------------------

  const C_DIM    = 'rgba(240,240,220,0.93)';
  const C_EXT    = 'rgba(180,200,230,0.45)';
  const C_HFILL  = 'rgba(15,30,60,0.88)';
  const C_HSTK   = 'rgba(170,210,255,0.97)';
  const C_LBBG   = 'rgba(8,18,40,0.78)';
  const C_LBLTXT = 'rgba(230,240,255,0.97)';
  const C_SO     = 'rgba(255,210,80,0.82)';

  // -- Sub-components --------------------------------------------------------

  const DimSegment = ({
    h0, h1, dist, dir: d, segIdx,
  }: {
    h0: Pt2D; h1: Pt2D; dist: number; dir: 'X' | 'Y'; segIdx: number;
  }) => {
    const mx  = (h0.x + h1.x) / 2;
    const my  = (h0.y + h1.y) / 2;
    const ang = Math.atan2(h1.y - h0.y, h1.x - h0.x) * 180 / Math.PI;
    const len = Math.sqrt((h1.x - h0.x) ** 2 + (h1.y - h0.y) ** 2);
    return (
      <g>
        <line x1={h0.x} y1={h0.y} x2={h1.x} y2={h1.y} stroke={C_DIM} strokeWidth="1.4" />
        <path d={arrowPath(h0, { x: h0.x - h1.x, y: h0.y - h1.y })} stroke={C_DIM} strokeWidth="1.2" fill="none" />
        <path d={arrowPath(h1, { x: h1.x - h0.x, y: h1.y - h0.y })} stroke={C_DIM} strokeWidth="1.2" fill="none" />
        {len >= LABEL_MIN_PX && (
          <g
            transform={`translate(${mx.toFixed(1)},${my.toFixed(1)}) rotate(${ang.toFixed(1)})`}
            style={{ cursor: 'text', pointerEvents: 'auto' }}
            onClick={() => openEdit(d, segIdx)}
          >
            <rect x="-26" y="-9" width="52" height="15" rx="3" fill={C_LBBG} />
            <text textAnchor="middle" y="1.5" fontSize="10" fill={C_LBLTXT} style={{ userSelect: 'none' }}>
              {fmtMm(dist)}
            </text>
          </g>
        )}
      </g>
    );
  };

  const HandleMark = ({
    pt, dir: d, idx, canDrag,
  }: {
    pt: Pt2D; dir: 'X' | 'Y'; idx: number; canDrag: boolean;
  }) => (
    <g
      style={{ pointerEvents: 'auto', cursor: canDrag ? 'crosshair' : 'default' }}
      onPointerDown={canDrag ? (e) => onHandlePointerDown(e, d, idx) : undefined}
    >
      <circle cx={pt.x} cy={pt.y} r={HANDLE_R + 6} fill="transparent" />
      <path d={crossPath(pt)} stroke={C_HSTK} strokeWidth="2" fill="none" />
      <circle cx={pt.x} cy={pt.y} r={HANDLE_R} fill={C_HFILL} stroke={C_HSTK} strokeWidth="1.5" />
    </g>
  );

  const StandoffArrow = ({ base, tip }: { base: Pt2D; tip: Pt2D }) => {
    const mx  = (base.x + tip.x) / 2;
    const my  = (base.y + tip.y) / 2;
    const len = Math.sqrt((tip.x - base.x) ** 2 + (tip.y - base.y) ** 2);
    const ang = Math.atan2(tip.y - base.y, tip.x - base.x) * 180 / Math.PI;
    return (
      <g>
        <line x1={base.x} y1={base.y} x2={tip.x} y2={tip.y} stroke={C_SO} strokeWidth="1.2" />
        <path d={arrowPath(base, { x: base.x - tip.x, y: base.y - tip.y }, 6)} stroke={C_SO} strokeWidth="1" fill="none" />
        <path d={arrowPath(tip,  { x: tip.x - base.x, y: tip.y - base.y }, 6)} stroke={C_SO} strokeWidth="1" fill="none" />
        {len > 32 && (
          <g transform={`translate(${mx.toFixed(1)},${my.toFixed(1)}) rotate(${ang.toFixed(1)})`}>
            <rect x="-26" y="-9" width="52" height="14" rx="3" fill={C_LBBG} />
            <text textAnchor="middle" y="1.5" fontSize="9" fill={C_SO} style={{ userSelect: 'none' }}>
              {fmtMm(STANDOFF_MM)}
            </text>
          </g>
        )}
      </g>
    );
  };

  // -- Render ----------------------------------------------------------------

  return (
    <div className="absolute inset-0" style={{ pointerEvents: 'none', zIndex: 15 }}>
      <svg
        className="absolute inset-0 w-full h-full"
        style={{ overflow: 'visible', pointerEvents: dragging ? 'auto' : 'none' }}
        onPointerMove={dragging ? onPointerMove : undefined}
        onPointerUp={dragging ? onPointerUp : undefined}
        onPointerCancel={dragging ? onPointerUp : undefined}
      >

        {/* X dimension line */}
        {liveAxX.length >= 2 && (
          <g>
            {layout.xHandles.map((h, i) =>
              h.pt && h.extPt ? (
                <line key={`xext-${i}`}
                  x1={h.extPt.x} y1={h.extPt.y} x2={h.pt.x} y2={h.pt.y}
                  stroke={C_EXT} strokeWidth="1" strokeDasharray="5 3"
                />
              ) : null,
            )}
            {layout.xHandles.slice(0, -1).map((h, i) => {
              const h2 = layout.xHandles[i + 1];
              if (!h.pt || !h2.pt) return null;
              return (
                <DimSegment key={`xdim-${i}`}
                  h0={h.pt} h1={h2.pt}
                  dist={Math.round(liveAxX[i + 1] - liveAxX[i])}
                  dir="X" segIdx={i}
                />
              );
            })}
            {layout.xHandles.map((h, i) =>
              h.pt ? (
                <HandleMark key={`xh-${i}`} pt={h.pt} dir="X" idx={i} canDrag />
              ) : null,
            )}
          </g>
        )}

        {/* Y dimension line */}
        {liveAxY.length >= 2 && (
          <g>
            {layout.yHandles.map((h, j) =>
              h.pt && h.extPt ? (
                <line key={`yext-${j}`}
                  x1={h.extPt.x} y1={h.extPt.y} x2={h.pt.x} y2={h.pt.y}
                  stroke={C_EXT} strokeWidth="1" strokeDasharray="5 3"
                />
              ) : null,
            )}
            {layout.yHandles.slice(0, -1).map((h, j) => {
              const h2 = layout.yHandles[j + 1];
              if (!h.pt || !h2.pt) return null;
              return (
                <DimSegment key={`ydim-${j}`}
                  h0={h.pt} h1={h2.pt}
                  dist={Math.round(liveAxY[j + 1] - liveAxY[j])}
                  dir="Y" segIdx={j}
                />
              );
            })}
            {layout.yHandles.map((h, j) =>
              h.pt ? (
                <HandleMark key={`yh-${j}`} pt={h.pt} dir="Y" idx={j} canDrag />
              ) : null,
            )}
          </g>
        )}

        {/* Standoff annotations */}
        {liveAxX.length >= 1 && layout.xSoBase && layout.xSoTip && (
          <StandoffArrow base={layout.xSoBase} tip={layout.xSoTip} />
        )}
        {liveAxY.length >= 1 && layout.ySoBase && layout.ySoTip && (
          <StandoffArrow base={layout.ySoBase} tip={layout.ySoTip} />
        )}

      </svg>

      {/* Inline distance editor */}
      {editState && (
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          type="number"
          min={MIN_GAP_MM}
          step="1"
          value={editState.val}
          onChange={(e) =>
            setEditState((prev) => prev ? { ...prev, val: e.target.value } : null)
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter')  { e.preventDefault(); commitEdit(); }
            if (e.key === 'Escape') setEditState(null);
          }}
          onBlur={commitEdit}
          style={{
            position:      'absolute',
            left:          editState.px - 44,
            top:           editState.py - 12,
            width:         88,
            fontSize:      12,
            background:    '#0b1828',
            color:         '#aaddff',
            border:        '1px solid #4488dd',
            borderRadius:  4,
            padding:       '2px 6px',
            textAlign:     'center',
            zIndex:        30,
            pointerEvents: 'auto',
            outline:       'none',
          }}
        />
      )}
    </div>
  );
}
