/**
 * current.ts — the one impure door into the terrain library.
 *
 * The scene builders, the drawing engine and the quantity measures all take
 * `(nodes, edges, …)` and nothing else, and threading a terrain model through
 * every one of those signatures — and every caller of every caller — would
 * touch far more code than the feature is worth. So they ask here instead,
 * the way the quantity catalog already asks its own store.
 *
 * Everything in `site.ts` and `heightGrid.ts` stays pure and testable; only
 * this file knows there is an app.
 */
import { useBubbleGraphStore } from '@/store';
import { normaliseTerrainModel, type TerrainModel } from './types';

/** The project's terrain as currently in the store, defaults filled in. */
export function currentTerrainModel(): TerrainModel {
  const t = useBubbleGraphStore.getState().terrain;
  return t ?? normaliseTerrainModel(null);
}
