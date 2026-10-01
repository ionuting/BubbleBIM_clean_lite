/**
 * StylePanel — the drawing style configurator, for dimensions and for
 * everything else.
 *
 * ## The one idea the UI has to get across
 *
 * A dimension follows a named STYLE, and may override a few fields on its own.
 * That is two different things to edit, and a panel that hides the difference
 * produces the classic complaint — "I changed it and nothing happened", or
 * worse, "I changed one and they all moved".
 *
 * So the panel has two modes and says which one it is in:
 *
 *   - nothing selected → you are editing the STYLE. Every dimension that
 *     follows it changes as you drag. The header says so.
 *   - a dimension selected → you are editing THAT dimension. Each field you
 *     touch becomes an override, marked with a dot and its own undo arrow,
 *     and a single button puts the whole thing back on its style.
 *
 * ## Why the preview is not decoration
 *
 * Tick size 4, extension overshoot 3, text offset 0.45 — these are multipliers
 * of a base that varies per view, and no one can picture them. The preview
 * draws a real dimension through the same `dimDrawing` the canvas uses, so
 * what you see is what the drawing gets, and the numbers can stay honest
 * instead of being translated into invented units.
 */
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useBubbleGraphStore, type DimAnn, type DrawingAnnotation } from '@/store';
import {
  DEFAULT_DRAW_STYLE_PROPS, RELEVANT, drawOverriddenKeys, resolveDrawStyle,
  type DrawKind, type DrawOverride, type DrawStyleProps,
} from '@/lib/drawing/drawStyle';
import { HATCH_PATTERNS } from './SvgHatches';
import { dashFor } from '@/lib/drawing/drawStyle';
import {
  DEFAULT_DIM_STYLE_PROPS, formatDimLabel, overriddenKeys, resolveDimStyle,
  type DimStyleProps, type DimTextPlacement, type DimTick, type DimUnit,
  type LineStyle,
} from '@/lib/drawing/dimStyle';
import { dimDrawing } from '@/lib/drawing/dimGeometry';

interface Props {
  /** Whatever is selected, of any kind — or nothing. */
  selected: DrawingAnnotation | null;
  /** The armed tool, which says what the NEXT annotation will be. */
  activeTool: string | null;
  /** Which styles new annotations are drawn in, when nothing is selected. */
  currentDimStyleId: string;
  currentDrawStyleId: string;
  onCurrentDimStyleChange: (id: string) => void;
  onCurrentDrawStyleChange: (id: string) => void;
  onClose: () => void;
}

/** Which kind of thing each drawing tool makes. */
const TOOL_KIND: Record<string, DrawKind> = {
  text: 'text', leader: 'leader', line: 'line', arc: 'arc',
  polyline: 'polyline', rect: 'rect', circle: 'circle', hatch: 'hatch',
};

// ─── Preview ─────────────────────────────────────────────────────────────────

