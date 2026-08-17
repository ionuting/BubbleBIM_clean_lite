/**
 * BabylonViewer — custom BIM geometry parser + Babylon.js 3D viewer.
 *
 * Coordinate system (BIM standard — matches Revit / Blender / ArchiCAD):
 *
 *   BIM model  →  Babylon.js scene (Y-up)
 *   ─────────────────────────────────────
 *   X (East)   →  Babylon X   (unchanged)
 *   Y (North)  →  Babylon Z   (plan north = scene depth)
 *   Z (Up/Elev)→  Babylon Y   (elevation  = scene up)
 *
 * All node coordinates are in mm; Babylon scene uses meters (× 0.001).
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { AxisInteraxOverlay, type Pt2D } from './AxisInteraxOverlay';
import { VisibilityFilter } from '@/components/views/VisibilityFilter';
import {
  Engine,
  Scene,
  ArcRotateCamera,
  HemisphericLight,
  DirectionalLight,
  Vector3,
  Matrix,
  Color3,
  Color4,
  MeshBuilder,
  StandardMaterial,
  Mesh,
  LinesMesh,
  CreateLineSystem,
  VertexData,
  SceneLoader,
} from '@babylonjs/core';
import * as THREE from 'three';
import { cn, parseAxes } from '@/lib/utils';
import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes } from '@/store';
import { useBubbleGraphStore } from '@/store';
import {
  MM, NODE_COLOR,
  parseColumnDims, parseBeamDims, parseWallThickness, getNodeSlabThickness,
  getStoreyBand, getAxRealPos, getNodeBimPos, getConnectedNodes,
  getGripBimPos, getConnectedNodesWithGrips,
  collectOpenings, calcRoomPolygon, isWallSeparator,
  getNodeLocalTransform, calcSpanEffectiveEnds,
  resolveStoreyId,
  type OpeningInfo,
} from '@/lib/bimGeometry';
import { WINDOW_TYPES } from '@/lib/elementLibrary';
import {
  loadIfcParts, buildIfcGroup,
  collectIfcLibraryPaths, resolveIfcPath,
  type IFCGroupInfo,
} from '@/lib/ifcLibraryLoader';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { resolveVisuals, applyNodeColorOverrides, hexToRgb01, type MaterialVisuals, type MaterialConfig } from '@/lib/materialConfig';
import { loadGlbIntoScene } from '@/lib/glbLibraryLoader';

// ─── Three.js BufferGeometry → Babylon.js VertexData ─────────────────────────
/**
 * Convert a Three.js BufferGeometry to Babylon.js VertexData so IFC library
 * meshes (produced by web-ifc + Three.js) can be rendered in Babylon.
 *
 * Three.js coord system used here: X=East, Y=Up, Z=North (BIM convention,
 * same as Babylon Y-up: X→X, Y→Y, Z→Z).
 */
function threeGeomToBabylon(geom: THREE.BufferGeometry, scene: Scene): Mesh {
  const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
  const nrmAttr = geom.getAttribute('normal')   as THREE.BufferAttribute | undefined;
  const idxAttr = geom.getIndex();

  const positions = Array.from(posAttr.array as Float32Array);
  const normals   = nrmAttr ? Array.from(nrmAttr.array as Float32Array) : undefined;
  const indices   = idxAttr ? Array.from(idxAttr.array as Uint32Array)  : undefined;

  const vd = new VertexData();
  vd.positions = positions;
  if (normals)  vd.normals  = normals;
  if (indices)  vd.indices  = indices;

  const mesh = new Mesh('ifc_part', scene);
  vd.applyToMesh(mesh);
  return mesh;
}

/**
 * Build Babylon.js meshes from an IFCGroupInfo (Three.js group) and
 * place them at the given opening position/orientation in the Babylon scene.
 *
 * Three.js and Babylon both use Y-up with X=East, Y=Up, Z=North/Depth,
 * so no axis conversion is needed — just copy positions/scales/rotations.
 */
function buildIfcBabylonMeshes(
  info: IFCGroupInfo,
  cx: number, cy: number, cz: number, // Babylon metres, centre of opening
  nx: number, nz: number,             // wall normal in Babylon XZ
  oW: number, oH: number,             // opening size in metres
  scene: Scene,
): Mesh[] {
  const meshes: Mesh[] = [];
  const rotY = Math.atan2(-nx, nz); // aligns local +X with wall tangent (= spanBox convention)

  // Scale factors to fit the IFC geometry into the target opening
  const scaleX = oW / (info.widthM  || 1);
  const scaleY = oH / (info.heightM || 1);

  for (const child of info.group.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    const m = threeGeomToBabylon(child.geometry as THREE.BufferGeometry, scene);
    m.position  = new Vector3(cx, cy, cz);
    m.rotation.y = rotY;
    m.scaling   = new Vector3(scaleX, scaleY, 1);

    const threeMat = child.material as THREE.MeshStandardMaterial;
    const mat = new StandardMaterial(`ifc_mat_${m.uniqueId}`, scene);
    mat.diffuseColor  = new Color3(
      threeMat.color.r, threeMat.color.g, threeMat.color.b,
    );
    mat.alpha         = threeMat.opacity;
    mat.backFaceCulling = false;
    m.material = mat;
    meshes.push(m);
  }
  return meshes;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Apply a node's local transform (obj_translate_x/y/z mm, obj_rotate_x/y/z °)
 * to a Babylon.js Mesh.
 * BIM axes: tx=East→Babylon X, ty=North→Babylon Z, tz=Up→Babylon Y.
 */
function applyNodeLocalTransformBabylon(mesh: Mesh, t: { tx: number; ty: number; tz: number; rx: number; ry: number; rz: number }): void {
  const D2R = Math.PI / 180;
  if (t.tx || t.ty || t.tz) {
    mesh.position.x += t.tx * MM;
    mesh.position.y += t.tz * MM;   // BIM Z (Up) → Babylon Y
    mesh.position.z += t.ty * MM;   // BIM Y (North) → Babylon Z
  }
  if (t.rx || t.ry || t.rz) {
    mesh.rotation.x += t.rx * D2R;
    mesh.rotation.y += t.ry * D2R;
    mesh.rotation.z += t.rz * D2R;
  }
}

/**
 * Convert BIM (mm) coordinates to Babylon.js scene (meters).
 *   bx = BIM X (east), by = BIM Y (north), bz = BIM Z (elevation)
 */
function bim(bx: number, by: number, bz: number): Vector3 {
  return new Vector3(bx * MM, bz * MM, by * MM);
}

/**
 * Place a thin horizontal box between two plan points (spanBox-like) but
 * spanning only a sub-segment [tStart, tEnd] along the wall direction.
 *
 * wallAx,wallAz = Babylon XZ start of wall (meters)
 * wallBx,wallBz = Babylon XZ end   of wall (meters)
 * tStart, tEnd  = metres along wall (scalar progress, NOT 0-1 – these are actual metre offsets)
 */
function wallSegBox(
  name: string,
  wallAx: number, wallAz: number,
  wallBx: number, wallBz: number,
  tStart: number, tEnd: number,
  wallThick: number,
  segH: number, segBaseY: number,
  scene: Scene,
): Mesh {
  const dx = wallBx - wallAx, dz = wallBz - wallAz;
  const wallLen = Math.sqrt(dx * dx + dz * dz);
  if (wallLen < 1e-6 || tEnd - tStart < 1e-6) {
    const ph = MeshBuilder.CreateBox(name, { size: 0.001 }, scene);
    ph.position = new Vector3(wallAx, segBaseY, wallAz);
    return ph;
  }
  const ux = dx / wallLen, uz = dz / wallLen;
  const midT  = (tStart + tEnd) / 2;
  const segLen = tEnd - tStart;
  const mx = wallAx + ux * midT, mz = wallAz + uz * midT;
  const box = MeshBuilder.CreateBox(name, { width: segLen, height: segH, depth: wallThick }, scene);
  box.position  = new Vector3(mx, segBaseY + segH / 2, mz);
  box.rotation.y = Math.atan2(dz, dx);
  return box;
}

/**
 * Tessellate a circular-arc wall into N straight box segments.
 * ax/az, bx/bz = Babylon XZ start/end (metres).
 * arcRadiusM   = signed arc radius in metres (positive = centre left of A→B, negative = right).
 * Returns an array of segment {ax,az,bx,bz} pairs to be passed to wallSegBox/spanBox.
 */
function arcWallSegments(
  ax: number, az: number,
  bx: number, bz: number,
  arcRadiusM: number,
): Array<{ ax: number; az: number; bx: number; bz: number }> {
  const chord = Math.sqrt((bx - ax) ** 2 + (bz - az) ** 2);
  const R = Math.abs(arcRadiusM);
  // Clamp radius to at least half chord (otherwise no valid arc)
  const Rc = Math.max(R, chord / 2 + 1e-6);
  // Mid-point of chord
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  // Unit along chord
  const cx = (bx - ax) / chord, cz = (bz - az) / chord;
  // Perpendicular (left of chord direction)
  const px = -cz, pz = cx;
  // Distance from mid-point to arc centre
  const h = Math.sqrt(Rc * Rc - (chord / 2) ** 2);
  // Sign: positive radius → centre to the left
  const sign = arcRadiusM >= 0 ? 1 : -1;
  const ocx = mx + sign * h * px;
  const ocz = mz + sign * h * pz;

  // Angles from centre to A and B
  const angA = Math.atan2(az - ocz, ax - ocx);
  const angB = Math.atan2(bz - ocz, bx - ocx);

  // Choose arc direction: shorter arc unless radius is negative
  let dAng = angB - angA;
  // Normalise to [-π, π]
  while (dAng >  Math.PI) dAng -= 2 * Math.PI;
  while (dAng < -Math.PI) dAng += 2 * Math.PI;

  // Tessellation: ~1 segment per 15° of arc
  const N = Math.max(3, Math.ceil(Math.abs(dAng) / (Math.PI / 12)));
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= N; i++) {
    const a = angA + (dAng * i) / N;
    pts.push([ocx + Rc * Math.cos(a), ocz + Rc * Math.sin(a)]);
  }

  const segs: Array<{ ax: number; az: number; bx: number; bz: number }> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    segs.push({ ax: pts[i][0], az: pts[i][1], bx: pts[i + 1][0], bz: pts[i + 1][1] });
  }
  return segs;
}

