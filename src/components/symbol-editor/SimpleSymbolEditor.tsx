import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { SimpleSymbolEdits } from '@/lib/symbolTemplates';
import {
  renderSymbolSVGString,
  type SvgSymbolDef,
  type SymRenderParams,
} from '@/lib/svgSymbolStore';

// ─── Primitive inputs ─────────────────────────────────────────────────────────

function ColorInput({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-xs text-gray-600 w-36 shrink-0">{label}</span>
      <div className="flex items-center gap-1">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
          className="w-7 h-6 rounded border border-gray-300 cursor-pointer p-0" />
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)}
          className="w-20 text-xs border border-gray-200 rounded px-1 py-0.5 font-mono" />
      </div>
    </label>
  );
}

function NumberInput({ label, value, onChange, min = 0, max = 500, step = 1, unit = '' }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; unit?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-xs text-gray-600 w-36 shrink-0">{label}</span>
      <div className="flex items-center gap-1">
        <input type="number" value={value} min={min} max={max} step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 text-xs border border-gray-200 rounded px-1 py-0.5 text-right" />
        {unit && <span className="text-xs text-gray-400 w-6">{unit}</span>}
      </div>
    </label>
  );
}

function Toggle({ label, value, onChange }: {
  label: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5 cursor-pointer">
      <span className="text-xs text-gray-600">{label}</span>
      <button type="button" onClick={() => onChange(!value)}
        className={cn('w-9 h-5 rounded-full transition-colors relative',
          value ? 'bg-blue-600' : 'bg-gray-300')}>
        <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all',
          value ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </label>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export interface SimpleSymbolEditorProps {
  elementType: 'window' | 'door';
  edits: SimpleSymbolEdits;
  onChange: (edits: SimpleSymbolEdits) => void;
  compiledDef: SvgSymbolDef;
  params: SymRenderParams;
  wallLabel: string;
}

export function SimpleSymbolEditor({
  elementType,
  edits,
  onChange,
  compiledDef,
  params,
  wallLabel,
}: SimpleSymbolEditorProps) {
  const patch = (partial: Partial<SimpleSymbolEdits>) => onChange({ ...edits, ...partial });

  const previewSvg = useMemo(
    () => renderSymbolSVGString(compiledDef, params, 320, 180),
    [compiledDef, params],
  );

  const isWindow = elementType === 'window';

  return (
    <div className="flex flex-1 overflow-hidden min-h-0">
      {/* Preview */}
      <div className="w-80 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center justify-center p-4 gap-2">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Live preview</div>
        <div className="rounded border border-gray-200 shadow-sm"
          dangerouslySetInnerHTML={{ __html: previewSvg }} />
        <div className="text-[10px] text-gray-400 text-center">{wallLabel}</div>
        <div className="text-[10px] text-gray-400 text-center leading-4 mt-1 px-2">
          Variables: W = opening width, T = wall thickness, outer_off / inner_off = frame offsets
        </div>
      </div>

      {/* Controls */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <section>
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-1 mb-2">
            Lines &amp; colors
          </div>
          <ColorInput label="Frame / cut color" value={edits.frameColor}
            onChange={(v) => patch({ frameColor: v })} />
          {isWindow && (
            <ColorInput label="Glass / seen color" value={edits.glassColor}
              onChange={(v) => patch({ glassColor: v })} />
          )}
          <ColorInput label="Arc color" value={edits.arcColor}
            onChange={(v) => patch({ arcColor: v })} />
          <NumberInput label="Frame line weight" value={edits.frameLineWeight}
            onChange={(v) => patch({ frameLineWeight: v })} min={0.5} max={6} step={0.5} unit="px" />
          <NumberInput label="Seen line weight" value={edits.seenLineWeight}
            onChange={(v) => patch({ seenLineWeight: v })} min={0.25} max={4} step={0.25} unit="px" />
          {!isWindow && (
            <>
              <NumberInput label="Panel line weight" value={edits.panelLineWeight}
                onChange={(v) => patch({ panelLineWeight: v })} min={0.5} max={6} step={0.5} unit="px" />
              <NumberInput label="Arc line weight" value={edits.arcLineWeight}
                onChange={(v) => patch({ arcLineWeight: v })} min={0.25} max={4} step={0.25} unit="px" />
            </>
          )}
        </section>

        {isWindow && (
          <section>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-1 mb-2">
              Frame geometry
            </div>
            <NumberInput label="Frame square side" value={edits.squareSide_mm}
              onChange={(v) => patch({ squareSide_mm: v })} min={20} max={150} unit="mm" />
            <NumberInput label="Outer line offset" value={edits.outerLineOffset_mm}
              onChange={(v) => patch({ outerLineOffset_mm: v })} min={50} max={300} unit="mm" />
            <NumberInput label="Inner line offset" value={edits.innerLineOffset_mm}
              onChange={(v) => patch({ innerLineOffset_mm: v })} min={50} max={300} unit="mm" />
          </section>
        )}

        <section>
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-1 mb-2">
            Visibility
          </div>
          {isWindow && (
            <>
              <Toggle label="Show frame squares" value={edits.showFrameSquares}
                onChange={(v) => patch({ showFrameSquares: v })} />
              <Toggle label="Show glass panel" value={edits.showGlassPanel}
                onChange={(v) => patch({ showGlassPanel: v })} />
              <Toggle label="Show sill / parapet" value={edits.showSillZone}
                onChange={(v) => patch({ showSillZone: v })} />
              {edits.showSillZone && (
                <ColorInput label="Sill fill color" value={edits.sillFillColor}
                  onChange={(v) => patch({ sillFillColor: v })} />
              )}
            </>
          )}
          {!isWindow && (
            <>
              <Toggle label="Show door panel" value={edits.showDoorPanel}
                onChange={(v) => patch({ showDoorPanel: v })} />
              <Toggle label="Show swing arc" value={edits.showSwingArc}
                onChange={(v) => patch({ showSwingArc: v })} />
            </>
          )}
          <Toggle label="Show white mask" value={edits.showWhiteMask}
            onChange={(v) => patch({ showWhiteMask: v })} />
          <Toggle label="Show wall breaks" value={edits.showWallBreaks}
            onChange={(v) => patch({ showWallBreaks: v })} />
          {edits.showWallBreaks && (
            <>
              <ColorInput label="Break line color" value={edits.breakLineColor}
                onChange={(v) => patch({ breakLineColor: v })} />
              <NumberInput label="Break line weight" value={edits.breakLineWeight}
                onChange={(v) => patch({ breakLineWeight: v })} min={0.25} max={4} step={0.25} unit="px" />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
