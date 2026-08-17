/**
 * AnnotationsToolbar — shared toolbar for ThatOpen DrawingEditor annotation tools.
 * Used by SectionOrthoViewer, ElevationOrthoViewer, WebIfcViewer (OBC worlds)
 * and TechnicalDrawingsViewer (SVG, subset: linear + callout).
 */
import React from 'react';
import { cn } from '@/lib/utils';

export type AnnotationTool = 'linear' | 'angle' | 'callout' | 'leader' | 'slope';

interface ToolDef { id: AnnotationTool; label: string; title: string }

const ALL_TOOLS: ToolDef[] = [
  { id: 'linear',  label: '─ Linear',  title: 'Linear dimension — click two points then set offset' },
  { id: 'angle',   label: '∠ Angle',   title: 'Angle dimension' },
  { id: 'callout', label: '◉ Callout', title: 'Text callout with leader' },
  { id: 'leader',  label: '↗ Leader',  title: 'Leader line' },
  { id: 'slope',   label: '/ Slope',   title: 'Slope annotation' },
];

export interface AnnotationsToolbarProps {
  activeTool: AnnotationTool | null;
  onToolChange: (tool: AnnotationTool | null) => void;
  onClearAll: () => void;
  /** If provided, only these tools are rendered. Default: all tools. */
  availableTools?: AnnotationTool[];
  className?: string;
}

export function AnnotationsToolbar({
  activeTool,
  onToolChange,
  onClearAll,
  availableTools,
  className,
}: AnnotationsToolbarProps) {
  const tools = availableTools
    ? ALL_TOOLS.filter((t) => availableTools.includes(t.id))
    : ALL_TOOLS;

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 bg-white/95 dark:bg-zinc-900/95',
        'border border-gray-200 dark:border-zinc-700 rounded shadow-sm px-1 py-0.5',
        className,
      )}
    >
      {tools.map(({ id, label, title }) => (
        <button
          key={id}
          title={title}
          onClick={() => onToolChange(activeTool === id ? null : id)}
          className={cn(
            'px-2 py-0.5 text-xs rounded transition-colors select-none whitespace-nowrap',
            activeTool === id
              ? 'bg-blue-600 text-white'
              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-700',
          )}
        >
          {label}
        </button>
      ))}
      <div className="w-px h-4 bg-gray-200 dark:bg-zinc-600 mx-0.5" />
      <button
        title="Clear all annotations"
        onClick={onClearAll}
        className="px-2 py-0.5 text-xs rounded text-gray-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 transition-colors select-none whitespace-nowrap"
      >
        🗑 Clear
      </button>
    </div>
  );
}
