/**
 * composerSync.ts — Synchronizes Composer RoomX shapes → BubbleGraph nodes & edges.
 *
 * Output matches the graph structure expected by BabylonViewer and FloorPlan2DViewer:
 * - `ax` nodes at each vertex (merged by proximity, FCFS)
 * - `wall` nodes for each edge with has_wall=true, connected to 2 endpoint ax nodes
 *   - Inline windows/doors via has_windows/has_doors + JSON arrays on wall properties
 * - `beam` nodes for standalone beams (connected to 2 endpoint ax nodes)
 * - Wall-embedded beams via has_beam + beam_section property on the wall node
 */

import type { RoomXShape, RoomXEdgeConfig, BubbleGraphNode, BubbleGraphEdge } from '@/store';

// ─── Vertex Key (for merge detection) ─────────────────────────────────────

/** Stable key for a vertex position (snapped to 1mm grid). */
function posKey(x: number, y: number): string {
  return `${Math.round(x)},${Math.round(y)}`;
}

// ─── Main Sync Function ───────────────────────────────────────────────────

export interface ComposerSyncResult {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  /** Maps shapeId:localIndex → generated axNodeId */
  vertexToNodeId: Map<string, string>;
}

/**
 * Generate BubbleGraph nodes/edges from composer shapes.
 *
 * @param shapes      All RoomX shapes (sorted by createdAt for FCFS)
 * @param storeyId    The storey to parent the generated ax nodes to
 * @param snapThreshold  Distance threshold for merge (mm)
 */
