/**
 * ifcStepParser.ts — Client-side IFC STEP parser (TypeScript port of backend/ifc_parser.py)
 *
 * Pure text processing — no WASM, no backend, no external deps.
 * Extracts storeys, walls, slabs, grid axes directly from a .ifc ArrayBuffer.
 *
 * Output format is identical to the Python backend API response so the
 * existing 2D SVG plan / rig system works unchanged.
 */

// ── Types (mirror backend/api.ts shapes) ─────────────────────────────────────

export interface IFCOpening {
  type:                 'window' | 'door' | 'opening';
  name:                 string;
  width_mm:             number;
  height_mm:            number;
  sillHeight_mm:        number;
  offsetAlongWall_mm:   number;
}

export interface IFCWall {
  id:             string;
  guid:           string;
  name:           string;
  startPt_mm:     [number, number];
  endPt_mm:       [number, number];
  thickness_mm:   number;
  height_mm:      number;
  openings:       IFCOpening[];
  footprint_mm:   [number, number][];
}

export interface IFCSlab {
  id:               string;
  guid:             string;
  name:             string;
  footprint_mm:     [number, number][];
  thickness_mm:     number;
  baseElevation_mm: number;
}

export interface IFCStorey {
  id:            string;
  name:          string;
  elevation_mm:  number;
  height_mm:     number;
  walls:         IFCWall[];
  slabs:         IFCSlab[];
  axesX_mm:      number[];
  axesY_mm:      number[];
}

export interface IFCPlanResult {
  storeys:     IFCStorey[];
  totalWalls:  number;
  totalSlabs:  number;
  worldBounds: [number, number, number, number]; // minX, minY, maxX, maxY mm
}

// ── STEP tokeniser ─────────────────────────────────────────────────────────

const LINE_RE = /^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\((.*)\)\s*;?\s*$/i;

