/**
 * windowSymbolLibrary.ts — 2D plan symbol configuration for windows.
 *
 * Defines parametric 2D floor-plan representation settings per window type.
 * Settings are global (apply to all instances of that window type / opening kind).
 *
 * Priority resolution for a given window instance:
 *   1. per-type ID override  (e.g. 'W-DBL-120x140')
 *   2. per-opening override  (e.g. 'opening:double')
 *   3. built-in opening defaults
 *   4. DEFAULT_WINDOW_PLAN_CONFIG
 *
 * Terminology:
 *   Cut zone   — section cut by the floor-plan cut plane → heavy lines, solid fill
 *   Seen zone  — visible from above but not cut         → thin lines, hatch fill
 *   Sill zone  — parapet below window sill (seen zone)
 *   Frame sq   — square at window endpoints = frame cross-section
 *   Glass pane — narrow rect(s) between frame squares = glass
 */

import { WINDOW_TYPES, type WindowType } from './elementLibrary';

// ─── Config interface ─────────────────────────────────────────────────────────

export interface WindowPlan2DConfig {
  // ── Frame squares ─────────────────────────────────────────────────────────
  /** Full side length (mm) of each frame corner square. Default 70 mm. */
  squareSide_mm: number;
  /** Frame square outline color (hex). */
  frameColor: string;
  /** Line weight for frame squares (cut-weight convention). */
  cutLineWeight: number;
  /** Whether to draw frame corner squares. */
  showFrameSquares: boolean;

  // ── Glass panels ──────────────────────────────────────────────────────────
  /** Full width (mm) of glass pane rectangle in plan. Default 30 mm. */
  glassPanelWidth_mm: number;
  /** Glass pane outline color (hex). */
  glassColor: string;
  /** Line weight for glass pane outline (seen-weight convention). */
  seenLineWeight: number;
  /** Whether to draw glass pane rectangle(s) between squares. */
  showGlassPanel: boolean;

  // ── Sill / parapet zone (seen from above through the opening) ─────────────
  /** Draw the parapet fill rectangle inside the opening. */
  showSillZone: boolean;
  /** Fill color for the parapet (sill zone) rectangle. */
  sillFillColor: string;
  /** Fill opacity for the parapet rectangle. */
  sillFillOpacity: number;
  /** Outline color for the parapet rectangle (thin, "seen" convention). */
  sillLineColor: string;
  /** Dash size for the parapet outline (0 = solid). */
  sillLineDash: number;

