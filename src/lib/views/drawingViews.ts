/**
 * drawingViews.ts — 2D views as things of the project, the way Revit has them.
 *
 * A view (a plan, a section, an elevation) is not a window. It has a name of
 * its own, unique among the views and editable; it says what it shows (which
 * storey, which discipline, which cut or direction) and how it is drawn (the
 * classic 2D engine or OpenGeometry); and it owns its annotations — text,
 * dimensions, leaders drawn on it belong to it and to no other view. Two
 * ground-floor plans are two views with two sets of notes.
 *
 * A tab is only where a view is open (`tab.params.drawingViewId`). Close the
 * tab and the view is still in the project browser, notes and all.
 *
 * Annotations are filed under `annKey`. A new view gets a key of its own
 * (`view:<id>`); a view that stands in for a drawing made before views existed
 * keeps the key that drawing used (`legacyAnnKey`) — so nothing anyone drew
 * goes missing when the registry first appears.
 */
import type { BubbleGraphNode, DrawingAnnotation, StoreyDiscipline, ViewTab, ViewTabType } from '@/store';
import type { GraphicStyleId } from '@/lib/drawing/graphicStyle';

export type DrawingViewKind = 'plan' | 'section' | 'elevation';
export type DrawingEngine = 'classic' | 'og';
export type Dir = 'N' | 'S' | 'E' | 'W';

export interface DrawingView {
  id: string;
  /** Unique among the project's views; the user's to change. */
  name: string;
  kind: DrawingViewKind;
  engine: DrawingEngine;
  storeyId?: string;
  discipline?: StoreyDiscipline;
  /** Elevations and OG sections: the side looked at. */
  dir?: Dir;
  /** Classic sections: the section node that cuts it. */
  sectionNodeId?: string;
  /** Anything else the view's tab needs (cut depth, elevation range…). */
  params?: Record<string, unknown>;
  /** The key its annotations are filed under. */
  annKey: string;
  /** How it is drawn: colour, technical, poché, presentation (lib/drawing/graphicStyle). */
  graphic?: GraphicStyleId;
}

/**
 * The engine a new view is drawn with. OpenGeometry cuts the real solids —
 * exact outlines, holes, hidden lines — so it is the drawing; the classic
 * engine stays one click away on every view.
 */
export const DEFAULT_ENGINE: DrawingEngine = 'og';

/** The key a drawing used before views existed — what each viewer computed for itself. */
export function legacyAnnKey(v: Pick<DrawingView, 'kind' | 'engine' | 'storeyId' | 'dir' | 'sectionNodeId'> & { cutY?: number }): string {
  if (v.engine === 'og') {
    return v.kind === 'plan' ? `og:plan:${v.storeyId ?? 'all'}` : `og:${v.kind}:${v.dir ?? 'N'}`;
  }
  if (v.kind === 'plan') return v.storeyId ?? 'floorplan:all';
  if (v.kind === 'elevation') return `elevation:${v.dir ?? 'N'}`;
  return `section:${v.sectionNodeId ?? `y${v.cutY}`}`;
}

/** The tab type a view opens in. */
export function tabTypeOf(v: Pick<DrawingView, 'kind' | 'engine'>): ViewTabType {
  if (v.engine === 'og') return v.kind === 'plan' ? 'opengeo-floorplan' : v.kind === 'section' ? 'opengeo-section' : 'opengeo-elevation';
  return v.kind === 'plan' ? 'floorplan' : v.kind;
}

