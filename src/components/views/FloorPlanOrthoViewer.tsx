/**
 * FloorPlanOrthoViewer — OBC-based orthographic top-down floor plan viewer.
 *
 * Uses @thatopen/components (OBC) world with OrthoPerspectiveCamera in orthographic mode.
 * Geometry via buildSceneGeometry (same source as WebIfcViewer / SectionOrthoViewer).
 * Two horizontal clip planes implement the Revit-style "view range":
 *   - Upper clip at cutElevation: everything above is hidden
 *   - Lower clip at cutElevation − viewDepth: everything below is hidden
 *
 * Features:
 *   - OBC world with OrthoPerspectiveCamera (orthographic projection)
 *   - Camera top-down, north (BIM +Y) pointing upward in the viewport
 *   - Revit-style view range: cutElevation + viewDepth dual clip planes
 *   - AABB plan fills for walls / columns / beams / slabs / foundations
 *   - Ring polygon plan fills for shells / coverings (using ringPolyOuter/Inner)
 *   - 2D plan symbols: door swing arcs + window triple-line (professional BIM standard)
 *   - Render modes: colored / technical / wireframe
 *   - VisibilityFilter per element type
 */

import { useEffect, useRef, useState, useMemo, useCallback, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as OBF from '@thatopen/components-front';
import { cn, parseAxes } from '@/lib/utils';
import { AnnotationsToolbar, type AnnotationTool } from './AnnotationsToolbar';
import { VisibilityFilter } from '@/components/views/VisibilityFilter';
import { RenderModeSelector, type RenderMode } from '@/components/views/RenderModeSelector';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { useBubbleGraphStore } from '@/store';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { resolveVisuals, getSectionFillColor, getSectionFillOpacity, getViewLineColor, getViewLineWeight, type MaterialConfig } from '@/lib/materialConfig';
import { calcWallGeometry, calcWallJoins, type OpeningMeshDesc, getAxRealPos, calcRoomPolygon, calcRoomParametricGrid, type RoomParametricGrid, parseContourOffsets, insetPolygon } from '@/lib/bimGeometry';
import { WINDOW_TYPE_MAP, DOOR_TYPE_MAP } from '@/lib/elementLibrary';
import {
  resolveWindowPlan2DConfig,
  subscribeWindowSymbolConfig,
} from '@/lib/windowSymbolLibrary';
import { WindowConfigurator } from '@/components/configurators/WindowConfigurator';
import { buildSceneGeometry } from './WebIfcViewer';
import {
  loadIfcParts, buildIfcGroup, collectIfcLibraryPaths,
  type IFCGroupInfo,
} from '@/lib/ifcLibraryLoader';

const MM = 0.001; // mm → metres

function fpUid(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface FloorPlanOrthoViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  /** Storey to target. Used to derive default cutElevation from bottomElevation + 1200 mm. */
  storeyId?: string | null;
  /** Absolute elevation (mm) for the upper horizontal cut plane. Defaults to storey floor + 1200 mm. */
  cutElevation?: number;
  /**
   * View depth (mm) — how far below the cut elevation to show geometry.
   * Equivalent to Revit's view range bottom offset.
   * Defaults to the storey height or 3000 mm.
   */
  viewDepth?: number;
  className?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert any THREE.Color representation to a grayscale THREE.Color (by luminance). */
function toGray(c: THREE.ColorRepresentation): THREE.Color {
  const col = new THREE.Color(c);
  const L = 0.299 * col.r + 0.587 * col.g + 0.114 * col.b;
  return new THREE.Color(L, L, L);
}

function applyRenderMode(
  scene: THREE.Scene,
  mode: RenderMode,
  matConfig: MaterialConfig | null,
  hiddenTypes: Set<string>,
): void {
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    // Plan-fill overlays own their materials — skip them here.
    if (obj.userData.isPlanFill) return;
    const nt = obj.userData.nodeType as string | undefined;
    if (!nt) return;
    if (!obj.userData._origMat) obj.userData._origMat = obj.material;
    const origMat = obj.userData._origMat as THREE.Material;
    const vis = resolveVisuals(nt, '', matConfig);
    const isInstanced = (obj as THREE.InstancedMesh).isInstancedMesh;

    // Cached edge-lines: visible only in wireframe mode
    if (obj.userData._edgeLines) {
      (obj.userData._edgeLines as THREE.LineSegments).visible =
        mode === 'wireframe' && !hiddenTypes.has(nt);
    }

    switch (mode) {
      case 'colored':
        obj.material = origMat;
        break;

      case 'technical': {
        obj.material = new THREE.MeshBasicMaterial({
          color: toGray(vis.color_2d),
          transparent: vis.opacity_2d < 1,
          opacity: vis.opacity_2d,
          side: THREE.DoubleSide,
        });
        break;
      }

      case 'wireframe': {
        if (!isInstanced) {
          obj.material = new THREE.MeshBasicMaterial({
            transparent: true, opacity: 0, depthWrite: false,
          });
          if (!obj.userData._edgeLines) {
            if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
            const bb = obj.geometry.boundingBox!;
            const dims = bb.getSize(new THREE.Vector3());
            const cent = bb.getCenter(new THREE.Vector3());
            const boxGeo = new THREE.BoxGeometry(dims.x, dims.y, dims.z);
            const edgeGeo = new THREE.EdgesGeometry(boxGeo);
            boxGeo.dispose();
            const edgeColor = new THREE.Color(vis.color_2d).multiplyScalar(0.65);
            const edgeLines = new THREE.LineSegments(
              edgeGeo,
              new THREE.LineBasicMaterial({ color: edgeColor }),
            );
            edgeLines.position.copy(cent);
            edgeLines.userData._isEdgeHelper = true;
            obj.userData._edgeLines = edgeLines;
            obj.add(edgeLines);
          }
          (obj.userData._edgeLines as THREE.LineSegments).visible = !hiddenTypes.has(nt);
        } else {
          const edgeColor = new THREE.Color(vis.color_2d).multiplyScalar(0.65);
          obj.material = new THREE.MeshBasicMaterial({
            color: edgeColor, wireframe: true, transparent: true, opacity: 0.4,
          });
        }
        break;
      }
    }

    if (nt) obj.visible = !hiddenTypes.has(nt);
  });
}

// ─── Plan Fills ───────────────────────────────────────────────────────────────
//
// Two strategies, mirroring SectionOrthoViewer's approach:
//
// 1. AABB fills (walls, columns, beams, slabs, foundations):
//    Place a flat PlaneGeometry quad (rotated -90° to lie in XZ) at y = cutYm − ε
//    for every element whose world AABB straddles the cut elevation.
//
// 2. Ring polygon fills (shell, covering):
//    Use the ringPolyOuter/ringPolyInner BIM-coordinate arrays attached to the
//    mesh by buildSceneGeometry (attachRingData). Build a THREE.ShapeGeometry
//    (outer polygon with inner hole) then rotateX(-Math.PI/2) to lay in XZ plane.
//    Only generated when the ring's vertical extent straddles the cut elevation.
//
// depthTest:false + high renderOrder keep fills always visible above geometry.

const FILL_TYPES      = new Set(['wall', 'beam', 'column', 'slab', 'foundation']);
const RING_FILL_TYPES = new Set(['shell', 'covering']);

