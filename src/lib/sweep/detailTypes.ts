/**
 * detailTypes.ts — named sweeps, the way `WALL_TYPES` names walls.
 *
 * WHY
 * ---
 * `roles.ts` says WHAT a sweep is; this says what it LOOKS like. Setting up a
 * cornice by hand means picking a profile, typing two or three dimensions,
 * choosing both anchors and two offsets — six or seven fields, every time, and
 * the anchors are the easy ones to get wrong: a cornice hung by its centre sits
 * half inside the wall.
 *
 * A detail type is one pick that fills all of them. It is also the vocabulary a
 * style will map onto later — a style is, in the end, a table saying which
 * detail type fills which role. That table cannot be written until the types
 * have names.
 *
 * WHAT
 * ----
 * Plain data plus `detailTypeProperties`, which returns the property patch to
 * merge into a sweep node. Nothing here touches geometry: the patch goes
 * through `parseSweepIntent` like anything a user typed.
 *
 * The built-in list is deliberately thin, and all of it is parametric. A real
 * moulding is a drawn profile — `p_*` dimensions cannot describe an ovolo — and
 * the profile editor now writes those into the library. These are the starting
 * points, not the catalogue.
 */

import type { SweepAnchor, SweepLevel } from './types';
import type { SweepRole } from './roles';

export interface DetailType {
  /** Stable id, stored on the node as `detail_type`. */
  id: string;
  label: string;
  role: SweepRole;
  /** A profile id: parametric ('rect'), catalogue ('cat:…') or drawn ('dxf:…'). */
  profileId: string;
  /** The `p_*` dimensions this profile needs. */
  params: Record<string, number>;
  /** Where the guide line passes through the profile's bounding box. */
  anchorX: SweepAnchor;
  anchorY: SweepAnchor;
  /** Lateral shift, mm — +x is LEFT of travel. */
  offsetXMm: number;
  /** Shift from the chosen storey level, mm. */
  offsetZMm: number;
  /** Which end of the storey band the run sits at. */
  level: SweepLevel;
  material: string;
  description: string;
}

/**
 * Anchors, explained once so the table reads.
 *
 * A moulding hangs off the OUTSIDE face of the wall it decorates. The guide
 * line runs along that face, so the profile's inner edge must sit on the line:
 * `anchorX: 'min'` puts the profile's left edge on it, and `offsetXMm` pushes
 * it back onto the wall if it should overlap. `anchorY` picks which horizontal
 * edge of the profile meets the level — `max` hangs the profile below the line
 * (a cornice under the eaves), `min` stands it above (a plinth off the ground).
 */
