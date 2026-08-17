/**
 * BubbleGraph API Client
 * Communicates with Python FastAPI backend
 */

import { parseAxes } from './utils';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

// ─── Types ───────────────────────────────────────────────────────────────

export interface BubbleGraphNode {
  id: string;
  type: string;
  name?: string;
  x: number;
  y: number;
  parentId?: string | null;
  properties: Record<string, any>;
}

export interface BubbleGraphEdge {
  id: string;
  from: string;
  to: string;
}

export interface BuildingAxes {
  xValues: number[];
  yValues: number[];
}

export interface GraphData {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes?: BuildingAxes;
  activeStoreyId?: string | null;
  projectName?: string;
  annotations?: import('@/store').DrawingAnnotation[];
  worldLocation?: import('@/store').WorldLocation;
  globeInstances?: import('@/store').GlobeInstance[];
  composerShapes?: import('@/store').RoomXShape[];
  /** Open drawing tabs (plans/sections/elevations/…) — persisted so the drawing workspace survives a reload. */
  viewTabs?: import('@/store').ViewTab[];
  activeTabId?: string;
}

// ─── API Functions ───────────────────────────────────────────────────────

/**
 * Check backend health
 */
export async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return await res.json();
  } catch (err) {
    console.error('❌ Backend unavailable:', err);
    return null;
  }
}

/**
 * Load graph from backend — normalises axesX/axesY arrays on every storey node
 * (guards against legacy LadybugDB JSON-string serialisation).
 */
