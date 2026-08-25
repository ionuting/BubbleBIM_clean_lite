/**
 * MaterialConfigEditor — modal editor for backend/materials.yaml visual settings.
 *
 * Allows editing per-element-type defaults and named material catalogue entries.
 * Changes are saved via PUT /api/material-config and cached via useMaterialConfig.
 *
 * Works offline: falls back to BUILTIN_ELEMENT_DEFAULTS when backend is unreachable.
 *
 * Three-column layout per element:
 *   1. 3D View    — colour + opacity
 *   2. Section/Cut — line colour, weight, style + fill colour/opacity
 *   3. 2D Overhead — line colour, weight, style
 *   + shared: hatch pattern, fill texture
 */
import React, { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import {
  type MaterialConfig,
  type MaterialVisuals,
  type NamedMaterial,
  type HatchPattern,
  type LineStyle,
  type WindowGlazingConfig,
  BUILTIN_ELEMENT_DEFAULTS,
  BUILTIN_WINDOW_GLAZING,
  getSectionLineColor, getSectionLineWeight, getSectionLineStyle,
  getSectionFillColor, getSectionFillOpacity,
  getViewLineColor, getViewLineWeight, getViewLineStyle,
} from '@/lib/materialConfig';

/** Offline-safe fallback config when backend is unreachable */
const OFFLINE_CONFIG: MaterialConfig = {
  version: 1,
  element_defaults: BUILTIN_ELEMENT_DEFAULTS,
  materials: {},
};

/**
 * Every element type the app can style: the built-ins plus anything extra the
 * saved config carries, in a stable order (built-ins first, then extras).
 */
function editableElementTypes(config: MaterialConfig): string[] {
  const builtin = Object.keys(BUILTIN_ELEMENT_DEFAULTS);
  const extra = Object.keys(config.element_defaults ?? {}).filter((t) => !builtin.includes(t));
  return [...builtin, ...extra];
}

const HATCH_OPTIONS: HatchPattern[] =['none', 'solid', 'diagonal', 'crosshatch', 'wave', 'brick', 'stone', 'concrete'];
const LINE_STYLE_OPTIONS: LineStyle[] = ['solid', 'dashed', 'dotted', 'dash-dot'];
const LINE_STYLE_LABELS: Record<LineStyle, string> = { solid: '── solid', dashed: '╌─ dashed', dotted: '··· dotted', 'dash-dot': '─·─ dash-dot' };

// `shell` used to be labelled "Shell / Roof", which sent anyone looking for roof
// colours to the wrong row: pitched roofs render as `roof`, not `shell`.
const ELEMENT_TYPE_LABELS: Record<string, string> = {
  column: 'Column', beam: 'Beam', wall: 'Wall', slab: 'Slab', foundation: 'Foundation',
  window: 'Window', door: 'Door', room: 'Room', shell: 'Shell', covering: 'Covering', ax: 'Grid Axis',
  roof: 'Roof', roof_ridge: 'Roof Ridge', skylight: 'Skylight', dormer: 'Dormer', void: 'Void',
};

const ELEMENT_ICONS: Record<string, string> = {
  column: '⬛', beam: '━', wall: '▬', slab: '▭', foundation: '⊞',
  window: '⊡', door: '⊟', room: '□', shell: '◬', covering: '⌒', ax: '✛',
  roof: '⌂', roof_ridge: '△', skylight: '☀', dormer: '⌗', void: '⊘',
};

// ── Sub-components ────────────────────────────────────────────────────────

function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      <input type="color" className="w-5 h-5 rounded cursor-pointer border-0 p-0 shrink-0" value={value} onChange={(e) => onChange(e.target.value)} />
      <input
        className="w-16 rounded bg-white border border-gray-200 px-1 py-0.5 text-[9px] font-mono text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-400"
        value={value}
        onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && onChange(e.target.value)}
      />
    </div>
  );
}

function SliderField({ label, value, onChange, min = 0, max = 1, step = 0.05 }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-gray-400 text-[8px] shrink-0 w-10">{label}</span>
      <input type="range" min={min} max={max} step={step} className="flex-1 accent-blue-500 h-1 min-w-0" value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <span className="text-gray-600 text-[8px] w-7 text-right tabular-nums shrink-0">{max === 1 ? `${Math.round(value * 100)}%` : value.toFixed(2)}</span>
    </div>
  );
}

function NumberField({ label, value, onChange, min = 0.05, max = 5, step = 0.05 }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-gray-400 text-[8px] shrink-0 w-10">{label}</span>
      <input type="number" min={min} max={max} step={step}
        className="flex-1 min-w-0 rounded bg-white border border-gray-200 px-1 py-0.5 text-[9px] text-gray-800 tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-400"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || min)}
      />
    </div>
  );
}

