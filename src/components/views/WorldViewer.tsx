/**
 * WorldViewer — CesiumJS-based 3D Earth viewer for building geo-location.
 *
 * Engine: CesiumJS (cesium npm package)
 * Base imagery: OpenStreetMap tiles (no API key / no Cesium Ion required)
 * Terrain: ArcGIS World Elevation (free, no API key)
 *
 * Geocoding:  Nominatim (OSM) — free, no key
 * Elevation:  Open-Topo-Data SRTM 90m — free, no key
 * Future layers: GeoJSON, CityJSON (3D Tiles), Point Cloud (.laz/.pnts)
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

// Disable Ion — we use OSM tiles directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Cesium.Ion as any).defaultAccessToken = "";

// ─── Types ────────────────────────────────────────────────────────────────────

// WorldLocation is defined in @/store and re-exported here for consumers.
export type { WorldLocation } from "@/store";

const DEFAULT_LOCATION = DEFAULT_WORLD_LOCATION;

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

// ─── Component ────────────────────────────────────────────────────────────────

export function WorldViewer({ className, projectName, tabId }: WorldViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef    = useRef<Cesium.Viewer | null>(null);
  const entityRef    = useRef<Cesium.Entity | null>(null);
  const placingRef   = useRef(false);

  const storedLoc     = useBubbleGraphStore((s) => s.worldLocation);
  const setWorldLocation = useBubbleGraphStore((s) => s.setWorldLocation);
  const updateViewTabParams = useBubbleGraphStore((s) => s.updateViewTabParams);
  // Restore per-tab state from viewTab params
  const tabParams = useBubbleGraphStore((s) => s.viewTabs.find((t) => t.id === tabId)?.params);
  const initialShowBim  = (tabParams?.showBim as boolean | undefined) ?? false;
  const initialViewMode = (tabParams?.viewMode as ViewMode | undefined) ?? "perspective";

  const [loc, setLocState]          = useState<WorldLocation>(storedLoc ?? DEFAULT_LOCATION);
  // Wrapper: update local state AND persist to store
  const setLoc = useCallback((patch: WorldLocation | ((prev: WorldLocation) => WorldLocation)) => {
    setLocState((prev) => {
      const next = typeof patch === 'function' ? patch(prev) : patch;
      setWorldLocation(next);
      return next;
    });
  }, [setWorldLocation]);

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

  // Rebuild BIM model when offset / rotation changes (while model is shown)
  // Debounced 400 ms so rapid number-field edits don't queue up many builds.
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
  }, [loc.rotation, loc.offsetE, loc.offsetN, loc.offsetZ]);

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

      // OSM base imagery — no Ion key required
      viewer.imageryLayers.removeAll();
      viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url:          "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          credit:       new Cesium.Credit("\u00A9 OpenStreetMap contributors", false),
          maximumLevel: 19,
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

      // Double-click to close polygon
      handler.setInputAction(() => {
        if (!drawingPolyRef.current) return;
        container.dispatchEvent(new CustomEvent("_wv_poly_finish"));
      }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

      (viewer as unknown as { _bbHandler?: Cesium.ScreenSpaceEventHandler })._bbHandler = handler;
      viewerRef.current = viewer;
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWvClick = async (e: Event) => {
      if (!placing) return;
      const { lat, lng } = (e as CustomEvent<{ lat: number; lng: number }>).detail;
      setPlacing(false);
      setAltLoading(true);
      const alt = await fetchElevation(lat, lng);
      setAltLoading(false);
      if (alt !== null) setAltSource("srtm");
      placeMarkerRef.current?.(lat, lng, alt ?? undefined);
    };
    container.addEventListener("_wv_click", onWvClick);
    return () => container.removeEventListener("_wv_click", onWvClick);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing, fetchElevation]);

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

    setLoc((prev) => ({
      ...prev,
      lat,
      lng,
      ...(altM !== undefined ? { alt: altM } : {}),
    }));
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
    if (canvas) canvas.style.cursor = placing ? "crosshair" : "";
  }, [placing]);

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
      // Build Three.js scene with same pipeline + materials as WebIfcViewer
      const scene = new THREE.Scene();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildSceneGeometry(scene, nodes, edges, new Map() as any, matConfig);

      // Apply visibility filter: hide types / storeys before GLB export
      const hidden     = hiddenTypesRef.current;
      const hiddenStor = hiddenStoreyIdsRef.current;
      scene.traverse((obj) => {
        const ud = obj.userData as { nodeType?: string; storeyId?: string; isLine?: boolean };
        // Always hide grid/axis line helpers and storey floor/ceiling planes
        if ((obj as THREE.Object3D & { isLine?: boolean }).isLine) { obj.visible = false; return; }
        if (ud.nodeType === 'storey') { obj.visible = false; return; }
        if (ud.nodeType && hidden.has(ud.nodeType)) { obj.visible = false; return; }
        if (ud.storeyId && hiddenStor.has(ud.storeyId)) { obj.visible = false; return; }
      });

      // Remove any invisible subtrees so GLB doesn't carry zero-area geometry
      const toRemove: THREE.Object3D[] = [];
      scene.traverse((obj) => { if (!obj.visible) toRemove.push(obj); });
      toRemove.forEach((obj) => obj.removeFromParent());

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

  // ── Click-pick handler for instance selection ──────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (placingRef.current) return; // placing mode takes priority
      const pick = viewer.scene.pick(event.position);
      if (pick && pick.primitive) {
        const instId = (pick.primitive as unknown as { _bbInstId?: string })._bbInstId;
        if (instId) {
          setSelectedInstanceId(instId);
          return;
        }
      }
      // Clicking empty space deselects
      setSelectedInstanceId(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => handler.destroy();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          title="Click on the globe to place the building anchor point"
        >
          {placing ? "⏹ Cancel" : "📍 Place building"}
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
              Click on the globe to place the building anchor
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
              Fetching elevation…
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
                        setAltLoading(true);
                        const alt = await fetchElevation(lat, lng);
                        setAltLoading(false);
                        if (alt !== null) setAltSource("srtm");
                        placeMarker(lat, lng, alt ?? undefined);
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
              {[
                { icon: "📐", label: "GeoJSON",     hint: "Drop .geojson" },
                { icon: "🏙", label: "CityJSON",    hint: "Drop .json / 3D Tiles" },
                { icon: "☁️", label: "Point Cloud", hint: "Drop .laz / .pnts" },
              ].map(({ icon, label, hint }) => (
                <div key={label}
                  className="flex items-center gap-2 px-2 py-1.5 rounded border border-dashed border-border/50 opacity-50 cursor-not-allowed"
                  title="Coming soon">
                  <span>{icon}</span>
                  <span className="font-medium text-foreground/70">{label}</span>
                  <span className="ml-auto text-[9px]">{hint}</span>
                </div>
              ))}
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
