/**
 * standaloneDrawings.tsx — the 2D drawings as static SVG text.
 *
 * Section2DViewer and Elevation2DViewer are live React components: they
 * pan, zoom, annotate and redraw as the graph changes. An exported file
 * needs none of that — it needs the same drawing, once, as text. So this
 * runs the same engine (`computeSectionView` / `computeElevationView`) and
 * the same renderer (`buildDrawingSvg`, the hatch defs) and prints the
 * result with `renderToStaticMarkup`. Whatever the viewers draw, the export
 * draws; there is no second drawing code path to keep in step.
 *
 * Every `<svg>` is self-contained: its own `viewBox`, its own hatch
 * patterns. The hatch ids repeat from one drawing to the next, which is why
 * the exported viewer puts only one drawing in the page at a time.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes } from '@/store';
import { FloorPlan2DViewer } from '@/components/views/FloorPlan2DViewer';
import type { MaterialConfig } from '@/lib/materialConfig';
import {
  computeElevationView, computeSectionView, elevationCut,
  type DrawingResult, type ElevationDir, type KernelOutlines, type SectionCut,
} from '@/lib/drawingEngine';
import { TEXT, drawingStyle, fitScale } from '@/lib/drawingStyle';
import { autoDimensions, dimensionReach } from '@/lib/drawingDimensions';
import { resolveSectionCut } from '@/lib/sectionFromPlan';
import { SvgHatchDefs } from '@/components/views/SvgHatches';
import { buildDrawingSvg, sheetBounds } from '@/components/views/drawingSvg';
import type { StandaloneDrawing } from './standaloneTypes';

/** Hatch tile in paper millimetres — the same pen the viewers use. */
const HATCH_TILE_MM = 2.5;
/** Paper millimetres a caption strip takes above the drawing. */
const CAPTION_MM = 8;

const ELEVATIONS: { dir: ElevationDir; title: string }[] = [
  { dir: 'N', title: 'Fațada nord' },
  { dir: 'S', title: 'Fațada sud' },
  { dir: 'E', title: 'Fațada est' },
  { dir: 'W', title: 'Fațada vest' },
];

/** The kernel's outlines for a cut, if a caller has them; null draws the engine alone. */
export type OutlinesFor = (cut: SectionCut) => KernelOutlines | null;

export interface DrawingSvgOptions {
  /** Dimension the openings too (a facade does; a section does not). */
  openings?: boolean;
  /** A caption over the drawing, the way a facade names its direction. */
  caption?: string;
}