/**
 * Build 3D meshes for a single opening (window or door) embedded in a wall.
 *
 * wallAx,wallAz : Babylon XZ start of wall (metres)
 * wallBx,wallBz : Babylon XZ end   of wall (metres)
 * wallThick     : wall thickness (metres)
 * botY          : Babylon Y of storey bottom (metres)
 * opening       : opening descriptor (all lengths in mm, converted internally)
 */
function buildOpeningMeshes(
  wallAx: number, wallAz: number,
  wallBx: number, wallBz: number,
  wallThick: number,
  botY: number,
  opening: OpeningInfo,
  scene: Scene,
  _matCache: Map<string, StandardMaterial>,
): Mesh[] {
  const meshes: Mesh[] = [];

  const dx = wallBx - wallAx, dz = wallBz - wallAz;
  const wallLenM = Math.sqrt(dx * dx + dz * dz);
  if (wallLenM < 1e-6) return [];
  const ux = dx / wallLenM, uz = dz / wallLenM;
  // Perpendicular (into-wall normal) — used to position glass/frame/void
  const nx = -uz, nz = ux;

  const tS  = opening.distFromStart * MM; // metres along wall — start of opening
  const oW  = opening.width  * MM;
  const oH  = opening.height * MM;
  const sill= opening.sillHeight * MM;
  const PROFILE = Math.min(0.06, wallThick * 0.25); // frame profile width (m), max 60mm
  const isDoor = opening.node.type === 'door';

  const openingCentreT = tS + oW / 2;
  const cx = wallAx + ux * openingCentreT;
  const cz = wallAz + uz * openingCentreT;

  // ── Frame profiles (toc) ─────────────────────────────────────────────────
  // 4 profiles: left jamb, right jamb, head (lintel), sill profile (windows only)
  const frameDepth = wallThick; // toc spans full wall thickness
  const frameY = botY + sill;

  const addFrameBox = (fName: string, fW: number, fH: number, fTx: number, fNx: number, fNz: number, fBaseY: number) => {
    // fTx = t-offset along wall from opening centre; fN = perpendicular offset
    const pos = new Vector3(
      cx + ux * fTx + nx * fNx,
      fBaseY + fH / 2,
      cz + uz * fTx + nz * fNz,
    );
    const box = MeshBuilder.CreateBox(fName, { width: fW, height: fH, depth: frameDepth }, scene);
    box.position  = pos;
    box.rotation.y = Math.atan2(dz, dx);
    const [r, g, b] = NODE_COLOR[opening.node.type] ?? [0.5, 0.5, 0.5];
    const mat = new StandardMaterial(fName + '_mat', scene);
    mat.diffuseColor  = new Color3(r * 0.6, g * 0.6, b * 0.6);
    mat.specularColor = new Color3(0.1, 0.1, 0.1);
    box.material = mat;
    meshes.push(box);
  };

  // Left jamb
  addFrameBox(`${opening.node.id}_jambL`, PROFILE, oH, -oW / 2 - PROFILE / 2, 0, 0, frameY);
  // Right jamb
  addFrameBox(`${opening.node.id}_jambR`, PROFILE, oH,  oW / 2 + PROFILE / 2, 0, 0, frameY);
  // Head (lintel profile)
  addFrameBox(`${opening.node.id}_head`,  oW + PROFILE * 2, PROFILE, 0, 0, 0, frameY + oH);
  // Sill profile (windows only)
  if (!isDoor) {
    addFrameBox(`${opening.node.id}_sillP`, oW + PROFILE * 2, PROFILE, 0, 0, 0, frameY - PROFILE);
  }

  // ── Glass / door panel ────────────────────────────────────────────────────
  const panelThick = isDoor ? 0.04 : 0.006;
  const panelH     = oH - PROFILE * (isDoor ? 1 : 2);
  const panelW     = oW - PROFILE * 2;
  const panelBaseY = frameY + (isDoor ? 0 : PROFILE);

  const panel = MeshBuilder.CreateBox(`${opening.node.id}_panel`, {
    width: panelW,
    height: panelH,
    depth: panelThick,
  }, scene);
  panel.position = new Vector3(cx, panelBaseY + panelH / 2, cz);
  panel.rotation.y = Math.atan2(dz, dx);

  if (isDoor) {
    const mat = new StandardMaterial(`${opening.node.id}_panelMat`, scene);
    mat.diffuseColor  = new Color3(0.72, 0.52, 0.24);
    mat.specularColor = new Color3(0.1, 0.1, 0.1);
    panel.material = mat;
  } else {
    const mat = new StandardMaterial(`${opening.node.id}_glassMat`, scene);
    mat.diffuseColor  = new Color3(0.22, 0.74, 0.97);
    mat.specularColor = new Color3(0.5, 0.7, 0.9);
    mat.alpha = 0.35;
    mat.backFaceCulling = false;
    panel.material = mat;
  }
  meshes.push(panel);

  // ── Fixed-window cross mullion (non-operable sash) ────────────────────────
  // Rendered when the window_type library entry has opening === 'none'.
  if (!isDoor) {
    const wt = String(opening.node.properties.window_type ?? '');
    const libEntry = WINDOW_TYPES.find((w) => w.id === wt);
    if (libEntry?.opening === 'none') {
      const MBAR = Math.min(0.04, panelW * 0.06); // mullion/transom bar width (m)
      const barMat = new StandardMaterial(`${opening.node.id}_mullionMat`, scene);
      barMat.diffuseColor  = new Color3(0.85, 0.87, 0.89);
      barMat.specularColor = new Color3(0.3, 0.3, 0.3);

      // Vertical centre mullion
      const vBar = MeshBuilder.CreateBox(`${opening.node.id}_mullion`, {
        width: MBAR, height: panelH, depth: panelThick * 1.5,
      }, scene);
      vBar.position  = new Vector3(cx, panelBaseY + panelH / 2, cz);
      vBar.rotation.y = Math.atan2(dz, dx);
      vBar.material  = barMat;
      meshes.push(vBar);

      // Horizontal centre transom
      const hBar = MeshBuilder.CreateBox(`${opening.node.id}_transom`, {
        width: panelW, height: MBAR, depth: panelThick * 1.5,
      }, scene);
      hBar.position  = new Vector3(cx, panelBaseY + panelH / 2, cz);
      hBar.rotation.y = Math.atan2(dz, dx);
      hBar.material  = barMat;
      meshes.push(hBar);
    }
  }

  // ── Void reveal (jamb depth visible on both sides) ────────────────────────
  // Two thin planes flush with each face of the wall, spanning the opening width
  const revealH = oH + (isDoor ? 0 : PROFILE * 2);
  const revealBaseY = isDoor ? botY + sill : frameY - PROFILE;
  for (let side = -1; side <= 1; side += 2) {
    const revName = `${opening.node.id}_reveal${side > 0 ? 'F' : 'B'}`;
    const reveal = MeshBuilder.CreateBox(revName, {
      width: oW,
      height: revealH,
      depth: 0.003,
    }, scene);
    reveal.position = new Vector3(
      cx + nx * side * wallThick / 2,
      revealBaseY + revealH / 2,
      cz + nz * side * wallThick / 2,
    );
    reveal.rotation.y = Math.atan2(dz, dx);
    const mat = new StandardMaterial(revName + '_mat', scene);
    mat.diffuseColor  = new Color3(0.94, 0.93, 0.90);
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;
    reveal.material = mat;
    meshes.push(reveal);
  }

  return meshes;
}

