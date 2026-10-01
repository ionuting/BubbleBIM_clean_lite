/**
 * IfcPropertiesPanel — everything an IFC file says about one element.
 *
 * Presentational only: it takes the flat record `normalizeItemData` produces
 * and draws it. The TOC viewer and the World view both mount it, so the two
 * never disagree about what "the properties" are.
 *
 * The background must stay OPAQUE: the TOC viewer mounts this panel floating
 * over a 3D canvas, and anything translucent there is unreadable. `bg-card`
 * is a solid colour in both themes, so it carries that on its own — but only
 * since `index.css` began registering the semantic colours with `@theme`.
 * Before that they compiled to nothing and this panel was invisible.
 */

import { useState } from 'react';
import type { IfcElementProperties, IfcPropertySet, IfcScalar } from '@/lib/ifc/ifcFragments';

interface Props {
  element: IfcElementProperties | null;
  /** Shown while a pick is being resolved. */
  loading?: boolean;
  onClose: () => void;
  className?: string;
}

function fmt(v: IfcScalar): string {
  if (v === null) return '—';
  if (typeof v === 'boolean') return v ? 'da' : 'nu';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '');
  return v;
}

/** "IFCWALLSTANDARDCASE" → "Wall standard case". */
function humanCategory(cat: string): string {
  const s = (cat ?? '').replace(/^IFC/, '');
  if (!s) return '—';
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function Rows({ props }: { props: Record<string, IfcScalar> }) {
  const entries = Object.entries(props);
  if (entries.length === 0) return <div className="text-[10px] text-muted-foreground px-2 py-1">gol</div>;
  return (
    <table className="w-full text-[11px]">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k} className="border-t border-border/40">
            <td className="px-2 py-0.5 text-muted-foreground align-top w-[45%] break-words">{k}</td>
            <td className="px-2 py-0.5 text-foreground font-mono break-all">{fmt(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Group({ title, badge, defaultOpen, children }: {
  title: string; badge?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div className="border border-border rounded overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-2 py-1 bg-muted/50 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-[11px] font-semibold text-foreground truncate">{title}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          {badge && <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{badge}</span>}
          <span className="text-[10px] text-muted-foreground">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && children}
    </div>
  );
}

export function IfcPropertiesPanel({ element, loading, onClose, className }: Props) {
  return (
    <div
      className={`flex flex-col bg-card border border-border rounded-md shadow-xl overflow-hidden ${className ?? ''}`}
    >
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border bg-muted/50">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Proprietăți IFC
          </div>
          {element && (
            <div className="text-xs text-foreground truncate" title={element.name ?? undefined}>
              {element.name ?? <span className="text-muted-foreground">(fără nume)</span>}
            </div>
          )}
        </div>
        <button
          className="text-muted-foreground hover:text-foreground text-sm px-1"
          onClick={onClose} title="Închide"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
        {loading && <div className="text-[11px] text-muted-foreground">Se citesc proprietățile…</div>}

        {!loading && !element && (
          <div className="text-[11px] text-muted-foreground">
            Dă click pe un element al modelului IFC.
          </div>
        )}

        {element && (
          <>
            {/* Identity — the things you need before any pset */}
            <div className="text-[11px] grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 px-1">
              <span className="text-muted-foreground">Clasă</span>
              <span className="text-foreground">
                {humanCategory(element.category)}{' '}
                <span className="text-muted-foreground font-mono text-[10px]">{element.category}</span>
              </span>
              {element.typeName && (<>
                <span className="text-muted-foreground">Tip</span>
                <span className="text-foreground">{element.typeName}</span>
              </>)}
              {element.materials.length > 0 && (<>
                <span className="text-muted-foreground">Material</span>
                <span className="text-foreground">{element.materials.join(' · ')}</span>
              </>)}
              <span className="text-muted-foreground">GUID</span>
              <span className="text-foreground font-mono text-[10px] break-all">{element.guid ?? '—'}</span>
              <span className="text-muted-foreground">id local</span>
              <span className="text-foreground font-mono text-[10px]">{element.localId}</span>
            </div>

            <Group title="Atribute" badge="entitate">
              <Rows props={element.attributes} />
            </Group>

            {element.psets.filter((p) => p.kind === 'pset').map((p) => (
              <PsetGroup key={`p-${p.name}`} pset={p} />
            ))}
            {element.psets.filter((p) => p.kind === 'qto').map((p) => (
              <PsetGroup key={`q-${p.name}`} pset={p} />
            ))}

            {element.psets.length === 0 && (
              <div className="text-[10px] text-muted-foreground px-1">
                Elementul nu are seturi de proprietăți în fișier.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PsetGroup({ pset }: { pset: IfcPropertySet }) {
  return (
    <Group title={pset.name} badge={pset.kind === 'qto' ? 'cantități' : 'pset'} defaultOpen={pset.kind === 'pset'}>
      <Rows props={pset.props} />
    </Group>
  );
}
