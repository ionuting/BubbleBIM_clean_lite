/**
 * Selection priority: a wall, beam or column behind a room's translucent volume
 * must win the click, without making rooms themselves unselectable.
 *
 * The geometry mirrors the real cause — room solids are extruded along the wall
 * centrelines, so they overlap the inner half of every wall, enclose columns
 * standing on the grid, and sit between the camera and the structure.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { pickNodeId } from './pickSelection';

/** A tagged box, exactly how `ogBimMapper.tag()` marks meshes. */
function box(
  nodeId: string, nodeType: string,
  size: [number, number, number], pos: [number, number, number],
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial());
  m.position.set(...pos);
  m.userData.nodeId = nodeId;
  m.userData.nodeType = nodeType;
  m.updateMatrixWorld(true);
  return m;
}

/** Ray fired along −Z from z=+10 — "looking at" the given x/y. */
function rayAt(x = 0, y = 0): THREE.Raycaster {
  return new THREE.Raycaster(new THREE.Vector3(x, y, 10), new THREE.Vector3(0, 0, -1));
}

function sceneOf(...objs: THREE.Object3D[]): THREE.Scene {
  const s = new THREE.Scene();
  for (const o of objs) s.add(o);
  s.updateMatrixWorld(true);
  return s;
}

/** Room box the ray always enters first — the thing that used to eat the click. */
const room = () => box('room-1', 'room', [8, 8, 2.65], [0, 0, 0]);

describe('structure behind a room wins the click', () => {
  it.each(['wall', 'beam', 'column'])('picks a %s beyond the room surface', (type) => {
    const el = box(`${type}-1`, type, [1, 1, 0.4], [0, 0, -3]);
    expect(pickNodeId(rayAt(), sceneOf(room(), el))).toBe(`${type}-1`);
  });

  it('picks a column fully enclosed by the room volume', () => {
    const col = box('col-1', 'column', [0.4, 0.4, 3], [0, 0, 0]);
    expect(pickNodeId(rayAt(), sceneOf(room(), col))).toBe('col-1');
  });

  it('does not depend on the order meshes were added to the scene', () => {
    const wall = box('wall-1', 'wall', [8, 3, 0.3], [0, 0, -3]);
    expect(pickNodeId(rayAt(), sceneOf(wall, room()))).toBe('wall-1');
    expect(pickNodeId(rayAt(), sceneOf(room(), wall))).toBe('wall-1');
  });

  it('takes the NEAREST structure when several lie beyond the room', () => {
    const near = box('wall-near', 'wall', [8, 3, 0.3], [0, 0, -3]);
    const far = box('wall-far', 'wall', [8, 3, 0.3], [0, 0, -6]);
    expect(pickNodeId(rayAt(), sceneOf(room(), far, near))).toBe('wall-near');
  });

  it('resolves the id from a tagged ancestor, not just the hit mesh', () => {
    const group = new THREE.Group();
    group.userData.nodeId = 'wall-9';
    group.userData.nodeType = 'wall';
    const child = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.3), new THREE.MeshBasicMaterial());
    child.position.set(0, 0, -3);
    group.add(child);
    expect(pickNodeId(rayAt(), sceneOf(room(), group))).toBe('wall-9');
  });
});

describe('rooms stay selectable', () => {
  it('picks the room when nothing else is under the cursor', () => {
    expect(pickNodeId(rayAt(), sceneOf(room()))).toBe('room-1');
  });

  it('picks the room over its own floor slab — the normal way to click a room', () => {
    // Clicking the open floor area: the ray meets no structure, only the slab.
    const slab = box('slab-1', 'slab', [8, 8, 0.2], [0, 0, -2]);
    expect(pickNodeId(rayAt(), sceneOf(room(), slab))).toBe('room-1');
  });

  it('picks the room over a roof or covering beyond it', () => {
    const covering = box('cov-1', 'covering', [8, 8, 0.1], [0, 0, -3]);
    expect(pickNodeId(rayAt(), sceneOf(room(), covering))).toBe('room-1');
  });

  it('ignores structure hidden by the visibility filter', () => {
    const wall = box('wall-1', 'wall', [8, 3, 0.3], [0, 0, -3]);
    wall.visible = false;
    expect(pickNodeId(rayAt(), sceneOf(room(), wall))).toBe('room-1');

    const group = new THREE.Group();
    group.visible = false;
    group.add(box('wall-2', 'wall', [8, 3, 0.3], [0, 0, -3]));
    expect(pickNodeId(rayAt(), sceneOf(room(), group))).toBe('room-1');
  });
});

describe('everything that is not a room keeps plain nearest-first picking', () => {
  it('returns null for empty space', () => {
    expect(pickNodeId(rayAt(), sceneOf())).toBeNull();
  });

  it('picks the nearer of two walls', () => {
    const near = box('wall-near', 'wall', [4, 4, 0.3], [0, 0, 0]);
    const far = box('wall-far', 'wall', [4, 4, 0.3], [0, 0, -0.3]);
    expect(pickNodeId(rayAt(), sceneOf(near, far))).toBe('wall-near');
  });

  it('a slab in front is NOT overridden by a wall behind it', () => {
    // The rule only fires when the nearest hit is a room; this must not regress.
    const slab = box('slab-1', 'slab', [8, 8, 0.2], [0, 0, 0]);
    const wall = box('wall-1', 'wall', [8, 3, 0.3], [0, 0, -3]);
    expect(pickNodeId(rayAt(), sceneOf(slab, wall))).toBe('slab-1');
  });

  it('a window in front is NOT overridden by the wall behind it', () => {
    const win = box('win-1', 'window', [1, 1, 0.05], [0, 0, 0]);
    const wall = box('wall-1', 'wall', [8, 3, 0.3], [0, 0, -1]);
    expect(pickNodeId(rayAt(), sceneOf(win, wall))).toBe('win-1');
  });

  it('skips untagged geometry such as grid and axis helpers', () => {
    const helper = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 0.01), new THREE.MeshBasicMaterial());
    helper.position.set(0, 0, 5); // nearest of all, but carries no nodeId
    helper.updateMatrixWorld(true);
    expect(pickNodeId(rayAt(), sceneOf(helper, room()))).toBe('room-1');
  });
});
