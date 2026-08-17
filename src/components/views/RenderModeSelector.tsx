/**
 * RenderModeSelector — toggle between Colored / Technical / Wireframe render modes.
 *
 * Small floating pill that sits next to the VisibilityFilter in 2D viewers.
 */
import { cn } from '@/lib/utils';

export type RenderMode = 'colored' | 'technical' | 'wireframe';

const MODES: { id: RenderMode; label: string; icon: string }[] = [
  { id: 'colored',   label: 'Colored',   icon: '🎨' },
  { id: 'technical', label: 'Technical',  icon: '📐' },
  { id: 'wireframe', label: 'Wireframe', icon: '🔲' },
];

export interface RenderModeSelectorProps {
  mode: RenderMode;
  onChange: (m: RenderMode) => void;
  className?: string;
}

export function RenderModeSelector({ mode, onChange, className }: RenderModeSelectorProps) {
  return (
    <div className={cn('absolute top-2 left-2 z-10 flex gap-0.5 bg-white/90 rounded shadow-sm border border-gray-200 p-0.5', className)}>
      {MODES.map(({ id, label, icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          title={label}
          className={cn(
            'px-2 py-1 text-xs rounded transition-colors',
            mode === id
              ? 'bg-blue-600 text-white font-semibold'
              : 'text-gray-600 hover:bg-gray-100',
          )}
        >
          {icon} {label}
        </button>
      ))}
    </div>
  );
}
