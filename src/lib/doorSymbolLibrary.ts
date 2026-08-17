/**
 * doorSymbolLibrary.ts — 2D plan symbol configuration for doors.
 *
 * Mirrors the structure of windowSymbolLibrary.ts.
 * Resolution priority:
 *   1. per-type ID override  (e.g. 'D-SWING-90x210')
 *   2. per-swing-type override (e.g. 'swing:double')
 *   3. built-in swing-type defaults
 *   4. DEFAULT_DOOR_PLAN_CONFIG
 */

import { DOOR_TYPES, type DoorType } from './elementLibrary';

// ─── Config interface ─────────────────────────────────────────────────────────

export interface DoorPlan2DConfig {
  // ── Door panel line ───────────────────────────────────────────────────────
  showDoorPanel: boolean;
  panelColor: string;       // hex
  panelLineWeight: number;  // px

  // ── Swing arc ─────────────────────────────────────────────────────────────
  showSwingArc: boolean;
  arcColor: string;
  arcLineWeight: number;

  // ── White mask ────────────────────────────────────────────────────────────
  showWhiteMask: boolean;

  // ── Wall break lines ──────────────────────────────────────────────────────
  showWallBreaks: boolean;
  breakLineColor: string;
  breakLineWeight: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_DOOR_PLAN_CONFIG: DoorPlan2DConfig = {
  showDoorPanel:   true,
  panelColor:      '#111111',
  panelLineWeight: 2,

  showSwingArc:   true,
  arcColor:       '#555555',
  arcLineWeight:  1,

  showWhiteMask:    true,
  showWallBreaks:   true,
  breakLineColor:   '#222222',
  breakLineWeight:  1,
};

// ─── Registry ─────────────────────────────────────────────────────────────────

const _registry = new Map<string, Partial<DoorPlan2DConfig>>();

export function swingKey(swing: string): string {
  return `swing:${swing}`;
}

export function resolveDoorPlan2DConfig(
  typeId: string,
  swing: string,
): DoorPlan2DConfig {
  return {
    ...DEFAULT_DOOR_PLAN_CONFIG,
    ...(_registry.get(swingKey(swing)) ?? {}),
    ...(_registry.get(typeId) ?? {}),
  };
}

export function setDoorPlan2DConfig(
  key: string,
  overrides: Partial<DoorPlan2DConfig>,
): void {
  _registry.set(key, { ...(_registry.get(key) ?? {}), ...overrides });
  _listeners.forEach((fn) => fn());
}

export function resetDoorPlan2DConfig(key: string): void {
  _registry.delete(key);
  _listeners.forEach((fn) => fn());
}

export function getRawDoorOverride(key: string): Partial<DoorPlan2DConfig> | undefined {
  return _registry.get(key);
}

export function exportDoorRegistry(): Record<string, Partial<DoorPlan2DConfig>> {
  return Object.fromEntries(_registry.entries());
}

export function importDoorRegistry(data: Record<string, Partial<DoorPlan2DConfig>>): void {
  _registry.clear();
  for (const [k, v] of Object.entries(data)) _registry.set(k, v);
  _listeners.forEach((fn) => fn());
}

// ─── Pub / sub ────────────────────────────────────────────────────────────────

const _listeners = new Set<() => void>();

export function subscribeDoorSymbolConfig(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ─── SVG preview ──────────────────────────────────────────────────────────────

export function renderDoorPlanSymbolSVG(
  cfg: DoorPlan2DConfig,
  swing: 'left' | 'right' | 'double' | 'sliding' | 'folding',
  wallThick_mm: number,
  doorWidth_mm: number,
  svgW: number,
  svgH: number,
): string {
  const PAD = 18;
  const scale = Math.min((svgW - PAD * 2) / doorWidth_mm, (svgH - PAD * 2) / wallThick_mm);

  const W  = doorWidth_mm * scale;
  const _T  = wallThick_mm * scale;
  const ox = (svgW - W) / 2;
  const oy = svgH / 2;

  const parts: string[] = [];

  // White mask background
  if (cfg.showWhiteMask) {
    parts.push(`<rect x="${ox.toFixed(1)}" y="${(oy - _T / 2).toFixed(1)}" width="${W.toFixed(1)}" height="${_T.toFixed(1)}" fill="#f8f8f4" stroke="none"/>`);
  }

  // Wall break lines
  if (cfg.showWallBreaks) {
    for (const side of [0, 1]) {
      const bx = (ox + side * W).toFixed(1);
      parts.push(`<line x1="${bx}" y1="${(oy - _T / 2).toFixed(1)}" x2="${bx}" y2="${(oy + _T / 2).toFixed(1)}" stroke="${cfg.breakLineColor}" stroke-width="${cfg.breakLineWeight}"/>`);
    }
  }

  // Swing symbols
  if (swing === 'sliding') {
    if (cfg.showDoorPanel) {
      const off = _T * 0.2;
      parts.push(`<line x1="${ox.toFixed(1)}" y1="${(oy + off).toFixed(1)}" x2="${(ox + W).toFixed(1)}" y2="${(oy + off).toFixed(1)}" stroke="${cfg.panelColor}" stroke-width="${cfg.panelLineWeight}" stroke-dasharray="5 3"/>`);
      // Arrow
      const ax1 = ox + W * 0.3, ax2 = ox + W * 0.85;
      parts.push(`<line x1="${ax1.toFixed(1)}" y1="${oy.toFixed(1)}" x2="${ax2.toFixed(1)}" y2="${oy.toFixed(1)}" stroke="${cfg.arcColor}" stroke-width="${cfg.arcLineWeight}" stroke-dasharray="5 3"/>`);
      const aw = W * 0.06;
      parts.push(`<polygon points="${ax2},${oy} ${(ax2 - aw)},${(oy - aw / 2)} ${(ax2 - aw)},${(oy + aw / 2)}" fill="${cfg.arcColor}"/>`);
    }
  } else if (swing === 'double') {
    const hw = W / 2;
    if (cfg.showDoorPanel) {
      // Left leaf
      parts.push(`<line x1="${ox.toFixed(1)}" y1="${oy.toFixed(1)}" x2="${ox.toFixed(1)}" y2="${(oy - hw).toFixed(1)}" stroke="${cfg.panelColor}" stroke-width="${cfg.panelLineWeight}"/>`);
      // Right leaf
      parts.push(`<line x1="${(ox + W).toFixed(1)}" y1="${oy.toFixed(1)}" x2="${(ox + W).toFixed(1)}" y2="${(oy - hw).toFixed(1)}" stroke="${cfg.panelColor}" stroke-width="${cfg.panelLineWeight}"/>`);
    }
    if (cfg.showSwingArc) {
      parts.push(`<path d="M ${ox} ${(oy - hw)} A ${hw} ${hw} 0 0 1 ${(ox + hw)} ${oy}" fill="none" stroke="${cfg.arcColor}" stroke-width="${cfg.arcLineWeight}"/>`);
      parts.push(`<path d="M ${(ox + W)} ${(oy - hw)} A ${hw} ${hw} 0 0 0 ${(ox + hw)} ${oy}" fill="none" stroke="${cfg.arcColor}" stroke-width="${cfg.arcLineWeight}"/>`);
    }
  } else {
    // Single swing (left/right)
    const hingeX = swing === 'right' ? ox + W : ox;
    const tipX   = swing === 'right' ? ox : ox + W;
    if (cfg.showDoorPanel) {
      parts.push(`<line x1="${hingeX.toFixed(1)}" y1="${oy.toFixed(1)}" x2="${hingeX.toFixed(1)}" y2="${(oy - W).toFixed(1)}" stroke="${cfg.panelColor}" stroke-width="${cfg.panelLineWeight}"/>`);
    }
    if (cfg.showSwingArc) {
      const d = swing === 'right' ? 0 : 1;
      parts.push(`<path d="M ${hingeX} ${(oy - W)} A ${W} ${W} 0 0 ${d} ${tipX} ${oy}" fill="none" stroke="${cfg.arcColor}" stroke-width="${cfg.arcLineWeight}"/>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" style="background:#e0e0dc;border-radius:4px;">
  ${parts.join('\n  ')}
</svg>`;
}

export { DOOR_TYPES };
export type { DoorType };
