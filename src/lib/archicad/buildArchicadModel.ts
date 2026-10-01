/**
 * buildArchicadModel.ts — bubble-graph → ArchiCAD element payloads.
 *
 * Mirrors `src/lib/ifc/buildIfcModel.ts`: same per-storey traversal, a different
 * emitter. Pure — it produces a plan of Tapir command payloads and touches no
 * network, so the whole mapping is unit-testable without ArchiCAD running.
 *
 * ArchiCAD's model lines up with ours unusually well: stories carry an
 * elevation while elements are placed storey-relative, walls are centreline +
 * thickness, and openings are (host wall, offset along it, sill, size). So this
 * is mostly unit conversion and ordering, not geometry.
 *
 * Two conventions worth stating once:
 *
 *   Units. The graph is millimetres, ArchiCAD's API is metres, and the
 *   `parse*` helpers in bimGeometry.ts already return METRES because the type
 *   strings encode centimetres (`W20`, `C30x30`, `B25x30`, `SLAB15`). Positions
 *   therefore get `* MM`; parsed sections must NOT.
 *
 *   Joins. Unlike the IFC and 3D paths, we do not bake mitres into a footprint —
 *   ArchiCAD joins walls itself. Raw centreline endpoints are both simpler and
 *   more correct here.
 *
 * Roofs map unusually cleanly: every face the roof solver produces is planar,
 * and ArchiCAD's single-plane roof is defined by exactly a plan outline, a
 * pivot line and a slope — so one face becomes one roof with no approximation.
 *
 * Deliberately not emitted: the roof's timber framing (a Tapir beam takes one
 * zCoordinate and is therefore horizontal, so a sloping rafter cannot be
 * expressed as one), gable-end panels, foundations, shells, coverings, objects,
 * voids, and local node transforms.
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  MM,
  calcRoomPolygon,
  calcShellPolygon,
  collectOpenings,
  getConnectedNodes,
  getNodeBimPos,
  getNodeSlabThickness,
  insetPolygon,
  parseBeamDims,
  parseColumnDims,
  parseContourOffsets,
  getNodeWallThickness,
  resolveStoreyId,
} from '@/lib/bimGeometry';
import { evalProp, expandArrayNodes } from '@/lib/formulaUtils';
import { computeRoofFaces } from '@/lib/roof';
import { computeStairGeometry } from '@/lib/stair';
import { computeSweep, placedRectangle, sweepSegments } from '@/lib/sweep';

// ─── Tapir payload shapes ────────────────────────────────────────────────────

export interface Pt2 { x: number; y: number }

export interface StoryPayload { name: string; level: number; dispOnSections: boolean }

export interface WallPayload {
  begCoordinate: Pt2; endCoordinate: Pt2; zCoordinate: number;
  height: number; thickness: number; floorIndex: number;
}

export interface ColumnPayload {
  coordinates: { x: number; y: number; z: number };
  height: number; width: number; depth: number; floorIndex: number;
}

export interface BeamPayload {
  begCoordinate: Pt2; endCoordinate: Pt2; zCoordinate: number;
  width: number; height: number; floorIndex: number;
}

export interface SlabPayload {
  polygonCoordinates: Pt2[]; level: number; thickness: number; floorIndex: number;
}

/** Windows and doors share a shape; `ownerWallId` is filled in after the walls exist. */
export interface OpeningPayload {
  /** Index into `plan.walls` — resolved to a GUID once CreateWalls has run. */
  wallIndex: number;
  centerOffset: number; sillHeight: number; width: number; height: number;
}

/**
 * One planar roof face, as ArchiCAD's SINGLE-PLANE roof.
 *
 * ArchiCAD builds such a roof from a plan outline plus a pivot line and a slope
 * angle: the plane passes through the pivot line at `level` and rises on the
 * LEFT of the pivot direction. Since every face BubbleBIM produces is already
 * planar, one face maps to one roof exactly — no approximation, and no need for
 * ArchiCAD's own multi-plane solver to re-derive a shape we already know.
 */
