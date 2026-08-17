import { useMemo, useState, useEffect, useCallback } from 'react';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { computeFullTakeoff } from '@/lib/quantityTakeoff';
import { downloadF3Csv, downloadTakeoffDetailCsv } from '@/lib/quantityTakeoff/f3Export';
import type { F3Row } from '@/lib/norms';
import { getActiveCatalog } from '@/lib/norms';
import { F3Table } from './F3Table';
import { CalcReportPanel } from './CalcReportPanel';

interface QuantitiesPanelProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  projectName: string;
  onHighlightNodes: (nodeIds: string[]) => void;
}

export function QuantitiesPanel({
  nodes,
  edges,
  projectName,
  onHighlightNodes,
}: QuantitiesPanelProps) {
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [filterCategorie, setFilterCategorie] = useState('');
  const [filterStorey, setFilterStorey] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<'table' | 'report'>('table');

  const result = useMemo(
    () => computeFullTakeoff(nodes, edges),
    [nodes, edges],
  );

  const categories = useMemo(
    () => [...new Set(result.f3.map((r) => r.categorie))].sort(),
    [result.f3],
  );

  const storeys = useMemo(
    () => [...new Set(result.f3.map((r) => ({ id: r.storeyId, name: r.storeyName })))]
      .filter((s) => s.id !== 'unknown'),
    [result.f3],
  );

  const selectedRow = useMemo(() => {
    if (!selectedRowKey) return null;
    return result.f3.find((r) => `${r.normId}::${r.storeyId}` === selectedRowKey) ?? null;
  }, [selectedRowKey, result.f3]);

  useEffect(() => {
    onHighlightNodes(selectedRow?.nodeIds ?? []);
  }, [selectedRow, onHighlightNodes]);

  const handleSelectRow = useCallback((row: F3Row | null) => {
    setSelectedRowKey(row ? `${row.normId}::${row.storeyId}` : null);
  }, []);

  const detailLines = selectedRow
    ? result.lines.filter((l) => l.normId === selectedRow.normId && l.storeyId === selectedRow.storeyId)
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Mode toggle: F3 table ⟷ calculation memo */}
      <div style={{ display: 'flex', gap: 4, padding: '4px 8px 0' }}>
        {(['table', 'report'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              flex: 1,
              fontSize: 10.5,
              padding: '4px 6px',
              borderRadius: 6,
              border: '1px solid hsl(var(--border))',
              cursor: 'pointer',
              background: mode === m ? 'hsl(var(--primary))' : 'transparent',
              color: mode === m ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
            }}
          >
            {m === 'table' ? 'F3 table' : 'Calculation memo'}
          </button>
        ))}
      </div>

      {mode === 'report' && (
        <CalcReportPanel
          nodes={nodes}
          edges={edges}
          projectName={projectName}
          onHighlightNodes={onHighlightNodes}
        />
      )}

      {mode === 'table' && (
        <>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 4, padding: '0 8px', flexWrap: 'wrap' }}>
        <select
          value={filterCategorie}
          onChange={(e) => setFilterCategorie(e.target.value)}
          style={{ fontSize: 10, padding: '2px 4px', flex: 1, minWidth: 80 }}
          title="Category filter"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={filterStorey}
          onChange={(e) => setFilterStorey(e.target.value)}
          style={{ fontSize: 10, padding: '2px 4px', flex: 1, minWidth: 80 }}
          title="Storey filter"
        >
          <option value="">All storeys</option>
          {storeys.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {/* Summary */}
      <div style={{ padding: '0 10px', fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
        {result.f3.length} articles · {result.lines.length} detail lines
        <br />
        <span style={{ fontSize: 9 }}>Catalog: {getActiveCatalog().version}</span>
      </div>

      <F3Table
        rows={result.f3}
        selectedRowKey={selectedRowKey}
        onSelectRow={handleSelectRow}
        filterCategorie={filterCategorie}
        filterStorey={filterStorey}
      />

      {/* Detail breakdown */}
      {selectedRow && (
        <div style={{ padding: '4px 10px', borderTop: '1px solid hsl(var(--border))' }}>
          <button
            onClick={() => setExpanded((p) => !p)}
            style={{ fontSize: 10, color: 'hsl(var(--primary))', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            {expanded ? '▼' : '▶'} Takeoff detail ({detailLines.length})
          </button>
          {expanded && (
            <ul style={{ margin: '4px 0 0', padding: '0 0 0 14px', fontSize: 9.5, lineHeight: 1.5 }}>
              {detailLines.map((l) => (
                <li key={`${l.nodeId}-${l.normId}`}>
                  <span style={{ fontFamily: 'monospace' }}>{l.nodeName}</span>
                  {' '}({l.elementTypeId}): {l.quantity.toFixed(2)} {l.unit}
                  <span style={{ color: 'hsl(var(--muted-foreground))' }}> — {l.source}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Export buttons */}
      <div style={{ display: 'flex', gap: 4, padding: '4px 8px 8px' }}>
        <button
          className="bb-row"
          style={{ flex: 1, justifyContent: 'center', fontSize: 10.5, color: 'hsl(var(--primary))' }}
          onClick={() => downloadF3Csv(result.f3, projectName)}
          disabled={result.f3.length === 0}
          title="Export F3 schedule (CSV)"
        >
          ↓ F3 CSV
        </button>
        <button
          className="bb-row"
          style={{ flex: 1, justifyContent: 'center', fontSize: 10.5, color: 'hsl(var(--muted-foreground))' }}
          onClick={() => downloadTakeoffDetailCsv(result.lines, projectName)}
          disabled={result.lines.length === 0}
          title="Export takeoff detail"
        >
          ↓ Detail
        </button>
      </div>
        </>
      )}
    </div>
  );
}
