/**
 * NodeMultiSelectFilter.tsx
 *
 * Floating panel that lets the user build a set of criteria (node type +
 * optional element-type ID) and select all matching nodes at once.
 *
 * Usage:
 *   <NodeMultiSelectFilter
 *     nodes={nodes}
 *     onSelect={(ids) => setSelectedNodeIds(ids)}
 *     onClose={() => setShowMultiSelect(false)}
 *   />
 *
 * Keyboard: ESC closes the panel and clears the selection.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { BubbleGraphNode } from '@/store';
import {
  WALL_TYPES,
  BEAM_TYPES,
  COLUMN_TYPES,
  SLAB_TYPES,
  FOUNDATION_TYPES,
  WINDOW_TYPES,
  DOOR_TYPES,
} from '@/lib/elementLibrary';

// ─── Node-type → element-type descriptor map ─────────────────────────────────

interface NodeTypeOption {
  type: string;
  label: string;
  icon: string;
  propKey: string | null;
  elementTypes: { id: string; label: string }[];
}

const NODE_TYPE_OPTIONS: NodeTypeOption[] = [
  { type: 'wall',       label: 'Wall',       icon: '▭', propKey: 'wall_type',        elementTypes: WALL_TYPES.map((t) => ({ id: t.id, label: t.label })) },
  { type: 'beam',       label: 'Beam',       icon: '═', propKey: 'beam_type',        elementTypes: BEAM_TYPES.map((t) => ({ id: t.id, label: t.label })) },
  { type: 'column',     label: 'Column',     icon: '⬛', propKey: 'column_type',      elementTypes: COLUMN_TYPES.map((t) => ({ id: t.id, label: t.label })) },
  { type: 'ax',         label: 'Grid Axis',  icon: '⊕', propKey: 'column_type',      elementTypes: COLUMN_TYPES.map((t) => ({ id: t.id, label: t.label })) },
  { type: 'slab',       label: 'Slab',       icon: '▬', propKey: 'slab_type',        elementTypes: SLAB_TYPES.map((t) => ({ id: t.id, label: t.label })) },
  { type: 'foundation', label: 'Foundation', icon: '⬜', propKey: 'foundation_type',  elementTypes: FOUNDATION_TYPES.map((t) => ({ id: t.id, label: t.label })) },
  { type: 'window',     label: 'Window',     icon: '🪟', propKey: 'window_type',      elementTypes: WINDOW_TYPES.map((t) => ({ id: t.id, label: t.label })) },
  { type: 'door',       label: 'Door',       icon: '🚪', propKey: 'door_type',        elementTypes: DOOR_TYPES.map((t) => ({ id: t.id, label: t.label })) },
  { type: 'storey',     label: 'Storey',     icon: '🏢', propKey: null,               elementTypes: [] },
  { type: 'room',       label: 'Room',       icon: '□', propKey: null,               elementTypes: [] },
  { type: 'shell',      label: 'Shell',      icon: '⌒', propKey: null,               elementTypes: [] },
  { type: 'roof',       label: 'Roof',       icon: '△', propKey: null,               elementTypes: [] },
  { type: 'covering',   label: 'Covering',   icon: '▤', propKey: null,               elementTypes: [] },
];

const NODE_TYPE_MAP = new Map(NODE_TYPE_OPTIONS.map((o) => [o.type, o]));

// ─── Criterion row ────────────────────────────────────────────────────────────

interface Criterion {
  id: number;
  nodeType: string;   // '' = not yet chosen
  elementTypeId: string; // '' = any
}

let _criterionCounter = 0;
function newCriterion(): Criterion {
  return { id: ++_criterionCounter, nodeType: '', elementTypeId: '' };
}

// ─── Matching logic ───────────────────────────────────────────────────────────

function nodeMatchesCriteria(node: BubbleGraphNode, criteria: Criterion[]): boolean {
  // Active criteria only (node type must be chosen)
  const active = criteria.filter((c) => c.nodeType !== '');
  if (active.length === 0) return false;

  // Node matches if it satisfies ANY criterion (OR logic)
  return active.some((c) => {
    if (node.type !== c.nodeType) return false;
    if (!c.elementTypeId) return true; // "any element type"
    const opt = NODE_TYPE_MAP.get(c.nodeType);
    if (!opt?.propKey) return true;
    // Compare against both possible property keys for beams
    const v1 = String(node.properties[opt.propKey] ?? '');
    const v2 = opt.propKey === 'beam_type'
      ? String(node.properties.beam_section ?? '')
      : '';
    return v1 === c.elementTypeId || v2 === c.elementTypeId;
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface NodeMultiSelectFilterProps {
  nodes: BubbleGraphNode[];
  /** Called with matching node IDs when user confirms selection */
  onSelect: (ids: string[]) => void;
  /** Called when panel should close (ESC, Cancel, or after Select) */
  onClose: () => void;
  className?: string;
}

