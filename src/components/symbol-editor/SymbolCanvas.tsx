/**
 * SymbolCanvas.tsx — visual parametric SVG symbol editor.
 *
 * A mini graph-canvas where users place and connect nodes to define 2D
 * parametric symbols for windows, doors, etc. in floor-plan / section /
 * elevation views.
 *
 * Canvas coordinate space: mm in symbol space (0,0 = outer face, left jamb).
 * Display: auto-scaled to canvas pixel dimensions, with wall-context band shown.
 *
 * Node types:
 *   sp — anchor point  (blue circle)
 *   sl — line segment  (orange)
 *   sa — arc           (purple)
 *   st — text label    (green)
 *   sh — hatch/fill    (teal)
 *
 * Interactions:
 *   • Palette tool selected → click canvas → add node at cursor position
 *   • Click existing node → select it → edit props in side panel
 *   • Drag selected node → reposition it
 *   • Edge tool (sl/sh) → click source node, then click sp node(s) to connect
 *   • Del / Backspace → delete selected node + connected edges
 *   • "New symbol" / "Save" / "Delete" via toolbar buttons
 */

import React, {
  useState, useRef, useCallback, useEffect, useMemo,
} from 'react';
import { cn } from '@/lib/utils';
import {
  type SvgSymbolDef,
  type SvgSymNode,
  type SvgSymEdge,
  type SymNodeType,
  type SymRenderParams,
  type SpProps,
  type SlProps,
  type SaProps,
  type StProps,
  type ShProps,
  type HatchPatternType,
  symId,
  symbolKey,
  setSymbolDef,
  deleteSymbolDef,
  resolveSymbolDef,
  listSymbolDefs,
  subscribeSymbolLibrary,
  saveSymbolLibraryToStorage,
  renderSymbolSVGString,
  evalSymExpr,
  buildWindowSymRenderParams,
} from '@/lib/svgSymbolStore';

// ─── Palette config ───────────────────────────────────────────────────────────

const PALETTE_TOOLS: { type: SymNodeType; icon: string; label: string; color: string }[] = [
  { type: 'sp', icon: '•', label: 'Anchor point',  color: '#2563eb' },
  { type: 'sl', icon: '╱', label: 'Line',           color: '#ea580c' },
  { type: 'sa', icon: '⌒', label: 'Arc',            color: '#7c3aed' },
  { type: 'st', icon: 'T', label: 'Text',           color: '#16a34a' },
  { type: 'sh', icon: '▦', label: 'Hatch / fill',  color: '#0891b2' },
];

const NODE_COLORS: Record<SymNodeType, string> = {
  sp: '#2563eb',
  sl: '#ea580c',
  sa: '#7c3aed',
  st: '#16a34a',
  sh: '#0891b2',
};

const CANVAS_W = 440;
const CANVAS_H = 240;
const CANVAS_PAD = 24;
const PREVIEW_W = 360;
const PREVIEW_H = 200;

// ─── Helper: default props per node type ──────────────────────────────────────

function defaultProps(type: SymNodeType, cx: number, cy: number): Record<string, unknown> {
  switch (type) {
    case 'sp': return { x_mm: cx, y_mm: cy, name: '' } satisfies SpProps;
    case 'sl': return { stroke: '#111111', weight: 2, dash: false, linecap: 'square' } satisfies SlProps;
    case 'sa': return { cx_mm: cx, cy_mm: cy, r_mm: 100, a0: 180, a1: 0, stroke: '#111111', weight: 1.5 } satisfies SaProps;
    case 'st': return { x_mm: cx, y_mm: cy, content: 'Text', size_mm: 50, color: '#1a1a2e', anchor: 'middle', bold: false } satisfies StProps;
    case 'sh': return { fill_color: '#aabbcc', fill_opacity: 0.45, pattern: 'diagonal', stroke: '#555555', weight: 1 } satisfies ShProps;
  }
}

// ─── Empty symbol template ────────────────────────────────────────────────────

function emptySymbol(
  elementType: 'window' | 'door',
  typeKey: string,
  viewType: 'floorplan' | 'section' | 'elevation',
  name: string,
): SvgSymbolDef {
  return {
    id: symbolKey(elementType, typeKey, viewType),
    name,
    elementType,
    typeKey,
    viewType,
    nodes: [],
    edges: [],
    updatedAt: Date.now(),
  };
}

// ─── Canvas coordinate helpers ────────────────────────────────────────────────

