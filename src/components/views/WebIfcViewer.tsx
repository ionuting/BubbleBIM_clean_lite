/**
 * WebIfcViewer — That Open Components (OBC) 3D BIM viewer.
 *
 * Uses @thatopen/components for scene / camera / renderer infrastructure.
 * Geometry is rendered via THREE.InstancedMesh (columns grouped by type for
 * GPU instancing) and THREE.Mesh (unique shapes: walls, beams, slabs, etc.).
 * IFC-like hierarchy:
 *
 *   IfcProject (THREE.Group)
 *     IfcBuilding (THREE.Group)
 *       IfcBuildingStorey_<name> (THREE.Group)
 *         storey planes + InstancedMesh / Mesh children
 *
 * Coordinate system: BIM X->Three.X, BIM Y->Three.Z, BIM Z->Three.Y (mm*0.001)
 */

import { useEffect, useRef, useState, useCallback, useMemo, useId } from 'react';
import * as THREE from 'three';
import { AxisInteraxOverlay } from './AxisInteraxOverlay';
import { AnnotationsToolbar, type AnnotationTool } from './AnnotationsToolbar';
import * as OBC from '@thatopen/components';
import * as OBF from '@thatopen/components-front';
import { cn, parseAxes } from '@/lib/utils';
import { VisibilityFilter } from '@/components/views/VisibilityFilter';
import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes } from '@/store';
import { useBubbleGraphStore } from '@/store';
import {
  MM,
  parseColumnDims, parseBeamDims, getNodeSlabThickness,
  getStoreyBand, getAxRealPos, getNodeBimPos, getConnectedNodes,
  calcWallGeometry, calcWallJoins, calcStoreyPlanExtents,
  calcRoomPolygon, calcShellPolygon, parseContourOffsets, insetPolygon,
  calcSpanEffectiveEnds, resolveStoreyId,
  type WallSegDesc,
} from '@/lib/bimGeometry';
import { getMat, wallSolidMesh, wallHorizontalProfileMesh, wallHorizontalProfileLayerMesh, wallSolidLayerMesh, makeBoxOpeningCutter, makeIfcOpeningCutter, applyOpeningVoids, buildOpeningMeshes3, applyIfcGlazingOverrides, applyNodeLocalTransformThree, roofFaceGeometry, roofSurfaceNode } from '@/lib/bimGeometryThree';
import { getNodeLocalTransform } from '@/lib/bimGeometry';
import {
  loadIfcParts, buildIfcGroup, positionIfcGroup,
  collectIfcLibraryPaths, resolveIfcPath,
  type IFCGroupInfo,
} from '@/lib/ifcLibraryLoader';
import { type MaterialConfig, resolveVisuals, applyNodeColorOverrides, hexToRgb01, resolveWindowGlazing } from '@/lib/materialConfig';
import { computeSweep, sweepBufferGeometry } from '@/lib/sweep';
import { computeSketch } from '@/lib/sketch';
import { computeScatter, type ScatterInstance } from '@/lib/scatter';
import { scatterGeometries } from '@/lib/scatter/mesh';
import { terrainItemInstances } from '@/lib/scatter/terrainItems';
import { computeFacade } from '@/lib/facade';
import { facadeGeometries } from '@/lib/facade/mesh';
import { computeDome, domePanelGeometry } from '@/lib/dome';
import { computeSite, findSiteNode, terrainBufferGeometry } from '@/lib/terrain';
import { currentTerrainModel } from '@/lib/terrain/current';
import { resolveCoveringLayers, roomHasCovering } from '@/lib/roomCovering';
import { resolveWallLayers, syntheticWallNodeForLayer } from '@/lib/wallLayers';
import { renderBandsOf } from '@/lib/zones/heightZones';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { getBubbleIdByLocalId, getLocalIdsByBubbleId, BIM_MODEL_ID } from '@/lib/fragModelBuilder';
import { useModelIfc } from '@/lib/ifc/useModelIfc';
import { IFC_EXPORTED_NODE_TYPES, nodeIdOfTag } from '@/lib/ifc/ifcCoverage';
import { exportFragmentsModel, formatBytes, fragFileName } from '@/lib/fragmentsExport';
import { expandArrayNodes } from '@/lib/formulaUtils';
import { computeRoofFaces } from '@/lib/roof/solver';
import type { RoofFace3D } from '@/lib/roof/types';
import type { FragmentsModel } from '@thatopen/fragments';
import { readItemGuid, readItemProperties, type IfcElementProperties } from '@/lib/ifc/ifcFragments';
import { getHostBridge } from '@/lib/ifc/hostBridge';
import { useExtrusions } from '@/lib/ifc/extrude/useExtrusions';
import { contourLineGeometry, extrudedSolidEdges, extrudedSolidGeometry } from '@/lib/ifc/extrude/extrudeGeometry';
import type { Pt2 } from '@/lib/ifc/extrude/extrudedSolid';
import { ExtrudePanel } from '@/components/ifc/ExtrudePanel';
import { IfcPropertiesPanel } from '@/components/ifc/IfcPropertiesPanel';
import { registerLoadedIfc, unregisterLoadedIfc } from '@/lib/loadedIfcRegistry';
import { productsByColour, readIndexedColours } from '@/lib/ifc/indexedColours';

const SCENE_ROOT = '__bg_scene_root__';

function pose(x: number, y: number, z: number, rotY = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationY(rotY);
  m.setPosition(x, y, z);
  return m;
}

