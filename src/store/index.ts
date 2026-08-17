/**
 * Standalone BubbleGraph store.
 *
 * This is a self-contained Zustand store that provides all the state
 * the BubbleGraph panels need, without depending on the full ifc-lite
 * viewer store.
 */

import { create } from 'zustand';

// ─── Types (cloned from viewer's bubbleGraphSlice) ────────────────────────

// ── IFC Plan View ─────────────────────────────────────────────────────────
export interface IFCPlanWall {
  id:            string;
  guid:          string;
  name:          string;
  startPt_mm:    [number, number];
  endPt_mm:      [number, number];
  footprint_mm:  [number, number][];
  thickness_mm:  number;
  height_mm:     number;
  openings:      IFCPlanOpening[];
}

export interface IFCPlanOpening {
  type:                string;
  name:                string;
  width_mm:            number;
  height_mm:           number;
  sillHeight_mm:       number;
  offsetAlongWall_mm:  number;
}

export interface IFCPlanSlab {
  id:               string;
  guid:             string;
  name:             string;
  /** N-point footprint polygon in plan (mm) */
  footprint_mm:     [number, number][];
  thickness_mm:     number;
  /** World Z of the slab's bottom face (mm) */
  baseElevation_mm: number;
}

export interface IFCPlanStorey {
  id:            string;
  name:          string;
  elevation_mm:  number;
  height_mm:     number;
  walls:         IFCPlanWall[];
  slabs:         IFCPlanSlab[];
  axesX_mm:      number[];
  axesY_mm:      number[];
}

export interface IFCPlanData {
  fileKey:     string;
  storeys:     IFCPlanStorey[];
  worldBounds: { minX_mm: number; minY_mm: number; maxX_mm: number; maxY_mm: number };
  totalWalls:  number;
  totalSlabs:  number;
}

// ── Rig System ────────────────────────────────────────────────────────────
/** A single rig control axis — a draggable line in the IFC plan. */
export interface RigAxis {
  id:          string;
  dir:         'X' | 'Y';   // 'X' = vertical line (constant X), 'Y' = horizontal line
  positionMm:  number;       // world coordinate in mm
  label:       string;       // e.g. "1", "A"
  /** Original position when rig was generated — used to compute delta for back-projection */
  originMm:    number;
}

export interface RigState {
  axes:      RigAxis[];
  storeyId:  string | null;  // which IFC storey this rig was built for
}


export interface BubbleGraphNode {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  z: number;
  properties: Record<string, unknown>;
  locked?: boolean;
  parentId?: string;
}

export interface BubbleGraphEdge {
  id: string;
  from: string;
  to: string;
  fromGrip?: number; // 0-8: grip index on ax 'from' node (0=center, default)
  toGrip?: number;   // 0-8: grip index on ax 'to' node (0=center, default)
}

export interface BuildingAxes {
  xValues: number[];
  yValues: number[];
}

/** Geographic placement of the BIM model on the globe. */
export interface WorldLocation {
  lat: number;
  lng: number;
  alt: number;       // metres above ellipsoid
  offsetE: number;   // additional East offset in metres (ENU)
  offsetN: number;   // additional North offset in metres (ENU)
  offsetZ: number;   // additional vertical offset in metres
  rotation: number;  // heading/yaw in degrees (0 = North, CW)
}

export const DEFAULT_WORLD_LOCATION: WorldLocation = {
  lat: 44.4268, lng: 26.1025, alt: 0,
  offsetE: 0, offsetN: 0, offsetZ: 0,
  rotation: 0,
};

/** An imported BIM model placed on the globe with its own geo-position. */
export interface GlobeInstance {
  id: string;
  name: string;
  location: WorldLocation;
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  visible: boolean;
}

export type StoreyDiscipline = 'architectural' | 'structural' | 'mep';

// ─── Drawing Annotations ──────────────────────────────────────────────────

export interface AnnPt { x: number; y: number; }

interface AnnBase {
  id: string;
  viewId: string;   // storey id (floor plan) or viewType:storeyId (section/elevation)
  color?: string;
  lineWeight?: number;
}

export type HatchPatternId =
  | 'diagonal' | 'crosshatch' | 'dots' | 'solid' | 'none'
  | 'concrete' | 'brick' | 'stone' | 'wave'
  | 'wood' | 'insulation' | 'earth' | 'steel' | 'glass' | 'sand';

