/**
 * ComposerCanvas — RoomX polygon composition editor.
 *
 * Features:
 * - Place predefined polygon shapes (RoomX)
 * - Dimensions controlled from properties panel (parametric)
 * - Edge (side) dragging with configurable step snapping
 * - Edge type configuration (edge / wall / beam)
 * - Vertex merge (FCFS) when within snapThreshold
 * - Properties panel for selected shape / edge dimensions
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBubbleGraphStore } from '@/store';
import type { RoomXShape, RoomXVertex, RoomXVertexProps, RoomXEdgeConfig, RoomXEdgeType } from '@/store';
import { syncComposerToGraph, detectMergedVertices } from '@/lib/composerSync';
import { clientToSvgUserPoint } from '@/lib/svgCoordinates';
import { WINDOW_TYPES, DOOR_TYPES } from '@/lib/elementLibrary';

// ─── Parametric Shape Templates ───────────────────────────────────────────

interface ShapeTemplateDef {
  id: string;
  label: string;
  icon: string;
  defaultDimensions: Record<string, number>; // mm
  dimensionLabels: Record<string, string>;   // human-readable label
  /** Compute local vertices (relative to origin 0,0) from dimensions. */
  computeVertices: (dims: Record<string, number>) => [number, number][];
  /** Map: edgeIndex → dragging behaviour. moveOrigin=true for edges touching originX/Y. */
  edgeDimensionMap: (dims: Record<string, number>) => Map<number, {
    dim: string; sign: number; axis: 'x' | 'y';
    moveOrigin?: boolean; // if true, shift origin so the OPPOSITE edge stays fixed
  }>;
}

const SHAPE_TEMPLATES: ShapeTemplateDef[] = [
  {
    id: 'rect-4x4',
    label: 'Rectangle 4×4m',
    icon: '▭',
    defaultDimensions: { width: 4000, depth: 4000 },
    dimensionLabels: { width: 'Width (X)', depth: 'Depth (Y)' },
    computeVertices: (d) => [[0, 0], [d.width, 0], [d.width, d.depth], [0, d.depth]],
    // rect vertices: V0=top-left, V1=top-right, V2=bottom-right, V3=bottom-left (SVG Y-down)
    // Edge 0 (V0→V1) = TOP   — touches originY → moveOrigin
    // Edge 1 (V1→V2) = RIGHT — far from origin ✓
    // Edge 2 (V2→V3) = BOTTOM— far from origin ✓
    // Edge 3 (V3→V0) = LEFT  — touches originX → moveOrigin
    edgeDimensionMap: () => new Map([
      [0, { dim: 'depth', sign: -1, axis: 'y' as const, moveOrigin: true }],
      [1, { dim: 'width', sign:  1, axis: 'x' as const }],
      [2, { dim: 'depth', sign:  1, axis: 'y' as const }],
      [3, { dim: 'width', sign: -1, axis: 'x' as const, moveOrigin: true }],
    ]),
  },
  {
    id: 'rect-6x4',
    label: 'Rectangle 6×4m',
    icon: '▭',
    defaultDimensions: { width: 6000, depth: 4000 },
    dimensionLabels: { width: 'Width (X)', depth: 'Depth (Y)' },
    computeVertices: (d) => [[0, 0], [d.width, 0], [d.width, d.depth], [0, d.depth]],
    edgeDimensionMap: () => new Map([
      [0, { dim: 'depth', sign: -1, axis: 'y' as const, moveOrigin: true }],
      [1, { dim: 'width', sign:  1, axis: 'x' as const }],
      [2, { dim: 'depth', sign:  1, axis: 'y' as const }],
      [3, { dim: 'width', sign: -1, axis: 'x' as const, moveOrigin: true }],
    ]),
  },
  {
    id: 'l-shape',
    label: 'L-Shape',
    icon: '⌐',
    defaultDimensions: { totalWidth: 6000, totalDepth: 6000, armWidth: 3000, armDepth: 3000 },
    dimensionLabels: { totalWidth: 'Total Width', totalDepth: 'Total Depth', armWidth: 'Arm Width', armDepth: 'Arm Depth' },
    computeVertices: (d) => [
      [0, 0], [d.totalWidth, 0], [d.totalWidth, d.armDepth],
      [d.armWidth, d.armDepth], [d.armWidth, d.totalDepth], [0, d.totalDepth],
    ],
    // L-shape: Edge 0 = TOP (Y=0, touches originY), Edge 5 = LEFT (X=0, touches originX)
    edgeDimensionMap: () => new Map([
      [0, { dim: 'totalDepth', sign: -1, axis: 'y' as const, moveOrigin: true }],  // top edge
      [1, { dim: 'totalWidth', sign:  1, axis: 'x' as const }],                   // right far edge
      [2, { dim: 'armDepth',   sign:  1, axis: 'y' as const }],                   // inner step down
      [3, { dim: 'armWidth',   sign:  1, axis: 'x' as const }],                   // inner step right
      [4, { dim: 'totalDepth', sign:  1, axis: 'y' as const }],                   // bottom far edge
      [5, { dim: 'totalWidth', sign: -1, axis: 'x' as const, moveOrigin: true }], // left edge
    ]),
  },
  {
    id: 't-shape',
    label: 'T-Shape',
    icon: '⊤',
    defaultDimensions: { totalWidth: 8000, topDepth: 3000, armWidth: 2000, armDepth: 3000 },
    dimensionLabels: { totalWidth: 'Total Width', topDepth: 'Top Depth', armWidth: 'Arm Width', armDepth: 'Arm Depth' },
    computeVertices: (d) => {
      const armLeft = (d.totalWidth - d.armWidth) / 2;
      const armRight = armLeft + d.armWidth;
      return [
        [0, 0], [d.totalWidth, 0], [d.totalWidth, d.topDepth],
        [armRight, d.topDepth], [armRight, d.topDepth + d.armDepth],
        [armLeft, d.topDepth + d.armDepth], [armLeft, d.topDepth], [0, d.topDepth],
      ];
    },
    // T-shape: Edge 0 = TOP, Edge 7 = LEFT — both touch origin
    edgeDimensionMap: () => new Map([
      [0, { dim: 'topDepth',   sign: -1, axis: 'y' as const, moveOrigin: true }], // top edge
      [1, { dim: 'totalWidth', sign:  1, axis: 'x' as const }],                  // right edge
      [2, { dim: 'topDepth',   sign:  1, axis: 'y' as const }],                  // right inner step
      [4, { dim: 'armDepth',   sign:  1, axis: 'y' as const }],                  // arm bottom
      [7, { dim: 'totalWidth', sign: -1, axis: 'x' as const, moveOrigin: true }], // left edge
    ]),
  },
  {
    id: 'triangle',
    label: 'Triangle',
    icon: '△',
    defaultDimensions: { base: 4000, height: 3464 },
    dimensionLabels: { base: 'Base (X)', height: 'Height (Y)' },
    computeVertices: (d) => [[0, 0], [d.base, 0], [d.base / 2, d.height]],
    edgeDimensionMap: () => new Map([
      [0, { dim: 'height', sign: -1, axis: 'y' as const, moveOrigin: true }], // base (top) edge
      [2, { dim: 'height', sign:  1, axis: 'y' as const }],                   // apex slant
    ]),
  },
];

