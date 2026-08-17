/**
 * TerrainViewer — Babylon.js terrain modeler for BubbleGraph BIM.
 *
 * Capabilities:
 *  - Procedural terrain mesh (fBm value noise) or flat ground
 *  - Excavation with FLAT horizontal floor (two-pass height grid) + optional slope rim
 *  - Embankment tool: raise terrain height within polygon
 *  - Rock placement: sphere meshes with random scale/rotation
 *  - Plant placement: billboard SpriteManager (trees, bushes, grass)
 *  - Nature library: 35 GLTF objects with preview + asset cache
 *  - Grid snapping: configurable XZ snap with live wireframe grid
 *  - Hover placement cursor: disc indicator snaps to grid while placing
 *  - Transform gizmos: move/rotate/scale + gizmo snap + array tool
 *  - GLB import with click-to-place workflow
 *  - Export/Import terrain JSON
 *
 * Coordinate system: X = East (m), Z = North (m), Y = Up (m) — Babylon Y-up
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Engine, Scene, ArcRotateCamera, HemisphericLight, DirectionalLight,
  Vector3, Color3, Color4, MeshBuilder, StandardMaterial,
  Mesh, VertexData, DynamicTexture, SpriteManager, Sprite,
  SceneLoader, AssetContainer, TransformNode,
  AbstractMesh, PositionGizmo, RotationGizmo, ScaleGizmo, UtilityLayerRenderer,
  Matrix, PointerEventTypes,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ObjectGizmoMode = 'move' | 'rotate' | 'scale';

export type TerrainTool =
  | 'select'
  | 'excavate'
  | 'embankment'
  | 'trench'
  | 'vegscatter'
  | 'vertexedit'
  | 'rock'
  | 'plant'
  | 'object';

export type GroundMaterial = 'grass' | 'dirt' | 'gravel' | 'sand';

export type PlantType = 'tree' | 'bush' | 'grass';

export interface ExcavationZone {
  id: string;
  polygon: [number, number][];
  depth: number;
  slope: number;
  type: 'trench' | 'pit' | 'embankment';
}

export interface RockInstance {
  id: string;
  x: number; z: number;
  scale: number;
  rotY: number;
}

export interface PlantInstance {
  id: string;
  x: number; z: number;
  type: PlantType;
  scale: number;
}

export interface PlacedObject {
  id: string;
  gltfFile: string;  // nature key (e.g. 'BirchTree_1.gltf') or '__import_<uuid>__' for custom imports
  label?: string;    // display name for custom imports
  x: number; z: number;
  rotY: number;
  scale: number;
}

export interface TerrainState {
  sizeM: number;
  subdivisions: number;
  maxHeightM: number;
  seed: number;
  excavations: ExcavationZone[];
  rocks: RockInstance[];
  plants: PlantInstance[];
  objects: PlacedObject[];
  groundMaterial?: GroundMaterial;
}

export interface TerrainViewerProps {
  className?: string;
  tabId?: string;
}

// ─── Noise helpers ────────────────────────────────────────────────────────────

function hash2(ix: number, iy: number, seed: number): number {
  const n = Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.3) * 43758.5453;
  return n - Math.floor(n);
}

function smoothstep(t: number) { return t * t * (3 - 2 * t); }

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = smoothstep(fx), sy = smoothstep(fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let val = 0, amp = 0.5, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    val += valueNoise(x * freq, y * freq, seed + i * 17) * amp;
    max += amp; amp *= 0.5; freq *= 2;
  }
  return val / max;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function pointInPolygon(px: number, pz: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]; const [xj, zj] = poly[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi)
      inside = !inside;
  }
  return inside;
}

function distToPolygonEdge(px: number, pz: number, poly: [number, number][]): number {
  let minDist = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j]; const [bx, bz] = poly[i];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    if (len2 === 0) { minDist = Math.min(minDist, Math.hypot(px - ax, pz - az)); continue; }
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
    const nx = ax + t * dx, nz = az + t * dz;
    minDist = Math.min(minDist, Math.hypot(px - nx, pz - nz));
  }
  return minDist;
}

/**
 * Build terrain height grid — two-pass algorithm.
 *
 * Pass 1: raw fBm noise.
 * Pass 2: apply excavation zones with a FLAT horizontal floor.
 *   floorY = avg(base heights at polygon boundary) − depth   (fixed Y, not terrain-relative)
 *   Slope rim: linear transition from original terrain down to floorY over rimWidth metres.
 */
function buildHeightGrid(
  sizeM: number, subdivisions: number, maxHeightM: number, seed: number,
  excavations: ExcavationZone[],
): Float32Array {
  const count = subdivisions + 1;
  const baseH = new Float32Array(count * count);

  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      const nx = col / subdivisions, nz = row / subdivisions;
      baseH[row * count + col] = fbm(nx * 4, nz * 4, seed) * maxHeightM;
    }
  }

  if (!excavations.length) return baseH;

  // Pre-compute flat floor Y and rim width for each excavation zone
  const zoneParams = excavations.map(zone => {
    if (zone.type === 'embankment') return { floorY: 0, rimWidth: 0 };
    let sum = 0;
    for (const [px, pz] of zone.polygon) {
      const c = Math.max(0, Math.min(count - 1, Math.round(((px / sizeM) + 0.5) * subdivisions)));
      const r = Math.max(0, Math.min(count - 1, Math.round(((pz / sizeM) + 0.5) * subdivisions)));
      sum += baseH[r * count + c];
    }
    const entryH  = sum / zone.polygon.length;
    const floorY  = entryH - zone.depth;
    const rimSlope = zone.slope > 0 ? Math.tan((zone.slope * Math.PI) / 180) : 0;
    const rimWidth = rimSlope > 0 ? zone.depth / rimSlope : 0;
    return { floorY, rimWidth };
  });

  const heights = new Float32Array(baseH);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      const wx = (col / subdivisions - 0.5) * sizeM;
      const wz = (row / subdivisions - 0.5) * sizeM;
      let h = baseH[row * count + col];

      for (let zi = 0; zi < excavations.length; zi++) {
        const zone = excavations[zi];
        if (!pointInPolygon(wx, wz, zone.polygon)) continue;

        if (zone.type === 'embankment') {
          h = Math.max(h, h + zone.depth);
        } else {
          const { floorY, rimWidth } = zoneParams[zi];
          if (rimWidth <= 0) {
            h = Math.min(h, floorY);
          } else {
            const dist = distToPolygonEdge(wx, wz, zone.polygon);
            if (dist >= rimWidth) {
              h = Math.min(h, floorY);
            } else {
              // Slope rim: interpolate original terrain → flat floor
              const t = dist / rimWidth;
              h = Math.min(h, baseH[row * count + col] * (1 - t) + floorY * t);
            }
          }
        }
      }
      heights[row * count + col] = h;
    }
  }
  return heights;
}

/** Construct Babylon VertexData for a heightfield ground mesh. */
function buildTerrainVertexData(
  sizeM: number, subdivisions: number, heights: Float32Array,
): VertexData {
  const count = subdivisions + 1;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      const x = (col / subdivisions - 0.5) * sizeM;
      const z = (row / subdivisions - 0.5) * sizeM;
      const y = heights[row * count + col];
      positions.push(x, y, z);
      uvs.push(col / subdivisions, row / subdivisions);
      normals.push(0, 1, 0);
    }
  }

  for (let row = 0; row < subdivisions; row++) {
    for (let col = 0; col < subdivisions; col++) {
      const i0 = row * count + col, i1 = i0 + 1;
      const i2 = (row + 1) * count + col, i3 = i2 + 1;
      indices.push(i0, i1, i2);
      indices.push(i1, i3, i2);
    }
  }

  const norms = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = positions[b] - positions[a], ay = positions[b + 1] - positions[a + 1], az = positions[b + 2] - positions[a + 2];
    const bx = positions[c] - positions[a], by = positions[c + 1] - positions[a + 1], bz = positions[c + 2] - positions[a + 2];
    const nx = az * by - ay * bz, ny = ax * bz - az * bx, nz = ay * bx - ax * by;
    for (const vi of [indices[i], indices[i + 1], indices[i + 2]]) {
      norms[vi * 3] += nx; norms[vi * 3 + 1] += ny; norms[vi * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < norms.length; i += 3) {
    const len = Math.sqrt(norms[i] ** 2 + norms[i + 1] ** 2 + norms[i + 2] ** 2) || 1;
    norms[i] /= len; norms[i + 1] /= len; norms[i + 2] /= len;
  }

  const vd = new VertexData();
  vd.positions = positions; vd.normals = Array.from(norms); vd.uvs = uvs; vd.indices = indices;
  return vd;
}

// ─── Sprite texture factories ─────────────────────────────────────────────────

function makeTreeSprite(): string {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#7a5c2e'; ctx.fillRect(28, 80, 8, 48);
  ctx.fillStyle = '#2d7a30';
  for (const [x, y, w, h] of [[16, 55, 32, 28], [10, 30, 44, 32], [16, 8, 32, 28]] as [number, number, number, number][]) {
    ctx.beginPath(); ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); ctx.fill();
  }
  return c.toDataURL();
}

