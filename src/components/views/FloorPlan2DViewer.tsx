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
import { getNodeLocalTransform, resolveOpeningDims, calcShellPolygon, parseContourOffsets, insetPolygon, calcSpanEffectiveEnds, calcRoomPolygon, getNodeBimPos, getAxRealPos, collectOpenings, getEndpointAutoOffset, parseBeamDims, calcWallJoins, calcWallGeometry, getWallJoinProp, type OpeningInfo, type WallJoinResult } from '@/lib/bimGeometry';
import { unionWallRings, wallFaces, wallSolidPolygons } from '@/lib/plan/wallSilhouette';
import { defaultDoorPlanDef } from '@/lib/symbolTemplates/planDefaults';
import { buildRoofPlan, ROOF_GENERATED_TYPES, type RoofPlan } from '@/lib/roof';
import { buildStairPlan, STAIR_GENERATED_TYPES, type StairPlan } from '@/lib/stair';
import { computeSweep } from '@/lib/sweep';
import {
  applySketchDim, computeSketch, parseSketchIntent, serialiseOutline, setSketchRefs, sketchDims, sketchOutline,
  worldToLocal, type SketchFrame, type SketchTransform,
} from '@/lib/sketch';
import {
  dragVertex, paramsForCircle, paramsForRect, translateShape,
  type ShapeParams, type SketchShape,
} from '@/lib/sketch/shapes';
import { computeScatter, scatterSymbol, type ScatterInstance } from '@/lib/scatter';
import { computeFacade } from '@/lib/facade';
import { terrainItemInstances } from '@/lib/scatter/terrainItems';
import { computeSite, findSiteNode } from '@/lib/terrain';
import { currentTerrainModel } from '@/lib/terrain/current';
import { getOrderedAnchorNodes } from '@/lib/bimGeometry';
import type { DrawingAnnotation } from '@/store';
import { toast } from '@/components/ui/toast';
import {
  SKETCH_TOOLS,
  sketchToolClicks,
  sketchToolDef,
  sketchToolOutline,
  isCurveTool,
  sketchToolPreview,
  type SketchTool,
} from '@/lib/sketch/tools';
import { computeDome } from '@/lib/dome';
import { SvgAnnotationLayer, type SvgAnnotationTool } from './SvgAnnotationLayer';
import { DrawingPropertiesPanel } from './DrawingPropertiesPanel';
import { RebarLayer } from '@/components/views/armare/RebarLayer';
import { RebarPanel } from '@/components/views/armare/RebarPanel';
import { useArmare } from '@/store/armareStore';
import {
  resolveVisuals,
  applyNodeColorOverrides,
  BUILTIN_ELEMENT_DEFAULTS, FALLBACK_VISUALS,
  getSectionLineColor, getSectionLineWeight, getSectionLineStyle,
  getSectionFillColor, getSectionFillOpacity,
  getViewLineColor, getViewLineWeight, getViewLineStyle,
  lineStyleToDashArray,
  type HatchPattern, type MaterialVisuals,
} from '@/lib/materialConfig';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { useFitToContent } from '@/hooks/useFitToContent';
import { expandArrayNodes, safeEval } from '@/lib/formulaUtils';
import { applyGridEdit, roundToSnap, DEFAULT_SPAN_EDIT_MODE, GRID_MIN_GAP_MM } from '@/lib/grid/axisEdit';
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

// ── Dimension lines ────────────────────────────────────────────────────────────
//
// One drawing primitive for every dimension on the plan — the axis chains and
// the selected sketch's own sizes. Endpoints are SVG units; `offset` hangs
// the line to the clockwise-perpendicular side of a→b (which, with SVG's y
// pointing down, is the RIGHT of the segment as read on screen). A dimension
// that has an `onEdit` reads as a control: its number is a button.
const DIM_OFF  = 11;   // gap from the measured edge to the dimension line
const DIM_FONT = 6.5;
const DIM_TICK = 1.8;
/** Centre of the number, measured back from the dimension line toward the object. */
const DIM_TEXT = 2.6 + DIM_FONT * 0.4;

function PlanDim({ a, b, offset, label, color = '#475569', onEdit, hidden }: {
  a: { x: number; y: number };
  b: { x: number; y: number };
  offset: number;
  label: string;
  color?: string;
  onEdit?: () => void;
  /** Keep the line, drop the number — while an input sits over it. */
  hidden?: boolean;
}) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return null;
  const d = { x: dx / len, y: dy / len };
  const n = { x: -d.y, y: d.x };
  const s = Math.sign(offset) || 1;
  const A = { x: a.x + n.x * offset, y: a.y + n.y * offset };
  const B = { x: b.x + n.x * offset, y: b.y + n.y * offset };
  // Extension lines overshoot the dimension line a touch, the way they are drawn.
  const ext = offset + s * 2;
  const t = { x: (d.x + n.x) * Math.SQRT1_2, y: (d.y + n.y) * Math.SQRT1_2 };
  const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  const tx = mid.x - n.x * s * DIM_TEXT, ty = mid.y - n.y * s * DIM_TEXT;
  // Read left-to-right, or bottom-to-top: angles in [−90°, 90°).
  let ang = (Math.atan2(d.y, d.x) * 180) / Math.PI;
  if (ang >= 90) ang -= 180; else if (ang < -90) ang += 180;
  const w = Math.max(10, label.length * DIM_FONT * 0.62 + 4);
  return (
    <g style={{ pointerEvents: onEdit ? 'auto' : 'none' }}>
      <line x1={a.x} y1={a.y} x2={a.x + n.x * ext} y2={a.y + n.y * ext} stroke={color} strokeWidth={0.4} opacity={0.7} />
      <line x1={b.x} y1={b.y} x2={b.x + n.x * ext} y2={b.y + n.y * ext} stroke={color} strokeWidth={0.4} opacity={0.7} />
      <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={color} strokeWidth={0.5} />
      <line x1={A.x - t.x * DIM_TICK} y1={A.y - t.y * DIM_TICK} x2={A.x + t.x * DIM_TICK} y2={A.y + t.y * DIM_TICK} stroke={color} strokeWidth={0.8} />
      <line x1={B.x - t.x * DIM_TICK} y1={B.y - t.y * DIM_TICK} x2={B.x + t.x * DIM_TICK} y2={B.y + t.y * DIM_TICK} stroke={color} strokeWidth={0.8} />
      {!hidden && (
        <g transform={`translate(${tx} ${ty}) rotate(${ang})`}
          onClick={onEdit ? (e) => { e.stopPropagation(); onEdit(); } : undefined}
          onMouseDown={onEdit ? (e) => e.stopPropagation() : undefined}
          style={onEdit ? { cursor: 'text' } : undefined}>
          <rect x={-w / 2} y={-DIM_FONT * 0.55} width={w} height={DIM_FONT * 1.1} rx={1}
            fill={onEdit ? '#ffffff' : 'none'} fillOpacity={onEdit ? 0.75 : 0} stroke="none" />
          <text x={0} y={0} textAnchor="middle" dominantBaseline="central" fontSize={DIM_FONT} fill={color} fontFamily="ui-monospace, monospace"
            style={{ textDecoration: onEdit ? 'underline dotted' : undefined }}>
            {label}
          </text>
          {onEdit && <title>Clic pentru a edita — Enter aplică, Esc anulează</title>}
        </g>
      )}
    </g>
  );
}

/** Where an inline value editor sits on the plan and what its Enter does. */
interface PlanDimEdit {
  key: string;
  value: string;
  at: { x: number; y: number };
  /** `shift` = the alternate mode (for an axis span: move only the next axis). */
  commit: (valueMm: number, shift: boolean) => void;
}

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

