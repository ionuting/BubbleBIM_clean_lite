/**
 * IFCRigViewer.tsx
 *
 * Floating OBC-based IFC 3D viewer for the Rig Zone deformation pipeline.
 *
 * - Loads the real IFC file buffer via OBC IfcLoader + FragmentsManager.
 * - Notifies parent when model is ready via onModelLoaded(model, fragsModels).
 * - Is the replacement for IFCPreview3D once BREP deformation is active.
 * - Accepts an optional IFCRigZoneModifier ref so rig drag → BREP update
 *   is coordinated via fragsModels.update().
 *
 * Usage in IFCPlanView:
 *   <IFCRigViewer
 *     ifcBuffer={ifcBuffer}
 *     onModelLoaded={(model, frags) => { modifierRef.current = new IFCRigZoneModifier(model, frags); }}
 *     onClose={() => setShow3D(false)}
 *   />
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as OBF from '@thatopen/components-front';
import * as FRAGS from '@thatopen/fragments';
import { cn } from '@/lib/utils';

// ── OBC worker / wasm URLs (identical to WebIfcViewer) ────────────────────────
const FRAGMENTS_WORKER_URL = '/node_modules/@thatopen/fragments/dist/Worker/worker.mjs';
// Use local web-ifc WASM (served by Vite dev server via fs.allow: ['..'])
const WEBIFC_WASM_PATH     = '/node_modules/web-ifc/';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IFCRigViewerProps {
  /** Raw IFC file bytes — passed from IFCPlanView after upload. */
  ifcBuffer:     ArrayBuffer | null;
  /** IFC file name (for fragment tile naming). */
  ifcName?:      string;
  className?:    string;
  onClose?:      () => void;
  /**
   * Called once when the model has been fully parsed and loaded into the scene.
   * Provides the FragmentsModel and the FragmentsModels manager so the caller
   * can create an IFCRigZoneModifier.
   */
  onModelLoaded?: (
    model:       FRAGS.FragmentsModel,
    fragsModels: FRAGS.FragmentsModels,
    components:  OBC.Components,
  ) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function IFCRigViewer({
  ifcBuffer,
  ifcName = 'model',
  className,
  onClose,
  onModelLoaded,
}: IFCRigViewerProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const componentsRef  = useRef<OBC.Components | null>(null);
  const worldRef       = useRef<OBC.World | null>(null);
  const ifcLoaderRef   = useRef<OBC.IfcLoader | null>(null);
  const loadedModelRef = useRef<FRAGS.FragmentsModel | null>(null);

  const [status, setStatus]     = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  // Track loading to prevent duplicate loads (React strict mode / dep changes)
  const loadingRef = useRef(false);
  // Keep a stable callback ref so the effect doesn't re-run when callback changes
  const onModelLoadedRef = useRef(onModelLoaded);
  useEffect(() => { onModelLoadedRef.current = onModelLoaded; }, [onModelLoaded]);

  // ── OBC scene init ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const components = new OBC.Components();
    componentsRef.current = components;

    const worlds = components.get(OBC.Worlds);
    const world  = worlds.create<
      OBC.SimpleScene,
      OBC.OrthoPerspectiveCamera,
      OBF.PostproductionRenderer
    >();

    world.name     = 'IFCRigViewer';
    world.scene    = new OBC.SimpleScene(components);
    world.renderer = new OBF.PostproductionRenderer(components, container);
    world.camera   = new OBC.OrthoPerspectiveCamera(components);

    const cam = world.camera as OBC.OrthoPerspectiveCamera;
    cam.threePersp.near = 0.01;
    cam.threePersp.updateProjectionMatrix();
    cam.controls.restThreshold = 0.05;

    world.scene.setup();
    world.scene.three.background = new THREE.Color(0x13161c);

    // Grid
    try {
      const grid = components.get(OBC.Grids).create(world);
      (grid as any).material?.uniforms?.uColor?.value?.set(0x3a3d44);
    } catch { /* grid optional */ }

    components.init();
    components.get(OBC.Raycasters).get(world);

    // Postprocessing
    const { postproduction } = world.renderer;
    postproduction.enabled = true;

    // FragmentsManager
    const fragments = components.get(OBC.FragmentsManager);
    fragments.init(FRAGMENTS_WORKER_URL);

    fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
      const isLod = 'isLodMaterial' in material && (material as any).isLodMaterial;
      if (isLod) world.renderer!.postproduction.basePass.isolatedMaterials.push(material as THREE.Material);
    });

    cam.projection.onChanged.add(() => {
      for (const [, model] of fragments.list) model.useCamera(cam.three);
      fragments.core.update(true);
    });

    // Drive tile streaming every camera-controls frame (same as reference project)
    cam.controls.addEventListener('update', () => {
      fragments.core.update();
    });

    // Also hook into the world's beforeUpdate/afterUpdate for continuous rendering
    // so tiles stream even before the user interacts with the camera.
    world.renderer!.onBeforeUpdate.add(() => {
      fragments.core.update();
    });

    // Models loaded via fragments.core.load() appear here (tile-streamed models)
    fragments.core.models.list.onItemSet.add(({ value: model }: { value: FRAGS.FragmentsModel }) => {
      // Always use perspective camera for tile LOD calculations
      model.useCamera(cam.threePersp);
      model.getClippingPlanesEvent = () =>
        Array.from(world.renderer!.three.clippingPlanes);
      world.scene.three.add(model.object);
      fragments.core.update(true);
    });

    // IfcLoader
    const ifcLoader = components.get(OBC.IfcLoader) as OBC.IfcLoader;
    ifcLoader.setup({
      autoSetWasm: false,
      wasm: { absolute: true, path: WEBIFC_WASM_PATH },
    }).then(() => {
      ifcLoaderRef.current = ifcLoader;
    }).catch((e) => {
      console.error('[IFCRigViewer] IfcLoader setup failed:', e);
      setStatus('error');
      setErrorMsg('IfcLoader init failed');
    });

    worldRef.current = world;

    return () => {
      try { components.dispose(); } catch { /* ignore */ }
      componentsRef.current = null;
      worldRef.current = null;
      ifcLoaderRef.current = null;
      loadedModelRef.current = null;
    };
  }, []);

  // ── Load IFC buffer when it changes ───────────────────────────────────────
  useEffect(() => {
    if (!ifcBuffer) return;
    // Prevent duplicate loads (React strict mode or dep changes)
    if (loadingRef.current) return;
    loadingRef.current = true;

    const tryLoad = async () => {
      // Wait for IfcLoader to be ready (async setup)
      let attempts = 0;
      while (!ifcLoaderRef.current && attempts < 40) {
        await new Promise((r) => setTimeout(r, 250));
        attempts++;
      }
      if (!ifcLoaderRef.current) {
        setStatus('error');
        setErrorMsg('IfcLoader not ready');
        return;
      }

      setStatus('loading');
      setErrorMsg('');

      try {
        // Unload previous model if any
        const fragments = componentsRef.current?.get(OBC.FragmentsManager);
        if (fragments && loadedModelRef.current) {
          try {
            fragments.core.dispose(loadedModelRef.current.modelId);
          } catch { /* ignore */ }
          loadedModelRef.current = null;
        }

        // IfcLoader.load() in OBC v3 internally calls:
        //   serializer.process(bytes) → fragments.core.load(bytes, { modelId })
        // So it already adds the model to fragments.core.models.list (tile-streaming).
        // The onItemSet handler above will add model.object to scene automatically.
        const cam = worldRef.current?.camera as OBC.OrthoPerspectiveCamera | undefined;
        const model = await ifcLoaderRef.current.load(
          new Uint8Array(ifcBuffer),
          false,                              // don't apply geo-coordinate transformation
          ifcName.replace(/\.ifc$/i, ''),
        );
        model.graphicsQuality = 1;
        loadedModelRef.current = model;
        setStatus('ready');

        // Fit camera to model bounding box from an isometric-like SE viewpoint.
        if (cam) {
          const box = model.box;
          if (!box.isEmpty()) {
            const center = new THREE.Vector3();
            const size   = new THREE.Vector3();
            box.getCenter(center);
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            const dist   = maxDim * 2.0;

            // Position camera to SE above, looking at center
            const eye = new THREE.Vector3(
              center.x + dist * 0.6,
              center.y + dist * 0.5,
              center.z + dist * 0.6,
            );
            await cam.controls.setLookAt(
              eye.x, eye.y, eye.z,
              center.x, center.y, center.z,
              false, // instant
            );
          }
          // Re-apply camera to model after fit so LOD uses the final camera pos
          model.useCamera(cam.threePersp);
          await fragments!.core.update(true);
        }

        // Notify parent AFTER camera is positioned (IFCRigZoneModifier init won't race)
        onModelLoadedRef.current?.(model, fragments!.core as unknown as FRAGS.FragmentsModels, componentsRef.current!);
        loadingRef.current = false;
      } catch (err) {
        console.error('[IFCRigViewer] load error:', err);
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : String(err));
        loadingRef.current = false;
      }
    };

    void tryLoad();
  }, [ifcBuffer, ifcName]);

  // ── Resize observer ────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    const renderer  = worldRef.current?.renderer as OBF.PostproductionRenderer | undefined;
    if (!container || !renderer) return;
    const obs = new ResizeObserver(() => {
      try { renderer.resize(); } catch { /* ignore */ }
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, []);

  // ── Close handler ──────────────────────────────────────────────────────────
  const handleClose = useCallback(() => onClose?.(), [onClose]);

  // ── Status label ──────────────────────────────────────────────────────────
  const statusLabel = status === 'loading'
    ? 'Se încarcă modelul IFC…'
    : status === 'error'
      ? `Eroare: ${errorMsg}`
      : null;

  return (
    <div
      className={cn(
        'absolute bottom-4 right-4 z-40',
        'w-[580px] h-[400px] flex flex-col',
        'rounded-xl overflow-hidden shadow-2xl border border-slate-700',
        'bg-[#13161c]',
        className,
      )}
      style={{ resize: 'both', overflow: 'hidden', minWidth: 320, minHeight: 200 }}
    >
      {/* Title bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-800/90 border-b border-slate-700 shrink-0 select-none">
        <span className="text-xs font-semibold text-sky-400 tracking-wide">⬡ IFC 3D — Real BREP</span>
        {status === 'ready' && (
          <span className="text-[10px] text-emerald-400 ml-1">● model loaded</span>
        )}
        {status === 'loading' && (
          <span className="text-[10px] text-amber-400 ml-1 animate-pulse">● loading…</span>
        )}
        {status === 'error' && (
          <span className="text-[10px] text-red-400 ml-1">● error</span>
        )}
        <div className="ml-auto flex gap-1">
          <button
            title="Close"
            onClick={handleClose}
            className="w-5 h-5 rounded text-slate-400 hover:text-red-400 hover:bg-slate-700 text-xs flex items-center justify-center transition-colors"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 3D canvas container */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden">
        {/* Status overlay */}
        {statusLabel && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
            <span className="text-sm text-slate-300">{statusLabel}</span>
          </div>
        )}

        {/* Empty state */}
        {status === 'idle' && !ifcBuffer && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-500">
            <span className="text-3xl">🏗</span>
            <span className="text-xs">Încarcă un fișier IFC pentru preview 3D real</span>
          </div>
        )}
      </div>
    </div>
  );
}
