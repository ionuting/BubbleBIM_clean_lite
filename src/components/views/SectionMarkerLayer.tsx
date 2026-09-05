/**
 * SectionMarkerLayer — the section marker in the floor plan, edited in place.
 *
 * The marker is the section's whole definition, the way it is in ArchiCAD:
 *
 *   ●━━━━━━━━━━━━━━━━━━━●     the line A–B (endpoints drag; length = extent)
 *   ▲        ⊕        ▲       arrows point at the viewed side; ⊕ moves it
 *   ┈┈┈┈┈┈┈┈┈┈▢┈┈┈┈┈┈┈┈┈┈     the depth line (drag ▢; double-click = infinite)
 *            ⇄                flip handle, on the side you are NOT looking at
 *
 * Every change writes the node's `plan_cut` / `look_side` / `cut_depth_mm`
 * through `onUpdateProps`; the open section tab reads the same node, so the
 * drawing follows the drag. Rendering goes through `resolveSectionCut`, the
 * same resolver the engine uses, so what the plan shows IS what gets cut.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  resolveSectionCut,
  type PlanCut,
  type SectionSpec,
} from '@/lib/sectionFromPlan';

export interface SectionMarkerLayerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  /** BIM mm → SVG user units. */
  toSvg: (x: number, y: number) => { x: number; y: number };
  /** SVG units per mm (for the band depth). */
  scale: number;
  /** Browser client coords → BIM mm (handles pan/zoom). */
  clientToBim: (clientX: number, clientY: number) => { x: number; y: number };
  onOpen: (nodeId: string) => void;
  onUpdateProps: (nodeId: string, patch: Record<string, unknown>) => void;
  /** False in print/embedded hosts: draw, but no handles. */
  interactive?: boolean;
}

type Handle = 'a' | 'b' | 'move' | 'depth';

interface DragState {
  nodeId: string;
  handle: Handle;
  startClient: { x: number; y: number };
  startBim: { x: number; y: number };
  line: PlanCut;
  spec: SectionSpec;
  shift: boolean;
  moved: boolean;
  /** Live preview while dragging. */
  preview: { line: PlanCut; depthMm?: number };
}

const CLICK_PX = 4;
const DEPTH_STEP_MM = 100;

type ViewDir = 'N' | 'S' | 'E' | 'W';
/** Where the elevation camera looks (BIM: +x east, +y north) — matches computeElevationView. */
const VIEW_NORMALS: Record<ViewDir, { x: number; y: number }> = {
  N: { x: 0, y: 1 }, S: { x: 0, y: -1 }, E: { x: -1, y: 0 }, W: { x: 1, y: 0 },
};
const OPPOSITE_DIR: Record<ViewDir, ViewDir> = { N: 'S', S: 'N', E: 'W', W: 'E' };
function viewDirectionOf(n: BubbleGraphNode): ViewDir {
  const d = String(n.properties.view_direction ?? 'W');
  return d === 'N' || d === 'S' || d === 'E' ? d : 'W';
}

function isOrtho(line: PlanCut): 'h' | 'v' | null {
  const dx = Math.abs(line.x2 - line.x1), dy = Math.abs(line.y2 - line.y1);
  if (dy < 1e-6 || dx / Math.max(dy, 1e-9) > 100) return 'h';
  if (dx < 1e-6 || dy / Math.max(dx, 1e-9) > 100) return 'v';
  return null;
}

