/**
 * TechnicalDrawingsViewer — SVG-based 2D BIM drawing viewer.
 *
 * Renders floorplan, section, and elevation technical drawings as SVG with:
 *   - Element-grouped paths joined into closed polygons
 *   - Hatch fill for sectioned walls / columns
 *   - Native SVG click events for eraser and editing
 *   - Pan (drag) + zoom (wheel) via viewBox manipulation
 *
 * Pipeline: buildBimGeometry -> extractTaggedEdges -> clip -> project -> join -> SVG
 *
 * Coordinate mapping (BIM -> Three.js world -> SVG):
 *   BIM X->East,  BIM Y->North,  BIM Z->Up
 *   Three: X=East, Y=Up(BIM Z), Z=-North(-BIM Y)
 *   SVG floorplan: svgX=worldX,   svgY=worldZ   (north up)
 *   SVG section:   svgX=worldX,   svgY=-worldY   (elevation up)
 *   SVG elevation:  svgX=-worldZ,  svgY=-worldY   (north right, elevation up)
 */

import { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { cn, parseAxes } from '@/lib/utils';
import { clientToSvgUserPoint } from '@/lib/svgCoordinates';
import { VisibilityFilter } from '@/components/views/VisibilityFilter';
import { AnnotationsToolbar } from './AnnotationsToolbar';
import { SvgAnnotationLayer, type SvgAnnotationTool } from './SvgAnnotationLayer';
import { useBubbleGraphStore } from '@/store';
import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes, StoreyDiscipline } from '@/store';
import {
  MM,
  parseColumnDims, parseBeamDims, parseSlabThickness, getNodeSlabThickness,
  getStoreyBand, getAxRealPos, getNodeBimPos, getConnectedNodes,
  calcWallGeometry, calcWallJoins, calcStoreyPlanExtents, calcShellPolygon,
  parseContourOffsets, insetPolygon, calcSpanEffectiveEnds,
  getNodeLocalTransform,
  type WallSegDesc,
} from '@/lib/bimGeometry';
import { getMat, buildOpeningMeshes3, spanBox3, applyNodeLocalTransformThree } from '@/lib/bimGeometryThree';
import {
  type MaterialConfig, resolveVisuals, applyNodeColorOverrides, type MaterialVisuals, type HatchPattern,
} from '@/lib/materialConfig';
import { useMaterialConfig } from '@/lib/useMaterialConfig';

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Types
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

export type DrawingViewType = 'floorplan' | 'section' | 'elevation';
/** Which compass direction the elevation camera is looking FROM. */
export type ElevationDir = 'N' | 'S' | 'E' | 'W';

export interface TechnicalDrawingsViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes?: BuildingAxes;
  storeyId?: string | null;
  discipline?: StoreyDiscipline | null;
  viewType?: DrawingViewType;
  cutElevation?: number;
  cutY?: number;
  cutX?: number;
  cutDepth?: number;
  startElevation?: number;
  endElevation?: number;
  /** For elevation views: which facade direction to show (default 'W'). */
  viewDirection?: ElevationDir;
  onParamsChange?: (params: {
    cutElevation?: number; cutY?: number; cutX?: number;
    cutDepth?: number; startElevation?: number; endElevation?: number;
  }) => void;
  className?: string;
}

/** A line segment in Three.js world space tagged with its source BIM element. */
interface TaggedEdge {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  elementId: string;
  elementType: string;
}

/** A 2D edge in SVG coordinate space + source tag. */
interface SvgEdge {
  x1: number; y1: number;
  x2: number; y2: number;
  elementId: string;
  elementType: string;
}

/** A group of SVG paths for a single BIM element. */
interface SvgElementGroup {
  elementId: string;
  elementType: string;
  /** Closed polygon paths (d attribute). Filled with hatch for walls/columns. */
  closedPaths: string[];
  /** Open polyline paths (d attribute). Stroke only. */
  openPaths: string[];
}

interface ViewBox {
  x: number; y: number; w: number; h: number;
}

// SVG Annotations
interface SvgLinearAnnotation {
  id: string; kind: 'linear';
  p1: { x: number; y: number };
  p2: { x: number; y: number };
}
interface SvgCalloutAnnotation {
  id: string; kind: 'callout';
  px: number; py: number;
  text: string;
}
type SvgAnnotation = SvgLinearAnnotation | SvgCalloutAnnotation;

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Helper: mesh userData for element tagging
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function getElementTag(obj: THREE.Object3D): { elementId: string; elementType: string } {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (cur.userData?.elementId) return cur.userData as { elementId: string; elementType: string };
    cur = cur.parent;
  }
  return { elementId: 'unknown', elementType: 'unknown' };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Edge extraction with element tagging
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function extractTaggedEdges(root: THREE.Object3D): TaggedEdge[] {
  const result: TaggedEdge[] = [];
  root.updateWorldMatrix(true, true);

  root.traverse((obj) => {
    if (obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
      const geo = obj.geometry as THREE.BufferGeometry;
      const pos = geo.attributes.position;
      if (!pos) return;
      const mat = obj.matrixWorld;
      const tag = getElementTag(obj);
      for (let i = 0; i < pos.count - 1; i += 2) {
        const a = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mat);
        const b = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)).applyMatrix4(mat);
        result.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, ...tag });
      }
    } else if (obj instanceof THREE.Mesh) {
      const mat3 = obj.material as THREE.Material;
      if (mat3 && (mat3 as THREE.MeshStandardMaterial).transparent &&
          (mat3 as THREE.MeshStandardMaterial).opacity < 0.8) return;
      const edges = new THREE.EdgesGeometry(obj.geometry, 35);
      const pos = edges.attributes.position;
      if (!pos) { edges.dispose(); return; }
      const mat = obj.matrixWorld;
      const tag = getElementTag(obj);
      for (let i = 0; i < pos.count - 1; i += 2) {
        const a = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mat);
        const b = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)).applyMatrix4(mat);
        result.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, ...tag });
      }
      edges.dispose();
    }
  });

  return result;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// BIM geometry builder (with element tagging via userData on Groups)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function pose(x: number, y: number, z: number, rotY = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationY(rotY);
  m.setPosition(x, y, z);
  return m;
}

function addMesh(
  parent: THREE.Group,
  geom: THREE.BufferGeometry,
  mat: THREE.Material,
  matrix: THREE.Matrix4,
): void {
  const mesh = new THREE.Mesh(geom, mat);
  mesh.applyMatrix4(matrix);
  parent.add(mesh);
}

function wallSegMesh(parent: THREE.Group, seg: WallSegDesc, mat: THREE.Material): void {
  const { ax, az, bx, bz, tStart, tEnd, width, height, baseY } = seg;
  const dx = bx - ax; const dz = bz - az;
  const wallLen = Math.sqrt(dx * dx + dz * dz);
  if (wallLen < 1e-6 || tEnd - tStart < 1e-6) return;
  const ux = dx / wallLen; const uz = dz / wallLen;
  const segLen = tEnd - tStart;
  addMesh(parent,
    new THREE.BoxGeometry(segLen, height, width), mat,
    pose(ax + ux * (tStart + tEnd) / 2, baseY + height / 2, az + uz * (tStart + tEnd) / 2, Math.atan2(dz, dx)));
}

