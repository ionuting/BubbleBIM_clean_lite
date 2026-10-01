/**
 * browserPush.ts — the "Push to ArchiCAD" button's whole job.
 *
 * The mapping and the push sequence are shared verbatim with
 * scripts/archicad-push.mjs; the only difference is the transport. The browser
 * cannot post to ArchiCAD's 127.0.0.1:19723 (no CORS headers there, and mixed
 * content once the page is on HTTPS), so `TapirClient` is pointed at the
 * backend relay instead — same envelope, one extra hop.
 *
 * The graph comes from the editor's live state rather than the saved project,
 * so unsaved edits push too.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { buildArchicadModel } from './buildArchicadModel';
import { pushToArchicad, type PushResult } from './pushToArchicad';
import { TapirClient } from './tapirClient';

/**
 * Read the backend base directly rather than importing it from `@/lib/api`:
 * that specifier is aliased per build (api.ts, api.cloud.ts, api.lite.ts) and
 * the variants neither export the same names nor, in the lite build, have a
 * backend at all — so importing it breaks those bundles.
 */
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '')
  || 'http://localhost:8000/api';

export const RELAY_URL = `${API_BASE}/archicad/relay`;

export interface PushOptions {
  /**
   * Asked before touching a SAVED ArchiCAD project, because regenerating
   * deletes every wall, column, beam, slab, window and door first. Returning
   * false aborts before anything is deleted. Untitled projects skip the ask.
   */
  confirmSavedProject?: (projectPath?: string) => boolean | Promise<boolean>;
}

export interface BrowserPushResult extends PushResult {
  archicad: string;
  /**
   * What the mapping produced, before ArchiCAD saw any of it. Worth surfacing
   * separately from `created`: an empty push means the GRAPH had nothing to
   * emit, which is a very different problem from ArchiCAD refusing it.
   */
  planned: Record<string, number>;
  cancelled?: false;
}

export type PushOutcome = BrowserPushResult | { cancelled: true };

export function isCancelled(r: PushOutcome): r is { cancelled: true } {
  return 'cancelled' in r && r.cancelled === true;
}

export async function pushGraphToArchicad(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  opts: PushOptions = {},
): Promise<PushOutcome> {
  const client = new TapirClient(RELAY_URL);

  // Fails fast and with a usable message when ArchiCAD is not running — better
  // here than midway through, after elements have already been deleted.
  const product = await client.productInfo();
  const version = await client.addOnVersion();

  const info = await client.projectInfo();
  if (!info.isUntitled && opts.confirmSavedProject) {
    const ok = await opts.confirmSavedProject(info.projectPath);
    if (!ok) return { cancelled: true };
  }

  const plan = buildArchicadModel(nodes, edges);
  const planned: Record<string, number> = {};
  for (const k of ['stories', 'walls', 'columns', 'beams', 'slabs', 'roofs', 'stairs', 'windows', 'doors'] as const) {
    if (plan[k].length) planned[k] = plan[k].length;
  }

  const result = await pushToArchicad(client, plan);
  return { ...result, planned, archicad: `ArchiCAD ${product.version}, Tapir ${version}` };
}
