/**
 * The bug worth pinning: a mesh tinted by the post-rebuild path could never be
 * un-tinted, because only the selection-change path recorded the original
 * material. Selecting a roof, changing one of its properties (which rebuilds
 * the scene), then deselecting left it gold for good.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  HIGHLIGHT_COLOR,
  applySelectionHighlight,
  setHighlight,
} from './selectionHighlight';

function mesh(nodeId: string, emissive = 0x000000): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ emissive, emissiveIntensity: 0.25 }),
  );
  m.userData.nodeId = nodeId;
  return m;
}

const emissiveOf = (m: THREE.Mesh) => (m.material as THREE.MeshStandardMaterial).emissive.getHex();
const intensityOf = (m: THREE.Mesh) => (m.material as THREE.MeshStandardMaterial).emissiveIntensity;

describe('setHighlight', () => {
  it('restores a mesh that was tinted directly, not via a selection change', () => {
    // Exactly what the rebuild path does.
    const m = mesh('roof1', 0x112233);
    setHighlight(m, true);
    expect(emissiveOf(m)).toBe(HIGHLIGHT_COLOR);

    setHighlight(m, false);
    expect(emissiveOf(m)).toBe(0x112233);
    expect(intensityOf(m)).toBe(0.25);
  });

  it('keeps the first recorded original when tinted repeatedly', () => {
    const m = mesh('roof1', 0x445566);
    setHighlight(m, true);
    setHighlight(m, true); // a rebuild while already selected
    setHighlight(m, true);
    setHighlight(m, false);
    expect(emissiveOf(m)).toBe(0x445566);
  });

  it('does nothing when clearing a mesh that was never tinted', () => {
    const m = mesh('wall1', 0x778899);
    setHighlight(m, false);
    expect(emissiveOf(m)).toBe(0x778899);
    expect(intensityOf(m)).toBe(0.25);
  });

  it('leaves multi-material meshes alone rather than half-tinting them', () => {
    const m = mesh('slab1');
    m.material = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    expect(() => setHighlight(m, true)).not.toThrow();
    expect((m.material as THREE.MeshStandardMaterial[])[0].emissive.getHex()).toBe(0);
  });
});

describe('applySelectionHighlight', () => {
  it('tints every mesh of the selected node and clears all others', () => {
    const scene = new THREE.Scene();
    // A roof is many meshes sharing one nodeId — all must follow the selection.
    const roofA = mesh('roof1', 0x101010);
    const roofB = mesh('roof1', 0x101010);
    const wall = mesh('wall1', 0x202020);
    scene.add(roofA, roofB, wall);

    applySelectionHighlight(scene, 'roof1');
    expect(emissiveOf(roofA)).toBe(HIGHLIGHT_COLOR);
    expect(emissiveOf(roofB)).toBe(HIGHLIGHT_COLOR);
    expect(emissiveOf(wall)).toBe(0x202020);

    applySelectionHighlight(scene, null);
    expect(emissiveOf(roofA)).toBe(0x101010);
    expect(emissiveOf(roofB)).toBe(0x101010);
  });

  it('clears the previous selection when a different node is picked', () => {
    const scene = new THREE.Scene();
    const roof = mesh('roof1', 0x101010);
    const wall = mesh('wall1', 0x202020);
    scene.add(roof, wall);

    applySelectionHighlight(scene, 'roof1');
    applySelectionHighlight(scene, 'wall1');
    expect(emissiveOf(roof)).toBe(0x101010);
    expect(emissiveOf(wall)).toBe(HIGHLIGHT_COLOR);
  });

  it('survives the rebuild sequence that caused the stuck tint', () => {
    // select → rebuild (new meshes, tinted directly) → deselect
    const scene = new THREE.Scene();
    const before = mesh('roof1', 0x303030);
    scene.add(before);
    applySelectionHighlight(scene, 'roof1');

    scene.remove(before);
    const rebuilt = mesh('roof1', 0x303030);
    scene.add(rebuilt);
    setHighlight(rebuilt, true); // what the rebuild path does

    applySelectionHighlight(scene, null);
    expect(emissiveOf(rebuilt)).toBe(0x303030);
  });
});
