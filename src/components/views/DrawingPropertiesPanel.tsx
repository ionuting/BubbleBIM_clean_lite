/**
 * DrawingPropertiesPanel — floating properties panel for 2D SVG drawing tools.
 *
 * The labelled tool palette. Appearance lives in `StylePanel`, which can
 * restyle what is already drawn as well as what comes next.
 */
import { cn } from '@/lib/utils';
import type { SvgAnnotationTool } from './SvgAnnotationLayer';

// ─── Tool definitions ─────────────────────────────────────────────────────────

interface ToolDef {
  tool: SvgAnnotationTool;
  icon: string;
  label: string;
}

const TOOLS: ToolDef[] = [
  { tool: 'select',    icon: '↖',  label: 'Select / move' },
  { tool: 'text',      icon: 'T',  label: 'Text label' },
  { tool: 'dimension', icon: '↔',  label: 'Dimension' },
  { tool: 'leader',    icon: '↗',  label: 'Leader' },
  { tool: 'line',      icon: '╱',  label: 'Line' },
  { tool: 'arc',       icon: '⌒',  label: 'Arc' },
  { tool: 'polyline',  icon: '╮',  label: 'Polyline' },
  { tool: 'rect',      icon: '▭',  label: 'Rectangle' },
  { tool: 'circle',    icon: '○',  label: 'Circle' },
  { tool: 'hatch',     icon: '▦',  label: 'Hatch fill' },
  { tool: 'join',      icon: '⋈',  label: 'Join lines' },
  { tool: 'trim',      icon: '✂',  label: 'Trim' },
  { tool: 'eraser',    icon: '✕',  label: 'Eraser' },
];

// ─── Props ────────────────────────────────────────────────────────────────────

interface DrawingPropertiesPanelProps {
  activeTool: SvgAnnotationTool | null;
  onToolChange: (tool: SvgAnnotationTool | null) => void;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DrawingPropertiesPanel({
  activeTool,
  onToolChange,
  onClose,
}: DrawingPropertiesPanelProps) {
  return (
    <div className="flex flex-col gap-2 text-xs bg-background border border-border/70 rounded-lg shadow-xl p-3 w-[220px] select-none">

      {/* Header */}
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-semibold text-foreground text-[11px]">Drawing</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground leading-none">✕</button>
      </div>

      {/* ── Tool grid ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-1">
        {TOOLS.map(({ tool, icon, label }) => (
          <button
            key={tool}
            title={label}
            onClick={() => onToolChange(activeTool === tool ? null : tool)}
            className={cn(
              'h-8 flex flex-col items-center justify-center rounded text-[10px] gap-0.5 transition-colors border',
              activeTool === tool
                ? 'bg-blue-600 text-white border-blue-700'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground border-border/40',
            )}
          >
            <span className="text-sm leading-none">{icon}</span>
            <span className="leading-none truncate w-full text-center">{label.split(' ')[0]}</span>
          </button>
        ))}
      </div>

      <div className="border-t border-border/40" />

      {/* Appearance moved out. It used to live here as a set of globals that
          only affected the NEXT annotation; it is now a named style that can
          be edited after the fact and restyles everything following it. Two
          panels offering the same fields, one of them unable to change
          anything already drawn, is worse than a pointer. */}
      <p className="text-[10px] text-muted-foreground leading-snug">
        Grosimi, culori, capete de cotă, text și hașuri se setează din
        <span className="text-foreground"> Stil</span> (butonul ↔ din bara de sus) —
        acolo se pot schimba și după ce ai desenat.
      </p>

    </div>
  );
}