function buildBimGeometry(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null,
): THREE.Group {
  const nodeMap   = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  const matCache  = new Map<string, THREE.MeshStandardMaterial>();
  const root      = new THREE.Group();
  root.name = '__td_bim_root__';

  const storeyNodes = nodes.filter((n) => n.type === 'storey');
  const storeyMap   = new Map<string, THREE.Group>();

  for (const s of storeyNodes) {
    const sg = new THREE.Group(); sg.name = `storey_${s.id}`; root.add(sg);
    storeyMap.set(s.id, sg);
    const bot = Number(s.properties.bottomElevation ?? 0);
    const top = Number(s.properties.topElevation   ?? 3000);
    const { cXm, cZm, planWm, planDm } = calcStoreyPlanExtents(s, nodes);
    const planeMat = new THREE.MeshStandardMaterial({ color: 0x383848, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
    // Floor plane — tagged as storey element
    const flrGrp = new THREE.Group();
    flrGrp.userData = { elementId: `${s.id}_floor`, elementType: 'slab' };
    const flr = new THREE.Mesh(new THREE.PlaneGeometry(planWm, planDm), planeMat.clone());
    flr.rotation.x = -Math.PI / 2; flr.position.set(cXm, bot * MM, cZm);
    flrGrp.add(flr); sg.add(flrGrp);
    // Ceiling plane
    const ceilGrp = new THREE.Group();
    ceilGrp.userData = { elementId: `${s.id}_ceil`, elementType: 'slab' };
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(planWm, planDm), planeMat.clone());
    ceil.rotation.x = -Math.PI / 2; ceil.position.set(cXm, top * MM, cZm);
    ceilGrp.add(ceil); sg.add(ceilGrp);
  }

  const fallback = new THREE.Group(); fallback.name = 'orphaned'; root.add(fallback);
  const getGrp = (n: BubbleGraphNode): THREE.Group =>
    (n.parentId ? storeyMap.get(n.parentId) : undefined) ?? fallback;

  // Columns from ax nodes
  for (const n of nodes.filter((n) => n.type === 'ax')) {
    const { x: rx, y: ry } = getAxRealPos(n, nodeMap);
    const hasCol = String(n.properties.has_column ?? '').toLowerCase() === 'true';
    if (hasCol) {
      const storey = n.parentId ? nodeMap.get(n.parentId) : undefined;
      if (storey) {
        const bot = Number(storey.properties.bottomElevation ?? 0);
        const top = Number(storey.properties.topElevation   ?? 3000);
        const h = (top - bot) * MM;
        const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
        const colGrp = new THREE.Group();
        colGrp.userData = { elementId: n.id, elementType: 'column' };
        const colGeo = circular
          ? new THREE.CylinderGeometry(w / 2, w / 2, h, 18)
          : new THREE.BoxGeometry(w, h, d);
        const colMesh = new THREE.Mesh(
          colGeo,
          getMat(matCache, 'column', 1, applyNodeColorOverrides(resolveVisuals('column', String(n.properties.material ?? ''), matConfig), n.properties)),
        );
        colMesh.position.set(rx * MM, (bot + (top - bot) / 2) * MM, -ry * MM);
        applyNodeLocalTransformThree(colMesh, getNodeLocalTransform(n));
        colGrp.add(colMesh); getGrp(n).add(colGrp);
      }
    }
  }

  // Standalone column nodes
  for (const n of nodes.filter((n) => n.type === 'column')) {
    const storey = n.parentId ? nodeMap.get(n.parentId) : undefined;
    if (!storey) continue;
    const bot = Number(storey.properties.bottomElevation ?? 0);
    const top = Number(storey.properties.topElevation   ?? 3000);
    const h = (top - bot) * MM;
    const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
    const colGrp = new THREE.Group();
    colGrp.userData = { elementId: n.id, elementType: 'column' };
    const colGeo = circular
      ? new THREE.CylinderGeometry(w / 2, w / 2, h, 18)
      : new THREE.BoxGeometry(w, h, d);
    const colMesh = new THREE.Mesh(
      colGeo,
      getMat(matCache, 'column', 1, applyNodeColorOverrides(resolveVisuals('column', String(n.properties.material ?? ''), matConfig), n.properties)),
    );
    colMesh.position.set(n.x * MM, (bot + (top - bot) / 2) * MM, -n.y * MM);
    applyNodeLocalTransformThree(colMesh, getNodeLocalTransform(n));
    colGrp.add(colMesh); getGrp(n).add(colGrp);
  }

  // Walls — solidSegs BoxGeometry for clean 90Â° edges
  for (const wn of nodes.filter((n) => n.type === 'wall')) {
    const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins);
    if (!geo) continue;
    const wallMat = getMat(matCache, 'wall', 1, resolveVisuals('wall', String(wn.properties.material ?? ''), matConfig));
    const wallGrp = new THREE.Group();
    wallGrp.userData = { elementId: wn.id, elementType: 'wall' };
    const grp = getGrp(wn);
    geo.solidSegs.forEach((seg) => wallSegMesh(wallGrp, seg, wallMat));
    grp.add(wallGrp);

    // Openings — each in its own tagged group
    for (const op of geo.openings) {
      const opGrp = new THREE.Group();
      opGrp.userData = {
        elementId: op.node?.id ?? `${wn.id}_opening`,
        elementType: op.isDoor ? 'door' : 'window',
      };
      const visuals = resolveVisuals(op.isDoor ? 'door' : 'window', String(op.node?.properties.material ?? ''), matConfig);
      buildOpeningMeshes3(op, matCache, op.isDoor ? 'door' : 'window', visuals).forEach((m) => opGrp.add(m));
      grp.add(opGrp);
    }

    // Wall-integrated beam
    if (geo.beamDesc) {
      const bd = geo.beamDesc;
      const bm = spanBox3(bd.ax, bd.az, bd.bx, bd.bz, bd.width, bd.height, bd.baseY);
      if (bm) {
        const beamGrp = new THREE.Group();
        beamGrp.userData = { elementId: `${wn.id}_beam`, elementType: 'beam' };
        bm.material = getMat(matCache, 'beam', 1, resolveVisuals('beam', String(wn.properties.beam_material ?? ''), matConfig));
        beamGrp.add(bm); grp.add(beamGrp);
      }
    }
  }

  // Standalone beams
  for (const bn of nodes.filter((n) => n.type === 'beam')) {
    const { top } = getStoreyBand(bn, nodeMap);
    const connectedNodes = getConnectedNodes(bn.id, edges, nodeMap);
    if (connectedNodes.length < 2) continue;
    const posA = getNodeBimPos(connectedNodes[0], nodeMap);
    const posB = getNodeBimPos(connectedNodes[1], nodeMap);
    const dx = posB.x - posA.x, dy = posB.y - posA.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) continue;
    const { sx, sy, ex, ey } = calcSpanEffectiveEnds(bn, posA, posB, connectedNodes[0], connectedNodes[1], nodeMap);
    const sec = String(bn.properties.beam_section ?? bn.properties.beam_type ?? 'B30x60');
    const { bw, bh } = parseBeamDims(sec);
    const bm = spanBox3(
      sx * MM, -sy * MM,
      ex * MM, -ey * MM,
      bw, bh, top * MM - bh,
    );
    if (bm) {
      const beamGrp = new THREE.Group();
      beamGrp.userData = { elementId: bn.id, elementType: 'beam' };
      bm.material = getMat(matCache, 'beam', 1, resolveVisuals('beam', String(bn.properties.material ?? ''), matConfig));
      beamGrp.add(bm); getGrp(bn).add(beamGrp);
    }
  }

  // Slabs
  for (const sn of nodes.filter((n) => n.type === 'slab')) {
    const { top } = getStoreyBand(sn, nodeMap);
    const th = getNodeSlabThickness(sn);
    const slabGrp = new THREE.Group();
    slabGrp.userData = { elementId: sn.id, elementType: 'slab' };
    const slabMatl = getMat(matCache, 'slab', 1, applyNodeColorOverrides(resolveVisuals('slab', String(sn.properties.material ?? ''), matConfig), sn.properties));

    // Try polygon from direct ax/column connections (edge-order perimeter)
    let poly = calcShellPolygon(sn, nodeMap, edges);
    if (poly && poly.length >= 3) {
      const rawOff = parseContourOffsets(sn.properties.contour_offset);
      const inward = rawOff.map((o: number) => -o);
      if (inward.some((o: number) => o !== 0)) poly = insetPolygon(poly, inward);
      const shape = new THREE.Shape();
      shape.moveTo(poly[0].x * MM, poly[0].y * MM);
      for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x * MM, poly[i].y * MM);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const slabMesh = new THREE.Mesh(geo, slabMatl);
      slabMesh.position.set(0, top * MM - th, 0);
      applyNodeLocalTransformThree(slabMesh, getNodeLocalTransform(sn));
      slabGrp.add(slabMesh);
    } else {
      // Fallback: bounding box from storey axes or node position
      const storey = sn.parentId ? nodeMap.get(sn.parentId) : undefined;
      const axesXS = storey ? Array.isArray(storey.properties.axesX) ? storey.properties.axesX as number[] : [] : [];
      const axesYS = storey ? Array.isArray(storey.properties.axesY) ? storey.properties.axesY as number[] : [] : [];
      const xs = axesXS.length ? axesXS : [sn.x];
      const ys = axesYS.length ? axesYS : [sn.y];
      const slabW = (Math.max(...xs) - Math.min(...xs)) * MM || 1;
      const slabD = (Math.max(...ys) - Math.min(...ys)) * MM || 1;
      const cx   = ((Math.min(...xs) + Math.max(...xs)) / 2) * MM;
      const cz   = -((Math.min(...ys) + Math.max(...ys)) / 2) * MM;
      const slabMesh = new THREE.Mesh(new THREE.BoxGeometry(slabW, th, slabD), slabMatl);
      slabMesh.position.set(cx, top * MM - th / 2, cz);
      applyNodeLocalTransformThree(slabMesh, getNodeLocalTransform(sn));
      slabGrp.add(slabMesh);
    }
    getGrp(sn).add(slabGrp);
  }

  // Shells & Coverings — per-edge BoxGeometry
  // Apply contour_offset so boxes sit at the actual wall-face position (matching Ara3DViewer).
  for (const shn of nodes.filter((n) => n.type === 'shell' || n.type === 'covering')) {
    const poly = calcShellPolygon(shn, nodeMap, edges);
    if (!poly || poly.length < 3) continue;
    const { bot, top } = getStoreyBand(shn, nodeMap);
    const h = (shn.type === 'covering'
      ? Number(shn.properties.covering_height ?? shn.properties.height ?? 200)
      : Number(shn.properties.height ?? (top - bot))) * MM;
    const thickMm = Number(shn.properties.thickness ?? (shn.type === 'covering' ? 150 : 200));
    const th = thickMm * MM;
    const baseElevM = bot * MM;
    const mat = getMat(matCache, shn.type, 1, resolveVisuals(shn.type, String(shn.properties.material ?? ''), matConfig));
    const shellGrp = new THREE.Group();
    shellGrp.userData = { elementId: shn.id, elementType: shn.type };
    const grp = getGrp(shn);

    // Compute midwall polygon (same logic as Ara3DViewer buildRingMesh):
    // outer = inset(poly, -contourOffset), inner = inset(poly, -contourOffset + thickMm)
    // centerline = inset(poly, -contourOffset + thickMm/2)
    const offsets = parseContourOffsets(shn.properties.contour_offset);
    const inward = offsets.map((o) => -o);
    const midPoly = insetPolygon(poly, inward.map((v) => v - thickMm / 2));

    for (let i = 0; i < midPoly.length; i++) {
      const pA = midPoly[i], pB = midPoly[(i + 1) % midPoly.length];
      const axP = pA.x * MM, azP = -pA.y * MM;
      const bxP = pB.x * MM, bzP = -pB.y * MM;
      const dxP = bxP - axP, dzP = bzP - azP;
      const len = Math.sqrt(dxP * dxP + dzP * dzP);
      if (len < 1e-5) continue;
      const box = new THREE.Mesh(new THREE.BoxGeometry(len, h, th), mat);
      box.position.set((axP + bxP) / 2, baseElevM + h / 2, (azP + bzP) / 2);
      box.rotation.y = Math.atan2(dzP, dxP);
      shellGrp.add(box);
    }
    grp.add(shellGrp);
  }

  return root;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Clipping functions (world-space, operate on TaggedEdge[])
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function clipSegmentY(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  minYm: number, maxYm: number,
): [number, number, number, number, number, number] | null {
  if (ay < minYm && by < minYm) return null;
  if (ay > maxYm && by > maxYm) return null;
  let t0 = 0, t1 = 1;
  const dy = by - ay;
  if (Math.abs(dy) > 1e-10) {
    const tMin = (minYm - ay) / dy;
    const tMax = (maxYm - ay) / dy;
    if (dy > 0) { t0 = Math.max(t0, tMin); t1 = Math.min(t1, tMax); }
    else        { t0 = Math.max(t0, tMax); t1 = Math.min(t1, tMin); }
  }
  if (t0 >= t1 - 1e-10) return null;
  return [
    ax + t0 * (bx - ax), ay + t0 * dy, az + t0 * (bz - az),
    ax + t1 * (bx - ax), ay + t1 * dy, az + t1 * (bz - az),
  ];
}