function tokeniseArgs(s: string): string[] {
  const args: string[] = [];
  let depth  = 0;
  let start  = 0;
  let inStr  = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inStr) { inStr = true; }
    else if (c === "'" && inStr) { inStr = false; }
    else if (!inStr) {
      if      (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        args.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  const last = s.slice(start).trim();
  if (last) args.push(last);
  return args;
}

function unquote(s: string): string {
  s = s.trim();
  if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
  s = s.replace(/\\X2\\[0-9A-Fa-f]+\\X0\\/g, '?');
  return s;
}

function ref(s: string): number | null {
  s = s.trim();
  if (s.startsWith('#')) {
    const n = parseInt(s.slice(1), 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

function flt(s: string): number {
  const n = parseFloat(s.trim());
  return isNaN(n) ? 0 : n;
}

function inner(s: string): string {
  s = s.trim();
  if (s.startsWith('(') && s.endsWith(')')) return s.slice(1, -1);
  return s;
}

// ── IFC entity table ────────────────────────────────────────────────────────

type EntityMap = Map<number, [string, string[]]>;

function parseStepText(text: string): EntityMap {
  const map: EntityMap = new Map();

  // Re-join logical lines ending with ;
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n');
  let buf = '';
  const logical: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('HEADER;') || trimmed.startsWith('ENDSEC;') ||
        trimmed.startsWith('ISO-')    || trimmed.startsWith('DATA;')   ||
        trimmed.startsWith('END-ISO') || trimmed.startsWith('/*')      ||
        trimmed.startsWith('//'))      continue;
    buf += trimmed;
    if (trimmed.endsWith(';')) {
      logical.push(buf);
      buf = '';
    }
  }
  if (buf) logical.push(buf);

  for (const line of logical) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const eid  = parseInt(m[1], 10);
    const type = m[2].toUpperCase();
    const args = tokeniseArgs(m[3]);
    map.set(eid, [type, args]);
  }

  return map;
}

function getEntity(map: EntityMap, id: number | null): [string, string[]] | null {
  if (id == null) return null;
  return map.get(id) ?? null;
}

function findAll(map: EntityMap, type: string): [number, string[]][] {
  type = type.toUpperCase();
  const result: [number, string[]][] = [];
  for (const [eid, [t, args]] of map) {
    if (t === type) result.push([eid, args]);
  }
  return result;
}

// ── Geometry helpers ────────────────────────────────────────────────────────

function cartPoint(map: EntityMap, id: number | null): [number, number, number] {
  if (id == null) return [0, 0, 0];
  const e = getEntity(map, id);
  if (!e) return [0, 0, 0];
  const coords = inner(e[1][0]).split(',');
  return [
    flt(coords[0] ?? '0'),
    flt(coords[1] ?? '0'),
    flt(coords[2] ?? '0'),
  ];
}

function direction(map: EntityMap, id: number | null): [number, number, number] {
  if (id == null) return [0, 0, 1];
  const e = getEntity(map, id);
  if (!e) return [0, 0, 1];
  const coords = inner(e[1][0]).split(',');
  return [
    flt(coords[0] ?? '0'),
    flt(coords[1] ?? '0'),
    flt(coords[2] ?? '1'),
  ];
}

function axis2placement3d(
  map:   EntityMap,
  axId:  number | null,
): { origin: [number, number, number]; xDir: [number, number, number]; zDir: [number, number, number] } {
  if (axId == null) return { origin: [0,0,0], xDir: [1,0,0], zDir: [0,0,1] };
  const e = getEntity(map, axId);
  if (!e) return { origin: [0,0,0], xDir: [1,0,0], zDir: [0,0,1] };
  const args = e[1];
  const locId = ref(args[0]);
  const zId   = args[1] && args[1] !== '$' ? ref(args[1]) : null;
  const xId   = args[2] && args[2] !== '$' ? ref(args[2]) : null;
  return {
    origin: [...cartPoint(map, locId)] as [number, number, number],
    xDir:   [...direction(map, xId)]   as [number, number, number],
    zDir:   [...direction(map, zId)]   as [number, number, number],
  };
}

function resolvePlacement(
  map:         EntityMap,
  placementId: number | null,
): { origin: [number, number, number]; xDir: [number, number, number] } {
  let ox = 0, oy = 0, oz = 0;
  let xx = 1, xy = 0;

  const chain: (number | null)[] = [];
  let cur: number | null = placementId;

  while (cur != null) {
    const e = getEntity(map, cur);
    if (!e) break;
    const [etype, args] = e;
    if (etype === 'IFCLOCALPLACEMENT') {
      const parentRef = args[0] && args[0] !== '$' ? ref(args[0]) : null;
      const axRef     = args[1] ? ref(args[1]) : null;
      chain.push(axRef);
      cur = parentRef;
    } else break;
  }

  for (let i = chain.length - 1; i >= 0; i--) {
    const axId = chain[i];
    if (axId == null) continue;
    const e = getEntity(map, axId);
    if (!e) continue;
    const [etype, args] = e;
    if (etype !== 'IFCAXIS2PLACEMENT3D') continue;
    const locId = ref(args[0]);
    const zId   = args[1] && args[1] !== '$' ? ref(args[1]) : null;
    const xId   = args[2] && args[2] !== '$' ? ref(args[2]) : null;
    const [lx, ly, lz] = cartPoint(map, locId);
    void lz; void zId;
    ox += lx; oy += ly; oz += lz;
    if (xId) {
      const [dxx, dxy] = direction(map, xId);
      xx = dxx; xy = dxy;
    }
  }
  return { origin: [ox, oy, oz], xDir: [xx, xy, 0] };
}

// ── Relationship maps ───────────────────────────────────────────────────────

interface RelMaps {
  storeyElements: Map<number, number[]>;
  wallOpenings:   Map<number, number[]>;
  openingFills:   Map<number, number>;
}

function buildRelMaps(map: EntityMap): RelMaps {
  const storeyElements = new Map<number, number[]>();
  for (const [, args] of findAll(map, 'IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
    const structureId = ref(args[5]);
    if (structureId == null) continue;
    const elemStr = inner(args[4] ?? '');
    const elemIds = elemStr.split(',')
      .map((r) => ref(r.trim()))
      .filter((x): x is number => x != null);
    const prev = storeyElements.get(structureId) ?? [];
    storeyElements.set(structureId, [...prev, ...elemIds]);
  }

  const wallOpenings = new Map<number, number[]>();
  for (const [, args] of findAll(map, 'IFCRELVOIDSELEMENT')) {
    const wallId    = ref(args[4]);
    const openingId = ref(args[5]);
    if (wallId == null || openingId == null) continue;
    const prev = wallOpenings.get(wallId) ?? [];
    wallOpenings.set(wallId, [...prev, openingId]);
  }

  const openingFills = new Map<number, number>();
  for (const [, args] of findAll(map, 'IFCRELFILLSELEMENT')) {
    const openingId  = ref(args[4]);
    const elementId  = ref(args[5]);
    if (openingId == null || elementId == null) continue;
    openingFills.set(openingId, elementId);
  }

  return { storeyElements, wallOpenings, openingFills };
}

// ── Wall geometry ───────────────────────────────────────────────────────────

interface WallRaw {
  guid:      string;
  name:      string;
  startPt:   [number, number];
  endPt:     [number, number];
  baseZ:     number;
  thickness: number;
  height:    number;
}

function extractWallAxis(map: EntityMap, wallId: number): WallRaw | null {
  const e = getEntity(map, wallId);
  if (!e) return null;
  const [etype, args] = e;
  if (etype !== 'IFCWALL' && etype !== 'IFCWALLSTANDARDCASE') return null;

  const guid         = unquote(args[0] ?? '');
  const name         = unquote(args[2] ?? '');
  const placementId  = ref(args[5]);
  const repId        = ref(args[6]);

  const { origin, xDir } = resolvePlacement(map, placementId);

  const axisPts: [number, number, number][] = [];

  if (repId != null) {
    const eRep = getEntity(map, repId);
    if (eRep) {
      const shapeListStr = inner(eRep[1][2] ?? '');
      const shapeIds = shapeListStr.split(',').map((r) => ref(r.trim())).filter((x): x is number => x != null);

      for (const shId of shapeIds) {
        const sh = getEntity(map, shId);
        if (!sh) continue;
        const shArgs  = sh[1];
        const repTag  = (shArgs[1] ?? '').trim().replace(/'/g, '');
        if (repTag !== 'Axis') continue;

        const itemsStr = inner(shArgs[3] ?? '');
        const itemIds  = itemsStr.split(',').map((r) => ref(r.trim())).filter((x): x is number => x != null);

        for (const itId of itemIds) {
          const it = getEntity(map, itId);
          if (!it) continue;
          const [itType, itArgs] = it;

          if (itType === 'IFCPOLYLINE') {
            const ptsStr = inner(itArgs[0] ?? '');
            const ptIds  = ptsStr.split(',').map((r) => ref(r.trim())).filter((x): x is number => x != null);
            for (const ptId of ptIds) axisPts.push(cartPoint(map, ptId));
          }

          if (itType === 'IFCINDEXEDPOLYCURVE') {
            const ptListId = ref(itArgs[0]);
            const ptList   = getEntity(map, ptListId);
            if (ptList && (ptList[0] === 'IFCCARTESIANPOINTLIST2D' || ptList[0] === 'IFCCARTESIANPOINTLIST3D')) {
              const raw = ptList[1][0] ?? '';
              const tupMatches = raw.matchAll(/\(([^()]+)\)/g);
              for (const tup of tupMatches) {
                const coords = tup[1].split(',');
                axisPts.push([flt(coords[0]), flt(coords[1] ?? '0'), flt(coords[2] ?? '0')]);
              }
            }
          }
        }
      }
    }
  }

  if (axisPts.length < 2) return null;

  const yDir: [number, number, number] = [-xDir[1], xDir[0], 0];

  function transformPt(pt: [number, number, number]): [number, number, number] {
    return [
      origin[0] + pt[0] * xDir[0] + pt[1] * yDir[0],
      origin[1] + pt[0] * xDir[1] + pt[1] * yDir[1],
      origin[2] + pt[2],
    ];
  }

  const p1 = transformPt(axisPts[0]);
  const p2 = transformPt(axisPts[1]);

  return {
    guid,
    name,
    startPt:   [p1[0], p1[1]],
    endPt:     [p2[0], p2[1]],
    baseZ:     p1[2],
    thickness: 0.25, // default 25 cm
    height:    3.0,  // default 3 m
  };
}

// ── Opening geometry ─────────────────────────────────────────────────────────

function extractOpening(
  map:       EntityMap,
  openingId: number,
  fillId:    number | null,
  wall:      WallRaw | null,
): IFCOpening | null {
  const e = getEntity(map, openingId);
  if (!e || e[0] !== 'IFCOPENINGELEMENT') return null;

  const args       = e[1];
  const placementId = ref(args[5]);
  const { origin } = resolvePlacement(map, placementId);

  let opType:   IFCOpening['type'] = 'opening';
  let widthM    = 1.0;
  let heightM   = 2.0;
  let sillM     = 0.8;
  let fillName  = '';

  if (fillId != null) {
    const fe = getEntity(map, fillId);
    if (fe) {
      const [fetype, fargs] = fe;
      fillName = unquote(fargs[2] ?? '');
      if (fetype === 'IFCWINDOW') {
        opType  = 'window';
        heightM = fargs[7] && fargs[7] !== '$' ? flt(fargs[7]) : 2.0;
        widthM  = fargs[8] && fargs[8] !== '$' ? flt(fargs[8]) : 1.0;
      } else if (fetype === 'IFCDOOR') {
        opType  = 'door';
        heightM = fargs[7] && fargs[7] !== '$' ? flt(fargs[7]) : 2.2;
        widthM  = fargs[8] && fargs[8] !== '$' ? flt(fargs[8]) : 0.9;
        sillM   = 0.0;
      }
    }
  }

  let offsetAlongWall = 0;
  if (wall) {
    const [wx1, wy1] = wall.startPt;
    const [wx2, wy2] = wall.endPt;
    const dx = wx2 - wx1; const dy = wy2 - wy1;
    const wlen = Math.hypot(dx, dy);
    if (wlen > 0.001) {
      const ox = origin[0] - wx1; const oy = origin[1] - wy1;
      const t  = (ox * dx + oy * dy) / (wlen * wlen);
      offsetAlongWall = t * wlen;
    }
    sillM = origin[2] - (wall.baseZ ?? 0);
  }

  return {
    type:               opType,
    name:               fillName,
    width_mm:           Math.round(widthM  * 1000),
    height_mm:          Math.round(heightM * 1000),
    sillHeight_mm:      Math.round(Math.max(0, sillM) * 1000),
    offsetAlongWall_mm: Math.round(offsetAlongWall * 1000),
  };
}

// ── Grid detection ───────────────────────────────────────────────────────────

function cluster(values: number[], tol = 0.15): number[] {
  if (!values.length) return [];
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const clusters: number[][] = [];
  let cur: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - cur[cur.length - 1] <= tol) {
      cur.push(sorted[i]);
    } else {
      clusters.push(cur);
      cur = [sorted[i]];
    }
  }
  clusters.push(cur);
  return clusters
    .map((c) => c.reduce((a, b) => a + b, 0) / c.length)
    .sort((a, b) => a - b);
}

function detectGrid(walls: WallRaw[]): { axesX: number[]; axesY: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const w of walls) {
    xs.push(w.startPt[0], w.endPt[0]);
    ys.push(w.startPt[1], w.endPt[1]);
  }
  return { axesX: cluster(xs), axesY: cluster(ys) };
}

