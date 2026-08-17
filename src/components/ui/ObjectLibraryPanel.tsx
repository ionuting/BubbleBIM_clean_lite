/**
 * ObjectLibraryPanel — 3D object library browser (Item 11).
 *
 * Shows all library objects grouped by category.
 * Clicking an entry calls onInsert(entry) so the parent can place an
 * 'object' node in the graph at the desired position.
 *
 * Features:
 *  - Category tabs
 *  - Text search filter
 *  - Per-object card with dimensions + description
 *  - Top-view SVG symbol preview (or generated fallback)
 *  - GLB upload drop zone per entry
 */

import React, { useState, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useObjectLibrary, invalidateObjectLibraryCache, type ObjectLibraryEntry } from '@/lib/useObjectLibrary';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

// ─── Generated top-view symbol (when no top.svg exists) ──────────────────────

function GeneratedTopSymbol({ entry, size = 56 }: { entry: ObjectLibraryEntry; size?: number }) {
  const aspect = entry.depth_mm > 0 ? entry.width_mm / entry.depth_mm : 1;
  const svgW   = size;
  const svgH   = size;
  const pad    = 4;
  const rectW  = Math.min(svgW - pad * 2, (svgH - pad * 2) * aspect);
  const rectH  = Math.min(svgH - pad * 2, (svgW - pad * 2) / aspect);
  const cx     = svgW / 2, cy = svgH / 2;

  return (
    <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} className="block">
      <rect
        x={cx - rectW / 2} y={cy - rectH / 2} width={rectW} height={rectH}
        fill="#ede9fe55" stroke="#8b5cf6" strokeWidth="1.2" rx="1"
      />
      <line x1={cx - rectW / 2} y1={cy - rectH / 2} x2={cx + rectW / 2} y2={cy + rectH / 2}
        stroke="#8b5cf680" strokeWidth="0.7" />
      <line x1={cx + rectW / 2} y1={cy - rectH / 2} x2={cx - rectW / 2} y2={cy + rectH / 2}
        stroke="#8b5cf680" strokeWidth="0.7" />
    </svg>
  );
}

// ─── Top-view symbol with server SVG fallback ─────────────────────────────────

function TopSymbol({ entry, size = 56 }: { entry: ObjectLibraryEntry; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!entry.top_svg || failed) return <GeneratedTopSymbol entry={entry} size={size} />;
  return (
    <img
      src={`${API_BASE}/library/${entry.top_svg}`}
      alt={entry.label}
      width={size} height={size}
      className="object-contain"
      onError={() => setFailed(true)}
      style={{ display: 'block' }}
    />
  );
}

// ─── GLB Upload Button ────────────────────────────────────────────────────────

function GlbUploadButton({ entry, onUploaded }: { entry: ObjectLibraryEntry; onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'ok' | 'err'>('idle');

  const handleFile = useCallback(async (file: File) => {
    setUploading(true);
    setStatus('idle');
    try {
      const parts = entry.glb.split('/'); // e.g. objects/furniture/chair_office/model.glb
      const category  = parts[1] ?? 'furniture';
      const objectId  = parts[2] ?? entry.id;
      const fd = new FormData();
      fd.append('file', file, file.name);
      const url = `${API_BASE}/api/library/objects/upload?category=${encodeURIComponent(category)}&object_id=${encodeURIComponent(objectId)}`;
      const res = await fetch(url, { method: 'POST', body: fd });
      if (!res.ok) throw new Error(await res.text());
      setStatus('ok');
      invalidateObjectLibraryCache();
      onUploaded();
    } catch (err) {
      console.error('[GlbUploadButton]', err);
      setStatus('err');
    } finally {
      setUploading(false);
    }
  }, [entry, onUploaded]);

  return (
    <>
      <input
        ref={inputRef} type="file" accept=".glb,.gltf,.svg"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
      />
      <button
        title="Upload GLB/GLTF/SVG for this object"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'text-[9px] px-1.5 py-0.5 rounded border transition-colors',
          status === 'ok'  ? 'border-green-400 text-green-600 bg-green-50/50 dark:bg-green-950/30' :
          status === 'err' ? 'border-red-400 text-red-500' :
          'border-border text-muted-foreground hover:border-violet-400 hover:text-violet-600',
        )}
      >
        {uploading ? '⏳' : status === 'ok' ? '✓ GLB' : '↑ GLB'}
      </button>
    </>
  );
}

// ─── ObjectLibraryCard ────────────────────────────────────────────────────────

interface ObjectLibraryCardProps {
  entry:     ObjectLibraryEntry;
  selected:  boolean;
  onSelect:  () => void;
  onInsert:  (entry: ObjectLibraryEntry) => void;
  onRefresh: () => void;
}

