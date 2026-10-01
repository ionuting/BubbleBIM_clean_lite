/**
 * CleanRibbon — BubbleBIM Professional contextual ribbon.
 * Groups change with view family; no placeholder actions.
 */
import type React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Box,
  Building2,
  Columns2,
  FileStack,
  Globe2,
  Grid3x3,
  Mountain,
  MousePointer2,
  PanelTop,
  PencilRuler,
  RectangleHorizontal,
  Scissors,
  X,
  Network,
} from 'lucide-react';
import type { ViewTabType } from '@/store';
import { cn } from '@/lib/utils';

export interface CleanRibbonActions {
  onWindows: () => void;
  onDoors: () => void;
  onSelect: () => void;
  onClearSelection: () => void;
  onAxes: () => void;
  /** Graph canvas Grid mode toggle (axes as lines, on-canvas axis editing). */
  onGridMode?: () => void;
  gridModeActive?: boolean;
  onMaterials: () => void;
  /** Architectural style — parametric rules applied to the graph. */
  onStyle?: () => void;
  onAddStorey: () => void;
  onAddRoof?: () => void;
  onAddStairwell?: () => void;
  onAddSweep?: () => void;
  onAddDome?: () => void;
  onAddDomeEntrance?: () => void;
  onAddSite?: () => void;
  onOpen3D: () => void;
  onOpenSheet: () => void;
  onDrawSection: () => void;
  onSectionOnAxis: () => void;
  drawSectionActive: boolean;
  sectionOnAxisActive: boolean;
  windowsActive: boolean;
  doorsActive: boolean;
  selectActive: boolean;
  selectionCount: number;
}

interface RibbonBtn {
  id: string;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  active?: boolean;
  title?: string;
  danger?: boolean;
}

interface RibbonGroup {
  id: string;
  label: string;
  buttons: RibbonBtn[];
}

function withClear(btns: RibbonBtn[], a: CleanRibbonActions): RibbonBtn[] {
  if (a.selectionCount > 0 && !a.selectActive) {
    return [
      ...btns,
      { id: 'clear', label: 'Clear', icon: X, onClick: a.onClearSelection, title: 'Clear selection', danger: true },
    ];
  }
  return btns;
}

/**
 * The context bar holds what you DO in the view in front — select, cut a
 * section, start a sheet. What you ADD is a node, and nodes come from the
 * graph's node list; how the project is SET UP (axes, storeys, grid) lives in
 * the graph's own toolbar, in order; what the project is CONFIGURED with
 * (windows, doors, materials, style) lives in the project configuration panel.
 * So none of those repeat here.
 */
function groupsForView(type: ViewTabType | undefined, a: CleanRibbonActions): RibbonGroup[] {
  const select = (id: string): RibbonBtn => ({
    id, label: a.selectionCount ? `Select (${a.selectionCount})` : 'Select', icon: MousePointer2,
    onClick: a.onSelect, active: a.selectActive, title: 'Multi-select filter',
  });

  const draw: RibbonGroup = {
    id: 'draw',
    label: 'Draw',
    buttons: withClear(
      [
        select('sel2'),
        { id: 'sec', label: 'Section', icon: Scissors, onClick: a.onDrawSection, active: a.drawSectionActive, title: 'Draw section — two clicks on plan' },
        { id: 'secax', label: 'On axis', icon: Grid3x3, onClick: a.onSectionOnAxis, active: a.sectionOnAxisActive, title: 'Section along a grid line' },
      ],
      a,
    ),
  };

  const sheets: RibbonGroup = {
    id: 'sheets',
    label: 'Sheets',
    buttons: [
      { id: 'sheet', label: 'New sheet', icon: FileStack, onClick: a.onOpenSheet, title: 'Create a new sheet' },
    ],
  };

  switch (type) {
    case 'graph-editor':
      // The graph has its own toolbar (setup steps, bridges) and selects by clicking.
      return [];
    case '3d-model':
    case 'opengeo-3d':
      return [{ id: 'nav', label: 'Navigate', buttons: withClear([select('sel3')], a) }];
    case 'floorplan':
    case 'opengeo-floorplan':
    case 'section':
    case 'opengeo-section':
    case 'elevation':
    case 'opengeo-elevation':
      return [draw];
    case 'sheet':
      return [sheets];
    case 'worldview':
    case 'terrain':
      return [];
    default:
      return [draw];
  }
}

const VIEW_LABEL: Partial<Record<ViewTabType, string>> = {
  'graph-editor': 'Model',
  '3d-model': '3D',
  'opengeo-3d': '3D',
  'opengeo-floorplan': 'Plan',
  'opengeo-section': 'Section',
  'opengeo-elevation': 'Elevation',
  floorplan: 'Plan',
  section: 'Section',
  elevation: 'Elevation',
  sheet: 'Sheet',
  worldview: 'World',
  terrain: 'Terrain',
};

interface CleanRibbonProps {
  viewType?: ViewTabType;
  viewLabel?: string;
  actions: CleanRibbonActions;
  /** Controls of the view itself (its drawing engine and graphic style), after the tools. */
  extra?: React.ReactNode;
}

export function CleanRibbon({ viewType, viewLabel, actions, extra }: CleanRibbonProps) {
  const groups = groupsForView(viewType, actions);
  // A view with nothing to do here (the world, the terrain modeller with its own tools) gets no bar.
  if (!groups.length && !extra) return null;
  const contextLabel = viewLabel ?? (viewType ? VIEW_LABEL[viewType] : undefined) ?? 'Workspace';

  return (
    <div className="bb-tools bb-ribbon" role="toolbar" aria-label="Contextual ribbon">
      {groups.map((g, gi) => (
        <div key={g.id} className="bb-ribbon-group">
          {gi > 0 && <div className="bb-sep" />}
          <span className="bb-tools-label">{g.label}</span>
          <div className="bb-ribbon-btns">
            {g.buttons.map((b) => {
              const Icon = b.icon;
              return (
                <button
                  key={b.id}
                  type="button"
                  className={cn('bb-btn bb-ribbon-btn', b.active && 'active', b.danger && 'danger')}
                  onClick={b.onClick}
                  title={b.title ?? b.label}
                >
                  <Icon className="bb-ico" strokeWidth={1.75} />
                  <span>{b.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {extra}
      <span className="bb-ribbon-context">{contextLabel}</span>
    </div>
  );
}

/** Lucide icon map for view tabs (Clean Lite). */
export const VIEW_TAB_LUCIDE: Record<ViewTabType, LucideIcon> = {
  'graph-editor': Grid3x3,
  '3d-model': Box,
  'opengeo-3d': Box,
  'opengeo-floorplan': PanelTop,
  'opengeo-section': Scissors,
  'opengeo-elevation': Columns2,
  floorplan: PanelTop,
  section: Scissors,
  elevation: Columns2,
  table: Grid3x3,
  report: Grid3x3,
  sheet: RectangleHorizontal,
  terrain: Mountain,
  'ifc-tiles': Box,
  worldview: Globe2,
  'ifc-plan': PanelTop,
  composer: PencilRuler,
  fem: Building2,
  topology: Network,
};
