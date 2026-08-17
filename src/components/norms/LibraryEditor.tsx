/**
 * LibraryEditor.tsx — editor vizual pentru librăria de categorii de lucrări.
 *
 * Editează în memorie forma librăriei (articole + mapări BIM + prețuri), o
 * recompilează și o revalidează la fiecare tastă, și arată un tablou de acoperire
 * (câte tipuri BIM au mapare, ce articole rămân nefolosite). Exportul produce
 * fișierele MD editabile + JSON-ul compilat pe care le consumă runtime-ul.
 *
 * Pur pe surse comune (`@/lib/norms/library/*` + `elementLibrary`); nu atinge
 * `quantityTakeoff`, deci intră neschimbat și în clean-lite (unde takeoff-ul e
 * stubuit). În clean-lite montăm DOAR editorul, nu memoriul de calcul / costuri.
 */
import { useMemo, useState } from 'react';
import { loadBundledLibrary } from '@/lib/norms/library/loadBundledLibrary';
import { compileLibrary, MATERIAL_SYNONYMS, elementTypesFor } from '@/lib/norms/library/compileLibrary';
import { validateLibrary } from '@/lib/norms/library/validateLibrary';
import { serializeLibrary } from '@/lib/norms/library/serializeLibrary';
import { compiledUnitPrices } from '@/lib/norms/library/compileLibrary';
import { VALID_UNITS, VALID_MEASURES } from '@/lib/norms/library/types';
import type {
  LibraryArticle,
  LibraryCategory,
  LibraryMapping,
  NormLibrary,
  PriceComponents,
} from '@/lib/norms/library/types';
import { ELEMENT_LIBRARY } from '@/lib/elementLibrary';
import { ProjectMappingOverrides } from './ProjectMappingOverrides';

const NODE_TYPES = [...Object.keys(ELEMENT_LIBRARY), 'room', 'ax', 'space', 'zone'];
const MATERIAL_KEYS = Object.keys(MATERIAL_SYNONYMS);
const EMPTY_PRICE: PriceComponents = { material: 0, manopera: 0, utilaj: 0, transport: 0 };

// ── tokens (doar cele care există în tema) ──────────────────────────────────
const S = {
  bg: 'var(--background)',
  fg: 'var(--foreground)',
  muted: 'var(--muted)',
  border: 'var(--border)',
  primary: 'var(--primary)',
  accent: 'var(--accent)',
};

