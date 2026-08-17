/**
 * projectFile.ts — .bbim file format: serialize / deserialize the entire
 * BubbleGraph project state so that "Open project" restores everything exactly
 * as the user left it: model, view tabs, settings, symbol configs.
 *
 * File format: JSON with the following top-level keys:
 *   - formatVersion  : number (1)
 *   - projectName    : string
 *   - savedAt        : ISO timestamp
 *   - model          : { nodes, edges, buildingAxes, activeStoreyId }
 *   - viewState      : { viewTabs, activeTabId, viewer3DType }
 *   - symbolConfigs  : { window, door, svgSymbols }
 */

import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes, ViewTab, Viewer3DType, WorldLocation, GlobeInstance, RoomXShape } from '@/store';
import { exportRegistry as exportWindowRegistry, importRegistry as importWindowRegistry } from './windowSymbolLibrary';
import { exportDoorRegistry, importDoorRegistry } from './doorSymbolLibrary';
import { exportSymbolLibrary, importSymbolLibrary, type SvgSymbolDef } from './svgSymbolStore';
import { exportCustomCalc, importCustomCalc, type CustomCalcPersist } from '@/store/customCalcStore';
import { exportPrices, importPrices, type PricePersist } from '@/store/priceStore';
import { exportMappingOverrides, importMappingOverrides, type MappingOverridePersist } from '@/store/mappingOverrideStore';

// ─── Format types ─────────────────────────────────────────────────────────────

export const FORMAT_VERSION = 1;

export interface BbimFile {
  formatVersion: number;
  projectName: string;
  savedAt: string;
  model: {
    nodes: BubbleGraphNode[];
    edges: BubbleGraphEdge[];
    buildingAxes: BuildingAxes;
    activeStoreyId: string | null;
    worldLocation?: WorldLocation;
    globeInstances?: GlobeInstance[];
    composerShapes?: RoomXShape[];
  };
  viewState: {
    viewTabs: ViewTab[];
    activeTabId: string;
    viewer3DType: Viewer3DType;
  };
  symbolConfigs: {
    window: Record<string, unknown>;
    door: Record<string, unknown>;
    svgSymbols?: Record<string, SvgSymbolDef>;
  };
  /** Grafuri de calcul custom (editor Faza 3B). */
  customCalc?: CustomCalcPersist;
  /** Prețuri unitare per articol de normă. */
  prices?: PricePersist;
  /** Suprascrieri de mapare BIM→articol la nivel de proiect. */
  mappingOverrides?: MappingOverridePersist;
}

// ─── Serialize (current state → JSON object) ──────────────────────────────────

/**
 * Strip runtime-only data from viewTabs before persisting them anywhere —
 * used by both the .bbim file save below AND the backend/cloud auto-save
 * (BubbleGraphPanel's useAutoSave), so tabs survive a reload identically on
 * every save path. Currently: drops blob: URLs, which are not valid across
 * sessions.
 */
export function sanitizeViewTabs(viewTabs: ViewTab[]): ViewTab[] {
  return viewTabs.map((t) => {
    const params = { ...t.params };
    if (params.ifcUrl && typeof params.ifcUrl === 'string' && params.ifcUrl.startsWith('blob:')) {
      delete params.ifcUrl;
    }
    return { ...t, params };
  });
}

export function serializeProject(
  projectName: string,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  buildingAxes: BuildingAxes,
  activeStoreyId: string | null,
  viewTabs: ViewTab[],
  activeTabId: string,
  viewer3DType: Viewer3DType,
  worldLocation?: WorldLocation,
  globeInstances?: GlobeInstance[],
  composerShapes?: RoomXShape[],
): BbimFile {
  const cleanTabs = sanitizeViewTabs(viewTabs);

  return {
    formatVersion: FORMAT_VERSION,
    projectName,
    savedAt: new Date().toISOString(),
    model: {
      nodes,
      edges,
      buildingAxes,
      activeStoreyId,
      worldLocation,
      globeInstances,
      composerShapes,
    },
    viewState: {
      viewTabs: cleanTabs,
      activeTabId,
      viewer3DType,
    },
    symbolConfigs: {
      window: exportWindowRegistry(),
      door: exportDoorRegistry(),
      svgSymbols: exportSymbolLibrary(),
    },
    customCalc: exportCustomCalc(),
    prices: exportPrices(),
    mappingOverrides: exportMappingOverrides(),
  };
}

// ─── Deserialize (JSON object → restore into app state) ───────────────────────

export interface DeserializedProject {
  projectName: string;
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes: BuildingAxes;
  activeStoreyId: string | null;
  viewTabs: ViewTab[];
  activeTabId: string;
  viewer3DType: Viewer3DType;
  worldLocation?: WorldLocation;
  globeInstances?: GlobeInstance[];
  composerShapes?: RoomXShape[];
}

export function deserializeProject(raw: unknown): DeserializedProject {
  const data = raw as BbimFile;

  if (!data || typeof data !== 'object') throw new Error('Invalid project file');
  if (!data.model) throw new Error('Project file missing model data');

  // Restore symbol registries (side effects)
  if (data.symbolConfigs?.window) {
    importWindowRegistry(data.symbolConfigs.window as Record<string, Record<string, unknown>>);
  }
  if (data.symbolConfigs?.door) {
    importDoorRegistry(data.symbolConfigs.door as Record<string, Record<string, unknown>>);
  }
  if (data.symbolConfigs?.svgSymbols) {
    importSymbolLibrary(data.symbolConfigs.svgSymbols);
  }
  // Restore custom calc graphs (side effect into store)
  importCustomCalc(data.customCalc);
  // Restore unit prices (side effect into store)
  importPrices(data.prices);
  // Restore per-project mapping overrides (side effect into store)
  importMappingOverrides(data.mappingOverrides);

  return {
    projectName: data.projectName ?? 'My Building',
    nodes: data.model.nodes ?? [],
    edges: data.model.edges ?? [],
    buildingAxes: data.model.buildingAxes ?? { xValues: [], yValues: [] },
    activeStoreyId: data.model.activeStoreyId ?? null,
    viewTabs: data.viewState?.viewTabs ?? [
      { id: 'graph-editor', label: data.projectName ?? 'My Building', type: 'graph-editor', canClose: false },
    ],
    activeTabId: data.viewState?.activeTabId ?? 'graph-editor',
    viewer3DType: data.viewState?.viewer3DType ?? 'ara3d',
    worldLocation: data.model.worldLocation,
    globeInstances: data.model.globeInstances ?? [],
    composerShapes: data.model.composerShapes ?? [],
  };
}

// ─── Web File API helpers ─────────────────────────────────────────────────────

/** Download a .bbim file to the user's machine. */
export function downloadProject(data: BbimFile): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${data.projectName || 'project'}.bbim`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Show a file picker and read a .bbim file. Returns parsed content. */
export function openProjectFile(): Promise<BbimFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bbim,.bgjson,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        resolve(data as BbimFile);
      } catch {
        resolve(null);
      }
    };
    input.click();
  });
}
