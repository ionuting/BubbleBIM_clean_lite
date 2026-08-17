/**
 * DrawingPropertiesPanel — floating properties panel for 2D SVG drawing tools.
 *
 * Shows tool palette + stroke/fill/hatch/text settings.
 * Reads/writes via annotationDrawingSettings (localStorage-backed).
 */
import React, { useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { SvgAnnotationTool } from './SvgAnnotationLayer';
import {
  getAnnotationSettings,
  setAnnotationSettings,
  resetAnnotationSettings,
  subscribeAnnotationSettings,
  type AnnotationDrawingSettings,
} from '@/lib/annotationDrawingSettings';
import { HATCH_PATTERNS } from './SvgHatches';

// ─── Tool definitions ─────────────────────────────────────────────────────────

interface ToolDef {
  tool: SvgAnnotationTool;
  icon: string;
  label: string;
}

const TOOLS: ToolDef[] = [
  { tool: 'select',    icon: '↖',  label: 'Select / move' },
  { tool: 'text',      icon: 'T',  label: 'Text label' },
  { tool: 'dimension', icon: '↔',  label: 'Dimension' },
  { tool: 'leader',    icon: '↗',  label: 'Leader' },
  { tool: 'line',      icon: '╱',  label: 'Line' },
  { tool: 'arc',       icon: '⌒',  label: 'Arc' },
  { tool: 'polyline',  icon: '╮',  label: 'Polyline' },
  { tool: 'rect',      icon: '▭',  label: 'Rectangle' },
  { tool: 'circle',    icon: '○',  label: 'Circle' },
  { tool: 'hatch',     icon: '▦',  label: 'Hatch fill' },
  { tool: 'join',      icon: '⋈',  label: 'Join lines' },
  { tool: 'trim',      icon: '✂',  label: 'Trim' },
  { tool: 'eraser',    icon: '✕',  label: 'Eraser' },
];

// ─── Props ────────────────────────────────────────────────────────────────────

interface DrawingPropertiesPanelProps {
  activeTool: SvgAnnotationTool | null;
  onToolChange: (tool: SvgAnnotationTool | null) => void;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DrawingPropertiesPanel({
  activeTool,
  onToolChange,
  onClose,
}: DrawingPropertiesPanelProps) {
  const [s, setS] = useState<AnnotationDrawingSettings>(() => getAnnotationSettings());

  useEffect(() => subscribeAnnotationSettings(() => setS(getAnnotationSettings())), []);

  const set = useCallback(<K extends keyof AnnotationDrawingSettings>(key: K, value: AnnotationDrawingSettings[K]) => {
    setAnnotationSettings({ [key]: value });
  }, []);

  return (
    <div className="flex flex-col gap-2 text-xs bg-background border border-border/70 rounded-lg shadow-xl p-3 w-[220px] select-none">

      {/* Header */}
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-semibold text-foreground text-[11px]">Drawing</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground leading-none">✕</button>
      </div>

      {/* ── Tool grid ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-1">
        {TOOLS.map(({ tool, icon, label }) => (
          <button
            key={tool}
            title={label}
            onClick={() => onToolChange(activeTool === tool ? null : tool)}
            className={cn(
              'h-8 flex flex-col items-center justify-center rounded text-[10px] gap-0.5 transition-colors border',
              activeTool === tool
                ? 'bg-blue-600 text-white border-blue-700'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground border-border/40',
            )}
          >
            <span className="text-sm leading-none">{icon}</span>
            <span className="leading-none truncate w-full text-center">{label.split(' ')[0]}</span>
          </button>
        ))}
      </div>

      <div className="border-t border-border/40" />

      {/* ── Stroke ─────────────────────────────────────────────────────────── */}
      <Section label="Stroke">
        <Row label="Line colour">
          <input type="color" value={s.drawColor}
            onChange={(e) => set('drawColor', e.target.value)}
            className="w-8 h-6 rounded cursor-pointer border border-border/50 p-0" />
          <code className="text-[10px] text-muted-foreground w-14">{s.drawColor}</code>
        </Row>
        <Row label="Weight">
          <input type="range" min={1} max={60} step={1} value={s.strokeSvg}
            onChange={(e) => set('strokeSvg', Number(e.target.value))}
            className="w-20 accent-blue-500" />
          <span className="w-8 text-right text-muted-foreground">{s.strokeSvg}</span>
        </Row>
        <Row label="Style">
          <div className="flex gap-0.5">
            {(['solid', 'dashed', 'dotted'] as const).map((st) => (
              <button key={st} title={st} onClick={() => set('strokeStyle', st)}
                className={cn(
                  'px-1.5 py-0.5 rounded border text-[10px] transition-colors',
                  s.strokeStyle === st
                    ? 'bg-blue-600 text-white border-blue-700'
                    : 'text-muted-foreground border-border/40 hover:bg-accent',
                )}>
                {st === 'solid' ? '—' : st === 'dashed' ? '- -' : '···'}
              </button>
            ))}
          </div>
        </Row>
      </Section>

      <div className="border-t border-border/40" />

      {/* ── Fill ────────────────────────────────────────────────────────────── */}
      <Section label="Fill">
        <Row label="Fill colour">
          <input type="color" value={s.fillColor}
            onChange={(e) => set('fillColor', e.target.value)}
            className="w-8 h-6 rounded cursor-pointer border border-border/50 p-0" />
          <code className="text-[10px] text-muted-foreground w-14">{s.fillColor}</code>
        </Row>
        <Row label="Opacity">
          <input type="range" min={0} max={1} step={0.05} value={s.fillOpacity}
            onChange={(e) => set('fillOpacity', Number(e.target.value))}
            className="w-20 accent-blue-500" />
          <span className="w-8 text-right text-muted-foreground">{Math.round(s.fillOpacity * 100)}%</span>
        </Row>
      </Section>

      <div className="border-t border-border/40" />

      {/* ── Dimension / Leader colours ──────────────────────────────────────── */}
      <Section label="Dimension &amp; Leader">
        <Row label="Dim colour">
          <input type="color" value={s.dimColor}
            onChange={(e) => set('dimColor', e.target.value)}
            className="w-8 h-6 rounded cursor-pointer border border-border/50 p-0" />
          <code className="text-[10px] text-muted-foreground w-14">{s.dimColor}</code>
        </Row>
      </Section>

      <div className="border-t border-border/40" />

      {/* ── Text ────────────────────────────────────────────────────────────── */}
      <Section label="Text">
        <Row label="Text colour">
          <input type="color" value={s.textColor}
            onChange={(e) => set('textColor', e.target.value)}
            className="w-8 h-6 rounded cursor-pointer border border-border/50 p-0" />
          <code className="text-[10px] text-muted-foreground w-14">{s.textColor}</code>
        </Row>
        <Row label="Size">
          <input type="range" min={40} max={600} step={10} value={s.fontSizeSvg}
            onChange={(e) => set('fontSizeSvg', Number(e.target.value))}
            className="w-20 accent-blue-500" />
          <span className="w-8 text-right text-muted-foreground">{s.fontSizeSvg}</span>
        </Row>
        <Row label="Bold">
          <button onClick={() => set('fontBold', !s.fontBold)}
            className={cn(
              'w-8 h-6 rounded border text-[11px] font-bold transition-colors',
              s.fontBold
                ? 'bg-blue-600 text-white border-blue-700'
                : 'text-muted-foreground border-border/40 hover:bg-accent',
            )}>B</button>
        </Row>
      </Section>

      <div className="border-t border-border/40" />

      {/* ── Hatch ───────────────────────────────────────────────────────────── */}
      <Section label="Hatch">
        {/* Pattern grid */}
        <div className="grid grid-cols-4 gap-1 mb-1">
          {HATCH_PATTERNS.map(({ id, label }) => (
            <button key={id} title={label} onClick={() => set('hatchPattern', id)}
              className={cn(
                'h-7 rounded border text-[9px] transition-colors leading-tight px-0.5',
                s.hatchPattern === id
                  ? 'bg-blue-600 text-white border-blue-700'
                  : 'text-muted-foreground border-border/40 hover:bg-accent',
              )}>
              {label}
            </button>
          ))}
        </div>
        <Row label="Spacing">
          <input type="range" min={0.3} max={3} step={0.1} value={s.hatchSpacing}
            onChange={(e) => set('hatchSpacing', Number(e.target.value))}
            className="w-20 accent-blue-500" />
          <span className="w-8 text-right text-muted-foreground">{s.hatchSpacing.toFixed(1)}×</span>
        </Row>
        <Row label="Angle">
          <input type="number" min={0} max={359} step={5} value={s.hatchAngle}
            onChange={(e) => set('hatchAngle', Number(e.target.value))}
            className="w-14 px-1 py-0.5 border border-border rounded bg-background text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
          <span className="text-muted-foreground">°</span>
        </Row>
        <Row label="Opacity">
          <input type="range" min={0} max={1} step={0.05} value={s.hatchOpacity}
            onChange={(e) => set('hatchOpacity', Number(e.target.value))}
            className="w-20 accent-blue-500" />
          <span className="w-8 text-right text-muted-foreground">{Math.round(s.hatchOpacity * 100)}%</span>
        </Row>
      </Section>

      {/* ── Reset ───────────────────────────────────────────────────────────── */}
      <div className="border-t border-border/40 pt-1">
        <button onClick={() => resetAnnotationSettings()}
          className="text-[10px] text-muted-foreground hover:text-foreground border border-border/40 rounded px-2 py-0.5 w-full">
          ↺ Reset to defaults
        </button>
      </div>
    </div>
  );
}

// ─── Small layout helpers ─────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide"
        dangerouslySetInnerHTML={{ __html: label }} />
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-1">
      <span className="text-muted-foreground flex-1 shrink-0">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}
