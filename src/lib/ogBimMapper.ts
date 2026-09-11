/**
 * ogBimMapper.ts — BubbleGraph BIM nodes → OpenGeometry shapes.
 *
 * All OG shapes extend THREE.Mesh directly, so they can be added to any
 * Three.js scene without serialization.
 *
 * Phase 1: columns, beams, walls (solid only, no openings), slabs, rooms, foundations.
 * Phase 2: window/door opening booleans via Opening.subtractFrom(wallSolid).
 *
 * Coordinate system (same as Ara3DViewer / bimGeometryThree.ts):
 *   BIM X (East)  → Three/OG +X
 *   BIM Y (North) → Three/OG -Z  (negated)
 *   BIM Z (Up)    → Three/OG +Y
 *   All BIM values in mm; OG/Three scene in meters (multiply by MM = 0.001).
 */

import * as THREE from 'three';
import { Vector3, Cuboid, Polygon, Opening, executeBooleanSubtractionMany, booleanIntersection } from 'opengeometry';
import type { Solid, BooleanResult as OGBooleanResult } from 'opengeometry';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  MM, NODE_COLOR,
  parseColumnDims, parseSlabThickness, getNodeSlabThickness,
  getStoreyBand, getAxRealPos, getNodeBimPos,
  calcWallGeometry, calcWallJoins, calcShellPolygon, calcRoomPolygon,
  parseContourOffsets, insetPolygon, resolveStoreyId,
  getNodeLocalTransform,
} from '@/lib/bimGeometry';
import { expandArrayNodes } from '@/lib/formulaUtils';
import { yawForPlanDir, yawForPlanDirX } from '@/lib/geom/plan2d';
import { flightProfile, invertedTeeProfile } from '@/lib/stair/profile';
import { buildHelixGeometry } from '@/lib/stair/helixMesh';
import { computeSweep, sweepBufferGeometry } from '@/lib/sweep';
import { resolveVisuals, applyNodeColorOverrides, resolveWindowGlazing } from '@/lib/materialConfig';
import type { MaterialConfig } from '@/lib/materialConfig';
import { buildOpeningMeshes3, applyNodeLocalTransformThree } from '@/lib/bimGeometryThree';
import {
  resolveCoveringLayers, roomHasCovering, syntheticCoveringNodeForLayer,
} from '@/lib/roomCovering';
import { resolveWallLayers, syntheticWallNodeForLayer } from '@/lib/wallLayers';
import { renderBandsOf } from '@/lib/zones/heightZones';
import {
  computeFaceBasis, computeRoofFaces, orientPointsToward, parseTimberSection, placeDormer, placeSkylight,
  ROOF_LINEAR_DETAIL_TYPES, ROOF_ROUND_DETAIL_TYPES, ROOF_SHEET_DETAIL_TYPES,
  type DormerPlacement, type Pt3, type RoofFace3D, type SkylightPlacement, type WallPane,
} from '@/lib/roof';
import {
  attachHeightAlong, attachesToRoof, isTrimmed, nodesCuttingRoof, planeZ, roofTrim, roofTrimsNode,
  trimmedTopAlong, type RoofTrim, type TrimPlane,
} from '@/lib/roof/trim';
import { gableFootprintMm, gableMaterial, gableSpec, wallThicknessMm } from '@/lib/roof/gable';
import { computeWallFraming, placeMember } from '@/lib/framing/wallFraming';
import { computeCltPanels, isCltWallType } from '@/lib/framing/cltPanels';
import { cltInputForWall, framingInputForWall } from '@/lib/framing/framingInput';
import { classifyWallSides, type WallSide } from '@/lib/walls/wallSides';
import { UNIVERSAL_WALL_TYPES } from '@/lib/systems/profiles';
import { resolveStructuralSystem } from '@/lib/systems/structuralSystem';
import { getTakeoffContext } from '@/lib/quantityTakeoff/takeoffContext';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** NODE_COLOR [r,g,b] float tuple → hex number for OG color props. */
function nodeHex(type: string): number {
  const [r, g, b] = NODE_COLOR[type] ?? [0.5, 0.5, 0.5];
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

/**
 * Override the material of an OG mesh with matConfig-resolved visuals.
 * OG always creates MeshStandardMaterial in generateGeometry() — we just
 * overwrite color/opacity so it stays in sync with the material configurator.
 */
function applyMat(
  mesh: THREE.Mesh,
  type: string,
  node: BubbleGraphNode | null,
  matConfig: MaterialConfig | null,
  alphaOverride?: number,
): void {
  const baseVis = resolveVisuals(type, String(node?.properties?.material ?? ''), matConfig);
  const vis = node ? applyNodeColorOverrides(baseVis, node.properties) : baseVis;
  const opacity = alphaOverride !== undefined ? vis.opacity_3d * alphaOverride : vis.opacity_3d;
  const applyOrReplace = (m: THREE.Material, idx?: number) => {
    if (m instanceof THREE.MeshStandardMaterial) {
      m.color.set(vis.color_3d);
      m.opacity      = opacity;
      m.transparent  = opacity < 1;
      m.needsUpdate  = true;
    } else {
      // Default material (e.g. MeshBasicMaterial on plain THREE.Mesh) — replace with Standard
      const std = new THREE.MeshStandardMaterial({
        color: vis.color_3d,
        opacity,
        transparent: opacity < 1,
      });
      if (idx !== undefined && Array.isArray(mesh.material)) {
        (mesh.material as THREE.Material[])[idx] = std;
      } else {
        mesh.material = std;
      }
    }
  };
  const mat = mesh.material;
  Array.isArray(mat) ? mat.forEach((m, i) => applyOrReplace(m, i)) : applyOrReplace(mat);
}

/**
 * OG Vector3 from BIM mm coordinates.
 *   bimX → Three/OG +X,  bimY → Three/OG -Z,  bimZ → Three/OG +Y
 */
function v3(bimX: number, bimY: number, bimZ: number): Vector3 {
  return new Vector3(bimX * MM, bimZ * MM, -bimY * MM);
}

/** OG Vector3 for a plan point in XZ at Y=0 (for Polygon profile vertices). */
function planV3(bimX: number, bimY: number): Vector3 {
  return new Vector3(bimX * MM, 0, -bimY * MM);
}

/**
 * Tag a Three.js mesh for visibility filtering and selection raycasting.
 */
function tag(mesh: THREE.Mesh, nodeType: string, nodeId?: string, storeyId?: string): void {
  mesh.castShadow    = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeType = nodeType;
  if (nodeId)   mesh.userData.nodeId   = nodeId;
  if (storeyId) mesh.userData.storeyId = storeyId;
}

/**
 * Extrude a BIM-space polygon (array of { x, y } mm points) into an OG Solid
 * and add it to the scene at the specified base elevation.
 *
 * @param poly      XY plan points in BIM mm (CCW wound when viewed from above).
 * @param height    Extrusion height in METERS.
 * @param baseElevM Base elevation in METERS (bottom of the extruded solid).
 * @param color     OG hex color.
 * @returns         The extruded THREE.Mesh (an OG Solid), or null on failure.
 */
function extrudePolygon(
  poly: { x: number; y: number }[],
  height: number,
  baseElevM: number,
  color: number,
): THREE.Mesh | null {
  if (poly.length < 3 || height <= 0) return null;
  try {
    const polygon = new Polygon({
      vertices: poly.map((p) => planV3(p.x, p.y)),
      color,
    });
    const solid = polygon.extrude(height);
    solid.setTranslation(new Vector3(0, baseElevM, 0));
    return solid as unknown as THREE.Mesh;
  } catch (err) {
    console.warn('[ogBimMapper] extrudePolygon failed:', err);
    return null;
  }
}

/**
 * The node a roof FACE should be styled from.
 *
 * A roof carries two materials: `material` is the framing (timber), while
 * `covering_material` is what you actually see from outside — tiles, sheet,
 * membrane. The visible surface must follow the covering, so it wins here and
 * `material` only stands in when no covering is named.
 *
 * Returning a synthetic node rather than a bare material id keeps the per-node
 * `color_3d` / `color_2d` overrides working, since applyMat reads them off the
 * node it is given.
 */
function roofSurfaceNode(n: BubbleGraphNode): BubbleGraphNode {
  const covering = String(n.properties.covering_material ?? '').trim();
  if (!covering) return n;
  return { ...n, properties: { ...n.properties, material: covering } };
}

/** Pitched roof face from BIM mm 3D vertices (fan triangulation). */
function pitchedFaceMesh(face: RoofFace3D): THREE.Mesh | null {
  const verts = face.vertices;
  if (verts.length < 3) return null;
  const positions: number[] = [];
  for (const v of verts) {
    positions.push(v.x * MM, v.z * MM, -v.y * MM);
  }
  const indices: number[] = [];
  for (let i = 1; i < verts.length - 1; i++) {
    indices.push(0, i, i + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, flatShading: true }),
  );
}

/**
 * Extruded SOLID slab for a pitched roof face — same triangulated footprint as
 * `pitchedFaceMesh`, but as a boolean-ready `Solid` (`Polygon.extrude`) so a
 * skylight can be cut into it. Only built for faces that actually host a
 * skylight; every other face keeps the cheap flat `pitchedFaceMesh` fast path.
 *
 * No rotation is used anywhere in this file's roof-cutting code: `face.vertices`
 * (and every cutter below) are passed as already-WORLD-SPACE 3D points, and
 * `Polygon.extrude()` extrudes along the polygon's OWN plane normal (confirmed
 * against the wall-solid code above, which extrudes a Y=0 footprint upward by
 * leaving rotation at identity) — so the extrude direction falls out of vertex
 * winding alone, with no dependency on the WASM kernel's Euler-angle convention.
 */
function pitchedFaceSolid(face: RoofFace3D, thicknessM: number): Solid | null {
  if (face.vertices.length < 3) return null;
  try {
    const basis = computeFaceBasis(face);
    const oriented = basis ? orientPointsToward(face.vertices, basis.n) : face.vertices;
    const corners = oriented.map((v) => new Vector3(v.x * MM, v.z * MM, -v.y * MM));
    const polygon = new Polygon({ vertices: corners, color: 0xffffff });
    return polygon.extrude(thicknessM);
  } catch (err) {
    console.warn('[ogBimMapper] pitchedFaceSolid failed:', err);
    return null;
  }
}

/**
 * Boolean cutter for one skylight opening: the opening rectangle (already ON
 * the roof plane — see `placeSkylight`), pushed `pad` back along the face's
 * inward normal and extruded through the slab plus `pad` again on the far
 * side, so the cut always fully spans the covering regardless of small
 * placement/thickness rounding. `pad` follows OG's documented overshoot
 * guidance for through-cuts: `max(hostThickness * 0.05, 0.01)` model units.
 */
