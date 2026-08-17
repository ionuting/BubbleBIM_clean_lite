/**
 * RebarPanel — panou plutitor pentru configuratorul de armare:
 *  - paletă de forme (armare + cofraj) → setează unealta de plasare
 *  - proprietăți ale formei selectate (parametri, număr, marcă, transformări)
 *
 * Portat conceptual din PaletaForme.tsx + PanouProprietati.tsx ale sursei,
 * reconstruit modular și mult mai compact.
 */
import {
  type FormaArmare,
  LISTA_FORME,
  LISTA_FORME_COFRAJ,
  definitiePentru,
} from '@armare/nucleu';
import { useArmare, type UnealtaArmare } from '@/store/armareStore';

export function RebarPanel() {
  const unealta = useArmare((s) => s.unealta);
  const setUnealta = useArmare((s) => s.setUnealta);
  const forme = useArmare((s) => (s.activeViewId ? s.views[s.activeViewId]?.forme ?? [] : []));
  const ids = useArmare((s) => (s.activeViewId ? s.views[s.activeViewId]?.idsSelectate ?? [] : []));

  const selectata = forme.find((f) => ids.includes(f.id)) ?? null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: 12,
        width: 240,
        maxHeight: 'calc(100% - 24px)',
        overflowY: 'auto',
        background: 'rgba(255,255,255,0.96)',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        fontSize: 12,
        color: '#0f172a',
        zIndex: 20,
      }}
      // Nu lăsăm evenimentele de canvas (pan/zoom) să treacă prin panou.
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <Sectiune titlu="Armare · Unelte">
        <ToolButton
          activ={unealta === 'select'}
          label="↖ Selecție"
          onClick={() => setUnealta('select')}
        />
      </Sectiune>

      <Sectiune titlu="Forme armare">
        <PaletaGrup lista={LISTA_FORME} unealta={unealta} setUnealta={setUnealta} />
      </Sectiune>

      <Sectiune titlu="Cofraj / contur">
        <PaletaGrup lista={LISTA_FORME_COFRAJ} unealta={unealta} setUnealta={setUnealta} />
      </Sectiune>

      {selectata && <Proprietati forma={selectata} />}
    </div>
  );
}

function PaletaGrup({
  lista,
  unealta,
  setUnealta,
}: {
  lista: typeof LISTA_FORME;
  unealta: UnealtaArmare;
  setUnealta: (u: UnealtaArmare) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
      {lista.map((def) => (
        <ToolButton
          key={def.tip}
          activ={unealta === def.tip}
          label={def.nume}
          onClick={() => setUnealta(def.tip)}
        />
      ))}
    </div>
  );
}

function Proprietati({ forma }: { forma: FormaArmare }) {
  const def = definitiePentru(forma.tip);
  const actualizeazaParametru = useArmare((s) => s.actualizeazaParametru);
  const actualizeazaNumar = useArmare((s) => s.actualizeazaNumar);
  const setMarcaForma = useArmare((s) => s.setMarcaForma);
  const setRotatie = useArmare((s) => s.setRotatie);
  const roteste = useArmare((s) => s.roteste);
  const comutaOglindire = useArmare((s) => s.comutaOglindire);
  const stergeSelectia = useArmare((s) => s.stergeSelectia);

  return (
    <Sectiune titlu={`Proprietăți · ${forma.nume}`}>
      <Camp label="Marcă">
        <input
          type="number"
          value={forma.marca}
          min={1}
          onChange={(e) => setMarcaForma(forma.id, Number(e.target.value))}
          style={inputStyle}
        />
      </Camp>
      <Camp label="Număr bare">
        <input
          type="number"
          value={forma.numar}
          min={0}
          onChange={(e) => actualizeazaNumar(forma.id, Number(e.target.value))}
          style={inputStyle}
        />
      </Camp>

      {def.parametri.map((par) => (
        <Camp key={par.cheie} label={`${par.eticheta} (${par.unitate})`}>
          <input
            type="number"
            value={forma.parametri[par.cheie] ?? par.valoareImplicita}
            min={par.min}
            max={par.max}
            onChange={(e) => actualizeazaParametru(forma.id, par.cheie, Number(e.target.value))}
            style={inputStyle}
          />
        </Camp>
      ))}

      <Camp label="Rotație (°)">
        <input
          type="number"
          value={Math.round(forma.rotatie ?? 0)}
          onChange={(e) => setRotatie(forma.id, Number(e.target.value))}
          style={inputStyle}
        />
      </Camp>

      <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
        <MicButon label="⟲ 90°" onClick={() => roteste(forma.id, 90)} />
        <MicButon label="⟳ 90°" onClick={() => roteste(forma.id, -90)} />
        <MicButon label="⇋ X" onClick={() => comutaOglindire(forma.id, 'x')} />
        <MicButon label="⇅ Y" onClick={() => comutaOglindire(forma.id, 'y')} />
        <MicButon label="🗑 Șterge" danger onClick={() => stergeSelectia()} />
      </div>
    </Sectiune>
  );
}

// ── UI helpers ────────────────────────────────────────────────────────────

function Sectiune({ titlu, children }: { titlu: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: 10, borderBottom: '1px solid #f1f5f9' }}>
      <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', color: '#64748b', marginBottom: 8, letterSpacing: 0.4 }}>
        {titlu}
      </div>
      {children}
    </div>
  );
}

function ToolButton({ activ, label, onClick }: { activ: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 8px',
        borderRadius: 6,
        border: `1px solid ${activ ? '#2563eb' : '#e2e8f0'}`,
        background: activ ? '#2563eb' : '#fff',
        color: activ ? '#fff' : '#0f172a',
        cursor: 'pointer',
        fontSize: 11,
        textAlign: 'left',
        lineHeight: 1.2,
      }}
    >
      {label}
    </button>
  );
}

function Camp({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
      <span style={{ color: '#475569' }}>{label}</span>
      {children}
    </label>
  );
}

function MicButon({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 8px',
        borderRadius: 6,
        border: `1px solid ${danger ? '#fecaca' : '#e2e8f0'}`,
        background: danger ? '#fef2f2' : '#f8fafc',
        color: danger ? '#dc2626' : '#0f172a',
        cursor: 'pointer',
        fontSize: 11,
      }}
    >
      {label}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  width: 90,
  padding: '3px 6px',
  border: '1px solid #cbd5e1',
  borderRadius: 4,
  fontSize: 12,
  textAlign: 'right',
};
