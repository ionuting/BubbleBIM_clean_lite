/**
 * svgSymbolStore.ts — parametric SVG symbol graph library.
 *
 * Symbols are defined as mini node-edge graphs in mm coordinate space:
 *   X: 0 = left jamb of opening ... W = right jamb
 *   Y: 0 = outer wall face ... increases toward interior
 *
 * Node types:
 *   sp  — anchor point  (props: x_mm, y_mm, name?)
 *   sl  — line segment  (props: stroke, weight, dash?)  — references 2 sp via 'ref' edges
 *   sa  — arc           (props: cx_mm, cy_mm, r_mm, a0, a1, stroke, weight, clockwise?)
 *   st  — text label    (props: x_mm, y_mm, content, size_mm, color, anchor?, bold?)
 *   sh  — hatch/fill    (props: fill_color, fill_opacity, pattern, stroke?, weight?)
 *          — references N sp nodes via ordered 'poly' edges
 *
 * Expressions in *_mm and content fields are evaluated using safeEval with context:
 *   { W, T, SH, FD, outer_off, inner_off, sill_proj, sq, gw }
 *   W         = opening width mm
 *   T         = wall thickness mm
 *   SH        = sill height mm
 *   FD        = frame depth mm
 *   outer_off = outer line offset from wall centre mm
 *   inner_off = inner line offset from wall centre mm
 *   sill_proj = sill projection beyond inner face mm
 *   sq        = frame square side mm
 *   gw        = glass pane half-width mm
 */

import { safeEval } from '@/lib/formulaUtils';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SymNodeType = 'sp' | 'sl' | 'sa' | 'st' | 'sh';
export type SymEdgeType = 'ref' | 'poly';

export type HatchPatternType = 'none' | 'solid' | 'diagonal' | 'crosshatch' | 'brick' | 'dots';

export interface SvgSymNode {
  id: string;
  type: SymNodeType;
  label: string;
  /** Display position on the editor canvas (mm in symbol space) */
  cx: number;
  cy: number;
  props: Record<string, unknown>;
}

// Point node props
export interface SpProps {
  x_mm: string | number;
  y_mm: string | number;
  name?: string;
}

// Line node props
export interface SlProps {
  stroke: string;
  weight: number;
  dash?: boolean;
  linecap?: 'round' | 'square' | 'butt';
}

// Arc node props (no edge references — self-contained)
export interface SaProps {
  cx_mm: string | number;
  cy_mm: string | number;
  r_mm:  string | number;
  a0:    number;   // start angle in degrees (0=right, CCW positive)
  a1:    number;   // end angle in degrees
  stroke: string;
  weight: number;
  clockwise?: boolean;
}

// Text node props (self-contained)
export interface StProps {
  x_mm:    string | number;
  y_mm:    string | number;
  content: string;
  size_mm: number;
  color:   string;
  anchor?: 'start' | 'middle' | 'end';
  bold?:   boolean;
}

// Hatch/fill node props (polygon defined by sp nodes via 'poly' edges)
export interface ShProps {
  fill_color:   string;
  fill_opacity: number;
  pattern:      HatchPatternType;
  stroke?:      string;
  weight?:      number;
  dash?:        boolean;
}

export interface SvgSymEdge {
  id: string;
  from: string;   // node id
  to:   string;   // node id (for ref edges: to sp node; for poly: to sp polygon vertex)
  type: SymEdgeType;
  order?: number; // for poly edges: vertex order in polygon
}

export interface SvgSymbolDef {
  id: string;
  name: string;
  elementType: 'window' | 'door';
  /** 'opening:single' | 'opening:double' | specific typeId */
  typeKey: string;
  viewType: 'floorplan' | 'section' | 'elevation';
  nodes: SvgSymNode[];
  edges: SvgSymEdge[];
  updatedAt: number;
}

export interface SymRenderParams {
  W:          number;  // opening width mm
  T:          number;  // wall thickness mm
  SH?:        number;  // sill height mm
  FD?:        number;  // frame depth mm
  outer_off?: number;  // outer frame line offset from outer wall face (mm)
  inner_off?: number;  // inner frame line offset
  sill_proj?: number;  // sill projection below inner frame
  sq?:        number;  // frame square side mm
  gw?:        number;  // glass pane half-width mm
  [k: string]: number | undefined;
}

// ─── Expression evaluator ─────────────────────────────────────────────────────

