/**
 * bimGeometryThree — Three.js-specific BIM mesh builders.
 *
 * Shared between Ara3DViewer and WebIfcViewer.
 * Engine-agnostic geometry math lives in bimGeometry.ts.
 */

import * as THREE from 'three';
import { Evaluator, Brush, SUBTRACTION } from 'three-bvh-csg';
import { MM, NODE_COLOR, type WallSegDesc, type OpeningMeshDesc, type WallGeometry, type NodeLocalTransform, type VoidInfo } from './bimGeometry';
import { type MaterialVisuals, type WindowGlazingConfig, BUILTIN_WINDOW_GLAZING, hexToRgb01 } from './materialConfig';
import { WINDOW_TYPE_MAP, DOOR_TYPE_MAP } from './elementLibrary';

// ─── CSG evaluator singleton ──────────────────────────────────────────────────
let _csgEval: Evaluator | null = null;
function getCsgEval(): Evaluator {
  if (!_csgEval) _csgEval = new Evaluator();
  return _csgEval;
}

// ─── BIM → Three.js coordinate conversion ────────────────────────────────────
// BIM X (East)  → Three +X
// BIM Y (North) → Three -Z  (negated: Babylon is left-handed, Three.js right-handed)
// BIM Z (Up)    → Three +Y

export function bim(bx: number, by: number, bz: number): THREE.Vector3 {
  return new THREE.Vector3(bx * MM, bz * MM, -by * MM);
}

/**
 * Apply a node's local transform to a Three.js Object3D.
 * Translation is in mm (BIM axes), rotation in degrees (local object axes).
 *
 * BIM → Three.js mapping:
 *   BIM tx (East)  → Three +X
 *   BIM ty (North) → Three -Z  (negated)
 *   BIM tz (Up)    → Three +Y
 *   BIM rx (tilt around East)  → Three rotation.x
 *   BIM ry (spin around Up)    → Three rotation.y
 *   BIM rz (roll around North) → Three rotation.z
 *
 * Rotations are applied in intrinsic XYZ order (Three.js default "XYZ" Euler).
 * They ADD to the existing rotation/position so callers can set base pose first.
 */
export function applyNodeLocalTransformThree(obj: THREE.Object3D, t: NodeLocalTransform) {
  if (t.tx !== 0 || t.ty !== 0 || t.tz !== 0) {
    const D2R = Math.PI / 180;
    // Compute local-axis offset: translate along object's own X/Y/Z after its base rotation
    const local = new THREE.Vector3(t.tx * MM, t.tz * MM, -t.ty * MM); // BIM→Three mapping (North→-Z)
    // Apply local translation in world space (for axis-aligned elements this is sufficient)
    obj.position.x += local.x;
    obj.position.y += local.y;
    obj.position.z += local.z;
    void D2R; // used below
  }
  if (t.rx !== 0 || t.ry !== 0 || t.rz !== 0) {
    const D2R = Math.PI / 180;
    obj.rotation.x += t.rx * D2R;
    obj.rotation.y += t.ry * D2R;  // rotate around Up = plan rotation
    obj.rotation.z += t.rz * D2R;
  }
}

// ─── Material cache ───────────────────────────────────────────────────────────

/**
 * Get (or create) a cached MeshStandardMaterial.
 * If `visuals` is provided (from materialConfig.resolveVisuals), its color and
 * opacity take precedence over the built-in NODE_COLOR table.
 * Cache key includes the hex color so per-material overrides produce distinct entries.
 */
export function getMat(
  cache: Map<string, THREE.MeshStandardMaterial>,
  type: string,
  alpha = 1,
  visuals?: MaterialVisuals | null,
): THREE.MeshStandardMaterial {
  const colorHex = visuals?.color_3d ?? null;
  const opacity  = visuals != null ? visuals.opacity_3d * alpha : alpha;
  const key = colorHex ? `custom:${colorHex}@${opacity}` : `${type}@${opacity}`;
  if (cache.has(key)) return cache.get(key)!;

  let r: number, g: number, b: number;
  if (colorHex) {
    [r, g, b] = hexToRgb01(colorHex);
  } else {
    [r, g, b] = NODE_COLOR[type] ?? [0.5, 0.5, 0.5];
  }

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(r, g, b),
    roughness: 0.7,
    metalness: 0.2,
  });
  if (opacity < 1) {
    mat.transparent = true;
    mat.opacity = opacity;
    mat.side = THREE.DoubleSide;
  }
  cache.set(key, mat);
  return mat;
}