/** A real dimension, drawn through the same geometry the canvas uses. */
function Preview({ props }: { props: DimStyleProps }) {
  const W = 210, H = 76;
  const d = useMemo(() => dimDrawing({
    s1: { x: 26, y: 54 }, s2: { x: W - 26, y: 54 },
    n: { x: 0, y: -1 }, offset: 22,
    baseStroke: 0.9, baseFont: 11,
    props,
    label: formatDimLabel(3600, props),
  }), [props]);

  const label = formatDimLabel(3600, props);

  return (
    // `shrink-0` is load-bearing: the panel is a flex column with a capped
    // height, so a child that can shrink does — and this one would collapse to
    // nothing while the `<svg>` kept its own 76px and drew straight over the
    // section below it.
    <div className="shrink-0 rounded border border-border/50 bg-[#f8f7f4] overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" style={{ height: 76 }}>
        {/* Something to be measuring, so the extension lines have a reason. */}
        <rect x={26} y={54} width={W - 52} height={14} fill="#d8d4cc" stroke="#b3ada3" strokeWidth={0.5} />
        {d && (
          <>
            {d.extensions.map((e, i) => (
              <line key={i} x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y}
                stroke={props.lineColor} strokeWidth={d.strokeWidth} />
            ))}
            <line x1={d.dimLine.a.x} y1={d.dimLine.a.y} x2={d.dimLine.b.x} y2={d.dimLine.b.y}
              stroke={props.lineColor} strokeWidth={d.strokeWidth} strokeDasharray={d.dash} />
            {d.ticks.map((t, i) => (
              t.kind === 'line'
                ? <line key={i} x1={t.a.x} y1={t.a.y} x2={t.b.x} y2={t.b.y}
                    stroke={props.lineColor} strokeWidth={d.tickStrokeWidth} />
                : t.kind === 'dot'
                  ? <circle key={i} cx={t.c.x} cy={t.c.y} r={t.r} fill={props.lineColor} />
                  : <polygon key={i} points={t.points.map((q) => `${q.x},${q.y}`).join(' ')} fill={props.lineColor} />
            ))}
            {d.text && (
              <g transform={`translate(${d.text.x},${d.text.y}) rotate(${d.text.angle})`}>
                {d.background && (
                  <rect x={d.background.x} y={d.background.y}
                    width={d.background.width} height={d.background.height}
                    fill="#f8f7f4" fillOpacity={0.95} rx={d.background.rx} />
                )}
                <text x={0} y={0} textAnchor="middle" dominantBaseline="central"
                  fill={d.text.color} fontSize={d.text.size}
                  fontWeight={d.text.bold ? 600 : 400}>{label}</text>
              </g>
            )}
          </>
        )}
      </svg>
    </div>
  );
}

// ─── Small controls ──────────────────────────────────────────────────────────