function buildPlanFills(
  scene: THREE.Scene,
  cutYm: number,
  matConfig: MaterialConfig | null,
  cfg: { showShellBreaks: boolean; showCoveringBreaks: boolean },
): void {
  const old = scene.getObjectByName('__plan_fills__');
  if (old) scene.remove(old);

  const fillGroup = new THREE.Group();
  fillGroup.name = '__plan_fills__';

  // Fills sit just below the cut plane so they are not clipped by the upper plane.
  const fillY = cutYm - 0.025;

  const tempMat4 = new THREE.Matrix4();
  const tempBox  = new THREE.Box3();

  // ── 1. AABB fills ──────────────────────────────────────────────────────────
  const addFillForBox = (worldBox: THREE.Box3, nt: string) => {
    if (worldBox.isEmpty()) return;
    if (worldBox.min.y >= cutYm - 0.001 || worldBox.max.y <= cutYm + 0.001) return;

    const yExt = worldBox.max.y - worldBox.min.y;
    if (yExt < 0.05) return;

    const w  = Math.max(worldBox.max.x - worldBox.min.x, 0.01);
    const d  = Math.max(worldBox.max.z - worldBox.min.z, 0.01);
    const cx = (worldBox.min.x + worldBox.max.x) / 2;
    const cz = (worldBox.min.z + worldBox.max.z) / 2;

    const vis = resolveVisuals(nt, '', matConfig);
    const fillColor = new THREE.Color(getSectionFillColor(vis));
    const fillOpacity = getSectionFillOpacity(vis);
    const planeGeo  = new THREE.PlaneGeometry(w, d);

    const fillMesh = new THREE.Mesh(
      planeGeo,
      new THREE.MeshBasicMaterial({ color: fillColor, transparent: true, opacity: fillOpacity, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
    );
    fillMesh.rotation.x = -Math.PI / 2;
    fillMesh.position.set(cx, fillY, cz);
    fillMesh.renderOrder = 10;
    fillMesh.userData.isPlanFill = true;
    fillMesh.userData.fillNodeType = nt;
    fillGroup.add(fillMesh);

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(planeGeo),
      new THREE.LineBasicMaterial({ color: 0x111111, depthTest: false }),
    );
    outline.rotation.x = -Math.PI / 2;
    outline.position.set(cx, fillY + 0.002, cz);
    outline.renderOrder = 11;
    outline.userData.isPlanFill = true;
    outline.userData.fillNodeType = nt;
    fillGroup.add(outline);
  };

  // ── 1b. Oriented wall polygon fill (no individual outline — corners merge cleanly) ──
  const wallPolys: { x: number; z: number }[][] = []; // collect for merged outline
  const addFillForWallPoly = (poly: { x: number; z: number }[], nt: string) => {
    // poly has 4 vertices in Three.js XZ metres
    const shape = new THREE.Shape();
    // Shape XY → Three.js XZ after rotateX(-PI/2): shape.x→world.x, shape.y→world.-z
    shape.moveTo(poly[0].x, -poly[0].z);
    for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, -poly[i].z);
    shape.closePath();

    const vis = resolveVisuals(nt, '', matConfig);
    const fillColor = new THREE.Color(getSectionFillColor(vis));
    const fillOpacity = getSectionFillOpacity(vis);
    const shapeGeo = new THREE.ShapeGeometry(shape);
    shapeGeo.rotateX(-Math.PI / 2);

    const fillMesh = new THREE.Mesh(
      shapeGeo,
      new THREE.MeshBasicMaterial({ color: fillColor, transparent: true, opacity: fillOpacity, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
    );
    fillMesh.position.y = fillY;
    fillMesh.renderOrder = 10;
    fillMesh.userData.isPlanFill = true;
    fillMesh.userData.fillNodeType = nt;
    fillGroup.add(fillMesh);
    wallPolys.push(poly);
  };

  // ── 2. Ring polygon fills ──────────────────────────────────────────────────
  //
  // The ring polygon lives in BIM XY (East / North) in mm.
  // THREE.ShapeGeometry is built in shape-XY space, then rotateX(-PI/2) maps:
  //   shape (x, y) → Three.js (x, 0, -y)  i.e.  East → X, North → -Z  ✓
  const addFillForRing = (
    outer: Array<{ x: number; y: number }>,
    inner: Array<{ x: number; y: number }>,
    botM: number,
    heightM: number,
    nt: string,
    showBreaks: boolean,
  ) => {
    // Only fill if the ring straddles the cut elevation
    if (cutYm < botM - 0.001 || cutYm > botM + heightM + 0.001) return;
    if (outer.length < 3 || inner.length < 3) return;

    const shape = new THREE.Shape();
    shape.moveTo(outer[0].x * MM, outer[0].y * MM);
    for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i].x * MM, outer[i].y * MM);
    shape.closePath();

    // Inner polygon must be reversed relative to outer for correct hole winding
    const rev  = [...inner].reverse();
    const hole = new THREE.Path();
    hole.moveTo(rev[0].x * MM, rev[0].y * MM);
    for (let i = 1; i < rev.length; i++) hole.lineTo(rev[i].x * MM, rev[i].y * MM);
    hole.closePath();
    shape.holes.push(hole);

    const shapeGeo = new THREE.ShapeGeometry(shape);
    // Rotate to horizontal (XZ) plane: shape-XY → Three.js XZ
    shapeGeo.rotateX(-Math.PI / 2);

    const vis = resolveVisuals(nt, '', matConfig);
    // Ring fills (shell/covering) are overhead-visible, not cut → use section fill for cross-section colour
    const fillColor = new THREE.Color(getSectionFillColor(vis));
    const fillOpacity = getSectionFillOpacity(vis);

    const fillMesh = new THREE.Mesh(
      shapeGeo,
      new THREE.MeshBasicMaterial({ color: fillColor, transparent: true, opacity: fillOpacity, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
    );
    fillMesh.position.y = fillY;
    fillMesh.renderOrder = 10;
    fillMesh.userData.isPlanFill = true;
    fillMesh.userData.fillNodeType = nt;
    fillGroup.add(fillMesh);

    const edgeGeo = new THREE.EdgesGeometry(shapeGeo);
    const outlineColor = new THREE.Color(getViewLineColor(vis));
    const outline = new THREE.LineSegments(
      edgeGeo,
      new THREE.LineBasicMaterial({ color: outlineColor, depthTest: false }),
    );
    outline.position.y = fillY + 0.002;
    outline.renderOrder = 11;
    outline.userData.isPlanFill = true;
    outline.userData.fillNodeType = nt;
    fillGroup.add(outline);

    // ── Break-line tick marks at outer polygon corners ─────────────────────
    if (showBreaks && outer.length >= 3) {
      const Y_RING_BREAK = cutYm - 0.018;
      const TICK = 0.05; // 50 mm tick half-length
      for (let i = 0; i < outer.length; i++) {
        const prev = outer[(i - 1 + outer.length) % outer.length];
        const curr = outer[i];
        const next = outer[(i + 1) % outer.length];
        // Three.js coords: x = BIM.x * MM, z = -BIM.y * MM
        const pcx = curr.x * MM, pcz = -curr.y * MM;
        const ppx = prev.x * MM, ppz = -prev.y * MM;
        const pnx = next.x * MM, pnz = -next.y * MM;
        const inDx = pcx - ppx, inDz = pcz - ppz;
        const outDx = pnx - pcx, outDz = pnz - pcz;
        const inLen  = Math.sqrt(inDx  * inDx  + inDz  * inDz);
        const outLen = Math.sqrt(outDx * outDx + outDz * outDz);
        if (inLen < 1e-5 || outLen < 1e-5) continue;
        const inUx = inDx / inLen, inUz = inDz / inLen;
        const outUx = outDx / outLen, outUz = outDz / outLen;
        // Bisector of angle at corner
        const bisX = inUx + outUx, bisZ = inUz + outUz;
        const bisLen = Math.sqrt(bisX * bisX + bisZ * bisZ);
        let perpX: number, perpZ: number;
        if (bisLen > 1e-5) {
          // Perpendicular to bisector direction = tick direction
          perpX = -bisZ / bisLen; perpZ = bisX / bisLen;
        } else {
          perpX = -inUz; perpZ = inUx;
        }
        const tickPts = [
          new THREE.Vector3(pcx - perpX * TICK, Y_RING_BREAK, pcz - perpZ * TICK),
          new THREE.Vector3(pcx + perpX * TICK, Y_RING_BREAK, pcz + perpZ * TICK),
        ];
        const tickGeo = new THREE.BufferGeometry().setFromPoints(tickPts);
        const tick = new THREE.LineSegments(
          tickGeo,
          new THREE.LineBasicMaterial({ color: 0x111111, depthTest: false }),
        );
        tick.renderOrder = 12;
        tick.userData.isPlanFill = true;
        tick.userData.fillNodeType = nt;
        fillGroup.add(tick);
      }
    }
  };

  scene.traverse((obj) => {
    if (obj.userData.isPlanFill || obj.userData.isBackWall) return;
    if (!obj.visible) return;
    const nt = obj.userData.nodeType as string | undefined;
    if (!nt) return;

    if (FILL_TYPES.has(nt)) {
      // Use oriented wall polygon if available (proper architectural corners)
      if (nt === 'wall' && obj.userData.wallPlanPoly) {
        const poly = obj.userData.wallPlanPoly as { x: number; z: number }[];
        const wallBot = obj.userData.wallBotM as number ?? 0;
        const wallTop = obj.userData.wallTopM as number ?? 10;
        // Only draw if wall straddles cut plane
        if (cutYm >= wallBot - 0.001 && cutYm <= wallTop + 0.001) {
          addFillForWallPoly(poly, nt);
        }
        return;
      }
      if ((obj as THREE.InstancedMesh).isInstancedMesh) {
        const im = obj as THREE.InstancedMesh;
        if (!im.geometry.boundingBox) im.geometry.computeBoundingBox();
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, tempMat4);
          const worldMat = tempMat4.clone().premultiply(im.matrixWorld);
          tempBox.copy(im.geometry.boundingBox!).applyMatrix4(worldMat);
          addFillForBox(tempBox.clone(), nt);
        }
      } else if (obj instanceof THREE.Mesh) {
        if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
        tempBox.copy(obj.geometry.boundingBox!).applyMatrix4(obj.matrixWorld);
        addFillForBox(tempBox.clone(), nt);
      }
      return;
    }

    if (RING_FILL_TYPES.has(nt) && obj instanceof THREE.Mesh) {
      const outer   = obj.userData.ringPolyOuter  as Array<{ x: number; y: number }> | undefined;
      const inner   = obj.userData.ringPolyInner  as Array<{ x: number; y: number }> | undefined;
      const botM    = obj.userData.ringBotM        as number | undefined;
      const heightM = obj.userData.ringHeightM     as number | undefined;
      if (outer && inner && botM !== undefined && heightM !== undefined) {
        const showBreaks = (nt === 'shell' && cfg.showShellBreaks) || (nt === 'covering' && cfg.showCoveringBreaks);
        addFillForRing(outer, inner, botM, heightM, nt, showBreaks);
      }
    }
  });

  // ── Merged wall outline: split edges at poly intersections, draw only exterior sub-segments ──
  if (wallPolys.length > 0) {
    // 2D segment intersection in XZ plane. Returns t ∈ (eps,1-eps) on edge A→B if crossing
    const segCross = (
      ax: number, az: number, bx: number, bz: number,
      cx: number, cz: number, dx: number, dz: number,
    ): number | null => {
      const dx1 = bx - ax, dz1 = bz - az;
      const dx2 = dx - cx, dz2 = dz - cz;
      const denom = dx1 * dz2 - dz1 * dx2;
      if (Math.abs(denom) < 1e-10) return null;
      const t = ((cx - ax) * dz2 - (cz - az) * dx2) / denom;
      const s = ((cx - ax) * dz1 - (cz - az) * dx1) / denom;
      const EPS = 1e-6;
      if (t > EPS && t < 1 - EPS && s >= -EPS && s <= 1 + EPS) return t;
      return null;
    };

    // Point-in-polygon (XZ)
    const pointInPoly = (px: number, pz: number, poly: { x: number; z: number }[]) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const zi = poly[i].z, zj = poly[j].z;
        const xi = poly[i].x, xj = poly[j].x;
        if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };

    const outlinePoints: THREE.Vector3[] = [];
    for (let pi = 0; pi < wallPolys.length; pi++) {
      const poly = wallPolys[pi];
      const n = poly.length;
      for (let ei = 0; ei < n; ei++) {
        const a = poly[ei], b = poly[(ei + 1) % n];
        // Collect all t-values where this edge crosses any edge of any other poly
        const tVals: number[] = [0, 1];
        for (let pj = 0; pj < wallPolys.length; pj++) {
          if (pj === pi) continue;
          const q = wallPolys[pj];
          for (let ej = 0; ej < q.length; ej++) {
            const c = q[ej], d = q[(ej + 1) % q.length];
            const t = segCross(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z);
            if (t !== null) tVals.push(t);
          }
        }
        tVals.sort((x, y) => x - y);
        // For each sub-segment, draw only if its midpoint is NOT inside any other poly
        for (let k = 0; k < tVals.length - 1; k++) {
          const t0 = tVals[k], t1 = tVals[k + 1];
          if (t1 - t0 < 1e-8) continue;
          const mx = a.x + (b.x - a.x) * (t0 + t1) / 2;
          const mz = a.z + (b.z - a.z) * (t0 + t1) / 2;
          let isInternal = false;
          for (let pj = 0; pj < wallPolys.length; pj++) {
            if (pj === pi) continue;
            if (pointInPoly(mx, mz, wallPolys[pj])) { isInternal = true; break; }
          }
          if (!isInternal) {
            const p0x = a.x + (b.x - a.x) * t0, p0z = a.z + (b.z - a.z) * t0;
            const p1x = a.x + (b.x - a.x) * t1, p1z = a.z + (b.z - a.z) * t1;
            outlinePoints.push(new THREE.Vector3(p0x, fillY + 0.002, p0z));
            outlinePoints.push(new THREE.Vector3(p1x, fillY + 0.002, p1z));
          }
        }
      }
    }
    if (outlinePoints.length > 0) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints(outlinePoints);
      const wallOutline = new THREE.LineSegments(
        lineGeo,
        new THREE.LineBasicMaterial({ color: 0x111111, depthTest: false }),
      );
      wallOutline.renderOrder = 11;
      wallOutline.userData.isPlanFill = true;
      wallOutline.userData.fillNodeType = 'wall';
      fillGroup.add(wallOutline);
    }
  }

  scene.add(fillGroup);
}

