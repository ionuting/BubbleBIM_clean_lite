/**
 * style.ts — addressing tiled elements by their IFC GlobalId.
 *
 * This is the whole reason the tileset carries a property table. Once an
 * element's GlobalId is in the tile, 3D Tiles can pick it, hide it and colour
 * it natively, with no per-element geometry and no work on our side beyond
 * writing an expression. The identifier is the same one the fragments path
 * reports and the same one the host platform stores as `componentSourceId`,
 * so a selection made in any of the three rendering modes, or arriving from
 * the platform, names the same thing.
 *
 * The 3D Tiles styling language is a small expression language evaluated per
 * feature. `${guid}` reads the `guid` property from the table; everything
 * here is string building, which is why it is pure and testable — an
 * expression with a stray quote fails silently at runtime, colouring nothing
 * and reporting nothing.
 */

/** A 3D Tiles style document, in the shape `new Cesium3DTileStyle(...)` takes. */
export interface TileStyleDocument {
  color?: { conditions: Array<[string, string]> } | string;
  show?: string;
}

/**
 * A GlobalId as a styling-language string literal.
 *
 * IFC GlobalIds are base64-ish and contain `$` and `_`, none of which need
 * escaping — but a single quote would end the literal early and turn the rest
 * of the expression into syntax, so it is escaped. A GlobalId containing one
 * would be malformed, and guarding costs a line.
 */
export function guidLiteral(guid: string): string {
  return `'${guid.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Cesium wants `color('#rrggbb', alpha)`; alpha defaults to opaque. */
export function colourLiteral(css: string, alpha = 1): string {
  return `color(${guidLiteral(css)}, ${alpha})`;
}

/**
 * Paint one element and leave the rest as they are.
 *
 * The fallback condition matters: without a `true` arm every feature that
 * does not match evaluates to no colour, and Cesium renders those white
 * rather than leaving the model's own colours alone.
 */
export function highlightGuidStyle(
  guid: string | null,
  highlight = '#ffd700',
  base = '#ffffff',
): TileStyleDocument {
  if (!guid) return { color: colourLiteral(base) };
  return {
    color: {
      conditions: [
        [`\${guid} === ${guidLiteral(guid)}`, colourLiteral(highlight)],
        ['true', colourLiteral(base)],
      ],
    },
  };
}

/**
 * Colour many elements at once, which is what a host asking to shade a model
 * by some measured value actually needs. Unmatched features keep `base`.
 */
export function colourByGuidStyle(
  colours: Record<string, string>,
  base = '#ffffff',
): TileStyleDocument {
  const conditions: Array<[string, string]> = Object.entries(colours)
    .filter(([guid, css]) => !!guid && !!css)
    .map(([guid, css]) => [`\${guid} === ${guidLiteral(guid)}`, colourLiteral(css)]);
  conditions.push(['true', colourLiteral(base)]);
  return { color: { conditions } };
}

/** Show only the named elements. An empty list shows everything, not nothing. */
export function showOnlyGuidsStyle(guids: string[]): TileStyleDocument {
  const wanted = guids.filter(Boolean);
  if (wanted.length === 0) return { show: 'true' };
  return { show: wanted.map((g) => `\${guid} === ${guidLiteral(g)}`).join(' || ') };
}

/** No styling at all — the model as the tileset draws it. */
export const NO_STYLE: TileStyleDocument = {};