export interface TextAnn     extends AnnBase { kind: 'text';      x: number;     y: number;      text: string; fontSize?: number; rotation?: number; bold?: boolean; }
export interface DimAnn      extends AnnBase { kind: 'dimension'; p1: AnnPt;     p2: AnnPt;      offsetDir: number; textOverride?: string; }
export interface LeaderAnn   extends AnnBase { kind: 'leader';    points: AnnPt[]; text: string; fontSize?: number; }
export interface LineAnn     extends AnnBase { kind: 'line';      p1: AnnPt;     p2: AnnPt;      dashed?: boolean; strokeStyle?: 'solid' | 'dashed' | 'dotted'; }
export interface ArcAnn      extends AnnBase { kind: 'arc';       cx: number;    cy: number;     radius: number; startAngle: number; endAngle: number; }
export interface PolylineAnn extends AnnBase { kind: 'polyline';  points: AnnPt[]; closed?: boolean; fill?: string; fillOpacity?: number; strokeStyle?: 'solid' | 'dashed' | 'dotted'; }
export interface HatchAnn    extends AnnBase { kind: 'hatch';     points: AnnPt[]; pattern?: HatchPatternId; fillColor?: string; fillOpacity?: number; hatchSpacing?: number; hatchAngle?: number; }
export interface RectAnn     extends AnnBase { kind: 'rect';      x: number; y: number; width: number; height: number; rotation?: number; fill?: string; fillOpacity?: number; strokeStyle?: 'solid' | 'dashed' | 'dotted'; }
export interface CircleAnn   extends AnnBase { kind: 'circle';    cx: number; cy: number; radius: number; fill?: string; fillOpacity?: number; strokeStyle?: 'solid' | 'dashed' | 'dotted'; }

export type DrawingAnnotation = TextAnn | DimAnn | LeaderAnn | LineAnn | ArcAnn | PolylineAnn | HatchAnn | RectAnn | CircleAnn;

export interface FlowNode {
  id: string;
  type?: string;
  data: Record<string, unknown>;
}

export interface ViewDefinition {
  id: string;
  name: string;
  type: 'floorplan' | 'section' | 'elevation' | 'custom';
  storeyId?: string;
}

// ─── View Tabs (multi-viewer tab system) ──────────────────────────────────

export type ViewTabType =
  | 'graph-editor'
  | '3d-model'
  | 'opengeo-3d'
  | 'opengeo-floorplan'
  | 'opengeo-section'
  | 'opengeo-elevation'
  | 'floorplan'
  | 'section'
  | 'elevation'
  | 'table'
  | 'report'
  | 'sheet'
  | 'worldview'
  | 'ifc-plan'
  | 'terrain'
  | 'ifc-tiles'
  | 'fem'
  | 'composer';

export interface ViewTab {
  id: string;
  label: string;
  type: ViewTabType;
  /** Storey node id this view is associated with */
  storeyId?: string;
  discipline?: StoreyDiscipline;
  /** Arbitrary extra data (e.g. blob URLs) */
  params?: Record<string, unknown>;
  canClose: boolean;
}

// ─── Store interface ──────────────────────────────────────────────────────

/**
 * Viewer3DType — selects which 3D rendering engine to use for 3d-model tabs.
 *
 * - 'babylon':  Babylon.js – full-featured, optimized for large scenes
 * - 'ara3d':    Three.js (raw) – lighter alternative
 * - 'webifc':   That Open Components (OBC) – Three.js-based, IFC hierarchy
 * - 'opengeo':  OpenGeometry WASM kernel – boolean-ready, IFC/STEP/STL export
 * - 'brep':     Internal B-rep kernel – diagnostic view that renders the new
 *               kernel against the OpenGeometry output for comparison
 *
 * Switch is instant and persistent (stored in Zustand).
 * All viewers use the same geometry calculations (bimGeometry.ts).
 */
export type Viewer3DType = 'ara3d' | 'webifc' | 'opengeo' | 'brep';

// ─── Composer (RoomX) Types ───────────────────────────────────────────────

export type RoomXEdgeType = 'edge' | 'wall' | 'beam';

export interface RoomXVertex {
  localIndex: number;       // 0..n, unique within the shape
  x: number;               // mm, absolute world coordinate
  y: number;               // mm
  merged?: boolean;         // true if merged with another shape's vertex
  mergedWithShapeId?: string;
  mergedWithLocalIndex?: number;
  properties: RoomXVertexProps; // ax-node-like properties
}