// ── Wall footprint ────────────────────────────────────────────────────────────

function wallFootprintMm(wall: IFCWall): [number, number][] {
  const [x1, y1] = wall.startPt_mm;
  const [x2, y2] = wall.endPt_mm;
  const dx = x2 - x1; const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return [];
  const ux = dx / len; const uy = dy / len;
  const px = -uy; const py = ux;
  const half = wall.thickness_mm / 2;
  return [
    [Math.round(x1 + px * half), Math.round(y1 + py * half)],
    [Math.round(x2 + px * half), Math.round(y2 + py * half)],
    [Math.round(x2 - px * half), Math.round(y2 - py * half)],
    [Math.round(x1 - px * half), Math.round(y1 - py * half)],
  ];
}

// ── Slab geometry ─────────────────────────────────────────────────────────────

function polygonArea2d(pts: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i][0] * pts[j][1];
    area -= pts[j][0] * pts[i][1];
  }
  return Math.abs(area) / 2;
}

interface SlabRaw {
  guid:      string;
  name:      string;
  footprint: [number, number][];
  thickness: number;
  baseZ:     number;
}

function parsePolygonalFaceSet(
  map:       EntityMap,
  facesetId: number,
): { vertices: [number, number, number][]; flatFaces: [number, number, number][][] } | null {
  const e = getEntity(map, facesetId);
  if (!e || e[0] !== 'IFCPOLYGONALFACESET') return null;
  const args = e[1];

  const ptListId = ref(args[0]);
  const ptList   = getEntity(map, ptListId);
  if (!ptList) return null;

  const raw = ptList[1][0] ?? '';
  const tuples = raw.matchAll(/\(([^()]+)\)/g);
  const vertices: [number, number, number][] = [];
  for (const tup of tuples) {
    const c = tup[1].split(',');
    if (c.length >= 3) vertices.push([flt(c[0]), flt(c[1]), flt(c[2])]);
  }
  if (!vertices.length) return null;

  const faceListRaw = (args[2] ?? '').trim().replace(/^\(|\)$/g, '');
  const faceRefs    = faceListRaw.split(',').map((r) => ref(r.trim())).filter((x): x is number => x != null);

  const flatFaces: [number, number, number][][] = [];
  for (const fid of faceRefs) {
    const fe = getEntity(map, fid);
    if (!fe) continue;
    const [ftype, fargs] = fe;
    if (ftype !== 'IFCINDEXEDPOLYGONALFACE' && ftype !== 'IFCINDEXEDPOLYGONALFACEWITHVOIDS') continue;
    const idxRaw = (fargs[0] ?? '').trim().replace(/^\(|\)$/g, '');
    const idxs   = idxRaw.split(',').map((i) => parseInt(i.trim(), 10)).filter((n) => !isNaN(n));
    const fverts = idxs.filter((i) => i >= 1 && i <= vertices.length).map((i) => vertices[i - 1]);
    if (fverts.length < 3) continue;
    const zs = new Set(fverts.map((v) => Math.round(v[2] * 10000)));
    if (zs.size === 1) flatFaces.push(fverts);
  }

  return { vertices, flatFaces };
}

