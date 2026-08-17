/**
 * DoorConfigurator.tsx — Parametric door symbol configurator with Save / Cancel.
 *
 * Uses a local draft state: changes are accumulated and only committed to the
 * registry on Save. Cancel discards all draft changes.
 */

import { useState, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { DOOR_TYPES } from '@/lib/elementLibrary';
import { SymbolStudio } from '@/components/symbol-editor/SymbolStudio';
import {
  DEFAULT_DOOR_PLAN_CONFIG,
  swingKey,
  resolveDoorPlan2DConfig,
  setDoorPlan2DConfig,
  resetDoorPlan2DConfig,
  renderDoorPlanSymbolSVG,
  exportDoorRegistry,
  importDoorRegistry,
  type DoorPlan2DConfig,
} from '@/lib/doorSymbolLibrary';

const STORAGE_KEY = 'bg_door_symbol_registry_v1';

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(exportDoorRegistry())); } catch { /* ignore */ }
}

type SwingFamily = 'left' | 'right' | 'double' | 'sliding' | 'folding';

const SWING_FAMILIES: { id: SwingFamily; label: string }[] = [
  { id: 'left',    label: 'Single Swing (L)' },
  { id: 'right',   label: 'Single Swing (R)' },
  { id: 'double',  label: 'Double Swing' },
  { id: 'sliding', label: 'Sliding' },
  { id: 'folding', label: 'Folding' },
];

// ─── Primitive inputs ─────────────────────────────────────────────────────────

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-xs text-gray-600 w-32 shrink-0">{label}</span>
      <div className="flex items-center gap-1">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
          className="w-7 h-6 rounded border border-gray-300 cursor-pointer p-0" />
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)}
          className="w-20 text-xs border border-gray-200 rounded px-1 py-0.5 font-mono" />
      </div>
    </label>
  );
}