export function syncComposerToGraph(
  shapes: RoomXShape[],
  storeyId: string | null,
  snapThreshold: number,
): ComposerSyncResult {
  // Sort by creation time (FCFS)
  const sorted = [...shapes].sort((a, b) => a.createdAt - b.createdAt);

  // Phase 1: Assign ax node IDs to vertices (merge by position proximity)
  const positionToNodeId = new Map<string, string>(); // posKey → nodeId
  const vertexToNodeId = new Map<string, string>();   // "shapeId:localIndex" → nodeId
  const nodesMap = new Map<string, BubbleGraphNode>(); // nodeId → node

  let nodeCounter = 0;

  for (const shape of sorted) {
    for (const vertex of shape.vertices) {
      const vKey = `${shape.id}:${vertex.localIndex}`;

      // Check if there's an existing node nearby (snap merge)
      let mergedNodeId: string | null = null;
      for (const [existingKey, existingId] of positionToNodeId) {
        const [exStr, eyStr] = existingKey.split(',');
        const ex = Number(exStr);
        const ey = Number(eyStr);
        const d = Math.hypot(vertex.x - ex, vertex.y - ey);
        if (d < snapThreshold) {
          mergedNodeId = existingId;
          break;
        }
      }

      if (mergedNodeId) {
        // Merge: reuse existing node
        vertexToNodeId.set(vKey, mergedNodeId);
      } else {
        // New node
        const nodeId = `composer-ax-${nodeCounter++}`;
        const vp = vertex.properties;
        const node: BubbleGraphNode = {
          id: nodeId,
          type: 'ax',
          name: vp?.label || `V${nodeCounter - 1}`,
          x: vertex.x,
          y: vertex.y,
          z: 0,
          properties: {
            gridX: 0, // Will be computed after all nodes are placed
            gridY: 0,
            axNodeIndex: nodeCounter - 1,
            has_column: vp?.has_column ? 'True' : 'False',
            column_type: vp?.column_type ?? 'C25x25',
            bimX: vertex.x,   // Direct BIM mm coordinate (used by getAxRealPos)
            bimY: -vertex.y,  // Negate SVG Y-down → BIM Y-north (up on canvas = north = positive BIM Y)
            composerSource: `${shape.id}:${vertex.localIndex}`,
            ...(vp?.offsetX ? { offsetX: vp.offsetX } : {}),
            ...(vp?.offsetY ? { offsetY: vp.offsetY } : {}),
            ...(vp?.offsetBase ? { offsetBase: vp.offsetBase } : {}),
            ...(vp?.offsetTop ? { offsetTop: vp.offsetTop } : {}),
            ...(vp?.material ? { material: vp.material } : {}),
            ...(vp?.color_3d ? { color_3d: vp.color_3d } : {}),
            ...(vp?.color_2d ? { color_2d: vp.color_2d } : {}),
          },
          parentId: storeyId ?? undefined,
        };
        nodesMap.set(nodeId, node);
        positionToNodeId.set(posKey(vertex.x, vertex.y), nodeId);
        vertexToNodeId.set(vKey, nodeId);
      }
    }
  }

  // Phase 2: Generate wall/beam nodes + edges (skip merged duplicates)
  const edgeSet = new Set<string>(); // "fromNodeId→toNodeId" for dedup
  const edges: BubbleGraphEdge[] = [];
  let edgeCounter = 0;
  let wallCounter = 0;
  let beamCounter = 0;

  for (const shape of sorted) {
    for (const edgeCfg of shape.edges) {
      const fromKey = `${shape.id}:${edgeCfg.from}`;
      const toKey = `${shape.id}:${edgeCfg.to}`;
      const fromNodeId = vertexToNodeId.get(fromKey);
      const toNodeId = vertexToNodeId.get(toKey);
      if (!fromNodeId || !toNodeId) continue;
      if (fromNodeId === toNodeId) continue; // Collapsed edge (both merged to same)

      // Canonical edge key (undirected)
      const ek = fromNodeId < toNodeId
        ? `${fromNodeId}→${toNodeId}`
        : `${toNodeId}→${fromNodeId}`;

      if (edgeSet.has(ek)) continue; // FCFS: first edge wins
      edgeSet.add(ek);

      const hasWall = edgeCfg.has_wall ?? true;
      const hasBeam = edgeCfg.has_beam ?? true;

      // ── Generate wall node ──────────────────────────────────────────────
      if (hasWall) {
        const wallId = `composer-wall-${wallCounter++}`;
        const wallThickCm = Math.round((edgeCfg.wallConfig?.thickness ?? 200) / 10);
        const wallHeightMm = edgeCfg.wallConfig?.height ?? 3000;

        const wallProps: Record<string, unknown> = {
          wall_type: `W${wallThickCm}`,
          height: wallHeightMm,
          material: edgeCfg.wallConfig?.material ?? 'concrete',
          offset_start: 0,
          offset_end: 0,
        };

        // Embedded beam (runs along wall top)
        if (hasBeam) {
          const bw = edgeCfg.beamConfig?.width ?? 300;
          const bh = edgeCfg.beamConfig?.height ?? 600;
          wallProps.has_beam = 'True';
          wallProps.beam_section = `B${Math.round(bw / 10)}x${Math.round(bh / 10)}`;
          wallProps.beam_material = edgeCfg.beamConfig?.material ?? 'concrete';
        }

        // Inline windows
        const hasWindow = edgeCfg.has_window ?? false;
        if (hasWindow && edgeCfg.windowConfig) {
          wallProps.has_windows = 'True';
          wallProps.windows = JSON.stringify([{
            id: `inl_win_${wallId}_0`,
            window_type: edgeCfg.windowConfig.window_type,
            sill_height: edgeCfg.windowConfig.sill_height,
            wall_offset: edgeCfg.windowConfig.wall_offset || null,
            count: edgeCfg.windowConfig.count,
            spacing: edgeCfg.windowConfig.spacing || null,
          }]);
        } else {
          wallProps.has_windows = 'False';
          wallProps.windows = '[]';
        }

        // Inline doors
        const hasDoor = edgeCfg.has_door ?? false;
        if (hasDoor && edgeCfg.doorConfig) {
          wallProps.has_doors = 'True';
          wallProps.doors = JSON.stringify([{
            id: `inl_door_${wallId}_0`,
            door_type: edgeCfg.doorConfig.door_type,
            wall_offset: edgeCfg.doorConfig.wall_offset || null,
            count: edgeCfg.doorConfig.count,
          }]);
        } else {
          wallProps.has_doors = 'False';
          wallProps.doors = '[]';
        }

        const wallNode: BubbleGraphNode = {
          id: wallId,
          type: 'wall',
          name: `Wall ${wallCounter}`,
          x: 0, y: 0, z: 0,
          properties: { ...wallProps, composerSource: wallId },
          parentId: storeyId ?? undefined,
        };
        nodesMap.set(wallId, wallNode);

        // Edges: wall → endpoint A, wall → endpoint B
        edges.push({ id: `composer-edge-${edgeCounter++}`, from: wallId, to: fromNodeId });
        edges.push({ id: `composer-edge-${edgeCounter++}`, from: wallId, to: toNodeId });
      } else if (hasBeam) {
        // ── Standalone beam node (no wall on this edge) ─────────────────────
        const beamId = `composer-beam-${beamCounter++}`;
        const bw = edgeCfg.beamConfig?.width ?? 300;
        const bh = edgeCfg.beamConfig?.height ?? 600;

        const beamNode: BubbleGraphNode = {
          id: beamId,
          type: 'beam',
          name: `Beam ${beamCounter}`,
          x: 0, y: 0, z: 0,
          properties: {
            beam_section: `B${Math.round(bw / 10)}x${Math.round(bh / 10)}`,
            material: edgeCfg.beamConfig?.material ?? 'concrete',
            offset_start: 0,
            offset_end: 0,
            composerSource: beamId,
          },
          parentId: storeyId ?? undefined,
        };
        nodesMap.set(beamId, beamNode);

        // Edges: beam → endpoint A, beam → endpoint B
        edges.push({ id: `composer-edge-${edgeCounter++}`, from: beamId, to: fromNodeId });
        edges.push({ id: `composer-edge-${edgeCounter++}`, from: beamId, to: toNodeId });
      } else {
        // Edge-only (no geometry), just a direct link between ax nodes
        edges.push({ id: `composer-edge-${edgeCounter++}`, from: fromNodeId, to: toNodeId });
      }
    }
  }

  // Phase 3: Compute gridX/gridY from actual positions (ax nodes only)
  const allAxNodes = Array.from(nodesMap.values()).filter((n) => n.type === 'ax');
  const allX = [...new Set(allAxNodes.map((n) => n.x))].sort((a, b) => a - b);
  const allY = [...new Set(allAxNodes.map((n) => n.y))].sort((a, b) => a - b);

  for (const node of allAxNodes) {
    node.properties.gridX = allX.indexOf(node.x);
    node.properties.gridY = allY.indexOf(node.y);
    node.properties.axNodeIndex = (node.properties.gridY as number) * allX.length + (node.properties.gridX as number);
  }

  return { nodes: Array.from(nodesMap.values()), edges, vertexToNodeId };
}

/**
 * Detect which vertices across shapes are effectively merged (same position within threshold).
 * Returns a map of "shapeId:localIndex" → "ownerShapeId:ownerLocalIndex" for non-owners.
 */
export function detectMergedVertices(
  shapes: RoomXShape[],
  snapThreshold: number,
): Map<string, string> {
  const sorted = [...shapes].sort((a, b) => a.createdAt - b.createdAt);
  const mergeMap = new Map<string, string>(); // non-owner → owner
  const owners: { key: string; x: number; y: number }[] = [];

  for (const shape of sorted) {
    for (const v of shape.vertices) {
      const vKey = `${shape.id}:${v.localIndex}`;
      let foundOwner: string | null = null;
      for (const owner of owners) {
        if (Math.hypot(v.x - owner.x, v.y - owner.y) < snapThreshold) {
          foundOwner = owner.key;
          break;
        }
      }
      if (foundOwner) {
        mergeMap.set(vKey, foundOwner);
      } else {
        owners.push({ key: vKey, x: v.x, y: v.y });
      }
    }
  }

  return mergeMap;
}
