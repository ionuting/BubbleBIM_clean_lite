/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * buildIfcModel.ts — converts the FULL bubble-graph (every storey) into a
 * real IFC4 STEP file via `@ifc-lite/create`'s `IfcCreator`.
 *
 * Mirrors the same per-storey node traversal `src/lib/fem/buildFemModel.ts`
 * uses (columns: `ax`+has_column / standalone `column`; beams between column
 * tops; walls between two ax/column endpoints; slabs from a `room`
 * (has_slab-gated) or a standalone `slab` node) — but emits real IFC
 * geometry instead of a physics mesh, and covers every storey in one file
 * (the FEM module deliberately only ever looks at one storey at a time).
 *
 * Coordinates: metres. Each storey is built in LOCAL coordinates (element
 * Z = 0 at the storey floor) — the storey's real elevation is carried by
 * `IfcCreator`'s own `addIfcBuildingStorey({ Elevation })`, exactly like the
 * BIM viewers already separate "storey elevation" from "element-within-
 * storey" position (see bimGeometry.ts's `getStoreyBand`).
 *
 * Scope (v1 spike, same narrowing philosophy as the FEM module):
 *   - Wall JOINS come from `calcWallJoins`, the same solve the 3D viewer and
 *     the floor plan draw: a butt stops the wall at the face it meets, a
 *     mitre grows it to the corner and clips it back to the bisector, a plain
 *     end is inset by the node's own half-size. Walls no longer run
 *     centre-to-centre through one another, and an edge wired to a column's
 *     FACE starts the wall there, as the plan has always shown it.
 *   - A CIRCULAR wall goes out as the arc's own footprint — one arbitrary
 *     profile, the same polygon the viewers extrude — instead of the straight
 *     chord it used to become. It gives up what only a parametric wall has:
 *     its openings are cut as holes but carry no window or door product, and
 *     it takes no ring beam or roof trim, both of which are written along a
 *     straight axis that an arc does not have.
 *   - Wall height DOES account for the ring-beam reduction
 *     (`has_beam`/`beam_section`) the same way `calcWallGeometry` does, since
 *     that's a one-line lookup and matters a lot for a wall not to visually
 *     poke through the slab above it.
 *   - Doors/windows: wall-hosted openings only (`collectOpenings`), via
 *     `addIfcWallDoor`/`addIfcWallWindow`. Standalone door/window nodes not
 *     attached to a wall are not exported.
 *   - No roofs or MEP. Non-convex slabs are fine: `@ifc-lite/create`'s
 *     arbitrary-profile slab handles any simple polygon in one shot.
 *   - Stairs ARE exported, from the stairwell's solved geometry: each straight
 *     flight as a real IfcStair (`addIfcStair` is a straight-run primitive
 *     whose Position is the base of the first riser — exactly the walking-line
 *     convention the solver uses), landings and winder steps as profile slabs
 *     at their levels, and a spiral's pole as a circular column. The base beam
 *     is NOT exported: `addIfcFooting` is axis-aligned, so a rotated stair
 *     would get a mis-oriented footing — worse than none.
 *   - Sweeps ARE exported, one arbitrary-profile extrusion per guide-line
 *     segment. An IFC extrusion has two PARALLEL cap planes, so a mitered
 *     corner cannot be expressed in one solid: the segments overlap on the
 *     inside of a corner and notch on the outside, by at most the profile's
 *     lateral half-width. The entity type follows the node's `ifc_type`
 *     ('auto' → IFCBEAM for a horizontal run, IFCCOLUMN for a vertical one).
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  getNodeBimPos,
  getConnectedNodes,
  parseColumnDims,
  parseBeamDims,
  getNodeWallThickness,
  getNodeSlabThickness,
  calcRoomPolygon,
  calcWallGeometry,
  calcWallJoins,
  collectOpenings,
  getConnectedNodesWithGrips,
  getGripBimPos,
  calcShellPolygon,
  insetPolygon,
  parseContourOffsets,
  MM,
  type WallJoinResult,
} from '@/lib/bimGeometry';
import { BUILTIN_MATERIAL_CONFIG, resolveWindowGlazing, type MaterialConfig } from '@/lib/materialConfig';
import { appearanceOf, applyStyleTransparency, rgbOf } from './ifcAppearance';
import {
  clipElements, profileVoids, replaceFillGeometry, replaceWithMeshes, voidElements,
  type ClipSpec, type FillSpec, type MeshSpec, type ProfileVoidSpec, type Rgb, type Vec3, type VoidSpec,
} from './stepGeometry';
import { ornamentLook, shellOrnaments } from '@/lib/ornament';
import { extrudePolygon3, eyebrowIntentOf, placeEyebrow, type EyebrowNotch, type Tri } from '@/lib/roof/eyebrow';
import { gabletIntentOf, placeGablet } from '@/lib/roof/gablet';
import { ROOF_LINEAR_DETAIL_TYPES, ROOF_ROUND_DETAIL_TYPES, ROOF_SHEET_DETAIL_TYPES } from '@/lib/roof/types';
import { dormerIntentOf, dormerSolids, placeDormer } from '@/lib/roof/dormer';
import { DOOR_TYPE_MAP, WINDOW_TYPE_MAP, isDoubleOpening } from '@/lib/elementLibrary';
import { resolveWallLayers, syntheticWallNodeForLayer } from '@/lib/wallLayers';
import {
  getRoomHeightMm, resolveCoveringLayers, roomHasCovering, syntheticCoveringNodeForLayer,
} from '@/lib/roomCovering';
import { renderBandsOf } from '@/lib/zones/heightZones';
import { parseRoofIntent, parseTimberSection } from '@/lib/roof/solver';
import type { Pt3, RoofFace3D } from '@/lib/roof/types';
import { IfcCreator } from '@ifc-lite/create';
import { writeGeoreference, type GeoReference, type GeorefWriteOptions } from '@/lib/geo/ifcGeoref';
import type { CreateResult } from '@ifc-lite/create';
import { computeRoofFaces } from '@/lib/roof/solver';
import {
  attachHeightAlong, attachesToRoof, isTrimmed, roofTrim, roofTrimsNode, topOutline, trimmedTopAlong,
  type RoofTrim,
} from '@/lib/roof/trim';
import { gableMaterial, gableSpec } from '@/lib/roof/gable';
import { computeStairGeometry } from '@/lib/stair';
import { flightProfile } from '@/lib/stair/profile';
import { computeSweep, ifcTypeForRole, solidTriangles, sweepRole, sweepSegments, triangulateSimple, type SweepSolid } from '@/lib/sweep';
import { computeSketch, placeDirection, placeFn, sketchIfcType } from '@/lib/sketch';
import { addQuantityFormula, encodeStepUnicode } from './stepEncoding';
import { faceArea, facePerimeter } from '@/lib/geom/faceWithHoles';
import { computeDome, domeMemberPieces, domePanelPieces } from '@/lib/dome';
import { computeFacade, facadeMemberPieces, facadeCassettePieces } from '@/lib/facade';

/** The file, plus what the text alone cannot say back. */
export type IfcModelResult = CreateResult & {
  /** Room node id → express id of its IfcSpace. */
  spaceIds: Record<string, number>;
};

export interface IfcModelOptions {
  schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  /**
   * Where the model stands in the world. Given, the file gets IfcSite
   * lat/long/elevation, a TrueNorth on the model context, and (IFC4 and
   * later) IfcMapConversion + IfcProjectedCRS. Omitted, the file is local —
   * exactly what it was before, with every reference slot left empty.
   */
  georeference?: GeoReference | null;
  /** Passed through to IfcProjectedCRS: datum and projection names. */
  georeferenceOptions?: GeorefWriteOptions;
  /**
   * The material settings the viewers draw from. Every element's colour,
   * opacity and IfcMaterial come from here through the same resolver the 3D
   * viewer uses. Omitted, the built-in catalogue applies — so a file built
   * without settings still matches what the viewer shows before they load.
   */
  materialConfig?: MaterialConfig | null;
  /**
   * Geometry of the IFC library elements a window or door type points at
   * (`ifc_path` in the element library), by that path — loaded by the caller,
   * since it comes from the backend. Given, such an opening is written with
   * the library's own body instead of the generic frame and pane.
   */
  libraryParts?: Map<string, LibraryPart[]>;
}

/**
 * One mesh of a library element: triangles in metres in the opening's frame —
 * X along the wall from the opening's centre, Y up from its sill, Z across the
 * wall from the middle of its thickness.
 */
export interface LibraryPart {
  tris: Array<[Vec3, Vec3, Vec3]>;
  rgb: Rgb;
  opacity: number;
}

type Pt = { x: number; y: number };

/** Counter-clockwise, the winding an extruded profile is read in. */
function ccw(poly: Pt[]): Pt[] {
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area2 += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area2 < 0 ? poly.slice().reverse() : poly;
}

/** BIM mm → the metre pairs a profile takes. */
const toM = (poly: Pt[]): Array<[number, number]> => poly.map((p) => [p.x * MM, p.y * MM]);

/**
 * The contour offset the 3D viewer applies to a plan polygon before drawing
 * it (negative = inward; the default is 125 mm in). Applied here for the
 * same reason: a slab that is 250 mm wider in the file than on screen is a
 * different slab.
 */
function withContourOffset(poly: Pt[], raw: unknown): Pt[] {
  const inward = parseContourOffsets(raw).map((o) => -o);
  return inward.some((o) => o !== 0) ? insetPolygon(poly, inward) : poly;
}

/**
 * A ring — the plan polygon inset once for the outer face and once more by
 * the thickness for the inner — as one mitred quad per edge. An arbitrary
 * profile in `@ifc-lite/create` has an outer curve and nothing else, so a
 * ring cannot be one solid; per-edge quads keep the corners mitred exactly
 * as `insetPolygon` cuts them and give each side its own pickable product.
 */
function ringSegments(poly: Pt[], offsets: number[], thickMm: number): Pt[][] {
  if (poly.length < 3 || !(thickMm > 0)) return [];
  const inward = offsets.map((o) => -o);
  const outer = insetPolygon(poly, inward);
  const inner = insetPolygon(poly, inward.map((v) => v + thickMm));
  if (outer.length !== inner.length || outer.length < 3) return [];
  return outer.map((_, i) => {
    const j = (i + 1) % outer.length;
    return ccw([outer[i], outer[j], inner[j], inner[i]]);
  });
}

const toRgb = ([r, g, b]: [number, number, number]): Rgb => ({ r, g, b });

/** A wall opening in plan, for cutting the rings that run past it. BIM mm. */
interface WallOpening {
  x: number; y: number;          // centre of the opening on the wall axis
  ux: number; uy: number;        // along the wall
  widthMm: number; wallThickMm: number;
  widthM: number; heightM: number; sillM: number;
  name: string;
}