function download(name: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface LibraryEditorProps {
  onClose: () => void;
}

export function LibraryEditor({ onClose }: LibraryEditorProps) {
  const initial = useMemo(() => loadBundledLibrary(), []);
  const [lib, setLib] = useState<NormLibrary>(initial.library);
  const [activeIdx, setActiveIdx] = useState(0);
  const [tab, setTab] = useState<'articles' | 'mappings' | 'coverage'>('articles');
  const [mode, setMode] = useState<'library' | 'project'>('library');

  const compiled = useMemo(() => compileLibrary(lib), [lib]);
  const validation = useMemo(() => validateLibrary(lib, compiled), [lib, compiled]);
  const errors = validation.issues.filter((i) => i.severity === 'error');
  const warnings = validation.issues.filter((i) => i.severity === 'warning');

  const cat = lib.categories[activeIdx];

  // ── mutatori imutabili ────────────────────────────────────────────────────
  const patchCategory = (idx: number, fn: (c: LibraryCategory) => LibraryCategory) =>
    setLib((l) => ({ ...l, categories: l.categories.map((c, i) => (i === idx ? fn(c) : c)) }));

  const patchArticle = (ai: number, patch: Partial<LibraryArticle>) =>
    patchCategory(activeIdx, (c) => ({
      ...c,
      articles: c.articles.map((a, i) => (i === ai ? { ...a, ...patch } : a)),
    }));

  const patchPrice = (ai: number, key: keyof PriceComponents, value: number) =>
    patchCategory(activeIdx, (c) => ({
      ...c,
      articles: c.articles.map((a, i) =>
        i === ai ? { ...a, price: { ...(a.price ?? EMPTY_PRICE), [key]: value } } : a,
      ),
    }));

  const addArticle = () =>
    patchCategory(activeIdx, (c) => ({
      ...c,
      articles: [...c.articles, { normId: `NEW_${c.articles.length + 1}`, symbol: '', denumire: '', unit: 'buc' }],
    }));

  const delArticle = (ai: number) =>
    patchCategory(activeIdx, (c) => ({ ...c, articles: c.articles.filter((_, i) => i !== ai) }));

  const patchMapping = (mi: number, patch: Partial<LibraryMapping>) =>
    patchCategory(activeIdx, (c) => ({
      ...c,
      mappings: c.mappings.map((m, i) => (i === mi ? { ...m, ...patch } : m)),
    }));

  const addMapping = () =>
    patchCategory(activeIdx, (c) => ({
      ...c,
      mappings: [
        ...c.mappings,
        { normId: c.articles[0]?.normId ?? '', nodeType: 'wall', elementType: '*', measure: 'area' },
      ],
    }));

  const delMapping = (mi: number) =>
    patchCategory(activeIdx, (c) => ({ ...c, mappings: c.mappings.filter((_, i) => i !== mi) }));

  // ── export ────────────────────────────────────────────────────────────────
  const exportJson = () => download('norms.compiled.json', JSON.stringify(compiled, null, 2) + '\n', 'application/json');
  const exportMd = () => {
    const files = serializeLibrary(lib);
    for (const [name, text] of Object.entries(files)) download(name, text, 'text/markdown');
  };

  const { mappedTypeCount, totalTypeCount, unmappedTypes, unusedArticles } = validation.coverage;
  const coveragePct = totalTypeCount ? Math.round((mappedTypeCount / totalTypeCount) * 100) : 0;
  const totalPrice = useMemo(() => {
    const up = compiledUnitPrices(compiled);
    return Object.values(up).reduce((s, v) => s + v, 0);
  }, [compiled]);

  // ── stil helperi ──────────────────────────────────────────────────────────
  const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', fontWeight: 600, fontSize: 11, opacity: 0.7, borderBottom: `1px solid ${S.border}`, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '2px 4px', borderBottom: `1px solid ${S.border}`, verticalAlign: 'middle' };
  const input: React.CSSProperties = { width: '100%', background: 'transparent', color: S.fg, border: `1px solid transparent`, borderRadius: 4, padding: '4px 6px', font: 'inherit' };
  const inputBox: React.CSSProperties = { ...input, border: `1px solid ${S.border}`, background: S.bg };
  const btn: React.CSSProperties = { background: S.bg, color: S.fg, border: `1px solid ${S.border}`, borderRadius: 6, padding: '6px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12 };
  const btnPrimary: React.CSSProperties = { ...btn, background: S.primary, color: S.bg, borderColor: S.primary, fontWeight: 600 };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: 'min(1120px, 96vw)', height: 'min(760px, 94vh)', background: S.bg, color: S.fg, border: `1px solid ${S.border}`, borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 12px 48px rgba(0,0,0,0.5)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${S.border}` }}>
          <strong style={{ fontSize: 14 }}>Librărie categorii de lucrări</strong>
          <span style={{ fontSize: 11, opacity: 0.6 }}>{lib.meta.id} · v{lib.meta.version} · {lib.meta.currency}</span>
          {/* Comutator global ↔ proiect */}
          <div style={{ display: 'flex', gap: 0, marginLeft: 8, border: `1px solid ${S.border}`, borderRadius: 8, overflow: 'hidden' }}>
            {(['library', 'project'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                style={{ background: mode === m ? S.primary : 'transparent', color: mode === m ? S.bg : S.fg, border: 'none', padding: '6px 12px', cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: mode === m ? 600 : 400 }}>
                {m === 'library' ? 'Librărie globală' : 'Overrides proiect'}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {mode === 'library' && (
            <>
              <span style={{ fontSize: 11, color: errors.length ? '#e5484d' : S.fg, opacity: errors.length ? 1 : 0.7 }}>
                {errors.length} erori · {warnings.length} avertismente
              </span>
              <button style={btn} onClick={exportMd} title="Descarcă fișierele .md editabile">Export MD</button>
              <button style={btnPrimary} onClick={exportJson} title="Descarcă JSON-ul compilat (consumat de runtime)">Export JSON</button>
            </>
          )}
          <button style={btn} onClick={onClose} aria-label="Închide">✕</button>
        </div>

        {mode === 'project' ? (
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            <ProjectMappingOverrides />
          </div>
        ) : (
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Sidebar categorii */}
          <div style={{ width: 220, borderRight: `1px solid ${S.border}`, overflowY: 'auto', padding: 8 }}>
            {lib.categories.map((c, i) => {
              const catErrors = errors.filter((e) => e.file === c.sourceFile).length;
              const active = i === activeIdx;
              return (
                <button key={c.sourceFile} onClick={() => setActiveIdx(i)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', marginBottom: 3, borderRadius: 6, border: `1px solid ${active ? S.primary : 'transparent'}`, background: active ? S.accent : 'transparent', color: S.fg, cursor: 'pointer', font: 'inherit', fontSize: 12.5 }}>
                  <div style={{ fontWeight: active ? 600 : 400, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.categorie || c.sourceFile}</span>
                    {catErrors > 0 && <span style={{ color: '#e5484d', fontSize: 11 }}>●</span>}
                  </div>
                  <div style={{ fontSize: 10.5, opacity: 0.55 }}>{c.articles.length} art · {c.mappings.length} map</div>
                </button>
              );
            })}
          </div>

          {/* Panou principal */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {/* Taburi + capitol */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: `1px solid ${S.border}` }}>
              {(['articles', 'mappings', 'coverage'] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  style={{ ...btn, background: tab === t ? S.accent : 'transparent', borderColor: tab === t ? S.primary : S.border }}>
                  {t === 'articles' ? `Articole (${cat?.articles.length ?? 0})` : t === 'mappings' ? `Mapări BIM (${cat?.mappings.length ?? 0})` : 'Acoperire'}
                </button>
              ))}
              <span style={{ flex: 1 }} />
              {cat && tab !== 'coverage' && (
                <label style={{ fontSize: 11, opacity: 0.7, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Capitol
                  <input style={{ ...inputBox, width: 180 }} value={cat.capitol}
                    onChange={(e) => patchCategory(activeIdx, (c) => ({ ...c, capitol: e.target.value }))} />
                </label>
              )}
            </div>

            <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
              {tab === 'articles' && cat && (
                <ArticlesTable cat={cat} th={th} td={td} input={input} inputBox={inputBox} btn={btn}
                  onPatch={patchArticle} onPatchPrice={patchPrice} onAdd={addArticle} onDel={delArticle} />
              )}
              {tab === 'mappings' && cat && (
                <MappingsTable cat={cat} th={th} td={td} inputBox={inputBox} btn={btn}
                  onPatch={patchMapping} onAdd={addMapping} onDel={delMapping} />
              )}
              {tab === 'coverage' && (
                <Coverage pct={coveragePct} mapped={mappedTypeCount} total={totalTypeCount}
                  unmapped={unmappedTypes} unused={unusedArticles} articleCount={compiled.articles.length}
                  ruleCount={compiled.mapping.length} totalPrice={totalPrice} currency={lib.meta.currency} />
              )}
            </div>
          </div>

          {/* Validare live */}
          <div style={{ width: 280, borderLeft: `1px solid ${S.border}`, overflowY: 'auto', padding: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.7, marginBottom: 6 }}>Validare</div>
            {validation.issues.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>Fără probleme ✓</div>}
            {errors.map((e, i) => (
              <div key={`e${i}`} style={{ fontSize: 11.5, marginBottom: 6, padding: 7, borderRadius: 6, border: `1px solid #e5484d55`, background: '#e5484d18' }}>
                <div style={{ color: '#e5484d', fontWeight: 600, fontSize: 10 }}>{e.code}</div>
                {e.message}{e.file ? <span style={{ opacity: 0.5 }}> · {e.file}</span> : null}
              </div>
            ))}
            {warnings.slice(0, 60).map((w, i) => (
              <div key={`w${i}`} style={{ fontSize: 11, marginBottom: 5, padding: 6, borderRadius: 6, border: `1px solid ${S.border}`, opacity: 0.85 }}>
                <div style={{ color: '#f5a623', fontWeight: 600, fontSize: 10 }}>{w.code}</div>
                {w.message}
              </div>
            ))}
            {warnings.length > 60 && <div style={{ fontSize: 11, opacity: 0.5 }}>+{warnings.length - 60} alte avertismente…</div>}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

