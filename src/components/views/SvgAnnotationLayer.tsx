/**
 * SvgAnnotationLayer — reusable SVG 2D annotation overlay.
 *
 * Tools: select, text, dimension, leader, line, arc, polyline, rect, circle,
 *        hatch, join, trim, eraser.
 *
 * Select tool:
 *   - Click annotation → select (blue handles overlay)
 *   - Drag selected annotation → move it
 *   - Click empty area → deselect
 *
 * Join tool:
 *   - Click first line/polyline, then click second → merges if endpoints coincide.
 *
 * Trim tool:
 *   - Click the cutter line, then click the target line near the end to trim.
 *   - Trims target to the intersection of the two lines.
 *
 * Rect / Circle:
 *   - Rect: click first corner, then opposite corner.
 *   - Circle: click center, then edge point (sets radius).
 *
 * Text re-edit: double-click any placed text annotation to reopen the edit overlay.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  useBubbleGraphStore,
  type DrawingAnnotation,
  type AnnPt,
  type HatchPatternId,
} from '@/store';
import { SvgHatchDefs } from './SvgHatches';

// ─── Tool type ────────────────────────────────────────────────────────────────

export type SvgAnnotationTool =
  | 'select'
  | 'text' | 'dimension' | 'leader' | 'line' | 'arc'
  | 'polyline' | 'rect' | 'circle'
  | 'hatch' | 'join' | 'trim' | 'eraser';

// ─── Placement state machine ──────────────────────────────────────────────────

type PlaceStage =
  | 'idle'
  | 'dim:p1' | 'dim:p2' | 'dim:offset'
  | 'leader:pts'
  | 'line:p1'  | 'line:p2'
  | 'arc:center' | 'arc:start' | 'arc:end'
  | 'poly:pts' | 'hatch:pts'
  | 'rect:p1'  | 'rect:p2'
  | 'circle:center' | 'circle:edge'
  | 'join:first' | 'join:second'
  | 'trim:cutter'  | 'trim:target';

interface PlaceState {
  stage:   PlaceStage;
  pts:     AnnPt[];
  aux1?:   AnnPt;          // dim p1
  aux2?:   AnnPt;          // dim p2
  arcCx?:  number;
  arcCy?:  number;
  arcR?:   number;
  arcA0?:  number;
  joinId?: string;         // first annotation picked by join tool
  trimId?: string;         // cutter annotation id for trim
}

interface TextOverlay {
  logX: number; logY: number;
  screenX: number; screenY: number;
  forLeader?: AnnPt[];
  editId?: string;         // set when re-editing existing text
  initValue?: string;
}

let _ann = 0;
function annId(): string {
  return `ann_${Date.now().toString(36)}_${(++_ann).toString(36)}`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SvgAnnotationLayerProps {
  viewId: string;
  toSvg: (lx: number, ly: number) => AnnPt;
  /** Accepts any object with clientX/clientY so it can be called from both React and native events. */
  fromSvgEvent: (e: { clientX: number; clientY: number }) => AnnPt;
  activeTool: SvgAnnotationTool | null;
  onToolDone?: () => void;
  snapPoints?: AnnPt[];
  snapThreshold?: number;
  fontSizeSvg?: number;
  strokeSvg?: number;
  dimColor?: string;
  textColor?: string;
  drawColor?: string;
  fillColor?: string;
  fillOpacity?: number;
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  fontBold?: boolean;
  hatchPattern?: HatchPatternId;
  hatchSpacing?: number;
  hatchAngle?: number;
  hatchOpacity?: number;
  captureBounds?: [number, number, number, number];
  /** Externally-controlled selected annotation id */
  selectedId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Compute intersection of line segments (p1,p2) and (p3,p4). Returns null if none. */
function segIntersect(
  p1: AnnPt, p2: AnnPt,
  p3: AnnPt, p4: AnnPt,
): AnnPt | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-9) return null;
  const dx = p3.x - p1.x, dy = p3.y - p1.y;
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  if (t < -0.001 || t > 1.001 || u < -0.001 || u > 1.001) return null;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/** Translate all logical points of an annotation by (dx, dy). */
function translateAnnotation(ann: DrawingAnnotation, dx: number, dy: number): Partial<DrawingAnnotation> {
  const mv = (p: AnnPt): AnnPt => ({ x: p.x + dx, y: p.y + dy });
  switch (ann.kind) {
    case 'text':      return { x: ann.x + dx,  y: ann.y + dy };
    case 'dimension': return { p1: mv(ann.p1), p2: mv(ann.p2) };
    case 'leader':    return { points: ann.points.map(mv) };
    case 'line':      return { p1: mv(ann.p1), p2: mv(ann.p2) };
    case 'arc':       return { cx: ann.cx + dx, cy: ann.cy + dy };
    case 'polyline':  return { points: ann.points.map(mv) };
    case 'hatch':     return { points: ann.points.map(mv) };
    case 'rect':      return { x: ann.x + dx, y: ann.y + dy };
    case 'circle':    return { cx: ann.cx + dx, cy: ann.cy + dy };
    default:          return {};
  }
}

/** Check if two points are within `thresh` distance. */
function near(a: AnnPt, b: AnnPt, thresh: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < thresh;
}

