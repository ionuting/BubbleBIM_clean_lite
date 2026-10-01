/**
 * ProjectsDialog — the projects stored on the backend, and what to do with them.
 *
 * There used to be one graph file. Two tabs holding two projects auto-saved
 * over each other and the last writer won, silently: a project could be
 * replaced by another with nothing reported. Projects are separate files now,
 * and this is where they become visible — because a store nobody can see is a
 * store nobody trusts.
 *
 * Deliberately plain: a list, and the four things you do to a project. The one
 * that needed care is delete, which keeps the commit log by default, so a
 * project deleted by accident is still recoverable from its history.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  deleteProject, listProjects, openProject, renameProject, type ProjectSummary,
} from '@/lib/api';

/** "acum 3 min", "acum 2 h", "17 sep" — a save you made is worth reading at a glance. */
function whenSaved(unixSeconds: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - unixSeconds) / 60));
  if (mins < 1) return 'chiar acum';
  if (mins < 60) return `acum ${mins} min`;
  if (mins < 60 * 24) return `acum ${Math.round(mins / 60)} h`;
  return new Date(unixSeconds * 1000).toLocaleDateString('ro-RO', { day: 'numeric', month: 'short' });
}

export interface ProjectsDialogProps {
  /** The project this tab has open, so it can be marked and not "opened" again. */
  currentSlug: string;
  /** Switch this tab to another project. The caller reloads the graph. */
  onOpen: (slug: string) => void;
  /** Save the CURRENT graph under a new name. */
  onSaveAs: (name: string) => void;
  onClose: () => void;
}

export function ProjectsDialog({ currentSlug, onOpen, onSaveAs, onClose }: ProjectsDialogProps) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ slug: string; value: string } | null>(null);
  const [newName, setNewName] = useState('');

  const refresh = useCallback(async () => {
    const { projects: list } = await listProjects();
    setProjects(list);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = useCallback(async (job: () => Promise<void>) => {
    setError(null);
    try {
      await job();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refresh]);

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[30rem] max-h-[80vh] flex flex-col rounded-lg border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Proiecte
          </span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">✕</button>
        </div>

        {/* Save the current graph under a new name — the thing this was asked for. */}
        <div className="px-4 py-3 border-b border-border flex gap-1.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) { onSaveAs(newName.trim()); setNewName(''); }
            }}
            placeholder="Salvează ce ai acum ca…"
            className="flex-1 bg-background border border-border rounded px-2 py-1 text-xs outline-none focus:border-primary"
          />
          <button
            disabled={!newName.trim()}
            onClick={() => { onSaveAs(newName.trim()); setNewName(''); }}
            className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            Salvează ca
          </button>
        </div>

        {error && (
          <div className="px-4 py-2 text-[11px] text-destructive border-b border-border">{error}</div>
        )}

        <div className="flex-1 overflow-y-auto">
          {projects === null && (
            <div className="px-4 py-6 text-xs text-muted-foreground">Se încarcă…</div>
          )}
          {projects?.length === 0 && (
            <div className="px-4 py-6 text-xs text-muted-foreground">Niciun proiect salvat.</div>
          )}
          {projects?.map((p) => {
            const isCurrent = p.slug === currentSlug;
            return (
              <div
                key={p.slug}
                className={`px-4 py-2 border-b border-border/50 flex items-center gap-2 ${isCurrent ? 'bg-primary/5' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  {renaming?.slug === p.slug ? (
                    <input
                      autoFocus
                      value={renaming.value}
                      onChange={(e) => setRenaming({ slug: p.slug, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setRenaming(null);
                        if (e.key === 'Enter' && renaming.value.trim()) {
                          const value = renaming.value.trim();
                          setRenaming(null);
                          void run(async () => { await renameProject(p.slug, value); });
                        }
                      }}
                      onBlur={() => setRenaming(null)}
                      className="w-full bg-background border border-primary rounded px-1.5 py-0.5 text-xs outline-none"
                    />
                  ) : (
                    <div className="text-xs font-medium truncate flex items-center gap-1.5">
                      {p.name}
                      {isCurrent && (
                        <span className="text-[9px] uppercase tracking-wider text-primary border border-primary/40 rounded px-1">
                          deschis
                        </span>
                      )}
                    </div>
                  )}
                  <div className="text-[10px] text-muted-foreground">
                    {p.nodes} noduri · {p.edges} muchii · {whenSaved(p.updated)}
                  </div>
                </div>

                {!isCurrent && (
                  <button
                    onClick={() => void run(async () => { await openProject(p.slug); onOpen(p.slug); })}
                    className="text-[11px] px-2 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
                  >
                    Deschide
                  </button>
                )}
                <button
                  onClick={() => setRenaming({ slug: p.slug, value: p.name })}
                  title="Redenumește — istoricul se mută odată cu proiectul"
                  className="text-[11px] px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                >
                  ✎
                </button>
                <button
                  onClick={() => {
                    // The history survives, so this is undoable — but it still
                    // takes a project off the list, and that deserves a pause.
                    if (!confirm(`Ștergi „${p.name}"? Istoricul lui rămâne, deci poate fi recuperat.`)) return;
                    void run(async () => { await deleteProject(p.slug, true); });
                  }}
                  title="Șterge proiectul (istoricul rămâne)"
                  className="text-[11px] px-1.5 py-0.5 text-muted-foreground hover:text-destructive"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
