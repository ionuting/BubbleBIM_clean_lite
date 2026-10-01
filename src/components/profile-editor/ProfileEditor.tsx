/**
 * ProfileEditor.tsx — draw a sweep profile without leaving the app.
 *
 * The profile library has always had an open door: drop a DXF in
 * `backend/library/profiles/symbols2d` and the sweep can use any shape at all.
 * The cost was the trip — open a CAD, draw, export, come back. This is the same
 * door from the inside: what it saves is a `BglibSymbol`, the very structure
 * the DXF parser produces, so nothing downstream can tell the difference.
 *
 * ## The two things being drawn
 *
 * The OUTLINE is one closed polygon. Not two, and no holes: that is the whole
 * of what `profileFromBglib` reads and what `computeSweep` will accept, and
 * offering more here would only produce profiles the sweep quietly discards.
 *
 * The STRETCH ZONES are rectangles that make the profile resizable. A vertex
 * inside one moves by the full size change; inside a half zone, by half of it.
 * Draw a cornice 180 wide with its right-hand half in a length zone and it can
 * be used at 240 without redrawing — the mouldings keep their size and only the
 * flat stretches. Without any zone the profile is a fixed shape, which is right
 * for a moulding and wrong for a rail.
 *
 * Coordinates are millimetres in the profile's own plane, y up. The SVG y is
 * negated rather than the whole canvas flipped, so text stays upright.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { clientToSvgUserPoint } from '@/lib/svgCoordinates';
import { saveAutoSymbol } from '@/lib/bglibSymbolStore';
import { PROFILE_ELEMENT_TYPE, reloadProfileLibrary } from '@/lib/sweep/profileLibrary';
import {
  draftBounds, draftToBglib, profileFileName, validateProfileDraft,
  type ProfileDraft, type ProfileSlider,
} from '@/lib/profileDraft';
import type { Pt2 } from '@/lib/geom/plan2d';

type Tool = 'draw' | 'select' | 'zone';

const GRID_STEPS = [1, 5, 10, 25, 50];
/** How close, in screen pixels, a click has to be to snap to the first point. */
const CLOSE_PX = 12;

const SLIDER_KINDS: { axis: 'x' | 'y'; factor: number; label: string }[] = [
  { axis: 'x', factor: 1, label: 'lățime' },
  { axis: 'x', factor: 0.5, label: '½ lățime' },
  { axis: 'y', factor: 1, label: 'înălțime' },
  { axis: 'y', factor: 0.5, label: '½ înălțime' },
];

const ZONE_COLOR: Record<string, string> = {
  x: '#f59e0b',
  y: '#8b5cf6',
};

interface View { x: number; y: number; w: number; h: number }

/** The drawing, framed with room to work around it. SVG y is negated. */
function fitView(b: { minX: number; minY: number; maxX: number; maxY: number }): View {
  const pad = Math.max(60, Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.35);
  const x0 = Math.min(b.minX, 0) - pad;
  const x1 = Math.max(b.maxX, 200) + pad;
  const y0 = Math.min(b.minY, 0) - pad;
  const y1 = Math.max(b.maxY, 200) + pad;
  return { x: x0, y: -y1, w: Math.max(x1 - x0, 1), h: Math.max(y1 - y0, 1) };
}

/**
 * The view, widened just enough to hold the bounds — and the SAME object when
 * it already does, so setting it from an effect settles instead of looping.
 */
