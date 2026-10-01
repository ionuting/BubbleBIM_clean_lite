import { describe, expect, it } from 'vitest';
import {
  DETACHABLE_VIEWS, detachSearch, detachedTitle, isDetachable, parseDetachedSearch,
  resolveTab, tabIsGone, type GraphBroadcast,
} from './detachedView';
import type { ViewTab } from '@/store';

const tab = (over: Partial<ViewTab> = {}): ViewTab => ({
  id: 'sec-1', label: 'Secțiune A-A', type: 'section', canClose: true, ...over,
});

const broadcast = (over: Partial<GraphBroadcast> = {}): GraphBroadcast => ({
  rev: 1, projectName: 'Casa', nodes: [], edges: [],
  buildingAxes: { xValues: [], yValues: [] },
  tabs: [tab()], viewer3DType: 'tiles', ...over,
});

describe('what may be detached', () => {
  it('only viewers — never the graph editor or an editing surface', () => {
    expect(isDetachable('section')).toBe(true);
    expect(isDetachable('elevation')).toBe(true);
    expect(isDetachable('floorplan')).toBe(true);
    expect(isDetachable('3d-model')).toBe(true);
    // These write to the model or to per-tab state that is never broadcast.
    expect(isDetachable('graph-editor')).toBe(false);
    expect(isDetachable('sheet')).toBe(false);
    expect(isDetachable('composer')).toBe(false);
    expect(isDetachable(undefined)).toBe(false);
  });
});

describe('the URL a detached window is addressed by', () => {
  it('round-trips', () => {
    const spec = { viewType: 'section' as const, tabId: 'sec-1', label: 'Secțiune A-A' };
    const back = parseDetachedSearch('?' + detachSearch(spec));
    expect(back).toEqual(spec);
  });

  it('survives a label with spaces and diacritics', () => {
    const search = detachSearch({ viewType: 'elevation', tabId: 'e w', label: 'Fațadă Nord' });
    expect(parseDetachedSearch(search)?.label).toBe('Fațadă Nord');
    expect(parseDetachedSearch(search)?.tabId).toBe('e w');
  });

  it('a leading ? is optional', () => {
    expect(parseDetachedSearch('view=section&tab=a')?.tabId).toBe('a');
  });

  it('the main window parses to null', () => {
    expect(parseDetachedSearch('')).toBeNull();
    expect(parseDetachedSearch('?foo=1')).toBeNull();
  });

  it('a stale or hand-typed view opens the app rather than a blank window', () => {
    expect(parseDetachedSearch('?view=sheet&tab=a')).toBeNull();
    expect(parseDetachedSearch('?view=nonsense&tab=a')).toBeNull();
    expect(parseDetachedSearch('?view=section')).toBeNull();
  });

  it('every detachable view is addressable', () => {
    for (const v of DETACHABLE_VIEWS) {
      expect(parseDetachedSearch('?' + detachSearch({ viewType: v, tabId: 't', label: '' }))?.viewType).toBe(v);
    }
  });
});

describe('resolveTab', () => {
  const spec = { viewType: 'section' as const, tabId: 'sec-1', label: 'la deschidere' };

  it('takes the live tab, so params edited in the main window reach the drawing', () => {
    const live = tab({ label: 'Secțiune B-B', params: { cutY: 3200 } });
    expect(resolveTab(spec, broadcast({ tabs: [live] }))).toEqual(live);
  });

  it('falls back to what the window was opened with before anything arrives', () => {
    expect(resolveTab(spec, null)).toEqual({
      id: 'sec-1', label: 'la deschidere', type: 'section', canClose: true,
    });
  });

  it('keeps showing the last state when the tab is closed in the main window — and says so', () => {
    const b = broadcast({ tabs: [] });
    expect(resolveTab(spec, b).type).toBe('section');
    expect(tabIsGone(spec, b)).toBe(true);
    expect(tabIsGone(spec, broadcast())).toBe(false);
    // Nothing has arrived yet: absence is not proof the tab is gone.
    expect(tabIsGone(spec, null)).toBe(false);
  });
});

describe('detachedTitle', () => {
  const spec = { viewType: 'section' as const, tabId: 'sec-1', label: 'Secțiune A-A' };

  it('names the view and the project', () => {
    expect(detachedTitle(spec, broadcast())).toBe('Secțiune A-A — Casa');
  });

  it('follows a rename in the main window', () => {
    expect(detachedTitle(spec, broadcast({ tabs: [tab({ label: 'A-A revizuit' })] })))
      .toBe('A-A revizuit — Casa');
  });

  it('never ends up empty', () => {
    expect(detachedTitle({ ...spec, label: '' }, null)).toBe('BubbleGraph');
  });
});
