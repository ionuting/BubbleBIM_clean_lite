/**
 * Sketch element — public surface.
 *
 * `computeSketch` is the single pure entry point every consumer shares: the 3D
 * viewers, the floor plan, the section engine, the quantity takeoff, the IFC
 * writer and the Inspector's diagnostics all read the same result, so what is
 * drawn is what is measured and what is exported. It never throws — a failure
 * is a diagnostic, not an exception.
 *
 * The outline is stored relative to a REFERENCE — see `frame.ts`. Unwired, the
 * reference is the identity and the points are plain BIM millimetres; wired
 * to one or two axes, the points are offsets from them, so the sketch follows
 * the grid the way a wall does. An element that should follow a whole run of
 * axes is still a sweep, which takes its guide line from every anchor.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { getStoreyBand } from '@/lib/bimGeometry';
import { isSimplePolygon } from '@/lib/geom/plan2d';
import { profilePlacementOf } from '@/lib/sweep/profiles';
import { ccw, checkHoles, cw, faceArea, facePerimeter, type HoleProblem } from '@/lib/geom/faceWithHoles';
import type { Pt2 } from '@/lib/geom/plan2d';
import { arcLength } from '@/lib/geom/nurbs';
import { curveFromPoints } from './shapes';
import { resolveSweepProfile, type SweepProfileResolver } from '@/lib/sweep/profileLibrary';
import {
  computeSweepSolids,
  profileArea,
  sweepFootprint,
  sweepVolume,
  triangulateSimple,
} from '@/lib/sweep/rings';
import type { SweepIntent, SweepSolid } from '@/lib/sweep/types';
import {
  arrayOffsets,
  cleanOutline,
  extrudeSolid,
  IDENTITY_PLACEMENT,
  outlineArea,
  outlineLength,
  outlinePath,
  placementOf,
  placeOutline,
  placeSolids,
  type CopyPlacement,
} from './build';
import { closestDistance, curvePath, headingOf, polylinePath, type PathReader } from '@/lib/geom/pathStations';
import type { SketchArray } from './types';
import {
  parseSketchIntent,
  type SketchCopy,
  type SketchDiagnostic,
  type SketchIntent,
  type SketchResult,
} from './types';
import { outlineToWorld, resolveSketchFrame, type SketchFrame } from './frame';

export * from './types';
export * from './build';
export * from './shapes';
export * from './frame';
export * from './rewire';
export * from './dims';

/**
 * The IFC entity an 'auto' sketch exports as.
 *
 * Proxy is the honest answer: nothing about a hand-drawn outline says whether
 * it is a plinth, a kerb or a bench, and guessing would put a wrong class in
 * the model for the sake of looking clever. The Inspector offers the real
 * classes so the modeller can say what it actually is.
 */
export const SKETCH_DEFAULT_IFC_TYPE = 'IFCBUILDINGELEMENTPROXY';

export function sketchIfcType(intent: SketchIntent): string {
  const declared = intent.ifcType.trim().toUpperCase();
  return declared && declared !== 'AUTO' && declared.startsWith('IFC')
    ? declared
    : SKETCH_DEFAULT_IFC_TYPE;
}

/** The sweep intent a sketch's profile placement needs — the shared fields only. */
function placementIntent(intent: SketchIntent): SweepIntent {
  return {
    profileId: intent.profileId,
    params: intent.params,
    anchorX: intent.anchorX,
    anchorY: intent.anchorY,
    offsetXMm: intent.offsetXMm,
    offsetZMm: 0,
    rotationDeg: intent.rotationDeg,
    mirror: intent.mirror,
    corners: intent.corners,
    closed: intent.closed,
    level: intent.level,
    heightMm: 0,
    riseMm: 0,
    material: intent.material,
  };
}

// ─── Faces with holes ────────────────────────────────────────────────────────

/** Prefix of a sweep profile id that names a drawn face: `sketch:<node id>`. */
export const SKETCH_PROFILE_PREFIX = 'sketch:';

const HOLE_PROBLEM_TEXT: Record<HoleProblem, string> = {
  too_few_points: 'nu are cel puțin 3 puncte distincte',
  not_simple: 'se auto-intersectează',
  outside: 'nu e în întregime în interiorul conturului',
  overlaps: 'se suprapune cu alt gol',
};

