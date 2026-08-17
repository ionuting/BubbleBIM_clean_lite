/**
 * materialConfig.ts — Visual material configuration for all BubbleGraph viewers.
 *
 * A `MaterialVisuals` entry defines how an element is rendered in:
 *   - 3D viewers  (color_3d, opacity_3d)
 *   - 2D plan section (cut) — structural elements intersected by cut plane:
 *       section_line_color, section_line_weight, section_line_style, section_fill_color, section_fill_opacity
 *   - 2D plan view (overhead / visible below cut) — elements seen but not cut:
 *       view_line_color, view_line_weight, view_line_style
 *
 * All optional section_* / view_* fields fall back to the base color_2d / line_weight.
 *
 * Resolution order for a given node:
 *   1. node.properties.material → look up in materialConfig.materials[id]
 *   2. fall back to materialConfig.element_defaults[node.type]
 *   3. fall back to FALLBACK_VISUALS
 */

export type HatchPattern = 'none' | 'solid' | 'diagonal' | 'crosshatch' | 'wave' | 'brick' | 'stone' | 'concrete';
export type LineStyle    = 'solid' | 'dashed' | 'dotted' | 'dash-dot';

export interface MaterialVisuals {
  /** hex string, e.g. "#8A8A8A" — base 3D colour */
  color_3d: string;
  opacity_3d: number;
  /** Base 2D fallback colour (used when section_* / view_* are not set) */
  color_2d: string;
  opacity_2d: number;
  /** SVG stroke-width fallback for cut edges in 2D views */
  line_weight: number;
  hatch: HatchPattern;
  /** Optional fill texture path relative to /textures/ (e.g. "brick.svg") */
  fill_texture?: string;

  // ── Section / Cut properties (element intersected by the cutting plane) ──
  /** Line colour when element is cut. Defaults to color_2d. */
  section_line_color?: string;
  /** Line weight when cut. Defaults to line_weight. */
  section_line_weight?: number;
  /** Line style when cut. Defaults to 'solid'. */
  section_line_style?: LineStyle;
  /** Fill colour of cut cross-section. Defaults to color_2d. */
  section_fill_color?: string;
  /** Fill opacity of cut cross-section. Defaults to opacity_2d. */
  section_fill_opacity?: number;

  // ── 2D View / Overhead properties (element visible but not cut) ──────────
  /** Line colour when seen but not cut. Defaults to color_2d. */
  view_line_color?: string;
  /** Line weight when seen. Defaults to line_weight * 0.6. */
  view_line_weight?: number;
  /** Line style when seen. Defaults to 'dashed'. */
  view_line_style?: LineStyle;
}

// ── Derived section / view accessors ─────────────────────────────────────────

export function getSectionLineColor(v: MaterialVisuals):   string    { return v.section_line_color   ?? v.color_2d; }
export function getSectionLineWeight(v: MaterialVisuals):  number    { return v.section_line_weight  ?? v.line_weight; }
export function getSectionLineStyle(v: MaterialVisuals):   LineStyle { return v.section_line_style   ?? 'solid'; }
export function getSectionFillColor(v: MaterialVisuals):   string    { return v.section_fill_color   ?? v.color_2d; }
export function getSectionFillOpacity(v: MaterialVisuals): number    { return v.section_fill_opacity ?? v.opacity_2d; }

export function getViewLineColor(v: MaterialVisuals):   string    { return v.view_line_color   ?? v.color_2d; }
export function getViewLineWeight(v: MaterialVisuals):  number    { return v.view_line_weight  ?? v.line_weight * 0.6; }
export function getViewLineStyle(v: MaterialVisuals):   LineStyle { return v.view_line_style   ?? 'dashed'; }

/**
 * Convert a LineStyle to an SVG stroke-dasharray string.
 * Returns undefined for 'solid'.
 */
export function lineStyleToDashArray(style: LineStyle): string | undefined {
  switch (style) {
    case 'dashed':   return '8 4';
    case 'dotted':   return '2 3';
    case 'dash-dot': return '8 3 2 3';
    default:         return undefined; // solid
  }
}


export interface NamedMaterial extends MaterialVisuals {
  label: string;
}

