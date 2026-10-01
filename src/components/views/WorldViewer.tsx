/**
 * WorldViewer — CesiumJS-based 3D Earth viewer for building geo-location.
 *
 * Engine: CesiumJS (cesium npm package)
 * Base imagery: OpenStreetMap tiles (no API key / no Cesium Ion required)
 * Terrain: ArcGIS World Elevation (free, no API key)
 *
 * Geocoding:  Nominatim (OSM) — free, no key
 * Elevation:  Open-Topo-Data SRTM 90m — free, no key
 * Future layers: GeoJSON. CityJSON is exported via the Python converter.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { cn } from "@/lib/utils";
import { useBubbleGraphStore } from "@/store";
import type { WorldLocation, GlobeInstance } from "@/store";
import { DEFAULT_WORLD_LOCATION } from "@/store";
import { buildSceneGeometry } from "./WebIfcViewer";
import { VisibilityFilter } from "./VisibilityFilter";
import { useMaterialConfig } from "@/lib/useMaterialConfig";
import { deserializeProject, openProjectFile } from "@/lib/projectFile";
import * as turf from "@turf/turf";
import {
  DEFAULT_PROJECT_CRS, axisLabels, crsForLocation, crsValidAt, exportGeoreference, georefFromWorldLocation,
  isKnownCrs, placeOverlay, worldLocationFromGeoref,
} from "@/lib/geo";
import { writeGeoreference } from "@/lib/geo/ifcGeoref";
import { packageTileset } from "@/lib/ifc/tiles3d/package";
import { buildIfcModel } from "@/lib/ifc/buildIfcModel";
import { BUBBLE_GRAPH_READER } from "@/lib/ifc/tiles3d/fromFragments";
import { downloadBytes, safeFilename } from "@/lib/download";
import { FRAG_MIME, fragFileName } from "@/lib/fragmentsExport";
import { detectIfcSchema } from "@/lib/ifc/stepText";
import { parseIfcPlan } from "@/lib/ifcStepParser";
import { readIndexedColours } from '@/lib/ifc/indexedColours';
import {
  convertIfcToFragments, fragmentsToThreeGroup, getHeadlessFragments, loadFragments, modelToProjectMatrix,
  parseItemNodeName, pickedNodeName, readItemGuid, readItemProperties, type IfcElementProperties,
} from "@/lib/ifc/ifcFragments";
import { getHostBridge } from "@/lib/ifc/hostBridge";
import type { FragmentsModel } from "@thatopen/fragments";
import { IfcPropertiesPanel } from "@/components/ifc/IfcPropertiesPanel";
import { FeaturePropertiesPanel } from "@/components/views/FeaturePropertiesPanel";
import { cityJsonFeature, isCityPick, tilesFeature, type PickedFeature } from "@/lib/featurePick";
import { ExtrudePanel } from "@/components/ifc/ExtrudePanel";
import { FragmentsOverlay, OVERLAY_MODEL_KEY, overlayNodeFor, placeInOverlay } from "@/lib/ifc/overlay/fragmentsOverlay";
import {
  GLTF_MODEL_AXES, insertionPoint, overlayAnchorOf, overlayOffsetOf, placementMatrix,
} from "@/lib/geo/worldPlacement";
import type { CesiumCameraState } from "@/lib/ifc/overlay/cameraSync";
import { buildTilesetFromGroup, type BuiltTileset } from "@/lib/ifc/tiles3d/fromFragments";
import {
  convertPointCloud, deletePointCloud, formatBytes as formatCloudBytes,
  POINT_CLOUD_ACCEPT, tilesetUrlOf, type PointCloudJob,
} from "@/lib/pointCloudApi";
import {
  deleteTileset, probeTilesetUrl, tilesetUrlOf as archiveUrlOf, uploadTilesetArchive,
  formatBytes as formatSetBytes, type TilesetInfo,
} from "@/lib/tilesetApi";
import { convertIfcToCesiumTiles, convertIfcToCityJson } from "@/lib/ifcConvertApi";
import { highlightGuidStyle } from "@/lib/ifc/tiles3d/style";
import { useExtrusions } from "@/lib/ifc/extrude/useExtrusions";
import { effectiveHeight, worldProfile } from "@/lib/ifc/extrude/extrudedSolid";
import {
  BASEMAPS, WorldGeoPanel, emptyOverlay,
  type BasemapId, type OverlayState,
} from "./world/WorldGeoPanel";

// Disable Ion — we use OSM tiles directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Cesium.Ion as any).defaultAccessToken = "";

// ─── Types ────────────────────────────────────────────────────────────────────

// WorldLocation is defined in @/store and re-exported here for consumers.
export type { WorldLocation } from "@/store";

const DEFAULT_LOCATION = DEFAULT_WORLD_LOCATION;

/**
 * A location moved to (lat, lng) by the user. Placing IS georeferencing, so
 * the flag goes on; and the grid follows the model — see `crsForLocation`.
 */
function placedAt<L extends WorldLocation>(prev: L, lat: number, lng: number, more: Partial<WorldLocation> = {}): L {
  return { ...prev, lat, lng, crs: crsForLocation(lat, lng, prev.crs), georeferenced: true, ...more };
}

export interface WorldViewerProps {
  className?: string;
  projectName?: string;
  tabId?: string;
}

type ViewMode = "top" | "perspective" | "eye";

const VIEW_CONFIGS: Record<ViewMode, { height: number; pitch: number }> = {
  top:         { height: 600,  pitch: -89 },
  perspective: { height: 350,  pitch: -45 },
  eye:         { height: 3,    pitch: -5  },
};

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtCoord(v: number, dec = 6) { return v.toFixed(dec); }

function NumField({
  label, value, unit, step, onChange, loading,
}: {
  label: string; value: number; unit: string; step: number;
  onChange: (v: number) => void;
  loading?: boolean;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-12 shrink-0 text-right">{label}</span>
      <div className="flex-1 relative">
        <input
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-full bg-background border border-border rounded px-2 py-0.5 text-xs text-foreground"
        />
        {loading && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-primary animate-pulse">
            …
          </span>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground w-6 shrink-0">{unit}</span>
    </label>
  );
}

// `insertionPoint` and `placementMatrix` — the model's INSERTION POINT, the
// one point everything (georeference, drag, pin, all three renderers) is
// measured from — live in `@/lib/geo/worldPlacement`, where a test proves the
// three rendering modes land on the same spot.

/**
 * Where a screen position lands on the horizontal plane through `L`'s
 * insertion point, as east/north metres from that point. Picking on THIS
 * plane rather than on the ellipsoid keeps a drag honest on a tilted camera:
 * the model's base stays under the cursor instead of sliding with parallax.
 */
function groundOffsetAt(
  viewer: Cesium.Viewer, screen: Cesium.Cartesian2, L: WorldLocation,
): { e: number; n: number } | null {
  const origin = insertionPoint(L);
  const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(origin, new Cesium.Cartesian3());
  const plane = Cesium.Plane.fromPointNormal(origin, up);
  const ray = viewer.camera.getPickRay(screen);
  if (!ray) return null;
  const hit = Cesium.IntersectionTests.rayPlane(ray, plane);
  if (!hit) return null;
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const inv = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
  const local = Cesium.Matrix4.multiplyByPoint(inv, hit, new Cesium.Cartesian3());
  return { e: local.x, n: local.y };
}

const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * How the imported IFC is drawn on the globe. The three are genuinely
 * different architectures, not three settings, which is why they are worth
 * having side by side:
 *
 *   gltf      — the model baked once into glTF and handed to Cesium as a
 *               Model primitive. One conversion, no streaming, no level of
 *               detail, no per-element highlight. What we had first.
 *   fragments — a Three.js layer over Cesium, with fragments streaming its
 *               own tiles against the shared camera. Streaming, LOD and
 *               per-element highlight; no depth against terrain.
 *   tiles     — a 3D Tiles tileset Cesium streams natively. Correct depth,
 *               native styling and picking; a conversion step, and geometry
 *               that can no longer be edited.
 */
export type IfcRenderMode = 'gltf' | 'fragments' | 'tiles';

export const RENDER_MODES: Array<{ id: IfcRenderMode; label: string; hint: string }> = [
  { id: 'gltf', label: 'glTF', hint: 'Model copt o dată. Fără streaming, fără LOD.' },
  { id: 'fragments', label: 'Fragments', hint: 'Strat Three peste Cesium. Streaming, LOD, evidențiere. Fără ocluzie cu terenul.' },
  { id: 'tiles', label: '3D Tiles', hint: 'Streaming nativ Cesium. Adâncime corectă. Geometrie coaptă.' },
];

/** Cesium's camera in the plain numbers `cameraSync` works with. */
function readCesiumCamera(viewer: Cesium.Viewer): CesiumCameraState | null {
  const cam = viewer.camera;
  const frustum = cam.frustum as Cesium.PerspectiveFrustum;
  // An orthographic frustum (2D and Columbus view) has no vertical field of
  // view, and a perspective Three camera cannot represent it. The overlay
  // sits out those scene modes rather than drawing something wrong.
  if (typeof frustum.fovy !== 'number' || !isFinite(frustum.fovy)) return null;
  const canvas = viewer.scene.canvas;
  return {
    positionWC: { x: cam.positionWC.x, y: cam.positionWC.y, z: cam.positionWC.z },
    directionWC: { x: cam.directionWC.x, y: cam.directionWC.y, z: cam.directionWC.z },
    upWC: { x: cam.upWC.x, y: cam.upWC.y, z: cam.upWC.z },
    fovy: frustum.fovy,
    aspect: (canvas.clientWidth || 1) / (canvas.clientHeight || 1),
    near: frustum.near,
    far: frustum.far,
  };
}

/** Centre of an imported model's bounding box, on the globe. */
function boundsCentre(b: { cE: number; cN: number; cU: number }, L: WorldLocation): Cesium.Cartesian3 {
  return Cesium.Matrix4.multiplyByPoint(
    placementMatrix(L), new Cesium.Cartesian3(b.cE, b.cN, b.cU), new Cesium.Cartesian3(),
  );
}

/**
 * Globe → drawing plane. Metres east and north of `L`'s insertion point,
 * which is the origin the drawn solids and the IFC export both measure from.
 */
function enuOffsetOf(lat: number, lng: number, L: WorldLocation): { x: number; y: number } {
  const origin = insertionPoint(L);
  const inv = Cesium.Matrix4.inverse(
    Cesium.Transforms.eastNorthUpToFixedFrame(origin), new Cesium.Matrix4(),
  );
  const local = Cesium.Matrix4.multiplyByPoint(
    inv, Cesium.Cartesian3.fromDegrees(lng, lat, L.alt), new Cesium.Cartesian3(),
  );
  return { x: local.x, y: local.y };
}

/** Drawing plane → globe, at a height above the anchor's own elevation. */
function cartesianOfEnu(p: { x: number; y: number }, z: number, L: WorldLocation): Cesium.Cartesian3 {
  return Cesium.Matrix4.multiplyByPoint(
    Cesium.Transforms.eastNorthUpToFixedFrame(insertionPoint(L)),
    new Cesium.Cartesian3(p.x, p.y, z),
    new Cesium.Cartesian3(),
  );
}

/** The heavy, non-serialisable half of an imported IFC. */
/**
 * The extent of an imported model, in the ENU frame of its insertion point:
 * metres east, north and up, plus where the centre of that box sits relative
 * to the origin. Drawn as a wireframe box so the model reads as ONE thing you
 * can pick up and move, and so you can see at a glance whether every element
 * is inside it.
 */
interface IfcBounds { sizeE: number; sizeN: number; sizeU: number; cE: number; cN: number; cU: number }

interface IfcOnGlobe {
  model: FragmentsModel; cesium: Cesium.Model; pin: Cesium.Entity; file: File;
  bounds: IfcBounds; box: Cesium.Entity;
  /** The Three.js flattening, kept so a tileset can be built on demand
   *  without re-reading the whole fragments model. */
  group: THREE.Object3D;
  /** Stored geometry → the file's project coordinates. Baked into `group`;
   *  the live fragments object needs it applied at draw time. */
  toProject: THREE.Matrix4;
  /** Built lazily, the first time the 3D Tiles mode asks for it. */
  tiles?: { built: BuiltTileset; primitive: Cesium.Cesium3DTileset };
}

/** The editable half: where the model stands and how it got there. */
interface IfcPlacement {
  id: string; name: string; visible: boolean;
  /** The file itself said where it is (IfcMapConversion / IfcSite). */
  georeferenced: boolean;
  /**
   * Follow the project's location: the IFC origin sits on the project origin
   * and moves with it, so moving the IFC moves the project. This is the
   * default for a file that does not know where it is — it IS the building,
   * and the map is how you decide where the building goes.
   */
  linked: boolean;
  /** Own placement, used when not linked. */
  location: WorldLocation;
}

/**
 * Placement editor for one imported IFC.
 *
 * Everything here describes ONE point — the model's insertion point — and the
 * heading of its axes there. Three ways to set it, from coarse to exact: drag
 * the crosshair on the map, click a spot, or type grid coordinates.
 */
function IfcPlacementEditor({
  model, projectLoc, placing, onTogglePlacing, onToggleLinked, onLocChange, onFocus, onExport,
  onExportFrag, onExportTiles, onExportCityjson, onExportHtml, busy,
}: {
  model: IfcPlacement;
  projectLoc: WorldLocation;
  placing: boolean;
  onTogglePlacing: () => void;
  onToggleLinked: () => void;
  onLocChange: (patch: Partial<WorldLocation>) => void;
  onFocus: () => void;
  onExport: () => void;
  onExportFrag: () => void;
  onExportTiles: () => void;
  onExportCityjson: () => void;
  onExportHtml: () => void;
  /** Which export is running, if any — the work takes seconds. */
  busy: IfcExportKind | null;
}) {
  const L = model.linked ? projectLoc : model.location;
  const crs = L.crs ?? DEFAULT_PROJECT_CRS;
  const known = isKnownCrs(crs);
  // The grid coordinates of the insertion point, straight from the same
  // function the IFC export uses — so what is read here is what gets written.
  const grid = known ? georefFromWorldLocation(L, crs) : null;
  const labels = known ? axisLabels(crs) : null;
  const [typed, setTyped] = useState<{ e: string; n: string } | null>(null);
  const shown = typed ?? (grid ? { e: grid.eastings.toFixed(3), n: grid.northings.toFixed(3) } : { e: '', n: '' });

  const applyTyped = () => {
    if (!typed || !grid) return;
    const e = parseFloat(typed.e);
    const n = parseFloat(typed.n);
    setTyped(null);
    if (!isFinite(e) || !isFinite(n)) return;
    // Straight back through the same georeference: grid point → lat/lng, with
    // the ENU offsets zeroed because the typed point IS the insertion point.
    const wl = worldLocationFromGeoref({ ...grid, eastings: e, northings: n });
    onLocChange({ lat: wl.lat, lng: wl.lng, offsetE: 0, offsetN: 0, georeferenced: true });
  };

  return (
    <div className="ml-1 pl-2 border-l-2 border-primary/30 flex flex-col gap-2 pb-1">
      <button
        onClick={onTogglePlacing}
        className={cn("text-[11px] py-1 rounded border transition-colors",
          placing
            ? "bg-primary text-primary-foreground border-primary"
            : "bg-background border-border text-foreground hover:bg-accent")}
        title="Apoi dă click pe hartă: acolo ajunge punctul de inserție"
      >
        {placing ? '⏹ Anulează plasarea' : '✛ Mută punctul de inserție'}
      </button>
      <div className="text-[10px] text-muted-foreground leading-snug">
        Trage crucea albastră de pe hartă ca să muți modelul. Ea marchează originea modelului.
      </div>

      <label className="flex items-center gap-1.5 text-[11px] text-foreground cursor-pointer">
        <input type="checkbox" checked={model.linked} onChange={onToggleLinked} className="accent-primary" />
        <span title="Modelul stă pe originea proiectului; mutându-l, georeferențiezi proiectul">
          Legat de poziția proiectului
        </span>
      </label>

      {known && (
        <div className="flex flex-col gap-1">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Punct de inserție — {crs}
          </div>
          {(['e', 'n'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground w-12 shrink-0 text-right">
                {k === 'e' ? labels?.x : labels?.y}
              </span>
              <input
                value={shown[k]}
                onChange={(ev) => setTyped({ ...shown, [k]: ev.target.value })}
                onBlur={applyTyped}
                onKeyDown={(ev) => { if (ev.key === 'Enter') applyTyped(); if (ev.key === 'Escape') setTyped(null); }}
                className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-0.5 text-[11px] font-mono text-foreground"
              />
              <span className="text-[10px] text-muted-foreground w-4 shrink-0">{labels?.unit}</span>
            </label>
          ))}
        </div>
      )}

      <NumField label="Cotă" value={L.alt} unit="m" step={0.5} onChange={(v) => onLocChange({ alt: v })} />
      <NumField label="Rotire" value={L.rotation} unit="°" step={1}
        onChange={(v) => onLocChange({ rotation: norm360(v) })} />

      <div className="flex gap-1">
        <button onClick={onFocus}
          className="flex-1 text-[11px] py-1 rounded border border-border bg-background text-foreground hover:bg-accent">
          ⌖ Focus
        </button>
        <button onClick={onExport} disabled={busy !== null}
          title="Descarcă fișierul IFC cu poziția scrisă în el (IfcMapConversion + IfcSite)"
          className="flex-1 text-[11px] py-1 rounded border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40">
          {busy === 'ifc' ? '⏳' : '⬇'} IFC
        </button>
      </div>

      {/* The same placement, in the two formats a viewer reads directly. */}
      <div className="flex gap-1">
        <button onClick={onExportFrag} disabled={busy !== null}
          title="Descarcă .frag (That Open). Georeferința se coace la conversie: fișierul IFC e georeferențiat întâi, iar convertorul citește IfcProjectedCRS."
          className="flex-1 text-[11px] py-1 rounded border border-border bg-background text-foreground hover:bg-accent disabled:opacity-40">
          {busy === 'frag' ? '⏳' : '⬇'} .frag
        </button>
        <button onClick={onExportTiles} disabled={busy !== null}
          title="Descarcă un arhiv Cesium 3D Tiles 1.1 (.zip: tileset.json + GLB), convertit în Python. root.transform poartă poziția de pe glob."
          className="flex-1 text-[11px] py-1 rounded border border-border bg-background text-foreground hover:bg-accent disabled:opacity-40">
          {busy === 'tiles' ? '⏳' : '⬇'} 3D Tiles
        </button>
      </div>
      <div className="flex gap-1">
        <button onClick={onExportCityjson} disabled={busy !== null}
          title="Descarcă CityJSON 2.0 real (Python / ifcopenshell): CityObjects, vertices întregi și transform. Nu e 3D Tiles."
          className="flex-1 text-[11px] py-1 rounded border border-border bg-background text-foreground hover:bg-accent disabled:opacity-40">
          {busy === 'cityjson' ? '⏳' : '⬇'} CityJSON
        </button>
        <button onClick={onExportHtml} disabled={busy !== null}
          title="Un singur fișier .html cu viewer 3D: se deschide oriunde, fără instalare, cu proprietățile fiecărui element la clic."
          className="flex-1 text-[11px] py-1 rounded border border-border bg-background text-foreground hover:bg-accent disabled:opacity-40">
          {busy === 'html' ? '⏳' : '⬇'} HTML
        </button>
      </div>
    </div>
  );
}

/** The exports one imported IFC offers; one runs at a time. */
type IfcExportKind = 'ifc' | 'frag' | 'tiles' | 'cityjson' | 'html';

/** Canvas-drawn building pin for the Cesium billboard. */
function createBuildingPinCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 44; canvas.height = 56;
  const ctx = canvas.getContext("2d")!;
  ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
  ctx.beginPath(); ctx.arc(22, 20, 18, 0, Math.PI * 2);
  ctx.fillStyle = "#3b82f6"; ctx.fill();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.shadowColor = "transparent";
  ctx.beginPath(); ctx.moveTo(14, 33); ctx.lineTo(22, 56); ctx.lineTo(30, 33); ctx.closePath();
  ctx.fillStyle = "#3b82f6"; ctx.fill();
  ctx.font = "18px serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("\u{1F3E2}", 22, 20);
  return canvas;
}