// The dimensions come from `resolveOpeningDims` — the one resolver the wall
// geometry, the 3D viewers and the IFC export all use. Reading the node's
// properties here instead would drift from them: the keys it used to read
// (`sill_height_mm`, `height_mm`) are the LIBRARY's names, never written onto
// a node, so a window whose sill the user had raised was still judged at the
// catalogue default — and a door, looked up in the window catalogue, was
// given a 900 mm sill it does not have.
function getOpeningCutZone(
  opNode: BubbleGraphNode,
  storeyBottomMm: number,
  cutAbsElevMm: number,
): OpeningCutZone {
  const { height: openH, sillHeight: sillH } = resolveOpeningDims(opNode);
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

/** Whether these visuals are drawn with an SVG <pattern> (not none / solid). */
const isPatternHatch = (vis: MaterialVisuals): boolean =>
  !!vis.hatch && vis.hatch !== 'none' && vis.hatch !== 'solid';

/**
 * The SVG pattern ID for a section hatch — named after what it looks like
 * (hatch, colour, weight), not after the material that asked for it. A
 * material resolves by id, label or alias, and every spelling that lands on
 * the same visuals lands on the same pattern, so the fill can never point at
 * a pattern that was defined under another name.
 */
function hatchPatId(vis: MaterialVisuals): string {
  const colour = getSectionFillColor(vis).replace(/[^a-z0-9]/gi, '');
  const weight = String(getSectionLineWeight(vis)).replace(/[^0-9]/g, 'p');
  return `bgp_${vis.hatch}_${colour}_${weight}`;
}

/** Get the SVG fill value for a section element: either a colour or url(#patternId). */
function sectionFill(vis: MaterialVisuals): string {
  if (!vis.hatch || vis.hatch === 'none') return 'none';
  if (vis.hatch === 'solid') return getSectionFillColor(vis);
  return `url(#${hatchPatId(vis)})`;
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
  /** Multi-selection (region select writes it; Delete removes it). */
  selectedNodeIds?: string[];
  onSelectNodes?: (ids: string[]) => void;
  /** The view's own annotation key (lib/views/drawingViews); absent → the key this drawing used before views. */
  annotationKey?: string;
}

/**
 * Node types the plan itself authors, and so may delete. Everything else on
 * the plan — walls, rooms, columns, beams — is generated from the graph, and
 * the graph is where it is removed; a Delete here only says so.
 */
const PLAN_OWNED_TYPES = new Set(['sketch', 'section', 'view', 'scatter', 'terrain_pad']);

/** Node types whose `x/y` IS a plan position — the only ones a connection line can be drawn between. */
const PLAN_POINT_TYPES = new Set(['ax', 'column']);

/** A closed outline strokes as a polygon, an open one as a polyline. */
const closedOutline = (closed: boolean) => closed;

/**
 * The plan points an annotation occupies — for region selection, which keeps
 * a shape only when ALL of them fall inside the rectangle (window select).
 */
function annotationPoints(a: DrawingAnnotation): { x: number; y: number }[] {
  switch (a.kind) {
    case 'text':      return [{ x: a.x, y: a.y }];
    case 'dimension': return [a.p1, a.p2];
    case 'line':      return [a.p1, a.p2];
    case 'leader':
    case 'polyline':
    case 'hatch':     return a.points;
    case 'rect':      return [{ x: a.x, y: a.y }, { x: a.x + a.width, y: a.y + a.height }];
    case 'arc':
    case 'circle':    return [{ x: a.cx - a.radius, y: a.cy - a.radius }, { x: a.cx + a.radius, y: a.cy + a.radius }];
  }
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
  selectedNodeIds = [],
  onSelectNodes,
  annotationKey,
}: FloorPlan2DViewerProps) {
  const annViewId = annotationKey ?? storeyId ?? 'floorplan:all';
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
    svgRef, containerRef, setZoom, setPan,
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
  const { clearViewAnnotations, setBubbleGraph, selectAnnotation, setPlanTool, setPendingOpenSectionId, deleteAnnotation } = useBubbleGraphStore();
  const allAnnotations = useBubbleGraphStore((s) => s.annotations);
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

  // ── Sketch authoring: clicks in the plan become a `sketch` node ───────────
  // The clicks land in BIM mm (the plan's own logical space), so what is drawn
  // is where it is — no conversion, and the 3D body stands exactly there.
  const [sketchTool, setSketchTool] = useState<SketchTool | null>(null);
  const [sketchPts, setSketchPts] = useState<{ x: number; y: number }[]>([]);
  // The rebar panel is a MODE, not furniture: it used to be mounted always,
  // top-left, over the plan toolbar's first group.
  const [showRebar, setShowRebar] = useState(false);

  // ── Region (window) selection ─────────────────────────────────────────────
  // Drag on empty ground with nothing armed. Everything wholly inside the
  // rectangle — nodes, annotations, rebar forms — becomes the selection, and
  // one Delete removes the lot. Nodes go through the host's multi-selection;
  // annotations are held here because the store only knows one at a time.
  const [marquee, setMarquee] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const marqueeStart = useRef<{ client: { x: number; y: number }; bim: { x: number; y: number } } | null>(null);
  const suppressClick = useRef(false);
  const [annSel, setAnnSel] = useState<string[]>([]);
  /** The node most recently picked IN THIS PLAN — the one Delete here may act on. */
  const lastPlanPick = useRef<string | null>(null);
  // Editing an existing sketch: which vertex (or the whole body) is being
  // dragged. A ref, so a pointermove does not re-render on every pixel.
  //
  // `params`/`outline` are frame-LOCAL (what the node stores); `frame` + `ref`
  // are how the pointer's BIM position gets back into that space.
  const sketchDrag = useRef<
    | { kind: 'vertex'; nodeId: string; index: number; shape: SketchShape; params: ShapeParams; outline: { x: number; y: number }[]; frame: SketchFrame; ref: SketchTransform }
    | { kind: 'body'; nodeId: string; from: { x: number; y: number }; shape: SketchShape; params: ShapeParams; outline: { x: number; y: number }[]; frame: SketchFrame; ref: SketchTransform }
    | null
  >(null);

  /**
   * Write a sketch edit back — one graph update, one undo step.
   *
   * Parametric shapes take new NUMBERS; a free polygon takes new points. The
   * derived outline is written alongside either way, so nothing reading the
   * raw property ever sees a stale shape.
   */
  const applySketchEdit = useCallback((
    nodeId: string,
    edit: { params?: ShapeParams; outline?: { x: number; y: number }[] },
  ) => {
    // `params` and `outline` are frame-local, like the properties they write.
    if (!edit.params && !edit.outline) return;
    const store = useBubbleGraphStore.getState();
    setBubbleGraph(
      store.bubbleGraphNodes.map((n) => {
        if (n.id !== nodeId) return n;
        const props: Record<string, unknown> = { ...n.properties };
        if (edit.params) {
          props.shape_x_mm = Math.round(edit.params.xMm * 10) / 10;
          props.shape_y_mm = Math.round(edit.params.yMm * 10) / 10;
          props.shape_w_mm = Math.round(edit.params.wMm * 10) / 10;
          props.shape_h_mm = Math.round(edit.params.hMm * 10) / 10;
          props.shape_r_mm = Math.round(edit.params.rMm * 10) / 10;
        }
        if (edit.outline) props.outline = serialiseOutline(edit.outline);
        const next = { ...n, properties: props };
        // Points are stored frame-LOCAL; only the label position is world.
        const local = parseSketchIntent(next).outline;
        if (local.length) {
          if (!edit.outline) props.outline = serialiseOutline(local);
          const map = new Map(store.bubbleGraphNodes.map((m) => [m.id, m]));
          const o = sketchOutline(next, map, store.bubbleGraphEdges);
          next.x = o.reduce((a, p) => a + p.x, 0) / o.length;
          next.y = o.reduce((a, p) => a + p.y, 0) / o.length;
        }
        return next;
      }),
      store.bubbleGraphEdges,
    );
  }, [setBubbleGraph]);

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
  const canPickBim = !drawWallMode && !drawSectionMode && !sectionOnAxisMode && !annTool && !armarePlaseaza && !sketchTool;
  const handlePickNode = useCallback((nodeId: string, e: React.MouseEvent) => {
    if (!canPickBim || !onSelectNode || e.shiftKey) return;
    e.stopPropagation();
    const next = selectedNodeId === nodeId ? null : nodeId;
    lastPlanPick.current = next;
    onSelectNode(next);
  }, [canPickBim, onSelectNode, selectedNodeId]);
  const onContainerClick = useCallback((e: React.MouseEvent) => {
    if (!canPickBim || !onSelectNode || e.shiftKey) return;
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (e.target === containerRef.current || e.target === svgRef.current) {
      onSelectNode(null);
      selectAnnotation(null);
      onSelectNodes?.([]);
      setAnnSel([]);
    }
  }, [canPickBim, onSelectNode, onSelectNodes]);
  useEffect(() => {
    setArmareActiveView(storeyId ?? 'floorplan');
    // Forms drawn while this tab had no storeyId were keyed 'floorplan';
    // fold them into the storey so they neither vanish nor stay orphaned.
    if (storeyId) useArmare.getState().migrateView('floorplan', storeyId);
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

  // BIM mm coords for any node. Ax nodes go through the ONE resolver so free
  // points (bimX/bimY) and grid offsets (ax_dx_mm) land where every other view
  // puts them; the storey-less fallback keeps legacy graphs on the grid origin.
  const getNodeMmPos = (n: BubbleGraphNode): { x: number; y: number } => {
    if (n.type === 'ax') {
      if (n.parentId && nodeMap.has(n.parentId)) return getAxRealPos(n, nodeMap);
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

  /** Every plan point a node occupies: its marker line, outline, anchors, or itself. */
  const nodePlanPoints = (n: BubbleGraphNode): { x: number; y: number }[] => {
    if (n.type === 'section' || n.type === 'view') {
      const c = n.properties.plan_cut as { x1?: number; y1?: number; x2?: number; y2?: number } | undefined;
      if (c && Number.isFinite(c.x1) && Number.isFinite(c.x2)) {
        return [{ x: c.x1 as number, y: c.y1 as number }, { x: c.x2 as number, y: c.y2 as number }];
      }
    }
    if (n.type === 'sketch') {
      const o = sketchOutline(n, nodeMap, edges);
      if (o.length) return o;
    }
    const anchors = getOrderedAnchorNodes(n.id, edges, nodeMap);
    if (anchors.length) return anchors.map(getNodeMmPos);
    return [getNodeMmPos(n)];
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

  // Turn the clicked points into a sketch node on the active storey. The tool
  // decides the starting operation — a contour extrudes, a path sweeps — and
  // everything after that is the Inspector's job.
  const commitSketch = useCallback((tool: SketchTool, pts: { x: number; y: number }[]) => {
    if (!storeyId) return false;
    const outline = sketchToolOutline(tool, pts);
    if (!outline) return false;
    const def = sketchToolDef(tool);
    // A rectangle stays a rectangle: the two clicks become width and height,
    // editable by number afterwards. A free contour owns its points; a curve
    // owns the points it passes through, and its outline is read off it.
    const curve = isCurveTool(tool);
    const shape: SketchShape = tool === 'rect' ? 'rect' : tool === 'circle' ? 'circle' : curve ? 'curve' : 'poly';
    const sp: ShapeParams = tool === 'rect' ? paramsForRect(pts[0], pts[1])
      : tool === 'circle' ? paramsForCircle(pts[0], pts[1])
      : { xMm: 0, yMm: 0, wMm: 0, hMm: 0, rMm: 0 };
    const count = rawNodes.filter((n) => n.type === 'sketch').length;
    // The node's own x/y is only a label position; the geometry is the outline.
    const cx = outline.reduce((a, p) => a + p.x, 0) / outline.length;
    const cy = outline.reduce((a, p) => a + p.y, 0) / outline.length;
    const node: BubbleGraphNode = {
      id: `node_${uid()}`,
      type: 'sketch',
      name: `${def.label}${count + 1}`,
      x: cx, y: cy, z: 0,
      parentId: storeyId,
      properties: {
        shape,
        shape_x_mm: Math.round(sp.xMm * 10) / 10,
        shape_y_mm: Math.round(sp.yMm * 10) / 10,
        shape_w_mm: Math.round(sp.wMm * 10) / 10,
        shape_h_mm: Math.round(sp.hMm * 10) / 10,
        shape_r_mm: Math.round(sp.rMm * 10) / 10,
        outline: serialiseOutline(curve ? pts : outline),
        ...(curve ? { curve_mode: 'fit', curve_degree: 3 } : {}),
        closed: def.closed ? 'True' : 'False',
        op: def.op,
        level: 'bottom',
        offset_z_mm: 0,
        height_mm: def.op === 'extrude' ? 1000 : 0,
        profile: 'rect',
        p_w_mm: 100,
        p_h_mm: 200,
        anchor_x: 'mid',
        anchor_y: 'max',
        offset_x_mm: 0,
        rotation_deg: 0,
        mirror: 'False',
        corners: 'miter',
        array_count: 1,
        array_dx_mm: 0,
        array_dy_mm: 0,
        array_dz_mm: 0,
        array_along: 'vector',
        array_step_mm: 0,
        array_fit: 'False',
        ref_dx_mm: 0,
        ref_dy_mm: 0,
        ref_rot_deg: 0,
        ref_mirror: 'False',
        ifc_type: 'auto',
        element_type: '',
        material: 'Beton C30/37',
      },
    };
    // Started on an axis point? Then that ax is the reference: the sketch is
    // stored relative to it and follows it when the grid moves. The rewire
    // re-expresses the points, so nothing the user just drew shifts.
    const originAx = storeyNodes.find((n) => {
      if (n.type !== 'ax' && n.type !== 'column') return false;
      const q = getNodeMmPos(n);
      return Math.hypot(q.x - pts[0].x, q.y - pts[0].y) < 1;
    });
    let ns: BubbleGraphNode[] = [...rawNodes, node];
    let es: BubbleGraphEdge[] = rawEdges;
    if (originAx) ({ nodes: ns, edges: es } = setSketchRefs(ns, es, node.id, [originAx.id]));
    setBubbleGraph(ns, es);
    onSelectNode?.(node.id);
    return true;
    // getNodeMmPos is a plain per-render resolver over the same inputs as storeyNodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeyId, rawNodes, rawEdges, storeyNodes, setBubbleGraph, onSelectNode]);

  /** Finish whatever the sketch tool has collected; clears either way. */
  const finishSketch = useCallback(() => {
    if (sketchTool) commitSketch(sketchTool, sketchPts);
    setSketchPts([]);
    setSketchTool(null);
  }, [sketchTool, sketchPts, commitSketch]);

  // Vertex and body drags run on window listeners so the pointer can leave the
  // SVG mid-drag without the shape freezing where it was.
  //
  // The listeners registered are STABLE wrappers reading a ref, not the live
  // callbacks: dragging edits the nodes, which rebuilds `snapPoints` and so
  // `findSnap`, so a callback registered directly would be a different
  // function by the time `removeEventListener` ran — the handlers would pile
  // up instead of coming off.
  const sketchMoveImpl = useRef<(e: PointerEvent) => void>(() => {});
  sketchMoveImpl.current = (e: PointerEvent) => {
    const d = sketchDrag.current;
    if (!d) return;
    // Snap in the world, edit in the frame: a corner dragged onto an axis
    // point lands on it exactly, and a rectangle stays square to its line.
    const w = worldToLocal(d.frame, d.ref, findSnap(clientToBim(e.clientX, e.clientY)));
    if (d.kind === 'vertex') {
      applySketchEdit(d.nodeId, dragVertex(d.shape, d.params, d.outline, d.index, w));
    } else {
      const from = worldToLocal(d.frame, d.ref, d.from);
      applySketchEdit(d.nodeId, translateShape(d.shape, d.params, d.outline, w.x - from.x, w.y - from.y));
    }
  };

  const sketchDragHandlers = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);
  if (!sketchDragHandlers.current) {
    const move = (e: PointerEvent) => sketchMoveImpl.current(e);
    const up = () => {
      sketchDrag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    sketchDragHandlers.current = { move, up };
  }

  const startSketchDrag = useCallback((d: NonNullable<typeof sketchDrag.current>) => {
    const h = sketchDragHandlers.current!;
    sketchDrag.current = d;
    window.addEventListener('pointermove', h.move);
    window.addEventListener('pointerup', h.up);
  }, []);

  // A drag in flight when the plan unmounts would otherwise keep its listeners.
  useEffect(() => () => {
    const h = sketchDragHandlers.current;
    if (h) { window.removeEventListener('pointermove', h.move); window.removeEventListener('pointerup', h.up); }
  }, []);

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

  // Delete removes the region selection in one go; Esc drops it. Capture
  // phase, so this runs before the host's own Delete listener and can stop it
  // — otherwise the same key would delete the nodes twice over.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') {
        if (marquee || annSel.length) { marqueeStart.current = null; setMarquee(null); setAnnSel([]); }
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (annSel.length === 0 && selectedNodeIds.length === 0) {
        // A single node picked in this plan: delete it here if the plan
        // owns it; refuse — audibly — if the graph does. Anything picked
        // elsewhere keeps its own owner.
        if (!selectedNodeId || lastPlanPick.current !== selectedNodeId) return;
        const n = nodeMap.get(selectedNodeId);
        if (!n) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!PLAN_OWNED_TYPES.has(n.type)) {
          toast.info('Elementele generate din graf se șterg din graf, nu din plan.');
          return;
        }
        setBubbleGraph(
          rawNodes.filter((x) => x.id !== n.id),
          rawEdges.filter((ed) => ed.from !== n.id && ed.to !== n.id),
        );
        lastPlanPick.current = null;
        onSelectNode?.(null);
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (selectedNodeIds.length) {
        const del = new Set(selectedNodeIds);
        setBubbleGraph(
          rawNodes.filter((n) => !del.has(n.id)),
          rawEdges.filter((ed) => !del.has(ed.from) && !del.has(ed.to)),
        );
        onSelectNodes?.([]);
        onSelectNode?.(null);
      }
      for (const id of annSel) deleteAnnotation(id);
      setAnnSel([]);
      const arm = useArmare.getState();
      if (arm.selectieCurenta().length) arm.stergeSelectia();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marquee, annSel, selectedNodeIds, selectedNodeId, rawNodes, rawEdges, setBubbleGraph, onSelectNodes, onSelectNode, deleteAnnotation]);

  // ESC cancels draw-wall / section modes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never steal a key from a field the user is typing in — an armed tool
      // does not mean every Enter in the app belongs to the drawing.
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (sketchTool && !typing && (e.key === 'Enter' || e.key === 'Escape')) {
        e.preventDefault();
        if (e.key === 'Enter') finishSketch();
        else { setSketchPts([]); setSketchTool(null); setHoverSnap(null); setHoverRaw(null); }
        return;
      }
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
  }, [drawWallMode, drawSectionMode, sectionOnAxisMode, setPlanTool, sketchTool, finishSketch]);

  // Entering a plan section tool cancels wall / annotations
  useEffect(() => {
    if (planTool) {
      setDrawWallMode(false);
      setWallStart(null);
      setAnnTool(null);
      setSketchTool(null);
      setSketchPts([]);
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
    // Sketch tool: collect points. Rect and circle commit on their second
    // click; a contour or path runs until Enter or a double-click.
    if (sketchTool && e.button === 0 && !e.shiftKey) {
      const pt = findSnap(fromClientPos(e.clientX, e.clientY));
      const pts = [...sketchPts, pt];
      const needed = sketchToolClicks(sketchTool);
      if (needed > 0 && pts.length >= needed) {
        commitSketch(sketchTool, pts);
        setSketchPts([]);
        setSketchTool(null);
      } else {
        setSketchPts(pts);
      }
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
      return;
    }
    // Idle left-press on empty ground: a possible region selection. It only
    // becomes one after the pointer moves, so a plain click still deselects.
    if (e.button === 0 && canPickBim && (e.target === containerRef.current || e.target === svgRef.current)) {
      marqueeStart.current = { client: { x: e.clientX, y: e.clientY }, bim: fromClientPos(e.clientX, e.clientY) };
    }
  }, [drawWallMode, wallStart, findSnap, fromClientPos, commitWall, drawSectionMode, sectionOnAxisMode, sectionStart, sectionLine, commitSectionLine, commitSectionOnAxis, sketchTool, sketchPts, commitSketch, canPickBim]);

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
    } else if (drawWallMode || sketchTool) {
      const raw = fromClientPos(e.clientX, e.clientY);
      setHoverRaw(raw);
      setHoverSnap(findSnap(raw));
    } else {
      setHoverRaw(null);
    }
    const ms = marqueeStart.current;
    if (ms) {
      if (marquee || Math.hypot(e.clientX - ms.client.x, e.clientY - ms.client.y) > 4) {
        setMarquee({ a: ms.bim, b: fromClientPos(e.clientX, e.clientY) });
      }
    }
    if (!dragging) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, [dragging, drawWallMode, drawSectionMode, sectionOnAxisMode, findSnap, fromClientPos, axisXVals, axisYVals, sketchTool, marquee]);

  /** Resolve the region: window-select everything wholly inside it. */
  const finishMarquee = useCallback((m: { a: { x: number; y: number }; b: { x: number; y: number } }) => {
    const x0 = Math.min(m.a.x, m.b.x), x1 = Math.max(m.a.x, m.b.x);
    const y0 = Math.min(m.a.y, m.b.y), y1 = Math.max(m.a.y, m.b.y);
    const inside = (pts: { x: number; y: number }[]) =>
      pts.length > 0 && pts.every((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1);

    // Only what the plan authored: graph-generated geometry is not the
    // band's to take, and selecting it here would only promise a Delete
    // that cannot follow.
    const nodeIds = storeyNodes
      .filter((n) => PLAN_OWNED_TYPES.has(n.type) && inside(nodePlanPoints(n)))
      .map((n) => n.id);
    const viewIds = new Set([annViewId, 'floorplan:all']);
    const annIds = allAnnotations
      .filter((a) => viewIds.has(a.viewId) && inside(annotationPoints(a)))
      .map((a) => a.id);
    const arm = useArmare.getState();
    const armIds = arm.formeCurente().filter((f) => inside([f.pozitie])).map((f) => f.id);

    onSelectNode?.(null);
    selectAnnotation(null);
    onSelectNodes?.(nodeIds);
    setAnnSel(annIds);
    arm.selecteazaMulte(armIds);
    // nodeMap is declared further down the component; the closure reads it
    // live, but naming it here would evaluate it before its declaration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeyNodes, storeyId, allAnnotations, onSelectNode, onSelectNodes, selectAnnotation, edges]);

  const onMouseUp = useCallback(() => {
    setDragging(false);
    if (marquee) {
      finishMarquee(marquee);
      suppressClick.current = true; // the click that follows must not deselect
    }
    marqueeStart.current = null;
    setMarquee(null);
  }, [marquee, finishMarquee]);

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

  // ── Parametric dimensions ─────────────────────────────────────────────────
  // The axis chains are always there to read; typing over a number is what
  // makes them parametric. One editor at a time; its `commit` knows what the
  // number means (an axis span, a sketch side, an offset, an array step).
  const [showDims, setShowDims] = useState(true);
  const [planDimEdit, setPlanDimEdit] = useState<PlanDimEdit | null>(null);
  const openDimEdit = useCallback((key: string, valueMm: number, at: { x: number; y: number }, commit: PlanDimEdit['commit']) => {
    setPlanDimEdit({ key, value: String(Math.round(valueMm)), at, commit });
  }, []);
  const commitDimEdit = useCallback((shift: boolean) => {
    const d = planDimEdit;
    setPlanDimEdit(null);
    if (!d) return;
    let v: number;
    try { v = safeEval(d.value); } catch { return; }
    if (!Number.isFinite(v)) return;
    d.commit(v, shift);
  }, [planDimEdit]);
  /** Typing over an axis span: the same edit grid mode makes, linked across storeys. */
  const commitAxisSpan = useCallback((axis: 'x' | 'y', index: number, spanMm: number, shift: boolean) => {
    if (!storeyId || spanMm < GRID_MIN_GAP_MM) return;
    const store = useBubbleGraphStore.getState();
    const r = applyGridEdit(store.bubbleGraphNodes, store.bubbleGraphEdges, {
      kind: 'setSpan', storeyId, axis, index, spanMm: roundToSnap(spanMm),
      mode: shift ? 'neighbour' : DEFAULT_SPAN_EDIT_MODE, scope: 'linked',
    });
    if (r.nodes !== store.bubbleGraphNodes) setBubbleGraph(r.nodes, r.edges);
  }, [storeyId, setBubbleGraph]);
  /** A property patch on one sketch — for the edits that are not shape numbers. */
  const patchSketchProps = useCallback((nodeId: string, patch: Record<string, unknown>) => {
    const store = useBubbleGraphStore.getState();
    setBubbleGraph(
      store.bubbleGraphNodes.map((n) => (n.id === nodeId ? { ...n, properties: { ...n.properties, ...patch } } : n)),
      store.bubbleGraphEdges,
    );
  }, [setBubbleGraph]);
  useEffect(() => subscribeAnnotationSettings(() => setAnnSettingsState(getAnnotationSettings())), []);

  // SVG hatch pattern defs for every visuals a section fill can resolve to:
  // `resolveVisuals` only ever returns a configured material, a configured or
  // built-in element default, or the fallback — plus a node's own colour
  // override. One def per distinct look, keyed as `sectionFill` keys it.
  const hatchDefsHtml = useMemo(() => {
    const looks: MaterialVisuals[] = [
      ...Object.values(matConfig?.materials ?? {}),
      ...Object.values(matConfig?.element_defaults ?? {}),
      ...Object.values(BUILTIN_ELEMENT_DEFAULTS),
      FALLBACK_VISUALS,
    ];
    for (const n of expandedNodes) {
      if (!n.properties?.color_2d) continue;
      looks.push(applyNodeColorOverrides(resolveVisuals(n.type, String(n.properties.material ?? ''), matConfig), n.properties));
    }
    const seen = new Set<string>();
    let defs = '';
    for (const vis of looks) {
      if (!isPatternHatch(vis)) continue;
      const id = hatchPatId(vis);
      if (seen.has(id)) continue;
      seen.add(id);
      defs += buildSvgHatchPattern(id, vis.hatch, getSectionFillColor(vis), getSectionLineWeight(vis));
    }
    return defs;
  }, [matConfig, expandedNodes]);

  // Full nodeMap (ALL nodes, not just storey-filtered) so calcShellPolygon can resolve
  // ax parent storey and cross-storey edges correctly — same as 3D viewers.
  const nodeMap = useMemo(() => new Map(expandedNodes.map((n) => [n.id, n])), [expandedNodes]);

  // Precompute wall join results for all walls (auto/butt/miter/square_off)
  const wallJoins = useMemo(() => calcWallJoins(expandedNodes, edges), [expandedNodes, edges]);

  /**
   * The storey's walls as ONE outline.
   *
   * A wall that draws its own closed quad shows a seam wherever it meets
   * another — a line across the poché at every T and every cross, where the
   * masonry is in fact continuous. So the bodies are unioned and only the
   * boundary of that union is stroked. Each wall still paints its own fill
   * below, which is what keeps materials, hatches, selection and picking
   * exactly as they were; all a wall gives up is its outline.
   */
  const wallSilhouette = useMemo(() => {
    const polys = storeyNodes
      .filter((n) => n.type === 'wall')
      .flatMap((wn) => {
        const geo = calcWallGeometry(wn, nodeMap, edges, wallJoins);
        return geo ? wallSolidPolygons(geo) : [];
      });
    return unionWallRings(polys);
  }, [storeyNodes, nodeMap, edges, wallJoins]);

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

  // Stair symbols for the stairwells on this storey. Built from the same cut
  // plane the walls use, so the break line lands where the plan is actually cut.
  const stairPlans = useMemo(() => {
    const wells = expandedNodes.filter((n) =>
      n.type === 'stairwell' && (!storeyId || n.parentId === storeyId || !n.parentId));
    const out: { id: string; plan: StairPlan }[] = [];
    for (const w of wells) {
      try {
        const plan = buildStairPlan(w, expandedNodes, edges, (storeyMeta?.properties?.bottomElevation as number ?? 0) + cutHeightMm);
        if (plan) out.push({ id: w.id, plan });
      } catch { /* a stair that fails to solve must not take the plan down */ }
    }
    return out;
  }, [expandedNodes, edges, storeyId, storeyMeta, cutHeightMm]);

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
      onDoubleClick={sketchTool ? (e) => { e.preventDefault(); finishSketch(); } : undefined}
      style={{ cursor: drawWallMode || sketchTool || marquee ? 'crosshair' : dragging ? 'grabbing' : 'default' }}
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

        {/* ── Axis dimension chains: the spans along the bottom and the left,
            hung just outside the bubbles. Each number is the parameter it
            shows — type over it and the axis moves (grid mode's setSpan). ── */}
        {showDims && (() => {
          const editable = canPickBim && !embedded && !!storeyId && !sketchTool && !drawWallMode;
          const rowY = CANVAS_MARGIN + H - PAD / 2 + 9;
          const colX = CANVAS_MARGIN + PAD / 2 - 9;
          const out: React.ReactNode[] = [];
          for (let i = 0; i < axisXVals.length - 1; i++) {
            const span = axisXVals[i + 1] - axisXVals[i];
            const a = { x: toSvg(axisXVals[i], minY).x, y: rowY };
            const b = { x: toSvg(axisXVals[i + 1], minY).x, y: rowY };
            const key = `axx${i}`;
            out.push(
              <PlanDim key={key} a={a} b={b} offset={DIM_OFF} label={String(Math.round(span))} color={discColor}
                hidden={planDimEdit?.key === key}
                onEdit={editable ? () => openDimEdit(key, span, { x: (a.x + b.x) / 2, y: rowY + DIM_OFF - DIM_TEXT },
                  (v, shift) => commitAxisSpan('x', i, v, shift)) : undefined} />,
            );
          }
          for (let j = 0; j < axisYVals.length - 1; j++) {
            const span = axisYVals[j + 1] - axisYVals[j];
            const a = { x: colX, y: toSvg(minX, axisYVals[j]).y };
            const b = { x: colX, y: toSvg(minX, axisYVals[j + 1]).y };
            const key = `axy${j}`;
            out.push(
              <PlanDim key={key} a={a} b={b} offset={-DIM_OFF} label={String(Math.round(span))} color={discColor}
                hidden={planDimEdit?.key === key}
                onEdit={editable ? () => openDimEdit(key, span, { x: colX - DIM_OFF + DIM_TEXT, y: (a.y + b.y) / 2 },
                  (v, shift) => commitAxisSpan('y', j, v, shift)) : undefined} />,
            );
          }
          return out;
        })()}

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

        {/* ── Stair symbols ──
            Drawing convention, not a projection: steps below the cut are drawn,
            the break line marks where the cut falls, and the steps above belong
            to the plan of the storey overhead. */}
        {stairPlans.map(({ id, plan }) => {
          const vis = resolveVisuals('stair_flight', undefined, matConfig);
          const col = getSectionLineColor(vis);
          const light = getViewLineColor(vis);
          const ARR = 5 * SCALE;
          const arrow = plan.upArrow;
          return (
            <g key={`stairplan_${id}`} style={{ pointerEvents: 'none' }}>
              {/* Landings first, so the nosing lines read on top of them. */}
              {plan.landings.map((poly, i) => (
                <polygon key={`sl_${id}_${i}`}
                  points={poly.map((p) => { const q = toSvg(p.x, p.y); return `${q.x},${q.y}`; }).join(' ')}
                  fill={getSectionFillColor(vis)} fillOpacity={0.35}
                  stroke={col} strokeWidth={1} />
              ))}
              {plan.treads.map((t, i) => {
                const a = toSvg(t.a.x, t.a.y), b = toSvg(t.b.x, t.b.y);
                return <line key={`st_${id}_${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={col} strokeWidth={1.1} strokeLinecap="round" />;
              })}
              {/* Steps above the cut, ghosted — they belong to the plan above. */}
              {plan.treadsAboveCut.map((t, i) => {
                const a = toSvg(t.a.x, t.a.y), b = toSvg(t.b.x, t.b.y);
                return <line key={`sta_${id}_${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={light} strokeWidth={0.8} strokeDasharray="4 4" opacity={0.45} />;
              })}
              {plan.breakLines.map((l, i) => {
                const a = toSvg(l.a.x, l.a.y), b = toSvg(l.b.x, l.b.y);
                return <line key={`sb_${id}_${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={col} strokeWidth={1.4} strokeLinecap="round" />;
              })}
              {/* Walking line, with the circle at the bottom step and the arrow
                  at the top — the reader's cue for which way is up. */}
              <polyline
                points={plan.walkingLine.map((p) => { const q = toSvg(p.x, p.y); return `${q.x},${q.y}`; }).join(' ')}
                fill="none" stroke={col} strokeWidth={1.2} />
              {plan.start && (() => {
                const q = toSvg(plan.start.x, plan.start.y);
                return <circle cx={q.x} cy={q.y} r={2.2 * SCALE} fill="none" stroke={col} strokeWidth={1.2} />;
              })()}
              {arrow && (() => {
                const f = toSvg(arrow.a.x, arrow.a.y), t = toSvg(arrow.b.x, arrow.b.y);
                const dx = t.x - f.x, dy = t.y - f.y, L = Math.hypot(dx, dy) || 1;
                const ux = dx / L, uy = dy / L, px = -uy, py = ux;
                return (
                  <path
                    d={`M${t.x - ux * ARR + px * ARR * 0.5},${t.y - uy * ARR + py * ARR * 0.5} `
                      + `L${t.x},${t.y} `
                      + `L${t.x - ux * ARR - px * ARR * 0.5},${t.y - uy * ARR - py * ARR * 0.5}`}
                    fill="none" stroke={col} strokeWidth={1.4} strokeLinecap="round" />
                );
              })()}
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
          const secLineW = getSectionLineWeight(wallVis);
          const vwLineW  = getViewLineWeight(wallVis);   // seen/view line weight (thin)
          const secFillO = getSectionFillOpacity(wallVis);
          const fillVal  = sectionFill(wallVis);

          // Helpers: SVG positions along wall centreline at mm distance t from join-adjusted start
          const wPt     = (t: number) => toSvg(sxMm + ux * t, szMm + uy * t);
          const wOuter  = (t: number) => { const p = wPt(t); return { x: p.x + px * halfTh, y: p.y + py * halfTh }; };
          const wInner  = (t: number) => { const p = wPt(t); return { x: p.x - px * halfTh, y: p.y - py * halfTh }; };

          // The footprint's faces at a distance t (mm) along the axis — not at
          // a fraction of each face: a joined wall's faces differ in length,
          // and equal fractions turn every opening into a parallelogram.
          // Outer edge: fp[0] → fp[1], Inner edge: fp[3] → fp[2]. See `wallFaces`.
          const faces = wallFaces(geo);
          const fpOuterBim = (t: number) => faces
            ? faces.outerAt(t)
            : { x: fp[0].x + (fp[1].x - fp[0].x) * (t / joinLen), y: fp[0].y + (fp[1].y - fp[0].y) * (t / joinLen) };
          const fpInnerBim = (t: number) => faces
            ? faces.innerAt(t)
            : { x: fp[3].x + (fp[2].x - fp[3].x) * (t / joinLen), y: fp[3].y + (fp[2].y - fp[3].y) * (t / joinLen) };
          const fpOuterSvg = (t: number) => { const p = fpOuterBim(t); return toSvg(p.x, p.y); };
          const fpInnerSvg = (t: number) => { const p = fpInnerBim(t); return toSvg(p.x, p.y); };

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
            const aO = fpOuterSvg(seg.s), bO = fpOuterSvg(seg.e);
            const bI = fpInnerSvg(seg.e), aI = fpInnerSvg(seg.s);

            els.push(
              <polygon key={`${wn.id}_s${i}`}
                points={`${aO.x},${aO.y} ${bO.x},${bO.y} ${bI.x},${bI.y} ${aI.x},${aI.y}`}
                fill={fillVal}
                fillOpacity={secFillO}
                // The outline is drawn once for the whole storey, from the
                // union of every wall — see `wallSilhouette`. A selected wall
                // keeps its own stroke, or selecting it would show nothing.
                stroke={wallSelected ? '#2563eb' : 'none'}
                strokeWidth={wallSelected ? secLineW + 1.5 : 0}
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
              const bFill    = wbAboveCut ? 'none' : sectionFill(wallBeamVis);
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
            const sfO = fpOuterSvg(t0), stO = fpOuterSvg(t1);
            const sfI = fpInnerSvg(t0), stI = fpInnerSvg(t1);
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
            const o0OuterBim = fpOuterBim(t0);
            const o1OuterBim = fpOuterBim(t1);
            const oWmm = Math.hypot(o1OuterBim.x - o0OuterBim.x, o1OuterBim.y - o0OuterBim.y);
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
              // The leaf, the arc and the sweep direction are the template's
              // business now. What is still needed here is which face the
              // symbol is laid out from, for the placement matrix below.
              const flipAcross   = String(opNode.properties.flip_across ?? '').toLowerCase() === 'true';

              // Resolve door visual config from the global door symbol registry
              const doorTypeId = String(opNode.properties.door_type ?? 'D-SWING-90x210');
              const swingType  = String(opNode.properties.swing ?? 'left');
              const dCfg = resolveDoorCfg(doorTypeId, swingType);

              // ── The symbol: a drawn one if there is one, else the
              //    architectural template for this swing family. Symbol
              //    Studio has always read those templates; now the plan does
              //    too, so the editor and the drawing cannot disagree. The
              //    simple controls still apply — see `defaultDoorPlanDef`. ──
              const doorCustomSym = resolveSymbolDef('door', doorTypeId, 'floorplan')
                ?? resolveSymbolDef('door', `swing:${swingType}`, 'floorplan')
                ?? defaultDoorPlanDef(swingType, dCfg);
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

              // No procedural fallback any more: `defaultDoorPlanDef` always
              // returns a symbol, so everything a door draws now comes from
              // the template above and from nowhere else.
            }
          });

          return els;
        })}


        {/* ── Wall silhouette: the outline of every wall, drawn once ──
             Each wall above painted its fill and no stroke; this is the
             boundary of their union, so a T or a cross shows no seam across
             the poché. Holes come through as rings of their own, which is
             what a courtyard needs. */}
        {wallSilhouette.length > 0 && (() => {
          const vis = resolveVisuals('wall', '', matConfig);
          const dash = lineStyleToDashArray(getSectionLineStyle(vis));
          return (
            <g pointerEvents="none">
              {wallSilhouette.map((ring, i) => (
                <path
                  key={`wsil${i}`}
                  d={`${ring.map((p, j) => {
                    const q = toSvg(p.x, p.y);
                    return `${j === 0 ? 'M' : 'L'}${q.x},${q.y}`;
                  }).join(' ')} Z`}
                  fill="none"
                  stroke={getSectionLineColor(vis)}
                  strokeWidth={getSectionLineWeight(vis)}
                  strokeDasharray={dash ?? undefined}
                  strokeLinejoin="miter" />
              ))}
            </g>
          );
        })()}

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
          const bFillStr = isAboveCut ? 'none' : sectionFill(beamVis);
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

        {/* ── Sweeps (profil pe linia de ghidaj din axe) — mitered footprint ── */}
        {storeyNodes.filter((n) => n.type === 'sweep').flatMap((sn) => {
          const res = computeSweep(sn, nodeMap, edges);
          if (res.footprint.length === 0) return [];
          const vis = resolveVisuals('sweep', String(sn.properties?.material ?? ''), matConfig);
          const isAboveCut = res.zMinMm >= cutAbsElevMm;
          if (isAboveCut && !showBeamsAboveCut) return [];
          const fillStr  = isAboveCut ? 'none' : sectionFill(vis);
          const strokeC  = isAboveCut ? getViewLineColor(vis) : getSectionLineColor(vis);
          const strokeW  = isAboveCut ? getViewLineWeight(vis) : getSectionLineWeight(vis);
          const da       = isAboveCut
            ? (lineStyleToDashArray(getViewLineStyle(vis)) ?? '5 3')
            : lineStyleToDashArray(getSectionLineStyle(vis));
          const isSel = selectedNodeId === sn.id;
          return res.footprint.map((poly, i) => (
            <polygon key={`${sn.id}_fp${i}`}
              points={poly.map((p) => { const s = toSvg(p.x, p.y); return `${s.x},${s.y}`; }).join(' ')}
              fill={fillStr}
              fillOpacity={isAboveCut ? 0 : getSectionFillOpacity(vis)}
              stroke={isSel ? '#2563eb' : strokeC}
              strokeWidth={isSel ? strokeW + 1.5 : strokeW}
              strokeDasharray={da ?? undefined}
              opacity={isAboveCut ? 0.55 : 1}
              onClick={canPickBim ? (e) => handlePickNode(sn.id, e) : undefined}
              style={canPickBim ? { cursor: 'pointer' } : undefined} />
          ));
        })}

        {/* ── Terrain platforms: the boundary, and the level it holds ──
            A pad has no body — it is an instruction to the ground — so it
            draws as a dashed boundary with its elevation, the way a site
            plan states a platform. */}
        {(() => {
          const siteNode = findSiteNode(rawNodes);
          if (!siteNode) return null;
          const site = computeSite(siteNode, nodeMap, edges, currentTerrainModel());
          if (site.pads.length === 0) return null;
          const vis = resolveVisuals('terrain_pad', '', matConfig);
          return site.pads.map((pad) => {
            const isSel = selectedNodeId === pad.nodeId;
            const pts = pad.outline.map((p) => { const q = toSvg(p.x, p.y); return `${q.x},${q.y}`; }).join(' ');
            const cx = pad.outline.reduce((a, p) => a + p.x, 0) / pad.outline.length;
            const cy = pad.outline.reduce((a, p) => a + p.y, 0) / pad.outline.length;
            const c = toSvg(cx, cy);
            return (
              <g key={`pad_${pad.nodeId}`}
                onClick={canPickBim ? (e) => handlePickNode(pad.nodeId, e) : undefined}
                style={canPickBim ? { cursor: 'pointer' } : undefined}>
                <polygon points={pts}
                  fill={getSectionFillColor(vis)} fillOpacity={0.22}
                  stroke={isSel ? '#2563eb' : getViewLineColor(vis)}
                  strokeWidth={isSel ? getViewLineWeight(vis) + 1.2 : getViewLineWeight(vis)}
                  strokeDasharray="6 3" />
                <text x={c.x} y={c.y} textAnchor="middle" fontSize="7"
                  fill={isSel ? '#2563eb' : getViewLineColor(vis)} pointerEvents="none">
                  {`▱ ${(pad.levelMm / 1000).toFixed(2)}`}
                </text>
              </g>
            );
          });
        })()}

        {/* ── Facades: the face line at its mullion depth, ticks at the bays ── */}
        {storeyNodes.filter((n) => n.type === 'facade').flatMap((fn) => {
          const res = computeFacade(fn, nodeMap, edges);
          if (res.faces.length === 0) return [];
          const vis = resolveVisuals('facade', String(fn.properties?.material ?? ''), matConfig);
          const isSel = selectedNodeId === fn.id;
          const stroke = isSel ? '#2563eb' : getSectionLineColor(vis);
          const P = (p: { x: number; y: number }) => { const q = toSvg(p.x, p.y); return `${q.x},${q.y}`; };
          const d = res.intent.mullionDMm;
          return res.faces.map((f) => {
            const band = [f.a, f.b, { x: f.b.x + f.n.x * d, y: f.b.y + f.n.y * d }, { x: f.a.x + f.n.x * d, y: f.a.y + f.n.y * d }];
            // Bay ticks: the vertical mullions of the bottom row.
            const as = new Set<number>();
            for (const c of res.cells) if (c.face === f.index) for (const p of c.poly) if (p.y < 1) as.add(Math.round(p.x));
            return (
              <g key={`${fn.id}_f${f.index}`} onClick={canPickBim ? (e) => handlePickNode(fn.id, e) : undefined}
                style={canPickBim ? { cursor: 'pointer' } : undefined}>
                <polygon points={band.map(P).join(' ')} fill={getSectionFillColor(vis)} fillOpacity={0.9}
                  stroke={stroke} strokeWidth={isSel ? getSectionLineWeight(vis) + 1.5 : getSectionLineWeight(vis)} />
                {[...as].map((a) => {
                  const p0 = { x: f.a.x + f.u.x * a, y: f.a.y + f.u.y * a };
                  const p1 = { x: p0.x + f.n.x * (d + 150), y: p0.y + f.n.y * (d + 150) };
                  return <line key={a} x1={toSvg(p0.x, p0.y).x} y1={toSvg(p0.x, p0.y).y} x2={toSvg(p1.x, p1.y).x} y2={toSvg(p1.x, p1.y).y}
                    stroke={stroke} strokeWidth={getViewLineWeight(vis)} />;
                })}
              </g>
            );
          });
        })}

        {/* ── Scatter: generic planting-plan symbols ──
            Graph scatter nodes (selectable) and the terrain model's own
            rocks and plants (not selectable here — they belong to the Terrain
            tab and the 3D brush) are drawn with the same symbols. */}
        {(() => {
          const siteNode = findSiteNode(storeyNodes.length ? rawNodes : []);
          const site = siteNode ? computeSite(siteNode, nodeMap, edges, currentTerrainModel()) : null;
          const heightAt = site?.frame ? site.heightAtBim : null;
          const P = (p: { x: number; y: number }) => { const q = toSvg(p.x, p.y); return `${q.x},${q.y}`; };
          const draw = (inst: ScatterInstance[], stroke: string, sw: number, keyPrefix: string) =>
            inst.flatMap((it, i) => scatterSymbol(it).map((pr, j) => pr.kind === 'circle'
              ? (() => { const c = toSvg(pr.cx, pr.cy); return <circle key={`${keyPrefix}${i}_${j}`} cx={c.x} cy={c.y} r={pr.r * SCALE} fill="none" stroke={stroke} strokeWidth={sw} />; })()
              : pr.closed
                ? <polygon key={`${keyPrefix}${i}_${j}`} points={pr.pts.map(P).join(' ')} fill="none" stroke={stroke} strokeWidth={sw} />
                : <polyline key={`${keyPrefix}${i}_${j}`} points={pr.pts.map(P).join(' ')} fill="none" stroke={stroke} strokeWidth={sw} />));
          const groups = storeyNodes.filter((n) => n.type === 'scatter').map((sn) => {
            const res = computeScatter(sn, nodeMap, edges, heightAt);
            if (res.count === 0) return null;
            const key = res.intent.kind === 'rock' || res.intent.kind === 'boulder' ? 'scatter_rock' : 'scatter';
            const vis = resolveVisuals(key, String(sn.properties?.material ?? ''), matConfig);
            const isSel = selectedNodeId === sn.id;
            return (
              <g key={sn.id} onClick={canPickBim ? (e) => handlePickNode(sn.id, e) : undefined}
                style={canPickBim ? { cursor: 'pointer' } : undefined} opacity={isSel ? 1 : 0.9}>
                {draw(res.instances, isSel ? '#2563eb' : getViewLineColor(vis), isSel ? getViewLineWeight(vis) + 0.8 : getViewLineWeight(vis), 's')}
              </g>
            );
          });
          const terrainItems = site && site.frame ? terrainItemInstances(site) : [];
          return (
            <>
              {groups}
              {terrainItems.length > 0 && (
                <g pointerEvents="none" opacity={0.85}>
                  {draw(terrainItems.filter((i) => i.kind !== 'rock'), getViewLineColor(resolveVisuals('scatter', '', matConfig)), 0.5, 'tp')}
                  {draw(terrainItems.filter((i) => i.kind === 'rock'), getViewLineColor(resolveVisuals('scatter_rock', '', matConfig)), 0.5, 'tr')}
                </g>
              )}
            </>
          );
        })()}

        {/* ── Sketches (contur desenat + corp) ──
            Drawn at the cut plane like any other solid, and each array copy
            draws itself so a repeat is visibly a repeat. An open path with a
            swept profile shows its mitered footprint; an `op: none` sketch is
            a setting-out line, so it gets the thin dashed treatment. */}
        {storeyNodes.filter((n) => n.type === 'sketch').flatMap((kn) => {
          const res = computeSketch(kn, nodeMap, edges);
          const outline = res.intent.outline;
          if (outline.length < 2) return [];
          const vis = resolveVisuals('sketch', String(kn.properties?.material ?? ''), matConfig);
          const isSel = selectedNodeId === kn.id;
          const failed = res.diagnostics.some((d) => d.severity === 'error');
          // A hole has no body: it is drawn as the setting-out line it is,
          // and its host's fill leaves the hole empty.
          const bodiless = res.intent.op === 'none' || !!res.intent.holeOf;
          const isAboveCut = !bodiless && !failed && res.zMinMm >= cutAbsElevMm;
          if (isAboveCut && !showBeamsAboveCut) return [];
          const ghost = bodiless || isAboveCut;
          const fillStr = ghost || failed ? 'none' : sectionFill(vis);
          const strokeC = ghost ? getViewLineColor(vis) : getSectionLineColor(vis);
          const strokeW = ghost ? getViewLineWeight(vis) : getSectionLineWeight(vis);
          const da = ghost
            ? (lineStyleToDashArray(getViewLineStyle(vis)) ?? '5 3')
            : lineStyleToDashArray(getSectionLineStyle(vis));
          const pick = canPickBim ? (e: React.MouseEvent) => handlePickNode(kn.id, e) : undefined;
          const cursor = canPickBim ? { cursor: 'pointer' as const } : undefined;
          const P = (poly: { x: number; y: number }[]) =>
            poly.map((p) => { const q = toSvg(p.x, p.y); return `${q.x},${q.y}`; }).join(' ');
          // A face with holes: one path, the holes as further subpaths, filled
          // even-odd so the holes stay empty.
          const D = (poly: { x: number; y: number }[], holes: { x: number; y: number }[][]) =>
            [poly, ...holes].map((r) => `M ${P(r).replace(/ /g, ' L ')} Z`).join(' ');

          const out: React.ReactNode[] = [];
          // The body, when the operation produced one.
          if (!failed) {
            res.footprint.forEach((poly, i) => out.push((res.footprintHoles[i]?.length ?? 0) > 0 ? (
              <path key={`${kn.id}_fp${i}`} d={D(poly, res.footprintHoles[i])} fillRule="evenodd"
                fill={fillStr}
                fillOpacity={ghost ? 0 : getSectionFillOpacity(vis)}
                stroke={isSel ? '#2563eb' : strokeC}
                strokeWidth={isSel ? strokeW + 1.5 : strokeW}
                strokeDasharray={da ?? undefined}
                opacity={isAboveCut ? 0.55 : 1}
                onClick={pick} style={cursor} />
            ) : (
              <polygon key={`${kn.id}_fp${i}`} points={P(poly)}
                fill={fillStr}
                fillOpacity={ghost ? 0 : getSectionFillOpacity(vis)}
                stroke={isSel ? '#2563eb' : strokeC}
                strokeWidth={isSel ? strokeW + 1.5 : strokeW}
                strokeDasharray={da ?? undefined}
                opacity={isAboveCut ? 0.55 : 1}
                onClick={pick} style={cursor} />
            )));
          }
          // ALWAYS the outline the user actually drew. Every failure path in
          // `computeSketch` returns an empty footprint, so drawing only the
          // body made a mistyped height or an unclosed contour erase the
          // drawing outright — with no clue why. A failed sketch now shows
          // its outline in red and keeps its Inspector diagnostics.
          out.push(failed || bodiless || res.footprint.length === 0 ? (
            closedOutline(res.intent.closed) ? (
              <polygon key={`${kn.id}_out`} points={P(outline)}
                fill="none" stroke={failed ? '#dc2626' : isSel ? '#2563eb' : strokeC}
                strokeWidth={isSel ? strokeW + 1 : strokeW} strokeDasharray={failed ? '6 3' : da ?? undefined}
                onClick={pick} style={cursor} />
            ) : (
              <polyline key={`${kn.id}_out`} points={P(outline)}
                fill="none" stroke={failed ? '#dc2626' : isSel ? '#2563eb' : strokeC}
                strokeWidth={isSel ? strokeW + 1 : strokeW} strokeDasharray={failed ? '6 3' : da ?? undefined}
                onClick={pick} style={cursor} />
            )
          ) : null);
          return out;
        })}

        {/* ── Domes: the cell pattern in plan, as seen from below ──
            A dome stands above the cut plane, so it is drawn the way anything
            overhead is: thin dashed lines, no fill. The cells are the whole
            information — a plain base outline would say nothing the axes do
            not already say. */}
        {storeyNodes.filter((n) => n.type === 'dome').flatMap((dn) => {
          const res = computeDome(dn, nodeMap, edges);
          if (!res.base) return [];
          const vis = resolveVisuals('dome', String(dn.properties?.material ?? ''), matConfig);
          const isSel = selectedNodeId === dn.id;
          const stroke = isSel ? '#2563eb' : getViewLineColor(vis);
          const path = (poly: { x: number; y: number }[]) =>
            poly.map((p) => { const s = toSvg(p.x, p.y); return `${s.x},${s.y}`; }).join(' ');
          return [
            <polygon key={`${dn.id}_base`}
              points={path(res.base)}
              fill="none" stroke={stroke}
              strokeWidth={(isSel ? 1.5 : 0.8) * getViewLineWeight(vis) * 2}
              strokeDasharray={lineStyleToDashArray(getViewLineStyle(vis)) ?? '5 3'}
              opacity={0.75}
              onClick={canPickBim ? (e) => handlePickNode(dn.id, e) : undefined}
              style={canPickBim ? { cursor: 'pointer' } : undefined} />,
            ...res.cells.map((cell, i) => cell.length < 3 ? null : (
              <polygon key={`${dn.id}_c${i}`}
                points={path(cell)}
                fill="none" stroke={stroke}
                strokeWidth={getViewLineWeight(vis)}
                strokeDasharray="4 3"
                opacity={0.5}
                pointerEvents="none" />
            )).filter(Boolean),
          ];
        })}

        {/* ── Other edges: connections between POINT elements (ax, column) ──
            Only nodes that stand at a plan position. A shell, a room, a slab
            has a graph-canvas position and no plan point of its own; drawn
            from there, its anchor edges fanned out across the sheet as a
            spray of dashed lines to every axis it was wired to. */}
        {storeyEdges
          .filter((e) => {
            const f = storeyNodes.find((n) => n.id === e.from);
            const t = storeyNodes.find((n) => n.id === e.to);
            return f && t && PLAN_POINT_TYPES.has(f.type) && PLAN_POINT_TYPES.has(t.type);
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
          interactive={canPickBim && !embedded}
          onSelect={canPickBim && onSelectNode ? (id) => { lastPlanPick.current = id; onSelectNode(id); } : undefined}
          selectedId={selectedNodeId}
        />

        {/* ── Nodes ── */}
        {storeyNodes.map((node) => {
          if (node.type === 'storey') return null; // skip storey meta-node
          if (node.type === 'wall' || node.type === 'beam') return null; // rendered as geometry lines above
          if (node.type === 'sweep') return null; // rendered as mitered footprint above
          if (node.type === 'window' || node.type === 'door') return null; // rendered as symbols above
          if (node.type === 'section' || node.type === 'view') return null; // rendered as cut symbols above
          if (node.type === 'shell' || node.type === 'covering') return null; // rendered as overhead outlines above
          if (node.type === 'roof' || ROOF_GENERATED_TYPES.has(node.type)) return null; // rendered by the roof-plan layer above
          // Hidden because the stair-plan layer above draws them. Matched by the
          // stairwell tag, not by type alone: `void` is a shared type, and a
          // void the user placed by hand must still show.
          if (node.type === 'stairwell') return null;
          if (STAIR_GENERATED_TYPES.has(node.type) && node.properties.source_stairwell_id) return null;
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
            // position from the shared resolver — NOT from node.x/y (canvas position)
            const { x: rx, y: ry } = getNodeMmPos(node);
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

        {/* ── Region selection: the band, and a box round everything it holds ── */}
        {(() => {
          const box = (pts: { x: number; y: number }[], key: string) => {
            if (!pts.length) return null;
            const sp = pts.map((p) => toSvg(p.x, p.y));
            const x0 = Math.min(...sp.map((p) => p.x)) - 3, x1 = Math.max(...sp.map((p) => p.x)) + 3;
            const y0 = Math.min(...sp.map((p) => p.y)) - 3, y1 = Math.max(...sp.map((p) => p.y)) + 3;
            return <rect key={key} x={x0} y={y0} width={x1 - x0} height={y1 - y0}
              fill="#2563eb" fillOpacity={0.06} stroke="#2563eb" strokeWidth={1} strokeDasharray="3 2" pointerEvents="none" />;
          };
          const selIds = new Set(selectedNodeIds);
          const annIds = new Set(annSel);
          return (
            <g pointerEvents="none">
              {storeyNodes.filter((n) => selIds.has(n.id)).map((n) => box(nodePlanPoints(n), `msel_${n.id}`))}
              {allAnnotations.filter((a) => annIds.has(a.id)).map((a) => box(annotationPoints(a), `asel_${a.id}`))}
              {marquee && (() => {
                const a = toSvg(marquee.a.x, marquee.a.y), b = toSvg(marquee.b.x, marquee.b.y);
                return <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)}
                  fill="#2563eb" fillOpacity={0.08} stroke="#2563eb" strokeWidth={1} strokeDasharray="4 2" />;
              })()}
            </g>
          );
        })()}

        {/* ── Sketch edit handles: only on the selected sketch, only when no
            tool is armed, so they never fight the placement clicks. ── */}
        {!sketchTool && canPickBim && (() => {
          const sel = storeyNodes.find((n) => n.id === selectedNodeId && n.type === 'sketch');
          if (!sel) return null;
          const sres = computeSketch(sel, nodeMap, edges);
          const si = sres.intent;
          // Handles sit on the WORLD outline; the drag edits the LOCAL one.
          // A curve's handles are its own points — the outline is dozens of
          // chords that only stand for it.
          const outline = si.outline;
          if (outline.length === 0) return null;
          const closed = si.closed;
          const handles = si.curve ? sres.curvePoints : outline;
          const drag = { shape: si.shape, params: si.shapeParams, outline: si.curve ? si.curve.points : si.localOutline, frame: sres.frame, ref: si.ref };
          const P = (p: { x: number; y: number }) => { const q = toSvg(p.x, p.y); return `${q.x},${q.y}`; };
          const fr = sres.frame;
          const o = toSvg(fr.origin.x, fr.origin.y);
          return (
            <g>
              {/* The reference: a dot on the origin ax and, with two axes, the
                  line between them — so it is visible what the sketch is
                  relative to, and which way "along" runs. */}
              {fr.refIds.length > 0 && (() => {
                const L = fr.refLengthMm > 0 ? fr.refLengthMm : 0;
                const e = toSvg(fr.origin.x + fr.dir.x * L, fr.origin.y + fr.dir.y * L);
                return (
                  <g pointerEvents="none">
                    {L > 0 && (
                      <line x1={o.x} y1={o.y} x2={e.x} y2={e.y}
                        stroke="#7c3aed" strokeWidth={1} strokeDasharray="8 3 2 3" opacity={0.8} />
                    )}
                    <circle cx={o.x} cy={o.y} r={4} fill="none" stroke="#7c3aed" strokeWidth={1.4} />
                    <circle cx={o.x} cy={o.y} r={1.2} fill="#7c3aed" />
                    {L > 0 && <circle cx={e.x} cy={e.y} r={2.5} fill="#7c3aed" opacity={0.8} />}
                  </g>
                );
              })()}
              {/* The drawn line itself is the grab area for moving the whole
                  sketch — a fat transparent stroke, the usual CAD affordance. */}
              {closed ? (
                <polygon points={outline.map(P).join(' ')}
                  fill="transparent" stroke="transparent" strokeWidth={6}
                  style={{ cursor: 'move' }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    startSketchDrag({ kind: 'body', nodeId: sel.id, from: clientToBim(e.clientX, e.clientY), ...drag });
                  }} />
              ) : (
                <polyline points={outline.map(P).join(' ')}
                  fill="none" stroke="transparent" strokeWidth={6}
                  style={{ cursor: 'move' }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    startSketchDrag({ kind: 'body', nodeId: sel.id, from: clientToBim(e.clientX, e.clientY), ...drag });
                  }} />
              )}
              {/* A control polygon is drawn: the curve is pulled towards it,
                  and without it the handles would seem to float. */}
              {si.curve?.mode === 'control' && handles.length > 1 && (
                <polyline points={[...handles, ...(closed ? [handles[0]] : [])].map(P).join(' ')}
                  fill="none" stroke="#D97706" strokeWidth={0.8} strokeDasharray="4 3"
                  opacity={0.8} pointerEvents="none" />
              )}
              {handles.map((p, i) => {
                const q = toSvg(p.x, p.y);
                return (
                  <rect key={i}
                    x={q.x - 2.6} y={q.y - 2.6} width={5.2} height={5.2}
                    fill="#fff" stroke="#D97706" strokeWidth={1.2}
                    style={{ cursor: 'grab' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startSketchDrag({ kind: 'vertex', nodeId: sel.id, index: i, ...drag });
                    }}>
                    <title>{`Punct ${i + 1} — trage pentru a muta`}</title>
                  </rect>
                );
              })}
              {/* The sketch's own numbers: sides, radius, segments, the offset
                  from its reference, the array step. `side` is BIM-left; with
                  SVG's y flipped, that is the NEGATIVE offset here. */}
              {showDims && sketchDims(sres).map((dm) => {
                const a = toSvg(dm.a.x, dm.a.y), b = toSvg(dm.b.x, dm.b.y);
                const off = -dm.side * DIM_OFF;
                const key = `sk_${dm.id}`;
                const color = dm.kind === 'u' || dm.kind === 'v' ? '#7c3aed' : dm.kind === 'step' ? '#0891b2' : '#b45309';
                const label = `${Math.round(dm.valueMm)}${dm.kind === 'r' ? ' R' : ''}`;
                const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
                const n = { x: -dy / L, y: dx / L };
                const at = { x: (a.x + b.x) / 2 + n.x * (off - Math.sign(off) * DIM_TEXT), y: (a.y + b.y) / 2 + n.y * (off - Math.sign(off) * DIM_TEXT) };
                return (
                  <PlanDim key={key} a={a} b={b} offset={off} label={label} color={color}
                    hidden={planDimEdit?.key === key}
                    onEdit={() => openDimEdit(key, dm.valueMm, at, (v) => {
                      const edit = applySketchDim(sres, dm, v);
                      if (!edit) return;
                      if (edit.params || edit.outline) applySketchEdit(sel.id, edit);
                      if (edit.props) patchSketchProps(sel.id, edit.props);
                    })} />
                );
              })}
            </g>
          );
        })()}

        {/* ── Inline value editor, over the number it replaces. Inside the SVG
            so it pans and zooms with the drawing. ── */}
        {planDimEdit && (
          <foreignObject x={planDimEdit.at.x - 30} y={planDimEdit.at.y - 6} width={60} height={12}>
            <input
              key={planDimEdit.key}
              type="text"
              inputMode="decimal"
              autoFocus
              value={planDimEdit.value}
              title="Enter = aplică · Shift+Enter = doar axul următor · Esc = anulează · acceptă formule (3000+500)"
              style={{
                width: 60, height: 12, fontSize: DIM_FONT, lineHeight: '12px', padding: '0 2px',
                textAlign: 'center', border: '0.6px solid #2563eb', borderRadius: 1.5,
                background: '#fff', color: '#111', outline: 'none', fontFamily: 'ui-monospace, monospace',
                boxSizing: 'border-box',
              }}
              onChange={(e) => setPlanDimEdit({ ...planDimEdit, value: e.target.value })}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') { e.preventDefault(); commitDimEdit(e.shiftKey); }
                else if (e.key === 'Escape') { e.preventDefault(); setPlanDimEdit(null); }
              }}
              onBlur={() => setPlanDimEdit(null)}
              onFocus={(e) => e.currentTarget.select()}
            />
          </foreignObject>
        )}

        {/* ── Sketch overlay: the rubber band and the points placed so far ── */}
        {sketchTool && (() => {
          const cursor = hoverSnap ?? hoverRaw;
          const pv = sketchToolPreview(sketchTool, sketchPts, cursor);
          const P = (p: { x: number; y: number }) => { const q = toSvg(p.x, p.y); return `${q.x},${q.y}`; };
          return (
            <g pointerEvents="none">
              {/* A contour previews as the area it encloses; a path is a run,
                  so it stays an open polyline rather than a closed loop. */}
              {pv && (pv.closed ? (
                <polygon points={pv.points.map(P).join(' ')}
                  fill="#D97706" fillOpacity={0.12}
                  stroke="#D97706" strokeWidth={1.2} strokeDasharray="4 2" />
              ) : (
                <polyline points={pv.points.map(P).join(' ')}
                  fill="none"
                  stroke="#D97706" strokeWidth={1.2} strokeDasharray="4 2" />
              ))}
              {sketchPts.map((p, i) => {
                const q = toSvg(p.x, p.y);
                return <circle key={i} cx={q.x} cy={q.y} r={2.2} fill="#D97706" stroke="#fff" strokeWidth={0.6} />;
              })}
              {cursor && (() => {
                const q = toSvg(cursor.x, cursor.y);
                return <circle cx={q.x} cy={q.y} r={3} fill="none" stroke="#D97706" strokeWidth={1} />;
              })()}
            </g>
          );
        })()}

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
          viewId={annViewId}
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
          dimStyleId={annSettings.dimStyleId}
          drawStyleId={annSettings.drawStyleId}
          selectedId={selectedAnnotationId}
          onSelectAnnotation={selectAnnotation}
          alsoViewIds={storeyId ? ['floorplan:all'] : undefined}
          idlePick={canPickBim}
        />
        {/* ── Armare 2D: forme, grips, selecție ── */}
        <RebarLayer toSvg={toSvg} fromSvgEvent={fromSvgEvent} scale={SCALE} />
      </svg>

      {/* ── Armare 2D: paletă + proprietăți ── */}
      {!embedded && showRebar && <div className="absolute top-12 left-2 z-20"><RebarPanel /></div>}

      {/* ── Plan toolbar ──────────────────────────────────────────────────
          Grouped and labelled, because a single row of nineteen glyphs had
          two of them meaning two things each: ▭ was both Wall and Rectangle,
          ✂ both Section and Trim. The thirteen annotation tools are not
          repeated here — they live, labelled, in the Drawing panel, and the
          button below says which one is armed. */}
      {!embedded && <div className="absolute top-2 left-2 z-10 flex items-center gap-2 bg-background/85 border border-border/60 rounded-md px-2 py-1 backdrop-blur-sm shadow-sm">

        {/* ── Model ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] uppercase tracking-wide text-muted-foreground/70 mr-0.5 select-none">Model</span>
          <button
            title={drawWallMode ? 'Perete — clic pentru a plasa (ESC anulează)' : 'Perete — clic două puncte'}
            onClick={() => {
              setDrawWallMode(!drawWallMode);
              setWallStart(null);
              setHoverSnap(null);
              setHoverRaw(null);
              setAnnTool(null);
              setPlanTool(null);
              setSketchTool(null);
              setSketchPts([]);
            }}
            className={cn(
              'h-6 px-1.5 flex items-center justify-center text-[10px] rounded transition-colors select-none',
              drawWallMode ? 'bg-orange-500 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >Perete</button>
          <button
            title={drawSectionMode ? 'Secțiune — clic A, clic B, apoi pe partea privită (Alt = unghi liber, ESC anulează)' : 'Secțiune — clic A, clic B, apoi pe partea privită'}
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
              'h-6 px-1.5 flex items-center justify-center text-[10px] rounded transition-colors select-none',
              drawSectionMode ? 'bg-rose-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >Secțiune</button>
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
              sectionOnAxisMode ? 'bg-rose-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >⊕</button>
        </div>

        <div className="w-px h-5 bg-border" />

        {/* ── Sketch: 2D drawn, 3D body ─────────────────────────────────── */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] uppercase tracking-wide text-muted-foreground/70 mr-0.5 select-none">Schiță 3D</span>
          {SKETCH_TOOLS.map((t) => (
            <button
              key={t.tool}
              title={`${t.label} — ${t.hint}`}
              onClick={() => {
                const next = sketchTool === t.tool ? null : t.tool;
                setSketchTool(next);
                setSketchPts([]);
                setDrawWallMode(false);
                setWallStart(null);
                setAnnTool(null);
                setPlanTool(null);
              }}
              className={cn(
                'h-6 px-1.5 flex items-center justify-center text-[10px] rounded transition-colors select-none',
                sketchTool === t.tool ? 'bg-amber-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >{t.label}</button>
          ))}
        </div>

        <div className="w-px h-5 bg-border" />

        {/* ── Annotation: one entry point, not thirteen glyphs ───────────── */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] uppercase tracking-wide text-muted-foreground/70 mr-0.5 select-none">Desen</span>
          <button
            title={annTool ? `Unealtă de desen activă: ${annTool}. Clic pentru panoul de desen.` : 'Panou desen — unelte, culori, hașuri'}
            onClick={() => { setShowDrawingPanel(!showDrawingPanel); setShowFilterPanel(false); }}
            className={cn(
              'h-6 px-1.5 flex items-center justify-center text-[10px] rounded transition-colors select-none gap-1',
              showDrawingPanel || annTool ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <span>🎨</span>
            <span>{annTool ?? 'Desen'}</span>
          </button>
          {annTool && (
            <button
              title="Oprește unealta de desen"
              onClick={() => setAnnTool(null)}
              className="w-5 h-6 flex items-center justify-center text-[10px] rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >✕</button>
          )}
          <button
            title="Șterge toate adnotările din acest view"
            onClick={() => { clearViewAnnotations(storeyId ?? 'floorplan:all'); if (storeyId) clearViewAnnotations('floorplan:all'); }}
            className="w-6 h-6 flex items-center justify-center text-xs rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 transition-colors"
          >🗑</button>
        </div>

        <div className="w-px h-5 bg-border" />

        {/* ── Rebar: a mode, opened on demand ───────────────────────────── */}
        <button
          title="Armare 2D — bare, etriere, cofraj"
          onClick={() => setShowRebar((v) => !v)}
          className={cn(
            'h-6 px-1.5 flex items-center justify-center text-[10px] rounded transition-colors select-none',
            showRebar ? 'bg-rose-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >Armare</button>

        <div className="w-px h-5 bg-border" />

        {/* ── View ──────────────────────────────────────────────────────── */}
        <button
          title="Cote parametrice — deschiderile axelor și dimensiunile schiței selectate; clic pe cifră ca să o schimbi"
          onClick={() => setShowDims((v) => !v)}
          className={cn(
            'h-6 px-1.5 flex items-center justify-center text-[10px] rounded transition-colors select-none',
            showDims ? 'bg-slate-700 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >Cote</button>
        <button
          title="Plan de tăiere și filtre de vizibilitate"
          onClick={() => { setShowFilterPanel(!showFilterPanel); setShowDrawingPanel(false); }}
          className={cn(
            'w-6 h-6 flex items-center justify-center text-xs rounded transition-colors select-none',
            showFilterPanel ? 'bg-indigo-600 text-white' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >⚙</button>
      </div>}

      {/* ── Sketch hint bar: says what the armed tool expects ── */}
      {!embedded && sketchTool && (
        <div className="absolute top-11 left-2 z-10 text-[10px] bg-amber-600 text-white rounded px-2 py-1 shadow-sm select-none">
          {sketchToolDef(sketchTool).label} · {sketchToolDef(sketchTool).hint}
          {sketchPts.length === 0 && ' · Pornit dintr-un punct de ax, desenul rămâne legat de el.'}
          {sketchPts.length > 0 && ` · ${sketchPts.length} puncte`}
        </div>
      )}

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
