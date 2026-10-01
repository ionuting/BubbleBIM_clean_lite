/**
 * TopologyScene3D — the CellComplex in 3D: the cells, the faces they share,
 * and the adjacency graph threaded through them.
 *
 * Every face is drawn once, as the kernel built it (backend/topology_engine.py
 * sends the outlines): shared walls and slabs in the colours of the graph's
 * edges, the envelope in quieter tones. Orbit with the left button, pan with
 * the right (or shift), zoom with the wheel; a click picks a room, and the
 * room in focus — hovered or selected — lights its own cell and its
 * neighbours' shared faces while the rest fades back.
 *
 * Z is up, as in the building: the camera's up vector is +Z instead of the
 * model being turned into Three's Y-up frame. Rendering is on demand — a
 * frame is drawn when the controls move or the focus changes, not in a loop.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildFaceObjects, FACE_COLOUR, FACE_LABEL, isSharedKind, type FaceMeshData } from '@/lib/topology/sceneGeometry';
import type { AdjacencyKind, TopologyFaceKind, TopologyResult } from '@/lib/topology/types';

const MM = 0.001;
const EDGE_COLOUR: Record<AdjacencyKind, string> = { wall: '#2563eb', slab: '#d97706', mixed: '#7c3aed' };

export interface TopologyLayers {
  envelope: boolean;
  shared: boolean;
  graph: boolean;
  /** Doors, exits, and the focused room's way out. */
  egress: boolean;
}

interface Props {
  result: TopologyResult;
  storeyColour: (storeyId: string | null) => string;
  /** Hovered or selected room — lit, with its neighbours. */
  focus: string | null;
  selectedId: string | null;
  neighbours: Map<string, Set<string>>;
  layers: TopologyLayers;
  /** Egress limit, metres — a path longer than this is drawn red. */
  maxEgressM: number;
  onPick: (roomId: string | null) => void;
  onHover: (roomId: string | null) => void;
}

type View = 'iso' | 'top' | 'front';

