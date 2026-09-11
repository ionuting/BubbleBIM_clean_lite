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
 *   - No wall joins/offsets, no circular walls, no grip-face offsetting —
 *     wall Start/End are the raw ax/column endpoint centres. Good enough for
 *     a first real export; the visual join logic lives in `calcWallGeometry`
 *     and would need porting separately if exact mitred corners matter.
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
  collectOpenings,
  MM,
} from '@/lib/bimGeometry';
import { IfcCreator } from '@ifc-lite/create';
import type { CreateResult } from '@ifc-lite/create';
import { computeRoofFaces } from '@/lib/roof/solver';
import {
  attachHeightAlong, attachesToRoof, isTrimmed, roofTrim, roofTrimsNode, topOutline, trimmedTopAlong,
  type RoofTrim,
} from '@/lib/roof/trim';
import { gableMaterial, gableSpec } from '@/lib/roof/gable';
import { computeStairGeometry } from '@/lib/stair';
import { flightProfile } from '@/lib/stair/profile';
import { computeSweep, sweepSegments } from '@/lib/sweep';

export interface IfcModelOptions {
  schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
}

/** `undefined` for an empty/whitespace name so `@ifc-lite/create` falls back to its own default label. */
function nameOf(n: BubbleGraphNode): string | undefined {
  const t = n.name?.trim();
  return t ? t : undefined;
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
): CreateResult {
  const creator = new IfcCreator({ Name: projectName, Schema: options.schema ?? 'IFC4' });
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  const storeys = allNodes
    .filter((n) => n.type === 'storey')
    .slice()
    .sort((a, b) => Number(a.properties.bottomElevation ?? 0) - Number(b.properties.bottomElevation ?? 0));

  // Roof trim planes, built once: a roof sits on its own storey but cuts walls
  // on the ones below, so this cannot live inside the storey loop.
  const roofTrims: RoofTrim[] = [];
  for (const rn of allNodes) {
    if (rn.type !== 'roof') continue;
    const t = roofTrim(rn, computeRoofFaces(rn, allNodes, edges).faces);
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

    // ── Columns: `ax` nodes with has_column: true, and standalone `column` nodes ──
    for (const n of storeyNodes) {
      const isGridColumn = n.type === 'ax' && String(n.properties.has_column ?? '').toLowerCase() === 'true';
      const isStandaloneColumn = n.type === 'column';
      if (!isGridColumn && !isStandaloneColumn) continue;

      const pos = getNodeBimPos(n, nodeMap);
      const x = pos.x * MM, y = pos.y * MM;
      const { w, d, circular } = parseColumnDims(String(n.properties.column_type ?? 'C25x25'));

      if (circular) {
        creator.addIfcCircularColumn(storeyId, {
          Position: [x, y, 0], Radius: w / 2, Height: heightM,
          Name: nameOf(n), Tag: n.id,
        });
      } else {
        creator.addIfcColumn(storeyId, {
          Position: [x, y, 0], Width: w, Depth: d, Height: heightM,
          Name: nameOf(n), Tag: n.id,
        });
      }
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
      creator.addIfcBeam(storeyId, {
        Start: [posA.x * MM, posA.y * MM, heightM],
        End: [posB.x * MM, posB.y * MM, heightM],
        Width: bw, Height: bh,
        Name: nameOf(n), Tag: n.id,
      });
    }

    // ── Walls: between two ax/column endpoints, with ring-beam height reduction
    //    and door/window openings hosted via addIfcWallDoor/addIfcWallWindow ──
    for (const n of storeyNodes) {
      if (n.type !== 'wall') continue;
      const ends = getConnectedNodes(n.id, edges, nodeMap).filter((c) => c.type === 'ax' || c.type === 'column');
      if (ends.length < 2) continue;
      const [eA, eB] = ends;

      const posA = getNodeBimPos(eA, nodeMap);
      const posB = getNodeBimPos(eB, nodeMap);
      const wallLenMm = Math.hypot(posB.x - posA.x, posB.y - posA.y);
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
        }
      }

      const openingInfos = collectOpenings(n, wallLenMm, edges, nodeMap);
      for (const op of openingInfos) {
        // Clamp so a mis-measured opening from a formula edge case can't land outside the wall solid.
        const along = Math.min(Math.max(op.distFromStart, 0), Math.max(0, wallLenMm - op.width)) * MM;
        const w = op.width * MM;
        // Clamped to the box part: the gable above it is a separate product and
        // cannot host an opening.
        const h = Math.min(op.height, Math.max(0, boxHMm - op.sillHeight)) * MM;
        if (w < 0.001 || h < 0.001) continue;
        const thk = op.frameDepth > 0 ? op.frameDepth * MM : undefined;

        if (op.node.type === 'door') {
          creator.addIfcWallDoor(wallId, {
            Position: [along, 0, op.sillHeight * MM], Width: w, Height: h, Thickness: thk,
            Name: nameOf(op.node),
          });
        } else {
          creator.addIfcWallWindow(wallId, {
            Position: [along, 0, op.sillHeight * MM], Width: w, Height: h, Thickness: thk,
            Name: nameOf(op.node),
          });
        }
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
      if (directAnchors.length >= 3) {
        const pts = directAnchors.map((a) => getNodeBimPos(a, nodeMap));
        let area2 = 0;
        for (let i = 0; i < pts.length; i++) {
          const j = (i + 1) % pts.length;
          area2 += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
        }
        poly = area2 < 0 ? pts.slice().reverse() : pts; // CCW winding
      } else if (n.type === 'room') {
        poly = calcRoomPolygon(n, nodeMap, edges);
      }
      if (!poly || poly.length < 3) continue;

      creator.addIfcSlab(storeyId, {
        Position: [0, 0, heightM - thickness],
        Thickness: thickness,
        Profile: poly.map((p): [number, number] => [p.x * MM, p.y * MM]),
        Name: nameOf(n), Tag: n.id,
      });
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

      const declared = String(n.properties.ifc_type ?? 'auto').toUpperCase();
      const ifcType = declared !== 'AUTO' && declared.startsWith('IFC')
        ? declared
        : (res.path.kind === 'vertical' ? 'IFCCOLUMN' : 'IFCBEAM');
      const outerCurve = res.placed.map((p): [number, number] => [p.x * MM, p.y * MM]);

      for (const seg of sweepSegments(res.path)) {
        if (seg.lengthMm < 1) continue;
        creator.addElement(storeyId, {
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
        creator.addElement(storeyId, {
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
      }

      // Landings and winder steps as profile slabs at their walking levels —
      // a winder is simply a one-riser-thick slab shaped like its wedge.
      for (const l of geometry.landings) {
        creator.addIfcSlab(storeyId, {
          Position: [0, 0, (l.levelMm - l.thicknessMm - bottomMm) * MM],
          Thickness: l.thicknessMm * MM,
          Profile: l.polygon.map((p): [number, number] => [p.x * MM, p.y * MM]),
          Name: nameOf(n), Tag: n.id,
        });
      }
      for (const w of geometry.winders) {
        creator.addIfcSlab(storeyId, {
          Position: [0, 0, (w.zTopMm - w.riserMm - bottomMm) * MM],
          Thickness: w.riserMm * MM,
          Profile: w.polygon.map((p): [number, number] => [p.x * MM, p.y * MM]),
          Name: nameOf(n), Tag: n.id,
        });
      }

      if (geometry.spiral && geometry.spiral.innerMm > 0) {
        creator.addIfcCircularColumn(storeyId, {
          Position: [
            geometry.spiral.center.x * MM,
            geometry.spiral.center.y * MM,
            (geometry.bottomZMm - bottomMm) * MM,
          ],
          Radius: geometry.spiral.innerMm * MM,
          Height: (geometry.topZMm - geometry.bottomZMm) * MM,
          Name: nameOf(n), Tag: n.id,
        });
      }
    }
  }

  return creator.toIfc();
}
