/**
 * IFCPreview3D — floating 3D preview of the full IFC model geometry.
 *
 * Renders walls (extruded footprint rectangles) and slabs (extruded flat
 * polygons) as Three.js solids. Updates in real-time as rig axes are
 * dragged — the deformed geometry is passed from IFCPlanView.
 *
 * Controls:
 *  - Left drag  → orbit
 *  - Right drag → pan
 *  - Wheel      → zoom
 *  - Window     → draggable + resizable (CSS resize)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { IFCPlanWall, IFCPlanSlab } from '../../store/index';
import { cn } from '../../lib/utils';

// ── Constants ──────────────────────────────────────────────────────────────
const MM = 0.001; // mm → metres

// Wall material palette — one per storey index
const WALL_MAT_COLORS = [
  0x6366f1, 0x10b981, 0xf59e0b, 0xef4444, 0xa855f7, 0x14b8a6,
];
// Slab material palette — lighter, more translucent tones
const SLAB_MAT_COLORS = [
  0x818cf8, 0x34d399, 0xfbbf24, 0xf87171, 0xc084fc, 0x2dd4bf,
];

// ── Types ──────────────────────────────────────────────────────────────────
export interface IFCPreview3DWall {
  wall:        IFCPlanWall;
  storeyIdx:   number;
  elevationMm: number;  // storey bottom elevation in mm
}

export interface IFCPreview3DSlab {
  slab:      IFCPlanSlab;
  storeyIdx: number;
}

interface IFCPreview3DProps {
  walls:     IFCPreview3DWall[];
  slabs:     IFCPreview3DSlab[];
  className?: string;
  onClose?:  () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extrude a 2-D footprint polygon into a 3-D solid standing upright. */
