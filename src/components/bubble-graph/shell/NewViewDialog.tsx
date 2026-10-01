/**
 * NewViewDialog — a new 2D view: what it shows, how it is drawn, its name.
 *
 * Plan (a storey, a discipline), elevation (a side) or section (a side, for
 * OpenGeometry; a classic section is drawn on the plan instead). Drawn by the
 * classic 2D engine or by OpenGeometry. The name is proposed from the choices
 * and kept unique among the project's views; once typed by hand it stays.
 */
import { useMemo, useState } from 'react';
import type { BubbleGraphNode, StoreyDiscipline } from '@/store';
import {
  DEFAULT_ENGINE, defaultViewName, uniqueViewName, type Dir, type DrawingEngine, type DrawingView, type DrawingViewKind,
} from '@/lib/views/drawingViews';

export interface NewViewRequest {
  kind: DrawingViewKind;
  engine: DrawingEngine;
  storeyId?: string;
  discipline?: StoreyDiscipline;
  dir?: Dir;
  name: string;
}

export function NewViewDialog({ storeys, views, initial, showDisciplines, onCreate, onDrawSection, onClose }: {
  storeys: BubbleGraphNode[];
  views: DrawingView[];
  initial?: Partial<NewViewRequest>;
  showDisciplines: boolean;
  onCreate: (req: NewViewRequest) => void;
  /** A classic section is cut by drawing it on a plan. */
  onDrawSection: () => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<DrawingViewKind>(initial?.kind ?? 'plan');
  const [engine, setEngine] = useState<DrawingEngine>(initial?.engine ?? DEFAULT_ENGINE);
  const [storeyId, setStoreyId] = useState(initial?.storeyId ?? storeys[0]?.id ?? '');
  const [discipline, setDiscipline] = useState<StoreyDiscipline>(initial?.discipline ?? 'architectural');
  const [dir, setDir] = useState<Dir>(initial?.dir ?? 'S');
  const [typed, setTyped] = useState<string | null>(null);

  const storeyName = storeys.find((s) => s.id === storeyId)?.name;
  const proposed = useMemo(
    () => uniqueViewName(defaultViewName({ kind, engine, discipline, dir }, storeyName), views),
    [kind, engine, discipline, dir, storeyName, views],
  );
  const name = typed ?? proposed;
  const finalName = uniqueViewName(name, views);
  const classicSection = kind === 'section' && engine === 'classic';
  const canCreate = classicSection || (kind !== 'plan' || !!storeyId);

  const submit = () => {
    if (classicSection) { onClose(); onDrawSection(); return; }
    onCreate({ kind, engine, name: finalName, ...(kind === 'plan' ? { storeyId, discipline } : { dir }) });
    onClose();
  };

  const seg = <T extends string>(value: T, set: (v: T) => void, opts: [T, string][], label: string) => (
    <div className="bb-field">
      <span className="bb-field-label">{label}</span>
      <div className="bb-seg" role="radiogroup" aria-label={label}>
        {opts.map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => set(v)}>{l}</button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="bb-palette-backdrop" onPointerDown={onClose}>
      <form
        className="bb-dialog"
        role="dialog"
        aria-label="Vedere nouă"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (canCreate) submit(); }}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <h2>Vedere nouă</h2>
        {seg(kind, setKind, [['plan', 'Plan'], ['elevation', 'Fațadă'], ['section', 'Secțiune']], 'Tip')}
        {seg(engine, setEngine, [['og', 'OpenGeometry'], ['classic', 'Desen 2D clasic']], 'Desen')}
        {kind === 'plan' && (
          <>
            <label className="bb-field">
              <span className="bb-field-label">Nivel</span>
              <select className="bb-input" value={storeyId} onChange={(e) => setStoreyId(e.target.value)}>
                {storeys.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            {showDisciplines && seg(discipline, setDiscipline, [['architectural', 'Arhitectură'], ['structural', 'Structură'], ['mep', 'Instalații']], 'Disciplină')}
          </>
        )}
        {kind !== 'plan' && !classicSection && seg(dir, setDir, [['N', 'Nord'], ['S', 'Sud'], ['E', 'Est'], ['W', 'Vest']], 'Privită dinspre')}
        {classicSection ? (
          <p className="bb-dialog-note">O secțiune clasică se taie pe plan: după „Continuă”, dă două clicuri pe plan. Vederea apare apoi la Secțiuni, cu numele ei.</p>
        ) : (
          <label className="bb-field">
            <span className="bb-field-label">Nume</span>
            <input className="bb-input" value={name} onChange={(e) => setTyped(e.target.value)} autoFocus />
            {finalName !== name.trim() && <span className="bb-dialog-note">Există deja — va fi „{finalName}”.</span>}
          </label>
        )}
        <div className="bb-dialog-actions">
          <button type="button" className="bb-btn" onClick={onClose}>Renunță</button>
          <button type="submit" className="bb-btn primary" disabled={!canCreate}>{classicSection ? 'Continuă' : 'Creează'}</button>
        </div>
      </form>
    </div>
  );
}