/** Global settings for window/door frame and glass rendering (3D only). */
export interface WindowGlazingConfig {
  frame_color: string;       // hex
  frame_metalness: number;   // 0–1
  frame_roughness: number;   // 0–1
  glass_color: string;       // hex
  glass_opacity: number;     // 0–1
  glass_roughness: number;   // 0–1
  glass_metalness: number;   // 0–1
}

export interface MaterialConfig {
  version: number;
  /** per node-type defaults */
  element_defaults: Record<string, MaterialVisuals>;
  /** named material catalogue, keyed by material id */
  materials: Record<string, NamedMaterial>;
  /** global window/door frame & glass appearance */
  window_glazing?: WindowGlazingConfig;
}

// ─── Fallback (hardcoded minimums, always available) ────────────────────────

export const FALLBACK_VISUALS: MaterialVisuals = {
  color_3d: '#888888',
  opacity_3d: 1.0,
  color_2d: '#888888',
  opacity_2d: 1.0,
  line_weight: 0.4,
  hatch: 'solid',
};

/** Built-in element defaults — mirrors backend/materials.yaml element_defaults.
 *  Used before the YAML is fetched from the backend. */
export const BUILTIN_ELEMENT_DEFAULTS: Record<string, MaterialVisuals> = {
  column:     { color_3d: '#3B82F6', opacity_3d: 1.0, color_2d: '#1E293B', opacity_2d: 1.0, line_weight: 0.5, hatch: 'solid',
                section_line_color: '#1E293B', section_line_weight: 0.6, section_line_style: 'solid', section_fill_color: '#CBD5E1', section_fill_opacity: 1.0,
                view_line_color: '#94A3B8', view_line_weight: 0.3, view_line_style: 'dashed' },
  beam:       { color_3d: '#10B981', opacity_3d: 1.0, color_2d: '#475569', opacity_2d: 1.0, line_weight: 0.4, hatch: 'diagonal',
                section_line_color: '#475569', section_line_weight: 0.5, section_line_style: 'solid', section_fill_color: '#94A3B8', section_fill_opacity: 0.8,
                view_line_color: '#64748B', view_line_weight: 0.3, view_line_style: 'dashed' },
  wall:       { color_3d: '#F59E0B', opacity_3d: 1.0, color_2d: '#334155', opacity_2d: 1.0, line_weight: 0.5, hatch: 'solid',
                section_line_color: '#1E293B', section_line_weight: 0.7, section_line_style: 'solid', section_fill_color: '#334155', section_fill_opacity: 0.5,
                view_line_color: '#64748B', view_line_weight: 0.35, view_line_style: 'dashed' },
  slab:       { color_3d: '#8B5CF6', opacity_3d: 1.0, color_2d: '#CBD5E1', opacity_2d: 1.0, line_weight: 0.35, hatch: 'diagonal',
                section_line_color: '#64748B', section_line_weight: 0.4, section_line_style: 'solid', section_fill_color: '#E2E8F0', section_fill_opacity: 1.0,
                view_line_color: '#94A3B8', view_line_weight: 0.25, view_line_style: 'dashed' },
  foundation: { color_3d: '#EF4444', opacity_3d: 1.0, color_2d: '#7F1D1D', opacity_2d: 1.0, line_weight: 0.6, hatch: 'crosshatch',
                section_line_color: '#7F1D1D', section_line_weight: 0.8, section_line_style: 'solid', section_fill_color: '#B91C1C', section_fill_opacity: 0.9,
                view_line_color: '#991B1B', view_line_weight: 0.4, view_line_style: 'dashed' },
  window:     { color_3d: '#38BDF8', opacity_3d: 0.55, color_2d: '#BAE6FD', opacity_2d: 0.7, line_weight: 0.25, hatch: 'none',
                section_line_color: '#38BDF8', section_line_weight: 0.3, section_line_style: 'solid', section_fill_color: '#E0F2FE', section_fill_opacity: 0.5,
                view_line_color: '#BAE6FD', view_line_weight: 0.2, view_line_style: 'solid' },
  door:       { color_3d: '#FB923C', opacity_3d: 1.0, color_2d: '#F59E0B', opacity_2d: 1.0, line_weight: 0.3, hatch: 'none',
                section_line_color: '#F59E0B', section_line_weight: 0.4, section_line_style: 'solid', section_fill_color: '#FEF3C7', section_fill_opacity: 0.7,
                view_line_color: '#F59E0B', view_line_weight: 0.25, view_line_style: 'solid' },
  room:       { color_3d: '#14B8A6', opacity_3d: 0.15, color_2d: '#CCFBF1', opacity_2d: 0.25, line_weight: 0.2, hatch: 'none',
                view_line_color: '#99F6E4', view_line_weight: 0.15, view_line_style: 'dashed' },
  shell:      { color_3d: '#A855F7', opacity_3d: 1.0, color_2d: '#D8B4FE', opacity_2d: 1.0, line_weight: 0.4, hatch: 'diagonal',
                section_line_color: '#7E22CE', section_line_weight: 0.6, section_line_style: 'solid', section_fill_color: '#C084FC', section_fill_opacity: 0.9,
                view_line_color: '#D8B4FE', view_line_weight: 0.25, view_line_style: 'dashed' },
  covering:   { color_3d: '#F43F5E', opacity_3d: 1.0, color_2d: '#FDA4AF', opacity_2d: 1.0, line_weight: 0.35, hatch: 'diagonal',
                section_line_color: '#BE123C', section_line_weight: 0.5, section_line_style: 'solid', section_fill_color: '#FB7185', section_fill_opacity: 0.85,
                view_line_color: '#FDA4AF', view_line_weight: 0.2, view_line_style: 'dashed' },
  roof:       { color_3d: '#C2410C', opacity_3d: 0.95, color_2d: '#FB923C', opacity_2d: 0.85, line_weight: 0.4, hatch: 'diagonal',
                section_line_color: '#9A3412', section_line_weight: 0.55, section_line_style: 'solid', section_fill_color: '#FDBA74', section_fill_opacity: 0.9,
                view_line_color: '#FDBA74', view_line_weight: 0.25, view_line_style: 'dashed' },
  roof_ridge: { color_3d: '#9A3412', opacity_3d: 1.0, color_2d: '#9A3412', opacity_2d: 1.0, line_weight: 0.5, hatch: 'none',
                view_line_color: '#9A3412', view_line_weight: 0.4, view_line_style: 'solid' },
  ax:         { color_3d: '#94A3B8', opacity_3d: 1.0, color_2d: '#94A3B8', opacity_2d: 0.8, line_weight: 0.2, hatch: 'none',
                view_line_color: '#CBD5E1', view_line_weight: 0.15, view_line_style: 'dotted' },
};

