/**
 * ifcTilePipeline.worker.ts — Web Worker: IFC bytes → raw geometry tiles.
 *
 * Uses web-ifc WASM directly (no DOM, no Three.js — pure data processing).
 * Streams tile_data messages back to the main thread one tile at a time.
 * Main thread is responsible for Three.js scene building + GLTFExporter + IndexedDB.
 *
 * Message protocol:
 *   IN:  WorkerProcessMsg  { type:'process', ifcBuffer, gridSizeM, wasmPath }
 *   OUT: WorkerProgressMsg { type:'progress', percent, message }
 *       WorkerTileDataMsg  { type:'tile_data', tileId, floor, bbox, elements[] }
 *       WorkerCompleteMsg  { type:'complete', manifest, metadata }
 *       WorkerErrorMsg     { type:'error', message }
 */

import * as WebIFC from 'web-ifc';
import type {
  WorkerProcessMsg, WorkerProgressMsg, WorkerTileDataMsg,
  WorkerCompleteMsg, WorkerErrorMsg, WorkerElementGeom,
  WorkerInstancedGroup,
  TileBBox, FloorInfo, TileManifestEntry, RootManifest, ElementMetaMap,
} from './tileManifest';
import { CATEGORY_COLOR } from './tileManifest';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function post(msg: WorkerProgressMsg | WorkerTileDataMsg | WorkerCompleteMsg | WorkerErrorMsg, transfer: Transferable[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (self as any).postMessage(msg, transfer);
}

function progress(percent: number, message: string) {
  post({ type: 'progress', percent, message });
}

/** Axis-aligned bounding box overlap volume (0 if no overlap). */
function bboxOverlapVolume(a: TileBBox, b: TileBBox): number {
  const ox = Math.max(0, Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]));
  const oy = Math.max(0, Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]));
  const oz = Math.max(0, Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]));
  return ox * oy * oz;
}

/** Get IFC type name string from numeric code (best-effort). */
function typeCodeToName(api: WebIFC.IfcAPI, typeCode: number): string {
  try {
    return (api as any).GetNameFromTypeCode?.(typeCode) ?? String(typeCode);
  } catch {
    return String(typeCode);
  }
}

/** Expand interleaved [x,y,z, nx,ny,nz, ...] into separate position/normal arrays. */
function deinterleave(interleaved: Float32Array): { positions: Float32Array; normals: Float32Array } {
  const vertexCount = interleaved.length / 6;
  const positions = new Float32Array(vertexCount * 3);
  const normals   = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3]     = interleaved[i * 6];
    positions[i * 3 + 1] = interleaved[i * 6 + 1];
    positions[i * 3 + 2] = interleaved[i * 6 + 2];
    normals[i * 3]       = interleaved[i * 6 + 3];
    normals[i * 3 + 1]   = interleaved[i * 6 + 4];
    normals[i * 3 + 2]   = interleaved[i * 6 + 5];
  }
  return { positions, normals };
}

/** Apply a column-major 4×4 matrix (flatTransformation) to position array in-place. */
function applyMatrix4ToPositions(positions: Float32Array, m: Float32Array): void {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15]);
    positions[i]     = (m[0] * x + m[4] * y + m[8]  * z + m[12]) * w;
    positions[i + 1] = (m[1] * x + m[5] * y + m[9]  * z + m[13]) * w;
    positions[i + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;
  }
}

/** Apply rotation-only part of a column-major 4×4 matrix to normal array in-place. */
function applyMatrix4ToNormals(normals: Float32Array, m: Float32Array): void {
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    normals[i]     = m[0] * x + m[4] * y + m[8]  * z;
    normals[i + 1] = m[1] * x + m[5] * y + m[9]  * z;
    normals[i + 2] = m[2] * x + m[6] * y + m[10] * z;
    // re-normalize
    const len = Math.sqrt(normals[i]**2 + normals[i+1]**2 + normals[i+2]**2) || 1;
    normals[i] /= len; normals[i+1] /= len; normals[i+2] /= len;
  }
}