export async function loadGraph(): Promise<GraphData> {
  try {
    const res = await fetch(`${API_BASE}/graph/load`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: GraphData = await res.json();

    // Normalise axesX / axesY on storey nodes
    for (const node of data.nodes) {
      if (node.type === 'storey' && node.properties) {
        node.properties.axesX = parseAxes(node.properties.axesX);
        node.properties.axesY = parseAxes(node.properties.axesY);

        // Reconstruct from ax children when axes are empty (migration safety)
        if (
          (node.properties.axesX as number[]).length === 0 ||
          (node.properties.axesY as number[]).length === 0
        ) {
          const children = data.nodes.filter(
            n => n.type === 'ax' && n.parentId === node.id,
          );
          if (children.length > 0) {
            const xs = [...new Set(children.map(n => n.x))].sort((a, b) => a - b);
            const ys = [...new Set(children.map(n => n.y))].sort((a, b) => a - b);
            if ((node.properties.axesX as number[]).length === 0) node.properties.axesX = xs;
            if ((node.properties.axesY as number[]).length === 0) node.properties.axesY = ys;
          }
        }
      }
    }

    return data;
  } catch (err) {
    console.error('❌ Failed to load graph:', err);
    return { nodes: [], edges: [], buildingAxes: { xValues: [], yValues: [] } };
  }
}

/**
 * Save graph to backend
 */
export async function saveGraph(data: GraphData) {
  try {
    const res = await fetch(`${API_BASE}/graph/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to save graph:', err);
    throw err;
  }
}

/**
 * Create backup
 */
export async function createBackup(label: string = 'manual') {
  try {
    const res = await fetch(`${API_BASE}/graph/backup?label=${label}`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to create backup:', err);
    throw err;
  }
}

/**
 * List backups
 */
export async function listBackups() {
  try {
    const res = await fetch(`${API_BASE}/graph/backups`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to list backups:', err);
    return { backups: [] };
  }
}

/**
 * Export as IFC STEP format
 */
export async function exportIFC(data: GraphData) {
  try {
    const res = await fetch(`${API_BASE}/graph/export-ifc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to export IFC:', err);
    throw err;
  }
}

/**
 * Export as SVG floor plan
 */
export async function exportSVG(data: GraphData) {
  try {
    const res = await fetch(`${API_BASE}/graph/export-svg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to export SVG:', err);
    throw err;
  }
}

/**
 * Full-text search nodes
 */
export async function searchGraph(query: string) {
  try {
    const res = await fetch(`${API_BASE}/graph/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Search failed:', err);
    return { results: [] };
  }
}

/**
 * Search nodes by type
 */
export async function searchByType(type: string) {
  try {
    const res = await fetch(`${API_BASE}/graph/search-by-type?type=${encodeURIComponent(type)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Type search failed:', err);
    return { results: [] };
  }
}

/**
 * Get graph statistics
 */
export async function getGraphStats() {
  try {
    const res = await fetch(`${API_BASE}/graph/stats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to get stats:', err);
    return { total_nodes: 0, total_edges: 0, node_types: {} };
  }
}

/**
 * Restore graph from backup
 */
export async function restoreBackup(backupName: string) {
  try {
    const res = await fetch(`${API_BASE}/graph/restore?backup_name=${encodeURIComponent(backupName)}`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Restore failed:', err);
    throw err;
  }
}

// ─── Version history (git-like commit log — backend/version_history.py) ───
// Replaces the raw backups/ scheme above: content-addressed (dedup), real
// commit metadata (message + kind), and an explicit retention policy
// (historyGc) instead of unbounded growth. See the History panel.

export type HistoryCommitKind = 'manual' | 'auto' | 'checkpoint' | 'restore' | 'pre-ifc-import';

export interface HistoryComment {
  text: string;
  timestamp: string; // ISO 8601, UTC
}

export interface HistoryCommit {
  id: number;
  hash: string;
  parent: number | null;
  message: string;
  kind: HistoryCommitKind;
  timestamp: string; // ISO 8601, UTC
  node_count: number;
  edge_count: number;
  /** Notes added AFTER the fact — never touches the commit's own content/message/hash. Absent on commits made before this field existed. */
  comments?: HistoryComment[];
}

export interface HistoryDiffSummary {
  nodes: { added: string[]; removed: string[]; modified: string[] };
  edges: { added: string[]; removed: string[] };
}

/** Commit the CURRENTLY SAVED backend graph state (call saveGraph() first if local edits haven't been pushed yet). */
export async function commitHistory(message: string, kind: HistoryCommitKind = 'manual'): Promise<{ success: boolean; commit: HistoryCommit } | null> {
  try {
    const res = await fetch(`${API_BASE}/graph/history/commit?message=${encodeURIComponent(message)}&kind=${kind}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to commit history:', err);
    return null;
  }
}

/** Newest-first commit list. */
export async function listHistory(limit = 50): Promise<HistoryCommit[]> {
  try {
    const res = await fetch(`${API_BASE}/graph/history?limit=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.commits ?? [];
  } catch (err) {
    console.error('❌ Failed to list history:', err);
    return [];
  }
}

/** Fetch one commit's content (for a read-only preview) without touching the live graph. */
export async function getHistoryCommitContent(commitId: number): Promise<GraphData | null> {
  try {
    const res = await fetch(`${API_BASE}/graph/history/${commitId}?include_content=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.content ?? null;
  } catch (err) {
    console.error('❌ Failed to load commit content:', err);
    return null;
  }
}

/**
 * Restore a commit — appends a NEW "restore" commit carrying the target's
 * content (nothing in the log is ever deleted or rewritten) and applies it
 * to the live backend graph. Caller still needs to reload into the local
 * React state (this only updates the backend's bubble_graph.json).
 */
export async function restoreHistoryCommit(commitId: number): Promise<{ success: boolean; commit: HistoryCommit; nodes_restored: number; edges_restored: number } | null> {
  try {
    const res = await fetch(`${API_BASE}/graph/history/restore/${commitId}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to restore commit:', err);
    return null;
  }
}

/** Node/edge-level diff (added/removed/modified ids) between two commits. */
export async function getHistoryDiff(fromId: number, toId: number): Promise<HistoryDiffSummary | null> {
  try {
    const res = await fetch(`${API_BASE}/graph/history/diff/summary?from_id=${fromId}&to_id=${toId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to diff history:', err);
    return null;
  }
}

/** Prune old 'auto' commit metadata beyond `keepAuto`, then reclaim unreferenced blobs. */
export async function gcHistory(keepAuto = 50): Promise<{ success: boolean; pruned_commits: number; freed_count: number; freed_bytes: number } | null> {
  try {
    const res = await fetch(`${API_BASE}/graph/history/gc?keep_auto=${keepAuto}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to run history gc:', err);
    return null;
  }
}

/** Append a note to a commit — does NOT touch its content, message, or hash (GitHub-style commit comment). */
export async function addHistoryComment(commitId: number, text: string): Promise<{ success: boolean; commit: HistoryCommit } | null> {
  try {
    const res = await fetch(`${API_BASE}/graph/history/${commitId}/comment?text=${encodeURIComponent(text)}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to add comment:', err);
    return null;
  }
}

// ─── Chat ─────────────────────────────────────────────────────────────────

export interface ChatHistoryEntry {
  role: string;
  content: string;
}

export interface ChatApiResponse {
  reply: string;
  cypher?: string | null;
  results?: unknown[] | null;
  action?: string | null;
}

/**
 * Send a natural-language or Cypher message to the chatbot endpoint.
 */
export async function sendChatMessage(
  message: string,
  history: ChatHistoryEntry[] = [],
): Promise<ChatApiResponse> {
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Chat API ${res.status}: ${detail}`);
  }
  return res.json();
}

export interface ChatStatusResponse {
  ollama: boolean;
  model: string | null;
  base_url: string;
}

/**
 * Check whether ollama is reachable and which model is active.
 */
export async function getChatStatus(): Promise<ChatStatusResponse> {
  const res = await fetch(`${API_BASE}/chat/status`);
  if (!res.ok) return { ollama: false, model: null, base_url: '' };
  return res.json();
}

// ── IFC Import ───────────────────────────────────────────────────────────────

export interface IFCStoreyInfo {
  name: string;
  elevation_mm: number;
}

export interface IFCOpeningInfo {
  type: 'window' | 'door' | 'opening';
  name: string;
  width_mm: number;
  height_mm: number;
  sillHeight_mm: number;
  offsetAlongWall_mm: number;
}

export interface IFCWallInfo {
  guid: string;
  name: string;
  startPt_mm: [number, number];
  endPt_mm: [number, number];
  thickness_mm: number;
  height_mm: number;
  openings: IFCOpeningInfo[];
}

export interface IFCParsedStorey {
  storey: { name: string; elevation_mm: number; height_mm: number };
  allStoreys: IFCStoreyInfo[];
  walls: IFCWallInfo[];
  axesX_mm: number[];
  axesY_mm: number[];
  wallCount: number;
  openingCount: number;
  error?: string;
}

export interface IFCParseResponse {
  parsed: IFCParsedStorey;
  graph: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } | null;
  llmUsed: boolean;
  llmError?: string;
}

/** Upload an IFC file to the backend. Returns a fileKey for subsequent calls. */
export async function uploadIFCFile(file: File): Promise<{ fileKey: string; size: number }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/ifc/upload`, { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Upload failed');
  }
  return res.json();
}

/** Parse one storey from an uploaded IFC file and optionally LLM-parametrize it. */
export async function parseIFCStorey(
  fileKey: string,
  storeyName?: string,
  storeyIndex = 0,
  llmParametrize = true,
): Promise<IFCParseResponse> {
  const res = await fetch(`${API_BASE}/ifc/parse-storey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileKey, storeyName, storeyIndex, llmParametrize }),
    signal: AbortSignal.timeout(120_000),  // LLM can take up to 2 min
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Parse failed');
  }
  return res.json();
}

/** Commit LLM-generated nodes+edges into the current graph (with auto-backup). */
export async function commitIFCGraph(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): Promise<{ success: boolean; addedNodes: number; addedEdges: number; backup: string }> {
  const res = await fetch(`${API_BASE}/ifc/commit-graph`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Commit failed');
  }
  return res.json();
}

// ── IFC Plan View ─────────────────────────────────────────────────────────

export interface IFCPlanApiWall {
  id: string; guid: string; name: string;
  startPt_mm: [number, number]; endPt_mm: [number, number];
  footprint_mm: [number, number][];
  thickness_mm: number; height_mm: number;
  openings: { type: string; name: string; width_mm: number; height_mm: number;
              sillHeight_mm: number; offsetAlongWall_mm: number }[];
}
export interface IFCPlanApiSlab {
  id: string; guid: string; name: string;
  footprint_mm: [number, number][];
  thickness_mm: number;
  baseElevation_mm: number;
}
export interface IFCPlanApiStorey {
  id: string; name: string; elevation_mm: number; height_mm: number;
  walls: IFCPlanApiWall[];
  slabs: IFCPlanApiSlab[];
  axesX_mm: number[]; axesY_mm: number[];
}
export interface IFCPlanApiResponse {
  success: boolean;
  storeys: IFCPlanApiStorey[];
  worldBounds: { minX_mm: number; minY_mm: number; maxX_mm: number; maxY_mm: number };
  totalWalls: number;
  totalSlabs: number;
}

export async function fetchIFCPlan(fileKey: string): Promise<IFCPlanApiResponse> {
  const res = await fetch(`${API_BASE}/ifc/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileKey }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'IFC plan fetch failed');
  }
  return res.json();
}



export interface WallFootprint {
  id: string;
  name: string;
  /** 2-D plan polygon in mm [[x, y], …], CCW, last point ≠ first */
  footprint: [number, number][];
  storeyId: string;
  bottomElevation: number;   // mm
  topElevation: number;      // mm
  thickness: number;         // mm
  wallType: string;
}

export interface WallFootprintsResponse {
  walls: WallFootprint[];
  count: number;
}

/**
 * Ask the backend (Shapely) to compute joined wall plan footprints.
 *
 * The backend applies the "extension/boolean" method:
 *  - Each wall is extended by half its thickness at structural junctions.
 *  - Meeting walls are unioned at each junction.
 *  - Each wall's footprint is clipped back to its directional strip.
 *
 * Returns null when the backend is unavailable (Shapely not installed or
 * backend not running), so callers can fall back to the TypeScript path.
 */
export async function fetchWallFootprints(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): Promise<WallFootprintsResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/geometry/wall-footprints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes, edges }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<WallFootprintsResponse>;
  } catch {
    // Backend not running or Shapely unavailable — caller will use TypeScript fallback
    return null;
  }
}

/**
 * Check which geometry backends are available on the server.
 */
export async function getGeometryStatus(): Promise<{ shapely: boolean } | null> {
  try {
    const res = await fetch(`${API_BASE}/geometry/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
