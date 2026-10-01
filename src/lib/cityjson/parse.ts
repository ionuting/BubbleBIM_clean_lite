/**
 * parse.ts — a CityJSON file as something a viewer can draw.
 *
 * CityJSON is the one exchange format in this app a browser can read by
 * itself: it is JSON, its geometry is indices into one vertex list, and there
 * is no compression scheme or binary chunk to decode. So there is no server
 * round trip here — unlike a point cloud or a tileset, the file is parsed
 * where it is dropped.
 *
 * What comes out is per CityObject: a flat position array, per-vertex
 * normals, triangle indices, and one colour. That is what Cesium wants and it
 * is also what the tests can check without a viewer.
 *
 * ## Four things the format does that you have to honour
 *
 * **Vertices are integers.** `transform.scale` and `transform.translate` turn
 * them into real coordinates, and they are mandatory from 1.1 on. Read them
 * as coordinates and a building ends up seventy kilometres across.
 *
 * **Boundaries nest by geometry type.** A MultiSurface's boundaries are
 * surfaces; a Solid's are shells OF surfaces; a MultiSolid's are solids of
 * shells of surfaces. One level wrong and every index is read as a ring.
 *
 * **Rings are not closed** — the first vertex is not repeated at the end.
 * Writers close them anyway, this project's own exporter included, so the
 * triangulator accepts both.
 *
 * **Colour lives in two places.** `appearance.materials` with a per-surface
 * `material` theme, and `semantics` with surface types. Materials win where
 * they exist because they are what the author chose; semantics are the
 * fallback everyone recognises — roof, wall, ground.
 *
 * ## Where on Earth it goes
 *
 * A CityJSON file may be in a projected CRS, and then its coordinates are
 * hundreds of kilometres from zero. Placing that at the project's insertion
 * point would put the model in the next country. There is no reprojection
 * here — that needs a full CRS database — so instead the extent is measured:
 * a model far from the origin is RECENTRED onto the insertion point and the
 * caller is told, which is at least an honest answer and puts the geometry
 * where it can be looked at.
 */
import { triangulateSurface, type P3 } from './triangulate';

/** How far from the origin a model has to be before its coordinates are read as absolute. */
export const ABSOLUTE_COORD_THRESHOLD_M = 10_000;

export interface CityObjectMesh {
  id: string;
  type: string;
  /** The CityObject's own attributes, for the inspector and for picking. */
  attributes: Record<string, unknown>;
  /**
   * The objects this one belongs to. A BuildingPart or an installation is
   * only half a thing without its Building, so the attribute panel shows it.
   */
  parents?: string[];
  /** Flat XYZ triples, metres, already recentred if the file was absolute. */
  positions: Float64Array;
  /** Flat XYZ triples, one per position — flat shading, so a normal per corner. */
  normals: Float32Array;
  indices: Uint32Array;
  /** `#rrggbb`. */
  color: string;
  /** 0 = opaque. */
  transparency: number;
  lod?: string;
}

export interface CityJsonModel {
  version: string;
  objects: CityObjectMesh[];
  /** Metres, after recentring: what the viewer has to fit. */
  extent: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  /** The shift applied because the file was in absolute coordinates, metres. */
  recentred: { x: number; y: number } | null;
  /** From `metadata.referenceSystem`, verbatim, when the file names one. */
  crs: string | null;
  counts: { objects: number; drawn: number; triangles: number; vertices: number };
  /** Anything skipped, in words — shown rather than swallowed. */
  warnings: string[];
}

interface RawGeometry {
  type: string;
  lod?: string | number;
  boundaries: unknown;
  semantics?: { surfaces?: { type?: string }[]; values?: unknown };
  material?: Record<string, { values?: unknown; value?: number }>;
  template?: number;
  transformationMatrix?: number[];
}

interface RawObject {
  type?: string;
  attributes?: Record<string, unknown>;
  parents?: string[];
  geometry?: RawGeometry[];
}