// ─── Babylon-specific helpers ─────────────────────────────────────────────────

function getMat(scene: Scene, cache: Map<string, StandardMaterial>, type: string, alpha = 1, visuals?: MaterialVisuals | null): StandardMaterial {
  const colorHex = visuals?.color_3d ?? null;
  const opacity  = visuals != null ? visuals.opacity_3d * alpha : alpha;
  const key = colorHex ? `custom:${colorHex}@${opacity}` : `${type}@${alpha}`;
  if (cache.has(key)) return cache.get(key)!;
  let r: number, g: number, b: number;
  if (colorHex) {
    [r, g, b] = hexToRgb01(colorHex);
  } else {
    [r, g, b] = NODE_COLOR[type] ?? [0.5, 0.5, 0.5];
  }
  const mat = new StandardMaterial(key, scene);
  mat.diffuseColor  = new Color3(r, g, b);
  mat.specularColor = new Color3(0.08, 0.08, 0.08);
  if (opacity < 1) { mat.alpha = opacity; mat.backFaceCulling = false; }
  cache.set(key, mat);
  return mat;
}

/**
 * Box mesh spanning between two PLAN points (in Babylon XZ) at a given
 * elevation (Babylon Y). width = cross-section, height = vertical size.
 *
 * ax,az  = Babylon X,Z of start point (already converted to meters)
 * bx,bz  = Babylon X,Z of end point
 */
function spanBox(
  name: string,
  ax: number, az: number, bx: number, bz: number,
  width: number, height: number, baseY: number,
  scene: Scene,
): Mesh {
  const dx = bx - ax, dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-4) {
    const ph = MeshBuilder.CreateBox(name, { size: 0.01 }, scene);
    ph.position = new Vector3(ax, baseY, az);
    return ph;
  }
  const box = MeshBuilder.CreateBox(name, { width: len, height, depth: width }, scene);
  box.position  = new Vector3((ax + bx) / 2, baseY + height / 2, (az + bz) / 2);
  // atan2(dz, dx): aligns local X axis (width/len) with the span direction (dx, dz) in Babylon XZ.
  box.rotation.y = Math.atan2(dz, dx);
  return box;
}

/**
 * Build all Babylon.js meshes from the node/edge graph.
 * Also builds storey floor planes and building grid axis lines.
 */
