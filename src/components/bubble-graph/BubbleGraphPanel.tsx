/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BubbleGraphPanel — visual relational building-graph editor ported from
 * webBubbleBIM / ModernGraphEditor and adapted for ifc-lite.
 *
 * Key ifc-lite integrations:
 *  - Storey nodes → automatic `ViewDefinition` (floor plan) in viewsSlice
 *  - State persisted in bubbleGraphSlice (Zustand)
 *  - GraphML export/import (feed into graphmlBuilderNode in NodeEditor)
 *  - Uses ifc-lite CSS variables (--bg-dark, --border, etc.)
 */

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Maximize2, Minimize2,
  MousePointer2, Circle, Minus, ChevronLeft, ChevronRight, PanelRightClose,
  Grid3x3, Combine, Calculator, FlaskConical, Scissors,
  RectangleHorizontal, DoorOpen, Layers, Palette, BookMarked, House, Building2, Shapes,
  Share2, Layers3, PanelTop, Box, Columns2, Globe2, Mountain, Table2, FileStack, Folder, Package,
} from 'lucide-react';
import { CleanRibbon } from '@/components/bubble-graph/CleanRibbon';
import { ProjectBrowser, type TreeItem } from '@/components/bubble-graph/shell/ProjectBrowser';
import { NewViewDialog, type NewViewRequest } from '@/components/bubble-graph/shell/NewViewDialog';
import {
  DEFAULT_ENGINE, duplicateView, newViewId, syncViews, tabTypeOf, uniqueViewName, type DrawingEngine, type DrawingView,
} from '@/lib/views/drawingViews';
import { GRAPHIC_STYLE_IDS, GRAPHIC_STYLES, type GraphicStyleId } from '@/lib/drawing/graphicStyle';
import { HudBar, HudMenu, HudPopover, type MenuItem } from '@/components/bubble-graph/shell/HudBar';
import { CommandPalette, type ShellCommand } from '@/components/bubble-graph/shell/CommandPalette';
import { ProjectConfigPanel, type ConfigGroup } from '@/components/bubble-graph/shell/ProjectConfigPanel';
import { VersionControl } from '@/components/bubble-graph/shell/VersionControl';
import { readAppliedStyle } from '@/lib/style/engine';
import { STYLE_PACK_MAP } from '@/lib/style/packs';
import { capabilitiesFor } from '@/components/bubble-graph/shell/capabilities';
import { isTypingTarget, modesFor, type ShellMode } from '@/components/bubble-graph/shell/modes';
import { cn, parseAxes } from '@/lib/utils';
import { useBubbleGraphStore } from '@/store';
import type {
  BubbleGraphNode, BubbleGraphEdge, BuildingAxes, StoreyDiscipline, ViewTab, Viewer3DType,
} from '@/store';
import { isDetachable, type GraphBroadcast } from '@/lib/detachedView';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ProjectsDialog } from '@/components/bubble-graph/ProjectsDialog';
import { getGeometriesByFamily } from './geometryResolver';
import { isCancelled, pushGraphToArchicad } from '@/lib/archicad/browserPush';
import { buildIfcModel } from '@/lib/ifc/buildIfcModel';
import { exportGeoreference } from '@/lib/geo';
import { safeFilename } from '@/lib/download';
import { IfcLiveSyncClient, type LiveSyncStatus } from '@/lib/ifc/liveSync';
import { QuestPanel } from './QuestPanel';
import { generateRoomGrid, planJoinRooms } from '@/lib/roomGrid/roomGrid';
import { useUndoableGraphState } from '@/hooks/useUndoableGraphState';
import { computeLastFloorBand } from '@/lib/storeys/lastFloor';
import { buildDefaultProjectNodes, DEFAULT_PROJECT_AXES, LAST_FLOOR_HEIGHT_MM } from '@/lib/storeys/defaultProject';
import { saveGraph, loadGraph, commitHistory } from '@/lib/api';
import type { GraphData } from '@/lib/api';
import { HistoryPanel } from './HistoryPanel';
import {
  serializeProject, deserializeProject, downloadProject, openProjectFile, sanitizeViewTabs,
} from '@/lib/projectFile';
import { ChatPanel } from './ChatPanel';
import { ObjectLibraryPanel } from '@/components/ui/ObjectLibraryPanel';
import { SymbolConfigPanel } from '@/components/ui/SymbolConfigPanel';
import type { ObjectLibraryEntry } from '@/lib/useObjectLibrary';
import nodeLibraryData from './nodeLibrary.json';
import { toast } from '@/components/ui/toast';
import { listLoadedIfc } from '@/lib/loadedIfcRegistry';
import type { ProjectData } from '@/electron.d';
import { ViewTabBar } from '@/components/views/ViewTabBar';
import { WebIfcViewer } from '@/components/views/WebIfcViewer';
import { OpenGeoViewer } from '@/components/views/OpenGeoViewer';
import { BrepViewer } from '@/components/views/BrepViewer';
import { FemViewer } from '@/components/views/FemViewer';
import { TopologyView } from '@/components/views/TopologyView';
import { ROOM_LOAD_LABELS, DEFAULT_ROOM_LOAD_CATEGORY } from '@/lib/fem/femLoads';
import { OGFloorPlanViewer, OGSectionViewer, OGElevationViewer } from '@/components/views/OGFloorPlanViewer';
import { ProfileEditor } from '@/components/profile-editor/ProfileEditor';
import type { ProfileDraft } from '@/lib/profileDraft';
import { TechnicalDrawingsViewer } from '@/components/views/TechnicalDrawingsViewer';
import { FloorPlan2DViewer } from '@/components/views/FloorPlan2DViewer';
import { Section2DViewer } from '@/components/views/Section2DViewer';
import { DEFAULT_CUT_DEPTH_MM, parseDepthMode, parseLookSide, parsePlanCut, resolveSectionCut } from '@/lib/sectionFromPlan';
import { Elevation2DViewer } from '@/components/views/Elevation2DViewer';
// OBC ortho viewers kept for OG 2D Views tab only
import { FloorPlanOrthoViewer } from '@/components/views/FloorPlanOrthoViewer';
import { ElevationOrthoViewer } from '@/components/views/ElevationOrthoViewer';
import { SectionOrthoViewer } from '@/components/views/SectionOrthoViewer';
import { PlaceholderView } from '@/components/views/PlaceholderView';
import { SheetComposer } from '@/components/views/SheetComposer';
import { WorldViewer } from '@/components/views/WorldViewer';
import { IFCPlanView } from '@/components/views/IFCPlanView';
import { TerrainViewer } from '@/components/views/TerrainViewer';
import { IFCTilesViewer } from '@/components/views/IFCTilesViewer';
import { useModelIfc } from '@/lib/ifc/useModelIfc';
import { createSiteNode } from '@/lib/terrain/siteNode';
import { ComposerCanvas } from '@/components/views/ComposerCanvas';
import { MaterialConfigEditor } from '@/components/views/MaterialConfigEditor';
import { StyleDialog } from '@/components/views/StyleDialog';
import { WindowConfigurator } from '@/components/configurators/WindowConfigurator';
import { NodeMultiSelectFilter } from './NodeMultiSelectFilter';
import { WorkflowHelpPanel } from './WorkflowHelpPanel';
import { DoorConfigurator } from '@/components/configurators/DoorConfigurator';
import { WINDOW_TYPE_MAP, DOOR_TYPE_MAP } from '@/lib/elementLibrary';
import { useLibraryTypes } from '@/lib/useLibraryTypes';
import type { WindowType, DoorType } from '@/lib/elementLibrary';
import { getMaterialConfigSync, useMaterialConfig } from '@/lib/useMaterialConfig';
import { safeEval, parseArrayProp, isArrayExpr, resolveFormulaContext, evalProp } from '@/lib/formulaUtils';
import { deriveQuantities, isDerivedKey, quantityVars, stampDerivedQuantities } from '@/lib/quantityTakeoff/derivedQuantities';
import type { FormulaVars } from '@/lib/formulaUtils';
import { calcRoomPolygon, calcRoomParametricGrid, type RoomParametricGrid, parseContourOffsets, insetPolygon, getAxRealPos, getConnectedNodesWithGrips, parseWallThickness } from '@/lib/bimGeometry';
import {
  canvasToBim, storeyFrame, applyGridEdit, linkedStoreys, axisDeltaBounds, cellOffsetBounds, roundToSnap,
  GRID_MIN_GAP_MM, GRID_SNAP_MM, DEFAULT_SPAN_EDIT_MODE, type GridEdit, type GridScope,
} from '@/lib/grid/axisEdit';
import { buildGridLayout, gridHitTest, screenToWorld, worldToScreen, type AxisLine, type CellHandle } from '@/lib/grid/gridLayout';
import { drawGridMode, type GridHover } from '@/lib/grid/gridRender';
import {
  wallOpenings, placeOpening, openingHitTest, wallChips, wallChipHitTest, patchOpening, removeOpening,
  addOpening, setHasOpenings, offsetKeyFor, offsetForCentre, sameOpeningRef,
  type GridWall, type OpeningPlacement, type OpeningRef,
} from '@/lib/grid/openings';
import { HUB_TYPES, annotateEdgeTypes } from '@/lib/graph/edgeTypes';
import {
  parseStructuralSystem, resolveStructuralSystem, STRUCTURAL_SYSTEMS,
  STRUCTURAL_SYSTEM_LABELS, STRUCTURAL_SYSTEM_HINTS, SYSTEM_PROPERTY_KEY,
  type StructuralSystem,
} from '@/lib/systems/structuralSystem';
import {
  COVERING_PRESETS, DEFAULT_COVERING_HEIGHT_MM, DEFAULT_COVERING_THICKNESS_MM, DEFAULT_ROOM_HEIGHT_MM,
  getEditableCoveringLayers, getRoomHeightMm, scaleCoveringPreset, serializeCoveringLayers,
  syncCoveringSummaryProps, type RoomCoveringLayer,
} from '@/lib/roomCovering';
import {
  WALL_LAYER_PRESETS, DEFAULT_WALL_HEIGHT_MM, getEditableWallLayers, getWallHeightMm,
  scaleWallLayerPreset, serializeWallLayers, type WallLayer,
} from '@/lib/wallLayers';
import { solveRoof, applyRoofResult, createRoofForStorey } from '@/lib/roof';
import { solveStair, applyStairResult, createStairwellForStorey } from '@/lib/stair';
import {
  computeSweep, ensureProfileLibraryLoaded, listProfileOptions,
  PARAMETRIC_PROFILES, profileSvgPath,
  sweepRole, SWEEP_ROLES, SWEEP_ROLE_LABELS, SWEEP_ROLE_HINTS,
  DETAIL_TYPE_MAP, detailTypeProperties, detailTypesForRole,
} from '@/lib/sweep';
import { computeSketch, resolveSketchFrame, setSketchRefs, sketchOutline, sketchPathReader, SKETCH_DEFAULT_IFC_TYPE, SKETCH_PROFILE_PREFIX } from '@/lib/sketch';
import { pointInPolygon, polygonArea } from '@/lib/geom/plan2d';
import { computeScatter, parseScatterKind, SCATTER_KINDS, SCATTER_KIND_LABELS, SCATTER_KIND_DEFAULTS } from '@/lib/scatter';
import { computeFacade, FACADE_PATTERNS, FACADE_PATTERN_LABELS, FACADE_PANEL_KINDS, FACADE_PANEL_KIND_LABELS } from '@/lib/facade';
import { useArmare } from '@/store/armareStore';
import { computeDome } from '@/lib/dome';
import { computeSite, findSiteNode, slopeRatio } from '@/lib/terrain';
import { subscribeBglibStore } from '@/lib/bglibSymbolStore';
import { useAutoRegenerateStairs } from '@/hooks/useAutoRegenerateStairs';
import { QuantitiesPanel } from '@/components/quantities/QuantitiesPanel';
import { ReportTabView } from '@/components/quantities/ReportTabView';
import { CostFloatingPanel } from '@/components/quantities/CostFloatingPanel';
import { DashboardPanel } from '@/components/quantities/DashboardPanel';
import { computeFullTakeoff } from '@/lib/quantityTakeoff';
import { setTakeoffContext } from '@/lib/quantityTakeoff/takeoffContext';
import { CLIMATE, DEFAULT_SITE } from '@/lib/energy/heating';
import { distToSegment, pickBestHit, type HitCandidate } from '@/lib/graph/pickHit';
import { LibraryPanel } from '@/components/library/LibraryPanel';
import { ZoneSpecField } from '@/components/zones/ZoneSpecField';
import { ShellZonesEditor } from '@/components/zones/ShellZonesEditor';
import { ScenarioBar } from '@/components/scenarios/ScenarioBar';
import { CURRENCY } from '@/store/priceStore';
import { CompareFloatingPanel } from '@/components/scenarios/CompareFloatingPanel';
import { useScenarioResults } from '@/hooks/useScenarioResults';
import { useScenarios, exportScenarios, importScenarios } from '@/store/scenarioStore';
import { applyScenario } from '@/lib/scenarios/scenario';
import { adaptGraphToSystem, isNativeWallType, profileFor, summaryChanged } from '@/lib/systems/profiles';
import { parseSpecSelection, specGroupsFor, type SpecSelection } from '@/lib/norms/specs';
import { SpecPicker } from '@/components/systems/SpecPicker';
import { SystemAdaptBanner } from '@/components/systems/SystemAdaptBanner';
import { SHELL_ROLES, SHELL_ROLE_HINTS, SHELL_ROLE_LABELS, envelopeMissing, shellRole } from '@/lib/shell/region';
import type { EconomySnapshot } from '@/lib/quests/economist';

// ─── Types ────────────────────────────────────────────────────────────────

interface NodeType {
  id: string;
  label: string;
  category: string;
  color: string;
  description: string;
  defaultProperties: Record<string, unknown>;
}

interface Category {
  id: string;
  label: string;
  description: string;
  icon: string;
  color: string;
}

type InteractionMode = 'select' | 'addNode' | 'addEdge';
type EdgePlacementType = 'simple' | 'wall' | 'beam';

/**
 * "Hub" nodes (room, roof, slab, …) define a polygon by fanning edges out to
 * many ax corners. When one is the edge anchor, continuous connect keeps the
 * SAME anchor so you can click corner after corner (press Enter to finish),
 * instead of re-picking the hub each time.
 *
 * `HUB_TYPES` is imported from lib/graph/edgeTypes rather than redeclared here:
 * the same set decides which edges are `bounds` relations, so the editor's idea
 * of a hub and the graph's relation semantics cannot drift apart.
 */

// ─── Constants ────────────────────────────────────────────────────────────

const NODE_LIBRARY: { categories: Category[]; nodeTypes: NodeType[] } =
  nodeLibraryData as { categories: Category[]; nodeTypes: NodeType[] };

const NODE_COLORS: Record<string, string> = Object.fromEntries(
  NODE_LIBRARY.nodeTypes.map((nt) => [nt.id, nt.color]),
);

const MM_TO_PX = 0.05; // 1 mm = 0.05 canvas pixels
/** Radius (canvas px) of the room grab-handle drawn at the polygon centroid.
 *  Keeps the room node visible & clickable so its contour can keep growing. */
const ROOM_HANDLE_R = 14;

// ─── Ax node column-grip helpers ──────────────────────────────────────────────
/** Visual display scale for ax nodes — multiplies physical px size so grips are easy to click. */
const AX_D = 2;
/** Parse column type string (cm notation) → half-dimensions in mm graph units.
 *  C25x25 → hw=125, hd=125   C30x50 → hw=150, hd=250   CR30 → hw=hd=150 */
function parseColHalfDims(colType: string): { hw: number; hd: number } {
  const rect = colType.match(/^[Cc](\d+)x(\d+)$/);
  if (rect) return { hw: Number(rect[1]) * 5, hd: Number(rect[2]) * 5 };
  const circ = colType.match(/^[Cc][Rr](\d+)$/);
  if (circ) { const r = Number(circ[1]) * 5; return { hw: r, hd: r }; }
  return { hw: 125, hd: 125 }; // default C25×25
}

/** 9 grip points for an ax node in graph-mm units.
 *  Layout (plan view, Y-up):
 *    6──7──8      (top row)
 *    4──0──5      (middle)
 *    1──2──3      (bottom row)
 */
function axGrips(n: BubbleGraphNode): { x: number; y: number }[] {
  const { hw, hd } = parseColHalfDims((n.properties.column_type as string) ?? 'C25x25');
  const cx = n.x, cy = n.y;
  return [
    { x: cx,      y: cy      }, // 0 center
    { x: cx - hw, y: cy - hd }, // 1 bottom-left
    { x: cx,      y: cy - hd }, // 2 bottom-center
    { x: cx + hw, y: cy - hd }, // 3 bottom-right
    { x: cx - hw, y: cy      }, // 4 left
    { x: cx + hw, y: cy      }, // 5 right
    { x: cx - hw, y: cy + hd }, // 6 top-left
    { x: cx,      y: cy + hd }, // 7 top-center
    { x: cx + hw, y: cy + hd }, // 8 top-right
  ];
}

/** Resolve the actual edge endpoint position (mm graph units) for a node.
 *  For ax nodes, uses grip index (0=center). For all others, returns node position. */
function edgeNodePos(n: BubbleGraphNode, grip?: number): { x: number; y: number } {
  if (n.type === 'ax' && grip != null && grip !== 0) {
    return axGrips(n)[grip] ?? { x: n.x, y: n.y };
  }
  return { x: n.x, y: n.y };
}

// ─── FormulaInput ─────────────────────────────────────────────────────────
/**
 * Enhanced numeric input that accepts math expressions (e.g. "1000*3", "2500+500",
 * "PI*200", "room_area * 50") and evaluates them on blur / Enter.
 * Turns amber when a valid formula is present; red border on bad syntax.
 * Passes numeric result to onChange — keeps intermediate typing state.
 *
 * Optional `ctx` prop injects topology context variables (wall_length, room_area, etc.)
 * for formula resolution. When present a live tooltip shows the resolved value.
 */
function FormulaInput({
  value, step = 1, onChange, className = '', placeholder, ctx,
}: {
  value: number; step?: number; onChange: (v: number) => void;
  className?: string; placeholder?: string;
  /** Optional BIM topology context for resolving context variables. */
  ctx?: FormulaVars;
}) {
  const [display, setDisplay] = useState(String(isNaN(value) ? 0 : value));
  const [isFormula, setIsFormula] = useState(false);
  const [isError,   setIsError]   = useState(false);

  // Sync inward when parent changes and we're not mid-edit
  useEffect(() => {
    if (isNaN(value)) return;
    const local = safeEval(display, ctx);
    if (isNaN(local) || Math.abs(local - value) > 1e-9) {
      setDisplay(String(value));
      setIsFormula(false);
      setIsError(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    const result  = safeEval(trimmed, ctx);
    const looksLikeFormula = /[+\-*/()a-zA-Z_]/.test(trimmed) && trimmed !== '';
    if (!isNaN(result)) {
      setDisplay(String(result));
      setIsFormula(false);
      setIsError(false);
      onChange(result);
    } else if (looksLikeFormula) {
      setIsError(true);
    }
  };

  // Build tooltip: show resolved value + live context vars when formula
  const resolvedVal = safeEval(display, ctx);
  const hasCtxVars  = ctx && Object.keys(ctx).length > 0;
  const tooltipLines: string[] = [];
  if (isFormula && !isNaN(resolvedVal)) {
    tooltipLines.push(`= ${resolvedVal.toLocaleString('ro-RO', { maximumFractionDigits: 3 })}`);
  }
  if (isError) tooltipLines.push('⚠ Invalid expression');
  if (hasCtxVars && (isFormula || display.includes('_'))) {
    tooltipLines.push('─── Context disponibil ───');
    for (const [k, v] of Object.entries(ctx!)) {
      if (typeof v === 'number' && !isNaN(v as number))
        tooltipLines.push(`${k} = ${(v as number).toLocaleString('ro-RO', { maximumFractionDigits: 2 })}`);
    }
  }
  const tooltip = tooltipLines.length ? tooltipLines.join('\n') : undefined;

  return (
    <input
      type="text"
      step={step}
      placeholder={placeholder}
      className={cn(
        'bg-background border rounded px-1.5 py-0.5 text-xs font-mono transition-colors',
        isError   ? 'border-red-500 text-red-500'
        : isFormula ? 'border-amber-400 text-amber-600 dark:text-amber-400'
        : 'border-border',
        className,
      )}
      value={display}
      title={tooltip}
      onChange={(e) => {
        const raw = e.target.value;
        setDisplay(raw);
        const looksLikeFormula = /[+\-*/()a-zA-Z_]/.test(raw);
        setIsFormula(looksLikeFormula && !isNaN(safeEval(raw, ctx)));
        setIsError(false);
        // Emit live if plain number
        const n = parseFloat(raw);
        if (!isNaN(n) && !looksLikeFormula) onChange(n);
        // Emit live if formula resolves
        if (looksLikeFormula) {
          const ev = safeEval(raw, ctx);
          if (!isNaN(ev)) onChange(ev);
        }
      }}
      onBlur={(e)  => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
    />
  );
}

/** Legacy alias so existing NumInput usages keep working without changes. */
const NumInput = FormulaInput;

// ─── Helpers ──────────────────────────────────────────────────────────────

function getNodeTypeData(id: string): NodeType | undefined {
  return NODE_LIBRARY.nodeTypes.find((n) => n.id === id);
}

/** Category names for the browser's Families folder (Revit's "Families"). */
const FAMILY_LABEL_RO: Record<string, string> = {
  wall: 'Pereți', window: 'Ferestre', door: 'Uși', slab: 'Plăci', column: 'Stâlpi', beam: 'Grinzi',
  foundation: 'Fundații', roof: 'Acoperișuri', room: 'Încăperi', shell: 'Straturi exterioare',
  covering: 'Finisaje', stairwell: 'Scări', sweep: 'Profile (sweep)', sketch: 'Schițe', dormer: 'Lucarne',
  skylight: 'Ferestre de acoperiș', site: 'Teren', dome: 'Cupole', facade: 'Fațade cortină',
  object: 'Obiecte din bibliotecă', scatter: 'Vegetație și pietre', void: 'Goluri',
};
/** Node types that are structure of the browser itself, not elements. */
const NOT_A_FAMILY = new Set(['ax', 'storey', 'section', 'view', 'cell']);

/** What tells one type of a category from another: wall_type, window_type… or the role, the material. */
function familyTypeOf(n: BubbleGraphNode): string {
  const p = n.properties ?? {};
  for (const k of [`${n.type}_type`, 'element_type', 'sweep_role', 'dormer_type', 'material']) {
    const v = p[k];
    if (v != null && String(v).trim() !== '') return String(v);
  }
  return '—';
}

function uid(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// ── GraphML: the graph as a plain interchange file ──────────────────────────

function graphMLText(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<graphml xmlns="http://graphml.graphdrawing.org/xmlns">\n  <graph id="G" edgedefault="undirected">\n';
  nodes.forEach((n) => {
    xml += `    <node id="${n.id}">\n`;
    xml += `      <data key="type">${n.type}</data>\n`;
    xml += `      <data key="name">${n.name}</data>\n`;
    xml += `      <data key="x">${n.x}</data>\n`;
    xml += `      <data key="y">${n.y}</data>\n`;
    xml += `      <data key="z">${n.z}</data>\n`;
    if (n.parentId) xml += `      <data key="parentId">${n.parentId}</data>\n`;
    Object.entries(n.properties).forEach(([k, v]) => {
      xml += `      <data key="${k}">${Array.isArray(v) ? v.join(',') : v}</data>\n`;
    });
    xml += '    </node>\n';
  });
  edges.forEach((e) => {
    xml += `    <edge id="${e.id}" source="${e.from}" target="${e.to}"/>\n`;
  });
  return xml + '  </graph>\n</graphml>';
}

function parseGraphML(text: string): { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const nodes: BubbleGraphNode[] = [];
  for (const el of Array.from(doc.getElementsByTagName('node'))) {
    const id = el.getAttribute('id') ?? `node_${uid()}`;
    const n: BubbleGraphNode = { id, type: '', name: '', x: 0, y: 0, z: 0, properties: {} };
    for (const d of Array.from(el.getElementsByTagName('data'))) {
      const k = d.getAttribute('key'), v = d.textContent ?? '';
      if (k === 'type') n.type = v;
      else if (k === 'name') n.name = v;
      else if (k === 'x') n.x = parseFloat(v);
      else if (k === 'y') n.y = parseFloat(v);
      else if (k === 'z') n.z = parseFloat(v);
      else if (k === 'parentId') n.parentId = v;
      else if (k) n.properties[k] = v;
    }
    nodes.push(n);
  }
  const edges: BubbleGraphEdge[] = Array.from(doc.getElementsByTagName('edge')).map((el) => ({
    id: el.getAttribute('id') ?? `edge_${uid()}`,
    from: el.getAttribute('source') ?? '',
    to: el.getAttribute('target') ?? '',
  }));
  return { nodes, edges };
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/**
 * useAutoSave: Automatically save graph to backend at intervals
 * Debounces updates to avoid spamming the backend
 */
function useAutoSave(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  buildingAxes: BuildingAxes,
  projectName: string,
  structuralSystem: StructuralSystem,
  isLoaded: boolean,
  interval = 10000,
) {
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaveRef = useRef<number>(0);
  const hasMountedRef = useRef(false);
  const latestDataRef = useRef({ nodes, edges, buildingAxes, projectName, structuralSystem });
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Subscribed (not getState()) so opening/closing/switching a drawing tab
  // actually SCHEDULES a save — those don't touch nodes/edges, so without
  // this the whole drawing workspace was silently never persisted.
  const viewTabs = useBubbleGraphStore((s) => s.viewTabs);
  const activeTabId = useBubbleGraphStore((s) => s.activeTabId);

  // Keep ref in sync with latest props without triggering effects
  useEffect(() => {
    latestDataRef.current = { nodes, edges, buildingAxes, projectName, structuralSystem };
  });

  const performSave = useCallback(async () => {
    const { nodes: n, edges: e, buildingAxes: ba, projectName: pn, structuralSystem: sys } = latestDataRef.current;
    const annotations = useBubbleGraphStore.getState().annotations;
    const drawingViews = useBubbleGraphStore.getState().drawingViews;
    const worldLocation = useBubbleGraphStore.getState().worldLocation;
    const globeInstances = useBubbleGraphStore.getState().globeInstances;
    const composerShapes = useBubbleGraphStore.getState().composer.shapes;
    // Open drawing tabs (plans/sections/elevations) — same sanitising the .bbim
    // file save applies, so the drawing workspace survives a reload identically
    // on both save paths.
    const viewTabs = sanitizeViewTabs(useBubbleGraphStore.getState().viewTabs);
    const activeTabId = useBubbleGraphStore.getState().activeTabId;
    // Never overwrite backend with an empty graph caused by stale state on mount
    if (n.length === 0 && e.length === 0) return;
    try {
      setIsSaving(true);
      setSaveError(null);
      // Backfill relation types on the way out, so what lands on disk is typed
      // even for edges drawn since the last load (annotateEdgeTypes is a no-op
      // when everything already carries a type).
      const typedEdges = annotateEdgeTypes(e, n);
      const terrain = useBubbleGraphStore.getState().terrain ?? undefined;
      await saveGraph({ projectSlug: useBubbleGraphStore.getState().projectSlug, nodes: stampDerivedQuantities(n, e), edges: typedEdges, buildingAxes: ba, projectName: pn, activeStoreyId: null, annotations, drawingViews, worldLocation, globeInstances, composerShapes, viewTabs, activeTabId, structuralSystem: sys, scenarios: exportScenarios(), terrain });
      setLastSaved(new Date());
      lastSaveRef.current = Date.now();
      console.log('✅ Graph auto-saved');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setSaveError(msg);
      console.error('❌ Auto-save failed:', err);
    } finally {
      setIsSaving(false);
    }
  }, []);

  useEffect(() => {
    // Don't schedule saves until the backend load has completed —
    // before that, nodes/edges are still empty and would wipe the backend.
    if (!isLoaded) return;

    // Skip the first run after isLoaded flips to true to avoid an immediate
    // re-save of data we just fetched.
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    const timeSinceLastSave = Date.now() - lastSaveRef.current;
    const delay = Math.max(interval - timeSinceLastSave, 2000);

    saveTimeoutRef.current = setTimeout(performSave, delay);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [nodes, edges, projectName, structuralSystem, viewTabs, activeTabId, isLoaded, interval, performSave]);

  return { lastSaved, isSaving, saveError, performSave };
}

/**
 * useAutoBackup: periodically commit the CURRENT backend graph into the
 * version-history commit log (kind: 'auto') — see HistoryPanel.tsx /
 * backend/version_history.py. Content-addressed (a no-op save doesn't
 * duplicate anything) and bounded by the History panel's "Clean up old
 * auto-saves" action (backend/version_history.py's prune_auto_commits),
 * unlike the old raw backups/ folder this replaced (unbounded full-JSON
 * copies forever).
 */
function useAutoBackup(nodes: BubbleGraphNode[], interval = 300000) {
  const backupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lastBackup, setLastBackup] = useState<Date | null>(null);

  useEffect(() => {
    if (nodes.length === 0) return;

    if (backupTimeoutRef.current) {
      clearTimeout(backupTimeoutRef.current);
    }

    backupTimeoutRef.current = setTimeout(async () => {
      try {
        await commitHistory('Auto-save', 'auto');
        setLastBackup(new Date());
        console.log('✅ Auto-save committed to history');
      } catch (err) {
        console.error('❌ Auto-save commit failed:', err);
      }
    }, interval);

    return () => {
      if (backupTimeoutRef.current) {
        clearTimeout(backupTimeoutRef.current);
      }
    };
  }, [nodes, interval]);

  return { lastBackup };
}

/**
 * useIfcLiveSync: while `enabled`, keeps a WebSocket connection open to the
 * standalone relay (IfcLiteBridge/server/relay.ts) and pushes a freshly-built
 * IFC STEP model every time `nodes`/`edges` settle — same debounce shape as
 * `useAutoBackup` above, but a much shorter window since this is meant to
 * feel live rather than a periodic backup. Reuses `buildIfcModel`, the exact
 * function the manual "⚙ Generate IFC" button already calls — no new
 * IFC-generation logic, only a transport for the same output. When disabled,
 * this is a no-op: no socket, no `buildIfcModel` calls.
 */
function useIfcLiveSync(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  projectName: string,
  enabled: boolean,
  debounceMs = 800,
) {
  const [status, setStatus] = useState<LiveSyncStatus>('idle');
  const clientRef = useRef<IfcLiveSyncClient | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connection lifecycle — open/close strictly follows `enabled`.
  useEffect(() => {
    if (!enabled) {
      clientRef.current?.disconnect();
      clientRef.current = null;
      setStatus('idle');
      return;
    }
    const client = new IfcLiveSyncClient(setStatus);
    clientRef.current = client;
    client.connect();
    return () => {
      client.disconnect();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [enabled]);

  // Debounced push on every graph change.
  useEffect(() => {
    if (!enabled) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const client = clientRef.current;
      if (!client?.isConnected) return;
      try {
        const { content } = buildIfcModel(nodes, edges, projectName, {
          georeference: exportGeoreference(useBubbleGraphStore.getState().worldLocation),
          materialConfig: getMaterialConfigSync(),
        });
        client.sendModel(projectName, content);
      } catch (err) {
        console.error('[ifc live-sync] build failed:', err);
      }
    }, debounceMs);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [nodes, edges, projectName, enabled, debounceMs]);

  return { status };
}

function pointToLineDist(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const A = px - x1, B = py - y1, C = x2 - x1, D = y2 - y1;
  const lenSq = C * C + D * D;
  const t = lenSq ? Math.max(0, Math.min(1, (A * C + B * D) / lenSq)) : 0;
  return Math.hypot(px - (x1 + t * C), py - (y1 + t * D));
}

// ─── useStoreyViewSync ────────────────────────────────────────────────────

/**
 * Keeps viewsSlice in sync with storey nodes in BubbleGraph.
 * For each storey node → upsert one `floorplan` ViewDefinition.
 * Storeys that disappear from the graph → remove the associated view.
 *
 * View IDs are tracked in a stable Map stored in a ref to survive re-renders.
 */
// ─── LibraryTypePicker ────────────────────────────────────────────────────

interface LibraryTypePickerProps {
  family: 'window' | 'door';
  currentId: string;
  onUpdateProp: (key: string, v: unknown) => void;
}

function LibraryTypePicker({ family, currentId, onUpdateProp }: LibraryTypePickerProps) {
  const types = useLibraryTypes(family);
  const propKey = family === 'window' ? 'window_type' : 'door_type';

  const currentEntry = (family === 'window' ? WINDOW_TYPE_MAP : DOOR_TYPE_MAP).get(currentId)
    ?? types.find((t) => t.id === currentId);

  // Group entries by style
  const styles = [...new Set(types.map((t) => t.style))];

  const handleChange = (id: string) => {
    const entry = types.find((t) => t.id === id);
    onUpdateProp(propKey, id);
    if (entry) {
      onUpdateProp('width',  entry.width_mm);
      onUpdateProp('height', entry.height_mm);
      onUpdateProp('sill_height', (entry as WindowType).sill_height_mm ?? 0);
      // Auto-set opening style to match library default — user can override later
      if (family === 'window') {
        onUpdateProp('opening', (entry as WindowType).opening ?? 'single');
      }
    }
  };

  return (
    <div className="space-y-1.5">
      <select
        className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
        value={currentId}
        onChange={(e) => handleChange(e.target.value)}
      >
        <option value="">— Custom (manual dims) —</option>
        {styles.map((style) => (
          <optgroup key={style} label={style.charAt(0).toUpperCase() + style.slice(1)}>
            {types.filter((t) => t.style === style).map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </optgroup>
        ))}
      </select>

      {currentEntry && (
        <div className="text-[10px] bg-muted/30 border border-border/50 rounded px-2 py-1.5 space-y-0.5">
          <div className="font-medium text-foreground">
            {currentEntry.width_mm / 10}×{currentEntry.height_mm / 10} cm
            {' · '}
            {currentEntry.material}
          </div>
          {'opening' in currentEntry && (currentEntry as WindowType).opening !== 'none' && (
            <div className="text-muted-foreground">
              Opening: {(currentEntry as WindowType).opening}
            </div>
          )}
          {'swing' in currentEntry && (
            <div className="text-muted-foreground">
              Swing: {(currentEntry as DoorType).swing} · {(currentEntry as DoorType).leaf_count} leaf
            </div>
          )}
          <div className="text-muted-foreground italic">{currentEntry.description}</div>
        </div>
      )}
    </div>
  );
}

// ─── PropSection (accordion) ─────────────────────────────────────────────────
function PropSection({
  label, icon, children, defaultOpen = true,
}: {
  label: string; icon?: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: '1px solid hsl(var(--border))' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', width: '100%', gap: 6,
          padding: '7px 10px 6px', border: 'none', background: 'none',
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        {icon && <span style={{ fontSize: 11, lineHeight: 1, opacity: 0.55, flexShrink: 0 }}>{icon}</span>}
        <span style={{
          flex: 1, fontSize: 9, fontWeight: 700, letterSpacing: '0.09em',
          textTransform: 'uppercase', color: 'hsl(var(--muted-foreground))',
          textAlign: 'left',
        }}>{label}</span>
        <span style={{
          fontSize: 7, color: 'hsl(var(--muted-foreground))',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.14s ease',
          display: 'inline-block', flexShrink: 0,
        }}>▶</span>
      </button>
      {open && (
        <div className="space-y-2" style={{ padding: '0 10px 10px' }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── PropertiesPanel ──────────────────────────────────────────────────────

interface PropertiesPanelProps {
  node: BubbleGraphNode | null;
  /** When set, panel is in bulk-edit mode. Values that differ show "var". */
  bulkNodes?: BubbleGraphNode[];
  onUpdateField: (field: keyof BubbleGraphNode, v: unknown) => void;
  onUpdateProp: (key: string, v: unknown) => void;
  /** Apply several properties at once — one undo step. */
  onUpdateProps?: (patch: Record<string, unknown>) => void;
  onAddProp: () => void;
  onDeleteProp: (key: string) => void;
  onDuplicateStorey: (id: string) => void;
  onOpenSectionTab?: (nodeId: string) => void;
  /** Generate / update parametric roof assembly for the selected roof node. */
  onGenerateRoof?: (level: 'envelope' | 'skeleton' | 'framing') => void;
  onGenerateStair?: (level: 'outline' | 'flights' | 'steps') => void;
  /** Project-wide structural system — shown as the inherited value an element can override. */
  projectSystem?: StructuralSystem;
  /**
   * Apply a pure graph rewrite — nodes AND edges together, one undo step.
   * For edits that are not a property patch: wiring a sketch to its reference.
   */
  onRewireGraph?: (fn: (nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]) => { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] }) => void;
}

/** Returns the common value across all nodes, or undefined if they differ. */
function bulkPropValue<T = unknown>(nodes: BubbleGraphNode[], key: string): T | undefined {
  if (nodes.length === 0) return undefined;
  const first = nodes[0].properties[key];
  return nodes.every((n) => String(n.properties[key] ?? '') === String(first ?? '')) ? (first as T) : undefined;
}
function bulkFieldValue<K extends keyof BubbleGraphNode>(nodes: BubbleGraphNode[], key: K): BubbleGraphNode[K] | undefined {
  if (nodes.length === 0) return undefined;
  const first = nodes[0][key];
  return nodes.every((n) => String(n[key] ?? '') === String(first ?? '')) ? first : undefined;
}

// ─── User Element Library (persisted in localStorage) ──────────────────────
interface UserColEntry  { id: string; label: string; column_type: string; material?: string; color_3d?: string; color_2d?: string; }
interface UserSlabEntry { id: string; label: string; slab_type?: string; slab_custom_mm?: number; material?: string; color_3d?: string; color_2d?: string; }
function _loadUL<T>(key: string): T[] { try { return JSON.parse(localStorage.getItem(key) ?? '[]') as T[]; } catch { return []; } }
function _saveUL<T>(key: string, e: T[]): void { try { localStorage.setItem(key, JSON.stringify(e)); } catch { /* ignore */ } }

function PropertiesPanel({
  node,
  bulkNodes,
  onUpdateField,
  onUpdateProp,
  onUpdateProps,
  onAddProp,
  onDeleteProp,
  onDuplicateStorey,
  onOpenSectionTab,
  onGenerateRoof,
  onGenerateStair,
  projectSystem,
  onRewireGraph,
}: PropertiesPanelProps) {
  const { config: matConfig } = useMaterialConfig();
  // User element library state (column + slab)
  const [colUserLib,  setColUserLib]  = useState<UserColEntry[]>(()  => _loadUL<UserColEntry>('bg_ul_col'));
  const [slabUserLib, setSlabUserLib] = useState<UserSlabEntry[]>(() => _loadUL<UserSlabEntry>('bg_ul_slab'));
  const [colSaveName,  setColSaveName]  = useState('');
  const [slabSaveName, setSlabSaveName] = useState('');
  // Read live graph data for formula context resolution
  const allNodes = useBubbleGraphStore((s) => s.bubbleGraphNodes);
  const allEdges = useBubbleGraphStore((s) => s.bubbleGraphEdges);
  const nodeMap  = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);
  // Formula context for the currently selected node (resolved lazily from topology)
  const fmCtx = useMemo(
    () => node ? resolveFormulaContext(node, allEdges, nodeMap) : undefined,
    [node, allEdges, nodeMap],
  );

  // In bulk mode use bulkNodes; in single mode wrap `node` in an array for helpers
  const isBulk = !!(bulkNodes && bulkNodes.length > 1);
  const panelNodes = isBulk ? bulkNodes! : (node ? [node] : []);

  // Helper: rendered value for a property. Returns undefined when values differ (bulk).
  const propVal = (key: string): unknown => isBulk ? bulkPropValue(panelNodes, key) : node?.properties[key];
  // Helper: boolean property (handles boolean or 'true'/'True' string forms).
  const boolProp = (key: string): boolean => {
    const v = propVal(key);
    return v === true || String(v ?? '').toLowerCase() === 'true';
  };
  // Helper: rendered value for a node field.
  const fieldVal = <K extends keyof BubbleGraphNode>(key: K): BubbleGraphNode[K] | undefined =>
    isBulk ? bulkFieldValue(panelNodes, key) : node?.[key];

  // Placeholder shown in inputs when values differ
  const VAR = 'var';

  // ── Sweep: pure recompute for read-outs + diagnostics ─────────────────────
  // DXF profiles land async in the bglib store; the version bump re-runs the
  // memo (and re-lists the picker options) when one arrives.
  const [profileLibVer, setProfileLibVer] = useState(0);
  // The in-app profile editor, opened from the picker. It writes a library
  // symbol, so a drawn profile and an imported DXF are the same thing after.
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null);
  useEffect(() => {
    void ensureProfileLibraryLoaded();
    return subscribeBglibStore(() => setProfileLibVer((n) => n + 1));
  }, []);
  const sweepRes = useMemo(
    () => (!isBulk && node?.type === 'sweep' ? computeSweep(node, nodeMap, allEdges) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node, nodeMap, allEdges, profileLibVer],
  );
  const sketchRes = useMemo(
    () => (!isBulk && node?.type === 'sketch' ? computeSketch(node, nodeMap, allEdges) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node, nodeMap, allEdges, profileLibVer],
  );
  /**
   * The other closed sketches of this storey — what this one can be a hole in,
   * and which faces a sweep can take as its profile. A hole is never offered
   * as a host: holes do not nest.
   */
  const sketchFaces = useMemo(() => {
    if (isBulk || node?.type !== 'sketch') return [];
    const closedOf = (n: BubbleGraphNode) => String(n.properties?.closed ?? 'True').toLowerCase() !== 'false';
    return [...nodeMap.values()]
      .filter((n) => n.type === 'sketch' && n.id !== node.id && n.parentId === node.parentId
        && closedOf(n) && !String(n.properties?.hole_of ?? '').trim())
      .map((n) => {
        const outline = sketchOutline(n, nodeMap, allEdges);
        const holes = [...nodeMap.values()].filter((h) => h.type === 'sketch' && String(h.properties?.hole_of ?? '') === n.id).length;
        return { id: n.id, name: n.name || n.id, outline, holes };
      })
      .filter((f) => f.outline.length >= 3);
  }, [isBulk, node, nodeMap, allEdges]);
  /**
   * Every other sketch of the storey an array can run along — open or
   * closed, curve or polyline — with its length, for the picker.
   */
  const sketchPaths = useMemo(() => {
    if (isBulk || node?.type !== 'sketch') return [];
    return [...nodeMap.values()]
      .filter((n) => n.type === 'sketch' && n.id !== node.id && n.parentId === node.parentId
        && !String(n.properties?.hole_of ?? '').trim())
      .map((n) => ({ id: n.id, name: n.name || n.id, lengthMm: sketchPathReader(n, nodeMap, allEdges)?.length ?? 0 }))
      .filter((p) => p.lengthMm >= 1);
  }, [isBulk, node, nodeMap, allEdges]);
  /** The node's derived quantities — shown read-only, and the `q_*` a formula may name. */
  const nodeQty = useMemo(
    () => (!isBulk && node ? deriveQuantities(node, allEdges, nodeMap) : []),
    [isBulk, node, allEdges, nodeMap],
  );
  /**
   * What a sketch's formula fields may name: the topology context, the
   * node's own quantities, and the length of the path its array runs along.
   */
  const fmVars = useMemo(() => {
    const pathId = String(node?.properties?.array_path ?? '');
    const path = sketchPaths.find((p) => p.id === pathId);
    return {
      ...(fmCtx ?? {}),
      ...quantityVars(nodeQty),
      ...(path ? { path_length_m: path.lengthMm / 1000 } : {}),
    } as Record<string, number>;
  }, [fmCtx, nodeQty, sketchPaths, node]);
  /** The smallest closed sketch that contains every point of this one. */
  const enclosingSketch = useMemo(() => {
    if (!sketchRes || sketchRes.intent.outline.length < 3) return null;
    const mine = sketchRes.intent.outline;
    const around = sketchFaces
      .filter((f) => mine.every((p) => pointInPolygon(p, f.outline, 0)))
      .sort((a, b) => Math.abs(polygonArea(a.outline)) - Math.abs(polygonArea(b.outline)));
    return around[0] ?? null;
  }, [sketchRes, sketchFaces]);
  const facadeRes = useMemo(
    () => (!isBulk && node?.type === 'facade' ? computeFacade(node, nodeMap, allEdges) : null),
    [isBulk, node, nodeMap, allEdges],
  );
  const scatterRes = useMemo(
    () => (!isBulk && node?.type === 'scatter' ? computeScatter(node, nodeMap, allEdges) : null),
    [isBulk, node, nodeMap, allEdges],
  );
  const domeRes = useMemo(
    () => (!isBulk && node?.type === 'dome' ? computeDome(node, nodeMap, allEdges) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node, nodeMap, allEdges, profileLibVer],
  );
  const terrainModel = useBubbleGraphStore((s) => s.terrain);
  const padRes = useMemo(() => {
    if (isBulk || node?.type !== 'terrain_pad') return null;
    const siteNode = findSiteNode(nodeMap.values());
    if (!siteNode) return { pad: null, site: null };
    const site = computeSite(siteNode, nodeMap, allEdges, terrainModel);
    return { pad: site.pads.find((p) => p.nodeId === node.id) ?? null, site };
  }, [isBulk, node, nodeMap, allEdges, terrainModel]);
  const siteRes = useMemo(
    () => (!isBulk && node?.type === 'site' ? computeSite(node, nodeMap, allEdges, terrainModel) : null),
    [isBulk, node, nodeMap, allEdges, terrainModel],
  );

  // ── User library helpers (need propVal defined first) ─────────────────────
  const _saveColPreset  = (colType: string) => {
    const entry: UserColEntry = { id: `ucol_${Date.now()}`, label: colSaveName.trim() || colType,
      column_type: colType, material: String(propVal('material') ?? '') || undefined,
      color_3d: String(propVal('color_3d') ?? '') || undefined, color_2d: String(propVal('color_2d') ?? '') || undefined };
    const next = [...colUserLib, entry]; setColUserLib(next); _saveUL('bg_ul_col', next); setColSaveName('');
  };
  const _removeColPreset = (id: string) => { const next = colUserLib.filter((e) => e.id !== id); setColUserLib(next); _saveUL('bg_ul_col', next); };
  const _applyColPreset  = (e: UserColEntry) => {
    onUpdateProp('column_type', e.column_type);
    if (e.material) onUpdateProp('material',  e.material);
    if (e.color_3d) onUpdateProp('color_3d',  e.color_3d);
    if (e.color_2d) onUpdateProp('color_2d',  e.color_2d);
  };
  const _saveSlabPreset  = (slabType: string, customMm?: number) => {
    const entry: UserSlabEntry = { id: `uslab_${Date.now()}`, label: slabSaveName.trim() || slabType,
      slab_type: slabType, slab_custom_mm: customMm && customMm > 0 ? customMm : undefined,
      material: String(propVal('material') ?? '') || undefined,
      color_3d: String(propVal('color_3d') ?? '') || undefined, color_2d: String(propVal('color_2d') ?? '') || undefined };
    const next = [...slabUserLib, entry]; setSlabUserLib(next); _saveUL('bg_ul_slab', next); setSlabSaveName('');
  };
  const _removeSlabPreset = (id: string) => { const next = slabUserLib.filter((e) => e.id !== id); setSlabUserLib(next); _saveUL('bg_ul_slab', next); };
  const _applySlabPreset  = (e: UserSlabEntry) => {
    if (e.slab_type)      onUpdateProp('slab_type', e.slab_type);
    if (e.slab_custom_mm) onUpdateProp('slab_custom_mm', e.slab_custom_mm); else onUpdateProp('slab_custom_mm', undefined);
    if (e.material)       onUpdateProp('material',  e.material);
    if (e.color_3d)       onUpdateProp('color_3d',  e.color_3d);
    if (e.color_2d)       onUpdateProp('color_2d',  e.color_2d);
  };

  if (!node) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-2 p-4">
        <span className="text-3xl opacity-30">⬡</span>
        <span>Select a node to inspect</span>
      </div>
    );
  }

  const typeDef = getNodeTypeData(node.type);

  // Smart property keys that get dedicated UI
  const smartKeys = new Set([
    'has_column', 'column_type', 'has_beam', 'beam_type', 'beam_material',
    'roof_attach', 'trim_priority', 'gable_material', 'gable_thickness_mm', 'gable_offset_mm',
    'show_framing', 'stud_spacing_mm', 'stud_section', 'clt_max_panel_mm',
    'wall_type', 'wall_custom_mm', 'is_circular', 'arc_radius', 'slab_type', 'material',
    'bottomElevation', 'topElevation', 'axesX', 'axesY', 'width', 'height', 'depth',
    'sill_height', 'wall_offset', 'discipline', 'offset', 'elevation',
    'offsetStart', 'offsetEnd', 'offsetVerticalStart', 'offsetVerticalEnd',
    'offsetX', 'offsetY', 'offsetBase', 'offsetTop',
    // window / door library type keys
    'window_type', 'door_type', 'opening', 'opening_profile', 'cut_depth',
    // room-specific keys
    'contour_offset', 'has_slab', 'slab_material', 'room_load_category',
    // structural system override — edited by its own section, see lib/systems/
    'structural_system',
    // shell / covering keys
    'thickness',
    // roof keys
    'roof_type', 'pitch_deg', 'overhang_mm', 'ridge_direction', 'ridge_offset_mm',
    'generate_level', 'rafter_spacing_mm', 'rafter_section', 'ridge_section',
    'post_section', 'covering_material', 'covering_thickness_mm', 'covering_offset_mm', 'eave_z_offset_mm', 'system',
    'upper_pitch_deg', 'mansard_break_inset_mm', 'truss_spacing_mm', 'purlin_spacing_mm',
    // roof detail-layer keys
    'gen_membrane', 'gen_sheathing', 'sheathing_thickness_mm', 'gen_insulation', 'insulation_thickness_mm',
    'gen_counter_battens', 'counter_batten_spacing_mm', 'counter_batten_section',
    'gen_battens', 'batten_spacing_mm', 'batten_section',
    'gen_fascia', 'fascia_height_mm', 'fascia_thickness_mm', 'gen_barge_board', 'gen_soffit',
    'gen_ridge_caps', 'ridge_cap_width_mm', 'gen_hip_caps', 'gen_valley_flashing', 'valley_flashing_width_mm',
    'gen_gutters', 'gutter_diameter_mm', 'gen_downpipes', 'downpipe_spacing_mm', 'downpipe_diameter_mm',
    'gen_snow_guards', 'snow_guard_spacing_mm', 'gen_collar_ties', 'collar_height_ratio',
    'round', 'diameter_mm',
    // skylight / dormer keys
    'width_mm', 'length_mm', 'curb_height_mm', 'depth_mm', 'wall_height_mm',
    'solver_version', 'face_count', 'base_z', 'source_roof_id', 'generated', 'role',
    // room-derived covering keys
    'has_covering', 'covering_thickness', 'covering_height', 'covering_material', 'covering_offset', 'covering_layers',
    'wall_layers',
    // height bands on the envelope — edited by ShellZonesEditor
    'shell_zones',
    'climate_site',
    // local-transform params (rendered in Transform section)
    'obj_translate_x', 'obj_translate_y', 'obj_translate_z',
    'obj_rotate_x', 'obj_rotate_y', 'obj_rotate_z',
    // section / view keys
    'cut_depth_mm', 'cut_height_mm', 'cut_plane_offset_mm', 'start_elevation_mm',
    'offset_left_mm', 'offset_right_mm', 'flipped', 'show_in_plan',
    'plan_cut', 'look_side', 'depth_mode', 'clip_to_marker', 'view_direction',
    // per-node appearance overrides (shown in dedicated Appearance sections)
    'label', 'color_3d', 'color_2d', 'slab_custom_mm',
    // sweep keys (dedicated Sweep section)
    'profile', 'p_w_mm', 'p_h_mm', 'p_t_mm', 'p_tw_mm', 'p_tf_mm', 'p_d_mm', 'p_segments',
    'anchor_x', 'anchor_y', 'offset_x_mm', 'offset_z_mm', 'rotation_deg', 'mirror',
    'corners', 'closed', 'level', 'height_mm', 'ifc_type', 'sweep_role', 'detail_type',
    // dome keys (dedicated Dome section)
    'base_radius_mm', 'base_fillet_mm', 'dome_height_mm', 'dome_bulge',
    'cell_count', 'cell_seed', 'relax_iterations', 'width_mm', 'height_mm',
    // sketch keys (dedicated Sketch section)
    'outline', 'op', 'array_count', 'array_dx_mm', 'array_dy_mm', 'array_dz_mm',
    'array_path', 'array_orient', 'hole_of', 'curve_mode', 'curve_degree',
    'element_type', 'shape', 'shape_x_mm', 'shape_y_mm', 'shape_w_mm', 'shape_h_mm', 'shape_r_mm',
    // terrain pad keys (dedicated Platform section)
    'level_mm', 'level_mode', 'transition', 'slope_deg',
    // facade keys (dedicated Facade section)
    'pattern', 'cell_w_mm', 'cell_h_mm', 'panel_kind', 'mullion_w_mm', 'mullion_d_mm',
    'panel_thickness_mm', 'cassette_depth_mm', 'cassette_bevel_mm', 'offset_mm', 'flip', 'panel_material',
    // scatter keys (dedicated Scatter section)
    'kind', 'mode', 'count', 'spacing_mm', 'seed', 'size_mm', 'size_jitter', 'min_gap_mm', 'edge_margin_mm',
    // site keys (dedicated Site section)
    'excavate_foundations', 'working_space_mm', 'bedding_mm', 'pit_slope_deg', 'show_in_3d',
    'resolution', 'glass_thickness_mm', 'planarity_tol_mm', 'glass_material',
  ]);

  return (
    <div className="flex flex-col h-full overflow-y-auto text-xs">
      {/* Bulk-edit banner */}
      {isBulk && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-teal-600/15 border-b border-teal-500/30 text-teal-700 dark:text-teal-300 text-[10px]">
          <span className="text-base">⊞</span>
          <span><strong>{allNodes.length} nodes</strong> selected — editing in bulk. Fields marked <strong className="font-mono">var</strong> have mixed values.</span>
        </div>
      )}
      {/* Info */}
      <PropSection label="Information" icon="ⓘ">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
          <span className="text-muted-foreground">Type</span>
          <span
            className="font-semibold px-2 py-0.5 rounded text-white text-xs"
            style={{ background: typeDef?.color ?? '#334155' }}
          >
            {typeDef?.label ?? node.type}
          </span>
          <span className="text-muted-foreground">Name</span>
          <input
            className="bg-background border border-border rounded px-1.5 py-0.5 w-full text-xs"
            value={fieldVal('name') !== undefined ? String(fieldVal('name')) : ''}
            placeholder={fieldVal('name') === undefined ? VAR : undefined}
            onChange={(e) => onUpdateField('name', e.target.value)}
          />
        </div>
      </PropSection>

      {/* Position — hidden in bulk (positions differ) */}
      {!isBulk && (
      <PropSection label="Position (mm)" icon="⊹">
        <div className="grid grid-cols-3 gap-2">
          {(['x', 'y', 'z'] as const).map((ax) => (
            <div key={ax}>
              <div className="text-muted-foreground mb-0.5 uppercase">{ax}</div>
              <input
                type="number"
                className="bg-background border border-border rounded px-1.5 py-0.5 w-full text-xs"
                value={Math.round(Number(node[ax]) || 0)}
                onChange={(e) => onUpdateField(ax, parseFloat(e.target.value))}
              />
            </div>
          ))}
        </div>
      </PropSection>
      )} {/* end !isBulk position block */}

      {/* ── Array / Repeat ──────────────────────────────────────────────── */}
      {!['storey', 'ax', 'section', 'view'].includes(node.type) && (
        <PropSection label="Array / Repeat" icon="⊞" defaultOpen={false}>
          <div className="grid grid-cols-[1rem_1fr] gap-x-2 gap-y-1 items-center text-xs">
            {(['array_x', 'array_y', 'array_z'] as const).map((key) => {
              const axis = key.slice(-1).toUpperCase(); // X, Y, Z
              const raw  = String(node.properties[key] ?? '');
              const vals = parseArrayProp(raw);
              const isArr = isArrayExpr(raw);
              return (
                <React.Fragment key={key}>
                  <span className="text-muted-foreground font-mono font-bold">{axis}</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      placeholder={`e.g. [0, 3000, 6000] or {0..9000..3000}`}
                      className={cn(
                        'flex-1 bg-background border rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors',
                        isArr && vals.length > 0 ? 'border-amber-400 text-amber-600 dark:text-amber-400'
                          : raw && vals.length === 0 ? 'border-red-500 text-red-500'
                          : 'border-border',
                      )}
                      value={raw}
                      onChange={(e) => onUpdateProp(key, e.target.value === '' ? undefined : e.target.value)}
                    />
                    {vals.length > 0 && (
                      <span className="text-[9px] text-muted-foreground whitespace-nowrap">{vals.length}×</span>
                    )}
                    {raw && (
                      <button
                        className="text-[10px] text-muted-foreground hover:text-red-400"
                        title="Clear"
                        onClick={() => onUpdateProp(key, undefined)}
                      >✕</button>
                    )}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
          {/* Summary of total instances */}
          {(['array_x', 'array_y', 'array_z'] as const).some((k) => parseArrayProp(String(node.properties[k] ?? '')).length > 0) && (() => {
            const cx = Math.max(1, parseArrayProp(String(node.properties.array_x ?? '')).length);
            const cy = Math.max(1, parseArrayProp(String(node.properties.array_y ?? '')).length);
            const cz = Math.max(1, parseArrayProp(String(node.properties.array_z ?? '')).length);
            return (
              <div className="text-[10px] text-amber-500 dark:text-amber-400 font-medium">
                ↳ {cx * cy * cz} instance{cx * cy * cz !== 1 ? 's' : ''} ({cx}×{cy}×{cz})
              </div>
            );
          })()}
        </PropSection>
      )}

      {/* Storey elevations */}
      {node.type === 'storey' && (
        <PropSection label="Elevations (mm)" icon="↕">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-muted-foreground mb-0.5">Bottom</div>
              <input
                type="number"
                className="bg-background border border-border rounded px-1.5 py-0.5 w-full text-xs"
                value={node.properties.bottomElevation as number ?? 0}
                onChange={(e) => onUpdateProp('bottomElevation', parseFloat(e.target.value))}
              />
            </div>
            <div>
              <div className="text-muted-foreground mb-0.5">Top</div>
              <input
                type="number"
                className="bg-background border border-border rounded px-1.5 py-0.5 w-full text-xs"
                value={node.properties.topElevation as number ?? 3000}
                onChange={(e) => onUpdateProp('topElevation', parseFloat(e.target.value))}
              />
            </div>
          </div>
          <button
            className="w-full text-xs bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded px-2 py-1.5 transition-colors"
            onClick={() => onDuplicateStorey(node.id)}
          >
            Duplicate Storey
          </button>
        </PropSection>
      )}

      {/* Discipline */}
      {node.type === 'storey' && (
        <PropSection label="Discipline" icon="◈">
          <div className="grid grid-cols-3 gap-1">
            {(['architectural', 'structural', 'mep'] as StoreyDiscipline[]).map((d) => (
              <button
                key={d}
                className={cn(
                  'text-[11px] px-1.5 py-1 rounded border transition-colors capitalize',
                  (node.properties.discipline ?? 'architectural') === d
                    ? 'bg-primary/20 border-primary/50 text-primary'
                    : 'border-border hover:bg-accent text-muted-foreground',
                )}
                onClick={() => onUpdateProp('discipline', d)}
              >
                {d === 'architectural' ? 'Arch.' : d === 'structural' ? 'Struct.' : 'MEP'}
              </button>
            ))}
          </div>
        </PropSection>
      )}

      {/* Structural family pickers */}
      {node.type === 'ax' && (
        <PropSection label="Column at Axis" icon="■">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground">Enabled</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(node.properties.has_column ?? 'False')}
              onChange={(e) => onUpdateProp('has_column', e.target.value)}
            >
              <option value="True">True</option>
              <option value="False">False</option>
            </select>
          </div>
          {(node.properties.has_column === 'True' || node.properties.has_column === true) && (() => {
            const colType   = (propVal('column_type') as string) ?? 'C25x25';
            const isCirc    = /^[Cc][Rr]\d+/.test(colType);
            const rectMatch = colType.match(/^[Cc](\d+)x(\d+)$/);
            const circMatch = colType.match(/^[Cc][Rr](\d+)$/);
            return (
              <div className="space-y-2 pt-1">
                <div className="flex gap-1">
                  {(['rect', 'circle'] as const).map((shape) => (
                    <button key={shape}
                      className={cn('flex-1 text-xs py-1 rounded border font-semibold transition-all',
                        (shape === 'circle') === isCirc
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'border-border bg-background text-muted-foreground hover:border-blue-400')}
                      onClick={() => {
                        if (shape === 'rect' && isCirc) {
                          const d = circMatch ? +circMatch[1] : 25;
                          onUpdateProp('column_type', `C${d}x${d}`);
                        } else if (shape === 'circle' && !isCirc) {
                          const w = rectMatch ? +rectMatch[1] : 25;
                          onUpdateProp('column_type', `CR${w}`);
                        }
                      }}
                    >{shape === 'rect' ? '▪ Rect.' : '● Circ.'}</button>
                  ))}
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
                  {isCirc ? (<>
                    <span className="text-muted-foreground">Preset</span>
                    <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={colType} onChange={(e) => onUpdateProp('column_type', e.target.value)}>
                      {getGeometriesByFamily('column').filter((g) => /^[Cc][Rr]/.test(g.id)).map((g) => (
                        <option key={g.id} value={g.id}>{g.label}</option>
                      ))}
                    </select>
                    <span className="text-muted-foreground">Diameter (cm)</span>
                    <NumInput step={1} className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={circMatch ? +circMatch[1] : 25}
                      onChange={(v) => onUpdateProp('column_type', `CR${Math.max(1, Math.round(v))}`)} />
                  </>) : (<>
                    <span className="text-muted-foreground">Preset</span>
                    <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={getGeometriesByFamily('column').find((g) => g.id === colType && !/^[Cc][Rr]/.test(g.id)) ? colType : ''}
                      onChange={(e) => { if (e.target.value) onUpdateProp('column_type', e.target.value); }}>
                      <option value="">— custom —</option>
                      {getGeometriesByFamily('column').filter((g) => !/^[Cc][Rr]/.test(g.id)).map((g) => (
                        <option key={g.id} value={g.id}>{g.label}</option>
                      ))}
                    </select>
                    <span className="text-muted-foreground">Width (cm)</span>
                    <NumInput step={1} className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={rectMatch ? +rectMatch[1] : 25}
                      onChange={(v) => { const d = rectMatch ? +rectMatch[2] : Math.max(1, Math.round(v)); onUpdateProp('column_type', `C${Math.max(1, Math.round(v))}x${d}`); }} />
                    <span className="text-muted-foreground">Depth (cm)</span>
                    <NumInput step={1} className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={rectMatch ? +rectMatch[2] : 25}
                      onChange={(v) => { const w = rectMatch ? +rectMatch[1] : 25; onUpdateProp('column_type', `C${w}x${Math.max(1, Math.round(v))}`); }} />
                  </>)}
                  <span className="text-muted-foreground">Off.X (mm)</span>
                  <NumInput step={25} className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    value={(node.properties.offsetX as number) ?? 0} onChange={(v) => onUpdateProp('offsetX', v)} />
                  <span className="text-muted-foreground">Off.Y (mm)</span>
                  <NumInput step={25} className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    value={(node.properties.offsetY as number) ?? 0} onChange={(v) => onUpdateProp('offsetY', v)} />
                  <span className="text-muted-foreground">Off.Base (mm)</span>
                  <NumInput step={25} className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    value={(node.properties.offsetBase as number) ?? 0} onChange={(v) => onUpdateProp('offsetBase', v)} />
                  <span className="text-muted-foreground">Off.Top (mm)</span>
                  <NumInput step={25} className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    value={(node.properties.offsetTop as number) ?? 0} onChange={(v) => onUpdateProp('offsetTop', v)} />
                </div>
                {/* Appearance */}
                <div className="pt-2 border-t border-border/50 space-y-1.5">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest block">Appearance</span>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
                    <span className="text-muted-foreground">Label</span>
                    <input type="text" className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      placeholder="Display name…" value={String(node.properties.label ?? '')}
                      onChange={(e) => onUpdateProp('label', e.target.value || undefined)} />
                    <span className="text-muted-foreground">Material</span>
                    <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={String(propVal('material') ?? '')} onChange={(e) => onUpdateProp('material', e.target.value || undefined)}>
                      <option value="">(column default)</option>
                      {matConfig ? Object.entries(matConfig.materials).map(([id, m]) => (<option key={id} value={id}>{(m as {label?:string}).label ?? id}</option>)) : null}
                    </select>
                    <span className="text-muted-foreground" title="3D color override — overrides material color in all 3D viewers">Color 3D</span>
                    <div className="flex items-center gap-1">
                      <input type="color" className="w-8 h-6 rounded border border-border cursor-pointer"
                        value={String(propVal('color_3d') || '#3b82f6')}
                        onChange={(e) => onUpdateProp('color_3d', e.target.value)} />
                      {propVal('color_3d') && <button className="text-[10px] text-muted-foreground hover:text-red-400" title="Clear override" onClick={() => onUpdateProp('color_3d', undefined)}>✕</button>}
                    </div>
                    <span className="text-muted-foreground" title="2D color override — overrides material color in floor plans and sections">Color 2D</span>
                    <div className="flex items-center gap-1">
                      <input type="color" className="w-8 h-6 rounded border border-border cursor-pointer"
                        value={String(propVal('color_2d') || '#1e293b')}
                        onChange={(e) => onUpdateProp('color_2d', e.target.value)} />
                      {propVal('color_2d') && <button className="text-[10px] text-muted-foreground hover:text-red-400" title="Clear override" onClick={() => onUpdateProp('color_2d', undefined)}>✕</button>}
                    </div>
                  </div>
                  <div className="flex gap-1 pt-0.5">
                    <input type="text" className="flex-1 bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      placeholder="Name for library…" value={colSaveName} onChange={(e) => setColSaveName(e.target.value)} />
                    <button className="text-xs px-2 py-0.5 rounded bg-amber-500 hover:bg-amber-600 text-white font-semibold shrink-0"
                      title="Save current config as a library preset" onClick={() => _saveColPreset(colType)}>💾 Save</button>
                  </div>
                  {colUserLib.length > 0 && (
                    <div className="space-y-0.5">
                      <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Saved presets</span>
                      {colUserLib.map((e) => (
                        <div key={e.id} className="flex items-center gap-1">
                          <button className="flex-1 text-left text-xs px-1.5 py-0.5 rounded bg-background border border-border hover:bg-accent truncate"
                            title={`Apply: ${e.column_type}${e.material ? ` · ${e.material}` : ''}${e.color_3d ? ` · 3D ${e.color_3d}` : ''}`}
                            onClick={() => _applyColPreset(e)}>{e.label}</button>
                          <button className="text-[10px] text-muted-foreground hover:text-red-400 px-0.5" title="Remove" onClick={() => _removeColPreset(e.id)}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </PropSection>
      )}

      {(node.type === 'column') && (
        <PropSection label="Column" icon="■">
          {/* Shape mode toggle */}
          {(() => {
            const colType   = (propVal('column_type') as string) ?? 'C30x30';
            const isCirc    = /^[Cc][Rr]\d+/.test(colType);
            const rectMatch = colType.match(/^[Cc](\d+)x(\d+)$/);
            const circMatch = colType.match(/^[Cc][Rr](\d+)$/);
            return (
              <>
                <div className="flex gap-1">
                  {(['rect', 'circle'] as const).map((shape) => (
                    <button key={shape}
                      className={cn('flex-1 text-xs py-1.5 rounded-lg border font-semibold transition-all',
                        (shape === 'circle') === isCirc
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'border-border bg-background text-muted-foreground hover:border-blue-400')}
                      onClick={() => {
                        if (shape === 'rect' && isCirc) {
                          const d = circMatch ? +circMatch[1] : 30;
                          onUpdateProp('column_type', `C${d}x${d}`);
                        } else if (shape === 'circle' && !isCirc) {
                          const w = rectMatch ? +rectMatch[1] : 30;
                          onUpdateProp('column_type', `CR${w}`);
                        }
                      }}
                    >{shape === 'rect' ? '▪ Rectangular' : '● Circular'}</button>
                  ))}
                </div>
                {isCirc ? (
                  /* Circular: single diameter input */
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
                    <span className="text-muted-foreground">Preset</span>
                    <select
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={colType}
                      onChange={(e) => onUpdateProp('column_type', e.target.value)}
                    >
                      {getGeometriesByFamily('column').filter((g) => /^[Cc][Rr]/.test(g.id)).map((g) => (
                        <option key={g.id} value={g.id}>{g.label}</option>
                      ))}
                    </select>
                    <span className="text-muted-foreground">Diameter (cm)</span>
                    <NumInput step={1}
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={circMatch ? +circMatch[1] : 30}
                      onChange={(v) => onUpdateProp('column_type', `CR${Math.max(1, Math.round(v))}`)}
                    />
                  </div>
                ) : (
                  /* Rectangular: preset + custom W × D */
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
                    <span className="text-muted-foreground">Preset</span>
                    <select
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={getGeometriesByFamily('column').find((g) => g.id === colType && !/^[Cc][Rr]/.test(g.id)) ? colType : ''}
                      onChange={(e) => { if (e.target.value) onUpdateProp('column_type', e.target.value); }}
                    >
                      <option value="">— custom —</option>
                      {getGeometriesByFamily('column').filter((g) => !/^[Cc][Rr]/.test(g.id)).map((g) => (
                        <option key={g.id} value={g.id}>{g.label}</option>
                      ))}
                    </select>
                    <span className="text-muted-foreground">Width (cm)</span>
                    <NumInput step={1}
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={rectMatch ? +rectMatch[1] : 30}
                      onChange={(v) => {
                        const d = rectMatch ? +rectMatch[2] : Math.max(1, Math.round(v));
                        onUpdateProp('column_type', `C${Math.max(1, Math.round(v))}x${d}`);
                      }}
                    />
                    <span className="text-muted-foreground">Depth (cm)</span>
                    <NumInput step={1}
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={rectMatch ? +rectMatch[2] : 30}
                      onChange={(v) => {
                        const w = rectMatch ? +rectMatch[1] : 30;
                        onUpdateProp('column_type', `C${w}x${Math.max(1, Math.round(v))}`);
                      }}
                    />
                  </div>
                )}
              </>
            );
          })()}
          <div className="grid grid-cols-2 gap-2 pt-1">
            {([
              ['offsetX',    'Off.X (mm)'],
              ['offsetY',    'Off.Y (mm)'],
              ['offsetBase', 'Off.Base (mm)'],
              ['offsetTop',  'Off.Top (mm)'],
            ] as const).map(([key, label]) => (
              <div key={key}>
                <label className="text-[10px] text-muted-foreground block mb-0.5">{label}</label>
                <NumInput step={25}
                  className="w-full"
                  value={(node.properties[key] as number) ?? 0}
                  onChange={(v) => onUpdateProp(key, v)}
                />
              </div>
            ))}
          </div>
          {/* Column Appearance */}
          {(() => {
            const colType = (propVal('column_type') as string) ?? 'C30x30';
            return (
              <div className="pt-2 border-t border-border/50 space-y-1.5">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest block">Appearance</span>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
                  <span className="text-muted-foreground">Label</span>
                  <input type="text" className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    placeholder="Display name…" value={String(node.properties.label ?? '')}
                    onChange={(e) => onUpdateProp('label', e.target.value || undefined)} />
                  <span className="text-muted-foreground">Material</span>
                  <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    value={String(propVal('material') ?? '')} onChange={(e) => onUpdateProp('material', e.target.value || undefined)}>
                    <option value="">(column default)</option>
                    {matConfig ? Object.entries(matConfig.materials).map(([id, m]) => (<option key={id} value={id}>{(m as {label?:string}).label ?? id}</option>)) : null}
                  </select>
                  <span className="text-muted-foreground" title="3D color override">Color 3D</span>
                  <div className="flex items-center gap-1">
                    <input type="color" className="w-8 h-6 rounded border border-border cursor-pointer"
                      value={String(propVal('color_3d') || '#3b82f6')}
                      onChange={(e) => onUpdateProp('color_3d', e.target.value)} />
                    {propVal('color_3d') && <button className="text-[10px] text-muted-foreground hover:text-red-400" onClick={() => onUpdateProp('color_3d', undefined)}>✕</button>}
                  </div>
                  <span className="text-muted-foreground" title="2D color override">Color 2D</span>
                  <div className="flex items-center gap-1">
                    <input type="color" className="w-8 h-6 rounded border border-border cursor-pointer"
                      value={String(propVal('color_2d') || '#1e293b')}
                      onChange={(e) => onUpdateProp('color_2d', e.target.value)} />
                    {propVal('color_2d') && <button className="text-[10px] text-muted-foreground hover:text-red-400" onClick={() => onUpdateProp('color_2d', undefined)}>✕</button>}
                  </div>
                </div>
                <div className="flex gap-1 pt-0.5">
                  <input type="text" className="flex-1 bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    placeholder="Name for library…" value={colSaveName} onChange={(e) => setColSaveName(e.target.value)} />
                  <button className="text-xs px-2 py-0.5 rounded bg-amber-500 hover:bg-amber-600 text-white font-semibold shrink-0"
                    onClick={() => _saveColPreset(colType)}>💾 Save</button>
                </div>
                {colUserLib.length > 0 && (
                  <div className="space-y-0.5">
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Saved presets</span>
                    {colUserLib.map((e) => (
                      <div key={e.id} className="flex items-center gap-1">
                        <button className="flex-1 text-left text-xs px-1.5 py-0.5 rounded bg-background border border-border hover:bg-accent truncate"
                          onClick={() => _applyColPreset(e)}>{e.label}</button>
                        <button className="text-[10px] text-muted-foreground hover:text-red-400 px-0.5" onClick={() => _removeColPreset(e.id)}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </PropSection>
      )}

      {node.type === 'beam' && (
        <PropSection label="Beam" icon="═">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground">Type</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(propVal('beam_type') as string) ?? 'B30x60'}
              onChange={(e) => onUpdateProp('beam_type', e.target.value)}
            >
              {getGeometriesByFamily('beam').map((g) => (
                <option key={g.id} value={g.id}>{g.label}</option>
              ))}
            </select>
            <span className="text-muted-foreground">Height (mm)</span>
            <input
              type="number"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.height as number) ?? 300}
              onChange={(e) => onUpdateProp('height', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Off.Start (mm)</span>
            <NumInput step={25}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.offsetStart as number) ?? 0}
              onChange={(v) => onUpdateProp('offsetStart', v)}
            />
            <span className="text-muted-foreground">Off.End (mm)</span>
            <NumInput step={25}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.offsetEnd as number) ?? 0}
              onChange={(v) => onUpdateProp('offsetEnd', v)}
            />
            <span className="text-muted-foreground">Z.Start (mm)</span>
            <NumInput step={25}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.offsetVerticalStart as number) ?? 0}
              onChange={(v) => onUpdateProp('offsetVerticalStart', v)}
            />
            <span className="text-muted-foreground">Z.End (mm)</span>
            <NumInput step={25}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.offsetVerticalEnd as number) ?? 0}
              onChange={(v) => onUpdateProp('offsetVerticalEnd', v)}
            />
          </div>
        </PropSection>
      )}

      {node.type === 'wall' && (
        <PropSection label="Wall" icon="▬">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground">Type</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(propVal('wall_type') as string) ?? 'W20'}
              onChange={(e) => onUpdateProp('wall_type', e.target.value)}
              title={projectSystem && projectSystem !== 'unset' ? `Tipurile native sistemului ${STRUCTURAL_SYSTEM_LABELS[projectSystem]} sunt primele` : undefined}
            >
              {(() => {
                const all = getGeometriesByFamily('wall');
                if (!projectSystem || projectSystem === 'unset') {
                  return all.map((g) => <option key={g.id} value={g.id}>{g.label}</option>);
                }
                const native = all.filter((g) => isNativeWallType(projectSystem, g.id));
                const other = all.filter((g) => !isNativeWallType(projectSystem, g.id));
                return (<>
                  <optgroup label={STRUCTURAL_SYSTEM_LABELS[projectSystem]}>
                    {native.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                  </optgroup>
                  {other.length > 0 && (
                    <optgroup label="Alte tehnologii">
                      {other.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                    </optgroup>
                  )}
                </>);
              })()}
            </select>
            {/* Grosime proprie — catalogul acoperă cazurile uzuale, dar un zid de
                60 cm n-are de ce să ceară un tip nou în librărie. Gol = grosimea
                tipului, ca până acum. */}
            <span
              className="text-muted-foreground"
              title="Grosime proprie, în mm. Gol sau 0 = grosimea tipului ales."
            >Grosime (mm)</span>
            <div className="flex items-center gap-2">
              <input
                type="number" step="10" min="0"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-24"
                placeholder={String(Math.round(parseWallThickness(String(propVal('wall_type') ?? 'W20')) * 1000))}
                value={Number(propVal('wall_custom_mm') ?? 0) > 0 ? String(propVal('wall_custom_mm')) : ''}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  onUpdateProp('wall_custom_mm', Number.isFinite(v) && v > 0 ? v : undefined);
                }}
              />
              {Number(propVal('wall_custom_mm') ?? 0) > 0 && (
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                  title="Înapoi la grosimea tipului"
                  onClick={() => onUpdateProp('wall_custom_mm', undefined)}
                >
                  ↺ tip
                </button>
              )}
            </div>
            <span className="text-muted-foreground">Circular Wall</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox"
                checked={propVal('is_circular') === 'True' || propVal('is_circular') === true}
                onChange={(e) => onUpdateProp('is_circular', e.target.checked ? 'True' : 'False')}
                style={{ width: 11, height: 11 }}
              />
              <span className="text-[11px]">{(propVal('is_circular') === 'True' || propVal('is_circular') === true) ? 'Arc enabled' : 'Straight'}</span>
            </label>
            {(node.properties.is_circular === 'True' || node.properties.is_circular === true) && (<>
              <span className="text-muted-foreground">Arc Radius (mm)</span>
              <input
                type="number" step="100"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                placeholder="e.g. 5000"
                value={propVal('arc_radius') !== undefined ? (propVal('arc_radius') as number) : ''}
                onChange={(e) => onUpdateProp('arc_radius', parseFloat(e.target.value))}
                title="Positive = arc bends left (CCW viewed from above), Negative = right (CW)"
              />
            </>)}
            <span className="text-muted-foreground">Height (mm)</span>
            <input
              type="number"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              placeholder={isBulk && propVal('height') === undefined ? VAR : undefined}
              value={propVal('height') !== undefined ? (propVal('height') as number) ?? DEFAULT_WALL_HEIGHT_MM : ''}
              onChange={(e) => {
                const h = parseFloat(e.target.value);
                onUpdateProp('height', h);
                const layers = getEditableWallLayers(node.properties);
                if (layers.length > 0) {
                  const last = layers.length - 1;
                  const next = layers.map((l, i) => (i === last ? { ...l, to_mm: h } : l));
                  onUpdateProp('wall_layers', serializeWallLayers(next));
                }
              }}
            />
            <span className="text-muted-foreground">Off.Start (mm)</span>
            <input
              type="number" step="25"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              placeholder={isBulk && propVal('offsetStart') === undefined ? VAR : undefined}
              value={propVal('offsetStart') !== undefined ? (propVal('offsetStart') as number) ?? 0 : ''}
              onChange={(e) => onUpdateProp('offsetStart', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Off.End (mm)</span>
            <input
              type="number" step="25"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              placeholder={isBulk && propVal('offsetEnd') === undefined ? VAR : undefined}
              value={propVal('offsetEnd') !== undefined ? (propVal('offsetEnd') as number) ?? 0 : ''}
              onChange={(e) => onUpdateProp('offsetEnd', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Join Start</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('wall_join_start') ?? 'auto')}
              onChange={(e) => onUpdateProp('wall_join_start', e.target.value)}
            >
              <option value="auto">Auto</option>
              <option value="butt">Butt (T-join)</option>
              <option value="miter">Miter (L-corner)</option>
              <option value="square_off">Square Off</option>
              <option value="none">None</option>
            </select>
            <span className="text-muted-foreground">Join End</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('wall_join_end') ?? 'auto')}
              onChange={(e) => onUpdateProp('wall_join_end', e.target.value)}
            >
              <option value="auto">Auto</option>
              <option value="butt">Butt (T-join)</option>
              <option value="miter">Miter (L-corner)</option>
              <option value="square_off">Square Off</option>
              <option value="none">None</option>
            </select>
            {/* ── Roof trim ─────────────────────────────────────────────── */}
            <span className="text-muted-foreground" title="Grow this wall up to the roof above it before the roof cuts it back — a gable wall closes its own triangle.">Attach to roof</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('roof_attach') ?? 'False')}
              onChange={(e) => onUpdateProp('roof_attach', e.target.value)}
            >
              <option value="False">False</option>
              <option value="True">True</option>
            </select>
            <span className="text-muted-foreground" title="Who cuts whom: the higher number wins. A roof is 100, so leaving this at 10 lets the roof trim the wall; above 100 the wall punches through it instead.">Trim priority</span>
            <FormulaInput
              value={Number(propVal('trim_priority') ?? 10)}
              ctx={fmCtx}
              onChange={(v) => onUpdateProp('trim_priority', v)} />
            {/* The gable — the piece left above the roof's cut — is often
                another construction than the wall below it. */}
            <span className="text-muted-foreground" title="Material of the part left above the roof cut. Leave on (same as wall) for a wall that carries on in one material.">Gable material</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(propVal('gable_material') as string) ?? ''}
              onChange={(e) => onUpdateProp('gable_material', e.target.value)}
            >
              <option value="">(same as wall)</option>
              {matConfig
                ? Object.entries(matConfig.materials).map(([id, mat]) => (
                    <option key={id} value={id}>{(mat as { label?: string }).label ?? id}</option>
                  ))
                : null}
            </select>
            <span className="text-muted-foreground" title="Thickness of the gable in mm. 0 keeps the wall's own thickness.">Gable thk (mm)</span>
            <FormulaInput
              value={Number(propVal('gable_thickness_mm') ?? 0)}
              ctx={fmCtx}
              onChange={(v) => onUpdateProp('gable_thickness_mm', v)} />
            <span className="text-muted-foreground" title="Lateral shift of the gable from the wall axis, in mm. Positive moves it to the right walking from the wall's start to its end — set it to half the difference in thickness to sit the gable flush with one face.">Gable offset (mm)</span>
            <FormulaInput
              value={Number(propVal('gable_offset_mm') ?? 0)}
              ctx={fmCtx}
              onChange={(v) => onUpdateProp('gable_offset_mm', v)} />
            {/* ── What the system builds the wall of: framing tuning for timber, panel limit for CLT ── */}
            {(() => {
              const wt = String(propVal('wall_type') ?? '');
              const prof = profileFor(resolveStructuralSystem(node, projectSystem));
              const showFraming = prof.inspector.framing || /^TF/i.test(wt);
              const showClt = prof.inspector.clt || /^CLT/i.test(wt);
              return (<>
                {showFraming && (<>
            <span className="text-muted-foreground" title="Draw this wall as studs and plates in 3D instead of a solid — only takes effect for a timber-frame wall (TF type or timber_frame system).">Show framing</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox"
                checked={propVal('show_framing') === 'True' || propVal('show_framing') === true}
                onChange={(e) => onUpdateProp('show_framing', e.target.checked ? 'True' : 'False')}
                style={{ width: 11, height: 11 }}
              />
              <span className="text-[11px]">studs &amp; plates</span>
            </label>
            <span className="text-muted-foreground" title="Centre-to-centre stud spacing in mm; 0 = 625.">Stud spacing (mm)</span>
            <FormulaInput
              value={Number(propVal('stud_spacing_mm') ?? 0)}
              ctx={fmCtx}
              onChange={(v) => onUpdateProp('stud_spacing_mm', v)} />
            <span className="text-muted-foreground" title="Stud section as a T-code in cm (T4.5x14.5). Empty = the deepest stud the wall thickness holds.">Stud section</span>
            <input
              type="text"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              placeholder="T4.5x14.5"
              value={(propVal('stud_section') as string) ?? ''}
              onChange={(e) => onUpdateProp('stud_section', e.target.value)}
            />
                </>)}
                {showClt && (<>
                  <span className="text-muted-foreground" title="Longest CLT panel the transport allows, in mm; the wall is split into equal pieces above it, never through an opening. 0 = 12000.">CLT max panel (mm)</span>
                  <FormulaInput
                    value={Number(propVal('clt_max_panel_mm') ?? 0)}
                    ctx={fmCtx}
                    onChange={(v) => onUpdateProp('clt_max_panel_mm', v)} />
                </>)}
              </>);
            })()}

            <span className="text-muted-foreground">Has Beam</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('has_beam') ?? 'True')}
              onChange={(e) => onUpdateProp('has_beam', e.target.value)}
            >
              <option value="True">True</option>
              <option value="False">False</option>
            </select>
            {(node.properties.has_beam === 'True' || node.properties.has_beam === true) && (<>
              <span className="text-muted-foreground">Beam Type</span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={(propVal('beam_type') as string) ?? ''}
                onChange={(e) => onUpdateProp('beam_type', e.target.value)}
              >
                <option value="">Default 0.25×0.25 m</option>
                {getGeometriesByFamily('beam').map((g) => (
                  <option key={g.id} value={g.id}>{g.label}</option>
                ))}
              </select>
              <span className="text-muted-foreground">Beam Material</span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={(propVal('beam_material') as string) ?? ''}
                onChange={(e) => onUpdateProp('beam_material', e.target.value || undefined)}
              >
                <option value="">(beam default)</option>
                {matConfig
                  ? Object.entries(matConfig.materials).map(([id, mat]) => (
                      <option key={id} value={id}>{(mat as { label?: string }).label ?? id}</option>
                    ))
                  : null}
              </select>
            </>)}

            <span className="text-muted-foreground col-span-2 text-[10px] uppercase tracking-wider pb-0.5 pt-1">Wall layers</span>
            <div className="col-span-2 flex flex-wrap gap-1 pb-1">
              {Object.entries(WALL_LAYER_PRESETS).map(([key, preset]) => (
                <button
                  key={key}
                  type="button"
                  className="px-2 py-0.5 rounded border border-border bg-muted/40 hover:bg-muted text-[10px]"
                  onClick={() => {
                    const wallH = getWallHeightMm(node.properties);
                    const layers = scaleWallLayerPreset(preset.layers, wallH);
                    onUpdateProp('wall_layers', serializeWallLayers(layers));
                    if (layers[0]?.material) onUpdateProp('material', layers[0].material);
                    if (layers[0]?.wall_type) onUpdateProp('wall_type', layers[0].wall_type);
                  }}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                className="px-2 py-0.5 rounded border border-dashed border-border hover:bg-muted text-[10px]"
                onClick={() => {
                  const wallH = getWallHeightMm(node.properties);
                  const layers = getEditableWallLayers(node.properties);
                  const lastTo = layers.length ? Number(layers[layers.length - 1].to_mm ?? wallH) : wallH;
                  const next: WallLayer[] = [
                    ...layers,
                    {
                      from_mm: lastTo,
                      to_mm: wallH,
                      material: String(node.properties.material ?? ''),
                      wall_type: String(node.properties.wall_type ?? 'W20'),
                    },
                  ];
                  onUpdateProp('wall_layers', serializeWallLayers(next));
                }}
              >
                + Strat
              </button>
            </div>
            {getEditableWallLayers(node.properties).map((layer, idx, all) => {
              const updateLayer = (patch: Partial<WallLayer>) => {
                const next = all.map((l, i) => (i === idx ? { ...l, ...patch } : l));
                onUpdateProp('wall_layers', serializeWallLayers(next));
                if (idx === 0) {
                  if (next[0]?.material) onUpdateProp('material', next[0].material);
                  if (next[0]?.wall_type) onUpdateProp('wall_type', next[0].wall_type);
                }
              };
              const layerColor = String(layer.color_3d ?? '').trim()
                || (layer.material && matConfig?.materials?.[layer.material]?.color_3d)
                || (matConfig?.element_defaults?.wall?.color_3d as string)
                || '#f59e0b';
              return (
                <React.Fragment key={`wall-layer-${idx}`}>
                  <span className="text-muted-foreground col-span-2 text-[10px] font-medium pt-1">
                    Strat {idx + 1} — {Number(layer.from_mm ?? 0)}–{Number(layer.to_mm ?? DEFAULT_WALL_HEIGHT_MM)} mm
                  </span>
                  <span className="text-muted-foreground">From (mm)</span>
                  <input type="number" step="50"
                    className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    value={Number(layer.from_mm ?? 0)}
                    onChange={(e) => updateLayer({ from_mm: parseFloat(e.target.value) || 0 })}
                  />
                  <span className="text-muted-foreground">To (mm)</span>
                  <input type="number" step="50"
                    className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    value={Number(layer.to_mm ?? DEFAULT_WALL_HEIGHT_MM)}
                    onChange={(e) => updateLayer({ to_mm: parseFloat(e.target.value) || 0 })}
                  />
                  <span className="text-muted-foreground">Wall type</span>
                  <select
                    className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    value={String(layer.wall_type ?? node.properties.wall_type ?? 'W20')}
                    onChange={(e) => updateLayer({ wall_type: e.target.value })}
                  >
                    {getGeometriesByFamily('wall').map((g) => (
                      <option key={g.id} value={g.id}>{g.label}</option>
                    ))}
                  </select>
                  <span className="text-muted-foreground">Material</span>
                  <select
                    className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    value={String(layer.material ?? '')}
                    onChange={(e) => updateLayer({ material: e.target.value || undefined })}
                  >
                    <option value="">(wall default)</option>
                    {matConfig
                      ? Object.entries(matConfig.materials).map(([id, mat]) => (
                          <option key={id} value={id}>{(mat as { label?: string }).label ?? id}</option>
                        ))
                      : null}
                  </select>
                  {/* Ce se decontează pe banda asta — BCA pe soclu, zidărie deasupra. */}
                  <ZoneSpecField
                    nodeType="wall"
                    value={(layer as { spec?: unknown }).spec}
                    onChange={(spec) => updateLayer({ spec } as Partial<WallLayer>)}
                  />
                  <span className="text-muted-foreground">Color</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      className="w-8 h-6 rounded border border-border cursor-pointer"
                      value={layerColor}
                      onChange={(e) => updateLayer({ color_3d: e.target.value })}
                    />
                    {layer.color_3d && (
                      <button
                        type="button"
                        className="text-[10px] text-muted-foreground hover:text-red-400"
                        title="Clear layer color override"
                        onClick={() => updateLayer({ color_3d: undefined })}
                      >
                        ✕
                      </button>
                    )}
                    {all.length > 1 && (
                      <button
                        type="button"
                        className="ml-auto text-[10px] text-muted-foreground hover:text-red-400"
                        onClick={() => {
                          const next = all.filter((_, i) => i !== idx);
                          onUpdateProp('wall_layers', serializeWallLayers(next));
                          if (next[0]?.material) onUpdateProp('material', next[0].material);
                          if (next[0]?.wall_type) onUpdateProp('wall_type', next[0].wall_type);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </React.Fragment>
              );
            })}

            {/* ── Inline Windows ─────────────────────────────────────── */}
            <span className="text-muted-foreground">Has Windows</span>
            <div className="flex items-center gap-1.5">
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs flex-1"
                value={String(propVal('has_windows') ?? 'False')}
                onChange={(e) => onUpdateProp('has_windows', e.target.value)}
              >
                <option value="True">True</option>
                <option value="False">False</option>
              </select>
              {(node.properties.has_windows === 'True' || node.properties.has_windows === true) && (
                <span className="text-sky-400 text-sm" title="Has inline windows">🪟</span>
              )}
            </div>

            {(node.properties.has_windows === 'True' || node.properties.has_windows === true) && (() => {
              const rawWins = node.properties.windows;
              const winList: Array<Record<string, unknown>> = (() => {
                try { return JSON.parse(rawWins as string ?? '[]') as Array<Record<string, unknown>>; } catch { return []; }
              })();
              const updateWins = (next: Array<Record<string, unknown>>) => onUpdateProp('windows', JSON.stringify(next));
              return (
                <div className="col-span-2 space-y-1.5">
                  {winList.map((w, idx) => (
                    <div key={String(w.id ?? idx)} className="bg-muted/30 border border-border rounded p-2 space-y-1">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Window {idx + 1}</span>
                        <button
                          className="text-[10px] text-red-400 hover:text-red-600 px-1"
                          onClick={() => updateWins(winList.filter((_, i) => i !== idx))}
                        >✕ Remove</button>
                      </div>
                      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 items-center">
                        <span className="text-muted-foreground text-[10px]">Type</span>
                        <select
                          className="bg-background border border-border rounded px-1 py-0.5 text-[10px]"
                          value={String(w.window_type ?? 'W-FIX-100x120')}
                          onChange={(e) => {
                            const wt = WINDOW_TYPE_MAP.get(e.target.value);
                            const n2 = [...winList];
                            n2[idx] = {
                              ...w,
                              window_type: e.target.value,
                              // Auto-set opening to library default; user can override below
                              opening: wt ? wt.opening : (w.opening ?? undefined),
                            };
                            updateWins(n2);
                          }}
                        >
                          {Array.from(WINDOW_TYPE_MAP.values()).map((wt) => (
                            <option key={wt.id} value={wt.id}>{wt.label}</option>
                          ))}
                        </select>
                        <span className="text-muted-foreground text-[10px]" title="DXF symbol used on the floor plan">Plan Symbol</span>
                        <select
                          className="bg-background border border-border rounded px-1 py-0.5 text-[10px]"
                          value={String(w.opening ?? '')}
                          onChange={(e) => { const n2 = [...winList]; n2[idx] = { ...w, opening: e.target.value === '' ? undefined : e.target.value }; updateWins(n2); }}
                        >
                          <option value="">Auto (din tip)</option>
                          <option value="none">Fixed Glazing</option>
                          <option value="single">Single Casement</option>
                          <option value="double">Double Casement</option>
                          <option value="tilt-turn">Tilt-Turn</option>
                        </select>
                        <span className="text-muted-foreground text-[10px]">Width (mm)</span>
                        <FormulaInput
                          className="text-[10px]"
                          value={Number(w.width ?? 1000)}
                          ctx={fmCtx}
                          onChange={(v) => { const n2 = [...winList]; n2[idx] = { ...w, width: v }; updateWins(n2); }} />
                        <span className="text-muted-foreground text-[10px]">Height (mm)</span>
                        <FormulaInput
                          className="text-[10px]"
                          value={Number(w.height ?? 1200)}
                          ctx={fmCtx}
                          onChange={(v) => { const n2 = [...winList]; n2[idx] = { ...w, height: v }; updateWins(n2); }} />
                        <span className="text-muted-foreground text-[10px]">Sill (mm)</span>
                        <FormulaInput
                          className="text-[10px]"
                          value={Number(w.sill_height ?? 900)}
                          ctx={fmCtx}
                          onChange={(v) => { const n2 = [...winList]; n2[idx] = { ...w, sill_height: v }; updateWins(n2); }} />
                        <span className="text-muted-foreground text-[10px]" title="Group offset (mm) — distance from wall start to the left edge of the first window. Empty = group centered on wall.">Group offset (mm)</span>
                        <input type="number" placeholder="auto" className="bg-background border border-border rounded px-1 py-0.5 text-[10px]"
                          value={w.wall_offset != null ? Number(w.wall_offset) : ''}
                          onChange={(e) => { const n2 = [...winList]; n2[idx] = { ...w, wall_offset: e.target.value === '' ? null : parseFloat(e.target.value) }; updateWins(n2); }} />
                        <span className="text-muted-foreground text-[10px]" title="Number of identical windows evenly distributed along the wall. 1 = single window.">Count</span>
                        <input type="number" min="1" max="20" step="1" className="bg-background border border-border rounded px-1 py-0.5 text-[10px]"
                          value={Number(w.count ?? 1)}
                          onChange={(e) => { const n2 = [...winList]; n2[idx] = { ...w, count: Math.max(1, Math.round(parseFloat(e.target.value))) }; updateWins(n2); }} />
                        {Number(w.count ?? 1) > 1 && (<>
                          <span className="text-muted-foreground text-[10px]" title="Clear gap (mm) between adjacent window edges. Empty = equal distribution.">Spacing (mm)</span>
                          <input type="number" min="0" step="50" placeholder="auto" className="bg-background border border-border rounded px-1 py-0.5 text-[10px]"
                            value={w.spacing != null ? Number(w.spacing) : ''}
                            onChange={(e) => { const n2 = [...winList]; n2[idx] = { ...w, spacing: e.target.value === '' ? null : Math.max(0, parseFloat(e.target.value)) }; updateWins(n2); }} />
                        </>)}
                        {/* Flip controls */}
                        <span className="text-muted-foreground text-[10px]" title="Mirror symbol across wall (inner ↔ outer face)">Flip across</span>
                        <button
                          className={cn(
                            'px-1.5 py-0.5 text-[10px] rounded border transition-colors',
                            (w.flip_across === true || w.flip_across === 'true' || w.flip_across === 'True')
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'bg-background border-border text-muted-foreground hover:bg-accent',
                          )}
                          onClick={() => { const n2 = [...winList]; n2[idx] = { ...w, flip_across: !(w.flip_across === true || w.flip_across === 'true' || w.flip_across === 'True') }; updateWins(n2); }}
                        >
                          {(w.flip_across === true || w.flip_across === 'true' || w.flip_across === 'True') ? '◆ Flipped' : '□ Normal'}
                        </button>
                        <span className="text-muted-foreground text-[10px]" title="Mirror symbol along wall (swap hinge/handle side)">Flip along</span>
                        <button
                          className={cn(
                            'px-1.5 py-0.5 text-[10px] rounded border transition-colors',
                            (w.flip_along === true || w.flip_along === 'true' || w.flip_along === 'True')
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'bg-background border-border text-muted-foreground hover:bg-accent',
                          )}
                          onClick={() => { const n2 = [...winList]; n2[idx] = { ...w, flip_along: !(w.flip_along === true || w.flip_along === 'true' || w.flip_along === 'True') }; updateWins(n2); }}
                        >
                          {(w.flip_along === true || w.flip_along === 'true' || w.flip_along === 'True') ? '◆ Flipped' : '□ Normal'}
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    className="w-full text-[10px] py-1 rounded border border-dashed border-sky-400 text-sky-500 hover:bg-sky-50 dark:hover:bg-sky-950 transition-colors"
                    onClick={() => updateWins([...winList, { id: `inl_win_${uid()}`, window_type: 'W-FIX-100x120', width: 1000, height: 1200, sill_height: 900, wall_offset: null, count: 1 }])}
                  >+ Add Window</button>
                </div>
              );
            })()}

            {/* ── Inline Doors ───────────────────────────────────────── */}
            <span className="text-muted-foreground">Has Doors</span>
            <div className="flex items-center gap-1.5">
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs flex-1"
                value={String(propVal('has_doors') ?? 'False')}
                onChange={(e) => onUpdateProp('has_doors', e.target.value)}
              >
                <option value="True">True</option>
                <option value="False">False</option>
              </select>
              {(node.properties.has_doors === 'True' || node.properties.has_doors === true) && (
                <span className="text-orange-400 text-sm" title="Has inline doors">🚪</span>
              )}
            </div>

            {(node.properties.has_doors === 'True' || node.properties.has_doors === true) && (() => {
              const rawDoors = node.properties.doors;
              const doorList: Array<Record<string, unknown>> = (() => {
                try { return JSON.parse(rawDoors as string ?? '[]') as Array<Record<string, unknown>>; } catch { return []; }
              })();
              const updateDoors = (next: Array<Record<string, unknown>>) => onUpdateProp('doors', JSON.stringify(next));
              return (
                <div className="col-span-2 space-y-1.5">
                  {doorList.map((d, idx) => (
                    <div key={String(d.id ?? idx)} className="bg-muted/30 border border-border rounded p-2 space-y-1">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Door {idx + 1}</span>
                        <button
                          className="text-[10px] text-red-400 hover:text-red-600 px-1"
                          onClick={() => updateDoors(doorList.filter((_, i) => i !== idx))}
                        >✕ Remove</button>
                      </div>
                      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 items-center">
                        <span className="text-muted-foreground text-[10px]">Type</span>
                        <select
                          className="bg-background border border-border rounded px-1 py-0.5 text-[10px]"
                          value={String(d.door_type ?? 'D-SWING-90x210')}
                          onChange={(e) => { const n2 = [...doorList]; n2[idx] = { ...d, door_type: e.target.value }; updateDoors(n2); }}
                        >
                          {Array.from(DOOR_TYPE_MAP.values()).map((dt) => (
                            <option key={dt.id} value={dt.id}>{dt.label}</option>
                          ))}
                        </select>
                        <span className="text-muted-foreground text-[10px]">Width (mm)</span>
                        <FormulaInput
                          className="text-[10px]"
                          value={Number(d.width ?? 900)}
                          ctx={fmCtx}
                          onChange={(v) => { const n2 = [...doorList]; n2[idx] = { ...d, width: v }; updateDoors(n2); }} />
                        <span className="text-muted-foreground text-[10px]">Height (mm)</span>
                        <FormulaInput
                          className="text-[10px]"
                          value={Number(d.height ?? 2100)}
                          ctx={fmCtx}
                          onChange={(v) => { const n2 = [...doorList]; n2[idx] = { ...d, height: v }; updateDoors(n2); }} />
                        <span className="text-muted-foreground text-[10px]" title="Group offset (mm) — distance from wall start to the left edge of the first door. Empty = group centered.">Group offset (mm)</span>
                        <input type="number" placeholder="auto" className="bg-background border border-border rounded px-1 py-0.5 text-[10px]"
                          value={d.wall_offset != null ? Number(d.wall_offset) : ''}
                          onChange={(e) => { const n2 = [...doorList]; n2[idx] = { ...d, wall_offset: e.target.value === '' ? null : parseFloat(e.target.value) }; updateDoors(n2); }} />
                        <span className="text-muted-foreground text-[10px]" title="Number of identical doors evenly distributed along the wall. 1 = single door.">Count</span>
                        <input type="number" min="1" max="20" step="1" className="bg-background border border-border rounded px-1 py-0.5 text-[10px]"
                          value={Number(d.count ?? 1)}
                          onChange={(e) => { const n2 = [...doorList]; n2[idx] = { ...d, count: Math.max(1, Math.round(parseFloat(e.target.value))) }; updateDoors(n2); }} />
                        {Number(d.count ?? 1) > 1 && (<>
                          <span className="text-muted-foreground text-[10px]" title="Clear gap (mm) between adjacent door edges. Empty = equal distribution.">Spacing (mm)</span>
                          <input type="number" min="0" step="50" placeholder="auto" className="bg-background border border-border rounded px-1 py-0.5 text-[10px]"
                            value={d.spacing != null ? Number(d.spacing) : ''}
                            onChange={(e) => { const n2 = [...doorList]; n2[idx] = { ...d, spacing: e.target.value === '' ? null : Math.max(0, parseFloat(e.target.value)) }; updateDoors(n2); }} />
                        </>)}
                        <span className="text-muted-foreground text-[10px]">Swing</span>
                        <select
                          className="bg-background border border-border rounded px-1 py-0.5 text-[10px]"
                          value={String(d.swing ?? 'left')}
                          onChange={(e) => { const n2 = [...doorList]; n2[idx] = { ...d, swing: e.target.value }; updateDoors(n2); }}
                        >
                          <option value="left">Left</option>
                          <option value="right">Right</option>
                          <option value="double">Double</option>
                          <option value="sliding">Sliding</option>
                        </select>
                      </div>
                    </div>
                  ))}
                  <button
                    className="w-full text-[10px] py-1 rounded border border-dashed border-orange-400 text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-950 transition-colors"
                    onClick={() => updateDoors([...doorList, { id: `inl_door_${uid()}`, door_type: 'D-SWING-90x210', width: 900, height: 2100, wall_offset: null, swing: 'left', count: 1 }])}
                  >+ Add Door</button>
                </div>
              );
            })()}
          </div>
        </PropSection>
      )}

      {node.type === 'slab' && (
        <PropSection label="Slab" icon="━">
          <select
            className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
            value={(propVal('slab_type') as string) ?? 'SLAB15'}
            onChange={(e) => { onUpdateProp('slab_type', e.target.value); onUpdateProp('slab_custom_mm', undefined); }}
          >
            {getGeometriesByFamily('slab').map((g) => (
              <option key={g.id} value={g.id}>{g.label}</option>
            ))}
          </select>
          {/* Custom thickness override */}
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center pt-0.5">
            <span className="text-muted-foreground">Custom thickness (mm)</span>
            <NumInput
              step={10}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.slab_custom_mm as number) ?? 0}
              placeholder="0 = use preset"
              onChange={(v) => onUpdateProp('slab_custom_mm', v > 0 ? v : undefined)}
            />
          </div>
          <div className="text-[10px] text-muted-foreground leading-relaxed">
            Custom thickness (mm) overrides the preset. Set to 0 to use preset.
          </div>
          {/* Slab Appearance */}
          <div className="pt-2 border-t border-border/50 space-y-1.5">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest block">Appearance</span>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
              <span className="text-muted-foreground">Label</span>
              <input type="text" className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                placeholder="Display name…" value={String(node.properties.label ?? '')}
                onChange={(e) => onUpdateProp('label', e.target.value || undefined)} />
              <span className="text-muted-foreground">Material</span>
              <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={String(propVal('material') ?? '')} onChange={(e) => onUpdateProp('material', e.target.value || undefined)}>
                <option value="">(slab default)</option>
                {matConfig ? Object.entries(matConfig.materials).map(([id, m]) => (<option key={id} value={id}>{(m as {label?:string}).label ?? id}</option>)) : null}
              </select>
              <span className="text-muted-foreground" title="3D color override — overrides material color in all 3D viewers">Color 3D</span>
              <div className="flex items-center gap-1">
                <input type="color" className="w-8 h-6 rounded border border-border cursor-pointer"
                  value={String(propVal('color_3d') || '#8b5cf6')}
                  onChange={(e) => onUpdateProp('color_3d', e.target.value)} />
                {propVal('color_3d') && <button className="text-[10px] text-muted-foreground hover:text-red-400" title="Clear override" onClick={() => onUpdateProp('color_3d', undefined)}>✕</button>}
              </div>
              <span className="text-muted-foreground" title="2D color override — overrides material color in floor plans and sections">Color 2D</span>
              <div className="flex items-center gap-1">
                <input type="color" className="w-8 h-6 rounded border border-border cursor-pointer"
                  value={String(propVal('color_2d') || '#cbd5e1')}
                  onChange={(e) => onUpdateProp('color_2d', e.target.value)} />
                {propVal('color_2d') && <button className="text-[10px] text-muted-foreground hover:text-red-400" title="Clear override" onClick={() => onUpdateProp('color_2d', undefined)}>✕</button>}
              </div>
            </div>
            <div className="flex gap-1 pt-0.5">
              <input type="text" className="flex-1 bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                placeholder="Name for library…" value={slabSaveName} onChange={(e) => setSlabSaveName(e.target.value)} />
              <button className="text-xs px-2 py-0.5 rounded bg-amber-500 hover:bg-amber-600 text-white font-semibold shrink-0"
                title="Save current slab config as a library preset"
                onClick={() => _saveSlabPreset(String(propVal('slab_type') ?? 'SLAB15'), (node.properties.slab_custom_mm as number) ?? 0)}>💾 Save</button>
            </div>
            {slabUserLib.length > 0 && (
              <div className="space-y-0.5">
                <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Saved presets</span>
                {slabUserLib.map((e) => (
                  <div key={e.id} className="flex items-center gap-1">
                    <button className="flex-1 text-left text-xs px-1.5 py-0.5 rounded bg-background border border-border hover:bg-accent truncate"
                      title={`Apply: ${e.slab_custom_mm ? `${e.slab_custom_mm}mm custom` : e.slab_type}${e.material ? ` · ${e.material}` : ''}`}
                      onClick={() => _applySlabPreset(e)}>{e.label}</button>
                    <button className="text-[10px] text-muted-foreground hover:text-red-400 px-0.5" title="Remove" onClick={() => _removeSlabPreset(e.id)}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </PropSection>
      )}

      {/* Window / Door properties */}
      {(node.type === 'window' || node.type === 'door') && (
        <PropSection label={node.type === 'window' ? 'Window' : 'Door'} icon={node.type === 'window' ? '□' : '◫'}>

          {/* Library type picker */}
          <LibraryTypePicker
            family={node.type as 'window' | 'door'}
            currentId={(node.properties[node.type === 'window' ? 'window_type' : 'door_type'] as string) ?? ''}
            onUpdateProp={onUpdateProp}
          />

          {/* Manual dimension overrides */}
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center pt-1">
            <span className="text-muted-foreground text-[10px] col-span-2 uppercase tracking-wider pb-0.5">Dimensions (override)</span>
            <span className="text-muted-foreground">Width (mm)</span>
            <input
              type="number"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.width as number) ?? (node.type === 'window' ? 1000 : 900)}
              onChange={(e) => onUpdateProp('width', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Height (mm)</span>
            <input
              type="number"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.height as number) ?? (node.type === 'window' ? 1200 : 2100)}
              onChange={(e) => onUpdateProp('height', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Sill (mm)</span>
            <input
              type="number"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.sill_height as number) ?? (node.type === 'window' ? 900 : 0)}
              onChange={(e) => onUpdateProp('sill_height', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground" title="Distance from wall start (axA) to opening centre, in mm. Leave empty to use canvas position.">Offset (mm)</span>
            <input
              type="number"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              placeholder="auto"
              value={node.properties.wall_offset != null ? (node.properties.wall_offset as number) : ''}
              onChange={(e) => {
                const v = e.target.value;
                onUpdateProp('wall_offset', v === '' ? undefined : parseFloat(v));
              }}
            />
            <span className="text-muted-foreground col-span-2 text-[10px] uppercase tracking-wider pb-0.5 pt-1">Plan Symbol Flip</span>
            {/* flip_across: mirrors about wall axis (inner ↔ outer face) */}
            <span className="text-muted-foreground" title="Flip symbol across wall (inner ↔ outer face). Affects both 2D plan and 3D.">Flip across wall</span>
            <button
              onClick={() => onUpdateProp('flip_across', !(node.properties.flip_across === true || node.properties.flip_across === 'true' || node.properties.flip_across === 'True'))}
              className={cn(
                'px-2 py-0.5 text-xs rounded border transition-colors',
                (node.properties.flip_across === true || node.properties.flip_across === 'true' || node.properties.flip_across === 'True')
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background border-border text-muted-foreground hover:bg-accent',
              )}
            >
              {(node.properties.flip_across === true || node.properties.flip_across === 'true' || node.properties.flip_across === 'True') ? '◆ Flipped' : '□ Normal'}
            </button>
            {/* flip_along: mirrors about perpendicular axis (swap hinge side) */}
            <span className="text-muted-foreground" title="Flip symbol along wall (swap hinge/handle side). Affects both 2D plan and 3D.">Flip along wall</span>
            <button
              onClick={() => onUpdateProp('flip_along', !(node.properties.flip_along === true || node.properties.flip_along === 'true' || node.properties.flip_along === 'True'))}
              className={cn(
                'px-2 py-0.5 text-xs rounded border transition-colors',
                (node.properties.flip_along === true || node.properties.flip_along === 'true' || node.properties.flip_along === 'True')
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background border-border text-muted-foreground hover:bg-accent',
              )}
            >
              {(node.properties.flip_along === true || node.properties.flip_along === 'true' || node.properties.flip_along === 'True') ? '◆ Flipped' : '□ Normal'}
            </button>
            {node.type === 'window' && (<>
              <span className="text-muted-foreground col-span-2 text-[10px] uppercase tracking-wider pb-0.5 pt-1">Plan Symbol</span>
              <span className="text-muted-foreground" title="Floor-plan representation symbol (DXF from symbols2d/). Auto = taken from window type.">Opening style</span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={String(node.properties.opening ?? '')}
                onChange={(e) => onUpdateProp('opening', e.target.value === '' ? undefined : e.target.value)}
              >
                <option value="">Auto (din tip)</option>
                <option value="none">Fixed Glazing (no sash)</option>
                <option value="single">Single Casement</option>
                <option value="double">Double Casement</option>
                <option value="tilt-turn">Tilt-Turn</option>
              </select>
            </>)}
            <span className="text-muted-foreground col-span-2 text-[10px] uppercase tracking-wider pb-0.5 pt-1">Void Cut</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.opening_profile as string) ?? 'box'}
              onChange={(e) => onUpdateProp('opening_profile', e.target.value === 'box' ? undefined : e.target.value)}
            >
              <option value="box">Box (rectangular)</option>
              <option value="arch">Arch (phase 2)</option>
              <option value="circle">Circle (phase 2)</option>
            </select>
            <span
              className="text-muted-foreground"
              title="Boolean cut depth (mm). Default 1000 mm — 500 mm on each face of the wall. Increase when the opening must also cut shell or covering geometry."
            >Cut Depth (mm)</span>
            <input
              type="number" step="100" min="50"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.cut_depth as number) ?? 1000}
              onChange={(e) => onUpdateProp('cut_depth', parseFloat(e.target.value))}
            />
            <span
              className="text-muted-foreground"
              title="Number of identical windows distributed evenly along the wall. Default 1. When N > 1, the wall is split into N+1 equal segments and one window is placed at the centre of each gap."
            >Count</span>
            <input
              type="number" step="1" min="1" max="20"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.count as number) ?? 1}
              onChange={(e) => onUpdateProp('count', Math.max(1, Math.round(parseFloat(e.target.value))))}
            />
            {((node.properties.count as number) ?? 1) > 1 && (<>
              <span
                className="text-muted-foreground"
                title="Clear gap (mm) between adjacent window edges when Count > 1. Empty = automatic equal distribution."
              >Spacing (mm)</span>
              <input
                type="number" step="50" min="0"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                placeholder="auto"
                value={node.properties.spacing != null ? (node.properties.spacing as number) : ''}
                onChange={(e) => {
                  const v = e.target.value;
                  onUpdateProp('spacing', v === '' ? undefined : Math.max(0, parseFloat(v)));
                }}
              />
            </>)}
          </div>
        </PropSection>
      )}

      {/* Room properties */}
      {node.type === 'room' && (
        <PropSection label="Room" icon="◻">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground">Height (mm)</span>
            <input
              type="number" step="50"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.height as number) ?? DEFAULT_ROOM_HEIGHT_MM}
              onChange={(e) => {
                const h = parseFloat(e.target.value);
                onUpdateProp('height', h);
                const layers = getEditableCoveringLayers(node.properties);
                if (layers.length > 0) {
                  const last = layers.length - 1;
                  const next = layers.map((l, i) => (i === last ? { ...l, to_mm: h } : l));
                  onUpdateProp('covering_layers', serializeCoveringLayers(next));
                  onUpdateProp('covering_height', h);
                }
              }}
            />
            <span
              className="text-muted-foreground"
              title="Contour offset (mm). Negative = inward (inset). A single value (e.g. -125) applies to all edges. A list with ';' or ',' (e.g. -125;-100;-50) applies per edge in index order; the last value repeats if the list is shorter."
            >Contour offset (mm)</span>
            <input
              type="text"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              placeholder="-125 or -125;-100;-50"
              value={(node.properties.contour_offset as string ?? node.properties.contour_offset as number ?? '')}
              onChange={(e) => onUpdateProp('contour_offset', e.target.value || undefined)}
            />
            <span className="text-muted-foreground">Has Slab</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(node.properties.has_slab ?? 'True')}
              onChange={(e) => onUpdateProp('has_slab', e.target.value)}
            >
              <option value="True">True</option>
              <option value="False">False</option>
            </select>
            {(node.properties.has_slab !== 'False' && node.properties.has_slab !== false) && (<>
              <span className="text-muted-foreground">Slab Type</span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={(node.properties.slab_type as string) ?? 'SLAB15'}
                onChange={(e) => onUpdateProp('slab_type', e.target.value)}
              >
                {getGeometriesByFamily('slab').map((g) => (
                  <option key={g.id} value={g.id}>{g.label}</option>
                ))}
              </select>
              <span className="text-muted-foreground">Slab Material</span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={(node.properties.slab_material as string) ?? ''}
                onChange={(e) => onUpdateProp('slab_material', e.target.value || undefined)}
              >
                <option value="">(slab default)</option>
                {matConfig
                  ? Object.entries(matConfig.materials).map(([id, mat]) => (
                      <option key={id} value={id}>{(mat as { label?: string }).label ?? id}</option>
                    ))
                  : null}
              </select>
              <span className="text-muted-foreground" title="Usage category for the imposed (live) floor load used by the Structural (FEM) module — SR EN 1991-1-1 categories.">
                Live Load
              </span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={(node.properties.room_load_category as string) ?? DEFAULT_ROOM_LOAD_CATEGORY}
                onChange={(e) => onUpdateProp('room_load_category', e.target.value)}
              >
                {Object.entries(ROOM_LOAD_LABELS).map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </>)}
            <span className="text-muted-foreground">Has Covering</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(node.properties.has_covering ?? 'True')}
              onChange={(e) => onUpdateProp('has_covering', e.target.value)}
            >
              <option value="True">True</option>
              <option value="False">False</option>
            </select>
            {(node.properties.has_covering !== 'False' && node.properties.has_covering !== false) && (<>
              <span
                className="text-muted-foreground"
                title="Covering contour offset (mm). Negative = inward. Default: −125 mm."
              >Cov. Offset (mm)</span>
              <input type="text"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                placeholder="-125 or -125;-100;-50"
                value={(node.properties.covering_offset as string ?? '')}
                onChange={(e) => onUpdateProp('covering_offset', e.target.value || undefined)}
              />
              <span className="text-muted-foreground col-span-2 text-[10px] uppercase tracking-wider pb-0.5 pt-1">Covering layers</span>
              <div className="col-span-2 flex flex-wrap gap-1 pb-1">
                {Object.entries(COVERING_PRESETS).map(([key, preset]) => (
                  <button
                    key={key}
                    type="button"
                    className="px-2 py-0.5 rounded border border-border bg-muted/40 hover:bg-muted text-[10px]"
                    onClick={() => {
                      const roomH = getRoomHeightMm(node.properties);
                      const layers = scaleCoveringPreset(preset.layers, roomH);
                      onUpdateProp('covering_layers', serializeCoveringLayers(layers));
                      const summary = syncCoveringSummaryProps(layers);
                      onUpdateProp('covering_height', summary.covering_height);
                      onUpdateProp('covering_thickness', summary.covering_thickness);
                      if (summary.covering_material) onUpdateProp('covering_material', summary.covering_material);
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="px-2 py-0.5 rounded border border-dashed border-border hover:bg-muted text-[10px]"
                  onClick={() => {
                    const roomH = getRoomHeightMm(node.properties);
                    const layers = getEditableCoveringLayers(node.properties);
                    const lastTo = layers.length ? Number(layers[layers.length - 1].to_mm ?? roomH) : roomH;
                    const next: RoomCoveringLayer[] = [
                      ...layers,
                      { from_mm: lastTo, to_mm: roomH, thickness_mm: DEFAULT_COVERING_THICKNESS_MM, material: '' },
                    ];
                    onUpdateProp('covering_layers', serializeCoveringLayers(next));
                  }}
                >
                  + Strat
                </button>
              </div>
              {getEditableCoveringLayers(node.properties).map((layer, idx, all) => {
                const updateLayer = (patch: Partial<RoomCoveringLayer>) => {
                  const next = all.map((l, i) => (i === idx ? { ...l, ...patch } : l));
                  onUpdateProp('covering_layers', serializeCoveringLayers(next));
                  const summary = syncCoveringSummaryProps(next);
                  onUpdateProp('covering_height', summary.covering_height);
                  onUpdateProp('covering_thickness', summary.covering_thickness);
                };
                const layerColor = String(layer.color_3d ?? '').trim()
                  || (layer.material && matConfig?.materials?.[layer.material]?.color_3d)
                  || (matConfig?.element_defaults?.covering?.color_3d as string)
                  || '#F43F5E';
                return (
                  <React.Fragment key={`cov-layer-${idx}`}>
                    <span className="text-muted-foreground col-span-2 text-[10px] font-medium pt-1">
                      Strat {idx + 1} — {Number(layer.from_mm ?? 0)}–{Number(layer.to_mm ?? DEFAULT_COVERING_HEIGHT_MM)} mm
                    </span>
                    <span className="text-muted-foreground">From (mm)</span>
                    <input type="number" step="50"
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={Number(layer.from_mm ?? 0)}
                      onChange={(e) => updateLayer({ from_mm: parseFloat(e.target.value) || 0 })}
                    />
                    <span className="text-muted-foreground">To (mm)</span>
                    <input type="number" step="50"
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={Number(layer.to_mm ?? DEFAULT_COVERING_HEIGHT_MM)}
                      onChange={(e) => updateLayer({ to_mm: parseFloat(e.target.value) || 0 })}
                    />
                    <span className="text-muted-foreground">Thickness (mm)</span>
                    <input type="number" step="1"
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={Number(layer.thickness_mm ?? DEFAULT_COVERING_THICKNESS_MM)}
                      onChange={(e) => updateLayer({ thickness_mm: parseFloat(e.target.value) || DEFAULT_COVERING_THICKNESS_MM })}
                    />
                    <span className="text-muted-foreground">Material</span>
                    <select
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={String(layer.material ?? '')}
                      onChange={(e) => updateLayer({ material: e.target.value || undefined })}
                    >
                      <option value="">(covering default)</option>
                      {matConfig
                        ? Object.entries(matConfig.materials).map(([id, mat]) => (
                            <option key={id} value={id}>{(mat as { label?: string }).label ?? id}</option>
                          ))
                        : null}
                    </select>
                    {/* Ce se decontează pe banda asta — faianță jos, tencuială sus. */}
                    <ZoneSpecField
                      nodeType="room"
                      value={(layer as { spec?: unknown }).spec}
                      onChange={(spec) => updateLayer({ spec } as Partial<RoomCoveringLayer>)}
                    />
                    <span className="text-muted-foreground">Color</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        className="w-8 h-6 rounded border border-border cursor-pointer"
                        value={layerColor}
                        onChange={(e) => updateLayer({ color_3d: e.target.value })}
                      />
                      {layer.color_3d && (
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground hover:text-red-400"
                          title="Clear layer color override"
                          onClick={() => updateLayer({ color_3d: undefined })}
                        >
                          ✕
                        </button>
                      )}
                      {all.length > 1 && (
                        <button
                          type="button"
                          className="ml-auto text-[10px] text-muted-foreground hover:text-red-400"
                          onClick={() => {
                            const next = all.filter((_, i) => i !== idx);
                            onUpdateProp('covering_layers', serializeCoveringLayers(next));
                            const summary = syncCoveringSummaryProps(next);
                            onUpdateProp('covering_height', summary.covering_height);
                            onUpdateProp('covering_thickness', summary.covering_thickness);
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </React.Fragment>
                );
              })}
            </>)}
            {/* Room individual color */}
            <span className="text-muted-foreground col-span-2 text-[10px] uppercase tracking-wider pb-0.5 pt-1">Appearance</span>
            <span className="text-muted-foreground" title="Individual display color for this room in all views. Leave blank to use the global Room material color.">Color</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                className="w-8 h-6 rounded border border-border cursor-pointer"
                value={(node.properties.color as string)?.trim() || (matConfig?.element_defaults?.room?.color_3d as string) || '#14b8a6'}
                onChange={(e) => onUpdateProp('color', e.target.value)}
              />
              {(node.properties.color as string)?.trim() && (
                <button
                  className="text-[10px] text-muted-foreground hover:text-destructive px-1 transition-colors"
                  onClick={() => onUpdateProp('color', '')}
                  title="Reset to global Room material color"
                >✕ reset</button>
              )}
            </div>
          </div>
        </PropSection>
      )}

      {/* Void properties */}
      {node.type === 'void' && (
        <PropSection label="Void" icon="▣">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground">Shape</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.void_shape as string) ?? 'box'}
              onChange={(e) => onUpdateProp('void_shape', e.target.value)}
            >
              <option value="box">Box</option>
              <option value="cylinder">Cylinder</option>
            </select>

            {((node.properties.void_shape as string) ?? 'box') !== 'cylinder' && (<>
              <span className="text-muted-foreground">Width (mm)</span>
              <FormulaInput
                value={(node.properties.width as number | string) ?? 500}
                step={50}
                onChange={(v) => onUpdateProp('width', v)}
                ctx={fmCtx}
              />
              <span className="text-muted-foreground">Height (mm)</span>
              <FormulaInput
                value={(node.properties.height as number | string) ?? 500}
                step={50}
                onChange={(v) => onUpdateProp('height', v)}
                ctx={fmCtx}
              />
              <span className="text-muted-foreground">Depth (mm)</span>
              <FormulaInput
                value={(node.properties.depth as number | string) ?? 500}
                step={50}
                onChange={(v) => onUpdateProp('depth', v)}
                ctx={fmCtx}
              />
            </>)}

            {(node.properties.void_shape as string) === 'cylinder' && (<>
              <span className="text-muted-foreground">Radius (mm)</span>
              <FormulaInput
                value={(node.properties.radius as number | string) ?? 250}
                step={25}
                onChange={(v) => onUpdateProp('radius', v)}
                ctx={fmCtx}
              />
              <span className="text-muted-foreground">Height (mm)</span>
              <FormulaInput
                value={(node.properties.height as number | string) ?? 500}
                step={50}
                onChange={(v) => onUpdateProp('height', v)}
                ctx={fmCtx}
              />
              <span className="text-muted-foreground">Facets</span>
              <input
                type="number" min={4} max={64} step={4}
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={(node.properties.radial_segments as number) ?? 16}
                onChange={(e) => onUpdateProp('radial_segments', parseInt(e.target.value, 10))}
              />
            </>)}

            <span className="text-muted-foreground col-span-2 text-[10px] uppercase tracking-wider pb-0.5 pt-1">Offset from host (mm)</span>
            <span className="text-muted-foreground">Offset X (East)</span>
            <FormulaInput
              value={(node.properties.offset_x as number | string) ?? 0}
              step={50}
              onChange={(v) => onUpdateProp('offset_x', v)}
              ctx={fmCtx}
            />
            <span className="text-muted-foreground">Offset Y (North)</span>
            <FormulaInput
              value={(node.properties.offset_y as number | string) ?? 0}
              step={50}
              onChange={(v) => onUpdateProp('offset_y', v)}
              ctx={fmCtx}
            />
            <span className="text-muted-foreground">Offset Z (Up)</span>
            <FormulaInput
              value={(node.properties.offset_z as number | string) ?? 0}
              step={50}
              onChange={(v) => onUpdateProp('offset_z', v)}
              ctx={fmCtx}
            />
          </div>
        </PropSection>
      )}

      {/* Shell properties */}
      {node.type === 'shell' && (
        <PropSection label="Shell" icon="◡">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground" title="Ce reprezintă conturul — decide ce cantități produce și pe ce norme se decontează">Rol</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={shellRole(node)}
              onChange={(e) => onUpdateProp('shell_role', e.target.value)}
            >
              {SHELL_ROLES.map((r) => (
                <option key={r} value={r}>{SHELL_ROLE_LABELS[r]}</option>
              ))}
            </select>
            <span className="text-muted-foreground">Height (mm)</span>
            <input type="number" step="50"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.height as number) ?? 2800}
              onChange={(e) => onUpdateProp('height', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Thickness (mm)</span>
            <input type="number" step="25"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.thickness as number) ?? 200}
              onChange={(e) => onUpdateProp('thickness', parseFloat(e.target.value))}
            />
            <span
              className="text-muted-foreground"
              title="Contour offset (mm). Negative = inward. Per-edge list with ';' or ','"
            >Contour offset (mm)</span>
            <input type="text"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              placeholder="-125 or -125;-100;-50"
              value={(node.properties.contour_offset as string ?? '')}
              onChange={(e) => onUpdateProp('contour_offset', e.target.value || undefined)}
            />
            {/* Clima stă pe anvelopă, nu pe aplicație: e o proprietate a clădirii,
                se salvează cu proiectul, și se vede lângă ce descrie. */}
            <span
              className="text-muted-foreground"
              title="Localitatea de calcul — dă gradele-zile din care iese necesarul de încălzire. Valori orientative."
            >Climă</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(node.properties.climate_site ?? DEFAULT_SITE.id)}
              onChange={(e) => onUpdateProp('climate_site', e.target.value)}
            >
              {CLIMATE.map((c) => (
                <option key={c.id} value={c.id}>{c.label} — {c.degreeDays} K·zi</option>
              ))}
            </select>
          </div>
          <ShellZonesEditor
            value={node.properties.shell_zones}
            heightMm={Number(node.properties.height ?? 2800)}
            onChange={(v) => onUpdateProp('shell_zones', v)}
          />
          <div className="text-[10px] text-muted-foreground">
            {SHELL_ROLE_HINTS[shellRole(node)]}
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Conturul vine din nodurile <em>ax</em> legate la shell. Nodurile <em>cell</em>
            dinăuntrul lui sunt goluri: plinul = aria conturului minus ariile celulelor,
            iar din el ies aria tălpii, volumul și fețele de cofrat.
          </div>
        </PropSection>
      )}

      {/* Roof properties (parametric envelope → skeleton → framing) */}
      {node.type === 'roof' && (
        <PropSection label="Roof" icon="△">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground">Type</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('roof_type') ?? 'gable')}
              onChange={(e) => onUpdateProp('roof_type', e.target.value)}
            >
              <option value="gable">Gable (două ape)</option>
              <option value="hip">Hip (patru ape)</option>
              <option value="shed">Shed (o apă)</option>
              <option value="flat">Flat</option>
              <option value="mansard">Mansard (2 pante)</option>
            </select>
            <span className="text-muted-foreground">Pitch (°)</span>
            <input type="number" step="1" min={1} max={75}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('pitch_deg') ?? 30)}
              onChange={(e) => onUpdateProp('pitch_deg', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground" title="Degajarea streașinii, uniformă pe tot conturul. Pozitiv = extinde spre exterior (streașină peste zid); negativ = retrage uniform spre interior.">Overhang (mm) ↔</span>
            <input type="number" step="50"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('overhang_mm') ?? 400)}
              onChange={(e) => onUpdateProp('overhang_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground" title="Ridicare verticală suplimentară a feței de acoperiș (țigla) peste degajarea automată de deasupra căpriorilor.">Covering offset (mm) ↑</span>
            <input type="number" step="10" min={0}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('covering_offset_mm') ?? 0)}
              onChange={(e) => onUpdateProp('covering_offset_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground" title="Cota streașinii față de cota superioară a etajului. Negativ = streașina coboară sub coronament (acoperiș care reazemă pe ziduri și trece peste o prispă).">Eave Z (mm) ↕</span>
            <input type="number" step="50"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('eave_z_offset_mm') ?? 0)}
              onChange={(e) => onUpdateProp('eave_z_offset_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Ridge dir</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('ridge_direction') ?? 'auto')}
              onChange={(e) => onUpdateProp('ridge_direction', e.target.value)}
            >
              <option value="auto">Auto (long axis)</option>
              <option value="x">Along X</option>
              <option value="y">Along Y</option>
            </select>
            <span className="text-muted-foreground">Ridge offset</span>
            <input type="number" step="50"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('ridge_offset_mm') ?? 0)}
              onChange={(e) => onUpdateProp('ridge_offset_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Rafter spacing</span>
            <input type="number" step="50" min={300}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('rafter_spacing_mm') ?? 600)}
              onChange={(e) => onUpdateProp('rafter_spacing_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Rafter §</span>
            <input type="text"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('rafter_section') ?? 'T8x16')}
              onChange={(e) => onUpdateProp('rafter_section', e.target.value)}
            />
            <span className="text-muted-foreground">Ridge §</span>
            <input type="text"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('ridge_section') ?? 'T10x20')}
              onChange={(e) => onUpdateProp('ridge_section', e.target.value)}
            />
            <span className="text-muted-foreground">Post §</span>
            <input type="text"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('post_section') ?? 'T10x10')}
              onChange={(e) => onUpdateProp('post_section', e.target.value)}
            />

            {/* Appearance. The covering is what you SEE — the roof surface takes
                its colour from here, while `material` stays the framing timber. */}
            <span className="text-muted-foreground" title="Materialul învelitorii — dă culoarea feței de acoperiș. Se ia din setările de materiale.">Covering mat.</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('covering_material') ?? '')}
              onChange={(e) => onUpdateProp('covering_material', e.target.value || undefined)}
            >
              <option value="">— roof default —</option>
              {Object.entries(matConfig?.materials ?? {}).map(([id, m]) => (
                <option key={id} value={id}>{(m as { label?: string }).label ?? id}</option>
              ))}
              {/* A value typed elsewhere (or a legacy name) must stay visible
                  rather than silently reading as "roof default". */}
              {Boolean(propVal('covering_material'))
                && !matConfig?.materials?.[String(propVal('covering_material'))] && (
                <option value={String(propVal('covering_material'))}>
                  {String(propVal('covering_material'))} (unknown)
                </option>
              )}
            </select>
            <span className="text-muted-foreground" title="Suprascrie culoarea 3D doar pentru acest acoperiș.">Color 3D</span>
            <div className="flex items-center gap-1">
              <input type="color"
                className="w-6 h-6 rounded cursor-pointer border-0 p-0 bg-transparent"
                value={String(propVal('color_3d') || matConfig?.element_defaults?.roof?.color_3d || '#c2410c')}
                onChange={(e) => onUpdateProp('color_3d', e.target.value)} />
              {Boolean(propVal('color_3d')) && (
                <button className="text-[10px] text-muted-foreground hover:text-red-400"
                  title="Clear override" onClick={() => onUpdateProp('color_3d', undefined)}>✕</button>
              )}
            </div>

            {/* Two-pitch mansard params */}
            {String(propVal('roof_type') ?? 'gable') === 'mansard' && (
              <>
                <span className="text-muted-foreground" title="Panta apei superioare (mai lină). Panta de sus.">Upper pitch (°)</span>
                <input type="number" step="1" min={1} max={70}
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('upper_pitch_deg') ?? 15)}
                  onChange={(e) => onUpdateProp('upper_pitch_deg', parseFloat(e.target.value))}
                />
                <span className="text-muted-foreground" title="Retragere orizontală (mm) de la streașină până la linia de frângere.">Break inset (mm)</span>
                <input type="number" step="100" min={300}
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('mansard_break_inset_mm') ?? 1500)}
                  onChange={(e) => onUpdateProp('mansard_break_inset_mm', parseFloat(e.target.value))}
                />
              </>
            )}

            {/* Structural system */}
            <span className="text-muted-foreground" title="Sistem: căpriori simpli, pane, sau ferme.">System</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('system') ?? 'rafter')}
              onChange={(e) => onUpdateProp('system', e.target.value)}
            >
              <option value="rafter">Rafter (căpriori)</option>
              <option value="purlin">Purlin (pane)</option>
              <option value="truss">Truss (ferme)</option>
            </select>
            {String(propVal('system') ?? 'rafter') === 'truss' && (
              <>
                <span className="text-muted-foreground">Truss spacing (mm)</span>
                <input type="number" step="100" min={1200}
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('truss_spacing_mm') ?? 3000)}
                  onChange={(e) => onUpdateProp('truss_spacing_mm', parseFloat(e.target.value))}
                />
              </>
            )}
            {String(propVal('system') ?? 'rafter') === 'purlin' && (
              <>
                <span className="text-muted-foreground">Purlin spacing (mm)</span>
                <input type="number" step="100" min={600}
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('purlin_spacing_mm') ?? 1200)}
                  onChange={(e) => onUpdateProp('purlin_spacing_mm', parseFloat(e.target.value))}
                />
                <span className="text-muted-foreground" title="Distanța între fermele/cadrele principale care poartă panele.">Frame spacing (mm)</span>
                <input type="number" step="100" min={1200}
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('truss_spacing_mm') ?? 3000)}
                  onChange={(e) => onUpdateProp('truss_spacing_mm', parseFloat(e.target.value))}
                />
              </>
            )}
          </div>

          {/* ── Detail layers (opt-in generated elements) ── */}
          <details className="mt-2 border-t border-border pt-2">
            <summary className="text-xs text-foreground cursor-pointer select-none font-medium">
              Detail layers ({[
                'gen_membrane', 'gen_sheathing', 'gen_insulation', 'gen_counter_battens', 'gen_battens',
                'gen_fascia', 'gen_barge_board', 'gen_soffit', 'gen_ridge_caps', 'gen_hip_caps',
                'gen_valley_flashing', 'gen_gutters', 'gen_downpipes', 'gen_snow_guards', 'gen_collar_ties',
              ].filter(boolProp).length} on)
            </summary>
            <div className="mt-1.5 flex flex-col gap-2 text-xs">
              {([
                ['Covering', [
                  ['gen_membrane', 'Membrane (folie)'],
                  ['gen_sheathing', 'Sheathing (astereală)', 'sheathing_thickness_mm', 24],
                  ['gen_insulation', 'Insulation (termoizolație)', 'insulation_thickness_mm', 200],
                ]],
                ['Battens', [
                  ['gen_counter_battens', 'Counter-battens (contrașipci)', 'counter_batten_spacing_mm', 600],
                  ['gen_battens', 'Battens (șipci)', 'batten_spacing_mm', 350],
                ]],
                ['Edge trim', [
                  ['gen_fascia', 'Fascia (bordură streașină)', 'fascia_height_mm', 200],
                  ['gen_barge_board', 'Barge board (fronton)'],
                  ['gen_soffit', 'Soffit (căptușeală)'],
                ]],
                ['Ridge / hip / valley', [
                  ['gen_ridge_caps', 'Ridge caps (coame)', 'ridge_cap_width_mm', 250],
                  ['gen_hip_caps', 'Hip caps'],
                  ['gen_valley_flashing', 'Valley flashing (șorț dolie)', 'valley_flashing_width_mm', 400],
                ]],
                ['Drainage', [
                  ['gen_gutters', 'Gutters (jgheaburi)', 'gutter_diameter_mm', 150],
                  ['gen_downpipes', 'Downpipes (burlane)', 'downpipe_spacing_mm', 8000],
                  ['gen_snow_guards', 'Snow guards (parazăpezi)', 'snow_guard_spacing_mm', 800],
                ]],
                ['Structure', [
                  ['gen_collar_ties', 'Collar ties (clești)', 'collar_height_ratio', 0.6],
                ]],
              ] as [string, [string, string, string?, number?][]][]).map(([group, rows]) => (
                <div key={group}>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">{group}</div>
                  {rows.map(([flag, label, paramKey, paramDefault]) => (
                    <div key={flag} className="flex items-center gap-1.5 py-0.5">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={boolProp(flag)}
                        onChange={(e) => onUpdateProp(flag, e.target.checked)}
                      />
                      <span className="text-muted-foreground flex-1">{label}</span>
                      {paramKey && boolProp(flag) && (
                        <input
                          type="number"
                          step={paramKey === 'collar_height_ratio' ? '0.05' : '10'}
                          className="w-16 bg-background border border-border rounded px-1 py-0.5 text-xs"
                          value={Number(propVal(paramKey) ?? paramDefault)}
                          onChange={(e) => onUpdateProp(paramKey, parseFloat(e.target.value))}
                        />
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </details>

          <div className="flex flex-col gap-1 mt-2">
            <button
              type="button"
              className="w-full text-xs bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded px-2 py-1.5 transition-colors font-semibold"
              onClick={() => onGenerateRoof?.('framing')}
            >
              Generate complete roof
            </button>
            <button
              type="button"
              className="w-full text-xs border border-border hover:bg-accent rounded px-2 py-1.5 transition-colors text-muted-foreground"
              onClick={() => onGenerateRoof?.('envelope')}
            >
              Envelope only (faces + ridge)
            </button>
            <button
              type="button"
              className="w-full text-xs border border-border hover:bg-accent rounded px-2 py-1.5 transition-colors text-muted-foreground"
              onClick={() => onGenerateRoof?.('skeleton')}
            >
              Skeleton markers only
            </button>
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Complete = envelope + coamă + căpriori + popi + cosoroabe + covering.
            Contur din pereți storey sau ≥3 ax conectate.
            {propVal('face_count') != null && <> · {String(propVal('face_count'))} fețe</>}
            {propVal('member_count') != null && <> · {String(propVal('member_count'))} elemente</>}
          </div>
        </PropSection>
      )}

      {/* Stairwell — steps are solved from the storey height, so the read-outs
          below are results, not inputs. */}
      {node.type === 'stairwell' && (
        <PropSection label="Stairwell" icon="◱">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground">Type</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('stair_type') ?? 'straight')}
              onChange={(e) => onUpdateProp('stair_type', e.target.value)}
            >
              <option value="straight">Straight (rampă dreaptă)</option>
              <option value="l_shape">L — quarter turn (întoarcere la 90°)</option>
              <option value="u_shape">U — half turn (întoarcere la 180°)</option>
              <option value="spiral">Spiral (scară circulară)</option>
            </select>

            <span className="text-muted-foreground">Width (mm)</span>
            <input type="number" step="50" min={600}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('width_mm') ?? 1000)}
              onChange={(e) => onUpdateProp('width_mm', parseFloat(e.target.value))}
            />

            <span
              className="text-muted-foreground"
              title={Number(propVal('boundary_ax_count') ?? 0) >= 3
                ? 'Direcția vine din casa scării desenată cu axe. Mută nodul în colțul de unde vrei să urci ca să o întorci.'
                : 'Direcția primei rampe, grade CCW de la axa X.'}
            >
              Direction (°)
            </span>
            {Number(propVal('boundary_ax_count') ?? 0) >= 3 ? (
              <span className="text-[11px] text-muted-foreground italic px-1.5">
                {String(propVal('solved_direction_deg') ?? 0)}° — din contur
              </span>
            ) : (
              <input type="number" step="15"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={Number(propVal('direction_deg') ?? 0)}
                onChange={(e) => onUpdateProp('direction_deg', parseFloat(e.target.value))}
              />
            )}

            {String(propVal('stair_type') ?? 'straight') !== 'straight' && (
              <>
                <span className="text-muted-foreground">Turn</span>
                <select
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={String(propVal('turn') ?? 'left')}
                  onChange={(e) => onUpdateProp('turn', e.target.value)}
                >
                  <option value="left">Left (spre stânga, urcând)</option>
                  <option value="right">Right (spre dreapta)</option>
                </select>
              </>
            )}

            {['l_shape', 'u_shape'].includes(String(propVal('stair_type') ?? 'straight')) && (
              <>
                <span className="text-muted-foreground" title="Podest drept, sau trepte balansate care urcă prin colț.">Turn style</span>
                <select
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={String(propVal('turn_style') ?? 'landing')}
                  onChange={(e) => onUpdateProp('turn_style', e.target.value)}
                >
                  <option value="landing">Podest drept</option>
                  <option value="winder">Evantai (trepte balansate)</option>
                </select>

                {String(propVal('turn_style') ?? 'landing') === 'winder' ? (
                  <>
                    <span className="text-muted-foreground" title="Câte trepte balansate fac întoarcerea. Fiecare urcă o contratreaptă.">Winders</span>
                    <input type="number" step="1" min={1} max={12}
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={Number(propVal('winder_count') ?? 3)}
                      onChange={(e) => onUpdateProp('winder_count', parseFloat(e.target.value))}
                    />
                  </>
                ) : (
                  <>
                    <span className="text-muted-foreground" title="0 = cât lățimea rampei, care este regula uzuală.">Landing depth</span>
                    <input type="number" step="50" min={0}
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                      value={Number(propVal('landing_depth_mm') ?? 0)}
                      onChange={(e) => onUpdateProp('landing_depth_mm', parseFloat(e.target.value))}
                    />
                  </>
                )}
              </>
            )}

            {String(propVal('stair_type') ?? 'straight') === 'spiral' && (
              <>
                <span className="text-muted-foreground" title="Raza stâlpului central. 0 = fără stâlp, gol în centru.">Pole radius</span>
                <input type="number" step="25" min={0}
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('spiral_inner_mm') ?? 100)}
                  onChange={(e) => onUpdateProp('spiral_inner_mm', parseFloat(e.target.value))}
                />
                <span className="text-muted-foreground" title="Trepte-pană suprapuse (segmente prefabricate) sau o turnare continuă: placă elicoidală cu treptele deasupra.">Structure</span>
                <select
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={String(propVal('spiral_structure') ?? 'steps')}
                  onChange={(e) => onUpdateProp('spiral_structure', e.target.value)}
                >
                  <option value="steps">Trepte suprapuse (prefab)</option>
                  <option value="monolithic">Beton monolit (elicoidal)</option>
                </select>
              </>
            )}

            <span className="text-muted-foreground" title="Auto împarte înălțimea etajului în contratrepte egale.">Sizing</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('sizing') ?? 'auto')}
              onChange={(e) => onUpdateProp('sizing', e.target.value)}
            >
              <option value="auto">Auto from storey height</option>
              <option value="explicit">Explicit riser</option>
            </select>

            <span className="text-muted-foreground" title="Contratreapta dorită. Numărul de trepte se rotunjește, iar contratreapta reală închide exact înălțimea.">Riser target</span>
            <input type="number" step="5" min={100} max={220}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('riser_mm') ?? 170)}
              onChange={(e) => onUpdateProp('riser_mm', parseFloat(e.target.value))}
            />

            <span className="text-muted-foreground" title="0 = derivată din regula 2h+g.">Going (mm)</span>
            <input type="number" step="10" min={0}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('tread_mm') ?? 0)}
              onChange={(e) => onUpdateProp('tread_mm', parseFloat(e.target.value))}
            />

            <span className="text-muted-foreground">Waist (mm)</span>
            <input type="number" step="10" min={40}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('thickness_mm') ?? 150)}
              onChange={(e) => onUpdateProp('thickness_mm', parseFloat(e.target.value))}
            />

            <span className="text-muted-foreground" title="Taie golul în placa de deasupra, printr-un nod void.">Slab opening</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('gen_void') ?? 'True')}
              onChange={(e) => onUpdateProp('gen_void', e.target.value)}
            >
              <option value="True">Generate</option>
              <option value="False">None</option>
            </select>

            {/* A spiral has no straight flight to anchor, so no base beam. */}
            {String(propVal('stair_type') ?? 'straight') !== 'spiral' && (
              <>
            <span className="text-muted-foreground" title="Grindă de fundare sub prima treaptă, secțiune T întors — preia împingerea rampei. Dimensiunile sunt uzuale, de confirmat cu structuristul.">Base beam</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('gen_base_beam') ?? 'True')}
              onChange={(e) => onUpdateProp('gen_base_beam', e.target.value)}
            >
              <option value="True">Generate (T întors)</option>
              <option value="False">None</option>
            </select>
              </>
            )}

            {String(propVal('stair_type') ?? 'straight') !== 'spiral'
              && String(propVal('gen_base_beam') ?? 'True') === 'True' && (
              <>
                <span className="text-muted-foreground" title="Adâncimea totală sub cota pardoselii.">Beam depth</span>
                <input type="number" step="50" min={200}
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('base_beam_depth_mm') ?? 400)}
                  onChange={(e) => onUpdateProp('base_beam_depth_mm', parseFloat(e.target.value))}
                />
                <span className="text-muted-foreground" title="Lățimea tălpii de la bază.">Flange (mm)</span>
                <input type="number" step="50" min={300}
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('base_beam_flange_mm') ?? 600)}
                  onChange={(e) => onUpdateProp('base_beam_flange_mm', parseFloat(e.target.value))}
                />
              </>
            )}

            <span className="text-muted-foreground">Railing</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('gen_railing') ?? 'False')}
              onChange={(e) => onUpdateProp('gen_railing', e.target.value)}
            >
              <option value="False">None</option>
              <option value="True">Generate</option>
            </select>

            {String(propVal('gen_railing') ?? 'False') === 'True' && (
              <>
                <span className="text-muted-foreground" title="Pe ce margine a rampei, privind în sus.">Railing side</span>
                <select
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={String(propVal('railing_side') ?? 'both')}
                  onChange={(e) => onUpdateProp('railing_side', e.target.value)}
                >
                  <option value="both">Both (ambele margini)</option>
                  <option value="left">Left (stânga, urcând)</option>
                  <option value="right">Right (dreapta)</option>
                </select>
              </>
            )}
          </div>

          {/* What the solver worked out — the numbers you check a stair by. */}
          {propVal('solved_steps') != null && (
            <div className="mt-2 rounded border border-border bg-muted/40 px-2 py-1.5 text-[10px] leading-relaxed">
              <div className="font-medium text-foreground">
                {String(propVal('solved_steps'))} risers × {String(propVal('solved_riser_mm'))} mm
                {' · '}going {String(propVal('solved_tread_mm'))} mm
              </div>
              <div className="text-muted-foreground">
                climbs {String(propVal('solved_rise_mm'))} mm
                {' · '}2h+g = {Math.round(2 * Number(propVal('solved_riser_mm') ?? 0) + Number(propVal('solved_tread_mm') ?? 0))} mm
              </div>
            </div>
          )}

          {/* The solver's verdicts, in place. A toast per keystroke would be
              noise now that regeneration is live; here they persist until the
              design actually changes. */}
          {(() => {
            let diags: { severity: string; message: string }[] = [];
            try { diags = JSON.parse(String(propVal('solved_diagnostics') ?? '[]')); } catch { /* stale prop */ }
            if (!diags.length) return null;
            return (
              <div className="mt-1.5 flex flex-col gap-1">
                {diags.map((d, i) => (
                  <div
                    key={i}
                    className={`text-[10px] leading-snug rounded border px-2 py-1 ${
                      d.severity === 'error'
                        ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                        : d.severity === 'warning'
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                          : 'border-border bg-muted/40 text-muted-foreground'
                    }`}
                  >
                    {d.message}
                  </div>
                ))}
              </div>
            );
          })()}

          <div className="flex flex-col gap-1 mt-2">
            <button
              type="button"
              className="w-full text-xs bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded px-2 py-1.5 transition-colors font-semibold"
              onClick={() => onGenerateStair?.('flights')}
            >
              Generate stair
            </button>
            <button
              type="button"
              className="w-full text-xs border border-border hover:bg-accent rounded px-2 py-1.5 transition-colors text-muted-foreground"
              onClick={() => onGenerateStair?.('steps')}
            >
              With individual steps
            </button>
            <button
              type="button"
              className="w-full text-xs border border-border hover:bg-accent rounded px-2 py-1.5 transition-colors text-muted-foreground"
              onClick={() => onGenerateStair?.('outline')}
            >
              Opening only
            </button>
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Modificările se aplică live — scara se regenerează singură. Butoanele de mai sus
            schimbă doar nivelul de detaliu. Contratreapta închide mereu exact cota etajului.
          </div>
          {/* The shaft, when one is wired — the roof's contour gesture, applied here. */}
          <div className="text-[10px] text-muted-foreground mt-1">
            {Number(propVal('boundary_ax_count') ?? 0) >= 3
              ? `Casa scării: ${String(propVal('boundary_ax_count'))} axe legate — dau poziția, `
                + 'direcția și golul în placă. Lățimea și tipul rămân cele de mai sus.'
              : 'Leagă nodul de axele care mărginesc casa scării, în ordinea conturului, '
                + 'și scara se așază singură în ea.'}
          </div>
        </PropSection>
      )}

      {/* Sweep — a library profile along the guide line the graph defines */}
      {node.type === 'sweep' && (
        <PropSection label="Sweep" icon="↝">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            {/* One pick that sets role, profile, dimensions, both anchors and
                the offsets — the anchors being the ones easiest to get wrong. */}
            {onUpdateProps && (<>
              <span className="text-muted-foreground"
                title="Un tip gata definit: rol, profil, dimensiuni, ancore și offseturi dintr-o dată. După aplicare poți ajusta orice câmp.">
                Tip detaliu
              </span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                value={String(propVal('detail_type') ?? '')}
                onChange={(e) => {
                  const t = DETAIL_TYPE_MAP.get(e.target.value);
                  if (t) onUpdateProps(detailTypeProperties(t));
                }}
              >
                <option value="">— personalizat —</option>
                {SWEEP_ROLES.filter((r) => detailTypesForRole(r).length > 0).map((r) => (
                  <optgroup key={r} label={SWEEP_ROLE_LABELS[r]}>
                    {detailTypesForRole(r).map((t) => (
                      <option key={t.id} value={t.id} title={t.description}>{t.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </>)}

            {/* What it IS, before what shape it has: the role is the quantity
                key and the IFC class, and the same profile can be either. */}
            <span className="text-muted-foreground"
              title="Ce element este — nu ce formă are. Decide norma din antemăsurătoare și clasa IFC la export.">
              Rol
            </span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={sweepRole(node)}
              title={SWEEP_ROLE_HINTS[sweepRole(node)]}
              onChange={(e) => onUpdateProp('sweep_role', e.target.value)}
            >
              {SWEEP_ROLES.map((r) => (
                <option key={r} value={r} title={SWEEP_ROLE_HINTS[r]}>
                  {SWEEP_ROLE_LABELS[r]}
                </option>
              ))}
            </select>

            <span className="text-muted-foreground"
              title="Parametrice: forme standard. Catalog: secțiuni denumite. DXF: desene QCAD din backend/library/profiles/symbols2d/">
              Profil
            </span>
            <div className="flex items-center gap-1.5">
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs flex-1 min-w-0"
                value={String(propVal('profile') ?? 'rect')}
                onChange={(e) => onUpdateProp('profile', e.target.value)}
              >
                <optgroup label="Parametrice">
                  {listProfileOptions().filter((o) => o.group === 'parametric').map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Catalog">
                  {listProfileOptions().filter((o) => o.group === 'catalogue').map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </optgroup>
                {listProfileOptions().some((o) => o.group === 'dxf') && (
                  <optgroup label="DXF (QCAD)">
                    {listProfileOptions().filter((o) => o.group === 'dxf').map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              {sweepRes?.placed && (
                <svg width="30" height="30" viewBox="0 0 40 40"
                  className="shrink-0 border border-border rounded bg-background text-primary">
                  <path d={profileSvgPath(sweepRes.placed, 40)}
                    fill="currentColor" fillOpacity={0.25}
                    stroke="currentColor" strokeWidth="1.2" />
                </svg>
              )}
              <button
                type="button"
                title="Desenează un profil nou — se salvează în bibliotecă și poate fi folosit de orice sweep"
                onClick={() => setProfileDraft({ name: '', outline: [], sliders: [] })}
                className="shrink-0 w-6 h-6 rounded border border-border bg-background hover:bg-accent text-xs"
              >✏</button>
            </div>
            {PARAMETRIC_PROFILES.find((d) => d.id === String(propVal('profile') ?? 'rect'))?.params.map((pp) => (
              <div key={pp.key} className="contents">
                <span className="text-muted-foreground">{pp.label} (mm)</span>
                <input type="number" step="10"
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal(pp.key) ?? pp.defaultMm)}
                  onChange={(e) => onUpdateProp(pp.key, parseFloat(e.target.value))}
                />
              </div>
            ))}
            {/* A DXF profile is stretchable only on the axes it was drawn with
                slider_* regions for — offering the other axis would distort it. */}
            {sweepRes?.profile?.sizing?.stretchX && (
              <>
                <span className="text-muted-foreground"
                  title={`Desenat la ${sweepRes.profile.sizing.defaultWidthMm} mm — zonele slider_length se întind`}>
                  Lățime (mm)
                </span>
                <input type="number" step="10"
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('p_w_mm') ?? sweepRes.profile.sizing.defaultWidthMm)}
                  onChange={(e) => onUpdateProp('p_w_mm', parseFloat(e.target.value))}
                />
              </>
            )}
            {sweepRes?.profile?.sizing?.stretchY && (
              <>
                <span className="text-muted-foreground"
                  title={`Desenat la ${sweepRes.profile.sizing.defaultHeightMm} mm — zonele slider_height se întind`}>
                  Înălțime (mm)
                </span>
                <input type="number" step="10"
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('p_h_mm') ?? sweepRes.profile.sizing.defaultHeightMm)}
                  onChange={(e) => onUpdateProp('p_h_mm', parseFloat(e.target.value))}
                />
              </>
            )}
            {sweepRes?.profile?.group === 'dxf' && !sweepRes.profile.sizing?.stretchX && !sweepRes.profile.sizing?.stretchY && (
              <>
                <span className="text-muted-foreground">Dimensiuni</span>
                <span className="text-[10px] text-muted-foreground italic px-1.5">
                  fixe — desenul nu are straturi slider_*
                </span>
              </>
            )}
            <span className="text-muted-foreground"
              title="Prin ce punct al dreptunghiului profilului trece linia de ghidaj (după oglindire și rotire)">
              Ancoră
            </span>
            <div className="grid grid-cols-3 gap-0.5 w-16">
              {(['max', 'mid', 'min'] as const).map((ay) =>
                (['min', 'mid', 'max'] as const).map((ax) => (
                  <button key={`${ax}_${ay}`} type="button"
                    title={`${ax} / ${ay}`}
                    className={`h-4 rounded-sm border transition-colors ${
                      String(propVal('anchor_x') ?? 'mid') === ax && String(propVal('anchor_y') ?? 'max') === ay
                        ? 'bg-primary border-primary'
                        : 'bg-muted/40 border-border hover:bg-accent'
                    }`}
                    onClick={() => { onUpdateProp('anchor_x', ax); onUpdateProp('anchor_y', ay); }}
                  />
                )))}
            </div>
            <span className="text-muted-foreground" title="Deplasare laterală față de linie — pozitiv = stânga sensului de parcurgere">Offset lateral (mm)</span>
            <input type="number" step="10"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('offset_x_mm') ?? 0)}
              onChange={(e) => onUpdateProp('offset_x_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Rotire profil (°)</span>
            <input type="number" step="15"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('rotation_deg') ?? 0)}
              onChange={(e) => onUpdateProp('rotation_deg', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Oglindit</span>
            <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('mirror') ?? 'False')}
              onChange={(e) => onUpdateProp('mirror', e.target.value)}>
              <option value="False">Nu</option>
              <option value="True">Da</option>
            </select>
            <span className="text-muted-foreground" title="Îmbinare în unghi (miter) sau tăietură dreaptă la fiecare colț">Colțuri</span>
            <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('corners') ?? 'miter')}
              onChange={(e) => onUpdateProp('corners', e.target.value)}>
              <option value="miter">În unghi (miter)</option>
              <option value="butt">Tăiate drept</option>
            </select>
            {sweepRes?.path?.kind !== 'vertical' && (
              <>
                <span className="text-muted-foreground">Cotă</span>
                <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={String(propVal('level') ?? 'top')}
                  onChange={(e) => onUpdateProp('level', e.target.value)}>
                  <option value="top">Sus etaj</option>
                  <option value="bottom">Jos etaj</option>
                </select>
              </>
            )}
            <span className="text-muted-foreground">Offset cotă (mm)</span>
            <input type="number" step="50"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('offset_z_mm') ?? 0)}
              onChange={(e) => onUpdateProp('offset_z_mm', parseFloat(e.target.value))}
            />
            {sweepRes?.path?.kind === 'vertical' && (
              <>
                <span className="text-muted-foreground" title="0 = până la cota de sus a etajului">Înălțime (mm)</span>
                <input type="number" step="100"
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('height_mm') ?? 0)}
                  onChange={(e) => onUpdateProp('height_mm', parseFloat(e.target.value))}
                />
              </>
            )}
            {sweepRes?.path?.kind !== 'vertical' && !(propVal('closed') === 'True') && (
              <>
                <span className="text-muted-foreground"
                  title="Cât urcă traseul de la primul ax la ultimul. Panta se împarte pe lungime, deci rămâne constantă pe tot parcursul — o cornișă pe fronton, un soclu pe teren în pantă, o mână curentă lângă o rampă.">
                  Urcare (mm)
                </span>
                <input type="number" step="50"
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={Number(propVal('rise_mm') ?? 0)}
                  onChange={(e) => onUpdateProp('rise_mm', parseFloat(e.target.value))}
                />
              </>
            )}
            {(sweepRes?.path?.points.length ?? 0) >= 3 && (
              <>
                <span className="text-muted-foreground">Închis</span>
                <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                  value={String(propVal('closed') ?? 'False')}
                  onChange={(e) => onUpdateProp('closed', e.target.value)}>
                  <option value="False">Deschis</option>
                  <option value="True">Inel închis</option>
                </select>
              </>
            )}
            <span className="text-muted-foreground">Material</span>
            <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('material') ?? '')}
              onChange={(e) => onUpdateProp('material', e.target.value || undefined)}>
              <option value="">(implicit sweep)</option>
              {matConfig ? Object.entries(matConfig.materials).map(([mid, m]) => (
                <option key={mid} value={mid}>{(m as { label?: string }).label ?? mid}</option>
              )) : null}
            </select>
            <span className="text-muted-foreground"
              title="Ce fel de element devine la export IFC. Auto = grindă pentru trasee orizontale, stâlp pentru cele verticale.">
              Tip IFC
            </span>
            <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('ifc_type') ?? 'auto')}
              onChange={(e) => onUpdateProp('ifc_type', e.target.value)}>
              <option value="auto">Auto (grindă / stâlp)</option>
              <option value="IFCBEAM">Grindă (IfcBeam)</option>
              <option value="IFCCOLUMN">Stâlp (IfcColumn)</option>
              <option value="IFCMEMBER">Element liniar (IfcMember)</option>
              <option value="IFCRAILING">Balustradă (IfcRailing)</option>
              <option value="IFCCOVERING">Finisaj (IfcCovering)</option>
              <option value="IFCPIPESEGMENT">Țeavă (IfcPipeSegment)</option>
              <option value="IFCBUILDINGELEMENTPROXY">Generic (Proxy)</option>
            </select>
          </div>
          {profileDraft && (
            <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6"
              onClick={(e) => { if (e.target === e.currentTarget) setProfileDraft(null); }}>
              <div className="w-[min(1100px,95vw)] h-[min(720px,88vh)] rounded-lg overflow-hidden border border-border shadow-2xl">
                <ProfileEditor
                  initial={profileDraft}
                  onClose={() => setProfileDraft(null)}
                  onSaved={(typeId) => onUpdateProp('profile', `dxf:${typeId}`)}
                />
              </div>
            </div>
          )}
          <div className="text-[10px] text-muted-foreground mt-1.5">
            {sweepRes?.path
              ? sweepRes.path.kind === 'vertical'
                ? `1 ax → linie verticală · L ${(sweepRes.lengthMm / 1000).toFixed(2)} m`
                : `${sweepRes.path.points.length} puncte → ${sweepRes.path.closed ? 'inel închis' : 'polilinie'}`
                  + `${sweepRes.path.kind === 'raked' ? ` · pantă ${((sweepRes.zMaxMm - sweepRes.zMinMm) / 1000).toFixed(2)} m` : ''}`
                  + ` · L ${(sweepRes.lengthMm / 1000).toFixed(2)} m`
              : 'Leagă nodul de axe: 1 = vertical, 2 = segment, 3+ = polilinie (în ordinea conectării).'}
            {sweepRes && sweepRes.volumeMm3 > 0 && (
              <> · A {(sweepRes.areaMm2 / 1e6).toFixed(4)} m² · V {(sweepRes.volumeMm3 / 1e9).toFixed(3)} m³</>
            )}
          </div>
          {(() => {
            const diags = sweepRes?.diagnostics ?? [];
            if (!diags.length) return null;
            return (
              <div className="mt-1.5 flex flex-col gap-1">
                {diags.map((d, i) => (
                  <div key={i} className={`text-[10px] leading-snug rounded border px-2 py-1 ${
                    d.severity === 'error'
                      ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                      : d.severity === 'warning'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                        : 'border-border bg-muted/40 text-muted-foreground'
                  }`}>
                    {d.message}
                  </div>
                ))}
              </div>
            );
          })()}
        </PropSection>
      )}

      {/* Sketch — an outline drawn in the plan, given a body and an identity */}
      {node.type === 'sketch' && (
        <PropSection label="Schiță" icon="✎">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">

            {/* What the sketch IS comes first: a rectangle or a circle is
                edited by typing its size, and only a free contour has points
                to pull. */}
            <span className="text-muted-foreground" title="Dreptunghi și cerc sunt parametrice — se editează prin numere, iar un colț tras le păstrează forma. Contur liber = punctele în sine.">Formă</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('shape') ?? 'poly')}
              onChange={(e) => onUpdateProp('shape', e.target.value)}
            >
              <option value="poly">Contur liber</option>
              <option value="curve">Curbă (NURBS)</option>
              <option value="rect">Dreptunghi</option>
              <option value="circle">Cerc</option>
            </select>

            {String(propVal('shape') ?? 'poly') === 'curve' && (<>
              <span className="text-muted-foreground"
                title="Prin puncte: curba trece exact prin fiecare punct desenat. Puncte de control: punctele formează poligonul de control, iar curba e trasă spre ele — control mai fin, ca în CAD.">
                Curbă
              </span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                value={String(propVal('curve_mode') ?? 'fit')}
                onChange={(e) => onUpdateProp('curve_mode', e.target.value)}
              >
                <option value="fit">Prin puncte</option>
                <option value="control">Puncte de control</option>
              </select>
              <span className="text-muted-foreground"
                title="Gradul curbei: 1 = linie frântă, 2 = pătratică, 3 = cubică (implicit, netedă). Limitat de numărul de puncte.">
                Grad
              </span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                value={String(propVal('curve_degree') ?? 3)}
                onChange={(e) => onUpdateProp('curve_degree', Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d}{d === 3 ? ' (cubică)' : ''}</option>)}
              </select>
            </>)}

            {String(propVal('shape') ?? 'poly') === 'rect' && (<>
              <span className="text-muted-foreground" title="Colțul minim al dreptunghiului, în coordonate BIM.">Colț X / Y (mm)</span>
              <div className="flex gap-1">
                {(['shape_x_mm', 'shape_y_mm'] as const).map((k) => (
                  <input key={k} type="number" step="10"
                    className="bg-background border border-border rounded px-1 py-0.5 text-xs w-full min-w-0"
                    value={String(propVal(k) ?? 0)}
                    onChange={(e) => onUpdateProp(k, Number(e.target.value))} />
                ))}
              </div>
              <span className="text-muted-foreground">Lățime × Adâncime (mm)</span>
              <div className="flex gap-1">
                {(['shape_w_mm', 'shape_h_mm'] as const).map((k) => (
                  <input key={k} type="number" step="10" min={1}
                    className="bg-background border border-border rounded px-1 py-0.5 text-xs w-full min-w-0"
                    value={String(propVal(k) ?? 0)}
                    onChange={(e) => onUpdateProp(k, Number(e.target.value))} />
                ))}
              </div>
            </>)}

            {String(propVal('shape') ?? 'poly') === 'circle' && (<>
              <span className="text-muted-foreground">Centru X / Y (mm)</span>
              <div className="flex gap-1">
                {(['shape_x_mm', 'shape_y_mm'] as const).map((k) => (
                  <input key={k} type="number" step="10"
                    className="bg-background border border-border rounded px-1 py-0.5 text-xs w-full min-w-0"
                    value={String(propVal(k) ?? 0)}
                    onChange={(e) => onUpdateProp(k, Number(e.target.value))} />
                ))}
              </div>
              <span className="text-muted-foreground">Rază (mm)</span>
              <input type="number" step="10" min={1}
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={String(propVal('shape_r_mm') ?? 0)}
                onChange={(e) => onUpdateProp('shape_r_mm', Number(e.target.value))} />
            </>)}

            {/* The operation decides how the SAME drawn points are read, so it
                comes next — everything below depends on which one is picked. */}
            <span className="text-muted-foreground"
              title="Extrudare: conturul e un profil închis, ridicat pe verticală. Sweep: conturul e un traseu, cu un profil plimbat de-a lungul lui. Fără corp: rămâne desen 2D cu identitate BIM.">
              Operație
            </span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('op') ?? 'extrude')}
              onChange={(e) => onUpdateProp('op', e.target.value)}
            >
              <option value="extrude">Extrudare (contur închis)</option>
              <option value="sweep">Sweep pe traseu</option>
              <option value="none">Fără corp (doar 2D)</option>
            </select>

            <span className="text-muted-foreground" title="Conturul revine la primul punct. Extrudarea cere contur închis.">
              Contur închis
            </span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('closed') ?? 'True')}
              onChange={(e) => onUpdateProp('closed', e.target.value)}
            >
              <option value="True">Da</option>
              <option value="False">Nu</option>
            </select>

            {/* A closed sketch drawn inside another can be cut out of it. */}
            {String(propVal('closed') ?? 'True') !== 'False' && (<>
              <span className="text-muted-foreground"
                title="Face din acest contur un GOL în altă schiță închisă: e decupat din extrudarea ei, din fața ei în plan și din orice sweep care o folosește ca profil. Golul nu mai are corp propriu.">
                Gol în
              </span>
              <div className="flex items-center gap-1">
                <select
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs flex-1 min-w-0"
                  value={String(propVal('hole_of') ?? '')}
                  onChange={(e) => onUpdateProp('hole_of', e.target.value)}
                >
                  <option value="">— nu e gol —</option>
                  {sketchFaces.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                {enclosingSketch && !String(propVal('hole_of') ?? '') && (
                  <button type="button"
                    className="shrink-0 px-1.5 py-0.5 rounded border border-border text-xs hover:bg-accent"
                    title={`Schița „${enclosingSketch.name}” conține acest contur — fă-l gol în ea.`}
                    onClick={() => onUpdateProp('hole_of', enclosingSketch.id)}>
                    ⊙ {enclosingSketch.name}
                  </button>
                )}
              </div>
            </>)}

            <span className="text-muted-foreground" title="Cota de bază: talpa sau plafonul etajului.">Nivel</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('level') ?? 'bottom')}
              onChange={(e) => onUpdateProp('level', e.target.value)}
            >
              <option value="bottom">Talpa etajului</option>
              <option value="top">Plafonul etajului</option>
            </select>

            <span className="text-muted-foreground">Offset Z (mm)</span>
            <input type="number" step="10"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('offset_z_mm') ?? 0)}
              onChange={(e) => onUpdateProp('offset_z_mm', Number(e.target.value))} />

            {/* ── Extrusion ───────────────────────────────────────────── */}
            {String(propVal('op') ?? 'extrude') === 'extrude' && (<>
              <span className="text-muted-foreground"
                title="Pozitiv urcă, negativ coboară sub cota de bază.">
                Înălțime extrudare (mm)
              </span>
              <FormulaInput step={50} ctx={fmVars}
                value={Number(propVal('height_mm') ?? 1000)}
                onChange={(v) => onUpdateProp('height_mm', v)} />
            </>)}

            {/* ── Sweep along the drawn path ──────────────────────────── */}
            {String(propVal('op') ?? 'extrude') === 'sweep' && (<>
              <span className="text-muted-foreground"
                title="Secțiunea care se plimbă pe traseul desenat — aceeași bibliotecă folosită de elementul Sweep.">
                Profil
              </span>
              <div className="flex items-center gap-1.5">
                <select
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs flex-1 min-w-0"
                  value={String(propVal('profile') ?? 'rect')}
                  onChange={(e) => onUpdateProp('profile', e.target.value)}
                >
                  <optgroup label="Parametrice">
                    {listProfileOptions().filter((o) => o.group === 'parametric').map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Catalog">
                    {listProfileOptions().filter((o) => o.group === 'catalogue').map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </optgroup>
                  {listProfileOptions().some((o) => o.group === 'dxf') && (
                    <optgroup label="DXF (QCAD)">
                      {listProfileOptions().filter((o) => o.group === 'dxf').map((o) => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </optgroup>
                  )}
                  {sketchFaces.length > 0 && (
                    <optgroup label="Fețe desenate (cu goluri)">
                      {sketchFaces.map((f) => (
                        <option key={f.id} value={`${SKETCH_PROFILE_PREFIX}${f.id}`}>
                          {f.name}{f.holes > 0 ? ` — ${f.holes} ${f.holes === 1 ? 'gol' : 'goluri'}` : ''}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {sketchRes?.placed && (
                  <svg width="30" height="30" viewBox="0 0 40 40"
                    className="shrink-0 border border-border rounded bg-background text-primary">
                    <path d={profileSvgPath(sketchRes.placed, 40)}
                      fill="currentColor" fillOpacity={0.25}
                      stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                )}
              </div>
              {PARAMETRIC_PROFILES.find((d) => d.id === String(propVal('profile') ?? 'rect'))?.params.map((pp) => (
                <div key={pp.key} className="contents">
                  <span className="text-muted-foreground">{pp.label} (mm)</span>
                  <input type="number" step="10"
                    className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    value={Number(propVal(pp.key) ?? pp.defaultMm)}
                    onChange={(e) => onUpdateProp(pp.key, parseFloat(e.target.value))} />
                </div>
              ))}
              <span className="text-muted-foreground" title="Ce punct al profilului trece pe traseu.">Ancoră X / Y</span>
              <div className="flex gap-1">
                {(['anchor_x', 'anchor_y'] as const).map((k) => (
                  <select key={k}
                    className="bg-background border border-border rounded px-1.5 py-0.5 text-xs flex-1 min-w-0"
                    value={String(propVal(k) ?? (k === 'anchor_x' ? 'mid' : 'max'))}
                    onChange={(e) => onUpdateProp(k, e.target.value)}
                  >
                    <option value="min">min</option>
                    <option value="mid">mid</option>
                    <option value="max">max</option>
                  </select>
                ))}
              </div>
              <span className="text-muted-foreground" title="Deplasare laterală, + spre stânga sensului de mers.">Offset lateral (mm)</span>
              <input type="number" step="10"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={String(propVal('offset_x_mm') ?? 0)}
                onChange={(e) => onUpdateProp('offset_x_mm', Number(e.target.value))} />
              <span className="text-muted-foreground">Rotație profil (°)</span>
              <input type="number" step="5"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={String(propVal('rotation_deg') ?? 0)}
                onChange={(e) => onUpdateProp('rotation_deg', Number(e.target.value))} />
              <span className="text-muted-foreground" title="Miter taie colțurile în bisectoare; butt le lasă drepte.">Colțuri</span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                value={String(propVal('corners') ?? 'miter')}
                onChange={(e) => onUpdateProp('corners', e.target.value)}
              >
                <option value="miter">Miter</option>
                <option value="butt">Butt</option>
              </select>
            </>)}
          </div>

          {/* ── Reference ─────────────────────────────────────────────
              The sketch's numbers are offsets from here. One ax = origin;
              two = origin + the line "along" runs on. Picking one rewires
              the graph and rewrites the points so the drawing stays put. */}
          {(() => {
            const refIds = sketchRes?.frame.refIds ?? [];
            const origin = refIds[0] ?? '';
            const dirId = refIds[1] ?? '';
            const axOptions = allNodes
              .filter((n) => (n.type === 'ax' || n.type === 'column') && n.parentId === node.parentId)
              .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            const setRefs = (o: string, d: string) =>
              onRewireGraph?.((ns, es) => setSketchRefs(ns, es, node.id, [o, d].filter(Boolean)));
            const sel = 'bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full';
            return (
              <div className="mt-2 pt-2 border-t border-border/50">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Reper</div>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
                  <span className="text-muted-foreground"
                    title="Axul față de care sunt măsurate punctele schiței. Mută axul, schița vine după el. Fără reper = milimetri absoluți.">
                    Origine
                  </span>
                  <select className={sel} value={origin} disabled={!onRewireGraph}
                    onChange={(e) => setRefs(e.target.value, e.target.value ? dirId : '')}>
                    <option value="">— fără (mm absoluți)</option>
                    {axOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <span className="text-muted-foreground"
                    title="Al doilea ax: linia Origine→Direcție e axa „de-a lungul” (u); „transversal” (v) e la stânga ei. Un dreptunghi se aliniază la linie.">
                    Direcție
                  </span>
                  <select className={sel} value={dirId} disabled={!onRewireGraph || !origin}
                    onChange={(e) => setRefs(origin, e.target.value)}>
                    <option value="">— pe X (fără linie)</option>
                    {axOptions.filter((a) => a.id !== origin).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  {sketchRes && sketchRes.frame.refLengthMm > 0 && (
                    <div className="col-span-2 text-[10px] text-muted-foreground">
                      linia de referință: {(sketchRes.frame.refLengthMm / 1000).toFixed(3)} m
                      {' · '}{Math.round((Math.atan2(sketchRes.frame.dir.y, sketchRes.frame.dir.x) * 180) / Math.PI)}° față de X
                    </div>
                  )}

                  <span className="text-muted-foreground"
                    title="Deplasare de-a lungul liniei (u) și transversal (v, + la stânga sensului Origine→Direcție).">
                    Deplasare u / v (mm)
                  </span>
                  <div className="flex gap-1">
                    {(['ref_dx_mm', 'ref_dy_mm'] as const).map((k) => (
                      <input key={k} type="number" step="10"
                        className="bg-background border border-border rounded px-1 py-0.5 text-xs w-full min-w-0"
                        value={String(propVal(k) ?? 0)}
                        onChange={(e) => onUpdateProp(k, Number(e.target.value))} />
                    ))}
                  </div>
                  <span className="text-muted-foreground" title="Rotire în jurul originii, în sens trigonometric, după oglindire.">Rotire (°)</span>
                  <input type="number" step="5"
                    className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                    value={String(propVal('ref_rot_deg') ?? 0)}
                    onChange={(e) => onUpdateProp('ref_rot_deg', Number(e.target.value))} />
                  <span className="text-muted-foreground" title="Oglindire față de linia de referință (v → −v).">Oglindire</span>
                  <select className={sel}
                    value={String(propVal('ref_mirror') ?? 'False')}
                    onChange={(e) => onUpdateProp('ref_mirror', e.target.value)}>
                    <option value="False">Nu</option>
                    <option value="True">Da</option>
                  </select>
                </div>
              </div>
            );
          })()}

          {/* ── Array ─────────────────────────────────────────────────── */}
          <div className="mt-2 pt-2 border-t border-border/50">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Array</div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
              <span className="text-muted-foreground"
                title="Numărul total de exemplare, originalul inclus. 1 = fără array.">
                Exemplare
              </span>
              <FormulaInput step={1} ctx={fmVars}
                value={Number(propVal('array_count') ?? 1)}
                onChange={(v) => onUpdateProp('array_count', Math.max(1, Math.round(v) || 1))} />
              <span className="text-muted-foreground"
                title="Vector: pasul dX/dY/dZ, în coordonate BIM. Referință: pasul merge pe linia Origine→Direcție (cere două axe legate).">
                Direcția
              </span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                value={String(propVal('array_along') ?? 'vector')}
                onChange={(e) => onUpdateProp('array_along', e.target.value)}
              >
                <option value="vector">Vector dX / dY / dZ</option>
                <option value="ref">De-a lungul liniei de referință</option>
                <option value="path">De-a lungul unui traseu (schiță)</option>
              </select>
              {String(propVal('array_along') ?? 'vector') === 'path' ? (<>
                <span className="text-muted-foreground"
                  title="Schița pe care se repetă exemplarele — curbă sau polilinie, deschisă sau închisă. Originalul e exemplarul 0 și își păstrează poziția față de traseu.">
                  Traseu
                </span>
                <select
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                  value={String(propVal('array_path') ?? '')}
                  onChange={(e) => onUpdateProp('array_path', e.target.value)}
                >
                  <option value="">— alege schița-traseu —</option>
                  {sketchPaths.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} — {(p.lengthMm / 1000).toFixed(2)} m</option>
                  ))}
                </select>
                <span className="text-muted-foreground"
                  title="După tangentă: fiecare exemplar se rotește odată cu traseul, păstrându-și unghiul față de el. Fixă: exemplarele doar se mută.">
                  Orientare
                </span>
                <select
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                  value={String(propVal('array_orient') ?? 'tangent')}
                  onChange={(e) => onUpdateProp('array_orient', e.target.value)}
                >
                  <option value="tangent">După tangentă</option>
                  <option value="fixed">Fixă (doar translație)</option>
                </select>
                <span className="text-muted-foreground"
                  title="Întins: exemplarele se împart egal de la original până la capătul traseului (pe o buclă, pe toată bucla). Altfel, pasul fix măsurat pe lungimea reală a traseului. Originalul pornește array-ul din punctul traseului cel mai apropiat de el.">
                  Întins pe tot traseul
                </span>
                <select
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                  value={String(propVal('array_fit') ?? 'False')}
                  onChange={(e) => onUpdateProp('array_fit', e.target.value)}
                >
                  <option value="False">Nu — pas fix</option>
                  <option value="True">Da — pas dedus din număr</option>
                </select>
                {String(propVal('array_fit') ?? 'False') !== 'True' && (<>
                  <span className="text-muted-foreground" title="Acceptă formule, de ex. path_length_m * 1000 / 10 — lungimea traseului împărțită în 10.">Pas pe traseu (mm)</span>
                  <FormulaInput step={100} ctx={fmVars}
                    value={Number(propVal('array_step_mm') ?? 0)}
                    onChange={(v) => onUpdateProp('array_step_mm', v)} />
                </>)}
                <span className="text-muted-foreground" title="Urcarea de la un exemplar la următorul.">Pas dZ (mm)</span>
                <FormulaInput step={100} ctx={fmVars}
                  value={Number(propVal('array_dz_mm') ?? 0)}
                  onChange={(v) => onUpdateProp('array_dz_mm', v)} />
              </>) : String(propVal('array_along') ?? 'vector') === 'ref' ? (<>
                <span className="text-muted-foreground"
                  title="Întins: exemplarele se împart egal între cele două axe, ultimul ajunge exact pe al doilea ax; pasul e dedus.">
                  Întins între axe
                </span>
                <select
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                  value={String(propVal('array_fit') ?? 'False')}
                  onChange={(e) => onUpdateProp('array_fit', e.target.value)}
                >
                  <option value="False">Nu — pas fix</option>
                  <option value="True">Da — pas dedus din număr</option>
                </select>
                {String(propVal('array_fit') ?? 'False') !== 'True' && (<>
                  <span className="text-muted-foreground">Pas pe linie (mm)</span>
                  <FormulaInput step={100} ctx={fmVars}
                    value={Number(propVal('array_step_mm') ?? 0)}
                    onChange={(v) => onUpdateProp('array_step_mm', v)} />
                </>)}
                <span className="text-muted-foreground" title="Urcarea de la un exemplar la următorul — un array pe linie poate și să urce.">Pas dZ (mm)</span>
                <FormulaInput step={100} ctx={fmVars}
                  value={Number(propVal('array_dz_mm') ?? 0)}
                  onChange={(v) => onUpdateProp('array_dz_mm', v)} />
              </>) : (<>
                {/* One vector, so "vertical" and "horizontal" are the same control:
                    (0,0,dz) stacks, (dx,dy,0) runs along the ground. */}
                <span className="text-muted-foreground"
                  title="Pasul dintre exemplare. Doar dZ = array vertical; doar dX/dY = orizontal.">
                  Pas dX / dY / dZ (mm)
                </span>
                <div className="flex gap-1">
                  {(['array_dx_mm', 'array_dy_mm', 'array_dz_mm'] as const).map((k) => (
                    <FormulaInput key={k} step={100} ctx={fmVars} className="w-full min-w-0"
                      value={Number(propVal(k) ?? 0)}
                      onChange={(v) => onUpdateProp(k, v)} />
                  ))}
                </div>
              </>)}
            </div>
          </div>

          {/* ── BIM identity ──────────────────────────────────────────── */}
          <div className="mt-2 pt-2 border-t border-border/50">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Încadrare BIM</div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
              <span className="text-muted-foreground"
                title="Clasa IFC la export. „auto” exportă ca proxy — un contur desenat nu spune singur ce element este.">
                Clasă IFC
              </span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                value={String(propVal('ifc_type') ?? 'auto')}
                onChange={(e) => onUpdateProp('ifc_type', e.target.value)}
              >
                <option value="auto">auto ({SKETCH_DEFAULT_IFC_TYPE.replace('IFC', '')})</option>
                {[
                  'IFCBUILDINGELEMENTPROXY', 'IFCSLAB', 'IFCWALL', 'IFCBEAM', 'IFCCOLUMN',
                  'IFCMEMBER', 'IFCPLATE', 'IFCCOVERING', 'IFCRAILING', 'IFCFOOTING',
                  'IFCCURTAINWALL', 'IFCFURNISHINGELEMENT', 'IFCDISCRETEACCESSORY',
                ].map((t) => <option key={t} value={t}>{t.replace('IFC', '')}</option>)}
              </select>

              <span className="text-muted-foreground"
                title="Cheia pe care o caută regulile din antemăsurătoare. Două schițe cu tipuri diferite se facturează ca lucrări diferite.">
                Tip element
              </span>
              <input
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                placeholder="ex. SOCLU20"
                value={String(propVal('element_type') ?? '')}
                onChange={(e) => onUpdateProp('element_type', e.target.value)} />

              <span className="text-muted-foreground">Material</span>
              <input
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={String(propVal('material') ?? '')}
                onChange={(e) => onUpdateProp('material', e.target.value)} />

              {/* The same per-node override keys every other element uses, so
                  one picker sets 3D and 2D together. Empty falls back to the
                  material, which is what the Appearance section also edits. */}
              <span className="text-muted-foreground" title="Gol = urmează culoarea materialului. Setează deopotrivă 3D și 2D.">Culoare</span>
              <div className="flex items-center gap-1.5">
                <input type="color"
                  className="w-8 h-6 rounded cursor-pointer border border-border p-0"
                  value={String(propVal('color_3d') || '#D97706')}
                  onChange={(e) => onUpdateProps?.({ color_3d: e.target.value, color_2d: e.target.value })} />
                <button type="button"
                  onClick={() => onUpdateProps?.({ color_3d: '', color_2d: '' })}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent text-muted-foreground"
                >urmează materialul</button>
              </div>
            </div>
          </div>

          {/* ── What it came out as ───────────────────────────────────── */}
          <div className="mt-1.5 text-[10px] text-muted-foreground leading-snug">
            {sketchRes && sketchRes.count > 0
              ? `${sketchRes.intent.shape === 'rect' ? 'dreptunghi' : sketchRes.intent.shape === 'circle' ? 'cerc'
                : sketchRes.intent.curve ? `curbă NURBS, ${sketchRes.intent.curve.points.length} puncte` : `${sketchRes.intent.outline.length} puncte`}`
                + ` · L ${(sketchRes.lengthMm / 1000).toFixed(2)} m`
                + (sketchRes.areaMm2 > 0 ? ` · A ${(sketchRes.areaMm2 / 1e6).toFixed(3)} m²${sketchRes.holes.length ? ' net' : ''}` : '')
                + (sketchRes.holes.length ? ` · ${sketchRes.holes.length} ${sketchRes.holes.length === 1 ? 'gol' : 'goluri'} · P ${(sketchRes.perimeterMm / 1000).toFixed(2)} m` : '')
                + (sketchRes.profileHoles.length ? ` · profil cu ${sketchRes.profileHoles.length} ${sketchRes.profileHoles.length === 1 ? 'gol' : 'goluri'}` : '')
                + (sketchRes.count > 1 ? ` · ${sketchRes.count} exemplare` : '')
                + (sketchRes.volumeMm3 > 0 ? ` · V ${(sketchRes.volumeMm3 / 1e9).toFixed(3)} m³` : '')
                + ` · cote ${Math.round(sketchRes.zMinMm)}–${Math.round(sketchRes.zMaxMm)} mm`
              : 'Desenează conturul în planul de nivel — bara Schiță 3D: Contur, Dreptunghi, Cerc sau Traseu.'}
          </div>
          {(() => {
            const diags = sketchRes?.diagnostics ?? [];
            if (!diags.length) return null;
            return (
              <div className="mt-1.5 flex flex-col gap-1">
                {diags.map((d, i) => (
                  <div key={i} className={`text-[10px] leading-snug rounded border px-2 py-1 ${
                    d.severity === 'error'
                      ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                      : d.severity === 'warning'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                        : 'border-border bg-muted/40 text-muted-foreground'
                  }`}>
                    {d.message}
                  </div>
                ))}
              </div>
            );
          })()}
        </PropSection>
      )}

      {/* Terrain platform — one level, and how the ground gets to it */}
      {node.type === 'terrain_pad' && (
        <PropSection label="Platformă teren" icon="▱">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            {/* The level is THE parameter: one number, and the earth follows. */}
            <span className="text-muted-foreground"
              title="Cota la care ajunge terenul. Față de talpa etajului (implicit) sau absolută.">
              Cotă (mm)
            </span>
            <input type="number" step="50"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('level_mm') ?? 0)}
              onChange={(e) => onUpdateProp('level_mm', Number(e.target.value))} />

            <span className="text-muted-foreground">Cota se măsoară</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('level_mode') ?? 'storey')}
              onChange={(e) => onUpdateProp('level_mode', e.target.value)}
            >
              <option value="storey">față de talpa etajului</option>
              <option value="absolute">absolut (cotă BIM)</option>
            </select>

            <span className="text-muted-foreground"
              title="Vertical: perete drept. Pantă: taluz de la terenul din jur până la cotă.">
              Trecere
            </span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('transition') ?? 'vertical')}
              onChange={(e) => onUpdateProp('transition', e.target.value)}
            >
              <option value="vertical">Verticală</option>
              <option value="slope">În pantă</option>
            </select>

            {String(propVal('transition') ?? 'vertical') === 'slope' && (<>
              <span className="text-muted-foreground" title="Unghiul taluzului față de orizontală.">Unghi (°)</span>
              <div className="flex items-center gap-1.5">
                <input type="number" min={1} max={89} step="1"
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-16"
                  value={String(propVal('slope_deg') ?? 45)}
                  onChange={(e) => onUpdateProp('slope_deg', Number(e.target.value))} />
                <span className="text-[10px] text-muted-foreground">
                  ≈ 1 : {slopeRatio(Number(propVal('slope_deg') ?? 45)).toFixed(2)}
                  {' · '}
                  {Math.round(100 / Math.max(0.01, slopeRatio(Number(propVal('slope_deg') ?? 45))))}%
                </span>
              </div>
            </>)}

            <span className="text-muted-foreground"
              title="Sapă doar, umple doar, sau ambele — o terasă pe pantă are nevoie de ambele.">
              Lucrare
            </span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('mode') ?? 'both')}
              onChange={(e) => onUpdateProp('mode', e.target.value)}
            >
              <option value="both">Săpătură și umplutură</option>
              <option value="cut">Doar săpătură</option>
              <option value="fill">Doar umplutură</option>
            </select>
          </div>

          <div className="mt-1.5 text-[10px] text-muted-foreground leading-snug">
            {padRes?.pad
              ? `contur din ${padRes.pad.source === 'sketch' ? 'schiță' : 'axe'}`
                + ` · cotă ${(padRes.pad.levelMm / 1000).toFixed(2)} m`
                + ` · ${padRes.pad.transition === 'slope' ? `taluz ${padRes.pad.slopeDeg}°` : 'perete vertical'}`
                + (padRes.site ? ` · săpătură ${padRes.site.padCutM3.toFixed(1)} m³ · umplutură ${padRes.site.padFillM3.toFixed(1)} m³` : '')
              : padRes && !padRes.site
                ? 'Nu există nod Teren în proiect — adaugă unul și leagă-l de un ax.'
                : 'Leagă platforma de o schiță închisă (unealta Dreptunghi din plan) sau de 3+ axe.'}
          </div>
          {(() => {
            const diags = (padRes?.site?.diagnostics ?? []).filter((d) => d.code.startsWith('PAD_'));
            if (!diags.length) return null;
            return (
              <div className="mt-1.5 flex flex-col gap-1">
                {diags.map((d, i) => (
                  <div key={i} className={`text-[10px] leading-snug rounded border px-2 py-1 ${
                    d.severity === 'error'
                      ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  }`}>
                    {d.message}
                  </div>
                ))}
              </div>
            );
          })()}
        </PropSection>
      )}

      {/* Facade — a pattern of mullions and panels on the faces between the anchors */}
      {node.type === 'facade' && (
        <PropSection label="Fațadă" icon="▦">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground" title="Cum se împarte fiecare față în celule.">Tipar</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('pattern') ?? 'grid')}
              onChange={(e) => onUpdateProp('pattern', e.target.value)}
            >
              {FACADE_PATTERNS.map((p) => <option key={p} value={p}>{FACADE_PATTERN_LABELS[p]}</option>)}
            </select>

            {String(propVal('pattern') ?? 'grid') !== 'voronoi' ? (<>
              <span className="text-muted-foreground" title="Celulele se potrivesc uniform pe față: 10 m la 1,5 m dau 7 travee egale, nu 6 și o fâșie.">Celulă L × H (mm)</span>
              <div className="flex gap-1">
                {(['cell_w_mm', 'cell_h_mm'] as const).map((k) => (
                  <input key={k} type="number" step="50"
                    className="bg-background border border-border rounded px-1 py-0.5 text-xs w-full min-w-0"
                    value={String(propVal(k) ?? 1500)}
                    onChange={(e) => onUpdateProp(k, Number(e.target.value))} />
                ))}
              </div>
            </>) : (<>
              <span className="text-muted-foreground" title="0 = din mărimea celulei.">Celule / față</span>
              <input type="number" min={0} step="1"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={String(propVal('cell_count') ?? 0)}
                onChange={(e) => onUpdateProp('cell_count', Math.max(0, Math.round(Number(e.target.value) || 0)))} />
              <span className="text-muted-foreground">Celulă nominală (mm)</span>
              <input type="number" step="50"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={String(propVal('cell_w_mm') ?? 1500)}
                onChange={(e) => onUpdateProps?.({ cell_w_mm: Number(e.target.value), cell_h_mm: Number(e.target.value) })} />
              <span className="text-muted-foreground">Sămânță · relaxare</span>
              <div className="flex gap-1 items-center">
                <input type="number" step="1"
                  className="bg-background border border-border rounded px-1 py-0.5 text-xs w-16"
                  value={String(propVal('seed') ?? 1)}
                  onChange={(e) => onUpdateProp('seed', Math.round(Number(e.target.value) || 1))} />
                <input type="number" min={0} max={10} step="1"
                  className="bg-background border border-border rounded px-1 py-0.5 text-xs w-12"
                  value={String(propVal('relax_iterations') ?? 2)}
                  onChange={(e) => onUpdateProp('relax_iterations', Math.round(Number(e.target.value) || 0))} />
                <button type="button" onClick={() => onUpdateProp('seed', Math.round(Number(propVal('seed') ?? 1)) + 1)}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent text-muted-foreground">🎲</button>
              </div>
            </>)}

            <span className="text-muted-foreground" title="Sticlă, panou opac, casetă profilată (împinsă în afară, cu teșitură) sau alternat.">Umplere</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('panel_kind') ?? 'glass')}
              onChange={(e) => onUpdateProp('panel_kind', e.target.value)}
            >
              {FACADE_PANEL_KINDS.map((k) => <option key={k} value={k}>{FACADE_PANEL_KIND_LABELS[k]}</option>)}
            </select>

            <span className="text-muted-foreground" title="Lățimea și adâncimea montantului (iese în afara planului sticlei).">Montant l × a (mm)</span>
            <div className="flex gap-1">
              {(['mullion_w_mm', 'mullion_d_mm'] as const).map((k) => (
                <input key={k} type="number" step="10"
                  className="bg-background border border-border rounded px-1 py-0.5 text-xs w-full min-w-0"
                  value={String(propVal(k) ?? (k === 'mullion_w_mm' ? 60 : 120))}
                  onChange={(e) => onUpdateProp(k, Number(e.target.value))} />
              ))}
            </div>

            {['cassette', 'mixed'].includes(String(propVal('panel_kind') ?? 'glass')) && (<>
              <span className="text-muted-foreground" title="Cât iese caseta din plan, și cât se strânge fața ei (teșitura).">Casetă: relief · teșitură (mm)</span>
              <div className="flex gap-1">
                {(['cassette_depth_mm', 'cassette_bevel_mm'] as const).map((k) => (
                  <input key={k} type="number" step="10"
                    className="bg-background border border-border rounded px-1 py-0.5 text-xs w-full min-w-0"
                    value={String(propVal(k) ?? (k === 'cassette_depth_mm' ? 250 : 120))}
                    onChange={(e) => onUpdateProp(k, Number(e.target.value))} />
                ))}
              </div>
            </>)}

            <span className="text-muted-foreground">Sticlă · panou (mm)</span>
            <div className="flex gap-1">
              {(['glass_thickness_mm', 'panel_thickness_mm'] as const).map((k) => (
                <input key={k} type="number" step="2"
                  className="bg-background border border-border rounded px-1 py-0.5 text-xs w-full min-w-0"
                  value={String(propVal(k) ?? (k === 'glass_thickness_mm' ? 24 : 40))}
                  onChange={(e) => onUpdateProp(k, Number(e.target.value))} />
              ))}
            </div>

            <span className="text-muted-foreground" title="Deplasarea planului fațadei în afara liniei axelor.">Offset în afară (mm)</span>
            <input type="number" step="10"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('offset_mm') ?? 0)}
              onChange={(e) => onUpdateProp('offset_mm', Number(e.target.value))} />

            <span className="text-muted-foreground" title="0 = banda etajului.">Înălțime (0 = etaj) · offset Z</span>
            <div className="flex gap-1">
              {(['height_mm', 'offset_z_mm'] as const).map((k) => (
                <input key={k} type="number" step="50"
                  className="bg-background border border-border rounded px-1 py-0.5 text-xs w-full min-w-0"
                  value={String(propVal(k) ?? 0)}
                  onChange={(e) => onUpdateProp(k, Number(e.target.value))} />
              ))}
            </div>

            <span className="text-muted-foreground" title="Cu 2 axe, exteriorul e la dreapta lui A→B; bifează ca să-l întorci. La poligon, exteriorul e dedus.">Întoarce exteriorul</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('flip') ?? 'False')}
              onChange={(e) => onUpdateProp('flip', e.target.value)}
            >
              <option value="False">Nu</option>
              <option value="True">Da</option>
            </select>

            {(facadeRes?.faces.length ?? 0) >= 2 && (<>
              <span className="text-muted-foreground" title="Cu 3+ axe: închide poligonul (shell).">Poligon închis</span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                value={String(propVal('closed') ?? 'True')}
                onChange={(e) => onUpdateProp('closed', e.target.value)}
              >
                <option value="True">Da (shell)</option>
                <option value="False">Nu (fețe deschise)</option>
              </select>
            </>)}

            <span className="text-muted-foreground">Material montanți</span>
            <input className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('material') ?? '')} onChange={(e) => onUpdateProp('material', e.target.value)} />
            <span className="text-muted-foreground">Material sticlă</span>
            <input className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('glass_material') ?? '')} onChange={(e) => onUpdateProp('glass_material', e.target.value)} />
            <span className="text-muted-foreground">Material panouri</span>
            <input className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('panel_material') ?? '')} onChange={(e) => onUpdateProp('panel_material', e.target.value)} />
          </div>

          <div className="mt-1.5 text-[10px] text-muted-foreground leading-snug">
            {facadeRes && facadeRes.cells.length > 0
              ? `${facadeRes.faces.length} ${facadeRes.faces.length === 1 ? 'față' : 'fețe'} · ${facadeRes.cells.length} celule`
                + ` · montanți ${(facadeRes.memberLengthMm / 1000).toFixed(1)} m`
                + (facadeRes.glassAreaMm2 > 0 ? ` · sticlă ${(facadeRes.glassAreaMm2 / 1e6).toFixed(1)} m²` : '')
                + (facadeRes.cassettes.length > 0 ? ` · ${facadeRes.cassettes.length} casete` : '')
                + (facadeRes.panelAreaMm2 > 0 ? ` · panouri ${(facadeRes.panelAreaMm2 / 1e6).toFixed(1)} m²` : '')
                + ` · H ${((facadeRes.zMaxMm - facadeRes.zMinMm) / 1000).toFixed(2)} m`
              : 'Leagă nodul de 2 axe (un panou vertical) sau de 3+ axe (shell poligonal).'}
          </div>
          {(() => {
            const diags = facadeRes?.diagnostics ?? [];
            if (!diags.length) return null;
            return (
              <div className="mt-1.5 flex flex-col gap-1">
                {diags.map((d, i) => (
                  <div key={i} className={`text-[10px] leading-snug rounded border px-2 py-1 ${
                    d.severity === 'error'
                      ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                      : d.severity === 'warning'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                        : 'border-border bg-muted/40 text-muted-foreground'
                  }`}>
                    {d.message}
                  </div>
                ))}
              </div>
            );
          })()}
        </PropSection>
      )}

      {/* Scatter — vegetation and rocks over a sketch or along axes */}
      {node.type === 'scatter' && (
        <PropSection label="Vegetație / pietre" icon="🌳">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            {/* The kind carries a size preset; picking one rewrites the four
                size fields at once, and each stays editable after. */}
            <span className="text-muted-foreground" title="Felul obiectului. Aplică și o presetare de mărime / pas / distanță minimă.">Fel</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('kind') ?? 'tree')}
              onChange={(e) => {
                const k = parseScatterKind(e.target.value);
                const d = SCATTER_KIND_DEFAULTS[k];
                onUpdateProps?.({ kind: k, size_mm: d.sizeMm, height_mm: d.heightMm, spacing_mm: d.spacingMm, min_gap_mm: d.minGapMm });
              }}
            >
              {SCATTER_KINDS.map((k) => <option key={k} value={k}>{SCATTER_KIND_LABELS[k]}</option>)}
            </select>

            <span className="text-muted-foreground"
              title="Auto: contur închis = împrăștiere pe arie, traseu deschis = array pe traseu.">
              Mod
            </span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('mode') ?? 'auto')}
              onChange={(e) => onUpdateProp('mode', e.target.value)}
            >
              <option value="auto">auto (după contur)</option>
              <option value="area">Împrăștiere pe arie</option>
              <option value="path">Array pe traseu</option>
            </select>

            <span className="text-muted-foreground" title="0 = se deduce din pas.">Număr (0 = din pas)</span>
            <input type="number" min={0} step="1"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('count') ?? 0)}
              onChange={(e) => onUpdateProp('count', Math.max(0, Math.round(Number(e.target.value) || 0)))} />

            <span className="text-muted-foreground" title="Traseu: distanța dintre stații. Arie: pasul nominal → număr = arie / pas².">Pas (mm)</span>
            <input type="number" step="100"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('spacing_mm') ?? 4000)}
              onChange={(e) => onUpdateProp('spacing_mm', Number(e.target.value))} />

            <span className="text-muted-foreground" title="Diametrul în plan (coroană / piatră).">Mărime (mm)</span>
            <input type="number" step="100"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('size_mm') ?? 4000)}
              onChange={(e) => onUpdateProp('size_mm', Number(e.target.value))} />

            <span className="text-muted-foreground">Înălțime (mm)</span>
            <input type="number" step="100"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('height_mm') ?? 6000)}
              onChange={(e) => onUpdateProp('height_mm', Number(e.target.value))} />

            <span className="text-muted-foreground" title="0 = toate identice; 0.3 = ±30 % pe mărime.">Variație (0–1)</span>
            <input type="number" min={0} max={1} step="0.05"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('size_jitter') ?? 0.3)}
              onChange={(e) => onUpdateProp('size_jitter', Number(e.target.value))} />

            <span className="text-muted-foreground" title="Doar pe arie: niciun exemplar mai aproape de altul decât atât.">Distanță minimă (mm)</span>
            <input type="number" step="100"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('min_gap_mm') ?? 2500)}
              onChange={(e) => onUpdateProp('min_gap_mm', Number(e.target.value))} />

            <span className="text-muted-foreground" title="Doar pe arie: distanța păstrată față de contur.">Margine (mm)</span>
            <input type="number" step="100"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('edge_margin_mm') ?? 0)}
              onChange={(e) => onUpdateProp('edge_margin_mm', Number(e.target.value))} />

            <span className="text-muted-foreground" title="Aceeași sămânță = aceeași așezare. Schimb-o când aranjamentul nu-ți place.">Sămânță</span>
            <div className="flex items-center gap-1.5">
              <input type="number" step="1"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-20"
                value={String(propVal('seed') ?? 1)}
                onChange={(e) => onUpdateProp('seed', Math.round(Number(e.target.value) || 1))} />
              <button type="button"
                onClick={() => onUpdateProp('seed', Math.round(Number(propVal('seed') ?? 1)) + 1)}
                className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent text-muted-foreground"
                title="Altă așezare">🎲 altă așezare</button>
            </div>

            {scatterRes?.source === 'axes' && (<>
              <span className="text-muted-foreground" title="Cu 3+ axe: închide polilinia și împrăștie pe arie.">Contur închis</span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                value={String(propVal('closed') ?? 'False')}
                onChange={(e) => onUpdateProp('closed', e.target.value)}
              >
                <option value="False">Nu (traseu)</option>
                <option value="True">Da (arie)</option>
              </select>
            </>)}

            <span className="text-muted-foreground">Material</span>
            <input
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('material') ?? '')}
              onChange={(e) => onUpdateProp('material', e.target.value)} />
          </div>

          <div className="mt-1.5 text-[10px] text-muted-foreground leading-snug">
            {scatterRes && scatterRes.count > 0
              ? `${scatterRes.count} exemplare · ${scatterRes.mode === 'area' ? 'pe arie' : 'pe traseu'} din ${scatterRes.source === 'sketch' ? 'schiță' : 'axe'}`
                + (scatterRes.areaMm2 > 0 ? ` · A ${(scatterRes.areaMm2 / 1e6).toFixed(1)} m²` : '')
                + ` · L ${(scatterRes.lengthMm / 1000).toFixed(1)} m`
              : 'Leagă nodul de o schiță (închisă = arie, deschisă = traseu) sau de 2+ axe.'}
          </div>
          {(() => {
            const diags = scatterRes?.diagnostics ?? [];
            if (!diags.length) return null;
            return (
              <div className="mt-1.5 flex flex-col gap-1">
                {diags.map((d, i) => (
                  <div key={i} className={`text-[10px] leading-snug rounded border px-2 py-1 ${
                    d.severity === 'error'
                      ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                      : d.severity === 'warning'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                        : 'border-border bg-muted/40 text-muted-foreground'
                  }`}>
                    {d.message}
                  </div>
                ))}
              </div>
            );
          })()}
        </PropSection>
      )}

      {/* Dome — a membrane over the base contour, tessellated and glazed */}
      {node.type === 'dome' && (
        <PropSection label="Dom" icon="◠">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground"
              title="Folosită doar când domul e legat de UN singur ax: acela e centrul, iar baza e un cerc cu raza asta. 0 = baza vine din conturul axelor legate (minimum 3).">
              Rază bază
            </span>
            <input type="number" step={100} min={0}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('base_radius_mm') ?? 0)}
              onChange={(e) => onUpdateProp('base_radius_mm', Number(e.target.value))} />

            <span className="text-muted-foreground"
              title="Rotunjește colțurile conturului. O membrană se încrețește în colț și panourile de acolo ies ca niște așchii — deci e geometrie, nu ornament. Nu are efect pe bază circulară.">
              Filet colțuri
            </span>
            <input type="number" step={50} min={0}
              disabled={domeRes?.baseKind === 'circle'}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full disabled:opacity-40"
              value={Number(propVal('base_fillet_mm') ?? 0)}
              onChange={(e) => onUpdateProp('base_fillet_mm', Number(e.target.value))} />

            <span className="text-muted-foreground" title="Cât urcă vârful peste cota bazei.">Înălțime</span>
            <div className="flex items-center gap-1.5">
              <input type="number" step={100}
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs flex-1 min-w-0"
                value={Number(propVal('dome_height_mm') ?? 3000)}
                onChange={(e) => onUpdateProp('dome_height_mm', Number(e.target.value))} />
              {/* A hemisphere is height = radius at bulge 1 — the one shape
                  worth a click, because getting it by hand means typing the
                  radius twice and remembering the bulge. */}
              {domeRes?.baseKind === 'circle' && (
                <button type="button"
                  title="Emisferă: înălțimea = raza, bombare 1"
                  className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent whitespace-nowrap"
                  onClick={() => onUpdateProps?.({
                    dome_height_mm: Number(propVal('base_radius_mm') ?? 0),
                    dome_bulge: 1,
                  })}>
                  = emisferă
                </button>
              )}
            </div>

            <span className="text-muted-foreground"
              title="0 = paraboloid (membrană sub presiune mică). 1 = elipsoidal — emisferă când înălțimea egalează raza. Peste 1, flancurile se înclină abrupt și vârful se aplatizează, ca un balon.">
              Bombare
            </span>
            <div className="flex items-center gap-1.5">
              <input type="range" min={0} max={1.5} step={0.05} className="flex-1"
                value={Number(propVal('dome_bulge') ?? 1)}
                onChange={(e) => onUpdateProp('dome_bulge', Number(e.target.value))} />
              <span className="text-[10px] text-muted-foreground w-7 text-right">
                {Number(propVal('dome_bulge') ?? 1).toFixed(2)}
              </span>
            </div>

            <span className="text-muted-foreground" title="Cota bazei: talpa sau plafonul etajului, plus offsetul.">Cotă bază</span>
            <div className="flex items-center gap-1.5">
              <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs flex-1"
                value={String(propVal('level') ?? 'top')}
                onChange={(e) => onUpdateProp('level', e.target.value)}>
                <option value="top">Plafon etaj</option>
                <option value="bottom">Talpă etaj</option>
              </select>
              <input type="number" step={50} title="Offset față de cota aleasă, mm"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-16"
                value={Number(propVal('offset_z_mm') ?? 0)}
                onChange={(e) => onUpdateProp('offset_z_mm', Number(e.target.value))} />
            </div>

            <span className="text-muted-foreground" title="Câte celule Voronoi — deci câte panouri de sticlă.">Celule</span>
            <input type="number" min={1} max={600} step={1}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('cell_count') ?? 40)}
              onChange={(e) => onUpdateProp('cell_count', Number(e.target.value))} />

            <span className="text-muted-foreground"
              title="Schimbă tiparul păstrând numărul de celule. Același seed dă mereu aceeași tesela­ție.">
              Seed
            </span>
            <div className="flex items-center gap-1.5">
              <input type="number" step={1}
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs flex-1"
                value={Number(propVal('cell_seed') ?? 1)}
                onChange={(e) => onUpdateProp('cell_seed', Number(e.target.value))} />
              <button type="button" title="Alt tipar"
                className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent"
                onClick={() => onUpdateProp('cell_seed', Math.floor(Math.random() * 100000))}>
                ↻
              </button>
            </div>

            <span className="text-muted-foreground"
              title="Uniformizează celulele pe SUPRAFAȚĂ, nu în plan — fără ea, celulele de pe flancuri ies întinse. 0 le lasă unde au căzut.">
              Relaxare
            </span>
            <input type="number" min={0} max={20} step={1}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('relax_iterations') ?? 3)}
              onChange={(e) => onUpdateProp('relax_iterations', Number(e.target.value))} />

            <span className="text-muted-foreground" title="Finețea plasei de calcul a suprafeței. Mai mare = mai precis, mai lent.">Rezoluție</span>
            <input type="number" min={6} max={80} step={2}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('resolution') ?? 28)}
              onChange={(e) => onUpdateProp('resolution', Number(e.target.value))} />

            <span className="text-muted-foreground" title="Profilul nervurii — din aceeași bibliotecă folosită de sweep.">Nervură</span>
            <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={String(propVal('profile') ?? 'rect')}
              onChange={(e) => onUpdateProp('profile', e.target.value)}>
              <optgroup label="Parametrice">
                {listProfileOptions().filter((o) => o.group === 'parametric').map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </optgroup>
              <optgroup label="Catalog">
                {listProfileOptions().filter((o) => o.group === 'catalogue').map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </optgroup>
              <optgroup label="DXF">
                {listProfileOptions().filter((o) => o.group === 'dxf').map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </optgroup>
            </select>

            {(PARAMETRIC_PROFILES.find((p) => p.id === String(propVal('profile') ?? 'rect'))?.params ?? []).map((prm) => (
              <React.Fragment key={prm.key}>
                <span className="text-muted-foreground">{prm.label}</span>
                <input type="number" step={5}
                  className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                  value={Number(propVal(prm.key) ?? prm.defaultMm)}
                  onChange={(e) => onUpdateProp(prm.key, Number(e.target.value))} />
              </React.Fragment>
            ))}

            <span className="text-muted-foreground" title="Grosimea panoului de sticlă.">Sticlă</span>
            <input type="number" step={1} min={1}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('glass_thickness_mm') ?? 12)}
              onChange={(e) => onUpdateProp('glass_thickness_mm', Number(e.target.value))} />

            <span className="text-muted-foreground"
              title="Cât are voie un panou să se abată de la planul lui. Peste asta, panoul nu mai poate fi sticlă plană — e raportat, nu ascuns.">
              Toleranță plan
            </span>
            <input type="number" step={1} min={0}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('planarity_tol_mm') ?? 10)}
              onChange={(e) => onUpdateProp('planarity_tol_mm', Number(e.target.value))} />
          </div>

          <div className="text-[10px] text-muted-foreground mt-1.5">
            {domeRes?.base
              ? (domeRes.baseKind === 'circle'
                  ? `1 ax + rază ${(domeRes.intent.baseRadiusMm / 1000).toFixed(2)} m → bază circulară · `
                  : `${domeRes.base.length} axe → contur · `)
                + `${domeRes.cells.length} celule · `
                + `${domeRes.panels.length} panouri · H ${((domeRes.zMaxMm - domeRes.zMinMm) / 1000).toFixed(2)} m`
                + ` · nervuri ${(domeRes.memberLengthMm / 1000).toFixed(1)} m`
                + ` · sticlă ${(domeRes.glassAreaMm2 / 1e6).toFixed(1)} m²`
              : 'Leagă nodul de un ax și dă-i o rază (bază circulară), sau de cel puțin 3 axe (contur).'}
          </div>

          {domeRes?.clustered && (
            <div className="text-[10px] text-cyan-700 dark:text-cyan-400 mt-0.5">
              {domeRes.clusteredWith.length > 0
                ? `Unit cu ${domeRes.clusteredWith.length === 1 ? 'alt dom' : `${domeRes.clusteredWith.length} domuri`} — `
                : 'Cu intrare — '}
              rămâne doar învelitoarea exterioară, iar muchia comună devine ramă
              {domeRes.seamLengthMm > 0 && ` (${(domeRes.seamLengthMm / 1000).toFixed(1)} m)`}.
            </div>
          )}

          {domeRes && domeRes.panels.length > 0 && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              Abatere max. de la plan: {Math.max(...domeRes.panels.map((p) => p.deviationMm)).toFixed(1)} mm
              {domeRes.offToleranceCount > 0
                ? ` · ${domeRes.offToleranceCount} panouri peste toleranță`
                : ' · toate în toleranță'}
            </div>
          )}

          {(domeRes?.diagnostics ?? []).length > 0 && (
            <div className="mt-1.5 flex flex-col gap-1">
              {domeRes!.diagnostics.map((d, i) => (
                <div key={i} className={`text-[10px] leading-snug rounded border px-2 py-1 ${
                  d.severity === 'error'
                    ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                    : d.severity === 'warning'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                      : 'border-border bg-muted/40 text-muted-foreground'
                }`}>
                  {d.message}
                </div>
              ))}
            </div>
          )}
        </PropSection>
      )}

      {/* Site — the project's ground, placed by one axis and pinned to the storey floor */}
      {node.type === 'site' && (
        <PropSection label="Teren" icon="⛰">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground" title="Rotirea grilei de teren față de axele clădirii.">Rotire</span>
            <input type="number" step={5}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('rotation_deg') ?? 0)}
              onChange={(e) => onUpdateProp('rotation_deg', Number(e.target.value))} />

            <span className="text-muted-foreground"
              title="Cota terenului la axul de ancorare = talpa etajului acestui nod, plus offsetul de aici.">
              Offset cotă
            </span>
            <input type="number" step={50}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('offset_z_mm') ?? 0)}
              onChange={(e) => onUpdateProp('offset_z_mm', Number(e.target.value))} />

            <span className="text-muted-foreground" title="Desenează terenul în viewerele 3D și pe glob.">În 3D</span>
            <input type="checkbox"
              checked={String(propVal('show_in_3d') ?? 'True').toLowerCase() === 'true'}
              onChange={(e) => onUpdateProp('show_in_3d', e.target.checked ? 'True' : 'False')} />

            <span className="text-muted-foreground"
              title="Fiecare fundație din graf își sapă groapa: amprenta plus spațiul de lucru, până sub talpă plus stratul de egalizare. Oprit implicit — o groapă e o decizie despre teren, nu o consecință a desenării unei fundații.">
              Sapă fundațiile
            </span>
            <input type="checkbox"
              checked={String(propVal('excavate_foundations') ?? 'False').toLowerCase() === 'true'}
              onChange={(e) => onUpdateProp('excavate_foundations', e.target.checked ? 'True' : 'False')} />

            {String(propVal('excavate_foundations') ?? 'False').toLowerCase() === 'true' && (<>
              <span className="text-muted-foreground" title="Spațiu de lucru de fiecare parte a fundației, mm.">Spațiu lucru</span>
              <input type="number" step={50} min={0}
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                value={Number(propVal('working_space_mm') ?? 500)}
                onChange={(e) => onUpdateProp('working_space_mm', Number(e.target.value))} />
              <span className="text-muted-foreground" title="Strat de egalizare sub talpă, mm.">Egalizare</span>
              <input type="number" step={10} min={0}
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                value={Number(propVal('bedding_mm') ?? 100)}
                onChange={(e) => onUpdateProp('bedding_mm', Number(e.target.value))} />
              <span className="text-muted-foreground" title="Taluzul gropii, grade. 0 = pereți verticali.">Taluz</span>
              <input type="number" step={5} min={0} max={89}
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
                value={Number(propVal('pit_slope_deg') ?? 45)}
                onChange={(e) => onUpdateProp('pit_slope_deg', Number(e.target.value))} />
            </>)}
          </div>

          <div className="text-[10px] text-muted-foreground mt-1.5">
            {siteRes?.frame
              ? `Grilă ${siteRes.model.sizeM} m · ${siteRes.model.subdivisions} div · `
                + (siteRes.model.flat ? 'plat' : 'relief')
                + (siteRes.model.bakedHeights ? ' · editat manual' : '')
                + ` · cota la ax ${(siteRes.frame.datumMm / 1000).toFixed(2)} m`
                + ` · teren ${(siteRes.zMinMm / 1000).toFixed(2)}…${(siteRes.zMaxMm / 1000).toFixed(2)} m`
              : 'Leagă nodul de un ax: acolo e centrul grilei, iar terenul de acolo stă la talpa etajului.'}
          </div>
          {siteRes?.frame && (siteRes.zoneCutM3 + siteRes.foundationCutM3 + siteRes.zoneFillM3 > 0) && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              Săpătură {(siteRes.zoneCutM3 + siteRes.foundationCutM3).toFixed(1)} m³
              {siteRes.foundationCutM3 > 0 && ` (din care fundații ${siteRes.foundationCutM3.toFixed(1)} m³)`}
              {' · '}umplutură {siteRes.zoneFillM3.toFixed(1)} m³
            </div>
          )}
          {(siteRes?.diagnostics ?? []).length > 0 && (
            <div className="mt-1.5 flex flex-col gap-1">
              {siteRes!.diagnostics.map((d, i) => (
                <div key={i} className={`text-[10px] leading-snug rounded border px-2 py-1 ${
                  d.severity === 'error'
                    ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                    : d.severity === 'warning'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                      : 'border-border bg-muted/40 text-muted-foreground'
                }`}>
                  {d.message}
                </div>
              ))}
            </div>
          )}
          <div className="text-[10px] text-muted-foreground mt-1.5">
            Forma terenului, șanțurile și săpăturile se modelează în fila <b>Terrain</b>; ce faci acolo
            se salvează cu proiectul și apare aici, în 3D, pe glob și în secțiuni.
          </div>
        </PropSection>
      )}

      {/* Dome entrance — an igloo tunnel, unioned into the dome it opens into */}
      {node.type === 'dome_entrance' && (
        <PropSection label="Intrare dom" icon="⌒">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground" title="Lățimea tunelului, deci a golului de trecere.">Lățime</span>
            <input type="number" step={50} min={100}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('width_mm') ?? 1400)}
              onChange={(e) => onUpdateProp('width_mm', Number(e.target.value))} />

            <span className="text-muted-foreground" title="Înălțimea boltei. Trebuie să fie mai mică decât a domului, altfel l-ar înghiți.">Înălțime</span>
            <input type="number" step={50} min={1}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('height_mm') ?? 2100)}
              onChange={(e) => onUpdateProp('height_mm', Number(e.target.value))} />

            <span className="text-muted-foreground" title="Ridică sau coboară tunelul față de cota bazei domului.">Offset cotă</span>
            <input type="number" step={50}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('offset_z_mm') ?? 0)}
              onChange={(e) => onUpdateProp('offset_z_mm', Number(e.target.value))} />

            <span className="text-muted-foreground" title="Câte panouri primește tunelul. Are numărul lui, fiindcă altfel, fiind mic pe lângă dom, ar ieși dintr-o singură bucată.">Celule</span>
            <input type="number" step={1} min={1} max={200}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
              value={Number(propVal('cell_count') ?? 8)}
              onChange={(e) => onUpdateProp('cell_count', Number(e.target.value))} />
          </div>
          <div className="text-[10px] text-muted-foreground mt-1.5">
            Leag-o de nodul <b>dom</b> și de <b>axul unde vrei gura</b> tunelului. Bolta se
            unește cu domul, iar curba pe care se întâlnesc e arcul ușii — nu se taie niciun
            gol, cele două interioare sunt deja unul singur.
          </div>
        </PropSection>
      )}

      {/* Skylight properties — cuts a flat hole in a single roof slope face */}
      {node.type === 'skylight' && (
        <PropSection label="Skylight" icon="◫">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground">Width (mm)</span>
            <input type="number" step="10" min={200}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('width_mm') ?? 780)}
              onChange={(e) => onUpdateProp('width_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Length (mm)</span>
            <input type="number" step="10" min={200}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('length_mm') ?? 1180)}
              onChange={(e) => onUpdateProp('length_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground" title="Înălțimea bordurii (curb) ridicate peste suprafața acoperișului.">Curb height (mm)</span>
            <input type="number" step="10" min={0}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('curb_height_mm') ?? 120)}
              onChange={(e) => onUpdateProp('curb_height_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Material</span>
            <input type="text"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('material') ?? 'PVC alb')}
              onChange={(e) => onUpdateProp('material', e.target.value)}
            />
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Poziționează nodul (X/Y) peste o pantă de acoperiș — gaura se decupează automat
            în panta pe care cade centrul luminatorului, la generarea 3D.
          </div>
        </PropSection>
      )}

      {/* Dormer properties — cuts a notch + adds its own small roof volume */}
      {node.type === 'dormer' && (
        <PropSection label="Dormer" icon="⌂">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground">Width (mm)</span>
            <input type="number" step="50" min={600}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('width_mm') ?? 1200)}
              onChange={(e) => onUpdateProp('width_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground" title="Cât de mult iese fereastra din planul acoperișului, măsurat orizontal.">Depth (mm)</span>
            <input type="number" step="50" min={400}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('depth_mm') ?? 900)}
              onChange={(e) => onUpdateProp('depth_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Front wall height (mm)</span>
            <input type="number" step="50" min={600}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('wall_height_mm') ?? 1200)}
              onChange={(e) => onUpdateProp('wall_height_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Roof type</span>
            <select
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('roof_type') ?? 'gable')}
              onChange={(e) => onUpdateProp('roof_type', e.target.value)}
            >
              <option value="gable">Gable</option>
              <option value="shed">Shed</option>
            </select>
            <span className="text-muted-foreground">Pitch (°)</span>
            <input type="number" step="1" min={1} max={75}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('pitch_deg') ?? 25)}
              onChange={(e) => onUpdateProp('pitch_deg', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Overhang (mm)</span>
            <input type="number" step="25" min={0}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={Number(propVal('overhang_mm') ?? 200)}
              onChange={(e) => onUpdateProp('overhang_mm', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Material</span>
            <input type="text"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={String(propVal('material') ?? 'Lemn rasinos')}
              onChange={(e) => onUpdateProp('material', e.target.value)}
            />
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Poziționează nodul (X/Y) peste o pantă de acoperiș. La generarea 3D: decupează
            o crestătură în panta părinte și adaugă pereții + acoperișul propriu al lucarnei.
          </div>
        </PropSection>
      )}

      {/* Covering properties */}
      {node.type === 'covering' && (
        <PropSection label="Covering" icon="◢">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-muted-foreground">Height (mm)</span>
            <input type="number" step="50"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.height as number) ?? 2650}
              onChange={(e) => onUpdateProp('height', parseFloat(e.target.value))}
            />
            <span className="text-muted-foreground">Thickness (mm)</span>
            <input type="number" step="25"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              value={(node.properties.thickness as number) ?? 150}
              onChange={(e) => onUpdateProp('thickness', parseFloat(e.target.value))}
            />
            <span
              className="text-muted-foreground"
              title="Contour offset (mm). Negative = inward. Per-edge list with ';' or ','"
            >Contour offset (mm)</span>
            <input type="text"
              className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
              placeholder="-125 or -125;-100;-50"
              value={(node.properties.contour_offset as string ?? '')}
              onChange={(e) => onUpdateProp('contour_offset', e.target.value || undefined)}
            />
          </div>
          <div className="text-[10px] text-muted-foreground">
            Connect ax nodes directly to this covering for the contour. Default: −125 mm inward offset, 150 mm thickness.
          </div>
        </PropSection>
      )}

      {/* Slab / Shell contour — now only slab (shell has own panel above) */}
      {node.type === 'slab' && (
        <PropSection label="Contour" icon="▢" defaultOpen={false}>
          <div className="space-y-1.5">
            <label className="text-[10px] text-muted-foreground block">
              Contour offset (mm)
            </label>
            <input
              type="text"
              className="bg-background border border-border rounded px-1.5 py-1 w-full text-xs"
              placeholder="-125 or -125;-100;-50"
              value={(node.properties.contour_offset as string ?? node.properties.contour_offset as number ?? '')}
              onChange={(e) => onUpdateProp('contour_offset', e.target.value || undefined)}
            />
            <div className="text-[10px] text-muted-foreground leading-relaxed">
              Negative = inward (inset), positive = outward. Default: <strong>−125 mm</strong> (inset 125 mm).<br />
              Per-edge list with <code>;</code> or <code>,</code> — e.g. <code>-125;-100;-50</code> (last value repeats if the list is shorter).
            </div>
            {node.type === 'slab' && (
              <div className="mt-1.5">
                <label className="text-[10px] text-muted-foreground block mb-0.5">Elevation (mm)</label>
                <input
                  type="number"
                  step="50"
                  className="bg-background border border-border rounded px-1.5 py-1 w-full text-xs"
                  value={(node.properties.elevation as number) ?? ''}
                  placeholder="storey base"
                  onChange={(e) => onUpdateProp('elevation', e.target.value === '' ? undefined : parseFloat(e.target.value))}
                />
              </div>
            )}
          </div>
        </PropSection>
      )}

      {/* ── Section / View properties ─────────────────────────────────────────── */}
      {(node.type === 'section' || node.type === 'view') && (() => {
        const lookSide = parseLookSide(node.properties.look_side, node.properties.flipped);
        const depthMode = parseDepthMode(node.properties.depth_mode);
        const hasLine = !!parsePlanCut(node.properties.plan_cut);
        const clip = node.properties.clip_to_marker !== false && node.properties.clip_to_marker !== 'false';
        return (
          <PropSection label={node.type === 'section' ? 'Secțiune' : 'Vedere (fațadă)'} icon="✂">
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
              <span className="text-muted-foreground" title="Partea liniei de marcaj spre care privești. Stânga = normala în sens trigonometric față de A→B (A vest, B est → nord).">Privire</span>
              <div className="flex items-center gap-1">
                <span className="text-xs">{lookSide === 'left' ? 'stânga liniei' : 'dreapta liniei'}</span>
                <button
                  className="px-1.5 py-0.5 text-xs rounded border border-border hover:bg-accent"
                  title="Întoarce direcția de privire"
                  onClick={() => onUpdateProp('look_side', lookSide === 'left' ? 'right' : 'left')}
                >⇄</button>
              </div>
              <span className="text-muted-foreground" title="Cât de departe, dincolo de planul de tăiere, se mai desenează elementele proiectate.">Adâncime</span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={depthMode}
                onChange={(e) => onUpdateProp('depth_mode', e.target.value)}
              >
                <option value="infinite">infinită</option>
                <option value="limited">limitată</option>
                <option value="zero">doar elementele tăiate</option>
              </select>
              {depthMode === 'limited' && (
                <>
                  <span className="text-muted-foreground">Adâncime (mm)</span>
                  <NumInput step={500}
                    className="w-full"
                    value={Number(node.properties.cut_depth_mm ?? DEFAULT_CUT_DEPTH_MM)}
                    onChange={(v) => onUpdateProp('cut_depth_mm', v)}
                  />
                </>
              )}
              <span className="text-muted-foreground" title="Desenul se limitează orizontal la lungimea liniei de marcaj (ca în ArchiCAD).">Limitează la marcaj</span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={clip ? 'true' : 'false'}
                onChange={(e) => onUpdateProp('clip_to_marker', e.target.value === 'true')}
              >
                <option value="true">Da</option>
                <option value="false">Nu</option>
              </select>
              <span className="text-muted-foreground" title="Cota de jos a desenului (mm). Negativ pentru subsol.">Cotă de start (mm)</span>
              <NumInput step={100}
                className="w-full"
                value={Number(node.properties.start_elevation_mm ?? 0)}
                onChange={(v) => onUpdateProp('start_elevation_mm', v)}
              />
              <span className="text-muted-foreground" title="Înălțimea desenului (mm). 0 = toate etajele.">Înălțime (mm)</span>
              <NumInput step={100}
                className="w-full"
                value={Number(node.properties.cut_height_mm ?? 0)}
                onChange={(v) => onUpdateProp('cut_height_mm', v)}
              />
              <span className="text-muted-foreground">Arată în plan</span>
              <select
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={String(node.properties.show_in_plan ?? 'true')}
                onChange={(e) => onUpdateProp('show_in_plan', e.target.value === 'true')}
              >
                <option value="true">Da</option>
                <option value="false">Nu</option>
              </select>
            </div>
            <div className="text-[10px] text-muted-foreground">
              {hasLine
                ? 'Linia, capetele și adâncimea se editează direct în plan: trage capetele, pătratul de adâncime sau centrul marcajului.'
                : 'Desenează pe plan (✂ / ⊕) sau leagă nodul de 2 axe ca să definești linia.'}
            </div>
            <button
              className="w-full text-xs bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded px-2 py-1.5 transition-colors"
              onClick={() => onOpenSectionTab?.(node.id)}
            >
              Deschide {node.type === 'section' ? 'secțiunea' : 'vederea'} →
            </button>
          </PropSection>
        );
      })()}

      {/* ── Local Transform (all geometry nodes except storey/ax/section/view) ─────────── */}
      {node.type !== 'storey' && node.type !== 'ax' && node.type !== 'section' && node.type !== 'view' && (
        <PropSection label="Transform" icon="↺" defaultOpen={false}>
          <div className="grid grid-cols-3 gap-1.5">
            {([
              ['obj_translate_x', 'T-X (mm)'],
              ['obj_translate_y', 'T-Y (mm)'],
              ['obj_translate_z', 'T-Z (mm)'],
            ] as const).map(([key, label]) => (
              <div key={key}>
                <div className="text-[10px] text-muted-foreground mb-0.5">{label}</div>
                <NumInput step={10}
                  className="w-full"
                  value={Number(node.properties[key]) || 0}
                  onChange={(v) => onUpdateProp(key, v)}
                />
              </div>
            ))}
            {([
              ['obj_rotate_x', 'R-X (°)'],
              ['obj_rotate_y', 'R-Y (°)'],
              ['obj_rotate_z', 'R-Z (°)'],
            ] as const).map(([key, label]) => (
              <div key={key}>
                <div className="text-[10px] text-muted-foreground mb-0.5">{label}</div>
                <NumInput step={1}
                  className="w-full"
                  value={Number(node.properties[key]) || 0}
                  onChange={(v) => onUpdateProp(key, v)}
                />
              </div>
            ))}
          </div>
          <div className="text-[10px] text-muted-foreground">
            T = translate along BIM axes (mm). R = rotate around local object axes (degrees).
          </div>
        </PropSection>
      )}

      {/* Material assignment */}
      {node.type !== 'storey' && node.type !== 'ax' && node.type !== 'section' && node.type !== 'view' && (
        <PropSection label="Material" icon="◌">
          <select
            className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
            value={(propVal('material') as string) ?? ''}
            onChange={(e) => onUpdateProp('material', e.target.value || undefined)}
          >
            <option value="">{isBulk && propVal('material') === undefined ? '(var)' : '(element default)'}</option>
            {matConfig
              ? Object.entries(matConfig.materials).map(([id, mat]) => (
                  <option key={id} value={id}>{(mat as { label?: string }).label ?? id}</option>
                ))
              : null}
          </select>
        </PropSection>
      )}

      {/* ── Specification overrides for this element ── */}
      {specGroupsFor(node.type).length > 0 && (
        <PropSection label="Materiale și finisaje" icon="⚒" defaultOpen={false}>
          <SpecPicker
            nodeType={node.type}
            compact
            inheritLabel="moștenit"
            value={Object.fromEntries(
              specGroupsFor(node.type)
                .map((g) => [g.id, String(propVal(`spec_${g.id}`) ?? '')] as const)
                .filter(([, v]) => v !== ''),
            )}
            onChange={(next) => {
              for (const g of specGroupsFor(node.type)) {
                const before = String(propVal(`spec_${g.id}`) ?? '');
                const after = next[g.id] ?? '';
                if (before !== after) onUpdateProp(`spec_${g.id}`, after || undefined);
              }
            }}
          />
          <div className="text-[10px] text-muted-foreground mt-1">
            Suprascrie alegerea proiectului doar pentru acest element — de pildă faianță
            într-o baie, fără să o pui în toată casa.
          </div>
        </PropSection>
      )}

      {/* ── Structural system override ── */}
      <PropSection label="Sistem structural" icon="⚙" defaultOpen={false}>
        <select
          className="bg-background border border-border rounded px-1.5 py-0.5 w-full text-xs"
          value={String(propVal(SYSTEM_PROPERTY_KEY) ?? '')}
          onChange={(e) => onUpdateProp(SYSTEM_PROPERTY_KEY, e.target.value)}
          title="Suprascrie sistemul structural doar pentru acest element"
        >
          <option value="">
            {isBulk && propVal(SYSTEM_PROPERTY_KEY) === undefined
              ? '(var)'
              : `(moștenit: ${STRUCTURAL_SYSTEM_LABELS[projectSystem ?? 'unset']})`}
          </option>
          {STRUCTURAL_SYSTEMS.filter((sys) => sys !== 'unset').map((sys) => (
            <option key={sys} value={sys}>{STRUCTURAL_SYSTEM_LABELS[sys]}</option>
          ))}
        </select>
        <p className="text-[10px] text-muted-foreground mt-1">
          {STRUCTURAL_SYSTEM_HINTS[
            resolveStructuralSystem(isBulk ? undefined : node ?? undefined, projectSystem)
          ]}
        </p>
      </PropSection>

      {/* Derived quantities — computed from the geometry, never typed. They
          are saved with the project as `q_*` and a formula may name them. */}
      {!isBulk && nodeQty.length > 0 && (
        <PropSection label="Cantități" icon="Σ">
          <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 items-baseline">
            {/* One row per distinct value: a single slab's length, outline
                length, area, net area and section coincide, and five equal
                rows would read as five different things. Every name still
                works in a formula — the tooltip lists them. */}
            {nodeQty
              .reduce<{ label: string; unit: string; value: number; keys: string[] }[]>((rows, q) => {
                const same = rows.find((r) => r.unit === q.unit && Math.abs(r.value - q.value) <= 1e-9 * Math.max(1, Math.abs(q.value)));
                if (same) same.keys.push(q.key);
                else rows.push({ label: q.label, unit: q.unit, value: q.value, keys: [q.key] });
                return rows;
              }, [])
              .map((r) => (
                <React.Fragment key={r.keys[0]}>
                  <span className="text-muted-foreground truncate"
                    title={`Calculată din geometrie — doar citire. În formule: ${r.keys.join(', ')}`}>
                    {r.label}
                  </span>
                  <span className="font-mono tabular-nums text-right" title={r.keys.join(', ')}>
                    {r.value.toLocaleString('ro-RO', { maximumFractionDigits: r.unit === 'buc' ? 0 : 3 })}
                    <span className="text-muted-foreground ml-1">{r.unit}</span>
                  </span>
                </React.Fragment>
              ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            Se salvează cu proiectul și pot fi folosite în formule prin numele lor
            (<span className="font-mono">q_…</span>, vezi tooltip-ul fiecărui rând).
          </p>
        </PropSection>
      )}

      {/* Other custom properties */}
      <PropSection label="Properties" icon="⋯" defaultOpen={false}>
        <div className="flex items-center justify-between">
          <button
            className="text-xs bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded px-2 py-0.5"
            onClick={onAddProp}
          >+ Add</button>
        </div>
        {/* In bulk mode: collect all non-smart keys across all nodes */}
        {!isBulk && Object.entries(node.properties)
          .filter(([k]) => !smartKeys.has(k) && !isDerivedKey(k))
          .map(([k, v]) => (
            <div key={k} className="flex gap-1 items-center">
              <span className="text-muted-foreground shrink-0 w-16 truncate" title={k}>{k}</span>
              <input
                className="bg-background border border-border rounded px-1.5 py-0.5 flex-1 text-xs"
                value={String(v)}
                onChange={(e) => onUpdateProp(k, e.target.value)}
              />
              <button
                className="text-muted-foreground hover:text-destructive px-1"
                onClick={() => onDeleteProp(k)}
              >×</button>
            </div>
          ))}
        {isBulk && (() => {
          // Collect all non-smart keys that appear in at least one node
          const keySet = new Set<string>();
          for (const n of allNodes) Object.keys(n.properties).forEach((k) => { if (!smartKeys.has(k) && !isDerivedKey(k)) keySet.add(k); });
          return Array.from(keySet).map((k) => {
            const val = bulkPropValue(allNodes, k);
            const mixed = val === undefined;
            return (
              <div key={k} className="flex gap-1 items-center">
                <span className="text-muted-foreground shrink-0 w-16 truncate" title={k}>{k}</span>
                <input
                  className={cn(
                    'border border-border rounded px-1.5 py-0.5 flex-1 text-xs',
                    mixed ? 'bg-amber-50 dark:bg-amber-900/20 placeholder-amber-600 dark:placeholder-amber-400 italic' : 'bg-background',
                  )}
                  placeholder={mixed ? 'var' : undefined}
                  value={mixed ? '' : String(val)}
                  onChange={(e) => onUpdateProp(k, e.target.value)}
                />
              </div>
            );
          });
        })()}
    </PropSection>
    </div>
  );
}

// ─── BuildingAxesDialog ───────────────────────────────────────────────────

interface BuildingAxesDialogProps {
  initial: BuildingAxes;
  onClose: () => void;
  onSave: (axes: BuildingAxes) => void;
}

function BuildingAxesDialog({ initial, onClose, onSave }: BuildingAxesDialogProps) {
  const [axesMode, setAxesMode] = useState<'manual' | 'parametric'>('manual');

  // Manual mode
  const [axesX, setAxesX] = useState(initial.xValues.join(', ') || '0, 6000, 12000, 18000');
  const [axesY, setAxesY] = useState(initial.yValues.join(', ') || '0, 5000, 10000, 15000');

  // Parametric mode — per-span distances in mm
  const initSpansX = (() => {
    const ax = [...initial.xValues].sort((a, b) => a - b);
    if (ax.length < 2) return [6000, 6000, 6000];
    return ax.slice(1).map((v, i) => v - ax[i]);
  })();
  const initSpansY = (() => {
    const ay = [...initial.yValues].sort((a, b) => a - b);
    if (ay.length < 2) return [5000, 5000];
    return ay.slice(1).map((v, i) => v - ay[i]);
  })();
  const [spansX, setSpansX] = useState<number[]>(initSpansX);
  const [spansY, setSpansY] = useState<number[]>(initSpansY);

  // Quick-fill state
  const [fillNX, setFillNX] = useState(String(initSpansX.length));
  const [fillDX, setFillDX] = useState(String(initSpansX[0] ?? 6000));
  const [fillNY, setFillNY] = useState(String(initSpansY.length));
  const [fillDY, setFillDY] = useState(String(initSpansY[0] ?? 5000));

  const spansToAxes = (spans: number[]): number[] => {
    const p = [0];
    for (const s of spans) p.push(p[p.length - 1] + Math.max(1, s));
    return p;
  };

  const handleSave = () => {
    let xs: number[], ys: number[];
    if (axesMode === 'parametric') {
      xs = spansToAxes(spansX);
      ys = spansToAxes(spansY);
    } else {
      xs = axesX.split(',').map((v) => parseFloat(v.trim())).filter((v) => !isNaN(v));
      ys = axesY.split(',').map((v) => parseFloat(v.trim())).filter((v) => !isNaN(v));
    }
    if (xs.length < 2 || ys.length < 2) { alert('Need at least 2 X-axes and 2 Y-axes'); return; }
    onSave({ xValues: [...new Set(xs)].sort((a, b) => a - b), yValues: [...new Set(ys)].sort((a, b) => a - b) });
  };

  const inputCls = 'w-full rounded-lg bg-white border border-gray-300 text-gray-900 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-400 transition-all font-mono';
  const numInlineCls = 'w-20 rounded-md bg-white border border-gray-300 text-gray-900 px-2 py-1 text-xs text-right font-mono focus:outline-none focus:ring-1 focus:ring-blue-400/50 focus:border-blue-400';
  const numSmCls = 'w-14 rounded-md bg-white border border-gray-300 text-gray-900 px-2 py-1 text-xs text-right font-mono focus:outline-none focus:ring-1 focus:ring-blue-400/50 focus:border-blue-400';

  const SpansEditor = ({
    spans, setSpans, label,
    fillN, setFillN, fillD, setFillD,
  }: {
    spans: number[]; setSpans: (s: number[]) => void; label: string;
    fillN: string; setFillN: (v: string) => void;
    fillD: string; setFillD: (v: string) => void;
  }) => {
    const axes = spansToAxes(spans);
    const doFill = () => {
      const n = Math.max(1, parseInt(fillN) || 1);
      const d = Math.max(1, parseFloat(fillD) || 1);
      setSpans(Array.from({ length: n }, () => d));
    };
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">{label}</label>
          <span className="text-[10px] text-gray-400 font-mono">{axes.length} axes · {(axes[axes.length - 1] / 1000).toFixed(2)} m total</span>
        </div>
        {/* Quick-fill row */}
        <div className="flex items-center gap-1.5 bg-blue-50 border border-blue-200 rounded-lg px-2.5 py-1.5">
          <span className="text-[10px] text-blue-600 font-semibold shrink-0">Fill:</span>
          <input type="number" min="1" step="1" className={numSmCls} value={fillN} onChange={(e) => setFillN(e.target.value)} title="Number of spans" />
          <span className="text-[10px] text-blue-500 shrink-0">spans ×</span>
          <input type="number" min="1" step="100" className={numInlineCls} value={fillD} onChange={(e) => setFillD(e.target.value)} title="Span distance (mm)" />
          <span className="text-[10px] text-blue-500 shrink-0">mm</span>
          <button className="ml-1 text-[10px] px-2 py-0.5 rounded bg-blue-600 text-white font-semibold hover:bg-blue-700 transition-all shrink-0" onClick={doFill}>→ Apply</button>
        </div>
        {/* Per-span inputs */}
        <div className="flex flex-col gap-1">
          {spans.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-400 w-4 text-right shrink-0">{i + 1}</span>
              <input type="number" step="100" min="100" className={numInlineCls} value={s}
                onChange={(e) => {
                  const v = Math.max(1, parseFloat(e.target.value) || 1);
                  const next = [...spans]; next[i] = v; setSpans(next);
                }} />
              <span className="text-[10px] text-gray-400 shrink-0">mm</span>
              <span className="text-[10px] text-blue-500 font-mono ml-1 shrink-0">→ {axes[i + 1]}</span>
              <button className="ml-auto text-gray-300 hover:text-red-400 text-xs px-1" onClick={() => setSpans(spans.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="mt-1 text-xs text-blue-500 hover:text-blue-700 self-start font-medium"
            onClick={() => setSpans([...spans, spans[spans.length - 1] ?? 5000])}>+ Add span</button>
        </div>
        <div className="text-[10px] text-gray-500 font-mono bg-gray-50 rounded px-2 py-1 border border-gray-200">
          Positions: {spansToAxes(spans).join(', ')}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
      <div className="flex flex-col w-[460px] max-h-[90vh] rounded-2xl bg-white border border-gray-200 shadow-2xl shadow-black/20 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200 bg-gray-50 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-base">📐</div>
          <div className="flex-1">
            <h3 className="font-bold text-sm text-gray-900">Building Axes</h3>
            <p className="text-[10px] text-gray-500 mt-0.5">Global axis grid — applies to all storeys</p>
          </div>
          <button className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-all text-sm" onClick={onClose}>✕</button>
        </div>
        {/* Body — scrollable */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Mode toggle */}
          <div className="flex gap-1">
            {(['manual', 'parametric'] as const).map((m) => (
              <button key={m}
                className={cn('flex-1 text-xs py-1.5 rounded-lg border font-semibold transition-all',
                  axesMode === m
                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                    : 'border-gray-300 bg-white text-gray-500 hover:text-gray-800 hover:bg-gray-50')}
                onClick={() => setAxesMode(m)}
              >{m === 'manual' ? '✎ Manual (mm positions)' : '⊞ Parametric (spans)'}</button>
            ))}
          </div>

          {axesMode === 'manual' ? (
            <>
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">X Axes (mm, East →)</label>
                <input className={inputCls} value={axesX} onChange={(e) => setAxesX(e.target.value)} placeholder="0, 6000, 12000, 18000" />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Y Axes (mm, North ↑)</label>
                <input className={inputCls} value={axesY} onChange={(e) => setAxesY(e.target.value)} placeholder="0, 5000, 10000, 15000" />
              </div>
            </>
          ) : (
            <>
              <SpansEditor label="X Spans (East →)" spans={spansX} setSpans={setSpansX}
                fillN={fillNX} setFillN={setFillNX} fillD={fillDX} setFillD={setFillDX} />
              <div className="border-t border-gray-100" />
              <SpansEditor label="Y Spans (North ↑)" spans={spansY} setSpans={setSpansY}
                fillN={fillNY} setFillN={setFillNY} fillD={fillDY} setFillD={setFillDY} />
            </>
          )}

          <p className="text-[10px] text-gray-500 bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">
            Changes rebuild the axis grid on each storey, preserving existing node properties.
          </p>
        </div>
        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="text-xs px-4 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 transition-all font-medium">Cancel</button>
          <button onClick={handleSave} className="text-xs px-5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-all shadow-sm">Save Axes</button>
        </div>
      </div>
    </div>
  );
}

// ─── NewStoreyDialog ──────────────────────────────────────────────────────

interface NewStoreyDialogProps {
  buildingAxes: BuildingAxes;
  existingNames: string[];
  onClose: () => void;
  onCreate: (cfg: {
    name: string;
    bottomElev: number;
    topElev: number;
    discipline: StoreyDiscipline;
  }) => void;
}

function NewStoreyDialog({ buildingAxes, existingNames, onClose, onCreate }: NewStoreyDialogProps) {
  const [name, setName] = useState('');
  const [bottomElev, setBottomElev] = useState('0');
  const [topElev, setTopElev] = useState('3000');
  const [discipline, setDiscipline] = useState<StoreyDiscipline>('architectural');

  const hasAxes = buildingAxes.xValues.length > 0 && buildingAxes.yValues.length > 0;

  const handleCreate = () => {
    if (!name.trim()) { alert('Enter a unique storey name'); return; }
    if (existingNames.includes(name.trim())) { alert('A storey with this name already exists.'); return; }
    if (!hasAxes) { alert('Define Building Axes first before adding a storey.'); return; }
    const bot = parseFloat(bottomElev);
    const top = parseFloat(topElev);
    if (isNaN(bot) || isNaN(top)) { alert('Enter valid elevations'); return; }
    onCreate({ name: name.trim(), bottomElev: bot, topElev: top, discipline });
  };

  const inputCls = 'w-full rounded-lg bg-white border border-gray-300 text-gray-900 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-400 transition-all';

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
      <div className="flex flex-col w-[440px] rounded-2xl bg-white border border-gray-200 shadow-2xl shadow-black/20 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200 bg-gray-50 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-base">⊞</div>
          <div className="flex-1">
            <h3 className="font-bold text-sm text-gray-900">New Storey</h3>
            <p className="text-[10px] text-gray-500 mt-0.5">Add a building level to the model</p>
          </div>
          <button className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-all text-sm" onClick={onClose}>✕</button>
        </div>
        {/* Body */}
        <div className="p-5 space-y-4">
          {!hasAxes && (
            <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
              <span className="text-sm shrink-0">⚠</span>
              <span>No Building Axes defined yet. Click <strong>Building Axes</strong> in the toolbar first.</span>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Storey Name</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ground Floor" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Bottom Elev. (mm)</label>
              <input type="number" className={inputCls} value={bottomElev} onChange={(e) => setBottomElev(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Top Elev. (mm)</label>
              <input type="number" className={inputCls} value={topElev} onChange={(e) => setTopElev(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Discipline</label>
            <div className="grid grid-cols-3 gap-2">
              {(['architectural', 'structural', 'mep'] as StoreyDiscipline[]).map((d) => (
                <button key={d}
                  className={cn(
                    'text-xs py-2.5 rounded-xl border font-semibold transition-all',
                    discipline === d
                      ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                      : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50 hover:border-blue-400 hover:text-gray-900',
                  )}
                  onClick={() => setDiscipline(d)}
                >
                  {d === 'architectural' ? 'Arch.' : d === 'structural' ? 'Struct.' : 'MEP'}
                </button>
              ))}
            </div>
          </div>
          <div className="text-[10px] text-gray-500 bg-gray-50 rounded-xl px-3 py-2 border border-gray-200">
            Axes grid: <span className="text-gray-700 font-mono">{buildingAxes.xValues.length} × {buildingAxes.yValues.length}</span> intersections
          </div>
        </div>
        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-xs px-4 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 transition-all font-medium">Cancel</button>
          <button onClick={handleCreate} disabled={!hasAxes} className="text-xs px-5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-all shadow-sm disabled:opacity-40 disabled:cursor-not-allowed">Create Storey</button>
        </div>
      </div>
    </div>
  );
}

// ─── EditStoreyDialog ─────────────────────────────────────────────────────

interface EditStoreyDialogProps {
  storey: BubbleGraphNode;
  onClose: () => void;
  onSave: (updates: { name: string; bottomElev: number; topElev: number; discipline: StoreyDiscipline }) => void;
  onRegenerateAxes: (storeyId: string, newAxesX: number[], newAxesY: number[]) => void;
}

function EditStoreyDialog({ storey, onClose, onSave, onRegenerateAxes }: EditStoreyDialogProps) {
  const [name, setName] = useState(storey.name);
  const [bottomElev, setBottomElev] = useState(String(storey.properties.bottomElevation ?? 0));
  const [topElev, setTopElev] = useState(String(storey.properties.topElevation ?? 3000));
  const [discipline, setDiscipline] = useState<StoreyDiscipline>(
    (storey.properties.discipline as StoreyDiscipline) ?? 'architectural',
  );
  // Axes editing — comma-separated mm values (manual mode)
  const [axesXStr, setAxesXStr] = useState(
    ((storey.properties.axesX as number[] | undefined) ?? []).join(', '),
  );
  const [axesYStr, setAxesYStr] = useState(
    ((storey.properties.axesY as number[] | undefined) ?? []).join(', '),
  );
  const [tab, setTab] = useState<'general' | 'axes'>('general');

  // Parametric grid mode
  const [axesMode, setAxesMode] = useState<'manual' | 'parametric'>('manual');
  // Parametric spans: array of distances in mm (not cumulative positions)
  const initSpansX = (() => {
    const axX = ((storey.properties.axesX as number[] | undefined) ?? []).slice().sort((a, b) => a - b);
    if (axX.length < 2) return [6000, 6000, 6000];
    return axX.slice(1).map((v, i) => v - axX[i]);
  })();
  const initSpansY = (() => {
    const axY = ((storey.properties.axesY as number[] | undefined) ?? []).slice().sort((a, b) => a - b);
    if (axY.length < 2) return [5000, 5000];
    return axY.slice(1).map((v, i) => v - axY[i]);
  })();
  const [spansX, setSpansX] = useState<number[]>(initSpansX);
  const [spansY, setSpansY] = useState<number[]>(initSpansY);

  // Convert parametric spans to absolute axis positions
  const spansToAxes = (spans: number[]): number[] => {
    const positions = [0];
    for (const s of spans) positions.push(positions[positions.length - 1] + Math.max(1, s));
    return positions;
  };

  const handleSave = () => {
    if (!name.trim()) { alert('Enter a storey name'); return; }
    const bot = parseFloat(bottomElev);
    const top = parseFloat(topElev);
    if (isNaN(bot) || isNaN(top)) { alert('Enter valid elevations'); return; }
    onSave({ name: name.trim(), bottomElev: bot, topElev: top, discipline });
  };

  const handleSaveAxes = () => {
    let xs: number[], ys: number[];
    if (axesMode === 'parametric') {
      xs = spansToAxes(spansX);
      ys = spansToAxes(spansY);
    } else {
      xs = axesXStr.split(',').map((v) => parseFloat(v.trim())).filter((v) => !isNaN(v));
      ys = axesYStr.split(',').map((v) => parseFloat(v.trim())).filter((v) => !isNaN(v));
    }
    if (xs.length < 2 || ys.length < 2) { alert('Need at least 2 X-axes and 2 Y-axes'); return; }
    const uniqueXs = [...new Set(xs)].sort((a, b) => a - b);
    const uniqueYs = [...new Set(ys)].sort((a, b) => a - b);
    const oldXCount = ((storey.properties.axesX as number[] | undefined) ?? []).length;
    const oldYCount = ((storey.properties.axesY as number[] | undefined) ?? []).length;
    if (uniqueXs.length < oldXCount || uniqueYs.length < oldYCount) {
      if (!confirm(
        `The grid is shrinking (was ${oldXCount}×${oldYCount}, becomes ${uniqueXs.length}×${uniqueYs.length}).\n` +
        `Ax nodes and edges outside the new grid will be permanently deleted.\nContinue?`,
      )) return;
    }
    onRegenerateAxes(storey.id, uniqueXs, uniqueYs);
  };

  const inputCls = 'w-full rounded-lg bg-white border border-gray-300 text-gray-900 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-400 transition-all';
  const inputMonoCls = inputCls + ' font-mono';
  const numInlineCls = 'w-20 rounded-md bg-white border border-gray-300 text-gray-900 px-2 py-1 text-xs text-right font-mono focus:outline-none focus:ring-1 focus:ring-blue-400/50 focus:border-blue-400';

  // Helper: render a parametric spans editor for one direction
  const SpansEditor = ({ spans, setSpans, label }: { spans: number[]; setSpans: (s: number[]) => void; label: string }) => {
    const axes = spansToAxes(spans);
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">{label}</label>
          <span className="text-[10px] text-gray-400 font-mono">{axes.length} axes · {(axes[axes.length - 1] / 1000).toFixed(2)} m total</span>
        </div>
        <div className="flex flex-col gap-1">
          {spans.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-400 w-4 text-right shrink-0">{i + 1}</span>
              <input type="number" step="100" min="100" className={numInlineCls} value={s}
                onChange={(e) => {
                  const v = Math.max(1, parseFloat(e.target.value) || 1);
                  const next = [...spans]; next[i] = v; setSpans(next);
                }} />
              <span className="text-[10px] text-gray-400 shrink-0">mm</span>
              <span className="text-[10px] text-blue-500 font-mono ml-1 shrink-0">→ {axes[i + 1]}</span>
              <button className="ml-auto text-gray-300 hover:text-red-400 text-xs px-1" title="Remove span"
                onClick={() => setSpans(spans.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="mt-1 text-xs text-blue-500 hover:text-blue-700 self-start font-medium"
            onClick={() => setSpans([...spans, spans[spans.length - 1] ?? 5000])}>+ Add span</button>
        </div>
        <div className="text-[10px] text-gray-500 font-mono bg-gray-50 rounded px-2 py-1 border border-gray-200">
          Positions: {spansToAxes(spans).join(', ')}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
      <div className="flex flex-col w-[480px] max-h-[90vh] rounded-2xl bg-white border border-gray-200 shadow-2xl shadow-black/20 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200 bg-gray-50 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-base">✏️</div>
          <div className="flex-1">
            <h3 className="font-bold text-sm text-gray-900">Edit Storey</h3>
            <p className="text-[10px] text-gray-500 mt-0.5 font-mono">{storey.name}</p>
          </div>
          <button className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-all text-sm" onClick={onClose}>✕</button>
        </div>

        {/* Tab strip */}
        <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-gray-200 bg-white shrink-0">
          {(['general', 'axes'] as const).map((t) => (
            <button key={t}
              className={cn(
                'px-4 py-1.5 text-xs font-semibold rounded-lg transition-all',
                tab === t
                  ? 'text-blue-600 bg-blue-50 border border-blue-200 shadow-sm'
                  : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100',
              )}
              onClick={() => setTab(t)}
            >{t === 'axes' ? '⊞ Axes Grid' : '⚙ General'}</button>
          ))}
        </div>

        {/* Body — scrollable */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {tab === 'general' && (
            <>
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Storey Name</label>
                <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Bottom Elev. (mm)</label>
                  <input type="number" className={inputCls} value={bottomElev} onChange={(e) => setBottomElev(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Top Elev. (mm)</label>
                  <input type="number" className={inputCls} value={topElev} onChange={(e) => setTopElev(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Discipline</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['architectural', 'structural', 'mep'] as StoreyDiscipline[]).map((d) => (
                    <button key={d}
                      className={cn(
                        'text-xs py-2.5 rounded-xl border font-semibold transition-all',
                        discipline === d
                          ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                          : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50 hover:border-blue-400 hover:text-gray-900',
                      )}
                      onClick={() => setDiscipline(d)}
                    >
                      {d === 'architectural' ? 'Arch.' : d === 'structural' ? 'Struct.' : 'MEP'}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === 'axes' && (
            <>
              {/* Mode toggle */}
              <div className="flex gap-1">
                {(['manual', 'parametric'] as const).map((m) => (
                  <button key={m}
                    className={cn('flex-1 text-xs py-1.5 rounded-lg border font-semibold transition-all',
                      axesMode === m
                        ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                        : 'border-gray-300 bg-white text-gray-500 hover:text-gray-800 hover:bg-gray-50')}
                    onClick={() => setAxesMode(m)}
                  >{m === 'manual' ? '✎ Manual (mm positions)' : '⊞ Parametric (spans)'}</button>
                ))}
              </div>

              {axesMode === 'manual' ? (
                <>
                  <p className="text-[10px] text-gray-500 bg-gray-50 rounded-xl px-3 py-2.5 border border-gray-200 leading-relaxed">
                    Edit axis positions (mm, comma-separated). Grid regenerates, preserving node properties for intersections that still exist.
                  </p>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">X Axes (mm, East →)</label>
                    <input className={inputMonoCls} value={axesXStr} onChange={(e) => setAxesXStr(e.target.value)} placeholder="0, 6000, 12000, 18000" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Y Axes (mm, North ↑)</label>
                    <input className={inputMonoCls} value={axesYStr} onChange={(e) => setAxesYStr(e.target.value)} placeholder="0, 5000, 10000, 15000" />
                  </div>
                </>
              ) : (
                <>
                  <p className="text-[10px] text-gray-500 bg-gray-50 rounded-xl px-3 py-2.5 border border-gray-200 leading-relaxed">
                    Define inter-axis distances (spans) in mm. Grid starts at 0 and accumulates. Add/remove spans to change number of axes.
                  </p>
                  <SpansEditor spans={spansX} setSpans={setSpansX} label="X direction (East →)" />
                  <SpansEditor spans={spansY} setSpans={setSpansY} label="Y direction (North ↑)" />
                </>
              )}
              <div className="text-[10px] text-gray-500 bg-gray-50 rounded-xl px-3 py-2 border border-gray-200">
                Current grid: <span className="text-gray-700 font-mono">{((storey.properties.axesX as number[] | undefined) ?? []).length} × {((storey.properties.axesY as number[] | undefined) ?? []).length}</span> intersections
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="text-xs px-4 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 transition-all font-medium">Cancel</button>
          {tab === 'general'
            ? <button onClick={handleSave} className="text-xs px-5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-all shadow-sm">Save</button>
            : <button onClick={handleSaveAxes} className="text-xs px-5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-semibold transition-all shadow-sm">Regenerate Grid</button>
          }
        </div>
      </div>
    </div>
  );
}

// ─── Node type visibility list ────────────────────────────────────────────
const VISIBILITY_TYPES = [
  { type: 'storey',     icon: '▦', label: 'Storey'     },
  { type: 'ax',         icon: '⊕', label: 'Grid Axis'  },
  { type: 'wall',       icon: '▭', label: 'Wall'       },
  { type: 'beam',       icon: '═', label: 'Beam'       },
  { type: 'column',     icon: '⬛', label: 'Column'     },
  { type: 'slab',       icon: '▬', label: 'Slab'       },
  { type: 'foundation', icon: '⬜', label: 'Foundation' },
  { type: 'window',     icon: '🪟', label: 'Window'     },
  { type: 'door',       icon: '🚪', label: 'Door'       },
  { type: 'room',       icon: '□', label: 'Room'       },
  { type: 'shell',      icon: '⌒', label: 'Shell'      },
  { type: 'cell',       icon: '◌', label: 'Cell'       },
  { type: 'roof',       icon: '△', label: 'Roof'       },
  { type: 'roof_ridge', icon: '━', label: 'Ridge'      },
  { type: 'rafter',     icon: '/', label: 'Rafter'     },
  { type: 'post',       icon: '|', label: 'Post'       },
  { type: 'covering',   icon: '▤', label: 'Covering'   },
  { type: 'skylight',   icon: '◫', label: 'Skylight'   },
  { type: 'dormer',     icon: '⌂', label: 'Dormer'     },
  { type: 'section',    icon: '✂', label: 'Section'    },
] as const;

/**
 * Dashboard visibility, remembered across sessions. Wrapped in try/catch
 * because storage throws outright in some contexts (private windows, blocked
 * site data) and a dashboard preference must never break the editor.
 */
const DASHBOARD_PREF_KEY = 'bb.dashboard.v1';

function readDashboardPref(key: 'open' | 'collapsed', fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(DASHBOARD_PREF_KEY);
    if (!raw) return fallback;
    const v = (JSON.parse(raw) as Record<string, unknown>)[key];
    return typeof v === 'boolean' ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeDashboardPref(pref: { open: boolean; collapsed: boolean }): void {
  try { localStorage.setItem(DASHBOARD_PREF_KEY, JSON.stringify(pref)); } catch { /* storage unavailable */ }
}

// ─── BubbleGraphCanvas ────────────────────────────────────────────────────

interface BubbleGraphCanvasProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  /** The storey node to display (null = overview of all storeys) */
  activeStoreyId: string | null;
  buildingAxes: { xValues: number[]; yValues: number[] };
  setNodes: React.Dispatch<React.SetStateAction<BubbleGraphNode[]>>;
  setEdges: React.Dispatch<React.SetStateAction<BubbleGraphEdge[]>>;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  /** IDs of nodes selected via the multi-select filter */
  selectedNodeIds?: string[];
  setSelectedNodeIds?: (ids: string[]) => void;
  onOpenSectionTab?: (nodeId: string) => void;
  /** When true, omit internal properties dock/float (Clean shell inspector owns it). */
  hidePropsPanel?: boolean;
  /** Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z — owned by the parent's useUndoableGraphState. */
  undo?: () => void;
  redo?: () => void;
  /** Project-wide structural system, so the inspector can show what an element inherits. */
  projectSystem?: StructuralSystem;
  /** Grid mode: axes as lines, intersections as dots, minimal elements, on-canvas axis editing. Uncontrolled when omitted. */
  gridMode?: boolean;
  onToggleGridMode?: () => void;
  /** The model's setup, in order — axes, then storeys — shown as steps 1 and 2 before the grid view. */
  onOpenAxes?: () => void;
  onAddStorey?: () => void;
  lang?: 'ro' | 'en';
  /**
   * Nodes the INSPECTOR reads when a cost scenario is active — the graph with
   * the scenario applied — so it shows the values the viewers show. The canvas
   * itself keeps drawing and editing `nodes` (the base graph).
   */
  inspectNodes?: BubbleGraphNode[];
  /** Cost state for the quest HUD's "Economist" line (undefined where quantities are excluded). */
  economy?: EconomySnapshot;
}

export function BubbleGraphCanvas({ nodes, edges, activeStoreyId, buildingAxes, setNodes, setEdges, selectedNodeId, setSelectedNodeId, selectedNodeIds = [], setSelectedNodeIds, onOpenSectionTab, hidePropsPanel = false, undo, redo, projectSystem, gridMode: gridModeProp, onToggleGridMode, onOpenAxes, onAddStorey, lang = 'ro', inspectNodes, economy }: BubbleGraphCanvasProps) {
  const [gridModeLocal, setGridModeLocal] = useState(false);
  const gridMode = gridModeProp ?? gridModeLocal;
  const toggleGridMode = onToggleGridMode ?? (() => setGridModeLocal((v) => !v));
  // Nodes visible in the current view: all children of active storey (or all nodes for overview).
  // Includes indirect descendants: nodes whose parentId is a direct child, AND orphan nodes
  // (parentId === null) that are connected via edge to a direct child (e.g. windows on walls).
  const visibleNodes = useMemo(() => {
    if (!activeStoreyId) return nodes;

    // Phase 1: storey itself + direct children
    const directIds = new Set<string>();
    directIds.add(activeStoreyId);
    for (const n of nodes) {
      if (n.parentId === activeStoreyId) directIds.add(n.id);
    }

    // Phase 2: deeper descendants (grandchildren etc.)
    let grew = true;
    const allIds = new Set(directIds);
    while (grew) {
      grew = false;
      for (const n of nodes) {
        if (!allIds.has(n.id) && n.parentId && allIds.has(n.parentId)) {
          allIds.add(n.id);
          grew = true;
        }
      }
    }

    // Phase 3: orphan nodes (parentId null/undefined) connected via edge to a visible node
    for (const e of edges) {
      if (allIds.has(e.from) && !allIds.has(e.to)) {
        const target = nodes.find((n) => n.id === e.to);
        if (target && !target.parentId) allIds.add(e.to);
      }
      if (allIds.has(e.to) && !allIds.has(e.from)) {
        const target = nodes.find((n) => n.id === e.from);
        if (target && !target.parentId) allIds.add(e.from);
      }
    }

    // Phase 4: section/view nodes are GLOBAL — always visible regardless of active storey.
    // Also add their directly-connected ax anchors so the line symbol can be drawn.
    for (const n of nodes) {
      if (n.type === 'section' || n.type === 'view') {
        allIds.add(n.id);
        for (const e of edges) {
          if (e.from === n.id || e.to === n.id) {
            const anchorId = e.from === n.id ? e.to : e.from;
            const anchor = nodes.find((cn) => cn.id === anchorId);
            if (anchor?.type === 'ax') allIds.add(anchorId);
          }
        }
      }
    }

    return nodes.filter((n) => allIds.has(n.id));
  }, [nodes, edges, activeStoreyId]);

  const visibleEdges = useMemo(() => {
    const ids = new Set(visibleNodes.map((n) => n.id));
    return edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }, [edges, visibleNodes]);
  const { config: matConfig } = useMaterialConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [mode, setMode] = useState<InteractionMode>('select');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{
    nodeId: string;
    ox: number;
    oy: number;
    /** Absolute BIM start positions for multi-drag */
    origins: Record<string, { x: number; y: number }>;
  } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  /** Screen-space marquee for box select (null = inactive) */
  const [boxSelect, setBoxSelect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const boxSelectRef = useRef(boxSelect);
  boxSelectRef.current = boxSelect;
  const [edgeStart, setEdgeStart] = useState<string | null>(null);
  const [edgeStartGrip, setEdgeStartGrip] = useState(0); // grip index (0-8) on the 'from' ax node
  const [hoveredGrip, setHoveredGrip] = useState<{ nodeId: string; gripIdx: number } | null>(null);
  const [isGripDragging, setIsGripDragging] = useState(false);
  // While dragging a single node in select mode, the node currently hovered as a
  // connect target (drop on it → make an edge instead of moving). null = plain move.
  const [connectTargetId, setConnectTargetId] = useState<string | null>(null);
  const [hiddenNodeTypes, setHiddenNodeTypes] = useState<Set<string>>(new Set());
  const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
  // ── Grid mode state ──
  /** 'linked' edits every storey sharing the axis value; 'single' only the storey under the cursor. */
  const [gridScope, setGridScope] = useState<GridScope>('linked');
  /** An axis / cell-edge drag in progress: previewed on a copy, committed once on mouse-up. */
  const [gridDrag, setGridDrag] = useState<{
    edit: Extract<GridEdit, { deltaMm: number }>;
    startMm: number;
    bounds: { lo: number; hi: number };
  } | null>(null);
  const gridDragRef = useRef(gridDrag);
  gridDragRef.current = gridDrag;
  const [gridHover, setGridHover] = useState<GridHover>(null);
  /** The opening whose on-canvas controls are showing. */
  const [openingHover, setOpeningHover] = useState<OpeningRef | null>(null);
  /** Sliding an opening along its wall: previewed locally, written once on mouse-up. */
  const [openingDrag, setOpeningDrag] = useState<{
    ref: OpeningRef;
    wallId: string;
    lenMm: number;
    widthMm: number;
    /** Where it started, so a click that never moved selects instead of writing. */
    fromMm: number;
    offsetMm: number;
  } | null>(null);
  const openingDragRef = useRef(openingDrag);
  openingDragRef.current = openingDrag;
  /** Dimension label being edited in the HTML input over the canvas. */
  const [editingDim, setEditingDim] = useState<{ storeyId: string; axis: 'x' | 'y'; index: number; value: string } | null>(null);
  // Nearest edge midpoint for snap indicator while drawing edges (canvas coords)
  const [edgeMidSnap, setEdgeMidSnap] = useState<{ x: number; y: number; edgeId: string } | null>(null);
  const [selectedNodeType, setSelectedNodeType] = useState('ax');
  const [nodeTypeQuery, setNodeTypeQuery] = useState('');
  /** Node types matching a search, by label, id or description. Empty = all. */
  const filterNodeTypes = useCallback((q: string) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return NODE_LIBRARY.nodeTypes;
    return NODE_LIBRARY.nodeTypes.filter((nt) =>
      nt.label.toLowerCase().includes(needle) || nt.id.toLowerCase().includes(needle)
      || String((nt as { description?: string }).description ?? '').toLowerCase().includes(needle));
  }, []);
  const [continuousMode, setContinuousMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [edgeType, setEdgeType] = useState<EdgePlacementType>('simple');
  const [isPropsDocked, setIsPropsDocked] = useState(true);
  const [floatPos, setFloatPos] = useState({ x: 120, y: 80 });
  const [floatSize, _setFloatSize] = useState({ w: 300, h: 500 });
  const [isDraggingFloat, setIsDraggingFloat] = useState(false);
  const [floatDragOff, setFloatDragOff] = useState({ x: 0, y: 0 });

  const setBubbleGraph = useBubbleGraphStore((s) => s.setBubbleGraph);
  const [projectName, setProjectName] = useState('My Building');
  // Live-pushes the generated IFC to the IfcLiteBridge companion app's viewer — see useIfcLiveSync above.
  const [ifcLiveSyncEnabled, setIfcLiveSyncEnabled] = useState(false);

  // Detect dark mode from <html> class
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);


  // Generates the model straight into a running ArchiCAD via the Tapir add-on.
  // Regenerating deletes what the previous push made, so a saved project asks first.
  const [archicadBusy, setArchicadBusy] = useState(false);
  const handlePushToArchicad = useCallback(async () => {
    setArchicadBusy(true);
    try {
      const result = await pushGraphToArchicad(nodes, edges, {
        confirmSavedProject: (path) => window.confirm(
          `The open ArchiCAD project is saved${path ? ` (${path})` : ''}.\n\n`
          + 'Pushing deletes every wall, column, beam, slab, window and door before '
          + 'regenerating. Continue?',
        ),
      });
      if (isCancelled(result)) {
        toast.info('ArchiCAD push cancelled — nothing was changed.');
        return;
      }
      const made = Object.entries(result.created).map(([k, v]) => `${v} ${k}`).join(', ');
      if (made) {
        toast.success(`Pushed to ArchiCAD: ${made}`);
      } else {
        // An empty push almost always means the GRAPH had nothing to emit, so
        // say what the mapping actually found instead of a bare "nothing".
        const found = Object.entries(result.planned).map(([k, v]) => `${v} ${k}`).join(', ');
        const axCount = nodes.filter((n) => n.type === 'ax').length;
        toast.info(
          found
            ? `Nothing created. The mapping produced only: ${found}.`
            : `Nothing to push — the graph has no walls, columns, beams or slabs`
              + `${axCount ? ` (${axCount} ax nodes, none with has_column = True)` : ''}.`,
        );
      }
      // Rejections and skips are the interesting part; never let them pass silently.
      for (const [kind, r] of Object.entries(result.rejected)) {
        toast.error(`ArchiCAD refused ${r.count} ${kind}: ${r.reason}`);
      }
      for (const h of result.hints) toast.info(h);
      if (result.skipped.length) {
        const first = result.skipped[0];
        const more = result.skipped.length - 1;
        toast.info(
          `Skipped ${result.skipped.length} element(s) — ${first.type} ${first.nodeId}: `
          + `${first.reason}${more ? ` (+${more} more)` : ''}`,
        );
      }
    } catch (err) {
      toast.error(`ArchiCAD push failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setArchicadBusy(false);
    }
  }, [nodes, edges]);

  const { status: ifcLiveSyncStatus } = useIfcLiveSync(nodes, edges, projectName, ifcLiveSyncEnabled);

  // Sync to store when nodes/edges change
  useEffect(() => {
    setBubbleGraph(nodes, edges);
  }, [nodes, edges, setBubbleGraph]);

  // Canvas background: dark = tokyo-night (#16161e), light = #f4f4f5
  const canvasBg = theme === 'dark' ? '#16161e' : '#f4f4f5';
  const canvasGrid = theme === 'dark' ? '#1f2335' : '#e4e4e7';
  const canvasText = theme === 'dark' ? '#a9b1d6' : '#3f3f46';
  const canvasEdge = theme === 'dark' ? '#3b4261' : '#a1a1aa';

  // Room parametric control grids for graph editor (BIM mm → canvas via storey position)
  const roomParametricGridsCanvas = useMemo((): Array<RoomParametricGrid & { canvasPoints: { x: number; y: number }[]; canvasGridLines: [{ x: number; y: number }, { x: number; y: number }][] }> => {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const results: Array<RoomParametricGrid & { canvasPoints: { x: number; y: number }[]; canvasGridLines: [{ x: number; y: number }, { x: number; y: number }][] }> = [];
    const roomNodes = visibleNodes.filter((n) => n.type === 'room');
    for (const rn of roomNodes) {
      let poly = calcRoomPolygon(rn, nodeMap, edges);
      if (!poly || poly.length < 3) continue;
      const rawOff = parseContourOffsets(rn.properties.contour_offset);
      const inward = rawOff.map((o: number) => -o);
      if (inward.some((o: number) => o !== 0)) poly = insetPolygon(poly, inward);
      const grid = calcRoomParametricGrid(poly, rn.id);
      if (grid.points.length === 0) continue;
      // Convert BIM mm → canvas positions using storey formula
      const storey = rn.parentId ? nodeMap.get(rn.parentId) : undefined;
      const axesX = parseAxes(storey?.properties?.axesX).sort((a, b) => a - b);
      const axesY = parseAxes(storey?.properties?.axesY).sort((a, b) => a - b);
      const maxX = axesX.length > 0 ? axesX[axesX.length - 1] : 0;
      const maxY = axesY.length > 0 ? axesY[axesY.length - 1] : 0;
      const sx = storey?.x ?? 0;
      const sy = storey?.y ?? 0;
      const bimToCanvas = (p: { x: number; y: number }) => ({
        x: (sx + (p.x - maxX / 2)) * MM_TO_PX,
        y: (sy + (p.y - maxY / 2)) * MM_TO_PX,
      });
      const canvasPoints = grid.points.map(bimToCanvas);
      const canvasGridLines = grid.gridLines.map(([a, b]) => [bimToCanvas(a), bimToCanvas(b)] as [{ x: number; y: number }, { x: number; y: number }]);
      results.push({ ...grid, canvasPoints, canvasGridLines });
    }
    return results;
  }, [nodes, edges, visibleNodes]);

  // Visibility-filtered draw lists (respects hiddenNodeTypes toggle)
  // 'view' type is grouped under the 'section' toggle
  const displayNodes = useMemo(
    () => {
      if (hiddenNodeTypes.size === 0) return visibleNodes;
      const hideView = hiddenNodeTypes.has('section');
      return visibleNodes.filter((n) => {
        if (hiddenNodeTypes.has(n.type)) return false;
        if (hideView && n.type === 'view') return false;
        return true;
      });
    },
    [visibleNodes, hiddenNodeTypes],
  );
  const displayEdges = useMemo(() => {
    if (hiddenNodeTypes.size === 0) return visibleEdges;
    const ids = new Set(displayNodes.map((n) => n.id));
    return visibleEdges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }, [visibleEdges, displayNodes, hiddenNodeTypes]);

  // ── Grid mode: preview + layout ──
  // While an axis drag is live, the picture is the edit applied to a COPY of the
  // graph (so linked storeys preview too), filtered to what this view shows.
  // Nothing is written until mouse-up.
  // A stepped cell edge ADDS nodes (the new grid points and the wall that closes
  // the jog), so the preview keeps anything the edit invented on top of what the
  // view already showed.
  const gridPreview = useMemo(() => {
    if (gridDrag) {
      const res = applyGridEdit(nodes, edges, gridDrag.edit);
      if (res.nodes === nodes && res.edges === edges) return null;
      const before = new Set(nodes.map((n) => n.id));
      const shown = new Set(displayNodes.map((n) => n.id));
      const keep = res.nodes.filter((n) => shown.has(n.id) || !before.has(n.id));
      const ids = new Set(keep.map((n) => n.id));
      return { nodes: keep, edges: res.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
    }
    if (openingDrag) {
      const patched = patchOpening(displayNodes, openingDrag.ref, {
        [offsetKeyFor(openingDrag.ref)]: openingDrag.offsetMm,
      });
      return { nodes: patched, edges: displayEdges };
    }
    return null;
  }, [gridDrag, openingDrag, nodes, edges, displayNodes, displayEdges]);
  const viewNodes = gridPreview?.nodes ?? displayNodes;
  const viewEdges = gridPreview?.edges ?? displayEdges;

  const gridLayout = useMemo(() => {
    if (!gridMode) return null;
    const storeyIds = viewNodes.filter((n) => n.type === 'storey').map((n) => n.id);
    return buildGridLayout(viewNodes, storeyIds, { zoom });
  }, [gridMode, viewNodes, zoom]);

  // ── Grid mode: walls as segments, with the openings cut into them ──
  // The endpoint order is the one `calcWallGeometry` uses, so an opening lands
  // on the canvas exactly where it lands in the plan and in 3D.
  const gridWalls = useMemo<GridWall[]>(() => {
    if (!gridMode) return [];
    const map = new Map(viewNodes.map((n) => [n.id, n]));
    const out: GridWall[] = [];
    for (const n of viewNodes) {
      if (n.type !== 'wall') continue;
      const ends = getConnectedNodesWithGrips(n.id, viewEdges, map)
        .filter(({ node: m }) => m.type !== 'window' && m.type !== 'door');
      if (ends.length < 2) continue;
      const pA = edgeNodePos(ends[0].node, ends[0].gripIdx);
      const pB = edgeNodePos(ends[1].node, ends[1].gripIdx);
      const lenMm = Math.hypot(pB.x - pA.x, pB.y - pA.y);
      if (lenMm < 1) continue;
      out.push({
        wall: n,
        a: { x: pA.x * MM_TO_PX, y: pA.y * MM_TO_PX },
        b: { x: pB.x * MM_TO_PX, y: pB.y * MM_TO_PX },
        lenMm,
        openings: wallOpenings(n, lenMm, viewEdges, map),
      });
    }
    return out;
  }, [gridMode, viewNodes, viewEdges]);

  const gridOpenings = useMemo(() => {
    const out: Array<{ wall: GridWall; placement: OpeningPlacement }> = [];
    for (const w of gridWalls) {
      for (const op of w.openings) {
        const placement = placeOpening(w, op, zoom);
        if (placement) out.push({ wall: w, placement });
      }
    }
    return out;
  }, [gridWalls, zoom]);

  /** Has-windows / has-doors chips, shown on the selected wall only. */
  const gridWallChipList = useMemo(() => {
    const sel = new Set([selectedNodeId, ...selectedNodeIds].filter((id): id is string => !!id));
    return gridWalls.filter((w) => sel.has(w.wall.id)).flatMap((w) => wallChips(w, zoom));
  }, [gridWalls, selectedNodeId, selectedNodeIds, zoom]);

  /** The opening currently offering its controls: hovered, dragged, or selected. */
  const activeOpening = useMemo(() => {
    const wanted = openingDrag?.ref ?? openingHover;
    const hit = gridOpenings.find(({ placement }) =>
      sameOpeningRef(placement.op.ref, wanted) ||
      (placement.op.ref.kind === 'node' && placement.op.ref.nodeId === selectedNodeId));
    return hit?.placement ?? null;
  }, [gridOpenings, openingHover, openingDrag, selectedNodeId]);

  // ── Draw ──────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = canvasBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Subtle grid dots
    const gridSpacing = 50 * zoom;
    if (gridSpacing > 8) {
      const ox = ((pan.x % gridSpacing) + gridSpacing) % gridSpacing;
      const oy = ((pan.y % gridSpacing) + gridSpacing) % gridSpacing;
      ctx.fillStyle = canvasGrid;
      for (let gx = ox; gx < canvas.width; gx += gridSpacing) {
        for (let gy = oy; gy < canvas.height; gy += gridSpacing) {
          ctx.beginPath();
          ctx.arc(gx, gy, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);
    // AutoCAD-style: Y positive upward
    ctx.translate(0, canvas.height / zoom);
    ctx.scale(1, -1);

    // Room polygons are collected by the normal pass and consulted by the node
    // pass below; grid mode draws rooms itself, so the map stays empty there.
    const roomPolygons = new Map<string, { pts: {x:number;y:number}[]; centX: number; centY: number; area_m2: number }>();

    if (gridMode && gridLayout) {
      // ── Grid mode: axes, dimensions, dots and a minimal reading of the rest ──
      drawGridMode(ctx, {
        nodes: viewNodes,
        edges: viewEdges,
        layout: gridLayout,
        zoom,
        mmToPx: MM_TO_PX,
        colors: {
          text: canvasText,
          axis: theme === 'dark' ? '#94a3b8' : '#64748b',
          accent: '#0ea5e9',
          selection: '#e94560',
          edge: canvasEdge,
          surface: canvasBg,
        },
        nodeColors: NODE_COLORS,
        selectedNodeId,
        selectedNodeIds,
        selectedEdge,
        edgeStart,
        hoveredGrip,
        hover: gridHover,
        drag: gridDrag ? { edit: gridDrag.edit } : null,
        hideDim: editingDim ? { storeyId: editingDim.storeyId, axis: editingDim.axis, index: editingDim.index } : null,
        roomPts: (n) => getRoomCanvasPts(n, viewNodes, viewEdges),
        edgeEndpoint: edgeNodePos,
        walls: gridWalls,
        openings: gridOpenings,
        activeOpening,
        wallChips: gridWallChipList,
      });
    } else {
    // Storey frames
    displayNodes.filter((n) => n.type === 'storey').forEach((s) => {
      const w = (s.properties.width as number || 0) * MM_TO_PX;
      const h = (s.properties.height as number || 0) * MM_TO_PX;
      const fx = s.x * MM_TO_PX - w / 2;
      const fy = s.y * MM_TO_PX - h / 2;

      ctx.fillStyle = 'rgba(108,92,231,0.06)';
      ctx.fillRect(fx, fy, w, h);
      ctx.strokeStyle = selectedNodeId === s.id ? '#e94560' : '#6c5ce7';
      ctx.lineWidth = selectedNodeId === s.id ? 3 : 2;
      ctx.setLineDash([10, 5]);
      ctx.strokeRect(fx, fy, w, h);
      ctx.setLineDash([]);

      const disciplineColor =
        s.properties.discipline === 'structural' ? '#f7768e' :
        s.properties.discipline === 'mep' ? '#e0af68' : '#7c87de';

      ctx.save();
      ctx.translate(fx + 8, fy + h - 8);
      ctx.scale(1, -1);
      ctx.fillStyle = disciplineColor;
      ctx.font = 'bold 13px system-ui,sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(`▦ ${s.name}`, 0, 0);
      ctx.fillStyle = canvasText;
      ctx.font = '10px system-ui,sans-serif';
      ctx.fillText(`↓${s.properties.bottomElevation}↑${s.properties.topElevation} mm`, 0, 16);
      if (s.properties.discipline) {
        ctx.fillStyle = disciplineColor;
        ctx.fillText(String(s.properties.discipline).toUpperCase(), 0, 28);
      }
      ctx.restore();
    });

    // ── Pre-compute room polygons (canvas coords, matching calcRoomPolygon topology) ─
    // Key: room node id → { pts: {x,y}[], centX, centY, area_m2 }
    //
    // Pattern A — room connected to ax/column directly → use those as vertices
    // Pattern B — room connected to walls → resolve wall corner ax/column nodes via
    //             adjacency walk (same as calcRoomPolygon in bimGeometry.ts)
    // Fallback  — any other connected non-room nodes (≥3)
    // getRoomCanvasPts is defined as a useCallback above — used directly here

    displayNodes.filter((n) => n.type === 'room').forEach((n) => {
      let pts = getRoomCanvasPts(n);
      if (!pts) return;
      // Shoelace: ensure CCW (positive area in canvas Y-up space)
      let area2 = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        area2 += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      }
      if (area2 < 0) pts = pts.reverse();
      const centX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const centY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const area_m2 = Math.abs(area2) / (2 * MM_TO_PX * MM_TO_PX) / 1e6;
      roomPolygons.set(n.id, { pts, centX, centY, area_m2 });
    });

    // Draw room polygons BEFORE edges (so edges of other types render on top)
    roomPolygons.forEach((poly, roomId) => {
      const n = displayNodes.find((vn) => vn.id === roomId);
      if (!n) return;
      const isSelected = selectedNodeId === n.id;
      // Individual color > matConfig default > nodeLibrary fallback
      const color = (n.properties.color as string | undefined)?.trim() ||
        (matConfig?.element_defaults?.room?.color_3d as string | undefined) ||
        NODE_COLORS['room'] || '#14b8a6';
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(poly.pts[0].x, poly.pts[0].y);
      for (let i = 1; i < poly.pts.length; i++) ctx.lineTo(poly.pts[i].x, poly.pts[i].y);
      ctx.closePath();
      // Fill
      ctx.fillStyle = color + (theme === 'dark' ? '28' : '1a');
      ctx.fill();
      // Outline
      ctx.strokeStyle = isSelected ? '#e94560' : color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.setLineDash([8, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Vertex dots
      ctx.fillStyle = color + 'aa';
      for (const p of poly.pts) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx.fill();
      }
      // Room grab-handle at the centroid — keeps the room node visible and
      // clickable even after the polygon forms, so the contour can keep growing
      // past a triangle. The "+" signals: click here to attach the next ax node.
      ctx.beginPath();
      ctx.arc(poly.centX, poly.centY, ROOM_HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = color + (theme === 'dark' ? 'cc' : 'd9');
      ctx.fill();
      const roomActive = edgeStart === n.id || isSelected;
      ctx.strokeStyle = roomActive ? '#e94560'
        : mode === 'addEdge' ? '#4ecdc4'
        : (theme === 'dark' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.55)');
      ctx.lineWidth = edgeStart === n.id ? 4 : roomActive ? 3 : mode === 'addEdge' ? 2.5 : 1.5;
      ctx.stroke();
      ctx.save();
      ctx.translate(poly.centX, poly.centY);
      ctx.scale(1, -1);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+', 0, 0.5);
      ctx.restore();
      // Label above the handle: room name + area
      ctx.save();
      ctx.translate(poly.centX, poly.centY);
      ctx.scale(1, -1);
      ctx.fillStyle = isSelected ? '#e94560' : color;
      ctx.font = 'bold 12px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.name, 0, -(ROOM_HANDLE_R + 20));
      ctx.font = '10px system-ui,sans-serif';
      ctx.fillStyle = canvasText;
      ctx.fillText(`${poly.area_m2.toFixed(1)} m²`, 0, -(ROOM_HANDLE_R + 7));
      ctx.restore();
      ctx.restore();
    });

    // Room parametric control points and grid lines — hidden in graph editor

    // Edges
    displayEdges.forEach((e) => {
      const sn = displayNodes.find((n) => n.id === e.from);
      const tn = displayNodes.find((n) => n.id === e.to);
      if (!sn || !tn) return;
      // Suppress edges where one endpoint is a room with a polygon (polygon shows the shape)
      if ((sn.type === 'room' && roomPolygons.has(sn.id)) ||
          (tn.type === 'room' && roomPolygons.has(tn.id))) return;
      ctx.beginPath();
      const spFrom = edgeNodePos(sn, e.fromGrip);
      const spTo   = edgeNodePos(tn, e.toGrip);
      ctx.moveTo(spFrom.x * MM_TO_PX, spFrom.y * MM_TO_PX);
      ctx.lineTo(spTo.x   * MM_TO_PX, spTo.y   * MM_TO_PX);
      ctx.strokeStyle = selectedEdge === e.id ? '#e94560' : canvasEdge;
      ctx.lineWidth = selectedEdge === e.id ? 3 : 2;
      ctx.stroke();
    });

    } // end normal-mode frames / rooms / edges

    // Edge preview (addEdge mode click-click OR grip drag) — both modes
    if ((mode === 'addEdge' || isGripDragging) && edgeStart) {
      const startN = displayNodes.find((n) => n.id === edgeStart);
      if (startN && canvas) {
        ctx.beginPath();
        // Use AX_D-scaled canvas position for ax start node so line starts at visual grip
        let startCanvasX: number, startCanvasY: number;
        if (startN.type === 'ax' && edgeStartGrip !== 0) {
          const gripsS = axGrips(startN);
          const sg = gripsS[edgeStartGrip];
          const snx = startN.x * MM_TO_PX, sny = startN.y * MM_TO_PX;
          startCanvasX = snx + (sg.x * MM_TO_PX - snx) * AX_D;
          startCanvasY = sny + (sg.y * MM_TO_PX - sny) * AX_D;
        } else {
          const startGPos = edgeNodePos(startN, edgeStartGrip);
          startCanvasX = startGPos.x * MM_TO_PX;
          startCanvasY = startGPos.y * MM_TO_PX;
        }
        ctx.moveTo(startCanvasX, startCanvasY);
        // Snap to hovered grip target (AX_D-scaled) or follow cursor
        let mx: number, my: number;
        if (hoveredGrip && hoveredGrip.nodeId !== edgeStart) {
          const tgtN = displayNodes.find((n) => n.id === hoveredGrip.nodeId);
          if (tgtN) {
            const gripsT = axGrips(tgtN);
            const tg = gripsT[hoveredGrip.gripIdx];
            const tnx = tgtN.x * MM_TO_PX, tny = tgtN.y * MM_TO_PX;
            mx = tnx + (tg.x * MM_TO_PX - tnx) * AX_D;
            my = tny + (tg.y * MM_TO_PX - tny) * AX_D;
          } else {
            mx = (lastMousePos.x - pan.x) / zoom;
            my = (canvas.height - (lastMousePos.y - pan.y)) / zoom;
          }
        } else if (edgeMidSnap) {
          mx = edgeMidSnap.x; my = edgeMidSnap.y;
        } else {
          mx = (lastMousePos.x - pan.x) / zoom;
          my = (canvas.height - (lastMousePos.y - pan.y)) / zoom;
        }
        ctx.lineTo(mx, my);
        ctx.strokeStyle = '#e94560';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Drag-to-connect preview (select mode: dragging a node onto another).
    if (dragging && connectTargetId) {
      const s = displayNodes.find((n) => n.id === dragging.nodeId);
      const t = displayNodes.find((n) => n.id === connectTargetId);
      if (s && t) {
        ctx.save();
        ctx.strokeStyle = '#4ecdc4';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(s.x * MM_TO_PX, s.y * MM_TO_PX);
        ctx.lineTo(t.x * MM_TO_PX, t.y * MM_TO_PX);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(t.x * MM_TO_PX, t.y * MM_TO_PX, 15, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Edge midpoint snap indicator — small diamond at snapped midpoint
    if (mode === 'addEdge' && edgeStart && edgeMidSnap) {
      const { x: mx, y: my } = edgeMidSnap;
      const s = 8;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(mx, my - s);
      ctx.lineTo(mx + s, my);
      ctx.lineTo(mx, my + s);
      ctx.lineTo(mx - s, my);
      ctx.closePath();
      ctx.fillStyle = 'rgba(59,130,246,0.25)';
      ctx.fill();
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    if (!gridMode) {
    // Non-storey nodes (section/view rendered separately below)
    displayNodes.filter((n) => n.type !== 'storey' && n.type !== 'section' && n.type !== 'view').forEach((n) => {
      // Room nodes with a polygon are already drawn above — skip the circle
      if (n.type === 'room' && roomPolygons.has(n.id)) return;
      const nx = n.x * MM_TO_PX;
      const ny = n.y * MM_TO_PX;

      // ─── AX NODE: square + 9 grip points ───────────────────────────────
      if (n.type === 'ax') {
        const { hw, hd } = parseColHalfDims((n.properties.column_type as string) ?? 'C25x25');
        const hwp = Math.max(12, hw * MM_TO_PX * AX_D);
        const hdp = Math.max(12, hd * MM_TO_PX * AX_D);
        ctx.beginPath();
        ctx.rect(nx - hwp, ny - hdp, 2 * hwp, 2 * hdp);
        ctx.fillStyle = NODE_COLORS['ax'] ?? '#374151';
        ctx.fill();
        if (edgeStart === n.id) { ctx.strokeStyle = '#e94560'; ctx.lineWidth = 4; ctx.stroke(); }
        else if (selectedNodeId === n.id || selectedNodeIds.includes(n.id)) { ctx.strokeStyle = '#e94560'; ctx.lineWidth = 3; ctx.stroke(); }
        else if (mode === 'addEdge') { ctx.strokeStyle = '#4ecdc4'; ctx.lineWidth = 2; ctx.stroke(); }
        // 9 grip circles
        const grips = axGrips(n);
        for (let gi = 0; gi < 9; gi++) {
          const gp = grips[gi];
          // scale grip display position from node center
          const gpx = nx + (gp.x * MM_TO_PX - nx) * AX_D;
          const gpy = ny + (gp.y * MM_TO_PX - ny) * AX_D;
          const isHov = hoveredGrip?.nodeId === n.id && hoveredGrip.gripIdx === gi;
          const isStart = edgeStart === n.id && gi === edgeStartGrip;
          ctx.beginPath();
          ctx.arc(gpx, gpy, isHov || isStart ? 5 : 2.5, 0, Math.PI * 2);
          ctx.fillStyle = isHov || isStart ? '#facc15' : 'rgba(255,255,255,0.7)';
          ctx.fill();
          ctx.strokeStyle = isHov || isStart ? '#92400e' : 'rgba(0,0,0,0.6)';
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
        // Label above node
        ctx.save();
        ctx.translate(nx, ny + hdp + 14);
        ctx.scale(1, -1);
        ctx.fillStyle = canvasText;
        ctx.font = '11px system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(n.name, 0, 0);
        ctx.restore();
        return; // skip generic rendering
      }
      // ─── Generic node ───────────────────────────────────────────────────
      ctx.beginPath();
      ctx.arc(nx, ny, 20, 0, Math.PI * 2);
      ctx.fillStyle = NODE_COLORS[n.type] ?? '#1e3a5f';
      ctx.fill();
      if (mode === 'addEdge' && edgeStart !== n.id) { ctx.strokeStyle = '#4ecdc4'; ctx.lineWidth = 2; ctx.stroke(); }
      if (edgeStart === n.id) { ctx.strokeStyle = '#e94560'; ctx.lineWidth = 4; ctx.stroke(); }
      if (selectedNodeId === n.id || selectedNodeIds.includes(n.id)) { ctx.strokeStyle = '#e94560'; ctx.lineWidth = 3; ctx.stroke(); }

      if (n.locked) {
        ctx.save();
        ctx.translate(nx + 12, ny + 12);
        ctx.scale(1, -1);
        ctx.font = '11px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🔒', 0, 0);
        ctx.restore();
      }

      ctx.save();
      ctx.translate(nx, ny - 28);
      ctx.scale(1, -1);
      ctx.fillStyle = canvasText;
      ctx.font = '11px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.name, 0, 0);
      ctx.restore();

      // Wall inline-opening badges — show 🪟 / 🚪 below node name
      if (n.type === 'wall') {
        const hasW = n.properties.has_windows === 'True' || n.properties.has_windows === true;
        const hasD = n.properties.has_doors  === 'True' || n.properties.has_doors  === true;
        if (hasW || hasD) {
          ctx.save();
          ctx.translate(nx, ny - 40);
          ctx.scale(1, -1);
          ctx.font = '10px system-ui,sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${hasW ? '🪟' : ''}${hasD ? '🚪' : ''}`, 0, 0);
          ctx.restore();
        }
      }

      // Array badge — show count if node has array_x/y/z
      {
        const ax = parseArrayProp(String(n.properties.array_x ?? ''));
        const ay = parseArrayProp(String(n.properties.array_y ?? ''));
        const az = parseArrayProp(String(n.properties.array_z ?? ''));
        const cx = Math.max(1, ax.length); const cy = Math.max(1, ay.length); const cz = Math.max(1, az.length);
        const total = cx * cy * cz;
        if (total > 1) {
          ctx.save();
          ctx.translate(nx + 16, ny + 16);
          ctx.scale(1, -1);
          ctx.fillStyle = '#f59e0b';
          ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 7px system-ui,sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(total), 0, 0);
          ctx.restore();
        }
      }

    }); // end displayNodes.forEach

    // ── Section / View line symbols ────────────────────────────────────────
    displayNodes
      .filter((n) => n.type === 'section' || n.type === 'view')
      .forEach((n) => {
        const connEdges = displayEdges.filter((e) => e.from === n.id || e.to === n.id);
        const axNodes = connEdges
          .map((e) => displayNodes.find((vn) => vn.id === (e.from === n.id ? e.to : e.from)))
          .filter((vn): vn is BubbleGraphNode => !!vn && vn.type === 'ax');

        const color = n.type === 'section' ? '#e11d48' : '#f97316';
        const isSelected = selectedNodeId === n.id;

        if (axNodes.length < 2) {
          // Not yet connected — draw a small placeholder circle
          const nx = n.x * MM_TO_PX;
          const ny = n.y * MM_TO_PX;
          ctx.beginPath();
          ctx.arc(nx, ny, 14, 0, Math.PI * 2);
          ctx.fillStyle = color + '40';
          ctx.fill();
          ctx.strokeStyle = isSelected ? '#fff' : color;
          ctx.lineWidth = isSelected ? 3 : 1.5;
          ctx.setLineDash([4, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.save();
          ctx.translate(nx, ny - 22);
          ctx.scale(1, -1);
          ctx.fillStyle = isSelected ? '#fff' : color;
          ctx.font = '10px system-ui,sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(n.name, 0, 0);
          ctx.restore();
          return;
        }

        const ax1 = axNodes[0], ax2 = axNodes[1];
        const x1 = ax1.x * MM_TO_PX, y1 = ax1.y * MM_TO_PX;
        const x2 = ax2.x * MM_TO_PX, y2 = ax2.y * MM_TO_PX;

        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) return;
        const ux = dx / len, uy = dy / len;

        // Perpendicular look direction (Y-up canvas: CCW 90° of (ux, uy) = (-uy, ux) = left of A→B)
        const lookRight = parseLookSide(n.properties.look_side, n.properties.flipped) === 'right';
        let nx = -uy, ny = ux;
        if (lookRight) { nx = -nx; ny = -ny; }

        const depthMode = parseDepthMode(n.properties.depth_mode);
        const cutDepthPx    = (depthMode === 'zero' ? 0 : depthMode === 'infinite' ? 4000 : Number(n.properties.cut_depth_mm ?? 6000)) * MM_TO_PX;
        const planeOffsetPx = Number(n.properties.cut_plane_offset_mm ?? 0) * MM_TO_PX;
        const offL = Number(n.properties.offset_left_mm ?? 0) * MM_TO_PX;
        const offR = Number(n.properties.offset_right_mm ?? 0) * MM_TO_PX;

        // Shift cut line base by plane offset along look direction (positive = toward look dir)
        const lx1 = x1 + nx * planeOffsetPx - ux * offL;
        const ly1 = y1 + ny * planeOffsetPx - uy * offL;
        const lx2 = x2 + nx * planeOffsetPx + ux * offR;
        const ly2 = y2 + ny * planeOffsetPx + uy * offR;

        ctx.save();

        // Depth band (dashed fill) — extends from cut line in look direction
        ctx.beginPath();
        ctx.moveTo(lx1, ly1);
        ctx.lineTo(lx1 + nx * cutDepthPx, ly1 + ny * cutDepthPx);
        ctx.lineTo(lx2 + nx * cutDepthPx, ly2 + ny * cutDepthPx);
        ctx.lineTo(lx2, ly2);
        ctx.closePath();
        ctx.fillStyle = color + '18';
        ctx.fill();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = color + '55';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.setLineDash([]);

        // Main cut line
        ctx.beginPath();
        ctx.moveTo(lx1, ly1);
        ctx.lineTo(lx2, ly2);
        ctx.strokeStyle = isSelected ? '#fff' : color;
        ctx.lineWidth = isSelected ? 4 : 2.5;
        ctx.stroke();

        // Endpoint circles + arrowheads
        const arrowLen = 16;
        const arrowHW = 6;
        const circleR = 10;
        [{ cx: lx1, cy: ly1 }, { cx: lx2, cy: ly2 }].forEach(({ cx, cy }) => {
          ctx.beginPath();
          ctx.arc(cx, cy, circleR, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          // Arrow pointing in look direction
          const tipX = cx + nx * (circleR + arrowLen);
          const tipY = cy + ny * (circleR + arrowLen);
          ctx.beginPath();
          ctx.moveTo(cx + nx * circleR - ux * arrowHW, cy + ny * circleR - uy * arrowHW);
          ctx.lineTo(tipX, tipY);
          ctx.lineTo(cx + nx * circleR + ux * arrowHW, cy + ny * circleR + uy * arrowHW);
          ctx.strokeStyle = isSelected ? '#fff' : color;
          ctx.lineWidth = 2;
          ctx.stroke();
        });

        // Name label at midpoint, offset toward look direction
        const midX = (lx1 + lx2) / 2, midY = (ly1 + ly2) / 2;
        ctx.save();
        ctx.translate(midX + nx * (circleR + arrowLen + 6), midY + ny * (circleR + arrowLen + 6));
        ctx.scale(1, -1);
        ctx.fillStyle = isSelected ? '#fff' : color;
        ctx.font = 'bold 11px system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(n.name, 0, 0);
        ctx.restore();

        // Midpoint handle — always-visible click target for the section node
        ctx.beginPath();
        ctx.arc(midX, midY, 7, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? '#fff' : color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.stroke();

        ctx.restore();
      });
    } // end normal-mode nodes / markers

    ctx.restore();

    // ── Multi-select highlight rings ──────────────────────────────────────────
    // Draw teal glow rings around all multi-selected nodes (second pass, in
    // world space before the axes gizmo which resets the transform).
    // Grid mode draws its own selection rings on the dots.
    if (!gridMode && selectedNodeIds.length > 0) {
      const multiSet = new Set(selectedNodeIds);
      ctx.save();
      ctx.translate(pan.x, pan.y);
      ctx.scale(zoom, zoom);
      ctx.translate(0, canvas.height / zoom);
      ctx.scale(1, -1);

      for (const n of displayNodes) {
        if (!multiSet.has(n.id)) continue;
        const nx2 = n.x * MM_TO_PX;
        const ny2 = n.y * MM_TO_PX;

        // Outer glow ring
        ctx.beginPath();
        ctx.arc(nx2, ny2, 22, 0, Math.PI * 2);
        ctx.strokeStyle = '#14b8a6'; // teal-500
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = 0.85;
        ctx.stroke();
        // Inner fill ring
        ctx.beginPath();
        ctx.arc(nx2, ny2, 18, 0, Math.PI * 2);
        ctx.strokeStyle = '#ccfbf1'; // teal-100
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.55;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    // ── Roof skeleton + framing lines (plan projection) ────────────────
    {
      ctx.save();
      ctx.translate(pan.x, pan.y);
      ctx.scale(zoom, zoom);
      ctx.translate(0, canvas.height / zoom);
      ctx.scale(1, -1);
      const ROOF_LINE: Record<string, { color: string; dash?: number[]; width: number }> = {
        roof_ridge: { color: '#c2410c', width: 2.5 },
        roof_eave:  { color: '#ea580c', dash: [8, 5], width: 2 },
        roof_hip:   { color: '#9a3412', width: 2 },
        roof_valley:{ color: '#7c2d12', dash: [4, 4], width: 2 },
        rafter:     { color: '#d97706', width: 1.2 },
        hip_rafter: { color: '#b45309', width: 1.6 },
        ridge_beam: { color: '#92400e', width: 2.2 },
        wall_plate: { color: '#a16207', dash: [6, 4], width: 1.4 },
        post:       { color: '#78350f', width: 1.5 },
      };
      for (const n of displayNodes) {
        const style = ROOF_LINE[n.type];
        if (!style) continue;
        const ax = Number(n.properties.ax);
        const ay = Number(n.properties.ay);
        const bx = Number(n.properties.bx);
        const by = Number(n.properties.by);
        if (![ax, ay, bx, by].every(Number.isFinite)) continue;
        ctx.beginPath();
        ctx.moveTo(ax * MM_TO_PX, ay * MM_TO_PX);
        ctx.lineTo(bx * MM_TO_PX, by * MM_TO_PX);
        ctx.strokeStyle = style.color;
        ctx.lineWidth = (selectedNodeId === n.id ? style.width + 1.5 : style.width) / zoom;
        ctx.setLineDash(style.dash ? style.dash.map((d) => d / zoom) : []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // ── Axes gizmo — fixed screen-space overlay, bottom-left corner ──────
    {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const gox = 52;
      const goy = canvas.height - 52;
      const al = 38; // arrow length px
      const ah = 8;  // arrowhead size px

      // X axis — red, pointing right
      ctx.strokeStyle = '#ef4444'; ctx.fillStyle = '#ef4444'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(gox, goy); ctx.lineTo(gox + al, goy); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(gox + al, goy);
      ctx.lineTo(gox + al - ah, goy - ah / 2);
      ctx.lineTo(gox + al - ah, goy + ah / 2);
      ctx.closePath(); ctx.fill();
      ctx.font = 'bold 11px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('X', gox + al + 5, goy);

      // Y axis — green, pointing up
      ctx.strokeStyle = '#22c55e'; ctx.fillStyle = '#22c55e'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(gox, goy); ctx.lineTo(gox, goy - al); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(gox, goy - al);
      ctx.lineTo(gox - ah / 2, goy - al + ah);
      ctx.lineTo(gox + ah / 2, goy - al + ah);
      ctx.closePath(); ctx.fill();
      ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('Y', gox, goy - al - 4);

      // Origin dot
      ctx.fillStyle = '#94a3b8';
      ctx.beginPath(); ctx.arc(gox, goy, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // ── Marquee box select (screen space) ─────────────────────────────────
    if (boxSelect) {
      const x = Math.min(boxSelect.x0, boxSelect.x1);
      const y = Math.min(boxSelect.y0, boxSelect.y1);
      const w = Math.abs(boxSelect.x1 - boxSelect.x0);
      const h = Math.abs(boxSelect.y1 - boxSelect.y0);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(20, 184, 166, 0.12)';
      ctx.strokeStyle = '#14b8a6';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
  }, [displayNodes, displayEdges, selectedNodeId, selectedEdge, selectedNodeIds, pan, zoom, mode, edgeStart, edgeStartGrip, hoveredGrip, isGripDragging, edgeMidSnap, lastMousePos, canvasBg, canvasGrid, canvasText, canvasEdge, theme, roomParametricGridsCanvas, boxSelect, dragging, connectTargetId,
    // getRoomCanvasPts is declared below draw (TDZ in the deps array) — it only
    // changes with visibleNodes/visibleEdges, which displayNodes already tracks.
    gridMode, gridLayout, viewNodes, viewEdges, gridHover, gridDrag, editingDim,
    gridWalls, gridOpenings, activeOpening, gridWallChipList]);

  // Resize canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const p = canvas.parentElement;
      if (p) { canvas.width = p.clientWidth; canvas.height = p.clientHeight; draw(); }
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [draw]);

  useEffect(() => { draw(); }, [draw]);

  // Floating props drag
  useEffect(() => {
    const mm = (e: MouseEvent) => {
      if (isDraggingFloat) {
        setFloatPos({ x: e.clientX - floatDragOff.x, y: e.clientY - floatDragOff.y });
      }
    };
    const mu = () => { if (isDraggingFloat) setIsDraggingFloat(false); };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
    return () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
  }, [isDraggingFloat, floatDragOff]);

  // ── Room polygon helper — shared by draw pass and hit testing ─────────

  const ROOM_GEOM_IGNORE_SET = useMemo(() => new Set(['window', 'door', 'room', 'storey']), []);

  const getRoomCanvasPts = useCallback((
    rn: BubbleGraphNode,
    list: BubbleGraphNode[] = visibleNodes,
    edgeList: BubbleGraphEdge[] = visibleEdges,
  ): {x:number;y:number}[] | null => {
    const rEdges = edgeList.filter((e) => e.from === rn.id || e.to === rn.id);
    const rConn  = rEdges
      .map((e) => list.find((vn) => vn.id === (e.from === rn.id ? e.to : e.from)))
      .filter((vn): vn is BubbleGraphNode => !!vn);

    // Pattern A: direct ax/column connections
    const directAnchors = rConn.filter((vn) => vn.type === 'ax' || vn.type === 'column');
    if (directAnchors.length >= 3)
      return directAnchors.map((vn) => ({ x: vn.x * MM_TO_PX, y: vn.y * MM_TO_PX }));

    // Pattern B: wall adjacency — collect wall endpoint ax/column nodes
    const walls = rConn.filter((vn) => vn.type === 'wall');
    if (walls.length >= 3) {
      const adj    = new Map<string, Set<string>>();
      const nById  = new Map<string, BubbleGraphNode>();
      for (const wall of walls) {
        const corners = edgeList
          .filter((e) => e.from === wall.id || e.to === wall.id)
          .map((e) => list.find((vn) => vn.id === (e.from === wall.id ? e.to : e.from)))
          .filter((vn): vn is BubbleGraphNode => !!vn && !ROOM_GEOM_IGNORE_SET.has(vn.type)
            && (vn.type === 'ax' || vn.type === 'column'));
        if (corners.length >= 2) {
          const [a, b] = corners;
          nById.set(a.id, a); nById.set(b.id, b);
          if (!adj.has(a.id)) adj.set(a.id, new Set());
          if (!adj.has(b.id)) adj.set(b.id, new Set());
          adj.get(a.id)!.add(b.id); adj.get(b.id)!.add(a.id);
        }
      }
      if (adj.size >= 3) {
        const start = [...adj.keys()][0];
        const visited = new Set<string>([start]);
        const polyIds = [start];
        let current = start;
        while (true) {
          const next = [...(adj.get(current) ?? [])].find((id) => !visited.has(id));
          if (!next) break;
          visited.add(next); polyIds.push(next); current = next;
        }
        if (polyIds.length >= 3)
          return polyIds.map((id) => ({ x: nById.get(id)!.x * MM_TO_PX, y: nById.get(id)!.y * MM_TO_PX }));
      }
    }

    // Fallback: any ≥3 non-room connected nodes
    const fallback = rConn.filter((vn) => !ROOM_GEOM_IGNORE_SET.has(vn.type));
    if (fallback.length >= 3)
      return fallback.map((vn) => ({ x: vn.x * MM_TO_PX, y: vn.y * MM_TO_PX }));

    return null;
  }, [visibleEdges, visibleNodes, ROOM_GEOM_IGNORE_SET]);

  // ── Hit testing ───────────────────────────────────────────────────────

  const getNodeAt = useCallback((sx: number, sy: number, exclude?: Set<string>): BubbleGraphNode | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cx = (sx - pan.x) / zoom;
    const cy = (canvas.height - (sy - pan.y)) / zoom;
    // Grid mode draws screen-sized glyphs, so hit radii shrink with zoom too.
    const R = (screenPx: number, normal: number) => (gridMode ? screenPx / zoom : normal);

    // ── Section / view nodes — hit against cut-line midpoint and endpoint circles ──
    const sectionNode = displayNodes.find((n) => {
      if (exclude?.has(n.id)) return false;
      if (n.type !== 'section' && n.type !== 'view') return false;
      const connEdges = displayEdges.filter((e) => e.from === n.id || e.to === n.id);
      const axNds = connEdges
        .map((e) => displayNodes.find((vn) => vn.id === (e.from === n.id ? e.to : e.from)))
        .filter((vn): vn is BubbleGraphNode => !!vn && vn.type === 'ax');
      if (axNds.length < 2) {
        // Not connected yet — fall through to regular radius check
        return Math.hypot(n.x * MM_TO_PX - cx, n.y * MM_TO_PX - cy) < R(10, 20);
      }
      const x1 = axNds[0].x * MM_TO_PX, y1 = axNds[0].y * MM_TO_PX;
      const x2 = axNds[1].x * MM_TO_PX, y2 = axNds[1].y * MM_TO_PX;
      const dxA = x2 - x1, dyA = y2 - y1;
      const lenA = Math.sqrt(dxA * dxA + dyA * dyA);
      if (lenA < 1) return false;
      const uxA = dxA / lenA, uyA = dyA / lenA;
      const lookRightA = parseLookSide(n.properties.look_side, n.properties.flipped) === 'right';
      let nxA = -uyA, nyA = uxA;
      if (lookRightA) { nxA = -nxA; nyA = -nyA; }
      const plOffPx = Number(n.properties.cut_plane_offset_mm ?? 0) * MM_TO_PX;
      const offL    = Number(n.properties.offset_left_mm  ?? 0) * MM_TO_PX;
      const offR    = Number(n.properties.offset_right_mm ?? 0) * MM_TO_PX;
      const lx1 = x1 + nxA * plOffPx - uxA * offL;
      const ly1 = y1 + nyA * plOffPx - uyA * offL;
      const lx2 = x2 + nxA * plOffPx + uxA * offR;
      const ly2 = y2 + nyA * plOffPx + uyA * offR;
      const midX = (lx1 + lx2) / 2, midY = (ly1 + ly2) / 2;
      const HIT = R(10, 18);
      if (gridMode) {
        // Compact marker: the whole line is the target.
        const L2 = dxA * dxA + dyA * dyA || 1;
        const t = Math.max(0, Math.min(1, ((cx - lx1) * (lx2 - lx1) + (cy - ly1) * (ly2 - ly1)) / L2));
        if (Math.hypot(lx1 + t * (lx2 - lx1) - cx, ly1 + t * (ly2 - ly1) - cy) < R(6, 6)) return true;
      }
      return (
        Math.hypot(midX - cx, midY - cy) < HIT ||
        Math.hypot(lx1  - cx, ly1  - cy) < HIT ||
        Math.hypot(lx2  - cx, ly2  - cy) < HIT
      );
    });
    if (sectionNode) return sectionNode;

    // ── Room grab-handle (centroid) — priority hit, so the contour can always be
    //    continued by clicking the room's "+" handle, even when the polygon (and
    //    its ax nodes) sit under the cursor. Small disk only: elsewhere the ax
    //    nodes inside the room stay clickable. ──
    const roomHandle = displayNodes.find((n) => {
      if (exclude?.has(n.id)) return false;
      if (n.type !== 'room') return false;
      const pts = getRoomCanvasPts(n);
      if (!pts || pts.length < 3) return false;
      const hX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const hY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      return Math.hypot(hX - cx, hY - cy) < R(8, ROOM_HANDLE_R + 3);
    });
    if (roomHandle) return roomHandle;

    // storey nodes are not hit-testable for movement (they are locked in canvas)
    // ── Non-room nodes ────────────────────────────────────────────────────
    // Se strâng TOȚI candidații cu distanța lor, apoi decide `pickBestHit`:
    // un punct (ax, stâlp) bate o linie (perete, grindă), iar în aceeași clasă
    // câștigă cel mai apropiat. Înainte se folosea `.find`, deci câștiga primul
    // din listă — și cum un perete e atins pe toată lungimea lui, fura clicul
    // de pe punctul de ax pe care stă.
    const candidates: Array<HitCandidate<BubbleGraphNode>> = [];
    for (const n of displayNodes) {
      if (exclude?.has(n.id)) continue;
      if (n.type === 'storey' || n.type === 'room') continue;
      if (n.type === 'section' || n.type === 'view') continue; // handled above

      if (n.type === 'ax') {
        const nx = n.x * MM_TO_PX, ny = n.y * MM_TO_PX;
        if (gridMode) {
          candidates.push({ node: n, nodeType: n.type, dist: Math.hypot(nx - cx, ny - cy), radius: R(8, 8) });
          continue;
        }
        // Cutia stâlpului e dreptunghiulară; distanța e cea Chebyshev normalizată
        // la semilățimi, ca un ax lat să rămână la fel de ușor de ochit.
        const { hw, hd } = parseColHalfDims((n.properties.column_type as string) ?? 'C25x25');
        const hwp = Math.max(12, hw * MM_TO_PX * AX_D), hdp = Math.max(12, hd * MM_TO_PX * AX_D);
        const inside = cx >= nx - hwp && cx <= nx + hwp && cy >= ny - hdp && cy <= ny + hdp;
        if (inside) {
          candidates.push({ node: n, nodeType: n.type, dist: Math.hypot(nx - cx, ny - cy), radius: Infinity });
        }
        continue;
      }

      if (n.type === 'wall' || n.type === 'beam') {
        // Hit-test along the whole span (endpoint ax→ax), not just the midpoint,
        // so walls stay selectable even when a room polygon sits under them.
        const ends = displayEdges
          .filter((e) => e.from === n.id || e.to === n.id)
          .map((e) => displayNodes.find((m) => m.id === (e.from === n.id ? e.to : e.from)))
          .filter((m): m is BubbleGraphNode => !!m && (m.type === 'ax' || m.type === 'column'));
        if (ends.length >= 2) {
          const d = distToSegment(
            cx, cy,
            ends[0].x * MM_TO_PX, ends[0].y * MM_TO_PX,
            ends[1].x * MM_TO_PX, ends[1].y * MM_TO_PX,
          );
          candidates.push({ node: n, nodeType: n.type, dist: d, radius: R(8, 12) });
          continue;
        }
      }

      candidates.push({
        node: n, nodeType: n.type,
        dist: Math.hypot(n.x * MM_TO_PX - cx, n.y * MM_TO_PX - cy),
        radius: R(10, 20),
      });
    }
    const nonRoom = pickBestHit(candidates)?.node;
    if (nonRoom) return nonRoom;

    // Second pass: room nodes (lowest priority — only selected when nothing else hit)
    const roomHit = displayNodes.find((n) => {
      if (exclude?.has(n.id)) return false;
      if (n.type !== 'room') return false;
      // Room nodes with polygon: hit-test against the polygon (point-in-polygon)
      const connPts = getRoomCanvasPts(n);
      if (connPts && connPts.length >= 3) {
        let inside = false;
        for (let i = 0, j = connPts.length - 1; i < connPts.length; j = i++) {
          const xi = connPts[i].x, yi = connPts[i].y;
          const xj = connPts[j].x, yj = connPts[j].y;
          if ((yi > cy) !== (yj > cy) && cx < (xj - xi) * (cy - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      }
      return Math.hypot(n.x * MM_TO_PX - cx, n.y * MM_TO_PX - cy) < R(10, 20);
    });
    if (roomHit) return roomHit;

    // Still allow selecting storey frame by clicking inside it
    return displayNodes.find((n) => {
      if (n.type !== 'storey') return false;
      const w = (n.properties.width as number || 0) * MM_TO_PX;
      const h = (n.properties.height as number || 0) * MM_TO_PX;
      const fx = n.x * MM_TO_PX - w / 2;
      const fy = n.y * MM_TO_PX - h / 2;
      return cx >= fx && cx <= fx + w && cy >= fy && cy <= fy + h;
    });
  }, [displayNodes, displayEdges, pan, zoom, getRoomCanvasPts, gridMode]);

  const getEdgeAt = useCallback((sx: number, sy: number): BubbleGraphEdge | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cx = (sx - pan.x) / zoom;
    const cy = (canvas.height - (sy - pan.y)) / zoom;
    return displayEdges.find((e) => {
      const sn = displayNodes.find((n) => n.id === e.from);
      const tn = displayNodes.find((n) => n.id === e.to);
      if (!sn || !tn) return false;
      return pointToLineDist(cx, cy, sn.x * MM_TO_PX, sn.y * MM_TO_PX, tn.x * MM_TO_PX, tn.y * MM_TO_PX) < 10;
    });
  }, [displayNodes, displayEdges, pan, zoom]);

  // ── Mouse handlers ────────────────────────────────────────────────────

  // ── Grid-mode gestures ──────────────────────────────────────────────────
  /** Drag a whole axis line: one value per storey in scope, clamped between its neighbours. */
  const startAxisDrag = useCallback((line: AxisLine, cx: number, cy: number) => {
    const storeyIds = gridScope === 'linked'
      ? linkedStoreys(nodes, line.storeyId, line.axis, line.index)
      : [line.storeyId];
    if (!storeyIds.length) return;
    setGridDrag({
      edit: { kind: 'moveAxis', storeyId: line.storeyId, axis: line.axis, index: line.index, deltaMm: 0, scope: gridScope },
      startMm: (line.axis === 'x' ? cx : cy) / MM_TO_PX,
      bounds: axisDeltaBounds(nodes, storeyIds, line.axis, line.index),
    });
    setSelectedEdge(null);
  }, [gridScope, nodes]);

  /**
   * Drag one cell edge. By default the envelope STEPS: a new axis is inserted,
   * the corner splits and a cloned wall closes the jog. Alt keeps the older,
   * purely geometric behaviour — the two points slide off the axis and the wall
   * between them goes oblique.
   */
  const startCellDrag = useCallback((h: CellHandle, cx: number, cy: number, detach: boolean) => {
    const storeyIds = gridScope === 'linked'
      ? linkedStoreys(nodes, h.storeyId, h.axis, h.index)
      : [h.storeyId];
    if (!storeyIds.length) return;
    const common = { storeyId: h.storeyId, axis: h.axis, index: h.index, cell: h.cell, deltaMm: 0, scope: gridScope } as const;
    setGridDrag({
      edit: detach ? { kind: 'detachCellEdge', ...common } : { kind: 'stepCellEdge', ...common },
      startMm: (h.axis === 'x' ? cx : cy) / MM_TO_PX,
      bounds: detach
        ? cellOffsetBounds(nodes, storeyIds, h.axis, h.index, h.cell)
        : axisDeltaBounds(nodes, storeyIds, h.axis, h.index),
    });
    setSelectedEdge(null);
  }, [gridScope, nodes]);

  /** How far along its wall (BIM mm) a world-space point sits. */
  const alongWallMm = useCallback((w: GridWall, cx: number, cy: number) => {
    const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-6) return 0;
    const t = ((cx - w.a.x) * dx + (cy - w.a.y) * dy) / (segLen * segLen);
    return t * w.lenMm;
  }, []);

  /** A click on one of an opening's chips — each one mirrors an inspector control. */
  const applyOpeningChip = useCallback((placement: OpeningPlacement, chipId: string) => {
    const ref = placement.op.ref;
    if (chipId === 'remove') { setNodes((prev) => removeOpening(prev, ref)); return; }
    const patch = chipId === 'across'
      ? { flip_across: !placement.op.flipAcross }
      : { flip_along: !placement.op.flipAlong };
    setNodes((prev) => patchOpening(prev, ref, patch));
  }, [setNodes]);

  /** Clicking a bubble selects every intersection on that axis (bulk edit in the inspector). */
  const selectWholeAxis = useCallback((line: AxisLine) => {
    const key = line.axis === 'x' ? 'gridX' : 'gridY';
    const ids = nodes
      .filter((n) => n.type === 'ax' && n.parentId === line.storeyId && n.properties.bimX == null && Number(n.properties[key]) === line.index)
      .map((n) => n.id);
    setSelectedNodeIds?.(ids);
    setSelectedNodeId(ids.length === 1 ? ids[0] : null);
    setSelectedEdge(null);
  }, [nodes, setSelectedNodeIds, setSelectedNodeId]);

  /** Commit the value typed into a dimension label. Shift = move only the next axis. */
  const commitDimEdit = useCallback((shift: boolean) => {
    const d = editingDim;
    setEditingDim(null);
    if (!d) return;
    let v: number;
    try { v = safeEval(d.value); } catch { return; }
    if (!Number.isFinite(v) || v < GRID_MIN_GAP_MM) return;
    setNodes((prev) => applyGridEdit(prev, edges, {
      kind: 'setSpan', storeyId: d.storeyId, axis: d.axis, index: d.index,
      spanMm: roundToSnap(v), mode: shift ? 'neighbour' : DEFAULT_SPAN_EDIT_MODE, scope: gridScope,
    }).nodes);
  }, [editingDim, edges, gridScope, setNodes]);

  /**
   * Add one hand-drawn edge. A sketch wired to an ax is a special case: the
   * edge changes what its stored numbers MEAN, so the same commit rewrites
   * them and the drawing stays where it is (`setSketchRefs`). The first ax
   * becomes the origin, the second the direction; a third is just an edge.
   */
  const addGraphEdge = useCallback((edge: BubbleGraphEdge) => {
    const a = nodes.find((n) => n.id === edge.from), b = nodes.find((n) => n.id === edge.to);
    const sk = a?.type === 'sketch' ? a : b?.type === 'sketch' ? b : null;
    const other = sk === a ? b : a;
    if (sk && other && (other.type === 'ax' || other.type === 'column')) {
      const cur = resolveSketchFrame(sk, new Map(nodes.map((n) => [n.id, n])), edges).frame.refIds;
      if (cur.length < 2 && !cur.includes(other.id)) {
        const r = setSketchRefs(nodes, edges, sk.id, [...cur, other.id]);
        if (r.nodes !== nodes) setNodes(r.nodes);
        if (r.edges !== edges) setEdges(r.edges);
        return;
      }
    }
    setEdges((prev) => [...prev, edge]);
  }, [nodes, edges, setNodes, setEdges]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // ── Grid mode: dimension labels, cell handles, bubbles, then axis lines ──
    // Nodes win over an axis line (a wall on the axis is still a wall), but a
    // click on empty grid, a room interior or the storey frame grabs the line.
    if (gridMode && gridLayout && mode === 'select' && e.button === 0 && !e.shiftKey && !spaceDown) {
      const { x: gcx, y: gcy } = screenToWorld(sx, sy, pan, zoom, canvas.height);

      // Openings first: their chips and symbols sit on top of the wall lines.
      const wc = wallChipHitTest(gridWallChipList, gcx, gcy, zoom);
      if (wc) {
        // Alt flips the has_windows / has_doors switch itself; a plain click adds one.
        setNodes((prev) => (e.altKey ? setHasOpenings(prev, wc.wallId, wc.list, !wc.on) : addOpening(prev, wc.wallId, wc.list)));
        return;
      }
      const oh = openingHitTest(gridOpenings, gcx, gcy, zoom);
      if (oh) {
        setOpeningHover(oh.placement.op.ref);
        if (oh.chip) { applyOpeningChip(oh.placement, oh.chip.id); return; }
        setOpeningDrag({
          ref: oh.placement.op.ref,
          wallId: oh.wall.wall.id,
          lenMm: oh.wall.lenMm,
          widthMm: oh.placement.op.widthMm,
          fromMm: oh.placement.op.distFromStart,
          offsetMm: oh.placement.op.distFromStart,
        });
        return;
      }

      const gh = gridHitTest(gridLayout, gcx, gcy, zoom, { skipAxisLine: true });
      if (gh?.kind === 'dim') {
        setEditingDim({ storeyId: gh.dim.storeyId, axis: gh.dim.axis, index: gh.dim.index, value: String(Math.round(gh.dim.spanMm)) });
        return;
      }
      if (gh?.kind === 'handle') { startCellDrag(gh.handle, gcx, gcy, e.altKey); return; }
      if (gh?.kind === 'bubble') { selectWholeAxis(gh.line); return; }
      const hit = getNodeAt(sx, sy);
      if (!hit || hit.type === 'room' || hit.type === 'storey') {
        const ah = gridHitTest(gridLayout, gcx, gcy, zoom);
        if (ah?.kind === 'axis') { startAxisDrag(ah.line, gcx, gcy); return; }
      }
    }

    if (e.button === 1 || (e.button === 0 && (e.shiftKey || spaceDown))) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      return;
    }

    // ── Grip drag: mousedown on any ax grip → start drawing edge (works in all modes EXCEPT addEdge) ──
    // Also select the parent ax node so its properties are visible in the panel.
    if (e.button === 0 && hoveredGrip && !isGripDragging && mode !== 'addEdge') {
      setSelectedNodeId(hoveredGrip.nodeId);
      setSelectedNodeIds?.([]);
      setSelectedEdge(null);
      setEdgeStart(hoveredGrip.nodeId);
      setEdgeStartGrip(hoveredGrip.gripIdx);
      setIsGripDragging(true);
      return;
    }

    if (mode === 'addNode') {
      const nx = (sx - pan.x) / zoom / MM_TO_PX;
      const ny = (canvas.height - (sy - pan.y)) / zoom / MM_TO_PX;
      const nt = getNodeTypeData(selectedNodeType);
      const newNode: BubbleGraphNode = {
        id: `node_${uid()}`,
        type: selectedNodeType,
        name: `${nt?.label ?? selectedNodeType}${nodes.filter((n) => n.type === selectedNodeType).length + 1}`,
        x: nx, y: ny, z: 0,
        properties: { ...(nt?.defaultProperties ?? {}) },
        // Associate with the active storey so it shows in the correct tab
        parentId: activeStoreyId ?? undefined,
      };
      setNodes((prev) => [...prev, newNode]);
      if (!continuousMode) setMode('select');
      return;
    }

    if (mode === 'addEdge') {
      // Helper: insert a new node at the midpoint of an edge (splits the edge into two)
      const insertMidpointNode = (edgeId: string): BubbleGraphNode | null => {
        const e2 = edges.find((e3) => e3.id === edgeId);
        if (!e2) return null;
        const sn2 = nodes.find((n) => n.id === e2.from);
        const tn2 = nodes.find((n) => n.id === e2.to);
        if (!sn2 || !tn2) return null;
        const midX = (sn2.x + tn2.x) / 2;
        const midY = (sn2.y + tn2.y) / 2;
        const midParent = sn2.parentId ?? tn2.parentId;
        const midStorey = midParent ? nodes.find((n) => n.id === midParent && n.type === 'storey') : undefined;
        // A free ax point: stamp its BIM position so every resolver (plan, 3D,
        // sections) puts it where the canvas shows it, not on the grid origin.
        const midBim = midStorey ? canvasToBim(storeyFrame(midStorey), { x: midX, y: midY }) : { x: midX, y: midY };
        const midNode: BubbleGraphNode = {
          id: `node_${uid()}`,
          type: 'ax',
          name: `Ax${nodes.filter((n) => n.type === 'ax').length + 1}`,
          x: midX,
          y: midY,
          z: 0,
          parentId: midParent,
          properties: { bimX: Math.round(midBim.x), bimY: Math.round(midBim.y) },
        };
        setNodes((prev) => [...prev, midNode]);
        setEdges((prev) => [
          ...prev.filter((e3) => e3.id !== edgeId),
          { id: `edge_${uid()}`, from: e2.from, to: midNode.id },
          { id: `edge_${uid()}`, from: midNode.id, to: e2.to },
        ]);
        return midNode;
      };

      // Check if cursor is snapped to an edge midpoint — insert a node there first
      let hit = getNodeAt(sx, sy);
      // If hovering a grip but getNodeAt didn't find the node (grip extends beyond body), use the grip's node
      if (!hit && hoveredGrip) {
        hit = nodes.find((n) => n.id === hoveredGrip.nodeId);
      }
      if (!hit && edgeMidSnap) {
        const newMid = insertMidpointNode(edgeMidSnap.edgeId);
        if (newMid) {
          hit = newMid;
          setEdgeMidSnap(null);
        }
      }

      if (hit && hit.type !== 'storey') {
        if (!edgeStart) {
          // If clicking on an ax node, capture the hovered grip (or default 0)
          const sg = hit.type === 'ax' ? (hoveredGrip?.nodeId === hit.id ? hoveredGrip.gripIdx : 0) : 0;
          setEdgeStartGrip(sg);
          setEdgeStart(hit.id);
        } else if (edgeStart !== hit.id) {
          // Find start node by id
          const startN = nodes.find((n) => n.id === edgeStart)!;
          const endN = hit;
          const eg = endN.type === 'ax' ? (hoveredGrip?.nodeId === endN.id ? hoveredGrip.gripIdx : 0) : 0;
          if (edgeType === 'simple') {
            addGraphEdge({
              id: `edge_${uid()}`, from: edgeStart, to: endN.id,
              ...(edgeStartGrip !== 0 ? { fromGrip: edgeStartGrip } : {}),
              ...(eg !== 0 ? { toGrip: eg } : {}),
            });
          } else {
            const intType = edgeType === 'wall' ? 'wall' : 'beam';
            const intDef = getNodeTypeData(intType);
            const intId = `${intType}_${uid()}`;
            const intNode: BubbleGraphNode = {
              id: intId,
              type: intType,
              name: `${intDef?.label ?? intType}${nodes.filter((n) => n.type === intType).length + 1}`,
              x: (startN.x + endN.x) / 2,
              y: (startN.y + endN.y) / 2,
              z: 0,
              properties: { ...(intDef?.defaultProperties ?? {}) },
              parentId: startN.parentId ?? endN.parentId,
            };
            setNodes((prev) => [...prev, intNode]);
            setEdges((prev) => [
              ...prev,
              { id: `edge_${uid()}_1`, from: edgeStart, to: intId, ...(edgeStartGrip !== 0 ? { fromGrip: edgeStartGrip } : {}) },
              { id: `edge_${uid()}_2`, from: intId, to: endN.id,   ...(eg !== 0 ? { toGrip: eg } : {}) },
            ]);
          }
          // Continuous edge creation (stay in addEdge mode; ESC/Enter to finish):
          //  • hub node anchor (room/roof/…) stays fixed → fan out corner after
          //    corner as one continuous action (press Enter to close/finish);
          //  • continuous toggle on a normal node → advance the anchor to build a
          //    polyline chain;
          //  • otherwise → classic one edge per source→target pair.
          if (HUB_TYPES.has(startN.type)) {
            // keep edgeStart + grip on the hub
          } else if (continuousMode) {
            setEdgeStart(endN.id);
            setEdgeStartGrip(eg);
          } else {
            setEdgeStart(null);
            setEdgeStartGrip(0);
          }
        }
      }
      return;
    }

    // Node has priority over edge — check node first
    const hitNode = getNodeAt(sx, sy);
    if (hitNode) {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+click: toggle node in multi-selection
        const isAlreadySelected = selectedNodeIds.includes(hitNode.id);
        const newIds = isAlreadySelected
          ? selectedNodeIds.filter((id) => id !== hitNode.id)
          : [...selectedNodeIds, hitNode.id];
        setSelectedNodeIds?.(newIds);
        setSelectedNodeId(null);
        setSelectedEdge(null);
      } else {
        // Normal click: ensure hit node is in selection (keep multi if already selected)
        const alreadyInMulti = selectedNodeIds.includes(hitNode.id);
        if (!alreadyInMulti) {
          setSelectedNodeIds?.([]);
          setSelectedNodeId(hitNode.id);
        } else {
          setSelectedNodeId(null);
        }
        setSelectedEdge(null);
        // Storey nodes are immovable in canvas — they are always locked
        if (!hitNode.locked && hitNode.type !== 'storey') {
          const moveIds = alreadyInMulti && selectedNodeIds.length > 0
            ? selectedNodeIds
            : [hitNode.id];
          const origins: Record<string, { x: number; y: number }> = {};
          for (const id of moveIds) {
            const n = nodes.find((x) => x.id === id);
            if (n && !n.locked && n.type !== 'storey') origins[id] = { x: n.x, y: n.y };
          }
          setDragging({
            nodeId: hitNode.id,
            ox: sx - hitNode.x * MM_TO_PX * zoom - pan.x,
            oy: (canvas.height - hitNode.y * MM_TO_PX * zoom) - (sy - pan.y),
            origins,
          });
        }
      }
      return;
    }
    const hitEdge = getEdgeAt(sx, sy);
    if (hitEdge) { setSelectedEdge(hitEdge.id); setSelectedNodeId(null); setSelectedNodeIds?.([]); return; }
    // Empty space in select mode → start marquee box select
    if (mode === 'select' && e.button === 0) {
      setBoxSelect({ x0: sx, y0: sy, x1: sx, y1: sy });
      if (!e.ctrlKey && !e.metaKey) {
        setSelectedNodeId(null);
        setSelectedEdge(null);
        setSelectedNodeIds?.([]);
      }
      return;
    }
    setSelectedNodeId(null); setSelectedEdge(null);
    if (!e.ctrlKey && !e.metaKey) setSelectedNodeIds?.([]);
  }, [mode, pan, zoom, nodes, edges, edgeStart, edgeStartGrip, hoveredGrip, isGripDragging, edgeMidSnap, edgeType, selectedNodeType, continuousMode, activeStoreyId, selectedNodeIds, spaceDown, getNodeAt, getEdgeAt, setNodes, setEdges, addGraphEdge, setSelectedNodeIds,
    gridMode, gridLayout, startAxisDrag, startCellDrag, selectWholeAxis,
    gridOpenings, gridWallChipList, applyOpeningChip]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    setLastMousePos({ x: sx, y: sy });

    // ── Grid mode: a live axis / cell drag, previewed, committed on mouse-up ──
    if (gridDrag) {
      const { x: gcx, y: gcy } = screenToWorld(sx, sy, pan, zoom, canvas.height);
      const curMm = (gridDrag.edit.axis === 'x' ? gcx : gcy) / MM_TO_PX;
      const delta = Math.min(gridDrag.bounds.hi, Math.max(gridDrag.bounds.lo, roundToSnap(curMm - gridDrag.startMm)));
      if (delta !== gridDrag.edit.deltaMm) setGridDrag({ ...gridDrag, edit: { ...gridDrag.edit, deltaMm: delta } });
      return;
    }
    // Sliding an opening along its wall writes the same offset the inspector does.
    if (openingDrag) {
      const w = gridWalls.find((g) => g.wall.id === openingDrag.wallId);
      if (w) {
        const { x: gcx, y: gcy } = screenToWorld(sx, sy, pan, zoom, canvas.height);
        const offsetMm = offsetForCentre(openingDrag.widthMm, alongWallMm(w, gcx, gcy), w.lenMm, GRID_SNAP_MM);
        if (offsetMm !== openingDrag.offsetMm) setOpeningDrag({ ...openingDrag, offsetMm });
      }
      return;
    }
    // Hover feedback for the grid's own targets (and node labels).
    if (gridMode && gridLayout && mode === 'select' && !dragging && !isPanning && !boxSelect && !isGripDragging) {
      const { x: gcx, y: gcy } = screenToWorld(sx, sy, pan, zoom, canvas.height);
      const oh = openingHitTest(gridOpenings, gcx, gcy, zoom);
      const nextOpening = oh?.placement.op.ref ?? null;
      if (!sameOpeningRef(nextOpening, openingHover)) setOpeningHover(nextOpening);
      if (oh) {
        if (gridHover) setGridHover(null);
        if (hoveredGrip) setHoveredGrip(null);
        return;
      }
      const gh = gridHitTest(gridLayout, gcx, gcy, zoom, { skipAxisLine: true });
      let next: GridHover = gh;
      if (!next) {
        const hit = getNodeAt(sx, sy);
        if (hit && hit.type !== 'storey' && hit.type !== 'room') next = { kind: 'node', nodeId: hit.id };
        else next = gridHitTest(gridLayout, gcx, gcy, zoom);
      }
      const same = (p: GridHover, q: GridHover) => {
        if (p === q) return true;
        if (!p || !q || p.kind !== q.kind) return false;
        if (p.kind === 'node' && q.kind === 'node') return p.nodeId === q.nodeId;
        if (p.kind === 'dim' && q.kind === 'dim') return p.dim === q.dim;
        if (p.kind === 'handle' && q.kind === 'handle') return p.handle === q.handle;
        if ((p.kind === 'axis' || p.kind === 'bubble') && (q.kind === 'axis' || q.kind === 'bubble')) return p.line === q.line;
        return false;
      };
      if (!same(next, gridHover)) setGridHover(next);
    } else if (gridHover) {
      setGridHover(null);
    }

    // Edge-midpoint snap computation (only while drawing an edge)
    if (mode === 'addEdge' && edgeStart) {
      const cx = (sx - pan.x) / zoom;
      const cy = (canvas.height - (sy - pan.y)) / zoom;
      const SNAP_PX = 24;
      let bestSnap: { x: number; y: number; edgeId: string } | null = null;
      let bestD = SNAP_PX;
      for (const e2 of displayEdges) {
        const sn2 = displayNodes.find((n) => n.id === e2.from);
        const tn2 = displayNodes.find((n) => n.id === e2.to);
        if (!sn2 || !tn2) continue;
        const mx = (sn2.x + tn2.x) / 2 * MM_TO_PX;
        const my = (sn2.y + tn2.y) / 2 * MM_TO_PX;
        const d = Math.hypot(mx - cx, my - cy);
        if (d < bestD) { bestD = d; bestSnap = { x: mx, y: my, edgeId: e2.id }; }
      }
      setEdgeMidSnap(bestSnap);
    } else if (edgeMidSnap) {
      setEdgeMidSnap(null);
    }

    // Ax node grip hover detection (always, not just in addEdge mode).
    // Grid mode shows only the centre dot, sized on screen, so test grip 0 alone.
    {
      const cx = (sx - pan.x) / zoom;
      const cy = (canvas.height - (sy - pan.y)) / zoom;
      const GRIP_HIT = gridMode ? 8 / zoom : 12; // canvas units
      const gripCount = gridMode ? 1 : 9;
      let found: { nodeId: string; gripIdx: number } | null = null;
      for (const n of displayNodes) {
        if (n.type !== 'ax') continue;
        const nnx = n.x * MM_TO_PX, nny = n.y * MM_TO_PX;
        const grips = axGrips(n);
        for (let gi = 0; gi < gripCount; gi++) {
          const gpx = nnx + (grips[gi].x * MM_TO_PX - nnx) * AX_D;
          const gpy = nny + (grips[gi].y * MM_TO_PX - nny) * AX_D;
          if (Math.hypot(gpx - cx, gpy - cy) < GRIP_HIT) {
            found = { nodeId: n.id, gripIdx: gi };
            break;
          }
        }
        if (found) break;
      }
      setHoveredGrip(found);
    }

    if (isPanning) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
      return;
    }

    if (boxSelect) {
      setBoxSelect({ ...boxSelect, x1: sx, y1: sy });
      return;
    }

    // Skip node dragging if we're in grip-drag mode
    if (isGripDragging) return;

    if (dragging) {
      const draggedNode = nodes.find((n) => n.id === dragging.nodeId);
      if (!draggedNode || draggedNode.type === 'storey' || draggedNode.locked) return;

      // Single-node drag: if the cursor is over another node, switch to
      // "connect" intent — freeze the source at its origin and let mouse-up
      // create an edge, rather than moving it. Multi-node drags always move.
      const single = Object.keys(dragging.origins).length <= 1;
      if (single) {
        const over = getNodeAt(sx, sy, new Set([dragging.nodeId]));
        if (over && over.id !== dragging.nodeId && over.type !== 'storey') {
          if (connectTargetId !== over.id) setConnectTargetId(over.id);
          const o = dragging.origins[dragging.nodeId];
          if (o && (draggedNode.x !== o.x || draggedNode.y !== o.y)) {
            setNodes((prev) => prev.map((n) => n.id === dragging.nodeId ? { ...n, x: o.x, y: o.y } : n));
          }
          return; // don't move while hovering a connect target
        }
        if (connectTargetId) setConnectTargetId(null);
      }

      const nx = (sx - pan.x - dragging.ox) / zoom / MM_TO_PX;
      const ny = (canvas.height - (sy - pan.y - dragging.oy)) / zoom / MM_TO_PX;
      const origin = dragging.origins[dragging.nodeId];
      if (origin && Object.keys(dragging.origins).length > 1) {
        const ddx = nx - origin.x;
        const ddy = ny - origin.y;
        setNodes((prev) => prev.map((n) => {
          const o = dragging.origins[n.id];
          if (!o || n.locked || n.type === 'storey') return n;
          return { ...n, x: o.x + ddx, y: o.y + ddy };
        }));
      } else {
        setNodes((prev) => prev.map((n) => n.id === dragging.nodeId ? { ...n, x: nx, y: ny } : n));
      }
    }
  }, [pan, panStart, zoom, isPanning, isGripDragging, dragging, boxSelect, nodes, setNodes, mode, edgeStart, edgeMidSnap, displayEdges, displayNodes, setHoveredGrip, getNodeAt, connectTargetId,
    gridMode, gridLayout, gridDrag, gridHover, hoveredGrip,
    gridWalls, gridOpenings, openingDrag, openingHover, alongWallMm]);

  const handleMouseUp = useCallback((e?: React.MouseEvent<HTMLCanvasElement>) => {
    // Grid-mode drag: one commit = one undo step (the preview never touched the graph).
    const gd = gridDragRef.current;
    if (gd) {
      if (gd.edit.deltaMm !== 0) {
        const res = applyGridEdit(nodes, edges, gd.edit);
        if (res.nodes !== nodes) setNodes(res.nodes);
        if (res.edges !== edges) setEdges(res.edges);
      }
      setGridDrag(null);
      return;
    }
    const od = openingDragRef.current;
    if (od) {
      // A click that never moved is a selection: the inspector opens on the
      // host wall, where the full window / door configurator lives.
      if (od.offsetMm === od.fromMm) {
        setSelectedNodeId(od.ref.kind === 'node' ? od.ref.nodeId : od.wallId);
        setSelectedNodeIds?.([]);
      } else {
        setNodes((prev) => patchOpening(prev, od.ref, { [offsetKeyFor(od.ref)]: od.offsetMm }));
      }
      setOpeningDrag(null);
      return;
    }

    // Finalize marquee selection
    const box = boxSelectRef.current;
    if (box) {
      const canvas = canvasRef.current;
      if (canvas) {
        const left = Math.min(box.x0, box.x1);
        const right = Math.max(box.x0, box.x1);
        const top = Math.min(box.y0, box.y1);
        const bottom = Math.max(box.y0, box.y1);
        const w = right - left;
        const h = bottom - top;
        // Tiny drag = plain click (already cleared selection on mousedown)
        if (w > 4 || h > 4) {
          const hitIds: string[] = [];
          const hitR = 14; // screen-px radius approx at current zoom
          for (const n of displayNodes) {
            if (n.type === 'storey') continue;
            const nsx = pan.x + n.x * MM_TO_PX * zoom;
            const nsy = pan.y + canvas.height - n.y * MM_TO_PX * zoom;
            if (nsx + hitR >= left && nsx - hitR <= right && nsy + hitR >= top && nsy - hitR <= bottom) {
              hitIds.push(n.id);
            }
          }
          const additive = !!(e && (e.ctrlKey || e.metaKey));
          if (additive && selectedNodeIds.length > 0) {
            const merged = Array.from(new Set([...selectedNodeIds, ...hitIds]));
            setSelectedNodeIds?.(merged);
            setSelectedNodeId(merged.length === 1 ? merged[0] : null);
          } else if (hitIds.length === 1) {
            setSelectedNodeIds?.([]);
            setSelectedNodeId(hitIds[0]);
          } else if (hitIds.length > 1) {
            setSelectedNodeIds?.(hitIds);
            setSelectedNodeId(null);
          } else if (!additive) {
            setSelectedNodeIds?.([]);
            setSelectedNodeId(null);
          }
          setSelectedEdge(null);
        }
      }
      setBoxSelect(null);
    }

    // Complete grip drag: if we were dragging from a grip and we're now hovering another grip → create edge
    if (isGripDragging && edgeStart) {
      if (hoveredGrip && hoveredGrip.nodeId !== edgeStart) {
        const eg = hoveredGrip.gripIdx;
        if (edgeType === 'simple' || edgeType === undefined) {
          addGraphEdge({
            id: `edge_${uid()}`, from: edgeStart, to: hoveredGrip.nodeId,
            ...(edgeStartGrip !== 0 ? { fromGrip: edgeStartGrip } : {}),
            ...(eg !== 0 ? { toGrip: eg } : {}),
          });
        } else {
          // Wall or beam: create intermediate node + two edges
          const intType = edgeType === 'wall' ? 'wall' : 'beam';
          const intDef = getNodeTypeData(intType);
          const startN = nodes.find((n) => n.id === edgeStart);
          const endN = nodes.find((n) => n.id === hoveredGrip.nodeId);
          const intId = `${intType}_${uid()}`;
          const intNode: BubbleGraphNode = {
            id: intId,
            type: intType,
            name: `${intDef?.label ?? intType}${nodes.filter((n) => n.type === intType).length + 1}`,
            x: ((startN?.x ?? 0) + (endN?.x ?? 0)) / 2,
            y: ((startN?.y ?? 0) + (endN?.y ?? 0)) / 2,
            z: 0,
            properties: { ...(intDef?.defaultProperties ?? {}) },
            parentId: startN?.parentId ?? endN?.parentId,
          };
          setNodes((prev) => [...prev, intNode]);
          setEdges((prev) => [
            ...prev,
            { id: `edge_${uid()}_1`, from: edgeStart, to: intId, ...(edgeStartGrip !== 0 ? { fromGrip: edgeStartGrip } : {}) },
            { id: `edge_${uid()}_2`, from: intId, to: hoveredGrip.nodeId, ...(eg !== 0 ? { toGrip: eg } : {}) },
          ]);
        }
      }
      setEdgeStart(null);
      setEdgeStartGrip(0);
      setIsGripDragging(false);
    }

    // Drag-to-connect (select mode): a single-node drag released while hovering
    // another node creates an edge instead of moving the node.
    if (dragging && connectTargetId) {
      const fromId = dragging.nodeId;
      const toId = connectTargetId;
      const o = dragging.origins[fromId];
      if (o) setNodes((prev) => prev.map((n) => n.id === fromId ? { ...n, x: o.x, y: o.y } : n));
      const exists = edges.some((ed) =>
        (ed.from === fromId && ed.to === toId) || (ed.from === toId && ed.to === fromId));
      if (!exists) addGraphEdge({ id: `edge_${uid()}`, from: fromId, to: toId });
      setConnectTargetId(null);
      setDragging(null);
      setIsPanning(false);
      return;
    }

    void e;
    setDragging(null);
    setIsPanning(false);
  }, [isGripDragging, edgeStart, hoveredGrip, edgeStartGrip, edgeType, nodes, edges, dragging, connectTargetId, setEdges, setNodes, addGraphEdge, pan, zoom, displayNodes, selectedNodeIds, setSelectedNodeIds, setSelectedNodeId]);

  // Refs for latest pan/zoom so the wheel handler is registered once without stale closures
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  useEffect(() => { panRef.current = pan; }, [pan]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  // Non-passive wheel — zoom towards mouse cursor; registered once via refs
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const curPan = panRef.current;
      const curZoom = zoomRef.current;
      const h = canvas.height;
      // Canvas uses Y-flipped system: screen_y = pan.y + h - bim_y * zoom
      // So bim_x = (mx - pan.x) / zoom, bim_y = (pan.y + h - my) / zoom
      const wx = (mx - curPan.x) / curZoom;
      const wy = (curPan.y + h - my) / curZoom;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const nz = Math.max(0.1, Math.min(5, curZoom * delta));
      // After zoom: mx = newPan.x + wx*nz, my = newPan.y + h - wy*nz
      const newPan = { x: mx - wx * nz, y: my - h + wy * nz };
      panRef.current = newPan;
      zoomRef.current = nz;
      setPan(newPan);
      setZoom(nz);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []); // register once — reads latest pan/zoom via refs

  // ESC cancels a grid drag, an opening slide or a dimension edit. Separate from
  // the []-deps handler below, which cannot see this state.
  useEffect(() => {
    if (!gridDrag && !editingDim && !openingDrag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setGridDrag(null); setEditingDim(null); setOpeningDrag(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gridDrag, editingDim, openingDrag]);

  // Space = temporary pan; ESC = cancel placement / box
  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEdgeStart(null);
        setEdgeStartGrip(0);
        setBoxSelect(null);
        setMode('select');
        return;
      }
      // Enter finishes a continuous edge chain (room fan / polyline) without
      // leaving addEdge mode, so you can immediately start the next contour.
      if (e.key === 'Enter' && !isTypingTarget(e.target)) {
        setEdgeStart(null);
        setEdgeStartGrip(0);
        return;
      }
      if (e.code === 'Space' && !e.repeat && !isTypingTarget(e.target)) {
        e.preventDefault();
        setSpaceDown(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    const onBlur = () => setSpaceDown(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────

  const selectedNodeData = useMemo(
    () => (inspectNodes ?? visibleNodes).find((n) => n.id === selectedNodeId) ?? null,
    [inspectNodes, visibleNodes, selectedNodeId],
  );

  const deleteSelected = useCallback(() => {
    if (selectedNodeIds.length > 0) {
      const toDelete = new Set(selectedNodeIds);
      for (const id of selectedNodeIds) {
        const n = nodes.find((x) => x.id === id);
        if (n?.type === 'storey') {
          for (const c of nodes) if (c.parentId === n.id) toDelete.add(c.id);
        }
      }
      setNodes((prev) => prev.filter((x) => !toDelete.has(x.id)));
      setEdges((prev) => prev.filter((e) => !toDelete.has(e.from) && !toDelete.has(e.to)));
      setSelectedNodeIds?.([]);
      setSelectedNodeId(null);
      return;
    }
    if (selectedNodeId) {
      const n = visibleNodes.find((x) => x.id === selectedNodeId);
      if (!n) return;
      if (n.type === 'storey') {
        const childIds = nodes.filter((c) => c.parentId === n.id).map((c) => c.id);
        const toDelete = new Set([n.id, ...childIds]);
        setNodes((prev) => prev.filter((x) => !toDelete.has(x.id)));
        setEdges((prev) => prev.filter((e) => !toDelete.has(e.from) && !toDelete.has(e.to)));
      } else {
        setNodes((prev) => prev.filter((x) => x.id !== n.id));
        setEdges((prev) => prev.filter((e) => e.from !== n.id && e.to !== n.id));
      }
      setSelectedNodeId(null);
    } else if (selectedEdge) {
      setEdges((prev) => prev.filter((e) => e.id !== selectedEdge));
      setSelectedEdge(null);
    }
  }, [selectedNodeId, selectedNodeIds, selectedEdge, nodes, visibleNodes, setNodes, setEdges, setSelectedNodeIds]);

  // ── Grid → walls + rooms, and Join rooms ───────────────────────────────────
  const handleGenerateRoomGrid = useCallback(() => {
    if (!activeStoreyId) { toast.error('Open a storey first'); return; }
    const ax = nodes.filter((n) => n.type === 'ax' && n.parentId === activeStoreyId);
    if (ax.length < 4) { toast.error('Storey needs at least a 2×2 ax grid'); return; }
    const { nodes: add, edges: addE } = generateRoomGrid(activeStoreyId, ax, nodes, edges, (t) => `${t}_${uid()}`);
    if (!add.length) { toast.info('Grid already filled'); return; }
    setNodes((prev) => [...prev, ...add]);
    setEdges((prev) => [...prev, ...addE]);
    const nr = add.filter((n) => n.type === 'room').length;
    const nw = add.filter((n) => n.type === 'wall').length;
    toast.success(`Added ${nr} room${nr === 1 ? '' : 's'} + ${nw} wall${nw === 1 ? '' : 's'}`);
  }, [activeStoreyId, nodes, edges, setNodes, setEdges]);

  const selectedRooms = useMemo(
    () => selectedNodeIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is BubbleGraphNode => !!n && n.type === 'room'),
    [selectedNodeIds, nodes],
  );

  const handleJoinRooms = useCallback(() => {
    if (selectedRooms.length !== 2) return;
    const [rA, rB] = selectedRooms;
    const storeyId = rA.parentId ?? activeStoreyId ?? undefined;
    const ax = nodes.filter((n) => n.type === 'ax' && n.parentId === storeyId);
    const plan = planJoinRooms(rA, rB, ax, nodes, edges);
    if (!plan) { toast.error('Rooms must share a wall to join'); return; }
    const remove = new Set(plan.removeNodeIds);
    setNodes((prev) => prev
      .map((n) => n.id === plan.keepRoomId
        ? { ...n, x: plan.center.x, y: plan.center.y, properties: { ...n.properties, cells: plan.cells } }
        : n)
      .filter((n) => !remove.has(n.id)));
    setEdges((prev) => {
      // Drop edges touching removed nodes, and the kept room's OLD room→ax edges;
      // keep any other room links (coverings, etc.). Then wire the new outline.
      const kept = prev.filter((e) => {
        if (remove.has(e.from) || remove.has(e.to)) return false;
        const involvesRoom = e.from === plan.keepRoomId || e.to === plan.keepRoomId;
        if (!involvesRoom) return true;
        const otherId = e.from === plan.keepRoomId ? e.to : e.from;
        const other = nodes.find((n) => n.id === otherId);
        return !(other && other.type === 'ax');
      });
      const wired = plan.boundaryAxIds.map((axId) => ({ id: `edge_${uid()}`, from: plan.keepRoomId, to: axId }));
      return [...kept, ...wired];
    });
    setSelectedNodeIds?.([plan.keepRoomId]);
    setSelectedNodeId(plan.keepRoomId);
    toast.success('Rooms joined');
  }, [selectedRooms, activeStoreyId, nodes, edges, setNodes, setEdges, setSelectedNodeIds]);

  // Delete/Backspace key → delete selected node or edge (same as context menu)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      // A selected annotation owns the key — the drawing layer deletes it.
      if (useBubbleGraphStore.getState().selectedAnnotationId) return;
      if (useArmare.getState().selectieCurenta().length > 0) return;
      deleteSelected();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelected]);

  // Ctrl/Cmd+Z → undo, Ctrl/Cmd+Shift+Z (and Ctrl+Y) → redo — see useUndoableGraphState.
  useEffect(() => {
    if (!undo || !redo) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
      else if (e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      else if (e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  const copyNode = useCallback(() => {
    if (!selectedNodeId) return;
    const n = visibleNodes.find((x) => x.id === selectedNodeId);
    if (!n || n.type === 'storey' || n.locked) return;
    const copy: BubbleGraphNode = { ...n, id: `node_${uid()}`, name: `${n.name}_copy`, x: n.x + 500, y: n.y + 500, properties: { ...n.properties } };
    setNodes((prev) => [...prev, copy]);
    setSelectedNodeId(copy.id);
  }, [selectedNodeId, nodes, setNodes]);

  const insertNodeOnEdge = useCallback(() => {
    if (!selectedEdge) return;
    const edge = visibleEdges.find((e) => e.id === selectedEdge);
    if (!edge) return;
    const sn = visibleNodes.find((n) => n.id === edge.from), tn = visibleNodes.find((n) => n.id === edge.to);
    if (!sn || !tn) return;
    const nt = getNodeTypeData(selectedNodeType);
    const nid = `node_${uid()}`;
    const nn: BubbleGraphNode = {
      id: nid, type: selectedNodeType,
      name: `${nt?.label ?? selectedNodeType}${nodes.filter((n) => n.type === selectedNodeType).length + 1}`,
      x: (sn.x + tn.x) / 2, y: (sn.y + tn.y) / 2, z: 0,
      properties: { ...(nt?.defaultProperties ?? {}) },
    };
    setNodes((prev) => [...prev, nn]);
    setEdges((prev) => [
      ...prev.filter((e) => e.id !== selectedEdge),
      { id: `edge_${uid()}_1`, from: edge.from, to: nid },
      { id: `edge_${uid()}_2`, from: nid, to: edge.to },
    ]);
    setSelectedEdge(null); setSelectedNodeId(nid);
  }, [selectedEdge, edges, nodes, selectedNodeType, setNodes, setEdges]);

  const duplicateStorey = useCallback((storeyId: string) => {
    const storey = nodes.find((n) => n.id === storeyId);
    if (!storey || storey.type !== 'storey') return;
    const newStoreyId = `storey_${uid()}`;
    const children = nodes.filter((n) => n.parentId === storeyId);
    const idMap = new Map([[storeyId, newStoreyId]]);
    const newNodes: BubbleGraphNode[] = [
      {
        ...storey, id: newStoreyId, name: `${storey.name} (copy)`, x: storey.x + 1000, y: storey.y - 2000, locked: true,
        // Own axis arrays: a shallow spread would leave both storeys editing one array.
        properties: { ...storey.properties, axesX: parseAxes(storey.properties.axesX), axesY: parseAxes(storey.properties.axesY) },
      },
    ];
    children.forEach((c) => {
      const nid = `${c.type}_${newStoreyId}_${uid()}`;
      idMap.set(c.id, nid);
      newNodes.push({ ...c, id: nid, parentId: newStoreyId, x: c.x + 1000, y: c.y - 2000 });
    });
    const childSet = new Set(children.map((c) => c.id));
    const newEdges = edges
      .filter((e) => childSet.has(e.from) && childSet.has(e.to))
      .map((e) => ({ ...e, id: `edge_${uid()}`, from: idMap.get(e.from) ?? e.from, to: idMap.get(e.to) ?? e.to }));
    setNodes((prev) => [...prev, ...newNodes]);
    setEdges((prev) => [...prev, ...newEdges]);
  }, [nodes, edges, setNodes, setEdges]);


  // ── Node prop update helpers ──────────────────────────────────────────

  const handleUpdateField = useCallback((field: keyof BubbleGraphNode, v: unknown) => {
    // Match the inspector's node resolution: a stale SINGLE id in selectedNodeIds
    // must not shadow the actually-shown selectedNodeId (else edits hit the wrong
    // node and the field appears to "revert"). Only treat >1 as a real bulk edit.
    const targetIds = selectedNodeIds.length > 1
      ? selectedNodeIds
      : selectedNodeId ? [selectedNodeId] : selectedNodeIds;
    if (targetIds.length === 0) return;
    setNodes((prev) => prev.map((n) => targetIds.includes(n.id) ? { ...n, [field]: v } : n));
  }, [selectedNodeId, selectedNodeIds, setNodes]);

  const handleUpdateProp = useCallback((key: string, v: unknown) => {
    // Match the inspector's node resolution: a stale SINGLE id in selectedNodeIds
    // must not shadow the actually-shown selectedNodeId (else edits hit the wrong
    // node and the field appears to "revert"). Only treat >1 as a real bulk edit.
    const targetIds = selectedNodeIds.length > 1
      ? selectedNodeIds
      : selectedNodeId ? [selectedNodeId] : selectedNodeIds;
    if (targetIds.length === 0) return;
    // With a scenario active the edit is a decision of THAT scenario: it goes
    // into its patches and the base graph stays as drawn.
    const active = useScenarios.getState().activeId;
    if (active) {
      for (const id of targetIds) useScenarios.getState().patchNode(active, nodes, id, key, v);
      return;
    }
    setNodes((prev) => prev.map((n) =>
      targetIds.includes(n.id) ? { ...n, properties: { ...n.properties, [key]: v } } : n,
    ));
  }, [selectedNodeId, selectedNodeIds, setNodes, nodes]);

  const handleUpdateProps = useCallback((patch: Record<string, unknown>) => {
    const targetIds = selectedNodeIds.length > 1
      ? selectedNodeIds
      : selectedNodeId ? [selectedNodeId] : selectedNodeIds;
    if (targetIds.length === 0) return;
    const active = useScenarios.getState().activeId;
    if (active) {
      for (const id of targetIds)
        for (const [k, v] of Object.entries(patch)) useScenarios.getState().patchNode(active, nodes, id, k, v);
      return;
    }
    setNodes((prev) => applyPropPatch(prev, targetIds, patch));
  }, [selectedNodeId, selectedNodeIds, setNodes, nodes]);

  const handleAddProp = useCallback(() => {
    const key = prompt('Property name:');
    if (key && selectedNodeId) handleUpdateProp(key, '');
  }, [selectedNodeId, handleUpdateProp]);

  const handleDeleteProp = useCallback((key: string) => {
    if (!selectedNodeId) return;
    setNodes((prev) => prev.map((n) => {
      if (n.id !== selectedNodeId) return n;
      const { [key]: _, ...rest } = n.properties;
      return { ...n, properties: rest };
    }));
  }, [selectedNodeId, setNodes]);

  // Nodes and edges in one go — the two records coalesce into one undo step,
  // the same way the stair generator's do.
  const handleRewireGraph = useCallback((fn: (ns: BubbleGraphNode[], es: BubbleGraphEdge[]) => { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] }) => {
    const r = fn(nodes, edges);
    if (r.nodes !== nodes) setNodes(r.nodes);
    if (r.edges !== edges) setEdges(r.edges);
  }, [nodes, edges, setNodes, setEdges]);

  const handleGenerateStair = useCallback((level: 'outline' | 'flights' | 'steps') => {
    const id = selectedNodeId ?? (selectedNodeIds.length === 1 ? selectedNodeIds[0] : null);
    const stairwell = id ? nodes.find((n) => n.id === id && n.type === 'stairwell') : null;
    if (!stairwell) {
      toast.error('Select a stairwell node first');
      return;
    }
    const result = solveStair({ nodes, edges, stairwellId: stairwell.id, level });
    const applied = applyStairResult(nodes, edges, result);
    setNodes(applied.nodes);
    setEdges(applied.edges);

    const errs = result.diagnostics.filter((d) => d.severity === 'error');
    if (errs.length) { toast.error(errs[0].message); return; }
    const g = result.geometry;
    if (g) {
      toast.success(
        `Stair: ${g.steps} risers of ${Math.round(g.riserMm)} mm, going ${Math.round(g.treadMm)} mm `
        + `(2h+g = ${Math.round(2 * g.riserMm + g.treadMm)})`,
      );
    }
    for (const d of result.diagnostics.filter((x) => x.severity === 'warning')) toast.error(d.message);
    for (const d of result.diagnostics.filter((x) => x.severity === 'info')) toast.info(d.message);
  }, [selectedNodeId, selectedNodeIds, nodes, edges, setNodes, setEdges]);

  // Live regeneration: edit a stair parameter or drag the node, and the stair
  // rebuilds itself. The explicit buttons remain for switching detail level.
  useAutoRegenerateStairs(nodes, edges, setNodes, setEdges);

  const handleGenerateRoof = useCallback((level: 'envelope' | 'skeleton' | 'framing') => {
    const id = selectedNodeId
      ?? (selectedNodeIds.length === 1 ? selectedNodeIds[0] : null);
    if (!id) return;
    const roof = nodes.find((n) => n.id === id && n.type === 'roof');
    if (!roof) {
      toast.error('Select a roof node first');
      return;
    }
    const result = solveRoof({ nodes, edges, roofId: id, level });
    const applied = applyRoofResult(nodes, edges, result);
    setNodes(applied.nodes);
    setEdges(applied.edges);
    const errs = result.diagnostics.filter((d) => d.severity === 'error');
    const warns = result.diagnostics.filter((d) => d.severity === 'warning');
    const members = result.addNodes.filter((n) => n.type !== 'roof_ridge' && n.type !== 'roof_eave' && n.type !== 'roof_hip' && n.type !== 'roof_valley').length;
    if (errs.length) toast.error(errs[0].message);
    else if (level === 'framing') toast.success(`Roof complete: ${result.faces.length} faces, ${members} members`);
    else if (warns.length) toast.info(warns[0].message);
    else toast.success(`Roof ${level}: ${result.faces.length} face(s)`);
  }, [selectedNodeId, selectedNodeIds, nodes, edges, setNodes, setEdges]);

  // ── Render ────────────────────────────────────────────────────────────

  const panelClass = cn(
    'flex flex-col bg-background text-foreground border-border',
    isFullscreen ? 'fixed inset-0 z-[150]' : 'relative w-full h-full',
  );

  const bulkCanvasNodes = selectedNodeIds.length > 1
    ? (inspectNodes ?? nodes).filter((n) => selectedNodeIds.includes(n.id))
    : undefined;

  // Representative node: first of bulk selection, or single selected node
  const representativeNode = bulkCanvasNodes ? (bulkCanvasNodes[0] ?? null) : selectedNodeData;

  const PropsContent = (
    <PropertiesPanel
      node={representativeNode}
      bulkNodes={bulkCanvasNodes}
      onUpdateField={handleUpdateField}
      onUpdateProp={handleUpdateProp}
      onUpdateProps={handleUpdateProps}
      onAddProp={handleAddProp}
      onDeleteProp={handleDeleteProp}
      onDuplicateStorey={duplicateStorey}
      onOpenSectionTab={onOpenSectionTab}
      onGenerateRoof={handleGenerateRoof}
      onGenerateStair={handleGenerateStair}
      projectSystem={projectSystem}
      onRewireGraph={handleRewireGraph}
    />
  );

  return (
    <div className={panelClass}>
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-muted/30 flex-shrink-0 flex-wrap">
        {/* The model is set up in this order: the axis grid, the storeys on it,
            then the grid view to edit both on the canvas. Each step says when it is done. */}
        {(() => {
          const ro = lang === 'ro';
          const axesDone = buildingAxes.xValues.length > 0 && buildingAxes.yValues.length > 0;
          const storeysDone = nodes.some((n) => n.type === 'storey');
          const steps = [
            { n: 1, label: ro ? 'Axe' : 'Axes', done: axesDone, active: false, onClick: onOpenAxes,
              title: ro ? 'Pasul 1 — rețeaua de axe a clădirii' : 'Step 1 — the building axis grid' },
            { n: 2, label: ro ? 'Niveluri' : 'Storeys', done: storeysDone, active: false, onClick: onAddStorey,
              title: ro ? 'Pasul 2 — adaugă un nivel pe axe' : 'Step 2 — add a storey on the axes' },
            { n: 3, label: ro ? 'Grilă' : 'Grid', done: false, active: gridMode, onClick: toggleGridMode,
              title: ro ? 'Pasul 3 — mod grilă: axele ca linii, intersecțiile ca puncte; trage axele și cotele direct pe canvas'
                : 'Step 3 — grid mode: axes as lines, crossings as points; drag axes and dimensions on the canvas' },
          ];
          return (
            <div className="bb-setup-steps" role="group" aria-label={ro ? 'Setarea modelului' : 'Model setup'}>
              {steps.map((st, i) => (
                <React.Fragment key={st.n}>
                  {i > 0 && <span className="bb-setup-arrow" aria-hidden="true">›</span>}
                  <button
                    type="button"
                    className={cn('bb-setup-step', st.done && 'done', st.active && 'active')}
                    onClick={st.onClick}
                    disabled={!st.onClick}
                    title={st.title}
                    aria-pressed={st.n === 3 ? st.active : undefined}
                  >
                    <span className="bb-setup-num">{st.done ? '✓' : st.n}</span>
                    {st.n === 3 && <Grid3x3 className="h-3.5 w-3.5" />}
                    <span>{st.label}</span>
                  </button>
                </React.Fragment>
              ))}
            </div>
          );
        })()}
        <div className="w-px h-4 bg-border mx-1" />
        <input
          className="text-xs bg-background border border-border rounded px-2 py-0.5 w-32"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="Project name"
          title="IFC project name"
        />
        {/* Bridges: the model pushed live to other applications. */}
        <HudMenu
          className={cn('bb-bridges', ifcLiveSyncEnabled && 'live')}
          icon={<span className={cn('bb-bridge-dot', ifcLiveSyncStatus)} aria-hidden="true" />}
          label={<span>{lang === 'ro' ? 'Bridge-uri' : 'Bridges'}</span>}
          items={[
            { label: lang === 'ro' ? 'Trimite modelul către alte aplicații' : 'Send the model to other applications', heading: true },
            {
              label: `Live: ifc-lite viewer — ${ifcLiveSyncEnabled
                ? (ifcLiveSyncStatus === 'connected' ? (lang === 'ro' ? 'conectat' : 'connected')
                  : ifcLiveSyncStatus === 'connecting' ? (lang === 'ro' ? 'se conectează' : 'connecting')
                  : ifcLiveSyncStatus === 'error' ? (lang === 'ro' ? 'eroare' : 'error') : (lang === 'ro' ? 'pornit' : 'on'))
                : (lang === 'ro' ? 'oprit' : 'off')}`,
              active: ifcLiveSyncEnabled,
              onClick: () => setIfcLiveSyncEnabled((v) => !v),
            },
            {
              label: archicadBusy ? (lang === 'ro' ? 'ArchiCAD — se trimite…' : 'ArchiCAD — pushing…') : (lang === 'ro' ? 'Generează în ArchiCAD (Tapir)' : 'Generate in ArchiCAD (Tapir)'),
              onClick: archicadBusy ? undefined : handlePushToArchicad,
            },
          ]}
        />
        <div className="w-px h-4 bg-border mx-1" />
        <button className="text-xs px-2 py-1 rounded hover:bg-accent" onClick={() => {
          const canvas = canvasRef.current; if (!canvas) return;
          const cx = canvas.width / 2; const cy = canvas.height / 2;
          const curPan = panRef.current; const curZoom = zoomRef.current;
          const nz = Math.min(5, curZoom * 1.2);
          const wx = (cx - curPan.x) / curZoom; const wy = (curPan.y + canvas.height - cy) / curZoom;
          const np = { x: cx - wx * nz, y: cy - canvas.height + wy * nz };
          panRef.current = np; zoomRef.current = nz; setPan(np); setZoom(nz);
        }}>＋</button>
        <button className="text-xs px-2 py-1 rounded hover:bg-accent" onClick={() => {
          const canvas = canvasRef.current; if (!canvas) return;
          const cx = canvas.width / 2; const cy = canvas.height / 2;
          const curPan = panRef.current; const curZoom = zoomRef.current;
          const nz = Math.max(0.1, curZoom * 0.8);
          const wx = (cx - curPan.x) / curZoom; const wy = (curPan.y + canvas.height - cy) / curZoom;
          const np = { x: cx - wx * nz, y: cy - canvas.height + wy * nz };
          panRef.current = np; zoomRef.current = nz; setPan(np); setZoom(nz);
        }}>－</button>
        <button className="text-xs px-2 py-1 rounded hover:bg-accent" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }}>⌂</button>
        <div className="flex-1" />
        <button
          className="text-xs px-2 py-1 rounded hover:bg-accent"
          onClick={() => setIsFullscreen((f) => !f)}
          title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* ── Graph tool rail (narrow, symbolic) ── */}
        <aside
          className="bb-graph-tools"
          style={{
            width: mode === 'addNode' || mode === 'addEdge' ? 52 : 40,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            borderRight: '1px solid hsl(var(--border))',
            background: 'hsl(var(--muted) / 0.14)',
            overflowY: 'auto',
            padding: '6px 0',
            gap: 4,
            transition: 'width 0.15s ease',
          }}
        >
          {([
            { m: 'select' as InteractionMode, title: 'Select · drag box · Space+drag pan', Icon: MousePointer2 },
            { m: 'addNode' as InteractionMode, title: 'Add node', Icon: Circle },
            { m: 'addEdge' as InteractionMode, title: 'Add edge', Icon: Minus },
          ] as const).map(({ m, title, Icon }) => {
            const active = mode === m;
            const isTool = m !== 'select';
            return (
              <button
                key={m}
                type="button"
                title={title}
                aria-label={title}
                onClick={() => {
                  if (m === 'select') { setMode('select'); setEdgeStart(null); return; }
                  setMode(mode === m ? 'select' : m);
                  setEdgeStart(null);
                }}
                style={{
                  width: 30, height: 30, borderRadius: 6, display: 'grid', placeItems: 'center',
                  border: '1px solid', cursor: 'pointer', transition: 'all 0.12s', padding: 0,
                  background: active && isTool ? 'hsl(var(--primary))'
                    : active ? 'hsl(var(--accent))' : 'transparent',
                  color: active && isTool ? '#fff'
                    : active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                  borderColor: active && isTool ? 'hsl(var(--primary))'
                    : active ? 'hsl(var(--border))' : 'transparent',
                }}
              >
                <Icon size={15} strokeWidth={m === 'addEdge' ? 2.25 : 1.85} />
              </button>
            );
          })}

          {/* ── Grid → rooms · Join rooms ── */}
          <div style={{ width: 24, height: 1, background: 'hsl(var(--border))', margin: '2px 0' }} />
          {([
            {
              key: 'grid', title: 'Fill grid with walls + rooms (active storey)',
              Icon: Grid3x3, onClick: handleGenerateRoomGrid,
              enabled: !!activeStoreyId,
            },
            {
              key: 'join', title: 'Join the 2 selected rooms (removes the wall between them)',
              Icon: Combine, onClick: handleJoinRooms,
              enabled: selectedRooms.length === 2,
            },
          ] as const).map(({ key, title, Icon, onClick, enabled }) => (
            <button
              key={key}
              type="button"
              title={title}
              aria-label={title}
              disabled={!enabled}
              onClick={onClick}
              style={{
                width: 30, height: 30, borderRadius: 6, display: 'grid', placeItems: 'center',
                border: '1px solid transparent', padding: 0,
                cursor: enabled ? 'pointer' : 'not-allowed',
                opacity: enabled ? 1 : 0.35,
                background: key === 'join' && enabled ? 'hsl(var(--primary) / 0.12)' : 'transparent',
                color: key === 'join' && enabled ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
                transition: 'all 0.12s',
              }}
            >
              <Icon size={15} strokeWidth={1.85} />
            </button>
          ))}

          {mode === 'addNode' && (
            <div style={{ width: '100%', padding: '4px 4px 0', borderTop: '1px solid hsl(var(--border))', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
              {/* Type search: the list is long enough that scrolling a 40px
                  select to "Dom" is slower than typing "do". The first match
                  becomes the armed type, so search-then-click just works. */}
              <input
                value={nodeTypeQuery}
                onChange={(e) => {
                  const q = e.target.value;
                  setNodeTypeQuery(q);
                  const first = filterNodeTypes(q)[0];
                  if (first) setSelectedNodeType(first.id);
                }}
                onKeyDown={(e) => { if (e.key === 'Escape') setNodeTypeQuery(''); e.stopPropagation(); }}
                placeholder="🔍"
                title="Caută tip de nod (nume, id, descriere)"
                style={{
                  width: 40, boxSizing: 'border-box',
                  background: 'hsl(var(--background))',
                  border: '1px solid hsl(var(--border))', borderRadius: 5,
                  padding: '2px 3px', fontSize: 9, color: 'hsl(var(--foreground))',
                }}
              />
              <select
                value={selectedNodeType}
                onChange={(e) => setSelectedNodeType(e.target.value)}
                title="Node type"
                style={{
                  width: 40, writingMode: 'horizontal-tb',
                  background: 'hsl(var(--background))',
                  border: '1px solid hsl(var(--border))', borderRadius: 5,
                  padding: '2px 0', fontSize: 9, color: 'hsl(var(--foreground))', cursor: 'pointer',
                }}
              >
                {filterNodeTypes(nodeTypeQuery).map((nt) => (
                  <option key={nt.id} value={nt.id}>{nt.label}</option>
                ))}
              </select>
              <button
                type="button"
                title="Continuous place"
                onClick={() => setContinuousMode((c) => !c)}
                style={{
                  width: 30, height: 22, borderRadius: 5, fontSize: 9, fontWeight: 700,
                  border: '1px solid', cursor: 'pointer',
                  background: continuousMode ? 'hsl(var(--primary) / 0.15)' : 'transparent',
                  color: continuousMode ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
                  borderColor: continuousMode ? 'hsl(var(--primary) / 0.4)' : 'hsl(var(--border))',
                }}
              >∞</button>
            </div>
          )}

          {mode === 'addEdge' && (
            <div style={{ width: '100%', padding: '4px 4px 0', borderTop: '1px solid hsl(var(--border))', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
              {([
                { et: 'simple' as EdgePlacementType, label: '—', title: 'Simple edge' },
                { et: 'wall' as EdgePlacementType, label: '▬', title: 'Wall edge' },
                { et: 'beam' as EdgePlacementType, label: '═', title: 'Beam edge' },
              ]).map(({ et, label, title }) => (
                <button
                  key={et}
                  type="button"
                  title={title}
                  onClick={() => setEdgeType(et)}
                  style={{
                    width: 30, height: 24, borderRadius: 5, fontSize: 12, lineHeight: 1,
                    border: '1px solid', cursor: 'pointer',
                    background: edgeType === et ? 'hsl(var(--primary) / 0.14)' : 'transparent',
                    color: edgeType === et ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
                    borderColor: edgeType === et ? 'hsl(var(--primary) / 0.4)' : 'transparent',
                  }}
                >{label}</button>
              ))}
            </div>
          )}

          {(selectedNodeId || selectedEdge || selectedNodeIds.length > 0) && (
            <div style={{ width: '100%', marginTop: 'auto', padding: '4px', borderTop: '1px solid hsl(var(--border))', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
              {selectedNodeId && (
                <button type="button" title="Copy node" onClick={copyNode}
                  style={{ width: 30, height: 24, borderRadius: 5, fontSize: 11, border: '1px solid hsl(var(--border))', background: 'transparent', cursor: 'pointer', color: 'hsl(var(--foreground))' }}>⧉</button>
              )}
              {selectedEdge && (
                <button type="button" title="Insert node on edge" onClick={insertNodeOnEdge}
                  style={{ width: 30, height: 24, borderRadius: 5, fontSize: 11, border: '1px solid hsl(var(--border))', background: 'transparent', cursor: 'pointer', color: 'hsl(var(--foreground))' }}>⊕</button>
              )}
              <button type="button" title="Delete" onClick={deleteSelected}
                style={{ width: 30, height: 24, borderRadius: 5, fontSize: 12, border: '1px solid hsl(var(--border))', background: 'transparent', cursor: 'pointer', color: '#ef4444' }}>×</button>
            </div>
          )}
        </aside>

        {/* ── Canvas ── */}
        <section className="flex-1 relative overflow-hidden" style={{ background: canvasBg }}>

          {/* Visibility filter panel */}
          <div className="absolute top-2 left-2 z-10 select-none" style={{ pointerEvents: 'auto' }}>
            <div style={{
              background: 'hsl(var(--background) / 0.93)',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8,
              boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
              padding: '5px 6px',
              minWidth: 104,
            }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'hsl(var(--muted-foreground))', paddingBottom: 4, marginBottom: 4, borderBottom: '1px solid hsl(var(--border))' }}>
                Visibility
              </div>
              {VISIBILITY_TYPES.map(({ type, icon, label }) => {
                const hidden = hiddenNodeTypes.has(type);
                return (
                  <button
                    key={type}
                    onClick={() => setHiddenNodeTypes((prev) => {
                      const next = new Set(prev);
                      if (next.has(type)) next.delete(type); else next.add(type);
                      return next;
                    })}
                    title={hidden ? `Show ${label}` : `Hide ${label}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5, width: '100%',
                      padding: '2px 4px', borderRadius: 4, border: 'none', cursor: 'pointer',
                      background: 'transparent', textAlign: 'left',
                      opacity: hidden ? 0.35 : 1,
                      transition: 'opacity 0.12s',
                    }}
                  >
                    <span style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', lineHeight: 1 }}>{hidden ? '○' : '◉'}</span>
                    <span style={{ fontSize: 10, color: 'hsl(var(--foreground))' }}>{icon} {label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <canvas
            ref={canvasRef}
            className="block w-full h-full"
            style={{
              cursor: isPanning || spaceDown
                ? (isPanning ? 'grabbing' : 'grab')
                : boxSelect
                  ? 'crosshair'
                  : mode !== 'select'
                    ? 'crosshair'
                    : gridDrag
                      ? (gridDrag.edit.axis === 'x' ? 'col-resize' : 'row-resize')
                      : openingDrag
                        ? 'move'
                        : openingHover
                          ? 'pointer'
                          : gridHover?.kind === 'axis' || gridHover?.kind === 'handle'
                        ? ((gridHover.kind === 'axis' ? gridHover.line.axis : gridHover.handle.axis) === 'x' ? 'col-resize' : 'row-resize')
                        : gridHover?.kind === 'dim'
                          ? 'text'
                          : gridHover?.kind === 'bubble' || gridHover?.kind === 'node'
                            ? 'pointer'
                            : 'default',
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onContextMenu={(e) => e.preventDefault()}
          />

          {/* Grid mode bar: scope toggle + gesture hints */}
          {gridMode && mode === 'select' && !spaceDown && !boxSelect && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 text-[11px] text-foreground bg-background/90 border border-border px-3 py-1 rounded-full shadow">
              <span className="font-medium">Grilă</span>
              <span className="text-muted-foreground">·</span>
              <div className="flex rounded border border-border overflow-hidden">
                <button
                  className={cn('px-2 py-0.5', gridScope === 'linked' ? 'bg-primary/15 text-primary' : 'hover:bg-accent text-muted-foreground')}
                  onClick={() => setGridScope('linked')}
                  title="Mutarea se aplică pe toate etajele care au aceeași valoare a axului"
                >Toate etajele</button>
                <button
                  className={cn('px-2 py-0.5', gridScope === 'single' ? 'bg-primary/15 text-primary' : 'hover:bg-accent text-muted-foreground')}
                  onClick={() => setGridScope('single')}
                  title="Mutarea se aplică doar pe etajul de sub cursor"
                >Doar etajul</button>
              </div>
              <span className="text-muted-foreground">·</span>
              <span
                className="text-muted-foreground"
                title={'Trage o linie de ax ca s-o muți.\n'
                  + 'Trage pătratul unei celule: anvelopa face o treaptă și se inserează un ax nou (Alt = doar decalezi punctele, fără ax).\n'
                  + 'Clic pe o cotă ca s-o scrii: Enter translatează axele următoare, Shift+Enter mută doar axul următor.\n'
                  + 'Golurile: trage simbolul pe perete, ⇕ / ⇔ întorc fereastra sau ușa, × o șterge.\n'
                  + 'Selectează un perete pentru chip-urile ▭ / ◗ care adaugă un gol (Alt = comută has_windows / has_doors).'}
              >trage un ax · trage pătratul unei celule → treaptă · clic pe o cotă · goluri pe perete</span>
            </div>
          )}

          {/* Inline dimension editor, positioned over the label it edits */}
          {gridMode && editingDim && gridLayout && canvasRef.current && (() => {
            const dim = gridLayout.flatMap((l) => l.dims).find((d) =>
              d.storeyId === editingDim.storeyId && d.axis === editingDim.axis && d.index === editingDim.index);
            if (!dim) return null;
            const sp = worldToScreen(dim.anchor.x, dim.anchor.y, pan, zoom, canvasRef.current.height);
            return (
              <input
                key={`${editingDim.storeyId}-${editingDim.axis}-${editingDim.index}`}
                type="text"
                inputMode="decimal"
                autoFocus
                className="absolute w-[76px] text-center text-[11px] px-1 py-0.5 rounded border border-primary bg-background text-foreground shadow outline-none"
                style={{ left: sp.x - 38, top: sp.y - 11 }}
                value={editingDim.value}
                title="Enter = aplică (axele următoare se translatează) · Shift+Enter = doar axul următor · Esc = anulează"
                onChange={(e) => setEditingDim({ ...editingDim, value: e.target.value })}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitDimEdit(e.shiftKey); }
                  else if (e.key === 'Escape') { e.preventDefault(); setEditingDim(null); }
                }}
                onBlur={() => setEditingDim(null)}
                onFocus={(e) => e.currentTarget.select()}
              />
            );
          })()}

          {/* Mode hint */}
          {mode !== 'select' && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[11px] text-foreground bg-background/90 border border-border px-3 py-1 rounded-full pointer-events-none shadow">
              {mode === 'addEdge'
                ? (edgeStart
                    ? (HUB_TYPES.has(nodes.find((n) => n.id === edgeStart)?.type ?? '')
                        ? '→ Click each corner  •  Enter to finish  •  ESC cancel'
                        : continuousMode
                          ? '→ Click to chain  •  Enter to finish  •  ESC cancel'
                          : '→ Click target node  •  ESC to cancel')
                    : '→ Click source node  •  ESC to cancel')
                : 'Click canvas to place node  •  ESC to cancel'}
            </div>
          )}
          {mode === 'select' && (spaceDown || boxSelect) && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[11px] text-foreground bg-background/90 border border-border px-3 py-1 rounded-full pointer-events-none shadow">
              {spaceDown ? 'Space + drag to pan' : 'Drag to box-select · Ctrl adds'}
            </div>
          )}

          {/* Zoom badge */}
          <div className="absolute bottom-2 right-2 text-[10px] text-muted-foreground bg-background/60 px-1.5 py-0.5 rounded pointer-events-none">
            {Math.round(zoom * 100)}%
          </div>

          {/* Guided build questline (subtle onboarding HUD) */}
          <QuestPanel nodes={nodes} edges={edges} buildingAxes={buildingAxes} economy={economy} />
        </section>

        {/* ── Docked Properties ── */}
        {!hidePropsPanel && isPropsDocked && (
          <aside style={{
            width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
            borderLeft: '1px solid hsl(var(--border))', background: 'hsl(var(--card))',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '7px 10px', flexShrink: 0,
              background: 'hsl(var(--secondary))', borderBottom: '1px solid hsl(var(--border))',
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'hsl(var(--muted-foreground))' }}>
                {bulkCanvasNodes ? `Properties · ${bulkCanvasNodes.length}` : 'Properties'}
              </span>
              <button
                style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', background: 'none', border: 'none', cursor: 'pointer', padding: '1px 5px', borderRadius: 3, lineHeight: 1 }}
                onClick={() => setIsPropsDocked(false)}
                title="Float panel"
              >⊹</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {PropsContent}
            </div>
          </aside>
        )}
      </div>

      {/* ── Floating Properties ── */}
      {!hidePropsPanel && !isPropsDocked && createPortal(
        <div style={{
          position: 'fixed', zIndex: 160,
          left: floatPos.x, top: floatPos.y,
          width: floatSize.w, height: floatSize.h,
          background: 'hsl(var(--card))',
          border: '1px solid hsl(var(--border))',
          borderTop: '2px solid hsl(var(--primary))',
          borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,0.32)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '7px 10px', flexShrink: 0,
              background: 'hsl(var(--secondary))', borderBottom: '1px solid hsl(var(--border))',
              cursor: 'move', userSelect: 'none',
            }}
            onMouseDown={(e) => {
              setIsDraggingFloat(true);
              setFloatDragOff({ x: e.clientX - floatPos.x, y: e.clientY - floatPos.y });
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'hsl(var(--muted-foreground))' }}>
              {bulkCanvasNodes ? `Properties · ${bulkCanvasNodes.length}` : 'Properties'}
            </span>
            <button
              style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', background: 'none', border: 'none', cursor: 'pointer', padding: '1px 5px', borderRadius: 3 }}
              onClick={() => setIsPropsDocked(true)}
            >Dock ⊞</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>{PropsContent}</div>
        </div>,
        document.body,
      )}

    </div>
  );
}

/**
 * Apply a whole property patch to the chosen nodes in ONE update — so picking a
 * detail type is one undo step, not nine. A key set to `undefined` is deleted:
 * switching profiles must not leave the previous profile's dimensions behind.
 */
function applyPropPatch(
  prev: BubbleGraphNode[],
  ids: string[],
  patch: Record<string, unknown>,
): BubbleGraphNode[] {
  const target = new Set(ids);
  return prev.map((n) => {
    if (!target.has(n.id)) return n;
    const props: Record<string, unknown> = { ...n.properties };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete props[k];
      else props[k] = v;
    }
    return { ...n, properties: props };
  });
}

// ─── Electron helpers ────────────────────────────────────────────────────

const eAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
const isElectron = !!eAPI;

/**
 * Hook: wires Electron menu events (Save, Open, New, Export IFC) into
 * callbacks provided by the panel. Also exposes save/open helpers.
 */
function useElectronBridge(callbacks: {
  onSave: () => void;
  onOpen: () => void;
  onNew: () => void;
  onExportIfc: () => void;
}) {
  const { onSave, onOpen, onNew, onExportIfc } = callbacks;
  useEffect(() => {
    if (!eAPI) return;
    const wSave = () => onSave();
    const wOpen = () => onOpen();
    const wNew  = () => onNew();
    const wIfc  = () => onExportIfc();
    eAPI.onMenuSaveProject(wSave);
    eAPI.onMenuNewProject(wNew);
    eAPI.onMenuExportIfc(wIfc);
    eAPI.onMenuOpenProject?.(wOpen);
    return () => {
      eAPI.removeAllListeners('menu:save-project');
      eAPI.removeAllListeners('menu:new-project');
      eAPI.removeAllListeners('menu:export-ifc');
      eAPI.removeAllListeners('menu:open-project');
    };
  }, [onSave, onOpen, onNew, onExportIfc]);
}

/**
 * Hook: views pulled out into their own OS window (desktop build only).
 *
 * This window owns the model; a detached one only draws it. So the traffic is
 * one-way — a `GraphBroadcast` on every change — and the only thing coming back
 * is which tabs currently have a window, so the tab bar can say so.
 *
 * The broadcast is throttled because it carries the whole graph (a real project
 * is well over a hundred kilobytes as JSON) and `nodes` gets a new identity on
 * every frame of a node drag. Trailing edge, so the last state always lands.
 */
const BROADCAST_THROTTLE_MS = 150;

function useDetachedViews(model: {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes: BuildingAxes;
  projectName: string;
  tabs: ViewTab[];
  viewer3DType: Viewer3DType;
  activeTab: ViewTab | undefined;
  setActiveTabId: (id: string) => void;
}) {
  const { nodes, edges, buildingAxes, projectName, tabs, viewer3DType, activeTab, setActiveTabId } = model;
  const [detachedIds, setDetachedIds] = useState<string[]>([]);

  const revRef = useRef(0);
  const payloadRef = useRef<GraphBroadcast | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastSentRef = useRef(0);

  const buildPayload = useCallback((): GraphBroadcast => ({
    rev: ++revRef.current, projectName, nodes, edges, buildingAxes, tabs, viewer3DType,
  }), [projectName, nodes, edges, buildingAxes, tabs, viewer3DType]);

  // Who is listening — and the first answer, since a window may have been
  // opened before this hook mounted (a reload of the main window).
  useEffect(() => {
    if (!eAPI) return;
    eAPI.onDetachedViews(setDetachedIds);
    eAPI.listDetachedViews().then(setDetachedIds).catch(() => { /* none */ });
    return () => eAPI.removeAllListeners('view:detached-list');
  }, []);

  // The model, throttled. Nothing is sent while no window is listening.
  useEffect(() => {
    if (!eAPI || detachedIds.length === 0) return;
    payloadRef.current = buildPayload();
    const send = () => {
      timerRef.current = null;
      lastSentRef.current = Date.now();
      if (payloadRef.current) eAPI.publishGraph(payloadRef.current);
    };
    const since = Date.now() - lastSentRef.current;
    if (since >= BROADCAST_THROTTLE_MS) send();
    else if (timerRef.current === null) {
      timerRef.current = window.setTimeout(send, BROADCAST_THROTTLE_MS - since);
    }
    // No cleanup: a pending trailing send is exactly what we want to keep.
  }, [buildPayload, detachedIds.length]);

  useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current); }, []);

  const detach = useCallback((tab: ViewTab) => {
    if (!eAPI || !isDetachable(tab.type)) return;
    // Warm the cache first: the new window asks for the model on mount, and
    // that question can beat the broadcast this detaching triggers.
    eAPI.publishGraph(buildPayload());
    lastSentRef.current = Date.now();
    eAPI.detachView({ viewType: tab.type, tabId: tab.id, label: tab.label });
  }, [buildPayload]);

  // ⌘⇧D, and a detached window asking to be shown here again.
  useEffect(() => {
    if (!eAPI) return;
    eAPI.onMenuDetachView(() => { if (activeTab) detach(activeTab); });
    return () => eAPI.removeAllListeners('menu:detach-view');
  }, [activeTab, detach]);

  useEffect(() => {
    if (!eAPI) return;
    eAPI.onActivateTab((tabId) => setActiveTabId(tabId));
    return () => eAPI.removeAllListeners('view:activate-tab');
  }, [setActiveTabId]);

  return { detachedIds, detach: isElectron ? detach : undefined };
}

// ─── BubbleGraphPanel (outer wrapper) ────────────────────────────────────

/** App shell profile — which modules the shell offers (see shell/capabilities.ts). */
export type { AppProfile } from '@/components/bubble-graph/shell/capabilities';
import type { AppProfile } from '@/components/bubble-graph/shell/capabilities';

interface BubbleGraphPanelProps {
  visible: boolean;
  onClose: () => void;
  /**
   * @deprecated Prefer `appProfile`. When true (and appProfile unset), behaves as `minimal`.
   */
  minimalMode?: boolean;
  /**
   * - `full`: all viewers and engines (default)
   * - `minimal`: Storeys + OpenGeometry 3D only
   * - `clean`: OpenGeometry 3D + quantities + floorplans/sections/elevations + world/tables/sheets/terrain
   *            (no Ara3D/WebIfc, no OG-2D duplicates, no IFC plan/tiles, no Composer)
   */
  appProfile?: AppProfile;
  /** Cloud Clean: account chip + Projects / Sign out in the header */
  cloudAccount?: {
    username: string;
    onProjects: () => void;
    onSignOut: () => void;
    onSupport?: () => void;
    supportUnreadCount?: number;
  };
}

// ─── Discipline badge helpers ───────────────────────────────────────────

const DISC_CLS: Record<StoreyDiscipline, string> = {
  architectural: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  structural: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  mep: 'bg-green-500/20 text-green-400 border-green-500/30',
};

export function BubbleGraphPanel({
  visible,
  onClose,
  minimalMode = false,
  appProfile,
  cloudAccount,
}: BubbleGraphPanelProps) {
  const profile: AppProfile = appProfile ?? (minimalMode ? 'minimal' : 'full');
  const openGeoOnly = profile === 'minimal' || profile === 'clean';
  const caps = capabilitiesFor(profile);
  const ro = caps.lang === 'ro';

  const [navOpen, setNavOpen] = useState(() => {
    try { return localStorage.getItem('bb_clean_nav_open') !== '0'; } catch { return true; }
  });
  const [inspOpen, setInspOpen] = useState(() => {
    try { return localStorage.getItem('bb_clean_insp_open') !== '0'; } catch { return true; }
  });
  // The inspector's width: dragged from its left edge, remembered per browser.
  const INSP_DEFAULT_W = 300;
  const clampInspW = (w: number) => Math.round(Math.min(Math.max(w, 240), Math.min(720, (typeof window !== 'undefined' ? window.innerWidth : 1600) * 0.55)));
  const [inspW, setInspW] = useState(() => {
    try { const v = Number(localStorage.getItem('bb_insp_w')); return v > 0 ? v : INSP_DEFAULT_W; } catch { return INSP_DEFAULT_W; }
  });
  useEffect(() => {
    try { localStorage.setItem('bb_insp_w', String(inspW)); } catch { /* per-viewer convenience only */ }
  }, [inspW]);
  const startInspResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = inspW;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('bb-resizing');
    const move = (ev: PointerEvent) => setInspW(clampInspW(w0 + (x0 - ev.clientX)));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('bb-resizing');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspW]);
  useEffect(() => {
    try {
      localStorage.setItem('bb_clean_nav_open', navOpen ? '1' : '0');
      localStorage.setItem('bb_clean_insp_open', inspOpen ? '1' : '0');
    } catch { /* ignore */ }
  }, [navOpen, inspOpen, profile]);

  const storedNodes = useBubbleGraphStore((s) => s.bubbleGraphNodes);
  const storedEdges = useBubbleGraphStore((s) => s.bubbleGraphEdges);
  const buildingAxes = useBubbleGraphStore((s) => s.buildingAxes);
  const setBuildingAxes = useBubbleGraphStore((s) => s.setBuildingAxes);
  const activeStoreyId = useBubbleGraphStore((s) => s.activeStoreyId);
  const setActiveStoreyId = useBubbleGraphStore((s) => s.setActiveStoreyId);

  const {
    nodes, edges, setNodes, setEdges, undo, redo, canUndo, canRedo, breakCoalescing,
  } = useUndoableGraphState(storedNodes, storedEdges);
  // True only after the initial backend load completes — gates auto-save
  const [isLoaded, setIsLoaded] = useState(false);
  const [projectName, setProjectName] = useState<string>('My Building');
  /** Project-wide structural system; elements override it via properties.structural_system. */
  const [structuralSystem, setStructuralSystem] = useState<StructuralSystem>('unset');
  // Project-level material and finish choices (which brick, which plaster,
  // which floor). Groups absent here run on the library's declared defaults.
  const [projectSpecs, setProjectSpecs] = useState<SpecSelection>({});
  const [specsPanelOpen, setSpecsPanelOpen] = useState(false);

  // Live quantities/costs dashboard. Visibility and the collapsed state are the
  // user's and survive a reload — a dashboard you have to re-open every session
  // is not a dashboard.
  const [dashboardOpen, setDashboardOpen] = useState<boolean>(() => readDashboardPref('open', false));
  const [dashboardCollapsed, setDashboardCollapsed] = useState<boolean>(() => readDashboardPref('collapsed', false));
  useEffect(() => { writeDashboardPref({ open: dashboardOpen, collapsed: dashboardCollapsed }); }, [dashboardOpen, dashboardCollapsed]);

  // ── Cost scenarios ──────────────────────────────────────────────────────
  // The viewers and the quantities read `viewNodes`: the base graph with the
  // active scenario's delta applied. The canvas keeps editing `nodes`.
  const scenarioList = useScenarios((s) => s.scenarios);
  const activeScenarioId = useScenarios((s) => s.activeId);
  const scenarioBudget = useScenarios((s) => s.budget);
  const activeScenario = useMemo(
    () => (activeScenarioId ? scenarioList.find((s) => s.id === activeScenarioId) ?? null : null),
    [scenarioList, activeScenarioId],
  );
  const viewNodes = useMemo(() => applyScenario(nodes, edges, activeScenario), [nodes, edges, activeScenario]);
  const viewSystem: StructuralSystem = activeScenario?.structuralSystem ?? structuralSystem;
  const viewSpecs = useMemo<SpecSelection>(
    () => ({ ...projectSpecs, ...(activeScenario?.specs ?? {}) }),
    [projectSpecs, activeScenario],
  );
  // The takeoff reads the project system and specifications from here (see takeoffContext).
  useEffect(() => { setTakeoffContext({ structuralSystem: viewSystem, specs: viewSpecs }); }, [viewSystem, viewSpecs]);
  const scenarioResults = useScenarioResults(nodes, edges, structuralSystem, projectSpecs);
  const [comparePanelOpen, setComparePanelOpen] = useState(false);
  const scenarioTotals = useMemo(
    () => new Map([...scenarioResults.byId].map(([id, r]) => [id, r.metrics.total])),
    [scenarioResults],
  );
  const economy = useMemo<EconomySnapshot>(() => ({
    baselineTotal: scenarioResults.baseline?.metrics.total ?? 0,
    unpricedCount: scenarioResults.baseline?.metrics.unpricedCount ?? 0,
    articleCount: scenarioResults.baseline?.articleCount ?? 0,
    budget: scenarioBudget,
    scenarios: scenarioList.map((s) => ({
      total: scenarioResults.byId.get(s.id)?.metrics.total ?? null,
      structuralSystem: s.structuralSystem,
    })),
    projectSystem: structuralSystem,
  }), [scenarioResults, scenarioBudget, scenarioList, structuralSystem]);

  // ── Technology adaptation ─────────────────────────────────────────────
  // What `adaptGraphToSystem` would change to make the model match its
  // declared system. Offered in a banner, applied as one undo step, never
  // silently: retyping walls and adding columns is the user's call.
  const adaptPreview = useMemo(
    () => (structuralSystem === 'unset' ? null : adaptGraphToSystem(nodes, edges, structuralSystem)),
    [nodes, edges, structuralSystem],
  );
  const [adaptDismissedFor, setAdaptDismissedFor] = useState<StructuralSystem | null>(null);
  const showAdaptBanner = !!adaptPreview && summaryChanged(adaptPreview.summary) && adaptDismissedFor !== structuralSystem;

  // Sync from store when external components (e.g. floor plan draw-wall) change it
  useEffect(() => {
    setNodes((prev) => (prev === storedNodes ? prev : storedNodes));
    setEdges((prev) => (prev === storedEdges ? prev : storedEdges));
  }, [storedNodes, storedEdges]);

  // Keep the "Last floor" storey (role: 'last') floating on top of every other
  // storey: its bottom = the highest regular storey's top; its height is kept.
  // Add a storey below/above and it re-floats above them all.
  useEffect(() => {
    const storeys = nodes.filter((n) => n.type === 'storey');
    const last = storeys.find((n) => n.properties.role === 'last');
    if (!last) return;
    const band = computeLastFloorBand(
      storeys.map((n) => ({
        id: n.id,
        bottomElevation: Number(n.properties.bottomElevation ?? 0),
        topElevation: Number(n.properties.topElevation ?? 0),
      })),
      last.id,
      LAST_FLOOR_HEIGHT_MM,
    );
    if (!band) return;
    if (Number(last.properties.bottomElevation) === band.bottom
      && Number(last.properties.topElevation) === band.top) return; // stable → no loop
    setNodes((prev) => prev.map((n) => n.id === last.id
      ? { ...n, properties: { ...n.properties, bottomElevation: band.bottom, topElevation: band.top } }
      : n));
  }, [nodes]);

  // ── Multi-viewer tab system ───────────────────────────────────────────
  const viewTabs      = useBubbleGraphStore((s) => s.viewTabs);
  const cleanViewTabs = useMemo(
    () => (profile === 'clean' ? viewTabs.filter((t) => t.type !== 'report' && t.type !== 'table') : viewTabs),
    [viewTabs, profile],
  );
  const activeTabId   = useBubbleGraphStore((s) => s.activeTabId);
  const addViewTab    = useBubbleGraphStore((s) => s.addViewTab);
  const closeViewTab  = useBubbleGraphStore((s) => s.closeViewTab);
  const renameViewTab = useBubbleGraphStore((s) => s.renameViewTab);
  const updateViewTabParams = useBubbleGraphStore((s) => s.updateViewTabParams);
  const setActiveTabId = useBubbleGraphStore((s) => s.setActiveTabId);
  const viewer3DType   = useBubbleGraphStore((s) => s.viewer3DType);
  const setViewer3DType = useBubbleGraphStore((s) => s.setViewer3DType);

  // Clean / minimal builds always use OpenGeometry as the 3D engine
  useEffect(() => {
    if (openGeoOnly) setViewer3DType('opengeo');
  }, [openGeoOnly, setViewer3DType]);

  // The live model as the exported IFC, for the IFC Tiles engine — built only
  // while that engine is the one a 3D tab would show.
  const modelIfc = useModelIfc(
    viewNodes, edges, projectName,
    !openGeoOnly && viewer3DType === 'tiles' && viewTabs.some((t) => t.type === '3d-model'),
  );

  // Views living in their own OS window (desktop build). This window stays the
  // one that owns the model; they draw what it publishes.
  const { detachedIds, detach: detachView } = useDetachedViews({
    nodes, edges, buildingAxes, projectName, tabs: viewTabs, viewer3DType,
    activeTab: viewTabs.find((t) => t.id === activeTabId),
    setActiveTabId,
  });

  const selectedNodeId  = useBubbleGraphStore((s) => s.selectedNodeId);
  const setSelectedNodeId = useBubbleGraphStore((s) => s.setSelectedNodeId);
  const selectedNodeIds   = useBubbleGraphStore((s) => s.selectedNodeIds);
  const setSelectedNodeIds = useBubbleGraphStore((s) => s.setSelectedNodeIds);
  // Single selection from a viewer must also clear any multi-select, so a stale
  // id can't shadow the shown node in the inspector / edit + delete handlers.
  const handleViewerSelectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
    setSelectedNodeIds([]);
  }, [setSelectedNodeId, setSelectedNodeIds]);
  const restoreViewState   = useBubbleGraphStore((s) => s.restoreViewState);
  const setWorldLocation    = useBubbleGraphStore((s) => s.setWorldLocation);

  const [showWindowConfigurator, setShowWindowConfigurator] = useState(false);
  const [showDoorConfigurator,   setShowDoorConfigurator]   = useState(false);
  const [showMultiSelect,        setShowMultiSelect]        = useState(false);

  const selectedNodeData = useMemo(
    () => viewNodes.find((n) => n.id === selectedNodeId) ?? null,
    [viewNodes, selectedNodeId],
  );

  const activeTabMeta = useMemo(
    () => viewTabs.find((t) => t.id === activeTabId),
    [viewTabs, activeTabId],
  );

  // Keep the graph-editor tab label in sync (Clean: "Model")
  // The graph is the model's root, and its tab says so — also after a project
  // load has brought back a tab saved under another name.
  const graphTabLabel = viewTabs.find((t) => t.id === 'graph-editor')?.label;
  useEffect(() => {
    const want = ro ? 'Graf' : 'Graph';
    if (graphTabLabel !== undefined && graphTabLabel !== want) renameViewTab('graph-editor', want);
  }, [renameViewTab, ro, graphTabLabel]);

  // Clean: prefer Plan for active storey once storeys exist (plan primacy)
  const cleanPlanPrimacyDone = useRef(false);
  useEffect(() => {
    if (profile !== 'clean' || cleanPlanPrimacyDone.current) return;
    const storeys = nodes.filter((n) => n.type === 'storey');
    if (storeys.length === 0) return;
    const sid = activeStoreyId ?? storeys[0].id;
    const s = storeys.find((x) => x.id === sid) ?? storeys[0];
    const existing = viewTabs.find(
      (t) => t.type === 'floorplan' && t.storeyId === s.id && (t.discipline ?? 'architectural') === 'architectural',
    );
    if (existing) {
      setActiveTabId(existing.id);
    } else {
      addViewTab({
        type: 'floorplan',
        label: `${s.name} — Plan`,
        storeyId: s.id,
        discipline: 'architectural',
        canClose: true,
      });
    }
    if (!activeStoreyId) setActiveStoreyId(s.id);
    cleanPlanPrimacyDone.current = true;
  }, [profile, nodes, activeStoreyId, viewTabs, addViewTab, setActiveTabId, setActiveStoreyId]);

  const [showAxesDialog, setShowAxesDialog] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  /** Graph canvas Grid mode (session-only; toggled from the toolbar and the ribbon). */
  const [gridMode, setGridMode] = useState(false);
  const [showNewStoreyDialog, setShowNewStoreyDialog] = useState(false);
  const [showMaterialEditor, setShowMaterialEditor] = useState(false);
  const [showStyleDialog, setShowStyleDialog] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [showBoardScanner, setShowBoardScanner] = useState(false);
  const [editingStoreyId, setEditingStoreyId] = useState<string | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [showObjectLibrary, setShowObjectLibrary] = useState(false);
  const [showSymbolConfig, setShowSymbolConfig] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [cleanTheme, setCleanTheme] = useState<'dark' | 'light'>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  );

  const toggleCleanTheme = useCallback(() => {
    const next = cleanTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    localStorage.setItem('bubblebim_clean_theme', next);
    setCleanTheme(next);
  }, [cleanTheme]);


  const handleInsertLibraryObject = useCallback((entry: ObjectLibraryEntry) => {
    const newNode: BubbleGraphNode = {
      id: `object_${uid()}`,
      type: 'object',
      name: entry.label,
      x: 0,
      y: 0,
      z: 0,
      parentId: activeStoreyId ?? undefined,
      properties: {
        glb_ref: entry.glb,
        glb_scale: 1.0,
        label: entry.label,
        width_mm: entry.width_mm,
        depth_mm: entry.depth_mm,
        height_mm: entry.height_mm,
        z_offset_mm: 0,
      },
    };
    setNodes((prev) => [...prev, newNode]);
  }, [activeStoreyId, setNodes]);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);

  // ── Named projects on the backend ──────────────────────────────────────
  const [showProjects, setShowProjects] = useState(false);

  /**
   * Switch this tab to another stored project.
   *
   * A reload is the honest way to do it: the graph, the axes, the world
   * placement, the open drawing tabs and every scenario all come from the
   * project, and swapping them piecemeal in a live tree is how half of one
   * project ends up in another.
   */
  const handleOpenStoredProject = useCallback((slug: string) => {
    useBubbleGraphStore.getState().setProjectSlug(slug);
    window.location.reload();
  }, []);

  /** Save what is open under a new name, and continue in it. */
  const handleSaveProjectAs = useCallback(async (name: string) => {
    try {
      const saved = await saveGraph({
        projectName: name,
        nodes: stampDerivedQuantities(nodes, edges) as never[],
        edges: annotateEdgeTypes(edges, nodes) as never[],
        buildingAxes,
        activeStoreyId: null,
        annotations: useBubbleGraphStore.getState().annotations,
        dimStyles: useBubbleGraphStore.getState().dimStyles,
        drawStyles: useBubbleGraphStore.getState().drawStyles,
        worldLocation: useBubbleGraphStore.getState().worldLocation,
        globeInstances: useBubbleGraphStore.getState().globeInstances,
        composerShapes: useBubbleGraphStore.getState().composer.shapes,
        viewTabs: sanitizeViewTabs(useBubbleGraphStore.getState().viewTabs),
        activeTabId: useBubbleGraphStore.getState().activeTabId,
        structuralSystem,
        specs: projectSpecs,
        scenarios: exportScenarios(),
        terrain: useBubbleGraphStore.getState().terrain ?? undefined,
      });
      // No slug was sent, so the server routed by name. Follow it, or autosave
      // would keep writing into the project this one was copied from.
      if (saved?.slug) useBubbleGraphStore.getState().setProjectSlug(saved.slug);
      setProjectName(name);
      toast.success(`Salvat ca „${name}"`);
    } catch (err) {
      toast.error(`Salvarea a eșuat: ${err instanceof Error ? err.message : 'eroare necunoscută'}`);
    }
  }, [nodes, edges, buildingAxes, structuralSystem, projectSpecs]);

  // ─── Collect snapshot of current graph state ──────────────────────────
  const getSnapshot = useCallback((): ProjectData => ({
    nodes: nodes as unknown[],
    edges: edges as unknown[],
    buildingAxes,
    projectName,
    activeStoreyId,
  }), [nodes, edges, buildingAxes, projectName, activeStoreyId]);

  // ─── Save to file (Electron native dialog) ────────────────────────────
  const handleSaveProject = useCallback(async () => {
    if (!eAPI) return;
    let fp = currentFilePath;
    if (!fp) {
      fp = await eAPI.saveAs(`${projectName}.bgjson`);
      if (!fp) return;
      setCurrentFilePath(fp);
      await eAPI.setProjectPath(fp);
    }
    const res = await eAPI.writeFile(fp, getSnapshot());
    if (res?.error) {
      toast.error(`Save failed: ${res.error}`);
    } else {
      toast.success(`Saved: ${fp.split(/[\\/]/).pop()}`);
    }
  }, [currentFilePath, getSnapshot, projectName]);

  const handleSaveAs = useCallback(async () => {
    if (!eAPI) return;
    const fp = await eAPI.saveAs(`${projectName}.bgjson`);
    if (!fp) return;
    setCurrentFilePath(fp);
    await eAPI.setProjectPath(fp);
    const res = await eAPI.writeFile(fp, getSnapshot());
    if (res?.error) toast.error(`Save failed: ${res.error}`);
    else toast.success(`Saved: ${fp.split(/[\\/]/).pop()}`);
  }, [getSnapshot, projectName]);

  // ─── Open from file (Electron native dialog) ─────────────────────────
  const handleOpenProject = useCallback(async () => {
    if (!eAPI) return;
    const result = await eAPI.openFile();
    if (!result || result.error) {
      if (result?.error) toast.error(`Open failed: ${result.error}`);
      return;
    }
    const { filePath, data } = result;
    breakCoalescing(); // opening a project is a hard reset — never merge into whatever undo step preceded it
    if (data.nodes) setNodes(data.nodes as BubbleGraphNode[]);
    if (data.edges) setEdges(data.edges as BubbleGraphEdge[]);
    if (data.buildingAxes) setBuildingAxes(data.buildingAxes);
    if (data.projectName) setProjectName(data.projectName);
    if (data.activeStoreyId !== undefined) setActiveStoreyId(data.activeStoreyId ?? null);
    if (data.worldLocation) setWorldLocation(data.worldLocation);
    useBubbleGraphStore.getState().setTerrain(data.terrain ?? null);
    setCurrentFilePath(filePath);
    await eAPI.setProjectPath(filePath);
    toast.success(`Opened: ${filePath.split(/[\\/]/).pop()}`);
  }, [setBuildingAxes, setActiveStoreyId, setWorldLocation, breakCoalescing]);

  const handleNewProject = useCallback(() => {
    const { nodes: seed, activeStoreyId } = buildDefaultProjectNodes();
    breakCoalescing();
    setNodes(seed);
    setEdges([]);
    setBuildingAxes(DEFAULT_PROJECT_AXES);
    setProjectName('My Building');
    setActiveStoreyId(activeStoreyId || null);
    setCurrentFilePath(null);
    importScenarios(undefined);
    useBubbleGraphStore.getState().setDrawingViews([]);
    useBubbleGraphStore.getState().setAnnotations([]);
    toast.success('New project — 4 storeys ready');
  }, [setBuildingAxes, setActiveStoreyId, breakCoalescing]);

  // ── Web (non-Electron) project file handlers ────────────────────────────
  const handleWebNewProject = useCallback(() => {
    const { nodes: seed, activeStoreyId } = buildDefaultProjectNodes();
    breakCoalescing();
    setNodes(seed);
    setEdges([]);
    setBuildingAxes(DEFAULT_PROJECT_AXES);
    setProjectName('My Building');
    setActiveStoreyId(activeStoreyId || null);
    setCurrentFilePath(null);
    importScenarios(undefined);
    useBubbleGraphStore.getState().setDrawingViews([]);
    useBubbleGraphStore.getState().setAnnotations([]);
    restoreViewState(
      [{ id: 'graph-editor', label: 'My Building', type: 'graph-editor', canClose: false }],
      'graph-editor',
      'tiles',
    );
    toast.success('New project created');
  }, [setBuildingAxes, setActiveStoreyId, restoreViewState, breakCoalescing]);

  /** The project as a `.bbim` — what Save downloads and the HTML export carries inside. */
  const buildProjectFile = useCallback(() => {
    const worldLocation = useBubbleGraphStore.getState().worldLocation;
    const globeInstances = useBubbleGraphStore.getState().globeInstances;
    const composerShapes = useBubbleGraphStore.getState().composer.shapes;
    return serializeProject(
      projectName, stampDerivedQuantities(nodes, edges), annotateEdgeTypes(edges, nodes), buildingAxes, activeStoreyId,
      viewTabs, activeTabId, viewer3DType,
      worldLocation, globeInstances, composerShapes, structuralSystem, projectSpecs,
      useBubbleGraphStore.getState().terrain,
    );
  }, [projectName, nodes, edges, buildingAxes, activeStoreyId, viewTabs, activeTabId, viewer3DType, structuralSystem, projectSpecs]);

  const handleWebSaveProject = useCallback(() => {
    downloadProject(buildProjectFile());
  }, [buildProjectFile]);

  const handleWebOpenProject = useCallback(async () => {
    const raw = await openProjectFile();
    if (!raw) return;
    try {
      const proj = deserializeProject(raw);
      breakCoalescing();
      setNodes(proj.nodes as BubbleGraphNode[]);
      setEdges(annotateEdgeTypes(proj.edges as BubbleGraphEdge[], proj.nodes as BubbleGraphNode[]));
      setBuildingAxes(proj.buildingAxes);
      setProjectName(proj.projectName);
      if (proj.structuralSystem) setStructuralSystem(proj.structuralSystem);
      setProjectSpecs(parseSpecSelection(proj.specs));
      setActiveStoreyId(proj.activeStoreyId);
      restoreViewState(proj.viewTabs, proj.activeTabId, proj.viewer3DType);
      if (proj.worldLocation) setWorldLocation(proj.worldLocation);
      if (proj.globeInstances?.length) useBubbleGraphStore.getState().setGlobeInstances(proj.globeInstances);
      if (proj.composerShapes?.length) useBubbleGraphStore.getState().composerSetShapes(proj.composerShapes);
      useBubbleGraphStore.getState().setTerrain(proj.terrain ?? null);
      setCurrentFilePath(null);
      // Also save to backend so auto-save doesn't overwrite with stale data.
      // No projectSlug: the server routes by name, so an imported project lands
      // under its OWN name rather than on top of whatever was open. The slug it
      // answers with becomes this tab's, or the next autosave would write the
      // imported graph back into the previous project.
      try {
        const saved = await saveGraph({
          nodes: proj.nodes as never[],
          edges: proj.edges as never[],
          buildingAxes: proj.buildingAxes,
          projectName: proj.projectName,
          activeStoreyId: proj.activeStoreyId,
          worldLocation: proj.worldLocation,
          globeInstances: proj.globeInstances,
          composerShapes: proj.composerShapes,
          structuralSystem: proj.structuralSystem,
          specs: proj.specs,
          scenarios: exportScenarios(),
          terrain: proj.terrain,
        });
        if (saved?.slug) useBubbleGraphStore.getState().setProjectSlug(saved.slug);
      } catch { /* ok — backend may be offline */ }
      toast.success(`Opened project: ${proj.projectName}`);
    } catch (err) {
      toast.error(`Failed to open project: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [setBuildingAxes, setActiveStoreyId, restoreViewState, setWorldLocation, breakCoalescing]);

  const handleImportBoardGame = useCallback(() => {
    setShowBoardScanner(true);
  }, []);

  // Listen for board-game-import postMessage from scanner iframe
  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      if (e.data?.type !== 'board-game-import' || !e.data.graph) return;
      const data = e.data.graph;
      if (!data.nodes || !data.edges) return;
      setNodes(data.nodes as BubbleGraphNode[]);
      setEdges(data.edges as BubbleGraphEdge[]);
      if (data.buildingAxes) setBuildingAxes(data.buildingAxes);
      if (data.projectName) setProjectName(data.projectName);
      const storeyNode = (data.nodes as BubbleGraphNode[]).find((n: BubbleGraphNode) => n.type === 'storey');
      if (storeyNode) setActiveStoreyId(storeyNode.id);
      setPan({ x: 0, y: 0 });
      setZoom(1);
      setShowBoardScanner(false);
      try {
        const saved = await saveGraph({
          nodes: data.nodes,
          edges: data.edges,
          buildingAxes: data.buildingAxes,
          projectName: data.projectName ?? projectName,
        });
        if (saved?.slug) useBubbleGraphStore.getState().setProjectSlug(saved.slug);
      } catch { /* backend may be offline */ }
      toast.success(`Board game imported: ${data.nodes.length} nodes, ${data.edges.length} edges`);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [setBuildingAxes, setActiveStoreyId, projectName]);

  // One self-contained .html: the 3D model baked from the viewer's own scene,
  // the drawings as SVG, the .bbim inside it, and every IFC open in the 3D
  // viewers next to the project. Opens from a double-click.
  const handleStandaloneExport = useCallback(() => {
    const ifcModels = listLoadedIfc();
    toast.info(ifcModels.length
      ? `Se pregătește exportul HTML, cu ${ifcModels.length} model(e) IFC…`
      : 'Se pregătește exportul HTML…');
    const project = buildProjectFile();
    import('@/lib/standaloneExport')
      .then(({ exportStandaloneHtml }) => exportStandaloneHtml({
        projectName, nodes, edges, buildingAxes, matConfig: getMaterialConfigSync(), project, ifcModels,
      }))
      .then((r) => {
        toast.success([
          `${r.fileName} — ${(r.bytes / 1048576).toFixed(1)} MB`,
          `${r.meshes} corpuri`,
          r.ifcModels ? `${r.ifcModels} model(e) IFC` : null,
          `${r.drawings} planșe`,
          r.boqRows ? `${r.boqRows} articole de deviz` : null,
        ].filter(Boolean).join(', '));
        if (r.ifcModels < ifcModels.length) {
          toast.error(`${ifcModels.length - r.ifcModels} model(e) IFC nu au putut fi incluse — vezi consola.`);
        }
      })
      .catch((err: unknown) => toast.error(`Exportul HTML a eșuat: ${err instanceof Error ? err.message : 'eroare necunoscută'}`));
  }, [projectName, nodes, edges, buildingAxes, buildProjectFile]);

  // ── Viewer tab openers ────────────────────────────────────────────────
  const handleOpen3DTab = useCallback(() => {
    const existing = viewTabs.find((t) => t.type === '3d-model');
    if (existing) { setActiveTabId(existing.id); return; }
    addViewTab({ type: '3d-model', label: `${projectName} — 3D`, canClose: true });
  }, [viewTabs, projectName, addViewTab, setActiveTabId]);

  // ── 2D views: things of the project, not tabs (lib/views/drawingViews) ──
  const drawingViews = useBubbleGraphStore((s) => s.drawingViews);
  const setDrawingViews = useBubbleGraphStore((s) => s.setDrawingViews);
  // Every storey has a plan, every section node its view, every drawing tab
  // its view — kept so as the model and the tabs change.
  useEffect(() => {
    const r = syncViews(drawingViews, nodes, viewTabs);
    if (!r) return;
    setDrawingViews(r.views);
    for (const l of r.links) updateViewTabParams(l.tabId, { drawingViewId: l.viewId });
  }, [drawingViews, nodes, viewTabs, setDrawingViews, updateViewTabParams]);

  /** Bring a view up: the tab it is open in, or a new one. */
  const openDrawingView = useCallback((v: DrawingView) => {
    const open = useBubbleGraphStore.getState().viewTabs.find((t) => t.params?.drawingViewId === v.id);
    if (open) { setActiveTabId(open.id); return; }
    const id = addViewTab({
      type: tabTypeOf(v),
      label: v.name,
      storeyId: v.storeyId,
      discipline: v.discipline,
      canClose: true,
      params: {
        ...(v.kind === 'elevation' && v.engine === 'classic'
          ? { startElevation: -5000, endElevation: 15000, cutDepth: 999_999, cutX: 999_999, cutY: -999_999 } : {}),
        ...(v.params ?? {}),
        ...(v.dir ? { viewDirection: v.dir } : {}),
        ...(v.sectionNodeId ? { nodeId: v.sectionNodeId } : {}),
        drawingViewId: v.id,
      },
    });
    setActiveTabId(id);
  }, [addViewTab, setActiveTabId]);

  /** A new view in the registry, opened. */
  const createDrawingView = useCallback((req: NewViewRequest) => {
    const id = newViewId();
    const views = useBubbleGraphStore.getState().drawingViews;
    const v: DrawingView = {
      id, name: uniqueViewName(req.name, views), kind: req.kind, engine: req.engine,
      storeyId: req.storeyId, discipline: req.kind === 'plan' ? req.discipline ?? 'architectural' : undefined,
      dir: req.kind === 'plan' ? undefined : req.dir, annKey: `view:${id}`,
    };
    setDrawingViews([...views, v]);
    openDrawingView(v);
  }, [setDrawingViews, openDrawingView]);

  /** Open a storey's plan: the first of that discipline, made if there is none. */
  const handleOpenFloorPlanTab = useCallback((storeyId: string, storeyName: string, disc?: StoreyDiscipline) => {
    const d = disc ?? 'architectural';
    const views = useBubbleGraphStore.getState().drawingViews;
    const v = views.find((x) => x.kind === 'plan' && x.storeyId === storeyId && (x.discipline ?? 'architectural') === d && x.engine === DEFAULT_ENGINE)
      ?? views.find((x) => x.kind === 'plan' && x.storeyId === storeyId && (x.discipline ?? 'architectural') === d);
    if (v) { openDrawingView(v); return; }
    createDrawingView({ kind: 'plan', engine: DEFAULT_ENGINE, storeyId, discipline: d,
      name: d === 'architectural' ? storeyName : `${storeyName} — ${d === 'structural' ? 'structură' : 'instalații'}` });
  }, [openDrawingView, createDrawingView]);

  const renameDrawingView = useCallback((id: string, name: string) => {
    const views = useBubbleGraphStore.getState().drawingViews;
    const unique = uniqueViewName(name, views, id);
    setDrawingViews(views.map((v) => (v.id === id ? { ...v, name: unique } : v)));
    for (const t of useBubbleGraphStore.getState().viewTabs) if (t.params?.drawingViewId === id) renameViewTab(t.id, unique);
  }, [setDrawingViews, renameViewTab]);

  const duplicateDrawingView = useCallback((id: string, detailing: boolean) => {
    const st = useBubbleGraphStore.getState();
    const v = st.drawingViews.find((x) => x.id === id);
    if (!v) return;
    const dup = duplicateView(v, st.drawingViews, st.annotations, detailing);
    setDrawingViews([...st.drawingViews, dup.view]);
    if (dup.annotations.length) st.setAnnotations([...st.annotations, ...dup.annotations]);
    openDrawingView(dup.view);
  }, [setDrawingViews, openDrawingView]);

  const deleteDrawingView = useCallback((id: string) => {
    const st = useBubbleGraphStore.getState();
    const v = st.drawingViews.find((x) => x.id === id);
    if (!v) return;
    if (v.kind === 'plan' && !st.drawingViews.some((x) => x.id !== id && x.kind === 'plan' && x.storeyId === v.storeyId)) {
      toast.info('Fiecare nivel își păstrează cel puțin un plan — duplică-l înainte să-l ștergi pe acesta.');
      return;
    }
    if (!window.confirm(`Ștergi vederea „${v.name}” și adnotările ei?`)) return;
    const rest = st.drawingViews.filter((x) => x.id !== id);
    setDrawingViews(rest);
    // Its notes go with it — unless another view still files under the same key.
    if (!rest.some((x) => x.annKey === v.annKey)) st.clearViewAnnotations(v.annKey);
    for (const t of st.viewTabs) if (t.params?.drawingViewId === id) closeViewTab(t.id);
  }, [setDrawingViews, closeViewTab]);

  /**
   * Draw a view with the other engine. The view stays the same view — name,
   * notes — and its tab reopens on the new engine. A section cut by a marker
   * on the plan has no OpenGeometry counterpart (that engine cuts on a side).
   */
  const switchViewEngine = useCallback((id: string, engine: DrawingEngine) => {
    const st = useBubbleGraphStore.getState();
    const v = st.drawingViews.find((x) => x.id === id);
    if (!v || v.engine === engine) return;
    if (v.kind === 'section' && v.sectionNodeId && engine === 'og') {
      toast.info('Secțiunea desenată pe plan se taie doar cu desenul clasic — pentru OpenGeometry fă o secțiune pe o direcție.');
      return;
    }
    const next: DrawingView = { ...v, engine, ...(v.kind !== 'plan' && !v.dir ? { dir: 'N' as const } : {}) };
    setDrawingViews(st.drawingViews.map((x) => (x.id === id ? next : x)));
    for (const t of st.viewTabs) if (t.params?.drawingViewId === id) closeViewTab(t.id);
    openDrawingView(next);
  }, [setDrawingViews, closeViewTab, openDrawingView]);

  const setViewGraphic = useCallback((id: string, graphic: GraphicStyleId) => {
    const st = useBubbleGraphStore.getState();
    setDrawingViews(st.drawingViews.map((x) => (x.id === id ? { ...x, graphic } : x)));
  }, [setDrawingViews]);

  /** The tab bar renames the view, not just the tab. */
  const renameTabOrView = useCallback((tabId: string, label: string) => {
    const t = useBubbleGraphStore.getState().viewTabs.find((x) => x.id === tabId);
    const vid = t?.params?.drawingViewId as string | undefined;
    if (vid) renameDrawingView(vid, label); else renameViewTab(tabId, label);
  }, [renameDrawingView, renameViewTab]);

  const [newViewInit, setNewViewInit] = useState<Partial<NewViewRequest> | null>(null);

  const handleOpenFemTab = useCallback((storeyId: string, storeyName: string) => {
    const existing = viewTabs.find((t) => t.type === 'fem' && t.storeyId === storeyId);
    if (existing) { setActiveTabId(existing.id); return; }
    addViewTab({ type: 'fem', label: `${storeyName} — Structural`, storeyId, canClose: true });
  }, [viewTabs, addViewTab, setActiveTabId]);

  const handleOpenSimpleTab = useCallback((type: 'section' | 'elevation' | 'table' | 'sheet', label: string) => {
    addViewTab({ type, label, canClose: true });
  }, [addViewTab]);

  // Panou flotant cu structura costurilor.
  const [costPanelOpen, setCostPanelOpen] = useState(false);

  useEffect(() => {
    if (profile !== 'clean') return;
    if (costPanelOpen) setCostPanelOpen(false);
    const active = viewTabs.find((t) => t.id === activeTabId);
    if (active && (active.type === 'report' || active.type === 'table')) {
      const fallback = cleanViewTabs.find((t) => t.type === 'graph-editor') ?? cleanViewTabs[0];
      if (fallback) setActiveTabId(fallback.id);
    }
  }, [profile, costPanelOpen, viewTabs, activeTabId, cleanViewTabs, setActiveTabId]);

  const handleOpenReportTab = useCallback(() => {
    const existing = viewTabs.find((t) => t.type === 'report');
    if (existing) { setActiveTabId(existing.id); return; }
    addViewTab({ type: 'report', label: `${projectName} — Calculation memo`, canClose: true });
  }, [viewTabs, projectName, addViewTab, setActiveTabId]);

  const handleOpenTopologyTab = useCallback(() => {
    const existing = viewTabs.find((t) => t.type === 'topology');
    if (existing) { setActiveTabId(existing.id); return; }
    addViewTab({ type: 'topology', label: `${projectName} — Topologie`, canClose: true });
  }, [viewTabs, projectName, addViewTab, setActiveTabId]);

  const handleOpenIFCPlanTab = useCallback(() => {
    const existing = viewTabs.find((t) => t.type === 'ifc-plan');
    if (existing) { setActiveTabId(existing.id); return; }
    addViewTab({ type: 'ifc-plan', label: 'IFC Plan 2D', canClose: true });
  }, [viewTabs, addViewTab, setActiveTabId]);

  const handleOpenOGFloorPlanTab = useCallback((storeyId: string, storeyName: string) => {
    const existing = viewTabs.find((t) => t.type === 'opengeo-floorplan' && t.storeyId === storeyId);
    if (existing) { setActiveTabId(existing.id); return; }
    addViewTab({ type: 'opengeo-floorplan', label: `${storeyName} — OG Plan`, storeyId, canClose: true });
  }, [viewTabs, addViewTab, setActiveTabId]);

  const handleOpenOGSectionTab = useCallback((dir: 'N' | 'S' | 'E' | 'W' = 'N') => {
    const existing = viewTabs.find((t) => t.type === 'opengeo-section' && t.params?.viewDirection === dir);
    if (existing) { setActiveTabId(existing.id); return; }
    const labels: Record<string, string> = { N: 'OG Section — N', S: 'OG Section — S', E: 'OG Section — E', W: 'OG Section — W' };
    addViewTab({ type: 'opengeo-section', label: labels[dir], canClose: true, params: { viewDirection: dir } });
  }, [viewTabs, addViewTab, setActiveTabId]);

  const handleOpenOGElevationTab = useCallback((dir: 'N' | 'S' | 'E' | 'W' = 'N') => {
    const existing = viewTabs.find((t) => t.type === 'opengeo-elevation' && t.params?.viewDirection === dir);
    if (existing) { setActiveTabId(existing.id); return; }
    const labels: Record<string, string> = { N: 'North Elevation', S: 'South Elevation', E: 'East Elevation', W: 'West Elevation' };
    addViewTab({ type: 'opengeo-elevation', label: labels[dir], canClose: true, params: { viewDirection: dir } });
  }, [viewTabs, addViewTab, setActiveTabId]);

  /**
   * Create (or focus) default North / South / East / West elevation tabs.
   * start/end elevation defaults: -5000 mm to 15000 mm.
   */
  /** The four elevations, as views — the ones missing are made, the last is opened. */
  const handleGenerateDefaultElevations = useCallback(() => {
    const defs: Array<{ dir: 'N' | 'S' | 'E' | 'W'; name: string }> = [
      { dir: 'W', name: 'Fațada vest' },
      { dir: 'E', name: 'Fațada est' },
      { dir: 'S', name: 'Fațada sud' },
      { dir: 'N', name: 'Fațada nord' },
    ];
    let views = useBubbleGraphStore.getState().drawingViews;
    let last: DrawingView | null = null;
    for (const { dir, name } of defs) {
      const existing = views.find((v) => v.kind === 'elevation' && v.dir === dir);
      if (existing) { last = existing; continue; }
      const id = newViewId();
      const v: DrawingView = {
        id, name: uniqueViewName(name, views), kind: 'elevation', engine: DEFAULT_ENGINE, dir,
        annKey: DEFAULT_ENGINE === 'og' ? `og:elevation:${dir}` : `elevation:${dir}`,
      };
      // The first elevation on a side keeps the key that side's notes always had.
      if (views.some((x) => x.annKey === v.annKey)) v.annKey = `view:${id}`;
      views = [...views, v];
      last = v;
    }
    setDrawingViews(views);
    if (last) openDrawingView(last);
  }, [setDrawingViews, openDrawingView]);

  /** Open a parametric section/elevation tab from a section/view node. */
  const handleOpenSectionTab = useCallback((nodeId: string) => {
    const n = nodes.find((nd) => nd.id === nodeId);
    if (!n || (n.type !== 'section' && n.type !== 'view')) return;

    // Resolve ax positions through the shared resolver (own parent storey, free
    // points and grid offsets included) — not a local re-implementation.
    const nodeMapAll = new Map(nodes.map((nd) => [nd.id, nd]));
    const getAxPos = (axN: BubbleGraphNode) => getAxRealPos(axN, nodeMapAll);

    const connEdges = edges.filter((e) => e.from === nodeId || e.to === nodeId);
    const axNodes = connEdges
      .map((e) => nodes.find((nd) => nd.id === (e.from === nodeId ? e.to : e.from)))
      .filter((nd): nd is BubbleGraphNode => !!nd && nd.type === 'ax');

    const cutDepth        = Number(n.properties.cut_depth_mm ?? 6000);
    const cutHeight       = Number(n.properties.cut_height_mm ?? 0);
    const planeOffset     = Number(n.properties.cut_plane_offset_mm ?? 0);
    const startElevation  = Number(n.properties.start_elevation_mm ?? 0);
    // Height 0 = "all storeys": leave the end open and let the viewer derive it.
    const endElevation    = cutHeight > 0 ? startElevation + cutHeight : undefined;
    const flipped         = n.properties.flipped === true || n.properties.flipped === 'true';
    const planCutRaw = n.properties.plan_cut as { x1?: number; y1?: number; x2?: number; y2?: number } | undefined;

    if (n.type === 'section') {
      // The viewer reads everything live from the node; the params are only
      // the legacy fallback for sheet viewports.
      const existing = viewTabs.find((t) => t.type === 'section' && t.params?.nodeId === nodeId);
      const spec = resolveSectionCut(n, nodes, edges);
      const cutY = spec ? (spec.line.y1 + spec.line.y2) / 2 : 0;
      const params = { cutY, cutDepth: spec?.depthMm ?? cutDepth, startElevation, endElevation, nodeId };
      if (existing) {
        updateViewTabParams(existing.id, params);
        setActiveTabId(existing.id);
        return;
      }
      addViewTab({ type: 'section', label: n.name || 'Section', storeyId: n.parentId ?? undefined, canClose: true, params });
    } else {
      const existing = viewTabs.find((t) => t.type === 'elevation' && t.params?.nodeId === nodeId);
      let cutX = 0;
      if (planCutRaw && Number.isFinite(planCutRaw.x1) && Number.isFinite(planCutRaw.x2)) {
        cutX = ((Number(planCutRaw.x1) + Number(planCutRaw.x2)) / 2) + (flipped ? -planeOffset : planeOffset);
      } else if (axNodes.length >= 2) {
        const p1 = getAxPos(axNodes[0]), p2 = getAxPos(axNodes[1]);
        cutX = (p1.x + p2.x) / 2 + (flipped ? -planeOffset : planeOffset);
      }
      if (existing) {
        updateViewTabParams(existing.id, { cutX, cutDepth, startElevation, endElevation, nodeId });
        setActiveTabId(existing.id);
        return;
      }
      addViewTab({ type: 'elevation', label: n.name || 'View', storeyId: n.parentId ?? undefined, canClose: true,
        params: {
          cutX, cutDepth, startElevation, endElevation, nodeId,
          viewDirection: (n.properties.view_direction as 'N' | 'S' | 'E' | 'W' | undefined) ?? 'W',
        } });
    }
  }, [nodes, edges, viewTabs, addViewTab, setActiveTabId, updateViewTabParams]);

  // Open section/elevation tab requested from floor-plan authoring
  const pendingOpenSectionId = useBubbleGraphStore((s) => s.pendingOpenSectionId);
  const setPendingOpenSectionId = useBubbleGraphStore((s) => s.setPendingOpenSectionId);
  useEffect(() => {
    if (!pendingOpenSectionId) return;
    handleOpenSectionTab(pendingOpenSectionId);
    setPendingOpenSectionId(null);
  }, [pendingOpenSectionId, handleOpenSectionTab, setPendingOpenSectionId]);

  // Wire Electron menu events
  useElectronBridge({
    onSave: handleSaveProject,
    onOpen: handleOpenProject,
    onNew: handleNewProject,
    onExportIfc: () => { /* triggered from canvas toolbar */ },
  });

  // On mount: load graph from backend, then unlock auto-save.
  // Replace the fragile "sync from Zustand store" approach — Zustand is in-memory
  // only and always starts empty on page refresh.
  useEffect(() => {
    let cancelled = false;
    loadGraph().then((data) => {
      if (cancelled) return;
      // The server says which project this is; every later save names it back.
      if (data.projectSlug) useBubbleGraphStore.getState().setProjectSlug(data.projectSlug);
      if (data.nodes.length > 0 || data.edges.length > 0) {
        const loadedNodes = data.nodes as BubbleGraphNode[];
        setNodes(loadedNodes);
        // Backfill relation types on graphs saved before edges had any — one
        // pass here means the rest of the app sees a typed graph, and a no-op
        // (same array reference) once a project has already been annotated.
        setEdges(annotateEdgeTypes(data.edges as BubbleGraphEdge[], loadedNodes));
      }
      if (data.buildingAxes && (
        (data.buildingAxes.xValues?.length ?? 0) > 0 ||
        (data.buildingAxes.yValues?.length ?? 0) > 0
      )) {
        setBuildingAxes(data.buildingAxes);
      }
      if (data.projectName) {
        setProjectName(data.projectName);
      }
      setProjectSpecs(parseSpecSelection(data.specs));
      const loadedSystem = parseStructuralSystem(data.structuralSystem);
      if (loadedSystem) setStructuralSystem(loadedSystem);
      importScenarios(data.scenarios);
      if (data.annotations?.length) {
        useBubbleGraphStore.getState().setAnnotations(data.annotations);
      }
      // The project's 2D views; a project saved before them gets its views
      // made from its storeys, sections and open tabs (syncViews).
      useBubbleGraphStore.getState().setDrawingViews(data.drawingViews ?? []);
      // Always run, even for a project saved before styles existed:
      // `setDimStyles` puts the built-ins back, so the dimensions in an old
      // project resolve through a style that exists instead of falling back.
      useBubbleGraphStore.getState().setDimStyles(data.dimStyles ?? []);
      useBubbleGraphStore.getState().setDrawStyles(data.drawStyles ?? []);
      if (data.worldLocation) {
        useBubbleGraphStore.getState().setWorldLocation(data.worldLocation);
      }
      useBubbleGraphStore.getState().setTerrain(data.terrain ?? null);
      if (data.globeInstances?.length) {
        useBubbleGraphStore.getState().setGlobeInstances(data.globeInstances as import('@/store').GlobeInstance[]);
      }
      if ((data as { composerShapes?: unknown }).composerShapes) {
        useBubbleGraphStore.getState().composerSetShapes(
          (data as { composerShapes: import('@/store').RoomXShape[] }).composerShapes
        );
      }
      // Restore the open drawing tabs (plans/sections/elevations) saved with the
      // graph, so a reload lands you back on the drawings you had open. The
      // non-closable 'graph-editor' tab is re-added if a legacy save predates
      // it, and activeTabId is validated against the restored set (a stale id
      // would otherwise render a blank workspace with no tab highlighted).
      if (data.viewTabs?.length) {
        const tabs = [...data.viewTabs];
        if (!tabs.some((t) => t.type === 'graph-editor')) {
          tabs.unshift({ id: 'graph-editor', label: data.projectName ?? 'My Building', type: 'graph-editor', canClose: false });
        }
        const active = tabs.some((t) => t.id === data.activeTabId) ? data.activeTabId! : tabs[0].id;
        useBubbleGraphStore.getState().restoreViewState(
          tabs, active, useBubbleGraphStore.getState().viewer3DType,
        );
      }
      setIsLoaded(true);
    }).catch(() => {
      // Backend unavailable — still allow editing, just don't auto-save garbage
      setIsLoaded(true);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const storeyNodes = useMemo(
    () => nodes.filter((n) => n.type === 'storey'),
    [nodes],
  );

  const setPlanTool = useBubbleGraphStore((s) => s.setPlanTool);
  const planTool = useBubbleGraphStore((s) => s.planTool);

  /** Ensure a floor-plan tab is active, then activate a plan authoring tool. */
  const startPlanSectionTool = useCallback((tool: 'draw-section' | 'section-on-axis') => {
    const active = viewTabs.find((t) => t.id === activeTabId);
    if (active?.type !== 'floorplan') {
      const sid = activeStoreyId ?? storeyNodes[0]?.id;
      const sn = storeyNodes.find((n) => n.id === sid) ?? storeyNodes[0];
      if (sn) handleOpenFloorPlanTab(sn.id, sn.name, 'architectural');
    }
    setPlanTool(planTool === tool ? null : tool);
  }, [viewTabs, activeTabId, activeStoreyId, storeyNodes, handleOpenFloorPlanTab, setPlanTool, planTool]);

  const takeoffF3Count = useMemo(
    () => computeFullTakeoff(viewNodes, edges, { structuralSystem: viewSystem, specs: viewSpecs }).f3.length,
    [viewNodes, edges, viewSystem],
  );

  const handleQuantityHighlight = useCallback((nodeIds: string[]) => {
    setSelectedNodeIds(nodeIds);
    if (nodeIds.length === 1) setSelectedNodeId(nodeIds[0]);
    else if (nodeIds.length === 0) setSelectedNodeId(null);
  }, [setSelectedNodeIds, setSelectedNodeId]);

  // Live sync: when ax nodes change (axes coordinates updated), refresh open section/elevation tabs
  useEffect(() => {
    viewTabs.forEach((tab) => {
      const nodeId = tab.params?.nodeId as string | undefined;
      // Section tabs read their node live; only elevations still carry params.
      if (!nodeId || tab.type !== 'elevation') return;
      const n = nodes.find((nd) => nd.id === nodeId);
      if (!n) return;

      // Resolve each ax node's position through the shared resolver.
      const nodeMapAll = new Map(nodes.map((nd) => [nd.id, nd]));
      const getAxPos = (axN: BubbleGraphNode) => getAxRealPos(axN, nodeMapAll);

      const connEdges = edges.filter((e) => e.from === nodeId || e.to === nodeId);
      const axNodes = connEdges
        .map((e) => nodes.find((nd) => nd.id === (e.from === nodeId ? e.to : e.from)))
        .filter((nd): nd is BubbleGraphNode => !!nd && nd.type === 'ax');
      if (axNodes.length < 2) return;

      const cutDepth       = Number(n.properties.cut_depth_mm ?? 6000);
      const cutHeight      = Number(n.properties.cut_height_mm ?? 0);
      const planeOffset    = Number(n.properties.cut_plane_offset_mm ?? 0);
      const startElevation = Number(n.properties.start_elevation_mm ?? 0);
      const endElevation   = cutHeight > 0 ? startElevation + cutHeight : undefined;
      const flipped        = n.properties.flipped === true || n.properties.flipped === 'true';

      {
        const p1 = getAxPos(axNodes[0]), p2 = getAxPos(axNodes[1]);
        const cutX = (p1.x + p2.x) / 2 + (flipped ? -planeOffset : planeOffset);
        if (tab.params?.cutX !== cutX || tab.params?.cutDepth !== cutDepth ||
            tab.params?.startElevation !== startElevation || tab.params?.endElevation !== endElevation) {
          updateViewTabParams(tab.id, { ...tab.params, cutX, cutDepth, startElevation, endElevation });
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  /** Duplicate a storey: deep-copy the storey + all its children with new IDs */
  const duplicateStorey = useCallback((storeyId: string) => {
    const source = nodes.find((n) => n.id === storeyId);
    if (!source) return;
    const newStoreyId = `storey_${uid()}`;
    const idMap = new Map<string, string>();
    idMap.set(storeyId, newStoreyId);
    const children = nodes.filter((n) => n.parentId === storeyId);
    children.forEach((c) => idMap.set(c.id, `${c.type}_${uid()}`));

    const newStorey: BubbleGraphNode = {
      ...source,
      id: newStoreyId,
      name: `${source.name} (copy)`,
      x: source.x + 1000,
      y: source.y - 2000,
      locked: true,
      // Own axis arrays: a shallow spread would leave both storeys editing one array.
      properties: { ...source.properties, axesX: parseAxes(source.properties.axesX), axesY: parseAxes(source.properties.axesY) },
    };
    const newChildren = children.map((c) => ({
      ...c,
      id: idMap.get(c.id)!,
      parentId: newStoreyId,
      x: c.x + 1000,
      y: c.y - 2000,
    }));

    const newEdges = edges
      .filter((e) => idMap.has(e.from) && idMap.has(e.to))
      .map((e) => ({ ...e, id: `edge_${uid()}`, from: idMap.get(e.from)!, to: idMap.get(e.to)! }));

    setNodes((prev) => [...prev, newStorey, ...newChildren]);
    setEdges((prev) => [...prev, ...newEdges]);
    setActiveStoreyId(newStoreyId);
  }, [nodes, edges, setActiveStoreyId]);

  // ── Property update handlers for non-graph-editor viewers ─────────────────
  const handleViewerUpdateField = useCallback((field: keyof BubbleGraphNode, v: unknown) => {
    // If multi-select is active, apply to all selected nodes; otherwise single node.
    // Match the inspector's node resolution: a stale SINGLE id in selectedNodeIds
    // must not shadow the actually-shown selectedNodeId (else edits hit the wrong
    // node and the field appears to "revert"). Only treat >1 as a real bulk edit.
    const targetIds = selectedNodeIds.length > 1
      ? selectedNodeIds
      : selectedNodeId ? [selectedNodeId] : selectedNodeIds;
    if (targetIds.length === 0) return;
    setNodes((prev) => prev.map((n) => targetIds.includes(n.id) ? { ...n, [field]: v } : n));
  }, [selectedNodeId, selectedNodeIds, setNodes]);

  const handleViewerUpdateProp = useCallback((key: string, v: unknown) => {
    // Match the inspector's node resolution: a stale SINGLE id in selectedNodeIds
    // must not shadow the actually-shown selectedNodeId (else edits hit the wrong
    // node and the field appears to "revert"). Only treat >1 as a real bulk edit.
    const targetIds = selectedNodeIds.length > 1
      ? selectedNodeIds
      : selectedNodeId ? [selectedNodeId] : selectedNodeIds;
    if (targetIds.length === 0) return;
    // Same rule as the graph-editor inspector: an active scenario takes the edit.
    const active = useScenarios.getState().activeId;
    if (active) {
      for (const id of targetIds) useScenarios.getState().patchNode(active, nodes, id, key, v);
      return;
    }
    setNodes((prev) => prev.map((n) =>
      targetIds.includes(n.id) ? { ...n, properties: { ...n.properties, [key]: v } } : n,
    ));
  }, [selectedNodeId, selectedNodeIds, setNodes, nodes]);

  const handleViewerUpdateProps = useCallback((patch: Record<string, unknown>) => {
    const targetIds = selectedNodeIds.length > 1
      ? selectedNodeIds
      : selectedNodeId ? [selectedNodeId] : selectedNodeIds;
    if (targetIds.length === 0) return;
    const active = useScenarios.getState().activeId;
    if (active) {
      for (const id of targetIds)
        for (const [k, v] of Object.entries(patch)) useScenarios.getState().patchNode(active, nodes, id, k, v);
      return;
    }
    setNodes((prev) => applyPropPatch(prev, targetIds, patch));
  }, [selectedNodeId, selectedNodeIds, setNodes, nodes]);

  const handleViewerAddProp = useCallback(() => {
    const key = prompt('Property name:');
    if (key) handleViewerUpdateProp(key, '');
  }, [handleViewerUpdateProp]);

  const handleViewerDeleteProp = useCallback((key: string) => {
    // Match the inspector's node resolution: a stale SINGLE id in selectedNodeIds
    // must not shadow the actually-shown selectedNodeId (else edits hit the wrong
    // node and the field appears to "revert"). Only treat >1 as a real bulk edit.
    const targetIds = selectedNodeIds.length > 1
      ? selectedNodeIds
      : selectedNodeId ? [selectedNodeId] : selectedNodeIds;
    if (targetIds.length === 0) return;
    setNodes((prev) => prev.map((n) => {
      if (!targetIds.includes(n.id)) return n;
      const { [key]: _, ...rest } = n.properties;
      return { ...n, properties: rest };
    }));
  }, [selectedNodeId, selectedNodeIds, setNodes]);

  const handleGenerateRoof = useCallback((level: 'envelope' | 'skeleton' | 'framing') => {
    const id = selectedNodeIds.length === 1
      ? selectedNodeIds[0]
      : selectedNodeId;
    if (!id) return;
    const roof = nodes.find((n) => n.id === id && n.type === 'roof');
    if (!roof) {
      toast.error('Select a roof node first');
      return;
    }
    const result = solveRoof({ nodes, edges, roofId: id, level });
    const applied = applyRoofResult(nodes, edges, result);
    setNodes(applied.nodes);
    setEdges(applied.edges);
    const errs = result.diagnostics.filter((d) => d.severity === 'error');
    const warns = result.diagnostics.filter((d) => d.severity === 'warning');
    const members = result.addNodes.filter(
      (n) => !['roof_ridge', 'roof_eave', 'roof_hip', 'roof_valley'].includes(n.type),
    ).length;
    if (errs.length) toast.error(errs[0].message);
    else if (level === 'framing') toast.success(`Roof complete: ${result.faces.length} faces, ${members} members`);
    else if (warns.length) toast.info(warns[0].message);
    else toast.success(`Roof ${level}: ${result.faces.length} face(s)`);
  }, [selectedNodeId, selectedNodeIds, nodes, edges, setNodes, setEdges]);

  const handleAddRoofForActiveStorey = useCallback(() => {
    const sid = activeStoreyId ?? storeyNodes[storeyNodes.length - 1]?.id;
    if (!sid) {
      toast.error('Add a storey with walls first');
      return;
    }
    const out = createRoofForStorey(sid, nodes, edges, {
      roofType: 'gable',
      pitchDeg: 30,
      generateLevel: 'framing',
    });
    if (!out.roofId) {
      toast.error(out.diagnostics[0]?.message ?? 'Could not create roof');
      return;
    }
    setNodes(out.nodes);
    setEdges(out.edges);
    setSelectedNodeId(out.roofId);
    setSelectedNodeIds([]);
    const rafters = out.nodes.filter((n) => n.type === 'rafter' && n.properties.source_roof_id === out.roofId).length;
    toast.success(`Roof complete — ${rafters} rafters. Change type/pitch in Inspector + regenerate.`);
  }, [activeStoreyId, storeyNodes, nodes, edges, setNodes, setEdges, setSelectedNodeId, setSelectedNodeIds]);

  const handleRewireGraph = useCallback((fn: (ns: BubbleGraphNode[], es: BubbleGraphEdge[]) => { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] }) => {
    const r = fn(nodes, edges);
    if (r.nodes !== nodes) setNodes(r.nodes);
    if (r.edges !== edges) setEdges(r.edges);
  }, [nodes, edges, setNodes, setEdges]);

  const handleGenerateStair = useCallback((level: 'outline' | 'flights' | 'steps') => {
    const id = selectedNodeIds.length === 1 ? selectedNodeIds[0] : selectedNodeId;
    const stairwell = id ? nodes.find((n) => n.id === id && n.type === 'stairwell') : null;
    if (!stairwell) {
      toast.error('Select a stairwell node first');
      return;
    }
    const result = solveStair({ nodes, edges, stairwellId: stairwell.id, level });
    const applied = applyStairResult(nodes, edges, result);
    setNodes(applied.nodes);
    setEdges(applied.edges);

    const errs = result.diagnostics.filter((d) => d.severity === 'error');
    if (errs.length) { toast.error(errs[0].message); return; }
    const g = result.geometry;
    if (g) {
      toast.success(
        `Stair: ${g.steps} risers of ${Math.round(g.riserMm)} mm, going ${Math.round(g.treadMm)} mm `
        + `(2h+g = ${Math.round(2 * g.riserMm + g.treadMm)})`,
      );
    }
    // Every limit the sizing misses is worth seeing, not just the first.
    for (const d of result.diagnostics.filter((x) => x.severity === 'warning')) toast.error(d.message);
    for (const d of result.diagnostics.filter((x) => x.severity === 'info')) toast.info(d.message);
  }, [selectedNodeId, selectedNodeIds, nodes, edges, setNodes, setEdges]);

  // Live regeneration: edit a stair parameter or drag the node, and the stair
  // rebuilds itself. The explicit buttons remain for switching detail level.
  useAutoRegenerateStairs(nodes, edges, setNodes, setEdges);

  const handleAddStairwellForActiveStorey = useCallback(() => {
    const sid = activeStoreyId ?? storeyNodes[0]?.id;
    if (!sid) {
      toast.error('Add a storey first');
      return;
    }
    // Drop it at the middle of what already exists, so it lands somewhere useful
    // rather than at the origin on top of the grid.
    const placed = nodes.filter((n) => n.type === 'ax');
    const at = placed.length
      ? {
          x: Math.round(placed.reduce((s, n) => s + n.x, 0) / placed.length),
          y: Math.round(placed.reduce((s, n) => s + n.y, 0) / placed.length),
        }
      : { x: 0, y: 0 };

    const out = createStairwellForStorey(sid, nodes, edges, undefined, at);
    if (!out.stairwellId) {
      toast.error(out.diagnostics[0]?.message ?? 'Could not create stairwell');
      return;
    }
    setNodes(out.nodes);
    setEdges(out.edges);
    setSelectedNodeId(out.stairwellId);
    setSelectedNodeIds([]);
    const errs = out.diagnostics.filter((d) => d.severity === 'error');
    if (errs.length) { toast.error(errs[0].message); return; }
    const sw = out.nodes.find((n) => n.id === out.stairwellId);
    toast.success(
      `Stairwell: ${sw?.properties.solved_steps ?? '?'} risers of `
      + `${sw?.properties.solved_riser_mm ?? '?'} mm. Set type/width in the Inspector, then regenerate.`,
    );
    for (const d of out.diagnostics.filter((x) => x.severity === 'warning')) toast.error(d.message);
  }, [activeStoreyId, storeyNodes, nodes, edges, setNodes, setEdges, setSelectedNodeId, setSelectedNodeIds]);

  /** Add a sweep node for the active storey — the user then wires it to axes. */
  const handleAddSweepForActiveStorey = useCallback(() => {
    const sid = activeStoreyId ?? storeyNodes[0]?.id;
    if (!sid) {
      toast.error('Add a storey first');
      return;
    }
    const placed = nodes.filter((n) => n.type === 'ax');
    const at = placed.length
      ? {
          x: Math.round(placed.reduce((s, n) => s + n.x, 0) / placed.length),
          y: Math.round(placed.reduce((s, n) => s + n.y, 0) / placed.length),
        }
      : { x: 0, y: 0 };
    const nt = getNodeTypeData('sweep');
    const id = `node_sweep_${Date.now().toString(36)}`;
    setNodes((prev) => [...prev, {
      id, type: 'sweep',
      name: `Sweep${prev.filter((n) => n.type === 'sweep').length + 1}`,
      x: at.x, y: at.y, z: 0,
      parentId: sid,
      properties: { ...(nt?.defaultProperties ?? {}) },
    }]);
    setSelectedNodeId(id);
    setSelectedNodeIds([]);
    toast.success('Sweep adăugat — leagă-l de 1 ax (vertical), 2 (segment) sau mai multe (polilinie).');
  }, [activeStoreyId, storeyNodes, nodes, setNodes, setSelectedNodeId, setSelectedNodeIds]);

  /** Add a dome node for the active storey — the user then wires its base contour. */
  const handleAddDomeForActiveStorey = useCallback(() => {
    const sid = activeStoreyId ?? storeyNodes[0]?.id;
    if (!sid) {
      toast.error('Add a storey first');
      return;
    }
    const placed = nodes.filter((n) => n.type === 'ax');
    const at = placed.length
      ? {
          x: Math.round(placed.reduce((s, n) => s + n.x, 0) / placed.length),
          y: Math.round(placed.reduce((s, n) => s + n.y, 0) / placed.length),
        }
      : { x: 0, y: 0 };
    const nt = getNodeTypeData('dome');
    const id = `node_dome_${Date.now().toString(36)}`;
    setNodes((prev) => [...prev, {
      id, type: 'dome',
      name: `Dom${prev.filter((n) => n.type === 'dome').length + 1}`,
      x: at.x, y: at.y, z: 0,
      parentId: sid,
      properties: { ...(nt?.defaultProperties ?? {}) },
    }]);
    setSelectedNodeId(id);
    setSelectedNodeIds([]);
    toast.success('Dom adăugat — leagă-l de un ax și dă-i o rază, sau de 3+ axe în ordinea conturului.');
  }, [activeStoreyId, storeyNodes, nodes, setNodes, setSelectedNodeId, setSelectedNodeIds]);

  /** Add the site node — one per project; the user wires it to the anchor axis. */
  const handleAddSite = useCallback(() => {
    const sid = activeStoreyId ?? storeyNodes[0]?.id;
    if (!sid) {
      toast.error('Add a storey first');
      return;
    }
    const existing = nodes.find((n) => n.type === 'site');
    if (existing) {
      setSelectedNodeId(existing.id);
      setSelectedNodeIds([]);
      toast.info('Proiectul are deja un teren — l-am selectat.');
      return;
    }
    // On the storey at ±0.00, anchored to the middle of its axes, 0.45 m
    // below the floor — a ground that shows straight away (lib/terrain/siteNode).
    const made = createSiteNode(nodes, getNodeTypeData('site')?.defaultProperties ?? {});
    if (!made) { toast.error('Add a storey first'); return; }
    setNodes((prev) => [...prev, made.node]);
    if (made.edge) setEdges((prev) => [...prev, made.edge!]);
    setSelectedNodeId(made.node.id);
    setSelectedNodeIds([]);
    toast.success(made.edge
      ? 'Teren adăugat la −0.45 m, centrat pe clădire.'
      : 'Teren adăugat — leagă-l de axul unde vrei centrul grilei.');
  }, [activeStoreyId, storeyNodes, nodes, setNodes, setEdges, setSelectedNodeId, setSelectedNodeIds]);

  /** Add an igloo-style entrance; the user wires it to a dome and to an axis. */
  const handleAddDomeEntrance = useCallback(() => {
    const sid = activeStoreyId ?? storeyNodes[0]?.id;
    if (!sid) {
      toast.error('Add a storey first');
      return;
    }
    const domes = nodes.filter((n) => n.type === 'dome' && n.parentId === sid);
    if (domes.length === 0) {
      toast.error('Adaugă întâi un dom — intrarea se deschide într-unul.');
      return;
    }
    const nt = getNodeTypeData('dome_entrance');
    const id = `node_domeent_${Date.now().toString(36)}`;
    const host = domes.find((d) => d.id === selectedNodeId) ?? domes[0];
    setNodes((prev) => [...prev, {
      id, type: 'dome_entrance',
      name: `Intrare${prev.filter((n) => n.type === 'dome_entrance').length + 1}`,
      x: host.x + 60, y: host.y + 60, z: 0,
      parentId: sid,
      properties: { ...(nt?.defaultProperties ?? {}) },
    }]);
    // Wired to the dome straight away — an entrance with no dome has nothing
    // to open into, and that edge is never the interesting choice.
    setEdges((prev) => [...prev, { id: `edge_${id}`, from: host.id, to: id }]);
    setSelectedNodeId(id);
    setSelectedNodeIds([]);
    toast.success(`Intrare adăugată în „${host.name}" — leag-o de axul unde vrei gura tunelului.`);
  }, [activeStoreyId, storeyNodes, nodes, selectedNodeId, setNodes, setEdges, setSelectedNodeId, setSelectedNodeIds]);

  /** Delete a full storey + its children */
  const deleteStorey = useCallback((storeyId: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== storeyId && n.parentId !== storeyId));
    setEdges((prev) => {
      const toRemove = new Set(nodes.filter((n) => n.id === storeyId || n.parentId === storeyId).map((n) => n.id));
      return prev.filter((e) => !toRemove.has(e.from) && !toRemove.has(e.to));
    });
    if (activeStoreyId === storeyId) setActiveStoreyId(null);
  }, [nodes, activeStoreyId, setActiveStoreyId]);

  /** Create a new storey from current buildingAxes */
  const handleCreateStorey = useCallback((cfg: {
    name: string; bottomElev: number; topElev: number; discipline: StoreyDiscipline;
  }) => {
    const { name, bottomElev, topElev, discipline } = cfg;
    const xs = buildingAxes.xValues;
    const ys = buildingAxes.yValues;
    const maxX = xs[xs.length - 1] ?? 0;
    const maxY = ys[ys.length - 1] ?? 0;
    const numStoreys = storeyNodes.length;
    const cx = 8000 + numStoreys * 500;
    const cy = 6000;
    const storeyId = `storey_${uid()}`;
    const axDef = getNodeTypeData('ax');
    const newNodes: BubbleGraphNode[] = [{
      id: storeyId, type: 'storey', name, x: cx, y: cy, z: 0,
      properties: { bottomElevation: bottomElev, topElevation: topElev, axesX: xs, axesY: ys, width: maxX, height: maxY, discipline },
      locked: true,
    }];
    // Generate ax nodes — gridX/gridY are the stable spatial identifiers,
    // axNodeIndex = gridY * xs.length + gridX is the flat sequential index.
    // These three properties are the permanent identity of each ax node and
    // MUST be preserved when axis distances change (only the coordinate table changes).
    for (let i = 0; i < ys.length; i++) {
      for (let j = 0; j < xs.length; j++) {
        const axNodeIndex = i * xs.length + j;
        newNodes.push({
          id: `ax_${storeyId}_${j}_${i}`,
          type: 'ax',
          name: `${j + 1}-${String.fromCharCode(65 + i)}`,
          x: cx + (xs[j] - maxX / 2),
          y: cy + (ys[i] - maxY / 2),
          z: 0,
          properties: { ...(axDef?.defaultProperties ?? {}), gridX: j, gridY: i, axNodeIndex },
          locked: true,
          parentId: storeyId,
        });
      }
    }
    setNodes((prev) => [...prev, ...newNodes]);
    setShowNewStoreyDialog(false);
    setActiveStoreyId(storeyId);
  }, [buildingAxes, storeyNodes.length, setActiveStoreyId]);

  /** Update mutable properties on an existing storey */
  const handleEditStorey = useCallback((updates: {
    name: string; bottomElev: number; topElev: number; discipline: StoreyDiscipline;
  }) => {
    if (!editingStoreyId) return;
    setNodes((prev) => prev.map((n) => {
      if (n.id !== editingStoreyId) return n;
      return {
        ...n,
        name: updates.name,
        properties: {
          ...n.properties,
          bottomElevation: updates.bottomElev,
          topElevation: updates.topElev,
          discipline: updates.discipline,
        },
      };
    }));
    setEditingStoreyId(null);
  }, [editingStoreyId]);

  /**
   * Regenerate the ax grid for a storey when its inter-axis distances change.
   *
   * FOUNDATIONAL RULE: gridX/gridY/axNodeIndex are stable identifiers.
   * Only the coordinate table (axesX/axesY on the storey node) changes.
   * All non-spatial properties (has_column, column_type, custom metadata…)
   * are preserved for every (gridX, gridY) pair that still exists after the change.
   * New intersections receive default properties; removed ones are deleted along
   * with any edges that referenced them.
   */
  const handleRegenerateStoreyAxes = useCallback((storeyId: string, newAxesX: number[], newAxesY: number[]) => {
    const axDef = getNodeTypeData('ax');
    setNodes((prev) => {
      const storey = prev.find((n) => n.id === storeyId);
      if (!storey) return prev;

      // ── Old canvas extents (needed to remap non-ax nodes proportionally) ──
      const oldXs = [...((storey.properties.axesX as number[] | undefined) ?? [])].sort((a, b) => a - b);
      const oldYs = [...((storey.properties.axesY as number[] | undefined) ?? [])].sort((a, b) => a - b);
      const oldMaxX = oldXs[oldXs.length - 1] ?? 0;
      const oldMaxY = oldYs[oldYs.length - 1] ?? 0;
      const cx = storey.x;
      const cy = storey.y;
      // Canvas span formula: canvas_x = cx + (bimX - oldMaxX/2)
      const oldCL = cx + (oldXs[0] ?? 0) - oldMaxX / 2;
      const oldCR = cx + oldMaxX / 2;
      const oldCB = cy + (oldYs[0] ?? 0) - oldMaxY / 2;
      const oldCT = cy + oldMaxY / 2;
      const oldSpanX = oldCR - oldCL;
      const oldSpanY = oldCT - oldCB;

      // Build a map of existing ax-node properties keyed by (gridX, gridY)
      const existingProps = new Map<string, Record<string, unknown>>();
      for (const n of prev) {
        if (n.parentId === storeyId && n.type === 'ax') {
          const key = `${n.properties.gridX}_${n.properties.gridY}`;
          existingProps.set(key, n.properties);
        }
      }

      // Collect IDs of ax nodes that are being removed (grid shrinks)
      const keptKeys = new Set<string>();
      for (let i = 0; i < newAxesY.length; i++)
        for (let j = 0; j < newAxesX.length; j++)
          keptKeys.add(`${j}_${i}`);
      const removedIds = new Set(
        prev
          .filter((n) => n.parentId === storeyId && n.type === 'ax')
          .filter((n) => !keptKeys.has(`${n.properties.gridX}_${n.properties.gridY}`))
          .map((n) => n.id),
      );

      // Remove old ax nodes (and their edges are removed in setEdges below)
      const without = prev.filter((n) => !(n.parentId === storeyId && n.type === 'ax'));

      // Update storey coordinate table
      const xs = [...newAxesX].sort((a, b) => a - b);
      const ys = [...newAxesY].sort((a, b) => a - b);
      const maxX = xs[xs.length - 1] ?? 0;
      const maxY = ys[ys.length - 1] ?? 0;

      // ── New canvas extents ──
      const newCL = cx + (xs[0] ?? 0) - maxX / 2;
      const newCR = cx + maxX / 2;
      const newCB = cy + (ys[0] ?? 0) - maxY / 2;
      const newCT = cy + maxY / 2;

      // Proportional remap: non-ax child nodes follow the grid stretch/shrink
      const remapNode = (n: BubbleGraphNode): BubbleGraphNode => {
        if (n.parentId !== storeyId || n.type === 'ax' || n.id === storeyId) return n;
        if (oldSpanX < 1 || oldSpanY < 1) return n; // first-time setup, nothing to remap
        const tx = (n.x - oldCL) / oldSpanX;
        const ty = (n.y - oldCB) / oldSpanY;
        return {
          ...n,
          x: newCL + tx * (newCR - newCL),
          y: newCB + ty * (newCT - newCB),
        };
      };

      const updatedStorey = without.map((n) => {
        if (n.id === storeyId) return { ...n, properties: { ...n.properties, axesX: xs, axesY: ys, width: maxX, height: maxY } };
        return remapNode(n);
      });

      // Regenerate ax nodes, preserving properties for existing (gridX, gridY) pairs
      const newAxNodes: BubbleGraphNode[] = [];
      for (let i = 0; i < ys.length; i++) {
        for (let j = 0; j < xs.length; j++) {
          const axNodeIndex = i * xs.length + j;
          const key = `${j}_${i}`;
          const preserved = existingProps.get(key) ?? {};
          newAxNodes.push({
            id: `ax_${storeyId}_${j}_${i}`,
            type: 'ax',
            name: `${j + 1}-${String.fromCharCode(65 + i)}`,
            x: cx + (xs[j] - maxX / 2),
            y: cy + (ys[i] - maxY / 2),
            z: 0,
            properties: {
              ...(axDef?.defaultProperties ?? {}),
              ...preserved,           // overwrite with preserved (keeps has_column etc.)
              gridX: j,               // always authoritative
              gridY: i,
              axNodeIndex,
            },
            locked: true,
            parentId: storeyId,
          });
        }
      }

      // Also remove any edges that touched removed ax nodes
      setEdges((prevEdges) => prevEdges.filter((e) => !removedIds.has(e.from) && !removedIds.has(e.to)));

      // ── Semantic layout pass ─────────────────────────────────────────────
      // After proportional remap, snap each non-ax node to the semantically
      // correct canvas position derived from its connected ax endpoints.
      //
      // Canvas formula: canvas_x = storey.x + (bimX_mm - maxX/2)
      //                 canvas_y = storey.y + (bimY_mm - maxY/2)
      const bimToCanvas = (bx: number, by: number) => ({
        x: cx + (bx - maxX / 2),
        y: cy + (by - maxY / 2),
      });

      // Build a lookup: id → node, including the freshly generated ax nodes
      const draft = [...updatedStorey, ...newAxNodes];
      const draftMap = new Map(draft.map((n) => [n.id, n]));

      // Helper: BIM mm position of any node in the draft (ax or non-ax)
      const draftBimPos = (n: BubbleGraphNode): { x: number; y: number } => {
        if (n.type === 'ax') {
          return {
            x: xs[Number(n.properties.gridX ?? 0)] ?? 0,
            y: ys[Number(n.properties.gridY ?? 0)] ?? 0,
          };
        }
        // For non-ax nodes that have already been proportionally remapped,
        // convert canvas back to BIM mm:
        return {
          x: n.x - cx + maxX / 2,
          y: n.y - cy + maxY / 2,
        };
      };

      const activeEdges = edges.filter((e) => !removedIds.has(e.from) && !removedIds.has(e.to));

      // IDs of direct (non-ax) children of this storey — used to extend coverage
      // to nodes connected to them even if their own parentId differs (e.g. windows
      // placed before parentId was set).
      const storeyChildIds = new Set(
        draft.filter((n) => n.parentId === storeyId && n.type !== 'ax' && n.id !== storeyId).map((n) => n.id),
      );

      // A node is "affected" if it lives in this storey or is directly connected to
      // one of its children (1-hop reach, e.g. windows with no parentId).
      const isAffected = (n: BubbleGraphNode): boolean => {
        if (n.id === storeyId || n.type === 'ax' || n.type === 'storey') return false;
        if (n.parentId === storeyId) return true;
        return activeEdges.some(
          (e) =>
            (e.from === n.id && storeyChildIds.has(e.to)) ||
            (e.to === n.id && storeyChildIds.has(e.from)),
        );
      };

      // For walls/beams: compute canvas midpoint between two ax endpoints.
      // Returns null if there aren't exactly two ax endpoints.
      const wallMidCanvas = (n: BubbleGraphNode): { x: number; y: number } | null => {
        const connectedNodes = activeEdges
          .filter((e) => e.from === n.id || e.to === n.id)
          .map((e) => draftMap.get(e.from === n.id ? e.to : e.from))
          .filter((c): c is BubbleGraphNode => !!c);
        const axPts = connectedNodes.filter((c) => c.type === 'ax');
        if (axPts.length < 2) return null;
        const pA = draftBimPos(axPts[0]);
        const pB = draftBimPos(axPts[1]);
        return bimToCanvas((pA.x + pB.x) / 2, (pA.y + pB.y) / 2);
      };

      // Pre-compute wall canvas positions (needed for door/window offsets)
      const wallCanvasPos = new Map<string, { x: number; y: number }>();
      for (const n of draft) {
        if (n.type === 'wall' || n.type === 'beam') {
          const mid = wallMidCanvas(n);
          if (mid) wallCanvasPos.set(n.id, mid);
        }
      }

      // For each wall, collect which doors/windows are attached so we can stagger them.
      // Key: wall node id → sorted list of opening node ids
      const wallOpenings = new Map<string, string[]>();
      for (const n of draft) {
        if (n.type !== 'door' && n.type !== 'window') continue;
        const connNodes = activeEdges
          .filter((e) => e.from === n.id || e.to === n.id)
          .map((e) => draftMap.get(e.from === n.id ? e.to : e.from))
          .filter((c): c is BubbleGraphNode => !!c);
        const wallConn = connNodes.find((c) => c.type === 'wall');
        if (wallConn) {
          if (!wallOpenings.has(wallConn.id)) wallOpenings.set(wallConn.id, []);
          wallOpenings.get(wallConn.id)!.push(n.id);
        }
      }

      // Half the minimum axis step — used as perpendicular offset for openings
      const minStepX = xs.length >= 2
        ? Math.min(...xs.slice(1).map((v, i) => v - xs[i]))
        : (xs[0] ?? 6000);
      const minStepY = ys.length >= 2
        ? Math.min(...ys.slice(1).map((v, i) => v - ys[i]))
        : (ys[0] ?? 6000);
      const perpOffset = Math.min(minStepX, minStepY) * 0.28; // ~28% of smallest bay

      const semanticallySorted = draft.map((n): BubbleGraphNode => {
        if (!isAffected(n)) return n;

        const connectedNodes = activeEdges
          .filter((e) => e.from === n.id || e.to === n.id)
          .map((e) => draftMap.get(e.from === n.id ? e.to : e.from))
          .filter((c): c is BubbleGraphNode => !!c);

        // ── Walls & beams: midpoint of their two ax endpoints ──────────────
        if (n.type === 'wall' || n.type === 'beam') {
          const mid = wallMidCanvas(n);
          if (mid) return { ...n, x: mid.x, y: mid.y };
        }

        // ── Doors & windows: perpendicular to wall + stagger along wall ────
        if (n.type === 'door' || n.type === 'window') {
          const wallConn = connectedNodes.find((c) => c.type === 'wall');
          if (wallConn) {
            const wPos = wallCanvasPos.get(wallConn.id);
            if (wPos) {
              // Get wall direction from its ax endpoints to compute perpendicular
              const wallAxConn = activeEdges
                .filter((e) => e.from === wallConn.id || e.to === wallConn.id)
                .map((e) => draftMap.get(e.from === wallConn.id ? e.to : e.from))
                .filter((c): c is BubbleGraphNode => !!c && c.type === 'ax');
              let perpX = 0, perpY = perpOffset; // default: offset upward
              let wallDirX = 1, wallDirY = 0;
              if (wallAxConn.length >= 2) {
                const pA = draftBimPos(wallAxConn[0]);
                const pB = draftBimPos(wallAxConn[1]);
                const dx = pB.x - pA.x, dy = pB.y - pA.y;
                const len = Math.sqrt(dx * dx + dy * dy) || 1;
                wallDirX = dx / len; wallDirY = dy / len;
                // Perpendicular (CCW 90°): (-dy, dx)
                perpX = -wallDirY * perpOffset;
                perpY = wallDirX * perpOffset;
              }
              // Stagger index: position this opening evenly along the wall
              const siblings = wallOpenings.get(wallConn.id) ?? [n.id];
              const idx = siblings.indexOf(n.id);
              const count = siblings.length;
              // Distribute along wall: -0.5..+0.5 of perpOffset, then along wall axis
              const staggerAlong = count > 1
                ? (idx - (count - 1) / 2) * perpOffset * 0.6
                : 0;
              return {
                ...n,
                x: wPos.x + perpX + wallDirX * staggerAlong,
                y: wPos.y + perpY + wallDirY * staggerAlong,
              };
            }
          }
          // No wall found: place at centroid of any connected nodes
          if (connectedNodes.length > 0) {
            const positions = connectedNodes.map(draftBimPos);
            const sumX = positions.reduce((s, p) => s + p.x, 0);
            const sumY = positions.reduce((s, p) => s + p.y, 0);
            const centroid = bimToCanvas(sumX / positions.length, sumY / positions.length);
            return { ...n, x: centroid.x + perpOffset, y: centroid.y };
          }
        }

        // ── Rooms, slabs, shells, coverings, foundations: centroid ─────────
        if (['room', 'slab', 'foundation', 'shell', 'cell', 'covering', 'roof'].includes(n.type) && connectedNodes.length > 0) {
          const positions = connectedNodes.map(draftBimPos);
          const sumX = positions.reduce((s, p) => s + p.x, 0);
          const sumY = positions.reduce((s, p) => s + p.y, 0);
          const centroid = bimToCanvas(sumX / positions.length, sumY / positions.length);
          return { ...n, x: centroid.x, y: centroid.y };
        }

        // Fallback: keep proportional position
        return n;
      });

      return semanticallySorted;
    });
    setEditingStoreyId(null);
  }, [edges, setEdges]);

  /**
   * Called when the user saves new global Building Axes.
   * Updates the global buildingAxes store value AND regenerates the ax grid
   * on every existing storey, preserving all non-spatial node properties.
   */
  const handleGlobalAxesSave = useCallback((axes: BuildingAxes) => {
    const xs = axes.xValues;
    const ys = axes.yValues;
    const oldXCount = buildingAxes.xValues.length;
    const oldYCount = buildingAxes.yValues.length;
    // Warn if any storey grid would shrink
    if (storeyNodes.length > 0 && (xs.length < oldXCount || ys.length < oldYCount)) {
      if (!confirm(
        `The grid is shrinking (was ${oldXCount}×${oldYCount}, becomes ${xs.length}×${ys.length}).\n` +
        `Ax nodes and edges outside the new grid will be deleted on ALL storeys.\nContinue?`,
      )) return;
    }
    setBuildingAxes(axes);
    // Regenerate ax grid for every storey
    for (const s of storeyNodes) {
      handleRegenerateStoreyAxes(s.id, xs, ys);
    }
    setShowAxesDialog(false);
  }, [buildingAxes, storeyNodes, setBuildingAxes, handleRegenerateStoreyAxes]);

  // Auto-save and auto-backup state (moved from BubbleGraphCanvas to BubbleGraphPanel for header scope)
  const { lastSaved, isSaving, saveError, performSave } = useAutoSave(nodes, edges, buildingAxes, projectName, structuralSystem, isLoaded, 10000);
  useAutoBackup(nodes, 300000);

  // Applies a restored (or freshly re-loaded) backend graph into local state — same
  // shape as handleWebOpenProject, minus the file-open-specific bits (view tabs etc.),
  // since a history restore only ever changes graph content, not the workspace layout.
  // `data` comes from api.ts's loadGraph()/GraphData — its own BubbleGraphNode/Edge
  // types are structurally looser than @/store's (e.g. no required `z`), same `as`
  // bridge handleWebOpenProject already uses for the same reason.
  const handleRestoreFromHistory = useCallback((data: GraphData) => {
    breakCoalescing(); // a restore is a hard reset — never merge into a preceding undo step
    const restoredNodes = data.nodes as unknown as BubbleGraphNode[];
    setNodes(restoredNodes);
    setEdges(annotateEdgeTypes(data.edges as unknown as BubbleGraphEdge[], restoredNodes));
    if (data.buildingAxes) setBuildingAxes(data.buildingAxes);
    if (data.projectName) setProjectName(data.projectName);
    setProjectSpecs(parseSpecSelection(data.specs));
    const restoredSystem = parseStructuralSystem(data.structuralSystem);
    if (restoredSystem) setStructuralSystem(restoredSystem);
    importScenarios(data.scenarios);
    if (data.activeStoreyId !== undefined) setActiveStoreyId(data.activeStoreyId ?? null);
  }, [breakCoalescing, setBuildingAxes, setActiveStoreyId]);

  // ── Shell: modes (the graph first), project and panel menus, commands ──
  const shellModes = modesFor(caps);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Bumped to save a version from outside the versions panel (Ctrl+Shift+S, the palette). */
  const [versionSaveRequest, setVersionSaveRequest] = useState(0);

  const openOrAdd = useCallback((type: 'terrain' | 'worldview' | 'ifc-tiles' | 'composer', label: string) => {
    const existing = useBubbleGraphStore.getState().viewTabs.find((t) => t.type === type);
    if (existing) { setActiveTabId(existing.id); return; }
    const id = addViewTab({ type, label, canClose: true });
    setActiveTabId(id);
  }, [addViewTab, setActiveTabId]);

  const goToMode = useCallback((m: ShellMode) => {
    if (m === 'graph') { setActiveTabId('graph-editor'); return; }
    if (m === '3d') { handleOpen3DTab(); return; }
    if (m === 'plan') {
      const s = storeyNodes.find((x) => x.id === activeStoreyId) ?? storeyNodes[0];
      if (!s) { toast.info(ro ? 'Adaugă întâi un nivel în graf.' : 'Add a storey to the graph first.'); return; }
      handleOpenFloorPlanTab(s.id, s.name, 'architectural');
      return;
    }
    if (m === 'sheets') {
      const ex = useBubbleGraphStore.getState().viewTabs.find((t) => t.type === 'sheet');
      if (ex) setActiveTabId(ex.id); else handleOpenSimpleTab('sheet', ro ? 'Planșa A1' : 'Sheet A1');
      return;
    }
    openOrAdd('terrain', ro ? 'Teren' : 'Terrain Modeler');
  }, [setActiveTabId, handleOpen3DTab, storeyNodes, activeStoreyId, handleOpenFloorPlanTab, handleOpenSimpleTab, openOrAdd, ro]);

  const [showProjectConfig, setShowProjectConfig] = useState(false);
  const appliedStyle = useMemo(() => readAppliedStyle(nodes), [nodes]);

  const configGroups = useMemo<ConfigGroup[]>(() => {
    const specsN = Object.keys(projectSpecs).length;
    const styleLabel = appliedStyle ? STYLE_PACK_MAP.get(appliedStyle.packId)?.label ?? appliedStyle.packId : null;
    return [
      {
        label: ro ? 'Goluri' : 'Openings',
        cards: [
          { id: 'win', icon: RectangleHorizontal, title: ro ? 'Ferestre' : 'Windows',
            text: ro ? 'Tipurile de fereastră ale proiectului: dimensiuni, ramă, simbolul din plan.' : 'The project\'s window types: sizes, frame, plan symbol.',
            action: { label: ro ? 'Configurează' : 'Configure', onClick: () => { setShowDoorConfigurator(false); setShowWindowConfigurator(true); } } },
          { id: 'door', icon: DoorOpen, title: ro ? 'Uși' : 'Doors',
            text: ro ? 'Tipurile de ușă: foi, deschidere, toc, simbolul din plan.' : 'Door types: leaves, swing, frame, plan symbol.',
            action: { label: ro ? 'Configurează' : 'Configure', onClick: () => { setShowWindowConfigurator(false); setShowDoorConfigurator(true); } } },
        ],
      },
      {
        label: ro ? 'Materiale' : 'Materials',
        cards: [
          ...(caps.projectSpecs ? [{ id: 'specs', icon: Layers, title: ro ? 'Materialele proiectului' : 'Project materials',
            text: ro ? 'Ce cărămidă, ce tencuială, ce termoizolație, ce pardoseală — pentru tot proiectul.' : 'Which brick, render, insulation, flooring — for the whole project.',
            state: specsN ? `${specsN} ${ro ? 'alese' : 'chosen'}` : undefined,
            action: { label: specsPanelOpen ? (ro ? 'Ascunde' : 'Hide') : (ro ? 'Alege' : 'Choose'), onClick: () => setSpecsPanelOpen((v) => !v), active: specsPanelOpen } }] : []),
          { id: 'look', icon: Palette, title: ro ? 'Aspectul materialelor' : 'Material look',
            text: ro ? 'Culori, transparență și hașuri, în 3D și în planuri.' : 'Colours, transparency and hatches, in 3D and in plans.',
            action: { label: ro ? 'Editează' : 'Edit', onClick: () => setShowMaterialEditor(true) } },
          { id: 'lib', icon: BookMarked, title: ro ? 'Librărie: articole și procese' : 'Library: items and processes',
            text: ro ? 'Articolele de deviz, mapările și specificațiile — pe utilizator sau pe proiect.' : 'Cost items, mappings and specs — per user or per project.',
            action: { label: ro ? 'Deschide' : 'Open', onClick: () => setShowLibrary(true) } },
        ],
      },
      {
        label: ro ? 'Arhitectură și structură' : 'Architecture and structure',
        cards: [
          { id: 'style', icon: House, title: ro ? 'Stil arhitectural' : 'Architectural style',
            text: ro ? 'Reguli aplicate grafului: acoperiș, intrare, soclu, ornamente, terase.' : 'Rules applied to the graph: roof, entrance, plinth, ornament, terraces.',
            state: styleLabel ?? (ro ? 'niciun stil aplicat' : 'no style applied'),
            action: { label: styleLabel ? (ro ? 'Schimbă' : 'Change') : (ro ? 'Alege un stil' : 'Pick a style'), onClick: () => setShowStyleDialog(true) } },
          ...(caps.projectSpecs ? [{ id: 'system', icon: Building2, title: ro ? 'Sistem structural' : 'Structural system',
            text: STRUCTURAL_SYSTEM_HINTS[structuralSystem],
            control: (
              <select className="bb-btn bb-config-select" value={structuralSystem}
                aria-label={ro ? 'Sistem structural' : 'Structural system'}
                onChange={(e) => setStructuralSystem(e.target.value as StructuralSystem)}>
                {STRUCTURAL_SYSTEMS.map((sy) => (
                  <option key={sy} value={sy}>{sy === 'unset' ? (ro ? 'nedeclarat' : 'unset') : STRUCTURAL_SYSTEM_LABELS[sy]}</option>
                ))}
              </select>
            ) }] : []),
        ],
      },
      {
        label: ro ? 'Desen' : 'Drawing',
        cards: caps.extras ? [{ id: 'sym', icon: Shapes, title: ro ? 'Simboluri 2D' : '2D symbols',
          text: ro ? 'Cum se desenează fiecare tip de element în plan.' : 'How each element type is drawn in plan.',
          action: { label: ro ? 'Configurează' : 'Configure', onClick: () => setShowSymbolConfig(true) } }] : [],
      },
    ];
  }, [ro, caps.projectSpecs, caps.extras, projectSpecs, specsPanelOpen, appliedStyle, structuralSystem, setStructuralSystem]);

  // ── Project browser (Revit-style tree) ──
  const browserItems = useMemo<TreeItem[]>(() => {
    const L = (r: string, e: string) => (ro ? r : e);
    const tabLeaf = (t: ViewTab, icon: TreeItem['icon']): TreeItem => ({
      id: `tab:${t.id}`, label: t.label, icon, active: activeTabId === t.id, onOpen: () => setActiveTabId(t.id),
      actions: t.canClose ? [{ label: L('Închide', 'Close'), glyph: '✕', danger: true, onClick: () => closeViewTab(t.id) }] : undefined,
    });
    const items: TreeItem[] = [];
    // Storeys top down, as a section through the building reads.
    const levels = [...storeyNodes].sort((a, b) => Number(b.properties.bottomElevation ?? 0) - Number(a.properties.bottomElevation ?? 0));

    // The graph: the root, with its storeys — which part of it you work on.
    items.push({
      id: 'graph', label: L('Graf', 'Graph'), icon: Share2, root: true, kbd: '1', defaultOpen: true,
      active: activeTabMeta?.type === 'graph-editor',
      hint: L('Rădăcina modelului — toate vederile de mai jos se desenează din el', 'The model\'s root — every view below is drawn from it'),
      onOpen: () => setActiveTabId('graph-editor'),
      children: [
        { id: 'graph:all', label: L('Toate nivelurile', 'All storeys'), icon: Layers3, active: !activeStoreyId,
          onOpen: () => { setActiveStoreyId(null); setActiveTabId('graph-editor'); } },
        ...levels.map((st): TreeItem => ({
          id: `graph:${st.id}`, label: st.name, icon: Layers3, active: activeStoreyId === st.id,
          badge: (() => { const z = Number(st.properties.bottomElevation ?? 0); return `${z >= 0 ? '+' : '−'}${(Math.abs(z) / 1000).toFixed(2)}`; })(),
          hint: L('Clic: lucrezi pe acest nivel · dublu-clic: planul lui', 'Click: work on this storey · double-click: its plan'),
          onOpen: () => { setActiveStoreyId(st.id); setActiveTabId('graph-editor'); },
          onDoubleClick: caps.drawings ? () => handleOpenFloorPlanTab(st.id, st.name, 'architectural') : undefined,
          actions: [
            { label: L('Editează nivelul', 'Edit storey'), glyph: '✎', onClick: () => setEditingStoreyId(st.id) },
            { label: L('Duplică nivelul', 'Duplicate storey'), glyph: '⧉', onClick: () => duplicateStorey(st.id) },
            { label: L('Șterge nivelul', 'Delete storey'), glyph: '✕', danger: true, onClick: () => deleteStorey(st.id) },
          ],
        })),
        { id: 'graph:new', label: L('Nivel nou…', 'New storey…'), create: true, onOpen: () => setShowNewStoreyDialog(true) },
      ],
    });

    // Views, by kind, as Revit sorts them — each a thing of the project, with
    // its own name and notes; a tab is only where one is open.
    const views: TreeItem[] = [];
    const elev = (id?: string) => Number(storeyNodes.find((x) => x.id === id)?.properties.bottomElevation ?? 0);
    const viewLeaf = (v: DrawingView): TreeItem => {
      const tab = viewTabs.find((t) => t.params?.drawingViewId === v.id);
      return {
        id: `dv:${v.id}`, label: v.name, tag: v.engine === 'og' ? 'OG' : undefined,
        icon: v.kind === 'plan' ? PanelTop : v.kind === 'section' ? Scissors : Columns2,
        active: !!tab && activeTabId === tab.id,
        onOpen: () => openDrawingView(v),
        onRename: (name) => renameDrawingView(v.id, name),
        actions: [
          { label: L('Duplică', 'Duplicate'), glyph: '⧉', onClick: () => duplicateDrawingView(v.id, false) },
          { label: L('Duplică cu adnotări', 'Duplicate with detailing'), glyph: '⧉✎', onClick: () => duplicateDrawingView(v.id, true) },
          { label: L('Șterge vederea', 'Delete view'), glyph: '✕', danger: true, onClick: () => deleteDrawingView(v.id) },
        ],
      };
    };
    const plansFolder = (disc: StoreyDiscipline, id: string, label: string, open = false): TreeItem => {
      const list = drawingViews
        .filter((v) => v.kind === 'plan' && (v.discipline ?? 'architectural') === disc)
        .sort((a, b) => elev(b.storeyId) - elev(a.storeyId) || a.name.localeCompare(b.name));
      return {
        id, label, icon: Folder, badge: list.length, defaultOpen: open,
        children: [
          ...list.map(viewLeaf),
          { id: `${id}:new`, label: L('Plan nou…', 'New plan…'), create: true, onOpen: () => setNewViewInit({ kind: 'plan', discipline: disc, storeyId: activeStoreyId ?? undefined }) },
        ],
      };
    };
    if (caps.drawings) {
      views.push(plansFolder('architectural', 'plans', L('Planuri de nivel', 'Floor plans'), true));
      if (caps.lab) {
        views.push(plansFolder('structural', 'plans-s', L('Planuri de structură', 'Structural plans')));
        views.push(plansFolder('mep', 'plans-m', L('Planuri de instalații', 'MEP plans')));
      }
    }
    const tabs3d = viewTabs.filter((t) => t.type === '3d-model' || t.type === 'opengeo-3d');
    views.push({
      id: '3d', label: L('Vederi 3D', '3D views'), icon: Folder, badge: tabs3d.length, defaultOpen: true,
      children: [
        ...tabs3d.map((t) => tabLeaf(t, Box)),
        ...(tabs3d.length ? [] : [{ id: '3d:new', label: '{3D}', icon: Box, onOpen: handleOpen3DTab } satisfies TreeItem]),
      ],
    });
    if (caps.drawings) {
      const elevations = drawingViews.filter((v) => v.kind === 'elevation').sort((a, b) => a.name.localeCompare(b.name));
      views.push({
        id: 'elev', label: L('Fațade', 'Elevations'), icon: Folder, badge: elevations.length,
        children: [
          ...elevations.map(viewLeaf),
          { id: 'elev:four', label: L('Generează cele 4 fațade', 'Generate the 4 elevations'), create: true, onOpen: handleGenerateDefaultElevations },
          { id: 'elev:new', label: L('Fațadă nouă…', 'New elevation…'), create: true, onOpen: () => setNewViewInit({ kind: 'elevation' }) },
        ],
      });
      const sections = drawingViews.filter((v) => v.kind === 'section').sort((a, b) => a.name.localeCompare(b.name));
      views.push({
        id: 'sec', label: L('Secțiuni', 'Sections'), icon: Folder, badge: sections.length,
        children: [
          ...sections.map(viewLeaf),
          { id: 'sec:draw', label: L('Desenează o secțiune', 'Draw a section'), create: true, onOpen: () => startPlanSectionTool('draw-section') },
          { id: 'sec:axis', label: L('Secțiune pe ax', 'Section on an axis'), create: true, onOpen: () => startPlanSectionTool('section-on-axis') },
          { id: 'sec:new', label: L('Secțiune OpenGeometry…', 'OpenGeometry section…'), create: true, onOpen: () => setNewViewInit({ kind: 'section', engine: 'og' }) },
        ],
      });
    }
    if (caps.site) {
      const world = viewTabs.find((t) => t.type === 'worldview');
      const terr = viewTabs.find((t) => t.type === 'terrain');
      views.push({
        id: 'site', label: L('Sit', 'Site'), icon: Folder,
        children: [
          { id: 'site:terrain', label: L('Teren', 'Terrain'), icon: Mountain, active: !!terr && activeTabId === terr.id, onOpen: () => openOrAdd('terrain', L('Teren', 'Terrain Modeler')) },
          { id: 'site:world', label: L('Lume', 'World'), icon: Globe2, active: !!world && activeTabId === world.id, onOpen: () => openOrAdd('worldview', 'World View') },
        ],
      });
    }
    items.push({
      id: 'views', label: L('Vederi', 'Views'), icon: Folder, defaultOpen: true,
      children: caps.drawings
        ? [...views, { id: 'views:new', label: L('Vedere nouă…', 'New view…'), create: true, onOpen: () => setNewViewInit({}) }]
        : views,
    });

    // Schedules and quantities.
    if (caps.quantities) {
      const report = viewTabs.find((t) => t.type === 'report');
      const tables = viewTabs.filter((t) => t.type === 'table');
      items.push({
        id: 'sched', label: L('Tabele și cantități', 'Schedules and quantities'), icon: Folder,
        children: [
          { id: 'sched:memo', label: L('Memoriu de calcul', 'Calculation memo'), icon: Calculator, active: !!report && activeTabId === report.id, onOpen: handleOpenReportTab },
          ...tables.map((t) => tabLeaf(t, Table2)),
          { id: 'sched:table', label: L('Tabel nou', 'New schedule'), create: true, onOpen: () => handleOpenSimpleTab('table', L('Tabel elemente', 'Element Schedule')) },
          { id: 'sched:qty', label: L('Cantități pe articole', 'Quantities by item'), icon: Calculator, badge: takeoffF3Count,
            content: <QuantitiesPanel nodes={viewNodes} edges={edges} projectName={projectName} onHighlightNodes={handleQuantityHighlight} /> },
        ],
      });
    }

    // Sheets.
    if (caps.drawings) {
      const sheets = viewTabs.filter((t) => t.type === 'sheet');
      items.push({
        id: 'sheets', label: L('Planșe', 'Sheets'), icon: Folder, badge: sheets.length,
        children: [
          ...sheets.map((t) => tabLeaf(t, FileStack)),
          { id: 'sheets:new', label: L('Planșă nouă', 'New sheet'), create: true, onOpen: () => handleOpenSimpleTab('sheet', L('Planșa A1', 'Sheet A1')) },
        ],
      });
    }

    // Families: the types the model uses, by category; a type selects its elements.
    const byCat = new Map<string, Map<string, string[]>>();
    for (const n of nodes) {
      if (NOT_A_FAMILY.has(n.type)) continue;
      const cat = byCat.get(n.type) ?? new Map<string, string[]>();
      const t = familyTypeOf(n);
      cat.set(t, [...(cat.get(t) ?? []), n.id]);
      byCat.set(n.type, cat);
    }
    const catLabel = (t: string) => (ro ? FAMILY_LABEL_RO[t] : undefined) ?? getNodeTypeData(t)?.label ?? t;
    items.push({
      id: 'fam', label: L('Familii', 'Families'), icon: Package, badge: byCat.size,
      hint: L('Tipurile folosite în model — clic pe un tip selectează elementele lui', 'The types the model uses — click a type to select its elements'),
      children: [...byCat.entries()]
        .sort((a, b) => catLabel(a[0]).localeCompare(catLabel(b[0])))
        .map(([type, types]): TreeItem => ({
          id: `fam:${type}`, label: catLabel(type), icon: Folder,
          badge: [...types.values()].reduce((sum, ids) => sum + ids.length, 0),
          children: [...types.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([t, ids]): TreeItem => ({
            id: `fam:${type}:${t}`, label: t, icon: Shapes, badge: ids.length,
            active: ids.length > 0 && selectedNodeIds.length === ids.length && ids.every((id) => selectedNodeIds.includes(id)),
            hint: L('Selectează elementele de acest tip', 'Select the elements of this type'),
            onOpen: () => { setSelectedNodeIds(ids); setSelectedNodeId(ids[0] ?? null); setInspOpen(true); },
          })),
        })),
    });

    // Structural analysis.
    if (caps.fem && storeyNodes.length) {
      const femTab = (id: string) => viewTabs.find((t) => t.type === 'fem' && t.storeyId === id);
      items.push({
        id: 'fem', label: L('Analiză structurală', 'Structural analysis'), icon: Building2,
        children: [
          ...(storeyNodes.length > 1 ? [{ id: 'fem:all', label: L('Toată clădirea', 'Whole building'), icon: Building2,
            active: !!femTab('all') && activeTabId === femTab('all')!.id,
            onOpen: () => handleOpenFemTab('all', L('Toată clădirea', 'Whole building')) } satisfies TreeItem] : []),
          ...storeyNodes.map((st): TreeItem => ({ id: `fem:${st.id}`, label: st.name, icon: Layers3,
            active: !!femTab(st.id) && activeTabId === femTab(st.id)!.id, onOpen: () => handleOpenFemTab(st.id, st.name) })),
        ],
      });
    }

    // The lab: other engines and experimental views.
    if (caps.lab) {
      const labTabs = viewTabs.filter((t) => ['composer', 'topology', 'ifc-plan', 'ifc-tiles', 'opengeo-floorplan', 'opengeo-section', 'opengeo-elevation'].includes(t.type));
      items.push({
        id: 'lab', label: L('Laborator', 'Lab'), icon: FlaskConical, badge: labTabs.length,
        children: [
          { id: 'lab:tiles', label: 'IFC Tiles', icon: Box, onOpen: () => openOrAdd('ifc-tiles', 'IFC Tiles') },
          { id: 'lab:ifcplan', label: L('Plan IFC 2D', 'IFC 2D plan'), icon: PanelTop, onOpen: handleOpenIFCPlanTab },
          { id: 'lab:composer', label: 'Composer', icon: Shapes, onOpen: () => openOrAdd('composer', 'Composer') },
          { id: 'lab:topo', label: L('Analiză topologică', 'Topology analysis'), icon: Share2, onOpen: handleOpenTopologyTab },
          { id: 'lab:og', label: 'OG 2D', icon: Folder, children: [
            ...storeyNodes.map((st): TreeItem => ({ id: `lab:og:${st.id}`, label: `${L('Plan', 'Plan')} — ${st.name}`, icon: PanelTop, onOpen: () => handleOpenOGFloorPlanTab(st.id, st.name) })),
            ...(['N', 'S', 'E', 'W'] as const).map((d): TreeItem => ({ id: `lab:ogs:${d}`, label: `${L('Secțiune', 'Section')} ${d}`, icon: Scissors, onOpen: () => handleOpenOGSectionTab(d) })),
            ...(['N', 'S', 'E', 'W'] as const).map((d): TreeItem => ({ id: `lab:oge:${d}`, label: `${L('Fațadă', 'Elevation')} ${d}`, icon: Columns2, onOpen: () => handleOpenOGElevationTab(d) })),
          ] },
          ...labTabs.map((t) => tabLeaf(t, Box)),
        ],
      });
    }
    return items;
  }, [ro, caps, nodes, edges, viewNodes, projectName, storeyNodes, viewTabs, activeTabId, activeTabMeta, activeStoreyId, selectedNodeIds,
    takeoffF3Count, setActiveTabId, closeViewTab, setActiveStoreyId, handleOpenFloorPlanTab, duplicateStorey, deleteStorey,
    handleOpen3DTab, handleOpenSectionTab, handleGenerateDefaultElevations, startPlanSectionTool, openOrAdd, handleOpenReportTab,
    handleOpenSimpleTab, handleQuantityHighlight, setSelectedNodeIds, setSelectedNodeId, handleOpenFemTab, handleOpenIFCPlanTab,
    handleOpenTopologyTab, handleOpenOGFloorPlanTab, handleOpenOGSectionTab, handleOpenOGElevationTab,
    drawingViews, openDrawingView, renameDrawingView, duplicateDrawingView, deleteDrawingView]);

  const handleExportGraphML = useCallback(() => {
    downloadBlob(new Blob([graphMLText(nodes, edges)], { type: 'application/xml' }), 'bubble-graph.graphml');
  }, [nodes, edges]);
  const handleImportGraphML = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.graphml,.xml';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        try {
          const g = parseGraphML(text);
          setNodes(g.nodes);
          setEdges(g.edges);
          setSelectedNodeId(null);
        } catch (err) {
          toast.error(`GraphML: ${(err as Error).message}`);
        }
      });
    };
    input.click();
  }, [setNodes, setEdges, setSelectedNodeId]);
  /**
   * The model as IFC4, built in the browser — the same builder the 3D viewers
   * draw from (walls, openings, roofs and their timber, dormers, sweeps,
   * styles, IFC library elements), georeferenced when the project is placed.
   * No backend: every edition can download it.
   */
  const handleDownloadIfc = useCallback(async () => {
    try {
      let libraryParts: Map<string, import('@/lib/ifc/buildIfcModel').LibraryPart[]> | undefined;
      try {
        const { collectAllIfcLibraryPaths, libraryPartsForExport } = await import('@/lib/ifcLibraryLoader');
        const paths = collectAllIfcLibraryPaths(nodes);
        if (paths.length) {
          const entries = await Promise.all(paths.map(async (p) => [p, await libraryPartsForExport(p).catch(() => [])] as const));
          libraryParts = new Map(entries.filter(([, parts]) => parts.length));
        }
      } catch { /* the generic frames stand in for library elements */ }
      const { content } = buildIfcModel(nodes, edges, projectName, {
        georeference: exportGeoreference(useBubbleGraphStore.getState().worldLocation),
        materialConfig: getMaterialConfigSync(),
        libraryParts,
      });
      const name = safeFilename(projectName || 'model', 'ifc');
      downloadBlob(new Blob([content], { type: 'application/x-step' }), name);
      toast.success(`IFC: ${name} — ${(content.length / 1048576).toFixed(1)} MB`);
    } catch (err) {
      toast.error(`IFC: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [nodes, edges, projectName]);

  const projectMenu = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = isElectron
      ? [
        { label: ro ? 'Proiect nou' : 'New project', keys: 'Ctrl N', onClick: handleNewProject },
        { label: ro ? 'Deschide…' : 'Open…', keys: 'Ctrl O', onClick: handleOpenProject },
        { label: ro ? 'Salvează' : 'Save', keys: 'Ctrl S', onClick: handleSaveProject },
        { label: ro ? 'Salvează ca…' : 'Save as…', onClick: handleSaveAs },
      ]
      : [
        { label: ro ? 'Proiect nou' : 'New project', onClick: handleWebNewProject },
        { label: ro ? 'Deschide un fișier .bbim…' : 'Open a .bbim file…', onClick: handleWebOpenProject },
        { label: ro ? 'Descarcă .bbim' : 'Download .bbim', onClick: handleWebSaveProject },
      ];
    items.push(
      { label: ro ? 'Proiecte salvate pe server' : 'Projects on the server', onClick: () => setShowProjects(true) },
      { label: ro ? 'Export și import' : 'Export and import', heading: true },
      { label: ro ? 'Descarcă IFC (IFC4)' : 'Download IFC (IFC4)', onClick: () => { void handleDownloadIfc(); } },
      { label: ro ? 'Export HTML de sine stătător' : 'Standalone HTML export', onClick: handleStandaloneExport },
      { label: ro ? 'Exportă graful (GraphML)' : 'Export the graph (GraphML)', onClick: handleExportGraphML },
      { label: ro ? 'Importă un graf (GraphML)…' : 'Import a graph (GraphML)…', onClick: handleImportGraphML },
    );
    if (caps.extras) items.push({ label: ro ? 'Importă joc de societate (JSON)' : 'Import board game (JSON)', onClick: handleImportBoardGame });
    // A hosted edition goes back to its project list; a desktop one has nowhere to go.
    if (cloudAccount) items.push({ label: ro ? 'Închide proiectul' : 'Close project', onClick: onClose });
    return items;
  }, [ro, caps.extras, cloudAccount, onClose, handleNewProject, handleOpenProject, handleSaveProject, handleSaveAs,
    handleWebNewProject, handleWebOpenProject, handleWebSaveProject, handleStandaloneExport, handleImportBoardGame,
    handleDownloadIfc, handleExportGraphML, handleImportGraphML]);

  const panelsMenu = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [
      { label: ro ? 'Configurare proiect' : 'Project setup', active: showProjectConfig, onClick: () => setShowProjectConfig((v) => !v) },
      { label: ro ? 'Bibliotecă de obiecte' : 'Object library', active: showObjectLibrary, onClick: () => setShowObjectLibrary((v) => !v) },
    ];
    items.push({ label: ro ? 'Ajutor' : 'Help', heading: true });
    if (caps.chat) items.push({ label: ro ? 'Chat AI pe graf' : 'AI chat on the graph', active: showChat, onClick: () => setShowChat((v) => !v) });
    items.push(
      { label: ro ? 'Ghid de lucru' : 'Workflow guide', onClick: () => setShowHelp(true) },
      { label: ro ? 'Navigator' : 'Navigator', active: navOpen, onClick: () => setNavOpen((v) => !v) },
      { label: 'Inspector', active: inspOpen, onClick: () => setInspOpen((v) => !v) },
    );
    return items;
  }, [ro, caps.chat, showProjectConfig, showObjectLibrary, showChat, navOpen, inspOpen]);

  const commands = useMemo<ShellCommand[]>(() => {
    const out: ShellCommand[] = [];
    const g = { mode: ro ? 'Mod' : 'Mode', file: ro ? 'Proiect' : 'Project', panel: ro ? 'Panou' : 'Panel',
      add: ro ? 'Adaugă' : 'Add', view: ro ? 'Vedere' : 'View', tool: ro ? 'Unealtă' : 'Tool' };
    for (const m of shellModes) out.push({ id: `mode:${m.id}`, group: g.mode, label: m.label[caps.lang], keys: m.key, run: () => goToMode(m.id) });
    const fromMenu = (items: MenuItem[], group: string, prefix: string) => items.forEach((it, i) => {
      if (it.heading || it.node || !it.onClick) return;
      out.push({ id: `${prefix}:${i}`, group, label: it.label, keys: it.keys, run: it.onClick });
    });
    fromMenu(projectMenu, g.file, 'file');
    fromMenu(panelsMenu, g.panel, 'panel');
    out.push(
      { id: 'setup:axes', group: g.tool, label: ro ? '1 · Axe' : '1 · Axes', run: () => setShowAxesDialog(true) },
      { id: 'setup:storey', group: g.tool, label: ro ? '2 · Nivel nou' : '2 · New storey', run: () => setShowNewStoreyDialog(true) },
      { id: 'style', group: g.tool, label: ro ? 'Stil arhitectural' : 'Architectural style', run: () => setShowStyleDialog(true) },
      { id: 'ver:save', group: g.file, label: ro ? 'Salvează o versiune' : 'Save a version', keys: 'Ctrl Shift S', run: () => setVersionSaveRequest((n) => n + 1) },
      { id: 'ver:history', group: g.file, label: ro ? 'Istoric versiuni' : 'Version history', run: () => setShowHistoryPanel(true) },
      { id: 'add:roof', group: g.add, label: ro ? 'Acoperiș pe nivelul activ' : 'Roof on the active storey', run: handleAddRoofForActiveStorey },
      { id: 'add:stair', group: g.add, label: ro ? 'Casa scării pe nivelul activ' : 'Stairwell on the active storey', run: handleAddStairwellForActiveStorey },
      { id: 'add:sweep', group: g.add, label: 'Sweep', run: handleAddSweepForActiveStorey },
      { id: 'add:dome', group: g.add, label: ro ? 'Cupolă' : 'Dome', run: handleAddDomeForActiveStorey },
      { id: 'add:site', group: g.add, label: ro ? 'Teren (sit)' : 'Site terrain', run: handleAddSite },
      { id: 'tool:windows', group: g.tool, label: ro ? 'Configurator ferestre' : 'Window configurator', run: () => setShowWindowConfigurator(true) },
      { id: 'tool:doors', group: g.tool, label: ro ? 'Configurator uși' : 'Door configurator', run: () => setShowDoorConfigurator(true) },
      { id: 'tool:select', group: g.tool, label: ro ? 'Selecție după filtru' : 'Select by filter', run: () => setShowMultiSelect(true) },
      { id: 'tool:grid', group: g.tool, label: ro ? '3 · Mod grilă în graf' : '3 · Graph grid mode', run: () => { setActiveTabId('graph-editor'); setGridMode((v) => !v); } },
      { id: 'tool:symbols', group: g.tool, label: ro ? 'Simboluri 2D' : '2D symbols', run: () => setShowSymbolConfig(true) },
      { id: 'tool:look', group: g.tool, label: ro ? 'Aspectul materialelor' : 'Material look', run: () => setShowMaterialEditor(true) },
      { id: 'tool:library', group: g.tool, label: ro ? 'Librărie: articole și procese' : 'Library: items and processes', run: () => setShowLibrary(true) },
    );
    if (caps.drawings) {
      out.push(
        { id: 'view:section', group: g.view, label: ro ? 'Desenează o secțiune' : 'Draw a section', run: () => startPlanSectionTool('draw-section') },
        { id: 'view:section-axis', group: g.view, label: ro ? 'Secțiune pe ax' : 'Section on an axis', run: () => startPlanSectionTool('section-on-axis') },
        { id: 'view:elevations', group: g.view, label: ro ? 'Fațadele (4)' : 'The four elevations', run: handleGenerateDefaultElevations },
        { id: 'view:sheet', group: g.view, label: ro ? 'Planșă nouă' : 'New sheet', run: () => handleOpenSimpleTab('sheet', ro ? 'Planșa A1' : 'Sheet A1') },
      );
      for (const s of storeyNodes) {
        out.push({ id: `view:plan:${s.id}`, group: g.view, label: `${ro ? 'Plan' : 'Plan'} — ${s.name}`, run: () => handleOpenFloorPlanTab(s.id, s.name, 'architectural') });
      }
    }
    if (caps.site) out.push({ id: 'view:world', group: g.view, label: ro ? 'Harta lumii' : 'World view', run: () => openOrAdd('worldview', 'World View') });
    if (caps.quantities) {
      const sim = ro ? 'Simulări' : 'Simulations';
      out.push(
        { id: 'view:memo', group: g.view, label: ro ? 'Memoriu de calcul' : 'Calculation memo', run: handleOpenReportTab },
        { id: 'sim:dashboard', group: sim, label: 'Dashboard', run: () => setDashboardOpen((v) => !v) },
        { id: 'sim:cost', group: sim, label: ro ? 'Structura costurilor' : 'Cost breakdown', run: () => setCostPanelOpen((v) => !v) },
        { id: 'sim:compare', group: sim, label: ro ? 'Compară scenarii' : 'Compare scenarios', run: () => setComparePanelOpen((v) => !v) },
      );
    }
    if (caps.fem) out.push({ id: 'view:fem', group: g.view, label: ro ? 'Model structural (FEM) — toată clădirea' : 'Structural model (FEM) — whole building', run: () => handleOpenFemTab('all', ro ? 'Toată clădirea' : 'Whole building') });
    for (const s of storeyNodes) out.push({ id: `storey:${s.id}`, group: ro ? 'Nivel' : 'Storey', label: s.name, run: () => setActiveStoreyId(s.id) });
    return out;
  }, [ro, caps, shellModes, goToMode, projectMenu, panelsMenu, storeyNodes, handleAddRoofForActiveStorey, handleAddStairwellForActiveStorey,
    handleAddSweepForActiveStorey, handleAddDomeForActiveStorey, handleAddSite, startPlanSectionTool, handleGenerateDefaultElevations,
    handleOpenSimpleTab, handleOpenFloorPlanTab, openOrAdd, handleOpenReportTab, handleOpenFemTab, setActiveStoreyId]);

  // Mode keys 1–5 and Ctrl K, anywhere but in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      // Ctrl+Shift+S: a version, named later in the history if need be.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setVersionSaveRequest((n) => n + 1);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const m = shellModes.find((x) => x.key === e.key);
      if (m) { e.preventDefault(); goToMode(m.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shellModes, goToMode]);

  if (!visible) return null;

  const activeTabLabel = viewTabs.find((t) => t.id === activeTabId)?.label ?? 'Graph';
  const storeyLabel = storeyNodes.find((s) => s.id === activeStoreyId)?.name ?? 'All storeys';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background ac-shell">
      <div className="bg-background w-full h-full flex flex-col overflow-hidden">
        {/* ── HUD: project, modes (the graph first), commands ── */}
        <HudBar
          lang={caps.lang}
          projectName={currentFilePath ? (currentFilePath.split(/[\\/]/).pop() ?? projectName) : projectName}
          saving={isSaving}
          saveError={saveError}
          lastSaved={lastSaved}
          projectMenu={projectMenu}
          panelsMenu={panelsMenu}
          onCommand={() => setPaletteOpen(true)}
          undo={undo}
          redo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          simulations={caps.quantities ? (() => {
            const total = activeScenarioId ? scenarioTotals.get(activeScenarioId) ?? null : scenarioResults.baseline?.metrics.total ?? null;
            const name = activeScenario?.name ?? 'Baseline';
            return (
              <HudPopover
                className="bb-hud-sim"
                ariaLabel={ro ? 'Simulări' : 'Simulations'}
                icon={<FlaskConical className="bb-ico" strokeWidth={1.75} />}
                label={(
                  <span className="bb-hud-sim-label">
                    <span>{ro ? 'Simulări' : 'Simulations'}</span>
                    <span className="bb-hud-sim-chip">{name}{total != null ? ` · ${Math.round(total).toLocaleString('ro-RO')} ${CURRENCY}` : ''}</span>
                  </span>
                )}
              >
                <div className="bb-sim">
                  <h4>{ro ? 'Scenarii de cost' : 'Cost scenarios'}</h4>
                  <p>{ro ? 'Același model, alte decizii: alege scenariul pe care îl arată vederile, adaugă unul, compară-le.' : 'The same model, other decisions: pick the scenario the views show, add one, compare them.'}</p>
                  <ScenarioBar
                    inline
                    base={nodes}
                    edges={edges}
                    projectSystem={structuralSystem}
                    projectSpecs={projectSpecs}
                    baselineTotal={scenarioResults.baseline?.metrics.total ?? null}
                    totals={scenarioTotals}
                    onOpenCompare={() => setComparePanelOpen(true)}
                  />
                  <div className="bb-sim-actions">
                    <button type="button" className={`bb-btn${comparePanelOpen ? ' active' : ''}`} onClick={() => setComparePanelOpen((v) => !v)}>{ro ? 'Compară scenarii' : 'Compare scenarios'}</button>
                    <button type="button" className={`bb-btn${costPanelOpen ? ' active' : ''}`} onClick={() => setCostPanelOpen((v) => !v)}>{ro ? 'Structura costurilor' : 'Cost breakdown'}</button>
                    <button type="button" className={`bb-btn${dashboardOpen ? ' active' : ''}`} onClick={() => setDashboardOpen((v) => !v)}>Dashboard</button>
                  </div>
                  {caps.fem && (
                    <>
                      <h4>{ro ? 'Structură' : 'Structure'}</h4>
                      <div className="bb-sim-actions">
                        <button type="button" className="bb-btn" onClick={() => handleOpenFemTab('all', ro ? 'Toată clădirea' : 'Whole building')}>
                          {ro ? 'Analiză FEM — toată clădirea' : 'FEM analysis — whole building'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </HudPopover>
            );
          })() : undefined}
          onConfig={() => setShowProjectConfig((v) => !v)}
          configActive={showProjectConfig}
          versions={(
            <VersionControl
              lang={caps.lang}
              onSaveBeforeCommit={performSave}
              onRestore={handleRestoreFromHistory}
              onOpenHistory={() => setShowHistoryPanel(true)}
              saveRequest={versionSaveRequest}
            />
          )}
          theme={cleanTheme}
          onToggleTheme={toggleCleanTheme}
          account={cloudAccount ? (
            <HudMenu
              align="right"
              className="ghost bb-hud-account"
              label={<span className="bb-hud-avatar" title={cloudAccount.username}>{cloudAccount.username.slice(0, 2).toUpperCase()}{(cloudAccount.supportUnreadCount ?? 0) > 0 && <span className="bb-hud-unread" />}</span>}
              items={[
                { label: cloudAccount.username, heading: true },
                { label: ro ? 'Proiectele mele' : 'My projects', onClick: cloudAccount.onProjects },
                ...(cloudAccount.onSupport ? [{
                  label: `${ro ? 'Suport' : 'Support'}${(cloudAccount.supportUnreadCount ?? 0) > 0 ? ` (${cloudAccount.supportUnreadCount})` : ''}`,
                  onClick: cloudAccount.onSupport,
                }] : []),
                { label: ro ? 'Ieși din cont' : 'Sign out', onClick: cloudAccount.onSignOut },
              ]}
            />
          ) : undefined}
        />
        {paletteOpen && <CommandPalette commands={commands} lang={caps.lang} onClose={() => setPaletteOpen(false)} />}

        {/* ── Body ── */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* ════════════════════════════════════════════════
              STOREY EXPLORER / NAVIGATOR
              ════════════════════════════════════════════════ */}
          {!navOpen ? (
            <button
              type="button"
              className="bb-dock-rail bb-dock-rail-left"
              title={ro ? 'Arată navigatorul' : 'Show navigator'}
              aria-label={ro ? 'Arată navigatorul' : 'Show navigator'}
              onClick={() => setNavOpen(true)}
            >
              <ChevronRight size={14} strokeWidth={1.85} />
              <span>Nav</span>
            </button>
          ) : (
          <aside className="bb-sidebar">
            <ProjectBrowser
              lang={caps.lang}
              title={ro ? 'Browser proiect' : 'Project browser'}
              projectName={projectName}
              items={browserItems}
              onCollapse={() => setNavOpen(false)}
            />
          </aside>
          )}

          {/* ════════════════════════════════════════════════
              VIEWPORT  — tab bar + active view content
              ════════════════════════════════════════════════ */}
          {(() => {
            const activeTab = viewTabs.find((t) => t.id === activeTabId);
            const activeViewDef = drawingViews.find((v) => v.id === activeTab?.params?.drawingViewId);
            return (
              <div className="flex-1 flex flex-col min-h-0 min-w-0">
                {/* Tab bar */}
                <ViewTabBar
                  tabs={profile === 'clean' ? cleanViewTabs : viewTabs}
                  activeTabId={activeTabId}
                  onSelect={setActiveTabId}
                  onClose={closeViewTab}
                  onRename={renameTabOrView}
                  useLucide
                  onDetach={detachView}
                  detachedIds={detachedIds}
                />

                {/* Context bar: the actions of the view in front, in every edition */}
                <CleanRibbon
                  viewType={activeTab?.type}
                  viewLabel={activeTab?.label}
                  extra={activeViewDef ? (
                    <div className="bb-ribbon-group bb-view-look">
                      <div className="bb-sep" />
                      <span className="bb-tools-label">{ro ? 'Desen' : 'Drawing'}</span>
                      <div className="bb-seg bb-seg-sm" role="radiogroup" aria-label={ro ? 'Motorul de desen' : 'Drawing engine'}>
                        {([['og', 'OpenGeometry'], ['classic', ro ? 'Clasic' : 'Classic']] as const).map(([e, l]) => (
                          <button key={e} type="button" role="radio" aria-checked={activeViewDef.engine === e}
                            className={activeViewDef.engine === e ? 'on' : ''}
                            onClick={() => switchViewEngine(activeViewDef.id, e)}>{l}</button>
                        ))}
                      </div>
                      <label className="bb-view-style">
                        <span className="bb-tools-label">{ro ? 'Stil' : 'Style'}</span>
                        <select
                          className="bb-input bb-input-sm"
                          value={activeViewDef.graphic ?? 'color'}
                          disabled={activeViewDef.kind === 'plan' && activeViewDef.engine === 'classic'}
                          title={activeViewDef.kind === 'plan' && activeViewDef.engine === 'classic'
                            ? (ro ? 'Stilurile grafice sunt pentru desenele OpenGeometry, secțiuni și fațade' : 'Graphic styles apply to OpenGeometry drawings, sections and elevations')
                            : (ro ? 'Cum arată desenul acestei vederi' : 'How this view is drawn')}
                          onChange={(e) => setViewGraphic(activeViewDef.id, e.target.value as GraphicStyleId)}
                        >
                          {GRAPHIC_STYLE_IDS.map((g) => <option key={g} value={g}>{GRAPHIC_STYLES[g].label}</option>)}
                        </select>
                      </label>
                    </div>
                  ) : undefined}
                  actions={{
                    onWindows: () => { setShowWindowConfigurator((p) => !p); setShowDoorConfigurator(false); setShowMultiSelect(false); },
                    onDoors: () => { setShowDoorConfigurator((p) => !p); setShowWindowConfigurator(false); setShowMultiSelect(false); },
                    onSelect: () => { setShowMultiSelect((p) => !p); setShowWindowConfigurator(false); setShowDoorConfigurator(false); },
                    onClearSelection: () => setSelectedNodeIds([]),
                    onAxes: () => setShowAxesDialog(true),
                    onGridMode: () => setGridMode((v) => !v),
                    gridModeActive: gridMode,
                    onMaterials: () => setShowMaterialEditor(true),
                    onStyle: () => setShowStyleDialog(true),
                    onAddStorey: () => setShowNewStoreyDialog(true),
                    onAddRoof: handleAddRoofForActiveStorey,
                    onAddStairwell: handleAddStairwellForActiveStorey,
                    onAddSweep: handleAddSweepForActiveStorey,
                    onAddDome: handleAddDomeForActiveStorey,
                    onAddDomeEntrance: handleAddDomeEntrance,
                    onAddSite: handleAddSite,
                    onOpen3D: handleOpen3DTab,
                    onOpenSheet: () => handleOpenSimpleTab('sheet', 'Sheet A1'),
                    onDrawSection: () => startPlanSectionTool('draw-section'),
                    onSectionOnAxis: () => startPlanSectionTool('section-on-axis'),
                    drawSectionActive: planTool === 'draw-section',
                    sectionOnAxisActive: planTool === 'section-on-axis',
                    windowsActive: showWindowConfigurator,
                    doorsActive: showDoorConfigurator,
                    selectActive: showMultiSelect,
                    selectionCount: selectedNodeIds.length,
                  }}
                />

                {/* Tab content */}
                <div className="flex-1 min-h-0 min-w-0 relative bb-workspace">
                  {/* A viewer that throws must not take the tab bar, the explorer
                      and the unsaved model down with it. Keyed by tab so moving
                      away and back gives the view a clean retry. */}
                  <ErrorBoundary label={activeTab?.label} resetKey={activeTabId}>
                  {/* Window configurator overlay */}
                  {showWindowConfigurator && (
                    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/25">
                      <WindowConfigurator onClose={() => setShowWindowConfigurator(false)} />
                    </div>
                  )}
                  {/* Door configurator overlay */}
                  {showDoorConfigurator && (
                    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/25">
                      <DoorConfigurator onClose={() => setShowDoorConfigurator(false)} />
                    </div>
                  )}
                  {/* Multi-select filter overlay */}
                  {showMultiSelect && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/25">
                      <NodeMultiSelectFilter
                        nodes={viewNodes}
                        onSelect={(ids) => { setSelectedNodeIds(ids); }}
                        onClose={() => setShowMultiSelect(false)}
                      />
                    </div>
                  )}
                  {/* Graph editor — always mounted to preserve canvas state; hidden when inactive */}
                  <div className={cn('absolute inset-0', activeTab?.type !== 'graph-editor' && 'invisible pointer-events-none')}>
                    <BubbleGraphCanvas
                      nodes={nodes}
                      inspectNodes={activeScenario ? viewNodes : undefined}
                      economy={economy}
                      edges={edges}
                      activeStoreyId={activeStoreyId}
                      buildingAxes={buildingAxes}
                      setNodes={setNodes}
                      setEdges={setEdges}
                      selectedNodeId={selectedNodeId}
                      setSelectedNodeId={setSelectedNodeId}
                      selectedNodeIds={selectedNodeIds}
                      setSelectedNodeIds={setSelectedNodeIds}
                      onOpenSectionTab={handleOpenSectionTab}
                      hidePropsPanel
                      gridMode={gridMode}
                      onToggleGridMode={() => setGridMode((v) => !v)}
                      onOpenAxes={() => setShowAxesDialog(true)}
                      onAddStorey={() => setShowNewStoreyDialog(true)}
                      lang={caps.lang}
                      undo={undo}
                      redo={redo}
                      projectSystem={structuralSystem}
                    />
                  </div>
                  {/* 3D viewer */}
                  {activeTab?.type === '3d-model' && (
                    <div className="absolute inset-0 flex flex-col">
                      {/* Viewer selector toolbar — full profile only */}
                      {!openGeoOnly && (
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20 flex-shrink-0">
                          <span className="text-xs text-muted-foreground">3D Engine:</span>
                          <button
                            onClick={() => setViewer3DType('tiles')}
                            className={cn(
                              'px-3 py-1 text-xs rounded transition-colors',
                              viewer3DType === 'tiles'
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted text-muted-foreground hover:bg-accent'
                            )}
                            title="Motorul nostru: modelul exact ca IFC-ul exportat, împărțit în tile-uri și randat cu BatchedMesh"
                          >
                            BubbleBIM (IFC Tiles)
                          </button>
                          <button
                            onClick={() => setViewer3DType('webifc')}
                            className={cn(
                              'px-3 py-1 text-xs rounded transition-colors',
                              viewer3DType === 'webifc'
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted text-muted-foreground hover:bg-accent'
                            )}
                          >
                            That Open (OBC)
                          </button>
                          <button
                            onClick={() => setViewer3DType('opengeo')}
                            className={cn(
                              'px-3 py-1 text-xs rounded transition-colors',
                              viewer3DType === 'opengeo'
                                ? 'bg-emerald-600 text-white'
                                : 'bg-muted text-muted-foreground hover:bg-accent'
                            )}
                          >
                            ⬡ OpenGeometry
                          </button>
                          <button
                            onClick={() => setViewer3DType('brep')}
                            className={cn(
                              'px-3 py-1 text-xs rounded transition-colors',
                              viewer3DType === 'brep'
                                ? 'bg-emerald-600 text-white'
                                : 'bg-muted text-muted-foreground hover:bg-accent'
                            )}
                            title="Diagnostic: internal B-rep kernel vs OpenGeometry"
                          >
                            ◈ B-rep (compare)
                          </button>
                        </div>
                      )}
                      {/* Viewer container */}
                      <div className="flex-1 min-h-0 relative">
                        {(openGeoOnly ? 'opengeo' : viewer3DType) === 'tiles' ? (
                          <IFCTilesViewer
                            source={modelIfc.model}
                            nodes={viewNodes}
                            edges={edges}
                            className="w-full h-full"
                            onSelectNode={(id) => handleViewerSelectNode(id)}
                            selectedNodeId={selectedNodeId}
                          />
                        ) : (openGeoOnly ? 'opengeo' : viewer3DType) === 'opengeo' ? (
                          <OpenGeoViewer
                            nodes={viewNodes}
                            edges={edges}
                            buildingAxes={buildingAxes}
                            className="w-full h-full"
                            onSelectNode={handleViewerSelectNode}
                            selectedNodeId={selectedNodeId}
                          />
                        ) : (openGeoOnly ? 'opengeo' : viewer3DType) === 'brep' ? (
                          <BrepViewer
                            nodes={viewNodes}
                            edges={edges}
                            className="w-full h-full"
                            onSelectNode={handleViewerSelectNode}
                            selectedNodeId={selectedNodeId}
                          />
                        ) : (
                          <WebIfcViewer
                            nodes={viewNodes}
                            edges={edges}
                            buildingAxes={buildingAxes}
                            className="w-full h-full"
                            onSelectNode={handleViewerSelectNode}
                            selectedNodeId={selectedNodeId}
                          />
                        )}
                      </div>
                    </div>
                  )}
                  {/* Floor plan viewer — SVG engine */}
                  {activeTab?.type === 'floorplan' && (
                    <div className="absolute inset-0">
                      <FloorPlan2DViewer
                        nodes={viewNodes}
                        edges={edges}
                        buildingAxes={buildingAxes}
                        storeyId={activeTab.storeyId ?? null}
                        discipline={activeTab.discipline ?? null}
                        annotationKey={activeViewDef?.annKey}
                        className="w-full h-full"
                        selectedNodeId={selectedNodeId}
                        onSelectNode={handleViewerSelectNode}
                        selectedNodeIds={selectedNodeIds}
                        onSelectNodes={setSelectedNodeIds}
                      />
                    </div>
                  )}
                  {/* Structural (FEM) viewer — spike: linear-elastic self-weight only, see src/lib/fem/ */}
                  {activeTab?.type === 'fem' && (
                    <div className="absolute inset-0">
                      <FemViewer
                        nodes={viewNodes}
                        edges={edges}
                        storeyId={activeTab.storeyId ?? null}
                        className="w-full h-full"
                      />
                    </div>
                  )}
                  {/* Report viewer — memoriu de calcul (CalcPad + graf + plan 2D) */}
                  {profile !== 'clean' && activeTab?.type === 'report' && (
                    <div className="absolute inset-0 overflow-y-auto bg-[hsl(var(--background))]">
                      <div className="mx-auto" style={{ maxWidth: 1000 }}>
                        <ReportTabView
                          nodes={viewNodes}
                          edges={edges}
                          projectName={projectName}
                          onHighlightNodes={handleQuantityHighlight}
                        />
                      </div>
                    </div>
                  )}
                  {/* Section viewer — SVG engine */}
                  {activeTab?.type === 'section' && (
                    <div className="absolute inset-0">
                      <Section2DViewer
                        nodes={viewNodes}
                        edges={edges}
                        cutY={activeTab.params?.cutY as number | undefined}
                        cutDepth={activeTab.params?.cutDepth as number | undefined}
                        startElevation={activeTab.params?.startElevation as number | undefined}
                        endElevation={activeTab.params?.endElevation as number | undefined}
                        sectionNodeId={activeTab.params?.nodeId as string | undefined}
                        annotationKey={activeViewDef?.annKey}
                        graphicStyle={activeViewDef?.graphic}
                        className="w-full h-full"
                      />
                    </div>
                  )}
                  {/* Elevation viewer — SVG engine */}
                  {activeTab?.type === 'elevation' && (
                    <div className="absolute inset-0">
                      <Elevation2DViewer
                        nodes={viewNodes}
                        edges={edges}
                        viewDirection={activeTab.params?.viewDirection as 'N' | 'S' | 'E' | 'W' | undefined}
                        startElevation={activeTab.params?.startElevation as number | undefined}
                        endElevation={activeTab.params?.endElevation as number | undefined}
                        annotationKey={activeViewDef?.annKey}
                        graphicStyle={activeViewDef?.graphic}
                        className="w-full h-full"
                      />
                    </div>
                  )}
                  {/* OG 2D Floor Plan */}
                  {activeTab?.type === 'opengeo-floorplan' && (
                    <div className="absolute inset-0">
                      <OGFloorPlanViewer
                        nodes={viewNodes}
                        edges={edges}
                        storeyId={activeTab.storeyId}
                        tabId={activeTab.id}
                        annotationKey={activeViewDef?.annKey}
                        graphicStyle={activeViewDef?.graphic}
                        initialCutPos={activeTab.params?.cutPos as number | undefined}
                        initialCutDepth={activeTab.params?.cutDepth as number | undefined}
                        className="w-full h-full"
                      />
                    </div>
                  )}
                  {/* OG 2D Section */}
                  {activeTab?.type === 'opengeo-section' && (
                    <div className="absolute inset-0">
                      <OGSectionViewer
                        nodes={viewNodes}
                        edges={edges}
                        viewDirection={activeTab.params?.viewDirection as 'N' | 'S' | 'E' | 'W' | undefined}
                        tabId={activeTab.id}
                        annotationKey={activeViewDef?.annKey}
                        graphicStyle={activeViewDef?.graphic}
                        initialCutPos={activeTab.params?.cutPos as number | undefined}
                        initialCutDepth={activeTab.params?.cutDepth as number | undefined}
                        className="w-full h-full"
                      />
                    </div>
                  )}
                  {/* OG 2D Elevation */}
                  {activeTab?.type === 'opengeo-elevation' && (
                    <div className="absolute inset-0">
                      <OGElevationViewer
                        nodes={viewNodes}
                        edges={edges}
                        viewDirection={activeTab.params?.viewDirection as 'N' | 'S' | 'E' | 'W' | undefined}
                        tabId={activeTab.id}
                        annotationKey={activeViewDef?.annKey}
                        graphicStyle={activeViewDef?.graphic}
                        initialCutPos={activeTab.params?.cutPos as number | undefined}
                        initialCutDepth={activeTab.params?.cutDepth as number | undefined}
                        className="w-full h-full"
                      />
                    </div>
                  )}
                  {/* World Viewer */}
                  {activeTab?.type === 'worldview' && (
                    <div className="absolute inset-0">
                      <WorldViewer projectName={projectName} tabId={activeTab.id} className="w-full h-full" />
                    </div>
                  )}
                  {/* IFC 2D Plan View */}
                  {activeTab?.type === 'ifc-plan' && (
                    <div className="absolute inset-0">
                      <IFCPlanView className="w-full h-full" />
                    </div>
                  )}
                  {/* Terrain Modeler */}
                  {activeTab?.type === 'terrain' && (
                    <div className="absolute inset-0">
                      <TerrainViewer tabId={activeTab.id} className="w-full h-full" />
                    </div>
                  )}
                  {/* IFC Tiles Viewer */}
                  {activeTab?.type === 'ifc-tiles' && (
                    <div className="absolute inset-0">
                      <IFCTilesViewer tabId={activeTab.id} className="w-full h-full" />
                    </div>
                  )}
                  {/* Sheet composer */}
                  {activeTab?.type === 'sheet' && (
                    <div className="absolute inset-0">
                      <SheetComposer
                        nodes={viewNodes}
                        edges={edges}
                        tab={activeTab}
                        className="w-full h-full"
                      />
                    </div>
                  )}
                  {/* Composer (RoomX) */}
                  {activeTab?.type === 'composer' && (
                    <div className="absolute inset-0">
                      <ComposerCanvas />
                    </div>
                  )}
                  {/* Room topology — the backend's CellComplex of the rooms */}
                  {activeTab?.type === 'topology' && (
                    <div className="absolute inset-0">
                      <TopologyView
                        nodes={viewNodes}
                        edges={edges}
                        selectedNodeId={selectedNodeId}
                        onSelectNode={handleViewerSelectNode}
                        projectName={projectName}
                        className="w-full h-full"
                      />
                    </div>
                  )}
                  {/* Placeholder views (table only) */}
                  {profile !== 'clean' && activeTab?.type === 'table' && (
                    <div className="absolute inset-0">
                      <PlaceholderView type={activeTab.type} label={activeTab.label} className="w-full h-full" />
                    </div>
                  )}

                  {specsPanelOpen && (
                    <div
                      style={{
                        position: 'absolute', top: 8, right: 16, zIndex: 42, width: 320,
                        background: 'hsl(var(--card, var(--background)))', border: '1px solid hsl(var(--border))',
                        borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,0.28)', padding: '10px 12px',
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 12 }}>⚒ Materiale și finisaje</span>
                        <button onClick={() => setSpecsPanelOpen(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--muted-foreground))', fontSize: 15, lineHeight: 1 }}>×</button>
                      </div>
                      <div style={{ fontSize: 10.5, color: 'hsl(var(--muted-foreground))', marginBottom: 8, lineHeight: 1.45 }}>
                        Alegerile proiectului. Un scenariu le poate schimba peste, iar un element le poate
                        suprascrie punctual din inspector. Opțiunile vin din librăria de norme.
                      </div>
                      <SpecPicker value={projectSpecs} onChange={setProjectSpecs} />
                      {Object.keys(projectSpecs).length > 0 && (
                        <button
                          onClick={() => setProjectSpecs({})}
                          style={{ marginTop: 8, fontSize: 10.5, color: 'hsl(var(--primary))', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        >
                          revino la implicit
                        </button>
                      )}
                    </div>
                  )}
                  {showAdaptBanner && adaptPreview && (
                    <SystemAdaptBanner
                      system={structuralSystem}
                      summary={adaptPreview.summary}
                      onApply={() => setNodes(adaptPreview.nodes)}
                      onDismiss={() => setAdaptDismissedFor(structuralSystem)}
                    />
                  )}
                  {profile !== 'clean' && comparePanelOpen && (
                    <CompareFloatingPanel
                      base={nodes}
                      edges={edges}
                      projectSystem={structuralSystem}
                      projectSpecs={projectSpecs}
                      baseline={scenarioResults.baseline}
                      onClose={() => setComparePanelOpen(false)}
                    />
                  )}
                  {profile !== 'clean' && costPanelOpen && (
                    <CostFloatingPanel nodes={viewNodes} edges={edges} onClose={() => setCostPanelOpen(false)} />
                  )}
                  {profile !== 'clean' && dashboardOpen && (
                    <DashboardPanel
                      result={activeScenarioId ? scenarioResults.byId.get(activeScenarioId) ?? null : scenarioResults.baseline}
                      sourceLabel={activeScenario ? activeScenario.name : 'Baseline'}
                      envelopeMissing={envelopeMissing(viewNodes)}
                      collapsed={dashboardCollapsed}
                      onToggleCollapsed={() => setDashboardCollapsed((v) => !v)}
                      onClose={() => setDashboardOpen(false)}
                    />
                  )}
                  </ErrorBoundary>
                </div>
              </div>
            );
          })()}

          {/* ── Clean shell Inspector (docked properties) ── */}
          {!inspOpen && (
            <button
              type="button"
              className="bb-dock-rail bb-dock-rail-right"
              title="Show inspector"
              aria-label="Show inspector"
              onClick={() => setInspOpen(true)}
            >
              <span>Insp</span>
              <ChevronLeft size={14} strokeWidth={1.85} />
            </button>
          )}
          {inspOpen && (
            <aside className="bb-inspector" style={{ width: inspW }}>
              <div
                className="bb-resize-handle"
                role="separator"
                aria-orientation="vertical"
                aria-label={ro ? 'Lățimea inspectorului — trage, sau săgeți stânga/dreapta' : 'Inspector width — drag, or arrow keys'}
                aria-valuenow={inspW}
                aria-valuemin={240}
                aria-valuemax={720}
                tabIndex={0}
                title={ro ? 'Trage ca să lățești sau să îngustezi · dublu-clic: lățimea implicită' : 'Drag to widen or narrow · double-click: default width'}
                onPointerDown={startInspResize}
                onDoubleClick={() => setInspW(INSP_DEFAULT_W)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') { e.preventDefault(); setInspW((w) => clampInspW(w + 24)); }
                  else if (e.key === 'ArrowRight') { e.preventDefault(); setInspW((w) => clampInspW(w - 24)); }
                }}
              />
              <div className="bb-inspector-head">
                <span>
                  {selectedNodeIds.length > 1
                    ? `Inspector · ${selectedNodeIds.length}`
                    : 'Inspector'}
                </span>
                <button
                  type="button"
                  className="bb-dock-toggle"
                  title="Hide inspector"
                  aria-label="Hide inspector"
                  onClick={() => setInspOpen(false)}
                >
                  <PanelRightClose size={14} strokeWidth={1.75} />
                </button>
              </div>
              <div className="bb-inspector-body">
                {(() => {
                  const bulk = selectedNodeIds.length > 1
                    ? viewNodes.filter((n) => selectedNodeIds.includes(n.id))
                    : undefined;
                  const node = bulk
                    ? (bulk[0] ?? null)
                    : selectedNodeData;
                  if (!node && !bulk) {
                    return (
                      <div className="bb-inspector-empty">
                        {ro ? 'Selectează un element în graf, în plan sau în 3D ca să-i editezi proprietățile.' : 'Select an element in the graph, a plan or the 3D view to edit its properties.'}
                      </div>
                    );
                  }
                  return (
                    <PropertiesPanel
                      node={node}
                      bulkNodes={bulk}
                      onUpdateField={handleViewerUpdateField}
                      onUpdateProp={handleViewerUpdateProp}
                      onUpdateProps={handleViewerUpdateProps}
                      onAddProp={handleViewerAddProp}
                      onDeleteProp={handleViewerDeleteProp}
                      onDuplicateStorey={duplicateStorey}
                      onOpenSectionTab={handleOpenSectionTab}
                      onGenerateRoof={handleGenerateRoof}
                      onGenerateStair={handleGenerateStair}
                      projectSystem={structuralSystem}
                      onRewireGraph={handleRewireGraph}
                    />
                  );
                })()}
              </div>
            </aside>
          )}

          {showProjects && (
            <ProjectsDialog
              currentSlug={useBubbleGraphStore.getState().projectSlug}
              onOpen={handleOpenStoredProject}
              onSaveAs={(name) => { void handleSaveProjectAs(name); setShowProjects(false); }}
              onClose={() => setShowProjects(false)}
            />
          )}

          {/* ── Chat Panel ── */}
          {showChat && (
            <aside className="w-80 border-l border-border flex flex-col flex-shrink-0 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20 flex-shrink-0">
                <span className="text-xs font-semibold">💬 AI Chat — Graph DB</span>
                <button
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => setShowChat(false)}
                  title="Close chat"
                >✕</button>
              </div>
              <ChatPanel className="flex-1 min-h-0" />
            </aside>
          )}

          {newViewInit && (
            <NewViewDialog
              storeys={[...storeyNodes].sort((a, b) => Number(b.properties.bottomElevation ?? 0) - Number(a.properties.bottomElevation ?? 0))}
              views={drawingViews}
              initial={newViewInit}
              showDisciplines={caps.lab}
              onCreate={createDrawingView}
              onDrawSection={() => startPlanSectionTool('draw-section')}
              onClose={() => setNewViewInit(null)}
            />
          )}

          {/* ── Project setup: windows, doors, materials, style, system ── */}
          {showProjectConfig && (
            <ProjectConfigPanel
              title={ro ? 'Configurare proiect' : 'Project setup'}
              closeLabel={ro ? 'Închide' : 'Close'}
              groups={configGroups}
              onClose={() => setShowProjectConfig(false)}
            />
          )}

          {/* ── Object Library Panel ── */}
          {showObjectLibrary && (
            <aside className="w-72 border-l border-border flex flex-col flex-shrink-0 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20 flex-shrink-0">
                <span className="text-xs font-semibold">📦 Object Library</span>
                <button
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => setShowObjectLibrary(false)}
                  title="Close library"
                >✕</button>
              </div>
              <ObjectLibraryPanel onInsert={handleInsertLibraryObject} className="flex-1 min-h-0 overflow-y-auto" />
            </aside>
          )}
        </div>

        <div className="bb-statusbar">
          <span className={`bb-status-dot${saveError ? ' warn' : ''}`} />
          <span><strong>{projectName}</strong></span>
          <span>{ro ? 'Vedere' : 'View'}: <strong>{activeTabLabel}</strong></span>
          <span>{ro ? 'Nivel' : 'Storey'}: <strong>{storeyLabel}</strong></span>
          <span>{ro ? 'Noduri' : 'Nodes'}: <strong>{nodes.length}</strong></span>
          {selectedNodeIds.length > 0 && (
            <span>{ro ? 'Selecție' : 'Selection'}: <strong>{selectedNodeIds.length}</strong></span>
          )}
          <span className="bb-status-spacer" />
          <span>{isSaving ? (ro ? 'Se salvează…' : 'Saving…') : lastSaved ? `${ro ? 'Salvat' : 'Saved'} ${lastSaved.toLocaleTimeString()}` : (ro ? 'Gata' : 'Ready')}</span>
          <span className="bb-status-engine">{openGeoOnly ? 'OpenGeometry' : ({ tiles: 'IFC Tiles', webifc: 'That Open', opengeo: 'OpenGeometry', brep: 'B-rep' } as Record<string, string>)[viewer3DType] ?? viewer3DType}</span>
        </div>
      </div>

      {/* ── Board Scanner Modal ── */}
      {showBoardScanner && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.75)', display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowBoardScanner(false); }}
        >
          <div style={{
            width: '92vw', height: '88vh', borderRadius: 12, overflow: 'hidden',
            background: '#1a1a2e', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 16px', background: '#16213e', borderBottom: '1px solid #0f3460',
            }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: '#eee' }}>
                🎲 Board Game Scanner — Photograph the board, then press “Import into BubbleGraph”
              </span>
              <button
                onClick={() => setShowBoardScanner(false)}
                style={{
                  background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6,
                  padding: '4px 14px', fontSize: 13, cursor: 'pointer', fontWeight: 600,
                }}
              >
                ✕ Close
              </button>
            </div>
            <iframe
              src="/board_game/scanner.html"
              style={{ flex: 1, border: 'none', width: '100%' }}
              allow="camera"
            />
          </div>
        </div>
      )}

      {/* ── Building Axes Dialog ── */}
      {showAxesDialog && (
        <BuildingAxesDialog
          initial={buildingAxes}
          onClose={() => setShowAxesDialog(false)}
          onSave={handleGlobalAxesSave}
        />
      )}

      {/* ── Material Config Editor ── */}
      {showMaterialEditor && (
        <MaterialConfigEditor onClose={() => setShowMaterialEditor(false)} />
      )}

      {/* ── Stil arhitectural: reguli parametrice aplicate grafului ── */}
      {showStyleDialog && (
        <StyleDialog
          nodes={nodes}
          edges={edges}
          onApply={(n, e, summary) => {
            setNodes(n);
            setEdges(e);
            setShowStyleDialog(false);
            toast.success(summary);
          }}
          onClose={() => setShowStyleDialog(false)}
        />
      )}

      {/* ── Librăria: materiale și procese, cu straturile lor ── */}
      {showLibrary && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
          onPointerDown={() => setShowLibrary(false)}
        >
          <div
            className="bg-white dark:bg-zinc-900 border border-border rounded-xl shadow-2xl w-[900px] max-w-[95vw] h-[80vh] flex flex-col overflow-hidden"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
              <span className="font-semibold text-sm">Librărie — materiale și procese</span>
              <button
                type="button"
                className="ml-auto text-muted-foreground hover:text-foreground"
                onClick={() => setShowLibrary(false)}
              >
                ×
              </button>
            </div>
            <LibraryPanel nodes={nodes} edges={edges} />
          </div>
        </div>
      )}

      {/* ── Version History ── */}
      {showHistoryPanel && (
        <HistoryPanel
          onSaveBeforeCommit={performSave}
          onRestore={handleRestoreFromHistory}
          onClose={() => setShowHistoryPanel(false)}
          projectName={projectName}
        />
      )}

      {/* ── Workflow Help Panel ── */}
      {showHelp && <WorkflowHelpPanel onClose={() => setShowHelp(false)} />}

      {/* ── Symbol Config Panel ── */}
      {showSymbolConfig && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-zinc-900 border border-border rounded-xl shadow-2xl w-[680px] max-h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-gray-50 dark:bg-zinc-800 flex-shrink-0">
              <span className="text-sm font-semibold">🔷 2D Symbol Configuration</span>
              <button
                className="text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => setShowSymbolConfig(false)}
                title="Close"
              >✕</button>
            </div>
            <SymbolConfigPanel className="flex-1 overflow-y-auto" />
          </div>
        </div>
      )}

      {/* ── New Storey Dialog ── */}
      {showNewStoreyDialog && (
        <NewStoreyDialog
          buildingAxes={buildingAxes}
          existingNames={storeyNodes.map((s) => s.name)}
          onClose={() => setShowNewStoreyDialog(false)}
          onCreate={handleCreateStorey}
        />
      )}

      {/* ── Edit Storey Dialog ── */}
      {editingStoreyId && (() => {
        const storey = nodes.find((n) => n.id === editingStoreyId);
        return storey ? (
          <EditStoreyDialog
            storey={storey}
            onClose={() => setEditingStoreyId(null)}
            onSave={handleEditStorey}
            onRegenerateAxes={handleRegenerateStoreyAxes}
          />
        ) : null;
      })()}
    </div>
  );
}
