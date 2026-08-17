/**
 * FemViewer — diagnostic 3D view of a storey's structural FEM model.
 *
 * Builds the model via `buildFemModel`, runs `@awatif/components`'s linear
 * solver, and renders original (dim) + deformed (coloured, exaggerated)
 * geometry in the same scene, plus support markers (cube = fully fixed,
 * sphere = pinned). Frame members (columns/beams) draw as lines; wall/slab
 * shells draw as translucent triangles.
 *
 * Development artefact — not part of the shipped app.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { cn } from '@/lib/utils';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { buildFemModel, type FemModel, type FemModelOptions, type ElementKind } from '@/lib/fem/buildFemModel';
import { getPositionsAndForces } from '@awatif/components/analysis/l-solver/getPositionsAndForces';
import { getFullReactions, type FemReactions } from '@/lib/fem/getFullReactions';

interface FemViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  /** A storey node id, the literal string `'all'` to stack the whole building, or `null` (nothing selected yet). */
  storeyId: string | null;
  options?: FemModelOptions;
  className?: string;
}

const KIND_COLOR: Record<ElementKind, number> = {
  column: 0x3b82f6, // blue
  beam: 0x10b981,   // green
  wall: 0xeab308,   // amber
  slab: 0xa855f8,   // purple
};
const ORIGINAL_COLOR = 0x555b66;
const FIXED_SUPPORT_COLOR = 0xef4444;
const PIN_SUPPORT_COLOR = 0x22d3ee;

interface SolveResult {
  model: FemModel;
  positions: number[];
  reactions: FemReactions;
  maxDisplacement: number;
}