function growView(v: View, b: { minX: number; minY: number; maxX: number; maxY: number }): View {
  if (!Number.isFinite(b.minX)) return v;
  const margin = Math.max(30, Math.min(v.w, v.h) * 0.08);
  const x0 = Math.min(v.x, b.minX - margin);
  const x1 = Math.max(v.x + v.w, b.maxX + margin);
  const y0 = Math.min(v.y, -b.maxY - margin);
  const y1 = Math.max(v.y + v.h, -b.minY + margin);
  if (x0 === v.x && y0 === v.y && x1 - x0 === v.w && y1 - y0 === v.h) return v;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface ProfileEditorProps {
  initial?: ProfileDraft;
  /** Called with the library id once the profile is saved. */
  onSaved?: (typeId: string) => void;
  onClose: () => void;
  className?: string;
}

export function ProfileEditor({ initial, onSaved, onClose, className }: ProfileEditorProps) {
  const [draft, setDraft] = useState<ProfileDraft>(
    () => initial ?? { name: '', outline: [], sliders: [] },
  );
  const [tool, setTool] = useState<Tool>(initial?.outline.length ? 'select' : 'draw');
  const [grid, setGrid] = useState(10);
  const [closed, setClosed] = useState(Boolean(initial?.outline.length));
  const [hover, setHover] = useState<Pt2 | null>(null);
  const [drag, setDrag] = useState<{ kind: 'vertex'; index: number } | { kind: 'zone'; from: Pt2; to: Pt2 } | null>(null);
  const [selectedZone, setSelectedZone] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const diagnostics = useMemo(() => validateProfileDraft(draft), [draft]);
  const blocking = diagnostics.filter((d) => d.severity === 'error');
  const bounds = useMemo(() => draftBounds(draft.outline), [draft.outline]);

  // ── The view box ────────────────────────────────────────────────────────
  // It only ever GROWS while you draw. Recomputing it from the outline on
  // every click would rescale the canvas under the cursor at each new point,
  // which is unusable: you aim at a spot and the drawing moves out from under
  // you. It widens when a point lands outside it, and otherwise holds still.
  const [view, setView] = useState(() => fitView(draftBounds(initial?.outline ?? [])));
  const refit = useCallback(() => setView(fitView(bounds)), [bounds]);
  useEffect(() => {
    setView((v) => growView(v, bounds));
  }, [bounds]);

  const snap = useCallback((v: number) => Math.round(v / grid) * grid, [grid]);

  /** Pointer → profile millimetres, snapped to the grid. */
  const at = useCallback((e: { clientX: number; clientY: number }): Pt2 | null => {
    const p = clientToSvgUserPoint(svgRef.current, e.clientX, e.clientY);
    return p ? { x: snap(p.x), y: snap(-p.y) } : null;
  }, [snap]);

  /** Millimetres per screen pixel, for hit tests that should feel constant. */
  const mmPerPx = useCallback(() => {
    const el = svgRef.current;
    const w = el?.clientWidth ?? 1;
    return view.w / Math.max(w, 1);
  }, [view.w]);

  // ── Drawing the outline ─────────────────────────────────────────────────
  const onCanvasClick = useCallback((e: React.MouseEvent) => {
    const p = at(e);
    if (!p) return;
    if (tool === 'draw') {
      setError(null);
      const first = draft.outline[0];
      if (first && draft.outline.length >= 3
        && Math.hypot(p.x - first.x, p.y - first.y) < CLOSE_PX * mmPerPx()) {
        setClosed(true);
        setTool('select');
        return;
      }
      setDraft((d) => ({ ...d, outline: [...d.outline, p] }));
      return;
    }
    if (tool === 'select') setSelectedZone(null);
  }, [at, tool, draft.outline, mmPerPx]);

  const onCanvasMove = useCallback((e: React.MouseEvent) => {
    const p = at(e);
    setHover(p);
    if (!p || !drag) return;
    if (drag.kind === 'vertex') {
      setDraft((d) => ({
        ...d,
        outline: d.outline.map((q, i) => (i === drag.index ? p : q)),
      }));
    } else {
      setDrag({ ...drag, to: p });
    }
  }, [at, drag]);

  const onCanvasUp = useCallback(() => {
    if (drag?.kind === 'zone') {
      const { from, to } = drag;
      if (Math.abs(to.x - from.x) >= grid && Math.abs(to.y - from.y) >= grid) {
        setDraft((d) => ({
          ...d,
          sliders: [...d.sliders, {
            axis: 'x', factor: 1,
            region: { x0: from.x, y0: from.y, x1: to.x, y1: to.y },
          }],
        }));
        setSelectedZone(draft.sliders.length);
      }
    }
    setDrag(null);
  }, [drag, grid, draft.sliders.length]);

  const onCanvasDown = useCallback((e: React.MouseEvent) => {
    if (tool !== 'zone') return;
    const p = at(e);
    if (p) setDrag({ kind: 'zone', from: p, to: p });
  }, [tool, at]);

  // Enter closes the outline, Escape takes the last point back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Enter' && tool === 'draw' && draft.outline.length >= 3) {
        setClosed(true); setTool('select');
      } else if (e.key === 'Escape') {
        if (tool === 'draw' && draft.outline.length > 0) {
          setDraft((d) => ({ ...d, outline: d.outline.slice(0, -1) }));
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, draft.outline.length, onClose]);

  const removeVertex = (i: number) =>
    setDraft((d) => ({ ...d, outline: d.outline.filter((_, j) => j !== i) }));

  /** Split the edge that starts at `i`, so a straight run can grow a corner. */
  const splitEdge = (i: number) => setDraft((d) => {
    const a = d.outline[i], b = d.outline[(i + 1) % d.outline.length];
    const mid = { x: snap((a.x + b.x) / 2), y: snap((a.y + b.y) / 2) };
    const out = [...d.outline];
    out.splice(i + 1, 0, mid);
    return { ...d, outline: out };
  });

  const updateZone = (i: number, patch: Partial<ProfileSlider>) =>
    setDraft((d) => ({ ...d, sliders: d.sliders.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  const removeZone = (i: number) => {
    setDraft((d) => ({ ...d, sliders: d.sliders.filter((_, j) => j !== i) }));
    setSelectedZone(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const res = await saveAutoSymbol(PROFILE_ELEMENT_TYPE, draftToBglib(draft));
    setSaving(false);
    if ('error' in res) { setError(res.error); return; }
    reloadProfileLibrary();
    onSaved?.(res.typeId);
    onClose();
  };

  // ── Rendering helpers ───────────────────────────────────────────────────
  const X = (p: Pt2) => p.x;
  const Y = (p: Pt2) => -p.y;
  const px = (n: number) => n * mmPerPx();          // screen pixels → mm

  const outlinePath = draft.outline.length >= 2
    ? `M ${draft.outline.map((p) => `${X(p)},${Y(p)}`).join(' L ')}${closed ? ' Z' : ''}`
    : '';

  const gridLines = useMemo(() => {
    // Never more than a few hundred lines: a 1 mm grid over a metre would be
    // 1000 of them, and the browser would rather not.
    const step = Math.max(grid, view.w / 200);
    const lines: React.ReactElement[] = [];
    const x0 = Math.ceil(view.x / step) * step;
    for (let x = x0; x < view.x + view.w; x += step) {
      lines.push(<line key={`gx${x}`} x1={x} y1={view.y} x2={x} y2={view.y + view.h} />);
    }
    const y0 = Math.ceil(view.y / step) * step;
    for (let y = y0; y < view.y + view.h; y += step) {
      lines.push(<line key={`gy${y}`} x1={view.x} y1={y} x2={view.x + view.w} y2={y} />);
    }
    return lines;
  }, [grid, view]);

  return (
    <div className={cn('flex h-full min-h-0 bg-background', className)}>
      {/* ── Canvas ── */}
      <div className="flex-1 min-w-0 relative" style={{ background: '#f8f7f4' }}>
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          className="w-full h-full"
          style={{ cursor: tool === 'draw' || tool === 'zone' ? 'crosshair' : 'default' }}
          onClick={onCanvasClick}
          onMouseMove={onCanvasMove}
          onMouseDown={onCanvasDown}
          onMouseUp={onCanvasUp}
          onMouseLeave={() => { setHover(null); setDrag(null); }}
        >
          <g stroke="#cbd5e1" strokeWidth={px(0.4)} opacity={0.6}>{gridLines}</g>
          {/* The origin — where the profile's own coordinates start. */}
          <g stroke="#94a3b8" strokeWidth={px(0.9)}>
            <line x1={view.x} y1={0} x2={view.x + view.w} y2={0} />
            <line x1={0} y1={view.y} x2={0} y2={view.y + view.h} />
          </g>

          {/* Stretch zones, under the outline so the shape stays readable. */}
          {draft.sliders.map((s, i) => {
            const r = s.region;
            const x = Math.min(r.x0, r.x1), y = Math.max(r.y0, r.y1);
            return (
              <rect key={`z${i}`}
                x={x} y={-y}
                width={Math.abs(r.x1 - r.x0)} height={Math.abs(r.y1 - r.y0)}
                fill={ZONE_COLOR[s.axis]} fillOpacity={selectedZone === i ? 0.25 : 0.12}
                stroke={ZONE_COLOR[s.axis]} strokeWidth={px(selectedZone === i ? 1.6 : 1)}
                strokeDasharray={`${px(4)} ${px(3)}`}
                style={{ cursor: 'pointer' }}
                onClick={(e) => { e.stopPropagation(); setSelectedZone(i); }}
              />
            );
          })}
          {drag?.kind === 'zone' && (
            <rect
              x={Math.min(drag.from.x, drag.to.x)} y={-Math.max(drag.from.y, drag.to.y)}
              width={Math.abs(drag.to.x - drag.from.x)} height={Math.abs(drag.to.y - drag.from.y)}
              fill="#f59e0b" fillOpacity={0.15} stroke="#f59e0b" strokeWidth={px(1.2)} />
          )}

          {/* The outline. */}
          {outlinePath && (
            <path d={outlinePath}
              fill={closed ? '#3b82f6' : 'none'} fillOpacity={0.16}
              stroke={blocking.length ? '#dc2626' : '#1d4ed8'} strokeWidth={px(1.8)}
              strokeLinejoin="round" />
          )}

          {/* The rubber band while drawing. */}
          {tool === 'draw' && hover && draft.outline.length > 0 && (
            <line
              x1={X(draft.outline[draft.outline.length - 1])} y1={Y(draft.outline[draft.outline.length - 1])}
              x2={X(hover)} y2={Y(hover)}
              stroke="#1d4ed8" strokeWidth={px(1)} strokeDasharray={`${px(4)} ${px(3)}`} opacity={0.7} />
          )}

          {/* Edge handles: click one to grow a corner there. */}
          {tool === 'select' && closed && draft.outline.map((p, i) => {
            const q = draft.outline[(i + 1) % draft.outline.length];
            return (
              <circle key={`e${i}`}
                cx={(X(p) + X(q)) / 2} cy={(Y(p) + Y(q)) / 2} r={px(3.5)}
                fill="white" stroke="#94a3b8" strokeWidth={px(1)}
                style={{ cursor: 'copy' }}
                onClick={(e) => { e.stopPropagation(); splitEdge(i); }}>
                <title>Adaugă un punct aici</title>
              </circle>
            );
          })}

          {/* Vertices. */}
          {draft.outline.map((p, i) => (
            <circle key={`v${i}`}
              cx={X(p)} cy={Y(p)} r={px(i === 0 && !closed ? 6 : 4.5)}
              fill={i === 0 && !closed ? '#1d4ed8' : 'white'}
              stroke="#1d4ed8" strokeWidth={px(1.6)}
              style={{ cursor: tool === 'select' ? 'move' : 'pointer' }}
              onMouseDown={(e) => {
                if (tool !== 'select') return;
                e.stopPropagation();
                setDrag({ kind: 'vertex', index: i });
              }}
              onDoubleClick={(e) => { e.stopPropagation(); removeVertex(i); }}>
              <title>{`${p.x} , ${p.y} mm${tool === 'select' ? ' — trage pentru a muta, dublu-clic pentru a șterge' : ''}`}</title>
            </circle>
          ))}
        </svg>

        <div className="absolute bottom-2 left-2 text-[10px] text-muted-foreground bg-background/80 px-1.5 py-0.5 rounded border border-border/50 font-mono">
          {hover ? `${hover.x} , ${hover.y} mm` : `grilă ${grid} mm`}
        </div>
        <div className="absolute bottom-2 right-2 text-[10px] text-muted-foreground pointer-events-none">
          {tool === 'draw'
            ? 'Clic = punct · Enter sau clic pe primul punct = închide · Esc = înapoi'
            : tool === 'zone'
              ? 'Trage un dreptunghi peste punctele care trebuie să urmeze dimensiunea'
              : 'Trage un punct · dublu-clic îl șterge · cercul de pe latură adaugă unul'}
        </div>
      </div>

      {/* ── Side panel ── */}
      <aside className="w-64 shrink-0 border-l border-border bg-muted/20 flex flex-col min-h-0">
        <div className="p-2.5 border-b border-border/60 space-y-2">
          <input
            className="w-full bg-background border border-border rounded px-2 py-1 text-xs"
            placeholder="Numele profilului"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <div className="flex gap-1">
            {(['draw', 'select', 'zone'] as Tool[]).map((t) => (
              <button key={t}
                onClick={() => setTool(t)}
                className={cn(
                  'flex-1 text-[11px] py-1 rounded border transition-colors',
                  tool === t ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background border-border hover:bg-accent',
                )}
              >{t === 'draw' ? 'Desenează' : t === 'select' ? 'Editează' : 'Zone'}</button>
            ))}
          </div>
          <label className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Grilă</span>
            <select
              className="bg-background border border-border rounded px-1 py-0.5 text-[11px]"
              value={grid}
              onChange={(e) => setGrid(Number(e.target.value))}
            >
              {GRID_STEPS.map((g) => <option key={g} value={g}>{g} mm</option>)}
            </select>
          </label>
        </div>

        <div className="p-2.5 border-b border-border/60 text-[11px] text-muted-foreground space-y-0.5">
          <div className="flex justify-between">
            <span>Dimensiune desenată</span>
            <span className="font-mono text-foreground">
              {Math.round(bounds.maxX - bounds.minX)} × {Math.round(bounds.maxY - bounds.minY)} mm
            </span>
          </div>
          <div className="flex justify-between">
            <span>Puncte</span>
            <span className="font-mono text-foreground">{draft.outline.length}</span>
          </div>
          <button
            onClick={refit}
            className="w-full mt-1 text-[10px] py-0.5 rounded border border-border bg-background hover:bg-accent"
          >Încadrează desenul</button>
        </div>

        {/* Stretch zones */}
        <div className="flex-1 min-h-0 overflow-auto p-2.5 space-y-1.5">
          <div className="text-[11px] font-medium text-foreground">Zone de întindere</div>
          {draft.sliders.length === 0 && (
            <p className="text-[10px] text-muted-foreground leading-snug">
              Fără ele profilul rămâne la dimensiunea desenată. Desenează o zonă peste
              punctele care trebuie să se miște când se schimbă lățimea sau înălțimea.
            </p>
          )}
          {draft.sliders.map((s, i) => (
            <div key={i}
              className={cn(
                'rounded border p-1.5 space-y-1 cursor-pointer',
                selectedZone === i ? 'border-primary bg-background' : 'border-border/60 bg-background/60',
              )}
              onClick={() => setSelectedZone(i)}
            >
              <div className="flex items-center gap-1">
                <select
                  className="flex-1 bg-background border border-border rounded px-1 py-0.5 text-[11px]"
                  value={`${s.axis}:${s.factor}`}
                  onChange={(e) => {
                    const [axis, factor] = e.target.value.split(':');
                    updateZone(i, { axis: axis as 'x' | 'y', factor: Number(factor) });
                  }}
                >
                  {SLIDER_KINDS.map((k) => (
                    <option key={`${k.axis}:${k.factor}`} value={`${k.axis}:${k.factor}`}>{k.label}</option>
                  ))}
                </select>
                <button
                  className="w-5 h-5 rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                  onClick={(e) => { e.stopPropagation(); removeZone(i); }}
                >✕</button>
              </div>
              <div className="text-[10px] text-muted-foreground font-mono">
                {Math.round(Math.min(s.region.x0, s.region.x1))},{Math.round(Math.min(s.region.y0, s.region.y1))}
                {' → '}
                {Math.round(Math.max(s.region.x0, s.region.x1))},{Math.round(Math.max(s.region.y0, s.region.y1))}
              </div>
            </div>
          ))}
        </div>

        {/* Diagnostics */}
        {(diagnostics.length > 0 || error) && (
          <div className="p-2.5 border-t border-border/60 space-y-1 max-h-40 overflow-auto">
            {error && <p className="text-[10px] text-red-600">{error}</p>}
            {diagnostics.map((d, i) => (
              <p key={i} className={cn(
                'text-[10px] leading-snug',
                d.severity === 'error' ? 'text-red-600'
                  : d.severity === 'warning' ? 'text-amber-600' : 'text-muted-foreground',
              )}>{d.message}</p>
            ))}
          </div>
        )}

        <div className="p-2.5 border-t border-border/60 flex gap-1.5">
          <button
            onClick={onClose}
            className="flex-1 text-[11px] py-1.5 rounded border border-border bg-background hover:bg-accent"
          >Renunță</button>
          <button
            onClick={save}
            disabled={saving || blocking.length > 0 || !closed}
            title={!closed ? 'Închide întâi conturul' : blocking[0]?.message}
            className="flex-1 text-[11px] py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90"
          >{saving ? 'Se salvează…' : `Salvează ${draft.name ? `«${profileFileName(draft.name)}»` : ''}`}</button>
        </div>
      </aside>
    </div>
  );
}
