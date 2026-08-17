/**
 * annotationDrawingSettings.ts
 *
 * User-configurable settings for the 2D SVG annotation / drawing tools.
 * All values are stored in localStorage and shared across all floor-plan,
 * section and elevation 2D viewers.
 */

import type { HatchPatternId } from '@/store';

const STORAGE_KEY = 'bg_annotation_drawing_settings_v2';

// ─── Settings interface ───────────────────────────────────────────────────────

export interface AnnotationDrawingSettings {
  /** Colour for dimension lines and leaders (hex). Default #1565c0. */
  dimColor: string;
  /** Colour for text annotations (hex). Default #1a1a2e. */
  textColor: string;
  /** Colour for free-draw elements — lines, arcs, polylines, hatches (hex). Default #374151. */
  drawColor: string;
  /** Fill colour for closed shapes — rect, circle, closed polyline. Default #ffffff. */
  fillColor: string;
  /** Fill opacity for closed shapes. 0 = transparent. Default 0. */
  fillOpacity: number;
  /**
   * Base font size in SVG coordinate units (FloorPlan2DViewer SVG space).
   * 180 ≈ 180 mm → 14.4 px at SCALE=0.08. Range: 60–600.
   */
  fontSizeSvg: number;
  /** Bold text. Default false. */
  fontBold: boolean;
  /**
   * Base stroke width in SVG coordinate units.
   * 10 ≈ 10 mm. Range: 2–60.
   */
  strokeSvg: number;
  /** Stroke dash style for free-draw lines. Default 'solid'. */
  strokeStyle: 'solid' | 'dashed' | 'dotted';
  /** Active hatch pattern for the hatch tool. Default 'diagonal'. */
  hatchPattern: HatchPatternId;
  /** Tile size multiplier for hatch patterns (0.5 = denser, 2.0 = sparser). Default 1.0. */
  hatchSpacing: number;
  /** Additional rotation in degrees applied to hatch tiles. Default 0. */
  hatchAngle: number;
  /** Opacity for hatch fills. Default 0.4. */
  hatchOpacity: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_ANNOTATION_SETTINGS: AnnotationDrawingSettings = {
  dimColor:     '#1565c0',
  textColor:    '#1a1a2e',
  drawColor:    '#374151',
  fillColor:    '#ffffff',
  fillOpacity:  0,
  fontSizeSvg:  180,
  fontBold:     false,
  strokeSvg:    10,
  strokeStyle:  'solid',
  hatchPattern: 'diagonal',
  hatchSpacing: 1.0,
  hatchAngle:   0,
  hatchOpacity: 0.4,
};

// ─── In-memory state ──────────────────────────────────────────────────────────

let _current: AnnotationDrawingSettings = { ...DEFAULT_ANNOTATION_SETTINGS };
const _listeners = new Set<() => void>();

// ─── Persistence ──────────────────────────────────────────────────────────────

function load(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) _current = { ...DEFAULT_ANNOTATION_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_current));
  } catch { /* ignore */ }
}

load();

// ─── Public API ───────────────────────────────────────────────────────────────

export function getAnnotationSettings(): AnnotationDrawingSettings {
  return _current;
}

export function setAnnotationSettings(overrides: Partial<AnnotationDrawingSettings>): void {
  _current = { ..._current, ...overrides };
  save();
  _listeners.forEach((fn) => fn());
}

export function resetAnnotationSettings(): void {
  _current = { ...DEFAULT_ANNOTATION_SETTINGS };
  save();
  _listeners.forEach((fn) => fn());
}

export function subscribeAnnotationSettings(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
