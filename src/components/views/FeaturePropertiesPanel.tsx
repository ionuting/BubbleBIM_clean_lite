/**
 * FeaturePropertiesPanel — the attributes of a picked CityJSON object or
 * 3D Tiles feature.
 *
 * A sibling of `IfcPropertiesPanel` rather than an extension of it: that one
 * knows what a pset is, what a GUID is and what an IFC class is, and none of
 * those exist here. What these layers have is a bag of names and values the
 * file's author chose, so the panel's job is to show them honestly and say
 * where they came from — not to pretend they are something richer.
 *
 * The visual language is deliberately the same, so a click in the world view
 * reads the same whichever layer it lands on.
 */
import { useState } from 'react';
import type { PickedFeature } from '@/lib/featurePick';

interface Props {
  feature: PickedFeature;
  onClose: () => void;
  className?: string;
}

const SOURCE_LABEL: Record<PickedFeature['source'], string> = {
  cityjson: 'CityJSON',
  tiles: '3D Tiles',
};

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <table className="w-full text-[11px]">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-t border-border/40">
            <td className="px-2 py-0.5 text-muted-foreground align-top w-[45%] break-words">{k}</td>
            <td className="px-2 py-0.5 text-foreground font-mono break-all">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Group({ title, count, children }: {
  title: string; count: number; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-border rounded overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-2 py-1 bg-muted/50 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-[11px] font-semibold text-foreground truncate">{title}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{count}</span>
          <span className="text-[10px] text-muted-foreground">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && children}
    </div>
  );
}

export function FeaturePropertiesPanel({ feature, onClose, className }: Props) {
  return (
    <div
      className={`flex flex-col bg-card border border-border rounded-md shadow-xl overflow-hidden ${className ?? ''}`}
    >
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border bg-muted/50">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Proprietăți {SOURCE_LABEL[feature.source]}
          </div>
          <div className="text-xs text-foreground truncate" title={feature.title}>
            {feature.title}
          </div>
          <div className="text-[10px] text-muted-foreground truncate" title={feature.layer}>
            {feature.subtitle} · {feature.layer}
          </div>
        </div>
        <button
          className="text-muted-foreground hover:text-foreground text-sm px-1"
          onClick={onClose} title="Închide"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
        {feature.identity.length > 0 && (
          <div className="text-[11px] grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 px-1">
            {feature.identity.map(([k, v]) => (
              <span key={k} className="contents">
                <span className="text-muted-foreground">{k}</span>
                <span className="text-foreground font-mono text-[10px] break-all">{v}</span>
              </span>
            ))}
          </div>
        )}

        {feature.groups.map((g) => (
          <Group key={g.name} title={g.name} count={g.rows.length}>
            <Rows rows={g.rows} />
          </Group>
        ))}

        {feature.groups.length === 0 && (
          <div className="text-[10px] text-muted-foreground px-1">
            {feature.source === 'tiles'
              ? 'Tileset-ul nu are tabel de metadate — geometrie fără atribute.'
              : 'Obiectul nu are atribute în fișier.'}
          </div>
        )}
      </div>
    </div>
  );
}
