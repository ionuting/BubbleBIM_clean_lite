/**
 * IFCRigZoneModifier.ts
 *
 * Adapts the ZoneModifier pattern from compontent-editor to work directly
 * with BubbleBIM's auto-rig system.
 *
 * Each rig axis (from IFCPlanView) becomes an axis-strip zone:
 *   - dir='X' axis at posX → strip polygon centered on X in the XZ plane
 *   - dir='Y' axis at posY → strip polygon centered on Z in the XZ plane
 *
 * When a rig axis is dragged, applyDisplacement() is called and:
 *   1. All BREP vertices whose baseline world position falls inside the strip
 *      are moved by (dx, 0, dz) in world space, then transformed back to local.
 *   2. The modified points are written back to the FragmentsModel via
 *      FRAGS.EditRequest (CREATE_REPRESENTATION on first edit, UPDATE after).
 *   3. fragsModels.update(true) triggers a live Three.js scene re-render.
 *
 * Live drag preview (zero-allocation, 60fps):
 *   prepareDrag(axisId) → DragContext
 *   liveDisplace(ctx, deltaMm) → mutates THREE.BufferAttribute directly
 *   commitDrag(ctx, totalDeltaMm) → writeFrags + fragsModels.update
 *   cancelDrag(ctx) → restore positions from ctx.basePositions
 */

import * as FRAGS from '@thatopen/fragments';
import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import {
  toWorld, fromWorld, pointInPolygonXZ,
  makeAxisStripPolygon,
} from './ifcBrepHelpers';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RigAxisDef {
  id:         string;
  dir:        'X' | 'Y';
  /** Current world position in METRES (IFC coords, already converted from mm). */
  positionM:  number;
  /** Original position at rig generation time — used for ownership snap. */
  originM:    number;
  /** Human label (e.g. "1", "A") */
  label:      string;
  /** Half-width of the ownership zone in metres.
   *  If omitted, defaults to STRIP_HALF_WIDTH_M (0.25m). */
  halfWidthM?: number;
}

type Pt3 = [number, number, number];

interface SampleRecord {
  sampleId:        number;
  item:            number;
  material:        number;
  representation:  number;
  localTransform:  number;
}

/** One BREP representation that overlaps with a zone strip. */
interface AffectedRep {
  repId:          number;
  baseline:       (Pt3 | null)[];   // snapshot at addAxis() time, never mutated
  current:        (Pt3 | null)[];   // mutated on each displacement
  primarySample:  SampleRecord;
  /** Resolved numeric ID of the cloned representation (null before first write). */
  clonedRepId:    string | number | null;
}

interface ZoneState {
  axisId:       string;
  dir:          'X' | 'Y';
  polygon:      [number, number][];  // XZ strip polygon (world metres, at originM)
  baseY:        number;
  height:       number;
  dx:           number;              // cumulative world displacement (metres)
  dz:           number;
  /** Pre-computed at addAxis() time: { sampleId → Set<pointIndex> } */
  ownedIndices: Map<number, Set<number>>;
  affectedReps: AffectedRep[];
}

interface ModelCache {
  allGT:      Map<number, FRAGS.RawGlobalTransformData>;
  allLT:      Map<number, FRAGS.RawTransformData>;
  repSamples: Map<number, SampleRecord[]>;
  allReps:    Map<number, FRAGS.RawRepresentation>;
}