function skylightCutterSolid(placement: SkylightPlacement, hostThicknessM: number): Solid | null {
  const { corners, basis } = placement;
  if (corners.length < 3) return null;
  const padM = Math.max(hostThicknessM * 0.05, 0.01);
  const padMm = padM * 1000;
  try {
    const basePts = corners.map((c) => ({
      x: c.x - basis.n.x * padMm,
      y: c.y - basis.n.y * padMm,
      z: c.z - basis.n.z * padMm,
    }));
    const oriented = orientPointsToward(basePts, basis.n);
    const baseCorners = oriented.map((c) => new Vector3(c.x * MM, c.z * MM, -c.y * MM));
    const polygon = new Polygon({ vertices: baseCorners, color: 0xffffff });
    return polygon.extrude(hostThicknessM + 2 * padM);
  } catch (err) {
    console.warn('[ogBimMapper] skylightCutterSolid failed:', err);
    return null;
  }
}

/** Flat glazing pane for a skylight, raised by the curb height above the roof surface. */
function skylightGlazingMesh(placement: SkylightPlacement, curbHeightMm: number): THREE.Mesh | null {
  const { corners, basis } = placement;
  if (corners.length < 3) return null;
  const positions: number[] = [];
  for (const c of corners) {
    const gx = c.x + basis.n.x * curbHeightMm;
    const gy = c.y + basis.n.y * curbHeightMm;
    const gz = c.z + basis.n.z * curbHeightMm;
    positions.push(gx * MM, gz * MM, -gy * MM);
  }
  const indices: number[] = [];
  for (let i = 1; i < corners.length - 1; i++) indices.push(0, i, i + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, flatShading: true, transparent: true, opacity: 0.55 }),
  );
}

/**
 * Vertical notch cutter for a dormer: the flat plan footprint (world XY),
 * extruded straight up (world Z) from `fromZ` to `toZ` — same proven pattern
 * as wall solids (flat horizontal footprint, vertical extrude, translate into
 * place after), so no new extrude-direction risk versus what's already used
 * for every wall in this file.
 */
function dormerNotchSolid(footprint: Pt3[], fromZ: number, toZ: number): Solid | null {
  if (footprint.length < 3 || toZ <= fromZ) return null;
  try {
    const corners = footprint.map((p) => new Vector3(p.x * MM, 0, -p.y * MM));
    const polygon = new Polygon({ vertices: corners, color: 0xffffff });
    const solid = polygon.extrude((toZ - fromZ) * MM);
    solid.setTranslation(new Vector3(0, fromZ * MM, 0));
    return solid;
  } catch (err) {
    console.warn('[ogBimMapper] dormerNotchSolid failed:', err);
    return null;
  }
}

/** A rectangular column's plan outline in BIM mm, from its centre and section (metres). */
const columnFootprintMm = (pos: { x: number; y: number }, w: number, d: number) => {
  const hw = w * 1000 / 2, hd = d * 1000 / 2;
  return [
    { x: pos.x - hw, y: pos.y - hd }, { x: pos.x + hw, y: pos.y - hd },
    { x: pos.x + hw, y: pos.y + hd }, { x: pos.x - hw, y: pos.y + hd },
  ];
};

/**
 * The plan outline (BIM mm) a node punches through a roof when its
 * `trim_priority` outranks it — a chimney, a shaft, a stair tower. Only shapes
 * whose footprint is unambiguous qualify; anything else declines rather than
 * guessing a hole.
 */
function roofPunchFootprint(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  wallJoins: ReturnType<typeof calcWallJoins>,
): Array<{ x: number; y: number }> | null {
  if (node.type === 'wall') return calcWallGeometry(node, nodeMap, edges, wallJoins)?.footprint ?? null;
  if (node.type === 'column') {
    const p = getNodeBimPos(node, nodeMap);
    const d = parseColumnDims(String(node.properties.column_type ?? 'C30x30'));
    return columnFootprintMm(p, d.w, d.d);
  }
  return null;
}

/**
 * Everything above ONE roof slope, as a boolean cutter: the volume between that
 * face and the sky, bounded to the face's own plan footprint.
 *
 * Built as an intersection rather than a single sweep on purpose. `Polygon
 * .extrude()` always extrudes along the polygon's own normal, so sweeping a
 * pitched face "upward" also drags it sideways — on a 30° roof, metres of drift
 * over a few metres of rise, which would cut the wrong walls. Intersecting a
 * VERTICAL prism over the footprint with a half-space above the plane gives the
 * exact wedge: the prism fixes the plan extent, the half-space fixes the cut
 * surface. The half-space rectangle is deliberately huge so the same drift
 * cannot pull it out from under the prism.
 */
function roofTrimWedge(plane: TrimPlane, ceilingMm: number): OGBooleanResult | null {
  try {
    const { minX, minY, maxX, maxY } = plane.bbox;
    const floorMm = plane.minZ - 10000;
    const prism = dormerNotchSolid(
      plane.footprint.map((p) => ({ x: p.x, y: p.y, z: 0 })), floorMm, ceilingMm);
    if (!prism) return null;

    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const R = 3 * Math.hypot(maxX - minX, maxY - minY) + 10000;
    const quad = [
      { x: cx - R, y: cy - R }, { x: cx + R, y: cy - R },
      { x: cx + R, y: cy + R }, { x: cx - R, y: cy + R },
    ].map((p) => ({ ...p, z: planeZ(plane, p.x, p.y) }));
    const oriented = orientPointsToward(quad, { x: 0, y: 0, z: 1 });
    const half = new Polygon({
      vertices: oriented.map((p) => new Vector3(p.x * MM, p.z * MM, -p.y * MM)),
      color: 0xffffff,
    // The sweep covers `h / nz` of vertical rise, so `h` alone always suffices.
    }).extrude((ceilingMm - plane.minZ + 20000) * MM);

    return booleanIntersection(prism, half, { kernel: { mergeCoplanarFaces: true, tolerance: undefined } });
  } catch (err) {
    console.warn('[ogBimMapper] roofTrimWedge failed:', err);
    return null;
  }
}

/** One dormer wall pane (front or a cheek), extruded by `thicknessMm` toward `outward`. */
function wallPaneSolid(pane: WallPane, thicknessMm: number, outward: Pt3): Solid | null {
  if (thicknessMm <= 0) return null;
  try {
    const oriented = orientPointsToward(pane.corners, outward);
    const corners = oriented.map((p) => new Vector3(p.x * MM, p.z * MM, -p.y * MM));
    const polygon = new Polygon({ vertices: corners, color: 0xffffff });
    return polygon.extrude(thicknessMm * MM);
  } catch (err) {
    console.warn('[ogBimMapper] wallPaneSolid failed:', err);
    return null;
  }
}

/** Flat mesh for one dormer wall pane (visual fallback / always rendered alongside the solid). */
function wallPaneMesh(pane: WallPane): THREE.Mesh | null {
  const positions: number[] = [];
  for (const c of pane.corners) positions.push(c.x * MM, c.z * MM, -c.y * MM);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, flatShading: true }));
}

/** Timber member from ax..bz properties (BIM mm) → box mesh in OG/Three space. */
function timberMemberMesh(n: BubbleGraphNode): THREE.Mesh | null {
  const ax = Number(n.properties.ax);
  const ay = Number(n.properties.ay);
  const az = Number(n.properties.az);
  const bx = Number(n.properties.bx);
  const by = Number(n.properties.by);
  const bz = Number(n.properties.bz);
  if (![ax, ay, az, bx, by, bz].every(Number.isFinite)) return null;

  const a = new THREE.Vector3(ax * MM, az * MM, -ay * MM);
  const b = new THREE.Vector3(bx * MM, bz * MM, -by * MM);
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-4) return null;

  const { w, h } = parseTimberSection(String(n.properties.section ?? 'T8x16'));
  const geo = new THREE.BoxGeometry(w, h, len);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.55 }),
  );
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  mesh.position.copy(mid);
  // Align local +Z with member axis
  const quat = new THREE.Quaternion();
  quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
  mesh.quaternion.copy(quat);
  return mesh;
}

/**
 * Box aligned to an explicit horizontal direction, rather than to the minimal
 * rotation from +Z.
 *
 * Stair parts need this: a tread must stay level and square to its flight no
 * matter how the flight is angled in plan, and the shortest rotation onto a
 * sloping axis would roll it. Local axes are (width across, height up, depth
 * along `dir`).
 */
function orientedBox(
  centreMm: { x: number; y: number; z: number },
  dirPlan: { x: number; y: number },
  widthMm: number,
  heightMm: number,
  depthMm: number,
): THREE.Mesh | null {
  if (!(widthMm > 0 && heightMm > 0 && depthMm > 0)) return null;
  const len = Math.hypot(dirPlan.x, dirPlan.y);
  if (len < 1e-9) return null;

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(widthMm * MM, heightMm * MM, depthMm * MM),
    new THREE.MeshStandardMaterial({ roughness: 0.7 }),
  );
  mesh.position.copy(v3(centreMm.x, centreMm.y, centreMm.z));
  mesh.rotation.y = yawForPlanDir(dirPlan.x, dirPlan.y);
  return mesh;
}

/**
 * A flight as a stepped solid: the sawtooth of risers and treads over a sloping
 * waist, the way Revit and ArchiCAD draw a stair at every detail level. The
 * cross-section comes from `flightProfile` and is extruded across the width,
 * centred on the walking line.
 */
function stairFlightMesh(n: BubbleGraphNode): THREE.Mesh | null {
  const p = n.properties;
  const a = { x: Number(p.ax), y: Number(p.ay), z: Number(p.az) };
  const b = { x: Number(p.bx), y: Number(p.by), z: Number(p.bz) };
  if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return null;

  const steps = Math.max(1, Math.round(Number(p.steps ?? 1)));
  const widthMm = Number(p.width_mm ?? 1000);
  const riserMm = Number(p.riser_mm ?? 170);
  const treadMm = Number(p.tread_mm ?? 280);
  const thickMm = Number(p.thickness_mm ?? 150);

  const runMm = Math.hypot(b.x - a.x, b.y - a.y);
  const dir = runMm > 1e-6
    ? { x: (b.x - a.x) / runMm, y: (b.y - a.y) / runMm }
    : { x: 1, y: 0 };

  const profile = flightProfile(steps, riserMm, treadMm, thickMm, {
    footDropMm: Number(p.foot_drop_mm ?? 0),
    headDropMm: Number(p.head_drop_mm ?? thickMm),
    ...(p.tail_mm != null ? { tailMm: Number(p.tail_mm) } : {}),
  });
  if (!profile) {
    // A single riser has no run to extrude along — draw it as the block it is.
    return orientedBox({ x: a.x, y: a.y, z: a.z + riserMm / 2 }, dir, widthMm, riserMm, Math.max(treadMm, 10));
  }

  const shape = new THREE.Shape();
  shape.moveTo(profile[0].x * MM, profile[0].y * MM);
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i].x * MM, profile[i].y * MM);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: widthMm * MM, bevelEnabled: false });
  geo.translate(0, 0, -widthMm * MM / 2); // centre the width on the walking line
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.7 }));
  // The profile's s-axis is the mesh's local +X; point it up the run.
  mesh.position.copy(v3(a.x, a.y, a.z));
  mesh.rotation.y = yawForPlanDirX(dir.x, dir.y);
  return mesh;
}

