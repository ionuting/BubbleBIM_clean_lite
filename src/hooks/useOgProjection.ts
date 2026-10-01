/**
 * useOgProjection — the kernel's exact projected outlines for one section or
 * elevation, or null while they are not there yet.
 *
 * The drawing engine is pure and synchronous; the kernel is a wasm module
 * that loads once, asynchronously. So the async lives here: the viewer keeps
 * drawing its own bounding-rectangle outlines until the kernel's arrive,
 * then redraws with them. The projection module itself is imported lazily,
 * so a build that never opens a section never pays for the kernel.
 */
import { useEffect, useState } from 'react';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import type { MaterialConfig } from '@/lib/materialConfig';
import type { KernelOutlines, SectionCut } from '@/lib/drawingEngine';

/** Editing the graph re-projects; wait for the keystrokes to settle first. */
const SETTLE_MS = 120;

export function useOgProjection(
  enabled: boolean,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null,
  cut: SectionCut | null,
): KernelOutlines | null {
  const [lines, setLines] = useState<KernelOutlines | null>(null);

  useEffect(() => {
    if (!enabled || !cut) {
      setLines(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const [{ ensureOpenGeoReady }, og] = await Promise.all([
            import('@/lib/openGeoInit'),
            import('@/lib/ogProjection'),
          ]);
          await ensureOpenGeoReady();
          if (cancelled) return;
          const entities = og.collectOgEntities(nodes, edges, matConfig);
          const next = og.projectOgLines(entities, cut, nodes, matConfig);
          if (!cancelled) setLines(next);
        } catch (err) {
          console.warn('[useOgProjection] kernel projection failed — drawing without it:', err);
          if (!cancelled) setLines(null);
        }
      })();
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, nodes, edges, matConfig, cut]);

  return lines;
}