export interface DragContext {
  axisId:  string;
  dir:     'X' | 'Y';
  /**
   * Pre-computed list of vertex moves for O(k) per-frame displacement.
   * baseLocal is the snapshot at drag-start (after previous commits).
   * localDir is the world +X or +Z direction expressed in local BREP space.
   */
  affected: Array<{
    rep:       AffectedRep;
    ptIdx:     number;
    baseLocal: Pt3;
    localDir:  Pt3;   // unit vector in local space corresponding to world X (or Z)
  }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Half-width of each axis strip in metres.
 * Vertices within this distance of the axis baseline are bound to it.
 * Default = 0.25 m (250 mm), matching the SNAP_MM=500 / 2 convention.
 */
const STRIP_HALF_WIDTH_M = 0.25;

/**
 * Y-range (metres) used for the strip inclusion test.
 * Axes are vertical strips so we want ALL vertices regardless of elevation.
 * Use an intentionally large range to cover any IFC building.
 */
const STRIP_MIN_Y = -200;
const STRIP_MAX_Y =  200;

// ── Gizmo visual constants ────────────────────────────────────────────────────

const GIZMO_BOX_COLOR      = 0x00ccff;
const GIZMO_BOX_COLOR_MOVED= 0xff9900;
const GIZMO_ARROW_X_COLOR  = 0xff4444;
const GIZMO_ARROW_Z_COLOR  = 0x4444ff;
const GIZMO_SHAFT_R        = 0.04;
const GIZMO_ARROW_HEAD_R   = 0.12;
const GIZMO_ARROW_HEAD_LEN = 0.5;
const GIZMO_ARROW_LEN      = 2.0;

/** Create a wireframe box from a zone's polygon + baseY/height, clamped to model bbox. */
function makeZoneBox(
  zone: ZoneState,
  brepBbox?: { minX: number; maxX: number; minZ: number; maxZ: number } | null,
): THREE.Group {
  const { polygon, baseY, height, dx, dz } = zone;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [px, pz] of polygon) {
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  // Clamp to model BREP bbox so visual prisms don't extend to ±200m
  if (brepBbox) {
    const pad = 1.0; // 1m padding beyond model bounds
    minX = Math.max(minX, brepBbox.minX - pad);
    maxX = Math.min(maxX, brepBbox.maxX + pad);
    minZ = Math.max(minZ, brepBbox.minZ - pad);
    maxZ = Math.min(maxZ, brepBbox.maxZ + pad);
  }
  // Apply current displacement to the box position
  minX += dx; maxX += dx;
  minZ += dz; maxZ += dz;

  const w = Math.max(maxX - minX, 0.1);
  const d = Math.max(maxZ - minZ, 0.1);
  const h = Math.max(height, 0.1);
  const moved = Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001;

  const geo   = new THREE.BoxGeometry(w, h, d);
  const edges = new THREE.EdgesGeometry(geo);
  const mat   = new THREE.LineBasicMaterial({
    color: moved ? GIZMO_BOX_COLOR_MOVED : GIZMO_BOX_COLOR,
    transparent: true, opacity: 0.5, depthTest: false,
  });
  const lines = new THREE.LineSegments(edges, mat);
  lines.renderOrder = 998;
  lines.position.set((minX + maxX) / 2, baseY + h / 2, (minZ + maxZ) / 2);

  // Also add a semi-transparent fill at base level for plan visibility
  const fillGeo = new THREE.PlaneGeometry(w, d);
  const fillMat = new THREE.MeshBasicMaterial({
    color: moved ? GIZMO_BOX_COLOR_MOVED : GIZMO_BOX_COLOR,
    transparent: true, opacity: 0.08, depthTest: false, side: THREE.DoubleSide,
  });
  const fillPlane = new THREE.Mesh(fillGeo, fillMat);
  fillPlane.rotation.x = -Math.PI / 2; // lay flat
  fillPlane.position.set((minX + maxX) / 2, baseY + 0.01, (minZ + maxZ) / 2);
  fillPlane.renderOrder = 997;

  const group = new THREE.Group();
  group.add(lines, fillPlane);
  return group;
}

/** Create an arrow gizmo (shaft cylinder + cone head) for the given axis direction. */
function makeArrowMesh(axis: 'x' | 'z', centroid: THREE.Vector3): THREE.Group {
  const color   = axis === 'x' ? GIZMO_ARROW_X_COLOR : GIZMO_ARROW_Z_COLOR;
  const mat     = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });

  const shaftLen = GIZMO_ARROW_LEN - GIZMO_ARROW_HEAD_LEN;
  const shaftGeo = new THREE.CylinderGeometry(GIZMO_SHAFT_R, GIZMO_SHAFT_R, shaftLen, 8);
  const shaft    = new THREE.Mesh(shaftGeo, mat.clone());
  const headGeo  = new THREE.ConeGeometry(GIZMO_ARROW_HEAD_R, GIZMO_ARROW_HEAD_LEN, 10);
  const head     = new THREE.Mesh(headGeo, mat.clone());

  const group = new THREE.Group();
  group.renderOrder = 999;

  if (axis === 'x') {
    // Point along +X
    shaft.rotation.z = -Math.PI / 2;
    shaft.position.set(shaftLen / 2, 0, 0);
    head.rotation.z  = -Math.PI / 2;
    head.position.set(shaftLen + GIZMO_ARROW_HEAD_LEN / 2, 0, 0);
  } else {
    // Point along +Z
    shaft.rotation.x = Math.PI / 2;
    shaft.position.set(0, 0, shaftLen / 2);
    head.rotation.x  = Math.PI / 2;
    head.position.set(0, 0, shaftLen + GIZMO_ARROW_HEAD_LEN / 2);
  }

  group.add(shaft, head);
  group.position.copy(centroid);
  return group;
}

// ── Bbox helper ───────────────────────────────────────────────────────────────

