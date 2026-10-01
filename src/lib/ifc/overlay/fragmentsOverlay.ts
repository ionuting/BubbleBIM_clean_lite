/**
 * fragmentsOverlay.ts — a Three.js layer that rides on top of Cesium.
 *
 * Variant A of the World view. Cesium draws the globe, terrain and imagery;
 * this draws the IFC, with fragments streaming its own tiles, on a
 * transparent canvas stacked over Cesium's. The two look like one scene
 * because the camera is copied across on every frame (`cameraSync.ts` does
 * that arithmetic, and explains why it is done in a local frame).
 *
 * What this buys over baking the model into glTF: fragments keeps its tile
 * streaming and its level of detail, because it finally has a camera to
 * stream against. The same Highlighter the TOC viewer uses works here, so an
 * element can actually light up when you pick it. And the drawing code stops
 * being a second implementation of the first.
 *
 * What it costs, and this is deliberate rather than overlooked: the two
 * renderers own SEPARATE depth buffers. Nothing this layer draws can be
 * hidden by terrain, and nothing Cesium draws can hide it. A building
 * standing on its own site reads correctly; a building behind a hill does
 * not. Compositing the two depth buffers is possible and is a separate piece
 * of work — see the 3D Tiles variant, which gets depth for free by giving up
 * everything else on this list.
 */

import * as THREE from 'three';
import {
  enuBasis, needsReanchor, syncCamera,
  type CesiumCameraState, type EnuBasis, type ThreeCameraPose,
} from './cameraSync';

export interface OverlayAnchor { lat: number; lng: number; alt: number }

export interface FragmentsOverlayOptions {
  /** Pixel ratio cap. Two renderers at full retina is a lot of fill rate. */
  maxPixelRatio?: number;
}

export class FragmentsOverlay {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10_000);
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly container: HTMLElement;
  private basis: EnuBasis;
  private anchor: OverlayAnchor;
  private disposed = false;

  constructor(container: HTMLElement, anchor: OverlayAnchor, opts: FragmentsOverlayOptions = {}) {
    this.container = container;
    this.anchor = anchor;
    this.basis = enuBasis(anchor.lat, anchor.lng, anchor.alt);

    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      // Clicks belong to Cesium: it owns navigation, and picking this layer
      // is done by raycasting from the shared camera, not by the DOM.
      pointerEvents: 'none',
      zIndex: '1',
    } as Partial<CSSStyleDeclaration>);
    container.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,            // the globe has to show through
      antialias: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.maxPixelRatio ?? 2));
    this.renderer.autoClear = true;

    // Lighting that reads on a model seen from any bearing. Cesium's own sun
    // is not shared across contexts, so this layer carries its own.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x555560, 2.2);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.6, 1, 0.4);
    this.scene.add(hemi, key);

    this.resize();
  }

  /** The frame the scene is drawn in. Consumers place objects relative to it. */
  get enu(): EnuBasis { return this.basis; }
  get anchorPoint(): OverlayAnchor { return this.anchor; }

  /**
   * Move the scene's origin. Everything already in the scene is expressed
   * relative to the old anchor, so the caller has to re-place its objects —
   * which is why this returns the new basis rather than pretending it can fix
   * the scene itself.
   */
  setAnchor(anchor: OverlayAnchor): EnuBasis {
    this.anchor = anchor;
    this.basis = enuBasis(anchor.lat, anchor.lng, anchor.alt);
    return this.basis;
  }

  /** True when the camera has strayed far enough that float32 starts to show. */
  shouldReanchor(cam: CesiumCameraState): boolean {
    return needsReanchor(cam, this.basis);
  }

  resize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Copy Cesium's camera onto ours. Call once per frame, before `render`. */
  applyCamera(cam: CesiumCameraState): ThreeCameraPose {
    const pose = syncCamera(cam, this.basis);
    this.camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.camera.up.set(pose.up.x, pose.up.y, pose.up.z);
    this.camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
    this.camera.fov = pose.fovDeg;
    this.camera.aspect = pose.aspect;
    this.camera.near = pose.near;
    this.camera.far = pose.far;
    this.camera.updateProjectionMatrix();
    return pose;
  }

  render(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  /** Hide the layer without tearing it down — the mode switch uses this. */
  setVisible(v: boolean): void {
    this.canvas.style.display = v ? '' : 'none';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/**
 * Where a model stands inside the overlay scene.
 *
 * `offsetE/N/U` are metres from the scene's anchor and `headingDeg` is
 * clockwise from north, matching `WorldLocation`. The rotation sign is the
 * one place this is easy to get backwards: Three's positive rotation about
 * +y sends +z towards +x, while the model's north is −z and a positive
 * heading turns north towards east. The two conventions meet at a negated
 * angle, and a test pins it.
 */
export function placeInOverlay(
  object: THREE.Object3D,
  offsetE: number, offsetN: number, offsetU: number,
  headingDeg: number,
): void {
  object.position.set(offsetE, offsetU, -offsetN);
  object.rotation.set(0, (-headingDeg * Math.PI) / 180, 0);
  object.updateMatrixWorld(true);
}

/** Marks the node that stands in for one model in the overlay scene. */
export const OVERLAY_MODEL_KEY = 'ifcModelId';

/**
 * The node the overlay scene holds for one model: a wrapper that takes the
 * placement, with the model's own object inside it carrying the transform
 * back to the file's project coordinates.
 *
 * Two levels because they answer two different questions. The wrapper is
 * WHERE the model stands — `placeInOverlay` writes it, and it is the same
 * matrix the glTF mode hands Cesium. The inner transform is what the model's
 * stored geometry needs to become IFC coordinates (`modelToProjectMatrix`),
 * and it turns with the model, which a single flattened offset would not do
 * once the heading is anything but zero. Writing the placement straight onto
 * the model's object, as this once did, threw the inner transform away and
 * drew the model shifted by the file's own coordination offset — visibly
 * somewhere else from the glTF of the same file.
 *
 * Re-parents `object` if it is already inside an older wrapper.
 */
export function overlayNodeFor(
  object: THREE.Object3D,
  toProject: THREE.Matrix4,
  modelId: string,
): THREE.Group {
  const node = new THREE.Group();
  node.name = `overlay:${modelId}`;
  node.userData[OVERLAY_MODEL_KEY] = modelId;
  toProject.decompose(object.position, object.quaternion, object.scale);
  node.add(object);
  node.updateMatrixWorld(true);
  return node;
}