export function evalSymExpr(
  expr: string | number | undefined,
  ctx: Record<string, number>,
): number {
  if (typeof expr === 'number') return expr;
  if (!expr) return 0;
  try {
    const result = safeEval(String(expr), ctx as Parameters<typeof safeEval>[1]);
    return typeof result === 'number' && isFinite(result) ? result : 0;
  } catch {
    return 0;
  }
}

function buildCtx(params: SymRenderParams): Record<string, number> {
  return {
    W:         params.W,
    T:         params.T,
    SH:        params.SH        ?? 900,
    FD:        params.FD        ?? 100,
    outer_off: params.outer_off ?? 125,
    inner_off: params.inner_off ?? 125,
    sill_proj: params.sill_proj ?? 200,
    sq:        params.sq        ?? 70,
    gw:        params.gw        ?? 15,
  };
}

// ─── SVG hatch pattern builder ────────────────────────────────────────────────

export function buildSymHatchPattern(
  id: string,
  pattern: HatchPatternType,
  color: string,
  lineWeight: number,
): string {
  const w = Math.max(0.3, lineWeight * 0.6);
  switch (pattern) {
    case 'diagonal':
      return `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse">
        <line x1="0" y1="6" x2="6" y2="0" stroke="${color}" stroke-width="${w}"/></pattern>`;
    case 'crosshatch':
      return `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse">
        <line x1="0" y1="6" x2="6" y2="0" stroke="${color}" stroke-width="${w}"/>
        <line x1="0" y1="0" x2="6" y2="6" stroke="${color}" stroke-width="${w}"/></pattern>`;
    case 'brick':
      return `<pattern id="${id}" width="12" height="6" patternUnits="userSpaceOnUse">
        <rect x="0.5" y="0.5" width="11" height="5" fill="none" stroke="${color}" stroke-width="${w}"/>
        <line x1="6" y1="0" x2="6" y2="3" stroke="${color}" stroke-width="${w}"/>
        <line x1="0" y1="3" x2="12" y2="3" stroke="${color}" stroke-width="${w}"/></pattern>`;
    case 'dots':
      return `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse">
        <circle cx="3" cy="3" r="${w * 1.2}" fill="${color}"/></pattern>`;
    default: return '';
  }
}

// ─── SVG string renderer ──────────────────────────────────────────────────────

/**
 * Renders a symbol definition as a standalone SVG string.
 * Used for previews in the editor.
 */
