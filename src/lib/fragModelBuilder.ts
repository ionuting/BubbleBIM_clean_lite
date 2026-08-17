/**
 * fragModelBuilder — builds a @thatopen/fragments FragmentsModel from BIM graph nodes.
 *
 * Each BIM node becomes an IFC-categorised item in the fragments model:
 *   wall    → IFCWALL       column / ax-with-column → IFCCOLUMN
 *   beam    → IFCBEAM       slab                    → IFCSLAB
 *   foundation → IFCFOOTING  room                   → IFCSPACE
 *   shell   → IFCROOF        covering               → IFCCOVERING
 *
 * Every item carries a `BubbleId` attribute (= node.id) and all node.properties
 * serialised as IFCLABEL attributes — ready for OBC metadata queries.
 *
 * Geometry uses simple Three.js BoxGeometry / ExtrudeGeometry primitives so no
 * extra WASM or CSG passes are needed here.  Visual fidelity comes from the
 * existing buildSceneGeometry() Three.js pipeline; this model is for:
 *   – OBF.Highlighter click-to-select  (raycasts fragments tiles)
 *   – OBC Clipper section fills         (ClipStyler on tiles)
 *   – Attribute / category queries      (getItemsByQuery, etc.)
 */

import * as THREE from 'three';
import type { FragmentsModels, NewElementData } from '@thatopen/fragments';
import { EMPTY_FRAG_MODEL_B64 } from './emptyFragModel.b64';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import type { MaterialConfig } from './materialConfig';
import {
  MM,
  parseColumnDims, parseBeamDims, parseSlabThickness, getNodeSlabThickness,
  getStoreyBand, getAxRealPos, getNodeBimPos, getConnectedNodes,
  calcWallGeometry, calcWallJoins, calcRoomPolygon, calcShellPolygon,
  parseContourOffsets, insetPolygon, calcSpanEffectiveEnds,
} from './bimGeometry';
import { wallHorizontalProfileLayerMesh, wallSolidLayerMesh, applyOpeningVoids, makeBoxOpeningCutter } from './bimGeometryThree';
import { resolveVisuals, applyNodeColorOverrides, hexToRgb01 } from './materialConfig';
import { resolveCoveringLayers } from './roomCovering';
import { resolveWallLayers, syntheticWallNodeForLayer } from './wallLayers';
import { getNodeLocalTransform } from './bimGeometry';

// ── Constants ─────────────────────────────────────────────────────────────────

/** The fragments model ID used for the BIM graph geometry. */
export const BIM_MODEL_ID = 'bubblgraph-bim';

/** BIM node types that are rendered as fragments tiles (not Three.js). */
export const FRAG_ELEMENT_TYPES = new Set([
  'column', 'ax', 'wall', 'beam', 'slab', 'foundation', 'room', 'shell', 'covering',
]);

// ── Colour helpers ─────────────────────────────────────────────────────────────

const DEFAULT_COLORS: Record<string, [number, number, number]> = {
  column:     [0.70, 0.50, 0.30],
  beam:       [0.60, 0.45, 0.30],
  wall:       [0.85, 0.82, 0.75],
  slab:       [0.70, 0.70, 0.70],
  foundation: [0.50, 0.40, 0.30],
  room:       [0.40, 0.60, 0.90],
  shell:      [0.70, 0.50, 0.40],
  covering:   [0.60, 0.60, 0.65],
  window:     [0.30, 0.50, 0.80],
  door:       [0.60, 0.40, 0.25],
};

function lambertMat(type: string, matConfig: MaterialConfig | null, propMaterial = '', nodeProps?: Record<string, unknown>): THREE.MeshLambertMaterial {
  const baseVis = resolveVisuals(type as any, propMaterial, matConfig);
  const vis = nodeProps ? applyNodeColorOverrides(baseVis, nodeProps) : baseVis;
  const [dr, dg, db] = DEFAULT_COLORS[type] ?? [0.5, 0.5, 0.5];
  let r = dr, g = dg, b = db, opacity = 1;
  if (vis?.color_3d) {
    [r, g, b] = hexToRgb01(vis.color_3d);
    opacity = vis.opacity_3d;
  }
  const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(r, g, b) });
  if (opacity < 1) { mat.transparent = true; mat.opacity = opacity; }
  return mat;
}