function makeBushSprite(): string {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3a8a3a'; ctx.beginPath(); ctx.arc(32, 40, 24, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2d7a2d';
  ctx.beginPath(); ctx.arc(20, 35, 16, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(44, 36, 18, 0, Math.PI * 2); ctx.fill();
  return c.toDataURL();
}

function makeGrassSprite(): string {
  const c = document.createElement('canvas'); c.width = 32; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = '#5aad4a'; ctx.lineWidth = 2;
  for (const [x, tilt] of [[8, -4], [14, 2], [20, -2], [26, 5]] as [number, number][]) {
    ctx.beginPath(); ctx.moveTo(x, 60);
    ctx.bezierCurveTo(x + tilt, 40, x - tilt, 20, x + tilt * 1.5, 4); ctx.stroke();
  }
  return c.toDataURL();
}

function makeRockTexture(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture('rock_tex', { width: 64, height: 64 }, scene, false);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const grd = ctx.createRadialGradient(32, 28, 4, 32, 28, 28);
  grd.addColorStop(0, '#a0998a'); grd.addColorStop(1, '#6a6058');
  ctx.fillStyle = grd; ctx.beginPath(); ctx.ellipse(32, 32, 28, 24, 0.3, 0, Math.PI * 2); ctx.fill();
  tex.update();
  return tex;
}

// ─── Nature Library Assets ────────────────────────────────────────────────────

const NATURE_BASE = `${import.meta.env.VITE_API_URL ?? 'http://localhost:8000'}/nature/`;

interface NatureAsset { file: string; label: string; category: string; emoji: string; }
const NATURE_ASSETS: NatureAsset[] = [
  { file: 'BirchTree_1.gltf',  label: 'Birch 1', category: 'Birch Trees', emoji: '🌲' },
  { file: 'BirchTree_2.gltf',  label: 'Birch 2', category: 'Birch Trees', emoji: '🌲' },
  { file: 'BirchTree_3.gltf',  label: 'Birch 3', category: 'Birch Trees', emoji: '🌲' },
  { file: 'BirchTree_4.gltf',  label: 'Birch 4', category: 'Birch Trees', emoji: '🌲' },
  { file: 'BirchTree_5.gltf',  label: 'Birch 5', category: 'Birch Trees', emoji: '🌲' },
  { file: 'MapleTree_1.gltf',  label: 'Maple 1', category: 'Maple Trees', emoji: '🍁' },
  { file: 'MapleTree_2.gltf',  label: 'Maple 2', category: 'Maple Trees', emoji: '🍁' },
  { file: 'MapleTree_3.gltf',  label: 'Maple 3', category: 'Maple Trees', emoji: '🍁' },
  { file: 'MapleTree_4.gltf',  label: 'Maple 4', category: 'Maple Trees', emoji: '🍁' },
  { file: 'MapleTree_5.gltf',  label: 'Maple 5', category: 'Maple Trees', emoji: '🍁' },
  { file: 'DeadTree_1.gltf',   label: 'Dead 1',  category: 'Dead Trees',  emoji: '🪵' },
  { file: 'DeadTree_2.gltf',   label: 'Dead 2',  category: 'Dead Trees',  emoji: '🪵' },
  { file: 'DeadTree_3.gltf',   label: 'Dead 3',  category: 'Dead Trees',  emoji: '🪵' },
  { file: 'DeadTree_4.gltf',   label: 'Dead 4',  category: 'Dead Trees',  emoji: '🪵' },
  { file: 'DeadTree_5.gltf',   label: 'Dead 5',  category: 'Dead Trees',  emoji: '🪵' },
  { file: 'DeadTree_6.gltf',   label: 'Dead 6',  category: 'Dead Trees',  emoji: '🪵' },
  { file: 'DeadTree_7.gltf',   label: 'Dead 7',  category: 'Dead Trees',  emoji: '🪵' },
  { file: 'DeadTree_8.gltf',   label: 'Dead 8',  category: 'Dead Trees',  emoji: '🪵' },
  { file: 'DeadTree_9.gltf',   label: 'Dead 9',  category: 'Dead Trees',  emoji: '🪵' },
  { file: 'DeadTree_10.gltf',  label: 'Dead 10', category: 'Dead Trees',  emoji: '🪵' },
  { file: 'Bush.gltf',                label: 'Bush',           category: 'Bushes', emoji: '🌿' },
  { file: 'Bush_Flowers.gltf',        label: 'Bush + Flowers', category: 'Bushes', emoji: '🌿' },
  { file: 'Bush_Large.gltf',          label: 'Large Bush',     category: 'Bushes', emoji: '🌿' },
  { file: 'Bush_Large_Flowers.gltf',  label: 'Large + Flowers',category: 'Bushes', emoji: '🌿' },
  { file: 'Bush_Small.gltf',          label: 'Small Bush',     category: 'Bushes', emoji: '🌿' },
  { file: 'Bush_Small_Flowers.gltf',  label: 'Small + Flowers',category: 'Bushes', emoji: '🌿' },
  { file: 'Flower_1.gltf',       label: 'Flower 1',       category: 'Flowers', emoji: '🌸' },
  { file: 'Flower_1_Clump.gltf', label: 'Flower 1 Clump', category: 'Flowers', emoji: '🌸' },
  { file: 'Flower_2.gltf',       label: 'Flower 2',       category: 'Flowers', emoji: '🌼' },
  { file: 'Flower_2_Clump.gltf', label: 'Flower 2 Clump', category: 'Flowers', emoji: '🌼' },
  { file: 'Flower_3_Clump.gltf', label: 'Flower 3 Clump', category: 'Flowers', emoji: '🌻' },
  { file: 'Flower_4_Clump.gltf', label: 'Flower 4 Clump', category: 'Flowers', emoji: '🌻' },
  { file: 'Flower_5_Clump.gltf', label: 'Flower 5 Clump', category: 'Flowers', emoji: '🌺' },
  { file: 'Grass_Small.gltf',          label: 'Grass Small',    category: 'Grass', emoji: '🌱' },
  { file: 'Grass_Large.gltf',          label: 'Grass Large',    category: 'Grass', emoji: '🌱' },
  { file: 'Grass_Large_Extruded.gltf', label: 'Grass Extruded', category: 'Grass', emoji: '🌱' },
];
const NATURE_CATEGORIES = [...new Set(NATURE_ASSETS.map(a => a.category))];

// ─── Nature Preview Mini-Viewer ───────────────────────────────────────────────

function NaturePreviewCanvas({ gltfFile }: { gltfFile: string | null }) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const engineRef    = useRef<Engine | null>(null);
  const sceneRef     = useRef<Scene | null>(null);
  const containerRef = useRef<AssetContainer | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new Engine(canvasRef.current, true, { antialias: true });
    const scene  = new Scene(engine);
    scene.clearColor = new Color4(0.1, 0.1, 0.14, 1);
    const camera = new ArcRotateCamera('prev_cam', -Math.PI / 4, Math.PI / 3.5, 5, Vector3.Zero(), scene);
    camera.lowerRadiusLimit = 0.1; camera.upperRadiusLimit = 300;
    const hemi = new HemisphericLight('prev_hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 1.3;
    const dir = new DirectionalLight('prev_dir', new Vector3(-1, -2, 1), scene);
    dir.intensity = 0.5;
    scene.onBeforeRenderObservable.add(() => { camera.alpha += 0.008; });
    engine.runRenderLoop(() => scene.render());
    engineRef.current = engine; sceneRef.current = scene;
    return () => {
      containerRef.current?.dispose(); containerRef.current = null;
      engine.dispose(); engineRef.current = null; sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (containerRef.current) { containerRef.current.removeAllFromScene(); containerRef.current.dispose(); containerRef.current = null; }
    if (!gltfFile || !scene || gltfFile.startsWith('__import_')) return;
    let cancelled = false;
    setLoading(true);
    SceneLoader.LoadAssetContainerAsync(NATURE_BASE, gltfFile, scene)
      .then(container => {
        if (cancelled) { container.dispose(); return; }
        container.addAllToScene(); containerRef.current = container;
        const meshes = container.meshes.filter(m => m.getTotalVertices() > 0);
        if (meshes.length > 0) {
          meshes.forEach(m => m.computeWorldMatrix(true));
          let min = meshes[0].getBoundingInfo().boundingBox.minimumWorld.clone();
          let max = meshes[0].getBoundingInfo().boundingBox.maximumWorld.clone();
          for (const m of meshes) {
            const b = m.getBoundingInfo().boundingBox;
            min = Vector3.Minimize(min, b.minimumWorld);
            max = Vector3.Maximize(max, b.maximumWorld);
          }
          const center = Vector3.Center(min, max);
          const size   = Vector3.Distance(min, max);
          const cam    = scene.cameras[0] as ArcRotateCamera;
          cam.target = center; cam.radius = size * 1.3;
        }
        setLoading(false);
      })
      .catch(err => { if (!cancelled) { console.warn('[NaturePreview] Load failed:', err); setLoading(false); } });
    return () => { cancelled = true; };
  }, [gltfFile]);

  return (
    <div style={{
      position: 'relative', width: '100%', height: 150,
      borderRadius: 6, overflow: 'hidden', background: '#16161e',
      border: '1px solid hsl(var(--border))', flexShrink: 0,
    }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#00000080', color: '#ccc', fontSize: 11 }}>
          ⏳ Loading…
        </div>
      )}
      {!gltfFile && !loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'hsl(var(--muted-foreground))', fontSize: 11, textAlign: 'center', padding: 12, lineHeight: 1.6 }}>
          Select a model<br />to preview
        </div>
      )}
      {gltfFile?.startsWith('__import_') && !loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'hsl(var(--muted-foreground))', fontSize: 11 }}>
          📦 Custom import
        </div>
      )}
    </div>
  );
}

// ─── Snap helper ──────────────────────────────────────────────────────────────

function snapToGrid(v: number, size: number): number {
  return Math.round(v / size) * size;
}

// ─── Trench: expand centerline path into a closed polygon ─────────────────────

function pathToPolygon(pts: [number, number][], halfWidth: number): [number, number][] {
  const n = pts.length;
  if (n < 2) return [];
  const left:  [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    let dx = 0, dz = 0;
    if (i < n - 1) { dx += pts[i + 1][0] - pts[i][0]; dz += pts[i + 1][1] - pts[i][1]; }
    if (i > 0)     { dx += pts[i][0] - pts[i - 1][0]; dz += pts[i][1] - pts[i - 1][1]; }
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    left.push( [pts[i][0] - dz * halfWidth, pts[i][1] + dx * halfWidth]);
    right.push([pts[i][0] + dz * halfWidth, pts[i][1] - dx * halfWidth]);
  }
  return [...left, ...[...right].reverse()];
}

// ─── Vegscatter helpers ────────────────────────────────────────────────────────

function polygonArea(poly: [number, number][]): number {
  let area = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1];
  }
  return Math.abs(area) / 2;
}

function scatterInPolygon(
  poly:      [number, number][],
  density:   number,
  plantFiles: string[],
  scale:     number,
): PlacedObject[] {
  if (poly.length < 3 || !plantFiles.length) return [];
  const area  = polygonArea(poly);
  const count = Math.max(1, Math.round(area * density / 100));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of poly) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const result: PlacedObject[] = [];
  let attempts = 0;
  while (result.length < count && attempts < count * 20) {
    attempts++;
    const x = minX + Math.random() * (maxX - minX);
    const z = minZ + Math.random() * (maxZ - minZ);
    if (!pointInPolygon(x, z, poly)) continue;
    const gltfFile = plantFiles[Math.floor(Math.random() * plantFiles.length)];
    result.push({
      id: crypto.randomUUID(), gltfFile,
      x, z, rotY: Math.random() * Math.PI * 2,
      scale: scale * (0.8 + Math.random() * 0.4),
    });
  }
  return result;
}

// ─── Ground material texture drawing ─────────────────────────────────────────

