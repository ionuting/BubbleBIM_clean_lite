/**
 * ElevationOrthoViewer — OBC-based orthographic viewer for BIM elevation facades.
 *
 * Uses @thatopen/components (OBC) world with OrthoPerspectiveCamera in orthographic mode.
 * Geometry via buildSceneGeometry, camera locked perpendicular to facade (N/S/E/W).
 *
 * Features:
 *   - OBC world with OrthoPerspectiveCamera (orthographic projection)
 *   - Camera auto-positioned per facade direction
 *   - Render modes: colored / technical / wireframe
 *   - TechnicalDrawings: interactive linear dimensions
 *   - VisibilityFilter per element type
 */

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as OBF from '@thatopen/components-front';
import { cn } from '@/lib/utils';
import { AnnotationsToolbar, type AnnotationTool } from './AnnotationsToolbar';
import { VisibilityFilter } from '@/components/views/VisibilityFilter';
import { RenderModeSelector, type RenderMode } from '@/components/views/RenderModeSelector';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { resolveVisuals, type MaterialConfig } from '@/lib/materialConfig';
import { buildSceneGeometry } from './WebIfcViewer';
import type { ElevationDir } from './TechnicalDrawingsViewer';
import {
  loadIfcParts, buildIfcGroup, collectIfcLibraryPaths,
  type IFCGroupInfo,
} from '@/lib/ifcLibraryLoader';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ElevationOrthoViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  viewDirection?: ElevationDir;
  startElevation?: number;
  endElevation?: number;
  className?: string;
  /** When true, hide all toolbars/overlays (for sheet composer embedding) */
  embedded?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a hex/THREE.Color value to a grayscale THREE.Color (luminance). */
function toGray(c: THREE.ColorRepresentation): THREE.Color {
  const col = new THREE.Color(c);
  const L = 0.299 * col.r + 0.587 * col.g + 0.114 * col.b;
  return new THREE.Color(L, L, L);
}

function applyRenderMode(
  scene: THREE.Scene,
  mode: RenderMode,
  matConfig: MaterialConfig | null,
  hiddenTypes: Set<string>,
): void {
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const nt = obj.userData.nodeType as string | undefined;
    if (!nt) return;
    if (!obj.userData._origMat) obj.userData._origMat = obj.material;
    const origMat = obj.userData._origMat as THREE.Material;
    const vis = resolveVisuals(nt, '', matConfig);
    const isInstanced = (obj as THREE.InstancedMesh).isInstancedMesh;

    // Sync cached edge-lines: only visible in wireframe mode
    if (obj.userData._edgeLines) {
      (obj.userData._edgeLines as THREE.LineSegments).visible =
        mode === 'wireframe' && !hiddenTypes.has(nt);
    }

    switch (mode) {
      case 'colored':
        obj.material = origMat;
        break;

      case 'technical': {
        // Same structure as colored but grayscale (luminance)
        obj.material = new THREE.MeshBasicMaterial({
          color: toGray(vis.color_2d),
          transparent: vis.opacity_2d < 1,
          opacity: vis.opacity_2d,
          side: THREE.DoubleSide,
        });
        break;
      }

      case 'wireframe': {
        if (!isInstanced) {
          // Transparent fill — only 12-edge bounding-box silhouette is drawn
          obj.material = new THREE.MeshBasicMaterial({
            transparent: true, opacity: 0, depthWrite: false,
          });
          if (!obj.userData._edgeLines) {
            if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
            const bb   = obj.geometry.boundingBox!;
            const dims = bb.getSize(new THREE.Vector3());
            const cent = bb.getCenter(new THREE.Vector3());
            const boxGeo  = new THREE.BoxGeometry(dims.x, dims.y, dims.z);
            const edgeGeo = new THREE.EdgesGeometry(boxGeo);
            boxGeo.dispose();
            const edgeColor = new THREE.Color(vis.color_2d).multiplyScalar(0.65);
            const edgeLines = new THREE.LineSegments(
              edgeGeo,
              new THREE.LineBasicMaterial({ color: edgeColor }),
            );
            edgeLines.position.copy(cent);
            edgeLines.userData._isEdgeHelper = true;
            obj.userData._edgeLines = edgeLines;
            obj.add(edgeLines);
          }
          (obj.userData._edgeLines as THREE.LineSegments).visible = !hiddenTypes.has(nt);
        } else {
          const edgeColor = new THREE.Color(vis.color_2d).multiplyScalar(0.65);
          obj.material = new THREE.MeshBasicMaterial({
            color: edgeColor, wireframe: true, transparent: true, opacity: 0.4,
          });
        }
        break;
      }
    }

    if (nt) obj.visible = !hiddenTypes.has(nt);
  });
}

