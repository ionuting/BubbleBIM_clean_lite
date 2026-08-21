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
import { Vector3, Cuboid, Polygon, Opening, executeBooleanSubtractionMany } from 'opengeometry';
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
import { resolveVisuals, applyNodeColorOverrides, resolveWindowGlazing } from '@/lib/materialConfig';
import type { MaterialConfig } from '@/lib/materialConfig';
import { buildOpeningMeshes3, applyNodeLocalTransformThree } from '@/lib/bimGeometryThree';
import {
  resolveCoveringLayers, roomHasCovering, syntheticCoveringNodeForLayer,
} from '@/lib/roomCovering';
import { resolveWallLayers, syntheticWallNodeForLayer } from '@/lib/wallLayers';
import {
  computeFaceBasis, computeRoofFaces, orientPointsToward, parseTimberSection, placeDormer, placeSkylight,
  ROOF_LINEAR_DETAIL_TYPES, ROOF_ROUND_DETAIL_TYPES, ROOF_SHEET_DETAIL_TYPES,
  type DormerPlacement, type Pt3, type RoofFace3D, type SkylightPlacement, type WallPane,
} from '@/lib/roof';

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
export function buildOGScene(
  scene: THREE.Scene,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null = null,
): void {
  nodes = expandArrayNodes(nodes);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);

  // Openings from all walls, stored with their world-space vertical centre (metres).
  // Used by applyOpeningCuts() to punch holes in same-storey ring solids.
  const allOgOpenings: { opening: Opening; centerY: number }[] = [];

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
        // OG Cuboid — bake translation into center (OG rebakes vertices, mesh.position stays 0)
        const cuboid = new Cuboid({
          center: v3(pos.x + ltr.tx, pos.y + ltr.ty, bot + (top - bot) / 2 + ltr.tz),
          width:  w,
          height,
          depth:  d,
          color:  nodeHex('column'),
        });
        const mesh = cuboid as unknown as THREE.Mesh;
        tag(mesh, 'column', n.id, resolveStoreyId(n, nodeMap));
        applyMat(mesh, 'column', n, matConfig);
        scene.add(cuboid as unknown as THREE.Object3D);
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
        const cuboid = new Cuboid({
          center: v3(pos.x + ltrAx.tx, pos.y + ltrAx.ty, bot + (top - bot) / 2 + ltrAx.tz),
          width:  w,
          height,
          depth:  d,
          color:  nodeHex('column'),
        });
        const mesh = cuboid as unknown as THREE.Mesh;
        tag(mesh, 'column', n.id, resolveStoreyId(n, nodeMap));
        applyMat(mesh, 'column', n, matConfig);
        scene.add(cuboid as unknown as THREE.Object3D);
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

    const wallTopM = wg.solidSegs.reduce((mx, s) => Math.max(mx, s.baseY + s.height), wg.botM);
    const wallH    = wallTopM - wg.botM;
    if (wallH < 0.001) continue;

    // Use the pre-computed footprint (BIM mm → Three.js metres).
    // Footprint already includes join geometry (miter/butt corners).
    const corners: Vector3[] = wg.footprint.map(
      (p) => new Vector3(p.x * MM, 0, -p.y * MM),
    );

    const layers = resolveWallLayers(n.properties, wg.wallH);

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

    for (const layer of layers) {
      const layerBaseM = wg.botM + layer.fromMm * MM;
      const layerHM    = layer.heightMm * MM;
      if (layerHM < 0.001) continue;

      let wallMesh: THREE.Mesh | null = null;
      try {
        const wallPolygon = new Polygon({ vertices: corners, color });
        const wallSolid   = wallPolygon.extrude(layerHM);
        wallSolid.setTranslation(new Vector3(0, layerBaseM, 0));

        if (ogOpenings.length > 0) {
          try {
            const result = executeBooleanSubtractionMany(
              wallSolid,
              ogOpenings,
              { kernel: _ogKernel },
            );
            wallMesh = result as unknown as THREE.Mesh;
          } catch (boolErr) {
            if (ogOpenings.length === 1) {
              console.warn('[ogBimMapper] wall boolean cut failed, using solid fallback:', boolErr);
              wallMesh = wallSolid as unknown as THREE.Mesh;
            } else {
              console.warn('[ogBimMapper] multi-opening cut failed, retrying one-by-one:', boolErr);
              let current: OGBooleanResult | null = null;
              for (const opening of ogOpenings) {
                try {
                  const lhs = current ?? wallSolid;
                  current = executeBooleanSubtractionMany(lhs, [opening], { kernel: _ogKernel });
                } catch (singleErr) {
                  console.warn('[ogBimMapper] single wall opening skipped:', singleErr);
                }
              }
              wallMesh = current ? current as unknown as THREE.Mesh : wallSolid as unknown as THREE.Mesh;
            }
          }
        } else {
          wallMesh = wallSolid as unknown as THREE.Mesh;
        }
      } catch (err) {
        console.warn('[ogBimMapper] wall solid failed:', err);
      }

      if (wallMesh) {
        tag(wallMesh, 'wall', n.id, resolveStoreyId(n, nodeMap));
        applyMat(wallMesh, 'wall', syntheticWallNodeForLayer(n, layer), matConfig);
        applyNodeLocalTransformThree(wallMesh as THREE.Mesh, getNodeLocalTransform(n));
        scene.add(wallMesh as THREE.Object3D);
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
    const ring = buildOGRing(poly, offsets, thickMm, shellH, baseM, nodeHex('shell'));
    if (ring) {
      const mesh = applyOpeningCuts(ring, baseM, shellH);
      applyMat(mesh, 'shell', n, matConfig);
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
    const { faces } = computeRoofFaces(n, nodes, edges);
    const coveringThicknessM = Math.max(0.01, Number(n.properties.covering_thickness_mm ?? 40) * MM);

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
      if (skyHits.length > 0 || dormerHits.length > 0) {
        try {
          const solid = pitchedFaceSolid(face, coveringThicknessM);
          if (solid) {
            const cutters: Solid[] = [
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
        // A gable end (fronton) is masonry closing off the attic, not covering.
        const kind = face.role === 'gable_end' ? 'wall' : 'roof';
        applyMat(faceMesh, kind, kind === 'wall' ? null : n, matConfig);
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
          applyMat(roofMesh, 'roof', h.node, matConfig);
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

