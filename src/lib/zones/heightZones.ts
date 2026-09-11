/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * heightZones.ts — un element împărțit în BENZI pe înălțime, pentru cantități.
 *
 * DE CE
 * -----
 * O cameră are faianță pe primii 1.5 m și tencuială în rest. Un perete are
 * soclul din BCA și restul din cărămidă. O fațadă are soclu hidrofug jos și
 * termosistem deasupra. În toate trei, elementul e UNUL singur în graf, dar
 * lucrarea de pe el nu e uniformă pe verticală.
 *
 * MODELUL EXISTA DEJA — DOAR CĂ NU AJUNGEA ÎN DEVIZ
 * -------------------------------------------------
 * Aplicația avea deja benzile, în două locuri, cu preseturi și editor:
 *
 *   room  → `covering_layers`  (preset „Baie": 0–1500 faianță, 1500–2800 tencuială)
 *   wall  → `wall_layers`      (preset „Soclu BCA": 0–600 BCA, 600–3000 zidărie)
 *
 * Amândouă mișcau doar CULOAREA în 3D. Modulul ăsta le citește pe amândouă prin
 * aceeași ușă, adaugă `shell` (`shell_zones`, aceeași formă JSON) și le dă
 * motorului de antemăsurători. Nu e un al treilea mecanism paralel: e cel care
 * lipsea la capătul celor două care existau.
 *
 * CE POARTĂ O BANDĂ
 * -----------------
 * Două feluri de suprascriere, fiindcă întrebarea „ce se schimbă pe verticală"
 * are două răspunsuri diferite:
 *
 *   `spec`  — ce LUCRARE: `faianta:standard`, `tencuiala_int:fara`. Rotește
 *             articolele prin exact aceleași specificații ca bara de scenarii.
 *   `props` — ce ELEMENT: `wall_type` altul pe soclu. Schimbă tipul pe care
 *             regulile îl potrivesc.
 *
 * ACOPERIREA E OBLIGATORIE
 * ------------------------
 * Benzile se decupează pe înălțimea MĂSURATĂ a nodului, nu pe cea din
 * proprietăți (cele două pot să nu fie de acord — vezi `getRoomHeightMm` vs
 * `measureRoom`), iar ultima bandă se întinde până sus. O bandă lipsă ar
 * însemna cantitate lipsă în tăcere, ceea ce e mai rău decât o bandă greșită.
 *
 * Pur: fără store, fără React.
 */
import type { BubbleGraphNode } from '@/store';
import { specGroupsFor, specMaterial, type SpecSelection } from '@/lib/norms/specs';

/** Proprietatea care poartă benzile, pe tip de nod. */
export const ZONE_PROPERTY: Record<string, string> = {
  room: 'covering_layers',
  wall: 'wall_layers',
  shell: 'shell_zones',
};

/** Tipurile care pot fi zonate. Restul se măsoară întreg, ca până acum. */
export const ZONABLE_TYPES = Object.keys(ZONE_PROPERTY);

export const isZonable = (nodeType: string): boolean => nodeType in ZONE_PROPERTY;

/** O bandă rezolvată pe înălțimea reală a nodului. */
export interface HeightZone {
  /** Cota inferioară, în metri de la baza elementului. */
  fromM: number;
  /** Cota superioară, în metri. */
  toM: number;
  heightM: number;
  /** Ce se vede în urma de calcul: `0.00–1.50 m`, plus eticheta dacă există. */
  label: string;
  /** Alegerile de specificație în vigoare în bandă. Gol = ce zice nodul. */
  specs: SpecSelection;
  /** Suprascrieri de proprietate — alt `wall_type` pe soclu. */
  props: Record<string, string>;
}

const M2 = (n: number) => n.toFixed(2);

/**
 * `faianta:standard, tencuiala_int:fara` → `{faianta:'standard', tencuiala_int:'fara'}`.
 *
 * Validat pe grupurile pe care tipul de nod le acceptă: un id greșit e IGNORAT,
 * nu propagat, exact ca la `parseSpecSelection` — o greșeală de tastare n-are
 * voie să inventeze o opțiune.
 */
export function parseZoneSpecs(raw: unknown, nodeType: string): SpecSelection {
  const out: SpecSelection = {};
  if (raw == null) return out;

  const groups = specGroupsFor(nodeType);
  const entries: Array<[string, string]> = [];

  if (typeof raw === 'string') {
    for (const part of raw.split(',')) {
      const [g, o] = part.split(':').map((s) => s.trim());
      if (g && o) entries.push([g, o]);
    }
  } else if (typeof raw === 'object') {
    for (const [g, o] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof o === 'string') entries.push([g, o]);
    }
  }

  for (const [gid, oid] of entries) {
    const g = groups.find((x) => x.id === gid);
    if (g && g.options.some((o) => o.id === oid)) out[gid] = oid;
  }
  return out;
}

/** Suprascrierile de proprietate declarate de o bandă. */
function parseZoneProps(layer: Record<string, unknown>, nodeType: string): Record<string, string> {
  const out: Record<string, string> = {};
  const explicit = layer.props;
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
    for (const [k, v] of Object.entries(explicit as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') out[k] = v;
    }
  }
  // Comoditate: banda unui perete își poate declara direct tipul, fiindcă asta
  // e forma pe care `wall_layers` o are deja scrisă în proiectele existente.
  if (nodeType === 'wall' && typeof layer.wall_type === 'string' && layer.wall_type !== '') {
    out.wall_type = layer.wall_type;
  }
  return out;
}

/**
 * Benzile brute dintr-o proprietate. Aceeași formă JSON pentru toate trei
 * sursele, deci un singur parser.
 *
 * Deliberat NU importă `parseWallLayersFromProps` / `parseCoveringLayersFromProps`:
 * modulele alea au ajuns să depindă de ăsta (banda decide și materialul cu care
 * se desenează), iar un ciclu între ele ar fi o capcană de inițializare pentru
 * un câștig de zece rânduri.
 */
function parseBands(raw: unknown): Array<Record<string, unknown>> | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return null;
    const out = parsed.filter((l) => l && typeof l === 'object'
      && Number.isFinite(Number((l as Record<string, unknown>).from_mm))
      && Number.isFinite(Number((l as Record<string, unknown>).to_mm)));
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function rawLayers(node: BubbleGraphNode): Array<Record<string, unknown>> | null {
  const props = node.properties ?? {};
  // Camera poartă benzi doar dacă are covering — altfel nu are ce zona.
  if (node.type === 'room' && (props.has_covering === 'False' || props.has_covering === false)) return null;
  const key = ZONE_PROPERTY[node.type];
  return key ? parseBands(props[key]) : null;
}

/**
 * Benzile unui nod, decupate pe `totalHeightM` — înălțimea pe care motorul a
 * MĂSURAT-O efectiv.
 *
 * `null` când nu e nimic de împărțit: nod nezonabil, fără benzi scrise, sau o
 * singură bandă (care e chiar nodul întreg). Nul înseamnă „măsoară ca până
 * acum", deci un proiect care n-a configurat nimic se decontează identic.
 */
export function heightZonesOf(node: BubbleGraphNode, totalHeightM: number): HeightZone[] | null {
  if (!isZonable(node.type)) return null;
  if (!(totalHeightM > 0)) return null;

  const layers = rawLayers(node);
  if (!layers || layers.length < 2) return null;

  const totalMm = totalHeightM * 1000;
  const sorted = [...layers].sort((a, b) => Number(a.from_mm ?? 0) - Number(b.from_mm ?? 0));

  const zones: HeightZone[] = [];
  for (const l of sorted) {
    const fromMm = Math.max(0, Math.min(totalMm, Number(l.from_mm ?? 0)));
    const toMm = Math.max(0, Math.min(totalMm, Number(l.to_mm ?? totalMm)));
    if (toMm - fromMm <= 0.5) continue; // sub o jumătate de milimetru nu e bandă
    const fromM = fromMm / 1000;
    const toM = toMm / 1000;
    const name = typeof l.label === 'string' && l.label.trim() !== '' ? l.label.trim() : '';
    zones.push({
      fromM,
      toM,
      heightM: toM - fromM,
      label: name ? `${name} (${M2(fromM)}–${M2(toM)} m)` : `${M2(fromM)}–${M2(toM)} m`,
      specs: parseZoneSpecs(l.spec ?? l.specs, node.type),
      props: parseZoneProps(l, node.type),
    });
  }

  if (zones.length < 2) return null;

  // Ultima bandă merge până sus: o bandă lipsă e cantitate lipsă în tăcere.
  const last = zones[zones.length - 1];
  if (last.toM < totalHeightM - 1e-6) {
    last.toM = totalHeightM;
    last.heightM = last.toM - last.fromM;
    last.label = `${M2(last.fromM)}–${M2(last.toM)} m`;
  }
  return zones;
}

/**
 * Nodul așa cum îl vede banda: proprietățile suprascrise, plus alegerile de
 * specificație scrise ca `spec_<grup>`, ca `resolveSpecs` să le găsească pe
 * calea pe care o cunoaște deja.
 *
 * Același `id`, deci liniile de deviz arată în continuare spre elementul real.
 */
/**
 * O bandă așa cum o vede un VIEWER: unde începe, cât e de înaltă, și cu ce
 * material se desenează.
 *
 * Peretele și camera își au deja rezolvatoarele lor de straturi
 * (`resolveWallLayers` / `resolveCoveringLayers`), care le desenau bandat de
 * mult. Anvelopa nu — se desena ca un inel întreg — așa că asta e ușa prin care
 * cele patru viewere o pot desena pe benzi fără să repete parsarea de patru
 * ori.
 *
 * `null` = nezonat: desenează ca până acum.
 */
export interface RenderBand {
  fromM: number;
  heightM: number;
  /** Cheia de material, dedusă din ce se decontează pe bandă. */
  material?: string;
  label: string;
}

export function renderBandsOf(node: BubbleGraphNode, totalHeightM: number): RenderBand[] | null {
  const zones = heightZonesOf(node, totalHeightM);
  if (!zones) return null;
  return zones.map((z) => ({
    fromM: z.fromM,
    heightM: z.heightM,
    material: z.props.material ?? specMaterial(z.specs),
    label: z.label,
  }));
}

export function zoneNode(node: BubbleGraphNode, zone: HeightZone): BubbleGraphNode {
  const specProps: Record<string, string> = {};
  for (const [g, o] of Object.entries(zone.specs)) specProps[`spec_${g}`] = o;
  return {
    ...node,
    properties: { ...node.properties, ...zone.props, ...specProps },
  };
}
