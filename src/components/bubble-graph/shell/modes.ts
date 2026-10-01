/**
 * modes.ts — the five ways of looking at one model.
 *
 * The graph is the root: every element is a node there, and every other mode
 * is a view derived from it — the plan draws a storey of it, the 3D builds it,
 * the sheets compose drawings of it, the site places it on the ground. So the
 * graph is mode 1, always there, never closed; the others open the view they
 * stand for (or bring back the one already open).
 */
import type { ViewTabType } from '@/store';
import type { ShellCapabilities } from './capabilities';

export type ShellMode = 'graph' | 'plan' | '3d' | 'sheets' | 'site';

export interface ModeDef {
  id: ShellMode;
  key: string;
  label: { ro: string; en: string };
  hint: { ro: string; en: string };
}

export const MODES: ModeDef[] = [
  { id: 'graph', key: '1', label: { ro: 'Graf', en: 'Graph' },
    hint: { ro: 'Rădăcina modelului: nodurile și legăturile din care se nasc toate vederile', en: 'The model itself: the nodes and links every view is drawn from' } },
  { id: 'plan', key: '2', label: { ro: 'Plan', en: 'Plan' },
    hint: { ro: 'Planul nivelului activ', en: 'Plan of the active storey' } },
  { id: '3d', key: '3', label: { ro: '3D', en: '3D' },
    hint: { ro: 'Modelul construit din graf, în 3D', en: 'The model built from the graph, in 3D' } },
  { id: 'sheets', key: '4', label: { ro: 'Planșe', en: 'Sheets' },
    hint: { ro: 'Secțiuni, fațade și planșe de predat', en: 'Sections, elevations and sheets' } },
  { id: 'site', key: '5', label: { ro: 'Sit', en: 'Site' },
    hint: { ro: 'Teren, vegetație, locație', en: 'Terrain, planting, location' } },
];

/** Modes an edition has. The graph is always there. */
export function modesFor(caps: ShellCapabilities): ModeDef[] {
  return MODES.filter((m) => (m.id === 'sheets' || m.id === 'plan' ? caps.drawings : m.id === 'site' ? caps.site : true));
}

/** Which mode a view tab belongs to. */
export function modeOfTab(type: ViewTabType | undefined): ShellMode {
  switch (type) {
    case 'floorplan': case 'opengeo-floorplan': case 'ifc-plan':
      return 'plan';
    case '3d-model': case 'opengeo-3d': case 'ifc-tiles': case 'fem':
      return '3d';
    case 'sheet': case 'section': case 'elevation': case 'table': case 'report':
    case 'opengeo-section': case 'opengeo-elevation':
      return 'sheets';
    case 'terrain': case 'worldview':
      return 'site';
    default:
      return 'graph';
  }
}

/** True when keyboard focus is somewhere typing — mode keys must not fire there. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
