/**
 * CalcFlowGraph — reprezentarea VIZUALĂ (graf) a unui calcul, pe React Flow, cu
 * FORMULĂ EDITABILĂ. Arată fluxul mărimi de intrare → operație (formulă) → cantitate.
 *
 * Formula din nodul de operație e editabilă (în termeni de simbolurile intrărilor,
 * ex. "A_brut - A_gol"); rezultatul se recalculează live. Editarea e locală
 * (what-if / verificare), nu modifică cifrele din F3.
 */
import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Position, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { unitLabel, evalWithSymbols } from '@/lib/quantityTakeoff';
import type { CalcPadItem } from './CalcPadBlock';

const COL_INPUT = 0;
const COL_OP = 260;
const COL_RESULT = 540;
const ROW_H = 74;

const nodeBase: React.CSSProperties = {
  fontSize: 11,
  borderRadius: 8,
  padding: '6px 10px',
  border: '1px solid #cbd5e1',
  width: 200,
  textAlign: 'center',
  lineHeight: 1.3,
};

interface CalcFlowGraphProps {
  item: CalcPadItem;
  height?: number;
}

export function CalcFlowGraph({ item, height = 210 }: CalcFlowGraphProps) {
  const { trace, article } = item;
  const u = unitLabel(trace.unit);

  const [formula, setFormula] = useState(trace.editableFormula);
  // Resetează formula când se schimbă elementul/articolul.
  useEffect(() => {
    setFormula(trace.editableFormula);
  }, [item.nodeId, item.article.id, trace.editableFormula]);

  const result = useMemo(() => evalWithSymbols(formula, trace.inputs), [formula, trace.inputs]);
  const valid = !Number.isNaN(result);
  const edited = formula.trim() !== trace.editableFormula.trim();

  const { nodes, edges } = useMemo(() => {
    const ns: Node[] = [];
    const es: Edge[] = [];
    const inputs = trace.inputs;
    const midY = ((inputs.length - 1) * ROW_H) / 2;

    inputs.forEach((inp, i) => {
      const id = `in-${inp.key}`;
      ns.push({
        id,
        position: { x: COL_INPUT, y: i * ROW_H },
        data: {
          label: (
            <div>
              <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{inp.symbol}</div>
              <div style={{ fontVariantNumeric: 'tabular-nums' }}>{inp.value.toFixed(2)} {inp.unit}</div>
              <div style={{ fontSize: 9, color: '#64748b' }}>{inp.label}</div>
            </div>
          ),
        },
        style: { ...nodeBase, background: '#f8fafc' },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      });
      es.push({ id: `e-${id}-op`, source: id, target: 'op' });
    });

    // Nodul de operație — formulă EDITABILĂ.
    ns.push({
      id: 'op',
      position: { x: COL_OP, y: Math.max(0, midY) },
      data: {
        label: (
          <div onPointerDown={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 9, color: '#64748b', marginBottom: 2 }}>Formula (editable)</div>
            <input
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              spellCheck={false}
              style={{
                width: '100%', fontFamily: 'monospace', fontSize: 12, textAlign: 'center',
                border: `1px solid ${valid ? '#93c5fd' : '#f87171'}`, borderRadius: 4, padding: '3px 4px',
                background: valid ? '#fff' : '#fef2f2',
              }}
            />
            <div style={{ fontSize: 8.5, color: '#94a3b8', marginTop: 3 }}>
              vars: {trace.inputs.map((i) => i.symbol).join(', ') || '—'}
            </div>
          </div>
        ),
      },
      style: { ...nodeBase, background: '#eff6ff', borderColor: '#93c5fd', width: 230 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });

    ns.push({
      id: 'result',
      position: { x: COL_RESULT, y: Math.max(0, midY) },
      data: {
        label: (
          <div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1d4ed8' }}>{article.symbol}</div>
            <div style={{ fontWeight: 700, color: valid ? '#0f172a' : '#dc2626' }}>
              {valid ? `${result.toFixed(2)} ${u}` : 'eroare'}
            </div>
            {edited && valid && (
              <div style={{ fontSize: 8.5, color: '#b45309' }}>orig: {trace.result.toFixed(2)}</div>
            )}
            <div style={{ fontSize: 9, color: '#64748b' }}>{article.denumire}</div>
          </div>
        ),
      },
      style: { ...nodeBase, background: '#eef2ff', borderColor: '#818cf8' },
      targetPosition: Position.Left,
    });
    es.push({ id: 'e-op-result', source: 'op', target: 'result', animated: true });

    return { nodes: ns, edges: es };
  }, [trace, formula, valid, edited, result, article, u]);

  return (
    <div style={{ height, border: '1px solid hsl(var(--border))', borderRadius: 8, overflow: 'hidden', background: 'hsl(var(--card, var(--background)))' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background gap={16} color="hsl(var(--border))" />
      </ReactFlow>
    </div>
  );
}