function addInstanced(
  parent: THREE.Group,
  geom: THREE.BufferGeometry,
  mat: THREE.Material,
  instances: Array<{ matrix: THREE.Matrix4 }>,
  nodeType?: string,
  storeyId?: string,
): void {
  if (!instances.length) return;
  const mesh = new THREE.InstancedMesh(geom, mat, instances.length);
  instances.forEach((inst, i) => mesh.setMatrixAt(i, inst.matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow    = true;
  mesh.receiveShadow = true;
  if (nodeType)  mesh.userData.nodeType = nodeType;
  if (storeyId)  mesh.userData.storeyId = storeyId;
  parent.add(mesh);
}

function addMesh(
  parent: THREE.Group,
  geom: THREE.BufferGeometry,
  mat: THREE.Material,
  matrix: THREE.Matrix4,
  node?: BubbleGraphNode,
  nodeType?: string,
  nodeMap?: Map<string, BubbleGraphNode>,
): void {
  const mesh = new THREE.Mesh(geom, mat);
  mesh.applyMatrix4(matrix);
  if (node) {
    applyNodeLocalTransformThree(mesh, getNodeLocalTransform(node));
    mesh.userData.nodeId   = node.id;
    mesh.userData.nodeType = nodeType ?? node.type;
    if (nodeMap) mesh.userData.storeyId = resolveStoreyId(node, nodeMap);
  } else if (nodeType) {
    mesh.userData.nodeType = nodeType;
  }
  mesh.castShadow    = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
}

function wallSegMesh(
  parent: THREE.Group,
  seg: WallSegDesc,
  mat: THREE.Material,
  node?: BubbleGraphNode,
  nodeMap?: Map<string, BubbleGraphNode>,
): void {
  const { ax, az, bx, bz, tStart, tEnd, width, height, baseY } = seg;
  const dx = bx - ax, dz = bz - az;
  const wallLen = Math.sqrt(dx * dx + dz * dz);
  if (wallLen < 1e-6 || tEnd - tStart < 1e-6) return;
  const ux = dx / wallLen, uz = dz / wallLen;
  const segLen = tEnd - tStart;
  addMesh(parent, new THREE.BoxGeometry(segLen, height, width), mat,
    pose(ax + ux * (tStart + tEnd) / 2, baseY + height / 2, az + uz * (tStart + tEnd) / 2, Math.atan2(dz, dx)),
    node, 'wall', nodeMap);
}

export function buildSceneGeometry(
  scene: THREE.Scene,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  ifcGroupCache: Map<string, IFCGroupInfo>,
  matConfig: MaterialConfig | null,
): THREE.Group {
  nodes = expandArrayNodes(nodes);  // expand array_x/y/z into virtual copies
  const nodeMap  = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  const matCache = new Map<string, THREE.MeshStandardMaterial>();

  const root = new THREE.Group(); root.name = SCENE_ROOT;
  const projectGrp  = new THREE.Group(); projectGrp.name  = 'IfcProject';
  const buildingGrp = new THREE.Group(); buildingGrp.name = 'IfcBuilding';
  projectGrp.add(buildingGrp);
  root.add(projectGrp);

  const storeyNodes = nodes.filter((n) => n.type === 'storey');
  const storeyMap   = new Map<string, THREE.Group>();
  const allBots = storeyNodes.map((s) => Number(s.properties.bottomElevation ?? 0));
  const allTops = storeyNodes.map((s) => Number(s.properties.topElevation   ?? 3000));
  const globalBot = allBots.length ? Math.min(...allBots) : 0;
  const globalTop = allTops.length ? Math.max(...allTops) : 3000;

  for (const s of storeyNodes) {
    const bot = Number(s.properties.bottomElevation ?? 0);
    const top = Number(s.properties.topElevation   ?? 3000);
    const { cXm, cZm, planWm, planDm } = calcStoreyPlanExtents(s, nodes);
    const sg = new THREE.Group(); sg.name = `IfcBuildingStorey_${s.name || s.id}`;
    buildingGrp.add(sg); storeyMap.set(s.id, sg);
    const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(planWm, planDm),
      new THREE.MeshStandardMaterial({ color: 0x383848, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
    floorMesh.rotation.x = -Math.PI / 2; floorMesh.position.set(cXm, bot * MM, cZm);
    floorMesh.userData.nodeType = 'storey';
    floorMesh.userData.nodeId   = s.id;
    floorMesh.userData.storeyId = s.id;
    sg.add(floorMesh);
    const ceilMesh = new THREE.Mesh(new THREE.PlaneGeometry(planWm, planDm),
      new THREE.MeshStandardMaterial({ color: 0x4488dd, transparent: true, opacity: 0.18, side: THREE.DoubleSide }));
    ceilMesh.rotation.x = -Math.PI / 2; ceilMesh.position.set(cXm, top * MM, cZm);
    ceilMesh.userData.nodeType = 'storey';
    ceilMesh.userData.nodeId   = s.id;
    ceilMesh.userData.storeyId = s.id;
    sg.add(ceilMesh);
  }

  const fallbackGrp = new THREE.Group(); fallbackGrp.name = 'IfcBuilding_orphaned'; buildingGrp.add(fallbackGrp);
  const nodeGroupCache = new Map<string, THREE.Group>();
  const getGroup = (n: BubbleGraphNode): THREE.Group => {
    if (nodeGroupCache.has(n.id)) return nodeGroupCache.get(n.id)!;
    const parent = (n.parentId ? storeyMap.get(n.parentId) : undefined) ?? fallbackGrp;
    const ng = new THREE.Group();
    ng.name = `Node_${n.type}_${n.id}`;
    ng.userData.nodeId = n.id;
    parent.add(ng);
    nodeGroupCache.set(n.id, ng);
    return ng;
  };

  const allAxesX = new Set<number>(); const allAxesY = new Set<number>();
  for (const s of storeyNodes) {
    parseAxes(s.properties.axesX).forEach((v) => allAxesX.add(v));
    parseAxes(s.properties.axesY).forEach((v) => allAxesY.add(v));
  }
  const uniqueX = [...allAxesX].sort((a, b) => a - b); const uniqueY = [...allAxesY].sort((a, b) => a - b);
  const pad = 1000;
  const gXmin = uniqueX.length ? (uniqueX[0] - pad) * MM : -5;
  const gXmax = uniqueX.length ? (uniqueX[uniqueX.length - 1] + pad) * MM : 5;
  const gZmin = uniqueY.length ? -(uniqueY[uniqueY.length - 1] + pad) * MM : -5;
  const gZmax = uniqueY.length ? -(uniqueY[0] - pad) * MM : 5;
  const gridY = globalBot * MM - 0.02;
  const lm = new THREE.LineBasicMaterial({ color: 0x4488dd, transparent: true, opacity: 0.4 });
  const ln = (a: THREE.Vector3, b: THREE.Vector3, storeyId?: string) => {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), lm);
    line.userData.nodeType = 'storey';
    if (storeyId) line.userData.storeyId = storeyId;
    root.add(line);
  };
  for (const s of storeyNodes) {
    const sAxX = parseAxes(s.properties.axesX);
    const sAxY = parseAxes(s.properties.axesY);
    const sMinX = sAxX.length ? (Math.min(...sAxX) - pad) * MM : gXmin;
    const sMaxX = sAxX.length ? (Math.max(...sAxX) + pad) * MM : gXmax;
    const sMinZ = sAxY.length ? -(Math.max(...sAxY) + pad) * MM : gZmin;
    const sMaxZ = sAxY.length ? -(Math.min(...sAxY) - pad) * MM : gZmax;
    for (const xMm of sAxX) {
      const bx = xMm * MM;
      ln(new THREE.Vector3(bx, gridY, sMinZ), new THREE.Vector3(bx, gridY, sMaxZ), s.id);
      ln(new THREE.Vector3(bx, globalBot * MM, sMinZ), new THREE.Vector3(bx, globalTop * MM, sMinZ), s.id);
    }
    for (const yMm of sAxY) {
      const bz = -yMm * MM;
      ln(new THREE.Vector3(sMinX, gridY, bz), new THREE.Vector3(sMaxX, gridY, bz), s.id);
      ln(new THREE.Vector3(sMinX, globalBot * MM, bz), new THREE.Vector3(sMinX, globalTop * MM, bz), s.id);
    }
  }
  // ─── Add BIM-aware axes gizmo (X=East/red, Y=Up/blue, Z=North/green) ────────
  const addBimAxes = (group: THREE.Group, length: number = 1): void => {
    // X-axis (East, red)
    const xLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(length, 0, 0),
      ]),
      new THREE.LineBasicMaterial({ color: 0xE63946, linewidth: 2 })
    );
    group.add(xLine);

    // Y-axis (Up, blue)
    const yLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, length, 0),
      ]),
      new THREE.LineBasicMaterial({ color: 0x4088F2, linewidth: 2 })
    );
    group.add(yLine);

    // Z-axis (North, green) — BIM Y maps to Three.js -Z
    const zLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -length),
      ]),
      new THREE.LineBasicMaterial({ color: 0x33CC33, linewidth: 2 })
    );
    group.add(zLine);
  };
  addBimAxes(root, 1);

  // Columns grouped by (type x storey) for instancing
  const colsBucket = new Map<string, { w: number; h: number; d: number; circular: boolean; node: BubbleGraphNode | undefined; storeyId: string | undefined; grp: THREE.Group; matrices: THREE.Matrix4[] }>();
  const pushColumn = (rx: number, ry: number, colType: string, storeyNode: BubbleGraphNode | undefined, grp: THREE.Group, srcNode?: BubbleGraphNode) => {
    if (!storeyNode) return;
    const bot = Number(storeyNode.properties.bottomElevation ?? 0);
    const top = Number(storeyNode.properties.topElevation   ?? 3000);
    const h = (top - bot) * MM; const { w, d, circular } = parseColumnDims(colType);
    const ltr = srcNode ? getNodeLocalTransform(srcNode) : null;

    // Columns with rotation overrides can't share an instance matrix — render individually
    if (ltr && (ltr.rx || ltr.ry || ltr.rz)) {
      const colGeo = circular ? new THREE.CylinderGeometry(w / 2, w / 2, h, 18) : new THREE.BoxGeometry(w, h, d);
      const colVis = srcNode ? applyNodeColorOverrides(resolveVisuals('column', String(srcNode.properties.material ?? ''), matConfig), srcNode.properties) : null;
      const txM = ltr.tx * MM; const tyM = ltr.tz * MM; const tzM = -ltr.ty * MM;
      addMesh(grp, colGeo, getMat(matCache, 'column', 1, colVis),
        pose(rx * MM + txM, (bot + (top - bot) / 2) * MM + tyM, -ry * MM + tzM), srcNode, undefined, nodeMap);
      return;
    }

    // Bucket key includes color + material so each visual variant gets its own InstancedMesh
    const colKey = `${String(srcNode?.properties.color_3d ?? '')}|${String(srcNode?.properties.material ?? '')}`;
    const key = `${storeyNode.id}|${colType}|${Math.round(h * 1e4)}|${colKey}`;
    if (!colsBucket.has(key)) colsBucket.set(key, { w, h, d, circular, node: srcNode, storeyId: storeyNode.id, grp, matrices: [] });
    // Bake translation offsets into the per-instance matrix
    const txM = ltr ? ltr.tx * MM : 0;
    const tyM = ltr ? ltr.tz * MM : 0;  // BIM tz (up) → Three.js Y
    const tzM = ltr ? -ltr.ty * MM : 0; // BIM ty (north) → Three.js -Z
    colsBucket.get(key)!.matrices.push(pose(rx * MM + txM, (bot + (top - bot) / 2) * MM + tyM, -ry * MM + tzM));
  };
  for (const n of nodes.filter((n) => n.type === 'column'))
    pushColumn(n.x, n.y, String(n.properties.column_type ?? 'C25x25'), n.parentId ? nodeMap.get(n.parentId) : undefined, getGroup(n), n);
  for (const n of nodes.filter((n) => n.type === 'ax')) {
    const { x: rx, y: ry } = getAxRealPos(n, nodeMap);
    const hasCol = String(n.properties.has_column ?? '').toLowerCase() === 'true';
    if (hasCol) pushColumn(rx, ry, String(n.properties.column_type ?? 'C25x25'), n.parentId ? nodeMap.get(n.parentId) : undefined, getGroup(n), n);
    else { const { bot } = getStoreyBand(n, nodeMap); addMesh(getGroup(n), new THREE.BoxGeometry(0.12, 0.04, 0.12), getMat(matCache, 'ax', 1, resolveVisuals('ax', String(n.properties.material ?? ''), matConfig)), pose(rx * MM, bot * MM, -ry * MM), n, undefined, nodeMap); }
  }
  for (const { w, h, d, circular, node: colNode, storeyId: colStoreyId, grp, matrices } of colsBucket.values()) {
    const colGeo = circular ? new THREE.CylinderGeometry(w / 2, w / 2, h, 18) : new THREE.BoxGeometry(w, h, d);
    addInstanced(grp, colGeo, getMat(matCache, 'column', 1, colNode ? applyNodeColorOverrides(resolveVisuals('column', String(colNode.properties.material ?? ''), matConfig), colNode.properties) : null), matrices.map((matrix) => ({ matrix })), 'column', colStoreyId);
  }

  // allOpeningCutters accumulated during the wall loop, reused for shell/covering CSG
  const allOpeningCutters: ReturnType<typeof makeBoxOpeningCutter>[] = [];
  for (const wn of nodes.filter((n) => n.type === 'wall')) {
    const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins); if (!geo) continue;
    const grp = getGroup(wn);
    const layers = resolveWallLayers(wn.properties, geo.wallH);
    const isArc = geo.footprint.length > 4;

    const cutters = geo.openings.map((op) => {
      const typeId  = String(op.isDoor ? (op.node.properties.door_type ?? '') : (op.node.properties.window_type ?? ''));
      const ifcPath = resolveIfcPath(op.isDoor ? 'door' : 'window', typeId);
      const ifcInfo = ifcPath ? ifcGroupCache.get(ifcPath) : null;
      const c = ifcInfo
        ? makeIfcOpeningCutter(ifcInfo.widthM, ifcInfo.heightM, op)
        : makeBoxOpeningCutter(op);
      allOpeningCutters.push(c);
      return c;
    });

    let builtLayer = false;
    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
      const layer = layers[layerIdx];
      const layerNode = syntheticWallNodeForLayer(wn, layer);
      const baseVis = resolveVisuals('wall', String(layer.material ?? ''), matConfig);
      const vis = applyNodeColorOverrides(baseVis, layerNode.properties);
      const wallMat = getMat(matCache, 'wall', 1, vis);
      let wallSolid: THREE.Mesh;
      try {
        wallSolid = (geo.openings.length === 0 || isArc)
          ? wallHorizontalProfileLayerMesh(geo, layer.fromMm, layer.toMm, wallMat)
          : wallSolidLayerMesh(geo, layer.fromMm, layer.toMm, wallMat);
      } catch {
        continue;
      }
      const wm = applyOpeningVoids(wallSolid, cutters);
      wm.userData.nodeType = 'wall';
      wm.userData.nodeId   = wn.id;
      wm.userData.storeyId = resolveStoreyId(wn, nodeMap);
      if (layerIdx === 0) {
        const MM = 0.001;
        wm.userData.wallPlanPoly = geo.footprint.map((p) => ({
          x: p.x * MM,
          z: -p.y * MM,
        }));
        wm.userData.wallBotM = geo.botM;
        const wallTopM = geo.solidSegs.reduce((mx, s) => Math.max(mx, s.baseY + s.height), geo.botM + 2.5);
        wm.userData.wallTopM = wallTopM;
      }
      grp.add(wm);
      applyNodeLocalTransformThree(wm, getNodeLocalTransform(wn));
      builtLayer = true;
    }

    if (!builtLayer) {
      const wallMat = getMat(matCache, 'wall', 1, resolveVisuals('wall', String(wn.properties.material ?? ''), matConfig));
      geo.solidSegs.forEach((seg) => wallSegMesh(grp, seg, wallMat, wn, nodeMap));
      continue;
    }

    for (const op of geo.openings) {
      const nt = op.isDoor ? 'door' : 'window';
      const { isDoor, cx, cz, nx, nz, botY, oW, oH, sill } = op;

      // ── IFC library mesh ────────────────────────────────────────────────
      const typeId  = String(isDoor ? (op.node.properties.door_type ?? '') : (op.node.properties.window_type ?? ''));
      const ifcPath = resolveIfcPath(isDoor ? 'door' : 'window', typeId);
      const ifcInfo    = ifcPath ? ifcGroupCache.get(ifcPath) : null;

      if (ifcInfo) {
        // Place IFC mesh: group local Y=0 = bottom of window = botY + sill
        const placed = positionIfcGroup(
          ifcInfo,
          cx,
          botY + sill,
          cz,
          nx, nz,
          oW, oH,
        );
        placed.userData.nodeType = nt;
        applyIfcGlazingOverrides(placed, resolveWindowGlazing(matConfig));
        if (op.node) {
          const flipAlong  = String(op.node.properties.flip_along  ?? '').toLowerCase() === 'true';
          const flipAcross = String(op.node.properties.flip_across ?? '').toLowerCase() === 'true';
          if (flipAlong)  placed.scale.x *= -1;
          if (flipAcross) placed.scale.z *= -1;
          applyNodeLocalTransformThree(placed, getNodeLocalTransform(op.node));
          const opStoreyId = resolveStoreyId(op.node, nodeMap);
          placed.userData.nodeId   = op.node.id;
          placed.userData.storeyId = opStoreyId;
          placed.traverse((c) => {
            c.userData.nodeId   = op.node.id;
            c.userData.nodeType = nt;
            c.userData.storeyId = opStoreyId;
          });
        }
        grp.add(placed);
        continue; // skip generic frame+glass for this opening
      }

      // ── Generic frame + glass with double-mullion and physical glass (fallback) ──
      const nt2 = nt;
      const vis = op.node ? resolveVisuals(nt2, String(op.node.properties.material ?? ''), matConfig) : null;
      const prevChildCount = grp.children.length;
      buildOpeningMeshes3(op, new Map(), nt2, vis, resolveWindowGlazing(matConfig)).forEach((m) => {
        m.userData.nodeType = nt2;
        if (op.node) {
          m.userData.nodeId   = op.node.id;
          m.userData.storeyId = resolveStoreyId(op.node, nodeMap);
        }
        grp.add(m);
      });
      if (op.node) {
        const flipAlong  = String(op.node.properties.flip_along  ?? '').toLowerCase() === 'true';
        const flipAcross = String(op.node.properties.flip_across ?? '').toLowerCase() === 'true';
        const opStoreyId = resolveStoreyId(op.node, nodeMap);
        for (let ci = prevChildCount; ci < grp.children.length; ci++) {
          const child = grp.children[ci];
          if (flipAlong)  { child.scale.x *= -1; }
          if (flipAcross) { child.scale.z *= -1; }
          child.userData.nodeId   = op.node.id;
          child.userData.storeyId = opStoreyId;
        }
      }
    }
    if (geo.beamDesc) {
      const bd = geo.beamDesc; const dx = bd.bx - bd.ax; const dz = bd.bz - bd.az;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 1e-4) addMesh(grp, new THREE.BoxGeometry(len, bd.height, bd.width), getMat(matCache, 'beam', 1, resolveVisuals('beam', String(wn.properties.material ?? ''), matConfig)),
        pose((bd.ax + bd.bx) / 2, bd.baseY + bd.height / 2, (bd.az + bd.bz) / 2, Math.atan2(dz, dx)), undefined, 'beam');
    }
  }

  for (const bn of nodes.filter((n) => n.type === 'beam')) {
    const pts = getConnectedNodes(bn.id, edges, nodeMap); if (pts.length < 2) continue;
    const pA = getNodeBimPos(pts[0], nodeMap); const pB = getNodeBimPos(pts[1], nodeMap);
    const dx = pB.x - pA.x; const dy = pB.y - pA.y; const lenMm = Math.sqrt(dx * dx + dy * dy);
    if (lenMm < 1) continue;
    const { sx, sy, ex, ey } = calcSpanEffectiveEnds(bn, pA, pB, pts[0], pts[1], nodeMap);
    const bLen = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2);
    const { top } = getStoreyBand(bn, nodeMap);
    const { bw, bh } = parseBeamDims(String(bn.properties.beam_section ?? bn.properties.beam_type ?? 'B30x60'));
    addMesh(getGroup(bn), new THREE.BoxGeometry(bLen * MM, bh, bw), getMat(matCache, 'beam', 1, resolveVisuals('beam', String(bn.properties.material ?? ''), matConfig)),
      pose((sx + ex) / 2 * MM, top * MM - bh / 2, -(sy + ey) / 2 * MM, Math.atan2(-(ey - sy), ex - sx)), bn, undefined, nodeMap);
  }

  for (const n of nodes.filter((n) => n.type === 'slab')) {
    const { top } = getStoreyBand(n, nodeMap);
    const th = getNodeSlabThickness(n);
    const slabMat = getMat(matCache, 'slab', 1, applyNodeColorOverrides(resolveVisuals('slab', String(n.properties.material ?? ''), matConfig), n.properties));

    // Try polygon from direct ax/column connections (edge-order perimeter)
    let poly = calcShellPolygon(n, nodeMap, edges);
    if (poly && poly.length >= 3) {
      const rawOff = parseContourOffsets(n.properties.contour_offset);
      const inward = rawOff.map((o) => -o);
      if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);
      const shape = new THREE.Shape();
      shape.moveTo(poly[0].x * MM, poly[0].y * MM);
      for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x * MM, poly[i].y * MM);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      addMesh(getGroup(n), geo, slabMat, new THREE.Matrix4().makeTranslation(0, top * MM - th, 0), n, undefined, nodeMap);
    } else {
      // Fallback: bounding box from sibling positions
      const sibs = nodes.filter((s) => s.parentId === n.parentId && s.type !== 'storey');
      const xs = (sibs.length ? sibs : [n]).map((s) => s.x * MM); const zs = (sibs.length ? sibs : [n]).map((s) => -s.y * MM);
      const cxM = (Math.min(...xs) + Math.max(...xs)) / 2; const czM = (Math.min(...zs) + Math.max(...zs)) / 2;
      const contourOffM = parseContourOffsets(n.properties.contour_offset)[0] * MM;
      const sw = Math.max(Math.max(...xs) - Math.min(...xs) + 2 * contourOffM, 0.1);
      const sd = Math.max(Math.max(...zs) - Math.min(...zs) + 2 * contourOffM, 0.1);
      addMesh(getGroup(n), new THREE.BoxGeometry(sw, th, sd), slabMat, pose(cxM, top * MM - th / 2, czM), n, undefined, nodeMap);
    }
  }

  for (const n of nodes.filter((n) => n.type === 'foundation')) {
    const { bot } = getStoreyBand(n, nodeMap);
    addMesh(getGroup(n), new THREE.BoxGeometry(1.2, 0.5, 1.2), getMat(matCache, 'foundation', 1, resolveVisuals('foundation', String(n.properties.material ?? ''), matConfig)), pose(n.x * MM, (bot - 250) * MM, -n.y * MM), n, undefined, nodeMap);
  }

  // ── Roof surfaces ─────────────────────────────────────────────────────────
  // The solver already knows the shape; this scene only has to draw the faces
  // it returns. Everything downstream of buildSceneGeometry inherits them —
  // the ortho plan/section/elevation viewers and, via glTF, the Cesium world.
  //
  // Faces are flat, so they need their own material cache: getMat() only turns
  // on DoubleSide for translucent materials, and forcing it on a shared entry
  // would silently flip the side of every slab or wall that happens to share
  // the colour. A cache private to roofs makes that impossible.
  const roofMatCache = new Map<string, THREE.MeshStandardMaterial>();
  for (const rn of nodes.filter((n) => n.type === 'roof')) {
    let faces: RoofFace3D[];
    try {
      faces = computeRoofFaces(rn, nodes, edges).faces;
    } catch (err) {
      console.warn('[WebIfcViewer] roof solve failed:', rn.id, err);
      continue;
    }
    const surfaceNode = roofSurfaceNode(rn);
    const vis = applyNodeColorOverrides(
      resolveVisuals('roof', String(surfaceNode.properties.material ?? ''), matConfig),
      surfaceNode.properties,
    );
    const mat = getMat(roofMatCache, 'roof', 1, vis);
    mat.side = THREE.DoubleSide;
    const grp = getGroup(rn);
    for (const face of faces) {
      const geo = roofFaceGeometry(face);
      if (!geo) continue;
      // Vertices are already absolute BIM coordinates — no placement matrix.
      addMesh(grp, geo, mat, new THREE.Matrix4(), rn, undefined, nodeMap);
    }
  }

  for (const n of nodes.filter((n) => n.type === 'room')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const roomH = Number(n.properties.height ?? 2650); // mm
    const roomVis = resolveVisuals('room', String(n.properties.material ?? ''), matConfig);
    const [rr, rg, rb] = hexToRgb01(roomVis.color_3d);
    const roomMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(rr, rg, rb), transparent: true, opacity: roomVis.opacity_3d * 0.12,
    });

    // Build and optionally inset the room polygon
    let poly = calcRoomPolygon(n, nodeMap, edges);
    if (poly && poly.length >= 3) {
      const rawOff = parseContourOffsets(n.properties.contour_offset);
      const inward = rawOff.map((o) => -o);
      if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);
    }

    const extrudeShape = (shPoly: { x: number; y: number }[], depthM: number) => {
      const shape = new THREE.Shape();
      // Shape in X-Y plane; after rotateX(-PI/2): Three.js Z = -shape_y = -BIM_y → matches pose() convention
      shape.moveTo(shPoly[0].x * MM, shPoly[0].y * MM);
      for (let i = 1; i < shPoly.length; i++) shape.lineTo(shPoly[i].x * MM, shPoly[i].y * MM);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: depthM, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      return geo;
    };

    if (poly && poly.length >= 3) {
      const roomGeo = extrudeShape(poly, roomH * MM);
      addMesh(getGroup(n), roomGeo, roomMat, new THREE.Matrix4().makeTranslation(0, bot * MM, 0), n, 'room', nodeMap);
    } else {
      addMesh(getGroup(n), new THREE.BoxGeometry(4, roomH * MM * 0.95, 4), roomMat,
        pose(n.x * MM, (bot + roomH / 2) * MM, -n.y * MM), n, 'room', nodeMap);
    }

    // Room slab — starts at top face of room
    const hasSlab = n.properties.has_slab !== 'False' && n.properties.has_slab !== false;
    if (hasSlab) {
      const slabTh = getNodeSlabThickness(n); // metres
      const slabVis = applyNodeColorOverrides(resolveVisuals('slab', String(n.properties.slab_material ?? ''), matConfig), n.properties);
      const slabMat = getMat(matCache, 'slab_room_' + n.id, 1, slabVis);
      if (poly && poly.length >= 3) {
        const slabGeo = extrudeShape(poly, slabTh);
        addMesh(getGroup(n), slabGeo, slabMat, new THREE.Matrix4().makeTranslation(0, (bot + roomH) * MM, 0), n, 'slab', nodeMap);
      } else {
        addMesh(getGroup(n), new THREE.BoxGeometry(4, slabTh, 4), slabMat,
          pose(n.x * MM, (bot + roomH) * MM + slabTh / 2, -n.y * MM), n, 'slab', nodeMap);
      }
    }
  }

  // ── Shell & Covering (ring extrusion from ax nodes) ────────────────────────
  // Opening cuts require per-face decomposition (Phase 2) — side holes in a
  // vertical ring extrusion cannot be expressed as ExtrudeGeometry Shape holes.
  const buildRingMesh = (
    poly: { x: number; y: number }[],
    offsets: number[],
    thickMm: number,
    heightM: number,
    botM: number,
    mat: THREE.Material,
  ): THREE.Mesh | null => {
    if (poly.length < 3) return null;
    const inward = offsets.map((o) => -o);
    const outer = insetPolygon(poly, inward);
    const inner = insetPolygon(poly, inward.map((v) => v + thickMm));
    if (outer.length < 3 || inner.length < 3) return null;

    const shape = new THREE.Shape();
    shape.moveTo(outer[0].x * MM, outer[0].y * MM);
    for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i].x * MM, outer[i].y * MM);
    shape.closePath();

    const rev = [...inner].reverse();
    const hole = new THREE.Path();
    hole.moveTo(rev[0].x * MM, rev[0].y * MM);
    for (let i = 1; i < rev.length; i++) hole.lineTo(rev[i].x * MM, rev[i].y * MM);
    hole.closePath();
    shape.holes.push(hole);

    const geo = new THREE.ExtrudeGeometry(shape, { depth: heightM, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(0, botM, 0);
    return m;
  };

  // Helper: attach ring polygon data to a mesh so section viewers can draw
  // exact per-segment cross-section fills (outer/inner polygon pair + height).
  const attachRingData = (
    m: THREE.Mesh,
    poly: { x: number; y: number }[],
    offsets: number[],
    thickMm: number,
    heightM: number,
    botM: number,
  ) => {
    const inward = offsets.map((o) => -o);
    m.userData.ringPolyOuter = insetPolygon(poly, inward);
    m.userData.ringPolyInner = insetPolygon(poly, inward.map((v) => v + thickMm));
    m.userData.ringBotM    = botM;
    m.userData.ringHeightM = heightM;
  };

  for (const n of nodes.filter((n) => n.type === 'shell')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const shellH = Number(n.properties.height ?? 2800) * MM;
    const thickMm = Number(n.properties.thickness ?? 200);
    const poly = calcShellPolygon(n, nodeMap, edges);
    if (!poly) continue;
    const offsets = parseContourOffsets(n.properties.contour_offset);
    // Benzile anvelopei: soclul și câmpul sunt lucrări diferite, deci se
    // desenează diferit. Fără benzi, un singur inel, ca până acum.
    const bands = renderBandsOf(n, shellH)
      ?? [{ fromM: 0, heightM: shellH, material: undefined, label: '' }];
    for (const band of bands) {
      const mat = getMat(matCache, 'shell', 1, resolveVisuals(
        'shell', band.material ?? String(n.properties.material ?? ''), matConfig));
      const bandBot = bot * MM + band.fromM;
      const rawMesh = buildRingMesh(poly, offsets, thickMm, band.heightM, bandBot, mat);
      if (!rawMesh) continue;
      rawMesh.userData.nodeType = 'shell'; rawMesh.userData.nodeId = n.id; rawMesh.userData.storeyId = resolveStoreyId(n, nodeMap);
      const m = allOpeningCutters.length ? applyOpeningVoids(rawMesh, allOpeningCutters) : rawMesh;
      m.userData.nodeType = 'shell'; m.userData.nodeId = n.id; m.userData.storeyId = resolveStoreyId(n, nodeMap);
      attachRingData(m, poly, offsets, thickMm, band.heightM, bandBot);
      getGroup(n).add(m);
    }
  }

  for (const n of nodes.filter((n) => n.type === 'covering')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const covH = Number(n.properties.height ?? 2650) * MM;
    const thickMm = Number(n.properties.thickness ?? 150);
    const poly = calcShellPolygon(n, nodeMap, edges);
    if (!poly) continue;
    const offsets = parseContourOffsets(n.properties.contour_offset);
    const mat = getMat(matCache, 'covering', 1, resolveVisuals('covering', String(n.properties.material ?? ''), matConfig));
    const rawMesh = buildRingMesh(poly, offsets, thickMm, covH, bot * MM, mat);
    if (rawMesh) {
      rawMesh.userData.nodeType = 'covering'; rawMesh.userData.nodeId = n.id; rawMesh.userData.storeyId = resolveStoreyId(n, nodeMap);
      const m = allOpeningCutters.length ? applyOpeningVoids(rawMesh, allOpeningCutters) : rawMesh;
      m.userData.nodeType = 'covering'; m.userData.nodeId = n.id; m.userData.storeyId = resolveStoreyId(n, nodeMap);
      attachRingData(m, poly, offsets, thickMm, covH, bot * MM);
      getGroup(n).add(m);
    }
  }

  // ── Room-derived covering (has_covering = True on room node) ───────────────
  for (const n of nodes.filter((n) => n.type === 'room')) {
    if (!roomHasCovering(n.properties)) continue;
    const { bot } = getStoreyBand(n, nodeMap);
    const offsets = parseContourOffsets(n.properties.covering_offset ?? n.properties.contour_offset);
    const poly = calcRoomPolygon(n, nodeMap, edges);
    if (!poly || poly.length < 3) continue;

    const layers = resolveCoveringLayers(n.properties);
    for (const layer of layers) {
      const covBot = (bot + layer.fromMm) * MM;
      const covH = layer.heightMm * MM;
      const baseVis = resolveVisuals('covering', String(layer.material ?? ''), matConfig);
      const vis = applyNodeColorOverrides(baseVis, {
        ...(layer.color3d ? { color_3d: layer.color3d } : {}),
      });
      const mat = getMat(matCache, 'covering', 1, vis);
      const rawMesh = buildRingMesh(poly, offsets, layer.thicknessMm, covH, covBot, mat);
      if (!rawMesh) continue;
      rawMesh.userData.nodeType = 'covering'; rawMesh.userData.nodeId = n.id; rawMesh.userData.storeyId = resolveStoreyId(n, nodeMap);
      const m = allOpeningCutters.length ? applyOpeningVoids(rawMesh, allOpeningCutters) : rawMesh;
      m.userData.nodeType = 'covering'; m.userData.nodeId = n.id; m.userData.storeyId = resolveStoreyId(n, nodeMap);
      attachRingData(m, poly, offsets, layer.thicknessMm, covH, covBot);
      getGroup(n).add(m);
    }
  }

  // ── Sweeps, domes, site ────────────────────────────────────────────────────
  // This builder feeds the globe and the georeferenced exports; anything it
  // does not know stays off the map. Same pure computes as the other viewers.
  for (const n of nodes.filter((n) => n.type === 'sweep')) {
    const res = computeSweep(n, nodeMap, edges);
    if (!res.placed || res.solids.length === 0) continue;
    const geo = sweepBufferGeometry(res.solids, res.placed);
    if (!geo) continue;
    const vis = applyNodeColorOverrides(resolveVisuals('sweep', String(n.properties.material ?? ''), matConfig), n.properties);
    const m = new THREE.Mesh(geo, getMat(matCache, 'sweep', 1, vis));
    m.userData.nodeType = 'sweep'; m.userData.nodeId = n.id; m.userData.storeyId = resolveStoreyId(n, nodeMap);
    getGroup(n).add(m);
  }
  for (const n of nodes.filter((n) => n.type === 'sketch')) {
    const res = computeSketch(n, nodeMap, edges);
    if (!res.placed || res.solids.length === 0) continue;
    const geo = sweepBufferGeometry(res.solids, res.placed);
    if (!geo) continue;
    const vis = applyNodeColorOverrides(resolveVisuals('sketch', String(n.properties.material ?? ''), matConfig), n.properties);
    const m = new THREE.Mesh(geo, getMat(matCache, 'sketch', 1, vis));
    m.userData.nodeType = 'sketch'; m.userData.nodeId = n.id; m.userData.storeyId = resolveStoreyId(n, nodeMap);
    getGroup(n).add(m);
  }
  {
    const siteNode = findSiteNode(nodes);
    const site = siteNode ? computeSite(siteNode, nodeMap, edges, currentTerrainModel()) : null;
    const heightAt = site?.frame ? site.heightAtBim : null;
    const emit = (inst: ScatterInstance[], n: BubbleGraphNode, type: string) => {
      const g = scatterGeometries(inst);
      for (const [geo, key] of [[g.foliage, 'scatter'], [g.wood, 'scatter_wood'], [g.stone, 'scatter_rock']] as const) {
        if (!geo) continue;
        const vis = applyNodeColorOverrides(resolveVisuals(key, String(n.properties.material ?? ''), matConfig), n.properties);
        const m = new THREE.Mesh(geo, getMat(matCache, key, 1, vis));
        m.userData.nodeType = type; m.userData.nodeId = n.id; m.userData.storeyId = resolveStoreyId(n, nodeMap);
        getGroup(n).add(m);
      }
    };
    for (const n of nodes.filter((n) => n.type === 'scatter')) emit(computeScatter(n, nodeMap, edges, heightAt).instances, n, 'scatter');
    if (site && siteNode && site.intent.showIn3d) emit(terrainItemInstances(site), siteNode, 'site');
  }

  for (const n of nodes.filter((n) => n.type === 'facade')) {
    const res = computeFacade(n, nodeMap, edges);
    if (res.cells.length === 0) continue;
    const g = facadeGeometries(res);
    for (const [geo, key, alpha, mat] of [
      [g.mullions, 'facade', 1, res.intent.material],
      [g.glass, 'facade_panel', 0.45, res.intent.glassMaterial],
      [g.opaque, 'facade_cassette', 1, res.intent.panelMaterial],
    ] as const) {
      if (!geo) continue;
      const vis = applyNodeColorOverrides(resolveVisuals(key, mat, matConfig), n.properties);
      const m = new THREE.Mesh(geo, getMat(matCache, key, alpha, vis));
      m.userData.nodeType = 'facade'; m.userData.nodeId = n.id; m.userData.storeyId = resolveStoreyId(n, nodeMap);
      getGroup(n).add(m);
    }
  }
  for (const n of nodes.filter((n) => n.type === 'dome')) {
    const res = computeDome(n, nodeMap, edges);
    if (res.placed && res.memberSolids.length) {
      const geo = sweepBufferGeometry(res.memberSolids, res.placed);
      if (geo) {
        const vis = applyNodeColorOverrides(resolveVisuals('dome', String(n.properties.material ?? ''), matConfig), n.properties);
        const m = new THREE.Mesh(geo, getMat(matCache, 'dome', 1, vis));
        m.userData.nodeType = 'dome'; m.userData.nodeId = n.id; m.userData.storeyId = resolveStoreyId(n, nodeMap);
        getGroup(n).add(m);
      }
    }
    const glass = domePanelGeometry(res.panels, res.intent.glassThicknessMm);
    if (glass) {
      const vis = resolveVisuals('dome_panel', res.intent.glassMaterial, matConfig);
      const m = new THREE.Mesh(glass, getMat(matCache, 'dome_panel', 0.45, vis));
      m.userData.nodeType = 'dome_panel'; m.userData.nodeId = n.id; m.userData.storeyId = resolveStoreyId(n, nodeMap);
      getGroup(n).add(m);
    }
  }
  {
    const siteNode = findSiteNode(nodes);
    if (siteNode) {
      const site = computeSite(siteNode, nodeMap, edges, currentTerrainModel());
      if (site.intent.showIn3d && site.frame) {
        const geo = terrainBufferGeometry(site);
        if (geo) {
          const vis = applyNodeColorOverrides(resolveVisuals('site', String(siteNode.properties.material ?? ''), matConfig), siteNode.properties);
          const m = new THREE.Mesh(geo, getMat(matCache, 'site', 1, vis));
          (m.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
          m.userData.nodeType = 'site'; m.userData.nodeId = siteNode.id; m.userData.storeyId = resolveStoreyId(siteNode, nodeMap);
          const sg = new THREE.Group(); sg.name = 'IfcSite'; sg.userData.nodeId = siteNode.id;
          sg.add(m); projectGrp.add(sg);
        }
      }
    }
  }

  scene.add(root);
  return root;
}

interface WebIfcViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes: BuildingAxes;
  className?: string;
  onSelectNode?: (nodeId: string | null) => void;
  selectedNodeId?: string | null;
}

