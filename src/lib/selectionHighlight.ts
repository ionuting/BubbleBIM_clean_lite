/**
 * selectionHighlight.ts — the gold tint that marks the selected element in 3D.
 *
 * Tinting is easy; putting the material back is where it went wrong. Each
 * viewer set the tint in two places — once when the selection changes, and
 * again after a geometry rebuild re-creates the meshes — but only the first
 * saved what the material looked like beforehand. A mesh tinted by the rebuild
 * path therefore had nothing to restore from, so deselecting silently did
 * nothing and the element stayed gold until the next full rebuild.
 *
 * Keeping set and clear in one function makes that particular divergence
 * impossible: you cannot apply the tint without recording the original.
 */
import * as THREE from 'three';

/** Gold, and the emissive strength it is applied at. */
export const HIGHLIGHT_COLOR = 0xffd700;
export const HIGHLIGHT_INTENSITY = 0.6;

interface HighlightState {
  originalEmissive?: THREE.Color;
  originalEmissiveIntensity?: number;
}

/**
 * Turn the selection tint on or off for one mesh.
 *
 * Safe to call repeatedly with the same value: turning it on again keeps the
 * originally recorded material, and turning it off when it was never on does
 * nothing. Meshes with a material array, or with no emissive channel, are left
 * alone rather than half-tinted.
 */
export function setHighlight(mesh: THREE.Mesh, on: boolean): void {
  const mat = mesh.material as THREE.MeshStandardMaterial;
  if (!mat || Array.isArray(mat) || !mat.emissive) return;
  const state = mesh.userData as HighlightState;

  if (on) {
    if (!state.originalEmissive) {
      state.originalEmissive = mat.emissive.clone();
      state.originalEmissiveIntensity = mat.emissiveIntensity ?? 0;
    }
    mat.emissive.set(HIGHLIGHT_COLOR);
    mat.emissiveIntensity = HIGHLIGHT_INTENSITY;
    return;
  }

  if (!state.originalEmissive) return;
  mat.emissive.copy(state.originalEmissive);
  mat.emissiveIntensity = state.originalEmissiveIntensity ?? 0;
  delete state.originalEmissive;
  delete state.originalEmissiveIntensity;
}

/**
 * Apply the selection across a whole scene in one pass: every mesh carrying
 * `nodeId` is tinted, every other mesh is cleared.
 */
export function applySelectionHighlight(scene: THREE.Object3D, nodeId: string | null | undefined): void {
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      setHighlight(obj, Boolean(nodeId) && obj.userData.nodeId === nodeId);
    }
  });
}