/** A sketch node's own outline in BIM mm, cleaned — no holes, no body. */
function worldOutline(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): { outline: Pt2[]; closed: boolean } {
  const intent = parseSketchIntent(node);
  const { frame } = resolveSketchFrame(node, nodeMap, edges);
  const local = cleanOutline(intent.localOutline, intent.closed);
  return { outline: outlineToWorld(frame, intent.ref, local), closed: intent.closed };
}

/**
 * The holes cut out of `host`'s face: every closed sketch naming it in
 * `hole_of`, checked against the outline and against each other. What cannot
 * be cut is reported, never silently dropped.
 */
export function sketchHoles(
  host: BubbleGraphNode,
  outline: Pt2[],
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): { holes: Pt2[][]; holeIds: string[]; diagnostics: SketchDiagnostic[] } {
  const diagnostics: SketchDiagnostic[] = [];
  const candidates: { id: string; name: string; ring: Pt2[] }[] = [];
  for (const n of nodeMap.values()) {
    if (n.type !== 'sketch' || n.id === host.id) continue;
    if (String(n.properties?.hole_of ?? '').trim() !== host.id) continue;
    const { outline: ring, closed } = worldOutline(n, nodeMap, edges);
    const name = n.name || n.id;
    if (!closed) {
      diagnostics.push({ code: 'SKETCH_HOLE_OPEN', severity: 'warning', message: `Golul „${name}” nu e un contur închis — nu a fost decupat.` });
      continue;
    }
    candidates.push({ id: n.id, name, ring });
  }
  if (candidates.length === 0) return { holes: [], holeIds: [], diagnostics };

  const check = checkHoles(outline, candidates.map((c) => c.ring));
  for (const r of check.rejected) {
    diagnostics.push({
      code: 'SKETCH_HOLE_REJECTED',
      severity: 'warning',
      message: `Golul „${candidates[r.index].name}” ${HOLE_PROBLEM_TEXT[r.problem]} — nu a fost decupat.`,
    });
  }
  return {
    holes: check.valid.map((i) => cw(candidates[i].ring)),
    holeIds: check.valid.map((i) => candidates[i].id),
    diagnostics,
  };
}

/**
 * A drawn face as a sweep profile: the source sketch's outline and its holes,
 * in plan millimetres read as the profile's own (x, y). Where it stands in the
 * plan does not matter — the placement re-anchors it on its own bounds.
 */
export function sketchFaceProfile(
  sourceId: string,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): { polygon: Pt2[]; holes: Pt2[][]; diagnostics: SketchDiagnostic[] } | null {
  const src = nodeMap.get(sourceId);
  if (!src || src.type !== 'sketch') return null;
  const { outline, closed } = worldOutline(src, nodeMap, edges);
  if (!closed || outline.length < 3 || !isSimplePolygon(outline)) return null;
  const { holes, diagnostics } = sketchHoles(src, outline, nodeMap, edges);
  return { polygon: ccw(outline), holes, diagnostics };
}

// ─── Arrays along a path ─────────────────────────────────────────────────────

/**
 * A sketch's outline as a path to walk: the exact curve for a curve sketch,
 * the polyline otherwise — in BIM mm either way. A NURBS curve is invariant
 * under the rigid frame transform, so the curve built on the placed points
 * IS the placed curve.
 */
export function sketchPathReader(
  src: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
): PathReader | null {
  const intent = parseSketchIntent(src);
  const { frame } = resolveSketchFrame(src, nodeMap, edges);
  if (intent.curve) {
    const pts = outlineToWorld(frame, intent.ref, intent.curve.points);
    const c = curveFromPoints(pts, intent.closed, intent.curve.mode, intent.curve.degree);
    if (c) return curvePath(c);
  }
  const { outline, closed } = worldOutline(src, nodeMap, edges);
  return outline.length >= 2 ? polylinePath(outline, closed) : null;
}

