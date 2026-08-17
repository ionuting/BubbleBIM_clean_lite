/**
 * Internal B-rep kernel — public surface.
 *
 * A boundary representation built directly on BubbleGraph's topology: solids are
 * planar-faced polyhedra with half-edge connectivity, so "these two walls meet at
 * this ax" is expressible as geometry rather than re-derived numerically at every
 * render.
 *
 * Layering:
 *   types / vec / triangulate / solid / prism / measure   — pure kernel, no deps
 *   mesh                                                  — triangle-mesh round trip
 *   boolean                                               — engine-agnostic ops
 *   engines/*                                             — the one place a boolean library is imported
 *   tessellate                                            — renderer-space buffers
 *   three                                                 — THREE.js adapter
 *   builders                                              — BubbleGraph → Solid
 *
 * The THREE adapter is intentionally NOT re-exported — import `./three` directly
 * so non-rendering consumers (tests, takeoff, export) stay free of THREE.
 * Likewise `engines/*` is never re-exported: reach booleans through `boolean.ts`.
 */

export type {
  BrepDiagnostic, BrepDiagSeverity,
  Face, HalfEdge, Loop, Solid, Topology,
  Vec2, Vec3, VertexId,
} from './types';
export { TOL_AREA, TOL_DIST, TOL_PLANAR } from './types';

export {
  add, cross, dist, dist2, dot, ensureCCW2, len, newellNormal, normalize,
  planeBasis, project2, scale, signedArea2, sub, v3,
} from './vec';

export { triangulateFace, type Tri } from './triangulate';

export {
  buildTopology, flipSolid, isManifold, makeSolid, transformSolid, translateSolid, validateSolid,
  type FaceInput,
} from './solid';

export { boxSolid, cylinderSolid, extrudeFootprint, extrudePolygon3, sweepBox } from './prism';

export {
  bounds, centroid, faceArea, facePlanarity, signedVolume, solidTriangles,
  surfaceArea, surfaceAreaM2, volume, volumeM3,
  type Bounds,
} from './measure';

export {
  faceTagCounts, solidFromMesh, toIndexedMesh,
  type IndexedMesh, type RebuildOptions,
} from './mesh';

export {
  ensureBooleanEngine, getBooleanEngine, intersectSolids, resetBooleanEngine,
  setBooleanEngine, subtractSolids, unionSolids,
  type BooleanEngine, type BooleanOp, type BooleanOptions, type BooleanOutcome,
} from './boolean';

export { MM, tessellate, type TessellateOptions, type TessellateSpace, type TriangleSoup } from './tessellate';

export {
  applyLocalTransform, columnSolid, roomSlabSolid, roomVolumeSolid, slabSolid,
  wallBeamSolid, wallSolid,
  type BuildOptions, type WallBuildOptions,
} from './builders';

export {
  cutWallOpenings, openingCutter, wallOpeningCutters,
  type CutOpeningsOptions, type OpeningCutter,
} from './openings';

export {
  buildWallSolids, compareWallPriority, findWallJunctions, resolveWallJunctions, wallPriority,
  type BuildWallsOptions, type JunctionDiagCode, type JunctionDiagnostic, type ResolveOptions,
  type ResolveResult, type WallBody, type WallExtensions, type WallJunction, type WallPriority,
} from './junctions';
