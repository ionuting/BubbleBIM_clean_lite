/**
 * SvgHatches — SVG <defs> with reusable hatch pattern fills.
 *
 * Supported patterns (HatchPatternId):
 *   none       → transparent
 *   solid      → flat fill (use fillColor directly)
 *   diagonal   → 45° diagonal lines
 *   crosshatch → 45° + 135° grid
 *   dots       → scattered dots
 *   concrete   → diagonal + aggregate dots
 *   brick      → horizontal courses, staggered joints
 *   stone      → irregular polygons
 *   wave       → wavy horizontal lines
 *   wood       → parallel grain lines + ring curves
 *   insulation → zigzag thermal insulation
 *   earth      → earth/soil fill diagonal + dots
 *   steel      → dense diagonal (steel sections)
 *   glass      → double diagonal lines (glazing)
 *   sand       → random dot field
 */
import type { HatchPatternId } from '@/store';

interface HatchDefsProps {
  /** Base tile size in SVG units. Default 8. */
  tileSize?: number;
  /** Additional rotation applied to all patterns (degrees). Default 0. */
  extraAngle?: number;
  /** Tile size multiplier (spacing). Default 1.0. */
  spacing?: number;
}

export function SvgHatchDefs({ tileSize = 8, extraAngle = 0, spacing = 1.0 }: HatchDefsProps) {
  const t = tileSize * spacing;
  const sw = 0.5;
  const transform = extraAngle !== 0 ? `rotate(${extraAngle})` : undefined;

  return (
    <defs>
      {/* ── diagonal ─────────────────────────────────────── */}
      <pattern id="hatch-diagonal" x="0" y="0" width={t} height={t}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <line x1="0" y1={t} x2={t} y2="0" stroke="currentColor" strokeWidth={sw} />
      </pattern>

      {/* ── crosshatch ───────────────────────────────────── */}
      <pattern id="hatch-crosshatch" x="0" y="0" width={t} height={t}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <line x1="0" y1={t} x2={t} y2="0" stroke="currentColor" strokeWidth={sw} />
        <line x1="0" y1="0" x2={t} y2={t} stroke="currentColor" strokeWidth={sw} />
      </pattern>

      {/* ── dots ─────────────────────────────────────────── */}
      <pattern id="hatch-dots" x="0" y="0" width={t} height={t}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <circle cx={t / 2} cy={t / 2} r={sw * 1.2} fill="currentColor" />
      </pattern>

      {/* ── concrete ─────────────────────────────────────── */}
      <pattern id="hatch-concrete" x="0" y="0" width={t} height={t}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <line x1="0" y1={t} x2={t} y2="0" stroke="currentColor" strokeWidth={sw} />
        <circle cx={t * 0.25} cy={t * 0.75} r={sw * 0.8} fill="currentColor" />
        <circle cx={t * 0.75} cy={t * 0.25} r={sw * 0.6} fill="currentColor" />
      </pattern>

      {/* ── brick ────────────────────────────────────────── */}
      <pattern id="hatch-brick" x="0" y="0" width={t * 2} height={t}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <rect x="0" y={t * 0.5} width={t * 2} height={t * 0.5}
          fill="none" stroke="currentColor" strokeWidth={sw * 0.7} />
        <line x1={t} y1={t * 0.5} x2={t} y2={t} stroke="currentColor" strokeWidth={sw * 0.7} />
        <rect x="0" y="0" width={t * 2} height={t * 0.5}
          fill="none" stroke="currentColor" strokeWidth={sw * 0.7} />
        <line x1="0" y1="0" x2="0" y2={t * 0.5} stroke="currentColor" strokeWidth={sw * 0.7} />
        <line x1={t * 2} y1="0" x2={t * 2} y2={t * 0.5} stroke="currentColor" strokeWidth={sw * 0.7} />
      </pattern>

      {/* ── stone ────────────────────────────────────────── */}
      <pattern id="hatch-stone" x="0" y="0" width={t * 2} height={t * 2}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <polyline points={`0,${t} ${t * 0.6},${t * 0.2} ${t * 2},${t * 0.7}`}
          fill="none" stroke="currentColor" strokeWidth={sw * 0.8} />
        <polyline points={`0,${t * 2} ${t * 0.8},${t * 1.4} ${t * 2},${t * 2}`}
          fill="none" stroke="currentColor" strokeWidth={sw * 0.8} />
        <line x1={t * 0.6} y1={t * 0.2} x2={t * 0.8} y2={t * 1.4}
          stroke="currentColor" strokeWidth={sw * 0.8} />
        <line x1={t * 2} y1={t * 0.7} x2={t * 2} y2={t * 2}
          stroke="currentColor" strokeWidth={sw * 0.8} />
      </pattern>

      {/* ── wave ─────────────────────────────────────────── */}
      <pattern id="hatch-wave" x="0" y="0" width={t * 2} height={t}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <path d={`M0,${t * 0.5} Q${t * 0.5},0 ${t},${t * 0.5} Q${t * 1.5},${t} ${t * 2},${t * 0.5}`}
          fill="none" stroke="currentColor" strokeWidth={sw} />
      </pattern>

      {/* ── wood — grain lines ────────────────────────────── */}
      <pattern id="hatch-wood" x="0" y="0" width={t * 2} height={t * 3}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <line x1="0" y1={t * 0.5}  x2={t * 2} y2={t * 0.5}  stroke="currentColor" strokeWidth={sw * 0.7} />
        <line x1="0" y1={t * 1.2}  x2={t * 2} y2={t * 1.2}  stroke="currentColor" strokeWidth={sw * 0.5} />
        <line x1="0" y1={t * 1.8}  x2={t * 2} y2={t * 1.8}  stroke="currentColor" strokeWidth={sw * 0.7} />
        <line x1="0" y1={t * 2.5}  x2={t * 2} y2={t * 2.5}  stroke="currentColor" strokeWidth={sw * 0.5} />
        {/* grain curve */}
        <path d={`M${t * 0.8},0 Q${t * 1.2},${t * 1.5} ${t * 0.8},${t * 3}`}
          fill="none" stroke="currentColor" strokeWidth={sw * 0.4} opacity="0.5" />
      </pattern>

      {/* ── insulation — zigzag ───────────────────────────── */}
      <pattern id="hatch-insulation" x="0" y="0" width={t * 4} height={t * 1.5}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <path d={`M0,${t * 0.75} L${t},0 L${t * 2},${t * 1.5} L${t * 3},0 L${t * 4},${t * 0.75}`}
          fill="none" stroke="currentColor" strokeWidth={sw} />
      </pattern>

      {/* ── earth — soil fill ─────────────────────────────── */}
      <pattern id="hatch-earth" x="0" y="0" width={t * 2} height={t * 2}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <line x1="0" y1={t * 2} x2={t * 2} y2="0" stroke="currentColor" strokeWidth={sw} />
        <circle cx={t * 0.4}  cy={t * 1.2} r={sw * 0.9} fill="currentColor" />
        <circle cx={t * 1.1}  cy={t * 0.5} r={sw * 0.7} fill="currentColor" />
        <circle cx={t * 1.6}  cy={t * 1.7} r={sw * 0.8} fill="currentColor" />
      </pattern>

      {/* ── steel — dense diagonal (structural steel sections) */}
      <pattern id="hatch-steel" x="0" y="0" width={t * 0.6} height={t * 0.6}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <line x1="0" y1={t * 0.6} x2={t * 0.6} y2="0" stroke="currentColor" strokeWidth={sw * 0.8} />
      </pattern>

      {/* ── glass — double diagonal lines ─────────────────── */}
      <pattern id="hatch-glass" x="0" y="0" width={t * 1.5} height={t * 1.5}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <line x1="0" y1={t * 1.5} x2={t * 1.5} y2="0"
          stroke="currentColor" strokeWidth={sw} />
        <line x1={sw * 2} y1={t * 1.5} x2={t * 1.5} y2={sw * 2}
          stroke="currentColor" strokeWidth={sw * 0.5} opacity="0.6" />
      </pattern>

      {/* ── sand — scattered dots ─────────────────────────── */}
      <pattern id="hatch-sand" x="0" y="0" width={t * 2} height={t * 2}
        patternUnits="userSpaceOnUse" patternTransform={transform}>
        <circle cx={t * 0.3}  cy={t * 0.4}  r={sw * 0.6} fill="currentColor" />
        <circle cx={t * 0.8}  cy={t * 1.2}  r={sw * 0.5} fill="currentColor" />
        <circle cx={t * 1.3}  cy={t * 0.6}  r={sw * 0.7} fill="currentColor" />
        <circle cx={t * 1.7}  cy={t * 1.5}  r={sw * 0.5} fill="currentColor" />
        <circle cx={t * 0.5}  cy={t * 1.8}  r={sw * 0.4} fill="currentColor" />
        <circle cx={t * 1.1}  cy={t * 1.9}  r={sw * 0.6} fill="currentColor" />
      </pattern>
    </defs>
  );
}