function LineStyleSelect({ value, onChange }: { value: LineStyle; onChange: (v: LineStyle) => void }) {
  return (
    <select className="w-full rounded bg-white border border-gray-200 px-1 py-0.5 text-[9px] text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-400"
      value={value} onChange={(e) => onChange(e.target.value as LineStyle)}>
      {LINE_STYLE_OPTIONS.map((s) => <option key={s} value={s}>{LINE_STYLE_LABELS[s]}</option>)}
    </select>
  );
}

// ── VisualsRow — 3-column card ─────────────────────────────────────────────

interface VisualsRowProps {
  label: string;
  icon?: string;
  visuals: MaterialVisuals;
  onChange: (updated: MaterialVisuals) => void;
  onDelete?: () => void;
  sublabel?: string;
}

function VisualsRow({ label, icon, visuals, onChange, onDelete, sublabel }: VisualsRowProps) {
  const set = <K extends keyof MaterialVisuals>(key: K, val: MaterialVisuals[K]) =>
    onChange({ ...visuals, [key]: val });
  const [expanded, setExpanded] = useState(false);

  const secLineColor = getSectionLineColor(visuals);
  const secLineWeight = getSectionLineWeight(visuals);
  const secLineStyle = getSectionLineStyle(visuals);
  const secFillColor = getSectionFillColor(visuals);
  const secFillOp = getSectionFillOpacity(visuals);
  const vwLineColor = getViewLineColor(visuals);
  const vwLineWeight = getViewLineWeight(visuals);
  const vwLineStyle = getViewLineStyle(visuals);

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-2.5 px-3 py-2 bg-gray-50 border-b border-gray-200 cursor-pointer select-none hover:bg-gray-100 transition-colors"
        onClick={() => setExpanded((p) => !p)}
      >
        <div className="w-4 h-4 rounded border border-gray-300 shrink-0 shadow-sm" style={{ background: visuals.color_3d }} />
        <div className="w-3 h-3 rounded-sm border border-gray-300 shrink-0" style={{ background: getSectionFillColor(visuals) }} />
        <div className="w-3 h-3 rounded-sm border border-gray-200 shrink-0" style={{ background: getViewLineColor(visuals), opacity: 0.7 }} />
        <span className="font-semibold text-xs text-gray-900 flex-1 ml-1">{label}</span>
        {icon && <span className="text-[10px] text-gray-400">{icon}</span>}
        {sublabel && <span className="text-[9px] text-gray-400 font-mono bg-gray-100 px-1.5 py-0.5 rounded">{sublabel}</span>}
        {onDelete && (
          <button className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-all text-[10px] ml-1"
            onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete material">✕</button>
        )}
        <span className="text-[9px] text-gray-400 ml-1">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <>
          {/* 3-column grid */}
          <div className="grid grid-cols-3 gap-px bg-gray-100 text-[11px]">
            {/* ── Column 1: 3D View ── */}
            <div className="px-2.5 py-2 bg-white space-y-1.5">
              <div className="text-[8px] font-bold text-gray-400 uppercase tracking-widest">3D View</div>
              <ColorField value={visuals.color_3d} onChange={(v) => set('color_3d', v)} />
              <SliderField label="Opacity" value={visuals.opacity_3d} onChange={(v) => set('opacity_3d', v)} />
            </div>

            {/* ── Column 2: Section / Cut ── */}
            <div className="px-2.5 py-2 bg-white space-y-1.5">
              <div className="text-[8px] font-bold text-orange-500 uppercase tracking-widest">Section / Cut</div>
              <div className="text-[8px] text-gray-400 -mt-1">Line</div>
              <ColorField value={secLineColor} onChange={(v) => set('section_line_color', v)} />
              <NumberField label="Weight" value={secLineWeight} onChange={(v) => set('section_line_weight', v)} />
              <LineStyleSelect value={secLineStyle} onChange={(v) => set('section_line_style', v)} />
              <div className="text-[8px] text-gray-400 mt-1">Fill</div>
              <ColorField value={secFillColor} onChange={(v) => set('section_fill_color', v)} />
              <SliderField label="Opacity" value={secFillOp} onChange={(v) => set('section_fill_opacity', v)} />
            </div>

            {/* ── Column 3: 2D Overhead View ── */}
            <div className="px-2.5 py-2 bg-white space-y-1.5">
              <div className="text-[8px] font-bold text-teal-600 uppercase tracking-widest">2D Overhead</div>
              <div className="text-[8px] text-gray-400 -mt-1">Line</div>
              <ColorField value={vwLineColor} onChange={(v) => set('view_line_color', v)} />
              <NumberField label="Weight" value={vwLineWeight} onChange={(v) => set('view_line_weight', v)} />
              <LineStyleSelect value={vwLineStyle} onChange={(v) => set('view_line_style', v)} />
              {/* Fallback / base colour */}
              <div className="text-[8px] text-gray-400 mt-1">Base colour</div>
              <ColorField value={visuals.color_2d} onChange={(v) => set('color_2d', v)} />
              <SliderField label="Opacity" value={visuals.opacity_2d} onChange={(v) => set('opacity_2d', v)} />
            </div>
          </div>

          {/* Shared bottom row: hatch + texture */}
          <div className="px-3 py-2 bg-gray-50 border-t border-gray-100 flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-[8px] text-gray-400 uppercase tracking-wider">Hatch</span>
              <select className="rounded bg-white border border-gray-200 px-1.5 py-0.5 text-[9px] text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-400"
                value={visuals.hatch} onChange={(e) => set('hatch', e.target.value as HatchPattern)}>
                {HATCH_OPTIONS.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-[8px] text-gray-400 uppercase tracking-wider shrink-0">Texture</span>
              <input
                className="flex-1 min-w-0 rounded bg-white border border-gray-200 px-1.5 py-0.5 text-[9px] font-mono text-gray-700 placeholder:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-400"
                placeholder="e.g. brick.svg (from /textures/)"
                value={visuals.fill_texture ?? ''}
                onChange={(e) => set('fill_texture', e.target.value || undefined)}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main editor component ──────────────────────────────────────────────────

interface MaterialConfigEditorProps {
  onClose: () => void;
}

export function MaterialConfigEditor({ onClose }: MaterialConfigEditorProps) {
  const { config, loading, save, refresh } = useMaterialConfig();
  const [draft, setDraft] = useState<MaterialConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'elements' | 'materials' | 'glazing'>('elements');
  const [newMatId, setNewMatId] = useState('');
  const [newMatLabel, setNewMatLabel] = useState('');

  // Always have content — offline fallback ensures body is never empty
  const working: MaterialConfig = draft ?? config ?? OFFLINE_CONFIG;
  const isOffline = !config && !loading;

  const updateElementDefault = useCallback((type: string, updated: MaterialVisuals) => {
    setDraft((prev) => {
      const base = prev ?? config ?? OFFLINE_CONFIG;
      return { ...base, element_defaults: { ...base.element_defaults, [type]: updated } };
    });
  }, [config]);

  const updateMaterial = useCallback((id: string, updated: Partial<NamedMaterial>) => {
    setDraft((prev) => {
      const base = prev ?? config ?? OFFLINE_CONFIG;
      return { ...base, materials: { ...base.materials, [id]: { ...base.materials[id], ...updated } } };
    });
  }, [config]);

  const deleteMaterial = useCallback((id: string) => {
    setDraft((prev) => {
      const base = prev ?? config ?? OFFLINE_CONFIG;
      const { [id]: _removed, ...rest } = base.materials;
      return { ...base, materials: rest };
    });
  }, [config]);

  const addMaterial = useCallback(() => {
    const id = newMatId.trim().toLowerCase().replace(/\s+/g, '_');
    if (!id) return;
    setDraft((prev) => {
      const base = prev ?? config ?? OFFLINE_CONFIG;
      if (base.materials[id]) { alert(`Material "${id}" already exists.`); return prev; }
      const newMat: NamedMaterial = {
        label: newMatLabel.trim() || id,
        color_3d: '#888888', opacity_3d: 1.0,
        color_2d: '#AAAAAA', opacity_2d: 1.0,
        line_weight: 0.5, hatch: 'none',
      };
      return { ...base, materials: { ...base.materials, [id]: newMat } };
    });
    setNewMatId('');
    setNewMatLabel('');
  }, [config, newMatId, newMatLabel]);

  const updateGlazing = useCallback(<K extends keyof WindowGlazingConfig>(key: K, val: WindowGlazingConfig[K]) => {
    setDraft((prev) => {
      const base = prev ?? config ?? OFFLINE_CONFIG;
      const glz = base.window_glazing ?? BUILTIN_WINDOW_GLAZING;
      return { ...base, window_glazing: { ...glz, [key]: val } };
    });
  }, [config]);

  const handleSave = async () => {
    if (!draft) { onClose(); return; }
    setSaving(true);
    try {
      await save(draft);
      setDraft(null);
    } catch (err) {
      alert('Failed to save material config: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const isDirty = draft !== null;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50">
      <div className="flex flex-col w-[820px] max-h-[88vh] rounded-2xl bg-white border border-gray-200 shadow-2xl shadow-black/20 overflow-hidden">

        {/* ── Header ── */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200 bg-gray-50 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-base">
            🎨
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-sm text-gray-900 leading-tight">Material Config</h3>
            <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">
              Visual properties for 3D, 2D &amp; section views
              {isOffline && <span className="ml-2 text-amber-600 font-medium">· offline — backend unreachable</span>}
            </p>
          </div>
          {loading && <div className="w-4 h-4 rounded-full border-2 border-blue-200 border-t-blue-500 animate-spin shrink-0" />}
          <button className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-all text-sm ml-1" onClick={onClose}>✕</button>
        </div>

        {/* ── Tabs ── */}
        <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-gray-200 shrink-0 bg-white">
          {(['elements', 'materials', 'glazing'] as const).map((t) => (
            <button
              key={t}
              className={cn(
                'relative px-4 py-1.5 text-xs font-semibold rounded-lg transition-all',
                tab === t
                  ? 'text-blue-600 bg-blue-50 border border-blue-200 shadow-sm'
                  : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100',
              )}
              onClick={() => setTab(t)}
            >
              {t === 'elements' ? '⬛ Element Types' : t === 'materials' ? '🗃 Named Materials' : '⊡ Frame & Glass'}
            </button>
          ))}
          {isDirty && <span className="ml-auto text-[9px] text-amber-600 font-medium tracking-wide">● unsaved changes</span>}
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {tab === 'elements' && (
            // Union with the built-ins, not just what the saved YAML happens to
            // hold: a config written before an element type existed would
            // otherwise make that type permanently uneditable. That is exactly
            // how roofs ended up stuck on their built-in colour.
            editableElementTypes(working).map((type) => (
              <VisualsRow
                key={type}
                label={ELEMENT_TYPE_LABELS[type] ?? type}
                sublabel={type}
                icon={ELEMENT_ICONS[type]}
                visuals={working.element_defaults[type] ?? BUILTIN_ELEMENT_DEFAULTS[type]}
                onChange={(updated) => updateElementDefault(type, updated)}
              />
            ))
          )}

          {tab === 'materials' && (<>
            {Object.keys(working.materials).length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-gray-300 gap-2">
                <span className="text-3xl">🗃</span>
                <span className="text-xs">No named materials yet — add one below</span>
              </div>
            )}
            {Object.entries(working.materials).map(([id, mat]) => (
              <VisualsRow
                key={id}
                label={(mat as NamedMaterial).label ?? id}
                sublabel={id}
                visuals={mat as MaterialVisuals}
                onChange={(updated) => updateMaterial(id, updated)}
                onDelete={() => deleteMaterial(id)}
              />
            ))}

            {/* Add new material */}
            <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-3.5 space-y-2.5 mt-1">
              <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Add Material</div>
              <div className="flex gap-2">
                <input
                  className="flex-1 min-w-0 rounded-lg bg-white border border-gray-300 text-gray-900 px-3 py-2 text-xs placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-400 transition-all font-mono"
                  placeholder="id, e.g. tile_ceramic"
                  value={newMatId}
                  onChange={(e) => setNewMatId(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addMaterial()}
                />
                <input
                  className="flex-1 min-w-0 rounded-lg bg-white border border-gray-300 text-gray-900 px-3 py-2 text-xs placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-400 transition-all"
                  placeholder="label, e.g. Ceramic Tile"
                  value={newMatLabel}
                  onChange={(e) => setNewMatLabel(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addMaterial()}
                />
                <button onClick={addMaterial} disabled={!newMatId.trim()} className="text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 transition-all font-medium disabled:opacity-40 shrink-0">
                  + Add
                </button>
              </div>
            </div>
          </>)}

          {tab === 'glazing' && (() => {
            const glz = working.window_glazing ?? BUILTIN_WINDOW_GLAZING;
            return (<>
              <div className="text-[10px] text-gray-500 mb-2 leading-relaxed">
                Global frame & glass properties applied to <strong>all</strong> windows and doors — both generic and IFC-loaded.
              </div>

              {/* ── Frame ── */}
              <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <div className="flex items-center gap-2.5 px-3 py-2 bg-gray-50 border-b border-gray-200">
                  <div className="w-5 h-5 rounded-md border border-gray-300 shrink-0 shadow-sm" style={{ background: glz.frame_color }} />
                  <span className="font-semibold text-xs text-gray-900 flex-1">Window / Door Frame</span>
                  <span className="text-[9px] text-gray-400 font-mono bg-gray-100 px-1.5 py-0.5 rounded">frame</span>
                </div>
                <div className="px-3 py-3 space-y-2.5 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-[10px] w-16 shrink-0">Color</span>
                    <input type="color" className="w-6 h-6 rounded cursor-pointer border-0 p-0 shrink-0" value={glz.frame_color} onChange={(e) => updateGlazing('frame_color', e.target.value)} />
                    <input className="flex-1 rounded-md bg-white border border-gray-300 px-2 py-1 text-[10px] font-mono text-gray-900 min-w-0 focus:outline-none focus:ring-1 focus:ring-blue-400"
                      value={glz.frame_color}
                      onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && updateGlazing('frame_color', e.target.value)}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-[10px] w-16 shrink-0">Metalness</span>
                    <input type="range" min="0" max="1" step="0.05" className="flex-1 accent-blue-500 h-1" value={glz.frame_metalness} onChange={(e) => updateGlazing('frame_metalness', parseFloat(e.target.value))} />
                    <span className="text-gray-600 text-[9px] w-8 text-right tabular-nums">{glz.frame_metalness.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-[10px] w-16 shrink-0">Roughness</span>
                    <input type="range" min="0" max="1" step="0.05" className="flex-1 accent-blue-500 h-1" value={glz.frame_roughness} onChange={(e) => updateGlazing('frame_roughness', parseFloat(e.target.value))} />
                    <span className="text-gray-600 text-[9px] w-8 text-right tabular-nums">{glz.frame_roughness.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* ── Glass ── */}
              <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <div className="flex items-center gap-2.5 px-3 py-2 bg-gray-50 border-b border-gray-200">
                  <div className="w-5 h-5 rounded-md border border-gray-300 shrink-0 shadow-sm" style={{ background: glz.glass_color, opacity: glz.glass_opacity }} />
                  <span className="font-semibold text-xs text-gray-900 flex-1">Window Glass</span>
                  <span className="text-[9px] text-gray-400 font-mono bg-gray-100 px-1.5 py-0.5 rounded">glass</span>
                </div>
                <div className="px-3 py-3 space-y-2.5 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-[10px] w-16 shrink-0">Color</span>
                    <input type="color" className="w-6 h-6 rounded cursor-pointer border-0 p-0 shrink-0" value={glz.glass_color} onChange={(e) => updateGlazing('glass_color', e.target.value)} />
                    <input className="flex-1 rounded-md bg-white border border-gray-300 px-2 py-1 text-[10px] font-mono text-gray-900 min-w-0 focus:outline-none focus:ring-1 focus:ring-blue-400"
                      value={glz.glass_color}
                      onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && updateGlazing('glass_color', e.target.value)}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-[10px] w-16 shrink-0">Opacity</span>
                    <input type="range" min="0" max="1" step="0.05" className="flex-1 accent-blue-500 h-1" value={glz.glass_opacity} onChange={(e) => updateGlazing('glass_opacity', parseFloat(e.target.value))} />
                    <span className="text-gray-600 text-[9px] w-8 text-right tabular-nums">{Math.round(glz.glass_opacity * 100)}%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-[10px] w-16 shrink-0">Metalness</span>
                    <input type="range" min="0" max="1" step="0.05" className="flex-1 accent-blue-500 h-1" value={glz.glass_metalness} onChange={(e) => updateGlazing('glass_metalness', parseFloat(e.target.value))} />
                    <span className="text-gray-600 text-[9px] w-8 text-right tabular-nums">{glz.glass_metalness.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-[10px] w-16 shrink-0">Roughness</span>
                    <input type="range" min="0" max="1" step="0.05" className="flex-1 accent-blue-500 h-1" value={glz.glass_roughness} onChange={(e) => updateGlazing('glass_roughness', parseFloat(e.target.value))} />
                    <span className="text-gray-600 text-[9px] w-8 text-right tabular-nums">{glz.glass_roughness.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </>);
          })()}
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center justify-between border-t border-gray-200 px-5 py-3 bg-gray-50 shrink-0">
          <div className="flex items-center gap-3">
            {isOffline && (
              <button className="text-[10px] text-blue-600 hover:text-blue-700 transition-colors font-medium" onClick={refresh}>↺ Retry backend</button>
            )}
            {isDirty && (
              <button className="text-[10px] text-gray-500 hover:text-gray-700 transition-colors" onClick={() => setDraft(null)}>Discard changes</button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-xs px-4 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 transition-all font-medium">Close</button>
            <button onClick={handleSave} disabled={saving || !isDirty || isOffline}
              className="text-xs px-5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-all shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
              title={isOffline ? 'Backend offline — cannot save' : ''}>
              {saving ? '↺ Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
