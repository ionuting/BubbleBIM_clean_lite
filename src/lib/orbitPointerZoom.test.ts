/**
 * The whole point of zoom-at-cursor is one invariant: the point under the
 * cursor must not move on screen. These tests assert that directly — project
 * the pivot before and after the wheel event and compare screen positions —
 * rather than checking that some intermediate number changed.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createPointerZoom, type OrbitState } from './orbitPointerZoom';

const W = 800;
const H = 600;

/** Stands in for renderer.domElement — the handler only needs its rect. */
const fakeDom = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
} as unknown as HTMLElement;

/** The handler reads only these fields off the event. */
const wheel = (clientX: number, clientY: number, deltaY: number, timeStamp = 0) =>
  ({ clientX, clientY, deltaY, timeStamp }) as unknown as WheelEvent;

/** Same orbit placement the viewers use. */
function place(camera: THREE.PerspectiveCamera, st: OrbitState, t: THREE.Vector3) {
  camera.position.set(
    t.x + st.radius * Math.sin(st.phi) * Math.sin(st.theta),
    t.y + st.radius * Math.cos(st.phi),
    t.z + st.radius * Math.sin(st.phi) * Math.cos(st.theta),
  );
  camera.lookAt(t);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
}

/** Where a world point lands on screen, in pixels. */
function toScreen(p: THREE.Vector3, camera: THREE.PerspectiveCamera) {
  const v = p.clone().project(camera);
  return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
}

function harness(sceneObjects: THREE.Object3D[] = []) {
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.01, 10000);
  const scene = new THREE.Scene();
  for (const o of sceneObjects) scene.add(o);
  const state: OrbitState = { theta: -Math.PI / 4, phi: 1.1, radius: 10 };
  const target = new THREE.Vector3(0, 0, 0);
  place(camera, state, target);
  const zoom = createPointerZoom({
    dom: fakeDom, camera, scene, state, target, minRadius: 1, maxRadius: 1000,
  });
  return { camera, scene, state, target, zoom, step: () => place(camera, state, target) };
}

describe('zoom keeps the cursor point fixed', () => {
  it.each([
    ['top-left', 120, 90],
    ['off-centre', 610, 180],
    ['dead centre', W / 2, H / 2],
    ['bottom edge', 400, 560],
  ])('zooming in at %s does not move that point', (_label, cx, cy) => {
    const h = harness();
    // The pivot is whatever the cursor is over before the wheel turns.
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((cx / W) * 2 - 1, -(cy / H) * 2 + 1), h.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3().subVectors(h.camera.position, h.target).normalize(), h.target,
    );
    const pivot = ray.ray.intersectPlane(plane, new THREE.Vector3())!;
    expect(pivot).not.toBeNull();

    h.zoom(wheel(cx, cy, -100));
    h.step();

    const after = toScreen(pivot, h.camera);
    expect(after.x).toBeCloseTo(cx, 3);
    expect(after.y).toBeCloseTo(cy, 3);
  });

  it('holds through a whole continuous scroll gesture', () => {
    const h = harness();
    const cx = 640, cy = 150;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((cx / W) * 2 - 1, -(cy / H) * 2 + 1), h.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3().subVectors(h.camera.position, h.target).normalize(), h.target,
    );
    const pivot = ray.ray.intersectPlane(plane, new THREE.Vector3())!;

    for (let i = 0; i < 8; i++) { h.zoom(wheel(cx, cy, -100, i * 40)); h.step(); }

    expect(h.state.radius).toBeLessThan(10);
    const after = toScreen(pivot, h.camera);
    expect(after.x).toBeCloseTo(cx, 2);
    expect(after.y).toBeCloseTo(cy, 2);
  });

  it('zooms toward the object under the cursor, not the view centre', () => {
    // A box parked well off to one side; pointing at it must approach IT.
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    box.position.set(4, 0, 0);
    box.updateMatrixWorld(true);
    const h = harness([box]);

    const screenPos = toScreen(box.position, h.camera);
    const before = h.camera.position.distanceTo(box.position);
    for (let i = 0; i < 5; i++) { h.zoom(wheel(screenPos.x, screenPos.y, -100, i * 40)); h.step(); }
    const after = h.camera.position.distanceTo(box.position);

    expect(after).toBeLessThan(before * 0.7);
    // ...and the box stays where it was on screen.
    const nowAt = toScreen(box.position, h.camera);
    expect(nowAt.x).toBeCloseTo(screenPos.x, 1);
    expect(nowAt.y).toBeCloseTo(screenPos.y, 1);
  });
});

describe('regressions the old center-only zoom would have passed', () => {
  it('actually pans the target — the bug was that it never moved', () => {
    const h = harness();
    h.zoom(wheel(700, 100, -100));
    expect(h.target.length()).toBeGreaterThan(0.1);
  });

  it('zoom in then back out at the same spot returns to the start', () => {
    const h = harness();
    const t0 = h.target.clone();
    const r0 = h.state.radius;
    h.zoom(wheel(650, 200, -100, 0));
    h.step();
    h.zoom(wheel(650, 200, 100, 40)); // same gesture → same pivot → exact inverse
    h.step();
    expect(h.state.radius).toBeCloseTo(r0, 6);
    expect(h.target.distanceTo(t0)).toBeLessThan(1e-6);
  });

  it('does not drift the target once the radius is clamped', () => {
    const h = harness();
    h.state.radius = 1; // already at minRadius
    h.step();
    const t0 = h.target.clone();
    h.zoom(wheel(700, 120, -100));
    expect(h.state.radius).toBe(1);
    expect(h.target.distanceTo(t0)).toBe(0);
  });

  it('a new gesture at a new spot picks a fresh pivot', () => {
    const h = harness();
    h.zoom(wheel(200, 200, -100, 0));
    h.step();
    const t1 = h.target.clone();
    // Far away in space and time → must not reuse the previous pivot.
    h.zoom(wheel(700, 500, -100, 5000));
    h.step();
    expect(h.target.distanceTo(t1)).toBeGreaterThan(0);
  });

  it('ignores objects hidden by the visibility filter', () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    box.position.set(4, 0, 0);
    box.visible = false; // filtered out in the UI — must not become a zoom pivot
    box.updateMatrixWorld(true);
    const h = harness([box]);
    const at = toScreen(box.position, h.camera);

    const visible = new THREE.Vector3();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((at.x / W) * 2 - 1, -(at.y / H) * 2 + 1), h.camera);
    ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3().subVectors(h.camera.position, h.target).normalize(), h.target,
    ), visible);

    h.zoom(wheel(at.x, at.y, -100));
    h.step();
    // Fell back to the target plane, so THAT point is what stayed put.
    const after = toScreen(visible, h.camera);
    expect(after.x).toBeCloseTo(at.x, 2);
    expect(after.y).toBeCloseTo(at.y, 2);
  });
});
