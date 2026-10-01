/**
 * Dome element — public surface.
 *
 * `computeDome` is the one pure entry point: the 3D viewers, the plan, the
 * quantity takeoff, the IFC exporter and the Inspector all read the same
 * result, so what is drawn is what is measured. It never throws — failure is
 * a diagnostic. The membrane solve costs tens of milliseconds, so results are
 * memoised on what they depend on: the node's properties and the anchors'
 * positions. A viewer rebuilding after an unrelated edit pays nothing.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { ensureCcw, isSimplePolygon, planPos, pointInPolygon, polygonArea, type Pt2 } from '@/lib/geom/plan2d';
import { getOrderedAnchorNodes, getStoreyBand } from '@/lib/bimGeometry';
import { applyProfilePlacement } from '@/lib/sweep/profiles';
import { resolveSweepProfile, type SweepProfileResolver } from '@/lib/sweep/profileLibrary';
import { placedRectangle } from '@/lib/sweep/rings';
import type { SweepIntent } from '@/lib/sweep/types';
import { filletPolygon } from './fillet';
import { cellEdges, clipByLine, lloydStep, rng, seedPoints, voronoiCells } from './voronoi';
import {
  membraneFor, ownedRegion, ownsSeamAgainst, shellHeight, shellsIntersect, type DomeShell,
} from './cluster';
import { entranceFits, entranceGeometry, type EntranceGeometry } from './entrance';
import { liftEdge, memberSolids } from './frame';
import { panelFromCell } from './panels';
import {
  DEFAULT_DOME_INTENT,
  type DomeIntent, type DomeMember, type DomeResult, type SweepDiagnostic,
} from './types';

export * from './types';
export { buildMembrane, bulgeExponent, type Membrane } from './membrane';
export { delaunay, type Tri } from './delaunay';
export { cellEdges, clipByLine, lloydStep, rng, seedPoints, voronoiCells } from './voronoi';
export { insetRing, panelFromCell } from './panels';
export { filletPolygon } from './fillet';
export { contourRegion, simplifyRing, splitRings } from './contour';
export {
  membraneFor, onSeam, ownedRegion, shellHeight, shellsIntersect, signedDistanceToPolygon,
  winMargin, type DomeShell,
} from './cluster';
export {
  entranceFits, entranceGeometry, polygonCentroid, stadiumPolygon, type EntranceGeometry,
} from './entrance';
export { liftEdge, memberSolids } from './frame';
export { domePanelGeometry } from './mesh';
export { domeMemberPieces, domePanelPieces, type DomeIfcPiece } from './ifc';

const num = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Read a dome node's properties into an intent. */
export function parseDomeIntent(node: BubbleGraphNode): DomeIntent {
  const p = node.properties ?? {};
  const params: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith('p_')) {
      const n = Number(v);
      if (Number.isFinite(n)) params[k] = n;
    }
  }
  const D = DEFAULT_DOME_INTENT;
  const anchorY = p.anchor_y === 'min' || p.anchor_y === 'mid' || p.anchor_y === 'max' ? p.anchor_y : D.anchorY;
  return {
    baseRadiusMm: Math.max(0, num(p.base_radius_mm, D.baseRadiusMm)),
    baseFilletMm: Math.max(0, num(p.base_fillet_mm, D.baseFilletMm)),
    heightMm: num(p.dome_height_mm, D.heightMm),
    bulge: num(p.dome_bulge, D.bulge),
    level: p.level === 'bottom' ? 'bottom' : 'top',
    offsetZMm: num(p.offset_z_mm, 0),
    resolution: num(p.resolution, D.resolution),
    cellCount: num(p.cell_count, D.cellCount),
    seed: num(p.cell_seed, D.seed),
    relaxIterations: num(p.relax_iterations, D.relaxIterations),
    profileId: String(p.profile ?? D.profileId),
    params,
    anchorY,
    glassThicknessMm: num(p.glass_thickness_mm, D.glassThicknessMm),
    planarityTolMm: num(p.planarity_tol_mm, D.planarityTolMm),
    material: String(p.material ?? D.material),
    glassMaterial: String(p.glass_material ?? D.glassMaterial),
  };
}