export function TopologyScene3D({ result, storeyColour, focus, selectedId, neighbours, layers, maxEgressM, onPick, onHover }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    render: () => void;
  } | null>(null);
  const groupsRef = useRef<{
    faces: THREE.Mesh[];
    outlines: THREE.LineSegments[];
    nodes: THREE.Mesh[];
    links: THREE.Mesh[];
    box: THREE.Box3;
  } | null>(null);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);

  // ── Renderer, camera, controls — once ────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(-1, -2, 3);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(-20, -20, 20);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;

    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);

    const resize = () => {
      const w = host.clientWidth || 1, h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    ctx.current = { renderer, scene, camera, controls, render };
    resize();

    return () => {
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
      });
      renderer.dispose();
      renderer.domElement.remove();
      ctx.current = null;
    };
  }, []);

  // ── The model: faces, outlines, graph — rebuilt per result ───────────────────
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const root = new THREE.Group();
    root.name = 'topology';

    const { meshes, outlines } = buildFaceObjects(result.faces ?? []);
    meshes.forEach((m) => root.add(m));
    outlines.forEach((l) => root.add(l));

    // Graph: a sphere per room at its footprint's middle, mid-height; a rod
    // per adjacency, thicker for a larger shared area.
    const box = new THREE.Box3();
    for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox!); }
    const pos = new Map(result.graph.nodes.map((n) => [n.id, new THREE.Vector3(...n.positionMm).multiplyScalar(MM)]));
    for (const p of pos.values()) box.expandByPoint(p);
    const size = box.isEmpty() ? 10 : box.getSize(new THREE.Vector3()).length();
    const maxArea = Math.max(...result.rooms.map((r) => r.floorAreaM2), 1);
    const maxShared = Math.max(...result.graph.edges.map((e) => e.sharedAreaM2), 1);
    const areaOf = new Map(result.rooms.map((r) => [r.id, r.floorAreaM2]));

    const nodes: THREE.Mesh[] = [];
    const sphere = new THREE.SphereGeometry(1, 20, 14);
    for (const n of result.graph.nodes) {
      const p = pos.get(n.id)!;
      const r = size * (0.006 + 0.01 * Math.sqrt((areaOf.get(n.id) ?? 0) / maxArea));
      const m = new THREE.Mesh(sphere, new THREE.MeshLambertMaterial({ color: storeyColour(n.storeyId) }));
      m.position.copy(p);
      m.scale.setScalar(r);
      m.userData = { room: n.id, name: n.name };
      m.renderOrder = 10;
      nodes.push(m);
      root.add(m);
    }
    const links: THREE.Mesh[] = [];
    const rod = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
    for (const e of result.graph.edges) {
      const a = pos.get(e.source), b = pos.get(e.target);
      if (!a || !b) continue;
      const len = a.distanceTo(b);
      if (len < 1e-6) continue;
      const w = size * (0.0015 + 0.004 * (e.sharedAreaM2 / maxShared));
      const m = new THREE.Mesh(rod, new THREE.MeshLambertMaterial({ color: EDGE_COLOUR[e.kind], transparent: true }));
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.scale.set(w, len, w);
      // The cylinder runs along +Y; turn it onto a→b.
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      m.userData = { link: [e.source, e.target] };
      m.renderOrder = 9;
      links.push(m);
      root.add(m);
    }

    c.scene.add(root);
    groupsRef.current = { faces: meshes, outlines, nodes, links, box };
    frame('iso');
    return () => {
      c.scene.remove(root);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && m.geometry !== sphere && m.geometry !== rod) m.geometry.dispose();
        const mat = m.material as THREE.Material | undefined;
        mat?.dispose?.();
      });
      sphere.dispose();
      rod.dispose();
      groupsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // ── Focus and layers: materials only, no rebuild ────────────────────────────
  useEffect(() => {
    const g = groupsRef.current, c = ctx.current;
    if (!g || !c) return;
    const near = focus ? neighbours.get(focus) : undefined;
    const lit = (rooms: string[]) => !!focus && rooms.includes(focus);
    for (const m of [...g.faces, ...g.outlines]) {
      const d = m.userData as FaceMeshData;
      const shared = isSharedKind(d.kind);
      m.visible = shared ? layers.shared : layers.envelope;
      const mat = m.material as THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
      const isLine = m instanceof THREE.LineSegments;
      const base = isLine ? (shared ? 0.9 : 0.45) : (shared ? 0.35 : 0.12);
      mat.opacity = !focus ? base : lit(d.rooms) ? Math.min(1, base * 2.4) : base * 0.25;
    }
    for (const m of g.nodes) {
      m.visible = layers.graph;
      const id = (m.userData as { room: string }).room;
      const on = !focus || id === focus || !!near?.has(id);
      const mat = m.material as THREE.MeshLambertMaterial;
      mat.transparent = !on;
      mat.opacity = on ? 1 : 0.2;
      mat.emissive.set(id === selectedId ? '#f97316' : '#000000');
    }
    for (const m of g.links) {
      m.visible = layers.graph;
      const [a, b] = (m.userData as { link: [string, string] }).link;
      (m.material as THREE.MeshLambertMaterial).opacity = !focus || a === focus || b === focus ? 0.95 : 0.12;
    }
    c.render();
  }, [focus, selectedId, neighbours, layers, result]);

  // ── Egress: doors always (with the layer), the focused room's walk ─────────
  useEffect(() => {
    const c = ctx.current, g = groupsRef.current;
    const circ = result.circulation;
    if (!c || !g || !circ) return;
    const grp = new THREE.Group();
    grp.visible = layers.egress;
    const size = g.box.isEmpty() ? 10 : g.box.getSize(new THREE.Vector3()).length();
    const lift = 0.9; // walking height above the floor, m

    const doorGeom = new THREE.BoxGeometry(1, 1, 1);
    for (const d of circ.doors) {
      const m = new THREE.Mesh(doorGeom, new THREE.MeshLambertMaterial({ color: d.exterior ? '#16a34a' : '#64748b' }));
      const s = size * (d.exterior ? 0.012 : 0.008);
      m.scale.set(s, s, s * 1.8);
      m.position.set(d.positionMm[0] * MM, d.positionMm[1] * MM, d.positionMm[2] * MM + s * 0.9);
      m.renderOrder = 11;
      grp.add(m);
    }

    const room = focus ? circ.rooms.find((r) => r.id === focus) : undefined;
    if (room && room.pathMm.length >= 2) {
      const over = room.egressM != null && room.egressM > maxEgressM;
      const mat = new THREE.MeshLambertMaterial({ color: over ? '#dc2626' : '#16a34a' });
      const rod = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
      const w = size * 0.004;
      const pts = room.pathMm.map((p) => new THREE.Vector3(p[0] * MM, p[1] * MM, p[2] * MM + lift));
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const len = a.distanceTo(b);
        if (len < 1e-6) continue;
        const m = new THREE.Mesh(rod, mat);
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.scale.set(w, len, w);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        m.renderOrder = 12;
        grp.add(m);
      }
      const start = new THREE.Mesh(new THREE.SphereGeometry(w * 2.5, 12, 8), mat);
      start.position.copy(pts[0]);
      grp.add(start);
    }

    c.scene.add(grp);
    c.render();
    return () => {
      c.scene.remove(grp);
      grp.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
      c.render();
    };
  }, [result, focus, layers.egress, maxEgressM]);

  // ── Camera presets ───────────────────────────────────────────────────────────
  const frame = useCallback((view: View) => {
    const c = ctx.current, g = groupsRef.current;
    if (!c || !g || g.box.isEmpty()) return;
    const centre = g.box.getCenter(new THREE.Vector3());
    const radius = Math.max(g.box.getSize(new THREE.Vector3()).length() / 2, 1);
    const dist = radius / Math.sin((c.camera.fov * Math.PI) / 360) * 1.05;
    const dir = view === 'top' ? new THREE.Vector3(0, -0.0001, 1)
      : view === 'front' ? new THREE.Vector3(0, -1, 0.15)
      : new THREE.Vector3(-1, -1.3, 0.9);
    c.camera.position.copy(centre).addScaledVector(dir.normalize(), dist);
    c.camera.near = dist / 1000;
    c.camera.far = dist * 20;
    c.camera.updateProjectionMatrix();
    c.controls.target.copy(centre);
    c.controls.update();
    c.render();
  }, []);

  // ── Picking: a click (not a drag) picks a room ──────────────────────────────
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const pickAt = useCallback((ev: { clientX: number; clientY: number }): { room: string | null; label: string | null } => {
    const c = ctx.current, g = groupsRef.current;
    if (!c || !g) return { room: null, label: null };
    const r = c.renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), c.camera);
    raycaster.params.Line = { threshold: 0 };
    const nodeHit = raycaster.intersectObjects(g.nodes.filter((m) => m.visible), false)[0];
    if (nodeHit) {
      const d = nodeHit.object.userData as { room: string; name: string };
      return { room: d.room, label: d.name };
    }
    const faceHit = raycaster.intersectObjects(g.faces.filter((m) => m.visible), false)[0];
    if (!faceHit) return { room: null, label: null };
    const d = faceHit.object.userData as FaceMeshData;
    const names = new Map(result.rooms.map((x) => [x.id, x.name]));
    // A shared face bounds two cells: pick the one on the camera's side.
    let room = d.rooms[0] ?? null;
    if (d.rooms.length === 2 && faceHit.face) {
      const n = faceHit.face.normal.clone();
      const towardsCamera = raycaster.ray.direction.dot(n) < 0;
      const centre = (id: string) => new THREE.Vector3(...(result.graph.nodes.find((x) => x.id === id)?.positionMm ?? [0, 0, 0])).multiplyScalar(MM);
      const side = (id: string) => centre(id).sub(faceHit.point).dot(n);
      const [a, b] = d.rooms;
      room = (side(a) > 0) === towardsCamera ? a : b;
    }
    const label = `${FACE_LABEL[d.kind]} · ${d.rooms.map((id) => names.get(id) ?? id).join(' — ')} · ${d.areaM2.toLocaleString('ro-RO', { maximumFractionDigits: 2 })} m²`;
    return { room, label };
  }, [raycaster, result]);

  const down = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => { down.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    onPick(pickAt(e).room);
  };
  const hoverRaf = useRef(0);
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons) return;
    cancelAnimationFrame(hoverRaf.current);
    const pt = { clientX: e.clientX, clientY: e.clientY };
    hoverRaf.current = requestAnimationFrame(() => {
      const h = pickAt(pt);
      setHoverLabel(h.label);
      onHover(h.room);
    });
  };

  const kindsPresent = useMemo(() => {
    const s = new Set<TopologyFaceKind>();
    for (const f of result.faces ?? []) s.add(f.kind);
    return (['wall', 'slab', 'exterior', 'roof', 'ground'] as TopologyFaceKind[]).filter((k) => s.has(k));
  }, [result]);

  return (
    <div className="relative w-full h-full">
      <div ref={hostRef} className="absolute inset-0"
        onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerMove={onPointerMove}
        onPointerLeave={() => { setHoverLabel(null); onHover(null); }}
        onContextMenu={(e) => e.preventDefault()} />
      <div className="absolute right-3 top-3 flex flex-col gap-1">
        {([['iso', 'Izo'], ['top', 'Sus'], ['front', 'Față']] as [View, string][]).map(([v, label]) => (
          <button key={v} className="px-2 py-0.5 rounded border border-border bg-background/85 hover:bg-accent"
            onClick={() => frame(v)}>{label}</button>
        ))}
        <button className="px-2 py-0.5 rounded border border-border bg-background/85 hover:bg-accent"
          title="Încadrează modelul" onClick={() => frame('iso')}>⤢</button>
      </div>
      {hoverLabel && (
        <div className="absolute left-3 top-3 px-2 py-1 rounded border border-border bg-background/90 pointer-events-none">
          {hoverLabel}
        </div>
      )}
      <div className="absolute left-3 bottom-10 flex flex-wrap gap-x-3 gap-y-1 bg-background/80 rounded px-2 py-1 border border-border max-w-[70%]">
        {kindsPresent.map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: FACE_COLOUR[k], opacity: isSharedKind(k) ? 0.9 : 0.6 }} />
            {FACE_LABEL[k]}
          </span>
        ))}
      </div>
      <div className="absolute right-3 bottom-3 text-[10px] text-muted-foreground bg-background/70 rounded px-1.5 py-0.5 pointer-events-none">
        stânga: rotire · dreapta/shift: deplasare · rotiță: zoom · click: cameră
      </div>
    </div>
  );
}
