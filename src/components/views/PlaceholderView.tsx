/**
 * PlaceholderView — shown for view types not yet fully implemented
 * (section, elevation, table, sheet).
 */

import { cn } from '@/lib/utils';
import type { ViewTabType } from '@/store';

const ICONS: Record<ViewTabType, string>       = {
  'graph-editor':      '⬡',
  '3d-model':          '🎲',
  'opengeo-3d':        '⬡',
  'opengeo-floorplan': '⬡',
  'opengeo-section':   '⬡',
  'opengeo-elevation': '⬡',
  'floorplan':         '📐',
  'section':           '✂',
  'elevation':         '↑',
  'table':             '📊',
  'sheet':             '📄',
  'fem':               '🏗',
};

const DESCRIPTIONS: Partial<Record<ViewTabType, string>> = {
  'section':   'Section views will display 2D vertical cross-sections from the graph database.',
  'elevation': 'Elevation views will display 2D facade views from the graph database.',
  'table':     'Table views will display structured element data from the graph database.',
  'sheet':     'Sheet views will display composed drawing sheets with multiple viewports.',
};

interface PlaceholderViewProps {
  type: ViewTabType;
  label: string;
  className?: string;
}

export function PlaceholderView({ type, label, className }: PlaceholderViewProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center w-full h-full gap-4 text-muted-foreground',
        className,
      )}
    >
      <div className="text-6xl opacity-20">{ICONS[type]}</div>
      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-foreground/60">{label}</p>
        <p className="text-xs max-w-xs text-center opacity-60">
          {DESCRIPTIONS[type] ?? 'This view type is coming soon.'}
        </p>
      </div>
      <div className="text-[10px] uppercase tracking-widest opacity-30 border border-border/40 px-3 py-1 rounded-full">
        Coming soon
      </div>
    </div>
  );
}
