/**
 * CleanRibbon — BubbleBIM Professional contextual ribbon.
 * Groups change with view family; no placeholder actions.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Box,
  Building2,
  Columns2,
  DoorOpen,
  FileStack,
  Globe2,
  Grid3x3,
  Layers,
  Mountain,
  MousePointer2,
  PanelTop,
  PencilRuler,
  RectangleHorizontal,
  Scissors,
  SquareStack,
  Tent,
  X,
} from 'lucide-react';
import type { ViewTabType } from '@/store';
import { cn } from '@/lib/utils';

export interface CleanRibbonActions {
  onWindows: () => void;
  onDoors: () => void;
  onSelect: () => void;
  onClearSelection: () => void;
  onAxes: () => void;
  onMaterials: () => void;
  onAddStorey: () => void;
  onAddRoof?: () => void;
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

function groupsForView(type: ViewTabType | undefined, a: CleanRibbonActions): RibbonGroup[] {
  const relations: RibbonGroup = {
    id: 'relations',
    label: 'Relations',
    buttons: withClear(
      [
        { id: 'sel', label: a.selectionCount ? `Select (${a.selectionCount})` : 'Select', icon: MousePointer2, onClick: a.onSelect, active: a.selectActive, title: 'Multi-select filter' },
        { id: 'win', label: 'Windows', icon: RectangleHorizontal, onClick: a.onWindows, active: a.windowsActive, title: 'Window configurator' },
        { id: 'door', label: 'Doors', icon: DoorOpen, onClick: a.onDoors, active: a.doorsActive, title: 'Door configurator' },
      ],
      a,
    ),
  };

  const model: RibbonGroup = {
    id: 'model',
    label: 'Model',
    buttons: [
      { id: 'axes', label: 'Axes', icon: Grid3x3, onClick: a.onAxes, title: 'Building axes' },
      { id: 'mat', label: 'Materials', icon: Layers, onClick: a.onMaterials, title: 'Material config' },
      { id: 'storey', label: 'Storey', icon: SquareStack, onClick: a.onAddStorey, title: 'Add storey' },
      ...(a.onAddRoof
        ? [{ id: 'roof', label: 'Roof', icon: Tent, onClick: a.onAddRoof, title: 'Create complete roof (envelope + framing) from storey walls' } satisfies RibbonBtn]
        : []),
    ],
  };

  const draw: RibbonGroup = {
    id: 'draw',
    label: 'Draw',
    buttons: withClear(
      [
        { id: 'sel2', label: a.selectionCount ? `Select (${a.selectionCount})` : 'Select', icon: MousePointer2, onClick: a.onSelect, active: a.selectActive },
        { id: 'win2', label: 'Windows', icon: RectangleHorizontal, onClick: a.onWindows, active: a.windowsActive },
        { id: 'door2', label: 'Doors', icon: DoorOpen, onClick: a.onDoors, active: a.doorsActive },
        { id: 'sec', label: 'Section', icon: Scissors, onClick: a.onDrawSection, active: a.drawSectionActive, title: 'Draw section — two clicks on plan' },
        { id: 'secax', label: 'On axis', icon: Grid3x3, onClick: a.onSectionOnAxis, active: a.sectionOnAxisActive, title: 'Section along a grid line' },
      ],
      a,
    ),
  };

  const verify: RibbonGroup = {
    id: 'verify',
    label: 'Verify',
    buttons: [
      { id: 'og', label: '3D', icon: Box, onClick: a.onOpen3D, title: 'Open 3D view' },
      { id: 'mat3', label: 'Materials', icon: Layers, onClick: a.onMaterials },
    ],
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
      return [relations, model, verify];
    case '3d-model':
    case 'opengeo-3d':
      return [
        {
          id: 'nav',
          label: 'Navigate',
          buttons: withClear(
            [
              { id: 'sel3', label: a.selectionCount ? `Select (${a.selectionCount})` : 'Select', icon: MousePointer2, onClick: a.onSelect, active: a.selectActive },
              { id: 'mat4', label: 'Materials', icon: Layers, onClick: a.onMaterials },
            ],
            a,
          ),
        },
        model,
      ];
    case 'floorplan':
    case 'opengeo-floorplan':
      return [draw, model, verify];
    case 'section':
    case 'opengeo-section':
    case 'elevation':
    case 'opengeo-elevation':
      return [draw, model];
    case 'sheet':
      return [sheets, model];
    case 'worldview':
      return [
        {
          id: 'geo',
          label: 'Site',
          buttons: [
            { id: 'globe', label: 'World', icon: Globe2, onClick: a.onOpen3D, title: 'Stay in world / open 3D' },
            { id: 'mat5', label: 'Materials', icon: Layers, onClick: a.onMaterials },
          ],
        },
      ];
    case 'terrain':
      return [
        {
          id: 'terr',
          label: 'Terrain',
          buttons: [
            { id: 'mat6', label: 'Materials', icon: Layers, onClick: a.onMaterials },
            { id: 'og2', label: '3D', icon: Box, onClick: a.onOpen3D },
          ],
        },
      ];
    default:
      return [draw, model];
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
}

export function CleanRibbon({ viewType, viewLabel, actions }: CleanRibbonProps) {
  const groups = groupsForView(viewType, actions);
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
};
