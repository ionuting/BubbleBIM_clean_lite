/**
 * elementNormMappingZidarieConfinata.ts
 *
 * Mapări BIM → articole deviz pentru case din zidărie confinată,
 * conform categoriilor din DEVIZ PE CATEGORII.ods.
 */

import type { NormMappingRule } from './types';
import { WALL_TYPES, COLUMN_TYPES, BEAM_TYPES, FOUNDATION_TYPES } from '@/lib/elementLibrary';

/**
 * Materiale de zidărie/beton structural, în AMBELE limbi.
 *
 * ⚠️ `elementLibrary` ține materialul ca text liber afișabil, iar acest text a fost
 * deja tradus o dată (ro → en: „Caramida"→"Brick", „Beton"→"Concrete"). O potrivire
 * într-o singură limbă lasă `MASONRY_WALL_IDS` gol → zero reguli pentru pereți →
 * zidăria dispare tăcut din deviz. Potrivim bilingv, iar testele de acoperire
 * (`mappingCoverage.test.ts`) blochează regresia dacă lista redevine goală.
 */
const MASONRY_MATERIAL_RE = /caramid|brick|beton|concrete/i;

/** Pereți structurali din zidărie (cărămidă / blocuri ceramice). */
const MASONRY_WALL_IDS = WALL_TYPES
  .filter((t) => MASONRY_MATERIAL_RE.test(t.material))
  .map((t) => t.id);

/** Articole comune beton armat (stalpișori / centuri) — raport armătură din deviz exemplu. */
const BETON_ARMAT_OUTPUTS = (prefix: string): NormMappingRule['outputs'] => [
  { normId: `${prefix}_CA01D_02`, measure: 'volume' },
  { normId: `${prefix}_CB01C_02`, measure: 'formula', formula: 'perimeter_m * height_m' },
  { normId: `${prefix}_CC01A4_02`, measure: 'formula', formula: 'volume_m3 * 61.5' },
  { normId: `${prefix}_CC01A1_02`, measure: 'formula', formula: 'volume_m3 * 30.8' },
];

function wallRules(ids: string[], outputs: NormMappingRule['outputs']): NormMappingRule[] {
  return ids.map((elementTypeId) => ({ nodeType: 'wall', elementTypeId, outputs }));
}

export const ZIDARIE_CONFINATA_MAPPING: NormMappingRule[] = [
  // ── Zidărie — pereți structurali Porotherm (mc) ───────────────────────────
  ...wallRules(MASONRY_WALL_IDS, [
    { normId: '0001_00201A01_02', measure: 'volume' },
  ]),

  // ── Hidroizolație la soclu (mp) — fundații ─────────────────────────────────
  ...FOUNDATION_TYPES.map((t): NormMappingRule => ({
    nodeType: 'foundation',
    elementTypeId: t.id,
    outputs: [
      { normId: '0016_RPCE26A_09', measure: 'formula', formula: '2 * (width_m + depth_m) * height_m' },
      { normId: '0016_CD03A_02', measure: 'volume' },
      { normId: '0016_00301E_02', measure: 'formula', formula: '2 * (width_m + depth_m) * height_m' },
    ],
  })),

  // ── Stalpișori ─────────────────────────────────────────────────────────────
  ...COLUMN_TYPES.map((t): NormMappingRule => ({
    nodeType: 'column',
    elementTypeId: t.id,
    outputs: BETON_ARMAT_OUTPUTS('0002'),
  })),
  ...COLUMN_TYPES.map((t): NormMappingRule => ({
    nodeType: 'ax',
    elementTypeId: t.id,
    outputs: BETON_ARMAT_OUTPUTS('0002'),
  })),

  // ── Centuri (grinzi) ─────────────────────────────────────────────────────
  ...BEAM_TYPES.map((t): NormMappingRule => ({
    nodeType: 'beam',
    elementTypeId: t.id,
    outputs: BETON_ARMAT_OUTPUTS('0003'),
  })),

  // ── Finisaje camere ────────────────────────────────────────────────────────
  {
    nodeType: 'room',
    elementTypeId: '*',
    outputs: [
      { normId: '0011_CF24A_02', measure: 'formula', formula: 'perimeter_m * height_m' },
      { normId: '0011_CF06B1_82', measure: 'formula', formula: 'perimeter_m * height_m' },
      { normId: '0012_00107A011_02', measure: 'formula', formula: 'perimeter_m * height_m' },
      { normId: '0013_CN05A_02', measure: 'formula', formula: 'perimeter_m * height_m' },
      { normId: '0013_CN11A_02', measure: 'formula', formula: 'perimeter_m * height_m' },
    ],
  },

  // ── Glafuri ferestre (ml) ──────────────────────────────────────────────────
  {
    nodeType: 'window',
    elementTypeId: '*',
    outputs: [
      { normId: '0015_CK26A_02', measure: 'formula', formula: 'width_m * 2 + height_m' },
    ],
  },
];
