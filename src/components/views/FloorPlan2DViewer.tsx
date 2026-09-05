/**
 * FloorPlan2DViewer — SVG floor-plan renderer built from BubbleGraph node data.
 *
 * Renders building elements (structural columns at axes, walls along edges,
 * spaces, openings) for a given storey in a 2D top-down view.
 * Supports Architecture, Structure, and MEP discipline filters.
 *
 * Plan rendering rules (matches BIM standard):
 *   - Cut elements (structural elements intersected by cut plane):
 *       use section_line_color, section_line_weight, section_line_style,
 *       section_fill_color (+ hatch pattern), section_fill_opacity
 *   - Visible elements (seen overhead / below cut):
 *       use view_line_color, view_line_weight, view_line_style
 *   Shell/covering = visible (overhead), not cut.
 *   Walls/columns/beams/slabs/foundations = cut (section).
 */
import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { cn, parseAxes } from '@/lib/utils';
import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes, StoreyDiscipline } from '@/store';
import { useBubbleGraphStore } from '@/store';
import { getNodeLocalTransform, calcShellPolygon, parseContourOffsets, insetPolygon, calcSpanEffectiveEnds, calcRoomPolygon, getNodeBimPos, collectOpenings, getEndpointAutoOffset, parseBeamDims, calcWallJoins, calcWallGeometry, getWallJoinProp, type OpeningInfo, type WallJoinResult } from '@/lib/bimGeometry';
import { buildRoofPlan, ROOF_GENERATED_TYPES, type RoofPlan } from '@/lib/roof';
import { SvgAnnotationLayer, type SvgAnnotationTool } from './SvgAnnotationLayer';
import { DrawingPropertiesPanel } from './DrawingPropertiesPanel';
import { RebarLayer } from '@/components/views/armare/RebarLayer';
import { RebarPanel } from '@/components/views/armare/RebarPanel';
import { useArmare } from '@/store/armareStore';
import {
  resolveVisuals,
  applyNodeColorOverrides,
  getSectionLineColor, getSectionLineWeight, getSectionLineStyle,
  getSectionFillColor, getSectionFillOpacity,
  getViewLineColor, getViewLineWeight, getViewLineStyle,
  lineStyleToDashArray,
  type HatchPattern, type MaterialVisuals,
} from '@/lib/materialConfig';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { useFitToContent } from '@/hooks/useFitToContent';
import { expandArrayNodes } from '@/lib/formulaUtils';
import { WINDOW_TYPE_MAP } from '@/lib/elementLibrary';
import {
  commitPlanCut,
  cutFromAxisLine,
  sideOfLine,
  type PlanCut,
  findNearestAxisLine,
  orthoConstrainCut,
} from '@/lib/sectionFromPlan';
import { clientToSvgUserPoint } from '@/lib/svgCoordinates';
import { SectionMarkerLayer } from './SectionMarkerLayer';
import { useWindowSymbolConfig } from '@/hooks/useWindowSymbolConfig';
import { useDoorSymbolConfig } from '@/hooks/useDoorSymbolConfig';
import { resolveWindowPlan2DConfig } from '@/lib/windowSymbolLibrary';
import {
  resolveSymbolDef,
  renderSymbolInlineElements,
  buildWindowSymRenderParams,
  buildDoorSymRenderParams,
  subscribeSymbolLibrary,
} from '@/lib/svgSymbolStore';
import {
  resolveBglibSymbol,
  resolveAutoSymbol,
  subscribeBglibStore,
  prewarmBglibSymbols,
  initAutoSymbolList,
} from '@/lib/bglibSymbolStore';
import {
  renderBglibSymbolElements,
} from '@/lib/dxfSymbolRenderer';
import {
  getAnnotationSettings,
  subscribeAnnotationSettings,
  type AnnotationDrawingSettings,
} from '@/lib/annotationDrawingSettings';

const SCALE = 0.08; // mm → SVG units
const PAD   = 60;   // padding inside the building area (for axis bubbles etc.)

// ── Opening cut-zone helper ────────────────────────────────────────────────────
//
// Determines whether the horizontal cut plane passes THROUGH the opening,
// BELOW the sill (parapet/sill visible from above), or ABOVE the lintel.
// Line weights are then derived from wall material config, not from window config.
//
//  'cut'          cut plane is within the opening height → frame/glass are section-cut lines (thick)
//  'sill-visible' cut plane is below the sill → opening not at cut; parapet/sill seen from above (thin)
//  'above-lintel' cut plane is above the lintel → wall is solid at cut height → skip opening entirely
//
type OpeningCutZone = 'cut' | 'sill-visible' | 'above-lintel';

function getOpeningCutZone(
  opNode: BubbleGraphNode,
  storeyBottomMm: number,
  cutAbsElevMm: number,
): OpeningCutZone {
  const typeId  = String(opNode.properties.window_type ?? opNode.properties.door_type ?? '');
  const wType   = WINDOW_TYPE_MAP.get(typeId);
  const sillH   = Number(opNode.properties.sill_height_mm ?? wType?.sill_height_mm ?? 900);
  const openH   = Number(opNode.properties.height_mm     ?? wType?.height_mm       ?? 2100);
  const sillAbs = storeyBottomMm + sillH;
  const headAbs = sillAbs + openH;
  if (cutAbsElevMm > headAbs) return 'above-lintel';
  if (cutAbsElevMm < sillAbs) return 'sill-visible';
  return 'cut';
}
/**
 * Extra canvas space around the building content (SVG units).
 * 1200 SVG units ≈ 15 000 mm = 15 m on each side — plenty for annotations,
 * notes, detail callouts, north arrows, legends, etc.
 */
const CANVAS_MARGIN = 1200;

function uid(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// ── SVG hatch pattern helpers ────────────────────────────────────────────────

/** Build an SVG <pattern> element string for a given hatch type. */
function buildSvgHatchPattern(id: string, hatch: HatchPattern, color: string, lw: number): string {
  const w = Math.max(0.2, lw * 0.6);
  switch (hatch) {
    case 'diagonal':
      return `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse">
        <line x1="0" y1="6" x2="6" y2="0" stroke="${color}" stroke-width="${w}" />
      </pattern>`;
    case 'crosshatch':
      return `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse">
        <line x1="0" y1="6" x2="6" y2="0" stroke="${color}" stroke-width="${w}" />
        <line x1="0" y1="0" x2="6" y2="6" stroke="${color}" stroke-width="${w}" />
      </pattern>`;
    case 'brick':
      return `<pattern id="${id}" width="12" height="6" patternUnits="userSpaceOnUse">
        <rect x="0.5" y="0.5" width="11" height="5" fill="none" stroke="${color}" stroke-width="${w}" />
        <line x1="6" y1="0" x2="6" y2="3" stroke="${color}" stroke-width="${w}" />
        <line x1="0" y1="3" x2="12" y2="3" stroke="${color}" stroke-width="${w}" />
      </pattern>`;
    case 'stone':
      return `<pattern id="${id}" width="10" height="10" patternUnits="userSpaceOnUse">
        <polygon points="1,5 5,1 9,5 5,9" fill="none" stroke="${color}" stroke-width="${w}" />
      </pattern>`;
    case 'wave':
      return `<pattern id="${id}" width="12" height="5" patternUnits="userSpaceOnUse">
        <path d="M0,2.5 Q3,0 6,2.5 Q9,5 12,2.5" fill="none" stroke="${color}" stroke-width="${w}" />
      </pattern>`;
    case 'concrete':
      return `<pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="0.7" fill="${color}" />
        <circle cx="6" cy="6" r="0.7" fill="${color}" />
        <circle cx="2" cy="6" r="0.4" fill="${color}" opacity="0.5" />
        <circle cx="6" cy="2" r="0.4" fill="${color}" opacity="0.5" />
      </pattern>`;
    default: return ''; // 'none' and 'solid' have no pattern (use fill color directly)
  }
}

/** Get the SVG fill value for a section element: either a colour or url(#patternId). */
function sectionFill(patternId: string, vis: MaterialVisuals): string {
  if (!vis.hatch || vis.hatch === 'none') return 'none';
  if (vis.hatch === 'solid') return getSectionFillColor(vis);
  return `url(#${patternId})`;
}

/** Generate a unique SVG pattern ID for a given element type and material id. */
function hatchPatId(elementType: string, materialKey: string): string {
  return `bgp_${elementType}_${materialKey.replace(/[^a-z0-9]/gi, '_')}`;
}


/**
 * Build an SVG transform string for a node's local plan transforms.
 * obj_translate_x (mm, East) → SVG +x  (SCALE factor applied)
 * obj_translate_y (mm, North) → SVG -y (SVG y-flip applied)
 * obj_rotate_y (degrees, around vertical axis) → SVG rotate around centre
 */
function nodeTransformAttr(n: BubbleGraphNode, cx: number, cy: number): string | undefined {
  const t = getNodeLocalTransform(n);
  const parts: string[] = [];
  if (t.tx !== 0 || t.ty !== 0) parts.push(`translate(${t.tx * SCALE},${-t.ty * SCALE})`);
  if (t.ry !== 0) parts.push(`rotate(${-t.ry},${cx},${cy})`); // ry = plan spin, SVG CCW = -
  return parts.length > 0 ? parts.join(' ') : undefined;
}

const DISC_COLORS: Record<StoreyDiscipline, string> = {
  architectural: '#6366f1',
  structural:    '#f59e0b',
  mep:           '#10b981',
};

// Colors are now driven by material config (resolveVisuals); these defaults are in BUILTIN_ELEMENT_DEFAULTS

interface FloorPlan2DViewerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes: BuildingAxes;
  storeyId?: string | null;
  discipline?: StoreyDiscipline | null;
  className?: string;
  /** When true, hide all toolbars/overlays (for sheet composer embedding) */
  embedded?: boolean;
  selectedNodeId?: string | null;
  onSelectNode?: (id: string | null) => void;
}