function mulberry32(seed: number) {
  let s = (seed | 0) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawGroundCanvas(
  ctx: CanvasRenderingContext2D,
  type: GroundMaterial,
  w: number, h: number,
  seed: number,
): void {
  const rng = mulberry32(seed);
  switch (type) {
    case 'grass': {
      const gs = 32;
      for (let gy = 0; gy < h / gs; gy++)
        for (let gx = 0; gx < w / gs; gx++) {
          ctx.fillStyle = (gx + gy) % 2 === 0 ? '#4a7a4a' : '#3d6b3d';
          ctx.fillRect(gx * gs, gy * gs, gs, gs);
        }
      // Subtle variation dots
      for (let i = 0; i < 1200; i++) {
        const x = rng() * w, y = rng() * h, r = 0.5 + rng() * 2;
        const v = (rng() * 20 - 10) | 0;
        ctx.fillStyle = `rgba(${55 + v},${110 + v},${55 + v},0.45)`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'dirt': {
      ctx.fillStyle = '#6b4a2a';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 2000; i++) {
        const x = rng() * w, y = rng() * h, r = 1 + rng() * 4;
        const v = (rng() * 50 - 25) | 0;
        ctx.fillStyle = `rgba(${105 + v},${74 + v},${42 + v},0.7)`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      // Cracks
      ctx.strokeStyle = 'rgba(40,28,14,0.3)'; ctx.lineWidth = 0.8;
      for (let i = 0; i < 18; i++) {
        ctx.beginPath(); ctx.moveTo(rng() * w, rng() * h);
        for (let s = 0; s < 6; s++) ctx.lineTo(rng() * w, rng() * h);
        ctx.stroke();
      }
      break;
    }
    case 'gravel': {
      ctx.fillStyle = '#787068';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 2800; i++) {
        const x = rng() * w, y = rng() * h;
        const a = rng() * Math.PI;
        const rx = 1.5 + rng() * 4, ry = 0.8 + rng() * 2;
        const v = (rng() * 50 - 25) | 0;
        ctx.fillStyle = `rgba(${110 + v},${108 + v},${100 + v},0.9)`;
        ctx.beginPath(); ctx.ellipse(x, y, rx, ry, a, 0, Math.PI * 2); ctx.fill();
        // Highlight edge
        ctx.strokeStyle = `rgba(${150 + v},${148 + v},${140 + v},0.4)`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
      break;
    }
    case 'sand': {
      ctx.fillStyle = '#c4a96a';
      ctx.fillRect(0, 0, w, h);
      // Wind ripple lines
      ctx.lineWidth = 1.2;
      for (let y = 0; y < h; y += 9) {
        const alpha = 0.25 + rng() * 0.2;
        ctx.strokeStyle = `rgba(212,188,128,${alpha})`;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 3) {
          const yy = y + Math.sin((x + y * 0.7) * 0.045) * 2.8;
          x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      // Fine grains
      for (let i = 0; i < 900; i++) {
        const x = rng() * w, y = rng() * h, v = (rng() * 30) | 0;
        ctx.fillStyle = `rgba(${190 + v},${170 + v},${95 + v},0.5)`;
        ctx.beginPath(); ctx.arc(x, y, 0.5 + rng(), 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
  }
}

// ─── Main Component ───────────────────────────────────────────────────────────

const DEFAULT_TERRAIN: TerrainState = {
  sizeM: 100, subdivisions: 128, maxHeightM: 6, seed: 42,
  excavations: [], rocks: [], plants: [], objects: [],
  groundMaterial: 'grass',
};

const SNAP_SIZES = [0.25, 0.5, 1, 2, 5];

export function TerrainViewer({ className, tabId: _tabId }: TerrainViewerProps) {
  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const engineRef        = useRef<Engine | null>(null);
  const sceneRef         = useRef<Scene | null>(null);
  const terrainMeshRef   = useRef<Mesh | null>(null);
  const spriteManagersRef= useRef<Record<PlantType, SpriteManager | null>>({ tree: null, bush: null, grass: null });
  const rockMaterialRef  = useRef<StandardMaterial | null>(null);
  const polygonInProgressRef = useRef<[number, number][]>([]);
  const previewMeshRef   = useRef<Mesh | null>(null);
  const heightsRef       = useRef<Float32Array | null>(null);

  // Vertex edit mode
  const cameraRef           = useRef<ArcRotateCamera | null>(null);
  const vertexHighlightRef  = useRef<Mesh | null>(null);
  const vertexDragRef       = useRef<{ col: number; row: number; startScreenY: number; startHeight: number } | null>(null);
  const bakedHeightsRef     = useRef<Float32Array | null>(null);
  const vertexWireframeRef  = useRef<Mesh | null>(null);

  // Refs forwarded to Babylon observers (avoid stale closures)
  const activeToolRef         = useRef<TerrainTool>('select');
  const snapEnabledRef        = useRef(false);
  const snapSizeRef           = useRef(1.0);
  const terrainSizeMRef       = useRef(DEFAULT_TERRAIN.sizeM);
  const terrainSubdivisionsRef= useRef(DEFAULT_TERRAIN.subdivisions);
  const hoverDiscRef          = useRef<Mesh | null>(null);
  const hoverMatRef           = useRef<StandardMaterial | null>(null);
  const rubberBandRef         = useRef<Mesh | null>(null);
  const snapGridMeshRef       = useRef<Mesh | null>(null);

  const [hoverCoords, setHoverCoords] = useState<{ x: number; z: number; snapped: boolean } | null>(null);

  const [terrain, setTerrain]   = useState<TerrainState>(DEFAULT_TERRAIN);
  const [activeTool, setActiveTool] = useState<TerrainTool>('select');
  const [bgLight, setBgLight]   = useState(false);

  // Snap state
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [snapSize, setSnapSize]       = useState(1.0);

  // Pending GLB import (click-to-place mode)
  const [pendingGLBKey, setPendingGLBKey] = useState<string | null>(null);
  const pendingGLBKeyRef = useRef<string | null>(null);
  const customLabelsRef  = useRef<Record<string, string>>({});

  const hemiRef = useRef<HemisphericLight | null>(null);
  const dirRef  = useRef<DirectionalLight | null>(null);

  const [excavationDepth, setExcavationDepth] = useState(2);
  const [excavationSlope, setExcavationSlope] = useState(30);
  const [excavationType, setExcavationType]   = useState<ExcavationZone['type']>('trench');
  const [polygonPoints, setPolygonPoints]     = useState<[number, number][]>([]);
  const [selectedExcavId, setSelectedExcavId] = useState<string | null>(null);

  // Trench tool
  const [trenchWidth, setTrenchWidth] = useState(3);
  const [trenchDepth, setTrenchDepth] = useState(2);
  const [trenchAngle, setTrenchAngle] = useState(30);

  // Vegscatter tool
  const [scatterDensity, setScatterDensity] = useState(5);
  const [scatterPlants, setScatterPlants]   = useState<string[]>(['BirchTree_1.gltf']);
  const [scatterScale, setScatterScale]     = useState(1.0);
  const [showSettings, setShowSettings]           = useState(false);
  const [pendingSeed, setPendingSeed]             = useState(terrain.seed);
  const [pendingMaxH, setPendingMaxH]             = useState(terrain.maxHeightM);
  const [pendingSubs, setPendingSubs]             = useState(terrain.subdivisions);
  const [pendingGroundMat, setPendingGroundMat]   = useState<GroundMaterial>('grass');

  const [selectedNatureGltf, setSelectedNatureGltf] = useState<string | null>(null);
  const [objectScale, setObjectScale]               = useState(1.0);
  const selectedNatureGltfRef = useRef<string | null>(null);
  const gltfCacheRef    = useRef<Map<string, AssetContainer>>(new Map());
  const placedNodesRef  = useRef<Map<string, TransformNode[]>>(new Map());
  const pinMeshesRef    = useRef<Map<string, Mesh>>(new Map());
  const syncGenRef      = useRef(0);

  const [selectedObjectId, setSelectedObjectId]   = useState<string | null>(null);
  const [gizmoMode, setGizmoMode]                 = useState<ObjectGizmoMode>('move');
  const selectedObjectIdRef = useRef<string | null>(null);
  const gizmoModeRef        = useRef<ObjectGizmoMode>('move');
  const posGizmoRef         = useRef<PositionGizmo | null>(null);
  const rotGizmoRef         = useRef<RotationGizmo | null>(null);
  const scaleGizmoRef       = useRef<ScaleGizmo | null>(null);
  const [syncCount, setSyncCount] = useState(0);

  const [arrayType, setArrayType]       = useState<'linear' | 'grid'>('linear');
  const [arrayCount, setArrayCount]     = useState(3);
  const [arrayAxis, setArrayAxis]       = useState<'x' | 'z'>('x');
  const [arraySpacing, setArraySpacing] = useState(5);
  const [gridRows, setGridRows]         = useState(3);
  const [gridCols, setGridCols]         = useState(3);
  const [gridSpX, setGridSpX]           = useState(5);
  const [gridSpZ, setGridSpZ]           = useState(5);

  // ── Sync observer refs with state ─────────────────────────────────────────
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { snapEnabledRef.current = snapEnabled; }, [snapEnabled]);
  useEffect(() => { snapSizeRef.current = snapSize; }, [snapSize]);
  useEffect(() => { selectedNatureGltfRef.current = selectedNatureGltf; }, [selectedNatureGltf]);
  useEffect(() => { pendingGLBKeyRef.current = pendingGLBKey; }, [pendingGLBKey]);

  // ── Rebuild terrain mesh ───────────────────────────────────────────────────
  const rebuildTerrain = useCallback((t: TerrainState, scene: Scene) => {
    terrainSizeMRef.current        = t.sizeM;
    terrainSubdivisionsRef.current = t.subdivisions;
    if (terrainMeshRef.current) { terrainMeshRef.current.dispose(); terrainMeshRef.current = null; }
    const count = t.subdivisions + 1;
    const baked = bakedHeightsRef.current;
    const heights = (baked && baked.length === count * count)
      ? baked
      : buildHeightGrid(t.sizeM, t.subdivisions, t.maxHeightM, t.seed, t.excavations);
    heightsRef.current = heights;
    const vd = buildTerrainVertexData(t.sizeM, t.subdivisions, heights);
    const mesh = new Mesh('terrain', scene);
    vd.applyToMesh(mesh, true);
    const mat = new StandardMaterial('terrain_mat', scene);
    const texW = 512, texH = 512;
    const tex  = new DynamicTexture('terrain_tex', { width: texW, height: texH }, scene, false);
    const ctx  = tex.getContext() as unknown as CanvasRenderingContext2D;

    // Base ground material
    drawGroundCanvas(ctx, t.groundMaterial ?? 'grass', texW, texH, t.seed);

    // Helper: world XZ → canvas pixel (UV: u=wX/sizeM+0.5, v flipped for canvas Y)
    const w2c = (wx: number, wz: number) => ({
      x: (wx / t.sizeM + 0.5) * texW,
      y: (0.5 - wz / t.sizeM) * texH,
    });

    const tracePoly = (poly: [number, number][]) => {
      ctx.beginPath();
      poly.forEach(([wx, wz], i) => {
        const { x, y } = w2c(wx, wz);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
    };

    for (const zone of t.excavations) {
      if (zone.polygon.length < 3) continue;
      const isEmb = zone.type === 'embankment';
      tracePoly(zone.polygon);

      if (isEmb) {
        // Rambleu / umplutura: brun-auriu cald
        ctx.fillStyle = '#8b5e1a';
        ctx.fill();
        // Hașuri diagonale pentru material de umplutura
        ctx.save(); ctx.clip();
        ctx.strokeStyle = '#a87228'; ctx.lineWidth = 1.5;
        for (let h = -texW; h < texW * 2; h += 14) {
          ctx.beginPath(); ctx.moveTo(h, 0); ctx.lineTo(h + texH, texH); ctx.stroke();
        }
        ctx.restore();
        // Contur rambleu
        tracePoly(zone.polygon);
        ctx.strokeStyle = '#d4963c'; ctx.lineWidth = 4; ctx.stroke();
      } else {
        // Sapatura / excavatie: pamant inchis
        ctx.fillStyle = '#2e1a0a';
        ctx.fill();
        // Hașuri încrucișate pentru tăietura
        ctx.save(); ctx.clip();
        ctx.strokeStyle = '#4a2e12'; ctx.lineWidth = 1;
        for (let h = -texW; h < texW * 2; h += 10) {
          ctx.beginPath(); ctx.moveTo(h, texH); ctx.lineTo(h + texH, 0); ctx.stroke();
        }
        ctx.restore();
        // Contur excavatie
        tracePoly(zone.polygon);
        ctx.strokeStyle = '#7a4820'; ctx.lineWidth = 4; ctx.stroke();
      }
    }

    tex.update();
    mat.diffuseTexture = tex;
    mat.specularColor  = new Color3(0.1, 0.1, 0.1);
    mesh.material = mat;
    mesh.receiveShadows = true;
    terrainMeshRef.current = mesh;
  }, []);

  // ── Quick update: re-snap object Y positions after terrain rebuild ─────────
  const quickUpdateObjectPositions = useCallback(() => {
    for (const [id, nodes] of placedNodesRef.current) {
      const root = nodes[0];
      if (!root) continue;
      const ty = sampleTerrainHeight(root.position.x, root.position.z,
        terrainSizeMRef.current, terrainSubdivisionsRef.current, heightsRef.current);
      root.position.y = ty;
      const pin = pinMeshesRef.current.get(id);
      if (pin) pin.position.y = ty + 0.5;
    }
  }, []);

  // ── Sync plants to SpriteManagers ─────────────────────────────────────────
  const syncPlants = useCallback((plants: PlantInstance[], scene: Scene) => {
    const smgrs = spriteManagersRef.current;
    for (const key of Object.keys(smgrs) as PlantType[]) { smgrs[key]?.dispose(); smgrs[key] = null; }
    const byType: Record<PlantType, PlantInstance[]> = { tree: [], bush: [], grass: [] };
    for (const p of plants) byType[p.type].push(p);
    for (const [ptype, list] of Object.entries(byType) as [PlantType, PlantInstance[]][]) {
      if (!list.length) continue;
      const dataUrl = ptype === 'tree' ? makeTreeSprite() : ptype === 'bush' ? makeBushSprite() : makeGrassSprite();
      const mgr = new SpriteManager(`sp_${ptype}`, dataUrl, list.length + 1,
        { width: 64, height: ptype === 'tree' ? 128 : 64 }, scene);
      for (const p of list) {
        const sp  = new Sprite(`sp_${p.id}`, mgr);
        const ty  = sampleTerrainHeight(p.x, p.z, terrainSizeMRef.current, terrainSubdivisionsRef.current, heightsRef.current);
        sp.position = new Vector3(p.x, ty + (ptype === 'tree' ? p.scale * 1.5 : p.scale * 0.5), p.z);
        sp.size = p.scale * (ptype === 'tree' ? 4 : ptype === 'bush' ? 2 : 1);
        sp.isPickable = false;
      }
      smgrs[ptype] = mgr;
    }
  }, []);

  // ── Sync rocks ────────────────────────────────────────────────────────────
  const rockMeshesRef = useRef<Mesh[]>([]);
  const syncRocks = useCallback((rocks: RockInstance[], scene: Scene) => {
    for (const m of rockMeshesRef.current) m.dispose(); rockMeshesRef.current = [];
    if (!rockMaterialRef.current) {
      const mat = new StandardMaterial('rock_mat', scene);
      mat.diffuseTexture = makeRockTexture(scene);
      mat.specularColor  = new Color3(0.3, 0.3, 0.3);
      rockMaterialRef.current = mat;
    }
    for (const r of rocks) {
      const mesh = MeshBuilder.CreateSphere(`rock_${r.id}`, { diameter: r.scale, segments: 6 }, scene);
      const ty   = sampleTerrainHeight(r.x, r.z, terrainSizeMRef.current, terrainSubdivisionsRef.current, heightsRef.current);
      mesh.position = new Vector3(r.x, ty + r.scale * 0.3, r.z);
      mesh.rotation.y = r.rotY; mesh.scaling.y = 0.65;
      mesh.material = rockMaterialRef.current;
      rockMeshesRef.current.push(mesh);
    }
  }, []);

  // ── Polygon preview markers ───────────────────────────────────────────────
  const markerMeshesRef = useRef<Mesh[]>([]);
  const syncPolygonMarkers = useCallback((pts: [number, number][], scene: Scene) => {
    for (const m of markerMeshesRef.current) m.dispose(); markerMeshesRef.current = [];
    const mat = new StandardMaterial('poly_mat', scene);
    mat.diffuseColor = new Color3(1, 0.6, 0); mat.emissiveColor = new Color3(0.8, 0.4, 0);
    for (const [px, pz] of pts) {
      const ty  = sampleTerrainHeight(px, pz, terrainSizeMRef.current, terrainSubdivisionsRef.current, heightsRef.current);
      const sph = MeshBuilder.CreateSphere(`pm_${px}_${pz}`, { diameter: 0.4 }, scene);
      sph.position = new Vector3(px, ty + 0.3, pz); sph.material = mat;
      markerMeshesRef.current.push(sph);
    }
    if (previewMeshRef.current) { previewMeshRef.current.dispose(); previewMeshRef.current = null; }
    if (pts.length >= 2) {
      const linePoints = pts.map(([px, pz]) => {
        const ty = sampleTerrainHeight(px, pz, terrainSizeMRef.current, terrainSubdivisionsRef.current, heightsRef.current);
        return new Vector3(px, ty + 0.4, pz);
      });
      linePoints.push(linePoints[0]);
      const lines = MeshBuilder.CreateLines('poly_preview', { points: linePoints }, scene);
      lines.color = new Color3(1, 0.6, 0);
      previewMeshRef.current = lines;
    }
  }, []);

  // ── Selection highlight ───────────────────────────────────────────────────
  const selectionMeshRef = useRef<Mesh | null>(null);
  const syncSelectionHighlight = useCallback((id: string | null, excavations: ExcavationZone[], scene: Scene) => {
    if (selectionMeshRef.current) { selectionMeshRef.current.dispose(); selectionMeshRef.current = null; }
    if (!id) return;
    const zone = excavations.find(z => z.id === id);
    if (!zone || zone.polygon.length < 3) return;
    const pts = [...zone.polygon, zone.polygon[0]].map(([px, pz]) => {
      const ty = sampleTerrainHeight(px, pz, terrainSizeMRef.current, terrainSubdivisionsRef.current, heightsRef.current);
      return new Vector3(px, ty + 0.3, pz);
    });
    const lines = MeshBuilder.CreateLines('sel_highlight', { points: pts }, scene);
    lines.color = new Color3(0.2, 0.7, 1);
    selectionMeshRef.current = lines;
  }, []);

  // ── Sync nature GLTF objects ───────────────────────────────────────────────
  const syncNatureObjects = useCallback(async (objects: PlacedObject[], scene: Scene) => {
    const gen = ++syncGenRef.current;
    for (const [, nodes] of placedNodesRef.current) for (const n of nodes) n.dispose();
    placedNodesRef.current.clear();
    for (const [, pin] of pinMeshesRef.current) pin.dispose();
    pinMeshesRef.current.clear();

    for (const obj of objects) {
      if (gen !== syncGenRef.current) return;
      try {
        if (!gltfCacheRef.current.has(obj.gltfFile)) {
          // Only load from NATURE_BASE if it's a nature asset, not a custom import
          if (obj.gltfFile.startsWith('__import_')) {
            console.warn(`[TerrainViewer] Custom import ${obj.gltfFile} not in cache, skipping`);
            continue;
          }
          const container = await SceneLoader.LoadAssetContainerAsync(NATURE_BASE, obj.gltfFile, scene);
          if (gen !== syncGenRef.current) { container.dispose(); return; }
          gltfCacheRef.current.set(obj.gltfFile, container);
        }
        const container = gltfCacheRef.current.get(obj.gltfFile)!;
        const entries   = container.instantiateModelsToScene(undefined, false, { doNotInstantiate: true });
        const ty        = sampleTerrainHeight(obj.x, obj.z, terrainSizeMRef.current, terrainSubdivisionsRef.current, heightsRef.current);
        for (const root of entries.rootNodes) {
          const tn = root as unknown as TransformNode;
          tn.position = new Vector3(obj.x, ty, obj.z);
          tn.rotation = new Vector3(0, obj.rotY, 0);
          tn.scaling  = new Vector3(obj.scale, obj.scale, obj.scale);
        }
        placedNodesRef.current.set(obj.id, entries.rootNodes as TransformNode[]);

        // Selection pin
        const pinMat = new StandardMaterial(`__pin_mat_${obj.id}__`, scene);
        pinMat.diffuseColor  = new Color3(1.0, 0.55, 0.05);
        pinMat.emissiveColor = new Color3(0.7, 0.3, 0.0);
        pinMat.disableLighting = true;
        const pin = MeshBuilder.CreateSphere(`__pin_${obj.id}__`, { diameter: 0.7, segments: 6 }, scene);
        pin.position = new Vector3(obj.x, ty + 0.5, obj.z);
        pin.material = pinMat; pin.isPickable = true; pin.renderingGroupId = 1;
        pinMeshesRef.current.set(obj.id, pin);
      } catch (err) {
        console.warn(`[TerrainViewer] GLTF load failed (${obj.gltfFile}):`, err);
      }
    }
  }, []);

  // ── Babylon.js scene initialization ───────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new Engine(canvasRef.current, true, { preserveDrawingBuffer: true });
    const scene  = new Scene(engine);
    scene.clearColor = new Color4(0.15, 0.2, 0.15, 1);
    engineRef.current = engine; sceneRef.current = scene;

    const camera = new ArcRotateCamera('cam', -Math.PI / 3, Math.PI / 3.5, 120, Vector3.Zero(), scene);
    camera.lowerRadiusLimit = 5; camera.upperRadiusLimit = 400;
    camera.wheelDeltaPercentage = 0.01;
    camera.attachControl(canvasRef.current, true);
    cameraRef.current = camera;

    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.6; hemi.groundColor = new Color3(0.2, 0.3, 0.2);
    hemiRef.current = hemi;
    const dir = new DirectionalLight('sun', new Vector3(-0.5, -1, 0.5), scene);
    dir.intensity = 0.8; dirRef.current = dir;

    // Gizmos
    const utilLayer  = new UtilityLayerRenderer(scene);
    const posGizmo   = new PositionGizmo(utilLayer);
    const rotGizmo   = new RotationGizmo(utilLayer);
    const scaleGizmo = new ScaleGizmo(utilLayer);
    posGizmo.scaleRatio = rotGizmo.scaleRatio = scaleGizmo.scaleRatio = 1.5;
    posGizmoRef.current = posGizmo; rotGizmoRef.current = rotGizmo; scaleGizmoRef.current = scaleGizmo;

    const onDragEnd = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = (posGizmo.attachedNode ?? rotGizmo.attachedNode ?? scaleGizmo.attachedNode) as any as TransformNode | null;
      if (!node) return;
      const id = selectedObjectIdRef.current;
      if (!id) return;

      // Snap position to grid if enabled
      if (snapEnabledRef.current) {
        const sz = snapSizeRef.current;
        node.position.x = snapToGrid(node.position.x, sz);
        node.position.z = snapToGrid(node.position.z, sz);
      }
      // Always snap Y to terrain surface
      node.position.y = sampleTerrainHeight(
        node.position.x, node.position.z,
        terrainSizeMRef.current, terrainSubdivisionsRef.current, heightsRef.current,
      );

      setTerrain(t => ({
        ...t,
        objects: t.objects.map(o => o.id === id ? {
          ...o,
          x: node.position.x, z: node.position.z,
          rotY: node.rotation.y,
          scale: Math.max(0.01, node.scaling.x),
        } : o),
      }));
    };
    posGizmo.onDragEndObservable.add(onDragEnd);
    rotGizmo.onDragEndObservable.add(onDragEnd);
    scaleGizmo.onDragEndObservable.add(onDragEnd);

    rebuildTerrain(DEFAULT_TERRAIN, scene);

    // ── Hover cursor disc (shared across tools) ────────────────────────────
    const hoverDisc = MeshBuilder.CreateDisc('hover_cursor', { radius: 0.6, tessellation: 32 }, scene);
    hoverDisc.rotation.x = Math.PI / 2;
    const hoverMat = new StandardMaterial('hover_mat', scene);
    hoverMat.diffuseColor  = new Color3(0.3, 0.8, 1.0);
    hoverMat.emissiveColor = new Color3(0.15, 0.5, 0.8);
    hoverMat.alpha = 0.65;
    hoverMat.disableLighting = true;
    hoverDisc.material = hoverMat;
    hoverDisc.setEnabled(false);
    hoverDisc.renderingGroupId = 1;
    hoverDiscRef.current  = hoverDisc;
    hoverMatRef.current   = hoverMat;

    // ── Vertex edit: highlight sphere ──────────────────────────────────────
    const vtxHL    = MeshBuilder.CreateSphere('vtx_highlight', { diameter: 0.55, segments: 8 }, scene);
    const vtxMat   = new StandardMaterial('vtx_mat', scene);
    vtxMat.diffuseColor  = new Color3(0.15, 0.85, 1.0);
    vtxMat.emissiveColor = new Color3(0.05, 0.55, 0.8);
    vtxMat.disableLighting = true;
    vtxHL.material = vtxMat;
    vtxHL.setEnabled(false);
    vtxHL.renderingGroupId = 1;
    vertexHighlightRef.current = vtxHL;

    // ── Vertex edit: pointer observable ────────────────────────────────────
    scene.onPointerObservable.add((pi) => {
      if (activeToolRef.current !== 'vertexedit') return;
      const mesh  = terrainMeshRef.current;
      const sizeM = terrainSizeMRef.current;
      const subs  = terrainSubdivisionsRef.current;
      const count = subs + 1;

      const gridCoord = (wx: number, wz: number) => ({
        col: Math.max(0, Math.min(subs, Math.round(((wx / sizeM) + 0.5) * subs))),
        row: Math.max(0, Math.min(subs, Math.round(((wz / sizeM) + 0.5) * subs))),
      });

      if (pi.type === PointerEventTypes.POINTERMOVE) {
        const drag = vertexDragRef.current;
        if (drag && mesh) {
          const dY = (drag.startScreenY - scene.pointerY) * 0.04;
          const newH = drag.startHeight + dY;
          const heights = heightsRef.current;
          if (heights) {
            const idx = drag.row * count + drag.col;
            heights[idx] = newH;
            const positions = mesh.getVerticesData('position') as number[];
            positions[idx * 3 + 1] = newH;
            mesh.updateVerticesData('position', positions, true);
            const indices = mesh.getIndices()!;
            const normals = new Array<number>(positions.length).fill(0);
            VertexData.ComputeNormals(positions, indices, normals);
            mesh.updateVerticesData('normal', normals, true);
            const hl = vertexHighlightRef.current;
            if (hl) hl.position.y = newH + 0.35;
          }
        } else {
          const pick = scene.pick(scene.pointerX, scene.pointerY, m => m.name === 'terrain');
          const hl = vertexHighlightRef.current;
          if (pick.hit && pick.pickedPoint && hl) {
            const { col, row } = gridCoord(pick.pickedPoint.x, pick.pickedPoint.z);
            const wx = (col / subs - 0.5) * sizeM;
            const wz = (row / subs - 0.5) * sizeM;
            const h  = heightsRef.current?.[row * count + col] ?? 0;
            hl.position.set(wx, h + 0.35, wz);
            hl.setEnabled(true);
          } else if (hl) {
            hl.setEnabled(false);
          }
        }
      } else if (pi.type === PointerEventTypes.POINTERDOWN) {
        if ((pi.event as PointerEvent).button !== 0) return;
        const pick = scene.pick(scene.pointerX, scene.pointerY, m => m.name === 'terrain');
        if (pick.hit && pick.pickedPoint) {
          const { col, row } = gridCoord(pick.pickedPoint.x, pick.pickedPoint.z);
          const h = heightsRef.current?.[row * count + col] ?? 0;
          vertexDragRef.current = { col, row, startScreenY: scene.pointerY, startHeight: h };
        }
      } else if (pi.type === PointerEventTypes.POINTERUP) {
        if (vertexDragRef.current) {
          if (heightsRef.current) {
            bakedHeightsRef.current = new Float32Array(heightsRef.current);
          }
          vertexDragRef.current = null;
        }
      }
    });


    // Tool → cursor appearance
    const TOOL_CURSOR: Record<string, { r: number; g: number; b: number; radius: number }> = {
      object:      { r: 0.30, g: 0.80, b: 1.00, radius: 0.60 },
      rock:        { r: 0.65, g: 0.60, b: 0.55, radius: 0.50 },
      plant:       { r: 0.35, g: 0.85, b: 0.35, radius: 0.45 },
      excavate:    { r: 0.85, g: 0.40, b: 0.20, radius: 0.35 },
      embankment:  { r: 0.78, g: 0.55, b: 0.20, radius: 0.35 },
      trench:      { r: 0.20, g: 0.65, b: 1.00, radius: 0.35 },
      vegscatter:  { r: 0.30, g: 0.92, b: 0.40, radius: 0.40 },
    };

    // ── Pointer move: universal hover cursor + rubber-band + coords ────────
    scene.onPointerMove = () => {
      const tool = activeToolRef.current;
      const disc = hoverDiscRef.current;
      const mat  = hoverMatRef.current;
      if (!disc || !mat) return;

      // Tools that show cursor
      const showCursor = tool === 'object' || tool === 'rock' || tool === 'plant'
        || tool === 'excavate' || tool === 'embankment' || tool === 'trench' || tool === 'vegscatter';
      if (!showCursor) {
        disc.setEnabled(false);
        setHoverCoords(null);
        if (rubberBandRef.current) { rubberBandRef.current.dispose(); rubberBandRef.current = null; }
        return;
      }

      const pick = scene.pick(scene.pointerX, scene.pointerY, m => m.name === 'terrain');
      if (!pick.hit || !pick.pickedPoint) {
        disc.setEnabled(false);
        setHoverCoords(null);
        if (rubberBandRef.current) { rubberBandRef.current.dispose(); rubberBandRef.current = null; }
        return;
      }

      const snapping = snapEnabledRef.current;
      const sx = snapping ? snapToGrid(pick.pickedPoint.x, snapSizeRef.current) : pick.pickedPoint.x;
      const sz = snapping ? snapToGrid(pick.pickedPoint.z, snapSizeRef.current) : pick.pickedPoint.z;
      const sy = sampleTerrainHeight(sx, sz, terrainSizeMRef.current, terrainSubdivisionsRef.current, heightsRef.current);

      // Update cursor appearance per tool
      const cfg = TOOL_CURSOR[tool] ?? TOOL_CURSOR.object;
      const radius = snapping ? Math.max(snapSizeRef.current * 0.42, 0.3) : cfg.radius;
      mat.diffuseColor.set(cfg.r, cfg.g, cfg.b);
      mat.emissiveColor.set(cfg.r * 0.5, cfg.g * 0.5, cfg.b * 0.5);
      disc.scaling.setAll(radius / 0.6);
      disc.position.set(sx, sy + 0.12, sz);
      disc.setEnabled(true);

      // Rubber-band line: last polygon/path point → cursor
      if (rubberBandRef.current) { rubberBandRef.current.dispose(); rubberBandRef.current = null; }
      const inProg = polygonInProgressRef.current;
      if ((tool === 'excavate' || tool === 'embankment' || tool === 'trench' || tool === 'vegscatter') && inProg.length > 0) {
        const last = inProg[inProg.length - 1];
        const lastY = sampleTerrainHeight(last[0], last[1], terrainSizeMRef.current, terrainSubdivisionsRef.current, heightsRef.current);
        const rubberLine = MeshBuilder.CreateLines('rubber_band', {
          points: [
            new Vector3(last[0], lastY + 0.3, last[1]),
            new Vector3(sx, sy + 0.3, sz),
          ],
        }, scene);
        const emb = tool === 'embankment';
        const tr  = tool === 'trench';
        const veg = tool === 'vegscatter';
        rubberLine.color = new Color3(
          tr ? 0.20 : veg ? 0.20 : (emb ? 0.78 : 0.85),
          tr ? 0.65 : veg ? 0.92 : (emb ? 0.55 : 0.40),
          tr ? 1.00 : veg ? 0.20 : 0.20,
        );
        rubberBandRef.current = rubberLine;
      }

      // Update React coordinate display
      setHoverCoords({ x: +sx.toFixed(2), z: +sz.toFixed(2), snapped: snapping });
    };

    engine.runRenderLoop(() => scene.render());
    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      posGizmo.dispose(); rotGizmo.dispose(); scaleGizmo.dispose(); utilLayer.dispose();
      hoverDisc.dispose(); hoverDiscRef.current = null;
      vtxHL.dispose(); vertexHighlightRef.current = null;
      if (rubberBandRef.current) { rubberBandRef.current.dispose(); rubberBandRef.current = null; }
      if (vertexWireframeRef.current) { vertexWireframeRef.current.dispose(); vertexWireframeRef.current = null; }
      for (const [, container] of gltfCacheRef.current) container.dispose();
      gltfCacheRef.current.clear();
      engine.dispose(); engineRef.current = null; sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Effect A: Terrain geometry rebuild (expensive) ─────────────────────────
  // Only fires when mesh-affecting fields change — NOT when objects/plants/rocks change.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    // Excavation or noise-setting change invalidates vertex edits
    bakedHeightsRef.current = null;
    rebuildTerrain(terrain, scene);
    // Re-sync plants + rocks since heights changed, and re-snap object Y positions
    syncPlants(terrain.plants, scene);
    syncRocks(terrain.rocks, scene);
    quickUpdateObjectPositions();
    syncPolygonMarkers(polygonPoints, scene);
    syncSelectionHighlight(selectedExcavId, terrain.excavations, scene);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain.sizeM, terrain.subdivisions, terrain.maxHeightM, terrain.seed, terrain.excavations]);

  // ── Effect A2: Ground material texture-only rebuild ────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    rebuildTerrain(terrain, scene);
    quickUpdateObjectPositions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain.groundMaterial]);

  // ── Effect Vertex: Camera detach/attach + wireframe overlay ───────────────
  useEffect(() => {
    const cam    = cameraRef.current;
    const canvas = canvasRef.current;
    const scene  = sceneRef.current;
    if (!cam || !canvas) return;
    if (activeTool === 'vertexedit') {
      cam.detachControl();
      // Build coarse wireframe overlay showing mesh topology
      if (scene && heightsRef.current) {
        if (vertexWireframeRef.current) { vertexWireframeRef.current.dispose(); vertexWireframeRef.current = null; }
        const sizeM  = terrainSizeMRef.current;
        const subs   = terrainSubdivisionsRef.current;
        const count  = subs + 1;
        const heights = heightsRef.current;
        const step   = Math.max(2, Math.floor(subs / 24)); // ~24 grid lines
        const lines: Vector3[][] = [];
        for (let row = 0; row <= subs; row += step) {
          const pts: Vector3[] = [];
          for (let col = 0; col <= subs; col++) {
            pts.push(new Vector3((col / subs - 0.5) * sizeM, heights[row * count + col] + 0.06, (row / subs - 0.5) * sizeM));
          }
          lines.push(pts);
        }
        for (let col = 0; col <= subs; col += step) {
          const pts: Vector3[] = [];
          for (let row = 0; row <= subs; row++) {
            pts.push(new Vector3((col / subs - 0.5) * sizeM, heights[row * count + col] + 0.06, (row / subs - 0.5) * sizeM));
          }
          lines.push(pts);
        }
        const wf = MeshBuilder.CreateLineSystem('vtx_wireframe', { lines }, scene);
        (wf as unknown as { color: Color3 }).color = new Color3(0.3, 0.7, 1.0);
        wf.alpha = 0.55;
        vertexWireframeRef.current = wf;
      }
    } else {
      cam.attachControl(canvas, true);
      if (vertexHighlightRef.current) vertexHighlightRef.current.setEnabled(false);
      if (vertexWireframeRef.current) { vertexWireframeRef.current.dispose(); vertexWireframeRef.current = null; }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);

  // ── Effect B: Plants sync (lightweight) ───────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    syncPlants(terrain.plants, scene);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain.plants]);

  // ── Effect C: Rocks sync (lightweight) ────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    syncRocks(terrain.rocks, scene);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain.rocks]);

  // ── Effect D: Nature GLTF objects (async, only when objects list changes) ──
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    syncNatureObjects(terrain.objects ?? [], scene).then(() => setSyncCount(c => c + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain.objects]);

  // ── Effect E: Polygon markers ──────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    syncPolygonMarkers(polygonPoints, scene);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygonPoints]);

  // ── Effect F: Selection highlight ──────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    syncSelectionHighlight(selectedExcavId, terrain.excavations, scene);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExcavId, terrain.excavations]);

  // ── Effect G: Gizmo attachment + bounding box highlight ───────────────────
  useEffect(() => {
    selectedObjectIdRef.current = selectedObjectId;
    gizmoModeRef.current        = gizmoMode;
    const p = posGizmoRef.current, r = rotGizmoRef.current, s = scaleGizmoRef.current;
    if (!p || !r || !s) return;
    p.attachedNode = r.attachedNode = s.attachedNode = null;

    for (const [id, nodes] of placedNodesRef.current) {
      const sel = id === selectedObjectId;
      for (const n of nodes) n.getChildMeshes(false).forEach((m: AbstractMesh) => { m.showBoundingBox = sel; });
    }
    for (const [id, pin] of pinMeshesRef.current) {
      const mat = pin.material as StandardMaterial | null;
      if (!mat) continue;
      if (id === selectedObjectId) {
        mat.diffuseColor = new Color3(0.2, 1.0, 0.4); mat.emissiveColor = new Color3(0.1, 0.7, 0.2);
        pin.scaling.setAll(1.5);
      } else {
        mat.diffuseColor = new Color3(1.0, 0.55, 0.05); mat.emissiveColor = new Color3(0.7, 0.3, 0.0);
        pin.scaling.setAll(1.0);
      }
    }

    if (!selectedObjectId) return;
    const nodes = placedNodesRef.current.get(selectedObjectId);
    const root  = nodes?.[0] ?? null;
    if (!root) return;
    if (gizmoMode === 'move')   p.attachedNode = root;
    if (gizmoMode === 'rotate') r.attachedNode = root;
    if (gizmoMode === 'scale')  s.attachedNode = root;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedObjectId, gizmoMode, syncCount]);

  // ── Effect H: Background mode ──────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (bgLight) {
      scene.clearColor = new Color4(0.94, 0.94, 0.94, 1);
      if (hemiRef.current) { hemiRef.current.intensity = 0.9; hemiRef.current.groundColor = new Color3(0.8, 0.8, 0.8); }
      if (dirRef.current)  dirRef.current.intensity = 1.2;
    } else {
      scene.clearColor = new Color4(0.15, 0.2, 0.15, 1);
      if (hemiRef.current) { hemiRef.current.intensity = 0.6; hemiRef.current.groundColor = new Color3(0.2, 0.3, 0.2); }
      if (dirRef.current)  dirRef.current.intensity = 0.8;
    }
  }, [bgLight]);

  // ── Effect I: Snap grid wireframe ──────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    // Dispose previous
    if (snapGridMeshRef.current) { snapGridMeshRef.current.dispose(); snapGridMeshRef.current = null; }
    if (!snapEnabled) return;

    const sizeM = terrainSizeMRef.current;
    const half  = sizeM / 2;
    const step  = snapSize;
    const lines: Vector3[][] = [];
    const stepsN = Math.floor(sizeM / step) + 1;
    for (let i = 0; i <= stepsN; i++) {
      const v = -half + i * step;
      if (v > half + 0.001) break;
      lines.push([new Vector3(-half, 0.08, v), new Vector3(half, 0.08, v)]);
      lines.push([new Vector3(v, 0.08, -half), new Vector3(v, 0.08, half)]);
    }
    if (!lines.length) return;
    const gridMesh = MeshBuilder.CreateLineSystem('snap_grid', { lines }, scene);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gridMesh as any).color = new Color3(0.35, 0.72, 1.0);
    gridMesh.alpha = 0.38;
    snapGridMeshRef.current = gridMesh;
    return () => {
      gridMesh.dispose(); snapGridMeshRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapEnabled, snapSize, terrain.sizeM]);

  // ── Tool helpers ───────────────────────────────────────────────────────────
  function cancelPolygon() { setPolygonPoints([]); polygonInProgressRef.current = []; }
  function undoLastPoint() { setPolygonPoints(p => p.slice(0, -1)); }

  function deleteSelectedExcavation() {
    if (!selectedExcavId) return;
    setTerrain(t => ({ ...t, excavations: t.excavations.filter(z => z.id !== selectedExcavId) }));
    setSelectedExcavId(null);
  }

  function clearAll() {
    setTerrain(t => ({ ...t, excavations: [], rocks: [], plants: [], objects: [] }));
    setSelectedExcavId(null); setPolygonPoints([]); setSelectedObjectId(null);
    selectedObjectIdRef.current = null;
  }

  function applySettings() {
    setTerrain(t => ({
      ...t,
      seed: pendingSeed, maxHeightM: pendingMaxH,
      subdivisions: Math.max(32, Math.min(256, pendingSubs)),
      groundMaterial: pendingGroundMat,
    }));
    setShowSettings(false);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(terrain, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'terrain.json'; a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importGlb() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.glb,.gltf';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !sceneRef.current) return;

      const key      = `__import_${crypto.randomUUID()}__`;
      const label    = file.name.replace(/\.(glb|gltf)$/i, '');
      const blobUrl  = URL.createObjectURL(file);

      try {
        const container = await SceneLoader.LoadAssetContainerAsync(blobUrl, '', sceneRef.current);
        URL.revokeObjectURL(blobUrl);
        // Store in cache so syncNatureObjects can instantiate it
        gltfCacheRef.current.set(key, container);
        customLabelsRef.current[key] = label;
        // Switch to object tool and enter pending-placement mode
        setActiveTool('object');
        setPendingGLBKey(key);
        pendingGLBKeyRef.current = key;
      } catch (err) {
        URL.revokeObjectURL(blobUrl);
        console.warn('[TerrainViewer] GLB import failed:', err);
      }
    };
    input.click();
  }

  async function importJson() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const data = JSON.parse(text) as TerrainState;
        setTerrain(data);
        setPendingSeed(data.seed); setPendingMaxH(data.maxHeightM); setPendingSubs(data.subdivisions);
      } catch { /* noop */ }
    };
    input.click();
  }

  function deleteSelectedObject() {
    if (!selectedObjectId) return;
    const id = selectedObjectId;
    setSelectedObjectId(null); selectedObjectIdRef.current = null;
    setTerrain(t => ({ ...t, objects: t.objects.filter(o => o.id !== id) }));
  }

  function applyArray() {
    if (!selectedObjectId) return;
    const obj = terrain.objects?.find(o => o.id === selectedObjectId);
    if (!obj) return;
    const newObjs: PlacedObject[] = [];
    if (arrayType === 'linear') {
      for (let i = 1; i < arrayCount; i++) {
        newObjs.push({ ...obj, id: crypto.randomUUID(),
          x: obj.x + (arrayAxis === 'x' ? i * arraySpacing : 0),
          z: obj.z + (arrayAxis === 'z' ? i * arraySpacing : 0) });
      }
    } else {
      for (let row = 0; row < gridRows; row++) {
        for (let col = 0; col < gridCols; col++) {
          if (row === 0 && col === 0) continue;
          newObjs.push({ ...obj, id: crypto.randomUUID(),
            x: obj.x + col * gridSpX, z: obj.z + row * gridSpZ });
        }
      }
    }
    setTerrain(t => ({ ...t, objects: [...(t.objects ?? []), ...newObjs] }));
  }

  // ── Canvas click handler ───────────────────────────────────────────────────
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (activeTool === 'vertexedit') return; // handled by pointer observable

    const snap = (v: number) => snapEnabled ? snapToGrid(v, snapSize) : v;

    if (activeTool === 'object') {
      const clickX = e.nativeEvent.offsetX;
      const clickY = e.nativeEvent.offsetY;
      const engine = engineRef.current;
      const cam    = scene.activeCamera;

      // ── Handle pending GLB placement ───────────────────────────────────────
      if (pendingGLBKey) {
        const tp = scene.pick(clickX, clickY, m => m.name === 'terrain');
        if (tp.hit && tp.pickedPoint) {
          const px = snap(tp.pickedPoint.x);
          const pz = snap(tp.pickedPoint.z);
          const obj: PlacedObject = {
            id: crypto.randomUUID(), gltfFile: pendingGLBKey,
            label: customLabelsRef.current[pendingGLBKey] ?? pendingGLBKey,
            x: px, z: pz, rotY: 0, scale: objectScaleRef.current,
          };
          setTerrain(t => ({ ...t, objects: [...(t.objects ?? []), obj] }));
        }
        setPendingGLBKey(null);
        pendingGLBKeyRef.current = null;
        return;
      }

      // ── Screen-space proximity selection ──────────────────────────────────
      if (engine && cam) {
        const viewport  = cam.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
        const transform = scene.getTransformMatrix();
        let closestId: string | null = null;
        let closestDist = 64;
        for (const [id, roots] of placedNodesRef.current) {
          const root = roots[0];
          if (!root) continue;
          const worldPos = new Vector3(root.position.x, root.position.y + 1.5, root.position.z);
          const screen   = Vector3.Project(worldPos, Matrix.IdentityReadOnly, transform, viewport);
          if (screen.z <= 0 || screen.z >= 1) continue;
          const d = Math.hypot(clickX - screen.x, clickY - screen.y);
          if (d < closestDist) { closestDist = d; closestId = id; }
        }
        if (closestId) {
          setSelectedObjectId(closestId); selectedObjectIdRef.current = closestId; return;
        }
      }

      // ── Deselect + place new nature object ────────────────────────────────
      setSelectedObjectId(null); selectedObjectIdRef.current = null;
      if (!selectedNatureGltf) return;
      const tp = scene.pick(clickX, clickY, m => m.name === 'terrain');
      if (!tp.hit || !tp.pickedPoint) return;
      const px = snap(tp.pickedPoint.x);
      const pz = snap(tp.pickedPoint.z);
      const obj: PlacedObject = {
        id: crypto.randomUUID(), gltfFile: selectedNatureGltf,
        x: px, z: pz, rotY: Math.random() * Math.PI * 2, scale: objectScaleRef.current,
      };
      setTerrain(t => ({ ...t, objects: [...(t.objects ?? []), obj] }));
      return;
    }

    // ── Other tools: pick terrain ──────────────────────────────────────────
    const pickResult = scene.pick(e.nativeEvent.offsetX, e.nativeEvent.offsetY, m => m.name === 'terrain');
    if (!pickResult.hit || !pickResult.pickedPoint) return;
    const px = snap(pickResult.pickedPoint.x);
    const pz = snap(pickResult.pickedPoint.z);

    if (activeTool === 'excavate' || activeTool === 'embankment' || activeTool === 'trench' || activeTool === 'vegscatter') {
      const newPts: [number, number][] = [...polygonPoints, [px, pz]];
      setPolygonPoints(newPts); polygonInProgressRef.current = newPts;
    } else if (activeTool === 'rock') {
      const rock: RockInstance = {
        id: crypto.randomUUID(), x: px, z: pz,
        scale: 0.5 + Math.random() * 1.5, rotY: Math.random() * Math.PI * 2,
      };
      setTerrain(t => ({ ...t, rocks: [...t.rocks, rock] }));
    } else if (activeTool === 'plant') {
      const plant: PlantInstance = {
        id: crypto.randomUUID(), x: px, z: pz,
        type: plantTypeOverrideRef.current, scale: 0.8 + Math.random() * 0.6,
      };
      setTerrain(t => ({ ...t, plants: [...t.plants, plant] }));
    } else if (activeTool === 'select') {
      let bestId: string | null = null, bestDist = 5;
      for (const zone of terrain.excavations) {
        const cx = zone.polygon.reduce((s, [x]) => s + x, 0) / zone.polygon.length;
        const cz = zone.polygon.reduce((s, [, z]) => s + z, 0) / zone.polygon.length;
        const d  = Math.hypot(px - cx, pz - cz);
        if (d < bestDist) { bestDist = d; bestId = zone.id; }
      }
      setSelectedExcavId(bestId);
    }
  }, [activeTool, polygonPoints, terrain.excavations, selectedNatureGltf, snapEnabled, snapSize, pendingGLBKey]);

  const handleCanvasDblClick = useCallback(() => {
    if (activeTool === 'excavate' || activeTool === 'embankment') {
      if (polygonPoints.length < 3) return;
      const zone: ExcavationZone = {
        id: crypto.randomUUID(), polygon: polygonPoints,
        depth: excavationDepth, slope: excavationSlope,
        type: activeTool === 'embankment' ? 'embankment' : excavationType,
      };
      setTerrain(t => ({ ...t, excavations: [...t.excavations, zone] }));
      setPolygonPoints([]); polygonInProgressRef.current = [];
    } else if (activeTool === 'trench') {
      if (polygonPoints.length < 2) return;
      const poly = pathToPolygon(polygonPoints, trenchWidth / 2);
      if (poly.length >= 3) {
        const zone: ExcavationZone = {
          id: crypto.randomUUID(), polygon: poly,
          depth: trenchDepth, slope: trenchAngle,
          type: 'trench',
        };
        setTerrain(t => ({ ...t, excavations: [...t.excavations, zone] }));
      }
      setPolygonPoints([]); polygonInProgressRef.current = [];
    } else if (activeTool === 'vegscatter') {
      if (polygonPoints.length < 3) return;
      const newObjs = scatterInPolygon(polygonPoints, scatterDensity, scatterPlants, scatterScale);
      if (newObjs.length > 0) {
        setTerrain(t => ({ ...t, objects: [...(t.objects ?? []), ...newObjs] }));
      }
      setPolygonPoints([]); polygonInProgressRef.current = [];
    }
  }, [activeTool, polygonPoints, excavationDepth, excavationSlope, excavationType,
      trenchWidth, trenchDepth, trenchAngle, scatterDensity, scatterPlants, scatterScale]);

  // ── Render ────────────────────────────────────────────────────────────────
  const toolBtn = (tool: TerrainTool, label: string, icon: string) => (
    <button
      key={tool} title={label}
      onClick={() => { setActiveTool(tool); if (tool !== 'excavate' && tool !== 'embankment' && tool !== 'trench' && tool !== 'vegscatter') cancelPolygon(); setPendingGLBKey(null); pendingGLBKeyRef.current = null; }}
      style={{
        padding: '4px 8px', fontSize: 12, cursor: 'pointer', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 4,
        background: activeTool === tool ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
        color: activeTool === tool ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
        border: `1px solid ${activeTool === tool ? 'hsl(var(--primary))' : 'hsl(var(--border))'}`,
      }}
    >
      <span>{icon}</span><span style={{ fontSize: 10 }}>{label}</span>
    </button>
  );

  const isDrawing = (activeTool === 'excavate' || activeTool === 'embankment' || activeTool === 'trench' || activeTool === 'vegscatter') && polygonPoints.length > 0;

  return (
    <div className={cn('relative flex flex-col w-full h-full overflow-hidden', bgLight ? 'bg-[#f0f2f5]' : 'bg-[#1a2318]', className)}>

      {/* ── Toolbar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px',
        background: 'hsl(var(--background))', borderBottom: '1px solid hsl(var(--border))',
        flexWrap: 'wrap', minHeight: 38,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'hsl(var(--foreground))', marginRight: 2 }}>
          🏔
        </span>

        {/* Edit tools */}
        <span style={toolGroupLabelStyle}>EDIT</span>
        {toolBtn('select',     'Select',     '↖')}
        {toolBtn('excavate',   'Excavate',   '⛏')}
        {toolBtn('embankment', 'Embankment', '▲')}
        {toolBtn('trench',     'Trench',     '〰')}
        {toolBtn('vertexedit', 'Vertex',     '✦')}

        <div style={dividerStyle} />

        {/* Place tools */}
        <span style={toolGroupLabelStyle}>PLACE</span>
        {toolBtn('rock',       'Rock',      '🪨')}
        {toolBtn('plant',      'Plant',     '🌱')}
        {toolBtn('vegscatter', 'Scatter',   '🌿')}
        {toolBtn('object',     'Objects',   '🌲')}

        <div style={dividerStyle} />

        {/* Snap controls */}
        <span style={toolGroupLabelStyle}>SNAP</span>
        <button
          onClick={() => setSnapEnabled(v => !v)}
          title={snapEnabled ? 'Disable grid snap' : 'Enable grid snap'}
          style={{
            padding: '4px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 4,
            background: snapEnabled ? '#1d4ed8' : 'hsl(var(--muted))',
            color: snapEnabled ? '#dbeafe' : 'hsl(var(--muted-foreground))',
            border: `1px solid ${snapEnabled ? '#3b82f6' : 'hsl(var(--border))'}`,
            fontWeight: snapEnabled ? 700 : 400,
          }}
        >
          🔲 {snapEnabled ? 'On' : 'Off'}
        </button>
        {snapEnabled && (
          <div style={{ display: 'flex', gap: 3 }}>
            {SNAP_SIZES.map(sz => (
              <button
                key={sz}
                onClick={() => setSnapSize(sz)}
                style={{
                  padding: '3px 7px', fontSize: 10, cursor: 'pointer', borderRadius: 4,
                  background: snapSize === sz ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                  color: snapSize === sz ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                  border: `1px solid ${snapSize === sz ? 'hsl(var(--primary))' : 'hsl(var(--border))'}`,
                }}
              >
                {sz < 1 ? sz : sz}m
              </button>
            ))}
          </div>
        )}

        <div style={dividerStyle} />

        {/* Drawing state */}
        {isDrawing && (
          <>
            <button onClick={undoLastPoint} style={btnStyle}>↩ Undo</button>
            <button onClick={cancelPolygon} style={btnStyle}>✕ Cancel</button>
            <span style={{ fontSize: 10, color: '#f59e0b' }}>
              {polygonPoints.length} pt{polygonPoints.length !== 1 ? 's' : ''} ·{' '}
              {activeTool === 'trench' ? 'min 2 pts · dbl-click to apply' : 'dbl-click to close'}
            </span>
          </>
        )}
        {activeTool === 'select' && selectedExcavId && (
          <button onClick={deleteSelectedExcavation} style={{ ...btnStyle, color: '#ef4444' }}>🗑 Del zone</button>
        )}

        {/* Right side actions */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 5, alignItems: 'center' }}>
          <button onClick={() => { setShowSettings(s => !s); setPendingGroundMat(terrain.groundMaterial ?? 'grass'); }} style={btnStyle}>⚙ Settings</button>
          <button
            onClick={() => setBgLight(v => !v)}
            style={{ ...btnStyle, background: bgLight ? '#e8e8e8' : 'hsl(var(--muted))', color: bgLight ? '#333' : 'hsl(var(--muted-foreground))' }}
          >{bgLight ? '🌑 Dark' : '☀ Light'}</button>
          <button onClick={importGlb} style={btnStyle} title="Import GLB/GLTF — click to place on terrain">📦 GLB</button>
          <button onClick={clearAll} style={{ ...btnStyle, color: '#ef4444' }}>🗑 All</button>
          <button onClick={exportJson} style={btnStyle}>⬇ Export</button>
          <button onClick={importJson} style={btnStyle}>⬆ Import</button>
        </div>
      </div>

      {/* ── Pending GLB placement banner ── */}
      {pendingGLBKey && (
        <div style={{
          background: '#1d4ed8', color: '#dbeafe', padding: '6px 14px',
          fontSize: 11, display: 'flex', alignItems: 'center', gap: 10,
          borderBottom: '1px solid #3b82f6',
        }}>
          <span>📦 <b>Place mode:</b> Click on terrain to place <b>{customLabelsRef.current[pendingGLBKey] ?? 'model'}</b>{snapEnabled ? ` (snap ${snapSize}m)` : ''}</span>
          <button onClick={() => { setPendingGLBKey(null); pendingGLBKeyRef.current = null; }}
            style={{ marginLeft: 'auto', background: 'none', border: '1px solid #60a5fa', color: '#93c5fd', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 10 }}>
            Cancel
          </button>
        </div>
      )}

      {/* ── Settings panel ── */}
      {showSettings && (
        <div style={{
          position: 'absolute', top: 44, right: 12, zIndex: 50,
          background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))',
          borderRadius: 8, padding: 14, width: 240, boxShadow: '0 4px 24px #0005',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: 'hsl(var(--foreground))' }}>⚙ Terrain Settings</div>

          {/* Ground material */}
          <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', marginBottom: 4 }}>Ground material</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 10 }}>
            {([
              { key: 'grass',  label: '🌿 Grass',  bg: '#3d6b3d' },
              { key: 'dirt',   label: '🟫 Dirt',   bg: '#6b4a2a' },
              { key: 'gravel', label: '⬜ Gravel', bg: '#787068' },
              { key: 'sand',   label: '🟡 Sand',   bg: '#c4a96a' },
            ] as { key: GroundMaterial; label: string; bg: string }[]).map(({ key, label, bg }) => (
              <button key={key} onClick={() => setPendingGroundMat(key)} style={{
                padding: '5px 4px', fontSize: 10, cursor: 'pointer', borderRadius: 4, textAlign: 'left',
                background: pendingGroundMat === key ? bg : 'hsl(var(--muted))',
                color: pendingGroundMat === key ? '#fff' : 'hsl(var(--muted-foreground))',
                border: `2px solid ${pendingGroundMat === key ? bg : 'hsl(var(--border))'}`,
                fontWeight: pendingGroundMat === key ? 700 : 400,
              }}>
                {label}
              </button>
            ))}
          </div>

          {([
            { label: 'Seed', val: pendingSeed, set: setPendingSeed, min: 0, max: 9999, step: 1 },
            { label: 'Max height (m)', val: pendingMaxH, set: setPendingMaxH, min: 0.5, max: 30, step: 0.5 },
            { label: 'Subdivisions', val: pendingSubs, set: setPendingSubs, min: 32, max: 256, step: 16 },
          ] as { label: string; val: number; set: (v: number) => void; min: number; max: number; step: number }[]).map(({ label, val, set, min, max, step }) => (
            <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', width: 110 }}>{label}</span>
              <input type="number" min={min} max={max} step={step} value={val}
                onChange={e => set(Number(e.target.value))}
                style={inputStyle} />
            </label>
          ))}
          <button onClick={applySettings} style={{ ...btnStyle, width: '100%', marginTop: 4 }}>Apply & Regenerate</button>
        </div>
      )}

      {/* ── Side panel + Canvas ── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* Excavation panel */}
        {(activeTool === 'excavate' || activeTool === 'embankment') && (
          <div style={sidePanelStyle}>
            <div style={panelTitleStyle}>
              {activeTool === 'embankment' ? '▲ Embankment' : '⛏ Excavation'}
            </div>
            {activeTool === 'excavate' && (
              <label style={labelStyle}>
                <span style={labelTextStyle}>Type</span>
                <select value={excavationType} onChange={e => setExcavationType(e.target.value as ExcavationZone['type'])} style={selectStyle}>
                  <option value="trench">Trench</option>
                  <option value="pit">Pit</option>
                </select>
              </label>
            )}
            <label style={labelStyle}>
              <span style={labelTextStyle}>Depth (m)</span>
              <input type="number" min={0.1} max={20} step={0.1} value={excavationDepth}
                onChange={e => setExcavationDepth(Number(e.target.value))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              <span style={labelTextStyle}>Slope (°)</span>
              <input type="range" min={0} max={60} step={1} value={excavationSlope}
                onChange={e => setExcavationSlope(Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', width: 28 }}>{excavationSlope}°</span>
            </label>
            <div style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', marginTop: 4, lineHeight: 1.5, padding: '6px 0', borderTop: '1px solid hsl(var(--border)/0.5)' }}>
              Floor is <b>flat horizontal</b> at the average boundary elevation − depth.<br />
              Slope = angle of walls (0° = vertical).
            </div>
            <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', marginTop: 8, lineHeight: 1.5 }}>
              Click to add polygon points.<br />
              <b>Double-click</b> to close and apply.
            </div>
            {terrain.excavations.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 600, marginBottom: 4, color: 'hsl(var(--muted-foreground))' }}>
                  Zones ({terrain.excavations.length})
                </div>
                {terrain.excavations.map((z, i) => (
                  <div key={z.id}
                    onClick={() => setSelectedExcavId(z.id === selectedExcavId ? null : z.id)}
                    style={{
                      padding: '3px 6px', borderRadius: 4, cursor: 'pointer', fontSize: 10, marginBottom: 2,
                      background: z.id === selectedExcavId ? 'hsl(var(--accent))' : 'hsl(var(--muted))',
                      color: 'hsl(var(--foreground))',
                    }}
                  >
                    {z.type === 'embankment' ? '▲' : '⛏'} Zone {i + 1} — {z.depth.toFixed(1)} m
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Trench panel */}
        {activeTool === 'trench' && (
          <div style={sidePanelStyle}>
            <div style={panelTitleStyle}>〰 Trench</div>
            <label style={labelStyle}>
              <span style={labelTextStyle}>Width (m)</span>
              <input type="number" min={0.5} max={50} step={0.5} value={trenchWidth}
                onChange={e => setTrenchWidth(Number(e.target.value))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              <span style={labelTextStyle}>Depth (m)</span>
              <input type="number" min={0.1} max={20} step={0.1} value={trenchDepth}
                onChange={e => setTrenchDepth(Number(e.target.value))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              <span style={labelTextStyle}>Bank angle (°)</span>
              <input type="range" min={0} max={60} step={1} value={trenchAngle}
                onChange={e => setTrenchAngle(Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', width: 28 }}>{trenchAngle}°</span>
            </label>
            <div style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', marginTop: 4, lineHeight: 1.6, padding: '6px 0', borderTop: '1px solid hsl(var(--border)/0.5)' }}>
              Draw a <b>centerline path</b>.<br />
              Trench expands ±{(trenchWidth / 2).toFixed(1)} m on each side.<br />
              Floor is <b>flat</b> at boundary avg − depth.<br />
              Bank angle = slope of walls.
            </div>
            <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', marginTop: 8, lineHeight: 1.5 }}>
              Click to add path points.<br />
              <b>Double-click</b> last point to apply.
            </div>
            {terrain.excavations.filter(z => z.type === 'trench').length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 600, marginBottom: 4, color: 'hsl(var(--muted-foreground))' }}>
                  Trenches ({terrain.excavations.filter(z => z.type === 'trench').length})
                </div>
                {terrain.excavations.filter(z => z.type === 'trench').map((z, i) => (
                  <div key={z.id}
                    onClick={() => setSelectedExcavId(z.id === selectedExcavId ? null : z.id)}
                    style={{
                      padding: '3px 6px', borderRadius: 4, cursor: 'pointer', fontSize: 10, marginBottom: 2,
                      background: z.id === selectedExcavId ? 'hsl(var(--accent))' : 'hsl(var(--muted))',
                      color: 'hsl(var(--foreground))',
                    }}
                  >
                    〰 Trench {i + 1} — {z.depth.toFixed(1)} m deep
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Vegscatter panel */}
        {activeTool === 'vegscatter' && (
          <div style={{ ...sidePanelStyle, width: 220 }}>
            <div style={panelTitleStyle}>🌿 Veg. Scatter</div>
            <label style={labelStyle}>
              <span style={labelTextStyle}>Density</span>
              <input type="range" min={1} max={50} step={1} value={scatterDensity}
                onChange={e => setScatterDensity(Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', width: 50 }}>{scatterDensity}/100m²</span>
            </label>
            <label style={labelStyle}>
              <span style={labelTextStyle}>Scale</span>
              <input type="range" min={0.3} max={3.0} step={0.1} value={scatterScale}
                onChange={e => setScatterScale(Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', width: 28 }}>×{scatterScale.toFixed(1)}</span>
            </label>

            <div style={{ fontSize: 10, fontWeight: 600, color: 'hsl(var(--foreground))', margin: '6px 0 4px' }}>
              Plants for shuffle
            </div>
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {NATURE_CATEGORIES.map(cat => {
                const catAssets = NATURE_ASSETS.filter(a => a.category === cat);
                const allSel    = catAssets.every(a => scatterPlants.includes(a.file));
                const someSel   = catAssets.some(a => scatterPlants.includes(a.file));
                return (
                  <div key={cat}>
                    <button
                      onClick={() => setScatterPlants(prev => {
                        const files = catAssets.map(a => a.file);
                        return allSel ? prev.filter(f => !files.includes(f)) : [...new Set([...prev, ...files])];
                      })}
                      style={{
                        width: '100%', textAlign: 'left', padding: '3px 6px', fontSize: 10,
                        cursor: 'pointer', borderRadius: 4, marginBottom: 2,
                        background: allSel ? 'hsl(var(--primary))' : someSel ? 'hsl(var(--accent))' : 'hsl(var(--muted))',
                        color: allSel ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
                        border: `1px solid ${allSel ? 'hsl(var(--primary))' : 'hsl(var(--border))'}`,
                        fontWeight: 600,
                      }}
                    >
                      {catAssets[0]?.emoji} {cat}
                    </button>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, paddingLeft: 8, marginBottom: 4 }}>
                      {catAssets.map(asset => {
                        const sel = scatterPlants.includes(asset.file);
                        return (
                          <button key={asset.file}
                            onClick={() => setScatterPlants(prev =>
                              sel ? prev.filter(f => f !== asset.file) : [...prev, asset.file]
                            )}
                            style={{
                              padding: '2px 5px', fontSize: 9, cursor: 'pointer', borderRadius: 4,
                              background: sel ? '#1d4ed8' : 'hsl(var(--muted))',
                              color: sel ? '#dbeafe' : 'hsl(var(--muted-foreground))',
                              border: `1px solid ${sel ? '#3b82f6' : 'hsl(var(--border))'}`,
                            }}
                          >
                            {asset.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', marginTop: 4, lineHeight: 1.6, padding: '6px 0', borderTop: '1px solid hsl(var(--border)/0.5)' }}>
              Draw a polygon, <b>double-click</b> to scatter.<br />
              {scatterPlants.length > 0
                ? <>{scatterPlants.length} plant type{scatterPlants.length !== 1 ? 's' : ''} in shuffle.</>
                : <span style={{ color: '#ef4444' }}>⚠ Select at least one plant.</span>}
            </div>
          </div>
        )}

        {/* Vertex edit panel */}
        {activeTool === 'vertexedit' && (
          <div style={sidePanelStyle}>
            <div style={panelTitleStyle}>✦ Vertex Edit</div>
            <div style={{
              padding: '6px 8px', borderRadius: 5, marginBottom: 8,
              background: 'rgba(48,180,255,0.12)', border: '1px solid rgba(48,180,255,0.3)',
              fontSize: 9, color: '#7dd3fc', lineHeight: 1.7,
            }}>
              Camera orbit is <b>disabled</b> in this mode.<br />
              Hover a vertex → blue sphere snaps to it.<br />
              <b>Click + drag up/down</b> to move the vertex.<br />
              Exit mode to re-enable orbit.
            </div>
            <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
              Drag sensitivity: 0.04 m / px<br />
              Topology grid shown at ≈24 lines.
            </div>
            <div style={{ fontSize: 9, color: '#f59e0b', marginTop: 10, lineHeight: 1.5 }}>
              ⚠ Adding excavations or changing terrain settings will reset vertex edits.
            </div>
            {bakedHeightsRef.current && (
              <div style={{ marginTop: 10, fontSize: 10, color: '#4ade80' }}>
                ✓ {bakedHeightsRef.current.length} vertex heights saved
              </div>
            )}
            <button
              onClick={() => { bakedHeightsRef.current = null; const s = sceneRef.current; if (s) rebuildTerrain(terrain, s); }}
              style={{ ...btnStyle, marginTop: 12, color: '#ef4444', width: '100%' }}
            >
              Reset vertex edits
            </button>
          </div>
        )}

        {(activeTool === 'rock' || activeTool === 'plant') && (
          <div style={sidePanelStyle}>
            <div style={panelTitleStyle}>{activeTool === 'rock' ? '🪨 Rocks' : '🌱 Plants'}</div>
            <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', lineHeight: 1.5, marginBottom: 10 }}>
              {activeTool === 'rock'
                ? 'Click on terrain to place a rock (random scale/rotation).'
                : 'Click on terrain to place a plant. Choose type below.'}
            </div>
            {activeTool === 'plant' && (
              <label style={labelStyle}>
                <span style={labelTextStyle}>Type</span>
                <select style={selectStyle} defaultValue="tree" onChange={e => { plantTypeOverrideRef.current = e.target.value as PlantType; }}>
                  <option value="tree">Tree</option>
                  <option value="bush">Bush</option>
                  <option value="grass">Grass</option>
                </select>
              </label>
            )}
            {snapEnabled && (
              <div style={{ fontSize: 10, color: '#60a5fa', marginTop: 4, padding: '4px 6px', background: '#1e3a5f50', borderRadius: 4 }}>
                🔲 Snap {snapSize}m active
              </div>
            )}
            <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', marginTop: 10 }}>
              Rocks: {terrain.rocks.length} · Plants: {terrain.plants.length}
            </div>
            {(terrain.rocks.length > 0 || terrain.plants.length > 0) && (
              <button onClick={() => setTerrain(t => ({ ...t, rocks: [], plants: [] }))}
                style={{ ...btnStyle, marginTop: 8, color: '#ef4444' }}>Clear rocks & plants</button>
            )}
          </div>
        )}

        {/* ── Nature Library Panel ── */}
        {activeTool === 'object' && (
          <div style={{ ...sidePanelStyle, width: 230 }}>

            {/* Selected object transform panel */}
            {selectedObjectId && (() => {
              const selObj   = terrain.objects?.find(o => o.id === selectedObjectId);
              const selAsset = NATURE_ASSETS.find(a => a.file === selObj?.gltfFile);
              const selLabel = selObj?.label ?? selAsset?.label ?? selObj?.gltfFile ?? '';
              const selEmoji = selAsset?.emoji ?? '📦';
              return (
                <div style={{ padding: 12, borderBottom: '1px solid hsl(var(--border))', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                      {selEmoji} {selLabel}
                    </span>
                    <button onClick={() => { setSelectedObjectId(null); selectedObjectIdRef.current = null; }}
                      style={{ ...btnStyle, padding: '2px 6px', fontSize: 10 }} title="Deselect">✕</button>
                  </div>

                  {/* Gizmo buttons */}
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['move', 'rotate', 'scale'] as ObjectGizmoMode[]).map(m => (
                      <button key={m} onClick={() => setGizmoMode(m)} style={{
                        flex: 1, padding: '4px 2px', fontSize: 10, cursor: 'pointer', borderRadius: 4,
                        background: gizmoMode === m ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                        color: gizmoMode === m ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                        border: '1px solid hsl(var(--border))',
                      }}>
                        {m === 'move' ? '🔀 Move' : m === 'rotate' ? '↺ Rot' : '⇱ Scale'}
                      </button>
                    ))}
                  </div>

                  {snapEnabled && (
                    <div style={{ fontSize: 10, color: '#60a5fa', padding: '3px 6px', background: '#1e3a5f50', borderRadius: 4 }}>
                      🔲 Gizmo snaps to {snapSize}m grid on drag-end
                    </div>
                  )}

                  {/* Array section */}
                  <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: 8 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: 'hsl(var(--foreground))', marginBottom: 6 }}>📐 Array</div>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                      {(['linear', 'grid'] as const).map(t => (
                        <button key={t} onClick={() => setArrayType(t)} style={{
                          flex: 1, padding: '3px 0', fontSize: 10, cursor: 'pointer', borderRadius: 4,
                          background: arrayType === t ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                          color: arrayType === t ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                          border: '1px solid hsl(var(--border))',
                        }}>
                          {t === 'linear' ? '↔ Linear' : '⊞ Grid'}
                        </button>
                      ))}
                    </div>
                    {arrayType === 'linear' ? (
                      <>
                        <label style={labelStyle}>
                          <span style={labelTextStyle}>Count</span>
                          <input type="number" min={2} max={50} value={arrayCount}
                            onChange={e => setArrayCount(Number(e.target.value))} style={inputStyle} />
                        </label>
                        <label style={labelStyle}>
                          <span style={labelTextStyle}>Spacing (m)</span>
                          <input type="number" min={0.5} max={100} step={0.5} value={arraySpacing}
                            onChange={e => setArraySpacing(Number(e.target.value))} style={inputStyle} />
                        </label>
                        <label style={labelStyle}>
                          <span style={labelTextStyle}>Axis</span>
                          <select value={arrayAxis} onChange={e => setArrayAxis(e.target.value as 'x' | 'z')} style={selectStyle}>
                            <option value="x">X (East)</option>
                            <option value="z">Z (North)</option>
                          </select>
                        </label>
                        <div style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))' }}>Creates {arrayCount - 1} copies</div>
                      </>
                    ) : (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                          {([['Rows', gridRows, setGridRows], ['Cols', gridCols, setGridCols],
                             ['SpX (m)', gridSpX, setGridSpX], ['SpZ (m)', gridSpZ, setGridSpZ]] as [string, number, (v: number) => void][]).map(([lbl, val, set]) => (
                            <label key={lbl} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))' }}>{lbl}</span>
                              <input type="number" min={0.5} max={50} step={lbl.includes('S') ? 0.5 : 1} value={val}
                                onChange={e => set(Number(e.target.value))} style={inputStyle} />
                            </label>
                          ))}
                        </div>
                        <div style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', marginTop: 2 }}>Creates {gridRows * gridCols - 1} copies</div>
                      </>
                    )}
                    <button onClick={applyArray}
                      style={{ ...btnStyle, width: '100%', marginTop: 6, background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}>
                      Apply Array
                    </button>
                  </div>

                  <button onClick={deleteSelectedObject} style={{ ...btnStyle, color: '#ef4444', width: '100%' }}>🗑 Delete object</button>
                </div>
              );
            })()}

            {/* Library section */}
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'hsl(var(--foreground))' }}>🌲 Nature Library</div>

              <NaturePreviewCanvas gltfFile={selectedNatureGltf} />

              {snapEnabled && (
                <div style={{ fontSize: 10, color: '#60a5fa', padding: '3px 6px', background: '#1e3a5f50', borderRadius: 4 }}>
                  🔲 Placement snaps to {snapSize}m grid
                </div>
              )}

              <label style={labelStyle}>
                <span style={labelTextStyle}>Scale</span>
                <input type="range" min={0.3} max={3.0} step={0.1} value={objectScale}
                  onChange={e => { const v = Number(e.target.value); setObjectScale(v); objectScaleRef.current = v; }}
                  style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', width: 28 }}>×{objectScale.toFixed(1)}</span>
              </label>

              {NATURE_CATEGORIES.map(cat => (
                <div key={cat}>
                  <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'hsl(var(--muted-foreground))', marginBottom: 4, marginTop: 4 }}>{cat}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
                    {NATURE_ASSETS.filter(a => a.category === cat).map(asset => (
                      <button key={asset.file} title={asset.label}
                        onClick={() => setSelectedNatureGltf(asset.file === selectedNatureGltf ? null : asset.file)}
                        style={{
                          padding: '3px 5px', fontSize: 10, cursor: 'pointer', borderRadius: 4,
                          textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          background: asset.file === selectedNatureGltf ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                          color: asset.file === selectedNatureGltf ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
                          border: `1px solid ${asset.file === selectedNatureGltf ? 'hsl(var(--primary))' : 'hsl(var(--border))'}`,
                        }}
                      >
                        {asset.emoji} {asset.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', marginTop: 4 }}>
                Placed: {(terrain.objects ?? []).length}
              </div>
              {(terrain.objects ?? []).length > 0 && (
                <button onClick={() => setTerrain(t => ({ ...t, objects: [] }))}
                  style={{ ...btnStyle, color: '#ef4444' }}>🗑 Clear all objects</button>
              )}
            </div>
          </div>
        )}

        {/* 3D Canvas */}
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <canvas
            ref={canvasRef}
            style={{ width: '100%', height: '100%', display: 'block', outline: 'none' }}
            onClick={handleCanvasClick}
            onDoubleClick={handleCanvasDblClick}
            onMouseLeave={() => {
              setHoverCoords(null);
              if (hoverDiscRef.current) hoverDiscRef.current.setEnabled(false);
              if (rubberBandRef.current) { rubberBandRef.current.dispose(); rubberBandRef.current = null; }
            }}
          />
          {isDrawing && (
            <div style={{
              position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
              background: '#00000099', color: '#fff', padding: '4px 12px',
              borderRadius: 20, fontSize: 11, pointerEvents: 'none',
            }}>
              {polygonPoints.length} pt{polygonPoints.length !== 1 ? 's' : ''} · Double-click to close
            </div>
          )}
          {snapEnabled && activeTool === 'object' && !pendingGLBKey && !selectedNatureGltf && (
            <div style={{
              position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
              background: '#1d4ed8cc', color: '#dbeafe', padding: '3px 12px',
              borderRadius: 20, fontSize: 10, pointerEvents: 'none',
            }}>
              🔲 Grid {snapSize}m · Select a model to place
            </div>
          )}
          {hoverCoords && (
            <div style={{
              position: 'absolute', bottom: 8, right: 8,
              background: '#000000aa', color: '#e2e8f0', padding: '3px 10px',
              borderRadius: 4, fontSize: 10, pointerEvents: 'none', fontFamily: 'monospace',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span>X: {hoverCoords.x.toFixed(2)}</span>
              <span style={{ color: '#94a3b8' }}>·</span>
              <span>Z: {hoverCoords.z.toFixed(2)}</span>
              {hoverCoords.snapped && (
                <span style={{ color: '#60a5fa', marginLeft: 2 }}>⊞</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Module-level refs (shared between component instances) ───────────────────
const plantTypeOverrideRef = { current: 'tree' as PlantType };
const objectScaleRef       = { current: 1.0 };

// ─── Terrain height sampling ──────────────────────────────────────────────────
function sampleTerrainHeight(
  wx: number, wz: number,
  sizeM: number, subdivisions: number,
  heights: Float32Array | null,
): number {
  if (!heights) return 0;
  const count = subdivisions + 1;
  const col = Math.round(((wx / sizeM) + 0.5) * subdivisions);
  const row = Math.round(((wz / sizeM) + 0.5) * subdivisions);
  const ci  = Math.max(0, Math.min(count - 1, col));
  const ri  = Math.max(0, Math.min(count - 1, row));
  return heights[ri * count + ci] ?? 0;
}

// ─── Shared inline styles ─────────────────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  padding: '3px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 4,
  background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))',
  border: '1px solid hsl(var(--border))',
};

const dividerStyle: React.CSSProperties = {
  width: 1, height: 20, background: 'hsl(var(--border))', margin: '0 2px',
};

const toolGroupLabelStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, color: 'hsl(var(--muted-foreground))',
  textTransform: 'uppercase', letterSpacing: 0.8, userSelect: 'none',
};

const sidePanelStyle: React.CSSProperties = {
  width: 200, flexShrink: 0, background: 'hsl(var(--card))',
  borderRight: '1px solid hsl(var(--border))', padding: 12,
  overflowY: 'auto', display: 'flex', flexDirection: 'column',
};

const panelTitleStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, marginBottom: 10, color: 'hsl(var(--foreground))',
};

const labelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
};

const labelTextStyle: React.CSSProperties = {
  fontSize: 10, color: 'hsl(var(--muted-foreground))', width: 80,
};

const inputStyle: React.CSSProperties = {
  flex: 1, background: 'hsl(var(--input))', border: '1px solid hsl(var(--border))',
  borderRadius: 4, padding: '2px 6px', fontSize: 11, color: 'hsl(var(--foreground))',
};

const selectStyle: React.CSSProperties = {
  flex: 1, background: 'hsl(var(--input))', border: '1px solid hsl(var(--border))',
  borderRadius: 4, padding: '2px 6px', fontSize: 11, color: 'hsl(var(--foreground))',
};