function ObjectLibraryCard({ entry, selected, onSelect, onInsert, onRefresh }: ObjectLibraryCardProps) {
  return (
    <div
      onClick={onSelect}
      onDoubleClick={() => onInsert(entry)}
      className={cn(
        'group flex flex-col rounded-md border cursor-pointer transition-all select-none',
        'hover:border-violet-400/70 hover:shadow-sm',
        selected
          ? 'border-violet-500 bg-violet-50/60 dark:bg-violet-950/30 ring-1 ring-violet-400/40'
          : 'border-border/60 bg-background/60',
      )}
    >
      {/* Symbol preview */}
      <div className="flex items-center justify-center h-14 p-1 rounded-t-md bg-muted/30">
        <TopSymbol entry={entry} size={52} />
      </div>

      {/* Info */}
      <div className="px-1.5 py-1 flex flex-col gap-0.5 min-h-0">
        <span className="text-[10px] font-medium truncate leading-tight text-foreground" title={entry.label}>
          {entry.label}
        </span>
        <span className="text-[9px] text-muted-foreground truncate">
          {entry.width_mm}×{entry.depth_mm}×{entry.height_mm} mm
        </span>
      </div>

      {/* Actions (shown on hover or selected) */}
      <div className={cn(
        'flex items-center justify-between px-1.5 pb-1 gap-1 transition-opacity',
        selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
      )}>
        <GlbUploadButton entry={entry} onUploaded={onRefresh} />
        <button
          title="Insert into graph"
          onClick={(e) => { e.stopPropagation(); onInsert(entry); }}
          className="text-[9px] px-1.5 py-0.5 rounded border border-violet-400 text-violet-600 hover:bg-violet-100 dark:hover:bg-violet-900/30 transition-colors"
        >
          + Place
        </button>
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export interface ObjectLibraryPanelProps {
  /** Called when user wants to insert an entry into the graph */
  onInsert: (entry: ObjectLibraryEntry) => void;
  className?: string;
}

export function ObjectLibraryPanel({ onInsert, className }: ObjectLibraryPanelProps) {
  const { entries, categories, loading, error } = useObjectLibrary();
  const [activeCategory, setActiveCategory] = useState<string | 'all'>('all');
  const [search, setSearch]     = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [, forceRefresh] = useState(0);

  const handleRefresh = () => { invalidateObjectLibraryCache(); forceRefresh((n) => n + 1); };

  const filtered = entries.filter((e) => {
    if (activeCategory !== 'all' && e.category !== activeCategory) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      e.label.toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q) ||
      (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  });

  const allCategories = [{ id: 'all', label: 'All', icon: '📦' }, ...categories];

  return (
    <div className={cn('flex flex-col h-full overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/60 flex-shrink-0">
        <span className="text-xs font-semibold text-foreground">Library Objects</span>
        <button
          onClick={handleRefresh}
          title="Reload library"
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >↺</button>
      </div>

      {/* Search */}
      <div className="px-2 py-1.5 border-b border-border/40 flex-shrink-0">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search objects…"
          className="w-full text-xs bg-muted/40 border border-border/50 rounded px-2 py-1 outline-none focus:border-violet-400 placeholder:text-muted-foreground/50"
        />
      </div>

      {/* Category tabs */}
      <div className="flex gap-0.5 px-1.5 py-1 border-b border-border/40 flex-wrap flex-shrink-0">
        {allCategories.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            className={cn(
              'text-[9px] px-1.5 py-0.5 rounded transition-colors whitespace-nowrap',
              activeCategory === cat.id
                ? 'bg-violet-600 text-white'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {cat.icon} {cat.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {loading && (
          <div className="flex items-center justify-center h-20 text-xs text-muted-foreground animate-pulse">
            Loading library…
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center justify-center h-20 gap-1 text-xs text-muted-foreground">
            <span className="text-red-500">⚠ {error}</span>
            <span className="opacity-60">Backend may be offline</span>
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="flex items-center justify-center h-16 text-xs text-muted-foreground">
            No objects match
          </div>
        )}
        {!loading && !error && (
          <div className="grid grid-cols-2 gap-1.5">
            {filtered.map((entry) => (
              <ObjectLibraryCard
                key={entry.id}
                entry={entry}
                selected={selected === entry.id}
                onSelect={() => setSelected(entry.id)}
                onInsert={onInsert}
                onRefresh={handleRefresh}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="px-2 py-1 border-t border-border/40 flex-shrink-0 text-[9px] text-muted-foreground/60 text-center">
        Double-click or click "+ Place" to insert • ↑ GLB to upload model
      </div>
    </div>
  );
}
