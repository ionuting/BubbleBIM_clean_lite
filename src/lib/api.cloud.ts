/**
 * api.cloud.ts — Clean cloud build: JWT + per-user projects via FastAPI.
 * Drop-in replacement for api.ts / api.lite.ts (same exports BubbleGraphPanel needs).
 */

import { parseAxes } from './utils';
import { authHeaders, getActiveProjectId, getToken } from './auth';

const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) || '/api').replace(/\/$/, '');

export interface BubbleGraphNode {
  id: string;
  type: string;
  name?: string;
  x: number;
  y: number;
  parentId?: string | null;
  properties: Record<string, unknown>;
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

function normalizeGraph(data: GraphData): GraphData {
  for (const node of data.nodes) {
    if (node.type === 'storey' && node.properties) {
      node.properties.axesX = parseAxes(node.properties.axesX);
      node.properties.axesY = parseAxes(node.properties.axesY);
      if (
        (node.properties.axesX as number[]).length === 0 ||
        (node.properties.axesY as number[]).length === 0
      ) {
        const children = data.nodes.filter((n) => n.type === 'ax' && n.parentId === node.id);
        if (children.length > 0) {
          const xs = [...new Set(children.map((n) => n.x))].sort((a, b) => a - b);
          const ys = [...new Set(children.map((n) => n.y))].sort((a, b) => a - b);
          if ((node.properties.axesX as number[]).length === 0) node.properties.axesX = xs;
          if ((node.properties.axesY as number[]).length === 0) node.properties.axesY = ys;
        }
      }
    }
  }
  return data;
}

export async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return await res.json();
  } catch {
    return null;
  }
}

