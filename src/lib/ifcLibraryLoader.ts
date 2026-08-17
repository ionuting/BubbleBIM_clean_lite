/**
 * ifcLibraryLoader.ts — Load .frag library elements using @thatopen/fragments.
 *
 * Replaces the old web-ifc StreamAllMeshes approach.
 * Fetches .frag files from the backend (same sub-path as .ifc but with .frag extension).
 * Uses SingleThreadedFragmentsModel to extract geometry as Three.js BufferGeometry.
 *
 * Coordinate system: fragments IfcImporter normalises to Three.js Y-up space (metres).
 *   X = East, Y = Up, Z = depth
 * buildIfcGroup uses coordinates as-is — NO axis swap required.
 */

import { SingleThreadedFragmentsModel } from '@thatopen/fragments';
import * as THREE from 'three';
import { WINDOW_TYPE_MAP, DOOR_TYPE_MAP } from './elementLibrary';

// ─── Config ───────────────────────────────────────────────────────────────────

const BACKEND_URL = (import.meta.env.VITE_API_URL as string || 'http://localhost:8000/api').replace(/\/api$/, '');

// ─── Typed data for a single mesh part ───────────────────────────────────────

export interface IFCGeomPart {
  /** Three.js geometry: positions.xyz (Y-up, metres), normals.xyz — already in world space */
  geometry: THREE.BufferGeometry;
  /** Diffuse color (0–1) */
  color: THREE.Color;
  /** Opacity (0–1) */
  opacity: number;
}

// ─── Geometry cache (library_path → parts) ───────────────────────────────────

const _partsCache = new Map<string, IFCGeomPart[]>();

/**
 * Load a .frag library file from the backend and extract all mesh parts
 * as Three.js BufferGeometry objects in world coordinates (metres, Y-up).
 *
 * The libraryPath is the .ifc path from elementLibrary — we swap the extension
 * to .frag automatically. Results are cached by libraryPath.
 */
export async function loadIfcParts(libraryPath: string): Promise<IFCGeomPart[]> {
  if (_partsCache.has(libraryPath)) return _partsCache.get(libraryPath)!;

  const url = `${BACKEND_URL}/library/${libraryPath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Frag fetch failed (${resp.status}) for: ${libraryPath}`);
  const buffer = new Uint8Array(await resp.arrayBuffer());

  const modelId = libraryPath.replace(/[^a-z0-9]/gi, '_');
  const model = new SingleThreadedFragmentsModel(modelId, buffer);

  const localIds = model.getItemsWithGeometry();
  if (!localIds.length) {
    model.dispose();
    _partsCache.set(libraryPath, []);
    return [];
  }

  // Geometry per item — outer array is per localId, inner is per sample/instance
  const meshDataPerItem = await model.getItemsGeometry(localIds);

  // Samples map: sampleId → { material: materialId, ... }
  const samplesMap = await model.getSamples();

  // Materials map: materialId → { r, g, b, a (0–255) }
  const materialsMap = await model.getMaterials();

  const parts: IFCGeomPart[] = [];
  const tmpV = new THREE.Vector3();
  const tmpN = new THREE.Vector3();

  for (const itemMeshes of meshDataPerItem) {
    for (const md of itemMeshes) {
      if (!md.positions || !md.indices) continue;

      const srcPos = md.positions;
      const count  = srcPos.length / 3;

      // Positions: apply MeshData.transform to get world-space coordinates
      const worldPos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        tmpV.set(srcPos[i * 3], srcPos[i * 3 + 1], srcPos[i * 3 + 2]);
        tmpV.applyMatrix4(md.transform);
        worldPos[i * 3]     = tmpV.x;
        worldPos[i * 3 + 1] = tmpV.y;
        worldPos[i * 3 + 2] = tmpV.z;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(worldPos, 3));

      // Normals: Int16 normalised (÷32767) → apply normal matrix
      if (md.normals) {
        const srcNrm     = md.normals;
        const worldNrm   = new Float32Array(count * 3);
        const normalMat  = new THREE.Matrix3().getNormalMatrix(md.transform);
        for (let i = 0; i < count; i++) {
          tmpN.set(
            srcNrm[i * 3]     / 32767,
            srcNrm[i * 3 + 1] / 32767,
            srcNrm[i * 3 + 2] / 32767,
          );
          tmpN.applyMatrix3(normalMat).normalize();
          worldNrm[i * 3]     = tmpN.x;
          worldNrm[i * 3 + 1] = tmpN.y;
          worldNrm[i * 3 + 2] = tmpN.z;
        }
        geo.setAttribute('normal', new THREE.BufferAttribute(worldNrm, 3));
      }

      // Indices: promote to Uint32Array regardless of source type
      const idx = md.indices;
      geo.setIndex(new THREE.BufferAttribute(
        idx instanceof Uint32Array ? idx : new Uint32Array(idx),
        1,
      ));

      // Material: sampleId → RawSample.material → RawMaterial { r,g,b,a (0-255) }
      let color   = new THREE.Color(0.75, 0.75, 0.75);
      let opacity = 1.0;
      if (md.sampleId != null) {
        const sample = samplesMap.get(md.sampleId);
        if (sample != null) {
          const mat = materialsMap.get(sample.material);
          if (mat) {
            color   = new THREE.Color(mat.r / 255, mat.g / 255, mat.b / 255);
            opacity = mat.a / 255;
          }
        }
      }

      parts.push({ geometry: geo, color, opacity });
    }
  }

  model.dispose();
  _partsCache.set(libraryPath, parts);
  return parts;
}

// ─── Build a centred Three.js Group from IFC parts ───────────────────────────