export function NodeMultiSelectFilter({
  nodes,
  onSelect,
  onClose,
  className,
}: NodeMultiSelectFilterProps) {
  const [criteria, setCriteria] = useState<Criterion[]>([newCriterion]);

  // ESC → close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const addCriterion = () => setCriteria((prev) => [...prev, newCriterion()]);

  const removeCriterion = (id: number) =>
    setCriteria((prev) => {
      const next = prev.filter((c) => c.id !== id);
      return next.length ? next : [newCriterion()];
    });

  const updateCriterion = useCallback(<K extends keyof Criterion>(id: number, field: K, value: Criterion[K]) => {
    setCriteria((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        // Reset element type when node type changes
        if (field === 'nodeType') return { ...c, nodeType: value as string, elementTypeId: '' };
        return { ...c, [field]: value };
      }),
    );
  }, []);

  // Live count of matching nodes
  const matchingIds = useMemo<string[]>(() => {
    const active = criteria.filter((c) => c.nodeType !== '');
    if (active.length === 0) return [];
    return nodes.filter((n) => nodeMatchesCriteria(n, active)).map((n) => n.id);
  }, [nodes, criteria]);

  const handleSelect = () => {
    onSelect(matchingIds);
    onClose();
  };

  const handleClear = () => {
    onSelect([]);
    onClose();
  };

  return (
    <div
      className={cn(
        'flex flex-col bg-background border border-border rounded-lg shadow-2xl overflow-hidden select-none',
        className,
      )}
      style={{ width: 560, maxHeight: '75vh' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-muted/40 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Multi-Select Filter</span>
          <span className="text-[10px] text-muted-foreground">select nodes by type and property</span>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-lg leading-none"
          title="Close (ESC)"
        >
          ×
        </button>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[1fr_1fr_28px] gap-2 px-4 pt-2 pb-1">
        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">Node Type</span>
        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">Element Type</span>
        <span />
      </div>

      {/* Criteria rows */}
      <div className="flex-1 overflow-y-auto px-4 pb-2 space-y-1.5">
        {criteria.map((c) => {
          const opt = c.nodeType ? NODE_TYPE_MAP.get(c.nodeType) : undefined;
          return (
            <div key={c.id} className="grid grid-cols-[1fr_1fr_28px] gap-2 items-center">
              {/* Node type selector */}
              <select
                className="bg-background border border-border rounded px-2 py-1 text-xs"
                value={c.nodeType}
                onChange={(e) => updateCriterion(c.id, 'nodeType', e.target.value)}
              >
                <option value="">— choose type —</option>
                {NODE_TYPE_OPTIONS.map((o) => (
                  <option key={o.type} value={o.type}>
                    {o.icon}  {o.label}
                  </option>
                ))}
              </select>

              {/* Element type selector */}
              {opt && opt.elementTypes.length > 0 ? (
                <select
                  className="bg-background border border-border rounded px-2 py-1 text-xs"
                  value={c.elementTypeId}
                  onChange={(e) => updateCriterion(c.id, 'elementTypeId', e.target.value)}
                >
                  <option value="">— any element type —</option>
                  {opt.elementTypes.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
              ) : (
                <div className="bg-muted/30 border border-border rounded px-2 py-1 text-xs text-muted-foreground">
                  {c.nodeType ? 'no subtypes' : '—'}
                </div>
              )}

              {/* Remove row */}
              <button
                onClick={() => removeCriterion(c.id)}
                className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors text-base"
                title="Remove criterion"
              >
                ×
              </button>
            </div>
          );
        })}

        {/* Add row button */}
        <button
          onClick={addCriterion}
          className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
        >
          <span className="text-base leading-none">+</span>
          <span>Add criterion</span>
        </button>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-muted/20 border-t border-border">
        <div className="text-xs text-muted-foreground">
          {matchingIds.length > 0 ? (
            <span>
              <span className="font-semibold text-foreground">{matchingIds.length}</span>{' '}
              {matchingIds.length === 1 ? 'node matches' : 'nodes match'}
            </span>
          ) : (
            <span>No matching nodes</span>
          )}
          <span className="ml-2 text-[10px]">· ESC to cancel</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleClear}
            className="px-3 py-1 text-xs rounded border border-border bg-background hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSelect}
            disabled={matchingIds.length === 0}
            className={cn(
              'px-4 py-1 text-xs rounded font-medium transition-colors',
              matchingIds.length > 0
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground cursor-not-allowed',
            )}
          >
            Select {matchingIds.length > 0 ? `${matchingIds.length} nodes` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