// ── Articole ────────────────────────────────────────────────────────────────
function ArticlesTable(props: {
  cat: LibraryCategory;
  th: React.CSSProperties; td: React.CSSProperties; input: React.CSSProperties; inputBox: React.CSSProperties; btn: React.CSSProperties;
  onPatch: (ai: number, patch: Partial<LibraryArticle>) => void;
  onPatchPrice: (ai: number, key: keyof PriceComponents, value: number) => void;
  onAdd: () => void; onDel: (ai: number) => void;
}) {
  const { cat, th, td, input, inputBox, btn, onPatch, onPatchPrice, onAdd, onDel } = props;
  const numCol = (ai: number, key: keyof PriceComponents, v?: number) => (
    <input type="number" step="0.01" style={{ ...input, textAlign: 'right', width: 70 }} value={v ?? ''}
      onChange={(e) => onPatchPrice(ai, key, Number(e.target.value) || 0)} />
  );
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr>
          <th style={th}>normId</th><th style={th}>Simbol</th><th style={th}>Denumire</th><th style={th}>UM</th>
          <th style={{ ...th, textAlign: 'right' }}>mat.</th><th style={{ ...th, textAlign: 'right' }}>man.</th>
          <th style={{ ...th, textAlign: 'right' }}>util.</th><th style={{ ...th, textAlign: 'right' }}>transp.</th><th style={th} />
        </tr>
      </thead>
      <tbody>
        {cat.articles.map((a, ai) => (
          <tr key={ai}>
            <td style={td}><input style={{ ...input, minWidth: 110 }} value={a.normId} onChange={(e) => onPatch(ai, { normId: e.target.value })} /></td>
            <td style={td}><input style={{ ...input, minWidth: 80 }} value={a.symbol} onChange={(e) => onPatch(ai, { symbol: e.target.value })} /></td>
            <td style={td}><input style={{ ...input, minWidth: 200 }} value={a.denumire} onChange={(e) => onPatch(ai, { denumire: e.target.value })} /></td>
            <td style={td}>
              <select style={{ ...inputBox, width: 64 }} value={a.unit} onChange={(e) => onPatch(ai, { unit: e.target.value as LibraryArticle['unit'] })}>
                {VALID_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </td>
            <td style={td}>{numCol(ai, 'material', a.price?.material)}</td>
            <td style={td}>{numCol(ai, 'manopera', a.price?.manopera)}</td>
            <td style={td}>{numCol(ai, 'utilaj', a.price?.utilaj)}</td>
            <td style={td}>{numCol(ai, 'transport', a.price?.transport)}</td>
            <td style={td}><button style={{ ...btn, padding: '3px 7px' }} onClick={() => onDel(ai)} title="Șterge">✕</button></td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr><td colSpan={9} style={{ padding: 8 }}><button style={btn} onClick={onAdd}>+ Articol</button></td></tr>
      </tfoot>
    </table>
  );
}

// ── Mapări BIM ──────────────────────────────────────────────────────────────
function MappingsTable(props: {
  cat: LibraryCategory;
  th: React.CSSProperties; td: React.CSSProperties; inputBox: React.CSSProperties; btn: React.CSSProperties;
  onPatch: (mi: number, patch: Partial<LibraryMapping>) => void;
  onAdd: () => void; onDel: (mi: number) => void;
}) {
  const { cat, th, td, inputBox, btn, onPatch, onAdd, onDel } = props;
  const articleIds = cat.articles.map((a) => a.normId);
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr>
          <th style={th}>Articol</th><th style={th}>nodeType</th><th style={th}>elementType</th>
          <th style={th}>materialKey</th><th style={th}>măsură</th><th style={th}>formulă</th><th style={th}>net.goluri</th><th style={th} />
        </tr>
      </thead>
      <tbody>
        {cat.mappings.map((m, mi) => {
          const types = elementTypesFor(m.nodeType);
          return (
            <tr key={mi}>
              <td style={td}>
                <select style={{ ...inputBox, minWidth: 130 }} value={m.normId} onChange={(e) => onPatch(mi, { normId: e.target.value })}>
                  {!articleIds.includes(m.normId) && <option value={m.normId}>{m.normId} (extern)</option>}
                  {articleIds.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </td>
              <td style={td}>
                <select style={{ ...inputBox, width: 100 }} value={m.nodeType} onChange={(e) => onPatch(mi, { nodeType: e.target.value, elementType: '*', materialKey: undefined })}>
                  {NODE_TYPES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </td>
              <td style={td}>
                <select style={{ ...inputBox, width: 110 }} value={m.elementType} disabled={!!m.materialKey}
                  onChange={(e) => onPatch(mi, { elementType: e.target.value })}>
                  <option value="*">* (oricare)</option>
                  {types.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
                </select>
              </td>
              <td style={td}>
                <select style={{ ...inputBox, width: 96 }} value={m.materialKey ?? ''} onChange={(e) => onPatch(mi, { materialKey: e.target.value || undefined })}>
                  <option value="">—</option>
                  {MATERIAL_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </td>
              <td style={td}>
                <select style={{ ...inputBox, width: 100 }} value={m.measure} onChange={(e) => onPatch(mi, { measure: e.target.value as LibraryMapping['measure'] })}>
                  {VALID_MEASURES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </td>
              <td style={td}>
                <input style={{ ...inputBox, minWidth: 150 }} value={m.formula ?? ''} placeholder={m.measure === 'formula' ? 'ex. length_m*height_m' : ''}
                  onChange={(e) => onPatch(mi, { formula: e.target.value || undefined })} />
              </td>
              <td style={{ ...td, textAlign: 'center' }}>
                <input type="checkbox" checked={!!m.netOfOpenings} onChange={(e) => onPatch(mi, { netOfOpenings: e.target.checked || undefined })} />
              </td>
              <td style={td}><button style={{ ...btn, padding: '3px 7px' }} onClick={() => onDel(mi)} title="Șterge">✕</button></td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr><td colSpan={8} style={{ padding: 8 }}><button style={btn} onClick={onAdd}>+ Mapare</button></td></tr>
      </tfoot>
    </table>
  );
}

// ── Acoperire ───────────────────────────────────────────────────────────────
function Coverage(props: {
  pct: number; mapped: number; total: number; unmapped: string[]; unused: string[];
  articleCount: number; ruleCount: number; totalPrice: number; currency: string;
}) {
  const { pct, mapped, total, unmapped, unused, articleCount, ruleCount, totalPrice, currency } = props;
  const card: React.CSSProperties = { border: `1px solid ${S.border}`, borderRadius: 10, padding: 14, background: S.accent };
  const stat = (label: string, value: string) => (
    <div style={{ ...card, flex: 1 }}>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11, opacity: 0.6 }}>{label}</div>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        {stat('Tipuri BIM acoperite', `${mapped}/${total}`)}
        {stat('Articole', String(articleCount))}
        {stat('Reguli de mapare', String(ruleCount))}
        {stat('Preț unitar cumulat', `${totalPrice.toLocaleString('ro-RO', { maximumFractionDigits: 0 })} ${currency}`)}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
          <span style={{ fontWeight: 600 }}>Acoperire tipuri BIM</span><span>{pct}%</span>
        </div>
        <div style={{ height: 10, borderRadius: 6, background: S.border, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: S.primary }} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Tipuri nemapate ({unmapped.length})</div>
          <div style={{ maxHeight: 260, overflowY: 'auto', fontSize: 11.5 }}>
            {unmapped.length === 0 && <div style={{ opacity: 0.5 }}>Toate tipurile au mapare ✓</div>}
            {unmapped.map((t) => <div key={t} style={{ padding: '3px 0', borderBottom: `1px solid ${S.border}`, fontFamily: 'monospace' }}>{t}</div>)}
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Articole nefolosite ({unused.length})</div>
          <div style={{ maxHeight: 260, overflowY: 'auto', fontSize: 11.5 }}>
            {unused.length === 0 && <div style={{ opacity: 0.5 }}>Toate articolele sunt folosite ✓</div>}
            {unused.map((a) => <div key={a} style={{ padding: '3px 0', borderBottom: `1px solid ${S.border}`, fontFamily: 'monospace' }}>{a}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

export default LibraryEditor;