export interface IFCGroupInfo {
  /** Three.js group containing all mesh parts, centred at bottom-centre. */
  group: THREE.Group;
  /** Width in metres (horizontal span of bounding box). */
  widthM: number;
  /** Height in metres (vertical span of bounding box). */
  heightM: number;
  /** Depth in metres (through-wall thickness). */
  depthM: number;
}

/**
 * Convert IFC parts to a centred Three.js Group ready to be positioned
 * at a wall opening.
 *
 * web-ifc@0.0.77 outputs geometry via flatTransformation already in
 * Three.js / OpenGL Y-up convention (X=East, Y=Up, Z=depth).
 * No axis swap is needed — use coordinates as-is.
 *
 * Group origin after centring:
 *   Local X   = 0 at horizontal centre of window (width axis)
 *   Local Y   = 0 at BOTTOM of window (sill level — caller adds sill offset)
 *   Local Z   = 0 at depth centre (middle of wall thickness)
 */
export function buildIfcGroup(parts: IFCGeomPart[]): IFCGroupInfo {
  // 1. Bounding box — web-ifc already outputs in Y-up: X=width, Y=height, Z=depth
  let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const part of parts) {
    const pos = part.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }

  // Centre: X and Z at midpoint; Y at bottom (Y=0 → sill level)
  const cX = (minX + maxX) / 2;
  const cY = minY;                   // bottom of element → group local Y=0
  const cZ = (minZ + maxZ) / 2;

  const widthM  = maxX - minX;   // horizontal width along wall face
  const heightM = maxY - minY;   // vertical height of element
  const depthM  = maxZ - minZ;   // through-wall depth

  // 2. Build group — no axis swap; just re-centre
  const group = new THREE.Group();

  for (const part of parts) {
    const srcPos = part.geometry.getAttribute('position') as THREE.BufferAttribute;
    const srcNrm = part.geometry.getAttribute('normal')   as THREE.BufferAttribute;
    const count  = srcPos.count;

    const newPos = new Float32Array(count * 3);
    const newNrm = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      newPos[i * 3]     = srcPos.getX(i) - cX;
      newPos[i * 3 + 1] = srcPos.getY(i) - cY;
      newPos[i * 3 + 2] = srcPos.getZ(i) - cZ;

      newNrm[i * 3]     = srcNrm.getX(i);
      newNrm[i * 3 + 1] = srcNrm.getY(i);
      newNrm[i * 3 + 2] = srcNrm.getZ(i);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
    geom.setAttribute('normal',   new THREE.BufferAttribute(newNrm, 3));
    geom.setIndex(part.geometry.getIndex()!.clone());

    const mat = new THREE.MeshStandardMaterial({
      color:       part.color,
      transparent: part.opacity < 0.99,
      opacity:     part.opacity,
      side:        THREE.DoubleSide,
    });

    group.add(new THREE.Mesh(geom, mat));
  }

  return { group, widthM, heightM, depthM };
}

/**
 * Place a centred IFC group at a wall opening.
 *   cx, cy, cz — Three.js world position: cx/cz = plan centre, cy = BOTTOM of opening (sill level)
 *   nx, nz     — wall normal unit vector in Three.js XZ plane (points outward from wall)
 *   oW, oH     — wall opening size in metres (used for reference; IFC placed at native scale)
 *
 * The IFC group is placed at its NATIVE scale (1:1) — no stretch-to-fit.
 * The library entry dimensions (oW, oH) should match the IFC model's actual geometry.
 * Using native scale preserves the correct profile proportions of the element.
 */
export function positionIfcGroup(
  info: IFCGroupInfo,
  cx: number, cy: number, cz: number,
  nx: number, nz: number,
  _oW: number, _oH: number,
): THREE.Group {
  const placed = info.group.clone();

  // Native scale — no stretching. The IFC model's own dimensions are correct.
  // Non-uniform XY scale with Z=1 distorts profile thickness; avoid it entirely.
  placed.scale.set(1, 1, 1);

  // Align local +X with wall tangent: tangent = (nz, -nx) from normal (nx, nz).
  // Using spanBox convention atan2(dz, dx): atan2(-nx, nz) = atan2(wuz, wux) ✓
  placed.rotation.y = Math.atan2(-nx, nz);

  // cy = BOTTOM of opening (group local Y=0 = bottom after centring in buildIfcGroup)
  placed.position.set(cx, cy, cz);

  return placed;
}

// ─── Convenience: collect IFC library_paths needed for a node list ───────────

/**
 * Resolve the IFC file path for a window or door node using the explicit
 * `ifc_path` field from the library entry.
 * Returns null when ifc_path is null → callers should use procedural geometry.
 */
export function resolveIfcPath(nodeType: string, typeId: string): string | null {
  if (!typeId) return null;
  if (nodeType === 'window') return WINDOW_TYPE_MAP.get(typeId)?.ifc_path ?? null;
  if (nodeType === 'door')   return DOOR_TYPE_MAP.get(typeId)?.ifc_path ?? null;
  return null;
}

/** @deprecated Use resolveIfcPath(nodeType, typeId) instead. */
export function resolveWindowIfcPath(windowType: string): string | null {
  return resolveIfcPath('window', windowType);
}

export function collectIfcLibraryPaths(nodes: { type: string; properties: Record<string, unknown> }[]): string[] {
  const paths = new Set<string>();
  for (const n of nodes) {
    if (n.type !== 'window' && n.type !== 'door') continue;
    const typeId = String(
      n.type === 'window' ? (n.properties.window_type ?? '') : (n.properties.door_type ?? ''),
    );
    const ifcPath = resolveIfcPath(n.type, typeId);
    if (ifcPath) paths.add(ifcPath);
  }
  return [...paths];
}