export interface RoofPayload {
  polygonCoordinates: Pt2[];
  pivotLine: { begCoordinate: Pt2; endCoordinate: Pt2 };
  /** Slope in RADIANS, as the command expects. */
  angle: number;
  /** Elevation of the pivot line, storey-relative like every other payload. */
  level: number;
  thickness: number;
  /**
   * Always 'Basic'. Left unset, ArchiCAD builds the roof from whatever
   * composite its Roof tool currently defaults to and IGNORES `thickness`
   * outright — measured on ArchiCAD 29, a 40 mm covering came out as the
   * template's 300 mm composite. 'Basic' is what makes the thickness we send
   * the thickness that gets built.
   */
  structureType: 'Basic';
  floorIndex: number;
}

/**
 * A stair, in ArchiCAD's own parameters.
 *
 * `CreateStairs` takes the walking-line polyline plus the step sizing, which is
 * exactly what the stair solver already produces — 2 baseline points for a
 * straight run, 3+ for a quarter- or half-turn. So this is a unit conversion,
 * not a translation.
 *
 * One caveat, measured on ArchiCAD 29: the baseline gives the PATH, not the
 * exact layout. A straight run comes back identical (17 risers, 4.62 m walking
 * line, both as sent), but for a turning stair ArchiCAD re-derives its own
 * flight split and landing from the polyline, so its walking line comes out
 * longer than the one we sent (6.09 m against 5.04 m on a quarter-turn). The
 * step count, riser and going are honoured either way — what differs is where
 * the landing lands, so a turning stair's plan footprint can disagree with
 * BubbleBIM's. That is ArchiCAD's parametric stair doing its own thing, and it
 * stays editable there, which is the point of pushing a real Stair rather than
 * a pile of slabs.
 *
 * Status by stair type, all verified against ArchiCAD 29 / Tapir 1.5.8:
 *   straight        comes back identical.
 *   L / U, landing  counts and sizing honoured, layout re-derived.
 *   L / U, winder   creates — but ONLY with the corner point alone on the
 *                   baseline. With a point per winder (~260 mm segments)
 *                   CreateStairs refuses the whole stair (-2130313215), so the
 *                   payload sends flight ends only and ArchiCAD builds its own
 *                   corner, which will be its default turn, not our fan.
 *   spiral          refused outright: arc chords at both ~16° (18 points) and
 *                   ~60° (6 points) fail with the same code. Skipped, with the
 *                   measured reason in `skipped`.
 */
export interface StairPayload {
  baseLinePoints: Pt2[];
  /** ABSOLUTE elevation of the stair base, unlike every other payload here. */
  zCoordinate: number;
  totalHeight: number;
  flightWidth: number;
  stepNum: number;
  riserHeight: number;
  treadDepth: number;
  floorIndex: number;
}

export interface ArchicadPlan {
  stories: StoryPayload[];
  walls: WallPayload[];
  columns: ColumnPayload[];
  beams: BeamPayload[];
  slabs: SlabPayload[];
  roofs: RoofPayload[];
  stairs: StairPayload[];
  windows: OpeningPayload[];
  doors: OpeningPayload[];
  /** Everything dropped, with the reason — printed by the CLI so nothing vanishes silently. */
  skipped: { nodeId: string; type: string; reason: string }[];
}

// ─── Property reading ────────────────────────────────────────────────────────

/** Opt-in flag, case-insensitive: `has_column`, `has_beam`. */
const flagOn = (v: unknown): boolean => String(v ?? '').toLowerCase() === 'true';

/** Opt-OUT flag: absent means yes. Only `has_slab` behaves this way. */
const flagNotOff = (v: unknown): boolean => v !== 'False' && v !== false && v !== 'false';

/** Numeric property that may be a formula string, so `Number()` alone would give NaN. */
function numProp(v: unknown, fallback: number): number {
  if (v == null || v === '') return fallback;
  if (typeof v === 'number') return isFinite(v) ? v : fallback;
  const n = evalProp(v as string, undefined, NaN);
  return isFinite(n) ? n : fallback;
}

