/**
 * StyleDialog — pick an architectural style, tune it, see what it will do,
 * apply it to the graph.
 *
 * The preview is the real thing: `applyStyle` runs on the current graph on
 * every change and the list below is its own account of what it changed, what
 * it derived (eave height, wall-plate lift, posts) and what it could not do.
 * Nothing reaches the model until "Aplică"; the result then goes through the
 * panel's undoable setters, so Ctrl+Z takes it back like any other edit.
 */
import { useDeferredValue, useMemo, useState } from 'react';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { applyStyle, readAppliedStyle, removeStyle } from '@/lib/style/engine';
import { paramApplies, paramRange, resolveParams, STYLE_PACK_MAP, STYLE_PACKS, STYLE_PARAMS } from '@/lib/style/packs';
import { STYLE_FAMILY_LABELS, STYLE_GROUP_LABELS, type StyleFamily, type StyleGroup, type StyleParams } from '@/lib/style/types';

interface Props {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  onApply: (nodes: BubbleGraphNode[], edges: BubbleGraphEdge[], summary: string) => void;
  onClose: () => void;
}

const GROUPS: StyleGroup[] = ['roof', 'envelope', 'ornament', 'porch', 'details'];
const FAMILIES: StyleFamily[] = ['traditional', 'modern', 'classic'];

const FIGURE_LABELS: Record<string, [string, string]> = {
  roof_overhang_mm: ['Streașină', 'mm'],
  eave_z_mm: ['Marginea streașinii', 'mm'],
  wall_plate_lift_mm: ['Cosoroabă ridicată', 'mm'],
  porch_plate_top_mm: ['Grinda prispei (sus)', 'mm'],
  porch_posts: ['Stâlpi', ''],
  porch_area_m2: ['Suprafață prispă', 'm²'],
  portico_columns: ['Coloane portic', ''],
};

