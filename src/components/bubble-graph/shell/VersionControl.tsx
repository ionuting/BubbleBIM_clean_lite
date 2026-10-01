/**
 * VersionControl — the project's versions, from the HUD, next to the save state.
 *
 * The button names the latest version and how old it is ("v12 · acum 3 min").
 * Its panel does the three things a person does with versions all day:
 * save one under a name (Ctrl+Shift+S), look at the last few, put one back.
 * Everything else — diffs, comments, amending, clean-up — stays in the full
 * history panel, one click further. Same store as that panel
 * (backend/version_history.py, per project): restoring never rewrites
 * history, it adds a "restored" version on top.
 */
import { useCallback, useEffect, useState } from 'react';
import { Bookmark, Clock3, GitCommitHorizontal, History, RotateCcw, Save, Upload } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { commitHistory, listHistory, restoreHistoryCommit, type GraphData, type HistoryCommit, type HistoryCommitKind } from '@/lib/api';
import { HudPopover } from './HudBar';

const KIND: Record<HistoryCommitKind, { icon: LucideIcon; ro: string; en: string }> = {
  checkpoint: { icon: Bookmark, ro: 'Versiune', en: 'Version' },
  manual: { icon: Save, ro: 'Salvare', en: 'Save' },
  auto: { icon: Clock3, ro: 'Automată', en: 'Auto-save' },
  restore: { icon: RotateCcw, ro: 'Restaurată', en: 'Restored' },
  'pre-ifc-import': { icon: Upload, ro: 'Înainte de import IFC', en: 'Before IFC import' },
};