// ─── Mesh primitives ──────────────────────────────────────────────────────────

/**
 * Box spanning between two XZ points (ax,az) → (bx,bz), in metres.
 */
export function spanBox3(
  ax: number, az: number, bx: number, bz: number,
  width: number, height: number, baseY: number,
): THREE.Mesh | null {
  // az/bz are already in Three.js Z space (negated from BIM Y by calcWallGeometry callers)
  const dx = bx - ax, dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-4) return null;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, height, width));
  mesh.position.set((ax + bx) / 2, baseY + height / 2, (az + bz) / 2);
  mesh.rotation.y = Math.atan2(dz, dx);
  return mesh;
}

/**
 * Sub-span wall segment box from descriptor.
 */
export function wallSegBox3(seg: WallSegDesc): THREE.Mesh | null {
  const { ax, az, bx, bz, tStart, tEnd, width, height, baseY } = seg;
  const dx = bx - ax, dz = bz - az;
  const wallLen = Math.sqrt(dx * dx + dz * dz);
  if (wallLen < 1e-6 || tEnd - tStart < 1e-6) return null;
  const ux = dx / wallLen, uz = dz / wallLen;
  const midT   = (tStart + tEnd) / 2;
  const segLen = tEnd - tStart;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(segLen, height, width));
  mesh.position.set(ax + ux * midT, baseY + height / 2, az + uz * midT);
  mesh.rotation.y = Math.atan2(dz, dx);
  return mesh;
}

/**
 * Build a single-mesh wall profile using THREE.ExtrudeGeometry with Shape holes.
 *
 * Why: the previous approach decomposed each wall into multiple BoxGeometry
 * segments around openings.  Adjacent segment faces share edges that produce
 * visible silhouette lines in elevation projections (TechnicalDrawings /
 * EdgesGeometry).  This function replaces all those segments with one clean
 * mesh whose only edges are the outer wall perimeter and the opening frames.
 *
 * Shape convention (wall-local space):
 *   X = distance along wall,   0 → wallLen  (metres)
 *   Y = vertical elevation,    0 → wallH    (metres, 0 = wall bottom)
 *   Z = through-wall depth,    0 → wallThick (extruded)
 *
 * The basis matrix transforms wall-local coords into Three.js world space:
 *   local X → world along-wall direction
 *   local Y → world up (+Y)
 *   local Z → world wall-normal direction (centred on wall centre-line)
 */
export function wallProfileMesh(
  geo: import('./bimGeometry').WallGeometry,
  mat: THREE.Material,
): THREE.Mesh {
  const { sxM, szM, exM, ezM, wallThick, botM, solidSegs, openings } = geo;

  const wdx = exM - sxM, wdz = ezM - szM;
  const wallLen = Math.sqrt(wdx * wdx + wdz * wdz);
  if (wallLen < 1e-5) throw new Error('zero-length wall');
  const wux = wdx / wallLen, wuz = wdz / wallLen;
  // Wall normal in XZ (perpendicular to wall, pointing "left" of travel)
  const wnx = -wuz, wnz = wux;

  // Wall height: maximum topY across all solid segments
  const topM = solidSegs.length > 0
    ? solidSegs.reduce((mx, s) => Math.max(mx, s.baseY + s.height), botM)
    : botM + 3;
  const wallH = topM - botM;

  // ── 2-D shape in wall-local XY ───────────────────────────────────────────
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(wallLen, 0);
  shape.lineTo(wallLen, wallH);
  shape.lineTo(0, wallH);
  shape.closePath();

  // One rectangular hole per opening (tS is the LEFT EDGE along the wall)
  for (const op of openings) {
    if (op.oW <= 1e-5 || op.oH <= 1e-5) continue;
    const hole = new THREE.Path();
    hole.moveTo(op.tS,          op.sill);
    hole.lineTo(op.tS + op.oW, op.sill);
    hole.lineTo(op.tS + op.oW, op.sill + op.oH);
    hole.lineTo(op.tS,          op.sill + op.oH);
    hole.closePath();
    shape.holes.push(hole);
  }

  // ── Extrude along local +Z (wall normal direction) ─────────────────────
  const extGeo = new THREE.ExtrudeGeometry(shape, { depth: wallThick, bevelEnabled: false });

  // ── Transform from wall-local to Three.js world ─────────────────────────
  // Basis columns: [along | up | normal | origin]
  // The wall origin is shifted by -wallThick/2 along the normal so the wall
  // is centred on its centre-line (matching the BoxGeometry approach).
  const ox = sxM + wnx * (-wallThick / 2);
  const oz = szM + wnz * (-wallThick / 2);

  extGeo.applyMatrix4(new THREE.Matrix4().set(
    wux,  0, wnx,  ox,
      0,  1,   0,  botM,
    wuz,  0, wnz,  oz,
      0,  0,   0,  1,
  ));

  extGeo.computeVertexNormals(); // recalculate normals after manual transform
  return new THREE.Mesh(extGeo, mat);
}

