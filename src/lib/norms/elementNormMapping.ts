/**
 * elementNormMapping.ts — Links BubbleGraph node types + elementLibrary ids to norm articles.
 *
 * Extend by adding rules here; the takeoff engine matches top-to-bottom (first match wins
 * per output, but multiple rules can apply if elementTypeId differs).
 */

import type { NormMappingRule } from './types';
import {
  WALL_TYPES,
  BEAM_TYPES,
  COLUMN_TYPES,
  SLAB_TYPES,
  FOUNDATION_TYPES,
} from '@/lib/elementLibrary';

// ─── Concrete wall types (beton) ──────────────────────────────────────────────
const CONCRETE_WALL_IDS = WALL_TYPES
  .filter((t) => /beton/i.test(t.material))
  .map((t) => t.id);

// ─── Drywall types (gips-carton) ──────────────────────────────────────────────
const DRYWALL_WALL_IDS = WALL_TYPES
  .filter((t) => /gips/i.test(t.material))
  .map((t) => t.id);

function wallRules(ids: string[], outputs: NormMappingRule['outputs']): NormMappingRule[] {
  return ids.map((elementTypeId) => ({
    nodeType: 'wall',
    elementTypeId,
    outputs,
  }));
}

/** All mapping rules, evaluated in order. */
export const ELEMENT_NORM_MAPPING: NormMappingRule[] = [
  // ── Pereți beton ───────────────────────────────────────────────────────────
  ...wallRules(CONCRETE_WALL_IDS, [
    { normId: 'C-4.1.01', measure: 'volume' },
    { normId: 'C-4.2.01', measure: 'area', netOfOpenings: true },
  ]),

  // ── Pereți cărămidă ────────────────────────────────────────────────────────
  { nodeType: 'wall', elementTypeId: 'W15', outputs: [{ normId: 'C-5.1.01', measure: 'area', netOfOpenings: true }] },
  { nodeType: 'wall', elementTypeId: 'W20', outputs: [{ normId: 'C-5.1.02', measure: 'area', netOfOpenings: true }] },
  { nodeType: 'wall', elementTypeId: 'W25', outputs: [{ normId: 'C-5.1.03', measure: 'area', netOfOpenings: true }] },

  // ── Pereți gips-carton ─────────────────────────────────────────────────────
  ...wallRules(DRYWALL_WALL_IDS, [
    { normId: 'C-6.1.01', measure: 'area', netOfOpenings: true },
  ]),

  // ── Stâlpi ─────────────────────────────────────────────────────────────────
  ...COLUMN_TYPES.map((t): NormMappingRule => ({
    nodeType: 'column',
    elementTypeId: t.id,
    outputs: [
      { normId: 'C-4.1.02', measure: 'volume' },
      { normId: 'C-4.2.02', measure: 'formula', formula: 'perimeter_m * height_m' },
    ],
  })),

  // ── Stâlpi pe axă (has_column) ─────────────────────────────────────────────
  ...COLUMN_TYPES.map((t): NormMappingRule => ({
    nodeType: 'ax',
    elementTypeId: t.id,
    outputs: [
      { normId: 'C-4.1.02', measure: 'volume' },
      { normId: 'C-4.2.02', measure: 'formula', formula: 'perimeter_m * height_m' },
    ],
  })),

  // ── Grinzi ─────────────────────────────────────────────────────────────────
  ...BEAM_TYPES.map((t): NormMappingRule => ({
    nodeType: 'beam',
    elementTypeId: t.id,
    outputs: [
      { normId: 'C-4.1.03', measure: 'volume' },
      { normId: 'C-4.2.03', measure: 'formula', formula: '2 * (width_m + height_m) * length_m' },
    ],
  })),

  // ── Plăci ──────────────────────────────────────────────────────────────────
  ...SLAB_TYPES.map((t): NormMappingRule => ({
    nodeType: 'slab',
    elementTypeId: t.id,
    outputs: [
      { normId: 'C-4.1.04', measure: 'volume' },
      { normId: 'C-4.2.04', measure: 'area' },
    ],
  })),

  // ── Fundații ───────────────────────────────────────────────────────────────
  ...FOUNDATION_TYPES.map((t): NormMappingRule => ({
    nodeType: 'foundation',
    elementTypeId: t.id,
    outputs: [
      {
        normId: /C20/i.test(t.material) ? 'C-4.1.05' : 'C-4.1.06',
        measure: 'volume',
      },
      { normId: 'C-4.2.05', measure: 'formula', formula: '2 * (width_m + depth_m) * height_m + width_m * depth_m' },
    ],
  })),

  // ── Ferestre ───────────────────────────────────────────────────────────────
  {
    nodeType: 'window',
    elementTypeId: '*',
    materialFilter: 'PVC',
    outputs: [{ normId: 'C-7.1.01', measure: 'count' }],
  },
  {
    nodeType: 'window',
    elementTypeId: '*',
    materialFilter: 'Lemn',
    outputs: [{ normId: 'C-7.1.02', measure: 'count' }],
  },
  {
    nodeType: 'window',
    elementTypeId: '*',
    outputs: [{ normId: 'C-7.1.01', measure: 'count' }],
  },

  // ── Uși ────────────────────────────────────────────────────────────────────
  {
    nodeType: 'door',
    elementTypeId: '*',
    outputs: [{ normId: 'C-7.2.01', measure: 'count' }],
  },

  // ── Camere — tencuială interioară (perimetru × înălțime, starter) ─────────
  {
    nodeType: 'room',
    elementTypeId: '*',
    outputs: [
      { normId: 'C-6.1.02', measure: 'formula', formula: 'perimeter_m * height_m' },
    ],
  },
];

/**
 * Find mapping rules for the Indicator C starter catalog.
 * @internal Use `findMappingRules` from `catalog.ts` for the active catalog.
 */
export function findIndicatorMappingRules(
  nodeType: string,
  elementTypeId: string,
  material?: string,
): NormMappingRule[] {
  const candidates = ELEMENT_NORM_MAPPING.filter(
    (r) => r.nodeType === nodeType
      && (r.elementTypeId === elementTypeId || r.elementTypeId === '*'),
  );
  if (candidates.length === 0) return [];

  const exactId = candidates.filter((r) => r.elementTypeId === elementTypeId);
  const pool = exactId.length > 0 ? exactId : candidates;

  if (material) {
    const withMat = pool.filter((r) => r.materialFilter && material.includes(r.materialFilter));
    if (withMat.length > 0) return withMat;
  }

  const noFilter = pool.filter((r) => !r.materialFilter);
  return noFilter.length > 0 ? noFilter : pool;
}
