/**
 * ProjectConfigPanel — what the whole project is configured with, in one place.
 *
 * Not tools (those act on the view in front) and not nodes (those are added
 * from the graph's node list): the settings every element of the project draws
 * on — the window and door types, the materials and their look, the item
 * library, the architectural style, the structural system, the 2D symbols.
 * Each card says what it sets and opens its editor.
 */
import type { ReactNode } from 'react';
import { PanelRightClose } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface ConfigCard {
  id: string;
  icon: LucideIcon;
  title: string;
  text: string;
  /** A short state line: "Bucovinean aplicat", "12 materiale"… */
  state?: string;
  action?: { label: string; onClick: () => void; active?: boolean };
  /** A control in place of the button (the structural-system select). */
  control?: ReactNode;
}

export interface ConfigGroup {
  label: string;
  cards: ConfigCard[];
}

export function ProjectConfigPanel({ title, groups, onClose, closeLabel }: {
  title: string; groups: ConfigGroup[]; onClose: () => void; closeLabel: string;
}) {
  return (
    <aside className="bb-config" aria-label={title}>
      <div className="bb-inspector-head">
        <span>{title}</span>
        <button type="button" className="bb-dock-toggle" title={closeLabel} aria-label={closeLabel} onClick={onClose}>
          <PanelRightClose size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="bb-config-body">
        {groups.filter((g) => g.cards.length).map((g) => (
          <section key={g.label} className="bb-config-group">
            <h3>{g.label}</h3>
            {g.cards.map((c) => {
              const Icon = c.icon;
              return (
                <div key={c.id} className="bb-config-card">
                  <div className="bb-config-card-head">
                    <span className="bb-config-icon"><Icon size={16} strokeWidth={1.8} /></span>
                    <div className="bb-config-titles">
                      <strong>{c.title}</strong>
                      {c.state && <span className="bb-config-state">{c.state}</span>}
                    </div>
                  </div>
                  <p>{c.text}</p>
                  {c.control}
                  {c.action && (
                    <button type="button" className={`bb-btn${c.action.active ? ' active' : ''}`} onClick={c.action.onClick}>
                      {c.action.label}
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}