/** Get the endpoint(s) of an annotation as an array of AnnPt. */
function getEndpoints(ann: DrawingAnnotation): AnnPt[] {
  switch (ann.kind) {
    case 'line':     return [ann.p1, ann.p2];
    case 'polyline': return ann.points.length ? [ann.points[0], ann.points[ann.points.length - 1]] : [];
    default:         return [];
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SvgAnnotationLayer({
  viewId,
  toSvg,
  fromSvgEvent,
  activeTool,
  onToolDone,
  snapPoints = [],
  snapThreshold = 200,
  fontSizeSvg = 180,
  strokeSvg = 10,
  dimColor   = '#1565c0',
  textColor  = '#1a1a2e',
  drawColor  = '#374151',
  fillColor  = '#ffffff',
  fillOpacity = 0,
  strokeStyle = 'solid',
  fontBold = false,
  hatchPattern = 'diagonal',
  hatchSpacing = 1.0,
  hatchAngle   = 0,
  hatchOpacity = 0.4,
  captureBounds = [-1e6, -1e6, 1e6, 1e6],
  selectedId,
  onSelectAnnotation,
}: SvgAnnotationLayerProps) {
  const {
    annotations,
    addAnnotation,
    deleteAnnotation,
    updateAnnotation,
  } = useBubbleGraphStore();
  const viewAnns = annotations.filter((a) => a.viewId === viewId);

  const [place, setPlace] = useState<PlaceState>({ stage: 'idle', pts: [] });
  const [mouse, setMouse] = useState<AnnPt | null>(null);
  const [snapped, setSnapped] = useState<AnnPt | null>(null);
  const [textOverlay, setTextOverlay] = useState<TextOverlay | null>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  // ── Move state for select tool ─────────────────────────────────────────
  const moveRef = useRef<{
    id: string;
    startLog: AnnPt;
    origAnn: DrawingAnnotation;
  } | null>(null);

  // ── Stable ref to fromSvgEvent — always holds the latest version ───────
  // This lets the global pointermove handler call it without stale closures.
  const fromSvgEventRef = useRef(fromSvgEvent);
  fromSvgEventRef.current = fromSvgEvent;

  // ── Reset on tool change ───────────────────────────────────────────────
  useEffect(() => {
    setMouse(null);
    setSnapped(null);
    setTextOverlay(null);
    moveRef.current = null;

    const NULL_TOOLS: (SvgAnnotationTool | null)[] = [null, 'eraser', 'text', 'select'];
    if (!activeTool || NULL_TOOLS.includes(activeTool)) {
      setPlace({ stage: 'idle', pts: [] });
      return;
    }

    const INIT: Partial<Record<SvgAnnotationTool, PlaceStage>> = {
      dimension: 'dim:p1',
      leader:    'leader:pts',
      line:      'line:p1',
      arc:       'arc:center',
      polyline:  'poly:pts',
      hatch:     'hatch:pts',
      rect:      'rect:p1',
      circle:    'circle:center',
      join:      'join:first',
      trim:      'trim:cutter',
    };
    setPlace({ stage: INIT[activeTool] ?? 'idle', pts: [] });
  }, [activeTool]);

  // Focus text input when overlay opens
  useEffect(() => {
    if (textOverlay) setTimeout(() => textInputRef.current?.focus(), 30);
  }, [textOverlay]);

  // ESC cancels current placement or text overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (textOverlay) { setTextOverlay(null); return; }
      if (place.stage !== 'idle') setPlace({ stage: 'idle', pts: [] });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [textOverlay, place.stage]);

  // ── Global pointermove/up for select-drag (move) ───────────────────────
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const mv = moveRef.current;
      if (!mv) return;
      // fromSvgEventRef.current accepts {clientX, clientY} — correct BIM mm conversion
      const cur = fromSvgEventRef.current({ clientX: e.clientX, clientY: e.clientY });
      const dx = cur.x - mv.startLog.x;
      const dy = cur.y - mv.startLog.y;
      updateAnnotation(mv.id, translateAnnotation(mv.origAnn, dx, dy) as Partial<DrawingAnnotation>);
    };
    const onUp = () => { moveRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [updateAnnotation]);

  // ── Snap helper ────────────────────────────────────────────────────────
  const snapTo = useCallback((pt: AnnPt): AnnPt => {
    if (!snapPoints.length) { setSnapped(null); return pt; }
    let best: AnnPt | null = null;
    let bestD = snapThreshold;
    for (const sp of snapPoints) {
      const d = Math.hypot(sp.x - pt.x, sp.y - pt.y);
      if (d < bestD) { bestD = d; best = sp; }
    }
    setSnapped(best);
    return best ?? pt;
  }, [snapPoints, snapThreshold]);

  // ── Mouse move ─────────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent<SVGElement>) => {
    if (!activeTool || activeTool === 'eraser' || activeTool === 'select') return;
    const raw = fromSvgEvent(e);
    setMouse(snapTo(raw));
  }, [activeTool, fromSvgEvent, snapTo]);

  // ── Click handler ──────────────────────────────────────────────────────
  const handleClick = useCallback((e: React.MouseEvent<SVGElement>) => {
    if (!activeTool || activeTool === 'eraser' || activeTool === 'select') return;
    e.stopPropagation();

    if (activeTool === 'text') {
      const pt = snapTo(fromSvgEvent(e));
      setTextOverlay({ logX: pt.x, logY: pt.y, screenX: e.clientX, screenY: e.clientY });
      return;
    }

    const pt = snapTo(fromSvgEvent(e));

    setPlace((prev) => {
      switch (prev.stage) {
        // ── Dimension ──────────────────────────────────────────────────
        case 'dim:p1':
          return { ...prev, stage: 'dim:p2', aux1: pt };
        case 'dim:p2':
          return { ...prev, stage: 'dim:offset', aux2: pt };
        case 'dim:offset': {
          const p1 = prev.aux1!, p2 = prev.aux2!;
          const dx = p2.x - p1.x, dy = p2.y - p1.y;
          const len = Math.hypot(dx, dy);
          if (len > 1e-6) {
            const nx = -dy / len, ny = dx / len;
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            const offsetDir = (pt.x - mx) * nx + (pt.y - my) * ny;
            addAnnotation({ id: annId(), kind: 'dimension', viewId, p1, p2, offsetDir, color: dimColor });
            onToolDone?.();
          }
          return { stage: 'dim:p1', pts: [] };
        }
        // ── Line ─────────────────────────────────────────────────────
        case 'line:p1':
          return { ...prev, stage: 'line:p2', pts: [pt] };
        case 'line:p2':
          addAnnotation({
            id: annId(), kind: 'line', viewId,
            p1: prev.pts[0], p2: pt,
            color: drawColor,
            strokeStyle,
          });
          onToolDone?.();
          return { stage: 'line:p1', pts: [] };
        // ── Arc ───────────────────────────────────────────────────────
        case 'arc:center':
          return { ...prev, stage: 'arc:start', arcCx: pt.x, arcCy: pt.y, pts: [] };
        case 'arc:start': {
          const r  = Math.hypot(pt.x - prev.arcCx!, pt.y - prev.arcCy!);
          const a0 = Math.atan2(pt.y - prev.arcCy!, pt.x - prev.arcCx!);
          return { ...prev, stage: 'arc:end', arcR: r, arcA0: a0 };
        }
        case 'arc:end': {
          const endAngle = Math.atan2(pt.y - prev.arcCy!, pt.x - prev.arcCx!);
          addAnnotation({
            id: annId(), kind: 'arc', viewId,
            cx: prev.arcCx!, cy: prev.arcCy!, radius: prev.arcR!,
            startAngle: prev.arcA0!, endAngle, color: drawColor,
          });
          onToolDone?.();
          return { stage: 'arc:center', pts: [] };
        }
        // ── Rect ──────────────────────────────────────────────────────
        case 'rect:p1':
          return { ...prev, stage: 'rect:p2', pts: [pt] };
        case 'rect:p2': {
          const p0 = prev.pts[0];
          const x = Math.min(p0.x, pt.x), y = Math.min(p0.y, pt.y);
          const w = Math.abs(pt.x - p0.x), h = Math.abs(pt.y - p0.y);
          if (w > 0 && h > 0) {
            addAnnotation({
              id: annId(), kind: 'rect', viewId,
              x, y, width: w, height: h,
              color: drawColor,
              fill: fillOpacity > 0 ? fillColor : undefined,
              fillOpacity: fillOpacity > 0 ? fillOpacity : undefined,
              strokeStyle,
            });
            onToolDone?.();
          }
          return { stage: 'rect:p1', pts: [] };
        }
        // ── Circle ────────────────────────────────────────────────────
        case 'circle:center':
          return { ...prev, stage: 'circle:edge', pts: [pt] };
        case 'circle:edge': {
          const radius = Math.hypot(pt.x - prev.pts[0].x, pt.y - prev.pts[0].y);
          if (radius > 1e-6) {
            addAnnotation({
              id: annId(), kind: 'circle', viewId,
              cx: prev.pts[0].x, cy: prev.pts[0].y, radius,
              color: drawColor,
              fill: fillOpacity > 0 ? fillColor : undefined,
              fillOpacity: fillOpacity > 0 ? fillOpacity : undefined,
              strokeStyle,
            });
            onToolDone?.();
          }
          return { stage: 'circle:center', pts: [] };
        }
        // ── Leader / Polyline / Hatch — accumulate ────────────────────
        case 'leader:pts':
        case 'poly:pts':
        case 'hatch:pts':
          return { ...prev, pts: [...prev.pts, pt] };
        // ── Join — pick two annotations ───────────────────────────────
        case 'join:first':
        case 'join:second':
          // handled in annotation-level click handlers
          return prev;
        // ── Trim — pick cutter then target ────────────────────────────
        case 'trim:cutter':
        case 'trim:target':
          return prev;
        default:
          return prev;
      }
    });
  }, [
    activeTool, fromSvgEvent, snapTo, viewId,
    addAnnotation, dimColor, drawColor,
    fillColor, fillOpacity, strokeStyle, onToolDone,
  ]);

  // ── Double-click — finish multi-point + text re-edit ──────────────────
  const handleDblClick = useCallback((e: React.MouseEvent<SVGElement>) => {
    e.preventDefault(); e.stopPropagation();
    setPlace((prev) => {
      if (prev.stage === 'leader:pts' && prev.pts.length >= 1) {
        const last = prev.pts[prev.pts.length - 1];
        setTextOverlay({ logX: last.x, logY: last.y, screenX: e.clientX, screenY: e.clientY, forLeader: prev.pts });
        return { stage: 'idle', pts: [] };
      }
      if (prev.stage === 'poly:pts' && prev.pts.length >= 2) {
        addAnnotation({
          id: annId(), kind: 'polyline', viewId, points: prev.pts,
          closed: false, color: drawColor, strokeStyle,
        });
        onToolDone?.();
        return { stage: 'poly:pts', pts: [] };
      }
      if (prev.stage === 'hatch:pts' && prev.pts.length >= 3) {
        addAnnotation({
          id: annId(), kind: 'hatch', viewId, points: prev.pts,
          pattern: hatchPattern, fillColor: drawColor,
          fillOpacity: hatchOpacity, color: drawColor,
          hatchSpacing, hatchAngle,
        });
        onToolDone?.();
        return { stage: 'hatch:pts', pts: [] };
      }
      return prev;
    });
  }, [viewId, addAnnotation, drawColor, strokeStyle, hatchPattern, hatchOpacity, hatchSpacing, hatchAngle, onToolDone]);

  // ── Text overlay ───────────────────────────────────────────────────────
  const confirmText = useCallback((value: string) => {
    const v = value.trim();
    setTextOverlay((ov) => {
      if (!ov) return null;
      if (v) {
        if (ov.editId) {
          // re-edit: update existing annotation
          updateAnnotation(ov.editId, { text: v } as Partial<DrawingAnnotation>);
        } else if (ov.forLeader) {
          addAnnotation({ id: annId(), kind: 'leader', viewId, points: ov.forLeader, text: v, color: dimColor });
          setPlace({ stage: 'leader:pts', pts: [] });
        } else {
          addAnnotation({
            id: annId(), kind: 'text', viewId,
            x: ov.logX, y: ov.logY, text: v, color: textColor,
            bold: fontBold,
          });
          setPlace({ stage: 'idle', pts: [] });
          onToolDone?.();
        }
      }
      return null;
    });
  }, [viewId, addAnnotation, updateAnnotation, dimColor, textColor, fontBold, onToolDone]);

  const cancelText = useCallback(() => {
    setTextOverlay(null);
    if (activeTool === 'leader') setPlace({ stage: 'leader:pts', pts: [] });
  }, [activeTool]);

  // ── Per-annotation click handler (eraser, select, join, trim) ─────────
  const handleAnnClick = useCallback((ann: DrawingAnnotation, e: React.MouseEvent) => {
    e.stopPropagation();

    if (activeTool === 'eraser') {
      deleteAnnotation(ann.id);
      return;
    }

    if (activeTool === 'select') {
      onSelectAnnotation?.(ann.id === selectedId ? null : ann.id);
      return;
    }

    if (activeTool === 'join') {
      setPlace((prev) => {
        if (prev.stage === 'join:first') {
          // Only joinable types: line and polyline
          if (ann.kind !== 'line' && ann.kind !== 'polyline') return prev;
          return { ...prev, stage: 'join:second', joinId: ann.id };
        }
        if (prev.stage === 'join:second' && prev.joinId && prev.joinId !== ann.id) {
          if (ann.kind !== 'line' && ann.kind !== 'polyline') return { stage: 'join:first', pts: [] };
          const a1 = annotations.find((a) => a.id === prev.joinId);
          if (!a1 || (a1.kind !== 'line' && a1.kind !== 'polyline')) return { stage: 'join:first', pts: [] };
          const eps = snapThreshold;
          const ends1 = getEndpoints(a1);
          const ends2 = getEndpoints(ann);
          const pts1 = a1.kind === 'line' ? [a1.p1, a1.p2] : a1.points;
          const pts2 = ann.kind === 'line' ? [ann.p1, ann.p2] : ann.points;
          let merged: AnnPt[] | null = null;
          for (const e1 of ends1) {
            for (const e2 of ends2) {
              if (!near(e1, e2, eps)) continue;
              const r1 = near(pts1[pts1.length - 1], e1, eps) ? pts1 : [...pts1].reverse();
              const r2 = near(pts2[0], e2, eps) ? pts2 : [...pts2].reverse();
              merged = [...r1, ...r2.slice(1)];
              break;
            }
            if (merged) break;
          }
          if (merged) {
            deleteAnnotation(a1.id);
            deleteAnnotation(ann.id);
            addAnnotation({ id: annId(), kind: 'polyline', viewId, points: merged, color: drawColor });
          }
          onToolDone?.();
          return { stage: 'join:first', pts: [] };
        }
        return prev;
      });
      return;
    }

    if (activeTool === 'trim') {
      // Capture click position before setPlace (setPlace callback can't read event)
      const clickPt = fromSvgEvent(e);
      setPlace((prev) => {
        if (prev.stage === 'trim:cutter') {
          return { ...prev, stage: 'trim:target', trimId: ann.id };
        }
        if (prev.stage === 'trim:target' && prev.trimId && prev.trimId !== ann.id) {
          const cutter = annotations.find((a) => a.id === prev.trimId);
          if (!cutter) return { stage: 'trim:cutter', pts: [] };
          const cutEnds = getEndpoints(cutter);
          if (cutEnds.length < 2) return { stage: 'trim:cutter', pts: [] };
          const tarEnds = getEndpoints(ann);
          if (tarEnds.length < 2) return { stage: 'trim:cutter', pts: [] };
          const cutP1 = cutEnds[0], cutP2 = cutEnds[cutEnds.length - 1];
          const tarP1 = tarEnds[0], tarP2 = tarEnds[tarEnds.length - 1];
          const ip = segIntersect(cutP1, cutP2, tarP1, tarP2);
          if (ip) {
            // Use click position to determine which end the user wants to trim:
            // the clicked end is replaced by the intersection point.
            const dClick1 = Math.hypot(clickPt.x - tarP1.x, clickPt.y - tarP1.y);
            const dClick2 = Math.hypot(clickPt.x - tarP2.x, clickPt.y - tarP2.y);
            const newP1 = dClick1 < dClick2 ? ip : tarP1;  // trim tarP1 end if click was near it
            const newP2 = dClick1 < dClick2 ? tarP2 : ip;
            updateAnnotation(ann.id, { p1: newP1, p2: newP2 } as Partial<DrawingAnnotation>);
          }
          onToolDone?.();
          return { stage: 'trim:cutter', pts: [] };
        }
        return prev;
      });
      return;
    }
  }, [
    activeTool, selectedId, annotations, viewId, fromSvgEvent,
    snapThreshold, addAnnotation, deleteAnnotation, updateAnnotation,
    drawColor, onSelectAnnotation, onToolDone,
  ]);

  // ── Per-annotation double-click (text re-edit) ─────────────────────────
  const handleAnnDblClick = useCallback((ann: DrawingAnnotation, e: React.MouseEvent) => {
    if (activeTool !== 'select' && activeTool !== 'text') return;
    e.stopPropagation();
    if (ann.kind === 'text') {
      setTextOverlay({
        logX: ann.x, logY: ann.y,
        screenX: e.clientX, screenY: e.clientY,
        editId: ann.id, initValue: ann.text,
      });
    }
  }, [activeTool]);

  // ── Pointer-down on annotation (select + drag-move) ────────────────────
  const handleAnnPointerDown = useCallback((ann: DrawingAnnotation, e: React.PointerEvent) => {
    if (activeTool !== 'select') return;
    e.stopPropagation();
    onSelectAnnotation?.(ann.id);
    const startLog = fromSvgEventRef.current({ clientX: e.clientX, clientY: e.clientY });
    moveRef.current = { id: ann.id, startLog, origAnn: { ...ann } };
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [activeTool, onSelectAnnotation]);

  // ── Click on empty area — deselect in select mode ─────────────────────
  const handleCaptureClick = useCallback((e: React.MouseEvent<SVGElement>) => {
    handleClick(e);
  }, [handleClick]);

  // ─── Render helpers ───────────────────────────────────────────────────

  const SW = strokeSvg;
  const FS = fontSizeSvg;

  function dashArray(style: 'solid' | 'dashed' | 'dotted' | undefined, sw: number): string | undefined {
    if (!style || style === 'solid') return undefined;
    if (style === 'dashed') return `${sw * 6} ${sw * 3}`;
    if (style === 'dotted') return `${sw * 1} ${sw * 3}`;
    return undefined;
  }

  function renderAnnotation(ann: DrawingAnnotation) {
    const col  = ann.color ?? dimColor;
    const sw   = (ann.lineWeight ?? 1) * SW;
    const isSel = ann.id === selectedId;

    const clickProps = (activeTool === 'eraser' || activeTool === 'select' || activeTool === 'join' || activeTool === 'trim')
      ? {
          onClick:       (ev: React.MouseEvent)        => handleAnnClick(ann, ev),
          onDoubleClick: (ev: React.MouseEvent)        => handleAnnDblClick(ann, ev),
          onPointerDown: (ev: React.PointerEvent<SVGElement>) =>
            handleAnnPointerDown(ann, ev),
          style: { cursor: activeTool === 'select' ? 'move' : 'pointer' } as React.CSSProperties,
        }
      : (activeTool === 'text'
          ? { onDoubleClick: (ev: React.MouseEvent) => handleAnnDblClick(ann, ev) }
          : {});

    const selectionOverlay = isSel ? renderSelectionBounds(ann) : null;

    switch (ann.kind) {
      // ── Text ──────────────────────────────────────────────────────────
      case 'text': {
        const s  = toSvg(ann.x, ann.y);
        const fs = ann.fontSize ?? FS;
        return (
          <g key={ann.id} {...clickProps}>
            {selectionOverlay}
            <text x={s.x} y={s.y}
              fill={col} fontSize={fs}
              fontWeight={(ann.bold ?? fontBold) ? 'bold' : 'normal'}
              transform={ann.rotation ? `rotate(${ann.rotation},${s.x},${s.y})` : undefined}
              vectorEffect="non-scaling-stroke">
              {ann.text}
            </text>
          </g>
        );
      }
      // ── Linear dimension ──────────────────────────────────────────────
      case 'dimension': {
        const { p1, p2, offsetDir, textOverride } = ann;
        const s1 = toSvg(p1.x, p1.y), s2 = toSvg(p2.x, p2.y);
        const dx = s2.x - s1.x, dy = s2.y - s1.y;
        const lenSvg = Math.hypot(dx, dy);
        if (lenSvg < 0.5) return null;
        const ux = dx / lenSvg, uy = dy / lenSvg;
        const nx = -uy, ny = ux;
        const logLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const svgPerLog = logLen > 1e-9 ? lenSvg / logLen : 1;
        const offSvg = offsetDir * svgPerLog;
        const OVER = SW * 3, GAP = SW * 1.5, TICK = SW * 4;
        const d1  = { x: s1.x + nx * offSvg, y: s1.y + ny * offSvg };
        const d2  = { x: s2.x + nx * offSvg, y: s2.y + ny * offSvg };
        const e1a = { x: s1.x + nx * GAP,  y: s1.y + ny * GAP  };
        const e1b = { x: s1.x + nx * (offSvg + OVER), y: s1.y + ny * (offSvg + OVER) };
        const e2a = { x: s2.x + nx * GAP,  y: s2.y + ny * GAP  };
        const e2b = { x: s2.x + nx * (offSvg + OVER), y: s2.y + ny * (offSvg + OVER) };
        const t1a = { x: d1.x + (ux + nx) * TICK * 0.5, y: d1.y + (uy + ny) * TICK * 0.5 };
        const t1b = { x: d1.x - (ux + nx) * TICK * 0.5, y: d1.y - (uy + ny) * TICK * 0.5 };
        const t2a = { x: d2.x + (ux + nx) * TICK * 0.5, y: d2.y + (uy + ny) * TICK * 0.5 };
        const t2b = { x: d2.x - (ux + nx) * TICK * 0.5, y: d2.y - (uy + ny) * TICK * 0.5 };
        const mid  = { x: (d1.x + d2.x) / 2, y: (d1.y + d2.y) / 2 };
        let ang = Math.atan2(uy, ux) * 180 / Math.PI;
        if (ang > 90) ang -= 180;
        if (ang < -90) ang += 180;
        const label = textOverride ?? (logLen >= 1000 ? `${(logLen / 1000).toFixed(3)} m` : `${Math.round(logLen)}`);
        const bgW = label.length * FS * 0.62, bgH = FS * 1.4;
        return (
          <g key={ann.id} {...clickProps}>
            {selectionOverlay}
            <line x1={e1a.x} y1={e1a.y} x2={e1b.x} y2={e1b.y} stroke={col} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
            <line x1={e2a.x} y1={e2a.y} x2={e2b.x} y2={e2b.y} stroke={col} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
            <line x1={d1.x}  y1={d1.y}  x2={d2.x}  y2={d2.y}  stroke={col} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
            <line x1={t1a.x} y1={t1a.y} x2={t1b.x} y2={t1b.y} stroke={col} strokeWidth={sw * 1.8} vectorEffect="non-scaling-stroke" />
            <line x1={t2a.x} y1={t2a.y} x2={t2b.x} y2={t2b.y} stroke={col} strokeWidth={sw * 1.8} vectorEffect="non-scaling-stroke" />
            <g transform={`translate(${mid.x},${mid.y}) rotate(${ang})`}>
              <rect x={-bgW / 2} y={-bgH / 2} width={bgW} height={bgH} fill="white" fillOpacity={0.92} rx={FS * 0.15} />
              <text x={0} y={0} textAnchor="middle" dominantBaseline="central" fill={col} fontSize={FS} fontWeight="600">{label}</text>
            </g>
          </g>
        );
      }
      // ── Leader ────────────────────────────────────────────────────────
      case 'leader': {
        if (!ann.points.length) return null;
        const svgPts = ann.points.map((p) => toSvg(p.x, p.y));
        const first  = svgPts[0];
        const second = svgPts.length > 1 ? svgPts[1] : svgPts[0];
        const last   = svgPts[svgPts.length - 1];
        const dxA = second.x - first.x, dyA = second.y - first.y;
        const dlA = Math.hypot(dxA, dyA) || 1;
        const arrow = FS * 0.5;
        const polyStr = svgPts.map((p) => `${p.x},${p.y}`).join(' ');
        const txtLen  = Math.min((ann.text?.length || 4), 30) * FS * 0.6;
        const fs = ann.fontSize ?? FS;
        return (
          <g key={ann.id} {...clickProps}>
            {selectionOverlay}
            <polyline points={polyStr} fill="none" stroke={col} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
            <polygon
              points={`${first.x},${first.y} ${first.x - dxA / dlA * arrow * 1.5 + dyA / dlA * arrow * 0.45},${first.y - dyA / dlA * arrow * 1.5 - dxA / dlA * arrow * 0.45} ${first.x - dxA / dlA * arrow * 1.5 - dyA / dlA * arrow * 0.45},${first.y - dyA / dlA * arrow * 1.5 + dxA / dlA * arrow * 0.45}`}
              fill={col}
            />
            <line x1={last.x} y1={last.y} x2={last.x + txtLen} y2={last.y} stroke={col} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
            <text x={last.x + FS * 0.2} y={last.y - FS * 0.2} fill={col} fontSize={fs}>{ann.text}</text>
          </g>
        );
      }
      // ── Line ──────────────────────────────────────────────────────────
      case 'line': {
        const s1 = toSvg(ann.p1.x, ann.p1.y), s2 = toSvg(ann.p2.x, ann.p2.y);
        return (
          <g key={ann.id} {...clickProps}>
            {selectionOverlay}
            <line x1={s1.x} y1={s1.y} x2={s2.x} y2={s2.y}
              stroke={col} strokeWidth={sw}
              strokeDasharray={dashArray(ann.strokeStyle, SW)}
              vectorEffect="non-scaling-stroke" />
          </g>
        );
      }
      // ── Arc ───────────────────────────────────────────────────────────
      case 'arc': {
        const sc  = toSvg(ann.cx, ann.cy);
        const sEx = toSvg(ann.cx + ann.radius, ann.cy);
        const rSvg = Math.abs(sEx.x - sc.x);
        const sx1 = sc.x + rSvg * Math.cos(ann.startAngle);
        const sy1 = sc.y - rSvg * Math.sin(ann.startAngle);
        const sx2 = sc.x + rSvg * Math.cos(ann.endAngle);
        const sy2 = sc.y - rSvg * Math.sin(ann.endAngle);
        const dA  = ((ann.endAngle - ann.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        const largeArc = dA > Math.PI ? 1 : 0;
        const d = `M ${sx1} ${sy1} A ${rSvg} ${rSvg} 0 ${largeArc} 0 ${sx2} ${sy2}`;
        return (
          <g key={ann.id} {...clickProps}>
            {selectionOverlay}
            <path d={d} fill="none" stroke={col} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
          </g>
        );
      }
      // ── Polyline / Polygon ────────────────────────────────────────────
      case 'polyline': {
        const pts   = ann.points.map((p) => toSvg(p.x, p.y));
        const ptStr = pts.map((p) => `${p.x},${p.y}`).join(' ');
        return (
          <g key={ann.id} {...clickProps}>
            {selectionOverlay}
            {ann.closed ? (
              <polygon points={ptStr}
                fill={ann.fill ?? 'none'} fillOpacity={ann.fillOpacity ?? 0}
                stroke={col} strokeWidth={sw}
                strokeDasharray={dashArray((ann as any).strokeStyle, SW)}
                vectorEffect="non-scaling-stroke" />
            ) : (
              <polyline points={ptStr} fill="none"
                stroke={col} strokeWidth={sw}
                strokeDasharray={dashArray((ann as any).strokeStyle, SW)}
                vectorEffect="non-scaling-stroke" />
            )}
          </g>
        );
      }
      // ── Rect ──────────────────────────────────────────────────────────
      case 'rect': {
        // Ann coords: x/y are logical bottom-left (BIM Y-up); we convert corners
        const tl = toSvg(ann.x, ann.y + ann.height);
        const br = toSvg(ann.x + ann.width, ann.y);
        const rx = Math.min(tl.x, br.x), ry = Math.min(tl.y, br.y);
        const rw = Math.abs(br.x - tl.x), rh = Math.abs(br.y - tl.y);
        const rotAttr = ann.rotation
          ? `rotate(${-ann.rotation},${rx + rw / 2},${ry + rh / 2})`
          : undefined;
        return (
          <g key={ann.id} transform={rotAttr} {...clickProps}>
            {selectionOverlay}
            <rect x={rx} y={ry} width={rw} height={rh}
              fill={ann.fill ?? 'none'} fillOpacity={ann.fillOpacity ?? 0}
              stroke={col} strokeWidth={sw}
              strokeDasharray={dashArray(ann.strokeStyle, SW)}
              vectorEffect="non-scaling-stroke" />
          </g>
        );
      }
      // ── Circle ────────────────────────────────────────────────────────
      case 'circle': {
        const sc  = toSvg(ann.cx, ann.cy);
        const sEx = toSvg(ann.cx + ann.radius, ann.cy);
        const rSvg = Math.abs(sEx.x - sc.x);
        return (
          <g key={ann.id} {...clickProps}>
            {selectionOverlay}
            <circle cx={sc.x} cy={sc.y} r={rSvg}
              fill={ann.fill ?? 'none'} fillOpacity={ann.fillOpacity ?? 0}
              stroke={col} strokeWidth={sw}
              strokeDasharray={dashArray(ann.strokeStyle, SW)}
              vectorEffect="non-scaling-stroke" />
          </g>
        );
      }
      // ── Hatch fill ────────────────────────────────────────────────────
      case 'hatch': {
        const pts    = ann.points.map((p) => toSvg(p.x, p.y));
        const ptStr  = pts.map((p) => `${p.x},${p.y}`).join(' ');
        const patId  = `ann-hatch-${ann.id}`;
        const fc     = ann.fillColor ?? col;
        const pat    = ann.pattern ?? 'diagonal';
        const ts     = FS * 2.5 * (ann.hatchSpacing ?? 1.0);
        const angle  = ann.hatchAngle ?? 0;
        const xform  = angle !== 0 ? `rotate(${angle})` : undefined;
        const patternContent = buildHatchContent(pat, fc, ts, SW);
        return (
          <g key={ann.id} {...clickProps}>
            {selectionOverlay}
            {pat !== 'solid' && pat !== 'none' && patternContent && (
              <defs>
                <pattern id={patId} x={0} y={0} width={ts} height={ts}
                  patternUnits="userSpaceOnUse" patternTransform={xform}>
                  {patternContent}
                </pattern>
              </defs>
            )}
            <polygon points={ptStr}
              color={fc}
              fill={pat === 'solid' ? fc : pat === 'none' ? 'none' : patternContent ? `url(#${patId})` : 'none'}
              fillOpacity={ann.fillOpacity ?? 0.4}
              stroke={col} strokeWidth={sw}
              vectorEffect="non-scaling-stroke" />
          </g>
        );
      }
      default: return null;
    }
  }

  // ── Selection bounding-box overlay ────────────────────────────────────
  function renderSelectionBounds(ann: DrawingAnnotation): React.ReactNode {
    let pts: AnnPt[] = [];
    switch (ann.kind) {
      case 'text':      pts = [toSvg(ann.x, ann.y)]; break;
      case 'dimension': pts = [toSvg(ann.p1.x, ann.p1.y), toSvg(ann.p2.x, ann.p2.y)]; break;
      case 'leader':
      case 'polyline':
      case 'hatch':     pts = ann.points.map((p) => toSvg(p.x, p.y)); break;
      case 'line':      pts = [toSvg(ann.p1.x, ann.p1.y), toSvg(ann.p2.x, ann.p2.y)]; break;
      case 'arc':       {
        const sc = toSvg(ann.cx, ann.cy);
        const sEx = toSvg(ann.cx + ann.radius, ann.cy);
        const r = Math.abs(sEx.x - sc.x);
        pts = [{ x: sc.x - r, y: sc.y - r }, { x: sc.x + r, y: sc.y + r }];
        break;
      }
      case 'rect': {
        pts = [toSvg(ann.x, ann.y), toSvg(ann.x + ann.width, ann.y + ann.height)];
        break;
      }
      case 'circle': {
        const sc = toSvg(ann.cx, ann.cy);
        const sEx = toSvg(ann.cx + ann.radius, ann.cy);
        const r = Math.abs(sEx.x - sc.x);
        pts = [{ x: sc.x - r, y: sc.y - r }, { x: sc.x + r, y: sc.y + r }];
        break;
      }
    }
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x = Math.min(...xs) - SW * 2, y = Math.min(...ys) - SW * 2;
    const w = Math.max(...xs) - Math.min(...xs) + SW * 4;
    const h = Math.max(...ys) - Math.min(...ys) + SW * 4;
    const handles: AnnPt[] = [
      { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
    ];
    return (
      <g style={{ pointerEvents: 'none' }}>
        <rect x={x} y={y} width={w} height={h}
          fill="none" stroke="#3b82f6" strokeWidth={SW * 0.7}
          strokeDasharray={`${SW * 3} ${SW * 2}`} vectorEffect="non-scaling-stroke" />
        {handles.map((p, i) => (
          <rect key={i} x={p.x - SW * 1.5} y={p.y - SW * 1.5} width={SW * 3} height={SW * 3}
            fill="white" stroke="#3b82f6" strokeWidth={SW * 0.6} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    );
  }

  // ── In-progress preview ────────────────────────────────────────────────
  function renderPreview() {
    if (!mouse || !activeTool || activeTool === 'eraser' || activeTool === 'text' || activeTool === 'select') return null;
    const ms = toSvg(mouse.x, mouse.y);
    const previewColor = '#3b82f6';
    const dash = `${SW * 4} ${SW * 2}`;

    switch (place.stage) {
      case 'dim:p2': {
        const s1 = toSvg(place.aux1!.x, place.aux1!.y);
        return <line x1={s1.x} y1={s1.y} x2={ms.x} y2={ms.y} stroke={previewColor} strokeWidth={SW} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />;
      }
      case 'dim:offset': {
        const s1 = toSvg(place.aux1!.x, place.aux1!.y);
        const s2 = toSvg(place.aux2!.x, place.aux2!.y);
        const dx = s2.x - s1.x, dy = s2.y - s1.y;
        const len = Math.hypot(dx, dy);
        if (len < 0.5) return null;
        const nx = -dy / len, ny = dx / len;
        const mx = (s1.x + s2.x) / 2, my = (s1.y + s2.y) / 2;
        const off = (ms.x - mx) * nx + (ms.y - my) * ny;
        const d1 = { x: s1.x + nx * off, y: s1.y + ny * off };
        const d2 = { x: s2.x + nx * off, y: s2.y + ny * off };
        return (
          <g>
            <line x1={s1.x} y1={s1.y} x2={d1.x} y2={d1.y} stroke={previewColor} strokeWidth={SW} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
            <line x1={s2.x} y1={s2.y} x2={d2.x} y2={d2.y} stroke={previewColor} strokeWidth={SW} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
            <line x1={d1.x} y1={d1.y} x2={d2.x} y2={d2.y} stroke={previewColor} strokeWidth={SW} vectorEffect="non-scaling-stroke" />
          </g>
        );
      }
      case 'line:p2': {
        const s1 = toSvg(place.pts[0].x, place.pts[0].y);
        return <line x1={s1.x} y1={s1.y} x2={ms.x} y2={ms.y} stroke={previewColor} strokeWidth={SW} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />;
      }
      case 'rect:p2': {
        const p0s = toSvg(place.pts[0].x, place.pts[0].y);
        const rx = Math.min(p0s.x, ms.x), ry = Math.min(p0s.y, ms.y);
        const rw = Math.abs(ms.x - p0s.x), rh = Math.abs(ms.y - p0s.y);
        return <rect x={rx} y={ry} width={rw} height={rh} fill="none" stroke={previewColor} strokeWidth={SW} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />;
      }
      case 'circle:edge': {
        const sc = toSvg(place.pts[0].x, place.pts[0].y);
        const r  = Math.hypot(ms.x - sc.x, ms.y - sc.y);
        return (
          <g>
            <circle cx={sc.x} cy={sc.y} r={r} fill="none" stroke={previewColor} strokeWidth={SW} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
            <line x1={sc.x} y1={sc.y} x2={ms.x} y2={ms.y} stroke={previewColor} strokeWidth={SW * 0.5} vectorEffect="non-scaling-stroke" />
          </g>
        );
      }
      case 'leader:pts':
      case 'poly:pts':
      case 'hatch:pts': {
        if (!place.pts.length) return <circle cx={ms.x} cy={ms.y} r={SW * 2} fill={previewColor} fillOpacity={0.5} />;
        const lastSvg = toSvg(place.pts[place.pts.length - 1].x, place.pts[place.pts.length - 1].y);
        const segments = place.pts.slice(1).map((p, i) => {
          const sa = toSvg(place.pts[i].x, place.pts[i].y);
          const sb = toSvg(p.x, p.y);
          return <line key={i} x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={previewColor} strokeWidth={SW} vectorEffect="non-scaling-stroke" />;
        });
        const dots = place.pts.map((p, i) => {
          const s = toSvg(p.x, p.y);
          return <circle key={`d${i}`} cx={s.x} cy={s.y} r={SW * 1.5} fill={previewColor} />;
        });
        return (
          <g>
            {segments}{dots}
            <line x1={lastSvg.x} y1={lastSvg.y} x2={ms.x} y2={ms.y} stroke={previewColor} strokeWidth={SW} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
          </g>
        );
      }
      case 'arc:start': {
        const sc = toSvg(place.arcCx!, place.arcCy!);
        return <line x1={sc.x} y1={sc.y} x2={ms.x} y2={ms.y} stroke={previewColor} strokeWidth={SW} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />;
      }
      case 'arc:end': {
        const sc   = toSvg(place.arcCx!, place.arcCy!);
        const sEx  = toSvg(place.arcCx! + place.arcR!, place.arcCy!);
        const rSvg = Math.abs(sEx.x - sc.x);
        const sx1  = sc.x + rSvg * Math.cos(place.arcA0!);
        const sy1  = sc.y - rSvg * Math.sin(place.arcA0!);
        const endA = Math.atan2(mouse.y - place.arcCy!, mouse.x - place.arcCx!);
        const sx2  = sc.x + rSvg * Math.cos(endA);
        const sy2  = sc.y - rSvg * Math.sin(endA);
        const dA   = ((endA - place.arcA0!) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        const la   = dA > Math.PI ? 1 : 0;
        const d    = `M ${sx1} ${sy1} A ${rSvg} ${rSvg} 0 ${la} 0 ${sx2} ${sy2}`;
        return <path d={d} fill="none" stroke={previewColor} strokeWidth={SW} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />;
      }
      default: return null;
    }
  }

  // ── Snap indicator ─────────────────────────────────────────────────────
  function renderSnapIndicator() {
    if (!snapped) return null;
    const s = toSvg(snapped.x, snapped.y);
    const r = SW * 2.5;
    return (
      <g>
        <circle cx={s.x} cy={s.y} r={r} fill="none" stroke="#3b82f6" strokeWidth={SW * 0.7} vectorEffect="non-scaling-stroke" />
        <line x1={s.x - r * 1.5} y1={s.y} x2={s.x + r * 1.5} y2={s.y} stroke="#3b82f6" strokeWidth={SW * 0.5} vectorEffect="non-scaling-stroke" />
        <line x1={s.x} y1={s.y - r * 1.5} x2={s.x} y2={s.y + r * 1.5} stroke="#3b82f6" strokeWidth={SW * 0.5} vectorEffect="non-scaling-stroke" />
      </g>
    );
  }

  const toolCursor: React.CSSProperties['cursor'] =
    activeTool === 'select' ? 'default'
    : activeTool === 'eraser' ? 'crosshair'
    : activeTool ? 'crosshair'
    : 'default';

  const [cx0, cy0, cx1, cy1] = captureBounds;

  // Drawing tools need a topmost capture rect; select/eraser/join/trim hit annotations directly.
  const DRAW_CAPTURE_TOOLS: SvgAnnotationTool[] = [
    'dimension', 'leader', 'line', 'arc', 'polyline', 'hatch', 'rect', 'circle', 'text',
  ];
  const usesDrawCapture = !!activeTool && DRAW_CAPTURE_TOOLS.includes(activeTool);

  // ── Shared hatch defs (for hatch tool preview and placed annotations) ──
  const hatchTileSize = FS * 2.5 * hatchSpacing;

  return (
    <>
      <defs>
        <SvgHatchDefs tileSize={hatchTileSize} extraAngle={hatchAngle} spacing={1} />
      </defs>

      {activeTool === 'select' && (
        <rect
          x={cx0} y={cy0} width={cx1 - cx0} height={cy1 - cy0}
          fill="transparent"
          style={{ cursor: toolCursor }}
          onClick={() => onSelectAnnotation?.(null)}
        />
      )}

      <g className="ann-placed">
        {viewAnns.map((a) => renderAnnotation(a))}
      </g>

      <g className="ann-preview">
        {renderPreview()}
        {renderSnapIndicator()}
      </g>

      {usesDrawCapture && (
        <rect
          x={cx0} y={cy0} width={cx1 - cx0} height={cy1 - cy0}
          fill="transparent"
          style={{ cursor: toolCursor }}
          onMouseMove={handleMouseMove}
          onClick={handleCaptureClick}
          onDoubleClick={handleDblClick}
        />
      )}

      {textOverlay && createPortal(
        <div style={{
          position: 'fixed',
          left: textOverlay.screenX + 8, top: textOverlay.screenY - 20,
          zIndex: 9999, display: 'flex', alignItems: 'center', gap: 4,
          background: 'white', border: '2px solid #3b82f6', borderRadius: 4,
          padding: '3px 6px', boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
        }}>
          <input
            ref={textInputRef}
            type="text"
            defaultValue={textOverlay.initValue ?? ''}
            placeholder={textOverlay.forLeader ? 'Leader text…' : textOverlay.editId ? 'Edit text…' : 'Label text…'}
            style={{ border: 'none', outline: 'none', fontSize: 13, minWidth: 160, background: 'transparent' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter')  confirmText(e.currentTarget.value);
              if (e.key === 'Escape') cancelText();
            }}
            onBlur={(e) => confirmText(e.target.value)}
          />
          <kbd style={{ fontSize: 10, color: '#9ca3af' }}>Enter</kbd>
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Inline hatch pattern content (for annotation-level hatch) ─────────────────

function buildHatchContent(
  pat: HatchPatternId, color: string, t: number, sw: number,
): React.ReactNode {
  switch (pat) {
    case 'diagonal':
      return <line x1={0} y1={t} x2={t} y2={0} stroke={color} strokeWidth={sw * 0.55} />;
    case 'crosshatch':
      return <>
        <line x1={0} y1={t} x2={t} y2={0} stroke={color} strokeWidth={sw * 0.55} />
        <line x1={0} y1={0} x2={t} y2={t} stroke={color} strokeWidth={sw * 0.55} />
      </>;
    case 'dots':
      return <circle cx={t / 2} cy={t / 2} r={sw * 1.2} fill={color} />;
    case 'concrete':
      return <>
        <line x1={0} y1={t} x2={t} y2={0} stroke={color} strokeWidth={sw * 0.55} />
        <circle cx={t * 0.25} cy={t * 0.75} r={sw * 0.8} fill={color} />
        <circle cx={t * 0.75} cy={t * 0.25} r={sw * 0.6} fill={color} />
      </>;
    case 'brick':
      return <>
        <rect x={0} y={t * 0.5} width={t * 2} height={t * 0.5} fill="none" stroke={color} strokeWidth={sw * 0.4} />
        <line x1={t} y1={t * 0.5} x2={t} y2={t} stroke={color} strokeWidth={sw * 0.4} />
      </>;
    case 'stone':
      return <polyline points={`0,${t * 0.6} ${t * 0.5},${t * 0.1} ${t},${t * 0.6}`} fill="none" stroke={color} strokeWidth={sw * 0.5} />;
    case 'wave':
      return <path d={`M0,${t * 0.5} Q${t * 0.5},0 ${t},${t * 0.5} Q${t * 1.5},${t} ${t * 2},${t * 0.5}`} fill="none" stroke={color} strokeWidth={sw * 0.55} />;
    case 'wood':
      return <>
        <line x1={0} y1={t * 0.4} x2={t} y2={t * 0.4} stroke={color} strokeWidth={sw * 0.5} />
        <line x1={0} y1={t * 0.9} x2={t} y2={t * 0.9} stroke={color} strokeWidth={sw * 0.4} />
      </>;
    case 'insulation':
      return <path d={`M0,${t * 0.5} L${t * 0.5},0 L${t},${t} L${t * 1.5},0 L${t * 2},${t * 0.5}`} fill="none" stroke={color} strokeWidth={sw * 0.55} />;
    case 'earth':
      return <>
        <line x1={0} y1={t} x2={t} y2={0} stroke={color} strokeWidth={sw * 0.55} />
        <circle cx={t * 0.3} cy={t * 0.6} r={sw * 0.7} fill={color} />
      </>;
    case 'steel':
      return <line x1={0} y1={t * 0.6} x2={t * 0.6} y2={0} stroke={color} strokeWidth={sw * 0.8} />;
    case 'glass':
      return <>
        <line x1={0} y1={t} x2={t} y2={0} stroke={color} strokeWidth={sw * 0.55} />
        <line x1={sw} y1={t} x2={t} y2={sw} stroke={color} strokeWidth={sw * 0.3} opacity={0.5} />
      </>;
    case 'sand':
      return <>
        <circle cx={t * 0.2} cy={t * 0.3} r={sw * 0.5} fill={color} />
        <circle cx={t * 0.7} cy={t * 0.6} r={sw * 0.4} fill={color} />
        <circle cx={t * 0.4} cy={t * 0.85} r={sw * 0.6} fill={color} />
      </>;
    default: return null;
  }
}