// ─── Plan Symbols ─────────────────────────────────────────────────────────────
//
// Professional 2D annotation layer drawn from BIM parametric data.
//
// Layer stack (bottom → top):
//   y = cutYm − 0.025 : plan fills (structural section overlays)
//   y = cutYm − 0.020 : WHITE MASK over each opening (hides 3D fill behind voids)
//   y = cutYm − 0.018 : wall break lines (thin dark at mask edges)
//   y = cutYm − 0.015 : 2D symbols (glass lines, door arcs, sliding arrows)
//
// Window symbols (all types): 3 parallel lines (outer frame / glass / inner frame)
//   'double' additionally gets a centre mullion splitting both panes
//   No opening arcs for windows — clean architectural representation
//
// Door symbols depend on `swing` / `leaf_count` from DOOR_TYPE_MAP:
//   'left'/'right' → panel line + quarter-circle swing arc
//   'double'        → two symmetric panels + two arcs
//   'sliding'       → dashed arrow parallel to wall (no arc)
//   'folding'       → zigzag panel + short arc

interface SymbolConfig {
  showDoorSwing: boolean;
  showDoorPanel: boolean;
  showWindowRect: boolean;
  showWindowGlass: boolean;
  showWhiteMask: boolean;
  showWallBreaks: boolean;
  showShellBreaks: boolean;
  showCoveringBreaks: boolean;
}