/**
 * Where each copy of an array along a path goes.
 *
 * Copy 0 is the original; it stands where it is nearest the path — read off
 * the drawing, so an element drawn anywhere beside the path starts the array
 * from there. Every other copy is the original carried along the path to its
 * own station — moved by
 * the difference of the stations and, with `orient: 'tangent'`, turned by
 * the difference of the headings about the first station. So whatever
 * relation the original has to the path (on it, 500 off it, across it) every
 * copy has too.
 */
function pathPlacements(
  self: BubbleGraphNode,
  /** Where the original is — its outline's centroid, BIM mm. */
  at: Pt2,
  array: SketchArray,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  diagnostics: SketchDiagnostic[],
): CopyPlacement[] | null {
  const src = array.pathId ? nodeMap.get(array.pathId) : undefined;
  if (!src || src.type !== 'sketch' || src.id === self.id) {
    diagnostics.push({
      code: 'SKETCH_ARRAY_NO_PATH',
      severity: 'warning',
      message: array.pathId
        ? 'Traseul array-ului nu mai există sau nu e o schiță — a rămas un singur exemplar.'
        : 'Alege schița-traseu pe care se repetă exemplarele (Array → Traseu).',
    });
    return null;
  }
  const path = sketchPathReader(src, nodeMap, edges);
  if (!path || path.length < 1) {
    diagnostics.push({ code: 'SKETCH_ARRAY_PATH_EMPTY', severity: 'warning', message: `Traseul „${src.name || src.id}” nu are lungime — a rămas un singur exemplar.` });
    return null;
  }

  const n = Math.max(1, Math.round(array.count));
  const s0 = closestDistance(path, at);
  let distances: number[];
  if (array.fit) {
    // Spread over what is left of the path; a loop wraps, so its last copy
    // stops one gap short of landing on the first.
    const span = path.closed ? path.length : path.length - s0;
    const gaps = path.closed ? n : Math.max(1, n - 1);
    distances = Array.from({ length: n }, (_, i) => s0 + (n === 1 ? 0 : (span * i) / gaps));
  } else {
    if (array.stepMm < 1) {
      diagnostics.push({ code: 'SKETCH_ARRAY_NO_STEP', severity: 'warning', message: 'Array-ul pe traseu are pasul zero — alege un pas sau „Întins pe tot traseul”.' });
      return null;
    }
    distances = Array.from({ length: n }, (_, i) => s0 + i * array.stepMm);
  }
  if (!path.closed) {
    const past = distances.filter((d) => d > path.length + 0.5).length;
    if (past > 0) {
      diagnostics.push({
        code: 'SKETCH_ARRAY_PAST_END',
        severity: 'warning',
        message: `${past} ${past === 1 ? 'exemplar ar ieși' : 'exemplare ar ieși'} după capătul traseului (${Math.round(path.length)} mm) — ${past === 1 ? 'a fost omis' : 'au fost omise'}.`,
      });
      distances = distances.filter((d) => d <= path.length + 0.5);
    }
  }

  const st = path.at(distances);
  const base = st[0];
  const h0 = headingOf(base.tangent);
  return st.map((q, i) => ({
    d: { x: q.point.x - base.point.x, y: q.point.y - base.point.y, z: array.dzMm * i },
    rotRad: (array.orient ?? 'tangent') === 'tangent' ? headingOf(q.tangent) - h0 : 0,
    pivot: base.point,
  }));
}

function emptyResult(intent: SketchIntent, frame: SketchFrame, diagnostics: SketchDiagnostic[]): SketchResult {
  return {
    intent,
    frame,
    placed: null,
    profileHoles: [],
    path: null,
    solids: [],
    copies: [],
    footprint: [],
    footprintHoles: [],
    holes: [],
    holeIds: [],
    lengthMm: outlineLength(intent.outline, intent.closed),
    curvePoints: [],
    perimeterMm: outlineLength(intent.outline, intent.closed),
    areaMm2: outlineArea(intent.outline, intent.closed),
    profileAreaMm2: 0,
    volumeMm3: 0,
    count: 0,
    zMinMm: 0,
    zMaxMm: 0,
    diagnostics,
  };
}

