/**
 * The georeferencing module.
 *
 *   crs.ts           which grids exist and how to project onto them
 *   georeference.ts  where the model stands, in CRS terms
 *   ifcGeoref.ts     that fact written into, and read back out of, an IFC
 *
 * The one rule worth stating up front: a model is georeferenced only when
 * someone said so. `WorldLocation` always holds a lat/lng because the globe
 * needs somewhere to point the camera, and that default must never leak into
 * a file as a claim about the world.
 */

export * from './crs';
export * from './countries';
export * from './georeference';
export * from './overlay';
export { readGeoreference, writeGeoreference, type GeorefWriteOptions } from './ifcGeoref';

import type { WorldLocation } from '@/store';
import { isKnownCrs } from './crs';
import { georefFromWorldLocation, type GeoReference } from './georeference';

/** The grid used when a project has not named one. Romanian cadastre. */
export const DEFAULT_PROJECT_CRS = 'EPSG:3844';

/**
 * The georeference to write into an export, or null to write none.
 *
 * Null for a project nobody has placed, and null for one naming a CRS the app
 * cannot project into — in both cases the export stays local, which is what
 * it has always been. Writing a guess would be worse: a file that says where
 * it stands is trusted, and a surveyor has no way to tell a real position
 * from a default one.
 */
export function exportGeoreference(loc: WorldLocation | null | undefined): GeoReference | null {
  if (!loc?.georeferenced) return null;
  const crs = loc.crs ?? DEFAULT_PROJECT_CRS;
  if (!isKnownCrs(crs)) return null;
  return georefFromWorldLocation(loc, crs);
}