export interface RoomXVertexProps {
  has_column: boolean;
  column_type: string;       // "C25x25", "CR30", etc. (cm notation)
  offsetX: number;           // mm, horizontal X offset
  offsetY: number;           // mm, horizontal Y offset
  offsetBase: number;        // mm, vertical offset from storey base
  offsetTop: number;         // mm, vertical offset from storey top
  label: string;             // display name for axis
  material: string;          // material ID
  color_3d: string;          // hex color override for 3D
  color_2d: string;          // hex color override for 2D
}

export interface RoomXEdgeConfig {
  from: number;             // localIndex of start vertex
  to: number;              // localIndex of end vertex
  type: RoomXEdgeType;
  has_wall: boolean;
  has_beam: boolean;
  has_window: boolean;
  has_door: boolean;
  wallConfig?: { thickness: number; height: number; material: string };
  beamConfig?: { width: number; height: number; material: string };
  windowConfig?: { window_type: string; sill_height: number; wall_offset: number; count: number; spacing: number };
  doorConfig?: { door_type: string; wall_offset: number; count: number };
}

export interface RoomXShape {
  id: string;
  name: string;
  templateId: string;       // shape template type (rect-4x4, l-shape, etc.)
  fillColor: string;        // hex color
  fillOpacity: number;      // 0..1
  originX: number;          // mm, bottom-left anchor X
  originY: number;          // mm, bottom-left anchor Y
  dimensions: Record<string, number>; // parametric dimensions in mm (width, depth, etc.)
  dragStep: number;         // mm, snap step for edge dragging (default 100)
  vertices: RoomXVertex[];
  edges: RoomXEdgeConfig[];
  storeyId: string | null;
  zOrder: number;           // lower = placed first (FCFS priority)
  createdAt: number;        // timestamp for FCFS ordering
}

export interface ComposerState {
  shapes: RoomXShape[];
  selectedShapeId: string | null;
  selectedVertexIndex: number | null;  // within selected shape
  selectedEdgeIndex: number | null;    // within selected shape
  snapThreshold: number;               // mm (default 50)
  gridVisible: boolean;
  snapEnabled: boolean;
}

export interface BubbleGraphStore {
  // BubbleGraph state
  bubbleGraphNodes: BubbleGraphNode[];
  bubbleGraphEdges: BubbleGraphEdge[];
  bubbleGraphPanelVisible: boolean;
  buildingAxes: BuildingAxes;
  activeStoreyId: string | null;

  // ReactFlow node snapshots
  flowNodes: FlowNode[];
  setFlowNodes: (nodes: FlowNode[]) => void;

  // nodeId → IFC expressId(s)
  nodeExprIds: Map<string, number[]>;
  setNodeExprIds: (map: Map<string, number[]>) => void;

  // External node data updater (wired from NodeEditor if present)
  updateFlowNodeData: ((nodeId: string, data: Record<string, unknown>) => void) | null;
  registerFlowNodeDataUpdater: (fn: ((nodeId: string, data: Record<string, unknown>) => void) | null) => void;

  // View definitions (floor-plan views generated from storeys)
  views: ViewDefinition[];
  addView: (view: ViewDefinition) => void;
  removeView: (id: string) => void;
  activeViewId: string | null;
  setActiveViewId: (id: string | null) => void;

  // ── Multi-viewer tab system ────────────────────────────────────────────
  viewTabs: ViewTab[];
  activeTabId: string;
  addViewTab: (tab: Omit<ViewTab, 'id'>) => string;
  closeViewTab: (id: string) => void;
  renameViewTab: (id: string, label: string) => void;
  updateViewTabParams: (id: string, params: Record<string, unknown>) => void;
  setActiveTabId: (id: string) => void;

  // ── 3D Viewer selection ────────────────────────────────────────────────
  viewer3DType: Viewer3DType;
  setViewer3DType: (type: Viewer3DType) => void;

  // ── IFC Plan View data ────────────────────────────────────────────────
  ifcPlanData: IFCPlanData | null;
  setIfcPlanData: (data: IFCPlanData | null) => void;

  // ── Rig system ────────────────────────────────────────────────────────
  rigState: RigState;
  setRigAxes: (axes: RigAxis[]) => void;
  updateRigAxis: (id: string, positionMm: number) => void;
  clearRig: () => void;

  // ── 3D element selection ──────────────────────────────────────────────
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;

