/**
 * loadedIfcRegistry.ts — the IFC models the 3D viewers hold right now.
 *
 * The toolbar's HTML export lives in the graph panel and knows nothing of
 * the viewers; the viewers know nothing of the export. This is where they
 * meet: a viewer registers each model it has loaded and unregisters it when
 * the model goes (removed, file changed, tab closed), and the export reads
 * the list at the moment it runs.
 *
 * A model comes in one of two forms, whichever the viewer has:
 *  - the live fragments model (the That Open viewer) — used as it is;
 *  - the original IFC file (the IFC Tiles viewer, which streams GLB tiles
 *    and keeps no fragments model) — converted at export time, the way the
 *    World view converts an import.
 */

import type { FragmentsModel } from '@thatopen/fragments';

export interface LoadedIfc {
  /** Unique across viewers and viewer instances. */
  key: string;
  /** What the exported file calls the model — the file name, usually. */
  name: string;
  /** The live model, read at export time; undefined once the viewer lets it go. */
  getModel?: () => FragmentsModel | undefined;
  /**
   * The IFC itself: converted when there is no live model, and read either
   * way for what fragments does not carry (IfcIndexedColourMap colours).
   */
  file?: File;
}

const entries = new Map<string, LoadedIfc>();

export function registerLoadedIfc(entry: LoadedIfc): void {
  entries.set(entry.key, entry);
}

export function unregisterLoadedIfc(key: string): void {
  entries.delete(key);
}

/** Every model registered, in the order they were loaded. */
export function listLoadedIfc(): LoadedIfc[] {
  return [...entries.values()];
}
