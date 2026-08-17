/**
 * IFCOrthoPlanView — Orthographic top-down OBC FragmentsModel view.
 *
 * Replaces the SVG-based plan view with a direct OBC render, giving
 * 1:1 coordinate mapping between mouse position and BREP world space.
 *
 * - Loads IFC file into OBC FragmentsManager with tile streaming.
 * - Orthographic camera locked to top-down (looking -Y in Three.js).
 * - Rig axes rendered as Three.js dashed lines in world space.
 * - Mouse drag on axes → direct BREP deformation via callbacks.
 * - Optional storey clipping via Y-axis clip planes.
 */

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as OBF from '@thatopen/components-front';
import * as FRAGS from '@thatopen/fragments';
import { cn } from '@/lib/utils';
import type { RigAxis } from '../../store/index';

// ── Worker / WASM URLs ────────────────────────────────────────────────────────
const FRAGMENTS_WORKER_URL = '/node_modules/@thatopen/fragments/dist/Worker/worker.mjs';
const WEBIFC_WASM_PATH     = '/node_modules/web-ifc/';

// ── Rig axis styling ──────────────────────────────────────────────────────────
const RIG_X_COLOR    = 0xf97316;  // orange-500
const RIG_Y_COLOR    = 0xa855f7;  // purple-500
const RIG_X_COLOR_HI = 0xfbbf24; // amber-400 (hover/drag highlight)
const RIG_Y_COLOR_HI = 0xc084fc; // purple-300 (hover/drag highlight)
const RIG_HIT_PX     = 12;        // pixel hit zone each side (generous for easy grabbing)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BrepBbox {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

export interface IFCOrthoPlanViewProps {
  ifcBuffer:    ArrayBuffer | null;
  ifcName?:     string;
  /** Storey clipping: Y bottom (BREP world metres). Omit to skip clipping. */
  clipBottomM?: number;
  /** Storey clipping: Y top (BREP world metres). Omit to skip clipping. */
  clipTopM?:    number;
  /** Rig axes — positionMm/originMm are BREP world millimetres. */
  rigAxes:      RigAxis[];
  showRig?:     boolean;
  /** Called when IFC model is loaded and ready. */
  onModelLoaded?: (
    model:       FRAGS.FragmentsModel,
    fragsModels: FRAGS.FragmentsModels,
    components:  OBC.Components,
    bbox:        BrepBbox,
    scene:       THREE.Scene,
    renderer:    THREE.WebGLRenderer,
  ) => void;
  /** Called per-frame during drag with new BREP world mm position. */
  onAxisDrag?:      (axisId: string, newPosMm: number) => void;
  onAxisDragStart?: (axisId: string) => void;
  onAxisDragEnd?:   (axisId: string, startPosMm: number, endPosMm: number) => void;
  className?:       string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function IFCOrthoPlanView({
  ifcBuffer,
  ifcName = 'model',
  clipBottomM,
  clipTopM,
  rigAxes,
  showRig = true,
  onModelLoaded,
  onAxisDrag,
  onAxisDragStart,
  onAxisDragEnd,
  className,
}: IFCOrthoPlanViewProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const componentsRef  = useRef<OBC.Components | null>(null);
  const worldRef       = useRef<OBC.World | null>(null);
  const ifcLoaderRef   = useRef<OBC.IfcLoader | null>(null);
  const loadedModelRef = useRef<FRAGS.FragmentsModel | null>(null);
  const rigGroupRef    = useRef<THREE.Group | null>(null);
  const rigLinesRef    = useRef<Map<string, THREE.Line>>(new Map());
  const boundsRef      = useRef<BrepBbox | null>(null);
  const modelBoxRef    = useRef<THREE.Box3 | null>(null);

  const [status, setStatus]       = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg]   = useState('');
  const loadingRef = useRef(false);

  // Stable callback refs to avoid stale closures in raw event handlers
  const onModelLoadedRef  = useRef(onModelLoaded);
  const onAxisDragRef     = useRef(onAxisDrag);
  const onAxisDragStartRef = useRef(onAxisDragStart);
  const onAxisDragEndRef  = useRef(onAxisDragEnd);
  useEffect(() => { onModelLoadedRef.current = onModelLoaded; }, [onModelLoaded]);
  useEffect(() => { onAxisDragRef.current = onAxisDrag; }, [onAxisDrag]);
  useEffect(() => { onAxisDragStartRef.current = onAxisDragStart; }, [onAxisDragStart]);
  useEffect(() => { onAxisDragEndRef.current = onAxisDragEnd; }, [onAxisDragEnd]);

  // Re-notify parent when callback changes and model is already loaded (handles HMR / late mount)
  useEffect(() => {
    if (onModelLoaded && loadedModelRef.current && boundsRef.current && worldRef.current && componentsRef.current) {
      const fragments = componentsRef.current.get(OBC.FragmentsManager);
      onModelLoaded(
        loadedModelRef.current,
        fragments.core as unknown as FRAGS.FragmentsModels,
        componentsRef.current,
        boundsRef.current,
        worldRef.current.scene.three,
        (worldRef.current.renderer as any).three as THREE.WebGLRenderer,
      );
    }
  }, [onModelLoaded]);

  // Rig state refs (used in raw event handlers, no stale closure)
  const rigAxesRef = useRef(rigAxes);
  rigAxesRef.current = rigAxes;
  const showRigRef = useRef(showRig);
  showRigRef.current = showRig;

  // Drag state
  const dragRef = useRef<{
    axisId:     string;
    dir:        'X' | 'Y';
    startPosMm: number;
  } | null>(null);