/**
 * A ring segment measured in its own frame: where it is, which way it runs,
 * and how far it reaches along and across that direction.
 *
 * Measured FROM THE QUAD, never from the polygon it came from. `insetPolygon`
 * returns vertex `i` as the intersection of edge-lines `i` and `i+1` — that is,
 * the offset of the ORIGINAL vertex `i+1` — so a segment's index does not name
 * the polygon edge it covers. Assuming it did put the south facade's windows
 * on the east facade's segment, where they cut nothing at all and the export
 * came out with a blank envelope over every opening.
 */
export interface SegmentFrame {
  cx: number; cy: number;      // centroid, BIM mm
  dx: number; dy: number;      // unit vector along the segment
  halfLen: number; halfThick: number;
}

export function segmentFrame(quad: Pt[]): SegmentFrame | null {
  if (quad.length < 3) return null;
  const cx = quad.reduce((s, p) => s + p.x, 0) / quad.length;
  const cy = quad.reduce((s, p) => s + p.y, 0) / quad.length;
  // The longest edge is the one running along the wall; a ring segment is a
  // long thin quad, so this is unambiguous for anything worth cutting.
  let dx = 0, dy = 0, best = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i], b = quad[(i + 1) % quad.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best) { best = len; dx = (b.x - a.x) / len; dy = (b.y - a.y) / len; }
  }
  if (best < 1) return null;
  let halfLen = 0, halfThick = 0;
  for (const p of quad) {
    halfLen = Math.max(halfLen, Math.abs((p.x - cx) * dx + (p.y - cy) * dy));
    halfThick = Math.max(halfThick, Math.abs((p.x - cx) * dy - (p.y - cy) * dx));
  }
  return { cx, cy, dx, dy, halfLen, halfThick };
}

/** How parallel a wall must be to a segment for its opening to show through it. */
const PARALLEL_DOT = 0.7;
/** Slack past the segment, so the cut clears its faces. BIM mm. */
const CUT_MARGIN_MM = 50;

/**
 * Which ring segments a storey's wall openings pass through, and the cut to
 * make in each. The 3D viewer runs every opening cutter against every ring;
 * this asks the same question geometrically, per segment: does the wall run
 * along this segment, does the opening fall within its length, is it close
 * enough across, and do the two overlap in height. The cut is centred on the
 * wall axis and deep enough to pass clean through the segment.
 */
function ringVoids(
  quads: Pt[][], segmentIds: number[], openings: WallOpening[],
  fromM: number, heightM: number, offsets: number[], thickMm: number,
): VoidSpec[] {
  const out: VoidSpec[] = [];
  // How far the ring may stand from the wall it wraps: its own declared
  // contour offset plus its thickness. A ventilated facade sits well clear of
  // the wall, so a fixed tolerance would quietly stop cutting the moment
  // someone pushed the envelope out.
  const standOff = offsets.reduce((m, o) => Math.max(m, Math.abs(o)), 0) + thickMm;
  for (let i = 0; i < segmentIds.length; i++) {
    const f = segmentFrame(quads[i]);
    if (!f) continue;
    for (const o of openings) {
      // A wall meeting the facade at an angle does not show through it.
      if (Math.abs(o.ux * f.dx + o.uy * f.dy) < PARALLEL_DOT) continue;
      const rx = o.x - f.cx, ry = o.y - f.cy;
      const along = rx * f.dx + ry * f.dy;
      const across = rx * f.dy - ry * f.dx;
      if (Math.abs(along) > f.halfLen + o.widthMm / 2) continue;
      if (Math.abs(across) > f.halfThick + standOff + o.wallThickMm / 2 + CUT_MARGIN_MM) continue;
      if (o.sillM + o.heightM <= fromM || o.sillM >= fromM + heightM) continue;
      // Deep enough to reach the far face of the segment from the wall axis,
      // and centred on that axis, so it cuts whichever side the segment is on.
      const reach = Math.abs(across) + f.halfThick + CUT_MARGIN_MM;
      const nx = o.uy, ny = -o.ux;
      out.push({
        hostId: segmentIds[i],
        name: `${o.name} opening`,
        location: [(o.x - nx * reach) * MM, (o.y - ny * reach) * MM, o.sillM - fromM],
        axis: [nx, ny, 0],
        refDirection: [o.ux, o.uy, 0],
        width: o.widthM, height: o.heightM, depth: 2 * reach * MM,
      });
    }
  }
  return out;
}

/**
 * Where a wall's two ends really are, and how the corners are cut.
 *
 * `calcWallJoins` already solves every junction in the plan — it is what the
 * 3D viewer and the floor plan draw — and the export used to ignore it, so
 * every wall ran from axis-node centre to axis-node centre. The two join kinds
 * it resolves need different answers here:
 *
 *   • a BUTT trims the centre-line, so it is simply where the wall starts and
 *     stops; a stem that ran on to the node centre buried half its length in
 *     the wall it meets, and now it stops at that wall's face;
 *   • a SQUARE_OFF end is the same kind of answer — the endpoint inset by the
 *     node's own half-size, so a wall ending on a column stops at its face;
 *   • a MITRE cuts the corner off at an angle. `addIfcWall` sweeps a
 *     rectangle, because a parametric wall is the only host
 *     `IfcOpeningElement` accepts, so the true quadrilateral footprint is not
 *     available to us — the mitre line becomes a clipping plane instead, which
 *     is IFC's own way of saying it and costs the wall nothing. A clip can
 *     only take material away, so a mitred end first grows PAST its node to
 *     where the cut reaches, then is cut back.
 *
 * Local frame as `addIfcWall` lays it out: origin at the wall's own start, X
 * toward its end, Y = Z × X. Metres out, BIM mm in.
 */
export interface WallEnds {
  /**
   * Where each end sits relative to its axis node, signed along the wall's
   * own direction. BIM mm.
   *
   * Negative at the start (and positive at the end) lengthens the wall — a
   * mitre reaching past its node. The other sign shortens it — a butt.
   */
  startOffMm: number;
  endOffMm: number;
  /** The mitre cutting planes, in the local frame of the adjusted wall. */
  planes: Array<{ location: Vec3; normal: Vec3 }>;
}

function wallEnds(
  posA: Pt, posB: Pt, lenMm: number, join: WallJoinResult | undefined,
): WallEnds {
  const none: WallEnds = { startOffMm: 0, endOffMm: 0, planes: [] };
  if (!join || !(lenMm > 1e-6)) return none;
  const ux = (posB.x - posA.x) / lenMm, uy = (posB.y - posA.y) / lenMm;
  const nx = -uy, ny = ux;
  const toLocal = (p: Pt): Pt => ({
    x: ((p.x - posA.x) * ux + (p.y - posA.y) * uy) * MM,
    y: ((p.x - posA.x) * nx + (p.y - posA.y) * ny) * MM,
  });

  // The join's "start" need not be ours: it orders a wall's endpoints from
  // `getConnectedNodesWithGrips`, this loop from `getConnectedNodes`, and the
  // two filter differently. Match by position, the way calcWallGeometry does.
  const toA = Math.hypot(join.startPt.x - posA.x, join.startPt.y - posA.y);
  const toB = Math.hypot(join.startPt.x - posB.x, join.startPt.y - posB.y);
  const flip = toB < toA;

  const ends = [
    // Our start: the material a mitre drops lies back along −X.
    {
      kind: flip ? join.endJoin : join.startJoin,
      centre: flip ? join.endPt : join.startPt,
      outer: flip ? join.outerEndPt : join.outerStartPt,
      inner: flip ? join.innerEndPt : join.innerStartPt,
      sign: -1,
      /** Where this end sits on the local axis before any adjustment. */
      base: 0,
    },
    {
      kind: flip ? join.startJoin : join.endJoin,
      centre: flip ? join.startPt : join.endPt,
      outer: flip ? join.outerStartPt : join.outerEndPt,
      inner: flip ? join.innerStartPt : join.innerEndPt,
      sign: 1,
      base: lenMm * MM,
    },
  ];

  // First pass: everything measured in the UNADJUSTED frame.
  const raw: Array<{ location: Vec3; normal: Vec3 }> = [];
  const offM = [0, 0];

  ends.forEach((e, i) => {
    if (e.kind !== 'miter') {
      // Butt, square_off and none all resolve to a centre-line point, and it
      // lies on the axis by construction — projecting it loses nothing.
      //
      // For a butt that point is the face the wall stops against. For a
      // square_off it is the endpoint INSET by the node's own half-size:
      // a wall ending on a C30x30 column stops at the column's face, 150 mm
      // short of its centre, which is where the 3D viewer and the plan have
      // always drawn it. The export used to run to the centre and bury that
      // much of every wall inside its end column.
      offM[i] = toLocal(e.centre).x - e.base;
      return;
    }
    const a = toLocal(e.outer), b = toLocal(e.inner);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-9)) return;
    // Perpendicular to the cut, turned to face the end being trimmed.
    let mx = -dy / len, my = dx / len;
    if (mx * e.sign < 0) { mx = -mx; my = -my; }
    // A cut running along the wall would take all of it or none; that is a
    // degenerate join, not a mitre.
    if (Math.abs(mx) < 1e-6) return;
    // Grow to wherever the cut reaches, never the other way — a mitre that
    // falls inside the span still needs the full box to cut from.
    offM[i] = e.sign < 0
      ? Math.min(0, Math.min(a.x, b.x))
      : Math.max(0, Math.max(a.x, b.x) - e.base);
    raw.push({
      location: [(a.x + b.x) / 2, (a.y + b.y) / 2, 0],
      normal: [mx, my, 0],
    });
  });

  // A wall trimmed at both ends by more than its own length has no junction
  // left to draw; leave it as the graph put it rather than turn it inside out.
  if (lenMm * MM - offM[0] + offM[1] < 1e-6) return none;

  // Second pass: the wall now starts `offM[0]` further along, so every plane
  // slides the opposite way with it.
  return {
    startOffMm: offM[0] / MM,
    endOffMm: offM[1] / MM,
    planes: raw.map((p) => ({
      location: [p.location[0] - offM[0], p.location[1], p.location[2]] as Vec3,
      normal: p.normal,
    })),
  };
}

/** Is this wall drawn as an arc rather than a straight run? */
function isCircularWall(n: BubbleGraphNode): boolean {
  return n.properties.is_circular === 'True' || n.properties.is_circular === true;
}

/** One roof face as an extrusion frame: the face is the covering's TOP surface. */
interface FaceFrame {
  location: [number, number, number];
  axis: [number, number, number];
  refDirection: [number, number, number];
  profile: Array<[number, number]>;
}

/**
 * Local frame for a planar face: origin at its first vertex, X along its
 * first edge, Z pointing DOWN through the covering so the extrusion hangs
 * below the surface the solver placed. Y = Z × X keeps the frame right-handed,
 * and the profile is the face projected onto (X, Y). Null for a face too
 * degenerate to carry a normal.
 */
