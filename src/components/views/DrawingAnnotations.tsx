/**
 * DrawingAnnotations.tsx — the annotation tools, on a section or an elevation.
 *
 * `SvgAnnotationLayer` was already written to be view-agnostic: it asks for a
 * view id and a pair of coordinate functions and knows nothing else about its
 * host. Only the floor plan ever mounted it, so dimensioning, text, leaders
 * and hatch existed on one of the three drawings. This wires the other two.
 *
 * One thing does not carry across unchanged. The layer's `fontSizeSvg` and
 * `strokeSvg` are raw units of the HOST's SVG space, and the floor plan's
 * space is not the section's: the plan draws at 0.08 units per model mm, a
 * section at 1. Passing the stored numbers straight through would give a
 * section text a twelfth of the size it has on a plan. So the shared settings
 * keep deciding colour, dash, hatch and relative size, while the absolute
 * sizes come from the view's own scale in paper millimetres — the same place
 * its pen widths come from.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useBubbleGraphStore, type AnnPt } from '@/store';
import {
  DEFAULT_ANNOTATION_SETTINGS,
  getAnnotationSettings,
  setAnnotationSettings,
  subscribeAnnotationSettings,
  type AnnotationDrawingSettings,
} from '@/lib/annotationDrawingSettings';
import { StylePanel } from './StylePanel';
import { TEXT, type DrawingStyle } from '@/lib/drawingStyle';
import type { DrawingResult } from '@/lib/drawingEngine';
import { SvgAnnotationLayer, type SvgAnnotationTool } from './SvgAnnotationLayer';
import { DrawingPropertiesPanel } from './DrawingPropertiesPanel';

/** The drawing settings, kept in step with the panel that edits them. */
export function useAnnotationSettings(): AnnotationDrawingSettings {
  const [s, setS] = useState<AnnotationDrawingSettings>(() => getAnnotationSettings());
  useEffect(() => subscribeAnnotationSettings(() => setS(getAnnotationSettings())), []);
  return s;
}

/**
 * Where the pointer is allowed to land: every corner of every shape in the
 * drawing, plus the crossings of the axis grid with the storey levels.
 *
 * Capped, because a stair profile alone is a hundred corners and the layer
 * tests every candidate on each move.
 */
const MAX_SNAP_POINTS = 4000;

export function drawingSnapPoints(drawing: DrawingResult): AnnPt[] {
  const seen = new Set<string>();
  const pts: AnnPt[] = [];
  const add = (u: number, v: number) => {
    if (pts.length >= MAX_SNAP_POINTS) return;
    const key = `${Math.round(u)}:${Math.round(v)}`;
    if (seen.has(key)) return;
    seen.add(key);
    pts.push({ x: u, y: v });
  };
  for (const ax of drawing.axes) for (const lv of drawing.levels) add(ax.u, lv.vMm);
  for (const sh of drawing.shapes) for (const p of sh.pts) add(p.u, p.v);
  return pts;
}

// ─── Layer ────────────────────────────────────────────────────────────────────

export interface DrawingAnnotationLayerProps {
  /** Identity of the drawing the annotations belong to. */
  viewId: string;
  style: DrawingStyle;
  drawing: DrawingResult;
  activeTool: SvgAnnotationTool | null;
  toSvg: (u: number, v: number) => AnnPt;
  fromSvgEvent: (e: { clientX: number; clientY: number }) => AnnPt;
}