function NumberInput({ label, value, onChange, min = 0, max = 10, step = 0.25, unit = '' }: {
  label: string; value: number; onChange(v: number): void; min?: number; max?: number; step?: number; unit?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-xs text-gray-600 w-32 shrink-0">{label}</span>
      <div className="flex items-center gap-1">
        <input type="number" value={value} min={min} max={max} step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 text-xs border border-gray-200 rounded px-1 py-0.5 text-right" />
        {unit && <span className="text-xs text-gray-400 w-6">{unit}</span>}
      </div>
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5 cursor-pointer">
      <span className="text-xs text-gray-600">{label}</span>
      <button onClick={() => onChange(!value)}
        className={cn('w-9 h-5 rounded-full transition-colors relative', value ? 'bg-amber-500' : 'bg-gray-300')}>
        <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all', value ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </label>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export interface DoorConfiguratorProps {
  onClose?: () => void;
  className?: string;
}

export function DoorConfigurator({ onClose, className }: DoorConfiguratorProps) {
  const [selectedFamily, setSelectedFamily] = useState<SwingFamily>('left');
  const [perTypeMode, setPerTypeMode] = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState('');

  // ── Draft state ─────────────────────────────────────────────────────────────
  // A local map of key → partial overrides, committed only on Save.
  const [draft, setDraft] = useState<Map<string, Partial<DoorPlan2DConfig>>>(() => new Map());
  const [dirty, setDirty] = useState(false);

  const activeKey = perTypeMode && selectedTypeId
    ? selectedTypeId
    : swingKey(selectedFamily);

  const activeSwing: SwingFamily = perTypeMode && selectedTypeId
    ? (DOOR_TYPES.find((t) => t.id === selectedTypeId)?.swing ?? selectedFamily) as SwingFamily
    : selectedFamily;

  // Resolve: merge committed registry + draft
  const cfg = useMemo<DoorPlan2DConfig>(() => {
    const committed = resolveDoorPlan2DConfig(selectedTypeId || '__dummy__', activeSwing);
    const draftOverride = draft.get(activeKey) ?? {};
    return { ...committed, ...draftOverride };
  }, [draft, activeKey, activeSwing, selectedTypeId]);

  const updateDraft = useCallback((field: keyof DoorPlan2DConfig, value: unknown) => {
    setDraft((prev) => {
      const next = new Map(prev);
      next.set(activeKey, { ...(next.get(activeKey) ?? {}), [field]: value } as Partial<DoorPlan2DConfig>);
      return next;
    });
    setDirty(true);
  }, [activeKey]);

  const handleSave = () => {
    for (const [key, overrides] of draft.entries()) {
      setDoorPlan2DConfig(key, overrides);
    }
    save();
    setDraft(new Map());
    setDirty(false);
  };

  const handleCancel = () => {
    setDraft(new Map());
    setDirty(false);
  };

  const handleReset = () => {
    resetDoorPlan2DConfig(activeKey);
    // Also clear draft for this key
    setDraft((prev) => {
      const next = new Map(prev);
      next.delete(activeKey);
      return next;
    });
    save();
  };

  const familyTypes = useMemo(() =>
    DOOR_TYPES.filter((t) => t.swing === selectedFamily),
  [selectedFamily]);

  const previewType = DOOR_TYPES.find((t) =>
    perTypeMode ? t.id === selectedTypeId : t.swing === selectedFamily,
  );
  const previewWallThick = previewType?.depth_mm ?? 200;
  const previewWidth     = previewType?.width_mm ?? 900;

  const svgString = renderDoorPlanSymbolSVG(cfg, activeSwing, previewWallThick, previewWidth, 300, 140);

  const [mainTab, setMainTab] = useState<'properties' | 'symbol'>('properties');

  return (
    <div className={cn('flex flex-col bg-white border border-gray-300 rounded-lg shadow-2xl overflow-hidden select-none', className)}
      style={{ width: mainTab === 'properties' ? 780 : 960, maxWidth: '96vw', maxHeight: '90vh' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-amber-50 border-b border-amber-200">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-gray-800">Door Symbol Configurator</span>
          <span className="text-xs text-gray-400">2D floor-plan representation</span>
          {dirty && <span className="text-[10px] bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded font-medium">Unsaved changes</span>}
        </div>
        {onClose && (
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-lg leading-none">×</button>
        )}
      </div>

      <div className="flex border-b border-gray-200 bg-gray-50">
        {([
          { id: 'properties', label: 'Properties' },
          { id: 'symbol',     label: '⊞ Simbol 2D' },
        ] as const).map(({ id, label }) => (
          <button key={id} type="button" onClick={() => setMainTab(id)}
            className={cn('px-4 py-1.5 text-xs border-b-2 transition-colors whitespace-nowrap',
              mainTab === id
                ? 'border-amber-500 text-amber-700 font-medium bg-white'
                : 'border-transparent text-gray-500 hover:text-gray-700')}>
            {label}
          </button>
        ))}
      </div>

      {mainTab === 'symbol' && (
        <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
          <SymbolStudio elementType="door" className="flex-1" />
        </div>
      )}

      {mainTab === 'properties' && (<>

      {/* Swing family tabs */}
      <div className="flex border-b border-gray-200 bg-gray-50">
        {SWING_FAMILIES.map((f) => (
          <button key={f.id}
            onClick={() => { setSelectedFamily(f.id); setPerTypeMode(false); }}
            className={cn('px-3 py-1.5 text-xs border-b-2 transition-colors',
              selectedFamily === f.id && !perTypeMode
                ? 'border-amber-500 text-amber-700 font-medium bg-white'
                : 'border-transparent text-gray-500 hover:text-gray-700')}>
            {f.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 px-3">
          <span className="text-xs text-gray-500">Per type:</span>
          <button onClick={() => setPerTypeMode((p) => !p)}
            className={cn('px-2 py-0.5 text-xs rounded border transition-colors',
              perTypeMode ? 'bg-amber-500 text-white border-amber-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50')}>
            {perTypeMode ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left: type list */}
        <div className="w-44 shrink-0 border-r border-gray-200 overflow-y-auto">
          {!perTypeMode && (
            <div className="px-3 py-2 text-[10px] text-gray-400 font-semibold uppercase tracking-wide">
              All {SWING_FAMILIES.find((f) => f.id === selectedFamily)?.label}
            </div>
          )}
          {perTypeMode && familyTypes.map((t) => (
            <button key={t.id} onClick={() => setSelectedTypeId(t.id)}
              className={cn('w-full text-left px-3 py-2 text-xs transition-colors border-b border-gray-100',
                selectedTypeId === t.id ? 'bg-amber-50 text-amber-800 font-medium' : 'text-gray-700 hover:bg-gray-50')}>
              <div className="font-medium truncate">{t.label}</div>
              <div className="text-gray-400 text-[10px] mt-0.5">{t.width_mm}×{t.height_mm} mm</div>
            </button>
          ))}
          {!perTypeMode && (
            <div className="px-3 py-2 text-[11px] text-gray-400">
              Applies to all {selectedFamily} doors
            </div>
          )}
        </div>

        {/* Center: preview */}
        <div className="flex flex-col items-center justify-center w-72 shrink-0 border-r border-gray-200 bg-gray-50 p-4 gap-3">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Plan Symbol Preview</div>
          <div className="rounded border border-gray-200 shadow-sm"
            dangerouslySetInnerHTML={{ __html: svgString }} />
          <div className="text-[10px] text-gray-400 text-center leading-4">
            {previewWallThick} mm wall · {previewWidth} mm opening
            {perTypeMode && selectedTypeId && <div className="mt-0.5 text-amber-600">{previewType?.label}</div>}
          </div>
          <button onClick={handleReset} className="text-[10px] text-red-500 hover:text-red-700 underline mt-1">
            Reset to defaults
          </button>
        </div>

        {/* Right: settings */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <section>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-1 mb-2">
              Door Panel (cut section)
            </div>
            <Toggle label="Show door panel" value={cfg.showDoorPanel} onChange={(v) => updateDraft('showDoorPanel', v)} />
            <ColorInput label="Panel color" value={cfg.panelColor} onChange={(v) => updateDraft('panelColor', v)} />
            <NumberInput label="Line weight" value={cfg.panelLineWeight} onChange={(v) => updateDraft('panelLineWeight', v)} min={0.5} max={5} step={0.5} unit="px" />
          </section>

          <section>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-1 mb-2">
              Swing Arc (seen zone)
            </div>
            <Toggle label="Show swing arc" value={cfg.showSwingArc} onChange={(v) => updateDraft('showSwingArc', v)} />
            <ColorInput label="Arc color" value={cfg.arcColor} onChange={(v) => updateDraft('arcColor', v)} />
            <NumberInput label="Arc line weight" value={cfg.arcLineWeight} onChange={(v) => updateDraft('arcLineWeight', v)} min={0.25} max={3} step={0.25} unit="px" />
          </section>

          <section>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-1 mb-2">
              Opening Mask
            </div>
            <Toggle label="Show white mask" value={cfg.showWhiteMask} onChange={(v) => updateDraft('showWhiteMask', v)} />
            <Toggle label="Show wall breaks" value={cfg.showWallBreaks} onChange={(v) => updateDraft('showWallBreaks', v)} />
            <ColorInput label="Break line color" value={cfg.breakLineColor} onChange={(v) => updateDraft('breakLineColor', v)} />
            <NumberInput label="Break line weight" value={cfg.breakLineWeight} onChange={(v) => updateDraft('breakLineWeight', v)} min={0.25} max={3} step={0.25} unit="px" />
          </section>
        </div>
      </div>

      {/* Footer: Save / Cancel */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-t border-gray-200">
        <span className="text-[10px] text-gray-400">
          Settings saved to browser storage · applied globally to all floor-plan viewers
        </span>
        <div className="flex gap-2">
          <button onClick={handleCancel} disabled={!dirty}
            className={cn('px-3 py-1 text-xs rounded border transition-colors',
              dirty ? 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100' : 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed')}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={!dirty}
            className={cn('px-4 py-1 text-xs rounded font-medium transition-colors',
              dirty ? 'bg-amber-600 text-white hover:bg-amber-700' : 'bg-gray-200 text-gray-400 cursor-not-allowed')}>
            Save
          </button>
        </div>
      </div>

      </>)}
    </div>
  );
}
