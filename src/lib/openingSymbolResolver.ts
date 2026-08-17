import { resolveAutoSymbol } from '@/lib/bglibSymbolStore';
import {
  resolveSymbolDef,
  type SvgSymbolDef,
} from '@/lib/svgSymbolStore';

export type OpeningSymbolSource = 'dxf' | 'custom' | 'procedural';

export interface ResolvedOpeningSymbol {
  source: OpeningSymbolSource;
  def?: SvgSymbolDef;
}

/**
 * Resolve the 2D symbol source for an opening in floor-plan view.
 * Priority: DXF (bglib) → custom SvgSymbolDef → procedural fallback.
 */
export function resolveOpeningSymbol2D(
  elementType: 'window' | 'door',
  typeId: string,
  familyKey: string,
  viewType: 'floorplan' | 'section' | 'elevation' = 'floorplan',
): ResolvedOpeningSymbol {
  if (resolveAutoSymbol(elementType, typeId)
    ?? resolveAutoSymbol(elementType, familyKey.replace(':', '_'))) {
    return { source: 'dxf' };
  }

  const custom = resolveSymbolDef(elementType, typeId, viewType)
    ?? resolveSymbolDef(elementType, familyKey, viewType);

  if (custom) return { source: 'custom', def: custom };

  return { source: 'procedural' };
}
