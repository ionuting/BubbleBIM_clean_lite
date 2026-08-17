/**
 * CleanNavigator — BubbleBIM Professional left rail.
 * Zones: Project (storeys) · Views · Sheets.
 */
import { useState, type ReactNode } from 'react';
import {
  Box,
  Building2,
  Columns2,
  FileStack,
  FolderTree,
  Globe2,
  Grid3x3,
  Layers3,
  Mountain,
  PanelLeftClose,
  PanelTop,
  Scissors,
  SquareStack,
} from 'lucide-react';
import type { BubbleGraphNode, StoreyDiscipline, ViewTab } from '@/store';

const DISC_LABEL: Record<StoreyDiscipline, string> = {
  architectural: 'A',
  structural: 'S',
  mep: 'M',
};
const DISC_BG: Record<StoreyDiscipline, string> = {
  architectural: 'color-mix(in srgb, #3b82f6 18%, transparent)',
  structural: 'color-mix(in srgb, #f97316 18%, transparent)',
  mep: 'color-mix(in srgb, #22c55e 18%, transparent)',
};
const DISC_FG: Record<StoreyDiscipline, string> = {
  architectural: '#60a5fa',
  structural: '#fb923c',
  mep: '#4ade80',
};

function NavSection({
  icon: Icon,
  label,
  count,
  defaultOpen = false,
  children,
}: {
  icon: typeof FolderTree;
  label: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" className={`bb-section-btn${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <Icon className="bb-ico" strokeWidth={1.75} />
        <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
        {count !== undefined && count > 0 && <span className="bb-nav-badge">{count}</span>}
        <span className="chevron">▶</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

export interface CleanNavigatorProps {
  storeyNodes: BubbleGraphNode[];
  activeStoreyId: string | null;
  setActiveStoreyId: (id: string | null) => void;
  onEditStorey: (id: string) => void;
  onDuplicateStorey: (id: string) => void;
  onDeleteStorey: (id: string) => void;
  onOpenPlan: (storeyId: string, storeyName: string) => void;
  onOpen3D: () => void;
  onOpenSection: () => void;
  onSectionOnAxis: () => void;
  onOpenElevation: () => void;
  onOpenWorld: () => void;
  onOpenTerrain: () => void;
  onOpenSheet: () => void;
  /** Open a linear-elastic FEM model — a storey id, or `'all'` for the whole building. */
  onOpenFem: (storeyId: string, storeyName: string) => void;
  viewTabs: ViewTab[];
  activeTabId: string;
  setActiveTabId: (id: string) => void;
  closeViewTab: (id: string) => void;
  onCollapse?: () => void;
}

export function CleanNavigator({
  storeyNodes,
  activeStoreyId,
  setActiveStoreyId,
  onEditStorey,
  onDuplicateStorey,
  onDeleteStorey,
  onOpenPlan,
  onOpen3D,
  onOpenSection,
  onSectionOnAxis,
  onOpenElevation,
  onOpenWorld,
  onOpenTerrain,
  onOpenSheet,
  onOpenFem,
  viewTabs,
  activeTabId,
  setActiveTabId,
  closeViewTab,
  onCollapse,
}: CleanNavigatorProps) {
  const planCount = viewTabs.filter((t) => t.type === 'floorplan').length;
  const viewCount =
    planCount +
    viewTabs.filter((t) =>
      ['section', 'elevation', '3d-model', 'worldview', 'terrain'].includes(t.type),
    ).length;
  const sheetTabs = viewTabs.filter((t) => t.type === 'sheet');
  const femTabs = viewTabs.filter((t) => t.type === 'fem');

  return (
    <>
      <div className="bb-nav-head">
        <span>Navigator</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 500, letterSpacing: 0, textTransform: 'none', fontSize: 10.5 }}>
            {storeyNodes.length} storey{storeyNodes.length === 1 ? '' : 's'}
          </span>
          {onCollapse && (
            <button
              type="button"
              className="bb-dock-toggle"
              title="Hide navigator"
              aria-label="Hide navigator"
              onClick={onCollapse}
            >
              <PanelLeftClose size={14} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>

      <div className="bb-nav-scroll">
        <NavSection icon={SquareStack} label="Project" count={storeyNodes.length} defaultOpen>
          <button
            type="button"
            className={`bb-row${!activeStoreyId ? ' active' : ''}`}
            onClick={() => setActiveStoreyId(null)}
          >
            <Layers3 className="bb-ico" strokeWidth={1.75} />
            <span>All storeys</span>
          </button>
          {storeyNodes.length === 0 && (
            <div className="bb-empty-hint">
              No storeys yet. Set axes, then add a storey — double-click a storey to open its plan.
            </div>
          )}
          {storeyNodes.map((s) => {
            const disc = (s.properties.discipline as StoreyDiscipline) ?? 'architectural';
            const isActive = activeStoreyId === s.id;
            return (
              <div
                key={s.id}
                className={`bb-row${isActive ? ' active' : ''}`}
                style={{ paddingRight: 4 }}
                onClick={() => setActiveStoreyId(s.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onOpenPlan(s.id, s.name);
                }}
                title="Double-click to open plan"
              >
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    padding: '1px 4px',
                    borderRadius: 3,
                    background: DISC_BG[disc],
                    color: DISC_FG[disc],
                    flexShrink: 0,
                  }}
                >
                  {DISC_LABEL[disc]}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.name}
                </span>
                <div className="group-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" title="Open plan" onClick={() => onOpenPlan(s.id, s.name)}>
                    <PanelTop style={{ width: 11, height: 11 }} strokeWidth={1.75} />
                  </button>
                  <button type="button" title="Edit" onClick={() => onEditStorey(s.id)}>✎</button>
                  <button type="button" title="Duplicate" onClick={() => onDuplicateStorey(s.id)}>⧉</button>
                  <button type="button" className="danger" title="Delete" onClick={() => onDeleteStorey(s.id)}>✕</button>
                </div>
              </div>
            );
          })}
        </NavSection>

        <NavSection icon={FolderTree} label="Views" count={viewCount} defaultOpen>
          {storeyNodes.map((s) => {
            const tab = viewTabs.find(
              (t) => t.type === 'floorplan' && t.storeyId === s.id && (t.discipline ?? 'architectural') === 'architectural',
            );
            return (
              <button
                key={`plan-${s.id}`}
                type="button"
                className={`bb-row${tab && activeTabId === tab.id ? ' active' : ''}`}
                onClick={() => onOpenPlan(s.id, s.name)}
              >
                <PanelTop className="bb-ico" strokeWidth={1.75} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name} — Plan</span>
              </button>
            );
          })}
          {storeyNodes.length === 0 && (
            <div className="bb-empty-hint">Add a storey to open floor plans.</div>
          )}
          <button type="button" className="bb-row" onClick={onOpenSection}>
            <Scissors className="bb-ico" strokeWidth={1.75} />
            <span>Draw section</span>
          </button>
          <button type="button" className="bb-row" onClick={onSectionOnAxis}>
            <Grid3x3 className="bb-ico" strokeWidth={1.75} />
            <span>Section on axis</span>
          </button>
          <button type="button" className="bb-row" onClick={onOpenElevation}>
            <Columns2 className="bb-ico" strokeWidth={1.75} />
            <span>New elevation</span>
          </button>
          <button
            type="button"
            className={`bb-row${viewTabs.some((t) => t.type === '3d-model' && t.id === activeTabId) ? ' active' : ''}`}
            onClick={onOpen3D}
          >
            <Box className="bb-ico" strokeWidth={1.75} />
            <span>3D verify</span>
          </button>
          <button type="button" className="bb-row" onClick={onOpenWorld}>
            <Globe2 className="bb-ico" strokeWidth={1.75} />
            <span>World</span>
          </button>
          <button type="button" className="bb-row" onClick={onOpenTerrain}>
            <Mountain className="bb-ico" strokeWidth={1.75} />
            <span>Terrain</span>
          </button>
          {viewTabs
            .filter((t) => ['section', 'elevation', 'worldview', 'terrain', '3d-model'].includes(t.type))
            .map((tab) => (
              <div
                key={tab.id}
                className={`bb-row${activeTabId === tab.id ? ' active' : ''}`}
                onClick={() => setActiveTabId(tab.id)}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', paddingLeft: 4 }}>
                  {tab.label}
                </span>
                {tab.canClose && (
                  <div className="group-actions">
                    <button
                      type="button"
                      className="danger"
                      title="Close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeViewTab(tab.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            ))}
        </NavSection>

        {/* Structural (FEM) — linear-elastic self-weight + room live loads, see src/lib/fem/ */}
        <NavSection icon={Building2} label="Structural" count={femTabs.length}>
          {storeyNodes.length === 0 ? (
            <div className="bb-empty-hint">Add a storey to build a structural model.</div>
          ) : (
            <>
              {storeyNodes.length > 1 && (() => {
                const allTab = viewTabs.find((t) => t.type === 'fem' && t.storeyId === 'all');
                return (
                  <button
                    type="button"
                    className={`bb-row${allTab && activeTabId === allTab.id ? ' active' : ''}`}
                    style={{ fontWeight: 600 }}
                    title="Whole building — every storey stacked at its real elevation, columns continuous storey-to-storey"
                    onClick={() => onOpenFem('all', 'Whole building')}
                  >
                    <Building2 className="bb-ico" strokeWidth={1.75} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>Whole building</span>
                  </button>
                );
              })()}
              {storeyNodes.map((s) => {
                const tab = viewTabs.find((t) => t.type === 'fem' && t.storeyId === s.id);
                return (
                  <button
                    key={`fem-${s.id}`}
                    type="button"
                    className={`bb-row${tab && activeTabId === tab.id ? ' active' : ''}`}
                    title="Linear-elastic FEM model of this storey (columns/beams/walls/slabs)"
                    onClick={() => onOpenFem(s.id, s.name)}
                  >
                    <Layers3 className="bb-ico" strokeWidth={1.75} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name} — Structural</span>
                  </button>
                );
              })}
            </>
          )}
        </NavSection>

        <NavSection icon={FileStack} label="Sheets" count={sheetTabs.length} defaultOpen>
          <button type="button" className="bb-row" onClick={onOpenSheet}>
            <FileStack className="bb-ico" strokeWidth={1.75} />
            <span>New sheet</span>
          </button>
          {sheetTabs.length === 0 && (
            <div className="bb-empty-hint">Create a sheet to compose drawings for print.</div>
          )}
          {sheetTabs.map((tab) => (
            <div
              key={tab.id}
              className={`bb-row${activeTabId === tab.id ? ' active' : ''}`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <FileStack className="bb-ico" strokeWidth={1.75} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.label}</span>
              {tab.canClose && (
                <div className="group-actions">
                  <button
                    type="button"
                    className="danger"
                    title="Close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeViewTab(tab.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          ))}
        </NavSection>
      </div>
    </>
  );
}