  // Drag feedback — shown as tooltip during active drag
  const [dragFeedback, setDragFeedback] = useState<{
    axisLabel: string;
    deltaMm: number;
    screenX: number;
    screenY: number;
  } | null>(null);

  // Hover state — track which axis is hovered for visual highlight
  const hoveredAxisRef = useRef<string | null>(null);

  // Raw canvas event handler cleanup ref
  const cleanupRef = useRef<(() => void) | null>(null);

  // ── Helper: screen → BREP world XZ via raycast to ground plane ──────────
  // Works in BOTH orthographic and perspective modes.
  const _raycaster = useRef(new THREE.Raycaster());
  const _groundPlane = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)); // Y-up

  const screenToWorldXZ = (clientX: number, clientY: number): { x: number; z: number } | null => {
    const cam = worldRef.current?.camera as OBC.OrthoPerspectiveCamera | undefined;
    const container = containerRef.current;
    if (!cam || !container) return null;

    const rect = container.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    // Set ground plane at model's Y center
    const b = boundsRef.current;
    const elevY = b ? (b.minY + b.maxY) / 2 : 0;
    _groundPlane.current.constant = -elevY;

    _raycaster.current.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam.three);
    const hit = new THREE.Vector3();
    const intersected = _raycaster.current.ray.intersectPlane(_groundPlane.current, hit);
    if (!intersected) return null;
    return { x: hit.x, z: hit.z };
  };

  // ── Helper: hit threshold in BREP world metres (scales with zoom/distance) ──
  const getHitThreshold = (): number => {
    const cam = worldRef.current?.camera as OBC.OrthoPerspectiveCamera | undefined;
    const container = containerRef.current;
    if (!cam || !container) return 0.5;

    const threeCam = cam.three;
    if (threeCam instanceof THREE.OrthographicCamera) {
      const visibleWidth = threeCam.right - threeCam.left;
      return (visibleWidth / container.clientWidth) * RIG_HIT_PX;
    }
    // Perspective: use distance from camera to model center
    const b = boundsRef.current;
    if (b) {
      const center = new THREE.Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
      const dist = threeCam.position.distanceTo(center);
      const fov = (threeCam as THREE.PerspectiveCamera).fov * Math.PI / 180;
      const visibleHeight = 2 * dist * Math.tan(fov / 2);
      return (visibleHeight / container.clientHeight) * RIG_HIT_PX;
    }
    return 0.5;
  };

  // ── OBC scene initialisation ────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const components = new OBC.Components();
    componentsRef.current = components;

    const worlds = components.get(OBC.Worlds);
    const world = worlds.create<
      OBC.SimpleScene,
      OBC.OrthoPerspectiveCamera,
      OBF.PostproductionRenderer
    >();

    world.name     = 'IFCOrthoPlan';
    world.scene    = new OBC.SimpleScene(components);
    world.renderer = new OBF.PostproductionRenderer(components, container);
    world.camera   = new OBC.OrthoPerspectiveCamera(components);

    const cam = world.camera as OBC.OrthoPerspectiveCamera;
    cam.threePersp.near = 0.01;
    cam.threePersp.updateProjectionMatrix();
    cam.controls.restThreshold  = 0.05;
    cam.controls.enabled        = true;

    world.scene.setup();
    world.scene.three.background = new THREE.Color(0x0f172a); // slate-950

    // Enable local clipping (for storey filtering)
    world.renderer.three.localClippingEnabled = true;

    components.init();

    // Force renderer to correct container size after layout settles
    requestAnimationFrame(() => {
      try { (world.renderer as OBF.PostproductionRenderer).resize(); } catch { /* ignore */ }
    });

    // Postprocessing
    const { postproduction } = world.renderer;
    postproduction.enabled = true;

    // FragmentsManager
    const fragments = components.get(OBC.FragmentsManager);
    fragments.init(FRAGMENTS_WORKER_URL);

    fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
      const isLod = 'isLodMaterial' in material && (material as any).isLodMaterial;
      if (isLod) {
        world.renderer!.postproduction.basePass.isolatedMaterials.push(material as THREE.Material);
      }
    });

    // Drive tile streaming on camera move + render loop
    // Also sync persp camera for tile LOD when in ortho mode.
    // CRITICAL: When ortho zoom changes, the ortho camera position stays fixed —
    // only camera.zoom changes. We must adjust the persp camera distance so that
    // FragmentsModels tile LOD picks up the zoom level change.
    const _syncTarget = new THREE.Vector3();
    cam.controls.addEventListener('update', () => {
      cam.threePersp.quaternion.copy(cam.three.quaternion);

      // Sync position + ortho zoom → persp distance
      const orthoCam = cam.three as THREE.OrthographicCamera;
      const orthoZoom = ('zoom' in orthoCam) ? (orthoCam.zoom || 1) : 1;
      cam.controls.getTarget(_syncTarget);
      const dir = cam.three.position.clone().sub(_syncTarget);
      const baseDist = dir.length();
      if (baseDist > 0.01) {
        // Move persp cam closer when zoom > 1, further when zoom < 1
        dir.normalize().multiplyScalar(baseDist / orthoZoom);
        cam.threePersp.position.copy(_syncTarget).add(dir);
      } else {
        cam.threePersp.position.copy(cam.three.position);
      }

      cam.threePersp.updateProjectionMatrix();
      fragments.core.update();
    });
    world.renderer!.onBeforeUpdate.add(() => { fragments.core.update(); });

    // Fragment model handler — always use perspective camera for tile LOD
    fragments.core.models.list.onItemSet.add(({ value: model }: { value: FRAGS.FragmentsModel }) => {
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
      console.error('[IFCOrthoPlan] IfcLoader setup failed:', e);
      setStatus('error');
      setErrorMsg('IfcLoader init failed');
    });

    // Rig axis group (rendered on top of model)
    const rigGroup = new THREE.Group();
    rigGroup.name = 'RigAxes';
    rigGroup.renderOrder = 999;
    world.scene.three.add(rigGroup);
    rigGroupRef.current = rigGroup;

    worldRef.current = world;

    // ── Helper: set/clear highlight on rig axis visuals ───────────────────
    const setAxisHighlight = (axisId: string | null) => {
      const group = rigGroupRef.current;
      if (!group) return;
      const prev = hoveredAxisRef.current;
      if (prev === axisId) return;

      // Un-highlight previous
      if (prev) {
        const dir = prev.includes('-x-') ? 'X' : 'Y';
        const baseColor = dir === 'X' ? RIG_X_COLOR : RIG_Y_COLOR;
        group.children.forEach((child) => {
          if (child.name === `rig-plane-${prev}`) {
            const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
            mat.opacity = 0.06;
            mat.color.setHex(baseColor);
          }
          if (child.name === `rig-${prev}`) {
            const mat = (child as THREE.Line).material as THREE.LineDashedMaterial;
            mat.opacity = 0.8;
            mat.color.setHex(baseColor);
          }
        });
      }
      // Highlight new
      if (axisId) {
        const dir = axisId.includes('-x-') ? 'X' : 'Y';
        const hiColor = dir === 'X' ? RIG_X_COLOR_HI : RIG_Y_COLOR_HI;
        group.children.forEach((child) => {
          if (child.name === `rig-plane-${axisId}`) {
            const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
            mat.opacity = 0.18;
            mat.color.setHex(hiColor);
          }
          if (child.name === `rig-${axisId}`) {
            const mat = (child as THREE.Line).material as THREE.LineDashedMaterial;
            mat.opacity = 1;
            mat.color.setHex(hiColor);
          }
        });
      }
      hoveredAxisRef.current = axisId;
    };

    // ── Raw pointer handlers on canvas (capture phase, fires before camera-controls) ──
    const setupPointerHandlers = (canvas: HTMLCanvasElement) => {

      // ── Shared drag-move / drag-end used by both canvas and label drags ──
      const onDragMove = (e: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;

        const w = screenToWorldXZ(e.clientX, e.clientY);
        if (!w) return;
        const newPosM = drag.dir === 'X' ? w.x : w.z;
        const newPosMm = newPosM * 1000;
        const deltaMm = newPosMm - drag.startPosMm;

        // Update Three.js line + plane + vline positions imperatively
        const line = rigLinesRef.current.get(drag.axisId);
        if (line) {
          updateLinePosition(line, drag.dir, newPosM, boundsRef.current);
        }
        const grp = rigGroupRef.current;
        if (grp) {
          grp.children.forEach((child) => {
            if (child.name === `rig-plane-${drag.axisId}`) {
              if (drag.dir === 'X') child.position.x = newPosM;
              else child.position.z = newPosM;
            }
            if (child.name === `rig-v-${drag.axisId}`) {
              updateVLinePosition(child as THREE.Line, drag.dir, newPosM, boundsRef.current);
            }
          });
        }

        // Drag tooltip near cursor
        const axis = rigAxesRef.current.find((a) => a.id === drag.axisId);
        const containerRect = containerRef.current?.getBoundingClientRect();
        if (containerRect) {
          setDragFeedback({
            axisLabel: axis?.label ?? drag.axisId,
            deltaMm,
            screenX: e.clientX - containerRect.left,
            screenY: e.clientY - containerRect.top,
          });
        }

        onAxisDragRef.current?.(drag.axisId, newPosMm);
      };

      const onDragEnd = (e: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;

        // Always re-enable camera controls
        try { cam.controls.enabled = true; } catch { /* ignore */ }
        canvas.style.cursor = '';
        try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        setAxisHighlight(null);
        setDragFeedback(null);

        // Remove window-level drag listeners
        window.removeEventListener('pointermove', onDragMove);
        window.removeEventListener('pointerup', onDragEnd);

        const axis = rigAxesRef.current.find((a) => a.id === drag.axisId);
        const endPosMm = axis?.positionMm ?? drag.startPosMm;
        onAxisDragEndRef.current?.(drag.axisId, drag.startPosMm, endPosMm);
      };

      // ── Start drag (shared by canvas hit and label click) ──
      const startDrag = (axisId: string, dir: 'X' | 'Y', startPosMm: number, e: PointerEvent) => {
        e.stopPropagation();
        e.preventDefault();
        dragRef.current = { axisId, dir, startPosMm };
        try { cam.controls.enabled = false; } catch { /* ignore */ }
        canvas.style.cursor = 'grabbing';
        setAxisHighlight(axisId);
        onAxisDragStartRef.current?.(axisId);

        // Attach move/up to window so drags work from anywhere (labels or canvas)
        window.addEventListener('pointermove', onDragMove);
        window.addEventListener('pointerup', onDragEnd);
      };

      // Expose startDrag for label bubbles to call
      (containerRef.current as any).__startDrag = startDrag;

      // ── Canvas pointerdown: hit-test against rig lines ──
      const onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (!showRigRef.current || !rigAxesRef.current.length) return;

        const w = screenToWorldXZ(e.clientX, e.clientY);
        if (!w) return;

        const threshold = getHitThreshold();

        for (const axis of rigAxesRef.current) {
          const dist = axis.dir === 'X'
            ? Math.abs(w.x - axis.positionMm * 0.001)
            : Math.abs(w.z - axis.positionMm * 0.001);

          if (dist < threshold) {
            startDrag(axis.id, axis.dir, axis.positionMm, e);
            return;
          }
        }
      };

      // ── Canvas hover: cursor + highlight (non-drag) ──
      const onHover = (e: PointerEvent) => {
        if (dragRef.current) return; // handled by window listener

        // Safety: if camera controls got stuck disabled, re-enable
        if (cam.controls.enabled === false && !dragRef.current) {
          cam.controls.enabled = true;
        }

        if (!showRigRef.current || !rigAxesRef.current.length) {
          canvas.style.cursor = '';
          setAxisHighlight(null);
          return;
        }
        const w = screenToWorldXZ(e.clientX, e.clientY);
        if (!w) { setAxisHighlight(null); return; }

        const threshold = getHitThreshold();
        let foundAxis: string | null = null;
        for (const axis of rigAxesRef.current) {
          const dist = axis.dir === 'X'
            ? Math.abs(w.x - axis.positionMm * 0.001)
            : Math.abs(w.z - axis.positionMm * 0.001);
          if (dist < threshold) {
            canvas.style.cursor = axis.dir === 'X' ? 'ew-resize' : 'ns-resize';
            foundAxis = axis.id;
            break;
          }
        }
        if (!foundAxis) canvas.style.cursor = '';
        setAxisHighlight(foundAxis);
      };

      canvas.addEventListener('pointerdown', onDown, true);  // capture phase
      canvas.addEventListener('pointermove', onHover);

      cleanupRef.current = () => {
        canvas.removeEventListener('pointerdown', onDown, true);
        canvas.removeEventListener('pointermove', onHover);
        // Clean up any dangling window listeners
        window.removeEventListener('pointermove', onDragMove);
        window.removeEventListener('pointerup', onDragEnd);
        // Re-enable camera controls on cleanup
        try { cam.controls.enabled = true; } catch { /* ignore */ }
      };
    };

    // Wait for OBC to create the <canvas> inside the container, then attach handlers
    const waitForCanvas = () => {
      const canvas = container.querySelector('canvas');
      if (canvas) {
        setupPointerHandlers(canvas as HTMLCanvasElement);
      } else {
        requestAnimationFrame(waitForCanvas);
      }
    };
    requestAnimationFrame(waitForCanvas);

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      try { components.dispose(); } catch { /* ignore */ }
      componentsRef.current = null;
      worldRef.current = null;
      ifcLoaderRef.current = null;
      loadedModelRef.current = null;
      rigGroupRef.current = null;
      rigLinesRef.current.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load IFC buffer ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!ifcBuffer) return;
    if (loadingRef.current) return;
    loadingRef.current = true;

    const tryLoad = async () => {
      // Wait for IfcLoader to be ready
      let attempts = 0;
      while (!ifcLoaderRef.current && attempts < 40) {
        await new Promise((r) => setTimeout(r, 250));
        attempts++;
      }
      if (!ifcLoaderRef.current) {
        setStatus('error');
        setErrorMsg('IfcLoader not ready');
        loadingRef.current = false;
        return;
      }

      setStatus('loading');
      setErrorMsg('');

      try {
        // Unload previous model
        const fragments = componentsRef.current?.get(OBC.FragmentsManager);
        if (fragments && loadedModelRef.current) {
          try { fragments.core.dispose(loadedModelRef.current.modelId); } catch { /* ignore */ }
          loadedModelRef.current = null;
        }

        const cam   = worldRef.current?.camera as OBC.OrthoPerspectiveCamera | undefined;
        const model = await ifcLoaderRef.current.load(
          new Uint8Array(ifcBuffer),
          false,
          ifcName.replace(/\.ifc$/i, ''),
        );
        model.graphicsQuality = 1;
        loadedModelRef.current = model;
        setStatus('ready');

        // Compute model bounding box
        const box = model.box;
        if (!box.isEmpty()) {
          const min = box.min;
          const max = box.max;
          boundsRef.current = {
            minX: min.x, maxX: max.x,
            minY: min.y, maxY: max.y,
            minZ: min.z, maxZ: max.z,
          };
          modelBoxRef.current = box.clone();
        }

        // Position camera — initial load in perspective for reliability
        if (cam && modelBoxRef.current) {
          // Apply plan view directly (switches to ortho + top-down)
          await applyPlanView(cam, modelBoxRef.current);

          // Sync persp camera so tile LOD continues to work
          cam.threePersp.position.copy(cam.three.position);
          cam.threePersp.quaternion.copy(cam.three.quaternion);
          cam.threePersp.updateProjectionMatrix();
          model.useCamera(cam.threePersp);
          await fragments!.core.update(true);
        }

        // Notify parent
        if (boundsRef.current) {
          onModelLoadedRef.current?.(
            model,
            fragments!.core as unknown as FRAGS.FragmentsModels,
            componentsRef.current!,
            boundsRef.current,
            worldRef.current!.scene.three,
            (worldRef.current!.renderer as any).three as THREE.WebGLRenderer,
          );
        }
        loadingRef.current = false;
      } catch (err) {
        console.error('[IFCOrthoPlan] load error:', err);
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : String(err));
        loadingRef.current = false;
      }
    };

    void tryLoad();
  }, [ifcBuffer, ifcName]);

  // ── Storey clip planes ──────────────────────────────────────────────────
  useEffect(() => {
    const renderer = worldRef.current?.renderer;
    if (!renderer) return;

    if (clipBottomM != null && clipTopM != null) {
      // Plane(normal, constant): keeps points where normal·p + constant > 0
      const clipBelow = new THREE.Plane(new THREE.Vector3(0, 1, 0), -clipBottomM);
      const clipAbove = new THREE.Plane(new THREE.Vector3(0, -1, 0),  clipTopM);
      renderer.three.clippingPlanes = [clipBelow, clipAbove];
    } else {
      renderer.three.clippingPlanes = [];
    }
  }, [clipBottomM, clipTopM]);

  // ── Update rig axis Three.js lines ──────────────────────────────────────
  useEffect(() => {
    const group = rigGroupRef.current;
    if (!group) return;
    const bounds = boundsRef.current;

    // Clear old lines
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    rigLinesRef.current.clear();

    if (!showRig || !rigAxes.length || !bounds) return;

    const padding = 2; // metres beyond model extent
    const elevY = (bounds.minY + bounds.maxY) / 2;
    const fullHeight = (bounds.maxY - bounds.minY) + padding * 2;
    const halfH = fullHeight / 2;

    for (const axis of rigAxes) {
      const posM  = axis.positionMm * 0.001;
      const color = axis.dir === 'X' ? RIG_X_COLOR : RIG_Y_COLOR;
      const spanX = bounds.maxX - bounds.minX + padding * 2;
      const spanZ = bounds.maxZ - bounds.minZ + padding * 2;

      // ── Translucent plane mesh (visible & draggable in 3D) ──
      let planeW: number, planeH: number;
      if (axis.dir === 'X') {
        planeW = spanZ; planeH = fullHeight;
      } else {
        planeW = spanX; planeH = fullHeight;
      }
      const planeGeo = new THREE.PlaneGeometry(planeW, planeH);
      const planeMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.06,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const planeMesh = new THREE.Mesh(planeGeo, planeMat);
      planeMesh.renderOrder = 998;
      planeMesh.name = `rig-plane-${axis.id}`;

      if (axis.dir === 'X') {
        planeMesh.rotation.y = Math.PI / 2;
        const cz = (bounds.minZ + bounds.maxZ) / 2;
        planeMesh.position.set(posM, elevY, cz);
      } else {
        const cx = (bounds.minX + bounds.maxX) / 2;
        planeMesh.position.set(cx, elevY, posM);
      }
      group.add(planeMesh);

      // ── Dashed line at mid-height (always visible) ──
      let points: THREE.Vector3[];
      if (axis.dir === 'X') {
        points = [
          new THREE.Vector3(posM, elevY + 0.01, bounds.minZ - padding),
          new THREE.Vector3(posM, elevY + 0.01, bounds.maxZ + padding),
        ];
      } else {
        points = [
          new THREE.Vector3(bounds.minX - padding, elevY + 0.01, posM),
          new THREE.Vector3(bounds.maxX + padding, elevY + 0.01, posM),
        ];
      }

      // ── Vertical line edges (visible in 3D) ──
      let vPoints: THREE.Vector3[];
      if (axis.dir === 'X') {
        vPoints = [
          new THREE.Vector3(posM, bounds.minY - padding, bounds.minZ - padding),
          new THREE.Vector3(posM, bounds.maxY + padding, bounds.minZ - padding),
          new THREE.Vector3(posM, bounds.maxY + padding, bounds.maxZ + padding),
          new THREE.Vector3(posM, bounds.minY - padding, bounds.maxZ + padding),
          new THREE.Vector3(posM, bounds.minY - padding, bounds.minZ - padding),
        ];
      } else {
        vPoints = [
          new THREE.Vector3(bounds.minX - padding, bounds.minY - padding, posM),
          new THREE.Vector3(bounds.minX - padding, bounds.maxY + padding, posM),
          new THREE.Vector3(bounds.maxX + padding, bounds.maxY + padding, posM),
          new THREE.Vector3(bounds.maxX + padding, bounds.minY - padding, posM),
          new THREE.Vector3(bounds.minX - padding, bounds.minY - padding, posM),
        ];
      }

      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineDashedMaterial({
        color,
        dashSize:  0.4,
        gapSize:   0.2,
        linewidth: 1,
        depthTest: false,
        transparent: true,
        opacity: 0.8,
      });

      const line = new THREE.Line(geometry, material);
      line.computeLineDistances();
      line.renderOrder = 999;
      line.name = `rig-${axis.id}`;
      line.userData = { axisId: axis.id, dir: axis.dir };
      group.add(line);
      rigLinesRef.current.set(axis.id, line);

      // Vertical outline
      const vGeo = new THREE.BufferGeometry().setFromPoints(vPoints);
      const vMat = new THREE.LineDashedMaterial({
        color,
        dashSize: 0.5,
        gapSize: 0.25,
        linewidth: 1,
        depthTest: false,
        transparent: true,
        opacity: 0.4,
      });
      const vLine = new THREE.Line(vGeo, vMat);
      vLine.computeLineDistances();
      vLine.renderOrder = 998;
      vLine.name = `rig-v-${axis.id}`;
      group.add(vLine);
    }
  }, [rigAxes, showRig]);

  // ── Resize observer ─────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const obs = new ResizeObserver(() => {
      try {
        (worldRef.current?.renderer as OBF.PostproductionRenderer | undefined)?.resize();
      } catch { /* ignore */ }
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, []);

  // ── Fit handler ────────────────────────────────────────────────────────
  const handleFit = async () => {
    const cam = worldRef.current?.camera as OBC.OrthoPerspectiveCamera | undefined;
    const box = modelBoxRef.current;
    if (!cam || !box) return;
    await applyPlanView(cam, box);

    // Sync persp camera for tile LOD
    cam.threePersp.position.copy(cam.three.position);
    cam.threePersp.quaternion.copy(cam.three.quaternion);
    cam.threePersp.updateProjectionMatrix();
    const model = loadedModelRef.current;
    if (model) {
      model.useCamera(cam.threePersp);
      const fragments = componentsRef.current?.get(OBC.FragmentsManager);
      if (fragments) await fragments.core.update(true);
    }
  };

  // ── Status overlay ──────────────────────────────────────────────────────
  const statusLabel = status === 'loading'
    ? 'Se încarcă modelul IFC…'
    : status === 'error'
      ? `Eroare: ${errorMsg}`
      : null;

  return (
    <div className={cn('relative w-full h-full', className)}>
      {/* OBC canvas container — wrapper keeps absolute positioning intact
          because PostproductionRenderer sets inline position:relative on containerRef */}
      <div className="absolute inset-0 overflow-hidden">
        <div ref={containerRef} className="w-full h-full" />
      </div>

      {/* Status overlay */}
      {statusLabel && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10 pointer-events-none">
          <span className="text-sm text-slate-300">{statusLabel}</span>
        </div>
      )}

      {/* Rig axis labels overlay (HTML, projected from world coords) */}
      {showRig && rigAxes.length > 0 && (
        <RigLabelsOverlay
          rigAxes={rigAxes}
          worldRef={worldRef}
          containerRef={containerRef}
        />
      )}

      {/* Fit button */}
      {status === 'ready' && (
        <div className="absolute bottom-3 right-3 z-10">
          <button
            onClick={() => void handleFit()}
            className="px-2.5 py-1 text-xs bg-slate-800/90 text-slate-300 border border-slate-700 rounded-md hover:bg-slate-700 transition-colors font-medium"
            title="Fit model in view"
          >⊞ Fit</button>
        </div>
      )}

      {/* ── Drag tooltip — shows displacement while dragging ── */}
      {dragFeedback && (
        <div
          className="absolute z-30 pointer-events-none"
          style={{
            left: `${dragFeedback.screenX + 16}px`,
            top:  `${dragFeedback.screenY - 12}px`,
          }}
        >
          <div className="bg-slate-900/95 border border-amber-500/40 rounded-md px-2.5 py-1 shadow-lg backdrop-blur-sm">
            <div className="text-[10px] text-slate-400 font-medium">{dragFeedback.axisLabel}</div>
            <div className="text-sm font-mono font-bold tabular-nums" style={{
              color: Math.abs(dragFeedback.deltaMm) < 1 ? '#94a3b8' : dragFeedback.deltaMm > 0 ? '#4ade80' : '#f87171',
            }}>
              {dragFeedback.deltaMm > 0 ? '+' : ''}{formatDimensionDrag(dragFeedback.deltaMm)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helper: switch camera to top-down orthographic and fit model ───────────
async function applyPlanView(cam: OBC.OrthoPerspectiveCamera, modelBox: THREE.Box3) {
  const center = new THREE.Vector3();
  modelBox.getCenter(center);
  const size = new THREE.Vector3();
  modelBox.getSize(size);

  // Position camera directly above model center, looking straight down
  const dist = Math.max(size.x, size.z) * 2 + 50;
  await cam.controls.setLookAt(
    center.x, center.y + dist, center.z,
    center.x, center.y, center.z,
    false,
  );

  // Switch to orthographic projection
  // NOTE: OBC's setOrthoCamera() internally sets wheel=ZOOM and middle=ZOOM
  try { await (cam.projection as any).set('Orthographic'); } catch { /* ignore */ }

  // Lock polar angles AFTER switch so top-down sticks
  cam.controls.minPolarAngle = 0;
  cam.controls.maxPolarAngle = 0.001;

  // Mouse config AFTER projection switch (OBC overrides wheel/middle during switch)
  // ACTION: NONE=0, ROTATE=1, TRUCK=2, DOLLY=16, ZOOM=32
  cam.controls.mouseButtons.left   = 2;  // TRUCK (pan)
  cam.controls.mouseButtons.right  = 2;  // TRUCK (pan)
  cam.controls.mouseButtons.middle = 2;  // TRUCK (pan)
  // For ortho: ZOOM (32) adjusts camera.zoom, works with dollyToCursor
  (cam.controls.mouseButtons as any).wheel = 32; // ZOOM

  cam.controls.dollyToCursor = true;
  cam.controls.dollySpeed    = 1.0;
  cam.controls.truckSpeed    = 2.0;

  // Touch: one finger = pan, two fingers = zoom+pan
  cam.controls.touches.one   = 128 as any;   // TOUCH_TRUCK
  cam.controls.touches.two   = 65536 as any; // TOUCH_ZOOM_TRUCK
  cam.controls.touches.three = 0 as any;     // NONE

  // Fit to flat footprint (XZ only) so zoom is correct for plan
  const PAD = Math.max(size.x, size.z) * 0.05;
  const flatBox = new THREE.Box3(
    new THREE.Vector3(modelBox.min.x - PAD, center.y - 0.1, modelBox.min.z - PAD),
    new THREE.Vector3(modelBox.max.x + PAD, center.y + 0.1, modelBox.max.z + PAD),
  );
  await cam.controls.fitToBox(flatBox, false, {
    paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
  });
}

// ── Helper: update a rig line's position imperatively during drag ──────────
function updateLinePosition(
  line: THREE.Line,
  dir: 'X' | 'Y',
  posM: number,
  bounds: BrepBbox | null,
) {
  if (!bounds) return;
  const padding = 2;
  const elevY = (bounds.minY + bounds.maxY) / 2;
  const positions = line.geometry.attributes.position;
  if (!positions) return;

  if (dir === 'X') {
    positions.setXYZ(0, posM, elevY + 0.01, bounds.minZ - padding);
    positions.setXYZ(1, posM, elevY + 0.01, bounds.maxZ + padding);
  } else {
    positions.setXYZ(0, bounds.minX - padding, elevY + 0.01, posM);
    positions.setXYZ(1, bounds.maxX + padding, elevY + 0.01, posM);
  }
  positions.needsUpdate = true;
  line.computeLineDistances();
}

// ── Helper: update vertical outline line position during drag ──────────────
function updateVLinePosition(
  line: THREE.Line,
  dir: 'X' | 'Y',
  posM: number,
  bounds: BrepBbox | null,
) {
  if (!bounds) return;
  const padding = 2;
  const positions = line.geometry.attributes.position;
  if (!positions) return;

  if (dir === 'X') {
    // 5 points: bottom-near, top-near, top-far, bottom-far, bottom-near
    positions.setXYZ(0, posM, bounds.minY - padding, bounds.minZ - padding);
    positions.setXYZ(1, posM, bounds.maxY + padding, bounds.minZ - padding);
    positions.setXYZ(2, posM, bounds.maxY + padding, bounds.maxZ + padding);
    positions.setXYZ(3, posM, bounds.minY - padding, bounds.maxZ + padding);
    positions.setXYZ(4, posM, bounds.minY - padding, bounds.minZ - padding);
  } else {
    positions.setXYZ(0, bounds.minX - padding, bounds.minY - padding, posM);
    positions.setXYZ(1, bounds.minX - padding, bounds.maxY + padding, posM);
    positions.setXYZ(2, bounds.maxX + padding, bounds.maxY + padding, posM);
    positions.setXYZ(3, bounds.maxX + padding, bounds.minY - padding, posM);
    positions.setXYZ(4, bounds.minX - padding, bounds.minY - padding, posM);
  }
  positions.needsUpdate = true;
  line.computeLineDistances();
}

// ── Rig axis HTML label overlay — AutoCAD-style axis markers & dimensions ──
function RigLabelsOverlay({
  rigAxes,
  worldRef,
  containerRef,
}: {
  rigAxes:      RigAxis[];
  worldRef:     React.RefObject<OBC.World | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [labels, setLabels] = useState<Array<{
    id: string; label: string; dir: 'X' | 'Y';
    x: number; y: number; posMm: number; originMm: number;
  }>>([]);

  useEffect(() => {
    let running = true;

    const updateLabels = () => {
      if (!running) return;

      const cam = worldRef.current?.camera as OBC.OrthoPerspectiveCamera | undefined;
      const container = containerRef.current;
      if (!cam || !container) {
        requestAnimationFrame(updateLabels);
        return;
      }

      const rect = container.getBoundingClientRect();
      const threeCam = cam.three;

      const newLabels = rigAxes.map((axis) => {
        const posM = axis.positionMm * 0.001;
        const worldPt = axis.dir === 'X'
          ? new THREE.Vector3(posM, 0, 0)
          : new THREE.Vector3(0, 0, posM);

        const ndc = worldPt.project(threeCam);
        const screenX = (ndc.x * 0.5 + 0.5) * rect.width;
        const screenY = (-ndc.y * 0.5 + 0.5) * rect.height;

        return {
          id:       axis.id,
          label:    axis.label,
          dir:      axis.dir,
          x:        screenX,
          y:        screenY,
          posMm:    axis.positionMm,
          originMm: axis.originMm,
        };
      });

      setLabels(newLabels);
      requestAnimationFrame(updateLabels);
    };

    requestAnimationFrame(updateLabels);
    return () => { running = false; };
  }, [rigAxes, worldRef, containerRef]);

  // ── Start drag from label bubble ──
  const handleBubblePointerDown = (axis: RigAxis, e: React.PointerEvent) => {
    const startDrag = (containerRef.current as any)?.__startDrag;
    if (startDrag) {
      startDrag(axis.id, axis.dir, axis.positionMm, e.nativeEvent);
    }
  };

  // Separate and sort X/Y axes for dimension annotations
  const xLabels = labels.filter((l) => l.dir === 'X').sort((a, b) => a.x - b.x);
  const yLabels = labels.filter((l) => l.dir === 'Y').sort((a, b) => a.y - b.y);

  const GUTTER = 36;

  return (
    <div className="absolute inset-0 pointer-events-none z-20" style={{ overflow: 'clip' }}>

      {/* ── Top gutter — X axis bubbles ── */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center"
        style={{ height: `${GUTTER}px`, background: 'linear-gradient(to bottom, rgba(15,23,42,0.95), rgba(15,23,42,0))' }}
      >
        {xLabels.map((l) => {
          const delta = l.posMm - l.originMm;
          const hasMoved = Math.abs(delta) > 0.5;
          const axisData = rigAxes.find((a) => a.id === l.id);
          return (
            <div
              key={l.id}
              className="absolute flex flex-col items-center pointer-events-auto"
              style={{
                left: `${l.x}px`, top: '3px', transform: 'translateX(-50%)',
                cursor: 'ew-resize',
              }}
              onPointerDown={axisData ? (e) => handleBubblePointerDown(axisData, e) : undefined}
            >
              <div
                className="flex items-center justify-center rounded-full border-2 font-bold text-[11px] leading-none select-none"
                style={{
                  width: 26, height: 26,
                  borderColor: hasMoved ? '#fbbf24' : '#f97316',
                  backgroundColor: hasMoved ? 'rgba(251,191,36,0.15)' : 'rgba(249,115,22,0.12)',
                  color: hasMoved ? '#fbbf24' : '#fb923c',
                }}
              >
                {l.label}
              </div>
              {hasMoved && (
                <span
                  className="text-[9px] font-mono mt-0.5 px-1 rounded select-none"
                  style={{ color: '#fbbf24', background: 'rgba(0,0,0,0.6)' }}
                >
                  {delta > 0 ? '+' : ''}{Math.round(delta)}
                </span>
              )}
            </div>
          );
        })}

        {/* ── X dimension annotations ── */}
        {xLabels.map((l, i) => {
          if (i === 0) return null;
          const prev = xLabels[i - 1];
          const distMm = Math.abs(l.posMm - prev.posMm);
          const gap = l.x - prev.x;
          if (gap < 40) return null;
          return (
            <div
              key={`dim-x-${i}`}
              className="absolute flex items-center"
              style={{
                left: `${prev.x + 13}px`,
                width: `${gap - 26}px`,
                top: '12px',
              }}
            >
              <div className="flex-1 h-px bg-slate-500/50 relative">
                <div className="absolute left-0 -top-[3px] w-px h-[7px] bg-slate-500/50" />
                <div className="absolute right-0 -top-[3px] w-px h-[7px] bg-slate-500/50" />
              </div>
              <span
                className="absolute text-[9px] font-mono text-slate-400 whitespace-nowrap"
                style={{
                  left: '50%',
                  transform: 'translateX(-50%)',
                  top: '-10px',
                  background: 'rgba(15,23,42,0.9)',
                  padding: '0 3px',
                }}
              >
                {formatDimension(distMm)}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Left gutter — Y axis bubbles ── */}
      <div
        className="absolute top-0 left-0 bottom-0 flex flex-col items-center"
        style={{ width: `${GUTTER}px`, background: 'linear-gradient(to right, rgba(15,23,42,0.95), rgba(15,23,42,0))' }}
      >
        {yLabels.map((l) => {
          const delta = l.posMm - l.originMm;
          const hasMoved = Math.abs(delta) > 0.5;
          const axisData = rigAxes.find((a) => a.id === l.id);
          return (
            <div
              key={l.id}
              className="absolute flex items-center gap-1 pointer-events-auto"
              style={{
                top: `${l.y}px`, left: '3px', transform: 'translateY(-50%)',
                cursor: 'ns-resize',
              }}
              onPointerDown={axisData ? (e) => handleBubblePointerDown(axisData, e) : undefined}
            >
              <div
                className="flex items-center justify-center rounded-full border-2 font-bold text-[11px] leading-none select-none"
                style={{
                  width: 26, height: 26,
                  borderColor: hasMoved ? '#fbbf24' : '#a855f7',
                  backgroundColor: hasMoved ? 'rgba(251,191,36,0.15)' : 'rgba(168,85,247,0.12)',
                  color: hasMoved ? '#fbbf24' : '#c084fc',
                }}
              >
                {l.label}
              </div>
              {hasMoved && (
                <span
                  className="text-[9px] font-mono px-1 rounded select-none"
                  style={{ color: '#fbbf24', background: 'rgba(0,0,0,0.6)' }}
                >
                  {delta > 0 ? '+' : ''}{Math.round(delta)}
                </span>
              )}
            </div>
          );
        })}

        {/* ── Y dimension annotations ── */}
        {yLabels.map((l, i) => {
          if (i === 0) return null;
          const prev = yLabels[i - 1];
          const distMm = Math.abs(l.posMm - prev.posMm);
          const gap = l.y - prev.y;
          if (gap < 30) return null;
          return (
            <div
              key={`dim-y-${i}`}
              className="absolute flex flex-col items-center"
              style={{
                top: `${prev.y + 13}px`,
                height: `${gap - 26}px`,
                left: '14px',
              }}
            >
              <div className="flex-1 w-px bg-slate-500/50 relative">
                <div className="absolute top-0 -left-[3px] h-px w-[7px] bg-slate-500/50" />
                <div className="absolute bottom-0 -left-[3px] h-px w-[7px] bg-slate-500/50" />
              </div>
              <span
                className="absolute text-[9px] font-mono text-slate-400 whitespace-nowrap"
                style={{
                  top: '50%',
                  transform: 'translateY(-50%) rotate(-90deg)',
                  left: '-16px',
                  background: 'rgba(15,23,42,0.9)',
                  padding: '0 3px',
                }}
              >
                {formatDimension(distMm)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Format mm as human-readable dimension: >1m → "X.XXm", else "XXXmm" */
function formatDimension(mm: number): string {
  const abs = Math.abs(mm);
  if (abs >= 1000) return `${(mm / 1000).toFixed(2)}m`;
  return `${Math.round(mm)}mm`;
}

/** Format drag delta for tooltip: shows mm with 1 decimal if under 100mm, else rounded */
function formatDimensionDrag(mm: number): string {
  const abs = Math.abs(mm);
  if (abs >= 1000) return `${(mm / 1000).toFixed(3)}m`;
  if (abs >= 100) return `${Math.round(mm)}mm`;
  return `${mm.toFixed(1)}mm`;
}