/**
 * A circle as a polygon, CCW, fine enough that the facets do not show.
 *
 * The floor is a COUNT rather than a chord length, because what the eye
 * judges is the facet relative to the radius, and that ratio depends only on
 * the count: 64 segments put the chord's sagitta at 0.12% of the radius for a
 * dome of any size. Large radii get more, so the absolute facet stays within
 * the membrane's own grid spacing; the ceiling stops a huge dome from
 * spending thousands of boundary points on a curve the mesh cannot resolve.
 */
export function circlePolygon(cx: number, cy: number, radiusMm: number): Pt2[] {
  const segments = Math.max(64, Math.min(160, Math.round(radiusMm / 150)));
  return Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return { x: cx + radiusMm * Math.cos(a), y: cy + radiusMm * Math.sin(a) };
  });
}

/**
 * The base the graph gives.
 *
 * ONE anchor plus a radius is a circle centred on that axis; three or more
 * are the contour itself, in edge order. The count of connections is the
 * choice, exactly as it is for a sweep — so a plain hemisphere costs one axis
 * and one number instead of a dozen axes placed on a circle by hand.
 */
export function domeBase(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  radiusMm = parseDomeIntent(node).baseRadiusMm,
  filletMm = parseDomeIntent(node).baseFilletMm,
): { base: Pt2[] | null; baseKind: DomeResult['baseKind']; anchorCount: number } {
  const anchors = getOrderedAnchorNodes(node.id, edges, nodeMap);

  if (anchors.length === 1 && radiusMm > 0) {
    const c = planPos(anchors[0], nodeMap);
    return { base: circlePolygon(c.x, c.y, radiusMm), baseKind: 'circle', anchorCount: 1 };
  }

  const pts: Pt2[] = [];
  for (const a of anchors) {
    const p = planPos(a, nodeMap);
    const prev = pts[pts.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 1) continue;
    pts.push({ x: p.x, y: p.y });
  }
  if (pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1) pts.pop();
  }
  if (pts.length < 3) return { base: null, baseKind: 'none', anchorCount: anchors.length };
  // Rounded AFTER the ring is closed and wound, so a fillet spanning the
  // seam between the last and first anchor is treated like any other corner.
  return {
    base: filletPolygon(ensureCcw(pts), filletMm),
    baseKind: 'contour',
    anchorCount: anchors.length,
  };
}

// ─── Memo ────────────────────────────────────────────────────────────────────

const MEMO_MAX = 16;
const memo = new Map<string, DomeResult>();

/**
 * Everything the result depends on. The resolved profile polygon is part of
 * it because a DXF profile lands asynchronously: the same properties can
 * resolve to nothing now and to a polygon a moment later.
 */
function memoKey(
  node: BubbleGraphNode, base: Pt2[] | null, anchorCount: number, baseZ: number,
  profilePoly: Pt2[] | null, context: string,
): string {
  // `anchorCount` is here for the failure cases: no base is the same `null`
  // whether the dome has no anchors or two, and the diagnostic says which.
  return JSON.stringify([node.id, node.properties, base, anchorCount, baseZ, profilePoly, context]);
}

/**
 * Everything OUTSIDE this dome that can change its geometry: the other domes
 * on the storey, their bases, and every entrance's settings and mouth.
 *
 * Without this the cache is wrong in the one case clusters exist for —
 * dragging the neighbouring dome would leave this one drawn against where
 * that dome used to be. Bases are cheap to recompute; no membrane is solved
 * to build this.
 */
function clusterSignature(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): string {
  const parts: unknown[] = [];
  const domes = [...nodeMap.values()]
    .filter((n) => n.type === 'dome' && n.parentId === node.parentId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const d of domes) {
    const di = parseDomeIntent(d);
    if (d.id !== node.id) {
      const band = getStoreyBand(d, nodeMap);
      parts.push([
        d.id, d.properties,
        domeBase(d, nodeMap, edges, di.baseRadiusMm, di.baseFilletMm).base,
        (di.level === 'bottom' ? band.bot : band.top) + di.offsetZMm,
      ]);
    }
    for (const en of neighboursOfType(d.id, 'dome_entrance', nodeMap, edges)) {
      parts.push([
        en.id, en.properties,
        getOrderedAnchorNodes(en.id, edges, nodeMap).map((a) => planPos(a, nodeMap)),
      ]);
    }
  }
  return JSON.stringify(parts);
}

