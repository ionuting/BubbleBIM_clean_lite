import { describe, expect, it, vi } from 'vitest';
import {
  createHostBridge, formatSelectionLog, parseHostMessage,
  type BimSelection, type WindowLike,
} from './hostBridge';

/** A window with a parent (embedded) or without (top-level). */
function fakeWindow(embedded: boolean) {
  const listeners = new Set<(ev: { data: unknown; origin: string }) => void>();
  const parent = { postMessage: vi.fn() };
  const self = {};
  const win: WindowLike = {
    parent: embedded ? parent : (self as WindowLike['parent']),
    self,
    addEventListener: (_t, h) => { listeners.add(h); },
    removeEventListener: (_t, h) => { listeners.delete(h); },
  };
  const receive = (data: unknown, origin: string) => { for (const h of listeners) h({ data, origin }); };
  return { win, parent, receive, listeners };
}

const SEL: BimSelection = {
  viewer: 'toc', modelId: 'casa', localId: 42, guid: '2O2Fr$t4X7Zf8NOew3FLKr',
  category: 'IFCWALL', name: 'Perete exterior P1',
};

describe('parseHostMessage', () => {
  it('reads the enveloped form the host documents', () => {
    expect(parseHostMessage({ type: 'BIM_SET_CONTEXT', payload: { siteId: 's1', token: 't', locale: 'ro' } }))
      .toEqual({ type: 'BIM_SET_CONTEXT', payload: { siteId: 's1', token: 't', locale: 'ro' } });
    expect(parseHostMessage({ type: 'BIM_FOCUS_GUID', payload: { guid: 'abc' } }))
      .toEqual({ type: 'BIM_FOCUS_GUID', payload: { guid: 'abc' } });
  });

  it('tolerates the flat form, because the exact shape is not pinned down', () => {
    expect(parseHostMessage({ type: 'BIM_SET_CONTEXT', siteId: 's1', token: 't' }))
      .toEqual({ type: 'BIM_SET_CONTEXT', payload: { siteId: 's1', token: 't' } });
    expect(parseHostMessage({ type: 'BIM_FOCUS_GUID', guid: 'abc' })).toEqual({ type: 'BIM_FOCUS_GUID', payload: { guid: 'abc' } });
  });

  it('keeps only string colours in a colour map', () => {
    expect(parseHostMessage({ type: 'BIM_COLOR_BY_VALUES', payload: { colors: { a: '#f00', b: 3 } } }))
      .toEqual({ type: 'BIM_COLOR_BY_VALUES', payload: { colors: { a: '#f00' } } });
  });

  it('ignores anything that is not ours — other iframes post too', () => {
    expect(parseHostMessage({ type: 'BOARD_IMPORT' })).toBeNull();
    expect(parseHostMessage('BIM_READY')).toBeNull();
    expect(parseHostMessage(null)).toBeNull();
    expect(parseHostMessage({ type: 'BIM_FOCUS_GUID' })).toBeNull();     // no guid: nothing to focus
  });
});

describe('createHostBridge', () => {
  it('knows when it is embedded', () => {
    expect(createHostBridge({ win: fakeWindow(true).win, allowedOrigins: [] }).embedded).toBe(true);
    expect(createHostBridge({ win: fakeWindow(false).win, allowedOrigins: [] }).embedded).toBe(false);
    expect(createHostBridge({ win: null, allowedOrigins: [] }).embedded).toBe(false);
  });

  it('always prints the GUID on selection — that is what a developer wires against', () => {
    const log = vi.fn();
    const top = fakeWindow(false);
    createHostBridge({ win: top.win, allowedOrigins: [], log }).reportSelection(SEL);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('2O2Fr$t4X7Zf8NOew3FLKr');
    expect(log.mock.calls[0][0]).toContain('IFCWALL');
    // Top-level: nobody to tell.
    expect(top.parent.postMessage).not.toHaveBeenCalled();
  });

  it('tells the host about a selection with the documented envelope', () => {
    const f = fakeWindow(true);
    createHostBridge({ win: f.win, allowedOrigins: ['https://qorum.example'], log: () => {} }).reportSelection(SEL);
    expect(f.parent.postMessage).toHaveBeenCalledWith(
      { type: 'BIM_ELEMENT_SELECTED', payload: SEL },
      'https://qorum.example',
    );
  });

  it('posts to * only when no origin is configured', () => {
    const f = fakeWindow(true);
    createHostBridge({ win: f.win, allowedOrigins: [], log: () => {} }).post({ type: 'BIM_READY' });
    expect(f.parent.postMessage).toHaveBeenCalledWith({ type: 'BIM_READY' }, '*');
  });

  it('drops inbound messages from an origin it was not told about', () => {
    const f = fakeWindow(true);
    const bridge = createHostBridge({ win: f.win, allowedOrigins: ['https://qorum.example'], log: () => {} });
    const h = vi.fn();
    bridge.onMessage(h);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.receive({ type: 'BIM_SET_CONTEXT', payload: { token: 'stolen?' } }, 'https://evil.example');
    expect(h).not.toHaveBeenCalled();
    expect(bridge.context).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('honours a message from an allowed origin and keeps the context', () => {
    const f = fakeWindow(true);
    const bridge = createHostBridge({ win: f.win, allowedOrigins: ['https://qorum.example'], log: () => {} });
    const h = vi.fn();
    bridge.onMessage(h);
    f.receive({ type: 'BIM_SET_CONTEXT', payload: { siteId: 's1', token: 'jwt', locale: 'es' } }, 'https://qorum.example');
    f.receive({ type: 'BIM_FOCUS_GUID', payload: { guid: 'abc' } }, 'https://qorum.example');
    expect(h).toHaveBeenCalledTimes(2);
    expect(h.mock.calls[1][0]).toEqual({ type: 'BIM_FOCUS_GUID', payload: { guid: 'abc' } });
    expect(bridge.context).toEqual({ siteId: 's1', token: 'jwt', locale: 'es' });
    // A refreshed token replaces the old one without losing the site.
    f.receive({ type: 'BIM_SET_CONTEXT', payload: { token: 'jwt2' } }, 'https://qorum.example');
    expect(bridge.context).toEqual({ siteId: 's1', token: 'jwt2', locale: 'es' });
  });

  it('does not listen at all when top-level, and lets go on dispose', () => {
    const top = fakeWindow(false);
    createHostBridge({ win: top.win, allowedOrigins: ['*'] });
    expect(top.listeners.size).toBe(0);

    const f = fakeWindow(true);
    const bridge = createHostBridge({ win: f.win, allowedOrigins: ['*'] });
    expect(f.listeners.size).toBe(1);
    bridge.dispose();
    expect(f.listeners.size).toBe(0);
  });
});

describe('formatSelectionLog', () => {
  it('reads as one line with the GUID first', () => {
    expect(formatSelectionLog(SEL)).toBe(
      '[IFC] selected 2O2Fr$t4X7Zf8NOew3FLKr — IFCWALL Perete exterior P1 (toc, model casa, localId 42)',
    );
    expect(formatSelectionLog({ viewer: 'world', modelId: 'm', localId: 1, guid: null })).toBe(
      '[IFC] selected (no GUID) (world, model m, localId 1)',
    );
  });
});
