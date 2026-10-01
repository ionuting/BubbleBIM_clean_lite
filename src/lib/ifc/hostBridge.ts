/**
 * hostBridge.ts — the viewer's side of an iframe host integration.
 *
 * The viewers may run embedded in a host application (an `<iframe>` in a
 * platform such as QORUM) that only knows our URL and a postMessage envelope.
 * The host pushes context in (site, token, locale) and reads back readiness
 * and selection; it never renders our data itself. This module is that
 * contract in one place, so both viewers speak it identically and nothing
 * else in the app has to know it exists.
 *
 * Envelope: `{ type: string, payload?: object }`, both directions. Inbound
 * messages are also accepted flat (`{ type, siteId, token }`) because the
 * host's exact shape has not been pinned down — the parser tolerates both and
 * we EMIT the enveloped form.
 *
 * Origin policy: an inbound message is honoured only from an allowed origin
 * (`VITE_BIM_HOST_ORIGINS`, comma-separated). With nothing configured, inbound
 * is dropped — that is the safe default, since one of those messages carries
 * the user's token. Outbound goes to the configured origins, or to `*` when
 * none are configured: readiness and a selected GUID are not secrets, and a
 * silent viewer is harder to integrate than a chatty one.
 *
 * The bridge also owns the one console line printed for every IFC selection,
 * embedded or not — the GUID is the key a host uses to find the element in its
 * own data, so it has to be easy to read off while wiring things up.
 */

export type ViewerKind = 'toc' | 'world';

/** What we say about a picked IFC element. The GUID is the contract. */
export interface BimSelection {
  viewer: ViewerKind;
  modelId: string;
  localId: number;
  guid: string | null;
  category?: string | null;
  name?: string | null;
}

export interface HostContext {
  siteId?: string;
  token?: string;
  locale?: string;
}

export type OutboundMessage =
  | { type: 'BIM_READY' }
  | { type: 'BIM_MODEL_LOADED'; payload: { modelId: string; name: string; viewer: ViewerKind } }
  | { type: 'BIM_ELEMENT_SELECTED'; payload: BimSelection }
  | { type: 'BIM_ERROR'; payload: { message: string } };

export type InboundMessage =
  | { type: 'BIM_SET_CONTEXT'; payload: HostContext }
  | { type: 'BIM_FOCUS_GUID'; payload: { guid: string } }
  | { type: 'BIM_RESET_VIEW' }
  | { type: 'BIM_COLOR_BY_VALUES'; payload: { colors: Record<string, string> } }
  | { type: 'BIM_CLEAR_COLORS' };

const INBOUND_TYPES = new Set<InboundMessage['type']>([
  'BIM_SET_CONTEXT', 'BIM_FOCUS_GUID', 'BIM_RESET_VIEW', 'BIM_COLOR_BY_VALUES', 'BIM_CLEAR_COLORS',
]);

/**
 * Turn whatever arrived on the wire into a typed message, or null.
 *
 * Accepts `{ type, payload }` and the flat `{ type, ...fields }`. Pure, so the
 * tolerance is testable without a window.
 */
export function parseHostMessage(data: unknown): InboundMessage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const rawType = d.type;
  if (typeof rawType !== 'string' || !INBOUND_TYPES.has(rawType as InboundMessage['type'])) return null;
  const type = rawType as InboundMessage['type'];
  const raw = (d.payload && typeof d.payload === 'object' ? d.payload : d) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof raw[k] === 'string' ? (raw[k] as string) : undefined);

  switch (type) {
    case 'BIM_SET_CONTEXT': {
      // Only the fields that came: a token refresh carries just the token and
      // must not blank the site and locale received earlier.
      const payload: HostContext = {};
      for (const k of ['siteId', 'token', 'locale'] as const) { const v = str(k); if (v !== undefined) payload[k] = v; }
      return { type, payload };
    }
    case 'BIM_FOCUS_GUID': {
      const guid = str('guid');
      return guid ? { type, payload: { guid } } : null;
    }
    case 'BIM_COLOR_BY_VALUES': {
      const colors = raw.colors && typeof raw.colors === 'object' ? (raw.colors as Record<string, unknown>) : raw;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(colors)) if (typeof v === 'string') out[k] = v;
      return { type, payload: { colors: out } };
    }
    case 'BIM_RESET_VIEW':
    case 'BIM_CLEAR_COLORS':
      return { type };
  }
  return null;
}