/** The view a drawing tab stands for, read off the tab — for tabs opened before views existed. */
export function viewFromTab(t: ViewTab): Omit<DrawingView, 'id' | 'name'> | null {
  const p = t.params ?? {};
  const dir = (p.viewDirection as Dir | undefined) ?? undefined;
  switch (t.type) {
    case 'floorplan':
      return { kind: 'plan', engine: 'classic', storeyId: t.storeyId, discipline: t.discipline ?? 'architectural', annKey: legacyAnnKey({ kind: 'plan', engine: 'classic', storeyId: t.storeyId }) };
    case 'opengeo-floorplan':
      return { kind: 'plan', engine: 'og', storeyId: t.storeyId, discipline: 'architectural', annKey: legacyAnnKey({ kind: 'plan', engine: 'og', storeyId: t.storeyId }), params: pick(p, ['cutPos', 'cutDepth']) };
    case 'elevation':
      return { kind: 'elevation', engine: 'classic', dir: dir ?? 'N', annKey: legacyAnnKey({ kind: 'elevation', engine: 'classic', dir }), params: pick(p, ['startElevation', 'endElevation', 'cutDepth', 'cutX', 'cutY', 'nodeId']) };
    case 'opengeo-elevation':
      return { kind: 'elevation', engine: 'og', dir: dir ?? 'N', annKey: legacyAnnKey({ kind: 'elevation', engine: 'og', dir }), params: pick(p, ['cutPos', 'cutDepth']) };
    case 'section': {
      const nodeId = p.nodeId as string | undefined;
      return { kind: 'section', engine: 'classic', sectionNodeId: nodeId, annKey: legacyAnnKey({ kind: 'section', engine: 'classic', sectionNodeId: nodeId, cutY: p.cutY as number | undefined }), params: pick(p, ['cutY', 'cutDepth', 'startElevation', 'endElevation']) };
    }
    case 'opengeo-section':
      return { kind: 'section', engine: 'og', dir: dir ?? 'N', annKey: legacyAnnKey({ kind: 'section', engine: 'og', dir }), params: pick(p, ['cutPos', 'cutDepth']) };
    default:
      return null;
  }
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return Object.keys(out).length ? out : undefined;
}

