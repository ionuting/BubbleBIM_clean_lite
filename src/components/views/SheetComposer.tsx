/**
 * SheetComposer — Interactive drawing sheet composer (BIM A0–A4 + custom).
 *
 * Features:
 *  - Standard paper sizes A0–A4, A0+, custom with landscape/portrait toggle
 *  - Configurable title block (project name, sheet number, date, drawn-by, scale)
 *  - Add viewports from floor plans, sections and elevations
 *  - Drag to move, resize (corner handle), scale, crop each viewport
 *  - Inline SVG rendering of floor plans using bimGeometry (no Three.js)
 *  - Simplified SVG elevation rendering for section/elevation viewports
 *  - Export sheet as SVG
 */

import React, {
  useMemo, useState, useRef, useCallback, useEffect,
} from 'react';
import { cn } from '@/lib/utils';
import type { BubbleGraphNode, BubbleGraphEdge, ViewTab, StoreyDiscipline } from '@/store';
import { useBubbleGraphStore } from '@/store';
import { parseAxes } from '@/lib/utils';
import type { MaterialConfig } from '@/lib/materialConfig';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { viewportContent } from '@/lib/sheetSvg';
import { downloadText, safeFilename } from '@/lib/download';
import { FloorPlan2DViewer } from './FloorPlan2DViewer';
import { Section2DViewer } from './Section2DViewer';
import { Elevation2DViewer } from './Elevation2DViewer';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SheetViewportDef {
  id: string;
  type: 'floorplan' | 'section' | 'elevation';
  /** Source storey id (for floorplan / section) */
  storeyId?: string;
  /** Discipline filter for floor plan viewports */
  discipline?: StoreyDiscipline;
  /** Elevation view direction */
  viewDirection?: 'N' | 'S' | 'E' | 'W';
  /** Section cut Y position in BIM mm */
  cutY?: number;
  /** Section cut depth in mm */
  cutDepth?: number;
  /** Section start elevation in mm */
  startElevation?: number;
  /** Section end elevation in mm */
  endElevation?: number;
  /** Section flipped flag */
  flipped?: boolean;
  /** Section/elevation source node id */
  sectionNodeId?: string;
  /** Elevation cutX (for elevation views) */
  cutX?: number;
  /** Label shown below viewport */
  label: string;
  /** Position on sheet in mm (from paper top-left) */
  x: number;
  y: number;
  /** Frame size on sheet in mm */
  frameW: number;
  frameH: number;
  /** Drawing scale 1:N  (e.g. 100 = 1:100) — informational, shown in label */
  scale: number;
  /** Crop: model-space centre of visible area (BIM mm) */
  cropCX: number;
  cropCY: number;
  showBorder: boolean;
  showLabel: boolean;
  showScaleText: boolean;
}

export interface TitleBlockDef {
  show: boolean;
  projectName: string;
  sheetNumber: string;
  drawDate: string;
  drawnBy: string;
  scale: string;
}

