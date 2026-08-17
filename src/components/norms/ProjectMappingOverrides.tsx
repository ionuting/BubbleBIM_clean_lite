/**
 * ProjectMappingOverrides.tsx — editor pentru suprascrierile de mapare la nivel
 * de PROIECT (salvate în `.bbim`, nu în librăria globală).
 *
 * Cazul principal: un tip BIM nemapat global capătă aici o mapare proprie
 * proiectului, fără să atingi fișierele MD comune. Fiecare rând = un output;
 * rândurile pe aceeași cheie (nodeType, elementType) se grupează într-o singură
 * regulă de motor la scriere.
 */
import { useMemo } from 'react';
import { useMappingOverrides } from '@/store/mappingOverrideStore';
import { getCompiledCatalog } from '@/lib/norms/catalogCompiled';
import { elementTypesFor, MATERIAL_SYNONYMS } from '@/lib/norms/library/compileLibrary';
import { VALID_MEASURES } from '@/lib/norms/library/types';
import { ELEMENT_LIBRARY } from '@/lib/elementLibrary';
import type { NormMappingRule, NormMappingOutput, MeasureKey } from '@/lib/norms/types';

const NODE_TYPES = [...Object.keys(ELEMENT_LIBRARY), 'room', 'ax', 'space', 'zone'];
const MATERIAL_KEYS = Object.keys(MATERIAL_SYNONYMS);

const S = {
  bg: 'var(--background)', fg: 'var(--foreground)', border: 'var(--border)',
  primary: 'var(--primary)', accent: 'var(--accent)',
};

/** O linie de override în UI = un output pe o cheie de regulă. */
interface Row {
  nodeType: string;
  elementType: string;
  materialFilter?: string;
  normId: string;
  measure: MeasureKey;
  formula?: string;
  netOfOpenings?: boolean;
}

const ruleKey = (r: { nodeType: string; elementType: string; materialFilter?: string }) =>
  `${r.nodeType}|${r.elementType}|${r.materialFilter ?? ''}`;

function flatten(rules: NormMappingRule[]): Row[] {
  const rows: Row[] = [];
  for (const r of rules) {
    for (const o of r.outputs) {
      rows.push({
        nodeType: r.nodeType,
        elementType: r.elementTypeId,
        materialFilter: r.materialFilter,
        normId: o.normId,
        measure: o.measure,
        formula: o.formula,
        netOfOpenings: o.netOfOpenings,
      });
    }
  }
  return rows;
}

function build(rows: Row[]): NormMappingRule[] {
  const byKey = new Map<string, NormMappingRule>();
  for (const row of rows) {
    const key = ruleKey(row);
    const output: NormMappingOutput = {
      normId: row.normId,
      measure: row.measure,
      ...(row.formula ? { formula: row.formula } : {}),
      ...(row.netOfOpenings ? { netOfOpenings: true } : {}),
    };
    const existing = byKey.get(key);
    if (existing) existing.outputs.push(output);
    else byKey.set(key, {
      nodeType: row.nodeType,
      elementTypeId: row.elementType,
      ...(row.materialFilter ? { materialFilter: row.materialFilter } : {}),
      outputs: [output],
    });
  }
  return [...byKey.values()];
}