/** `base`, or `base (2)`, `base (3)`… — the first that no other view has. Case-insensitive, like Revit. */
export function uniqueViewName(base: string, views: Pick<DrawingView, 'id' | 'name'>[], exceptId?: string): string {
  const taken = new Set(views.filter((v) => v.id !== exceptId).map((v) => v.name.trim().toLowerCase()));
  const clean = base.trim() || 'Vedere';
  if (!taken.has(clean.toLowerCase())) return clean;
  const stem = clean.replace(/\s\(\d+\)$/, '');
  for (let i = 2; ; i++) {
    const name = `${stem} (${i})`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

let seq = 0;
export const newViewId = () => `dv_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const DISC_NAME: Record<StoreyDiscipline, string> = { architectural: 'arhitectură', structural: 'structură', mep: 'instalații' };
const DIR_NAME: Record<Dir, string> = { N: 'nord', S: 'sud', E: 'est', W: 'vest' };

/** A name for a new view, before it is made unique. */
export function defaultViewName(v: Pick<DrawingView, 'kind' | 'engine' | 'discipline' | 'dir'>, storeyName?: string): string {
  const og = v.engine === 'og' ? ' (OG)' : '';
  if (v.kind === 'plan') {
    const disc = v.discipline && v.discipline !== 'architectural' ? ` — ${DISC_NAME[v.discipline]}` : '';
    return `${storeyName ?? 'Plan'}${disc}${og}`;
  }
  if (v.kind === 'elevation') return `Fațada ${DIR_NAME[v.dir ?? 'N']}${og}`;
  return `Secțiune ${v.dir ? DIR_NAME[v.dir] : ''}${og}`.replace(/\s+/g, ' ').trim();
}

/** A copy of a view under a new name; with `detailing`, its annotations copied to the copy's own key. */
export function duplicateView(
  v: DrawingView, views: DrawingView[], annotations: DrawingAnnotation[], detailing: boolean,
): { view: DrawingView; annotations: DrawingAnnotation[] } {
  const id = newViewId();
  const view: DrawingView = { ...v, id, name: uniqueViewName(`${v.name} — copie`, views), annKey: `view:${id}` };
  const copies = detailing
    ? annotations.filter((a) => a.viewId === v.annKey).map((a) => ({ ...a, id: `${a.id}_${id}`, viewId: view.annKey }) as DrawingAnnotation)
    : [];
  return { view, annotations: copies };
}

/**
 * The registry brought in line with the model and the open tabs:
 *
 *   • every storey has an architectural floor plan (Revit makes one per level);
 *   • every section node has its section view;
 *   • every drawing tab open on no view gets one (and the tab is linked to it);
 *   • a plan whose storey is gone, a section whose cut is gone, goes.
 *
 * Returns null when nothing changes, so a caller can run it on every render.
 */
export function syncViews(
  views: DrawingView[], nodes: BubbleGraphNode[], tabs: ViewTab[],
): { views: DrawingView[]; links: Array<{ tabId: string; viewId: string }> } | null {
  const storeys = nodes.filter((n) => n.type === 'storey');
  const storeyIds = new Set(storeys.map((s) => s.id));
  const sectionIds = new Set(nodes.filter((n) => n.type === 'section').map((n) => n.id));
  // A graph with no storey is a graph not loaded yet (or being replaced), not
  // a building whose every level was deleted — pruning then would throw away
  // every view's name. Wait for the model.
  if (!storeys.length) return null;
  const gone = (v: Pick<DrawingView, 'kind' | 'engine' | 'storeyId' | 'sectionNodeId'>) =>
    (v.kind === 'plan' && !!v.storeyId && !storeyIds.has(v.storeyId))
    || (v.kind === 'section' && v.engine === 'classic' && !!v.sectionNodeId && !sectionIds.has(v.sectionNodeId));
  let out = views.filter((v) => !gone(v));
  let changed = out.length !== views.length;
  const links: Array<{ tabId: string; viewId: string }> = [];
  const add = (v: Omit<DrawingView, 'id' | 'name'>, name: string, id = newViewId()) => {
    const view: DrawingView = { ...v, id, name: uniqueViewName(name, out) };
    out = [...out, view];
    changed = true;
    return view;
  };

  // Tabs first: a drawing already open keeps its name and its notes.
  for (const t of tabs) {
    const linked = t.params?.drawingViewId as string | undefined;
    if (linked && out.some((v) => v.id === linked)) continue;
    const def = viewFromTab(t);
    // A tab on a storey or a cut the model no longer has stands for nothing:
    // making a view for it would only see that view pruned again, forever.
    if (!def || gone(def)) continue;
    // The same drawing open in an older tab: link to the view that has its key.
    const same = out.find((v) => v.annKey === def.annKey && v.kind === def.kind && v.engine === def.engine
      && (v.discipline ?? 'architectural') === (def.discipline ?? 'architectural'));
    const view = same ?? add(def, t.label);
    links.push({ tabId: t.id, viewId: view.id });
  }

  for (const s of storeys) {
    const has = out.some((v) => v.kind === 'plan' && v.storeyId === s.id && (v.discipline ?? 'architectural') === 'architectural');
    // Drawn by OpenGeometry, filed under the key the storey's plan notes have
    // always had: both engines draw a plan in BIM x/y millimetres, so the notes
    // land where they were drawn.
    if (!has) add({ kind: 'plan', engine: DEFAULT_ENGINE, storeyId: s.id, discipline: 'architectural', annKey: legacyAnnKey({ kind: 'plan', engine: 'classic', storeyId: s.id }) }, s.name);
  }
  for (const id of sectionIds) {
    if (out.some((v) => v.kind === 'section' && v.sectionNodeId === id)) continue;
    const node = nodes.find((n) => n.id === id)!;
    add({ kind: 'section', engine: 'classic', sectionNodeId: id, annKey: legacyAnnKey({ kind: 'section', engine: 'classic', sectionNodeId: id }) }, node.name || 'Secțiune');
  }
  return changed || links.length ? { views: out, links } : null;
}