/** The one line a developer reads while wiring a host up. */
export function formatSelectionLog(sel: BimSelection): string {
  const what = [sel.category, sel.name].filter(Boolean).join(' ');
  return `[IFC] selected ${sel.guid ?? '(no GUID)'}${what ? ` — ${what}` : ''} (${sel.viewer}, model ${sel.modelId}, localId ${sel.localId})`;
}

/** The slice of `window` the bridge touches — so tests can hand in a fake. */
export interface WindowLike {
  parent: { postMessage: (msg: unknown, targetOrigin: string) => void } | null;
  self?: unknown;
  addEventListener: (type: 'message', h: (ev: { data: unknown; origin: string }) => void) => void;
  removeEventListener: (type: 'message', h: (ev: { data: unknown; origin: string }) => void) => void;
}

export interface HostBridge {
  /** True when we are inside someone else's page. */
  readonly embedded: boolean;
  /** Last context the host sent, token included. Never log it. */
  readonly context: HostContext | null;
  post(msg: OutboundMessage): void;
  /** Subscribe to host messages; returns the unsubscribe. */
  onMessage(handler: (msg: InboundMessage) => void): () => void;
  /** Print the selection and, when embedded, tell the host. */
  reportSelection(sel: BimSelection): void;
  dispose(): void;
}

export interface HostBridgeOptions {
  win?: WindowLike | null;
  /** Origins allowed to talk to us. Empty = inbound dropped, outbound to `*`. */
  allowedOrigins?: string[];
  log?: (line: string) => void;
}

export function createHostBridge(opts: HostBridgeOptions = {}): HostBridge {
  const win = opts.win === undefined ? (typeof window !== 'undefined' ? (window as unknown as WindowLike) : null) : opts.win;
  const allowed = (opts.allowedOrigins ?? envOrigins()).map((o) => o.trim()).filter(Boolean);
  const log = opts.log ?? ((line: string) => console.log(line));
  const embedded = !!win && !!win.parent && win.parent !== (win.self ?? win);
  const handlers = new Set<(msg: InboundMessage) => void>();
  let context: HostContext | null = null;
  let warnedOrigin = false;

  const onWindowMessage = (ev: { data: unknown; origin: string }) => {
    if (!allowed.includes(ev.origin) && !allowed.includes('*')) {
      if (!warnedOrigin && parseHostMessage(ev.data)) {
        warnedOrigin = true;
        console.warn(`[hostBridge] dropped a BIM message from ${ev.origin}: add it to VITE_BIM_HOST_ORIGINS to accept it`);
      }
      return;
    }
    const msg = parseHostMessage(ev.data);
    if (!msg) return;
    if (msg.type === 'BIM_SET_CONTEXT') context = { ...context, ...msg.payload };
    for (const h of handlers) h(msg);
  };
  if (win && embedded) win.addEventListener('message', onWindowMessage);

  const post = (msg: OutboundMessage) => {
    if (!embedded || !win?.parent) return;
    const targets = allowed.length ? allowed : ['*'];
    for (const t of targets) {
      try { win.parent.postMessage(msg, t); } catch { /* a closed or cross-realm parent — nothing to do */ }
    }
  };

  return {
    get embedded() { return embedded; },
    get context() { return context; },
    post,
    onMessage(h) { handlers.add(h); return () => { handlers.delete(h); }; },
    reportSelection(sel) {
      log(formatSelectionLog(sel));
      post({ type: 'BIM_ELEMENT_SELECTED', payload: sel });
    },
    dispose() {
      handlers.clear();
      if (win && embedded) win.removeEventListener('message', onWindowMessage);
    },
  };
}

function envOrigins(): string[] {
  try {
    const v = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_BIM_HOST_ORIGINS;
    return v ? v.split(',') : [];
  } catch {
    return [];
  }
}

/** The app-wide bridge. Created lazily so importing this file has no side effect. */
let shared: HostBridge | null = null;
export function getHostBridge(): HostBridge {
  if (!shared) shared = createHostBridge();
  return shared;
}
