// Type definitions for the Electron preload API exposed via contextBridge
// Available as window.electronAPI when running inside Electron

export interface ProjectData {
  nodes: unknown[];
  edges: unknown[];
  buildingAxes?: { xValues: number[]; yValues: number[] };
  projectName?: string;
  activeStoreyId?: string | null;
  worldLocation?: import('@/store').WorldLocation;
  terrain?: import('@/lib/terrain').TerrainModel;
}

export interface OpenResult {
  filePath: string;
  data: ProjectData;
  error?: string;
}

/** What a detached window is opened with. Mirrors `DetachedSpec`. */
export interface DetachSpec {
  viewType: string;
  tabId: string;
  label: string;
}

export interface ElectronAPI {
  /** Show native "Save As" dialog, returns chosen path or null if cancelled */
  saveAs: (defaultName?: string) => Promise<string | null>;
  /** Show native "Open" dialog, returns file path + parsed JSON data */
  openFile: () => Promise<OpenResult | null>;
  /** Write data to a file path */
  writeFile: (filePath: string, data: ProjectData) => Promise<{ success?: boolean; error?: string }>;
  /** Get current open project file path */
  getProjectPath: () => Promise<string | null>;
  /** Set current open project file path */
  setProjectPath: (fp: string) => Promise<void>;

  // Menu event listeners
  onMenuNewProject:   (cb: () => void) => void;
  onMenuOpenProject:  (cb: () => void) => void;
  onMenuSaveProject:  (cb: () => void) => void;
  onMenuExportIfc:    (cb: () => void) => void;
  onMenuDetachView:   (cb: () => void) => void;
  onProjectOpened:    (cb: (_event: unknown, payload: { filePath: string; data: ProjectData }) => void) => void;
  onRequestSaveAs:    (cb: () => void) => void;
  removeAllListeners: (channel: string) => void;

  // ── Detached view windows ───────────────────────────────────────────────
  /** Open (or focus) an OS window showing one view. Main window only. */
  detachView: (spec: DetachSpec) => Promise<{ id?: number; reused?: boolean; error?: string }>;
  /** Close a detached window by tab id — or, called from inside one, itself. */
  closeDetachedView: (tabId?: string) => Promise<boolean>;
  /** Which tabs currently have their own window. */
  listDetachedViews: () => Promise<string[]>;
  /** That list again, whenever it changes (main window only). */
  onDetachedViews: (cb: (tabIds: string[]) => void) => void;
  /** Close this detached window and bring its tab to the front in the main one. */
  reattachView: (tabId: string) => Promise<boolean>;
  /** Main window: a detached view asked to be shown here again. */
  onActivateTab: (cb: (tabId: string) => void) => void;

  /** Main window: hand the current model to every detached window. */
  publishGraph: (payload: unknown) => void;
  /** Detached window: the last published model, for the gap before the first push. */
  requestGraph: () => Promise<unknown>;
  /** Detached window: every subsequent model. */
  onGraphState: (cb: (payload: unknown) => void) => void;

  isElectron: true;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
