/**
 * IFCTilesViewer.tsx — Three.js IFC viewer with custom GLB tile streaming.
 *
 * Pipeline:
 *   IFC drop → SHA-256 hash → IndexedDB cache check
 *     ├── HIT  → load manifest → start TileStreamingManager
 *     └── MISS → spawn Web Worker → receive tile_data msgs
 *                → build Three.js scene → GLTFExporter → cache → IndexedDB
 *                → start TileStreamingManager
 *
 * Rendering:
 *   Three.js PerspectiveCamera + WebGLRenderer + OrbitControls
 *   TileStreamingManager: frustum culling, LRU budget 512 MB, 3 concurrent loads
 *   three-mesh-bvh: accelerated raycasting for element selection
 *   TransformControls: move/rotate/scale selected elements
 *   three-bvh-csg: wall opening regeneration when windows/doors are moved
 *
 * Coordinate system: Three.js Y-up  (X=East, Y=Up, Z=North/Depth)
 * Units: metres
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import {
  computeBoundsTree, disposeBoundsTree, acceleratedRaycast,
} from 'three-mesh-bvh';
import { Brush, Evaluator, ADDITION, SUBTRACTION } from 'three-bvh-csg';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { cn } from '@/lib/utils';
import type {
  RootManifest, TileManifestEntry, WorkerOutMsg,
  WorkerTileDataMsg, ElementMetaMap, ElementMeta, OpeningInfo,
} from '@/lib/tileManifest';
import {
  hashBuffer, cacheTileGLB, loadTileGLB,
  cacheManifest, loadManifest, cacheMetadata, loadMetadata,
  registerProject, listCachedProjects, deleteProject, projectExists,
  type CachedProjectInfo,
} from '@/lib/ifcTileCache';

// ─── Patch THREE prototypes for three-mesh-bvh ───────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ─── Constants ────────────────────────────────────────────────────────────────

const WASM_PATH            = '/node_modules/web-ifc/';
const TILE_BUDGET_BYTES    = 512 * 1024 * 1024; // 512 MB
const MAX_CONCURRENT_LOADS = 3;
const LOD_SWITCH_DIST      = 160;               // metres — unload beyond this distance
const STATS_THROTTLE_MS    = 500;               // stats HUD refresh interval
const MAX_MESHLET_TRIS     = 128;               // triangles per Nanite-style cluster

// ─── Per-element reference inside a BatchedMesh ──────────────────────────────

interface TileElementRef {
  batch:      THREE.BatchedMesh;
  instanceId: number;
  geomId:     number;
  origColor:  THREE.Color;
}

interface LoadedTile {
  opaqueBatch:      THREE.BatchedMesh;
  transparentBatch: THREE.BatchedMesh | null;
  opaqueInstIds:       Map<number, number>;  // instanceId → expressID
  transparentInstIds:  Map<number, number>;
  expressIDMap: Map<number, TileElementRef[]>; // expressID → refs (multi sub-mesh)
  lastUsed:  number;
  sizeBytes: number;
}

// ─── Tile streaming manager ───────────────────────────────────────────────────

class TileStreamingManager {
  private loaded   = new Map<string, LoadedTile>();
  private loading  = new Set<string>();
  private cancelled = new Set<string>(); // tiles evicted while in-flight
  private totalBytes = 0;
  private scene:    THREE.Scene;
  private hash:     string = '';
  private manifest: RootManifest | null = null;
  private activeFloors = new Set<string>();
  private loader = new GLTFLoader();

  // Cross-tile expressID lookup
  private globalExpressIDMap = new Map<number, Array<{ tileId: string } & TileElementRef>>();

  // Host walls that need geometry cached for CSG opening regeneration
  private hostWalls = new Set<number>();
  private wallGeomCache = new Map<number, THREE.BufferGeometry>(); // world-space

  // Reused per-frame objects to avoid GC pressure
  private _frustum  = new THREE.Frustum();
  private _vpMatrix = new THREE.Matrix4();
  private _camPos   = new THREE.Vector3();
  private _tileBox  = new THREE.Box3();

  onEvict?: (tileId: string, expressIDs: number[]) => void;
  private cloneIdCounter = 1_000_000;

  // ── Meshlet culling state ────────────────────────────────────────────────────
  // Per-tile meshlet bounding spheres — keyed by tileId so evict() cleans up in O(1)
  private tileMeshlets  = new Map<string, Map<number, MeshletSphere[]>>();
  private meshletHidden = new Set<number>(); // elements culled by cluster frustum pass
  private userHidden    = new Set<number>(); // elements explicitly hidden by the user
  private _tempSphere   = new THREE.Sphere();

  constructor(scene: THREE.Scene) { this.scene = scene; }

  setProject(hash: string, manifest: RootManifest) {
    this.hash = hash;
    this.manifest = manifest;
    this.activeFloors.clear();
    this.globalExpressIDMap.clear();
  }

  setHostWalls(ids: Set<number>) { this.hostWalls = ids; }

  setFloorFilter(floorIds: string[]) {
    this.activeFloors = new Set(floorIds);
    for (const [id] of this.loaded) {
      const entry = this.manifest?.tiles.find(t => t.id === id);
      if (entry && this.activeFloors.size > 0 && !this.activeFloors.has(entry.floor)) {
        this.evict(id);
      }
    }
  }

  update(camera: THREE.Camera) {
    if (!this.manifest) return;
    this._vpMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._vpMatrix);
    camera.getWorldPosition(this._camPos);
    const toLoad: TileManifestEntry[] = [];

    for (const tile of this.manifest.tiles) {
      if (this.activeFloors.size > 0 && !this.activeFloors.has(tile.floor)) continue;
      this._tileBox.set(
        new THREE.Vector3(...tile.bbox.min),
        new THREE.Vector3(...tile.bbox.max),
      );
      const inFrustum = this._frustum.intersectsBox(this._tileBox);
      const dist = this._tileBox.distanceToPoint(this._camPos);
      const shouldShow = inFrustum && dist < LOD_SWITCH_DIST;

      if (shouldShow) {
        if (this.loaded.has(tile.id)) this.loaded.get(tile.id)!.lastUsed = performance.now();
        else if (!this.loading.has(tile.id)) toLoad.push(tile);
      } else if (this.loaded.has(tile.id)) {
        this.evict(tile.id);
      }
    }

    // Sort closest first
    toLoad.sort((a, b) => {
      const ba = new THREE.Box3(new THREE.Vector3(...a.bbox.min), new THREE.Vector3(...a.bbox.max));
      const bb = new THREE.Box3(new THREE.Vector3(...b.bbox.min), new THREE.Vector3(...b.bbox.max));
      return ba.distanceToPoint(this._camPos) - bb.distanceToPoint(this._camPos);
    });
    for (const tile of toLoad) {
      if (this.loading.size >= MAX_CONCURRENT_LOADS) break;
      this.loadTile(tile);
    }
    this.enforceBudget();
    this.meshletCullingPass();
  }

  private async loadTile(tile: TileManifestEntry) {
    this.loading.add(tile.id);
    try {
      const glb = await loadTileGLB(this.hash, tile.id);
      if (!glb) return;

      // Cancelled while loading (tile was evicted before GLB arrived)
      if (this.cancelled.has(tile.id)) {
        this.cancelled.delete(tile.id);
        return;
      }

      const gltf = await new Promise<THREE.Group>((resolve, reject) => {
        this.loader.parse(glb, '', g => resolve(g.scene), reject);
      });

      if (this.cancelled.has(tile.id)) {
        this.cancelled.delete(tile.id);
        return;
      }

      const opaqueMeshes: THREE.Mesh[] = [];
      const transparentMeshes: THREE.Mesh[] = [];
      gltf.traverse(child => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        if ((mesh.userData.a ?? 1.0) < 0.99) transparentMeshes.push(mesh);
        else opaqueMeshes.push(mesh);
      });

      // Cache geometry for walls that host openings
      for (const mesh of [...opaqueMeshes, ...transparentMeshes]) {
        const eid = mesh.userData.expressID as number;
        if (eid != null && this.hostWalls.has(eid) && !this.wallGeomCache.has(eid)) {
          this.wallGeomCache.set(eid, mesh.geometry.clone());
        }
      }

      const buildBatch = (meshes: THREE.Mesh[], transparent: boolean): THREE.BatchedMesh | null => {
        if (!meshes.length) return null;
        let totalVerts = 0, totalIndices = 0;
        for (const m of meshes) {
          totalVerts   += m.geometry.attributes.position.count;
          totalIndices += m.geometry.index?.count ?? 0;
        }
        const mat = transparent
          ? new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
          : new THREE.MeshLambertMaterial({ side: THREE.FrontSide });
        return new THREE.BatchedMesh(
          Math.ceil(meshes.length * 1.3),
          Math.ceil(totalVerts   * 1.3),
          Math.ceil(totalIndices * 1.3),
          mat,
        );
      };

      const opaqueBatch      = buildBatch(opaqueMeshes, false)!;
      const transparentBatch = buildBatch(transparentMeshes, true);

      const expressIDMap:       Map<number, TileElementRef[]> = new Map();
      const opaqueInstIds:      Map<number, number>           = new Map();
      const transparentInstIds: Map<number, number>           = new Map();

      const addMesh = (mesh: THREE.Mesh, batch: THREE.BatchedMesh, instMap: Map<number, number>) => {
        const geomId     = batch.addGeometry(mesh.geometry);
        const instanceId = batch.addInstance(geomId);
        const color = new THREE.Color(mesh.userData.r ?? 0.7, mesh.userData.g ?? 0.7, mesh.userData.b ?? 0.7);
        batch.setColorAt(instanceId, color);
        const expressID = mesh.userData.expressID as number;
        if (expressID != null) {
          const ref: TileElementRef = { batch, instanceId, geomId, origColor: color.clone() };
          const tileRefs = expressIDMap.get(expressID);
          if (tileRefs) tileRefs.push(ref); else expressIDMap.set(expressID, [ref]);
          instMap.set(instanceId, expressID);
          const globalRefs = this.globalExpressIDMap.get(expressID);
          if (globalRefs) globalRefs.push({ tileId: tile.id, ...ref });
          else this.globalExpressIDMap.set(expressID, [{ tileId: tile.id, ...ref }]);

          // Store meshlet bounding spheres keyed by tile so evict() removes them cleanly
          const newMeshlets = meshletizeGeometry(mesh.geometry);
          if (newMeshlets.length > 0) {
            let tileMap = this.tileMeshlets.get(tile.id);
            if (!tileMap) { tileMap = new Map(); this.tileMeshlets.set(tile.id, tileMap); }
            const prev = tileMap.get(expressID);
            tileMap.set(expressID, prev ? [...prev, ...newMeshlets] : newMeshlets);
          }
          // Sync this new instance to the current culling/user state immediately,
          // so a reloaded tile doesn't flicker visible for one frame when it should be hidden
          if (this.userHidden.has(expressID) || this.meshletHidden.has(expressID)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const b = ref.batch as any;
            if (typeof b.setVisibleAt === 'function') b.setVisibleAt(ref.instanceId, false);
          }
        }
      };

      for (const m of opaqueMeshes)      addMesh(m, opaqueBatch,      opaqueInstIds);
      if (transparentBatch) {
        for (const m of transparentMeshes) addMesh(m, transparentBatch, transparentInstIds);
      }

      this.invalidateBatchColors(opaqueBatch);
      if (transparentBatch) this.invalidateBatchColors(transparentBatch);

      opaqueBatch.castShadow    = true;
      opaqueBatch.receiveShadow = true;
      this.scene.add(opaqueBatch);
      if (transparentBatch) this.scene.add(transparentBatch);

      this.loaded.set(tile.id, {
        opaqueBatch, transparentBatch,
        opaqueInstIds, transparentInstIds, expressIDMap,
        lastUsed: performance.now(), sizeBytes: glb.byteLength,
      });
      this.totalBytes += glb.byteLength;
    } catch (err) {
      console.warn(`[TileStreamingManager] Failed to load tile ${tile.id}:`, err);
    } finally {
      this.loading.delete(tile.id);
    }
  }

  private evict(tileId: string) {
    if (this.loading.has(tileId)) this.cancelled.add(tileId);
    const tile = this.loaded.get(tileId);
    if (!tile) return;

    const evictedIDs: number[] = [];
    for (const [expressID] of tile.expressIDMap) {
      evictedIDs.push(expressID);
      const globalRefs = this.globalExpressIDMap.get(expressID);
      if (!globalRefs) continue;
      const remaining = globalRefs.filter(r => r.tileId !== tileId);
      if (remaining.length === 0) {
        this.globalExpressIDMap.delete(expressID);
        this.meshletHidden.delete(expressID);
      } else {
        this.globalExpressIDMap.set(expressID, remaining);
      }
    }
    // Drop all meshlet spheres for this tile in one call — no per-element iteration needed
    this.tileMeshlets.delete(tileId);

    this.scene.remove(tile.opaqueBatch);
    (tile.opaqueBatch.material as THREE.Material).dispose();
    tile.opaqueBatch.dispose?.();
    if (tile.transparentBatch) {
      this.scene.remove(tile.transparentBatch);
      (tile.transparentBatch.material as THREE.Material).dispose();
      tile.transparentBatch.dispose?.();
    }
    this.totalBytes -= tile.sizeBytes;
    this.loaded.delete(tileId);
    this.onEvict?.(tileId, evictedIDs);
  }

  private enforceBudget() {
    if (this.totalBytes <= TILE_BUDGET_BYTES) return;
    const sorted = [...this.loaded.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id] of sorted) {
      if (this.totalBytes <= TILE_BUDGET_BYTES) break;
      this.evict(id);
    }
  }

  getStats() {
    let instances = 0, drawCalls = 0;
    for (const { opaqueBatch, transparentBatch } of this.loaded.values()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instances += (opaqueBatch as any)._instanceInfo?.length ?? 0;
      drawCalls++;
      if (transparentBatch) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        instances += (transparentBatch as any)._instanceInfo?.length ?? 0;
        drawCalls++;
      }
    }
    return { tilesLoaded: this.loaded.size, tilesLoading: this.loading.size,
      budgetMB: Math.round(this.totalBytes / 1024 / 1024), drawCalls, instances,
      meshletsCulled: this.meshletHidden.size, meshletsTotal: this.globalExpressIDMap.size };
  }

  // ── Meshlet culling pass (per-cluster frustum visibility) ───────────────────
  // Iterates all active elements. For each, checks whether any of its cluster
  // bounding spheres intersects the view frustum. If none do, the element is
  // hidden via setVisibleAt. GPU state is updated only on state changes (delta).
  // Elements whose geometry has no index buffer (no meshlets) are skipped so
  // they remain always visible — culling only what we can safely test.

  private meshletCullingPass() {
    for (const [expressID, refs] of this.globalExpressIDMap) {
      if (this.userHidden.has(expressID)) continue;
      if (!refs.length) continue;

      // Collect meshlets across all loaded tiles for this element
      let anyVisible = false;
      let hasMeshlets = false;
      outer: for (const tileMap of this.tileMeshlets.values()) {
        const meshlets = tileMap.get(expressID);
        if (!meshlets?.length) continue;
        hasMeshlets = true;
        for (const m of meshlets) {
          this._tempSphere.center.set(m.cx, m.cy, m.cz);
          this._tempSphere.radius = m.radius;
          if (this._frustum.intersectsSphere(this._tempSphere)) {
            anyVisible = true;
            break outer;
          }
        }
      }
      // No indexed geometry → skip culling for this element
      if (!hasMeshlets) continue;

      const wasHidden = this.meshletHidden.has(expressID);
      if (anyVisible === wasHidden) {
        if (anyVisible) this.meshletHidden.delete(expressID);
        else            this.meshletHidden.add(expressID);
        for (const ref of refs) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const b = ref.batch as any;
          if (typeof b.setVisibleAt === 'function') b.setVisibleAt(ref.instanceId, anyVisible);
        }
      }
    }
  }

  // ── Picking ──────────────────────────────────────────────────────────────────

  pickElement(raycaster: THREE.Raycaster): { expressID: number; tileId: string } | null {
    let closest: THREE.Intersection | null = null;
    let closestTile = '';
    let closestBatch: THREE.BatchedMesh | null = null;

    for (const [tileId, tile] of this.loaded) {
      for (const batch of [tile.opaqueBatch, tile.transparentBatch]) {
        if (!batch) continue;
        const hits = raycaster.intersectObject(batch, false);
        if (hits.length > 0 && (closest == null || hits[0].distance < closest.distance)) {
          closest = hits[0]; closestTile = tileId; closestBatch = batch;
        }
      }
    }
    if (!closest || !closestBatch || closest.batchId == null) return null;
    const tile = this.loaded.get(closestTile)!;
    const instIds = closestBatch === tile.opaqueBatch ? tile.opaqueInstIds : tile.transparentInstIds;
    const expressID = instIds.get(closest.batchId as number);
    if (expressID == null) return null;
    return { expressID, tileId: closestTile };
  }

  // ── Editor API ───────────────────────────────────────────────────────────────

  setHighlight(expressID: number | null, prevExpressID: number | null) {
    if (prevExpressID != null) {
      for (const ref of this.globalExpressIDMap.get(prevExpressID) ?? []) {
        ref.batch.setColorAt(ref.instanceId, ref.origColor);
        this.invalidateBatchColors(ref.batch);
      }
    }
    if (expressID != null) {
      for (const ref of this.globalExpressIDMap.get(expressID) ?? []) {
        ref.batch.setColorAt(ref.instanceId, HIGHLIGHT_COLOR);
        this.invalidateBatchColors(ref.batch);
      }
    }
  }

  setVisible(expressID: number, visible: boolean) {
    if (visible) {
      this.userHidden.delete(expressID);
      this.meshletHidden.delete(expressID); // let culling pass re-evaluate next frame
    } else {
      this.userHidden.add(expressID);
      this.meshletHidden.delete(expressID);
    }
    for (const ref of this.globalExpressIDMap.get(expressID) ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = ref.batch as any;
      if (typeof b.setVisibleAt === 'function') b.setVisibleAt(ref.instanceId, visible);
      else ref.batch.setColorAt(ref.instanceId, visible ? ref.origColor : new THREE.Color(0, 0, 0));
      this.invalidateBatchColors(ref.batch);
    }
  }

  /** Apply a delta (relative) transform to all sub-meshes of an element. */
  applyDeltaTransform(expressID: number, delta: THREE.Matrix4) {
    for (const ref of this.globalExpressIDMap.get(expressID) ?? []) {
      const mat = new THREE.Matrix4();
      ref.batch.getMatrixAt(ref.instanceId, mat);
      mat.premultiply(delta);
      ref.batch.setMatrixAt(ref.instanceId, mat);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = ref.batch as any;
      if (b._matricesTexture) b._matricesTexture.needsUpdate = true;
      if (b.instanceMatrix)   b.instanceMatrix.needsUpdate   = true;
    }
  }

  getMatrix(expressID: number): THREE.Matrix4 | null {
    const refs = this.globalExpressIDMap.get(expressID);
    if (!refs?.length) return null;
    const mat = new THREE.Matrix4();
    refs[0].batch.getMatrixAt(refs[0].instanceId, mat);
    return mat;
  }

  /** World-space position of an element (translation from instance matrix). */
  getWorldPosition(expressID: number): THREE.Vector3 | null {
    const refs = this.globalExpressIDMap.get(expressID);
    if (!refs?.length) return null;
    const mat = new THREE.Matrix4();
    refs[0].batch.getMatrixAt(refs[0].instanceId, mat);
    return new THREE.Vector3().setFromMatrixPosition(mat);
  }

  /** Delete all sub-meshes of an element (instance first, then geometry). */
  deleteElement(expressID: number) {
    const refs = this.globalExpressIDMap.get(expressID) ?? [];
    for (const ref of refs) ref.batch.deleteInstance(ref.instanceId);
    for (const ref of refs) {
      try { ref.batch.deleteGeometry(ref.geomId); } catch { /* ok */ }
    }
    this.globalExpressIDMap.delete(expressID);
    for (const tile of this.loaded.values()) {
      if (tile.expressIDMap.has(expressID)) {
        for (const ref of refs) {
          tile.opaqueInstIds.delete(ref.instanceId);
          tile.transparentInstIds.delete(ref.instanceId);
        }
        tile.expressIDMap.delete(expressID);
        break;
      }
    }
  }

  /**
   * Clone an element by adding a new instance of the same geometry with newMatrix.
   * Returns a virtual expressID (>= 1_000_000) for the new clone, or null if the
   * source element is not currently loaded.
   */
  cloneElement(expressID: number, newMatrix: THREE.Matrix4): number | null {
    const refs = this.globalExpressIDMap.get(expressID);
    if (!refs?.length) return null;

    const newID = this.cloneIdCounter++;
    const newGlobalRefs: Array<{ tileId: string } & TileElementRef> = [];

    for (const ref of refs) {
      const newInstanceId = ref.batch.addInstance(ref.geomId);
      ref.batch.setMatrixAt(newInstanceId, newMatrix);
      ref.batch.setColorAt(newInstanceId, ref.origColor.clone());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = ref.batch as any;
      if (b._matricesTexture) b._matricesTexture.needsUpdate = true;
      if (b.instanceMatrix)   b.instanceMatrix.needsUpdate   = true;
      this.invalidateBatchColors(ref.batch);

      const newRef: TileElementRef = {
        batch: ref.batch, instanceId: newInstanceId,
        geomId: ref.geomId, origColor: ref.origColor.clone(),
      };

      // Register in the tile that owns the source element
      for (const tile of this.loaded.values()) {
        if (tile.expressIDMap.has(expressID)) {
          const tileRefs = tile.expressIDMap.get(newID);
          if (tileRefs) tileRefs.push(newRef); else tile.expressIDMap.set(newID, [newRef]);
          if (ref.batch === tile.opaqueBatch)           tile.opaqueInstIds.set(newInstanceId, newID);
          else if (ref.batch === tile.transparentBatch) tile.transparentInstIds.set(newInstanceId, newID);
          break;
        }
      }
      newGlobalRefs.push({ tileId: ref.tileId, ...newRef });
    }

    this.globalExpressIDMap.set(newID, newGlobalRefs);
    return newID;
  }

  // ── Wall geometry cache (for CSG opening regeneration) ───────────────────────

  getWallGeom(expressID: number): THREE.BufferGeometry | null {
    return this.wallGeomCache.get(expressID) ?? null;
  }

  setWallGeom(expressID: number, geom: THREE.BufferGeometry) {
    this.wallGeomCache.set(expressID, geom);
  }

  /**
   * Eject a wall element from its BatchedMesh into standalone data.
   * Returns the current world-space geometry (original + any instance transform applied)
   * and the material color. The element is removed from the batch.
   */
  ejectFromBatch(expressID: number): { geom: THREE.BufferGeometry; color: THREE.Color } | null {
    const refs = this.globalExpressIDMap.get(expressID);
    if (!refs?.length) return null;
    const originalGeom = this.wallGeomCache.get(expressID);
    if (!originalGeom) return null;

    const instanceMat = new THREE.Matrix4();
    refs[0].batch.getMatrixAt(refs[0].instanceId, instanceMat);

    // Apply instance transform to get current world-space geometry
    const currentGeom = originalGeom.clone();
    if (!instanceMat.equals(new THREE.Matrix4())) {
      currentGeom.applyMatrix4(instanceMat);
    }

    const color = new THREE.Color();
    refs[0].batch.getColorAt(refs[0].instanceId, color);

    for (const ref of refs) ref.batch.deleteInstance(ref.instanceId);
    for (const ref of refs) {
      try { ref.batch.deleteGeometry(ref.geomId); } catch { /* ok */ }
    }
    this.globalExpressIDMap.delete(expressID);

    return { geom: currentGeom, color };
  }

  private invalidateBatchColors(batch: THREE.BatchedMesh) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = batch as any;
    if (b.instanceColor)  b.instanceColor.needsUpdate  = true;
    if (b._colorTexture)  b._colorTexture.needsUpdate  = true;
  }

  dispose() {
    for (const id of [...this.loaded.keys()]) this.evict(id);
    for (const geom of this.wallGeomCache.values()) geom.dispose();
    this.wallGeomCache.clear();
  }

  /** World-space position of every currently-loaded element. Used by polygon zone capture. */
  /** Returns all currently-loaded BatchedMesh objects (for vertex capture). */
  getLoadedBatches(): THREE.BatchedMesh[] {
    const out: THREE.BatchedMesh[] = [];
    for (const tile of this.loaded.values()) {
      out.push(tile.opaqueBatch);
      if (tile.transparentBatch) out.push(tile.transparentBatch);
    }
    return out;
  }

  getAllElementPositions(): Map<number, THREE.Vector3> {
    const result = new Map<number, THREE.Vector3>();
    const bbox   = new THREE.Box3();
    const mat    = new THREE.Matrix4();
    for (const [expressID, refs] of this.globalExpressIDMap) {
      if (!refs.length) continue;
      const ref = refs[0];
      // Geometry is baked in world-space; bbox center gives world position.
      // Apply instance matrix on top so already-moved elements report correctly.
      if (ref.batch.getBoundingBoxAt(ref.geomId, bbox) !== null) {
        const center = bbox.getCenter(new THREE.Vector3());
        ref.batch.getMatrixAt(ref.instanceId, mat);
        center.applyMatrix4(mat);
        result.set(expressID, center);
      }
    }
    return result;
  }
}

