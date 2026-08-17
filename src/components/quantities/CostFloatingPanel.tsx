/**
 * CostFloatingPanel — panou flotant cu structura costurilor construcției.
 *
 * Forme (conform ghidului de dataviz):
 *  - DONUT part-to-whole „la o privire", limitat la 4 segmente (top 3 + „Alte").
 *    Paleta = primele 4 sloturi categorice documentate, validate all-pairs în ambele
 *    moduri; dark aterizează în banda CVD 6–8 → encoding secundar obligatoriu, iar
 *    light are contrast <3:1 → relief obligatoriu. Ambele sunt acoperite de
 *    etichetele directe + legendă + vizualizarea tabel.
 *  - BARĂ ORIZONTALĂ ordonată pentru partea COMPARATIVĂ (pie e nepotrivit pentru
 *    comparat valori apropiate). Categorii nominale, o singură serie → toate barele
 *    poartă hue-ul slotului 1, fără legendă.
 *
 * Textul poartă tokenii de text, niciodată culoarea seriei.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  costByCategory, topNWithOther, grandTotalCost, layoutDonut, arcPath, DONUT_GEOM,
  planPriceRun, unpricedArticles,
} from '@/lib/quantityTakeoff';
import { usePrices, CURRENCY } from '@/store/priceStore';

interface CostFloatingPanelProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  onClose: () => void;
}

const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Primele 4 sloturi categorice — ordine fixă, niciodată ciclată. */
const SLOT = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];

const MIN_W = 300;
const MIN_H = 240;

