/**
 * IFCPlanView — Orthographic OBC Plan with Volumetric Rig System
 *
 * The plan view IS an orthographic top-down rendering of the OBC FragmentsModel.
 * Rig axes are Three.js line meshes in BREP world space.
 * Dragging an axis directly deforms the BREP model — 1:1 coordinate mapping,
 * no coordinate transform needed during drag.
 *
 * Sprint 1: IFC ortho plan view, pan/zoom (via OBC camera), storey selector
 * Sprint 2: Rig axis overlay — auto-generated from IFC grid, converted to BREP world coords
 * Sprint 3: Real-time BREP deformation as rig axes are dragged
 * Sprint 4: "Apply to BubbleGraph" — inverse-transforms rig positions back to parametric model
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useBubbleGraphStore,
  type IFCPlanData, type IFCPlanStorey,
} from '../../store/index';
import { cn } from '../../lib/utils';
import { generateRigFromStorey } from '../../lib/rigDeformer';
import { IFCRigZoneModifier, type RigAxisDef } from '../../lib/IFCRigZoneModifier';
import { parseIfcPlan } from '../../lib/ifcStepParser';
import { IFCOrthoPlanView, type BrepBbox } from './IFCOrthoPlanView';
import { IFC3DFloatingPanel } from './IFC3DFloatingPanel';
import type * as FRAGS from '@thatopen/fragments';
import type * as OBC from '@thatopen/components';
import type * as THREE from 'three';

// ── Constants ──────────────────────────────────────────────────────────────
const ALL_STOREYS_ID = '__all__';

// ── Component ──────────────────────────────────────────────────────────────
interface IFCPlanViewProps { className?: string; }

export function IFCPlanView({ className }: IFCPlanViewProps) {
  const {
    ifcPlanData, setIfcPlanData,
    rigState, setRigAxes, updateRigAxis, clearRig,
    bubbleGraphNodes, updateStoreyAxes,
  } = useBubbleGraphStore((s) => ({
    ifcPlanData:      s.ifcPlanData,
    setIfcPlanData:   s.setIfcPlanData,
    rigState:         s.rigState,
    setRigAxes:       s.setRigAxes,
    updateRigAxis:    s.updateRigAxis,
    clearRig:         s.clearRig,
    bubbleGraphNodes: s.bubbleGraphNodes,
    updateStoreyAxes: s.updateStoreyAxes,
  }));

  const [loading, setLoading]                   = useState(false);
  const [error, setError]                       = useState<string | null>(null);
  const [selectedStoreyId, setSelectedStoreyId] = useState<string | null>(null);
  const [showRig, setShowRig]                   = useState(true);
  const [show3D, setShow3D]                     = useState(false);

  // ── IFC buffer (raw bytes for OBC FragmentsModel) ─────────────────────────
  const [ifcBuffer, setIfcBuffer]   = useState<ArrayBuffer | null>(null);
  const [ifcFileName, setIfcFileName] = useState<string>('model.ifc');

  // ── BREP zone modifier (created once after OBC model is loaded) ───────────
  const zoneModifierRef = useRef<IFCRigZoneModifier | null>(null);
  const dragStartMm     = useRef<number>(0);
  const brepBboxRef     = useRef<BrepBbox | null>(null);

  // ── Shared Three.js scene from 2D plan (for 3D floating panel) ────────────
  const [sharedScene, setSharedScene] = useState<THREE.Scene | null>(null);
  const [sharedRenderer, setSharedRenderer] = useState<THREE.WebGLRenderer | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Active storey / merged mode ─────────────────────────────────────────
  const isMergedMode = (selectedStoreyId ?? ifcPlanData?.storeys[0]?.id) === ALL_STOREYS_ID;

  const activeStorey: IFCPlanStorey | null = useMemo(() => {
    if (!ifcPlanData || isMergedMode) return null;
    const id = selectedStoreyId ?? ifcPlanData.storeys[0]?.id ?? null;
    return ifcPlanData.storeys.find((s) => s.id === id) ?? ifcPlanData.storeys[0] ?? null;
  }, [ifcPlanData, selectedStoreyId, isMergedMode]);

  // Merged axes for rig generation in merged mode
  const mergedAxes = useMemo(() => {
    if (!ifcPlanData || !isMergedMode) return { axesX_mm: [] as number[], axesY_mm: [] as number[] };
    const xs = new Set<number>(), ys = new Set<number>();
    ifcPlanData.storeys.forEach((s) => {
      s.axesX_mm.forEach((v) => xs.add(v));
      s.axesY_mm.forEach((v) => ys.add(v));
    });
    return {
      axesX_mm: [...xs].sort((a, b) => a - b),
      axesY_mm: [...ys].sort((a, b) => a - b),
    };
  }, [ifcPlanData, isMergedMode]);

  // Effective parser axes for rig generation
  const effectiveAxesX = isMergedMode ? mergedAxes.axesX_mm : (activeStorey?.axesX_mm ?? []);
  const effectiveAxesY = isMergedMode ? mergedAxes.axesY_mm : (activeStorey?.axesY_mm ?? []);

  const rigAxes = rigState.axes;
  const rigAxesRef = useRef(rigAxes);
  rigAxesRef.current = rigAxes;
  const hasDeformation = useMemo(
    () => rigAxes.some((a) => a.positionMm !== a.originMm),
    [rigAxes],
  );

  // ── Storey clip planes (BREP world Y metres) ────────────────────────────
  // In merged mode: no clipping (show full building).
  // In single storey mode: clip to storey elevation range.
  const clipBottomM = useMemo(() => {
    if (isMergedMode || !activeStorey) return undefined;
    return activeStorey.elevation_mm * 0.001 - 0.1; // small buffer below
  }, [isMergedMode, activeStorey]);

  const clipTopM = useMemo(() => {
    if (isMergedMode || !activeStorey) return undefined;
    return (activeStorey.elevation_mm + activeStorey.height_mm) * 0.001 + 0.1;
  }, [isMergedMode, activeStorey]);

  // ── OBC model loaded callback ─────────────────────────────────────────────
  const handleModelLoaded = useCallback((
    model: FRAGS.FragmentsModel,
    fragsModels: FRAGS.FragmentsModels,
    components: OBC.Components,
    bbox: BrepBbox,
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
  ) => {
    brepBboxRef.current = bbox;
    setSharedScene(scene);
    setSharedRenderer(renderer);

    // Dispose previous modifier
    if (zoneModifierRef.current) {
      void zoneModifierRef.current.dispose();
    }
    zoneModifierRef.current = new IFCRigZoneModifier(model, fragsModels, components);
    zoneModifierRef.current.setScene(scene);
    console.log('[IFCPlanView] handleModelLoaded: new ZoneModifier created + scene attached');

    // Axis registration is handled by the dedicated useEffect below
  }, []);  // stable — no deps on rigAxes

  // ── Register rig axes on the existing modifier whenever axis LIST changes ──
  // We track axis IDs (not positions) to avoid re-registration during drag.
  const axisIdsKey = useMemo(() => rigAxes.map(a => a.id).join(','), [rigAxes]);
  useEffect(() => {
    const zm = zoneModifierRef.current;
    if (!zm || rigAxes.length === 0) return;

    // Compute half-widths: each axis zone extends to midpoints between neighbors
    const xAxes = rigAxes.filter(a => a.dir === 'X').sort((a, b) => a.originMm - b.originMm);
    const yAxes = rigAxes.filter(a => a.dir === 'Y').sort((a, b) => a.originMm - b.originMm);

    const halfWidths = new Map<string, number>();
    for (const group of [xAxes, yAxes]) {
      for (let i = 0; i < group.length; i++) {
        const prev = i > 0 ? group[i - 1].originMm : null;
        const next = i < group.length - 1 ? group[i + 1].originMm : null;
        const cur  = group[i].originMm;
        // Half distance to nearest neighbor on each side (in metres)
        const leftHalf  = prev !== null ? (cur - prev) * 0.001 / 2 : 2.0;  // default 2m for edge
        const rightHalf = next !== null ? (next - cur) * 0.001 / 2 : 2.0;
        halfWidths.set(group[i].id, Math.max(leftHalf, rightHalf));
      }
    }

    let cancelled = false;
    (async () => {
      try {
        // Clear previously registered zones before re-adding
        (zm as any)._zones?.clear?.();
        for (const a of rigAxes) {
          if (cancelled) return;
          const def: RigAxisDef = {
            id:         a.id,
            dir:        a.dir,
            positionM:  a.positionMm * 0.001,
            originM:    a.originMm * 0.001,
            label:      a.label,
            halfWidthM: halfWidths.get(a.id) ?? 0.25,
          };
          await zm.addAxis(def);
        }
        console.log(`[IFCPlanView] registered ${rigAxes.length} axes on modifier (zones=${(zm as any)._zones?.size})`);
      } catch (e) {
        console.warn('[IFCPlanView] addAxis failed:', e);
      }
    })();

    return () => { cancelled = true; };
  }, [axisIdsKey]); // only re-register when axis list changes, NOT on position changes

  // ── Axis drag callbacks (from IFCOrthoPlanView) ───────────────────────────

  const handleAxisDragStart = useCallback((axisId: string) => {
    const axis = rigAxesRef.current.find((a) => a.id === axisId);
    if (!axis) return;
    dragStartMm.current = axis.positionMm;
  }, []);

  const handleAxisDrag = useCallback((axisId: string, newPosMm: number) => {
    // Update rig axis store (moves the rig line visuals during drag)
    updateRigAxis(axisId, newPosMm);
    // Geometry is NOT updated during drag — only on pointer-up (like production)
  }, [updateRigAxis]);

  const handleAxisDragEnd = useCallback((axisId: string, startPosMm: number, endPosMm: number) => {
    const totalDeltaMm = endPosMm - startPosMm;
    if (Math.abs(totalDeltaMm) < 0.5) return; // insignificant drag

    const zm = zoneModifierRef.current;
    if (!zm) return;

    const axis = rigAxesRef.current.find((a) => a.id === axisId);
    if (!axis) return;

    // Apply displacement using production pattern (toWorld → add delta → fromWorld → writeFrags)
    const deltaM = totalDeltaMm * 0.001;
    const dx = axis.dir === 'X' ? deltaM : 0;
    const dz = axis.dir === 'Y' ? deltaM : 0;

    console.log(`[IFCPlanView] handleAxisDragEnd: calling applyAxisDelta(${axisId}, dx=${dx}, dz=${dz})`);
    zm.applyAxisDelta(axisId, dx, dz)
      .catch((e) => console.warn('[IFCPlanView] applyAxisDelta failed:', e));
  }, []);

  // ── Auto-generate rig (in BREP world coords) ─────────────────────────────
  const handleAutoRig = useCallback(async () => {
    const zm = zoneModifierRef.current;
    if (!zm) {
      console.warn('[IFCPlanView] Auto Rig: zone modifier not ready (load model first)');
      return;
    }

    const storeyId = isMergedMode ? ALL_STOREYS_ID : (activeStorey?.id ?? ALL_STOREYS_ID);

    // Convert parser grid axes to BREP world mm
    const parserBounds = ifcPlanData?.worldBounds as [number, number, number, number] | undefined;
    if (!parserBounds) {
      console.warn('[IFCPlanView] Auto Rig: no parser world bounds');
      return;
    }

    const result = await zm.convertParserAxesToBrep(parserBounds, effectiveAxesX, effectiveAxesY);
    if (!result) {
      console.warn('[IFCPlanView] Auto Rig: BREP bbox not available');
      return;
    }

    const { brepAxesXMm, brepAxesYMm } = result;
    console.log('[IFCPlanView] Auto Rig — BREP axes:', { brepAxesXMm, brepAxesYMm });

    // Generate rig axes with BREP world mm positions
    const axes = generateRigFromStorey(brepAxesXMm, brepAxesYMm, storeyId);
    setRigAxes(axes);
    // Axis registration is handled by the dedicated useEffect (triggered by setRigAxes)
  }, [isMergedMode, activeStorey, effectiveAxesX, effectiveAxesY, setRigAxes, ifcPlanData]);

  // ── Reset rig ─────────────────────────────────────────────────────────────
  const handleResetRig = useCallback(() => {
    const axes = rigAxesRef.current;
    setRigAxes(axes.map((a) => ({ ...a, positionMm: a.originMm })));
    const zm = zoneModifierRef.current;
    if (zm) {
      for (const a of axes) {
        zm.resetAxis(a.id).catch(() => {});
      }
    }
  }, [setRigAxes]);

  // ── Apply to BubbleGraph (inverse-transform BREP world → parser mm) ───────
  const handleApplyToBubbleGraph = useCallback(async () => {
    if (!rigAxes.length) return;
    const zm = zoneModifierRef.current;
    const parserBounds = ifcPlanData?.worldBounds as [number, number, number, number] | undefined;

    if (!zm || !parserBounds) {
      console.warn('[IFCPlanView] Apply: zone modifier or parser bounds not available');
      return;
    }

    // Separate X and Y axes (BREP world mm)
    const brepXMm = rigAxes.filter((a) => a.dir === 'X').map((a) => a.positionMm).sort((a, b) => a - b);
    const brepYMm = rigAxes.filter((a) => a.dir === 'Y').map((a) => a.positionMm).sort((a, b) => a - b);

    // Convert BREP world mm → parser mm
    const result = await zm.convertBrepAxesToParser(parserBounds, brepXMm, brepYMm);
    if (!result) {
      console.warn('[IFCPlanView] Apply: inverse transform failed');
      return;
    }

    const { parserAxesXMm, parserAxesYMm } = result;

    // Find the storey node in BubbleGraph
    const ifcElev = activeStorey?.elevation_mm ?? 0;
    const storeyNodes = bubbleGraphNodes.filter((n) => n.type === 'storey');
    const targetStorey = storeyNodes.find((n) => {
      const be = Number(n.properties?.bottomElevation ?? 0);
      return Math.abs(be - ifcElev) < 600;
    }) ?? storeyNodes[0];

    if (!targetStorey) {
      alert('Niciun storey găsit în BubbleGraph. Importă mai întâi modelul IFC prin ChatPanel.');
      return;
    }

    parserAxesXMm.forEach((mm, i) => updateStoreyAxes(targetStorey.id, 'X', i, mm));
    parserAxesYMm.forEach((mm, i) => updateStoreyAxes(targetStorey.id, 'Y', i, mm));
  }, [rigAxes, ifcPlanData, activeStorey, bubbleGraphNodes, updateStoreyAxes]);

  // ── Export Rig JSON ───────────────────────────────────────────────────────
  const handleExportRigJSON = useCallback(() => {
    const zm = zoneModifierRef.current;
    if (!zm || !rigAxes.length) {
      alert('Generează rig-ul înainte de export.');
      return;
    }
    const json = zm.exportRigJSON(
      ifcPlanData?.storeys as Array<{ id: string; name: string; elevation_mm: number; height_mm: number }> | undefined,
      ifcFileName,
    );
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const baseName = ifcFileName.replace(/\.ifc$/i, '');
    a.download = `${baseName}_rig.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [rigAxes, ifcPlanData, ifcFileName]);

  // ── IFC file upload ───────────────────────────────────────────────────────
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setLoading(true); setError(null);
    try {
      const rawBuffer = await file.arrayBuffer();
      setIfcBuffer(rawBuffer);
      setIfcFileName(file.name);

      // Dispose any existing zone modifier
      if (zoneModifierRef.current) {
        void zoneModifierRef.current.dispose();
        zoneModifierRef.current = null;
      }

      // Client-side IFC STEP parsing for storey metadata + grid detection
      const data = await parseIfcPlan(rawBuffer);

      setIfcPlanData({
        fileKey:     file.name,
        storeys:     data.storeys as IFCPlanData['storeys'],
        worldBounds: data.worldBounds,
        totalWalls:  data.totalWalls,
        totalSlabs:  data.totalSlabs,
      });
      setSelectedStoreyId(data.storeys[0]?.id ?? null);
      clearRig();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [setIfcPlanData, clearRig]);

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!ifcPlanData) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full gap-5 bg-slate-950', className)}>
        <input ref={fileInputRef} type="file" accept=".ifc" className="hidden" onChange={handleFileChange} />
        <div className="text-center space-y-3">
          <div className="text-4xl opacity-30">📐</div>
          <p className="text-base font-semibold text-slate-200">IFC Plan — Rig Control</p>
          <p className="text-sm text-slate-500 max-w-xs">
            Încarcă un fișier IFC pentru a vizualiza planul ortografic
            și a controla geometria prin axele de rig.
          </p>
        </div>
        {error && (
          <div className="text-sm text-red-400 bg-red-900/20 px-4 py-2 rounded-md max-w-sm text-center border border-red-800/30">{error}</div>
        )}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
          className="px-6 py-2.5 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-500 disabled:opacity-50 shadow-lg shadow-orange-900/30 transition-all"
        >
          {loading ? 'Se parsează IFC…' : '📂 Deschide fișier IFC'}
        </button>
      </div>
    );
  }

  const { storeys } = ifcPlanData;
  const currentStoreyId = selectedStoreyId ?? storeys[0]?.id ?? '';

  return (
    <div className={cn('relative flex flex-col h-full bg-slate-950 overflow-hidden select-none', className)}>
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 bg-slate-900/95 flex-shrink-0 z-10 text-xs">

        {/* ── Storey selector ── */}
        <div className="flex items-center gap-1.5">
          <span className="text-slate-500 text-[10px] uppercase tracking-wider font-medium">Etaj</span>
          <select
            value={currentStoreyId}
            onChange={(e) => { setSelectedStoreyId(e.target.value); clearRig(); }}
            className="bg-slate-800 text-slate-200 border border-slate-700 rounded px-2 py-1 focus:outline-none focus:border-blue-500 text-xs min-w-[140px]"
          >
            <option value={ALL_STOREYS_ID}>Toate etajele</option>
            {storeys.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.elevation_mm >= 0 ? '+' : ''}{(s.elevation_mm / 1000).toFixed(2)}m)
              </option>
            ))}
          </select>
        </div>

        <div className="w-px h-5 bg-slate-700" />

        {/* ── Rig controls group ── */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => void handleAutoRig()}
            className={cn(
              'flex items-center gap-1 px-2.5 py-1 rounded-md font-medium transition-all',
              rigAxes.length
                ? 'bg-orange-600/20 text-orange-300 hover:bg-orange-600/30'
                : 'bg-orange-600 text-white hover:bg-orange-500 shadow-sm shadow-orange-900/50',
            )}
            title="Generează rig din axele IFC detectate"
          >
            <span className="text-sm">⊞</span>
            {rigAxes.length ? 'Regenerează' : 'Auto Rig'}
          </button>
          {rigAxes.length > 0 && (
            <>
              <button
                onClick={handleResetRig}
                disabled={!hasDeformation}
                className="px-2 py-1 rounded-md bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                title="Resetează toate axele la poziția originală"
              >↺ Reset</button>
              <button
                onClick={clearRig}
                className="px-2 py-1 rounded-md bg-slate-800 text-slate-400 hover:bg-red-900/30 hover:text-red-400 transition-all"
                title="Șterge rig-ul complet"
              >✕</button>
            </>
          )}
        </div>

        {/* ── Apply deformation ── */}
        {hasDeformation && (
          <>
            <div className="w-px h-5 bg-slate-700" />
            <button
              onClick={() => void handleApplyToBubbleGraph()}
              className="flex items-center gap-1 px-3 py-1 rounded-md bg-emerald-600 text-white font-medium hover:bg-emerald-500 shadow-sm shadow-emerald-900/50 transition-all"
              title="Aplică modificările rig-ului în BubbleGraph"
            >
              <span>✓</span> Aplică la BubbleGraph
            </button>
          </>
        )}

        {/* ── Export Rig JSON ── */}
        {rigAxes.length > 0 && (
          <>
            <div className="w-px h-5 bg-slate-700" />
            <button
              onClick={handleExportRigJSON}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white transition-all"
              title="Exportă rig-ul cu coordonate world ale profilelor orizontale (JSON)"
            >
              <span>💾</span> Export Rig JSON
            </button>
          </>
        )}

        {/* ── Status badge ── */}
        {rigAxes.length > 0 && (
          <span className="text-[10px] text-slate-500 ml-1 tabular-nums">
            {rigAxes.filter((a) => a.dir === 'X').length}V · {rigAxes.filter((a) => a.dir === 'Y').length}H
            {hasDeformation && (
              <span className="text-amber-400 ml-1">
                ({rigAxes.filter((a) => Math.abs(a.positionMm - a.originMm) > 0.5).length} modificate)
              </span>
            )}
          </span>
        )}

        <div className="flex-1" />

        {/* ── Right side toggles ── */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowRig((v) => !v)}
            className={cn(
              'px-2 py-1 rounded-md text-[11px] font-medium transition-all',
              showRig
                ? 'bg-orange-600/20 text-orange-300 ring-1 ring-orange-600/40'
                : 'bg-slate-800 text-slate-500 hover:text-slate-300',
            )}
            title="Arată/ascunde axele rig"
          >Rig</button>

          <button
            onClick={() => setShow3D((v) => !v)}
            className={cn(
              'px-2 py-1 rounded-md text-[11px] font-medium transition-all',
              show3D
                ? 'bg-blue-600/20 text-blue-300 ring-1 ring-blue-600/40'
                : 'bg-slate-800 text-slate-500 hover:text-slate-300',
            )}
            title="Panou 3D flotant"
          >3D</button>

          <input ref={fileInputRef} type="file" accept=".ifc" className="hidden" onChange={handleFileChange} />
          <button onClick={() => fileInputRef.current?.click()} disabled={loading}
            className="px-2 py-1 rounded-md bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700 disabled:opacity-50 transition-all"
            title="Deschide alt fișier IFC"
          >{loading ? '…' : '📂'}</button>
        </div>

        {error && <span className="text-red-400 text-[10px] ml-1 truncate max-w-[200px]">{error}</span>}
      </div>

      {/* ── Orthographic Plan View (OBC FragmentsModel) ── */}
      <div className="flex-1 relative overflow-hidden">
        <IFCOrthoPlanView
          ifcBuffer={ifcBuffer}
          ifcName={ifcFileName}
          clipBottomM={clipBottomM}
          clipTopM={clipTopM}
          rigAxes={rigAxes}
          showRig={showRig}
          onModelLoaded={handleModelLoaded}
          onAxisDrag={handleAxisDrag}
          onAxisDragStart={handleAxisDragStart}
          onAxisDragEnd={handleAxisDragEnd}
        />

        {/* ── Instructions overlay (shown when rig is active but no deformation yet) ── */}
        {showRig && rigAxes.length > 0 && !hasDeformation && (
          <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <div className="bg-slate-900/90 text-slate-400 text-[11px] px-3 py-1.5 rounded-full border border-slate-700/50 backdrop-blur-sm flex items-center gap-2">
              <span className="text-orange-400">↔</span>
              Trage o axă pentru a deforma geometria
              <span className="text-slate-600">·</span>
              <span className="text-slate-500">Scroll = Zoom · Click+Drag = Pan</span>
            </div>
          </div>
        )}

        {/* Floating 3D panel */}
        {show3D && (
          <IFC3DFloatingPanel
            scene={sharedScene}
            renderer={sharedRenderer}
            clipBottomM={clipBottomM}
            clipTopM={clipTopM}
            onClose={() => setShow3D(false)}
          />
        )}
      </div>
    </div>
  );
}

