/**
 * SectionOrthoViewer — OBC-based orthographic viewer for BIM vertical section cuts.
 *
 * Uses @thatopen/components (OBC) world with OrthoPerspectiveCamera in orthographic mode.
 * Geometry via buildSceneGeometry, clipping via THREE.Plane.
 *
 * Features:
 *   - OBC world with OrthoPerspectiveCamera (orthographic projection)
 *   - Section clipping plane at cutY (BIM Y mm → Three.js -Z)
 *   - Back wall at cutDepth
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
import {
  loadIfcParts, buildIfcGroup, collectIfcLibraryPaths,
  type IFCGroupInfo,
} from '@/lib/ifcLibraryLoader';

const MM = 0.001; // mm → metres

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SectionOrthoViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  cutY?: number;
  cutDepth?: number;
  startElevation?: number;
  endElevation?: number;
  flipped?: boolean;
  sectionNodeId?: string;
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
    // Skip section-fill overlays — they have fillNodeType, not nodeType
    if (obj.userData.isSectionFill) return;
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
        // Same shape as colored but converted to grayscale
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
          // Transparent fill — only the bounding-box silhouette edges are visible
          obj.material = new THREE.MeshBasicMaterial({
            transparent: true, opacity: 0, depthWrite: false,
          });
          if (!obj.userData._edgeLines) {
            // Build EdgeGeometry from the AABB box — 12 clean lines, zero triangulation
            if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
            const bb = obj.geometry.boundingBox!;
            const dims = bb.getSize(new THREE.Vector3());
            const cent = bb.getCenter(new THREE.Vector3());
            const boxGeo = new THREE.BoxGeometry(dims.x, dims.y, dims.z);
            const edgeGeo = new THREE.EdgesGeometry(boxGeo);
            boxGeo.dispose();
            const edgeColor = new THREE.Color(vis.color_2d).multiplyScalar(0.65);
            const edgeLines = new THREE.LineSegments(
              edgeGeo,
              new THREE.LineBasicMaterial({ color: edgeColor }),
            );
            edgeLines.position.copy(cent); // offset to match bbox center in local space
            edgeLines.userData._isEdgeHelper = true;
            obj.userData._edgeLines = edgeLines;
            obj.add(edgeLines);
          }
          (obj.userData._edgeLines as THREE.LineSegments).visible = !hiddenTypes.has(nt);
        } else {
          // InstancedMesh (columns): tinted box wireframe fallback
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

// ─── Section Fills ──────────────────────────────────────────────────────────
//
// Strategy: for every structural element whose world-space bounding box straddles
// the cut plane (z spans cutZm), place a flat PlaneGeometry quad at z = cutZm+ε.
// depthTest:false + high renderOrder guarantee the fill is always visible.
// The quad uses the element's XY bounding extents, giving the exact cross-section
// shape for axis-aligned elements (walls, columns, beams, slabs).

// Structural elements: use AABB-based fills (axis-aligned boxes — AABB is exact).
const FILL_TYPES = new Set(['wall', 'beam', 'column', 'slab', 'foundation']);
// Ring elements: hollow polygon extrusions. Their AABB is the whole building footprint
// so we use per-segment polygon intersection fills instead.
const RING_FILL_TYPES = new Set(['shell', 'covering']);

function buildSectionFills(
  scene: THREE.Scene,
  _clipPlane: THREE.Plane,
  flipped: boolean,
  cutZm: number,
  matConfig: MaterialConfig | null,
): void {
  const old = scene.getObjectByName('__section_fills__');
  if (old) scene.remove(old);

  const fillGroup = new THREE.Group();
  fillGroup.name = '__section_fills__';

  // Place fills just in front of the cut plane (toward the camera)
  const fillZ = cutZm + (!flipped ? 0.025 : -0.025);

  const tempMat4 = new THREE.Matrix4();
  const tempBox  = new THREE.Box3();

  const addFillForBox = (worldBox: THREE.Box3, nt: string) => {
    if (worldBox.isEmpty()) return;
    if (worldBox.min.z >= cutZm + 0.001 || worldBox.max.z <= cutZm - 0.001) return;

    const zExt = worldBox.max.z - worldBox.min.z;
    if (zExt < 0.05) return;

    const w  = Math.max(worldBox.max.x - worldBox.min.x, 0.01);
    const h  = Math.max(worldBox.max.y - worldBox.min.y, 0.01);

    // Skip elements running parallel to the section plane
    if (zExt < w * 0.1) return;

    const cx = (worldBox.min.x + worldBox.max.x) / 2;
    const cy = (worldBox.min.y + worldBox.max.y) / 2;

    const vis = resolveVisuals(nt, '', matConfig);
    const fillColor = new THREE.Color(vis.color_3d ?? '#aaaaaa');
    const planeGeo = new THREE.PlaneGeometry(w, h);

    const fillMesh = new THREE.Mesh(
      planeGeo,
      new THREE.MeshBasicMaterial({
        color: fillColor,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    fillMesh.position.set(cx, cy, fillZ);
    fillMesh.renderOrder = 10;
    fillMesh.userData.isSectionFill = true;
    fillMesh.userData.fillNodeType  = nt;
    fillGroup.add(fillMesh);

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(planeGeo),
      new THREE.LineBasicMaterial({ color: 0x111111, depthTest: false }),
    );
    outline.position.set(cx, cy, fillZ + 0.002);
    outline.renderOrder = 11;
    outline.userData.isSectionFill = true;
    outline.userData.fillNodeType  = nt;
    fillGroup.add(outline);
  };

  scene.traverse((obj) => {
    if (obj.userData.isBackWall || obj.userData.isSectionFill) return;
    if (!obj.visible) return;
    const nt = obj.userData.nodeType as string | undefined;
    if (!nt) return;

    if (FILL_TYPES.has(nt)) {
      // ── Structural elements: AABB fills (axis-aligned boxes) ──
      if ((obj as THREE.InstancedMesh).isInstancedMesh) {
        const im = obj as THREE.InstancedMesh;
        if (!im.geometry.boundingBox) im.geometry.computeBoundingBox();
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, tempMat4);
          const worldMat = tempMat4.clone().premultiply(im.matrixWorld);
          tempBox.copy(im.geometry.boundingBox!).applyMatrix4(worldMat);
          addFillForBox(tempBox.clone(), nt);
        }
      } else if (obj instanceof THREE.Mesh) {
        if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
        tempBox.copy(obj.geometry.boundingBox!).applyMatrix4(obj.matrixWorld);
        addFillForBox(tempBox.clone(), nt);
      }
      return;
    }

    if (RING_FILL_TYPES.has(nt) && obj instanceof THREE.Mesh) {
      // ── Ring elements: per-segment polygon fills ──
      // For each wall segment of the outer/inner polygon pair that straddles
      // the cut plane, generate a fill rectangle = segment_thickness × ring_height.
      const outer = obj.userData.ringPolyOuter as Array<{ x: number; y: number }> | undefined;
      const inner = obj.userData.ringPolyInner as Array<{ x: number; y: number }> | undefined;
      const botM   = obj.userData.ringBotM    as number | undefined;
      const heightM = obj.userData.ringHeightM as number | undefined;
      if (!outer || !inner || botM === undefined || !heightM) return;

      const segCount = Math.min(outer.length, inner.length);
      const vis       = resolveVisuals(nt, '', matConfig);
      const fillColor = new THREE.Color(vis.color_3d ?? '#aaaaaa');
      const fillCy    = botM + heightM / 2;

      for (let si = 0; si < segCount; si++) {
        const o1 = outer[si],              o2 = outer[(si + 1) % segCount];
        const i1 = inner[si],              i2 = inner[(si + 1) % segCount];

        // Three.js Z = -BIM_Y * MM
        const zo1 = -o1.y * MM, zo2 = -o2.y * MM;
        const zi1 = -i1.y * MM, zi2 = -i2.y * MM;

        const outerCrosses = (zo1 <= cutZm) !== (zo2 <= cutZm);
        const innerCrosses = (zi1 <= cutZm) !== (zi2 <= cutZm);
        if (!outerCrosses || !innerCrosses) continue;

        const tO  = (cutZm - zo1) / (zo2 - zo1);
        const xO  = (o1.x + tO  * (o2.x - o1.x)) * MM;

        const tI  = (cutZm - zi1) / (zi2 - zi1);
        const xI  = (i1.x + tI  * (i2.x - i1.x)) * MM;

        const fillW = Math.abs(xO - xI);
        if (fillW < 0.001) continue;

        const fillCx  = (xO + xI) / 2;
        const planeGeo = new THREE.PlaneGeometry(fillW, heightM);

        const fillMesh = new THREE.Mesh(
          planeGeo,
          new THREE.MeshBasicMaterial({
            color: fillColor, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
          }),
        );
        fillMesh.position.set(fillCx, fillCy, fillZ);
        fillMesh.renderOrder = 10;
        fillMesh.userData.isSectionFill = true;
        fillMesh.userData.fillNodeType  = nt;
        fillGroup.add(fillMesh);

        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(planeGeo),
          new THREE.LineBasicMaterial({ color: 0x111111, depthTest: false }),
        );
        outline.position.set(fillCx, fillCy, fillZ + 0.002);
        outline.renderOrder = 11;
        outline.userData.isSectionFill = true;
        outline.userData.fillNodeType  = nt;
        fillGroup.add(outline);
      }
    }
  });

  scene.add(fillGroup);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SectionOrthoViewer({
  nodes,
  edges,
  cutY: cutYProp = 0,
  cutDepth: cutDepthProp = 6000,
  startElevation: startElevProp,
  endElevation: endElevProp,
  flipped: flippedProp = false,
  sectionNodeId,
  className,
  embedded = false,
}: SectionOrthoViewerProps) {
  // Live-read params from the section node for reactive property-panel updates
  const sectionNode = sectionNodeId ? nodes.find((n) => n.id === sectionNodeId) : undefined;
  const flipped = sectionNode
    ? (sectionNode.properties.flipped === true || sectionNode.properties.flipped === 'true')
    : flippedProp;
  const cutDepth = sectionNode
    ? Number(sectionNode.properties.cut_depth_mm ?? cutDepthProp)
    : cutDepthProp;
  const cutHeight = sectionNode ? Number(sectionNode.properties.cut_height_mm ?? 3000) : undefined;
  const startElevation = sectionNode
    ? Number(sectionNode.properties.start_elevation_mm ?? startElevProp ?? 0)
    : startElevProp;
  const endElevation = (sectionNode && cutHeight !== undefined && startElevation !== undefined)
    ? startElevation + cutHeight
    : endElevProp;
  const cutY = cutYProp;

  // ── State ─────────────────────────────────────────────────────────────────
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set(['room']));
  const [renderMode, setRenderMode] = useState<RenderMode>('colored');
  const [isReady, setIsReady] = useState(false);
  const [activeTool, setActiveTool] = useState<AnnotationTool | null>(null);

  const containerRef  = useRef<HTMLDivElement>(null);
  const componentsRef = useRef<OBC.Components | null>(null);
  const worldRef      = useRef<OBC.World | null>(null);
  const techDrawRef   = useRef<OBC.TechnicalDrawings | null>(null);
  const editorRef     = useRef<OBF.DrawingEditor | null>(null);
  const drawingRef    = useRef<any>(null);

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
    world.name = 'SectionView';
    world.scene = new OBC.SimpleScene(components);
    world.renderer = new OBC.SimpleRenderer(components, container);
    world.camera = new OBC.OrthoPerspectiveCamera(components);

    const cam = world.camera as OBC.OrthoPerspectiveCamera;
    cam.projection.set('Orthographic');

    // Lock rotation — orthographic 2D section view, rotation is meaningless
    cam.controls.azimuthRotateSpeed = 0;
    cam.controls.polarRotateSpeed = 0;

    // In embedded mode (sheet composer), disable all user interaction
    if (embedded) {
      cam.controls.enabled = false;
    }

    world.scene.setup();
    world.scene.three.background = new THREE.Color(0xf8f8f4);

    // Lighting
    const scene = world.scene.three as THREE.Scene;
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(0, 20, 10);
    scene.add(dirLight);

    // Enable local clipping on renderer
    world.renderer.three.localClippingEnabled = true;

    components.init();

    // ── TechnicalDrawings + DrawingEditor ───────────────────────────────────
    const techDrawings = components.get(OBC.TechnicalDrawings);
    const drawing = techDrawings.create(world);
    drawing.orientTo(new THREE.Vector3(0, 0, -1)); // looking along -Z (section)
    techDrawRef.current = techDrawings;
    drawingRef.current  = drawing;

    // DrawingEditor (OBF) handles snap, hover, state machine automatically
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

    // Callout text prompt
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

    // ESC cancels active annotation tool
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

  // ── Apply visibility ──────────────────────────────────────────────────────
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !isReady) return;
    let scene: THREE.Scene | null = null;
    try { scene = world.scene.three as THREE.Scene; } catch { return; }
    scene.traverse((obj) => {
      // Main mesh visibility
      const t = obj.userData.nodeType as string | undefined;
      if (t) obj.visible = !hiddenTypes.has(t);
      // Fill/edge visibility synchronized with element type
      const ft = obj.userData.fillNodeType as string | undefined;
      if (ft && !t) obj.visible = !hiddenTypes.has(ft);
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

  // ── Geometry rebuild ──────────────────────────────────────────────────────
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !isReady) return;
    let scene: THREE.Scene | null = null;
    try { scene = world.scene.three as THREE.Scene; } catch { return; }
    const cam = world.camera as OBC.OrthoPerspectiveCamera;

    const cutZm = -cutY * MM;
    const clipPlane = !flipped
      ? new THREE.Plane(new THREE.Vector3(0, 0, -1), cutZm)
      : new THREE.Plane(new THREE.Vector3(0, 0, 1), -cutZm);
    const backZm = !flipped ? cutZm - cutDepth * MM : cutZm + cutDepth * MM;

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

      // Apply clipping + compute bounds
      const box = new THREE.Box3();
      scene!.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          box.expandByObject(obj);
          const mat = (obj as THREE.Mesh | THREE.Line).material;
          if (Array.isArray(mat)) {
            mat.forEach((m) => { if (m instanceof THREE.Material) m.clippingPlanes = [clipPlane]; });
          } else if (mat instanceof THREE.Material) {
            mat.clippingPlanes = [clipPlane];
          }
        }
      });

      // Apply visibility + render mode
      scene!.traverse((obj) => {
        const t = obj.userData.nodeType as string | undefined;
        if (t) obj.visible = !hiddenTypes.has(t);
      });
      applyRenderMode(scene!, renderMode, matConfig, hiddenTypes);

      // Force world matrix update before building per-instance fills
      scene!.updateMatrixWorld(true);

      // Build colored cross-section fills + dark outline edges
      buildSectionFills(scene!, clipPlane, flipped, cutZm, matConfig);

      // Elevation bounds
      if (startElevation !== undefined) box.min.y = Math.min(box.min.y, startElevation * MM);
      if (endElevation !== undefined) box.max.y = Math.max(box.max.y, endElevation * MM);

      // Back wall
      if (!box.isEmpty()) {
        const center = new THREE.Vector3();
        box.getCenter(center);
        const bwSize = box.getSize(new THREE.Vector3());
        const backWall = new THREE.Mesh(
          new THREE.PlaneGeometry(bwSize.x + 10, bwSize.y + 10),
          new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
        );
        backWall.position.set(center.x, center.y, backZm);
        backWall.userData.isBackWall = true;
        scene!.add(backWall);
      }

      // Fit camera — position perpendicular to section plane
      if (!box.isEmpty()) {
        const sectionBox = box.clone();
        sectionBox.min.z = Math.min(cutZm, backZm);
        sectionBox.max.z = Math.max(cutZm, backZm);
        const center = new THREE.Vector3();
        sectionBox.getCenter(center);
        const size = sectionBox.getSize(new THREE.Vector3());
        const diag = Math.sqrt(size.x ** 2 + size.y ** 2 + size.z ** 2) || 20;
        const camDist = diag * 4 + 50;

        if (!flipped) {
          cam.controls.setLookAt(
            center.x, center.y, sectionBox.max.z + camDist,
            center.x, center.y, center.z,
            false,
          );
        } else {
          cam.controls.setLookAt(
            center.x, center.y, sectionBox.min.z - camDist,
            center.x, center.y, center.z,
            false,
          );
        }

        // Fit ortho bounds to section content
        cam.controls.fitToBox(sectionBox, false, { paddingTop: 0.5, paddingBottom: 0.5, paddingLeft: 0.5, paddingRight: 0.5 });
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, isReady, matConfig, cutY, cutDepth, startElevation, endElevation, flipped, sectionNode, hiddenTypes]);

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
        <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500 bg-[#f8f8f4]">
          Loading section…
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