function extractSlabData(map: EntityMap, slabId: number): SlabRaw | null {
  const e = getEntity(map, slabId);
  if (!e || e[0] !== 'IFCSLAB') return null;
  const args = e[1];

  const guid        = unquote(args[0] ?? '');
  const name        = unquote(args[2] ?? '');
  const placementId = ref(args[5]);
  const repId       = ref(args[6]);
  if (repId == null) return null;

  const { origin, xDir } = resolvePlacement(map, placementId);
  const yDir: [number, number, number] = [-xDir[1], xDir[0], 0];

  function trSlab(pt: [number, number, number]): [number, number, number] {
    return [
      origin[0] + pt[0] * xDir[0] + pt[1] * yDir[0],
      origin[1] + pt[0] * xDir[1] + pt[1] * yDir[1],
      origin[2] + pt[2],
    ];
  }

  const eRep = getEntity(map, repId);
  if (!eRep) return null;
  const shapeListStr = inner(eRep[1][2] ?? '');
  const shapeIds     = shapeListStr.split(',').map((r) => ref(r.trim())).filter((x): x is number => x != null);

  let facesetResult: ReturnType<typeof parsePolygonalFaceSet> | null = null;
  for (const shId of shapeIds) {
    const sh = getEntity(map, shId);
    if (!sh) continue;
    const repTag = (sh[1][1] ?? '').trim().replace(/'/g, '');
    if (repTag !== 'Body') continue;
    const itemsStr = inner(sh[1][3] ?? '');
    const itemIds  = itemsStr.split(',').map((r) => ref(r.trim())).filter((x): x is number => x != null);
    for (const itId of itemIds) {
      const it = getEntity(map, itId);
      if (it && it[0] === 'IFCPOLYGONALFACESET') {
        facesetResult = parsePolygonalFaceSet(map, itId);
        if (facesetResult) break;
      }
    }
    if (facesetResult) break;
  }

  if (!facesetResult || !facesetResult.flatFaces.length) return null;

  const { vertices, flatFaces } = facesetResult;
  const allZ    = vertices.map((v) => v[2]);
  const maxZ    = Math.max(...allZ);
  const minZ    = Math.min(...allZ);
  const thk     = maxZ - minZ;
  if (thk < 0.001) return null;

  const topFaces = flatFaces.filter((f) => Math.abs(f[0][2] - maxZ) < 0.002);
  const bestFaces = topFaces.length ? topFaces : flatFaces;

  function faceArea(f: [number, number, number][]): number {
    return polygonArea2d(f.map((v) => [v[0], v[1]]));
  }
  const bestLocal = bestFaces.reduce((best, f) => faceArea(f) >= faceArea(best) ? f : best, bestFaces[0]);

  const worldPts = bestLocal.map(trSlab);
  const fp2d: [number, number][] = worldPts.map((p) => [p[0], p[1]]);

  if (polygonArea2d(fp2d) < 0.25) return null;

  return { guid, name, footprint: fp2d, thickness: thk, baseZ: origin[2] + minZ };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Parse a .ifc ArrayBuffer entirely client-side.
 * Returns the same shape as the Python backend's /api/ifc/plan endpoint.
 */
export async function parseIfcPlan(buffer: ArrayBuffer): Promise<IFCPlanResult> {
  // Decode to text (IFC STEP is always UTF-8 or ASCII)
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

  // Build entity table
  const map = parseStepText(text);

  // Relationship maps
  const rels = buildRelMaps(map);

  // Collect storeys sorted by elevation
  const storeyList: { id: number; name: string; elevM: number }[] = [];
  for (const [eid, args] of findAll(map, 'IFCBUILDINGSTOREY')) {
    const name = unquote(args[2] ?? '') || `Storey-${eid}`;
    const elevM = args[9] && args[9] !== '$' ? flt(args[9]) : 0;
    storeyList.push({ id: eid, name, elevM });
  }
  storeyList.sort((a, b) => a.elevM - b.elevM);

  if (!storeyList.length) {
    return { storeys: [], totalWalls: 0, totalSlabs: 0, worldBounds: [0, 0, 10000, 10000] };
  }

  const MM = 1000;
  const storeys: IFCStorey[] = [];
  let totalWalls = 0;
  let totalSlabs = 0;
  let globalMinX = Infinity, globalMinY = Infinity;
  let globalMaxX = -Infinity, globalMaxY = -Infinity;

  for (let si = 0; si < storeyList.length; si++) {
    const { id: storeyId, name, elevM } = storeyList[si];
    const nextElevM = storeyList[si + 1]?.elevM ?? (elevM + 3.0);
    const heightM   = nextElevM - elevM;

    const elementIds = rels.storeyElements.get(storeyId) ?? [];

    // ── Walls ──────────────────────────────────────────────────────────
    const wallsOut: IFCWall[] = [];
    for (const wallId of elementIds) {
      const e = getEntity(map, wallId);
      if (!e) continue;
      const [etype] = e;
      if (etype !== 'IFCWALL' && etype !== 'IFCWALLSTANDARDCASE') continue;

      const raw = extractWallAxis(map, wallId);
      if (!raw) continue;

      const openings: IFCOpening[] = [];
      for (const opId of rels.wallOpenings.get(wallId) ?? []) {
        const fillId = rels.openingFills.get(opId) ?? null;
        const op = extractOpening(map, opId, fillId, raw);
        if (op) openings.push(op);
      }

      const wall: IFCWall = {
        id:           `w_${si}_${wallsOut.length}`,
        guid:         raw.guid,
        name:         raw.name,
        startPt_mm:   [Math.round(raw.startPt[0] * MM), Math.round(raw.startPt[1] * MM)],
        endPt_mm:     [Math.round(raw.endPt[0]   * MM), Math.round(raw.endPt[1]   * MM)],
        thickness_mm: Math.round(raw.thickness * MM),
        height_mm:    Math.round(heightM * MM),
        openings,
        footprint_mm: [],
      };
      wall.footprint_mm = wallFootprintMm(wall);
      wallsOut.push(wall);

      for (const pt of [wall.startPt_mm, wall.endPt_mm]) {
        if (pt[0] < globalMinX) globalMinX = pt[0];
        if (pt[1] < globalMinY) globalMinY = pt[1];
        if (pt[0] > globalMaxX) globalMaxX = pt[0];
        if (pt[1] > globalMaxY) globalMaxY = pt[1];
      }
    }

    // ── Slabs ──────────────────────────────────────────────────────────
    const slabsOut: IFCSlab[] = [];
    for (const slabId of elementIds) {
      const e = getEntity(map, slabId);
      if (!e || e[0] !== 'IFCSLAB') continue;

      const raw = extractSlabData(map, slabId);
      if (!raw) continue;

      slabsOut.push({
        id:               `sl_${si}_${slabsOut.length}`,
        guid:             raw.guid,
        name:             raw.name,
        footprint_mm:     raw.footprint.map(([x, y]) => [Math.round(x * MM), Math.round(y * MM)] as [number, number]),
        thickness_mm:     Math.round(raw.thickness * MM),
        baseElevation_mm: Math.round(raw.baseZ * MM),
      });
    }

    // ── Grid ───────────────────────────────────────────────────────────
    const rawWallsForGrid = wallsOut.map((w) => ({
      startPt: [w.startPt_mm[0] / MM, w.startPt_mm[1] / MM] as [number, number],
      endPt:   [w.endPt_mm[0]   / MM, w.endPt_mm[1]   / MM] as [number, number],
      thickness: w.thickness_mm / MM,
      height:    w.height_mm    / MM,
      baseZ:     0,
      guid:      w.guid,
      name:      w.name,
    }));
    const { axesX, axesY } = detectGrid(rawWallsForGrid);

    storeys.push({
      id:           `storey_${si}`,
      name,
      elevation_mm: Math.round(elevM * MM),
      height_mm:    Math.round(heightM * MM),
      walls:        wallsOut,
      slabs:        slabsOut,
      axesX_mm:     axesX.map((v) => Math.round(v * MM)),
      axesY_mm:     axesY.map((v) => Math.round(v * MM)),
    });

    totalWalls += wallsOut.length;
    totalSlabs += slabsOut.length;
  }

  // Safe fallback bounds
  if (!isFinite(globalMinX)) { globalMinX = 0; globalMaxX = 10000; globalMinY = 0; globalMaxY = 10000; }

  return {
    storeys,
    totalWalls,
    totalSlabs,
    worldBounds: [globalMinX, globalMinY, globalMaxX, globalMaxY],
  };
}
