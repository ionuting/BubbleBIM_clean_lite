/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HistoryPanel — the "commit log" layer of the git-inspired versioning
 * system (see also: useUndoableGraphState.ts for the local, ephemeral
 * "working tree" undo/redo layer, which this does NOT replace). Backed by
 * backend/version_history.py's content-addressable commit store.
 *
 * Flow: Save Checkpoint pushes the current backend graph as a named commit
 * → the list shows every commit newest-first → Restore appends a NEW commit
 * carrying the target's content (nothing is ever deleted) and reloads it
 * into the app's local state via `onRestore`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from '@/components/ui/toast';
import {
  commitHistory, listHistory, restoreHistoryCommit, gcHistory, addHistoryComment,
  getHistoryDiff, getHistoryCommitContent,
  type HistoryCommit, type HistoryCommitKind, type HistoryDiffSummary,
} from '@/lib/api';
import type { GraphData } from '@/lib/api';

interface DiffView {
  fromId: number;
  toId: number;
  summary: HistoryDiffSummary;
  fromContent: GraphData;
  toContent: GraphData;
}

/** id → "type · name" for display, resolved from whichever side's content actually has that id. */
function describeId(id: string, ...contents: (GraphData | null)[]): string {
  for (const c of contents) {
    const n = c?.nodes.find((x) => x.id === id);
    if (n) return `${n.type}${n.name ? ` · ${n.name}` : ''}`;
    const e = c?.edges.find((x) => x.id === id);
    if (e) return `edge ${e.from} → ${e.to}`;
  }
  return id;
}

interface HistoryPanelProps {
  /** Push the current in-app graph to the backend before committing (so the commit reflects what's on screen, not a stale prior save). */
  onSaveBeforeCommit: () => Promise<void>;
  /** Apply a restored graph into the app's local state (should also call breakCoalescing() on the undo stack). */
  onRestore: (data: GraphData) => void;
  onClose: () => void;
}

const KIND_META: Record<HistoryCommitKind, { icon: string; label: string; color: string }> = {
  checkpoint:     { icon: '📌', label: 'Checkpoint',    color: '#2563eb' },
  manual:         { icon: '💾', label: 'Save',          color: '#475569' },
  auto:           { icon: '⏱',  label: 'Auto-save',     color: '#94a3b8' },
  restore:        { icon: '↩',  label: 'Restored',      color: '#16a34a' },
  'pre-ifc-import': { icon: '📦', label: 'Before IFC import', color: '#d97706' },
};

function formatRelativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return iso;
  const diffMs = Date.now() - d;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function HistoryPanel({ onSaveBeforeCommit, onRestore, onClose }: HistoryPanelProps) {
  const [commits, setCommits] = useState<HistoryCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkpointMsg, setCheckpointMsg] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setCommits(await listHistory(50));
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCheckpoint = useCallback(async () => {
    setSaving(true);
    try {
      await onSaveBeforeCommit();
      const result = await commitHistory(checkpointMsg.trim() || 'Checkpoint', 'checkpoint');
      if (result) {
        toast.success(`Checkpoint saved: #${result.commit.id}`);
        setCheckpointMsg('');
        await refresh();
      } else {
        toast.error('Failed to save checkpoint — is the backend running?');
      }
    } finally {
      setSaving(false);
    }
  }, [checkpointMsg, onSaveBeforeCommit, refresh]);

  const handleRestore = useCallback(async (commit: HistoryCommit) => {
    const label = commit.message || `commit #${commit.id}`;
    if (!confirm(
      `Restore "${label}"?\n\n${commit.node_count} nodes / ${commit.edge_count} edges will replace the current graph.\n` +
      `This does NOT delete any history — it adds a new "Restored" entry, so you can always undo this by restoring again.`,
    )) return;

    setBusyId(commit.id);
    try {
      const result = await restoreHistoryCommit(commit.id);
      if (!result) { toast.error('Restore failed — is the backend running?'); return; }
      // The restore endpoint applies the content to the backend's bubble_graph.json;
      // reload it here so the caller gets the REAL restored nodes/edges.
      const { loadGraph } = await import('@/lib/api');
      const data = await loadGraph();
      onRestore(data);
      toast.success(`Restored "${label}" (${result.nodes_restored} nodes, ${result.edges_restored} edges)`);
      await refresh();
    } finally {
      setBusyId(null);
    }
  }, [onRestore, refresh]);

  const handleGc = useCallback(async () => {
    const result = await gcHistory(50);
    if (!result) { toast.error('Cleanup failed — is the backend running?'); return; }
    toast.success(`Cleaned up ${result.pruned_commits} old auto-saves, freed ${(result.freed_bytes / 1024).toFixed(1)} KB`);
    await refresh();
  }, [refresh]);

  const toggleExpand = useCallback((id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
    setCommentDraft('');
  }, []);

  const handleAddComment = useCallback(async (commitId: number) => {
    const text = commentDraft.trim();
    if (!text) return;
    setPostingComment(true);
    try {
      const result = await addHistoryComment(commitId, text);
      if (!result) { toast.error('Failed to add comment — is the backend running?'); return; }
      // Patch the single updated commit in place — avoids a full refetch/flicker.
      setCommits((prev) => prev.map((c) => (c.id === commitId ? result.commit : c)));
      setCommentDraft('');
    } finally {
      setPostingComment(false);
    }
  }, [commentDraft]);

  const toggleCompare = useCallback((id: number) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length < 2) return [...prev, id];
      return [prev[1], id]; // drop the oldest selection, keep the newest 2
    });
  }, []);

  // Always diff the OLDER commit → the NEWER one, regardless of click order.
  const [olderId, newerId] = useMemo(
    () => (compareIds.length === 2 ? [...compareIds].sort((a, b) => a - b) : [null, null]),
    [compareIds],
  );

  const handleViewDiff = useCallback(async () => {
    if (olderId == null || newerId == null) return;
    setDiffLoading(true);
    try {
      const [summary, fromContent, toContent] = await Promise.all([
        getHistoryDiff(olderId, newerId),
        getHistoryCommitContent(olderId),
        getHistoryCommitContent(newerId),
      ]);
      if (!summary || !fromContent || !toContent) { toast.error('Failed to load diff'); return; }
      setDiffView({ fromId: olderId, toId: newerId, summary, fromContent, toContent });
    } finally {
      setDiffLoading(false);
    }
  }, [olderId, newerId]);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
      <div className="flex flex-col w-[520px] max-h-[85vh] rounded-2xl bg-white border border-gray-200 shadow-2xl shadow-black/20 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200 bg-gray-50 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-base">🕐</div>
          <div className="flex-1">
            <h3 className="font-bold text-sm text-gray-900">Version History</h3>
            <p className="text-[10px] text-gray-500 mt-0.5">Checkpoints, auto-saves, and restores — nothing here is ever deleted automatically</p>
          </div>
          <button className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-all text-sm" onClick={onClose}>✕</button>
        </div>

        {/* Checkpoint composer */}
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50/50 shrink-0 flex gap-2">
          <input
            className="flex-1 rounded-lg bg-white border border-gray-300 text-gray-900 px-3 py-2 text-xs placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-400"
            placeholder="Describe this checkpoint (e.g. before roof redesign)…"
            value={checkpointMsg}
            onChange={(e) => setCheckpointMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !saving) handleCheckpoint(); }}
          />
          <button
            onClick={handleCheckpoint}
            disabled={saving}
            className="text-xs px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold transition-all shadow-sm shrink-0"
          >
            {saving ? 'Saving…' : '📌 Checkpoint'}
          </button>
        </div>

        {/* Body — scrollable commit list, or the diff view when two commits are compared */}
        <div className="flex-1 overflow-y-auto">
          {diffView ? (
            <DiffSummaryView diffView={diffView} onBack={() => setDiffView(null)} />
          ) : loading ? (
            <div className="px-5 py-8 text-center text-xs text-gray-400">Loading…</div>
          ) : commits.length === 0 ? (
            <div className="px-5 py-8 text-center text-xs text-gray-400">
              No history yet. Save a checkpoint above, or keep working — auto-saves will start appearing here.
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {commits.map((c) => {
                const meta = KIND_META[c.kind];
                const checked = compareIds.includes(c.id);
                const expanded = expandedId === c.id;
                const commentCount = c.comments?.length ?? 0;
                return (
                  <li key={c.id} className={checked ? 'bg-blue-50/60' : ''}>
                    <div className="flex items-center gap-3 px-5 py-2.5 hover:bg-gray-50 transition-colors">
                      <input
                        type="checkbox"
                        className="shrink-0"
                        checked={checked}
                        onChange={() => toggleCompare(c.id)}
                        title="Select to compare (pick 2)"
                      />
                      <span className="text-base shrink-0" title={meta.label}>{meta.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-gray-900 truncate">
                          {c.message || <span className="italic text-gray-400">({meta.label.toLowerCase()})</span>}
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-2">
                          <span>#{c.id}</span>
                          <span>·</span>
                          <span title={new Date(c.timestamp).toLocaleString()}>{formatRelativeTime(c.timestamp)}</span>
                          <span>·</span>
                          <span>{c.node_count}n / {c.edge_count}e</span>
                        </div>
                      </div>
                      <button
                        onClick={() => toggleExpand(c.id)}
                        className={`text-[10px] px-2 py-1.5 rounded-lg border transition-all shrink-0 ${expanded ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-500 hover:bg-gray-100'}`}
                        title="Comments"
                      >
                        💬{commentCount > 0 ? ` ${commentCount}` : ''}
                      </button>
                      <button
                        onClick={() => handleRestore(c)}
                        disabled={busyId !== null}
                        className="text-[10px] px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40 font-medium transition-all shrink-0"
                      >
                        {busyId === c.id ? '…' : 'Restore'}
                      </button>
                    </div>
                    {expanded && (
                      <div className="px-5 pb-3 pl-12 bg-gray-50/50">
                        {commentCount > 0 && (
                          <ul className="space-y-1.5 mb-2">
                            {c.comments!.map((cm, i) => (
                              <li key={i} className="text-[11px] text-gray-700 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5">
                                <span>{cm.text}</span>
                                <span className="text-gray-400 ml-2" title={new Date(cm.timestamp).toLocaleString()}>
                                  {formatRelativeTime(cm.timestamp)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="flex gap-1.5">
                          <input
                            className="flex-1 rounded-lg bg-white border border-gray-300 text-gray-900 px-2.5 py-1.5 text-[11px] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-400"
                            placeholder="Add a comment…"
                            value={commentDraft}
                            onChange={(e) => setCommentDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !postingComment) handleAddComment(c.id); }}
                          />
                          <button
                            onClick={() => handleAddComment(c.id)}
                            disabled={postingComment || !commentDraft.trim()}
                            className="text-[10px] px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium transition-all shrink-0"
                          >
                            {postingComment ? '…' : 'Add'}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Compare bar — shown once at least one commit is selected, not in diff view */}
        {!diffView && compareIds.length > 0 && (
          <div className="px-5 py-2 border-t border-gray-200 bg-blue-50 flex items-center justify-between shrink-0">
            <span className="text-[10px] text-blue-700">
              {compareIds.length === 1 ? 'Select one more commit to compare…' : `Comparing #${olderId} → #${newerId}`}
            </span>
            <div className="flex items-center gap-2">
              <button onClick={() => setCompareIds([])} className="text-[10px] text-blue-500 hover:text-blue-700">Clear</button>
              <button
                onClick={handleViewDiff}
                disabled={compareIds.length !== 2 || diffLoading}
                className="text-[10px] px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium transition-all"
              >
                {diffLoading ? 'Loading…' : '⇄ View Diff'}
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-between shrink-0">
          <button onClick={handleGc} className="text-[10px] text-gray-400 hover:text-gray-700 transition-all">
            🧹 Clean up old auto-saves
          </button>
          <button onClick={onClose} className="text-xs px-4 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 transition-all font-medium">Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── Diff view — node/edge-level, not a raw JSON text diff ────────────────

function DiffRow({ id, label, contents }: { id: string; label: 'added' | 'removed' | 'modified'; contents: (GraphData | null)[] }) {
  const colors = {
    added:    { dot: 'bg-green-500', text: 'text-green-700' },
    removed:  { dot: 'bg-red-500', text: 'text-red-700' },
    modified: { dot: 'bg-amber-500', text: 'text-amber-700' },
  }[label];
  return (
    <li className="flex items-center gap-2 py-1 text-[11px]">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot}`} />
      <span className={`font-mono ${colors.text}`}>{describeId(id, ...contents)}</span>
    </li>
  );
}

function DiffSection({
  title, kind, ids, contents,
}: { title: string; kind: 'added' | 'removed' | 'modified'; ids: string[]; contents: (GraphData | null)[] }) {
  if (ids.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1">{title} ({ids.length})</div>
      <ul>{ids.map((id) => <DiffRow key={id} id={id} label={kind} contents={contents} />)}</ul>
    </div>
  );
}

function DiffSummaryView({ diffView, onBack }: { diffView: DiffView; onBack: () => void }) {
  const { fromId, toId, summary, fromContent, toContent } = diffView;
  const totalChanges = summary.nodes.added.length + summary.nodes.removed.length + summary.nodes.modified.length
    + summary.edges.added.length + summary.edges.removed.length;

  return (
    <div className="px-5 py-4">
      <button onClick={onBack} className="text-[10px] text-blue-600 hover:text-blue-800 mb-3 font-medium">← Back to history</button>
      <div className="text-xs text-gray-500 mb-4">
        Comparing <span className="font-mono font-semibold text-gray-800">#{fromId}</span> → <span className="font-mono font-semibold text-gray-800">#{toId}</span>
      </div>
      {totalChanges === 0 ? (
        <p className="text-xs text-gray-400 italic">No differences — identical content.</p>
      ) : (
        <>
          <DiffSection title="Nodes added" kind="added" ids={summary.nodes.added} contents={[toContent]} />
          <DiffSection title="Nodes removed" kind="removed" ids={summary.nodes.removed} contents={[fromContent]} />
          <DiffSection title="Nodes modified" kind="modified" ids={summary.nodes.modified} contents={[toContent, fromContent]} />
          <DiffSection title="Edges added" kind="added" ids={summary.edges.added} contents={[toContent]} />
          <DiffSection title="Edges removed" kind="removed" ids={summary.edges.removed} contents={[fromContent]} />
        </>
      )}
    </div>
  );
}
