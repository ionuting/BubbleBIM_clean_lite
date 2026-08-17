/**
 * VisibilityFilter — per-viewer element type visibility panel.
 *
 * Supports two modes:
 * - Flat mode (2D viewers / section / elevation): flat list of element types.
 * - Tree mode (3D viewers): storeys as collapsible parent rows, element types
 *   as global-toggle children. An entire storey can be hidden with one click.
 *
 * State is entirely local to the viewer instance that mounts this component
 * so each tab has its own independent visibility settings.
 */

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';

// ─── Type metadata (label + colour dot) ──────────────────────────────────────

const TYPE_META: Record<string, { label: string; color: string }> = {
  storey:     { label: 'Storey floors / grid', color: '#4488dd' },
  ax:         { label: 'Axis markers',         color: '#8899aa' },
  column:     { label: 'Columns',              color: '#e8c840' },
  beam:       { label: 'Beams',                color: '#a06030' },
  wall:       { label: 'Walls',                color: '#cc8855' },
  slab:       { label: 'Slabs',               color: '#6699cc' },
  foundation: { label: 'Foundations',          color: '#886644' },
  window:     { label: 'Windows',              color: '#88ccee' },
  door:       { label: 'Doors',                color: '#cc9966' },
  room:       { label: 'Rooms',                color: '#88cc88' },
  shell:      { label: 'Shell / Roof',         color: '#cc6688' },
  covering:   { label: 'Covering',             color: '#aa88cc' },
};

function typeMeta(type: string) {
  return TYPE_META[type] ?? { label: type, color: '#aaaaaa' };
}

// ─── Canonical type order ─────────────────────────────────────────────────────

const CANONICAL_ORDER = [
  'storey', 'ax', 'column', 'beam', 'wall', 'slab',
  'foundation', 'window', 'door', 'room', 'shell', 'covering',
];