export const DETAIL_TYPES: DetailType[] = [
  // ── Horizontal runs on the facade ───────────────────────────────────────
  {
    id: 'PLINTH-R300x60', label: 'Soclu simplu 30×6 cm', role: 'plinth',
    profileId: 'rect', params: { p_w_mm: 60, p_h_mm: 300 },
    anchorX: 'min', anchorY: 'min', offsetXMm: 0, offsetZMm: 0, level: 'bottom',
    material: 'Mortar', description: 'Bandă dreaptă la baza fațadei, ieșită 6 cm din câmp',
  },
  {
    id: 'BAND-R120x40', label: 'Brâu 12×4 cm', role: 'band',
    profileId: 'rect', params: { p_w_mm: 40, p_h_mm: 120 },
    anchorX: 'min', anchorY: 'mid', offsetXMm: 0, offsetZMm: 0, level: 'top',
    material: 'Mortar', description: 'Brâu orizontal care marchează nivelul planșeului',
  },
  {
    id: 'CORN-L250x150', label: 'Cornișă L 25×15 cm', role: 'cornice',
    profileId: 'l', params: { p_w_mm: 250, p_h_mm: 150, p_t_mm: 60 },
    anchorX: 'min', anchorY: 'max', offsetXMm: 0, offsetZMm: 0, level: 'top',
    material: 'Beton', description: 'Cornișă simplă în trepte, la cota superioară a etajului',
  },
  {
    id: 'COPING-R300x80', label: 'Șapcă atic 30×8 cm', role: 'coping',
    profileId: 'rect', params: { p_w_mm: 300, p_h_mm: 80 },
    anchorX: 'mid', anchorY: 'min', offsetXMm: 0, offsetZMm: 0, level: 'top',
    material: 'Beton', description: 'Capac peste atic sau parapet, centrat pe zid',
  },

  // ── Around openings ─────────────────────────────────────────────────────
  {
    id: 'ARCH-R80x30', label: 'Ancadrament 8×3 cm', role: 'architrave',
    profileId: 'rect', params: { p_w_mm: 30, p_h_mm: 80 },
    anchorX: 'min', anchorY: 'mid', offsetXMm: 0, offsetZMm: 0, level: 'bottom',
    material: 'Mortar', description: 'Chenar plat în jurul golului',
  },
  {
    id: 'SILL-R250x40', label: 'Glaf 25×4 cm', role: 'sill',
    profileId: 'rect', params: { p_w_mm: 250, p_h_mm: 40 },
    anchorX: 'min', anchorY: 'max', offsetXMm: 0, offsetZMm: 0, level: 'bottom',
    material: 'Beton', description: 'Glaf exterior sub fereastră; panta se dă din rotație',
  },

  // ── Vertical articulation ───────────────────────────────────────────────
  {
    id: 'PIL-R400x60', label: 'Pilastru 40×6 cm', role: 'pilaster',
    profileId: 'rect', params: { p_w_mm: 400, p_h_mm: 60 },
    anchorX: 'mid', anchorY: 'min', offsetXMm: 0, offsetZMm: 0, level: 'bottom',
    material: 'Mortar', description: 'Lesenă plată aplicată pe fațadă, pe toată înălțimea etajului',
  },

  // ── Roof edge and rainwater ─────────────────────────────────────────────
  {
    id: 'EAVES-R200x25', label: 'Pazie 20×2.5 cm', role: 'eaves',
    profileId: 'rect', params: { p_w_mm: 25, p_h_mm: 200 },
    anchorX: 'mid', anchorY: 'max', offsetXMm: 0, offsetZMm: 0, level: 'top',
    material: 'Lemn', description: 'Scândură de pazie la marginea acoperișului',
  },
  {
    id: 'GUTTER-U150', label: 'Jgheab semicircular 15 cm', role: 'gutter',
    profileId: 'u', params: { p_w_mm: 150, p_h_mm: 100, p_t_mm: 6 },
    anchorX: 'mid', anchorY: 'max', offsetXMm: 0, offsetZMm: 0, level: 'top',
    material: 'Tablă', description: 'Jgheab de scurgere sub streașină',
  },

  // ── Circulation ─────────────────────────────────────────────────────────
  {
    id: 'RAIL-C50', label: 'Mână curentă Ø5 cm', role: 'handrail',
    profileId: 'circle', params: { p_d_mm: 50, p_segments: 20 },
    anchorX: 'mid', anchorY: 'mid', offsetXMm: 0, offsetZMm: 900, level: 'bottom',
    material: 'Lemn', description: 'Mână curentă rotundă, la 90 cm peste linia de ghidaj',
  },
];

export const DETAIL_TYPE_MAP = new Map(DETAIL_TYPES.map((d) => [d.id, d]));

/** The detail types that fill one role, in declaration order. */
export const detailTypesForRole = (role: SweepRole): DetailType[] =>
  DETAIL_TYPES.filter((d) => d.role === role);

/**
 * The property patch that makes a sweep node this detail type.
 *
 * Returned rather than applied, so the caller decides how it reaches the graph
 * — and so a style generator and the inspector can share one definition of what
 * "be a cornice" means.
 *
 * Stale `p_*` keys from the previous profile are cleared to `undefined`: a
 * profile switched from `l` to `rect` would otherwise keep a `p_t_mm` that the
 * new profile ignores but the inspector still shows.
 */
export function detailTypeProperties(type: DetailType): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    detail_type: type.id,
    sweep_role: type.role,
    profile: type.profileId,
    anchor_x: type.anchorX,
    anchor_y: type.anchorY,
    offset_x_mm: type.offsetXMm,
    offset_z_mm: type.offsetZMm,
    level: type.level,
    material: type.material,
  };
  for (const k of ALL_PARAM_KEYS) patch[k] = undefined;
  Object.assign(patch, type.params);
  return patch;
}

/** Every `p_*` key any built-in profile uses, so a switch can clear the rest. */
const ALL_PARAM_KEYS = [
  'p_w_mm', 'p_h_mm', 'p_t_mm', 'p_tw_mm', 'p_tf_mm', 'p_d_mm', 'p_segments',
] as const;

/** The detail type a node declares, if it still exists. */
export const detailTypeOf = (node: { properties?: Record<string, unknown> } | undefined) =>
  DETAIL_TYPE_MAP.get(String(node?.properties?.detail_type ?? '')) ?? null;
