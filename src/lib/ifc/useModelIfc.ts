/**
 * useModelIfc — the live graph as the IFC the export writes, for a viewer.
 *
 * The IFC Tiles viewer draws the model from exactly the file a user would
 * download: the same builder, the same material settings, the same post-passes
 * (openings, frames, mitred joints, dormers, styles). So whatever a method
 * generates — walls from the grid, sketches, sweeps, roofs, a style's porch —
 * shows in 3D precisely when, and as, it reaches the export.
 *
 * Rebuilt a moment after the graph settles, not on every keystroke. The file
 * is local (no georeference): a viewer works in the model's own coordinates.
 */
import { useEffect, useMemo, useState } from 'react';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { collectAllIfcLibraryPaths, libraryPartsForExport } from '@/lib/ifcLibraryLoader';
import { buildIfcModel, type LibraryPart } from './buildIfcModel';

/** Library elements, loaded once per path for the session. */
const libraryCache = new Map<string, Promise<LibraryPart[]>>();
function libraryParts(path: string): Promise<LibraryPart[]> {
  let p = libraryCache.get(path);
  if (!p) {
    p = libraryPartsForExport(path).catch((err) => {
      console.warn(`[useModelIfc] library element ${path} not loaded — the generic frame stands in:`, err);
      libraryCache.delete(path);
      return [];
    });
    libraryCache.set(path, p);
  }
  return p;
}

export interface ModelIfc {
  name: string;
  ifc: string;
}

export function useModelIfc(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  projectName: string,
  enabled = true,
  delayMs = 250,
): { model: ModelIfc | null; error: string | null } {
  const { config: materialConfig } = useMaterialConfig();
  const [model, setModel] = useState<ModelIfc | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The IFC library elements the openings point at (windows and doors whose
  // type names a library file): fetched, then built into the file as they are.
  const paths = useMemo(() => collectAllIfcLibraryPaths(nodes).sort().join('|'), [nodes]);
  const [library, setLibrary] = useState<Map<string, LibraryPart[]>>(new Map());
  useEffect(() => {
    if (!enabled || !paths) return;
    let live = true;
    const list = paths.split('|');
    void Promise.all(list.map(async (p) => [p, await libraryParts(p)] as const)).then((entries) => {
      if (live) setLibrary(new Map(entries.filter(([, parts]) => parts.length)));
    });
    return () => { live = false; };
  }, [paths, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => {
      try {
        const name = projectName || 'Model';
        const { content } = buildIfcModel(nodes, edges, name, { materialConfig, libraryParts: library });
        setModel({ name, ifc: content });
        setError(null);
      } catch (err) {
        console.error('[useModelIfc] build failed:', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    }, delayMs);
    return () => clearTimeout(t);
  }, [nodes, edges, projectName, materialConfig, library, enabled, delayMs]);

  return { model, error };
}