export function renderSymbolSVGString(
  def: SvgSymbolDef,
  params: SymRenderParams,
  svgW: number,
  svgH: number,
): string {
  const ctx = buildCtx(params);
  const totalH = ctx.outer_off + ctx.inner_off + ctx.sill_proj;
  const PAD = 18;
  const avW = svgW - PAD * 2;
  const avH = svgH - PAD * 2;
  const scale = Math.min(avW / params.W, avH / Math.max(params.T, totalH + 10));

  const oxSvg = (svgW - params.W * scale) / 2;
  const oySvg = PAD;

  function toSvgPt(xmm: number, ymm: number) {
    return { x: oxSvg + xmm * scale, y: oySvg + ymm * scale };
  }

  // Evaluate all 'sp' nodes → map id→SVG position
  const ptMap = new Map<string, { x: number; y: number }>();
  for (const n of def.nodes) {
    if (n.type === 'sp') {
      const p = n.props as SpProps;
      ptMap.set(n.id, toSvgPt(evalSymExpr(p.x_mm, ctx), evalSymExpr(p.y_mm, ctx)));
    }
  }

  // Edge adjacency: from→edges (for sl and sh nodes)
  const nodeEdges = new Map<string, SvgSymEdge[]>();
  for (const e of def.edges) {
    if (!nodeEdges.has(e.from)) nodeEdges.set(e.from, []);
    nodeEdges.get(e.from)!.push(e);
  }

  const parts: string[] = [];
  const hatchDefs: string[] = [];
  let hatchIdx = 0;

  // Wall context band (grey) — outer face at y=outer_off-T/2, inner at y=outer_off+T/2
  const wallTopY = oySvg + (ctx.outer_off - params.T / 2) * scale;
  const wallBotY = oySvg + (ctx.outer_off + params.T / 2) * scale;
  const bandExt = 20;
  parts.push(
    `<rect x="${(oxSvg - bandExt).toFixed(1)}" y="${wallTopY.toFixed(1)}"` +
    ` width="${(params.W * scale + bandExt * 2).toFixed(1)}"` +
    ` height="${(wallBotY - wallTopY).toFixed(1)}" fill="#CBD5E1"/>`,
  );

  // Render each non-point node
  for (const n of def.nodes) {
    switch (n.type) {
      case 'sl': {
        const p = n.props as SlProps;
        const refs = (nodeEdges.get(n.id) ?? []).filter((e) => e.type === 'ref');
        if (refs.length >= 2) {
          const a = ptMap.get(refs[0].to);
          const b = ptMap.get(refs[1].to);
          if (a && b) {
            const dash = p.dash ? ' stroke-dasharray="4 3"' : '';
            const cap = `stroke-linecap="${p.linecap ?? 'square'}"`;
            parts.push(
              `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}"` +
              ` x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"` +
              ` stroke="${p.stroke}" stroke-width="${p.weight}" ${cap}${dash}/>`,
            );
          }
        }
        break;
      }
      case 'sa': {
        const p = n.props as SaProps;
        const cx = oxSvg + evalSymExpr(p.cx_mm, ctx) * scale;
        const cy = oySvg + evalSymExpr(p.cy_mm, ctx) * scale;
        const r  = evalSymExpr(p.r_mm, ctx) * scale;
        const a0r = (p.a0 * Math.PI) / 180;
        const a1r = (p.a1 * Math.PI) / 180;
        // SVG uses Y-down; BIM math uses Y-up — so negate Y sin
        const x0 = cx + r * Math.cos(a0r);
        const y0 = cy - r * Math.sin(a0r);
        const x1 = cx + r * Math.cos(a1r);
        const y1 = cy - r * Math.sin(a1r);
        const large  = Math.abs(p.a1 - p.a0) > 180 ? 1 : 0;
        const sweep  = p.clockwise ? 1 : 0;
        parts.push(
          `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)}` +
          ` A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${large} ${sweep} ${x1.toFixed(1)} ${y1.toFixed(1)}"` +
          ` fill="none" stroke="${p.stroke}" stroke-width="${p.weight}"/>`,
        );
        break;
      }
      case 'st': {
        const p = n.props as StProps;
        const sp = toSvgPt(evalSymExpr(p.x_mm, ctx), evalSymExpr(p.y_mm, ctx));
        const fs = p.size_mm * scale;
        const fw = p.bold ? ' font-weight="bold"' : '';
        parts.push(
          `<text x="${sp.x.toFixed(1)}" y="${sp.y.toFixed(1)}"` +
          ` font-family="sans-serif" font-size="${fs.toFixed(1)}" fill="${p.color}"` +
          ` text-anchor="${p.anchor ?? 'middle'}" dominant-baseline="middle"${fw}>${p.content}</text>`,
        );
        break;
      }
      case 'sh': {
        const p = n.props as ShProps;
        const polyEdges = (nodeEdges.get(n.id) ?? [])
          .filter((e) => e.type === 'poly')
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const pts = polyEdges
          .map((e) => ptMap.get(e.to))
          .filter(Boolean) as { x: number; y: number }[];
        if (pts.length >= 3) {
          const ptStr = pts.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
          let fillAttr: string;
          if (p.pattern === 'solid') {
            fillAttr = `fill="${p.fill_color}" fill-opacity="${p.fill_opacity}"`;
          } else if (p.pattern !== 'none' && p.pattern !== 'solid') {
            const patId = `sym_h_${hatchIdx++}`;
            hatchDefs.push(buildSymHatchPattern(patId, p.pattern, p.fill_color, p.weight ?? 1));
            fillAttr = `fill="url(#${patId})" fill-opacity="${p.fill_opacity}"`;
          } else {
            fillAttr = 'fill="none"';
          }
          const strokeAttr = p.stroke
            ? ` stroke="${p.stroke}" stroke-width="${p.weight ?? 1}"${p.dash ? ' stroke-dasharray="4 3"' : ''}`
            : ' stroke="none"';
          parts.push(`<polygon points="${ptStr}" ${fillAttr}${strokeAttr}/>`);
        }
        break;
      }
      // sp nodes don't render in the output SVG (only used as anchors)
    }
  }

  const defs = hatchDefs.length
    ? `<defs>${hatchDefs.join('\n')}</defs>\n  `
    : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}"` +
    ` style="background:#f0f0ec;border-radius:4px;">\n  ${defs}` +
    parts.join('\n  ') +
    `\n</svg>`
  );
}

