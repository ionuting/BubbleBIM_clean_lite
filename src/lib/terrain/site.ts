/**
 * site.ts — where the ground stands in the building's coordinates.
 *
 * ## The gesture
 *
 * A `site` node wired to ONE axis: that axis is the terrain grid's origin.
 * The same one-anchor rule a circular dome uses, and for the same reason —
 * the thing has a centre and a size, and a single point places it.
 *
 * ## The datum
 *
 * The ground at the anchor IS the building's reference level: the bottom of
 * the storey the site belongs to, plus an offset. So a project starts with
 * the ground meeting the ground floor at the anchor, which is what "±0.00"
 * means on a drawing, and the terrain's own zero (an arbitrary metre) never
 * has to be reconciled with anything by hand.
 *
 * ## Foundations, on request
 *
 * With `excavate_foundations` on, every footing in the graph digs its own
 * pit: the footprint plus a working space each side, down to the footing's
 * underside plus a bedding. These are zones with ABSOLUTE floors, so they
 * are safe to apply over hand-edited ground. Off by default — a pit is a
 * decision about the site, not a consequence of drawing a footing.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { planPos, type Pt2 } from '@/lib/geom/plan2d';
import { getOrderedAnchorNodes, getStoreyBand } from '@/lib/bimGeometry';
import { FOUNDATION_TYPE_MAP } from '@/lib/elementLibrary';
import type { SweepDiagnostic } from '@/lib/sweep/types';
import {
  applyZones, baseHeights, earthworks, gridCount, gridToWorld, insideGrid, modelHeights, sampleHeight,
} from './heightGrid';
import { normaliseTerrainModel, type ExcavationZone, type TerrainModel } from './types';
import { bimToTerrain, bimZToTerrain, terrainToBim, terrainZToBim, type SiteFrame } from './frame';
import { collectPadZones, padOutline, type PadInfo } from './pad';

export interface SiteIntent {
  rotationDeg: number;
  offsetZMm: number;
  excavateFoundations: boolean;
  workingSpaceMm: number;
  beddingMm: number;
  pitSlopeDeg: number;
  showIn3d: boolean;
}

export const DEFAULT_SITE_INTENT: SiteIntent = {
  rotationDeg: 0,
  offsetZMm: 0,
  excavateFoundations: false,
  workingSpaceMm: 500,
  beddingMm: 100,
  pitSlopeDeg: 45,
  showIn3d: true,
};

const num = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const truthy = (v: unknown) => v === true || String(v ?? '').toLowerCase() === 'true';

export function parseSiteIntent(node: BubbleGraphNode): SiteIntent {
  const p = node.properties ?? {};
  const D = DEFAULT_SITE_INTENT;
  return {
    rotationDeg: num(p.rotation_deg, D.rotationDeg),
    offsetZMm: num(p.offset_z_mm, D.offsetZMm),
    excavateFoundations: truthy(p.excavate_foundations),
    workingSpaceMm: Math.max(0, num(p.working_space_mm, D.workingSpaceMm)),
    beddingMm: Math.max(0, num(p.bedding_mm, D.beddingMm)),
    pitSlopeDeg: Math.max(0, Math.min(89, num(p.pit_slope_deg, D.pitSlopeDeg))),
    showIn3d: p.show_in_3d === undefined ? D.showIn3d : truthy(p.show_in_3d),
  };
}

// The frame lives in its own module so `pad.ts` can use it without importing
// this one, which imports `pad.ts`. Re-exported here so nothing else changed.
export {
  bimToTerrain, bimZToTerrain, terrainToBim, terrainZToBim, type SiteFrame,
} from './frame';

export interface SiteResult {
  model: TerrainModel;
  intent: SiteIntent;
  /** Null when the site is not anchored — nothing can be placed then. */
  frame: SiteFrame | null;
  /** The ground as the model describes it (baked, or base + zones). */
  groundHeights: Float32Array;
  /** The ground after the graph's cuts on top. What is drawn. */
  heights: Float32Array;
  foundationPits: ExcavationZone[];
  /** The graph's platforms, resolved — for the plan and the Inspector. */
  pads: PadInfo[];
  /** Earthworks of the modeller's zones against the natural ground. */
  zoneCutM3: number;
  zoneFillM3: number;
  /** Earthworks of the graph's pads against the modelled ground. */
  padCutM3: number;
  padFillM3: number;
  /** Earthworks of the foundation pits against the padded ground. */
  foundationCutM3: number;
  /** Ground height in BIM mm at a BIM plan point; null outside the grid. */
  heightAtBim: (xMm: number, yMm: number) => number | null;
  /** BIM extents of the grid, mm. */
  boundsMm: { minX: number; minY: number; maxX: number; maxY: number } | null;
  zMinMm: number;
  zMaxMm: number;
  diagnostics: SweepDiagnostic[];
}

