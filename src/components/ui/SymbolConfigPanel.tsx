/**
 * SymbolConfigPanel — 2D symbols configuration UI (Item 10).
 *
 * Lets users visually configure how each BIM element type appears in
 * 2D plan views (floor plan, section, elevation).
 *
 * Settings per element type:
 *  - Section fill color + opacity + hatch pattern
 *  - Section line color + line weight + line style
 *  - View (overhead) line color + weight + style
 *  - 3D color + opacity
 *  - Live preview (SVG miniature cross-section)
 *
 * Changes are written to the material config and persisted via the
 * existing PUT /api/material-config backend endpoint.
 */

import React, { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import type {
  MaterialVisuals, HatchPattern, LineStyle,
} from '@/lib/materialConfig';
import { resolveVisuals } from '@/lib/materialConfig';

// ─── Element type catalog ─────────────────────────────────────────────────────

const ELEMENT_TYPES: { id: string; label: string; icon: string; group: string }[] = [
  { id: 'column',     label: 'Column',      icon: '▪',  group: 'Structure' },
  { id: 'beam',       label: 'Beam',        icon: '━',  group: 'Structure' },
  { id: 'wall',       label: 'Wall',        icon: '▬',  group: 'Structure' },
  { id: 'slab',       label: 'Slab',        icon: '□',  group: 'Structure' },
  { id: 'foundation', label: 'Foundation',  icon: '⊓',  group: 'Structure' },
  { id: 'window',     label: 'Window',      icon: '◻',  group: 'Opening' },
  { id: 'door',       label: 'Door',        icon: '◱',  group: 'Opening' },
  { id: 'room',       label: 'Room',        icon: '▢',  group: 'Space' },
  { id: 'shell',      label: 'Shell/Roof',  icon: '◆',  group: 'Envelope' },
  { id: 'covering',   label: 'Covering',    icon: '◇',  group: 'Envelope' },
  { id: 'void',       label: 'Void',        icon: '⊘',  group: 'Operations' },
  { id: 'object',     label: 'Library Obj', icon: '📦', group: 'Library' },
];

const HATCH_OPTIONS: { value: HatchPattern; label: string }[] = [
  { value: 'none',      label: 'None' },
  { value: 'solid',     label: 'Solid fill' },
  { value: 'diagonal',  label: 'Diagonal lines' },
  { value: 'crosshatch',label: 'Crosshatch' },
  { value: 'brick',     label: 'Brick' },
  { value: 'stone',     label: 'Stone' },
  { value: 'concrete',  label: 'Concrete' },
  { value: 'wave',      label: 'Wave' },
];

const LINE_STYLE_OPTIONS: { value: LineStyle; label: string }[] = [
  { value: 'solid',    label: 'Solid' },
  { value: 'dashed',   label: 'Dashed' },
  { value: 'dotted',   label: 'Dotted' },
  { value: 'dash-dot', label: 'Dash-dot' },
];

// ─── 2D Plan Symbol Preview ───────────────────────────────────────────────────

function PlanSymbolPreview({ vis }: { vis: MaterialVisuals }) {
  // Simulate a column cross-section (square) with current settings
  const fillColor   = vis.section_fill_color ?? vis.color_2d;
  const fillOpacity = vis.section_fill_opacity ?? vis.opacity_2d;
  const strokeColor = vis.section_line_color ?? vis.color_2d;
  const strokeW     = Math.max(0.5, (vis.section_line_weight ?? vis.line_weight) * 1.5);

  // Generate hatch pattern
  let patternEl: React.ReactNode = null;
  const patId = 'sym_prev_hatch';
  if (vis.hatch && vis.hatch !== 'none' && vis.hatch !== 'solid') {
    const hatchColor = strokeColor;
    if (vis.hatch === 'diagonal') {
      patternEl = (
        <defs>
          <pattern id={patId} width="8" height="8" patternUnits="userSpaceOnUse">
            <line x1="0" y1="8" x2="8" y2="0" stroke={hatchColor} strokeWidth="0.8" />
            <line x1="-8" y1="8" x2="0" y2="0" stroke={hatchColor} strokeWidth="0.8" />
            <line x1="8" y1="8" x2="16" y2="0" stroke={hatchColor} strokeWidth="0.8" />
          </pattern>
        </defs>
      );
    } else if (vis.hatch === 'crosshatch') {
      patternEl = (
        <defs>
          <pattern id={patId} width="8" height="8" patternUnits="userSpaceOnUse">
            <line x1="4" y1="0" x2="4" y2="8" stroke={hatchColor} strokeWidth="0.8" />
            <line x1="0" y1="4" x2="8" y2="4" stroke={hatchColor} strokeWidth="0.8" />
          </pattern>
        </defs>
      );
    } else if (vis.hatch === 'brick') {
      patternEl = (
        <defs>
          <pattern id={patId} width="16" height="8" patternUnits="userSpaceOnUse">
            <rect x="0.5" y="0.5" width="15" height="7" fill="none" stroke={hatchColor} strokeWidth="0.7" />
            <line x1="8" y1="0" x2="8" y2="4" stroke={hatchColor} strokeWidth="0.7" />
          </pattern>
        </defs>
      );
    } else if (vis.hatch === 'concrete') {
      patternEl = (
        <defs>
          <pattern id={patId} width="10" height="10" patternUnits="userSpaceOnUse">
            <circle cx="2.5" cy="2.5" r="0.9" fill={hatchColor} />
            <circle cx="7.5" cy="7.5" r="0.9" fill={hatchColor} />
            <circle cx="7.5" cy="2.5" r="0.5" fill={hatchColor} opacity="0.5" />
          </pattern>
        </defs>
      );
    }
  }

  const fill = vis.hatch === 'solid'
    ? fillColor
    : patternEl ? `url(#${patId})` : 'none';

  return (
    <svg width="80" height="80" viewBox="0 0 80 80" className="rounded border border-border/40 bg-card/60">
      {patternEl}
      {/* Section cut square */}
      <rect x="12" y="12" width="56" height="56"
        fill={fill}
        fillOpacity={vis.hatch === 'solid' ? fillOpacity : 0.85}
        stroke={strokeColor}
        strokeWidth={strokeW}
      />
    </svg>
  );
}

// ─── Field helpers ────────────────────────────────────────────────────────────

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label className="text-[10px] text-muted-foreground min-w-0 truncate">{label}</label>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
        className="w-7 h-5 rounded cursor-pointer border border-border/50 p-0 bg-transparent" />
    </div>
  );
}