/** Survey-style marker for an imported model's insertion point: crosshair
 *  over the exact point, so it reads as a coordinate, not as a label. */
function createInsertionPinCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 34; canvas.height = 34;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(17, 17);
  ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-14, 0); ctx.lineTo(14, 0); ctx.moveTo(0, -14); ctx.lineTo(0, 14);
  ctx.stroke();
  ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-14, 0); ctx.lineTo(-5, 0); ctx.moveTo(5, 0); ctx.lineTo(14, 0);
  ctx.moveTo(0, -14); ctx.lineTo(0, -5); ctx.moveTo(0, 5); ctx.lineTo(0, 14);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#38bdf8"; ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fill();
  return canvas;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WorldViewer({ className, projectName, tabId }: WorldViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef    = useRef<Cesium.Viewer | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const entityRef    = useRef<Cesium.Entity | null>(null);
  const placingRef   = useRef(false);

  const storedLoc     = useBubbleGraphStore((s) => s.worldLocation);
  const setWorldLocation = useBubbleGraphStore((s) => s.setWorldLocation);
  const updateViewTabParams = useBubbleGraphStore((s) => s.updateViewTabParams);
  // Restore per-tab state from viewTab params
  const tabParams = useBubbleGraphStore((s) => s.viewTabs.find((t) => t.id === tabId)?.params);
  const initialShowBim  = (tabParams?.showBim as boolean | undefined) ?? false;
  const initialViewMode = (tabParams?.viewMode as ViewMode | undefined) ?? "perspective";

  // The store owns the location; this view reads it live. It used to copy
  // the store into local state at mount, which went wrong whenever the
  // project arrived AFTER the tab: a reload or a `.bbim` restores the tabs
  // first and sets the saved placement second, so the view kept the default
  // site — and the first drag or turn wrote that default back over the saved
  // heading and coordinates.
  const loc = storedLoc ?? DEFAULT_LOCATION;
  const setLoc = useCallback((patch: WorldLocation | ((prev: WorldLocation) => WorldLocation)) => {
    const prev = useBubbleGraphStore.getState().worldLocation ?? DEFAULT_LOCATION;
    setWorldLocation(typeof patch === 'function' ? patch(prev) : patch);
  }, [setWorldLocation]);
  // The Cesium event handlers are installed once and never re-bound, so they
  // read the current location through a ref rather than through a closure.
  const locRef = useRef(loc);
  useEffect(() => { locRef.current = loc; }, [loc]);

  // Basemap and georeferenced overlay. Session state: the image is an object
  // URL over a local file, and persisting megabytes of raster into the project
  // JSON would make every save slower for something the user can re-attach.
  const [basemap, setBasemap] = useState<BasemapId>("osm");
  const [overlay, setOverlayState] = useState<OverlayState>(
    () => emptyOverlay(storedLoc?.crs ?? "EPSG:3844"),
  );
  const setOverlay = useCallback(
    (patch: Partial<OverlayState>) => setOverlayState((p) => ({ ...p, ...patch })),
    [],
  );
  const overlayEntityRef = useRef<Cesium.Entity | null>(null);

  // Imported IFC models. The heavy, non-serialisable objects (the fragments
  // model kept for properties, the Cesium.Model, the pin at the insertion
  // point, the original file for re-export) live in a ref; the placement
  // lives in React state so the panel can edit it. Session state: a
  // FragmentsModel is worker-backed and has no serialisable form, so like the
  // overlay this does not survive a reload — the file has to be imported again.
  const ifcModelsRef = useRef<Map<string, IfcOnGlobe>>(new Map());
  const [ifcList, setIfcList] = useState<IfcPlacement[]>([]);
  const ifcListRef = useRef<IfcPlacement[]>([]);
  useEffect(() => { ifcListRef.current = ifcList; }, [ifcList]);
  const [selectedIfcId, setSelectedIfcId] = useState<string | null>(null);
  // Which architecture draws the imported IFC. See RENDER_MODES.
  const [renderMode, setRenderMode] = useState<IfcRenderMode>('gltf');
  const renderModeRef = useRef<IfcRenderMode>('gltf');
  const overlayRef = useRef<FragmentsOverlay | null>(null);
  const [overlayReady, setOverlayReady] = useState(false);
  const [overlayNote, setOverlayNote] = useState<string | null>(null);
  const [ifcPlacing, setIfcPlacing] = useState<string | null>(null);   // id awaiting a click on the globe
  const ifcPlacingRef = useRef<string | null>(null);
  useEffect(() => { ifcPlacingRef.current = ifcPlacing; }, [ifcPlacing]);
  const [ifcLoading, setIfcLoading] = useState<string | null>(null);
  const [ifcPick, setIfcPick] = useState<{ loading: boolean; element: IfcElementProperties | null } | null>(null);
  const ifcFileRef = useRef<HTMLInputElement>(null);

  // ── Drawn extrusions ───────────────────────────────────────────────────────
  // The contour plane is the project anchor's elevation — the terrain height
  // under the marker — so a solid's own `z` stays a height above the site,
  // which is what the georeferenced export writes.
  const [extrudeOpen, setExtrudeOpen] = useState(false);
  const [extrudeProblem, setExtrudeProblem] = useState<string | null>(null);
  const extrusions = useExtrusions({ elevation: () => 0, onProblem: setExtrudeProblem });
  const extrudeEntitiesRef = useRef<Cesium.Entity[]>([]);
  const extrudeDrawingRef = useRef(false);
  useEffect(() => { extrudeDrawingRef.current = extrusions.drawing; }, [extrusions.drawing]);
  const extrudeAddRef = useRef(extrusions.addPoint);
  const extrudeFinishRef = useRef(extrusions.finishDraw);
  useEffect(() => {
    extrudeAddRef.current = extrusions.addPoint;
    extrudeFinishRef.current = extrusions.finishDraw;
  }, [extrusions.addPoint, extrusions.finishDraw]);

  const [placing, setPlacing]       = useState(false);
  const [viewMode, setViewModeState] = useState<ViewMode>(initialViewMode);
  const setViewMode = useCallback((m: ViewMode) => {
    setViewModeState(m);
    if (tabId) updateViewTabParams(tabId, { viewMode: m });
  }, [tabId, updateViewTabParams]);
  const [coordInput, setCoordInput] = useState({
    lat: (storedLoc?.lat ?? DEFAULT_LOCATION.lat).toFixed(6),
    lng: (storedLoc?.lng ?? DEFAULT_LOCATION.lng).toFixed(6),
  });

  // Search state
  const [searchQuery,   setSearchQuery]   = useState("");
  const [searchResults, setSearchResults] = useState<NominatimResult[]>([]);
  const [searchOpen,    setSearchOpen]    = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  // Elevation auto-detect state
  const [altLoading, setAltLoading] = useState(false);
  const [altSource,  setAltSource]  = useState<"manual" | "srtm">("manual");

  // BIM model overlay
  const cesiumModelRef = useRef<Cesium.Model | null>(null);
  const showBimRef     = useRef(false);
  const buildGenRef    = useRef(0); // incremented on every build; stale calls self-discard
  const [showBim,    setShowBimState]    = useState(initialShowBim);
  const setShowBim = useCallback((v: boolean | ((p: boolean) => boolean)) => {
    setShowBimState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      if (tabId) updateViewTabParams(tabId, { showBim: next });
      return next;
    });
  }, [tabId, updateViewTabParams]);
  const [bimLoading, setBimLoading] = useState(false);
  const nodes = useBubbleGraphStore((s) => s.bubbleGraphNodes);
  // The ground is edited in the Terrain tab; the globe must follow it.
  const terrainModel = useBubbleGraphStore((s) => s.terrain);
  const edges = useBubbleGraphStore((s) => s.bubbleGraphEdges);
  const { config: matConfig } = useMaterialConfig();

  // Globe instances (imported .bbim models)
  const globeInstances = useBubbleGraphStore((s) => s.globeInstances);
  const addGlobeInstance = useBubbleGraphStore((s) => s.addGlobeInstance);
  const updateGlobeInstance = useBubbleGraphStore((s) => s.updateGlobeInstance);
  const removeGlobeInstance = useBubbleGraphStore((s) => s.removeGlobeInstance);
  const instanceModelsRef = useRef<Map<string, Cesium.Model>>(new Map());
  const instanceEntitiesRef = useRef<Map<string, Cesium.Entity>>(new Map());
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const selectedInstance = useMemo(
    () => globeInstances.find((g) => g.id === selectedInstanceId) ?? null,
    [globeInstances, selectedInstanceId],
  );

  // Visibility filter
  const [hiddenTypes,     setHiddenTypes]     = useState<Set<string>>(new Set());
  const [hiddenStoreyIds, setHiddenStoreyIds] = useState<Set<string>>(new Set());
  const [visFilterOpen,   setVisFilterOpen]   = useState(false);

  // Polygon measurement (Turf.js)
  const drawingPolyRef      = useRef(false);
  const [drawingPoly, setDrawingPolyState] = useState(false);
  const setDrawingPoly = useCallback((v: boolean) => {
    setDrawingPolyState(v);
    drawingPolyRef.current = v;
  }, []);
  const polyPointsRef = useRef<Array<[number, number]>>([]); // [lng, lat] pairs
  const [polyPoints,  setPolyPoints]  = useState<Array<[number, number]>>([]);
  const [polyResult,  setPolyResult]  = useState<{ areaSqM: number; perimeterM: number } | null>(null);
  const drawPolyEntityRef     = useRef<Cesium.Entity | null>(null);
  const drawPolyDotEntities   = useRef<Cesium.Entity[]>([]);

  const { visibleTypes, typeCounts } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of nodes) { counts[n.type] = (counts[n.type] ?? 0) + 1; }
    return { visibleTypes: Object.keys(counts), typeCounts: counts };
  }, [nodes]);

  // ── Polygon measurement callbacks (Turf.js) ────────────────────────────────
  const clearPolyDraw = useCallback(() => {
    const viewer = viewerRef.current;
    if (viewer && !viewer.isDestroyed()) {
      if (drawPolyEntityRef.current) {
        viewer.entities.remove(drawPolyEntityRef.current);
        drawPolyEntityRef.current = null;
      }
      drawPolyDotEntities.current.forEach((e) => viewer.entities.remove(e));
      drawPolyDotEntities.current = [];
    }
    polyPointsRef.current = [];
    setPolyPoints([]);
    setPolyResult(null);
    setDrawingPoly(false);
  }, [setDrawingPoly]);

  const startPolyDraw = useCallback(() => {
    clearPolyDraw();
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const entity = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const pts = polyPointsRef.current;
          if (pts.length < 2) return [];
          return pts.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat));
        }, false),
        width: 2.5,
        material: new Cesium.ColorMaterialProperty(Cesium.Color.YELLOW),
        clampToGround: true,
      },
      polygon: {
        hierarchy: new Cesium.CallbackProperty(() => {
          const pts = polyPointsRef.current;
          if (pts.length < 3) return new Cesium.PolygonHierarchy([]);
          return new Cesium.PolygonHierarchy(
            pts.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat)),
          );
        }, false),
        material: Cesium.Color.YELLOW.withAlpha(0.15),
        outline: false,
      },
    });
    drawPolyEntityRef.current = entity;
    setDrawingPoly(true);
  }, [clearPolyDraw, setDrawingPoly]);

  const finishPolyDraw = useCallback(() => {
    setDrawingPoly(false);
    const pts = polyPointsRef.current;
    if (pts.length < 3) return;
    const ring = [...pts, pts[0]];
    const poly = turf.polygon([ring]);
    const areaSqM = turf.area(poly);
    const line = turf.lineString(ring);
    const perimeterM = turf.length(line, { units: "kilometers" }) * 1000;
    setPolyResult({ areaSqM, perimeterM });
  }, [setDrawingPoly]);

  const addPolyPoint = useCallback((lat: number, lng: number) => {
    polyPointsRef.current = [...polyPointsRef.current, [lng, lat]];
    setPolyPoints([...polyPointsRef.current]);
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const dot = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lng, lat),
      point: {
        pixelSize: 9,
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1.5,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    drawPolyDotEntities.current.push(dot);
  }, []);

  // Listen for poly click / finish custom events dispatched from Cesium handler
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onPolyClick = (e: Event) => {
      const { lat, lng } = (e as CustomEvent<{ lat: number; lng: number }>).detail;
      addPolyPoint(lat, lng);
    };
    const onPolyFinish = () => finishPolyDraw();
    container.addEventListener("_wv_poly_click", onPolyClick);
    container.addEventListener("_wv_poly_finish", onPolyFinish);
    return () => {
      container.removeEventListener("_wv_poly_click", onPolyClick);
      container.removeEventListener("_wv_poly_finish", onPolyFinish);
    };
  }, [addPolyPoint, finishPolyDraw]);

  // Contour clicks on the globe → drawing metres from the project origin.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onClick = (e: Event) => {
      const { lat, lng } = (e as CustomEvent<{ lat: number; lng: number }>).detail;
      extrudeAddRef.current(enuOffsetOf(lat, lng, locRef.current));
    };
    const onFinish = () => { extrudeFinishRef.current(); };
    container.addEventListener('_wv_extrude_click', onClick);
    container.addEventListener('_wv_extrude_finish', onFinish);
    return () => {
      container.removeEventListener('_wv_extrude_click', onClick);
      container.removeEventListener('_wv_extrude_finish', onFinish);
    };
  }, []);

  // Enter closes the contour, Esc abandons it — the same keys as the TOC viewer.
  useEffect(() => {
    if (!extrusions.drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); extrusions.finishDraw(); }
      if (e.key === 'Escape') { e.preventDefault(); extrusions.cancelDraw(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [extrusions.drawing, extrusions.finishDraw, extrusions.cancelDraw]);

  // ── Draw the extrusions on the globe ───────────────────────────────────────
  // Cesium draws an extruded polygon natively, which is exactly this model's
  // shape — so unlike the imported IFC models these need no glTF detour, and
  // a parameter edit is a cheap entity rebuild.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    for (const ent of extrudeEntitiesRef.current) viewer.entities.remove(ent);
    extrudeEntitiesRef.current = [];

    const base = loc.alt;
    for (const s of extrusions.solids) {
      const ring = worldProfile(s).map((p) => cartesianOfEnu(p, s.placement.z, loc));
      const selected = s.id === extrusions.selectedId;
      const colour = Cesium.Color.fromCssColorString(s.color);
      extrudeEntitiesRef.current.push(viewer.entities.add({
        id: `extrusion-${s.id}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(ring),
          height: base + s.placement.z,
          extrudedHeight: base + s.placement.z + effectiveHeight(s),
          material: colour.withAlpha(selected ? 0.75 : 0.5),
          outline: true,
          outlineColor: selected ? Cesium.Color.GOLD : Cesium.Color.BLACK,
          outlineWidth: selected ? 3 : 1,
        },
      }));
    }

    // The contour being clicked out: its corners and the ring so far.
    if (extrusions.drawing && extrusions.contour.length > 0) {
      const pts = extrusions.contour.map((p) => cartesianOfEnu(p, 0, loc));
      for (const pos of pts) {
        extrudeEntitiesRef.current.push(viewer.entities.add({
          position: pos,
          point: {
            pixelSize: 9,
            color: Cesium.Color.fromCssColorString('#38bdf8'),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }));
      }
      if (pts.length > 1) {
        extrudeEntitiesRef.current.push(viewer.entities.add({
          polyline: {
            positions: pts.length > 2 ? [...pts, pts[0]] : pts,
            width: 2,
            material: Cesium.Color.fromCssColorString('#38bdf8'),
            clampToGround: true,
          },
        }));
      }
    }
  }, [extrusions.solids, extrusions.selectedId, extrusions.drawing, extrusions.contour, loc]);

  useEffect(() => { placingRef.current = placing; }, [placing]);
  useEffect(() => { showBimRef.current = showBim; }, [showBim]);

  // Re-build BIM model on globe whenever visibility filter changes (and model is shown)
  const hiddenTypesRef     = useRef(hiddenTypes);
  const hiddenStoreyIdsRef = useRef(hiddenStoreyIds);
  useEffect(() => { hiddenTypesRef.current = hiddenTypes; }, [hiddenTypes]);
  useEffect(() => { hiddenStoreyIdsRef.current = hiddenStoreyIds; }, [hiddenStoreyIds]);
  useEffect(() => {
    if (!showBimRef.current) return;
    void buildAndPlaceBimModel(
      loc.lat, loc.lng, loc.alt,
      loc.rotation, loc.offsetE, loc.offsetN, loc.offsetZ,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenTypes, hiddenStoreyIds]);

  // Rebuild BIM model when the placement changes (while model is shown).
  // Debounced 400 ms so rapid number-field edits — and the stream of updates
  // a drag produces — don't queue up many builds.
  //
  // The anchor lat/lng belongs in here, not only the offsets: the position
  // can now change by dragging a linked IFC or by typing grid coordinates,
  // and without this the project's own model stays where it was.
  useEffect(() => {
    if (!showBimRef.current) return;
    const t = setTimeout(() => {
      void buildAndPlaceBimModel(
        loc.lat, loc.lng, loc.alt,
        loc.rotation, loc.offsetE, loc.offsetN, loc.offsetZ,
      );
    }, 400);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.lat, loc.lng, loc.alt, loc.rotation, loc.offsetE, loc.offsetN, loc.offsetZ]);

  // Keep the building anchor billboard on the anchor point. `placeMarker`
  // moves it when you click the globe; this catches every other way the
  // position can change — typed coordinates, a dragged model, the panel.
  useEffect(() => {
    const ent = entityRef.current;
    if (!ent) return;
    (ent.position as Cesium.ConstantPositionProperty).setValue(
      Cesium.Cartesian3.fromDegrees(loc.lng, loc.lat, (loc.alt || 0) + 1),
    );
  }, [loc.lat, loc.lng, loc.alt]);

  // Rebuild BIM model live when the graph (nodes/edges) changes
  // Debounced 800 ms so bulk edits don't fire many builds.
  useEffect(() => {
    if (!showBimRef.current) return;
    const t = setTimeout(() => {
      void buildAndPlaceBimModel(
        loc.lat, loc.lng, loc.alt,
        loc.rotation, loc.offsetE, loc.offsetN, loc.offsetZ,
      );
    }, 800);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, matConfig]);

  // Keep coordInput in sync when loc changes programmatically (e.g. place marker)
  useEffect(() => {
    setCoordInput({ lat: loc.lat.toFixed(6), lng: loc.lng.toFixed(6) });
  }, [loc.lat, loc.lng]);

  // ── Init CesiumJS viewer ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;
    const container = containerRef.current;

    const rafId = requestAnimationFrame(() => {
      if (!container || viewerRef.current) return;

      const viewer = new Cesium.Viewer(container, {
        baseLayerPicker:      false,
        geocoder:             false,
        homeButton:           false,
        sceneModePicker:      false,
        navigationHelpButton: false,
        animation:            false,
        timeline:             false,
        fullscreenButton:     false,
        infoBox:              false,
        selectionIndicator:   false,
        skyBox:               false,
        skyAtmosphere:        new Cesium.SkyAtmosphere(),
      });

      // ArcGIS World Elevation terrain — free, no Ion token required
      Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
        "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer",
      ).then((tp) => {
        viewer.terrainProvider = tp;
        viewer.scene.globe.depthTestAgainstTerrain = true;
      }).catch(() => {
        // Fallback: keep default flat ellipsoid if fetch fails (offline, firewall)
        console.warn("[WorldViewer] ArcGIS terrain unavailable, using flat ellipsoid");
      });

      // Base imagery: key-free providers, no Ion key required. The basemap
      // effect below owns layer 0 from here on; this only seeds the first
      // frame so the globe is never blank.
      viewer.imageryLayers.removeAll();
      const seed = BASEMAPS.find((b) => b.id === basemap) ?? BASEMAPS[0];
      viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url:          seed.url,
          credit:       new Cesium.Credit(seed.credit, false),
          maximumLevel: seed.maxLevel,
        }),
      );

      viewer.scene.globe.depthTestAgainstTerrain = false; // will be set true after terrain loads
      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#0f172a");
      viewer.scene.fog.enabled = true;
      viewer.scene.fog.density = 0.0003;
      (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = "none";

      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(storedLoc?.lng ?? DEFAULT_LOCATION.lng, storedLoc?.lat ?? DEFAULT_LOCATION.lat, 350),
        orientation: { heading: Cesium.Math.toRadians(storedLoc?.rotation ?? 0), pitch: Cesium.Math.toRadians(-45), roll: 0 },
      });

      // Restore building marker from saved location (if not default)
      const sl = storedLoc ?? DEFAULT_LOCATION;
      if (sl.lat !== DEFAULT_LOCATION.lat || sl.lng !== DEFAULT_LOCATION.lng) {
        const markerPos = Cesium.Cartesian3.fromDegrees(sl.lng, sl.lat, (sl.alt || 0) + 1);
        entityRef.current = viewer.entities.add({
          id:       "building-anchor",
          position: markerPos,
          billboard: {
            image:                    createBuildingPinCanvas(),
            verticalOrigin:           Cesium.VerticalOrigin.BOTTOM,
            scale:                    1.0,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text:                     projectName || "Building",
            font:                     "12px Inter, sans-serif",
            pixelOffset:              new Cesium.Cartesian2(0, -64),
            fillColor:                Cesium.Color.WHITE,
            outlineColor:             Cesium.Color.BLACK,
            outlineWidth:             2,
            style:                    Cesium.LabelStyle.FILL_AND_OUTLINE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            showBackground:           true,
            backgroundColor:          new Cesium.Color(0, 0, 0, 0.55),
            backgroundPadding:        new Cesium.Cartesian2(6, 4),
          },
        });
      }

      // Left-click handler — dispatch custom event so React state stays in sync
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        const cartesian =
          viewer.scene.pickPosition(event.position) ??
          viewer.camera.pickEllipsoid(event.position, viewer.scene.globe.ellipsoid);
        if (!cartesian) return;
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        const lng = Cesium.Math.toDegrees(carto.longitude);
        if (extrudeDrawingRef.current) {
          container.dispatchEvent(
            new CustomEvent<{ lat: number; lng: number }>("_wv_extrude_click", { detail: { lat, lng } }),
          );
          return;
        }
        if (drawingPolyRef.current) {
          container.dispatchEvent(
            new CustomEvent<{ lat: number; lng: number }>("_wv_poly_click", { detail: { lat, lng } }),
          );
          return;
        }
        if (!placingRef.current) return;
        container.dispatchEvent(
          new CustomEvent<{ lat: number; lng: number }>("_wv_click", { detail: { lat, lng } }),
        );
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      // Double-click to close a polygon or a contour
      handler.setInputAction(() => {
        if (extrudeDrawingRef.current) {
          container.dispatchEvent(new CustomEvent("_wv_extrude_finish"));
          return;
        }
        if (!drawingPolyRef.current) return;
        container.dispatchEvent(new CustomEvent("_wv_poly_finish"));
      }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

      (viewer as unknown as { _bbHandler?: Cesium.ScreenSpaceEventHandler })._bbHandler = handler;
      viewerRef.current = viewer;
      // The viewer is built inside a rAF callback, so every effect that wants
      // to attach to it has to wait for this flag rather than read the ref on
      // mount — at mount time it is still null.
      setViewerReady(true);
    });

    return () => {
      cancelAnimationFrame(rafId);
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        (viewerRef.current as unknown as { _bbHandler?: Cesium.ScreenSpaceEventHandler })
          ._bbHandler?.destroy();
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-build BIM model on mount if showBim was restored from tab params
  const didInitBim = useRef(false);
  useEffect(() => {
    if (didInitBim.current || !viewerRef.current || !showBimRef.current || nodes.length === 0) return;
    didInitBim.current = true;
    void buildAndPlaceBimModel(
      loc.lat, loc.lng, loc.alt,
      loc.rotation, loc.offsetE, loc.offsetN, loc.offsetZ,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  // ── Basemap ───────────────────────────────────────────────────────────────
  // Layer 0 only. The overlay is an Entity, not an imagery layer, so it is not
  // disturbed by a basemap swap — that separation is why the overlay keeps its
  // rotation, which imagery layers cannot express at all.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const b = BASEMAPS.find((x) => x.id === basemap) ?? BASEMAPS[0];
    const next = new Cesium.UrlTemplateImageryProvider({
      url:          b.url,
      credit:       new Cesium.Credit(b.credit, false),
      maximumLevel: b.maxLevel,
    });
    // Add first, then drop the old one: removing first leaves a frame of bare
    // ellipsoid, which reads as a flicker on every switch.
    const layer = viewer.imageryLayers.addImageryProvider(next);
    viewer.imageryLayers.lowerToBottom(layer);
    while (viewer.imageryLayers.length > 1) {
      const top = viewer.imageryLayers.get(viewer.imageryLayers.length - 1);
      if (top === layer) break;
      viewer.imageryLayers.remove(top, true);
    }
  }, [basemap]);

  // ── Georeferenced image overlay ───────────────────────────────────────────
  // A rotated rectangle, not an imagery layer: the image's edges follow the
  // survey grid's axes, and grid north is tilted from true north by the
  // meridian convergence. `placeOverlay` measures that tilt; ignoring it puts
  // a 200 m site plan metres out of place. See lib/geo/overlay.ts.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    if (overlayEntityRef.current) {
      viewer.entities.remove(overlayEntityRef.current);
      overlayEntityRef.current = null;
    }
    if (!overlay.imageUrl || !overlay.visible) return;

    const placed = placeOverlay(overlay.corners);
    if (!placed.ok) return;  // the panel shows why
    const { bounds, rotation } = placed.placement;

    overlayEntityRef.current = viewer.entities.add({
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(
          bounds.west, bounds.south, bounds.east, bounds.north,
        ),
        material: new Cesium.ImageMaterialProperty({
          image: overlay.imageUrl,
          transparent: true,
          color: Cesium.Color.WHITE.withAlpha(overlay.opacity),
        }),
        rotation,
        // The texture has to turn with the rectangle, or the image stays
        // north-up inside a rotated frame and gets cropped at the corners.
        stRotation: rotation,
        classificationType: Cesium.ClassificationType.TERRAIN,
      },
    });

    return () => {
      if (viewer.isDestroyed() || !overlayEntityRef.current) return;
      viewer.entities.remove(overlayEntityRef.current);
      overlayEntityRef.current = null;
    };
  }, [overlay.imageUrl, overlay.visible, overlay.opacity, overlay.corners]);

  // ── Elevation from SRTM via Open-Topo-Data (free, no key) ─────────────────
  const fetchElevation = useCallback(async (lat: number, lng: number): Promise<number | null> => {
    try {
      const res = await fetch(
        `https://api.opentopodata.org/v1/srtm90m?locations=${lat.toFixed(6)},${lng.toFixed(6)}`,
      );
      if (!res.ok) return null;
      const json = await res.json();
      const elev = json?.results?.[0]?.elevation;
      return typeof elev === "number" ? Math.round(elev) : null;
    } catch {
      return null;
    }
  }, []);

  // ── Geocoding via Nominatim (OSM, free, no key) ───────────────────────────
  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setSearchLoading(true);
    setSearchOpen(false);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&addressdetails=0`,
        { headers: { "Accept-Language": "en,ro" } },
      );
      if (!res.ok) return;
      const data: NominatimResult[] = await res.json();
      setSearchResults(data);
      setSearchOpen(data.length > 0);
    } catch {
      // network error — ignore silently
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery]);

  // ── React-side click handler — place + auto-fetch elevation ───────────────
  const placeMarkerRef = useRef<((lat: number, lng: number, altM?: number) => void) | null>(null);
  // The click that placing mode waits for is handled by `dropAt`, further
  // down, once every kind of model it can move has been declared.

  // ── Place / update building marker ────────────────────────────────────────
  const placeMarker = useCallback((lat: number, lng: number, altM?: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    // Clamp to ~1m above terrain surface for the billboard position
    const billboardAlt = altM !== undefined ? altM + 1 : 10;
    const position = Cesium.Cartesian3.fromDegrees(lng, lat, billboardAlt);

    if (entityRef.current) {
      (entityRef.current.position as Cesium.ConstantPositionProperty)?.setValue(position);
      if (entityRef.current.label)
        entityRef.current.label.text = new Cesium.ConstantProperty(projectName || "Building");
    } else {
      entityRef.current = viewer.entities.add({
        id:       "building-anchor",
        position,
        billboard: {
          image:                    createBuildingPinCanvas(),
          verticalOrigin:           Cesium.VerticalOrigin.BOTTOM,
          scale:                    1.0,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text:                     projectName || "Building",
          font:                     "12px Inter, sans-serif",
          pixelOffset:              new Cesium.Cartesian2(0, -64),
          fillColor:                Cesium.Color.WHITE,
          outlineColor:             Cesium.Color.BLACK,
          outlineWidth:             2,
          style:                    Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground:           true,
          backgroundColor:          new Cesium.Color(0, 0, 0, 0.55),
          backgroundPadding:        new Cesium.Cartesian2(6, 4),
        },
      });
    }

    // Placing IS georeferencing: from here on the export writes the position.
    setLoc((prev) => placedAt(prev, lat, lng, altM !== undefined ? { alt: altM } : {}));
    setCoordInput({ lat: lat.toFixed(6), lng: lng.toFixed(6) });

    // Auto-refresh BIM model on globe if overlay is active
    if (showBimRef.current) {
      void buildAndPlaceBimModel(
        lat, lng,
        altM ?? loc.alt,
        loc.rotation, loc.offsetE, loc.offsetN, loc.offsetZ,
      );
    }

    const { height, pitch } = VIEW_CONFIGS[viewMode] ?? VIEW_CONFIGS.perspective;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lng, lat, Math.max(height, 80)),
      orientation: {
        heading: Cesium.Math.toRadians(loc.rotation),
        pitch:   Cesium.Math.toRadians(pitch),
        roll:    0,
      },
      duration: 0.8,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName, viewMode, loc.rotation]);

  useEffect(() => { placeMarkerRef.current = placeMarker; }, [placeMarker]);

  useEffect(() => {
    const canvas = viewerRef.current?.scene.canvas;
    if (canvas) canvas.style.cursor = placing || ifcPlacing ? "crosshair" : "";
  }, [placing, ifcPlacing]);

  const focusCamera = useCallback((mode: ViewMode) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const { height, pitch } = VIEW_CONFIGS[mode];
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(loc.lng, loc.lat, height),
      orientation: {
        heading: Cesium.Math.toRadians(loc.rotation),
        pitch:   Cesium.Math.toRadians(pitch),
        roll:    0,
      },
      duration: 0.8,
    });
  }, [loc.lat, loc.lng, loc.rotation]);

  const applyCoordInput = () => {
    const lat = parseFloat(coordInput.lat);
    const lng = parseFloat(coordInput.lng);
    if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)
      placeMarker(lat, lng);
  };

  const updateLoc = (patch: Partial<WorldLocation>) =>
    setLoc((prev) => ({ ...prev, ...patch }));

  /**
   * The project's own geometry as a Three scene, filtered exactly as it is
   * drawn.
   *
   * Extracted because two consumers need the SAME scene: the GLB that goes on
   * the globe, and the 3D Tiles archive. Kept inline, the visibility filter
   * would have had to be written twice, and the day someone hid a type in one
   * place and not the other, the download would quietly disagree with the view.
   */
  const buildProjectScene = useCallback((): THREE.Scene => {
    const scene = new THREE.Scene();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildSceneGeometry(scene, nodes, edges, new Map() as any, matConfig);

    const hidden     = hiddenTypesRef.current;
    const hiddenStor = hiddenStoreyIdsRef.current;
    scene.traverse((obj) => {
      const ud = obj.userData as { nodeType?: string; storeyId?: string; isLine?: boolean };
      // Grid and axis helpers, and the storey floor/ceiling planes, are drawing
      // aids — they are not the building and must not be exported as it.
      if ((obj as THREE.Object3D & { isLine?: boolean }).isLine) { obj.visible = false; return; }
      if (ud.nodeType === 'storey') { obj.visible = false; return; }
      if (ud.nodeType && hidden.has(ud.nodeType)) { obj.visible = false; return; }
      if (ud.storeyId && hiddenStor.has(ud.storeyId)) { obj.visible = false; return; }
    });

    // Detach rather than merely hide: an invisible mesh still exports, and a
    // GLB carrying geometry nothing draws is dead weight in every tile.
    const toRemove: THREE.Object3D[] = [];
    scene.traverse((obj) => { if (!obj.visible) toRemove.push(obj); });
    toRemove.forEach((obj) => obj.removeFromParent());

    return scene;
  }, [nodes, edges, matConfig, terrainModel]);

  // ── Build BIM model and place it on the Cesium globe ─────────────────────
  // Strategy: Three.js scene → GLTFExporter (binary GLB) → Cesium.Model
  // Coordinates: Three.js BIM scene is already in metres (mm * 0.001 via bim())
  // glTF Y-up maps naturally to Cesium ENU (East=X, Up=Y, North=-Z)
  const buildAndPlaceBimModel = useCallback(async (
    lat: number, lng: number, alt: number,
    heading: number,
    offsetE: number, offsetN: number, offsetZ: number,
  ) => {
    const viewer = viewerRef.current;
    if (!viewer || nodes.length === 0) return;

    // Claim this build generation; any older in-flight call will see a mismatch and abort.
    const gen = ++buildGenRef.current;

    // Remove the current model immediately so we never have two simultaneously.
    if (cesiumModelRef.current) {
      viewer.scene.primitives.remove(cesiumModelRef.current);
      cesiumModelRef.current = null;
    }

    setBimLoading(true);
    let blobUrl: string | null = null;
    try {
      const scene = buildProjectScene();

      // Export to binary glTF (GLB)
      const glbBuffer = await new Promise<ArrayBuffer>((resolve, reject) =>
        new GLTFExporter().parse(
          scene,
          (result) => resolve(result as ArrayBuffer),
          (err) => reject(err),
          { binary: true },
        ),
      );

      // Abort if a newer build was started while we were exporting
      if (gen !== buildGenRef.current) return;

      blobUrl = URL.createObjectURL(new Blob([glbBuffer], { type: "model/gltf-binary" }));

      // Compute ECEF position: start at lat/lng/alt, then apply ENU offsets
      const basePos  = Cesium.Cartesian3.fromDegrees(lng, lat, alt);
      const enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(basePos);
      const posWithOffset = Cesium.Matrix4.multiplyByPoint(
        enuFrame,
        new Cesium.Cartesian3(offsetE, offsetN, offsetZ),
        new Cesium.Cartesian3(),
      );

      // headingPitchRollToFixedFrame: heading = CW from North (matches loc.rotation)
      const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
        posWithOffset,
        new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(heading), 0, 0),
      );

      const model = await Cesium.Model.fromGltfAsync({ url: blobUrl, modelMatrix, scale: 1.0 });

      // Abort if superseded while waiting for GPU upload
      if (gen !== buildGenRef.current) {
        viewer.scene.primitives.remove(model);
        return;
      }

      // Remove any model that may have been placed by a concurrent call
      if (cesiumModelRef.current) {
        viewer.scene.primitives.remove(cesiumModelRef.current);
      }
      viewer.scene.primitives.add(model);
      cesiumModelRef.current = model;
    } catch (err) {
      console.error("[WorldViewer] BIM model build failed:", err);
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      // Only clear the spinner if this is still the latest build
      if (gen === buildGenRef.current) setBimLoading(false);
    }
  }, [nodes, edges, matConfig, hiddenTypes, hiddenStoreyIds]);

  // ── Build and place a single imported instance on the globe ────────────────
  const buildInstanceModel = useCallback(async (inst: GlobeInstance) => {
    const viewer = viewerRef.current;
    if (!viewer || inst.nodes.length === 0 || !inst.visible) return;

    // Remove existing model for this instance
    const old = instanceModelsRef.current.get(inst.id);
    if (old) { viewer.scene.primitives.remove(old); instanceModelsRef.current.delete(inst.id); }

    try {
      const scene = new THREE.Scene();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildSceneGeometry(scene, inst.nodes, inst.edges, new Map() as any, matConfig);
      // Remove lines
      scene.traverse((obj) => {
        if ((obj as THREE.Object3D & { isLine?: boolean }).isLine) obj.visible = false;
        const ud = obj.userData as { nodeType?: string };
        if (ud.nodeType === 'storey') obj.visible = false;
      });
      const toRemove: THREE.Object3D[] = [];
      scene.traverse((obj) => { if (!obj.visible) toRemove.push(obj); });
      toRemove.forEach((obj) => obj.removeFromParent());

      const glb = await new Promise<ArrayBuffer>((res, rej) =>
        new GLTFExporter().parse(scene, (r) => res(r as ArrayBuffer), rej, { binary: true }),
      );
      const url = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));

      const L = inst.location;
      const basePos = Cesium.Cartesian3.fromDegrees(L.lng, L.lat, L.alt);
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(basePos);
      const pos = Cesium.Matrix4.multiplyByPoint(
        enu, new Cesium.Cartesian3(L.offsetE, L.offsetN, L.offsetZ), new Cesium.Cartesian3(),
      );
      const mat = Cesium.Transforms.headingPitchRollToFixedFrame(
        pos, new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(L.rotation), 0, 0),
      );
      const model = await Cesium.Model.fromGltfAsync({ url, modelMatrix: mat, scale: 1.0 });
      (model as unknown as { _bbInstId: string })._bbInstId = inst.id;
      viewer.scene.primitives.add(model);
      instanceModelsRef.current.set(inst.id, model);
      URL.revokeObjectURL(url);

      // Add / update pin entity
      const pinPos = Cesium.Cartesian3.fromDegrees(L.lng, L.lat, (L.alt || 0) + 1);
      const existing = instanceEntitiesRef.current.get(inst.id);
      if (existing) {
        (existing.position as Cesium.ConstantPositionProperty).setValue(pinPos);
        if (existing.label) existing.label.text = new Cesium.ConstantProperty(inst.name);
      } else {
        const ent = viewer.entities.add({
          id: `inst-pin-${inst.id}`,
          position: pinPos,
          billboard: {
            image: createBuildingPinCanvas(),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            scale: 0.75,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: inst.name,
            font: "11px Inter, sans-serif",
            pixelOffset: new Cesium.Cartesian2(0, -54),
            fillColor: Cesium.Color.fromCssColorString("#facc15"),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            showBackground: true,
            backgroundColor: new Cesium.Color(0, 0, 0, 0.55),
            backgroundPadding: new Cesium.Cartesian2(5, 3),
          },
        });
        instanceEntitiesRef.current.set(inst.id, ent);
      }
    } catch (err) {
      console.error(`[WorldViewer] Instance ${inst.name} build failed:`, err);
    }
  }, [matConfig]);

  // Rebuild all visible instances when globeInstances change
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    // Remove models for deleted instances
    const ids = new Set(globeInstances.map((g) => g.id));
    for (const [id, m] of instanceModelsRef.current) {
      if (!ids.has(id)) {
        viewer.scene.primitives.remove(m);
        instanceModelsRef.current.delete(id);
        const ent = instanceEntitiesRef.current.get(id);
        if (ent) { viewer.entities.remove(ent); instanceEntitiesRef.current.delete(id); }
      }
    }
    // Build/rebuild visible instances
    for (const inst of globeInstances) {
      if (inst.visible) void buildInstanceModel(inst);
      else {
        const m = instanceModelsRef.current.get(inst.id);
        if (m) { viewer.scene.primitives.remove(m); instanceModelsRef.current.delete(inst.id); }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globeInstances]);

  // ── Import .bbim file as globe instance ────────────────────────────────────
  const handleImportBbim = useCallback(async () => {
    const raw = await openProjectFile();
    if (!raw) return;
    try {
      const proj = deserializeProject(raw);
      const id = `gi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const inst: GlobeInstance = {
        id,
        name: proj.projectName || 'Imported',
        location: proj.worldLocation ?? { ...DEFAULT_WORLD_LOCATION },
        nodes: proj.nodes,
        edges: proj.edges,
        visible: true,
      };
      addGlobeInstance(inst);
      setSelectedInstanceId(id);
    } catch (err) {
      console.error('[WorldViewer] Import .bbim failed:', err);
    }
  }, [addGlobeInstance]);

  // ── Import an IFC as fragments and stand it on the globe ───────────────────
  // IFC → fragments (headless) → one mesh per element → GLB → Cesium.Model.
  // If the file carries a georeference (IfcMapConversion or IfcSite), the
  // model lands where the file says; otherwise at the project's location.
  const handleImportIfc = useCallback(async (file: File) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const id = `ifc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const name = file.name.replace(/\.ifc$/i, '');
    setIfcLoading(name);
    let url: string | null = null;
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);

      // Georeference first — cheap text pass — so the placement is known
      // before the expensive conversion and can be shown while it runs.
      //
      // A file that says where it is keeps its own placement. A file that
      // does not is LINKED to the project: its origin is the project origin,
      // so dragging it on the map is how the project gets georeferenced.
      let location: WorldLocation = { ...locRef.current, offsetE: 0, offsetN: 0, offsetZ: 0 };
      let georeferenced = false;
      try {
        const gr = (await parseIfcPlan(buf)).georeference;
        if (gr && gr.crs) {
          const wl = worldLocationFromGeoref(gr);
          // The position and heading are read geodetically, so they are right
          // whatever grid the file used. The grid itself is only kept if it
          // belongs where the model stands: a Stereo 70 file in Spain is
          // self-consistent and useless to anyone else, and re-exporting it
          // would pass the mistake on.
          const crs = crsValidAt(gr.crs, wl.lat, wl.lng) ? gr.crs : crsForLocation(wl.lat, wl.lng, null);
          if (crs !== gr.crs) console.warn(`[WorldViewer] ${file.name}: ${gr.crs} does not cover ${wl.lat.toFixed(4)}, ${wl.lng.toFixed(4)} — placed in ${crs} instead.`);
          location = { ...wl, crs, georeferenced: true };
          georeferenced = true;
        }
      } catch (err) {
        console.warn('[WorldViewer] IFC georeference read failed, using project location:', err);
      }

      // Colours web-ifc does not read (IfcIndexedColourMap), off the text
      // before the conversion can take the buffer.
      const bodyColours = readIndexedColours(new TextDecoder().decode(bytes));
      const frag = await convertIfcToFragments(bytes);
      const model = await loadFragments(getHeadlessFragments(), frag, id);
      const toProject = await modelToProjectMatrix(model);
      const group = await fragmentsToThreeGroup(model, { bodyColours });
      if (group.children.length === 0) throw new Error('Fișierul nu conține elemente cu geometrie.');

      // The model's extent, measured before it becomes glTF. Three is Y-up
      // with north on −z, so the ENU sizes come out permuted.
      const b3 = new THREE.Box3().setFromObject(group);
      const size = b3.getSize(new THREE.Vector3());
      const centre = b3.getCenter(new THREE.Vector3());
      const bounds: IfcBounds = {
        sizeE: Math.max(size.x, 0.1), sizeN: Math.max(size.z, 0.1), sizeU: Math.max(size.y, 0.1),
        cE: centre.x, cN: -centre.z, cU: centre.y,
      };

      const scene = new THREE.Scene();
      scene.add(group);
      const glb = await new Promise<ArrayBuffer>((res, rej) =>
        new GLTFExporter().parse(scene, (r) => res(r as ArrayBuffer), rej, { binary: true }),
      );
      url = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));

      const linked = !georeferenced;
      const L = linked ? locRef.current : location;
      const cesium = await Cesium.Model.fromGltfAsync({
        url, modelMatrix: placementMatrix(L), scale: 1.0, ...GLTF_MODEL_AXES,
      });
      (cesium as unknown as { _bbIfcId: string })._bbIfcId = id;
      viewer.scene.primitives.add(cesium);

      // A pin at the insertion point. It is what you grab to move the model,
      // and it makes visible the one thing that matters: which point of the
      // model the coordinates belong to.
      const pin = viewer.entities.add({
        id: `ifc-pin-${id}`,
        position: insertionPoint(L),
        billboard: {
          image: createInsertionPinCanvas(),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          scale: 0.7,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: name,
          font: '11px Inter, sans-serif',
          pixelOffset: new Cesium.Cartesian2(0, -40),
          fillColor: Cesium.Color.fromCssColorString('#38bdf8'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: new Cesium.Color(0, 0, 0, 0.55),
          backgroundPadding: new Cesium.Cartesian2(5, 3),
        },
      });
      (pin as unknown as { _bbIfcPinId: string })._bbIfcPinId = id;

      const box = viewer.entities.add({
        id: `ifc-box-${id}`,
        position: boundsCentre(bounds, L),
        orientation: Cesium.Transforms.headingPitchRollQuaternion(
          boundsCentre(bounds, L), new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(L.rotation), 0, 0),
        ),
        box: {
          dimensions: new Cesium.Cartesian3(bounds.sizeE, bounds.sizeN, bounds.sizeU),
          fill: false,
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.8),
          outlineWidth: 2,
        },
      });

      ifcModelsRef.current.set(id, { model, cesium, pin, file, bounds, box, group, toProject });
      setIfcList((l) => [...l, { id, name, visible: true, georeferenced, linked, location }]);
      setSelectedIfcId(id);
      // Frame the whole model rather than a fixed height above the anchor: a
      // hall and a handrail need very different distances.
      viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(
          boundsCentre(bounds, L),
          Math.hypot(bounds.sizeE, bounds.sizeN, bounds.sizeU) / 2,
        ),
        { duration: 1 },
      );
    } catch (err) {
      console.error('[WorldViewer] IFC import failed:', err);
      alert(`Importul IFC a eșuat: ${(err as Error).message}`);
    } finally {
      if (url) URL.revokeObjectURL(url);
      setIfcLoading(null);
    }
  }, []);

  const removeIfc = useCallback((id: string) => {
    const viewer = viewerRef.current;
    const entry = ifcModelsRef.current.get(id);
    if (entry) {
      if (viewer && !viewer.isDestroyed()) {
        viewer.scene.primitives.remove(entry.cesium);
        viewer.entities.remove(entry.pin);
        viewer.entities.remove(entry.box);
        if (entry.tiles) viewer.scene.primitives.remove(entry.tiles.primitive);
      }
      // The tileset lives entirely in blob URLs; without this the tab keeps a
      // second copy of the model for as long as it is open.
      entry.tiles?.built.urls.forEach((u) => URL.revokeObjectURL(u));
      const overlayScene = overlayRef.current?.scene;
      if (overlayScene) {
        for (const child of [...overlayScene.children]) {
          if (child.userData[OVERLAY_MODEL_KEY] === id) overlayScene.remove(child);
        }
      }
      void getHeadlessFragments().disposeModel(id).catch(() => {});
      ifcModelsRef.current.delete(id);
    }
    setIfcList((l) => l.filter((m) => m.id !== id));
    setSelectedIfcId((s) => (s === id ? null : s));
    setIfcPick(null);
  }, []);

  const toggleIfc = useCallback((id: string) => {
    setIfcList((l) => l.map((m) => m.id === id ? { ...m, visible: !m.visible } : m));
  }, []);

  /**
   * Write the placement the user dragged into a copy of the original IFC and
   * hand it back. Without this step the map work stays in the session: the
   * point of moving a model over a basemap is that the FILE ends up knowing
   * where it stands.
   */
  const exportIfcGeoref = useCallback(async (id: string) => {
    const entry = ifcModelsRef.current.get(id);
    const m = ifcListRef.current.find((x) => x.id === id);
    if (!entry || !m) return;
    const L = m.linked ? locRef.current : m.location;
    const crs = L.crs ?? DEFAULT_PROJECT_CRS;
    if (!isKnownCrs(crs)) { alert(`Sistemul de coordonate ${crs} nu este cunoscut.`); return; }
    try {
      const text = await entry.file.text();
      const out = writeGeoreference(text, georefFromWorldLocation(L, crs), {
        schema: detectIfcSchema(text),
      });
      const url = URL.createObjectURL(new Blob([out], { type: 'application/x-step' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${m.name}-georef.ifc`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      console.error('[WorldViewer] IFC georeference export failed:', err);
      alert(`Exportul a eșuat: ${(err as Error).message}`);
    }
  }, []);

  /**
   * The same placement, in the two formats a viewer opens directly.
   *
   * `.frag` — the fragments API has no `setCRS`, only `getCRS`, so a buffer
   * cannot be georeferenced after the fact. The way in is the front door: write
   * the reference into the IFC TEXT first, then convert, because the converter
   * reads `IfcProjectedCRS` and carries it into the model. Which means this
   * costs a re-conversion, and says so while it runs.
   *
   * 3D Tiles — the archive gets the placement in `root.transform`. The live
   * view deliberately leaves that unset and places the primitive instead, so a
   * drag never rebuilds the tiles; a downloaded tileset has no primitive, so
   * the matrix has to be in the file or it opens at the centre of the Earth.
   */
  const [exportBusy, setExportBusy] = useState<{ id: string; kind: IfcExportKind } | null>(null);
  const [projectExport, setProjectExport] = useState<'tiles' | 'frag' | null>(null);

  const placementOf = useCallback((id: string) => {
    const m = ifcListRef.current.find((x) => x.id === id);
    if (!m) return null;
    const L = m.linked ? locRef.current : m.location;
    const crs = L.crs ?? DEFAULT_PROJECT_CRS;
    return { m, L, crs };
  }, []);

  const exportIfcFrag = useCallback(async (id: string) => {
    const entry = ifcModelsRef.current.get(id);
    const p = placementOf(id);
    if (!entry || !p) return;
    if (!isKnownCrs(p.crs)) { alert(`Sistemul de coordonate ${p.crs} nu este cunoscut.`); return; }
    setExportBusy({ id, kind: 'frag' });
    try {
      const text = await entry.file.text();
      const georef = writeGeoreference(text, georefFromWorldLocation(p.L, p.crs), {
        schema: detectIfcSchema(text),
      });
      // IFC2X3 has no IfcMapConversion, so the CRS cannot ride along. Say so
      // rather than handing back a .frag that quietly knows only its own origin.
      if (detectIfcSchema(text) === 'IFC2X3') {
        console.warn('[WorldViewer] IFC2X3 source: the .frag carries IfcSite only, no CRS.');
      }
      const frag = await convertIfcToFragments(new TextEncoder().encode(georef));
      downloadBytes(fragFileName(p.m.name), frag, FRAG_MIME);
    } catch (err) {
      console.error('[WorldViewer] .frag export failed:', err);
      alert(`Exportul .frag a eșuat: ${(err as Error).message}`);
    } finally {
      setExportBusy(null);
    }
  }, [placementOf]);

  /**
   * The model as one self-contained `.html` — the same file the project's
   * own export writes, with the IFC as its one source. Geometry is the
   * flattening already drawn on the globe; the storeys and every element's
   * property sets are read from the fragments model kept for picking.
   */
  const exportIfcHtml = useCallback(async (id: string) => {
    const entry = ifcModelsRef.current.get(id);
    const p = placementOf(id);
    if (!entry || !p) return;
    setExportBusy({ id, kind: 'html' });
    try {
      const [{ ifcSource }, { exportStandaloneSources }] = await Promise.all([
        import('@/lib/standaloneSources'),
        import('@/lib/standaloneExport'),
      ]);
      const source = await ifcSource(entry.model, entry.group, { id, name: p.m.name });
      const r = await exportStandaloneSources({ projectName: p.m.name, sources: [source] });
      console.info(`[WorldViewer] ${r.fileName}: ${(r.bytes / 1048576).toFixed(1)} MB, ${r.meshes} corpuri, ${source.info.elements} elemente`);
    } catch (err) {
      console.error('[WorldViewer] HTML export failed:', err);
      alert(`Exportul HTML a eșuat: ${(err as Error).message}`);
    } finally {
      setExportBusy(null);
    }
  }, [placementOf]);

  const exportIfcTiles = useCallback(async (id: string) => {
    const entry = ifcModelsRef.current.get(id);
    const p = placementOf(id);
    if (!entry || !p) return;
    setExportBusy({ id, kind: 'tiles' });
    try {
      const out = await convertIfcToCesiumTiles(entry.file, {
        transform: Array.from(Cesium.Matrix4.toArray(placementMatrix(p.L))),
      });
      downloadBytes(safeFilename(`${p.m.name}-3dtiles`, 'zip', 'model'), out.bytes, 'application/zip');
      console.info(`[WorldViewer] exported ${out.tiles} Cesium 3D Tiles via Python`);
    } catch (err) {
      console.error('[WorldViewer] 3D Tiles export failed:', err);
      alert(`Exportul 3D Tiles a eșuat: ${(err as Error).message}`);
    } finally {
      setExportBusy(null);
    }
  }, [placementOf]);

  const exportIfcCityjson = useCallback(async (id: string) => {
    const entry = ifcModelsRef.current.get(id);
    const p = placementOf(id);
    if (!entry || !p) return;
    setExportBusy({ id, kind: 'cityjson' });
    try {
      if (!isKnownCrs(p.crs)) { alert(`Sistemul de coordonate ${p.crs} nu este cunoscut.`); return; }
      // Same front door as the .frag: the placement goes into the IFC text
      // first, and the converter turns IfcMapConversion into real grid
      // coordinates. Sending the original file only LABELLED local vertices
      // with a CRS — a model 0–112 m from the grid origin, in the Gulf of
      // Guinea.
      const text = await entry.file.text();
      const placed = writeGeoreference(text, georefFromWorldLocation(p.L, p.crs), { schema: detectIfcSchema(text) });
      const out = await convertIfcToCityJson(new File([placed], entry.file.name, { type: 'application/x-step' }), p.crs);
      downloadBytes(safeFilename(p.m.name, 'city.json', 'model'), out.bytes, 'application/json');
    } catch (err) {
      console.error('[WorldViewer] CityJSON export failed:', err);
      alert(`Exportul CityJSON a eșuat: ${(err as Error).message}`);
    } finally {
      setExportBusy(null);
    }
  }, [placementOf]);

  /**
   * The project's own model as a georeferenced 3D Tiles archive.
   *
   * Same scene the globe draws, read with `BUBBLE_GRAPH_READER` — so each tile
   * carries the bubble node id as its feature identity and every element keeps
   * its own colour, which is what makes a pick in Cesium name the same thing a
   * pick in the fragments viewer names.
   *
   * Unlike the imported-IFC path there is no live tileset to package: the
   * project is drawn as one baked GLB. It is built here, on demand, and thrown
   * away once zipped — nothing on screen changes.
   */
  /**
   * Whether the project's own model may go out as a georeferenced file.
   *
   * A "georeferenced" export of a project nobody placed states the default
   * viewpoint — central Bucharest — as a fact, which is the one thing
   * `exportGeoreference` exists to prevent; a Granada model got a Bucharest
   * `.frag` exactly this way. An empty scene is refused too: storeys and axes
   * are nodes, not geometry, and the result was a file of a site and nothing.
   */
  const projectExportBlocked = useCallback((scene?: THREE.Object3D): string | null => {
    if (!locRef.current.georeferenced) {
      return 'Proiectul nu este plasat pe hartă, deci nu are o poziție de scris în fișier. '
        + 'Plasează-l întâi (pin, „Plasează pe hartă” sau coordonate).\n\n'
        + 'Pentru un model IFC importat, folosește exporturile din lista „Modele IFC”.';
    }
    if (scene) {
      let meshes = 0;
      scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
      if (meshes === 0) return 'Proiectul nu are geometrie de exportat.';
    }
    return null;
  }, []);

  const exportProjectTiles = useCallback(async () => {
    if (nodes.length === 0) { alert('Proiectul nu are geometrie de exportat.'); return; }
    const scene = buildProjectScene();
    const blocked = projectExportBlocked(scene);
    if (blocked) { alert(blocked); return; }
    setProjectExport('tiles');
    let built: BuiltTileset | null = null;
    try {
      built = await buildTilesetFromGroup(scene, { reader: BUBBLE_GRAPH_READER });
      const { zip, tileCount } = await packageTileset(built.tileset, {
        transform: Array.from(Cesium.Matrix4.toArray(placementMatrix(locRef.current))),
      });
      downloadBytes(safeFilename(`${projectName || 'model'}-3dtiles`, 'zip', 'model'), zip, 'application/zip');
      console.info(`[WorldViewer] project exported as ${tileCount} tiles, ${built.featureCount} elements`);
    } catch (err) {
      console.error('[WorldViewer] project 3D Tiles export failed:', err);
      alert(`Exportul 3D Tiles a eșuat: ${(err as Error).message}`);
    } finally {
      // The blobs existed only to be zipped; nothing is rendering from them.
      built?.urls.forEach((u) => URL.revokeObjectURL(u));
      setProjectExport(null);
    }
  }, [nodes.length, projectName, buildProjectScene, projectExportBlocked]);

  /**
   * The project's own model as a georeferenced `.frag`.
   *
   * Same constraint as the imported path: the fragments API exposes `getCRS`
   * and no `setCRS`, so the reference cannot be added to a buffer afterwards.
   * The way in is to build the IFC WITH the reference and let the converter
   * read `IfcProjectedCRS` out of it — which is why this generates an IFC it
   * then throws away.
   *
   * The placement comes from `locRef`, not from the store: the user may have
   * dragged the model since the project was last saved, and the file should
   * say where it stands NOW.
   */
  const exportProjectFrag = useCallback(async () => {
    if (nodes.length === 0) { alert('Proiectul nu are geometrie de exportat.'); return; }
    const blocked = projectExportBlocked(buildProjectScene());
    if (blocked) { alert(blocked); return; }
    const L = locRef.current;
    const crs = L.crs ?? DEFAULT_PROJECT_CRS;
    if (!isKnownCrs(crs)) { alert(`Sistemul de coordonate ${crs} nu este cunoscut.`); return; }
    setProjectExport('frag');
    try {
      const { content } = buildIfcModel(nodes, edges, projectName || 'Model', {
        georeference: georefFromWorldLocation(L, crs),
        materialConfig: matConfig,
      });
      const frag = await convertIfcToFragments(new TextEncoder().encode(content));
      downloadBytes(fragFileName(projectName || 'model'), frag, FRAG_MIME);
    } catch (err) {
      console.error('[WorldViewer] project .frag export failed:', err);
      alert(`Exportul .frag a eșuat: ${(err as Error).message}`);
    } finally {
      setProjectExport(null);
    }
  }, [nodes, edges, projectName, matConfig, buildProjectScene, projectExportBlocked]);

  /** Patch one model's own placement (ignored while it is linked). */
  const updateIfcLoc = useCallback((id: string, patch: Partial<WorldLocation>) => {
    setIfcList((l) => l.map((m) => m.id === id ? { ...m, location: { ...m.location, ...patch } } : m));
  }, []);

  // ── Keep every imported IFC where its placement says ───────────────────────
  // One effect owns the Cesium side: the model matrix, the pin, visibility.
  // A linked model reads the project location, so moving the project moves it.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    for (const m of ifcList) {
      const entry = ifcModelsRef.current.get(m.id);
      if (!entry) continue;
      const L = m.linked ? loc : m.location;
      entry.cesium.modelMatrix = placementMatrix(L);
      // The glTF is one of three renderings, and only the chosen one draws.
      // This effect also runs on a plain move or turn, when the mode effect
      // below does not — without the check, rotating a model in fragments
      // mode brought the glTF back on top of it.
      entry.cesium.show = m.visible && renderModeRef.current === 'gltf';
      (entry.pin.position as Cesium.ConstantPositionProperty).setValue(insertionPoint(L));
      entry.pin.show = m.visible;

      // The bounding box moves and turns with the model, and is shown for the
      // selected one only — permanently drawn boxes would hide the models.
      const c = boundsCentre(entry.bounds, L);
      (entry.box.position as Cesium.ConstantPositionProperty).setValue(c);
      (entry.box.orientation as Cesium.ConstantProperty).setValue(
        Cesium.Transforms.headingPitchRollQuaternion(
          c, new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(L.rotation), 0, 0),
        ),
      );
      entry.box.show = m.visible && m.id === selectedIfcId;
    }
  }, [ifcList, loc, selectedIfcId]);

  /**
   * Move one model so its insertion point lands on `hit`, keeping the ENU
   * offsets as they are: a drag moves the anchor, not the nudge. A linked
   * model moves the PROJECT — that is the whole point of linking, and it is
   * how a plain IFC ends up georeferenced: you drag it onto the map.
   */
  const moveIfcTo = useCallback((id: string, lat: number, lng: number) => {
    const m = ifcListRef.current.find((x) => x.id === id);
    if (!m) return;
    if (m.linked) setLoc((prev) => placedAt(prev, lat, lng));
    else updateIfcLoc(id, placedAt(m.location, lat, lng));
  }, [setLoc, updateIfcLoc]);

  // ── Drop a pin, and the model lands there ──────────────────────────────────
  // One gesture for everything on the globe. What the pin moves is whatever
  // is selected — an imported IFC with its own placement, an imported .bbim
  // instance — and otherwise the project itself, which takes every model
  // linked to it along. Dropping is how a project gets georeferenced, so the
  // BIM model is switched on if it was hidden: the point is to see it land.
  const dropTarget = useMemo(() => {
    const ifc = selectedIfcId ? ifcList.find((m) => m.id === selectedIfcId) : null;
    if (ifc && !ifc.linked) return { kind: 'ifc' as const, id: ifc.id, name: ifc.name };
    if (selectedInstance) return { kind: 'instance' as const, id: selectedInstance.id, name: selectedInstance.name };
    return { kind: 'project' as const, id: null, name: projectName || 'proiectul' };
  }, [selectedIfcId, ifcList, selectedInstance, projectName]);
  const dropTargetRef = useRef(dropTarget);
  useEffect(() => { dropTargetRef.current = dropTarget; }, [dropTarget]);

  const [dropNote, setDropNote] = useState<string | null>(null);
  useEffect(() => {
    if (!dropNote) return;
    const t = setTimeout(() => setDropNote(null), 7000);
    return () => clearTimeout(t);
  }, [dropNote]);

  const flyToPoint = useCallback((lat: number, lng: number, heading: number) => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const { height, pitch } = VIEW_CONFIGS[viewMode] ?? VIEW_CONFIGS.perspective;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lng, lat, Math.max(height, 80)),
      orientation: { heading: Cesium.Math.toRadians(heading), pitch: Cesium.Math.toRadians(pitch), roll: 0 },
      duration: 0.8,
    });
  }, [viewMode]);

  const dropAt = useCallback(async (lat: number, lng: number) => {
    const target = dropTargetRef.current;
    setAltLoading(true);
    const alt = await fetchElevation(lat, lng);
    setAltLoading(false);
    if (alt !== null) setAltSource('srtm');
    const altPatch = alt !== null ? { alt } : {};

    if (target.kind === 'ifc') {
      const m = ifcListRef.current.find((x) => x.id === target.id);
      if (m) updateIfcLoc(target.id, placedAt(m.location, lat, lng, altPatch));
      flyToPoint(lat, lng, ifcListRef.current.find((m) => m.id === target.id)?.location.rotation ?? 0);
    } else if (target.kind === 'instance') {
      const inst = useBubbleGraphStore.getState().globeInstances.find((g) => g.id === target.id);
      if (inst) {
        updateGlobeInstance(target.id, {
          location: placedAt(inst.location, lat, lng, altPatch),
        });
        flyToPoint(lat, lng, inst.location.rotation);
      }
    } else {
      if (!showBimRef.current && nodes.length > 0) setShowBim(true);
      placeMarkerRef.current?.(lat, lng, alt ?? undefined);
    }

    setDropNote(
      `${target.name} plasat la ${fmtCoord(lat, 5)}°N ${fmtCoord(lng, 5)}°E`
      + (alt !== null ? ` · cotă ${alt} m (SRTM)` : '')
      + ' · trage pinul ca să ajustezi',
    );
  }, [fetchElevation, updateIfcLoc, updateGlobeInstance, setShowBim, nodes.length, flyToPoint]);

  // The click placing mode has been waiting for.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWvClick = (e: Event) => {
      if (!placingRef.current) return;
      const { lat, lng } = (e as CustomEvent<{ lat: number; lng: number }>).detail;
      setPlacing(false);
      void dropAt(lat, lng);
    };
    container.addEventListener('_wv_click', onWvClick);
    return () => container.removeEventListener('_wv_click', onWvClick);
  }, [dropAt]);

  // While placing, a ghost pin rides the cursor over the terrain, so you see
  // where the drop will land before you commit to it. Esc puts it away.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!placing || !viewer || !viewerReady || viewer.isDestroyed()) return;
    const ghost = viewer.entities.add({
      id: 'placing-ghost',
      show: false,
      billboard: {
        image: createBuildingPinCanvas(),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        color: Cesium.Color.WHITE.withAlpha(0.6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      const c = viewer.scene.pickPosition(e.endPosition)
        ?? viewer.camera.pickEllipsoid(e.endPosition, viewer.scene.globe.ellipsoid);
      if (!c) { ghost.show = false; return; }
      ghost.position = new Cesium.ConstantPositionProperty(c);
      ghost.show = true;
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPlacing(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      handler.destroy();
      if (!viewer.isDestroyed()) viewer.entities.remove(ghost);
    };
  }, [placing, viewerReady]);

  // ── Drag an imported model by its insertion point ──────────────────────────
  // The gesture is on the crosshair pin, never on the model body: a click on
  // the body has to stay free to select an element and show its properties.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !viewerReady) return;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    const camera = viewer.scene.screenSpaceCameraController;

    // The project's own pin drags too — the same gesture for every model on
    // the globe, and the natural way to nudge a drop that landed nearly right.
    const PROJECT = '__project__';
    interface Drag {
      id: string; start: WorldLocation; grabE: number; grabN: number;
      last?: { lat: number; lng: number };
    }
    let drag: Drag | null = null;

    const placementOf = (id: string): WorldLocation | null => {
      if (id === PROJECT) return locRef.current;
      const m = ifcListRef.current.find((x) => x.id === id);
      if (!m) return null;
      return m.linked ? locRef.current : m.location;
    };

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (placingRef.current || drawingPolyRef.current || ifcPlacingRef.current) return;
      const picked = viewer.scene.pick(event.position);
      const entity = picked?.id as unknown as { _bbIfcPinId?: string; id?: string } | undefined;
      const id = entity?._bbIfcPinId ?? (entity?.id === 'building-anchor' ? PROJECT : undefined);
      if (!id) return;
      const start = placementOf(id);
      if (!start) return;
      const grab = groundOffsetAt(viewer, event.position, start);
      if (!grab) return;
      drag = { id, start, grabE: grab.e, grabN: grab.n };
      if (id !== PROJECT) setSelectedIfcId(id);
      camera.enableInputs = false;              // the drag owns the mouse
      viewer.scene.canvas.style.cursor = 'grabbing';
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!drag) return;
      const hit = groundOffsetAt(viewer, event.endPosition, drag.start);
      if (!hit) return;
      // Re-derive from the drag START every frame rather than accumulating:
      // the point under the cursor at mouse-down stays under the cursor.
      const de = hit.e - drag.grabE;
      const dn = hit.n - drag.grabN;
      const base = Cesium.Cartesian3.fromDegrees(drag.start.lng, drag.start.lat, drag.start.alt);
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(base);
      const moved = Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(de, dn, 0), new Cesium.Cartesian3());
      const carto = Cesium.Cartographic.fromCartesian(moved);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      const lng = Cesium.Math.toDegrees(carto.longitude);
      drag.last = { lat, lng };
      if (drag.id === PROJECT) setLoc((prev) => placedAt(prev, lat, lng));
      else moveIfcTo(drag.id, lat, lng);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    const endDrag = () => {
      if (!drag) return;
      const done = drag;
      drag = null;
      camera.enableInputs = true;
      viewer.scene.canvas.style.cursor = '';
      // The terrain under the new spot may sit at another height. Asked once,
      // when the drag ends — not on every frame of it.
      if (!done.last) return;
      const { lat, lng } = done.last;
      void fetchElevation(lat, lng).then((alt) => {
        if (alt === null) return;
        setAltSource('srtm');
        const m = ifcListRef.current.find((x) => x.id === done.id);
        if (done.id === PROJECT || m?.linked) setLoc((prev) => ({ ...prev, alt }));
        else if (m) updateIfcLoc(done.id, { alt });
      });
    };
    handler.setInputAction(endDrag, Cesium.ScreenSpaceEventType.LEFT_UP);

    return () => { endDrag(); handler.destroy(); };
  }, [viewerReady, moveIfcTo, setLoc, updateIfcLoc, fetchElevation]);

  // ── Variant A: the fragments overlay ───────────────────────────────────────
  // Built once, kept for the life of the viewer, hidden when another mode is
  // showing. Tearing down a WebGL context on every toggle would make the
  // comparison itself expensive, and the point of the toggle is to compare.
  useEffect(() => {
    if (!viewerReady) return;
    const viewer = viewerRef.current;
    const container = containerRef.current;
    if (!viewer || viewer.isDestroyed() || !container) return;

    let overlay: FragmentsOverlay;
    try {
      overlay = new FragmentsOverlay(container, {
        lat: locRef.current.lat, lng: locRef.current.lng, alt: locRef.current.alt,
      });
    } catch (err) {
      // A second WebGL context is not guaranteed; some machines cap them.
      console.error('[WorldViewer] fragments overlay unavailable:', err);
      setOverlayNote('Stratul Fragments nu a putut porni: al doilea context WebGL a fost refuzat.');
      return;
    }
    overlayRef.current = overlay;
    overlay.setVisible(false);
    setOverlayReady(true);

    // Drawn after Cesium each frame, so the layer lands on top of the globe.
    const onPostRender = () => {
      if (overlay.canvas.style.display === 'none') return;
      const cam = readCesiumCamera(viewer);
      if (!cam) return;
      overlay.applyCamera(cam);
      overlay.render();
    };
    viewer.scene.postRender.addEventListener(onPostRender);

    // Fragments streams tiles for the camera it was given. Asking for an
    // update when the camera settles is what makes detail arrive, and is the
    // same trigger the TOC viewer uses.
    const onMoveEnd = () => {
      if (overlay.canvas.style.display === 'none') return;
      void getHeadlessFragments().update(true).catch(() => {});
    };
    viewer.camera.moveEnd.addEventListener(onMoveEnd);

    const ro = new ResizeObserver(() => overlay.resize());
    ro.observe(container);

    return () => {
      // React tears effects down in order, and the effect that owns the
      // Cesium viewer destroys it before this one runs. A destroyed Viewer
      // has no `_cesiumWidget`, so merely READING `viewer.scene` throws —
      // which surfaces as a crash inside a cleanup, taking the component
      // down with it. The listeners die with the viewer anyway.
      if (!viewer.isDestroyed()) {
        viewer.scene.postRender.removeEventListener(onPostRender);
        viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      }
      ro.disconnect();
      overlay.dispose();
      overlayRef.current = null;
      setOverlayReady(false);
    };
  }, [viewerReady]);

  // Populate the overlay: the live fragments object of every imported model,
  // placed relative to the overlay's anchor. This is the whole difference
  // from the glTF mode — what goes in the scene is the streaming model
  // itself, not a snapshot of it.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !overlayReady) return;

    // The scene's origin is the project's INSERTION POINT — anchor plus the
    // ENU offsets — not the bare anchor. A linked model sits at offset zero
    // from it, so anchoring the scene at the bare lat/lng/alt silently
    // dropped the project's own East/North/Up offsets: that is what left the
    // fragments layer at the wrong height while the glTF stood at the set one.
    overlay.setAnchor(overlayAnchorOf(loc));

    for (const child of [...overlay.scene.children]) {
      if (child.userData[OVERLAY_MODEL_KEY]) overlay.scene.remove(child);
    }
    if (renderMode !== 'fragments') return;

    for (const m of ifcList) {
      const entry = ifcModelsRef.current.get(m.id);
      if (!entry || !m.visible) continue;
      const L = m.linked ? loc : m.location;

      // Offset from the scene origin, in metres: this model's insertion point
      // expressed in the origin's own frame. Zero for a linked model.
      const d = overlayOffsetOf(loc, L);
      const node = overlayNodeFor(entry.model.object, entry.toProject, m.id);
      placeInOverlay(node, d.e, d.n, d.u, L.rotation);

      overlay.scene.add(node);
      entry.model.useCamera(overlay.camera);
    }
    void getHeadlessFragments().update(true).catch(() => {});
  }, [renderMode, overlayReady, ifcList, loc]);

  // ── Variant B: 3D Tiles ────────────────────────────────────────────────────
  // Built the first time the mode is asked for, then kept. The conversion is
  // the honest cost of this architecture, so it is worth feeling it once —
  // and worth not paying it again on every toggle.
  const [tilesBuilding, setTilesBuilding] = useState<string | null>(null);
  const [tilesNote, setTilesNote] = useState<string | null>(null);

  // ── Point clouds ─────────────────────────────────────────────────────────
  //
  // The scan is converted on the backend — nothing in a browser reads a .laz
  // or an .e57 — and what comes back is an ordinary 3D Tiles URL. Placement
  // follows the same rule as an imported IFC: the cloud's coordinates are
  // treated as metres east/north/up of the project's insertion point, which is
  // right for a local survey and is the only honest option until the CRS in
  // the file is read and reprojected.
  interface CloudEntry {
    id: string;
    name: string;
    state: PointCloudJob['state'];
    note: string;
    visible: boolean;
    points?: number;
    primitive?: Cesium.Cesium3DTileset;
  }
  const [clouds, setClouds] = useState<CloudEntry[]>([]);
  const [cloudBusy, setCloudBusy] = useState(false);
  const cloudFileRef = useRef<HTMLInputElement | null>(null);
  const cloudPrimitivesRef = useRef(new Map<string, Cesium.Cesium3DTileset>());

  const patchCloud = useCallback((id: string, patch: Partial<CloudEntry>) => {
    setClouds((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const handleLoadPointCloud = useCallback(async (file: File) => {
    setCloudBusy(true);
    // A placeholder id until the backend gives us the real one: the row has to
    // appear at once, because a 2 GB upload is a long time to look at nothing.
    const localId = `pending-${Date.now()}`;
    setClouds((l) => [...l, {
      id: localId, name: file.name, state: 'queued',
      note: `se încarcă — ${formatCloudBytes(file.size)}`, visible: true,
    }]);
    let serverId: string | null = null;
    try {
      const job = await convertPointCloud(file, (j) => {
        serverId = j.id;
        setClouds((l) => l.map((c) => (c.id === localId || c.id === j.id
          ? {
            ...c, id: j.id, state: j.state,
            note: j.steps?.length ? j.steps[j.steps.length - 1] : 'se convertește…',
          }
          : c)));
      });

      const url = tilesetUrlOf(job);
      const viewer = viewerRef.current;
      if (!url) throw new Error('Conversia nu a produs un tileset.');
      if (!viewer || viewer.isDestroyed()) return;

      const primitive = await Cesium.Cesium3DTileset.fromUrl(url, {
        // Points have no surface, so they need help being legible: attenuate
        // with distance and give the far ones a floor, or a dense scan reads
        // as a flat grey film from any distance.
        maximumScreenSpaceError: 8,
      });
      if (viewer.isDestroyed()) return;
      primitive.pointCloudShading.attenuation = true;
      primitive.pointCloudShading.maximumAttenuation = 6;
      primitive.pointCloudShading.eyeDomeLighting = true;
      primitive.modelMatrix = placementMatrix(locRef.current);
      viewer.scene.primitives.add(primitive);
      cloudPrimitivesRef.current.set(job.id, primitive);

      const r = job.result;
      patchCloud(job.id, {
        state: 'ready', primitive, points: r?.points,
        note: r
          ? `${r.points.toLocaleString('ro-RO')} puncte · ${r.tiles} tile-uri · pas ${r.rootSpacingM.toFixed(2)} m`
            + (r.stride > 1 ? ` · rărit 1/${r.stride}` : '')
          : 'gata',
      });
      void viewer.flyTo(primitive, { duration: 1.5 }).catch(() => undefined);
    } catch (e) {
      const id = serverId ?? localId;
      patchCloud(id, { state: 'failed', note: (e as Error).message });
      console.error('[WorldViewer] point cloud failed:', e);
    } finally {
      setCloudBusy(false);
    }
  }, [patchCloud]);

  const removeCloud = useCallback((id: string) => {
    const viewer = viewerRef.current;
    const primitive = cloudPrimitivesRef.current.get(id);
    if (primitive && viewer && !viewer.isDestroyed()) {
      viewer.scene.primitives.remove(primitive);
    }
    cloudPrimitivesRef.current.delete(id);
    setClouds((l) => l.filter((c) => c.id !== id));
    if (!id.startsWith('pending-')) void deletePointCloud(id);
  }, []);

  const toggleCloud = useCallback((id: string) => {
    const primitive = cloudPrimitivesRef.current.get(id);
    if (!primitive) return;
    primitive.show = !primitive.show;
    patchCloud(id, { visible: primitive.show });
  }, [patchCloud]);

  // ── 3D Tiles already built elsewhere ─────────────────────────────────────
  //
  // Either an archive — which is what this app's own `packageTileset` exports,
  // so this closes a loop that was open at one end — or a URL to something
  // already hosted. A tileset that carries its own root `transform` knows
  // where on Earth it belongs and is left alone; one without is placed at the
  // project, like an imported IFC.
  interface SetEntry {
    key: string;
    name: string;
    note: string;
    state: 'loading' | 'ready' | 'failed';
    visible: boolean;
    remoteId?: string;
    primitive?: Cesium.Cesium3DTileset;
  }
  const [tilesets, setTilesets] = useState<SetEntry[]>([]);
  const [tilesetBusy, setTilesetBusy] = useState(false);
  const [tilesetUrlInput, setTilesetUrlInput] = useState('');
  const tilesetFileRef = useRef<HTMLInputElement | null>(null);
  const setPrimitivesRef = useRef(new Map<string, Cesium.Cesium3DTileset>());

  const patchSet = useCallback((key: string, patch: Partial<SetEntry>) => {
    setTilesets((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }, []);

  /** Add a tileset that is already reachable over HTTP. */
  const attachTileset = useCallback(async (
    key: string, url: string,
    opts: { pointCloud?: boolean; hasTransform?: boolean; label?: string } = {},
  ) => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    const primitive = await Cesium.Cesium3DTileset.fromUrl(url, { maximumScreenSpaceError: 16 });
    if (viewer.isDestroyed()) return;
    if (opts.pointCloud) {
      primitive.pointCloudShading.attenuation = true;
      primitive.pointCloudShading.eyeDomeLighting = true;
    }
    // A tileset with a root transform is georeferenced already; overriding the
    // model matrix would move it off the spot it was built to sit on.
    if (!opts.hasTransform) primitive.modelMatrix = placementMatrix(locRef.current);
    // A point cloud has no features to pick and no attributes to show, so it
    // is left untagged and the pick handler passes over it. Everything else
    // carries the name the panel will show.
    if (!opts.pointCloud) {
      (primitive as unknown as { _bbTilesLayer?: string })._bbTilesLayer = opts.label ?? key;
    }
    viewer.scene.primitives.add(primitive);
    setPrimitivesRef.current.set(key, primitive);
    patchSet(key, { state: 'ready', primitive });
    void viewer.flyTo(primitive, { duration: 1.5 }).catch(() => undefined);
  }, [patchSet]);

  const handleLoadTilesetArchive = useCallback(async (file: File) => {
    setTilesetBusy(true);
    const key = `zip-${Date.now()}`;
    setTilesets((l) => [...l, {
      key, name: file.name, state: 'loading', visible: true,
      note: `se despachetează — ${formatSetBytes(file.size)}`,
    }]);
    try {
      const info: TilesetInfo = await uploadTilesetArchive(file);
      patchSet(key, {
        remoteId: info.id, name: info.name,
        note: `${info.tiles ?? '?'} tile-uri · ${info.files} fișiere · ${formatSetBytes(info.unpackedBytes)}`
          + (info.hasTransform ? ' · georeferențiat' : ''),
      });
      const pointCloud = (info.contentTypes ?? []).includes('.pnts');
      await attachTileset(key, archiveUrlOf(info), {
        pointCloud, hasTransform: info.hasTransform, label: info.name || file.name,
      });
    } catch (e) {
      patchSet(key, { state: 'failed', note: (e as Error).message });
      console.error('[WorldViewer] tileset archive failed:', e);
    } finally {
      setTilesetBusy(false);
    }
  }, [attachTileset, patchSet]);

  const handleLoadTilesetUrl = useCallback(async () => {
    const url = tilesetUrlInput.trim();
    if (!url) return;
    setTilesetBusy(true);
    const key = `url-${Date.now()}`;
    let short = url;
    try { short = new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('/') || url; } catch { /* keep */ }
    setTilesets((l) => [...l, { key, name: short, state: 'loading', visible: true, note: 'se verifică…' }]);
    try {
      // Probed first: Cesium's own failure for a CORS-refused URL says almost
      // nothing, and "that server will not talk to this page" is the single
      // most common reason a perfectly good tileset does not load.
      const probe = await probeTilesetUrl(url);
      patchSet(key, { note: `${probe.tiles} tile-uri · 3D Tiles ${probe.version ?? '?'}` });
      await attachTileset(key, url, { hasTransform: true, label: short });
      setTilesetUrlInput('');
    } catch (e) {
      patchSet(key, { state: 'failed', note: (e as Error).message });
    } finally {
      setTilesetBusy(false);
    }
  }, [attachTileset, patchSet, tilesetUrlInput]);

  const removeTileset = useCallback((key: string) => {
    const viewer = viewerRef.current;
    const primitive = setPrimitivesRef.current.get(key);
    if (primitive && tileHighlightRef.current?.feature?.tileset === primitive) {
      tileHighlightRef.current = null;
      setFeaturePick(null);
    }
    if (primitive && viewer && !viewer.isDestroyed()) viewer.scene.primitives.remove(primitive);
    setPrimitivesRef.current.delete(key);
    const entry = tilesets.find((s) => s.key === key);
    if (entry?.remoteId) void deleteTileset(entry.remoteId);
    setTilesets((l) => l.filter((s) => s.key !== key));
  }, [tilesets]);

  const toggleTileset = useCallback((key: string) => {
    const primitive = setPrimitivesRef.current.get(key);
    if (!primitive) return;
    primitive.show = !primitive.show;
    patchSet(key, { visible: primitive.show });
  }, [patchSet]);

  // ── CityJSON ─────────────────────────────────────────────────────────────
  //
  // The one exchange format here a browser can read by itself: JSON, with the
  // geometry as indices into a vertex list. No upload, no conversion, no
  // server — the file is parsed where it is dropped and becomes a primitive.
  //
  // Placement follows the same rule as a point cloud or an IFC: the
  // coordinates are metres east/north/up of the project's insertion point.
  // A file in a projected CRS has coordinates hundreds of kilometres from
  // zero, and `parseCityJson` recentres those onto the insertion point rather
  // than putting the model in the next county — and says so in the row.
  interface CityEntry {
    key: string;
    name: string;
    note: string;
    state: 'loading' | 'ready' | 'failed';
    visible: boolean;
    warnings: string[];
  }
  const [cities, setCities] = useState<CityEntry[]>([]);
  const [cityBusy, setCityBusy] = useState(false);
  const cityFileRef = useRef<HTMLInputElement | null>(null);
  const cityPrimitivesRef = useRef(new Map<string, Cesium.Primitive>());

  const handleLoadCityJson = useCallback(async (file: File) => {
    setCityBusy(true);
    const key = `city-${Date.now()}`;
    setCities((l) => [...l, {
      key, name: file.name, state: 'loading', visible: true,
      note: `se citește — ${formatCloudBytes(file.size)}`, warnings: [],
    }]);
    const patch = (p: Partial<CityEntry>) =>
      setCities((l) => l.map((c) => (c.key === key ? { ...c, ...p } : c)));
    try {
      const [{ parseCityJson }, { cityJsonPrimitive, cityJsonBoundingSphere }] = await Promise.all([
        import('@/lib/cityjson/parse'),
        import('@/lib/cityjson/toCesium'),
      ]);
      const model = parseCityJson(await file.text());
      if (model.objects.length === 0) {
        throw new Error(model.warnings[0] ?? 'Nimic de desenat în fișier.');
      }

      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;
      const matrix = placementMatrix(locRef.current);
      const primitive = cityJsonPrimitive(model, matrix);
      // The pick handler runs far from this state, so the layer names it puts
      // in the panel ride on the primitives themselves — the same trick the
      // IFC layers here already use with `_bbIfcId`.
      (primitive as unknown as { _bbCityLayer?: string })._bbCityLayer = file.name;
      viewer.scene.primitives.add(primitive);
      cityPrimitivesRef.current.set(key, primitive);

      const e = model.extent;
      patch({
        state: 'ready',
        warnings: model.warnings,
        note: `${model.counts.drawn} obiecte · ${model.counts.triangles.toLocaleString('ro-RO')} triunghiuri`
          + ` · ${Math.round(e.maxX - e.minX)}×${Math.round(e.maxY - e.minY)} m`
          + ` · CityJSON ${model.version}`
          + (model.recentred ? ' · recentrat' : ''),
      });
      viewer.camera.flyToBoundingSphere(cityJsonBoundingSphere(model, matrix), { duration: 1.5 });
    } catch (err) {
      patch({ state: 'failed', note: (err as Error).message });
      console.error('[WorldViewer] CityJSON failed:', err);
    } finally {
      setCityBusy(false);
    }
  }, []);

  const removeCity = useCallback((key: string) => {
    const viewer = viewerRef.current;
    const primitive = cityPrimitivesRef.current.get(key);
    // Drop the selection first: restoring a colour on a primitive that has
    // been destroyed is the one way this can throw.
    if (cityHighlightRef.current?.primitive === primitive) {
      cityHighlightRef.current = null;
      setFeaturePick(null);
    }
    if (primitive && viewer && !viewer.isDestroyed()) viewer.scene.primitives.remove(primitive);
    cityPrimitivesRef.current.delete(key);
    setCities((l) => l.filter((c) => c.key !== key));
  }, []);

  const toggleCity = useCallback((key: string) => {
    const primitive = cityPrimitivesRef.current.get(key);
    if (!primitive) return;
    primitive.show = !primitive.show;
    setCities((l) => l.map((c) => (c.key === key ? { ...c, visible: primitive.show } : c)));
  }, []);

  // ── Picking an imported feature ──────────────────────────────────────────
  //
  // A CityJSON object and a 3D Tiles feature both carry attributes, and both
  // are highlighted by putting the selection colour ON the thing itself —
  // there is no second copy of the geometry to draw over it. So the previous
  // colour has to be kept, because "unhighlight" means putting it back.
  //
  // The two layers do that through different doors: an instance of a
  // `Primitive` through its per-instance colour attribute, a tile feature
  // through its own `color`, which Cesium multiplies into the shader. Neither
  // survives being guessed at, so each keeps what it replaced.
  const [featurePick, setFeaturePick] = useState<PickedFeature | null>(null);
  const cityHighlightRef = useRef<{ primitive: Cesium.Primitive; id: object; color: Uint8Array } | null>(null);
  const tileHighlightRef = useRef<{ feature: Cesium.Cesium3DTileFeature; color: Cesium.Color } | null>(null);

  /** Cesium's selection tint — the one the viewer already uses for its own picks. */
  const HIGHLIGHT = useMemo(() => Cesium.Color.fromCssColorString('#f97316'), []);

  const clearFeatureHighlight = useCallback(() => {
    const city = cityHighlightRef.current;
    if (city) {
      try {
        const attrs = city.primitive.getGeometryInstanceAttributes(city.id);
        if (attrs) attrs.color = city.color;
      } catch {
        // The layer was removed under us; there is nothing to put back.
      }
      cityHighlightRef.current = null;
    }
    const tile = tileHighlightRef.current;
    if (tile) {
      try {
        tile.feature.color = tile.color;
      } catch {
        // A tile can unload between the pick and the next click.
      }
      tileHighlightRef.current = null;
    }
  }, []);

  const clearFeaturePick = useCallback(() => {
    clearFeatureHighlight();
    setFeaturePick(null);
  }, [clearFeatureHighlight]);

  // The panel lives with the layers it describes, which is far down a long
  // sidebar — so a click on the globe would set it and the user would see
  // nothing move. Bring it into view instead.
  const featurePanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!featurePick) return;
    featurePanelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [featurePick]);

  // Clouds, tilesets and city models are primitives on a viewer this component
  // owns; when it goes, they have to go with it or the next mount inherits a
  // scene full of them.
  useEffect(() => () => {
    const viewer = viewerRef.current;
    const alive = viewer && !viewer.isDestroyed();
    const all = [
      ...cloudPrimitivesRef.current.values(),
      ...setPrimitivesRef.current.values(),
      ...cityPrimitivesRef.current.values(),
    ];
    for (const primitive of all) {
      if (alive) viewer!.scene.primitives.remove(primitive);
    }
    cloudPrimitivesRef.current.clear();
    setPrimitivesRef.current.clear();
    cityPrimitivesRef.current.clear();
  }, []);

  useEffect(() => {
    if (renderMode !== 'tiles') return;
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    let cancelled = false;

    (async () => {
      for (const m of ifcList) {
        const entry = ifcModelsRef.current.get(m.id);
        if (!entry || entry.tiles) continue;
        const L = m.linked ? locRef.current : m.location;
        setTilesBuilding(m.name);
        try {
          // GlobalIds up front, in one call: the property table is the whole
          // reason a pick on a tile can name the same element the other two
          // modes name.
          const localIds = entry.group.children
            .map((c) => c.userData.ifcLocalId as number | undefined)
            .filter((v): v is number => typeof v === 'number');
          const guids = await entry.model.getGuidsByLocalIds(localIds);
          const guidByLocalId = new Map(localIds.map((id, i) => [id, guids[i] ?? null]));

          // No root transform in the tileset itself: the placement goes on
          // the primitive's modelMatrix, below and in the effect that keeps
          // it current, so a move never rebuilds the tiles. Cesium composes
          // the two, so writing it in both places placed the model twice
          // over — off the planet — the moment anything was dragged.
          const built = await buildTilesetFromGroup(entry.group, {
            guidOf: (id) => guidByLocalId.get(id) ?? null,
          });
          if (cancelled) { built.urls.forEach((u) => URL.revokeObjectURL(u)); return; }

          const primitive = await Cesium.Cesium3DTileset.fromUrl(built.tilesetUrl);
          // The build takes seconds; the tab may have moved on. Touching a
          // destroyed viewer throws from inside a getter, not a method, so
          // the check has to come before the property access.
          if (cancelled || viewer.isDestroyed()) {
            built.urls.forEach((u) => URL.revokeObjectURL(u));
            return;
          }
          // Placed where the model stands NOW, not where it stood when the
          // build started seconds ago.
          const current = ifcListRef.current.find((x) => x.id === m.id);
          const placedAt = current ? (current.linked ? locRef.current : current.location) : L;
          primitive.modelMatrix = placementMatrix(placedAt);
          viewer.scene.primitives.add(primitive);
          (primitive as unknown as { _bbIfcId: string })._bbIfcId = m.id;
          entry.tiles = { built, primitive };
          setTilesNote(`${built.tileCount} tile-uri · grilă ${built.gridSizeM} m · ${built.featureCount} elemente`);
        } catch (err) {
          console.error('[WorldViewer] building the tileset failed:', err);
          setTilesNote(`Construirea tileset-ului a eșuat: ${(err as Error).message}`);
        } finally {
          if (!cancelled) setTilesBuilding(null);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [renderMode, ifcList]);

  // ── The GlobalId is the link ───────────────────────────────────────────────
  // Picking a tiled element gives its GlobalId back from the tile's own
  // property table; this is the same street in the other direction. A style
  // expression addresses the element BY GlobalId, so the highlight works
  // without any per-element geometry — and it lights up whether the selection
  // came from a click here, from the fragments mode, or from a host platform
  // that only knows the identifier.
  useEffect(() => {
    const guid = ifcPick?.element?.guid ?? null;
    for (const [, entry] of ifcModelsRef.current) {
      if (!entry.tiles) continue;
      entry.tiles.primitive.style = new Cesium.Cesium3DTileStyle(
        highlightGuidStyle(renderMode === 'tiles' ? guid : null),
      );
    }
  }, [ifcPick, renderMode]);

  // Keep a built tileset standing where its model stands.
  useEffect(() => {
    for (const m of ifcList) {
      const entry = ifcModelsRef.current.get(m.id);
      if (!entry?.tiles) continue;
      const L = m.linked ? loc : m.location;
      entry.tiles.primitive.modelMatrix = placementMatrix(L);
    }
  }, [ifcList, loc]);

  // Only one mode draws at a time, or you are comparing a model with itself.
  useEffect(() => {
    renderModeRef.current = renderMode;
    overlayRef.current?.setVisible(renderMode === 'fragments');
    for (const m of ifcList) {
      const entry = ifcModelsRef.current.get(m.id);
      if (!entry) continue;
      entry.cesium.show = renderMode === 'gltf' && m.visible;
      if (entry.tiles) entry.tiles.primitive.show = renderMode === 'tiles' && m.visible;
    }
  }, [renderMode, ifcList]);

  // ── Click-pick handler for instance selection ──────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !viewerReady) return;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (placingRef.current) return; // placing mode takes priority

      // "Place insertion point" mode: the next click on the globe is where
      // this model's origin goes. Precision alternative to the drag.
      const placingId = ifcPlacingRef.current;
      if (placingId) {
        const cart = viewer.scene.pickPosition(event.position)
          ?? viewer.camera.pickEllipsoid(event.position, viewer.scene.globe.ellipsoid);
        if (cart) {
          const c = Cesium.Cartographic.fromCartesian(cart);
          moveIfcTo(placingId, Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude));
        }
        setIfcPlacing(null);
        return;
      }

      // ── Fragments overlay: ask the model itself what is under the cursor ──
      // Its own raycaster knows the batched geometry and returns a local id,
      // so a pick here resolves to the same element the other modes resolve
      // to — which is the only way the comparison is fair.
      const overlay = overlayRef.current;
      if (renderModeRef.current === 'fragments' && overlay) {
        const mouse = new THREE.Vector2(event.position.x, event.position.y);
        void (async () => {
          for (const [id, entry] of ifcModelsRef.current) {
            let hit: { localId: number } | null = null;
            try {
              hit = await entry.model.raycast({
                camera: overlay.camera, mouse, dom: overlay.canvas,
              });
            } catch (err) {
              console.warn('[WorldViewer] fragments raycast failed:', err);
            }
            if (!hit) continue;
            setSelectedIfcId(id);
            setSelectedInstanceId(null);
            setIfcPick({ loading: true, element: null });
            Promise.all([readItemGuid(entry.model, hit.localId), readItemProperties(entry.model, hit.localId)])
              .then(([guid, element]) => {
                getHostBridge().reportSelection({
                  viewer: 'world', modelId: id, localId: hit!.localId,
                  guid: guid ?? element?.guid ?? null,
                  category: element?.category ?? null, name: element?.name ?? null,
                });
                setIfcPick({ loading: false, element });
              })
              .catch(() => setIfcPick({ loading: false, element: null }));
            return;
          }
          setIfcPick(null);
        })();
        return;
      }

      const pick = viewer.scene.pick(event.position);

      // ── 3D Tiles: the feature carries the metadata table we wrote ─────────
      if (pick instanceof Cesium.Cesium3DTileFeature) {
        const tilesetId = (pick.primitive as unknown as { _bbIfcId?: string })._bbIfcId;
        const entry = tilesetId ? ifcModelsRef.current.get(tilesetId) : undefined;
        const localId = Number(pick.getProperty('localId'));
        if (entry && Number.isFinite(localId)) {
          setSelectedIfcId(tilesetId!);
          setSelectedInstanceId(null);
          setIfcPick({ loading: true, element: null });
          readItemProperties(entry.model, localId)
            .then((element) => {
              getHostBridge().reportSelection({
                viewer: 'world', modelId: tilesetId!, localId,
                // The GlobalId comes off the tile's own property table — proof
                // that the tileset carries the identity, not just the shape.
                guid: (pick.getProperty('guid') as string) || element?.guid || null,
                category: element?.category ?? null, name: element?.name ?? null,
              });
              setIfcPick({ loading: false, element });
            })
            .catch(() => setIfcPick({ loading: false, element: null }));
          return;
        }

        // ── Any other 3D Tiles feature: show the table it does carry ───────
        // An imported tileset's property names are whoever built it chose,
        // so nothing is assumed about them — they are read out and listed.
        // A point cloud is deliberately untagged and falls straight through:
        // a picked point has no attributes to show.
        const tilesLayer = (pick.primitive as unknown as { _bbTilesLayer?: string })._bbTilesLayer;
        if (tilesLayer) {
          clearFeatureHighlight();
          try {
            tileHighlightRef.current = { feature: pick, color: Cesium.Color.clone(pick.color) };
            pick.color = HIGHLIGHT;
          } catch (err) {
            console.warn('[WorldViewer] tile highlight failed:', err);
          }
          setIfcPick(null);
          setFeaturePick(tilesFeature(pick, tilesLayer));
          return;
        }
      }

      // ── CityJSON: the instance id IS the object's attributes ─────────────
      // `cityJsonPrimitive` hands each instance the very object Cesium gives
      // back here, and that same reference is the key its colour is stored
      // under — so the pick and the highlight need no index between them.
      if (isCityPick(pick?.id)) {
        const primitive = pick.primitive as Cesium.Primitive;
        clearFeatureHighlight();
        try {
          const attrs = primitive.getGeometryInstanceAttributes(pick.id);
          if (attrs?.color) {
            cityHighlightRef.current = {
              primitive, id: pick.id as object, color: Uint8Array.from(attrs.color),
            };
            attrs.color = Cesium.ColorGeometryInstanceAttribute.toValue(HIGHLIGHT);
          }
        } catch (err) {
          console.warn('[WorldViewer] CityJSON highlight failed:', err);
        }
        const layer = (primitive as unknown as { _bbCityLayer?: string })._bbCityLayer;
        setIfcPick(null);
        setFeaturePick(cityJsonFeature(pick.id, layer ?? 'CityJSON'));
        return;
      }

      if (pick?.id && (pick.id as unknown as { _bbIfcPinId?: string })._bbIfcPinId) {
        setSelectedIfcId((pick.id as unknown as { _bbIfcPinId: string })._bbIfcPinId);
        return;
      }
      if (pick && pick.primitive) {
        // An element of an imported IFC: the glTF node name carries the
        // fragments local id, and the fragments model kept alongside answers
        // for its properties.
        const ifcId = (pick.primitive as unknown as { _bbIfcId?: string })._bbIfcId;
        if (ifcId) {
          const entry = ifcModelsRef.current.get(ifcId);
          const ref = parseItemNodeName(pickedNodeName(pick));
          setSelectedIfcId(ifcId);
          if (entry && ref) {
            setSelectedInstanceId(null);
            setIfcPick({ loading: true, element: null });
            Promise.all([readItemGuid(entry.model, ref.localId), readItemProperties(entry.model, ref.localId)])
              .then(([guid, element]) => {
                getHostBridge().reportSelection({
                  viewer: 'world', modelId: ifcId, localId: ref.localId,
                  guid: guid ?? element?.guid ?? null,
                  category: element?.category ?? null, name: element?.name ?? null,
                });
                setIfcPick({ loading: false, element });
              })
              .catch((err) => {
                console.warn('[WorldViewer] IFC properties read failed:', err);
                setIfcPick({ loading: false, element: null });
              });
            return;
          }
        }
        const instId = (pick.primitive as unknown as { _bbInstId?: string })._bbInstId;
        if (instId) {
          setSelectedInstanceId(instId);
          return;
        }
      }
      // Clicking empty space deselects
      setSelectedInstanceId(null);
      setIfcPick(null);
      clearFeaturePick();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => handler.destroy();
  }, [viewerReady, moveIfcTo, HIGHLIGHT, clearFeatureHighlight, clearFeaturePick]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={cn("flex flex-col h-full overflow-hidden bg-background", className)}>

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20 flex-shrink-0 flex-wrap">
        <span className="text-xs font-semibold text-foreground">🌍 World</span>
        {projectName && (
          <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
            {projectName}
          </span>
        )}
        <div className="flex-1" />

        <button
          onClick={() => setPlacing((v) => !v)}
          className={cn("text-xs px-2.5 py-1 rounded border transition-colors",
            placing
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background border-border text-foreground hover:bg-accent")}
          title="Apoi dă click pe hartă: modelul selectat (sau proiectul) ajunge acolo, la cota terenului"
        >
          {placing ? "⏹ Anulează" : "📍 Plasează pe hartă"}
        </button>

        <button
          onClick={() => focusCamera(viewMode)}
          className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground hover:bg-accent"
          title="Fly camera to building"
        >
          ⌖ Focus
        </button>

        <button
          onClick={handleImportBbim}
          className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground hover:bg-accent"
          title="Import a .bbim project file and place it on the globe"
        >
          📂 Import .bbim
        </button>

        <input
          ref={ifcFileRef} type="file" accept=".ifc" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImportIfc(f); e.target.value = ''; }}
        />
        <button
          onClick={() => ifcFileRef.current?.click()}
          disabled={ifcLoading !== null}
          className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50"
          title="Import an IFC file as fragments and place it on the globe"
        >
          {ifcLoading ? `⏳ ${ifcLoading}…` : '📥 Import IFC'}
        </button>

        {/* How the imported IFC is drawn — three architectures, side by side */}
        {ifcList.length > 0 && (
          <div className="flex items-center border border-border rounded overflow-hidden">
            {RENDER_MODES.map((m) => (
              <button
                key={m.id}
                title={m.hint}
                disabled={m.id === 'fragments' && !overlayReady}
                onClick={() => setRenderMode(m.id)}
                className={cn(
                  'text-[11px] px-2 py-1 transition-colors border-r border-border last:border-r-0 disabled:opacity-40',
                  renderMode === m.id
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background text-foreground hover:bg-accent',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        <button
          onClick={() => setExtrudeOpen((v) => !v)}
          title="Desenează un contur pe teren și extrudează-l pe verticală"
          className={cn("text-xs px-2.5 py-1 rounded border transition-colors",
            extrudeOpen
              ? "bg-sky-500 text-white border-sky-400"
              : "bg-background border-border text-foreground hover:bg-accent")}
        >
          ✏ Extrudare
        </button>

        {/* Polygon measurement */}
        <button
          onClick={() => (drawingPoly ? finishPolyDraw() : startPolyDraw())}
          className={cn("text-xs px-2.5 py-1 rounded border transition-colors",
            drawingPoly
              ? "bg-yellow-500 text-black border-yellow-400 hover:bg-yellow-400"
              : "bg-background border-border text-foreground hover:bg-accent")}
          title={drawingPoly ? "Double-click on globe or click here to close polygon" : "Draw a polygon to measure area and perimeter"}
        >
          📐 {drawingPoly ? "Close" : "Measure"}
        </button>
        {(drawingPoly || polyResult) && (
          <button
            onClick={clearPolyDraw}
            className="text-xs px-2 py-1 rounded border border-border bg-background text-destructive hover:bg-destructive/10 transition-colors"
            title="Clear polygon drawing"
          >
            ✕
          </button>
        )}

        {/* BIM overlay toggle */}
        <button
          disabled={bimLoading}
          title={nodes.length === 0 ? "No BIM model loaded" : showBim ? "Hide BIM model" : "Show BIM model on globe"}
          onClick={() => {
            if (bimLoading) return;
            if (showBim) {
              // Remove model
              if (cesiumModelRef.current && viewerRef.current) {
                viewerRef.current.scene.primitives.remove(cesiumModelRef.current);
                cesiumModelRef.current = null;
              }
              setShowBim(false);
            } else {
              setShowBim(true);
              if (entityRef.current) {
                void buildAndPlaceBimModel(
                  loc.lat, loc.lng, loc.alt,
                  loc.rotation, loc.offsetE, loc.offsetN, loc.offsetZ,
                );
              }
            }
          }}
          className={cn(
            "text-xs px-2.5 py-1 rounded border transition-colors",
            bimLoading
              ? "opacity-50 cursor-wait bg-background border-border text-foreground"
              : showBim
                ? "bg-emerald-600 text-white border-emerald-500 hover:bg-emerald-700"
                : "bg-background border-border text-foreground hover:bg-accent",
          )}
        >
          {bimLoading ? "⏳" : "🏗"} BIM
        </button>

        <div className="flex items-center border border-border rounded overflow-hidden">
          {([
            { key: "top"         as ViewMode, icon: "⊙", label: "Top view" },
            { key: "perspective" as ViewMode, icon: "🏙", label: "3D Perspective" },
            { key: "eye"         as ViewMode, icon: "👁", label: "Eye level / walkthrough" },
          ]).map(({ key, icon, label }) => (
            <button
              key={key}
              title={label}
              onClick={() => { setViewMode(key); focusCamera(key); }}
              className={cn(
                "text-xs px-2.5 py-1 transition-colors border-r border-border last:border-r-0",
                viewMode === key
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-foreground hover:bg-accent",
              )}
            >
              {icon}
            </button>
          ))}
        </div>
      </div>

      {/* Main layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Cesium globe */}
        <div className="flex-1 relative min-w-0" style={{ minHeight: 0 }}>
          <div
            ref={containerRef}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
          />
          {placing && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-[11px] font-medium shadow pointer-events-none">
              📍 Dă click pe hartă: acolo ajunge <span className="font-semibold">{dropTarget.name}</span> · Esc anulează
            </div>
          )}
          {dropNote && !placing && !altLoading && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-full bg-emerald-700/95 text-white text-[11px] shadow flex items-center gap-2 max-w-[90%]">
              <span className="truncate">📍 {dropNote}</span>
              <button className="opacity-70 hover:opacity-100 shrink-0" onClick={() => setDropNote(null)}>✕</button>
            </div>
          )}
          {extrusions.drawing && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-full bg-sky-500 text-white text-[11px] font-medium shadow pointer-events-none">
              ✏ Click pe teren pentru colțuri · dublu-click sau Enter închide · Esc anulează
            </div>
          )}
          {/* What the current mode does and does not do, while you compare */}
          {ifcList.length > 0 && renderMode !== 'gltf' && (
            <div className="absolute bottom-2 left-2 z-10 max-w-sm px-2.5 py-1.5 rounded bg-black/60 backdrop-blur text-white text-[10px] leading-snug pointer-events-none">
              <span className="font-semibold">{RENDER_MODES.find((m) => m.id === renderMode)?.label}</span>
              {' — '}{RENDER_MODES.find((m) => m.id === renderMode)?.hint}
            </div>
          )}
          {tilesBuilding && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-[11px] shadow">
              ⏳ Construiesc tileset-ul pentru {tilesBuilding}…
            </div>
          )}
          {tilesNote && renderMode === 'tiles' && (
            <div className="absolute bottom-10 left-2 z-10 px-2.5 py-1 rounded bg-black/60 backdrop-blur text-white text-[10px] pointer-events-none">
              {tilesNote}
            </div>
          )}
          {overlayNote && (
            <div className="absolute bottom-2 left-2 z-20 max-w-sm px-2.5 py-1.5 rounded bg-destructive text-destructive-foreground text-[10px]">
              {overlayNote}
            </div>
          )}
          {extrudeProblem && (
            <div className="absolute top-12 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-full bg-destructive text-destructive-foreground text-[11px] shadow">
              {extrudeProblem}
              <button className="ml-2 opacity-70 hover:opacity-100" onClick={() => setExtrudeProblem(null)}>✕</button>
            </div>
          )}
          {ifcPlacing && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-full bg-sky-500 text-white text-[11px] font-medium shadow pointer-events-none">
              ✛ Dă click pe hartă: acolo ajunge punctul de inserție al modelului
            </div>
          )}
          {drawingPoly && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-full bg-yellow-900/90 border border-yellow-500 text-yellow-200 text-[11px] font-medium shadow pointer-events-none">
              📐 Click to add points • Double-click or press Close to finish ({polyPoints.length} point{polyPoints.length !== 1 ? "s" : ""})
            </div>
          )}
          {polyResult && !drawingPoly && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-lg bg-yellow-900/90 border border-yellow-500 text-yellow-100 text-[11px] font-medium shadow space-y-0.5 pointer-events-none text-center">
              <div className="font-bold text-yellow-300">📐 Measurement</div>
              <div>
                Area: <span className="font-mono text-white">
                  {polyResult.areaSqM >= 10000
                    ? `${(polyResult.areaSqM / 10000).toFixed(2)} ha`
                    : `${polyResult.areaSqM.toFixed(1)} m²`}
                </span>
              </div>
              <div>
                Perimeter: <span className="font-mono text-white">
                  {polyResult.perimeterM >= 1000
                    ? `${(polyResult.perimeterM / 1000).toFixed(3)} km`
                    : `${polyResult.perimeterM.toFixed(1)} m`}
                </span>
              </div>
            </div>
          )}
          {altLoading && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-full bg-muted/90 border border-border text-[11px] text-foreground shadow pointer-events-none">
              ⏳ Citesc cota terenului…
            </div>
          )}
          {bimLoading && (
            <div className="absolute top-10 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-full bg-emerald-900/90 border border-emerald-700 text-[11px] text-emerald-200 shadow pointer-events-none">
              ⏳ Building 3D model…
            </div>
          )}
          {entityRef.current && !altLoading && (
            <div className="absolute bottom-6 left-2 z-10 bg-background/90 border border-border rounded px-2 py-1 text-[10px] text-foreground/80 pointer-events-none font-mono">
              {fmtCoord(loc.lat)}°N &nbsp; {fmtCoord(loc.lng)}°E &nbsp;
              <span className={cn(altSource === "srtm" ? "text-primary" : "")}>
                {loc.alt} m {altSource === "srtm" ? "(SRTM)" : ""}
              </span>
            </div>
          )}
        </div>

        {/* Control panel */}
        <aside className="w-64 flex-shrink-0 border-l border-border bg-card flex flex-col overflow-y-auto">

          {/* Search address / locality */}
          <div className="p-3 border-b border-border">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
              Search address
            </div>
            <div className="relative flex flex-col gap-1">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setSearchOpen(false); }}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder="City, address, landmark…"
                  className="flex-1 bg-background border border-border rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50"
                />
                <button
                  onClick={handleSearch}
                  disabled={searchLoading || !searchQuery.trim()}
                  className="px-2.5 py-1 rounded border border-primary/30 bg-primary/10 text-primary text-xs hover:bg-primary/20 disabled:opacity-40 transition-colors"
                >
                  {searchLoading ? "…" : "🔍"}
                </button>
              </div>

              {/* Results dropdown */}
              {searchOpen && searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 z-20 bg-card border border-border rounded shadow-lg max-h-52 overflow-y-auto">
                  {searchResults.map((r) => (
                    <button
                      key={r.place_id}
                      className="w-full text-left px-2 py-2 text-[10px] text-foreground hover:bg-accent border-b border-border/40 last:border-b-0 leading-tight"
                      onClick={async () => {
                        const lat = parseFloat(r.lat);
                        const lng = parseFloat(r.lon);
                        setSearchOpen(false);
                        setSearchQuery(r.display_name.split(",")[0]);
                        // A found address is a drop like any other: the same
                        // model lands there, with the terrain height.
                        await dropAt(lat, lng);
                      }}
                    >
                      <span className="font-medium">{r.display_name.split(",")[0]}</span>
                      <br />
                      <span className="text-muted-foreground">
                        {r.display_name.split(",").slice(1, 3).join(",").trim()}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {searchOpen && searchResults.length === 0 && !searchLoading && (
                <div className="text-[10px] text-muted-foreground px-1 py-1">No results found.</div>
              )}
            </div>
          </div>

          {/* Location */}
          <div className="p-3 border-b border-border">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Location</div>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-12 shrink-0 text-right">Lat</span>
                <input
                  type="text" value={coordInput.lat}
                  onChange={(e) => setCoordInput((p) => ({ ...p, lat: e.target.value }))}
                  onBlur={applyCoordInput}
                  onKeyDown={(e) => e.key === "Enter" && applyCoordInput()}
                  className="flex-1 bg-background border border-border rounded px-2 py-0.5 text-xs text-foreground font-mono"
                  placeholder="44.426800"
                />
                <span className="text-[10px] text-muted-foreground w-6">°</span>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-12 shrink-0 text-right">Lng</span>
                <input
                  type="text" value={coordInput.lng}
                  onChange={(e) => setCoordInput((p) => ({ ...p, lng: e.target.value }))}
                  onBlur={applyCoordInput}
                  onKeyDown={(e) => e.key === "Enter" && applyCoordInput()}
                  className="flex-1 bg-background border border-border rounded px-2 py-0.5 text-xs text-foreground font-mono"
                  placeholder="26.102500"
                />
                <span className="text-[10px] text-muted-foreground w-6">°</span>
              </label>

              {/* Alt field — shows SRTM badge when auto-detected */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-12 shrink-0 text-right">Alt</span>
                <div className="flex-1 relative">
                  <input
                    type="number"
                    step={1}
                    value={loc.alt}
                    onChange={(e) => {
                      updateLoc({ alt: parseFloat(e.target.value) || 0 });
                      setAltSource("manual");
                    }}
                    className="w-full bg-background border border-border rounded px-2 py-0.5 text-xs text-foreground"
                  />
                  {altLoading && (
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-primary animate-pulse">…</span>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground w-6">m</span>
                {altSource === "srtm" && !altLoading && (
                  <span className="text-[9px] text-primary bg-primary/10 border border-primary/20 rounded px-1">SRTM</span>
                )}
              </div>

              <button
                onClick={applyCoordInput}
                className="mt-1 w-full text-xs py-1 rounded bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors"
              >
                Go to coordinates
              </button>
            </div>
          </div>

          {/* Offsets */}
          <div className="p-3 border-b border-border">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Offset from anchor</div>
            <div className="flex flex-col gap-1.5">
              <NumField label="East"  value={loc.offsetE} unit="m" step={0.1} onChange={(v) => updateLoc({ offsetE: v })} />
              <NumField label="North" value={loc.offsetN} unit="m" step={0.1} onChange={(v) => updateLoc({ offsetN: v })} />
              <NumField label="Up"    value={loc.offsetZ} unit="m" step={0.1} onChange={(v) => updateLoc({ offsetZ: v })} />
            </div>
          </div>

          {/* Rotation */}
          <div className="p-3 border-b border-border">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Rotation</div>
            <div className="flex flex-col gap-2">
              <NumField label="Heading" value={loc.rotation} unit="°" step={1}
                onChange={(v) => updateLoc({ rotation: ((v % 360) + 360) % 360 })} />
              <div className="flex flex-col items-center gap-1 py-2">
                <div
                  className="relative w-20 h-20 cursor-pointer select-none"
                  title="Drag to rotate"
                  onMouseDown={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const cx = rect.left + rect.width / 2;
                    const cy = rect.top + rect.height / 2;
                    const onMove = (me: MouseEvent) => {
                      const angle = Math.atan2(me.clientX - cx, -(me.clientY - cy)) * 180 / Math.PI;
                      updateLoc({ rotation: ((angle % 360) + 360) % 360 });
                    };
                    const onUp = () => {
                      window.removeEventListener("mousemove", onMove);
                      window.removeEventListener("mouseup", onUp);
                    };
                    window.addEventListener("mousemove", onMove);
                    window.addEventListener("mouseup", onUp);
                  }}
                >
                  <svg viewBox="0 0 80 80" className="w-full h-full">
                    <circle cx="40" cy="40" r="36" fill="none" stroke="hsl(var(--border))" strokeWidth="2" />
                    <text x="40" y="10"  textAnchor="middle" dominantBaseline="middle" fontSize="8" fill="hsl(var(--muted-foreground))">N</text>
                    <text x="40" y="72"  textAnchor="middle" dominantBaseline="middle" fontSize="8" fill="hsl(var(--muted-foreground))">S</text>
                    <text x="10" y="41"  textAnchor="middle" dominantBaseline="middle" fontSize="8" fill="hsl(var(--muted-foreground))">W</text>
                    <text x="72" y="41"  textAnchor="middle" dominantBaseline="middle" fontSize="8" fill="hsl(var(--muted-foreground))">E</text>
                    <g transform={`rotate(${loc.rotation} 40 40)`}>
                      <polygon points="40,12 44,50 40,46 36,50" fill="hsl(var(--primary))" />
                      <polygon points="40,68 44,30 40,34 36,30" fill="hsl(var(--muted-foreground)/0.4)" />
                      <circle cx="40" cy="40" r="3" fill="hsl(var(--primary))" />
                    </g>
                  </svg>
                </div>
                <span className="text-[10px] text-muted-foreground">{loc.rotation.toFixed(1)}° heading</span>
              </div>
            </div>
          </div>

          {/* CRS, converter, basemap, georeferenced overlay */}
          <WorldGeoPanel
            loc={loc}
            onLocChange={updateLoc}
            basemap={basemap}
            onBasemapChange={setBasemap}
            overlay={overlay}
            onOverlayChange={setOverlay}
            onGoTo={(lat, lng) => {
              const viewer = viewerRef.current;
              if (!viewer || viewer.isDestroyed()) return;
              viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(lng, lat, 800),
              });
            }}
          />

          {/* The project's own model, out as a file that stands on site */}
          <div className="p-3 border-b border-border flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Exportă modelul proiectului
            </span>
            <button
              onClick={() => void exportProjectTiles()}
              disabled={projectExport !== null || nodes.length === 0}
              title={nodes.length === 0
                ? 'Proiectul nu are geometrie'
                : 'Arhivă .zip cu tileset.json și tile-urile GLB. Fiecare element își păstrează culoarea și poartă id-ul nodului, iar poziția e scrisă în root.transform.'}
              className="text-[11px] py-1 rounded border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40"
            >
              {projectExport === 'tiles' ? '⏳ Se construiește…' : '⬇ 3D Tiles georeferențiat'}
            </button>
            <button
              onClick={() => void exportProjectFrag()}
              disabled={projectExport !== null || nodes.length === 0}
              title={nodes.length === 0
                ? 'Proiectul nu are geometrie'
                : 'Format .frag (That Open). Georeferința se coace la conversie: modelul e construit ca IFC cu IfcProjectedCRS, iar convertorul îl citește.'}
              className="text-[11px] py-1 rounded border border-border bg-background text-foreground hover:bg-accent disabled:opacity-40"
            >
              {projectExport === 'frag' ? '⏳ Se convertește…' : '⬇ .frag georeferențiat'}
            </button>
            {!loc.georeferenced && (
              <span className="text-[10px] text-amber-500">
                Proiectul nu e așezat pe hartă — arhiva va folosi poziția curentă a originii.
              </span>
            )}
          </div>

          {/* Contour drawing and extrusion */}
          {extrudeOpen && (
            <div className="p-3 border-b border-border">
              <ExtrudePanel
                solids={extrusions.solids}
                selectedId={extrusions.selectedId}
                drawing={extrusions.drawing}
                pointCount={extrusions.contour.length}
                planeLabel="cota terenului"
                defaultHeight={extrusions.defaultHeight}
                onDefaultHeightChange={extrusions.changeDefaultHeight}
                onStartDraw={extrusions.startDraw}
                onCancelDraw={extrusions.cancelDraw}
                onFinishDraw={() => extrusions.finishDraw()}
                onSelect={extrusions.setSelectedId}
                onPatch={extrusions.patch}
                onHeight={extrusions.setHeight}
                onRename={extrusions.rename}
                onType={extrusions.setType}
                onDelete={extrusions.remove}
                onFocus={(id) => {
                  const s = extrusions.solids.find((x) => x.id === id);
                  const viewer = viewerRef.current;
                  if (!s || !viewer) return;
                  const ring = worldProfile(s).map((p) => cartesianOfEnu(p, s.placement.z, loc));
                  viewer.camera.flyToBoundingSphere(
                    Cesium.BoundingSphere.fromPoints(ring), { duration: 0.8 },
                  );
                }}
                onExport={() => extrusions.exportIfc('extrudari', {
                  // The solids are measured from the project origin, so the
                  // project's georeference is theirs: the file opens on site.
                  georeference: exportGeoreference(loc),
                  projectName: projectName || 'Extrudări',
                })}
              />
            </div>
          )}

          {/* Imported IFC models + the picked element's properties */}
          {(ifcList.length > 0 || ifcPick) && (
            <div className="p-3 border-b border-border flex flex-col gap-2">
              {ifcList.length > 0 && (
                <>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Modele IFC ({ifcList.length})
                  </div>
                  {ifcList.map((m) => (
                    <div key={m.id} className="flex flex-col gap-1.5">
                      <div
                        className={cn(
                          "flex items-center gap-1.5 text-xs rounded px-1 py-0.5 cursor-pointer",
                          selectedIfcId === m.id ? "bg-primary/10 border border-primary/30" : "border border-transparent hover:bg-accent/40",
                        )}
                        onClick={() => setSelectedIfcId((s) => (s === m.id ? null : m.id))}
                      >
                        <button
                          className="text-muted-foreground hover:text-foreground w-5 shrink-0"
                          title={m.visible ? 'Ascunde' : 'Arată'}
                          onClick={(e) => { e.stopPropagation(); toggleIfc(m.id); }}
                        >
                          {m.visible ? '👁' : '◌'}
                        </button>
                        <span className="flex-1 min-w-0 truncate text-foreground" title={m.name}>{m.name}</span>
                        <span
                          className="text-[9px] shrink-0"
                          title={m.linked
                            ? 'Legat de poziția proiectului: mutându-l, muți proiectul'
                            : m.georeferenced
                              ? 'Plasat din georeferențierea fișierului'
                              : 'Poziție proprie'}
                        >
                          {m.linked ? '🔗' : m.georeferenced ? '🌍' : '📍'}
                        </span>
                        <button
                          className="text-muted-foreground hover:text-destructive w-5 shrink-0"
                          title="Elimină"
                          onClick={(e) => { e.stopPropagation(); removeIfc(m.id); }}
                        >
                          ✕
                        </button>
                      </div>

                      {selectedIfcId === m.id && (
                        <IfcPlacementEditor
                          model={m}
                          projectLoc={loc}
                          placing={ifcPlacing === m.id}
                          onTogglePlacing={() => setIfcPlacing((p) => (p === m.id ? null : m.id))}
                          onToggleLinked={() => setIfcList((l) => l.map((x) => x.id === m.id
                            // Unlinking freezes the model where it stands: it
                            // keeps the project's position as its own.
                            ? { ...x, linked: !x.linked, location: x.linked ? { ...loc } : x.location }
                            : x))}
                          onLocChange={(patch) => {
                            if (m.linked) updateLoc(patch);
                            else updateIfcLoc(m.id, patch);
                          }}
                          onFocus={() => {
                            const viewer = viewerRef.current;
                            const L = m.linked ? loc : m.location;
                            viewer?.camera.flyTo({
                              destination: Cesium.Cartesian3.fromDegrees(L.lng, L.lat, (L.alt || 0) + 250),
                              orientation: { heading: Cesium.Math.toRadians(L.rotation), pitch: Cesium.Math.toRadians(-45), roll: 0 },
                              duration: 0.8,
                            });
                          }}
                          onExport={() => void exportIfcGeoref(m.id)}
                          onExportFrag={() => void exportIfcFrag(m.id)}
                          onExportTiles={() => void exportIfcTiles(m.id)}
                          onExportCityjson={() => void exportIfcCityjson(m.id)}
                          onExportHtml={() => void exportIfcHtml(m.id)}
                          busy={exportBusy?.id === m.id ? exportBusy.kind : null}
                        />
                      )}
                    </div>
                  ))}
                </>
              )}
              {ifcPick && (
                <IfcPropertiesPanel
                  className="max-h-[60vh]"
                  element={ifcPick.element}
                  loading={ifcPick.loading}
                  onClose={() => setIfcPick(null)}
                />
              )}
            </div>
          )}

          {/* Polygon Measurement (Turf.js) */}
          {(drawingPoly || polyResult || polyPoints.length > 0) && (
            <div className="p-3 border-b border-border" style={{ background: "color-mix(in srgb, transparent 90%, #a16207)" }}>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-bold uppercase tracking-widest text-yellow-500">
                  📐 Measurement
                </div>
                <button
                  onClick={clearPolyDraw}
                  className="text-[10px] text-muted-foreground hover:text-destructive transition-colors"
                  title="Clear polygon"
                >
                  ✕ Clear
                </button>
              </div>
              {drawingPoly && (
                <div className="flex flex-col gap-1.5">
                  <div className="text-[10px] text-muted-foreground">
                    {polyPoints.length} point{polyPoints.length !== 1 ? "s" : ""} placed
                  </div>
                  {polyPoints.length >= 3 && (
                    <button
                      onClick={finishPolyDraw}
                      className="w-full text-xs py-1 rounded bg-yellow-600/20 text-yellow-400 border border-yellow-600/40 hover:bg-yellow-600/30 transition-colors"
                    >
                      Close polygon
                    </button>
                  )}
                </div>
              )}
              {polyResult && (
                <div className="flex flex-col gap-1 font-mono text-[11px] bg-background/40 rounded p-2">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Area</span>
                    <span className="text-foreground font-semibold">
                      {polyResult.areaSqM >= 10000
                        ? `${(polyResult.areaSqM / 10000).toFixed(2)} ha`
                        : `${polyResult.areaSqM.toFixed(1)} m²`}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Perimeter</span>
                    <span className="text-foreground font-semibold">
                      {polyResult.perimeterM >= 1000
                        ? `${(polyResult.perimeterM / 1000).toFixed(3)} km`
                        : `${polyResult.perimeterM.toFixed(1)} m`}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Points</span>
                    <span className="text-foreground">{polyPoints.length}</span>
                  </div>
                  <button
                    className="mt-1 w-full text-[10px] py-0.5 rounded bg-muted/40 text-muted-foreground hover:bg-muted/60 transition-colors"
                    onClick={() => {
                      const txt = `Area: ${polyResult.areaSqM.toFixed(2)} m²\nPerimeter: ${polyResult.perimeterM.toFixed(2)} m\nPoints: ${polyPoints.length}`;
                      navigator.clipboard.writeText(txt);
                    }}
                  >
                    Copy results
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Visibility filter */}
          <div className="border-b border-border">
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:bg-accent transition-colors"
              onClick={() => setVisFilterOpen((v) => !v)}
            >
              <span>Visibility</span>
              <span>{visFilterOpen ? "▴" : "▾"}</span>
            </button>
            {visFilterOpen && (
              <VisibilityFilter
                types={visibleTypes}
                hiddenTypes={hiddenTypes}
                onChange={setHiddenTypes}
                counts={typeCounts}
                nodes={nodes}
                edges={edges}
                hiddenStoreyIds={hiddenStoreyIds}
                onChangeStoreyIds={setHiddenStoreyIds}
                className="max-h-64 overflow-y-auto"
              />
            )}
          </div>

          {/* Globe instances (imported .bbim models) */}
          {globeInstances.length > 0 && (
            <div className="p-3 border-b border-border">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                Imported Models ({globeInstances.length})
              </div>
              <div className="flex flex-col gap-1">
                {globeInstances.map((inst) => (
                  <div
                    key={inst.id}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] cursor-pointer transition-colors border",
                      selectedInstanceId === inst.id
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border/50 bg-muted/20 text-foreground/80 hover:bg-muted/40",
                    )}
                    onClick={() => setSelectedInstanceId(selectedInstanceId === inst.id ? null : inst.id)}
                  >
                    <input
                      type="checkbox"
                      checked={inst.visible}
                      onChange={(e) => {
                        e.stopPropagation();
                        updateGlobeInstance(inst.id, { visible: !inst.visible });
                      }}
                      className="accent-primary w-3 h-3"
                    />
                    <span className="flex-1 truncate font-medium">{inst.name}</span>
                    <button
                      className="text-muted-foreground hover:text-destructive text-xs px-0.5"
                      title="Remove instance"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeGlobeInstance(inst.id);
                        if (selectedInstanceId === inst.id) setSelectedInstanceId(null);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Selected instance properties */}
          {selectedInstance && (
            <div className="p-3 border-b border-border bg-primary/5">
              <div className="text-[10px] font-bold uppercase tracking-widest text-primary mb-2">
                📍 {selectedInstance.name}
              </div>
              <div className="flex flex-col gap-1.5">
                <NumField
                  label="Lat" value={selectedInstance.location.lat} unit="°" step={0.0001}
                  onChange={(v) => updateGlobeInstance(selectedInstance.id, {
                    location: { ...selectedInstance.location, lat: v },
                  })}
                />
                <NumField
                  label="Lng" value={selectedInstance.location.lng} unit="°" step={0.0001}
                  onChange={(v) => updateGlobeInstance(selectedInstance.id, {
                    location: { ...selectedInstance.location, lng: v },
                  })}
                />
                <NumField
                  label="Alt" value={selectedInstance.location.alt} unit="m" step={1}
                  onChange={(v) => updateGlobeInstance(selectedInstance.id, {
                    location: { ...selectedInstance.location, alt: v },
                  })}
                />
                <NumField
                  label="East" value={selectedInstance.location.offsetE} unit="m" step={0.1}
                  onChange={(v) => updateGlobeInstance(selectedInstance.id, {
                    location: { ...selectedInstance.location, offsetE: v },
                  })}
                />
                <NumField
                  label="North" value={selectedInstance.location.offsetN} unit="m" step={0.1}
                  onChange={(v) => updateGlobeInstance(selectedInstance.id, {
                    location: { ...selectedInstance.location, offsetN: v },
                  })}
                />
                <NumField
                  label="Up" value={selectedInstance.location.offsetZ} unit="m" step={0.1}
                  onChange={(v) => updateGlobeInstance(selectedInstance.id, {
                    location: { ...selectedInstance.location, offsetZ: v },
                  })}
                />
                <NumField
                  label="Heading" value={selectedInstance.location.rotation} unit="°" step={1}
                  onChange={(v) => updateGlobeInstance(selectedInstance.id, {
                    location: { ...selectedInstance.location, rotation: ((v % 360) + 360) % 360 },
                  })}
                />
                <button
                  className="mt-1 w-full text-xs py-1 rounded bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors"
                  onClick={() => {
                    const viewer = viewerRef.current;
                    if (!viewer) return;
                    const L = selectedInstance.location;
                    viewer.camera.flyTo({
                      destination: Cesium.Cartesian3.fromDegrees(L.lng, L.lat, 350),
                      orientation: {
                        heading: Cesium.Math.toRadians(L.rotation),
                        pitch: Cesium.Math.toRadians(-45),
                        roll: 0,
                      },
                      duration: 0.8,
                    });
                  }}
                >
                  ⌖ Focus on instance
                </button>
              </div>
            </div>
          )}

          {/* Data Layers — future */}
          <div className="p-3 border-b border-border">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Data Layers</div>
            <div className="flex flex-col gap-1.5 text-[10px] text-muted-foreground">
              {/* Point clouds: converted on the backend, then loaded as 3D Tiles. */}
              <input
                ref={cloudFileRef} type="file" accept={POINT_CLOUD_ACCEPT} className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleLoadPointCloud(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => cloudFileRef.current?.click()}
                disabled={cloudBusy}
                title="LAS, LAZ, E57, PLY, PTS, XYZ — se convertesc pe server în 3D Tiles"
                className="flex items-center gap-2 px-2 py-1.5 rounded border border-dashed border-border
                           hover:bg-accent hover:border-solid text-left disabled:opacity-50 disabled:cursor-wait"
              >
                <span>☁️</span>
                <span className="font-medium text-foreground/90">Point Cloud</span>
                <span className="ml-auto text-[9px]">{cloudBusy ? 'se lucrează…' : '.las .laz .e57 .ply'}</span>
              </button>

              {clouds.map((c) => (
                <div key={c.id}
                  className="flex items-start gap-2 px-2 py-1.5 rounded border border-border bg-muted/30">
                  <button
                    type="button"
                    onClick={() => toggleCloud(c.id)}
                    disabled={c.state !== 'ready'}
                    title={c.visible ? 'Ascunde' : 'Arată'}
                    className="mt-[1px] disabled:opacity-40"
                  >
                    {c.state === 'failed' ? '⚠' : c.state === 'ready' ? (c.visible ? '👁' : '🚫') : '⏳'}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground/90" title={c.name}>{c.name}</div>
                    <div className={cn('truncate text-[9px]', c.state === 'failed' && 'text-destructive')}
                      title={c.note}>
                      {c.note}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeCloud(c.id)}
                    title="Elimină"
                    className="mt-[1px] hover:text-destructive"
                  >
                    ✕
                  </button>
                </div>
              ))}

              {/* 3D Tiles: an archive this app (or anything else) exported, or a URL. */}
              <input
                ref={tilesetFileRef} type="file" accept=".zip" className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleLoadTilesetArchive(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => tilesetFileRef.current?.click()}
                disabled={tilesetBusy}
                title="Arhivă .zip cu tileset.json și tile-urile — inclusiv cele exportate din această aplicație"
                className="flex items-center gap-2 px-2 py-1.5 rounded border border-dashed border-border
                           hover:bg-accent hover:border-solid text-left disabled:opacity-50 disabled:cursor-wait"
              >
                <span>🧊</span>
                <span className="font-medium text-foreground/90">3D Tiles</span>
                <span className="ml-auto text-[9px]">{tilesetBusy ? 'se lucrează…' : 'arhivă .zip'}</span>
              </button>

              <div className="flex items-center gap-1">
                <input
                  value={tilesetUrlInput}
                  onChange={(e) => setTilesetUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleLoadTilesetUrl(); }}
                  placeholder="…sau adresa unui tileset.json"
                  className="flex-1 min-w-0 px-2 py-1 rounded border border-border bg-background
                             text-[10px] text-foreground placeholder:text-muted-foreground/70"
                />
                <button
                  type="button"
                  onClick={() => void handleLoadTilesetUrl()}
                  disabled={tilesetBusy || !tilesetUrlInput.trim()}
                  title="Încarcă tileset-ul de la adresa dată"
                  className="px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-40"
                >
                  ↵
                </button>
              </div>

              {tilesets.map((s) => (
                <div key={s.key}
                  className="flex items-start gap-2 px-2 py-1.5 rounded border border-border bg-muted/30">
                  <button
                    type="button"
                    onClick={() => toggleTileset(s.key)}
                    disabled={s.state !== 'ready'}
                    title={s.visible ? 'Ascunde' : 'Arată'}
                    className="mt-[1px] disabled:opacity-40"
                  >
                    {s.state === 'failed' ? '⚠' : s.state === 'ready' ? (s.visible ? '👁' : '🚫') : '⏳'}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground/90" title={s.name}>{s.name}</div>
                    <div className={cn('truncate text-[9px]', s.state === 'failed' && 'text-destructive')}
                      title={s.note}>
                      {s.note}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeTileset(s.key)}
                    title="Elimină"
                    className="mt-[1px] hover:text-destructive"
                  >
                    ✕
                  </button>
                </div>
              ))}

              {/* CityJSON: read in the browser — no upload, no conversion. */}
              <input
                ref={cityFileRef} type="file" accept=".json,.cityjson,.city.json" className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleLoadCityJson(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => cityFileRef.current?.click()}
                disabled={cityBusy}
                title="CityJSON 1.0–2.0 — se citește direct în browser, fără server. Coordonatele locale sunt plasate la punctul de inserție; unul în coordonate absolute e recentrat."
                className="flex items-center gap-2 px-2 py-1.5 rounded border border-dashed border-border
                           hover:bg-accent hover:border-solid text-left disabled:opacity-50 disabled:cursor-wait"
              >
                <span>🏙</span>
                <span className="font-medium text-foreground/90">CityJSON</span>
                <span className="ml-auto text-[9px]">{cityBusy ? 'se citește…' : '.city.json'}</span>
              </button>

              {cities.map((c) => (
                <div key={c.key}
                  className="flex items-start gap-2 px-2 py-1.5 rounded border border-border bg-muted/30">
                  <button
                    type="button"
                    onClick={() => toggleCity(c.key)}
                    disabled={c.state !== 'ready'}
                    title={c.visible ? 'Ascunde' : 'Arată'}
                    className="mt-[1px] disabled:opacity-40"
                  >
                    {c.state === 'failed' ? '⚠' : c.state === 'ready' ? (c.visible ? '👁' : '🚫') : '⏳'}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground/90" title={c.name}>{c.name}</div>
                    <div className={cn('truncate text-[9px]', c.state === 'failed' && 'text-destructive')}
                      title={c.note}>
                      {c.note}
                    </div>
                    {c.warnings.map((w, i) => (
                      <div key={i} className="truncate text-[9px] text-amber-600" title={w}>⚠ {w}</div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeCity(c.key)}
                    title="Elimină"
                    className="mt-[1px] hover:text-destructive"
                  >
                    ✕
                  </button>
                </div>
              ))}

              <div
                className="flex items-center gap-2 px-2 py-1.5 rounded border border-dashed border-border/50 opacity-50 cursor-not-allowed"
                title="Coming soon">
                <span>📐</span>
                <span className="font-medium text-foreground/70">GeoJSON</span>
                <span className="ml-auto text-[9px]">Drop .geojson</span>
              </div>

              {/* The attributes of whatever was last clicked in these layers. */}
              {featurePick && (
                <div ref={featurePanelRef}>
                  <FeaturePropertiesPanel
                    className="mt-1 max-h-[50vh]"
                    feature={featurePick}
                    onClose={clearFeaturePick}
                  />
                </div>
              )}
              {!featurePick && (cities.length > 0 || tilesets.length > 0) && (
                <div className="px-2 py-1 text-[9px] text-muted-foreground/80">
                  Click pe un element pentru atribute.
                </div>
              )}
            </div>
          </div>

          {/* Summary / copy */}
          <div className="p-3 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Summary</div>
            <div className="text-[10px] font-mono text-muted-foreground space-y-0.5 bg-muted/30 rounded p-2">
              <div>lat: {fmtCoord(loc.lat)}</div>
              <div>lng: {fmtCoord(loc.lng)}</div>
              <div>
                alt: {loc.alt} m
                {altSource === "srtm" && <span className="text-primary ml-1">(SRTM)</span>}
              </div>
              <div>E+: {loc.offsetE} m</div>
              <div>N+: {loc.offsetN} m</div>
              <div>Z+: {loc.offsetZ} m</div>
              <div>hdg: {loc.rotation.toFixed(1)}°</div>
            </div>
            <button
              className="mt-2 w-full text-[10px] py-1 rounded bg-muted/40 text-muted-foreground hover:bg-muted/60 transition-colors"
              onClick={() => {
                navigator.clipboard.writeText(JSON.stringify({
                  lat: loc.lat, lng: loc.lng, alt: loc.alt,
                  offsetE: loc.offsetE, offsetN: loc.offsetN, offsetZ: loc.offsetZ,
                  rotation: loc.rotation,
                }, null, 2));
              }}
            >
              Copy JSON
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