/** Built-in window/door glazing defaults — used before backend fetch. */
export const BUILTIN_WINDOW_GLAZING: WindowGlazingConfig = {
  frame_color:     '#383C42',  // anthracite
  frame_metalness: 0.5,
  frame_roughness: 0.35,
  glass_color:     '#1F61A6',  // blue-tinted
  glass_opacity:   0.35,
  glass_roughness: 0.05,
  glass_metalness: 0.15,
};

/** Built-in named materials (EN labels) — used offline / Clean Lite when backend is unavailable. */
export const BUILTIN_MATERIALS: Record<string, NamedMaterial> = {
  concrete: {
    label: 'Concrete',
    color_3d: '#8A8A8A', opacity_3d: 1, color_2d: '#BEBEBE', opacity_2d: 1, line_weight: 0.5, hatch: 'solid',
  },
  concrete_reinforced: {
    label: 'Reinforced concrete',
    color_3d: '#6B7280', opacity_3d: 1, color_2d: '#9CA3AF', opacity_2d: 1, line_weight: 0.5, hatch: 'crosshatch',
  },
  brick: {
    label: 'Brick',
    color_3d: '#C0614A', opacity_3d: 1, color_2d: '#D4836A', opacity_2d: 1, line_weight: 0.4, hatch: 'brick',
  },
  steel: {
    label: 'Steel',
    color_3d: '#4A5568', opacity_3d: 1, color_2d: '#718096', opacity_2d: 1, line_weight: 0.35, hatch: 'crosshatch',
  },
  glass: {
    label: 'Glass',
    color_3d: '#87CEEB', opacity_3d: 0.35, color_2d: '#BAE6FD', opacity_2d: 0.5, line_weight: 0.2, hatch: 'none',
  },
  wood: {
    label: 'Wood',
    color_3d: '#8B6914', opacity_3d: 1, color_2d: '#C4A05A', opacity_2d: 1, line_weight: 0.4, hatch: 'diagonal',
  },
  gypsum: {
    label: 'Gypsum board',
    color_3d: '#F5F5DC', opacity_3d: 1, color_2d: '#EFEFD0', opacity_2d: 1, line_weight: 0.25, hatch: 'solid',
  },
  insulation: {
    label: 'Thermal insulation',
    color_3d: '#FFD580', opacity_3d: 0.9, color_2d: '#FFF3B0', opacity_2d: 0.9, line_weight: 0.2, hatch: 'wave',
  },
  stone: {
    label: 'Stone',
    color_3d: '#9E9E9E', opacity_3d: 1, color_2d: '#BDBDBD', opacity_2d: 1, line_weight: 0.5, hatch: 'stone',
  },
  aluminium: {
    label: 'Aluminium',
    color_3d: '#C0C0CC', opacity_3d: 1, color_2d: '#D1D5DB', opacity_2d: 1, line_weight: 0.3, hatch: 'diagonal',
  },
  timber_structural: {
    label: 'Structural timber',
    color_3d: '#A0522D', opacity_3d: 1, color_2d: '#D2B48C', opacity_2d: 1, line_weight: 0.4, hatch: 'diagonal',
  },
  ceramic_tile: {
    label: 'Ceramic tile',
    color_3d: '#E8E8E8', opacity_3d: 1, color_2d: '#F0F0F0', opacity_2d: 1, line_weight: 0.3, hatch: 'grid',
  },
  plaster: {
    label: 'Plaster finish',
    color_3d: '#F5F5DC', opacity_3d: 1, color_2d: '#EFEFD0', opacity_2d: 1, line_weight: 0.25, hatch: 'solid',
  },
  aac_block: {
    label: 'AAC block (BCA)',
    color_3d: '#D8D8D8', opacity_3d: 1, color_2d: '#E8E8E8', opacity_2d: 1, line_weight: 0.4, hatch: 'grid',
  },
};