/** Compute AABB of a flat position array. */
function computeBBox(positions: Float32Array): TileBBox {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i+1], z = positions[i+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

function unionBBox(a: TileBBox, b: TileBBox): TileBBox {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/** Transform the 8 AABB corners of a local-space bbox through a column-major 4×4 matrix. */
function bboxWorldFromLocal(local: TileBBox, m: Float32Array): TileBBox {
  const corners: [number, number, number][] = [
    [local.min[0], local.min[1], local.min[2]],
    [local.max[0], local.min[1], local.min[2]],
    [local.min[0], local.max[1], local.min[2]],
    [local.max[0], local.max[1], local.min[2]],
    [local.min[0], local.min[1], local.max[2]],
    [local.max[0], local.min[1], local.max[2]],
    [local.min[0], local.max[1], local.max[2]],
    [local.max[0], local.max[1], local.max[2]],
  ];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [px, py, pz] of corners) {
    const w = 1 / (m[3] * px + m[7] * py + m[11] * pz + m[15]);
    const wx = (m[0] * px + m[4] * py + m[8]  * pz + m[12]) * w;
    const wy = (m[1] * px + m[5] * py + m[9]  * pz + m[13]) * w;
    const wz = (m[2] * px + m[6] * py + m[10] * pz + m[14]) * w;
    if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
    if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
    if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Parse storeys from model. Returns sorted ascending by elevation. */
function parseStoreys(api: WebIFC.IfcAPI, modelID: number): FloorInfo[] {
  const floors: FloorInfo[] = [];
  try {
    const storeyIds = api.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY);
    for (let i = 0; i < storeyIds.size(); i++) {
      const id = storeyIds.get(i);
      try {
        const data = api.GetLine(modelID, id, true);
        const name = (data?.Name?.value as string) ?? `Level ${i}`;
        let elevM = 0;
        const rawElev = data?.Elevation?.value;
        if (typeof rawElev === 'number') elevM = rawElev;
        floors.push({ id: `F${i}`, name, elevationM: elevM, heightM: 3.0 });
      } catch { /* skip malformed storey */ }
    }
  } catch { /* ignore if type not found */ }

  if (!floors.length) {
    floors.push({ id: 'F0', name: 'Level 0', elevationM: 0, heightM: 10 });
  }

  floors.sort((a, b) => a.elevationM - b.elevationM);

  // Compute heights from gaps between storeys
  for (let i = 0; i < floors.length - 1; i++) {
    floors[i].heightM = floors[i + 1].elevationM - floors[i].elevationM;
  }
  // Last floor: use average of computed heights (or 3.5 m default)
  if (floors.length > 1) {
    const avg = floors.slice(0, -1).reduce((s, f) => s + f.heightM, 0) / (floors.length - 1);
    floors[floors.length - 1].heightM = avg;
  }

  return floors;
}

/** Assign an element's centroid Y to the best floor. */
function assignFloor(centroidY: number, floors: FloorInfo[]): string {
  let best = floors[0];
  for (const f of floors) {
    if (f.elevationM <= centroidY) best = f;
  }
  return best.id;
}

/** Compute grid tile key from world X, Z position. */
function gridKey(x: number, z: number, gridSizeM: number): { col: number; row: number } {
  return {
    col: Math.floor(x / gridSizeM),
    row: Math.floor(z / gridSizeM),
  };
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function runPipeline(msg: WorkerProcessMsg): Promise<void> {
  const { ifcBuffer, gridSizeM, wasmPath } = msg;

  progress(0, 'Initialising web-ifc WASM…');

  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(wasmPath, true);
  await api.Init();

  progress(5, 'Parsing IFC model…');

  const data = new Uint8Array(ifcBuffer);
  const modelID = api.OpenModel(data, {
    COORDINATE_TO_ORIGIN: true,  // centre model at origin
  });

  // ── 1. Detect floors ──────────────────────────────────────────────────
  progress(8, 'Reading storey hierarchy…');
  const floors = parseStoreys(api, modelID);

  // ── 2. Build expressID → { category, type, name } map ─────────────────
  progress(12, 'Cataloguing elements…');

  const elementCatalog = new Map<number, { category: string; typeName: string; name: string }>();

  // Iterate the key IFC element types
  const typeQueries: [number, string][] = [
    [WebIFC.IFCWALL,               'wall'],
    [WebIFC.IFCWALLSTANDARDCASE,   'wall'],
    [WebIFC.IFCSLAB,               'slab'],
    [WebIFC.IFCCOLUMN,             'column'],
    [WebIFC.IFCBEAM,               'beam'],
    [WebIFC.IFCWINDOW,             'window'],
    [WebIFC.IFCDOOR,               'door'],
    [WebIFC.IFCSTAIR,              'stair'],
    [WebIFC.IFCSTAIRFLIGHT,        'stair'],
    [WebIFC.IFCROOF,               'roof'],
    [WebIFC.IFCCOVERING,           'other'],
    [WebIFC.IFCFURNISHINGELEMENT,  'furniture'],
    [WebIFC.IFCSPACE,              'space'],
    [WebIFC.IFCBUILDINGELEMENTPROXY, 'other'],
  ];

  for (const [typeCode, category] of typeQueries) {
    try {
      const ids = api.GetLineIDsWithType(modelID, typeCode);
      const typeName = typeCodeToName(api, typeCode);
      for (let i = 0; i < ids.size(); i++) {
        const id = ids.get(i);
        try {
          const line = api.GetLine(modelID, id);
          const name = (line?.Name?.value as string) ?? '';
          elementCatalog.set(id, { category, typeName, name });
        } catch {
          elementCatalog.set(id, { category, typeName, name: '' });
        }
      }
    } catch { /* type not present in model */ }
  }

  // ── 3. Stream all meshes — collect raw instances + cache base geometries ──
  progress(18, 'Streaming geometry…');

  // Cache: geomExpressID → base geometry in LOCAL space (allocated once per unique geom)
  interface BaseGeomEntry {
    positions: Float32Array;
    normals:   Float32Array;
    indices:   Uint32Array;
    localBBox: TileBBox;
  }
  const baseGeomCache = new Map<number, BaseGeomEntry>();

  // Per element-geometry placement, before tile assignment
  interface RawInstance {
    expressID: number;
    geomExpressID: number;
    matrix: Float32Array;    // 4×4 col-major (copy of flatTransformation)
    r: number; g: number; b: number; a: number;
    category: string; typeName: string; name: string;
    worldBBox: TileBBox;
    floor: string; tileId: string; col: number; row: number;
  }
  const rawInstances: RawInstance[] = [];

  let totalProcessed = 0;
  let globalBBox: TileBBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  api.StreamAllMeshes(modelID, (rawMesh) => {
    const { expressID, geometries } = rawMesh;
    const catalog = elementCatalog.get(expressID);
    const category = catalog?.category ?? 'other';
    const typeName = catalog?.typeName ?? 'IFCBUILDINGELEMENTPROXY';
    const elemName = catalog?.name ?? `#${expressID}`;
    const col4 = CATEGORY_COLOR[category] ?? CATEGORY_COLOR.other;

    for (let gi = 0; gi < geometries.size(); gi++) {
      const placed = geometries.get(gi);
      const geomExpressID = placed.geometryExpressID;
      const matrix = new Float32Array(placed.flatTransformation); // copy before WASM recycles

      // Get or populate base geometry cache
      let base = baseGeomCache.get(geomExpressID);
      if (!base) {
        const geomData = api.GetGeometry(modelID, geomExpressID);
        try {
          const vertData = api.GetVertexArray(geomData.GetVertexData(), geomData.GetVertexDataSize());
          const idxData  = api.GetIndexArray(geomData.GetIndexData(), geomData.GetIndexDataSize());
          if (!vertData.length || !idxData.length) { geomData.delete(); continue; }
          const { positions, normals } = deinterleave(vertData);
          const indices  = new Uint32Array(idxData);
          const localBBox = computeBBox(positions);
          base = { positions, normals, indices, localBBox };
          baseGeomCache.set(geomExpressID, base);
        } catch { try { geomData.delete(); } catch { /* ignore */ } continue; }
        geomData.delete();
      }

      // Compute world bbox via corner-transform (fast, no full position transform)
      const worldBBox = bboxWorldFromLocal(base.localBBox, matrix);
      if (worldBBox.min[0] === Infinity) continue;

      const centroidY = (worldBBox.min[1] + worldBBox.max[1]) * 0.5;
      const centroidX = (worldBBox.min[0] + worldBBox.max[0]) * 0.5;
      const centroidZ = (worldBBox.min[2] + worldBBox.max[2]) * 0.5;

      const floor = assignFloor(centroidY, floors);
      const { col, row } = gridKey(centroidX, centroidZ, gridSizeM);
      const tileId = `${floor}_G${col}_${row}`;

      const r = placed.color.x > 0 ? placed.color.x : col4[0];
      const g = placed.color.y > 0 ? placed.color.y : col4[1];
      const b = placed.color.z > 0 ? placed.color.z : col4[2];
      const a = placed.color.w > 0 ? placed.color.w : col4[3];

      rawInstances.push({ expressID, geomExpressID, matrix, r, g, b, a,
        category, typeName, name: elemName, worldBBox, floor, tileId, col, row });
      globalBBox = unionBBox(globalBBox, worldBBox);
    }

    totalProcessed++;
  });

  api.CloseModel(modelID);

  // ── 4. Classify per-tile: detect instanced geometry + merge element sub-meshes ──
  progress(55, `Classifying ${rawInstances.length} placements…`);

  // Group raw instances by tileId
  const tileRawMap = new Map<string, RawInstance[]>();
  for (const ri of rawInstances) {
    if (!tileRawMap.has(ri.tileId)) tileRawMap.set(ri.tileId, []);
    tileRawMap.get(ri.tileId)!.push(ri);
  }

  const totalTiles = tileRawMap.size;
  progress(60, `Grouped into ${totalTiles} tiles. Posting…`);

  // ── 5. Post tile_data messages ────────────────────────────────────────
  let tileIdx = 0;
  const manifest: TileManifestEntry[] = [];
  const metadata: ElementMetaMap = {};

  for (const [tileId, riList] of tileRawMap) {
    const pct = 60 + Math.round((tileIdx / totalTiles) * 35);
    progress(pct, `Posting tile ${tileIdx + 1}/${totalTiles}…`);

    // Count how many times each geomExpressID appears in this tile (for GPU instancing detection)
    const geomCount = new Map<number, number>();
    for (const ri of riList) {
      geomCount.set(ri.geomExpressID, (geomCount.get(ri.geomExpressID) ?? 0) + 1);
    }

    const elements: WorkerElementGeom[] = [];
    const instancedMap = new Map<number, WorkerInstancedGroup>();
    const categories = new Set<string>();
    let tileBBox: TileBBox = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity] };

    for (const ri of riList) {
      tileBBox = unionBBox(tileBBox, ri.worldBBox);
      categories.add(ri.category);
      const count = geomCount.get(ri.geomExpressID)!;

      if (count >= 2) {
        // GPU-instanced: keep base geometry in local space + per-instance matrix
        if (!instancedMap.has(ri.geomExpressID)) {
          instancedMap.set(ri.geomExpressID, {
            geomExpressID: ri.geomExpressID,
            positions: baseGeomCache.get(ri.geomExpressID)!.positions,
            normals:   baseGeomCache.get(ri.geomExpressID)!.normals,
            indices:   baseGeomCache.get(ri.geomExpressID)!.indices,
            instances: [],
            category: ri.category,
          });
        }
        instancedMap.get(ri.geomExpressID)!.instances.push({
          expressID: ri.expressID,
          matrix: Array.from(ri.matrix),
          r: ri.r, g: ri.g, b: ri.b, a: ri.a,
          category: ri.category, name: ri.name,
        });
        metadata[ri.expressID] = { expressID: ri.expressID, category: ri.category, name: ri.name, type: ri.typeName, tileId };
      } else {
        // Unique element (or sub-mesh of multi-sub-mesh element): apply transform → world-space
        // NOTE: Multiple rawInstances can share the same expressID (e.g. window frame + glass pane).
        // They are kept as separate meshes (each with its own color/transparency) and will be
        // stored as separate BatchedMesh instances. The viewer's globalExpressIDMap stores ALL
        // refs per expressID so that highlight/hide/delete operate on the full element.
        const base = baseGeomCache.get(ri.geomExpressID)!;
        const positions = new Float32Array(base.positions);
        const normals   = new Float32Array(base.normals);
        const indices   = new Uint32Array(base.indices);
        applyMatrix4ToPositions(positions, ri.matrix);
        applyMatrix4ToNormals(normals, ri.matrix);
        elements.push({
          expressID: ri.expressID, category: ri.category, ifcTypeName: ri.typeName, name: ri.name,
          r: ri.r, g: ri.g, b: ri.b, a: ri.a,
          positions, normals, indices,
          bboxMin: ri.worldBBox.min, bboxMax: ri.worldBBox.max,
        });
        metadata[ri.expressID] = { expressID: ri.expressID, category: ri.category, name: ri.name, type: ri.typeName, tileId };
      }
    }

    // Build final instancedGroups array — copy base geometry buffers per tile (can't transfer shared refs)
    const instancedGroups: WorkerInstancedGroup[] = [];
    const transferables: Transferable[] = [];

    for (const el of elements) {
      transferables.push(el.positions.buffer, el.normals.buffer, el.indices.buffer);
    }

    for (const group of instancedMap.values()) {
      const posCopy  = new Float32Array(group.positions);
      const normCopy = new Float32Array(group.normals);
      const idxCopy  = new Uint32Array(group.indices);
      instancedGroups.push({ ...group, positions: posCopy, normals: normCopy, indices: idxCopy });
      transferables.push(posCopy.buffer, normCopy.buffer, idxCopy.buffer);
    }

    const tileMsg: WorkerTileDataMsg = {
      type: 'tile_data', tileId,
      floor: riList[0].floor, gridCol: riList[0].col, gridRow: riList[0].row,
      bbox: tileBBox, elements, instancedGroups,
    };
    post(tileMsg, transferables);

    const instancedCount = instancedGroups.reduce((s, g) => s + g.instances.length, 0);
    manifest.push({
      id: tileId, floor: riList[0].floor, gridCol: riList[0].col, gridRow: riList[0].row,
      bbox: tileBBox,
      elementCount: elements.length + instancedCount,
      categories: Array.from(categories),
    });

    tileIdx++;
  }

  // ── 5b. Detect hosting walls for windows and doors ────────────────────
  progress(97, 'Computing opening–wall relationships…');

  const wallInstances = rawInstances.filter(ri => ri.category === 'wall');
  for (const ri of rawInstances) {
    if (ri.category !== 'window' && ri.category !== 'door') continue;
    if (!metadata[ri.expressID]) continue;

    // Expand window/door bbox slightly so it reliably overlaps its host wall
    const wb = ri.worldBBox;
    const expanded: TileBBox = {
      min: [wb.min[0] - 0.15, wb.min[1] - 0.05, wb.min[2] - 0.15],
      max: [wb.max[0] + 0.15, wb.max[1] + 0.05, wb.max[2] + 0.15],
    };

    let bestWall = -1;
    let bestVol = 0;
    for (const wall of wallInstances) {
      const vol = bboxOverlapVolume(expanded, wall.worldBBox);
      if (vol > bestVol) { bestVol = vol; bestWall = wall.expressID; }
    }
    if (bestWall >= 0 && bestVol > 1e-4) {
      metadata[ri.expressID].openingInfo = {
        hostWallExpressID: bestWall,
        openingBboxWorld: ri.worldBBox,
      };
    }
  }

  // ── 6. Post complete message ──────────────────────────────────────────
  progress(98, 'Building manifest…');

  const rootManifest: RootManifest = {
    version: '1',
    projectName: 'IFC Model',
    sourceHash: '',  // filled in by main thread (has the buffer)
    createdAt: new Date().toISOString(),
    bounds: globalBBox.min[0] === Infinity
      ? { min: [0,0,0], max: [0,0,0] }
      : globalBBox,
    gridSizeM,
    floors,
    tiles: manifest,
    metadataUrl: 'metadata.json',
  };

  post({ type: 'complete', manifest: rootManifest, metadata });
}

// ─── Worker entry point ───────────────────────────────────────────────────────

self.onmessage = async (ev: MessageEvent<WorkerProcessMsg>) => {
  const msg = ev.data;
  if (msg.type !== 'process') return;
  try {
    await runPipeline(msg);
  } catch (err) {
    const errMsg: WorkerErrorMsg = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(errMsg);
  }
};
