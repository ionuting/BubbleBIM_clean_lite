/**
 * WindowConfigurator.tsx — ArchiCAD-style parametric window symbol configurator.
 *
 * Controls the 2D floor-plan symbol appearance for each window type (or opening
 * family) globally across all floor-plan viewers.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  [Opening family selector]  [Per-type override toggle]          │
 *   ├──────────────────┬──────────────────────┬───────────────────────┤
 *   │  Window type     │  SVG preview         │  Settings form        │
 *   │  list (grouped)  │  (live update)       │  (numeric + color)    │
 *   └──────────────────┴──────────────────────┴───────────────────────┘
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { WINDOW_TYPES } from '@/lib/elementLibrary';
import { SymbolStudio } from '@/components/symbol-editor/SymbolStudio';
import { DxfSymbolPanel } from '@/components/symbol-editor/DxfSymbolPanel';
import {
  resolveAutoSymbol,
  subscribeBglibStore,
  fetchAutoSymbol,
} from '@/lib/bglibSymbolStore';
import { renderBglibSymbolSVG } from '@/lib/dxfSymbolRenderer';
import {
  DEFAULT_WINDOW_PLAN_CONFIG,
  openingKey,
  renderWindowPlanSymbolSVG,
  setWindowPlan2DConfig,
  resetWindowPlan2DConfig,
  exportRegistry,
  type WindowPlan2DConfig,
} from '@/lib/windowSymbolLibrary';
import { useWindowSymbolConfig } from '@/hooks/useWindowSymbolConfig';

const STORAGE_KEY = 'bg_window_symbol_registry_v1';
function saveToStorage() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(exportRegistry())); } catch { /* ignore */ }
}

// ─── Types ─────────────────────────────────────────────────────────────────────

type OpeningFamily = 'none' | 'single' | 'double' | 'tilt-turn';

interface ConfigKey {
  /** 'opening:single' | 'opening:double' | typeId */
  key: string;
  label: string;
  opening: OpeningFamily;
  /** Is this an opening-family key (applies to all types of that family)? */
  isFamily: boolean;
}

// ─── Opening family options ────────────────────────────────────────────────────

const OPENING_FAMILIES: { id: OpeningFamily; label: string }[] = [
  { id: 'none',       label: 'Fixed Glazing' },
  { id: 'single',     label: 'Single Casement' },
  { id: 'double',     label: 'Double Casement' },
  { id: 'tilt-turn',  label: 'Tilt-Turn' },
];

// ─── Sub-components ────────────────────────────────────────────────────────────

function ColorInput({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-xs text-gray-600 w-32 shrink-0">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-7 h-6 rounded border border-gray-300 cursor-pointer p-0"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-20 text-xs border border-gray-200 rounded px-1 py-0.5 font-mono"
        />
      </div>
    </label>
  );
}

function NumberInput({
  label, value, onChange, min = 0, max = 500, step = 1, unit = '',
}: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; unit?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-xs text-gray-600 w-32 shrink-0">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          min={min} max={max} step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 text-xs border border-gray-200 rounded px-1 py-0.5 text-right"
        />
        {unit && <span className="text-xs text-gray-400 w-6">{unit}</span>}
      </div>
    </label>
  );
}

