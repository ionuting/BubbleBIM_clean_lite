/**
 * dxfSymbolRenderer.ts
 *
 * Renders a .bglib.json parametric symbol as SVG, applying slider offsets
 * to scale geometry from the default 1000mm reference size to any actual size.
 *
 * Slider algorithm (per vertex):
 *   for each slider polygon that contains the vertex:
 *     if slider.axis === 'x'  →  dx += (actualW - defaultW) * slider.factor
 *     if slider.axis === 'y'  →  dy += (actualH - defaultH) * slider.factor
 */

export interface BglibSlider {
  id: string;
  axis: 'x' | 'y';
  factor: number;        // 1.0 = full delta, 0.5 = half delta
  polygon: [number, number][];
}

export interface BglibGeomEntity {
  type: 'lwpolyline' | 'line' | 'arc' | 'circle' | 'text' | 'hatch';
  layer: string;
  color: string;
  lineweight: number;   // mm
  /** If present, entity is only rendered in these view types (e.g. ['section','elevation']). */
  viewTypes?: string[];
  // lwpolyline
  closed?: boolean;
  vertices?: [number, number][];
  // line
  start?: [number, number];
  end?: [number, number];
  // arc / circle
  center?: [number, number];
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  // text
  position?: [number, number];
  content?: string;
  height?: number;
  // metadata
  _approx?: string;
}

export interface BglibSymbol {
  name: string;
  defaultWidth: number;   // mm — reference size the DXF was drawn at
  defaultHeight: number;  // mm — wall depth direction reference size
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  insertionPoint: { x: number; y: number };
  sliders: BglibSlider[];
  geometry: BglibGeomEntity[];
  labels: BglibGeomEntity[];
}

// ─── Point-in-polygon (ray casting) ──────────────────────────────────────────