function buildExtrudedMesh(
  footprint_mm: [number, number][],
  height_mm:    number,
  baseElev_mm:  number,
  mat:          THREE.Material,
): THREE.Mesh | null {
  if (!footprint_mm || footprint_mm.length < 3) return null;

  const shape = new THREE.Shape();
  shape.moveTo(footprint_mm[0][0] * MM, footprint_mm[0][1] * MM);
  for (let i = 1; i < footprint_mm.length; i++) {
    shape.lineTo(footprint_mm[i][0] * MM, footprint_mm[i][1] * MM);
  }
  shape.closePath();

  const depth = Math.max(1, height_mm) * MM;
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });

  // ExtrudeGeometry extrudes along local +Z.
  // Rotate -90° around X so plan XY → world XZ, and extrude goes world +Y (up).
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, baseElev_mm * MM, 0);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow    = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ── Component ──────────────────────────────────────────────────────────────
export function IFCPreview3D({ walls, slabs, className, onClose }: IFCPreview3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  // Floating window drag state
  const [pos, setPos]   = useState({ x: 24, y: 60 });
  const [size, setSize] = useState({ w: 400, h: 320 });
  const winDrag = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null);

  // Three.js refs
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef    = useRef<THREE.Scene | null>(null);
  const cameraRef   = useRef<THREE.PerspectiveCamera | null>(null);
  const rafRef      = useRef<number>(0);
  const wallGroupRef = useRef<THREE.Group | null>(null);

  // Orbit state
  const orbit = useRef({ phi: Math.PI / 4, theta: -Math.PI / 6, r: 30 });
  const orbitDrag  = useRef<{ x: number; y: number } | null>(null);
  const panDrag    = useRef<{ x: number; y: number; cx: number; cy: number; cz: number } | null>(null);
  const targetRef  = useRef(new THREE.Vector3(0, 0, 0));

  // ── Scene init ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    scene.fog        = new THREE.FogExp2(0x0f172a, 0.018);
    sceneRef.current = scene;

    // Camera
    const cam = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.1, 500);
    cam.position.set(15, 12, 15);
    cameraRef.current = cam;

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff8e7, 1.2);
    sun.position.set(20, 40, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xc7d2fe, 0.5);
    fill.position.set(-15, 10, -10);
    scene.add(fill);

    // Ground grid
    const grid = new THREE.GridHelper(60, 60, 0x1e293b, 0x1e293b);
    scene.add(grid);

    // Wall group
    const wallGroup = new THREE.Group();
    scene.add(wallGroup);
    wallGroupRef.current = wallGroup;

    // Render loop
    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      const { phi, theta, r } = orbit.current;
      const t = targetRef.current;
      cam.position.set(
        t.x + r * Math.sin(phi) * Math.cos(theta),
        t.y + r * Math.cos(phi),
        t.z + r * Math.sin(phi) * Math.sin(theta),
      );
      cam.lookAt(t);
      renderer.render(scene, cam);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafRef.current);
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []); // mount once

  // ── Resize renderer when window size changes ─────────────────────────
  useEffect(() => {
    const el = mountRef.current;
    const renderer = rendererRef.current;
    const cam      = cameraRef.current;
    if (!el || !renderer || !cam) return;
    renderer.setSize(el.clientWidth, el.clientHeight);
    cam.aspect = el.clientWidth / el.clientHeight;
    cam.updateProjectionMatrix();
  }, [size]);

  // ── Rebuild all meshes when walls or slabs change ────────────────────
  useEffect(() => {
    const group = wallGroupRef.current;
    if (!group) return;

    group.clear();

    const totalElements = walls.length + slabs.length;
    if (totalElements === 0) return;

    // Wall materials — opaque, per storey
    const wallMats = WALL_MAT_COLORS.map(
      (c) => new THREE.MeshLambertMaterial({ color: c, transparent: true, opacity: 0.88 }),
    );
    // Slab materials — slightly lighter, semi-transparent
    const slabMats = SLAB_MAT_COLORS.map(
      (c) => new THREE.MeshLambertMaterial({ color: c, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
    );

    let sumX = 0, sumY = 0, sumZ = 0, cnt = 0;

    // ── Walls ──────────────────────────────────────────────────────────
    for (const entry of walls) {
      const { wall, storeyIdx, elevationMm } = entry;
      const mat  = wallMats[storeyIdx % wallMats.length];
      const mesh = buildExtrudedMesh(
        wall.footprint_mm,
        Math.max(100, wall.height_mm),
        elevationMm,
        mat,
      );
      if (mesh) {
        group.add(mesh);
        const bb = new THREE.Box3().setFromObject(mesh);
        const c  = bb.getCenter(new THREE.Vector3());
        sumX += c.x; sumY += c.y; sumZ += c.z; cnt++;
      }
    }

    // ── Slabs ──────────────────────────────────────────────────────────
    for (const entry of slabs) {
      const { slab, storeyIdx } = entry;
      const mat  = slabMats[storeyIdx % slabMats.length];
      const mesh = buildExtrudedMesh(
        slab.footprint_mm,
        Math.max(10, slab.thickness_mm),
        slab.baseElevation_mm,
        mat,
      );
      if (mesh) {
        group.add(mesh);
        const bb = new THREE.Box3().setFromObject(mesh);
        const c  = bb.getCenter(new THREE.Vector3());
        sumX += c.x; sumY += c.y; sumZ += c.z; cnt++;
      }
    }

    if (cnt > 0) {
      targetRef.current.set(sumX / cnt, sumY / cnt, sumZ / cnt);
      const bb = new THREE.Box3().setFromObject(group);
      const sz = bb.getSize(new THREE.Vector3());
      orbit.current.r = Math.max(sz.x, sz.z) * 0.9;
    }
  }, [walls, slabs]);

  // ── Canvas mouse: orbit + pan + zoom ─────────────────────────────────
  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.button === 0) {
      orbitDrag.current = { x: e.clientX, y: e.clientY };
    } else if (e.button === 2) {
      const t = targetRef.current;
      panDrag.current = { x: e.clientX, y: e.clientY, cx: t.x, cy: t.y, cz: t.z };
    }
  }, []);

  const onCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    if (orbitDrag.current) {
      const dx = e.clientX - orbitDrag.current.x;
      const dy = e.clientY - orbitDrag.current.y;
      orbitDrag.current = { x: e.clientX, y: e.clientY };
      orbit.current.theta -= dx * 0.008;
      orbit.current.phi    = Math.max(0.05, Math.min(Math.PI * 0.48, orbit.current.phi + dy * 0.008));
    }
    if (panDrag.current) {
      const dx = (e.clientX - panDrag.current.x) * 0.01 * (orbit.current.r / 20);
      const dy = (e.clientY - panDrag.current.y) * 0.01 * (orbit.current.r / 20);
      const t  = targetRef.current;
      const theta = orbit.current.theta;
      // Move target perpendicular to view direction in XZ plane
      t.x = panDrag.current.cx - dx * Math.cos(theta) + dy * Math.sin(theta) * 0.3;
      t.z = panDrag.current.cz + dx * Math.sin(theta) + dy * Math.cos(theta) * 0.3;
    }
  }, []);

  const onCanvasMouseUp = useCallback(() => {
    orbitDrag.current = null;
    panDrag.current   = null;
  }, []);

  const onCanvasWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
    orbit.current.r = Math.max(1, Math.min(200, orbit.current.r * (e.deltaY > 0 ? 1.12 : 0.89)));
  }, []);

  const onCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // ── Floating window drag ──────────────────────────────────────────────
  const onTitleMouseDown = useCallback((e: React.MouseEvent) => {
    winDrag.current = { ox: e.clientX, oy: e.clientY, px: pos.x, py: pos.y };
    e.preventDefault();
  }, [pos]);

  const onWindowMouseMove = useCallback((e: MouseEvent) => {
    if (!winDrag.current) return;
    setPos({
      x: winDrag.current.px + e.clientX - winDrag.current.ox,
      y: winDrag.current.py + e.clientY - winDrag.current.oy,
    });
  }, []);

  const onWindowMouseUp = useCallback(() => {
    winDrag.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup',  onWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup',  onWindowMouseUp);
    };
  }, [onWindowMouseMove, onWindowMouseUp]);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div
      className={cn('absolute z-50 flex flex-col rounded-lg overflow-hidden shadow-2xl border border-slate-700', className)}
      style={{
        left:    pos.x,
        top:     pos.y,
        width:   size.w,
        height:  size.h,
        resize:  'both',
        minWidth: 260,
        minHeight: 200,
        background: '#0f172a',
      }}
      onMouseUp={(e) => e.stopPropagation()}
    >
      {/* Title bar */}
      <div
        className="flex items-center justify-between px-3 py-1.5 bg-slate-800 border-b border-slate-700 flex-shrink-0 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onTitleMouseDown}
      >
        <span className="text-xs text-slate-300 font-medium">⬡ Preview 3D — {walls.length} pereți · {slabs.length} plăci</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">LMB orbit · RMB pan · scroll zoom</span>
          {onClose && (
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-red-400 transition-colors text-sm leading-none px-1"
              onMouseDown={(e) => e.stopPropagation()}
            >✕</button>
          )}
        </div>
      </div>

      {/* Three.js canvas mount */}
      <div
        ref={mountRef}
        className="flex-1"
        onMouseDown={onCanvasMouseDown}
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onMouseLeave={onCanvasMouseUp}
        onWheel={onCanvasWheel}
        onContextMenu={onCanvasContextMenu}
        style={{ cursor: 'grab' }}
      />

      {/* Resize handle hint */}
      <div className="absolute bottom-1 right-1 text-slate-600 text-xs pointer-events-none select-none">⤡</div>
    </div>
  );
}
