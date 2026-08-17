/**
 * DxfSymbolPanel.tsx
 *
 * UI for managing DXF-based parametric symbols (.bglib.json) for a specific
 * element type + typeKey combination.
 *
 * Flow:
 *   1. Upload a .dxf file → backend parses it → .bglib.json saved in library
 *   2. Select from available symbols in the library
 *   3. Assign the selected symbol to the current typeKey
 *   4. Live SVG preview at the current actualW / actualH dimensions
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import {
  fetchBglibMeta,
  fetchBglibSymbol,
  assignBglibSymbol,
  unassignBglibSymbol,
  getAssignedSymbolName,
  subscribeBglibStore,
  invalidateBglibMeta,
  invalidateAutoSymbolCache,
  initAutoSymbolList,
  type BglibMeta,
} from '@/lib/bglibSymbolStore';
import type { BglibSymbol } from '@/lib/dxfSymbolRenderer';
import { renderBglibSymbolSVG } from '@/lib/dxfSymbolRenderer';

const API_BASE = 'http://localhost:8000';

interface DxfSymbolPanelProps {
  /** 'window' | 'door' | … */
  elementType: string;
  /** The typeKey to assign a symbol to (e.g. 'W1000-DOUBLE' or 'opening:double') */
  typeKey: string;
  /** Opening width in mm for preview */
  actualW?: number;
  /** Wall thickness / height in mm for preview */
  actualH?: number;
  className?: string;
}