function buildGeometry(
  scene: Scene,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  ifcGroupCache: Map<string, IFCGroupInfo>,
  matConfig: MaterialConfig | null,
): Mesh[] {
  const nodeMap  = new Map(nodes.map((n) => [n.id, n]));
  const matCache = new Map<string, StandardMaterial>();
  const meshes: Mesh[] = [];

  const add = (mesh: Mesh, type: string, alpha = 1, node?: BubbleGraphNode, resolveAs?: string) => {
    const baseVis = node ? resolveVisuals(resolveAs ?? node.type, String(node.properties?.material ?? ''), matConfig) : null;
    const vis = (node && baseVis) ? applyNodeColorOverrides(baseVis, node.properties) : baseVis;
    mesh.material = getMat(scene, matCache, type, alpha, vis);
    if (node) {
      applyNodeLocalTransformBabylon(mesh, getNodeLocalTransform(node));
      mesh.metadata = { ...(mesh.metadata ?? {}), nodeId: node.id, nodeType: node.type, storeyId: resolveStoreyId(node, nodeMap) };
    }
    meshes.push(mesh);
  };

  // ── Storey floor planes (translucent) ─────────────────────────────────────
  const storeyNodes = nodes.filter((n) => n.type === 'storey');
  for (const s of storeyNodes) {
    const bot = Number(s.properties.bottomElevation ?? 0);
    const top = Number(s.properties.topElevation   ?? 3000);
    // Derive plan extents from children — use storey axesX/Y for ax nodes, node coords for others
    const children = nodes.filter((n) => n.parentId === s.id && n.type !== 'storey');
    const axesXS = parseAxes(s.properties.axesX);
    const axesYS = parseAxes(s.properties.axesY);
    const nonAx  = children.filter((c) => c.type !== 'ax');
    const allX = [...axesXS, ...nonAx.map((c) => c.x)];
    const allY = [...axesYS, ...nonAx.map((c) => c.y)];
    if (!allX.length) allX.push(0);
    if (!allY.length) allY.push(0);
    const pad  = 500; // 500 mm padding
    const minX = Math.min(...allX) - pad, maxX = Math.max(...allX) + pad;
    const minY = Math.min(...allY) - pad, maxY = Math.max(...allY) + pad;
    const planW = (maxX - minX) * MM || 10;
    const planD = (maxY - minY) * MM || 10;
    const cX    = ((minX + maxX) / 2) * MM;
    const cZ    = ((minY + maxY) / 2) * MM;

    // Bottom floor slab plane
    const floor = MeshBuilder.CreateGround(`floor_${s.id}`, { width: planW, height: planD }, scene);
    floor.position = new Vector3(cX, bot * MM, cZ);
    const floorMat = new StandardMaterial(`floorMat_${s.id}`, scene);
    floorMat.diffuseColor  = new Color3(0.22, 0.22, 0.30);
    floorMat.specularColor = Color3.Black();
    floorMat.alpha         = 0.35;
    floorMat.backFaceCulling = false;
    floor.material  = floorMat;
    floor.isPickable = false;
    floor.metadata   = { nodeType: 'storey', nodeId: s.id };
    meshes.push(floor);

    // Storey label (top elevation line as thin disc)
    const topLine = MeshBuilder.CreateGround(`top_${s.id}`, { width: planW, height: planD }, scene);
    topLine.position = new Vector3(cX, top * MM, cZ);
    const topMat = new StandardMaterial(`topMat_${s.id}`, scene);
    topMat.diffuseColor    = new Color3(0.28, 0.55, 0.85);
    topMat.specularColor   = Color3.Black();
    topMat.alpha           = 0.18;
    topMat.backFaceCulling = false;
    topLine.material  = topMat;
    topLine.isPickable = false;
    topLine.metadata   = { nodeType: 'storey', nodeId: s.id };
    meshes.push(topLine);
  }

  // ── Building grid axis lines ─────────────────────────────────────────────
  // Source of truth: each storey's axesX / axesY (absolute mm from origin).
  // Collect unique values across all storeys.
  const allBots = storeyNodes.map((s) => Number(s.properties.bottomElevation ?? 0));
  const allTops = storeyNodes.map((s) => Number(s.properties.topElevation   ?? 3000));
  const globalBot = allBots.length ? Math.min(...allBots) : 0;
  const globalTop = allTops.length ? Math.max(...allTops) : 3000;

  const allAxesX = new Set<number>();
  const allAxesY = new Set<number>();
  for (const s of storeyNodes) {
    parseAxes(s.properties.axesX).forEach((v) => allAxesX.add(v));
    parseAxes(s.properties.axesY).forEach((v) => allAxesY.add(v));
  }
  const uniqueX = [...allAxesX].sort((a, b) => a - b);
  const uniqueY = [...allAxesY].sort((a, b) => a - b);

  const pad = 1000; // mm overhang beyond outermost axes
  const gridMinX = uniqueX.length ? (uniqueX[0]  - pad) * MM : -5;
  const gridMaxX = uniqueX.length ? (uniqueX[uniqueX.length - 1] + pad) * MM :  5;
  const gridMinZ = uniqueY.length ? (uniqueY[0]  - pad) * MM : -5;
  const gridMaxZ = uniqueY.length ? (uniqueY[uniqueY.length - 1] + pad) * MM :  5;
  const gridElevY = globalBot * MM - 0.02; // just below ground level

  const axisLines: Vector3[][] = [];
  for (const xMm of uniqueX) {
    const bx = xMm * MM;
    axisLines.push([new Vector3(bx, gridElevY, gridMinZ), new Vector3(bx, gridElevY, gridMaxZ)]);
    axisLines.push([new Vector3(bx, globalBot * MM, gridMinZ), new Vector3(bx, globalTop * MM, gridMinZ)]);
  }
  for (const yMm of uniqueY) {
    const bz = yMm * MM;
    axisLines.push([new Vector3(gridMinX, gridElevY, bz), new Vector3(gridMaxX, gridElevY, bz)]);
    axisLines.push([new Vector3(gridMinX, globalBot * MM, bz), new Vector3(gridMinX, globalTop * MM, bz)]);
  }
  if (axisLines.length > 0) {
    const axLine = CreateLineSystem('gridAxes', { lines: axisLines }, scene) as unknown as Mesh;
    (axLine as LinesMesh).color = new Color3(0.28, 0.55, 0.85);
    (axLine as LinesMesh).alpha = 0.4;
    (axLine as LinesMesh).isPickable = false;
    meshes.push(axLine);
  }

  // ── Columns ───────────────────────────────────────────────────────────────
  for (const n of nodes.filter((n) => n.type === 'column')) {
    const { bot, top } = getStoreyBand(n, nodeMap);
    const h = (top - bot) * MM;
    const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
    const m = circular
      ? MeshBuilder.CreateCylinder(`col_${n.id}`, { diameter: w, height: h, tessellation: 18 }, scene)
      : MeshBuilder.CreateBox(`col_${n.id}`, { width: w, height: h, depth: d }, scene);
    m.position = bim(n.x, n.y, bot + (top - bot) / 2);
    add(m, 'column', 1, n);
  }

  // ── Ax markers — render as column when has_column === "True" ─────────────
  // Position derives from axesX[gridX] / axesY[gridY] of the parent storey.
  // node.x / node.y are graph-canvas positions and are ignored here.
  for (const n of nodes.filter((n) => n.type === 'ax')) {
    const { bot, top } = getStoreyBand(n, nodeMap);
    const { x: rx, y: ry } = getAxRealPos(n, nodeMap); // real BIM mm coords
    const hasCol = String(n.properties.has_column ?? '').toLowerCase() === 'true';

    if (hasCol) {
      const h = (top - bot) * MM;
      const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
      const m = circular
        ? MeshBuilder.CreateCylinder(`ax_col_${n.id}`, { diameter: w, height: h, tessellation: 18 }, scene)
        : MeshBuilder.CreateBox(`ax_col_${n.id}`, { width: w, height: h, depth: d }, scene);
      m.position = bim(rx, ry, bot + (top - bot) / 2);
      add(m, 'column', 1, n, 'column');
    } else {
      const m = MeshBuilder.CreateBox(`ax_${n.id}`, { width: 0.12, height: 0.04, depth: 0.12 }, scene);
      m.position = bim(rx, ry, bot);
      add(m, 'ax', 1, n);
    }
  }

  // ── Walls with openings ───────────────────────────────────────────────────
  // Each wall node is connected to two span-endpoint nodes (ax/column…) and
  // optionally to window/door nodes. Openings are cut analytically — the wall
  // is split into segments (sill, left/right of opening, lintel) instead of
  // using CSG boolean operations.
  for (const wn of nodes.filter((n) => n.type === 'wall')) {
    const endpointsRaw = getConnectedNodesWithGrips(wn.id, edges, nodeMap).filter(
      ({ node: n }) => n.type !== 'window' && n.type !== 'door',
    );
    if (endpointsRaw.length < 2) continue;
    const pts = endpointsRaw.map(({ node }) => node);
    const gripA = endpointsRaw[0].gripIdx;
    const gripB = endpointsRaw[1].gripIdx;
    const pA = gripA ? getGripBimPos(pts[0], gripA, nodeMap) : getNodeBimPos(pts[0], nodeMap);
    const pB = gripB ? getGripBimPos(pts[1], gripB, nodeMap) : getNodeBimPos(pts[1], nodeMap);
    const dx = pB.x - pA.x, dy = pB.y - pA.y;
    const wallLenMm = Math.sqrt(dx * dx + dy * dy);
    if (wallLenMm < 1) continue;

    const ux = dx / wallLenMm, uy = dy / wallLenMm;
    // camelCase (panel-written) takes priority over snake_case (nodeLibrary default)
    const osRaw = wn.properties.offsetStart ?? wn.properties.offset_start;
    const oeRaw = wn.properties.offsetEnd   ?? wn.properties.offset_end;
    const os = osRaw != null ? Number(osRaw) : 0;
    const oe = oeRaw != null ? Number(oeRaw) : 0;
    const sxMm = pA.x + ux * os, syMm = pA.y + uy * os;
    const exMm = pB.x - ux * oe, eyMm = pB.y - uy * oe;
    const effLen = wallLenMm - os - oe;

    const { bot, top } = getStoreyBand(wn, nodeMap);
    const wallH = Number(wn.properties.height ?? (top - bot));
    const th    = parseWallThickness(String(wn.properties.wall_type ?? 'W20'));
    const isSep = isWallSeparator(String(wn.properties.wall_type ?? ''));

    // Babylon metres
    const sxM = sxMm * MM, syM = syMm * MM;
    const exM = exMm * MM, eyM = eyMm * MM;
    const botM = bot * MM;

    // ── Separator: thin semi-transparent plane ──────────────────────────────
    if (isSep) {
      const cx2 = (sxM + exM) / 2, cz2 = (syM + eyM) / 2;
      const len2 = Math.sqrt((exM - sxM) ** 2 + (eyM - syM) ** 2) || 1;
      const hM   = wallH * MM;
      const plane = MeshBuilder.CreatePlane(`sep_${wn.id}`, { width: len2, height: hM }, scene);
      plane.position  = new Vector3(cx2, botM + hM / 2, cz2);
      plane.rotation.y = Math.atan2(eyM - syM, exM - sxM);
      const sepMat = new StandardMaterial(`sep_mat_${wn.id}`, scene);
      sepMat.diffuseColor   = new Color3(0.53, 0.67, 0.80);
      sepMat.alpha          = 0.35;
      sepMat.backFaceCulling = false;
      plane.material = sepMat;
      meshes.push(plane);
      continue;
    }

    const openings = collectOpenings(wn, effLen, edges, nodeMap);

    // ── Circular arc wall ────────────────────────────────────────────────────
    const isCircular = wn.properties.is_circular === 'True' || wn.properties.is_circular === true;
    const arcRadiusMm = isCircular ? Number(wn.properties.arc_radius ?? 5000) : 0;

    if (isCircular && arcRadiusMm !== 0) {
      // Tessellate arc into straight segments, no opening support yet
      const arcSegs = arcWallSegments(sxM, syM, exM, eyM, arcRadiusMm * MM);
      arcSegs.forEach((seg, i) => {
        const segLen = Math.sqrt((seg.bx - seg.ax) ** 2 + (seg.bz - seg.az) ** 2);
        if (segLen < 1e-5) return;
        add(
          spanBox(`wall_${wn.id}_arc${i}`, seg.ax, seg.az, seg.bx, seg.bz, th, wallH * MM, botM, scene),
          'wall', 1, wn, 'wall',
        );
      });
      continue;
    }

    if (openings.length === 0) {
      // No openings — render as a single box (original behaviour)
      add(spanBox(`wall_${wn.id}`, sxM, syM, exM, eyM, th, wallH * MM, botM, scene), 'wall', 1, wn, 'wall');
    } else {
      // Split wall into vertical segments around each opening.
      // Each opening occupies [tS .. tE] metres along the wall.
      // Between openings (and before/after) the full-height wall continues.
      // Inside an opening: sill panel (below) + lintel panel (above).

      // Sort & clamp openings
      const sorted = openings.map((o) => ({
        ...o,
        tS: Math.max(0, o.distFromStart * MM),
        tE: Math.min(effLen * MM, (o.distFromStart + o.width) * MM),
      })).filter((o) => o.tE > o.tS);

      let cursor = 0; // metres along wall

      for (let i = 0; i <= sorted.length; i++) {
        const gapStart = cursor;
        const gapEnd   = i < sorted.length ? sorted[i].tS : effLen * MM;

        // Full-height wall segment in the gap
        if (gapEnd - gapStart > 1e-6) {
          add(
            wallSegBox(`wall_${wn.id}_seg${i}`, sxM, syM, exM, eyM, gapStart, gapEnd, th, wallH * MM, botM, scene),
            'wall', 1, wn, 'wall',
          );
        }

        if (i < sorted.length) {
          const op = sorted[i];
          const sill   = op.sillHeight * MM;
          const openH  = op.height * MM;
          const lintelH = wallH * MM - sill - openH;

          // Sill panel (below opening)
          if (sill > 1e-6) {
            add(
              wallSegBox(`wall_${wn.id}_sill${i}`, sxM, syM, exM, eyM, op.tS, op.tE, th, sill, botM, scene),
              'wall', 1, wn, 'wall',
            );
          }
          // Lintel panel (above opening)
          if (lintelH > 1e-6) {
            add(
              wallSegBox(`wall_${wn.id}_lintel${i}`, sxM, syM, exM, eyM, op.tS, op.tE, th, lintelH, botM + sill + openH, scene),
              'wall', 1, wn, 'wall',
            );
          }

          // Opening 3D meshes (frame + glass/panel + void reveal OR IFC library mesh)
          const typeId  = String(op.node.type === 'door' ? (op.node.properties.door_type ?? '') : (op.node.properties.window_type ?? ''));
          const ifcPath = resolveIfcPath(op.node.type === 'door' ? 'door' : 'window', typeId);
          const ifcInfo = ifcPath ? ifcGroupCache.get(ifcPath) : null;

          if (ifcInfo) {
            // IFC library mesh — placed at opening centre, oriented to wall normal
            const dx2 = exM - sxM, dz2 = eyM - syM;
            const wallLenM2 = Math.sqrt(dx2 * dx2 + dz2 * dz2);
            const wux2 = dx2 / wallLenM2, wuz2 = dz2 / wallLenM2;
            const wnx2 = -wuz2, wnz2 = wux2; // wall normal in Babylon XZ
            const tMid2  = (op.tS + op.tE) / 2;
            const cx2    = sxM + wux2 * tMid2;
            const cz2    = syM + wuz2 * tMid2;
            const openBottomY = botM + op.sillHeight * MM; // group local Y=0 = bottom of window
            buildIfcBabylonMeshes(ifcInfo, cx2, openBottomY, cz2, wnx2, wnz2, op.width * MM, op.height * MM, scene)
              .forEach((m) => {
                if (op.node) applyNodeLocalTransformBabylon(m, getNodeLocalTransform(op.node));
                meshes.push(m);
              });
          } else {
            buildOpeningMeshes(sxM, syM, exM, eyM, th, botM, op, scene, matCache)
              .forEach((m) => meshes.push(m));
          }

          cursor = op.tE;
        }
      }
    }

    // Beam: extrusion downward from storey top by beam cross-section height
    if (String(wn.properties.has_beam ?? '').toLowerCase() === 'true') {
      const { bw, bh } = parseBeamDims(String(wn.properties.beam_section ?? 'B20x30'));
      const wBeamVis = resolveVisuals('beam', String(wn.properties.beam_material ?? ''), matConfig);
      const bm = spanBox(`wallbeam_${wn.id}`, sxM, syM, exM, eyM, bw, bh, top * MM - bh, scene);
      bm.material = getMat(scene, matCache, 'beam', 1, wBeamVis);
      meshes.push(bm);
    }
  }

  // ── Skip window/door nodes — rendered inline above via buildOpeningMeshes ─
  // (they have no independent geometry; their visuals are built when processing their parent wall)

  // ── Standalone Beams (node-centric, hangs down from storey top)
  //   Properties: beam_section (width×height cm), offset_start, offset_end.
  for (const bn of nodes.filter((n) => n.type === 'beam')) {
    const pts = getConnectedNodes(bn.id, edges, nodeMap);
    if (pts.length < 2) continue;
    const pA = getNodeBimPos(pts[0], nodeMap);
    const pB = getNodeBimPos(pts[1], nodeMap);
    const dx = pB.x - pA.x, dy = pB.y - pA.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) continue;
    const { sx, sy, ex, ey } = calcSpanEffectiveEnds(bn, pA, pB, pts[0], pts[1], nodeMap);

    const { top } = getStoreyBand(bn, nodeMap);
    const { bw, bh } = parseBeamDims(String(bn.properties.beam_section ?? bn.properties.beam_type ?? 'B30x60'));
    add(spanBox(`beam_${bn.id}`, sx * MM, sy * MM, ex * MM, ey * MM, bw, bh, top * MM - bh, scene), 'beam', 1, bn);
  }

  // ── Slabs ─────────────────────────────────────────────────────────────────
  for (const n of nodes.filter((n) => n.type === 'slab')) {
    const { top } = getStoreyBand(n, nodeMap);
    const th   = getNodeSlabThickness(n);
    const sibs = nodes.filter((s) => s.parentId === n.parentId && s.type !== 'storey');
    const xs   = (sibs.length ? sibs : [n]).map((s) => s.x * MM);
    const zs   = (sibs.length ? sibs : [n]).map((s) => s.y * MM);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const sw = Math.max(Math.max(...xs) - Math.min(...xs), 1) + 0.5;
    const sd = Math.max(Math.max(...zs) - Math.min(...zs), 1) + 0.5;
    const m  = MeshBuilder.CreateBox(`slab_${n.id}`, { width: sw, height: th, depth: sd }, scene);
    m.position = new Vector3(cx, top * MM - th / 2, cz);
    add(m, 'slab', 1, n);
  }

  // ── Foundations ───────────────────────────────────────────────────────────
  for (const n of nodes.filter((n) => n.type === 'foundation')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const m = MeshBuilder.CreateBox(`found_${n.id}`, { width: 1.2, height: 0.5, depth: 1.2 }, scene);
    m.position = bim(n.x, n.y, bot - 250); // 250 mm below storey bottom
    add(m, 'foundation', 1, n);
  }

  // ── Rooms (extruded polygon or fallback box) ────────────────────────────────────────
  for (const n of nodes.filter((n) => n.type === 'room')) {
    const { bot, top } = getStoreyBand(n, nodeMap);
    const roomH  = Number(n.properties.height ?? (top - bot));
    const botY   = bot * MM;
    const topY   = (bot + roomH * 0.95) * MM;

    // Per-node color > material config > fallback
    const colorHex  = String(n.properties.color ?? '').trim();
    const roomVis   = resolveVisuals('room', String(n.properties.material ?? ''), matConfig);
    const finalHex  = colorHex || roomVis.color_3d;
    const [cr, cg, cb] = hexToRgb01(finalHex);
    const roomAlpha = roomVis.opacity_3d;

    const poly = calcRoomPolygon(n, nodeMap, edges);
    if (poly && poly.length >= 3) {
      const nPts = poly.length;
      const positions: number[] = [];
      const indices:   number[] = [];

      // Vertex layout: [0..nPts-1] = bottom ring, [nPts..2*nPts-1] = top ring,
      //                [2*nPts] = bottom centroid, [2*nPts+1] = top centroid
      for (const p of poly) positions.push(p.x * MM, botY, p.y * MM); // bottom
      for (const p of poly) positions.push(p.x * MM, topY, p.y * MM); // top
      const cXm = poly.reduce((s, p) => s + p.x, 0) / nPts * MM;
      const cZm = poly.reduce((s, p) => s + p.y, 0) / nPts * MM;
      positions.push(cXm, botY, cZm); // 2*nPts   = bottom centroid
      positions.push(cXm, topY, cZm); // 2*nPts+1 = top centroid
      const botCent = 2 * nPts, topCent = 2 * nPts + 1;

      // Side quads
      for (let i = 0; i < nPts; i++) {
        const i0 = i, i1 = (i + 1) % nPts, i2 = i1 + nPts, i3 = i + nPts;
        indices.push(i0, i1, i2, i0, i2, i3);
      }
      // Bottom face (fan, CCW from above = normals face down)
      for (let i = 0; i < nPts; i++) indices.push(botCent, (i + 1) % nPts, i);
      // Top face (fan, CCW from above = normals face up)
      for (let i = 0; i < nPts; i++) indices.push(topCent, i + nPts, (i + 1) % nPts + nPts);

      const normArray: number[] = new Array(positions.length).fill(0);
      VertexData.ComputeNormals(positions, indices, normArray);
      const vd = new VertexData();
      vd.positions = positions; vd.indices = indices; vd.normals = normArray;

      const roomMesh = new Mesh(`room_${n.id}`, scene);
      vd.applyToMesh(roomMesh);
      const mat = new StandardMaterial(`room_mat_${n.id}`, scene);
      mat.diffuseColor   = new Color3(cr, cg, cb);
      mat.alpha          = roomAlpha;
      mat.backFaceCulling = false;
      roomMesh.material  = mat;
      applyNodeLocalTransformBabylon(roomMesh, getNodeLocalTransform(n));
      meshes.push(roomMesh);
    } else {
      // Fallback: generic transparent box
      const m = MeshBuilder.CreateBox(`room_${n.id}`, { width: 4, height: (topY - botY), depth: 4 }, scene);
      m.position = bim(n.x, n.y, bot + roomH * 0.95 / 2);
      const mat = new StandardMaterial(`room_mat_fb_${n.id}`, scene);
      mat.diffuseColor    = new Color3(cr, cg, cb);
      mat.alpha           = roomAlpha;
      mat.backFaceCulling = false;
      m.material = mat;
      applyNodeLocalTransformBabylon(m, getNodeLocalTransform(n));
      meshes.push(m);
    }
  }

  // ── Void nodes — ghost wireframe indicators (Babylon has no built-in CSG) ────────────────
  // Render as semi-transparent orange mesh at the void's intended world position.
  for (const n of nodes.filter((n) => n.type === 'void')) {
    const shape: 'box' | 'cylinder' =
      String(n.properties.void_shape ?? 'box') === 'cylinder' ? 'cylinder' : 'box';
    const w  = Number(n.properties.width   ?? 500) * MM;
    const h  = Number(n.properties.height  ?? 500) * MM;
    const d  = Number(n.properties.depth   ?? 500) * MM;
    const r  = Number(n.properties.radius  ?? 250) * MM;
    const rs = Math.max(4, Math.round(Number(n.properties.radial_segments ?? 16)));

    // Resolve position from connected host node + offsets
    let hx = n.x, hy = n.y, hz = 0;
    for (const e of edges) {
      if (e.from !== n.id && e.to !== n.id) continue;
      const host = nodeMap.get(e.from === n.id ? e.to : e.from);
      if (!host || host.type === 'void') continue;
      const hp = getNodeBimPos(host, nodeMap);
      const { bot, top: htop } = getStoreyBand(host, nodeMap);
      hx = hp.x; hy = hp.y; hz = bot + (htop - bot) / 2;
      break;
    }
    const ox = Number(n.properties.offset_x ?? 0);
    const oy = Number(n.properties.offset_y ?? 0);
    const oz = Number(n.properties.offset_z ?? 0);
    const cx = (hx + ox) * MM, cz = (hy + oy) * MM, cy = (hz + oz) * MM;

    const voidMat = new StandardMaterial(`void_mat_${n.id}`, scene);
    voidMat.diffuseColor    = new Color3(0.98, 0.60, 0.13);
    voidMat.alpha           = 0.35;
    voidMat.wireframe       = true;
    voidMat.backFaceCulling = false;

    let vm: Mesh;
    if (shape === 'cylinder') {
      vm = MeshBuilder.CreateCylinder(`void_${n.id}`, { diameter: r * 2, height: h, tessellation: rs }, scene);
    } else {
      vm = MeshBuilder.CreateBox(`void_${n.id}`, { width: w, height: h, depth: d }, scene);
    }
    vm.position = new Vector3(cx, cy, cz);
    vm.material = voidMat;
    meshes.push(vm);
  }

  // ── Library objects — placeholder box (shown while/if GLB loads) ──────────
  for (const n of nodes.filter((nd) => nd.type === 'object')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const w    = Number(n.properties.width_mm  ?? 600) * MM;
    const d    = Number(n.properties.depth_mm  ?? 600) * MM;
    const h    = Number(n.properties.height_mm ?? 900) * MM;
    const zOff = Number(n.properties.z_offset_mm ?? 0);
    const cenZ = bot + zOff + Number(n.properties.height_mm ?? 900) / 2;
    const m = MeshBuilder.CreateBox(`obj_ph_${n.id}`, { width: w, height: h, depth: d }, scene);
    m.position = bim(n.x, n.y, cenZ);
    const vis  = resolveVisuals('object', String(n.properties.material ?? ''), matConfig);
    m.material = getMat(scene, matCache, 'object', 0.35, vis);
    applyNodeLocalTransformBabylon(m, getNodeLocalTransform(n));
    meshes.push(m);
  }

  return meshes;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface BabylonViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes: BuildingAxes;
  className?: string;
}

