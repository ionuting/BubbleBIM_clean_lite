/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * structuralSystem.ts — the structural system as a first-class, controlled
 * value instead of a string smeared across ad-hoc node properties.
 *
 * WHY
 * ---
 * How an element is BUILT is not a property of the element — it follows from
 * a system decision. The same architectural wall becomes three completely
 * different construction processes as confined masonry, as infill in an RC
 * frame, or as timber framing. Until now that decision lived implicitly in
 * per-node strings (`wall_type: 'W30'`, `material`, `roof_type`), so it could
 * be neither queried nor switched wholesale.
 *
 * RESOLUTION
 * ----------
 * Project default, overridable per element:
 *
 *     element.properties.structural_system   →  most specific, wins
 *     project.structuralSystem               →  the default
 *     'unset'                                →  nothing chosen yet
 *
 * This deliberately mirrors the fallback `findMappingRules()` already uses in
 * the norms catalog (exact elementTypeId → '*' wildcard), so the codebase has
 * ONE resolution idea rather than two competing ones.
 *
 * VOCABULARY
 * ----------
 * Closed set. That is the entire point: free-form strings across many
 * projects produce 'beton' / 'beton armat' / 'C20/25' / 'BA' in one column and
 * make cross-project analysis worthless. Adding a system is a deliberate edit
 * here, not something a user types into a text box.
 */

import type { BubbleGraphNode } from '@/store';

export type StructuralSystem =
  | 'confined_masonry'   // zidărie confinată (sâmburi + centuri)
  | 'rc_frame'           // cadre din beton armat
  | 'rc_shear_wall'      // diafragme / pereți structurali din beton armat
  | 'timber_frame'       // structură din lemn (platform framing)
  | 'clt'                // panouri de lemn încleiat încrucișat
  | 'steel_frame'        // structură metalică
  | 'precast'            // prefabricat din beton
  | 'unset';             // nedecis — NOT a system, an explicit absence

export const STRUCTURAL_SYSTEMS: readonly StructuralSystem[] = [
  'confined_masonry', 'rc_frame', 'rc_shear_wall', 'timber_frame', 'clt', 'steel_frame', 'precast', 'unset',
] as const;

export const STRUCTURAL_SYSTEM_LABELS: Record<StructuralSystem, string> = {
  confined_masonry: 'Zidărie confinată',
  rc_frame:         'Cadre beton armat',
  rc_shear_wall:    'Diafragme beton armat',
  timber_frame:     'Structură lemn',
  clt:              'Panouri CLT',
  steel_frame:      'Structură metalică',
  precast:          'Prefabricat beton',
  unset:            'Nedefinit',
};

/** Short note shown next to each option — what the choice actually implies. */
export const STRUCTURAL_SYSTEM_HINTS: Record<StructuralSystem, string> = {
  confined_masonry: 'Zidărie portantă cu sâmburi și centuri din beton armat',
  rc_frame:         'Stâlpi și grinzi din beton armat, pereți de închidere neportanți',
  rc_shear_wall:    'Pereți structurali din beton armat turnat',
  timber_frame:     'Montanți, tălpi și rigle din lemn',
  clt:              'Panouri masive din lemn încleiat încrucișat, prefabricate și montate cu macaraua',
  steel_frame:      'Profile metalice, îmbinări sudate sau cu șuruburi',
  precast:          'Elemente turnate în fabrică și montate pe șantier',
  unset:            'Fără sistem ales — descompunerea pe procese nu se poate deduce',
};

export const DEFAULT_STRUCTURAL_SYSTEM: StructuralSystem = 'unset';

/** Property key carrying a per-element override. */
export const SYSTEM_PROPERTY_KEY = 'structural_system';

/** Narrow an untrusted value (saved JSON, imported file) to a known system. */
export function parseStructuralSystem(value: unknown): StructuralSystem | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return (STRUCTURAL_SYSTEMS as readonly string[]).includes(v)
    ? (v as StructuralSystem)
    : undefined;
}

/**
 * The system in force for one element: its own override, else the project
 * default, else 'unset'.
 *
 * An unrecognised override is IGNORED rather than propagated — a typo in a
 * hand-edited file must not silently create a seventh system and poison the
 * controlled vocabulary this module exists to protect.
 */
export function resolveStructuralSystem(
  node: BubbleGraphNode | undefined,
  projectSystem: StructuralSystem | undefined,
): StructuralSystem {
  return parseStructuralSystem(node?.properties?.[SYSTEM_PROPERTY_KEY])
    ?? parseStructuralSystem(projectSystem)
    ?? DEFAULT_STRUCTURAL_SYSTEM;
}

/** True when this element carries its own system, distinct from the project default. */
export function hasSystemOverride(
  node: BubbleGraphNode | undefined,
  projectSystem: StructuralSystem | undefined,
): boolean {
  const own = parseStructuralSystem(node?.properties?.[SYSTEM_PROPERTY_KEY]);
  if (!own) return false;
  return own !== (parseStructuralSystem(projectSystem) ?? DEFAULT_STRUCTURAL_SYSTEM);
}

/**
 * Count elements per system across a graph — the first genuinely mineable
 * question this makes answerable ("what is this building actually made of?"),
 * and what a mixed-system project looks like from the outside.
 */
export function summarizeSystems(
  nodes: BubbleGraphNode[],
  projectSystem: StructuralSystem | undefined,
): Map<StructuralSystem, number> {
  const out = new Map<StructuralSystem, number>();
  for (const n of nodes) {
    const sys = resolveStructuralSystem(n, projectSystem);
    out.set(sys, (out.get(sys) ?? 0) + 1);
  }
  return out;
}
