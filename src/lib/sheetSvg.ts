/**
 * sheetSvg.ts — putting the drawing that is on screen onto the exported sheet.
 *
 * The sheet composer shows each viewport by rendering the real viewer inside
 * it: hatches, opening symbols, the roof, annotations, everything. The export
 * used to redraw the same viewports from a separate, much simpler generator —
 * plain rectangles, no openings, no hatch, no roof — so the file you sent to
 * the printer was not the sheet you had composed.
 *
 * It is taken from the live viewer instead. What you see is what is written.
 *
 * Two things have to be carried across for that to be faithful:
 *   - the pan and zoom the viewer applies as a CSS transform, which is in
 *     screen pixels about the element's centre and has to be restated in the
 *     viewBox's own units;
 *   - the element ids, because several viewports carry hatch patterns under
 *     the same names and ids are global to the exported document.
 */

/** A viewer's `<svg>`, as the export needs to see it. */
export interface ViewportSource {
  /** viewBox of the viewer's svg. */
  vbX: number; vbY: number; vbW: number; vbH: number;
  /** Rendered size of that svg on screen, in px. */
  pxW: number; pxH: number;
  /** The CSS transform the viewer applies: scale about the centre, then pan. */
  zoom: number; panX: number; panY: number;
}

/**
 * The viewer's pan and zoom, restated in viewBox units so it can wrap the
 * serialized content in the exported file.
 *
 * `preserveAspectRatio="xMidYMid meet"` scales user units to pixels by
 * `s = min(pxW/vbW, pxH/vbH)`, so a pan of `panX` pixels is `panX / s` units.
 * The zoom is about the element's centre, which in user units is the centre of
 * the viewBox.
 */
export function viewportTransform(src: ViewportSource): string {
  const s = Math.min(src.pxW / src.vbW, src.pxH / src.vbH);
  if (!(s > 0) || !Number.isFinite(s)) return '';
  const tx = src.panX / s, ty = src.panY / s;
  const cx = src.vbX + src.vbW / 2, cy = src.vbY + src.vbH / 2;
  const z = Number.isFinite(src.zoom) && src.zoom > 0 ? src.zoom : 1;
  if (z === 1 && tx === 0 && ty === 0) return '';
  // Read right to left: centre the content, scale it, put it back, then pan.
  return `translate(${tx.toFixed(4)},${ty.toFixed(4)}) translate(${cx.toFixed(4)},${cy.toFixed(4)})`
    + ` scale(${z.toFixed(6)}) translate(${(-cx).toFixed(4)},${(-cy).toFixed(4)})`;
}

/**
 * Namespace every id in a fragment, and every reference to one.
 *
 * Each viewport carries its own `<defs>` — hatch patterns named after the
 * material, so two viewports showing brick both define `hatch-brick`. Dropped
 * into one document the second definition is ignored and the viewport is
 * filled with the first one's tile, at the first one's scale.
 */
export function prefixIds(svg: string, prefix: string): string {
  if (!prefix) return svg;
  return svg
    .replace(/\bid="([^"]+)"/g, (_m, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${prefix}${id})`)
    .replace(/\b(xlink:href|href)="#([^"]+)"/g, (_m, attr: string, id: string) => `${attr}="#${prefix}${id}"`);
}

/**
 * The inside of a viewer's `<svg>`, ready to drop into the sheet: its own
 * content, namespaced, wrapped in the pan/zoom it is drawn with.
 *
 * Returns '' when there is nothing to take — an empty viewport is better than
 * a viewport drawn from stale, different geometry.
 */
export function viewportContent(svg: SVGSVGElement, prefix: string): string {
  const vb = svg.viewBox.baseVal;
  const box = svg.getBoundingClientRect();
  const m = readTransform(svg);
  const transform = viewportTransform({
    vbX: vb.x, vbY: vb.y, vbW: vb.width, vbH: vb.height,
    pxW: box.width || vb.width, pxH: box.height || vb.height,
    zoom: m.zoom, panX: m.panX, panY: m.panY,
  });

  const ser = new XMLSerializer();
  const inner = Array.from(svg.childNodes)
    .map((n) => ser.serializeToString(n))
    .join('\n');
  if (!inner.trim()) return '';
  const body = prefixIds(inner, prefix);
  return transform ? `<g transform="${transform}">${body}</g>` : body;
}

/** The scale and translation of an element's CSS transform matrix. */
function readTransform(el: Element): { zoom: number; panX: number; panY: number } {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return { zoom: 1, panX: 0, panY: 0 };
  const nums = t.slice(t.indexOf('(') + 1, t.lastIndexOf(')')).split(',').map(Number);
  // matrix(a, b, c, d, e, f) — the viewers only ever scale uniformly and translate.
  if (nums.length < 6 || nums.some((n) => !Number.isFinite(n))) return { zoom: 1, panX: 0, panY: 0 };
  return { zoom: nums[0] || 1, panX: nums[4], panY: nums[5] };
}
