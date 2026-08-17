/**
 * IFC3DFloatingPanel — Draggable/resizable floating 3D perspective viewer.
 *
 * Renders the **same** Three.js scene as the 2D plan view using the **same**
 * WebGLRenderer (same GPU context). Renders to a WebGLRenderTarget and copies
 * pixels to a 2D canvas. This means any deformation applied in the plan view
 * is instantly visible here — no separate model loading.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const MIN_W = 280;
const MIN_H = 200;

interface IFC3DFloatingPanelProps {
  /** The Three.js scene from the 2D plan view. */
  scene:        THREE.Scene | null;
  /** The WebGLRenderer from the 2D plan view (same GPU context). */
  renderer:     THREE.WebGLRenderer | null;
  clipBottomM?: number;
  clipTopM?:    number;
  onClose:      () => void;
}

export function IFC3DFloatingPanel({
  scene,
  renderer,
  clipBottomM,
  clipTopM,
  onClose,
}: IFC3DFloatingPanelProps) {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const ctxRef        = useRef<CanvasRenderingContext2D | null>(null);
  const cameraRef     = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef   = useRef<OrbitControls | null>(null);
  const targetRef     = useRef<THREE.WebGLRenderTarget | null>(null);
  const rafRef        = useRef(0);
  const containerRef  = useRef<HTMLDivElement>(null);

  // ── Panel position / size state ──────────────────────────────────────
  const [pos, setPos]   = useState({ x: 20, y: 60 });
  const [size, setSize] = useState({ w: 420, h: 320 });
  const dragRef   = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);

  // Stable refs for render loop
  const sceneRef    = useRef(scene);
  const rendererRef = useRef(renderer);
  useEffect(() => { sceneRef.current = scene; }, [scene]);
  useEffect(() => { rendererRef.current = renderer; }, [renderer]);

  // Clip planes ref
  const clipPlanesRef = useRef<THREE.Plane[]>([]);
  useEffect(() => {
    if (clipBottomM != null && clipTopM != null) {
      clipPlanesRef.current = [
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -clipBottomM),
        new THREE.Plane(new THREE.Vector3(0, -1, 0),  clipTopM),
      ];
    } else {
      clipPlanesRef.current = [];
    }
  }, [clipBottomM, clipTopM]);

  // ── Init camera + controls + render target ───────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // 2D canvas context for pixel output
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctxRef.current = ctx;

    // Camera
    const cw = container.clientWidth || MIN_W;
    const ch = (container.clientHeight || MIN_H) - 28; // subtract title bar
    const aspect = cw / Math.max(ch, 1);
    const camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 2000);
    camera.position.set(15, 20, 25);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    // Orbit controls — attached to canvas for mouse input
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance   = 1;
    controls.maxDistance   = 500;
    controlsRef.current   = controls;

    // Render target
    const dpr = Math.min(window.devicePixelRatio, 2);
    const tw = Math.round(cw * dpr);
    const th = Math.round(ch * dpr);
    const target = new THREE.WebGLRenderTarget(tw, th, {
      format:    THREE.RGBAFormat,
      type:      THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    targetRef.current = target;

    // Set canvas size
    canvas.width  = tw;
    canvas.height = th;
    canvas.style.width  = `${cw}px`;
    canvas.style.height = `${ch}px`;

    // Pixel buffer for readback
    let pixelBuf = new Uint8Array(tw * th * 4);

    // Render loop
    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      controls.update();

      const r = rendererRef.current;
      const s = sceneRef.current;
      if (!r || !s) return;

      // Save renderer state
      const prevRT = r.getRenderTarget();
      const prevClip = r.clippingPlanes;
      const prevBg = s.background;

      // Set our clip planes and background
      r.clippingPlanes = clipPlanesRef.current;
      s.background = new THREE.Color(0x1e293b);

      // Render to our target
      r.setRenderTarget(target);
      r.clear(true, true, true);
      r.render(s, camera);

      // Restore renderer state
      r.setRenderTarget(prevRT);
      r.clippingPlanes = prevClip;
      s.background = prevBg;

      // Read pixels and paint to 2D canvas
      r.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixelBuf);

      // Flip Y — WebGL renders bottom-up, canvas is top-down
      const w = target.width;
      const h = target.height;
      const rowSize = w * 4;
      const flipped = new Uint8ClampedArray(pixelBuf.length);
      for (let y = 0; y < h; y++) {
        const srcOff = y * rowSize;
        const dstOff = (h - 1 - y) * rowSize;
        flipped.set(pixelBuf.subarray(srcOff, srcOff + rowSize), dstOff);
      }
      const imageData = new ImageData(flipped, w, h);
      ctx.putImageData(imageData, 0, 0);
    };
    rafRef.current = requestAnimationFrame(animate);

    // Resize handler
    const obs = new ResizeObserver(() => {
      const newCw = container.clientWidth || MIN_W;
      const newCh = Math.max((container.clientHeight || MIN_H) - 28, 10);
      const newAspect = newCw / newCh;
      camera.aspect = newAspect;
      camera.updateProjectionMatrix();

      const nDpr = Math.min(window.devicePixelRatio, 2);
      const ntw = Math.round(newCw * nDpr);
      const nth = Math.round(newCh * nDpr);
      target.setSize(ntw, nth);

      canvas.width  = ntw;
      canvas.height = nth;
      canvas.style.width  = `${newCw}px`;
      canvas.style.height = `${newCh}px`;

      pixelBuf = new Uint8Array(ntw * nth * 4);
    });
    obs.observe(container);

    return () => {
      cancelAnimationFrame(rafRef.current);
      obs.disconnect();
      controls.dispose();
      target.dispose();
      ctxRef.current   = null;
      cameraRef.current    = null;
      controlsRef.current  = null;
      targetRef.current    = null;
    };
  }, []);

  // ── Fit camera when scene first appears ──────────────────────────────
  useEffect(() => {
    if (!scene || !cameraRef.current || !controlsRef.current) return;

    const box = new THREE.Box3().setFromObject(scene);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const sz     = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(sz.x, sz.y, sz.z);
    const dist   = maxDim * 1.8;

    cameraRef.current.position.set(center.x + dist * 0.5, center.y + dist * 0.6, center.z + dist * 0.5);
    cameraRef.current.lookAt(center);
    cameraRef.current.updateProjectionMatrix();

    controlsRef.current.target.copy(center);
    controlsRef.current.update();
  }, [scene]);

  // ── Drag (title bar) ────────────────────────────────────────────────
  const onDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPosX: pos.x, startPosY: pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [pos]);

  const onDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPos({ x: dragRef.current.startPosX + dx, y: dragRef.current.startPosY + dy });
  }, []);

  const onDragEnd = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  // ── Resize (bottom-right handle) ─────────────────────────────────────
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [size]);

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const dx = e.clientX - resizeRef.current.startX;
    const dy = e.clientY - resizeRef.current.startY;
    setSize({
      w: Math.max(MIN_W, resizeRef.current.startW + dx),
      h: Math.max(MIN_H, resizeRef.current.startH + dy),
    });
  }, []);

  const onResizeEnd = useCallback((e: React.PointerEvent) => {
    resizeRef.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute z-30 rounded-lg shadow-2xl border border-slate-700 overflow-hidden flex flex-col"
      style={{
        left: pos.x, top: pos.y,
        width: size.w, height: size.h,
        background: '#1e293b',
      }}
    >
      {/* Title bar — draggable */}
      <div
        className="flex items-center justify-between px-2 py-1 bg-slate-800 border-b border-slate-700 cursor-move select-none flex-shrink-0"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
      >
        <span className="text-xs text-slate-300 font-medium">⬡ 3D View</span>
        <button
          onClick={onClose}
          className="text-xs text-slate-500 hover:text-slate-200 px-1"
          onPointerDown={(e) => e.stopPropagation()}
        >✕</button>
      </div>

      {/* Shared-scene 3D canvas (2D context, pixels from render target) */}
      <div className="flex-1 relative overflow-hidden">
        <canvas ref={canvasRef} className="w-full h-full block" />
        {(!scene || !renderer) && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs">
            Loading model…
          </div>
        )}
      </div>

      {/* Resize handle — bottom-right */}
      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
      >
        <svg className="w-3 h-3 text-slate-600 ml-1 mt-1" viewBox="0 0 6 6">
          <circle cx="5" cy="1" r="0.8" fill="currentColor" />
          <circle cx="3" cy="3" r="0.8" fill="currentColor" />
          <circle cx="5" cy="3" r="0.8" fill="currentColor" />
          <circle cx="1" cy="5" r="0.8" fill="currentColor" />
          <circle cx="3" cy="5" r="0.8" fill="currentColor" />
          <circle cx="5" cy="5" r="0.8" fill="currentColor" />
        </svg>
      </div>
    </div>
  );
}
