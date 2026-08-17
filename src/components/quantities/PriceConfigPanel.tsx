/**
 * PriceConfigPanel — configurare globală a prețurilor unitare, organizată pe
 * CATEGORIE DE LUCRĂRI. Prețul e per articol (fiecare articol are unitatea lui),
 * dar editarea e grupată pe categorie, cu opțiune de aplicare în masă pe categorie.
 */
import { useMemo, useState } from 'react';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { aggregateCalcGroups, unitLabel } from '@/lib/quantityTakeoff';
import type { NormArticle, NormUnit } from '@/lib/norms';
import { PRETURI_DEFAULT_RO, totalPret } from '@/lib/norms';
import { usePrices, CURRENCY } from '@/store/priceStore';

interface PriceConfigPanelProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
}

interface CategoryGroup {
  categorie: string;
  articles: { normId: string; article: NormArticle; unit: NormUnit }[];
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function PriceConfigPanel({ nodes, edges }: PriceConfigPanelProps) {
  const prices = usePrices((s) => s.prices);
  const setPrice = usePrices((s) => s.setPrice);
  const setPrices = usePrices((s) => s.setPrices);

  // Articles used in the project, unique, grouped by category.
  const categories = useMemo<CategoryGroup[]>(() => {
    const groups = aggregateCalcGroups(nodes, edges);
    const byCat = new Map<string, Map<string, { article: NormArticle; unit: NormUnit }>>();
    for (const cap of groups)
      for (const s of cap.storeys)
        for (const ag of s.articles) {
          let m = byCat.get(ag.article.categorie);
          if (!m) { m = new Map(); byCat.set(ag.article.categorie, m); }
          if (!m.has(ag.normId)) m.set(ag.normId, { article: ag.article, unit: ag.unit });
        }
    return [...byCat.entries()]
      .map(([categorie, arts]) => ({
        categorie,
        articles: [...arts.entries()]
          .map(([normId, v]) => ({ normId, ...v }))
          .sort((a, b) => a.article.symbol.localeCompare(b.article.symbol, 'en')),
      }))
      .sort((a, b) => a.categorie.localeCompare(b.categorie, 'en'));
  }, [nodes, edges]);

  const [bulk, setBulk] = useState<Record<string, string>>({});

  if (categories.length === 0) {
    return <div style={{ padding: 16, fontSize: 12, color: 'hsl(var(--muted-foreground))', textAlign: 'center' }}>No articles to price.</div>;
  }

  const allIds = categories.flatMap((c) => c.articles.map((a) => a.normId));
  const withDefaults = allIds.filter((id) => PRETURI_DEFAULT_RO[id]);

  function loadDefaults() {
    const next: Record<string, number> = {};
    for (const id of withDefaults) next[id] = totalPret(PRETURI_DEFAULT_RO[id]);
    for (const [id, p] of Object.entries(next)) setPrice(id, p);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 4px 12px' }}>
      <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
        Unit prices by work category ({CURRENCY}). Saved with the project.
      </div>

      {/* Honest warning: defaults are estimates, not market quotes. */}
      <div
        style={{
          border: '1px solid color-mix(in srgb, #d97706 45%, hsl(var(--border)))',
          background: 'color-mix(in srgb, #d97706 12%, hsl(var(--background)))',
          color: 'hsl(var(--foreground))',
          borderRadius: 8,
          padding: '8px 10px',
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        <strong>⚠ Indicative prices</strong> — order-of-magnitude estimates for Romania
        (~2025–2026), <strong>not verified market quotes</strong>. They vary by region,
        supplier, and volume. Use them as a starting point and update with your own prices
        before tendering. Each value = materials + labour + equipment + transport.
        <div style={{ marginTop: 6 }}>
          <button
            className="bb-row"
            style={{
              fontSize: 10.5,
              padding: '3px 10px',
              color: 'hsl(var(--foreground))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              background: 'hsl(var(--muted))',
            }}
            onClick={loadDefaults}
            disabled={withDefaults.length === 0}
            title="Overwrite prices with indicative defaults"
          >
            Load indicative prices ({withDefaults.length} articles)
          </button>
        </div>
      </div>

      {categories.map((cat) => (
        <section key={cat.categorie} style={{ border: '1px solid hsl(var(--border))', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'hsl(var(--muted))', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 12 }}>{cat.categorie}</span>
            <span style={{ fontSize: 10.5, color: 'hsl(var(--muted-foreground))' }}>{cat.articles.length} articles</span>
            {/* Bulk apply per category */}
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="price"
                value={bulk[cat.categorie] ?? ''}
                onChange={(e) => setBulk((b) => ({ ...b, [cat.categorie]: e.target.value }))}
                style={{ width: 72, padding: '2px 6px', border: '1px solid hsl(var(--border))', borderRadius: 4, fontSize: 11, textAlign: 'right' }}
              />
              <button
                className="bb-row"
                style={{ fontSize: 10, padding: '2px 8px', color: 'hsl(var(--primary))' }}
                onClick={() => {
                  const v = Number(bulk[cat.categorie]);
                  if (!isNaN(v)) setPrices(cat.articles.map((a) => a.normId), v);
                }}
                title="Apply price to all articles in this category"
              >
                apply to all
              </button>
            </span>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ color: 'hsl(var(--muted-foreground))', fontSize: 10 }}>
                <th style={{ textAlign: 'left', padding: '4px 10px' }}>Article</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Unit</th>
                <th style={{ textAlign: 'right', padding: '4px 10px' }}>Unit price ({CURRENCY}/unit)</th>
              </tr>
            </thead>
            <tbody>
              {cat.articles.map((a) => (
                <tr key={a.normId} style={{ borderTop: '1px solid hsl(var(--border))' }}>
                  <td style={{ padding: '4px 10px' }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'hsl(var(--primary))' }}>{a.article.symbol}</span>
                    <span style={{ marginLeft: 6 }}>{a.article.denumire}</span>
                    {(() => {
                      const c = PRETURI_DEFAULT_RO[a.normId];
                      if (!c) return null;
                      return (
                        <div style={{ fontSize: 9.5, color: 'hsl(var(--muted-foreground))', marginTop: 1 }}>
                          indicative: mat {c.material} + lab {c.manopera} + eq {c.utilaj} + tr {c.transport} ={' '}
                          <strong>{totalPret(c)}</strong>
                        </div>
                      );
                    })()}
                  </td>
                  <td style={{ padding: '4px 6px', color: 'hsl(var(--muted-foreground))' }}>{unitLabel(a.unit)}</td>
                  <td style={{ padding: '4px 10px', textAlign: 'right' }}>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={prices[a.normId] || ''}
                      placeholder="0.00"
                      onChange={(e) => setPrice(a.normId, Number(e.target.value))}
                      style={{ width: 90, padding: '2px 6px', border: '1px solid hsl(var(--border))', borderRadius: 4, fontSize: 12, textAlign: 'right' }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

export { money as formatMoney };
