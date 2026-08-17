/**
 * CalcPadBlock — randează urma de calcul (`CalcTrace`) a unei cantități ca o fișă
 * de calcul inginerească (stil CalcPad): formulă simbolică → valori substituite →
 * rezultat, plus mărimile de intrare cu sursa lor geometrică și articolul de normă.
 */
import { useState } from 'react';
import type { CalcTrace } from '@/lib/quantityTakeoff';
import { unitLabel } from '@/lib/quantityTakeoff';
import type { NormArticle } from '@/lib/norms';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { CalcFlowGraph } from './CalcFlowGraph';
import { Calc2DInset } from './Calc2DInset';

export interface CalcPadItem {
  trace: CalcTrace;
  article: NormArticle;
  nodeName: string;
  nodeId: string;
  elementTypeId: string;
}

interface CalcPadBlockProps {
  item: CalcPadItem;
  /** Evidențiază în graf / 3D nodul acestui calcul. */
  onFocusNode?: (nodeId: string) => void;
  /** Graful complet — necesar pentru insetul de plan 2D. */
  nodes?: BubbleGraphNode[];
  edges?: BubbleGraphEdge[];
}

export function CalcPadBlock({ item, onFocusNode, nodes, edges }: CalcPadBlockProps) {
  const { trace, article, nodeName, nodeId, elementTypeId } = item;
  const u = unitLabel(trace.unit);
  const [showGraph, setShowGraph] = useState(false);
  const [show2D, setShow2D] = useState(false);
  const canShow2D = !!nodes && !!edges;

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
      {/* Antet: articol + element */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'hsl(var(--primary))' }}>
            {article.symbol}
          </span>
          <span style={{ marginLeft: 6, color: 'hsl(var(--foreground))' }}>{article.denumire}</span>
        </div>
        <button
          onClick={() => onFocusNode?.(nodeId)}
          title="Highlight in graph / 3D"
          style={{
            flexShrink: 0,
            fontSize: 10.5,
            fontFamily: 'monospace',
            color: 'hsl(var(--muted-foreground))',
            background: 'none',
            border: 'none',
            cursor: onFocusNode ? 'pointer' : 'default',
            padding: 0,
            textDecoration: onFocusNode ? 'underline' : 'none',
          }}
        >
          {nodeName} · {elementTypeId} →
        </button>
      </div>

      {/* Calcul: simbolic → substituit → rezultat */}
      <div style={{ fontFamily: 'ui-monospace, monospace', lineHeight: 1.7 }}>
        <div style={{ color: 'hsl(var(--muted-foreground))' }}>{trace.symbolic}</div>
        <div style={{ color: 'hsl(var(--foreground))' }}>{trace.substituted}</div>
        <div style={{ marginTop: 2, fontWeight: 700, fontSize: 13 }}>
          Q = {trace.result.toFixed(2)} {u}
        </div>
      </div>

      {/* Mărimi de intrare (sursă geometrică) */}
      {trace.inputs.length > 0 && (
        <table style={{ marginTop: 8, width: '100%', borderCollapse: 'collapse', fontSize: 10.5 }}>
          <tbody>
            {trace.inputs.map((inp) => (
              <tr key={inp.key} style={{ color: 'hsl(var(--muted-foreground))' }}>
                <td style={{ fontFamily: 'monospace', padding: '1px 6px 1px 0', whiteSpace: 'nowrap' }}>
                  {inp.symbol}
                </td>
                <td style={{ padding: '1px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {inp.value.toFixed(2)} {inp.unit}
                </td>
                <td style={{ padding: '1px 0' }}>{inp.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Nota de sursă + toggle graf de calcul */}
      <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 9.5, color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' }}>
          {trace.sourceLabel}
        </span>
        <span style={{ display: 'flex', gap: 10 }}>
          {canShow2D && (
            <button
              onClick={() => setShow2D((p) => !p)}
              style={{ fontSize: 10, color: 'hsl(var(--primary))', background: 'none', border: 'none', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' }}
            >
              {show2D ? '▾ hide plan' : '▸ plan 2D'}
            </button>
          )}
          <button
            onClick={() => setShowGraph((p) => !p)}
            style={{ fontSize: 10, color: 'hsl(var(--primary))', background: 'none', border: 'none', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' }}
          >
            {showGraph ? '▾ hide graph' : '▸ calc graph'}
          </button>
        </span>
      </div>

      {show2D && canShow2D && (
        <div style={{ marginTop: 8 }}>
          {/* Tot planul în albastru, elementul curent evidențiat roșu. */}
          <Calc2DInset nodes={nodes!} edges={edges!} nodeIds={[nodeId]} fullContext />
        </div>
      )}

      {showGraph && (
        <div style={{ marginTop: 8 }}>
          <CalcFlowGraph item={item} />
        </div>
      )}
    </div>
  );
}