function remember(key: string, r: DomeResult): DomeResult {
  if (memo.size >= MEMO_MAX) {
    const first = memo.keys().next().value;
    if (first !== undefined) memo.delete(first);
  }
  memo.set(key, r);
  return r;
}

// ─── Patches ─────────────────────────────────────────────────────────────────

/** One piece of surface to tessellate: a ring, its holes, and whose it is. */
interface Patch {
  shell: DomeShell;
  ring: Pt2[];
  holes: Pt2[][];
  /** The shells this one competes with — needed to recognise its seams. */
  others: DomeShell[];
  /** Cells wanted on this patch, and the seed that places them. */
  cellCount: number;
  seed: number;
}

/** Is `inner` inside `outer`? Tested on a vertex, which suffices for rings
 *  that a contour pass produced and therefore cannot cross. */
function ringInside(inner: Pt2[], outer: Pt2[]): boolean {
  return inner.length > 0 && pointInPolygon(inner[0], outer, 0);
}

/**
 * Seed, relax and clip one patch.
 *
 * Holes are subtracted by treating each as an extra clip: a cell overlapping
 * a hole is cut back to the part outside it. That is exact for a convex hole
 * and conservative otherwise — it can only make a panel smaller, never leave
 * glass over an opening.
 */
function tessellatePatch(
  patch: Patch,
  count: number,
  intent: DomeIntent,
): { cells: Pt2[][]; seeds: Pt2[] } {
  const { shell, ring, holes } = patch;
  const usable = (p: Pt2) => holes.every((h) => !pointInPolygon(p, h, 0));

  let seeds = seedPoints(ring, count, rng(patch.seed)).filter(usable);
  if (seeds.length === 0) return { cells: [], seeds: [] };

  let cells = voronoiCells(ring, seeds);
  const passes = Math.max(0, Math.min(20, Math.round(intent.relaxIterations)));
  for (let i = 0; i < passes; i++) {
    seeds = lloydStep(ring, seeds, cells, (p) => shell.membrane.sample(p).z).filter(usable);
    if (seeds.length === 0) return { cells: [], seeds: [] };
    cells = voronoiCells(ring, seeds);
  }

  if (holes.length > 0) {
    cells = cells.map((cell) => {
      let cut = cell;
      for (const hole of holes) {
        if (cut.length < 3) break;
        // Keep the side of each hole edge that is OUTSIDE the hole. A hole
        // ring is clockwise, so outside is to the left of its reversed edges.
        for (let i = 0; i < hole.length && cut.length >= 3; i++) {
          const a = hole[i], b = hole[(i + 1) % hole.length];
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len < 1e-9) continue;
          if (!cut.some((q) => pointInPolygon(q, hole, 0))) break;
          cut = clipByLine(cut, a, { x: dy / len, y: -dx / len });
        }
      }
      return cut.length >= 3 ? cut : [];
    }).filter((c) => c.length >= 3);
  }

  return { cells, seeds };
}

/** The shell this point is level with, if any — the other side of a seam. */
function seamRival(
  shell: DomeShell,
  others: DomeShell[],
  p: Pt2,
  tolMm: number,
): DomeShell | null {
  const mine = shellHeight(shell, p);
  if (mine === null) return null;
  let best: DomeShell | null = null;
  let bestGap = Infinity;
  for (const o of others) {
    const z = shellHeight(o, p);
    if (z === null) continue;
    const gap = Math.abs(z - mine);
    if (gap <= tolMm && gap < bestGap) { bestGap = gap; best = o; }
  }
  return best;
}

// ─── Entrances and neighbours ────────────────────────────────────────────────

/** Nodes of the given type wired to `nodeId`. */
function neighboursOfType(
  nodeId: string,
  type: string,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): BubbleGraphNode[] {
  const out: BubbleGraphNode[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from !== nodeId && e.to !== nodeId) continue;
    const otherId = e.from === nodeId ? e.to : e.from;
    if (seen.has(otherId)) continue;
    seen.add(otherId);
    const n = nodeMap.get(otherId);
    if (n?.type === type) out.push(n);
  }
  return out;
}