// ─── CSG-based wall with voids ────────────────────────────────────────────────

/**
 * Solid wall mesh (no Shape holes) — base geometry for the CSG subtract pipeline.
 * Identical to wallProfileMesh but openings are not punched as 2-D Shape holes.
 */
export function wallSolidMesh(
  geo: WallGeometry,
  mat: THREE.Material,
): THREE.Mesh {
  const { sxM, szM, exM, ezM, wallThick, botM, solidSegs } = geo;
  const wdx = exM - sxM, wdz = ezM - szM;
  const wallLen = Math.sqrt(wdx * wdx + wdz * wdz);
  if (wallLen < 1e-5) throw new Error('zero-length wall');
  const wux = wdx / wallLen, wuz = wdz / wallLen;
  const wnx = -wuz, wnz = wux;
  const topM = solidSegs.length > 0
    ? solidSegs.reduce((mx, s) => Math.max(mx, s.baseY + s.height), botM)
    : botM + 3;
  const wallH = topM - botM;

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(wallLen, 0);
  shape.lineTo(wallLen, wallH);
  shape.lineTo(0, wallH);
  shape.closePath();

  const extGeo = new THREE.ExtrudeGeometry(shape, { depth: wallThick, bevelEnabled: false });
  const ox = sxM + wnx * (-wallThick / 2);
  const oz = szM + wnz * (-wallThick / 2);
  extGeo.applyMatrix4(new THREE.Matrix4().set(
    wux,  0, wnx,  ox,
      0,  1,   0,  botM,
    wuz,  0, wnz,  oz,
      0,  0,   0,  1,
  ));
  extGeo.computeVertexNormals();
  return new THREE.Mesh(extGeo, mat);
}

// ─── Horizontal-profile wall (footprint extruded vertically) ──────────────────

/**
 * Build a wall mesh by extruding the horizontal footprint polygon vertically.
 *
 * Unlike `wallProfileMesh` (vertical profile, extruded along normal), this
 * approach embeds join geometry (miter/butt corners) directly as polygon
 * vertices — no CSG needed for wall joins.
 *
 * The footprint polygon comes from `WallGeometry.footprint` (BIM mm, CCW).
 * Extrusion direction = world +Y (up), depth = wall height.
 *
 * Openings must be subtracted via CSG separately (they cannot be Shape holes
 * in a horizontal profile — the holes are vertical, not horizontal).
 *
 * Convention (wall-local space):
 *   Shape XY = horizontal plan (BIM mm → Three.js XZ)
 *   Extrude Z = vertical (becomes Three.js +Y after rotation)
 */
export function wallHorizontalProfileMesh(
  geo: import('./bimGeometry').WallGeometry,
  mat: THREE.Material,
): THREE.Mesh {
  const { footprint, botM, wallH } = geo;

  if (footprint.length < 3) throw new Error('degenerate footprint');
  if (wallH < 1e-4) throw new Error('zero-height wall');

  // Build Shape from footprint (BIM mm → Three.js metres).
  // Shape local X = BIM X * MM → stays as Three X after rotation.
  // Shape local Y = BIM Y * MM → becomes Three -Z after -90° X rotation (z' = -y).
  // Do NOT negate Y here — the rotation handles the BIM→Three Z flip.
  const shape = new THREE.Shape(
    footprint.map((p) => new THREE.Vector2(p.x * MM, p.y * MM)),
  );

  // Extrude along local +Z. After rotation this becomes world +Y.
  const extGeo = new THREE.ExtrudeGeometry(shape, {
    depth: wallH * MM,
    bevelEnabled: false,
  });

  // Rotate so extrusion axis (local +Z) maps to world +Y (up).
  // ExtrudeGeometry produces shape in XY, extruded along +Z.
  // We need shape in XZ, extruded along +Y:
  //   local X → world X  (unchanged)
  //   local Y → world -Z (already done by shape vertex mapping)
  //   local Z → world +Y (rotation around X by -90°)
  extGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

  // Translate to base elevation
  extGeo.translate(0, botM, 0);

  extGeo.computeVertexNormals();
  return new THREE.Mesh(extGeo, mat);
}

