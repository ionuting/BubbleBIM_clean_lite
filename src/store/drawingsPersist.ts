/**
 * drawingsPersist.ts — the project's 2D views and their annotations, in and out
 * of the project file, in the same export/import shape as the other stores.
 */
import { useBubbleGraphStore, type DrawingAnnotation } from '@/store';
import type { DrawingView } from '@/lib/views/drawingViews';

export interface DrawingsPersist {
  views: DrawingView[];
  annotations: DrawingAnnotation[];
}

export function exportDrawings(): DrawingsPersist {
  const s = useBubbleGraphStore.getState();
  return { views: s.drawingViews, annotations: s.annotations };
}

/** A file without drawings (saved before they travelled with it) clears nothing it did not bring. */
export function importDrawings(data: DrawingsPersist | undefined): void {
  if (!data) { useBubbleGraphStore.getState().setDrawingViews([]); return; }
  const s = useBubbleGraphStore.getState();
  s.setDrawingViews(Array.isArray(data.views) ? data.views : []);
  if (Array.isArray(data.annotations)) s.setAnnotations(data.annotations);
}
