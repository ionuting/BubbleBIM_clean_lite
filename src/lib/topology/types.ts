/**
 * The room topology the backend's /api/topology routes return — the rooms as
 * a CellComplex read by topologicpy on PythonOCC. See backend/topology_engine.py,
 * which is the source of every field here.
 */

export interface TopologyStatus {
  available: boolean;
  installed?: { topologicpy: boolean; pythonocc: boolean };
  backend?: string;
  topologicpy?: string;
  pythonocc?: string;
  /** Present when the exact-solid check can run. */
  ifcopenshell?: string | null;
  error?: string;
}

/** What two rooms share: a wall, a slab, or both. */
export type AdjacencyKind = 'wall' | 'slab' | 'mixed';

export interface TopologyGraphNode {
  /** The room node's id in the graph. */
  id: string;
  name: string;
  storeyId: string | null;
  degree: number;
  /** Footprint middle at mid-height, BIM mm. */
  positionMm: [number, number, number];
}

export interface TopologyGraphEdge {
  source: string;
  target: string;
  kind: AdjacencyKind;
  sharedAreaM2: number;
  wallAreaM2: number;
  slabAreaM2: number;
  faces: number;
}

export interface TopologySharedFace {
  rooms: [string, string];
  kind: 'wall' | 'slab';
  areaM2: number;
  centroidMm: [number, number, number];
  normal: [number, number, number];
}

/**
 * What a face of the complex is: shared between two rooms (a wall or a slab),
 * or on the envelope of one (an exterior wall, a roof, a ground floor).
 * `internal` is a face between two cells of the same room.
 */
export type TopologyFaceKind = 'wall' | 'slab' | 'exterior' | 'roof' | 'ground' | 'internal' | 'orphan';

/** One face of the CellComplex, as the kernel built it — drawable. */
export interface TopologyFace {
  kind: TopologyFaceKind;
  /** The rooms whose cells it bounds: two for a shared face, one on the envelope. */
  rooms: string[];
  areaM2: number;
  normal: [number, number, number];
  /** Ordered outline, BIM mm (x east, y north, z up). */
  outerMm: [number, number, number][];
  holesMm?: [number, number, number][][];
  /** The wall node the face lies on — sent with `extras` only. */
  elements?: string[];
  /** Doors and windows in the face — sent with `extras` only. */
  openings?: string[];
  /** Exterior faces: the normal turned away from the room, and its compass octant. */
  outward?: [number, number, number];
  orientation?: Orientation;
}

export type Orientation = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SV' | 'V' | 'NV';

// ── What the app sends beyond the rooms (lib/topology/extras.ts) ─────────────

export interface TopologyWall {
  id: string;
  aMm: [number, number];
  bMm: [number, number];
  thicknessMm: number;
  zMinMm: number;
  zMaxMm: number;
}

export interface TopologyOpening {
  id: string;
  kind: 'door' | 'window';
  name: string;
  wallId: string;
  centreMm: [number, number];
  widthMm: number;
  zMinMm: number;
  zMaxMm: number;
  thicknessMm: number;
}

export interface TopologyStair {
  id: string;
  name: string;
  bottomMm: [number, number, number];
  topMm: [number, number, number];
  lengthMm: number;
}

export interface TopologyExtras {
  walls: TopologyWall[];
  openings: TopologyOpening[];
  stairs: TopologyStair[];
  /** Egress distance above which a room is flagged, metres. */
  maxEgressM: number;
}

// ── Circulation and envelope (backend/topology_circulation.py) ───────────────

export interface CirculationRoom {
  id: string;
  name: string;
  storeyId: string | null;
  doors: number;
  /** Has at least one door or stair. */
  accessible: boolean;
  /** Farthest corner → nearest exit, door to door, metres. Null: no way out. */
  egressM: number | null;
  exitId: string | null;
  doorsOnPath: number;
  roomsOnPath: string[];
  /** The walk, BIM mm: farthest corner, then each door or stair end. */
  pathMm: [number, number, number][];
  exceedsLimit: boolean;
}

export interface TopologyCirculation {
  maxDistanceM: number;
  doors: { id: string; name: string; rooms: string[]; exterior: boolean; positionMm: [number, number, number] }[];
  exits: string[];
  stairs: { id: string; name: string; fromRoom: string; toRoom: string; lengthM: number }[];
  unplacedDoors: string[];
  rooms: CirculationRoom[];
}

export interface TopologyEnvelope {
  orientations: { dir: Orientation; wallM2: number; windowM2: number; doorM2: number; wwr: number }[];
  wallM2: number;
  windowM2: number;
  doorM2: number;
  /** Window over exterior wall area. */
  wwr: number | null;
  roofM2: number;
  groundM2: number;
  rooms: { id: string; windowM2: number; exteriorWallM2: number; windowToFloor: number | null }[];
}

// ── Exact solids (backend/topology_solids.py) ────────────────────────────────

export interface SolidElement {
  guid: string;
  type: string;
  /** The node id the app wrote into IfcElement.Tag (`id` or `id:part`). */
  tag: string | null;
  name: string | null;
  volumeM3: number;
  surfaceM2: number;
}

export interface SolidsResult {
  elements: SolidElement[];
  overlaps: { a: string; b: string; volumeM3: number }[];
  overlapsByType: { types: string; count: number; volumeM3: number }[];
  failed: { guid: string; type: string; reason: string }[];
  stats: {
    elements: number;
    volumeM3: number;
    overlapVolumeM3: number;
    pairsTested: number;
    truncated: boolean;
    tookMs: number;
  };
}

export interface TopologyRoom {
  id: string;
  name: string;
  storeyId: string | null;
  floorAreaM2: number;
  perimeterM: number;
  bottomMm: number;
  topMm: number;
  heightMm: number;
  volumeM3: number;
  sharedWallAreaM2: number;
  sharedSlabAreaM2: number;
  exteriorWallAreaM2: number;
  exposedTopAreaM2: number;
  exposedBottomAreaM2: number;
  neighbours: number;
}

export interface TopologyStats {
  rooms: number;
  cells: number;
  adjacencies: number;
  wallAdjacencies: number;
  slabAdjacencies: number;
  components: number;
  isolatedRooms: string[];
  totalFloorAreaM2: number;
  totalVolumeM3: number;
  envelopeAreaM2: number;
  sharedAreaM2: number;
  /** Envelope over volume, 1/m — lower is more compact. Null with no volume. */
  compactnessPerM: number | null;
  meanDegree: number;
  tookMs?: number;
}

export interface TopologyResult {
  graph: { nodes: TopologyGraphNode[]; edges: TopologyGraphEdge[] };
  sharedFaces: TopologySharedFace[];
  /** Every face of the complex once — absent from a backend older than the 3D view. */
  faces?: TopologyFace[];
  /** With extras: doors, exits, stairs and every room's way out. */
  circulation?: TopologyCirculation;
  /** With extras: the envelope by orientation. */
  envelope?: TopologyEnvelope;
  rooms: TopologyRoom[];
  stats: TopologyStats;
  skippedRooms: { id: string; name: string; reason: string }[];
  warnings: string[];
}

export interface TopologyRequest {
  nodes: unknown[];
  edges: unknown[];
  /** Only these storeys' rooms; all when absent. */
  storeyIds?: string[];
  extras?: TopologyExtras;
}