interface CanvasScale {
  scale: number;
  ox: number;  // SVG origin = canvas pixel position of mm (0,0)
  oy: number;
  W: number;   // mm width
  TotalH: number; // mm height (total symbol depth)
}

function computeScale(params: SymRenderParams): CanvasScale {
  const { W, outer_off = 125, inner_off = 125, sill_proj = 200 } = params;
  const TotalH = outer_off + inner_off + sill_proj;
  const availW = CANVAS_W - CANVAS_PAD * 2;
  const availH = CANVAS_H - CANVAS_PAD * 2;
  const scale = Math.min(availW / W, availH / TotalH);
  const ox = (CANVAS_W - W * scale) / 2;
  const oy = CANVAS_PAD;
  return { scale, ox, oy, W, TotalH };
}

function mm2px(mm: { x: number; y: number }, cs: CanvasScale) {
  return { x: cs.ox + mm.x * cs.scale, y: cs.oy + mm.y * cs.scale };
}

function px2mm(px: { x: number; y: number }, cs: CanvasScale) {
  return { x: (px.x - cs.ox) / cs.scale, y: (px.y - cs.oy) / cs.scale };
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SymbolCanvasProps {
  /** Initial element type and view type */
  elementType: 'window' | 'door';
  /** Initial typeKey to edit (e.g. 'opening:single') */
  initialTypeKey?: string;
  viewType: 'floorplan' | 'section' | 'elevation';
  /** Render params for preview (W, T, outer_off, etc.) */
  params: SymRenderParams;
}

// ─── Property inspector sub-components ───────────────────────────────────────

function PropRow({
  label, children,
}: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-1 py-0.5">
      <span className="text-[11px] text-gray-500 w-24 shrink-0">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function ExprInput({
  value, onChange, placeholder,
}: { value: string | number; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="text"
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full text-[11px] border border-gray-200 rounded px-1.5 py-0.5 font-mono bg-white"
    />
  );
}

function ColorInput2({
  value, onChange,
}: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
        className="w-7 h-5 rounded border border-gray-200 cursor-pointer p-0 shrink-0" />
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)}
        className="w-16 text-[11px] border border-gray-200 rounded px-1 py-0.5 font-mono bg-white" />
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SymbolCanvas({
  elementType,
  initialTypeKey = 'opening:single',
  viewType,
  params,
}: SymbolCanvasProps) {
  // ── Library subscription ─────────────────────────────────────────────────
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSymbolLibrary(() => forceUpdate((n) => n + 1)), []);

  // ── Editor state ──────────────────────────────────────────────────────────
  const [typeKey, setTypeKey] = useState(initialTypeKey);
  const [viewTypeLocal, setViewTypeLocal] = useState<'floorplan' | 'section' | 'elevation'>(viewType);
  const [activeTool, setActiveTool] = useState<SymNodeType | 'select'>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingEdgeFrom, setPendingEdgeFrom] = useState<string | null>(null);

  // Working copy of the symbol being edited
  const [def, setDef] = useState<SvgSymbolDef>(() => {
    return resolveSymbolDef(elementType, initialTypeKey, viewType)
      ?? emptySymbol(elementType, initialTypeKey, viewType, `New ${elementType} symbol`);
  });
  const [dirty, setDirty] = useState(false);

  // Drag state
  const dragging = useRef<{ id: string; startPx: { x: number; y: number }; startMm: { x: number; y: number } } | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);

  const cs = useMemo(() => computeScale(params), [params]);

  // ── Load symbol when typeKey/viewType changes ─────────────────────────────
  useEffect(() => {
    const loaded = resolveSymbolDef(elementType, typeKey, viewTypeLocal);
    setDef(loaded ?? emptySymbol(elementType, typeKey, viewTypeLocal, `New ${elementType} symbol`));
    setDirty(false);
    setSelectedId(null);
    setPendingEdgeFrom(null);
  }, [elementType, typeKey, viewTypeLocal]);

  // ── Modify helpers ────────────────────────────────────────────────────────
  const modDef = useCallback((fn: (d: SvgSymbolDef) => SvgSymbolDef) => {
    setDef((prev) => fn(prev));
    setDirty(true);
  }, []);

  const addNode = useCallback((type: SymNodeType, cx: number, cy: number) => {
    const id = symId(type);
    const node: SvgSymNode = {
      id, type, label: type.toUpperCase(), cx, cy,
      props: defaultProps(type, cx, cy),
    };
    modDef((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSelectedId(id);
    return id;
  }, [modDef]);

  const deleteNode = useCallback((id: string) => {
    modDef((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.from !== id && e.to !== id),
    }));
    if (selectedId === id) setSelectedId(null);
  }, [modDef, selectedId]);

  const updateNodeProp = useCallback(<K extends string>(
    id: string, key: K, value: unknown,
  ) => {
    modDef((d) => ({
      ...d,
      nodes: d.nodes.map((n) =>
        n.id === id ? { ...n, props: { ...n.props, [key]: value } } : n,
      ),
    }));
  }, [modDef]);

  const updateNodePos = useCallback((id: string, cx: number, cy: number) => {
    modDef((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        if (n.id !== id) return n;
        const updated = { ...n, cx, cy };
        // Also update position props for sp nodes
        if (n.type === 'sp') {
          updated.props = { ...n.props, x_mm: Math.round(cx * 10) / 10, y_mm: Math.round(cy * 10) / 10 };
        }
        if (n.type === 'sa') {
          updated.props = { ...n.props, cx_mm: Math.round(cx * 10) / 10, cy_mm: Math.round(cy * 10) / 10 };
        }
        if (n.type === 'st') {
          updated.props = { ...n.props, x_mm: Math.round(cx * 10) / 10, y_mm: Math.round(cy * 10) / 10 };
        }
        return updated;
      }),
    }));
  }, [modDef]);

  const addEdge = useCallback((from: string, to: string, type: 'ref' | 'poly', order?: number) => {
    const edge: SvgSymEdge = { id: symId('e'), from, to, type, order };
    modDef((d) => ({ ...d, edges: [...d.edges, edge] }));
  }, [modDef]);

  // ── Save / delete ─────────────────────────────────────────────────────────
  const handleSave = () => {
    const toSave: SvgSymbolDef = {
      ...def,
      elementType,
      typeKey,
      viewType: viewTypeLocal,
      id: symbolKey(elementType, typeKey, viewTypeLocal),
      updatedAt: Date.now(),
    };
    setSymbolDef(toSave);
    saveSymbolLibraryToStorage();
    setDirty(false);
  };

  const handleDelete = () => {
    if (!window.confirm('Delete this symbol? The default rendering will be used instead.')) return;
    deleteSymbolDef(elementType, typeKey, viewTypeLocal);
    saveSymbolLibraryToStorage();
    setDef(emptySymbol(elementType, typeKey, viewTypeLocal, `New ${elementType} symbol`));
    setDirty(false);
  };

  // ── Canvas mouse events ───────────────────────────────────────────────────
  function getCanvasPos(e: React.MouseEvent<SVGElement>): { x: number; y: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function nodeAtPx(px: { x: number; y: number }): SvgSymNode | null {
    const HIT = 10; // px radius
    for (let i = def.nodes.length - 1; i >= 0; i--) {
      const n = def.nodes[i];
      const np = mm2px({ x: n.cx, y: n.cy }, cs);
      const dx = px.x - np.x, dy = px.y - np.y;
      if (dx * dx + dy * dy <= HIT * HIT) return n;
    }
    return null;
  }

  const handleCanvasClick = (e: React.MouseEvent<SVGElement>) => {
    const px = getCanvasPos(e);
    const mm = px2mm(px, cs);
    const hit = nodeAtPx(px);

    if (activeTool === 'select') {
      setSelectedId(hit?.id ?? null);
      return;
    }

    // sl / sh: edge creation mode — need source + target sp nodes
    if (activeTool === 'sl' || activeTool === 'sh') {
      if (hit && hit.type === 'sp') {
        if (!pendingEdgeFrom) {
          // First: create the sl/sh node, then set pending from it
          const newId = addNode(activeTool, mm.x, mm.y);
          // For sl: first ref edge connects new sl → hit sp
          addEdge(newId, hit.id, 'ref', 0);
          setPendingEdgeFrom(newId);
          setSelectedId(newId);
        } else {
          // Second: add the connecting edge
          const srcNode = def.nodes.find((n) => n.id === pendingEdgeFrom);
          if (srcNode?.type === 'sl') {
            addEdge(pendingEdgeFrom, hit.id, 'ref', 1);
          } else if (srcNode?.type === 'sh') {
            const polyEdges = def.edges.filter((e) => e.from === pendingEdgeFrom && e.type === 'poly');
            addEdge(pendingEdgeFrom, hit.id, 'poly', polyEdges.length);
          }
          // Keep pending for sh (polygon), clear for sl (exactly 2 refs done)
          if (srcNode?.type === 'sl') {
            setPendingEdgeFrom(null);
            setActiveTool('select');
          }
        }
        return;
      }
      // Clicked empty space → just select nothing
      setSelectedId(null);
      return;
    }

    // sp, sa, st: click adds node at position
    if (hit) {
      setSelectedId(hit.id);
    } else {
      const clampedX = Math.max(0, Math.min(params.W, mm.x));
      const clampedY = Math.max(0, mm.y);
      addNode(activeTool, Math.round(clampedX * 10) / 10, Math.round(clampedY * 10) / 10);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<SVGElement>) => {
    if (activeTool !== 'select') return;
    const px = getCanvasPos(e);
    const hit = nodeAtPx(px);
    if (!hit) return;
    setSelectedId(hit.id);
    const mm = px2mm(px, cs);
    dragging.current = { id: hit.id, startPx: px, startMm: { x: hit.cx, y: hit.cy } };
    e.preventDefault();
  };

  const handleMouseMove = (e: React.MouseEvent<SVGElement>) => {
    if (!dragging.current) return;
    const px = getCanvasPos(e);
    const mm = px2mm(px, cs);
    const clampX = Math.max(0, Math.min(params.W, mm.x));
    const clampY = Math.max(0, mm.y);
    updateNodePos(
      dragging.current.id,
      Math.round(clampX * 10) / 10,
      Math.round(clampY * 10) / 10,
    );
  };

  const handleMouseUp = () => { dragging.current = null; };

  // Keyboard delete
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        const focused = document.activeElement;
        if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) return;
        deleteNode(selectedId);
      }
      if (e.key === 'Escape') {
        setPendingEdgeFrom(null);
        setActiveTool('select');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedId, deleteNode]);

  // ── Selected node ─────────────────────────────────────────────────────────
  const selectedNode = def.nodes.find((n) => n.id === selectedId) ?? null;

  // ── Edge rendering helpers ────────────────────────────────────────────────
  function nodeCenter(n: SvgSymNode) {
    return mm2px({ x: n.cx, y: n.cy }, cs);
  }

  function renderEdgeLines() {
    const lines: React.ReactElement[] = [];
    for (const e of def.edges) {
      const fromNode = def.nodes.find((n) => n.id === e.from);
      const toNode   = def.nodes.find((n) => n.id === e.to);
      if (!fromNode || !toNode) continue;
      if (e.type !== 'ref' && e.type !== 'poly') continue;
      const a = nodeCenter(fromNode);
      const b = nodeCenter(toNode);
      // For sl (line) ref edges, draw the actual line in the node's color
      if (fromNode.type === 'sl') {
        const p = fromNode.props as SlProps;
        lines.push(
          <line key={e.id}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={p.stroke ?? NODE_COLORS.sl} strokeWidth={1.5}
            strokeDasharray="none" opacity={0.4}
          />,
        );
      } else {
        lines.push(
          <line key={e.id}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke="#94a3b8" strokeWidth={1}
            strokeDasharray="3 2"
          />,
        );
      }
    }

    // For sl nodes: draw a preview of the actual line between the two referenced sp nodes
    for (const n of def.nodes) {
      if (n.type !== 'sl') continue;
      const refs = def.edges.filter((e) => e.from === n.id && e.type === 'ref');
      if (refs.length >= 2) {
        const ptA = def.nodes.find((x) => x.id === refs[0].to);
        const ptB = def.nodes.find((x) => x.id === refs[1].to);
        if (ptA && ptB) {
          const a = nodeCenter(ptA);
          const b = nodeCenter(ptB);
          const p = n.props as SlProps;
          lines.push(
            <line key={`slpreview_${n.id}`}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={p.stroke ?? '#111'} strokeWidth={p.weight ?? 2}
              strokeDasharray={p.dash ? '6 3' : 'none'}
            />,
          );
        }
      }
    }
    return lines;
  }

  // ── Preview SVG ───────────────────────────────────────────────────────────
  const previewSvg = useMemo(() => {
    try {
      return renderSymbolSVGString(def, params, PREVIEW_W, PREVIEW_H);
    } catch {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_W}" height="${PREVIEW_H}" style="background:#f0f0ec"><text x="50%" y="50%" text-anchor="middle" fill="#999" font-size="12">Preview error</text></svg>`;
    }
  }, [def, params]);

  // List of existing symbols in the library
  const existingSymbols = useMemo(() =>
    listSymbolDefs().filter((d) => d.elementType === elementType && d.viewType === viewTypeLocal),
  [elementType, viewTypeLocal]);

  // ── Property inspector content ────────────────────────────────────────────
  function renderInspector() {
    if (!selectedNode) {
      return (
        <div className="text-[11px] text-gray-400 italic p-2">
          Select a node to edit its properties.
        </div>
      );
    }
    const n = selectedNode;
    const upd = (k: string, v: unknown) => updateNodeProp(n.id, k, v);

    return (
      <div className="space-y-0.5">
        <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">
          {n.type.toUpperCase()} — {n.label}
        </div>

        {n.type === 'sp' && (() => {
          const p = n.props as SpProps;
          return (<>
            <PropRow label="x (mm)"><ExprInput value={p.x_mm ?? 0} onChange={(v) => upd('x_mm', isNaN(Number(v)) ? v : Number(v))} placeholder="W/2" /></PropRow>
            <PropRow label="y (mm)"><ExprInput value={p.y_mm ?? 0} onChange={(v) => upd('y_mm', isNaN(Number(v)) ? v : Number(v))} placeholder="outer_off" /></PropRow>
            <PropRow label="Name"><input type="text" value={String(p.name ?? '')} onChange={(e) => upd('name', e.target.value)} className="w-full text-[11px] border border-gray-200 rounded px-1.5 py-0.5 bg-white" /></PropRow>
          </>);
        })()}

        {n.type === 'sl' && (() => {
          const p = n.props as SlProps;
          const refs = def.edges.filter((e) => e.from === n.id && e.type === 'ref');
          return (<>
            <div className="text-[10px] text-gray-400 mb-1">
              Connected sp: {refs.map((e) => {
                const pt = def.nodes.find((x) => x.id === e.to);
                return pt ? (pt.props as SpProps).name || pt.id.slice(-4) : '?';
              }).join(' → ')} {refs.length < 2 && <span className="text-orange-500">(click 2 sp nodes)</span>}
            </div>
            <PropRow label="Color"><ColorInput2 value={p.stroke ?? '#111'} onChange={(v) => upd('stroke', v)} /></PropRow>
            <PropRow label="Weight">
              <input type="number" value={p.weight ?? 1} min={0.5} max={10} step={0.5} onChange={(e) => upd('weight', Number(e.target.value))} className="w-16 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 text-right bg-white" />
            </PropRow>
            <PropRow label="Dashed">
              <input type="checkbox" checked={!!p.dash} onChange={(e) => upd('dash', e.target.checked)} className="accent-orange-500" />
            </PropRow>
          </>);
        })()}

        {n.type === 'sa' && (() => {
          const p = n.props as SaProps;
          return (<>
            <PropRow label="Center X"><ExprInput value={p.cx_mm ?? 0} onChange={(v) => upd('cx_mm', isNaN(Number(v)) ? v : Number(v))} /></PropRow>
            <PropRow label="Center Y"><ExprInput value={p.cy_mm ?? 0} onChange={(v) => upd('cy_mm', isNaN(Number(v)) ? v : Number(v))} /></PropRow>
            <PropRow label="Radius"><ExprInput value={p.r_mm ?? 100} onChange={(v) => upd('r_mm', isNaN(Number(v)) ? v : Number(v))} placeholder="W/4" /></PropRow>
            <PropRow label="Start angle°">
              <input type="number" value={p.a0 ?? 180} min={-360} max={360} onChange={(e) => upd('a0', Number(e.target.value))} className="w-16 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 text-right bg-white" />
            </PropRow>
            <PropRow label="End angle°">
              <input type="number" value={p.a1 ?? 0} min={-360} max={360} onChange={(e) => upd('a1', Number(e.target.value))} className="w-16 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 text-right bg-white" />
            </PropRow>
            <PropRow label="Color"><ColorInput2 value={p.stroke ?? '#111'} onChange={(v) => upd('stroke', v)} /></PropRow>
            <PropRow label="Weight">
              <input type="number" value={p.weight ?? 1} min={0.5} max={10} step={0.5} onChange={(e) => upd('weight', Number(e.target.value))} className="w-16 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 text-right bg-white" />
            </PropRow>
            <PropRow label="Clockwise">
              <input type="checkbox" checked={!!p.clockwise} onChange={(e) => upd('clockwise', e.target.checked)} className="accent-purple-500" />
            </PropRow>
          </>);
        })()}

        {n.type === 'st' && (() => {
          const p = n.props as StProps;
          return (<>
            <PropRow label="x (mm)"><ExprInput value={p.x_mm ?? 0} onChange={(v) => upd('x_mm', isNaN(Number(v)) ? v : Number(v))} placeholder="W/2" /></PropRow>
            <PropRow label="y (mm)"><ExprInput value={p.y_mm ?? 0} onChange={(v) => upd('y_mm', isNaN(Number(v)) ? v : Number(v))} /></PropRow>
            <PropRow label="Content">
              <input type="text" value={p.content ?? ''} onChange={(e) => upd('content', e.target.value)} className="w-full text-[11px] border border-gray-200 rounded px-1.5 py-0.5 bg-white" />
            </PropRow>
            <PropRow label="Size (mm)">
              <input type="number" value={p.size_mm ?? 50} min={10} max={500} onChange={(e) => upd('size_mm', Number(e.target.value))} className="w-16 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 text-right bg-white" />
            </PropRow>
            <PropRow label="Color"><ColorInput2 value={p.color ?? '#1a1a2e'} onChange={(v) => upd('color', v)} /></PropRow>
            <PropRow label="Anchor">
              <select value={p.anchor ?? 'middle'} onChange={(e) => upd('anchor', e.target.value)}
                className="text-[11px] border border-gray-200 rounded px-1 py-0.5 bg-white">
                <option value="start">Start</option>
                <option value="middle">Middle</option>
                <option value="end">End</option>
              </select>
            </PropRow>
            <PropRow label="Bold">
              <input type="checkbox" checked={!!p.bold} onChange={(e) => upd('bold', e.target.checked)} className="accent-green-600" />
            </PropRow>
          </>);
        })()}

        {n.type === 'sh' && (() => {
          const p = n.props as ShProps;
          const polyEdges = def.edges.filter((e) => e.from === n.id && e.type === 'poly');
          return (<>
            <div className="text-[10px] text-gray-400 mb-1">
              Vertices: {polyEdges.length} sp nodes. Click sp nodes to add vertices.
            </div>
            <PropRow label="Fill color"><ColorInput2 value={p.fill_color ?? '#aabbcc'} onChange={(v) => upd('fill_color', v)} /></PropRow>
            <PropRow label="Opacity">
              <input type="number" value={p.fill_opacity ?? 0.45} min={0} max={1} step={0.05} onChange={(e) => upd('fill_opacity', Number(e.target.value))} className="w-16 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 text-right bg-white" />
            </PropRow>
            <PropRow label="Pattern">
              <select value={p.pattern ?? 'diagonal'} onChange={(e) => upd('pattern', e.target.value)}
                className="text-[11px] border border-gray-200 rounded px-1 py-0.5 bg-white">
                {(['none', 'solid', 'diagonal', 'crosshatch', 'brick', 'dots'] as HatchPatternType[]).map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </select>
            </PropRow>
            <PropRow label="Stroke"><ColorInput2 value={p.stroke ?? '#555'} onChange={(v) => upd('stroke', v)} /></PropRow>
            <PropRow label="Stroke weight">
              <input type="number" value={p.weight ?? 1} min={0} max={8} step={0.5} onChange={(e) => upd('weight', Number(e.target.value))} className="w-16 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 text-right bg-white" />
            </PropRow>
            <div className="mt-1">
              <button
                className="text-[10px] text-red-500 hover:text-red-700"
                onClick={() => {
                  // Remove last polygon vertex
                  const sorted = polyEdges.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
                  if (sorted.length) {
                    modDef((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== sorted[0].id) }));
                  }
                }}
              >↩ Remove last vertex</button>
              <button
                className="ml-3 text-[10px] text-blue-500 hover:text-blue-700"
                onClick={() => setPendingEdgeFrom(n.id)}
              >+ Add vertex (click sp)</button>
            </div>
          </>);
        })()}

        <div className="mt-2 pt-1.5 border-t border-gray-100">
          <PropRow label="Label">
            <input type="text" value={n.label} onChange={(e) => modDef((d) => ({
              ...d,
              nodes: d.nodes.map((x) => x.id === n.id ? { ...x, label: e.target.value } : x),
            }))} className="w-full text-[11px] border border-gray-200 rounded px-1.5 py-0.5 bg-white" />
          </PropRow>
          <button
            onClick={() => deleteNode(n.id)}
            className="mt-1.5 text-[10px] text-red-500 hover:text-red-700 border border-red-200 rounded px-1.5 py-0.5"
          >
            🗑 Delete node
          </button>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const wallTopPx = mm2px({ x: 0, y: (params.outer_off ?? 125) - params.T / 2 }, cs);
  const wallBotPx = mm2px({ x: 0, y: (params.outer_off ?? 125) + params.T / 2 }, cs);
  const rightEdge = mm2px({ x: params.W, y: 0 }, cs);

  return (
    <div className="flex flex-col gap-2 text-sm select-none">
      {/* ── Toolbar row ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* TypeKey selector */}
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-gray-500">Type key:</span>
          <input
            type="text"
            value={typeKey}
            onChange={(e) => setTypeKey(e.target.value)}
            className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 w-36 font-mono"
            placeholder="opening:single"
          />
        </div>

        {/* ViewType selector */}
        <select
          value={viewTypeLocal}
          onChange={(e) => setViewTypeLocal(e.target.value as typeof viewTypeLocal)}
          className="text-[11px] border border-gray-200 rounded px-1 py-0.5 bg-white"
        >
          <option value="floorplan">Floor Plan</option>
          <option value="section">Section</option>
          <option value="elevation">Elevation</option>
        </select>

        {/* Symbol name */}
        <input
          type="text"
          value={def.name}
          onChange={(e) => modDef((d) => ({ ...d, name: e.target.value }))}
          className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 flex-1 min-w-20"
          placeholder="Symbol name…"
        />

        {/* Save / Delete */}
        <button
          onClick={handleSave}
          className={cn(
            'px-2.5 py-0.5 rounded text-[11px] font-semibold transition-colors',
            dirty
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-gray-100 text-gray-400 border border-gray-200',
          )}
        >
          {dirty ? '● Save' : '✓ Saved'}
        </button>
        {resolveSymbolDef(elementType, typeKey, viewTypeLocal) && (
          <button
            onClick={handleDelete}
            className="px-2 py-0.5 rounded text-[11px] text-red-500 border border-red-200 hover:bg-red-50"
          >🗑</button>
        )}
      </div>

      {/* ── Palette ── */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => { setActiveTool('select'); setPendingEdgeFrom(null); }}
          className={cn(
            'px-2 py-0.5 rounded text-[11px] border transition-colors',
            activeTool === 'select' ? 'bg-gray-800 text-white border-gray-800' : 'border-gray-200 text-gray-600 hover:bg-gray-50',
          )}
        >↖ Select</button>
        {PALETTE_TOOLS.map(({ type, icon, label, color }) => (
          <button
            key={type}
            title={label}
            onClick={() => { setActiveTool(type); setPendingEdgeFrom(null); }}
            style={{ color: activeTool === type ? 'white' : color, background: activeTool === type ? color : undefined }}
            className={cn(
              'w-7 h-6 flex items-center justify-center rounded text-[12px] border transition-colors',
              activeTool === type ? 'border-transparent font-bold' : 'border-gray-200 hover:bg-gray-50',
            )}
          >{icon}</button>
        ))}
        {pendingEdgeFrom && (
          <span className="text-[10px] text-orange-500 ml-1">
            {activeTool === 'sl' ? '→ click 2nd sp node' : '→ click sp nodes to add polygon vertices'}
            <button className="ml-1 underline" onClick={() => setPendingEdgeFrom(null)}>Cancel</button>
          </span>
        )}
        <span className="ml-auto text-[10px] text-gray-400">Del = delete selected</span>
      </div>

      {/* ── Canvas + inspector + preview ── */}
      <div className="flex gap-3 items-start">
        {/* Canvas SVG */}
        <div className="border border-gray-200 rounded overflow-hidden shrink-0" style={{ width: CANVAS_W, height: CANVAS_H }}>
          <svg
            ref={svgRef}
            width={CANVAS_W}
            height={CANVAS_H}
            style={{ background: '#fafaf8', cursor: activeTool === 'select' ? 'default' : 'crosshair', display: 'block' }}
            onClick={handleCanvasClick}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {/* Grid */}
            <g opacity={0.18}>
              {Array.from({ length: Math.ceil(params.W / 200) + 1 }, (_, i) => {
                const px = mm2px({ x: i * 200, y: 0 }, cs);
                return <line key={`gx${i}`} x1={px.x} y1={CANVAS_PAD} x2={px.x} y2={CANVAS_H - CANVAS_PAD} stroke="#999" strokeWidth={0.5} />;
              })}
              {Array.from({ length: Math.ceil(cs.TotalH / 100) + 1 }, (_, i) => {
                const px = mm2px({ x: 0, y: i * 100 }, cs);
                return <line key={`gy${i}`} x1={cs.ox} y1={px.y} x2={rightEdge.x} y2={px.y} stroke="#999" strokeWidth={0.5} />;
              })}
            </g>

            {/* Wall band */}
            <rect
              x={cs.ox - 8} y={wallTopPx.y} width={params.W * cs.scale + 16} height={wallBotPx.y - wallTopPx.y}
              fill="#CBD5E1" opacity={0.5}
            />

            {/* Opening bounds */}
            <rect
              x={cs.ox} y={cs.oy} width={params.W * cs.scale} height={cs.TotalH * cs.scale}
              fill="none" stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 2"
            />

            {/* Guide labels */}
            <text x={cs.ox - 4} y={cs.oy - 4} fontSize={9} fill="#94a3b8" textAnchor="end">0</text>
            <text x={rightEdge.x + 4} y={cs.oy - 4} fontSize={9} fill="#94a3b8">W={params.W}mm</text>
            <text x={cs.ox - 4} y={wallTopPx.y} fontSize={9} fill="#94a3b8" textAnchor="end">outer</text>
            <text x={cs.ox - 4} y={wallBotPx.y} fontSize={9} fill="#94a3b8" textAnchor="end">inner</text>

            {/* Edges */}
            {renderEdgeLines()}

            {/* Nodes */}
            {def.nodes.map((n) => {
              const c = mm2px({ x: n.cx, y: n.cy }, cs);
              const isSelected = n.id === selectedId;
              const isPending = n.id === pendingEdgeFrom;
              const col = NODE_COLORS[n.type];
              return (
                <g key={n.id}>
                  <circle
                    cx={c.x} cy={c.y} r={isSelected ? 7 : 5}
                    fill={isPending ? '#f59e0b' : col}
                    stroke={isSelected ? '#1e3a5f' : col}
                    strokeWidth={isSelected ? 2 : 1}
                    opacity={n.type === 'sl' || n.type === 'sh' ? 0.5 : 0.85}
                  />
                  {n.label && (
                    <text x={c.x + 8} y={c.y + 4} fontSize={8} fill={col} fontWeight={isSelected ? 'bold' : 'normal'}>
                      {n.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Inspector */}
        <div className="w-52 shrink-0 border border-gray-200 rounded p-2 bg-white text-[11px]" style={{ minHeight: CANVAS_H }}>
          <div className="font-semibold text-gray-600 mb-1.5 text-[10px] uppercase tracking-wide">Properties</div>
          {renderInspector()}
        </div>

        {/* Preview */}
        <div className="shrink-0 flex flex-col gap-1">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide">Preview</div>
          <div
            dangerouslySetInnerHTML={{ __html: previewSvg }}
            style={{ border: '1px solid #e5e7eb', borderRadius: 4 }}
          />
        </div>
      </div>

      {/* ── Existing symbols ── */}
      {existingSymbols.length > 0 && (
        <div className="border-t border-gray-100 pt-2">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Saved symbols for {elementType}</div>
          <div className="flex gap-1.5 flex-wrap">
            {existingSymbols.map((sym) => (
              <button
                key={sym.id}
                onClick={() => { setTypeKey(sym.typeKey); setViewTypeLocal(sym.viewType as typeof viewTypeLocal); }}
                className={cn(
                  'px-2 py-0.5 text-[11px] rounded border transition-colors',
                  sym.typeKey === typeKey && sym.viewType === viewTypeLocal
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                )}
              >
                {sym.name} <span className="opacity-60">({sym.typeKey}, {sym.viewType})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Expression variable reference ── */}
      <details className="text-[10px] text-gray-400">
        <summary className="cursor-pointer hover:text-gray-600">Expression variables reference</summary>
        <div className="grid grid-cols-2 gap-x-4 mt-1 ml-2">
          {[
            ['W', 'Opening width mm'], ['T', 'Wall thickness mm'],
            ['SH', 'Sill height mm'], ['FD', 'Frame depth mm'],
            ['outer_off', 'Outer frame offset mm'], ['inner_off', 'Inner frame offset mm'],
            ['sill_proj', 'Sill projection mm'], ['sq', 'Frame square side mm'],
            ['gw', 'Glass half-width mm'],
          ].map(([k, v]) => (
            <div key={k} className="flex gap-1"><code className="text-blue-600">{k}</code><span>{v}</span></div>
          ))}
        </div>
      </details>
    </div>
  );
}