export function DxfSymbolPanel({
  elementType,
  typeKey,
  actualW = 1000,
  actualH = 200,
  className,
}: DxfSymbolPanelProps) {
  const [metaList, setMetaList] = useState<BglibMeta[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [previewSymbol, setPreviewSymbol] = useState<BglibSymbol | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Currently assigned symbol name for this typeKey
  const assignedName = getAssignedSymbolName(elementType, typeKey);

  // Reload metadata when store changes
  const reload = useCallback(async () => {
    setLoadingMeta(true);
    const list = await fetchBglibMeta(elementType);
    setMetaList(list);
    setLoadingMeta(false);
  }, [elementType]);

  useEffect(() => {
    reload();
    const unsub = subscribeBglibStore(reload);
    return unsub;
  }, [reload]);

  // Load preview when selection changes
  useEffect(() => {
    if (!selectedName) { setPreviewSymbol(null); return; }
    const entry = metaList.find((m) => m.name === selectedName);
    if (!entry) return;
    setLoadingPreview(true);
    fetchBglibSymbol(entry.file, elementType).then((sym) => {
      setPreviewSymbol(sym);
      setLoadingPreview(false);
    });
  }, [selectedName, metaList, elementType]);

  // Auto-select the currently assigned symbol on open
  useEffect(() => {
    if (assignedName && !selectedName) setSelectedName(assignedName);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignedName]);

  // ── Upload handler ─────────────────────────────────────────────────────────
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.dxf')) {
      setUploadError('Only .dxf files are supported');
      return;
    }
    setUploading(true);
    setUploadError(null);
    setUploadSuccess(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch(
        `${API_BASE}/api/library/bglib/parse-dxf?element_type=${encodeURIComponent(elementType)}`,
        { method: 'POST', body: fd },
      );
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail ?? resp.statusText);
      }
      const data = await resp.json() as { saved: string; symbol: BglibSymbol };
      setUploadSuccess(`Saved: ${data.saved}`);
      invalidateBglibMeta(elementType);   // triggers reload + re-render
      setSelectedName(data.symbol.name);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── Assign / unassign ──────────────────────────────────────────────────────
  const handleAssign = () => {
    if (!selectedName) return;
    assignBglibSymbol(elementType, typeKey, selectedName);
  };

  const handleUnassign = () => {
    unassignBglibSymbol(elementType, typeKey);
    setSelectedName(null);
    setPreviewSymbol(null);
  };

  // ── Refresh DXF cache (re-parse modified DXF files) ───────────────────────
  const handleRefreshDxf = async () => {
    invalidateBglibMeta(elementType);
    invalidateAutoSymbolCache(elementType);
    await initAutoSymbolList(elementType);
    await reload();
  };

  // ── SVG preview string ─────────────────────────────────────────────────────
  const previewSvg = previewSymbol
    ? renderBglibSymbolSVG(previewSymbol, actualW, actualH, 360, 180)
    : null;

  const isAssigned = !!assignedName;
  const isCurrent  = assignedName === selectedName;

  return (
    <div className={cn('flex flex-col gap-3 text-xs', className)}>

      {/* ── Header info ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-gray-700">DXF Symbol Library</span>
        <span className="text-gray-400">—</span>
        <span className="font-mono text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">{typeKey}</span>
        {isAssigned && (
          <span className="text-green-700 bg-green-50 px-1.5 py-0.5 rounded flex items-center gap-1">
            ✓ <span className="font-mono">{assignedName}</span>
          </span>
        )}
        {!isAssigned && (
          <span className="text-gray-400 italic">no DXF symbol assigned</span>
        )}
        <button
          onClick={handleRefreshDxf}
          title="Re-parse all DXF files (use after editing a .dxf file)"
          className="ml-auto text-[10px] px-2 py-0.5 rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 hover:text-gray-900 transition-colors"
        >
          ↺ Refresh DXF
        </button>
      </div>

      <div className="flex gap-3">
        {/* ── Symbol list ───────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1 w-52 shrink-0">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Library</span>
            {loadingMeta && <span className="text-[10px] text-gray-400 animate-pulse">loading…</span>}
          </div>

          {metaList.length === 0 && !loadingMeta && (
            <div className="text-gray-400 italic text-[10px] border border-dashed border-gray-200 rounded p-3 text-center">
              No .bglib.json symbols found.<br/>Upload a DXF below.
            </div>
          )}

          <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-0.5">
            {metaList.map((m) => (
              <button
                key={m.name}
                onClick={() => setSelectedName(m.name)}
                className={cn(
                  'text-left px-2 py-1.5 rounded border transition-colors',
                  selectedName === m.name
                    ? 'bg-blue-50 border-blue-300 text-blue-800'
                    : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50',
                  assignedName === m.name && 'ring-1 ring-green-400',
                )}
              >
                <div className="font-medium leading-tight">{m.name}</div>
                <div className="text-[9px] text-gray-400 mt-0.5 flex gap-2">
                  <span>{m.defaultWidth}mm</span>
                  <span>{m.sliderCount} slider{m.sliderCount !== 1 ? 's' : ''}</span>
                  {assignedName === m.name && (
                    <span className="text-green-600 font-semibold">assigned</span>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* Assign / Unassign buttons */}
          <div className="flex gap-1 mt-1">
            <button
              onClick={handleAssign}
              disabled={!selectedName || isCurrent}
              className={cn(
                'flex-1 py-1 rounded text-[10px] font-medium transition-colors',
                !selectedName || isCurrent
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700',
              )}
            >
              {isCurrent && isAssigned ? '✓ Assigned' : 'Assign'}
            </button>
            {isAssigned && (
              <button
                onClick={handleUnassign}
                className="px-2 py-1 rounded text-[10px] font-medium bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                title="Remove assignment"
              >✕</button>
            )}
          </div>
        </div>

        {/* ── Preview + dimensions ─────────────────────────────────────── */}
        <div className="flex flex-col gap-2 flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Preview</span>
            <span className="text-gray-300">|</span>
            <label className="flex items-center gap-1 text-[10px] text-gray-500">
              W:
              <input
                type="number" min={100} max={5000} step={50}
                defaultValue={actualW}
                className="w-16 px-1 py-0.5 border border-gray-200 rounded text-[10px]"
                onChange={(e) => {
                  // force re-render with new width by triggering a state update trick
                  const v = Number(e.target.value);
                  if (previewSymbol) {
                    setPreviewSymbol({ ...previewSymbol, _previewW: v } as BglibSymbol & { _previewW: number });
                  }
                }}
              />
              mm
            </label>
            <label className="flex items-center gap-1 text-[10px] text-gray-500">
              T:
              <input
                type="number" min={50} max={1000} step={10}
                defaultValue={actualH}
                className="w-14 px-1 py-0.5 border border-gray-200 rounded text-[10px]"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (previewSymbol) {
                    setPreviewSymbol({ ...previewSymbol, _previewH: v } as BglibSymbol & { _previewH: number });
                  }
                }}
              />
              mm
            </label>
          </div>

          {loadingPreview && (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-[10px] animate-pulse">
              Loading symbol…
            </div>
          )}
          {!loadingPreview && !previewSvg && (
            <div className="flex-1 flex items-center justify-center border border-dashed border-gray-200 rounded bg-gray-50 text-gray-400 text-[10px] min-h-[100px]">
              Select a symbol to preview
            </div>
          )}
          {!loadingPreview && previewSvg && (
            <div
              className="border border-gray-200 rounded overflow-hidden"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: previewSvg }}
            />
          )}

          {/* Slider info */}
          {previewSymbol && previewSymbol.sliders.length > 0 && (
            <div className="text-[9px] text-gray-500 bg-gray-50 rounded px-2 py-1 border border-gray-100">
              <span className="font-semibold">Sliders: </span>
              {previewSymbol.sliders.map((s, i) => (
                <span key={i} className="mr-2 font-mono">
                  {s.id} ({s.axis}×{s.factor})
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Upload section ────────────────────────────────────────────────── */}
      <div className="border border-dashed border-gray-200 rounded p-3 bg-gray-50">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide shrink-0">
            Upload .dxf
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".dxf"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className={cn(
              'px-3 py-1 rounded text-[10px] font-medium border transition-colors',
              uploading
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700',
            )}
          >
            {uploading ? '⏳ Parsing…' : '📂 Choose DXF file'}
          </button>

          <div className="text-[9px] text-gray-400 leading-tight">
            Drawn in QCAD using layer conventions:<br/>
            <span className="font-mono">slider_length</span> / <span className="font-mono">slider_0.5length</span> / <span className="font-mono">slider_height</span> / <span className="font-mono">origin</span> / <span className="font-mono">ax</span> / <span className="font-mono">ignore</span>
          </div>
        </div>

        {uploadError && (
          <div className="mt-2 text-[10px] text-red-600 bg-red-50 rounded px-2 py-1 border border-red-200">
            ✗ {uploadError}
          </div>
        )}
        {uploadSuccess && (
          <div className="mt-2 text-[10px] text-green-700 bg-green-50 rounded px-2 py-1 border border-green-200">
            ✓ {uploadSuccess}
          </div>
        )}
      </div>

    </div>
  );
}
