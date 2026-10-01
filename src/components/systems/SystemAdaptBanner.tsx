/**
 * SystemAdaptBanner — "your model does not yet match its structural system".
 *
 * Shown whenever `adaptGraphToSystem` would change something: after the
 * project system is switched, and again if a foreign-technology wall is
 * drawn later. One click applies the whole adaptation as ONE undo step;
 * dismissing hides it until the system changes again. Nothing is applied
 * silently — retyping walls and adding columns is the user's decision.
 */
import { STRUCTURAL_SYSTEM_LABELS, type StructuralSystem } from '@/lib/systems/structuralSystem';
import type { AdaptSummary } from '@/lib/systems/profiles';

export interface SystemAdaptBannerProps {
  system: StructuralSystem;
  summary: AdaptSummary;
  onApply: () => void;
  onDismiss: () => void;
}

export function describeAdapt(s: AdaptSummary): string {
  const parts: string[] = [];
  if (s.wallsRetyped) parts.push(`${s.wallsRetyped} ${s.wallsRetyped === 1 ? 'perete retipat' : 'pereți retipați'}`);
  if (s.slabsRetyped) parts.push(`${s.slabsRetyped} ${s.slabsRetyped === 1 ? 'planșeu retipat' : 'planșee retipate'}`);
  if (s.columnsAdded) parts.push(`+${s.columnsAdded} stâlpi`);
  if (s.columnsRemoved) parts.push(`−${s.columnsRemoved} stâlpi`);
  if (s.beamsAdded) parts.push(`+${s.beamsAdded} grinzi`);
  if (s.beamsRemoved) parts.push(`−${s.beamsRemoved} grinzi`);
  return parts.join(' · ');
}

export function SystemAdaptBanner({ system, summary, onApply, onDismiss }: SystemAdaptBannerProps) {
  return (
    <div
      role="status"
      data-testid="system-adapt-banner"
      style={{
        position: 'absolute', top: 44, left: '50%', transform: 'translateX(-50%)', zIndex: 12,
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
        background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8,
        boxShadow: '0 4px 14px rgba(0,0,0,0.12)', fontSize: 11, maxWidth: 'calc(100% - 260px)',
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span style={{ fontWeight: 600 }}>{STRUCTURAL_SYSTEM_LABELS[system]}</span>
      <span style={{ color: 'hsl(var(--muted-foreground))' }}>{describeAdapt(summary)}</span>
      <button
        type="button"
        onClick={onApply}
        title="Retipează pereții și planșeele străine de tehnologie și adaugă/scoate stâlpii și grinzile — un singur pas de undo"
        style={{ padding: '2px 8px', borderRadius: 5, border: 'none', background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', fontSize: 11, cursor: 'pointer' }}
      >
        Adaptează modelul
      </button>
      <button
        type="button"
        onClick={onDismiss}
        title="Lasă modelul cum e"
        style={{ padding: '2px 6px', borderRadius: 5, border: '1px solid hsl(var(--border))', background: 'transparent', fontSize: 11, cursor: 'pointer' }}
      >
        Ignoră
      </button>
    </div>
  );
}