function roofFaceFrame(vertices: Pt3[], bottomMm: number): FaceFrame | null {
  if (vertices.length < 3) return null;
  // Newell's normal: exact for a polygon, tolerant of a slightly bent one.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-9) return null;
  // Outward is up: a slope's visible side faces the sky.
  const s = nz < 0 ? -1 : 1;
  const n = { x: (s * nx) / nl, y: (s * ny) / nl, z: (s * nz) / nl };

  const v0 = vertices[0];
  let x: Pt3 | null = null;
  for (let i = 1; i < vertices.length && !x; i++) {
    const d = { x: vertices[i].x - v0.x, y: vertices[i].y - v0.y, z: vertices[i].z - v0.z };
    const along = d.x * n.x + d.y * n.y + d.z * n.z;
    const t = { x: d.x - n.x * along, y: d.y - n.y * along, z: d.z - n.z * along };
    const tl = Math.hypot(t.x, t.y, t.z);
    if (tl > 1e-6) x = { x: t.x / tl, y: t.y / tl, z: t.z / tl };
  }
  if (!x) return null;

  const axis = { x: -n.x, y: -n.y, z: -n.z };
  const y = {
    x: axis.y * x.z - axis.z * x.y,
    y: axis.z * x.x - axis.x * x.z,
    z: axis.x * x.y - axis.y * x.x,
  };
  const profile = ccw(vertices.map((p) => {
    const d = { x: p.x - v0.x, y: p.y - v0.y, z: p.z - v0.z };
    return { x: d.x * x.x + d.y * x.y + d.z * x.z, y: d.x * y.x + d.y * y.y + d.z * y.z };
  }));
  return {
    location: [v0.x * MM, v0.y * MM, (v0.z - bottomMm) * MM],
    axis: [axis.x, axis.y, axis.z],
    refDirection: [x.x, x.y, x.z],
    profile: toM(profile),
  };
}

/** A swept body's closed triangles (BIM mm), exactly as the 3D view meshes it. */
function sweepTriangles(solids: SweepSolid[], placed: Array<{ x: number; y: number }>): Tri[] {
  const placedTris = triangulateSimple(placed);
  if (!placedTris.length) return [];
  return solids.flatMap((solid) => solidTriangles(solid, placedTris) as Tri[]);
}

/** Triangles from BIM mm to the storey's frame in metres, for `replaceWithMeshes`. */
function toLocalTris(tris: Tri[], bottomMm: number): Array<[[number, number, number], [number, number, number], [number, number, number]]> {
  return tris.map((t) => t.map((q): [number, number, number] => [q.x * MM, q.y * MM, (q.z - bottomMm) * MM]) as [[number, number, number], [number, number, number], [number, number, number]]);
}

/** An element whose body `replaceWithMeshes` will write: a stand-in at the storey origin. */
function placeholderElement(creator: IfcCreator, storeyId: number, ifcType: string, name: string | undefined, tag: string): number {
  return creator.addElement(storeyId, {
    IfcType: ifcType,
    Placement: { Location: [0, 0, 0], Axis: [0, 0, 1], RefDirection: [1, 0, 0] },
    Profile: { ProfileType: 'AREA', OuterCurve: [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]] },
    Depth: 0.01,
    Name: name, Tag: tag,
  });
}

/** The roof solver's framing members — the same set the 3D view draws as timber. */
const ROOF_TIMBER_TYPES = new Set([
  'rafter', 'hip_rafter', 'valley_rafter', 'ridge_beam', 'wall_plate', 'post', 'purlin', 'tie_beam', 'collar_tie',
]);

/**
 * The frame of a straight member from `a` to `b` (BIM mm): extruded along the
 * member, its section's X kept horizontal (across it), so a rafter's depth
 * stands upright the way it is built. A vertical member takes world X.
 */
function memberFrame(a: Pt3, b: Pt3): { axis: [number, number, number]; ref: [number, number, number]; lengthMm: number } | null {
  if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return null;
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const L = Math.hypot(d.x, d.y, d.z);
  if (L < 1) return null;
  const axis: [number, number, number] = [d.x / L, d.y / L, d.z / L];
  const h = Math.hypot(axis[0], axis[1]);
  const ref: [number, number, number] = h < 1e-6 ? [1, 0, 0] : [-axis[1] / h, axis[0] / h, 0];
  return { axis, ref, lengthMm: L };
}

/** `undefined` for an empty/whitespace name so `@ifc-lite/create` falls back to its own default label. */
function nameOf(n: BubbleGraphNode): string | undefined {
  const t = n.name?.trim();
  return t ? t : undefined;
}

/**
 * The base-quantity set name for a class — `IFCSLAB` → `Qto_SlabBaseQuantities`.
 * Classes arrive upper-cased (`sketchIfcType`), so the spelling IFC4 gives
 * each set is looked up; a class without a standard set gets a named one.
 */
const QTO_NAMES: Record<string, string> = {
  IFCBEAM: 'Qto_BeamBaseQuantities',
  IFCBUILDINGELEMENTPROXY: 'Qto_BuildingElementProxyQuantities',
  IFCCOLUMN: 'Qto_ColumnBaseQuantities',
  IFCCOVERING: 'Qto_CoveringBaseQuantities',
  IFCCURTAINWALL: 'Qto_CurtainWallQuantities',
  IFCFOOTING: 'Qto_FootingBaseQuantities',
  IFCMEMBER: 'Qto_MemberBaseQuantities',
  IFCPLATE: 'Qto_PlateBaseQuantities',
  IFCRAILING: 'Qto_RailingBaseQuantities',
  IFCSLAB: 'Qto_SlabBaseQuantities',
  IFCWALL: 'Qto_WallBaseQuantities',
};
function qtoName(ifcType: string): string {
  return QTO_NAMES[ifcType.toUpperCase()] ?? 'Qto_BubbleBIM_SketchQuantities';
}

/** The plan rectangle of a wall from its axis and thickness (BIM mm). */
function wallFootprintMm(
  a: { x: number; y: number },
  b: { x: number; y: number },
  thicknessMm: number,
): Array<{ x: number; y: number }> {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * thicknessMm / 2, ny = dx / len * thicknessMm / 2;
  return [
    { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny },
  ];
}

