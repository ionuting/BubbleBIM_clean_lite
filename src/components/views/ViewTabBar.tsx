/**
 * ViewTabBar — floating tab strip for the multi-viewer area.
 * Design: tabs sit on the header bar with top-accent underline for active state.
 * - Click to activate · Double-click to rename · Click × to close
 */
import { useState, useRef, useEffect } from 'react';
import { PictureInPicture2, X } from 'lucide-react';
import type { ViewTab, ViewTabType } from '@/store';
import { VIEW_TAB_LUCIDE } from '@/components/bubble-graph/CleanRibbon';
import { isDetachable } from '@/lib/detachedView';

const TAB_ICONS: Record<ViewTabType, string> = {
  'graph-editor':      '◈',
  '3d-model':          '⬡',
  'opengeo-3d':        '⬡',
  'opengeo-floorplan': '▦',
  'opengeo-section':   '✂',
  'opengeo-elevation': '↑',
  'floorplan':         '▦',
  'section':           '✂',
  'elevation':         '↑',
  'table':             '≡',
  'report':            '🧮',
  'sheet':             '▭',
  'terrain':           '🏔',
  'ifc-tiles':         '📦',
  'worldview':         '🌐',
  'ifc-plan':          '▦',
  'composer':          '◇',
  'fem':               '🏗',
  'topology':          '⋈',
};

interface ViewTabBarProps {
  tabs: ViewTab[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, label: string) => void;
  /** Use Lucide icons (Clean Lite / modern chrome). */
  useLucide?: boolean;
  /**
   * Pull this view into its own OS window (desktop build only). Absent in the
   * browser, where there is nowhere to put it.
   */
  onDetach?: (tab: ViewTab) => void;
  /** Tabs that already have a window of their own; ⧉ then focuses it. */
  detachedIds?: readonly string[];
}

export function ViewTabBar({
  tabs, activeTabId, onSelect, onClose, onRename, useLucide = false,
  onDetach, detachedIds,
}: ViewTabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  function startEdit(tab: ViewTab) {
    setEditingId(tab.id);
    setEditValue(tab.label);
  }

  function commitEdit() {
    if (editingId && editValue.trim()) onRename(editingId, editValue.trim());
    setEditingId(null);
  }

  return (
    <div className="bb-tabbar">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const LucideIcon = VIEW_TAB_LUCIDE[tab.type];
        const isDetached = !!detachedIds?.includes(tab.id);
        const canDetach = !!onDetach && isDetachable(tab.type);
        return (
          <div
            key={tab.id}
            className={`bb-tab${isActive ? ' active' : ''}${isDetached ? ' detached' : ''}`}
            onClick={() => onSelect(tab.id)}
            onDoubleClick={() => startEdit(tab)}
            title={tab.label}
          >
            {useLucide && LucideIcon ? (
              <LucideIcon className="tab-icon bb-ico" strokeWidth={1.75} />
            ) : (
              <span className="tab-icon">{TAB_ICONS[tab.type]}</span>
            )}

            {editingId === tab.id ? (
              <input
                ref={inputRef}
                style={{
                  background: 'hsl(var(--input))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 4,
                  padding: '1px 6px',
                  fontSize: 11,
                  width: 110,
                  outline: 'none',
                  color: 'hsl(var(--foreground))',
                }}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>
                {tab.label}
              </span>
            )}

            {canDetach && (
              <button
                className="tab-detach"
                onClick={(e) => { e.stopPropagation(); onDetach!(tab); }}
                title={isDetached
                  ? 'Vederea are deja fereastra ei — adu-o în față'
                  : 'Deschide vederea într-o fereastră proprie (⌘⇧D)'}
                style={{ opacity: isDetached ? 1 : undefined, color: isDetached ? 'hsl(var(--primary))' : undefined }}
              >
                <PictureInPicture2 className="bb-ico" strokeWidth={1.75} />
              </button>
            )}

            {tab.canClose && (
              <button
                className="tab-close"
                onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                title="Close"
              >
                {useLucide ? <X className="bb-ico" strokeWidth={2} /> : '×'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