const HIGHLIGHT_COLOR = new THREE.Color(0.95, 0.55, 0.1);
const ZONE_COLOR      = new THREE.Color(0x00ccff);

interface GroupDef { id: string; name: string; expressIDs: number[]; }

/** Per-batch set of vertex indices owned by a rig zone (for vertex-level deformation). */
interface ZoneVertexBatch {
  batch:   THREE.BatchedMesh;
  indices: Uint32Array;   // indices into batch.geometry.attributes.position
}

/** An arbitrary-polygon rig zone — deforms vertices in-place rather than moving whole elements. */
interface RigZone {
  id:                 string;
  label:              string;
  polygon:            [number, number][];  // XZ world coords (metres), drifts with zone
  elevMin:            number;
  elevMax:            number;
  ownedExpressIDs:    number[];            // for highlighting only
  ownedVertexBatches: ZoneVertexBatch[];   // actual deformation target
  wireframe:          THREE.LineSegments;
  fillMesh:           THREE.Mesh;
  dx:                 number;
  dz:                 number;
}

// ─── Polygon-zone helpers ─────────────────────────────────────────────────────

function ptInPolyXZ(x: number, z: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)
      inside = !inside;
  }
  return inside;
}

function buildZoneWireframe(polygon: [number, number][], yMin: number, yMax: number): THREE.LineSegments {
  const pts: number[] = [];
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // bottom edge, top edge, vertical edge
    pts.push(polygon[i][0], yMin, polygon[i][1], polygon[j][0], yMin, polygon[j][1]);
    pts.push(polygon[i][0], yMax, polygon[i][1], polygon[j][0], yMax, polygon[j][1]);
    pts.push(polygon[i][0], yMin, polygon[i][1], polygon[i][0], yMax, polygon[i][1]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color: ZONE_COLOR, transparent: true, opacity: 0.65, depthTest: false });
  const ls  = new THREE.LineSegments(geo, mat);
  ls.renderOrder = 998;
  return ls;
}

