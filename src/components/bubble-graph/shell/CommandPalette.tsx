/**
 * CommandPalette — every action of the shell, one search away (Ctrl K).
 *
 * The menus and the ribbon are for finding things; this is for doing them
 * once you know the name. Type a few letters (diacritics optional), arrows to
 * move, Enter to run, Esc to leave. Commands come from the shell as a list, so
 * what an edition lacks is simply not listed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';

export interface ShellCommand {
  id: string;
  label: string;
  group: string;
  keys?: string;
  run: () => void;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Every query word must start a word of the label (or of its group). */
export function matchCommand(c: ShellCommand, q: string): number {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const hay = fold(`${c.label} ${c.group}`);
  const parts = hay.split(/[^a-z0-9]+/);
  let score = 0;
  for (const w of words) {
    if (parts.some((p) => p.startsWith(w))) score += 2;
    else if (hay.includes(w)) score += 1;
    else return 0;
  }
  return score + (fold(c.label).startsWith(words[0]) ? 2 : 0);
}

export function CommandPalette({ commands, lang, onClose }: { commands: ShellCommand[]; lang: 'ro' | 'en'; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => commands
    .map((c, i) => ({ c, s: matchCommand(c, q), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c), [commands, q]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    document.getElementById(`bb-cmd-${sel}`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (c: ShellCommand | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div className="bb-palette-backdrop" onPointerDown={onClose}>
      <div className="bb-palette" role="dialog" aria-label={lang === 'ro' ? 'Comenzi' : 'Commands'} onPointerDown={(e) => e.stopPropagation()}>
        <label className="bb-palette-search">
          <Search size={16} strokeWidth={1.9} aria-hidden="true" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={lang === 'ro' ? 'Ce vrei să faci? — perete, plan, salvează, teren…' : 'What do you want to do? — wall, plan, save, terrain…'}
            aria-label={lang === 'ro' ? 'Caută o comandă' : 'Search a command'}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(list.length - 1, s + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(list[sel]); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
          />
          <kbd className="bb-kbd">Esc</kbd>
        </label>
        <div className="bb-palette-list" role="listbox">
          {list.length === 0 && <div className="bb-palette-empty">{lang === 'ro' ? 'Nicio comandă cu acest nume.' : 'No command by that name.'}</div>}
          {list.map((c, i) => (
            <button
              key={c.id}
              id={`bb-cmd-${i}`}
              type="button"
              role="option"
              aria-selected={i === sel}
              className={`bb-palette-item${i === sel ? ' active' : ''}`}
              onPointerEnter={() => setSel(i)}
              onClick={() => run(c)}
            >
              <span className="bb-palette-group">{c.group}</span>
              <span className="bb-palette-label">{c.label}</span>
              {c.keys && <kbd className="bb-kbd">{c.keys}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