export function BabylonViewer({ nodes, edges, buildingAxes, className }: BabylonViewerProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const engineRef    = useRef<Engine | null>(null);
  const sceneRef     = useRef<Scene | null>(null);
  const geomRef      = useRef<Mesh[]>([]);
  const hasFitRef    = useRef(false); // auto-fit camera only on first build
  const hemiRef      = useRef<HemisphericLight | null>(null);
  const sunRef       = useRef<DirectionalLight | null>(null);
  const groundMatRef = useRef<StandardMaterial | null>(null);
  const importedMeshesRef = useRef<Mesh[]>([]);
  const setSelectedNodeId = useBubbleGraphStore((s) => s.setSelectedNodeId);
  const [ready, setReady] = useState(false);
  const [dayMode, setDayMode] = useState(false);
  const { config: matConfig } = useMaterialConfig();

  // ── Visibility filter ────────────────────────────────────────────────────
  const [hiddenTypes, setHiddenTypes]         = useState<Set<string>>(new Set());
  const [hiddenStoreyIds, setHiddenStoreyIds] = useState<Set<string>>(new Set());
  // Refs so the pointer-down handler (closed over in the scene useEffect) can
  // read the latest visibility state without needing a rebuild.
  const hiddenTypesRef     = useRef(hiddenTypes);
  const hiddenStoreyIdsRef = useRef(hiddenStoreyIds);
  const nodesMapRef        = useRef<Map<string, BubbleGraphNode>>(new Map());
  useEffect(() => { hiddenTypesRef.current     = hiddenTypes; }, [hiddenTypes]);
  useEffect(() => { hiddenStoreyIdsRef.current = hiddenStoreyIds; }, [hiddenStoreyIds]);
  useEffect(() => {
    nodesMapRef.current = new Map(nodes.map((n) => [n.id, n]));
  }, [nodes]);

  // Unique element types + counts for the VisibilityFilter (same logic as Ara3DViewer)
  const { visibleTypes, typeCounts } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
    if (!counts['storey'] && nodes.some((n) => n.type === 'storey'))
      counts['storey'] = nodes.filter((n) => n.type === 'storey').length;
    if (!counts['column']) {
      const c = nodes.filter((n) => n.type === 'ax' && String(n.properties.has_column ?? '').toLowerCase() === 'true').length;
      if (c > 0) counts['column'] = c;
    }
    if (!counts['beam']) {
      const c = nodes.filter((n) => n.type === 'wall' && String(n.properties.has_beam ?? '').toLowerCase() === 'true').length;
      if (c > 0) counts['beam'] = c;
    }
    return { visibleTypes: Object.keys(counts), typeCounts: counts };
  }, [nodes]);

  // ── Scene bootstrap (once on mount) ──────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    engineRef.current = engine;

    const scene = new Scene(engine);
    sceneRef.current = scene;
    scene.clearColor = new Color4(0.07, 0.07, 0.12, 1);

    // Camera
    const cam = new ArcRotateCamera('cam', -Math.PI / 4, 1.1, 25, Vector3.Zero(), scene);
    cam.attachControl(canvas, true);
    cam.lowerRadiusLimit = 1;
    cam.wheelPrecision   = 5;

    // Lights
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity   = 0.65;
    hemi.groundColor = new Color3(0.1, 0.1, 0.15);
    hemiRef.current  = hemi;
    const sun = new DirectionalLight('sun', new Vector3(-1, -2, -1), scene);
    sun.intensity = 0.9;
    sun.position  = new Vector3(20, 40, 20);
    sunRef.current = sun;

    // Ground plane
    const ground = MeshBuilder.CreateGround('ground', { width: 200, height: 200 }, scene);
    const gMat = new StandardMaterial('gMat', scene);
    gMat.diffuseColor  = new Color3(0.1, 0.1, 0.15);
    gMat.specularColor = Color3.Black();
    gMat.alpha         = 0.6;
    ground.material    = gMat;
    ground.isPickable  = false;
    groundMatRef.current = gMat;

    // ── Axes gizmo (corner overlay — X=red/East, Y=green/North, Z=blue/Up) ──
    // In Babylon Y-up space: BIM-X→Babylon X, BIM-Y→Babylon Z, BIM-Z→Babylon Y
    const axisLen = 1.0;
    const origin = new Vector3(0, 0, 0);
    const axes: Array<[string, Vector3, Color3]> = [
      ['axisX', new Vector3(axisLen, 0, 0),       new Color3(0.90, 0.20, 0.20)], // East  – red
      ['axisY', new Vector3(0, 0, axisLen),        new Color3(0.20, 0.80, 0.20)], // North – green (Babylon Z)
      ['axisZ', new Vector3(0, axisLen, 0),        new Color3(0.25, 0.55, 0.95)], // Up    – blue  (Babylon Y)
    ];
    for (const [name, dir, col] of axes) {
      const line = CreateLineSystem(name, { lines: [[origin, dir]] }, scene) as unknown as LinesMesh;
      line.color = col;
      line.isPickable = false;
    }

    engine.runRenderLoop(() => scene.render());
    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);

    // ── Click-to-select: pick mesh → extract nodeId from metadata ──
    // Track pointer start to distinguish click from drag (orbit/pan)
    let pointerStart: { x: number; y: number } | null = null;
    scene.onPointerDown = (evt) => {
      pointerStart = { x: evt.clientX, y: evt.clientY };
    };
    scene.onPointerUp = (evt) => {
      if (!pointerStart) return;
      const dx = evt.clientX - pointerStart.x;
      const dy = evt.clientY - pointerStart.y;
      pointerStart = null;
      if (dx * dx + dy * dy > 25) return; // dragged more than 5px — skip selection

      // Helper: check if a mesh is currently visible (respects type + storey filters)
      const isMeshVisible = (mesh: { metadata?: unknown }): boolean => {
        const m = mesh.metadata as { nodeId?: string; nodeType?: string; storeyId?: string } | null;
        if (!m?.nodeType) return true;
        if (hiddenTypesRef.current.has(m.nodeType)) return false;
        if (hiddenStoreyIdsRef.current.size > 0 && m.storeyId && hiddenStoreyIdsRef.current.has(m.storeyId)) return false;
        return true;
      };

      const pickResult = scene.pick(scene.pointerX, scene.pointerY);
      if (!pickResult?.hit || !pickResult.pickedMesh) {
        setSelectedNodeId(null);
        return;
      }
      // Room/storey meshes have lowest selection priority
      const LOW_PRIORITY = new Set(['room', 'storey']);
      const meta = pickResult.pickedMesh.metadata as { nodeId?: string; nodeType?: string } | null;
      if (meta?.nodeId && !LOW_PRIORITY.has(meta.nodeType ?? '') && isMeshVisible(pickResult.pickedMesh)) {
        setSelectedNodeId(meta.nodeId);
        return;
      }
      // Try multiPick to find something behind it (also skip hidden meshes)
      const multiResults = scene.multiPick(scene.pointerX, scene.pointerY);
      if (multiResults) {
        for (const pr of multiResults) {
          if (!pr.pickedMesh || !isMeshVisible(pr.pickedMesh)) continue;
          const m = pr.pickedMesh.metadata as { nodeId?: string; nodeType?: string } | null;
          if (m?.nodeId && !LOW_PRIORITY.has(m.nodeType ?? '')) {
            setSelectedNodeId(m.nodeId);
            return;
          }
        }
      }
      // Fallback: select room/storey if nothing else found (and it's visible)
      if (meta?.nodeId && isMeshVisible(pickResult.pickedMesh)) {
        setSelectedNodeId(meta.nodeId);
        return;
      }
      setSelectedNodeId(null);
    };

    setReady(true);

    return () => {
      window.removeEventListener('resize', onResize);
      engine.stopRenderLoop();
      scene.dispose();
      engine.dispose();
    };
  }, []);

  // ── Visibility effect: show/hide meshes when filters change ──────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !ready) return;
    scene.meshes.forEach((mesh) => {
      const m = mesh.metadata as { nodeId?: string; nodeType?: string; storeyId?: string } | null;
      if (!m?.nodeType) return;
      if (hiddenTypes.has(m.nodeType)) { mesh.setEnabled(false); return; }
      if (hiddenStoreyIds.size > 0 && m.storeyId && hiddenStoreyIds.has(m.storeyId)) { mesh.setEnabled(false); return; }
      mesh.setEnabled(true);
    });
  }, [hiddenTypes, hiddenStoreyIds, ready]);

  // ── Rebuild geometry whenever nodes/edges change ──────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !ready) return;

    // Async: pre-load IFC library parts, then rebuild geometry
    (async () => {
      const ifcGroupCache = new Map<string, IFCGroupInfo>();
      const paths = collectIfcLibraryPaths(nodes);
      await Promise.all(
        paths.map(async (lp) => {
          try {
            const parts = await loadIfcParts(lp);
            ifcGroupCache.set(lp, buildIfcGroup(parts));
          } catch (err) {
            console.warn(`[BabylonViewer] Could not load IFC library part: ${lp}`, err);
          }
        }),
      );

      geomRef.current.forEach((m) => { try { m.dispose(); } catch { /* ok */ } });
      geomRef.current = [];

      const buildingNodes = nodes.filter((n) => n.type !== 'storey');
      if (buildingNodes.length === 0) return;

      const meshes = buildGeometry(scene, nodes, edges, ifcGroupCache, matConfig);
      geomRef.current = meshes;

      // ── Async: load GLBs for 'object' nodes, replace placeholder boxes ──
      const objectNodes = nodes.filter((n) => n.type === 'object' && n.properties.glb_ref);
      await Promise.all(objectNodes.map(async (n) => {
        const glbRef = String(n.properties.glb_ref ?? '');
        if (!glbRef) return;

        const nodeMapLocal = new Map(nodes.map((x) => [x.id, x]));
        const { bot } = getStoreyBand(n, nodeMapLocal);
        const zOff  = Number(n.properties.z_offset_mm ?? 0);
        const posX  = n.x * MM;
        const posZ  = n.y * MM;
        const posY  = (bot + zOff) * MM;
        const rotY  = getNodeLocalTransform(n).ry;
        const scale = Number(n.properties.glb_scale ?? 1.0);

        const glbMeshes = await loadGlbIntoScene(glbRef, scene, `object_${n.id}`, posX, posY, posZ, rotY, scale);
        if (glbMeshes.length > 0) {
          // Dispose placeholder
          geomRef.current.filter((m) => m.name === `obj_ph_${n.id}`).forEach((m) => { try { m.dispose(); } catch { /* ok */ } });
          geomRef.current = geomRef.current.filter((m) => m.name !== `obj_ph_${n.id}`);
          geomRef.current.push(...glbMeshes);
        }
      }));

      // Fit camera to bounding box
      if (meshes.length === 0) return;
      let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      meshes.forEach((m) => {
        const bi = m.getBoundingInfo?.();
        if (!bi) return;
        const { minimumWorld: mn, maximumWorld: mx } = bi.boundingBox;
        if (mn.x < minX) minX = mn.x; if (mx.x > maxX) maxX = mx.x;
        if (mn.y < minY) minY = mn.y; if (mx.y > maxY) maxY = mx.y;
        if (mn.z < minZ) minZ = mn.z; if (mx.z > maxZ) maxZ = mx.z;
      });
      const cx   = (minX + maxX) / 2;
      const cy   = (minY + maxY) / 2;
      const cz   = (minZ + maxZ) / 2;
      const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
      const cam  = scene.getCameraByName('cam') as ArcRotateCamera | null;
      if (cam && !hasFitRef.current) {
        hasFitRef.current = true;
        cam.target = new Vector3(cx, cy, cz);
        cam.radius = Math.max(diag * 0.9, 5);
      }

      // Re-apply visibility after geometry rebuild
      scene.meshes.forEach((mesh) => {
        const m = mesh.metadata as { nodeId?: string; nodeType?: string; storeyId?: string } | null;
        if (!m?.nodeType) return;
        if (hiddenTypesRef.current.has(m.nodeType)) { mesh.setEnabled(false); return; }
        if (hiddenStoreyIdsRef.current.size > 0 && m.storeyId && hiddenStoreyIdsRef.current.has(m.storeyId)) { mesh.setEnabled(false); return; }
        mesh.setEnabled(true);
      });
    })();
  }, [nodes, edges, buildingAxes, ready, matConfig]);

  const isEmpty = nodes.filter((n) => n.type !== 'storey').length === 0;

  /**
   * Project a BIM-space point (mm) to viewport pixel coordinates.
   * BIM → Babylon: X→X (East), Y→Z (North/depth), Z→Y (Up)
   */
  const projectBimPoint = useCallback(
    (bimX: number, bimY: number, bimZ: number): Pt2D | null => {
      const scene  = sceneRef.current;
      const canvas = canvasRef.current;
      if (!scene || !canvas || !ready) return null;
      const cam = scene.getCameraByName('cam') as ArcRotateCamera | null;
      if (!cam) return null;
      const wp  = new Vector3(bimX * MM, bimZ * MM, bimY * MM);
      const vp  = cam.viewport.toGlobal(canvas.clientWidth, canvas.clientHeight);
      const proj = Vector3.Project(wp, Matrix.Identity(), scene.getTransformMatrix(), vp);
      if (!isFinite(proj.x) || !isFinite(proj.y) || proj.z < 0 || proj.z > 1.001) return null;
      return { x: proj.x, y: proj.y };
    },
    [ready],
  );

  // ── Day / Night mode ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const scene    = sceneRef.current;
    const hemi     = hemiRef.current;
    const sun      = sunRef.current;
    const groundMat = groundMatRef.current;
    if (!scene || !hemi || !sun || !groundMat) return;
    if (dayMode) {
      scene.clearColor = new Color4(0.76, 0.88, 0.97, 1);
      hemi.intensity   = 0.80;
      hemi.diffuse     = new Color3(1, 1, 1);
      hemi.groundColor = new Color3(0.55, 0.45, 0.35);
      sun.intensity    = 1.4;
      sun.diffuse      = new Color3(1, 0.97, 0.90);
      groundMat.diffuseColor = new Color3(0.76, 0.73, 0.68);
    } else {
      scene.clearColor = new Color4(0.07, 0.07, 0.12, 1);
      hemi.intensity   = 0.65;
      hemi.diffuse     = new Color3(1, 1, 1);
      hemi.groundColor = new Color3(0.10, 0.10, 0.15);
      sun.intensity    = 0.9;
      sun.diffuse      = new Color3(1, 1, 1);
      groundMat.diffuseColor = new Color3(0.10, 0.10, 0.15);
    }
  }, [dayMode]);

  return (
    <div className={cn('relative w-full h-full', className)}>
      <canvas ref={canvasRef} className="w-full h-full outline-none" />

      {/* Day / Night toggle — toolbar top-left */}
      {ready && (
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1 bg-black/50 backdrop-blur rounded-md px-1.5 py-1">
          <button
            onClick={() => setDayMode((d) => !d)}
            title={dayMode ? 'Mod noapte (click pentru zi)' : 'Mod zi (click pentru noapte)'}
            className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded select-none transition-colors text-white/80 hover:bg-white/15"
          >
            <span className="text-base leading-none">{dayMode ? '🌙' : '☀️'}</span>
            <span>{dayMode ? 'Noapte' : 'Zi'}</span>
          </button>
          <div className="w-px h-4 bg-white/20" />
          <button
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.glb,.gltf';
              input.onchange = async () => {
                const file = input.files?.[0];
                const scene = sceneRef.current;
                if (!file || !scene) return;
                const blobUrl = URL.createObjectURL(file);
                try {
                  const result = await SceneLoader.ImportMeshAsync('', blobUrl, '', scene);
                  for (const m of result.meshes) {
                    if ((m as Mesh).getTotalVertices?.() > 0)
                      importedMeshesRef.current.push(m as Mesh);
                  }
                } catch (err) {
                  console.warn('[BabylonViewer] GLB import failed:', err);
                } finally {
                  URL.revokeObjectURL(blobUrl);
                }
              };
              input.click();
            }}
            title="Import GLB/GLTF model into 3D scene"
            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded select-none transition-colors text-white/80 hover:bg-white/15"
          >
            <span>📦</span>
            <span>Import GLB</span>
          </button>
        </div>
      )}

      {/* Axis inter-ax dimension lines (perspective-projected) */}
      <AxisInteraxOverlay nodes={nodes} projectBimPoint={projectBimPoint} viewerReady={ready} />

      {/* Visibility filter — tree mode for 3D viewer */}
      {ready && (
        <VisibilityFilter
          types={visibleTypes}
          hiddenTypes={hiddenTypes}
          onChange={setHiddenTypes}
          counts={typeCounts}
          nodes={nodes}
          edges={edges}
          hiddenStoreyIds={hiddenStoreyIds}
          onChangeStoreyIds={setHiddenStoreyIds}
        />
      )}

      {isEmpty && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 gap-2 pointer-events-none">
          <span className="text-5xl opacity-30">🎲</span>
          <p className="text-sm">No building elements yet.</p>
          <p className="text-xs text-zinc-600">Add columns, walls, or slabs to the graph first.</p>
        </div>
      )}

      <div className="absolute bottom-3 right-3 text-[10px] text-zinc-500 space-y-0.5 text-right pointer-events-none select-none">
        <div>Left drag — orbit</div>
        <div>Right drag — pan</div>
        <div>Scroll — zoom</div>
      </div>
    </div>
  );
}