/** Horizontal-profile wall band between from_mm and to_mm (relative to botM). */
export function wallHorizontalProfileLayerMesh(
  geo: import('./bimGeometry').WallGeometry,
  fromMm: number,
  toMm: number,
  mat: THREE.Material,
): THREE.Mesh {
  const { footprint, botM } = geo;
  const layerH = (toMm - fromMm) * MM;
  if (footprint.length < 3 || layerH < 1e-6) throw new Error('degenerate wall layer');

  const shape = new THREE.Shape(
    footprint.map((p) => new THREE.Vector2(p.x * MM, p.y * MM)),
  );
  const extGeo = new THREE.ExtrudeGeometry(shape, {
    depth: layerH,
    bevelEnabled: false,
  });
  extGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  extGeo.translate(0, botM + fromMm * MM, 0);
  extGeo.computeVertexNormals();
  return new THREE.Mesh(extGeo, mat);
}

/** Solid vertical-profile wall band (CSG base) between from_mm and to_mm (relative to botM). */
export function wallSolidLayerMesh(
  geo: WallGeometry,
  fromMm: number,
  toMm: number,
  mat: THREE.Material,
): THREE.Mesh {
  const { sxM, szM, exM, ezM, wallThick, botM } = geo;
  const fromM = fromMm * MM;
  const toM = toMm * MM;
  const layerH = toM - fromM;
  if (layerH < 1e-6) throw new Error('zero-height wall layer');

  const wdx = exM - sxM, wdz = ezM - szM;
  const wallLen = Math.sqrt(wdx * wdx + wdz * wdz);
  if (wallLen < 1e-5) throw new Error('zero-length wall');
  const wux = wdx / wallLen, wuz = wdz / wallLen;
  const wnx = -wuz, wnz = wux;

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(wallLen, 0);
  shape.lineTo(wallLen, layerH);
  shape.lineTo(0, layerH);
  shape.closePath();

  const extGeo = new THREE.ExtrudeGeometry(shape, { depth: wallThick, bevelEnabled: false });
  const ox = sxM + wnx * (-wallThick / 2);
  const oz = szM + wnz * (-wallThick / 2);
  extGeo.applyMatrix4(new THREE.Matrix4().set(
    wux,  0, wnx,  ox,
      0,  1,   0,  botM + fromM,
    wuz,  0, wnz,  oz,
      0,  0,   0,  1,
  ));
  extGeo.computeVertexNormals();
  return new THREE.Mesh(extGeo, mat);
}

/**
 * Read the CSG cut depth from a window/door node's `cut_depth` property.
 * Default: 1000 mm = 1.0 m (500 mm each side — cuts through any reasonable wall thickness).
 */
function nodeOpeningCutDepth(node: OpeningMeshDesc['node']): number {
  if (!node) return 1.0;
  const v = node.properties.cut_depth;
  return v != null ? Math.max(0.05, Number(v) * MM) : 1.0;
}

export function makeBoxOpeningCutter(op: OpeningMeshDesc): Brush {
  const cutDepthM = nodeOpeningCutDepth(op.node);
  const b = new Brush(new THREE.BoxGeometry(op.oW, op.oH, cutDepthM));
  b.position.set(op.cx, op.botY + op.sill + op.oH / 2, op.cz);
  b.rotation.y = Math.atan2(op.uz, op.ux);
  b.updateMatrixWorld();
  return b;
}

/**
 * Box cutter brush sized from the IFC element's own bounding box.
 * ifcWidthM / ifcHeightM come from IFCGroupInfo.widthM / heightM.
 */
