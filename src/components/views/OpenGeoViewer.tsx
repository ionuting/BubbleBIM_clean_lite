/**
 * OpenGeoViewer — Three.js 3D viewer powered by the OpenGeometry WASM kernel.
 *
 * Uses the same camera / orbit / raycasting pattern as Ara3DViewer.
 * Geometry is built by ogBimMapper.ts (OG shapes extend THREE.Mesh directly).
 *
 * Phase 1: columns, walls, slabs, rooms, foundations rendered.
 * Phase 2 (todo): boolean openings (windows/doors) via Opening.subtractFrom().
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { cn } from '@/lib/utils';
import { VisibilityFilter } from '@/components/views/VisibilityFilter';
import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes } from '@/store';
import { expandArrayNodes } from '@/lib/formulaUtils';
import { ensureOpenGeoReady } from '@/lib/openGeoInit';
import { buildOGScene } from '@/lib/ogBimMapper';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { createPointerZoom } from '@/lib/orbitPointerZoom';
import { pickNodeId } from '@/lib/pickSelection';
import { applySelectionHighlight, setHighlight } from '@/lib/selectionHighlight';

function addBimAxes(scene: THREE.Scene, length = 1): void {
  const mkLine = (end: [number, number, number], color: number) => {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(...end),
    ]);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
  };
  scene.add(mkLine([length, 0, 0], 0xe63946));   // X East red
  scene.add(mkLine([0, length, 0], 0x4088f2));   // Y Up blue
  scene.add(mkLine([0, 0, -length], 0x33cc33));  // Z North green
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface OpenGeoViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes: BuildingAxes;
  className?: string;
  onSelectNode?: (nodeId: string | null) => void;
  selectedNodeId?: string | null;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function OpenGeoViewer({
  nodes,
  edges,
  buildingAxes: _buildingAxes,
  className,
  onSelectNode,
  selectedNodeId,
}: OpenGeoViewerProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const sceneRef       = useRef<THREE.Scene | null>(null);
  const cameraRef      = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef    = useRef<THREE.WebGLRenderer | null>(null);
  const ambLightRef    = useRef<THREE.AmbientLight | null>(null);
  const dirLightRef    = useRef<THREE.DirectionalLight | null>(null);
  const [isReady, setIsReady]     = useState(false);
  const [ogError, setOgError]     = useState<string | null>(null);
  const [isBuilding, setBuilding] = useState(false);
  const [dayMode, setDayMode]     = useState(false);
  const { config: matConfig } = useMaterialConfig();

  // ── Visibility filter ────────────────────────────────────────────────────
  const [hiddenTypes, setHiddenTypes]         = useState<Set<string>>(new Set());
  const [hiddenStoreyIds, setHiddenStoreyIds] = useState<Set<string>>(new Set());
  const nodesMapRef = useRef<Map<string, BubbleGraphNode>>(new Map());
  useEffect(() => {
    nodesMapRef.current = new Map(nodes.map((n) => [n.id, n]));
  }, [nodes]);

  const { visibleTypes, typeCounts } = useMemo(() => {
    const expanded = expandArrayNodes(nodes);
    const counts: Record<string, number> = {};
    for (const n of expanded) counts[n.type] = (counts[n.type] ?? 0) + 1;
    if (!counts['column']) {
      const c = expanded.filter((n: { type: string; properties: Record<string, unknown> }) => n.type === 'ax' && String(n.properties.has_column ?? '').toLowerCase() === 'true').length;
      if (c) counts['column'] = c;
    }
    if (!counts['beam']) {
      const c = expanded.filter((n: { type: string; properties: Record<string, unknown> }) => n.type === 'wall' && String(n.properties.has_beam ?? '').toLowerCase() === 'true').length;
      if (c) counts['beam'] = c;
    }
    return { visibleTypes: Object.keys(counts), typeCounts: counts };
  }, [nodes]);

  // ── Camera/mouse state ───────────────────────────────────────────────────
  const mouseRef        = useRef({ x: 0, y: 0, isDown: false, dragDist: 0 });
  const cameraStateRef  = useRef({ theta: -Math.PI / 4, phi: 1.1, radius: 10 });
  const cameraTargetRef = useRef(new THREE.Vector3(0, 0, 0));
  const hasFitRef       = useRef(false);
  const onSelectNodeRef = useRef(onSelectNode);
  useEffect(() => { onSelectNodeRef.current = onSelectNode; }, [onSelectNode]);
  const selectedNodeIdRef = useRef(selectedNodeId);
  useEffect(() => { selectedNodeIdRef.current = selectedNodeId; }, [selectedNodeId]);

  // ── Visibility toggle ────────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.traverse((obj) => {
      const t   = obj.userData.nodeType as string | undefined;
      const sid = obj.userData.storeyId as string | undefined;
      if (!t) return;
      if (hiddenTypes.has(t)) { obj.visible = false; return; }
      if (hiddenStoreyIds.size > 0 && sid && hiddenStoreyIds.has(sid)) { obj.visible = false; return; }
      obj.visible = true;
    });
  }, [hiddenTypes, hiddenStoreyIds, isReady]);

  // ── Selection highlight ──────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    applySelectionHighlight(scene, selectedNodeId);
  }, [selectedNodeId]);

  // ── Scene initialization ─────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1e1e1e);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 10000);
    camera.position.set(5, 5, 5);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const amb = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(amb);
    ambLightRef.current = amb;
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(10, 20, 10);
    dir.castShadow = true;
    scene.add(dir);
    dirLightRef.current = dir;

    addBimAxes(scene);

    const updateCamera = () => {
      const { theta, phi, radius } = cameraStateRef.current;
      const t = cameraTargetRef.current;
      camera.position.set(
        t.x + radius * Math.sin(phi) * Math.sin(theta),
        t.y + radius * Math.cos(phi),
        t.z + radius * Math.sin(phi) * Math.cos(theta),
      );
      camera.lookAt(t.x, t.y, t.z);
    };

    const onDown  = (e: MouseEvent) => { mouseRef.current = { x: e.clientX, y: e.clientY, isDown: true, dragDist: 0 }; };
    const onUp    = () => { mouseRef.current.isDown = false; };
    const onMove  = (e: MouseEvent) => {
      if (!mouseRef.current.isDown) return;
      const dx = e.clientX - mouseRef.current.x;
      const dy = e.clientY - mouseRef.current.y;
      mouseRef.current.dragDist += Math.sqrt(dx * dx + dy * dy);
      cameraStateRef.current.theta -= dx * 0.01;
      cameraStateRef.current.phi    = Math.max(0.1, Math.min(Math.PI - 0.1, cameraStateRef.current.phi + dy * 0.01));
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
      updateCamera();
    };
    const onClick = (e: MouseEvent) => {
      if (mouseRef.current.dragDist > 4) return;
      const cb = onSelectNodeRef.current;
      if (!cb || !sceneRef.current || !cameraRef.current) return;
      const rect  = renderer.domElement.getBoundingClientRect();
      const ndcX  = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      const ndcY  = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), cameraRef.current);
      cb(pickNodeId(rc, sceneRef.current));
    };
    const pointerZoom = createPointerZoom({
      dom: renderer.domElement,
      camera,
      scene,
      state: cameraStateRef.current,
      target: cameraTargetRef.current,
      minRadius: 1,
      maxRadius: 1000,
    });
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      pointerZoom(e);
      updateCamera();
    };
    const onResize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };

    renderer.domElement.addEventListener('mousedown', onDown);
    renderer.domElement.addEventListener('mousemove', onMove);
    renderer.domElement.addEventListener('mouseup', onUp);
    renderer.domElement.addEventListener('click', onClick);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);

    let animId: number;
    const animate = () => { animId = requestAnimationFrame(animate); renderer.render(scene, camera); };
    animate();

    setIsReady(true);

    return () => {
      cancelAnimationFrame(animId);
      renderer.domElement.removeEventListener('mousedown', onDown);
      renderer.domElement.removeEventListener('mousemove', onMove);
      renderer.domElement.removeEventListener('mouseup', onUp);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.domElement.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, []);
  // ── Day / Night mode ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    const amb   = ambLightRef.current;
    const dir   = dirLightRef.current;
    if (!scene || !amb || !dir) return;
    if (dayMode) {
      scene.background = new THREE.Color(0xd0e8f5);
      amb.color.set(0xfff6e8); amb.intensity = 1.2;
      dir.color.set(0xfff6e8); dir.intensity = 1.8; dir.position.set(50, 80, 30);
    } else {
      scene.background = new THREE.Color(0x1e1e1e);
      amb.color.set(0xffffff); amb.intensity = 0.8;
      dir.color.set(0xffffff); dir.intensity = 1.2; dir.position.set(10, 20, 10);
    }
  }, [dayMode]);
  // ── Geometry rebuild ─────────────────────────────────────────────────────
  useEffect(() => {
    const scene  = sceneRef.current;
    const camera = cameraRef.current;
    if (!scene || !camera || !isReady) return;

    setBuilding(true);
    setOgError(null);

    (async () => {
      try {
        // Initialize OG WASM kernel (idempotent)
        await ensureOpenGeoReady();

        // Remove old geometry (keep lights + axes)
        scene.children = scene.children.filter(
          (c) => c instanceof THREE.Light || c instanceof THREE.Line,
        );

        buildOGScene(scene, nodes, edges, matConfig);

        // Re-apply visibility
        scene.traverse((obj) => {
          const t   = obj.userData.nodeType as string | undefined;
          const sid = obj.userData.storeyId as string | undefined;
          if (!t) return;
          if (hiddenTypes.has(t)) { obj.visible = false; return; }
          if (hiddenStoreyIds.size > 0 && sid && hiddenStoreyIds.has(sid)) { obj.visible = false; return; }
          obj.visible = true;
        });

        // Re-apply selection highlight. Must go through setHighlight so the
        // original emissive is recorded: highlighting these freshly rebuilt
        // meshes without it left nothing to restore, and deselecting could
        // never clear the gold — the element stayed highlighted for good.
        const selId = selectedNodeIdRef.current;
        if (selId) {
          scene.traverse((obj) => {
            if (obj instanceof THREE.Mesh && obj.userData.nodeId === selId) setHighlight(obj, true);
          });
        }

        // Auto-fit camera on first build
        if (!hasFitRef.current) {
          const box = new THREE.Box3();
          scene.traverse((c) => {
            if (c instanceof THREE.Mesh) box.expandByObject(c);
          });
          if (!box.isEmpty()) {
            hasFitRef.current = true;
            const center = new THREE.Vector3();
            box.getCenter(center);
            cameraTargetRef.current.copy(center);
            const size = box.getSize(new THREE.Vector3());
            const diag = Math.sqrt(size.x ** 2 + size.y ** 2 + size.z ** 2);
            cameraStateRef.current.radius = Math.max(diag * 0.9, 5);
            const { theta, phi, radius } = cameraStateRef.current;
            camera.position.set(
              center.x + radius * Math.sin(phi) * Math.sin(theta),
              center.y + radius * Math.cos(phi),
              center.z + radius * Math.sin(phi) * Math.cos(theta),
            );
            camera.lookAt(center.x, center.y, center.z);
          }
        }
      } catch (err) {
        console.error('[OpenGeoViewer] Build failed:', err);
        setOgError(err instanceof Error ? err.message : 'OpenGeometry build failed');
      } finally {
        setBuilding(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, isReady, matConfig]);

  return (
    <div className={cn('relative w-full h-full', className)}>
      {/* Three.js canvas mount point */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Visibility filter overlay */}
      {visibleTypes.length > 0 && (
        <VisibilityFilter
          types={visibleTypes}
          hiddenTypes={hiddenTypes}
          counts={typeCounts}
          onChange={(next) => setHiddenTypes(next)}
          nodes={nodes}
          edges={edges}
          hiddenStoreyIds={hiddenStoreyIds}
          onChangeStoreyIds={setHiddenStoreyIds}
          className="absolute bottom-4 right-4 z-10"
        />
      )}

      {/* OG badge + Day/Night toggle */}
      <div className="absolute top-2 left-2 z-10 flex items-center gap-2">
        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-black/60 text-emerald-400 select-none">
          OpenGeometry WASM
        </span>
        {isReady && (
          <button
            onClick={() => setDayMode((d) => !d)}
            title={dayMode ? 'Switch to Night mode' : 'Switch to Day mode'}
            className="w-7 h-7 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 text-base select-none transition-colors"
          >
            {dayMode ? '🌙' : '☀️'}
          </button>
        )}
      </div>

      {/* Building indicator */}
      {isBuilding && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-20 pointer-events-none">
          <span className="text-white text-sm font-medium">Building geometry…</span>
        </div>
      )}

      {/* Error banner */}
      {ogError && (
        <div className="absolute top-2 right-2 z-20 max-w-sm px-3 py-2 rounded bg-red-900/80 text-red-200 text-xs font-mono">
          {ogError}
        </div>
      )}
    </div>
  );
}
