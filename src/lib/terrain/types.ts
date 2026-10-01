/**
 * Terrain — the data, as it lives in the project.
 *
 * ## Why this file exists
 *
 * The terrain modeller kept its state in a component: a `useState` that
 * vanished with the tab, a manual JSON export that did not even include the
 * hand-edited vertex heights, and a coordinate frame with no relation to the
 * building. The graph, the three 3D viewers, the globe, the sections, the
 * quantities — none of them knew a terrain existed.
 *
 * So the model moves here and becomes project data, saved with the graph the
 * way `worldLocation` is. The Terrain tab EDITS it; it no longer owns it.
 *
 * ## The frame
 *
 * The terrain's own coordinates are unchanged: metres, X east, Z north, the
 * grid centred on its origin and `sizeM` across. What ties it to the building
 * is a `site` node in the graph (`site.ts`), which says where that origin
 * stands in BIM millimetres and which BIM elevation the ground meets.
 */

export type GroundMaterial = 'grass' | 'dirt' | 'gravel' | 'sand';
export type PlantType = 'tree' | 'bush' | 'grass';

/**
 * Which way a zone may move the ground. `cut` (the default, and what every
 * zone did before this existed) only lowers; `fill` only raises; `both` makes
 * the ground the zone's level whichever side it started on — what a platform
 * on sloping ground needs.
 */
export type ZoneMode = 'cut' | 'fill' | 'both';

export interface ExcavationZone {
  id: string;
  /** [x, z] in terrain metres. */
  polygon: [number, number][];
  /** Cut (or raise) relative to the ground at the polygon's vertices, metres. */
  depth: number;
  /** Rim slope in degrees; 0 is a vertical cut. */
  slope: number;
  type: 'trench' | 'pit' | 'embankment';
  /**
   * An ABSOLUTE floor, terrain metres. When set, `depth` is not used: the
   * floor is where it says, whatever the ground around it does. This is what
   * a foundation pit needs — its bottom is a design elevation, not "so much
   * below wherever the ground happens to be".
   */
  floorM?: number;
  /** Defaults to 'cut', which is what every zone did before. */
  mode?: ZoneMode;
}

export interface RockInstance { id: string; x: number; z: number; scale: number; rotY: number }
export interface PlantInstance { id: string; x: number; z: number; type: PlantType; scale: number }
export interface PlacedObject {
  id: string;
  /** Nature-library key (e.g. 'BirchTree_1.gltf') or '__import_<uuid>__' for a custom GLB. */
  gltfFile: string;
  label?: string;
  x: number; z: number;
  rotY: number;
  scale: number;
}

export interface TerrainModel {
  /** Grid extent, metres, centred on the terrain origin. */
  sizeM: number;
  subdivisions: number;
  /** Amplitude of the procedural relief, metres. Unused when `flat`. */
  maxHeightM: number;
  seed: number;
  /**
   * Level ground at height zero. The default: a site starts as a plane and
   * takes relief only when someone asks for it, so a new project's ground
   * is not a random hillside.
   */
  flat: boolean;
  excavations: ExcavationZone[];
  rocks: RockInstance[];
  plants: PlantInstance[];
  objects: PlacedObject[];
  groundMaterial?: GroundMaterial;
  /**
   * The grid after hand editing, metres, row-major, (subdivisions+1)² long.
   * When present it IS the ground — relief and the zones above already
   * folded in — so the modeller's zones are not re-applied on top of it.
   * Graph-driven cuts (foundation pits) still are: they have absolute floors,
   * and cutting to an absolute floor twice is the same as cutting once.
   */
  bakedHeights?: number[];
}

export const DEFAULT_TERRAIN_MODEL: TerrainModel = {
  sizeM: 100,
  subdivisions: 128,
  maxHeightM: 6,
  seed: 42,
  flat: true,
  excavations: [],
  rocks: [],
  plants: [],
  objects: [],
  groundMaterial: 'grass',
};

/** Fill in anything a saved project from before a field existed left out. */
export function normaliseTerrainModel(raw: Partial<TerrainModel> | null | undefined): TerrainModel {
  const d = DEFAULT_TERRAIN_MODEL;
  if (!raw) return { ...d };
  return {
    sizeM: Number(raw.sizeM) > 0 ? Number(raw.sizeM) : d.sizeM,
    subdivisions: Number(raw.subdivisions) >= 4 ? Math.round(Number(raw.subdivisions)) : d.subdivisions,
    maxHeightM: Number.isFinite(Number(raw.maxHeightM)) ? Number(raw.maxHeightM) : d.maxHeightM,
    seed: Number.isFinite(Number(raw.seed)) ? Number(raw.seed) : d.seed,
    // A model saved before `flat` existed was procedural; keep it that way.
    flat: typeof raw.flat === 'boolean' ? raw.flat : false,
    excavations: Array.isArray(raw.excavations) ? raw.excavations : [],
    rocks: Array.isArray(raw.rocks) ? raw.rocks : [],
    plants: Array.isArray(raw.plants) ? raw.plants : [],
    objects: Array.isArray(raw.objects) ? raw.objects : [],
    groundMaterial: raw.groundMaterial ?? d.groundMaterial,
    ...(Array.isArray(raw.bakedHeights) && raw.bakedHeights.length > 0
      ? { bakedHeights: raw.bakedHeights }
      : {}),
  };
}