function Row({ label, dot, onReset, children }: {
  label: string; dot?: boolean; onReset?: () => void; children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-1 min-h-[22px]">
      <span className="text-muted-foreground flex items-center gap-1 flex-1 min-w-0">
        {/* A field this dimension sets for itself, rather than taking from its style. */}
        {dot && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="Suprascris local" />}
        <span className="truncate">{label}</span>
        {dot && onReset && (
          <button onClick={onReset} title="Revino la stil"
            className="text-[10px] text-muted-foreground hover:text-foreground shrink-0">↺</button>
        )}
      </span>
      <div className="flex items-center gap-1 shrink-0">{children}</div>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, width = 'auto' }: {
  value: T; options: { v: T; label: string; title?: string }[]; onChange: (v: T) => void; width?: string;
}) {
  return (
    <div className="flex gap-0.5">
      {options.map(({ v, label, title }) => (
        <button key={v} title={title ?? label} onClick={() => onChange(v)}
          className={cn(
            'px-1.5 py-0.5 rounded border text-[10px] transition-colors leading-none min-w-[22px]',
            value === v
              ? 'bg-blue-600 text-white border-blue-700'
              : 'text-muted-foreground border-border/40 hover:bg-accent',
          )}
          style={{ width }}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Num({ value, min, max, step, onChange, suffix }: {
  value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; suffix?: string;
}) {
  return (
    <>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-16 accent-blue-500" />
      <span className="w-9 text-right text-muted-foreground tabular-nums">
        {Number.isInteger(step) ? value : value.toFixed(2)}{suffix}
      </span>
    </>
  );
}

function Color({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
      className="w-7 h-5 rounded cursor-pointer border border-border/50 p-0" />
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</span>
      {children}
    </div>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────

/**
 * The panel proper: one configurator that follows what you are pointing at.
 *
 * Which vocabulary it shows is not a tab the user has to find — it is decided
 * by the selection, falling back to the armed tool. Select a circle and it
 * offers stroke and fill; select a dimension and it offers ticks and units.
 */
export function StylePanel({
  selected, activeTool,
  currentDimStyleId, currentDrawStyleId,
  onCurrentDimStyleChange, onCurrentDrawStyleChange, onClose,
}: Props) {
  const isDim = selected ? selected.kind === 'dimension' : activeTool === 'dimension';
  return isDim
    ? <DimBody selected={selected as DimAnn | null}
        currentStyleId={currentDimStyleId} onCurrentStyleChange={onCurrentDimStyleChange} onClose={onClose} />
    : <DrawBody selected={selected}
        activeTool={activeTool}
        currentStyleId={currentDrawStyleId} onCurrentStyleChange={onCurrentDrawStyleChange} onClose={onClose} />;
}

interface DimBodyProps {
  selected: DimAnn | null;
  currentStyleId: string;
  onCurrentStyleChange: (id: string) => void;
  onClose: () => void;
}

function DimBody({ selected, currentStyleId, onCurrentStyleChange, onClose }: DimBodyProps) {
  const dimStyles = useBubbleGraphStore((s) => s.dimStyles);
  const upsertDimStyle = useBubbleGraphStore((s) => s.upsertDimStyle);
  const deleteDimStyle = useBubbleGraphStore((s) => s.deleteDimStyle);
  const updateAnnotation = useBubbleGraphStore((s) => s.updateAnnotation);

  const editingOne = selected !== null;
  const styleId = selected?.styleId ?? currentStyleId;
  const style = dimStyles.find((s) => s.id === styleId) ?? dimStyles[0];
  const props = resolveDimStyle(editingOne ? selected : { styleId }, dimStyles);
  const overridden = new Set(editingOne ? overriddenKeys(selected) : []);

  /** Writing a field goes to the annotation's overrides, or to the style. */
  const set = <K extends keyof DimStyleProps>(key: K, value: DimStyleProps[K]) => {
    if (editingOne) {
      updateAnnotation(selected.id, {
        override: { ...(selected.override ?? {}), [key]: value },
      } as Partial<DimAnn>);
    } else if (style) {
      upsertDimStyle({ ...style, [key]: value });
    }
  };

  /** Drop one override so the field takes its style's value again. */
  const reset = (key: keyof DimStyleProps) => {
    if (!editingOne) return;
    const next = { ...(selected.override ?? {}) };
    delete next[key];
    updateAnnotation(selected.id, { override: next } as Partial<DimAnn>);
  };

  const bind = <K extends keyof DimStyleProps>(key: K) => ({
    dot: overridden.has(key),
    onReset: () => reset(key),
  });

  const addStyle = () => {
    if (!style) return;
    const n = dimStyles.filter((s) => !s.builtin).length + 1;
    upsertDimStyle({
      ...style,
      id: `dim-${Date.now().toString(36)}`,
      name: `${style.name} ${n}`,
      builtin: false,
    });
  };

  const rename = () => {
    if (!style || style.builtin) return;
    const name = window.prompt('Numele stilului', style.name)?.trim();
    if (name) upsertDimStyle({ ...style, name });
  };

  return (
    <div className="flex flex-col gap-2 text-xs bg-background border border-border/70 rounded-lg shadow-xl p-3 w-[250px] select-none max-h-[78vh] overflow-y-auto">

      <div className="flex items-center justify-between">
        <span className="font-semibold text-foreground text-[11px]">Stil cotă</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground leading-none">✕</button>
      </div>

      {/* What am I editing? The single most important line in the panel. */}
      <div className={cn(
        'text-[10px] rounded px-2 py-1 leading-snug',
        editingOne ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
      )}>
        {editingOne
          ? 'Editezi cota selectată. Modificările devin suprascrieri doar pentru ea.'
          : 'Editezi stilul. Se schimbă toate cotele care îl folosesc.'}
      </div>

      <Preview props={props} />

      {/* ── Style selector ── */}
      <Group label="Stil">
        <div className="flex items-center gap-1">
          <select
            value={styleId}
            onChange={(e) => {
              if (editingOne) updateAnnotation(selected.id, { styleId: e.target.value } as Partial<DimAnn>);
              else onCurrentStyleChange(e.target.value);
            }}
            className="flex-1 min-w-0 px-1 py-0.5 border border-border rounded bg-background text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {dimStyles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={addStyle} title="Stil nou, pornind de la acesta"
            className="w-6 h-6 rounded border border-border/40 text-muted-foreground hover:bg-accent">+</button>
          <button onClick={rename} disabled={!style || style.builtin}
            title={style?.builtin ? 'Un stil implicit nu poate fi redenumit' : 'Redenumește'}
            className="w-6 h-6 rounded border border-border/40 text-muted-foreground hover:bg-accent disabled:opacity-30">✎</button>
          <button
            onClick={() => style && !style.builtin && deleteDimStyle(style.id)}
            disabled={!style || style.builtin}
            title={style?.builtin ? 'Un stil implicit nu poate fi șters' : 'Șterge stilul'}
            className="w-6 h-6 rounded border border-border/40 text-muted-foreground hover:bg-red-50 hover:text-red-600 disabled:opacity-30">🗑</button>
        </div>
        {editingOne && overridden.size > 0 && (
          <button
            onClick={() => updateAnnotation(selected.id, { override: {} } as Partial<DimAnn>)}
            className="text-[10px] text-amber-700 dark:text-amber-400 border border-amber-500/40 rounded px-2 py-0.5 hover:bg-amber-500/10">
            ↺ Revino complet la stil ({overridden.size})
          </button>
        )}
      </Group>

      <div className="border-t border-border/40" />

      {/* ── Line ── */}
      <Group label="Linie">
        <Row label="Culoare" {...bind('lineColor')}>
          <Color value={props.lineColor} onChange={(v) => set('lineColor', v)} />
        </Row>
        <Row label="Grosime" {...bind('lineWeight')}>
          <Num value={props.lineWeight} min={0.05} max={6} step={0.05} onChange={(v) => set('lineWeight', v)} suffix="×" />
        </Row>
        <Row label="Stil" {...bind('lineStyle')}>
          <Seg<LineStyle> value={props.lineStyle} onChange={(v) => set('lineStyle', v)}
            options={[{ v: 'solid', label: '—' }, { v: 'dashed', label: '- -' }, { v: 'dotted', label: '···' }]} />
        </Row>
      </Group>

      <div className="border-t border-border/40" />

      {/* ── Terminators ── */}
      <Group label="Capete">
        <Row label="Tip" {...bind('tick')}>
          <Seg<DimTick> value={props.tick} onChange={(v) => set('tick', v)}
            options={[
              { v: 'oblique', label: '╱', title: 'Liniuță oblică' },
              { v: 'arrow', label: '▸', title: 'Săgeată' },
              { v: 'dot', label: '•', title: 'Punct' },
              { v: 'none', label: '∅', title: 'Fără' },
            ]} />
        </Row>
        <Row label="Mărime" {...bind('tickSize')}>
          <Num value={props.tickSize} min={1} max={10} step={0.5} onChange={(v) => set('tickSize', v)} suffix="×" />
        </Row>
        <Row label="Grosime capăt" {...bind('tickWeight')}>
          <Num value={props.tickWeight} min={0.1} max={6} step={0.1} onChange={(v) => set('tickWeight', v)} suffix="×" />
        </Row>
      </Group>

      <div className="border-t border-border/40" />

      {/* ── Extension lines ── */}
      <Group label="Linii de extensie">
        <Row label="Afișează" {...bind('extension')}>
          <Seg<'da' | 'nu'> value={props.extension ? 'da' : 'nu'}
            onChange={(v) => set('extension', v === 'da')}
            options={[{ v: 'da', label: 'Da' }, { v: 'nu', label: 'Nu' }]} />
        </Row>
        <Row label="Spațiu la punct" {...bind('extGap')}>
          <Num value={props.extGap} min={0} max={8} step={0.5} onChange={(v) => set('extGap', v)} suffix="×" />
        </Row>
        <Row label="Depășire" {...bind('extOvershoot')}>
          <Num value={props.extOvershoot} min={0} max={10} step={0.5} onChange={(v) => set('extOvershoot', v)} suffix="×" />
        </Row>
      </Group>

      <div className="border-t border-border/40" />

      {/* ── Text ── */}
      <Group label="Text">
        <Row label="Culoare" {...bind('textColor')}>
          <Color value={props.textColor} onChange={(v) => set('textColor', v)} />
        </Row>
        <Row label="Mărime" {...bind('textSize')}>
          <Num value={props.textSize} min={0.2} max={4} step={0.1} onChange={(v) => set('textSize', v)} suffix="×" />
        </Row>
        <Row label="Poziție" {...bind('textPlacement')}>
          <Seg<DimTextPlacement> value={props.textPlacement} onChange={(v) => set('textPlacement', v)}
            options={[
              { v: 'above', label: '↑', title: 'Deasupra liniei' },
              { v: 'inline', label: '—', title: 'Pe linie' },
              { v: 'below', label: '↓', title: 'Sub linie' },
            ]} />
        </Row>
        <Row label="Decalaj" {...bind('textOffset')}>
          <Num value={props.textOffset} min={0} max={2} step={0.05} onChange={(v) => set('textOffset', v)} suffix="×" />
        </Row>
        <Row label="Aliniat la linie" {...bind('textAligned')}>
          <Seg<'da' | 'nu'> value={props.textAligned ? 'da' : 'nu'}
            onChange={(v) => set('textAligned', v === 'da')}
            options={[{ v: 'da', label: 'Da' }, { v: 'nu', label: 'Orizontal' }]} />
        </Row>
        <Row label="Fundal" {...bind('textBackground')}>
          <Seg<'da' | 'nu'> value={props.textBackground ? 'da' : 'nu'}
            onChange={(v) => set('textBackground', v === 'da')}
            options={[{ v: 'da', label: 'Da' }, { v: 'nu', label: 'Nu' }]} />
        </Row>
        <Row label="Îngroșat" {...bind('textBold')}>
          <Seg<'da' | 'nu'> value={props.textBold ? 'da' : 'nu'}
            onChange={(v) => set('textBold', v === 'da')}
            options={[{ v: 'da', label: 'B' }, { v: 'nu', label: 'n' }]} />
        </Row>
      </Group>

      <div className="border-t border-border/40" />

      {/* ── Units ── */}
      <Group label="Unități">
        <Row label="Unitate" {...bind('unit')}>
          <Seg<DimUnit> value={props.unit} onChange={(v) => set('unit', v)}
            options={[
              { v: 'auto', label: 'auto', title: 'Metri peste 1 m, altfel milimetri' },
              { v: 'mm', label: 'mm' }, { v: 'cm', label: 'cm' }, { v: 'm', label: 'm' },
            ]} />
        </Row>
        <Row label="Zecimale" {...bind('precision')}>
          <Num value={props.precision} min={0} max={4} step={1} onChange={(v) => set('precision', v)} />
        </Row>
        <Row label="Simbol unitate" {...bind('showUnit')}>
          <Seg<'da' | 'nu'> value={props.showUnit ? 'da' : 'nu'}
            onChange={(v) => set('showUnit', v === 'da')}
            options={[{ v: 'da', label: 'Da' }, { v: 'nu', label: 'Nu' }]} />
        </Row>
        <Row label="Sufix" {...bind('suffix')}>
          <input type="text" value={props.suffix} maxLength={12}
            onChange={(e) => set('suffix', e.target.value)}
            placeholder="ex. typ."
            className="w-20 px-1 py-0.5 border border-border rounded bg-background text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
        </Row>
      </Group>

      {/* Offered for the built-ins too: resetting VALUES is not deleting the
          style, and a built-in someone has dragged out of shape is exactly the
          one they cannot otherwise get back. */}
      {!editingOne && style && (
        <button
          onClick={() => upsertDimStyle({ ...style, ...DEFAULT_DIM_STYLE_PROPS })}
          className="text-[10px] text-muted-foreground hover:text-foreground border border-border/40 rounded px-2 py-0.5 shrink-0">
          ↺ Readu stilul la valorile implicite
        </button>
      )}
    </div>
  );
}

// ─── Draw body ───────────────────────────────────────────────────────────────

interface DrawBodyProps {
  selected: DrawingAnnotation | null;
  activeTool: string | null;
  currentStyleId: string;
  onCurrentStyleChange: (id: string) => void;
  onClose: () => void;
}

/**
 * Text, leaders, lines, shapes and hatches.
 *
 * Only the groups that mean something for the kind in hand are shown — a
 * circle is not asked about its hatch angle — because a control that cannot
 * take effect reads as a broken one. With nothing selected and no tool armed
 * there is no kind to narrow by, so everything is offered.
 */
function DrawBody({ selected, activeTool, currentStyleId, onCurrentStyleChange, onClose }: DrawBodyProps) {
  const drawStyles = useBubbleGraphStore((s) => s.drawStyles);
  const upsertDrawStyle = useBubbleGraphStore((s) => s.upsertDrawStyle);
  const deleteDrawStyle = useBubbleGraphStore((s) => s.deleteDrawStyle);
  const updateAnnotation = useBubbleGraphStore((s) => s.updateAnnotation);

  const editingOne = selected !== null;
  const styleId = selected?.styleId ?? currentStyleId;
  const style = drawStyles.find((s) => s.id === styleId) ?? drawStyles[0];
  const props = resolveDrawStyle(editingOne ? selected : { styleId }, drawStyles);
  const overridden = new Set(editingOne ? drawOverriddenKeys(selected) : []);

  const kind: DrawKind | null =
    (selected && selected.kind !== 'dimension' ? (selected.kind as DrawKind) : null)
    ?? (activeTool ? TOOL_KIND[activeTool] ?? null : null);
  const show = kind ? RELEVANT[kind] : { stroke: true, fill: true, text: true, arrow: true, hatch: true };

  const set = <K extends keyof DrawStyleProps>(key: K, value: DrawStyleProps[K]) => {
    if (editingOne) {
      updateAnnotation(selected.id, {
        override: { ...(selected.override ?? {}), [key]: value },
      } as Partial<DrawingAnnotation>);
    } else if (style) {
      upsertDrawStyle({ ...style, [key]: value });
    }
  };

  const reset = (key: keyof DrawStyleProps) => {
    if (!editingOne) return;
    // `override` is typed as a union across annotation kinds; this body only
    // ever runs for the draw kinds, whose override is a `DrawOverride`.
    const next: DrawOverride = { ...((selected.override ?? {}) as DrawOverride) };
    delete next[key];
    updateAnnotation(selected.id, { override: next } as Partial<DrawingAnnotation>);
  };

  const bind = <K extends keyof DrawStyleProps>(key: K) => ({
    dot: overridden.has(key),
    onReset: () => reset(key),
  });

  const addStyle = () => {
    if (!style) return;
    upsertDrawStyle({
      ...style,
      id: `draw-${Date.now().toString(36)}`,
      name: `${style.name} ${drawStyles.filter((s) => !s.builtin).length + 1}`,
      builtin: false,
    });
  };

  const rename = () => {
    if (!style || style.builtin) return;
    const name = window.prompt('Numele stilului', style.name)?.trim();
    if (name) upsertDrawStyle({ ...style, name });
  };

  const KIND_LABEL: Record<DrawKind, string> = {
    text: 'text', leader: 'indicator', line: 'linie', arc: 'arc',
    polyline: 'polilinie', rect: 'dreptunghi', circle: 'cerc', hatch: 'hașură',
  };

  return (
    <div className="flex flex-col gap-2 text-xs bg-background border border-border/70 rounded-lg shadow-xl p-3 w-[250px] select-none max-h-[78vh] overflow-y-auto">
      <div className="flex items-center justify-between shrink-0">
        <span className="font-semibold text-foreground text-[11px]">
          Stil desen{kind ? ` · ${KIND_LABEL[kind]}` : ''}
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground leading-none">✕</button>
      </div>

      <div className={cn(
        'text-[10px] rounded px-2 py-1 leading-snug shrink-0',
        editingOne ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
      )}>
        {editingOne
          ? 'Editezi elementul selectat. Modificările devin suprascrieri doar pentru el.'
          : 'Editezi stilul. Se schimbă toate elementele care îl folosesc.'}
      </div>

      <DrawPreview props={props} kind={kind} />

      <Group label="Stil">
        <div className="flex items-center gap-1">
          <select
            value={styleId}
            onChange={(e) => {
              if (editingOne) updateAnnotation(selected.id, { styleId: e.target.value } as Partial<DrawingAnnotation>);
              else onCurrentStyleChange(e.target.value);
            }}
            className="flex-1 min-w-0 px-1 py-0.5 border border-border rounded bg-background text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {drawStyles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={addStyle} title="Stil nou, pornind de la acesta"
            className="w-6 h-6 rounded border border-border/40 text-muted-foreground hover:bg-accent">+</button>
          <button onClick={rename} disabled={!style || style.builtin}
            title={style?.builtin ? 'Un stil implicit nu poate fi redenumit' : 'Redenumește'}
            className="w-6 h-6 rounded border border-border/40 text-muted-foreground hover:bg-accent disabled:opacity-30">✎</button>
          <button onClick={() => style && !style.builtin && deleteDrawStyle(style.id)}
            disabled={!style || style.builtin}
            title={style?.builtin ? 'Un stil implicit nu poate fi șters' : 'Șterge stilul'}
            className="w-6 h-6 rounded border border-border/40 text-muted-foreground hover:bg-red-50 hover:text-red-600 disabled:opacity-30">🗑</button>
        </div>
        {editingOne && overridden.size > 0 && (
          <button
            onClick={() => updateAnnotation(selected.id, { override: {} } as Partial<DrawingAnnotation>)}
            className="text-[10px] text-amber-700 dark:text-amber-400 border border-amber-500/40 rounded px-2 py-0.5 hover:bg-amber-500/10">
            ↺ Revino complet la stil ({overridden.size})
          </button>
        )}
      </Group>

      {show.stroke && (
        <>
          <div className="border-t border-border/40" />
          <Group label="Linie">
            <Row label="Culoare" {...bind('lineColor')}>
              <Color value={props.lineColor} onChange={(v) => set('lineColor', v)} />
            </Row>
            <Row label="Grosime" {...bind('lineWeight')}>
              <Num value={props.lineWeight} min={0.05} max={6} step={0.05}
                onChange={(v) => set('lineWeight', v)} suffix="×" />
            </Row>
            <Row label="Stil" {...bind('lineStyle')}>
              <Seg<LineStyle> value={props.lineStyle} onChange={(v) => set('lineStyle', v)}
                options={[{ v: 'solid', label: '—' }, { v: 'dashed', label: '- -' }, { v: 'dotted', label: '···' }]} />
            </Row>
          </Group>
        </>
      )}

      {show.fill && (
        <>
          <div className="border-t border-border/40" />
          <Group label="Umplere">
            <Row label="Culoare" {...bind('fillColor')}>
              <Color value={props.fillColor} onChange={(v) => set('fillColor', v)} />
            </Row>
            <Row label="Opacitate" {...bind('fillOpacity')}>
              <Num value={props.fillOpacity} min={0} max={1} step={0.05}
                onChange={(v) => set('fillOpacity', v)} />
            </Row>
          </Group>
        </>
      )}

      {show.text && (
        <>
          <div className="border-t border-border/40" />
          <Group label="Text">
            <Row label="Culoare" {...bind('textColor')}>
              <Color value={props.textColor} onChange={(v) => set('textColor', v)} />
            </Row>
            <Row label="Mărime" {...bind('textSize')}>
              <Num value={props.textSize} min={0.2} max={4} step={0.1}
                onChange={(v) => set('textSize', v)} suffix="×" />
            </Row>
            <Row label="Îngroșat" {...bind('textBold')}>
              <Seg<'da' | 'nu'> value={props.textBold ? 'da' : 'nu'}
                onChange={(v) => set('textBold', v === 'da')}
                options={[{ v: 'da', label: 'B' }, { v: 'nu', label: 'n' }]} />
            </Row>
          </Group>
        </>
      )}

      {show.arrow && (
        <>
          <div className="border-t border-border/40" />
          <Group label="Săgeată">
            <Row label="Mărime" {...bind('arrowSize')}>
              <Num value={props.arrowSize} min={0.1} max={2} step={0.05}
                onChange={(v) => set('arrowSize', v)} suffix="×" />
            </Row>
          </Group>
        </>
      )}

      {show.hatch && (
        <>
          <div className="border-t border-border/40" />
          <Group label="Hașură">
            <div className="grid grid-cols-4 gap-1">
              {HATCH_PATTERNS.map(({ id, label }) => (
                <button key={id} title={label} onClick={() => set('hatchPattern', id)}
                  className={cn(
                    'h-7 rounded border text-[9px] transition-colors leading-tight px-0.5',
                    props.hatchPattern === id
                      ? 'bg-blue-600 text-white border-blue-700'
                      : 'text-muted-foreground border-border/40 hover:bg-accent',
                  )}>{label}</button>
              ))}
            </div>
            <Row label="Densitate" {...bind('hatchSpacing')}>
              <Num value={props.hatchSpacing} min={0.3} max={3} step={0.1}
                onChange={(v) => set('hatchSpacing', v)} suffix="×" />
            </Row>
            <Row label="Unghi" {...bind('hatchAngle')}>
              <Num value={props.hatchAngle} min={0} max={180} step={5}
                onChange={(v) => set('hatchAngle', v)} suffix="°" />
            </Row>
            <Row label="Opacitate" {...bind('hatchOpacity')}>
              <Num value={props.hatchOpacity} min={0} max={1} step={0.05}
                onChange={(v) => set('hatchOpacity', v)} />
            </Row>
          </Group>
        </>
      )}

      {!editingOne && style && (
        <button
          onClick={() => upsertDrawStyle({ ...style, ...DEFAULT_DRAW_STYLE_PROPS })}
          className="text-[10px] text-muted-foreground hover:text-foreground border border-border/40 rounded px-2 py-0.5 shrink-0">
          ↺ Readu stilul la valorile implicite
        </button>
      )}
    </div>
  );
}

/** A sample of the kind in hand, inked exactly as the drawing would ink it. */
function DrawPreview({ props, kind }: { props: DrawStyleProps; kind: DrawKind | null }) {
  const W = 210, H = 60;
  const sw = props.lineWeight * 3;          // a plausible base stroke for a chip this size
  const fs = props.textSize * 13;
  const dash = dashFor(props.lineStyle, 3);
  const stroke = { stroke: props.lineColor, strokeWidth: sw, strokeDasharray: dash, fill: 'none' as const };

  return (
    <div className="shrink-0 rounded border border-border/50 bg-[#f8f7f4] overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" style={{ height: 60 }}>
        {kind === 'text' ? (
          <text x={W / 2} y={H / 2} textAnchor="middle" dominantBaseline="central"
            fill={props.textColor} fontSize={fs} fontWeight={props.textBold ? 'bold' : 'normal'}>Text</text>
        ) : kind === 'circle' ? (
          <circle cx={W / 2} cy={H / 2} r={20} {...stroke}
            fill={props.fillColor} fillOpacity={props.fillOpacity} />
        ) : kind === 'leader' ? (
          <>
            <polyline points={`30,${H - 14} 70,20 110,20`} {...stroke} />
            <polygon points={`30,${H - 14} ${30 + props.arrowSize * 16},${H - 14 - props.arrowSize * 6} ${30 + props.arrowSize * 7},${H - 14 - props.arrowSize * 17}`}
              fill={props.lineColor} />
            <text x={114} y={18} fill={props.textColor} fontSize={fs}
              fontWeight={props.textBold ? 'bold' : 'normal'}>Notă</text>
          </>
        ) : kind === 'arc' ? (
          <path d={`M 40 ${H - 16} A 65 65 0 0 1 170 ${H - 16}`} {...stroke} />
        ) : kind === 'hatch' ? (
          <rect x={30} y={12} width={W - 60} height={H - 24}
            fill={props.lineColor} fillOpacity={props.hatchOpacity}
            stroke={props.lineColor} strokeWidth={sw} />
        ) : kind === 'line' ? (
          <line x1={26} y1={H / 2} x2={W - 26} y2={H / 2} {...stroke} />
        ) : (
          // rect, polyline, or nothing in particular
          <rect x={30} y={12} width={W - 60} height={H - 24} {...stroke}
            fill={props.fillColor} fillOpacity={props.fillOpacity} />
        )}
      </svg>
    </div>
  );
}
