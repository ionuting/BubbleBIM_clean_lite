/**
 * ProjectBrowser — the left rail as Revit's Project Browser: one tree.
 *
 *   Graf (the root: every view below is drawn from it)
 *     Toate nivelurile · Parter · Etaj …
 *   Vederi
 *     Planuri de nivel · Planuri de structură · Vederi 3D · Fațade · Secțiuni · Sit
 *   Tabele și cantități
 *   Planșe
 *   Familii — the types the model uses, by category, with how many
 *   Analiză structurală · Laborator   (editions that have them)
 *
 * Folders open and close and remember it; a search box filters the leaves and
 * keeps their folders. A leaf opens its view on click; its tools show on hover.
 * The tree is data (`TreeItem`): the shell builds it from the graph, this only
 * draws it.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, PanelLeftClose, Search, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface TreeAction {
  label: string;
  glyph: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

export interface TreeItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** A number on the right (count of children, of elements). */
  badge?: number | string;
  active?: boolean;
  /** A muted line under the label, or a hint on hover. */
  hint?: string;
  /** Clicking the row: open the view, select the elements… */
  onOpen?: () => void;
  onDoubleClick?: () => void;
  /** A "create" row (+ Planșă nouă) — drawn as an action, not a thing. */
  create?: boolean;
  actions?: TreeAction[];
  children?: TreeItem[];
  /** Arbitrary content shown when the folder is open (the quantities table). */
  content?: ReactNode;
  defaultOpen?: boolean;
  /** Emphasised — the graph, the model's root. */
  root?: boolean;
  kbd?: string;
  /** A name the user may change: ✎, double-click or F2 edits it in place. */
  onRename?: (name: string) => void;
  /** A short tag after the label ("OG"). */
  tag?: string;
}

const STORE_KEY = 'bb_browser_open';

function loadOpen(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}'); } catch { return {}; }
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The tree with only the leaves matching `q`, and the folders that hold them. */
function filterTree(items: TreeItem[], q: string): TreeItem[] {
  if (!q) return items;
  const out: TreeItem[] = [];
  for (const it of items) {
    const self = fold(it.label).includes(q);
    const kids = it.children ? filterTree(it.children, q) : [];
    if (self && !it.create) out.push(it);
    else if (kids.length) out.push({ ...it, children: kids, content: undefined });
  }
  return out;
}

interface RowCtx {
  open: Record<string, boolean>;
  toggle: (id: string, def: boolean) => void;
  searching: boolean;
  editing: string | null;
  setEditing: (id: string | null) => void;
}

