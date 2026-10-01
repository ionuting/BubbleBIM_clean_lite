/**
 * useOgDrawing — a kernel drawing for one view, or null while it is not there.
 *
 * Building the drawing means building the whole 3D model first: `ogDrawing`
 * cuts and projects the solids the viewer would show, so every one of them
 * has to exist. That is far too much to do on a keystroke, so it is debounced
 * and lives off the render path entirely — the viewer draws nothing, then the
 * drawing arrives and it draws that.
 *
 * The kernel modules are imported lazily for the same reason `useOgProjection`
 * does it: a session that never opens an OG view never pays for the wasm.
 */
import { useEffect, useRef, useState } from 'react';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import type { MaterialConfig } from '@/lib/materialConfig';
import type { DrawingResult } from '@/lib/drawingEngine';
import type { OgMergeOptions } from '@/lib/ogDrawing/merge';
import type { OgDrawingSpec } from '@/lib/ogDrawing';

/** Editing the graph re-cuts and re-projects; wait for the keystrokes to settle. */
const SETTLE_MS = 180;

export interface OgDrawingState {
  drawing: DrawingResult | null;
  busy: boolean;
  error: string | null;
  /** How long the last build took, ms — shown in the viewer, useful when it is slow. */
  tookMs: number | null;
}

export function useOgDrawing(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null,
  spec: OgDrawingSpec,
  /**
   * How the cut is turned into a drawing — walls merged into one poché,
   * opening solids left out for the symbol layer. See `ogDrawing/merge.ts`.
   */
  merge: OgMergeOptions = {},
): OgDrawingState {
  const [state, setState] = useState<OgDrawingState>({
    drawing: null, busy: true, error: null, tookMs: null,
  });

  // The spec is rebuilt by the caller on every render; compare it by value or
  // the effect never stops running.
  const specKey = JSON.stringify(spec);
  // Same reason: a toggle has to rebuild the drawing, and an object identity
  // that changes every render would rebuild it forever.
  const mergeKey = JSON.stringify(merge);
  const lastRef = useRef<DrawingResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, busy: true, error: null }));

    const timer = setTimeout(() => {
      void (async () => {
        const t0 = performance.now();
        try {
          const [{ ensureOpenGeoReady }, og, { collectOgEntities }, { OGSceneManager }] = await Promise.all([
            import('@/lib/openGeoInit'),
            import('@/lib/ogDrawing'),
            import('@/lib/ogProjection'),
            import('opengeometry'),
          ]);
          await ensureOpenGeoReady();
          if (cancelled) return;

          const parsed = JSON.parse(specKey) as OgDrawingSpec;
          const frame = og.buildOgFrame(nodes, parsed);
          const entities = collectOgEntities(nodes, edges, matConfig);
          if (cancelled) return;
          const drawing = og.computeOgDrawing(
            entities, frame, nodes, matConfig, () => new OGSceneManager(),
            JSON.parse(mergeKey) as OgMergeOptions,
          );
          if (cancelled) return;
          lastRef.current = drawing;
          setState({ drawing, busy: false, error: null, tookMs: performance.now() - t0 });
        } catch (err) {
          console.warn('[useOgDrawing] build failed:', err);
          if (cancelled) return;
          // Keep the last good drawing on screen: a transient failure while
          // the graph is mid-edit should not blank the view.
          setState({
            drawing: lastRef.current,
            busy: false,
            error: err instanceof Error ? err.message : String(err),
            tookMs: null,
          });
        }
      })();
    }, SETTLE_MS);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [nodes, edges, matConfig, specKey, mergeKey]);

  return state;
}
