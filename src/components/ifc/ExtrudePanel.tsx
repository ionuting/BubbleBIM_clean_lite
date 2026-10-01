/**
 * ExtrudePanel — draw a contour, extrude it, then edit the result by number.
 *
 * Presentational: it owns no solids, only the controls. The TOC viewer and the
 * World view both mount it, so the two offer the same editing vocabulary over
 * the same `ExtrudedSolid` model — only the surface you draw on differs, and
 * the host says so through `planeLabel`.
 */

import type { ExtrudedSolid, SolidPlacement } from '@/lib/ifc/extrude/extrudedSolid';
import { solidQuantities, topElevation } from '@/lib/ifc/extrude/extrudedSolid';
import { exportSummary } from '@/lib/ifc/extrude/extrudeIfc';

/** The IFC classes worth offering for a hand-drawn volume. */
export const EXTRUDE_TYPES: Array<{ value: string; label: string }> = [
  { value: 'IFCBUILDINGELEMENTPROXY', label: 'Volum generic' },
  { value: 'IFCSLAB', label: 'Placă' },
  { value: 'IFCWALL', label: 'Perete' },
  { value: 'IFCCOLUMN', label: 'Stâlp' },
  { value: 'IFCROOF', label: 'Acoperiș' },
  { value: 'IFCFOOTING', label: 'Fundație' },
  { value: 'IFCSPACE', label: 'Spațiu' },
];

interface Props {
  solids: ExtrudedSolid[];
  selectedId: string | null;
  /** True while the user is clicking out a contour. */
  drawing: boolean;
  /** How many points are down so far. */
  pointCount: number;
  /** "cota 0" / "cota terenului" — what the contour is drawn on. */
  planeLabel: string;
  defaultHeight: number;
  onDefaultHeightChange: (v: number) => void;
  onStartDraw: () => void;
  onCancelDraw: () => void;
  onFinishDraw: () => void;
  onSelect: (id: string | null) => void;
  onPatch: (id: string, patch: Partial<SolidPlacement>) => void;
  onHeight: (id: string, height: number) => void;
  onRename: (id: string, name: string) => void;
  onType: (id: string, ifcType: string) => void;
  onDelete: (id: string) => void;
  onFocus?: (id: string) => void;
  onExport: () => void;
  className?: string;
}

function Num({ label, value, unit, step, onChange }: {
  label: string; value: number; unit: string; step: number; onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground w-11 shrink-0 text-right">{label}</span>
      <input
        type="number" step={step} value={Number(value.toFixed(4))}
        onChange={(e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v); }}
        className="flex-1 min-w-0 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground"
      />
      <span className="text-[10px] text-muted-foreground w-5 shrink-0">{unit}</span>
    </label>
  );
}