/**
 * The foundation beam at the flight's base: the inverted-T section from
 * `invertedTeeProfile`, extruded across the flight width, its web topping out
 * at floor level under the first riser.
 */
function stairBaseBeamMesh(n: BubbleGraphNode): THREE.Mesh | null {
  const p = n.properties;
  const a = { x: Number(p.ax), y: Number(p.ay), z: Number(p.az) };
  if (![a.x, a.y, a.z].every(Number.isFinite)) return null;

  const profile = invertedTeeProfile(
    Number(p.web_mm ?? 300),
    Number(p.flange_mm ?? 600),
    Number(p.flange_h_mm ?? 150),
    Number(p.depth_mm ?? 400),
  );
  if (!profile) return null;

  const widthMm = Number(p.width_mm ?? 1000);
  const dir = { x: Number(p.dir_x ?? 1), y: Number(p.dir_y ?? 0) };

  const shape = new THREE.Shape();
  shape.moveTo(profile[0].x * MM, profile[0].y * MM);
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i].x * MM, profile[i].y * MM);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: widthMm * MM, bevelEnabled: false });
  geo.translate(0, 0, -widthMm * MM / 2);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.8 }));
  mesh.position.copy(v3(a.x, a.y, a.z));
  mesh.rotation.y = yawForPlanDirX(dir.x, dir.y);
  return mesh;
}

/**
 * The pre-stepped rendering of a flight — the plain sloping waist. Kept for the
 * `steps` detail level, where the sawtooth is built from real `stair_tread`
 * nodes sitting on this slab; drawing the stepped solid underneath them too
 * would duplicate every step's geometry in place.
 */
function stairWaistMesh(n: BubbleGraphNode): THREE.Mesh | null {
  const p = n.properties;
  const a = { x: Number(p.ax), y: Number(p.ay), z: Number(p.az) };
  const b = { x: Number(p.bx), y: Number(p.by), z: Number(p.bz) };
  if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return null;

  const runMm = Math.hypot(b.x - a.x, b.y - a.y);
  const riseMm = b.z - a.z;
  const slopeLenMm = Math.hypot(runMm, riseMm);
  if (slopeLenMm < 1) return null;

  const widthMm = Number(p.width_mm ?? 1000);
  const thickMm = Number(p.thickness_mm ?? 150);
  const dir = runMm > 1e-6
    ? { x: (b.x - a.x) / runMm, y: (b.y - a.y) / runMm }
    : { x: 1, y: 0 };

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(widthMm * MM, thickMm * MM, slopeLenMm * MM),
    new THREE.MeshStandardMaterial({ roughness: 0.7 }),
  );
  // Sit the slab's top face on the walking line, then tilt it up the slope.
  // The drop is along the slab's own normal, not straight down: a waist is
  // measured perpendicular to the flight, and dropping vertically would sink the
  // walking surface further the steeper the stair gets.
  const midMm = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  const half = thickMm / 2;
  const nx = (-riseMm * dir.x) / slopeLenMm;
  const ny = (-riseMm * dir.y) / slopeLenMm;
  const nz = runMm / slopeLenMm;
  mesh.position.copy(v3(midMm.x - nx * half, midMm.y - ny * half, midMm.z - nz * half));
  mesh.rotation.order = 'YXZ';
  mesh.rotation.y = yawForPlanDir(dir.x, dir.y);
  mesh.rotation.x = -Math.atan2(riseMm, runMm);
  return mesh;
}

/**
 * A railing as a handrail with posts, not a floating line.
 *
 * The node's a→b axis runs along the flight EDGE at walking-surface level;
 * `rail_height_mm` lifts the handrail above it and the posts span the gap. A
 * legacy node without that property carries its axis already at rail height, so
 * it falls back to the single-member rendering it was built for.
 */
function stairRailingMeshes(n: BubbleGraphNode): THREE.Mesh[] {
  const p = n.properties;
  if (p.rail_height_mm == null) {
    const legacy = timberMemberMesh(n);
    return legacy ? [legacy] : [];
  }

  const a = { x: Number(p.ax), y: Number(p.ay), z: Number(p.az) };
  const b = { x: Number(p.bx), y: Number(p.by), z: Number(p.bz) };
  if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return [];
  const railH = Number(p.rail_height_mm);
  if (!(railH > 0)) return [];

  const meshes: THREE.Mesh[] = [];

  // Handrail: a 60×50 section following the slope at rail height.
  const top0 = v3(a.x, a.y, a.z + railH);
  const top1 = v3(b.x, b.y, b.z + railH);
  const along = new THREE.Vector3().subVectors(top1, top0);
  const len = along.length();
  if (len < 1e-4) return [];
  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.05, len),
    new THREE.MeshStandardMaterial({ roughness: 0.4 }),
  );
  rail.position.copy(new THREE.Vector3().addVectors(top0, top1).multiplyScalar(0.5));
  rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), along.clone().normalize());
  meshes.push(rail);

  // Posts: verticals from the walking surface up to the rail, one per ~1100 mm.
  const posts = Math.max(2, Math.ceil(len / 1.1) + 1);
  for (let i = 0; i < posts; i++) {
    const u = i / (posts - 1);
    const x = a.x + (b.x - a.x) * u;
    const y = a.y + (b.y - a.y) * u;
    const z = a.z + (b.z - a.z) * u;
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, railH * MM, 0.04),
      new THREE.MeshStandardMaterial({ roughness: 0.4 }),
    );
    post.position.copy(v3(x, y, z + railH / 2));
    meshes.push(post);
  }
  return meshes;
}

/**
 * One step as a solid block from its tread down to the step below — the way a
 * cast stair actually reads, rather than a floating plate.
 */
function stairTreadMesh(n: BubbleGraphNode): THREE.Mesh | null {
  const p = n.properties;
  const widthMm = Number(p.width_mm ?? 1000);
  const treadMm = Number(p.tread_mm ?? 280);
  const riserMm = Number(p.riser_mm ?? 170);
  const dir = { x: Number(p.dir_x ?? 1), y: Number(p.dir_y ?? 0) };
  if (![widthMm, treadMm, riserMm].every(Number.isFinite)) return null;

  // n.z is the walking surface; the block fills the riser beneath it.
  return orientedBox(
    { x: n.x, y: n.y, z: n.z - riserMm / 2 },
    dir, widthMm, riserMm, treadMm,
  );
}

/** Round member (gutter / downpipe) from ax..bz + diameter_mm → cylinder mesh. */
function roundMemberMesh(n: BubbleGraphNode): THREE.Mesh | null {
  const ax = Number(n.properties.ax), ay = Number(n.properties.ay), az = Number(n.properties.az);
  const bx = Number(n.properties.bx), by = Number(n.properties.by), bz = Number(n.properties.bz);
  if (![ax, ay, az, bx, by, bz].every(Number.isFinite)) return null;
  const a = new THREE.Vector3(ax * MM, az * MM, -ay * MM);
  const b = new THREE.Vector3(bx * MM, bz * MM, -by * MM);
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-4) return null;
  const r = Math.max(0.01, Number(n.properties.diameter_mm ?? 100) * MM / 2);
  const geo = new THREE.CylinderGeometry(r, r, len, 14);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.5, metalness: 0.3 }));
  mesh.position.copy(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
  // Cylinder's local axis is +Y → align it with the member direction.
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return mesh;
}

/** Planar detail sheet (membrane / sheathing / insulation / soffit / flashing) from face_vertices. */
function detailSheetMesh(n: BubbleGraphNode): THREE.Mesh | null {
  let verts: { x: number; y: number; z: number }[];
  try { verts = JSON.parse(String(n.properties.face_vertices ?? '[]')); } catch { return null; }
  if (!Array.isArray(verts) || verts.length < 3) return null;
  const positions: number[] = [];
  for (const v of verts) positions.push(v.x * MM, v.z * MM, -v.y * MM);
  const indices: number[] = [];
  for (let i = 1; i < verts.length - 1; i++) indices.push(0, i, i + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, flatShading: true }));
}

// ─── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build all OG shapes for the BIM model and add them to the Three.js scene.
 * Must be called AFTER `ensureOpenGeoReady()` has resolved.
 */
export interface OGSceneOptions {
  /**
   * Draw every wall as what it is BUILT of — studs, plates, headers and the
   * sheathing layers for timber framing; panel joints for CLT — instead of a
   * plain solid. A per-wall `show_framing = True` does the same for one wall.
   */
  structureView?: boolean;
}

