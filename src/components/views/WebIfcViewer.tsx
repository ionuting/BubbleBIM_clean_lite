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

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { AxisInteraxOverlay } from './AxisInteraxOverlay';
import { AnnotationsToolbar, type AnnotationTool } from './AnnotationsToolbar';
import * as OBC from '@thatopen/components';
import * as OBF from '@thatopen/components-front';
import { cn, parseAxes } from '@/lib/utils';
import { VisibilityFilter } from '@/components/views/VisibilityFilter';
import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes } from '@/store';
import {
  MM,
  parseColumnDims, parseBeamDims, getNodeSlabThickness,
  getStoreyBand, getAxRealPos, getNodeBimPos, getConnectedNodes,
  calcWallGeometry, calcWallJoins, calcStoreyPlanExtents,
  calcRoomPolygon, calcShellPolygon, parseContourOffsets, insetPolygon,
  calcSpanEffectiveEnds, resolveStoreyId,
  type WallSegDesc,
} from '@/lib/bimGeometry';
import { getMat, wallSolidMesh, wallHorizontalProfileMesh, wallHorizontalProfileLayerMesh, wallSolidLayerMesh, makeBoxOpeningCutter, makeIfcOpeningCutter, applyOpeningVoids, buildOpeningMeshes3, applyIfcGlazingOverrides, applyNodeLocalTransformThree } from '@/lib/bimGeometryThree';
import { getNodeLocalTransform } from '@/lib/bimGeometry';
import {
  loadIfcParts, buildIfcGroup, positionIfcGroup,
  collectIfcLibraryPaths, resolveIfcPath,
  type IFCGroupInfo,
} from '@/lib/ifcLibraryLoader';
import { type MaterialConfig, resolveVisuals, applyNodeColorOverrides, hexToRgb01, resolveWindowGlazing } from '@/lib/materialConfig';
import { resolveCoveringLayers, roomHasCovering } from '@/lib/roomCovering';
import { resolveWallLayers, syntheticWallNodeForLayer } from '@/lib/wallLayers';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { buildBimFragmentsModel, getBubbleIdByLocalId, getLocalIdByBubbleId, FRAG_ELEMENT_TYPES, BIM_MODEL_ID } from '@/lib/fragModelBuilder';
import { expandArrayNodes } from '@/lib/formulaUtils';

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
    const mat = getMat(matCache, 'shell', 1, resolveVisuals('shell', String(n.properties.material ?? ''), matConfig));
    const rawMesh = buildRingMesh(poly, offsets, thickMm, shellH, bot * MM, mat);
    if (rawMesh) {
      rawMesh.userData.nodeType = 'shell'; rawMesh.userData.nodeId = n.id; rawMesh.userData.storeyId = resolveStoreyId(n, nodeMap);
      const m = allOpeningCutters.length ? applyOpeningVoids(rawMesh, allOpeningCutters) : rawMesh;
      m.userData.nodeType = 'shell'; m.userData.nodeId = n.id; m.userData.storeyId = resolveStoreyId(n, nodeMap);
      attachRingData(m, poly, offsets, thickMm, shellH, bot * MM);
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
  const [clipperActive, setClipperActive] = useState(false);
  const [activeViewMode, setActiveViewMode] = useState<'3d' | 'plan' | 'elevation'>('3d');
  const [activeTool, setActiveTool] = useState<AnnotationTool | null>(null);
  const [dayMode, setDayMode] = useState(false);
  const onSelectNodeRef = useRef(onSelectNode);
  useEffect(() => { onSelectNodeRef.current = onSelectNode; }, [onSelectNode]);

  // ── Visibility filter (local to this viewer instance) ─────────────────────
  const [hiddenTypes, setHiddenTypes]         = useState<Set<string>>(new Set());
  const [hiddenStoreyIds, setHiddenStoreyIds] = useState<Set<string>>(new Set());
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
        getLocalIdByBubbleId(frags.core, selectedNodeId).then((lid) => {
          if (lid !== null) {
            highlighter.highlightByID('select', { [BIM_MODEL_ID]: new Set([lid]) }, true, false)
              .catch(() => { /* model not ready yet */ });
          } else {
            highlighter.clear('select').catch(() => {});
          }
        }).catch(() => {});
      } else {
        highlighter.clear('select').catch(() => {});
      }
    }
  }, [selectedNodeId]);

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
      if (!clickIsDown) return; // only accumulate while button held
      const dx = e.clientX - clickStartX; const dy = e.clientY - clickStartY;
      clickDragDist += Math.sqrt(dx * dx + dy * dy);
      clickStartX = e.clientX; clickStartY = e.clientY;
    };
    // Async click handler: tries Highlighter (fragments tiles) first,
    // then falls back to Three.js raycaster for IFC library elements.
    const onClickCanvasAsync = async (e: MouseEvent) => {
      if (clickDragDist > 4) return;
      const cb = onSelectNodeRef.current;
      if (!cb || !worldRef.current) return;

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
                if (mId !== BIM_MODEL_ID) continue;
                for (const lid of (lids as Set<number>)) {
                  const bubbleId = await getBubbleIdByLocalId(frags.core, lid);
                  if (bubbleId) { cb(bubbleId); return; }
                }
              }
            }
          }
        } catch { /* highlight failed — fall through */ }
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
      if (!clipperRef.current?.enabled) return;
      clipperRef.current.create(world);
    };
    canvas.addEventListener('dblclick', onDblClick);

    // ── Delete key: delete last clipping plane when Clipper active ───────────
    const onKeyDown = (e: KeyboardEvent) => {
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
      canvas.removeEventListener('mousedown', onMousedownClick);
      canvas.removeEventListener('mouseup',   onMouseupClick);
      canvas.removeEventListener('mousemove', onMousemoveClick);
      canvas.removeEventListener('click', onClickCanvas);
      canvas.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('keydown', onKeyDown);
      components.dispose();
    };
  }, []);

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

      // ── Build fragments model for OBC selection / highlight / query ────────
      const comps = componentsRef.current;
      if (comps) {
        const frags = comps.get(OBC.FragmentsManager);
        let fragsBuildOk = false;
        try {
          await buildBimFragmentsModel(frags.core, nodes, edges, matConfig);
          fragsBuildOk = true;
        } catch (err) {
          console.warn('[WebIfcViewer] BIM fragments model build failed — keeping Three.js geometry visible:', err);
        }
        if (fragsBuildOk) {
          // Hide Three.js element meshes — fragments tiles render them instead
          root.traverse((obj) => {
            const t = obj.userData.nodeType as string | undefined;
            if (t && FRAG_ELEMENT_TYPES.has(t)) {
              obj.visible = false;
              obj.userData.hiddenByFragments = true;
            }
          });
        }
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
  }, [nodes, edges, isReady, matConfig, hiddenTypes, hiddenStoreyIds]);

  // ── IFC file loader (drag-and-drop or file input) ──────────────────────────
  const handleLoadIfc = useCallback(async (file: File) => {
    if (!ifcLoaderRef.current) {
      alert('IfcLoader not ready yet — please wait a moment and try again.');
      return;
    }
    setLoadingIfc(true);
    try {
      const buffer = await file.arrayBuffer();
      await ifcLoaderRef.current.load(new Uint8Array(buffer), true, file.name.replace(/\.ifc$/i, ''));
    } catch (e) {
      console.error('[WebIfcViewer] IFC load error:', e);
      alert(`Failed to load IFC: ${(e as Error).message}`);
    } finally {
      setLoadingIfc(false);
    }
  }, []);

  const onFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleLoadIfc(file);
    e.target.value = '';
  }, [handleLoadIfc]);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file?.name.endsWith('.ifc')) handleLoadIfc(file);
  }, [handleLoadIfc]);

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
          {loadingIfc ? 'Loading IFC model…' : 'Initializing That Open Components viewer…'}
        </div>
      )}

      {/* ── View Toolbar ─────────────────────────────────────────────────── */}
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

      {/* Visibility filter */}
      {isReady && (
        <VisibilityFilter
          types={visibleTypes}
          hiddenTypes={hiddenTypes}
          onChange={setHiddenTypes}
          counts={typeCounts}
          nodes={nodes}
          hiddenStoreyIds={hiddenStoreyIds}
          onChangeStoreyIds={setHiddenStoreyIds}
          className="top-2 right-24"
        />
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

      {/* Load IFC button */}
      {isReady && (
        <label className="absolute top-2 right-2 z-10 cursor-pointer">
          <input
            type="file"
            accept=".ifc"
            className="hidden"
            onChange={onFileInput}
          />
          <span className="px-2 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-white select-none">
            Load IFC
          </span>
        </label>
      )}
    </div>
  );
}
