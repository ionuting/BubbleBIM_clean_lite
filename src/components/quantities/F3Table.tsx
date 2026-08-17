import type { F3Row } from '@/lib/norms';

interface F3TableProps {
  rows: F3Row[];
  selectedRowKey: string | null;
  onSelectRow: (row: F3Row | null) => void;
  filterCategorie: string;
  filterStorey: string;
}

export function F3Table({
  rows,
  selectedRowKey,
  onSelectRow,
  filterCategorie,
  filterStorey,
}: F3TableProps) {
  const filtered = rows.filter((r) => {
    if (filterCategorie && r.categorie !== filterCategorie) return false;
    if (filterStorey && r.storeyId !== filterStorey) return false;
    return true;
  });

  if (filtered.length === 0) {
    return (
      <div style={{ padding: '12px 10px', fontSize: 11, color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' }}>
        No bill-of-quantities articles yet. Add structural elements to the graph.
      </div>
    );
  }

  const rowKey = (r: F3Row) => `${r.normId}::${r.storeyId}`;

  return (
    <div style={{ overflow: 'auto', maxHeight: 360 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10.5 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
            <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 600 }}>No.</th>
            <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 600 }}>Symbol</th>
            <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 600 }}>Description</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600 }}>Unit</th>
            <th style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 600 }}>Qty</th>
            <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 600 }}>Storey</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => {
            const key = rowKey(r);
            const isSelected = selectedRowKey === key;
            return (
              <tr
                key={key}
                onClick={() => onSelectRow(isSelected ? null : r)}
                style={{
                  cursor: 'pointer',
                  borderBottom: '1px solid hsl(var(--border) / 0.5)',
                  background: isSelected ? 'hsl(var(--primary) / 0.12)' : 'transparent',
                }}
                title={`${r.categorie} — ${r.nodeIds.length} element(e)`}
              >
                <td style={{ padding: '4px 6px', color: 'hsl(var(--muted-foreground))' }}>{r.nrCrt}</td>
                <td style={{ padding: '4px 6px', fontFamily: 'monospace', fontSize: 9.5 }}>{r.symbol}</td>
                <td style={{ padding: '4px 6px', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.denumire}
                </td>
                <td style={{ padding: '4px 6px', textAlign: 'center' }}>{r.unit}</td>
                <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace' }}>
                  {r.quantity.toFixed(2)}
                </td>
                <td style={{ padding: '4px 6px', fontSize: 9.5, color: 'hsl(var(--muted-foreground))' }}>
                  {r.storeyName}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