interface BuiltEntrance { node: BubbleGraphNode; shell: DomeShell; geometry: EntranceGeometry }

/**
 * The tunnels opening into this dome.
 *
 * An entrance node carries the width and height; the axis it is wired to is
 * where its mouth stands. Everything else — the stadium, the overrun past the
 * mouth, the cut — comes from `entranceGeometry`.
 */
function buildEntranceShells(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  base: Pt2[],
  baseZMm: number,
  intent: DomeIntent,
  diagnostics: SweepDiagnostic[],
): BuiltEntrance[] {
  const out: BuiltEntrance[] = [];
  for (const en of neighboursOfType(node.id, 'dome_entrance', nodeMap, edges)) {
    const anchors = getOrderedAnchorNodes(en.id, edges, nodeMap);
    if (anchors.length === 0) {
      diagnostics.push({
        code: 'ENTRANCE_NO_AXIS',
        severity: 'error',
        message: `Intrarea „${en.name}" nu e legată de niciun ax — leagă-o de axul unde vrei gura tunelului.`,
      });
      continue;
    }
    const widthMm = Math.max(100, Number(en.properties.width_mm ?? 1200));
    const heightMm = Math.max(1, Number(en.properties.height_mm ?? 2100));
    const fit = entranceFits(heightMm, intent.heightMm);
    if (!fit.ok) {
      diagnostics.push({ code: 'ENTRANCE_TOO_TALL', severity: 'error', message: `„${en.name}": ${fit.reason}` });
      continue;
    }
    const mouth = planPos(anchors[0], nodeMap);
    const geometry = entranceGeometry(base, mouth, widthMm);
    if (!geometry) {
      diagnostics.push({
        code: 'ENTRANCE_DEGENERATE',
        severity: 'error',
        message: `Intrarea „${en.name}" are gura în centrul domului — mut-o pe un ax din afara lui.`,
      });
      continue;
    }
    // A tunnel is narrow, so it needs its own, finer grid: the dome's
    // resolution is set for the dome's span and would give the tunnel two
    // cells across. Aim for eight divisions ACROSS the tunnel, which is what
    // decides whether its vault reads as a vault, and let the length follow.
    const span = Math.max(geometry.lengthMm + widthMm, widthMm);
    const res = Math.max(
      12,
      Math.round(Number(en.properties.resolution ?? 0) || (span / (widthMm / 8))),
    );
    const membrane = membraneFor(geometry.base, heightMm, Number(en.properties.bulge ?? intent.bulge), res);
    if (!membrane) {
      diagnostics.push({
        code: 'ENTRANCE_MEMBRANE_FAILED',
        severity: 'error',
        message: `Nu am putut construi bolta intrării „${en.name}" — verifică lățimea și poziția axului.`,
      });
      continue;
    }
    out.push({
      node: en,
      geometry,
      shell: {
        ownerId: en.id,
        base: geometry.base,
        membrane,
        baseZMm: baseZMm + Number(en.properties.offset_z_mm ?? 0),
        extraField: geometry.mouthField,
      },
    });
  }
  return out;
}

/**
 * Every other dome on the same storey, and their entrances, as shells to
 * compete with.
 *
 * Found by position rather than by wiring: two domes that overlap in plan
 * intersect whether or not anyone connected them, and asking the user to
 * declare it would be asking them to state something the geometry already
 * says.
 */
function buildForeignShells(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  resolveProfile: SweepProfileResolver,
): DomeShell[] {
  void resolveProfile;
  const out: DomeShell[] = [];
  for (const other of nodeMap.values()) {
    if (other.type !== 'dome' || other.id === node.id) continue;
    if (other.parentId !== node.parentId) continue;
    const oi = parseDomeIntent(other);
    if (!(oi.heightMm > 0)) continue;
    const ob = domeBase(other, nodeMap, edges, oi.baseRadiusMm, oi.baseFilletMm);
    if (!ob.base) continue;
    const band = getStoreyBand(other, nodeMap);
    const oz = (oi.level === 'bottom' ? band.bot : band.top) + oi.offsetZMm;
    const m = membraneFor(ob.base, oi.heightMm, oi.bulge, oi.resolution);
    if (!m) continue;
    out.push({ ownerId: other.id, base: ob.base, membrane: m, baseZMm: oz });
    out.push(...buildEntranceShells(other, nodeMap, edges, ob.base, oz, oi, []).map((e) => e.shell));
  }
  return out;
}