function clipSegmentAxis(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  axIdx: 0 | 2,
  minV: number, maxV: number,
): [number, number, number, number, number, number] | null {
  const va = axIdx === 0 ? ax : az;
  const vb = axIdx === 0 ? bx : bz;
  if (va < minV && vb < minV) return null;
  if (va > maxV && vb > maxV) return null;
  let t0 = 0, t1 = 1;
  const dv = vb - va;
  if (Math.abs(dv) > 1e-10) {
    const tMin = (minV - va) / dv;
    const tMax = (maxV - va) / dv;
    if (dv > 0) { t0 = Math.max(t0, tMin); t1 = Math.min(t1, tMax); }
    else        { t0 = Math.max(t0, tMax); t1 = Math.min(t1, tMin); }
  }
  if (t0 >= t1 - 1e-10) return null;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  return [ax + t0*dx, ay + t0*dy, az + t0*dz, ax + t1*dx, ay + t1*dy, az + t1*dz];
}

function clipTaggedEdgesToCutDepth(
  edges: TaggedEdge[],
  viewType: DrawingViewType,
  cutY: number, cutX: number, cutDepth: number,
  dir: ElevationDir = 'W',
): TaggedEdge[] {
  if (viewType === 'floorplan') return edges;
  const out: TaggedEdge[] = [];

  if (viewType === 'section') {
    const zNear = -cutY * MM;
    const zFar  = -(cutY + cutDepth) * MM;
    const zMin  = Math.min(zNear, zFar);
    const zMax  = Math.max(zNear, zFar);
    for (const e of edges) {
      const seg = clipSegmentAxis(e.ax, e.ay, e.az, e.bx, e.by, e.bz, 2, zMin, zMax);
      if (seg) out.push({ ax: seg[0], ay: seg[1], az: seg[2], bx: seg[3], by: seg[4], bz: seg[5], elementId: e.elementId, elementType: e.elementType });
    }
  } else if (viewType === 'elevation') {
    if (dir === 'N' || dir === 'S') {
      // N/S elevations: clip along Z axis (worldZ = -BIM_Y)
      // cutY = clipping position in BIM_Y (mm), depth extends toward larger BIM_Y
      const zNear = -cutY * MM;
      const zFar  = -(cutY + cutDepth) * MM;
      const zMin  = Math.min(zNear, zFar);
      const zMax  = Math.max(zNear, zFar);
      for (const e of edges) {
        const seg = clipSegmentAxis(e.ax, e.ay, e.az, e.bx, e.by, e.bz, 2, zMin, zMax);
        if (seg) out.push({ ax: seg[0], ay: seg[1], az: seg[2], bx: seg[3], by: seg[4], bz: seg[5], elementId: e.elementId, elementType: e.elementType });
      }
    } else {
      // E/W elevations: clip along X axis (existing behaviour)
      const xNear = cutX * MM;
      const xFar  = (cutX - cutDepth) * MM;
      const xMin  = Math.min(xNear, xFar);
      const xMax  = Math.max(xNear, xFar);
      for (const e of edges) {
        const seg = clipSegmentAxis(e.ax, e.ay, e.az, e.bx, e.by, e.bz, 0, xMin, xMax);
        if (seg) out.push({ ax: seg[0], ay: seg[1], az: seg[2], bx: seg[3], by: seg[4], bz: seg[5], elementId: e.elementId, elementType: e.elementType });
      }
    }
  }
  return out;
}

