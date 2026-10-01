/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * liveSync.ts — WebSocket client that pushes already-built IFC STEP text to
 * the standalone relay used by the IfcLiteBridge companion app (a separate
 * sibling repo embedding the LTplus-AG/ifc-lite project's viewer — not to be
 * confused with this codebase's own "ifc-lite" branding for its internal
 * viewer subsystem).
 *
 * This module holds no IFC-generation logic — callers build the STEP text
 * via `buildIfcModel` (see `buildIfcModel.ts`) exactly as the manual
 * "⚙ Generate IFC" export already does, and only hand the result here to be
 * broadcast. The relay (IfcLiteBridge/server/relay.ts) is a dumb passthrough:
 * it never parses IFC, just forwards `source` messages to `viewer` clients.
 */

export type LiveSyncStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** Override via VITE_IFC_LIVE_RELAY_URL if the relay isn't on its default port. */
const DEFAULT_RELAY_URL = 'ws://localhost:8765';

export class IfcLiveSyncClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly onStatus: (status: LiveSyncStatus) => void;

  constructor(onStatus: (status: LiveSyncStatus) => void, url?: string) {
    this.onStatus = onStatus;
    this.url = url ?? (import.meta.env.VITE_IFC_LIVE_RELAY_URL as string | undefined) ?? DEFAULT_RELAY_URL;
  }

  connect(): void {
    if (this.ws) return; // already connecting/connected

    this.onStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.onStatus('error');
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.onStatus('connected');
      socket.send(JSON.stringify({ type: 'hello', role: 'source' }));
    };
    socket.onclose = () => {
      if (this.ws === socket) this.ws = null;
      this.onStatus('idle');
    };
    socket.onerror = () => {
      this.onStatus('error');
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.onStatus('idle');
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Push a freshly-built IFC STEP model to any connected IfcLiteBridge viewer(s). */
  sendModel(projectName: string, stepText: string): void {
    if (!this.isConnected) return;
    this.ws!.send(JSON.stringify({
      type: 'model',
      projectName,
      step: stepText,
      timestamp: Date.now(),
    }));
  }
}
