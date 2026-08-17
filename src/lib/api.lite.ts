/**
 * api.lite.ts — Drop-in replacement for api.ts in the static lite build.
 *
 * Graph persistence uses localStorage instead of the FastAPI backend.
 * Chat / IFC upload / plan functions return empty/no-op responses — the UI
 * already handles backend unavailability gracefully.
 */

import { parseAxes } from './utils';

const LS_KEY = 'bubblebim_lite_graph';

// ─── Re-export all types so existing import sites keep working ─────────────

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

// ─── Graph persistence (localStorage) ─────────────────────────────────────

export async function checkHealth() {
  return { status: 'lite-mode' };
}

export async function loadGraph(): Promise<GraphData> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { nodes: [], edges: [], buildingAxes: { xValues: [], yValues: [] } };
    const data: GraphData = JSON.parse(raw);

    for (const node of data.nodes) {
      if (node.type === 'storey' && node.properties) {
        node.properties.axesX = parseAxes(node.properties.axesX);
        node.properties.axesY = parseAxes(node.properties.axesY);

        if (
          (node.properties.axesX as number[]).length === 0 ||
          (node.properties.axesY as number[]).length === 0
        ) {
          const children = data.nodes.filter(n => n.type === 'ax' && n.parentId === node.id);
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
  } catch {
    return { nodes: [], edges: [], buildingAxes: { xValues: [], yValues: [] } };
  }
}

export async function saveGraph(data: GraphData): Promise<{ status: string }> {
  localStorage.setItem(LS_KEY, JSON.stringify(data));
  return { status: 'saved' };
}

export async function createBackup(label = 'manual'): Promise<{ status: string }> {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) {
    const key = `bubblebim_lite_backup_${label}_${Date.now()}`;
    localStorage.setItem(key, raw);
    // Keep only the 10 most recent backups to avoid filling localStorage
    const allKeys = Object.keys(localStorage)
      .filter(k => k.startsWith('bubblebim_lite_backup_'))
      .sort();
    if (allKeys.length > 10) {
      allKeys.slice(0, allKeys.length - 10).forEach(k => localStorage.removeItem(k));
    }
  }
  return { status: 'backed-up' };
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
  throw new Error('Restore requires the full application.');
}

// ─── Chat (disabled in lite) ───────────────────────────────────────────────

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
  return { reply: 'AI chat is not available in the demo version.', cypher: null, results: null, action: null };
}

export interface ChatStatusResponse {
  ollama: boolean;
  model: string | null;
  base_url: string;
}

export async function getChatStatus(): Promise<ChatStatusResponse> {
  return { ollama: false, model: null, base_url: '' };
}

// ─── IFC (disabled in lite) ───────────────────────────────────────────────

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

// ─── IFC Plan / Wall footprints ────────────────────────────────────────────

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
  return null; // triggers TypeScript fallback in callers
}

export async function getGeometryStatus(): Promise<{ shapely: boolean } | null> {
  return null;
}

// ─── Version history (localStorage — no backend, so no content-addressing
// dedup either; commits store their content inline, capped to LITE_HISTORY_MAX
// entries with the oldest 'auto' commit evicted first once full, same
// durable-kinds-never-pruned rule as backend/version_history.py). ──────────

const LS_HISTORY_KEY = 'bubblebim_lite_history';
const LITE_HISTORY_MAX = 30;

export type HistoryCommitKind = 'manual' | 'auto' | 'checkpoint' | 'restore' | 'pre-ifc-import';

export interface HistoryComment { text: string; timestamp: string; }

export interface HistoryCommit {
  id: number;
  hash: string;
  parent: number | null;
  message: string;
  kind: HistoryCommitKind;
  timestamp: string;
  node_count: number;
  edge_count: number;
  comments?: HistoryComment[];
}

export interface HistoryDiffSummary {
  nodes: { added: string[]; removed: string[]; modified: string[] };
  edges: { added: string[]; removed: string[] };
}

interface LiteHistoryEntry extends HistoryCommit {
  content: GraphData; // stored inline — no separate blob store needed at localStorage scale
}

function stripContent(e: LiteHistoryEntry): HistoryCommit {
  const { content: _content, ...rest } = e;
  return rest;
}

