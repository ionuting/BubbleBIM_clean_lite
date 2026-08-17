/**
 * CalcReportPanel — memoriul de calcul al cantităților: grupează pe capitol → etaj
 * → articol de normă, ÎNSUMÂND elementele de același tip (ca Lista F3). Fiecare grup
 * afișează cantitatea totală, cu defalcare opțională pe elemente.
 *
 * Cifrele provin din `aggregateCalcGroups` (identice cu tabelul F3).
 */
import { useMemo } from 'react';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { aggregateCalcGroups, downloadCalcReportHtml, type CapitolGroup } from '@/lib/quantityTakeoff';
import { getActiveCatalog } from '@/lib/norms';
import { usePrices, CURRENCY } from '@/store/priceStore';
import { CalcPadAggregateBlock } from './CalcPadAggregateBlock';

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function capitolTotal(cap: CapitolGroup, prices: Record<string, number>): number {
  let t = 0;
  for (const s of cap.storeys) for (const ag of s.articles) t += ag.total * (prices[ag.normId] ?? 0);
  return t;
}

interface CalcReportPanelProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  projectName: string;
  onHighlightNodes: (nodeIds: string[]) => void;
}

export function CalcReportPanel({
  nodes,
  edges,
  projectName,
  onHighlightNodes,
}: CalcReportPanelProps) {
  const groups = useMemo(() => aggregateCalcGroups(nodes, edges), [nodes, edges]);
  const prices = usePrices((s) => s.prices);

  const totalArticole = groups.reduce((n, g) => n + g.articleCount, 0);
  const grandTotal = useMemo(() => groups.reduce((t, g) => t + capitolTotal(g, prices), 0), [groups, prices]);

  if (totalArticole === 0) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: 'hsl(var(--muted-foreground))', textAlign: 'center' }}>
        No calculations to show. Add elements with a norm mapping to the graph.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 8px 12px' }}>
      {/* Report header */}
      <div style={{ padding: '4px 4px 8px', borderBottom: '1px solid hsl(var(--border))' }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Quantity calculation memo</div>
        <div style={{ fontSize: 10.5, color: 'hsl(var(--muted-foreground))' }}>
          {projectName} · {totalArticole} articles · catalog {getActiveCatalog().version}
        </div>
        <div style={{ marginTop: 4, fontSize: 14, fontWeight: 800, color: 'hsl(var(--primary))' }}>
          Grand total: {money(grandTotal)} {CURRENCY}
        </div>
        <button
          onClick={() => downloadCalcReportHtml(nodes, edges, projectName)}
          className="bb-row"
          style={{ marginTop: 6, width: '100%', justifyContent: 'center', fontSize: 10.5, color: 'hsl(var(--primary))' }}
          title="Export calculation memo (self-contained HTML)"
        >
          ↓ Export HTML report
        </button>
      </div>

      {groups.map((g) => (
        <section key={g.capitol}>
          <h3 style={{ fontSize: 12, fontWeight: 700, margin: '8px 0 4px', color: 'hsl(var(--foreground))', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span>{g.capitol}</span>
            <span style={{ fontSize: 11, color: 'hsl(var(--primary))' }}>{money(capitolTotal(g, prices))} {CURRENCY}</span>
          </h3>
          {g.storeys.map((s) => (
            <div key={s.storeyId} style={{ marginBottom: 6 }}>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  color: 'hsl(var(--muted-foreground))',
                  margin: '4px 0',
                }}
              >
                {s.storeyName}
              </div>
              {s.articles.map((ag) => (
                <CalcPadAggregateBlock
                  key={`${ag.normId}-${ag.storeyId}`}
                  group={ag}
                  nodes={nodes}
                  edges={edges}
                  onHighlightNodes={onHighlightNodes}
                />
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