  // ── Parallel frame lines (cross-section through wall) ─────────────────────
  /** Distance from wall centreline toward exterior for line 1 (outer frame). Default 125 mm. */
  outerLineOffset_mm: number;
  /** Distance from wall centreline toward interior for line 2 (inner frame). Default 125 mm. */
  innerLineOffset_mm: number;
  /** Extra depth of the sill/parapet zone beyond line 2 for line 3. Default 200 mm. */
  sillProjection_mm: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_WINDOW_PLAN_CONFIG: WindowPlan2DConfig = {
  squareSide_mm:    70,
  frameColor:       '#222222',
  cutLineWeight:    2,
  showFrameSquares: true,

  glassPanelWidth_mm: 30,
  glassColor:         '#5588AA',
  seenLineWeight:     1,
  showGlassPanel:     true,

  showSillZone:    true,
  sillFillColor:   '#D0D0C4',
  sillFillOpacity: 0.55,
  sillLineColor:   '#888888',
  sillLineDash:    0.04, // dashed outline for "seen" convention (metres)

  outerLineOffset_mm: 125,
  innerLineOffset_mm: 125,
  sillProjection_mm:  200,
};

/** Optional per-opening-type tweaks applied on top of DEFAULT. */
const OPENING_TYPE_OVERRIDES: Partial<Record<string, Partial<WindowPlan2DConfig>>> = {
  none:      {},
  single:    {},
  double:    {},
  'tilt-turn': {},
};

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Global mutable registry of user overrides.
 * Keys: typeId (e.g. 'W-DBL-120x140') or openingKey (e.g. 'opening:double').
 */
const _registry = new Map<string, Partial<WindowPlan2DConfig>>();

/** Canonical key for per-opening-type defaults. */
export function openingKey(opening: string): string {
  return `opening:${opening}`;
}

/** Resolve the full config for a window instance. */
export function resolveWindowPlan2DConfig(
  typeId: string,
  opening: string,
): WindowPlan2DConfig {
  return {
    ...DEFAULT_WINDOW_PLAN_CONFIG,
    ...(OPENING_TYPE_OVERRIDES[opening] ?? {}),
    ...(_registry.get(openingKey(opening)) ?? {}),
    ...(_registry.get(typeId) ?? {}),
  };
}

/** Set / merge overrides for a key. */
export function setWindowPlan2DConfig(
  key: string,
  overrides: Partial<WindowPlan2DConfig>,
): void {
  _registry.set(key, { ...(_registry.get(key) ?? {}), ...overrides });
  _listeners.forEach((fn) => fn());
}

/** Reset a key back to resolved defaults. */
export function resetWindowPlan2DConfig(key: string): void {
  _registry.delete(key);
  _listeners.forEach((fn) => fn());
}

/** Get the raw (user-set) overrides for a key, or undefined if not set. */
export function getRawOverride(key: string): Partial<WindowPlan2DConfig> | undefined {
  return _registry.get(key);
}

/** Export entire registry as a plain object (for persistence). */
export function exportRegistry(): Record<string, Partial<WindowPlan2DConfig>> {
  return Object.fromEntries(_registry.entries());
}

/** Import (replace) registry from a plain object (from persistence). */
export function importRegistry(data: Record<string, Partial<WindowPlan2DConfig>>): void {
  _registry.clear();
  for (const [k, v] of Object.entries(data)) _registry.set(k, v);
  _listeners.forEach((fn) => fn());
}

// ─── Pub / sub (framework-agnostic) ──────────────────────────────────────────

const _listeners = new Set<() => void>();

export function subscribeWindowSymbolConfig(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ─── SVG preview helper ───────────────────────────────────────────────────────

/**
 * Render a standalone SVG string showing the plan symbol for a window type.
 * The SVG represents a top-down view: wall thickness on the Y axis, window
 * width on the X axis.
 *
 * @param cfg       Resolved WindowPlan2DConfig
 * @param opening   'none' | 'single' | 'double' | 'tilt-turn'
 * @param wallThick_mm  wall thickness in mm (for preview proportions)
 * @param windowWidth_mm window opening width in mm
 * @param svgW / svgH  output pixel dimensions
 */
export function renderWindowPlanSymbolSVG(
  cfg: WindowPlan2DConfig,
  opening: 'none' | 'single' | 'double' | 'tilt-turn',
  wallThick_mm: number,
  windowWidth_mm: number,
  svgW: number,
  svgH: number,
): string {
  const PAD = 18;
  const available_w = svgW - PAD * 2;
  const available_h = svgH - PAD * 2;

  // Scale to fit window width horizontally AND the full 3-line symbol depth vertically
  const totalDepth_mm = cfg.outerLineOffset_mm + cfg.innerLineOffset_mm + cfg.sillProjection_mm;
  const scale = Math.min(
    available_w / windowWidth_mm,
    available_h / Math.max(wallThick_mm, totalDepth_mm + 20),
  );

  const W = windowWidth_mm * scale;
  const ox = (svgW - W) / 2;

  // Y positions: outer frame at top, sill at bottom, wall centre in between
  const symH   = totalDepth_mm * scale;
  const line1Y = (svgH - symH) / 2;                              // line 1 — outer frame
  const centY  = line1Y + cfg.outerLineOffset_mm * scale;        // wall centre
  const line2Y = centY  + cfg.innerLineOffset_mm * scale;        // line 2 — inner frame
  const line3Y = line2Y + cfg.sillProjection_mm  * scale;        // line 3 — sill

  // Wall band context (grey)
  const wallFaceTop = centY - (wallThick_mm / 2) * scale;
  const wallFaceBot = centY + (wallThick_mm / 2) * scale;

  const sq   = cfg.squareSide_mm * scale;
  const sqH  = sq / 2;
  const gw   = (cfg.glassPanelWidth_mm * scale) / 2;
  const lw   = cfg.cutLineWeight;
  const lwS  = cfg.seenLineWeight;

  // Square centres inset by sqH from each opening edge
  const s1cx = ox + sqH;
  const s2cx = ox + W - sqH;

  const parts: string[] = [];

  // ── 0. Wall context band (grey) ───────────────────────────────────────────
  const bandExt = 24;
  parts.push(`<rect x="${(ox - bandExt).toFixed(1)}" y="${wallFaceTop.toFixed(1)}" width="${(W + bandExt * 2).toFixed(1)}" height="${(wallFaceBot - wallFaceTop).toFixed(1)}" fill="#CBD5E1"/>`);

  // ── 1. White mask (line 1 → line 3) ──────────────────────────────────────
  parts.push(`<rect x="${ox.toFixed(1)}" y="${line1Y.toFixed(1)}" width="${W.toFixed(1)}" height="${(line3Y - line1Y).toFixed(1)}" fill="white"/>`);

  // ── 2. Sill zone fill (line 2 → line 3, optional) ─────────────────────────
  if (cfg.showSillZone) {
    const sillH  = line3Y - line2Y;
    const dashDA = cfg.sillLineDash > 0 ? 'stroke-dasharray="4 3"' : '';
    parts.push(`<rect x="${ox.toFixed(1)}" y="${line2Y.toFixed(1)}" width="${W.toFixed(1)}" height="${sillH.toFixed(1)}" fill="${cfg.sillFillColor}" fill-opacity="${cfg.sillFillOpacity}" stroke="${cfg.sillLineColor}" stroke-width="${lwS}" ${dashDA}/>`);
    const step = 10, diags: string[] = [];
    for (let i = -sillH; i < W + sillH; i += step) {
      diags.push(`<line x1="${(ox + i).toFixed(1)}" y1="${line2Y.toFixed(1)}" x2="${(ox + i + sillH).toFixed(1)}" y2="${line3Y.toFixed(1)}" stroke="${cfg.sillLineColor}" stroke-width="0.6" opacity="0.45"/>`);
    }
    parts.push(`<clipPath id="szc"><rect x="${ox}" y="${line2Y}" width="${W}" height="${sillH}"/></clipPath>`);
    parts.push(`<g clip-path="url(#szc)">${diags.join('')}</g>`);
  }

  // ── 3. Glass panel (at wall centre, between frame squares) ────────────────
  if (cfg.showGlassPanel) {
    const gStartX = s1cx + sqH;
    const gEndX   = s2cx - sqH;
    const drawGlass = (x1: number, x2: number) =>
      `<rect x="${x1.toFixed(1)}" y="${(centY - gw).toFixed(1)}" width="${(x2 - x1).toFixed(1)}" height="${(gw * 2).toFixed(1)}" fill="white" stroke="${cfg.glassColor}" stroke-width="${lwS}"/>`;
    if (opening === 'double') {
      const midX = ox + W / 2, midL = midX - sqH, midR = midX + sqH;
      if (gStartX < midL) parts.push(drawGlass(gStartX, midL));
      if (midR < gEndX)   parts.push(drawGlass(midR, gEndX));
    } else {
      if (gStartX < gEndX) parts.push(drawGlass(gStartX, gEndX));
    }
  }

  // ── 4. Frame squares (at wall centre, at each jamb) ──────────────────
  if (cfg.showFrameSquares) {
    const drawSq = (cx: number) =>
      `<rect x="${(cx - sqH).toFixed(1)}" y="${(centY - sqH).toFixed(1)}" width="${sq.toFixed(1)}" height="${sq.toFixed(1)}" fill="white" stroke="${cfg.frameColor}" stroke-width="${lw}" rx="0.5"/>`;
    parts.push(drawSq(s1cx));
    parts.push(drawSq(s2cx));
    if (opening === 'double') parts.push(drawSq(ox + W / 2));
  }

  // ── 4b. Sill reveal lines — jamb break lines at sill zone (line2→line3) ───────
  // Black, wall-break weight, marks where solid material meets the opening at parapet level.
  const sillRevealLW = Math.max(lw, 1.5);
  parts.push(`<line x1="${ox.toFixed(1)}" y1="${line2Y.toFixed(1)}" x2="${ox.toFixed(1)}" y2="${line3Y.toFixed(1)}" stroke="#111111" stroke-width="${sillRevealLW}" stroke-linecap="square"/>`);
  parts.push(`<line x1="${(ox + W).toFixed(1)}" y1="${line2Y.toFixed(1)}" x2="${(ox + W).toFixed(1)}" y2="${line3Y.toFixed(1)}" stroke="#111111" stroke-width="${sillRevealLW}" stroke-linecap="square"/>`);
  if (opening === 'double') {
    parts.push(`<line x1="${(ox + W / 2).toFixed(1)}" y1="${line2Y.toFixed(1)}" x2="${(ox + W / 2).toFixed(1)}" y2="${line3Y.toFixed(1)}" stroke="#111111" stroke-width="${(sillRevealLW * 0.7).toFixed(1)}" stroke-linecap="square"/>`);
  }

  // ── 5. Three frame lines ──────────────────────────────────────────────────
  // Line 1 — outer frame (cut section, heavy)
  parts.push(`<line x1="${ox.toFixed(1)}" y1="${line1Y.toFixed(1)}" x2="${(ox + W).toFixed(1)}" y2="${line1Y.toFixed(1)}" stroke="${cfg.frameColor}" stroke-width="${lw}" stroke-linecap="square"/>`);
  // Line 2 — inner frame (cut section, heavy)
  parts.push(`<line x1="${ox.toFixed(1)}" y1="${line2Y.toFixed(1)}" x2="${(ox + W).toFixed(1)}" y2="${line2Y.toFixed(1)}" stroke="${cfg.frameColor}" stroke-width="${lw}" stroke-linecap="square"/>`);
  // Line 3 — sill / parapet (seen zone, lighter)
  const dashL3 = cfg.sillLineDash > 0 ? 'stroke-dasharray="4 3"' : '';
  parts.push(`<line x1="${ox.toFixed(1)}" y1="${line3Y.toFixed(1)}" x2="${(ox + W).toFixed(1)}" y2="${line3Y.toFixed(1)}" stroke="${cfg.sillLineColor}" stroke-width="${lwS}" ${dashL3} stroke-linecap="square"/>`);

  // ── 6. Jamb reveals (line 1 → line 2 at each side) ───────────────────────
  parts.push(`<line x1="${ox.toFixed(1)}" y1="${line1Y.toFixed(1)}" x2="${ox.toFixed(1)}" y2="${line2Y.toFixed(1)}" stroke="${cfg.frameColor}" stroke-width="${(lw * 0.7).toFixed(1)}"/>`);
  parts.push(`<line x1="${(ox + W).toFixed(1)}" y1="${line1Y.toFixed(1)}" x2="${(ox + W).toFixed(1)}" y2="${line2Y.toFixed(1)}" stroke="${cfg.frameColor}" stroke-width="${(lw * 0.7).toFixed(1)}"/>`);

  // ── 7. Casement opening indicator (V-lines from line 2 endpoints → line 3 midpoint) ──
  if (opening === 'single' || opening === 'tilt-turn') {
    const midX = ox + W / 2;
    parts.push(`<line x1="${ox.toFixed(1)}" y1="${line2Y.toFixed(1)}" x2="${midX.toFixed(1)}" y2="${line3Y.toFixed(1)}" stroke="${cfg.frameColor}" stroke-width="${lwS}" stroke-linecap="square"/>`);
    parts.push(`<line x1="${(ox + W).toFixed(1)}" y1="${line2Y.toFixed(1)}" x2="${midX.toFixed(1)}" y2="${line3Y.toFixed(1)}" stroke="${cfg.frameColor}" stroke-width="${lwS}" stroke-linecap="square"/>`);
  } else if (opening === 'double') {
    const midL = ox + W / 4;
    const midR = ox + W * 3 / 4;
    parts.push(`<line x1="${ox.toFixed(1)}" y1="${line2Y.toFixed(1)}" x2="${midL.toFixed(1)}" y2="${line3Y.toFixed(1)}" stroke="${cfg.frameColor}" stroke-width="${lwS}" stroke-linecap="square"/>`);
    parts.push(`<line x1="${(ox + W / 2).toFixed(1)}" y1="${line2Y.toFixed(1)}" x2="${midL.toFixed(1)}" y2="${line3Y.toFixed(1)}" stroke="${cfg.frameColor}" stroke-width="${lwS}" stroke-linecap="square"/>`);
    parts.push(`<line x1="${(ox + W / 2).toFixed(1)}" y1="${line2Y.toFixed(1)}" x2="${midR.toFixed(1)}" y2="${line3Y.toFixed(1)}" stroke="${cfg.frameColor}" stroke-width="${lwS}" stroke-linecap="square"/>`);
    parts.push(`<line x1="${(ox + W).toFixed(1)}" y1="${line2Y.toFixed(1)}" x2="${midR.toFixed(1)}" y2="${line3Y.toFixed(1)}" stroke="${cfg.frameColor}" stroke-width="${lwS}" stroke-linecap="square"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" style="background:#f0f0ec;border-radius:4px;">
  ${parts.join('\n  ')}
</svg>`;
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { WINDOW_TYPES };
export type { WindowType };