/** Compute vertices from template + dimensions + origin. */
const DEFAULT_VERTEX_PROPS: RoomXVertexProps = {
  has_column: true,
  column_type: 'C25x25',
  offsetX: 0,
  offsetY: 0,
  offsetBase: 0,
  offsetTop: 0,
  label: '',
  material: '',
  color_3d: '',
  color_2d: '',
};

function computeShapeVertices(templateId: string, dims: Record<string, number>, originX: number, originY: number): RoomXVertex[] {
  const tpl = SHAPE_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return [];
  const local = tpl.computeVertices(dims);
  return local.map(([lx, ly], i) => ({ localIndex: i, x: originX + lx, y: originY + ly, properties: { ...DEFAULT_VERTEX_PROPS } }));
}

const DEFAULT_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
let _colorIdx = 0;
function nextColor(): string {
  return DEFAULT_COLORS[_colorIdx++ % DEFAULT_COLORS.length];
}

const ROOM_NAMES = [
  'Living Room', 'Master Bedroom', 'Bedroom', 'Kitchen',
  'Bathroom', 'Hallway', 'Office', 'Dining Room',
  'Guest Room', 'Laundry', 'Storage', 'Garage',
];
let _roomIdx = 0;
function nextRoomName(): string {
  return ROOM_NAMES[_roomIdx++ % ROOM_NAMES.length];
}

