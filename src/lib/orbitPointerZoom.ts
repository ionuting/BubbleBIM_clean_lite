/**
 * Zoom-at-cursor for the hand-rolled orbit cameras (3D, FEM, BREP viewers).
 *
 * Those cameras are `{ theta, phi, radius }` around a `target`, and their wheel
 * handlers used to scale `radius` alone — which always pulls toward the target,
 * i.e. the centre of the view. Whatever you point at slides away as you zoom.
 *
 * Here the point under the cursor (the *pivot*) stays put instead. Scaling the
 * radius by `f` while moving the target to `pivot + f·(target − pivot)` leaves
 * the camera at `pivot + f·(camera − pivot)`: same viewing direction, same ray
 * through the pivot, so the pivot holds its exact screen position. Because the
 * transform is a pure scale about the pivot, zooming in and back out returns to
 * where you started.
 */
import * as THREE from 'three';

export interface OrbitState { theta: number; phi: number; radius: number }

export interface PointerZoomConfig {
  /** The canvas the wheel events land on — used to map clientX/Y to NDC. */
  dom: HTMLElement;
  camera: THREE.PerspectiveCamera;
  /** Raycast against this to find what the cursor is over. */
  scene: THREE.Scene;
  /** Mutated in place: `radius`. */
  state: OrbitState;
  /** Mutated in place: panned so the pivot stays under the cursor. */
  target: THREE.Vector3;
  minRadius: number;
  maxRadius: number;
  /** Radius multiplier per wheel notch (default 1.1). */
  step?: number;
}

/** Same gesture = same pivot: a continuous scroll must not hop between objects. */
const GESTURE_MS = 250;
const GESTURE_PX = 6;

/**
 * Build a `wheel` handler that zooms toward the cursor. Call it from the
 * viewer's own listener, then run that viewer's camera-placement function —
 * this only updates `state.radius` and `target`, so it stays agnostic about how
 * the camera is finally positioned (Y-up vs Z-up, lookAt vs quaternion).
 */
export function createPointerZoom(cfg: PointerZoomConfig): (e: WheelEvent) => void {
  const step = cfg.step ?? 1.1;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane();
  const normal = new THREE.Vector3();

  let lastPivot: THREE.Vector3 | null = null;
  let lastTime = 0;
  let lastX = 0;
  let lastY = 0;

  const pickPivot = (e: WheelEvent): THREE.Vector3 => {
    const rect = cfg.dom.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, cfg.camera);
    // Lines (grid, FEM frame elements) need a world-space pick radius; tie it to
    // the zoom level so it doesn't swallow the view when zoomed far out.
    raycaster.params.Line.threshold = cfg.state.radius * 0.005;
    raycaster.params.Points.threshold = cfg.state.radius * 0.005;

    for (const hit of raycaster.intersectObjects(cfg.scene.children, true)) {
      let o: THREE.Object3D | null = hit.object;
      let hidden = false;
      while (o) { if (!o.visible) { hidden = true; break; } o = o.parent; }
      if (!hidden) return hit.point.clone();
    }

    // Nothing under the cursor — fall back to the plane through the target
    // facing the camera, so empty space still zooms where you point.
    normal.subVectors(cfg.camera.position, cfg.target).normalize();
    plane.setFromNormalAndCoplanarPoint(normal, cfg.target);
    const p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, p) ? p : cfg.target.clone();
  };

  return (e: WheelEvent) => {
    const now = e.timeStamp;
    const continuing = lastPivot !== null
      && now - lastTime < GESTURE_MS
      && Math.abs(e.clientX - lastX) < GESTURE_PX
      && Math.abs(e.clientY - lastY) < GESTURE_PX;

    const pivot = continuing ? lastPivot! : pickPivot(e);
    lastPivot = pivot;
    lastTime = now;
    lastX = e.clientX;
    lastY = e.clientY;

    const wanted = cfg.state.radius * (e.deltaY > 0 ? step : 1 / step);
    const next = Math.max(cfg.minRadius, Math.min(cfg.maxRadius, wanted));
    // Use the factor actually applied — at the clamp the target must not drift.
    const f = next / cfg.state.radius;
    cfg.state.radius = next;
    if (f === 1) return;

    cfg.target.set(
      pivot.x + (cfg.target.x - pivot.x) * f,
      pivot.y + (cfg.target.y - pivot.y) * f,
      pivot.z + (cfg.target.z - pivot.z) * f,
    );
  };
}