// ─── Memo ────────────────────────────────────────────────────────────────────
//
// Keyed on the model OBJECT (the store hands out a new one on every change)
// and on a string of everything else that matters. The heights arrays are
// never serialised into a key.

const memo = new WeakMap<TerrainModel, Map<string, SiteResult>>();
const MEMO_PER_MODEL = 8;

function foundationSignature(nodeMap: Map<string, BubbleGraphNode>): string {
  const rows: unknown[] = [];
  for (const n of nodeMap.values()) {
    if (n.type !== 'foundation') continue;
    const band = getStoreyBand(n, nodeMap);
    rows.push([n.id, planPos(n, nodeMap), n.properties.foundation_type, band.bot]);
  }
  rows.sort((a, b) => String((a as unknown[])[0]) < String((b as unknown[])[0]) ? -1 : 1);
  return JSON.stringify(rows);
}

/**
 * Everything about the graph's pads that changes the ground.
 *
 * The outline is in here, not just the node's own properties: a pad takes its
 * shape from a SKETCH, so dragging that rectangle's corner must invalidate
 * the site even though the pad node itself did not change.
 */
function padSignature(
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): string {
  const rows: unknown[] = [];
  for (const n of nodeMap.values()) {
    if (n.type !== 'terrain_pad') continue;
    rows.push([n.id, n.properties, padOutline(n, nodeMap, edges).outline, getStoreyBand(n, nodeMap).bot]);
  }
  if (rows.length === 0) return '';
  rows.sort((a, b) => (String((a as unknown[])[0]) < String((b as unknown[])[0]) ? -1 : 1));
  return JSON.stringify(rows);
}

// ─── Compute ─────────────────────────────────────────────────────────────────