function solve(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  storeyId: string | null,
  options: FemModelOptions | undefined,
): { result: SolveResult | null; error: string | null } {
  if (!storeyId) return { result: null, error: null }; // no storey selected — not an error, just nothing to show yet
  try {
    const model = buildFemModel(nodes, edges, storeyId, options);
    if (model.nodes.length === 0) {
      return {
        result: null,
        error: storeyId === 'all' ? 'No columns/walls found in the building.' : 'No columns/walls found for this storey.',
      };
    }

    const { positions } = getPositionsAndForces(model.nodes, model.elements, model.loads, model.supports, model.elementsProps);
    const reactions = getFullReactions(model.nodes, model.elements, model.elementsProps, model.supports, model.loads);

    let maxDisplacement = 0;
    model.nodes.forEach((n, i) => {
      const d = Math.hypot(positions[i * 3] - n[0], positions[i * 3 + 1] - n[1], positions[i * 3 + 2] - n[2]);
      if (d > maxDisplacement) maxDisplacement = d;
    });

    return { result: { model, positions, reactions, maxDisplacement }, error: null };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function frameLineGeometry(
  model: FemModel, positions: number[] | null, kinds: ElementKind[],
): THREE.BufferGeometry | null {
  const pts: number[] = [];
  model.elements.forEach((el, i) => {
    if (el.length !== 2 || !kinds.includes(model.elementMeta[i].kind)) return;
    for (const nIdx of el) {
      if (positions) pts.push(positions[nIdx * 3], positions[nIdx * 3 + 1], positions[nIdx * 3 + 2]);
      else pts.push(model.nodes[nIdx][0], model.nodes[nIdx][1], model.nodes[nIdx][2]);
    }
  });
  if (pts.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

function shellMeshGeometry(
  model: FemModel, positions: number[] | null, kinds: ElementKind[],
): THREE.BufferGeometry | null {
  const pts: number[] = [];
  model.elements.forEach((el, i) => {
    if (el.length !== 3 || !kinds.includes(model.elementMeta[i].kind)) return;
    for (const nIdx of el) {
      if (positions) pts.push(positions[nIdx * 3], positions[nIdx * 3 + 1], positions[nIdx * 3 + 2]);
      else pts.push(model.nodes[nIdx][0], model.nodes[nIdx][1], model.nodes[nIdx][2]);
    }
  });
  if (pts.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  geo.computeVertexNormals();
  return geo;
}

export function FemViewer({ nodes, edges, storeyId, options, className }: FemViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const contentGroupRef = useRef<THREE.Group | null>(null);
  const [ready, setReady] = useState(false);
  const [showOriginal, setShowOriginal] = useState(true);
  const [showDeformed, setShowDeformed] = useState(true);
  const [autoScale, setAutoScale] = useState(true);
  const [manualScale, setManualScale] = useState(50);

  const cameraState = useRef({ theta: -Math.PI / 4, phi: 1.05, radius: 15 });
  const cameraTarget = useRef(new THREE.Vector3());
  const mouse = useRef({ x: 0, y: 0, down: false });
  const hasFit = useRef(false);

  const { result, error } = useMemo(() => solve(nodes, edges, storeyId, options), [nodes, edges, storeyId, options]);

  // ── Scene setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x15171c);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 10000);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(8, 15, 10);
    scene.add(dir);
    // GridHelper always lies flat in its LOCAL XZ plane — it ignores camera.up.
    // Everything else here is fed raw Z-up BIM coordinates (unlike the other
    // viewers, which convert to Three's native Y-up before building geometry),
    // so without this rotation the "floor" grid stands up as a vertical wall
    // through BIM-Y=0 instead of lying flat at the storey's z=0 base plane.
    const grid = new THREE.GridHelper(50, 50, 0x2a2f3a, 0x22262e);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);

    const content = new THREE.Group();
    scene.add(content);
    contentGroupRef.current = content;

    const place = () => {
      const { theta, phi, radius } = cameraState.current;
      const t = cameraTarget.current;
      camera.position.set(
        t.x + radius * Math.sin(phi) * Math.sin(theta),
        t.y + radius * Math.cos(phi),
        t.z + radius * Math.sin(phi) * Math.cos(theta),
      );
      camera.up.set(0, 0, 1); // Z-up, matching the FEM/BIM coordinate convention
      camera.lookAt(t);
    };
    place();

    const onDown = (e: MouseEvent) => { mouse.current = { x: e.clientX, y: e.clientY, down: true }; };
    const onUp = () => { mouse.current.down = false; };
    const onMove = (e: MouseEvent) => {
      if (!mouse.current.down) return;
      const dx = e.clientX - mouse.current.x, dy = e.clientY - mouse.current.y;
      cameraState.current.theta -= dx * 0.01;
      cameraState.current.phi = Math.max(0.05, Math.min(Math.PI - 0.05, cameraState.current.phi + dy * 0.01));
      mouse.current.x = e.clientX; mouse.current.y = e.clientY;
      place();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraState.current.radius = Math.max(0.5, Math.min(2000, cameraState.current.radius * (e.deltaY > 0 ? 1.1 : 0.9)));
      place();
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
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (container.contains(el)) container.removeChild(el);
    };
  }, []);

  // ── Auto-fit camera to the model once, when it first solves ───────────────
  useEffect(() => {
    if (!ready || !result || hasFit.current) return;
    const bb = new THREE.Box3();
    for (const n of result.model.nodes) bb.expandByPoint(new THREE.Vector3(n[0], n[1], n[2]));
    const center = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3());
    cameraTarget.current.copy(center);
    cameraState.current.radius = Math.max(3, size.length() * 1.3);
    hasFit.current = true;
  }, [ready, result]);

  // ── Populate content group ─────────────────────────────────────────────────
  useEffect(() => {
    const content = contentGroupRef.current;
    if (!ready || !content || !result) return;

    while (content.children.length) {
      const obj = content.children.pop()!;
      obj.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
      });
    }

    const { model, positions, reactions, maxDisplacement } = result;
    const bb = new THREE.Box3();
    for (const n of model.nodes) bb.expandByPoint(new THREE.Vector3(...(n as [number, number, number])));
    const diag = bb.getSize(new THREE.Vector3()).length() || 1;
    const scale = autoScale
      ? (maxDisplacement > 1e-9 ? Math.min(500, Math.max(1, (diag * 0.08) / maxDisplacement)) : 1)
      : manualScale;

    const scaledPositions = positions.map((v, i) => {
      const nodeIdx = Math.floor(i / 3);
      const orig = model.nodes[nodeIdx][i % 3];
      return orig + (v - orig) * scale;
    });

    const FRAME_KINDS: ElementKind[] = ['column', 'beam'];
    const SHELL_KINDS: ElementKind[] = ['wall', 'slab'];

    if (showOriginal) {
      const frameGeo = frameLineGeometry(model, null, FRAME_KINDS);
      if (frameGeo) content.add(new THREE.LineSegments(frameGeo, new THREE.LineBasicMaterial({ color: ORIGINAL_COLOR })));
      const shellGeo = shellMeshGeometry(model, null, SHELL_KINDS);
      if (shellGeo) content.add(new THREE.Mesh(shellGeo, new THREE.MeshLambertMaterial({
        color: ORIGINAL_COLOR, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false,
      })));
    }

    if (showDeformed) {
      for (const kinds of [['column'], ['beam']] as ElementKind[][]) {
        const geo = frameLineGeometry(model, scaledPositions, kinds);
        if (geo) content.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: KIND_COLOR[kinds[0]] })));
      }
      for (const kinds of [['wall'], ['slab']] as ElementKind[][]) {
        const geo = shellMeshGeometry(model, scaledPositions, kinds);
        if (geo) content.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
          color: KIND_COLOR[kinds[0]], transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
        })));
      }
    }

    // Support markers at the ORIGINAL position (undeformed — that's where the restraint physically is).
    for (const [nodeIdx, support] of model.supports) {
      const [x, y, z] = model.nodes[nodeIdx];
      const isFixed = support.every(Boolean);
      const markerSize = Math.max(0.05, diag * 0.015);
      const mesh = isFixed
        ? new THREE.Mesh(new THREE.BoxGeometry(markerSize, markerSize, markerSize), new THREE.MeshBasicMaterial({ color: FIXED_SUPPORT_COLOR }))
        : new THREE.Mesh(new THREE.SphereGeometry(markerSize * 0.6, 12, 12), new THREE.MeshBasicMaterial({ color: PIN_SUPPORT_COLOR }));
      mesh.position.set(x, y, z);
      mesh.userData.reaction = reactions.get(nodeIdx);
      content.add(mesh);
    }
  }, [ready, result, showOriginal, showDeformed, autoScale, manualScale]);

  const kindCounts = useMemo(() => {
    if (!result) return null;
    const counts: Record<ElementKind, number> = { column: 0, beam: 0, wall: 0, slab: 0 };
    result.model.elementMeta.forEach((m) => { counts[m.kind]++; });
    return counts;
  }, [result]);

  return (
    <div className={cn('relative w-full h-full', className)}>
      <div ref={containerRef} className="absolute inset-0" />
      <div
        className="absolute top-2 left-2 z-10 flex flex-col gap-1 rounded bg-black/60 px-3 py-2 text-[11px] text-white/80"
        style={{ fontFamily: 'ui-monospace, monospace' }}
      >
        <div>Structural (FEM) — {storeyId === 'all' ? 'whole building' : storeyId ?? 'no storey selected'}</div>
        {error && <div className="text-red-400">error: {error}</div>}
        {!storeyId && <div className="text-white/50">Pick a storey from the explorer to build its model.</div>}
        {kindCounts && (
          <div className="flex gap-3">
            <span style={{ color: `#${KIND_COLOR.column.toString(16)}` }}>col {kindCounts.column}</span>
            <span style={{ color: `#${KIND_COLOR.beam.toString(16)}` }}>beam {kindCounts.beam}</span>
            <span style={{ color: `#${KIND_COLOR.wall.toString(16)}` }}>wall {kindCounts.wall}</span>
            <span style={{ color: `#${KIND_COLOR.slab.toString(16)}` }}>slab {kindCounts.slab}</span>
          </div>
        )}
        {result && <div>max displacement: {(result.maxDisplacement * 1000).toFixed(2)} mm</div>}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showOriginal} onChange={(e) => setShowOriginal(e.target.checked)} /> original
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showDeformed} onChange={(e) => setShowDeformed(e.target.checked)} /> deformed
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={autoScale} onChange={(e) => setAutoScale(e.target.checked)} /> auto scale
        </label>
        {!autoScale && (
          <label className="flex items-center gap-1">
            scale ×
            <input
              type="number" min={1} max={1000} value={manualScale}
              onChange={(e) => setManualScale(Number(e.target.value) || 1)}
              className="w-16 bg-white/10 px-1"
            />
          </label>
        )}
        <div className="text-white/40">🟥 fixed · 🟦 pinned support</div>
      </div>
    </div>
  );
}
