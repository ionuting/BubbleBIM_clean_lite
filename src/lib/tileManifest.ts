/**
 * tileManifest.ts — Shared types for the IFC → GLB tile pipeline.
 *
 * Used by:
 *  - ifcTilePipeline.worker.ts  (producer)
 *  - IFCTilesViewer.tsx         (consumer)
 *  - ifcTileCache.ts            (storage)
 */

// ─── Manifest schema ──────────────────────────────────────────────────────────

export interface TileBBox {
  min: [number, number, number]; // metres, [X, Y, Z] Three.js Y-up
  max: [number, number, number];
}

export interface FloorInfo {
  id: string;        // e.g. "F0", "F1"
  name: string;      // storey name from IFC
  elevationM: number;
  heightM: number;
}

export interface TileManifestEntry {
  id: string;        // e.g. "F0_G2_1" (floor_gridCol_gridRow)
  floor: string;     // FloorInfo.id
  gridCol: number;
  gridRow: number;
  bbox: TileBBox;
  elementCount: number;
  categories: string[];  // e.g. ["wall", "slab", "column"]
}

export interface RootManifest {
  version: '1';
  projectName: string;
  sourceHash: string;        // first 8 chars of SHA-256(ifc bytes)
  createdAt: string;         // ISO date
  bounds: TileBBox;
  gridSizeM: number;
  floors: FloorInfo[];
  tiles: TileManifestEntry[];
  metadataUrl: 'metadata.json';
}

// ─── Element metadata (stored separately from GLB) ────────────────────────────

export interface OpeningInfo {
  hostWallExpressID: number;
  openingBboxWorld: TileBBox;   // world-space bbox of this opening
}

export interface ElementMeta {
  expressID: number;
  category: string;
  name: string;
  type: string;           // IFC type name, e.g. "IFCWALL"
  tileId: string;
  properties?: Record<string, unknown>;
  openingInfo?: OpeningInfo;  // set for windows & doors that have a host wall
}

export type ElementMetaMap = Record<number, ElementMeta>; // keyed by expressID

// ─── Worker message protocol ──────────────────────────────────────────────────

/** Main thread → Worker */
export interface WorkerProcessMsg {
  type: 'process';
  ifcBuffer: ArrayBuffer;
  gridSizeM: number;
  wasmPath: string;
}

/** Worker → Main: progress update */
export interface WorkerProgressMsg {
  type: 'progress';
  percent: number; // 0–100
  message: string;
}

/** Per-instance data for a GPU-instanced geometry group */
export interface WorkerInstanceData {
  expressID: number;
  matrix: number[];   // 16 col-major floats (4×4 transform → world space)
  r: number; g: number; b: number; a: number;
  category: string;
  name: string;
}

/**
 * A group of N instances sharing the same base geometry (local space).
 * Becomes THREE.InstancedMesh in the viewer.
 * Typical candidates: windows, doors, columns, furniture.
 */
export interface WorkerInstancedGroup {
  geomExpressID: number;
  positions: Float32Array;  // base geometry LOCAL space
  normals:   Float32Array;
  indices:   Uint32Array;
  instances: WorkerInstanceData[];
  category: string;         // dominant category
}

/** Geometry for one element, already in world space (metres, Y-up) */
export interface WorkerElementGeom {
  expressID: number;
  category: string;  // 'wall' | 'slab' | 'column' | 'beam' | 'window' | 'door' | 'other'
  ifcTypeName: string;
  name: string;
  r: number; g: number; b: number; a: number; // material color 0–1
  // interleaved pos/normal NOT used — separate arrays for clarity
  positions: Float32Array;   // flat [x,y,z, x,y,z, ...]  world space metres
  normals:   Float32Array;   // flat [nx,ny,nz, ...] world space
  indices:   Uint32Array;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

/** Worker → Main: one tile worth of raw geometry */
export interface WorkerTileDataMsg {
  type: 'tile_data';
  tileId: string;
  floor: string;
  gridCol: number;
  gridRow: number;
  bbox: TileBBox;
  elements: WorkerElementGeom[];         // unique-geometry elements (world-space)
  instancedGroups: WorkerInstancedGroup[]; // repeated-geometry elements (local-space + matrices)
}

/** Worker → Main: all done */
export interface WorkerCompleteMsg {
  type: 'complete';
  manifest: RootManifest;
  metadata: ElementMetaMap;
}

/** Worker → Main: fatal error */
export interface WorkerErrorMsg {
  type: 'error';
  message: string;
}

export type WorkerOutMsg =
  | WorkerProgressMsg
  | WorkerTileDataMsg
  | WorkerCompleteMsg
  | WorkerErrorMsg;

// ─── Category → default color mapping ────────────────────────────────────────

export const CATEGORY_COLOR: Record<string, [number, number, number, number]> = {
  wall:      [0.82, 0.78, 0.72, 1.0],
  slab:      [0.70, 0.70, 0.70, 1.0],
  column:    [0.55, 0.55, 0.60, 1.0],
  beam:      [0.50, 0.50, 0.56, 1.0],
  window:    [0.50, 0.75, 0.95, 0.55],
  door:      [0.72, 0.55, 0.35, 1.0],
  stair:     [0.78, 0.72, 0.62, 1.0],
  roof:      [0.65, 0.38, 0.28, 1.0],
  furniture: [0.80, 0.65, 0.50, 1.0],
  space:     [0.40, 0.70, 0.90, 0.15],
  other:     [0.65, 0.65, 0.65, 1.0],
};

// ─── IFC type code → category ─────────────────────────────────────────────────
// These are numeric type codes used by web-ifc (same as WEBIFC.IFCWALL etc.)
// We keep them as numbers to avoid importing web-ifc in this shared file.

export const IFC_TYPE_CATEGORY: Record<number, string> = {
  // Walls
  188: 'wall',     // IFCWALL
  3002: 'wall',    // IFCWALLSTANDARDCASE
  4037: 'wall',    // IFCWALLTYPE
  // Slabs
  3027: 'slab',    // IFCSLAB
  3278: 'slab',    // IFCSLABTYPE
  // Columns
  1532: 'column',  // IFCCOLUMN
  // Beams
  2732: 'beam',    // IFCBEAM
  // Windows
  4261: 'window',  // IFCWINDOW
  // Doors
  395: 'door',     // IFCDOOR
  // Stairs
  3288: 'stair',   // IFCSTAIR
  331: 'stair',    // IFCSTAIRELEMENT (IFCSTAIRFLIGHT)
  // Roofs
  2662: 'roof',    // IFCROOF
  // Covering (ceiling, flooring)
  1362: 'other',   // IFCCOVERING
  // Furniture
  263: 'furniture',// IFCFURNISHINGELEMENT
  // Space
  3856: 'space',   // IFCSPACE
};
