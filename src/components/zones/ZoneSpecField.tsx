/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ZoneSpecField — ce lucrare se face pe O BANDĂ de înălțime.
 *
 * Un element (cameră, perete, anvelopă) nu e obligatoriu același pe toată
 * verticala: faianță pe primii 1.5 m și tencuială în rest, soclu din BCA pe
 * primii 30 cm. Banda își poartă propriile alegeri, iar câmpul ăsta le editează
 * — aceleași grupuri de specificații pe care le rotește bara de scenarii, doar
 * că aplicate pe o felie.
 *
 * „Ca elementul" nu e o alegere, e absența ei: banda moștenește ce zice nodul,
 * care moștenește proiectul. Doar abaterile se scriu, deci o bandă neatinsă nu
 * îngheață implicitul de azi în proiect.
 *
 * Se serializează în câmpul `spec` al benzii, ca `grup:opțiune` separate prin
 * virgulă — forma pe care o citește `lib/zones/heightZones.ts`.
 */
import { parseZoneSpecs } from '@/lib/zones/heightZones';
import { specGroupsFor } from '@/lib/norms/specs';

interface ZoneSpecFieldProps {
  /** `room`, `wall` sau `shell` — decide ce grupuri se pot alege. */
  nodeType: string;
  /** Câmpul `spec` al benzii, așa cum e scris acum. */
  value: unknown;
  onChange: (next: string | undefined) => void;
}

const serialise = (specs: Record<string, string>): string | undefined => {
  const parts = Object.entries(specs).map(([g, o]) => `${g}:${o}`);
  return parts.length > 0 ? parts.join(', ') : undefined;
};

export function ZoneSpecField({ nodeType, value, onChange }: ZoneSpecFieldProps) {
  const groups = specGroupsFor(nodeType);
  if (groups.length === 0) return null;

  const current = parseZoneSpecs(value, nodeType);

  const set = (groupId: string, optionId: string) => {
    const next = { ...current };
    if (optionId) next[groupId] = optionId;
    else delete next[groupId];
    onChange(serialise(next));
  };

  return (
    <>
      <span
        className="text-muted-foreground"
        title="Ce lucrare se decontează pe banda asta. Neatins = ca elementul."
      >
        Lucrare
      </span>
      <div className="flex flex-col gap-1">
        {groups.map((g) => (
          <select
            key={g.id}
            className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
            title={g.description ?? g.label}
            value={current[g.id] ?? ''}
            onChange={(e) => set(g.id, e.target.value)}
          >
            <option value="">{g.label}: ca elementul</option>
            {g.options.map((o) => (
              <option key={o.id} value={o.id}>{g.label}: {o.label}</option>
            ))}
          </select>
        ))}
      </div>
    </>
  );
}
