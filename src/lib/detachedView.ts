/**
 * detachedView.ts — the contract between the main window and a view that has
 * been pulled out into its own OS window.
 *
 * Two BrowserWindows are two JavaScript contexts with two separate Zustand
 * stores; nothing is shared but what crosses IPC. This module is the whole of
 * what crosses it, kept pure so both ends agree without either importing the
 * other's React.
 *
 * ## Which way things flow
 *
 * The main window OWNS the model. It publishes a `GraphBroadcast` whenever the
 * graph, the axes or the tab list changes; the main process caches the last one
 * and fans it out. A detached window renders what it is given and never writes
 * back — a section on the second monitor follows the model, it does not edit
 * it. That is why `DETACHABLE_VIEWS` lists viewers only: a sheet composer or the
 * graph editor would invite edits that are silently thrown away at the next
 * broadcast.
 *
 * ## Why the URL carries so little
 *
 * A detached window is addressed by `?view=<type>&tab=<id>` and nothing else.
 * Everything that can change while the window is open — the storey, the cut
 * depth, the marker position, the label — lives in the broadcast's `tabs`, so
 * dragging a section marker in the plan redraws the detached section. Baking
 * those into the URL would freeze them at the moment of detaching.
 */

import type {
  BubbleGraphEdge, BubbleGraphNode, BuildingAxes, ViewTab, ViewTabType, Viewer3DType,
} from '@/store';

/** The views that are safe to detach: pure renderers with no model editing. */
export const DETACHABLE_VIEWS: readonly ViewTabType[] = [
  'floorplan', 'section', 'elevation', '3d-model',
] as const;

export const isDetachable = (type: ViewTabType | undefined): boolean =>
  !!type && DETACHABLE_VIEWS.includes(type);

/** What a detached window knows about itself before the first broadcast lands. */
export interface DetachedSpec {
  viewType: ViewTabType;
  tabId: string;
  /** Only for the window title while we wait — the live label comes in `tabs`. */
  label: string;
}

/** The whole of the model as a detached window sees it. */
export interface GraphBroadcast {
  /** Monotonic; a window that has already applied `rev` ignores it again. */
  rev: number;
  projectName: string;
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes: BuildingAxes;
  /** Every open tab, so a detached window can track its own params live. */
  tabs: ViewTab[];
  viewer3DType: Viewer3DType;
}

// ─── URL ──────────────────────────────────────────────────────────────────────

/** The query string that addresses a detached view. No leading `?`. */
export function detachSearch(spec: DetachedSpec): string {
  return new URLSearchParams({
    view: spec.viewType,
    tab: spec.tabId,
    label: spec.label ?? '',
  }).toString();
}

/**
 * Read a detached spec out of `location.search`, or null for the main window.
 *
 * An unknown or non-detachable `view` returns null rather than throwing: a
 * stale bookmark should open the app, not a blank window.
 */
export function parseDetachedSearch(search: string): DetachedSpec | null {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const view = q.get('view');
  const tab = q.get('tab');
  if (!view || !tab) return null;
  if (!DETACHABLE_VIEWS.includes(view as ViewTabType)) return null;
  return { viewType: view as ViewTabType, tabId: tab, label: q.get('label') ?? '' };
}

// ─── Reading a broadcast ──────────────────────────────────────────────────────

/**
 * The tab this window is showing, as of the latest broadcast.
 *
 * Falls back to the id/type the window was opened with, so a tab closed in the
 * main window leaves the detached one showing its last state instead of going
 * blank — `tabIsGone` is how a caller notices and says so.
 */
export function resolveTab(spec: DetachedSpec, broadcast: GraphBroadcast | null): ViewTab {
  const live = broadcast?.tabs.find((t) => t.id === spec.tabId);
  if (live) return live;
  return { id: spec.tabId, label: spec.label, type: spec.viewType, canClose: true };
}

export const tabIsGone = (spec: DetachedSpec, broadcast: GraphBroadcast | null): boolean =>
  !!broadcast && !broadcast.tabs.some((t) => t.id === spec.tabId);

/** The window title: the live tab label, else what we were opened with. */
export function detachedTitle(spec: DetachedSpec, broadcast: GraphBroadcast | null): string {
  const tab = resolveTab(spec, broadcast);
  const project = broadcast?.projectName;
  return project ? `${tab.label} — ${project}` : tab.label || 'BubbleGraph';
}