export function buildOGScene(
  scene: THREE.Scene,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null = null,
  opts: OGSceneOptions = {},
): void {
  nodes = expandArrayNodes(nodes);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  // Wall sides (exterior ring) — only the structure view needs them, and only once.
  let wallSides: Map<string, WallSide> | null = null;
  const sideOf = (id: string): WallSide | undefined => {
    if (!wallSides) wallSides = classifyWallSides(nodes, edges);
    return wallSides.get(id);
  };
  // Centroid of a storey's anchors, to tell which face of an exterior wall looks out.
  const centroidCache = new Map<string, { x: number; y: number }>();
  const storeyCentroid = (storeyId: string | undefined): { x: number; y: number } => {
    const key = storeyId ?? '';
    const hit = centroidCache.get(key);
    if (hit) return hit;
    let sx = 0, sy = 0, k = 0;
    for (const a of nodes) {
      if (a.type !== 'ax' || (a.parentId ?? undefined) !== storeyId) continue;
      const p = getNodeBimPos(a, nodeMap);
      sx += p.x; sy += p.y; k++;
    }
    const c = k ? { x: sx / k, y: sy / k } : { x: 0, y: 0 };
    centroidCache.set(key, c);
    return c;
  };

  // Openings from all walls, stored with their world-space vertical centre (metres).
  // Used by applyOpeningCuts() to punch holes in same-storey ring solids.
  const allOgOpenings: { opening: Opening; centerY: number }[] = [];

  // ── Roof trim: the planes every roof imposes on what stands under it ───────
  const roofFaceCache = new Map<string, RoofFace3D[]>();
  const roofFacesOf = (rn: BubbleGraphNode): RoofFace3D[] => {
    let f = roofFaceCache.get(rn.id);
    if (!f) { f = computeRoofFaces(rn, nodes, edges).faces; roofFaceCache.set(rn.id, f); }
    return f;
  };
  const roofTrims: RoofTrim[] = [];
  for (const rn of nodes) {
    if (rn.type !== 'roof') continue;
    const t = roofTrim(rn, roofFacesOf(rn));
    if (t) roofTrims.push(t);
  }
  // Headroom above the tallest roof — a wedge must reach past whatever it cuts.
  const trimCeilingMm = roofTrims.length
    ? Math.max(...roofTrims.flatMap((t) => t.planes.map((p) => p.maxZ))) + 30000
    : 0;
  const wedgeCache = new Map<string, OGBooleanResult[]>();
  const roofWedges = (t: RoofTrim): OGBooleanResult[] => {
    const hit = wedgeCache.get(t.roof.id);
    if (hit) return hit;
    const built = t.planes
      .map((p) => roofTrimWedge(p, trimCeilingMm))
      .filter((w): w is OGBooleanResult => !!w);
    wedgeCache.set(t.roof.id, built);
    return built;
  };


  // ── Columns ─────────────────────────────────────────────────────────────────

  // Standalone column nodes
  for (const n of nodes.filter((n) => n.type === 'column')) {
    const { bot, top } = getStoreyBand(n, nodeMap);
    const height = (top - bot) * MM;
    const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
    const pos = getNodeBimPos(n, nodeMap);
    const ltr = getNodeLocalTransform(n);
    try {
      if (circular) {
        // Plain THREE.Mesh — use position for transform (no OG regeneration risk)
        const cylGeo = new THREE.CylinderGeometry(w / 2, w / 2, height, 18);
        const mesh = new THREE.Mesh(cylGeo);
        mesh.position.set(pos.x * MM, (bot + (top - bot) / 2) * MM, -pos.y * MM);
        applyNodeLocalTransformThree(mesh, ltr);
        tag(mesh, 'column', n.id, resolveStoreyId(n, nodeMap));
        applyMat(mesh as unknown as THREE.Mesh, 'column', n, matConfig);
        scene.add(mesh);
      } else {
        // A roof above cuts the column back, and can raise it first when the
        // column is set to attach. Round columns are plain Three meshes with no
        // boolean path, so they stay untrimmed.
        const fp = columnFootprintMm(pos, w, d);
        const trims = roofTrims.filter((t) => roofTrimsNode(t, n, fp));
        let colTop = top;
        if (trims.length > 0 && attachesToRoof(n)) {
          const reach = attachHeightAlong(trims.flatMap((t) => t.planes), fp[0], fp[2]);
          if (reach != null && reach > colTop) colTop = reach;
        }
        const colH = (colTop - bot) * MM;

        // OG Cuboid — bake translation into center (OG rebakes vertices, mesh.position stays 0)
        const cuboid = new Cuboid({
          center: v3(pos.x + ltr.tx, pos.y + ltr.ty, bot + (colTop - bot) / 2 + ltr.tz),
          width:  w,
          height: colH,
          depth:  d,
          color:  nodeHex('column'),
        });
        const wedges = trims.flatMap(roofWedges);
        let mesh = cuboid as unknown as THREE.Mesh;
        if (wedges.length > 0) {
          try {
            mesh = executeBooleanSubtractionMany(cuboid, wedges, {
              kernel: { mergeCoplanarFaces: true, tolerance: undefined },
            }) as unknown as THREE.Mesh;
          } catch (cutErr) {
            console.warn('[ogBimMapper] column roof trim failed, using the full column:', cutErr);
          }
        }
        tag(mesh, 'column', n.id, resolveStoreyId(n, nodeMap));
        applyMat(mesh, 'column', n, matConfig);
        scene.add(mesh as unknown as THREE.Object3D);
      }
    } catch (err) {
      console.warn('[ogBimMapper] column failed:', err);
    }
  }

  // Ax nodes with has_column=true
  for (const n of nodes.filter(
    (n) => n.type === 'ax' && String(n.properties.has_column ?? '').toLowerCase() === 'true',
  )) {
    const { bot, top } = getStoreyBand(n, nodeMap);
    const height = (top - bot) * MM;
    const colType = String(n.properties.column_type ?? 'C25x25');
    const { w, d, circular } = parseColumnDims(colType);
    const pos = getAxRealPos(n, nodeMap);
    const ltrAx = getNodeLocalTransform(n);
    try {
      if (circular) {
        const cylGeo = new THREE.CylinderGeometry(w / 2, w / 2, height, 18);
        const mesh = new THREE.Mesh(cylGeo);
        mesh.position.set(pos.x * MM, (bot + (top - bot) / 2) * MM, -pos.y * MM);
        applyNodeLocalTransformThree(mesh, ltrAx);
        tag(mesh, 'column', n.id, resolveStoreyId(n, nodeMap));
        applyMat(mesh as unknown as THREE.Mesh, 'column', n, matConfig);
        scene.add(mesh);
      } else {
        // Same roof trim as a standalone column — these are the ones that
        // actually stand in an attic, on the grid points under the slopes.
        const fp = columnFootprintMm(pos, w, d);
        const trims = roofTrims.filter((t) => roofTrimsNode(t, n, fp));
        let colTop = top;
        if (trims.length > 0 && attachesToRoof(n)) {
          const reach = attachHeightAlong(trims.flatMap((t) => t.planes), fp[0], fp[2]);
          if (reach != null && reach > colTop) colTop = reach;
        }
        const cuboid = new Cuboid({
          center: v3(pos.x + ltrAx.tx, pos.y + ltrAx.ty, bot + (colTop - bot) / 2 + ltrAx.tz),
          width:  w,
          height: (colTop - bot) * MM,
          depth:  d,
          color:  nodeHex('column'),
        });
        const wedges = trims.flatMap(roofWedges);
        let mesh = cuboid as unknown as THREE.Mesh;
        if (wedges.length > 0) {
          try {
            mesh = executeBooleanSubtractionMany(cuboid, wedges, {
              kernel: { mergeCoplanarFaces: true, tolerance: undefined },
            }) as unknown as THREE.Mesh;
          } catch (cutErr) {
            console.warn('[ogBimMapper] ax-column roof trim failed, using the full column:', cutErr);
          }
        }
        tag(mesh, 'column', n.id, resolveStoreyId(n, nodeMap));
        applyMat(mesh, 'column', n, matConfig);
        scene.add(mesh as unknown as THREE.Object3D);
      }
    } catch (err) {
      console.warn('[ogBimMapper] ax-column failed:', err);
    }
  }

  // ── Walls (solid + OG boolean cuts for windows/doors) ─────────────────────
  //
  // Phase 2 approach:
  //   1. Build full wall solid as one Polygon.extrude (no per-segment splits)
  //   2. Create OG Opening objects for each window/door in the wall
  //   3. Apply executeBooleanSubtractionMany(wallSolid, openings) → BooleanResult
  //   4. Render window/door frame+glass meshes via buildOpeningMeshes3()

  const glazingCfg = resolveWindowGlazing(matConfig);

  for (const n of nodes.filter((n) => n.type === 'wall')) {
    const wg = calcWallGeometry(n, nodeMap, edges, wallJoins);
    if (!wg) continue;

    const color = nodeHex('wall');

    // ── Build FULL wall solid (one mesh, no per-opening splits) ──────────────
    const wdx = wg.exM - wg.sxM;
    const wdz = wg.ezM - wg.szM;
    const wallLen = Math.sqrt(wdx * wdx + wdz * wdz);
    if (wallLen < 0.001) continue;

    // ── Structure view ────────────────────────────────────────────────────
    //
    // A timber-frame wall is drawn as what it is built of: the studs, plates
    // and headers the takeoff counts (lib/framing, through the SAME input
    // builder), the OSB on the outer face of an exterior wall, the gypsum
    // lining on the inner face(s). A CLT wall keeps its solid and shows the
    // panel joints. Openings keep their frames from the loop below.
    const wallSystem = resolveStructuralSystem(n, getTakeoffContext().structuralSystem);
    const wallType = String(n.properties.wall_type ?? '');
    const universal = UNIVERSAL_WALL_TYPES.includes(wallType);
    const isTimber = /^TF/i.test(wallType) || (wallSystem === 'timber_frame' && !isCltWallType(wallType));
    const isClt = isCltWallType(wallType) || (wallSystem === 'clt' && !universal && !/^TF/i.test(wallType));
    const showStructure = !!opts.structureView || String(n.properties.show_framing ?? 'False').toLowerCase() === 'true';
    const thickMm = wg.wallThick * 1000;
    const start = { x: wg.sxM * 1000, y: -wg.szM * 1000 };
    const dir = { x: wdx / wallLen, y: -wdz / wallLen };
    const fg = {
      lengthMm: wallLen * 1000,
      heightMm: wg.wallH * 1000,
      thicknessMm: thickMm,
      openings: wg.openings.map((op) => ({
        x0Mm: op.tS * 1000, widthMm: op.oW * 1000, sillMm: op.sill * 1000, heightMm: op.oH * 1000,
      })),
    };
    const storeyId = resolveStoreyId(n, nodeMap);
    // Outward normal: the side of the wall that faces away from the storey's centre.
    const outward = (() => {
      const nrm = { x: dir.y, y: -dir.x };
      const c = storeyCentroid(storeyId);
      const mid = { x: start.x + dir.x * fg.lengthMm / 2, y: start.y + dir.y * fg.lengthMm / 2 };
      return (c.x - mid.x) * nrm.x + (c.y - mid.y) * nrm.y < 0 ? nrm : { x: -nrm.x, y: -nrm.y };
    })();
    const faceRects = (): { x0: number; x1: number; z0: number; z1: number }[] => {
      const L = fg.lengthMm, H = fg.heightMm;
      const ops = fg.openings
        .map((o) => ({ x0: Math.max(0, o.x0Mm), x1: Math.min(L, o.x0Mm + o.widthMm), z0: Math.max(0, o.sillMm), z1: Math.min(H, o.sillMm + o.heightMm) }))
        .filter((o) => o.x1 - o.x0 > 1 && o.z1 - o.z0 > 1)
        .sort((a, b) => a.x0 - b.x0);
      const rects: { x0: number; x1: number; z0: number; z1: number }[] = [];
      let x = 0;
      for (const o of ops) {
        if (o.x0 - x > 1) rects.push({ x0: x, x1: o.x0, z0: 0, z1: H });
        if (o.z0 > 1) rects.push({ x0: o.x0, x1: o.x1, z0: 0, z1: o.z0 });
        if (H - o.z1 > 1) rects.push({ x0: o.x0, x1: o.x1, z0: o.z1, z1: H });
        x = Math.max(x, o.x1);
      }
      if (L - x > 1) rects.push({ x0: x, x1: L, z0: 0, z1: H });
      return rects;
    };
    const faceLayer = (sideSign: 1 | -1, layerMm: number, color: number, opacity: number, label: string) => {
      const off = sideSign * (thickMm / 2 - layerMm / 2);
      for (const r of faceRects()) {
        const cx = start.x + dir.x * (r.x0 + r.x1) / 2 + outward.x * off;
        const cy = start.y + dir.y * (r.x0 + r.x1) / 2 + outward.y * off;
        const mesh = orientedBox(
          { x: cx, y: cy, z: wg.botM * 1000 + (r.z0 + r.z1) / 2 },
          dir, layerMm, r.z1 - r.z0, r.x1 - r.x0,
        );
        if (!mesh) continue;
        mesh.material = new THREE.MeshStandardMaterial({ color, roughness: 0.8, transparent: opacity < 1, opacity });
        tag(mesh, 'wall', n.id, storeyId);
        mesh.userData.layer = label;
        scene.add(mesh);
      }
    };

    if (isTimber && showStructure) {
      const framing = computeWallFraming(framingInputForWall(n, edges, nodeMap, fg));
      for (const m of framing.members) {
        const { a, b } = placeMember(m, start, dir, wg.botM * 1000);
        const mesh = timberMemberMesh({
          ...n, id: `${n.id}:${m.kind}`, type: 'stud',
          properties: {
            ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z,
            section: `T${(m.section.wMm * (m.plies ?? 1)) / 10}x${m.section.dMm / 10}`,
          },
        });
        if (!mesh) continue;
        applyMat(mesh, 'beam', { ...n, properties: { ...n.properties, material: 'timber_structural' } }, matConfig);
        tag(mesh, 'wall', n.id, storeyId);
        scene.add(mesh);
      }
      // Layers: OSB outside an exterior wall, gypsum on the inner face(s).
      const exterior = sideOf(n.id) === 'exterior';
      if (exterior) faceLayer(1, 12, 0xd9a066, 0.85, 'osb');
      faceLayer(-1, 12.5, 0xf3f4f6, 0.55, 'gypsum');
      if (!exterior) faceLayer(1, 12.5, 0xf3f4f6, 0.55, 'gypsum');
      // Openings still get their frames and glass.
      for (const op of wg.openings) {
        const nodeType = op.isDoor ? 'door' : 'window';
        const vis = resolveVisuals(nodeType, String(op.node?.properties?.material ?? ''), matConfig);
        for (const mm of buildOpeningMeshes3(op, new Map(), nodeType, vis, glazingCfg)) {
          mm.userData.nodeType = nodeType;
          mm.userData.nodeId = op.node?.id;
          mm.userData.storeyId = op.node ? resolveStoreyId(op.node, nodeMap) : undefined;
          scene.add(mm);
        }
      }
      continue;
    }

    if (isClt && showStructure) {
      // Panel joints as dark strips through the solid; the solid itself follows.
      const clt = computeCltPanels(cltInputForWall(n, fg));
      for (let i = 1; i < clt.panels.length; i++) {
        const x = clt.panels[i].x0Mm;
        const mesh = orientedBox(
          { x: start.x + dir.x * x, y: start.y + dir.y * x, z: wg.botM * 1000 + fg.heightMm / 2 },
          dir, thickMm + 4, fg.heightMm, 8,
        );
        if (!mesh) continue;
        mesh.material = new THREE.MeshStandardMaterial({ color: 0x3f2a14, roughness: 0.9 });
        tag(mesh, 'wall', n.id, storeyId);
        mesh.userData.layer = 'clt_joint';
        scene.add(mesh);
      }
    }

    const wallTopM = wg.solidSegs.reduce((mx, s) => Math.max(mx, s.baseY + s.height), wg.botM);
    const wallH    = wallTopM - wg.botM;
    if (wallH < 0.001) continue;

    // Use the pre-computed footprint (BIM mm → Three.js metres).
    // Footprint already includes join geometry (miter/butt corners).
    const corners: Vector3[] = wg.footprint.map(
      (p) => new Vector3(p.x * MM, 0, -p.y * MM),
    );

    const layers = resolveWallLayers(n.properties, wg.wallH);

    // Roofs above this wall: cut it back to their underside, and — when the wall
    // is set to attach — grow its top layer up to them first.
    const trims = roofTrims.filter((t) => roofTrimsNode(t, n, wg.footprint));
    const wedges = trims.flatMap(roofWedges);
    let attachRiseMm = 0;
    if (wedges.length > 0 && attachesToRoof(n)) {
      const reach = attachHeightAlong(
        trims.flatMap((t) => t.planes),
        { x: wg.sxM * 1000, y: -wg.szM * 1000 },
        { x: wg.exM * 1000, y: -wg.ezM * 1000 },
      );
      if (reach != null) attachRiseMm = Math.max(0, reach - wallTopM * 1000);
    }

    const ogOpenings: Opening[] = [];
    if (wg.openings.length > 0) {
      for (const op of wg.openings) {
        const cutDepthM    = Math.max(0.05, Number(op.node?.properties?.cut_depth ?? 1000) * MM);
        const worldCenterY = op.botY + op.sill + op.oH / 2;
        const wallAngleRad = Math.atan2(op.uz, op.ux);

        const opening = new Opening({
          center:      new Vector3(0, 0, 0),
          width:       op.oW,
          height:      op.oH,
          depth:       cutDepthM,
          color:       0xffffff,
          translation: new Vector3(op.cx, worldCenterY, op.cz),
          rotation:    new Vector3(0, wallAngleRad, 0),
        });

        ogOpenings.push(opening);
        allOgOpenings.push({ opening, centerY: worldCenterY });
      }
    }
    const _ogKernel = { mergeCoplanarFaces: true, tolerance: undefined } as const;

    // Openings and roof wedges go in one batch: the kernel resolves them
    // against one another instead of re-meshing the wall for each.
    const cutters: Array<Opening | OGBooleanResult> = wedges.length > 0
      ? [...ogOpenings, ...wedges]
      : ogOpenings;

    /** One extruded band of the wall, with every cutter subtracted from it. */
    const buildBand = (fp: Vector3[], baseM: number, hM: number): THREE.Mesh | null => {
      try {
        const wallPolygon = new Polygon({ vertices: fp, color });
        const wallSolid   = wallPolygon.extrude(hM);
        wallSolid.setTranslation(new Vector3(0, baseM, 0));
        if (cutters.length === 0) return wallSolid as unknown as THREE.Mesh;
        try {
          return executeBooleanSubtractionMany(wallSolid, cutters, { kernel: _ogKernel }) as unknown as THREE.Mesh;
        } catch (boolErr) {
          if (cutters.length === 1) {
            console.warn('[ogBimMapper] wall boolean cut failed, using solid fallback:', boolErr);
            return wallSolid as unknown as THREE.Mesh;
          }
          console.warn('[ogBimMapper] multi-cutter wall cut failed, retrying one-by-one:', boolErr);
          let current: OGBooleanResult | null = null;
          for (const cutter of cutters) {
            try {
              const lhs = current ?? wallSolid;
              current = executeBooleanSubtractionMany(lhs, [cutter], { kernel: _ogKernel });
            } catch (singleErr) {
              console.warn('[ogBimMapper] single wall cutter skipped:', singleErr);
            }
          }
          return (current ?? wallSolid) as unknown as THREE.Mesh;
        }
      } catch (err) {
        console.warn('[ogBimMapper] wall solid failed:', err);
        return null;
      }
    };

    // ── Gable built separately ────────────────────────────────────────────
    //
    // When the wall says its gable is another construction — thinner, in
    // another material, off the axis — the solid splits at the lowest point of
    // the roof's cut: the layers below stop there, and one extra body carries
    // the triangle above on its own footprint. `splitM` stays null for a wall
    // nobody configured, and then this whole branch costs nothing.
    const gable = gableSpec(n, wallThicknessMm(n));
    let splitM: number | null = null;
    let gableCorners: Vector3[] = corners;
    if (wedges.length > 0 && gable.distinct) {
      const A = { x: wg.sxM * 1000, y: -wg.szM * 1000 };
      const B = { x: wg.exM * 1000, y: -wg.ezM * 1000 };
      const topAbsMm = wallTopM * 1000 + attachRiseMm;
      const segs = trimmedTopAlong(trims.flatMap((t) => t.planes), A, B, topAbsMm);
      if (isTrimmed(segs, topAbsMm)) {
        const cutMm = Math.min(...segs.flatMap((s) => [s.z0, s.z1]));
        if (cutMm * MM > wg.botM + 0.001 && cutMm < topAbsMm) {
          splitM = cutMm * MM;
          if (gable.reshaped) {
            gableCorners = gableFootprintMm(A, B, gable).map(
              (p) => new Vector3(p.x * MM, 0, -p.y * MM),
            );
          }
        }
      }
    }

    for (const layer of layers) {
      const layerBaseM = wg.botM + layer.fromMm * MM;
      // Only the topmost layer grows to meet the roof; the ones below keep their band.
      const isTopLayer = layer === layers[layers.length - 1];
      let layerHM      = (layer.heightMm + (isTopLayer ? attachRiseMm : 0)) * MM;
      // A separately built gable takes over above the split.
      if (splitM != null) layerHM = Math.min(layerHM, splitM - layerBaseM);
      if (layerHM < 0.001) continue;

      const wallMesh = buildBand(corners, layerBaseM, layerHM);
      if (wallMesh) {
        tag(wallMesh, 'wall', n.id, resolveStoreyId(n, nodeMap));
        applyMat(wallMesh, 'wall', syntheticWallNodeForLayer(n, layer), matConfig);
        applyNodeLocalTransformThree(wallMesh as THREE.Mesh, getNodeLocalTransform(n));
        scene.add(wallMesh as THREE.Object3D);
      }
    }

    if (splitM != null && gableCorners.length >= 3) {
      // Extruded past the roof and cut back by the same wedges the wall used,
      // so the two bodies meet the underside on exactly the same planes.
      const gableMesh = buildBand(gableCorners, splitM, wallTopM + attachRiseMm * MM - splitM);
      if (gableMesh) {
        tag(gableMesh, 'wall', n.id, resolveStoreyId(n, nodeMap));
        applyMat(
          gableMesh, 'wall',
          { ...n, properties: { ...n.properties, material: gableMaterial(n, gable) } },
          matConfig,
        );
        applyNodeLocalTransformThree(gableMesh as THREE.Mesh, getNodeLocalTransform(n));
        scene.add(gableMesh as THREE.Object3D);
      }
    }

    // ── Window / door frame + glass meshes ──────────────────────────────
    for (const op of wg.openings) {
      const nodeType = op.isDoor ? 'door' : 'window';
      const vis = resolveVisuals(nodeType, String(op.node?.properties?.material ?? ''), matConfig);
      const frameMeshes = buildOpeningMeshes3(op, new Map(), nodeType, vis, glazingCfg);
      const opStoreyId = op.node ? resolveStoreyId(op.node, nodeMap) : undefined;
      for (const m of frameMeshes) {
        m.userData.nodeType = nodeType;
        m.userData.nodeId   = op.node?.id;
        m.userData.storeyId = opStoreyId;
        m.castShadow        = true;
        scene.add(m);
      }
    }
  }

  // ── Beams (from wall nodes with has_beam=true) ──────────────────────────────
  // NOTE: OG bakes world-space vertices into geometry (this.position stays at 0,0,0).
  // We CANNOT use Cuboid + rotation.y (that would rotate around world origin).
  // Instead we use the same Polygon.extrude approach as wall segments.

  for (const n of nodes.filter(
    (n) => n.type === 'wall' && String(n.properties.has_beam ?? '').toLowerCase() === 'true',
  )) {
    const wg = calcWallGeometry(n, nodeMap, edges, wallJoins);
    if (!wg?.beamDesc) continue;

    const bd  = wg.beamDesc;
    const dx  = bd.bx - bd.ax;
    const dz  = bd.bz - bd.az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) continue;

    const ux = dx / len, uz = dz / len;   // unit along beam span
    const px = -uz,      pz = ux;         // unit perpendicular in XZ plane
    const hw = bd.width / 2;

    // Footprint in XZ plane — same pattern as wall segments
    const corners: Vector3[] = [
      new Vector3(bd.ax - px * hw, 0, bd.az - pz * hw),
      new Vector3(bd.bx - px * hw, 0, bd.bz - pz * hw),
      new Vector3(bd.bx + px * hw, 0, bd.bz + pz * hw),
      new Vector3(bd.ax + px * hw, 0, bd.az + pz * hw),
    ];

    try {
      const polygon = new Polygon({ vertices: corners, color: nodeHex('beam') });
      const solid   = polygon.extrude(bd.height);
      solid.setTranslation(new Vector3(0, bd.baseY, 0));
      const mesh = solid as unknown as THREE.Mesh;
      tag(mesh, 'beam', n.id, resolveStoreyId(n, nodeMap));
      applyMat(mesh, 'beam', n, matConfig);
      scene.add(solid as unknown as THREE.Object3D);
    } catch (err) {
      console.warn('[ogBimMapper] beam failed:', err);
    }
  }

  // ── Slabs ───────────────────────────────────────────────────────────────────

  for (const n of nodes.filter((n) => n.type === 'slab')) {
    const { top } = getStoreyBand(n, nodeMap);
    const th      = getNodeSlabThickness(n);
    const baseM   = top * MM - th;

    let poly = calcShellPolygon(n, nodeMap, edges);
    if (poly && poly.length >= 3) {
      const rawOff = parseContourOffsets(n.properties.contour_offset);
      const inward = rawOff.map((o) => -o);
      if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);
    }

    const slabLtr = getNodeLocalTransform(n);
    if (poly && poly.length >= 3) {
      const mesh = extrudePolygon(poly, th, baseM, nodeHex('slab'));
      if (mesh) {
        // OG Solid — use setTranslation so the transform survives any OG regeneration
        const ogSolid = mesh as unknown as { setTranslation: (v: Vector3) => void };
        ogSolid.setTranslation(new Vector3(slabLtr.tx * MM, baseM + slabLtr.tz * MM, -slabLtr.ty * MM));
        tag(mesh, 'slab', n.id, resolveStoreyId(n, nodeMap));
        applyMat(mesh, 'slab', n, matConfig);
        scene.add(mesh as THREE.Object3D);
      }
    } else {
      // Fallback: bounding box from sibling positions
      const sibs = nodes.filter((s) => s.parentId === n.parentId && s.type !== 'storey');
      const xs   = (sibs.length ? sibs : [n]).map((s) => s.x * MM);
      const zs   = (sibs.length ? sibs : [n]).map((s) => -s.y * MM);
      const cx   = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cz   = (Math.min(...zs) + Math.max(...zs)) / 2;
      const sw   = Math.max(Math.max(...xs) - Math.min(...xs), 0.1);
      const sd   = Math.max(Math.max(...zs) - Math.min(...zs), 0.1);
      try {
        // OG Cuboid — bake translation into center
        const cuboid = new Cuboid({
          center: new Vector3(cx + slabLtr.tx * MM, baseM + th / 2 + slabLtr.tz * MM, cz - slabLtr.ty * MM),
          width: sw, height: th, depth: sd,
          color: nodeHex('slab'),
        });
        const mesh = cuboid as unknown as THREE.Mesh;
        tag(mesh, 'slab', n.id, resolveStoreyId(n, nodeMap));
        applyMat(mesh, 'slab', n, matConfig);
        scene.add(cuboid as unknown as THREE.Object3D);
      } catch (err) {
        console.warn('[ogBimMapper] slab fallback failed:', err);
      }
    }
  }

  // ── Room-derived floor slabs (has_slab = true on room node, default true) ──

  for (const n of nodes.filter((n) => n.type === 'room')) {
    const hasSlab = n.properties.has_slab !== 'False' && n.properties.has_slab !== false;
    if (!hasSlab) continue;

    const { top } = getStoreyBand(n, nodeMap);
    const th      = getNodeSlabThickness(n);
    const baseM   = top * MM - th;

    let poly = calcRoomPolygon(n, nodeMap, edges);
    if (!poly || poly.length < 3) continue;

    const rawOff = parseContourOffsets(n.properties.contour_offset);
    const inward = rawOff.map((o) => -o);
    if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);
    if (!poly || poly.length < 3) continue;

    const mesh = extrudePolygon(poly, th, baseM, nodeHex('slab'));
    if (mesh) {
      tag(mesh, 'slab', n.id, resolveStoreyId(n, nodeMap));
      const slabMatProp = String(n.properties.slab_material ?? '');
      applyMat(mesh, 'slab', { ...n, properties: { ...n.properties, material: slabMatProp } }, matConfig);
      scene.add(mesh as THREE.Object3D);
    }
  }

  // ── Foundations ─────────────────────────────────────────────────────────────

  for (const n of nodes.filter((n) => n.type === 'foundation')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const pos = getNodeBimPos(n, nodeMap);
    try {
      const cuboid = new Cuboid({
        center: v3(pos.x, pos.y, bot - 250),
        width: 1.2, height: 0.5, depth: 1.2,
        color: nodeHex('foundation'),
      });
      const mesh = cuboid as unknown as THREE.Mesh;
      tag(mesh, 'foundation', n.id, resolveStoreyId(n, nodeMap));
      applyMat(mesh, 'foundation', n, matConfig);
      scene.add(cuboid as unknown as THREE.Object3D);
    } catch (err) {
      console.warn('[ogBimMapper] foundation failed:', err);
    }
  }

  // ── Rooms ───────────────────────────────────────────────────────────────────

  for (const n of nodes.filter((n) => n.type === 'room')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const roomH = Number(n.properties.height ?? 2650); // mm

    let poly = calcRoomPolygon(n, nodeMap, edges);
    if (poly && poly.length >= 3) {
      const rawOff = parseContourOffsets(n.properties.contour_offset);
      const inward = rawOff.map((o) => -o);
      if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);
    }

    if (poly && poly.length >= 3) {
      try {
        const polygon = new Polygon({
          vertices: poly.map((p) => planV3(p.x, p.y)),
          color: nodeHex('room'),
        });
        const solid = polygon.extrude(roomH * MM);
        solid.setTranslation(new Vector3(0, bot * MM, 0));
        const mesh = solid as unknown as THREE.Mesh;
        // Apply matConfig — room opacity_3d is 0.15 by default
        applyMat(mesh, 'room', n, matConfig);
        tag(mesh, 'room', n.id, resolveStoreyId(n, nodeMap));
        scene.add(mesh as THREE.Object3D);
      } catch (err) {
        console.warn('[ogBimMapper] room failed:', err);
      }
    }
  }

  // ── Shell / Covering (ring via CSG: outer solid − inner solid) ──────────────
  //
  // Why NOT Polygon({ holes }).extrude():
  //   The OG kernel produces non-manifold edges at the inner/outer contour
  //   boundary → NonManifoldOutputError on any subsequent boolean pass.
  //
  // Why CSG outer − inner:
  //   Both Polygon.extrude() results are fully manifold closed solids.
  //   executeBooleanSubtractionMany returns BooleanResult which is ALSO manifold
  //   and satisfies BooleanOperand → can be fed into a second boolean pass
  //   (window/door opening cuts), chain: outer − inner − openings.
  //
  // Inner solid is 2×EPS taller and EPS lower than outer to avoid coincident
  // top/bottom faces (boolmesh merges faces within ~1 mm, causing failure).

  /**
   * Build a manifold ring mesh via CSG: outerSolid − innerSolid.
   * Returns a BooleanResult (extends THREE.Mesh & BooleanOperand) so it can
   * be further cut by opening booleans.
   */
  const buildOGRing = (
    poly: { x: number; y: number }[],
    offsets: number[],
    thickMm: number,
    heightM: number,
    baseM: number,
    color: number,
  ): OGBooleanResult | null => {
    if (poly.length < 3 || heightM <= 0 || thickMm <= 0) return null;

    const inward = offsets.map((o) => -o);
    const outer  = insetPolygon(poly, inward);
    const inner  = insetPolygon(poly, inward.map((v) => v + thickMm));
    if (outer.length < 3 || inner.length < 3) return null;

    // Both polygons CCW (outer CCW = as returned by calcShellPolygon;
    // inner CCW too — it's a normal filled solid, not a hole descriptor).
    const outerV = outer.map((p) => planV3(p.x, p.y));
    const innerV = inner.map((p) => planV3(p.x, p.y));

    const EPS = 0.005; // 5 mm vertical overshoot to avoid coincident faces

    try {
      const outerPolygon = new Polygon({ vertices: outerV, color });
      const outerSolid   = outerPolygon.extrude(heightM);
      outerSolid.setTranslation(new Vector3(0, baseM, 0));

      const innerPolygon = new Polygon({ vertices: innerV, color: 0xffffff });
      const innerSolid   = innerPolygon.extrude(heightM + 2 * EPS);
      innerSolid.setTranslation(new Vector3(0, baseM - EPS, 0));

      // Subtract inner from outer → manifold ring BooleanResult
      return executeBooleanSubtractionMany(
        outerSolid,
        [innerSolid as unknown as Solid],
        { kernel: { mergeCoplanarFaces: true, tolerance: undefined } },
      );
    } catch (err) {
      console.warn('[ogBimMapper] ring construction failed:', err);
      return null;
    }
  };

  /**
   * Apply same-storey window/door opening cuts to a manifold ring solid.
   * The ring (BooleanResult) satisfies BooleanOperand, so it can be passed
   * directly as the LHS of executeBooleanSubtractionMany.
   * Only openings whose vertical centre falls within [baseM .. baseM+heightM]
   * are used — openings from other storeys are excluded.
   */
  const applyOpeningCuts = (ring: OGBooleanResult, baseM: number, heightM: number): THREE.Mesh => {
    const topM     = baseM + heightM;
    const relevant = allOgOpenings
      .filter((o) => o.centerY >= baseM - 0.01 && o.centerY <= topM + 0.01)
      .map((o) => o.opening);
    if (relevant.length === 0) return ring as unknown as THREE.Mesh;
    const _k = { mergeCoplanarFaces: true, tolerance: undefined } as const;
    try {
      return executeBooleanSubtractionMany(ring, relevant, { kernel: _k }) as unknown as THREE.Mesh;
    } catch (err) {
      if (relevant.length > 1) {
        // One opening may have caused numerical issues — try each individually
        console.warn('[ogBimMapper] multi-opening ring cut failed, retrying one-by-one:', err);
        let current: OGBooleanResult = ring;
        for (const opening of relevant) {
          try {
            current = executeBooleanSubtractionMany(current, [opening], { kernel: _k });
          } catch (singleErr) {
            console.warn('[ogBimMapper] single ring opening cut skipped:', singleErr);
          }
        }
        return current as unknown as THREE.Mesh;
      }
      console.warn('[ogBimMapper] ring opening cuts failed, using ring without cuts:', err);
      return ring as unknown as THREE.Mesh;
    }
  };

  // Standalone shell nodes
  for (const n of nodes.filter((n) => n.type === 'shell')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const shellH  = Number(n.properties.height ?? 2800) * MM;
    const thickMm = Number(n.properties.thickness ?? 200);
    const offsets = parseContourOffsets(n.properties.contour_offset);
    const poly    = calcShellPolygon(n, nodeMap, edges);
    if (!poly) continue;
    const baseM = bot * MM;
    // Anvelopa se desenează pe BENZI când are: soclul și câmpul sunt lucrări
    // diferite, deci nici nu arată la fel. Fără benzi, un singur inel, ca până
    // acum.
    const bands = renderBandsOf(n, shellH)
      ?? [{ fromM: 0, heightM: shellH, material: undefined, label: '' }];
    for (const band of bands) {
      const bandBase = baseM + band.fromM;
      const ring = buildOGRing(poly, offsets, thickMm, band.heightM, bandBase, nodeHex('shell'));
      if (!ring) continue;
      const mesh = applyOpeningCuts(ring, bandBase, band.heightM);
      const bandNode = band.material
        ? { ...n, properties: { ...n.properties, material: band.material } }
        : n;
      applyMat(mesh, 'shell', bandNode, matConfig);
      tag(mesh, 'shell', n.id, resolveStoreyId(n, nodeMap));
      scene.add(mesh as THREE.Object3D);
    }
  }

  // Standalone covering nodes (skip pitched roof coverings — rendered via roof faces)
  for (const n of nodes.filter((n) => n.type === 'covering' && !n.properties.pitched)) {
    const { bot } = getStoreyBand(n, nodeMap);
    const covH    = Number(n.properties.height ?? 2800) * MM;
    const thickMm = Number(n.properties.thickness ?? 200);
    const offsets = parseContourOffsets(n.properties.contour_offset);
    const poly    = calcShellPolygon(n, nodeMap, edges);
    if (!poly) continue;
    const covBaseM = bot * MM;
    const ring = buildOGRing(poly, offsets, thickMm, covH, covBaseM, nodeHex('covering'));
    if (ring) {
      const mesh = applyOpeningCuts(ring, covBaseM, covH);
      applyMat(mesh, 'covering', n, matConfig);
      tag(mesh, 'covering', n.id, resolveStoreyId(n, nodeMap));
      scene.add(mesh as THREE.Object3D);
    }
  }

  // Parametric roofs (pitched faces), cut for any skylights/dormers that land on them.
  const skylightNodes = nodes.filter((n) => n.type === 'skylight');
  const dormerNodes = nodes.filter((n) => n.type === 'dormer');
  for (const n of nodes.filter((n) => n.type === 'roof')) {
    const faces = roofFacesOf(n);
    const coveringThicknessM = Math.max(0.01, Number(n.properties.covering_thickness_mm ?? 40) * MM);

    // Bodies that outrank this roof punch through it instead of being cut by it.
    const thisTrim = roofTrims.find((t) => t.roof.id === n.id);
    const punchFootprints = thisTrim
      ? nodesCuttingRoof(thisTrim, nodes)
          .map((p) => roofPunchFootprint(p, nodeMap, edges, wallJoins))
          .filter((fp): fp is Array<{ x: number; y: number }> => !!fp && fp.length >= 3)
      : [];

    // Resolve which skylights / dormers land on which face of THIS roof.
    const skyByFace = new Map<string, { node: BubbleGraphNode; placement: SkylightPlacement }[]>();
    for (const sk of skylightNodes) {
      const placement = placeSkylight(faces, {
        planX: sk.x,
        planY: sk.y,
        widthMm: Number(sk.properties.width_mm ?? 780),
        lengthMm: Number(sk.properties.length_mm ?? 1180),
        curbHeightMm: Number(sk.properties.curb_height_mm ?? 120),
      });
      if (!placement) continue; // not over this roof
      if (!placement.ok) console.warn(`[ogBimMapper] skylight ${sk.id}: ${placement.diagnostics.join('; ')}`);
      const arr = skyByFace.get(placement.face.id) ?? [];
      arr.push({ node: sk, placement });
      skyByFace.set(placement.face.id, arr);
    }

    const dormerByFace = new Map<string, { node: BubbleGraphNode; placement: DormerPlacement }[]>();
    for (const dm of dormerNodes) {
      const placement = placeDormer(faces, {
        planX: dm.x,
        planY: dm.y,
        widthMm: Number(dm.properties.width_mm ?? 1200),
        depthMm: Number(dm.properties.depth_mm ?? 900),
        wallHeightMm: Number(dm.properties.wall_height_mm ?? 1200),
        roofType: (String(dm.properties.roof_type ?? 'gable') === 'shed' ? 'shed' : 'gable'),
        pitchDeg: Number(dm.properties.pitch_deg ?? 25),
        overhangMm: Number(dm.properties.overhang_mm ?? 200),
      });
      if (!placement) continue; // not over this roof
      if (!placement.ok) console.warn(`[ogBimMapper] dormer ${dm.id}: ${placement.diagnostics.join('; ')}`);
      const arr = dormerByFace.get(placement.face.id) ?? [];
      arr.push({ node: dm, placement });
      dormerByFace.set(placement.face.id, arr);
    }

    for (const face of faces) {
      const skyHits = skyByFace.get(face.id) ?? [];
      const dormerHits = dormerByFace.get(face.id) ?? [];

      let faceMesh: THREE.Mesh | null = null;
      if (skyHits.length > 0 || dormerHits.length > 0 || punchFootprints.length > 0) {
        try {
          const solid = pitchedFaceSolid(face, coveringThicknessM);
          if (solid) {
            const faceZ = face.vertices.map((v) => v.z);
            const cutters: Solid[] = [
              // Priority inverted: these bodies outrank the roof, so they take a
              // hole out of it exactly the way a dormer notch does.
              ...punchFootprints.map((fp) => dormerNotchSolid(
                fp.map((p) => ({ x: p.x, y: p.y, z: 0 })),
                Math.min(...faceZ) - 1000,
                Math.max(...faceZ) + 1000,
              )),
              ...skyHits.map((h) => skylightCutterSolid(h.placement, coveringThicknessM)),
              ...dormerHits.map((h) => {
                const front = h.placement.frontWall.corners[0]; // frontBottomL, on the roof surface
                const top = h.placement.frontWall.corners[2].z;  // frontTopL.z — wall-plate height
                const padM = Math.max(coveringThicknessM * 0.05, 0.01);
                return dormerNotchSolid(h.placement.notchFootprint, front.z - padM * 1000, top + padM * 1000);
              }),
            ].filter((c): c is Solid => !!c);
            faceMesh = cutters.length
              ? (executeBooleanSubtractionMany(solid, cutters, {
                kernel: { mergeCoplanarFaces: true, tolerance: undefined },
              }) as unknown as THREE.Mesh)
              : (solid as unknown as THREE.Mesh);
          }
        } catch (err) {
          console.warn(`[ogBimMapper] opening cut failed on roof ${n.id} face ${face.id} — using uncut face:`, err);
        }
      }
      if (!faceMesh) faceMesh = pitchedFaceMesh(face);
      if (faceMesh) {
        // A gable end (fronton) is masonry closing off the attic, not covering,
        // so it keeps the wall default rather than the roof's covering colour.
        const kind = face.role === 'gable_end' ? 'wall' : 'roof';
        applyMat(faceMesh, kind, kind === 'wall' ? null : roofSurfaceNode(n), matConfig);
        tag(faceMesh, kind, n.id, resolveStoreyId(n, nodeMap));
        scene.add(faceMesh);
      }

      // Skylight glazing panes.
      for (const h of skyHits) {
        const curbMm = Number(h.node.properties.curb_height_mm ?? 120);
        const glazing = skylightGlazingMesh(h.placement, curbMm);
        if (!glazing) continue;
        applyMat(glazing, 'skylight', h.node, matConfig);
        tag(glazing, 'skylight', h.node.id, resolveStoreyId(h.node, nodeMap));
        scene.add(glazing);
      }

      // Dormer walls + its own small roof.
      for (const h of dormerHits) {
        const dormerMaterial = String(h.node.properties.material ?? 'Lemn rasinos');
        const wallThicknessMm = 100;
        const uAxis: Pt3 = { x: h.placement.basis.u.x, y: h.placement.basis.u.y, z: 0 };
        const outwardFront: Pt3 = (() => {
          const l = Math.hypot(h.placement.basis.v.x, h.placement.basis.v.y) || 1;
          return { x: -h.placement.basis.v.x / l, y: -h.placement.basis.v.y / l, z: 0 };
        })();
        const panes: { pane: WallPane; outward: Pt3 }[] = [
          { pane: h.placement.frontWall, outward: outwardFront },
          { pane: h.placement.cheekLeft, outward: { x: -uAxis.x, y: -uAxis.y, z: 0 } },
          { pane: h.placement.cheekRight, outward: uAxis },
        ];
        for (const { pane, outward } of panes) {
          let wallMesh: THREE.Mesh | null = null;
          try {
            const solid = wallPaneSolid(pane, wallThicknessMm, outward);
            if (solid) wallMesh = solid as unknown as THREE.Mesh;
          } catch (err) {
            console.warn(`[ogBimMapper] dormer ${h.node.id} wall pane failed, using flat fallback:`, err);
          }
          if (!wallMesh) wallMesh = wallPaneMesh(pane);
          if (!wallMesh) continue;
          applyMat(wallMesh, 'wall', { ...h.node, properties: { ...h.node.properties, material: dormerMaterial } }, matConfig);
          tag(wallMesh, 'dormer', h.node.id, resolveStoreyId(h.node, nodeMap));
          scene.add(wallMesh);
        }

        for (const rf of h.placement.ownRoofFaces) {
          const roofMesh = pitchedFaceMesh(rf);
          if (!roofMesh) continue;
          applyMat(roofMesh, 'roof', roofSurfaceNode(h.node), matConfig);
          tag(roofMesh, 'dormer', h.node.id, resolveStoreyId(h.node, nodeMap));
          scene.add(roofMesh);
        }
      }
    }
  }

  // Generated roof timber (rafters, ridge, posts, plates, hips) + linear detail
  // members (battens, fascia, barge boards, caps, snow guards) — all box profiles.
  const TIMBER_TYPES = new Set([
    'rafter', 'hip_rafter', 'valley_rafter', 'ridge_beam', 'wall_plate', 'post', 'purlin',
    'tie_beam', 'collar_tie',
    ...ROOF_LINEAR_DETAIL_TYPES,
  ]);
  for (const n of nodes.filter((n) => TIMBER_TYPES.has(n.type))) {
    const mesh = timberMemberMesh(n);
    if (!mesh) continue;
    applyMat(mesh, 'beam', n, matConfig);
    tag(mesh, n.type, n.id, resolveStoreyId(n, nodeMap));
    scene.add(mesh);
  }

  // ── Stairs ──
  // Flights as stepped solids, landings as small slabs. The stairwell node
  // itself draws nothing: it is the parameter holder, and its slab opening is a
  // plain `void` that the boolean pass above already applied.
  //
  // At the `steps` detail level the sawtooth exists as real `stair_tread` nodes,
  // so those stairwells get the plain waist under their treads instead of the
  // stepped solid — otherwise every step would be drawn twice in place.
  const stairwellsWithTreads = new Set(
    nodes
      .filter((n) => n.type === 'stair_tread')
      .map((n) => String(n.properties.source_stairwell_id ?? '')),
  );
  for (const n of nodes.filter((n) => n.type === 'stair_flight')) {
    const stepped = !stairwellsWithTreads.has(String(n.properties.source_stairwell_id ?? ''));
    const mesh = stepped ? stairFlightMesh(n) : stairWaistMesh(n);
    if (!mesh) continue;
    applyMat(mesh, 'stair_flight', n, matConfig);
    tag(mesh, 'stair_flight', n.id, resolveStoreyId(n, nodeMap));
    scene.add(mesh);
  }

  for (const n of nodes.filter((n) => n.type === 'stair_landing')) {
    let poly: { x: number; y: number }[] = [];
    try {
      poly = JSON.parse(String(n.properties.polygon ?? '[]'));
    } catch { /* a malformed polygon just means no landing, not a crash */ }
    if (poly.length < 3) continue;
    const thickMm = Number(n.properties.thickness_mm ?? 150);
    const levelMm = Number(n.properties.level_mm ?? n.z);
    // Hang it under the walking surface, like the flights.
    const mesh = extrudePolygon(poly, thickMm * MM, (levelMm - thickMm) * MM, 0x155e75);
    if (!mesh) continue;
    applyMat(mesh, 'stair_landing', n, matConfig);
    tag(mesh, 'stair_landing', n.id, resolveStoreyId(n, nodeMap));
    scene.add(mesh);
  }

  for (const n of nodes.filter((n) => n.type === 'stair_tread')) {
    const mesh = stairTreadMesh(n);
    if (!mesh) continue;
    applyMat(mesh, 'stair_tread', n, matConfig);
    tag(mesh, 'stair_tread', n.id, resolveStoreyId(n, nodeMap));
    scene.add(mesh);
  }

  // Winder steps (spiral treads and fan corners): one-riser-thick wedge prisms.
  for (const n of nodes.filter((n) => n.type === 'stair_winder')) {
    let poly: { x: number; y: number }[] = [];
    try {
      poly = JSON.parse(String(n.properties.polygon ?? '[]'));
    } catch { /* a malformed polygon just means no winder, not a crash */ }
    if (poly.length < 3) continue;
    const riserMm = Number(n.properties.riser_mm ?? 170);
    const levelMm = Number(n.properties.level_mm ?? n.z);
    const mesh = extrudePolygon(poly, riserMm * MM, (levelMm - riserMm) * MM, 0x155e75);
    if (!mesh) continue;
    applyMat(mesh, 'stair_winder', n, matConfig);
    tag(mesh, 'stair_winder', n.id, resolveStoreyId(n, nodeMap));
    scene.add(mesh);
  }

  // The monolithic spiral: one helical waist with the steps on top.
  for (const n of nodes.filter((n) => n.type === 'stair_helix')) {
    const geo = buildHelixGeometry({
      centerXMm: n.x,
      centerYMm: n.y,
      baseZMm: Number(n.properties.base_z_mm ?? 0),
      innerMm: Number(n.properties.inner_mm ?? 100),
      outerMm: Number(n.properties.outer_mm ?? 1100),
      startRad: Number(n.properties.start_rad ?? 0),
      deltaRad: Number(n.properties.delta_rad ?? 0.3),
      steps: Number(n.properties.steps ?? 2),
      riserMm: Number(n.properties.riser_mm ?? 170),
      treadMm: Number(n.properties.tread_mm ?? 280),
      waistMm: Number(n.properties.thickness_mm ?? 150),
    });
    if (!geo) continue;
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ roughness: 0.7, side: THREE.DoubleSide }),
    );
    applyMat(mesh, 'stair_helix', n, matConfig);
    tag(mesh, 'stair_helix', n.id, resolveStoreyId(n, nodeMap));
    scene.add(mesh);
  }

  // The centre pole of a spiral stair.
  for (const n of nodes.filter((n) => n.type === 'stair_column')) {
    const r = Number(n.properties.radius_mm ?? 0);
    const h = Number(n.properties.height_mm ?? 0);
    const baseZ = Number(n.properties.base_z_mm ?? 0);
    if (!(r > 0 && h > 0)) continue;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(r * MM, r * MM, h * MM, 24),
      new THREE.MeshStandardMaterial({ roughness: 0.6 }),
    );
    mesh.position.copy(v3(n.x, n.y, baseZ + h / 2));
    applyMat(mesh, 'stair_column', n, matConfig);
    tag(mesh, 'stair_column', n.id, resolveStoreyId(n, nodeMap));
    scene.add(mesh);
  }

  for (const n of nodes.filter((n) => n.type === 'stair_base_beam')) {
    const mesh = stairBaseBeamMesh(n);
    if (!mesh) continue;
    applyMat(mesh, 'stair_base_beam', n, matConfig);
    tag(mesh, 'stair_base_beam', n.id, resolveStoreyId(n, nodeMap));
    scene.add(mesh);
  }

  for (const n of nodes.filter((n) => n.type === 'stair_railing')) {
    for (const mesh of stairRailingMeshes(n)) {
      applyMat(mesh, 'stair_railing', n, matConfig);
      tag(mesh, 'stair_railing', n.id, resolveStoreyId(n, nodeMap));
      scene.add(mesh);
    }
  }

  // Sweep elements: a library profile swept along the guide line the graph
  // defines (1 ax = vertical, 2 = segment, 3+ = polyline). One pure compute
  // shared with the plan, sections and quantities.
  for (const n of nodes.filter((n) => n.type === 'sweep')) {
    const res = computeSweep(n, nodeMap, edges);
    if (!res.placed || res.solids.length === 0) continue;
    const geo = sweepBufferGeometry(res.solids, res.placed);
    if (!geo) continue;
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: nodeHex('sweep'), roughness: 0.7 }),
    );
    applyMat(mesh, 'sweep', n, matConfig);
    tag(mesh, 'sweep', n.id, resolveStoreyId(n, nodeMap));
    scene.add(mesh);
  }

  // Round detail members (gutters, downpipes) → cylinders.
  for (const n of nodes.filter((n) => ROOF_ROUND_DETAIL_TYPES.has(n.type))) {
    const mesh = roundMemberMesh(n);
    if (!mesh) continue;
    applyMat(mesh, n.type, n, matConfig);
    tag(mesh, n.type, n.id, resolveStoreyId(n, nodeMap));
    scene.add(mesh);
  }

  // Planar detail sheets (membrane, sheathing, insulation, soffit, valley flashing).
  for (const n of nodes.filter((n) => ROOF_SHEET_DETAIL_TYPES.has(n.type))) {
    const mesh = detailSheetMesh(n);
    if (!mesh) continue;
    applyMat(mesh, n.type, n, matConfig);
    tag(mesh, n.type, n.id, resolveStoreyId(n, nodeMap));
    scene.add(mesh);
  }

  // Room-derived covering (has_covering = true on room node, default true)
  for (const n of nodes.filter((n) => n.type === 'room')) {
    if (!roomHasCovering(n.properties)) continue;

    const { bot }  = getStoreyBand(n, nodeMap);
    const offsets  = parseContourOffsets(n.properties.covering_offset ?? n.properties.contour_offset);

    let poly = calcRoomPolygon(n, nodeMap, edges);
    if (!poly || poly.length < 3) continue;

    const layers = resolveCoveringLayers(n.properties);
    for (const layer of layers) {
      const covH = layer.heightMm * MM;
      const thickMm = layer.thicknessMm;
      const roomCovBaseM = bot * MM + layer.fromMm * MM;
      const ring = buildOGRing(poly, offsets, thickMm, covH, roomCovBaseM, nodeHex('covering'));
      if (!ring) continue;
      const mesh = applyOpeningCuts(ring, roomCovBaseM, covH);
      applyMat(mesh, 'covering', syntheticCoveringNodeForLayer(n, layer), matConfig);
      tag(mesh, 'covering', n.id, resolveStoreyId(n, nodeMap));
      scene.add(mesh as THREE.Object3D);
    }
  }
}

