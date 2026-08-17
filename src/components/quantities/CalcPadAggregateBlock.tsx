/**
 * CalcPadAggregateBlock — fișă de calcul pentru un articol de normă, cu elementele
 * de același tip ÎNSUMATE pe etaj. Afișează cantitatea totală + suma pe elemente,
 * cu defalcare opțională pe fiecare element (formulă individuală) și un plan 2D
 * cu toate elementele grupului.
 */
import { useState } from 'react';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { unitLabel, type ArticleGroup } from '@/lib/quantityTakeoff';
import { usePrices, CURRENCY } from '@/store/priceStore';
import { CalcPadBlock, type CalcPadItem } from './CalcPadBlock';
import { Calc2DInset } from './Calc2DInset';

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface CalcPadAggregateBlockProps {
  group: ArticleGroup;
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  onHighlightNodes: (nodeIds: string[]) => void;
}

const MAX_TERMS = 12;

export function CalcPadAggregateBlock({ group, nodes, edges, onHighlightNodes }: CalcPadAggregateBlockProps) {
  const [showElements, setShowElements] = useState(false);
  const [show2D, setShow2D] = useState(false);
  const u = unitLabel(group.unit);
  const nodeIds = group.elements.map((e) => e.nodeId);
  const n = group.elements.length;

  const unitPrice = usePrices((s) => s.prices[group.normId] ?? 0);
  const setPrice = usePrices((s) => s.setPrice);
  const totalPrice = group.total * unitPrice;

  // Suma pe elemente (trunchiată dacă sunt prea multe).
  const terms = group.elements.map((e) => e.quantity.toFixed(2));
  const sumExpr =
    terms.length <= MAX_TERMS
      ? terms.join(' + ')
      : `${terms.slice(0, MAX_TERMS).join(' + ')} + … (${terms.length - MAX_TERMS} more)`;

  return (
    <div
      style={{
        border: '1px solid hsl(var(--border))',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 8,
        background: 'hsl(var(--background))',
        fontSize: 12,
      }}
    >
      {/* Antet: articol + nr. elemente */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'hsl(var(--primary))' }}>{group.article.symbol}</span>
          <span style={{ marginLeft: 6 }}>{group.article.denumire}</span>
        </div>
        <button
          onClick={() => onHighlightNodes(nodeIds)}
          title="Highlight all elements in this group"
          style={{ flexShrink: 0, fontSize: 10.5, fontFamily: 'monospace', color: 'hsl(var(--muted-foreground))', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
        >
          {n} {n === 1 ? 'element' : 'elements'} →
        </button>
      </div>

      {/* Sum → total */}
      <div style={{ fontFamily: 'ui-monospace, monospace', lineHeight: 1.7 }}>
        <div style={{ color: 'hsl(var(--muted-foreground))' }}>Q = Σ Qᵢ (n = {n})</div>
        {n > 1 && <div style={{ color: 'hsl(var(--foreground))', wordBreak: 'break-word' }}>Q = {sumExpr}</div>}
        <div style={{ marginTop: 2, fontWeight: 700, fontSize: 13 }}>Q = {group.total.toFixed(2)} {u}</div>
      </div>

      {/* Unit price (editable) + total price */}
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 6, borderTop: '1px dashed hsl(var(--border))' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>
          Unit price:
          <input
            type="number"
            min={0}
            step="0.01"
            value={unitPrice || ''}
            placeholder="0.00"
            onChange={(e) => setPrice(group.normId, Number(e.target.value))}
            style={{ width: 84, padding: '2px 6px', border: '1px solid hsl(var(--border))', borderRadius: 4, fontSize: 12, textAlign: 'right' }}
          />
          <span>{CURRENCY}/{u}</span>
        </label>
        <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: 13, color: 'hsl(var(--primary))', fontVariantNumeric: 'tabular-nums' }}>
          {money(totalPrice)} {CURRENCY}
        </span>
      </div>

      {/* Acțiuni */}
      <div style={{ marginTop: 6, display: 'flex', gap: 12 }}>
        <button onClick={() => setShow2D((p) => !p)} style={linkBtn}>
          {show2D ? '▾ hide plan' : '▸ plan 2D'}
        </button>
        <button onClick={() => setShowElements((p) => !p)} style={linkBtn}>
          {showElements ? '▾ hide detail' : `▸ per-element detail (${n})`}
        </button>
      </div>

      {show2D && (
        <div style={{ marginTop: 8 }}>
          {/* Tot planul albastru, elementele grupului evidențiate roșu. */}
          <Calc2DInset nodes={nodes} edges={edges} nodeIds={nodeIds} fullContext />
        </div>
      )}

      {showElements && (
        <div style={{ marginTop: 8, paddingLeft: 8, borderLeft: '2px solid hsl(var(--border))' }}>
          {group.elements.map((el, i) => {
            const item: CalcPadItem = {
              trace: el.trace,
              article: group.article,
              nodeName: el.nodeName,
              nodeId: el.nodeId,
              elementTypeId: el.elementTypeId,
            };
            return (
              <CalcPadBlock
                key={`${el.nodeId}-${i}`}
                item={item}
                nodes={nodes}
                edges={edges}
                onFocusNode={(id) => onHighlightNodes([id])}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  fontSize: 10,
  color: 'hsl(var(--primary))',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  whiteSpace: 'nowrap',
};