function buildZoneFillMesh(polygon: [number, number][], yBase: number): THREE.Mesh {
  const shape = new THREE.Shape(polygon.map(([x, z]) => new THREE.Vector2(x, z)));
  const geo = new THREE.ShapeGeometry(shape);
  // ShapeGeometry is in XY plane; rotate 90° around X to lay it on XZ plane
  geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  geo.translate(0, yBase + 0.02, 0);
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false });
  return new THREE.Mesh(geo, mat);
}

function raycastToXZPlane(
  clientX: number, clientY: number,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  elevY = 0,
): THREE.Vector3 | null {
  const rect = canvas.getBoundingClientRect();
  const mx = ((clientX - rect.left) / rect.width)  *  2 - 1;
  const my = -((clientY - rect.top)  / rect.height) * 2 + 1;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(mx, my), camera);
  const plane  = new THREE.Plane(new THREE.Vector3(0, 1, 0), -elevY);
  const target = new THREE.Vector3();
  return ray.ray.intersectPlane(plane, target) ? target : null;
}

// ─── Build a GLB buffer from raw tile geometry (main thread) ─────────────────

async function buildTileGLB(tile: Pick<WorkerTileDataMsg, 'elements' | 'instancedGroups'>): Promise<ArrayBuffer> {
  const scene = new THREE.Scene();

  for (const el of tile.elements) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(el.positions, 3));
    geom.setAttribute('normal',   new THREE.BufferAttribute(el.normals, 3));
    geom.setIndex(new THREE.BufferAttribute(el.indices, 1));
    const mat  = new THREE.MeshLambertMaterial({ color: new THREE.Color(el.r, el.g, el.b) });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData = { expressID: el.expressID, category: el.category, name: el.name,
                      r: el.r, g: el.g, b: el.b, a: el.a };
    scene.add(mesh);
  }

  for (const group of tile.instancedGroups) {
    for (const inst of group.instances) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(group.positions), 3));
      geom.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(group.normals), 3));
      geom.setIndex(new THREE.BufferAttribute(new Uint32Array(group.indices), 1));
      geom.applyMatrix4(new THREE.Matrix4().fromArray(inst.matrix));
      const mat  = new THREE.MeshLambertMaterial({ color: new THREE.Color(inst.r, inst.g, inst.b) });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData = { expressID: inst.expressID, category: inst.category, name: inst.name,
                        r: inst.r, g: inst.g, b: inst.b, a: inst.a };
      scene.add(mesh);
    }
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    new GLTFExporter().parse(scene, result => resolve(result as ArrayBuffer), reject, {
      binary: true, embedImages: false,
    });
  });
}

// ─── Meshlet decomposition ────────────────────────────────────────────────────
// Splits indexed element geometry into clusters of MAX_MESHLET_TRIS triangles.
// Each cluster gets a tight bounding sphere used for per-cluster frustum culling.
// Only the sphere is stored — normal-cone backface culling was removed because
// IFC geometry is viewed from inside buildings where tight-cone walls trigger
// false positives and leave elements stuck hidden.

interface MeshletSphere {
  cx: number; cy: number; cz: number; radius: number;
}

function meshletizeGeometry(geom: THREE.BufferGeometry): MeshletSphere[] {
  const idxAttr = geom.index;
  if (!idxAttr) return [];
  const indices = idxAttr.array as Uint32Array | Uint16Array;
  const pos     = geom.attributes.position?.array as Float32Array | undefined;
  if (!pos) return [];

  const triCount = Math.floor(indices.length / 3);
  const result: MeshletSphere[] = [];

  for (let t = 0; t < triCount; t += MAX_MESHLET_TRIS) {
    const tEnd = Math.min(t + MAX_MESHLET_TRIS, triCount);

    // Bounding sphere: centroid of all vertices in cluster + max radius from centroid
    let sx = 0, sy = 0, sz = 0, vCnt = 0;
    for (let ti = t; ti < tEnd; ti++) {
      for (let v = 0; v < 3; v++) {
        const vi = indices[ti * 3 + v] * 3;
        sx += pos[vi]; sy += pos[vi + 1]; sz += pos[vi + 2];
        vCnt++;
      }
    }
    const cx = sx / vCnt, cy = sy / vCnt, cz = sz / vCnt;
    let rSq = 0;
    for (let ti = t; ti < tEnd; ti++) {
      for (let v = 0; v < 3; v++) {
        const vi = indices[ti * 3 + v] * 3;
        const dx = pos[vi] - cx, dy = pos[vi + 1] - cy, dz = pos[vi + 2] - cz;
        rSq = Math.max(rSq, dx * dx + dy * dy + dz * dz);
      }
    }
    result.push({ cx, cy, cz, radius: Math.sqrt(rSq) });
  }

  return result;
}

// ─── Component ────────────────────────────────────────────────────────────────

type ViewerPhase =
  | 'idle' | 'hashing' | 'checking' | 'processing' | 'building' | 'streaming' | 'error';

type GizmoMode = 'translate' | 'rotate';

export interface IFCTilesViewerProps {
  className?: string;
  tabId?: string;
}