export interface SheetDef {
  paperId: string;
  paperW: number;   // mm
  paperH: number;   // mm
  orientation: 'landscape' | 'portrait';
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  viewports: SheetViewportDef[];
  titleBlock: TitleBlockDef;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const PAPER_SIZES: Record<string, { w: number; h: number; label: string }> = {
  'A4':     { w: 297,  h: 210,  label: 'A4  (297×210 mm)' },
  'A3':     { w: 420,  h: 297,  label: 'A3  (420×297 mm)' },
  'A2':     { w: 594,  h: 420,  label: 'A2  (594×420 mm)' },
  'A1':     { w: 841,  h: 594,  label: 'A1  (841×594 mm)' },
  'A0':     { w: 1189, h: 841,  label: 'A0  (1189×841 mm)' },
  'A0+':    { w: 1189, h: 914,  label: 'A0+ (1189×914 mm)' },
  'custom': { w: 841,  h: 594,  label: 'Custom' },
};

const SCALE_PRESETS = [5, 10, 20, 25, 50, 100, 200, 500, 1000];

function defaultSheet(storeys: BubbleGraphNode[]): SheetDef {
  return {
    paperId: 'A2',
    paperW: 594,
    paperH: 420,
    orientation: 'landscape',
    marginTop: 10,
    marginRight: 10,
    marginBottom: 25,
    marginLeft: 20,
    viewports: [],
    titleBlock: {
      show: true,
      projectName: 'BubbleGraph Project',
      sheetNumber: 'A1.01',
      drawDate: new Date().toISOString().slice(0, 10),
      drawnBy: '',
      scale: 'As shown',
    },
  };
}

function uid(): string {
  return `vp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// ─── Viewport Content (renders actual viewer component) ───────────────────────

interface ViewportContentProps {
  vp: SheetViewportDef;
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  matConfig: MaterialConfig | null;
  /** px size of the viewport frame on screen */
  pxW: number;
  pxH: number;
  /** When true, the viewer inside is interactive (pan/zoom). When false, an overlay captures pointer events for sheet drag. */
  isSelected: boolean;
}

function ViewportContent({ vp, nodes, edges, pxW, pxH, isSelected }: ViewportContentProps) {
  const buildingAxes = useBubbleGraphStore((s) => s.buildingAxes);

  return (
    <div style={{ width: pxW, height: pxH, overflow: 'hidden', position: 'relative', background: 'white' }}>
      {/* ── Floor Plan — full FloorPlan2DViewer (SVG-based, full fidelity) ── */}
      {vp.type === 'floorplan' && (
        <FloorPlan2DViewer
          key={`fp-${vp.storeyId}-${vp.discipline}-${vp.scale}`}
          nodes={nodes}
          edges={edges}
          buildingAxes={buildingAxes}
          storeyId={vp.storeyId}
          discipline={(vp.discipline ?? 'architectural') as StoreyDiscipline}
          className="w-full h-full"
          embedded={!isSelected}
        />
      )}

      {/* ── Section — Section2DViewer (SVG-based, scalable) ── */}
      {vp.type === 'section' && (
        <Section2DViewer
          key={`sec-${vp.cutY}-${vp.cutDepth}-${vp.startElevation}-${vp.endElevation}-${vp.flipped}-${vp.scale}`}
          nodes={nodes}
          edges={edges}
          cutY={vp.cutY}
          cutDepth={vp.cutDepth}
          startElevation={vp.startElevation}
          endElevation={vp.endElevation}
          sectionNodeId={vp.sectionNodeId}
          className="w-full h-full"
          embedded={!isSelected}
        />
      )}

      {/* ── Elevation — SVG Elevation2DViewer ── */}
      {vp.type === 'elevation' && (
        <Elevation2DViewer
          key={`elev-${vp.viewDirection}-${vp.startElevation}-${vp.endElevation}-${vp.scale}`}
          nodes={nodes}
          edges={edges}
          viewDirection={vp.viewDirection}
          startElevation={vp.startElevation}
          endElevation={vp.endElevation}
          className="w-full h-full"
          embedded={!isSelected}
        />
      )}

      {/* Interaction blocker: when the viewport is NOT selected for content-editing,
          pointer events go to the sheet layer (drag/resize the frame). */}
      {!isSelected && (
        <div
          style={{
            position: 'absolute', inset: 0,
            cursor: 'move',
          }}
        />
      )}

      {/* When selected and content is unlocked: show a small badge */}
      {isSelected && (
        <div
          style={{
            position: 'absolute', top: 4, left: 4, zIndex: 10,
            fontSize: 9, padding: '1px 5px', borderRadius: 3,
            background: 'rgba(59,130,246,0.85)', color: 'white',
            pointerEvents: 'none', userSelect: 'none',
          }}
        >
          ✎ pan/zoom active
        </div>
      )}
    </div>
  );
}

// ─── Add Viewport Panel ────────────────────────────────────────────────────────

// Discipline display helpers (mirrors Storey Explorer)
const DISC_LABEL: Record<StoreyDiscipline, string> = {
  architectural: 'A',
  structural: 'S',
  mep: 'M',
};
const DISC_COLOR: Record<StoreyDiscipline, string> = {
  architectural: '#60a5fa',  // blue-400
  structural:    '#f97316',  // orange-400
  mep:           '#4ade80',  // green-400
};

interface AddViewportPanelProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  viewTabs: ViewTab[];
  paperW: number;
  paperH: number;
  onAdd: (vp: SheetViewportDef) => void;
  onClose: () => void;
}

function AddViewportPanel({ nodes, edges, viewTabs, paperW, paperH, onAdd, onClose }: AddViewportPanelProps) {
  const storeys = nodes.filter((n) => n.type === 'storey');
  const [type, setType] = useState<'floorplan' | 'section' | 'elevation'>('floorplan');
  // floorplan selection: { storeyId, discipline }
  const [fpStoreyId, setFpStoreyId] = useState(storeys[0]?.id ?? '');
  const [fpDisc, setFpDisc] = useState<StoreyDiscipline>('architectural');
  // section/elevation selection: tab id (from existing tabs) or 'custom'
  const [selectedTabId, setSelectedTabId] = useState<string>('');
  const [scale, setScale] = useState(100);

  const sectionTabs = viewTabs.filter((t) => t.type === 'section');
  const elevationTabs = viewTabs.filter((t) => t.type === 'elevation');

  // Auto-select first available section/elevation tab when switching type
  const handleTypeChange = (t: 'floorplan' | 'section' | 'elevation') => {
    setType(t);
    if (t === 'section') setSelectedTabId(sectionTabs[0]?.id ?? '');
    if (t === 'elevation') setSelectedTabId(elevationTabs[0]?.id ?? '');
  };

  const handleAdd = () => {
    const frameW = Math.min(paperW * 0.7, 200);
    const frameH = Math.min(paperH * 0.7, 150);

    if (type === 'floorplan') {
      const sn = nodes.find((n) => n.id === fpStoreyId);
      let cropCX = 0; let cropCY = 0;
      if (sn) {
        const axX = parseAxes(sn.properties.axesX).sort((a, b) => a - b);
        const axY = parseAxes(sn.properties.axesY).sort((a, b) => a - b);
        cropCX = axX.length ? (axX[0] + axX[axX.length - 1]) / 2 : 0;
        cropCY = axY.length ? (axY[0] + axY[axY.length - 1]) / 2 : 0;
      }
      const discSuffix = fpDisc !== 'architectural' ? ` (${fpDisc})` : '';
      onAdd({
        id: uid(), type: 'floorplan',
        storeyId: fpStoreyId, discipline: fpDisc,
        label: `Plan — ${sn?.name ?? fpStoreyId}${discSuffix}`,
        x: 20, y: 20, frameW, frameH, scale, cropCX, cropCY,
        showBorder: true, showLabel: true, showScaleText: true,
      });
    } else if (type === 'section') {
      const tab = viewTabs.find((t) => t.id === selectedTabId);
      const cutY = Number(tab?.params?.cutY ?? 0);
      const cutDepth = Number(tab?.params?.cutDepth ?? 6000);
      const startElevation = Number(tab?.params?.startElevation ?? 0);
      const endElevation = Number(tab?.params?.endElevation ?? 3000);
      const flipped = tab?.params?.flipped === true;
      const sectionNodeId = tab?.params?.nodeId as string | undefined;
      onAdd({
        id: uid(), type: 'section',
        storeyId: tab?.storeyId,
        cutY, cutDepth, startElevation, endElevation, flipped, sectionNodeId,
        label: tab?.label ?? 'Section',
        x: 20, y: 20, frameW, frameH, scale,
        cropCX: 0, cropCY: (startElevation + endElevation) / 2,
        showBorder: true, showLabel: true, showScaleText: true,
      });
    } else {
      const tab = viewTabs.find((t) => t.id === selectedTabId);
      const dir = (tab?.params?.viewDirection as 'N' | 'S' | 'E' | 'W') ?? 'N';
      const startElevation = tab?.params?.startElevation != null ? Number(tab.params.startElevation) : undefined;
      const endElevation = tab?.params?.endElevation != null ? Number(tab.params.endElevation) : undefined;
      const sectionNodeId = tab?.params?.nodeId as string | undefined;
      onAdd({
        id: uid(), type: 'elevation',
        viewDirection: dir, startElevation, endElevation, sectionNodeId,
        label: tab?.label ?? `Elevation ${dir}`,
        x: 20, y: 20, frameW, frameH, scale,
        cropCX: 0, cropCY: 1500,
        showBorder: true, showLabel: true, showScaleText: true,
      });
    }
    onClose();
  };

  const LBL = 'text-[11px] text-zinc-400 mb-1 block';
  const SEL = 'w-full rounded bg-zinc-700 border border-zinc-600 text-zinc-100 px-2 py-1 text-xs';

  return (
    <div className="bg-zinc-800 border border-zinc-600 rounded-lg p-4 space-y-3 w-72 shadow-xl">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-200">Add Viewport</span>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-sm">✕</button>
      </div>

      {/* Tab type selector */}
      <div className="flex rounded overflow-hidden border border-zinc-600 text-[11px]">
        {(['floorplan', 'section', 'elevation'] as const).map((t) => (
          <button key={t}
            className={cn('flex-1 py-1 capitalize transition-colors',
              type === t ? 'bg-blue-600 text-white' : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600')}
            onClick={() => handleTypeChange(t)}>
            {t === 'floorplan' ? 'Floor Plan' : t === 'section' ? 'Section' : 'Elevation'}
          </button>
        ))}
      </div>

      {/* ── Floor plan: grouped storey → discipline list (mirrors Storey Explorer) ── */}
      {type === 'floorplan' && (
        <div>
          <div className={LBL}>Select floor plan view</div>
          <div className="border border-zinc-600 rounded overflow-hidden max-h-56 overflow-y-auto">
            {storeys.length === 0
              ? <div className="px-3 py-4 text-[10px] text-zinc-500 italic text-center">No storeys in project.</div>
              : storeys.map((s) => (
                <div key={s.id}>
                  {/* Storey header */}
                  <div className="px-2 py-1 text-[10px] text-zinc-400 font-semibold bg-zinc-900/60 border-b border-zinc-700">
                    {s.name || s.id}
                  </div>
                  {/* Discipline rows */}
                  {(['architectural', 'structural', 'mep'] as StoreyDiscipline[]).map((disc) => {
                    const hasTab = viewTabs.some(
                      (t) => t.type === 'floorplan' && t.storeyId === s.id && t.discipline === disc
                    );
                    const isActive = fpStoreyId === s.id && fpDisc === disc;
                    return (
                      <button
                        key={disc}
                        className={cn(
                          'flex items-center gap-2 w-full px-3 py-1.5 text-left text-[11px] transition-colors',
                          isActive
                            ? 'bg-blue-600/30 text-blue-200'
                            : 'text-zinc-300 hover:bg-zinc-700'
                        )}
                        onClick={() => { setFpStoreyId(s.id); setFpDisc(disc); }}
                      >
                        <span
                          className="text-[9px] font-bold w-4 text-center"
                          style={{ color: DISC_COLOR[disc] }}
                        >
                          {DISC_LABEL[disc]}
                        </span>
                        <span className="capitalize">{disc}</span>
                        {hasTab && (
                          <span className="ml-auto text-[9px]" style={{ color: DISC_COLOR[disc] }}>●</span>
                        )}
                        {isActive && (
                          <span className="ml-auto text-blue-400 text-[10px]">✓</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            }
          </div>
        </div>
      )}

      {/* ── Section: list of existing section tabs ── */}
      {type === 'section' && (
        <div>
          <div className={LBL}>Select section</div>
          {sectionTabs.length === 0
            ? <div className="text-[10px] text-zinc-500 italic px-1">No section tabs open. Open a section in the Storey Explorer first.</div>
            : (
              <div className="border border-zinc-600 rounded overflow-hidden max-h-48 overflow-y-auto">
                {sectionTabs.map((tab) => (
                  <button key={tab.id}
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-1.5 text-left text-[11px] transition-colors',
                      selectedTabId === tab.id
                        ? 'bg-blue-600/30 text-blue-200'
                        : 'text-zinc-300 hover:bg-zinc-700'
                    )}
                    onClick={() => setSelectedTabId(tab.id)}
                  >
                    <span className="text-[9px] text-red-400">✂</span>
                    <span className="flex-1 truncate">{tab.label}</span>
                    {selectedTabId === tab.id && <span className="text-blue-400 text-[10px]">✓</span>}
                  </button>
                ))}
              </div>
            )
          }
        </div>
      )}

      {/* ── Elevation: list of existing elevation tabs ── */}
      {type === 'elevation' && (
        <div>
          <div className={LBL}>Select elevation</div>
          {elevationTabs.length === 0
            ? <div className="text-[10px] text-zinc-500 italic px-1">No elevation tabs open. Use "Generate 4 Facades" in the Storey Explorer first.</div>
            : (
              <div className="border border-zinc-600 rounded overflow-hidden max-h-48 overflow-y-auto">
                {elevationTabs.map((tab) => (
                  <button key={tab.id}
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-1.5 text-left text-[11px] transition-colors',
                      selectedTabId === tab.id
                        ? 'bg-blue-600/30 text-blue-200'
                        : 'text-zinc-300 hover:bg-zinc-700'
                    )}
                    onClick={() => setSelectedTabId(tab.id)}
                  >
                    <span className="text-[9px] text-orange-400">↑</span>
                    <span className="flex-1 truncate">{tab.label}</span>
                    {selectedTabId === tab.id && <span className="text-blue-400 text-[10px]">✓</span>}
                  </button>
                ))}
              </div>
            )
          }
        </div>
      )}

      {/* Scale */}
      <div>
        <label className={LBL}>Scale (1 : N)</label>
        <select className={SEL} value={scale} onChange={(e) => setScale(Number(e.target.value))}>
          {SCALE_PRESETS.map((s) => (
            <option key={s} value={s}>1 : {s}</option>
          ))}
        </select>
      </div>

      <button
        onClick={handleAdd}
        disabled={
          (type === 'section' && sectionTabs.length === 0) ||
          (type === 'elevation' && elevationTabs.length === 0) ||
          (type === 'floorplan' && storeys.length === 0)
        }
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs py-1.5 rounded font-medium"
      >
        + Add Viewport
      </button>
    </div>
  );
}

// ─── Sheet Canvas SVG export ──────────────────────────────────────────────────

/** XML-escape a title-block or label string. */
const esc = (v: string) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Write the sheet out as SVG, taking each viewport's drawing from the viewer
 * that is rendering it on screen.
 *
 * The frame is in paper millimetres and the viewer draws in model
 * millimetres, so each viewport is a nested `<svg>` whose viewBox is the
 * viewer's own: the nesting does the scaling, and the drawing lands at
 * exactly the size the frame allows — the same fit the screen shows.
 */
function buildSheetSvg(sheet: SheetDef, host: HTMLElement | null): string {
  const W = sheet.paperW; const H = sheet.paperH;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="white" stroke="#333" stroke-width="0.5"/>`);

