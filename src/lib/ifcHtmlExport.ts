/**
 * ifcHtmlExport.ts — Export IFC models loaded in the That Open viewer as a
 * single self-contained HTML file with the geometry embedded as GLB.
 *
 * Fragments models render through LOD tiles with custom materials, so
 * exporting `model.object` directly is unreliable. Instead we read the full
 * geometry through the fragments API (getItemsGeometry / getItemsMaterialDefinition),
 * bake it to world space, merge it per material and run GLTFExporter on that.
 *
 * The HTML inlines three.js r128 + GLTFLoader (fetched at export time, CDN
 * <script src> fallback when offline) and the GLB as base64, so it opens from
 * file:// with no server and no sibling files.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const THREE_URL       = 'https://unpkg.com/three@0.128.0/build/three.min.js';
const GLTF_LOADER_URL = 'https://unpkg.com/three@0.128.0/examples/js/loaders/GLTFLoader.js';

/** Fragments MeshData normals are Int16 normalised to ±32767. */
const NORMAL_SCALE = 1 / 32767;
/** Items per worker request — keeps individual messages to a sane size. */
const CHUNK = 500;

interface MeshDataLike {
  transform: THREE.Matrix4;
  indices?: ArrayLike<number>;
  positions?: ArrayLike<number>;
  normals?: ArrayLike<number>;
}

interface MaterialDefinitionLike {
  color: { r: number; g: number; b: number };
  opacity: number;
  transparent: boolean;
  renderedFaces?: number;
}

/** The subset of @thatopen/fragments FragmentsModel this module needs. */
export interface FragmentsModelLike {
  modelId: string;
  object: THREE.Object3D;
  getItemsIdsWithGeometry(): Promise<number[]>;
  getItemsMaterialDefinition(localIds: number[]): Promise<{ definition: MaterialDefinitionLike; localIds: number[] }[]>;
  getItemsGeometry(localIds: number[]): Promise<MeshDataLike[][]>;
}

/** Bake every item of the given models into a scene of world-space meshes, one per material. */
export async function buildSceneFromFragments(models: FragmentsModelLike[]): Promise<{ scene: THREE.Scene; triangles: number }> {
  const scene = new THREE.Scene();
  let triangles = 0;
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();

  for (const model of models) {
    model.object.updateMatrixWorld(true);
    const ids = await model.getItemsIdsWithGeometry();
    if (!ids.length) continue;
    const groups = await model.getItemsMaterialDefinition(ids);

    for (let gi = 0; gi < groups.length; gi++) {
      const { definition, localIds } = groups[gi]!;
      const pos: number[] = [];
      const nor: number[] = [];
      const idx: number[] = [];

      for (let c = 0; c < localIds.length; c += CHUNK) {
        const perItem = await model.getItemsGeometry(localIds.slice(c, c + CHUNK));
        for (const meshes of perItem) {
          for (const mesh of meshes) {
            const { positions, indices, normals } = mesh;
            if (!positions || !indices || !positions.length) continue;
            m.multiplyMatrices(model.object.matrixWorld, mesh.transform);
            nm.getNormalMatrix(m);
            const base = pos.length / 3;
            for (let i = 0; i < positions.length; i += 3) {
              v.set(positions[i]!, positions[i + 1]!, positions[i + 2]!).applyMatrix4(m);
              pos.push(v.x, v.y, v.z);
              if (normals && normals.length === positions.length) {
                v.set(normals[i]! * NORMAL_SCALE, normals[i + 1]! * NORMAL_SCALE, normals[i + 2]! * NORMAL_SCALE)
                  .applyMatrix3(nm).normalize();
                nor.push(v.x, v.y, v.z);
              }
            }
            for (let i = 0; i < indices.length; i++) idx.push(indices[i]! + base);
          }
        }
      }
      if (!idx.length) continue;

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      if (nor.length === pos.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      else geo.computeVertexNormals();
      geo.setIndex(idx);
      triangles += idx.length / 3;

      const { r, g, b } = definition.color;
      const transparent = definition.transparent || definition.opacity < 1;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(r, g, b),
        roughness: 0.8,
        metalness: 0,
        transparent,
        opacity: definition.opacity ?? 1,
        // RenderedFaces.TWO === 1 in fragments' schema
        side: definition.renderedFaces === 1 ? THREE.DoubleSide : THREE.FrontSide,
        depthWrite: !transparent,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `${model.modelId}_mat${gi}`;
      scene.add(mesh);
    }
  }
  return { scene, triangles };
}

function sceneToGlb(scene: THREE.Scene): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(scene, (res) => resolve(res as ArrayBuffer), reject, { binary: true });
  });
}

async function fetchScript(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.text()).replace(/\/\/# sourceMappingURL=\S+/g, '');
  } catch {
    return null; // offline — the HTML falls back to <script src> at open time
  }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

