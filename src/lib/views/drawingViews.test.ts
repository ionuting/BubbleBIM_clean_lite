import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, DrawingAnnotation, ViewTab } from '@/store';
import { defaultViewName, duplicateView, legacyAnnKey, syncViews, tabTypeOf, uniqueViewName, type DrawingView } from './drawingViews';

const storey = (id: string, name: string, z = 0) =>
  ({ id, type: 'storey', name, x: 0, y: 0, z: 0, properties: { bottomElevation: z } }) as unknown as BubbleGraphNode;
const section = (id: string, name: string) =>
  ({ id, type: 'section', name, x: 0, y: 0, z: 0, properties: {} }) as unknown as BubbleGraphNode;
const text = (id: string, viewId: string): DrawingAnnotation => ({ id, kind: 'text', viewId, x: 0, y: 0, text: id });

describe('the keys drawings had before views', () => {
  it('are the ones each viewer computed for itself', () => {
    expect(legacyAnnKey({ kind: 'plan', engine: 'classic', storeyId: 'p0' })).toBe('p0');
    expect(legacyAnnKey({ kind: 'plan', engine: 'classic' })).toBe('floorplan:all');
    expect(legacyAnnKey({ kind: 'elevation', engine: 'classic', dir: 'S' })).toBe('elevation:S');
    expect(legacyAnnKey({ kind: 'section', engine: 'classic', sectionNodeId: 's1' })).toBe('section:s1');
    expect(legacyAnnKey({ kind: 'plan', engine: 'og', storeyId: 'p0' })).toBe('og:plan:p0');
    expect(legacyAnnKey({ kind: 'section', engine: 'og', dir: 'E' })).toBe('og:section:E');
  });
  it('open in the right tab type', () => {
    expect(tabTypeOf({ kind: 'plan', engine: 'classic' })).toBe('floorplan');
    expect(tabTypeOf({ kind: 'elevation', engine: 'og' })).toBe('opengeo-elevation');
  });
});

describe('names', () => {
  it('stay unique, case-insensitively, the way Revit asks', () => {
    const views = [{ id: 'a', name: 'Parter' }, { id: 'b', name: 'parter (2)' }];
    expect(uniqueViewName('Parter', views)).toBe('Parter (3)');
    expect(uniqueViewName('Etaj', views)).toBe('Etaj');
    expect(uniqueViewName('Parter', views, 'a')).toBe('Parter');      // renaming a view to its own name
  });
  it('are proposed from what the view shows', () => {
    expect(defaultViewName({ kind: 'plan', engine: 'classic', discipline: 'architectural' }, 'Parter')).toBe('Parter');
    expect(defaultViewName({ kind: 'plan', engine: 'og', discipline: 'structural' }, 'Parter')).toBe('Parter — structură (OG)');
    expect(defaultViewName({ kind: 'elevation', engine: 'classic', dir: 'S' })).toBe('Fațada sud');
  });
});

describe('the registry kept in line with the model', () => {
  const nodes = [storey('p0', 'Parter'), storey('p1', 'Etaj', 2800), section('s1', 'A-A')];

  it('gives every storey a plan and every section node its view, on the keys their notes already had', () => {
    const r = syncViews([], nodes, [])!;
    const plans = r.views.filter((v) => v.kind === 'plan');
    expect(plans.map((v) => [v.name, v.annKey, v.engine])).toEqual([['Parter', 'p0', 'og'], ['Etaj', 'p1', 'og']]);
    expect(r.views.find((v) => v.kind === 'section')).toMatchObject({ name: 'A-A', sectionNodeId: 's1', annKey: 'section:s1' });
    expect(syncViews(r.views, nodes, [])).toBeNull();                 // nothing more to do
  });

  it('gives an older tab a view of its own engine on the key its notes have', () => {
    const base = syncViews([], nodes, [])!.views;
    const tabs: ViewTab[] = [
      { id: 't1', label: 'Parter — Plan', type: 'floorplan', storeyId: 'p0', discipline: 'architectural', canClose: true },
      { id: 't2', label: 'South Elevation', type: 'elevation', canClose: true, params: { viewDirection: 'S' } },
    ];
    const r = syncViews(base, nodes, tabs)!;
    // The storey's plan is OpenGeometry now; the old classic tab keeps a view of
    // its own engine — on the same key, so both show the notes it has.
    const classic = r.views.find((v) => v.kind === 'plan' && v.storeyId === 'p0' && v.engine === 'classic')!;
    expect(classic).toMatchObject({ name: 'Parter — Plan', annKey: 'p0' });
    expect(r.links).toContainEqual({ tabId: 't1', viewId: classic.id });
    const south = r.views.find((v) => v.kind === 'elevation')!;
    expect(south).toMatchObject({ name: 'South Elevation', dir: 'S', annKey: 'elevation:S' });
  });

  it('makes no view for a tab on a storey that is gone — and settles', () => {
    const base = syncViews([], nodes, [])!.views;
    const stale: ViewTab[] = [{ id: 'old', label: 'Demolat — Plan', type: 'floorplan', storeyId: 'gone', canClose: true }];
    expect(syncViews(base, nodes, stale)).toBeNull();
  });

  it('waits while the graph has no storey, instead of dropping every view', () => {
    const base = syncViews([], nodes, [])!.views;
    expect(syncViews(base, [], [])).toBeNull();
  });

  it('lets a plan go with its storey, a section with its cut', () => {
    const base = syncViews([], nodes, [])!.views;
    const r = syncViews(base, [storey('p0', 'Parter')], [])!;
    expect(r.views.map((v) => v.storeyId ?? v.sectionNodeId)).toEqual(['p0']);
  });
});

describe('duplicating a view', () => {
  const v: DrawingView = { id: 'v1', name: 'Parter', kind: 'plan', engine: 'classic', storeyId: 'p0', annKey: 'p0' };
  const anns = [text('a1', 'p0'), text('a2', 'p0'), text('b1', 'p1')];

  it('makes a view of its own: a new name, a new key, no notes', () => {
    const d = duplicateView(v, [v], anns, false);
    expect(d.view.name).toBe('Parter — copie');
    expect(d.view.annKey).toBe(`view:${d.view.id}`);
    expect(d.annotations).toEqual([]);
  });

  it('with detailing, copies its notes under the copy\'s key — the original keeps its own', () => {
    const d = duplicateView(v, [v], anns, true);
    expect(d.annotations.map((a) => a.viewId)).toEqual([d.view.annKey, d.view.annKey]);
    expect(new Set(d.annotations.map((a) => a.id)).size).toBe(2);
    expect(d.annotations.every((a) => !anns.some((o) => o.id === a.id))).toBe(true);
  });
});