function loadLiteHistory(): LiteHistoryEntry[] {
  try {
    const raw = localStorage.getItem(LS_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLiteHistory(log: LiteHistoryEntry[]): void {
  try {
    localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(log));
  } catch {
    // Quota exceeded — drop the oldest entry and retry once rather than losing the whole log.
    if (log.length > 1) saveLiteHistory(log.slice(1));
  }
}

export async function commitHistory(message: string, kind: HistoryCommitKind = 'manual'): Promise<{ success: boolean; commit: HistoryCommit } | null> {
  const raw = localStorage.getItem(LS_KEY);
  const content: GraphData = raw ? JSON.parse(raw) : { nodes: [], edges: [] };
  const hash = JSON.stringify(content); // cheap identity check — good enough at this scale, no crypto needed
  const log = loadLiteHistory();

  if (log.length && log[log.length - 1].hash === hash && kind !== 'checkpoint' && kind !== 'restore') {
    return { success: true, commit: stripContent(log[log.length - 1]) };
  }

  const entry: LiteHistoryEntry = {
    id: log.length ? log[log.length - 1].id + 1 : 1,
    hash,
    parent: log.length ? log[log.length - 1].id : null,
    message,
    kind,
    timestamp: new Date().toISOString(),
    node_count: content.nodes.length,
    edge_count: content.edges.length,
    comments: [],
    content,
  };
  log.push(entry);
  if (log.length > LITE_HISTORY_MAX) {
    const autoIdx = log.findIndex((e) => e.kind === 'auto');
    log.splice(autoIdx >= 0 ? autoIdx : 0, 1); // evict the oldest 'auto' first; durable kinds only as a last resort
  }
  saveLiteHistory(log);
  return { success: true, commit: stripContent(entry) };
}

export async function listHistory(limit = 50): Promise<HistoryCommit[]> {
  return loadLiteHistory().slice().reverse().slice(0, limit).map(stripContent);
}

export async function getHistoryCommitContent(commitId: number): Promise<GraphData | null> {
  return loadLiteHistory().find((e) => e.id === commitId)?.content ?? null;
}

export async function restoreHistoryCommit(commitId: number): Promise<{ success: boolean; commit: HistoryCommit; nodes_restored: number; edges_restored: number } | null> {
  const entry = loadLiteHistory().find((e) => e.id === commitId);
  if (!entry) return null;
  localStorage.setItem(LS_KEY, JSON.stringify(entry.content));
  const result = await commitHistory(`Restored: ${entry.message || `commit #${entry.id}`}`, 'restore');
  if (!result) return null;
  return { success: true, commit: result.commit, nodes_restored: entry.content.nodes.length, edges_restored: entry.content.edges.length };
}

export async function getHistoryDiff(fromId: number, toId: number): Promise<HistoryDiffSummary | null> {
  const log = loadLiteHistory();
  const a = log.find((e) => e.id === fromId)?.content;
  const b = log.find((e) => e.id === toId)?.content;
  if (!a || !b) return null;
  const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(b.nodes.map((n) => [n.id, n]));
  const aEdges = new Map(a.edges.map((e) => [e.id, e]));
  const bEdges = new Map(b.edges.map((e) => [e.id, e]));
  return {
    nodes: {
      added: [...bNodes.keys()].filter((id) => !aNodes.has(id)).sort(),
      removed: [...aNodes.keys()].filter((id) => !bNodes.has(id)).sort(),
      modified: [...bNodes.keys()].filter((id) => aNodes.has(id) && JSON.stringify(aNodes.get(id)) !== JSON.stringify(bNodes.get(id))).sort(),
    },
    edges: {
      added: [...bEdges.keys()].filter((id) => !aEdges.has(id)).sort(),
      removed: [...aEdges.keys()].filter((id) => !bEdges.has(id)).sort(),
    },
  };
}

export async function gcHistory(keepAuto = 50): Promise<{ success: boolean; pruned_commits: number; freed_count: number; freed_bytes: number } | null> {
  const log = loadLiteHistory();
  const autos = log.filter((e) => e.kind === 'auto'); // oldest first
  const dropIds = new Set(autos.slice(0, Math.max(0, autos.length - keepAuto)).map((e) => e.id));
  const beforeSize = JSON.stringify(log).length;
  const next = log.filter((e) => !dropIds.has(e.id));
  saveLiteHistory(next);
  return { success: true, pruned_commits: dropIds.size, freed_count: dropIds.size, freed_bytes: Math.max(0, beforeSize - JSON.stringify(next).length) };
}

export async function addHistoryComment(commitId: number, text: string): Promise<{ success: boolean; commit: HistoryCommit } | null> {
  const log = loadLiteHistory();
  const entry = log.find((e) => e.id === commitId);
  if (!entry) return null;
  const t = text.trim();
  if (t) {
    entry.comments = entry.comments ?? [];
    entry.comments.push({ text: t, timestamp: new Date().toISOString() });
    saveLiteHistory(log);
  }
  return { success: true, commit: stripContent(entry) };
}
