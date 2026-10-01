/**
 * Terrain — public surface.
 *
 * `computeSite` is the one entry point the viewers, the sections, the
 * quantities and the Inspector share: the same ground, placed the same way,
 * read through the same `heightAtBim`. The Terrain tab edits the model this
 * builds from; it does not draw its own copy.
 */
export * from './types';
export {
  applyZones, baseHeights, distToZoneEdge, earthworks, fbm, gridCount, gridToWorld,
  insideGrid, modelHeights, pointInZone, sampleHeight, worldToGrid, type GridSpec,
} from './heightGrid';
export {
  DEFAULT_SITE_INTENT, bimToTerrain, bimZToTerrain, computeSite, findSiteNode, parseSiteIntent,
  siteVerticesBim, terrainToBim, terrainZToBim,
  type SiteFrame, type SiteIntent, type SiteResult,
} from './site';
export { terrainBufferGeometry } from './mesh';
export {
  RECT_EDGE_FRACTION, brushReachM, brushWeight,
  type BrushFootprint, type BrushShape,
} from './brush';
export {
  DEFAULT_PAD_INTENT, collectPadZones, padOutline, parsePadIntent, slopeRatio,
  type PadInfo, type PadIntent, type PadLevelMode, type PadTransition,
} from './pad';