  // Margins
  const { marginLeft: ml, marginTop: mt, marginRight: mr, marginBottom: mb } = sheet;
  parts.push(`<rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${H - mt - mb}" fill="none" stroke="#999" stroke-width="0.25"/>`);

  // Viewports
  sheet.viewports.forEach((vp, i) => {
    parts.push(`<g transform="translate(${vp.x}, ${vp.y})">`);
    if (vp.showBorder) {
      parts.push(`<rect width="${vp.frameW}" height="${vp.frameH}" fill="white" stroke="#444" stroke-width="0.35"/>`);
    }

    const svg = host?.querySelector<SVGSVGElement>(`[data-viewport-id="${vp.id}"] svg`) ?? null;
    if (svg) {
      const vb = svg.viewBox.baseVal;
      parts.push(
        `<svg x="0" y="0" width="${vp.frameW}" height="${vp.frameH}"`
        + ` viewBox="${vb.x} ${vb.y} ${vb.width} ${vb.height}"`
        + ` preserveAspectRatio="xMidYMid meet" overflow="hidden">`,
      );
      parts.push(viewportContent(svg, `v${i}-`));
      parts.push(`</svg>`);
    }

    if (vp.showLabel) {
      parts.push(`<text x="${vp.frameW / 2}" y="${vp.frameH + 5}" text-anchor="middle" font-size="3.5" font-family="sans-serif" fill="#333">${esc(vp.label)}</text>`);
    }
    if (vp.showScaleText) {
      parts.push(`<text x="${vp.frameW / 2}" y="${vp.frameH + 9}" text-anchor="middle" font-size="3" font-family="sans-serif" fill="#666">1 : ${vp.scale}</text>`);
    }
    parts.push(`</g>`);
  });