export function makeIfcOpeningCutter(
  ifcWidthM: number,
  ifcHeightM: number,
  op: OpeningMeshDesc,
): Brush {
  const cutDepthM = nodeOpeningCutDepth(op.node);
  const b = new Brush(new THREE.BoxGeometry(ifcWidthM, ifcHeightM, cutDepthM));
  b.position.set(op.cx, op.botY + op.sill + ifcHeightM / 2, op.cz);
  b.rotation.y = Math.atan2(op.uz, op.ux);
  b.updateMatrixWorld();
  return b;
}

/**
 * CSG-subtract all opening cutters from a wall (or ring) solid mesh.
 *
 * The input mesh's own matrix (position/rotation/scale) is baked into a geometry
 * clone before the subtract, so this works for:
 *   - wall meshes (geometry already in world space, identity matrix → no change)
 *   - ring meshes (geometry at local origin, mesh.position.y = botM → baked in)
 *
 * Each cutter is applied in its own try/catch so a failure on one opening
 * (e.g. non-manifold intermediate geometry, near-coincident faces) does not
 * discard the cuts that already succeeded.  At least the first N-1 openings
 * will always be cut even if the N-th one is problematic.
 *
 * On total CSG failure the original solid wall mesh is returned so rendering never breaks.
 */
export function applyOpeningVoids(
  wallMesh: THREE.Mesh,
  cutters: Brush[],
): THREE.Mesh {
  if (!cutters.length) return wallMesh;

  const evaluator = getCsgEval();
  // Bake the mesh's own transform into a cloned geometry so CSG operates in world space.
  // Walls have baked geometry (identity matrix) — this is a no-op for them.
  // Ring meshes carry a Y-translation that must be folded in.
  wallMesh.updateMatrix();
  const geoForCsg = wallMesh.geometry.clone().applyMatrix4(wallMesh.matrix);
  let brushA = new Brush(geoForCsg, wallMesh.material as THREE.Material);
  brushA.updateMatrixWorld();

  let anyCut = false;
  for (const cutter of cutters) {
    // Each subtraction is isolated: a failure on one opening keeps all previous cuts.
    try {
      const target = new Brush();
      evaluator.evaluate(brushA, cutter, SUBTRACTION, target);
      target.material = wallMesh.material as THREE.Material;
      brushA = target;
      brushA.updateMatrixWorld();
      anyCut = true;
    } catch (cutErr) {
      console.warn('[CSG] single opening cut skipped (degenerate geometry or non-manifold result):', cutErr);
    }
  }

  if (!anyCut) return wallMesh;
  const result = new THREE.Mesh(brushA.geometry, wallMesh.material as THREE.Material);
  result.userData = { ...wallMesh.userData };
  return result;
}

// ─── Void boolean cutters ─────────────────────────────────────────────────────

/**
 * Create a box Brush cutter for a void node.
 * Position uses Three.js axes: BIM X→X, BIM Y→−Z, BIM Z→Y.
 */
export function makeBoxVoidCutter(v: VoidInfo): Brush {
  const b = new Brush(new THREE.BoxGeometry(v.width, v.height, v.depth));
  b.position.set(v.cx_mm * MM, v.cz_mm * MM, -v.cy_mm * MM);
  b.updateMatrixWorld();
  return b;
}

/**
 * Create a cylinder Brush cutter for a void node.
 * The cylinder axis is vertical (Y up in Three.js = BIM Z).
 */
export function makeCylinderVoidCutter(v: VoidInfo): Brush {
  const geo = new THREE.CylinderGeometry(v.radius, v.radius, v.height, v.radialSegments);
  const b = new Brush(geo);
  b.position.set(v.cx_mm * MM, v.cz_mm * MM, -v.cy_mm * MM);
  b.updateMatrixWorld();
  return b;
}

/**
 * CSG-subtract void cutters from a solid mesh.
 * Mirrors applyOpeningVoids but accepts VoidInfo[] and builds cutters inline.
 * On any CSG failure the original mesh is returned unchanged.
 */
