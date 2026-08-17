/**
 * SymbolStudio — template-first 2D symbol editor for windows and doors.
 *
 * Simple mode: pick a template, tweak intuitive controls, save globally per type.
 * Advanced mode: full SymbolCanvas graph editor (for power users).
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { WINDOW_TYPES, DOOR_TYPES } from '@/lib/elementLibrary';
import { openingKey } from '@/lib/windowSymbolLibrary';
import { swingKey } from '@/lib/doorSymbolLibrary';
import {
  WINDOW_PLAN_TEMPLATES,
  DOOR_PLAN_TEMPLATES,
  pickWindowTemplate,
  pickDoorTemplate,
  compileTemplate,
  defaultEditsFor,
  type SimpleSymbolEdits,
  type SymbolTemplate,
} from '@/lib/symbolTemplates';
import {
  resolveSymbolDef,
  setSymbolDef,
  deleteSymbolDef,
  subscribeSymbolLibrary,
  saveSymbolLibraryToStorage,
  buildWindowSymRenderParams,
  buildDoorSymRenderParams,
  type SymRenderParams,
} from '@/lib/svgSymbolStore';
import { TemplatePicker } from './TemplatePicker';
import { SimpleSymbolEditor } from './SimpleSymbolEditor';
import { SymbolCanvas } from './SymbolCanvas';

export interface SymbolStudioProps {
  elementType: 'window' | 'door';
  className?: string;
}

type StudioMode = 'simple' | 'advanced';

export function SymbolStudio({ elementType, className }: SymbolStudioProps) {
  const isWindow = elementType === 'window';
  const types = isWindow ? WINDOW_TYPES : DOOR_TYPES;

  const [perTypeMode, setPerTypeMode] = useState(true);
  const [selectedFamily, setSelectedFamily] = useState(isWindow ? 'single' : 'left');
  const [selectedTypeId, setSelectedTypeId] = useState(types[0]?.id ?? '');
  const [mode, setMode] = useState<StudioMode>('simple');
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    isWindow ? 'fixed' : 'swing-left',
  );
  const [edits, setEdits] = useState<SimpleSymbolEdits>(() => defaultEditsFor(elementType));
  const [dirty, setDirty] = useState(false);

  const [, tick] = useState(0);
  useEffect(() => subscribeSymbolLibrary(() => tick((n) => n + 1)), []);

  const activeType = types.find((t) => t.id === selectedTypeId) ?? types[0];
  const family = isWindow
    ? (activeType as { opening: string }).opening
    : (activeType as { swing: string }).swing;

  const typeKey = perTypeMode && selectedTypeId
    ? selectedTypeId
    : isWindow
      ? openingKey(selectedFamily)
      : swingKey(selectedFamily);

  const existingDef = resolveSymbolDef(elementType, typeKey, 'floorplan');

  const templates = isWindow ? WINDOW_PLAN_TEMPLATES : DOOR_PLAN_TEMPLATES;
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId)
    ?? (isWindow ? pickWindowTemplate(family) : pickDoorTemplate(family));

  const params: SymRenderParams = useMemo(() => {
    const W = activeType?.width_mm ?? 1000;
    const T = activeType?.depth_mm ?? 200;
    if (isWindow) {
      return buildWindowSymRenderParams({
        outerLineOffset_mm: edits.outerLineOffset_mm,
        innerLineOffset_mm: edits.innerLineOffset_mm,
        sillProjection_mm: 200,
        squareSide_mm: edits.squareSide_mm,
        glassPanelWidth_mm: 30,
      }, W, T);
    }
    return buildDoorSymRenderParams({}, W, T);
  }, [activeType, edits, isWindow]);

  const compiledDef = useMemo(
    () => compileTemplate(
      selectedTemplate.build,
      typeKey,
      `${selectedTemplate.name} — ${activeType?.label ?? typeKey}`,
      edits,
      elementType,
    ),
    [selectedTemplate, typeKey, activeType, edits, elementType],
  );

  // When type changes, pick a sensible default template for its family
  useEffect(() => {
    const tpl = isWindow ? pickWindowTemplate(family) : pickDoorTemplate(family);
    setSelectedTemplateId(tpl.id);
    setEdits(defaultEditsFor(elementType));
    setDirty(false);
  }, [selectedTypeId, selectedFamily, perTypeMode, elementType, family, isWindow]);

  const handleTemplateSelect = useCallback((t: SymbolTemplate) => {
    setSelectedTemplateId(t.id);
    setDirty(true);
  }, []);

  const handleSave = () => {
    setSymbolDef(compiledDef);
    saveSymbolLibraryToStorage();
    setDirty(false);
  };

  const handleReset = () => {
    deleteSymbolDef(elementType, typeKey, 'floorplan');
    saveSymbolLibraryToStorage();
    const tpl = isWindow ? pickWindowTemplate(family) : pickDoorTemplate(family);
    setSelectedTemplateId(tpl.id);
    setEdits(defaultEditsFor(elementType));
    setDirty(false);
  };

  const familyTypes = types.filter((t) =>
    isWindow
      ? (t as { opening: string }).opening === selectedFamily
      : (t as { swing: string }).swing === selectedFamily,
  );

  const families = isWindow
    ? [
        { id: 'none', label: 'Fixed' },
        { id: 'single', label: 'Single' },
        { id: 'double', label: 'Double' },
        { id: 'tilt-turn', label: 'Tilt-turn' },
      ]
    : [
        { id: 'left', label: 'Swing L' },
        { id: 'right', label: 'Swing R' },
        { id: 'double', label: 'Double' },
        { id: 'sliding', label: 'Sliding' },
        { id: 'folding', label: 'Folding' },
      ];

  const wallLabel = `${activeType?.depth_mm ?? 200} mm wall · ${activeType?.width_mm ?? 1000} mm opening`;

  return (
    <div className={cn('flex flex-col min-h-0', className)}>
      {/* Family tabs + per-type toggle */}
      <div className="flex border-b border-gray-200 bg-gray-50 shrink-0">
        {families.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => { setSelectedFamily(f.id); if (!perTypeMode) setDirty(true); }}
            className={cn('px-3 py-1.5 text-xs border-b-2 transition-colors',
              selectedFamily === f.id && !perTypeMode
                ? 'border-blue-600 text-blue-700 font-medium bg-white'
                : 'border-transparent text-gray-500 hover:text-gray-700')}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3 px-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">Per type:</span>
            <button type="button" onClick={() => setPerTypeMode((p) => !p)}
              className={cn('px-2 py-0.5 text-xs rounded border transition-colors',
                perTypeMode ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-gray-600 border-gray-300')}>
              {perTypeMode ? 'On' : 'Off'}
            </button>
          </div>
          <div className="flex items-center gap-1 border border-gray-200 rounded overflow-hidden">
            <button type="button" onClick={() => setMode('simple')}
              className={cn('px-2.5 py-0.5 text-xs transition-colors',
                mode === 'simple' ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50')}>
              Simple
            </button>
            <button type="button" onClick={() => setMode('advanced')}
              className={cn('px-2.5 py-0.5 text-xs transition-colors',
                mode === 'advanced' ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50')}>
              Advanced
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Type list */}
        <div className="w-44 shrink-0 border-r border-gray-200 overflow-y-auto">
          {perTypeMode ? (
            familyTypes.map((t) => {
              const hasCustom = !!resolveSymbolDef(elementType, t.id, 'floorplan');
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedTypeId(t.id)}
                  className={cn('w-full text-left px-3 py-2 text-xs transition-colors border-b border-gray-100',
                    selectedTypeId === t.id ? 'bg-blue-50 text-blue-800 font-medium' : 'text-gray-700 hover:bg-gray-50')}
                >
                  <div className="flex items-center gap-1">
                    <span className={cn('text-[9px]', hasCustom ? 'text-green-600' : 'text-gray-300')}>
                      {hasCustom ? '✓' : '○'}
                    </span>
                    <span className="font-medium truncate">{t.label}</span>
                  </div>
                  <div className="text-gray-400 text-[10px] mt-0.5 pl-3">
                    {t.width_mm}×{t.height_mm} mm
                  </div>
                </button>
              );
            })
          ) : (
            <div className="px-3 py-3 text-[11px] text-gray-500 leading-5">
              Applies to all <strong>{families.find((f) => f.id === selectedFamily)?.label}</strong> {elementType}s
              <div className="mt-2 text-[10px] text-gray-400 font-mono">{typeKey}</div>
              {existingDef && (
                <div className="mt-2 text-[10px] text-green-600">✓ Custom symbol saved</div>
              )}
            </div>
          )}
        </div>

        {/* Main editor area */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {mode === 'simple' ? (
            <>
              <div className="px-4 py-3 border-b border-gray-100 shrink-0">
                <div className="text-xs font-semibold text-gray-600 mb-2">Choose a template</div>
                <TemplatePicker
                  templates={templates}
                  selectedId={selectedTemplateId}
                  onSelect={handleTemplateSelect}
                  elementType={elementType}
                  typeKey={typeKey}
                  params={params}
                />
              </div>
              <SimpleSymbolEditor
                elementType={elementType}
                edits={edits}
                onChange={(e) => { setEdits(e); setDirty(true); }}
                compiledDef={compiledDef}
                params={params}
                wallLabel={wallLabel}
              />
            </>
          ) : (
            <div className="flex-1 overflow-auto p-4">
              <SymbolCanvas
                elementType={elementType}
                initialTypeKey={typeKey}
                viewType="floorplan"
                params={params}
              />
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-t border-gray-200 shrink-0">
        <span className="text-[10px] text-gray-400">
          Key: <span className="font-mono">{typeKey}</span>
          {existingDef ? ' · custom symbol active' : ' · using template preview'}
          {' · '}saved to project on Save Project
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={handleReset}
            className="px-3 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-100">
            Reset
          </button>
          <button type="button" onClick={handleSave} disabled={!dirty && !!existingDef}
            className={cn('px-4 py-1 text-xs rounded font-medium transition-colors',
              dirty || !existingDef
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed')}>
            {dirty ? 'Save symbol' : existingDef ? 'Saved' : 'Save symbol'}
          </button>
        </div>
      </div>
    </div>
  );
}