export async function loadGraph(): Promise<GraphData> {
  const projectId = getActiveProjectId();
  if (!projectId || !getToken()) {
    return { nodes: [], edges: [], buildingAxes: { xValues: [], yValues: [] } };
  }
  try {
    const res = await fetch(`${API_BASE}/projects/${projectId}`, {
      headers: authHeaders(false),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as GraphData;
    return normalizeGraph({
      nodes: data.nodes ?? [],
      edges: data.edges ?? [],
      buildingAxes: data.buildingAxes ?? { xValues: [], yValues: [] },
      activeStoreyId: data.activeStoreyId ?? null,
      projectName: data.projectName,
      annotations: data.annotations,
      worldLocation: data.worldLocation,
      globeInstances: data.globeInstances,
      composerShapes: data.composerShapes,
      viewTabs: data.viewTabs,
      activeTabId: data.activeTabId,
    });
  } catch (err) {
    console.error('Failed to load project:', err);
    return { nodes: [], edges: [], buildingAxes: { xValues: [], yValues: [] } };
  }
}

export async function saveGraph(data: GraphData) {
  const projectId = getActiveProjectId();
  if (!projectId || !getToken()) {
    throw new Error('No active project — sign in and open a project first');
  }
  const res = await fetch(`${API_BASE}/projects/${projectId}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return await res.json();
}

export async function createBackup(_label = 'manual') {
  return { status: 'ok', message: 'Cloud projects auto-persist on save' };
}

export async function listBackups() {
  return { backups: [] };
}

export async function exportIFC(_data: GraphData) {
  throw new Error('IFC export requires the full desktop application.');
}

export async function exportSVG(_data: GraphData) {
  throw new Error('SVG export requires the full application.');
}

export async function searchGraph(_query: string) {
  return { results: [] };
}

export async function searchByType(_type: string) {
  return { results: [] };
}

export async function getGraphStats() {
  return { total_nodes: 0, total_edges: 0, node_types: {} };
}

export async function restoreBackup(_backupName: string) {
  throw new Error('Restore not available in cloud Clean.');
}

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

export async function sendChatMessage(): Promise<ChatApiResponse> {
  return { reply: 'AI chat is not enabled in BubbleBIM Clean cloud.', cypher: null, results: null, action: null };
}

export interface ChatStatusResponse {
  ollama: boolean;
  model: string | null;
  base_url: string;
}

export async function getChatStatus(): Promise<ChatStatusResponse> {
  return { ollama: false, model: null, base_url: '' };
}

export interface IFCStoreyInfo { name: string; elevation_mm: number; }
export interface IFCOpeningInfo {
  type: 'window' | 'door' | 'opening'; name: string;
  width_mm: number; height_mm: number; sillHeight_mm: number; offsetAlongWall_mm: number;
}
export interface IFCWallInfo {
  guid: string; name: string; startPt_mm: [number, number]; endPt_mm: [number, number];
  thickness_mm: number; height_mm: number; openings: IFCOpeningInfo[];
}
export interface IFCParsedStorey {
  storey: { name: string; elevation_mm: number; height_mm: number };
  allStoreys: IFCStoreyInfo[];
  walls: IFCWallInfo[];
  axesX_mm: number[]; axesY_mm: number[];
  wallCount: number; openingCount: number; error?: string;
}
export interface IFCParseResponse {
  parsed: IFCParsedStorey;
  graph: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } | null;
  llmUsed: boolean; llmError?: string;
}

export async function uploadIFCFile(_file: File): Promise<{ fileKey: string; size: number }> {
  throw new Error('IFC upload requires the full application.');
}

export async function parseIFCStorey(): Promise<IFCParseResponse> {
  throw new Error('IFC parsing requires the full application.');
}

export async function commitIFCGraph(): Promise<{ success: boolean; addedNodes: number; addedEdges: number; backup: string }> {
  throw new Error('IFC commit requires the full application.');
}

export interface IFCPlanApiWall {
  id: string; guid: string; name: string;
  startPt_mm: [number, number]; endPt_mm: [number, number];
  footprint_mm: [number, number][]; thickness_mm: number; height_mm: number;
  openings: { type: string; name: string; width_mm: number; height_mm: number;
              sillHeight_mm: number; offsetAlongWall_mm: number }[];
}
export interface IFCPlanApiSlab {
  id: string; guid: string; name: string;
  footprint_mm: [number, number][]; thickness_mm: number; baseElevation_mm: number;
}
export interface IFCPlanApiStorey {
  id: string; name: string; elevation_mm: number; height_mm: number;
  walls: IFCPlanApiWall[]; slabs: IFCPlanApiSlab[];
  axesX_mm: number[]; axesY_mm: number[];
}
export interface IFCPlanApiResponse {
  success: boolean; storeys: IFCPlanApiStorey[];
  worldBounds: { minX_mm: number; minY_mm: number; maxX_mm: number; maxY_mm: number };
  totalWalls: number; totalSlabs: number;
}

export async function fetchIFCPlan(): Promise<IFCPlanApiResponse> {
  throw new Error('IFC plan requires the full application.');
}

export interface WallFootprint {
  id: string; name: string;
  footprint: [number, number][]; storeyId: string;
  bottomElevation: number; topElevation: number; thickness: number; wallType: string;
}
export interface WallFootprintsResponse { walls: WallFootprint[]; count: number; }

export async function fetchWallFootprints(): Promise<WallFootprintsResponse | null> {
  return null;
}

export async function getGeometryStatus(): Promise<{ shapely: boolean } | null> {
  return null;
}

// ─── Version history — per-project, scoped to the active cloud project ────
// Backed by a dedicated VersionHistory root per project
// (backend/data/project_history/<projectId>/ — see get_project_history_dir()
// in auth_db.py), exposed at /api/projects/{projectId}/history/* in
// auth_routes.py (ownership-checked the same way GET/PUT /projects/{id}
// already are). Never throws — returns null/[] (with a console note) when
// there's no active project/token, same contract as every other function
// in this file, so the History panel degrades to its empty state instead
// of crashing.

export type HistoryCommitKind = 'manual' | 'auto' | 'checkpoint' | 'restore' | 'pre-ifc-import';
export interface HistoryComment { text: string; timestamp: string; }
export interface HistoryCommit {
  id: number; hash: string; parent: number | null; message: string; kind: HistoryCommitKind;
  timestamp: string; node_count: number; edge_count: number; comments?: HistoryComment[];
}
export interface HistoryDiffSummary {
  nodes: { added: string[]; removed: string[]; modified: string[] };
  edges: { added: string[]; removed: string[] };
}

function requireProject(): string | null {
  const projectId = getActiveProjectId();
  if (!projectId || !getToken()) {
    console.warn('[api.cloud] Version history needs an active project — sign in and open a project first.');
    return null;
  }
  return projectId;
}

export async function commitHistory(message: string, kind: HistoryCommitKind = 'manual'): Promise<{ success: boolean; commit: HistoryCommit } | null> {
  const projectId = requireProject();
  if (!projectId) return null;
  try {
    const res = await fetch(
      `${API_BASE}/projects/${projectId}/history/commit?message=${encodeURIComponent(message)}&kind=${kind}`,
      { method: 'POST', headers: authHeaders(false) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to commit history:', err);
    return null;
  }
}

export async function listHistory(limit = 50): Promise<HistoryCommit[]> {
  const projectId = requireProject();
  if (!projectId) return [];
  try {
    const res = await fetch(`${API_BASE}/projects/${projectId}/history?limit=${limit}`, { headers: authHeaders(false) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.commits ?? [];
  } catch (err) {
    console.error('❌ Failed to list history:', err);
    return [];
  }
}

export async function getHistoryCommitContent(commitId: number): Promise<GraphData | null> {
  const projectId = requireProject();
  if (!projectId) return null;
  try {
    const res = await fetch(`${API_BASE}/projects/${projectId}/history/${commitId}?include_content=true`, { headers: authHeaders(false) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.content ?? null;
  } catch (err) {
    console.error('❌ Failed to load commit content:', err);
    return null;
  }
}

export async function restoreHistoryCommit(commitId: number): Promise<{ success: boolean; commit: HistoryCommit; nodes_restored: number; edges_restored: number } | null> {
  const projectId = requireProject();
  if (!projectId) return null;
  try {
    const res = await fetch(`${API_BASE}/projects/${projectId}/history/restore/${commitId}`, { method: 'POST', headers: authHeaders(false) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to restore commit:', err);
    return null;
  }
}

export async function getHistoryDiff(fromId: number, toId: number): Promise<HistoryDiffSummary | null> {
  const projectId = requireProject();
  if (!projectId) return null;
  try {
    const res = await fetch(`${API_BASE}/projects/${projectId}/history/diff/summary?from_id=${fromId}&to_id=${toId}`, { headers: authHeaders(false) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to diff history:', err);
    return null;
  }
}

export async function gcHistory(keepAuto = 50): Promise<{ success: boolean; pruned_commits: number; freed_count: number; freed_bytes: number } | null> {
  const projectId = requireProject();
  if (!projectId) return null;
  try {
    const res = await fetch(`${API_BASE}/projects/${projectId}/history/gc?keep_auto=${keepAuto}`, { method: 'POST', headers: authHeaders(false) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to run history gc:', err);
    return null;
  }
}

export async function addHistoryComment(commitId: number, text: string): Promise<{ success: boolean; commit: HistoryCommit } | null> {
  const projectId = requireProject();
  if (!projectId) return null;
  try {
    const res = await fetch(
      `${API_BASE}/projects/${projectId}/history/${commitId}/comment?text=${encodeURIComponent(text)}`,
      { method: 'POST', headers: authHeaders(false) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Failed to add comment:', err);
    return null;
  }
}
