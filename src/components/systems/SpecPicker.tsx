/**
 * SpecPicker — one select per specification group, derived from the norm
 * library.
 *
 * Nothing here knows what plaster or insulation is: the groups, their options
 * and their labels all come from `_specificatii.md` through
 * `specGroups()`. Adding a kind of screed to the Markdown and recompiling makes
 * it appear here, in the scenario bar and in the sensitivity table without a
 * line of TypeScript — which is the point of putting the vocabulary in the
 * catalogue rather than in the code.
 *
 * The same component serves three scopes: the project's own choices, a
 * scenario's overrides on top of them, and a single element's exception. Only
 * `value` and `inherited` differ.
 */
import { useMemo } from 'react';
import { specGroups, specGroupsFor, type SpecSelection } from '@/lib/norms/specs';

export interface SpecPickerProps {
  /** Explicit choices at this scope. A group absent here inherits. */
  value: SpecSelection;
  onChange: (next: SpecSelection) => void;
  /** What a group falls back to when unset here — the scope one level out. */
  inherited?: SpecSelection;
  /** Only groups that apply to this node type; omit for all of them. */
  nodeType?: string;
  /** Label for the "not chosen here" option. */
  inheritLabel?: string;
  compact?: boolean;
}

const selStyle: React.CSSProperties = {
  background: 'hsl(var(--background))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 4,
  padding: '2px 4px',
  fontSize: 11,
  maxWidth: 220,
};

export function SpecPicker({
  value, onChange, inherited, nodeType, inheritLabel = 'implicit', compact = false,
}: SpecPickerProps) {
  const groups = useMemo(() => (nodeType ? specGroupsFor(nodeType) : specGroups()), [nodeType]);
  if (groups.length === 0) return null;

  const set = (groupId: string, optionId: string) => {
    const next = { ...value };
    if (optionId === '') delete next[groupId];
    else next[groupId] = optionId;
    onChange(next);
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: compact ? '2px 8px' : '4px 10px',
        alignItems: 'center',
        fontSize: 11,
      }}
    >
      {groups.map((g) => {
        const fallback = inherited?.[g.id] ?? g.defaultOption;
        const fallbackLabel = g.options.find((o) => o.id === fallback)?.label ?? fallback;
        const chosen = value[g.id] ?? '';
        return (
          <div key={g.id} style={{ display: 'contents' }}>
            <span style={{ color: 'hsl(var(--muted-foreground))' }} title={g.description}>{g.label}</span>
            <select
              value={chosen}
              onChange={(e) => set(g.id, e.target.value)}
              style={{
                ...selStyle,
                borderColor: chosen ? 'hsl(var(--primary))' : 'hsl(var(--border))',
              }}
              title={g.options.find((o) => o.id === (chosen || fallback))?.description ?? g.description}
            >
              <option value="">{`${inheritLabel}: ${fallbackLabel}`}</option>
              {g.options.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