export function CostFloatingPanel({ nodes, edges, onClose }: CostFloatingPanelProps) {
  const prices = usePrices((s) => s.prices);
  const mergePrices = usePrices((s) => s.mergePrices);
  const [showTable, setShowTable] = useState(false);
  const [runInfo, setRunInfo] = useState<string | null>(null);
  const [hover, setHover] = useState<{ label: string; value: number; share: number; x: number; y: number } | null>(null);

  // ── Mutare + redimensionare ──
  const panelRef = useRef<HTMLDivElement>(null);
  /** null = ancorat implicit dreapta-jos; după prima mutare trecem pe left/top. */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number | null }>({ w: 360, h: null });
  const drag = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null>(null);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    const el = panelRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    const parent = el.offsetParent as HTMLElement | null;

    if (d.mode === 'move') {
      let x = d.ox + dx;
      let y = d.oy + dy;
      if (parent) {
        // Ținem panoul în interiorul containerului.
        x = Math.max(0, Math.min(x, parent.clientWidth - el.offsetWidth));
        y = Math.max(0, Math.min(y, parent.clientHeight - el.offsetHeight));
      }
      setPos({ x, y });
    } else {
      let w = Math.max(MIN_W, d.ow + dx);
      let h = Math.max(MIN_H, d.oh + dy);
      if (parent) {
        w = Math.min(w, parent.clientWidth - d.ox);
        h = Math.min(h, parent.clientHeight - d.oy);
      }
      setSize({ w, h });
    }
  }, []);

  const endDrag = useCallback(() => {
    drag.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
  }, [onPointerMove]);

  const beginDrag = useCallback(
    (mode: 'move' | 'resize', e: React.PointerEvent) => {
      const el = panelRef.current;
      if (!el) return;
      // Fixăm poziția curentă înainte de a trece de la ancorare right/bottom la left/top.
      const x = pos?.x ?? el.offsetLeft;
      const y = pos?.y ?? el.offsetTop;
      setPos({ x, y });
      drag.current = { mode, sx: e.clientX, sy: e.clientY, ox: x, oy: y, ow: el.offsetWidth, oh: el.offsetHeight };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', endDrag);
      e.preventDefault();
      e.stopPropagation();
    },
    [pos, onPointerMove, endDrag],
  );

  const all = useMemo(() => costByCategory(nodes, edges, prices), [nodes, edges, prices]);
  const total = useMemo(() => grandTotalCost(all), [all]);
  // Maxim 4 segmente: paleta documentată validează 4 sloturi într-o formă all-pairs.
  const slices = useMemo(() => topNWithOther(all, 3), [all]);
  const { arcs, labels } = useMemo(() => layoutDonut(slices), [slices]);

  const { W, H, cx, cy, rO, rI } = DONUT_GEOM;
  const maxBar = all.length > 0 ? all[0].total : 1;

  // Articole folosite în model care încă n-au preț → totalul e incomplet.
  const unpriced = useMemo(() => unpricedArticles(nodes, edges, prices), [nodes, edges, prices]);

  /** Rulează tarifarea pentru modelul în starea curentă; costurile se recalculează reactiv. */
  const runPrices = useCallback(
    (overwrite: boolean) => {
      const plan = planPriceRun(nodes, edges, prices, { overwrite });
      mergePrices(plan.toApply);
      const parts = [`${Object.keys(plan.toApply).length} articles priced`];
      if (plan.kept.length) parts.push(`${plan.kept.length} kept manual`);
      if (plan.missing.length) parts.push(`${plan.missing.length} without default price`);
      setRunInfo(`✓ ${plan.usedCount} articles · ${plan.categories.length} categories — ${parts.join(' · ')}`);
    },
    [nodes, edges, prices, mergePrices],
  );

  return (
    <div
      ref={panelRef}
      className="cost-viz"
      style={{
        position: 'absolute',
        ...(pos ? { left: pos.x, top: pos.y } : { right: 16, bottom: 16 }),
        width: size.w,
        ...(size.h ? { height: size.h } : { maxHeight: 'calc(100% - 32px)' }),
        display: 'flex', flexDirection: 'column',
        background: 'hsl(var(--card, var(--background)))',
        border: '1px solid hsl(var(--border))',
        borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,0.28)', zIndex: 40, fontSize: 12,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Paleta: primele 4 sloturi documentate; dark = aceleași hue-uri stepate pentru suprafața dark. */}
      <style>{`
        .cost-viz { --s1:#2a78d6; --s2:#008300; --s3:#e87ba4; --s4:#eda100; --viz-surface:hsl(var(--muted)); }
        .dark .cost-viz { --s1:#3987e5; --s2:#3dbeb0; --s3:#d55181; --s4:#c98500; --viz-surface:hsl(var(--muted)); }
      `}</style>

      {/* Antet = mâner de mutare */}
      <div
        onPointerDown={(e) => beginDrag('move', e)}
        style={{
          display: 'flex', alignItems: 'baseline', gap: 8, padding: '10px 12px 6px',
          borderBottom: '1px solid hsl(var(--border))', cursor: 'move', flexShrink: 0,
          userSelect: 'none', touchAction: 'none',
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>⠿ Construction costs</div>
          <div style={{ fontSize: 10.5, color: 'hsl(var(--muted-foreground))' }}>by work category</div>
        </div>
        <button
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          title="Close"
          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--muted-foreground))', fontSize: 15, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      {/* Action bar: run pricing for current model */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid hsl(var(--border))', flexShrink: 0, flexWrap: 'wrap' }}>
        <button
          onClick={() => runPrices(false)}
          title="Load unit prices for all categories in the model and recalculate"
          style={{
            fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
            border: '1px solid hsl(var(--primary))', background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))',
          }}
        >
          ▶ Calculate costs
        </button>
        <button
          onClick={() => runPrices(true)}
          title="Overwrite including manually entered prices"
          style={{
            fontSize: 10.5, padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
            border: '1px solid hsl(var(--border))', background: 'transparent', color: 'hsl(var(--muted-foreground))',
          }}
        >
          ↻ reset to defaults
        </button>
      </div>

      {/* Run result + coverage warning */}
      {(runInfo || unpriced.length > 0) && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid hsl(var(--border))', flexShrink: 0, fontSize: 10 }}>
          {runInfo && <div style={{ color: 'hsl(var(--muted-foreground))' }}>{runInfo}</div>}
          {unpriced.length > 0 && (
            <div style={{ color: '#b45309', marginTop: runInfo ? 3 : 0 }}>
              ⚠ {unpriced.length} {unpriced.length === 1 ? 'article' : 'articles'} without price — <strong>total incomplete</strong>
              <div style={{ fontSize: 9, opacity: 0.85, marginTop: 1 }}>
                {unpriced.slice(0, 3).map((u) => u.article.symbol).join(', ')}
                {unpriced.length > 3 ? ` +${unpriced.length - 3}` : ''}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Scrollable body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {total <= 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'hsl(var(--muted-foreground))', fontSize: 11.5, lineHeight: 1.6 }}>
          No costs calculated yet.
          <br />
          Press <strong>▶ Calculate costs</strong> to load unit prices
          <br />for the categories in the model.
        </div>
      ) : (
        <>
          {/* ── Donut: cost structure (part-to-whole, ≤4 segments) ── */}
          <div style={{ padding: '8px 12px 0' }}>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'hsl(var(--muted-foreground))', marginBottom: 2 }}>
              Cost structure
            </div>
            <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
              {arcs.map((a) => (
                <path
                  key={a.categorie}
                  d={arcPath(cx, cy, rO, rI, a.a0, a.a1)}
                  fill={SLOT[a.colorSlot] ?? SLOT[3]}
                  /* spacer de 2px în culoarea suprafeței între fill-uri */
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                  onPointerMove={(e) => setHover({ label: a.categorie, value: a.total, share: a.share, x: e.clientX, y: e.clientY })}
                  onPointerLeave={() => setHover(null)}
                />
              ))}
              {/* Hero number în centru — textul poartă tokeni de text, nu culoarea seriei */}
              <text x={cx} y={cy - 3} textAnchor="middle" style={{ fontSize: 13, fontWeight: 800, fill: 'hsl(var(--foreground))' }}>
                {money(total)}
              </text>
              <text x={cx} y={cy + 10} textAnchor="middle" style={{ fontSize: 8.5, fill: 'hsl(var(--muted-foreground))' }}>
                {CURRENCY} total
              </text>

              {/* Etichete directe — identitatea nu e purtată doar de culoare (poziții de-coliziate) */}
              {labels.map((l) => (
                <text
                  key={`l-${l.text}`}
                  x={l.x} y={l.y}
                  textAnchor={l.anchor}
                  dominantBaseline="middle"
                  style={{ fontSize: 9.5, fill: 'hsl(var(--foreground))' }}
                >
                  {l.text}
                </text>
              ))}
            </svg>

            {/* Legendă (≥2 serii → mereu prezentă) */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginTop: 2 }}>
              {arcs.map((a) => (
                <span key={`lg-${a.categorie}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: SLOT[a.colorSlot] ?? SLOT[3], flexShrink: 0 }} />
                  {a.categorie}
                </span>
              ))}
            </div>
          </div>

          {/* ── Bară ordonată: comparativ pe categorii (o singură serie → slot 1) ── */}
          <div style={{ padding: '10px 12px 4px' }}>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'hsl(var(--muted-foreground))', marginBottom: 5 }}>
              Category comparison
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {all.map((c) => (
                <div
                  key={c.categorie}
                  onPointerMove={(e) => setHover({ label: c.categorie, value: c.total, share: c.share, x: e.clientX, y: e.clientY })}
                  onPointerLeave={() => setHover(null)}
                  style={{ display: 'grid', gridTemplateColumns: '84px 1fr auto', alignItems: 'center', gap: 6, cursor: 'default' }}
                >
                  <span style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.categorie}>
                    {c.categorie}
                  </span>
                  <span style={{ height: 9, background: 'hsl(var(--muted))', borderRadius: 3, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: `${(c.total / maxBar) * 100}%`, background: 'var(--s1)', borderRadius: 3 }} />
                  </span>
                  <span style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--foreground))' }}>
                    {money(c.total)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Vizualizare tabel (relief obligatoriu pentru contrast + alternativă non-vizuală) ── */}
          <div style={{ padding: '6px 12px 12px' }}>
            <button
              onClick={() => setShowTable((p) => !p)}
              style={{ fontSize: 10, color: 'hsl(var(--primary))', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              {showTable ? '▾ hide table' : '▸ view as table'}
            </button>
            {showTable && (
              <table style={{ width: '100%', marginTop: 6, borderCollapse: 'collapse', fontSize: 10.5 }}>
                <thead>
                  <tr style={{ color: 'hsl(var(--muted-foreground))', fontSize: 9.5 }}>
                    <th style={{ textAlign: 'left', padding: '2px 0' }}>Category</th>
                    <th style={{ textAlign: 'right', padding: '2px 0' }}>Cost ({CURRENCY})</th>
                    <th style={{ textAlign: 'right', padding: '2px 0' }}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map((c) => (
                    <tr key={c.categorie} style={{ borderTop: '1px solid hsl(var(--border))' }}>
                      <td style={{ padding: '2px 0' }}>{c.categorie}</td>
                      <td style={{ padding: '2px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(c.total)}</td>
                      <td style={{ padding: '2px 0', textAlign: 'right', color: 'hsl(var(--muted-foreground))' }}>{pct(c.share)}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid hsl(var(--border))', fontWeight: 700 }}>
                    <td style={{ padding: '3px 0' }}>Total</td>
                    <td style={{ padding: '3px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(total)}</td>
                    <td style={{ padding: '3px 0', textAlign: 'right' }}>100%</td>
                  </tr>
                </tbody>
              </table>
            )}
            <div style={{ marginTop: 6, fontSize: 9, color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' }}>
              Indicative prices — verify before tendering.
            </div>
          </div>
        </>
      )}
      </div>

      {/* Resize handle (bottom-right) */}
      <div
        onPointerDown={(e) => beginDrag('resize', e)}
        title="Resize"
        style={{
          position: 'absolute', right: 0, bottom: 0, width: 16, height: 16,
          cursor: 'nwse-resize', touchAction: 'none',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" style={{ display: 'block' }}>
          <path d="M15 5 L5 15 M15 9 L9 15 M15 13 L13 15" stroke="hsl(var(--muted-foreground))" strokeWidth="1.2" fill="none" />
        </svg>
      </div>

      {/* Tooltip la hover */}
      {hover && (
        <div
          style={{
            position: 'fixed', left: hover.x + 12, top: hover.y + 12, pointerEvents: 'none', zIndex: 60,
            background: 'hsl(var(--background))', color: 'hsl(var(--foreground))',
            border: '1px solid hsl(var(--border))', borderRadius: 6, padding: '4px 8px', fontSize: 11,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)', whiteSpace: 'nowrap',
          }}
        >
          <strong>{hover.label}</strong> — {money(hover.value)} {CURRENCY} · {pct(hover.share)}
        </div>
      )}
    </div>
  );
}