/** One engine result as a complete `<svg>` string. */
export function drawingToSvg(drawing: DrawingResult, opts: DrawingSvgOptions = {}): string {
  const style = drawingStyle(fitScale(drawing.uMax - drawing.uMin, drawing.vMax - drawing.vMin));
  const dimensions = autoDimensions(drawing, style, opts.openings ? { openings: true } : undefined);
  // The caption sits in its own strip above the drawing, not over the top level line.
  const bounds = sheetBounds(drawing, style, { ...dimensionReach(dimensions, drawing), top: opts.caption ? style.paper(CAPTION_MM) : 0 });
  const { uMin, uMax, vMin, vMax, width, height } = bounds;
  const toX = (u: number) => u - uMin;
  const toY = (v: number) => height - (v - vMin);

  const els = buildDrawingSvg({ drawing, style, bounds, toX, toY, dimensions });
  const caption = opts.caption ? (
    <text key="caption"
      x={toX((uMin + uMax) / 2)} y={toY(vMax - style.paper(4))}
      textAnchor="middle" dominantBaseline="central"
      fontSize={style.text(TEXT.large)} fontFamily="sans-serif" fontWeight="600" fill="#475569">
      {opts.caption}
    </text>
  ) : null;

  return renderToStaticMarkup(
    <svg xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width.toFixed(2)} ${height.toFixed(2)}`}
      preserveAspectRatio="xMidYMid meet">
      <SvgHatchDefs tileSize={style.paper(HATCH_TILE_MM)} />
      {els}
      {caption}
    </svg>,
  );
}

/**
 * A storey's floor plan as a complete `<svg>` string — the plan viewer
 * itself, rendered once, statically.
 *
 * The plan is not a product of the drawing engine: `FloorPlan2DViewer`
 * computes its own geometry inline, and carries what the engine does not —
 * the opening symbols, the room fills and areas, the annotations, the
 * section markers. Rendering the component is the only way to get that
 * drawing, and it renders statically well enough: the hooks that need a
 * browser (fit-to-view, wheel zoom) simply never run.
 *
 * What comes out is the viewer's whole canvas, blank margin included; the
 * exported viewer frames the drawn part when it shows the plan, the way the
 * app does when the tab opens. Null when the component cannot render.
 */
export function renderPlanSvg(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  buildingAxes: BuildingAxes,
  storeyId: string,
): string | null {
  let html: string;
  try {
    html = renderToStaticMarkup(
      <FloorPlan2DViewer nodes={nodes} edges={edges} buildingAxes={buildingAxes}
        storeyId={storeyId} discipline="architectural" embedded />,
    );
  } catch {
    return null;
  }
  const i = html.indexOf('<svg'), j = html.lastIndexOf('</svg>');
  if (i < 0 || j < 0) return null;
  let svg = html.slice(i, j + 6);
  // The root carries the viewer's pan/zoom transform; a static sheet has none.
  svg = svg.replace(/^<svg([^>]*)>/, (_, attrs: string) => `<svg${attrs.replace(/\sstyle="[^"]*"/, '')}>`);
  if (!/^<svg[^>]*\sxmlns=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}

export interface StandaloneDrawingOptions {
  /** With these, a plan is drawn for every storey, first. */
  buildingAxes?: BuildingAxes;
}

/**
 * Every drawing the model has: a plan per storey, the four facades, then
 * each section marker in the graph. A drawing with nothing in it (a facade
 * of an empty model) is left out rather than exported as a blank sheet.
 */
export function buildStandaloneDrawings(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null,
  outlinesFor: OutlinesFor = () => null,
  opts: StandaloneDrawingOptions = {},
): StandaloneDrawing[] {
  const out: StandaloneDrawing[] = [];

  if (opts.buildingAxes) {
    const storeys = nodes
      .filter((n) => n.type === 'storey')
      .sort((a, b) => Number(a.properties.bottomElevation ?? 0) - Number(b.properties.bottomElevation ?? 0));
    for (const s of storeys) {
      const svg = renderPlanSvg(nodes, edges, opts.buildingAxes, s.id);
      if (!svg) continue;
      out.push({ id: `plan-${s.id}`, title: `Plan ${s.name || s.id}`, kind: 'plan', svg });
    }
  }

  for (const { dir, title } of ELEVATIONS) {
    const cut = elevationCut(nodes, dir);
    const outlines = outlinesFor(cut);
    const drawing = computeElevationView(nodes, edges, matConfig, dir, undefined, undefined, outlines ? { outlines } : undefined);
    if (drawing.shapes.length === 0) continue;
    out.push({ id: `elevation-${dir}`, title, kind: 'elevation', svg: drawingToSvg(drawing, { openings: true, caption: title }) });
  }

  let k = 0;
  for (const n of nodes) {
    if (n.type !== 'section') continue;
    const spec = resolveSectionCut(n, nodes, edges);
    if (!spec) continue;
    k++;
    const cut: SectionCut = {
      line: spec.line, lookSide: spec.lookSide, cutDepth: spec.depthMm, clipToLine: spec.clipToMarker,
      elevMin: spec.elevMin ?? undefined, elevMax: spec.elevMax ?? undefined,
    };
    const outlines = outlinesFor(cut);
    const drawing = computeSectionView(nodes, edges, matConfig, cut, outlines ? { outlines } : undefined);
    if (drawing.shapes.length === 0) continue;
    const title = n.name?.trim() || `Secțiune ${k}`;
    out.push({ id: `section-${n.id}`, title, kind: 'section', svg: drawingToSvg(drawing, { caption: title }) });
  }
  return out;
}