function SliderField({ label, value, min, max, step, onChange, format }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between">
        <label className="text-[10px] text-muted-foreground">{label}</label>
        <span className="text-[10px] text-foreground font-medium tabular-nums">
          {format ? format(value) : value}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1 accent-violet-500" />
    </div>
  );
}

function SelectField<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label className="text-[10px] text-muted-foreground min-w-0 truncate">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="text-[10px] bg-muted/50 border border-border/50 rounded px-1.5 py-0.5 outline-none focus:border-violet-400"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export interface SymbolConfigPanelProps {
  className?: string;
}

export function SymbolConfigPanel({ className }: SymbolConfigPanelProps) {
  const { config, updateElementDefault, isSaving, saveError } = useMaterialConfig();
  const [selectedType, setSelectedType] = useState<string>('wall');
  const [savedMsg, setSavedMsg] = useState(false);

  // Current resolved visuals for selected type
  const vis = useMemo(() => resolveVisuals(selectedType, '', config), [selectedType, config]);

  function patch(updates: Partial<MaterialVisuals>) {
    updateElementDefault(selectedType, updates);
  }

  // Grouped element types
  const groups = useMemo(() => {
    const map = new Map<string, typeof ELEMENT_TYPES>();
    for (const et of ELEMENT_TYPES) {
      if (!map.has(et.group)) map.set(et.group, []);
      map.get(et.group)!.push(et);
    }
    return map;
  }, []);

  return (
    <div className={cn('flex h-full overflow-hidden bg-white dark:bg-zinc-900', className)}>
      {/* Left: type list */}
      <div className="w-32 flex-shrink-0 border-r border-border/60 overflow-y-auto bg-gray-50 dark:bg-zinc-800">
        <div className="px-2 pt-2 pb-1 text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">
          Element Types
        </div>
        {[...groups.entries()].map(([group, types]) => (
          <div key={group}>
            <div className="px-2 py-0.5 text-[9px] text-muted-foreground/60 border-b border-border/20">
              {group}
            </div>
            {types.map((et) => (
              <button
                key={et.id}
                onClick={() => setSelectedType(et.id)}
                className={cn(
                  'w-full text-left flex items-center gap-1.5 px-2 py-1 text-[10px] transition-colors',
                  selectedType === et.id
                    ? 'bg-violet-100/80 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 font-medium'
                    : 'hover:bg-accent text-foreground',
                )}
              >
                <span>{et.icon}</span>
                <span className="truncate">{et.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Right: settings */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 flex-shrink-0">
          <span className="text-xs font-semibold text-foreground">
            {ELEMENT_TYPES.find((e) => e.id === selectedType)?.label ?? selectedType}
          </span>
          <div className="flex items-center gap-2">
            {savedMsg && <span className="text-[10px] text-green-600">Saved ✓</span>}
            {saveError && <span className="text-[10px] text-red-500" title={saveError}>⚠ Error</span>}
            {isSaving && <span className="text-[10px] text-muted-foreground animate-pulse">Saving…</span>}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4 bg-white dark:bg-zinc-900">
          {/* Preview */}
          <div className="flex items-start gap-3">
            <PlanSymbolPreview vis={vis} />
            <div className="flex-1 text-[10px] text-muted-foreground leading-relaxed">
              <div className="font-medium text-foreground mb-1">2D Plan Cross-Section</div>
              <div>Section fill: <span className="text-foreground">{vis.section_fill_color ?? vis.color_2d}</span></div>
              <div>Hatch: <span className="text-foreground">{vis.hatch}</span></div>
              <div>Line: <span className="text-foreground">{vis.section_line_color ?? vis.color_2d}</span></div>
              <div>Weight: <span className="text-foreground">{vis.section_line_weight ?? vis.line_weight}</span></div>
            </div>
          </div>

          {/* 3D */}
          <div className="flex flex-col gap-2 p-2.5 rounded-md border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800">
            <div className="text-[10px] font-semibold text-foreground mb-0.5">3D Viewer</div>
            <ColorField label="Color" value={vis.color_3d}
              onChange={(v) => patch({ color_3d: v })} />
            <SliderField label="Opacity" value={vis.opacity_3d} min={0} max={1} step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => patch({ opacity_3d: v })} />
          </div>

          {/* Section / Cut */}
          <div className="flex flex-col gap-2 p-2.5 rounded-md border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800">
            <div className="text-[10px] font-semibold text-foreground mb-0.5">
              2D Section Cut
              <span className="ml-1 text-muted-foreground font-normal">(floor plan)</span>
            </div>
            <SelectField<HatchPattern>
              label="Hatch" value={vis.hatch}
              options={HATCH_OPTIONS}
              onChange={(v) => patch({ hatch: v })}
            />
            <ColorField label="Fill color"
              value={vis.section_fill_color ?? vis.color_2d}
              onChange={(v) => patch({ section_fill_color: v })} />
            <SliderField label="Fill opacity"
              value={vis.section_fill_opacity ?? vis.opacity_2d}
              min={0} max={1} step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => patch({ section_fill_opacity: v })} />
            <ColorField label="Line color"
              value={vis.section_line_color ?? vis.color_2d}
              onChange={(v) => patch({ section_line_color: v })} />
            <SliderField label="Line weight"
              value={vis.section_line_weight ?? vis.line_weight}
              min={0.3} max={5} step={0.1}
              onChange={(v) => patch({ section_line_weight: v })} />
            <SelectField<LineStyle>
              label="Line style"
              value={vis.section_line_style ?? 'solid'}
              options={LINE_STYLE_OPTIONS}
              onChange={(v) => patch({ section_line_style: v })}
            />
          </div>

          {/* View / Overhead */}
          <div className="flex flex-col gap-2 p-2.5 rounded-md border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800">
            <div className="text-[10px] font-semibold text-foreground mb-0.5">
              2D View
              <span className="ml-1 text-muted-foreground font-normal">(overhead / not cut)</span>
            </div>
            <ColorField label="Line color"
              value={vis.view_line_color ?? vis.color_2d}
              onChange={(v) => patch({ view_line_color: v })} />
            <SliderField label="Line weight"
              value={vis.view_line_weight ?? vis.line_weight * 0.6}
              min={0.2} max={4} step={0.1}
              onChange={(v) => patch({ view_line_weight: v })} />
            <SelectField<LineStyle>
              label="Line style"
              value={vis.view_line_style ?? 'dashed'}
              options={LINE_STYLE_OPTIONS}
              onChange={(v) => patch({ view_line_style: v })}
            />
          </div>

          {/* Base 2D */}
          <div className="flex flex-col gap-2 p-2.5 rounded-md border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800">
            <div className="text-[10px] font-semibold text-foreground mb-0.5">
              Base 2D
              <span className="ml-1 text-muted-foreground font-normal">(fallback for all 2D)</span>
            </div>
            <ColorField label="Color" value={vis.color_2d}
              onChange={(v) => patch({ color_2d: v })} />
            <SliderField label="Opacity" value={vis.opacity_2d} min={0} max={1} step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => patch({ opacity_2d: v })} />
            <SliderField label="Line weight" value={vis.line_weight} min={0.2} max={5} step={0.1}
              onChange={(v) => patch({ line_weight: v })} />
          </div>
        </div>
      </div>
    </div>
  );
}