  // Title block
  if (sheet.titleBlock.show) {
    const tb = sheet.titleBlock;
    const tbX = ml; const tbY = H - mb + 1; const tbW = W - ml - mr;
    parts.push(`<rect x="${tbX}" y="${tbY}" width="${tbW}" height="${mb - 2}" fill="#f5f5f5" stroke="#555" stroke-width="0.3"/>`);
    parts.push(`<text x="${tbX + 4}" y="${tbY + 5}" font-size="5" font-family="sans-serif" font-weight="bold" fill="#222">${esc(tb.projectName)}</text>`);
    parts.push(`<text x="${tbX + 4}" y="${tbY + 10}" font-size="3.5" font-family="sans-serif" fill="#444">Sheet: ${esc(tb.sheetNumber)}   Date: ${esc(tb.drawDate)}   By: ${esc(tb.drawnBy)}   Scale: ${esc(tb.scale)}</text>`);
  }

  parts.push(`</svg>`);
  return parts.join('\n');
}

function exportSheetSvg(sheet: SheetDef, host: HTMLElement | null): void {
  downloadText(safeFilename(sheet.titleBlock.sheetNumber || 'plansa', 'svg'),
    buildSheetSvg(sheet, host), 'image/svg+xml');
}

/**
 * Print the sheet — which is also how it becomes a PDF, through the browser's
 * own "Save as PDF".
 *
 * The sheet is written into a hidden iframe rather than a new window: a popup
 * is blocked often enough that an export would silently do nothing, and an
 * iframe never is. `@page` carries the real paper size, so the PDF comes out
 * at true scale rather than fitted to whatever A4 the printer defaults to.
 */
function printSheet(sheet: SheetDef, host: HTMLElement | null): void {
  const svg = buildSheetSvg(sheet, host);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) { frame.remove(); return; }
  doc.open();
  doc.write(
    '<!doctype html><html><head><meta charset="utf-8"><title>'
    + `${sheet.titleBlock.sheetNumber || 'Planșă'}</title><style>`
    + `@page { size: ${sheet.paperW}mm ${sheet.paperH}mm; margin: 0 }`
    + 'html,body{margin:0;padding:0;background:#fff}svg{display:block}'
    + `</style></head><body>${svg}</body></html>`,
  );
  doc.close();
  // document.write can finish after load has already fired, so the print is
  // asked for on the next frame rather than from an onload that never comes.
  requestAnimationFrame(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  });
}

// ─── Main Component ────────────────────────────────────────────────────────────

interface SheetComposerProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  tab: ViewTab;
  className?: string;
}