export function pointInPolygon(px: number, py: number, polygon: [number, number][]): boolean {
  let inside = false;
  const n = polygon.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

// ─── Apply sliders to a single vertex ────────────────────────────────────────

export function applySlidersToPt(
  pt: [number, number],
  sliders: BglibSlider[],
  actualW: number,
  actualH: number,
  defaultW: number,
  defaultH: number,
): [number, number] {
  let [x, y] = pt;
  for (const s of sliders) {
    if (!pointInPolygon(x, y, s.polygon)) continue;
    if (s.axis === 'x') x += (actualW - defaultW) * s.factor;
    else                y += (actualH - defaultH) * s.factor;
  }
  return [x, y];
}

// ─── Apply sliders to a vertex array ─────────────────────────────────────────

export function applySlidersToVertices(
  vertices: [number, number][],
  sliders: BglibSlider[],
  actualW: number,
  actualH: number,
  defaultW: number,
  defaultH: number,
): [number, number][] {
  return vertices.map((v) => applySlidersToPt(v, sliders, actualW, actualH, defaultW, defaultH));
}

// ─── SVG element renderers ────────────────────────────────────────────────────

/**
 * Render all geometry entities of a BglibSymbol as an array of SVG element strings.
 *
 * @param sym          Parsed bglib symbol
 * @param actualW      Actual opening width (mm) for this instance
 * @param actualH      Actual opening height/depth (mm) — wall thickness for floor plan
 * @param scale        mm → SVG units. Pass 1.0 when wrapping with an SVG transform matrix.
 * @param showLabels   Whether to include label-layer geometry (default false)
 * @param layerColors  Override colors per layer name (lowercased), e.g. { frame: '#111', glass: '#aac' }
 * @param overrideColor  Override ALL entity colors (takes lowest priority after layerColors)
 * @param skipLayers   Layer names to skip entirely (lowercased), e.g. ['sill'] for floor plan view
 * @param viewType     Active view type ('floorplan'|'section'|'elevation'). Entities whose
 *                     viewTypes[] do not include this value are skipped. Pass undefined to render all.
 * @param layerLineWeights  Override lineweight (SVG units before scale) per layer name (lowercased).
 *                          Applied after scale. Has higher priority than entity lineweight.
 */
export function renderBglibSymbolElements(
  sym: BglibSymbol,
  actualW: number,
  actualH: number,
  scale = 1.0,
  showLabels = false,
  layerColors?: Record<string, string>,
  overrideColor?: string,
  skipLayers?: string[],
  viewType?: string,
  layerLineWeights?: Record<string, number>,
): string[] {
  const parts: string[] = [];
  const { sliders, geometry, labels, defaultWidth: dW, defaultHeight: dH, insertionPoint: ip } = sym;
  const all = showLabels ? [...geometry, ...labels] : geometry;
  const skipSet = new Set((skipLayers ?? []).map((s) => s.toLowerCase()));

  // Auto-scale Y axis when the DXF has no explicit Y sliders (slider_height / slider_0.5height).
  // This ensures the symbol fills the actual wall depth regardless of defaultHeight.
  const hasYSlider = sliders.some((s) => s.axis === 'y');
  const yScale = (!hasYSlider && dH > 0) ? actualH / dH : 1.0;

  /** Convert a DXF-space point → SVG space (apply sliders, offset origin, flip Y, scale) */
  function toSvg(pt: [number, number]): [number, number] {
    const [ax, ay] = applySlidersToPt(pt, sliders, actualW, actualH, dW, dH);
    return [(ax - ip.x) * scale, -(ay - ip.y) * yScale * scale];
  }

  const strokeScale = scale < 0.5 ? 1 / scale : 1; // keep stroke visible at small scales

  for (const g of all) {
    // Skip layers explicitly excluded
    const layerKey = (g.layer ?? '').toLowerCase();
    if (skipSet.has(layerKey)) continue;
    // Skip if entity has viewTypes restriction and current viewType doesn't match
    if (viewType && g.viewTypes && !g.viewTypes.includes(viewType)) continue;
    // Layer color takes priority: exact match → lowercased match → overrideColor → entity color
    const stroke = layerColors?.[layerKey] ?? layerColors?.[g.layer ?? ''] ?? overrideColor ?? g.color;
    // Layer lineweight takes priority over entity lineweight
    const baseWeight = layerLineWeights?.[layerKey] ?? layerLineWeights?.[g.layer ?? ''] ?? g.lineweight;
    const sw = (baseWeight * scale * strokeScale).toFixed(2);

    switch (g.type) {
      case 'lwpolyline': {
        if (!g.vertices || g.vertices.length < 2) break;
        const pts = g.vertices.map((v) => toSvg(v));
        const ptStr = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
        if (g.closed) {
          parts.push(`<polygon points="${ptStr}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`);
        } else {
          parts.push(`<polyline points="${ptStr}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`);
        }
        break;
      }

      case 'line': {
        if (!g.start || !g.end) break;
        const [x1, y1] = toSvg(g.start);
        const [x2, y2] = toSvg(g.end);
        parts.push(
          `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${stroke}" stroke-width="${sw}"/>`,
        );
        break;
      }

      case 'arc': {
        if (!g.center || g.radius == null) break;
        const [cx, cy] = toSvg(g.center);
        const r = (g.radius * scale).toFixed(2);
        const a0 = ((g.startAngle ?? 0) * Math.PI) / 180;
        const a1 = ((g.endAngle ?? 360) * Math.PI) / 180;
        const x0 = (parseFloat(cx.toFixed(2)) + g.radius * scale * Math.cos(a0)).toFixed(2);
        const y0 = (parseFloat(cy.toFixed(2)) - g.radius * scale * Math.sin(a0)).toFixed(2); // Y flipped
        const x1 = (parseFloat(cx.toFixed(2)) + g.radius * scale * Math.cos(a1)).toFixed(2);
        const y1 = (parseFloat(cy.toFixed(2)) - g.radius * scale * Math.sin(a1)).toFixed(2);
        const sweep = (g.endAngle ?? 360) - (g.startAngle ?? 0);
        const large = Math.abs(sweep) > 180 ? 1 : 0;
        // Sweep direction: DXF arcs are CCW in math coords; after Y-flip they become CW in SVG
        parts.push(
          `<path d="M ${x0} ${y0} A ${r} ${r} 0 ${large} 0 ${x1} ${y1}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`,
        );
        break;
      }

      case 'circle': {
        if (!g.center || g.radius == null) break;
        const [cx, cy] = toSvg(g.center);
        const r = (g.radius * scale).toFixed(2);
        parts.push(
          `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`,
        );
        break;
      }

      case 'text': {
        if (!g.position) break;
        const [tx, ty] = toSvg(g.position);
        const fs = ((g.height ?? 12) * scale).toFixed(1);
        const txt = (g.content ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        parts.push(
          `<text x="${tx.toFixed(2)}" y="${ty.toFixed(2)}" font-size="${fs}" fill="${stroke}">${txt}</text>`,
        );
        break;
      }

      default:
        break;
    }
  }

  return parts;
}

/**
 * Render a complete standalone SVG string for symbol preview panels.
 *
 * @param sym       The parsed bglib symbol
 * @param actualW   Actual opening width in mm
 * @param actualH   Actual wall thickness / height in mm
 * @param svgW      Output SVG pixel width
 * @param svgH      Output SVG pixel height
 * @param padding   Padding in SVG pixels (default 16)
 */
export function renderBglibSymbolSVG(
  sym: BglibSymbol,
  actualW: number,
  actualH: number,
  svgW: number,
  svgH: number,
  padding = 16,
  layerColors?: Record<string, string>,
): string {
  // Compute rendered extent after sliders
  const renderedW = actualW;
  const renderedH = Math.max(actualH, sym.defaultHeight);
  const scale = Math.min(
    (svgW - padding * 2) / (renderedW || 1),
    (svgH - padding * 2) / (renderedH || 1),
  );

  const elems = renderBglibSymbolElements(sym, actualW, actualH, scale, false, layerColors, undefined, undefined, undefined);

  // An explicit undefined viewType = render all entities (preview shows everything)

  // Center in SVG: insertion point (0,0) in DXF space maps to center
  const ox = svgW / 2;
  const oy = svgH / 2 + (renderedH / 2) * scale;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" style="background:#f4f4f0">
  <g transform="translate(${ox.toFixed(1)},${oy.toFixed(1)})">
    ${elems.join('\n    ')}
  </g>
</svg>`;
}

/**
 * Compute the SVG transform matrix for placing a bglib symbol inside a floor plan.
 *
 * Returns an SVG `transform="matrix(...)"` attribute string that maps the symbol's
 * local coordinate system (X along wall, Y perpendicular outward) to SVG space.
 *
 * @param sfO         Start of opening on outer face {x, y} in SVG pixels
 * @param ux, uy      Unit vector along the wall in SVG space
 * @param wallDir     +1 = inner face above outer in SVG, -1 = below
 * @param scale       mm → SVG pixels
 */
export function bglibSymbolMatrix(
  sfO: { x: number; y: number },
  ux: number,
  uy: number,
  wallDir: number,
  scale: number,
): string {
  // Symbol local X → along wall → (ux, uy) * scale
  // Symbol local Y → perpendicular (into wall) → (-uy, ux) * wallDir * scale
  // After Y-flip by renderer: local Y becomes -local Y, so perpendicular is (uy, -ux) * wallDir * scale
  const a = ux * scale;
  const b = uy * scale;
  const c = -(-uy) * wallDir * scale;  // = uy * wallDir * scale ... explained below
  const d = -ux * wallDir * scale;     // after Y-flip
  // Actually simpler: the renderer already flips Y via `-(ay - ip.y) * scale`.
  // So in SVG space: local (x, y) → (x * scale, -y * scale)
  // We then rotate to align with wall direction (ux, uy):
  //   SVG-x' = ux * svgX - uy * svgY  (rotate)
  //   SVG-y' = uy * svgX + ux * svgY
  // Combined: local (lx, ly) → SVG (ux*lx*S + uy*ly*S, uy*lx*S - ux*ly*S) + translate
  const A = ux * scale;
  const B = uy * scale;
  const C = uy * scale * wallDir;
  const D = -ux * scale * wallDir;
  return `matrix(${A.toFixed(4)},${B.toFixed(4)},${C.toFixed(4)},${D.toFixed(4)},${sfO.x.toFixed(2)},${sfO.y.toFixed(2)})`;
}