// URL served by Vite dev server from node_modules.
// For production builds copy the file to public/fragments/worker.mjs (see docs/OBC_VIEWER.md).
const FRAGMENTS_WORKER_URL = '/node_modules/@thatopen/fragments/dist/Worker/worker.mjs';

// web-ifc wasm — loaded from CDN so no local copy is needed.
const WEBIFC_WASM_PATH    = 'https://unpkg.com/web-ifc@0.0.77/';

export function WebIfcViewer({ nodes, edges, buildingAxes: _buildingAxes, className, onSelectNode, selectedNodeId }: WebIfcViewerProps) {
  const containerRef    = useRef<HTMLDivElement>(null);
  const worldRef        = useRef<OBC.World | null>(null);
  const componentsRef   = useRef<OBC.Components | null>(null);
  const ifcLoaderRef    = useRef<OBC.IfcLoader | null>(null);
  const clipperRef      = useRef<OBC.Clipper | null>(null);
  const viewsRef        = useRef<OBC.Views | null>(null);
  const highlighterRef  = useRef<OBF.Highlighter | null>(null);
  const editorRef       = useRef<OBF.DrawingEditor | null>(null);
  const drawingRef      = useRef<any>(null);
  const [isReady, setIsReady]     = useState(false);
  const [loadingIfc, setLoadingIfc] = useState(false);
  // An element picked in an IMPORTED IFC (any fragments model that is not our
  // own graph). Our own elements go through onSelectNode to the inspector;
  // foreign ones have no node to select, so their properties are shown here.
  const [ifcPick, setIfcPick] = useState<{ loading: boolean; element: IfcElementProperties | null } | null>(null);
  // ── Drawn extrusions ───────────────────────────────────────────────────────
  // The contour plane here is elevation zero: this viewer has no terrain, and
  // the graph's own storeys are measured from the same datum.
  const [extrudeOpen, setExtrudeOpen] = useState(false);
  const extrusions = useExtrusions({
    elevation: () => 0,
    onProblem: (m) => setExtrudeProblem(m),
  });
  const [extrudeProblem, setExtrudeProblem] = useState<string | null>(null);
  // Every IFC file loaded into this viewer, so more than one can be open and
  // each can be hidden or closed on its own.
  const [ifcModels, setIfcModels] = useState<{ id: string; name: string; visible: boolean }[]>([]);
  const ifcModelsRef = useRef<{ id: string; name: string; visible: boolean }[]>([]);
  useEffect(() => { ifcModelsRef.current = ifcModels; }, [ifcModels]);
  // The toolbar's HTML export carries what is open and shown here. The model
  // is looked up when the export runs, so a model closed since is not.
  const instanceId = useId();
  /** The IFC each model came from — the export reads what fragments drops. */
  const ifcFilesRef = useRef(new Map<string, File>());
  useEffect(() => {
    const keys: string[] = [];
    for (const m of ifcModels) {
      if (!m.visible) continue;
      const key = `toc${instanceId}${m.id}`;
      registerLoadedIfc({
        key, name: m.name,
        getModel: () => componentsRef.current?.get(OBC.FragmentsManager).list.get(m.id),
        file: ifcFilesRef.current.get(m.id),
      });
      keys.push(key);
    }
    return () => { for (const k of keys) unregisterLoadedIfc(k); };
  }, [ifcModels, instanceId]);
  const extrudeGroupRef = useRef<THREE.Group | null>(null);
  /** Where the cursor last was on the contour plane, for the rubber band. */
  const [contourCursor, setContourCursor] = useState<Pt2 | null>(null);
  const contourCursorRef = useRef<Pt2 | null>(null);
  const finishDrawRef = useRef(extrusions.finishDraw);
  const addPointRef = useRef(extrusions.addPoint);
  const cancelDrawRef = useRef(extrusions.cancelDraw);
  useEffect(() => {
    finishDrawRef.current = extrusions.finishDraw;
    addPointRef.current = extrusions.addPoint;
    cancelDrawRef.current = extrusions.cancelDraw;
  }, [extrusions.finishDraw, extrusions.addPoint, extrusions.cancelDraw]);

  const [clipperActive, setClipperActive] = useState(false);
  const [activeViewMode, setActiveViewMode] = useState<'3d' | 'plan' | 'elevation'>('3d');
  const [activeTool, setActiveTool] = useState<AnnotationTool | null>(null);
  const [dayMode, setDayMode] = useState(false);
  const onSelectNodeRef = useRef(onSelectNode);
  useEffect(() => { onSelectNodeRef.current = onSelectNode; }, [onSelectNode]);

  // ── Visibility filter (local to this viewer instance) ─────────────────────
  const [hiddenTypes, setHiddenTypes]         = useState<Set<string>>(new Set());
  const [hiddenStoreyIds, setHiddenStoreyIds] = useState<Set<string>>(new Set());

  // ── The model as the exported IFC ──────────────────────────────────────────
  // The graph is shown through the same file a user downloads: built by the
  // exporter, converted by That Open's own IfcLoader into the BIM fragments
  // model. Whatever the export holds — every method's geometry, styles,
  // dormers, roof framing — this view holds, with no second implementation to
  // fall behind it. The scene's own geometry keeps only what the export does
  // not write (storey planes, terrain, scatter, library objects), and returns
  // in full if the IFC cannot be loaded.
  const { model: modelIfc, error: modelIfcError } = useModelIfc(nodes, edges, 'BubbleGraph');
  /** 'pending' until the first model is in; 'failed' falls back to the scene's own elements. */
  const bimIfcStateRef = useRef<'pending' | 'ready' | 'failed'>('pending');
  const [bimModelVersion, setBimModelVersion] = useState(0);
  const [bimLoading, setBimLoading] = useState(false);
  /** One IfcLoader run at a time: the model and dropped files share its worker. */
  const loadLockRef = useRef<Promise<unknown>>(Promise.resolve());
  const withLoadLock = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = loadLockRef.current.then(fn, fn);
    loadLockRef.current = next.catch(() => {});
    return next;
  }, []);
  const nodesMapRef = useRef<Map<string, BubbleGraphNode>>(new Map());
  useEffect(() => {
    nodesMapRef.current = new Map(nodes.map((n) => [n.id, n]));
  }, [nodes]);
  const { visibleTypes, typeCounts } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
    if (!counts['storey'] && nodes.some((n) => n.type === 'storey'))
      counts['storey'] = nodes.filter((n) => n.type === 'storey').length;
    // Virtual 'column' category: ax nodes with has_column=true
    if (!counts['column']) {
      const c = nodes.filter((n) => n.type === 'ax' && String(n.properties.has_column ?? '').toLowerCase() === 'true').length;
      if (c > 0) counts['column'] = c;
    }
    // Virtual 'beam' category: wall nodes with has_beam=true
    if (!counts['beam']) {
      const c = nodes.filter((n) => n.type === 'wall' && String(n.properties.has_beam ?? '').toLowerCase() === 'true').length;
      if (c > 0) counts['beam'] = c;
    }
    // Virtual 'covering' category: room nodes with has_covering truthy (default is true)
    if (!counts['covering']) {
      const c = nodes.filter((n) => n.type === 'room' && n.properties.has_covering !== 'False' && n.properties.has_covering !== false).length;
      if (c > 0) counts['covering'] = c;
    }
    return { visibleTypes: Object.keys(counts), typeCounts: counts };
  }, [nodes]);

  const { config: matConfig } = useMaterialConfig();
  // The ground is edited in the Terrain tab; this scene must follow it.
  const terrainModel = useBubbleGraphStore((st) => st.terrain);

  // IFC category lookup for fragments visibility toggling
  const FRAG_IFC_CATS: Record<string, string> = {
    column: 'IFCCOLUMN', ax: 'IFCCOLUMN', wall: 'IFCWALL', beam: 'IFCBEAM',
    slab: 'IFCSLAB', foundation: 'IFCFOOTING', room: 'IFCSPACE',
    shell: 'IFCROOF', covering: 'IFCCOVERING',
  };

  // ── Apply visibility whenever hiddenTypes / hiddenStoreyIds changes ──────────
  useEffect(() => {
    const world = worldRef.current;
    let scene: THREE.Scene | null = null;
    try { scene = world?.scene?.three as THREE.Scene ?? null; } catch { /* not ready */ }
    if (!scene) return;
    // Three.js objects (skip those hidden by fragments model)
    scene.traverse((obj) => {
      const t   = obj.userData.nodeType as string | undefined;
      const sid = obj.userData.storeyId as string | undefined;
      if (!t || obj.userData.hiddenByFragments) return;
      if (hiddenTypes.has(t)) { obj.visible = false; return; }
      if (hiddenStoreyIds.size > 0 && sid && hiddenStoreyIds.has(sid)) { obj.visible = false; return; }
      obj.visible = true;
    });
    // Fragments model element visibility (type-level only — storey-level via Three.js groups above)
    const components = componentsRef.current;
    if (components) {
      try {
        const frags = components.get(OBC.FragmentsManager);
        const model = frags.core.models.list.get(BIM_MODEL_ID);
        if (model) {
          (async () => {
            for (const [t, cat] of Object.entries(FRAG_IFC_CATS)) {
              const result = await model.getItemsOfCategories([new RegExp(`^${cat}$`)]);
              const items = result[cat] ?? [];
              if (items.length) model.setVisible(items, !hiddenTypes.has(t));
            }
            frags.core.update();
          })().catch(() => {});
        }
      } catch { /* model not yet loaded */ }
    }
  }, [hiddenTypes, hiddenStoreyIds, isReady]);

  // ── Selection highlight ────────────────────────────────────
  useEffect(() => {
    const world = worldRef.current;
    let threeScene: THREE.Scene | null = null;
    try { threeScene = world?.scene?.three as THREE.Scene ?? null; } catch { /* not ready */ }
    if (!threeScene) return;
    // Emissive highlight for Three.js objects (IFC library elements, storey, ax markers)
    threeScene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.userData.hiddenByFragments) return; // fragments handles these
      const mat = obj.material as THREE.MeshStandardMaterial;
      if (!mat || Array.isArray(mat)) return;
      if (obj.userData.nodeId && obj.userData.nodeId === selectedNodeId) {
        if (!obj.userData.originalEmissive) {
          obj.userData.originalEmissive = mat.emissive.clone();
          obj.userData.originalEmissiveIntensity = mat.emissiveIntensity;
        }
        mat.emissive.set(0xffd700);
        mat.emissiveIntensity = 0.6;
      } else if (obj.userData.originalEmissive) {
        mat.emissive.copy(obj.userData.originalEmissive);
        mat.emissiveIntensity = obj.userData.originalEmissiveIntensity ?? 0;
        delete obj.userData.originalEmissive;
        delete obj.userData.originalEmissiveIntensity;
      }
    });
    // OBF Highlighter for fragments model items
    const highlighter = highlighterRef.current;
    const components  = componentsRef.current;
    if (highlighter && components) {
      const frags = components.get(OBC.FragmentsManager);
      if (selectedNodeId) {
        getLocalIdsByBubbleId(frags.core, selectedNodeId).then((lids) => {
          if (lids.length) {
            highlighter.highlightByID('select', { [BIM_MODEL_ID]: new Set(lids) }, true, false)
              .catch(() => { /* model not ready yet */ });
          } else {
            highlighter.clear('select').catch(() => {});
          }
        }).catch(() => {});
      } else {
        // Deselecting a graph node must not wipe a highlight that belongs to
        // an imported IFC: picking a foreign element goes through here too
        // (it calls onSelectNode(null)), and clearing would undo the pick
        // the user just made.
        const sel = highlighter.selection['select'] ?? {};
        if (BIM_MODEL_ID in sel) {
          highlighter.clear('select', { [BIM_MODEL_ID]: sel[BIM_MODEL_ID] }).catch(() => {});
        }
      }
    }
  }, [selectedNodeId, bimModelVersion]);

  // ── OBC world init (runs once) ─────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const components = new OBC.Components();
    componentsRef.current = components;

    const worlds = components.get(OBC.Worlds);
    const world  = worlds.create<
      OBC.SimpleScene,
      OBC.OrthoPerspectiveCamera,
      OBF.PostproductionRenderer
    >();

    world.name     = 'Main';
    world.scene    = new OBC.SimpleScene(components);
    world.renderer = new OBF.PostproductionRenderer(components, container);
    world.camera   = new OBC.OrthoPerspectiveCamera(components);

    const cam = world.camera as OBC.OrthoPerspectiveCamera;
    cam.threePersp.near = 0.01;
    cam.threePersp.updateProjectionMatrix();
    cam.controls.restThreshold = 0.05;

    // ── Navigation ─────────────────────────────────────────────────────────
    // The defaults dolly towards the orbit target, which in a building model
    // means the zoom crawls once you are inside and overshoots from outside.
    // Zooming at the cursor is what every BIM viewer does and what makes a
    // model navigable without constantly re-centring.
    cam.controls.dollyToCursor = true;
    // Panning is proportional to distance, so the same drag moves the same
    // number of pixels of model whether you are at a door or above a site.
    cam.controls.truckSpeed = 4;
    cam.controls.dollySpeed = 1.2;
    // Enough damping to feel smooth, little enough to feel direct; dragging
    // gets less so the model tracks the cursor instead of trailing it.
    cam.controls.smoothTime = 0.12;
    cam.controls.draggingSmoothTime = 0.06;
    // Without a floor the dolly walks through the far side and inverts.
    cam.controls.minDistance = 0.5;
    // Middle-drag pans, which frees the right button for the context menu and
    // matches the habit from every other viewer in this app.
    cam.controls.mouseButtons.middle = 2;   // CameraControls.ACTION.TRUCK

    world.scene.setup();
    world.scene.three.background = new THREE.Color(0x1a1d23);

    // Grid
    const worldGrid = components.get(OBC.Grids).create(world);
    (worldGrid as any).material.uniforms.uColor.value = new THREE.Color(0x494b50);
    (worldGrid as any).material.uniforms.uSize1.value = 2;
    (worldGrid as any).material.uniforms.uSize2.value = 8;

    components.init();
    components.get(OBC.Raycasters).get(world);

    // Postprocessing
    const { postproduction } = world.renderer;
    postproduction.enabled = true;

    // FragmentsManager — enables IFC flat-buffer loading
    const fragments = components.get(OBC.FragmentsManager);
    fragments.init(FRAGMENTS_WORKER_URL);

    fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
      const isLod = 'isLodMaterial' in material && (material as unknown as { isLodMaterial: boolean }).isLodMaterial;
      if (isLod) world.renderer!.postproduction.basePass.isolatedMaterials.push(material as THREE.Material);
    });

    cam.projection.onChanged.add(() => {
      for (const [, model] of fragments.list) model.useCamera(cam.three);
    });

    cam.controls.addEventListener('rest', () => {
      fragments.core.update(true);
    });

    fragments.list.onItemSet.add(async ({ value: model }) => {
      model.useCamera(cam.three);
      model.getClippingPlanesEvent = () =>
        Array.from(world.renderer!.three.clippingPlanes) || [];
      world.scene.three.add(model.object);
      await fragments.core.update(true);
    });

    // IfcLoader (async setup — non-blocking)
    const ifcLoader = components.get(OBC.IfcLoader) as OBC.IfcLoader;
    ifcLoader.setup({
      autoSetWasm: false,
      wasm: { absolute: true, path: WEBIFC_WASM_PATH },
    }).then(() => {
      ifcLoaderRef.current = ifcLoader;
    }).catch((e) => console.error('[WebIfcViewer] IfcLoader setup failed:', e));

    // ── Clipper — interactive section planes ────────────────────────────────
    const clipper = components.get(OBC.Clipper);
    clipper.enabled = false; // off by default; user toggles via toolbar
    clipperRef.current = clipper;

    // ── ClipEdges — stylized cut edges on loaded IFC fragment models ────────
    // ClipEdges/ClipStyler work with FragmentsManager models.
    // When a clipping plane is created, it triggers styled edge/fill rendering
    // for any IFC models currently loaded in the scene.
    try {
      const clipStyler = components.get(OBF.ClipStyler);
      clipStyler.styles.set('default', {
        linesMaterial: new THREE.LineBasicMaterial({ color: 0x000000 }) as any,
        fillsMaterial: new THREE.MeshBasicMaterial({ color: 0xbcbcbc, side: THREE.DoubleSide }),
      });
    } catch (e) {
      console.warn('[WebIfcViewer] ClipStyler setup skipped:', e);
    }

    // ── OBF Highlighter — tile-level highlight for fragments model items ─────
    try {
      const highlighter = components.get(OBF.Highlighter);
      highlighter.setup({ world });
      // Disable the Highlighter's own mouseup click-to-select: we manage selection
      // in our click handler so we can also fall back to Three.js raycasting.
      // autoToggle for 'select' (added by setup()) would deselect on the second
      // highlight() call from our click event — remove it to prevent that.
      highlighter.config.autoHighlightOnClick = false;
      highlighter.autoToggle.delete(highlighter.config.selectName);
      highlighter.zoomToSelection = false;
      highlighter.styles.set('select', {
        color: new THREE.Color(0xffd700),
        renderedFaces: 1,
        opacity: 1,
        transparent: false,
      });
      highlighterRef.current = highlighter;

      // ── Selection in an IMPORTED IFC → GUID + properties panel ────────────
      // Hooked on the Highlighter's own event rather than on our click
      // handler: whatever puts an element into the 'select' set — a click, a
      // host's BIM_FOCUS_GUID, a later feature — lands here, so the panel and
      // the console line cannot drift out of step with the highlight.
      highlighter.events.select.onHighlight.add((map) => {
        for (const [mId, lids] of Object.entries(map)) {
          if (mId === BIM_MODEL_ID) continue;
          const first = (lids as Set<number>).values().next();
          if (first.done) continue;
          const model = fragments.list.get(mId);
          if (!model) continue;
          const localId = first.value;
          setIfcPick({ loading: true, element: null });
          Promise.all([readItemGuid(model, localId), readItemProperties(model, localId)])
            .then(([guid, element]) => {
              getHostBridge().reportSelection({
                viewer: 'toc', modelId: mId, localId,
                guid: guid ?? element?.guid ?? null,
                category: element?.category ?? null, name: element?.name ?? null,
              });
              setIfcPick({ loading: false, element });
            })
            .catch((err) => {
              console.warn('[WebIfcViewer] IFC properties read failed:', err);
              setIfcPick({ loading: false, element: null });
            });
          return;
        }
      });
    } catch (e) {
      console.warn('[WebIfcViewer] Highlighter setup skipped:', e);
    }

    // ── Views — orthographic floor plan / elevation camera management ───────
    const views = components.get(OBC.Views);
    views.world = world;
    viewsRef.current = views;

    // ── TechnicalDrawings + DrawingEditor (annotation tools) ─────────────────
    try {
      const techDrawings = components.get(OBC.TechnicalDrawings);
      const drawing = techDrawings.create(world);
      drawing.orientTo(new THREE.Vector3(0, -1, 0)); // looking down (plan view)
      (drawing as any).far = 50;
      drawingRef.current = drawing;

      const editor = components.get(OBF.DrawingEditor);
      editor.enabled = true;
      editor.setSource(world);
      editor.fonts
        .load('/fonts/kenpixel.ttf')
        .catch(() => {});

      // Create all tools BEFORE setting activeDrawing so they receive the onDrawingChange notification
      const linearTool  = editor.use(OBF.LinearAnnotationsTool);
      const angleTool   = editor.use(OBF.AngleAnnotationsTool);
      const calloutTool = editor.use(OBF.CalloutAnnotationsTool);
      const leaderTool  = editor.use(OBF.LeaderAnnotationsTool);
      const slopeTool   = editor.use(OBF.SlopeAnnotationsTool);

      (calloutTool as any).onEnterText?.add?.(({ isEdit, currentText }: any) => {
        const text = window.prompt(isEdit ? 'Edit:' : 'Callout text:', currentText ?? '') ?? currentText ?? '';
        (calloutTool as any).submitText(text);
      });

      const DIM_STYLE = {
        color: 0x90caf9, fontSize: 0.25, textOffset: 0.35, tickSize: 0.2,
        extensionGap: 0.04, extensionOvershoot: 0.15,
        unit: OBC.Units.m, lineTick: OBC.DiagonalTick, meshTick: OBC.FilledArrowTick,
      };
      for (const tool of [linearTool, angleTool, leaderTool, slopeTool] as any[]) {
        tool?.system?.styles?.set('default', DIM_STYLE);
      }
      (calloutTool as any)?.system?.styles?.set('default', {
        ...DIM_STYLE, enclosure: OBC.CloudEnclosure,
      });

      // Set activeDrawing AFTER tools exist — setter notifies tools via onDrawingChange
      editor.activeDrawing = drawing;
      editorRef.current = editor;
    } catch (e) {
      console.warn('[WebIfcViewer] DrawingEditor setup skipped:', e);
    }

    // Resize
    const onResize = () => {
      world.renderer?.resize();
      cam.updateAspect();
    };
    window.addEventListener('resize', onResize);
    // Same reason as the Three.js viewers: a side panel opening changes the
    // container without a window resize, and the canvas would stay oversized.
    const ro = new ResizeObserver(onResize);
    if (containerRef.current) ro.observe(containerRef.current);

    worldRef.current = world;
    setIsReady(true);

    // ── Click-to-select raycaster ──────────────────────────────────────────
    const canvas = world.renderer.three.domElement;
    let clickDragDist = 0;
    let clickIsDown = false;
    let clickStartX = 0; let clickStartY = 0;
    const onMousedownClick = (e: MouseEvent) => { clickStartX = e.clientX; clickStartY = e.clientY; clickDragDist = 0; clickIsDown = true; };
    const onMouseupClick   = () => { clickIsDown = false; };
    const onMousemoveClick = (e: MouseEvent) => {
      // The rubber band to the cursor: without it you are clicking blind,
      // because nothing shows the edge you are about to commit to.
      if (extrusions.drawingRef.current) {
        const p = planePoint(e);
        if (p && (contourCursorRef.current?.x !== p.x || contourCursorRef.current?.y !== p.y)) {
          contourCursorRef.current = p;
          setContourCursor(p);
        }
      }
      if (!clickIsDown) return; // only accumulate while button held
      const dx = e.clientX - clickStartX; const dy = e.clientY - clickStartY;
      clickDragDist += Math.sqrt(dx * dx + dy * dy);
      clickStartX = e.clientX; clickStartY = e.clientY;
    };
    /**
     * Where a screen position lands on the contour plane (elevation zero,
     * which is Three's y = 0), in drawing metres. Null when the ray runs
     * parallel to it or hits it behind the camera.
     */
    const planePoint = (e: MouseEvent): Pt2 | null => {
      const w = worldRef.current;
      if (!w) return null;
      const cam = (w.camera as OBC.OrthoPerspectiveCamera).three;
      const rect = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ), cam);
      const hit = ray.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3(),
      );
      // Three (x, y, z) → drawing (x east, y north): north is −z.
      return hit ? { x: hit.x, y: -hit.z } : null;
    };

    // Async click handler: tries Highlighter (fragments tiles) first,
    // then falls back to Three.js raycaster for IFC library elements.
    const onClickCanvasAsync = async (e: MouseEvent) => {
      if (clickDragDist > 4) return;
      if (!worldRef.current) return;

      // Drawing a contour takes the click before anything can be selected.
      if (extrusions.drawingRef.current) {
        const p = planePoint(e);
        if (p) addPointRef.current(p);
        return;
      }
      // Without a node callback there is still a pick to do — an imported
      // IFC's properties do not depend on anyone listening for graph nodes.
      const cb = onSelectNodeRef.current ?? (() => {});

      // ── Try Highlighter for fragments model tiles ────────────────────────
      const hl = highlighterRef.current;
      if (hl) {
        try {
          await hl.highlight('select', true, false);
          const sel = hl.selection?.['select'];
          if (sel) {
            const comps = componentsRef.current;
            if (comps) {
              const frags = comps.get(OBC.FragmentsManager);
              for (const [mId, lids] of Object.entries(sel)) {
                const first = (lids as Set<number>).values().next();
                if (first.done) continue;

                if (mId !== BIM_MODEL_ID) {
                  // An imported IFC. Nothing in the graph corresponds to it,
                  // so it is not a node selection; the Highlighter's
                  // onHighlight (above, in setup) has already opened the
                  // properties panel and printed the GUID.
                  cb(null);
                  return;
                }

                for (const lid of (lids as Set<number>)) {
                  const bubbleId = await getBubbleIdByLocalId(frags.core, lid);
                  if (bubbleId) { setIfcPick(null); cb(bubbleId); return; }
                }
              }
            }
          }
        } catch (err) {
          // Fall through to the Three.js raycaster — but say so: a silent
          // catch here is exactly how "clicking does nothing" stays unexplained.
          console.warn('[WebIfcViewer] fragments pick failed, falling back to raycaster:', err);
        }
      }

      // ── Fallback: Three.js raycaster for IFC library elements ────────────
      let threeScene: THREE.Scene | null = null;
      try { threeScene = worldRef.current.scene.three as THREE.Scene; } catch { return; }
      if (!threeScene) return;
      const camera = (worldRef.current.camera as OBC.OrthoPerspectiveCamera).three;
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      const ndcY = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const hits = raycaster.intersectObjects(threeScene.children, true);
      for (const hit of hits) {
        // Skip objects hidden by fragments or by visibility filter
        if (hit.object.userData.hiddenByFragments) continue;
        let checkNode: THREE.Object3D | null = hit.object;
        let invisible = false;
        while (checkNode) {
          if (!checkNode.visible) { invisible = true; break; }
          checkNode = checkNode.parent;
        }
        if (invisible) continue;

        let obj: THREE.Object3D | null = hit.object;
        while (obj) {
          if (obj.userData.nodeId) { cb(obj.userData.nodeId as string); return; }
          obj = obj.parent;
        }
      }
      cb(null); // nothing hit — deselect
    };
    const onClickCanvas = (e: MouseEvent) => {
      // Forward click to DrawingEditor for annotation tools (step = place point)
      editorRef.current?.step();
      onClickCanvasAsync(e).catch(() => {});
    };
    canvas.addEventListener('mousedown', onMousedownClick);
    canvas.addEventListener('mouseup',   onMouseupClick);
    canvas.addEventListener('mousemove', onMousemoveClick);
    canvas.addEventListener('click', onClickCanvas);

    // ── Double-click: create/delete clipping plane when Clipper is active ───
    const onDblClick = () => {
      // A double-click while drawing closes the contour. The click that came
      // with it already added its point, which is the behaviour every drawing
      // tool has: the last corner is where you finished.
      if (extrusions.drawingRef.current) { finishDrawRef.current(); return; }
      if (!clipperRef.current?.enabled) return;
      clipperRef.current.create(world);
    };
    canvas.addEventListener('dblclick', onDblClick);

    // ── Delete key: delete last clipping plane when Clipper active ───────────
    const onKeyDown = (e: KeyboardEvent) => {
      if (extrusions.drawingRef.current) {
        if (e.key === 'Enter') { e.preventDefault(); finishDrawRef.current(); return; }
        if (e.key === 'Escape') { e.preventDefault(); cancelDrawRef.current(); return; }
      }
      if (e.key === 'Delete' && clipperRef.current?.enabled) {
        clipperRef.current.delete(world);
      }
      if (e.key === 'Escape' && editorRef.current) {
        editorRef.current.cancel();
        setActiveTool(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      canvas.removeEventListener('mousedown', onMousedownClick);
      canvas.removeEventListener('mouseup',   onMouseupClick);
      canvas.removeEventListener('mousemove', onMousemoveClick);
      canvas.removeEventListener('click', onClickCanvas);
      canvas.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('keydown', onKeyDown);
      components.dispose();
    };
  }, []);

  // ── Draw the extrusions and the contour in progress ────────────────────────
  // One effect owns the whole group: it is emptied and rebuilt on every
  // change. The geometry already carries position, rotation and scale, so
  // there is no transform to keep in step — a parameter edit is a rebuild.
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !isReady) return;
    const scene = world.scene.three as THREE.Scene;
    let group = extrudeGroupRef.current;
    if (!group) {
      group = new THREE.Group();
      group.name = 'bb-extrusions';
      group.userData.skipVisibilityFilter = true;
      scene.add(group);
      extrudeGroupRef.current = group;
    }
    for (const child of [...group.children]) {
      group.remove(child);
      const m = child as THREE.Mesh | THREE.LineSegments;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    }

    for (const s of extrusions.solids) {
      const geo = extrudedSolidGeometry(s);
      if (!geo) continue;
      const selected = s.id === extrusions.selectedId;
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: new THREE.Color(s.color),
        transparent: true,
        opacity: selected ? 0.85 : 0.6,
        side: THREE.DoubleSide,
        roughness: 0.75,
      }));
      // Tagged so the existing pick loop can select it like any other object,
      // and skipped by the visibility filter, which speaks node types.
      mesh.userData.extrusionId = s.id;
      group.add(mesh);

      const edges = extrudedSolidEdges(s);
      if (edges) {
        group.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
          color: selected ? 0xffd700 : 0x111111,
          transparent: true,
          opacity: selected ? 1 : 0.45,
        })));
      }
    }

    // The contour being clicked out, with a rubber band to the cursor and the
    // closing edge shown dashed-in so the shape is legible before it exists.
    if (extrusions.drawing && extrusions.contour.length > 0) {
      const live = contourCursor ? [...extrusions.contour, contourCursor] : extrusions.contour;
      const line = contourLineGeometry(live, 0, live.length > 2);
      if (line) {
        group.add(new THREE.Line(line, new THREE.LineBasicMaterial({ color: 0x38bdf8 })));
      }
      for (const p of extrusions.contour) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.12, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0x38bdf8 }),
        );
        dot.position.set(p.x, 0, -p.y);
        group.add(dot);
      }
    }
  }, [isReady, extrusions.solids, extrusions.selectedId, extrusions.drawing, extrusions.contour, contourCursor]);

  // Clear the rubber band when the drawing stops, so a stale segment does not
  // hang in the scene until the next move.
  useEffect(() => {
    if (!extrusions.drawing) { contourCursorRef.current = null; setContourCursor(null); }
  }, [extrusions.drawing]);

  // ── Rebuild BIM graph geometry when nodes / edges change ───────────────────
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !isReady) return;
    const scene = world.scene.three as THREE.Scene;

    // Async: pre-load any IFC library elements needed for this node set,
    // then rebuild geometry once all IFC parts are cached.
    (async () => {
      const ifcGroupCache = new Map<string, IFCGroupInfo>();

      // Collect unique IFC paths needed
      const paths = collectIfcLibraryPaths(nodes);
      await Promise.all(
        paths.map(async (lp) => {
          try {
            const parts = await loadIfcParts(lp);
            ifcGroupCache.set(lp, buildIfcGroup(parts));
          } catch (err) {
            console.warn(`[WebIfcViewer] Could not load IFC library part: ${lp}`, err);
          }
        }),
      );

      const oldRoot = scene.getObjectByName(SCENE_ROOT);
      if (oldRoot) {
        oldRoot.traverse((c) => {
          if ((c as THREE.InstancedMesh).isInstancedMesh)
            (c as THREE.InstancedMesh).geometry?.dispose();
        });
        scene.remove(oldRoot);
      }
      if (nodes.length === 0) return;

      const root = buildSceneGeometry(scene, nodes, edges, ifcGroupCache, matConfig);

      // ── The elements come from the IFC-loaded fragments model ──────────────
      // Unless that model failed to load: then the scene's own meshes stand in.
      if (bimIfcStateRef.current !== 'failed') {
        root.traverse((obj) => {
          const t = obj.userData.nodeType as string | undefined;
          if (t && IFC_EXPORTED_NODE_TYPES.has(t)) {
            obj.visible = false;
            obj.userData.hiddenByFragments = true;
          }
        });
      }

      const box = new THREE.Box3();
      root.traverse((c) => {
        if ((c as THREE.InstancedMesh).isInstancedMesh || c instanceof THREE.Mesh || c instanceof THREE.Line)
          box.expandByObject(c);
      });
      if (!box.isEmpty()) {
        const cam = world.camera as OBC.OrthoPerspectiveCamera;

        // Position camera south-east above (matching BabylonViewer perspective)
        const center = new THREE.Vector3();
        const size   = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);
        const diag = Math.sqrt(size.x ** 2 + size.y ** 2 + size.z ** 2);
        const dist = Math.max(diag * 0.9, 5);

        // Babylon camera: alpha=-π/4 (SE), beta=1.1 (~63° from top)
        // Map to Three.js: cam at (center + offset) looking at center
        const alpha = -Math.PI / 4;
        const beta  = 1.1;
        const camX = center.x + dist * Math.sin(beta) * Math.sin(alpha);
        const camY = center.y + dist * Math.cos(beta);
        const camZ = center.z + dist * Math.sin(beta) * Math.cos(alpha);

        cam.controls.setLookAt(camX, camY, camZ, center.x, center.y, center.z, false);
      }

      // Re-apply visibility toggles after rebuild (skip fragments-managed objects)
      root.traverse((obj) => {
        const t   = obj.userData.nodeType as string | undefined;
        const sid = obj.userData.storeyId as string | undefined;
        if (!t || obj.userData.hiddenByFragments) return;
        if (hiddenTypes.has(t)) { obj.visible = false; return; }
        if (hiddenStoreyIds.size > 0 && sid && hiddenStoreyIds.has(sid)) { obj.visible = false; return; }
        obj.visible = true;
      });
    })();
  }, [terrainModel, nodes, edges, isReady, matConfig, hiddenTypes, hiddenStoreyIds]);

  // ── Load the graph's IFC into the BIM fragments model ──────────────────────
  useEffect(() => {
    const comps = componentsRef.current;
    if (!isReady || !comps || !modelIfc) return;
    let cancelled = false;
    setBimLoading(true);
    void withLoadLock(async () => {
      // The loader finishes its own setup asynchronously.
      for (let i = 0; !ifcLoaderRef.current && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
      const loader = ifcLoaderRef.current;
      if (cancelled || !loader) return;
      const frags = comps.get(OBC.FragmentsManager);
      if (frags.list.has(BIM_MODEL_ID)) await frags.core.disposeModel(BIM_MODEL_ID);
      if (cancelled) return;
      // Not coordinated: the model stays in its own frame, the frame the
      // storey planes, terrain and axes are drawn in.
      await loader.load(new TextEncoder().encode(modelIfc.ifc), false, BIM_MODEL_ID, {
        // web-ifc would move the model to the origin; this one is in the scene's
        // own frame already (local BIM metres), shared with everything else drawn.
        instanceCallback: (importer) => {
          importer.webIfcSettings = { ...loader.settings.webIfc, COORDINATE_TO_ORIGIN: false };
        },
      });
      await applyIndexedColours(BIM_MODEL_ID, modelIfc.ifc);
      bimIfcStateRef.current = 'ready';
      if (!cancelled) setBimModelVersion((v) => v + 1);
    }).catch((err) => {
      console.error('[WebIfcViewer] IFC model load failed — drawing the scene geometry instead:', err);
      bimIfcStateRef.current = 'failed';
      const root = worldRef.current?.scene.three.getObjectByName(SCENE_ROOT);
      root?.traverse((obj) => {
        if (obj.userData.hiddenByFragments) { obj.visible = true; obj.userData.hiddenByFragments = false; }
      });
    }).finally(() => { if (!cancelled) setBimLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelIfc?.ifc, isReady]);

  // ── Visibility filter on the fragments model: by node type and storey ──────
  useEffect(() => {
    const model = componentsRef.current?.get(OBC.FragmentsManager).list.get(BIM_MODEL_ID);
    if (!model) return;
    void (async () => {
      const ids = await model.getItemsIdsWithGeometry();
      const data = await model.getItemsData(ids);
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      const show: number[] = [], hide: number[] = [];
      data.forEach((item, i) => {
        const tag = (item?.['Tag'] as { value?: unknown } | undefined)?.value;
        const node = nodeMap.get(nodeIdOfTag(tag) ?? '');
        const storeyId = node ? resolveStoreyId(node, nodeMap) : undefined;
        const hidden = !!node && (hiddenTypes.has(node.type) || (!!storeyId && hiddenStoreyIds.has(storeyId)));
        (hidden ? hide : show).push(ids[i]);
      });
      if (show.length) await model.setVisible(show, true);
      if (hide.length) await model.setVisible(hide, false);
      await componentsRef.current?.get(OBC.FragmentsManager).core.update(true);
    })().catch((err) => console.warn('[WebIfcViewer] visibility on the IFC model failed:', err));
  }, [hiddenTypes, hiddenStoreyIds, bimModelVersion, nodes]);

  /**
   * Colour what web-ifc left grey: bodies an IfcIndexedColourMap colours
   * (Revit's IFC4). fragments colours whole elements only, so each takes
   * the colour most of its bodies have; the exports colour body by body.
   */
  const applyIndexedColours = useCallback(async (modelId: string, text: string) => {
    const model = componentsRef.current?.get(OBC.FragmentsManager).list.get(modelId);
    if (!model) return;
    try {
      const groups = productsByColour(readIndexedColours(text));
      for (const { colour, ids } of groups) {
        const [r, g, b] = colour.rgb;
        await model.setColor(ids, new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace));
        if (colour.opacity < 1) await model.setOpacity(ids, colour.opacity);
      }
      if (groups.length) {
        await componentsRef.current!.get(OBC.FragmentsManager).core.update(true);
        console.info(`[WebIfcViewer] ${modelId}: ${groups.reduce((n, g) => n + g.ids.length, 0)} elements coloured from IfcIndexedColourMap`);
      }
    } catch (err) {
      console.warn('[WebIfcViewer] IfcIndexedColourMap colours not applied:', err);
    }
  }, []);

  // ── IFC file loader (drag-and-drop or file input) ──────────────────────────
  const handleLoadIfc = useCallback(async (file: File) => {
    if (!ifcLoaderRef.current) {
      alert('IfcLoader not ready yet — please wait a moment and try again.');
      return;
    }
    setLoadingIfc(true);
    try {
      const buffer = await file.arrayBuffer();
      // The model id is the file name, so loading two files with the same
      // name would replace the first. Suffix a repeat rather than lose it.
      const base = file.name.replace(/\.ifc$/i, '');
      const taken = new Set(ifcModelsRef.current.map((m) => m.id));
      let name = base;
      for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;

      // Read before loading: the loader may hand the buffer to its worker.
      const text = new TextDecoder().decode(buffer);
      const loader = ifcLoaderRef.current;
      await withLoadLock(() => loader.load(new Uint8Array(buffer), true, name));
      ifcFilesRef.current.set(name, file);
      await applyIndexedColours(name, text);
      setIfcModels((l) => [...l, { id: name, name, visible: true }]);
      getHostBridge().post({ type: 'BIM_MODEL_LOADED', payload: { modelId: name, name, viewer: 'toc' } });
    } catch (e) {
      console.error('[WebIfcViewer] IFC load error:', e);
      getHostBridge().post({ type: 'BIM_ERROR', payload: { message: `IFC load: ${(e as Error).message}` } });
      alert(`Failed to load IFC: ${(e as Error).message}`);
    } finally {
      setLoadingIfc(false);
    }
  }, [applyIndexedColours, withLoadLock]);

  /**
   * Point the camera at a box, from the south-east and above.
   *
   * The same framing the scene rebuild uses, so a model opened from a file and
   * the project's own graph are looked at from the same angle. Extracted
   * because a loaded model is often nowhere near the project origin — the
   * photovoltaic site this was first tried on stands 100 m away, so without
   * this the model loads correctly and the screen shows nothing, which reads
   * as a failed import.
   */
  const frameBox = useCallback((box: THREE.Box3) => {
    const world = worldRef.current;
    if (!world || box.isEmpty()) return false;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const diag = Math.hypot(size.x, size.y, size.z);
    if (!Number.isFinite(diag)) return false;
    const dist = Math.max(diag * 0.9, 5);
    const alpha = -Math.PI / 4;   // south-east
    const beta = 1.1;             // ~63° down from vertical
    const cam = world.camera as OBC.OrthoPerspectiveCamera;
    cam.controls.setLookAt(
      center.x + dist * Math.sin(beta) * Math.sin(alpha),
      center.y + dist * Math.cos(beta),
      center.z + dist * Math.sin(beta) * Math.cos(alpha),
      center.x, center.y, center.z,
      true,   // animated: the jump is large, and it should read as a move
    );
    return true;
  }, []);

  /**
   * Open a `.frag` directly — no conversion, because there is nothing to
   * convert: the file already IS the fragments model this viewer works with.
   *
   * `fragments.list` is `core.models.list`, so loading through the core fires
   * the `onItemSet` handler set up with the world, which is what puts the model
   * in the scene, gives it the camera and hands it the clipping planes. Every
   * feature that follows — the tree, picking, sections, the .frag export — sees
   * an ordinary FragmentsModel and cannot tell how it arrived.
   */
  const handleLoadFrag = useCallback(async (file: File) => {
    const fragments = componentsRef.current?.get(OBC.FragmentsManager);
    if (!fragments?.initialized) {
      alert('Vizualizatorul nu este gata încă — încearcă peste o clipă.');
      return;
    }
    setLoadingIfc(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // A `.frag` is normally zlib-compressed, and `raw` must match or the
      // parse fails silently and yields a model with nothing in it. The zlib
      // header is the only way to tell from the outside.
      const raw = bytes[0] !== 0x78;
      const base = file.name.replace(/\.frag$/i, '');
      const taken = new Set(ifcModelsRef.current.map((m) => m.id));
      let name = base;
      for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;

      await fragments.core.load(bytes, { modelId: name, raw });
      await fragments.core.update(true);

      const model = fragments.list.get(name);
      const items = model ? (await model.getItemsIdsWithGeometry()).length : 0;
      if (items === 0) {
        console.warn(`[WebIfcViewer] ${file.name} loaded but carries no geometry`);
      }
      setIfcModels((l) => [...l, { id: name, name, visible: true }]);
      getHostBridge().post({ type: 'BIM_MODEL_LOADED', payload: { modelId: name, name, viewer: 'toc' } });
      if (model && items > 0) frameBox(model.box);
      console.info(`[WebIfcViewer] loaded ${file.name}: ${items} elements with geometry`);
    } catch (e) {
      console.error('[WebIfcViewer] .frag load error:', e);
      getHostBridge().post({ type: 'BIM_ERROR', payload: { message: `Fragments load: ${(e as Error).message}` } });
      alert(`Nu am putut deschide ${file.name}: ${(e as Error).message}`);
    } finally {
      setLoadingIfc(false);
    }
  }, [frameBox]);

  /** Files load one after another: two IfcLoader runs at once fight over the
   *  same worker, and the second id would be chosen before the first landed. */
  const handleLoadIfcFiles = useCallback(async (files: File[]) => {
    for (const f of files) {
      if (/\.frag$/i.test(f.name)) await handleLoadFrag(f);
      else await handleLoadIfc(f);
    }
  }, [handleLoadIfc, handleLoadFrag]);

  const toggleIfcModel = useCallback((id: string) => {
    const comps = componentsRef.current;
    const model = comps?.get(OBC.FragmentsManager).list.get(id);
    if (!model) return;
    model.object.visible = !model.object.visible;
    setIfcModels((l) => l.map((m) => (m.id === id ? { ...m, visible: model.object.visible } : m)));
  }, []);

  // ── Export to .frag ────────────────────────────────────────────────────────
  // Nothing is converted here: OBC.IfcLoader already turned the IFC into a
  // fragments model in its worker, and the graph is built into one too. This
  // asks for the buffer that model is holding and writes it to disk, so the
  // next open is instant instead of another IFC conversion.
  const [exportingFrag, setExportingFrag] = useState<string | null>(null);

  const exportFrag = useCallback(async (modelId: string, fileLabel: string) => {
    const comps = componentsRef.current;
    const model = comps?.get(OBC.FragmentsManager).list.get(modelId);
    if (!model) {
      alert('Modelul nu mai este încărcat.');
      return;
    }
    setExportingFrag(modelId);
    try {
      const size = await exportFragmentsModel(model, fragFileName(fileLabel));
      console.info(`[WebIfcViewer] exported ${fragFileName(fileLabel)} (${formatBytes(size)})`);
    } catch (e) {
      console.error('[WebIfcViewer] fragments export failed:', e);
      alert(`Exportul în Fragments a eșuat: ${(e as Error).message}`);
    } finally {
      setExportingFrag(null);
    }
  }, []);

  const removeIfcModel = useCallback((id: string) => {
    const comps = componentsRef.current;
    void comps?.get(OBC.FragmentsManager).core.disposeModel(id).catch((err) => {
      console.warn('[WebIfcViewer] disposing model failed:', err);
    });
    setIfcModels((l) => l.filter((m) => m.id !== id));
    ifcFilesRef.current.delete(id);
    setIfcPick(null);
  }, []);

  const onFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) void handleLoadIfcFiles(files);
    e.target.value = '';
  }, [handleLoadIfcFiles]);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => /\.(ifc|frag)$/i.test(f.name));
    if (files.length) void handleLoadIfcFiles(files);
  }, [handleLoadIfcFiles]);

  // ── Clipper toggle ─────────────────────────────────────────────────────────
  const toggleClipper = useCallback(() => {
    const clipper = clipperRef.current;
    if (!clipper) return;
    const next = !clipper.enabled;
    clipper.enabled = next;
    setClipperActive(next);
  }, []);

  const deleteAllPlanes = useCallback(() => {
    clipperRef.current?.deleteAll();
  }, []);

  // ── Views: switch to floor plan ────────────────────────────────────────────
  const switchToPlan = useCallback((elevation: number) => {
    const world = worldRef.current;
    const views = viewsRef.current;
    if (!world || !views) return;

    // Close any existing view first
    views.close();

    // Create a horizontal plan view at the given elevation (mm→m)
    const elevM = elevation * MM;
    const normal = new THREE.Vector3(0, -1, 0); // looking down
    const point  = new THREE.Vector3(0, elevM, 0);
    const view = views.create(normal, point, { world });
    views.open(view.id);
    setActiveViewMode('plan');
  }, []);

  // ── Views: switch to elevation ─────────────────────────────────────────────
  const switchToElevation = useCallback((dir: 'N' | 'S' | 'E' | 'W') => {
    const world = worldRef.current;
    const views = viewsRef.current;
    if (!world || !views) return;

    views.close();

    // Compute bounding box for camera distance
    let threeScene: THREE.Scene | null = null;
    try { threeScene = world.scene.three as THREE.Scene; } catch { return; }
    const box = new THREE.Box3();
    threeScene.traverse((c) => {
      if (c instanceof THREE.Mesh || c instanceof THREE.Line) box.expandByObject(c);
    });
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const dist = Math.max(size.x, size.y, size.z) * 2 + 10;

    let normal: THREE.Vector3;
    let point: THREE.Vector3;
    switch (dir) {
      case 'N': normal = new THREE.Vector3(0, 0, -1); point = new THREE.Vector3(center.x, center.y, box.min.z - dist); break;
      case 'S': normal = new THREE.Vector3(0, 0, 1);  point = new THREE.Vector3(center.x, center.y, box.max.z + dist); break;
      case 'E': normal = new THREE.Vector3(1, 0, 0);  point = new THREE.Vector3(box.max.x + dist, center.y, center.z); break;
      case 'W': normal = new THREE.Vector3(-1, 0, 0); point = new THREE.Vector3(box.min.x - dist, center.y, center.z); break;
    }

    const view = views.create(normal, point, { world });
    views.open(view.id);
    setActiveViewMode('elevation');
  }, []);

  // ── Views: return to 3D perspective ────────────────────────────────────────
  const switchTo3D = useCallback(() => {
    viewsRef.current?.close();
    setActiveViewMode('3d');
  }, []);

  // ── Host integration (iframe) ──────────────────────────────────────────────
  // Announce readiness, then act on what the host asks: focus an element by
  // GUID, reset, colour elements by GUID. Everything addresses elements by
  // GUID because that is the only id the host and the file share.
  useEffect(() => {
    if (!isReady) return;
    const bridge = getHostBridge();
    bridge.post({ type: 'BIM_READY' });

    const foreignModels = () => {
      const comps = componentsRef.current;
      if (!comps) return [] as [string, FragmentsModel][];
      return [...comps.get(OBC.FragmentsManager).list].filter(([id]) => id !== BIM_MODEL_ID);
    };
    /** GUID → { modelId, localId } across every imported model. */
    const locate = async (guid: string) => {
      for (const [id, model] of foreignModels()) {
        const [lid] = await model.getLocalIdsByGuids([guid]);
        if (lid !== null && lid !== undefined) return { id, lid };
      }
      return null;
    };
    const HOST_STYLE = 'host:';

    const off = bridge.onMessage(async (msg) => {
      const hl = highlighterRef.current;
      if (!hl) return;
      try {
        switch (msg.type) {
          case 'BIM_FOCUS_GUID': {
            const hit = await locate(msg.payload.guid);
            if (!hit) { console.warn(`[WebIfcViewer] BIM_FOCUS_GUID: ${msg.payload.guid} is in no loaded model`); return; }
            await hl.highlightByID('select', { [hit.id]: new Set([hit.lid]) }, true, true);
            break;
          }
          case 'BIM_RESET_VIEW':
            await hl.clear();
            setIfcPick(null);
            switchTo3D();
            break;
          case 'BIM_COLOR_BY_VALUES': {
            // One style per colour, its selection being every GUID that
            // maps to it. Styles are named after the colour so a repeat
            // message replaces rather than stacks.
            const byColour = new Map<string, OBC.ModelIdMap>();
            for (const [guid, colour] of Object.entries(msg.payload.colors)) {
              const hit = await locate(guid);
              if (!hit) continue;
              const map = byColour.get(colour) ?? {};
              (map[hit.id] ??= new Set()).add(hit.lid);
              byColour.set(colour, map);
            }
            for (const [colour, map] of byColour) {
              const name = HOST_STYLE + colour;
              if (!hl.styles.has(name)) {
                hl.styles.set(name, { color: new THREE.Color(colour), renderedFaces: 1, opacity: 1, transparent: false });
              }
              await hl.highlightByID(name, map, true, false);
            }
            break;
          }
          case 'BIM_CLEAR_COLORS':
            for (const name of [...hl.styles.keys()]) {
              if (name.startsWith(HOST_STYLE)) await hl.clear(name);
            }
            break;
          default:
            break;
        }
      } catch (err) {
        console.warn(`[WebIfcViewer] host message ${msg.type} failed:`, err);
        bridge.post({ type: 'BIM_ERROR', payload: { message: `${msg.type}: ${(err as Error).message}` } });
      }
    });
    return off;
  }, [isReady, switchTo3D]);

  // ── Collect storeys for plan mode dropdown ─────────────────────────────────
  const storeys = useMemo(() =>
    nodes.filter((n) => n.type === 'storey').sort((a, b) => {
      const aE = Number(a.properties.bottomElevation ?? 0);
      const bE = Number(b.properties.bottomElevation ?? 0);
      return aE - bE;
    }),
  [nodes]);

  // ── Day / Night mode ──────────────────────────────────────────────────────
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const scene = world.scene.three as THREE.Scene;
    if (dayMode) {
      scene.background = new THREE.Color(0xd0e8f5);
      scene.traverse((obj) => {
        if (obj instanceof THREE.AmbientLight)     { obj.color.set(0xfff6e8); obj.intensity = 1.2; }
        if (obj instanceof THREE.DirectionalLight) { obj.color.set(0xfff6e8); obj.intensity = 1.8; obj.position.set(50, 80, 30); }
      });
    } else {
      scene.background = new THREE.Color(0x1a1d23);
      scene.traverse((obj) => {
        if (obj instanceof THREE.AmbientLight)     { obj.color.set(0xffffff); obj.intensity = 0.8; }
        if (obj instanceof THREE.DirectionalLight) { obj.color.set(0xffffff); obj.intensity = 1.5; obj.position.set(10, 20, 10); }
      });
    }
  }, [dayMode]);

  // ── BIM-to-screen projection (fed to AxisInteraxOverlay) ──────────────────
  /** Project a BIM-space coordinate (mm) to viewport pixel coords. */
  const projectBimPoint = useCallback(
    (bimX: number, bimY: number, bimZ: number): { x: number; y: number } | null => {
      if (!isReady) return null;
      try {
        const world = worldRef.current;
        const el    = containerRef.current;
        if (!world || !el) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const camera = (world.camera as any).three as THREE.Camera | undefined;
        if (!camera) return null;
        // BIM → Three.js: X→+X (East), Y→-Z (North negated), Z→+Y (Up), all × MM
        const vec = new THREE.Vector3(bimX * MM, bimZ * MM, -bimY * MM);
        vec.project(camera);
        if (vec.z > 1) return null; // behind camera
        return {
          x: (vec.x + 1) / 2 * el.clientWidth,
          y: (1 - vec.y) / 2 * el.clientHeight,
        };
      } catch { return null; }
    },
    [isReady],
  );

  return (
    <div
      ref={containerRef}
      className={cn('relative w-full h-full', className)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* Loading overlay */}
      {(!isReady || loadingIfc) && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white text-sm z-10 pointer-events-none">
          {loadingIfc ? 'Se încarcă modelul…' : 'Initializing That Open Components viewer…'}
        </div>
      )}

      {/* Extrusion editor */}
      {extrudeOpen && (
        <ExtrudePanel
          className="absolute top-12 left-2 bottom-2 w-64 z-20"
          solids={extrusions.solids}
          selectedId={extrusions.selectedId}
          drawing={extrusions.drawing}
          pointCount={extrusions.contour.length}
          planeLabel="cota 0"
          defaultHeight={extrusions.defaultHeight}
          onDefaultHeightChange={extrusions.changeDefaultHeight}
          onStartDraw={extrusions.startDraw}
          onCancelDraw={extrusions.cancelDraw}
          onFinishDraw={() => extrusions.finishDraw()}
          onSelect={extrusions.setSelectedId}
          onPatch={extrusions.patch}
          onHeight={extrusions.setHeight}
          onRename={extrusions.rename}
          onType={extrusions.setType}
          onDelete={extrusions.remove}
          onExport={() => extrusions.exportIfc('extrudari')}
        />
      )}
      {extrudeProblem && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 px-3 py-1.5 rounded-full bg-destructive text-destructive-foreground text-[11px] shadow">
          {extrudeProblem}
          <button className="ml-2 opacity-70 hover:opacity-100" onClick={() => setExtrudeProblem(null)}>✕</button>
        </div>
      )}
      {extrusions.drawing && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-full bg-sky-500 text-white text-[11px] shadow pointer-events-none">
          ✏ Click pe cota 0 pentru colțuri · dublu-click sau Enter închide · Esc anulează
        </div>
      )}

      {/* Properties of a picked element in an imported IFC */}
      {ifcPick && (
        <IfcPropertiesPanel
          className="absolute top-12 right-2 bottom-2 w-72 z-20"
          element={ifcPick.element}
          loading={ifcPick.loading}
          onClose={() => {
            setIfcPick(null);
            highlighterRef.current?.clear('select').catch(() => {});
          }}
        />
      )}

      {/* ── View Toolbar ─────────────────────────────────────────────────── */}
      {(bimLoading || modelIfcError) && (
        <div className="absolute right-3 bottom-3 z-20 rounded-full border border-border bg-card/90 px-3 py-1 text-[11px] text-muted-foreground">
          {modelIfcError ? `⚠ Modelul IFC: ${modelIfcError}` : '⟳ Actualizez modelul…'}
        </div>
      )}
      {isReady && (
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1 bg-black/50 backdrop-blur rounded-md px-1.5 py-1">
          {/* 3D button */}
          <button
            onClick={switchTo3D}
            className={cn(
              'px-2 py-0.5 text-xs rounded select-none transition-colors',
              activeViewMode === '3d' ? 'bg-blue-600 text-white' : 'text-white/80 hover:bg-white/15',
            )}
            title="3D Perspective"
          >
            3D
          </button>

          {/* Section plane toggle */}
          <button
            onClick={toggleClipper}
            className={cn(
              'px-2 py-0.5 text-xs rounded select-none transition-colors',
              clipperActive ? 'bg-orange-600 text-white' : 'text-white/80 hover:bg-white/15',
            )}
            title="Toggle section planes (double-click model to create, Delete to remove)"
          >
            Section
          </button>

          {clipperActive && (
            <button
              onClick={deleteAllPlanes}
              className="px-1.5 py-0.5 text-[10px] rounded text-red-300 hover:bg-red-600/30 select-none"
              title="Delete all section planes"
            >
              Clear
            </button>
          )}

          <span className="w-px h-4 bg-white/20 mx-0.5" />

          {/* Plan views */}
          {storeys.length > 0 && (
            <div className="relative group">
              <button
                className={cn(
                  'px-2 py-0.5 text-xs rounded select-none transition-colors',
                  activeViewMode === 'plan' ? 'bg-green-600 text-white' : 'text-white/80 hover:bg-white/15',
                )}
                title="Floor plan view"
              >
                Plan
              </button>
              <div className="hidden group-hover:block absolute top-full left-0 mt-1 bg-gray-900 border border-gray-700 rounded shadow-lg min-w-[120px]">
                {storeys.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => switchToPlan(Number(s.properties.bottomElevation ?? 0) + 1200)}
                    className="block w-full text-left px-3 py-1 text-xs text-white/80 hover:bg-white/10"
                  >
                    {s.name || String(s.properties.name ?? '') || s.id}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Elevation views */}
          {(['N', 'S', 'E', 'W'] as const).map((dir) => (
            <button
              key={dir}
              onClick={() => switchToElevation(dir)}
              className={cn(
                'px-1.5 py-0.5 text-xs rounded select-none transition-colors',
                activeViewMode === 'elevation' ? 'text-white/90' : 'text-white/60 hover:bg-white/15',
              )}
              title={`${dir} Elevation`}
            >
              {dir}
            </button>
          ))}

          <span className="w-px h-4 bg-white/20 mx-0.5" />

          {/* Day / Night toggle */}
          <button
            onClick={() => setDayMode((d) => !d)}
            title={dayMode ? 'Switch to Night mode' : 'Switch to Day mode'}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/15 text-base select-none transition-colors"
          >
            {dayMode ? '🌙' : '☀️'}
          </button>
        </div>
      )}

      {/* Annotation tools toolbar */}
      {isReady && (
        <AnnotationsToolbar
          activeTool={activeTool}
          onToolChange={(tool) => {
            const TOOL_MAP: Record<AnnotationTool, any> = {
              linear: OBF.LinearAnnotationsTool, angle: OBF.AngleAnnotationsTool,
              callout: OBF.CalloutAnnotationsTool, leader: OBF.LeaderAnnotationsTool,
              slope: OBF.SlopeAnnotationsTool,
            };
            const editor = editorRef.current;
            if (editor) editor.activeTool = tool ? TOOL_MAP[tool] : null;
            setActiveTool(tool);
          }}
          onClearAll={() => {
            const comps = componentsRef.current;
            const drawing = drawingRef.current;
            if (!comps || !drawing) return;
            try {
              const td = comps.get(OBC.TechnicalDrawings);
              for (const Sys of [OBC.LinearAnnotations, OBC.AngleAnnotations,
                  OBC.CalloutAnnotations, OBC.LeaderAnnotations, OBC.SlopeAnnotations] as any[]) {
                td.use(Sys)?.clear?.([drawing]);
              }
            } catch { /* */ }
            setActiveTool(null);
          }}
          className="absolute bottom-2 left-2 z-10"
        />
      )}

      {/* Axis inter-ax dimension lines (perspective-projected) */}
      <AxisInteraxOverlay nodes={nodes} projectBimPoint={projectBimPoint} viewerReady={isReady} />

      {/*
        Everything that lives in the top-right corner, in ONE column.

        The visibility filter used to be a second absolutely-positioned box at
        `right-24`, on the same row as this one at `right-2`. Whether they
        collided depended on how wide the buttons happened to be — and they
        did, the moment "Load IFC" became "Load IFC / .frag". Coordinates
        cannot express "next to, never on top of"; a flex column can.
      */}
      {isReady && (
        <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setExtrudeOpen((v) => !v)}
              title="Desenează contururi și extrudează-le pe verticală"
              className={cn('px-2 py-1 text-xs rounded select-none',
                extrudeOpen ? 'bg-sky-500 text-white' : 'bg-white/10 hover:bg-white/20 text-white')}
            >
              ✏ Extrudare
            </button>
            <label className="cursor-pointer">
              <input type="file" accept=".ifc,.frag" multiple className="hidden" onChange={onFileInput} />
              <span
                title="Deschide un IFC (se convertește) sau un .frag (se deschide direct)"
                className="px-2 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-white select-none"
              >
                Load IFC / .frag
              </span>
            </label>
            {/* The project's own graph is a fragments model too — same export. */}
            <button
              onClick={() => void exportFrag(BIM_MODEL_ID, 'BubbleGraph')}
              disabled={exportingFrag !== null}
              title="Salvează modelul proiectului în formatul .frag (That Open)"
              className="px-2 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-white select-none disabled:opacity-40"
            >
              {exportingFrag === BIM_MODEL_ID ? '⏳' : '⭳'} .frag
            </button>
          </div>

          {/* `relative` so the panel it opens pushes the list below it down
              rather than being positioned over it. */}
          <VisibilityFilter
            types={visibleTypes}
            hiddenTypes={hiddenTypes}
            onChange={setHiddenTypes}
            counts={typeCounts}
            nodes={nodes}
            hiddenStoreyIds={hiddenStoreyIds}
            onChangeStoreyIds={setHiddenStoreyIds}
            className="relative top-0 right-0 z-auto"
          />

          {ifcModels.length > 0 && (
            <div className="rounded bg-black/55 backdrop-blur px-1.5 py-1 flex flex-col gap-0.5 max-w-[15rem]">
              {ifcModels.map((m) => (
                <div key={m.id} className="flex items-center gap-1.5 text-[11px] text-white">
                  <button
                    className="w-4 shrink-0 opacity-70 hover:opacity-100"
                    title={m.visible ? 'Ascunde' : 'Arată'}
                    onClick={() => toggleIfcModel(m.id)}
                  >
                    {m.visible ? '👁' : '◌'}
                  </button>
                  <span className="flex-1 min-w-0 truncate" title={m.id}>{m.name}</span>
                  <button
                    className="w-4 shrink-0 opacity-70 hover:opacity-100 disabled:opacity-30"
                    title="Exportă în .frag (formatul That Open) — se deschide instant data viitoare"
                    disabled={exportingFrag !== null}
                    onClick={() => void exportFrag(m.id, m.name)}
                  >
                    {exportingFrag === m.id ? '⏳' : '⭳'}
                  </button>
                  <button
                    className="w-4 shrink-0 opacity-70 hover:opacity-100 hover:text-red-400"
                    title="Închide modelul"
                    onClick={() => removeIfcModel(m.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