// ─── Compute ─────────────────────────────────────────────────────────────────

export function computeDome(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  resolveProfile: SweepProfileResolver = resolveSweepProfile,
): DomeResult {
  const intent = parseDomeIntent(node);
  const { base, baseKind, anchorCount } = domeBase(node, nodeMap, edges, intent.baseRadiusMm, intent.baseFilletMm);
  const band = getStoreyBand(node, nodeMap);
  const baseZMm = (intent.level === 'bottom' ? band.bot : band.top) + intent.offsetZMm;

  const resolved = resolveProfile(intent.profileId, intent.params);
  const key = memoKey(
    node, base, anchorCount, baseZMm, resolved.profile?.polygon ?? null,
    clusterSignature(node, nodeMap, edges),
  );
  const hit = memo.get(key);
  if (hit) return hit;

  const result: DomeResult = {
    intent, base, baseKind, baseZMm,
    cells: [], members: [], memberSolids: [], profile: null, placed: null, panels: [],
    memberLengthMm: 0, seamLengthMm: 0, memberVolumeMm3: 0, glassAreaMm2: 0, offToleranceCount: 0,
    clustered: false, clusteredWith: [],
    zMinMm: baseZMm, zMaxMm: baseZMm,
    diagnostics: [],
  };

  try {
    if (!base) {
      // One anchor and no radius is the near miss worth naming: the user has
      // made the gesture for a circular dome and left out its one number.
      result.diagnostics.push(anchorCount === 1
        ? {
          code: 'NEED_RADIUS',
          severity: 'error',
          message: 'Domul e legat de un singur ax — dă-i o rază a bazei ca să fie cerc, '
            + 'sau leagă-l de cel puțin 3 axe pentru un contur.',
        }
        : {
          code: 'NEED_3_ANCHORS',
          severity: 'error',
          message: anchorCount === 0
            ? 'Domul nu e legat de niciun ax — leagă-l de un ax și dă-i o rază, '
              + 'sau de cel puțin 3 axe, în ordinea conturului bazei.'
            : `Domul are ${anchorCount} axe legate — conturul bazei are nevoie de cel puțin 3 puncte distincte.`,
        });
      return remember(key, result);
    }
    // A radius that is set but unused would otherwise be a silent no-op: the
    // user turns the knob and nothing moves, with nothing to say why.
    if (baseKind === 'contour' && intent.baseRadiusMm > 0) {
      result.diagnostics.push({
        code: 'RADIUS_IGNORED',
        severity: 'info',
        message: `Raza bazei e ignorată — conturul vine din cele ${anchorCount} axe legate. `
          + 'Lasă un singur ax legat ca să folosești raza.',
      });
    }
    if (!isSimplePolygon(base)) {
      result.diagnostics.push({
        code: 'BASE_NOT_SIMPLE',
        severity: 'error',
        message: 'Conturul bazei se auto-intersectează — verifică ordinea în care ai legat axele.',
      });
      return remember(key, result);
    }
    const parent = node.parentId ? nodeMap.get(node.parentId) : undefined;
    if (!parent || parent.type !== 'storey') {
      result.diagnostics.push({
        code: 'NO_STOREY',
        severity: 'warning',
        message: 'Domul nu aparține unui etaj — cota bazei cade pe banda implicită 0–3000 mm.',
      });
    }
    if (!(intent.heightMm > 0)) {
      result.diagnostics.push({
        code: 'ZERO_HEIGHT',
        severity: 'error',
        message: 'Înălțimea domului trebuie să fie pozitivă.',
      });
      return remember(key, result);
    }

    // ── Surfaces ─────────────────────────────────────────────────────────
    // This dome, then its own entrances, then every dome (and entrance) on
    // the storey that stands in its way. All of them are the same thing: a
    // membrane over a base at an elevation.
    const membrane = membraneFor(base, intent.heightMm, intent.bulge, intent.resolution);
    if (!membrane) {
      result.diagnostics.push({
        code: 'MEMBRANE_FAILED',
        severity: 'error',
        message: 'Nu am putut întinde suprafața peste contur — baza e prea mică sau degenerată.',
      });
      return remember(key, result);
    }
    const selfShell: DomeShell = { ownerId: node.id, base, membrane, baseZMm };

    const mine = buildEntranceShells(node, nodeMap, edges, base, baseZMm, intent, result.diagnostics);
    const localShells: DomeShell[] = [selfShell, ...mine.map((e) => e.shell)];
    const foreignShells = buildForeignShells(node, nodeMap, edges, resolveProfile);

    const allShells = [...localShells, ...foreignShells];
    const clusteredWith = new Set<string>();
    for (const local of localShells) {
      for (const other of allShells) {
        if (other === local) continue;
        if (shellsIntersect(local, other)) clusteredWith.add(other.ownerId);
      }
    }
    // An entrance always overlaps its own dome; that is the point, not news.
    const foreignIds = new Set(foreignShells.map((s) => s.ownerId));
    result.clusteredWith = [...clusteredWith].filter((id) => foreignIds.has(id)).sort();
    result.clustered = clusteredWith.size > 0;

    // ── Ribs: the profile, shared by every patch ─────────────────────────
    const { profile, diagnostics: profDiags } = resolved;
    result.profile = profile;
    result.diagnostics.push(...profDiags);
    if (!profile) {
      if (!result.diagnostics.some((d) => d.severity === 'error')) {
        result.diagnostics.push({
          code: 'PROFILE_UNAVAILABLE',
          severity: 'error',
          message: `Profilul nervurii "${intent.profileId}" nu e disponibil — verifică biblioteca de profile.`,
        });
      }
    }
    const sweepIntent: SweepIntent = {
      profileId: intent.profileId, params: intent.params,
      anchorX: 'mid', anchorY: intent.anchorY,
      offsetXMm: 0, offsetZMm: 0, rotationDeg: 0, mirror: false,
      corners: 'butt', closed: false, level: 'top', heightMm: 0, riseMm: 0,
      material: intent.material,
    };
    const placed = profile ? applyProfilePlacement(profile.polygon, sweepIntent) : null;
    result.placed = placed;
    const ribWidthMm = placed ? (placedRectangle(placed)?.w ?? 0) : 0;

    // ── Each local surface tessellates the region it wins ─────────────────
    // A tunnel is a small region beside a big dome, so splitting the dome's
    // cell count by area would give the whole entrance one panel. An entrance
    // carries its own count: it is its own piece of architecture, and the
    // frame around a doorway is exactly where subdivision is wanted.
    const localCounts = new Map<string, { cellCount: number; seed: number }>();
    for (const e of mine) {
      localCounts.set(e.shell.ownerId, {
        cellCount: Math.max(1, Math.min(200, Math.round(Number(e.node.properties.cell_count ?? 8)))),
        seed: Number(e.node.properties.cell_seed ?? intent.seed),
      });
    }

    const patches: Patch[] = [];
    for (const shell of localShells) {
      const others = allShells.filter((s) => s !== shell);
      const own = localCounts.get(shell.ownerId);
      const cellCount = own?.cellCount ?? -1;       // −1 = share the dome's count
      const seed = own?.seed ?? intent.seed;
      const overlapped = others.some((o) => shellsIntersect(shell, o));
      if (!overlapped) {
        patches.push({ shell, ring: shell.base, holes: [], others, cellCount, seed });
        continue;
      }
      // The grid has to resolve the smallest thing it is asked to separate:
      // a 1.2 m tunnel notching a 10 m dome is invisible on the dome's own
      // spacing, and the crease would come back as a stub instead of an arch.
      const spacing = Math.min(
        shell.membrane.spacingMm,
        ...others.filter((o) => shellsIntersect(shell, o)).map((o) => o.membrane.spacingMm),
      );
      const region = ownedRegion(shell, others, spacing);
      for (const ring of region.outers) {
        patches.push({
          shell, ring,
          holes: region.holes.filter((h) => ringInside(h, ring)),
          others, cellCount, seed,
        });
      }
    }
    if (patches.length === 0) {
      result.diagnostics.push({
        code: 'FULLY_COVERED',
        severity: 'warning',
        message: 'Domul e complet acoperit de altul — nu mai are nicio suprafață proprie.',
      });
      return remember(key, result);
    }

    const shared = patches.filter((p) => p.cellCount < 0);
    const sharedArea = shared.reduce((s, p) => s + Math.abs(polygonArea(p.ring)), 0);
    const want = Math.max(1, Math.min(600, Math.round(intent.cellCount)));
    let placedCells = 0;
    const finestSpacing = Math.min(...allShells.map((s) => s.membrane.spacingMm));
    const seamTol = Math.max(10, finestSpacing * 0.8);

    for (const patch of patches) {
      const share = patch.cellCount >= 0
        ? patch.cellCount
        : sharedArea > 0
          ? Math.max(1, Math.round((want * Math.abs(polygonArea(patch.ring))) / sharedArea))
          : want;
      const { cells, seeds } = tessellatePatch(patch, share, intent);
      placedCells += seeds.length;

      const firstCell = result.cells.length;
      result.cells.push(...cells);

      // Ribs. A seam belongs to two surfaces at once, so only the one whose
      // owner id sorts first emits it — otherwise the crease gets two bars.
      const step = Math.max(100, patch.shell.membrane.spacingMm);
      const patchMembers: DomeMember[] = [];
      for (const e of cellEdges(cells)) {
        const mid = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
        const rival = seamRival(patch.shell, patch.others, mid, seamTol);
        if (rival && !ownsSeamAgainst(patch.shell, rival)) continue;
        const member = liftEdge(e, patch.shell.membrane, patch.shell.baseZMm, step);
        member.onSeam = rival !== null;
        patchMembers.push(member);
      }
      result.members.push(...patchMembers);

      // Solids are swept on the patch's OWN surface: the profile stands on
      // that membrane's normals, and a tunnel's normals are not the dome's.
      if (placed && placed.length >= 3) {
        const { solids, volumeMm3 } = memberSolids(patchMembers, placed, patch.shell.membrane);
        result.memberSolids.push(...solids);
        result.memberVolumeMm3 += volumeMm3;
      }

      // Glass.
      const inset = ribWidthMm / 2;
      cells.forEach((cell, i) => {
        if (cell.length < 3) return;
        const panel = panelFromCell(
          firstCell + i, cell, inset, patch.shell.membrane, patch.shell.baseZMm, intent.planarityTolMm,
        );
        if (panel) result.panels.push(panel);
      });
    }

    result.memberLengthMm = result.members.reduce((s, m) => s + m.lengthMm, 0);
    result.seamLengthMm = result.members.filter((m) => m.onSeam).reduce((s, m) => s + m.lengthMm, 0);

    if (placedCells < want) {
      result.diagnostics.push({
        code: 'FEWER_CELLS',
        severity: 'info',
        message: `Au încăput ${placedCells} celule din ${want} cerute — suprafața e prea mică pentru atâtea.`,
      });
    }

    result.glassAreaMm2 = result.panels.reduce((s, p) => s + p.areaMm2, 0);
    result.offToleranceCount = result.panels.filter((p) => !p.planar).length;
    if (result.offToleranceCount > 0) {
      result.diagnostics.push({
        code: 'PANELS_OFF_TOLERANCE',
        severity: 'warning',
        message: `${result.offToleranceCount} din ${result.panels.length} panouri ies din toleranța de planeitate `
          + `(${intent.planarityTolMm} mm) — mai multe celule sau un dom mai plat le aduc înapoi.`,
      });
    }

    // ── Extents ──────────────────────────────────────────────────────────
    let zMax = baseZMm;
    for (const shell of localShells) {
      for (let i = 0; i < shell.membrane.z.length; i++) {
        const z = shell.baseZMm + shell.membrane.z[i];
        if (z > zMax) zMax = z;
      }
    }
    result.zMinMm = baseZMm;
    result.zMaxMm = zMax;
  } catch (err) {
    result.diagnostics.push({
      code: 'DOME_FAILED',
      severity: 'error',
      message: `Geometria domului a eșuat: ${err instanceof Error ? err.message : String(err)}`,
    });
    result.members = []; result.memberSolids = []; result.panels = []; result.cells = [];
  }
  return remember(key, result);
}
