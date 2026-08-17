/**
 * femLoads.ts — imposed (live) floor-load catalog by room usage category.
 *
 * Representative values per SR EN 1991-1-1 (Eurocode 1, Romanian national
 * annex) occupancy categories — single characteristic qk per category, not
 * the full per-category sub-table (this is a spike; a real structural
 * design pass would still need a licensed engineer's load assumptions).
 * Values in kN/m² (kPa), applied as a uniform area load on the ROOM's own
 * slab shell, on top of (not instead of) the slab's self-weight.
 *
 * Only `room` nodes carry a usage category — a standalone `slab` node (e.g.
 * a balcony not attached to a room) still gets self-weight only. See
 * buildShellElements.ts's addSlabShell.
 */

export type RoomLoadCategory =
  | 'residential'
  | 'office'
  | 'assembly_commercial'
  | 'balcony_terrace'
  | 'stairs_corridor'
  | 'storage'
  | 'garage_light'
  | 'attic_nonaccessible'
  | 'roof_accessible';

export const DEFAULT_ROOM_LOAD_CATEGORY: RoomLoadCategory = 'residential';

/** Characteristic imposed load qk, kN/m² (SR EN 1991-1-1 categories, one representative value each). */
export const ROOM_LIVE_LOAD_KPA: Record<RoomLoadCategory, number> = {
  residential: 1.5,          // Categ. A — locuințe, camere
  office: 2.0,                // Categ. B — birouri
  assembly_commercial: 4.0,   // Categ. C/D — săli de reuniune, comerț
  balcony_terrace: 3.0,       // balcoane / terase (conservator, peste camera adiacentă)
  stairs_corridor: 3.0,       // scări și coridoare comune (Categ. A note 2)
  storage: 5.0,                // Categ. E — depozitare (valoare implicită, verificați sarcina reală)
  garage_light: 2.5,           // Categ. F — trafic auto ușor (≤ 30 kN greutate vehicul)
  attic_nonaccessible: 0.75,  // pod necirculabil
  roof_accessible: 1.5,        // acoperiș-terasă circulabil
};

export const ROOM_LOAD_LABELS: Record<RoomLoadCategory, string> = {
  residential: 'Locuință (Categ. A) — 1.5 kN/m²',
  office: 'Birou (Categ. B) — 2.0 kN/m²',
  assembly_commercial: 'Reuniune / comerț (Categ. C/D) — 4.0 kN/m²',
  balcony_terrace: 'Balcon / terasă — 3.0 kN/m²',
  stairs_corridor: 'Scară / coridor comun — 3.0 kN/m²',
  storage: 'Depozitare (Categ. E) — 5.0 kN/m²',
  garage_light: 'Garaj — trafic ușor (Categ. F) — 2.5 kN/m²',
  attic_nonaccessible: 'Pod necirculabil — 0.75 kN/m²',
  roof_accessible: 'Terasă circulabilă — 1.5 kN/m²',
};

/**
 * Resolve a room node's live-load category → N/m² (Pa), ready to add directly
 * alongside self-weight (which is already accumulated in N, via density × g).
 * Unset / unrecognized `room_load_category` falls back to `residential`.
 */
export function getRoomLiveLoadNm2(roomLoadCategory: unknown): number {
  const cat = String(roomLoadCategory ?? DEFAULT_ROOM_LOAD_CATEGORY) as RoomLoadCategory;
  const kPa = ROOM_LIVE_LOAD_KPA[cat] ?? ROOM_LIVE_LOAD_KPA[DEFAULT_ROOM_LOAD_CATEGORY];
  return kPa * 1000; // kN/m² → N/m²
}