function buildPlanSymbols(
  scene: THREE.Scene,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  cutYm: number,
  cfg: SymbolConfig,
  _symbolRegistryVersion: number, // increment to force re-run when registry changes
): void {
  const old = scene.getObjectByName('__plan_symbols__');
  if (old) scene.remove(old);

  const symGroup = new THREE.Group();
  symGroup.name = '__plan_symbols__';

  const Y_MASK  = cutYm - 0.022;   // white mask layer
  const Y_SILL  = cutYm - 0.021;   // sill / parapet zone (above mask)
  const Y_BREAK = cutYm - 0.018;   // wall break lines
  const Y       = cutYm - 0.015;   // symbols layer

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const mkLine = (pts: THREE.Vector3[], color: number, lw = 1, nt: 'door' | 'window'): THREE.Line => {
    const l = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: lw }),
    );
    l.renderOrder = 20;
    l.userData.isPlanSymbol   = true;
    l.userData.symbolNodeType = nt;
    return l;
  };

  const mkDashedLine = (pts: THREE.Vector3[], color: number, dashSize: number, gapSize: number, nt: 'door' | 'window'): THREE.Line => {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    // compute distances for dashing
    const dists = [0];
    for (let i = 1; i < pts.length; i++) dists.push(dists[i - 1] + pts[i].distanceTo(pts[i - 1]));
    geo.setAttribute('lineDistance', new THREE.Float32BufferAttribute(dists, 1));
    const l = new THREE.Line(
      geo,
      new THREE.LineDashedMaterial({ color, depthTest: false, dashSize, gapSize, linewidth: 1 }),
    );
    l.computeLineDistances();
    l.renderOrder = 20;
    l.userData.isPlanSymbol   = true;
    l.userData.symbolNodeType = nt;
    return l;
  };

  const mkMask = (w: number, d: number, cx: number, cz: number, ang: number) => {
    const geo = new THREE.PlaneGeometry(w, d);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xf8f8f4, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    }));
    mesh.rotation.set(-Math.PI / 2, 0, ang);
    mesh.position.set(cx, Y_MASK, cz);
    mesh.renderOrder = 15;
    mesh.userData.isPlanSymbol = true;
    return mesh;
  };

  /** Sill/parapet zone: seen fill rendered above the white mask. */
  const mkSillZone = (
    w: number, d: number, cx: number, cz: number, ang: number,
    ux_: number, uz_: number, nx_: number, nz_: number,
    fillColor: string, fillOpacity: number, lineColor: string, lineDash: number,
  ) => {
    const color = new THREE.Color(fillColor);
    const geo = new THREE.PlaneGeometry(w, d);
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: fillOpacity,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    }));
    fill.rotation.set(-Math.PI / 2, 0, ang);
    fill.position.set(cx, Y_SILL, cz);
    fill.renderOrder = 16;
    fill.userData.isPlanSymbol = true;
    symGroup.add(fill);

    // Diagonal hatch lines (pairs = line segments)
    const lineC = new THREE.Color(lineColor);
    const hw = w / 2, hd = d / 2;
    const step = 0.06;
    const hatchPts: THREE.Vector3[] = [];
    for (let t = -d; t < w + d; t += step) {
      const cu1 = Math.max(-hw, Math.min(hw, t - hd));
      const cu2 = Math.max(-hw, Math.min(hw, t + hd));
      if (cu1 >= cu2) continue;
      const cn1 = Math.max(-hd, Math.min(hd, -hd + (t <= -hw ? 0 : 1) * 0));
      const cn2 = Math.max(-hd, Math.min(hd,  hd));
      void cn1; void cn2;
      const wx1 = cx + cu1 * ux_ - (-hd) * nx_; const wz1 = cz + cu1 * uz_ - (-hd) * nz_;
      const wx2 = cx + cu2 * ux_ - ( hd) * nx_; const wz2 = cz + cu2 * uz_ - ( hd) * nz_;
      hatchPts.push(new THREE.Vector3(wx1, Y_SILL, wz1), new THREE.Vector3(wx2, Y_SILL, wz2));
    }
    if (hatchPts.length > 0) {
      const hg = new THREE.BufferGeometry().setFromPoints(hatchPts);
      const hm = new THREE.LineBasicMaterial({ color: lineC, transparent: true, opacity: 0.4, depthTest: false });
      const hs = new THREE.LineSegments(hg, hm);
      hs.renderOrder = 17; hs.userData.isPlanSymbol = true;
      symGroup.add(hs);
    }

    // Dashed outline
    const corners: THREE.Vector3[] = [
      new THREE.Vector3(cx - ux_ * hw - nx_ * hd, Y_SILL, cz - uz_ * hw - nz_ * hd),
      new THREE.Vector3(cx + ux_ * hw - nx_ * hd, Y_SILL, cz + uz_ * hw - nz_ * hd),
      new THREE.Vector3(cx + ux_ * hw + nx_ * hd, Y_SILL, cz + uz_ * hw + nz_ * hd),
      new THREE.Vector3(cx - ux_ * hw + nx_ * hd, Y_SILL, cz - uz_ * hw + nz_ * hd),
      new THREE.Vector3(cx - ux_ * hw - nx_ * hd, Y_SILL, cz - uz_ * hw - nz_ * hd),
    ];
    const outGeo = new THREE.BufferGeometry().setFromPoints(corners);
    let outMat: THREE.Material;
    if (lineDash > 0) {
      const dists = [0];
      for (let i = 1; i < corners.length; i++) dists.push(dists[i-1] + corners[i].distanceTo(corners[i-1]));
      outGeo.setAttribute('lineDistance', new THREE.Float32BufferAttribute(dists, 1));
      outMat = new THREE.LineDashedMaterial({ color: lineC, depthTest: false, dashSize: lineDash, gapSize: lineDash * 0.75 });
    } else {
      outMat = new THREE.LineBasicMaterial({ color: lineC, depthTest: false });
    }
    const outline = new THREE.Line(outGeo, outMat);
    if (lineDash > 0) outline.computeLineDistances();
    outline.renderOrder = 17; outline.userData.isPlanSymbol = true;
    symGroup.add(outline);
  };

  // ── Resolve opening style from library type maps ───────────────────────────
  const getWindowOpening = (op: OpeningMeshDesc): 'none' | 'single' | 'double' | 'tilt-turn' => {
    const typeId = String(op.node?.properties?.window_type ?? '');
    const entry = typeId ? WINDOW_TYPE_MAP.get(typeId) : undefined;
    if (entry) return entry.opening;
    // fallback: check explicit 'double' property
    const d = op.node?.properties?.double;
    if (d === true || d === 'true' || d === 'True') return 'double';
    return 'none';
  };

  const getDoorSwing = (op: OpeningMeshDesc): { swing: 'left' | 'right' | 'double' | 'sliding' | 'folding'; leafCount: 1 | 2 } => {
    const typeId = String(op.node?.properties?.door_type ?? '');
    const entry = typeId ? DOOR_TYPE_MAP.get(typeId) : undefined;
    if (entry) return { swing: entry.swing, leafCount: entry.leaf_count };
    // fallback from node properties
    const hs = String(op.node?.properties?.hinge_side ?? 'left').toLowerCase();
    const d = op.node?.properties?.double;
    if (d === true || d === 'true' || d === 'True') return { swing: 'double', leafCount: 2 };
    return { swing: hs === 'right' ? 'right' : 'left', leafCount: 1 };
  };

  // ── Draw a single-leaf swing arc (door or window opening arc) ──────────────
  const drawSwingArc = (
    hingeX: number, hingeZ: number,
    latchDirX: number, latchDirZ: number,
    swingNormX: number, swingNormZ: number,
    radius: number,
    color: number, lw: number, nt: 'door' | 'window',
  ) => {
    const N = 24;
    const arcPts: THREE.Vector3[] = [];
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * (Math.PI / 2);
      arcPts.push(new THREE.Vector3(
        hingeX + latchDirX * radius * Math.cos(t) + swingNormX * radius * Math.sin(t),
        Y,
        hingeZ + latchDirZ * radius * Math.cos(t) + swingNormZ * radius * Math.sin(t),
      ));
    }
    symGroup.add(mkLine(arcPts, color, lw, nt));
  };

  // ── Process each wall ─────────────────────────────────────────────────────
  for (const wn of nodes.filter((n) => n.type === 'wall')) {
    const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins);
    if (!geo) continue;

    for (const op of geo.openings) {
      const { isDoor, cx, cz, ux, uz, nx, nz, oW, wallThick, botY, sill, oH } = op;
      const nt: 'door' | 'window' = isDoor ? 'door' : 'window';
      const openTop = botY + sill + oH;

      // Check if cut elevation falls within this opening's height range
      if (isDoor) {
        if (cutYm < botY - 0.001 || cutYm > openTop + 0.001) continue;
      } else {
        if (cutYm < botY + sill - 0.001 || cutYm > openTop + 0.001) continue;
      }

      const half = wallThick / 2;
      const ang  = Math.atan2(uz, ux); // wall rotation in XZ

      // Opening endpoints along wall centreline
      const p1x = cx - ux * oW / 2, p1z = cz - uz * oW / 2; // "left" end
      const p2x = cx + ux * oW / 2, p2z = cz + uz * oW / 2; // "right" end

      // ── 1. WHITE MASK — covers 3D fill in the opening area ─────────────
      if (cfg.showWhiteMask) {
        const maskDepth = wallThick + 1.0;
        symGroup.add(mkMask(oW + 0.01, maskDepth, cx, cz, ang));
      }

      // ── 2. WALL BREAK LINES — transverse dark lines at opening edges (wall meets void)
      if (cfg.showWallBreaks) {
        for (const side of [-1, 1] as const) {
          const ex = cx + ux * side * oW / 2;
          const ez = cz + uz * side * oW / 2;
          symGroup.add(mkLine([
            new THREE.Vector3(ex - nx * half, Y_BREAK, ez - nz * half),
            new THREE.Vector3(ex + nx * half, Y_BREAK, ez + nz * half),
          ], 0x222222, 1, nt));
        }
      }

      // ── 3. OPENING SYMBOLS ─────────────────────────────────────────────
      if (!isDoor) {
        // ────────── WINDOW ──────────────────────────────────────────────
        const wStyle = getWindowOpening(op);
        const typeId = String(op.node?.properties?.window_type ?? '');
        const wCfg   = resolveWindowPlan2DConfig(typeId, wStyle);

        // ── 3a. Sill / parapet zone (seen fill — between line 2 and line 3) ─────
        // Only show when the cut is above the sill (parapet visible below cut)
        const outerOff  = wCfg.outerLineOffset_mm * MM;   // m toward exterior (+nx)
        const innerOff  = wCfg.innerLineOffset_mm * MM;   // m toward interior (−nx)
        const sillProjM = wCfg.sillProjection_mm  * MM;   // m beyond inner (−nx)
        const fCol = new THREE.Color(wCfg.frameColor).getHex();

        if (wCfg.showSillZone && sill > 0.001 && cutYm > botY + sill - 0.001) {
          // Centre the sill zone between line 2 and line 3
          const sillCx = cx - nx * (innerOff + sillProjM / 2);
          const sillCz = cz - nz * (innerOff + sillProjM / 2);
          mkSillZone(
            oW, sillProjM, sillCx, sillCz, ang,
            ux, uz, nx, nz,
            wCfg.sillFillColor, wCfg.sillFillOpacity,
            wCfg.sillLineColor, wCfg.sillLineDash,
          );
        }

        // ── 3b. Frame squares + glass panels ────────────────────────────
        const sqH = (wCfg.squareSide_mm * MM) / 2; // half-side in metres
        const gw  = (wCfg.glassPanelWidth_mm * MM) / 2; // glass half-width in metres
        const gCol = new THREE.Color(wCfg.glassColor).getHex();

        // Inset square centres from opening endpoints
        const s1x = p1x + ux * sqH, s1z = p1z + uz * sqH;
        const s2x = p2x - ux * sqH, s2z = p2z - uz * sqH;

        if (cfg.showWindowRect && wCfg.showFrameSquares) {
          const drawSquare = (sx: number, sz: number) => {
            const a1x = sx - ux * sqH - nx * sqH, a1z = sz - uz * sqH - nz * sqH;
            const a2x = sx + ux * sqH - nx * sqH, a2z = sz + uz * sqH - nz * sqH;
            const a3x = sx + ux * sqH + nx * sqH, a3z = sz + uz * sqH + nz * sqH;
            const a4x = sx - ux * sqH + nx * sqH, a4z = sz - uz * sqH + nz * sqH;
            symGroup.add(mkLine([
              new THREE.Vector3(a1x, Y, a1z), new THREE.Vector3(a2x, Y, a2z),
              new THREE.Vector3(a3x, Y, a3z), new THREE.Vector3(a4x, Y, a4z),
              new THREE.Vector3(a1x, Y, a1z),
            ], fCol, wCfg.cutLineWeight, nt));
          };

          if (wStyle === 'double') {
            drawSquare(s1x, s1z);
            drawSquare(cx, cz);   // centre square
            drawSquare(s2x, s2z);
          } else {
            drawSquare(s1x, s1z);
            drawSquare(s2x, s2z);
          }
        }

        if (cfg.showWindowGlass && wCfg.showGlassPanel) {
          const drawGlassRect = (ax: number, az: number, bx: number, bz: number) => {
            const r1x = ax - nx * gw, r1z = az - nz * gw;
            const r2x = bx - nx * gw, r2z = bz - nz * gw;
            const r3x = bx + nx * gw, r3z = bz + nz * gw;
            const r4x = ax + nx * gw, r4z = az + nz * gw;
            symGroup.add(mkLine([
              new THREE.Vector3(r1x, Y, r1z), new THREE.Vector3(r2x, Y, r2z),
              new THREE.Vector3(r3x, Y, r3z), new THREE.Vector3(r4x, Y, r4z),
              new THREE.Vector3(r1x, Y, r1z),
            ], gCol, wCfg.seenLineWeight, nt));
          };

          if (wStyle === 'double') {
            drawGlassRect(s1x + ux * sqH, s1z + uz * sqH, cx - ux * sqH, cz - uz * sqH);
            drawGlassRect(cx + ux * sqH,  cz + uz * sqH,  s2x - ux * sqH, s2z - uz * sqH);
          } else {
            drawGlassRect(s1x + ux * sqH, s1z + uz * sqH, s2x - ux * sqH, s2z - uz * sqH);
          }
        }

        // ── 3c. Three parallel frame lines ──────────────────────────────
        // Line 1 — outer frame (toward exterior, +nx direction)
        symGroup.add(mkLine([
          new THREE.Vector3(p1x + nx * outerOff, Y, p1z + nz * outerOff),
          new THREE.Vector3(p2x + nx * outerOff, Y, p2z + nz * outerOff),
        ], fCol, wCfg.cutLineWeight, nt));

        // Line 2 — inner frame (toward interior, −nx direction)
        symGroup.add(mkLine([
          new THREE.Vector3(p1x - nx * innerOff, Y, p1z - nz * innerOff),
          new THREE.Vector3(p2x - nx * innerOff, Y, p2z - nz * innerOff),
        ], fCol, wCfg.cutLineWeight, nt));

        // Line 3 — sill line (further into interior)
        const sillLineCol3 = new THREE.Color(wCfg.sillLineColor).getHex();
        const sillEnd = innerOff + sillProjM;
        if (wCfg.sillLineDash > 0) {
          symGroup.add(mkDashedLine([
            new THREE.Vector3(p1x - nx * sillEnd, Y, p1z - nz * sillEnd),
            new THREE.Vector3(p2x - nx * sillEnd, Y, p2z - nz * sillEnd),
          ], sillLineCol3, wCfg.sillLineDash, wCfg.sillLineDash * 0.75, nt));
        } else {
          symGroup.add(mkLine([
            new THREE.Vector3(p1x - nx * sillEnd, Y, p1z - nz * sillEnd),
            new THREE.Vector3(p2x - nx * sillEnd, Y, p2z - nz * sillEnd),
          ], sillLineCol3, wCfg.seenLineWeight, nt));
        }

        // Jamb reveals: connect line 1 to line 2 at each opening side
        for (const [jx, jz] of [[p1x, p1z], [p2x, p2z]] as const) {
          symGroup.add(mkLine([
            new THREE.Vector3(jx + nx * outerOff, Y, jz + nz * outerOff),
            new THREE.Vector3(jx - nx * innerOff, Y, jz - nz * innerOff),
          ], fCol, wCfg.cutLineWeight * 0.7, nt));
        }

        // Sill reveal lines — black jamb break lines from line2 to line3 at each opening end.
        for (const [jx, jz] of [[p1x, p1z], [p2x, p2z]] as const) {
          symGroup.add(mkLine([
            new THREE.Vector3(jx - nx * innerOff, Y_BREAK, jz - nz * innerOff),
            new THREE.Vector3(jx - nx * sillEnd,  Y_BREAK, jz - nz * sillEnd),
          ], 0x111111, wCfg.cutLineWeight, nt));
        }

        // Casement opening indicator — V-lines from line 2 endpoints to line 3 midpoint
        const l2p1x = p1x - nx * innerOff, l2p1z = p1z - nz * innerOff;
        const l2p2x = p2x - nx * innerOff, l2p2z = p2z - nz * innerOff;
        if (wStyle === 'single' || wStyle === 'tilt-turn') {
          const apex_x = cx - nx * sillEnd, apex_z = cz - nz * sillEnd;
          symGroup.add(mkLine([
            new THREE.Vector3(l2p1x, Y, l2p1z),
            new THREE.Vector3(apex_x, Y, apex_z),
          ], fCol, wCfg.seenLineWeight, nt));
          symGroup.add(mkLine([
            new THREE.Vector3(l2p2x, Y, l2p2z),
            new THREE.Vector3(apex_x, Y, apex_z),
          ], fCol, wCfg.seenLineWeight, nt));
        } else if (wStyle === 'double') {
          const q1x = (p1x + cx) / 2 - nx * sillEnd, q1z = (p1z + cz) / 2 - nz * sillEnd;
          const q2x = (p2x + cx) / 2 - nx * sillEnd, q2z = (p2z + cz) / 2 - nz * sillEnd;
          const l2cx = cx - nx * innerOff, l2cz = cz - nz * innerOff;
          symGroup.add(mkLine([new THREE.Vector3(l2p1x, Y, l2p1z), new THREE.Vector3(q1x, Y, q1z)], fCol, wCfg.seenLineWeight, nt));
          symGroup.add(mkLine([new THREE.Vector3(l2cx,  Y, l2cz),  new THREE.Vector3(q1x, Y, q1z)], fCol, wCfg.seenLineWeight, nt));
          symGroup.add(mkLine([new THREE.Vector3(l2cx,  Y, l2cz),  new THREE.Vector3(q2x, Y, q2z)], fCol, wCfg.seenLineWeight, nt));
          symGroup.add(mkLine([new THREE.Vector3(l2p2x, Y, l2p2z), new THREE.Vector3(q2x, Y, q2z)], fCol, wCfg.seenLineWeight, nt));
        }

      } else {
        // ────────── DOOR ────────────────────────────────────────────────
        const { swing, leafCount } = getDoorSwing(op);
        const swingOut  = String(op.node?.properties?.swing_out   ?? '').toLowerCase() === 'true';
        const flipAlong  = String(op.node?.properties?.flip_along  ?? '').toLowerCase() === 'true';
        const flipAcross = String(op.node?.properties?.flip_across ?? '').toLowerCase() === 'true';

        // flip_across: inner ↔ outer face (negate normal swingDir)
        const effectiveSwingOut = flipAcross ? !swingOut : swingOut;
        const swingDir = effectiveSwingOut ? -1 : 1;
        const snx = nx * swingDir, snz = nz * swingDir;

        // flip_along: swap which endpoint is the hinge (p1 ↔ p2, ux ↔ -ux)
        const ap1x = flipAlong ? p2x : p1x, ap1z = flipAlong ? p2z : p1z;
        const ap2x = flipAlong ? p1x : p2x, ap2z = flipAlong ? p1z : p2z;
        const aux  = flipAlong ? -ux : ux,   auz  = flipAlong ? -uz : uz;

        if (swing === 'sliding') {
          if (cfg.showDoorPanel) {
            const slideOffset = half * 0.3;
            symGroup.add(mkLine([
              new THREE.Vector3(ap1x + nx * slideOffset, Y, ap1z + nz * slideOffset),
              new THREE.Vector3(ap2x + nx * slideOffset, Y, ap2z + nz * slideOffset),
            ], 0x444444, 2, nt));
            const arrowStart = 0.3, arrowEnd = 0.9;
            const asx = ap1x + aux * oW * arrowStart - nx * slideOffset;
            const asz = ap1z + auz * oW * arrowStart - nz * slideOffset;
            const aex = ap1x + aux * oW * arrowEnd   - nx * slideOffset;
            const aez = ap1z + auz * oW * arrowEnd   - nz * slideOffset;
            symGroup.add(mkDashedLine([
              new THREE.Vector3(asx, Y, asz), new THREE.Vector3(aex, Y, aez),
            ], 0x666666, 0.06, 0.04, nt));
            const arrowLen = oW * 0.08;
            symGroup.add(mkLine([
              new THREE.Vector3(aex - aux * arrowLen - nx * arrowLen * 0.5, Y, aez - auz * arrowLen - nz * arrowLen * 0.5),
              new THREE.Vector3(aex, Y, aez),
              new THREE.Vector3(aex - aux * arrowLen + nx * arrowLen * 0.5, Y, aez - auz * arrowLen + nz * arrowLen * 0.5),
            ], 0x666666, 1, nt));
          }

        } else if (swing === 'double' || leafCount === 2) {
          const leafW = oW / 2;
          if (cfg.showDoorPanel) {
            symGroup.add(mkLine([
              new THREE.Vector3(ap1x, Y, ap1z),
              new THREE.Vector3(ap1x + snx * leafW, Y, ap1z + snz * leafW),
            ], 0x111111, 2, nt));
            symGroup.add(mkLine([
              new THREE.Vector3(ap2x, Y, ap2z),
              new THREE.Vector3(ap2x + snx * leafW, Y, ap2z + snz * leafW),
            ], 0x111111, 2, nt));
          }
          if (cfg.showDoorSwing) {
            drawSwingArc(ap1x, ap1z, aux, auz, snx, snz, leafW, 0x555555, 1, nt);
            drawSwingArc(ap2x, ap2z, -aux, -auz, snx, snz, leafW, 0x555555, 1, nt);
          }

        } else if (swing === 'folding') {
          if (cfg.showDoorPanel) {
            const folds = 3;
            const foldW = oW / folds;
            const zigPts: THREE.Vector3[] = [];
            for (let i = 0; i <= folds; i++) {
              const along = ap1x + aux * foldW * i;
              const aZ    = ap1z + auz * foldW * i;
              const offset = (i % 2 === 1) ? half * 0.6 : 0;
              zigPts.push(new THREE.Vector3(along + snx * offset, Y, aZ + snz * offset));
            }
            symGroup.add(mkLine(zigPts, 0x333333, 2, nt));
          }
          if (cfg.showDoorSwing) {
            drawSwingArc(ap1x, ap1z, aux, auz, snx, snz, oW * 0.4, 0x888888, 1, nt);
          }

        } else {
          // Single swing — hinge is at ap1x/ap1z (after flip_along transform)
          const hx = ap1x;
          const hz = ap1z;
          const lx = aux;
          const lz = auz;

          if (cfg.showDoorPanel) {
            symGroup.add(mkLine([
              new THREE.Vector3(hx, Y, hz),
              new THREE.Vector3(hx + snx * oW, Y, hz + snz * oW),
            ], 0x111111, 2, nt));
          }
          if (cfg.showDoorSwing) {
            drawSwingArc(hx, hz, lx, lz, snx, snz, oW, 0x555555, 1, nt);
          }
        }
      }
    }
  }

  scene.add(symGroup);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function FloorPlanOrthoViewer({
  nodes,
  edges,
  storeyId,
  cutElevation: cutElevProp,
  viewDepth: viewDepthProp,
  className,
}: FloorPlanOrthoViewerProps) {
  // Derive storey node for defaults
  const storeyNode = storeyId ? nodes.find((n) => n.id === storeyId) : undefined;
  const storeyBot  = Number(storeyNode?.properties.bottomElevation ?? 0);
  const storeyTop  = Number(storeyNode?.properties.topElevation   ?? storeyBot + 3000);

  // Cut elevation: prop > storey floor + 1200 mm > fallback 1200 mm
  const cutElevation =
    cutElevProp !== undefined ? cutElevProp : storeyNode ? storeyBot + 1200 : 1200;

  // View depth: prop > storey height > fallback 3000 mm
  const viewDepth =
    viewDepthProp !== undefined ? viewDepthProp
    : storeyNode  ? (storeyTop - storeyBot)
    : 3000;

  // ── State ─────────────────────────────────────────────────────────────────
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set(['room']));
  const [renderMode, setRenderMode]   = useState<RenderMode>('colored');
  const [isReady, setIsReady]         = useState(false);
  const [showSymbolPanel, setShowSymbolPanel] = useState(false);
  const [showWindowConfigurator, setShowWindowConfigurator] = useState(false);
  const [symbolConfig, setSymbolConfig] = useState({
    showDoorSwing: true,
    showDoorPanel: true,
    showWindowRect: true,
    showWindowGlass: true,
    showWhiteMask: true,
    showWallBreaks: true,
    showShellBreaks: true,
    showCoveringBreaks: true,
  });

  const toggleSymbol = useCallback((key: keyof typeof symbolConfig) => {
    setSymbolConfig((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Subscribe to window symbol registry changes so the plan re-renders when
  // the configurator is edited.
  const symbolRegistryVersion = useSyncExternalStore(
    subscribeWindowSymbolConfig,
    () => 0, // snapshot: always 0 but re-render on each change
  );

  const [activeTool, setActiveTool] = useState<AnnotationTool | null>(null);
  const containerRef  = useRef<HTMLDivElement>(null);
  const componentsRef = useRef<OBC.Components | null>(null);
  const worldRef      = useRef<OBC.World | null>(null);
  const editorRef     = useRef<OBF.DrawingEditor | null>(null);
  const drawingRef    = useRef<any>(null);

  const { config: matConfig } = useMaterialConfig();

  // ── Selection ──────────────────────────────────────────────────────────────
  const setSelectedNodeId = useBubbleGraphStore((s) => s.setSelectedNodeId);
  const selectedNodeId    = useBubbleGraphStore((s) => s.selectedNodeId);

  // ── Draw Wall state ───────────────────────────────────────────────────────
  const setBubbleGraph = useBubbleGraphStore((s) => s.setBubbleGraph);
  const rawStoreNodes  = useBubbleGraphStore((s) => s.bubbleGraphNodes);
  const rawStoreEdges  = useBubbleGraphStore((s) => s.bubbleGraphEdges);

  const [drawWallMode, setDrawWallMode] = useState(false);
  const [wallStart, setWallStart]       = useState<{ x: number; y: number } | null>(null);
  const [hoverSnap, setHoverSnap]       = useState<{ x: number; y: number } | null>(null);
  const [hoverRaw, setHoverRaw]         = useState<{ x: number; y: number } | null>(null);

  // Storey axis data for snap points
  const axisXVals = useMemo(
    () => parseAxes(storeyNode?.properties?.axesX).slice().sort((a, b) => a - b),
    [storeyNode],
  );
  const axisYVals = useMemo(
    () => parseAxes(storeyNode?.properties?.axesY).slice().sort((a, b) => a - b),
    [storeyNode],
  );

  // All snap points (BIM mm): axis intersections + axis midpoints + cross-midpoints
  const snapPoints = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    for (const x of axisXVals) for (const y of axisYVals) pts.push({ x, y });
    for (let i = 0; i < axisXVals.length - 1; i++) {
      const mx = (axisXVals[i] + axisXVals[i + 1]) / 2;
      for (const y of axisYVals) pts.push({ x: mx, y });
    }
    for (let j = 0; j < axisYVals.length - 1; j++) {
      const my = (axisYVals[j] + axisYVals[j + 1]) / 2;
      for (const x of axisXVals) pts.push({ x, y: my });
    }
    for (let i = 0; i < axisXVals.length - 1; i++) {
      const mx = (axisXVals[i] + axisXVals[i + 1]) / 2;
      for (let j = 0; j < axisYVals.length - 1; j++) {
        const my = (axisYVals[j] + axisYVals[j + 1]) / 2;
        pts.push({ x: mx, y: my });
      }
    }
    return pts;
  }, [axisXVals, axisYVals]);

  // Room parametric control grids (computed from inset room polygons — inside real contour)
  const roomParametricGrids = useMemo((): RoomParametricGrid[] => {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const roomNodes = nodes.filter((n) => n.type === 'room' && n.parentId === storeyId);
    const grids: RoomParametricGrid[] = [];
    for (const rn of roomNodes) {
      let poly = calcRoomPolygon(rn, nodeMap, edges);
      if (!poly || poly.length < 3) continue;
      // Inset polygon by contour_offset (default -125mm inward) to get real interior
      const rawOff = parseContourOffsets(rn.properties.contour_offset);
      const inward = rawOff.map((o) => -o);
      if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);
      grids.push(calcRoomParametricGrid(poly, rn.id));
    }
    return grids;
  }, [nodes, edges, storeyId]);

  // Augmented snap points: axis grid + room parametric points (when in draw-wall mode)
  const allSnapPoints = useMemo(() => {
    if (!drawWallMode) return snapPoints;
    const extra = roomParametricGrids.flatMap((g) => g.points);
    return [...snapPoints, ...extra];
  }, [snapPoints, roomParametricGrids, drawWallMode]);

  const SNAP_THRESHOLD_MM = 500;

  /** Convert screen pixel (relative to container) → BIM mm using OBC camera. */
  const screenToBim = useCallback((sx: number, sy: number): { x: number; y: number } | null => {
    const world = worldRef.current;
    const container = containerRef.current;
    if (!world || !container) return null;
    const cam = (world.camera as OBC.OrthoPerspectiveCamera).controls.camera as THREE.OrthographicCamera;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const ndcX = (sx / w) * 2 - 1;
    const ndcY = -(sy / h) * 2 + 1;
    const v = new THREE.Vector3(ndcX, ndcY, 0).unproject(cam);
    // Three.js coord → BIM: X→X (mm), -Z→Y (mm)
    return { x: v.x / MM, y: -v.z / MM };
  }, []);

  /** BIM mm → screen pixel. */
  const bimToScreen = useCallback((bx: number, by: number): { sx: number; sy: number } | null => {
    const world = worldRef.current;
    const container = containerRef.current;
    if (!world || !container) return null;
    const cam = (world.camera as OBC.OrthoPerspectiveCamera).controls.camera as THREE.OrthographicCamera;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const v = new THREE.Vector3(bx * MM, 0, -by * MM).project(cam);
    return { sx: (v.x + 1) / 2 * w, sy: (-v.y + 1) / 2 * h };
  }, []);

  const findSnap = useCallback((pt: { x: number; y: number }): { x: number; y: number } => {
    let best: { x: number; y: number } | null = null;
    let bestD = SNAP_THRESHOLD_MM;
    for (const p of allSnapPoints) {
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ?? pt;
  }, [allSnapPoints]);

  /**
   * Convert a BIM mm position to graph canvas pixel position.
   * Uses the same formula the graph editor uses when auto-placing ax nodes:
   *   canvas = storeyNode.xy + (bim_mm - maxAxis/2)
   * Scale is 1:1 (1 canvas pixel = 1 BIM mm), centered on storey canvas pos.
   */
  const bimToCanvasPos = useCallback((bimPt: { x: number; y: number }): { x: number; y: number } => {
    const sn = rawStoreNodes.find((n) => n.id === storeyId);
    if (!sn) return { x: 300, y: 300 };
    const axesX = parseAxes(sn.properties?.axesX).sort((a, b) => a - b);
    const axesY = parseAxes(sn.properties?.axesY).sort((a, b) => a - b);
    const maxX = axesX.length > 0 ? axesX[axesX.length - 1] : 0;
    const maxY = axesY.length > 0 ? axesY[axesY.length - 1] : 0;
    return {
      x: sn.x + (bimPt.x - maxX / 2),
      y: sn.y + (bimPt.y - maxY / 2),
    };
  }, [rawStoreNodes, storeyId]);

  const commitWall = useCallback((ptA: { x: number; y: number }, ptB: { x: number; y: number }) => {
    if (!storeyId) return;
    const REUSE_DIST = 100; // mm
    // Build a nodeMap for getAxRealPos lookups
    const nodeMap = new Map(rawStoreNodes.map((n) => [n.id, n]));
    const stAxNodes = rawStoreNodes.filter(
      (n) => n.type === 'ax' && n.parentId === storeyId,
    );
    // Match against actual BIM positions (gridX/gridY or bimX/bimY), not canvas x/y
    const findExisting = (pt: { x: number; y: number }) =>
      stAxNodes.find((n) => {
        const pos = getAxRealPos(n, nodeMap);
        return Math.hypot(pos.x - pt.x, pos.y - pt.y) < REUSE_DIST;
      });

    const existingA = findExisting(ptA);
    const existingB = findExisting(ptB);
    const startId = existingA ? existingA.id : `ax_${fpUid()}`;
    const endId   = existingB ? existingB.id : `ax_${fpUid()}`;
    const wallId  = `wall_${fpUid()}`;

    const axCount   = rawStoreNodes.filter((n) => n.type === 'ax').length;
    const wallCount = rawStoreNodes.filter((n) => n.type === 'wall').length;
    const canvasA   = bimToCanvasPos(ptA);
    const canvasB   = bimToCanvasPos(ptB);
    const canvasMid = { x: (canvasA.x + canvasB.x) / 2, y: (canvasA.y + canvasB.y) / 2 };
    const newNodes: BubbleGraphNode[] = [];
    if (!existingA) {
      newNodes.push({
        id: startId, type: 'ax', name: `Ax${axCount + 1}`,
        x: canvasA.x, y: canvasA.y, z: 0, parentId: storeyId,
        properties: { has_column: 'False', column_type: 'C25x25', bimX: ptA.x, bimY: ptA.y },
      });
    }
    if (!existingB) {
      newNodes.push({
        id: endId, type: 'ax', name: `Ax${axCount + newNodes.length + 1}`,
        x: canvasB.x, y: canvasB.y, z: 0, parentId: storeyId,
        properties: { has_column: 'False', column_type: 'C25x25', bimX: ptB.x, bimY: ptB.y },
      });
    }
    // Determine if wall belongs to a room (both endpoints are room parametric points)
    const ROOM_SNAP_EPS = 10; // mm tolerance
    let ownerRoomId: string | null = null;
    for (const grid of roomParametricGrids) {
      const inA = grid.points.some((p) => Math.hypot(p.x - ptA.x, p.y - ptA.y) < ROOM_SNAP_EPS);
      const inB = grid.points.some((p) => Math.hypot(p.x - ptB.x, p.y - ptB.y) < ROOM_SNAP_EPS);
      if (inA && inB) { ownerRoomId = grid.roomId; break; }
    }
    const wallParentId = ownerRoomId ?? storeyId;

    newNodes.push({
      id: wallId, type: 'wall', name: `Wall${wallCount + 1}`,
      x: canvasMid.x, y: canvasMid.y, z: 0, parentId: wallParentId,
      properties: {
        wall_type: 'W20', height: 3000,
        offset_start: 0, offset_end: 0,
        has_beam: 'True', beam_section: 'B20x30',
        material: 'Beton C30/37',
        has_windows: 'False', windows: '[]',
        has_doors: 'False', doors: '[]',
        ...(ownerRoomId ? { roomId: ownerRoomId } : {}),
      },
    });
    const newEdges: BubbleGraphEdge[] = [
      { id: `edge_${fpUid()}`, from: startId, to: wallId },
      { id: `edge_${fpUid()}`, from: wallId, to: endId },
    ];
    setBubbleGraph([...rawStoreNodes, ...newNodes], [...rawStoreEdges, ...newEdges]);
  }, [storeyId, rawStoreNodes, rawStoreEdges, setBubbleGraph, bimToCanvasPos, roomParametricGrids]);

  const handleOverlayMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!drawWallMode || e.button !== 0 || e.shiftKey) return;
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const bim = screenToBim(e.clientX - rect.left, e.clientY - rect.top);
    if (!bim) return;
    const snapped = findSnap(bim);
    if (!wallStart) {
      setWallStart(snapped);
    } else {
      commitWall(wallStart, snapped);
      setWallStart(null);
    }
  }, [drawWallMode, wallStart, screenToBim, findSnap, commitWall]);

  const handleOverlayMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!drawWallMode) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const bim = screenToBim(e.clientX - rect.left, e.clientY - rect.top);
    if (bim) {
      setHoverRaw(bim);
      setHoverSnap(findSnap(bim));
    }
  }, [drawWallMode, screenToBim, findSnap]);

  // ── Click-to-select: raycast through the OBC scene when NOT in draw-wall mode ──
  const raycasterRef = useRef(new THREE.Raycaster());
  const handleSceneClick = useCallback((e: MouseEvent) => {
    if (drawWallMode) return;
    const world = worldRef.current;
    const container = containerRef.current;
    if (!world || !container) return;
    const cam = (world.camera as OBC.OrthoPerspectiveCamera).controls.camera as THREE.Camera;
    let scene: THREE.Scene;
    try { scene = world.scene.three as THREE.Scene; } catch { return; }
    const rect = container.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
    const hits = raycasterRef.current.intersectObjects(scene.children, true);
    let nodeId: string | null = null;
    let fallbackRoomId: string | null = null;
    const LOW_PRIORITY_TYPES = new Set(['room', 'storey']);
    for (const hit of hits) {
      // Skip plan-fill overlays
      if (hit.object.userData?.isPlanFill) continue;
      // Walk parent chain; collect nodeId and nodeType, bail if any ancestor invisible
      let obj: THREE.Object3D | null = hit.object;
      let invisible = false;
      let found: string | null = null;
      let foundType: string | null = null;
      while (obj) {
        if (!obj.visible) { invisible = true; break; }
        if (!found && obj.userData?.nodeId) {
          found = obj.userData.nodeId as string;
          foundType = (obj.userData.nodeType as string) ?? null;
        }
        obj = obj.parent;
      }
      if (!invisible && found && (!foundType || !hiddenTypes.has(foundType))) {
        // Room/storey have lowest selection priority — store as fallback
        if (LOW_PRIORITY_TYPES.has(foundType ?? '')) {
          if (!fallbackRoomId) fallbackRoomId = found;
          continue;
        }
        nodeId = found;
        break;
      }
    }
    setSelectedNodeId(nodeId ?? fallbackRoomId);
  }, [drawWallMode, hiddenTypes, setSelectedNodeId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener('click', handleSceneClick);
    return () => container.removeEventListener('click', handleSceneClick);
  }, [handleSceneClick]);

  /** Delete the currently selected wall (and its orphaned draw-wall ax endpoints). */
  const deleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    const node = rawStoreNodes.find((n) => n.id === selectedNodeId);
    if (!node) return;
    const toRemove = new Set<string>([selectedNodeId]);
    if (node.type === 'wall') {
      // Collect ax endpoints connected to this wall
      const connectedAxIds = rawStoreEdges
        .filter((e) => e.from === selectedNodeId || e.to === selectedNodeId)
        .map((e) => (e.from === selectedNodeId ? e.to : e.from));
      for (const axId of connectedAxIds) {
        const axNode = rawStoreNodes.find((n) => n.id === axId);
        // Only auto-remove "draw-wall" ax nodes (created by commitWall, have bimX/bimY)
        if (!axNode || axNode.properties?.bimX == null) continue;
        const hasOtherConn = rawStoreEdges.some(
          (e) => (e.from === axId || e.to === axId) && e.from !== selectedNodeId && e.to !== selectedNodeId,
        );
        if (!hasOtherConn) toRemove.add(axId);
      }
    }
    setBubbleGraph(
      rawStoreNodes.filter((n) => !toRemove.has(n.id)),
      rawStoreEdges.filter((e) => !toRemove.has(e.from) && !toRemove.has(e.to)),
    );
    setSelectedNodeId(null);
  }, [selectedNodeId, rawStoreNodes, rawStoreEdges, setBubbleGraph, setSelectedNodeId]);

  // ESC → cancel draw wall; Delete/Backspace → delete selected node
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drawWallMode) {
        setWallStart(null); setHoverSnap(null); setHoverRaw(null); setDrawWallMode(false);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !drawWallMode) {
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && !(e.target as HTMLElement)?.isContentEditable) {
          deleteSelectedNode();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawWallMode, deleteSelectedNode]);

  const { visibleTypes, typeCounts } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
    if (!counts['column']) {
      const c = nodes.filter(
        (nd) => nd.type === 'ax' && String(nd.properties.has_column ?? '').toLowerCase() === 'true',
      ).length;
      if (c > 0) counts['column'] = c;
    }
    if (!counts['beam']) {
      const c = nodes.filter(
        (nd) => nd.type === 'wall' && String(nd.properties.has_beam ?? '').toLowerCase() === 'true',
      ).length;
      if (c > 0) counts['beam'] = c;
    }
    // Doors and windows are shown as plan symbols even if the nodes count them under 'wall'
    if (!counts['door']) {
      const c = nodes.filter((nd) => nd.type === 'door').length;
      if (c > 0) counts['door'] = c;
    }
    if (!counts['window']) {
      const c = nodes.filter((nd) => nd.type === 'window').length;
      if (c > 0) counts['window'] = c;
    }
    return { visibleTypes: Object.keys(counts), typeCounts: counts };
  }, [nodes]);

  // ── OBC World Init ────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const components = new OBC.Components();
    componentsRef.current = components;

    const worlds = components.get(OBC.Worlds);
    const world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();
    world.name = 'FloorPlanView';
    world.scene    = new OBC.SimpleScene(components);
    world.renderer = new OBC.SimpleRenderer(components, container);
    world.camera   = new OBC.OrthoPerspectiveCamera(components);

    const cam = world.camera as OBC.OrthoPerspectiveCamera;
    cam.projection.set('Orthographic');

    // Lock rotation — orthographic plan view, rotation is meaningless
    cam.controls.azimuthRotateSpeed = 0;
    cam.controls.polarRotateSpeed = 0;

    world.scene.setup();
    world.scene.three.background = new THREE.Color(0xf8f8f4);

    const scene = world.scene.three as THREE.Scene;
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const topLight = new THREE.DirectionalLight(0xffffff, 0.6);
    topLight.position.set(5, 20, 5);
    scene.add(topLight);

    // Required for localClippingEnabled per-material clipping planes
    world.renderer.three.localClippingEnabled = true;

    components.init();

    // North (BIM +Y = Three.js −Z) should point up in the viewport
    cam.controls.camera.up.set(0, 0, -1);

    const onResize = () => {
      world.renderer?.resize();
      cam.updateAspect();
    };
    window.addEventListener('resize', onResize);

    // ── TechnicalDrawings + DrawingEditor ──────────────────────────────────
    try {
      const techDrawings = components.get(OBC.TechnicalDrawings);
      const drawing = techDrawings.create(world);
      drawing.orientTo(new THREE.Vector3(0, -1, 0)); // top-down floor plan (looking down)
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
        const text = window.prompt(isEdit ? 'Edit text:' : 'Callout text:', currentText ?? '') ?? currentText ?? '';
        (calloutTool as any).submitText(text);
      });

      const DIM_STYLE = {
        color: 0x1565c0, fontSize: 0.25, textOffset: 0.35, tickSize: 0.2,
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
    } catch (err) {
      console.warn('FloorPlanOrthoViewer: DrawingEditor not available', err);
    }

    // ESC cancels active annotation tool
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { editorRef.current?.cancel(); setActiveTool(null); }
    };
    window.addEventListener('keydown', onKeyDown);

    // DrawingEditor requires explicit step() on click to place points
    const canvas = world.renderer.three.domElement;
    const onCanvasClick = () => { editorRef.current?.step(); };
    canvas.addEventListener('click', onCanvasClick);

    worldRef.current = world;
    setIsReady(true);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('click', onCanvasClick);
      components.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Wire activeTool → DrawingEditor ──────────────────────────────────────
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !isReady) return;
    const TOOL_MAP: Record<AnnotationTool, any> = {
      linear:  OBF.LinearAnnotationsTool,
      angle:   OBF.AngleAnnotationsTool,
      callout: OBF.CalloutAnnotationsTool,
      leader:  OBF.LeaderAnnotationsTool,
      slope:   OBF.SlopeAnnotationsTool,
    };
    editor.activeTool = activeTool ? TOOL_MAP[activeTool] : null;
  }, [activeTool, isReady]);

  // ── Apply visibility ──────────────────────────────────────────────────────
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !isReady) return;
    let scene: THREE.Scene | null = null;
    try { scene = world.scene.three as THREE.Scene; } catch { return; }
    scene.traverse((obj) => {
      const t  = obj.userData.nodeType      as string | undefined;
      const ft = obj.userData.fillNodeType  as string | undefined;
      const st = obj.userData.symbolNodeType as string | undefined;
      if (t)        obj.visible = !hiddenTypes.has(t);
      else if (ft)  obj.visible = !hiddenTypes.has(ft);
      else if (st)  obj.visible = !hiddenTypes.has(st);
    });
  }, [hiddenTypes, isReady]);

  // ── Render mode ───────────────────────────────────────────────────────────
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !isReady) return;
    let scene: THREE.Scene | null = null;
    try { scene = world.scene.three as THREE.Scene; } catch { return; }
    applyRenderMode(scene, renderMode, matConfig, hiddenTypes);
  }, [renderMode, isReady, matConfig, hiddenTypes]);

  // ── Geometry rebuild ──────────────────────────────────────────────────────
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !isReady) return;
    let scene: THREE.Scene | null = null;
    try { scene = world.scene.three as THREE.Scene; } catch { return; }
    const cam = world.camera as OBC.OrthoPerspectiveCamera;

    // Three.js Y = BIM Z (elevation). mm → metres.
    const cutYm      = cutElevation * MM;
    const viewDepthM = viewDepth    * MM;

    // Revit-style view range: two clip planes
    //   upperClip: keep y <= cutYm   (normal points DOWN)
    //   lowerClip: keep y >= cutYm - viewDepthM  (normal points UP)
    const upperClip = new THREE.Plane(new THREE.Vector3(0, -1, 0), cutYm);
    const lowerClip = new THREE.Plane(new THREE.Vector3(0,  1, 0), -(cutYm - viewDepthM));
    const clipPlanes = [upperClip, lowerClip];

    let cancelled = false;
    (async () => {
      const ifcGroupCache = new Map<string, IFCGroupInfo>();
      const paths = collectIfcLibraryPaths(nodes);
      await Promise.all(
        paths.map(async (lp) => {
          try {
            const parts = await loadIfcParts(lp);
            if (!cancelled) ifcGroupCache.set(lp, buildIfcGroup(parts));
          } catch { /* ignore */ }
        }),
      );
      if (cancelled) return;

      // Remove old geometry (keep lights)
      const toRemove: THREE.Object3D[] = [];
      scene!.traverse((c) => {
        if (!(c instanceof THREE.Light) && c !== scene && c.parent === scene) toRemove.push(c);
      });
      toRemove.forEach((c) => scene!.remove(c));

      // Build full 3D geometry (same source as WebIfcViewer)
      buildSceneGeometry(scene!, nodes, edges, ifcGroupCache, matConfig);

      // Apply both clip planes to every material
      scene!.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          const mat = (obj as THREE.Mesh | THREE.Line).material;
          if (Array.isArray(mat)) {
            mat.forEach((m) => { if (m instanceof THREE.Material) m.clippingPlanes = clipPlanes; });
          } else if (mat instanceof THREE.Material) {
            mat.clippingPlanes = clipPlanes;
          }
        }
      });

      // Apply visibility filter and render mode
      scene!.traverse((obj) => {
        const t = obj.userData.nodeType as string | undefined;
        if (t) obj.visible = !hiddenTypes.has(t);
      });
      applyRenderMode(scene!, renderMode, matConfig, hiddenTypes);

      scene!.updateMatrixWorld(true);

      // Build plan-fill overlays: AABB fills for structural elements,
      // ring polygon fills for shells / coverings
      buildPlanFills(scene!, cutYm, matConfig, symbolConfig);

      // Build professional 2D plan symbols: door swing arcs + window rectangles
      buildPlanSymbols(scene!, nodes, edges, cutYm, symbolConfig, symbolRegistryVersion);

      // Fit camera: position directly above, looking down, north up.
      const box = new THREE.Box3();
      scene!.traverse((c) => {
        if ((c instanceof THREE.Mesh || c instanceof THREE.Line) && c.visible) {
          box.expandByObject(c);
        }
      });

      if (!box.isEmpty()) {
        const center = new THREE.Vector3();
        box.getCenter(center);
        const size    = box.getSize(new THREE.Vector3());
        const diagXZ  = Math.sqrt(size.x ** 2 + size.z ** 2) || 20;
        const camDist = diagXZ * 3 + 20;

        cam.controls.camera.up.set(0, 0, -1);
        cam.controls.setLookAt(
          center.x, center.y + camDist, center.z,
          center.x, center.y,           center.z,
          false,
        );
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, isReady, matConfig, cutElevation, viewDepth, storeyNode, hiddenTypes, symbolConfig, symbolRegistryVersion]);

  // ── Clear all annotations ─────────────────────────────────────────────────
  const clearAll = useCallback(() => {
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
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn('w-full h-full relative select-none', className)}
    >
      {!isReady && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500 bg-[#f8f8f4]">
          Loading floor plan…
        </div>
      )}
      {isReady && (
        <>
          {/* Draw-wall interaction overlay — above canvas, below UI controls */}
          {drawWallMode && (
            <div
              className="absolute inset-0 z-[5]"
              style={{ cursor: 'crosshair' }}
              onMouseDown={handleOverlayMouseDown}
              onMouseMove={handleOverlayMouseMove}
            >
              <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: 'visible' }}>
                {/* Room parametric grid lines */}
                {roomParametricGrids.map((grid) =>
                  grid.gridLines.map((line, li) => {
                    const s1 = bimToScreen(line[0].x, line[0].y);
                    const s2 = bimToScreen(line[1].x, line[1].y);
                    if (!s1 || !s2) return null;
                    return <line key={`rg_${grid.roomId}_${li}`} x1={s1.sx} y1={s1.sy} x2={s2.sx} y2={s2.sy} stroke="#14b8a6" strokeWidth={0.5} strokeOpacity={0.4} strokeDasharray="4 3" />;
                  })
                )}
                {/* Room parametric control points (teal squares) */}
                {roomParametricGrids.flatMap((grid) =>
                  grid.points.map((p, i) => {
                    const s = bimToScreen(p.x, p.y);
                    if (!s) return null;
                    return <rect key={`rp_${grid.roomId}_${i}`} x={s.sx - 3} y={s.sy - 3} width={6} height={6} fill="#14b8a6" fillOpacity={0.5} />;
                  })
                )}
                {/* Axis snap points (blue circles) */}
                {snapPoints.map((p, i) => {
                  const s = bimToScreen(p.x, p.y);
                  if (!s) return null;
                  return <circle key={i} cx={s.sx} cy={s.sy} r={3} fill="#3b82f6" fillOpacity={0.25} />;
                })}
                {hoverRaw && (() => {
                  const s = bimToScreen(hoverRaw.x, hoverRaw.y);
                  if (!s) return null;
                  const snapDist = hoverSnap
                    ? Math.hypot(hoverSnap.x - hoverRaw.x, hoverSnap.y - hoverRaw.y)
                    : 0;
                  const showSnap = hoverSnap && snapDist > 1;
                  const snapScr = showSnap ? bimToScreen(hoverSnap.x, hoverSnap.y) : null;
                  return (
                    <g>
                      <line x1={s.sx - 14} y1={s.sy} x2={s.sx + 14} y2={s.sy} stroke="#3b82f6" strokeWidth={1.5} />
                      <line x1={s.sx} y1={s.sy - 14} x2={s.sx} y2={s.sy + 14} stroke="#3b82f6" strokeWidth={1.5} />
                      <circle cx={s.sx} cy={s.sy} r={6} fill="#3b82f6" fillOpacity={0.3} stroke="#3b82f6" strokeWidth={1} />
                      {showSnap && snapScr && (
                        <circle cx={snapScr.sx} cy={snapScr.sy} r={8} fill="none" stroke="#22c55e" strokeWidth={1.2} strokeDasharray="3 2" />
                      )}
                    </g>
                  );
                })()}
                {wallStart && (() => {
                  const s = bimToScreen(wallStart.x, wallStart.y);
                  if (!s) return null;
                  return <circle cx={s.sx} cy={s.sy} r={6} fill="#22c55e" fillOpacity={0.7} stroke="#22c55e" strokeWidth={1.5} />;
                })()}
                {wallStart && hoverRaw && (() => {
                  const ss = bimToScreen(wallStart.x, wallStart.y);
                  const he = hoverSnap && Math.hypot(hoverSnap.x - hoverRaw.x, hoverSnap.y - hoverRaw.y) > 1
                    ? bimToScreen(hoverSnap.x, hoverSnap.y)
                    : bimToScreen(hoverRaw.x, hoverRaw.y);
                  if (!ss || !he) return null;
                  return <line x1={ss.sx} y1={ss.sy} x2={he.sx} y2={he.sy} stroke="#3b82f6" strokeWidth={2} strokeDasharray="8 4" />;
                })()}
              </svg>
            </div>
          )}

          <div className="absolute top-2 left-2 z-10 flex items-center gap-1">
            <RenderModeSelector
              mode={renderMode}
              onChange={setRenderMode}
              className="relative !top-0 !left-0 !absolute-none"
            />
            <button
              onClick={() => setShowSymbolPanel((p) => !p)}
              className={cn(
                'px-2 py-0.5 text-xs rounded border select-none transition-colors',
                showSymbolPanel
                  ? 'bg-blue-600 text-white border-blue-700'
                  : 'bg-white/90 text-gray-700 border-gray-200 hover:bg-gray-100',
              )}
              title="Configure plan symbol display"
            >
              ⚙ Symbols
            </button>
            <button
              onClick={() => setShowWindowConfigurator((p) => !p)}
              className={cn(
                'px-2 py-0.5 text-xs rounded border select-none transition-colors',
                showWindowConfigurator
                  ? 'bg-indigo-600 text-white border-indigo-700'
                  : 'bg-white/90 text-gray-700 border-gray-200 hover:bg-gray-100',
              )}
              title="Window symbol configurator"
            >
              🪟 Windows
            </button>
            <button
              onClick={() => { setDrawWallMode(!drawWallMode); setWallStart(null); setHoverSnap(null); setHoverRaw(null); }}
              className={cn(
                'px-2 py-0.5 text-xs rounded border select-none transition-colors',
                drawWallMode
                  ? 'bg-orange-500 text-white border-orange-600'
                  : 'bg-white/90 text-gray-700 border-gray-200 hover:bg-gray-100',
              )}
              title={drawWallMode ? 'Draw Wall active — click two snap points (ESC to cancel)' : 'Draw Wall — place walls by clicking snap points'}
            >
              ▭ Wall
            </button>
            {selectedNodeId && !drawWallMode && (
              <button
                onClick={deleteSelectedNode}
                className="px-2 py-0.5 text-xs rounded border select-none transition-colors bg-red-50 text-red-600 border-red-200 hover:bg-red-100"
                title="Delete selected element (Del)"
              >
                🗑 Delete
              </button>
            )}
            <AnnotationsToolbar
              activeTool={activeTool}
              onToolChange={setActiveTool}
              onClearAll={clearAll}
            />
          </div>
          {showSymbolPanel && (
            <div className="absolute top-10 left-2 z-20 bg-white border border-gray-300 rounded shadow-lg p-2 text-xs w-48 select-none">
              <div className="font-semibold text-gray-800 mb-1.5 text-[11px]">Plan Symbols</div>
              {([                ['showWhiteMask',   'White mask (openings)'],
                ['showWallBreaks',  'Wall break lines'],
                ['showShellBreaks', 'Shell break lines'],
                ['showCoveringBreaks', 'Covering break lines'],
                ['showWindowRect',  'Window symbol'],
                ['showWindowGlass', 'Window glass line'],
                ['showDoorPanel',   'Door panel line'],
                ['showDoorSwing',   'Door swing arc'],
              ] as [keyof typeof symbolConfig, string][]).map(([key, label]) => (
                <label key={key} className="flex items-center gap-1.5 py-0.5 cursor-pointer hover:bg-gray-50 rounded px-1">
                  <input
                    type="checkbox"
                    checked={symbolConfig[key]}
                    onChange={() => toggleSymbol(key)}
                    className="accent-blue-600 w-3 h-3"
                  />
                  <span className="text-gray-700">{label}</span>
                </label>
              ))}
            </div>
          )}
          <VisibilityFilter
            types={visibleTypes}
            hiddenTypes={hiddenTypes}
            onChange={setHiddenTypes}
            counts={typeCounts}
          />
          {/* Window symbol configurator modal */}
          {showWindowConfigurator && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/25">
              <WindowConfigurator onClose={() => setShowWindowConfigurator(false)} />
            </div>
          )}
          {/* Draw-wall status bar */}
          {drawWallMode && (
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded bg-black/75 text-[11px] font-mono text-orange-400 select-none">
              {wallStart ? 'Click 2nd snap point to place wall' : 'Click 1st snap point for wall start'} — ESC to cancel
            </div>
          )}
        </>
      )}
    </div>
  );
}