/** Node types this bridge can turn into ArchiCAD elements — used for skip reporting. */
const EMITTABLE = new Set(['ax', 'column', 'wall', 'beam', 'room', 'slab', 'window', 'door', 'roof', 'stairwell', 'sweep']);

/**
 * Turn one planar roof face into ArchiCAD's single-plane roof parameters.
 *
 * The face's own plane gives everything: the horizontal gradient points uphill,
 * so a level line of the plane runs perpendicular to it, and the slope angle is
 * the gradient's arctangent. The pivot direction is chosen so that ArchiCAD's
 * "rises on the left" rule tilts the plane the way our face actually tilts —
 * get this backwards and every roof comes out mirrored about the horizontal.
 *
 * Returns null for a face that is not a usable slope: degenerate, vertical, or
 * dead level (ArchiCAD requires a positive angle, so a flat face is a slab).
 */
export function roofFaceToPayload(
  vertices: { x: number; y: number; z: number }[],
): { poly: Pt2[]; pivot: { beg: Pt2; end: Pt2 }; angleRad: number; levelMm: number } | null {
  if (vertices.length < 3) return null;

  let nx = 0, ny = 0, nz = 0;
  for (let i = 1; i + 1 < vertices.length; i++) {
    const ux = vertices[i].x - vertices[0].x, uy = vertices[i].y - vertices[0].y, uz = vertices[i].z - vertices[0].z;
    const vx = vertices[i + 1].x - vertices[0].x, vy = vertices[i + 1].y - vertices[0].y, vz = vertices[i + 1].z - vertices[0].z;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (Math.hypot(cx, cy, cz) > 1e-6) { nx = cx; ny = cy; nz = cz; break; }
  }
  if (Math.abs(nz) < 1e-9) return null;

  // z = z0 + g·(p − p0); |g| is rise over run, so atan(|g|) is the slope.
  const gx = -nx / nz, gy = -ny / nz;
  const gLen = Math.hypot(gx, gy);
  if (gLen < 1e-6) return null;
  const up = { x: gx / gLen, y: gy / gLen };

  // ArchiCAD tilts up on the LEFT of beg→end, and left of d is (−d.y, d.x).
  // Setting d = (up.y, −up.x) makes that left normal equal `up`.
  const dir = { x: up.y, y: -up.x };

  // Anchor the pivot on the lowest vertex, and report that vertex's elevation.
  let low = vertices[0];
  for (const v of vertices) if (v.z < low.z) low = v;

  // Length is irrelevant to ArchiCAD — only the line's position and direction —
  // but keep it on the face's own scale so the numbers stay readable.
  const span = Math.max(
    1000,
    Math.max(...vertices.map((v) => Math.hypot(v.x - low.x, v.y - low.y))),
  );

  return {
    poly: vertices.map((v) => ({ x: v.x, y: v.y })),
    pivot: {
      beg: { x: low.x, y: low.y },
      end: { x: low.x + dir.x * span, y: low.y + dir.y * span },
    },
    angleRad: Math.atan(gLen),
    levelMm: low.z,
  };
}

// ─── Builder ─────────────────────────────────────────────────────────────────