export function applyVoids(mesh: THREE.Mesh, voids: VoidInfo[]): THREE.Mesh {
  if (!voids.length) return mesh;
  const cutters = voids.map((v) =>
    v.shape === 'cylinder' ? makeCylinderVoidCutter(v) : makeBoxVoidCutter(v),
  );
  try {
    const evaluator = getCsgEval();
    mesh.updateMatrix();
    const geoForCsg = mesh.geometry.clone().applyMatrix4(mesh.matrix);
    let brushA = new Brush(geoForCsg, mesh.material as THREE.Material);
    brushA.updateMatrixWorld();
    for (const cutter of cutters) {
      const target = new Brush();
      evaluator.evaluate(brushA, cutter, SUBTRACTION, target);
      target.material = mesh.material as THREE.Material;
      brushA = target;
      brushA.updateMatrixWorld();
    }
    const result = new THREE.Mesh(brushA.geometry, mesh.material as THREE.Material);
    result.userData = { ...mesh.userData };
    return result;
  } catch (err) {
    console.warn('[CSG] Void subtract failed, returning solid mesh:', err);
    return mesh;
  }
}

/**
 * Apply global window glazing overrides to an IFC-loaded group.
 * Transparent parts (opacity < 0.99) → glass overrides.
 * Opaque parts → frame overrides.
 */
export function applyIfcGlazingOverrides(group: THREE.Object3D, glazing: WindowGlazingConfig): void {
  const [fr, fg, fb] = hexToRgb01(glazing.frame_color);
  const [gr, gg, gb] = hexToRgb01(glazing.glass_color);
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mat = child.material as THREE.MeshStandardMaterial;
    if (!mat || !mat.isMeshStandardMaterial) return;
    if (mat.transparent && mat.opacity < 0.99) {
      // Glass part
      mat.color.setRGB(gr, gg, gb);
      mat.opacity = glazing.glass_opacity;
      mat.roughness = glazing.glass_roughness;
      mat.metalness = glazing.glass_metalness;
      mat.transparent = true;
      mat.depthWrite = false;
      mat.needsUpdate = true;
    } else {
      // Frame part
      mat.color.setRGB(fr, fg, fb);
      mat.roughness = glazing.frame_roughness;
      mat.metalness = glazing.frame_metalness;
      mat.needsUpdate = true;
    }
  });
}