export function IFCTilesViewer({ className }: IFCTilesViewerProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const rendererRef  = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef     = useRef<THREE.Scene | null>(null);
  const cameraRef      = useRef<THREE.Camera | null>(null);
  const perspCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const orthoCameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const isOrthoRef     = useRef(false);
  const [isOrtho, setIsOrtho] = useState(false);
  const switchCameraRef = useRef<() => void>(() => {});
  const controlsRef  = useRef<OrbitControls | null>(null);
  const streamingRef = useRef<TileStreamingManager | null>(null);
  const rafRef       = useRef(0);
  const workerRef    = useRef<Worker | null>(null);
  const gridRef      = useRef<THREE.GridHelper | null>(null);
  const hemiRef      = useRef<THREE.HemisphereLight | null>(null);
  const importedGroupsRef = useRef<THREE.Group[]>([]);
  const pendingTilesRef   = useRef<WorkerTileDataMsg[]>([]);

  // Selection — selectionRef is the source of truth; selectedExpressIDRef mirrors single-select
  const selectedExpressIDRef = useRef<number | null>(null);
  const selectionRef         = useRef<Set<number>>(new Set());

  // Groups
  const [groups, setGroups]                 = useState<GroupDef[]>([]);
  const [selectedElements, setSelectedElements] = useState<ElementMeta[]>([]);

  // Array transform
  const [arrayParams, setArrayParams] = useState<{ axis: 'x'|'y'|'z'; distance: number; count: number }>({ axis: 'x', distance: 3, count: 3 });
  const [showArrayPanel, setShowArrayPanel] = useState(false);

  // Transform gizmo
  const gizmoRef             = useRef<TransformControls | null>(null);
  const gizmoProxyRef        = useRef<THREE.Object3D | null>(null);
  const gizmoPrevMatrixRef   = useRef<THREE.Matrix4>(new THREE.Matrix4());
  const gizmoOriginalMatRef  = useRef<THREE.Matrix4>(new THREE.Matrix4());

  // Opening regeneration
  const standaloneWallsRef = useRef<Map<number, THREE.Mesh>>(new Map());
  const csgEvaluatorRef    = useRef<Evaluator | null>(null);

  // Metadata ref (always in sync with state, accessible in callbacks)
  const metadataRef = useRef<ElementMetaMap>({});

  // Stats throttle
  const lastStatsUpdateRef = useRef(0);

  // Stable ref to updateGizmoProxy (avoids forward-declaration TS error in startStreaming)
  const updateGizmoProxyRef = useRef<(sel: Set<number>) => void>(() => {});

  // Grid size (settable before import)
  const [gridSizeM, setGridSizeM]   = useState(20);
  const gridSizeMRef                = useRef(20);

  const [phase, setPhase]             = useState<ViewerPhase>('idle');
  const [progress, setProgress]       = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [manifest, setManifest]       = useState<RootManifest | null>(null);
  const [metadata, setMetadata]       = useState<ElementMetaMap>({});
  const [cachedProjects, setCachedProjects] = useState<CachedProjectInfo[]>([]);
  const [selectedEl, setSelectedEl]   = useState<ElementMeta | null>(null);
  const [activeFloors, setActiveFloors] = useState<Set<string>>(new Set());
  const [stats, setStats]             = useState({ tilesLoaded: 0, tilesLoading: 0, budgetMB: 0, drawCalls: 0, instances: 0, meshletsCulled: 0, meshletsTotal: 0 });
  const [errorMsg, setErrorMsg]       = useState('');
  const [isDragging, setIsDragging]   = useState(false);
  const [buildingTile, setBuildingTile] = useState('');
  const [bgLight, setBgLight]         = useState(false);
  const [gizmoMode, setGizmoMode]     = useState<GizmoMode>('translate');
  const [regenStatus, setRegenStatus] = useState<'idle' | 'computing' | 'done' | 'error'>('idle');

  // Keep metadataRef in sync
  useEffect(() => { metadataRef.current = metadata; }, [metadata]);

  // ── Polygon drawing ───────────────────────────────────────────────────
  const isDrawingPolygonRef = useRef(false);
  const [isDrawingPolygon, setIsDrawingPolygon] = useState(false);
  const drawingPtsRef  = useRef<Array<[number, number]>>([]);
  const drawPreviewRef = useRef<THREE.Line | null>(null);

  // ── Rig zones ─────────────────────────────────────────────────────────
  const rigZonesRef       = useRef<Map<string, RigZone>>(new Map());
  const [rigZoneList, setRigZoneList] = useState<Array<{ id: string; label: string; count: number }>>([]);
  const selectedZoneIdRef = useRef<string | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const zoneGizmoPrevMatRef = useRef(new THREE.Matrix4());

  // Stable refs for callbacks needed before their useCallback definitions
  const finalizePolygonRef = useRef<() => void>(() => {});
  const selectZoneRef      = useRef<(id: string) => void>(() => {});
  const deselectZoneRef    = useRef<() => void>(() => {});

  // ── Init Three.js scene ───────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1f2a);
    scene.fog = new THREE.Fog(0x1a1f2a, 100, 500);
    sceneRef.current = scene;

    const hemi = new THREE.HemisphereLight(0xddeeff, 0x303535, 0.8);
    scene.add(hemi);
    hemiRef.current = hemi;
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(30, 60, 20);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 0.5;
    dir.shadow.camera.far  = 300;
    scene.add(dir);

    const grid = new THREE.GridHelper(200, 40, 0x303540, 0x222830);
    scene.add(grid);
    gridRef.current = grid;

    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;
    const camera = new THREE.PerspectiveCamera(50, w / Math.max(h, 1), 0.1, 2000);
    camera.position.set(30, 25, 40);
    camera.lookAt(0, 0, 0);
    perspCameraRef.current = camera;

    const aspect = w / Math.max(h, 1);
    const orthoCamera = new THREE.OrthographicCamera(-50 * aspect, 50 * aspect, 50, -50, -1000, 2000);
    orthoCamera.position.copy(camera.position);
    orthoCamera.lookAt(0, 0, 0);
    orthoCameraRef.current = orthoCamera;

    cameraRef.current = camera;  // perspective is default

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.minDistance   = 0.5;
    controls.maxDistance   = 800;
    controlsRef.current = controls;

    const streaming = new TileStreamingManager(scene);
    streamingRef.current = streaming;

    // ── TransformControls ──────────────────────────────────────────────
    const gizmo = new TransformControls(camera, canvas);
    gizmo.setSize(0.85);
    const gizmoHelper = gizmo.getHelper();   // TransformControlsRoot extends Object3D
    scene.add(gizmoHelper);
    gizmoRef.current = gizmo;

    // Proxy object — receives the gizmo, mirrors transforms to BatchedMesh instances
    const proxy = new THREE.Object3D();
    scene.add(proxy);
    gizmoProxyRef.current = proxy;

    // Disable orbit while dragging
    gizmo.addEventListener('dragging-changed', (event: THREE.Event) => {
      if (controlsRef.current) controlsRef.current.enabled = !(event as unknown as { value: boolean }).value;
    });

    // Live delta: move all selected elements (or a rig zone) continuously during drag
    gizmo.addEventListener('objectChange', () => {
      const currMat = new THREE.Matrix4();
      currMat.compose(proxy.position, proxy.quaternion, proxy.scale);
      const delta = currMat.clone().multiply(gizmoPrevMatrixRef.current.clone().invert());

      // Zone mode — vertex-level deformation of all captured vertices
      const zoneId = selectedZoneIdRef.current;
      if (zoneId) {
        const zone = rigZonesRef.current.get(zoneId);
        if (zone) {
          const dx = delta.elements[12];
          const dy = delta.elements[13];
          const dz = delta.elements[14];

          // Move every vertex owned by this zone directly in the geometry buffer
          for (const { batch, indices } of zone.ownedVertexBatches) {
            if (!batch.parent) continue;   // tile was evicted
            const posAttr = batch.geometry.attributes.position as THREE.BufferAttribute;
            const arr = posAttr.array as Float32Array;
            for (let j = 0; j < indices.length; j++) {
              const vi = indices[j] * 3;
              arr[vi]     += dx;
              arr[vi + 1] += dy;
              arr[vi + 2] += dz;
            }
            posAttr.needsUpdate = true;
            // Invalidate per-geometry bbox caches so getAllElementPositions stays correct
            const gInfos = (batch as any)._geometryInfo as Array<{ boundingBox: unknown } | null> | undefined;
            if (gInfos) for (const gi of gInfos) { if (gi) gi.boundingBox = null; }
          }

          zone.wireframe.applyMatrix4(delta);
          zone.fillMesh.applyMatrix4(delta);
          zone.dx += dx; zone.dz += dz;
          zone.polygon = zone.polygon.map(([x, z]) => [x + dx, z + dz] as [number, number]);
        }
        gizmoPrevMatrixRef.current.copy(currMat);
        return;
      }

      // Element selection mode
      if (selectionRef.current.size === 0) return;
      for (const id of selectionRef.current) {
        streamingRef.current?.applyDeltaTransform(id, delta);
        const standalone = standaloneWallsRef.current.get(id);
        if (standalone) standalone.matrix.premultiply(delta);
      }

      gizmoPrevMatrixRef.current.copy(currMat);
    });

    // On drag end: run opening regeneration for any windows/doors in selection
    gizmo.addEventListener('mouseUp', () => {
      // Zone mode — no opening regen needed
      if (selectedZoneIdRef.current) return;
      if (selectionRef.current.size === 0) return;

      const finalMat = new THREE.Matrix4();
      finalMat.compose(proxy.position, proxy.quaternion, proxy.scale);
      const moveDelta = finalMat.clone().multiply(gizmoOriginalMatRef.current.clone().invert());

      for (const expressID of selectionRef.current) {
        const meta = metadataRef.current[expressID];
        if (!meta?.openingInfo) continue;
        if (meta.category !== 'window' && meta.category !== 'door') continue;

        applyOpeningRegen(expressID, meta.openingInfo, moveDelta, meta.tileId);

        const ob = meta.openingInfo.openingBboxWorld;
        const newMin = new THREE.Vector3(...ob.min).applyMatrix4(moveDelta);
        const newMax = new THREE.Vector3(...ob.max).applyMatrix4(moveDelta);
        meta.openingInfo.openingBboxWorld = {
          min: [newMin.x, newMin.y, newMin.z],
          max: [newMax.x, newMax.y, newMax.z],
        };
      }
      gizmoOriginalMatRef.current.copy(finalMat);
    });

    // ── CSG Evaluator (reused across operations) ───────────────────────
    csgEvaluatorRef.current = new Evaluator();
    csgEvaluatorRef.current.useGroups = false;

    // ── Render loop ────────────────────────────────────────────────────
    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      controls.update();
      const activeCam = cameraRef.current;
      if (activeCam) {
        streaming.update(activeCam);
        const now = performance.now();
        if (now - lastStatsUpdateRef.current > STATS_THROTTLE_MS) {
          setStats(streaming.getStats());
          lastStatsUpdateRef.current = now;
        }
        renderer.render(scene, activeCam);
      }
    };
    animate();

    // ── Resize ────────────────────────────────────────────────────────
    const onResize = () => {
      const w2 = canvas.clientWidth, h2 = canvas.clientHeight;
      const aspect2 = w2 / Math.max(h2, 1);
      camera.aspect = aspect2;
      camera.updateProjectionMatrix();
      // Keep ortho frustum in sync with canvas aspect
      const oc = orthoCameraRef.current;
      if (oc && oc.top !== oc.bottom) {
        const halfH = (oc.top - oc.bottom) / 2;
        oc.left  = -halfH * aspect2;
        oc.right =  halfH * aspect2;
        oc.updateProjectionMatrix();
      }
      renderer.setSize(w2, h2);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);

    // ── Keyboard shortcuts ────────────────────────────────────────────
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      // O — toggle ortho/perspective camera
      if ((e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.metaKey) {
        switchCameraRef.current();
        return;
      }

      // P — toggle polygon drawing mode
      if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey) {
        if (!isDrawingPolygonRef.current) {
          isDrawingPolygonRef.current = true;
          setIsDrawingPolygon(true);
          if (controlsRef.current) controlsRef.current.enabled = false;
          drawingPtsRef.current = [];
        } else {
          // Cancel drawing
          isDrawingPolygonRef.current = false;
          setIsDrawingPolygon(false);
          if (controlsRef.current) controlsRef.current.enabled = true;
          drawingPtsRef.current = [];
          const sc = sceneRef.current;
          if (drawPreviewRef.current && sc) { sc.remove(drawPreviewRef.current); drawPreviewRef.current.geometry.dispose(); drawPreviewRef.current = null; }
        }
        return;
      }

      if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey) {
        gizmoRef.current?.setMode('translate'); setGizmoMode('translate');
      }
      if (e.key === 'r' || e.key === 'R') { gizmoRef.current?.setMode('rotate'); setGizmoMode('rotate'); }

      if (e.key === 'Escape') {
        // Cancel polygon drawing
        if (isDrawingPolygonRef.current) {
          isDrawingPolygonRef.current = false;
          setIsDrawingPolygon(false);
          if (controlsRef.current) controlsRef.current.enabled = true;
          drawingPtsRef.current = [];
          const sc = sceneRef.current;
          if (drawPreviewRef.current && sc) { sc.remove(drawPreviewRef.current); drawPreviewRef.current.geometry.dispose(); drawPreviewRef.current = null; }
          return;
        }
        // Deselect zone
        deselectZoneRef.current();
        gizmoRef.current?.detach();
        for (const id of selectionRef.current) streamingRef.current?.setHighlight(null, id);
        selectionRef.current.clear();
        selectedExpressIDRef.current = null;
        setSelectedEl(null);
        setSelectedElements([]);
      }

      // Delete / Backspace — delete all selected elements
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const streaming = streamingRef.current;
        const scene     = sceneRef.current;
        gizmoRef.current?.detach();
        for (const id of selectionRef.current) {
          streaming?.deleteElement(id);
          const standalone = standaloneWallsRef.current.get(id);
          if (standalone && scene) {
            scene.remove(standalone);
            standalone.geometry.dispose();
            (standalone.material as THREE.Material).dispose();
            standaloneWallsRef.current.delete(id);
          }
        }
        selectionRef.current.clear();
        selectedExpressIDRef.current = null;
        setSelectedEl(null);
        setSelectedElements([]);
      }

      // Ctrl/Cmd + G — create group from current selection
      if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        const ids = [...selectionRef.current];
        if (ids.length > 1) {
          setGroups(prev => [...prev, {
            id: `group_${Date.now()}`,
            name: `Group ${prev.length + 1}`,
            expressIDs: ids,
          }]);
        }
      }
    };
    window.addEventListener('keydown', onKey);

    // ── Polygon drawing — mouse events ────────────────────────────────
    const onMouseMove = (e: MouseEvent) => {
      if (!isDrawingPolygonRef.current) return;
      const cam2 = cameraRef.current;
      const sc2  = sceneRef.current;
      if (!cam2 || !sc2) return;
      const pt = raycastToXZPlane(e.clientX, e.clientY, cam2, canvas, 0.05);
      if (!pt) return;
      const pts = drawingPtsRef.current;
      const y = 0.05;
      // Full polygon preview: all confirmed pts + cursor + close back to first
      const previewPts: THREE.Vector3[] = pts.map(([x, z]) => new THREE.Vector3(x, y, z));
      previewPts.push(new THREE.Vector3(pt.x, y, pt.z));
      if (pts.length > 0) previewPts.push(new THREE.Vector3(pts[0][0], y, pts[0][1]));
      if (previewPts.length < 2) return;   // need ≥2 points to render a visible line
      if (!drawPreviewRef.current) {
        const geo = new THREE.BufferGeometry().setFromPoints(previewPts);
        const mat = new THREE.LineBasicMaterial({ color: 0xffff44, depthTest: false, opacity: 0.9, transparent: true });
        drawPreviewRef.current = new THREE.Line(geo, mat);
        drawPreviewRef.current.renderOrder = 999;
        sc2.add(drawPreviewRef.current);
      } else {
        (drawPreviewRef.current.geometry as THREE.BufferGeometry).setFromPoints(previewPts);
      }
    };

    const onDblClick = (e: MouseEvent) => {
      if (!isDrawingPolygonRef.current) return;
      if (drawingPtsRef.current.length >= 3) {
        e.stopPropagation();
        finalizePolygonRef.current();
      }
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('dblclick',  onDblClick);

    return () => {
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('dblclick',  onDblClick);
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      scene.remove(gizmoHelper);
      gizmo.dispose();
      streaming.dispose();
      controls.dispose();
      for (const grp of importedGroupsRef.current) {
        grp.traverse(child => {
          const m = child as THREE.Mesh;
          if (m.isMesh) {
            m.geometry?.dispose();
            if (Array.isArray(m.material)) m.material.forEach(mt => mt.dispose());
            else (m.material as THREE.Material)?.dispose();
          }
        });
      }
      for (const mesh of standaloneWallsRef.current.values()) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      // Dispose rig zones
      for (const zone of rigZonesRef.current.values()) {
        zone.wireframe.geometry.dispose();
        (zone.wireframe.material as THREE.Material).dispose();
        zone.fillMesh.geometry.dispose();
        (zone.fillMesh.material as THREE.Material).dispose();
      }
      rigZonesRef.current.clear();
      if (drawPreviewRef.current) { drawPreviewRef.current.geometry.dispose(); drawPreviewRef.current = null; }
      importedGroupsRef.current = [];
      renderer.dispose();
      rendererRef.current = null; sceneRef.current = null; streamingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sync gizmo mode to TransformControls ────────────────────────────
  useEffect(() => {
    gizmoRef.current?.setMode(gizmoMode);
  }, [gizmoMode]);

  // ── Background mode ──────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const bgColor = bgLight ? 0xf0f2f5 : 0x1a1f2a;
    scene.background = new THREE.Color(bgColor);
    if (scene.fog instanceof THREE.Fog) scene.fog.color.set(bgColor);
    if (gridRef.current) { scene.remove(gridRef.current); gridRef.current.dispose(); }
    const newGrid = new THREE.GridHelper(200, 40,
      bgLight ? 0xa0a0a0 : 0x303540,
      bgLight ? 0xcccccc : 0x222830,
    );
    scene.add(newGrid);
    gridRef.current = newGrid;
    if (hemiRef.current) {
      hemiRef.current.color.set(bgLight ? 0xffffff : 0xddeeff);
      hemiRef.current.groundColor.set(bgLight ? 0xaaaaaa : 0x303535);
      hemiRef.current.intensity = bgLight ? 1.4 : 0.8;
    }
  }, [bgLight]);

  // ── Cached project list ──────────────────────────────────────────────
  useEffect(() => {
    listCachedProjects().then(setCachedProjects).catch(() => {});
  }, [phase]);

  // ── Floor filter ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!streamingRef.current || !manifest) return;
    streamingRef.current.setFloorFilter(activeFloors.size === 0 ? [] : [...activeFloors]);
  }, [activeFloors, manifest]);

  // ── Start streaming ───────────────────────────────────────────────────
  const startStreaming = useCallback((hash: string, man: RootManifest, meta: ElementMetaMap) => {
    setManifest(man);
    setMetadata(meta);
    metadataRef.current = meta;

    if (streamingRef.current) {
      streamingRef.current.setProject(hash, man);

      // Build the set of host-wall expressIDs so geometry gets cached on load
      const hostWalls = new Set<number>();
      for (const elMeta of Object.values(meta)) {
        if (elMeta.openingInfo?.hostWallExpressID != null) {
          hostWalls.add(elMeta.openingInfo.hostWallExpressID);
        }
      }
      streamingRef.current.setHostWalls(hostWalls);

      // Remove evicted elements from selection; detach gizmo if selection becomes empty
      streamingRef.current.onEvict = (_tileId, evictedIDs) => {
        const evictedSet = new Set(evictedIDs);
        let changed = false;
        for (const id of evictedSet) {
          if (selectionRef.current.has(id)) { selectionRef.current.delete(id); changed = true; }
        }
        if (changed) {
          selectedExpressIDRef.current = selectionRef.current.size === 1 ? [...selectionRef.current][0] : null;
          if (selectionRef.current.size === 0) {
            gizmoRef.current?.detach();
            setSelectedEl(null);
            setSelectedElements([]);
          } else {
            const els = [...selectionRef.current].map(id =>
              metadataRef.current[id] ?? { expressID: id, category: 'unknown', name: '', type: '', tileId: '' }
            );
            setSelectedEl(els.length === 1 ? els[0] : null);
            setSelectedElements(els);
            updateGizmoProxyRef.current(selectionRef.current);
          }
        }
      };
    }

    // Frame camera to model bounds
    const bounds = man.bounds;
    if (cameraRef.current && controlsRef.current) {
      const cx = (bounds.min[0] + bounds.max[0]) / 2;
      const cy = (bounds.min[1] + bounds.max[1]) / 2;
      const cz = (bounds.min[2] + bounds.max[2]) / 2;
      const size = Math.max(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      );
      cameraRef.current.position.set(cx + size * 0.8, cy + size * 0.5, cz + size * 0.8);
      controlsRef.current.target.set(cx, cy, cz);
    }
    setPhase('streaming');
  }, []);

  // ── Process IFC file ──────────────────────────────────────────────────
  const processIFC = useCallback(async (file: File) => {
    try {
      setPhase('hashing');
      setProgress(0);
      setProgressMsg('Computing file hash…');
      setErrorMsg('');
      pendingTilesRef.current = [];

      const buffer = await file.arrayBuffer();
      const hash   = await hashBuffer(buffer);

      setPhase('checking');
      setProgressMsg('Checking cache…');

      if (await projectExists(hash)) {
        const cached = await loadManifest(hash);
        const meta   = await loadMetadata(hash);
        if (cached && meta) { startStreaming(hash, cached, meta); return; }
      }

      setPhase('processing');
      setProgress(0);
      setProgressMsg('Starting pipeline…');

      const worker = new Worker(
        new URL('../../lib/ifcTilePipeline.worker.ts', import.meta.url),
        { type: 'module' },
      );
      workerRef.current = worker;

      let finalManifest: RootManifest | null = null;
      let finalMetadata: ElementMetaMap = {};

      worker.onmessage = async (ev: MessageEvent<WorkerOutMsg>) => {
        const msg = ev.data;
        if (msg.type === 'progress') {
          setProgress(msg.percent);
          setProgressMsg(msg.message);
        } else if (msg.type === 'tile_data') {
          pendingTilesRef.current.push(msg);
        } else if (msg.type === 'complete') {
          worker.terminate();
          workerRef.current = null;

          finalManifest = msg.manifest;
          finalManifest.sourceHash   = hash;
          finalManifest.projectName  = file.name.replace(/\.ifc$/i, '');
          finalMetadata = msg.metadata;
          const totalTiles = pendingTilesRef.current.length;

          setPhase('building');
          setProgress(0);
          setProgressMsg(`Building ${totalTiles} GLB tiles…`);

          for (let i = 0; i < pendingTilesRef.current.length; i++) {
            const tileMsg = pendingTilesRef.current[i];
            setBuildingTile(tileMsg.tileId);
            setProgress(Math.round((i / totalTiles) * 100));
            try {
              const glb = await buildTileGLB(tileMsg);
              await cacheTileGLB(hash, tileMsg.tileId, glb);
            } catch (err) {
              console.warn(`[IFCTilesViewer] Failed to build tile ${tileMsg.tileId}:`, err);
            }
            if ((i + 1) % 5 === 0) await new Promise(r => setTimeout(r, 0));
          }

          await cacheManifest(hash, finalManifest);
          await cacheMetadata(hash, finalMetadata);
          await registerProject(hash, finalManifest.projectName, totalTiles, 0);

          pendingTilesRef.current = [];
          startStreaming(hash, finalManifest, finalMetadata);
        } else if (msg.type === 'error') {
          worker.terminate();
          workerRef.current = null;
          setPhase('error');
          setErrorMsg(msg.message);
        }
      };

      worker.onerror = (e) => {
        worker.terminate();
        workerRef.current = null;
        setPhase('error');
        setErrorMsg(e.message ?? 'Unknown worker error');
      };

      worker.postMessage(
        { type: 'process', ifcBuffer: buffer, gridSizeM: gridSizeMRef.current, wasmPath: WASM_PATH },
        [buffer],
      );
    } catch (err) {
      setPhase('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [startStreaming]);

  // ── Load cached project ───────────────────────────────────────────────
  const loadCachedProject = useCallback(async (hash: string) => {
    setPhase('checking');
    setProgressMsg('Loading cached tiles…');
    const man  = await loadManifest(hash);
    const meta = await loadMetadata(hash) ?? {};
    if (man) startStreaming(hash, man, meta);
    else { setPhase('error'); setErrorMsg('Cache entry corrupted'); }
  }, [startStreaming]);

  // ── Drop / file input handlers ────────────────────────────────────────
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file?.name.endsWith('.ifc')) processIFC(file);
  }, [processIFC]);

  const onFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processIFC(file);
    e.target.value = '';
  }, [processIFC]);

  // ── Highlight helpers ─────────────────────────────────────────────────
  const clearHighlight = useCallback(() => {
    const streaming = streamingRef.current;
    for (const id of selectionRef.current) streaming?.setHighlight(null, id);
    selectionRef.current.clear();
    selectedExpressIDRef.current = null;
    gizmoRef.current?.detach();
    setSelectedEl(null);
    setSelectedElements([]);
  }, []);

  /**
   * Apply/toggle highlight.
   * shift=false → replace selection with this element.
   * shift=true  → add/remove this element from selection.
   */
  const applyHighlight = useCallback((expressID: number, shift = false) => {
    const streaming = streamingRef.current;
    if (!shift) {
      // Replace selection
      for (const id of selectionRef.current) {
        if (id !== expressID) streaming?.setHighlight(null, id);
      }
      selectionRef.current.clear();
      streaming?.setHighlight(expressID, null);
      selectionRef.current.add(expressID);
      selectedExpressIDRef.current = expressID;
    } else {
      // Toggle this element
      if (selectionRef.current.has(expressID)) {
        streaming?.setHighlight(null, expressID);
        selectionRef.current.delete(expressID);
        selectedExpressIDRef.current = selectionRef.current.size === 1 ? [...selectionRef.current][0] : null;
      } else {
        streaming?.setHighlight(expressID, null);
        selectionRef.current.add(expressID);
        selectedExpressIDRef.current = selectionRef.current.size === 1 ? expressID : null;
      }
    }
  }, []);

  // ── Canvas click → drawing / zone select / element select ────────────
  const onCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    // ── Drawing mode: place polygon vertex ───────────────────────────────
    if (isDrawingPolygonRef.current) {
      // Ignore double-click here (handled by native dblclick)
      if (e.detail >= 2) return;
      const canvas2  = canvasRef.current;
      const camera2  = cameraRef.current;
      const scene2   = sceneRef.current;
      if (!canvas2 || !camera2 || !scene2) return;
      const pt = raycastToXZPlane(e.clientX, e.clientY, camera2, canvas2, 0.05);
      if (!pt) return;

      const pts = drawingPtsRef.current;
      // If near first point (≥3 pts) — close polygon
      if (pts.length >= 3) {
        const fdx = pt.x - pts[0][0], fdz = pt.z - pts[0][1];
        if (Math.sqrt(fdx * fdx + fdz * fdz) < 0.8) { finalizePolygonRef.current(); return; }
      }

      pts.push([pt.x, pt.z]);
      // Preview is updated on next mousemove (always has cursor pos → guaranteed ≥2 pts)
      return;
    }

    if (phase !== 'streaming') return;
    // Ignore clicks that ended a gizmo drag
    if (gizmoRef.current?.dragging) return;

    const canvas = canvasRef.current;
    const camera = cameraRef.current;
    const streaming = streamingRef.current;
    if (!canvas || !camera || !streaming) return;

    const rect  = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width)  *  2 - 1,
      ((e.clientY - rect.top)  / rect.height) * -2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // ── Zone fill-mesh picking ───────────────────────────────────────────
    if (!e.shiftKey) {
      for (const zone of rigZonesRef.current.values()) {
        const hits = raycaster.intersectObject(zone.fillMesh);
        if (hits.length > 0) {
          selectZoneRef.current(zone.id);
          return;
        }
      }
      // Clicking outside any zone → deselect current zone
      if (selectedZoneIdRef.current) {
        deselectZoneRef.current();
      }
    }

    // ── Element picking ──────────────────────────────────────────────────
    const result = streaming.pickElement(raycaster);
    if (result) {
      applyHighlight(result.expressID, e.shiftKey);

      // Sync selectedEl / selectedElements from the updated selection set
      const els = [...selectionRef.current].map(id =>
        metadataRef.current[id] ?? { expressID: id, category: 'unknown', name: '', type: '', tileId: result.tileId }
      );
      setSelectedEl(els.length === 1 ? els[0] : null);
      setSelectedElements(els);

      updateGizmoProxyRef.current(selectionRef.current);
    } else if (!e.shiftKey) {
      clearHighlight();
    }
  }, [phase, applyHighlight, clearHighlight]);

  // ── Floor toggle ──────────────────────────────────────────────────────
  const toggleFloor = useCallback((floorId: string) => {
    setActiveFloors(prev => {
      const next = new Set(prev);
      if (next.has(floorId)) next.delete(floorId); else next.add(floorId);
      return next;
    });
  }, []);

  // ── Gizmo proxy → centroid of selection ───────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const updateGizmoProxy = useCallback((sel: Set<number>) => {
    const gizmo   = gizmoRef.current;
    const proxy   = gizmoProxyRef.current;
    const streaming = streamingRef.current;
    if (!gizmo || !proxy) return;
    if (sel.size === 0) { gizmo.detach(); return; }

    const center = new THREE.Vector3();
    let count = 0;
    for (const id of sel) {
      const pos = streaming?.getWorldPosition(id);
      if (pos) { center.add(pos); count++; }
    }
    if (count > 0) center.divideScalar(count);

    proxy.position.copy(center);
    proxy.quaternion.identity();
    proxy.scale.set(1, 1, 1);
    const mat = new THREE.Matrix4();
    mat.compose(proxy.position, proxy.quaternion, proxy.scale);
    gizmoOriginalMatRef.current.copy(mat);
    gizmoPrevMatrixRef.current.copy(mat);
    gizmo.attach(proxy);
  }, []);
  // Keep ref in sync so startStreaming's closure can call it without a forward-ref error
  updateGizmoProxyRef.current = updateGizmoProxy;

  // ── Rig zone: finalise drawn polygon ──────────────────────────────────
  const finalizePolygon = useCallback(() => {
    const pts = drawingPtsRef.current;
    if (pts.length < 3) return;
    const streaming = streamingRef.current;
    const scene     = sceneRef.current;
    if (!streaming || !scene) return;

    const man      = manifest;
    const elevMin  = (man?.bounds?.min[1] ?? -0.5) - 0.5;
    const elevMax  = (man?.bounds?.max[1] ?? 10)   + 0.5;

    // ── Capture vertex ownership (vertex-level deformation) ──────────────
    // Scan every vertex in every loaded BatchedMesh; those inside the polygon
    // footprint (XZ) and within the elevation range are owned by this zone.
    const ownedVertexBatches: ZoneVertexBatch[] = [];
    for (const batch of streaming.getLoadedBatches()) {
      const posAttr = batch.geometry.attributes.position as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      const captured: number[] = [];
      for (let i = 0, n = posAttr.count; i < n; i++) {
        const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
        if (y >= elevMin && y <= elevMax && ptInPolyXZ(x, z, pts)) {
          captured.push(i);
        }
      }
      if (captured.length > 0) {
        ownedVertexBatches.push({ batch, indices: new Uint32Array(captured) });
      }
    }

    // ── Owned express IDs (for element highlighting in the panel) ─────────
    const positions      = streaming.getAllElementPositions();
    const ownedExpressIDs: number[] = [];
    for (const [expressID, pos] of positions) {
      if (pos.y >= elevMin && pos.y <= elevMax && ptInPolyXZ(pos.x, pos.z, pts)) {
        ownedExpressIDs.push(expressID);
      }
    }

    const wireframe = buildZoneWireframe(pts, elevMin, elevMax);
    const fillMesh  = buildZoneFillMesh(pts, elevMin);
    scene.add(wireframe);
    scene.add(fillMesh);

    const zone: RigZone = {
      id:  `zone_${Date.now()}`,
      label: `Zone ${rigZonesRef.current.size + 1}`,
      polygon: pts.map(p => [p[0], p[1]] as [number, number]),
      elevMin, elevMax,
      ownedExpressIDs,
      ownedVertexBatches,
      wireframe, fillMesh,
      dx: 0, dz: 0,
    };

    rigZonesRef.current.set(zone.id, zone);
    setRigZoneList(prev => [...prev, { id: zone.id, label: zone.label, count: ownedExpressIDs.length }]);

    // Clean up drawing visuals
    if (drawPreviewRef.current) { scene.remove(drawPreviewRef.current); drawPreviewRef.current.geometry.dispose(); drawPreviewRef.current = null; }
    drawingPtsRef.current = [];
    isDrawingPolygonRef.current = false;
    setIsDrawingPolygon(false);
    if (controlsRef.current) controlsRef.current.enabled = true;
  }, [manifest]);
  finalizePolygonRef.current = finalizePolygon;

  // ── Ortho ↔ Perspective camera switch ────────────────────────────────
  const switchCamera = useCallback(() => {
    const persp    = perspCameraRef.current;
    const ortho    = orthoCameraRef.current;
    const controls = controlsRef.current;
    const canvas   = canvasRef.current;
    const gizmo    = gizmoRef.current;
    if (!persp || !ortho || !controls || !canvas) return;

    const toOrtho = !isOrthoRef.current;

    if (toOrtho) {
      // Sync position / orientation from perspective camera
      ortho.position.copy(persp.position);
      ortho.quaternion.copy(persp.quaternion);
      ortho.up.copy(persp.up);
      // Compute frustum from current FOV + distance to orbit target
      const dist   = persp.position.distanceTo(controls.target);
      const halfH  = Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)) * dist;
      const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
      ortho.left   = -halfH * aspect;
      ortho.right  =  halfH * aspect;
      ortho.top    =  halfH;
      ortho.bottom = -halfH;
      ortho.near   = -1000;
      ortho.far    =  2000;
      ortho.zoom   = 1;
      ortho.updateProjectionMatrix();
      cameraRef.current = ortho;
      controls.object = ortho as unknown as THREE.Camera;
      if (gizmo) (gizmo as unknown as { camera: THREE.Camera }).camera = ortho;
    } else {
      // Sync position / orientation back to perspective
      persp.position.copy(ortho.position);
      persp.quaternion.copy(ortho.quaternion);
      persp.up.copy(ortho.up);
      persp.updateProjectionMatrix();
      cameraRef.current = persp;
      controls.object = persp as unknown as THREE.Camera;
      if (gizmo) (gizmo as unknown as { camera: THREE.Camera }).camera = persp;
    }

    controls.update();
    isOrthoRef.current = toOrtho;
    setIsOrtho(toOrtho);
  }, []);
  switchCameraRef.current = switchCamera;

  // ── Rig zone: select / deselect / delete ──────────────────────────────
  const selectZone = useCallback((zoneId: string) => {
    const zone = rigZonesRef.current.get(zoneId);
    if (!zone) return;

    // Clear any element selection first
    for (const id of selectionRef.current) streamingRef.current?.setHighlight(null, id);
    selectionRef.current.clear();
    selectedExpressIDRef.current = null;
    setSelectedEl(null);
    setSelectedElements([]);

    selectedZoneIdRef.current = zoneId;
    setSelectedZoneId(zoneId);

    // Brighten wireframe to show selection
    (zone.wireframe.material as THREE.LineBasicMaterial).color.set(0xffffff);
    (zone.wireframe.material as THREE.LineBasicMaterial).opacity = 1.0;

    // Highlight owned elements with zone colour
    for (const id of zone.ownedExpressIDs) streamingRef.current?.setHighlight(id, null);

    // Compute zone polygon centroid for gizmo placement
    let cx = 0, cz = 0;
    for (const [x, z] of zone.polygon) { cx += x; cz += z; }
    cx /= zone.polygon.length;
    cz /= zone.polygon.length;
    const cy = (zone.elevMin + zone.elevMax) / 2;

    const proxy = gizmoProxyRef.current;
    const gizmo = gizmoRef.current;
    if (!proxy || !gizmo) return;
    proxy.position.set(cx, cy, cz);
    proxy.quaternion.identity();
    proxy.scale.set(1, 1, 1);
    const mat = new THREE.Matrix4();
    mat.compose(proxy.position, proxy.quaternion, proxy.scale);
    gizmoPrevMatrixRef.current.copy(mat);
    zoneGizmoPrevMatRef.current.copy(mat);
    gizmo.setMode('translate');
    gizmo.attach(proxy);
  }, []);
  selectZoneRef.current = selectZone;

  const deselectZone = useCallback(() => {
    const zoneId = selectedZoneIdRef.current;
    if (!zoneId) return;
    const zone = rigZonesRef.current.get(zoneId);
    if (zone) {
      for (const id of zone.ownedExpressIDs) streamingRef.current?.setHighlight(null, id);
      // Restore dim wireframe
      (zone.wireframe.material as THREE.LineBasicMaterial).color.set(ZONE_COLOR);
      (zone.wireframe.material as THREE.LineBasicMaterial).opacity = 0.65;
    }
    selectedZoneIdRef.current = null;
    setSelectedZoneId(null);
    gizmoRef.current?.detach();
  }, []);
  deselectZoneRef.current = deselectZone;

  const deleteZone = useCallback((zoneId: string) => {
    const zone  = rigZonesRef.current.get(zoneId);
    if (!zone) return;
    const scene = sceneRef.current;
    for (const id of zone.ownedExpressIDs) streamingRef.current?.setHighlight(null, id);
    if (scene) {
      scene.remove(zone.wireframe);
      scene.remove(zone.fillMesh);
    }
    zone.wireframe.geometry.dispose();
    (zone.wireframe.material as THREE.Material).dispose();
    zone.fillMesh.geometry.dispose();
    (zone.fillMesh.material as THREE.Material).dispose();
    rigZonesRef.current.delete(zoneId);
    setRigZoneList(prev => prev.filter(z => z.id !== zoneId));
    if (selectedZoneIdRef.current === zoneId) {
      selectedZoneIdRef.current = null;
      setSelectedZoneId(null);
      gizmoRef.current?.detach();
    }
  }, []);

  // ── Array transform ───────────────────────────────────────────────────
  const applyArrayTransform = useCallback(() => {
    const streaming = streamingRef.current;
    if (!streaming) return;
    const ids = [...selectionRef.current];
    if (ids.length === 0) return;

    const axisOffset = new THREE.Vector3(
      arrayParams.axis === 'x' ? arrayParams.distance : 0,
      arrayParams.axis === 'y' ? arrayParams.distance : 0,
      arrayParams.axis === 'z' ? arrayParams.distance : 0,
    );

    const newIds: number[] = [];
    for (const expressID of ids) {
      const baseMat = streaming.getMatrix(expressID);
      if (!baseMat) continue;
      for (let i = 1; i <= arrayParams.count; i++) {
        const offset = new THREE.Matrix4().makeTranslation(
          axisOffset.x * i, axisOffset.y * i, axisOffset.z * i,
        );
        const newMat = offset.clone().multiply(baseMat);
        const newID = streaming.cloneElement(expressID, newMat);
        if (newID != null) {
          newIds.push(newID);
          const srcMeta = metadataRef.current[expressID];
          if (srcMeta) {
            metadataRef.current[newID] = {
              ...srcMeta, expressID: newID,
              name: srcMeta.name ? `${srcMeta.name} [${i}]` : `copy ${i}`,
            };
          }
        }
      }
    }

    // Select all new clones
    for (const id of selectionRef.current) streaming.setHighlight(null, id);
    selectionRef.current.clear();
    for (const id of newIds) { streaming.setHighlight(id, null); selectionRef.current.add(id); }
    selectedExpressIDRef.current = newIds.length === 1 ? newIds[0] : null;

    const els = newIds.map(id => metadataRef.current[id] ?? { expressID: id, category: 'unknown', name: '', type: '', tileId: '' });
    setSelectedEl(els.length === 1 ? els[0] : null);
    setSelectedElements(els);
    updateGizmoProxy(selectionRef.current);
    setShowArrayPanel(false);
  }, [arrayParams, updateGizmoProxy]);

  // ── CSG opening regeneration ─────────────────────────────────────────
  const applyOpeningRegen = useCallback((
    windowExpressID: number,
    openingInfo: OpeningInfo,
    moveDelta: THREE.Matrix4,
    _tileId: string,
  ) => {
    const streaming = streamingRef.current;
    const scene     = sceneRef.current;
    const evaluator = csgEvaluatorRef.current;
    if (!streaming || !scene || !evaluator) return;

    const { hostWallExpressID, openingBboxWorld } = openingInfo;

    // Check for existing standalone wall (already ejected by a prior operation)
    const existingStandalone = standaloneWallsRef.current.get(hostWallExpressID);

    let baseWallGeom: THREE.BufferGeometry | null;
    let wallColor: THREE.Color;

    if (existingStandalone) {
      baseWallGeom = existingStandalone.geometry;
      wallColor    = (existingStandalone.material as THREE.MeshLambertMaterial).color.clone();
      scene.remove(existingStandalone);
      standaloneWallsRef.current.delete(hostWallExpressID);
    } else {
      const ejected = streaming.ejectFromBatch(hostWallExpressID);
      if (!ejected) {
        // Wall tile not loaded — warn and bail
        console.warn('[IFCTilesViewer] Host wall not in scene, opening regen skipped.');
        return;
      }
      baseWallGeom = ejected.geom;
      wallColor    = ejected.color;
    }

    setRegenStatus('computing');

    // Run CSG asynchronously (via setTimeout to let the React repaint first)
    setTimeout(() => {
      try {
        // Old opening box: slightly expanded for clean fill
        const oldMin = new THREE.Vector3(...openingBboxWorld.min);
        const oldMax = new THREE.Vector3(...openingBboxWorld.max);
        const oldCenter = new THREE.Vector3().addVectors(oldMin, oldMax).multiplyScalar(0.5);
        const oldSize   = new THREE.Vector3().subVectors(oldMax, oldMin).addScalar(0.12);

        // New opening box: translate old box by moveDelta
        const newMin = oldMin.clone().applyMatrix4(moveDelta);
        const newMax = oldMax.clone().applyMatrix4(moveDelta);
        const newCenter = new THREE.Vector3().addVectors(newMin, newMax).multiplyScalar(0.5);
        const newSize   = new THREE.Vector3().subVectors(newMax, newMin).addScalar(0.02);

        const wallBrush = new Brush(baseWallGeom!);
        wallBrush.updateMatrixWorld();

        // Step 1: fill old opening (UNION wall + old-opening box)
        const fillGeom = new THREE.BoxGeometry(oldSize.x, oldSize.y, oldSize.z);
        const fillBrush = new Brush(fillGeom);
        fillBrush.position.copy(oldCenter);
        fillBrush.updateMatrixWorld();
        const filled = evaluator.evaluate(wallBrush, fillBrush, ADDITION);

        // Step 2: cut new opening (SUBTRACT new-opening box from filled wall)
        const cutGeom = new THREE.BoxGeometry(newSize.x, newSize.y, newSize.z);
        const cutBrush = new Brush(cutGeom);
        cutBrush.position.copy(newCenter);
        cutBrush.updateMatrixWorld();
        const result = evaluator.evaluate(filled, cutBrush, SUBTRACTION);

        // Replace wall in scene with standalone Mesh
        const mat = new THREE.MeshLambertMaterial({ color: wallColor, side: THREE.FrontSide });
        const wallMesh = new THREE.Mesh(result.geometry, mat);
        wallMesh.castShadow    = true;
        wallMesh.receiveShadow = true;
        wallMesh.matrixAutoUpdate = false;
        wallMesh.matrix.identity();
        wallMesh.updateMatrixWorld();
        scene.add(wallMesh);
        standaloneWallsRef.current.set(hostWallExpressID, wallMesh);

        // Update cached geometry for future operations on same wall
        streaming.setWallGeom(hostWallExpressID, result.geometry.clone());

        // Dispose temporary brushes
        fillGeom.dispose();
        cutGeom.dispose();

        setRegenStatus('done');
        setTimeout(() => setRegenStatus('idle'), 2500);

        // Keep selection highlight on the moved element
        if (selectionRef.current.has(windowExpressID)) {
          streaming.setHighlight(windowExpressID, null);
        }
      } catch (err) {
        console.error('[IFCTilesViewer] Opening regen failed:', err);
        setRegenStatus('error');
        setTimeout(() => setRegenStatus('idle'), 3000);
      }
    }, 16);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────
  const isProcessing = phase === 'hashing' || phase === 'checking' || phase === 'processing' || phase === 'building';

  const regenLabel: Record<typeof regenStatus, string> = {
    idle: '',
    computing: '⚙ Regenerating opening…',
    done: '✓ Opening regenerated',
    error: '⚠ Opening regen failed',
  };

  return (
    <div className={cn('relative flex flex-col w-full h-full overflow-hidden bg-[#1a1f2a]', className)}>
      {/* ── Toolbar ── */}
      {phase === 'streaming' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
          background: 'hsl(var(--background))', borderBottom: '1px solid hsl(var(--border))',
          flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            📦 {manifest?.projectName ?? 'IFC Tiles'}
          </span>

          {/* Floor filter */}
          {manifest && manifest.floors.length > 1 && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>Floors:</span>
              {manifest.floors.map(f => (
                <button key={f.id} onClick={() => toggleFloor(f.id)} style={{
                  padding: '2px 7px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                  background: activeFloors.size === 0 || activeFloors.has(f.id)
                    ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                  color: activeFloors.size === 0 || activeFloors.has(f.id)
                    ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                  border: '1px solid hsl(var(--border))',
                }}>
                  {f.name}
                </button>
              ))}
            </div>
          )}

          {/* Camera mode toggle */}
          <button
            onClick={() => switchCamera()}
            title="Toggle orthographic / perspective (O)"
            style={{
              padding: '2px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
              background: isOrtho ? 'rgba(180,220,255,0.18)' : 'hsl(var(--muted))',
              color:      isOrtho ? '#a8d8ff'                 : 'hsl(var(--muted-foreground))',
              border:     isOrtho ? '1px solid #a8d8ff66'     : '1px solid hsl(var(--border))',
              fontWeight: isOrtho ? 700 : 400,
            }}
          >
            {isOrtho ? '⬜ Ortho (O)' : '⬡ Persp (O)'}
          </button>

          {/* Gizmo mode */}
          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', textTransform: 'uppercase', letterSpacing: 0.6 }}>Gizmo</span>
            {(['translate', 'rotate'] as GizmoMode[]).map(m => (
              <button key={m} onClick={() => setGizmoMode(m)} style={{
                padding: '2px 7px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                background: gizmoMode === m ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                color: gizmoMode === m ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                border: '1px solid hsl(var(--border))',
              }}>
                {m === 'translate' ? '↔ Move (G)' : '↻ Rotate (R)'}
              </button>
            ))}
          </div>

          {/* Draw Rig Zone button */}
          <button
            onClick={() => {
              if (!isDrawingPolygon) {
                isDrawingPolygonRef.current = true;
                setIsDrawingPolygon(true);
                if (controlsRef.current) controlsRef.current.enabled = false;
                drawingPtsRef.current = [];
              } else {
                isDrawingPolygonRef.current = false;
                setIsDrawingPolygon(false);
                if (controlsRef.current) controlsRef.current.enabled = true;
                drawingPtsRef.current = [];
                const sc = sceneRef.current;
                if (drawPreviewRef.current && sc) { sc.remove(drawPreviewRef.current); drawPreviewRef.current.geometry.dispose(); drawPreviewRef.current = null; }
              }
            }}
            style={{
              padding: '2px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
              background: isDrawingPolygon ? '#00ccff33' : 'hsl(var(--muted))',
              color: isDrawingPolygon ? '#00ccff' : 'hsl(var(--muted-foreground))',
              border: isDrawingPolygon ? '1px solid #00ccff88' : '1px solid hsl(var(--border))',
              fontWeight: isDrawingPolygon ? 700 : 400,
            }}
          >
            ⬡ {isDrawingPolygon ? 'Drawing… (P/Esc cancel)' : 'Draw Zone (P)'}
          </button>

          {/* Regen status badge */}
          {regenStatus !== 'idle' && (
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 10,
              background: regenStatus === 'done' ? '#14532d' : regenStatus === 'error' ? '#450a0a' : '#1e3a5f',
              color: regenStatus === 'done' ? '#86efac' : regenStatus === 'error' ? '#fca5a5' : '#93c5fd',
            }}>
              {regenLabel[regenStatus]}
            </span>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
              tiles: {stats.tilesLoaded} ({stats.tilesLoading} loading) | {stats.drawCalls} DC | {stats.budgetMB} MB | clusters: {stats.meshletsCulled}/{stats.meshletsTotal} culled
            </span>
            <button
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file'; input.accept = '.glb,.gltf';
                input.onchange = async () => {
                  const file = input.files?.[0];
                  if (!file || !sceneRef.current) return;
                  const blobUrl = URL.createObjectURL(file);
                  try {
                    const loader = new GLTFLoader();
                    const gltf = await new Promise<THREE.Group>((resolve, reject) => {
                      loader.load(blobUrl, g => resolve(g.scene), undefined, reject);
                    });
                    sceneRef.current.add(gltf);
                    importedGroupsRef.current.push(gltf);
                  } catch (err) {
                    console.warn('[IFCTilesViewer] GLB import failed:', err);
                  } finally { URL.revokeObjectURL(blobUrl); }
                };
                input.click();
              }}
              style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))',
                border: '1px solid hsl(var(--border))' }}
            >
              📦 Import GLB
            </button>
            <button onClick={() => setBgLight(v => !v)} style={{
              padding: '2px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
              background: bgLight ? '#e8e8e8' : 'hsl(var(--muted))',
              color: bgLight ? '#333' : 'hsl(var(--muted-foreground))',
              border: '1px solid hsl(var(--border))',
            }}>
              {bgLight ? 'Dark BG' : 'White BG'}
            </button>
            <button
              onClick={() => {
                clearHighlight();
                gizmoRef.current?.detach();
                setPhase('idle'); setManifest(null); setSelectedEl(null);
                selectedExpressIDRef.current = null;
              }}
              style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))',
                border: '1px solid hsl(var(--border))' }}
            >
              ↩ Change file
            </button>
          </div>
        </div>
      )}

      {/* ── 3D canvas ── */}
      <canvas
        ref={canvasRef}
        style={{ flex: 1, display: 'block', width: '100%', outline: 'none' }}
        onClick={onCanvasClick}
      />

      {/* ── File drop overlay ── */}
      {(phase === 'idle' || phase === 'error') && (
        <div
          style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 16,
            background: isDragging ? 'rgba(59,130,246,0.12)' : 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(4px)',
          }}
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
        >
          <div style={{
            border: `2px dashed ${isDragging ? '#3b82f6' : 'hsl(var(--border))'}`,
            borderRadius: 12, padding: '32px 48px', textAlign: 'center',
            background: isDragging ? 'rgba(59,130,246,0.08)' : 'hsl(var(--card)/0.9)',
          }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📦</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'hsl(var(--foreground))', marginBottom: 6 }}>
              IFC Tiles Viewer
            </div>
            <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', marginBottom: 12 }}>
              Drop an <b>.ifc</b> file or click to open
            </div>
            {/* Grid size control */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, justifyContent: 'center' }}>
              <span style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>Tile grid:</span>
              {[10, 20, 40].map(v => (
                <button key={v} onClick={() => { setGridSizeM(v); gridSizeMRef.current = v; }} style={{
                  padding: '3px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                  background: gridSizeM === v ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                  color: gridSizeM === v ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                  border: '1px solid hsl(var(--border))',
                }}>
                  {v}m
                </button>
              ))}
            </div>
            <label style={{
              display: 'inline-block', padding: '6px 18px', borderRadius: 6, cursor: 'pointer',
              background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', fontSize: 12,
            }}>
              Open IFC File
              <input type="file" accept=".ifc" style={{ display: 'none' }} onChange={onFileInput} />
            </label>
          </div>

          {phase === 'error' && (
            <div style={{ color: '#ef4444', fontSize: 12, maxWidth: 380, textAlign: 'center', padding: '8px 16px', background: '#1f1010', borderRadius: 8 }}>
              ⚠ {errorMsg}
            </div>
          )}

          {cachedProjects.length > 0 && (
            <div style={{
              background: 'hsl(var(--card)/0.9)', border: '1px solid hsl(var(--border))',
              borderRadius: 8, padding: 12, width: 340,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: 'hsl(var(--foreground))' }}>
                Cached projects ({cachedProjects.length})
              </div>
              {cachedProjects.slice(0, 6).map(p => (
                <div key={p.hash} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0',
                  borderBottom: '1px solid hsl(var(--border)/0.4)',
                }}>
                  <button
                    onClick={() => loadCachedProject(p.hash)}
                    style={{ flex: 1, textAlign: 'left', fontSize: 11, cursor: 'pointer', background: 'none', border: 'none', color: 'hsl(var(--foreground))' }}
                  >
                    📦 {p.name}
                    <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', marginLeft: 6 }}>
                      {p.tileCount} tiles · {new Date(p.date).toLocaleDateString()}
                    </span>
                  </button>
                  <button
                    onClick={() => deleteProject(p.hash).then(() => listCachedProjects().then(setCachedProjects))}
                    style={{ fontSize: 11, color: '#ef4444', cursor: 'pointer', background: 'none', border: 'none', opacity: 0.7 }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Processing overlay ── */}
      {isProcessing && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
          background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))',
            borderRadius: 10, padding: '28px 40px', width: 380, textAlign: 'center',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'hsl(var(--foreground))' }}>
              {phase === 'processing' ? '⚙ Processing IFC…' :
               phase === 'building'   ? '🔨 Building GLB tiles…' :
               phase === 'hashing'    ? '🔑 Hashing…' : '🔍 Checking cache…'}
            </div>
            {phase === 'building' && buildingTile && (
              <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', marginBottom: 8 }}>{buildingTile}</div>
            )}
            <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', marginBottom: 14 }}>{progressMsg}</div>
            <div style={{ background: 'hsl(var(--muted))', borderRadius: 99, height: 6, overflow: 'hidden' }}>
              <div style={{ width: `${progress}%`, height: '100%', borderRadius: 99,
                background: 'hsl(var(--primary))', transition: 'width 0.3s ease' }} />
            </div>
            <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', marginTop: 6 }}>{progress}%</div>
          </div>
        </div>
      )}

      {/* ── Selection panel (single or multi) ── */}
      {(selectedEl || selectedElements.length > 1) && phase === 'streaming' && (
        <div style={{
          position: 'absolute', top: 48, right: 12, zIndex: 20,
          background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))',
          borderRadius: 8, padding: 12, width: 252, boxShadow: '0 4px 24px #0005', fontSize: 11,
          maxHeight: 'calc(100% - 64px)', overflowY: 'auto',
        }}>

          {/* ── Single element ── */}
          {selectedEl && selectedElements.length <= 1 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                  {selectedEl.category.toUpperCase()}
                </span>
                <button onClick={() => { clearHighlight(); }}
                  style={{ color: 'hsl(var(--muted-foreground))', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>×
                </button>
              </div>
              {[
                ['Name',       selectedEl.name || '—'],
                ['Type',       selectedEl.type],
                ['Express ID', String(selectedEl.expressID)],
                ['Tile',       selectedEl.tileId],
              ].map(([label, val]) => (
                <div key={label} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <span style={{ color: 'hsl(var(--muted-foreground))', width: 72, flexShrink: 0 }}>{label}</span>
                  <span style={{ color: 'hsl(var(--foreground))', wordBreak: 'break-all' }}>{val}</span>
                </div>
              ))}
              {selectedEl.openingInfo && (
                <div style={{ marginTop: 6, padding: '4px 8px', background: '#1e3a5f44', borderRadius: 4, fontSize: 10, color: '#93c5fd' }}>
                  ↔ Hosted opening · wall #{selectedEl.openingInfo.hostWallExpressID}
                </div>
              )}
              {selectedEl.properties && Object.entries(selectedEl.properties).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <span style={{ color: 'hsl(var(--muted-foreground))', width: 72, flexShrink: 0 }}>{k}</span>
                  <span style={{ color: 'hsl(var(--foreground))' }}>{String(v)}</span>
                </div>
              ))}
              {/* Single-element actions */}
              <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => streamingRef.current?.setVisible(selectedEl.expressID, false)}
                  style={{ flex: 1, padding: '3px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                    background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))',
                    border: '1px solid hsl(var(--border))' }}>Hide</button>
                <button onClick={() => streamingRef.current?.setVisible(selectedEl.expressID, true)}
                  style={{ flex: 1, padding: '3px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                    background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))',
                    border: '1px solid hsl(var(--border))' }}>Show</button>
                <button
                  onClick={() => {
                    const id = selectedEl.expressID;
                    streamingRef.current?.deleteElement(id);
                    const standalone = standaloneWallsRef.current.get(id);
                    if (standalone) {
                      sceneRef.current?.remove(standalone);
                      standalone.geometry.dispose();
                      (standalone.material as THREE.Material).dispose();
                      standaloneWallsRef.current.delete(id);
                    }
                    clearHighlight();
                  }}
                  style={{ flex: 1, padding: '3px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                    background: '#3f1010', color: '#f87171', border: '1px solid #7f2020' }}>Delete</button>
              </div>
              {/* Array section */}
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={() => setShowArrayPanel(v => !v)}
                  style={{ width: '100%', padding: '3px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                    background: showArrayPanel ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                    color: showArrayPanel ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                    border: '1px solid hsl(var(--border))' }}>
                  ⊞ Array transform…
                </button>
                {showArrayPanel && (
                  <div style={{ marginTop: 6, padding: '8px', background: 'hsl(var(--muted)/0.4)', borderRadius: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', width: 38 }}>Axis</span>
                      {(['x','y','z'] as const).map(ax => (
                        <button key={ax} onClick={() => setArrayParams(p => ({ ...p, axis: ax }))} style={{
                          flex: 1, padding: '2px 0', fontSize: 10, borderRadius: 3, cursor: 'pointer',
                          background: arrayParams.axis === ax ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                          color: arrayParams.axis === ax ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                          border: '1px solid hsl(var(--border))', textTransform: 'uppercase',
                        }}>{ax}</button>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', width: 38 }}>Dist</span>
                      <input type="number" value={arrayParams.distance} step={0.5}
                        onChange={e => setArrayParams(p => ({ ...p, distance: parseFloat(e.target.value) || 1 }))}
                        style={{ flex: 1, padding: '2px 4px', fontSize: 10, borderRadius: 3,
                          background: 'hsl(var(--muted))', color: 'hsl(var(--foreground))',
                          border: '1px solid hsl(var(--border))', outline: 'none' }} />
                      <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))' }}>m</span>
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', width: 38 }}>Count</span>
                      <input type="number" value={arrayParams.count} min={1} max={64}
                        onChange={e => setArrayParams(p => ({ ...p, count: Math.max(1, parseInt(e.target.value) || 1) }))}
                        style={{ flex: 1, padding: '2px 4px', fontSize: 10, borderRadius: 3,
                          background: 'hsl(var(--muted))', color: 'hsl(var(--foreground))',
                          border: '1px solid hsl(var(--border))', outline: 'none' }} />
                    </div>
                    <button onClick={applyArrayTransform} style={{
                      padding: '4px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                      background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))',
                      border: 'none', fontWeight: 600,
                    }}>Create Array ({arrayParams.count}×)</button>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Multi-select summary ── */}
          {selectedElements.length > 1 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                  {selectedElements.length} elements
                </span>
                <button onClick={() => clearHighlight()}
                  style={{ color: 'hsl(var(--muted-foreground))', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>×
                </button>
              </div>
              {/* Element list (first 6) */}
              {selectedElements.slice(0, 6).map(el => (
                <div key={el.expressID} style={{ display: 'flex', gap: 6, marginBottom: 3, alignItems: 'center' }}>
                  <span style={{ color: 'hsl(var(--muted-foreground))', fontSize: 9, width: 48, flexShrink: 0 }}>
                    {el.category}
                  </span>
                  <span style={{ color: 'hsl(var(--foreground))', fontSize: 10, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {el.name || `#${el.expressID}`}
                  </span>
                </div>
              ))}
              {selectedElements.length > 6 && (
                <div style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', marginBottom: 4 }}>
                  +{selectedElements.length - 6} more…
                </div>
              )}
              {/* Multi actions */}
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  onClick={() => {
                    for (const el of selectedElements) streamingRef.current?.setVisible(el.expressID, false);
                  }}
                  style={{ flex: 1, padding: '3px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                    background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))',
                    border: '1px solid hsl(var(--border))' }}>Hide All</button>
                <button
                  onClick={() => {
                    const streaming = streamingRef.current;
                    const scene = sceneRef.current;
                    gizmoRef.current?.detach();
                    for (const el of selectedElements) {
                      streaming?.deleteElement(el.expressID);
                      const standalone = standaloneWallsRef.current.get(el.expressID);
                      if (standalone && scene) {
                        scene.remove(standalone);
                        standalone.geometry.dispose();
                        (standalone.material as THREE.Material).dispose();
                        standaloneWallsRef.current.delete(el.expressID);
                      }
                    }
                    clearHighlight();
                  }}
                  style={{ flex: 1, padding: '3px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                    background: '#3f1010', color: '#f87171', border: '1px solid #7f2020' }}>Delete All</button>
              </div>
              <button
                onClick={() => {
                  const ids = [...selectionRef.current];
                  setGroups(prev => [...prev, {
                    id: `group_${Date.now()}`,
                    name: `Group ${prev.length + 1}`,
                    expressIDs: ids,
                  }]);
                }}
                style={{ marginTop: 6, width: '100%', padding: '4px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                  background: '#1e3a5f', color: '#93c5fd', border: '1px solid #2a4f7f', fontWeight: 600 }}>
                ⊞ Create Group (Ctrl+G)
              </button>
              {/* Array on multi-selection */}
              <div style={{ marginTop: 6 }}>
                <button
                  onClick={() => setShowArrayPanel(v => !v)}
                  style={{ width: '100%', padding: '3px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                    background: showArrayPanel ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                    color: showArrayPanel ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                    border: '1px solid hsl(var(--border))' }}>
                  ⊞ Array selection…
                </button>
                {showArrayPanel && (
                  <div style={{ marginTop: 6, padding: '8px', background: 'hsl(var(--muted)/0.4)', borderRadius: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', width: 38 }}>Axis</span>
                      {(['x','y','z'] as const).map(ax => (
                        <button key={ax} onClick={() => setArrayParams(p => ({ ...p, axis: ax }))} style={{
                          flex: 1, padding: '2px 0', fontSize: 10, borderRadius: 3, cursor: 'pointer',
                          background: arrayParams.axis === ax ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                          color: arrayParams.axis === ax ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                          border: '1px solid hsl(var(--border))', textTransform: 'uppercase',
                        }}>{ax}</button>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', width: 38 }}>Dist</span>
                      <input type="number" value={arrayParams.distance} step={0.5}
                        onChange={e => setArrayParams(p => ({ ...p, distance: parseFloat(e.target.value) || 1 }))}
                        style={{ flex: 1, padding: '2px 4px', fontSize: 10, borderRadius: 3,
                          background: 'hsl(var(--muted))', color: 'hsl(var(--foreground))',
                          border: '1px solid hsl(var(--border))', outline: 'none' }} />
                      <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))' }}>m</span>
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', width: 38 }}>Count</span>
                      <input type="number" value={arrayParams.count} min={1} max={64}
                        onChange={e => setArrayParams(p => ({ ...p, count: Math.max(1, parseInt(e.target.value) || 1) }))}
                        style={{ flex: 1, padding: '2px 4px', fontSize: 10, borderRadius: 3,
                          background: 'hsl(var(--muted))', color: 'hsl(var(--foreground))',
                          border: '1px solid hsl(var(--border))', outline: 'none' }} />
                    </div>
                    <button onClick={applyArrayTransform} style={{
                      padding: '4px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                      background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))',
                      border: 'none', fontWeight: 600,
                    }}>Create Array ({arrayParams.count}×)</button>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Keyboard hint (always shown) */}
          <div style={{ marginTop: 8, fontSize: 9, color: 'hsl(var(--muted-foreground))', textAlign: 'center' }}>
            G — move · R — rotate · Del — delete · Shift+click — multi-select · Esc — deselect
          </div>
        </div>
      )}

      {/* ── Groups panel ── */}
      {groups.length > 0 && phase === 'streaming' && (
        <div style={{
          position: 'absolute', bottom: 12, right: 12, zIndex: 20,
          background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))',
          borderRadius: 8, padding: 10, width: 220, boxShadow: '0 4px 16px #0004', fontSize: 11,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'center' }}>
            <span style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>Groups ({groups.length})</span>
          </div>
          {groups.map(g => (
            <div key={g.id} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0',
              borderBottom: '1px solid hsl(var(--border)/0.4)',
            }}>
              <button
                onClick={() => {
                  // Select all elements in this group
                  const streaming = streamingRef.current;
                  if (!streaming) return;
                  for (const id of selectionRef.current) streaming.setHighlight(null, id);
                  selectionRef.current.clear();
                  for (const id of g.expressIDs) {
                    streaming.setHighlight(id, null);
                    selectionRef.current.add(id);
                  }
                  selectedExpressIDRef.current = g.expressIDs.length === 1 ? g.expressIDs[0] : null;
                  const els = g.expressIDs.map(id =>
                    metadataRef.current[id] ?? { expressID: id, category: 'unknown', name: '', type: '', tileId: '' }
                  );
                  setSelectedEl(els.length === 1 ? els[0] : null);
                  setSelectedElements(els);
                  updateGizmoProxy(selectionRef.current);
                }}
                style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer',
                  color: 'hsl(var(--foreground))', fontSize: 10 }}
              >
                {g.name}
                <span style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', marginLeft: 4 }}>
                  ({g.expressIDs.length})
                </span>
              </button>
              <input
                defaultValue={g.name}
                onBlur={e => setGroups(prev => prev.map(x => x.id === g.id ? { ...x, name: e.target.value || x.name } : x))}
                style={{ width: 60, padding: '1px 4px', fontSize: 9, borderRadius: 3,
                  background: 'hsl(var(--muted))', color: 'hsl(var(--foreground))',
                  border: '1px solid hsl(var(--border))', outline: 'none' }}
              />
              <button
                onClick={() => setGroups(prev => prev.filter(x => x.id !== g.id))}
                style={{ fontSize: 11, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer', opacity: 0.7 }}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {/* ── Drawing mode overlay ── */}
      {isDrawingPolygon && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          pointerEvents: 'none', zIndex: 30, textAlign: 'center',
        }}>
          <div style={{
            background: 'rgba(0,204,255,0.12)', border: '1px solid rgba(0,204,255,0.5)',
            borderRadius: 8, padding: '10px 20px', color: '#00ccff', fontSize: 12,
            backdropFilter: 'blur(4px)',
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>POLYGON DRAWING MODE</div>
            <div style={{ fontSize: 10, opacity: 0.8 }}>
              {drawingPtsRef.current.length === 0
                ? 'Click to place first vertex'
                : `${drawingPtsRef.current.length} point${drawingPtsRef.current.length > 1 ? 's' : ''} — click near start or double-click to close`
              }
            </div>
            <div style={{ fontSize: 9, opacity: 0.6, marginTop: 3 }}>P or Esc to cancel</div>
          </div>
        </div>
      )}

      {/* ── Rig Zones panel ── */}
      {rigZoneList.length > 0 && phase === 'streaming' && (
        <div style={{
          position: 'absolute', bottom: groups.length > 0 ? 160 : 12, left: 12, zIndex: 20,
          background: 'rgba(10, 12, 18, 0.93)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 10, width: 230,
          boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,204,255,0.08)',
          fontSize: 11, overflow: 'hidden',
          maxHeight: 280,
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 12px 7px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(0,204,255,0.05)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{
                display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                background: '#00ccff', boxShadow: '0 0 6px #00ccffaa',
              }} />
              <span style={{ fontWeight: 700, color: '#d4e8f0', letterSpacing: '0.04em', fontSize: 10, textTransform: 'uppercase' }}>
                Rig Zones
              </span>
            </div>
            <span style={{
              background: 'rgba(0,204,255,0.18)', color: '#00ccff',
              padding: '1px 7px', borderRadius: 10, fontSize: 9, fontWeight: 700,
            }}>
              {rigZoneList.length}
            </span>
          </div>

          {/* Zone rows */}
          <div style={{ overflowY: 'auto', maxHeight: 180 }}>
            {rigZoneList.map(z => {
              const isSel = selectedZoneId === z.id;
              return (
                <div
                  key={z.id}
                  onClick={() => isSel ? deselectZone() : selectZone(z.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 12px',
                    cursor: 'pointer',
                    background: isSel ? 'rgba(0,204,255,0.1)' : 'transparent',
                    borderLeft: `3px solid ${isSel ? '#00ccff' : 'transparent'}`,
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                  }}
                >
                  <span style={{ fontSize: 15, color: isSel ? '#00ccff' : 'rgba(0,204,255,0.4)', lineHeight: 1, flexShrink: 0 }}>⬡</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      color: isSel ? '#fff' : 'rgba(255,255,255,0.72)',
                      fontWeight: isSel ? 600 : 400, fontSize: 11,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {z.label}
                    </div>
                    <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 9, marginTop: 1 }}>
                      {z.count} elements
                    </div>
                  </div>
                  {isSel && (
                    <span style={{
                      background: '#00ccff', color: '#000d14',
                      fontSize: 7, fontWeight: 800, padding: '2px 5px',
                      borderRadius: 4, letterSpacing: '0.06em',
                    }}>
                      ACTIVE
                    </span>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); deleteZone(z.id); }}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0,
                      color: 'rgba(239,68,68,0.5)', fontSize: 13, padding: '2px 3px',
                      lineHeight: 1, borderRadius: 4,
                    }}
                    title="Delete zone"
                  >✕</button>
                </div>
              );
            })}
          </div>

          {/* Footer hint when zone selected */}
          {selectedZoneId ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px',
              borderTop: '1px solid rgba(255,255,255,0.06)',
              background: 'rgba(0,204,255,0.04)',
            }}>
              <span style={{ fontSize: 12, color: '#00ccff' }}>↔</span>
              <span style={{ color: 'rgba(255,255,255,0.38)', fontSize: 9, lineHeight: 1.4 }}>
                Drag arrows to move zone · Esc to deselect
              </span>
            </div>
          ) : (
            <div style={{
              padding: '5px 12px',
              borderTop: '1px solid rgba(255,255,255,0.06)',
            }}>
              <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 9 }}>
                Click a zone to select &amp; show gizmo
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