/**
 * Renders a symbol as SVG element strings for inline use in FloorPlan2DViewer.
 * Returns the inner SVG (no wrapper) in symbol mm space.
 * The caller MUST wrap these in:
 *   <g transform="matrix(e1x*S,e1y*S,e2x*S,e2y*S,sfO.x,sfO.y)">
 * where S = SCALE (mm→SVG units), e1/e2 are the along-wall and into-wall unit vectors.
 */
export function renderSymbolInlineElements(
  def: SvgSymbolDef,
  params: SymRenderParams,
): string[] {
  const ctx = buildCtx(params);
  const parts: string[] = [];
  const hatchDefs: string[] = [];
  let hatchIdx = 0;

  // Evaluate all 'sp' node positions in mm
  const ptMap = new Map<string, { x: number; y: number }>();
  for (const n of def.nodes) {
    if (n.type === 'sp') {
      const p = n.props as SpProps;
      ptMap.set(n.id, {
        x: evalSymExpr(p.x_mm, ctx),
        y: evalSymExpr(p.y_mm, ctx),
      });
    }
  }

  const nodeEdges = new Map<string, SvgSymEdge[]>();
  for (const e of def.edges) {
    if (!nodeEdges.has(e.from)) nodeEdges.set(e.from, []);
    nodeEdges.get(e.from)!.push(e);
  }

  for (const n of def.nodes) {
    switch (n.type) {
      case 'sl': {
        const p = n.props as SlProps;
        const refs = (nodeEdges.get(n.id) ?? []).filter((e) => e.type === 'ref');
        if (refs.length >= 2) {
          const a = ptMap.get(refs[0].to);
          const b = ptMap.get(refs[1].to);
          if (a && b) {
            const dash = p.dash ? ' stroke-dasharray="40 30"' : '';
            parts.push(
              `<line x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}"` +
              ` x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}"` +
              ` stroke="${p.stroke}" stroke-width="${p.weight}"` +
              ` stroke-linecap="${p.linecap ?? 'square'}"${dash}/>`,
            );
          }
        }
        break;
      }
      case 'sa': {
        const p = n.props as SaProps;
        const cx = evalSymExpr(p.cx_mm, ctx);
        const cy = evalSymExpr(p.cy_mm, ctx);
        const r  = evalSymExpr(p.r_mm, ctx);
        const a0r = (p.a0 * Math.PI) / 180;
        const a1r = (p.a1 * Math.PI) / 180;
        const x0 = cx + r * Math.cos(a0r);
        const y0 = cy - r * Math.sin(a0r);
        const x1 = cx + r * Math.cos(a1r);
        const y1 = cy - r * Math.sin(a1r);
        const large = Math.abs(p.a1 - p.a0) > 180 ? 1 : 0;
        const sweep = p.clockwise ? 1 : 0;
        parts.push(
          `<path d="M ${x0.toFixed(2)} ${y0.toFixed(2)}` +
          ` A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}"` +
          ` fill="none" stroke="${p.stroke}" stroke-width="${p.weight}"/>`,
        );
        break;
      }
      case 'st': {
        const p = n.props as StProps;
        const x = evalSymExpr(p.x_mm, ctx);
        const y = evalSymExpr(p.y_mm, ctx);
        const fw = p.bold ? ' font-weight="bold"' : '';
        parts.push(
          `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}"` +
          ` font-family="sans-serif" font-size="${p.size_mm.toFixed(1)}" fill="${p.color}"` +
          ` text-anchor="${p.anchor ?? 'middle'}" dominant-baseline="middle"${fw}>${p.content}</text>`,
        );
        break;
      }
      case 'sh': {
        const p = n.props as ShProps;
        const polyEdges = (nodeEdges.get(n.id) ?? [])
          .filter((e) => e.type === 'poly')
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const pts = polyEdges
          .map((e) => ptMap.get(e.to))
          .filter(Boolean) as { x: number; y: number }[];
        if (pts.length >= 3) {
          const ptStr = pts.map((pt) => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ');
          let fillAttr: string;
          if (p.pattern === 'solid') {
            fillAttr = `fill="${p.fill_color}" fill-opacity="${p.fill_opacity}"`;
          } else if (p.pattern !== 'none') {
            const patId = `isym_h_${hatchIdx++}_${n.id}`;
            hatchDefs.push(buildSymHatchPattern(patId, p.pattern, p.fill_color, p.weight ?? 1));
            fillAttr = `fill="url(#${patId})" fill-opacity="${p.fill_opacity}"`;
          } else {
            fillAttr = 'fill="none"';
          }
          const strokeAttr = p.stroke
            ? ` stroke="${p.stroke}" stroke-width="${p.weight ?? 1}"${p.dash ? ' stroke-dasharray="40 30"' : ''}`
            : ' stroke="none"';
          parts.push(`<polygon points="${ptStr}" ${fillAttr}${strokeAttr}/>`);
        }
        break;
      }
    }
  }

  if (hatchDefs.length) {
    // Inline defs at the start of the parts array
    parts.unshift(`<defs>${hatchDefs.join('')}</defs>`);
  }

  return parts;
}

// ─── ID generator ────────────────────────────────────────────────────────────

let _symIdCtr = 0;
export function symId(prefix: string = 'n'): string {
  return `${prefix}_${Date.now().toString(36)}_${(++_symIdCtr).toString(36)}`;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const _registry = new Map<string, SvgSymbolDef>();
const _listeners = new Set<() => void>();

/** Canonical key for a symbol definition. */
export function symbolKey(
  elementType: string,
  typeKey: string,
  viewType: string,
): string {
  return `${elementType}:${typeKey}:${viewType}`;
}

/** Return the user-defined symbol for a given combination, or null if not set. */
export function resolveSymbolDef(
  elementType: string,
  typeKey: string,
  viewType: string,
): SvgSymbolDef | null {
  return _registry.get(symbolKey(elementType, typeKey, viewType)) ?? null;
}

/** Store or replace a symbol definition. */
export function setSymbolDef(def: SvgSymbolDef): void {
  _registry.set(symbolKey(def.elementType, def.typeKey, def.viewType), def);
  _listeners.forEach((fn) => fn());
}

/** Delete a symbol definition (falls back to hardcoded rendering). */
export function deleteSymbolDef(elementType: string, typeKey: string, viewType: string): void {
  _registry.delete(symbolKey(elementType, typeKey, viewType));
  _listeners.forEach((fn) => fn());
}

/** List all defined symbols. */
export function listSymbolDefs(): SvgSymbolDef[] {
  return Array.from(_registry.values());
}

export function subscribeSymbolLibrary(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const STORAGE_KEY = 'bg_svg_symbol_library_v1';

export function exportSymbolLibrary(): Record<string, SvgSymbolDef> {
  return Object.fromEntries(_registry.entries());
}

export function importSymbolLibrary(data: Record<string, SvgSymbolDef>): void {
  _registry.clear();
  for (const [k, v] of Object.entries(data)) _registry.set(k, v);
  _listeners.forEach((fn) => fn());
}

export function loadSymbolLibraryFromStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) importSymbolLibrary(JSON.parse(raw));
  } catch { /* ignore */ }
}