/** Returns a compact dimension string from the shape's bounding box. */
function shapeDimString(shape: RoomXShape): string {
  if (shape.vertices.length === 0) return '';
  const xs = shape.vertices.map((v) => v.x);
  const ys = shape.vertices.map((v) => v.y);
  const w = (Math.max(...xs) - Math.min(...xs)) / 1000;
  const d = (Math.max(...ys) - Math.min(...ys)) / 1000;
  return `${w.toFixed(1)} × ${d.toFixed(1)} m`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function uid(): string {
  return `rx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const DEFAULT_WALL_CFG = { thickness: 200, height: 3000, material: 'concrete' } as const;
const DEFAULT_BEAM_CFG = { width: 300, height: 600, material: 'concrete' } as const;
const DEFAULT_WIN_CFG  = { window_type: 'W-DBL-120x140', sill_height: 900, wall_offset: 0, count: 1, spacing: 0 } as const;
const DEFAULT_DOOR_CFG = { door_type: 'D-SWING-90x210', wall_offset: 0, count: 1 } as const;

/** Create edges connecting each vertex to the next (closed polygon). */
function makeClosedEdges(vertexCount: number): RoomXEdgeConfig[] {
  const edges: RoomXEdgeConfig[] = [];
  for (let i = 0; i < vertexCount; i++) {
    edges.push({
      from: i, to: (i + 1) % vertexCount, type: 'wall',
      has_wall: true, has_beam: true, has_window: false, has_door: false,
      wallConfig: { ...DEFAULT_WALL_CFG },
      beamConfig: { ...DEFAULT_BEAM_CFG },
    });
  }
  return edges;
}

const WALL_MATERIALS = ['concrete', 'brick', 'wood', 'gypsum', 'glass', 'steel', 'aerated_concrete', 'stone'] as const;
const BEAM_MATERIALS = ['concrete', 'steel', 'wood', 'composite'] as const;

/** Snap a value to a step grid. */
function snapToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

/** Project a point onto a line segment and return the distance along the line's normal axis. */
function projectOnEdge(
  pt: { x: number; y: number },
  v1: { x: number; y: number },
  v2: { x: number; y: number },
  axis: 'x' | 'y',
): number {
  return axis === 'x' ? pt.x : pt.y;
}

// ─── Constants ────────────────────────────────────────────────────────────

const VERTEX_RADIUS = 6;    // px
const GRID_STEP_MM = 1000;  // 1m grid

// ─── Component ────────────────────────────────────────────────────────────

export function ComposerCanvas() {
  const composer          = useBubbleGraphStore((s) => s.composer);
  const addShape          = useBubbleGraphStore((s) => s.composerAddShape);
  const removeShape       = useBubbleGraphStore((s) => s.composerRemoveShape);
  const updateShape       = useBubbleGraphStore((s) => s.composerUpdateShape);
  const setSelectedShape  = useBubbleGraphStore((s) => s.composerSetSelectedShape);
  const setSelectedVertex = useBubbleGraphStore((s) => s.composerSetSelectedVertex);
  const setSelectedEdge   = useBubbleGraphStore((s) => s.composerSetSelectedEdge);
  const moveShape         = useBubbleGraphStore((s) => s.composerMoveShape);
  const setSnapEnabled    = useBubbleGraphStore((s) => s.composerSetSnapEnabled);
  const setGridVisible    = useBubbleGraphStore((s) => s.composerSetGridVisible);
  const setBubbleGraph    = useBubbleGraphStore((s) => s.setBubbleGraph);
  const activeStoreyId    = useBubbleGraphStore((s) => s.activeStoreyId);

  const { shapes, selectedShapeId, selectedVertexIndex, selectedEdgeIndex, snapThreshold, gridVisible, snapEnabled } = composer;

  // ── Merge detection (recompute on every shape change) ─────────────────
  const mergedVertices = useMemo(() => detectMergedVertices(shapes, snapThreshold), [shapes, snapThreshold]);

  // ── Sync to BubbleGraph (debounced) ───────────────────────────────────
  useEffect(() => {
    if (shapes.length === 0) return;
    const timer = setTimeout(() => {
      const result = syncComposerToGraph(shapes, activeStoreyId, snapThreshold);
      const store = useBubbleGraphStore.getState();
      const existingNodes = store.bubbleGraphNodes.filter((n) => !(n.properties?.composerSource));
      const existingEdges = store.bubbleGraphEdges.filter((e) => !e.id.startsWith('composer-'));
      setBubbleGraph([...existingNodes, ...result.nodes], [...existingEdges, ...result.edges]);
    }, 300);
    return () => clearTimeout(timer);
  }, [shapes, activeStoreyId, snapThreshold, setBubbleGraph]);

  // ── Pan/Zoom state ────────────────────────────────────────────────────
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewBox, setViewBox] = useState({ x: -5000, y: -5000, w: 30000, h: 20000 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; vb: typeof viewBox } | null>(null);

  // ── Drag state ────────────────────────────────────────────────────────
  const [dragMode, setDragMode] = useState<'none' | 'shape' | 'edge'>('none');
  const dragRef = useRef<{
    shapeId: string;
    edgeIndex?: number;
    dimKey?: string;
    dimSign?: number;
    dimAxis?: 'x' | 'y';
    moveOrigin?: boolean;                     // shift origin so the opposite edge stays fixed
    startMouse: { x: number; y: number };     // SVG world coords at drag start
    clientStart: { x: number; y: number };    // screen pixels at drag start
    startDimValue?: number;
    hasMoved: boolean;                        // true once threshold exceeded
  } | null>(null);

  // ── Tool state ────────────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState<'select' | 'place'>('select');
  const [placeTemplate, setPlaceTemplate] = useState<string>('rect-4x4');

  // ── SVG coordinate conversion ─────────────────────────────────────────
  const svgPt = useCallback((clientX: number, clientY: number) => {
    const loc = clientToSvgUserPoint(svgRef.current, clientX, clientY);
    return loc ?? { x: 0, y: 0 };
  }, []);

  // ── Place new shape ───────────────────────────────────────────────────
  const handleSvgClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (activeTool !== 'place') return;
    if (e.button !== 0) return;
    const pt = svgPt(e.clientX, e.clientY);
    const template = SHAPE_TEMPLATES.find((t) => t.id === placeTemplate);
    if (!template) return;

    const dims = { ...template.defaultDimensions };
    const vertices = computeShapeVertices(template.id, dims, pt.x, pt.y);

    const shape: RoomXShape = {
      id: uid(),
      name: nextRoomName(),
      templateId: template.id,
      fillColor: nextColor(),
      fillOpacity: 0.25,
      originX: pt.x,
      originY: pt.y,
      dimensions: dims,
      dragStep: 100,
      vertices,
      edges: makeClosedEdges(vertices.length),
      storeyId: null,
      zOrder: shapes.length,
      createdAt: Date.now(),
    };
    addShape(shape);
    setActiveTool('select');
  }, [activeTool, placeTemplate, svgPt, shapes.length, addShape]);

  // ── Recompute vertices when dimensions change ─────────────────────────
  const updateDimension = useCallback((
    shapeId: string,
    dimKey: string,
    value: number,
    originPatch?: { x?: number; y?: number },
  ) => {
    const shape = shapes.find((s) => s.id === shapeId);
    if (!shape) return;
    const newDims = { ...shape.dimensions, [dimKey]: Math.max(100, value) };
    const newOriginX = originPatch?.x ?? shape.originX;
    const newOriginY = originPatch?.y ?? shape.originY;
    const rawVertices = computeShapeVertices(shape.templateId, newDims, newOriginX, newOriginY);
    // Preserve existing vertex properties when vertex count unchanged (just a resize)
    const newVertices = rawVertices.length === shape.vertices.length
      ? rawVertices.map((v, i) => ({ ...v, properties: shape.vertices[i]?.properties ?? { ...DEFAULT_VERTEX_PROPS } }))
      : rawVertices;
    // Preserve existing edge configs when vertex count unchanged (just a resize)
    const newEdges = newVertices.length === shape.vertices.length
      ? shape.edges
      : makeClosedEdges(newVertices.length);
    updateShape(shapeId, {
      dimensions: newDims,
      vertices: newVertices,
      edges: newEdges,
      ...(originPatch?.x !== undefined ? { originX: originPatch.x } : {}),
      ...(originPatch?.y !== undefined ? { originY: originPatch.y } : {}),
    });
  }, [shapes, updateShape]);

  // ── Mouse handlers ────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, vb: { ...viewBox } };
      e.preventDefault();
      return;
    }
    if (activeTool === 'place') return;
  }, [viewBox, activeTool]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (isPanning && panStart.current) {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const dx = ((e.clientX - panStart.current.x) / rect.width) * panStart.current.vb.w;
      const dy = ((e.clientY - panStart.current.y) / rect.height) * panStart.current.vb.h;
      setViewBox({ ...panStart.current.vb, x: panStart.current.vb.x - dx, y: panStart.current.vb.y - dy });
      return;
    }
    if (dragMode === 'shape' && dragRef.current) {
      // Require >4px screen movement before starting drag (prevents accidental nudge on click)
      if (!dragRef.current.hasMoved) {
        const cdx = e.clientX - dragRef.current.clientStart.x;
        const cdy = e.clientY - dragRef.current.clientStart.y;
        if (Math.hypot(cdx, cdy) < 4) return;
        dragRef.current.hasMoved = true;
      }
      const pt = svgPt(e.clientX, e.clientY);
      const dx = pt.x - dragRef.current.startMouse.x;
      const dy = pt.y - dragRef.current.startMouse.y;
      moveShape(dragRef.current.shapeId, dx, dy);
      dragRef.current.startMouse = pt;
    }
    if (dragMode === 'edge' && dragRef.current) {
      const pt = svgPt(e.clientX, e.clientY);
      const shape = shapes.find((s) => s.id === dragRef.current!.shapeId);
      if (!shape || !dragRef.current.dimKey) return;
      const axis = dragRef.current.dimAxis!;
      const sign = dragRef.current.dimSign!;
      const mouseDelta = axis === 'x'
        ? pt.x - dragRef.current.startMouse.x
        : pt.y - dragRef.current.startMouse.y;
      const rawValue = (dragRef.current.startDimValue ?? 0) + mouseDelta * sign;
      const snappedValue = snapToStep(rawValue, shape.dragStep);
      const clampedValue = Math.max(shape.dragStep || 100, snappedValue);
      if (clampedValue !== shape.dimensions[dragRef.current.dimKey]) {
        const actualDimChange = clampedValue - shape.dimensions[dragRef.current.dimKey];
        // For origin-adjacent edges: shift origin so the OPPOSITE edge stays fixed.
        // The origin moves in the opposite direction of the dimension growth.
        const originPatch: { x?: number; y?: number } = {};
        if (dragRef.current.moveOrigin) {
          if (axis === 'x') originPatch.x = shape.originX - actualDimChange;
          else              originPatch.y = shape.originY - actualDimChange;
        }
        updateDimension(shape.id, dragRef.current.dimKey, clampedValue, originPatch);
      }
    }
  }, [isPanning, dragMode, svgPt, shapes, moveShape, updateDimension]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    panStart.current = null;
    if (dragMode !== 'none') {
      setDragMode('none');
      dragRef.current = null;
    }
  }, [dragMode]);

  // ── Zoom ──────────────────────────────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    const newW = viewBox.w * factor;
    const newH = viewBox.h * factor;
    setViewBox({
      x: viewBox.x + (viewBox.w - newW) * mx,
      y: viewBox.y + (viewBox.h - newH) * my,
      w: newW,
      h: newH,
    });
  }, [viewBox]);

  // ── Shape interaction handlers ────────────────────────────────────────
  const handleShapeMouseDown = useCallback((e: React.MouseEvent, shapeId: string) => {
    if (activeTool !== 'select') return;
    e.stopPropagation();
    setSelectedShape(shapeId);
    setDragMode('shape');
    const pt = svgPt(e.clientX, e.clientY);
    dragRef.current = { shapeId, startMouse: pt, clientStart: { x: e.clientX, y: e.clientY }, hasMoved: false };
  }, [activeTool, svgPt, setSelectedShape]);

  const handleEdgeMouseDown = useCallback((e: React.MouseEvent, shapeId: string, edgeIdx: number) => {
    if (activeTool !== 'select') return;
    e.stopPropagation();
    setSelectedShape(shapeId);
    setSelectedEdge(edgeIdx);

    // Start edge dragging if this edge has a dimension mapping
    const shape = shapes.find((s) => s.id === shapeId);
    if (!shape) return;
    const tpl = SHAPE_TEMPLATES.find((t) => t.id === shape.templateId);
    if (!tpl) return;
    const dimMap = tpl.edgeDimensionMap(shape.dimensions);
    const mapping = dimMap.get(edgeIdx);
    if (!mapping) return; // edge not draggable

    setDragMode('edge');
    const pt = svgPt(e.clientX, e.clientY);
    dragRef.current = {
      shapeId,
      edgeIndex: edgeIdx,
      dimKey: mapping.dim,
      dimSign: mapping.sign,
      dimAxis: mapping.axis,
      moveOrigin: mapping.moveOrigin ?? false,
      startMouse: pt,
      clientStart: { x: e.clientX, y: e.clientY },
      startDimValue: shape.dimensions[mapping.dim],
      hasMoved: false,
    };
  }, [activeTool, svgPt, shapes, setSelectedShape, setSelectedEdge]);

  const handleEdgeClick = useCallback((e: React.MouseEvent, shapeId: string, edgeIdx: number) => {
    e.stopPropagation();
    setSelectedShape(shapeId);
    setSelectedEdge(edgeIdx);
  }, [setSelectedShape, setSelectedEdge]);

  const handleVertexClick = useCallback((e: React.MouseEvent, shapeId: string, localIndex: number) => {
    e.stopPropagation();
    setSelectedShape(shapeId);
    setSelectedVertex(localIndex);
  }, [setSelectedShape, setSelectedVertex]);

  const handleBgClick = useCallback((e: React.MouseEvent) => {
    if (activeTool === 'select' && dragMode === 'none') {
      setSelectedShape(null);
    }
  }, [activeTool, dragMode, setSelectedShape]);

  // ── Selected shape/edge/vertex ────────────────────────────────────────
  const selectedShape = useMemo(() => shapes.find((s) => s.id === selectedShapeId) ?? null, [shapes, selectedShapeId]);
  const selectedEdge = useMemo(() => {
    if (!selectedShape || selectedEdgeIndex === null) return null;
    return selectedShape.edges[selectedEdgeIndex] ?? null;
  }, [selectedShape, selectedEdgeIndex]);

  // ── Get template for selected shape ───────────────────────────────────
  const selectedTemplate = useMemo(() => {
    if (!selectedShape) return null;
    return SHAPE_TEMPLATES.find((t) => t.id === selectedShape.templateId) ?? null;
  }, [selectedShape]);

  // ── Check if an edge is draggable ─────────────────────────────────────
  const edgeDraggable = useCallback((shape: RoomXShape, edgeIdx: number): boolean => {
    const tpl = SHAPE_TEMPLATES.find((t) => t.id === shape.templateId);
    if (!tpl) return false;
    const dimMap = tpl.edgeDimensionMap(shape.dimensions);
    return dimMap.has(edgeIdx);
  }, []);

  // ── Grid lines ────────────────────────────────────────────────────────
  const gridLines = useMemo(() => {
    if (!gridVisible) return [];
    const lines: { x1: number; y1: number; x2: number; y2: number; isMain: boolean }[] = [];
    const startX = Math.floor(viewBox.x / GRID_STEP_MM) * GRID_STEP_MM;
    const endX = viewBox.x + viewBox.w;
    const startY = Math.floor(viewBox.y / GRID_STEP_MM) * GRID_STEP_MM;
    const endY = viewBox.y + viewBox.h;
    for (let x = startX; x <= endX; x += GRID_STEP_MM) {
      lines.push({ x1: x, y1: startY, x2: x, y2: endY, isMain: x === 0 });
    }
    for (let y = startY; y <= endY; y += GRID_STEP_MM) {
      lines.push({ x1: startX, y1: y, x2: endX, y2: y, isMain: y === 0 });
    }
    return lines;
  }, [viewBox, gridVisible]);

  // ── Edge style ────────────────────────────────────────────────────────
  function edgeStroke(type: RoomXEdgeType): string {
    switch (type) {
      case 'wall': return '#475569';
      case 'beam': return '#f59e0b';
      default: return '#94a3b8';
    }
  }
  function edgeDash(type: RoomXEdgeType): string {
    switch (type) {
      case 'beam': return '200,100';
      case 'edge': return '100,100';
      default: return '';
    }
  }
  function edgeWidth(type: RoomXEdgeType): number {
    switch (type) {
      case 'wall': return 120;
      case 'beam': return 80;
      default: return 40;
    }
  }

  // ── Delete selected shape ─────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedShapeId && document.activeElement?.tagName !== 'INPUT') {
        removeShape(selectedShapeId);
      }
      if (e.key === 'Escape') {
        setActiveTool('select');
        setSelectedShape(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedShapeId, removeShape, setSelectedShape]);

  // ── Property change handlers ──────────────────────────────────────────
  const handleNameChange = useCallback((name: string) => {
    if (!selectedShapeId) return;
    updateShape(selectedShapeId, { name });
  }, [selectedShapeId, updateShape]);

  const handleColorChange = useCallback((fillColor: string) => {
    if (!selectedShapeId) return;
    updateShape(selectedShapeId, { fillColor });
  }, [selectedShapeId, updateShape]);

  const handleOpacityChange = useCallback((fillOpacity: number) => {
    if (!selectedShapeId) return;
    updateShape(selectedShapeId, { fillOpacity });
  }, [selectedShapeId, updateShape]);

  const handleDragStepChange = useCallback((step: number) => {
    if (!selectedShapeId) return;
    updateShape(selectedShapeId, { dragStep: Math.max(10, step) });
  }, [selectedShapeId, updateShape]);

  const handleToggleFlag = useCallback((flag: 'has_wall' | 'has_beam' | 'has_window' | 'has_door') => {
    if (!selectedShape || selectedEdgeIndex === null) return;
    const newEdges = [...selectedShape.edges];
    const e = { ...newEdges[selectedEdgeIndex], [flag]: !newEdges[selectedEdgeIndex][flag] };
    if (flag === 'has_window' && e.has_window && !e.windowConfig) e.windowConfig = { ...DEFAULT_WIN_CFG };
    if (flag === 'has_door'   && e.has_door   && !e.doorConfig)   e.doorConfig   = { ...DEFAULT_DOOR_CFG };
    if (flag === 'has_wall'   && e.has_wall   && !e.wallConfig)   e.wallConfig   = { ...DEFAULT_WALL_CFG };
    if (flag === 'has_beam'   && e.has_beam   && !e.beamConfig)   e.beamConfig   = { ...DEFAULT_BEAM_CFG };
    newEdges[selectedEdgeIndex] = e;
    updateShape(selectedShape.id, { edges: newEdges });
  }, [selectedShape, selectedEdgeIndex, updateShape]);

  const handleWindowConfig = useCallback(<K extends keyof NonNullable<RoomXEdgeConfig['windowConfig']>>(key: K, value: NonNullable<RoomXEdgeConfig['windowConfig']>[K]) => {
    if (!selectedShape || selectedEdgeIndex === null) return;
    const newEdges = [...selectedShape.edges];
    const e = newEdges[selectedEdgeIndex];
    newEdges[selectedEdgeIndex] = { ...e, windowConfig: { ...(e.windowConfig ?? { ...DEFAULT_WIN_CFG }), [key]: value } };
    updateShape(selectedShape.id, { edges: newEdges });
  }, [selectedShape, selectedEdgeIndex, updateShape]);

  const handleDoorConfig = useCallback(<K extends keyof NonNullable<RoomXEdgeConfig['doorConfig']>>(key: K, value: NonNullable<RoomXEdgeConfig['doorConfig']>[K]) => {
    if (!selectedShape || selectedEdgeIndex === null) return;
    const newEdges = [...selectedShape.edges];
    const e = newEdges[selectedEdgeIndex];
    newEdges[selectedEdgeIndex] = { ...e, doorConfig: { ...(e.doorConfig ?? { ...DEFAULT_DOOR_CFG }), [key]: value } };
    updateShape(selectedShape.id, { edges: newEdges });
  }, [selectedShape, selectedEdgeIndex, updateShape]);

  const handleWallThickness = useCallback((thickness: number) => {
    if (!selectedShape || selectedEdgeIndex === null) return;
    const newEdges = [...selectedShape.edges];
    const e = newEdges[selectedEdgeIndex];
    newEdges[selectedEdgeIndex] = { ...e, wallConfig: { ...(e.wallConfig ?? { thickness: 200, height: 3000, material: 'concrete' }), thickness } };
    updateShape(selectedShape.id, { edges: newEdges });
  }, [selectedShape, selectedEdgeIndex, updateShape]);

  const handleWallHeight = useCallback((height: number) => {
    if (!selectedShape || selectedEdgeIndex === null) return;
    const newEdges = [...selectedShape.edges];
    const e = newEdges[selectedEdgeIndex];
    newEdges[selectedEdgeIndex] = { ...e, wallConfig: { ...(e.wallConfig ?? { thickness: 200, height: 3000, material: 'concrete' }), height } };
    updateShape(selectedShape.id, { edges: newEdges });
  }, [selectedShape, selectedEdgeIndex, updateShape]);

  const handleBeamWidth = useCallback((width: number) => {
    if (!selectedShape || selectedEdgeIndex === null) return;
    const newEdges = [...selectedShape.edges];
    const e = newEdges[selectedEdgeIndex];
    newEdges[selectedEdgeIndex] = { ...e, beamConfig: { ...(e.beamConfig ?? { width: 300, height: 600, material: 'concrete' }), width } };
    updateShape(selectedShape.id, { edges: newEdges });
  }, [selectedShape, selectedEdgeIndex, updateShape]);

  const handleBeamHeight = useCallback((height: number) => {
    if (!selectedShape || selectedEdgeIndex === null) return;
    const newEdges = [...selectedShape.edges];
    const e = newEdges[selectedEdgeIndex];
    newEdges[selectedEdgeIndex] = { ...e, beamConfig: { ...(e.beamConfig ?? { width: 300, height: 600, material: 'concrete' }), height } };
    updateShape(selectedShape.id, { edges: newEdges });
  }, [selectedShape, selectedEdgeIndex, updateShape]);

  const handleWallMaterial = useCallback((material: string) => {
    if (!selectedShape || selectedEdgeIndex === null) return;
    const newEdges = [...selectedShape.edges];
    const e = newEdges[selectedEdgeIndex];
    newEdges[selectedEdgeIndex] = { ...e, wallConfig: { ...(e.wallConfig ?? { thickness: 200, height: 3000, material: 'concrete' }), material } };
    updateShape(selectedShape.id, { edges: newEdges });
  }, [selectedShape, selectedEdgeIndex, updateShape]);

  const handleBeamMaterial = useCallback((material: string) => {
    if (!selectedShape || selectedEdgeIndex === null) return;
    const newEdges = [...selectedShape.edges];
    const e = newEdges[selectedEdgeIndex];
    newEdges[selectedEdgeIndex] = { ...e, beamConfig: { ...(e.beamConfig ?? { width: 300, height: 600, material: 'concrete' }), material } };
    updateShape(selectedShape.id, { edges: newEdges });
  }, [selectedShape, selectedEdgeIndex, updateShape]);

  const handleVertexProp = useCallback((localIndex: number, patch: Partial<RoomXVertexProps>) => {
    if (!selectedShape) return;
    const newVertices = selectedShape.vertices.map((v) =>
      v.localIndex === localIndex
        ? { ...v, properties: { ...(v.properties ?? DEFAULT_VERTEX_PROPS), ...patch } }
        : v,
    );
    updateShape(selectedShape.id, { vertices: newVertices });
  }, [selectedShape, updateShape]);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex w-full h-full bg-background">

      {/* ── SVG Canvas ── */}
      <div className="flex-1 relative min-w-0">
        {/* Toolbar */}
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1 bg-background/90 border border-border rounded-md px-2 py-1 shadow-sm">
          <button
            className={`px-2 py-1 text-xs rounded ${activeTool === 'select' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
            onClick={() => setActiveTool('select')}
            title="Select / Move (V)"
          >
            ↖ Select
          </button>
          <div className="w-px h-4 bg-border mx-1" />
          <select
            className="text-xs bg-muted border border-border rounded px-1 py-0.5"
            value={placeTemplate}
            onChange={(e) => { setPlaceTemplate(e.target.value); setActiveTool('place'); }}
            title="Shape to place"
          >
            {SHAPE_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>{t.icon} {t.label}</option>
            ))}
          </select>
          <button
            className={`px-2 py-1 text-xs rounded ${activeTool === 'place' ? 'bg-emerald-600 text-white' : 'hover:bg-accent'}`}
            onClick={() => setActiveTool('place')}
            title="Place shape"
          >
            ＋ Place
          </button>
          <div className="w-px h-4 bg-border mx-1" />
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input type="checkbox" checked={snapEnabled} onChange={(e) => setSnapEnabled(e.target.checked)} className="w-3 h-3" />
            Snap
          </label>
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input type="checkbox" checked={gridVisible} onChange={(e) => setGridVisible(e.target.checked)} className="w-3 h-3" />
            Grid
          </label>
        </div>

        {/* SVG */}
        <svg
          ref={svgRef}
          className="w-full h-full select-none"
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={(e) => { handleSvgClick(e); handleBgClick(e); }}
          onWheel={handleWheel}
          style={{ cursor: activeTool === 'place' ? 'crosshair' : isPanning ? 'grabbing' : 'default' }}
        >
          {/* Grid */}
          {gridLines.map((l, i) => (
            <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
              stroke={l.isMain ? '#6366f1' : '#e2e8f0'}
              strokeWidth={l.isMain ? 30 : 10}
              opacity={l.isMain ? 0.5 : 0.3}
            />
          ))}

          {/* Shapes */}
          {shapes.map((shape) => {
            const points = shape.vertices.map((v) => `${v.x},${v.y}`).join(' ');
            const isSelected = shape.id === selectedShapeId;
            return (
              <g key={shape.id}>
                {/* Fill polygon — stopPropagation on click so SVG background doesn't deselect */}
                <polygon
                  points={points}
                  fill={shape.fillColor}
                  fillOpacity={shape.fillOpacity}
                  stroke={isSelected ? '#6366f1' : '#64748b'}
                  strokeWidth={isSelected ? 80 : 40}
                  strokeLinejoin="round"
                  style={{ cursor: 'move' }}
                  onMouseDown={(e) => handleShapeMouseDown(e, shape.id)}
                  onClick={(e) => e.stopPropagation()}
                />
                {/* Edges (on top of fill) — draggable if mapped */}
                {shape.edges.map((edge, ei) => {
                  const v1 = shape.vertices[edge.from];
                  const v2 = shape.vertices[edge.to];
                  if (!v1 || !v2) return null;
                  const isEdgeSelected = isSelected && selectedEdgeIndex === ei;
                  const isDraggable = edgeDraggable(shape, ei);
                  const cursor = isDraggable
                    ? (Math.abs(v1.x - v2.x) < Math.abs(v1.y - v2.y) ? 'ew-resize' : 'ns-resize')
                    : 'pointer';
                  return (
                    <g key={ei}>
                      {/* Visible stroke */}
                      <line
                        x1={v1.x} y1={v1.y} x2={v2.x} y2={v2.y}
                        stroke={isEdgeSelected ? '#6366f1' : edgeStroke(edge.type)}
                        strokeWidth={isEdgeSelected ? edgeWidth(edge.type) * 2 : edgeWidth(edge.type)}
                        strokeDasharray={edgeDash(edge.type)}
                        strokeLinecap="round"
                        pointerEvents="none"
                      />
                      {/* Wide invisible hit-target (always ~12px equivalent in world coords) */}
                      <line
                        x1={v1.x} y1={v1.y} x2={v2.x} y2={v2.y}
                        stroke="transparent"
                        strokeWidth={viewBox.w * 0.012}
                        strokeLinecap="round"
                        style={{ cursor }}
                        onClick={(e) => handleEdgeClick(e, shape.id, ei)}
                        onMouseDown={(e) => handleEdgeMouseDown(e, shape.id, ei)}
                      />
                    </g>
                  );
                })}
                {/* Dimension labels on edges */}
                {isSelected && shape.edges.map((edge, ei) => {
                  const v1 = shape.vertices[edge.from];
                  const v2 = shape.vertices[edge.to];
                  if (!v1 || !v2) return null;
                  const len = dist(v1, v2);
                  const mx = (v1.x + v2.x) / 2;
                  const my = (v1.y + v2.y) / 2;
                  return (
                    <text key={`dim-${ei}`}
                      x={mx} y={my - viewBox.w * 0.005}
                      textAnchor="middle" fontSize={viewBox.w * 0.006}
                      fill="#6366f1" fontWeight="500" pointerEvents="none"
                    >
                      {(len / 1000).toFixed(2)}m
                    </text>
                  );
                })}
                {/* Vertices — clickable ax node indicators */}
                {shape.vertices.map((v) => {
                  const isVSelected = isSelected && selectedVertexIndex === v.localIndex;
                  const isMerged = mergedVertices.has(`${shape.id}:${v.localIndex}`);
                  const hasCol = v.properties?.has_column ?? true;
                  const r = viewBox.w * 0.003;
                  return (
                    <g key={v.localIndex} onClick={(e) => handleVertexClick(e, shape.id, v.localIndex)} style={{ cursor: 'pointer' }}>
                      {hasCol ? (
                        <rect
                          x={v.x - r} y={v.y - r} width={r * 2} height={r * 2}
                          fill={isVSelected ? '#6366f1' : isMerged ? '#f59e0b' : '#475569'}
                          stroke={isVSelected ? '#4f46e5' : isMerged ? '#d97706' : '#1e293b'}
                          strokeWidth={r * 0.3}
                        />
                      ) : (
                        <circle
                          cx={v.x} cy={v.y} r={r}
                          fill={isVSelected ? '#6366f1' : isMerged ? '#f59e0b' : '#fff'}
                          stroke={isVSelected ? '#4f46e5' : isMerged ? '#d97706' : '#475569'}
                          strokeWidth={r * 0.3}
                        />
                      )}
                    </g>
                  );
                })}
                {/* Shape name + dimension label */}
                {(() => {
                  const cx = shape.vertices.reduce((s, v) => s + v.x, 0) / shape.vertices.length;
                  const cy = shape.vertices.reduce((s, v) => s + v.y, 0) / shape.vertices.length;
                  const fs = viewBox.w * 0.008;
                  const dimStr = shapeDimString(shape);
                  return (
                    <text x={cx} y={cy} textAnchor="middle" pointerEvents="none">
                      <tspan x={cx} dy={`-${fs * 0.6}`} fontSize={fs} fill="#334155" fontWeight="700">
                        {shape.name}
                      </tspan>
                      <tspan x={cx} dy={fs * 1.4} fontSize={fs * 0.85} fill="#6366f1" fontWeight="500">
                        {dimStr}
                      </tspan>
                    </text>
                  );
                })()}
              </g>
            );
          })}
        </svg>
      </div>

      {/* ── Properties Panel ── */}
      <aside className="w-72 border-l border-border bg-muted/10 overflow-y-auto flex-shrink-0 text-xs p-3 flex flex-col gap-3">
        <div className="font-bold text-sm text-foreground">Properties</div>

        {!selectedShape && (
          <div className="text-muted-foreground italic text-xs">
            Select a shape to inspect. Drag edges to resize (snaps to step).
          </div>
        )}

        {selectedShape && selectedTemplate && (
          <>
            {/* Shape props */}
            <div className="flex flex-col gap-2 border-b border-border pb-3">
              <label className="text-muted-foreground font-medium">Room Name</label>
              <input
                className="bg-background border border-border rounded px-2 py-1 text-xs font-medium"
                value={selectedShape.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. Living Room"
              />
              <div className="flex flex-wrap gap-1">
                {ROOM_NAMES.slice(0, 8).map((rn) => (
                  <button key={rn}
                    className={`px-1.5 py-0.5 rounded text-xs ${
                      selectedShape.name === rn ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-accent'
                    }`}
                    onClick={() => handleNameChange(rn)}
                  >
                    {rn}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <label className="text-muted-foreground w-12">Color</label>
                <input
                  type="color"
                  value={selectedShape.fillColor}
                  onChange={(e) => handleColorChange(e.target.value)}
                  className="w-8 h-6 border border-border rounded cursor-pointer"
                />
                <span className="text-muted-foreground">{selectedShape.fillColor}</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-muted-foreground w-12">Opacity</label>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={selectedShape.fillOpacity}
                  onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
                  className="flex-1"
                />
                <span className="w-8 text-right">{Math.round(selectedShape.fillOpacity * 100)}%</span>
              </div>
            </div>

            {/* ── Dimensions ── */}
            <div className="flex flex-col gap-2 border-b border-border pb-3">
              <label className="text-muted-foreground font-medium">Dimensions</label>
              {Object.entries(selectedTemplate.dimensionLabels).map(([key, label]) => (
                <div key={key} className="flex items-center gap-2">
                  <label className="text-muted-foreground w-24 truncate" title={label}>{label}</label>
                  <input
                    type="number"
                    className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                    value={selectedShape.dimensions[key] ?? 0}
                    step={selectedShape.dragStep}
                    min={100}
                    onChange={(e) => updateDimension(selectedShape.id, key, Number(e.target.value))}
                  />
                  <span className="text-muted-foreground">mm</span>
                </div>
              ))}
              {/* Computed area */}
              {(() => {
                // Shoelace formula for polygon area
                const verts = selectedShape.vertices;
                let area = 0;
                for (let i = 0; i < verts.length; i++) {
                  const j = (i + 1) % verts.length;
                  area += verts[i].x * verts[j].y;
                  area -= verts[j].x * verts[i].y;
                }
                area = Math.abs(area) / 2;
                return (
                  <div className="text-muted-foreground mt-1">
                    Area: {(area / 1_000_000).toFixed(2)} m²
                  </div>
                );
              })()}
            </div>

            {/* ── Drag Step ── */}
            <div className="flex flex-col gap-2 border-b border-border pb-3">
              <label className="text-muted-foreground font-medium">Edge Drag Step</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                  value={selectedShape.dragStep}
                  step={10}
                  min={10}
                  onChange={(e) => handleDragStepChange(Number(e.target.value))}
                />
                <span className="text-muted-foreground">mm</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {[50, 100, 250, 500, 1000].map((step) => (
                  <button key={step}
                    className={`px-1.5 py-0.5 rounded text-xs ${selectedShape.dragStep === step ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-accent'}`}
                    onClick={() => handleDragStepChange(step)}
                  >
                    {step >= 1000 ? `${step / 1000}m` : `${step}mm`}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Origin ── */}
            <div className="flex flex-col gap-1 border-b border-border pb-3">
              <label className="text-muted-foreground font-medium">Origin</label>
              <div className="flex items-center gap-2">
                <span className="w-8 text-muted-foreground">X</span>
                <span>{Math.round(selectedShape.originX)} mm</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-8 text-muted-foreground">Y</span>
                <span>{Math.round(selectedShape.originY)} mm</span>
              </div>
            </div>

            {/* Vertex / Ax Node properties */}
            {selectedVertexIndex !== null && (() => {
              const v = selectedShape.vertices.find((vt) => vt.localIndex === selectedVertexIndex);
              if (!v) return null;
              const isMerged = mergedVertices.has(`${selectedShape.id}:${v.localIndex}`);
              const mergeOwner = mergedVertices.get(`${selectedShape.id}:${v.localIndex}`);
              const vp = v.properties ?? DEFAULT_VERTEX_PROPS;
              const isCirc = /^[Cc][Rr]/.test(vp.column_type);
              return (
                <div className="flex flex-col gap-2 border-b border-border pb-3">
                  <div className="flex items-center justify-between">
                    <label className="text-muted-foreground font-medium">■ Axis #{v.localIndex}</label>
                    <span className="text-muted-foreground text-xs">{Math.round(v.x)}, {Math.round(v.y)} mm</span>
                  </div>
                  {isMerged && (
                    <div className="text-amber-500 font-medium text-xs">⚡ Merged with {mergeOwner}</div>
                  )}
                  {/* Label */}
                  <div className="flex items-center gap-2">
                    <label className="w-16 text-muted-foreground">Label</label>
                    <input
                      className="bg-background border border-border rounded px-1 py-0.5 flex-1 text-xs"
                      value={vp.label}
                      placeholder="Axis name…"
                      onChange={(e) => handleVertexProp(v.localIndex, { label: e.target.value })}
                    />
                  </div>
                  {/* Has Column toggle */}
                  <div className="flex items-center gap-2">
                    <label className="w-16 text-muted-foreground">Column</label>
                    <select
                      className="bg-background border border-border rounded px-1 py-0.5 text-xs flex-1"
                      value={vp.has_column ? 'True' : 'False'}
                      onChange={(e) => handleVertexProp(v.localIndex, { has_column: e.target.value === 'True' })}
                    >
                      <option value="True">True</option>
                      <option value="False">False</option>
                    </select>
                  </div>
                  {/* Column config — only when has_column=true */}
                  {vp.has_column && (
                    <div className="flex flex-col gap-2 pl-2 border-l-2 border-slate-400">
                      {/* Shape toggle: Rect / Circ */}
                      <div className="flex gap-1">
                        <button
                          className={`flex-1 py-0.5 rounded text-xs font-medium ${!isCirc ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-accent'}`}
                          onClick={() => handleVertexProp(v.localIndex, { column_type: 'C25x25' })}
                        >▪ Rect.</button>
                        <button
                          className={`flex-1 py-0.5 rounded text-xs font-medium ${isCirc ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-accent'}`}
                          onClick={() => handleVertexProp(v.localIndex, { column_type: 'CR30' })}
                        >● Circ.</button>
                      </div>
                      {/* Column type */}
                      {!isCirc ? (
                        <>
                          <div className="flex items-center gap-2">
                            <label className="w-16 text-muted-foreground">Type</label>
                            <select
                              className="bg-background border border-border rounded px-1 py-0.5 text-xs flex-1"
                              value={vp.column_type}
                              onChange={(e) => handleVertexProp(v.localIndex, { column_type: e.target.value })}
                            >
                              {['C20x20','C25x25','C25x40','C30x30','C30x50','C30x60','C40x40','C40x60','C50x50','C60x60'].map((t) => (
                                <option key={t} value={t}>{t.replace('C','').replace('x','×')} cm</option>
                              ))}
                            </select>
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center gap-2">
                          <label className="w-16 text-muted-foreground">Type</label>
                          <select
                            className="bg-background border border-border rounded px-1 py-0.5 text-xs flex-1"
                            value={vp.column_type}
                            onChange={(e) => handleVertexProp(v.localIndex, { column_type: e.target.value })}
                          >
                            {['CR20','CR25','CR30','CR35','CR40','CR50','CR60'].map((t) => (
                              <option key={t} value={t}>⌀{t.replace('CR','')} cm</option>
                            ))}
                          </select>
                        </div>
                      )}
                      {/* Offsets */}
                      <div className="text-muted-foreground font-medium text-xs uppercase tracking-wide mt-1">Offsets</div>
                      <div className="grid grid-cols-2 gap-1">
                        <div className="flex items-center gap-1">
                          <label className="text-muted-foreground w-5">X</label>
                          <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-full text-xs"
                            value={vp.offsetX} step={10}
                            onChange={(e) => handleVertexProp(v.localIndex, { offsetX: Number(e.target.value) })}
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <label className="text-muted-foreground w-5">Y</label>
                          <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-full text-xs"
                            value={vp.offsetY} step={10}
                            onChange={(e) => handleVertexProp(v.localIndex, { offsetY: Number(e.target.value) })}
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <label className="text-muted-foreground w-5">B</label>
                          <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-full text-xs"
                            value={vp.offsetBase} step={50} title="Offset from storey base"
                            onChange={(e) => handleVertexProp(v.localIndex, { offsetBase: Number(e.target.value) })}
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <label className="text-muted-foreground w-5">T</label>
                          <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-full text-xs"
                            value={vp.offsetTop} step={50} title="Offset from storey top"
                            onChange={(e) => handleVertexProp(v.localIndex, { offsetTop: Number(e.target.value) })}
                          />
                        </div>
                      </div>
                      {/* Material */}
                      <div className="flex items-center gap-2">
                        <label className="w-16 text-muted-foreground">Material</label>
                        <input
                          className="bg-background border border-border rounded px-1 py-0.5 flex-1 text-xs"
                          value={vp.material}
                          placeholder="material ID"
                          onChange={(e) => handleVertexProp(v.localIndex, { material: e.target.value })}
                        />
                      </div>
                      {/* Colors */}
                      <div className="flex items-center gap-2">
                        <label className="w-16 text-muted-foreground">3D Color</label>
                        <input type="color" className="w-6 h-5 border border-border rounded cursor-pointer"
                          value={vp.color_3d || '#64748b'}
                          onChange={(e) => handleVertexProp(v.localIndex, { color_3d: e.target.value })}
                        />
                        <label className="w-16 text-muted-foreground">2D Color</label>
                        <input type="color" className="w-6 h-5 border border-border rounded cursor-pointer"
                          value={vp.color_2d || '#64748b'}
                          onChange={(e) => handleVertexProp(v.localIndex, { color_2d: e.target.value })}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Edge config — shown as Wall / Beam / Edge node */}
            {selectedEdge && (
              <div className="flex flex-col gap-2 border-b border-border pb-3">
                {/* Header row */}
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground">
                    🧱 Side
                    <span className="ml-1 text-muted-foreground font-normal text-xs">{selectedEdge.from}→{selectedEdge.to}</span>
                  </span>
                  {edgeDraggable(selectedShape, selectedEdgeIndex!) && (
                    <span className="text-indigo-400 text-xs">↔ draggable</span>
                  )}
                </div>
                {/* Length */}
                {(() => {
                  const v1 = selectedShape.vertices[selectedEdge.from];
                  const v2 = selectedShape.vertices[selectedEdge.to];
                  if (!v1 || !v2) return null;
                  const len = dist(v1, v2);
                  return (
                    <div className="text-muted-foreground bg-muted/30 rounded px-2 py-1">
                      Length: <span className="text-foreground font-medium">{(len / 1000).toFixed(2)} m</span>
                      <span className="ml-2 opacity-60">({Math.round(len)} mm)</span>
                    </div>
                  );
                })()}
                {/* ── Feature flags ── */}
                <div className="grid grid-cols-2 gap-1">
                  {([
                    { key: 'has_wall',   icon: '🧱', label: 'Wall'   },
                    { key: 'has_beam',   icon: '🔩', label: 'Beam'   },
                    { key: 'has_window', icon: '🪟', label: 'Window' },
                    { key: 'has_door',   icon: '🚪', label: 'Door'   },
                  ] as const).map(({ key, icon, label }) => {
                    const on = selectedEdge[key] ?? (key === 'has_wall' || key === 'has_beam');
                    return (
                      <button key={key}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border transition-colors ${
                          on ? 'bg-primary/10 border-primary text-primary' : 'bg-muted border-border text-muted-foreground hover:bg-accent'
                        }`}
                        onClick={() => handleToggleFlag(key)}
                      >
                        <span>{on ? '✓' : '○'}</span>
                        <span>{icon} {label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* ── Wall properties ── */}
                {(selectedEdge.has_wall ?? true) && (
                  <div className="flex flex-col gap-2 pl-2 border-l-2 border-slate-400 mt-1">
                    <div className="text-muted-foreground font-medium text-xs uppercase tracking-wide">🧱 Wall Properties</div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Thickness</label>
                      <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                        value={selectedEdge.wallConfig?.thickness ?? 200}
                        step={10} min={50}
                        onChange={(e) => handleWallThickness(Number(e.target.value))}
                      />
                      <span className="text-muted-foreground">mm</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Height</label>
                      <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                        value={selectedEdge.wallConfig?.height ?? 3000}
                        step={100} min={500}
                        onChange={(e) => handleWallHeight(Number(e.target.value))}
                      />
                      <span className="text-muted-foreground">mm</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Material</label>
                      <select
                        className="bg-background border border-border rounded px-1 py-0.5 text-xs flex-1"
                        value={selectedEdge.wallConfig?.material ?? 'concrete'}
                        onChange={(e) => handleWallMaterial(e.target.value)}
                      >
                        {WALL_MATERIALS.map((m) => (
                          <option key={m} value={m}>{m.replace('_', ' ')}</option>
                        ))}
                      </select>
                    </div>
                    {/* Quick thickness presets */}
                    <div className="flex flex-wrap gap-1">
                      {[100, 150, 200, 250, 300, 375].map((t) => (
                        <button key={t}
                          className={`px-1.5 py-0.5 rounded text-xs ${
                            (selectedEdge.wallConfig?.thickness ?? 200) === t ? 'bg-slate-600 text-white' : 'bg-muted hover:bg-accent'
                          }`}
                          onClick={() => handleWallThickness(t)}
                        >{t}</button>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Beam properties ── */}
                {(selectedEdge.has_beam ?? true) && (
                  <div className="flex flex-col gap-2 pl-2 border-l-2 border-amber-400 mt-1">
                    <div className="text-muted-foreground font-medium text-xs uppercase tracking-wide">🔩 Beam Properties</div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Width</label>
                      <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                        value={selectedEdge.beamConfig?.width ?? 300}
                        step={50} min={100}
                        onChange={(e) => handleBeamWidth(Number(e.target.value))}
                      />
                      <span className="text-muted-foreground">mm</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Height</label>
                      <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                        value={selectedEdge.beamConfig?.height ?? 600}
                        step={50} min={100}
                        onChange={(e) => handleBeamHeight(Number(e.target.value))}
                      />
                      <span className="text-muted-foreground">mm</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Material</label>
                      <select
                        className="bg-background border border-border rounded px-1 py-0.5 text-xs flex-1"
                        value={selectedEdge.beamConfig?.material ?? 'concrete'}
                        onChange={(e) => handleBeamMaterial(e.target.value)}
                      >
                        {BEAM_MATERIALS.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                {/* ── Window properties ── */}
                {selectedEdge.has_window && (
                  <div className="flex flex-col gap-2 pl-2 border-l-2 border-sky-400 mt-1">
                    <div className="text-muted-foreground font-medium text-xs uppercase tracking-wide">🪟 Window Properties</div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Type</label>
                      <select
                        className="bg-background border border-border rounded px-1 py-0.5 text-xs flex-1"
                        value={selectedEdge.windowConfig?.window_type ?? 'W-DBL-120x140'}
                        onChange={(e) => handleWindowConfig('window_type', e.target.value)}
                      >
                        {WINDOW_TYPES.map((w) => (
                          <option key={w.id} value={w.id}>{w.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Sill H.</label>
                      <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                        value={selectedEdge.windowConfig?.sill_height ?? 900}
                        step={50} min={0}
                        onChange={(e) => handleWindowConfig('sill_height', Number(e.target.value))}
                      />
                      <span className="text-muted-foreground">mm</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Offset</label>
                      <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                        value={selectedEdge.windowConfig?.wall_offset ?? 0}
                        step={100} min={0}
                        onChange={(e) => handleWindowConfig('wall_offset', Number(e.target.value))}
                      />
                      <span className="text-muted-foreground">mm</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Count</label>
                      <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                        value={selectedEdge.windowConfig?.count ?? 1}
                        step={1} min={1}
                        onChange={(e) => handleWindowConfig('count', Number(e.target.value))}
                      />
                    </div>
                    {(selectedEdge.windowConfig?.count ?? 1) > 1 && (
                      <div className="flex items-center gap-2">
                        <label className="w-20 text-muted-foreground">Spacing</label>
                        <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                          value={selectedEdge.windowConfig?.spacing ?? 0}
                          step={100} min={0}
                          onChange={(e) => handleWindowConfig('spacing', Number(e.target.value))}
                        />
                        <span className="text-muted-foreground">mm</span>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Door properties ── */}
                {selectedEdge.has_door && (
                  <div className="flex flex-col gap-2 pl-2 border-l-2 border-green-500 mt-1">
                    <div className="text-muted-foreground font-medium text-xs uppercase tracking-wide">🚪 Door Properties</div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Type</label>
                      <select
                        className="bg-background border border-border rounded px-1 py-0.5 text-xs flex-1"
                        value={selectedEdge.doorConfig?.door_type ?? 'D-SWING-90x210'}
                        onChange={(e) => handleDoorConfig('door_type', e.target.value)}
                      >
                        {DOOR_TYPES.map((d) => (
                          <option key={d.id} value={d.id}>{d.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Offset</label>
                      <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                        value={selectedEdge.doorConfig?.wall_offset ?? 0}
                        step={100} min={0}
                        onChange={(e) => handleDoorConfig('wall_offset', Number(e.target.value))}
                      />
                      <span className="text-muted-foreground">mm</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="w-20 text-muted-foreground">Count</label>
                      <input type="number" className="bg-background border border-border rounded px-1 py-0.5 w-20 text-xs"
                        value={selectedEdge.doorConfig?.count ?? 1}
                        step={1} min={1}
                        onChange={(e) => handleDoorConfig('count', Number(e.target.value))}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Delete */}
            <button
              className="mt-auto px-3 py-1.5 rounded bg-red-500/10 text-red-500 hover:bg-red-500/20 text-xs font-medium"
              onClick={() => removeShape(selectedShape.id)}
            >
              Delete Shape
            </button>
          </>
        )}
      </aside>
    </div>
  );
}

export default ComposerCanvas;
