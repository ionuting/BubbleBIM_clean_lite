/**
 * Internal B-rep kernel — core types.
 *
 * ## Coordinate space and units
 *
 * The kernel works in **BIM world space**, identical to what BubbleGraph nodes
 * already store:
 *   X = East, Y = North, Z = Up (elevation), all in **millimetres**.
 *
 * This is deliberate: builders can read node properties straight through with no
 * unit or axis conversion (the historical source of sign/scale bugs), and the
 * space matches IFC's own Z-up convention for the eventual export path. The
 * Y-up / metres conversion the renderers need happens once, in `tessellate.ts`.
 *
 * ## Representation
 *
 * A `Solid` is a closed, orientable polyhedron with **planar** faces:
 *   - `vertices` — the shared point pool; faces reference it by index.
 *   - `Face.outer` — one boundary `Loop`, CCW when viewed from OUTSIDE the solid
 *     (i.e. counter-clockwise around `Face.normal`).
 *   - `Face.holes` — inner loops, wound CW when viewed from outside. Empty for
 *     everything the builders produce today; they exist because boolean cuts
 *     (a window punched through a wall face) produce them, and retrofitting the
 *     type later would touch every consumer.
 *
 * Curved geometry is **not** represented analytically — circular columns and arc
 * walls arrive here already tessellated into many-sided prisms, exactly as the
 * current pipeline does it.
 */

// ─── Vectors ──────────────────────────────────────────────────────────────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Plan-space point (BIM mm), as used for footprints. */
export interface Vec2 {
  x: number;
  y: number;
}

// ─── Topology ─────────────────────────────────────────────────────────────────

/** Index into `Solid.vertices`. */
export type VertexId = number;

/** An ordered, closed cycle of vertices. The closing edge (last → first) is implicit. */
export type Loop = VertexId[];

/**
 * One planar face of a solid.
 *
 * `normal` points OUT of the solid and is consistent with `outer`'s winding by
 * the right-hand rule. `makeSolid` computes it when omitted, so builders only
 * have to get the winding right.
 */
export interface Face {
  outer: Loop;
  /** Inner boundaries (holes), wound opposite to `outer`. Absent = no holes. */
  holes?: Loop[];
  /** Outward unit normal. */
  normal: Vec3;
  /**
   * Free-form provenance label, carried through untouched by the kernel.
   * Builders use it so downstream code can tell a wall's side face from its cap
   * (material assignment, IFC export, 2D projection). Conventions in use:
   * `'top' | 'bottom' | 'side' | 'start' | 'end'`.
   */
  tag?: string;
}

/**
 * A directed use of an edge by exactly one loop. In a valid closed solid every
 * half-edge has exactly one `twin` running the opposite way on the neighbouring
 * face — that pairing IS the manifold property, and checking it is how
 * `validateSolid` catches malformed geometry before it reaches a renderer or a
 * boolean engine.
 */
export interface HalfEdge {
  from: VertexId;
  to: VertexId;
  /** Index into `Solid.faces`. */
  face: number;
  /** 0 = the face's outer loop, 1+ = `holes[loop - 1]`. */
  loop: number;
  /** Index into `Topology.halfEdges` — next half-edge around the same loop. */
  next: number;
  /** Index into `Topology.halfEdges` of the opposite half-edge, or -1 if none. */
  twin: number;
}

/** Derived half-edge structure. Built on demand by `buildTopology`, never stored on the solid. */
export interface Topology {
  halfEdges: HalfEdge[];
  /** Undirected edge key (`"lo_hi"`) → indices of the half-edges using it. */
  byEdge: Map<string, number[]>;
}

/**
 * A closed polyhedron. Construct via `makeSolid` rather than by hand — it welds
 * coincident vertices, drops degenerate loops and fills in face normals, all of
 * which the topology and boolean stages assume.
 */
export interface Solid {
  vertices: Vec3[];
  faces: Face[];
  /** Free-form provenance label (element type, node id, layer…). */
  tag?: string;
}

// ─── Tolerances ───────────────────────────────────────────────────────────────
//
// All in BIM millimetres. Architectural models are authored to ~1 mm, so these
// sit a few orders of magnitude below anything a user can express, while staying
// far above float64 noise at building scale (~1e5 mm).

/** Points closer than this are treated as the same vertex. 1 micron. */
export const TOL_DIST = 1e-3;

/** Max allowed deviation of a loop vertex from its face plane. 10 microns. */
export const TOL_PLANAR = 1e-2;

/** Loops whose area falls below this are degenerate and get dropped. mm². */
export const TOL_AREA = 1e-6;

// ─── Diagnostics ──────────────────────────────────────────────────────────────

export type BrepDiagSeverity = 'error' | 'warning';

/**
 * A structural problem found in a solid. Mirrors `RoofDiagnostic` so the two
 * subsystems report into the same UI surfaces.
 */
export interface BrepDiagnostic {
  code:
    | 'not_closed'          // an edge is used by fewer than 2 half-edges
    | 'non_manifold_edge'   // an edge is used by more than 2 half-edges
    | 'inconsistent_winding'// two faces traverse a shared edge the same way
    | 'degenerate_face'     // face collapsed to a line/point
    | 'non_planar_face'     // loop vertices do not lie in one plane
    | 'inverted'            // signed volume is negative — normals point inward
    | 'empty';              // no faces at all
  severity: BrepDiagSeverity;
  message: string;
  /** Index into `Solid.faces`, when the problem is local to one face. */
  face?: number;
}