/** Inline a script, or reference the CDN when it could not be fetched. */
function scriptTag(src: string | null, url: string): string {
  return src
    ? `<script>${src.replace(/<\/script/gi, '<\\/script')}<\/script>`
    : `<script src="${url}"><\/script>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Export the given fragments models as `<name>_viewer.html`.
 * Throws when the models contain no geometry.
 */
export async function exportFragmentsToHtml(models: FragmentsModelLike[], name: string): Promise<{ triangles: number; bytes: number }> {
  const { scene, triangles } = await buildSceneFromFragments(models);
  if (!triangles) throw new Error('No geometry found in the loaded IFC model(s).');

  const [glb, threeSrc, loaderSrc] = await Promise.all([
    sceneToGlb(scene),
    fetchScript(THREE_URL),
    fetchScript(GLTF_LOADER_URL),
  ]);
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
  });

  const html = buildViewerHtml(name, toBase64(glb), triangles, scriptTag(threeSrc, THREE_URL), scriptTag(loaderSrc, GLTF_LOADER_URL));
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${name || 'model'}_viewer.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { triangles, bytes: blob.size };
}

function buildViewerHtml(name: string, glbB64: string, triangles: number, threeTag: string, loaderTag: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(name)} — IFC Viewer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0e0e14; color: #e0e0e0; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; }
  #header { position: fixed; top: 0; left: 0; right: 0; z-index: 10; padding: 10px 16px; background: rgba(14,14,20,0.85); backdrop-filter: blur(8px); border-bottom: 1px solid #2a2a3a; display: flex; align-items: center; gap: 12px; }
  #header h1 { font-size: 14px; font-weight: 700; }
  #header .badge { font-size: 11px; color: #8888aa; }
  #header .info { margin-left: auto; font-size: 10px; color: #666; }
  canvas { width: 100%; height: 100%; display: block; touch-action: none; }
  #controls { position: fixed; bottom: 12px; right: 12px; font-size: 10px; color: #555; text-align: right; line-height: 1.6; pointer-events: none; }
  #loading { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: #0e0e14; z-index: 100; }
  #loading span { font-size: 14px; color: #888; }
</style>
</head>
<body>
<div id="loading"><span>Loading IFC model…</span></div>
<div id="header">
  <h1>${esc(name)}</h1>
  <span class="badge">IFC Export</span>
  <span class="info">${triangles.toLocaleString('en-US')} triangles</span>
</div>
<div id="controls">
  Left drag — orbit<br>
  Right drag — pan<br>
  Scroll — zoom
</div>
${threeTag}
${loaderTag}
<script>
var GLB_B64 = "${glbB64}";

function fail(msg) {
  document.querySelector('#loading span').textContent = msg;
}

(function () {
  if (!window.THREE || !THREE.GLTFLoader) { fail('Could not load three.js — check your internet connection.'); return; }

  var bin = atob(GLB_B64), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12121e);
  var camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 5000);
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 0.8));
  var sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(30, 60, 40);
  scene.add(sun);

  var target = new THREE.Vector3();
  var spherical = new THREE.Spherical();

  new THREE.GLTFLoader().parse(bytes.buffer, '', function (gltf) {
    scene.add(gltf.scene);
    var bbox = new THREE.Box3().setFromObject(gltf.scene);
    if (!bbox.isEmpty()) {
      bbox.getCenter(target);
      var size = bbox.getSize(new THREE.Vector3());
      var maxDim = Math.max(size.x, size.y, size.z);
      var dist = maxDim / (2 * Math.tan(camera.fov * Math.PI / 360)) * 1.3;
      camera.position.set(target.x + dist * 0.6, target.y + dist * 0.5, target.z + dist * 0.6);
      camera.near = Math.max(0.01, maxDim / 1000);
      camera.far = maxDim * 20;
      camera.updateProjectionMatrix();
      var grid = new THREE.GridHelper(maxDim * 2, 40, 0x333348, 0x22222e);
      grid.position.set(target.x, bbox.min.y - 0.01, target.z);
      scene.add(grid);
    }
    camera.lookAt(target);
    document.getElementById('loading').style.display = 'none';
  }, function (err) {
    fail('Failed to load model: ' + (err && err.message ? err.message : err));
  });

  // ── Orbit / pan / zoom (inline, no import needed) ──────────────────────
  var isDrag = false, isRight = false, prevX = 0, prevY = 0;
  renderer.domElement.addEventListener('pointerdown', function (e) {
    isDrag = true; isRight = e.button === 2 || e.shiftKey;
    prevX = e.clientX; prevY = e.clientY;
  });
  window.addEventListener('pointermove', function (e) {
    if (!isDrag) return;
    var dx = e.clientX - prevX, dy = e.clientY - prevY;
    prevX = e.clientX; prevY = e.clientY;
    if (isRight) {
      var panScale = camera.position.distanceTo(target) * 0.002;
      var dir = camera.getWorldDirection(new THREE.Vector3());
      var right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
      var up = new THREE.Vector3().crossVectors(right, dir).normalize();
      var pan = right.multiplyScalar(-dx * panScale).add(up.multiplyScalar(dy * panScale));
      target.add(pan); camera.position.add(pan);
    } else {
      spherical.setFromVector3(camera.position.clone().sub(target));
      spherical.theta -= dx * 0.005;
      spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi - dy * 0.005));
      camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(spherical));
      camera.lookAt(target);
    }
  });
  window.addEventListener('pointerup', function () { isDrag = false; });
  renderer.domElement.addEventListener('wheel', function (e) {
    e.preventDefault();
    spherical.setFromVector3(camera.position.clone().sub(target));
    spherical.radius *= e.deltaY > 0 ? 1.1 : 0.9;
    camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(spherical));
    camera.lookAt(target);
  }, { passive: false });
  renderer.domElement.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  (function animate() { requestAnimationFrame(animate); renderer.render(scene, camera); })();
})();
<\/script>
</body>
</html>`;
}