/**
 * Return the SVG fill value and optional color CSS for a given hatch pattern.
 */
export function hatchFill(hatch: HatchPatternId, fillColor: string): {
  fill: string;
  patternColor?: string;
} {
  if (!hatch || hatch === 'none') return { fill: 'none' };
  if (hatch === 'solid') return { fill: fillColor };
  return { fill: `url(#hatch-${hatch})`, patternColor: fillColor };
}

/** All available hatch pattern IDs with display labels. */
export const HATCH_PATTERNS: { id: HatchPatternId; label: string }[] = [
  { id: 'none',        label: 'None' },
  { id: 'solid',       label: 'Solid' },
  { id: 'diagonal',    label: 'Diagonal' },
  { id: 'crosshatch',  label: 'Crosshatch' },
  { id: 'dots',        label: 'Dots' },
  { id: 'concrete',    label: 'Concrete' },
  { id: 'brick',       label: 'Brick' },
  { id: 'stone',       label: 'Stone' },
  { id: 'wave',        label: 'Wave' },
  { id: 'wood',        label: 'Wood' },
  { id: 'insulation',  label: 'Insulation' },
  { id: 'earth',       label: 'Earth' },
  { id: 'steel',       label: 'Steel' },
  { id: 'glass',       label: 'Glass' },
  { id: 'sand',        label: 'Sand' },
];