function sortTypes(types: string[]): string[] {
  const known   = CANONICAL_ORDER.filter((t) => types.includes(t));
  const unknown = types.filter((t) => !CANONICAL_ORDER.includes(t)).sort();
  return [...known, ...unknown];
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface VisibilityFilterProps {
  /** All unique node types currently in the scene */
  types: string[];
  /** Types that are currently hidden (controlled from parent) */
  hiddenTypes: Set<string>;
  /** Called whenever the user toggles a type */
  onChange: (hidden: Set<string>) => void;
  /** Optional per-type element count for display */
  counts?: Record<string, number>;
  className?: string;

  // ── Tree mode (3D viewers) ─────────────────────────────────────────────
  /**
   * All scene nodes. When provided the panel renders in tree mode:
   * storeys are collapsible parent rows, element-type checkboxes are
   * global toggles that appear under each storey for quick access.
   */
  nodes?: BubbleGraphNode[];
  /** Edges connecting nodes. Used in tree mode to include edge-connected elements
   * (windows, doors, coverings, shells) in per-storey counts. */
  edges?: BubbleGraphEdge[];
  /** Storey IDs that are fully hidden (controlled from parent) */
  hiddenStoreyIds?: Set<string>;
  /** Called whenever the user toggles an entire storey */
  onChangeStoreyIds?: (hidden: Set<string>) => void;
}

// ─── Single type row ─────────────────────────────────────────────────────────

function TypeRow({
  type,
  visible,
  count,
  indent,
  onToggle,
}: {
  type: string;
  visible: boolean;
  count?: number;
  indent?: boolean;
  onToggle: () => void;
}) {
  const meta = typeMeta(type);
  return (
    <label
      className={cn(
        'flex items-center gap-2 py-1.5 cursor-pointer hover:bg-white/5 transition-colors',
        indent ? 'pl-8 pr-3' : 'px-3',
        !visible && 'opacity-40',
      )}
    >
      <input
        type="checkbox"
        checked={visible}
        onChange={onToggle}
        className="accent-primary w-3 h-3 shrink-0"
      />
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.color }} />
      <span className="flex-1 truncate">{meta.label}</span>
      {count !== undefined && (
        <span className="text-white/30 text-[10px]">{count}</span>
      )}
    </label>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function VisibilityFilter({
  types,
  hiddenTypes,
  onChange,
  counts,
  className,
  nodes,
  edges,
  hiddenStoreyIds,
  onChangeStoreyIds,
}: VisibilityFilterProps) {
  const [open, setOpen] = useState(false);
  const [expandedStoreys, setExpandedStoreys] = useState<Set<string>>(new Set());

  const treeMode = !!nodes && !!hiddenStoreyIds && !!onChangeStoreyIds;

  // ─── Tree data: sorted storey nodes + per-storey type counts ─────────────
  const treeData = useMemo(() => {
    if (!treeMode || !nodes) return null;

    const storeyNodes = nodes
      .filter((n) => n.type === 'storey')
      .sort((a, b) => {
        const bA = Number(a.properties.bottomElevation ?? 0);
        const bB = Number(b.properties.bottomElevation ?? 0);
        return bA - bB;
      });

    const storeyTypeCounts = new Map<string, Record<string, number>>();

    // Build parent→children index for recursive descendant traversal
    const childrenMap = new Map<string, string[]>();
    const nodeById    = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      if (n.parentId) {
        if (!childrenMap.has(n.parentId)) childrenMap.set(n.parentId, []);
        childrenMap.get(n.parentId)!.push(n.id);
      }
    }

    // Build edge-neighbour index (bidirectional) for edge-connected types
    const edgeNeighbours = new Map<string, string[]>();
    for (const e of (edges ?? [])) {
      if (!edgeNeighbours.has(e.from)) edgeNeighbours.set(e.from, []);
      if (!edgeNeighbours.has(e.to))   edgeNeighbours.set(e.to, []);
      edgeNeighbours.get(e.from)!.push(e.to);
      edgeNeighbours.get(e.to)!.push(e.from);
    }

    const getDescendants = (startId: string): typeof nodes => {
      const result: typeof nodes = [];
      const visited = new Set<string>([startId]);
      const queue = [startId];
      while (queue.length) {
        const cid = queue.shift()!;
        // parentId children
        for (const childId of childrenMap.get(cid) ?? []) {
          if (!visited.has(childId)) {
            visited.add(childId);
            const child = nodeById.get(childId);
            if (child) { result.push(child); queue.push(childId); }
          }
        }
        // edge-connected children (window, door, shell, covering only,
        // to avoid pulling in unrelated nodes like ax/storey)
        const current = nodeById.get(cid);
        if (current && ['wall', 'beam', 'slab', 'column', 'ax', 'storey', 'shell'].includes(current.type)) {
          for (const nbId of edgeNeighbours.get(cid) ?? []) {
            if (!visited.has(nbId)) {
              const nb = nodeById.get(nbId);
              if (nb && ['window', 'door', 'shell', 'covering'].includes(nb.type)) {
                visited.add(nbId);
                result.push(nb);
                queue.push(nbId);
              }
            }
          }
        }
      }
      return result;
    };

    for (const s of storeyNodes) {
      const cnt: Record<string, number> = {};
      for (const c of getDescendants(s.id)) {
        cnt[c.type] = (cnt[c.type] ?? 0) + 1;
        // Virtual column category from ax nodes
        if (c.type === 'ax' && String(c.properties.has_column ?? '').toLowerCase() === 'true')
          cnt['column'] = (cnt['column'] ?? 0) + 1;
        // Virtual beam category from wall nodes
        if (c.type === 'wall' && String(c.properties.has_beam ?? '').toLowerCase() === 'true')
          cnt['beam'] = (cnt['beam'] ?? 0) + 1;
      }
      storeyTypeCounts.set(s.id, cnt);
    }

    return { storeyNodes, storeyTypeCounts };
  }, [treeMode, nodes, edges]);

  const sortedTypes = useMemo(() => sortTypes(types), [types]);

  const hiddenCount = hiddenTypes.size + (hiddenStoreyIds?.size ?? 0);
  const allHidden   = treeMode
    ? hiddenTypes.size === types.length && (treeData?.storeyNodes.length ?? 0) > 0 && hiddenStoreyIds!.size === treeData!.storeyNodes.length
    : hiddenTypes.size === types.length && types.length > 0;
  const allVisible  = hiddenTypes.size === 0 && (!hiddenStoreyIds || hiddenStoreyIds.size === 0);

  const toggleType = (type: string) => {
    const next = new Set(hiddenTypes);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    onChange(next);
  };

  const toggleStorey = (id: string) => {
    if (!hiddenStoreyIds || !onChangeStoreyIds) return;
    const next = new Set(hiddenStoreyIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChangeStoreyIds(next);
  };

  const toggleExpandStorey = (id: string) => {
    setExpandedStoreys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allVisible) {
      onChange(new Set(types));
      onChangeStoreyIds?.(new Set(treeData?.storeyNodes.map((s) => s.id) ?? []));
    } else {
      onChange(new Set());
      onChangeStoreyIds?.(new Set());
    }
  };

  return (
    <div className={cn('absolute top-2 right-2 z-10 select-none', className)}>
      {/* Toggle button */}
      <button
        onClick={() => setOpen((v) => !v)}
        title="Toggle visibility filter"
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium shadow',
          'bg-black/70 border border-white/10 text-white/80 hover:bg-black/90 hover:text-white',
          open && 'bg-black/90 text-white border-white/20',
        )}
      >
        {/* eye icon */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        Visibility
        {hiddenCount > 0 && (
          <span className="bg-primary/80 text-[10px] px-1 rounded-full text-white leading-none py-0.5">
            {hiddenCount}
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div className="mt-1 bg-black/85 border border-white/10 rounded shadow-xl w-56 text-xs text-white/85">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
            <span className="font-semibold text-white/60 uppercase tracking-wide text-[10px]">
              {treeMode ? 'Floors & Elements' : 'Element types'}
            </span>
            <button
              onClick={toggleAll}
              className="text-[10px] text-primary hover:text-primary/80 underline"
            >
              {allVisible ? 'Hide all' : 'Show all'}
            </button>
          </div>

          {/* Content */}
          <ul className="py-1 max-h-96 overflow-y-auto">
            {treeMode && treeData ? (
              // ── Tree mode ────────────────────────────────────────────────
              <>
                {treeData.storeyNodes.map((s) => {
                  const storeyVisible = !hiddenStoreyIds!.has(s.id);
                  const isExpanded    = expandedStoreys.has(s.id);
                  const cnt           = treeData.storeyTypeCounts.get(s.id) ?? {};
                  const childTypes    = sortTypes(Object.keys(cnt));
                  const storeyLabel   = String(
                    s.label ?? s.properties.label ?? s.properties.name ?? s.id,
                  );
                  const botM = (Number(s.properties.bottomElevation ?? 0) / 1000).toFixed(2);
                  const totalCount = childTypes.reduce((sum, t) => sum + (cnt[t] ?? 0), 0);

                  return (
                    <li key={s.id}>
                      {/* Storey header row */}
                      <div
                        className={cn(
                          'flex items-center gap-1.5 px-2 py-1.5 hover:bg-white/5 transition-colors',
                          !storeyVisible && 'opacity-40',
                        )}
                      >
                        {/* Expand/collapse arrow */}
                        <button
                          onClick={() => toggleExpandStorey(s.id)}
                          className="shrink-0 text-white/40 hover:text-white/80 w-4 h-4 flex items-center justify-center text-[10px]"
                          title={isExpanded ? 'Collapse' : 'Expand element types'}
                        >
                          {childTypes.length > 0 ? (isExpanded ? '▾' : '▸') : '·'}
                        </button>

                        {/* Storey visibility checkbox */}
                        <input
                          type="checkbox"
                          checked={storeyVisible}
                          onChange={() => toggleStorey(s.id)}
                          className="accent-primary w-3 h-3 shrink-0"
                          title={storeyVisible ? 'Hide this floor' : 'Show this floor'}
                        />

                        {/* Floor colour dot */}
                        <span className="w-2 h-2 rounded-full shrink-0 bg-[#4488dd]" />

                        {/* Label + elevation */}
                        <span className="flex-1 min-w-0">
                          <span className="truncate block font-medium text-white/90">{storeyLabel}</span>
                          <span className="text-white/35 text-[9px]">+{botM} m</span>
                        </span>

                        {totalCount > 0 && (
                          <span className="text-white/30 text-[10px] shrink-0">{totalCount}</span>
                        )}
                      </div>

                      {/* Child element types (shown when expanded) */}
                      {isExpanded && childTypes.map((type) => (
                        <TypeRow
                          key={type}
                          type={type}
                          visible={!hiddenTypes.has(type)}
                          count={cnt[type]}
                          indent
                          onToggle={() => toggleType(type)}
                        />
                      ))}
                    </li>
                  );
                })}

                {/* Separator + global types (storey floors/grid, uncategorised) */}
                {sortedTypes.filter((t) => t === 'storey' || !treeData.storeyNodes.length).length > 0 && (
                  <>
                    <li className="my-1 border-t border-white/10" />
                    {sortedTypes.filter((t) => t === 'storey').map((type) => (
                      <li key={type}>
                        <TypeRow
                          type={type}
                          visible={!hiddenTypes.has(type)}
                          count={counts?.[type]}
                          onToggle={() => toggleType(type)}
                        />
                      </li>
                    ))}
                  </>
                )}
              </>
            ) : (
              // ── Flat mode (2D viewers) ────────────────────────────────────
              sortedTypes.map((type) => (
                <li key={type}>
                  <TypeRow
                    type={type}
                    visible={!hiddenTypes.has(type)}
                    count={counts?.[type]}
                    onToggle={() => toggleType(type)}
                  />
                </li>
              ))
            )}

            {sortedTypes.length === 0 && (!treeData || treeData.storeyNodes.length === 0) && (
              <li className="px-3 py-3 text-white/30 text-center">No elements</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
