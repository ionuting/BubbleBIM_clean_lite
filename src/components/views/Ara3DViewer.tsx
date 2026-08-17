/**
 * Ara3DViewer — Three.js based 3D BIM viewer for BubbleGraph models.
 *
 * Geometry calculation is identical to BabylonViewer — shared via bimGeometry.ts.
 * Only the rendering layer (mesh creation) is Three.js specific.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { cn, parseAxes } from '@/lib/utils';
import { VisibilityFilter } from '@/components/views/VisibilityFilter';
import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes } from '@/store';
import {
  MM,
  parseColumnDims, parseBeamDims, getNodeSlabThickness,
  getStoreyBand, getAxRealPos, getNodeBimPos, getConnectedNodes,
  calcWallGeometry, calcWallJoins, calcStoreyPlanExtents, calcRoomPolygon, isWallSeparator,
  parseContourOffsets, insetPolygon, calcShellPolygon, calcSpanEffectiveEnds,
  collectVoids,
  resolveStoreyId,
} from '@/lib/bimGeometry';
import { bim, getMat, spanBox3, wallSegBox3, wallSolidMesh, wallHorizontalProfileMesh, wallHorizontalProfileLayerMesh, wallSolidLayerMesh, makeBoxOpeningCutter, makeIfcOpeningCutter, applyOpeningVoids, applyVoids, buildOpeningMeshes3, applyIfcGlazingOverrides, applyNodeLocalTransformThree } from '@/lib/bimGeometryThree';
import { getNodeLocalTransform } from '@/lib/bimGeometry';
import {
  resolveCoveringLayers, roomHasCovering, syntheticCoveringNodeForLayer,
} from '@/lib/roomCovering';
import { resolveWallLayers, syntheticWallNodeForLayer } from '@/lib/wallLayers';
import {
  loadIfcParts, buildIfcGroup, positionIfcGroup,
  collectIfcLibraryPaths, resolveIfcPath,
  type IFCGroupInfo,
} from '@/lib/ifcLibraryLoader';
import { type MaterialConfig, resolveVisuals, applyNodeColorOverrides, resolveWindowGlazing } from '@/lib/materialConfig';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { expandArrayNodes } from '@/lib/formulaUtils';


// ─── Add BIM-aware axes gizmo (X=East/red, Y=Up/blue, Z=North/green) ────────
function addBimAxes(scene: THREE.Scene, length: number = 1): void {
  // X-axis (East, red)
  const xLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(length, 0, 0),
    ]),
    new THREE.LineBasicMaterial({ color: 0xE63946, linewidth: 2 })
  );
  scene.add(xLine);

  // Y-axis (Up, blue)
  const yLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, length, 0),
    ]),
    new THREE.LineBasicMaterial({ color: 0x4088F2, linewidth: 2 })
  );
  scene.add(yLine);

  // Z-axis (North, green) — BIM Y maps to Three.js -Z
  const zLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -length),
    ]),
    new THREE.LineBasicMaterial({ color: 0x33CC33, linewidth: 2 })
  );
  scene.add(zLine);
}

// ─── Main geometry builder ────────────────────────────────────────────────────

export function buildGeometry3(
  scene: THREE.Scene,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  ifcGroupCache: Map<string, IFCGroupInfo>,
  matConfig: MaterialConfig | null,
): void {
  nodes = expandArrayNodes(nodes);  // expand array_x/y/z into virtual copies
  const nodeMap  = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  const matCache = new Map<string, THREE.MeshStandardMaterial>();

  const add = (mesh: THREE.Mesh | null, type: string, alpha = 1, node?: BubbleGraphNode, resolveAs?: string) => {
    if (!mesh) return;
    const baseVis = node ? resolveVisuals(resolveAs ?? node.type, String(node.properties.material ?? ''), matConfig) : null;
    const vis = (node && baseVis) ? applyNodeColorOverrides(baseVis, node.properties) : baseVis;
    mesh.material = getMat(matCache, type, alpha, vis);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.nodeType = type;  // used by visibility filter
    if (node) {
      applyNodeLocalTransformThree(mesh, getNodeLocalTransform(node));
      mesh.userData.nodeId   = node.id;
      mesh.userData.storeyId = resolveStoreyId(node, nodeMap);
    }
    scene.add(mesh);
  };

  // ── Storey floor planes + grid axis lines ──────────────────────────────────
  const storeyNodes = nodes.filter((n) => n.type === 'storey');

  const allBots = storeyNodes.map((s) => Number(s.properties.bottomElevation ?? 0));
  const allTops = storeyNodes.map((s) => Number(s.properties.topElevation   ?? 3000));
  const globalBot = allBots.length ? Math.min(...allBots) : 0;
  const globalTop = allTops.length ? Math.max(...allTops) : 3000;

  for (const s of storeyNodes) {
    const bot = Number(s.properties.bottomElevation ?? 0);
    const top = Number(s.properties.topElevation   ?? 3000);
    const { cXm, cZm, planWm, planDm } = calcStoreyPlanExtents(s, nodes);

    // Floor plane
    const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(planWm, planDm));
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.set(cXm, bot * MM, cZm);
    floorMesh.material = new THREE.MeshStandardMaterial({
      color: 0x383848, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
    });
    floorMesh.receiveShadow = true;
    floorMesh.userData.nodeType = 'storey';
    floorMesh.userData.nodeId    = s.id;
    scene.add(floorMesh);

    // Top plane
    const topMesh = new THREE.Mesh(new THREE.PlaneGeometry(planWm, planDm));
    topMesh.rotation.x = -Math.PI / 2;
    topMesh.position.set(cXm, top * MM, cZm);
    topMesh.material = new THREE.MeshStandardMaterial({
      color: 0x4488dd, transparent: true, opacity: 0.18, side: THREE.DoubleSide,
    });
    topMesh.userData.nodeType = 'storey';
    topMesh.userData.nodeId   = s.id;
    scene.add(topMesh);
  }

  // Axis grid lines
  const allAxesX = new Set<number>();
  const allAxesY = new Set<number>();
  for (const s of storeyNodes) {
    parseAxes(s.properties.axesX).forEach((v) => allAxesX.add(v));
    parseAxes(s.properties.axesY).forEach((v) => allAxesY.add(v));
  }
  const uniqueX = [...allAxesX].sort((a, b) => a - b);
  const uniqueY = [...allAxesY].sort((a, b) => a - b);
  const pad = 1000;
  const gridMinX = uniqueX.length ? (uniqueX[0]  - pad) * MM : -5;
  const gridMaxX = uniqueX.length ? (uniqueX[uniqueX.length - 1] + pad) * MM : 5;
  const gridMinZ = uniqueY.length ? -(uniqueY[uniqueY.length - 1] + pad) * MM : -5;
  const gridMaxZ = uniqueY.length ? -(uniqueY[0]  - pad) * MM : 5;
  const gridY    = globalBot * MM - 0.02;

  const lineMat = new THREE.LineBasicMaterial({ color: 0x4488dd, transparent: true, opacity: 0.4 });
  const addLine = (p1: THREE.Vector3, p2: THREE.Vector3, storeyId?: string) => {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p1, p2]), lineMat);
    line.userData.nodeType = 'storey';
    if (storeyId) line.userData.storeyId = storeyId;
    scene.add(line);
  };
  for (const s of storeyNodes) {
    const sAxX = parseAxes(s.properties.axesX);
    const sAxY = parseAxes(s.properties.axesY);
    const sMinX = sAxX.length ? (Math.min(...sAxX) - pad) * MM : gridMinX;
    const sMaxX = sAxX.length ? (Math.max(...sAxX) + pad) * MM : gridMaxX;
    const sMinZ = sAxY.length ? -(Math.max(...sAxY) + pad) * MM : gridMinZ;
    const sMaxZ = sAxY.length ? -(Math.min(...sAxY) - pad) * MM : gridMaxZ;
    for (const xMm of sAxX) {
      const bx = xMm * MM;
      addLine(new THREE.Vector3(bx, gridY, sMinZ), new THREE.Vector3(bx, gridY, sMaxZ), s.id);
      addLine(new THREE.Vector3(bx, globalBot * MM, sMinZ), new THREE.Vector3(bx, globalTop * MM, sMinZ), s.id);
    }
    for (const yMm of sAxY) {
      const bz = -yMm * MM;
      addLine(new THREE.Vector3(sMinX, gridY, bz), new THREE.Vector3(sMaxX, gridY, bz), s.id);
      addLine(new THREE.Vector3(sMinX, globalBot * MM, bz), new THREE.Vector3(sMinX, globalTop * MM, bz), s.id);
    }
  }

  // ── Columns (standalone column nodes) ─────────────────────────────────────
  for (const n of nodes.filter((n) => n.type === 'column')) {
    const { bot, top } = getStoreyBand(n, nodeMap);
    const h = (top - bot) * MM;
    const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
    let m: THREE.Mesh = new THREE.Mesh(
      circular ? new THREE.CylinderGeometry(w / 2, w / 2, h, 18) : new THREE.BoxGeometry(w, h, d));
    m.position.copy(bim(n.x, n.y, bot + (top - bot) / 2));
    const colVoids = collectVoids(n, { x: n.x, y: n.y, z: bot + (top - bot) / 2 }, edges, nodeMap);
    if (colVoids.length) m = applyVoids(m, colVoids);
    add(m, 'column', 1, n);
  }

  // ── Ax markers — column when has_column === "True" ────────────────────────
  for (const n of nodes.filter((n) => n.type === 'ax')) {
    const { bot, top } = getStoreyBand(n, nodeMap);
    const { x: rx, y: ry } = getAxRealPos(n, nodeMap);
    const hasCol = String(n.properties.has_column ?? '').toLowerCase() === 'true';

    if (hasCol) {
      const h = (top - bot) * MM;
      const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
      let m: THREE.Mesh = new THREE.Mesh(
        circular ? new THREE.CylinderGeometry(w / 2, w / 2, h, 18) : new THREE.BoxGeometry(w, h, d));
      m.position.copy(bim(rx, ry, bot + (top - bot) / 2));
      const axColVoids = collectVoids(n, { x: rx, y: ry, z: bot + (top - bot) / 2 }, edges, nodeMap);
      if (axColVoids.length) m = applyVoids(m, axColVoids);
      add(m, 'column', 1, n, 'column');
    } else {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.12));
      m.position.copy(bim(rx, ry, bot));
      add(m, 'ax', 1, n);
    }
  }

  // ── Walls with openings ────────────────────────────────────────────────────
  // allOpeningCutters is accumulated here and reused to cut shell/covering geometry.
  const allOpeningCutters: ReturnType<typeof makeBoxOpeningCutter>[] = [];
  for (const wn of nodes.filter((n) => n.type === 'wall')) {
    const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins);
    if (!geo) {
      if (String(wn.properties.has_windows) === 'True' || String(wn.properties.has_doors) === 'True') {
        console.warn('[Ara3D] inline-wall null geometry:', wn.id.substring(0, 30), wn.name);
      }
      continue;
    }

    // Debug: inline walls
    if (String(wn.properties.has_windows) === 'True' || String(wn.properties.has_doors) === 'True') {
      console.log(`[Ara3D] inline wall ${wn.name}: openings=${geo.openings.length}, fp=${geo.footprint.length}, wallH=${geo.wallH.toFixed(1)}`);
    }

    const isSep = isWallSeparator(String(wn.properties.wall_type ?? ''));

    if (isSep) {
      // Separator: single flat plane along wall centre-line, different material
      const { bot, top } = getStoreyBand(wn, nodeMap);
      const h = (Number(wn.properties.height ?? (top - bot))) * MM;
      const cx = (geo.sxM + geo.exM) / 2;
      const cz = (geo.szM + geo.ezM) / 2;
      const dx = geo.exM - geo.sxM, dz = geo.ezM - geo.szM;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(len, h));
      plane.position.set(cx, geo.botM + h / 2, cz);
      plane.rotation.y = -Math.atan2(dz, dx);
      plane.userData.nodeType = 'wall';
      plane.userData.nodeId   = wn.id;
      const sepMat = new THREE.MeshStandardMaterial({
        color: 0x88aacc, transparent: true, opacity: 0.35,
        side: THREE.DoubleSide, depthWrite: false,
      });
      plane.material = sepMat;
      scene.add(plane);
      continue;
    }

    // Build solid wall layers, collect cutters per opening, apply CSG voids
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
    for (const layer of layers) {
      const layerNode = syntheticWallNodeForLayer(wn, layer);
      const baseVis = resolveVisuals('wall', String(layer.material ?? ''), matConfig);
      const vis = applyNodeColorOverrides(baseVis, layerNode.properties);
      const wallMat = getMat(matCache, 'wall', 1, vis);
      let wallMesh: THREE.Mesh;
      try {
        wallMesh = (geo.openings.length === 0 || isArc)
          ? wallHorizontalProfileLayerMesh(geo, layer.fromMm, layer.toMm, wallMat)
          : wallSolidLayerMesh(geo, layer.fromMm, layer.toMm, wallMat);
      } catch {
        continue;
      }
      const wm = applyOpeningVoids(wallMesh, cutters);
      wm.castShadow = true;
      wm.receiveShadow = true;
      wm.userData.nodeType = 'wall';
      wm.userData.nodeId   = wn.id;
      wm.userData.storeyId = resolveStoreyId(wn, nodeMap);
      applyNodeLocalTransformThree(wm, getNodeLocalTransform(wn));
      scene.add(wm);
      builtLayer = true;
    }

    if (!builtLayer) {
      for (const seg of geo.solidSegs) add(wallSegBox3(seg), 'wall', 1, wn);
      continue;
    }

    for (const op of geo.openings) {
      // ── IFC library mesh ────────────────────────────────────────────────
      const typeId  = String(op.isDoor ? (op.node.properties.door_type ?? '') : (op.node.properties.window_type ?? ''));
      const ifcPath = resolveIfcPath(op.isDoor ? 'door' : 'window', typeId);
      const ifcInfo    = ifcPath ? ifcGroupCache.get(ifcPath) : null;

      if (ifcInfo) {
        // group local Y=0 = bottom of window = botY + sill
        const placed = positionIfcGroup(
          ifcInfo,
          op.cx,
          op.botY + op.sill,
          op.cz,
          op.nx, op.nz,
          op.oW, op.oH,
        );
        placed.castShadow = true;
        placed.userData.nodeType = op.isDoor ? 'door' : 'window';
        applyIfcGlazingOverrides(placed, resolveWindowGlazing(matConfig));
        if (op.node) {
          applyNodeLocalTransformThree(placed, getNodeLocalTransform(op.node));
          placed.userData.nodeId = op.node.id;
          placed.traverse((c) => {
            c.userData.nodeId   = op.node.id;
            c.userData.nodeType = op.isDoor ? 'door' : 'window';
          });
        }
        scene.add(placed);
      } else {
        const nodeType = op.isDoor ? 'door' : 'window';
        const vis = op.node ? resolveVisuals(nodeType, String(op.node.properties.material ?? ''), matConfig) : null;
        buildOpeningMeshes3(op, new Map(), nodeType, vis, resolveWindowGlazing(matConfig)).forEach((m) => {
          m.castShadow = true;
          m.userData.nodeType = nodeType;
          if (op.node) {
            applyNodeLocalTransformThree(m, getNodeLocalTransform(op.node));
            m.userData.nodeId = op.node.id;
          }
          scene.add(m);
        });
      }
    }
    if (geo.beamDesc) {
      // Use beam_material from the wall node (separate from wall material)
      const beamVis = resolveVisuals('beam', String(wn.properties.beam_material ?? ''), matConfig);
      const beamMesh = spanBox3(geo.beamDesc.ax, geo.beamDesc.az, geo.beamDesc.bx, geo.beamDesc.bz,
        geo.beamDesc.width, geo.beamDesc.height, geo.beamDesc.baseY);
      if (beamMesh) {
        beamMesh.material = getMat(matCache, 'beam', 1, beamVis);
        beamMesh.castShadow = true;
        beamMesh.receiveShadow = true;
        beamMesh.userData.nodeType = 'beam';
        beamMesh.userData.nodeId = wn.id;
        scene.add(beamMesh);
      }
    }
  }

  // ── Standalone Beams ───────────────────────────────────────────────────────
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
    let bm = spanBox3(sx * MM, -sy * MM, ex * MM, -ey * MM, bw, bh, top * MM - bh);
    if (bm) {
      const beamVoids = collectVoids(bn, { x: (sx + ex) / 2, y: (sy + ey) / 2, z: top - bh * 500 }, edges, nodeMap);
      if (beamVoids.length) bm = applyVoids(bm, beamVoids);
    }
    add(bm, 'beam', 1, bn);
  }

  // ── Slabs ─────────────────────────────────────────────────────────────────
  for (const n of nodes.filter((n) => n.type === 'slab')) {
    const { top } = getStoreyBand(n, nodeMap);
    const th   = getNodeSlabThickness(n);
    const slabVoids = collectVoids(n, { x: n.x, y: n.y, z: top - th * 500 }, edges, nodeMap);

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
      let m: THREE.Mesh = new THREE.Mesh(geo);
      m.position.set(0, top * MM - th, 0);
      if (slabVoids.length) m = applyVoids(m, slabVoids);
      add(m, 'slab', 1, n);
    } else {
      // Fallback: bounding box from sibling positions
      const sibs = nodes.filter((s) => s.parentId === n.parentId && s.type !== 'storey');
      const xs   = (sibs.length ? sibs : [n]).map((s) => s.x * MM);
      const zs   = (sibs.length ? sibs : [n]).map((s) => -s.y * MM);
      const cx   = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cz   = (Math.min(...zs) + Math.max(...zs)) / 2;
      const contourOffM = parseContourOffsets(n.properties.contour_offset)[0] * MM;
      const sw   = Math.max(Math.max(...xs) - Math.min(...xs) + 2 * contourOffM, 0.1);
      const sd   = Math.max(Math.max(...zs) - Math.min(...zs) + 2 * contourOffM, 0.1);
      let m: THREE.Mesh = new THREE.Mesh(new THREE.BoxGeometry(sw, th, sd));
      m.position.set(cx, top * MM - th / 2, cz);
      if (slabVoids.length) m = applyVoids(m, slabVoids);
      add(m, 'slab', 1, n);
    }
  }

  // ── Foundations ───────────────────────────────────────────────────────────
  for (const n of nodes.filter((n) => n.type === 'foundation')) {
    const { bot } = getStoreyBand(n, nodeMap);
    let m: THREE.Mesh = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.2));
    m.position.copy(bim(n.x, n.y, bot - 250));
    const foundVoids = collectVoids(n, { x: n.x, y: n.y, z: bot - 250 }, edges, nodeMap);
    if (foundVoids.length) m = applyVoids(m, foundVoids);
    add(m, 'foundation', 1, n);
  }

  // ── Rooms (extruded polygon from connected walls) ────────────────────────
  for (const n of nodes.filter((n) => n.type === 'room')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const roomH = Number(n.properties.height ?? 2650); // mm, default 2650
    const h = roomH * MM;

    // Build and optionally inset the room polygon
    let poly = calcRoomPolygon(n, nodeMap, edges);
    if (poly && poly.length >= 3) {
      // contour_offset: negative = interior. Negate to get inward amounts for insetPolygon.
      const rawOff = parseContourOffsets(n.properties.contour_offset);
      const inward = rawOff.map((o) => -o); // -(-125) = 125 mm inward
      if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);
    }

    if (poly && poly.length >= 3) {
      // Build THREE.Shape in X-Y plane, then rotateX(-PI/2) to stand it upright.
      const extrudeRoom = (shPoly: { x: number; y: number }[], depth: number) => {
        const shape = new THREE.Shape();
        shape.moveTo(shPoly[0].x * MM, shPoly[0].y * MM);
        for (let i = 1; i < shPoly.length; i++) shape.lineTo(shPoly[i].x * MM, shPoly[i].y * MM);
        shape.closePath();
        const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        return geo;
      };

      const m = new THREE.Mesh(extrudeRoom(poly, h));
      m.position.y = bot * MM;
      add(m, 'room', 0.12, n);

      // Room slab — starts at top face of room
      const hasSlab = n.properties.has_slab !== 'False' && n.properties.has_slab !== false;
      if (hasSlab) {
        const slabTh = getNodeSlabThickness(n); // metres
        const sm = new THREE.Mesh(extrudeRoom(poly, slabTh));
        sm.position.y = (bot + roomH) * MM;
        add(sm, 'slab', 1, n, 'slab');
      }
    } else {
      // Fallback: simple box (no walls connected yet)
      const fb = new THREE.Mesh(new THREE.BoxGeometry(3, h, 3));
      fb.position.copy(bim(n.x, n.y, bot + roomH / 2));
      add(fb, 'room', 0.12, n);

      const hasSlab = n.properties.has_slab !== 'False' && n.properties.has_slab !== false;
      if (hasSlab) {
        const slabTh = getNodeSlabThickness(n);
        const sm = new THREE.Mesh(new THREE.BoxGeometry(3, slabTh, 3));
        sm.position.copy(bim(n.x, n.y, bot + roomH + (slabTh * 1000) / 2));
        add(sm, 'slab', 1, n, 'slab');
      }
    }
  }

  // ── Shell & Covering (ring extrusion from ax nodes) ────────────────────────
  // NOTE: opening cuts (windows/doors) require per-face decomposition —
  //   the ring is a plan shape extruded vertically; side holes cannot be
  //   expressed as Shape holes. Implement per-face approach (Phase 2) for cuts.

  const buildRingMesh = (
    poly: { x: number; y: number }[],
    offsets: number[],
    thickMm: number,
    heightM: number,
    botM: number,
  ): THREE.Mesh | null => {
    if (poly.length < 3) return null;
    // inward = negate offset (negative contour_offset = inward)
    const inward = offsets.map((o) => -o);
    const outer = insetPolygon(poly, inward);
    const inner = insetPolygon(poly, inward.map((v) => v + thickMm));
    if (outer.length < 3 || inner.length < 3) return null;

    const shape = new THREE.Shape();
    shape.moveTo(outer[0].x * MM, outer[0].y * MM);
    for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i].x * MM, outer[i].y * MM);
    shape.closePath();

    const hole = new THREE.Path();
    // Reverse inner polygon for correct hole winding
    const rev = [...inner].reverse();
    hole.moveTo(rev[0].x * MM, rev[0].y * MM);
    for (let i = 1; i < rev.length; i++) hole.lineTo(rev[i].x * MM, rev[i].y * MM);
    hole.closePath();
    shape.holes.push(hole);

    const geo = new THREE.ExtrudeGeometry(shape, { depth: heightM, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo);
    m.position.y = botM;
    return m;
  };

  for (const n of nodes.filter((n) => n.type === 'shell')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const shellH = Number(n.properties.height ?? 2800) * MM;
    const thickMm = Number(n.properties.thickness ?? 200);
    const poly = calcShellPolygon(n, nodeMap, edges);
    if (!poly) continue;
    const offsets = parseContourOffsets(n.properties.contour_offset);
    const raw = buildRingMesh(poly, offsets, thickMm, shellH, bot * MM);
    if (raw) {
      const m = allOpeningCutters.length ? applyOpeningVoids(raw, allOpeningCutters) : raw;
      add(m, 'shell', 1, n);
    }
  }

  for (const n of nodes.filter((n) => n.type === 'covering')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const covH = Number(n.properties.height ?? 2800) * MM;
    const thickMm = Number(n.properties.thickness ?? 200);
    const poly = calcShellPolygon(n, nodeMap, edges);
    if (!poly) continue;
    const offsets = parseContourOffsets(n.properties.contour_offset);
    const raw = buildRingMesh(poly, offsets, thickMm, covH, bot * MM);
    if (raw) {
      const m = allOpeningCutters.length ? applyOpeningVoids(raw, allOpeningCutters) : raw;
      add(m, 'covering', 1, n);
    }
  }

  // ── Room-derived covering (has_covering = True on room node) ───────────────────
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
      const raw = buildRingMesh(poly, offsets, layer.thicknessMm, covH, covBot);
      if (!raw) continue;
      const m = allOpeningCutters.length ? applyOpeningVoids(raw, allOpeningCutters) : raw;
      add(m, 'covering', 1, syntheticCoveringNodeForLayer(n, layer), 'covering');
    }
  }

  // Axes gizmo — BIM-aware (X=East/red, Y=Up/blue, Z=North/green)
  addBimAxes(scene, 1);
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Ara3DViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes: BuildingAxes;
  className?: string;
  onSelectNode?: (nodeId: string | null) => void;
  selectedNodeId?: string | null;
}

// ─── Main Component ─────────────────────────────────────────────────────────────────────────────

export function Ara3DViewer({ nodes, edges, buildingAxes: _buildingAxes, className, onSelectNode, selectedNodeId }: Ara3DViewerProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const sceneRef       = useRef<THREE.Scene | null>(null);
  const cameraRef      = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef    = useRef<THREE.WebGLRenderer | null>(null);
  const ambLightRef    = useRef<THREE.AmbientLight | null>(null);
  const dirLightRef    = useRef<THREE.DirectionalLight | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [dayMode, setDayMode] = useState(false);

  // ── Visibility filter (local to this viewer instance) ─────────────────────
  const [hiddenTypes, setHiddenTypes]       = useState<Set<string>>(new Set());
  const [hiddenStoreyIds, setHiddenStoreyIds] = useState<Set<string>>(new Set());

  // Keep a live node map for storey-membership lookups in the visibility effect
  const nodesMapRef = useRef<Map<string, BubbleGraphNode>>(new Map());
  useEffect(() => {
    nodesMapRef.current = new Map(nodes.map((n) => [n.id, n]));
  }, [nodes]);

  // Unique element types present in the current node set (excluding 'storey' as a node type,
  // but we still offer 'storey' as a category for floor planes & grid lines)
  const { visibleTypes, typeCounts } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of nodes) {
      counts[n.type] = (counts[n.type] ?? 0) + 1;
    }
    // Always include 'storey' as a visibility category (controls floor planes + grid)
    if (!counts['storey'] && nodes.some((n) => n.type === 'storey')) counts['storey'] = nodes.filter((n) => n.type === 'storey').length;
    // Virtual 'column' category: ax nodes with has_column=true (if no standalone column nodes)
    if (!counts['column']) {
      const c = nodes.filter((n) => n.type === 'ax' && String(n.properties.has_column ?? '').toLowerCase() === 'true').length;
      if (c > 0) counts['column'] = c;
    }
    // Virtual 'beam' category: wall nodes with has_beam=true
    if (!counts['beam']) {
      const c = nodes.filter((n) => n.type === 'wall' && String(n.properties.has_beam ?? '').toLowerCase() === 'true').length;
      if (c > 0) counts['beam'] = c;
    }
    // Virtual 'covering' category: room nodes with has_covering truthy (default is true — show unless explicitly False)
    if (!counts['covering']) {
      const c = nodes.filter((n) => n.type === 'room' && n.properties.has_covering !== 'False' && n.properties.has_covering !== false).length;
      if (c > 0) counts['covering'] = c;
    }
    return { visibleTypes: Object.keys(counts), typeCounts: counts };
  }, [nodes]);

  const { config: matConfig } = useMaterialConfig();

  const mouseRef        = useRef({ x: 0, y: 0, isDown: false, dragDist: 0 });
  const cameraStateRef  = useRef({ theta: -Math.PI / 4, phi: 1.1, radius: 10 });
  const cameraTargetRef = useRef(new THREE.Vector3(0, 0, 0));
  const hasFitRef       = useRef(false); // auto-fit camera only on first build
  const onSelectNodeRef = useRef(onSelectNode);
  useEffect(() => { onSelectNodeRef.current = onSelectNode; }, [onSelectNode]);
  const selectedNodeIdRef = useRef(selectedNodeId);
  useEffect(() => { selectedNodeIdRef.current = selectedNodeId; }, [selectedNodeId]);

  // ── Day / Night mode ──────────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    const amb   = ambLightRef.current;
    const dir   = dirLightRef.current;
    if (!scene || !amb || !dir) return;
    if (dayMode) {
      scene.background = new THREE.Color(0xd0e8f5);
      amb.color.set(0xfff6e8); amb.intensity = 1.2;
      dir.color.set(0xfff6e8); dir.intensity = 1.8; dir.position.set(50, 80, 30);
    } else {
      scene.background = new THREE.Color(0x1e1e1e);
      amb.color.set(0xffffff); amb.intensity = 0.8;
      dir.color.set(0xffffff); dir.intensity = 1.2; dir.position.set(10, 20, 10);
    }
  }, [dayMode]);

  // ── Visibility effect — runs when hiddenTypes / hiddenStoreyIds changes ──────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.traverse((obj) => {
      const t   = obj.userData.nodeType as string | undefined;
      const sid = obj.userData.storeyId as string | undefined;
      if (!t) return;
      // Type-level check
      if (hiddenTypes.has(t)) { obj.visible = false; return; }
      // Storey-level check (storeyId is pre-computed at build time)
      if (hiddenStoreyIds.size > 0 && sid && hiddenStoreyIds.has(sid)) { obj.visible = false; return; }
      obj.visible = true;
    });
  }, [hiddenTypes, hiddenStoreyIds, isReady]);

  // ── Selection highlight ──────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
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
  }, [selectedNodeId]);

  // ── Scene initialization ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const scene    = new THREE.Scene();
    scene.background = new THREE.Color(0x1e1e1e);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 10000);
    camera.position.set(5, 5, 5);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const amb = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(amb);
    ambLightRef.current = amb;
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(10, 20, 10);
    dir.castShadow = true;
    scene.add(dir);
    dirLightRef.current = dir;

    const updateCamera = () => {
      const { theta, phi, radius } = cameraStateRef.current;
      const t = cameraTargetRef.current;
      // Match Babylon ArcRotateCamera convention: x=sin(alpha), z=cos(alpha)
      camera.position.set(
        t.x + radius * Math.sin(phi) * Math.sin(theta),
        t.y + radius * Math.cos(phi),
        t.z + radius * Math.sin(phi) * Math.cos(theta),
      );
      camera.lookAt(t.x, t.y, t.z);
    };

    const onDown  = (e: MouseEvent) => { mouseRef.current = { x: e.clientX, y: e.clientY, isDown: true, dragDist: 0 }; };
    const onUp    = () => { mouseRef.current.isDown = false; };
    const onMove  = (e: MouseEvent) => {
      if (!mouseRef.current.isDown) return;
      const dx = e.clientX - mouseRef.current.x; const dy = e.clientY - mouseRef.current.y;
      mouseRef.current.dragDist += Math.sqrt(dx * dx + dy * dy);
      cameraStateRef.current.theta -= dx * 0.01;
      cameraStateRef.current.phi    = Math.max(0.1, Math.min(Math.PI - 0.1, cameraStateRef.current.phi + dy * 0.01));
      mouseRef.current.x = e.clientX; mouseRef.current.y = e.clientY;
      updateCamera();
    };
    const onClick = (e: MouseEvent) => {
      if (mouseRef.current.dragDist > 4) return; // ignore drag
      const cb = onSelectNodeRef.current;
      if (!cb || !sceneRef.current || !cameraRef.current) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      const ndcY = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cameraRef.current);
      const hits = raycaster.intersectObjects(sceneRef.current.children, true);
      for (const hit of hits) {
        // Skip objects that are invisible (check full ancestor chain)
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
      cb(null); // clicked empty space — deselect
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraStateRef.current.radius = Math.max(1, Math.min(1000, cameraStateRef.current.radius * (e.deltaY > 0 ? 1.1 : 0.9)));
      updateCamera();
    };
    const onResize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };

    renderer.domElement.addEventListener('mousedown', onDown);
    renderer.domElement.addEventListener('mousemove', onMove);
    renderer.domElement.addEventListener('mouseup', onUp);
    renderer.domElement.addEventListener('click', onClick);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);

    let animId: number;
    const animate = () => { animId = requestAnimationFrame(animate); renderer.render(scene, camera); };
    animate();

    setIsReady(true);

    return () => {
      cancelAnimationFrame(animId);
      renderer.domElement.removeEventListener('mousedown', onDown);
      renderer.domElement.removeEventListener('mousemove', onMove);
      renderer.domElement.removeEventListener('mouseup', onUp);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.domElement.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, []);

  // ── Rebuild geometry when data changes ────────────────────────────────────
  useEffect(() => {
    const scene  = sceneRef.current;
    const camera = cameraRef.current;
    if (!scene || !camera || !isReady) return;

    (async () => {
      // Pre-load any IFC library elements referenced in this node set
      const ifcGroupCache = new Map<string, IFCGroupInfo>();
      const paths = collectIfcLibraryPaths(nodes);
      await Promise.all(
        paths.map(async (lp) => {
          try {
            const parts = await loadIfcParts(lp);
            ifcGroupCache.set(lp, buildIfcGroup(parts));
          } catch (err) {
            console.warn(`[Ara3DViewer] Could not load IFC library part: ${lp}`, err);
          }
        }),
      );

      // Remove old geometry (keep lights/cameras)
      scene.children = scene.children.filter(
        (c: THREE.Object3D) => c instanceof THREE.Light || c instanceof THREE.Camera,
      );

      buildGeometry3(scene, nodes, edges, ifcGroupCache, matConfig);

      // Re-apply visibility toggles after rebuild
      scene.traverse((obj) => {
        const t   = obj.userData.nodeType as string | undefined;
        const sid = obj.userData.storeyId as string | undefined;
        if (!t) return;
        if (hiddenTypes.has(t)) { obj.visible = false; return; }
        if (hiddenStoreyIds.size > 0 && sid && hiddenStoreyIds.has(sid)) { obj.visible = false; return; }
        obj.visible = true;
      });

      // Re-apply selection highlight after geometry rebuild
      const selId = selectedNodeIdRef.current;
      if (selId) {
        scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh && obj.userData.nodeId === selId) {
            const mat = obj.material as THREE.MeshStandardMaterial;
            if (mat && !Array.isArray(mat)) {
              mat.emissive.set(0xffd700);
              mat.emissiveIntensity = 0.6;
            }
          }
        });
      }

      // Auto-focus camera on built geometry (traverse ALL objects, including IFC groups)
      const box = new THREE.Box3();
      scene.traverse((c: THREE.Object3D) => {
        if (c instanceof THREE.Mesh || c instanceof THREE.Line) box.expandByObject(c);
      });
      if (!box.isEmpty() && !hasFitRef.current) {
        hasFitRef.current = true;
        // Orbit around building center, not world origin
        const center = new THREE.Vector3();
        box.getCenter(center);
        cameraTargetRef.current.copy(center);

        const size = box.getSize(new THREE.Vector3());
        const diag = Math.sqrt(size.x ** 2 + size.y ** 2 + size.z ** 2);
        cameraStateRef.current.radius = Math.max(diag * 0.9, 5);
        const { theta, phi, radius } = cameraStateRef.current;
        camera.position.set(
          center.x + radius * Math.sin(phi) * Math.sin(theta),
          center.y + radius * Math.cos(phi),
          center.z + radius * Math.sin(phi) * Math.cos(theta),
        );
        camera.lookAt(center.x, center.y, center.z);
      }
    })();
  }, [nodes, edges, isReady, matConfig, hiddenTypes]);

  return (
    <div ref={containerRef} className={cn('w-full h-full relative', className)}>
      {!isReady && (
        <div className="flex items-center justify-center h-full text-white text-sm">
          Initializing Three.js viewer…
        </div>
      )}
      {isReady && (
        <>
          <button
            onClick={() => setDayMode((d) => !d)}
            title={dayMode ? 'Switch to Night mode' : 'Switch to Day mode'}
            className="absolute top-2 right-2 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/60 text-lg select-none transition-colors"
          >
            {dayMode ? '🌙' : '☀️'}
          </button>
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
        </>
      )}
    </div>
  );
}