export function FloorPlan2DViewer({
  nodes,
  edges,
  buildingAxes,
  storeyId,
  discipline,
  className,
  embedded = false,
  selectedNodeId = null,
  onSelectNode,
}: FloorPlan2DViewerProps) {
  const [zoom, setZoom]   = useState(1);
  const [pan, setPan]     = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Frame the building when the plan opens (or switches storey/discipline).
  // Matters most here: the viewBox carries CANVAS_MARGIN of deliberate blank
  // space on every side, so at zoom 1 the building occupies only ~30% of it.
  useFitToContent({
    svgRef, containerRef, setZoom, setPan, enabled: !embedded,
    viewKey: `${storeyId ?? ''}:${discipline ?? ''}`,
  });

  // Refs that always hold the latest pan/zoom — used inside event-handler callbacks
  // so they never go stale even though the callbacks are memoized.
  const panRef  = useRef(pan);
  const zoomRef = useRef(zoom);
  panRef.current  = pan;   // updated every render before any event fires
  zoomRef.current = zoom;

  // Bounds refs — keep mouse→BIM conversion in sync without stale useCallback closures.
  const boundsRef = useRef({ minX: 0, minY: 0, th: 0 });

  // Annotation tool state
  const [annTool, setAnnTool] = useState<SvgAnnotationTool | null>(null);
  const { clearViewAnnotations, setBubbleGraph, selectAnnotation, setPlanTool, setPendingOpenSectionId } = useBubbleGraphStore();
  const planTool = useBubbleGraphStore((s) => s.planTool);
  const rawNodes = useBubbleGraphStore((s) => s.bubbleGraphNodes);
  const rawEdges = useBubbleGraphStore((s) => s.bubbleGraphEdges);
  const selectedAnnotationId = useBubbleGraphStore((s) => s.selectedAnnotationId);

  // ── Draw Wall authoring mode ───────────────────────────────────────────────
  const [drawWallMode, setDrawWallMode] = useState(false);
  const [wallStart, setWallStart] = useState<{ x: number; y: number } | null>(null);
  const [hoverSnap, setHoverSnap] = useState<{ x: number; y: number } | null>(null);
  const [hoverRaw, setHoverRaw] = useState<{ x: number; y: number } | null>(null);
  const SNAP_THRESHOLD_MM = 500; // snap radius in mm

  // ── Draw Section authoring (store-driven planTool) ─────────────────────────
  const drawSectionMode = planTool === 'draw-section';
  const sectionOnAxisMode = planTool === 'section-on-axis';
  const [sectionStart, setSectionStart] = useState<{ x: number; y: number } | null>(null);
  /** After the 2nd click: the line is fixed, the 3rd click picks the viewed side. */
  const [sectionLine, setSectionLine] = useState<PlanCut | null>(null);
  const [hoverAlt, setHoverAlt] = useState(false);
  const [axisHover, setAxisHover] = useState<{ dir: 'X' | 'Y'; value: number } | null>(null);

  // ── Cut-plane & visibility filter state ─────────────────────────────────────
  // cutHeightMm: horizontal cut level above storey bottom (default 1500mm ≈ door handle height)
  const [cutHeightMm, setCutHeightMm]             = useState(1500);
  const [showBeamsAboveCut, setShowBeamsAboveCut] = useState(false);
  const [showSlabs, setShowSlabs]                 = useState(false);
  const [showFilterPanel, setShowFilterPanel]     = useState(false);

  // Expand array_x/y/z nodes into virtual copies — must be first, everything derives from this.
  const expandedNodes = useMemo(() => expandArrayNodes(nodes), [nodes]);

  // ----- filter nodes for this storey
  const storeyNodes = useMemo(() => {
    if (!storeyId) return expandedNodes;
    return expandedNodes.filter((n) => n.id === storeyId || n.parentId === storeyId);
  }, [expandedNodes, storeyId]);

  const storeyMeta = useMemo(
    () => expandedNodes.find((n) => n.id === storeyId),
    [expandedNodes, storeyId],
  );

  const storeyEdges = useMemo(() => {
    const ids = new Set(storeyNodes.map((n) => n.id));
    return edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }, [edges, storeyNodes]);

  // ----- axis grid — source of truth: storey's axesX / axesY (absolute mm from origin).
  // node.x / node.y on ax nodes are graph-canvas positions and must NOT be used here.
  const axisXVals: number[] = useMemo(
    () => parseAxes(storeyMeta?.properties?.axesX ?? buildingAxes.xValues).slice().sort((a, b) => a - b),
    [storeyMeta, buildingAxes],
  );
  const axisYVals: number[] = useMemo(
    () => parseAxes(storeyMeta?.properties?.axesY ?? buildingAxes.yValues).slice().sort((a, b) => a - b),
    [storeyMeta, buildingAxes],
  );

  // ----- coordinate bounds: axis grid values + non-ax node positions (all mm)
  const { minX, minY, maxX, maxY } = useMemo(() => {
    const nonAxNodes = storeyNodes.filter((n) => n.type !== 'storey' && n.type !== 'ax');
    const allX = [...axisXVals, ...nonAxNodes.map((n) => n.x)];
    const allY = [...axisYVals, ...nonAxNodes.map((n) => n.y)];
    if (allX.length === 0) return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
    return {
      minX: Math.min(...allX),
      minY: Math.min(...allY),
      maxX: Math.max(...allX),
      maxY: Math.max(...allY),
    };
  }, [storeyNodes, axisXVals, axisYVals]);

  const W = (maxX - minX) * SCALE + PAD * 2;
  const H = (maxY - minY) * SCALE + PAD * 2;
  // Total canvas: building content + blank space around it for freehand notes, symbols, etc.
  const TW = W + CANVAS_MARGIN * 2;
  const TH = H + CANVAS_MARGIN * 2;
  boundsRef.current = { minX, minY, th: TH };

  // AutoCAD convention: X left→right (numeric 1,2,3...), Y bottom→top (letters A,B,C...).
  // SVG Y increases downward, so flip: larger BIM-Y → smaller SVG-Y (higher on screen).
  // Building content is centred inside TW × TH — CANVAS_MARGIN blank space on every side.
  function toSvg(wx: number, wy: number) {
    return {
      x: (wx - minX) * SCALE + PAD + CANVAS_MARGIN,
      y: TH - ((wy - minY) * SCALE + PAD + CANVAS_MARGIN),
    };
  }

  // Inverse of toSvg: SVG pixels → BIM mm
  function fromSvg(sx: number, sy: number) {
    return {
      x: (sx - PAD - CANVAS_MARGIN) / SCALE + minX,
      y: minY + (TH - sy - PAD - CANVAS_MARGIN) / SCALE,
    };
  }

  // Convert screen/client coords → BIM mm via the SVG's live screen CTM (handles pan/zoom).
  const clientToBim = useCallback((clientX: number, clientY: number) => {
    const loc = clientToSvgUserPoint(svgRef.current, clientX, clientY);
    if (!loc) return { x: 0, y: 0 };
    const { minX: mx, minY: my, th } = boundsRef.current;
    return {
      x: (loc.x - PAD - CANVAS_MARGIN) / SCALE + mx,
      y: my + (th - loc.y - PAD - CANVAS_MARGIN) / SCALE,
    };
  }, []);

  const fromSvgEvent = useCallback(
    (e: { clientX: number; clientY: number }) => clientToBim(e.clientX, e.clientY),
    [clientToBim],
  );

  // ── Armare 2D: leagă acest view de store-ul de armare (cheia = storeyId) ──
  const armareUnealta = useArmare((s) => s.unealta);
  const setArmareActiveView = useArmare((s) => s.setActiveView);
  const adaugaFormaLaPozitie = useArmare((s) => s.adaugaFormaLaPozitie);
  const armarePlaseaza = armareUnealta !== 'select';
  const canPickBim = !drawWallMode && !drawSectionMode && !sectionOnAxisMode && !annTool && !armarePlaseaza;
  const handlePickNode = useCallback((nodeId: string, e: React.MouseEvent) => {
    if (!canPickBim || !onSelectNode || e.shiftKey) return;
    e.stopPropagation();
    onSelectNode(selectedNodeId === nodeId ? null : nodeId);
  }, [canPickBim, onSelectNode, selectedNodeId]);
  const onContainerClick = useCallback((e: React.MouseEvent) => {
    if (!canPickBim || !onSelectNode || e.shiftKey) return;
    if (e.target === containerRef.current || e.target === svgRef.current) {
      onSelectNode(null);
    }
  }, [canPickBim, onSelectNode]);
  useEffect(() => {
    setArmareActiveView(storeyId ?? 'floorplan');
  }, [storeyId, setArmareActiveView]);

  // Plasează o formă de armare la punctul apăsat (când o unealtă e activă).
  const plaseazaArmare = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const u = useArmare.getState().unealta;
      if (u === 'select') return;
      const w = fromSvgEvent(e);
      adaugaFormaLaPozitie(u, { x: w.x, y: w.y });
    },
    [fromSvgEvent, adaugaFormaLaPozitie],
  );

  // Snap points: all axis intersections + axis midpoints + column node positions
  const snapPoints = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    // Axis grid intersections
    for (const x of axisXVals) for (const y of axisYVals) pts.push({ x, y });
    // Midpoints along X axis lines (between consecutive X, at each Y axis)
    for (let i = 0; i < axisXVals.length - 1; i++) {
      const mx = (axisXVals[i] + axisXVals[i + 1]) / 2;
      for (const y of axisYVals) pts.push({ x: mx, y });
    }
    // Midpoints along Y axis lines (at each X axis, between consecutive Y)
    for (let j = 0; j < axisYVals.length - 1; j++) {
      const my = (axisYVals[j] + axisYVals[j + 1]) / 2;
      for (const x of axisXVals) pts.push({ x, y: my });
    }
    // Cross midpoints (between both X and Y pairs)
    for (let i = 0; i < axisXVals.length - 1; i++) {
      const mx = (axisXVals[i] + axisXVals[i + 1]) / 2;
      for (let j = 0; j < axisYVals.length - 1; j++) {
        const my = (axisYVals[j] + axisYVals[j + 1]) / 2;
        pts.push({ x: mx, y: my });
      }
    }
    // Column node positions
    for (const n of storeyNodes) {
      if (n.type === 'column') pts.push({ x: n.x, y: n.y });
    }
    return pts;
  }, [axisXVals, axisYVals, storeyNodes]);

  // BIM mm coords for any node: ax nodes use storey grid axes, others use node.x/y directly
  const getNodeMmPos = (n: BubbleGraphNode): { x: number; y: number } => {
    if (n.type === 'ax') {
      return {
        x: axisXVals[Number(n.properties.gridX ?? 0)] ?? (axisXVals[0] ?? 0),
        y: axisYVals[Number(n.properties.gridY ?? 0)] ?? (axisYVals[0] ?? 0),
      };
    }
    return { x: n.x, y: n.y };
  };

  // Convert any node to SVG coords — delegates to getNodeMmPos then toSvg
  const getNodeSvgPos = (n: BubbleGraphNode) => {
    const { x, y } = getNodeMmPos(n);
    return toSvg(x, y);
  };

  const fromClientPos = clientToBim;

  // Snap cursor position to nearest snap point within SNAP_THRESHOLD_MM
  const findSnap = useCallback((pt: { x: number; y: number }) => {
    let best: { x: number; y: number } | null = null;
    let bestD = SNAP_THRESHOLD_MM;
    for (const p of snapPoints) {
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ?? pt;
  }, [snapPoints]);

  // Create a wall between two BIM mm points (reuse existing column nodes if close)
  const commitWall = useCallback((ptA: { x: number; y: number }, ptB: { x: number; y: number }) => {
    if (!storeyId) return;
    const REUSE_DIST = 100;
    const findExisting = (pt: { x: number; y: number }) =>
      storeyNodes.find(
        (n) => (n.type === 'column' || n.type === 'ax') &&
               Math.hypot(n.x - pt.x, n.y - pt.y) < REUSE_DIST,
      );

    const existingA = findExisting(ptA);
    const existingB = findExisting(ptB);
    const startId = existingA ? existingA.id : `node_${uid()}`;
    const endId   = existingB ? existingB.id : `node_${uid()}`;
    const wallId  = `node_${uid()}`;

    const colCount = rawNodes.filter((n) => n.type === 'column').length;
    const wallCount = rawNodes.filter((n) => n.type === 'wall').length;
    const newNodes: BubbleGraphNode[] = [];
    if (!existingA) {
      newNodes.push({
        id: startId, type: 'column',
        name: `Col${colCount + 1}`,
        x: ptA.x, y: ptA.y, z: 0,
        parentId: storeyId,
        properties: { column_type: 'C25x25' },
      });
    }
    if (!existingB) {
      newNodes.push({
        id: endId, type: 'column',
        name: `Col${colCount + newNodes.length + 1}`,
        x: ptB.x, y: ptB.y, z: 0,
        parentId: storeyId,
        properties: { column_type: 'C25x25' },
      });
    }
    newNodes.push({
      id: wallId, type: 'wall',
      name: `Wall${wallCount + 1}`,
      x: (ptA.x + ptB.x) / 2, y: (ptA.y + ptB.y) / 2, z: 0,
      parentId: storeyId,
      properties: { wall_type: 'W20' },
    });
    const newEdges: BubbleGraphEdge[] = [
      { id: `edge_${uid()}`, from: startId, to: wallId },
      { id: `edge_${uid()}`, from: wallId,  to: endId  },
    ];
    setBubbleGraph([...rawNodes, ...newNodes], [...rawEdges, ...newEdges]);
  }, [storeyId, storeyNodes, rawNodes, rawEdges, setBubbleGraph]);

  const commitSectionLine = useCallback((cut: PlanCut, lookSide: 'left' | 'right') => {
    if (!storeyId) return;
    if (Math.hypot(cut.x2 - cut.x1, cut.y2 - cut.y1) < 100) return;
    const result = commitPlanCut({
      nodes: rawNodes,
      edges: rawEdges,
      storeyId,
      cut,
      kind: 'section',
      lookSide,
    });
    setBubbleGraph(result.nodes, result.edges);
    setPendingOpenSectionId(result.sectionId);
    setSectionStart(null);
    setSectionLine(null);
    setPlanTool(null);
  }, [storeyId, rawNodes, rawEdges, setBubbleGraph, setPendingOpenSectionId, setPlanTool]);

  const commitSectionOnAxis = useCallback((pt: { x: number; y: number }) => {
    if (!storeyId) return;
    const hit = findNearestAxisLine(pt, axisXVals, axisYVals, 1000);
    if (!hit) return;
    const { cut, kind } = cutFromAxisLine(hit.dir, hit.value, { minX, maxX, minY, maxY });
    // The side of the grid line you clicked on is the side you look at.
    const result = commitPlanCut({
      nodes: rawNodes,
      edges: rawEdges,
      storeyId,
      cut,
      kind,
      lookSide: sideOfLine(cut, pt),
    });
    setBubbleGraph(result.nodes, result.edges);
    setPendingOpenSectionId(result.sectionId);
    setAxisHover(null);
    setPlanTool(null);
  }, [storeyId, axisXVals, axisYVals, minX, maxX, minY, maxY, rawNodes, rawEdges, setBubbleGraph, setPendingOpenSectionId, setPlanTool]);

  /** Marker edits from the plan (drag endpoints / depth / flip) → node properties. */
  const updateSectionProps = useCallback((nodeId: string, patch: Record<string, unknown>) => {
    const next = rawNodes.map((n) => {
      if (n.id !== nodeId) return n;
      const props = { ...n.properties };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete props[k]; else props[k] = v;
      }
      return { ...n, properties: props };
    });
    setBubbleGraph(next, rawEdges);
  }, [rawNodes, rawEdges, setBubbleGraph]);

  // ----- pan / zoom handlers
  // Use native non-passive listener so preventDefault() works (React 17+ registers onWheel as passive)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.max(0.1, Math.min(10, z * (1 - e.deltaY * 0.001))));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // ESC cancels draw-wall / section modes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (drawWallMode) {
        setWallStart(null);
        setHoverSnap(null);
        setHoverRaw(null);
        setDrawWallMode(false);
      }
      if (drawSectionMode || sectionOnAxisMode) {
        setSectionStart(null);
        setSectionLine(null);
        setHoverSnap(null);
        setHoverRaw(null);
        setAxisHover(null);
        setPlanTool(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawWallMode, drawSectionMode, sectionOnAxisMode, setPlanTool]);

  // Entering a plan section tool cancels wall / annotations
  useEffect(() => {
    if (planTool) {
      setDrawWallMode(false);
      setWallStart(null);
      setAnnTool(null);
      setSectionStart(null);
      setAxisHover(null);
    }
  }, [planTool]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // Draw section, ArchiCAD style: click A, click B (ortho unless Alt),
    // then click on the side you want to look at.
    if (drawSectionMode && e.button === 0 && !e.shiftKey) {
      const raw = fromClientPos(e.clientX, e.clientY);
      const snap = findSnap(raw);
      if (!sectionStart) {
        setSectionStart(snap);
      } else if (!sectionLine) {
        const { cut } = orthoConstrainCut(sectionStart, snap, e.altKey);
        if (Math.hypot(cut.x2 - cut.x1, cut.y2 - cut.y1) >= 100) setSectionLine(cut);
      } else {
        commitSectionLine(sectionLine, sideOfLine(sectionLine, raw));
      }
      return;
    }
    // Section on axis: click near a grid line
    if (sectionOnAxisMode && e.button === 0 && !e.shiftKey) {
      commitSectionOnAxis(fromClientPos(e.clientX, e.clientY));
      return;
    }
    // Draw wall mode: intercept left-click (not shift/middle for pan)
    if (drawWallMode && e.button === 0 && !e.shiftKey) {
      const snap = findSnap(fromClientPos(e.clientX, e.clientY));
      if (!wallStart) {
        setWallStart(snap);
      } else {
        commitWall(wallStart, snap);
        setWallStart(null);
        // Keep mode active for continuous wall placement
      }
      return;
    }
    if (e.button === 1 || e.shiftKey) {
      setDragging(true);
      lastPos.current = { x: e.clientX, y: e.clientY };
    }
  }, [drawWallMode, wallStart, findSnap, fromClientPos, commitWall, drawSectionMode, sectionOnAxisMode, sectionStart, sectionLine, commitSectionLine, commitSectionOnAxis]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (drawSectionMode) {
      const raw = fromClientPos(e.clientX, e.clientY);
      setHoverRaw(raw);
      setHoverSnap(findSnap(raw));
      setHoverAlt(e.altKey);
    } else if (sectionOnAxisMode) {
      setHoverRaw(null);
      const raw = fromClientPos(e.clientX, e.clientY);
      const hit = findNearestAxisLine(raw, axisXVals, axisYVals, 1000);
      setAxisHover(hit ? { dir: hit.dir, value: hit.value } : null);
    } else if (drawWallMode) {
      const raw = fromClientPos(e.clientX, e.clientY);
      setHoverRaw(raw);
      setHoverSnap(findSnap(raw));
    } else {
      setHoverRaw(null);
    }
    if (!dragging) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, [dragging, drawWallMode, drawSectionMode, sectionOnAxisMode, findSnap, fromClientPos, axisXVals, axisYVals]);

  const onMouseUp = useCallback(() => setDragging(false), []);

  const { config: matConfig } = useMaterialConfig();
  // Subscribe to window + door symbol config changes so floor-plan re-renders on edit
  useWindowSymbolConfig();
  const { resolve: resolveDoorCfg } = useDoorSymbolConfig();
  const resolveWinCfg = resolveWindowPlan2DConfig;
  // Subscribe to custom SVG symbol library (SymbolCanvas saves)
  const [, _symLibVer] = useState(0);
  useEffect(() => subscribeSymbolLibrary(() => _symLibVer((n) => n + 1)), []);
  // Subscribe to bglib symbol store changes (DXF-based parametric symbols)
  const [, _bglibVer] = useState(0);
  useEffect(() => {
    const unsub = subscribeBglibStore(() => _bglibVer((n) => n + 1));
    prewarmBglibSymbols('window').catch(() => {});
    prewarmBglibSymbols('door').catch(() => {});
    // initAutoSymbolList fetches the available DXF list first, then fetches only
    // the symbols that exist — avoids 404 noise for type IDs without DXF files.
    initAutoSymbolList('window').catch(() => {});
    initAutoSymbolList('door').catch(() => {});
    return unsub;
  }, []);

  // Subscribe to annotation drawing settings so the toolbar re-renders on external change
  const [annSettings, setAnnSettingsState] = useState<AnnotationDrawingSettings>(
    () => getAnnotationSettings(),
  );
  const [showDrawingPanel, setShowDrawingPanel] = useState(false);
  useEffect(() => subscribeAnnotationSettings(() => setAnnSettingsState(getAnnotationSettings())), []);

  // Pre-compute SVG hatch pattern defs for all element types that need them
  const hatchDefsHtml = useMemo(() => {
    const ELEMENT_TYPES = ['wall', 'column', 'beam', 'slab', 'foundation', 'shell', 'covering'];
    let defs = '';
    for (const et of ELEMENT_TYPES) {
      const vis = resolveVisuals(et, undefined, matConfig);
      if (vis.hatch && vis.hatch !== 'none' && vis.hatch !== 'solid') {
        // Section fill pattern
        defs += buildSvgHatchPattern(hatchPatId(et, 'sec'), vis.hatch, getSectionFillColor(vis), getSectionLineWeight(vis));
        // View (overhead) pattern
        defs += buildSvgHatchPattern(hatchPatId(et, 'view'), vis.hatch, getViewLineColor(vis), getViewLineWeight(vis));
      }
      // Named material patterns
      if (matConfig?.materials) {
        for (const [matId, matVis] of Object.entries(matConfig.materials)) {
          if ((matVis as MaterialVisuals).hatch && (matVis as MaterialVisuals).hatch !== 'none' && (matVis as MaterialVisuals).hatch !== 'solid') {
            const mv = matVis as MaterialVisuals;
            defs += buildSvgHatchPattern(hatchPatId(et, `${matId}_sec`), mv.hatch, getSectionFillColor(mv), getSectionLineWeight(mv));
          }
        }
      }
    }
    return defs;
  }, [matConfig]);

  // Full nodeMap (ALL nodes, not just storey-filtered) so calcShellPolygon can resolve
  // ax parent storey and cross-storey edges correctly — same as 3D viewers.
  const nodeMap = useMemo(() => new Map(expandedNodes.map((n) => [n.id, n])), [expandedNodes]);

  // Precompute wall join results for all walls (auto/butt/miter/square_off)
  const wallJoins = useMemo(() => calcWallJoins(expandedNodes, edges), [expandedNodes, edges]);

  // Shell/covering nodes for this storey: either parentId matches OR connected to storey ax nodes.
  // Simpler: just show all shell/covering nodes whose connected anchors are in the current storey.
  const shellNodes = useMemo(() => {
    // Pitched roof coverings are drawn by the dedicated roof-plan layer below, not here.
    const isShell = (n: BubbleGraphNode) =>
      (n.type === 'shell' || n.type === 'covering') && n.properties.pitched !== true;
    if (!storeyId) return expandedNodes.filter(isShell);
    return expandedNodes.filter((n) =>
      isShell(n) &&
      (n.parentId === storeyId || !n.parentId ||
        edges.some((e) => (e.from === n.id || e.to === n.id) &&
          storeyNodes.some((sn) => sn.id === (e.from === n.id ? e.to : e.from))))
    );
  }, [expandedNodes, edges, storeyId, storeyNodes]);

  // Parametric roofs whose plan should be drawn on this storey (overhead linework).
  const roofPlans = useMemo(() => {
    const roofs = expandedNodes.filter((n) =>
      n.type === 'roof' && (!storeyId || n.parentId === storeyId || !n.parentId));
    const out: { id: string; plan: RoofPlan }[] = [];
    for (const r of roofs) {
      try {
        const plan = buildRoofPlan(r, expandedNodes, edges);
        if (plan) out.push({ id: r.id, plan });
      } catch { /* skip a roof that fails to resolve rather than break the whole plan */ }
    }
    return out;
  }, [expandedNodes, edges, storeyId]);

  const storeyDisc = (storeyMeta?.properties?.discipline as StoreyDiscipline) ?? discipline ?? 'architectural';
  const discColor  = DISC_COLORS[storeyDisc];
  const elevBottom = storeyMeta?.properties?.bottomElevation as number | undefined;
  const elevTop    = storeyMeta?.properties?.topElevation    as number | undefined;

  // Storey band in mm — used for cut-level logic
  const storeyBottomMm = elevBottom ?? 0;
  const storeyTopMm    = elevTop    ?? storeyBottomMm + 3000;
  // Absolute elevation of the horizontal cut plane (mm)
  const cutAbsElevMm   = storeyBottomMm + cutHeightMm;

  return (
    <div
      ref={containerRef}
      className={cn('relative w-full h-full bg-[#fafafa] dark:bg-[#16161e] overflow-hidden select-none', className)}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onClick={onContainerClick}
      style={{ cursor: drawWallMode ? 'crosshair' : dragging ? 'grabbing' : 'default' }}
    >
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${TW} ${TH}`}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '50% 50%',
          transition: dragging ? 'none' : 'transform 0.05s',
        }}
      >
        {/* ── SVG hatch pattern defs ── */}
        <defs dangerouslySetInnerHTML={{ __html: hatchDefsHtml }} />

        {canPickBim && onSelectNode && (
          <rect
            x={0} y={0} width={TW} height={TH}
            fill="transparent"
            data-fit-ignore=""
            onClick={() => onSelectNode(null)}
          />
        )}

        {/* ── Armare: suprafață de plasare (activă doar când o unealtă e selectată) ── */}
        {armarePlaseaza && (
          <rect
            x={0}
            y={0}
            width={TW}
            height={TH}
            fill="transparent"
            data-fit-ignore=""
            style={{ cursor: 'crosshair' }}
            onPointerDown={(e) => {
              e.stopPropagation();
              plaseazaArmare(e);
            }}
          />
        )}

        {/* ── Axis grid ── */}
        {axisXVals.map((ax, i) => {
          const sx = toSvg(ax, minY); // ax is absolute mm world coord
          return (
            <g key={`ax-x-${i}`}>
              <line
                x1={sx.x} y1={CANVAS_MARGIN + PAD / 2}
                x2={sx.x} y2={CANVAS_MARGIN + H - PAD / 2}
                stroke={discColor} strokeWidth="0.5" strokeDasharray="6 4" opacity="0.4"
              />
              <circle cx={sx.x} cy={CANVAS_MARGIN + PAD / 2} r="7" fill="none" stroke={discColor} strokeWidth="0.8" opacity="0.5" />
              <text x={sx.x} y={CANVAS_MARGIN + PAD / 2 + 3.5} textAnchor="middle" fontSize="7" fill={discColor} opacity="0.7">{i + 1}</text>
              <circle cx={sx.x} cy={CANVAS_MARGIN + H - PAD / 2} r="7" fill="none" stroke={discColor} strokeWidth="0.8" opacity="0.5" />
              <text x={sx.x} y={CANVAS_MARGIN + H - PAD / 2 + 3.5} textAnchor="middle" fontSize="7" fill={discColor} opacity="0.7">{i + 1}</text>
            </g>
          );
        })}
        {axisYVals.map((ay, i) => {
          const sy = toSvg(minX, ay); // ay is absolute mm world coord
          return (
            <g key={`ax-y-${i}`}>
              <line
                x1={CANVAS_MARGIN + PAD / 2} y1={sy.y}
                x2={CANVAS_MARGIN + W - PAD / 2} y2={sy.y}
                stroke={discColor} strokeWidth="0.5" strokeDasharray="6 4" opacity="0.4"
              />
              <circle cx={CANVAS_MARGIN + PAD / 2} cy={sy.y} r="7" fill="none" stroke={discColor} strokeWidth="0.8" opacity="0.5" />
              <text x={CANVAS_MARGIN + PAD / 2} y={sy.y + 3.5} textAnchor="middle" fontSize="7" fill={discColor} opacity="0.7">
                {String.fromCharCode(65 + i)}
              </text>
              <circle cx={CANVAS_MARGIN + W - PAD / 2} cy={sy.y} r="7" fill="none" stroke={discColor} strokeWidth="0.8" opacity="0.5" />
              <text x={CANVAS_MARGIN + W - PAD / 2} y={sy.y + 3.5} textAnchor="middle" fontSize="7" fill={discColor} opacity="0.7">
                {String.fromCharCode(65 + i)}
              </text>
            </g>
          );
        })}

        {/* ── Shell / Roof outlines — overhead view (above cut plane → dashed outline + break ticks, no opaque fill) ── */}
        {shellNodes.map((n) => {
          const poly = calcShellPolygon(n, nodeMap, edges);
          if (!poly || poly.length < 3) return null;
          const offsets = parseContourOffsets(n.properties.contour_offset);
          const thickMm = Number(n.type === 'covering' ? (n.properties.thickness ?? 150) : (n.properties.thickness ?? 200));
          const inward = offsets.map((o) => -o);
          const outer = insetPolygon(poly, inward);
          const inner = insetPolygon(poly, inward.map((v) => v + thickMm));
          if (outer.length < 3) return null;
          const shellVis = resolveVisuals(n.type, String(n.properties?.material ?? ''), matConfig);
          // Shell/covering is ABOVE the horizontal cut plane → overhead view rules (not section)
          const vwLineC = getViewLineColor(shellVis);
          const vwLineW = Math.max(0.5, getViewLineWeight(shellVis));
          const vwLineStyle = lineStyleToDashArray(getViewLineStyle(shellVis)) ?? '5 3';

          // Helper: break-line ticks at midpoint of each edge, perpendicular to edge direction.
          // Placed at EDGE MIDPOINTS (not corners) so ticks don't overlap structural junctions.
          const TICK_SVG = 6 * SCALE;
          const ringTicks = (pts: { x: number; y: number }[], keyPrefix: string) =>
            pts.map((curr, i) => {
              const next = pts[(i + 1) % pts.length];
              const cs = toSvg(curr.x, curr.y);
              const ns = toSvg(next.x, next.y);
              const eDx = ns.x - cs.x, eDy = ns.y - cs.y;
              const eLen = Math.sqrt(eDx * eDx + eDy * eDy);
              if (eLen < 4) return null; // skip very short edges
              const mx = (cs.x + ns.x) / 2, my = (cs.y + ns.y) / 2;
              // Perpendicular to edge (left-hand normal)
              const perpX = -eDy / eLen, perpY = eDx / eLen;
              return (
                <line key={`${keyPrefix}_${i}`}
                  x1={mx - perpX * TICK_SVG} y1={my - perpY * TICK_SVG}
                  x2={mx + perpX * TICK_SVG} y2={my + perpY * TICK_SVG}
                  stroke={vwLineC} strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
              );
            });

          return (
            <g key={n.id} opacity="0.5">
              {/* Overhead dashed outline — outer polygon (no solid fill!) */}
              <polygon
                points={outer.map((p) => { const s = toSvg(p.x, p.y); return `${s.x},${s.y}`; }).join(' ')}
                fill="none"
                stroke={vwLineC}
                strokeWidth={vwLineW}
                strokeDasharray={vwLineStyle}
                strokeLinejoin="miter" />
              {/* Inner polygon outline (ring opening boundary) */}
              {inner.length >= 3 && (
                <polygon
                  points={inner.map((p) => { const s = toSvg(p.x, p.y); return `${s.x},${s.y}`; }).join(' ')}
                  fill="none"
                  stroke={vwLineC}
                  strokeWidth={vwLineW * 0.7}
                  strokeDasharray={vwLineStyle}
                  strokeLinejoin="miter" />
              )}
              {/* Break-line ticks — outer edge (material cut boundary) */}
              {ringTicks(outer, 'o')}
              {/* Break-line ticks — inner edge (ring opening / gap boundary) */}
              {inner.length >= 3 && ringTicks(inner, 'i')}
            </g>
          );
        })}

        {/* ── Parametric roof plan — eave outline + ridge/hip/valley + slope arrows ── */}
        {roofPlans.map(({ id, plan }) => {
          const roofVis = resolveVisuals('roof', undefined, matConfig);
          const col = getViewLineColor(roofVis);
          const styleFor = (role: string): { w: number; dash?: string } => {
            switch (role) {
              case 'ridge': return { w: 2.0 };
              case 'hip': return { w: 1.4 };
              case 'valley': return { w: 1.4, dash: '6 3' };
              case 'break': return { w: 1.2, dash: '3 3' };
              default: return { w: 1.2 }; // eave
            }
          };
          const ARR = 5 * SCALE; // arrowhead size
          return (
            <g key={`roofplan_${id}`} opacity="0.85" style={{ pointerEvents: 'none' }}>
              {plan.segments.map((s, i) => {
                const a = toSvg(s.a.x, s.a.y), b = toSvg(s.b.x, s.b.y);
                const st = styleFor(s.role);
                return (
                  <line key={`rs_${id}_${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={col} strokeWidth={st.w} strokeLinecap="round"
                    strokeLinejoin="round" strokeDasharray={st.dash} />
                );
              })}
              {plan.arrows.map((ar, i) => {
                const f = toSvg(ar.from.x, ar.from.y), t = toSvg(ar.to.x, ar.to.y);
                const dx = t.x - f.x, dy = t.y - f.y, L = Math.hypot(dx, dy) || 1;
                const ux = dx / L, uy = dy / L, px = -uy, py = ux;
                const h1x = t.x - ux * ARR + px * ARR * 0.5, h1y = t.y - uy * ARR + py * ARR * 0.5;
                const h2x = t.x - ux * ARR - px * ARR * 0.5, h2y = t.y - uy * ARR - py * ARR * 0.5;
                return (
                  <g key={`ra_${id}_${i}`}>
                    <line x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke={col} strokeWidth="1" opacity="0.7" />
                    <path d={`M${h1x},${h1y} L${t.x},${t.y} L${h2x},${h2y}`} fill="none" stroke={col} strokeWidth="1" opacity="0.7" />
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* ── Walls + opening symbols (single pass) ── */}
        {storeyNodes.filter((n) => n.type === 'wall').flatMap((wn) => {
          // ── Wall geometry from canonical engine (includes footprint with join corners) ──
          const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins);
          if (!geo) return [];
          const fp = geo.footprint; // BIM mm CCW: [outerStart, outerEnd, innerEnd, innerStart]
          if (fp.length < 4) return [];

          // Join-adjusted wall axis in BIM mm
          const MM = 0.001;
          const sxMm = geo.sxM / MM, szMm = -geo.szM / MM;
          const exMm = geo.exM / MM, ezMm = -geo.ezM / MM;
          const joinDx = exMm - sxMm, joinDy = ezMm - szMm;
          const joinLen = Math.sqrt(joinDx * joinDx + joinDy * joinDy);
          if (joinLen < 1) return [];
          const ux = joinDx / joinLen, uy = joinDy / joinLen;

          const wallThMm = geo.wallThick * 1000; // metres → mm
          const halfTh = Math.max(2, wallThMm * SCALE) / 2;

          // SVG perpendicular: wall SVG dir = (ux, −uy), perp = (uy, ux)
          const px = uy, py = ux;

          const wallVis     = resolveVisuals('wall', String(wn.properties?.material ?? ''), matConfig);
          const wallBeamVis = resolveVisuals('beam', String(wn.properties?.beam_material ?? ''), matConfig);
          const hasBeam = String(wn.properties.has_beam ?? '').toLowerCase() === 'true';
          const bsec    = String(wn.properties.beam_section ?? 'B20x30');
          const secLineC = getSectionLineColor(wallVis);
          const secLineW = getSectionLineWeight(wallVis);
          const vwLineW  = getViewLineWeight(wallVis);   // seen/view line weight (thin)
          const secFillO = getSectionFillOpacity(wallVis);
          const fillVal  = sectionFill(hatchPatId('wall', String(wn.properties?.material ?? 'sec')), wallVis);

          // Helpers: SVG positions along wall centreline at mm distance t from join-adjusted start
          const wPt     = (t: number) => toSvg(sxMm + ux * t, szMm + uy * t);
          const wOuter  = (t: number) => { const p = wPt(t); return { x: p.x + px * halfTh, y: p.y + py * halfTh }; };
          const wInner  = (t: number) => { const p = wPt(t); return { x: p.x - px * halfTh, y: p.y - py * halfTh }; };

          // Footprint edge interpolation (f = fraction 0..1 along wall)
          // Outer edge: fp[0] → fp[1], Inner edge: fp[3] → fp[2]
          const fpOuterSvg = (f: number) => toSvg(
            fp[0].x + (fp[1].x - fp[0].x) * f,
            fp[0].y + (fp[1].y - fp[0].y) * f,
          );
          const fpInnerSvg = (f: number) => toSvg(
            fp[3].x + (fp[2].x - fp[3].x) * f,
            fp[3].y + (fp[2].y - fp[3].y) * f,
          );

          // Opening intervals from geometry engine (mm from join-adjusted start)
          const intervals = geo.openings.map((op) => ({
            node:  op.node,
            t0:    op.tS / MM,                // metres → mm from join-adjusted start
            t1:    (op.tS + op.oW) / MM,      // metres → mm from join-adjusted start
          }));

          // Solid wall segments between openings (mm from join-adjusted start)
          const solidSegs: { s: number; e: number }[] = [];
          let prev = 0;
          for (const { t0, t1 } of intervals) {
            if (t0 > prev + 0.5) solidSegs.push({ s: prev, e: t0 });
            prev = t1;
          }
          if (prev < joinLen - 0.5) solidSegs.push({ s: prev, e: joinLen });

          const els: React.ReactElement[] = [];
          const wallSelected = selectedNodeId === wn.id;

          // ── Solid wall segment polygons — interpolated from footprint edges ──
          // The footprint already incorporates join geometry (miter/butt corners).
          solidSegs.forEach((seg, i) => {
            const f0 = seg.s / joinLen; // fraction 0..1
            const f1 = seg.e / joinLen;
            const aO = fpOuterSvg(f0), bO = fpOuterSvg(f1);
            const bI = fpInnerSvg(f1), aI = fpInnerSvg(f0);

            els.push(
              <polygon key={`${wn.id}_s${i}`}
                points={`${aO.x},${aO.y} ${bO.x},${bO.y} ${bI.x},${bI.y} ${aI.x},${aI.y}`}
                fill={fillVal}
                fillOpacity={secFillO}
                stroke={wallSelected ? '#2563eb' : secLineC}
                strokeWidth={wallSelected ? secLineW + 1.5 : secLineW}
                strokeLinejoin="miter"
                onClick={canPickBim ? (e) => handlePickNode(wn.id, e) : undefined}
                style={canPickBim ? { cursor: 'pointer' } : undefined} />,
            );
          });

          // Optional embedded beam — rendered as a filled rectangle cross-section in plan
          if (hasBeam) {
            const { bw: wbwM, bh: wbhM } = parseBeamDims(bsec);
            // Beam bottom is at storeyTop − beamHeight; compare against cut plane
            const wbBeamBotMm = storeyTopMm - wbhM * 1000;
            const wbAboveCut  = wbBeamBotMm >= cutAbsElevMm;
            if (!wbAboveCut || showBeamsAboveCut) {
              const s0 = wPt(0), sE = wPt(joinLen);
              const hw  = Math.max(1, wbwM * 1000 * SCALE) / 2; // half cross-section width in SVG units
              const bPts = [
                `${s0.x + px * hw},${s0.y + py * hw}`,
                `${sE.x + px * hw},${sE.y + py * hw}`,
                `${sE.x - px * hw},${sE.y - py * hw}`,
                `${s0.x - px * hw},${s0.y - py * hw}`,
              ].join(' ');
              const bFill    = wbAboveCut ? 'none' : sectionFill(hatchPatId('beam', String(wn.properties?.beam_material ?? 'sec')), wallBeamVis);
              const bStrokeC = wbAboveCut ? getViewLineColor(wallBeamVis) : getSectionLineColor(wallBeamVis);
              const bStrokeW = getSectionLineWeight(wallBeamVis);
              const bDA      = wbAboveCut ? (lineStyleToDashArray('dashed') ?? '4 2') : lineStyleToDashArray(getSectionLineStyle(wallBeamVis));
              els.push(
                <polygon key={`${wn.id}_beam`}
                  points={bPts}
                  fill={bFill}
                  fillOpacity={wbAboveCut ? 0 : getSectionFillOpacity(wallBeamVis)}
                  stroke={bStrokeC}
                  strokeWidth={bStrokeW}
                  strokeDasharray={bDA ?? undefined}
                  opacity={wbAboveCut ? 0.5 : 1} />,
              );
            }
          }

          // ── Opening symbols ──
          // Shell/covering dashed outline (rendered before walls in SVG z-order) is intentionally
          // visible through WINDOW gaps as overhead "overview" lines.
          // Door gaps get a white mask to keep the swing symbol readable.
          intervals.forEach(({ node: opNode, t0, t1 }, opIdx) => {
            // Opening corners from footprint edges (same basis as wall gap polygons).
            // Centreline + fixed half-thickness misaligns symbols near wall ends/joins.
            const f0 = t0 / joinLen;
            const f1 = t1 / joinLen;
            const sfO = fpOuterSvg(f0), stO = fpOuterSvg(f1);
            const sfI = fpInnerSvg(f0), stI = fpInnerSvg(f1);
            const pt0 = { x: (sfO.x + sfI.x) / 2, y: (sfO.y + sfI.y) / 2 };
            const pt1 = { x: (stO.x + stI.x) / 2, y: (stO.y + stI.y) / 2 };
            const openDx = pt1.x - pt0.x;
            const openDy = pt1.y - pt0.y;
            const openLenSvg = Math.hypot(openDx, openDy) || 1;
            const openUx = openDx / openLenSvg;
            const openUy = openDy / openLenSvg;
            let outNx = sfO.x - pt0.x;
            let outNy = sfO.y - pt0.y;
            const outLen = Math.hypot(outNx, outNy) || 1;
            outNx /= outLen;
            outNy /= outLen;
            const o0OuterBim = {
              x: fp[0].x + (fp[1].x - fp[0].x) * f0,
              y: fp[0].y + (fp[1].y - fp[0].y) * f0,
            };
            const o1OuterBim = {
              x: fp[0].x + (fp[1].x - fp[0].x) * f1,
              y: fp[0].y + (fp[1].y - fp[0].y) * f1,
            };
            const oWmm = Math.hypot(o1OuterBim.x - o0OuterBim.x, o1OuterBim.y - o0OuterBim.y);
            const oWsvg = oWmm * SCALE;
            // Unique key per interval instance: wall id + node id + instance index
            // (same node can appear multiple times when count > 1)
            const opKey = `${wn.id}_op_${opNode.id}_${opIdx}`;
            // (sfC/stC not used here — window uses resolveWinCfg positions, door uses sfI/stI)

            if (opNode.type === 'window') {
              // ── Configurable 3-line window symbol (positions from WindowSymbolConfigurator) ──
              const winCfg = resolveWinCfg(
                String(opNode.properties.window_type ?? ''),
                String(opNode.properties.opening ?? 'single'),
              );
              const winFlipAcross = String(opNode.properties.flip_across ?? '').toLowerCase() === 'true';

              // ── Cut-zone from geometry ──────────────────────────────────────────────────────
              // Determines line weight: thick = cut plane through opening, thin = sill parapet visible
              const cutZone = getOpeningCutZone(opNode, storeyBottomMm, cutAbsElevMm);
              if (cutZone === 'above-lintel') return; // wall is solid at cut height → no window in plan

              // Line weights derived from wall material config (NOT from window configurator):
              //   cut zone  → section line weight (same as wall section = thick)
              //   sill zone → view line weight (seen from above = thin)
              const frameLineW  = cutZone === 'cut' ? secLineW        : vwLineW * 0.8;
              const jambLineW   = cutZone === 'cut' ? secLineW * 0.7  : vwLineW * 0.6;
              const glassLineW  = cutZone === 'cut' ? secLineW * 0.4  : vwLineW * 0.35;
              const frameColor  = winCfg.frameColor;
              const glassColor  = winCfg.glassColor;

              // ── Build layer color + lineweight maps from resolved window config ──
              const winLayerColors: Record<string, string> = {
                frame: frameColor,
                glass: glassColor,
                sill:  winCfg.sillLineColor,
              };
              const winLayerLineWeights: Record<string, number> = {
                frame: frameLineW,
                glass: glassLineW,
                '0':   frameLineW,   // DXF layer 0 = default geometry → treat as frame weight
              };

              const openingClipId = `woclip_${opKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
              const openingClipPts = `${sfO.x},${sfO.y} ${stO.x},${stO.y} ${stI.x},${stI.y} ${sfI.x},${sfI.y}`;
              const wrapOpeningClip = (content: React.ReactElement) => (
                <g
                  key={opKey}
                  onClick={canPickBim ? (e) => handlePickNode(opNode.id, e) : undefined}
                  style={canPickBim ? { cursor: 'pointer' } : undefined}
                >
                  <defs>
                    <clipPath id={openingClipId}>
                      <polygon points={openingClipPts} />
                    </clipPath>
                  </defs>
                  <g clipPath={`url(#${openingClipId})`}>{content}</g>
                </g>
              );

              const depthNx = (sfI.x - sfO.x) / (Math.hypot(sfI.x - sfO.x, sfI.y - sfO.y) || 1);
              const depthNy = (sfI.y - sfO.y) / (Math.hypot(sfI.x - sfO.x, sfI.y - sfO.y) || 1);
              const windowSymbolMatrix = (S: number) => {
                if (winFlipAcross) {
                  return `matrix(${(openUx * S).toFixed(4)},${(-openUy * S).toFixed(4)},` +
                    `${(-depthNx * S).toFixed(4)},${(-depthNy * S).toFixed(4)},` +
                    `${sfI.x.toFixed(2)},${sfI.y.toFixed(2)})`;
                }
                return `matrix(${(openUx * S).toFixed(4)},${(-openUy * S).toFixed(4)},` +
                  `${(depthNx * S).toFixed(4)},${(depthNy * S).toFixed(4)},` +
                  `${sfO.x.toFixed(2)},${sfO.y.toFixed(2)})`;
              };

              // ── Priority 0: auto-symbol from symbols2d/{typeId}.dxf ──
              const winTypeId  = String(opNode.properties.window_type ?? '');
              // opening: explicit node override → library type default → 'single'
              const winOpening = String(
                opNode.properties.opening
                ?? WINDOW_TYPE_MAP.get(winTypeId)?.opening
                ?? 'single',
              );
              const autoSym = resolveAutoSymbol('window', winTypeId)
                ?? resolveAutoSymbol('window', `opening_${winOpening}`);
              // ── Priority 1: manually assigned bglib symbol ──
              const assignedSym = !autoSym
                ? (resolveBglibSymbol('window', winTypeId) ?? resolveBglibSymbol('window', winOpening))
                : null;
              const bglibSym = autoSym ?? assignedSym;
              if (bglibSym) {
                const FLOORPLAN_SKIP_LAYERS = ['sill'];
                const elements = renderBglibSymbolElements(
                  bglibSym, oWmm, wallThMm, 1, false,
                  winLayerColors, undefined, FLOORPLAN_SKIP_LAYERS, 'floorplan',
                  winLayerLineWeights,
                );
                const S = SCALE;
                const matrixStr = windowSymbolMatrix(S);
                els.push(wrapOpeningClip(
                  <g
                    transform={matrixStr}
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: elements.join('\n') }}
                  />,
                ));
                return;
              }
              // ── Priority 2: custom SVG symbol from SymbolCanvas ──
              const customSym  = resolveSymbolDef('window', winTypeId, 'floorplan')
                ?? resolveSymbolDef('window', `opening:${winOpening}`, 'floorplan');
              if (customSym) {
                const symParams = buildWindowSymRenderParams(winCfg, oWmm, wallThMm);
                const elements  = renderSymbolInlineElements(customSym, symParams);
                const S = SCALE;
                const matrixStr = windowSymbolMatrix(S);
                els.push(wrapOpeningClip(
                  <g
                    transform={matrixStr}
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: elements.join('\n') }}
                  />,
                ));
                return;
              }

              // ── Priority 3: hardcoded 3-line symbol — weights from geometry (cut-zone) ──
              const sqHalfMm = Math.min(winCfg.squareSide_mm / 2, Math.max(0, oWmm / 2 - 0.5));
              const sqHSvg   = sqHalfMm * SCALE;
              const glHSvg   = Math.min(winCfg.glassPanelWidth_mm * SCALE / 2, halfTh * 0.95);
              const gOutX = winFlipAcross ? -outNx : outNx;
              const gOutY = winFlipAcross ? -outNy : outNy;

              const jamb0 = { x: pt0.x + openUx * sqHSvg, y: pt0.y + openUy * sqHSvg };
              const jamb1 = { x: pt1.x - openUx * sqHSvg, y: pt1.y - openUy * sqHSvg };
              const midPt = { x: (pt0.x + pt1.x) / 2, y: (pt0.y + pt1.y) / 2 };
              const fo0 = sfO, fo1 = stO, fi0 = sfI, fi1 = stI;

              const squarePts = (cx: number, cy: number) => [
                { x: cx + openUx * sqHSvg + outNx * sqHSvg, y: cy + openUy * sqHSvg + outNy * sqHSvg },
                { x: cx - openUx * sqHSvg + outNx * sqHSvg, y: cy - openUy * sqHSvg + outNy * sqHSvg },
                { x: cx - openUx * sqHSvg - outNx * sqHSvg, y: cy - openUy * sqHSvg - outNy * sqHSvg },
                { x: cx + openUx * sqHSvg - outNx * sqHSvg, y: cy + openUy * sqHSvg - outNy * sqHSvg },
              ];

              const frameSquareCenters = winOpening === 'double' && oWmm >= winCfg.squareSide_mm * 1.5
                ? [jamb0, midPt, jamb1]
                : [jamb0, jamb1];

              const drawGlassSpan = (a: { x: number; y: number }, b: { x: number; y: number }, key: string) => (
                <g key={key}>
                  <line x1={a.x + gOutX * glHSvg} y1={a.y + gOutY * glHSvg}
                        x2={b.x + gOutX * glHSvg} y2={b.y + gOutY * glHSvg}
                    stroke={glassColor} strokeWidth={glassLineW * 0.8} />
                  <line x1={a.x - gOutX * glHSvg} y1={a.y - gOutY * glHSvg}
                        x2={b.x - gOutX * glHSvg} y2={b.y - gOutY * glHSvg}
                    stroke={glassColor} strokeWidth={glassLineW * 0.8} />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={glassColor} strokeWidth={glassLineW} />
                </g>
              );

              els.push(wrapOpeningClip(
                <g>
                  {/* White mask — exact opening footprint */}
                  <polygon
                    points={openingClipPts}
                    fill="white" stroke="none" />

                  {/* Glass lines — split for double casements */}
                  {winCfg.showGlassPanel && (
                    winOpening === 'double' && oWmm >= winCfg.squareSide_mm * 1.5
                      ? (<>
                        {drawGlassSpan(jamb0, { x: midPt.x - openUx * sqHSvg, y: midPt.y - openUy * sqHSvg }, 'gL')}
                        {drawGlassSpan({ x: midPt.x + openUx * sqHSvg, y: midPt.y + openUy * sqHSvg }, jamb1, 'gR')}
                      </>)
                      : drawGlassSpan(pt0, pt1, 'gS')
                  )}

                  {/* Frame squares — inset from opening jambs */}
                  {winCfg.showFrameSquares && frameSquareCenters.map((cp, ji) => (
                    <polygon key={ji}
                      points={squarePts(cp.x, cp.y).map((c) => `${c.x},${c.y}`).join(' ')}
                      fill="white" stroke={frameColor} strokeWidth={frameLineW} />
                  ))}

                  {/* Outer frame line — weight from geometry */}
                  <line x1={fo0.x} y1={fo0.y} x2={fo1.x} y2={fo1.y}
                    stroke={frameColor} strokeWidth={frameLineW} strokeLinecap="square" />
                  {/* Inner frame line — weight from geometry */}
                  <line x1={fi0.x} y1={fi0.y} x2={fi1.x} y2={fi1.y}
                    stroke={frameColor} strokeWidth={frameLineW} strokeLinecap="square" />

                  {/* Left jamb reveal — weight from geometry */}
                  <line x1={fo0.x} y1={fo0.y} x2={fi0.x} y2={fi0.y}
                    stroke={frameColor} strokeWidth={jambLineW} />
                  {/* Right jamb reveal — weight from geometry */}
                  <line x1={fo1.x} y1={fo1.y} x2={fi1.x} y2={fi1.y}
                    stroke={frameColor} strokeWidth={jambLineW} />
                </g>,
              ));
            } else {
              // Door — panel hangs on one wall face, arc sweeps into adjacent space
              //
              // flip_along  (matches 3D placed.scale.x *= -1): mirror hinge end along wall
              //   → XOR with swing property to get final hingeAtStart
              // flip_across (matches 3D placed.scale.z *= -1): mirror to opposite wall face
              //   → panel swings from outer face instead of inner face, sweep direction inverts
              const swingRight   = String(opNode.properties.swing     ?? 'left').toLowerCase() === 'right';
              const flipAlong    = String(opNode.properties.flip_along  ?? '').toLowerCase() === 'true';
              const flipAcross   = String(opNode.properties.flip_across ?? '').toLowerCase() === 'true';
              const hingeAtStart = swingRight === flipAlong;
              const hinge     = hingeAtStart
                ? (flipAcross ? sfO : sfI)
                : (flipAcross ? stO : stI);
              const closedEnd = hingeAtStart
                ? (flipAcross ? stO : stI)
                : (flipAcross ? sfO : sfI);
              const panelDir  = flipAcross ? 1 : -1;
              const panelEndX = hinge.x + px * panelDir * oWsvg;
              const panelEndY = hinge.y + py * panelDir * oWsvg;
              const sweepFlag = (hingeAtStart !== flipAcross) ? 1 : 0;

              // Resolve door visual config from the global door symbol registry
              const doorTypeId = String(opNode.properties.door_type ?? 'D-SWING-90x210');
              const swingType  = String(opNode.properties.swing ?? 'left');
              const dCfg = resolveDoorCfg(doorTypeId, swingType);

              // ── Custom SVG symbol from Symbol Studio ──
              const doorCustomSym = resolveSymbolDef('door', doorTypeId, 'floorplan')
                ?? resolveSymbolDef('door', `swing:${swingType}`, 'floorplan');
              if (doorCustomSym) {
                const oWmm = t1 - t0;
                const symParams = buildDoorSymRenderParams(dCfg, oWmm, wallThMm);
                const elements = renderSymbolInlineElements(doorCustomSym, symParams);
                const S = SCALE;
                const [cxDir, cyDir, ox, oy] = flipAcross
                  ? [px * S, py * S, sfI.x, sfI.y]
                  : [-px * S, -py * S, sfO.x, sfO.y];
                const matrixStr =
                  `matrix(${(ux * S).toFixed(4)},${(-uy * S).toFixed(4)},` +
                  `${cxDir.toFixed(4)},${cyDir.toFixed(4)},` +
                  `${ox.toFixed(2)},${oy.toFixed(2)})`;
                els.push(
                  <g key={opKey}
                    transform={matrixStr}
                    onClick={canPickBim ? (e) => handlePickNode(opNode.id, e) : undefined}
                    style={canPickBim ? { cursor: 'pointer' } : undefined}
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: elements.join('\n') }}
                  />,
                );
                return;
              }

              els.push(
                <g
                  key={opKey}
                  onClick={canPickBim ? (e) => handlePickNode(opNode.id, e) : undefined}
                  style={canPickBim ? { cursor: 'pointer' } : undefined}
                >
                  {/* White gap mask for door (only when showWhiteMask) */}
                  {dCfg.showWhiteMask && (
                    <polygon
                      points={`${sfO.x},${sfO.y} ${stO.x},${stO.y} ${stI.x},${stI.y} ${sfI.x},${sfI.y}`}
                      fill="white" stroke="none" />
                  )}
                  {/* White sector behind swing arc */}
                  {dCfg.showWhiteMask && (
                    <path
                      d={`M ${hinge.x},${hinge.y} L ${panelEndX},${panelEndY} A ${oWsvg},${oWsvg} 0 0 ${sweepFlag} ${closedEnd.x},${closedEnd.y} Z`}
                      fill="white" stroke="none" />
                  )}
                  {/* Wall-break lines (outer jambs) */}
                  {dCfg.showWallBreaks && (<>
                    <line x1={sfO.x} y1={sfO.y} x2={sfI.x} y2={sfI.y}
                      stroke={dCfg.breakLineColor} strokeWidth={dCfg.breakLineWeight} />
                    <line x1={stO.x} y1={stO.y} x2={stI.x} y2={stI.y}
                      stroke={dCfg.breakLineColor} strokeWidth={dCfg.breakLineWeight} />
                  </>)}
                  {/* Header line at outer wall face */}
                  <line x1={sfO.x} y1={sfO.y} x2={stO.x} y2={stO.y}
                    stroke={dCfg.panelColor} strokeWidth={dCfg.panelLineWeight * 1.2} strokeLinecap="square" />
                  {/* Door panel */}
                  {dCfg.showDoorPanel && (
                    <line x1={hinge.x} y1={hinge.y} x2={panelEndX} y2={panelEndY}
                      stroke={dCfg.panelColor} strokeWidth={dCfg.panelLineWeight} />
                  )}
                  {/* Swing arc */}
                  {dCfg.showSwingArc && (
                    <path
                      d={`M ${panelEndX} ${panelEndY} A ${oWsvg} ${oWsvg} 0 0 ${sweepFlag} ${closedEnd.x} ${closedEnd.y}`}
                      fill="none" stroke={dCfg.arcColor} strokeWidth={dCfg.arcLineWeight} strokeDasharray="4 2" />
                  )}
                </g>,
              );
            }
          });

          return els;
        })}


        {/* ── Standalone Beams (node-centric, rendered as plan-view rectangle) ── */}
        {storeyNodes.filter((n) => n.type === 'beam').map((bn) => {
          const ENDPOINT_TYPES = new Set(['ax', 'column', 'foundation', 'wall']);
          const connected = edges
            .filter((e) => e.from === bn.id || e.to === bn.id)
            .map((e) => nodeMap.get(e.from === bn.id ? e.to : e.from))
            .filter((n): n is BubbleGraphNode => !!n && ENDPOINT_TYPES.has(n.type));
          if (connected.length < 2) return null;

          const mmA = getNodeMmPos(connected[0]), mmB = getNodeMmPos(connected[1]);
          const { sx: bsxMm, sy: bsyMm, ex: bexMm, ey: beyMm } = calcSpanEffectiveEnds(bn, { x: mmA.x, y: mmA.y }, { x: mmB.x, y: mmB.y }, connected[0], connected[1], nodeMap);
          const sf = toSvg(bsxMm, bsyMm);
          const st = toSvg(bexMm, beyMm);

          const beamVis = resolveVisuals('beam', String(bn.properties?.material ?? ''), matConfig);
          const bsec    = String(bn.properties.beam_section ?? bn.properties.beam_type ?? 'B30x60');
          const { bw: bwM, bh: bhM } = parseBeamDims(bsec);

          // Cut-level check: beam hangs from storey top; beam bottom = storeyTop − beamHeight
          const beamBotMm  = storeyTopMm - bhM * 1000;
          const isAboveCut = beamBotMm >= cutAbsElevMm;
          if (isAboveCut && !showBeamsAboveCut) return null;

          // Plan footprint: rectangle along the span, width = cross-section width
          const ddx = st.x - sf.x, ddy = st.y - sf.y;
          const blen = Math.sqrt(ddx * ddx + ddy * ddy);
          if (blen < 1) return null;
          const bnx = -ddy / blen, bny = ddx / blen;            // perp unit vector in SVG space
          const hw  = Math.max(1, bwM * 1000 * SCALE) / 2;      // half cross-section width (SVG units)
          const bPts = [
            `${sf.x + bnx * hw},${sf.y + bny * hw}`,
            `${st.x + bnx * hw},${st.y + bny * hw}`,
            `${st.x - bnx * hw},${st.y - bny * hw}`,
            `${sf.x - bnx * hw},${sf.y - bny * hw}`,
          ].join(' ');

          // Appearance from material config: section style when cut, view style when above cut
          const bFillStr = isAboveCut ? 'none' : sectionFill(hatchPatId('beam', String(bn.properties?.material ?? 'sec')), beamVis);
          const bStrokeC = isAboveCut ? getViewLineColor(beamVis) : getSectionLineColor(beamVis);
          const bStrokeW = isAboveCut ? getViewLineWeight(beamVis) : getSectionLineWeight(beamVis);
          const bDA      = isAboveCut
            ? (lineStyleToDashArray(getViewLineStyle(beamVis)) ?? '5 3')
            : lineStyleToDashArray(getSectionLineStyle(beamVis));

          const beamSelected = selectedNodeId === bn.id;
          return (
            <polygon key={bn.id}
              points={bPts}
              fill={bFillStr}
              fillOpacity={isAboveCut ? 0 : getSectionFillOpacity(beamVis)}
              stroke={beamSelected ? '#2563eb' : bStrokeC}
              strokeWidth={beamSelected ? bStrokeW + 1.5 : bStrokeW}
              strokeDasharray={bDA ?? undefined}
              opacity={isAboveCut ? 0.55 : 1}
              onClick={canPickBim ? (e) => handlePickNode(bn.id, e) : undefined}
              style={canPickBim ? { cursor: 'pointer' } : undefined} />
          );
        })}

        {/* ── Other edges (non-wall, non-beam structural connections) ── */}
        {storeyEdges
          .filter((e) => {
            const f = storeyNodes.find((n) => n.id === e.from);
            const t = storeyNodes.find((n) => n.id === e.to);
            return f && t
              && f.type !== 'wall'  && t.type !== 'wall'
              && f.type !== 'beam'  && t.type !== 'beam';
          })
          .map((e) => {
            const from = storeyNodes.find((n) => n.id === e.from)!;
            const to   = storeyNodes.find((n) => n.id === e.to)!;
            const sf   = getNodeSvgPos(from);
            const st   = getNodeSvgPos(to);
            return (
              <line key={e.id} x1={sf.x} y1={sf.y} x2={st.x} y2={st.y}
                stroke="#94a3b8" strokeWidth="0.8" strokeLinecap="round"
                strokeDasharray="4 3" opacity="0.4" />
            );
          })
        }

        {/* ── Section / View markers — global (shown on ALL floor plans), edited in place ── */}
        <SectionMarkerLayer
          nodes={expandedNodes}
          edges={edges}
          toSvg={toSvg}
          scale={SCALE}
          clientToBim={clientToBim}
          onOpen={setPendingOpenSectionId}
          onUpdateProps={updateSectionProps}
          interactive={canPickBim}
        />

        {/* ── Nodes ── */}
        {storeyNodes.map((node) => {
          if (node.type === 'storey') return null; // skip storey meta-node
          if (node.type === 'wall' || node.type === 'beam') return null; // rendered as geometry lines above
          if (node.type === 'window' || node.type === 'door') return null; // rendered as symbols above
          if (node.type === 'section' || node.type === 'view') return null; // rendered as cut symbols above
          if (node.type === 'shell' || node.type === 'covering') return null; // rendered as overhead outlines above
          if (node.type === 'roof' || ROOF_GENERATED_TYPES.has(node.type)) return null; // rendered by the roof-plan layer above
          if (node.type === 'slab' && !showSlabs) return null; // hidden unless user enables slabs
          if (node.type === 'void') {
            // Void node: dashed orange rect (box) or circle (cylinder) at host position + offset
            const shape = String(node.properties.void_shape ?? 'box') === 'cylinder' ? 'cylinder' : 'box';
            const w2d  = Number(node.properties.width  ?? 500) * SCALE;
            const d2d  = Number(node.properties.depth  ?? 500) * SCALE;
            const r2d  = Number(node.properties.radius ?? 250) * SCALE;
            const ox   = Number(node.properties.offset_x ?? 0);
            const oy   = Number(node.properties.offset_y ?? 0);
            // Resolve host plan position
            let hx = node.x, hy = node.y;
            for (const e of edges) {
              if (e.from !== node.id && e.to !== node.id) continue;
              const host = nodeMap.get(e.from === node.id ? e.to : e.from);
              if (!host || host.type === 'void') continue;
              const hp = getNodeBimPos(host, nodeMap);
              hx = hp.x; hy = hp.y;
              break;
            }
            const vs = toSvg(hx + ox, hy + oy);
            return (
              <g key={node.id} opacity="0.75">
                {shape === 'cylinder' ? (
                  <circle cx={vs.x} cy={vs.y} r={r2d}
                    fill="#fed7aa33" stroke="#f97316" strokeWidth="0.8" strokeDasharray="4 2" />
                ) : (
                  <rect x={vs.x - w2d / 2} y={vs.y - d2d / 2} width={w2d} height={d2d}
                    fill="#fed7aa33" stroke="#f97316" strokeWidth="0.8" strokeDasharray="4 2" />
                )}
                <text x={vs.x} y={vs.y + 2} textAnchor="middle" fontSize="5"
                  fill="#f97316" fontWeight="bold" opacity="0.9">VOID</text>
              </g>
            );
          }
          if (node.type === 'object') {
            // Library object: plan-view bounding box with cross diagonals + label
            const w2d   = Number(node.properties.width_mm  ?? 600) * SCALE;
            const d2d   = Number(node.properties.depth_mm  ?? 600) * SCALE;
            const label = String(node.properties.label ?? node.name ?? '');
            const os    = toSvg(node.x, node.y);
            const rotDeg = getNodeLocalTransform(node).ry;
            const xfStr  = rotDeg !== 0 ? `rotate(${-rotDeg},${os.x},${os.y})` : undefined;
            return (
              <g key={node.id} transform={xfStr} opacity="0.85">
                <rect x={os.x - w2d / 2} y={os.y - d2d / 2} width={w2d} height={d2d}
                  fill="#ede9fe44" stroke="#8b5cf6" strokeWidth="0.7" />
                {/* Cross diagonals — BIM convention for furniture in plan */}
                <line x1={os.x - w2d / 2} y1={os.y - d2d / 2} x2={os.x + w2d / 2} y2={os.y + d2d / 2}
                  stroke="#8b5cf6" strokeWidth="0.4" opacity="0.5" />
                <line x1={os.x + w2d / 2} y1={os.y - d2d / 2} x2={os.x - w2d / 2} y2={os.y + d2d / 2}
                  stroke="#8b5cf6" strokeWidth="0.4" opacity="0.5" />
                {label && (
                  <text x={os.x} y={os.y + 3} textAnchor="middle" fontSize="6"
                    fill="#7c3aed" fontWeight="500" opacity="0.9">{label}</text>
                )}
              </g>
            );
          }
          if (node.type === 'room') {
            const roomColorHex = (node.properties.color as string | undefined)?.trim() ||
              resolveVisuals('room', '', matConfig).color_3d || '#14b8a6';
            const poly = calcRoomPolygon(node, nodeMap, edges);
            if (poly && poly.length >= 3) {
              const svgPts = poly.map((p) => {
                const sp = toSvg(p.x, p.y);
                return `${sp.x},${sp.y}`;
              }).join(' ');
              const centBim = { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
              const centSvg = toSvg(centBim.x, centBim.y);
              // Compute area in m² (shoelace in mm² → /1e6)
              let area2 = 0;
              for (let i = 0; i < poly.length; i++) {
                const j = (i + 1) % poly.length;
                area2 += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
              }
              const area_m2 = Math.abs(area2) / 2e6;
              const roomSelected = selectedNodeId === node.id;
              return (
                <g key={node.id}>
                  <polygon points={svgPts}
                    fill={roomColorHex + '28'}
                    stroke={roomSelected ? '#2563eb' : roomColorHex}
                    strokeWidth={roomSelected ? 1.2 : 0.6}
                    strokeDasharray="4 3"
                    opacity="0.9"
                    onClick={canPickBim ? (e) => handlePickNode(node.id, e) : undefined}
                    style={canPickBim ? { cursor: 'pointer' } : undefined}
                  />
                  <text x={centSvg.x} y={centSvg.y - 4} textAnchor="middle" fontSize="7"
                    fill={roomColorHex} fontWeight="bold" opacity="0.9">{node.name}</text>
                  <text x={centSvg.x} y={centSvg.y + 5} textAnchor="middle" fontSize="5.5"
                    fill={roomColorHex} opacity="0.75">{area_m2.toFixed(1)} m²</text>
                </g>
              );
            }
            // Fallback: just label at node canvas position
            const rs = toSvg(node.x, node.y);
            return (
              <text key={node.id} x={rs.x} y={rs.y + 3} textAnchor="middle" fontSize="7"
                fill={roomColorHex} fontWeight="bold" opacity="0.7">{node.name}</text>
            );
          }
          const s = toSvg(node.x, node.y);
          const vis    = resolveVisuals(node.type, String(node.properties?.material ?? ''), matConfig);
          const fill   = vis.color_2d;
          const isAxis = node.type === 'ax';

          if (isAxis) {
            // position from axesX[gridX] / axesY[gridY] — NOT from node.x/y (canvas position)
            const rx = axisXVals[Number(node.properties.gridX ?? 0)] ?? (axisXVals[0] ?? 0);
            const ry = axisYVals[Number(node.properties.gridY ?? 0)] ?? (axisYVals[0] ?? 0);
            const sa = toSvg(rx, ry);
            const hasCol = String(node.properties.has_column ?? '').toLowerCase() === 'true';
            // Column section from type string — 'C25x25' → 25 cm × 25 cm → 250 mm | 'CR30' → ∅30 cm circle
            const colType = String(node.properties.column_type ?? 'C25x25');
            const colCirc = /^[Cc][Rr](\d+)$/.test(colType);
            const colM    = colCirc ? colType.match(/^[Cc][Rr](\d+)$/) : colType.match(/[Cc](\d+)x(\d+)/);
            const colW    = colM ? +colM[1] * 10 * SCALE : 250 * SCALE;
            const colD    = (!colCirc && colM) ? +colM[2] * 10 * SCALE : colW;
            const colR    = colW / 2; // radius in SVG units when circular
            const xfAttr  = nodeTransformAttr(node, sa.x, sa.y);
            const colVis  = applyNodeColorOverrides(resolveVisuals('column', String(node.properties?.material ?? ''), matConfig), node.properties);
            const colFillC = getSectionFillColor(colVis);
            const colStrokeC = getSectionLineColor(colVis);
            const colSelected = selectedNodeId === node.id;
            return (
              <g key={node.id} transform={xfAttr}>
                {hasCol ? (
                  colCirc ? (
                    <circle cx={sa.x} cy={sa.y} r={colR}
                      fill={colFillC}
                      stroke={colSelected ? '#2563eb' : colStrokeC}
                      strokeWidth={colSelected ? getSectionLineWeight(colVis) + 1.5 : getSectionLineWeight(colVis)}
                      opacity={getSectionFillOpacity(colVis)}
                      onClick={canPickBim ? (e) => handlePickNode(node.id, e) : undefined}
                      style={canPickBim ? { cursor: 'pointer' } : undefined} />
                  ) : (
                    <rect x={sa.x - colW / 2} y={sa.y - colD / 2} width={colW} height={colD}
                      fill={colFillC}
                      stroke={colSelected ? '#2563eb' : colStrokeC}
                      strokeWidth={colSelected ? getSectionLineWeight(colVis) + 1.5 : getSectionLineWeight(colVis)}
                      opacity={getSectionFillOpacity(colVis)}
                      onClick={canPickBim ? (e) => handlePickNode(node.id, e) : undefined}
                      style={canPickBim ? { cursor: 'pointer' } : undefined} />
                  )
                ) : (
                  <circle cx={sa.x} cy={sa.y} r="3" fill="none" stroke={discColor} strokeWidth="0.8" opacity="0.6" />
                )}
              </g>
            );
          }

          if (node.type === 'space') {
            const w = ((node.properties?.width as number) ?? 200) * SCALE;
            const h = ((node.properties?.height as number) ?? 200) * SCALE;
            const xfAttr = nodeTransformAttr(node, s.x, s.y);
            return (
              <g key={node.id} transform={xfAttr}>
                <rect x={s.x - w / 2} y={s.y - h / 2} width={w} height={h}
                  fill={fill} stroke="#6366f1" strokeWidth={0.8 * vis.line_weight} opacity={vis.opacity_2d} />
                <text x={s.x} y={s.y + 3} textAnchor="middle" fontSize="8" fill="#6366f1" opacity="0.9">{node.name}</text>
              </g>
            );
          }

          const nodeSelected = selectedNodeId === node.id;
          const xfAttr = nodeTransformAttr(node, s.x, s.y);
          return (
            <g key={node.id} transform={xfAttr}>
              <circle cx={s.x} cy={s.y} r="5"
                fill={fill}
                stroke={nodeSelected ? '#2563eb' : '#fff'}
                strokeWidth={nodeSelected ? 2 : 0.6 * vis.line_weight}
                opacity={vis.opacity_2d}
                onClick={canPickBim ? (e) => handlePickNode(node.id, e) : undefined}
                style={canPickBim ? { cursor: 'pointer' } : undefined} />
              <text x={s.x} y={s.y - 7} textAnchor="middle" fontSize="6" fill="#64748b">{node.name}</text>
            </g>
          );
        })}

        {/* ── Title block — pinned to bottom of building area (stays inside building bounds) ── */}
        <rect x={CANVAS_MARGIN + PAD / 2} y={CANVAS_MARGIN + H - PAD / 2 + 12} width={W - PAD} height="16" fill={discColor} opacity="0.07" rx="2" />
        <text x={CANVAS_MARGIN + PAD} y={CANVAS_MARGIN + H - PAD / 2 + 23} fontSize="8" fill={discColor} fontWeight="bold">
          {storeyMeta?.name ?? 'All Storeys'}
          {elevBottom !== undefined && ` | Elev. ${elevBottom}–${elevTop ?? '?'} mm`}
          {`  |  ${storeyDisc.toUpperCase()}`}
        </text>

        {/* Scale indicator */}
        <line x1={CANVAS_MARGIN + W - PAD - 40} y1={CANVAS_MARGIN + H - PAD / 2 + 24} x2={CANVAS_MARGIN + W - PAD} y2={CANVAS_MARGIN + H - PAD / 2 + 24} stroke="#94a3b8" strokeWidth="1.5" />
        <text x={CANVAS_MARGIN + W - PAD - 20} y={CANVAS_MARGIN + H - PAD / 2 + 20} textAnchor="middle" fontSize="6" fill="#94a3b8">
          {Math.round(40 / SCALE / 1000)} m
        </text>

        {/* ── Draw Wall overlay ── */}
        {drawWallMode && hoverRaw && (() => {
          const hs = toSvg(hoverRaw.x, hoverRaw.y);
          const snapDist = hoverSnap
            ? Math.hypot(hoverSnap.x - hoverRaw.x, hoverSnap.y - hoverRaw.y)
            : 0;
          const showSnap = hoverSnap && snapDist > 1;
          const ss = showSnap ? toSvg(hoverSnap.x, hoverSnap.y) : null;
          const r = 5;
          return (
            <g key="draw-wall-hover" style={{ pointerEvents: 'none' }}>
              {/* Snap crosshair */}
              <line x1={hs.x - 12} y1={hs.y} x2={hs.x + 12} y2={hs.y} stroke="#3b82f6" strokeWidth="1.2" />
              <line x1={hs.x} y1={hs.y - 12} x2={hs.x} y2={hs.y + 12} stroke="#3b82f6" strokeWidth="1.2" />
              <circle cx={hs.x} cy={hs.y} r={r} fill="#3b82f6" fillOpacity="0.3" stroke="#3b82f6" strokeWidth="1" />
              {showSnap && ss && (
                <circle cx={ss.x} cy={ss.y} r={7} fill="none" stroke="#22c55e" strokeWidth="1.2" strokeDasharray="3 2" />
              )}
              {/* Rubber-band line from start to hover */}
              {wallStart && (() => {
                const ws = toSvg(wallStart.x, wallStart.y);
                const he = showSnap && hoverSnap ? toSvg(hoverSnap.x, hoverSnap.y) : hs;
                return (
                  <>
                    <line x1={ws.x} y1={ws.y} x2={he.x} y2={he.y} stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="6 3" />
                    <circle cx={ws.x} cy={ws.y} r={r} fill="#22c55e" fillOpacity="0.7" stroke="#22c55e" strokeWidth="1.5" />
                  </>
                );
              })()}
            </g>
          );
        })()}

        {/* ── Draw Section overlay: A, B, then the viewed side ── */}
        {drawSectionMode && hoverRaw && (() => {
          const color = '#e11d48';
          const preview = sectionLine
            ? { cut: sectionLine }
            : sectionStart && hoverSnap
              ? orthoConstrainCut(sectionStart, hoverSnap, hoverAlt)
              : null;
          const displayPt = preview && !sectionLine
            ? { x: preview.cut.x2, y: preview.cut.y2 }
            : hoverRaw;
          const hs = toSvg(displayPt.x, displayPt.y);
          const snapDist = !sectionStart && hoverSnap
            ? Math.hypot(hoverSnap.x - hoverRaw.x, hoverSnap.y - hoverRaw.y)
            : 0;
          const showSnap = !sectionStart && hoverSnap && snapDist > 1;
          const snapSvg = showSnap ? toSvg(hoverSnap.x, hoverSnap.y) : null;
          return (
            <g key="draw-section-hover" style={{ pointerEvents: 'none' }}>
              {!sectionLine && (
                <>
                  <line x1={hs.x - 12} y1={hs.y} x2={hs.x + 12} y2={hs.y} stroke={color} strokeWidth="1.2" />
                  <line x1={hs.x} y1={hs.y - 12} x2={hs.x} y2={hs.y + 12} stroke={color} strokeWidth="1.2" />
                  <circle cx={hs.x} cy={hs.y} r={5} fill={color} fillOpacity="0.35" stroke={color} strokeWidth="1" />
                </>
              )}
              {showSnap && snapSvg && (
                <circle cx={snapSvg.x} cy={snapSvg.y} r={7} fill="none" stroke={color} strokeWidth="1.2" strokeDasharray="3 2" />
              )}
              {preview && (() => {
                const ss = toSvg(preview.cut.x1, preview.cut.y1);
                const ee = toSvg(preview.cut.x2, preview.cut.y2);
                const len = Math.hypot(ee.x - ss.x, ee.y - ss.y) || 1;
                const ux = (ee.x - ss.x) / len;
                const uy = (ee.y - ss.y) / len;
                // Band on the side the cursor is on (BIM left = SVG (uy, -ux)).
                const side = sectionLine ? sideOfLine(preview.cut, hoverRaw) : 'left';
                const nx = side === 'left' ? uy : -uy;
                const ny = side === 'left' ? -ux : ux;
                const depth = 40;
                return (
                  <>
                    <polygon
                      points={`${ss.x},${ss.y} ${ss.x + nx * depth},${ss.y + ny * depth} ${ee.x + nx * depth},${ee.y + ny * depth} ${ee.x},${ee.y}`}
                      fill={color + '22'}
                      stroke={color + '66'}
                      strokeWidth="0.8"
                      strokeDasharray="4 3"
                    />
                    <line x1={ss.x} y1={ss.y} x2={ee.x} y2={ee.y} stroke={color} strokeWidth="2" />
                    <circle cx={ss.x} cy={ss.y} r={5} fill={color} fillOpacity="0.8" />
                    {sectionLine && <circle cx={ee.x} cy={ee.y} r={5} fill={color} fillOpacity="0.8" />}
                    <text x={(ss.x + ee.x) / 2 - nx * 10} y={(ss.y + ee.y) / 2 - ny * 10} textAnchor="middle" fontSize="8" fill={color} fontWeight="bold">
                      {sectionLine ? 'Clic pe partea privită' : hoverAlt ? 'Secțiune (liber)' : 'Secțiune'}
                    </text>
                  </>
                );
              })()}
            </g>
          );
        })()}

        {/* ── Section-on-axis hover highlight ── */}
        {sectionOnAxisMode && axisHover && (() => {
          const color = '#e11d48';
          if (axisHover.dir === 'Y') {
            const a = toSvg(minX - 500, axisHover.value);
            const b = toSvg(maxX + 500, axisHover.value);
            return (
              <g key="axis-section-hover" style={{ pointerEvents: 'none' }}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth="2.5" strokeDasharray="8 4" opacity={0.85} />
                <text x={(a.x + b.x) / 2} y={a.y - 10} textAnchor="middle" fontSize="9" fill={color} fontWeight="bold">
                  Secțiune pe Y={Math.round(axisHover.value)} — clic pe partea privită
                </text>
              </g>
            );
          }
          const a = toSvg(axisHover.value, minY - 500);
          const b = toSvg(axisHover.value, maxY + 500);
          return (
            <g key="axis-section-hover" style={{ pointerEvents: 'none' }}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth="2.5" strokeDasharray="8 4" opacity={0.85} />
              <text x={a.x + 10} y={(a.y + b.y) / 2} textAnchor="start" fontSize="9" fill={color} fontWeight="bold">
                Secțiune pe X={Math.round(axisHover.value)} — clic pe partea privită
              </text>
            </g>
          );
        })()}

        {/* ── Annotation layer ── */}
        <SvgAnnotationLayer
          viewId={storeyId ?? 'floorplan:all'}
          toSvg={toSvg}
          fromSvgEvent={fromSvgEvent}
          activeTool={annTool}
          onToolDone={() => { /* keep tool active for repeated placement */ }}
          snapPoints={snapPoints}
          snapThreshold={200}
          fontSizeSvg={annSettings.fontSizeSvg}
          strokeSvg={annSettings.strokeSvg}
          dimColor={annSettings.dimColor}
          textColor={annSettings.textColor}
          drawColor={annSettings.drawColor}
          fillColor={annSettings.fillColor}
          fillOpacity={annSettings.fillOpacity}
          strokeStyle={annSettings.strokeStyle}
          fontBold={annSettings.fontBold}
          hatchPattern={annSettings.hatchPattern}
          hatchSpacing={annSettings.hatchSpacing}
          hatchAngle={annSettings.hatchAngle}
          hatchOpacity={annSettings.hatchOpacity}
          selectedId={selectedAnnotationId}
          onSelectAnnotation={selectAnnotation}
        />
        {/* ── Armare 2D: forme, grips, selecție ── */}
        <RebarLayer toSvg={toSvg} fromSvgEvent={fromSvgEvent} scale={SCALE} />
      </svg>

      {/* ── Armare 2D: paletă + proprietăți ── */}
      {!embedded && <RebarPanel />}

      {/* ── Annotation toolbar ── */}
      {!embedded && <div className="absolute top-2 left-2 z-10 flex items-center gap-1 bg-background/85 border border-border/60 rounded-md px-1.5 py-1 backdrop-blur-sm shadow-sm">
        {/* Draw Wall authoring button */}
        <button
          title={drawWallMode ? 'Draw Wall — click to place (ESC to cancel)' : 'Draw Wall — click two points to create a wall'}
          onClick={() => {
            setDrawWallMode(!drawWallMode);
            setWallStart(null);
            setHoverSnap(null);
            setHoverRaw(null);
            setAnnTool(null);
            setPlanTool(null);
          }}
          className={cn(
            'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none font-bold',
            drawWallMode
              ? 'bg-orange-500 text-white'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >▭</button>
        <button
          title={drawSectionMode ? 'Secțiune — clic A, clic B, apoi clic pe partea privită (Alt = unghi liber, ESC anulează)' : 'Secțiune — clic A, clic B, apoi clic pe partea privită'}
          onClick={() => {
            setPlanTool(drawSectionMode ? null : 'draw-section');
            setSectionStart(null);
            setSectionLine(null);
            setHoverSnap(null);
            setHoverRaw(null);
            setDrawWallMode(false);
            setAnnTool(null);
          }}
          className={cn(
            'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none font-bold',
            drawSectionMode
              ? 'bg-rose-600 text-white'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >✂</button>
        <button
          title={sectionOnAxisMode ? 'Secțiune pe ax — clic lângă un ax, pe partea privită (ESC anulează)' : 'Secțiune pe ax — clic lângă un ax, pe partea privită'}
          onClick={() => {
            setPlanTool(sectionOnAxisMode ? null : 'section-on-axis');
            setAxisHover(null);
            setDrawWallMode(false);
            setAnnTool(null);
          }}
          className={cn(
            'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none font-bold',
            sectionOnAxisMode
              ? 'bg-rose-600 text-white'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >⊕</button>
        <div className="w-px h-4 bg-border mx-0.5" />
        {([
          { tool: 'select'    as SvgAnnotationTool, icon: '↖',  title: 'Select / move annotation' },
          { tool: 'text'      as SvgAnnotationTool, icon: 'T',  title: 'Place text label' },
          { tool: 'dimension' as SvgAnnotationTool, icon: '↔',  title: 'Linear dimension — click p1, p2, then offset side' },
          { tool: 'leader'    as SvgAnnotationTool, icon: '↗',  title: 'Leader with text — click points, double-click to finish' },
          { tool: 'line'      as SvgAnnotationTool, icon: '╱',  title: 'Single line' },
          { tool: 'arc'       as SvgAnnotationTool, icon: '⌒',  title: 'Arc — click center, start point, end point' },
          { tool: 'polyline'  as SvgAnnotationTool, icon: '╮',  title: 'Polyline — click points, double-click to finish' },
          { tool: 'rect'      as SvgAnnotationTool, icon: '▭',  title: 'Rectangle — click first corner, then opposite corner' },
          { tool: 'circle'    as SvgAnnotationTool, icon: '○',  title: 'Circle — click center, then edge point' },
          { tool: 'hatch'     as SvgAnnotationTool, icon: '▦',  title: 'Hatch fill — click polygon points, double-click to close' },
          { tool: 'join'      as SvgAnnotationTool, icon: '⋈',  title: 'Join — click two lines/polylines to merge endpoints' },
          { tool: 'trim'      as SvgAnnotationTool, icon: '✂',  title: 'Trim — click cutter line, then target line near end to trim' },
          { tool: 'eraser'    as SvgAnnotationTool, icon: '✕',  title: 'Eraser — click an annotation to delete it' },
        ]).map(({ tool, icon, title }) => (
          <button
            key={tool}
            title={title}
            onClick={() => setAnnTool(annTool === tool ? null : tool)}
            className={cn(
              'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none',
              annTool === tool
                ? 'bg-blue-600 text-white'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >{icon}</button>
        ))}
        <div className="w-px h-4 bg-border mx-0.5" />
        <button
          title="Clear all annotations for this view"
          onClick={() => clearViewAnnotations(storeyId ?? 'floorplan:all')}
          className="w-6 h-6 flex items-center justify-center text-xs rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 transition-colors"
        >🗑</button>
        <div className="w-px h-4 bg-border mx-0.5" />
        {/* Drawing properties panel toggle */}
        <button
          title="Drawing properties panel"
          onClick={() => { setShowDrawingPanel(!showDrawingPanel); setShowFilterPanel(false); }}
          className={cn(
            'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none',
            showDrawingPanel ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >🎨</button>
        <div className="w-px h-4 bg-border mx-0.5" />
        {/* Cut plane / visibility filter button */}
        <button
          title="Cut level & visibility filters"
          onClick={() => { setShowFilterPanel(!showFilterPanel); setShowDrawingPanel(false); }}
          className={cn(
            'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none',
            showFilterPanel ? 'bg-indigo-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >⚙</button>
      </div>}

      {/* ── Drawing properties panel ── */}
      {!embedded && showDrawingPanel && (
        <div className="absolute top-10 left-2 z-20">
          <DrawingPropertiesPanel
            activeTool={annTool}
            onToolChange={(t) => { setAnnTool(t); }}
            onClose={() => setShowDrawingPanel(false)}
          />
        </div>
      )}

      {/* ── Cut-plane & filter panel ── */}
      {!embedded && showFilterPanel && (
        <div className="absolute top-10 left-2 z-20 bg-background border border-border/70 rounded-lg shadow-lg p-3 min-w-[220px] text-xs">
          <div className="font-semibold text-foreground mb-2 flex items-center justify-between">
            <span>Cut plane & visibility</span>
            <button onClick={() => setShowFilterPanel(false)} className="text-muted-foreground hover:text-foreground ml-2">✕</button>
          </div>

          {/* Cut height */}
          <div className="mb-3">
            <label className="block text-muted-foreground mb-1">
              Cut height above floor
            </label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                value={cutHeightMm}
                min={0}
                max={storeyTopMm - storeyBottomMm}
                step={50}
                onChange={(e) => setCutHeightMm(Math.max(0, Number(e.target.value)))}
                className="w-20 px-1.5 py-0.5 border border-border rounded text-xs bg-background focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <span className="text-muted-foreground">mm</span>
              <button
                onClick={() => setCutHeightMm(1500)}
                className="px-1.5 py-0.5 text-[10px] rounded border border-border/50 text-muted-foreground hover:bg-accent"
                title="Reset to default 1500 mm"
              >↺</button>
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              Storey: {storeyBottomMm} – {storeyTopMm} mm
              &nbsp;| cut @ {storeyBottomMm + cutHeightMm} mm
            </div>
          </div>

          {/* Visibility toggles */}
          <div className="border-t border-border/40 pt-2 space-y-1.5">
            <div className="text-muted-foreground font-medium mb-1">Show elements</div>
            {[
              {
                label: 'Beams above cut',
                sublabel: 'Projected dashed outline',
                value: showBeamsAboveCut,
                set: setShowBeamsAboveCut,
              },
              {
                label: 'Slabs',
                sublabel: 'Floor / ceiling plates',
                value: showSlabs,
                set: setShowSlabs,
              },
            ].map(({ label, sublabel, value, set }) => (
              <label key={label} className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={(e) => set(e.target.checked)}
                  className="accent-indigo-500"
                />
                <span>
                  <span className="text-foreground">{label}</span>
                  <span className="text-muted-foreground ml-1">— {sublabel}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Controls hint */}
      {!embedded && <div className="absolute bottom-3 right-3 text-[10px] text-muted-foreground space-y-0.5 text-right pointer-events-none">
        {drawSectionMode ? (
          <>
            <div className="text-rose-500 font-semibold">{sectionStart ? '2nd point → create cut' : '1st point → cut start'}</div>
            <div>Ortho: horizontal = section · vertical = elevation</div>
            <div>ESC — cancel</div>
          </>
        ) : sectionOnAxisMode ? (
          <>
            <div className="text-rose-500 font-semibold">Click a grid line</div>
            <div>Y line → section · X line → elevation</div>
            <div>ESC — cancel</div>
          </>
        ) : drawWallMode ? (
          <>
            <div className="text-orange-500 font-semibold">{wallStart ? '2nd point → confirm wall' : '1st point → wall start'}</div>
            <div>ESC — cancel</div>
          </>
        ) : (
          <>
            <div>Shift+drag — pan</div>
            <div>Scroll — zoom</div>
            <div>Click section mark — open</div>
          </>
        )}
      </div>}

      {/* Zoom badge */}
      {!embedded && <div className="absolute bottom-3 left-3 text-[10px] text-muted-foreground bg-background/60 px-1.5 py-0.5 rounded border border-border/40">
        {Math.round(zoom * 100)}%
      </div>}
    </div>
  );
}