export function DrawingAnnotationLayer({
  viewId, style, drawing, activeTool, toSvg, fromSvgEvent,
}: DrawingAnnotationLayerProps) {
  const s = useAnnotationSettings();
  const selectedAnnotationId = useBubbleGraphStore((st) => st.selectedAnnotationId);
  const selectAnnotation = useBubbleGraphStore((st) => st.selectAnnotation);
  const snapPoints = useMemo(() => drawingSnapPoints(drawing), [drawing]);

  // The stored sizes are floor-plan units; keep only how far the user moved
  // them from the default, and apply that to this view's own paper sizes.
  const textFactor = s.fontSizeSvg / DEFAULT_ANNOTATION_SETTINGS.fontSizeSvg;
  const strokeFactor = s.strokeSvg / DEFAULT_ANNOTATION_SETTINGS.strokeSvg;

  return (
    <SvgAnnotationLayer
      viewId={viewId}
      toSvg={toSvg}
      fromSvgEvent={fromSvgEvent}
      activeTool={activeTool}
      onToolDone={() => { /* keep the tool active for repeated placement */ }}
      snapPoints={snapPoints}
      snapThreshold={style.paper(3)}
      fontSizeSvg={style.text(TEXT.normal) * textFactor}
      strokeSvg={style.line('annotation') * strokeFactor}
      dimColor={s.dimColor}
      textColor={s.textColor}
      drawColor={s.drawColor}
      fillColor={s.fillColor}
      fillOpacity={s.fillOpacity}
      strokeStyle={s.strokeStyle}
      fontBold={s.fontBold}
      hatchPattern={s.hatchPattern}
      hatchSpacing={s.hatchSpacing}
      hatchAngle={s.hatchAngle}
      hatchOpacity={s.hatchOpacity}
      dimStyleId={s.dimStyleId}
      drawStyleId={s.drawStyleId}
      selectedId={selectedAnnotationId}
      onSelectAnnotation={selectAnnotation}
    />
  );
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

const TOOLS: { tool: SvgAnnotationTool; icon: string; title: string }[] = [
  { tool: 'select', icon: '↖', title: 'Selectează / mută o adnotare' },
  { tool: 'text', icon: 'T', title: 'Text' },
  { tool: 'dimension', icon: '↔', title: 'Cotă — clic p1, p2, apoi partea pe care stă' },
  { tool: 'leader', icon: '↗', title: 'Indicator cu text — clic puncte, dublu-clic pentru final' },
  { tool: 'line', icon: '╱', title: 'Linie' },
  { tool: 'arc', icon: '⌒', title: 'Arc — centru, început, sfârșit' },
  { tool: 'polyline', icon: '╮', title: 'Polilinie — clic puncte, dublu-clic pentru final' },
  { tool: 'rect', icon: '▭', title: 'Dreptunghi' },
  { tool: 'circle', icon: '○', title: 'Cerc — centru, apoi un punct pe contur' },
  { tool: 'hatch', icon: '▦', title: 'Hașură — clic puncte, dublu-clic pentru închidere' },
  { tool: 'join', icon: '⋈', title: 'Unește două linii care se ating' },
  { tool: 'trim', icon: '✂', title: 'Retează — clic linia tăietoare, apoi capătul de retezat' },
  { tool: 'eraser', icon: '✕', title: 'Șterge o adnotare' },
];

export interface AnnotationToolbarProps {
  viewId: string;
  activeTool: SvgAnnotationTool | null;
  onToolChange: (t: SvgAnnotationTool | null) => void;
  /** View-specific controls, shown before the tools. */
  leading?: ReactNode;
  /** View-specific controls, shown after them — exports and the like. */
  trailing?: ReactNode;
  className?: string;
}

/** The tool row, with the properties panel it opens. */
export function AnnotationToolbar({ viewId, activeTool, onToolChange, leading, trailing, className }: AnnotationToolbarProps) {
  const clearViewAnnotations = useBubbleGraphStore((s) => s.clearViewAnnotations);
  const annotations = useBubbleGraphStore((s) => s.annotations);
  const selectedAnnotationId = useBubbleGraphStore((s) => s.selectedAnnotationId);
  const [showPanel, setShowPanel] = useState(false);
  const [showDimPanel, setShowDimPanel] = useState(false);
  const settings = useAnnotationSettings();

  // The style panel follows whatever is selected — it decides which
  // vocabulary to show from the annotation's kind, falling back to the armed
  // tool. So it needs the annotation itself, not just that one exists.
  const selectedAnn = useMemo(
    () => annotations.find((x) => x.id === selectedAnnotationId) ?? null,
    [annotations, selectedAnnotationId],
  );

  return (
    <>
      <div className={cn(
        'absolute top-2 right-2 z-20 flex items-center gap-0.5 bg-background/90 border border-border/60 rounded px-1 py-0.5',
        className,
      )}>
        {leading}
        {leading ? <div className="w-px h-4 bg-border mx-0.5" /> : null}
        {TOOLS.map(({ tool, icon, title }) => (
          <button
            key={tool}
            title={title}
            onClick={() => onToolChange(activeTool === tool ? null : tool)}
            className={cn(
              'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none',
              activeTool === tool
                ? 'bg-blue-600 text-white'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >{icon}</button>
        ))}
        <div className="w-px h-4 bg-border mx-0.5" />
        <button
          title="Șterge toate adnotările din această vedere"
          onClick={() => clearViewAnnotations(viewId)}
          className="w-6 h-6 flex items-center justify-center text-xs rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 transition-colors"
        >🗑</button>
        <button
          title="Proprietăți de desenare"
          onClick={() => { setShowPanel((v) => !v); setShowDimPanel(false); }}
          className={cn(
            'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none',
            showPanel ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >🎨</button>
        <button
          title={selectedAnn
            ? 'Stil cotă — editezi cota selectată'
            : 'Stil cotă — grosimi, capete, poziție text, unități'}
          onClick={() => { setShowDimPanel((v) => !v); setShowPanel(false); }}
          className={cn(
            'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none relative',
            showDimPanel ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          ↔
          {/* A dimension is selected, so this button edits THAT one. */}
          {selectedAnn && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" />
          )}
        </button>
        {trailing ? <div className="w-px h-4 bg-border mx-0.5" /> : null}
        {trailing}
      </div>

      {showPanel && (
        <div className="absolute top-10 right-2 z-20">
          <DrawingPropertiesPanel
            activeTool={activeTool}
            onToolChange={onToolChange}
            onClose={() => setShowPanel(false)}
          />
        </div>
      )}

      {showDimPanel && (
        <div className="absolute top-10 right-2 z-20">
          <StylePanel
            selected={selectedAnn}
            activeTool={activeTool}
            currentDimStyleId={settings.dimStyleId}
            currentDrawStyleId={settings.drawStyleId}
            onCurrentDimStyleChange={(id: string) => setAnnotationSettings({ dimStyleId: id })}
            onCurrentDrawStyleChange={(id: string) => setAnnotationSettings({ drawStyleId: id })}
            onClose={() => setShowDimPanel(false)}
          />
        </div>
      )}
    </>
  );
}