  // ── Multi-selection (filter by type) ─────────────────────────────────
  selectedNodeIds: string[];
  setSelectedNodeIds: (ids: string[]) => void;

  // ── Drawing annotations (persistent, per-view) ────────────────────────
  annotations: DrawingAnnotation[];
  selectedAnnotationId: string | null;
  addAnnotation:        (a: DrawingAnnotation) => void;
  updateAnnotation:     (id: string, updates: Partial<DrawingAnnotation>) => void;
  deleteAnnotation:     (id: string) => void;
  clearViewAnnotations: (viewId: string) => void;
  setAnnotations:       (anns: DrawingAnnotation[]) => void;
  selectAnnotation:     (id: string | null) => void;

  // ── Plan authoring tools (floor-plan section / wall) ───────────────────
  /** Active plan tool: draw-section (2-click) | section-on-axis (click grid line) */
  planTool: 'draw-section' | 'section-on-axis' | null;
  setPlanTool: (tool: 'draw-section' | 'section-on-axis' | null) => void;
  /** Set by plan viewer after creating a section; BubbleGraphPanel opens the tab then clears. */
  pendingOpenSectionId: string | null;
  setPendingOpenSectionId: (id: string | null) => void;

  // Actions
  setBubbleGraph: (nodes: BubbleGraphNode[], edges: BubbleGraphEdge[]) => void;
  setBubbleGraphPanelVisible: (visible: boolean) => void;
  toggleBubbleGraphPanel: () => void;
  setBuildingAxes: (axes: BuildingAxes) => void;
  setActiveStoreyId: (id: string | null) => void;
  worldLocation: WorldLocation;
  setWorldLocation: (loc: WorldLocation) => void;

  // ── Globe instances (imported .bbim models placed on the globe) ────────
  globeInstances: GlobeInstance[];
  addGlobeInstance: (inst: GlobeInstance) => void;
  updateGlobeInstance: (id: string, patch: Partial<GlobeInstance>) => void;
  removeGlobeInstance: (id: string) => void;
  setGlobeInstances: (insts: GlobeInstance[]) => void;

  /**
   * Move a single axis value on a storey node.
   */
  updateStoreyAxes: (storeyId: string, dir: 'X' | 'Y', index: number, newMm: number) => void;

  /** Bulk-restore the entire view state (used by project file open). */
  restoreViewState: (viewTabs: ViewTab[], activeTabId: string, viewer3DType: Viewer3DType) => void;

  // ── Composer (RoomX) ──────────────────────────────────────────────────
  composer: ComposerState;
  composerAddShape: (shape: RoomXShape) => void;
  composerRemoveShape: (id: string) => void;
  composerUpdateShape: (id: string, patch: Partial<RoomXShape>) => void;
  composerSetSelectedShape: (id: string | null) => void;
  composerSetSelectedVertex: (index: number | null) => void;
  composerSetSelectedEdge: (index: number | null) => void;
  composerMoveShape: (id: string, dx: number, dy: number) => void;
  composerMoveVertex: (shapeId: string, localIndex: number, x: number, y: number) => void;
  composerSetSnapEnabled: (enabled: boolean) => void;
  composerSetSnapThreshold: (mm: number) => void;
  composerSetGridVisible: (visible: boolean) => void;
  composerSetShapes: (shapes: RoomXShape[]) => void;
}

// ─── Unique ID generator ──────────────────────────────────────────────────

let _viewCounter = 0;
export function newViewId(): string {
  return `view-${Date.now()}-${_viewCounter++}`;
}

// ─── Store ────────────────────────────────────────────────────────────────

