/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useFitToContent — zoom/pan a 2D drawing viewer so the drawn geometry fills
 * the viewport when the view first opens.
 *
 * Why a shared hook rather than per-viewer maths: the three 2D viewers use
 * DIFFERENT viewBox conventions, so "fit" can't be computed from their props.
 *   - Section2DViewer / Elevation2DViewer: viewBox === the padded drawing
 *     extents, so `preserveAspectRatio="xMidYMid meet"` already fits it —
 *     but with only PAD (60mm) of margin, which on a 10 m building is
 *     edge-to-edge and reads as "over-zoomed".
 *   - FloorPlan2DViewer: viewBox is the building PLUS `CANVAS_MARGIN` (1200
 *     units) of deliberate blank space on every side (room to draw/pan
 *     outside the building), so at zoom 1 a typical building occupies only
 *     ~30% of the viewport and looks tiny.
 *
 * Measuring the rendered content with `SVGGraphicsElement.getBBox()` sidesteps
 * all of that: it returns the real ink bounds in viewBox units, whatever the
 * viewBox means for that viewer.
 *
 * The maths (must match how the viewers apply the transform — CSS
 * `transform: translate(pan) scale(zoom)` with `transformOrigin: 50% 50%`):
 *   base scale  s  = min(cw/vbW, ch/vbH)          (what `meet` already applies)
 *   zoom           = FILL · min(cw/(bbox.w·s), ch/(bbox.h·s))
 *   screen offset of the content centre from the container centre, at zoom 1:
 *                d = (bboxCentre − viewBoxCentre) · s
 *   a point at offset d lands at d·zoom + pan, so centring means pan = −d·zoom.
 */

import { useEffect, useRef, type RefObject } from 'react';

/** Fraction of the viewport the content should occupy — leaves a visual margin. */
const FILL = 0.88;
/** Retry budget: the container can still be 0×0 (or the SVG empty) on the first frames. */
const MAX_ATTEMPTS = 30;

export interface FitToContentOptions {
  svgRef: RefObject<SVGSVGElement | null>;
  containerRef: RefObject<HTMLElement | null>;
  setZoom: (z: number) => void;
  setPan: (p: { x: number; y: number }) => void;
  /**
   * Fit again whenever this changes — pass the view's identity (storey id,
   * section node id, view direction…). Undefined/empty still fits once on
   * mount. Not the geometry itself: re-fitting on every edit would fight the
   * user's own zoom.
   */
  viewKey?: string;
  /** Skip entirely (embedded mode: SheetComposer / report insets own their layout). */
  enabled?: boolean;
}

export function useFitToContent({
  svgRef, containerRef, setZoom, setPan, viewKey, enabled = true,
}: FitToContentOptions): void {
  // Refs so the effect never re-runs just because a parent re-created the setters.
  const setZoomRef = useRef(setZoom); setZoomRef.current = setZoom;
  const setPanRef = useRef(setPan); setPanRef.current = setPan;

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let attempts = 0;

    const tryFit = () => {
      const svg = svgRef.current;
      const container = containerRef.current;
      if (!svg || !container) return retry();

      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw < 2 || ch < 2) return retry(); // not laid out yet

      const vb = svg.viewBox.baseVal;
      if (!vb || vb.width < 1 || vb.height < 1) return retry();

      // What counts as "content":
      //  - `[data-fit-target]` when a viewer marks its real geometry — the
      //    section/elevation chrome (earth fill, axis grid, level lines)
      //    spans the view's whole elevation range, which for the default
      //    facades is −5000…15000 mm no matter how tall the building is, so
      //    framing everything would leave the building tiny.
      //  - otherwise the whole SVG, minus `[data-fit-ignore]`: full-canvas
      //    invisible hit targets (click-to-deselect, tool placement surfaces)
      //    that would otherwise report the entire canvas as content, i.e. no
      //    fit at all. Hiding them is the reliable way to exclude them at any
      //    nesting depth, since getBBox() skips display:none.
      const targets = svg.querySelectorAll<SVGGraphicsElement>('[data-fit-target]');
      const ignored = svg.querySelectorAll<SVGElement>('[data-fit-ignore]');
      ignored.forEach((el) => { el.style.display = 'none'; });
      let bbox: DOMRect | null = null;
      try {
        // getBBox() throws in some engines when the element isn't rendered yet.
        if (targets.length) {
          for (const t of targets) {
            const b = t.getBBox();
            if (b.width < 1 && b.height < 1) continue; // empty group
            bbox = bbox
              ? new DOMRect(
                  Math.min(bbox.x, b.x), Math.min(bbox.y, b.y),
                  Math.max(bbox.right, b.right) - Math.min(bbox.x, b.x),
                  Math.max(bbox.bottom, b.bottom) - Math.min(bbox.y, b.y),
                )
              : b;
          }
        } else {
          bbox = svg.getBBox();
        }
      } catch {
        return retry();
      } finally {
        ignored.forEach((el) => { el.style.display = ''; });
      }
      if (!bbox || bbox.width < 1 || bbox.height < 1) return retry(); // nothing drawn (yet)

      const s = Math.min(cw / vb.width, ch / vb.height); // what preserveAspectRatio=meet applies
      const zoom = Math.max(0.05, Math.min(20,
        FILL * Math.min(cw / (bbox.width * s), ch / (bbox.height * s)),
      ));

      const dx = (bbox.x + bbox.width / 2 - vb.width / 2) * s;
      const dy = (bbox.y + bbox.height / 2 - vb.height / 2) * s;

      setZoomRef.current(zoom);
      setPanRef.current({ x: -dx * zoom, y: -dy * zoom });
    };

    const retry = () => {
      if (++attempts > MAX_ATTEMPTS) return;
      raf = requestAnimationFrame(tryFit);
    };

    raf = requestAnimationFrame(tryFit);
    return () => cancelAnimationFrame(raf);
    // svgRef/containerRef are stable refs; setters are read through refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, viewKey]);
}