export function buildIfcModel(
  allNodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  projectName: string,
  options: IfcModelOptions = {},
): IfcModelResult {
  const creator = new IfcCreator({ Name: projectName, Schema: options.schema ?? 'IFC4' });
  // Room node id → its IfcSpace's express id. ifc-lite writes no Tag on a
  // space, so this is the only way back from a room to its space — which the
  // space-boundary writer needs (lib/ifc/spaceBoundaries.ts).
  const spaceIds: Record<string, number> = {};
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  // ── Appearance ─────────────────────────────────────────────────────────────
  // Colour and material from the same settings the viewers draw from, through
  // the same resolver, so the file shows what the screen showed. Opacity is
  // collected per style and written into the text after the library is done,
  // because its own surface style is always opaque.
  const config = options.materialConfig ?? BUILTIN_MATERIAL_CONFIG;
  const opacityByStyle = new Map<string, number>();
  const paint = (
    elementId: number,
    node: BubbleGraphNode,
    resolveAs?: string,
    opts: { material?: boolean } = {},
  ) => {
    const a = appearanceOf(node, config, resolveAs);
    creator.setColor(elementId, a.styleName, a.rgb);
    if (a.opacity < 1) opacityByStyle.set(a.styleName, a.opacity);
    if (opts.material !== false && a.materialName) {
      creator.addIfcMaterial(elementId, { Name: a.materialName, Category: a.materialCategory });
    }
  };
  // Written into the text after the library is done — see stepGeometry.ts.
  const fills: FillSpec[] = [];
  // Bodies no extrusion can make (the eyebrow dormer), written as B-reps after.
  const meshSpecs: MeshSpec[] = [];
  // Each slope as written (its element and local frame), and the holes the
  // dormers want in them — matched up once every storey is done.
  const roofFaceElements = new Map<string, { id: number; origin: Vec3; x: Vec3; y: Vec3; z: Vec3 }>();
  const pendingNotches: Array<{ key: string; notch: EyebrowNotch; name: string }> = [];
  const clips: ClipSpec[] = [];
  // Every junction in the graph, solved once. The same map the 3D viewer and
  // the floor plan are drawn from, so a corner cannot come out of the export
  // differently from the way it is on screen.
  const wallJoins = calcWallJoins(allNodes, edges);
  const voids: VoidSpec[] = [];
  // Faces with holes: ifc-lite writes outer curves only, the holes go in after.
  const profileHoleSpecs: ProfileVoidSpec[] = [];
  const glazing = resolveWindowGlazing(config);

  const storeys = allNodes
    .filter((n) => n.type === 'storey')
    .slice()
    .sort((a, b) => Number(a.properties.bottomElevation ?? 0) - Number(b.properties.bottomElevation ?? 0));

  // Roof trim planes, built once: a roof sits on its own storey but cuts walls
  // on the ones below, so this cannot live inside the storey loop.
  const roofTrims: RoofTrim[] = [];
  const roofFacesById = new Map<string, RoofFace3D[]>();
  for (const rn of allNodes) {
    if (rn.type !== 'roof') continue;
    const faces = computeRoofFaces(rn, allNodes, edges).faces;
    roofFacesById.set(rn.id, faces);
    const t = roofTrim(rn, faces);
    if (t) roofTrims.push(t);
  }

  for (const storey of storeys) {
    const bottomMm = Number(storey.properties.bottomElevation ?? 0);
    const topMm = Number(storey.properties.topElevation ?? 3000);
    const heightM = Math.max(0, (topMm - bottomMm) * MM);

    const storeyId = creator.addIfcBuildingStorey({
      Name: nameOf(storey) ?? storey.id,
      Elevation: bottomMm * MM,
    });

    const storeyNodes = allNodes.filter((n) => n.parentId === storey.id);
    // Every wall opening on this storey, for the rings written further down.
    const storeyOpenings: WallOpening[] = [];

    // ── Columns: `ax` nodes with has_column: true, and standalone `column` nodes ──
    for (const n of storeyNodes) {
      const isGridColumn = n.type === 'ax' && String(n.properties.has_column ?? '').toLowerCase() === 'true';
      const isStandaloneColumn = n.type === 'column';
      if (!isGridColumn && !isStandaloneColumn) continue;

      const pos = getNodeBimPos(n, nodeMap);
      const x = pos.x * MM, y = pos.y * MM;
      const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));

      const columnId = circular
        ? creator.addIfcCircularColumn(storeyId, {
          Position: [x, y, 0], Radius: w / 2, Height: heightM,
          Name: nameOf(n), Tag: n.id,
        })
        : creator.addIfcColumn(storeyId, {
          Position: [x, y, 0], Width: w, Depth: d, Height: heightM,
          Name: nameOf(n), Tag: n.id,
        });
      paint(columnId, n, 'column');
    }

    // ── Beams: connect the TOP of two column-bearing endpoints. Unlike walls
    //    (any ax/column endpoint), a beam needs an actual column at both ends —
    //    same has_column gate buildFemModel.ts uses (its gotcha #5): an `ax`
    //    node that's merely part of the axis grid has no "top" to frame into. ──
    for (const n of storeyNodes) {
      if (n.type !== 'beam') continue;
      const ends = getConnectedNodes(n.id, edges, nodeMap).filter((c) =>
        c.type === 'column' || (c.type === 'ax' && String(c.properties.has_column ?? '').toLowerCase() === 'true'));
      if (ends.length < 2) continue;

      const posA = getNodeBimPos(ends[0], nodeMap);
      const posB = getNodeBimPos(ends[1], nodeMap);
      const { bw, bh } = parseBeamDims(String(n.properties.beam_section ?? 'B20x30'));
      // Start/End are the SECTION CENTRE. The 3D viewer hangs the beam from
      // the storey top (its base at top − height); putting the centre on the
      // storey top, as this once did, left half the beam above the slab.
      const zC = heightM - bh / 2;
      const beamId = creator.addIfcBeam(storeyId, {
        Start: [posA.x * MM, posA.y * MM, zC],
        End: [posB.x * MM, posB.y * MM, zC],
        Width: bw, Height: bh,
        Name: nameOf(n), Tag: n.id,
      });
      paint(beamId, n, 'beam');
    }

    /**
     * A curved wall, as the one solid its plan footprint describes.
     *
     * `addIfcWall` sweeps a rectangle between two points, so an arc has never
     * fitted it: the export drew the CHORD, a straight wall where a curved one
     * stands. `calcCircularWallGeometry` already tessellates the arc into the
     * closed polygon the 3D viewers and the plan extrude — outer arc out,
     * inner arc back — so that same polygon goes out here as an arbitrary
     * profile, and the geometry finally matches the screen.
     *
     * The cost of leaving the parametric wall behind is its openings: only
     * `addIfcWall` can host `addIfcWallWindow`. The holes are still cut, as
     * real IfcOpeningElements through `voidElements` — the same path the
     * envelope rings use — but nothing is fitted INTO them, so a curved wall
     * exports with its window holes and no window products. A ring beam and a
     * roof trim are skipped for the same reason: both are written along a
     * straight axis, and on an arc that axis does not exist.
     */
    const emitCircularWall = (n: BubbleGraphNode): void => {
      const geo = calcWallGeometry(n, nodeMap, edges, wallJoins);
      if (!geo || geo.footprint.length < 3 || geo.wallH * MM < 0.001) return;

      const wallId = creator.addElement(storeyId, {
        IfcType: 'IFCWALL',
        Placement: { Location: [0, 0, 0] },
        Profile: { ProfileType: 'AREA', OuterCurve: toM(ccw(geo.footprint)) },
        Depth: geo.wallH * MM,
        Name: nameOf(n), Tag: n.id,
      });

      const bands = resolveWallLayers(n.properties, geo.wallH);
      const band = bands.length ? bands.reduce((a, b) => (b.heightMm > a.heightMm ? b : a)) : null;
      paint(wallId, band ? syntheticWallNodeForLayer(n, band) : n, 'wall');

      // The opening descriptors are in the viewers' frame (x east, z = −north,
      // metres); the file wants BIM mm with y north. `sill` is already
      // measured from the storey floor, which is where this wall's placement
      // sits, so it needs no shifting.
      const thicknessMm = getNodeWallThickness(n) * 1000;
      const reachMm = thicknessMm / 2 + CUT_MARGIN_MM;
      for (const op of geo.openings) {
        const bx = op.cx / MM, by = -op.cz / MM;
        const tx = op.ux, ty = -op.uz;
        const vx = op.nx, vy = -op.nz;
        const label = nameOf(op.node) ?? op.node.type;
        voids.push({
          hostId: wallId,
          name: label,
          location: [(bx - vx * reachMm) * MM, (by - vy * reachMm) * MM, op.sill],
          axis: [vx, vy, 0],
          refDirection: [tx, ty, 0],
          width: op.oW, height: op.oH, depth: 2 * reachMm * MM,
        });
        // The envelope has to know about them too, or a ring outside a curved
        // wall plasters over its windows.
        storeyOpenings.push({
          x: bx, y: by, ux: tx, uy: ty,
          widthMm: op.oW / MM, wallThickMm: thicknessMm,
          widthM: op.oW, heightM: op.oH, sillM: op.sill,
          name: label,
        });
      }
    };

    // ── Walls: between two ax/column endpoints, with ring-beam height reduction
    //    and door/window openings hosted via addIfcWallDoor/addIfcWallWindow ──
    for (const n of storeyNodes) {
      if (n.type !== 'wall') continue;
      // With grips, because an edge may be wired to a column's FACE rather
      // than its centre, and then that face is where the wall starts. The
      // plan and the 3D view have always read the grip; the export read the
      // node and put such a wall half a column off.
      const ends = getConnectedNodesWithGrips(n.id, edges, nodeMap)
        .filter(({ node: c }) => c.type === 'ax' || c.type === 'column');
      if (ends.length < 2) continue;
      const [eA, eB] = ends;

      const rawA = getGripBimPos(eA.node, eA.gripIdx, nodeMap);
      const rawB = getGripBimPos(eB.node, eB.gripIdx, nodeMap);
      const rawLenMm = Math.hypot(rawB.x - rawA.x, rawB.y - rawA.y);

      // ── A circular wall is not a box, so none of what follows fits it ────
      if (isCircularWall(n)) {
        emitCircularWall(n);
        continue;
      }
      if (rawLenMm < 1) continue;

      // The junctions, as the plan and the 3D view already resolve them: a
      // butt stops the wall at the face it meets, a mitre grows it to where
      // the cut reaches so the corner can then be cut back to the bisector.
      const join = wallEnds(rawA, rawB, rawLenMm, wallJoins.get(n.id));
      const uxA = (rawB.x - rawA.x) / rawLenMm, uyA = (rawB.y - rawA.y) / rawLenMm;
      const posA: Pt = {
        x: rawA.x + uxA * join.startOffMm,
        y: rawA.y + uyA * join.startOffMm,
      };
      const posB: Pt = {
        x: rawB.x + uxA * join.endOffMm,
        y: rawB.y + uyA * join.endOffMm,
      };
      const wallLenMm = rawLenMm - join.startOffMm + join.endOffMm;
      if (wallLenMm < 1) continue;

      const thickness = getNodeWallThickness(n);

      // Ring-beam height reduction — same rule as calcWallGeometry, so a wall doesn't
      // visually overlap the beam that sits above it when has_beam is set.
      const hasBeam = String(n.properties.has_beam ?? '').toLowerCase() === 'true';
      const beamHMm = hasBeam ? parseBeamDims(String(n.properties.beam_section ?? 'B20x30')).bh * 1000 : 0;
      const wallHMm = n.properties.height != null
        ? Number(n.properties.height)
        : Math.max(0, topMm - bottomMm - beamHMm);
      if (wallHMm * MM < 0.001) continue;

      // ── Roof trim ─────────────────────────────────────────────────────────
      //
      // A wall cut by a roof leaves IFC with a choice: `addIfcWall` is
      // parametric (a rectangle swept up) and is the only thing that can host
      // `IfcOpeningElement`s, but it cannot express a sloping top. So the wall
      // goes out in two parts — the plain box up to the LOWEST point of the
      // trimmed top, carrying every door and window as before, and above it the
      // gable as its own IFCWALL whose profile is the wall's elevation swept
      // through its thickness. A wall the roof does not reach takes neither
      // branch and is written exactly as it was.
      const thicknessMm = thickness * 1000;
      const planes = roofTrims
        .filter((t) => roofTrimsNode(t, n, wallFootprintMm(posA, posB, thicknessMm)))
        .flatMap((t) => t.planes);

      let topAbsMm = bottomMm + wallHMm;
      if (planes.length > 0 && attachesToRoof(n)) {
        const reach = attachHeightAlong(planes, posA, posB);
        if (reach != null && reach > topAbsMm) topAbsMm = reach;
      }
      const segs = planes.length > 0 ? trimmedTopAlong(planes, posA, posB, topAbsMm) : null;
      const trimmed = !!segs && isTrimmed(segs, topAbsMm);
      const boxTopAbsMm = trimmed
        ? Math.min(...segs.flatMap((s) => [s.z0, s.z1]))
        : topAbsMm;
      const boxHMm = boxTopAbsMm - bottomMm;
      if (boxHMm * MM < 0.001) continue;

      const wallId = creator.addIfcWall(storeyId, {
        Start: [posA.x * MM, posA.y * MM, 0],
        End: [posB.x * MM, posB.y * MM, 0],
        Thickness: thickness, Height: boxHMm * MM,
        Name: nameOf(n), Tag: n.id,
      });

      for (const c of join.planes) clips.push({ hostId: wallId, ...c });

      // Colour and material from the wall's own bands, as the 3D viewer
      // paints them; the tallest band is most of what you see. The solid
      // stays one box — a band is a finish zone, not a second wall.
      const bands = resolveWallLayers(n.properties, wallHMm);
      const band = bands.length ? bands.reduce((a, b) => (b.heightMm > a.heightMm ? b : a)) : null;
      paint(wallId, band ? syntheticWallNodeForLayer(n, band) : n, 'wall');

      // The ring beam the wall was shortened for. It is drawn in 3D and was
      // never written here, so the file had a gap where the beam belongs.
      if (hasBeam && beamHMm > 0) {
        const { bw, bh } = parseBeamDims(String(n.properties.beam_section ?? 'B20x30'));
        const zC = heightM - bh / 2;
        const ringId = creator.addIfcBeam(storeyId, {
          Start: [posA.x * MM, posA.y * MM, zC],
          End: [posB.x * MM, posB.y * MM, zC],
          Width: bw, Height: bh,
          Name: nameOf(n) ? `${nameOf(n)} (beam)` : 'Ring beam', Tag: `${n.id}:beam`,
        });
        // Its own material, and none of the wall's colour overrides.
        paint(ringId, { ...n, properties: { material: String(n.properties.beam_material ?? '') } }, 'beam');
      }

      if (trimmed) {
        // The gable may be its own construction — thinner, in another material,
        // and sitting off the wall axis. `Depth` carries the thickness and the
        // placement carries the offset; a wall nobody configured resolves to the
        // wall's own thickness and a zero offset, so the output is unchanged.
        const spec = gableSpec(n, thicknessMm);

        // Local frame: X along the wall, Z the wall normal, so Y = Z × X points
        // up and the profile is drawn straight in elevation.
        const ux = (posB.x - posA.x) / wallLenMm, uy = (posB.y - posA.y) / wallLenMm;
        const nx = uy, ny = -ux;
        const outline = topOutline(segs);
        const profile: Array<[number, number]> = [
          [0, 0], [wallLenMm * MM, 0],
          ...[...outline].reverse().map((p): [number, number] =>
            [p.t * wallLenMm * MM, (p.z - boxTopAbsMm) * MM]),
        ];
        // A sliver thinner than a millimetre is rounding, not a gable.
        if (Math.max(...profile.map((p) => p[1])) * 1000 > 1) {
          // The solid is swept from the placement along +Z (the wall normal),
          // so it starts half a thickness back from the gable's own centre-line.
          const backMm = spec.offsetMm - spec.thicknessMm / 2;
          const gableId = creator.addElement(storeyId, {
            IfcType: 'IFCWALL',
            Placement: {
              Location: [
                (posA.x + nx * backMm) * MM,
                (posA.y + ny * backMm) * MM,
                boxHMm * MM,
              ],
              Axis: [nx, ny, 0],
              RefDirection: [ux, uy, 0],
            },
            Profile: { ProfileType: 'AREA', OuterCurve: profile },
            Depth: spec.thicknessMm * MM,
            Name: nameOf(n) ? `${nameOf(n)} (gable)` : 'Wall (gable)',
            Tag: `${n.id}:gable`,
          });
          // Only when the gable names its own material: writing the wall's here
          // too would give every wall in every existing model a material it
          // never had.
          if (spec.material) {
            creator.addIfcMaterial(gableId, { Name: gableMaterial(n, spec), Category: 'Gable' });
          }
          paint(gableId, spec.material
            ? { ...n, properties: { ...n.properties, material: gableMaterial(n, spec) } }
            : n, 'wall', { material: false });
        }
      }

      // Openings are spaced along the wall the user drew, not the mitred
      // extension of it, so they are collected over the RAW span and then
      // slid by however much the wall grew at its start.
      const openingInfos = collectOpenings(n, rawLenMm, edges, nodeMap);
      const wx = (posB.x - posA.x) / wallLenMm, wy = (posB.y - posA.y) / wallLenMm;
      for (const op of openingInfos) {
        // Clamp so a mis-measured opening from a formula edge case can't land outside the wall solid.
        const along = (Math.min(Math.max(op.distFromStart, 0), Math.max(0, rawLenMm - op.width))
          - join.startOffMm) * MM;
        const w = op.width * MM;
        // Clamped to the box part: the gable above it is a separate product and
        // cannot host an opening.
        const h = Math.min(op.height, Math.max(0, boxHMm - op.sillHeight)) * MM;
        if (w < 0.001 || h < 0.001) continue;
        const thk = op.frameDepth > 0 ? op.frameDepth * MM : undefined;

        // The library's fill is a box; it is replaced afterwards with the
        // frame, mullion and pane or leaf the 3D viewer draws, in the same
        // proportions (`fillParts`). The box's size and depth are kept as
        // the frame's, so the opening and the fill still agree.
        // `along` is the opening's LEFT edge; the library's Position is its
        // CENTRE. Handing it the edge put every wall opening, and the window
        // in it, half a width to the left of where the 3D viewer draws it —
        // visible the moment the envelope's own cut landed on the true centre.
        const centreM = along + w / 2;
        const isDoor = op.node.type === 'door';
        const fillId = isDoor
          ? creator.addIfcWallDoor(wallId, {
            Position: [centreM, 0, op.sillHeight * MM], Width: w, Height: h, Thickness: thk,
            Name: nameOf(op.node),
          })
          : creator.addIfcWallWindow(wallId, {
            Position: [centreM, 0, op.sillHeight * MM], Width: w, Height: h, Thickness: thk,
            Name: nameOf(op.node),
          });
        paint(fillId, op.node, isDoor ? 'door' : 'window');
        // A type with an IFC library element: its own body, in place of the
        // generic frame and pane — what the viewers used to draw from it.
        const typeId = String(isDoor ? op.node.properties.door_type ?? '' : op.node.properties.window_type ?? '');
        const libPath = (isDoor ? DOOR_TYPE_MAP : WINDOW_TYPE_MAP).get(typeId)?.ifc_path ?? null;
        const lib = libPath ? options.libraryParts?.get(libPath) : undefined;
        if (lib?.length) {
          const half = (thk ?? thickness) / 2;
          meshSpecs.push({
            elementId: fillId,
            parts: lib.map((part) => part.tris.map((t) => t.map(([x, y, z]): Vec3 => [x, y, z + half]) as [Vec3, Vec3, Vec3])),
            looks: lib.map((part, i) => ({ name: `${libPath} ${i}`, rgb: part.rgb, opacity: part.opacity })),
          });
        } else fills.push({
          elementId: fillId,
          kind: isDoor ? 'door' : 'window',
          width: w, height: h, depth: thk ?? thickness,
          profile: Math.min(0.06, thickness * 0.25),
          double: isDoubleOpening(op.node, isDoor),
          frame: toRgb(rgbOf(glazing.frame_color)),
          panel: isDoor ? toRgb(appearanceOf(op.node, config, 'door').rgb) : toRgb(rgbOf(glazing.glass_color)),
          panelOpacity: isDoor ? 1 : glazing.glass_opacity,
        });
        const centreMm = centreM / MM;
        storeyOpenings.push({
          x: posA.x + wx * centreMm, y: posA.y + wy * centreMm,
          ux: wx, uy: wy,
          widthMm: w / MM, wallThickMm: thicknessMm,
          widthM: w, heightM: h, sillM: op.sillHeight * MM,
          name: nameOf(op.node) ?? op.node.type,
        });
      }
    }

    // ── Slabs: `room` (has_slab-gated) or standalone `slab` node → polygon footprint ──
    // Same anchor rule buildShellElements.ts/calcShellPolygon use: direct ax/column
    // anchors first; `room` additionally falls back to calcRoomPolygon's wall-walk.
    for (const n of storeyNodes) {
      const isStandaloneSlab = n.type === 'slab';
      const isRoomSlab = n.type === 'room' && n.properties.has_slab !== 'False' && n.properties.has_slab !== false;
      if (!isStandaloneSlab && !isRoomSlab) continue;

      const thickness = getNodeSlabThickness(n);
      const directAnchors = getConnectedNodes(n.id, edges, nodeMap).filter((c) => c.type === 'ax' || c.type === 'column');

      let poly: { x: number; y: number }[] | null = null;
      if (isStandaloneSlab) {
        // The perimeter the 3D viewer draws: the edge-order walk, so a slab
        // wired out of order does not come out as a bow-tie.
        poly = calcShellPolygon(n, nodeMap, edges);
      }
      if ((!poly || poly.length < 3) && directAnchors.length >= 3) {
        poly = ccw(directAnchors.map((a) => getNodeBimPos(a, nodeMap)));
      } else if ((!poly || poly.length < 3) && n.type === 'room') {
        poly = calcRoomPolygon(n, nodeMap, edges);
      }
      if (!poly || poly.length < 3) continue;
      poly = ccw(withContourOffset(poly, n.properties.contour_offset));

      const slabId = creator.addIfcSlab(storeyId, {
        Position: [0, 0, heightM - thickness],
        Thickness: thickness,
        Profile: toM(poly),
        Name: nameOf(n), Tag: n.id,
      });
      paint(slabId, n, 'slab');
    }

    // ── Foundations: the pad the 3D viewer draws under a `foundation` node ──
    // Top at the storey floor, extending down; Position is the top centre.
    for (const n of storeyNodes) {
      if (n.type !== 'foundation') continue;
      const pos = getNodeBimPos(n, nodeMap);
      const footingId = creator.addIfcFooting(storeyId, {
        Position: [pos.x * MM, pos.y * MM, 0],
        Width: 1.2, Depth: 1.2, Height: 0.5,
        PredefinedType: 'PAD_FOOTING',
        Name: nameOf(n), Tag: n.id,
      });
      paint(footingId, n, 'foundation');
    }

    // ── Rooms as IfcSpace: the translucent volume the 3D viewer draws ──
    // Same polygon, same contour offset, same height; a room with no walls
    // to walk is skipped rather than guessed at.
    for (const n of storeyNodes) {
      if (n.type !== 'room') continue;
      const raw = calcRoomPolygon(n, nodeMap, edges);
      if (!raw || raw.length < 3) continue;
      const poly = ccw(withContourOffset(raw, n.properties.contour_offset));
      const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
      const spaceId = creator.addIfcSpace(storeyId, {
        Position: [0, 0, 0],
        Width: (Math.max(...xs) - Math.min(...xs)) * MM,
        Depth: (Math.max(...ys) - Math.min(...ys)) * MM,
        Height: getRoomHeightMm(n.properties) * MM,
        Profile: toM(poly),
        Name: nameOf(n), LongName: nameOf(n), Tag: n.id,
      });
      spaceIds[n.id] = spaceId;
      paint(spaceId, n, 'room');
    }

    // ── Shell and covering rings ───────────────────────────────────────────
    // A plan polygon extruded as a ring, one mitred quad per edge (see
    // `ringSegments`). A shell is the envelope, so it goes out as IFCWALL
    // in bands when it has them; a covering is an IFCCOVERING.
    for (const n of storeyNodes) {
      if (n.type !== 'shell' && n.type !== 'covering') continue;
      const poly = calcShellPolygon(n, nodeMap, edges);
      if (!poly || poly.length < 3) continue;
      const totalM = Number(n.properties.height ?? 2800) * MM;
      const thickMm = Number(n.properties.thickness ?? 200);
      const offsets = parseContourOffsets(n.properties.contour_offset);
      const bands = (n.type === 'shell' ? renderBandsOf(n, totalM) : null)
        ?? [{ fromM: 0, heightM: totalM, material: undefined as string | undefined, label: '' }];
      const ifcType = n.type === 'shell' ? 'IFCWALL' : 'IFCCOVERING';
      for (const band of bands) {
        if (!(band.heightM > 0)) continue;
        const painted = band.material ? { ...n, properties: { ...n.properties, material: band.material } } : n;
        const quads = ringSegments(poly, offsets, thickMm);
        const segmentIds = quads.map((quad, i) => {
          const id = creator.addElement(storeyId, {
            IfcType: ifcType,
            ObjectType: n.type === 'shell' ? 'Shell' : undefined,
            Placement: { Location: [0, 0, band.fromM], Axis: [0, 0, 1], RefDirection: [1, 0, 0] },
            Profile: { ProfileType: 'AREA', OuterCurve: toM(quad) },
            Depth: band.heightM,
            Name: nameOf(n), Tag: `${n.id}:${band.label || 'ring'}:${i}`,
          });
          paint(id, painted, n.type);
          return id;
        });
        // The windows and doors show through: the ring is cut where the
        // walls behind it are, as the 3D viewer cuts its ring meshes.
        voids.push(...ringVoids(quads, segmentIds, storeyOpenings, band.fromM, band.heightM, offsets, thickMm));
      }
      // Surrounds, sills and corner dressings the shell carries (lib/ornament):
      // one covering per opening part or corner, the 3D view's own solids.
      if (n.type === 'shell') {
        for (const part of shellOrnaments(n, nodeMap, edges)) {
          const tag = `${n.id}:orn:${part.key}`;
          const id = placeholderElement(creator, storeyId, 'IFCCOVERING', `${nameOf(n) ?? 'Anvelopă'} — ${part.label}`, tag);
          paint(id, ornamentLook(n, part), 'covering');
          meshSpecs.push({ elementId: id, parts: part.solids.map((t) => toLocalTris(t, bottomMm)) });
        }
      }
    }

    // ── Room-derived coverings: the finish layers on a room's walls ──
    for (const n of storeyNodes) {
      if (n.type !== 'room' || !roomHasCovering(n.properties)) continue;
      const poly = calcRoomPolygon(n, nodeMap, edges);
      if (!poly || poly.length < 3) continue;
      const offsets = parseContourOffsets(n.properties.covering_offset ?? n.properties.contour_offset);
      for (const layer of resolveCoveringLayers(n.properties)) {
        if (!(layer.heightMm > 0)) continue;
        const painted = syntheticCoveringNodeForLayer(n, layer);
        const quads = ringSegments(poly, offsets, layer.thicknessMm);
        const segmentIds = quads.map((quad, i) => {
          const id = creator.addElement(storeyId, {
            IfcType: 'IFCCOVERING',
            Placement: { Location: [0, 0, layer.fromMm * MM], Axis: [0, 0, 1], RefDirection: [1, 0, 0] },
            Profile: { ProfileType: 'AREA', OuterCurve: toM(quad) },
            Depth: layer.heightMm * MM,
            Name: nameOf(n) ? `${nameOf(n)} (covering)` : 'Covering',
            Tag: `${n.id}:covering:${layer.fromMm}:${i}`,
          });
          paint(id, painted, 'covering');
          return id;
        });
        voids.push(...ringVoids(
          quads, segmentIds, storeyOpenings, layer.fromMm * MM, layer.heightMm * MM, offsets, layer.thicknessMm,
        ));
      }
    }

    // ── Roofs: the solved covering, one IfcRoof per slope ──────────────────
    // Each face is the top of the covering, extruded down through its
    // thickness. Gable-end faces are not written: the wall below already
    // carries its gable as a product of its own, and two would overlap.
    for (const rn of storeyNodes) {
      if (rn.type !== 'roof') continue;
      const faces = roofFacesById.get(rn.id) ?? [];
      const thickM = Math.max(1, parseRoofIntent(rn).coveringThicknessMm) * MM;
      // What you see from outside is the covering, so it names the material
      // — the same rule `roofSurfaceNode` applies for the 3D viewer.
      const covering = String(rn.properties.covering_material ?? '').trim();
      const surface = covering ? { ...rn, properties: { ...rn.properties, material: covering } } : rn;
      for (const face of faces) {
        if (face.role !== 'slope') continue;
        const frame = roofFaceFrame(face.vertices, bottomMm);
        if (!frame) continue;
        const roofId = creator.addElement(storeyId, {
          IfcType: 'IFCROOF',
          Placement: { Location: frame.location, Axis: frame.axis, RefDirection: frame.refDirection },
          Profile: { ProfileType: 'AREA', OuterCurve: frame.profile },
          Depth: thickM,
          Name: nameOf(rn), Tag: `${rn.id}:${face.id}`,
        });
        {
          const [zx, zy, zz] = frame.axis, [xx, xy, xz] = frame.refDirection;
          roofFaceElements.set(`${rn.id}:${face.id}`, {
            id: roofId, origin: frame.location, x: frame.refDirection, z: frame.axis,
            y: [zy * xz - zz * xy, zz * xx - zx * xz, zx * xy - zy * xx],
          });
        }
        paint(roofId, surface, 'roof');
      }
    }

    // ── Roof timber and linear details: members from a to b ─────────────────
    // Rafters, hips, ridge, wall plates, posts, purlins, ties, battens,
    // fascia… — what the roof solver generates at `generate_level: framing`
    // and its detail layers. Each is its section extruded from `a` to `b`
    // (absolute BIM mm), the section's width kept horizontal. Gutters and
    // downpipes go out round; the sheet layers (membrane, sheathing…) as thin
    // plates under the face they lie on.
    for (const n of storeyNodes) {
      const linear = ROOF_TIMBER_TYPES.has(n.type) || ROOF_LINEAR_DETAIL_TYPES.has(n.type);
      const round = ROOF_ROUND_DETAIL_TYPES.has(n.type);
      if (linear || round) {
        const p = n.properties;
        const a = { x: Number(p.ax), y: Number(p.ay), z: Number(p.az) };
        const b = { x: Number(p.bx), y: Number(p.by), z: Number(p.bz) };
        const frame = memberFrame(a, b);
        if (!frame) continue;
        let outer: Array<[number, number]>;
        if (round) {
          const r = Math.max(10, Number(p.diameter_mm ?? p.section_mm ?? 100)) * MM / 2;
          outer = Array.from({ length: 16 }, (_, i): [number, number] => [r * Math.cos((2 * Math.PI * i) / 16), r * Math.sin((2 * Math.PI * i) / 16)]);
        } else {
          const { w, h } = parseTimberSection(String(p.section ?? 'T8x16'));
          outer = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
        }
        const id = creator.addElement(storeyId, {
          IfcType: n.type === 'post' ? 'IFCCOLUMN' : 'IFCMEMBER',
          Placement: { Location: [a.x * MM, a.y * MM, (a.z - bottomMm) * MM], Axis: frame.axis, RefDirection: frame.ref },
          Profile: { ProfileType: 'AREA', OuterCurve: outer },
          Depth: frame.lengthMm * MM,
          Name: nameOf(n), Tag: n.id,
        });
        paint(id, n, n.type);
        continue;
      }
      if (ROOF_SHEET_DETAIL_TYPES.has(n.type)) {
        let verts: Pt3[] = [];
        try { verts = JSON.parse(String(n.properties.face_vertices ?? '[]')); } catch { verts = []; }
        if (!Array.isArray(verts) || verts.length < 3) continue;
        const t = Math.max(2, Number(n.properties.thickness_mm ?? 10));
        const solid = extrudePolygon3(verts, { x: 0, y: 0, z: -t });
        if (solid.length < 4) continue;
        const id = creator.addElement(storeyId, {
          IfcType: 'IFCCOVERING',
          Placement: { Location: [0, 0, 0], Axis: [0, 0, 1], RefDirection: [1, 0, 0] },
          Profile: { ProfileType: 'AREA', OuterCurve: [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]] },
          Depth: 0.01,
          Name: nameOf(n), Tag: n.id,
        });
        paint(id, n, n.type);
        meshSpecs.push({ elementId: id, parts: [solid.map((tr) => tr.map((q): [number, number, number] => [q.x * MM, q.y * MM, (q.z - bottomMm) * MM]) as [[number, number, number], [number, number, number], [number, number, number]])] });
      }
    }

    // ── Dormers: their own bodies as closed B-reps, and a hole in the slope ─
    // The eyebrow (hood, soffit, tympanum, glass) and the box dormer (walls,
    // own roof) are the same solids the 3D view draws (lib/roof/eyebrow.ts,
    // dormer.ts). The library writes a placeholder body at the storey origin;
    // `replaceWithMeshes` swaps in the triangles, in that frame. The hole each
    // opens in its host slope is resolved once every slope is written.
    for (const dn of storeyNodes) {
      if (dn.type !== 'dormer') continue;
      const eyebrow = dn.properties.dormer_type === 'eyebrow';
      let host: BubbleGraphNode | undefined;
      let parts: Array<{ type: string; label: string; solids: Tri[][]; paintAs: BubbleGraphNode; kind: string; window?: { w: number; h: number } }> = [];
      let notch: EyebrowNotch | null = null;
      let faceId = '';
      for (const [roofId, faces] of roofFacesById) {
        const roofNode = nodeMap.get(roofId);
        if (!roofNode) continue;
        const coveringMm = Math.max(1, parseRoofIntent(roofNode).coveringThicknessMm);
        const covering = String(roofNode.properties.covering_material ?? '').trim();
        const roofLook = covering ? { ...roofNode, properties: { ...roofNode.properties, material: covering } } : roofNode;
        const wallLook = { ...dn, properties: { ...dn.properties, material: String(dn.properties.material ?? (eyebrow ? 'Tencuială de var' : 'Lemn rasinos')) } };
        if (dn.properties.dormer_type === 'gablet') {
          const g = placeGablet(faces, gabletIntentOf(dn, coveringMm));
          if (!g || !g.ok) continue;
          host = roofNode;
          parts = [
            { type: 'IFCWALL', label: 'fronton', solids: [g.pediment], kind: 'wall',
              paintAs: { ...dn, properties: { ...dn.properties, material: String(dn.properties.material ?? 'Lemn masiv') } } },
            { type: 'IFCROOF', label: 'acoperiș', solids: g.roof, kind: 'roof', paintAs: roofLook },
            { type: 'IFCCOVERING', label: 'ornament', solids: g.decor, kind: 'covering',
              paintAs: { ...dn, properties: { ...dn.properties, material: String(dn.properties.decor_material ?? 'Tablă'), color_3d: dn.properties.decor_color ?? undefined } } },
          ];
        } else if (eyebrow) {
          const g = placeEyebrow(faces, eyebrowIntentOf(dn, coveringMm));
          if (!g) continue;
          host = roofNode; notch = g.notch; faceId = g.face.id;
          parts = [
            { type: 'IFCROOF', label: 'acoperiș', solids: [g.hood], kind: 'roof', paintAs: roofLook },
            { type: 'IFCCOVERING', label: 'streașină', solids: [g.soffit], kind: 'beam',
              paintAs: { ...dn, properties: {
                ...dn.properties, material: String(dn.properties.soffit_material ?? 'Lemn masiv'),
                color_3d: dn.properties.soffit_color ?? undefined,
              } } },
            { type: 'IFCWALL', label: 'timpan', solids: [g.tympanum], kind: 'wall', paintAs: wallLook },
            { type: 'IFCWINDOW', label: 'fereastră', solids: [g.glass], kind: 'window',
              paintAs: { ...dn, properties: { ...dn.properties, material: 'glass' } },
              window: { w: g.window.widthMm, h: g.window.heightMm } },
          ];
        } else {
          const pl = placeDormer(faces, dormerIntentOf(dn));
          if (!pl) continue;
          host = roofNode; faceId = pl.face.id;
          const solids = dormerSolids(pl, 100, coveringMm);
          const [L, R, , BL] = pl.notchFootprint;
          const w = Math.hypot(R.x - L.x, R.y - L.y) || 1;
          const d = Math.hypot(BL.x - L.x, BL.y - L.y) || 1;
          notch = {
            front: { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2, z: Math.min(L.z, R.z) },
            along: { x: (R.x - L.x) / w, y: (R.y - L.y) / w },
            up: { x: (BL.x - L.x) / d, y: (BL.y - L.y) / d },
            widthMm: w, depthMm: d,
            zMinMm: Math.min(...pl.notchFootprint.map((q) => q.z)) - 200,
            zMaxMm: pl.frontWall.corners[2].z + 50,
          };
          const ownCovering = String(dn.properties.covering_material ?? '').trim();
          parts = [
            { type: 'IFCWALL', label: 'pereți', solids: solids.walls, kind: 'wall', paintAs: wallLook },
            { type: 'IFCROOF', label: 'acoperiș', solids: solids.roof, kind: 'roof',
              paintAs: ownCovering ? { ...dn, properties: { ...dn.properties, material: ownCovering } } : wallLook },
          ];
        }
        break;
      }
      if (!host) continue;
      const local = (tris: Tri[]) => tris.map((t) =>
        t.map((q): [number, number, number] => [q.x * MM, q.y * MM, (q.z - bottomMm) * MM]) as [[number, number, number], [number, number, number], [number, number, number]]);
      for (const part of parts) {
        const solids = part.solids.filter((t) => t.length >= 4);
        if (!solids.length) continue;
        const Name = `${nameOf(dn) ?? 'Lucarnă'} — ${part.label}`;
        const Tag = `${dn.id}:${part.label}`;
        // A window has attributes of its own (overall size, partitioning) the
        // generic element writer leaves out; the library's window writer fills them.
        const id = part.type === 'IFCWINDOW' && part.window
          ? creator.addIfcWindow(storeyId, {
            Position: [0, 0, 0], Width: part.window.w * MM, Height: part.window.h * MM,
            Thickness: 0.02, PartitioningType: 'SINGLE_PANEL', Name, Tag,
          })
          : creator.addElement(storeyId, {
            IfcType: part.type,
            Placement: { Location: [0, 0, 0], Axis: [0, 0, 1], RefDirection: [1, 0, 0] },
            Profile: { ProfileType: 'AREA', OuterCurve: [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]] },
            Depth: 0.01,
            Name, Tag,
          });
        paint(id, part.paintAs, part.kind);
        meshSpecs.push({ elementId: id, parts: solids.map(local) });
      }
      if (notch) pendingNotches.push({ key: `${host.id}:${faceId}`, notch, name: `${nameOf(dn) ?? 'Lucarnă'} — gol` });
    }

    // ── Sweeps: one arbitrary-profile extrusion per guide-line segment ──
    // Frame: the profile's own (x, y) = (lateral left, up) must land as local
    // (X, Y), so RefDirection is the lateral direction and Axis the extrusion
    // heading — then Y = Axis × RefDirection comes out as world up. Getting
    // these two the wrong way round exports the profile lying on its side.
    for (const n of storeyNodes) {
      if (n.type !== 'sweep') continue;
      const res = computeSweep(n, nodeMap, edges);
      if (!res.placed || !res.path) continue;

      // An explicit ifc_type still wins; otherwise the declared role picks the
      // class, and only an undeclared sweep falls back to guessing by direction.
      const declared = String(n.properties.ifc_type ?? 'auto').toUpperCase();
      const ifcType = declared !== 'AUTO' && declared.startsWith('IFC')
        ? declared
        : ifcTypeForRole(sweepRole(n), res.path.kind);
      const outerCurve = res.placed.map((p): [number, number] => [p.x * MM, p.y * MM]);

      // A run of several segments, or a closed loop, goes out as ONE solid:
      // the swept body itself, mitred at every corner, triangulated exactly as
      // the 3D view draws it. Extrusions segment by segment cannot mitre — they
      // overlap inside a corner and leave a notch outside it (a plinth or a
      // cornice with a gap at the house corner).
      const segs = sweepSegments(res.path).filter((g) => g.lengthMm >= 1);
      if (segs.length > 1 && res.solids.length && !res.solids.some((sd) => sd.holes?.length)) {
        const tris = sweepTriangles(res.solids, res.placed);
        if (tris.length >= 4) {
          const id = placeholderElement(creator, storeyId, ifcType, nameOf(n), n.id);
          paint(id, n, 'sweep');
          meshSpecs.push({ elementId: id, parts: [toLocalTris(tris, bottomMm)] });
          creator.addIfcElementQuantity(id, {
            Name: qtoName(ifcType),
            Quantities: [
              { Name: 'Length', Value: res.lengthMm * MM, Kind: 'IfcQuantityLength' },
              { Name: 'CrossSectionArea', Value: res.areaMm2 * MM * MM, Kind: 'IfcQuantityArea' },
              { Name: 'NetVolume', Value: res.volumeMm3 * MM ** 3, Kind: 'IfcQuantityVolume' },
            ],
          });
          continue;
        }
      }

      for (const seg of segs) {
        const sweepId = creator.addElement(storeyId, {
          IfcType: ifcType,
          Placement: {
            Location: [seg.start.x * MM, seg.start.y * MM, (seg.start.z - bottomMm) * MM],
            Axis: [seg.axis.x, seg.axis.y, seg.axis.z],
            RefDirection: [seg.refDir.x, seg.refDir.y, seg.refDir.z],
          },
          Profile: { ProfileType: 'AREA', OuterCurve: outerCurve },
          Depth: seg.lengthMm * MM,
          Name: nameOf(n), Tag: n.id,
        });
        paint(sweepId, n, 'sweep');
      }
    }

    // ── Sketches: a drawn outline, extruded or swept along itself ──────────
    // An extrusion goes out as ONE extruded-area-solid per array copy, with
    // the outline as its profile — which is exactly what it is, so nothing is
    // approximated. A sweep along the drawn path goes out segment by segment,
    // the same way the sweep element does.
    for (const n of storeyNodes) {
      if (n.type !== 'sketch') continue;
      const res = computeSketch(n, nodeMap, edges);
      if (!res.placed || res.copies.length === 0) continue;
      const ifcType = sketchIfcType(res.intent);

      if (res.intent.op === 'extrude') {
        for (const copy of res.copies) {
          const depthMm = copy.zMaxMm - copy.zMinMm;
          if (depthMm < 1) continue;
          for (const [ringIdx, ring] of copy.footprint.entries()) {
            if (ring.length < 3) continue;
            // The profile is written relative to the copy's own base point.
            const origin = ring[0];
            const id = creator.addElement(storeyId, {
              IfcType: ifcType,
              Placement: {
                Location: [origin.x * MM, origin.y * MM, (copy.zMinMm - bottomMm) * MM],
                Axis: [0, 0, 1],
                RefDirection: [1, 0, 0],
              },
              Profile: {
                ProfileType: 'AREA',
                OuterCurve: ring.map((p): [number, number] => [(p.x - origin.x) * MM, (p.y - origin.y) * MM]),
              },
              Depth: depthMm * MM,
              Name: nameOf(n), Tag: n.id,
            });
            paint(id, n, 'sketch');
            const holes = copy.footprintHoles[ringIdx] ?? [];
            // This element's own quantities — one copy, one ring — so a
            // schedule summing the elements sums to the node's total.
            const grossMm2 = Math.abs(faceArea(ring));
            const netMm2 = faceArea(ring, holes);
            creator.addIfcElementQuantity(id, {
              Name: qtoName(ifcType),
              Quantities: [
                { Name: 'Height', Value: depthMm * MM, Kind: 'IfcQuantityLength' },
                { Name: 'Perimeter', Value: facePerimeter(ring, holes) * MM, Kind: 'IfcQuantityLength' },
                { Name: 'GrossArea', Value: grossMm2 * MM * MM, Kind: 'IfcQuantityArea' },
                { Name: 'NetArea', Value: netMm2 * MM * MM, Kind: 'IfcQuantityArea' },
                { Name: 'GrossVolume', Value: grossMm2 * depthMm * MM ** 3, Kind: 'IfcQuantityVolume' },
                { Name: 'NetVolume', Value: netMm2 * depthMm * MM ** 3, Kind: 'IfcQuantityVolume' },
              ],
            });
            if (holes.length) {
              profileHoleSpecs.push({
                elementId: id,
                holes: holes.map((h) => h.map((p): [number, number] => [(p.x - origin.x) * MM, (p.y - origin.y) * MM])),
              });
            }
          }
        }
      } else if (res.path) {
        const outerCurve = res.placed.map((p): [number, number] => [p.x * MM, p.y * MM]);
        const profilePerimeterMm = facePerimeter(res.placed, res.profileHoles);
        for (const copy of res.copies) {
          // A copy along a path is turned as well as moved: the segment's
          // start, its axis and its reference direction all turn with it.
          const pl = { d: { x: copy.dxMm, y: copy.dyMm, z: copy.dzMm }, rotRad: (copy.rotDeg * Math.PI) / 180, pivot: copy.pivot };
          const at = placeFn(pl);
          // Several segments: one mitred solid per copy, as for the sweep element.
          const segs = sweepSegments(res.path).filter((g) => g.lengthMm >= 1);
          if (segs.length > 1 && res.solids.length && !res.profileHoles.length) {
            const tris = sweepTriangles(res.solids, res.placed).map((t) => t.map((q) => {
              const m = at(q);
              return { x: m.x, y: m.y, z: q.z + copy.dzMm };
            }) as Tri);
            if (tris.length >= 4) {
              const id = placeholderElement(creator, storeyId, ifcType, nameOf(n), n.id);
              paint(id, n, 'sketch');
              meshSpecs.push({ elementId: id, parts: [toLocalTris(tris, bottomMm)] });
              const lengthMm = segs.reduce((sum, g) => sum + g.lengthMm, 0);
              creator.addIfcElementQuantity(id, {
                Name: qtoName(ifcType),
                Quantities: [
                  { Name: 'Length', Value: lengthMm * MM, Kind: 'IfcQuantityLength' },
                  { Name: 'CrossSectionArea', Value: res.profileAreaMm2 * MM * MM, Kind: 'IfcQuantityArea' },
                  { Name: 'NetVolume', Value: res.profileAreaMm2 * lengthMm * MM ** 3, Kind: 'IfcQuantityVolume' },
                ],
              });
              continue;
            }
          }
          for (const seg of segs) {
            const start = at(seg.start);
            const axis = placeDirection(seg.axis, pl);
            const refDir = placeDirection(seg.refDir, pl);
            const id = creator.addElement(storeyId, {
              IfcType: ifcType,
              Placement: {
                Location: [
                  start.x * MM,
                  start.y * MM,
                  (seg.start.z + copy.dzMm - bottomMm) * MM,
                ],
                Axis: [axis.x, axis.y, axis.z],
                RefDirection: [refDir.x, refDir.y, refDir.z],
              },
              Profile: { ProfileType: 'AREA', OuterCurve: outerCurve },
              Depth: seg.lengthMm * MM,
              Name: nameOf(n), Tag: n.id,
            });
            paint(id, n, 'sketch');
            creator.addIfcElementQuantity(id, {
              Name: qtoName(ifcType),
              Quantities: [
                { Name: 'Length', Value: seg.lengthMm * MM, Kind: 'IfcQuantityLength' },
                { Name: 'CrossSectionArea', Value: res.profileAreaMm2 * MM * MM, Kind: 'IfcQuantityArea' },
                { Name: 'OuterSurfaceArea', Value: profilePerimeterMm * seg.lengthMm * MM * MM, Kind: 'IfcQuantityArea' },
                { Name: 'NetVolume', Value: res.profileAreaMm2 * seg.lengthMm * MM ** 3, Kind: 'IfcQuantityVolume' },
              ],
            });
            if (res.profileHoles.length) {
              profileHoleSpecs.push({
                elementId: id,
                holes: res.profileHoles.map((h) => h.map((p): [number, number] => [p.x * MM, p.y * MM])),
              });
            }
          }
        }
      }
    }

    // ── Domes: ribs as members, cells as glass plates ──
    // One node becomes many elements of two classes, which is what a dome is:
    // a steel frame and a glazing package, priced and built by different
    // trades. Both carry the dome's `Tag` so the pieces stay traceable back
    // to the node that generated them.
    for (const n of storeyNodes) {
      if (n.type !== 'dome') continue;
      const res = computeDome(n, nodeMap, edges);
      if (!res.base) continue;

      if (res.placed) {
        for (const piece of domeMemberPieces(res.members, res.placed, bottomMm)) {
          const id = creator.addElement(storeyId, {
            IfcType: 'IFCMEMBER',
            Placement: { Location: piece.location, Axis: piece.axis, RefDirection: piece.refDirection },
            Profile: { ProfileType: 'AREA', OuterCurve: piece.profile },
            Depth: piece.depthM,
            Name: nameOf(n), Tag: n.id,
          });
          paint(id, n, 'dome');
        }
      }

      const glassNode = { ...n, properties: { ...n.properties, material: res.intent.glassMaterial } };
      for (const piece of domePanelPieces(res.panels, res.intent.glassThicknessMm, bottomMm)) {
        const id = creator.addElement(storeyId, {
          IfcType: 'IFCPLATE',
          Placement: { Location: piece.location, Axis: piece.axis, RefDirection: piece.refDirection },
          Profile: { ProfileType: 'AREA', OuterCurve: piece.profile },
          Depth: piece.depthM,
          Name: nameOf(n), Tag: n.id,
        });
        paint(id, glassNode, 'dome_panel');
      }
    }

    // ── Facades: mullions as members, glass and panels as plates ──
    // The cassette bevel is not exportable as a straight extrusion, so a
    // cassette goes out as its outer ring extruded by its depth.
    for (const n of storeyNodes) {
      if (n.type !== 'facade') continue;
      const res = computeFacade(n, nodeMap, edges);
      if (res.cells.length === 0) continue;
      for (const piece of facadeMemberPieces(res, bottomMm)) {
        const id = creator.addElement(storeyId, {
          IfcType: 'IFCMEMBER',
          Placement: { Location: piece.location, Axis: piece.axis, RefDirection: piece.refDirection },
          Profile: { ProfileType: 'AREA', OuterCurve: piece.profile },
          Depth: piece.depthM,
          Name: nameOf(n), Tag: n.id,
        });
        paint(id, n, 'facade');
      }
      const glassNode = { ...n, properties: { ...n.properties, material: res.intent.glassMaterial } };
      for (const piece of domePanelPieces(res.glassPanels, res.intent.glassThicknessMm, bottomMm)) {
        const id = creator.addElement(storeyId, {
          IfcType: 'IFCPLATE',
          Placement: { Location: piece.location, Axis: piece.axis, RefDirection: piece.refDirection },
          Profile: { ProfileType: 'AREA', OuterCurve: piece.profile },
          Depth: piece.depthM,
          Name: nameOf(n), Tag: n.id,
        });
        paint(id, glassNode, 'facade_panel');
      }
      const panelNode = { ...n, properties: { ...n.properties, material: res.intent.panelMaterial } };
      for (const piece of [
        ...domePanelPieces(res.solidPanels, res.intent.panelThicknessMm, bottomMm),
        ...facadeCassettePieces(res, bottomMm),
      ]) {
        const id = creator.addElement(storeyId, {
          IfcType: 'IFCPLATE',
          Placement: { Location: piece.location, Axis: piece.axis, RefDirection: piece.refDirection },
          Profile: { ProfileType: 'AREA', OuterCurve: piece.profile },
          Depth: piece.depthM,
          Name: nameOf(n), Tag: n.id,
        });
        paint(id, panelNode, 'facade_cassette');
      }
    }

    // ── Stairs: the solved stairwell geometry, element by element ──
    for (const n of storeyNodes) {
      if (n.type !== 'stairwell') continue;
      const { geometry } = computeStairGeometry(n, allNodes, edges);
      if (!geometry) continue;

      // Each flight is an IfcStair whose body is OUR cast cross-section — the
      // sawtooth-over-waist from `flightProfile`, with the same junction depths
      // the 3D viewers use — extruded across the width. The `addIfcStair`
      // primitive was tried first and draws detached tread plates floating one
      // above the other; a generic element with an arbitrary profile carries
      // the true solid instead.
      //
      // Frame: profile (x, y) = (along run, up); local Z (the extrusion axis)
      // must then be the RIGHT-hand normal of the run so Y = Z × X points UP,
      // and the extrusion starts on the LEFT edge to end up centred.
      const { intent: stairIntent } = computeStairGeometry(n, allNodes, edges);
      for (const f of geometry.flights) {
        const runMm = Math.hypot(f.end.x - f.start.x, f.end.y - f.start.y);
        const dir = runMm > 1e-6
          ? { x: (f.end.x - f.start.x) / runMm, y: (f.end.y - f.start.y) / runMm }
          : { x: 1, y: 0 };
        const isLast = f.index === geometry.flights.length - 1;
        const junction = stairIntent.turnStyle === 'winder' ? f.riserMm : stairIntent.thicknessMm;
        const profile = flightProfile(f.steps, f.riserMm, f.treadMm, stairIntent.thicknessMm, {
          footDropMm: f.index > 0 ? junction : 0,
          headDropMm: isLast ? 0 : junction,
          ...(isLast ? { tailMm: Math.max(30, stairIntent.voidClearanceMm) } : {}),
        });
        if (!profile) continue;
        const half = f.widthMm / 2;
        const flightId = creator.addElement(storeyId, {
          IfcType: 'IFCSTAIR',
          Placement: {
            Location: [
              (f.start.x - dir.y * half) * MM,          // left edge of the run
              (f.start.y + dir.x * half) * MM,
              (f.start.z - bottomMm) * MM,
            ],
            Axis: [dir.y, -dir.x, 0],                   // across, extrusion axis
            RefDirection: [dir.x, dir.y, 0],            // along the run
          },
          Profile: {
            ProfileType: 'AREA',
            OuterCurve: profile.map((p): [number, number] => [p.x * MM, p.y * MM]),
          },
          Depth: f.widthMm * MM,
          Name: nameOf(n), Tag: n.id,
        });
        paint(flightId, n, 'stair_flight');
      }

      // Landings and winder steps as profile slabs at their walking levels —
      // a winder is simply a one-riser-thick slab shaped like its wedge.
      for (const l of geometry.landings) {
        const landingId = creator.addIfcSlab(storeyId, {
          Position: [0, 0, (l.levelMm - l.thicknessMm - bottomMm) * MM],
          Thickness: l.thicknessMm * MM,
          Profile: l.polygon.map((p): [number, number] => [p.x * MM, p.y * MM]),
          Name: nameOf(n), Tag: n.id,
        });
        paint(landingId, n, 'stair_landing');
      }
      for (const w of geometry.winders) {
        const winderId = creator.addIfcSlab(storeyId, {
          Position: [0, 0, (w.zTopMm - w.riserMm - bottomMm) * MM],
          Thickness: w.riserMm * MM,
          Profile: w.polygon.map((p): [number, number] => [p.x * MM, p.y * MM]),
          Name: nameOf(n), Tag: n.id,
        });
        paint(winderId, n, 'stair_landing');
      }

      if (geometry.spiral && geometry.spiral.innerMm > 0) {
        const poleId = creator.addIfcCircularColumn(storeyId, {
          Position: [
            geometry.spiral.center.x * MM,
            geometry.spiral.center.y * MM,
            (geometry.bottomZMm - bottomMm) * MM,
          ],
          Radius: geometry.spiral.innerMm * MM,
          Height: (geometry.topZMm - geometry.bottomZMm) * MM,
          Name: nameOf(n), Tag: n.id,
        });
        paint(poleId, n, 'stair_flight');
      }
    }
  }

  // Dormer holes in their host slopes: a vertical box over the dormer's plan
  // rectangle, written in the slope element's own frame.
  for (const { key, notch: nt, name } of pendingNotches) {
    const host = roofFaceElements.get(key);
    if (!host) continue;
    const storeyBottom = Number(nodeMap.get(nodeMap.get(key.split(':')[0])?.parentId ?? '')?.properties.bottomElevation ?? 0);
    const up: Vec3 = [nt.up.x, nt.up.y, 0];
    // The box rises (its local Y) up the slope: Y = Z × X with Z vertical.
    const flip = (-nt.along.y * up[0] + nt.along.x * up[1]) < 0 ? -1 : 1;
    const ref: Vec3 = [flip * nt.along.x, flip * nt.along.y, 0];
    const p: Vec3 = [nt.front.x * MM, nt.front.y * MM, (nt.zMinMm - storeyBottom) * MM];
    const rel: Vec3 = [p[0] - host.origin[0], p[1] - host.origin[1], p[2] - host.origin[2]];
    const inLocal = (v: Vec3): Vec3 => [
      v[0] * host.x[0] + v[1] * host.x[1] + v[2] * host.x[2],
      v[0] * host.y[0] + v[1] * host.y[1] + v[2] * host.y[2],
      v[0] * host.z[0] + v[1] * host.z[1] + v[2] * host.z[2],
    ];
    voids.push({
      hostId: host.id, name,
      location: inLocal(rel), axis: inLocal([0, 0, 1]), refDirection: inLocal(ref),
      width: nt.widthMm * MM, height: nt.depthMm * MM, depth: (nt.zMaxMm - nt.zMinMm) * MM,
    });
  }

  const built = creator.toIfc();
  // Opacity is not in the library's API; it is written into the text after.
  // …as are the openings in the rings and the frames of the windows and
  // doors, neither of which the library can write.
  // …and the mitred corners, which need the wall to stay a swept solid so it
  // can go on hosting its openings — so the cut is a half-space taken off the
  // body rather than a different profile.
  const styled = replaceWithMeshes(clipElements(
    replaceFillGeometry(
      profileVoids(voidElements(applyStyleTransparency(built.content, opacityByStyle), voids), profileHoleSpecs),
      fills,
    ),
    clips,
  ), meshSpecs);
  // …and the quantities' IFC4 `Formula`, and the escapes a 7-bit STEP file
  // needs for every non-ASCII character (see stepEncoding.ts).
  const encoded = (text: string) => encodeStepUnicode(addQuantityFormula(text, options.schema ?? 'IFC4'));
  const finished = encoded(styled);
  const result: IfcModelResult = { ...built, spaceIds, content: finished, stats: { ...built.stats, fileSize: finished.length } };
  if (!options.georeference) return result;

  // Georeferencing is a text pass because `@ifc-lite/create` exposes no API
  // for it — see lib/geo/ifcGeoref.ts. It only edits IfcSite and the model
  // context and appends two entities, so nothing built above can shift.
  const content = encoded(writeGeoreference(result.content, options.georeference, {
    schema: options.schema ?? 'IFC4',
    ...options.georeferenceOptions,
  }));
  return { ...result, content, stats: { ...result.stats, fileSize: content.length } };
}