export function computeSite(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  modelIn: TerrainModel | null | undefined,
): SiteResult {
  const model = modelIn ?? normaliseTerrainModel(null);
  const intent = parseSiteIntent(node);
  const anchors = getOrderedAnchorNodes(node.id, edges, nodeMap);
  const anchor = anchors[0] ? planPos(anchors[0], nodeMap) : null;
  const band = getStoreyBand(node, nodeMap);
  const datumMm = band.bot + intent.offsetZMm;

  const key = JSON.stringify([
    node.id, node.properties, anchor, anchors.length, datumMm,
    intent.excavateFoundations ? foundationSignature(nodeMap) : '',
    padSignature(nodeMap, edges),
  ]);
  let perModel = memo.get(model);
  if (!perModel) { perModel = new Map(); memo.set(model, perModel); }
  const hit = perModel.get(key);
  if (hit) return hit;

  const diagnostics: SweepDiagnostic[] = [];
  const groundHeights = modelHeights(model);
  const natural = baseHeights(model);
  const zoneWorks = earthworks(natural, groundHeights, model);

  const result: SiteResult = {
    model, intent, frame: null,
    groundHeights, heights: groundHeights,
    foundationPits: [],
    pads: [],
    zoneCutM3: zoneWorks.cutM3, zoneFillM3: zoneWorks.fillM3,
    padCutM3: 0, padFillM3: 0, foundationCutM3: 0,
    heightAtBim: () => null,
    boundsMm: null,
    zMinMm: datumMm, zMaxMm: datumMm,
    diagnostics,
  };

  if (!anchor) {
    diagnostics.push({
      code: 'SITE_NO_ANCHOR',
      severity: 'error',
      message: 'Terenul nu e legat de niciun ax — leagă nodul de axul unde vrei centrul grilei de teren.',
    });
    return remember(perModel, key, result);
  }
  if (anchors.length > 1) {
    diagnostics.push({
      code: 'SITE_EXTRA_ANCHORS',
      severity: 'info',
      message: `Terenul folosește doar primul ax legat drept centru; celelalte ${anchors.length - 1} sunt ignorate.`,
    });
  }
  const parent = node.parentId ? nodeMap.get(node.parentId) : undefined;
  if (!parent || parent.type !== 'storey') {
    diagnostics.push({
      code: 'SITE_NO_STOREY',
      severity: 'warning',
      message: 'Terenul nu aparține unui etaj — cota de referință cade pe banda implicită 0–3000 mm.',
    });
  }

  // The datum pins the ground at the anchor BEFORE the modeller's zones: a
  // pit dug at the anchor must not hoist the whole site up by its depth.
  // Hand-edited ground has no "before", so it is taken as the natural ground.
  const rotRad = (intent.rotationDeg * Math.PI) / 180;
  const count = gridCount(model);
  const reference = model.bakedHeights?.length === count * count ? groundHeights : natural;
  const h0M = sampleHeight(reference, model, 0, 0);
  const frame: SiteFrame = { originX: anchor.x, originY: anchor.y, rotRad, datumMm, h0M };
  result.frame = frame;

  // ── Graph pads: platforms and terraces, applied before anything digs ─────
  let heights = groundHeights;
  {
    const collected = collectPadZones(nodeMap, edges, frame, model);
    result.pads = collected.pads;
    for (const d of collected.diagnostics) diagnostics.push(d);
    if (collected.zones.length > 0) {
      const after = applyZones(heights, model, collected.zones);
      const e = earthworks(heights, after, model);
      result.padCutM3 = e.cutM3;
      result.padFillM3 = e.fillM3;
      heights = after;
    }
  }

  // ── Foundation pits ──────────────────────────────────────────────────────
  if (intent.excavateFoundations) {
    const pits: ExcavationZone[] = [];
    for (const f of nodeMap.values()) {
      if (f.type !== 'foundation') continue;
      const type = FOUNDATION_TYPE_MAP.get(String(f.properties.foundation_type ?? ''));
      const wMm = type?.width_mm ?? 600, dMm = type?.depth_mm ?? 600, hMm = type?.height_mm ?? 400;
      const c = planPos(f, nodeMap);
      const fb = getStoreyBand(f, nodeMap);
      // The footing's underside: the 3D viewer stands the block on the
      // storey's base, so the underside is that minus the block's height.
      const undersideMm = fb.bot - hMm;
      const floorMm = undersideMm - intent.beddingMm;
      const hw = wMm / 2 + intent.workingSpaceMm, hd = dMm / 2 + intent.workingSpaceMm;
      const corners: Pt2[] = [
        { x: c.x - hw, y: c.y - hd }, { x: c.x + hw, y: c.y - hd },
        { x: c.x + hw, y: c.y + hd }, { x: c.x - hw, y: c.y + hd },
      ];
      const polygon = corners.map((p): [number, number] => {
        const t = bimToTerrain(frame, p.x, p.y);
        return [t.x, t.z];
      });
      if (!polygon.some(([x, z]) => insideGrid(model, x, z))) continue;
      pits.push({
        id: `pit:${f.id}`, polygon, depth: 0, slope: intent.pitSlopeDeg, type: 'pit',
        floorM: bimZToTerrain(frame, floorMm),
      });
    }
    result.foundationPits = pits;
    if (pits.length > 0) {
      const after = applyZones(heights, model, pits);
      result.foundationCutM3 = earthworks(heights, after, model).cutM3;
      heights = after;
    } else {
      diagnostics.push({
        code: 'SITE_NO_FOUNDATIONS',
        severity: 'info',
        message: 'Săpătura pentru fundații e pornită, dar nicio fundație nu cade pe grila de teren.',
      });
    }
  }
  result.heights = heights;

  // ── Read-back and extents ────────────────────────────────────────────────
  result.heightAtBim = (xMm, yMm) => {
    const t = bimToTerrain(frame, xMm, yMm);
    if (!insideGrid(model, t.x, t.z)) return null;
    return terrainZToBim(frame, sampleHeight(heights, model, t.x, t.z));
  };
  const half = model.sizeM / 2;
  const cornersBim = [[-half, -half], [half, -half], [half, half], [-half, half]]
    .map(([x, z]) => terrainToBim(frame, x, z));
  result.boundsMm = {
    minX: Math.min(...cornersBim.map((p) => p.x)), maxX: Math.max(...cornersBim.map((p) => p.x)),
    minY: Math.min(...cornersBim.map((p) => p.y)), maxY: Math.max(...cornersBim.map((p) => p.y)),
  };
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const z = terrainZToBim(frame, heights[i]);
    if (z < zMin) zMin = z; if (z > zMax) zMax = z;
  }
  result.zMinMm = zMin; result.zMaxMm = zMax;

  return remember(perModel, key, result);
}

function remember(perModel: Map<string, SiteResult>, key: string, r: SiteResult): SiteResult {
  if (perModel.size >= MEMO_PER_MODEL) {
    const first = perModel.keys().next().value;
    if (first !== undefined) perModel.delete(first);
  }
  perModel.set(key, r);
  return r;
}

/** The site node of a graph, if any. One per project is the intent. */
export function findSiteNode(nodes: Iterable<BubbleGraphNode>): BubbleGraphNode | null {
  for (const n of nodes) if (n.type === 'site') return n;
  return null;
}

/**
 * The BIM-space vertex grid of a computed site: positions in mm, row-major,
 * with the grid's own row/column count. Shared by the mesh and the section
 * profile so both read the same surface.
 */
export function siteVerticesBim(site: SiteResult): { count: number; xyz: Float64Array } | null {
  if (!site.frame) return null;
  const count = gridCount(site.model);
  const xyz = new Float64Array(count * count * 3);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      const { x, z } = gridToWorld(site.model, col, row);
      const p = terrainToBim(site.frame, x, z);
      const i = (row * count + col) * 3;
      xyz[i] = p.x; xyz[i + 1] = p.y; xyz[i + 2] = terrainZToBim(site.frame, site.heights[row * count + col]);
    }
  }
  return { count, xyz };
}