function clipTaggedEdgesToElevation(
  edges: TaggedEdge[],
  viewType: DrawingViewType,
  startElev: number, endElev: number,
): TaggedEdge[] {
  if (viewType === 'floorplan') return edges;
  const minYm = startElev * MM;
  const maxYm = endElev   * MM;
  const out: TaggedEdge[] = [];
  for (const e of edges) {
    const seg = clipSegmentY(e.ax, e.ay, e.az, e.bx, e.by, e.bz, minYm, maxYm);
    if (seg) out.push({ ax: seg[0], ay: seg[1], az: seg[2], bx: seg[3], by: seg[4], bz: seg[5], elementId: e.elementId, elementType: e.elementType });
  }
  return out;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Projection: world-space -> SVG 2D coordinates
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function projectToSvg(wx: number, wy: number, wz: number, vt: DrawingViewType, dir: ElevationDir = 'W'): { x: number; y: number } {
  switch (vt) {
    case 'floorplan': return { x: wx, y: wz };       // X=East→right, Z=-North→up (SVG Y-down)
    case 'section':   return { x: wx, y: -wy };      // X=East→right, Y=elevation→up
    case 'elevation':
      // worldX = BIM_X (East), worldY = elev (Up), worldZ = -BIM_Y (South)
      switch (dir) {
        case 'W': return { x: -wz, y: -wy };  // svgX = +BIM_Y (South→left, North→right)
        case 'E': return { x:  wz, y: -wy };  // svgX = -BIM_Y (mirrored — East camera)
        case 'S': return { x:  wx, y: -wy };  // svgX = +BIM_X (West→left, East→right)
        case 'N': return { x: -wx, y: -wy };  // svgX = -BIM_X (mirrored — North camera)
      }
  }
}

function projectTaggedEdges(edges: TaggedEdge[], vt: DrawingViewType, dir: ElevationDir = 'W'): SvgEdge[] {
  return edges.map((e) => {
    const a = projectToSvg(e.ax, e.ay, e.az, vt, dir);
    const b = projectToSvg(e.bx, e.by, e.bz, vt, dir);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, elementId: e.elementId, elementType: e.elementType };
  });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Path joining: connect edges into closed polygons / open polylines
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const JOIN_EPS = 0.0005; // 0.5mm tolerance for joining endpoints

function joinEdgesToPaths(edges: SvgEdge[]): { closedPaths: string[]; openPaths: string[] } {
  const remaining = new Set<number>(edges.map((_, i) => i));
  const closedPaths: string[] = [];
  const openPaths: string[] = [];

  while (remaining.size > 0) {
    const startIdx = remaining.values().next().value!;
    remaining.delete(startIdx);
    const start = edges[startIdx];
    const chain: [number, number][] = [[start.x1, start.y1], [start.x2, start.y2]];

    let extended = true;
    while (extended) {
      extended = false;
      const [hx, hy] = chain[0];
      const [tx, ty] = chain[chain.length - 1];

      for (const idx of remaining) {
        const e = edges[idx];
        // Extend tail
        if (Math.hypot(e.x1 - tx, e.y1 - ty) < JOIN_EPS) {
          chain.push([e.x2, e.y2]); remaining.delete(idx); extended = true; break;
        }
        if (Math.hypot(e.x2 - tx, e.y2 - ty) < JOIN_EPS) {
          chain.push([e.x1, e.y1]); remaining.delete(idx); extended = true; break;
        }
        // Extend head
        if (Math.hypot(e.x2 - hx, e.y2 - hy) < JOIN_EPS) {
          chain.unshift([e.x1, e.y1]); remaining.delete(idx); extended = true; break;
        }
        if (Math.hypot(e.x1 - hx, e.y1 - hy) < JOIN_EPS) {
          chain.unshift([e.x2, e.y2]); remaining.delete(idx); extended = true; break;
        }
      }
    }

    // Build SVG path d attribute
    const [fx, fy] = chain[0];
    const [lx, ly] = chain[chain.length - 1];
    const closed = chain.length > 2 && Math.hypot(fx - lx, fy - ly) < JOIN_EPS;

    // Use compact fixed-precision coordinates
    let d = `M${chain[0][0].toFixed(4)} ${chain[0][1].toFixed(4)}`;
    for (let i = 1; i < chain.length; i++) {
      d += `L${chain[i][0].toFixed(4)} ${chain[i][1].toFixed(4)}`;
    }
    if (closed) {
      d += 'Z';
      closedPaths.push(d);
    } else {
      openPaths.push(d);
    }
  }

  return { closedPaths, openPaths };
}

/**
 * Remove duplicate projected edges that arise when adjacent BoxGeometry meshes
 * share a face (walls+columns, wall segments around openings, etc.).
 *
 * Two edges are considered duplicates if both endpoints are within `eps` metres
 * of each other (in either orientation). Uses a snap-grid hash for O(n) speed.
 *
 * Dedup happens GLOBALLY across all elements so column/wall junction seams
 * are deduplicated even when they come from different element groups.
 * The first occurrence (lowest index) wins, preserving its elementId/Type.
 */
function deduplicateEdges(edges: SvgEdge[], eps = 0.002): SvgEdge[] {
  // snap to grid cell size = eps
  const s = (v: number) => Math.round(v / eps);
  const seen = new Map<string, true>();
  return edges.filter((e) => {
    const ax = s(e.x1), ay = s(e.y1);
    const bx = s(e.x2), by = s(e.y2);
    // Skip zero-length edges
    if (ax === bx && ay === by) return false;
    // Canonical key: always put the lexicographically smaller point first
    const key = (ax < bx || (ax === bx && ay <= by))
      ? `${ax},${ay}|${bx},${by}`
      : `${bx},${by}|${ax},${ay}`;
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

/** Group edges by elementId and join each group into paths. */
function groupAndJoinEdges(svgEdges: SvgEdge[]): SvgElementGroup[] {
  const byElement = new Map<string, SvgEdge[]>();
  for (const e of svgEdges) {
    let arr = byElement.get(e.elementId);
    if (!arr) { arr = []; byElement.set(e.elementId, arr); }
    arr.push(e);
  }
  const groups: SvgElementGroup[] = [];
  for (const [id, edgesInGroup] of byElement) {
    const type = edgesInGroup[0].elementType;
    const { closedPaths, openPaths } = joinEdgesToPaths(edgesInGroup);
    groups.push({ elementId: id, elementType: type, closedPaths, openPaths });
  }
  return groups;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Grid line generation (SVG)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

interface SvgGridLine {
  x1: number; y1: number; x2: number; y2: number;
  /** Position of the label bubble (at the extended far end of the line). */
  labelX: number; labelY: number;
  label: string;
  isX: boolean;
}

function buildGridLines(
  allAxesX: number[], allAxesY: number[],
  _storeyBot: number,
  minX: number, maxX: number, minY: number, maxY: number,
  globalMinElev: number, globalMaxElev: number,
  viewType: DrawingViewType,
  extM: number,       // extension beyond walls in metres (SVG units)
  dir: ElevationDir = 'W',
): SvgGridLine[] {
  const lines: SvgGridLine[] = [];

  if (viewType === 'floorplan') {
    // X axes: vertical lines. In SVG: svgX = worldX, svgY = worldZ = -bimY * MM
    // minY (south) -> svgY = -minY*MM  (less negative = lower in SVG = south)
    // maxY (north) -> svgY = -maxY*MM  (more negative = higher in SVG = north)
    // Extension: south end moves down (+Y in SVG), north end moves up (-Y in SVG)
    allAxesX.forEach((axX, i) => {
      const svgX   = axX * MM;
      const svgY_S = -minY * MM + extM;   // south end extended below building
      const svgY_N = -maxY * MM - extM;   // north end extended above building
      lines.push({
        x1: svgX, y1: svgY_S,
        x2: svgX, y2: svgY_N,
        labelX: svgX, labelY: svgY_S,     // label at south (bottom) end
        label: `${i + 1}`, isX: true,
      });
    });
    // Y axes: horizontal lines. svgY = constant, svgX varies east–west
    // minX -> svgX = minX*MM (west), maxX -> svgX = maxX*MM (east)
    allAxesY.forEach((axY, i) => {
      const svgY   = -axY * MM;
      const svgX_W = minX * MM - extM;    // west end extended left
      const svgX_E = maxX * MM + extM;    // east end extended right
      lines.push({
        x1: svgX_W, y1: svgY,
        x2: svgX_E, y2: svgY,
        labelX: svgX_W, labelY: svgY,     // label at west (left) end
        label: String.fromCharCode(65 + i), isX: false,
      });
    });
  } else if (viewType === 'section') {
    // X axes: vertical lines. svgX = worldX = bimX*MM, svgY = -worldY = -elev*MM
    allAxesX.forEach((axX, i) => {
      const svgX    = axX * MM;
      const svgY_Hi = -globalMaxElev * MM - extM;  // top extended up
      const svgY_Lo = -globalMinElev * MM + extM;  // bottom extended down
      lines.push({
        x1: svgX, y1: svgY_Hi,
        x2: svgX, y2: svgY_Lo,
        labelX: svgX, labelY: svgY_Lo,    // label at bottom
        label: `${i + 1}`, isX: true,
      });
    });
  } else if (viewType === 'elevation') {
    const svgY_Hi = -globalMaxElev * MM - extM;
    const svgY_Lo = -globalMinElev * MM + extM;

    if (dir === 'W' || dir === 'E') {
      // Camera looks E or W — horizontal spread is BIM_Y (North-South)
      // W: svgX = +BIM_Y;  E: svgX = -BIM_Y (mirrored)
      allAxesY.forEach((axY, i) => {
        const svgX = (dir === 'W') ? axY * MM : -axY * MM;
        lines.push({
          x1: svgX, y1: svgY_Hi,
          x2: svgX, y2: svgY_Lo,
          labelX: svgX, labelY: svgY_Lo,
          label: String.fromCharCode(65 + (dir === 'E' ? allAxesY.length - 1 - i : i)),
          isX: false,
        });
      });
    } else {
      // N/S elevations — horizontal spread is BIM_X (East-West)
      // S: svgX = +BIM_X;  N: svgX = -BIM_X (mirrored)
      allAxesX.forEach((axX, i) => {
        const svgX = (dir === 'S') ? axX * MM : -axX * MM;
        lines.push({
          x1: svgX, y1: svgY_Hi,
          x2: svgX, y2: svgY_Lo,
          labelX: svgX, labelY: svgY_Lo,
          label: `${dir === 'N' ? allAxesX.length - i : i + 1}`,
          isX: true,
        });
      });
    }
  }

  return lines;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Element type -> fill style
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/** Resolve 2D visuals for the given elementType + optional per-node material id. */
function getGroupVisuals(
  elementType: string,
  materialId: string,
  matConfig: MaterialConfig | null,
): MaterialVisuals {
  return resolveVisuals(elementType, materialId || undefined, matConfig);
}

/**
 * SVG fill for a closed path:
 * - elevation  → solid fill (opaque, color_2d)
 * - section/floorplan, hatch='none'  → 'none'
 * - section/floorplan, hatch='solid' → color_2d solid
 * - section/floorplan, hatch=pattern → url(#hatch-<elementType>)
 */
function getPathFill(
  elementType: string,
  vis: MaterialVisuals,
  vt: DrawingViewType,
): string {
  if (vt === 'elevation') return vis.color_2d;
  if (vis.hatch === 'none') return 'none';
  if (vis.hatch === 'solid') return vis.color_2d;
  return `url(#hatch-${elementType})`;
}

/** Build SVG <pattern> data for every element type that needs a patterned fill. */
function buildPatternDefs(
  groups: SvgElementGroup[],
  nodeMatMap: Map<string, string>,
  matConfig: MaterialConfig | null,
): Array<{ id: string; hatch: HatchPattern; color: string; lw: number }> {
  const seen = new Map<string, { id: string; hatch: HatchPattern; color: string; lw: number }>();
  for (const grp of groups) {
    if (seen.has(grp.elementType)) continue;
    const matId = nodeMatMap.get(grp.elementId) ?? '';
    const vis = getGroupVisuals(grp.elementType, matId, matConfig);
    if (vis.hatch !== 'none' && vis.hatch !== 'solid') {
      seen.set(grp.elementType, {
        id: `hatch-${grp.elementType}`,
        hatch: vis.hatch,
        color: vis.color_2d,
        lw: Math.max(vis.line_weight * 0.025, 0.006),
      });
    }
  }
  return [...seen.values()];
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Main Component
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

export function TechnicalDrawingsViewer({
  nodes,
  edges,
  buildingAxes: _buildingAxes,
  storeyId,
  discipline: _discipline,
  viewType = 'floorplan',
  cutElevation,
  cutY,
  cutX,
  cutDepth = 100_000,
  startElevation,
  endElevation,
  viewDirection,
  onParamsChange,
  className,
}: TechnicalDrawingsViewerProps) {
  const effDir: ElevationDir = viewDirection ?? 'W';
  const [settingsOpen, setSettingsOpen] = useState(false);

  // â”€â”€ Visibility filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const { visibleTypes, typeCounts } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
    return { visibleTypes: Object.keys(counts), typeCounts: counts };
  }, [nodes]);

  const filteredNodes = useMemo(
    () => nodes.filter((n) => n.type === 'storey' || !hiddenTypes.has(n.type)),
    [nodes, hiddenTypes],
  );

  // â”€â”€ Cut values (local editable state derived from props) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const storeyMeta = nodes.find((n) => n.id === storeyId);
  const storeyBot  = Number(storeyMeta?.properties.bottomElevation ?? 0);
  const storeyTop  = Number(storeyMeta?.properties.topElevation   ?? 3000);
  const allAxesX   = useMemo(() => nodes.filter((n) => n.type === 'storey').flatMap((s) => parseAxes(s.properties.axesX)), [nodes]);
  const allAxesY   = useMemo(() => nodes.filter((n) => n.type === 'storey').flatMap((s) => parseAxes(s.properties.axesY)), [nodes]);
  const minX       = allAxesX.length ? Math.min(...allAxesX) : 0;
  const maxX       = allAxesX.length ? Math.max(...allAxesX) : 10000;
  const minY       = allAxesY.length ? Math.min(...allAxesY) : 0;
  const maxY       = allAxesY.length ? Math.max(...allAxesY) : 10000;

  const defaultCutElev = storeyBot + (storeyTop - storeyBot) * 0.5;
  const defaultCutY    = (minY + maxY) / 2;
  const defaultCutX    = minX;

  const allStoreyBots = useMemo(() => nodes.filter((n) => n.type === 'storey').map((s) => Number(s.properties.bottomElevation ?? 0)), [nodes]);
  const allStoreyTops = useMemo(() => nodes.filter((n) => n.type === 'storey').map((s) => Number(s.properties.topElevation ?? 3000)), [nodes]);
  const globalMinElev = allStoreyBots.length ? Math.min(...allStoreyBots) : 0;
  const globalMaxElev = allStoreyTops.length ? Math.max(...allStoreyTops) : 3000;

  const [localCutElev,   setLocalCutElev]   = useState<number>(() => cutElevation ?? defaultCutElev);
  const [localCutY,      setLocalCutY]       = useState<number>(() => cutY ?? defaultCutY);
  const [localCutX,      setLocalCutX]       = useState<number>(() => cutX ?? defaultCutX);
  const [localCutDepth,  setLocalCutDepth]   = useState<number>(() => cutDepth ?? 100_000);
  const [localStartElev, setLocalStartElev]  = useState<number>(() => startElevation ?? globalMinElev);
  const [localEndElev,   setLocalEndElev]    = useState<number>(() => endElevation ?? globalMaxElev);

  useEffect(() => { if (cutElevation   !== undefined) setLocalCutElev(cutElevation);      }, [cutElevation]);
  useEffect(() => { if (cutY           !== undefined) setLocalCutY(cutY);                  }, [cutY]);
  useEffect(() => { if (cutX           !== undefined) setLocalCutX(cutX);                  }, [cutX]);
  useEffect(() => { if (cutDepth       !== undefined) setLocalCutDepth(cutDepth);          }, [cutDepth]);
  useEffect(() => { if (startElevation !== undefined) setLocalStartElev(startElevation);   }, [startElevation]);
  useEffect(() => { if (endElevation   !== undefined) setLocalEndElev(endElevation);       }, [endElevation]);

  // â”€â”€ SVG state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewBox, setViewBox] = useState<ViewBox>({ x: -1, y: -1, w: 20, h: 15 });
  /** Extension of grid axis lines beyond the building footprint, in mm. */
  const [axisExtensionMm, setAxisExtensionMm] = useState<number>(1200);
  /** Set of hidden path keys (format: `${elementId}:c${idx}` or `${elementId}:o${idx}`). */
  const [hiddenPaths, setHiddenPaths] = useState<Set<string>>(new Set());
  const [eraserActive, setEraserActive] = useState(false);
  const isPanning = useRef(false);
  const panStart  = useRef({ x: 0, y: 0 });
  const vbStart   = useRef<ViewBox>({ x: 0, y: 0, w: 20, h: 15 });

  const { config: matConfig } = useMaterialConfig();

  // ── SVG Annotation state ──────────────────────────────────────────────────
  const [annTool, setAnnTool] = useState<SvgAnnotationTool | null>(null);
  const { clearViewAnnotations } = useBubbleGraphStore();
  const annViewId = `${viewType}:${storeyId ?? 'all'}`;
  const annPendingRef = useRef<{ x: number; y: number } | null>(null);
  const nodeMatMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of filteredNodes) {
      const mat = String(n.properties.material ?? '');
      if (mat) m.set(n.id, mat);
    }
    return m;
  }, [filteredNodes]);

  // â”€â”€ Compute SVG data from BIM model â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const svgData = useMemo(() => {
    if (filteredNodes.length === 0) return null;

    // Build 3D geometry (detached — not rendered)
    const bimRoot = buildBimGeometry(filteredNodes, edges, matConfig);
    bimRoot.updateWorldMatrix(true, true);

    // Extract tagged edges
    const rawEdges = extractTaggedEdges(bimRoot);
    if (rawEdges.length === 0) return null;

    // Clip to view volume
    const depthClipped = clipTaggedEdgesToCutDepth(rawEdges, viewType, localCutY, localCutX, localCutDepth, effDir);
    const elevClipped  = clipTaggedEdgesToElevation(depthClipped, viewType, localStartElev, localEndElev);

    // Project to 2D SVG coordinates
    const svgEdgesRaw = projectTaggedEdges(elevClipped, viewType, effDir);

    // Remove duplicate edges that arise from adjacent BoxGeometry mesh seams
    // (wall segments + columns sharing a face, wall+window frame junctions, etc.)
    const svgEdges = deduplicateEdges(svgEdgesRaw);

    // Group by element and join into paths
    const groups = groupAndJoinEdges(svgEdges);

    // Compute bounds
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    for (const e of svgEdges) {
      bMinX = Math.min(bMinX, e.x1, e.x2);
      bMinY = Math.min(bMinY, e.y1, e.y2);
      bMaxX = Math.max(bMaxX, e.x1, e.x2);
      bMaxY = Math.max(bMaxY, e.y1, e.y2);
    }
    const pad = Math.max((bMaxX - bMinX), (bMaxY - bMinY)) * 0.1 || 1;

    // Grid lines
    const gridLines = buildGridLines(
      allAxesX, allAxesY, storeyBot,
      minX, maxX, minY, maxY,
      globalMinElev, globalMaxElev,
      viewType,
      axisExtensionMm * MM,
      effDir,
    );

    return {
      groups,
      gridLines,
      bounds: { x: bMinX - pad, y: bMinY - pad, w: bMaxX - bMinX + pad * 2, h: bMaxY - bMinY + pad * 2 },
    };
  }, [filteredNodes, edges, matConfig, viewType, localCutY, localCutX, localCutDepth, localStartElev, localEndElev, allAxesX, allAxesY, storeyBot, minX, maxX, minY, maxY, globalMinElev, globalMaxElev, axisExtensionMm, effDir]);

  // Set initial viewBox from computed bounds
  const boundsKey = svgData ? `${svgData.bounds.x.toFixed(2)}_${svgData.bounds.y.toFixed(2)}_${svgData.bounds.w.toFixed(2)}_${svgData.bounds.h.toFixed(2)}` : '';
  useEffect(() => {
    if (!svgData) return;
    setViewBox(svgData.bounds);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey]);

  // â”€â”€ Pan/zoom handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    setViewBox((vb) => {
      const nw = vb.w * factor;
      const nh = vb.h * factor;
      return { x: vb.x + (vb.w - nw) * mx, y: vb.y + (vb.h - nh) * my, w: nw, h: nh };
    });
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    // Block panning when annotation tool is active
    if (annTool) return;
    // Middle button or left button (when not eraser) to pan
    if (e.button === 1 || (e.button === 0 && !eraserActive)) {
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY };
      vbStart.current = viewBox;
      e.preventDefault();
    }
  }, [viewBox, eraserActive, annTool]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!isPanning.current) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const dx = (e.clientX - panStart.current.x) / rect.width * vbStart.current.w;
    const dy = (e.clientY - panStart.current.y) / rect.height * vbStart.current.h;
    setViewBox({ x: vbStart.current.x - dx, y: vbStart.current.y - dy, w: vbStart.current.w, h: vbStart.current.h });
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  // fromSvgEvent for annotation layer — converts mouse event to viewBox world coords
  const fromSvgEvent = useCallback((e: { clientX: number; clientY: number }) => {
    const loc = clientToSvgUserPoint(svgRef.current, e.clientX, e.clientY);
    return loc ?? { x: 0, y: 0 };
  }, []);

  // Identity toSvg — viewBox coords ARE SVG world coords in this viewer
  const toSvgIdent = useCallback((lx: number, ly: number) => ({ x: lx, y: ly }), []);

  // Legacy click handler kept for eraser/path interactions (non-annotation)
  const handleSvgClick = useCallback((_e: React.MouseEvent<SVGSVGElement>) => {
    // Annotation clicks handled by SvgAnnotationLayer directly
  }, []);

  // â”€â”€ Eraser handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handlePathClick = useCallback((pathKey: string, e: React.MouseEvent) => {
    if (!eraserActive) return;
    e.stopPropagation();
    setHiddenPaths((prev) => {
      const next = new Set(prev);
      next.add(pathKey);
      return next;
    });
  }, [eraserActive]);

  const handleGroupClick = useCallback((elementId: string, group: SvgElementGroup, e: React.MouseEvent) => {
    if (!eraserActive || !e.shiftKey) return;
    e.stopPropagation();
    setHiddenPaths((prev) => {
      const next = new Set(prev);
      group.closedPaths.forEach((_, i) => next.add(`${elementId}:c${i}`));
      group.openPaths.forEach((_, i) => next.add(`${elementId}:o${i}`));
      return next;
    });
  }, [eraserActive]);

  // â”€â”€ Settings commit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const commitParams = useCallback(() => {
    onParamsChange?.({
      cutElevation:   localCutElev,
      cutY:           localCutY,
      cutX:           localCutX,
      cutDepth:       localCutDepth,
      startElevation: localStartElev,
      endElevation:   localEndElev,
    });
  }, [onParamsChange, localCutElev, localCutY, localCutX, localCutDepth, localStartElev, localEndElev]);

  const viewLabel: Record<DrawingViewType, string> = {
    floorplan: 'Floor Plan',
    section:   'Section',
    elevation: 'Elevation',
  };
  const cutLabel: Record<DrawingViewType, string> = {
    floorplan: 'Cut elevation (mm)',
    section:   'Cut Y — North (mm)',
    elevation: 'Cut X — East (mm)',
  };
  const cutValue = viewType === 'floorplan' ? localCutElev
    : viewType === 'section' ? localCutY : localCutX;
  const setCutValue = viewType === 'floorplan' ? setLocalCutElev
    : viewType === 'section' ? setLocalCutY : setLocalCutX;

  // â”€â”€ Export SVG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleSvgExport = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const blob = new Blob([clone.outerHTML], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${viewType}-drawing.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [viewType]);

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // JSX
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  return (
    <div className={cn('relative w-full h-full bg-[#f8f8f2] dark:bg-[#1a1a2e] overflow-hidden', className)}>
      {/* â”€â”€â”€ SVG Drawing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <svg
        ref={svgRef}
        className="absolute inset-0 w-full h-full"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ cursor: annTool ? 'crosshair' : eraserActive ? 'crosshair' : isPanning.current ? 'grabbing' : 'grab' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={handleSvgClick}
        onMouseLeave={handleMouseUp}
      >
        {/* â”€â”€ Hatch pattern definitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <defs>
          {buildPatternDefs(svgData?.groups ?? [], nodeMatMap, matConfig).map(({ id, hatch, color, lw }) => (
            hatch === 'diagonal' ? (
              <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="0.15" height="0.15" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="0.15" stroke={color} strokeWidth={lw} />
              </pattern>
            ) : hatch === 'crosshatch' ? (
              <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="0.12" height="0.12">
                <line x1="0" y1="0" x2="0.12" y2="0.12" stroke={color} strokeWidth={lw} />
                <line x1="0.12" y1="0" x2="0" y2="0.12" stroke={color} strokeWidth={lw} />
              </pattern>
            ) : hatch === 'brick' ? (
              <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="0.25" height="0.12">
                <line x1="0" y1="0.06" x2="0.25" y2="0.06" stroke={color} strokeWidth={lw} />
                <line x1="0.125" y1="0" x2="0.125" y2="0.06" stroke={color} strokeWidth={lw} />
                <line x1="0" y1="0" x2="0" y2="0.12" stroke={color} strokeWidth={lw} />
              </pattern>
            ) : hatch === 'stone' ? (
              <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="0.2" height="0.1">
                <rect x="0" y="0" width="0.2" height="0.1" fill="none" stroke={color} strokeWidth={lw} />
                <line x1="0.1" y1="0" x2="0.1" y2="0.1" stroke={color} strokeWidth={lw} />
              </pattern>
            ) : (
              <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="0.15" height="0.15" patternTransform="rotate(30)">
                <line x1="0" y1="0" x2="0" y2="0.15" stroke={color} strokeWidth={lw} />
              </pattern>
            )
          ))}
        </defs>

        {/* â”€â”€ Grid lines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <g className="grid">
          {svgData?.gridLines.map((gl, i) => (
            <g key={`g${i}`}>
              <line
                x1={gl.x1} y1={gl.y1} x2={gl.x2} y2={gl.y2}
                stroke="#bdc3c7"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                strokeDasharray="8 3 3 3"
              />
              {/* Axis bubble + label at labelX/labelY */}
              <circle
                cx={gl.labelX} cy={gl.labelY}
                r={viewBox.w * 0.012}
                fill="white" stroke="#7f8c8d" strokeWidth="1" vectorEffect="non-scaling-stroke"
              />
              <text
                x={gl.labelX} y={gl.labelY}
                textAnchor="middle" dominantBaseline="central"
                fill="#5a6a7e"
                style={{ fontSize: `${viewBox.w * 0.016}px` }}
              >
                {gl.label}
              </text>
            </g>
          ))}
        </g>

        {/* â”€â”€ Building elements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {/* Paint order: opaque surfaces first, openings on top */}
        {[...(svgData?.groups ?? [])].sort((a, b) => {
          const P: Record<string, number> = {
            shell: 0, covering: 0, slab: 1, foundation: 1,
            wall: 2, column: 3, beam: 4, room: 5, door: 6, window: 7,
          };
          return (P[a.elementType] ?? 3) - (P[b.elementType] ?? 3);
        }).map((grp) => {
          const matId = nodeMatMap.get(grp.elementId) ?? '';
          const vis = getGroupVisuals(grp.elementType, matId, matConfig);
          const fillClosed = getPathFill(grp.elementType, vis, viewType);
          const strokeColor = vis.color_2d;
          const strokeW = Math.max(vis.line_weight, 0.2);
          return (
          <g
            key={grp.elementId}
            data-element-id={grp.elementId}
            data-element-type={grp.elementType}
            onClick={(e) => handleGroupClick(grp.elementId, grp, e)}
          >
            {grp.closedPaths.map((d, i) => {
              const pathKey = `${grp.elementId}:c${i}`;
              if (hiddenPaths.has(pathKey)) return null;
              return (
                <path
                  key={pathKey}
                  d={d}
                  fill={fillClosed}
                  fillOpacity={viewType === 'elevation' ? vis.opacity_2d : 1}
                  stroke={strokeColor}
                  strokeWidth={strokeW}
                  vectorEffect="non-scaling-stroke"
                  style={eraserActive ? { cursor: 'crosshair', pointerEvents: 'stroke' } : undefined}
                  onClick={(e) => handlePathClick(pathKey, e)}
                />
              );
            })}
            {grp.openPaths.map((d, i) => {
              const pathKey = `${grp.elementId}:o${i}`;
              if (hiddenPaths.has(pathKey)) return null;
              return (
                <path
                  key={pathKey}
                  d={d}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={strokeW * 0.8}
                  vectorEffect="non-scaling-stroke"
                  style={eraserActive ? { cursor: 'crosshair', pointerEvents: 'stroke' } : undefined}
                  onClick={(e) => handlePathClick(pathKey, e)}
                />
              );
            })}
          </g>
          );
        })}

        {/* ── SVG Annotation layer ────────────────────────────────────── */}
        <SvgAnnotationLayer
          viewId={annViewId}
          toSvg={toSvgIdent}
          fromSvgEvent={fromSvgEvent}
          activeTool={annTool}
          onToolDone={() => { /* keep tool active */ }}
          fontSizeSvg={viewBox.w * 0.015}
          strokeSvg={viewBox.w * 0.0008}
          captureBounds={[viewBox.x, viewBox.y, viewBox.x + viewBox.w, viewBox.y + viewBox.h]}
        />
      </svg>

      {/* â”€â”€ Visibility filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <VisibilityFilter
        types={visibleTypes}
        hiddenTypes={hiddenTypes}
        onChange={setHiddenTypes}
        counts={typeCounts}
        className="top-9 right-2"
      />

      {/* â”€â”€ Toolbar — left â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
        <div className="flex items-center gap-1.5 bg-background/80 border border-border/50 rounded px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm">
          <span className="font-semibold text-foreground">{viewLabel[viewType]}</span>
          <span className="opacity-40">|</span>
          <span>SVG Drawing</span>
        </div>
        <AnnotationsToolbar
          activeTool={annTool === 'dimension' ? 'linear' : annTool === 'leader' ? 'callout' : null}
          onToolChange={(tool) => {
            annPendingRef.current = null;
            if (tool === 'linear') setAnnTool('dimension');
            else if (tool === 'callout') setAnnTool('leader');
            else setAnnTool(null);
          }}
          onClearAll={() => { clearViewAnnotations(annViewId); annPendingRef.current = null; setAnnTool(null); }}
          availableTools={['linear', 'callout']}
        />
      </div>

      {/* â”€â”€ Toolbar — right â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="absolute top-2 right-2 z-10 flex gap-1 bg-background/80 border border-border/50 rounded px-1.5 py-1 backdrop-blur-sm">
        <button
          className="text-[10px] px-2 py-0.5 rounded hover:bg-accent transition-colors"
          title="Export SVG"
          onClick={handleSvgExport}
        >
          Export SVG
        </button>
        <div className="w-px bg-border mx-0.5" />
        <button
          className={cn(
            'text-[10px] px-2 py-0.5 rounded transition-colors',
            eraserActive ? 'bg-destructive/20 text-destructive border border-destructive/40' : 'hover:bg-accent',
          )}
          title="Line eraser — click a path to hide it (Shift+click hides entire element)"
          onClick={() => setEraserActive((v) => !v)}
        >
          Eraser
        </button>
        {hiddenPaths.size > 0 && (
          <button
            className="text-[10px] px-2 py-0.5 rounded hover:bg-accent transition-colors text-muted-foreground"
            title={`Unhide all ${hiddenPaths.size} hidden path(s)`}
            onClick={() => { setHiddenPaths(new Set()); setEraserActive(false); }}
          >
            Show all
          </button>
        )}
        <div className="w-px bg-border mx-0.5" />
        <button
          className={cn(
            'text-[10px] px-2 py-0.5 rounded transition-colors',
            settingsOpen ? 'bg-accent text-foreground' : 'hover:bg-accent',
          )}
          title="Cut / depth settings"
          onClick={() => setSettingsOpen((v) => !v)}
        >
          Settings
        </button>
      </div>

      {/* â”€â”€ Cut settings panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {settingsOpen && (
        <div className="absolute top-10 right-2 z-20 w-64 bg-background border border-border rounded shadow-lg p-3 space-y-3 text-[11px]">
          <div className="font-semibold text-foreground text-xs border-b border-border pb-1.5 mb-1">Plan settings</div>

          {/* Cut position */}
          <div className="space-y-1">
            <label className="text-muted-foreground block">{cutLabel[viewType]}</label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                className="flex-1 bg-muted border border-border rounded px-2 py-1 text-[11px] text-foreground"
                value={cutValue}
                step={100}
                onChange={(e) => setCutValue(parseFloat(e.target.value) || 0)}
                onBlur={commitParams}
                onKeyDown={(e) => e.key === 'Enter' && commitParams()}
              />
              <span className="text-muted-foreground">mm</span>
            </div>
            {viewType === 'floorplan' && (
              <div className="flex gap-1">
                <button
                  className="text-[10px] px-1.5 py-0.5 rounded bg-muted hover:bg-accent transition-colors flex-1"
                  onClick={() => { setLocalCutElev(storeyBot); commitParams(); }}
                  title="Jump to storey bottom elevation"
                >
                  Bottom ({storeyBot} mm)
                </button>
                <button
                  className="text-[10px] px-1.5 py-0.5 rounded bg-muted hover:bg-accent transition-colors flex-1"
                  onClick={() => { setLocalCutElev(Math.round(storeyBot + (storeyTop - storeyBot) * 0.5)); commitParams(); }}
                  title="Jump to storey mid-height"
                >
                  Mid ({Math.round(storeyBot + (storeyTop - storeyBot) * 0.5)} mm)
                </button>
              </div>
            )}
            {viewType === 'section' && (
              <div className="flex gap-1">
                <button className="text-[10px] px-1.5 py-0.5 rounded bg-muted hover:bg-accent transition-colors flex-1"
                  onClick={() => { setLocalCutY(minY); commitParams(); }}>Min Y ({minY} mm)</button>
                <button className="text-[10px] px-1.5 py-0.5 rounded bg-muted hover:bg-accent transition-colors flex-1"
                  onClick={() => { setLocalCutY(Math.round((minY + maxY) / 2)); commitParams(); }}>Mid ({Math.round((minY + maxY) / 2)} mm)</button>
              </div>
            )}
            {viewType === 'elevation' && (
              <div className="flex gap-1">
                <button className="text-[10px] px-1.5 py-0.5 rounded bg-muted hover:bg-accent transition-colors flex-1"
                  onClick={() => { setLocalCutX(minX); commitParams(); }}>Min X ({minX} mm)</button>
                <button className="text-[10px] px-1.5 py-0.5 rounded bg-muted hover:bg-accent transition-colors flex-1"
                  onClick={() => { setLocalCutX(maxX); commitParams(); }}>Max X ({maxX} mm)</button>
              </div>
            )}
          </div>

          {/* View depth */}
          <div className="space-y-1">
            <label className="text-muted-foreground block">View depth (mm)</label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                className="flex-1 bg-muted border border-border rounded px-2 py-1 text-[11px] text-foreground"
                value={localCutDepth}
                step={1000}
                min={100}
                onChange={(e) => setLocalCutDepth(parseFloat(e.target.value) || 100_000)}
                onBlur={commitParams}
                onKeyDown={(e) => e.key === 'Enter' && commitParams()}
              />
              <span className="text-muted-foreground">mm</span>
            </div>
            <div className="flex gap-1">
              {[1000, 5000, 20000, 100000].map((d) => (
                <button
                  key={d}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-muted hover:bg-accent transition-colors flex-1"
                  onClick={() => { setLocalCutDepth(d); commitParams(); }}
                >
                  {d >= 1000 ? `${d / 1000}m` : `${d}mm`}
                </button>
              ))}
            </div>
          </div>

          {/* Axis extension */}
          <div className="space-y-1">
            <label className="text-muted-foreground block">Axis extension (mm)</label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                className="flex-1 bg-muted border border-border rounded px-2 py-1 text-[11px] text-foreground"
                value={axisExtensionMm}
                step={100}
                min={0}
                onChange={(e) => setAxisExtensionMm(parseFloat(e.target.value) || 0)}
              />
              <span className="text-muted-foreground">mm</span>
            </div>
            <div className="flex gap-1">
              {[500, 1000, 1500, 2000].map((d) => (
                <button
                  key={d}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-muted hover:bg-accent transition-colors flex-1"
                  onClick={() => setAxisExtensionMm(d)}
                >
                  {d / 1000}m
                </button>
              ))}
            </div>
          </div>

          <p className="text-[9px] text-muted-foreground/60">Settings saved to tab — persist across view switches.</p>
        </div>
      )}

      {/* â”€â”€ Controls hint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="absolute bottom-3 right-3 text-[9px] text-muted-foreground space-y-0.5 text-right pointer-events-none">
        <div>Scroll — zoom</div>
        <div>Drag — pan</div>
        <div>Eraser — click path to hide</div>
        <div>Shift+click — hide entire element</div>
      </div>
    </div>
  );
}