/** Offline / Clean default config (English labels). */
export const BUILTIN_MATERIAL_CONFIG: MaterialConfig = {
  version: 1,
  element_defaults: BUILTIN_ELEMENT_DEFAULTS,
  materials: BUILTIN_MATERIALS,
  window_glazing: BUILTIN_WINDOW_GLAZING,
};

/** Resolve the window glazing config. */
export function resolveWindowGlazing(config: MaterialConfig | null): WindowGlazingConfig {
  return config?.window_glazing ?? BUILTIN_WINDOW_GLAZING;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the MaterialVisuals for a node.
 * @param nodeType  node.type
 * @param materialId  node.properties.material (may be undefined)
 * @param config  the loaded config (null = not yet loaded)
 */
export function resolveVisuals(
  nodeType: string,
  materialId: string | undefined | null,
  config: MaterialConfig | null,
): MaterialVisuals {
  // 1. Named material override
  if (materialId) {
    const named = config?.materials?.[materialId];
    if (named) return named;
  }
  // 2. Element-type default from config
  if (config?.element_defaults?.[nodeType]) return config.element_defaults[nodeType];
  // 3. Built-in element default
  if (BUILTIN_ELEMENT_DEFAULTS[nodeType]) return BUILTIN_ELEMENT_DEFAULTS[nodeType];
  // 4. Hard fallback
  return FALLBACK_VISUALS;
}

/**
 * Apply per-node color_3d / color_2d property overrides on top of resolved visuals.
 * Resolution order: node.properties.color_3d → material → element_defaults → fallback.
 * Nodes that have color_3d/color_2d set will override whatever the material says.
 */
export function applyNodeColorOverrides(
  visuals: MaterialVisuals,
  nodeProps: Record<string, unknown>,
): MaterialVisuals {
  const c3d = String(nodeProps.color_3d ?? '').trim();
  const c2d = String(nodeProps.color_2d ?? '').trim();
  if (!c3d && !c2d) return visuals;
  return {
    ...visuals,
    ...(c3d ? { color_3d: c3d } : {}),
    ...(c2d ? { color_2d: c2d, section_fill_color: c2d } : {}),
  };
}

/** Parse a CSS hex color "#RRGGBB" to [r, g, b] in 0–1 range. */
export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const len = h.length;
  if (len === 3) {
    return [
      parseInt(h[0] + h[0], 16) / 255,
      parseInt(h[1] + h[1], 16) / 255,
      parseInt(h[2] + h[2], 16) / 255,
    ];
  }
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}
