/**
 * ifcCoverage.ts — which graph node types reach the IFC export as elements.
 *
 * A viewer that draws the model from the exported IFC (IFC Tiles; That Open
 * through its IfcLoader) must not also draw these from its own geometry, or
 * every wall would be there twice. What is NOT in this set — storey planes,
 * axis markers without a column, the site's terrain, scatter, library objects —
 * the export does not write, so those viewers keep drawing them themselves.
 */
import { ROOF_LINEAR_DETAIL_TYPES, ROOF_ROUND_DETAIL_TYPES, ROOF_SHEET_DETAIL_TYPES } from '@/lib/roof/types';

export const IFC_EXPORTED_NODE_TYPES = new Set<string>([
  'wall', 'column', 'ax', 'beam', 'slab', 'foundation', 'room', 'shell', 'covering', 'roof',
  'window', 'door', 'dormer', 'stairwell', 'sweep', 'sketch', 'facade', 'dome', 'dome_panel',
  'rafter', 'hip_rafter', 'valley_rafter', 'ridge_beam', 'wall_plate', 'post', 'purlin', 'tie_beam', 'collar_tie',
  ...ROOF_LINEAR_DETAIL_TYPES, ...ROOF_ROUND_DETAIL_TYPES, ...ROOF_SHEET_DETAIL_TYPES,
]);

/** The graph node an IFC Tag points at — BubbleBIM writes `nodeId` or `nodeId:part`. */
export const nodeIdOfTag = (tag: unknown): string | null => {
  const s = typeof tag === 'string' ? tag : tag == null ? '' : String(tag);
  return s ? s.split(':')[0] || null : null;
};