// ── Geometry helpers ───────────────────────────────────────────────────────────

function poseMatrix(x: number, y: number, z: number, rotY = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationY(rotY);
  m.setPosition(x, y, z);
  return m;
}

function extrudedShape(poly: { x: number; y: number }[], depthM: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(poly[0].x * MM, poly[0].y * MM);
  for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x * MM, poly[i].y * MM);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: depthM, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function ringGeo(
  outer: { x: number; y: number }[],
  inner: { x: number; y: number }[],
  heightM: number,
): THREE.BufferGeometry | null {
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
  return geo;
}

// ── Element builder helpers ────────────────────────────────────────────────────

function makeAttrs(n: BubbleGraphNode, category: string): NewElementData['attributes'] {
  const attrs: NewElementData['attributes'] = {
    _category:  { value: category },
    _guid:      { value: n.id },
    Name:       { value: n.name || n.id,  type: 'IFCLABEL' },
    BubbleId:   { value: n.id,            type: 'IFCLABEL' },
    BubbleType: { value: n.type,          type: 'IFCLABEL' },
  };
  for (const [k, v] of Object.entries(n.properties ?? {})) {
    if (v !== undefined && v !== null)
      attrs[k] = { value: String(v), type: 'IFCLABEL' };
  }
  return attrs;
}

function isValidGeo(geo: THREE.BufferGeometry): boolean {
  const pos = geo.getAttribute('position');
  if (!pos || pos.count === 0) return false;
  const arr = (pos as THREE.BufferAttribute).array;
  for (let i = 0; i < arr.length; i++) {
    if (!isFinite(arr[i])) return false;
  }
  return true;
}

/**
 * Ensure the geometry has an index buffer — fragments' representationFromGeometry
 * calls `index.array` directly and crashes on non-indexed geometry (e.g. ExtrudeGeometry).
 * Also removes the UV attribute which fragments doesn't need and may trip over.
 */