function ago(iso: string, ro: boolean): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return ro ? 'acum' : 'just now';
  if (m < 60) return ro ? `acum ${m} min` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return ro ? `acum ${h} h` : `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? (ro ? `acum ${d} z` : `${d} d ago`) : new Date(iso).toLocaleDateString();
}

export function VersionControl({ lang, onSaveBeforeCommit, onRestore, onOpenHistory, saveRequest }: {
  lang: 'ro' | 'en';
  /** Push what is on screen to the store first, so the version is what you see. */
  onSaveBeforeCommit: () => Promise<void>;
  onRestore: (data: GraphData) => void;
  onOpenHistory: () => void;
  /** Bumped by the shell (Ctrl+Shift+S, the command palette) to save a version straight away. */
  saveRequest?: number;
}) {
  const ro = lang === 'ro';
  const [commits, setCommits] = useState<HistoryCommit[] | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setCommits(await listHistory(8)); } catch { setCommits([]); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const save = useCallback(async (message: string) => {
    setBusy('save');
    try {
      await onSaveBeforeCommit();
      const r = await commitHistory(message.trim() || (ro ? 'Versiune' : 'Version'), 'checkpoint');
      if (!r) { toast.error(ro ? 'Versiunea nu s-a salvat — rulează serverul?' : 'The version was not saved — is the backend running?'); return; }
      toast.success(ro ? `Versiunea v${r.commit.id} salvată: ${r.commit.message}` : `Version v${r.commit.id} saved: ${r.commit.message}`);
      setMsg('');
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [onSaveBeforeCommit, refresh, ro]);

  // A save asked for from outside the panel (the shortcut, the palette).
  useEffect(() => {
    if (saveRequest) void save('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveRequest]);

  const restore = useCallback(async (c: HistoryCommit) => {
    const label = c.message || `v${c.id}`;
    if (!window.confirm(ro
      ? `Restaurezi „${label}”?\n\n${c.node_count} noduri / ${c.edge_count} legături înlocuiesc graful de acum. Istoricul rămâne întreg: se adaugă o versiune „restaurată”, deci poți reveni oricând.`
      : `Restore "${label}"?\n\n${c.node_count} nodes / ${c.edge_count} edges replace the current graph. History stays whole: a "restored" version is added, so you can always go back.`)) return;
    setBusy(`r${c.id}`);
    try {
      const r = await restoreHistoryCommit(c.id);
      if (!r) { toast.error(ro ? 'Restaurarea a eșuat — rulează serverul?' : 'Restore failed — is the backend running?'); return; }
      const { loadGraph } = await import('@/lib/api');
      onRestore(await loadGraph());
      toast.success(ro ? `Restaurat „${label}”` : `Restored "${label}"`);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [onRestore, refresh, ro]);

  const latest = commits?.[0];
  return (
    <HudPopover
      align="left"
      className="ghost bb-hud-versions"
      ariaLabel={ro ? 'Versiuni' : 'Versions'}
      title={ro ? 'Versiunile proiectului — salvează una, restaurează (Ctrl+Shift+S salvează)' : 'Project versions — save one, restore (Ctrl+Shift+S saves)'}
      onOpenChange={(open) => { if (open) void refresh(); }}
      icon={<GitCommitHorizontal className="bb-ico" strokeWidth={1.9} />}
      label={(
        <span className="bb-hud-ver-label">
          {latest ? <><strong>v{latest.id}</strong><span>{ago(latest.timestamp, ro)}</span></> : <span>{ro ? 'Versiuni' : 'Versions'}</span>}
        </span>
      )}
    >
      <div className="bb-versions">
        <form className="bb-versions-save" onSubmit={(e) => { e.preventDefault(); void save(msg); }}>
          <input
            className="bb-input"
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder={ro ? 'Ce s-a schimbat? (ex. „acoperiș în 4 ape”)' : 'What changed? (e.g. "hip roof")'}
            aria-label={ro ? 'Numele versiunii' : 'Version name'}
          />
          <button type="submit" className="bb-btn primary" disabled={busy !== null}>
            <Bookmark className="bb-ico" strokeWidth={2} />
            {busy === 'save' ? (ro ? 'Se salvează…' : 'Saving…') : (ro ? 'Salvează' : 'Save')}
          </button>
        </form>

        <h4>{ro ? 'Ultimele versiuni' : 'Latest versions'}</h4>
        {commits === null && <p className="bb-versions-empty">{ro ? 'Se încarcă…' : 'Loading…'}</p>}
        {commits !== null && commits.length === 0 && (
          <p className="bb-versions-empty">{ro ? 'Nicio versiune încă — salvează prima de mai sus.' : 'No versions yet — save the first one above.'}</p>
        )}
        <ol className="bb-versions-list">
          {(commits ?? []).map((c, i) => {
            const k = KIND[c.kind] ?? KIND.manual;
            const Icon = k.icon;
            return (
              <li key={c.id} className={`bb-version${i === 0 ? ' latest' : ''} ${c.kind}`}>
                <span className="bb-version-icon" title={ro ? k.ro : k.en}><Icon size={13} strokeWidth={2} /></span>
                <span className="bb-version-text">
                  <strong>v{c.id} · {c.message || (ro ? k.ro : k.en)}</strong>
                  <span>{ago(c.timestamp, ro)} · {c.node_count} {ro ? 'noduri' : 'nodes'}{c.comments?.length ? ` · ${c.comments.length} ${ro ? 'note' : 'notes'}` : ''}</span>
                </span>
                {i === 0
                  ? <span className="bb-version-now">{ro ? 'ultima' : 'latest'}</span>
                  : (
                    <button type="button" className="bb-btn" disabled={busy !== null} onClick={() => void restore(c)}
                      title={ro ? 'Readu proiectul la această versiune' : 'Bring the project back to this version'}>
                      <RotateCcw className="bb-ico" strokeWidth={1.9} />
                      {busy === `r${c.id}` ? '…' : (ro ? 'Restaurează' : 'Restore')}
                    </button>
                  )}
              </li>
            );
          })}
        </ol>
        <button type="button" className="bb-btn bb-versions-all" onClick={onOpenHistory}>
          <History className="bb-ico" strokeWidth={1.9} />
          {ro ? 'Tot istoricul — diferențe, note, curățare' : 'Full history — diffs, notes, clean-up'}
        </button>
      </div>
    </HudPopover>
  );
}
