/**
 * ifcAppearance.ts — the colour and material an exported element carries.
 *
 * The IFC export used to write geometry only: every element came out in the
 * library's default grey, and the material settings the viewers draw from —
 * the element defaults, the named catalogue, a node's own colour override —
 * never reached the file. This module is the bridge. It answers one question
 * for one element: what does the 3D viewer show for it, and what should the
 * file say?
 *
 * The answer is computed by the SAME resolver the viewers use
 * (`resolveVisuals` then `applyNodeColorOverrides`), so the precedence is
 * identical: a node's `color_3d` beats its named material, which beats the
 * element-type default. Colour comes from `color_3d`, because a file opened
 * in a 3D viewer is the 3D view of the model.
 *
 * Opacity is the one thing `@ifc-lite/create` cannot write — its surface
 * style is always opaque — so it is carried in the STYLE NAME and applied to
 * the generated text afterwards (`applyStyleTransparency`). A window at 55%
 * therefore gets a style called "window 55%" whose rendering says
 * Transparency 0.45, which is what IfcSurfaceStyleRendering measures.
 */

import type { BubbleGraphNode } from '@/store';
import {
  applyNodeColorOverrides, hexToRgb01, lookupMaterial, resolveVisuals,
  type MaterialConfig,
} from '@/lib/materialConfig';
import { editEntityById, stepReal, tokeniseArgs, unquote } from './stepText';

export interface IfcAppearance {
  /** Name of the IfcSurfaceStyle. Carries the opacity when it is not 1. */
  styleName: string;
  /** 0–1 per channel, what `IfcCreator.setColor` takes. */
  rgb: [number, number, number];
  /** 0–1; 1 is opaque. */
  opacity: number;
  /** Name for the IfcMaterial, or null when the node names no material. */
  materialName: string | null;
  /** IfcMaterial.Category — the element kind, capitalised. */
  materialCategory: string;
}

const GREY: [number, number, number] = [0.5, 0.5, 0.5];
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A CSS hex colour as 0–1 channels; grey for anything that is not one. */
export function rgbOf(hex: string | undefined | null): [number, number, number] {
  const s = String(hex ?? '').trim();
  if (!HEX.test(s)) return GREY;
  const [r, g, b] = hexToRgb01(s.startsWith('#') ? s : `#${s}`);
  return [r, g, b];
}

/**
 * What the file should say about `node`, drawn as element kind `resolveAs`
 * (defaults to the node's own type — pass it when a node is exported as
 * something else, as a room's slab or a wall's ring beam are).
 */
export function appearanceOf(
  node: BubbleGraphNode,
  config: MaterialConfig | null,
  resolveAs?: string,
): IfcAppearance {
  const kind = resolveAs ?? node.type;
  const materialId = String(node.properties.material ?? '').trim();
  const vis = applyNodeColorOverrides(resolveVisuals(kind, materialId, config), node.properties);

  // The catalogue's label is what the settings call the material; a name
  // that resolves to nothing is still a name the user typed, so it is kept.
  const named = materialId ? lookupMaterial(materialId, config) : undefined;
  const label = named && 'label' in named ? String((named as { label?: string }).label ?? '') : '';
  const materialName = materialId ? (label || materialId) : null;

  const raw = Number(vis.opacity_3d);
  const opacity = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
  const base = materialName ?? kind;
  const styleName = opacity < 1 ? `${base} ${Math.round(opacity * 100)}%` : base;

  return {
    styleName,
    rgb: rgbOf(vis.color_3d),
    opacity,
    materialName,
    materialCategory: kind.charAt(0).toUpperCase() + kind.slice(1),
  };
}

const STYLE_LINE = /^#(\d+)=IFCSURFACESTYLE\((.*)\);$/i;

/**
 * Write the opacities into the generated file.
 *
 * `@ifc-lite/create` emits one IfcSurfaceStyle per distinct (name, colour)
 * and hard-codes its rendering's Transparency to 0. This finds each style by
 * the name `appearanceOf` gave it, follows its rendering reference, and sets
 * Transparency = 1 − opacity. Styles not in the map are left alone, as is a
 * file with no styles at all.
 */
export function applyStyleTransparency(text: string, opacityByStyle: Map<string, number>): string {
  if (opacityByStyle.size === 0) return text;
  let out = text;
  for (const line of text.split('\n')) {
    const m = STYLE_LINE.exec(line.trim());
    if (!m) continue;
    const args = tokeniseArgs(m[2]);
    // STEP doubles an apostrophe inside a string; `unquote` leaves that alone.
    const name = unquote(args[0] ?? '').replace(/''/g, "'");
    const opacity = opacityByStyle.get(name);
    if (opacity === undefined || opacity >= 1) continue;
    // The third argument is the style list: `(#12)` — one rendering.
    const renderingId = /#(\d+)/.exec(args[2] ?? '');
    if (!renderingId) continue;
    out = editEntityById(out, parseInt(renderingId[1], 10), (type, a) => {
      if (type !== 'IFCSURFACESTYLERENDERING') return;
      // Rounded so 1 − 0.55 reads 0.45, not a binary tail.
      a[1] = stepReal(Math.round((1 - opacity) * 1000) / 1000);
      return a;
    });
  }
  return out;
}