function prepareGeo(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  // Remove attributes fragments doesn't need to keep the payload small
  geo.deleteAttribute('uv');
  geo.deleteAttribute('uv1');
  // If already indexed, done
  if (geo.getIndex()) return geo;
  // Build a sequential index (non-indexed triangle soup → indexed)
  const count = geo.getAttribute('position').count;
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

function el(
  n: BubbleGraphNode,
  category: string,
  geo: THREE.BufferGeometry,
  mat: THREE.MeshLambertMaterial,
  globalTransform: THREE.Matrix4,
): NewElementData | null {
  if (!isValidGeo(geo)) return null;
  prepareGeo(geo);
  const identity = new THREE.Matrix4();
  return {
    attributes:    makeAttrs(n, category),
    globalTransform,
    samples: [{ localTransform: identity, representation: geo, material: mat }],
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build (or rebuild) the BIM graph fragments model.
 *
 * @returns The loaded FragmentsModel (tiles are added to scene via FragmentsManager listener).
 */
export async function buildBimFragmentsModel(
  core: FragmentsModels,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null,
): Promise<void> {
  // Dispose any previous model with the same ID
  if (core.models.list.has(BIM_MODEL_ID)) {
    await core.disposeModel(BIM_MODEL_ID);
  }

  // Load empty seed buffer (raw = already uncompressed FlatBuffer binary)
  const seedBytes = Uint8Array.from(atob(EMPTY_FRAG_MODEL_B64), (c) => c.charCodeAt(0));
  await core.load(seedBytes, { modelId: BIM_MODEL_ID, raw: true });

  // Verify the model was actually registered after load
  if (!core.models.list.has(BIM_MODEL_ID)) {
    throw new Error(`[fragModelBuilder] Seed model '${BIM_MODEL_ID}' failed to register after core.load(). Seed data may be incompatible — regenerate with: node backend/scripts/gen_empty_frag.mjs`);
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const wallJoins = calcWallJoins(nodes, edges);
  const identity = new THREE.Matrix4();
  const elements: (NewElementData | null)[] = [];

  // ── Columns (standalone column nodes) ─────────────────────────────────────
  for (const n of nodes.filter((n) => n.type === 'column')) {
    const storeyNode = n.parentId ? nodeMap.get(n.parentId) : undefined;
    if (!storeyNode) continue;
    const bot = Number(storeyNode.properties.bottomElevation ?? 0);
    const top = Number(storeyNode.properties.topElevation   ?? 3000);
    const h   = (top - bot) * MM;
    const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
    const ltr = getNodeLocalTransform(n);
    const mat = lambertMat('column', matConfig, String(n.properties.material ?? ''), n.properties);
    const geo = circular
      ? new THREE.CylinderGeometry(w / 2, w / 2, h, 18)
      : new THREE.BoxGeometry(w, h, d);
    elements.push(el(n, 'IFCCOLUMN', geo, mat,
      poseMatrix(n.x * MM + ltr.tx * MM, (bot + (top - bot) / 2) * MM + ltr.tz * MM, -n.y * MM - ltr.ty * MM)));
  }

  // ── Ax nodes with has_column ───────────────────────────────────────────────
  for (const n of nodes.filter((n) => n.type === 'ax')) {
    const { x: rx, y: ry } = getAxRealPos(n, nodeMap);
    const storeyNode = n.parentId ? nodeMap.get(n.parentId) : undefined;
    if (!storeyNode) continue;
    const hasCol = String(n.properties.has_column ?? '').toLowerCase() === 'true';
    if (!hasCol) continue; // non-column ax markers stay in Three.js infrastructure
    const bot = Number(storeyNode.properties.bottomElevation ?? 0);
    const top = Number(storeyNode.properties.topElevation   ?? 3000);
    const h   = (top - bot) * MM;
    const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
    const ltr = getNodeLocalTransform(n);
    const mat = lambertMat('column', matConfig, String(n.properties.material ?? ''), n.properties);
    const geo = circular
      ? new THREE.CylinderGeometry(w / 2, w / 2, h, 18)
      : new THREE.BoxGeometry(w, h, d);
    elements.push(el(n, 'IFCCOLUMN', geo, mat,
      poseMatrix(rx * MM + ltr.tx * MM, (bot + (top - bot) / 2) * MM + ltr.tz * MM, -ry * MM - ltr.ty * MM)));
  }

  // ── Walls — profile mesh with window/door openings (CSG) ─────────────────
  for (const wn of nodes.filter((n) => n.type === 'wall')) {
    const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins);
    if (!geo) continue;
    const dx = geo.exM - geo.sxM, dz = geo.ezM - geo.szM;
    const wallLen = Math.sqrt(dx * dx + dz * dz);
    if (wallLen < 1e-5) continue;

    const layers = resolveWallLayers(wn.properties, geo.wallH);
    const isArc = geo.footprint.length > 4;
    const cutters = geo.openings.map((op) => makeBoxOpeningCutter(op));

    for (const layer of layers) {
      const layerNode = syntheticWallNodeForLayer(wn, layer);
      const lambMat = lambertMat('wall', matConfig, String(layer.material ?? ''));
      const stdMat = new THREE.MeshStandardMaterial({ color: lambMat.color });
      let wallMesh: THREE.Mesh;
      try {
        wallMesh = (geo.openings.length === 0 || isArc)
          ? wallHorizontalProfileLayerMesh(geo, layer.fromMm, layer.toMm, stdMat)
          : wallSolidLayerMesh(geo, layer.fromMm, layer.toMm, stdMat);
      } catch {
        continue;
      }
      if (cutters.length > 0) wallMesh = applyOpeningVoids(wallMesh, cutters);

      const exportNode: BubbleGraphNode = {
        ...layerNode,
        id: `${wn.id}-wl-${layer.fromMm}`,
        name: `${wn.name || wn.id} wall ${layer.fromMm}-${layer.toMm}`,
      };
      elements.push(el(exportNode, 'IFCWALL', wallMesh.geometry, lambMat, identity));
    }

    // ── has_beam: beam along top of wall ──────────────────────────────────
    if (geo.beamDesc) {
      const b = geo.beamDesc;
      const dx2 = b.bx - b.ax, dz2 = b.bz - b.az;
      const bLen = Math.sqrt(dx2 * dx2 + dz2 * dz2);
      if (bLen > 1e-5) {
        const beamMat = lambertMat('beam', matConfig, '');
        const beamGeo = new THREE.BoxGeometry(bLen, b.height, b.width);
        // Beam centre in world space
        const bCx = (b.ax + b.bx) / 2;
        const bCy = b.baseY + b.height / 2;
        const bCz = (b.az + b.bz) / 2;
        // Synthetic wall-beam node (shares wn.id with a -beam suffix for uniqueness)
        const beamNode: BubbleGraphNode = {
          ...wn,
          id: wn.id + '-wallbeam',
          name: (wn.name || wn.id) + ' beam',
          type: 'beam',
        };
        elements.push(el(beamNode, 'IFCBEAM', beamGeo, beamMat,
          poseMatrix(bCx, bCy, bCz, Math.atan2(dz2, dx2))));
      }
    }
  }

  // ── Beams ─────────────────────────────────────────────────────────────────
  for (const bn of nodes.filter((n) => n.type === 'beam')) {
    const pts = getConnectedNodes(bn.id, edges, nodeMap);
    if (pts.length < 2) continue;
    const pA = getNodeBimPos(pts[0], nodeMap);
    const pB = getNodeBimPos(pts[1], nodeMap);
    const { sx, sy, ex, ey } = calcSpanEffectiveEnds(bn, pA, pB, pts[0], pts[1], nodeMap);
    const bLen = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2);
    if (bLen < 1e-3) continue;
    const { top } = getStoreyBand(bn, nodeMap);
    const { bw, bh } = parseBeamDims(String(bn.properties.beam_section ?? bn.properties.beam_type ?? 'B30x60'));
    const mat = lambertMat('beam', matConfig, String(bn.properties.material ?? ''));
    elements.push(el(bn, 'IFCBEAM',
      new THREE.BoxGeometry(bLen * MM, bh, bw), mat,
      poseMatrix(
        (sx + ex) / 2 * MM,
        top * MM - bh / 2,
        -(sy + ey) / 2 * MM,
        Math.atan2(-(ey - sy), ex - sx),
      )));
  }

  // ── Collect all opening cutters from all walls (for shell/covering CSG) ────
  const allCutters: ReturnType<typeof makeBoxOpeningCutter>[] = [];
  for (const wn of nodes.filter((n) => n.type === 'wall')) {
    const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins);
    if (!geo) continue;
    for (const op of geo.openings) allCutters.push(makeBoxOpeningCutter(op));
  }

  // ── Slabs ─────────────────────────────────────────────────────────────────
  for (const n of nodes.filter((n) => n.type === 'slab')) {
    const { top } = getStoreyBand(n, nodeMap);
    const th   = getNodeSlabThickness(n);
    const ltr  = getNodeLocalTransform(n);
    const mat  = lambertMat('slab', matConfig, String(n.properties.material ?? ''), n.properties);
    // tx/ty/tz in mm, BIM→Three mapping: tx→+X, ty→-Z, tz→+Y
    const txM = ltr.tx * MM; const tyM = -ltr.ty * MM; const tzM = ltr.tz * MM;

    // Try polygon from direct ax/column connections (edge-order perimeter)
    let poly = calcShellPolygon(n, nodeMap, edges);
    if (poly && poly.length >= 3) {
      const rawOff = parseContourOffsets(n.properties.contour_offset);
      const inward = rawOff.map((o) => -o);
      if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);
      const geo = extrudedShape(poly, th);
      geo.translate(txM, top * MM - th + tzM, tyM);
      elements.push(el(n, 'IFCSLAB', geo, mat, identity));
    } else {
      // Fallback: bounding box from sibling positions
      const sibs = nodes.filter((s) => s.parentId === n.parentId && s.type !== 'storey');
      const xs   = (sibs.length ? sibs : [n]).map((s) => s.x * MM);
      const zs   = (sibs.length ? sibs : [n]).map((s) => -s.y * MM);
      const cxM  = (Math.min(...xs) + Math.max(...xs)) / 2;
      const czM  = (Math.min(...zs) + Math.max(...zs)) / 2;
      const offM = parseContourOffsets(n.properties.contour_offset)[0] * MM;
      const sw   = Math.max(Math.max(...xs) - Math.min(...xs) + 2 * offM, 0.1);
      const sd   = Math.max(Math.max(...zs) - Math.min(...zs) + 2 * offM, 0.1);
      elements.push(el(n, 'IFCSLAB',
        new THREE.BoxGeometry(sw, th, sd), mat,
        poseMatrix(cxM + txM, top * MM - th / 2 + tzM, czM + tyM)));
    }
  }

  // ── Foundations ───────────────────────────────────────────────────────────
  for (const n of nodes.filter((n) => n.type === 'foundation')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const mat = lambertMat('foundation', matConfig, String(n.properties.material ?? ''));
    elements.push(el(n, 'IFCFOOTING',
      new THREE.BoxGeometry(1.2, 0.5, 1.2), mat,
      poseMatrix(n.x * MM, (bot - 250) * MM, -n.y * MM)));
  }

  // ── Rooms + room-derived slab + room-derived covering ─────────────────────
  for (const n of nodes.filter((n) => n.type === 'room')) {
    const { bot } = getStoreyBand(n, nodeMap);
    const roomH  = Number(n.properties.height ?? 2650);
    const vis    = resolveVisuals('room', String(n.properties.material ?? ''), matConfig);
    const mat    = lambertMat('room', matConfig, String(n.properties.material ?? ''));
    mat.transparent = true;
    mat.opacity = (vis?.opacity_3d ?? 1) * 0.12;

    let poly = calcRoomPolygon(n, nodeMap, edges);
    if (poly && poly.length >= 3) {
      const rawOff = parseContourOffsets(n.properties.contour_offset);
      if (rawOff.some((o) => o !== 0)) poly = insetPolygon(poly, rawOff.map((o) => -o));
    }

    // Room volume
    if (poly && poly.length >= 3) {
      const geo = extrudedShape(poly, roomH * MM);
      geo.translate(0, bot * MM, 0);
      elements.push(el(n, 'IFCSPACE', geo, mat, identity));
    } else {
      elements.push(el(n, 'IFCSPACE',
        new THREE.BoxGeometry(4, roomH * MM * 0.95, 4), mat,
        poseMatrix(n.x * MM, (bot + roomH / 2) * MM, -n.y * MM)));
    }

    // Room-derived slab (has_slab !== false)
    const hasSlab = n.properties.has_slab !== 'False' && n.properties.has_slab !== false;
    if (hasSlab) {
      const slabTh  = getNodeSlabThickness(n);
      const slabMat = lambertMat('slab', matConfig, String(n.properties.slab_material ?? ''));
      const slabNode: BubbleGraphNode = { ...n, id: n.id + '-slab', name: (n.name || n.id) + ' slab', type: 'slab' };
      if (poly && poly.length >= 3) {
        const slabGeo = extrudedShape(poly, slabTh);
        slabGeo.translate(0, (bot + roomH) * MM, 0);
        elements.push(el(slabNode, 'IFCSLAB', slabGeo, slabMat, identity));
      } else {
        elements.push(el(slabNode, 'IFCSLAB',
          new THREE.BoxGeometry(4, slabTh, 4), slabMat,
          poseMatrix(n.x * MM, (bot + roomH) * MM + slabTh / 2, -n.y * MM)));
      }
    }

    // Room-derived covering (has_covering !== false)
    const hasCov = n.properties.has_covering !== 'False' && n.properties.has_covering !== false;
    if (hasCov && poly && poly.length >= 3) {
      const offsets  = parseContourOffsets(n.properties.covering_offset ?? n.properties.contour_offset);
      const layers = resolveCoveringLayers(n.properties);
      for (const layer of layers) {
        const covH    = layer.heightMm * MM;
        const thickMm = layer.thicknessMm;
        const inward  = offsets.map((o) => -o);
        const outer   = insetPolygon(poly, inward);
        const inner   = insetPolygon(poly, inward.map((v) => v + thickMm));
        const geo     = ringGeo(outer, inner, covH);
        if (!geo) continue;
        geo.translate(0, (bot + layer.fromMm) * MM, 0);
        const covMat = lambertMat('covering', matConfig, layer.material);
        const covNode: BubbleGraphNode = {
          ...n,
          id: `${n.id}-cov-${layer.fromMm}`,
          name: `${n.name || n.id} covering ${layer.fromMm}-${layer.toMm}`,
          type: 'covering',
          properties: {
            ...n.properties,
            material: layer.material,
            ...(layer.color3d ? { color_3d: layer.color3d } : {}),
          },
        };
        let covMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
        if (allCutters.length) covMesh = applyOpeningVoids(covMesh, allCutters);
        elements.push(el(covNode, 'IFCCOVERING', covMesh.geometry, covMat, identity));
      }
    }
  }

  // ── Shell & Covering (ring extrusion from ax/column nodes) ─────────────────
  for (const n of nodes.filter((n) => n.type === 'shell' || n.type === 'covering')) {
    const { bot }   = getStoreyBand(n, nodeMap);
    const shellH    = Number(n.properties.height ?? 2800) * MM;
    const thickMm   = Number(n.properties.thickness ?? 200);
    const poly      = calcShellPolygon(n, nodeMap, edges);
    if (!poly) continue;
    const offsets   = parseContourOffsets(n.properties.contour_offset);
    const inward    = offsets.map((o) => -o);
    const outer     = insetPolygon(poly, inward);
    const inner     = insetPolygon(poly, inward.map((v) => v + thickMm));
    const geo       = ringGeo(outer, inner, shellH);
    if (!geo) continue;
    geo.translate(0, bot * MM, 0);
    // Apply window/door opening cuts (CSG) — same as WebIfcViewer
    let ringMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    if (allCutters.length) ringMesh = applyOpeningVoids(ringMesh, allCutters);
    const cat = n.type === 'shell' ? 'IFCROOF' : 'IFCCOVERING';
    const mat = lambertMat(n.type, matConfig, String(n.properties.material ?? ''));
    elements.push(el(n, cat, ringMesh.geometry, mat, identity));
  }

  // ── Push to model ─────────────────────────────────────────────────────────
  const valid = elements.filter((e): e is NewElementData => e !== null);
  if (valid.length === 0) return;
  const created = await core.editor.createElements(BIM_MODEL_ID, valid);
  if (!created) throw new Error('[fragModelBuilder] createElements returned null');
  // Force the renderer to process and display the new tiles
  await core.update(true);
}

/**
 * Query the fragments model for a node's localId by its BubbleId string.
 * Returns null if the model doesn't exist or the node isn't found.
 */
export async function getLocalIdByBubbleId(
  core: FragmentsModels,
  bubbleId: string,
): Promise<number | null> {
  const model = core.models.list.get(BIM_MODEL_ID);
  if (!model) return null;
  const results = await model.getItemsByQuery({
    attributes: { queries: [{ name: /^BubbleId$/, value: new RegExp(`^${bubbleId}$`) }] },
  });
  return results[0] ?? null;
}

/**
 * Query the fragments model for a BubbleId by localId.
 * Used by Highlighter's onHighlight event to map fragments hits → node IDs.
 */
export async function getBubbleIdByLocalId(
  core: FragmentsModels,
  localId: number,
): Promise<string | null> {
  const model = core.models.list.get(BIM_MODEL_ID);
  if (!model) return null;
  const items = await model.getItemsData([localId]);
  const item  = items[0];
  if (!item) return null;
  const bubbleAttr = item['BubbleId'];
  if (!bubbleAttr) return null;
  const raw = (bubbleAttr as { value?: unknown }).value;
  return raw != null ? String(raw) : null;
}
