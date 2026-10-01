/**
 * HudBar — the one top bar every edition shows.
 *
 *   [brand · project ▾ · save state]          [Command ⌘K · undo · redo · Setup · Panels ▾ · theme · account]
 *
 * The project menu holds everything about the file (new, open, save, projects,
 * history, exports and imports); the panels menu every drawer (library, costs,
 * chat…). Views are reached from the navigator, the graph first — keys 1–5
 * switch between them; there is no second set of view buttons up here.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown, Command, LayoutPanelLeft, Moon, Redo2, Settings2, Sun, Undo2, House,
} from 'lucide-react';

export interface MenuItem {
  label: string;
  onClick?: () => void;
  /** A keyboard hint shown on the right. */
  keys?: string;
  /** Shown highlighted (a drawer that is open). */
  active?: boolean;
  /** A heading row instead of an action. */
  heading?: boolean;
  /** Arbitrary content in place of a button (a select). */
  node?: ReactNode;
}

export function HudMenu({ label, icon, items, align = 'left', className }: {
  label: ReactNode; icon?: ReactNode; items: MenuItem[]; align?: 'left' | 'right'; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="bb-menu" ref={ref}>
      <button type="button" className={`bb-btn ${className ?? ''}${open ? ' active' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {icon}{label}<ChevronDown className="bb-ico" strokeWidth={1.75} />
      </button>
      {open && (
        <div className={`bb-menu-pop ${align}`} role="menu">
          {items.map((it, i) => (it.heading
            ? <div key={i} className="bb-menu-heading">{it.label}</div>
            : it.node
              ? <div key={i} className="bb-menu-node">{it.node}</div>
              : (
                <button key={i} type="button" role="menuitem" className={`bb-menu-item${it.active ? ' active' : ''}`}
                  onClick={() => { setOpen(false); it.onClick?.(); }}>
                  <span>{it.label}</span>
                  {it.keys && <kbd className="bb-kbd">{it.keys}</kbd>}
                </button>
              )))}
        </div>
      )}
    </div>
  );
}

/** A HUD button that opens a panel of its own content (the simulations group). */
export function HudPopover({ label, icon, children, className, ariaLabel, onOpenChange, title, align = 'right' }: {
  label: ReactNode; icon?: ReactNode; children: ReactNode; className?: string; ariaLabel: string;
  /** Told when the panel opens or closes — to load what it shows. */
  onOpenChange?: (open: boolean) => void;
  title?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (v: boolean | ((o: boolean) => boolean)) => setOpenState((o) => {
    const next = typeof v === 'function' ? v(o) : v;
    if (next !== o) queueMicrotask(() => onOpenChange?.(next));
    return next;
  });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="bb-menu" ref={ref}>
      <button type="button" className={`bb-btn ${className ?? ''}${open ? ' active' : ''}`} aria-haspopup="dialog" aria-expanded={open} title={title} onClick={() => setOpen((o) => !o)}>
        {icon}{label}<ChevronDown className="bb-ico" strokeWidth={1.75} />
      </button>
      {open && <div className={`bb-menu-pop ${align} bb-popover`} role="dialog" aria-label={ariaLabel}>{children}</div>}
    </div>
  );
}

export interface HudBarProps {
  lang: 'ro' | 'en';
  projectName: string;
  saving: boolean;
  saveError: string | null;
  lastSaved: Date | null;
  projectMenu: MenuItem[];
  panelsMenu: MenuItem[];
  onCommand: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Opens the project setup panel (windows, doors, materials, style…). */
  onConfig: () => void;
  configActive?: boolean;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  account?: ReactNode;
  /** The simulations group (scenarios, costs, structure) — editions that have it. */
  simulations?: ReactNode;
  /** Versions: save one, see the last ones, restore — next to the save state. */
  versions?: ReactNode;
}

export function HudBar(p: HudBarProps) {
  const ro = p.lang === 'ro';
  const status = p.saving
    ? { cls: 'busy', text: ro ? 'se salvează…' : 'saving…' }
    : p.saveError
      ? { cls: 'warn', text: ro ? 'salvarea a eșuat' : 'save failed' }
      : p.lastSaved
        ? { cls: 'ok', text: `${ro ? 'salvat' : 'saved'} ${p.lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }
        : { cls: '', text: ro ? 'nesalvat' : 'not saved' };
  return (
    <header className="bb-header bb-hud">
      <div className="bb-hud-left">
        <span className="bb-brand-mark" aria-hidden="true"><House size={15} strokeWidth={2.4} /></span>
        <HudMenu
          className="ghost bb-hud-project"
          label={<span className="bb-hud-project-name" title={p.projectName}>{p.projectName}</span>}
          items={p.projectMenu}
        />
        <span className={`bb-hud-save ${status.cls}`} title={p.saveError ?? undefined}>
          <span className="dot" />{status.text}
        </span>
        {p.versions}
      </div>


      <div className="bb-hud-right">
        <button type="button" className="bb-btn bb-hud-cmd" onClick={p.onCommand} title={ro ? 'Caută orice comandă' : 'Search any command'}>
          <Command className="bb-ico" strokeWidth={1.75} />
          <span>{ro ? 'Comandă' : 'Command'}</span>
          <kbd className="bb-kbd">Ctrl K</kbd>
        </button>
        <button type="button" className="bb-btn ghost" onClick={p.undo} disabled={!p.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)">
          <Undo2 className="bb-ico" strokeWidth={1.75} />
        </button>
        <button type="button" className="bb-btn ghost" onClick={p.redo} disabled={!p.canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
          <Redo2 className="bb-ico" strokeWidth={1.75} />
        </button>
        <button type="button" className={`bb-btn primary${p.configActive ? ' pressed' : ''}`} onClick={p.onConfig}
          aria-pressed={!!p.configActive}
          title={ro ? 'Configurarea proiectului: ferestre, uși, materiale, stil, sistem structural' : 'Project setup: windows, doors, materials, style, structural system'}>
          <Settings2 className="bb-ico" strokeWidth={2} />
          {ro ? 'Configurare' : 'Setup'}
        </button>
        {p.simulations}
        <HudMenu
          align="right"
          icon={<LayoutPanelLeft className="bb-ico" strokeWidth={1.75} />}
          label={<span>{ro ? 'Panouri' : 'Panels'}</span>}
          items={p.panelsMenu}
        />
        <button type="button" className="bb-btn ghost" onClick={p.onToggleTheme}
          aria-label={p.theme === 'dark' ? (ro ? 'Temă luminoasă' : 'Light theme') : (ro ? 'Temă întunecată' : 'Dark theme')}>
          {p.theme === 'dark' ? <Sun className="bb-ico" strokeWidth={1.75} /> : <Moon className="bb-ico" strokeWidth={1.75} />}
        </button>
        {p.account}
      </div>
    </header>
  );
}