export function SheetComposer({ nodes, edges, tab, className }: SheetComposerProps) {
  const { updateViewTabParams, viewTabs } = useBubbleGraphStore();
  const { config: matConfig } = useMaterialConfig();
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Sheet state (serialized into tab.params.sheet) ─────────────────────────
  const storeys = useMemo(() => nodes.filter((n) => n.type === 'storey'), [nodes]);

  const [sheet, setSheetRaw] = useState<SheetDef>(() => {
    const saved = tab.params?.sheet as SheetDef | undefined;
    return saved ?? defaultSheet(storeys);
  });

  const setSheet = useCallback((updater: (prev: SheetDef) => SheetDef) => {
    setSheetRaw((prev) => {
      const next = updater(prev);
      updateViewTabParams(tab.id, { sheet: next });
      return next;
    });
  }, [tab.id, updateViewTabParams]);

  // ── Canvas zoom / pan ──────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1); // px per mm
  const [panX, setPanX] = useState(40); // canvas offset px
  const [panY, setPanY] = useState(40);

  // Fit paper to container on mount / when paper changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const W = el.clientWidth - 80; const H = el.clientHeight - 80;
    const z = Math.min(W / sheet.paperW, H / sheet.paperH, 3);
    setZoom(Math.max(0.3, z));
    setPanX(40); setPanY(40);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.paperId, sheet.orientation]);

  const pxPerMm = zoom; // alias

  // Canvas pan on middle-drag or space+drag
  const isPanning = useRef(false);
  const panStart  = useRef({ x: 0, y: 0, px: 0, py: 0 });

  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || e.altKey) {
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY, px: panX, py: panY };
      e.preventDefault();
    }
  }, [panX, panY]);

  const onCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    setPanX(panStart.current.px + e.clientX - panStart.current.x);
    setPanY(panStart.current.py + e.clientY - panStart.current.y);
  }, []);

  const onCanvasMouseUp = useCallback(() => { isPanning.current = false; }, []);

  const onCanvasWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.3, Math.min(6, z * (e.deltaY > 0 ? 0.9 : 1.1))));
  }, []);

  // ── Viewport drag-to-move ──────────────────────────────────────────────────
  const [selectedVpId, setSelectedVpId] = useState<string | null>(null);
  const dragging = useRef<{ vpId: string; ox: number; oy: number } | null>(null);
  const resizing = useRef<{ vpId: string; ox: number; oy: number; fw: number; fh: number } | null>(null);

  const onViewportPointerDown = useCallback((e: React.PointerEvent, vpId: string) => {
    e.stopPropagation();
    setSelectedVpId(vpId);
    const vp = sheet.viewports.find((v) => v.id === vpId);
    if (!vp) return;
    dragging.current = { vpId, ox: e.clientX - vp.x * pxPerMm, oy: e.clientY - vp.y * pxPerMm };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [sheet.viewports, pxPerMm]);

  const onResizePointerDown = useCallback((e: React.PointerEvent, vpId: string) => {
    e.stopPropagation();
    const vp = sheet.viewports.find((v) => v.id === vpId);
    if (!vp) return;
    resizing.current = { vpId, ox: e.clientX, oy: e.clientY, fw: vp.frameW, fh: vp.frameH };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [sheet.viewports]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragging.current) {
      const { vpId, ox, oy } = dragging.current;
      const newX = (e.clientX - ox) / pxPerMm;
      const newY = (e.clientY - oy) / pxPerMm;
      setSheet((s) => ({
        ...s,
        viewports: s.viewports.map((v) =>
          v.id === vpId ? { ...v, x: Math.max(0, Math.min(s.paperW - v.frameW, newX)), y: Math.max(0, Math.min(s.paperH - v.frameH, newY)) } : v,
        ),
      }));
    }
    if (resizing.current) {
      const { vpId, ox, oy, fw, fh } = resizing.current;
      const dxMm = (e.clientX - ox) / pxPerMm;
      const dyMm = (e.clientY - oy) / pxPerMm;
      setSheet((s) => ({
        ...s,
        viewports: s.viewports.map((v) =>
          v.id === vpId ? { ...v, frameW: Math.max(20, fw + dxMm), frameH: Math.max(15, fh + dyMm) } : v,
        ),
      }));
    }
  }, [pxPerMm, setSheet]);

  const onPointerUp = useCallback(() => {
    dragging.current = null;
    resizing.current = null;
  }, []);

  // ── UI state ────────────────────────────────────────────────────────────────
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [showTitleBlock, setShowTitleBlock] = useState(false);

  const selectedVp = sheet.viewports.find((v) => v.id === selectedVpId);

  // Update paper size
  const applyPaper = (id: string) => {
    const sz = PAPER_SIZES[id];
    if (!sz) return;
    const isLandscape = sheet.orientation === 'landscape';
    const W = isLandscape ? Math.max(sz.w, sz.h) : Math.min(sz.w, sz.h);
    const H = isLandscape ? Math.min(sz.w, sz.h) : Math.max(sz.w, sz.h);
    setSheet((s) => ({ ...s, paperId: id, paperW: W, paperH: H }));
  };

  const toggleOrientation = () => {
    setSheet((s) => ({
      ...s,
      orientation: s.orientation === 'landscape' ? 'portrait' : 'landscape',
      paperW: s.paperH,
      paperH: s.paperW,
    }));
  };

  // Update viewport field
  const updateVp = useCallback((id: string, patch: Partial<SheetViewportDef>) => {
    setSheet((s) => ({
      ...s,
      viewports: s.viewports.map((v) => v.id === id ? { ...v, ...patch } : v),
    }));
  }, [setSheet]);

  const deleteVp = useCallback((id: string) => {
    setSheet((s) => ({ ...s, viewports: s.viewports.filter((v) => v.id !== id) }));
    if (selectedVpId === id) setSelectedVpId(null);
  }, [setSheet, selectedVpId]);

  const duplicateVp = useCallback((id: string) => {
    const vp = sheet.viewports.find((v) => v.id === id);
    if (!vp) return;
    setSheet((s) => ({
      ...s,
      viewports: [...s.viewports, { ...vp, id: uid(), x: vp.x + 10, y: vp.y + 10, label: vp.label + ' (copy)' }],
    }));
  }, [sheet.viewports, setSheet]);

  // ── Sidebar styles ─────────────────────────────────────────────────────────
  const LBL = 'text-[10px] text-zinc-400 leading-tight';
  const SEL = 'w-full rounded bg-zinc-700 border border-zinc-600 text-zinc-100 px-1.5 py-0.5 text-[11px]';
  const INP = 'w-full rounded bg-zinc-700 border border-zinc-600 text-zinc-100 px-1.5 py-0.5 text-[11px]';
  const NUM = 'w-full rounded bg-zinc-700 border border-zinc-600 text-zinc-100 px-1.5 py-0.5 text-[11px]';
  const SECTION_HEAD = 'text-[10px] uppercase tracking-widest text-zinc-500 font-semibold px-3 py-2 border-b border-zinc-700/60';

  return (
    <div className={cn('flex w-full h-full overflow-hidden bg-zinc-900 text-zinc-100', className)}>

      {/* ── Left sidebar ─────────────────────────────────────────────────── */}
      <aside className="w-52 flex-shrink-0 border-r border-zinc-700 flex flex-col overflow-hidden">

        {/* Paper size */}
        <div className={SECTION_HEAD}>📄 Paper</div>
        <div className="px-3 py-2 space-y-2 border-b border-zinc-700/60">
          <div>
            <div className={LBL}>Size</div>
            <select
              className={SEL}
              value={sheet.paperId}
              onChange={(e) => applyPaper(e.target.value)}
            >
              {Object.entries(PAPER_SIZES).map(([id, { label }]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>
          {sheet.paperId === 'custom' && (
            <div className="flex gap-1.5">
              <div className="flex-1">
                <div className={LBL}>W (mm)</div>
                <input type="number" className={NUM} value={sheet.paperW}
                  onChange={(e) => setSheet((s) => ({ ...s, paperW: Number(e.target.value) }))} />
              </div>
              <div className="flex-1">
                <div className={LBL}>H (mm)</div>
                <input type="number" className={NUM} value={sheet.paperH}
                  onChange={(e) => setSheet((s) => ({ ...s, paperH: Number(e.target.value) }))} />
              </div>
            </div>
          )}
          <button
            onClick={toggleOrientation}
            className="w-full text-[11px] py-0.5 rounded border border-zinc-600 hover:bg-zinc-700 text-zinc-300"
          >
            {sheet.orientation === 'landscape' ? '⟵ Landscape' : '↑ Portrait'}
          </button>
        </div>

        {/* Margins */}
        <div className="px-3 py-2 space-y-1 border-b border-zinc-700/60">
          <div className={LBL}>Margins (mm)</div>
          <div className="grid grid-cols-2 gap-1">
            {(['marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const).map((key) => (
              <div key={key}>
                <div className="text-[9px] text-zinc-500">{key.replace('margin', '')}</div>
                <input type="number" className={NUM} value={sheet[key]}
                  onChange={(e) => setSheet((s) => ({ ...s, [key]: Number(e.target.value) }))} />
              </div>
            ))}
          </div>
        </div>

        {/* Title block toggle */}
        <div className="px-3 py-2 border-b border-zinc-700/60">
          <button
            onClick={() => setShowTitleBlock((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-zinc-300 hover:text-white"
          >
            <span>{showTitleBlock ? '▾' : '▸'}</span>
            <span>Title Block</span>
            <input
              type="checkbox"
              className="ml-auto"
              checked={sheet.titleBlock.show}
              onChange={(e) => setSheet((s) => ({ ...s, titleBlock: { ...s.titleBlock, show: e.target.checked } }))}
              onClick={(e) => e.stopPropagation()}
            />
          </button>
          {showTitleBlock && (
            <div className="mt-2 space-y-1.5">
              {([
                ['projectName', 'Project name'],
                ['sheetNumber', 'Sheet No.'],
                ['drawDate',    'Date'],
                ['drawnBy',     'Drawn by'],
                ['scale',       'Scale'],
              ] as const).map(([key, lbl]) => (
                <div key={key}>
                  <div className={LBL}>{lbl}</div>
                  <input className={INP} value={sheet.titleBlock[key]}
                    onChange={(e) => setSheet((s) => ({ ...s, titleBlock: { ...s.titleBlock, [key]: e.target.value } }))} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Viewports list */}
        <div className={SECTION_HEAD}>🗂 Viewports</div>
        <div className="flex-1 overflow-y-auto">
          {sheet.viewports.length === 0 && (
            <div className="px-3 py-4 text-center text-[11px] text-zinc-500">No viewports yet.</div>
          )}
          {sheet.viewports.map((vp) => (
            <button
              key={vp.id}
              onClick={() => setSelectedVpId(vp.id === selectedVpId ? null : vp.id)}
              className={cn(
                'w-full text-left px-3 py-1.5 text-[11px] flex items-center gap-2 border-b border-zinc-800 hover:bg-zinc-700/50',
                vp.id === selectedVpId && 'bg-zinc-700',
              )}
            >
              <span className="text-[10px] text-zinc-500 shrink-0">
                {vp.type === 'floorplan' ? '📐' : vp.type === 'section' ? '✂️' : '↑'}
              </span>
              <span className="flex-1 truncate text-zinc-200">{vp.label}</span>
              <span className="text-[9px] text-zinc-500">1:{vp.scale}</span>
            </button>
          ))}
        </div>

        {/* Add viewport + Export buttons */}
        <div className="p-2 border-t border-zinc-700 space-y-1.5 relative">
          {showAddPanel && (
            <div className="absolute bottom-full left-0 mb-2 z-50">
              <AddViewportPanel
                nodes={nodes}
                edges={edges}
                viewTabs={viewTabs}
                paperW={sheet.paperW}
                paperH={sheet.paperH}
                onAdd={(vp) => setSheet((s) => ({ ...s, viewports: [...s.viewports, vp] }))}
                onClose={() => setShowAddPanel(false)}
              />
            </div>
          )}
          <button
            onClick={() => setShowAddPanel((v) => !v)}
            className="w-full bg-blue-700 hover:bg-blue-600 text-white text-[11px] py-1 rounded font-medium"
          >
            + Add Viewport
          </button>
          <button
            onClick={() => exportSheetSvg(sheet, containerRef.current)}
            className="w-full bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-[11px] py-1 rounded"
          >
            ↓ Export SVG
          </button>
          <button
            onClick={() => printSheet(sheet, containerRef.current)}
            title="Tipărește la dimensiunea reală a colii — sau salvează ca PDF din dialogul de tipărire"
            className="w-full bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-[11px] py-1 rounded"
          >
            🖨 Print / PDF
          </button>
        </div>
      </aside>

      {/* ── Main canvas ──────────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative bg-zinc-950 cursor-default"
        onMouseDown={onCanvasMouseDown}
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onWheel={onCanvasWheel}
        onClick={() => setSelectedVpId(null)}
      >
        {/* Zoom indicator */}
        <div className="absolute top-2 left-2 z-10 text-[10px] text-zinc-500 bg-zinc-900/70 px-2 py-0.5 rounded select-none pointer-events-none">
          {Math.round(zoom * 100)}% — Alt+drag to pan · Scroll to zoom
        </div>

        {/* Paper rectangle */}
        <div
          style={{
            position: 'absolute',
            left: panX,
            top: panY,
            width: sheet.paperW * pxPerMm,
            height: sheet.paperH * pxPerMm,
            background: 'white',
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {/* Margin outline */}
          <div
            style={{
              position: 'absolute',
              left: sheet.marginLeft * pxPerMm,
              top: sheet.marginTop * pxPerMm,
              width: (sheet.paperW - sheet.marginLeft - sheet.marginRight) * pxPerMm,
              height: (sheet.paperH - sheet.marginTop - sheet.marginBottom) * pxPerMm,
              border: '1px solid #aaa',
              pointerEvents: 'none',
            }}
          />

          {/* Title block strip */}
          {sheet.titleBlock.show && (
            <div
              style={{
                position: 'absolute',
                left: sheet.marginLeft * pxPerMm,
                bottom: 0,
                width: (sheet.paperW - sheet.marginLeft - sheet.marginRight) * pxPerMm,
                height: sheet.marginBottom * pxPerMm,
                borderTop: '1px solid #888',
                background: '#f8f8f6',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                paddingLeft: 8,
                pointerEvents: 'none',
              }}
            >
              <div style={{ fontSize: Math.max(7, pxPerMm * 4.5), fontWeight: 600, color: '#222', lineHeight: 1.1 }}>
                {sheet.titleBlock.projectName}
              </div>
              <div style={{ fontSize: Math.max(5, pxPerMm * 3), color: '#555', lineHeight: 1.2 }}>
                Sheet {sheet.titleBlock.sheetNumber} · {sheet.titleBlock.drawDate}
                {sheet.titleBlock.drawnBy ? ` · ${sheet.titleBlock.drawnBy}` : ''}
                {sheet.titleBlock.scale ? ` · ${sheet.titleBlock.scale}` : ''}
              </div>
            </div>
          )}

          {/* Viewports */}
          {sheet.viewports.map((vp) => {
            const isSelected = vp.id === selectedVpId;
            const pxW = vp.frameW * pxPerMm;
            const pxH = vp.frameH * pxPerMm;
            return (
              <div
                key={vp.id}
                style={{
                  position: 'absolute',
                  left: vp.x * pxPerMm,
                  top: vp.y * pxPerMm,
                  width: pxW,
                  // When selected, content is interactive — use default cursor inside content area
                  cursor: isSelected ? 'default' : 'move',
                }}
                onPointerDown={(e) => {
                  // If viewport is selected and click came from inside the content (not the label/resize handle),
                  // don't start a drag — let the viewer handle it.
                  if (isSelected) {
                    // Only drag from the label area below the frame (y > pxH)
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const localY = e.clientY - rect.top;
                    if (localY <= pxH) return; // inside content frame — let viewer handle it
                  }
                  onViewportPointerDown(e, vp.id);
                }}
                onClick={(e) => { e.stopPropagation(); setSelectedVpId(vp.id); }}
              >
                {/* Viewport content. Tagged so the SVG export can take the
                    drawing from the viewer that rendered it, rather than
                    redrawing it from a second, poorer generator. */}
                <div
                  data-viewport-id={vp.id}
                  style={{
                    width: pxW,
                    height: pxH,
                    overflow: 'hidden',
                    outline: isSelected ? '2px solid #3b82f6' : vp.showBorder ? '1px solid #777' : '1px dashed #ccc',
                    background: 'white',
                  }}
                >
                  <ViewportContent
                    vp={vp}
                    nodes={nodes}
                    edges={edges}
                    matConfig={matConfig}
                    pxW={pxW}
                    pxH={pxH}
                    isSelected={isSelected}
                  />
                </div>

                {/* Label below viewport */}
                {vp.showLabel && (
                  <div style={{
                    fontSize: Math.max(8, pxPerMm * 3),
                    textAlign: 'center',
                    color: '#333',
                    lineHeight: 1.2,
                    userSelect: 'none',
                  }}>
                    {vp.label}
                  </div>
                )}
                {vp.showScaleText && (
                  <div style={{ fontSize: Math.max(7, pxPerMm * 2.5), textAlign: 'center', color: '#666', userSelect: 'none' }}>
                    1 : {vp.scale}
                  </div>
                )}

                {/* Resize handle (bottom-right corner) */}
                {isSelected && (
                  <div
                    style={{
                      position: 'absolute',
                      right: -5,
                      bottom: -(vp.showLabel ? pxPerMm * 6 : 0) - 5,
                      width: 10,
                      height: 10,
                      background: '#3b82f6',
                      borderRadius: 2,
                      cursor: 'se-resize',
                    }}
                    onPointerDown={(e) => { e.stopPropagation(); onResizePointerDown(e, vp.id); }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Right Properties Panel ────────────────────────────────────────── */}
      {selectedVp && (
        <aside className="w-52 flex-shrink-0 border-l border-zinc-700 flex flex-col overflow-y-auto text-[11px]">
          <div className={SECTION_HEAD}>⚙ Viewport properties</div>
          <div className="px-3 py-2 space-y-2">

            {/* Label */}
            <div>
              <div className={LBL}>Label</div>
              <input className={INP} value={selectedVp.label}
                onChange={(e) => updateVp(selectedVp.id, { label: e.target.value })} />
            </div>

            {/* Scale */}
            <div>
              <div className={LBL}>Scale (1 : N)</div>
              <div className="flex gap-1">
                <select className={SEL} value={selectedVp.scale}
                  onChange={(e) => updateVp(selectedVp.id, { scale: Number(e.target.value) })}>
                  {SCALE_PRESETS.map((s) => (
                    <option key={s} value={s}>1 : {s}</option>
                  ))}
                </select>
                <input type="number" className="w-16 rounded bg-zinc-700 border border-zinc-600 text-zinc-100 px-1.5 py-0.5 text-[11px]"
                  value={selectedVp.scale}
                  onChange={(e) => updateVp(selectedVp.id, { scale: Math.max(1, Number(e.target.value)) })} />
              </div>
            </div>

            {/* Position */}
            <div className="flex gap-1.5">
              <div className="flex-1">
                <div className={LBL}>X (mm)</div>
                <input type="number" className={NUM} value={Math.round(selectedVp.x * 10) / 10}
                  onChange={(e) => updateVp(selectedVp.id, { x: Number(e.target.value) })} />
              </div>
              <div className="flex-1">
                <div className={LBL}>Y (mm)</div>
                <input type="number" className={NUM} value={Math.round(selectedVp.y * 10) / 10}
                  onChange={(e) => updateVp(selectedVp.id, { y: Number(e.target.value) })} />
              </div>
            </div>

            {/* Frame size */}
            <div className="flex gap-1.5">
              <div className="flex-1">
                <div className={LBL}>W (mm)</div>
                <input type="number" className={NUM} value={Math.round(selectedVp.frameW * 10) / 10}
                  onChange={(e) => updateVp(selectedVp.id, { frameW: Math.max(20, Number(e.target.value)) })} />
              </div>
              <div className="flex-1">
                <div className={LBL}>H (mm)</div>
                <input type="number" className={NUM} value={Math.round(selectedVp.frameH * 10) / 10}
                  onChange={(e) => updateVp(selectedVp.id, { frameH: Math.max(15, Number(e.target.value)) })} />
              </div>
            </div>

            {/* Crop center (model space pan) */}
            <div className={LBL + ' mt-1'}>Crop center (model mm)</div>
            <div className="flex gap-1.5">
              <div className="flex-1">
                <div className={LBL}>Center X</div>
                <input type="number" className={NUM} value={Math.round(selectedVp.cropCX)}
                  onChange={(e) => updateVp(selectedVp.id, { cropCX: Number(e.target.value) })} />
              </div>
              <div className="flex-1">
                <div className={LBL}>{selectedVp.type === 'floorplan' ? 'Center Y' : 'Center Z'}</div>
                <input type="number" className={NUM} value={Math.round(selectedVp.cropCY)}
                  onChange={(e) => updateVp(selectedVp.id, { cropCY: Number(e.target.value) })} />
              </div>
            </div>

            {/* Cut Y for section */}
            {selectedVp.type === 'section' && (
              <div>
                <div className={LBL}>Cut Y (BIM mm)</div>
                <input type="number" className={NUM} value={selectedVp.cutY ?? 0}
                  onChange={(e) => updateVp(selectedVp.id, { cutY: Number(e.target.value) })} />
              </div>
            )}

            {/* View direction for elevation/section */}
            {(selectedVp.type === 'elevation' || selectedVp.type === 'section') && (
              <div>
                <div className={LBL}>View direction</div>
                <select className={SEL} value={selectedVp.viewDirection ?? 'N'}
                  onChange={(e) => updateVp(selectedVp.id, { viewDirection: e.target.value as any })}>
                  {(['N', 'S', 'E', 'W'] as const).map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Visual toggles */}
            <div className="space-y-1 pt-1 border-t border-zinc-700">
              {([
                ['showBorder',    'Show border'],
                ['showLabel',     'Show label'],
                ['showScaleText', 'Show scale text'],
              ] as [keyof SheetViewportDef, string][]).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={selectedVp[key] as boolean}
                    onChange={(e) => updateVp(selectedVp.id, { [key]: e.target.checked })} />
                  <span className={LBL}>{label}</span>
                </label>
              ))}
            </div>

            {/* Storey selector (floorplan/section) */}
            {(selectedVp.type === 'floorplan' || selectedVp.type === 'section') && storeys.length > 0 && (
              <div>
                <div className={LBL}>Storey</div>
                <select className={SEL} value={selectedVp.storeyId ?? ''}
                  onChange={(e) => updateVp(selectedVp.id, { storeyId: e.target.value })}>
                  {storeys.map((s) => (
                    <option key={s.id} value={s.id}>{s.name || s.id}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Discipline selector (floorplan only) */}
            {selectedVp.type === 'floorplan' && (
              <div>
                <div className={LBL}>Discipline</div>
                <select className={SEL} value={selectedVp.discipline ?? 'architectural'}
                  onChange={(e) => updateVp(selectedVp.id, { discipline: e.target.value as StoreyDiscipline })}>
                  <option value="architectural">Architectural</option>
                  <option value="structural">Structural</option>
                  <option value="mep">MEP</option>
                </select>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-1.5 pt-2 border-t border-zinc-700">
              <button
                onClick={() => duplicateVp(selectedVp.id)}
                className="flex-1 text-[10px] py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
              >
                Duplicate
              </button>
              <button
                onClick={() => deleteVp(selectedVp.id)}
                className="flex-1 text-[10px] py-1 rounded bg-red-900/60 hover:bg-red-800 text-red-300"
              >
                Delete
              </button>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