/** Compute camera position and target for a given elevation direction. */
function getCamPosForDir(dir: ElevationDir, box: THREE.Box3): { pos: THREE.Vector3; target: THREE.Vector3 } {
  const center = new THREE.Vector3();
  box.getCenter(center);
  const size = box.getSize(new THREE.Vector3());
  const diag = Math.sqrt(size.x ** 2 + size.y ** 2 + size.z ** 2);
  const camDist = diag * 3 + 50;

  switch (dir) {
    case 'N': return { pos: new THREE.Vector3(center.x, center.y, box.min.z - camDist), target: center.clone() };
    case 'S': return { pos: new THREE.Vector3(center.x, center.y, box.max.z + camDist), target: center.clone() };
    case 'E': return { pos: new THREE.Vector3(box.max.x + camDist, center.y, center.z), target: center.clone() };
    case 'W': return { pos: new THREE.Vector3(box.min.x - camDist, center.y, center.z), target: center.clone() };
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ElevationOrthoViewer({
  nodes,
  edges,
  viewDirection = 'W',
  startElevation: _se,
  endElevation: _ee,
  className,
  embedded = false,
}: ElevationOrthoViewerProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const componentsRef = useRef<OBC.Components | null>(null);
  const worldRef      = useRef<OBC.World | null>(null);
  const boxRef        = useRef<THREE.Box3 | null>(null);
  const techDrawRef   = useRef<OBC.TechnicalDrawings | null>(null);
  const editorRef     = useRef<OBF.DrawingEditor | null>(null);
  const drawingRef    = useRef<any>(null);

  const [isReady, setIsReady] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set(['room']));
  const [renderMode, setRenderMode] = useState<RenderMode>('colored');
  const [activeTool, setActiveTool] = useState<AnnotationTool | null>(null);

  const { config: matConfig } = useMaterialConfig();

  const { visibleTypes, typeCounts } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
    if (!counts['storey'] && nodes.some((nd) => nd.type === 'storey'))
      counts['storey'] = nodes.filter((nd) => nd.type === 'storey').length;
    if (!counts['column']) {
      const c = nodes.filter((nd) => nd.type === 'ax' && String(nd.properties.has_column ?? '').toLowerCase() === 'true').length;
      if (c > 0) counts['column'] = c;
    }
    if (!counts['beam']) {
      const c = nodes.filter((nd) => nd.type === 'wall' && String(nd.properties.has_beam ?? '').toLowerCase() === 'true').length;
      if (c > 0) counts['beam'] = c;
    }
    if (!counts['covering']) {
      const c = nodes.filter((nd) => nd.type === 'room' && nd.properties.has_covering !== 'False' && nd.properties.has_covering !== false).length;
      if (c > 0) counts['covering'] = c;
    }
    return { visibleTypes: Object.keys(counts), typeCounts: counts };
  }, [nodes]);

  // ── OBC World Init ────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const components = new OBC.Components();
    componentsRef.current = components;

    const worlds = components.get(OBC.Worlds);
    const world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();
    world.name = 'ElevationView';
    world.scene = new OBC.SimpleScene(components);
    world.renderer = new OBC.SimpleRenderer(components, container);
    world.camera = new OBC.OrthoPerspectiveCamera(components);

    const cam = world.camera as OBC.OrthoPerspectiveCamera;
    cam.projection.set('Orthographic');

    // Lock rotation — orthographic elevation view, rotation is meaningless
    cam.controls.azimuthRotateSpeed = 0;
    cam.controls.polarRotateSpeed = 0;

    // In embedded mode (sheet composer), disable all user interaction
    if (embedded) {
      cam.controls.enabled = false;
    }

    world.scene.setup();
    world.scene.three.background = new THREE.Color(0xf0f0ec);

    // Lighting
    const scene = world.scene.three as THREE.Scene;
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const frontLight = new THREE.DirectionalLight(0xffffff, 0.8);
    frontLight.position.set(5, 15, 10);
    frontLight.castShadow = true;
    scene.add(frontLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
    fillLight.position.set(-8, 4, -6);
    scene.add(fillLight);

    components.init();

    // ── TechnicalDrawings + DrawingEditor ───────────────────────────────────
    const techDrawings = components.get(OBC.TechnicalDrawings);
    const drawing = techDrawings.create(world);
    drawing.orientTo(new THREE.Vector3(-1, 0, 0)); // default W elevation
    techDrawRef.current = techDrawings;
    drawingRef.current  = drawing;

    const editor = components.get(OBF.DrawingEditor);
    editor.enabled = true;
    editor.setSource(world);
    editor.fonts
      .load('/fonts/kenpixel.ttf')
      .catch(() => {});

    // Create all tools BEFORE setting activeDrawing so they receive the onDrawingChange notification
    const linearTool  = editor.use(OBF.LinearAnnotationsTool);
    const angleTool   = editor.use(OBF.AngleAnnotationsTool);
    const calloutTool = editor.use(OBF.CalloutAnnotationsTool);
    const leaderTool  = editor.use(OBF.LeaderAnnotationsTool);
    const slopeTool   = editor.use(OBF.SlopeAnnotationsTool);

    (calloutTool as any).onEnterText?.add?.(({ isEdit, currentText }: any) => {
      const text = window.prompt(isEdit ? 'Edit text:' : 'Callout text:', currentText ?? '') ?? currentText ?? '';
      (calloutTool as any).submitText(text);
    });

    const DIM_STYLE = {
      color: 0x1565c0, fontSize: 0.25, textOffset: 0.35, tickSize: 0.2,
      extensionGap: 0.04, extensionOvershoot: 0.15,
      unit: OBC.Units.m, lineTick: OBC.DiagonalTick, meshTick: OBC.FilledArrowTick,
    };
    for (const tool of [linearTool, angleTool, leaderTool, slopeTool] as any[]) {
      tool?.system?.styles?.set('default', DIM_STYLE);
    }
    (calloutTool as any)?.system?.styles?.set('default', {
      ...DIM_STYLE, enclosure: OBC.CloudEnclosure,
    });

    // Set activeDrawing AFTER tools exist — setter notifies tools via onDrawingChange
    editor.activeDrawing = drawing;
    editorRef.current = editor;

    // Resize
    const onResize = () => {
      world.renderer?.resize();
      cam.updateAspect();
    };
    window.addEventListener('resize', onResize);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { editorRef.current?.cancel(); setActiveTool(null); }
    };
    window.addEventListener('keydown', onKeyDown);

    // DrawingEditor requires explicit step() on click to place points
    const canvas = world.renderer.three.domElement;
    const onCanvasClick = () => { editorRef.current?.step(); };
    canvas.addEventListener('click', onCanvasClick);

    worldRef.current = world;
    setIsReady(true);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('click', onCanvasClick);
      components.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Wire activeTool → DrawingEditor ───────────────────────────────────────
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !isReady) return;
    const TOOL_MAP: Record<AnnotationTool, any> = {
      linear:  OBF.LinearAnnotationsTool,
      angle:   OBF.AngleAnnotationsTool,
      callout: OBF.CalloutAnnotationsTool,
      leader:  OBF.LeaderAnnotationsTool,
      slope:   OBF.SlopeAnnotationsTool,
    };
    editor.activeTool = activeTool ? TOOL_MAP[activeTool] : null;
  }, [activeTool, isReady]);

  // ── Re-orient drawing when view direction changes ─────────────────────
  useEffect(() => {
    const drawing = drawingRef.current;
    if (!drawing || !isReady) return;
    const NORMALS: Record<ElevationDir, THREE.Vector3> = {
      N: new THREE.Vector3(0, 0, -1),
      S: new THREE.Vector3(0, 0,  1),
      E: new THREE.Vector3(1, 0,  0),
      W: new THREE.Vector3(-1, 0, 0),
    };
    drawing.orientTo(NORMALS[viewDirection]);
  }, [viewDirection, isReady]);

  // ── Apply visibility ──────────────────────────────────────────────────────
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !isReady) return;
    let scene: THREE.Scene | null = null;
    try { scene = world.scene.three as THREE.Scene; } catch { return; }
    scene.traverse((obj) => {
      const t = obj.userData.nodeType as string | undefined;
      if (t) obj.visible = !hiddenTypes.has(t);
    });
  }, [hiddenTypes, isReady]);

  // ── Render mode ───────────────────────────────────────────────────────────
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !isReady) return;
    let scene: THREE.Scene | null = null;
    try { scene = world.scene.three as THREE.Scene; } catch { return; }
    applyRenderMode(scene, renderMode, matConfig, hiddenTypes);
  }, [renderMode, isReady, matConfig, hiddenTypes]);

  // ── Rebuild geometry ──────────────────────────────────────────────────────
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !isReady) return;
    let scene: THREE.Scene | null = null;
    try { scene = world.scene.three as THREE.Scene; } catch { return; }
    const cam = world.camera as OBC.OrthoPerspectiveCamera;

    let cancelled = false;
    (async () => {
      const ifcGroupCache = new Map<string, IFCGroupInfo>();
      const paths = collectIfcLibraryPaths(nodes);
      await Promise.all(
        paths.map(async (lp) => {
          try {
            const parts = await loadIfcParts(lp);
            if (!cancelled) ifcGroupCache.set(lp, buildIfcGroup(parts));
          } catch { /* ignore */ }
        }),
      );
      if (cancelled) return;

      // Remove old geometry (keep lights)
      const toRemove: THREE.Object3D[] = [];
      scene!.traverse((c) => { if (!(c instanceof THREE.Light) && c !== scene && c.parent === scene) toRemove.push(c); });
      toRemove.forEach((c) => scene!.remove(c));

      // Build geometry
      buildSceneGeometry(scene!, nodes, edges, ifcGroupCache, matConfig);

      // Apply visibility + render mode
      scene!.traverse((obj) => {
        const t = obj.userData.nodeType as string | undefined;
        if (t) obj.visible = !hiddenTypes.has(t);
      });
      applyRenderMode(scene!, renderMode, matConfig, hiddenTypes);

      // Compute bounding box and fit camera
      const box = new THREE.Box3();
      scene!.traverse((c) => {
        if ((c instanceof THREE.Mesh || c instanceof THREE.Line) && c.visible) {
          box.expandByObject(c);
        }
      });
      if (!box.isEmpty()) {
        boxRef.current = box;
        const { pos, target } = getCamPosForDir(viewDirection, box);
        cam.controls.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, false);
        cam.controls.fitToBox(box, false, { paddingTop: 0.5, paddingBottom: 0.5, paddingLeft: 0.5, paddingRight: 0.5 });
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, isReady, matConfig, hiddenTypes]);

  // ── Re-aim camera when viewDirection changes ──────────────────────────────
  useEffect(() => {
    const world = worldRef.current;
    const box = boxRef.current;
    if (!world || !box || !isReady) return;
    const cam = world.camera as OBC.OrthoPerspectiveCamera;
    const { pos, target } = getCamPosForDir(viewDirection, box);
    cam.controls.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, true);
    cam.controls.fitToBox(box, true, { paddingTop: 0.5, paddingBottom: 0.5, paddingLeft: 0.5, paddingRight: 0.5 });
  }, [viewDirection, isReady]);

  // ── Clear all annotations ─────────────────────────────────────────────────
  const clearAll = useCallback(() => {
    const comps = componentsRef.current;
    const drawing = drawingRef.current;
    if (!comps || !drawing) return;
    try {
      const td = comps.get(OBC.TechnicalDrawings);
      for (const Sys of [OBC.LinearAnnotations, OBC.AngleAnnotations,
          OBC.CalloutAnnotations, OBC.LeaderAnnotations, OBC.SlopeAnnotations] as any[]) {
        td.use(Sys)?.clear?.([drawing]);
      }
    } catch { /* */ }
    setActiveTool(null);
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn('w-full h-full relative select-none', className)}
    >
      {!isReady && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 bg-[#f0f0ec]">
          Loading elevation…
        </div>
      )}
      {isReady && !embedded && (
        <>
          <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
            <RenderModeSelector mode={renderMode} onChange={setRenderMode} className="relative !top-0 !left-0 !absolute-none" />
            <AnnotationsToolbar
              activeTool={activeTool}
              onToolChange={setActiveTool}
              onClearAll={clearAll}
            />
          </div>
          <VisibilityFilter
            types={visibleTypes}
            hiddenTypes={hiddenTypes}
            onChange={setHiddenTypes}
            counts={typeCounts}
          />
        </>
      )}
    </div>
  );
}