export function buildOpeningMeshes3(
  op: OpeningMeshDesc,
  _matCache: Map<string, THREE.MeshStandardMaterial>,
  _nodeType: string,
  visuals?: MaterialVisuals | null,
  glazing?: WindowGlazingConfig | null,
): THREE.Mesh[] {
  const { isDoor, cx, cz, ux, uz, nx, nz, wallThick, botY, oW, oH, sill, PROFILE } = op;
  const meshes: THREE.Mesh[] = [];
  const frameY = botY + sill;
  const gCfg = glazing ?? BUILTIN_WINDOW_GLAZING;

  // ── Detect double opening ──────────────────────────────────────────────────
  let isDouble = false;
  if (op.node) {
    const nodeDouble = op.node.properties.double;
    if (nodeDouble === true || nodeDouble === 'true' || nodeDouble === 'True') {
      isDouble = true;
    } else if (isDoor) {
      const typeId = String(op.node.properties.door_type ?? '');
      const entry = typeId ? DOOR_TYPE_MAP.get(typeId) : undefined;
      isDouble = entry ? (entry.leaf_count === 2 || entry.swing === 'double') : false;
    } else {
      const typeId = String(op.node.properties.window_type ?? '');
      const entry = typeId ? WINDOW_TYPE_MAP.get(typeId) : undefined;
      isDouble = entry?.opening === 'double';
    }
  }

  // ── Frame material — from global glazing config ───────────────────────────
  const [fr, fg, fb] = hexToRgb01(gCfg.frame_color);
  const frameMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(fr, fg, fb),
    roughness: gCfg.frame_roughness,
    metalness: gCfg.frame_metalness,
  });

  const ang = Math.atan2(uz, ux);
  const addFrameBox = (fW: number, fH: number, fD: number, tOffset: number, nOffset: number, fBaseY: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(fW, fH, fD), frameMat);
    mesh.position.set(cx + ux * tOffset + nx * nOffset, fBaseY + fH / 2, cz + uz * tOffset + nz * nOffset);
    mesh.rotation.y = ang;
    meshes.push(mesh);
  };

  // ── Contour frame — INSIDE the opening, spanning full wall thickness ──────
  // Left stile
  addFrameBox(PROFILE, oH, wallThick, -oW / 2 + PROFILE / 2, 0, frameY);
  // Right stile
  addFrameBox(PROFILE, oH, wallThick, oW / 2 - PROFILE / 2, 0, frameY);
  // Top rail (spans between stiles)
  addFrameBox(oW - PROFILE * 2, PROFILE, wallThick, 0, 0, frameY + oH - PROFILE);
  // Bottom rail (windows only)
  if (!isDoor) {
    addFrameBox(oW - PROFILE * 2, PROFILE, wallThick, 0, 0, frameY);
  }

  // Centre mullion for double elements (100 mm wide = 0.1 m)
  if (isDouble) {
    const MULLION = 0.10;
    addFrameBox(MULLION, oH - PROFILE * (isDoor ? 1 : 2), wallThick, 0, 0, frameY + (isDoor ? 0 : PROFILE));
  }

  // ── Glass / door panel ─────────────────────────────────────────────────────
  const panelThick = isDoor ? 0.04 : 0.008;
  // Inner clearance (inside frame contour)
  const innerW = oW - PROFILE * 2;
  const innerH = oH - PROFILE * (isDoor ? 1 : 2); // doors: no bottom rail

  if (isDoor) {
    const [pr, pg, pb] = visuals?.color_3d ? hexToRgb01(visuals.color_3d) : [0.55, 0.38, 0.18];
    const doorMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(pr, pg, pb),
      roughness: 0.65,
      metalness: 0.02,
    });
    const MULLION = isDouble ? 0.10 : 0;
    const leafW = isDouble ? (innerW - MULLION) / 2 - 0.005 : innerW;
    if (isDouble) {
      for (const side of [-1, 1] as const) {
        const leaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, innerH, panelThick), doorMat);
        leaf.position.set(cx + ux * (side * (leafW / 2 + MULLION / 2 + 0.002)), frameY + innerH / 2, cz + uz * (side * (leafW / 2 + MULLION / 2 + 0.002)));
        leaf.rotation.y = ang;
        meshes.push(leaf);
      }
    } else {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(leafW, innerH, panelThick), doorMat);
      panel.position.set(cx, frameY + innerH / 2, cz);
      panel.rotation.y = ang;
      meshes.push(panel);
    }
  } else {
    // Window glass — from global glazing config
    const [gr, gg, gb] = hexToRgb01(gCfg.glass_color);
    const glassMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(gr, gg, gb),
      transparent: true,
      opacity: gCfg.glass_opacity,
      roughness: gCfg.glass_roughness,
      metalness: gCfg.glass_metalness,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const MULLION = isDouble ? 0.10 : 0;
    const glassW = isDouble ? (innerW - MULLION) / 2 - 0.005 : innerW;
    const glassBaseY = frameY + PROFILE;
    if (isDouble) {
      for (const side of [-1, 1] as const) {
        const pane = new THREE.Mesh(new THREE.BoxGeometry(glassW, innerH, panelThick), glassMat);
        pane.position.set(cx + ux * (side * (glassW / 2 + MULLION / 2 + 0.002)), glassBaseY + innerH / 2, cz + uz * (side * (glassW / 2 + MULLION / 2 + 0.002)));
        pane.rotation.y = ang;
        meshes.push(pane);
      }
    } else {
      const pane = new THREE.Mesh(new THREE.BoxGeometry(glassW, innerH, panelThick), glassMat);
      pane.position.set(cx, glassBaseY + innerH / 2, cz);
      pane.rotation.y = ang;
      meshes.push(pane);
    }
  }

  // ── Reveals (wall jambs) — strips lining the inside of the opening tunnel ──
  const revMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.92, 0.91, 0.88),
    side: THREE.DoubleSide,
  });
  // Left and right jamb reveals
  for (const side of [-1, 1] as const) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.002, oH, wallThick), revMat);
    jamb.position.set(
      cx + ux * (side * oW / 2),
      frameY + oH / 2,
      cz + uz * (side * oW / 2),
    );
    jamb.rotation.y = ang;
    meshes.push(jamb);
  }
  // Top (head) reveal
  {
    const head = new THREE.Mesh(new THREE.BoxGeometry(oW, 0.002, wallThick), revMat);
    head.position.set(cx, frameY + oH, cz);
    head.rotation.y = ang;
    meshes.push(head);
  }
  // Bottom (sill) reveal — only for windows
  if (!isDoor) {
    const sillRev = new THREE.Mesh(new THREE.BoxGeometry(oW, 0.002, wallThick), revMat);
    sillRev.position.set(cx, frameY, cz);
    sillRev.rotation.y = ang;
    meshes.push(sillRev);
  }

  return meshes;
}
