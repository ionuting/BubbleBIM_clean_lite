/**
 * roles.ts — what a swept profile IS, as distinct from what shape it has.
 *
 * WHY
 * ---
 * `shell/region.ts` already states the principle, for shells:
 *
 *   > The ROLE is the element type: an envelope and a beam grid are the same
 *   > geometry decomposed into completely different work.
 *
 * A sweep is the same case, and worse. A cornice, a plinth, a skirting, a
 * handrail and a concrete beam can all be the identical polygon dragged along
 * a line. Until now the quantity engine keyed sweeps on `properties.profile` —
 * the PROFILE id — so a cornice and a handrail drawn with the same profile
 * billed identically, and the IFC exporter guessed a class from the direction
 * of travel: vertical meant column, anything else meant beam.
 *
 * A role fixes both, and it is the vocabulary a style system will later map
 * onto: a style says "this building's cornice is CORN-NEO-30", which only makes
 * sense once something can be a cornice.
 *
 * WHAT
 * ----
 * A controlled value with a label, a hint, an IFC class and an orientation
 * affinity. `generic` is the default and keeps the old direction heuristic, so
 * every existing sweep behaves exactly as it did.
 *
 * Pure data: no store, no React, no geometry.
 */

import type { BubbleGraphNode } from '@/store';
import type { SweepDiagnostic, SweepPathKind } from './types';

export type SweepRole =
  // Structure — what sweeps are mostly used for today.
  | 'generic' | 'beam' | 'column'
  // Mouldings that run horizontally along a facade.
  | 'cornice' | 'plinth' | 'band' | 'coping'
  // Mouldings that frame an opening.
  | 'architrave' | 'sill'
  // Vertical articulation.
  | 'pilaster'
  // Roof edge and rainwater.
  | 'eaves' | 'gutter'
  // Circulation.
  | 'handrail';

export const SWEEP_ROLES: readonly SweepRole[] = [
  'generic', 'beam', 'column',
  'cornice', 'plinth', 'band', 'coping',
  'architrave', 'sill',
  'pilaster',
  'eaves', 'gutter',
  'handrail',
];

export const DEFAULT_SWEEP_ROLE: SweepRole = 'generic';

export const SWEEP_ROLE_LABELS: Record<SweepRole, string> = {
  generic:    'Nedeclarat',
  beam:       'Grindă',
  column:     'Stâlp',
  cornice:    'Cornișă',
  plinth:     'Soclu',
  band:       'Brâu',
  coping:     'Șapcă / copertină atic',
  architrave: 'Ancadrament',
  sill:       'Glaf / solbanc',
  pilaster:   'Pilastru / lesenă',
  eaves:      'Streașină / pazie',
  gutter:     'Jgheab',
  handrail:   'Mână curentă',
};

export const SWEEP_ROLE_HINTS: Record<SweepRole, string> = {
  generic:    'Profil tras, fără scop declarat — clasa IFC se ghicește din direcție',
  beam:       'Element structural orizontal; se măsoară la volum',
  column:     'Element structural vertical; se măsoară la volum',
  cornice:    'Profilatura de sub streașină; se măsoară la metru liniar',
  plinth:     'Banda de la baza fațadei, de obicei alt finisaj decât câmpul',
  band:       'Brâu orizontal care marchează un nivel pe fațadă',
  coping:     'Capacul aticului sau al parapetului — scoate apa de pe zid',
  architrave: 'Chenarul din jurul unui gol de fereastră sau ușă',
  sill:       'Glaful de sub fereastră; panta și lăcrimarul se dau din profil',
  pilaster:   'Element vertical aplicat pe fațadă, cu rol de ritm, nu portant',
  eaves:      'Muchia acoperișului — pazie, astereală aparentă',
  gutter:     'Jgheab de scurgere; se măsoară la metru liniar',
  handrail:   'Mâna curentă a unei balustrade sau rampe',
};

/**
 * Which way a role is normally dragged.
 *
 * Not enforced — a cornice up a gable really is raked, and a pilaster really
 * does climb with a ramp. It drives a warning, not a refusal.
 */
export type RoleOrientation = 'horizontal' | 'vertical' | 'any';

export const SWEEP_ROLE_ORIENTATION: Record<SweepRole, RoleOrientation> = {
  generic:    'any',
  beam:       'horizontal',
  column:     'vertical',
  cornice:    'horizontal',
  plinth:     'horizontal',
  band:       'horizontal',
  coping:     'horizontal',
  architrave: 'any',        // frames a gol: runs up the jambs AND across the head
  sill:       'horizontal',
  pilaster:   'vertical',
  eaves:      'any',         // level along the eaves, raked up a verge
  gutter:     'horizontal',
  handrail:   'any',         // level on a landing, raked on a flight
};

/**
 * The IFC class a role exports as.
 *
 * `null` means "keep the direction heuristic" — that is what every sweep did
 * before roles existed, and `generic` must not change behaviour.
 *
 * Mouldings are IFCCOVERING because that is what IFC4 calls applied surface
 * work, and its PredefinedType includes MOLDING. A pilaster is IFCCOLUMN
 * because IfcColumnTypeEnum has PILASTER, decorative or not.
 */
export const SWEEP_ROLE_IFC: Record<SweepRole, string | null> = {
  generic:    null,
  beam:       'IFCBEAM',
  column:     'IFCCOLUMN',
  cornice:    'IFCCOVERING',
  plinth:     'IFCCOVERING',
  band:       'IFCCOVERING',
  coping:     'IFCCOVERING',
  architrave: 'IFCCOVERING',
  sill:       'IFCCOVERING',
  pilaster:   'IFCCOLUMN',
  eaves:      'IFCMEMBER',
  gutter:     'IFCPIPESEGMENT',
  handrail:   'IFCRAILING',
};

export function parseSweepRole(v: unknown): SweepRole | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return (SWEEP_ROLES as readonly string[]).includes(s) ? (s as SweepRole) : undefined;
}

/** The role of a sweep node. Anything unrecognised reads as `generic`. */
export const sweepRole = (node: BubbleGraphNode | undefined): SweepRole =>
  parseSweepRole(node?.properties?.sweep_role) ?? DEFAULT_SWEEP_ROLE;

/**
 * The IFC class for a role, falling back to the direction heuristic the
 * exporter has always used.
 */
export function ifcTypeForRole(role: SweepRole, kind: SweepPathKind): string {
  return SWEEP_ROLE_IFC[role] ?? (kind === 'vertical' ? 'IFCCOLUMN' : 'IFCBEAM');
}

/**
 * Warn when a role is dragged the wrong way — a horizontal cornice sent up a
 * wall is nearly always a mis-wired anchor, and the geometry alone cannot say
 * so. A raked path satisfies neither affinity strictly, so it is let through:
 * raked cornices and raked handrails are both ordinary.
 */
export function roleOrientationDiagnostic(
  role: SweepRole,
  kind: SweepPathKind,
): SweepDiagnostic | null {
  const want = SWEEP_ROLE_ORIENTATION[role];
  if (want === 'any' || kind === 'raked') return null;
  if (want === kind) return null;
  const label = SWEEP_ROLE_LABELS[role];
  return {
    code: 'ROLE_ORIENTATION',
    severity: 'warning',
    message: kind === 'vertical'
      ? `„${label}" e un element orizontal, dar traseul e vertical — verifică axele la care e legat.`
      : `„${label}" e un element vertical, dar traseul e orizontal — verifică axele la care e legat.`,
  };
}
