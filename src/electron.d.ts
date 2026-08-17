// Type definitions for the Electron preload API exposed via contextBridge
// Available as window.electronAPI when running inside Electron

export interface ProjectData {
  nodes: unknown[];
  edges: unknown[];
  buildingAxes?: { xValues: number[]; yValues: number[] };
  projectName?: string;
  activeStoreyId?: string | null;
}

export interface OpenResult {
  filePath: string;
  data: ProjectData;
  error?: string;
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
  onProjectOpened:    (cb: (_event: unknown, payload: { filePath: string; data: ProjectData }) => void) => void;
  onRequestSaveAs:    (cb: () => void) => void;
  removeAllListeners: (channel: string) => void;

  isElectron: true;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
