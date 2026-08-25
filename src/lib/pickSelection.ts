/**
 * Click-picking for the 3D viewers, with structure winning over rooms.
 *
 * Rooms are extruded from `calcRoomPolygon`, which runs along the wall
 * CENTRELINES (the ax/column grid), not the inner faces. A room solid therefore
 * overlaps the inner half of every wall around it, encloses any column standing
 * on those grid points, and puts a large translucent box between the camera and
 * the structure. Picking the nearest hit hands those clicks to the room, and the
 * wall, beam or column being pointed at cannot be reached at all.
 *
 * The rule here is deliberately narrow: it only changes what happens when the
 * NEAREST hit is a room. In that one case a wall, beam or column further along
 * the ray takes the click. Everything else — slab over covering, the nearer of
 * two walls, roofs, furniture — keeps plain nearest-first ordering, so this
 * cannot regress picking anywhere else.
 *
 * Rooms stay selectable because the natural way to click one is over its open
 * floor area, where the ray runs down through the room to the slab and meets no
 * structure at all. What it gives up is clicking a room *through* a spot with a
 * wall beyond it — which is the very case the user wanted to hit the wall.
 */
import * as THREE from 'three';

/** Types describing SPACE rather than something built. */
const ZONE_TYPES = new Set(['room']);

/** Structure that should be reachable through a room's translucent volume. */
const STRUCTURE_TYPES = new Set(['wall', 'beam', 'column']);

interface Candidate {
  nodeId: string;
  nodeType: string;
}

/** Pickable only if the object and every ancestor are visible. */
function isVisible(obj: THREE.Object3D): boolean {
  let o: THREE.Object3D | null = obj;
  while (o) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return true;
}

/** Nearest ancestor (or self) carrying a `nodeId`, with its `nodeType`. */
function owner(obj: THREE.Object3D): Candidate | null {
  let o: THREE.Object3D | null = obj;
  while (o) {
    const id = o.userData.nodeId as string | undefined;
    if (id) return { nodeId: id, nodeType: String(o.userData.nodeType ?? '') };
    o = o.parent;
  }
  return null;
}

/**
 * The node the user meant to click, or null for empty space.
 * `raycaster` must already be aimed (e.g. via `setFromCamera`).
 */
export function pickNodeId(raycaster: THREE.Raycaster, scene: THREE.Scene): string | null {
  // Hits arrive sorted by distance, so the first accepted one is the nearest.
  const candidates: Candidate[] = [];
  for (const hit of raycaster.intersectObjects(scene.children, true)) {
    if (!isVisible(hit.object)) continue;
    const own = owner(hit.object);
    if (own) candidates.push(own);
  }
  if (candidates.length === 0) return null;

  const nearest = candidates[0];
  if (!ZONE_TYPES.has(nearest.nodeType)) return nearest.nodeId;

  const structure = candidates.find((c) => STRUCTURE_TYPES.has(c.nodeType));
  return (structure ?? nearest).nodeId;
}
