/**
 * lastFloor.ts — keep a "Last floor" storey floating on top of the others.
 *
 * The Last floor (role: 'last') always sits directly above the highest regular
 * storey: its bottom = the max top elevation of every other storey, and its
 * height is preserved (so you can still change how tall it is). Add or remove
 * storeys below and it re-floats above them all. Pure → unit-tested.
 */
export interface StoreyBand {
  id: string;
  bottomElevation: number;
  topElevation: number;
}

/**
 * Compute the band the Last floor should occupy, or null when there's nothing
 * to float above (no other storeys) or the last storey isn't found.
 */
export function computeLastFloorBand(
  storeys: StoreyBand[],
  lastId: string,
  fallbackHeight = 2800,
): { bottom: number; top: number } | null {
  const last = storeys.find((s) => s.id === lastId);
  if (!last) return null;
  const others = storeys.filter((s) => s.id !== lastId);
  if (!others.length) return null;
  const maxTop = Math.max(...others.map((s) => s.topElevation));
  const height = last.topElevation > last.bottomElevation
    ? last.topElevation - last.bottomElevation
    : fallbackHeight;
  return { bottom: maxTop, top: maxTop + height };
}