export function buildArchicadModel(
  allNodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): ArchicadPlan {
  // Array nodes (`array_x/y/z`) stand for a grid of instances; the viewers expand
  // them first and buildIfcModel does not, which silently exports one of N.
  const nodes = expandArrayNodes(allNodes);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const plan: ArchicadPlan = {
    stories: [], walls: [], columns: [], beams: [], slabs: [], roofs: [], stairs: [],
    windows: [], doors: [], skipped: [],
  };
  const skip = (n: BubbleGraphNode, reason: string) =>
    plan.skipped.push({ nodeId: n.id, type: n.type, reason });

  const storeys = nodes
    .filter((n) => n.type === 'storey')
    .sort((a, b) => Number(a.properties.bottomElevation ?? 0) - Number(b.properties.bottomElevation ?? 0));

  if (storeys.length === 0) return plan;

  // The sorted position IS the ArchiCAD floorIndex — SetStories writes the same
  // order, so the two structures line up by construction.
  const floorIndexOf = new Map(storeys.map((s, i) => [s.id, i]));

  // Group by the FULL parent chain: a room's slab or a wall's opening can sit
  // deeper than one level, and a flat `parentId === storey.id` filter drops them.
  // Who is wired to whom, so an element with no parent can still be placed.
  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    if (!neighbours.has(e.from)) neighbours.set(e.from, []);
    if (!neighbours.has(e.to)) neighbours.set(e.to, []);
    neighbours.get(e.from)!.push(e.to);
    neighbours.get(e.to)!.push(e.from);
  }

  /**
   * The storey an element belongs to: its own parent chain first, and failing
   * that, the storey of anything it is connected to.
   *
   * The fallback is not a nicety. A roof is created by drawing it against the
   * axes it covers, and comes out with `parentId: null` — it is defined by its
   * edges, not by containment. Requiring a parent chain dropped every such
   * element before it was ever looked at.
   */
  const storeyOf = (n: BubbleGraphNode): string | undefined => {
    const own = resolveStoreyId(n, nodeMap);
    if (own && byStoreyHas(own)) return own;
    for (const id of neighbours.get(n.id) ?? []) {
      const other = nodeMap.get(id);
      if (!other) continue;
      const sid = other.type === 'storey' ? other.id : resolveStoreyId(other, nodeMap);
      if (sid && byStoreyHas(sid)) return sid;
    }
    return undefined;
  };

  const byStorey = new Map<string, BubbleGraphNode[]>(storeys.map((s) => [s.id, []]));
  function byStoreyHas(id: string) { return byStorey.has(id); }

  for (const n of nodes) {
    if (n.type === 'storey') continue;
    const sid = storeyOf(n);
    if (sid) { byStorey.get(sid)!.push(n); continue; }
    // Everything else in this file reports what it drops; this grouping used to
    // be the one place a node could vanish without a reason. An element whose
    // parent chain never reaches a storey is invisible to the whole traversal,
    // which looks exactly like "the bridge ignores my columns".
    if (EMITTABLE.has(n.type)) skip(n, 'no storey reachable from its parent or its connections');
  }

  for (const storey of storeys) {
    const bottomMm = Number(storey.properties.bottomElevation ?? 0);
    const topMm = Number(storey.properties.topElevation ?? 3000);
    const bandMm = Math.max(0, topMm - bottomMm);
    const floorIndex = floorIndexOf.get(storey.id)!;

    plan.stories.push({
      name: String(storey.name || storey.id),
      level: bottomMm * MM,
      dispOnSections: true,
    });

    const storeyNodes = byStorey.get(storey.id) ?? [];

    // ── Columns: `ax` carrying has_column, plus standalone `column` nodes ──
    for (const n of storeyNodes) {
      const isGridColumn = n.type === 'ax' && flagOn(n.properties.has_column);
      if (!isGridColumn && n.type !== 'column') continue;

      const pos = getNodeBimPos(n, nodeMap);
      const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));
      // CreateColumns takes a rectangular core; a round column becomes its
      // bounding square until we map it onto a circular Favorite.
      if (circular) skip(n, 'circular column emitted as square (no circular param in v1)');

      plan.columns.push({
        coordinates: { x: pos.x * MM, y: pos.y * MM, z: 0 },
        height: bandMm * MM, width: w, depth: d, floorIndex,
      });
    }

    // ── Beams between two column-bearing endpoints ──
    // The has_column gate is deliberate: a plain grid `ax` has no column top to
    // frame into. Same rule as buildFemModel.ts and buildIfcModel.ts.
    for (const n of storeyNodes) {
      if (n.type !== 'beam') continue;
      const ends = getConnectedNodes(n.id, edges, nodeMap).filter(
        (c) => c.type === 'column' || (c.type === 'ax' && flagOn(c.properties.has_column)),
      );
      if (ends.length < 2) { skip(n, 'beam needs 2 column-bearing endpoints'); continue; }

      const a = getNodeBimPos(ends[0], nodeMap);
      const b = getNodeBimPos(ends[1], nodeMap);
      const { bw, bh } = parseBeamDims(String(n.properties.beam_section ?? 'B20x30'));
      plan.beams.push({
        begCoordinate: { x: a.x * MM, y: a.y * MM },
        endCoordinate: { x: b.x * MM, y: b.y * MM },
        // Hang the beam UNDER the storey top, like every 3D viewer does.
        // buildIfcModel puts the axis AT the top, which floats it by its depth.
        zCoordinate: bandMm * MM - bh,
        width: bw, height: bh, floorIndex,
      });
    }

    // ── Walls, their ring beams, and their openings ──
    for (const n of storeyNodes) {
      if (n.type !== 'wall') continue;
      const ends = getConnectedNodes(n.id, edges, nodeMap).filter((c) => c.type === 'ax' || c.type === 'column');
      if (ends.length < 2) { skip(n, 'wall needs 2 ax/column endpoints'); continue; }

      // Endpoint ORDER matters: opening offsets are measured from ends[0], so
      // this must match how collectOpenings' caller sees the wall.
      const [eA, eB] = ends;
      const posA = getNodeBimPos(eA, nodeMap);
      const posB = getNodeBimPos(eB, nodeMap);
      const wallLenMm = Math.hypot(posB.x - posA.x, posB.y - posA.y);
      if (wallLenMm < 1) { skip(n, 'wall shorter than 1 mm'); continue; }

      // A wall carrying a ring beam is shortened to leave room for it.
      const hasBeam = flagOn(n.properties.has_beam);
      const beamDims = parseBeamDims(String(n.properties.beam_section ?? 'B20x30'));
      const beamHMm = hasBeam ? beamDims.bh * 1000 : 0;
      const wallHMm = n.properties.height != null
        ? numProp(n.properties.height, Math.max(0, bandMm - beamHMm))
        : Math.max(0, bandMm - beamHMm);
      if (wallHMm < 1) { skip(n, 'wall height resolves to zero'); continue; }

      const wallIndex = plan.walls.length;
      plan.walls.push({
        begCoordinate: { x: posA.x * MM, y: posA.y * MM },
        endCoordinate: { x: posB.x * MM, y: posB.y * MM },
        zCoordinate: 0,
        height: wallHMm * MM,
        thickness: getNodeWallThickness(n),
        floorIndex,
      });

      // The ring beam itself. buildIfcModel only ever SHORTENS the wall and never
      // emits this, which leaves a visible gap under the slab above.
      if (hasBeam) {
        plan.beams.push({
          begCoordinate: { x: posA.x * MM, y: posA.y * MM },
          endCoordinate: { x: posB.x * MM, y: posB.y * MM },
          zCoordinate: bandMm * MM - beamDims.bh,
          width: beamDims.bw, height: beamDims.bh, floorIndex,
        });
      }

      // Openings. collectOpenings already merges edge-connected window/door
      // nodes with the wall's inline `windows`/`doors` arrays, and expands
      // count/spacing — so one graph node can yield several entries here.
      for (const op of collectOpenings(n, wallLenMm, edges, nodeMap)) {
        const clampedStart = Math.min(Math.max(op.distFromStart, 0), Math.max(0, wallLenMm - op.width));
        const heightMm = Math.min(op.height, Math.max(0, wallHMm - op.sillHeight));
        if (op.width < 1 || heightMm < 1) { skip(op.node, 'opening has zero width or height'); continue; }

        const payload: OpeningPayload = {
          wallIndex,
          // collectOpenings gives the LEFT EDGE; ArchiCAD wants the CENTRE.
          centerOffset: (clampedStart + op.width / 2) * MM,
          sillHeight: op.sillHeight * MM,
          width: op.width * MM,
          height: heightMm * MM,
        };
        if (op.node.type === 'door') plan.doors.push(payload);
        else plan.windows.push(payload);
      }
    }

    // ── Slabs: a `room` (opt-out via has_slab) or a standalone `slab` node ──
    for (const n of storeyNodes) {
      const isRoomSlab = n.type === 'room' && flagNotOff(n.properties.has_slab);
      if (n.type !== 'slab' && !isRoomSlab) continue;

      let poly = calcShellPolygon(n, nodeMap, edges);
      if ((!poly || poly.length < 3) && n.type === 'room') poly = calcRoomPolygon(n, nodeMap, edges);
      if (!poly || poly.length < 3) { skip(n, 'slab has no polygon (needs 3+ anchors)'); continue; }

      // Pull the edge back to the room contour. Negative offsets mean inward,
      // and insetPolygon's own convention is the opposite sign — hence the flip.
      const offsets = parseContourOffsets(n.properties.contour_offset, 0);
      const inward = offsets.map((o) => -o);
      if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);

      const thickness = getNodeSlabThickness(n);
      plan.slabs.push({
        polygonCoordinates: poly.map((p) => ({ x: p.x * MM, y: p.y * MM })),
        // Slabs hang under the storey top, same rule the viewers use.
        level: bandMm * MM - thickness,
        thickness,
        floorIndex,
      });
    }

    // ── Roofs: one ArchiCAD single-plane roof per generated face ──
    for (const n of storeyNodes) {
      if (n.type !== 'roof') continue;
      const { faces } = computeRoofFaces(n, nodes, edges);
      if (!faces.length) { skip(n, 'roof produced no faces'); continue; }

      const coveringMm = numProp(n.properties.covering_thickness_mm, 40);
      let emitted = 0;
      let gableEnds = 0;
      for (const face of faces) {
        // A gable end is a vertical masonry panel closing the attic, not a roof
        // plane; ArchiCAD has no roof for that and a triangular wall is not
        // something CreateWalls can express either.
        if (face.role === 'gable_end') { gableEnds++; continue; }

        const p = roofFaceToPayload(face.vertices);
        if (!p) continue; // degenerate or dead level — a flat roof is a slab

        plan.roofs.push({
          polygonCoordinates: p.poly.map((q) => ({ x: q.x * MM, y: q.y * MM })),
          pivotLine: {
            begCoordinate: { x: p.pivot.beg.x * MM, y: p.pivot.beg.y * MM },
            endCoordinate: { x: p.pivot.end.x * MM, y: p.pivot.end.y * MM },
          },
          angle: p.angleRad,
          level: (p.levelMm - bottomMm) * MM,
          thickness: coveringMm * MM,
          structureType: 'Basic',
          floorIndex,
        });
        emitted++;
      }
      if (!emitted) skip(n, 'no slope faces to emit');
      if (gableEnds) skip(n, `${gableEnds} gable end(s) not emitted — no ArchiCAD roof for a vertical panel`);
    }

    // ── Sweeps ──
    // Tapir exposes no profile parameter and no Morph, so only a rectangle
    // standing square to the guide line survives: it becomes one beam per
    // segment (or a column, for a vertical run). An L, T, U or DXF cornice
    // would have to be faked as its bounding box, which is a different
    // element — it is skipped with that reason instead.
    for (const n of storeyNodes) {
      if (n.type !== 'sweep') continue;
      const res = computeSweep(n, nodeMap, edges);
      const errs = res.diagnostics.filter((d) => d.severity === 'error');
      if (!res.placed || !res.path) {
        skip(n, errs[0]?.message ?? 'sweep did not resolve — check its axes and profile');
        continue;
      }
      const rect = placedRectangle(res.placed);
      if (!rect) {
        skip(n, `profile "${res.profile?.label ?? res.intent.profileId}" is not a rectangle — `
          + 'ArchiCAD beams/columns take width × height only, and no Tapir command '
          + 'carries an arbitrary profile; draw it there as a Morph if you need it');
        continue;
      }

      if (res.path.kind === 'vertical') {
        const p = res.path.points[0];
        plan.columns.push({
          coordinates: {
            x: (p.x + rect.cx) * MM,
            y: (p.y + rect.cy) * MM,
            z: (res.zMinMm - bottomMm) * MM,
          },
          height: (res.zMaxMm - res.zMinMm) * MM,
          width: rect.w * MM, depth: rect.h * MM,
          floorIndex,
        });
        continue;
      }

      if (res.path.kind === 'raked') {
        skip(n, 'the run climbs — a Tapir beam carries one z for the whole span, '
          + 'so the slope is lost and the beam lands level at its start height');
      }
      const segs = sweepSegments(res.path);
      for (const seg of segs) {
        if (seg.lengthMm < 1) continue;
        // Shift the run sideways by the profile's own centre, so the anchor and
        // the lateral offset survive: ArchiCAD centres a beam on its baseline.
        const ox = seg.refDir.x * rect.cx, oy = seg.refDir.y * rect.cx;
        plan.beams.push({
          begCoordinate: { x: (seg.start.x + ox) * MM, y: (seg.start.y + oy) * MM },
          endCoordinate: {
            x: (seg.start.x + seg.axis.x * seg.lengthMm + ox) * MM,
            y: (seg.start.y + seg.axis.y * seg.lengthMm + oy) * MM,
          },
          zCoordinate: (seg.start.z - bottomMm + rect.cy - rect.h / 2) * MM,
          width: rect.w * MM, height: rect.h * MM,
          floorIndex,
        });
      }
      if (segs.length > 1) {
        skip(n, `${segs.length} segments emitted as separate beams — ArchiCAD has no `
          + 'mitred joint here, so the corners overlap inside and notch outside');
      }
    }

    // ── Stairs ──
    for (const n of storeyNodes) {
      if (n.type !== 'stairwell') continue;
      const { geometry } = computeStairGeometry(n, nodes, edges);
      if (!geometry) {
        skip(n, 'stair did not solve — check the storey heights');
        continue;
      }
      // Measured on ArchiCAD 29: CreateStairs refuses an arc-chord baseline
      // whatever the chord length — 18 points and 6 points fail alike with
      // -2130313215. A spiral would need Stair turn-type control Tapir does
      // not expose, so it is skipped with that measured reason.
      if (geometry.spiral) {
        skip(n, 'spiral stair — ArchiCAD\'s CreateStairs refuses an arc-chord '
          + 'baseline (measured on AC29); recreate it manually there if needed');
        continue;
      }
      if (geometry.flights.length === 0) {
        skip(n, 'stair has no straight flight to base the ArchiCAD stair on');
        continue;
      }

      // The baseline is built from FLIGHT ends, not from geometry.baseline:
      // the walking line decorates a winder turn with a point per winder, and
      // segments that short make CreateStairs refuse the whole stair. Flight
      // ends give the same 4-point path a landing turn sends — verified to
      // create — with ArchiCAD deriving its own corner in between.
      const path: Pt2[] = [];
      for (const f of geometry.flights) {
        const s = { x: f.start.x * MM, y: f.start.y * MM };
        const e = { x: f.end.x * MM, y: f.end.y * MM };
        const last = path[path.length - 1];
        if (!last || Math.hypot(last.x - s.x, last.y - s.y) > 1e-9) path.push(s);
        path.push(e);
      }
      plan.stairs.push({
        baseLinePoints: path,
        zCoordinate: geometry.bottomZMm * MM,
        totalHeight: (geometry.topZMm - geometry.bottomZMm) * MM,
        flightWidth: geometry.flights[0].widthMm * MM,
        stepNum: geometry.steps,
        riserHeight: geometry.riserMm * MM,
        treadDepth: geometry.treadMm * MM,
        floorIndex,
      });
    }
  }

  return plan;
}