function Toggle({
  label, value, onChange,
}: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5 cursor-pointer">
      <span className="text-xs text-gray-600">{label}</span>
      <button
        onClick={() => onChange(!value)}
        className={cn(
          'w-9 h-5 rounded-full transition-colors relative',
          value ? 'bg-blue-600' : 'bg-gray-300',
        )}
      >
        <span className={cn(
          'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all',
          value ? 'left-[18px]' : 'left-0.5',
        )} />
      </button>
    </label>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export interface WindowConfiguratorProps {
  onClose?: () => void;
  className?: string;
}

export function WindowConfigurator({ onClose, className }: WindowConfiguratorProps) {
  const { resolve } = useWindowSymbolConfig();

  // Selection state
  const [selectedFamily, setSelectedFamily] = useState<OpeningFamily>('single');
  const [perTypeMode, setPerTypeMode] = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState<string>('');

  // ── Draft state (committed only on Save) ─────────────────────────────────
  const [draft, setDraft] = useState<Map<string, Partial<WindowPlan2DConfig>>>(() => new Map());
  const [dirty, setDirty] = useState(false);

  const activeKey = perTypeMode && selectedTypeId
    ? selectedTypeId
    : openingKey(selectedFamily);

  const activeOpening: OpeningFamily = perTypeMode && selectedTypeId
    ? (WINDOW_TYPES.find((t) => t.id === selectedTypeId)?.opening ?? selectedFamily) as OpeningFamily
    : selectedFamily;

  // Merge committed registry + draft
  const cfg = useMemo<WindowPlan2DConfig>(() => {
    const committed = resolve(selectedTypeId || '__dummy__', activeOpening);
    return { ...committed, ...(draft.get(activeKey) ?? {}) };
  }, [draft, activeKey, activeOpening, selectedTypeId, resolve]);

  const update = useCallback((field: keyof WindowPlan2DConfig, value: unknown) => {
    setDraft((prev) => {
      const next = new Map(prev);
      next.set(activeKey, { ...(next.get(activeKey) ?? {}), [field]: value } as Partial<WindowPlan2DConfig>);
      return next;
    });
    setDirty(true);
  }, [activeKey]);

  const handleSave = () => {
    for (const [key, overrides] of draft.entries()) {
      setWindowPlan2DConfig(key, overrides);
    }
    saveToStorage();
    setDraft(new Map());
    setDirty(false);
  };

  const handleCancel = () => {
    setDraft(new Map());
    setDirty(false);
  };

  const handleReset = () => {
    resetWindowPlan2DConfig(activeKey);
    setDraft((prev) => { const n = new Map(prev); n.delete(activeKey); return n; });
    saveToStorage();
  };
  const previewType = WINDOW_TYPES.find((t) =>
    perTypeMode ? t.id === selectedTypeId : t.opening === selectedFamily,
  );
  const previewWallThick = previewType?.depth_mm ?? 200;
  const previewWidth     = previewType?.width_mm ?? 1000;

  const familyTypes = useMemo(() =>
    WINDOW_TYPES.filter((t) => t.opening === selectedFamily),
  [selectedFamily]);

  const svgString = renderWindowPlanSymbolSVG(cfg, activeOpening, previewWallThick, previewWidth, 300, 160);

  // ── Top-level tab: Properties vs Symbol editor ────────────────────────────
  const [mainTab, setMainTab] = useState<'properties' | 'symbol' | 'dxf'>('properties');

  const symTypeKey = perTypeMode && selectedTypeId
    ? selectedTypeId
    : `opening:${selectedFamily}`;

  // ── Auto-symbol from symbols2d/ folder ────────────────────────────────────
  // Watch for bglib store changes so the preview refreshes after backend loads
  const [, _bglibTick] = useState(0);
  useEffect(() => subscribeBglibStore(() => _bglibTick((n) => n + 1)), []);

  // Eagerly fetch the auto-symbol for the current selection so the preview shows on first render.
  // Per-type mode: fetch by typeId. Family mode: fetch by opening family name.
  useEffect(() => {
    if (perTypeMode && selectedTypeId) {
      fetchAutoSymbol('window', selectedTypeId).catch(() => {});
    } else {
      // family-level: opening_none, opening_single, opening_double, opening_tilt-turn
      fetchAutoSymbol('window', `opening_${selectedFamily}`).catch(() => {});
    }
  }, [perTypeMode, selectedTypeId, selectedFamily]);

  const autoSymForType = perTypeMode && selectedTypeId
    ? resolveAutoSymbol('window', selectedTypeId)
    : resolveAutoSymbol('window', `opening_${selectedFamily}`);

  const autoSymPreviewSvg = autoSymForType
    ? renderBglibSymbolSVG(
        autoSymForType, previewWidth, previewWallThick, 300, 120,
        8,
        { frame: cfg.frameColor, glass: cfg.glassColor, sill: cfg.sillLineColor },
      )
    : null;

  return (
    <div className={cn(
      'flex flex-col bg-white border border-gray-300 rounded-lg shadow-2xl overflow-hidden select-none',
      className,
    )} style={{ width: mainTab === 'properties' ? 780 : mainTab === 'dxf' ? 680 : 960, maxWidth: '96vw', maxHeight: '90vh' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-gray-800">Window Symbol Configurator</span>
          <span className="text-xs text-gray-400">2D floor-plan representation</span>
          {dirty && <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">Unsaved changes</span>}
        </div>
        {onClose && (
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-lg leading-none">×</button>
        )}
      </div>

      {/* ── Main tab bar ─────────────────────────────────────────────────── */}
      <div className="flex border-b border-gray-200 bg-gray-50">
        {([
          { id: 'properties', label: 'Properties' },
          { id: 'symbol',     label: '⊞ Simbol 2D' },
          { id: 'dxf',        label: '📐 DXF' },
        ] as const).map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setMainTab(id)}
            className={cn(
              'px-4 py-1.5 text-xs border-b-2 transition-colors whitespace-nowrap',
              mainTab === id
                ? 'border-blue-600 text-blue-700 font-medium bg-white'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            )}
          >{label}</button>
        ))}
      </div>

      {mainTab === 'symbol' && (
        <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
          <SymbolStudio elementType="window" className="flex-1" />
        </div>
      )}

      {/* ── DXF symbol panel ─────────────────────────────────────────── */}
      {mainTab === 'dxf' && (
        <div className="flex-1 overflow-auto p-4">
          <DxfSymbolPanel
            elementType="window"
            typeKey={symTypeKey}
            actualW={previewWidth}
            actualH={previewWallThick}
          />
        </div>
      )}

      {mainTab === 'properties' && (
      <>

      {/* ── Opening family tabs ─────────────────────────────────────────── */}
      <div className="flex border-b border-gray-200 bg-gray-50">
        {OPENING_FAMILIES.map((f) => (
          <button
            key={f.id}
            onClick={() => { setSelectedFamily(f.id); setPerTypeMode(false); }}
            className={cn(
              'px-4 py-1.5 text-xs border-b-2 transition-colors',
              selectedFamily === f.id && !perTypeMode
                ? 'border-blue-600 text-blue-700 font-medium bg-white'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            )}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 px-3">
          <span className="text-xs text-gray-500">Per type:</span>
          <button
            onClick={() => setPerTypeMode((p) => !p)}
            className={cn(
              'px-2 py-0.5 text-xs rounded border transition-colors',
              perTypeMode
                ? 'bg-blue-600 text-white border-blue-700'
                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50',
            )}
          >
            {perTypeMode ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left: type list ─────────────────────────────────────────── */}
        <div className="w-44 shrink-0 border-r border-gray-200 overflow-y-auto">
          {/* Family-level entry */}
          {!perTypeMode && (
            <div className="px-3 py-2 text-[11px] text-gray-400 font-semibold uppercase tracking-wide border-b border-gray-100">
              All {OPENING_FAMILIES.find((f) => f.id === selectedFamily)?.label}
            </div>
          )}

          {perTypeMode && familyTypes.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedTypeId(t.id)}
              className={cn(
                'w-full text-left px-3 py-2 text-xs transition-colors border-b border-gray-100',
                selectedTypeId === t.id
                  ? 'bg-blue-50 text-blue-800 font-medium'
                  : 'text-gray-700 hover:bg-gray-50',
              )}
            >
              <div className="font-medium truncate">{t.label}</div>
              <div className="text-gray-400 text-[10px] mt-0.5">{t.width_mm}×{t.height_mm} mm</div>
            </button>
          ))}

          {!perTypeMode && (
            <div className="px-3 py-2 text-[11px] text-gray-400">
              Settings apply to all {selectedFamily} windows
            </div>
          )}
        </div>

        {/* ── Center: preview ─────────────────────────────────────────── */}
        <div className="flex flex-col items-center w-72 shrink-0 border-r border-gray-200 bg-gray-50 p-4 gap-3 overflow-y-auto">

          {/* DXF auto-symbol preview (shown when symbols2d/{typeId}.dxf exists) */}
          {autoSymPreviewSvg && (
            <div className="w-full">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">DXF Symbol</span>
                <span className="text-[9px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">active</span>
              </div>
              <div
                className="rounded border border-green-200 shadow-sm w-full overflow-hidden"
                dangerouslySetInnerHTML={{ __html: autoSymPreviewSvg }}
              />
              <div className="text-[9px] text-gray-400 mt-1 font-mono">
                symbols2d/{perTypeMode && selectedTypeId ? selectedTypeId : `opening_${selectedFamily}`}.dxf
              </div>
              <div className="text-[9px] text-gray-500 mt-0.5">
                Layer colors: <span className="font-medium">frame</span> / <span className="font-medium">glass</span> / <span className="font-medium">sill</span> use settings below
              </div>
            </div>
          )}

          {/* Configured 3-line symbol preview */}
          <div className="w-full">
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">
              {autoSymPreviewSvg ? 'Configured Symbol' : 'Plan Symbol Preview'}
              {autoSymPreviewSvg && <span className="ml-1 text-[9px] text-gray-400">(fallback)</span>}
            </div>
            <div
              className="rounded border border-gray-200 shadow-sm"
              dangerouslySetInnerHTML={{ __html: svgString }}
            />
          </div>

          <div className="text-[10px] text-gray-400 text-center leading-4">
            {previewWallThick} mm wall · {previewWidth} mm opening
            {perTypeMode && selectedTypeId && (
              <div className="mt-0.5 text-blue-600">{previewType?.label}</div>
            )}
            {!perTypeMode && (
              <div className="mt-0.5 text-blue-600">Applies to all {selectedFamily} windows</div>
            )}
          </div>
          <button
            onClick={handleReset}
            className="text-[10px] text-red-500 hover:text-red-700 underline mt-1"
          >
            Reset to defaults
          </button>
        </div>

        {/* ── Right: settings form ─────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* Frame squares */}
          <section>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-1 mb-2">
              Frame Squares (cut section)
            </div>
            <Toggle
              label="Show frame squares"
              value={cfg.showFrameSquares}
              onChange={(v) => update('showFrameSquares', v)}
            />
            <NumberInput
              label="Square side"
              value={cfg.squareSide_mm}
              onChange={(v) => update('squareSide_mm', v)}
              min={20} max={200} step={5} unit="mm"
            />
            <ColorInput
              label="Frame color"
              value={cfg.frameColor}
              onChange={(v) => update('frameColor', v)}
            />
            <NumberInput
              label="Line weight (cut)"
              value={cfg.cutLineWeight}
              onChange={(v) => update('cutLineWeight', v)}
              min={0.5} max={5} step={0.5} unit="px"
            />
          </section>

          {/* Glass panel */}
          <section>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-1 mb-2">
              Glass Panel (seen zone)
            </div>
            <Toggle
              label="Show glass panel"
              value={cfg.showGlassPanel}
              onChange={(v) => update('showGlassPanel', v)}
            />
            <NumberInput
              label="Panel width"
              value={cfg.glassPanelWidth_mm}
              onChange={(v) => update('glassPanelWidth_mm', v)}
              min={10} max={100} step={5} unit="mm"
            />
            <ColorInput
              label="Glass color"
              value={cfg.glassColor}
              onChange={(v) => update('glassColor', v)}
            />
            <NumberInput
              label="Line weight (seen)"
              value={cfg.seenLineWeight}
              onChange={(v) => update('seenLineWeight', v)}
              min={0.25} max={3} step={0.25} unit="px"
            />
          </section>

          {/* Sill / parapet zone */}
          <section>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-1 mb-2">
              Sill / Parapet Zone (seen below sill)
            </div>
            <Toggle
              label="Show sill zone fill"
              value={cfg.showSillZone}
              onChange={(v) => update('showSillZone', v)}
            />
            <ColorInput
              label="Fill color"
              value={cfg.sillFillColor}
              onChange={(v) => update('sillFillColor', v)}
            />
            <NumberInput
              label="Fill opacity"
              value={Math.round(cfg.sillFillOpacity * 100)}
              onChange={(v) => update('sillFillOpacity', v / 100)}
              min={0} max={100} step={5} unit="%"
            />
            <ColorInput
              label="Outline color"
              value={cfg.sillLineColor}
              onChange={(v) => update('sillLineColor', v)}
            />
            <NumberInput
              label="Outline dash (0=solid)"
              value={Math.round(cfg.sillLineDash * 1000)}
              onChange={(v) => update('sillLineDash', v / 1000)}
              min={0} max={100} step={5} unit="mm"
            />
          </section>

          {/* Frame line positions (parallel to wall face) */}
          <section>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-1 mb-2">
              Frame Lines — distances from wall centre
            </div>
            <NumberInput
              label="Outer offset (line 1)"
              value={cfg.outerLineOffset_mm}
              onChange={(v) => update('outerLineOffset_mm', v)}
              min={0} max={500} step={5} unit="mm"
            />
            <NumberInput
              label="Inner offset (line 2)"
              value={cfg.innerLineOffset_mm}
              onChange={(v) => update('innerLineOffset_mm', v)}
              min={0} max={500} step={5} unit="mm"
            />
            <NumberInput
              label="Sill depth (line 3)"
              value={cfg.sillProjection_mm}
              onChange={(v) => update('sillProjection_mm', v)}
              min={0} max={1000} step={10} unit="mm"
            />
          </section>

        </div>
      </div>

      {/* ── Footer: Save / Cancel ──────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-t border-gray-200">
        <span className="text-[10px] text-gray-400">
          Settings saved to browser storage · applied globally to all floor-plan viewers.
        </span>
        <div className="flex gap-2">
          <button onClick={handleCancel} disabled={!dirty}
            className={cn('px-3 py-1 text-xs rounded border transition-colors',
              dirty ? 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100' : 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed')}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={!dirty}
            className={cn('px-4 py-1 text-xs rounded font-medium transition-colors',
              dirty ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-200 text-gray-400 cursor-not-allowed')}>
            Save
          </button>
        </div>
      </div>

      </>
      )}{/* end mainTab === 'properties' */}
    </div>
  );
}