export function saveSymbolLibraryToStorage(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(exportSymbolLibrary()));
  } catch { /* ignore */ }
}

// Load at module init
loadSymbolLibraryFromStorage();

// ─── Default render params from WindowPlan2DConfig ───────────────────────────

/**
 * Build SymRenderParams from a resolved WindowPlan2DConfig + actual window dimensions.
 * Import WindowPlan2DConfig from windowSymbolLibrary where needed.
 */
export function buildWindowSymRenderParams(
  cfg: {
    outerLineOffset_mm: number;
    innerLineOffset_mm: number;
    sillProjection_mm: number;
    squareSide_mm: number;
    glassPanelWidth_mm: number;
  },
  W_mm: number,
  T_mm: number,
  SH_mm?: number,
  FD_mm?: number,
): SymRenderParams {
  return {
    W: W_mm,
    T: T_mm,
    SH: SH_mm ?? 900,
    FD: FD_mm ?? 100,
    outer_off: cfg.outerLineOffset_mm,
    inner_off: cfg.innerLineOffset_mm,
    sill_proj: cfg.sillProjection_mm,
    sq: cfg.squareSide_mm,
    gw: cfg.glassPanelWidth_mm / 2,
  };
}

/** Build SymRenderParams for door plan symbols (y: 0 = outer face, T = inner face). */
export function buildDoorSymRenderParams(
  _cfg: Record<string, unknown>,
  W_mm: number,
  T_mm: number,
): SymRenderParams {
  return {
    W: W_mm,
    T: T_mm,
    outer_off: T_mm / 2,
    inner_off: 0,
    sill_proj: 0,
    sq: 0,
    gw: 0,
  };
}
