/**
 * The two topology calls, for whichever API base the build talks to.
 *
 * `@/lib/api` is a different module per build (full, cloud, lite), each with
 * its own base URL; they all export these through `topologyClient(API_BASE)`
 * so the view never has to know which one it got.
 */
import type { SolidsResult, TopologyRequest, TopologyResult, TopologyStatus } from './types';

/** The backend's own `detail`, which says why (kernel missing, timeout…). */
async function failure(res: Response): Promise<Error> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json() as { detail?: unknown };
    if (typeof body.detail === 'string') detail = body.detail;
  } catch { /* not JSON — keep the status line */ }
  return new Error(detail);
}

export function topologyClient(apiBase: string) {
  const base = apiBase.replace(/\/$/, '');
  return {
    async status(): Promise<TopologyStatus> {
      try {
        const res = await fetch(`${base}/topology/status`);
        if (!res.ok) return { available: false, error: (await failure(res)).message };
        return await res.json() as TopologyStatus;
      } catch (err) {
        return { available: false, error: `Backend unreachable: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    async analyze(req: TopologyRequest, signal?: AbortSignal): Promise<TopologyResult> {
      const res = await fetch(`${base}/topology/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal,
      });
      if (!res.ok) throw await failure(res);
      return await res.json() as TopologyResult;
    },
    async solids(ifc: string, signal?: AbortSignal): Promise<SolidsResult> {
      const res = await fetch(`${base}/topology/solids`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ifc }),
        signal,
      });
      if (!res.ok) throw await failure(res);
      return await res.json() as SolidsResult;
    },
  };
}
