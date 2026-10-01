/**
 * graphicStyle.ts — how a 2D view is drawn, as a choice of the view.
 *
 * The 2D engine says WHAT is on a drawing — this face is cut, that one only
 * seen, this is brick and hatched so. A graphic style says how it LOOKS, the
 * way a Revit view's visual style or view template does, without touching the
 * model or the drawing:
 *
 *   color         the materials' own colours and hatches (the default)
 *   technical     black on white: cut faces white with their hatch in black,
 *                 seen faces white, every line black — the drawing that prints
 *   poche         cut faces filled solid black, seen faces white — the
 *                 classic poché plan, the cut read at a glance
 *   presentation  soft material tints, no hatch on what is seen, the cut
 *                 outlined heavier — a drawing for the client
 */
import type { DrawingShape } from '@/lib/drawingEngine';
import type { HatchPattern } from '@/lib/materialConfig';

export type GraphicStyleId = 'color' | 'technical' | 'poche' | 'presentation';

export interface GraphicStyle {
  id: GraphicStyleId;
  label: string;
  /** The face's fill, or 'none'. `seen` = projected/hidden, not cut. */
  fill(sh: DrawingShape, seen: boolean): string;
  stroke(sh: DrawingShape, seen: boolean): string;
  hatch(sh: DrawingShape, seen: boolean): HatchPattern;
  /** Multiplier on the cut line weight. */
  cutWeight: number;
  axis: string;
  axisText: string;
  level: string;
  levelText: string;
  dim: string;
  ground: string;
  earth: string;
}

/** `hex` moved `k` of the way to white. */
function lighten(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * k);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

const COLOR: GraphicStyle = {
  id: 'color', label: 'Color',
  fill: (sh) => sh.fillColor,
  stroke: (sh) => sh.strokeColor,
  hatch: (sh) => sh.hatch,
  cutWeight: 1,
  axis: '#d946ef', axisText: '#9d00c4', level: '#94a3b8', levelText: '#475569', dim: '#334155',
  ground: '#8B5E3C', earth: '#c4a882',
};

const INK = '#111111';

/** What a poché drawing fills black when cut: the structure, not the spaces. */
const POCHE_TYPES = new Set(['wall', 'column', 'beam', 'shell', 'foundation', 'stairwell', 'stair_flight', 'chimney', 'sweep']);

export const GRAPHIC_STYLES: Record<GraphicStyleId, GraphicStyle> = {
  color: COLOR,
  technical: {
    id: 'technical', label: 'Tehnic (alb-negru)',
    fill: (sh) => (sh.fillColor && sh.fillColor !== 'none' ? '#ffffff' : 'none'),
    stroke: (_sh, seen) => (seen ? '#444444' : INK),
    hatch: (sh, seen) => (seen ? 'none' : sh.hatch),
    cutWeight: 1.15,
    axis: '#555555', axisText: INK, level: '#888888', levelText: INK, dim: INK,
    ground: INK, earth: '#bdbdbd',
  },
  poche: {
    id: 'poche', label: 'Poché',
    // Only what carries the building is filled: a room or a floor cut by the
    // plan stays white, or the poché plan would be one black slab.
    fill: (sh, seen) => (sh.fillColor && sh.fillColor !== 'none'
      ? (!seen && POCHE_TYPES.has(sh.nodeType) ? '#1c1c1c' : '#ffffff') : 'none'),
    stroke: (_sh, seen) => (seen ? '#555555' : INK),
    hatch: () => 'none',
    cutWeight: 1,
    axis: '#666666', axisText: INK, level: '#999999', levelText: '#333333', dim: INK,
    ground: INK, earth: '#cfcfcf',
  },
  presentation: {
    id: 'presentation', label: 'Prezentare',
    fill: (sh, seen) => (sh.fillColor && sh.fillColor !== 'none' ? lighten(sh.fillColor, seen ? 0.55 : 0.25) : 'none'),
    stroke: (sh, seen) => (seen ? lighten(sh.strokeColor, 0.35) : sh.strokeColor),
    hatch: (sh, seen) => (seen ? 'none' : sh.hatch),
    cutWeight: 1.4,
    axis: '#c4b5fd', axisText: '#6d28d9', level: '#cbd5e1', levelText: '#64748b', dim: '#475569',
    ground: '#6b4f3a', earth: '#e7dccb',
  },
};

export const GRAPHIC_STYLE_IDS = Object.keys(GRAPHIC_STYLES) as GraphicStyleId[];

export function graphicStyleOf(id: string | undefined | null): GraphicStyle {
  return GRAPHIC_STYLES[(id ?? 'color') as GraphicStyleId] ?? COLOR;
}