interface RawMaterial {
  name?: string;
  diffuseColor?: number[];
  transparency?: number;
}

/** Colours for the semantic surface types, when a file has no materials. */
const SEMANTIC_COLORS: Record<string, string> = {
  RoofSurface: '#b0413e',
  WallSurface: '#d9d0c9',
  GroundSurface: '#5a5a5a',
  ClosureSurface: '#9aa0a6',
  OuterCeilingSurface: '#c8b8a6',
  OuterFloorSurface: '#8d8d8d',
  Window: '#7fb3d5',
  Door: '#a0522d',
  WaterSurface: '#4f86c6',
  TrafficArea: '#8a8a8a',
  AuxiliaryTrafficArea: '#a5b48a',
};

/** Fallbacks by CityObject type, so a file with neither still reads. */
const TYPE_COLORS: Record<string, string> = {
  Building: '#d9cfc2',
  BuildingPart: '#d9cfc2',
  BuildingInstallation: '#bfae9b',
  Bridge: '#9fa8b0',
  Road: '#8a8a8a',
  Railway: '#6f6f6f',
  TINRelief: '#8fae6b',
  PlantCover: '#7f9f5b',
  SolitaryVegetationObject: '#6f9350',
  WaterBody: '#4f86c6',
  CityFurniture: '#b08968',
  GenericCityObject: '#aaaaaa',
  OtherConstruction: '#b3b3b3',
};

const DEFAULT_COLOR = '#b9b9b9';

const hex = (rgb: number[] | undefined): string | null => {
  if (!Array.isArray(rgb) || rgb.length < 3) return null;
  // CityJSON says 0–1. A writer that emits 0–255 is common enough to survive.
  const scale = rgb.some((v) => v > 1.001) ? 1 / 255 : 1;
  const two = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v * scale)) * 255).toString(16).padStart(2, '0');
  return `#${two(rgb[0])}${two(rgb[1])}${two(rgb[2])}`;
};

/**
 * The surfaces of one geometry, whatever its nesting.
 *
 * Every CityJSON geometry bottoms out in a surface — an array of rings, each
 * an array of vertex indices — and the types differ only in how many arrays
 * are wrapped around that. Rather than a case per type, the nesting is
 * measured: descend until the next level down is a list of numbers.
 */
export function surfacesOf(boundaries: unknown): number[][][] {
  const out: number[][][] = [];
  const walk = (b: unknown): void => {
    if (!Array.isArray(b) || b.length === 0) return;
    const first = b[0];
    // A surface is an array of rings; a ring is an array of numbers.
    if (Array.isArray(first) && typeof first[0] === 'number') {
      out.push(b as number[][]);
      return;
    }
    if (typeof first === 'number') return;      // a bare ring: not a surface
    for (const child of b) walk(child);
  };
  walk(boundaries);
  return out;
}

/**
 * The semantic type of each surface, flattened to match `surfacesOf`.
 *
 * `semantics.values` nests exactly like `boundaries` does, one level
 * shallower — an index into `semantics.surfaces`, or null.
 */
function semanticsOf(g: RawGeometry, count: number): (string | undefined)[] {
  const surfaces = g.semantics?.surfaces;
  if (!surfaces || g.semantics?.values === undefined) return [];
  const flat: (number | null)[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const c of v) walk(c); return; }
    flat.push(typeof v === 'number' ? v : null);
  };
  walk(g.semantics.values);
  if (flat.length !== count) return [];
  return flat.map((i) => (i === null ? undefined : surfaces[i]?.type));
}

/** The material index of each surface, for the theme in use. */
function materialsOf(g: RawGeometry, theme: string | null, count: number): (number | undefined)[] {
  if (!theme || !g.material?.[theme]) return [];
  const m = g.material[theme];
  if (typeof m.value === 'number') return new Array(count).fill(m.value);
  const flat: (number | null)[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const c of v) walk(c); return; }
    flat.push(typeof v === 'number' ? v : null);
  };
  walk(m.values);
  if (flat.length !== count) return [];
  return flat.map((i) => (i === null ? undefined : i));
}