export function StyleDialog({ nodes, edges, onApply, onClose }: Props) {
  const applied = useMemo(() => readAppliedStyle(nodes), [nodes]);
  const [packId, setPackId] = useState(applied?.packId && STYLE_PACK_MAP.has(applied.packId) ? applied.packId : STYLE_PACKS[0].id);
  const pack = STYLE_PACK_MAP.get(packId)!;
  const [overrides, setOverrides] = useState<Partial<StyleParams>>(applied?.packId === packId ? applied.params : {});
  const params = useMemo(() => resolveParams(pack, overrides), [pack, overrides]);

  const deferred = useDeferredValue(params);
  const preview = useMemo(() => {
    try {
      return applyStyle(nodes, edges, packId, deferred);
    } catch (e) {
      return { nodes, edges, changes: [], issues: [{ severity: 'error' as const, text: String(e) }], figures: {} };
    }
  }, [nodes, edges, packId, deferred]);
  const errors = preview.issues.filter((i) => i.severity === 'error');

  const pickPack = (id: string) => { setPackId(id); setOverrides({}); };
  const set = (key: string, v: StyleParams[string]) => setOverrides((o) => ({ ...o, [key]: v }));

  const apply = () => {
    const added = preview.changes.filter((c) => c.kind === 'add').length;
    onApply(preview.nodes, preview.edges, `${pack.label}: ${preview.changes.length} modificări, ${added} elemente noi`);
  };
  const remove = () => {
    const out = removeStyle(nodes, edges);
    onApply(out.nodes, out.edges, `Stil eliminat: ${out.removed} elemente scoase, ${out.restored} readuse`);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40" onPointerDown={onClose}>
      <div
        className="bg-white dark:bg-zinc-900 border border-border rounded-xl shadow-2xl w-[980px] max-w-[96vw] h-[84vh] flex flex-col overflow-hidden text-xs"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <span className="font-semibold text-sm">Stil arhitectural</span>
          <span className="text-muted-foreground">reguli parametrice aplicate grafului — totul rămâne editabil</span>
          <button type="button" className="ml-auto text-muted-foreground hover:text-foreground text-base" onClick={onClose}>×</button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-[300px_1fr] divide-x divide-border">
          {/* Packs and parameters */}
          <div className="overflow-y-auto p-3 space-y-3">
            {FAMILIES.map((fam) => (
              <div key={fam} className="space-y-1.5">
                <div className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground">{STYLE_FAMILY_LABELS[fam]}</div>
                {STYLE_PACKS.filter((p) => p.family === fam).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => pickPack(p.id)}
                    className={`w-full text-left rounded-lg border px-2.5 py-1.5 ${p.id === packId ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50'}`}
                  >
                    <div className="font-medium">{p.label}</div>
                    <div className="text-muted-foreground">{p.region}</div>
                  </button>
                ))}
              </div>
            ))}
            <p className="text-muted-foreground leading-snug">{pack.description}</p>

            {GROUPS.map((g) => (
              <div key={g} className="space-y-1.5">
                <div className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground">{STYLE_GROUP_LABELS[g]}</div>
                {STYLE_PARAMS.filter((d) => d.group === g && paramApplies(d.key, params)).map((d) => {
                  const v = params[d.key];
                  if (d.kind === 'number') {
                    const [lo, hi] = paramRange(pack, d)!;
                    return (
                      <label key={d.key} className="block" title={d.help}>
                        <div className="flex justify-between"><span>{d.label}</span><span className="tabular-nums">{Number(v)} {d.unit === 'buc' ? '' : d.unit}</span></div>
                        <input type="range" className="w-full" min={lo} max={hi} step={d.step} value={Number(v)}
                          onChange={(e) => set(d.key, Number(e.target.value))} />
                      </label>
                    );
                  }
                  if (d.kind === 'bool') {
                    return (
                      <label key={d.key} className="flex items-center gap-2" title={d.help}>
                        <input type="checkbox" checked={!!v} onChange={(e) => set(d.key, e.target.checked)} />
                        <span>{d.label}</span>
                      </label>
                    );
                  }
                  if (d.kind === 'choice') {
                    return (
                      <label key={d.key} className="block" title={d.help}>
                        <div>{d.label}</div>
                        <select className="w-full bg-background border border-border rounded px-1.5 py-0.5" value={String(v)}
                          onChange={(e) => set(d.key, e.target.value)}>
                          {d.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </label>
                    );
                  }
                  return (
                    <label key={d.key} className="flex items-center gap-2" title={d.help}>
                      <input type="color" value={String(v) || '#8B6914'} onChange={(e) => set(d.key, e.target.value)} />
                      <span>{d.label}</span>
                      {v !== '' && d.key !== 'brau_color' && (
                        <button type="button" className="ml-auto text-muted-foreground underline" onClick={() => set(d.key, '')}>
                          {d.key === 'woodwork_color' ? 'lemn natur' : 'culoarea materialului'}
                        </button>
                      )}
                    </label>
                  );
                })}
              </div>
            ))}
          </div>

          {/* What it will do */}
          <div className="overflow-y-auto p-3 space-y-3">
            <div className="font-semibold text-sm">Ce se schimbă în model</div>
            <ul className="space-y-1">
              {preview.changes.map((c, i) => (
                <li key={i} className="flex gap-2">
                  <span className={`shrink-0 w-4 text-center font-bold ${c.kind === 'add' ? 'text-emerald-600' : c.kind === 'remove' ? 'text-rose-600' : 'text-sky-600'}`}>
                    {c.kind === 'add' ? '+' : c.kind === 'remove' ? '−' : '~'}
                  </span>
                  <span className="text-muted-foreground w-16 shrink-0">{STYLE_GROUP_LABELS[c.group]}</span>
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>

            {Object.keys(preview.figures).some((k) => FIGURE_LABELS[k]) && (
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(FIGURE_LABELS).filter(([k]) => preview.figures[k] != null).map(([k, [label, unit]]) => (
                  <div key={k} className="rounded-lg border border-border px-2 py-1.5">
                    <div className="text-muted-foreground">{label}</div>
                    <div className="font-semibold tabular-nums">{preview.figures[k]} {unit}</div>
                  </div>
                ))}
              </div>
            )}

            {preview.issues.length > 0 && (
              <ul className="space-y-1">
                {preview.issues.map((i, k) => (
                  <li key={k} className={`rounded px-2 py-1 ${i.severity === 'error' ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : i.severity === 'warning' ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300' : 'bg-muted text-muted-foreground'}`}>
                    {i.text}
                  </li>
                ))}
              </ul>
            )}

            <p className="text-muted-foreground leading-snug">
              Elementele noi sunt noduri obișnuite — sweep-uri, schițe și axe libere — pe care le poți edita, muta sau șterge.
              Nodurile modificate (acoperiș, strat exterior) își păstrează valorile anterioare, așa că stilul se poate elimina oricând.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
          {applied && (
            <button type="button" className="px-3 py-1 rounded border border-border hover:bg-muted" onClick={remove}>
              Elimină stilul aplicat
            </button>
          )}
          <span className="ml-auto text-muted-foreground">{applied ? `Aplicat acum: ${STYLE_PACK_MAP.get(applied.packId)?.label ?? applied.packId}` : ''}</span>
          <button type="button" className="px-3 py-1 rounded border border-border hover:bg-muted" onClick={onClose}>Închide</button>
          <button
            type="button"
            disabled={errors.length > 0 || preview.changes.length === 0}
            className="px-3 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
            onClick={apply}
          >
            Aplică stilul
          </button>
        </div>
      </div>
    </div>
  );
}