export const useBubbleGraphStore = create<BubbleGraphStore>()((set) => ({
  bubbleGraphNodes: [],
  bubbleGraphEdges: [],
  bubbleGraphPanelVisible: true,
  buildingAxes: { xValues: [], yValues: [] },
  activeStoreyId: null,
  worldLocation: { ...DEFAULT_WORLD_LOCATION },

  flowNodes: [],
  setFlowNodes: (nodes) => set({ flowNodes: nodes }),
  nodeExprIds: new Map(),
  setNodeExprIds: (map) => set({ nodeExprIds: map }),
  updateFlowNodeData: null,
  registerFlowNodeDataUpdater: (fn) => set({ updateFlowNodeData: fn }),

  views: [],
  addView: (view) => set((s) => ({ views: [...s.views, view] })),
  removeView: (id) => set((s) => ({ views: s.views.filter((v) => v.id !== id) })),
  activeViewId: null,
  setActiveViewId: (id) => set({ activeViewId: id }),

  // ── Multi-viewer tab system ────────────────────────────────────────────
  viewTabs: [{ id: 'graph-editor', label: 'My Building', type: 'graph-editor', canClose: false }],
  activeTabId: 'graph-editor',
  addViewTab: (tab) => {
    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set((s) => ({ viewTabs: [...s.viewTabs, { ...tab, id }], activeTabId: id }));
    return id;
  },
  closeViewTab: (id) => set((s) => {
    const tab = s.viewTabs.find((t) => t.id === id);
    // Revoke blob URLs only if no other tab shares the same URL
    if (tab?.params?.ifcUrl && typeof tab.params.ifcUrl === 'string') {
      const url = tab.params.ifcUrl as string;
      const isShared = s.viewTabs.some((t) => t.id !== id && t.params?.ifcUrl === url);
      if (!isShared) try { URL.revokeObjectURL(url); } catch { /* ok */ }
    }
    const remaining = s.viewTabs.filter((t) => t.id !== id);
    const newActive = s.activeTabId === id
      ? (remaining[remaining.length - 1]?.id ?? 'graph-editor')
      : s.activeTabId;
    return { viewTabs: remaining, activeTabId: newActive };
  }),
  renameViewTab: (id, label) => set((s) => ({
    viewTabs: s.viewTabs.map((t) => t.id === id ? { ...t, label } : t),
  })),
  updateViewTabParams: (id, params) => set((s) => ({
    viewTabs: s.viewTabs.map((t) =>
      t.id === id ? { ...t, params: { ...t.params, ...params } } : t,
    ),
  })),
  setActiveTabId: (id) => set({ activeTabId: id }),

  // ── 3D Viewer selection ────────────────────────────────────────────────
  viewer3DType: 'ara3d',
  setViewer3DType: (type) => set({ viewer3DType: type }),

  // ── IFC Plan View data ────────────────────────────────────────────────
  ifcPlanData: null,
  setIfcPlanData: (data) => set({ ifcPlanData: data }),

  // ── Rig system ────────────────────────────────────────────────────────
  rigState: { axes: [], storeyId: null },
  setRigAxes: (axes) => set((s) => ({ rigState: { ...s.rigState, axes } })),
  updateRigAxis: (id, positionMm) => set((s) => ({
    rigState: {
      ...s.rigState,
      axes: s.rigState.axes.map((a) => a.id === id ? { ...a, positionMm } : a),
    },
  })),
  clearRig: () => set({ rigState: { axes: [], storeyId: null } }),

  // ── 3D element selection ──────────────────────────────────────────────
  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  selectedNodeIds: [],
  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

  annotations: [],
  selectedAnnotationId: null,
  addAnnotation:        (a)      => set((s) => ({ annotations: [...s.annotations, a] })),
  updateAnnotation:     (id, u)  => set((s) => ({ annotations: s.annotations.map((a) => a.id === id ? { ...a, ...u } as DrawingAnnotation : a) })),
  deleteAnnotation:     (id)     => set((s) => ({ annotations: s.annotations.filter((a) => a.id !== id), selectedAnnotationId: s.selectedAnnotationId === id ? null : s.selectedAnnotationId })),
  clearViewAnnotations: (vId)    => set((s) => ({ annotations: s.annotations.filter((a) => a.viewId !== vId), selectedAnnotationId: null })),
  setAnnotations:       (anns)   => set({ annotations: anns }),
  selectAnnotation:     (id)     => set({ selectedAnnotationId: id }),

  planTool: null,
  setPlanTool: (tool) => set({ planTool: tool }),
  pendingOpenSectionId: null,
  setPendingOpenSectionId: (id) => set({ pendingOpenSectionId: id }),

  setBubbleGraph: (nodes, edges) => set({ bubbleGraphNodes: nodes, bubbleGraphEdges: edges }),
  setBubbleGraphPanelVisible: (visible) => set({ bubbleGraphPanelVisible: visible }),
  toggleBubbleGraphPanel: () =>
    set((s) => ({ bubbleGraphPanelVisible: !s.bubbleGraphPanelVisible })),
  setBuildingAxes: (axes) => set({ buildingAxes: axes }),
  setActiveStoreyId: (id) => set({ activeStoreyId: id }),
  setWorldLocation: (loc) => set({ worldLocation: loc }),

  globeInstances: [],
  addGlobeInstance: (inst) => set((s) => ({ globeInstances: [...s.globeInstances, inst] })),
  updateGlobeInstance: (id, patch) => set((s) => ({
    globeInstances: s.globeInstances.map((g) => g.id === id ? { ...g, ...patch } : g),
  })),
  removeGlobeInstance: (id) => set((s) => ({
    globeInstances: s.globeInstances.filter((g) => g.id !== id),
  })),
  setGlobeInstances: (insts) => set({ globeInstances: insts }),

  updateStoreyAxes: (storeyId, dir, index, newMm) =>
    set((s) => {
      const MIN_GAP = 10;
      const key = dir === 'X' ? 'axesX' : 'axesY';
      const updatedNodes = s.bubbleGraphNodes.map((n) => {
        if (n.id !== storeyId || n.type !== 'storey') return n;
        const axes = [...((n.properties[key] as number[]) ?? [])];
        if (index < 0 || index >= axes.length) return n;
        // Clamp between neighbours so sorted order is preserved
        const lo = index > 0               ? axes[index - 1] + MIN_GAP : -Infinity;
        const hi = index < axes.length - 1 ? axes[index + 1] - MIN_GAP :  Infinity;
        axes[index] = Math.round(Math.min(hi, Math.max(lo, newMm)));
        return { ...n, properties: { ...n.properties, [key]: axes } };
      });
      return { bubbleGraphNodes: updatedNodes };
    }),

  restoreViewState: (viewTabs, activeTabId, viewer3DType) => set({
    viewTabs,
    activeTabId,
    viewer3DType,
    selectedNodeId: null,
    selectedNodeIds: [],
  }),

  // ── Composer (RoomX) ──────────────────────────────────────────────────
  composer: {
    shapes: [],
    selectedShapeId: null,
    selectedVertexIndex: null,
    selectedEdgeIndex: null,
    snapThreshold: 50,
    gridVisible: true,
    snapEnabled: true,
  },
  composerAddShape: (shape) => set((s) => ({
    composer: { ...s.composer, shapes: [...s.composer.shapes, shape] },
  })),
  composerRemoveShape: (id) => set((s) => ({
    composer: {
      ...s.composer,
      shapes: s.composer.shapes.filter((sh) => sh.id !== id),
      selectedShapeId: s.composer.selectedShapeId === id ? null : s.composer.selectedShapeId,
    },
  })),
  composerUpdateShape: (id, patch) => set((s) => ({
    composer: {
      ...s.composer,
      shapes: s.composer.shapes.map((sh) => sh.id === id ? { ...sh, ...patch } : sh),
    },
  })),
  composerSetSelectedShape: (id) => set((s) => ({
    composer: { ...s.composer, selectedShapeId: id, selectedVertexIndex: null, selectedEdgeIndex: null },
  })),
  composerSetSelectedVertex: (index) => set((s) => ({
    composer: { ...s.composer, selectedVertexIndex: index, selectedEdgeIndex: null },
  })),
  composerSetSelectedEdge: (index) => set((s) => ({
    composer: { ...s.composer, selectedEdgeIndex: index, selectedVertexIndex: null },
  })),
  composerMoveShape: (id, dx, dy) => set((s) => ({
    composer: {
      ...s.composer,
      shapes: s.composer.shapes.map((sh) =>
        sh.id === id
          ? {
              ...sh,
              originX: sh.originX + dx,
              originY: sh.originY + dy,
              vertices: sh.vertices.map((v) => ({ ...v, x: v.x + dx, y: v.y + dy })),
            }
          : sh
      ),
    },
  })),
  composerMoveVertex: (shapeId, localIndex, x, y) => set((s) => ({
    composer: {
      ...s.composer,
      shapes: s.composer.shapes.map((sh) =>
        sh.id === shapeId
          ? { ...sh, vertices: sh.vertices.map((v) => v.localIndex === localIndex ? { ...v, x, y } : v) }
          : sh
      ),
    },
  })),
  composerSetSnapEnabled: (enabled) => set((s) => ({
    composer: { ...s.composer, snapEnabled: enabled },
  })),
  composerSetSnapThreshold: (mm) => set((s) => ({
    composer: { ...s.composer, snapThreshold: mm },
  })),
  composerSetGridVisible: (visible) => set((s) => ({
    composer: { ...s.composer, gridVisible: visible },
  })),
  composerSetShapes: (shapes) => set((s) => ({
    composer: { ...s.composer, shapes },
  })),
}));
