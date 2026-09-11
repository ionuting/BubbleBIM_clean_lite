/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ShellZonesEditor — benzile pe înălțime ale anvelopei.
 *
 * Camera avea deja `covering_layers` și peretele `wall_layers`, cu editor și
 * preseturi. Anvelopa n-avea nimic, deși e chiar suprafața pe care banda
 * contează cel mai mult: soclul se termoizolează cu XPS și se finisează cu
 * mozaic, câmpul de deasupra cu EPS și tencuială decorativă. Aici se scrie
 * `shell_zones`, aceeași formă JSON ca celelalte două.
 *
 * O singură bandă nu e o zonare: motorul o ignoră și măsoară anvelopa întreagă.
 */
import { ZoneSpecField } from './ZoneSpecField';

export interface ShellZone {
  from_mm: number;
  to_mm: number;
  label?: string;
  spec?: string;
}

interface Props {
  /** `shell_zones` așa cum e scris în proprietăți (JSON sau tablou). */
  value: unknown;
  /** Înălțimea anvelopei, pentru banda implicită. */
  heightMm: number;
  onChange: (serialised: string | undefined) => void;
}

function parse(value: unknown, heightMm: number): ShellZone[] {
  if (value == null || value === '') return [{ from_mm: 0, to_mm: heightMm }];
  try {
    const raw = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(raw) || raw.length === 0) return [{ from_mm: 0, to_mm: heightMm }];
    return raw.map((l) => ({
      from_mm: Number(l?.from_mm ?? 0),
      to_mm: Number(l?.to_mm ?? heightMm),
      label: typeof l?.label === 'string' ? l.label : undefined,
      spec: typeof l?.spec === 'string' ? l.spec : undefined,
    }));
  } catch {
    return [{ from_mm: 0, to_mm: heightMm }];
  }
}

/** Presetul care acoperă cazul obișnuit: soclu hidrofug, câmp termoizolat. */
const SOCLE_MM = 500;

export function ShellZonesEditor({ value, heightMm, onChange }: Props) {
  const zones = parse(value, heightMm);
  const write = (next: ShellZone[]) => onChange(next.length > 1 ? JSON.stringify(next) : undefined);

  const update = (idx: number, patch: Partial<ShellZone>) =>
    write(zones.map((z, i) => (i === idx ? { ...z, ...patch } : z)));

  return (
    <>
      <div className="flex items-center gap-2 mt-2 mb-1">
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
          Benzi pe înălțime
        </span>
        <button
          type="button"
          className="text-[10px] border border-border rounded px-1.5 py-0.5 hover:bg-accent"
          title="Soclu de 50 cm, câmp deasupra"
          onClick={() => write([
            { from_mm: 0, to_mm: Math.min(SOCLE_MM, heightMm), label: 'Soclu' },
            { from_mm: Math.min(SOCLE_MM, heightMm), to_mm: heightMm, label: 'Câmp' },
          ])}
        >
          Soclu + câmp
        </button>
        <button
          type="button"
          className="text-[10px] border border-border rounded px-1.5 py-0.5 hover:bg-accent"
          onClick={() => {
            const lastTo = Number(zones[zones.length - 1]?.to_mm ?? 0);
            write([...zones, { from_mm: lastTo, to_mm: Math.max(lastTo, heightMm) }]);
          }}
        >
          + Bandă
        </button>
        {zones.length > 1 && (
          <button
            type="button"
            className="ml-auto text-[10px] text-muted-foreground hover:text-red-400"
            title="Înapoi la o anvelopă nezonată"
            onClick={() => onChange(undefined)}
          >
            Fără benzi
          </button>
        )}
      </div>

      {zones.length > 1 && (
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
          {zones.map((z, idx) => (
            <div key={`shell-zone-${idx}`} style={{ display: 'contents' }}>
              <span className="text-muted-foreground col-span-2 text-[10px] font-medium pt-1">
                Banda {idx + 1} — {z.from_mm}–{z.to_mm} mm
              </span>
              <span className="text-muted-foreground">De la (mm)</span>
              <input
                type="number" step="50"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={z.from_mm}
                onChange={(e) => update(idx, { from_mm: parseFloat(e.target.value) || 0 })}
              />
              <span className="text-muted-foreground">Până la (mm)</span>
              <input
                type="number" step="50"
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
                value={z.to_mm}
                onChange={(e) => update(idx, { to_mm: parseFloat(e.target.value) || 0 })}
              />
              <ZoneSpecField
                nodeType="shell"
                value={z.spec}
                onChange={(spec) => update(idx, { spec })}
              />
              {zones.length > 1 && (
                <>
                  <span />
                  <button
                    type="button"
                    className="justify-self-start text-[10px] text-muted-foreground hover:text-red-400"
                    onClick={() => write(zones.filter((_, i) => i !== idx))}
                  >
                    Șterge banda
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
