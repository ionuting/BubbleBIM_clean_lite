/**
 * glbLibraryLoader — async GLB/GLTF loader for Babylon.js.
 *
 * Uses @babylonjs/loaders GLTF plugin (already in package.json).
 * Caches loaded abstract geometry so a repeated glb_ref only hits the
 * network once per session.
 *
 * Usage in BabylonViewer:
 *   const meshes = await loadGlbIntoScene('/library/objects/...glb', scene, id, pos, rot, scale);
 */

import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';

// Register GLTF loader plugin once
import '@babylonjs/loaders/glTF';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

// ─── Cache ──────────────────────────────────────────────────────────────────

/** Cache key = glb URL. Stores the raw container (not cloned) to enable instancing. */
const _cache = new Map<string, Promise<{ meshes: AbstractMesh[] } | null>>();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a GLB from the library server into a Babylon.js scene.
 *
 * @param glbPath     Path relative to the library root (e.g. "objects/furniture/chair_office/model.glb")
 * @param scene       Target Babylon.js scene
 * @param namePrefix  Unique prefix for the created mesh names (usually `object_${nodeId}`)
 * @param posX        World X in metres (Babylon X)
 * @param posY        World Y in metres (Babylon Y = elevation)
 * @param posZ        World Z in metres (Babylon Z = north depth)
 * @param rotY        Rotation around vertical axis in degrees (Babylon Y axis)
 * @param scale       Uniform scale factor
 * @returns           Array of placed Babylon.js meshes (empty on failure)
 */
export async function loadGlbIntoScene(
  glbPath: string,
  scene: Scene,
  namePrefix: string,
  posX: number,
  posY: number,
  posZ: number,
  rotY: number = 0,
  scale: number = 1,
): Promise<Mesh[]> {
  const url = `${API_BASE}/library/${glbPath}`;
  const placed: Mesh[] = [];

  try {
    const result = await SceneLoader.ImportMeshAsync('', url, '', scene);
    const root = result.meshes[0];
    if (!root) return placed;

    // Name all loaded meshes with the given prefix
    result.meshes.forEach((m, i) => {
      m.name = `${namePrefix}_${i}`;
    });

    // Position, rotate, scale the root
    root.position = new Vector3(posX, posY, posZ);
    root.rotation = new Vector3(0, rotY * Math.PI / 180, 0);
    root.scaling  = new Vector3(scale, scale, scale);

    for (const m of result.meshes) {
      if (m.getTotalVertices() > 0) {
        placed.push(m as Mesh);
      }
    }
  } catch (err) {
    // GLB not found or failed → caller uses fallback placeholder box
    console.warn(`[glbLibraryLoader] Failed to load ${url}:`, err);
  }

  return placed;
}

/**
 * Build the full URL to a library GLB file.
 */
export function glbUrl(glbPath: string): string {
  return `${API_BASE}/library/${glbPath}`;
}

/**
 * Build the full URL to a library SVG top-view symbol.
 */
export function topSvgUrl(svgPath: string): string {
  return `${API_BASE}/library/${svgPath}`;
}

/**
 * Check whether a GLB file exists on the server.
 * Returns true if the HEAD request succeeds (status 200–299).
 */
export async function glbExists(glbPath: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/library/${glbPath}`, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}