const norm = (ax: number, ay: number, az: number): [number, number, number] => {
  const m = Math.hypot(ax, ay, az);
  return m < 1e-12 ? [0, 0, 1] : [ax / m, ay / m, az / m];
};

/**
 * Read a CityJSON document.
 *
 * Throws only when the file is not CityJSON at all. Anything it cannot draw —
 * a geometry template, an unreadable surface — is counted in `warnings` and
 * the rest of the model still loads, because half a city is more useful than
 * an error message.
 */
export function parseCityJson(text: string): CityJsonModel {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('Fișierul nu este JSON valid.');
  }
  if (doc?.type !== 'CityJSON') {
    throw new Error('Nu este un fișier CityJSON (lipsește "type": "CityJSON").');
  }
  const version = String(doc.version ?? '');
  const rawVertices = doc.vertices;
  if (!Array.isArray(rawVertices)) throw new Error('CityJSON fără "vertices".');

  const warnings: string[] = [];

  // ── Vertices, de-quantised ──────────────────────────────────────────────
  const t = doc.transform as { scale?: number[]; translate?: number[] } | undefined;
  const sx = t?.scale?.[0] ?? 1, sy = t?.scale?.[1] ?? 1, sz = t?.scale?.[2] ?? 1;
  const tx = t?.translate?.[0] ?? 0, ty = t?.translate?.[1] ?? 0, tz = t?.translate?.[2] ?? 0;
  if (!t && version && !version.startsWith('1.0')) {
    warnings.push('Lipsește "transform" — coordonatele sunt citite ca atare.');
  }

  const vn = rawVertices.length;
  const vx = new Float64Array(vn), vy = new Float64Array(vn), vz = new Float64Array(vn);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vn; i++) {
    const v = rawVertices[i] as number[];
    const x = v[0] * sx + tx, y = v[1] * sy + ty, z = v[2] * sz + tz;
    vx[i] = x; vy[i] = y; vz[i] = z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // ── Absolute coordinates get brought home ───────────────────────────────
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const absolute = Math.hypot(cx, cy) > ABSOLUTE_COORD_THRESHOLD_M;
  const shiftX = absolute ? cx : 0, shiftY = absolute ? cy : 0;
  if (absolute) {
    for (let i = 0; i < vn; i++) { vx[i] -= shiftX; vy[i] -= shiftY; }
    minX -= shiftX; maxX -= shiftX; minY -= shiftY; maxY -= shiftY;
  }

  const metadata = doc.metadata as { referenceSystem?: string } | undefined;
  const crs = typeof metadata?.referenceSystem === 'string' ? metadata.referenceSystem : null;
  if (absolute) {
    warnings.push(
      `Coordonate absolute${crs ? ` (${crs})` : ''} — modelul a fost recentrat pe punctul de inserție al proiectului.`,
    );
  }

  // ── Materials ────────────────────────────────────────────────────────────
  const appearance = doc.appearance as { materials?: RawMaterial[] } | undefined;
  const materials = Array.isArray(appearance?.materials) ? appearance.materials : [];

  // ── Objects ──────────────────────────────────────────────────────────────
  const cityObjects = (doc.CityObjects ?? {}) as Record<string, RawObject>;
  const objects: CityObjectMesh[] = [];
  let triangles = 0;
  let templates = 0;

  for (const [id, obj] of Object.entries(cityObjects)) {
    const geoms = Array.isArray(obj?.geometry) ? obj.geometry : [];
    if (geoms.length === 0) continue;

    // One LoD per object: the highest there is. Drawing every level at once
    // stacks a coarse box inside a detailed one and z-fights the whole way.
    const best = pickLod(geoms);
    if (!best) continue;
    if (best.type === 'GeometryInstance') { templates++; continue; }

    const surfaces = surfacesOf(best.boundaries);
    if (surfaces.length === 0) continue;

    const theme = best.material ? Object.keys(best.material)[0] ?? null : null;
    const sem = semanticsOf(best, surfaces.length);
    const mat = materialsOf(best, theme, surfaces.length);

    const pos: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    // The object's colour is whichever the most surfaces vote for — a single
    // Cesium instance carries one colour, and a per-surface split would make
    // an instance per triangle of a large city.
    const votes = new Map<string, number>();
    let transparency = 0;

    for (let s = 0; s < surfaces.length; s++) {
      const rings = surfaces[s].map((ring) =>
        ring.map((vi) => ({ x: vx[vi], y: vy[vi], z: vz[vi] } as P3)));
      if (rings.length === 0 || rings[0].length < 3) continue;

      const flat: P3[] = rings.flat();
      const tri = triangulateSurface(rings);
      if (tri.length === 0) continue;

      // Flat shading: a corner per triangle, so a roof edge stays an edge.
      for (let k = 0; k + 2 < tri.length; k += 3) {
        const a = flat[tri[k]], b = flat[tri[k + 1]], c = flat[tri[k + 2]];
        if (!a || !b || !c) continue;
        const [nx, ny, nz] = norm(
          (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y),
          (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z),
          (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x),
        );
        const base = pos.length / 3;
        for (const p of [a, b, c]) { pos.push(p.x, p.y, p.z); nor.push(nx, ny, nz); }
        idx.push(base, base + 1, base + 2);
        triangles++;
      }

      const mi = mat[s];
      const m = mi !== undefined ? materials[mi] : undefined;
      const c = hex(m?.diffuseColor)
        ?? (sem[s] ? SEMANTIC_COLORS[sem[s] as string] : undefined)
        ?? null;
      if (c) votes.set(c, (votes.get(c) ?? 0) + 1);
      if (typeof m?.transparency === 'number' && Number.isFinite(m.transparency)) {
        transparency = Math.max(transparency, m.transparency);
      }
    }

    if (idx.length === 0) continue;

    let color = TYPE_COLORS[String(obj.type ?? '')] ?? DEFAULT_COLOR;
    let bestVotes = 0;
    for (const [c, n] of votes) if (n > bestVotes) { bestVotes = n; color = c; }

    objects.push({
      id,
      type: String(obj.type ?? 'CityObject'),
      attributes: obj.attributes ?? {},
      parents: Array.isArray(obj.parents) ? obj.parents.map(String) : undefined,
      positions: new Float64Array(pos),
      normals: new Float32Array(nor),
      indices: new Uint32Array(idx),
      color,
      transparency,
      lod: best.lod === undefined ? undefined : String(best.lod),
    });
  }

  if (templates > 0) {
    warnings.push(`${templates} obiecte folosesc geometry-templates — neafișate.`);
  }
  if (objects.length === 0) {
    warnings.push('Niciun obiect cu suprafețe de desenat.');
  }

  return {
    version,
    objects,
    extent: { minX, minY, minZ, maxX, maxY, maxZ },
    recentred: absolute ? { x: shiftX, y: shiftY } : null,
    crs,
    counts: {
      objects: Object.keys(cityObjects).length,
      drawn: objects.length,
      triangles,
      vertices: vn,
    },
    warnings,
  };
}

/**
 * The geometry to draw for one object: the highest level of detail it has.
 *
 * LoD is a string from 1.1 on ("2.2"), a number before that, and sometimes
 * missing. Compared numerically when it can be, otherwise the last one wins,
 * which is the order files are written in.
 */
function pickLod(geoms: RawGeometry[]): RawGeometry | null {
  let best: RawGeometry | null = null;
  let bestLod = -Infinity;
  for (const g of geoms) {
    if (!g || g.boundaries === undefined) continue;
    const n = Number(g.lod);
    const lod = Number.isFinite(n) ? n : -1;
    if (best === null || lod >= bestLod) { best = g; bestLod = lod; }
  }
  return best;
}
