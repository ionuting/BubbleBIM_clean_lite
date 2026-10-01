/**
 * useExtrusions — the editing session both viewers run.
 *
 * Owns the solids, the contour being drawn, and the selection; hands back the
 * operations the panel calls. The viewers keep only what is genuinely theirs:
 * where a click lands on their own surface, and how a solid is drawn.
 *
 * Contour points arrive in DRAWING coordinates (metres, x east, y north) — the
 * caller converts from its own space before calling `addPoint`, which is the
 * one place the two viewers differ.
 */

import { useCallback, useRef, useState } from 'react';
import {
  checkContour, createExtrusion, setHeight as setSolidHeight, withPlacement,
  type ContourProblem, type ExtrudedSolid, type Pt2, type SolidPlacement,
  DEFAULT_HEIGHT_M,
} from './extrudedSolid';
import { buildExtrusionIfc, type ExtrudeExportOptions } from './extrudeIfc';

const PALETTE = ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb7185'];

export const CONTOUR_PROBLEM_TEXT: Record<ContourProblem['reason'], string> = {
  'too-few': 'Un contur are nevoie de cel puțin trei puncte.',
  'too-small': 'Conturul este prea mic pentru a fi un volum.',
  'self-intersecting': 'Conturul se intersectează pe el însuși.',
};

export interface UseExtrusionsOptions {
  /** Elevation the contour is drawn on, metres. Read when a contour closes. */
  elevation?: () => number;
  /** Told about a rejected contour, so the viewer can say why. */
  onProblem?: (message: string) => void;
}

export function useExtrusions(opts: UseExtrusionsOptions = {}) {
  const [solids, setSolids] = useState<ExtrudedSolid[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [contour, setContour] = useState<Pt2[]>([]);
  const [defaultHeight, setDefaultHeight] = useState(DEFAULT_HEIGHT_M);

  // The viewers' event handlers are installed once and read through refs.
  const drawingRef = useRef(false);
  const contourRef = useRef<Pt2[]>([]);
  const heightRef = useRef(DEFAULT_HEIGHT_M);
  const countRef = useRef(0);

  // The options object is a fresh literal on every render of the host. Held
  // in a ref, the callbacks below stay referentially stable — which matters
  // because the viewers put them in effect dependency lists and in handlers
  // that are installed once.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const setDraw = useCallback((v: boolean) => { drawingRef.current = v; setDrawing(v); }, []);
  const setPts = useCallback((pts: Pt2[]) => { contourRef.current = pts; setContour(pts); }, []);

  const startDraw = useCallback(() => { setPts([]); setDraw(true); }, [setDraw, setPts]);
  const cancelDraw = useCallback(() => { setPts([]); setDraw(false); }, [setDraw, setPts]);

  const addPoint = useCallback((p: Pt2) => {
    if (!drawingRef.current) return;
    setPts([...contourRef.current, p]);
  }, [setPts]);

  /** Close the contour and turn it into a solid. Returns it, or null when the
   *  contour could not carry one — the reason goes to `onProblem`. */
  const finishDraw = useCallback((): ExtrudedSolid | null => {
    const pts = contourRef.current;
    const checked = checkContour(pts);
    if (!checked.ok) {
      optsRef.current.onProblem?.(CONTOUR_PROBLEM_TEXT[checked.reason]);
      // Fewer than three points is a drawing still in progress, not a mistake
      // worth throwing away; anything else is.
      if (checked.reason !== 'too-few') { setPts([]); setDraw(false); }
      return null;
    }
    const made = createExtrusion(pts, {
      height: heightRef.current,
      elevation: optsRef.current.elevation?.() ?? 0,
      name: `Volum ${countRef.current + 1}`,
      color: PALETTE[countRef.current % PALETTE.length],
    });
    if (!made.ok) { optsRef.current.onProblem?.(CONTOUR_PROBLEM_TEXT[made.reason]); return null; }
    countRef.current += 1;
    setSolids((l) => [...l, made.solid]);
    setSelectedId(made.solid.id);
    setPts([]);
    setDraw(false);
    return made.solid;
  }, [setDraw, setPts]);

  const update = useCallback((id: string, fn: (s: ExtrudedSolid) => ExtrudedSolid) => {
    setSolids((l) => l.map((s) => (s.id === id ? fn(s) : s)));
  }, []);

  const patch = useCallback((id: string, p: Partial<SolidPlacement>) => {
    update(id, (s) => withPlacement(s, p));
  }, [update]);

  const setHeight = useCallback((id: string, h: number) => {
    update(id, (s) => setSolidHeight(s, h));
  }, [update]);

  const rename = useCallback((id: string, name: string) => {
    update(id, (s) => ({ ...s, name }));
  }, [update]);

  const setType = useCallback((id: string, ifcType: string) => {
    update(id, (s) => ({ ...s, ifcType }));
  }, [update]);

  const remove = useCallback((id: string) => {
    setSolids((l) => l.filter((s) => s.id !== id));
    setSelectedId((c) => (c === id ? null : c));
  }, []);

  const changeDefaultHeight = useCallback((v: number) => {
    const h = Math.max(0.01, v);
    heightRef.current = h;
    setDefaultHeight(h);
  }, []);

  /** Write the solids to a file the browser downloads. */
  const exportIfc = useCallback((filename: string, options: ExtrudeExportOptions = {}) => {
    if (solids.length === 0) return;
    const { content } = buildExtrusionIfc(solids, options);
    const url = URL.createObjectURL(new Blob([content], { type: 'application/x-step' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.ifc') ? filename : `${filename}.ifc`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, [solids]);

  return {
    solids, selectedId, drawing, contour, defaultHeight,
    drawingRef, contourRef,
    setSelectedId, startDraw, cancelDraw, addPoint, finishDraw,
    patch, setHeight, rename, setType, remove,
    changeDefaultHeight, exportIfc,
  };
}
