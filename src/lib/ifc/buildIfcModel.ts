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
 *   - No roofs, stairs, MEP, or non-convex slab triangulation subtleties —
 *     `@ifc-lite/create`'s own arbitrary-profile slab handles any simple
 *     polygon in one shot, convex or not (unlike the FEM module's manual fan
 *     triangulation, this needs no triangulation at all).
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  getNodeBimPos,
  getConnectedNodes,
  parseColumnDims,
  parseBeamDims,
  parseWallThickness,
  getNodeSlabThickness,
  calcRoomPolygon,
  collectOpenings,
  MM,
} from '@/lib/bimGeometry';
import { IfcCreator } from '@ifc-lite/create';
import type { CreateResult } from '@ifc-lite/create';

export interface IfcModelOptions {
  schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
}

/** `undefined` for an empty/whitespace name so `@ifc-lite/create` falls back to its own default label. */
function nameOf(n: BubbleGraphNode): string | undefined {
  const t = n.name?.trim();
  return t ? t : undefined;
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

      const thickness = parseWallThickness(String(n.properties.wall_type ?? 'W20'));

      // Ring-beam height reduction — same rule as calcWallGeometry, so a wall doesn't
      // visually overlap the beam that sits above it when has_beam is set.
      const hasBeam = String(n.properties.has_beam ?? '').toLowerCase() === 'true';
      const beamHMm = hasBeam ? parseBeamDims(String(n.properties.beam_section ?? 'B20x30')).bh * 1000 : 0;
      const wallHMm = n.properties.height != null
        ? Number(n.properties.height)
        : Math.max(0, topMm - bottomMm - beamHMm);
      const wallHM = wallHMm * MM;
      if (wallHM < 0.001) continue;

      const wallId = creator.addIfcWall(storeyId, {
        Start: [posA.x * MM, posA.y * MM, 0],
        End: [posB.x * MM, posB.y * MM, 0],
        Thickness: thickness, Height: wallHM,
        Name: nameOf(n), Tag: n.id,
      });

      const openingInfos = collectOpenings(n, wallLenMm, edges, nodeMap);
      for (const op of openingInfos) {
        // Clamp so a mis-measured opening from a formula edge case can't land outside the wall solid.
        const along = Math.min(Math.max(op.distFromStart, 0), Math.max(0, wallLenMm - op.width)) * MM;
        const w = op.width * MM;
        const h = Math.min(op.height, Math.max(0, wallHMm - op.sillHeight)) * MM;
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
  }

  return creator.toIfc();
}