export function ExtrudePanel({
  solids, selectedId, drawing, pointCount, planeLabel, defaultHeight, onDefaultHeightChange,
  onStartDraw, onCancelDraw, onFinishDraw, onSelect, onPatch, onHeight, onRename, onType,
  onDelete, onFocus, onExport, className,
}: Props) {
  const sel = solids.find((s) => s.id === selectedId) ?? null;
  const total = exportSummary(solids);

  return (
    <div className={`flex flex-col bg-card border border-border rounded-md shadow-xl overflow-hidden ${className ?? ''}`}>
      <div className="px-2 py-1.5 border-b border-border bg-muted/50">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Extrudări
        </div>
        <div className="text-[10px] text-muted-foreground">contur pe {planeLabel}</div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
        {/* Draw */}
        {drawing ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] text-foreground">
              {pointCount} {pointCount === 1 ? 'punct' : 'puncte'} — click pentru următorul
            </div>
            <div className="text-[10px] text-muted-foreground leading-snug">
              Dublu-click sau Enter închide conturul. Esc anulează.
            </div>
            <div className="flex gap-1">
              <button
                onClick={onFinishDraw} disabled={pointCount < 3}
                className="flex-1 text-[11px] py-1 rounded bg-primary text-primary-foreground disabled:opacity-40"
              >
                ✓ Închide
              </button>
              <button
                onClick={onCancelDraw}
                className="flex-1 text-[11px] py-1 rounded border border-border bg-background text-foreground hover:bg-accent"
              >
                Anulează
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              onClick={onStartDraw}
              className="text-[11px] py-1 rounded border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
            >
              ✏ Desenează contur
            </button>
            <Num label="Înălțime" value={defaultHeight} unit="m" step={0.1} onChange={onDefaultHeightChange} />
          </>
        )}

        {/* List */}
        {solids.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-border pt-2">
            {solids.map((s) => (
              <button
                key={s.id}
                onClick={() => onSelect(selectedId === s.id ? null : s.id)}
                className={`flex items-center gap-1.5 text-[11px] rounded px-1.5 py-1 text-left border ${
                  selectedId === s.id
                    ? 'bg-primary/10 border-primary/30'
                    : 'border-transparent hover:bg-accent/40'
                }`}
              >
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
                <span className="flex-1 min-w-0 truncate text-foreground">{s.name}</span>
                <span className="text-[9px] text-muted-foreground shrink-0">
                  {solidQuantities(s).volumeM3.toFixed(1)} m³
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Selected */}
        {sel && (
          <div className="flex flex-col gap-1.5 border-t border-border pt-2">
            <input
              value={sel.name}
              onChange={(e) => onRename(sel.id, e.target.value)}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground"
            />
            <select
              value={sel.ifcType}
              onChange={(e) => onType(sel.id, e.target.value)}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground"
            >
              {EXTRUDE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>

            <div className="text-[9px] uppercase tracking-wider text-muted-foreground pt-1">Vertical</div>
            <Num label="Înălțime" value={sel.height} unit="m" step={0.1}
              onChange={(v) => onHeight(sel.id, v)} />
            <Num label="Cotă bază" value={sel.placement.z} unit="m" step={0.1}
              onChange={(v) => onPatch(sel.id, { z: v })} />

            <div className="text-[9px] uppercase tracking-wider text-muted-foreground pt-1">Poziție</div>
            <Num label="Est" value={sel.placement.x} unit="m" step={0.1}
              onChange={(v) => onPatch(sel.id, { x: v })} />
            <Num label="Nord" value={sel.placement.y} unit="m" step={0.1}
              onChange={(v) => onPatch(sel.id, { y: v })} />
            <Num label="Rotire" value={sel.placement.rotation} unit="°" step={5}
              onChange={(v) => onPatch(sel.id, { rotation: v })} />

            <div className="text-[9px] uppercase tracking-wider text-muted-foreground pt-1">Scară</div>
            <Num label="X" value={sel.placement.sx} unit="×" step={0.1}
              onChange={(v) => onPatch(sel.id, { sx: v })} />
            <Num label="Y" value={sel.placement.sy} unit="×" step={0.1}
              onChange={(v) => onPatch(sel.id, { sy: v })} />
            <Num label="Z" value={sel.placement.sz} unit="×" step={0.1}
              onChange={(v) => onPatch(sel.id, { sz: v })} />
            <button
              onClick={() => onPatch(sel.id, { sx: 1, sy: 1, sz: 1, rotation: 0 })}
              className="text-[10px] py-0.5 rounded border border-border bg-background text-muted-foreground hover:bg-accent"
            >
              ↺ Resetează rotirea și scara
            </button>

            <SolidFacts solid={sel} />

            <div className="flex gap-1 pt-1">
              {onFocus && (
                <button
                  onClick={() => onFocus(sel.id)}
                  className="flex-1 text-[11px] py-1 rounded border border-border bg-background text-foreground hover:bg-accent"
                >
                  ⌖ Focus
                </button>
              )}
              <button
                onClick={() => onDelete(sel.id)}
                className="flex-1 text-[11px] py-1 rounded border border-destructive/30 text-destructive hover:bg-destructive/10"
              >
                ✕ Șterge
              </button>
            </div>
          </div>
        )}
      </div>

      {solids.length > 0 && (
        <div className="p-2 border-t border-border flex flex-col gap-1">
          <div className="text-[10px] text-muted-foreground">
            {total.count} {total.count === 1 ? 'volum' : 'volume'} · {total.volumeM3.toFixed(1)} m³
          </div>
          <button
            onClick={onExport}
            title="Scrie un fișier IFC nou cu aceste volume ca IfcExtrudedAreaSolid"
            className="text-[11px] py-1 rounded border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
          >
            ⬇ Exportă IFC
          </button>
        </div>
      )}
    </div>
  );
}

function SolidFacts({ solid }: { solid: ExtrudedSolid }) {
  const q = solidQuantities(solid);
  const rows: Array<[string, string]> = [
    ['Arie', `${q.areaM2.toFixed(2)} m²`],
    ['Perimetru', `${q.perimeterM.toFixed(2)} m`],
    ['Volum', `${q.volumeM3.toFixed(2)} m³`],
    ['Cotă superioară', `${topElevation(solid).toFixed(2)} m`],
  ];
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-2 text-[10px] bg-muted/40 rounded px-1.5 py-1 mt-1">
      {rows.map(([k, v]) => (
        <span key={k} className="contents">
          <span className="text-muted-foreground">{k}</span>
          <span className="text-foreground font-mono text-right">{v}</span>
        </span>
      ))}
    </div>
  );
}