function Row({ item, depth, ctx }: { item: TreeItem; depth: number; ctx: RowCtx }) {
  const { open, toggle, searching } = ctx;
  const isEditing = ctx.editing === item.id;
  const folder = !!(item.children?.length || item.content);
  const isOpen = searching ? true : (open[item.id] ?? item.defaultOpen ?? false);
  const Icon = item.icon;
  const click = () => {
    if (item.onOpen) item.onOpen();
    else if (folder) toggle(item.id, item.defaultOpen ?? false);
  };
  return (
    <li role="treeitem" aria-expanded={folder ? isOpen : undefined} aria-selected={item.active ? true : undefined}>
      <div
        className={`bb-tree-row${item.active ? ' active' : ''}${item.create ? ' create' : ''}${item.root ? ' root' : ''}${folder && !item.onOpen ? ' folder' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        title={item.hint}
      >
        {folder ? (
          <button
            type="button"
            className={`bb-tree-twisty${isOpen ? ' open' : ''}`}
            aria-label={isOpen ? 'Restrânge' : 'Extinde'}
            onClick={(e) => { e.stopPropagation(); toggle(item.id, item.defaultOpen ?? false); }}
          >
            <ChevronRight size={12} strokeWidth={2.2} />
          </button>
        ) : <span className="bb-tree-twisty-space" />}
        {isEditing && item.onRename ? (
          <span className="bb-tree-label editing">
            {Icon && <Icon className="bb-tree-icon" size={14} strokeWidth={1.8} />}
            <input
              className="bb-tree-input"
              defaultValue={item.label}
              autoFocus
              aria-label="Nume nou"
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { const v = e.currentTarget.value.trim(); if (v && v !== item.label) item.onRename?.(v); ctx.setEditing(null); }
                else if (e.key === 'Escape') ctx.setEditing(null);
              }}
              onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== item.label) item.onRename?.(v); ctx.setEditing(null); }}
            />
          </span>
        ) : (
          <button
            type="button"
            className="bb-tree-label"
            onClick={click}
            onDoubleClick={item.onDoubleClick ?? (item.onRename ? () => ctx.setEditing(item.id) : undefined)}
            onKeyDown={(e) => { if (e.key === 'F2' && item.onRename) { e.preventDefault(); ctx.setEditing(item.id); } }}
          >
            {Icon && <Icon className="bb-tree-icon" size={14} strokeWidth={1.8} />}
            <span className="bb-tree-text">{item.label}</span>
            {item.tag && <span className="bb-tree-tag">{item.tag}</span>}
          </button>
        )}
        {item.kbd && <kbd className="bb-kbd">{item.kbd}</kbd>}
        {item.badge !== undefined && item.badge !== 0 && <span className="bb-tree-badge">{item.badge}</span>}
        {(item.actions?.length || item.onRename) && !isEditing ? (
          <span className="bb-tree-actions">
            {item.onRename && (
              <button type="button" title="Redenumește (F2)" aria-label="Redenumește" onClick={(e) => { e.stopPropagation(); ctx.setEditing(item.id); }}>✎</button>
            )}
            {(item.actions ?? []).map((a) => (
              <button key={a.label} type="button" title={a.label} aria-label={a.label}
                className={a.danger ? 'danger' : undefined}
                onClick={(e) => { e.stopPropagation(); a.onClick(); }}>
                {a.glyph}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {folder && isOpen && (
        <>
          {item.content && <div className="bb-tree-content" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>{item.content}</div>}
          {item.children?.length ? (
            <ul role="group">
              {item.children.map((c) => (
                <Row key={c.id} item={c} depth={depth + 1} ctx={ctx} />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </li>
  );
}

export function ProjectBrowser({ title, projectName, items, onCollapse, lang }: {
  title: string; projectName: string; items: TreeItem[]; onCollapse?: () => void; lang: 'ro' | 'en';
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(open)); } catch { /* per-viewer convenience only */ }
  }, [open]);
  const toggle = (id: string, def: boolean) => setOpen((o) => ({ ...o, [id]: !(o[id] ?? def) }));
  const query = fold(q.trim());
  const shown = useMemo(() => filterTree(items, query), [items, query]);
  const ro = lang === 'ro';

  return (
    <>
      <div className="bb-nav-head bb-browser-head">
        <span className="bb-browser-title">
          <span>{title}</span>
          <strong title={projectName}>{projectName}</strong>
        </span>
        {onCollapse && (
          <button type="button" className="bb-dock-toggle" title={ro ? 'Ascunde browserul' : 'Hide browser'}
            aria-label={ro ? 'Ascunde browserul' : 'Hide browser'} onClick={onCollapse}>
            <PanelLeftClose size={14} strokeWidth={1.75} />
          </button>
        )}
      </div>
      <label className="bb-browser-search">
        <Search size={13} strokeWidth={2} aria-hidden="true" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={ro ? 'Caută în proiect' : 'Search the project'}
          aria-label={ro ? 'Caută în proiect' : 'Search the project'} />
        {q && (
          <button type="button" aria-label={ro ? 'Golește căutarea' : 'Clear search'} onClick={() => setQ('')}>
            <X size={12} strokeWidth={2} />
          </button>
        )}
      </label>
      <div className="bb-nav-scroll">
        <ul className="bb-tree" role="tree" aria-label={title}>
          {shown.map((it) => <Row key={it.id} item={it} depth={0} ctx={{ open, toggle, searching: !!query, editing, setEditing }} />)}
        </ul>
        {query && !shown.length && <div className="bb-empty-hint">{ro ? 'Nimic cu acest nume.' : 'Nothing by that name.'}</div>}
      </div>
    </>
  );
}