function computeBbox(pts: (Pt3 | null)[]): number[] {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const pt of pts) {
    if (!pt) continue;
    if (pt[0] < minX) minX = pt[0]; if (pt[0] > maxX) maxX = pt[0];
    if (pt[1] < minY) minY = pt[1]; if (pt[1] > maxY) maxY = pt[1];
    if (pt[2] < minZ) minZ = pt[2]; if (pt[2] > maxZ) maxZ = pt[2];
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

// ── Main class ─────────────────────────────────────────────────────────────────

export class IFCRigZoneModifier {
  private model:       FRAGS.FragmentsModel;
  private fragsModels: FRAGS.FragmentsModels;
  private _components: OBC.Components | null;

  private _cache:          ModelCache | null = null;
  private _cachePromise:   Promise<void> | null = null;
  private _zones:          Map<string, ZoneState>   = new Map();
  private _repBySample:    Map<number, AffectedRep> = new Map();

  /** Listeners for external UI updates. */
  private _listeners: Set<() => void> = new Set();

  /** Three.js group holding zone wireframe boxes + arrow gizmos. */
  private _gizmosGroup: THREE.Group = new THREE.Group();
  /** Scene reference for adding/removing gizmos. */
  private _scene: THREE.Scene | null = null;

  /**
   * Affine transform from IFC parser plan coordinates (metres) to
   * BREP world XZ coordinates (metres).
   * parserX → brepX, parserY → brepZ  (with possible sign flip & offset).
   * Set via setParserWorldBounds() after model load + IFC parse.
   */
  // Parser→BREP transform fields removed — axes now arrive in BREP world coords.
  // Conversion is done once during rig generation via convertParserAxesToBrep().
  /** Scale factor for displacements: parser delta X → BREP delta X */
  private _scaleX = 1;
  /** Scale factor for displacements: parser delta Y → BREP delta Z (may be negative) */
  private _scaleZ = -1;

  /** BREP world bbox computed during ensureInit(). */
  private _brepBbox: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

  constructor(
    model:       FRAGS.FragmentsModel,
    fragsModels: FRAGS.FragmentsModels,
    components?: OBC.Components,
  ) {
    this.model       = model;
    this.fragsModels = fragsModels;
    this._components = components ?? null;
    this._gizmosGroup.name = 'zone-gizmos';
  }

  /** Attach gizmos to a Three.js scene. Call once after model load. */
  setScene(scene: THREE.Scene): void {
    if (this._scene && this._scene !== scene) {
      this._scene.remove(this._gizmosGroup);
    }
    this._scene = scene;
    if (!scene.children.includes(this._gizmosGroup)) {
      scene.add(this._gizmosGroup);
    }
  }

  /** Rebuild all zone wireframe boxes + arrow gizmos from current state. */
  rebuildGizmos(): void {
    // Clear existing — dispose all geometries and materials
    while (this._gizmosGroup.children.length > 0) {
      const child = this._gizmosGroup.children[0];
      this._gizmosGroup.remove(child);
      child.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
        if ((obj as THREE.Mesh).material) {
          const mat = (obj as THREE.Mesh).material;
          if (Array.isArray(mat)) mat.forEach(m => m.dispose());
          else (mat as THREE.Material).dispose();
        }
      });
    }

    for (const [, state] of this._zones) {
      // Wireframe box (clamped to model extent)
      const box = makeZoneBox(state, this._brepBbox);
      this._gizmosGroup.add(box);

      // Compute centroid of the zone polygon (displaced)
      let cx = 0, cz = 0;
      for (const [px, pz] of state.polygon) { cx += px; cz += pz; }
      cx = cx / state.polygon.length + state.dx;
      cz = cz / state.polygon.length + state.dz;
      const cy = state.baseY + state.height / 2;
      const centroid = new THREE.Vector3(cx, cy, cz);

      // Arrow gizmos
      if (state.dir === 'X') {
        this._gizmosGroup.add(makeArrowMesh('x', centroid));
      } else {
        this._gizmosGroup.add(makeArrowMesh('z', centroid));
      }
    }
  }

  /** Get the gizmos group (for external scene management if needed). */
  get gizmosGroup(): THREE.Group { return this._gizmosGroup; }

  /**
   * Set the parser's world bounds [minX_mm, minY_mm, maxX_mm, maxY_mm]
   * to enable automatic coordinate transform from parser plan coords
   * to BREP world coords.
   *
   * Must be called after ensureInit() (or addAxis will call it).
   * The transform maps:
   *   parser X (IFC east, mm) → BREP world X (metres)
   *   parser Y (IFC north, mm) → BREP world Z (metres, may be negated)
   */
  async setParserWorldBounds(bounds: [number, number, number, number]): Promise<void> {
    await this.ensureInit();
    if (!this._brepBbox) return;

    const [pMinX_mm, pMinY_mm, pMaxX_mm, pMaxY_mm] = bounds;
    // Convert parser bounds from mm to metres
    const pMinX = pMinX_mm * 0.001;
    const pMaxX = pMaxX_mm * 0.001;
    const pMinY = pMinY_mm * 0.001;
    const pMaxY = pMaxY_mm * 0.001;

    const { minX: bMinX, maxX: bMaxX, minZ: bMinZ, maxZ: bMaxZ } = this._brepBbox;

    const pSpanX = pMaxX - pMinX || 1;
    const pSpanY = pMaxY - pMinY || 1;
    const bSpanX = bMaxX - bMinX;
    const bSpanZ = bMaxZ - bMinZ;

    // parser X → BREP X: linear map
    this._scaleX = bSpanX / pSpanX;
    this._parserToBrepX = (px: number) =>
      bMinX + ((px - pMinX) / pSpanX) * bSpanX;

    // parser Y → BREP Z: flipped (IFC north → Three.js -Z)
    this._scaleZ = -bSpanZ / pSpanY;  // negative: parser +Y → BREP -Z
    this._parserToBrepZ = (py: number) =>
      bMaxZ - ((py - pMinY) / pSpanY) * bSpanZ;

    console.log(
      `[IFCRigZoneModifier] coord transform set:`
      + ` parserX=[${pMinX.toFixed(2)}, ${pMaxX.toFixed(2)}] → brepX=[${bMinX.toFixed(2)}, ${bMaxX.toFixed(2)}]`
      + ` parserY=[${pMinY.toFixed(2)}, ${pMaxY.toFixed(2)}] → brepZ=[${bMaxZ.toFixed(2)}, ${bMinZ.toFixed(2)}] (flipped)`,
    );
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  onChange(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  /**
   * Get the BREP world bounding box (XZ plane, in metres).
   * Must be called after ensureInit() / addAxis().
   */
  async getBrepBbox(): Promise<{ minX: number; maxX: number; minZ: number; maxZ: number } | null> {
    await this.ensureInit();
    return this._brepBbox;
  }

  /**
   * Convert parser-detected grid axes (mm) to BREP world millimetres.
   *
   * Uses an affine mapping from parser world bounds to the BREP bounding box.
   * Call once when generating the rig, then store the result in BREP world mm.
   *
   * Returns null if BREP bbox is unavailable.
   */
  async convertParserAxesToBrep(
    parserBounds: [number, number, number, number], // [minX_mm, minY_mm, maxX_mm, maxY_mm]
    axesXMm: number[],
    axesYMm: number[],
  ): Promise<{ brepAxesXMm: number[]; brepAxesYMm: number[] } | null> {
    await this.ensureInit();
    if (!this._brepBbox) return null;

    const [pMinX_mm, pMinY_mm, pMaxX_mm, pMaxY_mm] = parserBounds;
    const pMinX = pMinX_mm * 0.001;
    const pMaxX = pMaxX_mm * 0.001;
    const pMinY = pMinY_mm * 0.001;
    const pMaxY = pMaxY_mm * 0.001;

    const { minX: bMinX, maxX: bMaxX, minZ: bMinZ, maxZ: bMaxZ } = this._brepBbox;

    const pSpanX = pMaxX - pMinX || 1;
    const pSpanY = pMaxY - pMinY || 1;
    const bSpanX = bMaxX - bMinX;
    const bSpanZ = bMaxZ - bMinZ;

    // parser X (east, mm) → BREP world X (metres) → mm
    const parserXToBrepXMm = (px_mm: number) =>
      (bMinX + ((px_mm * 0.001 - pMinX) / pSpanX) * bSpanX) * 1000;

    // parser Y (north, mm) → BREP world Z (metres, flipped) → mm
    const parserYToBrepZMm = (py_mm: number) =>
      (bMaxZ - ((py_mm * 0.001 - pMinY) / pSpanY) * bSpanZ) * 1000;

    console.log(
      `[IFCRigZoneModifier] convertParserAxesToBrep:`
      + ` parserX=[${pMinX.toFixed(2)}, ${pMaxX.toFixed(2)}]`
      + ` → brepX=[${bMinX.toFixed(2)}, ${bMaxX.toFixed(2)}]`
      + ` parserY=[${pMinY.toFixed(2)}, ${pMaxY.toFixed(2)}]`
      + ` → brepZ=[${bMaxZ.toFixed(2)}, ${bMinZ.toFixed(2)}] (flipped)`,
    );

    return {
      brepAxesXMm: axesXMm.map(parserXToBrepXMm),
      brepAxesYMm: axesYMm.map(parserYToBrepZMm),
    };
  }

  /**
   * Inverse of convertParserAxesToBrep: convert BREP world mm back to parser mm.
   * Used by "Apply to BubbleGraph" to get parametric axis values.
   */
  async convertBrepAxesToParser(
    parserBounds: [number, number, number, number],
    brepAxesXMm: number[],
    brepAxesYMm: number[],
  ): Promise<{ parserAxesXMm: number[]; parserAxesYMm: number[] } | null> {
    await this.ensureInit();
    if (!this._brepBbox) return null;

    const [pMinX_mm, pMinY_mm, pMaxX_mm, pMaxY_mm] = parserBounds;
    const pMinX = pMinX_mm * 0.001;
    const pMaxX = pMaxX_mm * 0.001;
    const pMinY = pMinY_mm * 0.001;
    const pMaxY = pMaxY_mm * 0.001;

    const { minX: bMinX, maxX: bMaxX, minZ: bMinZ, maxZ: bMaxZ } = this._brepBbox;

    const pSpanX = pMaxX - pMinX || 1;
    const pSpanY = pMaxY - pMinY || 1;
    const bSpanX = bMaxX - bMinX || 1;
    const bSpanZ = bMaxZ - bMinZ || 1;

    // BREP world X (mm) → parser X (mm)
    const brepXToParserXMm = (bx_mm: number) =>
      (pMinX + ((bx_mm * 0.001 - bMinX) / bSpanX) * pSpanX) * 1000;

    // BREP world Z (mm) → parser Y (mm)  (flipped)
    const brepZToParserYMm = (bz_mm: number) =>
      (pMinY + ((bMaxZ - bz_mm * 0.001) / bSpanZ) * pSpanY) * 1000;

    return {
      parserAxesXMm: brepAxesXMm.map(brepXToParserXMm),
      parserAxesYMm: brepAxesYMm.map(brepZToParserYMm),
    };
  }

  /**
   * Register a rig axis as a zone strip.
   * Must be called after the FragmentsModel is loaded.
   *
   * NOTE: axis.originM must be in BREP world metres (not parser coords).
   * Use convertParserAxesToBrep() during rig generation to get BREP coords.
   *
   * Returns the axisId (same as input).
   */
  async addAxis(axis: RigAxisDef): Promise<string> {
    await this.ensureInit();

    // originM is already in BREP world metres — use directly
    const originM = axis.originM;

    // Build the strip polygon from the transformed position
    // For dir='X', the strip is perpendicular to X axis (constant X, varies in Z)
    // For dir='Y', the strip is perpendicular to Z axis (constant Z, varies in X)
    const halfW = axis.halfWidthM ?? STRIP_HALF_WIDTH_M;
    const polygon = makeAxisStripPolygon(
      axis.dir,
      originM,
      halfW,
      STRIP_MIN_Y,
      STRIP_MAX_Y,
    );

    const affectedReps = this._findAffectedReps(polygon, STRIP_MIN_Y, STRIP_MAX_Y);

    // Pre-compute owned indices using baseline positions
    const ownedIndices = new Map<number, Set<number>>();
    for (const rep of affectedReps) {
      const globalT = this._cache!.allGT.get(rep.primarySample.item);
      const localT  = this._cache!.allLT.get(rep.primarySample.localTransform);
      const indices  = new Set<number>();
      for (let i = 0; i < rep.baseline.length; i++) {
        const pt = rep.baseline[i];
        if (!pt) continue;
        const wp = toWorld(pt, localT, globalT);
        if (pointInPolygonXZ(wp[0], wp[2], polygon)) {
          indices.add(i);
        }
      }
      if (indices.size > 0) ownedIndices.set(rep.primarySample.sampleId, indices);
    }

    console.log(
      `[IFCRigZoneModifier] addAxis ${axis.id} (${axis.dir}=${axis.originM.toFixed(3)}m → brep=${originM.toFixed(3)}m)`
      + ` reps=${affectedReps.length} ownedPts=${[...ownedIndices.values()].reduce((s, v) => s + v.size, 0)}`,
    );

    this._zones.set(axis.id, {
      axisId:       axis.id,
      dir:          axis.dir,
      polygon,
      baseY:        this.model.box?.min?.y ?? STRIP_MIN_Y,
      height:       ((this.model.box?.max?.y ?? STRIP_MAX_Y) - (this.model.box?.min?.y ?? STRIP_MIN_Y)) + 4,
      dx:           0,
      dz:           0,
      ownedIndices,
      affectedReps,
    });

    this._emit();
    this.rebuildGizmos();
    return axis.id;
  }

  /**
   * Convert a parser-space delta (metres) to BREP world delta (metres).
   * For dir='X': parser delta X → BREP delta X (scaled).
   * For dir='Y': parser delta Y → BREP delta Z (scaled, usually negative).
   */
  parserDeltaToBrepDelta(dir: 'X' | 'Y', deltaM: number): number {
    return dir === 'X' ? deltaM * this._scaleX : deltaM * this._scaleZ;
  }

  /**
   * Apply an absolute displacement to one axis.
   * dx / dz are METRES in world space (sign matches world X / world Z).
   * Internally converts to delta from current position and mutates current[].
   */
  async setAxisPosition(axisId: string, newDx: number, newDz: number): Promise<void> {
    const state = this._zones.get(axisId);
    if (!state) return;
    const deltaDx = newDx - state.dx;
    const deltaDz = newDz - state.dz;
    if (Math.abs(deltaDx) < 1e-9 && Math.abs(deltaDz) < 1e-9) return;
    await this._applyDelta(axisId, deltaDx, deltaDz);
  }

  /** Reset an axis back to its original position. */
  async resetAxis(axisId: string): Promise<void> {
    const state = this._zones.get(axisId);
    if (!state || (state.dx === 0 && state.dz === 0)) return;
    await this._applyDelta(axisId, -state.dx, -state.dz);
  }

  /**
   * Apply a world-space displacement to an axis (dx, dz in metres).
   * Matches the production `applyDisplacement` pattern:
   * toWorld → add delta → fromWorld → writeFrags → update tiles.
   */
  async applyAxisDelta(axisId: string, dx: number, dz: number): Promise<void> {
    if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return;
    await this._applyDelta(axisId, dx, dz);
  }

  /** Remove an axis and restore original geometry. */
  async removeAxis(axisId: string): Promise<void> {
    await this.resetAxis(axisId);
    const state = this._zones.get(axisId);
    if (state) {
      await this._restoreOriginalReps(state, axisId);
      for (const rep of state.affectedReps) {
        if (!this._isRepUsedByOther(rep, axisId)) {
          this._repBySample.delete(rep.primarySample.sampleId);
        }
      }
    }
    this._zones.delete(axisId);
    this._emit();
  }

  /**
   * Prepare a drag context for a rig axis — pre-computes per-vertex
   * displacement directions so liveDisplace() is O(k) with zero allocation.
   */
  prepareDrag(axisId: string): DragContext | null {
    const state = this._zones.get(axisId);
    if (!state || !this._cache) return null;

    const affected: DragContext['affected'] = [];

    for (const rep of state.affectedReps) {
      const owned   = state.ownedIndices.get(rep.primarySample.sampleId);
      if (!owned || owned.size === 0) continue;

      const globalT = this._cache.allGT.get(rep.primarySample.item);
      const localT  = this._cache.allLT.get(rep.primarySample.localTransform);

      // Pre-compute the world +X / +Z direction in local BREP space
      const wO  = fromWorld([0, 0, 0], localT, globalT);
      const wXe = fromWorld(state.dir === 'X' ? [1, 0, 0] : [0, 0, 1], localT, globalT);
      const localDir: Pt3 = [wXe[0] - wO[0], wXe[1] - wO[1], wXe[2] - wO[2]];

      for (const ptIdx of owned) {
        const pt = rep.current[ptIdx];
        if (!pt) continue;
        affected.push({ rep, ptIdx, baseLocal: [...pt] as Pt3, localDir });
      }
    }

    return { axisId, dir: state.dir, affected };
  }

  /**
   * Apply a preview displacement directly to BREP current[] array.
   * Called per pointermove frame — no writeFrags, no fragsModels.update.
   * The Three.js BufferAttribute update is handled by IFCRigViewer
   * by calling fragsModels.update(false) after this.
   */
  liveDisplace(ctx: DragContext, deltaM: number): void {
    for (const { rep, ptIdx, baseLocal, localDir } of ctx.affected) {
      rep.current[ptIdx] = [
        baseLocal[0] + deltaM * localDir[0],
        baseLocal[1] + deltaM * localDir[1],
        baseLocal[2] + deltaM * localDir[2],
      ];
    }
  }

  /**
   * Commit a drag: write the final displaced BREP via EditRequest API.
   * `totalDeltaM` is the total displacement in metres since prepareDrag().
   */
  async commitDrag(ctx: DragContext, totalDeltaM: number): Promise<void> {
    // Apply final displacement to current[]
    this.liveDisplace(ctx, totalDeltaM);

    // Update cumulative zone displacement
    const state = this._zones.get(ctx.axisId);
    if (state) {
      if (ctx.dir === 'X') state.dx += totalDeltaM;
      else                  state.dz += totalDeltaM;
    }

    // Collect unique reps to write
    const repsToWrite = new Set<AffectedRep>(
      ctx.affected.map((a) => a.rep),
    );
    await this._writeFragsForReps(Array.from(repsToWrite));
    this._emit();
  }

  /** Cancel a drag — restore current[] from ctx.baseLocal values. */
  cancelDrag(ctx: DragContext): void {
    for (const { rep, ptIdx, baseLocal } of ctx.affected) {
      rep.current[ptIdx] = baseLocal;
    }
  }

  /** Remove all zones and restore original geometry. */
  async dispose(): Promise<void> {
    for (const axisId of [...this._zones.keys()]) {
      await this.removeAxis(axisId);
    }
    this._repBySample.clear();
    this._listeners.clear();
    // Remove gizmos from scene
    if (this._scene) {
      this._scene.remove(this._gizmosGroup);
    }
    this._gizmosGroup.traverse((obj) => {
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      if ((obj as THREE.Mesh).material) ((obj as THREE.Mesh).material as THREE.Material).dispose();
    });
  }

  // ── Internal — model cache init ────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (this._cache) return;
    if (this._cachePromise) { await this._cachePromise; return; }

    this._cachePromise = (async () => {
      console.log('[IFCRigZoneModifier] initialising BREP cache…');
      const allSamples = await this.model.getSamples();
      const allGT      = await this.model.getGlobalTransforms();
      const allLT      = await this.model.getLocalTransforms();

      const repSamples = new Map<number, SampleRecord[]>();
      const repIds     = new Set<number>();
      for (const [sampleId, sample] of allSamples) {
        repIds.add(sample.representation);
        if (!repSamples.has(sample.representation)) repSamples.set(sample.representation, []);
        repSamples.get(sample.representation)!.push({
          sampleId,
          item: sample.item,
          material: sample.material,
          representation: sample.representation,
          localTransform: sample.localTransform,
        });
      }

      const allReps = await this.model.getRepresentations(repIds);

      this._cache = { allGT, allLT, repSamples, allReps };

      // Compute BREP world bbox for coordinate transform calibration
      let wxMin = Infinity, wzMin = Infinity;
      let wxMax = -Infinity, wzMax = -Infinity;
      for (const [repId, rep] of allReps) {
        const geom = rep.geometry as any;
        if (!geom || !('points' in geom)) continue;
        const instances = repSamples.get(repId);
        if (!instances?.length) continue;
        const inst = instances[0];
        const globalT = allGT.get(inst.item);
        const localT  = allLT.get(inst.localTransform);
        for (const pt of geom.points) {
          if (!pt) continue;
          const wp = toWorld(pt, localT, globalT);
          if (wp[0] < wxMin) wxMin = wp[0]; if (wp[0] > wxMax) wxMax = wp[0];
          if (wp[2] < wzMin) wzMin = wp[2]; if (wp[2] > wzMax) wzMax = wp[2];
        }
      }

      this._brepBbox = { minX: wxMin, maxX: wxMax, minZ: wzMin, maxZ: wzMax };

      console.log(
        `[IFCRigZoneModifier] cache ready: ${allReps.size} reps, ${allSamples.size} samples`,
      );

      // Diagnostic: count shared reps (reps with multiple samples)
      let sharedCount = 0;
      let maxSamples = 0;
      for (const [, samples] of repSamples) {
        if (samples.length > 1) { sharedCount++; maxSamples = Math.max(maxSamples, samples.length); }
      }
      if (sharedCount > 0) {
        console.warn(`[IFCRigZoneModifier] SHARED REPS: ${sharedCount} reps have multiple samples (max=${maxSamples}). These may cause visual duplication.`);
      }
    })();

    await this._cachePromise;
  }

  // ── Internal — affected rep discovery ─────────────────────────────────────

  private _findAffectedReps(
    polygon: [number, number][],
    minY: number,
    maxY: number,
  ): AffectedRep[] {
    if (!this._cache) return [];
    const { allGT, allLT, repSamples, allReps } = this._cache;
    const result: AffectedRep[] = [];

    for (const [repId, rep] of allReps) {
      const geom = rep.geometry as FRAGS.RawShell | null;
      if (!geom || !('points' in geom)) continue;
      const shell = geom as FRAGS.RawShell;

      const instances = repSamples.get(repId);
      if (!instances?.length) continue;

      for (const inst of instances) {
        const existing = this._repBySample.get(inst.sampleId);
        if (existing) {
          // Check if this sample overlaps this zone
          const globalT = allGT.get(inst.item);
          const localT  = allLT.get(inst.localTransform);
          let overlaps = false;
          for (const pt of existing.baseline) {
            if (!pt) continue;
            const wp = toWorld(pt, localT, globalT);
            if (wp[1] >= minY && wp[1] <= maxY && pointInPolygonXZ(wp[0], wp[2], polygon)) {
              overlaps = true;
              break;
            }
          }
          if (overlaps) result.push(existing);
          continue;
        }

        const globalT = allGT.get(inst.item);
        const localT  = allLT.get(inst.localTransform);

        let affected = false;
        for (const pt of shell.points) {
          if (!pt) continue;
          const wp = toWorld(pt, localT, globalT);
          if (wp[1] >= minY && wp[1] <= maxY && pointInPolygonXZ(wp[0], wp[2], polygon)) {
            affected = true;
            break;
          }
        }
        if (!affected) continue;

        const baseline = shell.points.map((pt) => (pt ? [...pt] as Pt3 : null));
        const current  = shell.points.map((pt) => (pt ? [...pt] as Pt3 : null));

        const newRep: AffectedRep = {
          repId,
          baseline,
          current,
          primarySample: inst,
          clonedRepId: null,
        };

        result.push(newRep);
        this._repBySample.set(inst.sampleId, newRep);
      }
    }

    return result;
  }

  // ── Internal — displacement application ────────────────────────────────────

  private async _applyDelta(axisId: string, dx: number, dz: number): Promise<void> {
    const state = this._zones.get(axisId);
    if (!state) return;

    let movedPts = 0;
    for (const rep of state.affectedReps) {
      const owned   = state.ownedIndices.get(rep.primarySample.sampleId);
      if (!owned || owned.size === 0) continue;

      const globalT = this._cache!.allGT.get(rep.primarySample.item);
      const localT  = this._cache!.allLT.get(rep.primarySample.localTransform);

      for (const ptIdx of owned) {
        const pt = rep.current[ptIdx];
        if (!pt) continue;
        const wp     = toWorld(pt, localT, globalT);
        const newWp  = [wp[0] + dx, wp[1], wp[2] + dz];
        const newLoc = fromWorld(newWp, localT, globalT);
        rep.current[ptIdx] = newLoc as Pt3;
        movedPts++;
      }
    }

    console.log(
      `[IFCRigZoneModifier] _applyDelta ${axisId}: dx=${dx.toFixed(4)} dz=${dz.toFixed(4)}`
      + ` movedPts=${movedPts} affectedReps=${state.affectedReps.length}`,
    );

    state.dx += dx;
    state.dz += dz;

    // Collect all reps that may share a clone
    const repsToWrite = new Set<AffectedRep>(state.affectedReps);
    for (const [otherId, otherState] of this._zones) {
      if (otherId === axisId) continue;
      for (const r of otherState.affectedReps) {
        if (state.affectedReps.includes(r)) repsToWrite.add(r);
      }
    }

    await this._writeFragsForReps(Array.from(repsToWrite));
    this._emit();
    this.rebuildGizmos();
  }

  // ── Internal — FRAGS write-back ─────────────────────────────────────────────

  private async _writeFragsForReps(reps: AffectedRep[]): Promise<void> {
    const requests: FRAGS.EditRequest[] = [];
    // Track CREATE_REPRESENTATION request indices so we can map returned IDs
    const createIndices: { rep: AffectedRep; requestIdx: number }[] = [];
    const seen = new Set<number>();

    for (const rep of reps) {
      if (seen.has(rep.primarySample.sampleId)) continue;
      seen.add(rep.primarySample.sampleId);

      const origRep = this._cache!.allReps.get(rep.repId);
      if (!origRep?.geometry) continue;
      const origShell = origRep.geometry as FRAGS.RawShell;

      const shellData: FRAGS.RawShell = {
        points:          rep.current.map((pt) => (pt ?? [0, 0, 0]) as number[]),
        profiles:        origShell.profiles,
        bigProfiles:     origShell.bigProfiles,
        holes:           origShell.holes,
        bigHoles:        origShell.bigHoles,
        profilesFaceIds: origShell.profilesFaceIds,
        type:            origShell.type,
      };

      const repData: FRAGS.RawRepresentation = {
        bbox:                 computeBbox(rep.current),
        representationClass: origRep.representationClass,
        geometry:            shellData,
      };

      if (rep.clonedRepId) {
        // Clone already exists — update using the numeric ID
        requests.push({
          type:    FRAGS.EditRequestType.UPDATE_REPRESENTATION,
          localId: rep.clonedRepId,
          data:    repData,
        } as FRAGS.EditRequest);
      } else {
        const tempId = `rig-rep-${rep.primarySample.sampleId}-${Date.now()}`;

        // Track which position in requests array this CREATE is at
        createIndices.push({ rep, requestIdx: requests.length });

        requests.push({
          type:   FRAGS.EditRequestType.CREATE_REPRESENTATION,
          tempId,
          data:   repData,
        } as FRAGS.EditRequest);

        requests.push({
          type:    FRAGS.EditRequestType.UPDATE_SAMPLE,
          localId: rep.primarySample.sampleId,
          data: {
            item:            rep.primarySample.item,
            material:        rep.primarySample.material,
            representation:  tempId,
            localTransform:  rep.primarySample.localTransform,
          },
        } as FRAGS.EditRequest);
      }
    }

    if (!requests.length) return;

    const editedIds = await this.fragsModels.editor.edit(this.model.modelId, requests);

    console.log(
      `[IFCRigZoneModifier] editor.edit returned:`,
      { type: typeof editedIds, isArray: Array.isArray(editedIds), value: editedIds },
      `createIndices=${createIndices.length}`,
    );

    // editor.edit() returns number[] — the IDs of created elements in order.
    // Map each CREATE_REPRESENTATION result back to the rep so subsequent calls
    // can use UPDATE_REPRESENTATION with the real numeric ID.
    if (Array.isArray(editedIds) && editedIds.length > 0) {
      // editedIds[i] corresponds to the i-th CREATE_REPRESENTATION in order
      for (let i = 0; i < createIndices.length; i++) {
        const realId = editedIds[i];
        if (typeof realId === 'number') {
          createIndices[i].rep.clonedRepId = realId;
        } else {
          createIndices[i].rep.clonedRepId = null;
          console.warn(`[IFCRigZoneModifier] could not resolve create[${i}], will recreate`);
        }
      }
    } else {
      // Fallback: clear all clonedRepIds so next call recreates
      for (const { rep } of createIndices) {
        rep.clonedRepId = null;
      }
    }

    await this.fragsModels.update(true);

    if (this._components) {
      const fragments = this._components.get(OBC.FragmentsManager);
      await fragments.core.update();
    }

    console.log(
      `[IFCRigZoneModifier] writeFrags: ${requests.length} requests`
      + ` (${createIndices.length} creates, ${requests.length - createIndices.length * 2} updates)`
      + ` editedIds=${editedIds?.length ?? 0}`,
    );
  }

  // ── Internal — rep sharing helpers ─────────────────────────────────────────

  private _isRepUsedByOther(rep: AffectedRep, excludeAxisId: string): boolean {
    for (const [id, state] of this._zones) {
      if (id === excludeAxisId) continue;
      if (state.affectedReps.includes(rep)) return true;
    }
    return false;
  }

  private async _restoreOriginalReps(state: ZoneState, forAxisId?: string): Promise<void> {
    const requests: FRAGS.EditRequest[] = [];

    for (const rep of state.affectedReps) {
      if (!rep.clonedRepId) continue;
      if (forAxisId && this._isRepUsedByOther(rep, forAxisId)) continue;

      requests.push({
        type:    FRAGS.EditRequestType.UPDATE_SAMPLE,
        localId: rep.primarySample.sampleId,
        data: {
          item:           rep.primarySample.item,
          material:       rep.primarySample.material,
          representation: rep.primarySample.representation,
          localTransform: rep.primarySample.localTransform,
        },
      } as FRAGS.EditRequest);

      rep.clonedRepId = null;
      rep.current = rep.baseline.map((pt) => (pt ? [...pt] as Pt3 : null));
    }

    if (requests.length) {
      await this.fragsModels.editor.edit(this.model.modelId, requests);
      await this.fragsModels.update(true);
      if (this._components) {
        const fragments = this._components.get(OBC.FragmentsManager);
        await fragments.core.update();
      }
      console.log(`[IFCRigZoneModifier] restoreOriginalReps: ${requests.length} samples restored`);
    }
  }

  private _emit(): void {
    this._listeners.forEach((fn) => fn());
  }

  /**
   * exportRigJSON — Export the current rig state as a structured JSON object.
   *
   * Returns a dictionary keyed by storey elevation (mm), then by zone label.
   * Each zone entry contains:
   *   - axisId, dir, label, originMm, positionMm (current), deltaMm
   *   - horizontalProfiles: array of face polygons (world XYZ mm) where
   *     all vertices lie at the same elevation (Y constant within 1mm tolerance).
   *     These are the footprint-like flat faces of affected BREP elements.
   *
   * Format:
   * {
   *   storeys: {
   *     "<elevation_mm>": {
   *       zones: {
   *         "<label>": {
   *           axisId, dir, label, originMm, positionMm, deltaMm,
   *           horizontalProfiles: [
   *             { elevationMm, points: [{x,y,z},...] }, ...
   *           ]
   *         }
   *       }
   *     }
   *   },
   *   meta: { exportedAt, fileKey?, totalZones, totalProfiles }
   * }
   */
  exportRigJSON(storeys?: Array<{ id: string; name: string; elevation_mm: number; height_mm: number }>, fileKey?: string): object {
    const HORIZ_Y_TOL = 1e-3; // 1mm tolerance for "all same Y" face detection

    const result: Record<string, unknown> = {};
    const storeyBuckets = new Map<number, {
      name: string;
      zones: Record<string, unknown>;
    }>();

    let totalProfiles = 0;

    for (const [axisId, zone] of this._zones) {
      const dx = zone.dx * 1000; // m → mm
      const dz = zone.dz * 1000;
      const deltaMm = zone.dir === 'X' ? dx : dz;
      const positionMm = zone.dir === 'X'
        ? (zone.polygon[0][0] + zone.polygon[1][0]) / 2 * 1000 + dx
        : (zone.polygon[0][1] + zone.polygon[2][1]) / 2 * 1000 + dz;
      // origin = position minus delta
      const originMm = positionMm - deltaMm;

      // Collect horizontal profiles from current geometry
      const horizontalProfiles: Array<{ elevationMm: number; points: Array<{x:number;y:number;z:number}> }> = [];

      for (const rep of zone.affectedReps) {
        if (!rep.current) continue;

        // Get the raw shell profiles to iterate over face polygons
        const allReps = this._cache?.allReps;
        if (!allReps) continue;
        const rawRep = allReps.get(rep.primarySample.representation);
        if (!rawRep) continue;
        const geom = rawRep.geometry as FRAGS.RawShell | null;
        if (!geom || !('profiles' in geom)) continue;

        const globalT = this._cache!.allGT.get(rep.primarySample.item);
        const localT  = this._cache!.allLT.get(rep.primarySample.localTransform);

        // Use CURRENT (deformed) positions
        const worldPts = rep.current.map((pt) =>
          pt ? toWorld(pt, localT, globalT) : null
        );

        // Iterate over profiles (each profile is an array of point indices forming a face)
        const profiles = geom.profiles as number[][] | undefined;
        if (!profiles) continue;

        for (const face of profiles) {
          if (!face || face.length < 3) continue;
          const facePts = face.map((i) => worldPts[i]).filter((p): p is Pt3 => !!p);
          if (facePts.length < 3) continue;

          // Check if face is horizontal: all Y values within tolerance
          const ys = facePts.map((p) => p[1]);
          const minY = Math.min(...ys), maxY = Math.max(...ys);
          if (maxY - minY > HORIZ_Y_TOL) continue;

          const elevationMm = Math.round(((minY + maxY) / 2) * 1000); // m → mm, rounded

          horizontalProfiles.push({
            elevationMm,
            points: facePts.map(([x, y, z]) => ({
              x: Math.round(x * 1000), // m → mm
              y: Math.round(y * 1000),
              z: Math.round(z * 1000),
            })),
          });
          totalProfiles++;
        }
      }

      // Deduplicate profiles by elevation + geometry (same elevation, same points within 1mm)
      const dedupedProfiles = horizontalProfiles.filter((prof, idx, arr) =>
        arr.findIndex((p) =>
          p.elevationMm === prof.elevationMm &&
          p.points.length === prof.points.length &&
          p.points.every((pt, i) =>
            Math.abs(pt.x - prof.points[i]?.x) < 1 &&
            Math.abs(pt.z - prof.points[i]?.z) < 1
          )
        ) === idx
      );

      // Find which storey this zone belongs to (by elevation range)
      let storeyElevMm = 0;
      let storeyName = 'Ground';
      if (storeys?.length) {
        const match = storeys.find((s) =>
          originMm >= s.elevation_mm - 100 &&
          originMm < s.elevation_mm + s.height_mm + 100
        ) ?? storeys[0];
        storeyElevMm = match.elevation_mm;
        storeyName = match.name;
      } else if (dedupedProfiles.length > 0) {
        // Infer storey from lowest horizontal profile elevation
        storeyElevMm = Math.min(...dedupedProfiles.map((p) => p.elevationMm));
        storeyName = `Elevation ${storeyElevMm}mm`;
      }

      if (!storeyBuckets.has(storeyElevMm)) {
        storeyBuckets.set(storeyElevMm, { name: storeyName, zones: {} });
      }

      const label = zone.axisId.replace(/^rig-[xy]-[^-]+-/, ''); // extract label suffix
      storeyBuckets.get(storeyElevMm)!.zones[label] = {
        axisId,
        dir: zone.dir,
        label,
        originMm,
        positionMm,
        deltaMm,
        horizontalProfiles: dedupedProfiles,
      };
    }

    // Build sorted output
    const storeyOut: Record<string, unknown> = {};
    for (const [elevMm, bucket] of [...storeyBuckets.entries()].sort((a, b) => a[0] - b[0])) {
      storeyOut[String(elevMm)] = {
        name: bucket.name,
        elevationMm: elevMm,
        zones: bucket.zones,
      };
    }

    return {
      storeys: storeyOut,
      meta: {
        exportedAt: new Date().toISOString(),
        fileKey,
        totalZones: this._zones.size,
        totalProfiles,
      },
    };
  }
}