export function SectionMarkerLayer({
  nodes, edges, toSvg, scale, clientToBim, onOpen, onUpdateProps, interactive = true,
}: SectionMarkerLayerProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const markers = useMemo(
    () => nodes.filter((n) => (n.type === 'section' || n.type === 'view') && n.properties.show_in_plan !== false),
    [nodes],
  );

  // ── Drag lifecycle: window listeners so the pointer may leave the handle ──
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const cur = clientToBim(e.clientX, e.clientY);
      const dxPx = e.clientX - d.startClient.x, dyPx = e.clientY - d.startClient.y;
      const moved = d.moved || Math.hypot(dxPx, dyPx) > CLICK_PX;
      const shift = e.shiftKey;
      let preview = d.preview;
      if (d.handle === 'move') {
        const dx = cur.x - d.startBim.x, dy = cur.y - d.startBim.y;
        preview = { line: { x1: d.line.x1 + dx, y1: d.line.y1 + dy, x2: d.line.x2 + dx, y2: d.line.y2 + dy } };
      } else if (d.handle === 'a' || d.handle === 'b') {
        const other = d.handle === 'a' ? { x: d.line.x2, y: d.line.y2 } : { x: d.line.x1, y: d.line.y1 };
        let p = { x: cur.x, y: cur.y };
        // An orthogonal marker stays orthogonal unless Shift frees it.
        const ortho = isOrtho(d.line);
        if (ortho && !shift) p = ortho === 'h' ? { x: p.x, y: other.y } : { x: other.x, y: p.y };
        preview = {
          line: d.handle === 'a'
            ? { x1: p.x, y1: p.y, x2: d.line.x2, y2: d.line.y2 }
            : { x1: d.line.x1, y1: d.line.y1, x2: p.x, y2: p.y },
        };
      } else if (d.handle === 'depth') {
        const n = d.spec.normal;
        const raw = (cur.x - d.line.x1) * n.x + (cur.y - d.line.y1) * n.y;
        const depth = Math.max(0, Math.round(raw / DEPTH_STEP_MM) * DEPTH_STEP_MM);
        preview = { line: d.line, depthMm: depth };
      }
      setDrag({ ...d, moved, shift, preview });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (!d.moved) {
        if (d.handle === 'move') onOpen(d.nodeId);
        return;
      }
      if (d.handle === 'depth') {
        const depth = d.preview.depthMm ?? d.spec.depthMm;
        onUpdateProps(d.nodeId, depth <= 0
          ? { depth_mode: 'zero' }
          : { depth_mode: 'limited', cut_depth_mm: depth });
        return;
      }
      const l = d.preview.line;
      if (Math.hypot(l.x2 - l.x1, l.y2 - l.y1) < 100) return;
      const r = (v: number) => Math.round(v);
      onUpdateProps(d.nodeId, {
        plan_cut: { x1: r(l.x1), y1: r(l.y1), x2: r(l.x2), y2: r(l.y2) },
        // A dragged marker is fully described by plan_cut; retire the legacy
        // shifts so they cannot double up.
        cut_plane_offset_mm: 0, offset_left_mm: 0, offset_right_mm: 0,
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, clientToBim, onOpen, onUpdateProps]);

  const startDrag = useCallback((e: React.MouseEvent, node: BubbleGraphNode, spec: SectionSpec, handle: Handle) => {
    if (!interactive || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const startBim = clientToBim(e.clientX, e.clientY);
    setDrag({
      nodeId: node.id, handle,
      startClient: { x: e.clientX, y: e.clientY },
      startBim,
      line: spec.line, spec,
      shift: e.shiftKey, moved: false,
      preview: { line: spec.line },
    });
  }, [interactive, clientToBim]);

  const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };

  return (
    <g data-layer="section-markers">
      {markers.map((n) => {
        const base = resolveSectionCut(n, nodes, edges);
        if (!base) return null;
        const isView = n.type === 'view';
        const isDragging = drag?.nodeId === n.id;
        const line = isDragging ? drag!.preview.line : base.line;
        // While dragging an endpoint the normal follows the new line.
        let spec: SectionSpec = isDragging
          ? { ...resolveSectionCut({ ...n, properties: { ...n.properties, plan_cut: line, cut_plane_offset_mm: 0, offset_left_mm: 0, offset_right_mm: 0 } }, nodes, edges)!,
              depthMm: drag!.preview.depthMm ?? base.depthMm,
              depthMode: drag!.preview.depthMm != null
                ? (drag!.preview.depthMm > 0 ? 'limited' : 'zero')
                : base.depthMode }
          : base;
        // An elevation looks along its compass direction, not at a side of the line.
        const viewDir = isView ? viewDirectionOf(n) : null;
        if (viewDir) spec = { ...spec, normal: VIEW_NORMALS[viewDir], depthMode: 'infinite' };

        const sA = toSvg(line.x1, line.y1);
        const sB = toSvg(line.x2, line.y2);
        const svgLen = Math.hypot(sB.x - sA.x, sB.y - sA.y);
        if (svgLen < 0.1) return null;
        const ux = (sB.x - sA.x) / svgLen, uy = (sB.y - sA.y) / svgLen;
        // Look normal in SVG space (SVG y is flipped relative to BIM north).
        const sN = toSvg(line.x1 + spec.normal.x * 1000, line.y1 + spec.normal.y * 1000);
        const nLen = Math.hypot(sN.x - sA.x, sN.y - sA.y) || 1;
        const nx = (sN.x - sA.x) / nLen, ny = (sN.y - sA.y) / nLen;

        const color = n.type === 'section' ? '#e11d48' : '#f97316';
        const circleR = 9;
        const arrowLen = 11;
        const mid = { x: (sA.x + sB.x) / 2, y: (sA.y + sB.y) / 2 };

        // Depth band. Infinite: a long faded band; zero: none; limited: to the depth line.
        const depthPx = spec.depthMode === 'limited' ? spec.depthMm * scale : null;
        const infinitePx = 260;
        const bandDepth = spec.depthMode === 'infinite' ? infinitePx : depthPx ?? 0;
        // Handle for the depth line: at the depth, or (infinite) at the last known depth.
        const rawDepth = Number(n.properties.cut_depth_mm);
        const handleDepthPx = spec.depthMode === 'limited'
          ? spec.depthMm * scale
          : (Number.isFinite(rawDepth) && rawDepth > 0 ? rawDepth : 6000) * scale;
        const hd = { x: mid.x + nx * handleDepthPx, y: mid.y + ny * handleDepthPx };
        const flipPos = { x: mid.x - nx * (circleR + 8), y: mid.y - ny * (circleR + 8) };
        const gradId = `sec-fade-${n.id}`;

        const onHandleDown = (h: Handle) => (e: React.MouseEvent) => startDrag(e, n, spec, h);
        const cursor = interactive ? 'pointer' : 'default';

        return (
          <g key={n.id} onClick={stop} onDoubleClick={stop} style={{ cursor }}>
            {spec.depthMode === 'infinite' && (
              <defs>
                <linearGradient id={gradId} gradientUnits="userSpaceOnUse"
                  x1={mid.x} y1={mid.y} x2={mid.x + nx * infinitePx} y2={mid.y + ny * infinitePx}>
                  <stop offset="0" stopColor={color} stopOpacity={0.12} />
                  <stop offset="1" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
            )}
            {bandDepth > 0 && (
              <polygon
                points={`${sA.x},${sA.y} ${sA.x + nx * bandDepth},${sA.y + ny * bandDepth} ${sB.x + nx * bandDepth},${sB.y + ny * bandDepth} ${sB.x},${sB.y}`}
                fill={spec.depthMode === 'infinite' ? `url(#${gradId})` : color + '18'}
                stroke="none"
                pointerEvents="none"
              />
            )}
            {/* Depth line — draggable */}
            {spec.depthMode !== 'infinite' && (
              <line
                x1={sA.x + nx * handleDepthPx} y1={sA.y + ny * handleDepthPx}
                x2={sB.x + nx * handleDepthPx} y2={sB.y + ny * handleDepthPx}
                stroke={color + (spec.depthMode === 'zero' ? '44' : '88')}
                strokeWidth="0.9" strokeDasharray="5 3"
                pointerEvents="none"
              />
            )}
            {/* Main cut line */}
            <line x1={sA.x} y1={sA.y} x2={sB.x} y2={sB.y} stroke={color} strokeWidth="2" strokeLinecap="square" pointerEvents="none" />
            {/* Endpoint circles + arrows (drag = move the endpoint) */}
            {([sA, sB] as const).map((pt, i) => (
              <g key={i} onMouseDown={onHandleDown(i === 0 ? 'a' : 'b')} style={{ cursor: interactive ? 'move' : cursor }}>
                <circle cx={pt.x} cy={pt.y} r={circleR} fill={color} />
                <line
                  x1={pt.x + nx * circleR} y1={pt.y + ny * circleR}
                  x2={pt.x + nx * (circleR + arrowLen)} y2={pt.y + ny * (circleR + arrowLen)}
                  stroke={color} strokeWidth="1.5"
                />
                <polygon
                  points={`${pt.x + nx * (circleR + arrowLen)},${pt.y + ny * (circleR + arrowLen)} ${pt.x + nx * circleR - ux * 4},${pt.y + ny * circleR - uy * 4} ${pt.x + nx * circleR + ux * 4},${pt.y + ny * circleR + uy * 4}`}
                  fill={color}
                />
              </g>
            ))}
            {/* Mid grip: click opens, drag moves the whole marker */}
            <g onMouseDown={onHandleDown('move')} style={{ cursor: interactive ? 'grab' : cursor }}>
              <circle cx={mid.x} cy={mid.y} r={6} fill="white" stroke={color} strokeWidth="1.5" />
              <circle cx={mid.x} cy={mid.y} r={2} fill={color} />
            </g>
            {/* Depth handle: drag sets the depth, double-click toggles infinite */}
            {interactive && !isView && (
              <g
                onMouseDown={onHandleDown('depth')}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onUpdateProps(n.id, spec.depthMode === 'infinite'
                    ? { depth_mode: 'limited' }
                    : { depth_mode: 'infinite' });
                }}
                style={{ cursor: 'ns-resize' }}
              >
                <rect x={hd.x - 5} y={hd.y - 5} width={10} height={10}
                  fill="white" stroke={color} strokeWidth="1.2"
                  strokeDasharray={spec.depthMode === 'infinite' ? '2 1.5' : undefined}
                  transform={`rotate(${Math.atan2(uy, ux) * 180 / Math.PI} ${hd.x} ${hd.y})`} />
                <text x={hd.x + ux * 9} y={hd.y + uy * 9} fontSize="6.5" fill={color}
                  dominantBaseline="middle" textAnchor="start" pointerEvents="none">
                  {spec.depthMode === 'infinite' ? '∞' : spec.depthMode === 'zero' ? '0' : `${(spec.depthMm / 1000).toFixed(1)} m`}
                </text>
              </g>
            )}
            {/* Flip handle, behind the line */}
            {interactive && (
              <g
                onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (viewDir) onUpdateProps(n.id, { view_direction: OPPOSITE_DIR[viewDir] });
                  else onUpdateProps(n.id, { look_side: spec.lookSide === 'left' ? 'right' : 'left', flipped: undefined });
                }}
                style={{ cursor: 'pointer' }}
              >
                <title>Întoarce direcția de privire</title>
                <circle cx={flipPos.x} cy={flipPos.y} r={6} fill="white" stroke={color} strokeWidth="1.2" />
                <text x={flipPos.x} y={flipPos.y + 0.5} fontSize="8" fill={color}
                  dominantBaseline="middle" textAnchor="middle" pointerEvents="none">⇄</text>
              </g>
            )}
            {/* Label on the viewed side */}
            <text
              x={mid.x + nx * (circleR + arrowLen + 5)}
              y={mid.y + ny * (circleR + arrowLen + 5)}
              textAnchor="middle" dominantBaseline="middle"
              fontSize="7" fill={color} fontWeight="bold" pointerEvents="none"
            >
              {n.name}
            </text>
          </g>
        );
      })}
    </g>
  );
}
