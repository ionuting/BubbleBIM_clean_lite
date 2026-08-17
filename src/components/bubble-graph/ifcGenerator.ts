/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BubbleGraph → IFC converter.
 *
 * Real IFC4 STEP export via `@ifc-lite/create` (Louis Trümpler's Rust/WASM
 * `ifc-lite` toolkit — see `src/lib/ifc/buildIfcModel.ts` for the node→IFC
 * mapping and its documented v1 scope).
 */

import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { buildIfcModel } from '@/lib/ifc/buildIfcModel';

/**
 * Generate an IFC STEP file from BubbleGraph nodes and edges.
 * Returns a File object ready for download.
 */
export function generateIfcFromGraph(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  projectName = 'Untitled Project',
  _buildingAxes?: { xValues: number[]; yValues: number[] },
): File {
  const { content, stats } = buildIfcModel(nodes, edges, projectName);
  console.info(`[ifc] generated ${stats.entityCount} entities, ${(stats.fileSize / 1024).toFixed(1)} KB`);

  const blob = new Blob([content], { type: 'application/x-step' });
  return new File([blob], `${projectName}.ifc`, { type: 'application/x-step' });
}
