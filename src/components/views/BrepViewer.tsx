/**
 * BrepViewer — side-by-side check of the internal B-rep kernel against the
 * existing OpenGeometry pipeline.
 *
 * Four phases of the kernel were built against numeric invariants (volume,
 * manifoldness, face topology). Those are strong but blind to a whole class of
 * mistakes: geometry that measures correctly and still looks wrong, or that
 * quietly disagrees with what ships today. This view exists to close that gap.
 *
 * Modes:
 *   brep    — the new kernel alone
 *   og      — the current pipeline alone (same code the app renders)
 *   overlay — OG as a pale solid with the kernel's edges drawn over it, so any
 *             mismatch shows up as edges that miss the surface beneath them
 *
 * This is a diagnostic view, not a product surface.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { cn } from '@/lib/utils';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { ensureOpenGeoReady } from '@/lib/openGeoInit';
import { buildOGScene } from '@/lib/ogBimMapper';
import { NODE_COLOR } from '@/lib/bimGeometry';
import { ensureBooleanEngine } from '@/lib/brep';
import { buildBrepModel, modelVolumesByType, type BrepModel } from '@/lib/brep/scene';
import { toBufferGeometry, toEdgesGeometry } from '@/lib/brep/three';
import { createPointerZoom } from '@/lib/orbitPointerZoom';

type CompareMode = 'brep' | 'og' | 'overlay';

interface BrepViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  className?: string;
  onSelectNode?: (nodeId: string | null) => void;
  selectedNodeId?: string | null;
}

function hexOf(type: string): number {
  const [r, g, b] = NODE_COLOR[type] ?? [0.6, 0.6, 0.6];
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

export function BrepViewer({
  nodes, edges, className, onSelectNode, selectedNodeId,
}: BrepViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const brepGroupRef = useRef<THREE.Group | null>(null);
  const ogGroupRef = useRef<THREE.Group | null>(null);

  // URL params let a headless screenshot reach a state it cannot click into:
  //   ?mode=brep|og|overlay  ?hide=slab,beam  ?az=<deg>&el=<deg>
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [mode, setMode] = useState<CompareMode>(() => {
    const q = params.get('mode');
    return q === 'brep' || q === 'og' ? q : 'overlay';
  });
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set((params.get('hide') ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  );
  const [ready, setReady] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<BrepModel | null>(null);
  const [buildMs, setBuildMs] = useState(0);
  const [showDiags, setShowDiags] = useState(false);

  const cameraState = useRef({
    theta: params.has('az') ? (Number(params.get('az')) * Math.PI) / 180 : -Math.PI / 4,
    phi: params.has('el') ? (Number(params.get('el')) * Math.PI) / 180 : 1.05,
    radius: 20,
  });
  const cameraTarget = useRef(new THREE.Vector3());
  const mouse = useRef({ x: 0, y: 0, down: false, drag: 0 });
  const hasFit = useRef(false);
  const selectRef = useRef(onSelectNode);
  useEffect(() => { selectRef.current = onSelectNode; }, [onSelectNode]);

  // ── Scene setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x15171c);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      50, container.clientWidth / container.clientHeight, 0.01, 10000,
    );
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(12, 22, 9);
    scene.add(dir);
    scene.add(new THREE.GridHelper(50, 50, 0x2a2f3a, 0x22262e));

    const brepGroup = new THREE.Group();
    const ogGroup = new THREE.Group();
    scene.add(brepGroup, ogGroup);
    brepGroupRef.current = brepGroup;
    ogGroupRef.current = ogGroup;

    const place = () => {
      const { theta, phi, radius } = cameraState.current;
      const t = cameraTarget.current;
      camera.position.set(
        t.x + radius * Math.sin(phi) * Math.sin(theta),
        t.y + radius * Math.cos(phi),
        t.z + radius * Math.sin(phi) * Math.cos(theta),
      );
      camera.lookAt(t);
    };
    place();

    const onDown = (e: MouseEvent) => { mouse.current = { x: e.clientX, y: e.clientY, down: true, drag: 0 }; };
    const onUp = () => { mouse.current.down = false; };
    const onMove = (e: MouseEvent) => {
      if (!mouse.current.down) return;
      const dx = e.clientX - mouse.current.x, dy = e.clientY - mouse.current.y;
      mouse.current.drag += Math.hypot(dx, dy);
      cameraState.current.theta -= dx * 0.01;
      cameraState.current.phi = Math.max(0.05, Math.min(Math.PI - 0.05, cameraState.current.phi + dy * 0.01));
      mouse.current.x = e.clientX; mouse.current.y = e.clientY;
      place();
    };
    const pointerZoom = createPointerZoom({
      dom: renderer.domElement,
      camera,
      scene,
      state: cameraState.current,
      target: cameraTarget.current,
      minRadius: 0.5,
      maxRadius: 2000,
    });
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      pointerZoom(e);
      place();
    };
    const onClick = (e: MouseEvent) => {
      if (mouse.current.drag > 4) return;
      const cb = selectRef.current;
      if (!cb) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ), camera);
      for (const hit of rc.intersectObjects(scene.children, true)) {
        let o: THREE.Object3D | null = hit.object;
        while (o) {
          if (o.visible === false) break;
          if (o.userData.nodeId) { cb(o.userData.nodeId as string); return; }
          o = o.parent;
        }
      }
      cb(null);
    };
    const onResize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };

    const el = renderer.domElement;
    el.addEventListener('mousedown', onDown);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseup', onUp);
    el.addEventListener('click', onClick);
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);

    let raf = 0;
    const loop = () => { raf = requestAnimationFrame(loop); renderer.render(scene, camera); };
    loop();
    setReady(true);

    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseup', onUp);
      el.removeEventListener('click', onClick);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (container.contains(el)) container.removeChild(el);
    };
  }, []);

  // ── Build both pipelines ───────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    const scene = sceneRef.current, camera = cameraRef.current;
    const brepGroup = brepGroupRef.current, ogGroup = ogGroupRef.current;
    if (!scene || !camera || !brepGroup || !ogGroup) return;

    let cancelled = false;
    setBuilding(true);
    setError(null);

    (async () => {
      try {
        await Promise.all([ensureBooleanEngine(), ensureOpenGeoReady()]);
        if (cancelled) return;

        const dispose = (g: THREE.Group) => {
          g.traverse((o) => {
            if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
              o.geometry?.dispose();
              const m = o.material;
              Array.isArray(m) ? m.forEach((x) => x.dispose()) : m?.dispose();
            }
          });
          g.clear();
        };
        dispose(brepGroup);
        dispose(ogGroup);

        // ── Kernel ──
        const t0 = performance.now();
        const built = buildBrepModel(nodes, edges);
        const t1 = performance.now();
        if (cancelled) return;
        setModel(built);
        setBuildMs(t1 - t0);

        for (const el of built.elements) {
          const geo = toBufferGeometry(el.solid);
          const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            color: hexOf(el.type), roughness: 0.75, metalness: 0.05,
          }));
          mesh.userData.nodeId = el.id;
          mesh.userData.nodeType = el.type;
          mesh.name = `brep:${el.type}:${el.id}`;
          brepGroup.add(mesh);

          // Real face boundaries from the B-rep loops — in overlay mode these
          // are what you compare against the surface underneath.
          const lines = new THREE.LineSegments(
            toEdgesGeometry(el.solid), new THREE.LineBasicMaterial({ color: 0x2ee6a8 }),
          );
          lines.name = `brepEdges:${el.id}`;
          lines.userData.nodeType = el.type;
          lines.userData.isEdges = true;
          brepGroup.add(lines);
        }

        // ── Existing pipeline ──
        // buildOGScene appends into a Scene; build into a scratch one, then move
        // the results into our group so the two pipelines stay separable.
        const scratch = new THREE.Scene();
        buildOGScene(scratch, nodes, edges, null);
        for (const child of [...scratch.children]) ogGroup.add(child);

        // ── Fit once ──
        if (!hasFit.current) {
          const box = new THREE.Box3();
          brepGroup.traverse((c) => { if (c instanceof THREE.Mesh) box.expandByObject(c); });
          if (box.isEmpty()) ogGroup.traverse((c) => { if (c instanceof THREE.Mesh) box.expandByObject(c); });
          if (!box.isEmpty()) {
            hasFit.current = true;
            const c = box.getCenter(new THREE.Vector3());
            const s = box.getSize(new THREE.Vector3());
            cameraTarget.current.copy(c);
            cameraState.current.radius = Math.max(s.length() * 0.85, 3);
            const { theta, phi, radius } = cameraState.current;
            camera.position.set(
              c.x + radius * Math.sin(phi) * Math.sin(theta),
              c.y + radius * Math.cos(phi),
              c.z + radius * Math.sin(phi) * Math.cos(theta),
            );
            camera.lookAt(c);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBuilding(false);
      }
    })();

    return () => { cancelled = true; };
  }, [nodes, edges, ready]);

  // ── Mode ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const brepGroup = brepGroupRef.current, ogGroup = ogGroupRef.current;
    if (!brepGroup || !ogGroup) return;

    brepGroup.visible = mode !== 'og';
    ogGroup.visible = mode !== 'brep';

    // Overlay: OG becomes a pale ghost, the kernel shows only its edges. Any
    // disagreement reads as green edges floating off the grey surface.
    brepGroup.traverse((o) => {
      const t = o.userData.nodeType as string | undefined;
      if (t && hidden.has(t)) { o.visible = false; return; }
      if (o instanceof THREE.Mesh) o.visible = mode === 'brep';
      if (o instanceof THREE.LineSegments) o.visible = true;
    });
    ogGroup.traverse((o) => {
      const t = o.userData.nodeType as string | undefined;
      if (t && hidden.has(t)) o.visible = false;
    });
    ogGroup.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        const sm = m as THREE.MeshStandardMaterial;
        if (!sm) continue;
        if (mode === 'overlay') {
          if (o.userData.ogAlpha === undefined) o.userData.ogAlpha = sm.opacity;
          sm.transparent = true;
          sm.opacity = 0.28;
        } else if (o.userData.ogAlpha !== undefined) {
          sm.opacity = o.userData.ogAlpha as number;
          sm.transparent = sm.opacity < 1;
        }
        sm.needsUpdate = true;
      }
    });
  }, [mode, model, hidden]);

  // ── Selection highlight ────────────────────────────────────────────────────
  useEffect(() => {
    brepGroupRef.current?.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.MeshStandardMaterial;
      if (!m?.emissive) return;
      const on = o.userData.nodeId === selectedNodeId;
      m.emissive.set(on ? 0xffd700 : 0x000000);
      m.emissiveIntensity = on ? 0.55 : 0;
      m.needsUpdate = true;
    });
  }, [selectedNodeId, model]);

  const volumes = useMemo(() => (model ? modelVolumesByType(model) : {}), [model]);
  const errorCount = model?.diagnostics.length ?? 0;

  return (
    <div className={cn('relative w-full h-full', className)}>
      <div ref={containerRef} className="absolute inset-0" />

      {/* Mode switch */}
      <div className="absolute top-2 left-2 z-10 flex items-center gap-1 rounded bg-black/70 p-1">
        {(['brep', 'overlay', 'og'] as CompareMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              'px-2.5 py-1 text-[11px] rounded transition-colors',
              mode === m ? 'bg-emerald-600 text-white' : 'text-white/60 hover:bg-white/10',
            )}
          >
            {m === 'brep' ? 'B-rep kernel' : m === 'og' ? 'OpenGeometry' : 'Overlay'}
          </button>
        ))}
      </div>

      {/* Readout */}
      <div className="absolute top-2 right-2 z-10 w-64 rounded bg-black/70 p-2.5 text-[11px] text-white/85 font-mono space-y-1">
        <div className="flex justify-between">
          <span className="text-white/50">elements</span>
          <span>{model?.elements.length ?? 0}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-white/50">build</span>
          <span>{buildMs.toFixed(1)} ms</span>
        </div>
        {/* Per-type volume, and a click to hide the type — a slab at ceiling
            level otherwise covers everything you came here to look at. */}
        {Object.entries(volumes).sort().map(([k, v]) => (
          <button
            key={k}
            onClick={() => setHidden((prev) => {
              const next = new Set(prev);
              next.has(k) ? next.delete(k) : next.add(k);
              return next;
            })}
            className={cn(
              'flex w-full justify-between hover:text-white',
              hidden.has(k) && 'line-through text-white/30',
            )}
            title={hidden.has(k) ? 'show' : 'hide'}
          >
            <span className="text-white/50">{k}</span>
            <span>{v.toFixed(3)} m³</span>
          </button>
        ))}

        {!!model?.unsupportedTypes.length && (
          <div className="pt-1.5 mt-1.5 border-t border-white/15 text-amber-300/90">
            <div className="text-[10px] leading-snug">
              not ported to the kernel yet (shown only in the OpenGeometry layer):
            </div>
            <div className="text-[10px] break-words">{model.unsupportedTypes.join(', ')}</div>
          </div>
        )}

        <div className="pt-1.5 mt-1.5 border-t border-white/15">
          <button
            onClick={() => setShowDiags((v) => !v)}
            className={cn(
              'w-full text-left',
              errorCount ? 'text-red-300 hover:text-red-200' : 'text-emerald-300',
            )}
          >
            {errorCount ? `▸ ${errorCount} diagnostic(s)` : '✓ all solids valid'}
          </button>
          {showDiags && !!errorCount && (
            <ul className="mt-1 max-h-48 overflow-y-auto space-y-1 text-[10px] text-red-200/85">
              {model!.diagnostics.map((d, i) => (
                <li key={i} className="break-words">
                  <span className="text-red-400/70">{d.code}</span> {d.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {building && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 pointer-events-none">
          <span className="text-white text-sm">Building both pipelines…</span>
        </div>
      )}
      {error && (
        <div className="absolute bottom-2 left-2 z-20 max-w-lg rounded bg-red-900/85 px-3 py-2 text-xs font-mono text-red-100">
          {error}
        </div>
      )}
    </div>
  );
}