export function computeSketch(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[] = [],
  resolveProfile: SweepProfileResolver = resolveSweepProfile,
): SketchResult {
  const raw = parseSketchIntent(node);
  const diagnostics: SketchDiagnostic[] = [];

  // Place the drawn points in the world first: everything below — the
  // simplicity test, the extrusion, the path — works on BIM coordinates, so
  // the reference frame is invisible to it. A mirror flips the winding, and
  // `extrudeSolid` re-winds CCW itself, so that needs no special case here.
  const { frame, diagnostics: frameDiags } = resolveSketchFrame(node, nodeMap, edges);
  for (const d of frameDiags) diagnostics.push(d);
  const local = cleanOutline(raw.localOutline, raw.closed);
  const outline = outlineToWorld(frame, raw.ref, local);
  const intent: SketchIntent = { ...raw, outline, localOutline: local };
  // A curve's handles sit on its own points, and its length is the curve's —
  // integrated on it, not summed along the polyline that stands for it. The
  // frame is rigid (a mirror at most), so the length does not depend on it.
  const curvePoints = raw.curve ? outlineToWorld(frame, raw.ref, raw.curve.points) : [];
  const curve = raw.curve ? curveFromPoints(raw.curve.points, raw.closed, raw.curve.mode, raw.curve.degree) : null;
  const exactLength = curve ? arcLength(curve) : null;

  if (outline.length < 2) {
    diagnostics.push({
      code: 'SKETCH_EMPTY',
      severity: 'error',
      message: 'Schița nu are contur — desenează-l în planul de nivel (unealta Schiță).',
    });
    return { ...emptyResult(intent, frame, diagnostics), curvePoints };
  }

  const parent = node.parentId ? nodeMap.get(node.parentId) : undefined;
  if (!parent || parent.type !== 'storey') {
    diagnostics.push({
      code: 'SKETCH_NO_STOREY',
      severity: 'warning',
      message: 'Schița nu aparține unui etaj — cotele cad pe banda implicită 0–3000 mm.',
    });
  }

  const band = getStoreyBand(node, nodeMap);
  const baseZ = (intent.level === 'bottom' ? band.bot : band.top) + intent.offsetZMm;

  // ── A hole is not a body: it is cut out of its host ─────────────────────
  if (intent.holeOf) {
    const host = nodeMap.get(intent.holeOf);
    if (!host || host.type !== 'sketch') {
      diagnostics.push({
        code: 'SKETCH_HOLE_NO_HOST',
        severity: 'warning',
        message: 'Schița e marcată ca gol, dar schița-gazdă nu mai există — nu decupează nimic.',
      });
    } else {
      diagnostics.push({
        code: 'SKETCH_IS_HOLE',
        severity: 'info',
        message: `Gol decupat din „${host.name || host.id}” — nu are corp propriu.`,
      });
    }
    return { ...emptyResult(intent, frame, diagnostics), curvePoints };
  }

  // Holes only mean something in a closed face; an open path has none.
  const faceHoles = intent.closed && outline.length >= 3
    ? sketchHoles(node, outline, nodeMap, edges)
    : { holes: [], holeIds: [], diagnostics: [] };
  for (const d of faceHoles.diagnostics) diagnostics.push(d);
  const holes = faceHoles.holes;

  const result: SketchResult = {
    intent,
    frame,
    placed: null,
    profileHoles: [],
    path: null,
    solids: [],
    copies: [],
    footprint: [],
    footprintHoles: [],
    holes,
    holeIds: faceHoles.holeIds,
    lengthMm: exactLength ?? outlineLength(outline, intent.closed),
    curvePoints,
    perimeterMm: intent.closed
      ? facePerimeter(outline, holes) + (exactLength != null ? exactLength - outlineLength(outline, true) : 0)
      : exactLength ?? outlineLength(outline, false),
    areaMm2: intent.closed ? faceArea(outline, holes) : 0,
    profileAreaMm2: 0,
    volumeMm3: 0,
    count: 0,
    zMinMm: baseZ,
    zMaxMm: baseZ,
    diagnostics,
  };

  try {
    // One copy of the body, at the origin; the array translates it afterwards.
    let base: SweepSolid[] = [];
    let placed: typeof result.placed = null;
    let footprint: ReturnType<typeof sweepFootprint> = [];
    let footprintHoles: Pt2[][][] = [];

    if (intent.op === 'none') {
      const fp = intent.closed ? [outline] : [];
      const fh = intent.closed ? [holes] : [];
      result.footprint = fp;
      result.footprintHoles = fh;
      result.copies = [{ dxMm: 0, dyMm: 0, dzMm: 0, rotDeg: 0, pivot: { x: 0, y: 0 }, footprint: fp, footprintHoles: fh, zMinMm: baseZ, zMaxMm: baseZ }];
      result.count = 1;
      return result;
    }

    if (intent.op === 'extrude') {
      if (!intent.closed) {
        diagnostics.push({
          code: 'SKETCH_NOT_CLOSED',
          severity: 'error',
          message: 'Extrudarea cere un contur închis — închide polilinia sau treci pe operația Sweep.',
        });
        return result;
      }
      if (outline.length < 3) {
        diagnostics.push({
          code: 'SKETCH_TOO_FEW_POINTS',
          severity: 'error',
          message: 'Un contur închis are nevoie de cel puțin 3 puncte.',
        });
        return result;
      }
      if (!isSimplePolygon(outline)) {
        diagnostics.push({
          code: 'SKETCH_NOT_SIMPLE',
          severity: 'error',
          message: 'Conturul se auto-intersectează — corectează punctele desenate.',
        });
        return result;
      }
      if (Math.abs(intent.heightMm) < 1) {
        diagnostics.push({
          code: 'SKETCH_ZERO_HEIGHT',
          severity: 'error',
          message: `Înălțimea de extrudare e ${Math.round(intent.heightMm)} mm — pune o valoare nenulă.`,
        });
        return result;
      }

      // A negative height extrudes downwards; rings stay bottom-then-top so
      // the face winding stays outward either way.
      const zLow = Math.min(baseZ, baseZ + intent.heightMm);
      const zHigh = Math.max(baseZ, baseZ + intent.heightMm);
      const solid = extrudeSolid(outline, zLow, zHigh, holes);
      if (!solid) return result;

      base = [solid];
      placed = solid.rings[0].map((p) => ({ x: p.x, y: p.y }));
      footprint = [outline];
      footprintHoles = [holes];
    } else {
      // ── sweep: the drawn outline is the PATH ────────────────────────────
      // The profile is a library one, or a face drawn as another sketch —
      // `sketch:<id>` — which brings its holes along.
      let profile: { polygon: Pt2[]; holes?: Pt2[][] } | null = null;
      if (intent.profileId.startsWith(SKETCH_PROFILE_PREFIX)) {
        const srcId = intent.profileId.slice(SKETCH_PROFILE_PREFIX.length);
        const face = srcId === node.id ? null : sketchFaceProfile(srcId, nodeMap, edges);
        if (!face) {
          diagnostics.push({
            code: 'SKETCH_PROFILE_FACE_INVALID',
            severity: 'error',
            message: 'Profilul desenat nu e o față închisă și simplă (sau lipsește) — alege altă schiță ca profil.',
          });
          return result;
        }
        for (const d of face.diagnostics) diagnostics.push(d);
        profile = face;
      } else {
        const lib = resolveProfile(intent.profileId, intent.params);
        for (const d of lib.diagnostics) diagnostics.push(d);
        profile = lib.profile;
      }
      if (!profile) {
        if (!diagnostics.some((d) => d.severity === 'error')) {
          diagnostics.push({
            code: 'SKETCH_PROFILE_UNAVAILABLE',
            severity: 'error',
            message: `Profilul "${intent.profileId}" nu e disponibil — verifică biblioteca de profile.`,
          });
        }
        return result;
      }

      const placeAt = profilePlacementOf(profile.polygon, placementIntent(intent));
      const sectionPoly = ccw(profile.polygon.map(placeAt));
      const sectionHoles = (profile.holes ?? []).map((h) => cw(h.map(placeAt)));
      if (sectionPoly.length < 3 || !isSimplePolygon(sectionPoly)) {
        diagnostics.push({
          code: 'SKETCH_PROFILE_NOT_SIMPLE',
          severity: 'error',
          message: 'Profilul rezultat se auto-intersectează — verifică dimensiunile.',
        });
        return result;
      }

      const path = outlinePath(outline, baseZ, intent.closed);
      if (!path) return result;

      const { solids, diagnostics: cornerDiags } = computeSweepSolids(path, sectionPoly, intent.corners, undefined, sectionHoles);
      result.path = path;
      for (const d of cornerDiags) diagnostics.push(d);
      base = solids;
      placed = sectionPoly;
      footprint = sweepFootprint(solids, path, sectionPoly);
      footprintHoles = footprint.map(() => []);
      result.profileAreaMm2 = sectionHoles.length ? faceArea(sectionPoly, sectionHoles) : profileArea(sectionPoly);
      result.profileHoles = sectionHoles;
    }

    if (base.length === 0 || !placed) return result;

    // ── array ────────────────────────────────────────────────────────────
    let offsets: CopyPlacement[];
    if (intent.array.along === 'path') {
      offsets = intent.array.count > 1
        ? pathPlacements(node, {
          x: outline.reduce((a, p) => a + p.x, 0) / outline.length,
          y: outline.reduce((a, p) => a + p.y, 0) / outline.length,
        }, intent.array, nodeMap, edges, diagnostics) ?? [IDENTITY_PLACEMENT]
        : [IDENTITY_PLACEMENT];
    } else {
      if (intent.array.along === 'ref' && frame.refLengthMm <= 0 && intent.array.count > 1) {
        diagnostics.push({
          code: 'SKETCH_ARRAY_NO_REF_LINE',
          severity: 'warning',
          message: 'Array-ul „de-a lungul referinței" are nevoie de două axe legate — s-a folosit pasul dX/dY/dZ.',
        });
      }
      offsets = arrayOffsets(intent.array, frame).map(placementOf);
      if (intent.array.count > 1 && offsets.length === 1) {
        diagnostics.push({
          code: 'SKETCH_ARRAY_NO_STEP',
          severity: 'warning',
          message: 'Array-ul are pasul zero — copiile s-ar suprapune, așa că a rămas un singur exemplar.',
        });
      }
    }

    // The body's own vertical extent, before any array offset.
    let baseMin = Infinity, baseMax = -Infinity;
    for (const s of base) for (const r of s.rings) for (const p of r) {
      if (p.z < baseMin) baseMin = p.z;
      if (p.z > baseMax) baseMax = p.z;
    }
    if (baseMin > baseMax) { baseMin = baseZ; baseMax = baseZ; }

    const allSolids: SweepSolid[] = [];
    const allFootprints: typeof footprint = [];
    const allFootprintHoles: Pt2[][][] = [];
    const copies: SketchCopy[] = [];
    for (const pl of offsets) {
      const d = pl.d;
      for (const s of placeSolids(base, pl)) allSolids.push(s);
      const fp = footprint.map((f) => placeOutline(f, pl));
      const fh = footprint.map((_, i) => (footprintHoles[i] ?? []).map((h) => placeOutline(h, pl)));
      for (const f of fp) allFootprints.push(f);
      for (const h of fh) allFootprintHoles.push(h);
      copies.push({
        dxMm: d.x, dyMm: d.y, dzMm: d.z,
        rotDeg: (pl.rotRad * 180) / Math.PI,
        pivot: pl.pivot,
        footprint: fp,
        footprintHoles: fh,
        zMinMm: baseMin + d.z,
        zMaxMm: baseMax + d.z,
      });
    }

    result.solids = allSolids;
    result.placed = placed;
    result.copies = copies;
    result.footprint = allFootprints;
    result.footprintHoles = allFootprintHoles;
    result.count = copies.length;
    result.volumeMm3 = sweepVolume(allSolids, triangulateSimple(placed));
    result.zMinMm = baseMin + Math.min(...copies.map((c) => c.dzMm));
    result.zMaxMm = baseMax + Math.max(...copies.map((c) => c.dzMm));
  } catch (err) {
    diagnostics.push({
      code: 'SKETCH_FAILED',
      severity: 'error',
      message: `Geometria schiței a eșuat: ${err instanceof Error ? err.message : String(err)}`,
    });
    result.solids = [];
    result.footprint = [];
    result.footprintHoles = [];
  }

  return result;
}