export function ProjectMappingOverrides() {
  const rules = useMappingOverrides((s) => s.rules);
  const setRules = useMappingOverrides((s) => s.setRules);
  const clear = useMappingOverrides((s) => s.clear);

  const rows = useMemo(() => flatten(rules), [rules]);
  const base = useMemo(() => getCompiledCatalog(), []);
  const articles = base.articles;

  // Tipuri BIM fără mapare în catalogul de bază (hint pentru completare rapidă).
  const unmapped = useMemo(() => {
    const mapped = new Set<string>();
    for (const r of base.mapping) {
      if (r.elementTypeId === '*') for (const t of elementTypesFor(r.nodeType)) mapped.add(`${r.nodeType}/${t.id}`);
      else mapped.add(`${r.nodeType}/${r.elementTypeId}`);
    }
    const all: string[] = [];
    for (const nt of Object.keys(ELEMENT_LIBRARY)) for (const t of elementTypesFor(nt)) all.push(`${nt}/${t.id}`);
    return all.filter((k) => !mapped.has(k));
  }, [base]);

  const commit = (next: Row[]) => setRules(build(next));
  const patch = (i: number, p: Partial<Row>) => commit(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const add = (seed?: Partial<Row>) =>
    commit([...rows, { nodeType: 'wall', elementType: '*', normId: articles[0]?.id ?? '', measure: 'area', ...seed }]);
  const del = (i: number) => commit(rows.filter((_, j) => j !== i));

  const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', fontWeight: 600, fontSize: 11, opacity: 0.7, borderBottom: `1px solid ${S.border}`, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '2px 4px', borderBottom: `1px solid ${S.border}` };
  const box: React.CSSProperties = { background: S.bg, color: S.fg, border: `1px solid ${S.border}`, borderRadius: 4, padding: '4px 6px', font: 'inherit' };
  const btn: React.CSSProperties = { background: S.bg, color: S.fg, border: `1px solid ${S.border}`, borderRadius: 6, padding: '6px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>
        Mapările de aici se salvează în proiect (<code>.bbim</code>) și se aplică peste librăria globală:
        pe aceeași cheie (nodeType + elementType) <strong>înlocuiesc</strong> regula globală, altfel o <strong>adaugă</strong>.
        Librăria comună rămâne neschimbată.
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={th}>nodeType</th><th style={th}>elementType</th><th style={th}>material</th>
            <th style={th}>Articol</th><th style={th}>măsură</th><th style={th}>formulă</th><th style={th}>net.goluri</th><th style={th} />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={8} style={{ ...td, opacity: 0.5, padding: 12 }}>Nicio suprascriere. Adaugă una mai jos sau dintr-un tip nemapat.</td></tr>
          )}
          {rows.map((r, i) => {
            const types = elementTypesFor(r.nodeType);
            return (
              <tr key={i}>
                <td style={td}>
                  <select style={{ ...box, width: 96 }} value={r.nodeType}
                    onChange={(e) => patch(i, { nodeType: e.target.value, elementType: '*', materialFilter: undefined })}>
                    {NODE_TYPES.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </td>
                <td style={td}>
                  <select style={{ ...box, width: 108 }} value={r.elementType} onChange={(e) => patch(i, { elementType: e.target.value })}>
                    <option value="*">* (oricare)</option>
                    {types.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
                  </select>
                </td>
                <td style={td}>
                  <select style={{ ...box, width: 88 }} value={r.materialFilter ?? ''} onChange={(e) => patch(i, { materialFilter: e.target.value || undefined })}>
                    <option value="">—</option>
                    {MATERIAL_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </td>
                <td style={td}>
                  <select style={{ ...box, minWidth: 150, maxWidth: 240 }} value={r.normId} onChange={(e) => patch(i, { normId: e.target.value })}>
                    {!articles.some((a) => a.id === r.normId) && r.normId && <option value={r.normId}>{r.normId}</option>}
                    {articles.map((a) => <option key={a.id} value={a.id}>{a.symbol} · {a.denumire.slice(0, 40)}</option>)}
                  </select>
                </td>
                <td style={td}>
                  <select style={{ ...box, width: 100 }} value={r.measure} onChange={(e) => patch(i, { measure: e.target.value as MeasureKey })}>
                    {VALID_MEASURES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </td>
                <td style={td}>
                  <input style={{ ...box, minWidth: 140 }} value={r.formula ?? ''} placeholder={r.measure === 'formula' ? 'length_m*height_m' : ''}
                    onChange={(e) => patch(i, { formula: e.target.value || undefined })} />
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <input type="checkbox" checked={!!r.netOfOpenings} onChange={(e) => patch(i, { netOfOpenings: e.target.checked || undefined })} />
                </td>
                <td style={td}><button style={{ ...btn, padding: '3px 7px' }} onClick={() => del(i)} title="Șterge">✕</button></td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={8} style={{ padding: 8, display: 'flex', gap: 8 }}>
              <button style={btn} onClick={() => add()}>+ Suprascriere</button>
              {rows.length > 0 && <button style={btn} onClick={() => clear()}>Golește tot</button>}
            </td>
          </tr>
        </tfoot>
      </table>

      {unmapped.length > 0 && (
        <div style={{ border: `1px solid ${S.border}`, borderRadius: 10, padding: 12, background: S.accent }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Tipuri nemapate global ({unmapped.length}) — click pentru a mapa în acest proiect</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 140, overflowY: 'auto' }}>
            {unmapped.map((k) => {
              const [nodeType, elementType] = k.split('/');
              return (
                <button key={k} style={{ ...btn, padding: '3px 8px', fontFamily: 'monospace', fontSize: 11 }}
                  onClick={() => add({ nodeType, elementType })}>{k} +</button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default ProjectMappingOverrides;
